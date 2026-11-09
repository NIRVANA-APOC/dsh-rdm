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
    // Workspace-owned scratch dir: the DSH Windows sandbox can deny child
    // processes writes under %LOCALAPPDATA%\Temp (os error 5).
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("tmp").join(format!("rdm-kernel-unit-{tag}-{}", std::process::id()));
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
    // 0.3.0 replaced the boolean compatibility check with a decision/reason
    // outcome; the unit-level contract is unchanged (accepted iff compatible).
    assert!(state.is_compatible("https://example.com/file.bin", &meta, 32).is_accepted());
    assert_eq!(state.completed_ranges(), Some(vec![(0, 8), (16, 32)]));
    state.completed_ranges = vec![[0, 33]];
    assert_eq!(state.completed_ranges(), None);
    state.completed_ranges = vec![[0, 8]];
    state.etag = Some("\"v2\"".to_string());
    assert!(!state.is_compatible("https://example.com/file.bin", &meta, 32).is_accepted());
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

// ---------------------------------------------------------------------------
// Protocol v2 JSON shapes (§2)
// ---------------------------------------------------------------------------

#[test]
fn task_view_v2_serde_roundtrip() {
    use rdm_kernel::protocol::{EtaConfidence, ResumeSafety, TaskView};
    let mut view = TaskView::default();
    view.id = "t_9f3a1c2d5e6b7a80".into();
    view.session_id = Some("sess_abc".into());
    view.url = "https://cdn.example.com/app.zip".into();
    view.host = "cdn.example.com".into();
    view.file_name = "app.zip".into();
    view.status = rdm_kernel::protocol::Status::Running;
    view.downloaded = 21_184_000;
    view.total = Some(50_406_400);
    view.percent = Some(42);
    view.speed1s_bps = Some(1_625_292);
    view.avg_bps = 1_200_000;
    view.peak_bps = 2_306_867;
    view.eta_confidence = EtaConfidence::High;
    view.resume_safety = ResumeSafety::Strong;
    view.verified = Some(true);
    let value = serde_json::to_value(&view).expect("serialize");
    for key in [
        "id",
        "sessionId",
        "url",
        "host",
        "finalUrl",
        "fileName",
        "dir",
        "path",
        "status",
        "downloaded",
        "total",
        "percent",
        "speedBps",
        "speed1sBps",
        "speed5sBps",
        "speed30sBps",
        "speed300sBps",
        "avgBps",
        "peakBps",
        "etaSecs",
        "etaConfidence",
        "stalledMs",
        "activeWorkers",
        "peakWorkers",
        "connections",
        "chunkSize",
        "resumedChunks",
        "rangeSupported",
        "resumable",
        "resumeSafety",
        "expectedSha256",
        "sha256",
        "verified",
        "error",
        "retries",
        "createdAt",
        "startedAt",
        "finishedAt",
        "elapsedMs",
        "signedUrlExpiresAt",
        "tlsNotAfter",
    ] {
        assert!(value.get(key).is_some(), "TaskView JSON missing {key}: {value}");
    }
    assert_eq!(value["sessionId"], "sess_abc");
    assert_eq!(value["percent"], 42);
    assert!(value["speed5sBps"].is_null(), "unknown numerics serialize as null");
    let back: TaskView = serde_json::from_value(value).expect("deserialize");
    assert_eq!(back.id, view.id);
    assert_eq!(back.verified, Some(true));
    assert_eq!(back.eta_confidence, EtaConfidence::High);
}

#[test]
fn server_facts_parses_and_serializes_the_spec_example() {
    use rdm_kernel::protocol::{ServerFacts, SignedUrlSource, ValidityState};
    let raw = r#"{
      "url":"https://cdn.example.com/app.zip?sig=<redacted>",
      "finalUrl":"https://cdn.example.com/app.zip?sig=<redacted>",
      "host":"cdn.example.com","httpVersion":"HTTP/2.0","status":200,
      "fileName":"app.zip","fileNameSource":"content-disposition","totalBytes":50406400,
      "contentType":"application/zip","contentEncoding":null,"contentDisposition":"attachment; filename=\"app.zip\"",
      "range":{"supported":true,"acceptRanges":"bytes","ifRange":true,"probedBy":"head","probeStatus":206,"probeBytes":64},
      "validators":{"etag":"\"9b2cf5\"","strongEtag":true,"lastModified":"Wed, 21 Oct 2026 07:28:00 GMT"},
      "resume":{"possible":true,"safety":"strong","reason":"strong-etag"},
      "signedUrl":{"signed":true,"expiresAt":1763000123000,"expiresInSecs":1180,"source":"aws-sigv4","state":"valid"},
      "tls":{"https":true,"notAfter":1767000000000,"expiresInSecs":3456000,"issuer":"R11","subject":"cdn.example.com","state":"valid"},
      "redirects":[{"status":301,"url":"https://cdn2.example.com/app.zip"}],
      "headers":{"server":"nginx","date":"Wed, 21 Oct 2026 07:28:00 GMT","cacheControl":"max-age=3600","expires":null,"vary":"Accept-Encoding"},
      "rateLimit":{"retryAfterSecs":null,"limit":null,"remaining":null},
      "timing":{"probeMs":84,"ttfbMs":61,"sampleBps":12345678},
      "checksum":{"contentDigest":null,"contentMd5":null,"sha256":null,"crc32c":null},
      "warnings":["weak-validators","signed-url-expiring"],
      "recommendation":{"start":"now","connections":8,"chunkSizeBytes":1572864,"singleStream":false,"reason":"ranges+strong-etag","verify":"recommended"},
      "origin":{"known":true,"attempts":3,"completed":2,"medianBps":14680064,"bestBps":23068672,"lastError":"network","lastAt":1762990000000}
    }"#;
    let facts: ServerFacts = serde_json::from_str(raw).expect("ServerFacts parse");
    assert_eq!(facts.signed_url.source, SignedUrlSource::AwsSigV4);
    assert_eq!(facts.signed_url.state, ValidityState::Valid);
    assert_eq!(facts.range.probe_status, Some(206));
    let origin = facts.origin.clone().expect("origin facts");
    assert_eq!(origin.median_bps, Some(14_680_064));
    let value = serde_json::to_value(&facts).expect("serialize");
    for key in [
        "url",
        "finalUrl",
        "host",
        "httpVersion",
        "status",
        "fileName",
        "fileNameSource",
        "totalBytes",
        "contentType",
        "contentEncoding",
        "contentDisposition",
        "range",
        "validators",
        "resume",
        "signedUrl",
        "tls",
        "redirects",
        "headers",
        "rateLimit",
        "timing",
        "checksum",
        "warnings",
        "recommendation",
        "origin",
    ] {
        assert!(value.get(key).is_some(), "ServerFacts JSON missing {key}");
    }
    for key in ["contentDigest", "contentMd5", "sha256", "crc32c"] {
        assert!(value["checksum"].get(key).is_some(), "checksum JSON missing {key}");
    }
    assert!(value["checksum"].get("digest").is_none(), "stale `digest` field must not exist");
}

#[test]
fn task_detail_serializes_protocol_v2_shape() {
    use rdm_kernel::protocol::{ChecksumFacts, TaskDetail, Telemetry, WindowRates};
    let mut detail = TaskDetail::default();
    detail.telemetry = Telemetry { windows: WindowRates { w1s: Some(10), w5s: Some(9), w30s: Some(8), w300s: None }, ..Telemetry::default() };
    detail.verification.server_checksums = ChecksumFacts { content_digest: Some("sha-256=:AA==:".into()), ..ChecksumFacts::default() };
    let value = serde_json::to_value(&detail).expect("serialize");
    for key in ["telemetry", "server", "target", "verification", "resumeState", "timing", "diagnosis"] {
        assert!(value.get(key).is_some(), "TaskDetail missing {key}");
    }
    let windows = &value["telemetry"]["windows"];
    assert_eq!(windows["1s"], 10);
    assert!(windows["300s"].is_null());
    assert_eq!(value["verification"]["serverChecksums"]["contentDigest"], "sha-256=:AA==:");
}

#[test]
fn legacy_0_1_x_task_record_json_loads() {
    use rdm_kernel::protocol::{Status, TaskRecord};
    let raw = r#"{
      "spec":{"url":"https://example.com/file.bin","dir":"C:\\tmp","fileName":null,"connections":8,
        "chunkSizeBytes":0,"headers":{},"cookie":null,"referer":null,"userAgent":null,
        "expectedSha256":null,"speedLimitBps":0,"resume":true,"singleStream":false,"proxy":null,
        "insecure":false,"maxAttempts":6,"fsyncOnComplete":false},
      "id":"t_legacy","url":"https://example.com/file.bin","finalUrl":null,"fileName":"file.bin",
      "dir":"C:\\tmp","path":null,"status":"completed","downloaded":10,"total":10,"speedBps":0,
      "etaSecs":null,"activeWorkers":0,"peakWorkers":1,"connections":8,"chunkSize":null,
      "resumedChunks":0,"rangeSupported":true,"expectedSha256":null,"sha256":null,"error":null,
      "retries":0,"createdAt":1,"startedAt":2,"finishedAt":3,"elapsedMs":4,"resumable":false
    }"#;
    let record: TaskRecord = serde_json::from_str(raw).expect("0.1.x record loads");
    assert_eq!(record.view.id, "t_legacy");
    assert_eq!(record.view.status, Status::Completed);
    assert!(record.view.session_id.is_none(), "0.1.x record has no session");
    assert!(record.view.peak_bps == 0);
    assert!(record.view.verified.is_none());
    assert_eq!(record.view.percent, None, "new fields default");
    assert!(record.server.is_none());
    assert!(record.spec.session_id.is_none());
    // The flattened view plus the sibling `server` field must both round-trip.
    let value = serde_json::to_value(&record).expect("serialize record");
    assert!(value.get("server").is_some());
    assert_eq!(value["id"], "t_legacy");
    let back: TaskRecord = serde_json::from_value(value).expect("round-trip");
    assert_eq!(back.view.id, "t_legacy");
}
