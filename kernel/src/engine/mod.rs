pub mod chunked;
pub mod single;
use crate::error::{EngineError, EngineResult};
use crate::filename;
use crate::http;
use crate::probe;
use crate::protocol::{ErrorInfo, OriginFacts, Spec};
use crate::state;
use crate::task::{Control, StopKind, Task};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::{interval, timeout, MissedTickBehavior};
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
pub const STALL_TIMEOUT: Duration = Duration::from_secs(30);
/// Near the end of a transfer the remaining claims are long-tail connections,
/// so a dead one should be retried sooner than mid-transfer (session data: the
/// finish worker tail was 9→3→2→1). The shorter deadline only applies once the
/// missing tail is small, so a genuinely slow-but-alive connection is not
/// killed while there is plenty of work left.
pub const TAIL_STALL_TIMEOUT: Duration = Duration::from_secs(10);
pub const FINAL_STALL_TIMEOUT: Duration = Duration::from_secs(5);
/// Tail claims (remaining work ≤ target workers) get a short deadline and fast
/// retries: the 20261109 run showed the last chunks waiting 10 s twice at the
/// very end while the rest of the transfer was already finished.
pub const TAIL_CLAIM_STALL_TIMEOUT: Duration = Duration::from_secs(3);
pub const TAIL_RETRY_BASE: Duration = Duration::from_millis(250);
pub const TAIL_RETRY_MAX: Duration = Duration::from_secs(1);
/// Largest per-worker write buffer. Writes are dispatched to the blocking pool
/// one at a time, so a 256 KiB buffer spends a measurable share of a transfer
/// inside that hand-off; 1 MiB cuts the dispatch count 4x at a bounded memory
/// cost (1 MiB per worker, 128 MiB at the 128-connection cap; the default
/// 8-connection profile uses 8 MiB).
pub const WRITE_BUFFER_BYTES: usize = 1024 * 1024;
pub const MIN_WRITE_BUFFER_BYTES: usize = 256 * 1024;
pub const SAVE_INTERVAL: Duration = Duration::from_millis(500);

/// Stall deadline for the current fraction of the transfer.
pub fn stall_timeout_for(written: u64, total: u64) -> Duration {
    if total == 0 {
        return STALL_TIMEOUT;
    }
    let percent = (written.min(total) as f64 / total as f64) * 100.0;
    if percent >= 97.0 {
        FINAL_STALL_TIMEOUT
    } else if percent >= 90.0 {
        TAIL_STALL_TIMEOUT
    } else {
        STALL_TIMEOUT
    }
}

/// Retry delay for a tail claim: 250 ms × attempt, capped at 1 s, so the last
/// few chunks do not sit through exponential backoff while everything else is
/// done.
pub fn tail_retry_delay(attempt: u32) -> Duration {
    TAIL_RETRY_BASE.saturating_mul(attempt.max(1)).min(TAIL_RETRY_MAX)
}

/// Write buffer for one claim: a quarter of the chunk size, bounded to
/// [256 KiB, 1 MiB], so small chunks do not allocate a full megabyte each.
pub fn write_buffer_bytes(chunk_size: u64) -> usize {
    let quarter = (chunk_size / 4).max(1);
    usize::try_from(quarter).unwrap_or(WRITE_BUFFER_BYTES).clamp(MIN_WRITE_BUFFER_BYTES, WRITE_BUFFER_BYTES)
}
pub enum EngineOutcome {
    Completed { sha256: Option<String> },
    Paused,
    Cancelled,
    Failed(ErrorInfo),
}
#[derive(Default)]
pub struct Counters {
    pub downloaded: AtomicU64,
    pub net_rx: AtomicU64,
    pub active: AtomicUsize,
    pub peak: AtomicUsize,
    pub active_nanos: AtomicU64,
    pub retries: AtomicU64,
}
impl Counters {
    pub fn downloaded(&self) -> u64 {
        self.downloaded.load(Ordering::Relaxed)
    }
    pub fn add_downloaded(&self, bytes: u64) {
        self.downloaded.fetch_add(bytes, Ordering::Relaxed);
    }
    pub fn sub_downloaded(&self, bytes: u64) {
        if bytes > 0 {
            self.downloaded.fetch_sub(bytes, Ordering::Relaxed);
        }
    }
    pub fn net_rx(&self) -> u64 {
        self.net_rx.load(Ordering::Relaxed)
    }
    pub fn add_net_rx(&self, bytes: u64) {
        self.net_rx.fetch_add(bytes, Ordering::Relaxed);
    }
    pub fn active(&self) -> usize {
        self.active.load(Ordering::Relaxed)
    }
    pub fn peak(&self) -> usize {
        self.peak.load(Ordering::SeqCst)
    }
    pub fn retries(&self) -> u64 {
        self.retries.load(Ordering::Relaxed)
    }
    pub fn note_retry(&self) {
        self.retries.fetch_add(1, Ordering::Relaxed);
    }
    pub fn active_nanos(&self) -> u64 {
        self.active_nanos.load(Ordering::Relaxed)
    }
    pub fn try_enter(&self, target: usize) -> bool {
        let mut active = self.active.load(Ordering::SeqCst);
        loop {
            if active >= target {
                return false;
            }
            match self.active.compare_exchange(active, active + 1, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => {
                    self.peak.fetch_max(active + 1, Ordering::SeqCst);
                    return true;
                }
                Err(current) => active = current,
            }
        }
    }
    pub fn leave(&self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}
pub struct Slot {
    counters: Arc<Counters>,
    started: Instant,
}
impl Drop for Slot {
    fn drop(&mut self) {
        self.counters.leave();
        let nanos = self.started.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64;
        self.counters.active_nanos.fetch_add(nanos, Ordering::Relaxed);
    }
}
pub struct Reporter {
    stop: Arc<Notify>,
    handle: JoinHandle<()>,
}
impl Reporter {
    /// Reused reporter tick (≤ 100 ms): samples cumulative bytes into the
    /// task's bounded speed ring and updates EWMA/peak/telemetry. `baseline` is
    /// the byte count adopted by resume at run start; rate metrics are computed
    /// from `downloaded - baseline` so a resumed task starts cold. No extra
    /// timers are created and idle tasks have no reporter running.
    pub fn start(task: Arc<Task>, counters: Arc<Counters>, total: Option<u64>, baseline: u64) -> Self {
        let stop = Arc::new(Notify::new());
        let wait = Arc::clone(&stop);
        let handle = tokio::spawn(async move {
            let mut ticker = interval(PROGRESS_INTERVAL);
            ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
            ticker.tick().await;
            loop {
                tokio::select! {
                    _ = wait.notified() => break,
                    _ = ticker.tick() => {}
                }
                let downloaded = counters.downloaded();
                task.report(downloaded, downloaded.saturating_sub(baseline), total, counters.active(), counters.peak());
            }
        });
        Self { stop, handle }
    }
    pub async fn stop(self) {
        self.stop.notify_waiters();
        let _ = timeout(Duration::from_secs(1), self.handle).await;
    }
}
pub fn control_error(control: &Control) -> Option<EngineError> {
    match control.stop_kind() {
        Some(StopKind::Paused) => Some(EngineError::Paused),
        Some(StopKind::Cancelled) => Some(EngineError::Cancelled),
        None => None,
    }
}
pub async fn run(task: Arc<Task>, origin: Option<OriginFacts>) -> EngineOutcome {
    let spec = task.spec();
    match run_inner(&task, &spec, origin).await {
        Ok(sha256) => EngineOutcome::Completed { sha256 },
        Err(EngineError::Paused) => EngineOutcome::Paused,
        Err(EngineError::Cancelled) => EngineOutcome::Cancelled,
        Err(EngineError::Failed(info)) => EngineOutcome::Failed(info),
    }
}
async fn run_inner(task: &Arc<Task>, spec: &Spec, origin: Option<OriginFacts>) -> EngineResult<Option<String>> {
    let control = task.control();
    let client = http::client_for_spec(spec)?;
    let probe_client = http::probe_client_for_spec(spec)?;
    task.set_status(crate::protocol::Status::Probing);
    task.add_event("probe", Some(format!("probing {}", spec.url)), None, None, None);
    if let Some(error) = control_error(&control) {
        return Err(error);
    }
    let outcome = probe::probe_spec(&probe_client, spec, origin).await?;
    let meta = outcome.meta;
    task.set_probe_ms(outcome.facts.timing.probe_ms);
    task.set_server(&outcome.facts);
    task.add_event(
        "probe",
        Some(format!("{} bytes, ranges={}, type={}", meta.total_bytes.map(|value| value.to_string()).unwrap_or_else(|| "unknown".to_string()), meta.supports_ranges, meta.content_type.as_deref().unwrap_or("unknown"),)),
        None,
        None,
        None,
    );
    tokio::fs::create_dir_all(&spec.dir).await.map_err(|error| EngineError::io(format!("{}: {error}", spec.dir.display())))?;
    let desired = spec.file_name.clone().unwrap_or_else(|| meta.file_name.clone());
    let (target, file_name) = filename::resolve_target(&spec.dir, &desired, spec.resume);
    let part = state::part_path(&target);
    let state_path = state::state_path(&target);
    task.set_target(&spec.dir, &file_name, &target);
    if let Some(error) = control_error(&control) {
        return Err(error);
    }
    match meta.total_bytes {
        Some(total) if meta.supports_ranges && !spec.single_stream => chunked::run(task, spec, &client, &meta, total, &target, &part, &state_path).await,
        total => single::run(task, spec, &client, &meta, total, &target, &part, &state_path).await,
    }
}
pub async fn finalize(task: &Arc<Task>, spec: &Spec, part: &Path, state_path: &Path, target: &Path, total: Option<u64>) -> EngineResult<Option<String>> {
    task.begin_finalize();
    let metadata = tokio::fs::metadata(part).await.map_err(|error| EngineError::io(format!("{}: {error}", part.display())))?;
    if let Some(total) = total {
        if metadata.len() != total {
            return Err(EngineError::remote_changed(format!("file size {} does not match advertised {total}", metadata.len())));
        }
    }
    if spec.fsync_on_complete {
        sync_all(part).await?;
    }
    let sha256 = match spec.expected_sha256.as_deref() {
        Some(expected) => {
            task.add_event("verify", Some("hashing file for sha256".to_string()), None, None, None);
            let actual = sha256_file(part).await?;
            if !actual.eq_ignore_ascii_case(expected) {
                let _ = tokio::fs::remove_file(part).await;
                let _ = tokio::fs::remove_file(state_path).await;
                return Err(EngineError::checksum(expected, &actual));
            }
            Some(actual)
        }
        None => None,
    };
    tokio::fs::rename(part, target).await.map_err(|error| EngineError::io(format!("could not finalize target: {error}")))?;
    let _ = tokio::fs::remove_file(state_path).await;
    task.end_finalize();
    Ok(sha256)
}
pub async fn prepare_part(part: &Path, total: u64) -> EngineResult<()> {
    let file = tokio::fs::OpenOptions::new().create(true).write(true).truncate(false).open(part).await.map_err(|error| EngineError::io(format!("{}: {error}", part.display())))?;
    file.set_len(total).await.map_err(|error| EngineError::io(format!("could not size {}: {error}", part.display())))?;
    Ok(())
}
pub async fn sync_all(path: &Path) -> EngineResult<()> {
    let file = tokio::fs::OpenOptions::new().read(true).write(true).open(path).await.map_err(|error| EngineError::io(format!("{}: {error}", path.display())))?;
    file.sync_all().await.map_err(|error| EngineError::io(format!("sync {}: {error}", path.display())))
}
pub async fn sha256_file(path: &Path) -> EngineResult<String> {
    use sha2::{Digest, Sha256};
    let mut file = tokio::fs::File::open(path).await.map_err(|error| EngineError::io(format!("{}: {error}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; WRITE_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer).await.map_err(|error| EngineError::io(format!("hash read: {error}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_stall_timeout_shortens_near_completion() {
        assert_eq!(stall_timeout_for(0, 1000), STALL_TIMEOUT);
        assert_eq!(stall_timeout_for(500, 1000), STALL_TIMEOUT);
        assert_eq!(stall_timeout_for(900, 1000), TAIL_STALL_TIMEOUT);
        assert_eq!(stall_timeout_for(969, 1000), TAIL_STALL_TIMEOUT);
        assert_eq!(stall_timeout_for(970, 1000), FINAL_STALL_TIMEOUT);
        assert_eq!(stall_timeout_for(1000, 1000), FINAL_STALL_TIMEOUT);
        // Unknown total (single stream) keeps the conservative deadline.
        assert_eq!(stall_timeout_for(0, 0), STALL_TIMEOUT);
    }

    #[test]
    fn write_buffer_sizes_follow_the_chunk() {
        assert_eq!(write_buffer_bytes(crate::protocol::MIN_CHUNK_SIZE), MIN_WRITE_BUFFER_BYTES);
        assert_eq!(write_buffer_bytes(8 * 1024 * 1024), WRITE_BUFFER_BYTES);
        assert_eq!(write_buffer_bytes(1024), MIN_WRITE_BUFFER_BYTES);
    }

    #[test]
    fn tail_retry_delays_are_fast_and_bounded() {
        assert_eq!(tail_retry_delay(1), Duration::from_millis(250));
        assert_eq!(tail_retry_delay(2), Duration::from_millis(500));
        assert_eq!(tail_retry_delay(3), Duration::from_millis(750));
        assert_eq!(tail_retry_delay(4), Duration::from_secs(1));
        assert_eq!(tail_retry_delay(99), Duration::from_secs(1));
        assert_eq!(tail_retry_delay(0), Duration::from_millis(250));
        assert_eq!(TAIL_CLAIM_STALL_TIMEOUT, Duration::from_secs(3));
    }
}
