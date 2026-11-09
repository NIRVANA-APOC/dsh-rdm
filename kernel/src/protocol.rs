use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Protocol v2: flat `TaskView` hot path, `TaskDetail` detail path, enriched
/// `ServerFacts` probe result and per-host origin ledger. See
/// docs/design/0.2.0-agent-native.md §2.
pub const PROTOCOL: u32 = 2;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_USER_AGENT: &str = concat!("dsh-rdm/", env!("CARGO_PKG_VERSION"));
pub const DEFAULT_CONNECTIONS: usize = 8;
pub const MIN_CONNECTIONS: usize = 1;
/// Hard ceiling for one task's worker pool. 0.2.1 raises it from 32 to 128 so
/// large objects on high-capacity origins (and the adaptive controller) can use
/// more connections; the HTTP pool, host config, tools and docs share this cap.
pub const MAX_CONNECTIONS: usize = 128;
/// Default adaptive ceiling: the controller may grow from `Spec::connections`
/// up to this value while per-connection throughput shows headroom.
pub const DEFAULT_MAX_CONNECTIONS: usize = 128;
pub const DEFAULT_CHUNK_SIZE: u64 = 4 * 1024 * 1024;
pub const MIN_CHUNK_SIZE: u64 = 256 * 1024;
pub const MAX_CHUNK_SIZE: u64 = 64 * 1024 * 1024;
/// Automatic chunk sizing (`chunkSizeBytes: 0`) targets four chunks per
/// connection, bounded by `MIN_CHUNK_SIZE` and this cap.
pub const MAX_AUTO_CHUNK_SIZE: u64 = 8 * 1024 * 1024;
pub const DEFAULT_MAX_ATTEMPTS: u32 = 6;
pub const EVENT_RING_CAPACITY: usize = 200;
/// A session id is opaque and only needs to be stable and JSON-safe.
pub const SESSION_ID_MAX_LEN: usize = 160;
/// Signed URLs expiring inside this horizon are reported as `expiring`.
pub const SIGNED_URL_EXPIRING_SECS: i64 = 300;
/// TLS certificates expiring inside this horizon are reported as `expiring`.
pub const TLS_EXPIRING_SECS: i64 = 30 * 24 * 60 * 60;
/// Manual redirect chain cap for probe (HEAD/GET, scheme-safe).
pub const MAX_REDIRECTS: usize = 8;
/// Origin ledger cap; least recently seen hosts are evicted past this.
pub const ORIGIN_LEDGER_MAX_HOSTS: usize = 256;

#[rustfmt::skip]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelInfo { pub version: String, pub pid: u32, pub data_dir: String }

impl KernelInfo {
    pub fn current(data_dir: &str) -> Self {
        Self { version: VERSION.to_string(), pid: std::process::id(), data_dir: data_dir.to_string() }
    }
}

#[rustfmt::skip]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub default_dir: Option<String>, pub connections: usize, pub max_connections: usize, pub chunk_size_bytes: u64,
    pub speed_limit_bps: u64, pub max_attempts: u32, pub auto_resume: bool, pub log_level: String,
    pub fsync_on_complete: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self { default_dir: None, connections: DEFAULT_CONNECTIONS, max_connections: DEFAULT_MAX_CONNECTIONS, chunk_size_bytes: 0, speed_limit_bps: 0, max_attempts: DEFAULT_MAX_ATTEMPTS, auto_resume: true, log_level: "warn".to_string(), fsync_on_complete: false }
    }
}

impl Config {
    pub fn normalized(mut self) -> Self {
        self.connections = self.connections.clamp(MIN_CONNECTIONS, MAX_CONNECTIONS);
        self.max_connections = self.max_connections.clamp(self.connections, MAX_CONNECTIONS);
        self.chunk_size_bytes = normalize_chunk_size(self.chunk_size_bytes);
        self.max_attempts = self.max_attempts.max(1);
        self
    }
}

pub fn normalize_chunk_size(value: u64) -> u64 {
    if value == 0 {
        0
    } else {
        value.clamp(MIN_CHUNK_SIZE, MAX_CHUNK_SIZE)
    }
}

/// Opaque agent-session attribution. Empty means "no session".
pub fn normalize_session_id(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > SESSION_ID_MAX_LEN {
        return Err(format!("sessionId must be at most {SESSION_ID_MAX_LEN} characters"));
    }
    if !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')) {
        return Err("sessionId may only contain [A-Za-z0-9._:-]".to_string());
    }
    Ok(Some(value))
}

/// Internal probe/engine snapshot. The public probe result is `ServerFacts`;
/// the engine still uses this compact form to drive a transfer.
#[rustfmt::skip]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub final_url: String, pub file_name: String, pub total_bytes: Option<u64>,
    pub supports_ranges: bool, pub content_type: Option<String>, pub etag: Option<String>,
    pub last_modified: Option<String>, pub http_version: Option<String>,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RequestSpec {
    pub url: String, pub dir: Option<PathBuf>, pub file_name: Option<String>,
    pub connections: Option<usize>, pub max_connections: Option<usize>, pub chunk_size_bytes: Option<u64>,
    pub headers: BTreeMap<String, String>, pub cookie: Option<String>, pub referer: Option<String>,
    pub user_agent: Option<String>, pub expected_sha256: Option<String>,
    pub speed_limit_bps: Option<u64>, pub resume: Option<bool>,
    pub single_stream: bool, pub proxy: Option<String>, pub insecure: bool,
    pub max_attempts: Option<u32>,
    /// Owning agent session. The host fills this from the execution context;
    /// it is omitted for programmatic callers outside a session.
    pub session_id: Option<String>,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub url: String, pub dir: PathBuf, pub file_name: Option<String>, pub connections: usize,
    /// Adaptive worker ceiling for this task (`connections..=MAX_CONNECTIONS`).
    /// Older task records predate it, so a missing value falls back to the
    /// protocol default instead of failing deserialization.
    #[serde(default = "default_max_connections")]
    pub max_connections: usize,
    pub chunk_size_bytes: u64, pub headers: BTreeMap<String, String>, pub cookie: Option<String>,
    pub referer: Option<String>, pub user_agent: Option<String>, pub expected_sha256: Option<String>,
    pub speed_limit_bps: u64, pub resume: bool, pub single_stream: bool, pub proxy: Option<String>,
    pub insecure: bool, pub max_attempts: u32, #[serde(default)] pub fsync_on_complete: bool,
    #[serde(default)] pub session_id: Option<String>,
}

fn default_max_connections() -> usize {
    DEFAULT_MAX_CONNECTIONS
}

impl Spec {
    pub fn resolve(raw: RequestSpec, config: &Config) -> Result<Self, String> {
        let url = url::Url::parse(raw.url.trim()).map_err(|e| format!("invalid url `{}`: {e}", raw.url))?;
        match url.scheme() {
            "http" | "https" => {}
            other => return Err(format!("unsupported url scheme `{other}`")),
        }
        let cwd = || std::env::current_dir().map_err(|error| format!("cwd: {error}"));
        let default_dir = match &config.default_dir {
            Some(dir) => PathBuf::from(dir),
            None => cwd()?,
        };
        let dir = raw.dir.unwrap_or(default_dir);
        let dir = if dir.is_absolute() { dir } else { cwd()?.join(dir) };
        let single_stream = raw.single_stream;
        let connections = if single_stream { 1 } else { raw.connections.unwrap_or(config.connections).clamp(MIN_CONNECTIONS, MAX_CONNECTIONS) };
        // The adaptive cap can never be below the initial population and never
        // above the protocol ceiling. A single stream always stays at one worker.
        let max_connections = if single_stream { 1 } else { raw.max_connections.unwrap_or(config.max_connections).clamp(connections, MAX_CONNECTIONS) };
        let chunk_size_bytes = if single_stream { 0 } else { normalize_chunk_size(raw.chunk_size_bytes.unwrap_or(config.chunk_size_bytes)) };
        let expected_sha256 = match raw.expected_sha256.map(|value| value.trim().to_string()) {
            Some(value) if value.is_empty() => None,
            Some(value) => {
                if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("expectedSha256 must be 64 hexadecimal characters".to_string());
                }
                Some(value.to_ascii_lowercase())
            }
            None => None,
        };
        let session_id = normalize_session_id(raw.session_id)?;
        let file_name = raw.file_name.and_then(|name| {
            let name = name.trim();
            (!name.is_empty()).then(|| name.to_string())
        });
        Ok(Self {
            url: url.to_string(),
            dir,
            file_name,
            connections,
            max_connections,
            chunk_size_bytes,
            headers: raw.headers,
            cookie: raw.cookie.filter(|v| !v.is_empty()),
            referer: raw.referer.filter(|v| !v.is_empty()),
            user_agent: raw.user_agent.filter(|v| !v.is_empty()),
            expected_sha256,
            speed_limit_bps: raw.speed_limit_bps.unwrap_or(config.speed_limit_bps),
            resume: raw.resume.unwrap_or(true),
            single_stream,
            proxy: raw.proxy.filter(|v| !v.is_empty()),
            insecure: raw.insecure,
            max_attempts: raw.max_attempts.unwrap_or(config.max_attempts).max(1),
            fsync_on_complete: config.fsync_on_complete,
            session_id,
        })
    }
    pub fn user_agent(&self) -> &str {
        self.user_agent.as_deref().unwrap_or(DEFAULT_USER_AGENT)
    }
    /// Host of the requested URL (not the post-redirect destination), used for
    /// the flat view and the origin ledger.
    pub fn host(&self) -> String {
        url::Url::parse(&self.url).ok().and_then(|url| url.host_str().map(str::to_string)).unwrap_or_default()
    }
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProbeParams {
    pub url: String, pub headers: BTreeMap<String, String>, pub cookie: Option<String>,
    pub referer: Option<String>, pub user_agent: Option<String>, pub proxy: Option<String>,
    pub insecure: bool, pub timeout_ms: Option<u64>,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status { Queued, Probing, Running, Paused, Completed, Failed, Cancelled, Interrupted }

impl Status {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
    pub fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Probing | Self::Running)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Probing => "probing",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "queued" => Self::Queued,
            "probing" => Self::Probing,
            "running" => Self::Running,
            "paused" => Self::Paused,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "interrupted" => Self::Interrupted,
            _ => return None,
        })
    }
}

// ---------------------------------------------------------------------------
// ServerFacts (§2.1)
// ---------------------------------------------------------------------------

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AcceptRanges { #[default] Unknown, Bytes, None }

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProbedBy { #[default] Head, RangeGet }

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileNameSource { #[default] Url, ContentDisposition }

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumeSafety { #[default] None, Strong, Weak }

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResumeReason {
    StrongEtag, LastModifiedOnly, NoValidators, #[default] NoRangeSupport,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValidityState { Valid, Expiring, Expired, #[default] Unknown }

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum SignedUrlSource {
    #[serde(rename = "aws-sigv4")] AwsSigV4,
    #[serde(rename = "aws-sigv2")] AwsSigV2,
    #[serde(rename = "gcs-sigv4")] GcsSigV4,
    #[serde(rename = "azure-sas")] AzureSas,
    #[serde(rename = "generic-expires")] GenericExpires,
    #[default] #[serde(rename = "unknown")] Unknown,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StartWhen { #[default] Now, Later, Avoid }

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VerifyAdvice { Recommended, Required, #[default] Unavailable }

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EtaConfidence { High, Medium, Low, #[default] Unknown }

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Trend { Rising, Steady, Falling, Stalled, #[default] Unknown }

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RangeFacts {
    pub supported: bool,
    pub accept_ranges: AcceptRanges,
    pub if_range: bool,
    pub probed_by: ProbedBy,
    pub probe_status: Option<u16>,
    pub probe_bytes: u64,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ValidatorFacts {
    pub etag: Option<String>,
    pub strong_etag: bool,
    pub last_modified: Option<String>,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ResumeFacts {
    pub possible: bool,
    pub safety: ResumeSafety,
    pub reason: ResumeReason,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SignedUrlFacts {
    pub signed: bool,
    pub expires_at: Option<u64>,
    pub expires_in_secs: Option<i64>,
    pub source: SignedUrlSource,
    pub state: ValidityState,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TlsFacts {
    pub https: bool,
    pub not_after: Option<u64>,
    pub expires_in_secs: Option<i64>,
    pub issuer: Option<String>,
    pub subject: Option<String>,
    pub state: ValidityState,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RedirectHop {
    pub status: u16,
    pub url: String,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HeaderFacts {
    pub server: Option<String>,
    pub date: Option<String>,
    pub cache_control: Option<String>,
    pub expires: Option<String>,
    pub vary: Option<String>,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RateLimitFacts {
    pub retry_after_secs: Option<u64>,
    pub limit: Option<u64>,
    pub remaining: Option<u64>,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TimingFacts {
    pub probe_ms: u64,
    pub ttfb_ms: Option<u64>,
    pub sample_bps: Option<u64>,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChecksumFacts {
    pub content_digest: Option<String>,
    pub content_md5: Option<String>,
    pub sha256: Option<String>,
    pub crc32c: Option<String>,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Recommendation {
    pub start: StartWhen,
    pub connections: usize,
    pub chunk_size_bytes: Option<u64>,
    pub single_stream: bool,
    pub reason: String,
    pub verify: VerifyAdvice,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OriginFacts {
    pub known: bool,
    pub attempts: u64,
    pub completed: u64,
    pub median_bps: Option<u64>,
    pub best_bps: Option<u64>,
    pub last_error: Option<String>,
    pub last_at: Option<u64>,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerFacts {
    pub url: String,
    pub final_url: String,
    pub host: String,
    pub http_version: Option<String>,
    pub status: u16,
    pub file_name: String,
    pub file_name_source: FileNameSource,
    pub total_bytes: Option<u64>,
    pub content_type: Option<String>,
    pub content_encoding: Option<String>,
    pub content_disposition: Option<String>,
    pub range: RangeFacts,
    pub validators: ValidatorFacts,
    pub resume: ResumeFacts,
    pub signed_url: SignedUrlFacts,
    pub tls: Option<TlsFacts>,
    pub redirects: Vec<RedirectHop>,
    pub headers: HeaderFacts,
    pub rate_limit: RateLimitFacts,
    pub timing: TimingFacts,
    pub checksum: ChecksumFacts,
    pub warnings: Vec<String>,
    pub recommendation: Recommendation,
    pub origin: Option<OriginFacts>,
}

impl ServerFacts {
    /// Compact engine view of the same facts.
    pub fn meta(&self) -> Meta {
        Meta {
            final_url: self.final_url.clone(),
            file_name: self.file_name.clone(),
            total_bytes: self.total_bytes,
            supports_ranges: self.range.supported,
            content_type: self.content_type.clone(),
            etag: self.validators.etag.clone(),
            last_modified: self.validators.last_modified.clone(),
            http_version: self.http_version.clone(),
        }
    }

    /// Protocol projection: credential-bearing query values are replaced with
    /// `<redacted>` in `url`/`finalUrl`. The raw URLs stay inside the kernel for
    /// request/resume; task records on disk keep the raw `Spec` URL.
    pub fn redacted(mut self) -> Self {
        self.url = redact_url(&self.url);
        self.final_url = redact_url(&self.final_url);
        // Redirect hops can carry signed query material too (e.g. ModelScope's
        // `auth_key` on the CDN hop); they are part of the same projection.
        for hop in &mut self.redirects {
            hop.url = redact_url(&hop.url);
        }
        self
    }
}

// ---------------------------------------------------------------------------
// Flat hot-path view (§2.2)
// ---------------------------------------------------------------------------

#[rustfmt::skip]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskView {
    pub id: String,
    pub session_id: Option<String>,
    pub url: String,
    pub host: String,
    pub final_url: Option<String>,
    pub file_name: String,
    pub dir: String,
    pub path: Option<String>,
    pub status: Status,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub percent: Option<u32>,
    pub speed_bps: u64,
    pub speed1s_bps: Option<u64>,
    pub speed5s_bps: Option<u64>,
    pub speed30s_bps: Option<u64>,
    pub speed300s_bps: Option<u64>,
    pub avg_bps: u64,
    pub peak_bps: u64,
    pub eta_secs: Option<u64>,
    pub eta_confidence: EtaConfidence,
    pub stalled_ms: u64,
    pub active_workers: usize,
    pub peak_workers: usize,
    /// Controller's current worker target (0 before the plan phase).
    pub target_workers: usize,
    pub connections: usize,
    /// Connection count requested by the caller (before chunk/worker clamping).
    /// `connections` reports the initial worker population instead.
    pub requested_connections: usize,
    /// Adaptive ceiling for this task (`connections..=MAX_CONNECTIONS`).
    pub max_connections: usize,
    pub chunk_size: Option<u64>,
    pub resumed_chunks: u64,
    pub resumed_bytes: u64,
    /// Bytes transferred by the current run only (excludes resumed bytes), so a
    /// resumed task's rate/avg never inherits the adopted `.part` bytes.
    pub transferred_bytes: u64,
    pub range_supported: Option<bool>,
    pub resumable: bool,
    pub resume_safety: ResumeSafety,
    pub expected_sha256: Option<String>,
    pub sha256: Option<String>,
    pub verified: Option<bool>,
    pub error: Option<ErrorInfo>,
    pub retries: u32,
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub elapsed_ms: u64,
    pub signed_url_expires_at: Option<u64>,
    pub tls_not_after: Option<u64>,
}

impl Default for TaskView {
    fn default() -> Self {
        Self {
            id: String::new(),
            session_id: None,
            url: String::new(),
            host: String::new(),
            final_url: None,
            file_name: String::new(),
            dir: String::new(),
            path: None,
            status: Status::Queued,
            downloaded: 0,
            total: None,
            percent: None,
            speed_bps: 0,
            speed1s_bps: None,
            speed5s_bps: None,
            speed30s_bps: None,
            speed300s_bps: None,
            avg_bps: 0,
            peak_bps: 0,
            eta_secs: None,
            eta_confidence: EtaConfidence::Unknown,
            stalled_ms: 0,
            active_workers: 0,
            peak_workers: 0,
            target_workers: 0,
            connections: 1,
            requested_connections: 0,
            max_connections: DEFAULT_MAX_CONNECTIONS,
            chunk_size: None,
            resumed_chunks: 0,
            resumed_bytes: 0,
            transferred_bytes: 0,
            range_supported: None,
            resumable: false,
            resume_safety: ResumeSafety::None,
            expected_sha256: None,
            sha256: None,
            verified: None,
            error: None,
            retries: 0,
            created_at: 0,
            started_at: None,
            finished_at: None,
            elapsed_ms: 0,
            signed_url_expires_at: None,
            tls_not_after: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Detail path (§2.3)
// ---------------------------------------------------------------------------

#[rustfmt::skip]
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowRates {
    #[serde(rename = "1s")] pub w1s: Option<u64>,
    #[serde(rename = "5s")] pub w5s: Option<u64>,
    #[serde(rename = "30s")] pub w30s: Option<u64>,
    #[serde(rename = "300s")] pub w300s: Option<u64>,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Telemetry {
    pub windows: WindowRates,
    pub peak_bps: u64,
    pub avg_bps: u64,
    pub stalled_ms: u64,
    pub trend: Trend,
    pub eta_confidence: EtaConfidence,
    pub samples: u64,
    pub last_sample_at: Option<u64>,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TargetFacts {
    pub dir: String,
    pub path: Option<String>,
    pub part: Option<String>,
    pub resume_state: Option<String>,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VerificationFacts {
    pub expected_sha256: Option<String>,
    pub sha256: Option<String>,
    pub verified: Option<bool>,
    pub server_checksums: ChecksumFacts,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ResumeStateFacts {
    pub chunks_done: u64,
    pub bytes_done: u64,
    pub resumed_chunks: u64,
    pub resumed_bytes: u64,
    pub validators_matched: bool,
    /// `accepted` | `rejected` | `not-attempted`.
    pub resume_decision: String,
    /// Stable code explaining the decision (see PROTOCOL.md "Resume reasons");
    /// `null` when no decision was made.
    pub resume_reason: Option<String>,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TimingDetail {
    pub queued_ms: u64,
    pub probe_ms: u64,
    pub transfer_ms: u64,
    pub finalize_ms: u64,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Diagnosis {
    pub code: String,
    pub advice: String,
    pub message: String,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskDetail {
    pub telemetry: Telemetry,
    pub server: Option<ServerFacts>,
    pub target: TargetFacts,
    pub verification: VerificationFacts,
    pub resume_state: ResumeStateFacts,
    pub timing: TimingDetail,
    pub diagnosis: Vec<Diagnosis>,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Aggregate {
    pub total: usize,
    pub active: usize,
    pub paused: usize,
    pub failed: usize,
    pub completed: usize,
    pub bytes_downloaded: u64,
    pub now_bps: u64,
    pub w5_bps: Option<u64>,
    pub w30_bps: Option<u64>,
    pub w300_bps: Option<u64>,
    pub risk_count: usize,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorInfo { pub code: String, pub message: String }

impl ErrorInfo {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }
}

#[rustfmt::skip]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub seq: u64, pub at: u64, pub kind: String, pub message: Option<String>,
    pub chunk: Option<u64>, pub attempt: Option<u32>, pub delay_ms: Option<u64>,
}

/// Persisted task record. 0.1.x records deserialize unchanged: every 0.2.0
/// addition is an optional field (`serde` default) and the v1 flat view keys
/// keep their names.
#[rustfmt::skip]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRecord {
    pub spec: Spec,
    #[serde(flatten)] pub view: TaskView,
    /// Full server-facts snapshot so a completed record can be reviewed after
    /// a kernel restart. Missing in 0.1.x records.
    #[serde(default)]
    pub server: Option<ServerFacts>,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64).unwrap_or(0)
}

pub fn percent_of(downloaded: u64, total: Option<u64>) -> Option<u32> {
    let total = total?;
    if total == 0 {
        return Some(if downloaded == 0 { 0 } else { 100 });
    }
    Some(((downloaded.min(total) as u128 * 100) / total as u128) as u32)
}

// ---------------------------------------------------------------------------
// Credential redaction (protocol projections only)
// ---------------------------------------------------------------------------

pub const REDACTED_VALUE: &str = "<redacted>";

/// Query parameters whose values are credentials or bearer material; matched
/// case-insensitively. 0.2.1 adds the Tengine/ModelScope `auth_key` family and
/// the OSS SigV1 parameters after real ModelScope/HF logs exposed them in
/// `finalUrl` and redirect-hop projections.
const CREDENTIAL_QUERY_PARAMS: [&str; 18] = [
    "x-amz-signature", "x-amz-credential", "x-amz-security-token", "signature", "sig", "token", "access_token", "key", "api_key", "secret", "key-pair-id", "x-goog-signature",
    "auth_key", "x-oss-signature", "x-oss-credential", "x-oss-security-token", "osssaccesskeyid", "ossaccesskeyid",
];

pub fn is_credential_param(name: &str) -> bool {
    CREDENTIAL_QUERY_PARAMS.iter().any(|candidate| name.eq_ignore_ascii_case(candidate))
}

/// Replace credential-bearing query values with the literal `<redacted>` while
/// leaving every other byte of the URL untouched. Used for protocol
/// projections (`ServerFacts.url/finalUrl/redirects`, `TaskView.url/finalUrl`);
/// the raw URL is kept internally for requests, resume state and task records.
pub fn redact_url(raw: &str) -> String {
    let Some((base, rest)) = raw.split_once('?') else { return raw.to_string() };
    let (query, fragment) = match rest.split_once('#') {
        Some((query, fragment)) => (query, Some(fragment)),
        None => (rest, None),
    };
    let mut changed = false;
    let pairs: Vec<String> = query
        .split('&')
        .map(|pair| {
            let key = pair.split_once('=').map(|(key, _)| key).unwrap_or(pair);
            let decoded = percent_encoding::percent_decode_str(key).decode_utf8_lossy();
            if is_credential_param(&decoded) {
                changed = true;
                format!("{key}={REDACTED_VALUE}")
            } else {
                pair.to_string()
            }
        })
        .collect();
    if !changed {
        return raw.to_string();
    }
    let mut out = format!("{base}?{}", pairs.join("&"));
    if let Some(fragment) = fragment {
        out.push('#');
        out.push_str(fragment);
    }
    out
}

/// Stable URL identity for resume matching: scheme, host (lowercased), optional
/// port and path. Query and fragment are dropped because CDN/LFS URLs mint a
/// fresh `auth_key`/`Expires`/`Policy` token on every probe — the real-data
/// reason resume was rejected (`.part.json` keyed on the volatile final URL).
/// A URL that cannot be parsed falls back to its raw string, which keeps the
/// exact-match behaviour for unusual inputs.
pub fn url_identity(raw: &str) -> String {
    let Ok(parsed) = url::Url::parse(raw) else { return raw.to_string() };
    let Some(host) = parsed.host_str().filter(|host| !host.is_empty()) else { return raw.to_string() };
    let port = parsed.port().map(|port| format!(":{port}")).unwrap_or_default();
    let path = if parsed.path().is_empty() { "/" } else { parsed.path() };
    format!("{}://{}{}{}", parsed.scheme().to_ascii_lowercase(), host.to_ascii_lowercase(), port, path)
}

fn redact_token(token: &str) -> String {
    let Some(start) = token.find("https://").or_else(|| token.find("http://")) else { return token.to_string() };
    let tail = &token[start..];
    let end = tail.find(|character: char| character.is_whitespace() || matches!(character, ')' | ']' | '}' | '"' | '\'' | '>' | ',' | ';')).unwrap_or(tail.len());
    format!("{}{}{}", &token[..start], redact_url(&tail[..end]), &tail[end..])
}

/// Redact credentials inside free-form diagnostic text (event messages and
/// error messages), because transport errors can echo the request URL.
pub fn redact_text(text: &str) -> String {
    if !text.contains("http") {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut chunk_start = 0;
    for (index, character) in text.char_indices() {
        if character.is_whitespace() {
            out.push_str(&redact_token(&text[chunk_start..index]));
            out.push(character);
            chunk_start = index + character.len_utf8();
        }
    }
    out.push_str(&redact_token(&text[chunk_start..]));
    out
}

#[cfg(test)]
mod redaction_tests {
    use super::*;

    #[test]
    fn redacts_credential_values_in_urls() {
        let raw = "https://bucket.example.com/app.zip?X-Amz-Date=20260101T000000Z&X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA%2Fabc&range=0-10";
        let redacted = redact_url(raw);
        assert!(redacted.contains("X-Amz-Signature=<redacted>"), "{redacted}");
        assert!(redacted.contains("X-Amz-Credential=<redacted>"), "{redacted}");
        // Non-credential parameters and the algorithm/date are preserved.
        assert!(redacted.contains("X-Amz-Date=20260101T000000Z"), "{redacted}");
        assert!(redacted.contains("range=0-10"), "{redacted}");
        assert!(!redacted.contains("deadbeef"));

        let azure = "https://acct.blob.core.windows.net/c/app.zip?sv=2022-11-02&sig=secretvalue&se=2026-11-08T13%3A00%3A00Z";
        let redacted = redact_url(azure);
        assert!(redacted.contains("sig=<redacted>"));
        assert!(!redacted.contains("secretvalue"));
        assert!(redacted.contains("se=2026-11-08T13%3A00%3A00Z"));

        // Case-insensitive matching and no-op when nothing matches.
        let inline = "https://example.com/a?TOKEN=abc&Key=def&plain=1";
        let redacted = redact_url(inline);
        assert!(!redacted.contains("abc") && !redacted.contains("def"), "{redacted}");
        let clean = "https://example.com/a?size=10&name=app.zip";
        assert_eq!(redact_url(clean), clean);
        let no_query = "https://example.com/file.zip";
        assert_eq!(redact_url(no_query), no_query);
    }

    #[test]
    fn redacts_urls_inside_diagnostic_text() {
        let text = "probe HEAD failed: error sending request for url (https://cdn.example.com/a.zip?X-Amz-Signature=abc&token=xyz)";
        let redacted = redact_text(text);
        assert!(!redacted.contains("abc") && !redacted.contains("xyz"), "{redacted}");
        assert!(redacted.contains("<redacted>"));
        assert!(redacted.starts_with("probe HEAD failed:"), "{redacted}");
        assert_eq!(redact_text("no url here"), "no url here");
    }

    #[test]
    fn server_facts_projection_is_redacted() {
        let mut facts = ServerFacts::default();
        facts.url = "https://cdn.example.com/app.zip?token=secret".into();
        facts.final_url = "https://cdn.example.com/app.zip?Signature=abc&expires=1".into();
        facts.redirects = vec![RedirectHop { status: 302, url: "https://cdn.example.com/app.zip?auth_key=1794154377-deadbeef-0-cafe".into() }];
        let projected = facts.redacted();
        assert!(!projected.url.contains("secret"), "{}", projected.url);
        assert!(!projected.final_url.contains("abc"), "{}", projected.final_url);
        assert!(projected.url.contains("<redacted>"));
        assert!(!projected.redirects[0].url.contains("deadbeef"), "{}", projected.redirects[0].url);
        assert!(projected.redirects[0].url.contains("auth_key=<redacted>"));
    }

    /// Real data (session_logs/tasks.json, 2026-11-09): ModelScope redirects to
    /// `cdn-lfs-cn-1.modelscope.cn/...?auth_key=1794154377-...`. The token must
    /// never reach the host projection.
    #[test]
    fn redacts_modelscope_auth_key_but_keeps_the_stable_path() {
        let raw = "https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/ca/3b/302d?filename=a.gguf&namespace=ukisai&repository=r&revision=master&tag=model&auth_key=1794154377-c6fc216ba8e4466d89b9af721eb2cf8d-0-cb444b28d3878bfbb67e715a719a58f5";
        let redacted = redact_url(raw);
        assert!(!redacted.contains("c6fc216ba8e4466d89b9af721eb2cf8d"), "{redacted}");
        assert!(redacted.contains("auth_key=<redacted>"), "{redacted}");
        assert!(redacted.contains("filename=a.gguf"), "{redacted}");
        assert_eq!(url_identity(raw), "https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/ca/3b/302d");
    }

    /// Two probes of the same object return different volatile tokens; their
    /// identities must still match so `.part.json` can resume.
    #[test]
    fn url_identity_ignores_volatile_query_tokens() {
        let first = "https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/ca/3b/302d?auth_key=1794154377-aa-0-bb&filename=a.gguf";
        let second = "https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/ca/3b/302d?auth_key=1794154910-cc-0-dd&filename=a.gguf";
        assert_eq!(url_identity(first), url_identity(second));
        assert_ne!(url_identity(first), url_identity("https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/ff/ff/other"));
        // Host casing / default port / empty path normalize.
        assert_eq!(url_identity("HTTPS://Example.COM:443"), "https://example.com/");
        assert_eq!(url_identity("not a url"), "not a url");
    }
}

