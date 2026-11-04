//! NDJSON protocol smoke tests: spawn the real `rdm-kernel` binary and drive it
//! over stdio exactly like the DSH plugin does.

mod common;

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use common::Fixture;
use serde_json::{json, Value};

struct KernelProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
}

impl KernelProcess {
    fn spawn(data_dir: &PathBuf) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_rdm-kernel"))
            .args(["--data-dir", data_dir.to_str().expect("data dir"), "--log-level", "warn"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn rdm-kernel");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let (tx, rx) = channel();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if tx.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Self { child, stdin: Some(stdin), lines: rx }
    }

    fn send(&mut self, value: Value) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        writeln!(stdin, "{value}").expect("write request");
        stdin.flush().expect("flush request");
    }

    fn next_line(&self, timeout: Duration) -> Option<Value> {
        let line = self.lines.recv_timeout(timeout).ok()?;
        Some(serde_json::from_str(&line).unwrap_or(Value::Null))
    }

    /// Send a request and read until the matching response arrives, skipping
    /// interleaved `task` notifications and out-of-order replies.
    fn request(&mut self, id: &str, method: &str, params: Value) -> Value {
        self.send(json!({"id": id, "method": method, "params": params}));
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "timeout waiting for {method}");
            let Some(value) = self.next_line(remaining) else {
                panic!("kernel closed stdout while waiting for {method}");
            };
            if value.get("event").is_some() {
                continue;
            }
            if value.get("id") == Some(&json!(id)) {
                return value;
            }
        }
    }

    fn close_stdin(&mut self) {
        self.stdin.take();
    }

    fn wait_exit(&mut self, timeout: Duration) -> Option<std::process::ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.child.try_wait().expect("try_wait") {
                Some(status) => return Some(status),
                None if Instant::now() >= deadline => return None,
                None => thread::sleep(Duration::from_millis(20)),
            }
        }
    }
}

impl Drop for KernelProcess {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn data_dir(tag: &str) -> PathBuf {
    // Workspace-backed: the kernel child may not be allowed to write %TEMP% on
    // sandboxed Windows hosts.
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("tmp").join(format!("rdm-kernel-proto-{tag}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn ndjson_handshake_and_download_roundtrip() {
    let dir = data_dir("roundtrip");
    let bytes = common::payload(1024 * 1024);
    let expected = common::sha256_hex(&bytes);
    let fixture = Fixture::start(bytes.clone());
    let mut kernel = KernelProcess::spawn(&dir);

    let ready = kernel.next_line(Duration::from_secs(20)).expect("ready line");
    assert_eq!(ready["event"], "ready");
    assert_eq!(ready["protocol"], 1);
    assert!(ready["kernel"]["pid"].as_u64().unwrap_or(0) > 0);

    let response = kernel.request("init", "initialize", json!({"defaultDir": dir.to_string_lossy(), "connections": 4, "autoResume": false}));
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["protocol"], 1);
    assert_eq!(response["result"]["config"]["connections"], 4);

    let response = kernel.request("probe", "probe", json!({"url": fixture.url("/file")}));
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["meta"]["totalBytes"], bytes.len() as u64);
    assert_eq!(response["result"]["meta"]["supportsRanges"], true);

    let response = kernel.request(
        "start",
        "start",
        json!({
            "url": fixture.url("/file"),
            "dir": dir.to_string_lossy(),
            "connections": 4,
            "expectedSha256": expected,
        }),
    );
    assert_eq!(response["ok"], true);
    let task = response["result"]["task"].clone();
    assert_eq!(task["status"], "queued");
    let id = task["id"].as_str().expect("task id").to_string();

    let response = kernel.request("wait", "wait", json!({"ids": [id], "timeoutMs": 60000}));
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["timedOut"], false);
    let task = &response["result"]["tasks"][0];
    assert_eq!(task["status"], "completed", "{task:?}");
    assert_eq!(task["downloaded"], task["total"], "{task:?}");
    assert_eq!(task["sha256"], expected);
    let path = task["path"].as_str().expect("path");
    assert_eq!(std::fs::read(path).unwrap(), bytes);

    let response = kernel.request("get", "get", json!({"id": id, "events": 100}));
    assert_eq!(response["ok"], true);
    assert!(response["result"]["events"].as_array().unwrap().len() > 0);
    assert_eq!(response["result"]["task"]["status"], "completed");

    let response = kernel.request("list", "list", json!({"status": "completed"}));
    assert_eq!(response["result"]["tasks"].as_array().unwrap().len(), 1);

    let response = kernel.request("stats", "stats", json!({}));
    assert_eq!(response["result"]["tasks"]["completed"], 1);
    assert_eq!(response["result"]["totals"]["downloadsCompleted"], 1);

    let response = kernel.request("shutdown", "shutdown", json!({}));
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["ok"], true);
    let status = kernel.wait_exit(Duration::from_secs(5)).expect("exit");
    assert!(status.success(), "kernel exit: {status:?}");
}

#[test]
fn stdin_eof_persists_and_exits() {
    let dir = data_dir("eof");
    let mut kernel = KernelProcess::spawn(&dir);
    let ready = kernel.next_line(Duration::from_secs(20)).expect("ready");
    assert_eq!(ready["event"], "ready");
    let response = kernel.request("init", "initialize", json!({}));
    assert_eq!(response["ok"], true);
    kernel.close_stdin();
    let status = kernel.wait_exit(Duration::from_secs(5)).expect("exit on stdin EOF");
    assert!(status.success(), "kernel exit: {status:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn malformed_and_unknown_requests_are_reported() {
    let dir = data_dir("errors");
    let mut kernel = KernelProcess::spawn(&dir);
    let _ready = kernel.next_line(Duration::from_secs(20)).expect("ready");
    kernel.send_raw("{not json");
    let error = kernel.next_line(Duration::from_secs(10)).expect("error line");
    assert_eq!(error["ok"], false);
    assert_eq!(error["error"]["code"], "invalid_request");

    let response = kernel.request("bad", "nope", json!({}));
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "invalid_request");

    let response = kernel.request("get", "get", json!({"id": "t_missing"}));
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "not_found");

    let response = kernel.request("badstart", "start", json!({"url": "ftp://x/y"}));
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "invalid_request");
    let _ = kernel.wait_exit(Duration::from_millis(10));
}

impl KernelProcess {
    fn send_raw(&mut self, raw: &str) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        writeln!(stdin, "{raw}").expect("write raw");
        stdin.flush().expect("flush raw");
    }
}
