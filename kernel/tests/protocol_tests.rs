//! NDJSON protocol v2 smoke tests: spawn the real `rdm-kernel` binary and
//! drive it over stdio exactly like the DSH plugin does.

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

    fn send_raw(&mut self, raw: &str) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        writeln!(stdin, "{raw}").expect("write raw");
        stdin.flush().expect("flush raw");
    }

    fn next_line(&self, timeout: Duration) -> Option<Value> {
        let line = self.lines.recv_timeout(timeout).ok()?;
        Some(serde_json::from_str(&line).unwrap_or(Value::Null))
    }

    /// Send a request and read until the matching response arrives, skipping
    /// interleaved `task` notifications and out-of-order replies.
    fn request(&mut self, id: &str, method: &str, params: Value) -> Value {
        self.send(json!({"id": id, "method": method, "params": params}));
        let deadline = Instant::now() + Duration::from_secs(90);
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

fn ready(kernel: &KernelProcess) -> Value {
    let ready = kernel.next_line(Duration::from_secs(20)).expect("ready line");
    assert_eq!(ready["event"], "ready");
    assert_eq!(ready["protocol"], 2, "{ready}");
    // 0.2.2 unifies the kernel and package versions: the ready frame reports
    // 0.2.2, and the history meta line records the same identity.
    assert_eq!(ready["kernel"]["version"], "0.2.2", "{ready}");
    assert!(ready["kernel"]["pid"].as_u64().unwrap_or(0) > 0);
    ready
}

#[test]
fn ndjson_protocol_v2_probe_download_and_detail() {
    let dir = data_dir("roundtrip");
    let bytes = common::payload(1024 * 1024);
    let expected = common::sha256_hex(&bytes);
    let fixture = Fixture::start(bytes.clone());
    let mut kernel = KernelProcess::spawn(&dir);
    ready(&kernel);

    let response = kernel.request("init", "initialize", json!({"defaultDir": dir.to_string_lossy(), "connections": 4, "autoResume": false}));
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["result"]["protocol"], 2);
    assert_eq!(response["result"]["config"]["connections"], 4);
    assert_eq!(response["result"]["kernel"]["version"], env!("CARGO_PKG_VERSION"));

    // ---- probe: complete ServerFacts ------------------------------------
    let response = kernel.request("probe", "probe", json!({"url": fixture.url("/file")}));
    assert_eq!(response["ok"], true, "{response}");
    let server = &response["result"]["server"];
    assert!(response["result"].get("meta").is_none(), "probe result is {{server}} only");
    for key in [
        "url",
        "finalUrl",
        "host",
        "httpVersion",
        "status",
        "fileName",
        "fileNameSource",
        "totalBytes",
        "contentType",
        "contentEncoding",
        "contentDisposition",
        "range",
        "validators",
        "resume",
        "signedUrl",
        "tls",
        "redirects",
        "headers",
        "rateLimit",
        "timing",
        "checksum",
        "warnings",
        "recommendation",
        "origin",
    ] {
        assert!(server.get(key).is_some(), "ServerFacts missing {key}: {server}");
    }
    assert_eq!(server["totalBytes"], bytes.len() as u64);
    assert_eq!(server["status"], 200);
    assert_eq!(server["httpVersion"], "HTTP/1.1");
    assert_eq!(server["range"]["supported"], true);
    assert_eq!(server["range"]["acceptRanges"], "bytes");
    assert_eq!(server["range"]["probedBy"], "range-get");
    assert_eq!(server["range"]["probeStatus"], 206);
    assert_eq!(server["range"]["probeBytes"], 64);
    assert!(server["range"]["ifRange"].as_bool().unwrap(), "strong ETag fixture must allow If-Range: {server}");
    assert_eq!(server["validators"]["etag"], "\"v1\"");
    assert_eq!(server["validators"]["strongEtag"], true);
    assert_eq!(server["resume"]["safety"], "strong");
    assert_eq!(server["resume"]["reason"], "strong-etag");
    assert_eq!(server["signedUrl"]["signed"], false);
    assert_eq!(server["signedUrl"]["source"], "unknown");
    assert!(server["tls"].is_null(), "http fixture must report tls null");
    assert_eq!(server["checksum"]["sha256"], Value::Null);
    assert!(server["timing"]["probeMs"].as_u64().is_some());
    assert!(server["timing"]["sampleBps"].is_null(), "64-byte range proof must not report throughput: {server}");
    assert_eq!(server["recommendation"]["singleStream"], false);
    assert_eq!(server["recommendation"]["start"], "now");
    assert_eq!(server["recommendation"]["verify"], "unavailable");
    assert!(server["warnings"].as_array().unwrap().is_empty(), "{}", server["warnings"]);
    assert!(server["redirects"].as_array().unwrap().is_empty());
    assert!(server["origin"].is_null(), "first probe of a host has no ledger entry");

    // ---- start with session attribution --------------------------------
    let response = kernel.request(
        "start",
        "start",
        json!({
            "url": fixture.url("/file"),
            "dir": dir.to_string_lossy(),
            "connections": 4,
            "expectedSha256": expected,
            "sessionId": "sess_abc",
        }),
    );
    assert_eq!(response["ok"], true, "{response}");
    let task = response["result"]["task"].clone();
    assert_eq!(task["status"], "queued");
    assert_eq!(task["sessionId"], "sess_abc");
    assert_eq!(task["host"], "127.0.0.1");
    assert!(task["percent"].is_null(), "percent is null until the total is known: {task}");
    for key in ["sessionId", "host", "percent", "speed1sBps", "speed5sBps", "speed30sBps", "speed300sBps", "avgBps", "peakBps", "etaConfidence", "stalledMs", "resumable", "resumeSafety", "verified", "signedUrlExpiresAt", "tlsNotAfter"] {
        assert!(task.get(key).is_some(), "TaskView missing {key}: {task}");
    }
    let id = task["id"].as_str().expect("task id").to_string();

    let response = kernel.request("wait", "wait", json!({"ids": [id], "timeoutMs": 90000}));
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["timedOut"], false);
    let task = &response["result"]["tasks"][0];
    assert_eq!(task["status"], "completed", "{task:?}");
    assert_eq!(task["downloaded"], task["total"]);
    assert_eq!(task["percent"], 100);
    assert_eq!(task["verified"], true);
    assert_eq!(task["sha256"], expected);
    assert_eq!(task["resumeSafety"], "strong");
    assert_eq!(task["resumable"], true);
    let path = task["path"].as_str().expect("path");
    assert_eq!(std::fs::read(path).unwrap(), bytes);

    // ---- get: flat view + TaskDetail + events --------------------------
    let response = kernel.request("get", "get", json!({"id": id, "events": 100}));
    assert_eq!(response["ok"], true, "{response}");
    let detail = &response["result"]["detail"];
    for key in ["telemetry", "server", "target", "verification", "resumeState", "timing", "diagnosis"] {
        assert!(detail.get(key).is_some(), "TaskDetail missing {key}: {detail}");
    }
    let windows = &detail["telemetry"]["windows"];
    for window in ["1s", "5s", "30s", "300s"] {
        assert!(windows.get(window).is_some(), "windows missing {window}: {windows}");
    }
    assert!(detail["telemetry"]["samples"].as_u64().is_some());
    assert!(detail["telemetry"]["peakBps"].as_u64().unwrap() > 0, "peak must survive completion: {detail}");
    assert!(detail["server"]["range"]["supported"].as_bool().unwrap(), "server facts retained on the task");
    assert_eq!(detail["verification"]["verified"], true);
    assert_eq!(detail["verification"]["sha256"], expected);
    assert_eq!(detail["target"]["path"], path);
    assert!(detail["target"]["part"].as_str().unwrap().ends_with(".part"));
    assert!(detail["target"]["resumeState"].as_str().unwrap().ends_with(".part.json"));
    assert!(detail["timing"]["probeMs"].as_u64().is_some());
    assert!(detail["timing"]["transferMs"].as_u64().is_some());
    assert_eq!(detail["resumeState"]["validatorsMatched"], true);
    assert!(response["result"]["events"].as_array().unwrap().len() > 0);
    assert_eq!(response["result"]["task"]["status"], "completed");
    assert!(detail["diagnosis"].is_array());

    // ---- list: session filter + aggregate ------------------------------
    let response = kernel.request("list", "list", json!({"sessionId": "sess_abc"}));
    assert_eq!(response["result"]["tasks"].as_array().unwrap().len(), 1);
    let aggregate = &response["result"]["aggregate"];
    for key in ["total", "active", "paused", "failed", "completed", "bytesDownloaded", "nowBps", "w5Bps", "w30Bps", "w300Bps", "riskCount"] {
        assert!(aggregate.get(key).is_some(), "aggregate missing {key}: {aggregate}");
    }
    assert_eq!(aggregate["completed"], 1);
    assert_eq!(aggregate["bytesDownloaded"], bytes.len() as u64);
    let other = kernel.request("list", "list", json!({"sessionId": "sess_other"}));
    assert!(other["result"]["tasks"].as_array().unwrap().is_empty());
    let completed = kernel.request("list", "list", json!({"status": "completed"}));
    assert_eq!(completed["result"]["tasks"].as_array().unwrap().len(), 1);

    // ---- stats ----------------------------------------------------------
    let response = kernel.request("stats", "stats", json!({}));
    assert_eq!(response["result"]["protocol"], 2);
    assert_eq!(response["result"]["tasks"]["completed"], 1);
    assert_eq!(response["result"]["totals"]["downloadsCompleted"], 1);
    for key in ["nowBps", "w5Bps", "w30Bps", "w300Bps"] {
        assert!(response["result"]["throughput"].get(key).is_some(), "throughput missing {key}");
    }
    assert_eq!(response["result"]["origins"], 1, "the fixture host was learned on completion");
    // The ledger file write is a coalesced background task, not a terminal gate.
    let ledger_path = dir.join("origins.json");
    let ledger_deadline = Instant::now() + Duration::from_secs(3);
    while !ledger_path.is_file() && Instant::now() < ledger_deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(ledger_path.is_file(), "origin ledger persisted at <data-dir>/origins.json");

    // ---- shutdown -------------------------------------------------------
    let response = kernel.request("shutdown", "shutdown", json!({}));
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"], json!({}));
    let status = kernel.wait_exit(Duration::from_secs(10)).expect("exit");
    assert!(status.success(), "kernel exit: {status:?}");
}

#[test]
fn probe_redirect_chain_signed_urls_and_redaction() {
    let dir = data_dir("facts");
    let fixture = Fixture::start(common::payload(128 * 1024));
    let mut kernel = KernelProcess::spawn(&dir);
    ready(&kernel);
    kernel.request("init", "initialize", json!({"autoResume": false}));

    // Two-hop manual redirect chain.
    let response = kernel.request("probe", "probe", json!({"url": fixture.url("/chain")}));
    assert_eq!(response["ok"], true, "{response}");
    let server = &response["result"]["server"];
    let redirects = server["redirects"].as_array().unwrap();
    assert!(redirects.len() >= 2, "expected the two-hop chain, got {redirects:?}");
    assert_eq!(redirects[0]["status"], 302);
    assert_eq!(server["status"], 200, "status is the final response status");
    assert!(server["finalUrl"].as_str().unwrap().ends_with("/file"), "{}", server["finalUrl"]);
    assert!(server["warnings"].as_array().unwrap().iter().any(|warning| warning == "redirected"));

    // AWS SigV4-style signed URL: expiry comes from the final URL's
    // X-Amz-Date + X-Amz-Expires, never now + TTL, and credentials are redacted.
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let date = httpdate_like(now - 60);
    let signed_url = format!("{}?X-Amz-Date={date}&X-Amz-Expires=3600&X-Amz-Signature=deadbeef", fixture.url("/file"));
    let response = kernel.request("probe", "probe", json!({"url": signed_url}));
    assert_eq!(response["ok"], true, "{response}");
    let server = &response["result"]["server"];
    assert_eq!(server["signedUrl"]["signed"], true);
    assert_eq!(server["signedUrl"]["source"], "aws-sigv4");
    assert_eq!(server["signedUrl"]["state"], "valid");
    let expires_at = server["signedUrl"]["expiresAt"].as_u64().expect("expiresAt");
    assert!(expires_at > (now as u64) * 1000, "expiresAt must be in the future: {expires_at}");
    let raw = response.to_string();
    assert!(!raw.contains("deadbeef"), "credential value leaked into the probe response: {raw}");
    assert!(server["url"].as_str().unwrap().contains("<redacted>"), "url projection must be redacted: {}", server["url"]);

    // Expired signed URL: warn and report expired.
    let old = httpdate_like(now - 7200);
    let expired_url = format!("{}?X-Amz-Date={old}&X-Amz-Expires=60&X-Amz-Signature=deadbeef", fixture.url("/file"));
    let response = kernel.request("probe", "probe", json!({"url": expired_url}));
    let server = &response["result"]["server"];
    assert_eq!(server["signedUrl"]["state"], "expired", "{server}");
    assert!(server["warnings"].as_array().unwrap().iter().any(|warning| warning == "signed-url-expired"));

    // Plain credential query value is redacted from the projected URL.
    let response = kernel.request("probe", "probe", json!({"url": fixture.url("/file?token=supersecret&size=1")}));
    let server = &response["result"]["server"];
    assert!(!response.to_string().contains("supersecret"), "token leaked: {server}");
    assert!(server["url"].as_str().unwrap().contains("token=<redacted>"));
    assert!(!server["url"].as_str().unwrap().contains("supersecret"));

    let _ = kernel.request("shutdown", "shutdown", json!({}));
    let _ = kernel.wait_exit(Duration::from_secs(10));
    let _ = std::fs::remove_dir_all(&dir);
}

/// `YYYYMMDDTHHMMSSZ` for a Unix timestamp (matches AWS/GCS signing dates).
fn httpdate_like(epoch_secs: i64) -> String {
    let days = epoch_secs.div_euclid(86_400);
    let seconds_of_day = epoch_secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}Z")
}

/// Howard Hinnant's civil-from-days.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[test]
fn legacy_0_1_x_task_record_loads() {
    let dir = data_dir("legacy");
    let tasks = dir.join("tasks");
    std::fs::create_dir_all(&tasks).unwrap();
    // A record written by kernel 0.1.x: no sessionId, no v2 telemetry fields
    // and no `server` snapshot.
    let legacy = json!({
        "spec": {
            "url": "http://127.0.0.1:1/legacy.bin",
            "dir": dir.to_string_lossy(),
            "fileName": null,
            "connections": 8,
            "chunkSizeBytes": 0,
            "headers": {},
            "cookie": null,
            "referer": null,
            "userAgent": null,
            "expectedSha256": null,
            "speedLimitBps": 0,
            "resume": true,
            "singleStream": false,
            "proxy": null,
            "insecure": false,
            "maxAttempts": 6,
            "fsyncOnComplete": false
        },
        "id": "t_legacy00000000",
        "url": "http://127.0.0.1:1/legacy.bin",
        "finalUrl": null,
        "fileName": "legacy.bin",
        "dir": dir.to_string_lossy(),
        "path": null,
        "status": "interrupted",
        "downloaded": 1024,
        "total": 2048,
        "speedBps": 0,
        "etaSecs": null,
        "activeWorkers": 0,
        "peakWorkers": 0,
        "connections": 8,
        "chunkSize": null,
        "resumedChunks": 0,
        "rangeSupported": null,
        "expectedSha256": null,
        "sha256": null,
        "error": null,
        "retries": 0,
        "createdAt": 1,
        "startedAt": 2,
        "finishedAt": null,
        "elapsedMs": 3000,
        "resumable": false
    });
    std::fs::write(tasks.join("t_legacy00000000.json"), serde_json::to_vec(&legacy).unwrap()).unwrap();

    let mut kernel = KernelProcess::spawn(&dir);
    ready(&kernel);
    kernel.request("init", "initialize", json!({"autoResume": false}));
    let response = kernel.request("list", "list", json!({}));
    let tasks = response["result"]["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "{response}");
    let task = &tasks[0];
    assert_eq!(task["id"], "t_legacy00000000");
    assert_eq!(task["status"], "interrupted", "active 0.1.x states load as interrupted");
    assert_eq!(task["sessionId"], Value::Null);
    assert_eq!(task["host"], "127.0.0.1");
    assert_eq!(task["percent"], 50);
    assert_eq!(task["downloaded"], 1024);
    assert_eq!(task["resumeSafety"], "none");
    assert!(task["speed1sBps"].is_null());
    let _ = kernel.request("shutdown", "shutdown", json!({}));
    let _ = kernel.wait_exit(Duration::from_secs(10));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stdin_eof_persists_and_exits() {
    let dir = data_dir("eof");
    let mut kernel = KernelProcess::spawn(&dir);
    let ready = kernel.next_line(Duration::from_secs(20)).expect("ready");
    assert_eq!(ready["event"], "ready");
    assert_eq!(ready["protocol"], 2);
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
    // 0.2.2: an unknown method is a stable, actionable `unsupported_method`
    // error naming the method and the kernel build instead of a generic
    // `invalid_request` (the 20261109 session hit `unknown method history`).
    assert_eq!(response["error"]["code"], "unsupported_method");
    let message = response["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("nope"), "message must name the method: {message}");
    assert!(message.contains("0.2.2"), "message must name the kernel version: {message}");

    let response = kernel.request("get", "get", json!({"id": "t_missing"}));
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "not_found");

    let response = kernel.request("badstart", "start", json!({"url": "ftp://x/y"}));
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "invalid_request");

    // A stale host handshake is refused with a stable code.
    let response = kernel.request("oldinit", "initialize", json!({"protocol": 1}));
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "protocol_mismatch");
    let _ = kernel.wait_exit(Duration::from_millis(10));
    let _ = std::fs::remove_dir_all(&dir);
}
