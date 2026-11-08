//! Stable diagnosis codes for live and terminal tasks (§2.3, §5.5).
//!
//! The kernel is the only component that sees the whole transfer state, so it
//! emits machine-readable `code` + `advice` pairs instead of the host guessing
//! from rates. The list is bounded to four entries, most actionable first.

use crate::protocol::{Diagnosis, EtaConfidence, OriginFacts, ResumeSafety, ServerFacts, Status, ValidityState};

/// Inputs the task exposes for diagnosis; kept small so the rules stay pure
/// and unit-testable.
pub struct DiagnosisInput<'a> {
    pub status: Status,
    pub percent: Option<u32>,
    pub stalled_ms: u64,
    pub retries: u32,
    /// A retry event happened within the last 30 s.
    pub retrying_recent: bool,
    /// A 429/503 pushback happened within the last 60 s.
    pub throttled_recent: bool,
    pub eta_confidence: EtaConfidence,
    pub range_supported: Option<bool>,
    pub resume_safety: ResumeSafety,
    pub expected_sha256: Option<&'a str>,
    pub avg_bps: u64,
    pub error_code: Option<&'a str>,
    pub server: Option<&'a ServerFacts>,
    pub origin: Option<&'a OriginFacts>,
}

/// Hard cap from §2.3.
pub const MAX_DIAGNOSES: usize = 4;

/// Declared checksum availability (not verification).
fn checksum_available(server: &ServerFacts) -> bool {
    server.checksum.sha256.is_some() || server.checksum.content_md5.is_some() || server.checksum.content_digest.is_some() || server.checksum.crc32c.is_some()
}

pub fn diagnose(input: &DiagnosisInput<'_>) -> Vec<Diagnosis> {
    let mut out: Vec<Diagnosis> = Vec::new();
    let terminal = input.status.is_terminal();
    if terminal {
        diagnosis_terminal(input, &mut out);
    } else {
        diagnosis_live(input, &mut out);
    }
    out.truncate(MAX_DIAGNOSES);
    out
}

fn diagnosis_live(input: &DiagnosisInput<'_>, out: &mut Vec<Diagnosis>) {
    let paused = input.status == Status::Paused;
    let running = input.status == Status::Running;

    if let Some(server) = input.server {
        if matches!(server.signed_url.state, ValidityState::Expiring | ValidityState::Expired) {
            // Pausing would miss the moment the URL stops working.
            out.push(diag("signed-url-expiring", "do not pause", format!("signed URL {}; finish this transfer before pausing", if server.signed_url.state == ValidityState::Expired { "is already expired" } else { "expires soon" })));
        }
    }
    if input.range_supported == Some(false) {
        out.push(diag("no-range", "single-stream", "server does not honour byte ranges; run one stream and do not resume"));
    }
    if running && input.stalled_ms >= 5_000 {
        out.push(diag("stalled", "inspect-or-restart", format!("no bytes for {}s; restart the transfer if this persists", input.stalled_ms / 1000)));
    }
    if !paused && input.throttled_recent {
        out.push(diag("throttled", "lower-connections", "server pushed back recently; wait or reduce connections"));
    }
    if input.retrying_recent && input.retries > 0 {
        out.push(diag("retrying", "wait", format!("retrying failed chunks ({} retries so far)", input.retries)));
    }
    if input.resume_safety == ResumeSafety::Weak && input.range_supported == Some(true) {
        out.push(diag("weak-validators", "avoid-resume", "only weak validators; a resumed transfer may splice a changed remote file"));
    }
    if let Some(server) = input.server {
        let checksum_available = checksum_available(server);
        if checksum_available && input.expected_sha256.is_none() {
            out.push(diag("checksum-available", "verify", "server advertises a checksum; pass expectedSha256 to verify the result"));
        }
    }
    if input.status.is_active() && input.percent.is_some_and(|percent| percent >= 95) {
        out.push(diag("almost-done", "wait", format!("{}% complete", input.percent.unwrap_or(0))));
    }
    if let Some(origin) = input.origin {
        if let Some(median) = origin.median_bps {
            if origin.known && median > 0 && input.avg_bps > 0 && input.avg_bps.saturating_mul(3) < median && input.status.is_active() {
                out.push(diag("origin-slow", "retry-later", format!("this transfer is well below this host's median {} B/s", median)));
            }
        }
    }
    if out.is_empty() && input.status.is_active() && input.eta_confidence != EtaConfidence::Unknown {
        out.push(diag("on-track", "wait", "transfer is progressing normally"));
    }
}

fn diagnosis_terminal(input: &DiagnosisInput<'_>, out: &mut Vec<Diagnosis>) {
    match input.status {
        Status::Failed => {
            if input.error_code == Some("io") {
                out.push(diag("disk-slow", "io-wait", "local I/O failed; check disk space and permissions before retrying"));
            } else if matches!(input.error_code, Some("network") | Some("http_status") | Some("remote_changed")) {
                if let Some(origin) = input.origin {
                    if origin.known {
                        out.push(diag("origin-slow", "retry-later", "the origin failed this attempt; retry later or reduce connections"));
                    }
                }
                if out.is_empty() {
                    out.push(diag("stalled", "inspect-or-restart", "transfer failed before completion; retry or inspect the origin"));
                }
            }
        }
        Status::Completed => {
            if let Some(server) = input.server {
                let checksum_available = checksum_available(server);
                if checksum_available && input.expected_sha256.is_none() {
                    out.push(diag("checksum-available", "verify", "server advertised a checksum; verify locally before trusting the file"));
                }
            }
        }
        _ => {}
    }
}

fn diag(code: &str, advice: &str, message: impl Into<String>) -> Diagnosis {
    Diagnosis { code: code.to_string(), advice: advice.to_string(), message: message.into() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ChecksumFacts, ResumeSafety};

    fn base<'a>() -> DiagnosisInput<'a> {
        DiagnosisInput {
            status: Status::Running,
            percent: Some(42),
            stalled_ms: 0,
            retries: 0,
            retrying_recent: false,
            throttled_recent: false,
            eta_confidence: EtaConfidence::High,
            range_supported: Some(true),
            resume_safety: ResumeSafety::Strong,
            expected_sha256: None,
            avg_bps: 1_000_000,
            error_code: None,
            server: None,
            origin: None,
        }
    }

    #[test]
    fn healthy_task_reports_on_track() {
        let list = diagnose(&base());
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].code, "on-track");
        assert_eq!(list[0].advice, "wait");
    }

    #[test]
    fn stalled_and_throttled_are_reported() {
        let mut input = base();
        input.stalled_ms = 9_000;
        input.throttled_recent = true;
        let diagnosed = diagnose(&input);
        let codes: Vec<&str> = diagnosed.iter().map(|item| item.code.as_str()).collect();
        assert!(codes.contains(&"stalled"));
        assert!(codes.contains(&"throttled"));
    }

    #[test]
    fn no_range_and_weak_validators() {
        let mut input = base();
        input.range_supported = Some(false);
        input.resume_safety = ResumeSafety::None;
        let diagnosed = diagnose(&input);
        let codes: Vec<&str> = diagnosed.iter().map(|item| item.code.as_str()).collect();
        assert!(codes.contains(&"no-range"));
        input.range_supported = Some(true);
        input.resume_safety = ResumeSafety::Weak;
        let diagnosed = diagnose(&input);
        let codes: Vec<&str> = diagnosed.iter().map(|item| item.code.as_str()).collect();
        assert!(codes.contains(&"weak-validators"));
    }

    #[test]
    fn checksum_available_when_server_proves_and_no_expected_hash() {
        let mut input = base();
        let mut server = ServerFacts::default();
        server.checksum = ChecksumFacts { sha256: Some("abc".into()), ..ChecksumFacts::default() };
        input.server = Some(&server);
        let diagnosed = diagnose(&input);
        let codes: Vec<&str> = diagnosed.iter().map(|item| item.code.as_str()).collect();
        assert!(codes.contains(&"checksum-available"));
        input.expected_sha256 = Some("deadbeef");
        let diagnosed = diagnose(&input);
        let codes: Vec<&str> = diagnosed.iter().map(|item| item.code.as_str()).collect();
        assert!(!codes.contains(&"checksum-available"));
    }

    #[test]
    fn list_is_capped_at_four() {
        let mut input = base();
        input.stalled_ms = 10_000;
        input.throttled_recent = true;
        input.retrying_recent = true;
        input.retries = 3;
        input.range_supported = Some(false);
        input.resume_safety = ResumeSafety::Weak;
        input.percent = Some(99);
        let mut server = ServerFacts::default();
        server.checksum = ChecksumFacts { content_digest: Some("sha-256=:eA==:".into()), ..ChecksumFacts::default() };
        input.server = Some(&server);
        assert!(diagnose(&input).len() <= MAX_DIAGNOSES);
    }

    #[test]
    fn failed_io_maps_to_disk_slow() {
        let mut input = base();
        input.status = Status::Failed;
        input.error_code = Some("io");
        let diagnosed = diagnose(&input);
        let codes: Vec<&str> = diagnosed.iter().map(|item| item.code.as_str()).collect();
        assert_eq!(codes, vec!["disk-slow"]);
    }
}
