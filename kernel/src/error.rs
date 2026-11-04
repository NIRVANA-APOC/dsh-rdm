use crate::protocol::ErrorInfo;
#[derive(Debug, Clone)]
pub enum EngineError {
    Paused,
    Cancelled,
    Failed(ErrorInfo),
}
impl EngineError {
    pub fn failed(code: &str, message: impl Into<String>) -> Self {
        Self::Failed(ErrorInfo::new(code, message))
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::failed("invalid_request", message)
    }
    pub fn network(message: impl Into<String>) -> Self {
        Self::failed("network", message)
    }
    pub fn http_status(status: u16, url: &str) -> Self {
        Self::failed("http_status", format!("server returned HTTP {status} for {url}"))
    }
    pub fn io(error: impl std::fmt::Display) -> Self {
        Self::failed("io", format!("local file error: {error}"))
    }
    pub fn remote_changed(message: impl Into<String>) -> Self {
        Self::failed("remote_changed", format!("remote file changed: {}", message.into()))
    }
    pub fn checksum(expected: &str, actual: &str) -> Self {
        Self::failed("checksum_mismatch", format!("checksum mismatch: expected {expected}, got {actual}"))
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::failed("internal", message)
    }
    pub fn is_control(&self) -> bool {
        matches!(self, Self::Paused | Self::Cancelled)
    }
    pub fn info(&self) -> ErrorInfo {
        match self {
            Self::Paused => ErrorInfo::new("cancelled", "paused"),
            Self::Cancelled => ErrorInfo::new("cancelled", "cancelled"),
            Self::Failed(info) => info.clone(),
        }
    }
}
pub type EngineResult<T> = Result<T, EngineError>;
