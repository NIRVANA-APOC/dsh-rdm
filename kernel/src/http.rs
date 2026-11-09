use crate::error::{EngineError, EngineResult};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, COOKIE, REFERER, RETRY_AFTER, USER_AGENT};
use reqwest::Client;
use std::collections::BTreeMap;
use std::time::{Duration, SystemTime};
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub const READ_TIMEOUT: Duration = Duration::from_secs(60);
pub const BASE_BACKOFF: Duration = Duration::from_millis(1_000);
pub const MAX_BACKOFF: Duration = Duration::from_secs(32);
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(120);
pub struct ClientOptions<'a> {
    pub headers: &'a BTreeMap<String, String>,
    pub cookie: Option<&'a str>,
    pub referer: Option<&'a str>,
    pub user_agent: &'a str,
    pub proxy: Option<&'a str>,
    pub insecure: bool,
    pub connections: usize,
    pub http1_only: bool,
    /// Probe follows redirects manually so the chain can be reported; the
    /// transfer client lets reqwest follow them.
    pub follow_redirects: bool,
}
pub fn build_client(options: ClientOptions<'_>) -> EngineResult<Client> {
    let mut headers = HeaderMap::new();
    for (name, value) in options.headers {
        let header_name = HeaderName::from_bytes(name.trim().as_bytes()).map_err(|_| EngineError::invalid(format!("invalid header name `{name}`")))?;
        let header_value = HeaderValue::from_str(value).map_err(|_| EngineError::invalid(format!("invalid value for header `{name}`")))?;
        headers.insert(header_name, header_value);
    }
    headers.insert(USER_AGENT, HeaderValue::from_str(options.user_agent).map_err(|_| EngineError::invalid("invalid user-agent header value"))?);
    if let Some(referer) = options.referer {
        headers.insert(REFERER, HeaderValue::from_str(referer).map_err(|_| EngineError::invalid("invalid referer header value"))?);
    }
    if let Some(cookie) = options.cookie {
        headers.insert(COOKIE, HeaderValue::from_str(cookie).map_err(|_| EngineError::invalid("invalid cookie header value"))?);
    }
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    let redirect = if options.follow_redirects { reqwest::redirect::Policy::limited(10) } else { reqwest::redirect::Policy::none() };
    let mut builder = Client::builder()
        .default_headers(headers)
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .pool_max_idle_per_host(options.connections.clamp(1, crate::protocol::MAX_CONNECTIONS))
        .redirect(redirect)
        // Needed by probe to read the leaf certificate for `tls.notAfter`.
        .tls_info(true);
    if options.http1_only {
        builder = builder.http1_only();
    }
    if let Some(proxy) = options.proxy {
        let proxy = reqwest::Proxy::all(proxy).map_err(|error| EngineError::invalid(format!("invalid proxy `{proxy}`: {error}")))?;
        builder = builder.proxy(proxy);
    }
    if options.insecure {
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder.build().map_err(|error| EngineError::network(format!("failed to build HTTP client: {error}")))
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContentRange {
    pub start: u64,
    pub end: u64,
    pub total: Option<u64>,
}
pub fn parse_content_range(value: &str) -> Option<ContentRange> {
    let rest = value.trim().strip_prefix("bytes")?.trim_start();
    if let Some(total) = rest.strip_prefix("*/") {
        return Some(ContentRange { start: 0, end: 0, total: Some(total.trim().parse().ok()?) });
    }
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let total = total.trim();
    Some(ContentRange { start: start.trim().parse().ok()?, end: end.trim().parse().ok()?, total: if total == "*" { None } else { Some(total.parse().ok()?) } })
}
pub fn header_string(headers: &HeaderMap, name: reqwest::header::HeaderName) -> Option<String> {
    headers.get(name).and_then(|value| value.to_str().ok()).map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}
pub fn content_length(headers: &HeaderMap) -> Option<u64> {
    header_string(headers, reqwest::header::CONTENT_LENGTH)?.parse().ok()
}
pub fn version_string(version: reqwest::Version) -> Option<String> {
    Some(format!("{version:?}"))
}
pub fn backoff(attempt: u32) -> Duration {
    let shift = attempt.saturating_sub(1).min(5);
    (BASE_BACKOFF * (1u32 << shift)).min(MAX_BACKOFF)
}
pub fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    let value = headers.get(RETRY_AFTER)?.to_str().ok()?.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds).min(MAX_RETRY_AFTER));
    }
    let date = httpdate::parse_http_date(value).ok()?;
    let wait = date.duration_since(SystemTime::now()).unwrap_or(Duration::ZERO);
    Some(wait.min(MAX_RETRY_AFTER))
}
pub fn is_retryable_status(status: u16) -> bool {
    matches!(status, 408 | 425 | 429 | 500 | 502 | 503 | 504)
}

pub fn client_for_spec(spec: &crate::protocol::Spec) -> EngineResult<Client> {
    client_for_spec_with(spec, true)
}

/// Probe client: redirects are followed by `probe` itself so the chain (≤ 8)
/// can be reported in `ServerFacts.redirects`.
pub fn probe_client_for_spec(spec: &crate::protocol::Spec) -> EngineResult<Client> {
    client_for_spec_with(spec, false)
}

pub fn client_for_spec_with(spec: &crate::protocol::Spec, follow_redirects: bool) -> EngineResult<Client> {
    build_client(ClientOptions {
        headers: &spec.headers,
        cookie: spec.cookie.as_deref(),
        referer: spec.referer.as_deref(),
        user_agent: spec.user_agent(),
        proxy: spec.proxy.as_deref(),
        insecure: spec.insecure,
        connections: spec.connections,
        http1_only: !spec.single_stream,
        follow_redirects,
    })
}
