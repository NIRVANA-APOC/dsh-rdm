use crate::filename;
use crate::protocol::{now_ms, ErrorInfo, Spec, Status, TaskEvent, TaskRecord, TaskView, EVENT_RING_CAPACITY};
use crate::state;
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

pub struct Control {
    mode: AtomicU8,
}

impl Control {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { mode: AtomicU8::new(RUN) })
    }
    pub fn pause(&self) {
        let _ = self.mode.compare_exchange(RUN, PAUSE, Ordering::SeqCst, Ordering::SeqCst);
    }
    pub fn cancel(&self) {
        self.mode.store(CANCEL, Ordering::SeqCst);
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
    pub async fn sleep(&self, duration: Duration) -> bool {
        let deadline = Instant::now() + duration;
        loop {
            if self.is_stopped() {
                return false;
            }
            let now = Instant::now();
            if now >= deadline {
                return true;
            }
            tokio::time::sleep((deadline - now).min(Duration::from_millis(25))).await;
        }
    }
    pub async fn wait_stopped(&self) -> StopKind {
        loop {
            if let Some(kind) = self.stop_kind() {
                return kind;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
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
}

struct Inner {
    spec: Spec,
    view: ViewState,
    events: VecDeque<TaskEvent>,
    seq: u64,
    run_gen: u64,
    accumulated_ms: u64,
    run_started: Option<Instant>,
    dirty: bool,
    notify_pending: bool,
    last_notified: Instant,
}

pub struct Task {
    pub id: String,
    inner: Mutex<Inner>,
    status_tx: watch::Sender<Status>,
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

impl Task {
    pub fn new(id: String, spec: Spec) -> Arc<Self> {
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
        };
        Self::assemble(id, spec, view, VecDeque::new(), 0)
    }

    fn assemble(id: String, spec: Spec, view: ViewState, events: VecDeque<TaskEvent>, seq: u64) -> Arc<Self> {
        let (status_tx, _) = watch::channel(view.status);
        Arc::new(Self {
            id,
            inner: Mutex::new(Inner { spec, view, events, seq, run_gen: 0, accumulated_ms: 0, run_started: None, dirty: false, notify_pending: true, last_notified: Instant::now() }),
            status_tx,
            control: Mutex::new(None),
            running: AtomicBool::new(false),
            persist_wake: Notify::new(),
        })
    }

    pub fn from_record(record: TaskRecord) -> Arc<Self> {
        let TaskRecord { spec, view: stored } = record;
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
        };
        let task = Self::assemble(stored.id, spec, view, VecDeque::new(), 0);
        {
            let mut inner = task.inner.lock().unwrap();
            inner.accumulated_ms = stored.elapsed_ms;
            inner.dirty = changed;
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
            inner.run_gen += 1;
            inner.run_started = Some(Instant::now());
            inner.view.speed_bps = 0;
            inner.view.active_workers = 0;
            inner.view.eta_secs = None;
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
        inner.view.active_workers = 0;
        inner.view.speed_bps = 0;
        inner.view.eta_secs = None;
        self.control.lock().expect("control mutex poisoned").take();
        true
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn set_status(&self, status: Status) {
        let mut inner = self.lock();
        if inner.view.status == status {
            return;
        }
        if status.is_active() && inner.view.started_at.is_none() {
            inner.view.started_at = Some(now_ms());
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
        self.persist_wake.notify_waiters();
    }

    pub fn set_meta(&self, meta: &crate::protocol::Meta) {
        self.mutate(
            |inner| {
                inner.view.final_url = Some(meta.final_url.clone());
                inner.view.file_name = meta.file_name.clone();
                inner.view.total = meta.total_bytes;
                inner.view.range_supported = Some(meta.supports_ranges);
                inner.view.chunk_size = None;
            },
            true,
        );
    }

    pub fn set_target(&self, dir: &Path, file_name: &str, target: &Path) {
        self.mutate(
            |inner| {
                inner.view.dir = dir.to_string_lossy().into_owned();
                inner.view.file_name = file_name.to_string();
                inner.view.path = Some(target.to_string_lossy().into_owned());
            },
            true,
        );
    }

    pub fn set_plan(&self, connections: usize, chunk_size: Option<u64>, resumed_chunks: u64) {
        self.mutate(
            |inner| {
                inner.view.connections = connections;
                inner.view.chunk_size = chunk_size;
                inner.view.resumed_chunks = resumed_chunks;
            },
            false,
        );
    }

    pub fn progress(&self, downloaded: u64, total: Option<u64>, speed_bps: u64, active_workers: usize, peak_workers: usize) {
        self.mutate(
            |inner| {
                let view = &mut inner.view;
                view.downloaded = downloaded;
                view.total = total.or(view.total);
                view.speed_bps = speed_bps;
                view.active_workers = active_workers;
                view.peak_workers = view.peak_workers.max(peak_workers);
                view.eta_secs = match (view.total, speed_bps) {
                    (Some(total), speed) if speed > 0 && total > downloaded => Some((total - downloaded).div_ceil(speed)),
                    (Some(_), _) => Some(0),
                    (None, _) => None,
                };
            },
            false,
        );
    }

    pub fn note_retry(&self) {
        self.mutate(|inner| inner.view.retries += 1, true);
    }
    pub fn set_error(&self, error: ErrorInfo) {
        self.mutate(|inner| inner.view.error = Some(error), true);
    }
    pub fn set_sha256(&self, sha256: Option<String>) {
        self.mutate(|inner| inner.view.sha256 = sha256, false);
    }

    pub fn add_event(&self, kind: &str, message: Option<String>, chunk: Option<u64>, attempt: Option<u32>, delay_ms: Option<u64>) {
        let mut inner = self.lock();
        inner.seq += 1;
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

    #[rustfmt::skip]
    pub fn view(&self) -> TaskView {
        let inner = self.lock();
        let view = &inner.view;
        let elapsed_ms = inner.accumulated_ms + inner.run_started.map(|started| started.elapsed().as_millis() as u64).unwrap_or(0);
        let resumable = matches!(view.status, Status::Paused | Status::Interrupted | Status::Cancelled)
            && view.path.as_deref().is_some_and(|path| {
                let target = Path::new(path);
                state::part_path(target).exists() && state::state_path(target).exists()
            });
        TaskView {
            id: self.id.clone(), url: inner.spec.url.clone(), final_url: view.final_url.clone(),
            file_name: view.file_name.clone(), dir: view.dir.clone(), path: view.path.clone(),
            status: view.status, downloaded: view.downloaded, total: view.total,
            speed_bps: view.speed_bps, eta_secs: view.eta_secs, active_workers: view.active_workers,
            peak_workers: view.peak_workers, connections: view.connections, chunk_size: view.chunk_size,
            resumed_chunks: view.resumed_chunks, range_supported: view.range_supported,
            expected_sha256: inner.spec.expected_sha256.clone(), sha256: view.sha256.clone(),
            error: view.error.clone(), retries: view.retries, created_at: view.created_at,
            started_at: view.started_at, finished_at: view.finished_at, elapsed_ms, resumable,
        }
    }

    pub fn record(&self) -> TaskRecord {
        TaskRecord { spec: self.spec(), view: self.view() }
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
                inner.accumulated_ms = 0;
                inner.run_started = None;
            },
            true,
        );
        let _ = self.status_tx.send(Status::Queued);
    }
}
