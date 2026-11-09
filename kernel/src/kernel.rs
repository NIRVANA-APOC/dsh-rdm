use crate::engine::{self, EngineOutcome};
use crate::error::EngineError;
use crate::error::EngineResult;
use crate::history::{self, HistoryPage, HistoryWriter};
use crate::http;
use crate::klog;
use crate::origins::OriginLedger;
use crate::probe;
use crate::protocol::{now_ms, Aggregate, Config, KernelInfo, ProbeParams, RequestSpec, Spec, Status, TaskDetail, TaskEvent, TaskRecord, TaskView, SIGNED_URL_EXPIRING_SECS};
use crate::state;
use crate::task::Task;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;
#[derive(Debug, Clone)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}
impl ApiError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_request", message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new("conflict", message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message)
    }
    pub fn protocol_mismatch(message: impl Into<String>) -> Self {
        Self::new("protocol_mismatch", message)
    }
}
impl From<EngineError> for ApiError {
    fn from(error: EngineError) -> Self {
        let info = error.info();
        Self { code: info.code, message: info.message }
    }
}
pub type Outbox = Option<std::sync::mpsc::Sender<String>>;
struct TaskTable {
    by_id: HashMap<String, Arc<Task>>,
    order: Vec<String>,
}
pub struct Kernel {
    data_dir: PathBuf,
    tasks_dir: PathBuf,
    /// `<dataDir>/history` — per-task JSONL download-data recordings (0.2.1).
    history_dir: PathBuf,
    info: KernelInfo,
    started: Instant,
    config: Mutex<Config>,
    init_done: AtomicBool,
    tasks: Mutex<TaskTable>,
    origins: Arc<OriginLedger>,
    outbox: Outbox,
    background_stop: Notify,
    status_notify: Arc<Notify>,
    shutting_down: AtomicBool,
    self_ref: OnceLock<std::sync::Weak<Kernel>>,
}
impl Kernel {
    pub fn new(data_dir: PathBuf, outbox: Outbox) -> EngineResult<Arc<Self>> {
        let tasks_dir = data_dir.join("tasks");
        std::fs::create_dir_all(&tasks_dir).map_err(|error| EngineError::io(format!("{}: {error}", tasks_dir.display())))?;
        let history_dir = history::history_dir(&data_dir);
        if let Err(error) = std::fs::create_dir_all(&history_dir) {
            // Recording is advisory; a read-only data dir must not stop downloads.
            klog!(warn, "could not create history dir {}: {error}", history_dir.display());
        }
        let origins = Arc::new(OriginLedger::load(&data_dir));
        let kernel = Arc::new(Self {
            info: KernelInfo::current(&data_dir.to_string_lossy()),
            tasks_dir,
            history_dir,
            origins,
            data_dir,
            started: Instant::now(),
            config: Mutex::new(Config::default()),
            init_done: AtomicBool::new(false),
            tasks: Mutex::new(TaskTable { by_id: HashMap::new(), order: Vec::new() }),
            outbox,
            background_stop: Notify::new(),
            status_notify: Arc::new(Notify::new()),
            shutting_down: AtomicBool::new(false),
            self_ref: OnceLock::new(),
        });
        let _ = kernel.self_ref.set(Arc::downgrade(&kernel));
        kernel.load_tasks()?;
        Ok(kernel)
    }
    pub fn info(&self) -> &KernelInfo {
        &self.info
    }
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
    pub fn config(&self) -> Config {
        self.config.lock().expect("config mutex poisoned").clone()
    }
    fn load_tasks(&self) -> EngineResult<()> {
        let mut records: Vec<TaskRecord> = Vec::new();
        let entries = match std::fs::read_dir(&self.tasks_dir) {
            Ok(entries) => entries,
            Err(error) => return Err(EngineError::io(format!("{}: {error}", self.tasks_dir.display()))),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            match std::fs::read(&path) {
                Ok(bytes) => match serde_json::from_slice::<TaskRecord>(&bytes) {
                    Ok(record) => records.push(record),
                    Err(error) => klog!(warn, "ignoring corrupt task record {}: {error}", path.display()),
                },
                Err(error) => klog!(warn, "could not read task record {}: {error}", path.display()),
            }
        }
        records.sort_by_key(|record| record.view.created_at);
        let mut table = self.tasks.lock().expect("tasks mutex poisoned");
        for record in records {
            let id = record.view.id.clone();
            if table.by_id.contains_key(&id) {
                continue;
            }
            table.order.push(id.clone());
            let task = Task::from_record(record, Arc::clone(&self.status_notify));
            self.attach_history(&task);
            table.by_id.insert(id, task);
        }
        Ok(())
    }
    /// Attach the per-task JSONL recorder. Failures degrade to "no recording"
    /// (each writer lazily creates its file on the first write).
    fn attach_history(&self, task: &Arc<Task>) {
        if task.history_writer().is_some() {
            return;
        }
        let writer = Arc::new(HistoryWriter::new(&self.history_dir, &task.id));
        task.attach_history(writer);
    }
    fn send(&self, value: Value) {
        if let Some(outbox) = &self.outbox {
            let _ = outbox.send(value.to_string());
        }
    }
    fn notify(&self, task: &Task) {
        // Notification frames carry exactly the flat TaskView (§2.2).
        self.send(json!({"event": "task", "task": task.view()}));
    }
    fn tasks_snapshot(&self) -> Vec<Arc<Task>> {
        let table = self.tasks.lock().expect("tasks mutex poisoned");
        table.order.iter().filter_map(|id| table.by_id.get(id).cloned()).collect()
    }
    fn task(&self, id: &str) -> Result<Arc<Task>, ApiError> {
        self.tasks.lock().expect("tasks mutex poisoned").by_id.get(id).cloned().ok_or_else(|| ApiError::not_found(format!("task {id} does not exist")))
    }
    async fn persist(&self, task: &Arc<Task>) {
        let record = task.record();
        let data = match serde_json::to_vec(&record) {
            Ok(data) => data,
            Err(error) => {
                klog!(warn, "could not serialize task: {error}");
                return;
            }
        };
        let path = self.tasks_dir.join(format!("{}.json", record.view.id));
        let tmp = path.with_extension("json.tmp");
        if let Err(error) = tokio::fs::write(&tmp, &data).await {
            klog!(warn, "could not persist task: {error}");
            return;
        }
        if let Err(error) = tokio::fs::rename(&tmp, &path).await {
            klog!(warn, "could not persist task: {error}");
        }
    }
    pub async fn run_background(self: Arc<Self>) {
        let mut ticker = tokio::time::interval(Duration::from_millis(250));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await;
        loop {
            tokio::select! {
                _ = self.background_stop.notified() => break,
                _ = ticker.tick() => {}
            }
            let now = Instant::now();
            for task in self.tasks_snapshot() {
                if task.take_notification(Duration::from_millis(500), now) {
                    self.notify(&task);
                }
                if task.take_persist(Duration::from_millis(1_000), now) {
                    self.persist(&task).await;
                }
                // Buffered history records (≤ 10 samples/s) are flushed once a
                // second without ever blocking the reporter.
                task.flush_history();
            }
        }
    }
    pub async fn initialize(&self, config: Config, protocol: Option<u32>) -> Result<Value, ApiError> {
        if let Some(protocol) = protocol {
            if protocol != crate::protocol::PROTOCOL {
                return Err(ApiError::protocol_mismatch(format!("kernel speaks protocol {} but the host requested {protocol}", crate::protocol::PROTOCOL)));
            }
        }
        let config = config.normalized();
        crate::log::set_level(&config.log_level);
        *self.config.lock().expect("config mutex poisoned") = config.clone();
        let first = !self.init_done.swap(true, Ordering::SeqCst);
        if first && config.auto_resume {
            let interrupted: Vec<Arc<Task>> = self.tasks_snapshot().into_iter().filter(|task| task.status() == Status::Interrupted && task.spec().resume).collect();
            for task in interrupted {
                self.resume(task, "auto-resume");
            }
        }
        Ok(json!({
            "protocol": crate::protocol::PROTOCOL,
            "kernel": self.info,
            "config": config,
        }))
    }
    pub async fn probe(&self, params: ProbeParams) -> Result<Value, ApiError> {
        let outcome = probe::probe_params(&params).await?;
        let mut facts = outcome.facts;
        let host = url::Url::parse(&facts.url).ok().and_then(|url| url.host_str().map(str::to_string)).unwrap_or_else(|| facts.host.clone());
        if !host.is_empty() {
            facts.host = host.clone();
        }
        facts.origin = self.origins.facts(&facts.host);
        // Never project credential-bearing query values to the host.
        Ok(json!({ "server": facts.redacted() }))
    }
    pub async fn start(&self, raw: RequestSpec) -> Result<Value, ApiError> {
        let config = self.config();
        let spec = Spec::resolve(raw, &config).map_err(ApiError::invalid)?;
        http::client_for_spec(&spec)?;
        tokio::fs::create_dir_all(&spec.dir).await.map_err(|error| ApiError::new("io", format!("{}: {error}", spec.dir.display())))?;
        let id = new_task_id();
        let task = Task::new(id, spec, Arc::clone(&self.status_notify));
        self.attach_history(&task);
        {
            let mut table = self.tasks.lock().expect("tasks mutex poisoned");
            table.order.push(task.id.clone());
            table.by_id.insert(task.id.clone(), Arc::clone(&task));
        }
        self.persist(&task).await;
        self.spawn_engine(&task);
        Ok(json!({ "task": task.view() }))
    }
    fn spawn_engine(&self, task: &Arc<Task>) {
        let (generation, _control) = task.begin_run();
        let kernel = self.self_arc();
        let origin = self.origins.facts(&task.spec().host());
        let task = Arc::clone(task);
        tokio::spawn(async move {
            let outcome = engine::run(Arc::clone(&task), origin).await;
            kernel.finish(&task, generation, outcome).await;
        });
    }
    fn self_arc(&self) -> Arc<Kernel> {
        self.self_ref.get().and_then(|weak| weak.upgrade()).expect("kernel self reference is initialized in `new`")
    }
    async fn finish(&self, task: &Arc<Task>, generation: u64, outcome: EngineOutcome) {
        if !task.end_run(generation) {
            return;
        }
        let status = match outcome {
            EngineOutcome::Completed { sha256 } => {
                if task.spec().expected_sha256.is_some() {
                    task.set_verified(Some(true));
                }
                task.set_sha256(sha256);
                Status::Completed
            }
            EngineOutcome::Paused => Status::Paused,
            EngineOutcome::Cancelled if self.shutting_down.load(Ordering::SeqCst) => Status::Interrupted,
            EngineOutcome::Cancelled => Status::Cancelled,
            EngineOutcome::Failed(info) => {
                if info.code == "checksum_mismatch" {
                    task.set_verified(Some(false));
                }
                task.set_error(info.clone());
                task.add_event("failed", Some(info.message), None, None, None);
                Status::Failed
            }
        };
        // Terminal transitions update the in-memory origin ledger *before* the
        // status becomes observable, so a host that has seen `completed` can
        // rely on `probe.origin`/`stats.origins` being current. The disk write
        // is advisory history, not durability-critical: it is coalesced and
        // spawned so a terminal transition never waits on I/O (this was a
        // measurable small-download regression).
        if status.is_terminal() {
            let view = task.view();
            let completed = status == Status::Completed;
            let error = match status {
                Status::Failed => view.error.as_ref().map(|info| info.code.clone()),
                Status::Cancelled => Some("cancelled".to_string()),
                _ => None,
            };
            let bps = completed.then_some(view.avg_bps).filter(|value| *value > 0);
            self.origins.record(&view.host, completed, error.as_deref(), bps);
            self.origins.request_save();
        }
        task.set_status(status);
        if status != Status::Failed {
            task.add_event(status.as_str(), Some(format!("download {}", status.as_str())), None, None, None);
        }
        // Terminal transition: make the recording durable before the host can
        // observe the terminal status and immediately read it via `history`.
        task.flush_history();
        self.persist(task).await;
        self.notify(task);
    }
    pub fn list(&self, statuses: Option<Vec<Status>>, session_id: Option<&str>, limit: usize) -> Value {
        let filtered: Vec<TaskView> = self
            .tasks_snapshot()
            .into_iter()
            .rev()
            .map(|task| task.view())
            .filter(|view| statuses.as_ref().is_none_or(|allowed| allowed.contains(&view.status)))
            .filter(|view| session_id.is_none_or(|session| view.session_id.as_deref() == Some(session)))
            .collect();
        let aggregate = aggregate_of(&filtered);
        let tasks: Vec<TaskView> = filtered.into_iter().take(limit).collect();
        json!({ "tasks": tasks, "aggregate": aggregate })
    }
    pub fn get(&self, id: &str, events: usize) -> Result<Value, ApiError> {
        let task = self.task(id)?;
        let view = task.view();
        let origin = self.origins.facts(&view.host);
        let mut detail: TaskDetail = task.detail(origin.as_ref());
        // The stored probe snapshot was taken at run start; refresh its ledger
        // block so the detail path reflects what the kernel has learned since.
        if let Some(server) = detail.server.as_mut() {
            server.origin = origin.clone();
        }
        let events: Vec<TaskEvent> = task.events(events);
        Ok(json!({ "task": view, "detail": detail, "events": events }))
    }
    /// `history` RPC (0.2.1): bounded read of one task's persisted download-data
    /// recording. Works for running tasks (the recorder is flushed first) and
    /// for tasks from earlier kernel generations (files are read from disk).
    pub fn history(&self, id: &str, offset: u64, limit: usize, raw: bool, include_events: bool, events_limit: usize) -> Result<Value, ApiError> {
        let task = self.task(id)?;
        task.flush_history();
        let page: HistoryPage = history::read_page(&self.history_dir, id, offset, limit, raw, events_limit);
        let sample_path = self.existing_history_path(id, "samples.jsonl");
        let event_path = self.existing_history_path(id, "events.jsonl");
        let events = if include_events { page.events } else { Vec::new() };
        let mut builds: Vec<String> = Vec::new();
        for meta in &page.meta {
            let tag = meta.build_tag();
            if !builds.contains(&tag) {
                builds.push(tag);
            }
        }
        Ok(json!({
            "taskId": id,
            "samplesPath": sample_path,
            "eventsPath": event_path,
            "samples": page.samples,
            "events": events,
            "meta": page.meta,
            "builds": builds,
            "totalSamples": page.total_samples,
            "totalEvents": page.total_events,
            "truncated": page.truncated,
            "sampleStride": page.sample_stride,
            "offset": page.offset,
        }))
    }
    fn existing_history_path(&self, id: &str, suffix: &str) -> Option<String> {
        let path = self.history_dir.join(format!("{id}.{suffix}"));
        path.exists().then(|| path.to_string_lossy().into_owned())
    }
    pub async fn wait(&self, ids: &[String], timeout_ms: u64) -> Result<Value, ApiError> {        let tasks = ids.iter().map(|id| self.task(id)).collect::<Result<Vec<_>, _>>()?;
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let views: Vec<TaskView> = tasks.iter().map(|task| task.view()).collect();
            let terminal = views.iter().all(|view| view.status.is_terminal());
            if terminal || Instant::now() >= deadline {
                return Ok(json!({ "tasks": views, "timedOut": !terminal }));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            // Wake on the next status transition instead of polling every 50 ms:
            // a terminal task is reported as soon as the engine finalizes it.
            let notified = self.status_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if tasks.iter().all(|task| task.status().is_terminal()) {
                continue;
            }
            tokio::select! {
                _ = notified => {}
                _ = tokio::time::sleep(remaining) => {}
            }
        }
    }
    pub async fn control(&self, id: &str, action: &str, delete_part: bool) -> Result<Value, ApiError> {
        let task = self.task(id)?;
        const ACTIVE: [Status; 3] = [Status::Queued, Status::Probing, Status::Running];
        const RESUMABLE: [Status; 4] = [Status::Paused, Status::Interrupted, Status::Cancelled, Status::Failed];
        match action {
            "pause" | "cancel" => {
                let pause = action == "pause";
                // Idempotent pause: a second pause on an already-paused task is
                // a no-op success instead of a conflict (agents retry controls).
                if pause && task.status() == Status::Paused {
                    return Ok(json!({ "task": task.view() }));
                }
                require_status(&task, if pause { &ACTIVE } else { &[ACTIVE[0], ACTIVE[1], ACTIVE[2], Status::Paused] }, action)?;
                if pause {
                    task.control().pause()
                } else {
                    task.control().cancel()
                };
                wait_for_status(&task, if pause { Status::Paused } else { Status::Cancelled }, Duration::from_millis(3000)).await;
                Ok(json!({ "task": task.view() }))
            }
            "resume" | "retry" => {
                // Idempotent resume: the engine may need a moment to observe a
                // pause, so "resume" on a still-active task returns the view
                // instead of failing with `cannot resume ... running`.
                if action == "resume" && task.status().is_active() {
                    return Ok(json!({ "task": task.view() }));
                }
                require_status(&task, &RESUMABLE, action)?;
                if action == "resume" {
                    self.resume(Arc::clone(&task), "resume");
                } else {
                    self.remove_part_files(&task).await;
                    task.reset_for_retry();
                    self.persist(&task).await;
                    self.spawn_engine(&task);
                }
                Ok(json!({ "task": task.view() }))
            }
            "remove" => {
                if ACTIVE.contains(&task.status()) {
                    task.control().cancel();
                    wait_for_status(&task, Status::Cancelled, Duration::from_millis(1500)).await;
                }
                if delete_part {
                    self.remove_part_files(&task).await
                }
                self.forget(id);
                let _ = tokio::fs::remove_file(self.tasks_dir.join(format!("{id}.json"))).await;
                Ok(json!({ "task": Value::Null }))
            }
            other => Err(ApiError::invalid(format!("unknown control action `{other}`"))),
        }
    }
    fn forget(&self, id: &str) {
        let mut table = self.tasks.lock().expect("tasks mutex poisoned");
        table.by_id.remove(id);
        table.order.retain(|existing| existing != id);
    }

    fn resume(&self, task: Arc<Task>, reason: &str) {
        task.add_event("resumed", Some(format!("resuming ({reason})")), None, None, None);
        task.set_status(Status::Queued);
        self.spawn_engine(&task);
    }
    async fn remove_part_files(&self, task: &Arc<Task>) {
        let view = task.view();
        let Some(path) = view.path else {
            return;
        };
        let target = PathBuf::from(path);
        let _ = tokio::fs::remove_file(state::part_path(&target)).await;
        let _ = tokio::fs::remove_file(state::state_path(&target)).await;
    }
    pub fn stats(&self) -> Value {
        let views: Vec<TaskView> = self.tasks_snapshot().iter().map(|task| task.view()).collect();
        let count = |status: Status| views.iter().filter(|view| view.status == status).count();
        let bytes: u64 = views.iter().map(|view| view.downloaded).sum();
        let uptime = self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        let throughput = throughput_of(&views);
        json!({
            "protocol": crate::protocol::PROTOCOL,
            "kernel": { "version": self.info.version, "pid": self.info.pid, "uptimeMs": uptime, "dataDir": self.info.data_dir },
            "tasks": { "total": views.len(), "queued": count(Status::Queued), "probing": count(Status::Probing), "running": count(Status::Running),
                "paused": count(Status::Paused), "completed": count(Status::Completed), "failed": count(Status::Failed),
                "cancelled": count(Status::Cancelled), "interrupted": count(Status::Interrupted) },
            "totals": { "bytesDownloaded": bytes, "downloadsCompleted": count(Status::Completed), "downloadsFailed": count(Status::Failed) },
            "throughput": {
                "nowBps": throughput.0,
                "w5Bps": throughput.1,
                "w30Bps": throughput.2,
                "w300Bps": throughput.3,
            },
            "origins": self.origins.host_count(),
            "config": self.config(),
        })
    }
    pub async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.background_stop.notify_waiters();
        let active: Vec<Arc<Task>> = self.tasks_snapshot().into_iter().filter(|task| matches!(task.status(), Status::Queued | Status::Probing | Status::Running)).collect();
        for task in &active {
            task.control().cancel();
        }
        let deadline = Instant::now() + Duration::from_millis(1000);
        while Instant::now() < deadline && active.iter().any(|task| task.is_running()) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        for task in &active {
            task.set_status(Status::Interrupted);
        }
        for task in self.tasks_snapshot() {
            task.flush_history();
            self.persist(&task).await;
        }
        self.origins.save().await;
        let _ = &self.data_dir;
    }
}
/// Aggregate strip for `list` (§2.4).
fn aggregate_of(views: &[TaskView]) -> Aggregate {
    let active = views.iter().filter(|view| view.status.is_active()).count();
    let paused = views.iter().filter(|view| view.status == Status::Paused).count();
    let failed = views.iter().filter(|view| view.status == Status::Failed).count();
    let completed = views.iter().filter(|view| view.status == Status::Completed).count();
    let bytes_downloaded: u64 = views.iter().map(|view| view.downloaded).sum();
    let live = views.iter().filter(|view| !view.status.is_terminal());
    let throughput = throughput_of(views);
    let now_ms = now_ms();
    let risk_count = views
        .iter()
        .filter(|view| !view.status.is_terminal())
        .filter(|view| {
            let signed_risky = view.signed_url_expires_at.is_some_and(|at| at <= now_ms.saturating_add(SIGNED_URL_EXPIRING_SECS as u64 * 1000));
            let tls_risky = view.tls_not_after.is_some_and(|at| at <= now_ms.saturating_add(crate::protocol::TLS_EXPIRING_SECS as u64 * 1000));
            let no_range = view.range_supported == Some(false);
            signed_risky || tls_risky || no_range
        })
        .count();
    let _ = live;
    Aggregate { total: views.len(), active, paused, failed, completed, bytes_downloaded, now_bps: throughput.0, w5_bps: throughput.1, w30_bps: throughput.2, w300_bps: throughput.3, risk_count }
}
/// Kernel-level throughput: sum of live task windows. `nowBps` is the summed
/// live EWMA (0 when idle); window sums are `null` when no live task has a
/// measured window.
fn throughput_of(views: &[TaskView]) -> (u64, Option<u64>, Option<u64>, Option<u64>) {
    let mut now = 0u64;
    let mut w5: Option<u64> = None;
    let mut w30: Option<u64> = None;
    let mut w300: Option<u64> = None;
    for view in views.iter().filter(|view| view.status.is_active()) {
        now = now.saturating_add(view.speed_bps);
        if let Some(rate) = view.speed5s_bps {
            w5 = Some(w5.unwrap_or(0).saturating_add(rate));
        }
        if let Some(rate) = view.speed30s_bps {
            w30 = Some(w30.unwrap_or(0).saturating_add(rate));
        }
        if let Some(rate) = view.speed300s_bps {
            w300 = Some(w300.unwrap_or(0).saturating_add(rate));
        }
    }
    (now, w5, w30, w300)
}
fn require_status(task: &Task, allowed: &[Status], action: &str) -> Result<(), ApiError> {
    let status = task.status();
    if allowed.contains(&status) {
        Ok(())
    } else {
        Err(ApiError::conflict(format!("cannot {action} task in status {}", status.as_str())))
    }
}

async fn wait_for_status(task: &Arc<Task>, wanted: Status, timeout: Duration) -> bool {
    let mut rx = task.subscribe();
    let deadline = Instant::now() + timeout;
    loop {
        if *rx.borrow() == wanted {
            return true;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let _ = tokio::time::timeout(remaining.min(Duration::from_millis(50)), rx.changed()).await;
    }
}
fn new_task_id() -> String {
    use sha2::{Digest, Sha256};
    use std::sync::atomic::AtomicU64;
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut hasher = Sha256::new();
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(now_ms().to_le_bytes());
    hasher.update(COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    let digest = hasher.finalize();
    format!("t_{}", hex::encode(&digest[..8]))
}
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum StatusFilter {
    One(String),
    Many(Vec<String>),
}
impl StatusFilter {
    pub fn parse(self) -> Result<Vec<Status>, ApiError> {
        let raw = match self {
            Self::One(value) => vec![value],
            Self::Many(values) => values,
        };
        raw.into_iter().map(|value| Status::parse(&value).ok_or_else(|| ApiError::invalid(format!("unknown status `{value}`")))).collect()
    }
}
pub fn error_value(error: &ApiError) -> Value {
    json!({"code": error.code, "message": error.message})
}
