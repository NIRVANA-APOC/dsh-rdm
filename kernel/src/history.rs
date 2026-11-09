//! Persistent per-task download-data recording (0.2.1).
//!
//! Real session data exposed the gap this module closes: the kernel held up to
//! 3000 speed samples in memory (`samples=1907` for one task) but exposed only
//! aggregates and the last 30 events, and nothing was persisted, so a session
//! could only reconstruct throughput by sampling `rdm_tasks` by hand.
//!
//! One task gets two append-only JSONL files under `<dataDir>/history/`:
//!
//! * `<taskId>.samples.jsonl` — one record per reporter sample (≤ 10/s):
//!   epoch millis, cumulative bytes, instantaneous + window rates, active/peak
//!   workers, stalled milliseconds.
//! * `<taskId>.events.jsonl` — the same diagnostic events `get` returns
//!   (probe/plan/controller/retry/…), redacted and with their epoch time.
//!
//! Recording is advisory: write errors are logged once and never fail or slow a
//! transfer. Files append across pause/resume/retry so one task id is one
//! timeline across a whole resume chain.

use crate::klog;
use crate::protocol::now_ms;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Directory under the kernel data dir that holds the JSONL recordings.
pub const HISTORY_DIR: &str = "history";
/// Hard cap for one task's sample timeline (≈ 2.8 h at the 100 ms cadence).
pub const MAX_RECORDED_SAMPLES: u64 = 100_000;
/// How many plan/build meta records the reader returns (one per run).
pub const MAX_META_RECORDS: usize = 20;
/// Flush buffered records at least this often.
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(1);
/// Write buffer per file; records are tiny but frequent.
const WRITE_BUFFER_BYTES: usize = 64 * 1024;

/// One recorded throughput sample. Field names are the documented JSONL keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleRecord {
    pub t: u64,
    /// Absolute progress written to the `.part` file (includes resumed bytes).
    pub bytes: u64,
    /// Bytes transferred by this run only (0 at the start of a resumed run).
    #[serde(default)]
    pub transferred: u64,
    pub bps: u64,
    pub w1_bps: Option<u64>,
    pub w5_bps: Option<u64>,
    pub w30_bps: Option<u64>,
    pub w300_bps: Option<u64>,
    pub workers: usize,
    pub peak_workers: usize,
    pub stalled_ms: u64,
}

/// One run's build/plan attribution record, written once per plan phase at the
/// top of the task's sample timeline. A task resumed by a later kernel build
/// appends another meta record, so one JSONL file explains which build produced
/// which slice of samples (the 20261109 session spanned two builds that both
/// reported `1.1.0`, making its series unattributable).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaRecord {
    pub kind: String,
    pub t: u64,
    pub kernel_version: String,
    pub pid: u32,
    pub task_id: String,
    /// Monotonic run generation inside one kernel process (1-based).
    pub run: u64,
    pub phase: String,
    /// Query values are redacted before recording.
    pub url: String,
    pub file_name: String,
    pub total_bytes: Option<u64>,
    pub chunk_size: Option<u64>,
    pub chunks: Option<u64>,
    pub requested_connections: usize,
    pub initial_workers: usize,
    pub max_connections: usize,
    pub resumed_bytes: u64,
    pub resume_decision: String,
    pub resume_reason: Option<String>,
}

impl MetaRecord {
    /// Compact build tag used by the `history` projection/`rdm_history` receipt.
    pub fn build_tag(&self) -> String {
        format!("{}@{}", self.kernel_version, self.pid)
    }
}

/// One recorded diagnostic event (mirrors `TaskEvent` plus its stable time).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub t: u64,
    pub seq: u64,
    pub kind: String,
    pub message: Option<String>,
    pub chunk: Option<u64>,
    pub attempt: Option<u32>,
    pub delay_ms: Option<u64>,
}

/// Marker appended once when the sample cap is reached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TruncationMarker {
    t: u64,
    truncated: bool,
    #[serde(default)]
    reason: Option<String>,
}

struct Sink {
    path: PathBuf,
    file: Option<BufWriter<File>>,
    written: u64,
    failed: bool,
    last_flush: Instant,
}

impl Sink {
    fn new(path: PathBuf) -> Self {
        Self { path, file: None, written: 0, failed: false, last_flush: Instant::now() }
    }

    fn open(&mut self) -> std::io::Result<&mut BufWriter<File>> {
        if self.file.is_none() {
            if let Some(parent) = self.path.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)?;
                }
            }
            let file = OpenOptions::new().create(true).append(true).open(&self.path)?;
            self.file = Some(BufWriter::with_capacity(WRITE_BUFFER_BYTES, file));
        }
        Ok(self.file.as_mut().expect("just opened"))
    }

    fn write_line<T: Serialize>(&mut self, record: &T) -> std::io::Result<()> {
        let mut line = serde_json::to_vec(record).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        line.push(b'\n');
        let sink = self.open()?;
        sink.write_all(&line)?;
        self.written += 1;
        Ok(())
    }

    fn flush_if_due(&mut self) {
        if self.last_flush.elapsed() >= FLUSH_INTERVAL {
            self.flush();
        }
    }

    fn flush(&mut self) {
        if let Some(file) = self.file.as_mut() {
            if let Err(error) = file.flush() {
                if !self.failed {
                    klog!(warn, "could not flush history {}: {error}", self.path.display());
                    self.failed = true;
                }
            }
        }
        self.last_flush = Instant::now();
    }
}

/// Owner-side recorder for one task. Shared with `Task`; all methods are
/// synchronous and non-failing by design.
pub struct HistoryWriter {
    task_id: String,
    samples: Mutex<Sink>,
    events: Mutex<Sink>,
    sample_count: AtomicU64,
    event_count: AtomicU64,
    meta_count: AtomicU64,
    truncated: AtomicBool,
    failed: AtomicBool,
}

impl HistoryWriter {
    /// Create the recorder for `task_id` under `dir`. Existing files (same task
    /// resumed by a later kernel generation) are appended to; the sample cap is
    /// re-counted on demand the first time a sample is written.
    pub fn new(dir: &Path, task_id: &str) -> Self {
        Self {
            task_id: task_id.to_string(),
            samples: Mutex::new(Sink::new(dir.join(format!("{task_id}.samples.jsonl")))),
            events: Mutex::new(Sink::new(dir.join(format!("{task_id}.events.jsonl")))),
            sample_count: AtomicU64::new(0),
            event_count: AtomicU64::new(0),
            meta_count: AtomicU64::new(0),
            truncated: AtomicBool::new(false),
            failed: AtomicBool::new(false),
        }
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn sample_path(&self) -> PathBuf {
        self.samples.lock().expect("history mutex poisoned").path.clone()
    }

    pub fn event_path(&self) -> PathBuf {
        self.events.lock().expect("history mutex poisoned").path.clone()
    }

    pub fn sample_count(&self) -> u64 {
        self.sample_count.load(Ordering::Relaxed)
    }

    pub fn event_count(&self) -> u64 {
        self.event_count.load(Ordering::Relaxed)
    }

    pub fn meta_count(&self) -> u64 {
        self.meta_count.load(Ordering::Relaxed)
    }

    /// Append one plan/build attribution record (before the run's samples).
    pub fn record_meta(&self, meta: &MetaRecord) {
        if self.failed.load(Ordering::Relaxed) {
            return;
        }
        let mut sink = self.samples.lock().expect("history mutex poisoned");
        match sink.write_line(meta) {
            Ok(()) => {
                self.meta_count.fetch_add(1, Ordering::Relaxed);
                sink.flush();
            }
            Err(error) => self.note_failure(error),
        }
    }

    pub fn truncated(&self) -> bool {
        self.truncated.load(Ordering::Relaxed)
    }

    fn note_failure(&self, error: std::io::Error) {
        if !self.failed.swap(true, Ordering::Relaxed) {
            klog!(warn, "history recording disabled after write error: {error}");
        }
    }

    pub fn record_sample(&self, sample: &SampleRecord) {
        if self.truncated.load(Ordering::Relaxed) || self.failed.load(Ordering::Relaxed) {
            return;
        }
        let mut sink = self.samples.lock().expect("history mutex poisoned");
        // A task resumed by a later kernel generation appends to its existing
        // file; seed the counter from what is already there so the cap is still
        // a per-task cap, not a per-process cap. A truncation marker from the
        // earlier generation stops recording immediately.
        if self.sample_count.load(Ordering::Relaxed) == 0 {
            let (existing, was_truncated) = scan_existing(&sink.path);
            if was_truncated {
                self.truncated.store(true, Ordering::Relaxed);
                return;
            }
            if existing > 0 {
                self.sample_count.store(existing, Ordering::Relaxed);
            }
        }
        if self.sample_count.load(Ordering::Relaxed) >= MAX_RECORDED_SAMPLES {
            self.truncated.store(true, Ordering::Relaxed);
            let marker = TruncationMarker { t: sample.t, truncated: true, reason: Some("sample-cap".to_string()) };
            let _ = sink.write_line(&marker);
            sink.flush();
            return;
        }
        match sink.write_line(sample) {
            Ok(()) => {
                self.sample_count.fetch_add(1, Ordering::Relaxed);
                sink.flush_if_due();
            }
            Err(error) => self.note_failure(error),
        }
    }

    pub fn record_event(&self, event: &EventRecord) {
        if self.failed.load(Ordering::Relaxed) {
            return;
        }
        let mut sink = self.events.lock().expect("history mutex poisoned");
        match sink.write_line(event) {
            Ok(()) => {
                self.event_count.fetch_add(1, Ordering::Relaxed);
                sink.flush_if_due();
            }
            Err(error) => self.note_failure(error),
        }
    }

    /// Flush both files (called periodically by the kernel background loop and
    /// forced at terminal transitions / shutdown).
    pub fn flush(&self) {
        self.samples.lock().expect("history mutex poisoned").flush();
        self.events.lock().expect("history mutex poisoned").flush();
    }
}

/// Bounded read of one task's recording, for the `history` RPC.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub samples: Vec<SampleRecord>,
    pub events: Vec<EventRecord>,
    /// Plan/build attribution records, oldest first (bounded to the last 20).
    pub meta: Vec<MetaRecord>,
    pub total_samples: u64,
    pub total_events: u64,
    pub truncated: bool,
    /// 1 = every sample returned; >1 = evenly downsampled by this stride.
    pub sample_stride: u64,
    pub offset: u64,
}

/// Read one task's recorded timeline.
///
/// * `limit` caps returned samples; when the recording holds more than `limit`
///   samples *and* `raw` is false, the series is evenly downsampled (first and
///   last samples always included) so a long transfer can be reviewed in one
///   bounded response. `raw` selects a literal page starting at `offset`.
/// * `events_limit` returns the most recent events (ring semantics).
pub fn read_page(dir: &Path, task_id: &str, offset: u64, limit: usize, raw: bool, events_limit: usize) -> HistoryPage {
    let samples_path = dir.join(format!("{task_id}.samples.jsonl"));
    let events_path = dir.join(format!("{task_id}.events.jsonl"));
    let mut page = HistoryPage::default();
    let mut all: Vec<(SampleRecord, bool)> = Vec::new();
    if let Ok(file) = File::open(&samples_path) {
        for line in BufReader::new(file).lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            if line.contains("\"kind\":\"meta\"") {
                if let Ok(meta) = serde_json::from_str::<MetaRecord>(&line) {
                    page.meta.push(meta);
                    if page.meta.len() > MAX_META_RECORDS {
                        page.meta.remove(0);
                    }
                }
                continue;
            }
            if let Ok(marker) = serde_json::from_str::<TruncationMarker>(&line) {
                if marker.truncated {
                    page.truncated = true;
                    continue;
                }
            }
            match serde_json::from_str::<SampleRecord>(&line) {
                Ok(record) => all.push((record, true)),
                Err(_) => continue,
            }
        }
    }
    page.total_samples = all.len() as u64;
    let limit = limit.max(1);
    if raw {
        let start = usize::try_from(offset).unwrap_or(usize::MAX).min(all.len());
        page.offset = start as u64;
        page.sample_stride = 1;
        page.samples = all.into_iter().skip(start).take(limit).map(|(record, _)| record).collect();
    } else if all.len() <= limit {
        page.sample_stride = 1;
        page.samples = all.into_iter().map(|(record, _)| record).collect();
    } else {
        // Evenly spaced indices, first and last included.
        let stride = (all.len() as f64 / limit as f64).ceil().max(2.0) as usize;
        page.sample_stride = stride as u64;
        let mut index = 0usize;
        while index < all.len() && page.samples.len() < limit {
            page.samples.push(all[index].0.clone());
            index += stride;
        }
        if let Some((last, _)) = all.last() {
            if page.samples.last().map(|record| record.t) != Some(last.t) {
                page.samples.push(last.clone());
            }
        }
    }
    let mut events: Vec<EventRecord> = Vec::new();
    if let Ok(file) = File::open(&events_path) {
        for line in BufReader::new(file).lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(record) = serde_json::from_str::<EventRecord>(&line) {
                events.push(record);
            }
        }
    }
    page.total_events = events.len() as u64;
    let keep = events_limit.max(1);
    if events.len() > keep {
        events.drain(..events.len() - keep);
    }
    page.events = events;
    page
}

/// Resolve the history directory for a kernel data dir (caller creates it).
pub fn history_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(HISTORY_DIR)
}

/// Count sample lines already on disk and whether the cap was reached before.
fn scan_existing(path: &Path) -> (u64, bool) {
    let Ok(file) = File::open(path) else { return (0, false) };
    let mut count = 0u64;
    let mut truncated = false;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        if line.contains("\"truncated\":true") {
            truncated = true;
            break;
        }
        if serde_json::from_str::<SampleRecord>(&line).is_ok() {
            count += 1;
        }
    }
    (count, truncated)
}

/// Convenience constructor for an event record stamped "now".
pub fn event_record(seq: u64, at_ms: u64, kind: &str, message: Option<String>, chunk: Option<u64>, attempt: Option<u32>, delay_ms: Option<u64>) -> EventRecord {
    EventRecord { t: if at_ms == 0 { now_ms() } else { at_ms }, seq, kind: kind.to_string(), message, chunk, attempt, delay_ms }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(t: u64, bytes: u64) -> SampleRecord {
        SampleRecord { t, bytes, transferred: bytes, bps: 0, w1_bps: None, w5_bps: None, w30_bps: None, w300_bps: None, workers: 0, peak_workers: 0, stalled_ms: 0 }
    }

    fn meta(kernel_version: &str, pid: u32, run: u64, resumed: u64) -> MetaRecord {
        MetaRecord {
            kind: "meta".into(),
            t: 1_000 + run,
            kernel_version: kernel_version.into(),
            pid,
            task_id: "t_test".into(),
            run,
            phase: "plan".into(),
            url: "https://cdn.example.com/a?token=<redacted>".into(),
            file_name: "a.bin".into(),
            total_bytes: Some(64),
            chunk_size: Some(8),
            chunks: Some(8),
            requested_connections: 4,
            initial_workers: 4,
            max_connections: 16,
            resumed_bytes: resumed,
            resume_decision: if resumed > 0 { "accepted" } else { "not-attempted" }.into(),
            resume_reason: if resumed > 0 { Some("etag".into()) } else { None },
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        crate::test_temp::dir(&format!("history-{name}"))
    }

    #[test]
    fn writes_and_reads_jsonl_records() {
        let dir = temp_dir("records");
        let writer = HistoryWriter::new(&dir, "t_test");
        writer.record_sample(&sample(1000, 10));
        writer.record_sample(&sample(1100, 20));
        writer.record_event(&event_record(1, 1000, "plan", Some("2 bytes".into()), None, None, None));
        writer.flush();
        assert_eq!(writer.sample_count(), 2);
        assert_eq!(writer.event_count(), 1);

        let page = read_page(&dir, "t_test", 0, 500, false, 200);
        assert_eq!(page.total_samples, 2);
        assert_eq!(page.total_events, 1);
        assert_eq!(page.samples[0].bytes, 10);
        assert_eq!(page.samples[1].bytes, 20);
        assert_eq!(page.events[0].kind, "plan");
        assert_eq!(page.sample_stride, 1);
        assert!(!page.truncated);

        // The file on disk is valid JSONL with the documented keys.
        let raw = std::fs::read_to_string(writer.sample_path()).expect("sample file");
        let first: serde_json::Value = serde_json::from_str(raw.lines().next().expect("line")).expect("json");
        assert_eq!(first["t"], 1000);
        assert_eq!(first["bytes"], 10);
        assert!(first.get("w1Bps").is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn downsamples_long_series_and_pages_raw() {
        let dir = temp_dir("downsample");
        let writer = HistoryWriter::new(&dir, "t_long");
        for index in 0..100 {
            writer.record_sample(&sample(1000 + index, index as u64));
        }
        writer.flush();
        let page = read_page(&dir, "t_long", 0, 10, false, 5);
        assert_eq!(page.total_samples, 100);
        assert!(page.samples.len() <= 11, "{}", page.samples.len());
        assert_eq!(page.samples.first().map(|record| record.bytes), Some(0));
        assert_eq!(page.samples.last().map(|record| record.bytes), Some(99));
        assert!(page.sample_stride > 1);
        let raw = read_page(&dir, "t_long", 40, 5, true, 5);
        assert_eq!(raw.samples.len(), 5);
        assert_eq!(raw.samples[0].bytes, 40);
        assert_eq!(raw.offset, 40);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn caps_samples_and_marks_truncation() {
        let dir = temp_dir("cap");
        let writer = HistoryWriter::new(&dir, "t_cap");
        // Pretend the previous kernel generation already wrote MAX-1 samples.
        writer.sample_count.store(MAX_RECORDED_SAMPLES - 1, Ordering::Relaxed);
        writer.record_sample(&sample(1, 1)); // last allowed sample
        writer.record_sample(&sample(2, 2)); // over cap -> marker, no record
        writer.record_sample(&sample(3, 3)); // ignored
        writer.record_event(&event_record(1, 0, "completed", None, None, None, None));
        writer.flush();
        assert_eq!(writer.sample_count(), MAX_RECORDED_SAMPLES);
        assert!(writer.truncated());
        assert_eq!(writer.event_count(), 1);
        let page = read_page(&dir, "t_cap", 0, 500, false, 10);
        assert!(page.truncated);
        // Only the one sample written in this process is on disk; the marker
        // records that the timeline stops before the true end.
        assert_eq!(page.total_samples, 1);
        let raw = std::fs::read_to_string(writer.sample_path()).expect("sample file");
        assert!(raw.contains("\"truncated\":true"), "{raw}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_files_yield_an_empty_page() {
        let dir = temp_dir("missing");
        let page = read_page(&dir, "t_none", 0, 10, false, 10);
        assert!(page.samples.is_empty());
        assert!(page.events.is_empty());
        assert_eq!(page.total_samples, 0);
        assert!(!page.truncated);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A task resumed by a later kernel generation appends to the same files;
    /// the cap must count what is already on disk, and a recorded truncation
    /// marker must stop the new generation from appending.
    #[test]
    fn resumed_generation_seeds_the_sample_cap_from_disk() {
        let dir = temp_dir("resumed");
        {
            let first = HistoryWriter::new(&dir, "t_resume");
            for index in 0..3 {
                first.record_sample(&sample(index, index as u64));
            }
            first.flush();
        }
        let second = HistoryWriter::new(&dir, "t_resume");
        assert_eq!(second.sample_count(), 0);
        second.record_sample(&sample(3, 3));
        assert_eq!(second.sample_count(), 4);
        second.flush();
        assert_eq!(read_page(&dir, "t_resume", 0, 100, false, 10).total_samples, 4);

        // Existing marker => recording is already exhausted.
        let raw_path = dir.join("t_resume.samples.jsonl");
        let mut raw = std::fs::read_to_string(&raw_path).expect("file");
        raw.push_str("{\"t\":99,\"truncated\":true,\"reason\":\"sample-cap\"}\n");
        std::fs::write(&raw_path, raw).expect("rewrite");
        let third = HistoryWriter::new(&dir, "t_resume");
        third.record_sample(&sample(4, 4));
        assert!(third.truncated());
        assert_eq!(third.sample_count(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Build attribution: one meta record per run, written before that run's
    /// samples; two builds resuming the same task produce two meta records in
    /// one file, and meta lines never count as samples.
    #[test]
    fn plan_meta_records_attribute_samples_to_builds() {
        let dir = temp_dir("meta");
        let writer = HistoryWriter::new(&dir, "t_meta");
        writer.record_meta(&meta("0.2.1", 100, 1, 0));
        writer.record_sample(&sample(1, 16));
        writer.record_sample(&sample(2, 32));
        writer.record_meta(&meta("0.2.2", 200, 2, 32));
        writer.record_sample(&sample(3, 48));
        writer.flush();
        assert_eq!(writer.meta_count(), 2);
        assert_eq!(writer.sample_count(), 3);

        let page = read_page(&dir, "t_meta", 0, 500, false, 200);
        assert_eq!(page.total_samples, 3, "meta lines must not count as samples");
        assert_eq!(page.meta.len(), 2);
        assert_eq!(page.meta[0].build_tag(), "0.2.1@100");
        assert_eq!(page.meta[1].build_tag(), "0.2.2@200");
        assert_eq!(page.meta[1].resumed_bytes, 32);
        assert_eq!(page.meta[1].resume_decision, "accepted");
        assert_eq!(page.meta[1].resume_reason.as_deref(), Some("etag"));
        // Old history files without meta lines still read (empty meta list).
        let legacy_dir = temp_dir("meta-legacy");
        {
            let legacy = HistoryWriter::new(&legacy_dir, "t_legacy");
            legacy.record_sample(&sample(1, 1));
            legacy.flush();
        }
        let legacy_page = read_page(&legacy_dir, "t_legacy", 0, 10, false, 10);
        assert!(legacy_page.meta.is_empty());
        assert_eq!(legacy_page.total_samples, 1);
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(legacy_dir);
    }
}
