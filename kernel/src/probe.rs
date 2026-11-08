//! Probe: manual redirect chain + range proof + `ServerFacts` (§2.1, §5.2).
//!
//! The probe follows redirects itself (≤ 8, http/https only) so the chain is
//! reportable, proves byte-range support with one 64-byte ranged GET, reads the
//! TLS leaf from the final response and derives the pure facts in `facts`.
//! Timing values are measured, never estimated.

use crate::error::{EngineError, EngineResult};
use crate::facts::{self, RecommendationInput, WarningsInput};
use crate::filename;
use crate::http::{self, content_length, header_string, parse_content_range, version_string};
use crate::protocol::{now_ms, AcceptRanges, Meta, OriginFacts, ProbeParams, ProbedBy, RangeFacts, RedirectHop, ServerFacts, Spec, MAX_REDIRECTS};
use crate::tls;
use reqwest::header::{HeaderMap, ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_ENCODING, CONTENT_RANGE, CONTENT_TYPE, ETAG, LAST_MODIFIED, LOCATION, RANGE};
use reqwest::{Client, Method, Response, StatusCode};
use std::time::{Duration, Instant};
use url::Url;

/// One ranged GET proves range support and samples throughput; 64 bytes keeps
/// the probe cheap even on metered origins.
pub const PROBE_RANGE_HEADER: &str = "bytes=0-63";
const PROBE_SAMPLE_BYTES: usize = 64;
const PROBE_BODY_TIMEOUT: Duration = Duration::from_secs(5);

/// The probe result plus the compact engine metadata derived from it.
pub struct ProbeOutcome {
    pub facts: ServerFacts,
    pub meta: Meta,
}

struct Fetched {
    status: u16,
    url: Url,
    version: Option<String>,
    headers: HeaderMap,
    tls_der: Option<Vec<u8>>,
    ttfb: Duration,
    redirects: Vec<RedirectHop>,
    response: Option<Response>,
}

/// Follow redirects manually, recording each hop; only http(s) targets are
/// followed, and the chain is capped at `MAX_REDIRECTS`.
async fn fetch(client: &Client, start: &Url, method: Method, range: Option<&str>) -> EngineResult<Fetched> {
    let mut current = start.clone();
    let mut redirects: Vec<RedirectHop> = Vec::new();
    loop {
        let started = Instant::now();
        let mut request = client.request(method.clone(), current.clone());
        if let Some(range) = range {
            request = request.header(RANGE, range);
        }
        let response = request.send().await.map_err(|error| EngineError::network(format!("probe {method} failed: {error}")))?;
        let ttfb = started.elapsed();
        let status = response.status();
        let version = version_string(response.version());
        let headers = response.headers().clone();
        let tls_der = response.extensions().get::<reqwest::tls::TlsInfo>().and_then(|info| info.peer_certificate().map(|der| der.to_vec()));
        let final_url = response.url().clone();
        if status.is_redirection() {
            if redirects.len() >= MAX_REDIRECTS {
                return Err(EngineError::network(format!("probe exceeded {MAX_REDIRECTS} redirects")));
            }
            let Some(location) = header_string(&headers, LOCATION) else {
                return Ok(Fetched { status: status.as_u16(), url: final_url, version, headers, tls_der, ttfb, redirects, response: Some(response) });
            };
            let next = final_url.join(&location).map_err(|error| EngineError::network(format!("invalid redirect location `{location}`: {error}")))?;
            if !matches!(next.scheme(), "http" | "https") {
                return Err(EngineError::network(format!("refusing redirect to unsupported scheme `{}`", next.scheme())));
            }
            redirects.push(RedirectHop { status: status.as_u16(), url: next.to_string() });
            drop(response);
            current = next;
            continue;
        }
        return Ok(Fetched { status: status.as_u16(), url: final_url, version, headers, tls_der, ttfb, redirects, response: Some(response) });
    }
}

#[derive(Debug, Clone, Default)]
struct Snapshot {
    content_length: Option<u64>,
    accept_ranges_raw: Option<String>,
    content_type: Option<String>,
    content_encoding: Option<String>,
    etag: Option<String>,
    last_modified: Option<String>,
    content_disposition: Option<String>,
    range_total: Option<u64>,
}

impl Snapshot {
    fn capture(headers: &HeaderMap) -> Self {
        let range_total = headers.get(CONTENT_RANGE).and_then(|value| value.to_str().ok()).and_then(parse_content_range).and_then(|range| range.total);
        Self {
            content_length: content_length(headers),
            accept_ranges_raw: header_string(headers, ACCEPT_RANGES),
            content_type: header_string(headers, CONTENT_TYPE),
            content_encoding: header_string(headers, CONTENT_ENCODING),
            etag: header_string(headers, ETAG),
            last_modified: header_string(headers, LAST_MODIFIED),
            content_disposition: header_string(headers, CONTENT_DISPOSITION),
            range_total,
        }
    }
    fn merge(fallback: &Self, primary: &Self) -> Self {
        Self {
            content_length: primary.content_length.or(fallback.content_length),
            accept_ranges_raw: primary.accept_ranges_raw.clone().or_else(|| fallback.accept_ranges_raw.clone()),
            content_type: primary.content_type.clone().or_else(|| fallback.content_type.clone()),
            content_encoding: primary.content_encoding.clone().or_else(|| fallback.content_encoding.clone()),
            etag: primary.etag.clone().or_else(|| fallback.etag.clone()),
            last_modified: primary.last_modified.clone().or_else(|| fallback.last_modified.clone()),
            content_disposition: primary.content_disposition.clone().or_else(|| fallback.content_disposition.clone()),
            range_total: primary.range_total.or(fallback.range_total),
        }
    }
}

/// Read at most `limit` bytes from the ranged response and measure the sample
/// throughput; a body read failure only clears `sampleBps`.
async fn read_sample(response: &mut Response, limit: usize) -> (u64, Option<u64>) {
    let started = Instant::now();
    let mut total = 0u64;
    while total < limit as u64 {
        match tokio::time::timeout(PROBE_BODY_TIMEOUT, response.chunk()).await {
            Ok(Ok(Some(chunk))) => {
                total += chunk.len() as u64;
            }
            _ => break,
        }
    }
    let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    (total, facts::sample_bps(total, elapsed_ms))
}

/// Probe `url` and return the complete `ServerFacts`. `origin` is the ledger
/// snapshot for the requested host (null when never seen).
pub async fn probe_with(client: &Client, url: &str, origin: Option<OriginFacts>) -> EngineResult<ProbeOutcome> {
    let started = Instant::now();
    let now = now_ms();
    let request_url = Url::parse(url).map_err(|error| EngineError::invalid(format!("invalid url `{url}`: {error}")))?;

    // HEAD first: cheap metadata, and it carries the TLS leaf too.
    let mut head_failed = false;
    let head = match fetch(client, &request_url, Method::HEAD, None).await {
        Ok(fetched) if fetched.status >= 200 && fetched.status < 300 => Some(fetched),
        Ok(fetched) if matches!(fetched.status, 403 | 405 | 501) => {
            head_failed = true;
            None
        }
        Ok(fetched) => return Err(EngineError::http_status(fetched.status, fetched.url.as_str())),
        Err(_) => {
            head_failed = true;
            None
        }
    };

    // Decide whether a ranged GET is needed to prove ranges. `Accept-Ranges:
    // none` is trusted (HEAD-only); everything else is proven by the GET.
    let head_snapshot = head.as_ref().map(|fetched| Snapshot::capture(&fetched.headers)).unwrap_or_default();
    let head_accept = facts::accept_ranges(head_snapshot.accept_ranges_raw.as_deref());
    let should_prove_ranges = !matches!(head_accept, AcceptRanges::None);
    let mut ranged: Option<Fetched> = None;
    let mut range_failure: Option<EngineError> = None;
    if should_prove_ranges {
        let start_url = head.as_ref().map(|fetched| fetched.url.clone()).unwrap_or_else(|| request_url.clone());
        match fetch(client, &start_url, Method::GET, Some(PROBE_RANGE_HEADER)).await {
            Ok(fetched) => ranged = Some(fetched),
            Err(error) => range_failure = Some(error),
        }
    }
    if head.is_none() && ranged.is_none() {
        return Err(range_failure.unwrap_or_else(|| EngineError::network("probe failed: HEAD and ranged GET both failed".to_string())));
    }

    let mut supported = false;
    let mut probed_by = ProbedBy::Head;
    let mut probe_status: Option<u16> = None;
    let mut probe_bytes = 0u64;
    let mut sample_bps: Option<u64> = None;
    let primary_status;
    let snapshot;
    let final_url;
    let http_version;
    let mut redirects;
    let tls_der;
    let header_map;
    let ttfb;

    let mut degrade_range = false;
    if let Some(candidate) = ranged.as_mut() {
        let status = candidate.status;
        probed_by = ProbedBy::RangeGet;
        probe_status = Some(status);
        match status {
            code if code == StatusCode::PARTIAL_CONTENT.as_u16() => {
                supported = true;
                if let Some(response) = candidate.response.as_mut() {
                    let (bytes, bps) = read_sample(response, PROBE_SAMPLE_BYTES).await;
                    probe_bytes = bytes;
                    sample_bps = bps;
                }
            }
            code if code == StatusCode::OK.as_u16() => supported = false,
            code if code == StatusCode::RANGE_NOT_SATISFIABLE.as_u16() => supported = false,
            _ => {
                if head.is_none() {
                    return Err(range_failure.unwrap_or_else(|| EngineError::http_status(status, candidate.url.as_str())));
                }
                // The ranged GET is unusable but HEAD answered; degrade to
                // HEAD facts with unproven range support.
                degrade_range = true;
                probed_by = ProbedBy::Head;
                probe_status = None;
            }
        }
    }
    if degrade_range {
        ranged = None;
    }
    if let Some(ranged) = ranged.as_ref() {
        primary_status = match head.as_ref() {
            Some(head) => head.status,
            None => {
                if ranged.status == StatusCode::PARTIAL_CONTENT.as_u16() {
                    200
                } else {
                    ranged.status
                }
            }
        };
        let ranged_snapshot = Snapshot::capture(&ranged.headers);
        snapshot = Snapshot::merge(&head_snapshot, &ranged_snapshot);
        final_url = ranged.url.to_string();
        http_version = ranged.version.clone();
        // The HEAD chain is the request chain from the requested URL; a
        // ranged GET starts at the HEAD destination and can only add hops.
        redirects = head.as_ref().map(|fetched| fetched.redirects.clone()).unwrap_or_default();
        for hop in &ranged.redirects {
            if !redirects.iter().any(|existing| existing.url == hop.url) {
                redirects.push(hop.clone());
            }
        }
        tls_der = ranged.tls_der.clone().or_else(|| head.as_ref().and_then(|fetched| fetched.tls_der.clone()));
        header_map = ranged.headers.clone();
        ttfb = Some(ranged.ttfb);
    } else {
        let Some(head) = head.as_ref() else {
            return Err(range_failure.unwrap_or_else(|| EngineError::network("probe failed: no usable response".to_string())));
        };
        primary_status = head.status;
        snapshot = head_snapshot.clone();
        final_url = head.url.to_string();
        http_version = head.version.clone();
        redirects = head.redirects.clone();
        tls_der = head.tls_der.clone();
        header_map = head.headers.clone();
        ttfb = Some(head.ttfb);
    }

    let total_bytes = snapshot.range_total.or(snapshot.content_length);
    let final_url_parsed = Url::parse(&final_url).unwrap_or_else(|_| request_url.clone());
    let accept_ranges = facts::accept_ranges(snapshot.accept_ranges_raw.as_deref());
    let validators = facts::validator_facts(snapshot.etag.clone(), snapshot.last_modified.clone());
    let resume = facts::resume_facts(supported, &validators, total_bytes.is_some());
    let signed_url = facts::signed_url_facts(&final_url_parsed, &request_url, now);
    let https = request_url.scheme() == "https";
    let tls_facts = tls::tls_facts(https, tls_der.as_deref(), now);
    let checksum = facts::checksum_facts(&header_map);
    let rate_limit = facts::rate_limit_facts(&header_map);
    let headers = facts::header_facts(&header_map);
    let content_disposition = snapshot.content_disposition.clone();
    let file_name = filename::derive(content_disposition.as_deref(), &final_url);
    let file_name_source = facts::file_name_source(content_disposition.as_deref());
    let range = RangeFacts { supported, accept_ranges, if_range: facts::if_range_etag(validators.etag.as_deref()).is_some(), probed_by, probe_status, probe_bytes };
    let warnings = facts::warnings(&WarningsInput {
        range_supported: supported,
        validators: &validators,
        total_bytes,
        signed_url: &signed_url,
        tls_state: tls_facts.as_ref().map(|facts| facts.state),
        rate_limit: &rate_limit,
        status: primary_status,
        head_failed,
        redirects: &redirects,
        content_encoding: snapshot.content_encoding.as_deref(),
    });
    let recommendation = facts::recommendation(&RecommendationInput { range: &range, validators: &validators, signed_url: &signed_url, rate_limit: &rate_limit, status: primary_status, total_bytes, checksum: &checksum });
    let host = request_url.host_str().unwrap_or_default().to_string();
    let facts = ServerFacts {
        url: request_url.to_string(),
        final_url,
        host,
        http_version,
        status: primary_status,
        file_name,
        file_name_source,
        total_bytes,
        content_type: snapshot.content_type.clone(),
        content_encoding: snapshot.content_encoding.clone(),
        content_disposition,
        range,
        validators,
        resume,
        signed_url,
        tls: tls_facts,
        redirects,
        headers,
        rate_limit,
        timing: crate::protocol::TimingFacts { probe_ms: started.elapsed().as_millis() as u64, ttfb_ms: ttfb.map(|value| value.as_millis() as u64), sample_bps },
        checksum,
        warnings,
        recommendation,
        origin,
    };
    let meta = facts.meta();
    Ok(ProbeOutcome { facts, meta })
}

pub async fn probe_params(params: &ProbeParams) -> EngineResult<ProbeOutcome> {
    if params.url.trim().is_empty() {
        return Err(EngineError::invalid("url is required"));
    }
    let user_agent = params.user_agent.as_deref().unwrap_or(crate::protocol::DEFAULT_USER_AGENT);
    let client = http::build_client(http::ClientOptions {
        headers: &params.headers,
        cookie: params.cookie.as_deref(),
        referer: params.referer.as_deref(),
        user_agent,
        proxy: params.proxy.as_deref(),
        insecure: params.insecure,
        connections: 4,
        http1_only: false,
        follow_redirects: false,
    })?;
    let timeout = Duration::from_millis(params.timeout_ms.unwrap_or(30_000));
    match tokio::time::timeout(timeout, probe_with(&client, &params.url, None)).await {
        Ok(result) => result,
        Err(_) => Err(EngineError::network(format!("probe timed out after {} ms", timeout.as_millis()))),
    }
}

pub async fn probe_spec(client: &Client, spec: &Spec, origin: Option<OriginFacts>) -> EngineResult<ProbeOutcome> {
    probe_with(client, &spec.url, origin).await
}
