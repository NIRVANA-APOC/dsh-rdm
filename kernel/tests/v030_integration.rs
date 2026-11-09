//! 0.2.1 integration tests: the real-data fixes verified through the public
//! kernel API (frozen spec `.design/0.3.0-spec.md` §4; shipped as release 0.2.1
//! in the 0.2.2 versioning pass — the file name keeps its original task tag).
//!
//! Coverage:
//! * resume decision matrix through a real in-process HTTP fixture and a real
//!   `Kernel`: stable identity vs volatile final URL (ModelScope `auth_key`
//!   tokens), changed validators, changed size, a legacy 0.2.0 `.part.json`
//!   without the new identity fields, and a truncated `.part`;
//! * `auth_key` credential redaction in `finalUrl`, redirect hops, task views
//!   and event/diagnostic text, plus `signedUrl.signed` detection;
//! * adaptive controller state machine (growth, diluted-growth revert, collapse
//!   pool rebuild + growth, pushback halving, hard cap);
//! * persisted JSONL recording (writer append, sample cap/truncation marker,
//!   raw paging, even downsampling), `Task::report` sample recording and the
//!   `history` RPC surviving a kernel restart;
//! * tail stall-timeout helper thresholds and the new protocol fields.
//!
//! All tests are offline: the HTTP fixture is a `std::net::TcpListener` on
//! 127.0.0.1.

mod common;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{payload, Fixture};
use rdm_kernel::controller::{Controller, ControllerEffect, ControllerTick, COLLAPSE_PROBE_TICKS, WARMUP_TICKS};
use rdm_kernel::engine;
use rdm_kernel::facts::signed_url_facts;
use rdm_kernel::history::{self, HistoryWriter, SampleRecord, MAX_RECORDED_SAMPLES};
use rdm_kernel::kernel::Kernel;
use rdm_kernel::protocol::{self, now_ms, url_identity, Config, Meta, RedirectHop, RequestSpec, ServerFacts, Spec, Status, TaskView};
use rdm_kernel::state::{ResumeOutcome, ResumeState};
use rdm_kernel::task::Task;
use serde_json::{json, Value};
use url::Url;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Workspace-owned temp dir (the sandbox denies writes under os.tmpdir()).
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("tmp").join(format!("rdm-v030-{tag}-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
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

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn download_params(fixture: &Fixture, dir: &TempDir, extra: Value) -> Value {
    let mut params = json!({
        "url": fixture.url("/file"),
        "dir": dir.as_str(),
        "connections": 2,
    });
    if let Value::Object(entries) = extra {
        for (key, value) in entries {
            params[key] = value;
        }
    }
    params
}

/// `get` -> `detail.resumeState` projection: (decision, reason, resumed bytes).
fn resume_state(kernel: &Kernel, id: &str) -> (Option<String>, Option<String>, u64) {
    let value = kernel.get(id, 0).expect("get");
    let state = &value["detail"]["resumeState"];
    (
        state["resumeDecision"].as_str().map(str::to_string),
        state["resumeReason"].as_str().map(str::to_string),
        state["resumedBytes"].as_u64().unwrap_or(0),
    )
}

/// Start a transfer, wait until enough chunks completed that a pause persists a
/// usable resume state, then pause. Pausing forces an fsync write of `.part.json`.
/// Returns `(task id, target path, `.part.json` content after the pause)`.
async fn start_and_pause(kernel: &Kernel, fixture: &Fixture, dir: &TempDir, name: &str, bytes: usize) -> (String, PathBuf, Value) {
    let view = start_task(kernel, download_params(fixture, dir, json!({"connections": 2, "chunkSizeBytes": 262144, "fileName": name}))).await;
    let waited = wait_until(kernel, &view.id, "enough completed chunks before pause", Duration::from_secs(30), |view| view.downloaded >= (bytes as u64 / 4)).await;
    let path = PathBuf::from(waited.path.clone().expect("target path"));
    let paused = control(kernel, &view.id, "pause").await;
    assert_eq!(paused.status, Status::Paused);
    let state: Value = serde_json::from_slice(&std::fs::read(suffixed(&path, ".part.json")).expect("state file")).expect("state json");
    (view.id, path, state)
}

fn write_state(path: &Path, state: &Value) {
    std::fs::write(path, serde_json::to_vec_pretty(state).expect("state serialize")).expect("state write");
}

// ---------------------------------------------------------------------------
// Protocol surface (§1.2, §1.3, §1.4)
// ---------------------------------------------------------------------------

#[test]
fn request_spec_resolves_the_adaptive_cap() {
    let resolve = |value: Value| Spec::resolve(serde_json::from_value::<RequestSpec>(value).expect("request spec"), &Config::default()).expect("spec resolves");

    assert_eq!(protocol::MAX_CONNECTIONS, 128);
    assert_eq!(protocol::DEFAULT_MAX_CONNECTIONS, 128);
    assert_eq!(Config::default().max_connections, protocol::DEFAULT_MAX_CONNECTIONS);
    // initialize config normalization never drops below `connections` or above 128.
    let config = Config { connections: 4, max_connections: 4096, ..Config::default() }.normalized();
    assert_eq!(config.max_connections, 128);
    let config = Config { connections: 16, max_connections: 2, ..Config::default() }.normalized();
    assert_eq!(config.max_connections, 16);

    // start params: clamped to [connections, MAX_CONNECTIONS].
    let spec = resolve(json!({"url": "https://example.com/a.bin", "connections": 8, "maxConnections": 5000}));
    assert_eq!(spec.connections, 8);
    assert_eq!(spec.max_connections, 128);
    let spec = resolve(json!({"url": "https://example.com/a.bin", "connections": 8, "maxConnections": 2}));
    assert_eq!(spec.max_connections, 8, "the cap can never sit below the initial population");
    // singleStream forces one worker and one slot.
    let spec = resolve(json!({"url": "https://example.com/a.bin", "connections": 8, "singleStream": true, "maxConnections": 64}));
    assert_eq!(spec.connections, 1);
    assert_eq!(spec.max_connections, 1);
    // unspecified inherits the configured default.
    let spec = resolve(json!({"url": "https://example.com/a.bin"}));
    assert_eq!(spec.max_connections, Config::default().max_connections);
    // connections itself is clamped to 1..=128.
    let spec = resolve(json!({"url": "https://example.com/a.bin", "connections": 999}));
    assert_eq!(spec.connections, 128);
}

#[test]
fn task_view_serializes_the_adaptive_fields() {
    let mut view = TaskView::default();
    view.max_connections = 128;
    view.target_workers = 16;
    view.resumed_bytes = 4096;
    let value = serde_json::to_value(&view).expect("serialize");
    assert_eq!(value["maxConnections"], 128);
    assert_eq!(value["targetWorkers"], 16);
    assert_eq!(value["resumedBytes"], 4096);

    // A 0.2.0-format view JSON without the new fields still loads (additive only).
    let mut old = serde_json::to_value(TaskView::default()).expect("serialize");
    let object = old.as_object_mut().expect("object");
    object.remove("maxConnections");
    object.remove("targetWorkers");
    object.remove("resumedBytes");
    let decoded: TaskView = serde_json::from_value(old).expect("0.2.0 view loads");
    assert_eq!(decoded.max_connections, protocol::DEFAULT_MAX_CONNECTIONS);
    assert_eq!(decoded.target_workers, 0);
    assert_eq!(decoded.resumed_bytes, 0);
}

// ---------------------------------------------------------------------------
// Resume decision matrix (§0 #1, §1.5, §4)
// ---------------------------------------------------------------------------

fn meta(final_url: &str, etag: Option<&str>, last_modified: Option<&str>) -> Meta {
    Meta {
        final_url: final_url.to_string(),
        file_name: "a.gguf".to_string(),
        total_bytes: Some(4096),
        supports_ranges: true,
        content_type: None,
        etag: etag.map(str::to_string),
        last_modified: last_modified.map(str::to_string),
        http_version: None,
    }
}

#[test]
fn resume_outcomes_cover_the_decision_matrix() {
    let original = "https://modelscope.cn/resolve/master/a.gguf";
    // Real session_logs shape: the same ModelScope object, two probes, two
    // different `auth_key` tokens in the final URL.
    let first = "https://cdn-lfs-cn-1.modelscope.cn/prod/lfs/a?filename=a.gguf&auth_key=1794154377-aa-0-bb";
    let second = "https://cdn-lfs-cn-1.modelscope.cn/prod/lfs/a?filename=a.gguf&auth_key=1794154910-cc-0-dd";
    let strong_etag = "\"77B298633474EED5463C3687BDE3A275-400\"";
    let mut state = ResumeState::new(original, &meta(first, Some(strong_etag), None), 4096, 1024, vec![(0, 2048)], 2048);

    // Same etag + volatile final-URL token: accepted via the stable identity.
    assert_eq!(state.is_compatible(original, &meta(second, Some(strong_etag), None), 4096), ResumeOutcome::Accepted("etag"));
    // No validators survive: the requested URL is still a stable identity.
    state.etag = None;
    assert_eq!(state.is_compatible(original, &meta(second, None, None), 4096), ResumeOutcome::Accepted("url"));
    // Changed etag -> validators-mismatch (never a silent restart or stale bytes).
    state.etag = Some("\"v1\"".to_string());
    assert_eq!(state.is_compatible(original, &meta(second, Some("\"v2\""), None), 4096), ResumeOutcome::Rejected("validators-mismatch"));
    // Changed size -> size-mismatch.
    state.etag = Some(strong_etag.to_string());
    assert_eq!(state.is_compatible(original, &meta(second, Some(strong_etag), None), 4097), ResumeOutcome::Rejected("size-mismatch"));
    // Different origin and path -> url-mismatch. The *saved* requested URL is
    // mirror-a while the current request is the ModelScope original.
    let saved = ResumeState::new(
        "https://mirror-a.example.com/a.gguf",
        &meta("https://mirror-a.example.com/a.gguf", None, None),
        4096,
        1024,
        vec![(0, 1024)],
        1024,
    );
    assert_eq!(saved.is_compatible(original, &meta("https://mirror-b.example.com/b.zip", None, None), 4096), ResumeOutcome::Rejected("url-mismatch"));
    // Last-Modified plus the same path is enough when the etag is gone.
    let last_modified = "Thu, 24 Sep 2026 20:15:00 GMT";
    let saved = ResumeState::new(original, &meta("https://cdn.example.com/a.gguf?token=1", None, Some(last_modified)), 4096, 1024, vec![(0, 1024)], 1024);
    assert_eq!(
        saved.is_compatible(original, &meta("https://cdn.example.com/a.gguf?token=2", None, Some(last_modified)), 4096),
        ResumeOutcome::Accepted("last-modified")
    );
    // Invalid saved ranges are rejected instead of trusted.
    let mut saved = ResumeState::new(original, &meta(first, Some(strong_etag), None), 4096, 1024, vec![(0, 1024)], 1024);
    saved.completed_ranges = vec![[0, 5000]];
    assert_eq!(saved.is_compatible(original, &meta(second, Some(strong_etag), None), 4096), ResumeOutcome::Rejected("ranges-invalid"));

    // The resume identity primitive strips volatile query material.
    assert_eq!(url_identity(first), url_identity(second));
    assert_ne!(url_identity(first), url_identity("https://cdn-lfs-cn-1.modelscope.cn/prod/lfs/b?x=1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_accepts_a_volatile_final_url_from_a_legacy_020_state() {
    let bytes = payload(2 * 1024 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_chunk_delay(Duration::from_millis(90));
    let dir = TempDir::new("resume-volatile");
    let kernel = kernel(&dir);
    let (id, path, mut state) = start_and_pause(&kernel, &fixture, &dir, "volatile.bin", bytes.len()).await;

    // Rewrite the persisted state as a 0.2.0 kernel would have written it:
    // no derived identity fields, and a finalUrl carrying an expired per-request
    // `auth_key` token that the next probe will never reproduce.
    let object = state.as_object_mut().expect("state object");
    object.insert(
        "finalUrl".to_string(),
        Value::String(format!("{}?filename=volatile.bin&auth_key=1794154377-old-token-0-deadbeef", fixture.url("/file"))),
    );
    object.remove("urlIdentity");
    object.remove("finalUrlIdentity");
    write_state(&suffixed(&path, ".part.json"), &state);

    let resumed = control(&kernel, &id, "resume").await;
    assert_eq!(resumed.status, Status::Queued);
    let view = wait_task(&kernel, &id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert!(view.resumed_bytes > 0, "the legacy state must be adopted: {view:?}");
    assert!(view.resumed_chunks > 0, "resumed_chunks={}", view.resumed_chunks);
    assert_eq!(std::fs::read(&path).expect("file"), bytes, "resumed bytes must be byte-identical");
    assert!(!suffixed(&path, ".part").exists());
    assert!(!suffixed(&path, ".part.json").exists());

    let (decision, reason, resumed_bytes) = resume_state(&kernel, &id);
    assert_eq!(decision.as_deref(), Some("accepted"));
    assert_eq!(reason.as_deref(), Some("etag"), "the same strong ETag is the accepted reason");
    assert!(resumed_bytes > 0, "resumeState.resumedBytes={resumed_bytes}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_rejects_a_changed_validator() {
    let bytes = payload(1536 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_chunk_delay(Duration::from_millis(90));
    let dir = TempDir::new("resume-etag");
    let kernel = kernel(&dir);
    let (id, path, _state) = start_and_pause(&kernel, &fixture, &dir, "etag.bin", bytes.len()).await;

    fixture.set_etag("\"v2-changed\"");
    let _ = control(&kernel, &id, "resume").await;
    let view = wait_task(&kernel, &id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert_eq!(view.resumed_chunks, 0, "changed validators must restart from zero");
    assert_eq!(std::fs::read(&path).expect("file"), bytes);

    let (decision, reason, resumed_bytes) = resume_state(&kernel, &id);
    assert_eq!(decision.as_deref(), Some("rejected"));
    assert_eq!(reason.as_deref(), Some("validators-mismatch"));
    assert_eq!(resumed_bytes, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_rejects_a_changed_size() {
    let bytes = payload(1024 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_chunk_delay(Duration::from_millis(90));
    let dir = TempDir::new("resume-size");
    let kernel = kernel(&dir);
    let (id, path, mut state) = start_and_pause(&kernel, &fixture, &dir, "size.bin", bytes.len()).await;

    let total = state["totalBytes"].as_u64().expect("totalBytes");
    state["totalBytes"] = Value::from(total + 1);
    write_state(&suffixed(&path, ".part.json"), &state);

    let _ = control(&kernel, &id, "resume").await;
    let view = wait_task(&kernel, &id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert_eq!(view.resumed_chunks, 0);
    assert_eq!(std::fs::read(&path).expect("file"), bytes);

    let (decision, reason, _) = resume_state(&kernel, &id);
    assert_eq!(decision.as_deref(), Some("rejected"));
    assert_eq!(reason.as_deref(), Some("size-mismatch"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_rejects_a_truncated_part() {
    let bytes = payload(1024 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_chunk_delay(Duration::from_millis(90));
    let dir = TempDir::new("resume-truncated");
    let kernel = kernel(&dir);
    let (id, path, state) = start_and_pause(&kernel, &fixture, &dir, "truncated.bin", bytes.len()).await;

    let ranges = state["completedRanges"].as_array().expect("completedRanges");
    let max_end = ranges.last().and_then(|range| range[1].as_u64()).expect("a completed range");
    assert!(max_end > 64 * 1024, "resume seed too small: {max_end}");
    let part = suffixed(&path, ".part");
    std::fs::OpenOptions::new()
        .write(true)
        .open(&part)
        .expect("open part")
        .set_len(max_end - 64 * 1024)
        .expect("truncate part");

    let _ = control(&kernel, &id, "resume").await;
    let view = wait_task(&kernel, &id, 60_000).await;
    assert_eq!(view.status, Status::Completed, "{:?}", view.error);
    assert_eq!(view.resumed_chunks, 0, "a truncated .part must never be trusted");
    assert_eq!(std::fs::read(&path).expect("file"), bytes);

    let (decision, reason, resumed_bytes) = resume_state(&kernel, &id);
    assert_eq!(decision.as_deref(), Some("rejected"));
    assert_eq!(reason.as_deref(), Some("part-truncated"));
    assert_eq!(resumed_bytes, 0);
}

// ---------------------------------------------------------------------------
// auth_key redaction + signed detection (§0 #4, §4)
// ---------------------------------------------------------------------------

const AUTH_KEY_SECRET: &str = "1794154377-c6fc216ba8e4466d89b9af721eb2cf8d-0-cb444b28d3878bfbb67e715a719a58f5";

fn auth_key_url() -> String {
    format!("https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/ca/3b/302d?filename=a.gguf&namespace=ukisai&repository=r&revision=master&tag=model&auth_key={AUTH_KEY_SECRET}")
}

#[test]
fn auth_key_is_redacted_from_every_projection() {
    let raw = auth_key_url();
    let redacted = protocol::redact_url(&raw);
    assert!(redacted.contains("auth_key=<redacted>"), "{redacted}");
    assert!(!redacted.contains(AUTH_KEY_SECRET), "credential leaked: {redacted}");
    assert!(redacted.contains("filename=a.gguf"), "non-credential params are preserved: {redacted}");
    assert!(redacted.contains("/prod/lfs-objects/ca/3b/302d"), "the stable path is preserved: {redacted}");

    // ServerFacts projection: finalUrl and every redirect hop.
    let mut facts = ServerFacts::default();
    facts.url = "https://modelscope.cn/resolve/master/a.gguf".to_string();
    facts.final_url = raw.clone();
    facts.redirects = vec![RedirectHop { status: 302, url: raw.clone() }];
    let projected = facts.clone().redacted();
    assert!(projected.final_url.contains("auth_key=<redacted>"), "{}", projected.final_url);
    assert!(!projected.final_url.contains(AUTH_KEY_SECRET));
    assert!(projected.redirects[0].url.contains("auth_key=<redacted>"), "{}", projected.redirects[0].url);
    assert!(!projected.redirects[0].url.contains(AUTH_KEY_SECRET), "redirect hop leaked the token");

    // Free-form diagnostic text (event ring + error messages).
    let text = format!("probe HEAD failed: error sending request for url ({raw})");
    let redacted_text = protocol::redact_text(&text);
    assert!(!redacted_text.contains(AUTH_KEY_SECRET), "{redacted_text}");
    assert!(redacted_text.contains("<redacted>"), "{redacted_text}");

    // Task view projection goes through the same redaction.
    let dir = TempDir::new("redaction-view");
    let raw_spec: RequestSpec = serde_json::from_value(json!({"url": raw, "dir": dir.as_str()})).expect("request spec");
    let spec = Spec::resolve(raw_spec, &Config::default()).expect("spec resolves");
    let task = Task::new("t_redact".to_string(), spec, Arc::new(tokio::sync::Notify::new()));
    task.set_server(&facts);
    let view = task.view();
    assert!(view.url.contains("auth_key=<redacted>"), "{}", view.url);
    assert!(!view.url.contains(AUTH_KEY_SECRET));
    let final_url = view.final_url.expect("final url");
    assert!(final_url.contains("auth_key=<redacted>"), "{final_url}");
    assert!(!final_url.contains(AUTH_KEY_SECRET));

    // Event text is redacted before it reaches the ring and the recording.
    task.add_event("probe", Some(format!("redirected to {raw}")), None, None, None);
    let events = task.events(10);
    let message = events[0].message.as_deref().unwrap_or("");
    assert!(!message.contains(AUTH_KEY_SECRET), "{message}");
    assert!(message.contains("<redacted>"), "{message}");
}

#[test]
fn auth_key_url_is_detected_as_signed() {
    let url = Url::parse(&auth_key_url()).expect("url");
    let facts = signed_url_facts(&url, &url, now_ms());
    assert!(facts.signed, "auth_key means signed-URL material");
    assert!(facts.expires_at.is_none(), "auth_key carries no parsable expiry");
    let plain = Url::parse("https://example.com/a.zip").expect("url");
    assert!(!signed_url_facts(&plain, &plain, now_ms()).signed);
    // The original URL is a fallback when a redirect lands on a bare final URL.
    let signed_original = Url::parse(&auth_key_url()).expect("url");
    let bare_final = Url::parse("https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/ca/3b/302d").expect("url");
    assert!(signed_url_facts(&bare_final, &signed_original, now_ms()).signed);
}

// ---------------------------------------------------------------------------
// Adaptive controller state machine (§0 #2/#3, §4)
// ---------------------------------------------------------------------------

const MIB: f64 = 1024.0 * 1024.0;

/// Non-tail tick: plenty of claim units remain, so the 0.2.2 tail freeze
/// (`remaining_units <= target`) does not apply.
fn tick(delta_mib: f64, active: f64, cap: usize) -> ControllerTick {
    ControllerTick {
        delta_bytes: (delta_mib * MIB) as u64,
        elapsed_secs: 1.0,
        active_avg: active,
        pushback: false,
        cap,
        remaining_units: cap.saturating_mul(64).max(4096),
    }
}

fn pushback_tick(delta_mib: f64, active: f64, cap: usize) -> ControllerTick {
    ControllerTick { pushback: true, ..tick(delta_mib, active, cap) }
}

fn targets(effects: &[ControllerEffect]) -> Vec<usize> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            ControllerEffect::SetTarget { target, .. } => Some(*target),
            ControllerEffect::RebuildPool { .. } | ControllerEffect::Note { .. } => None,
        })
        .collect()
}

fn has_rebuild(effects: &[ControllerEffect]) -> bool {
    effects.iter().any(|effect| matches!(effect, ControllerEffect::RebuildPool { .. }))
}

#[test]
fn controller_grows_while_per_connection_rate_holds() {
    let mut controller = Controller::new(8, 128);
    // session_logs: 16 connections sustained ~68.5 MiB/s; per-connection rate
    // is healthy, so the controller may probe above the requested population.
    let mut last_targets = Vec::new();
    for _ in 0..3 {
        let effects = controller.step(&tick(68.5, 8.0, 128));
        let grown = targets(&effects);
        if !grown.is_empty() {
            last_targets = grown;
        }
    }
    assert!(!last_targets.is_empty(), "healthy per-connection rate should probe upward");
    assert!(last_targets[0] > 8, "targets={last_targets:?}");
    assert!(controller.target() > 8, "target={}", controller.target());
    assert!(controller.target() <= controller.max_workers());
}

#[test]
fn controller_reverts_growth_that_drops_the_aggregate_rate() {
    // 0.2.2 judges growth probes on the aggregate rate (keep >= 95 %), so a
    // revert requires an aggregate drop larger than 5 %, not per-connection
    // dilution with a flat aggregate.
    let mut controller = Controller::new(8, 128);
    let _ = controller.step(&tick(40.0, 8.0, 128));
    let grown = controller.target();
    assert!(grown > 8, "the first healthy tick grows: {grown}");
    let effects = controller.step(&tick(30.0, grown as f64, 128));
    assert!(targets(&effects).contains(&8), "expected a revert to 8, got {effects:?}");
    assert_eq!(controller.target(), 8);
}

#[test]
fn controller_detects_a_collapse_and_rebuilds_the_pool_with_more_workers() {
    let mut controller = Controller::new(32, 128);
    // Real step-down: 56.9 MiB/s -> 9.3 MiB/s with the whole current pool busy.
    for _ in 0..(WARMUP_TICKS + 4) {
        let _ = controller.step(&tick(56.9, 32.0, 128));
    }
    assert!(controller.target() >= 32, "target={}", controller.target());
    // Feed the step-down with every current worker pinned (active == target):
    // completion cannot explain the drop, so a pool rebuild + upward probe is due.
    let mut rebuild = None;
    for _ in 0..8 {
        let active = controller.target() as f64;
        let collapsed_at = controller.target();
        let effects = controller.step(&tick(9.3, active, 128));
        if has_rebuild(&effects) {
            rebuild = Some((collapsed_at, effects));
            break;
        }
    }
    let (collapsed_at, rebuild) = rebuild.expect("a pinned throughput collapse must trigger a pool rebuild");
    assert_eq!(controller.rebuilds(), 1);
    assert!(
        targets(&rebuild).iter().any(|target| *target > collapsed_at),
        "a rebuild must probe more workers than the collapse target {collapsed_at}, got {rebuild:?}"
    );
}

#[test]
fn controller_rebuild_that_does_not_recover_reverts() {
    let mut controller = Controller::new(32, 128);
    for _ in 0..(WARMUP_TICKS + 4) {
        let _ = controller.step(&tick(56.9, 32.0, 128));
    }
    let mut found = None;
    for _ in 0..8 {
        let active = controller.target() as f64;
        let before = controller.target();
        let effects = controller.step(&tick(9.3, active, 128));
        if has_rebuild(&effects) {
            let probe_target = targets(&effects).first().copied().unwrap_or(before);
            found = Some((before, probe_target));
            break;
        }
    }
    let (pre_collapse, probe_target) = found.expect("a pinned throughput collapse must trigger a pool rebuild");
    assert!(probe_target >= pre_collapse);
    // Probe window: throughput stays low -> revert to the pre-collapse target.
    let mut reverted = None;
    for _ in 0..COLLAPSE_PROBE_TICKS {
        let effects = controller.step(&tick(9.3, probe_target as f64, probe_target));
        if let Some(target) = targets(&effects).first().copied() {
            reverted = Some(target);
        }
    }
    assert_eq!(reverted, Some(pre_collapse), "a failed rebuild probe must revert to the pre-collapse target");
    assert_eq!(controller.target(), pre_collapse);
}

#[test]
fn controller_backs_off_on_server_pushback() {
    let mut controller = Controller::new(32, 128);
    for _ in 0..(WARMUP_TICKS + 4) {
        let _ = controller.step(&tick(56.0, 32.0, 128));
    }
    let before = controller.target();
    let effects = controller.step(&pushback_tick(20.0, before as f64, 128));
    let halved = (before / 2).max(1);
    assert_eq!(controller.target(), halved, "429/503 pushback halves the pool");
    assert_eq!(targets(&effects), vec![halved], "pushback must not grow in the same tick");
}

#[test]
fn controller_growth_never_exceeds_max_workers() {
    let mut controller = Controller::new(2, 4);
    for _ in 0..20 {
        let effects = controller.step(&tick(5.0, 2.0, 4));
        for target in targets(&effects) {
            assert!(target <= 4, "target {target} above max_workers 4: {effects:?}");
        }
        assert!(controller.target() <= 4);
    }
    assert_eq!(controller.max_workers(), 4);
}

// ---------------------------------------------------------------------------
// Persisted recording (§0 #5, §1.7, §4)
// ---------------------------------------------------------------------------

fn sample(t: u64, bytes: u64) -> SampleRecord {
    SampleRecord { t, bytes, transferred: bytes, bps: 0, w1_bps: None, w5_bps: None, w30_bps: None, w300_bps: None, workers: 0, peak_workers: 0, stalled_ms: 0 }
}

#[test]
fn history_writer_appends_jsonl_and_reader_pages() {
    let dir = TempDir::new("history-api");
    let history_dir = dir.path().join("history");
    let writer = HistoryWriter::new(&history_dir, "t_api");
    for index in 0..5u64 {
        writer.record_sample(&sample(1000 + index, index * 10));
    }
    writer.record_event(&history::event_record(1, 1000, "plan", Some("plan".into()), None, None, None));
    writer.record_event(&history::event_record(2, 1001, "completed", Some("download completed".into()), None, None, None));
    writer.flush();

    assert_eq!(writer.sample_count(), 5);
    assert_eq!(writer.event_count(), 2);
    assert!(writer.sample_path().exists(), "samples JSONL file");
    assert!(writer.event_path().exists(), "events JSONL file");
    let raw_samples = std::fs::read_to_string(writer.sample_path()).expect("samples file");
    let first_line: Value = serde_json::from_str(raw_samples.lines().next().expect("line")).expect("json");
    assert_eq!(first_line["t"], 1000);
    assert_eq!(first_line["bytes"], 0);
    for key in ["t", "bytes", "bps", "w1Bps", "w5Bps", "w30Bps", "w300Bps", "workers", "peakWorkers", "stalledMs"] {
        assert!(first_line.get(key).is_some(), "sample JSONL missing {key}: {first_line}");
    }
    let raw_events = std::fs::read_to_string(writer.event_path()).expect("events file");
    let first_event: Value = serde_json::from_str(raw_events.lines().next().expect("line")).expect("json");
    assert_eq!(first_event["kind"], "plan");
    for key in ["t", "seq", "kind", "message", "chunk", "attempt", "delayMs"] {
        assert!(first_event.get(key).is_some(), "event JSONL missing {key}: {first_event}");
    }

    // Full read: totals, ordering and no truncation marker.
    let page = history::read_page(&history_dir, "t_api", 0, 500, false, 200);
    assert_eq!(page.total_samples, 5);
    assert_eq!(page.total_events, 2);
    assert_eq!(page.samples[1].bytes, 10);
    assert_eq!(page.samples[4].bytes, 40);
    assert_eq!(page.events[1].kind, "completed");
    assert!(!page.truncated);

    // Raw offset paging is a literal window.
    let raw = history::read_page(&history_dir, "t_api", 2, 2, true, 200);
    assert_eq!(raw.samples.len(), 2);
    assert_eq!(raw.offset, 2);
    assert_eq!(raw.samples[0].bytes, 20);
    assert_eq!(raw.samples[1].bytes, 30);
    assert_eq!(raw.sample_stride, 1);

    // A longer series is evenly downsampled with the first and last sample kept.
    let writer = HistoryWriter::new(&history_dir, "t_long");
    for index in 0..100u64 {
        writer.record_sample(&sample(2000 + index, index));
    }
    writer.flush();
    let page = history::read_page(&history_dir, "t_long", 0, 10, false, 200);
    assert_eq!(page.total_samples, 100);
    assert!(page.samples.len() <= 11, "downsampled page length {}", page.samples.len());
    assert_eq!(page.samples.first().map(|record| record.bytes), Some(0));
    assert_eq!(page.samples.last().map(|record| record.bytes), Some(99));
    assert!(page.sample_stride > 1);

    // A task that never recorded yields an empty page and no files.
    let empty = history::read_page(&history_dir, "t_absent", 0, 10, false, 10);
    assert_eq!(empty.total_samples, 0);
    assert_eq!(empty.total_events, 0);
    assert!(empty.samples.is_empty() && empty.events.is_empty());
    assert!(!empty.truncated);
}

#[test]
fn history_writer_caps_samples_and_reader_reports_truncation() {
    let dir = TempDir::new("history-cap");
    let history_dir = dir.path().join("history");
    let writer = HistoryWriter::new(&history_dir, "t_cap");
    for index in 0..MAX_RECORDED_SAMPLES {
        writer.record_sample(&sample(index, index));
    }
    // Two more samples must be ignored; the first overflow appends one marker.
    writer.record_sample(&sample(MAX_RECORDED_SAMPLES, 1));
    writer.record_sample(&sample(MAX_RECORDED_SAMPLES + 1, 2));
    // Events keep recording after the sample cap.
    writer.record_event(&history::event_record(1, 1000, "completed", Some("download completed".into()), None, None, None));
    writer.flush();

    assert_eq!(writer.sample_count(), MAX_RECORDED_SAMPLES);
    assert!(writer.truncated(), "the writer must report the sample cap");
    assert_eq!(writer.event_count(), 1, "events still append after the sample cap");

    let page = history::read_page(&history_dir, "t_cap", 0, 500, false, 10);
    assert!(page.truncated, "the reader must surface the truncation marker");
    assert_eq!(page.total_samples as u64, MAX_RECORDED_SAMPLES);
    assert_eq!(page.total_events, 1);
}

#[test]
fn task_report_records_samples_and_events() {
    let dir = TempDir::new("report");
    let history_dir = dir.path().join("history");
    let raw: RequestSpec = serde_json::from_value(json!({"url": "http://127.0.0.1:1/file", "dir": dir.as_str()})).expect("request spec");
    let spec = Spec::resolve(raw, &Config::default()).expect("spec resolves");
    let report_task = Task::new("t_report".to_string(), spec, Arc::new(tokio::sync::Notify::new()));
    let writer = Arc::new(HistoryWriter::new(&history_dir, "t_report"));
    report_task.attach_history(Arc::clone(&writer));

    // The first reporter sample is always recorded; events are always recorded.
    report_task.report(1024, 1024, Some(4096), 2, 2);
    report_task.add_event("plan", Some("4096 bytes, 1 chunk, 0 resumed bytes".to_string()), None, None, None);
    report_task.flush_history();

    assert_eq!(writer.sample_count(), 1, "Task::report must append a sample");
    assert_eq!(writer.event_count(), 1, "Task::add_event must append an event");
    let page = history::read_page(&history_dir, "t_report", 0, 10, false, 10);
    assert_eq!(page.total_samples, 1);
    assert_eq!(page.samples[0].bytes, 1024);
    assert_eq!(page.events[0].kind, "plan");
}

/// The reporter stores a sample every 100 ms; a 1 MiB trickled transfer lasts
/// long enough for several samples plus the expected plan/completed events.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_rpc_records_survives_restart_and_pages() {
    let bytes = payload(1024 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_chunk_delay(Duration::from_millis(20));
    let dir = TempDir::new("history-rpc");
    let new_kernel = kernel;
    let kernel = kernel(&dir);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({"connections": 1, "chunkSizeBytes": 262144, "fileName": "history.bin"}))).await;
    let id = view.id.clone();
    let done = wait_task(&kernel, &id, 60_000).await;
    assert_eq!(done.status, Status::Completed, "{:?}", done.error);
    assert_eq!(std::fs::read(PathBuf::from(done.path.clone().expect("path"))).expect("file"), bytes);

    let history = kernel.history(&id, 0, 500, false, true, 200).expect("history");
    assert_eq!(history["taskId"], id);
    let total_samples = history["totalSamples"].as_u64().unwrap_or(0);
    assert!(total_samples >= 2, "recording too short: {history}");
    let samples = history["samples"].as_array().expect("samples array");
    assert!(samples.len() >= 2);
    for key in ["t", "bytes", "bps", "w1Bps", "w5Bps", "w30Bps", "w300Bps", "workers", "peakWorkers", "stalledMs"] {
        assert!(samples[0].get(key).is_some(), "sample missing {key}: {}", samples[0]);
    }
    let sample_bytes: Vec<u64> = samples.iter().filter_map(|sample| sample["bytes"].as_u64()).collect();
    assert!(sample_bytes.windows(2).all(|pair| pair[0] <= pair[1]), "sample bytes must be monotonic: {sample_bytes:?}");
    assert!(sample_bytes.iter().any(|value| *value >= bytes.len() as u64 / 2), "recording never tracked the transfer: {sample_bytes:?}");

    let samples_path = PathBuf::from(history["samplesPath"].as_str().expect("samplesPath"));
    let events_path = PathBuf::from(history["eventsPath"].as_str().expect("eventsPath"));
    assert!(samples_path.starts_with(dir.path()), "{samples_path:?} not under {:?}", dir.path());
    assert_eq!(samples_path.file_name().expect("name").to_string_lossy(), format!("{id}.samples.jsonl"));
    assert_eq!(events_path.file_name().expect("name").to_string_lossy(), format!("{id}.events.jsonl"));
    assert!(samples_path.exists(), "samples JSONL must exist on disk");
    assert!(events_path.exists(), "events JSONL must exist on disk");
    // 0.2.2 writes one `{"kind":"meta",...}` header line per run into the same
    // samples file; the reader must exclude it from the sample timeline.
    let sample_lines: Vec<Value> = std::fs::read_to_string(&samples_path)
        .expect("samples file")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect();
    let sample_line_count = sample_lines.iter().filter(|record| record.get("kind").and_then(Value::as_str) != Some("meta")).count() as u64;
    assert_eq!(sample_line_count, total_samples, "JSONL sample line count must match totalSamples");
    assert!(
        sample_lines.iter().any(|record| record.get("kind").and_then(Value::as_str) == Some("meta")),
        "the recording must carry a 0.2.2 meta header: {sample_lines:?}"
    );
    assert!(history["meta"].as_array().is_some_and(|meta| !meta.is_empty()), "history must project meta: {history}");

    let events = history["events"].as_array().expect("events array");
    assert!(!events.is_empty());
    for key in ["t", "seq", "kind", "message", "chunk", "attempt", "delayMs"] {
        assert!(events[0].get(key).is_some(), "event missing {key}: {}", events[0]);
    }
    let kinds: Vec<&str> = events.iter().filter_map(|event| event["kind"].as_str()).collect();
    assert!(kinds.contains(&"plan"), "event kinds: {kinds:?}");
    assert!(kinds.contains(&"completed"), "event kinds: {kinds:?}");
    assert_eq!(history["truncated"], Value::Bool(false));

    // Raw paging: literal window from `offset`, no events when disabled.
    let raw_page = kernel.history(&id, 1, 1, true, false, 200).expect("raw history page");
    assert_eq!(raw_page["offset"].as_u64(), Some(1));
    assert_eq!(raw_page["samples"].as_array().expect("samples").len(), 1);
    assert!(raw_page["events"].as_array().expect("events").is_empty());
    assert_eq!(
        raw_page["samples"][0]["t"].as_u64(),
        samples[1]["t"].as_u64(),
        "raw offset page must select a later sample"
    );
    // Downsampled review series: bounded, first+last kept, stride reported.
    if total_samples > 2 {
        let review = kernel.history(&id, 0, 2, false, false, 200).expect("review history");
        assert!(review["sampleStride"].as_u64().unwrap_or(1) > 1, "review={review}");
        let review_samples = review["samples"].as_array().expect("samples");
        assert_eq!(review_samples.first().expect("first")["t"].as_u64(), samples.first().expect("first")["t"].as_u64());
        assert_eq!(review_samples.last().expect("last")["t"].as_u64(), samples.last().expect("last")["t"].as_u64());
        assert!(review_samples.len() <= 3, "review samples {}", review_samples.len());
    }

    // Unknown task -> recoverable not_found.
    match kernel.history("t_missing", 0, 10, false, true, 10) {
        Err(error) => assert_eq!(error.code, "not_found"),
        Ok(value) => panic!("expected not_found, got {value}"),
    }

    // A new kernel generation on the same data dir reads the same recording.
    kernel.shutdown().await;
    drop(kernel);
    let second = new_kernel(&dir);
    let _ = second.initialize(Config::default(), None).await;
    let after = second.history(&id, 0, 500, false, true, 200).expect("history after restart");
    assert!(after["totalSamples"].as_u64().unwrap_or(0) >= total_samples, "after={after}");
    assert_eq!(after["samplesPath"].as_str().expect("samplesPath"), samples_path.to_string_lossy());
    assert_eq!(after["eventsPath"].as_str().expect("eventsPath"), events_path.to_string_lossy());
    assert_eq!(after["samples"].as_array().expect("samples").len(), samples.len());
}

// ---------------------------------------------------------------------------
// Tail stall timeout (§0 #6, §4)
// ---------------------------------------------------------------------------

#[test]
fn stall_timeout_shortens_near_completion() {
    assert_eq!(engine::stall_timeout_for(0, 1000), engine::STALL_TIMEOUT);
    assert_eq!(engine::stall_timeout_for(500, 1000), engine::STALL_TIMEOUT);
    // 90 % and 97 % are the documented boundaries from real tail data.
    assert_eq!(engine::stall_timeout_for(899, 1000), engine::STALL_TIMEOUT);
    assert_eq!(engine::stall_timeout_for(900, 1000), engine::TAIL_STALL_TIMEOUT);
    assert_eq!(engine::stall_timeout_for(969, 1000), engine::TAIL_STALL_TIMEOUT);
    assert_eq!(engine::stall_timeout_for(970, 1000), engine::FINAL_STALL_TIMEOUT);
    assert_eq!(engine::stall_timeout_for(1000, 1000), engine::FINAL_STALL_TIMEOUT);
    // Unknown total (single stream) keeps the conservative deadline.
    assert_eq!(engine::stall_timeout_for(0, 0), engine::STALL_TIMEOUT);
    assert_eq!(engine::STALL_TIMEOUT, Duration::from_secs(30));
    assert_eq!(engine::TAIL_STALL_TIMEOUT, Duration::from_secs(10));
    assert_eq!(engine::FINAL_STALL_TIMEOUT, Duration::from_secs(5));
}

// ---------------------------------------------------------------------------
// Control verbs are safe to repeat (agents retry tool calls; the engine may
// need a moment to observe a pause)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pause_and_resume_controls_are_idempotent() {
    let dir = TempDir::new("controls");
    let fixture = Fixture::start(payload(16 * 1024 * 1024));
    fixture.set_chunk_delay(Duration::from_millis(20));
    let kernel = kernel(&dir);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({"connections": 2, "chunkSizeBytes": 262144}))).await;

    // resume on a still-active task is a no-op success, not a conflict.
    let resumed = control(&kernel, &view.id, "resume").await;
    assert!(resumed.status.is_active(), "resume on running task: {:?}", resumed.status);

    // pause -> paused, then a second pause is a no-op success.
    let paused = control(&kernel, &view.id, "pause").await;
    assert_eq!(paused.status, Status::Paused);
    let paused_again = control(&kernel, &view.id, "pause").await;
    assert_eq!(paused_again.status, Status::Paused);

    // resume restarts the engine; the task still completes afterwards.
    let resumed = control(&kernel, &view.id, "resume").await;
    assert!(matches!(resumed.status, Status::Queued | Status::Probing | Status::Running | Status::Paused), "{:?}", resumed.status);
    let settled = wait_task(&kernel, &view.id, 120_000).await;
    assert_eq!(settled.status, Status::Completed, "{settled:?}");
    kernel.shutdown().await;
}
