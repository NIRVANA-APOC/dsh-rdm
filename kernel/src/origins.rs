//! Bounded per-host origin ledger `<data-dir>/origins.json` (§2.1, §2.5, §5.4).
//!
//! The ledger remembers whether a host actually delivers: attempts, completed
//! transfers, a rolling median of successful throughput and the last error.
//! It is advisory (an agent hint), so a corrupt or absent file degrades to an
//! empty ledger instead of failing the kernel.

use crate::klog;
use crate::protocol::{now_ms, OriginFacts, ORIGIN_LEDGER_MAX_HOSTS};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const LEDGER_VERSION: u32 = 1;
/// Bounded per-host throughput history used for `medianBps`.
const RECENT_BPS_CAP: usize = 16;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OriginEntry {
    pub host: String,
    pub attempts: u64,
    pub completed: u64,
    pub failed: u64,
    pub last_error: Option<String>,
    pub last_at: u64,
    pub recent_bps: Vec<u64>,
    pub best_bps: Option<u64>,
}

impl OriginEntry {
    fn observation(&self) -> OriginFacts {
        OriginFacts { known: true, attempts: self.attempts, completed: self.completed, median_bps: self.median_bps(), best_bps: self.best_bps, last_error: self.last_error.clone(), last_at: Some(self.last_at) }
    }

    fn median_bps(&self) -> Option<u64> {
        if self.recent_bps.is_empty() {
            return None;
        }
        let mut values = self.recent_bps.clone();
        values.sort_unstable();
        Some(values[(values.len() - 1) / 2])
    }

    fn record(&mut self, completed: bool, error: Option<String>, bps: Option<u64>, at: u64) {
        self.attempts = self.attempts.saturating_add(1);
        if completed {
            self.completed = self.completed.saturating_add(1);
        } else {
            self.failed = self.failed.saturating_add(1);
        }
        if error.is_some() {
            self.last_error = error;
        }
        if let Some(bps) = bps {
            if bps > 0 {
                self.recent_bps.push(bps);
                if self.recent_bps.len() > RECENT_BPS_CAP {
                    let excess = self.recent_bps.len() - RECENT_BPS_CAP;
                    self.recent_bps.drain(..excess);
                }
                self.best_bps = Some(self.best_bps.map_or(bps, |best| best.max(bps)));
            }
        }
        self.last_at = at;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LedgerFile {
    version: u32,
    hosts: BTreeMap<String, OriginEntry>,
}

impl Default for LedgerFile {
    fn default() -> Self {
        Self { version: LEDGER_VERSION, hosts: BTreeMap::new() }
    }
}

pub struct OriginLedger {
    path: PathBuf,
    state: Mutex<LedgerFile>,
    save_lock: tokio::sync::Mutex<()>,
    /// Coalescing flag: at most one queued/in-flight background save.
    save_pending: AtomicBool,
}

impl OriginLedger {
    /// Load synchronously at kernel start. Absent, corrupt, or future-version
    /// files are ignored (warn once, keep an empty ledger).
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("origins.json");
        let mut file = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<LedgerFile>(&bytes) {
                Ok(file) if file.version == LEDGER_VERSION => file,
                Ok(file) => {
                    klog!(warn, "ignoring origin ledger version {} at {}", file.version, path.display());
                    LedgerFile::default()
                }
                Err(error) => {
                    klog!(warn, "ignoring corrupt origin ledger {}: {error}", path.display());
                    LedgerFile::default()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => LedgerFile::default(),
            Err(error) => {
                klog!(warn, "could not read origin ledger {}: {error}", path.display());
                LedgerFile::default()
            }
        };
        if file.hosts.len() > ORIGIN_LEDGER_MAX_HOSTS {
            let excess = file.hosts.len() - ORIGIN_LEDGER_MAX_HOSTS;
            evict_oldest(&mut file.hosts, excess);
        }
        Self { path, state: Mutex::new(file), save_lock: tokio::sync::Mutex::new(()), save_pending: AtomicBool::new(false) }
    }

    pub fn facts(&self, host: &str) -> Option<OriginFacts> {
        if host.is_empty() {
            return None;
        }
        let state = self.state.lock().expect("origin ledger mutex poisoned");
        state.hosts.get(host).map(OriginEntry::observation)
    }

    pub fn host_count(&self) -> usize {
        self.state.lock().expect("origin ledger mutex poisoned").hosts.len()
    }

    /// Record one finished attempt. Called on terminal transitions only, so an
    /// active transfer does not churn the file.
    pub fn record(&self, host: &str, completed: bool, error: Option<&str>, bps: Option<u64>) {
        if host.is_empty() {
            return;
        }
        let mut state = self.state.lock().expect("origin ledger mutex poisoned");
        let entry = state.hosts.entry(host.to_string()).or_insert_with(|| OriginEntry { host: host.to_string(), ..OriginEntry::default() });
        entry.record(completed, error.map(str::to_string), bps, now_ms());
        if state.hosts.len() > ORIGIN_LEDGER_MAX_HOSTS {
            let excess = state.hosts.len() - ORIGIN_LEDGER_MAX_HOSTS;
            evict_oldest(&mut state.hosts, excess);
        }
    }

    /// Atomic replace, serialized so concurrent saves cannot interleave a temp
    /// file. Best-effort: ledger persistence never fails a download. Callers on
    /// the download critical path should use `request_save` instead.
    pub async fn save(&self) {
        let _guard = self.save_lock.lock().await;
        self.write_locked().await;
    }

    /// Coalesced background persist, off the download critical path.
    ///
    /// `probe.origin`/`stats.origins` read the *in-memory* ledger, which is
    /// already updated synchronously by `record`, so the terminal transition
    /// must not wait for this write. The ledger is advisory history, not
    /// durability-critical: a crash between the status transition and the
    /// write loses at most this save interval's delta and the next terminal
    /// transition (or shutdown) rewrites the file.
    ///
    /// At most one save is queued: `save_pending` makes concurrent terminal
    /// transitions collapse into one writer, and the queued save snapshots the
    /// state after taking `save_lock`, so a skipped request is never lost
    /// (last writer wins).
    pub fn request_save(self: &Arc<Self>) {
        if self.save_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            // Defensive: only async kernel paths request background saves.
            self.save_pending.store(false, Ordering::SeqCst);
            klog!(warn, "origin ledger save skipped: no async runtime");
            return;
        };
        let ledger = Arc::clone(self);
        handle.spawn(async move {
            ledger.save_queued().await;
        });
    }

    async fn save_queued(&self) {
        let _guard = self.save_lock.lock().await;
        // Clear the flag before snapshotting: a record that lands after this
        // point schedules another save (the flag is false), while every record
        // before it is already in the snapshot.
        self.save_pending.store(false, Ordering::SeqCst);
        self.write_locked().await;
    }

    async fn write_locked(&self) {
        let data = {
            let state = self.state.lock().expect("origin ledger mutex poisoned");
            match serde_json::to_vec(&*state) {
                Ok(data) => data,
                Err(error) => {
                    klog!(warn, "could not serialize origin ledger: {error}");
                    return;
                }
            }
        };
        let tmp = self.path.with_extension("json.tmp");
        if let Err(error) = tokio::fs::write(&tmp, &data).await {
            klog!(warn, "could not write origin ledger: {error}");
            return;
        }
        if let Err(error) = tokio::fs::rename(&tmp, &self.path).await {
            klog!(warn, "could not replace origin ledger: {error}");
        }
    }
}

/// Drop the least recently touched hosts first; the ledger is a hint, not a
/// history archive.
fn evict_oldest(hosts: &mut BTreeMap<String, OriginEntry>, mut excess: usize) {
    while excess > 0 && !hosts.is_empty() {
        let oldest = hosts.iter().min_by_key(|(_, entry)| entry.last_at).map(|(host, _)| host.clone());
        let Some(oldest) = oldest else { break };
        hosts.remove(&oldest);
        excess -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rdm-kernel-origins-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn records_and_exposes_origin_facts() {
        let dir = temp_dir("facts");
        let ledger = OriginLedger::load(&dir);
        assert!(ledger.facts("example.com").is_none());
        ledger.record("example.com", true, None, Some(1_000_000));
        ledger.record("example.com", true, None, Some(3_000_000));
        ledger.record("example.com", false, Some("network"), None);
        let facts = ledger.facts("example.com").expect("known");
        assert!(facts.known);
        assert_eq!(facts.attempts, 3);
        assert_eq!(facts.completed, 2);
        assert_eq!(facts.median_bps, Some(1_000_000));
        assert_eq!(facts.best_bps, Some(3_000_000));
        assert_eq!(facts.last_error.as_deref(), Some("network"));
        assert_eq!(ledger.host_count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_ledger_is_ignored() {
        let dir = temp_dir("corrupt");
        std::fs::write(dir.join("origins.json"), b"{not json").unwrap();
        let ledger = OriginLedger::load(&dir);
        assert_eq!(ledger.host_count(), 0);
        assert!(ledger.facts("example.com").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ledger_is_bounded_and_evicts_oldest() {
        let dir = temp_dir("bounded");
        let ledger = OriginLedger::load(&dir);
        for index in 0..(ORIGIN_LEDGER_MAX_HOSTS + 10) {
            ledger.record(&format!("host{index}.example.com"), true, None, Some(1));
        }
        assert_eq!(ledger.host_count(), ORIGIN_LEDGER_MAX_HOSTS);
        // The first hosts were evicted, recent hosts survived.
        assert!(ledger.facts("host0.example.com").is_none());
        assert!(ledger.facts(&format!("host{}.example.com", ORIGIN_LEDGER_MAX_HOSTS + 9)).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn saves_and_reloads_atomically() {
        let dir = temp_dir("save");
        let ledger = OriginLedger::load(&dir);
        ledger.record("cdn.example.com", true, None, Some(2_000_000));
        ledger.save().await;
        assert!(dir.join("origins.json").is_file());
        assert!(!dir.join("origins.json.tmp").exists());
        let reloaded = OriginLedger::load(&dir);
        let facts = reloaded.facts("cdn.example.com").expect("known after reload");
        assert_eq!(facts.attempts, 1);
        assert_eq!(facts.best_bps, Some(2_000_000));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn coalesced_background_saves_cover_every_record() {
        let dir = temp_dir("coalesce");
        let ledger = Arc::new(OriginLedger::load(&dir));
        for index in 0..3 {
            ledger.record(&format!("host{index}.example.com"), true, None, Some(1_000 * (index + 1) as u64));
            ledger.request_save();
        }
        // The advisory write is a background task: poll for it instead of
        // assuming it completed, then verify no record was coalesced away.
        let path = dir.join("origins.json");
        let deadline = Instant::now() + Duration::from_secs(3);
        while !path.is_file() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(path.is_file(), "background origin ledger save did not run");
        let reloaded = OriginLedger::load(&dir);
        assert_eq!(reloaded.host_count(), 3);
        for index in 0..3 {
            assert!(reloaded.facts(&format!("host{index}.example.com")).is_some(), "host{index} was coalesced away");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
