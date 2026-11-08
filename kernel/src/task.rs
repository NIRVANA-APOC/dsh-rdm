use crate::diagnosis::{diagnose, DiagnosisInput};
use crate::filename;
use crate::protocol::{
    now_ms, percent_of, ErrorInfo, ResumeSafety, ResumeStateFacts, ServerFacts, Spec, Status, TargetFacts, TaskDetail, TaskEvent, TaskRecord, TaskView, Telemetry, TimingDetail, Trend, VerificationFacts, EVENT_RING_CAPACITY,
};
use crate::state;
use crate::telemetry::{self, SpeedRing};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{watch, Notify};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopKind {
    Paused,
    Cancelled,
}

const RUN: u8 = 0;
const PAUSE: u8 = 1;
const CANCEL: u8 = 2;
/// A retry event is still "recent" (diagnosis `retrying`) for this long.
const RETRY_RECENT: Duration = Duration::from_secs(30);
/// A 429/503 pushback is still "recent" (diagnosis `throttled`) for this long.
const THROTTLE_RECENT: Duration = Duration::from_secs(60);

pub struct Control {
    mode: AtomicU8,
    notify: Notify,
}

impl Control {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { mode: AtomicU8::new(RUN), notify: Notify::new() })
    }
    pub fn pause(&self) {
        if self.mode.compare_exchange(RUN, PAUSE, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            self.notify.notify_waiters();
        }
    }
    pub fn cancel(&self) {
        self.mode.store(CANCEL, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub fn stop_kind(&self) -> Option<StopKind> {
        match self.mode.load(Ordering::SeqCst) {
            PAUSE => Some(StopKind::Paused),
            CANCEL => Some(StopKind::Cancelled),
            _ => None,
        }
    }
    pub fn is_stopped(&self) -> bool {
        self.stop_kind().is_some()
    }
    /// Sleep, waking immediately when the task is paused or cancelled.
    pub async fn sleep(&self, duration: Duration) -> bool {
        if self.is_stopped() {
            return false;
        }
        tokio::select! {
            _ = tokio::time::sleep(duration) => !self.is_stopped(),
            _ = self.wait_stopped() => false,
        }
    }
    /// Resolve as soon as the task leaves `RUN`; no timer polling.
    pub async fn wait_stopped(&self) -> StopKind {
        loop {
            if let Some(kind) = self.stop_kind() {
                return kind;
            }
            let notified = self.notify.notified();
            tokio::pin!(notified);
            // Register before the second check so a pause() cannot slip in
            // between the check and the await.
            notified.as_mut().enable();
            if let Some(kind) = self.stop_kind() {
                return kind;
            }
            notified.await;
        }
    }
}

#[rustfmt::skip]
pub struct ViewState {
    pub status: Status, pub final_url: Option<String>, pub file_name: String, pub dir: String,
    pub path: Option<String>, pub downloaded: u64, pub total: Option<u64>, pub speed_bps: u64,
    pub eta_secs: Option<u64>, pub active_workers: usize, pub peak_workers: usize,
    pub connections: usize, pub chunk_size: Option<u64>, pub resumed_chunks: u64,
    pub range_supported: Option<bool>, pub sha256: Option<String>, pub error: Option<ErrorInfo>,
    pub retries: u32, pub created_at: u64, pub started_at: Option<u64>, pub finished_at: Option<u64>,
    pub peak_bps: u64, pub resume_safety: ResumeSafety, pub verified: Option<bool>,
    pub signed_url_expires_at: Option<u64>, pub tls_not_after: Option<u64>,
    pub server: Option<ServerFacts>,
    pub ewma: f64, pub last_byte_at: Option<Instant>, pub last_retry_at: Option<Instant>,
    pub last_throttle_at: Option<Instant>,
    pub resumed_bytes: u64, pub resume_chunks_done: u64, pub resume_bytes_done: u64,
    pub validators_matched: bool,
    pub probe_ms: u64, pub transfer_ms: u64, pub finalize_ms: u64,
    pub transfer_started: Option<Instant>, pub finalize_started: Option<Instant>,
}

struct Inner {
    spec: Spec,
    view: ViewState,
    ring: SpeedRing,
    events: VecDeque<TaskEvent>,
    seq: u64,
    run_gen: u64,
    accumulated_ms: u64,
    run_started: Option<Instant>,
    dirty: bool,
    notify_pending: bool,
    last_notified: Instant,
    last_persist: Instant,
    persisted_status: Status,
}

pub struct Task {
    pub id: String,
    inner: Mutex<Inner>,
    status_tx: watch::Sender<Status>,
    status_notify: Arc<Notify>,
    control: Mutex<Option<Arc<Control>>>,
    running: AtomicBool,
    pub persist_wake: Notify,
}

fn provisional_name(spec: &Spec) -> String {
    match &spec.file_name {
        Some(name) => {
            let clean = filename::sanitize(name);
            if clean.is_empty() {
                filename::FALLBACK_NAME.to_string()
            } else {
                clean
            }
        }
        None => filename::derive(None, &spec.url),
    }
}

/// One coherent read of the telemetry ring for both the flat view and the
/// detail path.
struct Snapshot {
    windows: crate::protocol::WindowRates,
    stalled_ms: u64,
    trend: Trend,
    eta_confidence: crate::protocol::EtaConfidence,
    samples: u64,
    last_sample_at: Option<u64>,
    avg_bps: u64,
}

impl Task {
    pub fn new(id: String, spec: Spec, status_notify: Arc<Notify>) -> Arc<Self> {
        let view = ViewState {
            status: Status::Queued,
            final_url: None,
            file_name: provisional_name(&spec),
            dir: spec.dir.to_string_lossy().into_owned(),
            path: None,
            downloaded: 0,
            total: None,
            speed_bps: 0,
            eta_secs: None,
            active_workers: 0,
            peak_workers: 0,
            connections: spec.connections,
            chunk_size: None,
            resumed_chunks: 0,
            range_supported: None,
            sha256: None,
            error: None,
            retries: 0,
            created_at: now_ms(),
            started_at: None,
            finished_at: None,
            peak_bps: 0,
            resume_safety: ResumeSafety::None,
            verified: None,
            signed_url_expires_at: None,
            tls_not_after: None,
            server: None,
            ewma: 0.0,
            last_byte_at: None,
            last_retry_at: None,
            last_throttle_at: None,
            resumed_bytes: 0,
            resume_chunks_done: 0,
            resume_bytes_done: 0,
            validators_matched: true,
            probe_ms: 0,
            transfer_ms: 0,
            finalize_ms: 0,
            transfer_started: None,
            finalize_started: None,
        };
        Self::assemble(id, spec, view, VecDeque::new(), 0, status_notify)
    }

    fn assemble(id: String, spec: Spec, view: ViewState, events: VecDeque<TaskEvent>, seq: u64, status_notify: Arc<Notify>) -> Arc<Self> {
        let (status_tx, _) = watch::channel(view.status);
        let persisted_status = view.status;
        Arc::new(Self {
            id,
            inner: Mutex::new(Inner {
                spec,
                view,
                ring: SpeedRing::new(),
                events,
                seq,
                run_gen: 0,
                accumulated_ms: 0,
                run_started: None,
                dirty: false,
                notify_pending: true,
                last_notified: Instant::now(),
                last_persist: Instant::now(),
                persisted_status,
            }),
            status_tx,
            status_notify,
            control: Mutex::new(None),
            running: AtomicBool::new(false),
            persist_wake: Notify::new(),
        })
    }

    pub fn from_record(record: TaskRecord, status_notify: Arc<Notify>) -> Arc<Self> {
        let TaskRecord { spec, view: stored, server } = record;
        let status = if stored.status.is_active() { Status::Interrupted } else { stored.status };
        let changed = status != stored.status;
        let view = ViewState {
            status,
            final_url: stored.final_url,
            file_name: stored.file_name,
            dir: stored.dir,
            path: stored.path,
            downloaded: stored.downloaded,
            total: stored.total,
            speed_bps: 0,
            eta_secs: None,
            active_workers: 0,
            peak_workers: stored.peak_workers,
            connections: stored.connections,
            chunk_size: stored.chunk_size,
            resumed_chunks: stored.resumed_chunks,
            range_supported: stored.range_supported,
            sha256: stored.sha256,
            error: stored.error,
            retries: stored.retries,
            created_at: stored.created_at,
            started_at: stored.started_at,
            finished_at: stored.finished_at,
            peak_bps: stored.peak_bps,
            resume_safety: stored.resume_safety,
            verified: stored.verified,
            signed_url_expires_at: stored.signed_url_expires_at,
            tls_not_after: stored.tls_not_after,
            server,
            ewma: 0.0,
            last_byte_at: None,
            last_retry_at: None,
            last_throttle_at: None,
            resumed_bytes: 0,
            resume_chunks_done: 0,
            resume_bytes_done: stored.downloaded,
            validators_matched: true,
            probe_ms: 0,
            transfer_ms: stored.elapsed_ms,
            finalize_ms: 0,
            transfer_started: None,
            finalize_started: None,
        };
        let task = Self::assemble(stored.id, spec, view, VecDeque::new(), 0, status_notify);
        {
            let mut inner = task.inner.lock().expect("task mutex poisoned");
            inner.accumulated_ms = 0;
            inner.dirty = changed;
            inner.persisted_status = Status::Queued;
            inner.notify_pending = true;
        }
        task
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("task mutex poisoned")
    }

    fn mutate(&self, f: impl FnOnce(&mut Inner), notify: bool) {
        let mut inner = self.lock();
        f(&mut inner);
        inner.dirty = true;
        inner.notify_pending |= notify;
        drop(inner);
        self.persist_wake.notify_waiters();
    }

    pub fn spec(&self) -> Spec {
        self.lock().spec.clone()
    }
    pub fn status(&self) -> Status {
        self.lock().view.status
    }
    pub fn subscribe(&self) -> watch::Receiver<Status> {
        self.status_tx.subscribe()
    }
    pub fn control(&self) -> Arc<Control> {
        self.control.lock().expect("control mutex poisoned").clone().unwrap_or_else(Control::new)
    }

    pub fn begin_run(&self) -> (u64, Arc<Control>) {
        let control = Control::new();
        let generation = {
            let mut inner = self.lock();
            let now = Instant::now();
            inner.run_gen += 1;
            inner.run_started = Some(now);
            inner.ring.reset();
            // Run-boundary baseline: makes the first reporter sample (or the
            // terminal sample of a sub-100 ms transfer) a real measured rate.
            let downloaded = inner.view.downloaded;
            inner.ring.push(now, downloaded);
            let view = &mut inner.view;
            view.speed_bps = 0;
            view.ewma = 0.0;
            view.active_workers = 0;
            view.eta_secs = None;
            view.last_byte_at = None;
            view.transfer_started = None;
            view.finalize_started = None;
            view.probe_ms = 0;
            // `peak_bps` intentionally survives pause/resume.
            inner.run_gen
        };
        *self.control.lock().expect("control mutex poisoned") = Some(Arc::clone(&control));
        self.running.store(true, Ordering::SeqCst);
        (generation, control)
    }

    pub fn end_run(&self, generation: u64) -> bool {
        let mut inner = self.lock();
        if inner.run_gen != generation {
            return false;
        }
        self.running.store(false, Ordering::SeqCst);
        // Terminal sample: a download shorter than the reporter cadence still
        // gets one measured end point, so peak/window telemetry is not empty.
        let now = Instant::now();
        let downloaded = inner.view.downloaded;
        if let Some(last) = inner.ring.last() {
            if downloaded > last.bytes {
                inner.ring.push(now, downloaded);
                if let Some(rate_1s) = inner.ring.window_rate(now, Duration::from_secs(1)) {
                    inner.view.peak_bps = inner.view.peak_bps.max(rate_1s);
                }
            }
        }
        let view = &mut inner.view;
        view.active_workers = 0;
        view.speed_bps = 0;
        view.ewma = 0.0;
        view.eta_secs = None;
        self.control.lock().expect("control mutex poisoned").take();
        true
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn set_status(&self, status: Status) {
        let mut inner = self.lock();
        let previous = inner.view.status;
        if previous == status {
            return;
        }
        if status.is_active() && inner.view.started_at.is_none() {
            inner.view.started_at = Some(now_ms());
        }
        let now = Instant::now();
        if status == Status::Running && previous != Status::Running {
            inner.view.transfer_started = Some(now);
            if inner.view.last_byte_at.is_none() {
                inner.view.last_byte_at = Some(now);
            }
        }
        if previous == Status::Running && status != Status::Running {
            if let Some(started) = inner.view.transfer_started.take() {
                inner.view.transfer_ms = inner.view.transfer_ms.saturating_add(now.saturating_duration_since(started).as_millis() as u64);
            }
        }
        if !status.is_active() {
            if let Some(started) = inner.run_started.take() {
                inner.accumulated_ms += started.elapsed().as_millis() as u64;
            }
            if status.is_terminal() {
                inner.view.finished_at = Some(now_ms());
            }
        }
        inner.view.status = status;
        inner.dirty = true;
        inner.notify_pending = true;
        drop(inner);
        let _ = self.status_tx.send(status);
        if previous != status {
            self.status_notify.notify_waiters();
        }
        self.persist_wake.notify_waiters();
    }

    /// Store the enriched probe result: the flat fields and the full facts
    /// snapshot used by `get` and by post-restart review.
    pub fn set_server(&self, facts: &ServerFacts) {
        self.mutate(
            |inner| {
                let view = &mut inner.view;
                view.final_url = Some(facts.final_url.clone());
                view.file_name = facts.file_name.clone();
                view.total = facts.total_bytes;
                view.range_supported = Some(facts.range.supported);
                view.resume_safety = facts.resume.safety;
                view.signed_url_expires_at = if facts.signed_url.signed { facts.signed_url.expires_at } else { None };
                view.tls_not_after = facts.tls.as_ref().and_then(|tls| tls.not_after);
                view.server = Some(facts.clone());
                view.chunk_size = None;
            },
            true,
        );
    }

    pub fn set_probe_ms(&self, ms: u64) {
        self.mutate(|inner| inner.view.probe_ms = ms, false);
    }

    pub fn set_target(&self, dir: &Path, file_name: &str, target: &Path) {
        self.mutate(
            |inner| {
                let view = &mut inner.view;
                view.dir = dir.to_string_lossy().into_owned();
                view.file_name = file_name.to_string();
                view.path = Some(target.to_string_lossy().into_owned());
            },
            true,
        );
    }

    pub fn set_plan(&self, connections: usize, chunk_size: Option<u64>, resumed_chunks: u64, resumed_bytes: u64) {
        self.mutate(
            |inner| {
                let view = &mut inner.view;
                view.connections = connections;
                view.chunk_size = chunk_size;
                view.resumed_chunks = resumed_chunks;
                view.resumed_bytes = resumed_bytes;
            },
            false,
        );
    }

    /// Resume-state snapshot recorded by the engine when it saves `.part.json`.
    pub fn set_resume_stats(&self, chunks_done: u64, bytes_done: u64) {
        self.mutate(
            |inner| {
                inner.view.resume_chunks_done = chunks_done;
                inner.view.resume_bytes_done = bytes_done;
            },
            false,
        );
    }

    pub fn set_validators_matched(&self, matched: bool) {
        self.mutate(|inner| inner.view.validators_matched = matched, false);
    }

    /// Reporter tick (≤ 100 ms): sample the cumulative byte counter and update
    /// the EWMA rate, peak and per-window telemetry.
    pub fn report(&self, downloaded: u64, total: Option<u64>, active_workers: usize, peak_workers: usize) {
        let now = Instant::now();
        self.mutate(
            |inner| {
                let view = &mut inner.view;
                let advanced = downloaded > view.downloaded;
                view.downloaded = downloaded;
                view.total = total.or(view.total);
                view.active_workers = active_workers;
                view.peak_workers = view.peak_workers.max(peak_workers);
                if advanced {
                    view.last_byte_at = Some(now);
                }
                let previous = inner.ring.last();
                if inner.ring.should_sample(now) {
                    inner.ring.push(now, downloaded);
                    if let Some(previous) = previous {
                        let elapsed = now.saturating_duration_since(previous.at);
                        let instant = downloaded.saturating_sub(previous.bytes) as f64 / elapsed.as_secs_f64().max(1e-6);
                        view.ewma = telemetry::ewma_step(view.ewma, instant, elapsed);
                    } else {
                        view.ewma = 0.0;
                    }
                    if let Some(rate_1s) = inner.ring.window_rate(now, Duration::from_secs(1)) {
                        view.peak_bps = view.peak_bps.max(rate_1s);
                    }
                }
                view.speed_bps = view.ewma.round().max(0.0) as u64;
                view.eta_secs = match (view.total, view.speed_bps) {
                    (Some(total), _) if total <= downloaded => Some(0),
                    (Some(total), speed) if speed > 0 => Some((total - downloaded).div_ceil(speed)),
                    _ => None,
                };
            },
            false,
        );
    }

    pub fn note_retry(&self) {
        let now = Instant::now();
        self.mutate(
            |inner| {
                inner.view.retries += 1;
                inner.view.last_retry_at = Some(now);
            },
            true,
        );
    }

    pub fn note_throttled(&self) {
        let now = Instant::now();
        self.mutate(|inner| inner.view.last_throttle_at = Some(now), false);
    }

    pub fn set_error(&self, error: ErrorInfo) {
        // Transport errors can echo the request URL; redact before projection.
        let error = ErrorInfo { code: error.code, message: crate::protocol::redact_text(&error.message) };
        self.mutate(|inner| inner.view.error = Some(error), true);
    }
    pub fn set_sha256(&self, sha256: Option<String>) {
        self.mutate(|inner| inner.view.sha256 = sha256, false);
    }
    pub fn set_verified(&self, verified: Option<bool>) {
        self.mutate(|inner| inner.view.verified = verified, false);
    }

    /// Called when the finalize phase starts: close the transfer timer and
    /// start the finalize timer.
    pub fn begin_finalize(&self) {
        let now = Instant::now();
        self.mutate(
            |inner| {
                let view = &mut inner.view;
                if let Some(started) = view.transfer_started.take() {
                    view.transfer_ms = view.transfer_ms.saturating_add(now.saturating_duration_since(started).as_millis() as u64);
                }
                view.finalize_started = Some(now);
            },
            false,
        );
    }

    pub fn end_finalize(&self) {
        let now = Instant::now();
        self.mutate(
            |inner| {
                let view = &mut inner.view;
                if let Some(started) = view.finalize_started.take() {
                    view.finalize_ms = view.finalize_ms.saturating_add(now.saturating_duration_since(started).as_millis() as u64);
                }
            },
            false,
        );
    }

    pub fn add_event(&self, kind: &str, message: Option<String>, chunk: Option<u64>, attempt: Option<u32>, delay_ms: Option<u64>) {
        let mut inner = self.lock();
        inner.seq += 1;
        let message = message.map(|message| crate::protocol::redact_text(&message));
        let event = TaskEvent { seq: inner.seq, at: now_ms(), kind: kind.to_string(), message, chunk, attempt, delay_ms };
        inner.events.push_back(event);
        if inner.events.len() > EVENT_RING_CAPACITY {
            inner.events.pop_front();
        }
    }

    pub fn events(&self, limit: usize) -> Vec<TaskEvent> {
        let inner = self.lock();
        let skip = inner.events.len().saturating_sub(limit);
        inner.events.iter().skip(skip).cloned().collect()
    }

    fn elapsed_ms(inner: &Inner) -> u64 {
        inner.accumulated_ms + inner.run_started.map(|started| started.elapsed().as_millis() as u64).unwrap_or(0)
    }

    fn to_epoch_ms(now: Instant, now_ms: u64, at: Instant) -> u64 {
        let age = now.saturating_duration_since(at).as_millis() as u64;
        now_ms.saturating_sub(age)
    }

    fn snapshot(&self, inner: &Inner, now: Instant) -> Snapshot {
        let view = &inner.view;
        let running = view.status == Status::Running;
        let stalled_ms = if running { view.last_byte_at.map(|at| now.saturating_duration_since(at).as_millis() as u64).unwrap_or(0) } else { 0 };
        let windows = inner.ring.windows(now);
        let samples = inner.ring.len();
        let last_sample_at = inner.ring.last().map(|sample| Self::to_epoch_ms(now, now_ms(), sample.at));
        let cv = inner.ring.coefficient_of_variation(16);
        let trend = if running { telemetry::trend_of(&windows, stalled_ms, samples) } else { Trend::Unknown };
        let eta_confidence = telemetry::eta_confidence_of(view.total.is_some(), !running, stalled_ms, samples, cv);
        let elapsed = Self::elapsed_ms(inner);
        let avg_bps = if elapsed > 0 { (view.downloaded as u128 * 1000 / elapsed as u128) as u64 } else { 0 };
        Snapshot { windows, stalled_ms, trend, eta_confidence, samples: samples as u64, last_sample_at, avg_bps }
    }

    fn view_locked(&self, inner: &Inner, now: Instant) -> TaskView {
        let view = &inner.view;
        let snapshot = self.snapshot(inner, now);
        let resumable = view.range_supported == Some(true) && view.resume_safety != ResumeSafety::None;
        TaskView {
            id: self.id.clone(),
            session_id: inner.spec.session_id.clone(),
            // Protocol projections redact credential-bearing query values; the
            // raw URL stays in `Spec` for requests and resume.
            url: crate::protocol::redact_url(&inner.spec.url),
            host: inner.spec.host(),
            final_url: view.final_url.as_deref().map(crate::protocol::redact_url),
            file_name: view.file_name.clone(),
            dir: view.dir.clone(),
            path: view.path.clone(),
            status: view.status,
            downloaded: view.downloaded,
            total: view.total,
            percent: percent_of(view.downloaded, view.total),
            speed_bps: view.speed_bps,
            speed1s_bps: snapshot.windows.w1s,
            speed5s_bps: snapshot.windows.w5s,
            speed30s_bps: snapshot.windows.w30s,
            speed300s_bps: snapshot.windows.w300s,
            avg_bps: snapshot.avg_bps,
            peak_bps: view.peak_bps,
            eta_secs: view.eta_secs,
            eta_confidence: snapshot.eta_confidence,
            stalled_ms: snapshot.stalled_ms,
            active_workers: view.active_workers,
            peak_workers: view.peak_workers,
            connections: view.connections,
            chunk_size: view.chunk_size,
            resumed_chunks: view.resumed_chunks,
            range_supported: view.range_supported,
            resumable,
            resume_safety: view.resume_safety,
            expected_sha256: inner.spec.expected_sha256.clone(),
            sha256: view.sha256.clone(),
            verified: view.verified,
            error: view.error.clone(),
            retries: view.retries,
            created_at: view.created_at,
            started_at: view.started_at,
            finished_at: view.finished_at,
            elapsed_ms: Self::elapsed_ms(inner),
            signed_url_expires_at: view.signed_url_expires_at,
            tls_not_after: view.tls_not_after,
        }
    }

    pub fn view(&self) -> TaskView {
        let inner = self.lock();
        let now = Instant::now();
        self.view_locked(&inner, now)
    }

    /// Detail path (§2.3). `origin` is the ledger snapshot for this host, if
    /// the kernel has seen it.
    pub fn detail(&self, origin: Option<&crate::protocol::OriginFacts>) -> TaskDetail {
        let inner = self.lock();
        let now = Instant::now();
        let snapshot = self.snapshot(&inner, now);
        let view = &inner.view;
        let queued_ms = view.started_at.map(|started| started.saturating_sub(view.created_at)).unwrap_or_else(|| now_ms().saturating_sub(view.created_at));
        let live_transfer = view.transfer_started.map(|started| now.saturating_duration_since(started).as_millis() as u64).unwrap_or(0);
        let live_finalize = view.finalize_started.map(|started| now.saturating_duration_since(started).as_millis() as u64).unwrap_or(0);
        let target = TargetFacts {
            dir: view.dir.clone(),
            path: view.path.clone(),
            part: view.path.as_deref().map(|path| state::part_path(Path::new(path)).to_string_lossy().into_owned()),
            resume_state: view.path.as_deref().map(|path| state::state_path(Path::new(path)).to_string_lossy().into_owned()),
        };
        let expected_sha256 = inner.spec.expected_sha256.clone();
        let verification =
            VerificationFacts { expected_sha256: expected_sha256.clone(), sha256: view.sha256.clone(), verified: view.verified, server_checksums: view.server.as_ref().map(|server| server.checksum.clone()).unwrap_or_default() };
        let retrying_recent = view.last_retry_at.is_some_and(|at| now.saturating_duration_since(at) <= RETRY_RECENT);
        let throttled_recent = view.last_throttle_at.is_some_and(|at| now.saturating_duration_since(at) <= THROTTLE_RECENT);
        let input = DiagnosisInput {
            status: view.status,
            percent: percent_of(view.downloaded, view.total),
            stalled_ms: snapshot.stalled_ms,
            retries: view.retries,
            retrying_recent,
            throttled_recent,
            eta_confidence: snapshot.eta_confidence,
            range_supported: view.range_supported,
            resume_safety: view.resume_safety,
            expected_sha256: expected_sha256.as_deref(),
            avg_bps: snapshot.avg_bps,
            error_code: view.error.as_ref().map(|error| error.code.as_str()),
            server: view.server.as_ref(),
            origin,
        };
        let diagnosis = diagnose(&input);
        TaskDetail {
            telemetry: Telemetry {
                windows: snapshot.windows,
                peak_bps: view.peak_bps,
                avg_bps: snapshot.avg_bps,
                stalled_ms: snapshot.stalled_ms,
                trend: snapshot.trend,
                eta_confidence: snapshot.eta_confidence,
                samples: snapshot.samples,
                last_sample_at: snapshot.last_sample_at,
            },
            server: view.server.clone().map(|facts| facts.redacted()),
            target,
            verification,
            resume_state: ResumeStateFacts { chunks_done: view.resume_chunks_done, bytes_done: view.resume_bytes_done, resumed_chunks: view.resumed_chunks, resumed_bytes: view.resumed_bytes, validators_matched: view.validators_matched },
            timing: TimingDetail { queued_ms, probe_ms: view.probe_ms, transfer_ms: view.transfer_ms.saturating_add(live_transfer), finalize_ms: view.finalize_ms.saturating_add(live_finalize) },
            diagnosis,
        }
    }

    pub fn record(&self) -> TaskRecord {
        let inner = self.lock();
        let now = Instant::now();
        let view = self.view_locked(&inner, now);
        let server = inner.view.server.clone().map(|facts| facts.redacted());
        TaskRecord { spec: inner.spec.clone(), view, server }
    }

    pub fn take_notification(&self, min_progress_interval: Duration, now: Instant) -> bool {
        let mut inner = self.lock();
        if inner.notify_pending {
            inner.notify_pending = false;
            inner.last_notified = now;
            return true;
        }
        if inner.view.status == Status::Running && now.duration_since(inner.last_notified) >= min_progress_interval {
            inner.last_notified = now;
            return true;
        }
        false
    }

    pub fn take_dirty(&self) -> bool {
        std::mem::take(&mut self.lock().dirty)
    }

    /// Persist decision: a status change is written immediately (crash safety
    /// for lifecycle transitions); progress-only updates are coalesced to one
    /// write per `interval`, because the kernel view is a cache the next kernel
    /// generation only needs for resume display.
    pub fn take_persist(&self, interval: Duration, now: Instant) -> bool {
        let mut inner = self.lock();
        if !inner.dirty {
            return false;
        }
        let status_changed = inner.persisted_status != inner.view.status;
        if !status_changed && now.duration_since(inner.last_persist) < interval {
            return false;
        }
        inner.dirty = false;
        inner.last_persist = now;
        inner.persisted_status = inner.view.status;
        true
    }

    pub fn reset_for_retry(&self) {
        self.mutate(
            |inner| {
                let view = &mut inner.view;
                view.downloaded = 0;
                view.total = None;
                view.speed_bps = 0;
                view.eta_secs = None;
                view.active_workers = 0;
                view.peak_workers = 0;
                view.resumed_chunks = 0;
                view.range_supported = None;
                view.chunk_size = None;
                view.final_url = None;
                view.sha256 = None;
                view.error = None;
                view.retries = 0;
                view.finished_at = None;
                view.status = Status::Queued;
                view.peak_bps = 0;
                view.ewma = 0.0;
                view.resume_safety = ResumeSafety::None;
                view.verified = None;
                view.signed_url_expires_at = None;
                view.tls_not_after = None;
                view.server = None;
                view.last_byte_at = None;
                view.last_retry_at = None;
                view.last_throttle_at = None;
                view.resumed_bytes = 0;
                view.resume_chunks_done = 0;
                view.resume_bytes_done = 0;
                view.validators_matched = true;
                view.probe_ms = 0;
                view.transfer_ms = 0;
                view.finalize_ms = 0;
                view.transfer_started = None;
                view.finalize_started = None;
                inner.accumulated_ms = 0;
                inner.run_started = None;
                inner.ring.reset();
            },
            true,
        );
        let _ = self.status_tx.send(Status::Queued);
        self.status_notify.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Config, RequestSpec};

    fn spec(session: Option<&str>) -> Spec {
        let mut raw: RequestSpec = serde_json::from_str(r#"{"url":"https://cdn.example.com/file.bin"}"#).unwrap();
        raw.session_id = session.map(str::to_string);
        Spec::resolve(raw, &Config::default()).unwrap()
    }

    fn task() -> Arc<Task> {
        Task::new("t_test".to_string(), spec(Some("sess_abc")), Arc::new(Notify::new()))
    }

    /// Byte clock slower than the 100 ms reporter cadence so every call lands
    /// as a real sample in the ring.
    fn pump(task: &Task, samples: usize) {
        let _ = task.begin_run();
        for index in 1..=samples {
            task.report(index as u64 * 100 * 1024, Some(50_000_000), 2, 2);
            std::thread::sleep(Duration::from_millis(110));
        }
    }

    #[test]
    fn view_is_flat_v2_and_computes_percent() {
        let task = task();
        task.set_status(Status::Probing);
        task.set_status(Status::Running);
        let mut facts = ServerFacts::default();
        facts.total_bytes = Some(100);
        facts.range = crate::protocol::RangeFacts { supported: true, ..crate::protocol::RangeFacts::default() };
        facts.resume = crate::protocol::ResumeFacts { possible: true, safety: ResumeSafety::Strong, reason: crate::protocol::ResumeReason::StrongEtag };
        facts.signed_url = crate::protocol::SignedUrlFacts { signed: true, expires_at: Some(123), ..crate::protocol::SignedUrlFacts::default() };
        facts.file_name = "file.bin".into();
        task.set_server(&facts);
        task.report(25, Some(100), 2, 2);
        let view = task.view();
        assert_eq!(view.session_id.as_deref(), Some("sess_abc"));
        assert_eq!(view.host, "cdn.example.com");
        assert_eq!(view.percent, Some(25));
        assert!(view.resumable);
        assert_eq!(view.resume_safety, ResumeSafety::Strong);
        assert_eq!(view.signed_url_expires_at, Some(123));
        let json = serde_json::to_value(&view).unwrap();
        for key in ["sessionId", "percent", "speed1sBps", "speed5sBps", "speed30sBps", "speed300sBps", "avgBps", "peakBps", "etaConfidence", "stalledMs", "resumable", "resumeSafety", "verified", "signedUrlExpiresAt", "tlsNotAfter", "host"]
        {
            assert!(json.get(key).is_some(), "missing {key}: {json}");
        }
    }

    #[test]
    fn telemetry_samples_produce_windows_and_detail() {
        let task = task();
        task.set_status(Status::Probing);
        task.set_status(Status::Running);
        pump(&task, 4);
        let detail = task.detail(None);
        assert!(detail.telemetry.samples > 0);
        assert!(detail.telemetry.windows.w1s.is_some(), "{detail:?}");
        assert!(detail.telemetry.avg_bps > 0);
        assert!(detail.telemetry.last_sample_at.is_some());
        assert!(!detail.diagnosis.is_empty());
        let view = task.view();
        assert_eq!(view.speed1s_bps, detail.telemetry.windows.w1s);
        assert_eq!(view.avg_bps, detail.telemetry.avg_bps);
    }

    #[test]
    fn detail_timing_separates_phases() {
        let task = task();
        task.set_status(Status::Probing);
        task.set_probe_ms(84);
        task.set_status(Status::Running);
        task.report(1_000, Some(10_000), 1, 1);
        std::thread::sleep(Duration::from_millis(3));
        task.begin_finalize();
        std::thread::sleep(Duration::from_millis(1));
        task.end_finalize();
        task.set_status(Status::Completed);
        let detail = task.detail(None);
        assert_eq!(detail.timing.probe_ms, 84);
        assert!(detail.timing.transfer_ms >= 3);
        assert!(detail.timing.finalize_ms >= 1);
        assert!(detail.verification.verified.is_none());
    }

    #[test]
    fn session_id_and_host_are_carried_on_the_view() {
        let view = task().view();
        assert_eq!(view.session_id.as_deref(), Some("sess_abc"));
        assert_eq!(view.host, "cdn.example.com");
        let plain = Task::new("t2".to_string(), spec(None), Arc::new(Notify::new()));
        assert!(plain.view().session_id.is_none());
    }

    #[test]
    fn reset_for_retry_clears_peak_and_ring() {
        let task = task();
        task.set_status(Status::Probing);
        task.set_status(Status::Running);
        pump(&task, 5);
        assert!(task.view().peak_bps > 0);
        task.reset_for_retry();
        let view = task.view();
        assert_eq!(view.peak_bps, 0);
        assert_eq!(view.downloaded, 0);
        assert!(view.speed1s_bps.is_none());
    }
}
