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
    second.initialize(config).await;
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
async fn probe_reports_metadata_and_range_support() {
    let bytes = payload(4096);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_content_disposition("attachment; filename=\"probe.bin\"");
    let dir = TempDir::new("probe");
    let kernel = kernel(&dir);
    let params: ProbeParams = serde_json::from_value(json!({
        "url": fixture.url("/file"),
    }))
    .unwrap();
    let value = kernel.probe(params).await.expect("probe");
    let meta: rdm_kernel::protocol::Meta = serde_json::from_value(value["meta"].clone()).unwrap();
    assert_eq!(meta.file_name, "probe.bin");
    assert_eq!(meta.total_bytes, Some(bytes.len() as u64));
    assert!(meta.supports_ranges);
    assert!(meta.etag.is_some());

    fixture.set_supports_ranges(false);
    let params: ProbeParams = serde_json::from_value(json!({"url": fixture.url("/file")})).unwrap();
    let value = kernel.probe(params).await.expect("probe");
    let meta: rdm_kernel::protocol::Meta = serde_json::from_value(value["meta"].clone()).unwrap();
    assert!(!meta.supports_ranges);
    assert_eq!(meta.total_bytes, Some(bytes.len() as u64));
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
