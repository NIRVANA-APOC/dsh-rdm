use crate::controller::{Controller, ControllerEffect, ControllerTick};
use crate::engine::{control_error, finalize, prepare_part, stall_timeout_for, Counters, EngineError, Reporter, Slot, SAVE_INTERVAL};
use crate::error::EngineResult;
use crate::http;
use crate::klog;
use crate::plan::{self, ChunkPlan};
use crate::protocol::{Meta, Spec, Status};
use crate::rate::TokenBucket;
use crate::scheduler::{Claim, Scheduler, COALESCE_MAX_BYTES, COALESCE_MIN_BYTES};
use crate::source::SourcePool;
use crate::state::{self, ResumeOutcome, ResumeState};
use crate::task::{Control, StopKind, Task};
use reqwest::header::{CONTENT_RANGE, IF_RANGE, RANGE};
use reqwest::StatusCode;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::{interval, timeout, MissedTickBehavior};
const WORK_POLL: Duration = Duration::from_millis(100);
const STEAL_WAIT: Duration = Duration::from_millis(250);
const GATE_POLL: Duration = Duration::from_millis(10);
const CONTROL_WINDOW: Duration = Duration::from_secs(1);
struct Shared {
    total: u64,
    /// Spec snapshot; a collapse recovery needs it to rebuild a source client.
    spec: Spec,
    /// Multi-source pool (0.3.0). One active source for select/failover/hedge;
    /// per-claim choice for race.
    pool: Arc<SourcePool>,
    part: PathBuf,
    state_path: PathBuf,
    spec_url: String,
    meta: Meta,
    chunk_size: u64,
    scheduler: Arc<Scheduler>,
    counters: Arc<Counters>,
    control: Arc<Control>,
    task: Arc<Task>,
    limiter: Option<Arc<TokenBucket>>,
    /// Controller's current worker target (dynamic; initial = `spec.connections`).
    target_workers: AtomicUsize,
    /// Upper bound for spawned worker tasks (`spec.max_connections`, capped by
    /// the number of chunks a transfer actually has).
    max_worker_tasks: usize,
    spawned_workers: AtomicUsize,
    /// Handles of live worker tasks; the controller may append, the engine
    /// drains and joins them at the end.
    worker_handles: Mutex<Vec<JoinHandle<()>>>,
    pushback: Mutex<Option<Instant>>,
    pushback_seen: AtomicBool,
    failure: Mutex<Option<EngineError>>,
    downgrade: AtomicBool,
    dirty: AtomicBool,
    last_save: Mutex<Instant>,
    save_lock: tokio::sync::Mutex<()>,
    wake: Notify,
    max_attempts: u32,
    started: Instant,
}
impl Shared {
    fn stopped(&self) -> bool {
        self.control.is_stopped() || self.failure.lock().map(|slot| slot.is_some()).unwrap_or(false)
    }
    fn has_failure(&self) -> bool {
        self.failure.lock().map(|slot| slot.is_some()).unwrap_or(false)
    }
    fn fail(&self, error: EngineError) {
        let mut slot = self.failure.lock().expect("failure mutex poisoned");
        if slot.is_none() {
            *slot = Some(error);
        }
        drop(slot);
        self.wake.notify_waiters();
    }
    fn take_failure(&self) -> Option<EngineError> {
        self.failure.lock().expect("failure mutex poisoned").take()
    }
    fn refresh_sources(&self) {
        self.task.set_sources(self.pool.snapshot(), Some(self.pool.active_index()), self.pool.policy().as_str(), self.pool.switches());
    }
    fn note_pushback(&self, delay: Duration) {
        let deadline = Instant::now() + delay;
        let mut slot = self.pushback.lock().expect("pushback mutex poisoned");
        *slot = Some(match *slot {
            Some(current) => current.max(deadline),
            None => deadline,
        });
        self.pushback_seen.store(true, Ordering::SeqCst);
        self.wake.notify_waiters();
    }
    async fn wait_pushback(&self) -> bool {
        loop {
            let remaining = {
                let slot = self.pushback.lock().expect("pushback mutex poisoned");
                slot.and_then(|until| until.checked_duration_since(Instant::now()))
            };
            match remaining {
                None => return true,
                Some(delay) => {
                    if !self.control.sleep(delay.min(Duration::from_millis(200))).await {
                        return false;
                    }
                }
            }
        }
    }
    async fn acquire_slot(self: &Arc<Self>) -> Option<Slot> {
        loop {
            if self.stopped() {
                return None;
            }
            let target = self.target_workers.load(Ordering::SeqCst).max(1);
            if self.counters.try_enter(target) {
                return Some(Slot { counters: Arc::clone(&self.counters), started: Instant::now() });
            }
            tokio::select! {
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep(GATE_POLL) => {}
                _ = self.control.wait_stopped() => return None,
            }
        }
    }
    async fn save_state(&self, durable: bool) {
        let _guard = self.save_lock.lock().await;
        let ranges = self.scheduler.completed_ranges();
        let downloaded = self.counters.downloaded();
        // Range count and covered-chunk count are different numbers: 17 merged
        // ranges can cover 422 chunks (20261109 report confused the two).
        let covered_chunks = plan::covered_chunks(&plan::ChunkPlan::with_chunk_size(self.total, self.chunk_size), &ranges);
        let state = ResumeState::new(&self.spec_url, &self.meta, self.total, self.chunk_size, ranges.clone(), downloaded)
            .with_target_workers(self.target_workers.load(Ordering::SeqCst))
            .with_content_key(self.pool.resume_content_key().map(str::to_string));
        if let Err(error) = state::save_atomic(&self.state_path, &state, durable).await {
            klog!(warn, "could not save resume state: {error}");
        }
        self.task.set_resume_stats(covered_chunks, downloaded);
        *self.last_save.lock().expect("save mutex poisoned") = Instant::now();
        self.dirty.store(false, Ordering::SeqCst);
        if durable && !ranges.is_empty() {
            self.task.add_event("info", Some(format!("resume state saved: {} ranges / {covered_chunks} chunks / {downloaded} bytes", ranges.len())), None, None, None);
        }
    }
    async fn save_if_due(&self) {
        if !self.dirty.swap(false, Ordering::SeqCst) {
            return;
        }
        let due = self.last_save.lock().expect("save mutex poisoned").elapsed() >= SAVE_INTERVAL;
        if due {
            // Periodic resume state is written without fsync: the bytes are in
            // the page cache, a process crash keeps them, and an OS crash loses
            // data and state together. Pause/stop/final paths fsync.
            self.save_state(false).await;
        } else {
            self.dirty.store(true, Ordering::SeqCst);
        }
    }
    /// Spawn `count` additional worker tasks (adaptive growth).
    fn spawn_workers(self: &Arc<Self>, count: usize) {
        if count == 0 {
            return;
        }
        let limit = self.max_worker_tasks.saturating_sub(self.spawned_workers.load(Ordering::SeqCst));
        let count = count.min(limit);
        if count == 0 {
            return;
        }
        self.spawned_workers.fetch_add(count, Ordering::SeqCst);
        let mut handles = self.worker_handles.lock().expect("worker handles mutex poisoned");
        for _ in 0..count {
            let shared = Arc::clone(self);
            handles.push(tokio::spawn(async move { worker(shared).await }));
        }
        drop(handles);
        self.wake.notify_waiters();
    }
    fn drain_handles(&self) -> Vec<JoinHandle<()>> {
        std::mem::take(&mut *self.worker_handles.lock().expect("worker handles mutex poisoned"))
    }
}
enum ClaimOutcome {
    Done,
    Stopped,
    Downgrade,
    Failed,
}
enum BodyResult {
    Complete,
    Split(u64),
    Stopped(u64),
    Retry(u64, String),
    Fatal(EngineError),
}
#[allow(clippy::too_many_arguments)]
pub async fn run(task: &Arc<Task>, spec: &Spec, pool: &Arc<SourcePool>, total: u64, target: &Path, part: &Path, state_path: &Path) -> EngineResult<Option<String>> {
    let control = task.control();
    let meta = pool.selected_meta().ok_or_else(|| EngineError::network("no active source for chunked transfer".to_string()))?;
    let plan = ChunkPlan::new(total, spec.connections, spec.chunk_size_bytes);
    let mut done: Vec<(u64, u64)> = Vec::new();
    let mut resumed_chunks = 0u64;
    // Concurrency learned by a previous run of this task (persisted in the task
    // record) and by the resume state; both are restored so a fast transfer
    // does not fall back to the requested count after a restart.
    let previous_target = task.view().target_workers;
    let mut resumed_target: Option<usize> = None;
    // ── Resume decision (0.2.1) ─────────────────────────────────────────────
    // The recorded state is matched by stable identity, never by the volatile
    // final URL (CDN tokens like `auth_key` change on every probe). Every
    // rejected path reports a stable code so the real reason is visible.
    #[derive(Clone, Copy)]
    struct ResumeSummary {
        decision: &'static str,
        reason: Option<&'static str>,
    }
    let resume: ResumeSummary;
    if spec.resume {
        match state::load_outcome(state_path).await {
            state::LoadOutcome::State(saved) => {
                let saved = *saved;
                let outcome = saved.is_compatible_with_content(&spec.url, &meta, total, pool.content_key());
                let part_len = tokio::fs::metadata(part).await.ok().map(|metadata| metadata.len());
                let accepted = match &outcome {
                    ResumeOutcome::Accepted(reason) => {
                        let ranges = saved.completed_ranges().unwrap_or_default();
                        let max_end = ranges.last().map(|(_, end)| *end).unwrap_or(0);
                        match part_len {
                            None => {
                                task.set_resume_decision("rejected", Some("part-missing"));
                                resume = ResumeSummary { decision: "rejected", reason: Some("part-missing") };
                                task.add_event("info", Some("resume rejected (part-missing): .part file is gone; restarting from zero".to_string()), None, None, None);
                                false
                            }
                            Some(len) if len < max_end => {
                                task.set_resume_decision("rejected", Some("part-truncated"));
                                resume = ResumeSummary { decision: "rejected", reason: Some("part-truncated") };
                                task.add_event("info", Some(format!("resume rejected (part-truncated): .part has {len} bytes but state covers {max_end}; restarting from zero")), None, None, None);
                                false
                            }
                            Some(_) => {
                                resumed_chunks = plan::covered_chunks(&plan, &ranges);
                                let resumed_bytes: u64 = ranges.iter().map(|(start, end)| end - start).sum();
                                resumed_target = saved.target_workers;
                                done = ranges;
                                task.set_validators_matched(true);
                                task.set_resume_decision("accepted", Some(reason));
                                resume = ResumeSummary { decision: "accepted", reason: Some(reason) };
                                task.add_event("info", Some(format!("resumed {resumed_chunks} chunks / {resumed_bytes} bytes from .part ({reason})")), None, None, None);
                                true
                            }
                        }
                    }
                    ResumeOutcome::Rejected(reason) => {
                        task.set_validators_matched(false);
                        task.set_resume_decision("rejected", Some(reason));
                        resume = ResumeSummary { decision: "rejected", reason: Some(reason) };
                        task.add_event("info", Some(format!("resume rejected ({reason}); restarting from zero")), None, None, None);
                        klog!(info, "resume rejected ({reason}); restarting from zero");
                        false
                    }
                };
                if !accepted {
                    done.clear();
                }
            }
            state::LoadOutcome::Missing => {
                // A fresh transfer has nothing to resume; that is not a
                // rejection, so the decision stays "not-attempted".
                task.set_resume_decision("not-attempted", None);
                resume = ResumeSummary { decision: "not-attempted", reason: None };
            }
            state::LoadOutcome::Corrupt(reason) => {
                task.set_validators_matched(false);
                task.set_resume_decision("rejected", Some(reason));
                resume = ResumeSummary { decision: "rejected", reason: Some(reason) };
                task.add_event("info", Some(format!("resume state is unusable ({reason}); restarting from zero")), None, None, None);
                done.clear();
            }
        }
    } else {
        task.set_resume_decision("rejected", Some("disabled"));
        resume = ResumeSummary { decision: "rejected", reason: Some("disabled") };
    }
    if done.is_empty() {
        let _ = tokio::fs::remove_file(state_path).await;
    }
    prepare_part(part, total).await?;
    let resumed_bytes: u64 = done.iter().map(|(start, end)| end - start).sum();
    // ── v2 hedge: race the first range across the two best sources ─────────
    // Only on a fresh transfer. The winner's bytes are complete and validated
    // before they are written; the loser is cancelled. This avoids trusting a
    // single-source probe, and it never mixes bytes because the engine then
    // commits to the winner (failover remains gated on a strong content key).
    let mut hedge_bytes = 0u64;
    if spec.source_policy == crate::protocol::SourcePolicy::Hedge && done.is_empty() && pool.len() >= 2 {
        if let Some((start, end)) = state::missing_ranges(&done, total).first().copied() {
            let len = spec.source_race_bytes.min(end - start).min(8 * 1024 * 1024);
            if len >= 64 * 1024 {
                if let Some((winner, bytes)) = pool.hedge_first_range(start, len).await {
                    if let Ok(mut file) = tokio::fs::OpenOptions::new().write(true).open(part).await {
                        let write = async {
                            file.seek(SeekFrom::Start(start)).await?;
                            file.write_all(&bytes).await?;
                            file.flush().await
                        }
                        .await;
                        if write.is_ok() {
                            hedge_bytes = bytes.len() as u64;
                            done.push((start, start + hedge_bytes));
                            done = state::merge_ranges(done);
                            task.set_sources(pool.snapshot(), Some(winner), pool.policy().as_str(), pool.switches());
                            task.add_event("source", Some(format!("hedged {hedge_bytes} bytes from source {winner}")), None, None, None);
                        }
                    }
                    if hedge_bytes == 0 {
                        task.add_event("source", Some("hedge winner could not be written; continuing with the active source".to_string()), None, None, None);
                    }
                }
            }
        }
    }
    let missing = state::missing_ranges(&done, total);
    let scheduler = Arc::new(Scheduler::new(total, done, missing, plan.chunk_size));
    let counters = Arc::new(Counters::default());
    counters.downloaded.store(resumed_bytes + hedge_bytes, Ordering::Relaxed);
    let chunk_units = plan.total_chunks.max(1) as usize;
    let base_workers = spec.connections.min(chunk_units).max(1);
    let max_worker_tasks = spec.max_connections.clamp(base_workers, crate::protocol::MAX_CONNECTIONS).min(chunk_units);
    // Restore the best known target on resume: previous run's target from the
    // task record wins over the saved state, both clamped to the legal range.
    let restore_target = previous_target.max(resumed_target.unwrap_or(0));
    let workers = if restore_target > base_workers { restore_target.clamp(base_workers, max_worker_tasks) } else { base_workers };
    task.set_plan(workers, Some(plan.chunk_size), resumed_chunks, resumed_bytes);
    task.set_controller_target(workers);
    let resume_suffix = match resume.reason {
        Some(reason) => format!("{}:{reason}", resume.decision),
        None => resume.decision.to_string(),
    };
    task.add_event("plan", Some(format!("{total} bytes; chunks={} chunk={}; requested={} initial={} ceiling={}; resumed={resumed_bytes} bytes resume={resume_suffix}", plan.total_chunks, plan.chunk_size, spec.connections, workers, max_worker_tasks)), None, None, None);
    // Build/plan attribution record for the persistent recording: one per run,
    // so a task spanning several kernel builds keeps an explainable timeline.
    task.record_history_meta(crate::history::MetaRecord {
        kind: "meta".to_string(),
        t: crate::protocol::now_ms(),
        kernel_version: crate::protocol::VERSION.to_string(),
        pid: std::process::id(),
        task_id: task.id.clone(),
        run: task.run_generation(),
        phase: "plan".to_string(),
        url: crate::protocol::redact_url(&spec.url),
        file_name: meta.file_name.clone(),
        total_bytes: Some(total),
        chunk_size: Some(plan.chunk_size),
        chunks: Some(plan.total_chunks),
        requested_connections: spec.connections,
        initial_workers: workers,
        max_connections: max_worker_tasks,
        resumed_bytes,
        resume_decision: resume.decision.to_string(),
        resume_reason: resume.reason.map(str::to_string),
    });
    if let Some(error) = control_error(&control) {
        return Err(error);
    }
    task.set_status(Status::Running);
    task.add_event("started", Some("transfer started".to_string()), None, None, None);
    if let Some(error) = control_error(&control) {
        return Err(error);
    }
    let limiter = (spec.speed_limit_bps > 0).then(|| Arc::new(TokenBucket::new(spec.speed_limit_bps)));
    let shared = Arc::new(Shared {
        total,
        spec: spec.clone(),
        pool: Arc::clone(pool),
        part: part.to_path_buf(),
        state_path: state_path.to_path_buf(),
        spec_url: spec.url.clone(),
        meta: meta.clone(),
        chunk_size: plan.chunk_size,
        scheduler: Arc::clone(&scheduler),
        counters: Arc::clone(&counters),
        control: Arc::clone(&control),
        task: Arc::clone(task),
        limiter,
        target_workers: AtomicUsize::new(workers),
        max_worker_tasks,
        spawned_workers: AtomicUsize::new(0),
        worker_handles: Mutex::new(Vec::with_capacity(max_worker_tasks)),
        pushback: Mutex::new(None),
        pushback_seen: AtomicBool::new(false),
        failure: Mutex::new(None),
        downgrade: AtomicBool::new(false),
        dirty: AtomicBool::new(false),
        last_save: Mutex::new(Instant::now()),
        save_lock: tokio::sync::Mutex::new(()),
        wake: Notify::new(),
        max_attempts: spec.max_attempts.max(1),
        started: Instant::now(),
    });
    let reporter = Reporter::start(Arc::clone(task), Arc::clone(&counters), Some(total), resumed_bytes);
    let saver_done = Arc::new(Notify::new());
    let saver = {
        let shared = Arc::clone(&shared);
        let done = Arc::clone(&saver_done);
        tokio::spawn(async move {
            let mut ticker = interval(Duration::from_millis(200));
            ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
            ticker.tick().await;
            loop {
                tokio::select! {
                    _ = done.notified() => break,
                    _ = ticker.tick() => shared.save_if_due().await,
                }
            }
        })
    };
    let controller_done = Arc::new(Notify::new());
    let controller = {
        let shared = Arc::clone(&shared);
        let done = Arc::clone(&controller_done);
        tokio::spawn(async move { controller_loop(shared, done).await })
    };
    shared.spawn_workers(workers);
    // Wait until every worker task has drained (the controller may add more
    // while the transfer is live; stop it before the final drain).
    loop {
        let handles = shared.drain_handles();
        for handle in handles {
            if let Err(error) = handle.await {
                shared.fail(EngineError::internal(format!("worker task terminated unexpectedly: {error}")));
            }
        }
        if shared.stopped() || shared.scheduler.is_finished() || shared.has_failure() {
            break;
        }
        // No live workers and neither terminal nor failed should not happen;
        // poll briefly so a spawning controller cannot livelock the loop.
        tokio::time::sleep(WORK_POLL).await;
    }
    controller_done.notify_waiters();
    let _ = timeout(Duration::from_secs(2), controller).await;
    saver_done.notify_waiters();
    let _ = timeout(Duration::from_secs(2), saver).await;
    for handle in shared.drain_handles() {
        let _ = handle.await;
    }
    reporter.stop().await;
    if let Some(outcome) = control.stop_kind() {
        shared.save_state(true).await;
        shared.refresh_sources();
        task.report(counters.downloaded(), counters.downloaded().saturating_sub(resumed_bytes), Some(total), 0, counters.peak());
        return Err(match outcome {
            StopKind::Paused => EngineError::Paused,
            StopKind::Cancelled => EngineError::Cancelled,
        });
    }
    if shared.downgrade.load(Ordering::SeqCst) {
        task.add_event("retry", Some("server ignored Range; falling back to a single stream".to_string()), None, None, None);
        shared.refresh_sources();
        let _ = tokio::fs::remove_file(state_path).await;
        return super::single::run(task, spec, pool, Some(total), target, part, state_path).await;
    }
    if let Some(error) = shared.take_failure() {
        shared.save_state(true).await;
        shared.refresh_sources();
        task.report(counters.downloaded(), counters.downloaded().saturating_sub(resumed_bytes), Some(total), 0, counters.peak());
        return Err(error);
    }
    if !scheduler.is_finished() {
        shared.save_state(true).await;
        shared.refresh_sources();
        task.report(counters.downloaded(), counters.downloaded().saturating_sub(resumed_bytes), Some(total), 0, counters.peak());
        return Err(EngineError::internal("transfer ended before every byte range completed"));
    }
    counters.downloaded.store(total, Ordering::Relaxed);
    shared.refresh_sources();
    task.report(total, total.saturating_sub(resumed_bytes), Some(total), 0, counters.peak());
    task.add_event("info", Some(format!("finished in {} ms", shared.started.elapsed().as_millis())), None, None, None);
    finalize(task, spec, part, state_path, target, Some(total)).await
}
async fn controller_loop(shared: Arc<Shared>, done: Arc<Notify>) {
    let mut state = Controller::new(shared.target_workers.load(Ordering::SeqCst), shared.max_worker_tasks);
    let mut ticker = interval(CONTROL_WINDOW);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ticker.tick().await;
    let mut last_net = shared.counters.net_rx();
    let mut last_at = Instant::now();
    loop {
        tokio::select! {
            _ = done.notified() => break,
            _ = ticker.tick() => {}
        }
        let now = Instant::now();
        let elapsed = now.saturating_duration_since(last_at);
        let elapsed_secs = elapsed.as_secs_f64().max(1e-6);
        let net = shared.counters.net_rx();
        let delta = net.saturating_sub(last_net);
        last_net = net;
        last_at = now;
        // Sampled active worker count. The cumulative slot-time metric only
        // advances when a slot is released, so a tick where every worker is
        // still inside a long range would read 0 and block adaptive growth;
        // the instantaneous counter is the right busy signal for this decision.
        let active_avg = shared.counters.active() as f64;
        let pushback = shared.pushback_seen.swap(false, Ordering::SeqCst);
        let cap = shared.max_worker_tasks.min(shared.scheduler.remaining_units()).max(1);
        let tick = ControllerTick { delta_bytes: delta, elapsed_secs, active_avg, pushback, cap, remaining_units: shared.scheduler.remaining_units() };
        klog!(debug, "controller tick: instant={:.0} B/s active_avg={active_avg:.2} cap={cap} target={} pushback={pushback}", delta as f64 / elapsed_secs, shared.target_workers.load(Ordering::SeqCst));
        for effect in state.step(&tick) {
            klog!(debug, "controller effect: {effect:?}");
            match effect {
                ControllerEffect::SetTarget { target, message } => {
                    let target = target.clamp(1, shared.max_worker_tasks);
                    shared.target_workers.store(target, Ordering::SeqCst);
                    shared.task.set_controller_target(target);
                    shared.task.add_event("controller", Some(message), None, None, None);
                    let spawned = shared.spawned_workers.load(Ordering::SeqCst);
                    if target > spawned {
                        shared.spawn_workers(target - spawned);
                    }
                }
                ControllerEffect::RebuildPool { message } => {
                    if let Some(switch) = shared.pool.switch_active() {
                        shared.task.set_sources(shared.pool.snapshot(), Some(switch.to), shared.pool.policy().as_str(), shared.pool.switches());
                        shared.task.add_event("source", Some(format!("switched source {} -> {} after throughput collapse", switch.from, switch.to)), None, None, None);
                        shared.task.add_event("controller", Some(message), None, None, None);
                    } else {
                        match shared.pool.rebuild_active(&shared.spec) {
                            Ok(()) => shared.task.add_event("controller", Some(message), None, None, None),
                            Err(error) => klog!(warn, "could not rebuild connection pool: {}", error.info().message),
                        }
                    }
                }
                ControllerEffect::Note { message } => {
                    shared.task.add_event("controller", Some(message), None, None, None);
                }
            }
        }
        shared.refresh_sources();
    }
    shared.task.set_controller_target(state.target());
}
async fn worker(shared: Arc<Shared>) {
    let mut file = match tokio::fs::OpenOptions::new().write(true).open(&shared.part).await {
        Ok(file) => file,
        Err(error) => {
            shared.fail(EngineError::io(format!("could not open .part file: {error}")));
            return;
        }
    };
    let max_span = if shared.total >= COALESCE_MIN_BYTES { COALESCE_MAX_BYTES } else { 0 };
    loop {
        if shared.stopped() {
            break;
        }
        if !shared.wait_pushback().await {
            break;
        }
        // Acquire a network slot *before* claiming so the number of reserved
        // chunks tracks the active worker target instead of the spawned pool.
        let Some(slot) = shared.acquire_slot().await else {
            break;
        };
        let keep_pending = shared.target_workers.load(Ordering::SeqCst).max(1);
        let claim = match shared.scheduler.claim_with(keep_pending, max_span) {
            Some(claim) => claim,
            None => {
                drop(slot);
                if shared.scheduler.is_finished() {
                    break;
                }
                if shared.scheduler.try_request_steal() {
                    shared.scheduler.wait_for_change(STEAL_WAIT).await;
                } else {
                    shared.scheduler.wait_for_change(WORK_POLL).await;
                }
                continue;
            }
        };
        match download_claim(&shared, &mut file, claim, Some(slot)).await {
            ClaimOutcome::Done => {}
            ClaimOutcome::Stopped => break,
            ClaimOutcome::Downgrade => {
                shared.downgrade.store(true, Ordering::SeqCst);
                shared.wake.notify_waiters();
                break;
            }
            ClaimOutcome::Failed => break,
        }
    }
    // `tokio::fs::File` buffers up to 2 MiB of writes internally and `Drop` does
    // not wait for the last blocking write; flush before the workers are joined,
    // otherwise `finalize()` can stat a still-short .part (spurious
    // `remote_changed`). This matters for the tail of every download.
    if let Err(error) = file.flush().await {
        shared.fail(EngineError::io(format!("flush .part: {error}")));
    }
}
async fn download_claim(shared: &Arc<Shared>, file: &mut tokio::fs::File, claim: Claim, mut slot: Option<Slot>) -> ClaimOutcome {
    let mut written: u64 = 0;
    let mut attempt: u32 = 0;
    loop {
        if shared.control.stop_kind().is_some() {
            shared.scheduler.complete(claim, written);
            return ClaimOutcome::Stopped;
        }
        if claim.steal_target().is_some() {
            shared.scheduler.complete(claim, written);
            return ClaimOutcome::Done;
        }
        if !shared.wait_pushback().await {
            shared.scheduler.complete(claim, written);
            return ClaimOutcome::Stopped;
        }
        let slot = match slot.take() {
            Some(slot) => slot,
            None => match shared.acquire_slot().await {
                Some(slot) => slot,
                None => {
                    shared.scheduler.complete(claim, written);
                    return ClaimOutcome::Stopped;
                }
            },
        };
        attempt += 1;
        let start = claim.start + written;
        let end_inclusive = claim.end - 1;
        let Some(source) = shared.pool.acquire(start) else {
            drop(slot);
            if shared.control.stop_kind().is_some() {
                shared.scheduler.complete(claim, written);
                return ClaimOutcome::Stopped;
            }
            shared.fail(EngineError::network(format!("no healthy source for bytes {start}-{end_inclusive}")));
            return ClaimOutcome::Failed;
        };
        shared.refresh_sources();
        let request_started = Instant::now();
        let mut request = source.client().get(source.url()).header(RANGE, format!("bytes={start}-{end_inclusive}"));
        // If-Range is only valid with a strong validator (RFC 9110 §13.1.5);
        // weak ETags and Last-Modified must not be used for conditional ranges.
        // Each source has its own validator: never reuse source A's ETag on B.
        if let Some(etag) = source.if_range() {
            request = request.header(IF_RANGE, etag);
        }
        let response = tokio::select! {
            result = request.send() => result,
            _ = shared.control.wait_stopped() => {
                drop(slot);
                shared.pool.cancel(source.id);
                shared.scheduler.complete(claim, written);
                return ClaimOutcome::Stopped;
            }
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                drop(slot);
                let reason = format!("request failed: {error}");
                shared.pool.failure(source.id, false, &reason);
                if let Some(delay) = retry_schedule(shared, &claim, attempt, written, reason, None) {
                    if !shared.control.sleep(delay).await {
                        shared.scheduler.complete(claim, written);
                        return ClaimOutcome::Stopped;
                    }
                    continue;
                }
                return ClaimOutcome::Failed;
            }
        };
        let status = response.status();
        if status == StatusCode::PARTIAL_CONTENT {
            let range = response.headers().get(CONTENT_RANGE).and_then(|value| value.to_str().ok()).and_then(http::parse_content_range);
            let valid = matches!(range, Some(range)
                if range.start == start
                    && range.end == end_inclusive
                    && range.total.map(|total| total == shared.total).unwrap_or(true));
            if !valid {
                drop(slot);
                let reason = format!("invalid Content-Range for bytes {start}-{end_inclusive}");
                shared.pool.failure(source.id, false, &reason);
                if let Some(delay) = retry_schedule(shared, &claim, attempt, written, reason, Some(status.as_u16())) {
                    if !shared.control.sleep(delay).await {
                        shared.scheduler.complete(claim, written);
                        return ClaimOutcome::Stopped;
                    }
                    continue;
                }
                return ClaimOutcome::Failed;
            }
            let is_tail = shared.scheduler.remaining_units() <= shared.target_workers.load(Ordering::SeqCst).max(1);
            let mut stall_timeout = stall_timeout_for(shared.counters.downloaded(), shared.total);
            if is_tail {
                stall_timeout = stall_timeout.min(crate::engine::TAIL_CLAIM_STALL_TIMEOUT);
            }
            let outcome = stream_body(shared, file, &claim, response, written, stall_timeout).await;
            drop(slot);
            match outcome {
                BodyResult::Complete => {
                    let length = claim.len();
                    shared.pool.success(source.id, length, request_started.elapsed());
                    shared.scheduler.complete(claim, length);
                    return ClaimOutcome::Done;
                }
                BodyResult::Split(covered) => {
                    shared.pool.success(source.id, covered, request_started.elapsed());
                    shared.scheduler.complete(claim, covered);
                    return ClaimOutcome::Done;
                }
                BodyResult::Stopped(new_written) => {
                    shared.pool.success(source.id, new_written, request_started.elapsed());
                    shared.scheduler.complete(claim, new_written);
                    return ClaimOutcome::Stopped;
                }
                BodyResult::Fatal(error) => {
                    shared.pool.failure(source.id, true, &error.info().message);
                    shared.fail(error);
                    return ClaimOutcome::Failed;
                }
                BodyResult::Retry(new_written, reason) => {
                    written = new_written;
                    shared.pool.failure(source.id, false, &reason);
                    if let Some(delay) = retry_schedule(shared, &claim, attempt, written, reason, None) {
                        if !shared.control.sleep(delay).await {
                            shared.scheduler.complete(claim, written);
                            return ClaimOutcome::Stopped;
                        }
                        continue;
                    }
                    return ClaimOutcome::Failed;
                }
            }
        }
        drop(slot);
        if status == StatusCode::OK {
            shared.pool.cancel(source.id);
            return ClaimOutcome::Downgrade;
        }
        if status == StatusCode::RANGE_NOT_SATISFIABLE {
            let reason = format!("server rejected range bytes {start}-{end_inclusive} (HTTP 416)");
            shared.pool.failure(source.id, true, &reason);
            shared.fail(EngineError::remote_changed(reason));
            return ClaimOutcome::Failed;
        }
        let retry_after = http::retry_after(response.headers());
        if matches!(status.as_u16(), 429 | 503) {
            shared.task.note_throttled();
            shared.note_pushback(retry_after.unwrap_or_else(|| http::backoff(attempt)));
        }
        let reason = format!("server returned HTTP {}", status.as_u16());
        shared.pool.failure(source.id, false, &reason);
        if let Some(delay) = retry_schedule(shared, &claim, attempt, written, reason, Some(status.as_u16())) {
            let delay = retry_after.unwrap_or(delay);
            if !shared.control.sleep(delay).await {
                shared.scheduler.complete(claim, written);
                return ClaimOutcome::Stopped;
            }
            continue;
        }
        let _ = shared.take_failure();
        shared.fail(EngineError::http_status(status.as_u16(), source.url()));
        return ClaimOutcome::Failed;
    }
}
fn retry_schedule(shared: &Arc<Shared>, claim: &Claim, attempt: u32, written: u64, reason: String, _status: Option<u16>) -> Option<Duration> {
    claim.update_progress(written);
    if attempt >= shared.max_attempts {
        shared.fail(EngineError::network(format!("range {}-{} failed after {attempt} attempts: {reason}", claim.start, claim.end)));
        return None;
    }
    shared.counters.note_retry();
    shared.task.note_retry();
    // In the tail (remaining claim units ≤ target workers) every other worker
    // is already done, so retry quickly instead of sitting out full backoff.
    let tail = shared.scheduler.remaining_units() <= shared.target_workers.load(Ordering::SeqCst).max(1);
    let delay = if tail { crate::engine::tail_retry_delay(attempt) } else { http::backoff(attempt) };
    shared.task.add_event("retry", Some(reason), Some(claim.start), Some(attempt), Some(delay.as_millis().min(u128::from(u64::MAX)) as u64));
    shared.dirty.store(true, Ordering::SeqCst);
    Some(delay)
}
async fn stream_body(shared: &Arc<Shared>, file: &mut tokio::fs::File, claim: &Claim, mut response: reqwest::Response, initial_written: u64, stall_timeout: Duration) -> BodyResult {
    macro_rules! flush1 {
        ($buffer:expr, $file:expr, $written:expr) => {{
            match flush($buffer, $file, &shared.counters, $written).await {
                Ok(written) => written,
                Err(error) => return BodyResult::Fatal(error),
            }
        }};
    }
    let mut written = initial_written;
    if let Err(error) = file.seek(SeekFrom::Start(claim.start + written)).await {
        return BodyResult::Fatal(EngineError::io(format!("seek failed: {error}")));
    }
    let buffer_limit = super::write_buffer_bytes(claim.len());
    let mut buffer: Vec<u8> = Vec::with_capacity(buffer_limit);
    loop {
        if written >= claim.len() {
            return BodyResult::Complete;
        }
        let chunk = tokio::select! {
            result = timeout(stall_timeout, response.chunk()) => match result {
                Ok(result) => result,
                Err(_) => {
                    let written = flush1!(&mut buffer, file, written);
                    return BodyResult::Retry(written, format!("no body data for {} s (stalled connection)", stall_timeout.as_secs()));
                }
            },
            _ = shared.control.wait_stopped() => {
                return BodyResult::Stopped(flush1!(&mut buffer, file, written));
            }
        };
        let bytes = match chunk {
            Ok(Some(bytes)) => bytes,
            Ok(None) => break,
            Err(error) => {
                let written = flush1!(&mut buffer, file, written);
                return BodyResult::Retry(written, format!("body read failed: {error}"));
            }
        };
        let len = bytes.len() as u64;
        shared.counters.add_net_rx(len);
        if let Some(limiter) = &shared.limiter {
            tokio::select! {
                _ = limiter.acquire(len) => {}
                _ = shared.control.wait_stopped() => {
                    return BodyResult::Stopped(flush1!(&mut buffer, file, written));
                }
            }
        }
        if let Some(split_at) = claim.steal_target() {
            let target_rel = split_at.saturating_sub(claim.start).min(claim.len());
            let already = written + buffer.len() as u64;
            if already + len >= target_rel {
                let take = target_rel.saturating_sub(already) as usize;
                buffer.extend_from_slice(&bytes[..take.min(bytes.len())]);
                let next = flush1!(&mut buffer, file, written);
                claim.update_progress(next);
                shared.dirty.store(true, Ordering::SeqCst);
                return BodyResult::Split(next);
            }
        }
        buffer.extend_from_slice(&bytes);
        if buffer.len() >= buffer_limit {
            written = flush1!(&mut buffer, file, written);
            claim.update_progress(written);
            shared.dirty.store(true, Ordering::SeqCst);
        }
    }
    written = flush1!(&mut buffer, file, written);
    if written < claim.len() {
        claim.update_progress(written);
        return BodyResult::Retry(written, format!("stream ended after {written} of {} bytes", claim.len()));
    }
    BodyResult::Complete
}
async fn flush(buffer: &mut Vec<u8>, file: &mut tokio::fs::File, counters: &Arc<Counters>, written: u64) -> Result<u64, EngineError> {
    if buffer.is_empty() {
        return Ok(written);
    }
    let bytes = buffer.len() as u64;
    file.write_all(buffer).await.map_err(|error| EngineError::io(format!("write failed: {error}")))?;
    buffer.clear();
    counters.add_downloaded(bytes);
    Ok(written + bytes)
}
