use crate::error::{EngineError, EngineResult};
use crate::filename;
use crate::http::{self, content_length, header_string, parse_content_range, version_string};
use crate::protocol::{Meta, ProbeParams, Spec};
use reqwest::header::{HeaderMap, ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_RANGE, CONTENT_TYPE, ETAG, LAST_MODIFIED, RANGE};
use reqwest::{Client, StatusCode};
#[derive(Debug, Clone, Default)]
struct Snapshot {
    content_length: Option<u64>,
    accept_ranges: Option<bool>,
    content_type: Option<String>,
    etag: Option<String>,
    last_modified: Option<String>,
    content_disposition: Option<String>,
    range_total: Option<u64>,
}
impl Snapshot {
    fn capture(headers: &HeaderMap) -> Self {
        let accept_ranges = headers.get(ACCEPT_RANGES).and_then(|value| value.to_str().ok()).map(|value| value.trim().eq_ignore_ascii_case("bytes"));
        let range_total = headers.get(CONTENT_RANGE).and_then(|value| value.to_str().ok()).and_then(parse_content_range).and_then(|range| range.total);
        Self {
            content_length: content_length(headers),
            accept_ranges,
            content_type: header_string(headers, CONTENT_TYPE),
            etag: header_string(headers, ETAG),
            last_modified: header_string(headers, LAST_MODIFIED),
            content_disposition: header_string(headers, CONTENT_DISPOSITION),
            range_total,
        }
    }
    fn merge(fallback: &Self, primary: &Self) -> Self {
        Self {
            content_length: primary.content_length.or(fallback.content_length),
            accept_ranges: primary.accept_ranges.or(fallback.accept_ranges),
            content_type: primary.content_type.clone().or_else(|| fallback.content_type.clone()),
            etag: primary.etag.clone().or_else(|| fallback.etag.clone()),
            last_modified: primary.last_modified.clone().or_else(|| fallback.last_modified.clone()),
            content_disposition: primary.content_disposition.clone().or_else(|| fallback.content_disposition.clone()),
            range_total: primary.range_total.or(fallback.range_total),
        }
    }
    fn into_meta(self, final_url: String, total_bytes: Option<u64>, supports_ranges: bool, http_version: Option<String>) -> Meta {
        Meta { file_name: filename::derive(self.content_disposition.as_deref(), &final_url), final_url, total_bytes, supports_ranges, content_type: self.content_type, etag: self.etag, last_modified: self.last_modified, http_version }
    }
}
pub async fn probe_with(client: &Client, url: &str, single_stream: bool) -> EngineResult<Meta> {
    let request_url = url::Url::parse(url).map_err(|error| EngineError::invalid(format!("invalid url `{url}`: {error}")))?;
    let head = client.head(request_url.clone()).send().await.map_err(|error| EngineError::network(format!("probe HEAD failed: {error}")))?;
    let status = head.status();
    let final_url = head.url().to_string();
    let http_version = version_string(head.version());
    let snapshot = Snapshot::capture(head.headers());
    drop(head);
    if status.is_success() {
        let length = snapshot.content_length;
        if snapshot.accept_ranges == Some(false) {
            return Ok(snapshot.into_meta(final_url, length, false, http_version));
        }
        if snapshot.accept_ranges == Some(true) && length.is_some() {
            return Ok(snapshot.into_meta(final_url, length, true, http_version));
        }
        if single_stream {
            return Ok(snapshot.into_meta(final_url, length, false, http_version));
        }
        return ranged_fallback(client, request_url, &snapshot).await;
    }
    if matches!(status, StatusCode::FORBIDDEN | StatusCode::METHOD_NOT_ALLOWED | StatusCode::NOT_IMPLEMENTED) {
        if single_stream {
            let length = snapshot.content_length;
            return Ok(snapshot.into_meta(final_url, length, false, http_version));
        }
        return ranged_fallback(client, request_url, &snapshot).await;
    }
    Err(EngineError::http_status(status.as_u16(), &final_url))
}
async fn ranged_fallback(client: &Client, url: url::Url, head: &Snapshot) -> EngineResult<Meta> {
    let response = client.get(url).header(RANGE, "bytes=0-0").send().await.map_err(|error| EngineError::network(format!("probe ranged GET failed: {error}")))?;
    let status = response.status();
    let final_url = response.url().to_string();
    let http_version = version_string(response.version());
    let snapshot = Snapshot::capture(response.headers());
    drop(response);
    let merged = Snapshot::merge(head, &snapshot);
    match status {
        StatusCode::PARTIAL_CONTENT => {
            let total = merged.range_total.or(merged.content_length);
            Ok(merged.into_meta(final_url, total, true, http_version))
        }
        StatusCode::OK => {
            let total = merged.content_length;
            Ok(merged.into_meta(final_url, total, false, http_version))
        }
        StatusCode::RANGE_NOT_SATISFIABLE => {
            let total = merged.range_total;
            Ok(merged.into_meta(final_url, total, false, http_version))
        }
        other => Err(EngineError::http_status(other.as_u16(), &final_url)),
    }
}
pub async fn probe_params(params: &ProbeParams) -> EngineResult<Meta> {
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
    })?;
    let timeout = std::time::Duration::from_millis(params.timeout_ms.unwrap_or(30_000));
    match tokio::time::timeout(timeout, probe_with(&client, &params.url, false)).await {
        Ok(result) => result,
        Err(_) => Err(EngineError::network(format!("probe timed out after {} ms", timeout.as_millis()))),
    }
}
pub async fn probe_spec(client: &Client, spec: &Spec) -> EngineResult<Meta> {
    probe_with(client, &spec.url, spec.single_stream).await
}
