//! End-to-end tests against an in-process HTTP fixture server.

mod common;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{payload, sha256_hex, Fixture};
use rdm_kernel::kernel::Kernel;
use rdm_kernel::protocol::{Config, ProbeParams, RequestSpec, Status, TaskView};
use serde_json::{json, Value};

static SEQ: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("tmp").join(format!("rdm-kernel-{tag}-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("temp dir");
        Self(path)
    }

    fn path(&self) -> PathBuf {
        self.0.clone()
    }

    fn as_str(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn kernel(dir: &TempDir) -> Arc<Kernel> {
    Kernel::new(dir.path(), None).expect("kernel")
}

async fn start_task(kernel: &Kernel, params: Value) -> TaskView {
    let raw: RequestSpec = serde_json::from_value(params).expect("request spec");
    let value = kernel.start(raw).await.expect("start");
    serde_json::from_value(value["task"].clone()).expect("task view")
}

async fn task(kernel: &Kernel, id: &str) -> TaskView {
    let value = kernel.get(id, 0).expect("get");
    serde_json::from_value(value["task"].clone()).expect("task view")
}

async fn wait_task(kernel: &Kernel, id: &str, timeout_ms: u64) -> TaskView {
    let value = kernel.wait(&[id.to_string()], timeout_ms).await.expect("wait");
    serde_json::from_value(value["tasks"][0].clone()).expect("task view")
}

async fn control(kernel: &Kernel, id: &str, action: &str) -> TaskView {
    let value = kernel.control(id, action, false).await.unwrap_or_else(|error| panic!("control {action} failed: {error:?}"));
    serde_json::from_value(value["task"].clone()).expect("task view")
}

async fn wait_until(kernel: &Kernel, id: &str, what: &str, deadline: Duration, predicate: impl Fn(&TaskView) -> bool) -> TaskView {
    let started = Instant::now();
    loop {
        let view = task(kernel, id).await;
        if predicate(&view) {
            return view;
        }
        if started.elapsed() > deadline {
            panic!("timed out waiting for {what}; last view: {view:?}");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn url_of(fixture: &Fixture, path: &str) -> String {
    fixture.url(path)
}

fn suffixed(path: &std::path::Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn download_params(fixture: &Fixture, dir: &TempDir, extra: Value) -> Value {
    let mut params = json!({
        "url": url_of(fixture, "/file"),
        "dir": dir.as_str(),
        "connections": 4,
    });
    if let Value::Object(entries) = extra {
        for (key, value) in entries {
            params[key] = value;
        }
    }
    params
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ranged_multi_connection_download() {
    let bytes = payload(3 * 1024 * 1024);
    let fixture = Fixture::start(bytes.clone());
    let dir = TempDir::new("ranged");
    let kernel = kernel(&dir);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({"chunkSizeBytes": 262144}))).await;
    assert_eq!(view.status, Status::Queued);
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    let path = PathBuf::from(view.path.clone().expect("path"));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(view.range_supported, Some(true));
    assert!(view.peak_workers >= 2, "peak_workers={}", view.peak_workers);
    assert!(fixture.max_active() >= 2, "fixture saw only {} concurrent requests", fixture.max_active());
    assert_eq!(view.chunk_size, Some(262144));
    assert!(!suffixed(&path, ".part").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_range_server_uses_single_stream() {
    let bytes = payload(700 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_supports_ranges(false);
    let dir = TempDir::new("norange");
    let kernel = kernel(&dir);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({"connections": 8}))).await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert_eq!(std::fs::read(view.path.clone().expect("path")).unwrap(), bytes);
    assert_eq!(view.range_supported, Some(false));
    assert_eq!(view.connections, 1);
    assert!(view.chunk_size.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn follows_redirects() {
    let bytes = payload(256 * 1024);
    let fixture = Fixture::start(bytes.clone());
    let dir = TempDir::new("redirect");
    let kernel = kernel(&dir);
    let mut params = download_params(&fixture, &dir, json!({}));
    params["url"] = json!(fixture.url("/redirect"));
    let view = start_task(&kernel, params).await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert!(view.final_url.as_deref().unwrap_or("").ends_with("/file"));
    assert_eq!(std::fs::read(view.path.clone().expect("path")).unwrap(), bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retries_429_with_retry_after() {
    let bytes = payload(300 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_flaky_429(2, Some("0"));
    let dir = TempDir::new("retry429");
    let kernel = kernel(&dir);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({"connections": 1}))).await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert!(view.retries >= 1, "expected retries, got {view:?}");
    assert!(fixture.requests() >= 3);
    assert_eq!(std::fs::read(view.path.clone().expect("path")).unwrap(), bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sha256_success_and_mismatch() {
    let bytes = payload(200 * 1024);
    let good = sha256_hex(&bytes);
    let fixture = Fixture::start(bytes.clone());
    let dir = TempDir::new("sha");
    let kernel = kernel(&dir);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({"expectedSha256": good}))).await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert_eq!(view.sha256.as_deref(), Some(good.as_str()));

    let bad = "0".repeat(64);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({"expectedSha256": bad, "fileName": "bad.bin"}))).await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Failed);
    assert_eq!(view.error.as_ref().map(|info| info.code.as_str()), Some("checksum_mismatch"));
    let path = PathBuf::from(view.path.clone().expect("path"));
    assert!(!path.exists(), "mismatching target must not be kept");
    assert!(!suffixed(&path, ".part").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pause_then_resume_preserves_bytes() {
    let bytes = payload(2 * 1024 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_chunk_delay(Duration::from_millis(25));
    let dir = TempDir::new("pause");
    let kernel = kernel(&dir);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({"connections": 2, "chunkSizeBytes": 262144}))).await;
    let view = wait_until(&kernel, &view.id, "progress before pause", Duration::from_secs(20), |view| view.downloaded >= 128 * 1024 && view.status == Status::Running).await;
    let paused = control(&kernel, &view.id, "pause").await;
    assert_eq!(paused.status, Status::Paused, "{paused:?}");
    assert!(paused.downloaded > 0);
    let path = PathBuf::from(paused.path.clone().expect("path"));
    assert!(suffixed(&path, ".part").exists());
    assert!(suffixed(&path, ".part.json").exists());
    let part_bytes = std::fs::metadata(suffixed(&path, ".part")).unwrap().len();
    assert!(part_bytes > 0);

    let resumed = control(&kernel, &view.id, "resume").await;
    assert_eq!(resumed.status, Status::Queued);
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert!(view.resumed_chunks > 0, "expected resumed chunks");
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_across_kernel_restart() {
    let bytes = payload(2 * 1024 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_chunk_delay(Duration::from_millis(25));
    let dir = TempDir::new("restart");
    let first = kernel(&dir);
    let view = start_task(&first, download_params(&fixture, &dir, json!({"connections": 2, "chunkSizeBytes": 262144}))).await;
    let waited =
        wait_until(&first, &view.id, "resume state", Duration::from_secs(20), |view| view.downloaded >= 128 * 1024 && view.path.as_deref().map(|path| suffixed(std::path::Path::new(path), ".part.json").exists()).unwrap_or(false)).await;
    let path = PathBuf::from(waited.path.clone().expect("path"));
    first.shutdown().await;
    drop(first);

    // The persisted record now says interrupted; a fresh kernel generation must
    // load it and auto-resume from the saved byte ranges.
    let record: Value = serde_json::from_slice(&std::fs::read(dir.path().join("tasks").join(format!("{}.json", view.id))).unwrap()).unwrap();
    assert_eq!(record["status"], "interrupted");

    let second = kernel(&dir);
    let loaded = task(&second, &view.id).await;
    assert_eq!(loaded.status, Status::Interrupted);
    let config = Config::default();
    assert!(config.auto_resume);
    let _ = second.initialize(config, None).await;
    let view = wait_task(&second, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert!(view.resumed_chunks > 0);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changed_etag_rejects_resume_state() {
    let bytes = payload(1536 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_chunk_delay(Duration::from_millis(25));
    let dir = TempDir::new("etag");
    let kernel = kernel(&dir);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({"connections": 2, "chunkSizeBytes": 262144}))).await;
    let running = wait_until(&kernel, &view.id, "progress before pause", Duration::from_secs(20), |view| view.downloaded >= 128 * 1024 && view.status == Status::Running).await;
    let path = PathBuf::from(running.path.clone().expect("path"));
    let paused = control(&kernel, &view.id, "pause").await;
    assert_eq!(paused.status, Status::Paused);

    fixture.set_etag("\"v2-changed\"");
    let resumed = control(&kernel, &view.id, "resume").await;
    assert_eq!(resumed.status, Status::Queued);
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert_eq!(view.resumed_chunks, 0, "changed validators must restart");
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn content_disposition_filename_is_sanitized_and_deduplicated() {
    let bytes = payload(64 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_content_disposition("attachment; filename=\"a<b>c:d?.bin\"");
    let dir = TempDir::new("filename");
    let kernel = kernel(&dir);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({}))).await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert_eq!(view.file_name, "a_b_c_d_.bin");
    let path = PathBuf::from(view.path.clone().expect("path"));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);

    // A second identical download must not clobber the first file.
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({}))).await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert_eq!(view.file_name, "a_b_c_d_ (1).bin");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_then_retry_discards_part_and_restarts() {
    let bytes = payload(1024 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_chunk_delay(Duration::from_millis(20));
    let dir = TempDir::new("cancel-retry");
    let kernel = kernel(&dir);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({"connections": 2, "chunkSizeBytes": 262144}))).await;
    wait_until(&kernel, &view.id, "progress before cancel", Duration::from_secs(20), |view| view.downloaded > 0 && view.status == Status::Running).await;
    let cancelled = control(&kernel, &view.id, "cancel").await;
    assert_eq!(cancelled.status, Status::Cancelled);
    let path = PathBuf::from(cancelled.path.clone().expect("path"));
    assert!(suffixed(&path, ".part").exists());

    fixture.set_chunk_delay(Duration::ZERO);
    let _retried = control(&kernel, &view.id, "retry").await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert_eq!(view.resumed_chunks, 0);
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn probe_returns_complete_server_facts() {
    let bytes = payload(4096);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_content_disposition("attachment; filename=\"probe.bin\"");
    fixture.set_header("x-amz-checksum-sha256", "Z29vZA==");
    fixture.set_header("x-ratelimit-limit", "100");
    let dir = TempDir::new("probe");
    let kernel = kernel(&dir);
    let params: ProbeParams = serde_json::from_value(json!({"url": fixture.url("/file")})).unwrap();
    let value = kernel.probe(params).await.expect("probe");
    assert!(value.get("meta").is_none(), "probe result is {{server}} only: {value}");
    let server: rdm_kernel::protocol::ServerFacts = serde_json::from_value(value["server"].clone()).expect("server facts");
    assert_eq!(server.status, 200);
    assert_eq!(server.file_name, "probe.bin");
    assert_eq!(server.file_name_source, rdm_kernel::protocol::FileNameSource::ContentDisposition);
    assert_eq!(server.total_bytes, Some(bytes.len() as u64));
    assert!(server.range.supported);
    assert_eq!(server.range.accept_ranges, rdm_kernel::protocol::AcceptRanges::Bytes);
    assert_eq!(server.range.probed_by, rdm_kernel::protocol::ProbedBy::RangeGet);
    assert_eq!(server.range.probe_status, Some(206));
    assert_eq!(server.range.probe_bytes, 64);
    assert!(server.range.if_range, "strong ETag + ranges allows If-Range");
    assert!(server.validators.strong_etag);
    assert_eq!(server.resume.safety, rdm_kernel::protocol::ResumeSafety::Strong);
    assert_eq!(server.resume.reason, rdm_kernel::protocol::ResumeReason::StrongEtag);
    assert_eq!(server.checksum.sha256.as_deref(), Some("Z29vZA=="));
    assert_eq!(server.rate_limit.limit, Some(100));
    assert_eq!(server.recommendation.verify, rdm_kernel::protocol::VerifyAdvice::Recommended);
    assert!(server.tls.is_none(), "plain http has no TLS block");
    assert!(server.timing.probe_ms < 60_000);
    assert!(server.timing.sample_bps.is_none(), "a 64-byte range proof is not a throughput sample");

    // No ranges: degrade to single stream and no If-Range.
    fixture.set_supports_ranges(false);
    let params: ProbeParams = serde_json::from_value(json!({"url": fixture.url("/file")})).unwrap();
    let value = kernel.probe(params).await.expect("probe");
    let server: rdm_kernel::protocol::ServerFacts = serde_json::from_value(value["server"].clone()).unwrap();
    assert!(!server.range.supported);
    assert_eq!(server.resume.safety, rdm_kernel::protocol::ResumeSafety::None);
    assert_eq!(server.resume.reason, rdm_kernel::protocol::ResumeReason::NoRangeSupport);
    assert!(server.recommendation.single_stream);
    assert!(server.warnings.iter().any(|warning| warning == "no-range-support"));
    assert_eq!(server.total_bytes, Some(bytes.len() as u64));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_task_and_invalid_control_are_rejected() {
    let dir = TempDir::new("errors");
    let kernel = kernel(&dir);
    assert!(kernel.get("t_missing", 0).is_err());
    assert!(kernel.wait(&["t_missing".to_string()], 100).await.is_err());
    match kernel.control("t_missing", "pause", false).await {
        Err(error) => assert_eq!(error.code, "not_found"),
        Ok(_) => panic!("expected not_found"),
    }
    let fixture = Fixture::start(payload(1024));
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({}))).await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed);
    // Pausing a completed task is a conflict.
    match kernel.control(&view.id, "pause", false).await {
        Err(error) => assert_eq!(error.code, "conflict"),
        Ok(_) => panic!("expected conflict"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn telemetry_windows_and_detail_while_running() {
    let bytes = payload(3 * 1024 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_chunk_delay(Duration::from_millis(20));
    let dir = TempDir::new("telemetry-detail");
    let kernel = kernel(&dir);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({"connections": 2, "chunkSizeBytes": 262144}))).await;
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut detail = None;
    while Instant::now() < deadline {
        let value = kernel.get(&view.id, 20).expect("get");
        let candidate = value["detail"].clone();
        let samples = candidate["telemetry"]["samples"].as_u64().unwrap_or(0);
        let window_1s = candidate["telemetry"]["windows"]["1s"].as_u64();
        if samples >= 2 && window_1s.is_some() && candidate["telemetry"]["peakBps"].as_u64().unwrap_or(0) > 0 {
            detail = Some(candidate);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let detail = detail.expect("telemetry detail while running");
    for window in ["1s", "5s", "30s", "300s"] {
        assert!(detail["telemetry"]["windows"].get(window).is_some(), "{detail}");
    }
    assert!(detail["telemetry"]["samples"].as_u64().unwrap() >= 2);
    assert!(detail["telemetry"]["peakBps"].as_u64().unwrap() > 0);
    assert!(detail["telemetry"]["avgBps"].as_u64().unwrap() > 0);
    assert!(detail["telemetry"]["lastSampleAt"].as_u64().is_some());
    assert!(["rising", "steady", "falling", "stalled", "unknown"].contains(&detail["telemetry"]["trend"].as_str().unwrap_or("?")));
    assert!(["high", "medium", "low", "unknown"].contains(&detail["telemetry"]["etaConfidence"].as_str().unwrap_or("?")));
    assert!(detail["timing"]["transferMs"].as_u64().unwrap() > 0);
    assert!(detail["server"]["range"]["supported"].as_bool().unwrap_or(false));

    let final_view = wait_task(&kernel, &view.id, 120_000).await;
    assert_eq!(final_view.status, Status::Completed, "{:?}", final_view.error);
    assert_eq!(final_view.percent, Some(100));
    assert_eq!(final_view.speed_bps, 0, "idle tasks report 0 live rate");
    assert!(final_view.peak_bps > 0);
    assert_eq!(std::fs::read(final_view.path.clone().expect("path")).unwrap(), bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_id_roundtrip_and_list_filter() {
    let bytes = payload(64 * 1024);
    let fixture = Fixture::start(bytes.clone());
    let dir = TempDir::new("session");
    let kernel = kernel(&dir);
    let mut params = download_params(&fixture, &dir, json!({"sessionId": "sess_abc", "fileName": "sess.bin"}));
    params["sessionId"] = json!("sess_abc");
    let view = start_task(&kernel, params).await;
    assert_eq!(view.session_id.as_deref(), Some("sess_abc"));
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed);
    assert_eq!(view.session_id.as_deref(), Some("sess_abc"));

    let unattributed = start_task(&kernel, download_params(&fixture, &dir, json!({"fileName": "plain.bin"}))).await;
    assert!(unattributed.session_id.is_none());
    let unattributed = wait_task(&kernel, &unattributed.id, 60_000).await;
    assert_eq!(unattributed.status, Status::Completed);

    let scoped = kernel.list(None, Some("sess_abc"), 50);
    let tasks = scoped["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "{scoped}");
    assert_eq!(tasks[0]["id"], view.id);
    assert_eq!(scoped["aggregate"]["completed"], 1);
    let global = kernel.list(None, None, 50);
    assert_eq!(global["tasks"].as_array().unwrap().len(), 2);
    assert!(kernel.list(None, Some("sess_other"), 50)["tasks"].as_array().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn origin_ledger_records_terminal_state_and_probe_reads_it() {
    let bytes = payload(256 * 1024);
    let fixture = Fixture::start(bytes.clone());
    let dir = TempDir::new("origins");
    let kernel = kernel(&dir);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({}))).await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed);
    let host = view.host.clone();
    assert_eq!(host, "127.0.0.1");
    // Terminal transition persisted the ledger; probe reads it back.
    let params: ProbeParams = serde_json::from_value(json!({"url": fixture.url("/file")})).unwrap();
    let value = kernel.probe(params).await.expect("probe");
    let server: rdm_kernel::protocol::ServerFacts = serde_json::from_value(value["server"].clone()).unwrap();
    let origin = server.origin.expect("origin facts for a known host");
    assert!(origin.known);
    assert_eq!(origin.attempts, 1);
    assert_eq!(origin.completed, 1);
    assert!(origin.median_bps.unwrap_or(0) > 0);
    assert!(origin.last_at.is_some());
    let stats = kernel.stats();
    assert_eq!(stats["origins"], 1, "in-memory ledger is current when `wait` returns");
    // The file write is a coalesced background task: wait for it.
    let ledger_path = dir.path().join("origins.json");
    let deadline = Instant::now() + Duration::from_secs(3);
    while !ledger_path.is_file() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(ledger_path.is_file(), "background origin ledger save did not run");
    let ledger: Value = serde_json::from_slice(&std::fs::read(&ledger_path).unwrap()).unwrap();
    assert!(ledger["hosts"].get(&host).is_some(), "{ledger}");
}
