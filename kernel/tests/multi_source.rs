//! Multi-source (0.3.0) integration tests: selection, failover, content
//! identity, race scheduling and Metalink/HTTP discovery.
//!
//! Offline: two or more in-process HTTP fixtures on 127.0.0.1.

mod common;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use common::{payload, Fixture};
use rdm_kernel::kernel::Kernel;
use rdm_kernel::protocol::{RequestSpec, Status, TaskView};
use serde_json::{json, Value};

static SEQ: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("tmp").join(format!("rdm-ms-{tag}-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
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

async fn wait_task(kernel: &Kernel, id: &str, timeout_ms: u64) -> TaskView {
    let value = kernel.wait(&[id.to_string()], timeout_ms).await.expect("wait");
    serde_json::from_value(value["tasks"][0].clone()).expect("task view")
}

async fn detail_events(kernel: &Kernel, id: &str) -> Vec<Value> {
    let value = kernel.get(id, 50).expect("get");
    value["events"].as_array().cloned().unwrap_or_default()
}

fn source(url: &str) -> Value {
    json!({ "url": url })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn select_picks_the_faster_mirror_and_reports_it() {
    let bytes = payload(2 * 1024 * 1024);
    let slow = Fixture::start(bytes.clone());
    let fast = Fixture::start(bytes.clone());
    slow.set_chunk_delay(Duration::from_millis(80));
    let dir = TempDir::new("select");
    let kernel = kernel(&dir);
    let view = start_task(
        &kernel,
        json!({
            "url": slow.url("/file"),
            "sources": [source(&fast.url("/file"))],
            "sourcePolicy": "select",
            "dir": dir.as_str(),
            "connections": 2,
            "maxConnections": 4,
        }),
    )
    .await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert_eq!(view.sources.len(), 2, "both candidates should be reported: {:?}", view.sources);
    assert_eq!(view.selected_source, Some(1), "the fast alternate should win: {:?}", view.sources);
    assert!(fast.range_requests() > slow.range_requests(), "fast={} slow={}", fast.range_requests(), slow.range_requests());
    assert_eq!(std::fs::read(dir.path().join("file")).expect("file"), bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failover_switches_after_the_primary_starts_failing() {
    let bytes = payload(2 * 1024 * 1024);
    let primary = Fixture::start(bytes.clone());
    let alternate = Fixture::start(bytes.clone());
    primary.set_fail_after(1); // probe GET succeeds, transfer GETs fail
    // Make the alternate deliberately slower for the probe so the primary is
    // selected deterministically; failover then has to move to the slower but
    // healthy mirror.
    alternate.set_chunk_delay(Duration::from_millis(20));
    let dir = TempDir::new("failover");
    let kernel = kernel(&dir);
    let view = start_task(
        &kernel,
        json!({
            "url": primary.url("/file"),
            "sources": [source(&alternate.url("/file"))],
            "sourcePolicy": "failover",
            "dir": dir.as_str(),
            "connections": 2,
            "maxConnections": 4,
            "maxAttempts": 6,
        }),
    )
    .await;
    let view = wait_task(&kernel, &view.id, 90_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert!(view.source_switches >= 1, "expected a source switch: {:?}", view.sources);
    assert!(view.sources.iter().any(|source| source.state == "bad"), "the failed source should be marked bad: {:?}", view.sources);
    assert!(alternate.range_requests() > 0);
    assert_eq!(std::fs::read(dir.path().join("file")).expect("file"), bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn select_does_not_switch_when_content_identity_is_unproven() {
    let bytes = payload(1024 * 1024);
    let primary = Fixture::start(bytes.clone());
    let alternate = Fixture::start(bytes.clone());
    alternate.set_etag("\"different-object\"");
    primary.set_fail_after(1);
    let dir = TempDir::new("identity");
    let kernel = kernel(&dir);
    let view = start_task(
        &kernel,
        json!({
            "url": primary.url("/file"),
            "sources": [source(&alternate.url("/file"))],
            "sourcePolicy": "failover",
            "dir": dir.as_str(),
            "connections": 2,
            "maxConnections": 4,
            "maxAttempts": 2,
        }),
    )
    .await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    // Different strong ETags mean the bytes cannot be mixed; the pool must not
    // silently splice the alternate. The transfer either fails or completes
    // from the primary, but it never reports a switch.
    assert_eq!(view.source_switches, 0, "unproven content must not switch: {:?}", view.sources);
    assert_eq!(view.source_policy, "select", "failover must downgrade without a shared identity");
    assert!(view.status == Status::Failed || view.status == Status::Completed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn race_assigns_chunks_to_both_sources() {
    let bytes = payload(4 * 1024 * 1024);
    let first = Fixture::start(bytes.clone());
    let second = Fixture::start(bytes.clone());
    first.set_chunk_delay(Duration::from_millis(8));
    second.set_chunk_delay(Duration::from_millis(8));
    let dir = TempDir::new("race");
    let kernel = kernel(&dir);
    let view = start_task(
        &kernel,
        json!({
            "url": first.url("/file"),
            "sources": [source(&second.url("/file"))],
            "sourcePolicy": "race",
            "dir": dir.as_str(),
            "connections": 2,
            "maxConnections": 2,
            "chunkSizeBytes": 262144,
            "maxAttempts": 6,
        }),
    )
    .await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert_eq!(view.source_policy, "race");
    assert!(view.sources.iter().all(|source| source.bytes > 0), "race should use both sources: {:?}", view.sources);
    assert_eq!(std::fs::read(dir.path().join("file")).expect("file"), bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn race_ignores_a_much_slower_mirror() {
    let bytes = payload(4 * 1024 * 1024);
    let first = Fixture::start(bytes.clone());
    let second = Fixture::start(bytes.clone());
    let slow = Fixture::start(bytes.clone());
    slow.set_chunk_delay(Duration::from_millis(120));
    let dir = TempDir::new("race-slow");
    let kernel = kernel(&dir);
    let view = start_task(
        &kernel,
        json!({
            "url": first.url("/file"),
            "sources": [source(&second.url("/file")), source(&slow.url("/file"))],
            "sourcePolicy": "race",
            "dir": dir.as_str(),
            "connections": 2,
            "maxConnections": 6,
            "chunkSizeBytes": 262144,
            "maxAttempts": 6,
        }),
    )
    .await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert_eq!(view.sources.len(), 3);
    let slow_bytes = view.sources.iter().find(|source| source.url.contains(&slow.addr.to_string())).map(|source| source.bytes).unwrap_or(0);
    assert_eq!(slow_bytes, 0, "a source measured far below the best must not receive race claims: {:?}", view.sources);
    assert_eq!(std::fs::read(dir.path().join("file")).expect("file"), bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hedge_writes_a_validated_first_range() {
    let bytes = payload(2 * 1024 * 1024);
    let slow = Fixture::start(bytes.clone());
    let fast = Fixture::start(bytes.clone());
    slow.set_chunk_delay(Duration::from_millis(40));
    let dir = TempDir::new("hedge");
    let kernel = kernel(&dir);
    let view = start_task(
        &kernel,
        json!({
            "url": slow.url("/file"),
            "sources": [source(&fast.url("/file"))],
            "sourcePolicy": "hedge",
            "sourceRaceBytes": 262144,
            "dir": dir.as_str(),
            "connections": 2,
            "maxConnections": 4,
        }),
    )
    .await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    let events = detail_events(&kernel, &view.id).await;
    assert!(events.iter().any(|event| event["message"].as_str().is_some_and(|message| message.contains("hedged"))), "hedge event missing: {events:?}");
    assert_eq!(std::fs::read(dir.path().join("file")).expect("file"), bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metalink_http_link_discovers_a_mirror() {
    let bytes = payload(2 * 1024 * 1024);
    let primary = Fixture::start(bytes.clone());
    let alternate = Fixture::start(bytes.clone());
    primary.set_header("Link", &format!("<{}>; rel=\"duplicate\"; pri=2", alternate.url("/file")));
    let dir = TempDir::new("link");
    let kernel = kernel(&dir);
    let view = start_task(
        &kernel,
        json!({
            "url": primary.url("/file"),
            "sourcePolicy": "select",
            "dir": dir.as_str(),
            "connections": 2,
            "maxConnections": 4,
        }),
    )
    .await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert_eq!(view.sources.len(), 2, "discovered mirror missing: {:?}", view.sources);
    assert!(view.sources.iter().any(|source| source.role == "discovered"), "role: {:?}", view.sources);
    assert_eq!(std::fs::read(dir.path().join("file")).expect("file"), bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metalink_document_resolves_to_its_file_and_hash() {
    let bytes = payload(1024 * 1024);
    let fixture = Fixture::start(bytes.clone());
    let dir = TempDir::new("metalink");
    let kernel = kernel(&dir);
    let view = start_task(
        &kernel,
        json!({
            "url": fixture.url("/metalink.meta4"),
            "dir": dir.as_str(),
            "connections": 2,
        }),
    )
    .await;
    let view = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert!(view.url.ends_with("/file"), "resolved URL: {}", view.url);
    assert!(view.expected_sha256.is_some(), "Metalink hash must become the expected SHA-256");
    assert_eq!(view.verified, Some(true));
    assert_eq!(std::fs::read(dir.path().join("file")).expect("file"), bytes);
}
