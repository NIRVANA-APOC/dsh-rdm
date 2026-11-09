//! Pure derivations from probe headers and URLs (§2.1, §5.2).
//!
//! Everything here is deterministic and unit-tested: signed-URL expiry parsing
//! (AWS SigV4/V2, GCS SigV4, Azure SAS, generic `Expires`/`exp`), validators
//! and RFC 9110 resume-safety classification, checksum/rate-limit/header
//! allowlist extraction, warnings and the recommendation suggestion.

use crate::protocol::{
    AcceptRanges, ChecksumFacts, FileNameSource, HeaderFacts, RateLimitFacts, Recommendation, RedirectHop, ResumeFacts, ResumeReason, ResumeSafety, SignedUrlFacts, SignedUrlSource, StartWhen, ValidatorFacts, ValidityState, VerifyAdvice,
    SIGNED_URL_EXPIRING_SECS,
};
use crate::tls::{days_from_civil, validity_state};
use reqwest::header::HeaderMap;
use std::time::{SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// Signed URLs
// ---------------------------------------------------------------------------

fn query_value<'a>(url: &'a url::Url, name: &str) -> Option<String> {
    url.query_pairs().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.into_owned())
}

fn query_present(url: &url::Url, name: &str) -> bool {
    url.query_pairs().any(|(key, _)| key.eq_ignore_ascii_case(name))
}

fn parse_u64(text: &str) -> Option<u64> {
    text.trim().parse::<u64>().ok()
}

/// `YYYYMMDDTHHMMSSZ` (AWS/GCS signing timestamps) to epoch millis.
fn parse_compact_utc(text: &str) -> Option<u64> {
    let text = text.trim();
    let (date, time) = text.split_once('T')?;
    let time = time.strip_suffix('Z')?;
    if date.len() != 8 || time.len() != 6 {
        return None;
    }
    let year: i64 = date.get(0..4)?.parse().ok()?;
    let month: u32 = date.get(4..6)?.parse().ok()?;
    let day: u32 = date.get(6..8)?.parse().ok()?;
    let hour: u64 = time.get(0..2)?.parse().ok()?;
    let minute: u64 = time.get(2..4)?.parse().ok()?;
    let second: u64 = time.get(4..6)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    if days < 0 {
        return None;
    }
    let seconds = days * 86_400 + i64::try_from(hour * 3_600 + minute * 60 + second).ok()?;
    u64::try_from(seconds).ok().map(|seconds| seconds * 1000)
}

/// An absolute expiry value: epoch seconds, epoch millis, an ISO-like signing
/// timestamp or an HTTP date. Relative TTLs are never interpreted here.
fn parse_absolute_expiry(raw: &str) -> Option<u64> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(number) = text.parse::<u64>() {
        // 10-digit values are seconds, 13-digit values are millis.
        return Some(if number < 100_000_000_000 { number * 1000 } else { number });
    }
    if let Ok(date) = httpdate::parse_http_date(text) {
        return Some(date.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64);
    }
    if let Some(ms) = parse_compact_utc(text) {
        return Some(ms);
    }
    // Azure `se=2026-11-08T13:00:00Z` / RFC3339-ish (seconds precision).
    let bytes = text.as_bytes();
    if bytes.len() >= 19 && bytes.get(4) == Some(&b'-') && bytes.get(7) == Some(&b'-') {
        let year: i64 = text.get(0..4)?.parse().ok()?;
        let month: u32 = text.get(5..7)?.parse().ok()?;
        let day: u32 = text.get(8..10)?.parse().ok()?;
        let hour: u64 = text.get(11..13)?.parse().ok()?;
        let minute: u64 = text.get(14..16)?.parse().ok()?;
        let second: u64 = text.get(17..19)?.parse().ok()?;
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
            return None;
        }
        let days = days_from_civil(year, month, day);
        if days < 0 {
            return None;
        }
        let seconds = days * 86_400 + i64::try_from(hour * 3_600 + minute * 60 + second).ok()?;
        return u64::try_from(seconds).ok().map(|seconds| seconds * 1000);
    }
    None
}

/// Query parameters that identify a signed (credential-bearing) URL.
///
/// `auth_key` is the Tengine/ModelScope signed-URL parameter observed in the
/// real session logs: `...?filename=…&auth_key=<ts>-<hex>-<n>-<hex>`. Its first
/// segment is a generation timestamp, not a parsable expiry, so presence marks
/// the URL signed while `expiresAt` stays `null` (no `now + TTL` guessing).
const SIGNATURE_PARAMS: [&str; 9] = ["x-amz-signature", "x-amz-credential", "signature", "sig", "x-goog-signature", "awsaccesskeyid", "googleaccessid", "key-pair-id", "auth_key"];

fn carries_signing_or_expiry(url: &url::Url) -> bool {
    SIGNATURE_PARAMS.iter().any(|name| query_present(url, name)) || ["expires", "exp", "se", "x-amz-date", "x-goog-date", "auth_key"].iter().any(|name| query_present(url, name))
}

/// Parse the expiry of a request URL. The expiry is derived from the *final*
/// URL actually used for requests (redirects may land on a differently signed
/// URL); the original URL is only a fallback when the final URL carries no
/// signing/expiry parameters. SigV4/GCS V4 use signed date + relative TTL,
/// SigV2/generic use absolute `Expires`/`exp`, Azure SAS uses absolute `se`;
/// there is no `now + TTL` heuristic.
pub fn signed_url_facts(final_url: &url::Url, original_url: &url::Url, now_ms: u64) -> SignedUrlFacts {
    let source_url = if carries_signing_or_expiry(final_url) {
        final_url
    } else if carries_signing_or_expiry(original_url) {
        original_url
    } else {
        final_url
    };
    let signed = SIGNATURE_PARAMS.iter().any(|name| query_present(source_url, name));

    let has_aws_sigv4 = query_value(source_url, "X-Amz-Algorithm").is_some_and(|algorithm| algorithm.to_ascii_uppercase().starts_with("AWS4"))
        || (query_value(source_url, "X-Amz-Date").is_some() && query_value(source_url, "X-Amz-Expires").is_some() && signed);
    let has_gcs_sigv4 =
        query_value(source_url, "X-Goog-Algorithm").is_some_and(|algorithm| algorithm.to_ascii_uppercase().starts_with("GOOG4")) || (query_value(source_url, "X-Goog-Date").is_some() && query_value(source_url, "X-Goog-Expires").is_some());
    let has_azure = query_value(source_url, "se").is_some() && (query_present(source_url, "sig") || query_present(source_url, "sv") || query_present(source_url, "sp"));

    let derived = if has_aws_sigv4 {
        match (query_value(source_url, "X-Amz-Date"), query_value(source_url, "X-Amz-Expires")) {
            (Some(date), Some(ttl)) => match (parse_compact_utc(&date), parse_u64(&ttl)) {
                (Some(base), Some(ttl)) => Some((base.saturating_add(ttl.saturating_mul(1000)), SignedUrlSource::AwsSigV4)),
                _ => None,
            },
            _ => None,
        }
    } else if has_gcs_sigv4 {
        match (query_value(source_url, "X-Goog-Date"), query_value(source_url, "X-Goog-Expires")) {
            (Some(date), Some(ttl)) => match (parse_compact_utc(&date), parse_u64(&ttl)) {
                (Some(base), Some(ttl)) => Some((base.saturating_add(ttl.saturating_mul(1000)), SignedUrlSource::GcsSigV4)),
                _ => None,
            },
            _ => None,
        }
    } else if has_azure {
        query_value(source_url, "se").and_then(|se| parse_absolute_expiry(&se)).map(|at| (at, SignedUrlSource::AzureSas))
    } else if let Some(expires) = query_value(source_url, "Expires").or_else(|| query_value(source_url, "expires")) {
        let family = if signed { SignedUrlSource::AwsSigV2 } else { SignedUrlSource::GenericExpires };
        parse_absolute_expiry(&expires).map(|at| (at, family))
    } else if let Some(exp) = query_value(source_url, "exp") {
        parse_absolute_expiry(&exp).map(|at| (at, SignedUrlSource::GenericExpires))
    } else {
        None
    };

    let (expires_at, source) = match derived {
        Some((at, source)) => (Some(at), source),
        None => (None, SignedUrlSource::Unknown),
    };
    let expires_in_secs = expires_at.map(|at| (at as i64 - now_ms as i64) / 1000);
    SignedUrlFacts { signed, expires_at, expires_in_secs, source, state: validity_state(expires_in_secs, SIGNED_URL_EXPIRING_SECS) }
}

// ---------------------------------------------------------------------------
// Validators / resume safety (RFC 9110 strong comparison)
// ---------------------------------------------------------------------------

pub fn accept_ranges(raw: Option<&str>) -> AcceptRanges {
    match raw.map(str::trim) {
        Some(value) if value.eq_ignore_ascii_case("bytes") => AcceptRanges::Bytes,
        Some(value) if value.eq_ignore_ascii_case("none") => AcceptRanges::None,
        _ => AcceptRanges::Unknown,
    }
}

/// Minimum bytes a probe must actually read before `timing.sampleBps` is
/// emitted; a 64-byte range probe says nothing about throughput.
pub const SAMPLE_BPS_MIN_BYTES: u64 = 65_536;

/// Measured probe throughput, or `null` when the sample is too small to mean
/// anything (the kernel proves ranges with a 64-byte read only).
pub fn sample_bps(bytes: u64, elapsed_ms: u64) -> Option<u64> {
    if bytes < SAMPLE_BPS_MIN_BYTES || elapsed_ms == 0 {
        return None;
    }
    Some((bytes as f64 / (elapsed_ms as f64 / 1000.0)).min(u64::MAX as f64) as u64)
}

/// Return the ETag usable as an `If-Range` validator: strong (no `W/`) and a
/// syntactically valid entity-tag (a double-quoted string, RFC 9110 §8.8.3).
/// Everything else must not be sent as `If-Range`.
pub fn if_range_etag(etag: Option<&str>) -> Option<&str> {
    let etag = etag?.trim();
    if etag.len() < 2 || etag.to_ascii_lowercase().starts_with("w/") {
        return None;
    }
    if etag.starts_with('"') && etag.ends_with('"') {
        Some(etag)
    } else {
        None
    }
}

pub fn validator_facts(etag: Option<String>, last_modified: Option<String>) -> ValidatorFacts {
    // Last-Modified is implicitly weak (RFC 9110 §8.8.2.2); it is never
    // promoted into a strong validator and never justifies `If-Range`.
    let strong_etag = etag.as_deref().is_some_and(|value| !value.trim_start().to_ascii_lowercase().starts_with("w/"));
    ValidatorFacts { etag, strong_etag, last_modified }
}

pub fn resume_facts(range_supported: bool, validators: &ValidatorFacts, total_known: bool) -> ResumeFacts {
    if !range_supported {
        return ResumeFacts { possible: false, safety: ResumeSafety::None, reason: ResumeReason::NoRangeSupport };
    }
    if !total_known {
        // Chunked resume needs a known total length.
        return ResumeFacts { possible: false, safety: ResumeSafety::None, reason: ResumeReason::NoValidators };
    }
    if validators.strong_etag {
        return ResumeFacts { possible: true, safety: ResumeSafety::Strong, reason: ResumeReason::StrongEtag };
    }
    if validators.etag.is_some() || validators.last_modified.is_some() {
        // Weak ETag or Last-Modified only: resume may work, but the kernel must
        // not send If-Range and must re-probe the validator.
        return ResumeFacts { possible: true, safety: ResumeSafety::Weak, reason: ResumeReason::LastModifiedOnly };
    }
    ResumeFacts { possible: false, safety: ResumeSafety::None, reason: ResumeReason::NoValidators }
}

pub fn file_name_source(content_disposition: Option<&str>) -> FileNameSource {
    if content_disposition.is_some() {
        FileNameSource::ContentDisposition
    } else {
        FileNameSource::Url
    }
}

// ---------------------------------------------------------------------------
// Header-derived facts
// ---------------------------------------------------------------------------

fn header_map_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|value| value.to_str().ok()).map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

/// Declared checksum availability, not verification. `sha256` only comes from
/// `x-amz-checksum-sha256`; GCS does not expose SHA-256 through `x-goog-hash`.
pub fn checksum_facts(headers: &HeaderMap) -> ChecksumFacts {
    let content_digest = header_map_string(headers, "content-digest").or_else(|| header_map_string(headers, "repr-digest"));
    let content_md5 = header_map_string(headers, "content-md5");
    let sha256 = header_map_string(headers, "x-amz-checksum-sha256");
    let mut crc32c = header_map_string(headers, "x-amz-checksum-crc32c");
    let mut goog_md5 = None;
    if let Some(goog) = header_map_string(headers, "x-goog-hash") {
        for entry in goog.split(',') {
            let entry = entry.trim();
            if let Some(value) = entry.strip_prefix("crc32c=") {
                if crc32c.is_none() {
                    crc32c = Some(value.trim().to_string());
                }
            } else if let Some(value) = entry.strip_prefix("md5=") {
                if goog_md5.is_none() {
                    goog_md5 = Some(value.trim().to_string());
                }
            }
        }
    }
    ChecksumFacts { content_digest, content_md5: content_md5.or(goog_md5), sha256, crc32c }
}

pub fn rate_limit_facts(headers: &HeaderMap) -> RateLimitFacts {
    let retry_after_secs = headers.get("retry-after").and_then(|value| value.to_str().ok()).and_then(|value| {
        let value = value.trim();
        if let Ok(seconds) = value.parse::<u64>() {
            Some(seconds)
        } else {
            httpdate::parse_http_date(value).ok().and_then(|date| date.duration_since(SystemTime::now()).ok()).map(|wait| wait.as_secs())
        }
    });
    let number = |name: &str| header_map_string(headers, name).and_then(|value| value.parse::<u64>().ok());
    RateLimitFacts { retry_after_secs, limit: number("x-ratelimit-limit").or_else(|| number("ratelimit-limit")), remaining: number("x-ratelimit-remaining").or_else(|| number("ratelimit-remaining")) }
}

pub fn header_facts(headers: &HeaderMap) -> HeaderFacts {
    HeaderFacts {
        server: header_map_string(headers, "server"),
        date: header_map_string(headers, "date"),
        cache_control: header_map_string(headers, "cache-control"),
        expires: header_map_string(headers, "expires"),
        vary: header_map_string(headers, "vary"),
    }
}

// ---------------------------------------------------------------------------
// Warnings + recommendation
// ---------------------------------------------------------------------------

pub struct WarningsInput<'a> {
    pub range_supported: bool,
    pub validators: &'a ValidatorFacts,
    pub total_bytes: Option<u64>,
    pub signed_url: &'a SignedUrlFacts,
    pub tls_state: Option<ValidityState>,
    pub rate_limit: &'a RateLimitFacts,
    pub status: u16,
    pub head_failed: bool,
    pub redirects: &'a [RedirectHop],
    pub content_encoding: Option<&'a str>,
}

/// Stable, bounded warning codes from §2.1.
pub fn warnings(input: &WarningsInput<'_>) -> Vec<String> {
    let mut out: Vec<&'static str> = Vec::new();
    let mut push = |code: &'static str| {
        if !out.contains(&code) {
            out.push(code);
        }
    };
    if !input.range_supported {
        push("no-range-support");
    }
    if input.validators.etag.is_none() && input.validators.last_modified.is_none() {
        push("no-validators");
    } else if !input.validators.strong_etag {
        push("weak-validators");
    }
    if input.total_bytes.is_none() {
        push("unknown-size");
    }
    match input.signed_url.state {
        ValidityState::Expiring => push("signed-url-expiring"),
        ValidityState::Expired => push("signed-url-expired"),
        _ => {}
    }
    match input.tls_state {
        Some(ValidityState::Expiring) => push("tls-expiring"),
        Some(ValidityState::Expired) => push("tls-expired"),
        _ => {}
    }
    if input.status == 429 || input.rate_limit.retry_after_secs.is_some() || input.rate_limit.remaining == Some(0) {
        push("rate-limited");
    }
    if input.head_failed {
        push("head-failed");
    }
    if !input.redirects.is_empty() {
        push("redirected");
    }
    if input.content_encoding.is_some_and(|encoding| !encoding.eq_ignore_ascii_case("identity")) {
        push("content-encoding");
    }
    out.into_iter().map(str::to_string).collect()
}

pub struct RecommendationInput<'a> {
    pub range: &'a crate::protocol::RangeFacts,
    pub validators: &'a ValidatorFacts,
    pub signed_url: &'a SignedUrlFacts,
    pub rate_limit: &'a RateLimitFacts,
    pub status: u16,
    pub total_bytes: Option<u64>,
    pub checksum: &'a ChecksumFacts,
}

/// A suggestion with reasons, not enforced policy; missing data degrades to a
/// single stream.
pub fn recommendation(input: &RecommendationInput<'_>) -> Recommendation {
    let range_supported = input.range.supported;
    let single_stream = !range_supported;
    let server_checksum = input.checksum.sha256.is_some() || input.checksum.content_md5.is_some() || input.checksum.content_digest.is_some() || input.checksum.crc32c.is_some();
    let rate_limited = input.status == 429 || input.rate_limit.retry_after_secs.is_some();
    let (start, reason) = if input.signed_url.state == ValidityState::Expired {
        (StartWhen::Avoid, "signed-url-expired".to_string())
    } else if rate_limited {
        (StartWhen::Later, "rate-limited".to_string())
    } else if single_stream {
        (StartWhen::Now, "no-range-support".to_string())
    } else if input.validators.strong_etag {
        (StartWhen::Now, "ranges+strong-etag".to_string())
    } else if input.validators.last_modified.is_some() || input.validators.etag.is_some() {
        (StartWhen::Now, "ranges+weak-validators".to_string())
    } else {
        (StartWhen::Now, "ranges+no-validators".to_string())
    };
    let connections = if single_stream { 1 } else { crate::protocol::DEFAULT_CONNECTIONS };
    let chunk_size_bytes = if single_stream || input.total_bytes.is_none() {
        None
    } else {
        let total = input.total_bytes.unwrap_or(0);
        let floor = crate::protocol::MIN_CHUNK_SIZE.min(total.max(1));
        Some((total / (connections as u64 * 4)).clamp(floor, crate::protocol::MAX_AUTO_CHUNK_SIZE))
    };
    // "unavailable" means the server does not declare any hash we could compare;
    // local hashing is always possible but declared availability is the fact.
    let verify = if server_checksum { VerifyAdvice::Recommended } else { VerifyAdvice::Unavailable };
    Recommendation { start, connections, chunk_size_bytes, single_stream, reason, verify }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::RangeFacts;

    fn url(text: &str) -> url::Url {
        url::Url::parse(text).expect("url")
    }

    fn at(text: &str) -> u64 {
        parse_compact_utc(text).expect("timestamp")
    }

    #[test]
    fn parses_aws_sigv4_and_sigv2() {
        let now = at("20261108T120000Z");
        let sigv4 = url("https://bucket.example.com/app.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20261108T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeef");
        let facts = signed_url_facts(&sigv4, &sigv4, now);
        assert!(facts.signed);
        assert_eq!(facts.source, SignedUrlSource::AwsSigV4);
        assert_eq!(facts.expires_at, Some(now + 3_600_000));
        assert_eq!(facts.expires_in_secs, Some(3600));
        assert_eq!(facts.state, ValidityState::Valid);

        let sigv2 = url("https://bucket.example.com/app.zip?AWSAccessKeyId=AKIAEXAMPLE&Expires=1762990000&Signature=abc");
        let facts = signed_url_facts(&sigv2, &sigv2, 1_762_990_000_000 - 60_000);
        assert!(facts.signed);
        assert_eq!(facts.source, SignedUrlSource::AwsSigV2);
        assert_eq!(facts.expires_at, Some(1_762_990_000_000));
        assert_eq!(facts.expires_in_secs, Some(60));
        assert_eq!(facts.state, ValidityState::Expiring);

        // A SigV4 URL without the signing date cannot derive expiry.
        let incomplete = url("https://bucket.example.com/app.zip?X-Amz-Expires=3600&X-Amz-Signature=abc");
        let facts = signed_url_facts(&incomplete, &incomplete, now);
        assert!(facts.signed);
        assert_eq!(facts.expires_at, None);
        assert_eq!(facts.source, SignedUrlSource::Unknown);
    }

    #[test]
    fn parses_gcs_azure_and_generic_expiry() {
        let now = at("20261108T120000Z");
        let gcs = url("https://storage.googleapis.com/b/app.zip?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Date=20261108T120000Z&X-Goog-Expires=1800&X-Goog-Signature=abc");
        let facts = signed_url_facts(&gcs, &gcs, now);
        assert_eq!(facts.source, SignedUrlSource::GcsSigV4);
        assert_eq!(facts.expires_at, Some(now + 1_800_000));

        let azure = url("https://acct.blob.core.windows.net/c/app.zip?sv=2022-11-02&sp=r&se=2026-11-08T13%3A00%3A00Z&sig=abc");
        let facts = signed_url_facts(&azure, &azure, now);
        assert!(facts.signed);
        assert_eq!(facts.source, SignedUrlSource::AzureSas);
        assert_eq!(facts.expires_at, Some(now + 3_600_000));

        let generic = url("https://cdn.example.com/app.zip?expires=1762990123");
        let facts = signed_url_facts(&generic, &generic, 1_762_990_000_000);
        assert!(!facts.signed);
        assert_eq!(facts.source, SignedUrlSource::GenericExpires);
        assert_eq!(facts.expires_at, Some(1_762_990_123_000));
        assert_eq!(facts.state, ValidityState::Expiring);

        let epoch = url("https://cdn.example.com/app.zip?exp=1762990000");
        assert_eq!(signed_url_facts(&epoch, &epoch, 1_762_990_000_000).expires_at, Some(1_762_990_000_000));

        let http_date = url("https://cdn.example.com/app.zip?Expires=Sun%2C+08+Nov+2026+13%3A00%3A00+GMT");
        assert_eq!(signed_url_facts(&http_date, &http_date, now).expires_at, Some(now + 3_600_000));
    }

    #[test]
    fn final_url_is_authoritative_with_original_fallback() {
        let now = at("20261108T120000Z");
        let original = url("https://short.example.com/go?token=1");
        let final_url = url("https://cdn.example.com/app.zip?X-Amz-Date=20261108T120000Z&X-Amz-Expires=600&X-Amz-Signature=abc");
        let facts = signed_url_facts(&final_url, &original, now);
        assert_eq!(facts.source, SignedUrlSource::AwsSigV4);
        assert_eq!(facts.expires_at, Some(now + 600_000));

        // Final URL has no signing parameters: fall back to the requested URL.
        let bare_final = url("https://cdn.example.com/app.zip");
        let signed_original = url("https://short.example.com/go?Expires=1762990000&Signature=abc");
        let facts = signed_url_facts(&bare_final, &signed_original, 1_762_990_000_000);
        assert!(facts.signed);
        assert_eq!(facts.source, SignedUrlSource::AwsSigV2);
        assert_eq!(facts.expires_at, Some(1_762_990_000_000));
    }

    #[test]
    fn unsigned_and_expired_urls() {
        let plain = url("https://cdn.example.com/app.zip");
        let facts = signed_url_facts(&plain, &plain, 1_000);
        assert!(!facts.signed);
        assert_eq!(facts.source, SignedUrlSource::Unknown);
        assert_eq!(facts.state, ValidityState::Unknown);
        assert_eq!(facts.expires_at, None);

        let expired = url("https://cdn.example.com/app.zip?X-Amz-Date=20261108T120000Z&X-Amz-Expires=60&X-Amz-Signature=x");
        let facts = signed_url_facts(&expired, &expired, at("20261108T120000Z") + 120_000);
        assert_eq!(facts.state, ValidityState::Expired);
        assert!(facts.expires_in_secs.unwrap_or(0) < 0);
    }

    /// Real data (session_logs, 2026-11-09): ModelScope redirect URLs carry
    /// `auth_key=<unix-ts>-<hex>-<0>-<hex>`. It is a signed-URL credential even
    /// though no absolute expiry can be derived from it.
    #[test]
    fn modelscope_auth_key_is_a_signed_url() {
        let signed = url("https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/ca/3b/x?filename=a.gguf&namespace=ukisai&repository=r&revision=master&tag=model&auth_key=1794154377-c6fc216ba8e4466d89b9af721eb2cf8d-0-cb444b28d3878bfbb67e715a719a58f5");
        let facts = signed_url_facts(&signed, &signed, 1_794_154_000_000);
        assert!(facts.signed);
        assert_eq!(facts.expires_at, None);
        assert_eq!(facts.source, SignedUrlSource::Unknown);
        // Plain CDN paths without a token stay unsigned.
        let plain = url("https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/ca/3b/x?filename=a.gguf");
        assert!(!signed_url_facts(&plain, &plain, 1_000).signed);
    }

    #[test]
    fn resume_safety_follows_strong_comparison() {
        let now = at("20261108T120000Z");
        let strong = validator_facts(Some("\"abc\"".into()), Some("Wed, 08 Nov 2026 12:00:00 GMT".into()));
        assert!(strong.strong_etag);
        // A strong ETag plus ranges plus a known length is the only strong case;
        // Last-Modified never upgrades it.
        let resume = resume_facts(true, &strong, true);
        assert_eq!(resume.safety, ResumeSafety::Strong);
        assert_eq!(resume.reason, ResumeReason::StrongEtag);
        assert_eq!(resume_facts(true, &strong, false).safety, ResumeSafety::None);

        let weak = validator_facts(Some("W/\"abc\"".into()), None);
        assert!(!weak.strong_etag);
        let resume = resume_facts(true, &weak, true);
        assert_eq!(resume.safety, ResumeSafety::Weak);
        assert!(resume.possible);
        let resume = resume_facts(true, &validator_facts(None, Some("Wed, 21 Oct 2026 07:28:00 GMT".into())), true);
        assert_eq!(resume.safety, ResumeSafety::Weak);
        assert_eq!(resume.reason, ResumeReason::LastModifiedOnly);
        let resume = resume_facts(true, &validator_facts(None, None), true);
        assert_eq!(resume.safety, ResumeSafety::None);
        assert_eq!(resume.reason, ResumeReason::NoValidators);
        let resume = resume_facts(false, &strong, true);
        assert!(!resume.possible);
        assert_eq!(resume.reason, ResumeReason::NoRangeSupport);
        let _ = now;
    }

    #[test]
    fn if_range_requires_a_quoted_strong_entity_tag() {
        assert_eq!(if_range_etag(Some("\"abc\"")), Some("\"abc\""));
        assert_eq!(if_range_etag(Some("W/\"abc\"")), None);
        assert_eq!(if_range_etag(Some("w/\"abc\"")), None);
        assert_eq!(if_range_etag(Some("abc")), None, "bare token is not an entity-tag");
        assert_eq!(if_range_etag(Some("\"abc")), None, "unterminated quote");
        assert_eq!(if_range_etag(Some("abc\"")), None, "unopened quote");
        assert_eq!(if_range_etag(None), None);
    }

    #[test]
    fn tiny_probe_samples_do_not_report_throughput() {
        assert_eq!(sample_bps(64, 10), None, "64-byte range probe is noise");
        assert_eq!(sample_bps(65_535, 100), None);
        assert_eq!(sample_bps(65_536, 0), None, "no elapsed time");
        assert_eq!(sample_bps(65_536, 1000), Some(65_536));
        assert_eq!(sample_bps(1_048_576, 100), Some(10_485_760));
    }

    #[test]
    fn checksum_and_rate_limit_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("content-md5", "b64md5".parse().unwrap());
        headers.insert("content-digest", "sha-256=:Z29vZA==:".parse().unwrap());
        headers.insert("x-goog-hash", "crc32c=abc123, sha256=Z29vZA==".parse().unwrap());
        headers.insert("x-ratelimit-limit", "100".parse().unwrap());
        headers.insert("x-ratelimit-remaining", "7".parse().unwrap());
        headers.insert("retry-after", "42".parse().unwrap());
        headers.insert("server", "nginx".parse().unwrap());
        headers.insert("cache-control", "max-age=3600".parse().unwrap());
        let checksums = checksum_facts(&headers);
        assert_eq!(checksums.content_digest.as_deref(), Some("sha-256=:Z29vZA==:"));
        assert_eq!(checksums.content_md5.as_deref(), Some("b64md5"));
        assert_eq!(checksums.crc32c.as_deref(), Some("abc123"));
        // GCS x-goog-hash sha256 is NOT a declared SHA-256.
        assert!(checksums.sha256.is_none());
        let limits = rate_limit_facts(&headers);
        assert_eq!(limits.retry_after_secs, Some(42));
        assert_eq!(limits.limit, Some(100));
        assert_eq!(limits.remaining, Some(7));
        let facts = header_facts(&headers);
        assert_eq!(facts.server.as_deref(), Some("nginx"));
        assert_eq!(facts.cache_control.as_deref(), Some("max-age=3600"));
        assert!(facts.date.is_none());

        let mut aws = HeaderMap::new();
        aws.insert("x-amz-checksum-sha256", "Z29vZA==".parse().unwrap());
        aws.insert("x-amz-checksum-crc32c", "AAAAAA==".parse().unwrap());
        let checksums = checksum_facts(&aws);
        assert_eq!(checksums.sha256.as_deref(), Some("Z29vZA=="));
        assert_eq!(checksums.crc32c.as_deref(), Some("AAAAAA=="));
    }

    #[test]
    fn warnings_are_stable_and_bounded() {
        let validators = validator_facts(Some("W/\"1\"".into()), None);
        let signed = SignedUrlFacts { signed: true, expires_at: Some(1), expires_in_secs: Some(30), source: SignedUrlSource::GenericExpires, state: ValidityState::Expiring };
        let rate_limit = RateLimitFacts { retry_after_secs: Some(5), limit: None, remaining: None };
        let redirects = vec![RedirectHop { status: 302, url: "https://cdn.example.com/x".into() }];
        let list = warnings(&WarningsInput {
            range_supported: false,
            validators: &validators,
            total_bytes: None,
            signed_url: &signed,
            tls_state: Some(ValidityState::Expired),
            rate_limit: &rate_limit,
            status: 429,
            head_failed: true,
            redirects: &redirects,
            content_encoding: Some("gzip"),
        });
        assert_eq!(list, vec!["no-range-support", "weak-validators", "unknown-size", "signed-url-expiring", "tls-expired", "rate-limited", "head-failed", "redirected", "content-encoding"]);
        assert!(list.len() <= 12);
    }

    #[test]
    fn recommendation_degrades_to_single_stream() {
        let healthy_range = RangeFacts { supported: true, ..RangeFacts::default() };
        let validators = validator_facts(Some("\"v1\"".into()), None);
        let signed = SignedUrlFacts::default();
        let rate_limit = RateLimitFacts::default();
        let checksum = ChecksumFacts { sha256: Some("abc".into()), ..ChecksumFacts::default() };
        let rec = recommendation(&RecommendationInput { range: &healthy_range, validators: &validators, signed_url: &signed, rate_limit: &rate_limit, status: 200, total_bytes: Some(50_000_000), checksum: &checksum });
        assert_eq!(rec.start, StartWhen::Now);
        assert!(!rec.single_stream);
        assert_eq!(rec.reason, "ranges+strong-etag");
        assert_eq!(rec.verify, VerifyAdvice::Recommended);
        assert!(rec.chunk_size_bytes.is_some());

        let no_range = RangeFacts { supported: false, ..RangeFacts::default() };
        let rec = recommendation(&RecommendationInput { range: &no_range, validators: &validators, signed_url: &signed, rate_limit: &rate_limit, status: 200, total_bytes: None, checksum: &ChecksumFacts::default() });
        assert!(rec.single_stream);
        assert_eq!(rec.connections, 1);
        assert_eq!(rec.chunk_size_bytes, None);
        assert_eq!(rec.verify, VerifyAdvice::Unavailable);

        let expired = SignedUrlFacts { signed: true, expires_at: Some(1), expires_in_secs: Some(-10), source: SignedUrlSource::GenericExpires, state: ValidityState::Expired };
        let rec = recommendation(&RecommendationInput { range: &healthy_range, validators: &validators, signed_url: &expired, rate_limit: &rate_limit, status: 200, total_bytes: Some(10), checksum: &ChecksumFacts::default() });
        assert_eq!(rec.start, StartWhen::Avoid);
        assert_eq!(rec.reason, "signed-url-expired");

        let limited = RateLimitFacts { retry_after_secs: Some(30), limit: None, remaining: None };
        let rec = recommendation(&RecommendationInput { range: &healthy_range, validators: &validators, signed_url: &signed, rate_limit: &limited, status: 429, total_bytes: Some(10), checksum: &ChecksumFacts::default() });
        assert_eq!(rec.start, StartWhen::Later);
        assert_eq!(rec.reason, "rate-limited");
    }
}
