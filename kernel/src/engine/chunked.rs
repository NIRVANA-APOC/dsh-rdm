use crate::engine::{control_error, finalize, prepare_part, Counters, EngineError, Reporter, Slot, SAVE_INTERVAL, STALL_TIMEOUT, WRITE_BUFFER_BYTES};
use crate::error::EngineResult;
use crate::http;
use crate::klog;
use crate::plan::{self, ChunkPlan};
use crate::protocol::{Meta, Spec, Status};
use crate::rate::TokenBucket;
use crate::scheduler::{Claim, Scheduler, COALESCE_MAX_BYTES, COALESCE_MIN_BYTES};
use crate::state::{self, ResumeState};
use crate::task::{Control, StopKind, Task};
use reqwest::header::{CONTENT_RANGE, IF_RANGE, RANGE};
use reqwest::{Client, StatusCode};
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Notify;
use tokio::time::{interval, timeout, MissedTickBehavior};
const WORK_POLL: Duration = Duration::from_millis(100);
const STEAL_WAIT: Duration = Duration::from_millis(250);
const GATE_POLL: Duration = Duration::from_millis(10);
const CONTROL_WINDOW: Duration = Duration::from_secs(1);
struct Shared {
    total: u64,
    client: Client,
    url: String,
    etag: Option<String>,
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
    target_workers: AtomicUsize,
    pushback: Mutex<Option<Instant>>,
    pushback_seen: AtomicBool,
    failure: Mutex<Option<EngineError>>,
    downgrade: AtomicBool,
    dirty: AtomicBool,
    last_save: Mutex<Instant>,
    save_lock: tokio::sync::Mutex<()>,
    wake: Notify,
    workers: usize,
    max_attempts: u32,
    started: Instant,
}
impl Shared {
    fn stopped(&self) -> bool {
        self.control.is_stopped() || self.failure.lock().map(|slot| slot.is_some()).unwrap_or(false)
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
    async fn save_state(&self) {
        let _guard = self.save_lock.lock().await;
        let state = ResumeState::new(&self.spec_url, &self.meta, self.total, self.chunk_size, self.scheduler.completed_ranges(), self.counters.downloaded());
        if let Err(error) = state::save_atomic(&self.state_path, &state).await {
            klog!(warn, "could not save resume state: {error}");
        }
        *self.last_save.lock().expect("save mutex poisoned") = Instant::now();
        self.dirty.store(false, Ordering::SeqCst);
    }
    async fn save_if_due(&self) {
        if !self.dirty.swap(false, Ordering::SeqCst) {
            return;
        }
        let due = self.last_save.lock().expect("save mutex poisoned").elapsed() >= SAVE_INTERVAL;
        if due {
            self.save_state().await;
        } else {
            self.dirty.store(true, Ordering::SeqCst);
        }
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
pub async fn run(task: &Arc<Task>, spec: &Spec, client: &Client, meta: &Meta, total: u64, target: &Path, part: &Path, state_path: &Path) -> EngineResult<Option<String>> {
    let control = task.control();
    let plan = ChunkPlan::new(total, spec.connections, spec.chunk_size_bytes);
    let mut done: Vec<(u64, u64)> = Vec::new();
    let mut resumed_chunks = 0u64;
    if spec.resume {
        if let Some(saved) = state::load(state_path).await {
            let part_ok = tokio::fs::metadata(part).await.map(|shown| shown.len() == total).unwrap_or(false);
            if saved.is_compatible(&spec.url, meta, total) && part_ok {
                if let Some(ranges) = saved.completed_ranges() {
                    resumed_chunks = plan::covered_chunks(&plan, &ranges);
                    done = ranges;
                    task.add_event("info", Some(format!("resuming with {resumed_chunks} completed chunks")), None, None, None);
                }
            } else {
                klog!(info, "resume validators changed; restarting from zero");
            }
        }
    }
    if done.is_empty() {
        let _ = tokio::fs::remove_file(state_path).await;
    }
    prepare_part(part, total).await?;
    let resumed_bytes: u64 = done.iter().map(|(start, end)| end - start).sum();
    let missing = state::missing_ranges(&done, total);
    let scheduler = Arc::new(Scheduler::new(total, done, missing, plan.chunk_size));
    let counters = Arc::new(Counters::default());
    counters.downloaded.store(resumed_bytes, Ordering::Relaxed);
    let workers = spec.connections.min(plan.total_chunks.max(1) as usize).max(1);
    task.set_plan(workers, Some(plan.chunk_size), resumed_chunks);
    task.add_event("plan", Some(format!("{} bytes, {} chunks of {} bytes, {} workers, {} resumed bytes", total, plan.total_chunks, plan.chunk_size, workers, resumed_bytes)), None, None, None);
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
        client: client.clone(),
        url: meta.final_url.clone(),
        etag: meta.etag.clone(),
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
        pushback: Mutex::new(None),
        pushback_seen: AtomicBool::new(false),
        failure: Mutex::new(None),
        downgrade: AtomicBool::new(false),
        dirty: AtomicBool::new(false),
        last_save: Mutex::new(Instant::now()),
        save_lock: tokio::sync::Mutex::new(()),
        wake: Notify::new(),
        workers,
        max_attempts: spec.max_attempts.max(1),
        started: Instant::now(),
    });
    let reporter = Reporter::start(Arc::clone(task), Arc::clone(&counters), Some(total));
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
    let mut handles = Vec::with_capacity(workers);
    for _ in 0..workers {
        let shared = Arc::clone(&shared);
        handles.push(tokio::spawn(async move { worker(shared).await }));
    }
    for handle in handles {
        if let Err(error) = handle.await {
            shared.fail(EngineError::internal(format!("worker task terminated unexpectedly: {error}")));
        }
    }
    controller_done.notify_waiters();
    let _ = timeout(Duration::from_secs(2), controller).await;
    saver_done.notify_waiters();
    let _ = timeout(Duration::from_secs(2), saver).await;
    reporter.stop().await;
    if let Some(outcome) = control.stop_kind() {
        shared.save_state().await;
        task.progress(counters.downloaded(), Some(total), 0, 0, counters.peak());
        return Err(match outcome {
            StopKind::Paused => EngineError::Paused,
            StopKind::Cancelled => EngineError::Cancelled,
        });
    }
    if shared.downgrade.load(Ordering::SeqCst) {
        task.add_event("retry", Some("server ignored Range; falling back to a single stream".to_string()), None, None, None);
        let _ = tokio::fs::remove_file(state_path).await;
        return super::single::run(task, spec, client, meta, Some(total), target, part, state_path).await;
    }
    if let Some(error) = shared.take_failure() {
        shared.save_state().await;
        task.progress(counters.downloaded(), Some(total), 0, 0, counters.peak());
        return Err(error);
    }
    if !scheduler.is_finished() {
        shared.save_state().await;
        task.progress(counters.downloaded(), Some(total), 0, 0, counters.peak());
        return Err(EngineError::internal("transfer ended before every byte range completed"));
    }
    counters.downloaded.store(total, Ordering::Relaxed);
    task.progress(total, Some(total), 0, 0, counters.peak());
    task.add_event("info", Some(format!("finished in {} ms", shared.started.elapsed().as_millis())), None, None, None);
    finalize(task, spec, part, state_path, target, Some(total)).await
}
async fn controller_loop(shared: Arc<Shared>, done: Arc<Notify>) {
    let mut ticker = interval(CONTROL_WINDOW);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ticker.tick().await;
    let mut last_net = shared.counters.net_rx();
    let mut last_nanos = shared.counters.active_nanos();
    let mut last_delta = 0u64;
    let mut last_at = Instant::now();
    loop {
        tokio::select! {
            _ = done.notified() => break,
            _ = ticker.tick() => {}
        }
        let now = Instant::now();
        let elapsed = now.saturating_duration_since(last_at).as_secs_f64().max(1e-6);
        let net = shared.counters.net_rx();
        let nanos = shared.counters.active_nanos();
        let delta = net.saturating_sub(last_net);
        let avg_active = nanos.saturating_sub(last_nanos) as f64 / (elapsed * 1e9);
        last_net = net;
        last_nanos = nanos;
        last_at = now;
        let cap = shared.workers.min(shared.scheduler.remaining_units()).max(1);
        let current = shared.target_workers.load(Ordering::SeqCst).clamp(1, cap);
        let mut target = current;
        if shared.pushback_seen.swap(false, Ordering::SeqCst) {
            target = (target / 2).max(1);
        } else if target < cap && avg_active >= target as f64 * 0.75 && delta >= last_delta {
            target += 1;
        } else if target > 1 && last_delta > 0 && delta * 10 < last_delta * 7 {
            target -= 1;
        }
        if target != current {
            shared.target_workers.store(target, Ordering::SeqCst);
            shared.wake.notify_waiters();
            shared.task.add_event("controller", Some(format!("active workers -> {target}")), None, None, None);
        }
        last_delta = delta;
    }
}
async fn worker(shared: Arc<Shared>) {
    let mut file = match tokio::fs::OpenOptions::new().write(true).open(&shared.part).await {
        Ok(file) => file,
        Err(error) => {
            shared.fail(EngineError::io(format!("could not open .part file: {error}")));
            return;
        }
    };
    let keep_pending = shared.workers;
    let max_span = if shared.total >= COALESCE_MIN_BYTES { COALESCE_MAX_BYTES } else { 0 };
    loop {
        if shared.stopped() {
            break;
        }
        if !shared.wait_pushback().await {
            break;
        }
        let claim = match shared.scheduler.claim_with(keep_pending, max_span) {
            Some(claim) => claim,
            None => {
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
        match download_claim(&shared, &mut file, claim).await {
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
}
async fn download_claim(shared: &Arc<Shared>, file: &mut tokio::fs::File, claim: Claim) -> ClaimOutcome {
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
        let Some(slot) = shared.acquire_slot().await else {
            shared.scheduler.complete(claim, written);
            return ClaimOutcome::Stopped;
        };
        attempt += 1;
        let start = claim.start + written;
        let end_inclusive = claim.end - 1;
        let mut request = shared.client.get(&shared.url).header(RANGE, format!("bytes={start}-{end_inclusive}"));
        if let Some(etag) = shared.etag.as_deref() {
            if etag.starts_with('"') && etag.ends_with('"') {
                request = request.header(IF_RANGE, etag);
            }
        }
        let response = tokio::select! {
            result = request.send() => result,
            _ = shared.control.wait_stopped() => {
                drop(slot);
                shared.scheduler.complete(claim, written);
                return ClaimOutcome::Stopped;
            }
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                drop(slot);
                if let Some(delay) = retry_schedule(shared, &claim, attempt, written, format!("request failed: {error}"), None) {
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
                if let Some(delay) = retry_schedule(shared, &claim, attempt, written, format!("invalid Content-Range for bytes {start}-{end_inclusive}"), Some(status.as_u16())) {
                    if !shared.control.sleep(delay).await {
                        shared.scheduler.complete(claim, written);
                        return ClaimOutcome::Stopped;
                    }
                    continue;
                }
                return ClaimOutcome::Failed;
            }
            let outcome = stream_body(shared, file, &claim, response, written).await;
            drop(slot);
            match outcome {
                BodyResult::Complete => {
                    let length = claim.len();
                    shared.scheduler.complete(claim, length);
                    return ClaimOutcome::Done;
                }
                BodyResult::Split(covered) => {
                    shared.scheduler.complete(claim, covered);
                    return ClaimOutcome::Done;
                }
                BodyResult::Stopped(new_written) => {
                    shared.scheduler.complete(claim, new_written);
                    return ClaimOutcome::Stopped;
                }
                BodyResult::Fatal(error) => {
                    shared.fail(error);
                    return ClaimOutcome::Failed;
                }
                BodyResult::Retry(new_written, reason) => {
                    written = new_written;
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
            return ClaimOutcome::Downgrade;
        }
        if status == StatusCode::RANGE_NOT_SATISFIABLE {
            shared.fail(EngineError::remote_changed(format!("server rejected range bytes {start}-{end_inclusive} (HTTP 416)")));
            return ClaimOutcome::Failed;
        }
        let retry_after = http::retry_after(response.headers());
        if matches!(status.as_u16(), 429 | 503) {
            shared.note_pushback(retry_after.unwrap_or_else(|| http::backoff(attempt)));
        }
        if let Some(delay) = retry_schedule(shared, &claim, attempt, written, format!("server returned HTTP {}", status.as_u16()), Some(status.as_u16())) {
            let delay = retry_after.unwrap_or(delay);
            if !shared.control.sleep(delay).await {
                shared.scheduler.complete(claim, written);
                return ClaimOutcome::Stopped;
            }
            continue;
        }
        let _ = shared.take_failure();
        shared.fail(EngineError::http_status(status.as_u16(), &shared.url));
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
    let delay = http::backoff(attempt);
    shared.task.add_event("retry", Some(reason), Some(claim.start), Some(attempt), Some(delay.as_millis().min(u128::from(u64::MAX)) as u64));
    shared.dirty.store(true, Ordering::SeqCst);
    Some(delay)
}
async fn stream_body(shared: &Arc<Shared>, file: &mut tokio::fs::File, claim: &Claim, mut response: reqwest::Response, initial_written: u64) -> BodyResult {
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
    let mut buffer: Vec<u8> = Vec::with_capacity(WRITE_BUFFER_BYTES);
    loop {
        if written >= claim.len() {
            return BodyResult::Complete;
        }
        let chunk = tokio::select! {
            result = timeout(STALL_TIMEOUT, response.chunk()) => match result {
                Ok(result) => result,
                Err(_) => {
                    let written = flush1!(&mut buffer, file, written);
                    return BodyResult::Retry(written, format!("no body data for {} s (stalled connection)", STALL_TIMEOUT.as_secs()));
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
        if buffer.len() >= WRITE_BUFFER_BYTES {
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
