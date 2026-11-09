//! Writable scratch directories for unit tests.
//!
//! Prefers `RDM_TEST_TMP`, then the OS temp dir, and falls back to the crate's
//! `target/test-tmp` when the host denies writes under Temp. That last case is
//! real on the DSH Windows sandbox: child processes of the harness can be
//! denied `%LOCALAPPDATA%\Temp` (`create_dir_all` → os error 5), so tests that
//! blindly used `std::env::temp_dir()` failed there while the product code was
//! fine. Each call returns a unique, freshly created directory.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_id() -> u64 {
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// Return a unique writable directory for a unit test.
pub fn dir(tag: &str) -> PathBuf {
    let base = std::env::var_os("RDM_TEST_TMP")
        .map(PathBuf::from)
        .or_else(writable_temp_root)
        .unwrap_or_else(|| {
            let dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join("target").join("test-tmp");
            let _ = std::fs::create_dir_all(&dir);
            dir
        });
    let path = base.join(format!("{tag}-{}-{}", std::process::id(), next_id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).expect("test temp dir");
    path
}

fn writable_temp_root() -> Option<PathBuf> {
    let root = std::env::temp_dir().join("rdm-kernel-tests");
    let probe = root.join(format!("probe-{}-{}", std::process::id(), next_id()));
    match std::fs::create_dir_all(&probe) {
        Ok(()) => {
            let _ = std::fs::remove_dir(&probe);
            Some(root)
        }
        Err(_) => None,
    }
}
