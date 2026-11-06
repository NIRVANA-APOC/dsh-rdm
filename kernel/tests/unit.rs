//! Unit tests for the ported engine building blocks (rate limiter, filename
//! rules, chunk geometry, scheduler, protocol defaults).

use std::path::Path;
use std::time::{Duration, Instant};

use rdm_kernel::filename;
use rdm_kernel::plan::{covered_chunks, split_work, ChunkPlan};
use rdm_kernel::protocol::{Config, Meta, RequestSpec, Spec};
use rdm_kernel::rate::TokenBucket;
use rdm_kernel::scheduler::{Claim, Completion, Scheduler, COALESCE_MAX_BYTES, COALESCE_MIN_BYTES, MIN_STEAL_REMAINING};
use rdm_kernel::state::{merge_ranges, missing_ranges, ResumeState};

const MB: u64 = 1024 * 1024;

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("rdm-kernel-unit-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// ---------------------------------------------------------------------------
// Protocol defaults
// ---------------------------------------------------------------------------

#[test]
fn start_inherits_initialize_defaults() {
    let config = Config { connections: 4, max_attempts: 3, default_dir: Some(std::env::temp_dir().to_string_lossy().into_owned()), ..Config::default() };
    let raw: RequestSpec = serde_json::from_str(r#"{"url":"https://example.com/file.bin"}"#).unwrap();
    assert!(raw.connections.is_none());
    assert!(raw.max_attempts.is_none());
    let spec = Spec::resolve(raw, &config).unwrap();
    assert_eq!(spec.connections, 4);
    assert_eq!(spec.max_attempts, 3);
    assert_eq!(spec.chunk_size_bytes, 0);
    assert!(spec.resume);
    assert!(!spec.single_stream);
}

#[test]
fn single_stream_forces_one_connection_without_chunks() {
    let raw: RequestSpec = serde_json::from_str(r#"{"url":"https://example.com/a.bin","singleStream":true,"connections":8,"chunkSizeBytes":1048576}"#).unwrap();
    let spec = Spec::resolve(raw, &Config::default()).unwrap();
    assert_eq!(spec.connections, 1);
    assert_eq!(spec.chunk_size_bytes, 0);
    assert!(spec.single_stream);
}

#[test]
fn rejects_invalid_requests() {
    for body in [r#"{"url":"ftp://example.com/a"}"#, r#"{"url":"not a url"}"#, r#"{"url":"https://example.com/a","expectedSha256":"zz"}"#] {
        let raw: RequestSpec = serde_json::from_str(body).unwrap();
        assert!(Spec::resolve(raw, &Config::default()).is_err(), "{body}");
    }
}

// ---------------------------------------------------------------------------
// Filename rules
// ---------------------------------------------------------------------------

#[test]
fn derives_names_from_headers_and_urls() {
    assert_eq!(filename::parse_content_disposition(r#"attachment; filename="report final.pdf""#).as_deref(), Some("report final.pdf"));
    assert_eq!(filename::parse_content_disposition("attachment; filename=\"fallback.bin\"; filename*=UTF-8''%E4%B8%AD%E6%96%87%20file.bin").as_deref(), Some("中文 file.bin"));
    assert_eq!(filename::derive(None, "https://example.com/files/My%20File.tar.gz?token=x"), "My File.tar.gz");
    assert_eq!(filename::derive(None, "https://example.com/"), filename::FALLBACK_NAME);
}

#[test]
fn sanitizes_windows_illegal_names() {
    assert_eq!(filename::sanitize("a<b>c:d\"e/f\\g|h?i*j"), "a_b_c_d_e_f_g_h_i_j");
    assert_eq!(filename::sanitize("name.  "), "name");
    assert_eq!(filename::sanitize("   "), "");
    assert_eq!(filename::sanitize(".."), "");
    assert_eq!(filename::sanitize("CON"), "_CON");
    assert_eq!(filename::sanitize("lpt9.txt"), "_lpt9.txt");
    assert_eq!(filename::sanitize("console.txt"), "console.txt");
    let long = filename::sanitize(&"汉".repeat(500));
    assert!(long.chars().count() <= 180);
    assert!(long.is_char_boundary(long.len()));
}

#[test]
fn deduplicates_targets_and_prefers_resume_state() {
    let dir = temp_dir("dedupe");
    let (path, name) = filename::resolve_target(&dir, "file.bin", true);
    assert_eq!(name, "file.bin");
    std::fs::write(&path, b"x").unwrap();
    let (_, name2) = filename::resolve_target(&dir, "file.bin", true);
    assert_eq!(name2, "file (1).bin");
    std::fs::write(dir.join("file.bin.part.json"), b"{}").unwrap();
    let (resume_path, resume_name) = filename::resolve_target(&dir, "file.bin", true);
    assert_eq!(resume_name, "file.bin");
    assert_eq!(resume_path, dir.join("file.bin"));
    let (_, no_resume) = filename::resolve_target(&dir, "file.bin", false);
    assert_eq!(no_resume, "file (1).bin");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// Chunk geometry
// ---------------------------------------------------------------------------

#[test]
fn chunk_plan_geometry() {
    let plan = ChunkPlan::new(64 * MB, 8, 0);
    assert_eq!(plan.chunk_size, 2 * MB);
    assert_eq!(plan.total_chunks, 32);
    // Auto sizing keeps four chunks per connection; a file below the 256 KiB
    // floor stays one chunk.
    let small = ChunkPlan::new(1024, 8, 0);
    assert_eq!(small.chunk_size, 1024);
    assert_eq!(small.total_chunks, 1);
    let medium = ChunkPlan::new(10 * MB, 8, 0);
    assert_eq!(medium.chunk_size, 10 * MB / 32);
    assert_eq!(medium.total_chunks, 32);
    // Auto sizing caps at 8 MiB even for a multi-gigabyte file on one stream.
    let large = ChunkPlan::new(4 * 1024 * MB, 1, 0);
    assert_eq!(large.chunk_size, 8 * MB);
    let explicit = ChunkPlan::new(10, 4, 3);
    assert_eq!(explicit.total_chunks, 4);
    assert_eq!(explicit.byte_range(3), (9, 10));
    assert_eq!(split_work(vec![(0, 10), (20, 26)], 4), vec![(0, 4), (4, 8), (8, 10), (20, 24), (24, 26)]);
    let base = ChunkPlan::with_chunk_size(100, 10);
    assert_eq!(covered_chunks(&base, &[(0, 30), (50, 55)]), 3);
}

#[test]
fn scheduler_merges_completed_ranges_incrementally() {
    use rdm_kernel::scheduler::Scheduler;
    let scheduler = Scheduler::new(16, Vec::new(), vec![(0, 16)], 4);
    let first = scheduler.claim_with(0, 0).expect("claim 1");
    let second = scheduler.claim_with(0, 0).expect("claim 2");
    let third = scheduler.claim_with(0, 0).expect("claim 3");
    // Out-of-order completion still produces merged, sorted ranges.
    scheduler.complete(third, 4);
    assert_eq!(scheduler.completed_ranges(), vec![(8, 12)]);
    scheduler.complete(first, 4);
    assert_eq!(scheduler.completed_ranges(), vec![(0, 4), (8, 12)]);
    scheduler.complete(second, 4);
    assert_eq!(scheduler.completed_ranges(), vec![(0, 12)]);
    assert_eq!(scheduler.done_bytes(), 12);
}

#[test]
fn resume_state_ranges_are_validated_and_merged() {
    assert_eq!(merge_ranges(vec![(4, 8), (0, 4)]), vec![(0, 8)]);
    assert_eq!(missing_ranges(&[(0, 4), (8, 12)], 16), vec![(4, 8), (12, 16)]);
    assert!(missing_ranges(&[(0, 16)], 16).is_empty());

    let meta = Meta {
        final_url: "https://cdn.example.com/file.bin".to_string(),
        file_name: "file.bin".to_string(),
        total_bytes: Some(32),
        supports_ranges: true,
        content_type: None,
        etag: Some("\"v1\"".to_string()),
        last_modified: None,
        http_version: None,
    };
    let mut state = ResumeState::new("https://example.com/file.bin", &meta, 32, 8, vec![(0, 8), (16, 32)], 24);
    assert!(state.is_compatible("https://example.com/file.bin", &meta, 32));
    assert_eq!(state.completed_ranges(), Some(vec![(0, 8), (16, 32)]));
    state.completed_ranges = vec![[0, 33]];
    assert_eq!(state.completed_ranges(), None);
    state.completed_ranges = vec![[0, 8]];
    state.etag = Some("\"v2\"".to_string());
    assert!(!state.is_compatible("https://example.com/file.bin", &meta, 32));
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

#[test]
fn scheduler_subdivides_and_merges() {
    let scheduler = Scheduler::new(10, Vec::new(), vec![(0, 10)], 4);
    let mut ranges = Vec::new();
    while let Some(claim) = scheduler.claim_with(usize::MAX, 0) {
        ranges.push((claim.start, claim.end));
    }
    assert_eq!(ranges, vec![(0, 4), (4, 8), (8, 10)]);

    let scheduler = Scheduler::new(8 * MB, Vec::new(), vec![(0, 8 * MB)], MB);
    let first = scheduler.claim_with(2, COALESCE_MAX_BYTES).unwrap();
    assert_eq!((first.start, first.end), (0, 4 * MB));
    let second = scheduler.claim_with(2, COALESCE_MAX_BYTES).unwrap();
    assert_eq!((second.start, second.end), (4 * MB, 6 * MB));
}

#[test]
fn scheduler_steals_the_tail() {
    let scheduler = Scheduler::new(4 * MB, Vec::new(), vec![(0, 4 * MB)], 4 * MB);
    let owner = scheduler.claim_with(usize::MAX, 0).unwrap();
    assert!(owner.len() >= MIN_STEAL_REMAINING);
    owner.update_progress(MB);
    assert!(scheduler.try_request_steal());
    let target = owner.steal_target().expect("split requested");
    let covered = target - owner.start;
    match scheduler.complete(owner, covered) {
        Completion::Split { completed } => assert_eq!(completed, covered),
        Completion::Finished => panic!("expected a split"),
    }
    let suffix = scheduler.claim_with(usize::MAX, 0).expect("suffix queued");
    assert_eq!((suffix.start, suffix.end), (target, 4 * MB));
    assert_eq!(scheduler.completed_ranges(), vec![(0, target)]);
    assert!(COALESCE_MIN_BYTES > MB);
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

#[tokio::test]
async fn token_bucket_throttles_above_rate() {
    let bucket = TokenBucket::new(512 * 1024);
    let started = Instant::now();
    bucket.acquire(768 * 1024).await;
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(400), "too early: {elapsed:?}");
    assert!(elapsed < Duration::from_secs(5), "too slow: {elapsed:?}");
}

#[tokio::test]
async fn token_bucket_allows_burst() {
    let bucket = TokenBucket::new(4 * 1024 * 1024);
    let started = Instant::now();
    bucket.acquire(128 * 1024).await;
    assert!(started.elapsed() < Duration::from_millis(200));
}

// Keep the `Path` import used on platforms where the compiler warns.
#[allow(dead_code)]
fn _path(_: &Path) {}

#[allow(dead_code)]
fn _claim(_: &Claim) {}
