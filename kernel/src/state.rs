use crate::klog;
use crate::protocol::Meta;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
pub const STATE_VERSION: u32 = 1;
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
        }
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
    pub fn is_compatible(&self, url: &str, meta: &Meta, total: u64) -> bool {
        self.version == STATE_VERSION && self.url == url && self.final_url == meta.final_url && self.total_bytes == total && self.etag == meta.etag && self.last_modified == meta.last_modified && self.completed_ranges().is_some()
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
    let data = match tokio::fs::read(path).await {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            klog!(warn, "could not read resume state {}: {error}", path.display());
            return None;
        }
    };
    match serde_json::from_slice::<ResumeState>(&data) {
        Ok(state) if state.version == STATE_VERSION => Some(state),
        Ok(state) => {
            klog!(warn, "unsupported resume state version {} at {}", state.version, path.display());
            None
        }
        Err(error) => {
            klog!(warn, "corrupt resume state at {}: {error}", path.display());
            None
        }
    }
}
pub async fn save_atomic(path: &Path, state: &ResumeState) -> std::io::Result<()> {
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
        file.sync_all().await?;
    }
    tokio::fs::rename(&tmp, path).await
}
