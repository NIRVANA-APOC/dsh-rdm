//! 0.2.2 integration tests: live ModelScope pass (`.design/0.2.2-spec.md` §4).
//!
//! Coverage:
//! * history meta records: one plan-phase header per run, reader excludes them
//!   from totals, meta survives a kernel restart, and a simulated second build
//!   appends a second header to the same task file (build attribution);
//! * rate accounting: a resumed run's first sample/peak/avg are this-run rates
//!   (no 8 GiB/s absolute-progress spike) and `transferredBytes` grows from 0;
//! * controller: aggregate-based growth verdict (flat aggregate with diluted
//!   per-connection rate does not revert), aggregate drop reverts with a 30-tick
//!   cooldown, saturation freeze at a flat ceiling, tail freeze (`cap<=target`);
//! * tail claims: fast bounded retry schedule and the 3 s tail stall deadline;
//! * resume stats: `chunksDone` counts chunks covered by the merged ranges (one
//!   merged range can cover hundreds of chunks), plan receipt fields
//!   `requested=/initial=/ceiling=`;
//! * unknown RPC method -> stable `unsupported_method` error.
//!
//! All tests are offline (in-process HTTP fixture on 127.0.0.1).

mod common;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{payload, Fixture};
use rdm_kernel::controller::{
    Controller, ControllerEffect, ControllerTick, GROWTH_KEEP_RATE_RATIO, REVERT_COOLDOWN_TICKS, SATURATION_FREEZE_TICKS, SATURATION_HITS, SATURATION_MIN_GAIN, SATURATION_UNFREEZE_RATIO, WARMUP_TICKS,
};
use rdm_kernel::engine::{self, tail_retry_delay, TAIL_CLAIM_STALL_TIMEOUT, TAIL_RETRY_BASE, TAIL_RETRY_MAX};
use rdm_kernel::history::{self, HistoryWriter, MetaRecord, SampleRecord, MAX_META_RECORDS};
use rdm_kernel::kernel::Kernel;
use rdm_kernel::plan::{covered_chunks, ChunkPlan};
use rdm_kernel::protocol::{now_ms, Meta, RequestSpec, Status, TaskView, VERSION};
use rdm_kernel::rpc;
use rdm_kernel::state::{self, ResumeState};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Workspace-owned temp dir (the sandbox denies writes under os.tmpdir()).
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("tmp").join(format!("rdm-v022-{tag}-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
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

fn new_kernel(dir: &TempDir) -> Arc<Kernel> {
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

fn events_of(kernel: &Kernel, id: &str) -> Vec<Value> {
    kernel.get(id, 200).expect("get events")["events"].as_array().cloned().unwrap_or_default()
}

fn event_messages(kernel: &Kernel, id: &str, kind: &str) -> Vec<String> {
    events_of(kernel, id)
        .iter()
        .filter(|event| event["kind"].as_str() == Some(kind))
        .filter_map(|event| event["message"].as_str().map(str::to_string))
        .collect()
}

/// Parse the 0.2.2 plan receipt `key=value` pairs.
fn field_value(message: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    message
        .split([' ', ';', ',', '(', ')'])
        .find_map(|token| token.strip_prefix(&prefix).map(str::to_string))
}

fn parse_u64(value: &str) -> u64 {
    value.chars().take_while(char::is_ascii_digit).collect::<String>().parse().unwrap_or(0)
}

// ---------------------------------------------------------------------------
// History meta record (§0 #1, §1.2, §4)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_plan_writes_one_meta_record_and_reader_skips_it() {
    let bytes = payload(1024 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_chunk_delay(Duration::from_millis(15));
    let dir = TempDir::new("meta-plan");
    let kernel = new_kernel(&dir);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({"connections": 1, "chunkSizeBytes": 262144}))).await;
    let done = wait_task(&kernel, &view.id, 60_000).await;
    assert_eq!(done.status, Status::Completed, "{:?}", done.error);

    let history = kernel.history(&view.id, 0, 500, false, true, 200).expect("history");
    let meta = history["meta"].as_array().expect("meta array");
    assert_eq!(meta.len(), 1, "one plan phase = one meta record: {history}");
    let record = &meta[0];
    assert_eq!(record["kind"], "meta");
    assert_eq!(record["kernelVersion"], VERSION);
    assert_eq!(record["pid"], u64::from(std::process::id()));
    assert_eq!(record["taskId"], view.id.as_str());
    assert_eq!(record["phase"], "plan");
    assert_eq!(record["run"], 1);
    // The recorded file name is the probe-resolved origin name (this download
    // takes it from the URL path, so it matches the target).
    assert_eq!(record["fileName"], "file");
    assert_eq!(record["url"], fixture.url("/file"), "the recorded url keeps its stable identity");
    assert_eq!(record["totalBytes"], bytes.len() as u64);
    assert_eq!(record["chunks"], 4, "1 MiB / 256 KiB chunks: {record}");
    assert_eq!(record["chunkSize"], 262144);
    assert_eq!(record["requestedConnections"], 1);
    assert_eq!(record["initialWorkers"], 1);
    // Effective ceiling: min(maxConnections, chunk count), same as the plan receipt.
    assert_eq!(record["maxConnections"], 4);
    assert_eq!(record["resumedBytes"], 0);
    assert_eq!(record["resumeDecision"], "not-attempted");
    assert!(record["resumeReason"].is_null(), "{record}");

    let total_samples = history["totalSamples"].as_u64().expect("totalSamples");
    let samples = history["samples"].as_array().expect("samples");
    assert!(total_samples >= 2, "recording too short: {history}");
    assert_eq!(samples.len() as u64, total_samples, "meta records must not count as samples");
    assert!(samples.iter().all(|sample| sample.get("kind").is_none()), "sample records must not carry a kind");

    let builds = history["builds"].as_array().expect("builds");
    assert_eq!(builds.len(), 1, "{history}");
    assert_eq!(builds[0].as_str().unwrap_or_default(), format!("{VERSION}@{}", std::process::id()));

    // On disk: exactly one meta header line, and one JSONL line per sample.
    let path = PathBuf::from(history["samplesPath"].as_str().expect("samplesPath"));
    let lines: Vec<Value> = std::fs::read_to_string(&path)
        .expect("samples file")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    assert_eq!(lines.iter().filter(|line| line["kind"] == "meta").count(), 1, "meta header lines");
    assert_eq!(lines.iter().filter(|line| line["kind"] != "meta").count() as u64, total_samples);

    // The reader skips meta lines from the totals and still pages the samples.
    let page = history::read_page(&dir.path().join("history"), &view.id, 0, 500, false, 200);
    assert_eq!(page.meta.len(), 1);
    assert_eq!(page.meta[0].build_tag(), format!("{VERSION}@{}", std::process::id()));
    assert_eq!(page.total_samples, total_samples);
    assert_eq!(page.samples.len() as u64, total_samples);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_meta_survives_restart_and_a_simulated_second_build_appends_another() {
    let bytes = payload(512 * 1024);
    let fixture = Fixture::start(bytes.clone());
    let dir = TempDir::new("meta-restart");
    let first = new_kernel(&dir);
    let view = start_task(&first, download_params(&fixture, &dir, json!({"connections": 1, "fileName": "restart.bin"}))).await;
    let done = wait_task(&first, &view.id, 60_000).await;
    assert_eq!(done.status, Status::Completed, "{:?}", done.error);
    first.shutdown().await;
    drop(first);

    // A later kernel build appends its own plan meta to the SAME task file.
    let history_dir = dir.path().join("history");
    let writer = HistoryWriter::new(&history_dir, &view.id);
    writer.record_meta(&MetaRecord {
        kind: "meta".to_string(),
        t: now_ms(),
        kernel_version: "1.1.0".to_string(),
        pid: 42_424,
        task_id: view.id.clone(),
        run: 2,
        phase: "plan".to_string(),
        url: fixture.url("/file"),
        file_name: "restart.bin".to_string(),
        total_bytes: Some(bytes.len() as u64),
        chunk_size: Some(262144),
        chunks: Some(2),
        requested_connections: 1,
        initial_workers: 1,
        max_connections: 2,
        resumed_bytes: 4096,
        resume_decision: "accepted".to_string(),
        resume_reason: Some("etag".to_string()),
    });
    writer.record_sample(&SampleRecord {
        t: now_ms(),
        bytes: bytes.len() as u64,
        transferred: 4096,
        bps: 1024,
        w1_bps: None,
        w5_bps: None,
        w30_bps: None,
        w300_bps: None,
        workers: 1,
        peak_workers: 1,
        stalled_ms: 0,
    });
    writer.flush();

    let second = new_kernel(&dir);
    let history = second.history(&view.id, 0, 500, false, true, 200).expect("history after restart");
    let meta = history["meta"].as_array().expect("meta array");
    assert_eq!(meta.len(), 2, "both builds must stay attributed: {history}");
    assert_eq!(meta[0]["kernelVersion"], VERSION, "oldest record first");
    assert_eq!(meta[1]["kernelVersion"], "1.1.0");
    assert_eq!(meta[1]["pid"], 42_424);
    assert_eq!(meta[1]["run"], 2);
    assert_eq!(meta[1]["resumeDecision"], "accepted");
    assert_eq!(meta[1]["resumeReason"], "etag");
    let builds = history["builds"].as_array().expect("builds");
    assert_eq!(builds.len(), 2, "{history}");
    assert_eq!(builds[0].as_str().unwrap_or_default(), format!("{VERSION}@{}", std::process::id()));
    assert_eq!(builds[1], "1.1.0@42424");
    assert!(meta.len() <= MAX_META_RECORDS, "the meta projection is bounded: {}", meta.len());
    // Samples from both generations stay readable in one timeline.
    assert!(history["totalSamples"].as_u64().unwrap_or(0) >= 1);
}

// ---------------------------------------------------------------------------
// Rate accounting on resume (§0 #5, §1.3, §4)
// ---------------------------------------------------------------------------

/// The real 20261109 bug: a resumed task's ring was seeded with absolute
/// `downloaded`, so the first post-resume sample showed ~8.6 GiB/s and `avgBps`
/// reached 1.8 GiB/s. Rates must be derived from this-run transferred bytes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resumed_run_rates_are_this_run_only() {
    const SPIKE_LIMIT: u64 = 512 * 1024 * 1024;
    let bytes = payload(4 * 1024 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_chunk_delay(Duration::from_millis(10));
    let dir = TempDir::new("rate-resume");
    let kernel = new_kernel(&dir);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({"connections": 1, "chunkSizeBytes": 262144, "fileName": "rate.bin"}))).await;
    let id = view.id.clone();

    // Run 1: make progress, then pause with persisted resume state.
    wait_until(&kernel, &id, "run 1 progress", Duration::from_secs(20), |view| view.status == Status::Running && view.downloaded >= 1024 * 1024).await;
    let _ = control(&kernel, &id, "pause").await;
    let paused = wait_until(&kernel, &id, "paused", Duration::from_secs(15), |view| view.status == Status::Paused).await;
    assert!(paused.downloaded >= 1024 * 1024);
    assert_eq!(paused.transferred_bytes, paused.downloaded, "a fresh run transfers everything it downloads");
    assert!(paused.transferred_bytes > 0);

    // Run 2: transferredBytes starts cold (0) while downloaded begins at the
    // adopted byte count, and it grows from there.
    let resumed_from = paused.downloaded;
    let _ = control(&kernel, &id, "resume").await;
    let resumed_view = wait_until(&kernel, &id, "run 2 progress", Duration::from_secs(20), |view| {
        view.status == Status::Running && view.downloaded > resumed_from && view.transferred_bytes < view.downloaded
    })
    .await;
    assert!(resumed_view.transferred_bytes > 0, "transferred={} downloaded={}", resumed_view.transferred_bytes, resumed_view.downloaded);
    let done = wait_task(&kernel, &id, 60_000).await;
    assert_eq!(done.status, Status::Completed, "{:?}", done.error);
    assert_eq!(done.downloaded, bytes.len() as u64);
    assert!(done.resumed_bytes > 0, "the resumed run must adopt .part bytes");
    assert!(done.transferred_bytes > 0 && done.transferred_bytes < done.downloaded);
    assert_eq!(done.downloaded, done.transferred_bytes + done.resumed_bytes, "downloaded = resumed + this-run transferred");
    assert!(done.peak_bps < SPIKE_LIMIT, "peakBps={} looks like the absolute-progress spike", done.peak_bps);
    assert!(done.avg_bps < SPIKE_LIMIT, "avgBps={} looks like the absolute-progress spike", done.avg_bps);
    assert!(std::fs::read(PathBuf::from(done.path.clone().expect("path"))).expect("file") == bytes);

    let history = kernel.history(&id, 0, 500, false, true, 200).expect("history");
    let meta = history["meta"].as_array().expect("meta array");
    assert_eq!(meta.len(), 2, "pause/resume writes one meta record per run: {history}");
    assert_eq!(meta[0]["run"], 1);
    assert_eq!(meta[0]["resumedBytes"], 0);
    assert_eq!(meta[1]["run"], 2);
    assert!(meta[1]["resumedBytes"].as_u64().unwrap_or(0) > 0);
    assert_eq!(meta[1]["resumeDecision"], "accepted");
    // The first sample recorded for run 2 must be a plausible this-run rate.
    let boundary = meta[1]["t"].as_u64().expect("run 2 timestamp");
    let samples = history["samples"].as_array().expect("samples");
    let first_after_resume = samples.iter().find(|sample| sample["t"].as_u64().unwrap_or(0) >= boundary).expect("a sample recorded after the resume");
    let first_bps = first_after_resume["bps"].as_u64().unwrap_or(0);
    assert!(first_bps < SPIKE_LIMIT, "first resumed sample bps={first_bps} (absolute-progress spike)");
    // Every sample's `transferred` field is a this-run counter, not absolute progress.
    let max_transferred = samples.iter().filter_map(|sample| sample["transferred"].as_u64()).max().unwrap_or(0);
    assert!(max_transferred <= done.transferred_bytes.max(1) + 1024 * 1024, "sample transferred={max_transferred} transferredBytes={}", done.transferred_bytes);
}

// ---------------------------------------------------------------------------
// Controller: aggregate verdict, revert cooldown, saturation, tail (§1.4, §4)
// ---------------------------------------------------------------------------

const MIB: f64 = 1024.0 * 1024.0;

/// Non-tail tick: plenty of claim units remain, so the tail freeze does not apply.
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

fn tail_tick(delta_mib: f64, active: f64, cap: usize, remaining_units: usize) -> ControllerTick {
    ControllerTick { remaining_units, ..tick(delta_mib, active, cap) }
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

fn has_note(effects: &[ControllerEffect]) -> bool {
    effects.iter().any(|effect| matches!(effect, ControllerEffect::Note { .. }))
}

#[test]
fn controller_keeps_growth_when_aggregate_holds_despite_per_connection_dilution() {
    // 20261109: 64 -> 72 workers reverted five times at 112-114 MiB/s aggregate
    // because a single tick judged per-connection dilution (1.75 -> 1.56 MiB/s).
    // 0.2.2 keeps the probe while the aggregate holds >= 95 %.
    assert_eq!(GROWTH_KEEP_RATE_RATIO, 0.95);
    let mut controller = Controller::new(64, 128);
    let grown = controller.step(&tick(112.0, 64.0, 128));
    assert_eq!(targets(&grown), vec![72], "first healthy tick probes 64 -> 72: {grown:?}");
    let kept = controller.step(&tick(112.0, 72.0, 128));
    assert!(targets(&kept).is_empty(), "a flat aggregate must not revert the growth: {kept:?}");
    assert_eq!(controller.target(), 72);
}

#[test]
fn controller_reverts_on_aggregate_drop_and_cools_down_30_ticks() {
    assert!(REVERT_COOLDOWN_TICKS >= 30, "revert cooldown must be >= 30 ticks, got {REVERT_COOLDOWN_TICKS}");
    let mut controller = Controller::new(64, 128);
    let _ = controller.step(&tick(112.0, 64.0, 128));
    assert_eq!(controller.target(), 72);
    // Aggregate falls by more than 5 %: revert to the pre-probe target.
    let revert = controller.step(&tick(100.0, 72.0, 128));
    assert_eq!(targets(&revert), vec![64], "aggregate drop must revert: {revert:?}");
    assert_eq!(controller.target(), 64);
    // Growth stays blocked for REVERT_COOLDOWN_TICKS ticks of healthy aggregate.
    let mut first_growth = None;
    for offset in 1..=(REVERT_COOLDOWN_TICKS + 5) {
        let effects = controller.step(&tick(112.0, 64.0, 128));
        if targets(&effects).iter().any(|target| *target > 64) {
            first_growth = Some(offset);
            break;
        }
    }
    assert_eq!(first_growth, Some(REVERT_COOLDOWN_TICKS), "growth must wait exactly the revert cooldown");
}

#[test]
fn controller_saturation_freeze_stops_growth_at_a_flat_ceiling() {
    assert_eq!(SATURATION_MIN_GAIN, 0.02);
    assert_eq!(SATURATION_HITS, 2);
    assert_eq!(SATURATION_UNFREEZE_RATIO, 0.90);
    let mut controller = Controller::new(64, 128);
    let mut effects = Vec::new();
    for _ in 0..40 {
        let current = controller.target();
        effects = controller.step(&tick(112.0, current as f64, 128));
        if controller.growth_frozen() {
            break;
        }
    }
    assert!(controller.growth_frozen(), "a flat aggregate must freeze growth");
    assert!(has_note(&effects), "freezing emits a controller note: {effects:?}");
    let frozen_target = controller.target();
    assert!(frozen_target > 64);
    // While frozen no growth probe may be launched at the flat ceiling.
    for _ in 0..(SATURATION_FREEZE_TICKS.saturating_sub(20)) {
        let effects = controller.step(&tick(112.0, frozen_target as f64, 128));
        assert!(!targets(&effects).iter().any(|target| *target > frozen_target), "growth while frozen: {effects:?}");
    }
    assert_eq!(controller.target(), frozen_target);
    // A genuine aggregate step-down (15 %) unfreezes growth detection.
    let fell = controller.step(&tick(112.0 * 0.85, frozen_target as f64, 128));
    assert!(!controller.growth_frozen(), "a 15 % aggregate drop must unfreeze growth: {fell:?}");
}

#[test]
fn controller_holds_the_target_in_the_tail() {
    let mut controller = Controller::new(32, 128);
    for _ in 0..(WARMUP_TICKS + 2) {
        let _ = controller.step(&tick(40.0, 32.0, 128));
    }
    let before = controller.target();
    // Tail: every remaining claim unit already owns a worker; the falling
    // active count is completion, not a throughput problem.
    let first_tail = controller.step(&tail_tick(1.0, 2.0, 128, 2));
    assert!(targets(&first_tail).is_empty(), "tail must not change the target: {first_tail:?}");
    assert!(!has_rebuild(&first_tail), "tail must not rebuild the pool: {first_tail:?}");
    assert_eq!(controller.target(), before);
    // `cap <= target` also holds, even with collapse-like rates and cap==target.
    for _ in 0..10 {
        let effects = controller.step(&tail_tick(0.2, 1.0, before, 1));
        assert!(targets(&effects).is_empty(), "{effects:?}");
        assert!(!has_rebuild(&effects), "{effects:?}");
        assert_eq!(controller.target(), before);
    }
}

// ---------------------------------------------------------------------------
// Tail retries (§0 #3, §1.5, §4)
// ---------------------------------------------------------------------------

#[test]
fn tail_retry_schedule_is_fast_and_bounded() {
    assert_eq!(TAIL_RETRY_BASE, Duration::from_millis(250));
    assert_eq!(TAIL_RETRY_MAX, Duration::from_secs(1));
    assert_eq!(tail_retry_delay(1), Duration::from_millis(250));
    assert_eq!(tail_retry_delay(2), Duration::from_millis(500));
    assert_eq!(tail_retry_delay(3), Duration::from_millis(750));
    assert_eq!(tail_retry_delay(4), Duration::from_secs(1));
    assert_eq!(tail_retry_delay(5), TAIL_RETRY_MAX, "retry delay is capped at 1 s");
    assert_eq!(tail_retry_delay(0), TAIL_RETRY_BASE);
    // Tail claims use a 3 s stall deadline. A mid-transfer deadline is 30 s and
    // the ≥90 % tail deadline is 10 s; the tail claim path caps it at 3 s.
    assert_eq!(TAIL_CLAIM_STALL_TIMEOUT, Duration::from_secs(3));
    assert_eq!(engine::stall_timeout_for(0, 1000), Duration::from_secs(30));
    assert_eq!(engine::stall_timeout_for(900, 1000).min(TAIL_CLAIM_STALL_TIMEOUT), Duration::from_secs(3));
}

// ---------------------------------------------------------------------------
// Resume stats + plan receipt (§0 #4, §1.6, §4)
// ---------------------------------------------------------------------------

#[test]
fn covered_chunk_count_is_not_the_range_count() {
    // 20261109: "resume state saved: 17 chunks" (merged ranges) vs the next
    // plan's "422 chunks". One merged range can cover hundreds of chunks.
    let chunk = 262_144u64;
    let plan = ChunkPlan::with_chunk_size(422 * chunk + 1000, chunk);
    assert_eq!(plan.total_chunks, 423);
    let one_merged_range = vec![(0u64, 422 * chunk)];
    assert_eq!(covered_chunks(&plan, &one_merged_range), 422, "one merged range covering 422 chunks reports 422, not 1");
    // Two split ranges can report a different number than their count.
    let split = vec![(0, 2 * chunk), (4 * chunk, 6 * chunk)];
    assert_eq!(covered_chunks(&plan, &split), 4);
    assert_ne!(covered_chunks(&plan, &split), split.len() as u64);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_stats_and_plan_receipt_report_chunks_not_ranges() {
    let bytes = payload(4 * 1024 * 1024);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_chunk_delay(Duration::from_millis(5));
    let dir = TempDir::new("resume-stats");
    let kernel = new_kernel(&dir);
    let view = start_task(&kernel, download_params(&fixture, &dir, json!({"connections": 2, "chunkSizeBytes": 262144, "fileName": "chunks.bin"}))).await;
    let id = view.id.clone();

    // Fresh-run plan receipt: requested / initial / ceiling / chunks / chunk.
    wait_until(&kernel, &id, "first plan event", Duration::from_secs(20), |view| view.status == Status::Running).await;
    let first_plan = event_messages(&kernel, &id, "plan").pop().expect("fresh plan event");
    assert!(first_plan.starts_with(&format!("{} bytes;", bytes.len())), "{first_plan}");
    assert_eq!(field_value(&first_plan, "chunks").as_deref(), Some("16"));
    assert_eq!(field_value(&first_plan, "chunk").as_deref(), Some("262144"));
    assert_eq!(field_value(&first_plan, "requested").as_deref(), Some("2"), "{first_plan}");
    assert_eq!(field_value(&first_plan, "initial").as_deref(), Some("2"), "{first_plan}");
    assert_eq!(field_value(&first_plan, "ceiling").as_deref(), Some("16"), "{first_plan}");
    assert_eq!(field_value(&first_plan, "resumed").as_deref(), Some("0"));
    assert_eq!(field_value(&first_plan, "resume").as_deref(), Some("not-attempted"));

    // Pause with persisted ranges.
    wait_until(&kernel, &id, "progress before pause", Duration::from_secs(20), |view| view.status == Status::Running && view.downloaded >= 2 * 1024 * 1024).await;
    let _ = control(&kernel, &id, "pause").await;
    let paused = wait_until(&kernel, &id, "paused", Duration::from_secs(15), |view| view.status == Status::Paused).await;
    assert!(paused.downloaded >= 2 * 1024 * 1024);
    let value = kernel.get(&id, 200).expect("get paused");
    let resume_state = &value["detail"]["resumeState"];
    let chunk_size = paused.chunk_size.expect("chunk size after plan");
    let plan = ChunkPlan::with_chunk_size(bytes.len() as u64, chunk_size);

    // Read the persisted ranges and recompute the covered-chunk count.
    let path = PathBuf::from(paused.path.clone().expect("path"));
    let state_path = state::state_path(&path);
    let state: Value = serde_json::from_slice(&std::fs::read(&state_path).expect("part state")).expect("state json");
    let ranges: Vec<(u64, u64)> = state["completedRanges"]
        .as_array()
        .expect("completedRanges")
        .iter()
        .map(|range| (range[0].as_u64().expect("start"), range[1].as_u64().expect("end")))
        .collect();
    assert!(!ranges.is_empty(), "expected merged completed ranges, got {ranges:?}");
    let expected_chunks = covered_chunks(&plan, &ranges);
    assert!(expected_chunks >= ranges.len() as u64, "covered chunks {expected_chunks} vs ranges {}", ranges.len());
    assert_eq!(resume_state["chunksDone"].as_u64(), Some(expected_chunks), "chunksDone must be the covered-chunk count, not the range count: {resume_state}");
    assert_eq!(resume_state["bytesDone"].as_u64(), state["downloadedBytes"].as_u64());

    // The durable save event prints ranges / chunks / bytes separately.
    let save_message = event_messages(&kernel, &id, "info")
        .into_iter()
        .filter(|message| message.starts_with("resume state saved:"))
        .next_back()
        .expect("resume state saved event");
    let numbers: Vec<u64> = save_message.split_whitespace().filter_map(|token| token.parse().ok()).collect();
    assert_eq!(numbers.len(), 3, "expected ranges / chunks / bytes: {save_message}");
    assert_eq!(numbers[0], ranges.len() as u64, "{save_message}");
    assert_eq!(numbers[1], expected_chunks, "{save_message}");
    assert_eq!(Some(numbers[2]), state["downloadedBytes"].as_u64(), "{save_message}");

    // Resume: the second plan adopts exactly the covered chunks and reports them.
    let _ = control(&kernel, &id, "resume").await;
    let done = wait_task(&kernel, &id, 60_000).await;
    assert_eq!(done.status, Status::Completed, "{:?}", done.error);
    assert_eq!(done.downloaded, bytes.len() as u64);
    assert_eq!(done.resumed_chunks, expected_chunks, "resumed_chunks must be the covered-chunk count");
    let second_plan = event_messages(&kernel, &id, "plan").pop().expect("resumed plan event");
    assert_eq!(field_value(&second_plan, "requested").as_deref(), Some("2"), "{second_plan}");
    assert!(parse_u64(&field_value(&second_plan, "resumed").expect("resumed field")) > 0, "{second_plan}");
    assert!(field_value(&second_plan, "resume").expect("resume field").starts_with("accepted"), "{second_plan}");
    assert!(parse_u64(&field_value(&second_plan, "ceiling").expect("ceiling field")) >= 2, "{second_plan}");
}

// ---------------------------------------------------------------------------
// Learned worker target restored on resume (live Q6: initial=41, requested=16)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_state_persists_the_controller_target() {
    let dir = TempDir::new("state-target");
    let meta = Meta {
        final_url: "http://127.0.0.1:1/file".to_string(),
        file_name: "file".to_string(),
        total_bytes: Some(16 * 1024 * 1024),
        supports_ranges: true,
        content_type: None,
        etag: Some("\"v1\"".to_string()),
        last_modified: None,
        http_version: None,
    };
    let state = ResumeState::new("http://127.0.0.1:1/file", &meta, 16 * 1024 * 1024, 262144, vec![(0, 8 * 262144)], 8 * 262144).with_target_workers(41);
    assert_eq!(state.target_workers, Some(41));
    assert_eq!(state.clone().with_target_workers(0).target_workers, Some(1), "the target is clamped to at least one worker");

    // JSON projection uses the documented camelCase key.
    let json = serde_json::to_value(&state).expect("serialize state");
    assert_eq!(json["targetWorkers"], 41);

    // A 0.2.1-format state without the field still loads (additive only).
    let mut old = json.clone();
    old.as_object_mut().expect("object").remove("targetWorkers");
    let legacy: ResumeState = serde_json::from_value(old).expect("0.2.1 state loads");
    assert_eq!(legacy.target_workers, None);

    // Atomic save/load round-trip through the real `.part.json` path.
    let path = state::state_path(&dir.path().join("file"));
    state::save_atomic(&path, &state, false).await.expect("save state");
    let loaded = state::load(&path).await.expect("load state");
    assert_eq!(loaded.target_workers, Some(41));
    let text = std::fs::read_to_string(&path).expect("state file");
    assert!(text.contains("\"targetWorkers\":41"), "{text}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_restores_the_learned_worker_target() {
    let total = 16 * 1024 * 1024usize;
    let bytes = payload(total);
    let fixture = Fixture::start(bytes.clone());
    fixture.set_chunk_delay(Duration::from_millis(2));
    let dir = TempDir::new("target-restore");
    let url = fixture.url("/file");
    let target = dir.path().join("file");
    let part = state::part_path(&target);
    let state_path = state::state_path(&target);
    let meta = Meta {
        final_url: url.clone(),
        file_name: "file".to_string(),
        total_bytes: Some(total as u64),
        supports_ranges: true,
        content_type: None,
        etag: Some("\"v1\"".to_string()),
        last_modified: Some("Wed, 21 Oct 2026 07:28:00 GMT".to_string()),
        http_version: None,
    };
    // Seed a paused 0.2.1-style transfer: 8 chunks adopted, controller learned 41.
    let seeded = ResumeState::new(&url, &meta, total as u64, 262144, vec![(0, 8 * 262144)], 8 * 262144).with_target_workers(41);
    state::save_atomic(&state_path, &seeded, false).await.expect("seed resume state");
    std::fs::write(&part, &bytes[..8 * 262144]).expect("seed part");

    let kernel = new_kernel(&dir);
    let view = start_task(
        &kernel,
        json!({
            "url": url.clone(),
            "dir": dir.as_str(),
            "connections": 16,
            "maxConnections": 128,
            "chunkSizeBytes": 262144,
        }),
    )
    .await;
    let running = wait_until(&kernel, &view.id, "resumed plan applied", Duration::from_secs(20), |view| view.status == Status::Running).await;
    // connections = clamp(max(requested 16, learned 41), 16, min(128, 64 chunks)) = 41.
    assert_eq!(running.requested_connections, 16, "{running:?}");
    assert_eq!(running.connections, 41, "the learned target must be restored, not the requested 16: {running:?}");
    assert_eq!(running.target_workers, 41);
    assert_eq!(running.resumed_chunks, 8);

    let done = wait_task(&kernel, &view.id, 120_000).await;
    assert_eq!(done.status, Status::Completed, "{:?}", done.error);
    assert_eq!(done.downloaded, total as u64);
    assert_eq!(done.connections, 41, "the restored population stays the planned population");
    assert_eq!(std::fs::read(&target).expect("target file"), bytes);

    let plan = event_messages(&kernel, &view.id, "plan").pop().expect("plan event");
    assert_eq!(field_value(&plan, "requested").as_deref(), Some("16"), "{plan}");
    assert_eq!(field_value(&plan, "initial").as_deref(), Some("41"), "{plan}");
    assert_eq!(field_value(&plan, "ceiling").as_deref(), Some("64"), "{plan}");

    // The history meta header explains the restored plan for this run.
    let history = kernel.history(&view.id, 0, 500, false, true, 200).expect("history");
    let meta = history["meta"].as_array().expect("meta array");
    assert!(!meta.is_empty(), "{history}");
    assert_eq!(meta[0]["requestedConnections"], 16);
    assert_eq!(meta[0]["initialWorkers"], 41);
    assert!(meta[0]["resumedBytes"].as_u64().unwrap_or(0) > 0);
}

// ---------------------------------------------------------------------------
// Unknown RPC method (§0 #6, §1.7, §4)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_rpc_method_returns_unsupported_method() {
    let dir = TempDir::new("unknown-method");
    let kernel = new_kernel(&dir);
    match rpc::dispatch(&kernel, "nope", json!({})).await {
        Err(error) => {
            assert_eq!(error.code, "unsupported_method", "{error:?}");
            assert!(error.message.contains("nope"), "message must name the method: {}", error.message);
            assert!(error.message.contains(VERSION), "message must name the kernel version: {}", error.message);
            assert!(error.message.contains("0.3.0-alpha.1"), "message must carry the upgrade hint: {}", error.message);
        }
        Ok(value) => panic!("unknown method must fail, got {value}"),
    }
    // A real method still dispatches normally.
    let stats = rpc::dispatch(&kernel, "stats", json!({})).await.expect("stats dispatch");
    assert_eq!(stats["protocol"], 2);
}
