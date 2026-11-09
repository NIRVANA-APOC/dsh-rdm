use crate::klog;
use crate::protocol::{url_identity, Meta};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
pub const STATE_VERSION: u32 = 1;

/// Outcome of matching a persisted `.part.json` against a fresh probe.
///
/// The reason strings are stable API (exposed as `resumeState.resumeReason`):
/// accepted codes `etag`, `last-modified`, `url`, `final-url`; rejected codes
/// `version-mismatch`, `size-mismatch`, `validators-mismatch`, `url-mismatch`,
/// `file-name-mismatch`, `ranges-invalid`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResumeOutcome {
    Accepted(&'static str),
    Rejected(&'static str),
}

impl ResumeOutcome {
    pub fn is_accepted(&self) -> bool {
        matches!(self, Self::Accepted(_))
    }

    pub fn reason(&self) -> &'static str {
        match self {
            Self::Accepted(reason) | Self::Rejected(reason) => reason,
        }
    }

    pub fn decision(&self) -> &'static str {
        if self.is_accepted() {
            "accepted"
        } else {
            "rejected"
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeState {
    pub version: u32,
    pub url: String,
    pub final_url: String,
    pub file_name: String,
    pub total_bytes: u64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub chunk_size: u64,
    pub completed_ranges: Vec<[u64; 2]>,
    pub downloaded_bytes: u64,
    /// Controller target at save time (0.2.2). Restored when a task is resumed
    /// so a transfer that had already discovered a good concurrency keeps it
    /// instead of starting over at the requested count.
    #[serde(default)]
    pub target_workers: Option<usize>,
    /// Query-stripped identity of `url` (0.2.1). Older states derive it on load.
    #[serde(default)]
    pub url_identity: Option<String>,
    /// Query-stripped identity of `final_url` (0.2.1). Older states derive it.
    #[serde(default)]
    pub final_url_identity: Option<String>,
    /// Source-independent content identity (0.3.0 multi-source): the same
    /// logical object fetched from a different mirror keeps this key, so a
    /// resumed task can switch sources without discarding completed ranges.
    #[serde(default)]
    pub content_key: Option<String>,
}

impl ResumeState {
    pub fn new(url: &str, meta: &Meta, total: u64, chunk_size: u64, ranges: Vec<(u64, u64)>, downloaded: u64) -> Self {
        Self {
            version: STATE_VERSION,
            url: url.to_string(),
            final_url: meta.final_url.clone(),
            file_name: meta.file_name.clone(),
            total_bytes: total,
            etag: meta.etag.clone(),
            last_modified: meta.last_modified.clone(),
            chunk_size,
            completed_ranges: merge_ranges(ranges).into_iter().map(|(start, end)| [start, end]).collect(),
            downloaded_bytes: downloaded,
            target_workers: None,
            url_identity: Some(url_identity(url)),
            final_url_identity: Some(url_identity(&meta.final_url)),
            content_key: None,
        }
    }

    /// Attach the source-independent content key (multi-source resume).
    pub fn with_content_key(mut self, content_key: Option<String>) -> Self {
        self.content_key = content_key;
        self
    }

    /// Multi-source resume decision: a shared content key wins over URL
    /// identity; a mismatch is a hard rejection (never splice two objects).
    /// When the legacy URL/validator path already accepts, its specific reason
    /// (`etag`, `url`, …) is preserved so existing receipts stay meaningful.
    pub fn is_compatible_with_content(&self, url: &str, meta: &Meta, total: u64, content_key: Option<&str>) -> ResumeOutcome {
        if let (Some(saved), Some(current)) = (self.content_key.as_deref(), content_key) {
            if saved != current {
                return ResumeOutcome::Rejected("validators-mismatch");
            }
            let legacy = self.is_compatible(url, meta, total);
            if let ResumeOutcome::Accepted(reason) = legacy {
                return ResumeOutcome::Accepted(reason);
            }
            // The selected mirror can have a different URL (and a different
            // volatile token); the strong content key is the better identity.
            if self.version != STATE_VERSION {
                return ResumeOutcome::Rejected("version-mismatch");
            }
            if self.completed_ranges().is_none() {
                return ResumeOutcome::Rejected("ranges-invalid");
            }
            if self.total_bytes != total || meta.total_bytes != Some(total) {
                return ResumeOutcome::Rejected("size-mismatch");
            }
            return ResumeOutcome::Accepted("content-key");
        }
        self.is_compatible(url, meta, total)
    }

    /// Attach the controller's current target so a later resume can restore it.
    pub fn with_target_workers(mut self, target: usize) -> Self {
        self.target_workers = Some(target.max(1));
        self
    }

    fn stored_url_identity(&self) -> String {
        self.url_identity.clone().unwrap_or_else(|| url_identity(&self.url))
    }

    fn stored_final_identity(&self) -> String {
        self.final_url_identity.clone().unwrap_or_else(|| url_identity(&self.final_url))
    }

    pub fn completed_ranges(&self) -> Option<Vec<(u64, u64)>> {
        let mut ranges = Vec::with_capacity(self.completed_ranges.len());
        for pair in &self.completed_ranges {
            let (start, end) = (pair[0], pair[1]);
            if start >= end || end > self.total_bytes {
                return None;
            }
            ranges.push((start, end));
        }
        Some(merge_ranges(ranges))
    }

    /// Decide whether a fresh probe may resume this state.
    ///
    /// Resume identity is deliberately *not* the final URL string: real
    /// downloads (ModelScope `auth_key`, HF xet `Expires`/`Policy`) mint a new
    /// token on every probe, so the recorded `finalUrl` never repeats. The
    /// stable identity is (in order): matching ETag, matching Last-Modified plus
    /// same path, same requested URL, same final path. Size and file name must
    /// always agree.
    pub fn is_compatible(&self, url: &str, meta: &Meta, total: u64) -> ResumeOutcome {
        use ResumeOutcome::{Accepted, Rejected};
        if self.version != STATE_VERSION {
            return Rejected("version-mismatch");
        }
        if self.completed_ranges().is_none() {
            return Rejected("ranges-invalid");
        }
        if self.total_bytes != total {
            return Rejected("size-mismatch");
        }
        let etag_both = match (&self.etag, &meta.etag) {
            (Some(saved), Some(current)) => Some(saved == current),
            _ => None,
        };
        if etag_both == Some(false) {
            return Rejected("validators-mismatch");
        }
        let last_modified_both = match (&self.last_modified, &meta.last_modified) {
            (Some(saved), Some(current)) => Some(saved == current),
            _ => None,
        };
        if etag_both == Some(true) {
            return Accepted("etag");
        }
        let same_requested = self.stored_url_identity() == url_identity(url);
        let same_final = self.stored_final_identity() == url_identity(&meta.final_url);
        if last_modified_both == Some(false) {
            return Rejected("validators-mismatch");
        }
        if last_modified_both == Some(true) && (same_requested || same_final) {
            return Accepted("last-modified");
        }
        if same_requested {
            return Accepted("url");
        }
        if same_final {
            return Accepted("final-url");
        }
        if self.file_name != meta.file_name {
            return Rejected("file-name-mismatch");
        }
        Rejected("url-mismatch")
    }
}
pub fn merge_ranges(mut ranges: Vec<(u64, u64)>) -> Vec<(u64, u64)> {
    ranges.retain(|(start, end)| start < end);
    ranges.sort_unstable();
    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        match merged.last_mut() {
            Some((_, last_end)) if start <= *last_end => {
                if end > *last_end {
                    *last_end = end;
                }
            }
            _ => merged.push((start, end)),
        }
    }
    merged
}
pub fn missing_ranges(ranges: &[(u64, u64)], total: u64) -> Vec<(u64, u64)> {
    let mut missing = Vec::new();
    let mut cursor = 0u64;
    for &(start, end) in ranges {
        if start > cursor {
            missing.push((cursor, start));
        }
        cursor = cursor.max(end);
    }
    if cursor < total {
        missing.push((cursor, total));
    }
    missing
}
fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}
pub fn part_path(target: &Path) -> PathBuf {
    append_suffix(target, ".part")
}
pub fn state_path(target: &Path) -> PathBuf {
    append_suffix(target, ".part.json")
}
pub async fn load(path: &Path) -> Option<ResumeState> {
    match load_outcome(path).await {
        LoadOutcome::State(state) => Some(*state),
        _ => None,
    }
}

/// Detailed load result: a missing file is not an error (fresh transfer), while
/// a corrupt or version-mismatched file is reported with its stable code so the
/// plan phase can distinguish `no-state` from `state-corrupt`/`version-mismatch`.
#[derive(Debug)]
pub enum LoadOutcome {
    Missing,
    Corrupt(&'static str),
    State(Box<ResumeState>),
}

pub async fn load_outcome(path: &Path) -> LoadOutcome {
    let data = match tokio::fs::read(path).await {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return LoadOutcome::Missing,
        Err(error) => {
            klog!(warn, "could not read resume state {}: {error}", path.display());
            return LoadOutcome::Corrupt("state-corrupt");
        }
    };
    match serde_json::from_slice::<ResumeState>(&data) {
        Ok(state) if state.version == STATE_VERSION => LoadOutcome::State(Box::new(state)),
        Ok(state) => {
            klog!(warn, "unsupported resume state version {} at {}", state.version, path.display());
            LoadOutcome::Corrupt("version-mismatch")
        }
        Err(error) => {
            klog!(warn, "corrupt resume state at {}: {error}", path.display());
            LoadOutcome::Corrupt("state-corrupt")
        }
    }
}
pub async fn save_atomic(path: &Path, state: &ResumeState, durable: bool) -> std::io::Result<()> {
    let data = serde_json::to_vec(state).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent).await?;
        }
    }
    let tmp = append_suffix(path, ".tmp");
    {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::File::create(&tmp).await?;
        file.write_all(&data).await?;
        if durable {
            file.sync_all().await?;
        }
    }
    tokio::fs::rename(&tmp, path).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Meta;

    fn meta(final_url: &str, etag: Option<&str>, last_modified: Option<&str>) -> Meta {
        Meta {
            final_url: final_url.to_string(),
            file_name: "a.gguf".to_string(),
            total_bytes: Some(1000),
            supports_ranges: true,
            content_type: None,
            etag: etag.map(str::to_string),
            last_modified: last_modified.map(str::to_string),
            http_version: None,
        }
    }

    fn state_for(meta: &Meta) -> ResumeState {
        ResumeState::new("https://modelscope.cn/resolve/master/a.gguf", meta, 1000, 8 * 1024 * 1024, vec![(0, 512)], 512)
    }

    /// Real session_logs shape: the same ModelScope object is probed twice and
    /// each probe returns a different `auth_key` query token in `finalUrl`.
    #[test]
    fn accepts_resume_across_volatile_final_url_tokens() {
        let first = "https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/ca/3b/a?filename=a.gguf&auth_key=1794154377-aa-0-bb";
        let second = "https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/ca/3b/a?filename=a.gguf&auth_key=1794154910-cc-0-dd";
        let saved = state_for(&meta(first, Some("\"77B298633474EED5463C3687BDE3A275-400\""), None));
        let outcome = saved.is_compatible("https://modelscope.cn/resolve/master/a.gguf", &meta(second, Some("\"77B298633474EED5463C3687BDE3A275-400\""), None), 1000);
        assert_eq!(outcome, ResumeOutcome::Accepted("etag"));
    }

    #[test]
    fn accepts_resume_by_requested_url_when_no_validators_survive() {
        let first = "https://cdn.example.com/a.zip?Expires=1&Signature=aa";
        let second = "https://cdn.example.com/a.zip?Expires=2&Signature=bb";
        let saved = state_for(&meta(first, None, None));
        let outcome = saved.is_compatible("https://modelscope.cn/resolve/master/a.gguf", &meta(second, None, None), 1000);
        assert_eq!(outcome, ResumeOutcome::Accepted("url"));
    }

    #[test]
    fn rejects_changed_validators_size_and_url() {
        let saved = state_for(&meta("https://cdn.example.com/a.zip", Some("\"v1\""), None));
        assert_eq!(
            saved.is_compatible("https://modelscope.cn/resolve/master/a.gguf", &meta("https://cdn.example.com/a.zip", Some("\"v2\""), None), 1000),
            ResumeOutcome::Rejected("validators-mismatch")
        );
        assert_eq!(saved.is_compatible("https://modelscope.cn/resolve/master/a.gguf", &meta("https://cdn.example.com/a.zip", Some("\"v1\""), None), 999), ResumeOutcome::Rejected("size-mismatch"));

        let no_validators = ResumeState::new("https://mirror-a.example.com/a.zip", &meta("https://mirror-a.example.com/a.zip", None, None), 1000, 8388608, vec![(0, 512)], 512);
        assert_eq!(
            no_validators.is_compatible("https://modelscope.cn/resolve/master/a.gguf", &meta("https://mirror-b.example.com/b.zip", None, None), 1000),
            ResumeOutcome::Rejected("url-mismatch")
        );
    }

    #[test]
    fn last_modified_plus_same_path_is_enough() {
        let saved = state_for(&meta("https://cdn.example.com/a.zip?token=1", None, Some("Thu, 24 Sep 2026 20:15:00 GMT")));
        assert_eq!(
            saved.is_compatible("https://modelscope.cn/resolve/master/a.gguf", &meta("https://cdn.example.com/a.zip?token=2", None, Some("Thu, 24 Sep 2026 20:15:00 GMT")), 1000),
            ResumeOutcome::Accepted("last-modified")
        );
    }

    #[test]
    fn derived_identity_resumes_old_state_format() {
        // 0.2.0 `.part.json` had no identity fields; the loader derives them.
        let old = serde_json::json!({
            "version": 1,
            "url": "https://modelscope.cn/resolve/master/a.gguf",
            "finalUrl": "https://cdn-lfs-cn-1.modelscope.cn/prod/x?auth_key=1-2-3-4",
            "fileName": "a.gguf",
            "totalBytes": 1000,
            "etag": "\"v1\"",
            "lastModified": null,
            "chunkSize": 8388608,
            "completedRanges": [[0, 512]],
            "downloadedBytes": 512
        });
        let saved: ResumeState = serde_json::from_value(old).expect("old state must load");
        assert!(matches!(saved.is_compatible("https://modelscope.cn/resolve/master/a.gguf", &meta("https://cdn-lfs-cn-1.modelscope.cn/prod/x?auth_key=9-9-9-9", Some("\"v1\""), None), 1000), ResumeOutcome::Accepted(_)));
        // Round-trip keeps the state version and the new fields.
        let json = serde_json::to_value(&saved).expect("serialize");
        assert_eq!(json.get("version").and_then(|value| value.as_u64()), Some(u64::from(STATE_VERSION)));
        assert!(json.get("urlIdentity").is_some());
        assert!(json["urlIdentity"].is_null() || json["urlIdentity"].is_string());
    }

    #[test]
    fn invalid_ranges_are_rejected() {
        let mut saved = state_for(&meta("https://cdn.example.com/a.zip", Some("\"v1\""), None));
        saved.completed_ranges = vec![[0, 2000]];
        assert_eq!(
            saved.is_compatible("https://modelscope.cn/resolve/master/a.gguf", &meta("https://cdn.example.com/a.zip", Some("\"v1\""), None), 1000),
            ResumeOutcome::Rejected("ranges-invalid")
        );
    }
}
