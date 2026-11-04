use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const PROTOCOL: u32 = 1;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_USER_AGENT: &str = "dsh-rdm/1.0";
pub const DEFAULT_CONNECTIONS: usize = 8;
pub const MIN_CONNECTIONS: usize = 1;
pub const MAX_CONNECTIONS: usize = 32;
pub const DEFAULT_CHUNK_SIZE: u64 = 4 * 1024 * 1024;
pub const MIN_CHUNK_SIZE: u64 = 256 * 1024;
pub const MAX_CHUNK_SIZE: u64 = 64 * 1024 * 1024;
pub const DEFAULT_MAX_ATTEMPTS: u32 = 6;
pub const EVENT_RING_CAPACITY: usize = 200;

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
    pub default_dir: Option<String>, pub connections: usize, pub chunk_size_bytes: u64,
    pub speed_limit_bps: u64, pub max_attempts: u32, pub auto_resume: bool, pub log_level: String,
}

impl Default for Config {
    fn default() -> Self {
        Self { default_dir: None, connections: DEFAULT_CONNECTIONS, chunk_size_bytes: 0, speed_limit_bps: 0, max_attempts: DEFAULT_MAX_ATTEMPTS, auto_resume: true, log_level: "warn".to_string() }
    }
}

impl Config {
    pub fn normalized(mut self) -> Self {
        self.connections = self.connections.clamp(MIN_CONNECTIONS, MAX_CONNECTIONS);
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
    pub connections: Option<usize>, pub chunk_size_bytes: Option<u64>,
    pub headers: BTreeMap<String, String>, pub cookie: Option<String>, pub referer: Option<String>,
    pub user_agent: Option<String>, pub expected_sha256: Option<String>,
    pub speed_limit_bps: Option<u64>, pub resume: Option<bool>,
    pub single_stream: bool, pub proxy: Option<String>, pub insecure: bool,
    pub max_attempts: Option<u32>,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub url: String, pub dir: PathBuf, pub file_name: Option<String>, pub connections: usize,
    pub chunk_size_bytes: u64, pub headers: BTreeMap<String, String>, pub cookie: Option<String>,
    pub referer: Option<String>, pub user_agent: Option<String>, pub expected_sha256: Option<String>,
    pub speed_limit_bps: u64, pub resume: bool, pub single_stream: bool, pub proxy: Option<String>,
    pub insecure: bool, pub max_attempts: u32,
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
        let file_name = raw.file_name.and_then(|name| {
            let name = name.trim();
            (!name.is_empty()).then(|| name.to_string())
        });
        Ok(Self {
            url: url.to_string(),
            dir,
            file_name,
            connections,
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
        })
    }
    pub fn user_agent(&self) -> &str {
        self.user_agent.as_deref().unwrap_or(DEFAULT_USER_AGENT)
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

#[rustfmt::skip]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub id: String, pub url: String, pub final_url: Option<String>, pub file_name: String,
    pub dir: String, pub path: Option<String>, pub status: Status, pub downloaded: u64,
    pub total: Option<u64>, pub speed_bps: u64, pub eta_secs: Option<u64>,
    pub active_workers: usize, pub peak_workers: usize, pub connections: usize,
    pub chunk_size: Option<u64>, pub resumed_chunks: u64, pub range_supported: Option<bool>,
    pub expected_sha256: Option<String>, pub sha256: Option<String>, pub error: Option<ErrorInfo>,
    pub retries: u32, pub created_at: u64, pub started_at: Option<u64>,
    pub finished_at: Option<u64>, pub elapsed_ms: u64, pub resumable: bool,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRecord {
    pub spec: Spec, #[serde(flatten)] pub view: TaskView,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64).unwrap_or(0)
}
