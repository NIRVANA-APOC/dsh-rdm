use crate::kernel::{ApiError, Kernel, StatusFilter};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
#[derive(Debug, Deserialize)]
pub struct RequestEnvelope {
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}
pub fn parse_request(line: &str) -> Result<RequestEnvelope, (Value, ApiError)> {
    match serde_json::from_str::<RequestEnvelope>(line) {
        Ok(envelope) => {
            if envelope.id.is_null() && !line.contains("\"id\"") {
                return Err((Value::Null, ApiError::invalid("request envelope is missing an id")));
            }
            Ok(envelope)
        }
        Err(error) => Err((Value::Null, ApiError::invalid(format!("invalid JSON: {error}")))),
    }
}
pub fn success_line(id: &Value, result: Value) -> String {
    json!({ "id": id, "ok": true, "result": result }).to_string()
}
pub fn error_line(id: &Value, error: &ApiError) -> String {
    json!({
        "id": id,
        "ok": false,
        "error": { "code": error.code, "message": error.message },
    })
    .to_string()
}
fn object_params(params: Value) -> Value {
    if params.is_null() {
        Value::Object(serde_json::Map::new())
    } else {
        params
    }
}
fn parse<T: DeserializeOwned>(params: Value, method: &str) -> Result<T, ApiError> {
    serde_json::from_value(object_params(params)).map_err(|error| ApiError::invalid(format!("invalid params for `{method}`: {error}")))
}
fn required_url(url: &str) -> Result<(), ApiError> {
    if url.trim().is_empty() {
        Err(ApiError::invalid("url is required"))
    } else {
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ListParams {
    status: Option<StatusFilter>,
    session_id: Option<String>,
    limit: Option<usize>,
}
impl Default for ListParams {
    fn default() -> Self {
        Self { status: None, session_id: None, limit: None }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetParams {
    id: String,
    #[serde(default)]
    events: Option<usize>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaitParams {
    ids: Vec<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlParams {
    id: String,
    action: String,
    #[serde(default)]
    delete_part: bool,
}
pub async fn dispatch(kernel: &Kernel, method: &str, params: Value) -> Result<Value, ApiError> {
    match method {
        "initialize" => {
            // The host sends `protocol` in its initialize params; a stale host
            // talking to a 1.1.0 kernel is refused with a stable code (§5.7).
            let protocol = params.get("protocol").and_then(Value::as_u64).map(|value| value as u32);
            let config = parse(params, method)?;
            kernel.initialize(config, protocol).await
        }
        "probe" => {
            let params: crate::protocol::ProbeParams = parse(params, method)?;
            required_url(&params.url)?;
            kernel.probe(params).await
        }
        "start" => {
            let params: crate::protocol::RequestSpec = parse(params, method)?;
            required_url(&params.url)?;
            kernel.start(params).await
        }
        "list" => {
            let params: ListParams = parse(params, method)?;
            let statuses = match params.status {
                Some(filter) => Some(filter.parse()?),
                None => None,
            };
            let limit = params.limit.unwrap_or(50).clamp(1, 200);
            Ok(kernel.list(statuses, params.session_id.as_deref(), limit))
        }
        "get" => {
            let params: GetParams = parse(params, method)?;
            let events = params.events.unwrap_or(50).min(EVENT_LIMIT);
            kernel.get(&params.id, events)
        }
        "wait" => {
            let params: WaitParams = parse(params, method)?;
            if params.ids.is_empty() || params.ids.len() > 20 {
                return Err(ApiError::invalid("ids must contain 1..20 task ids"));
            }
            let timeout = params.timeout_ms.unwrap_or(60_000).clamp(100, 300_000);
            kernel.wait(&params.ids, timeout).await
        }
        "control" => {
            let params: ControlParams = parse(params, method)?;
            kernel.control(&params.id, &params.action, params.delete_part).await
        }
        "stats" => Ok(kernel.stats()),
        "shutdown" => {
            kernel.shutdown().await;
            Ok(json!({}))
        }
        other => Err(ApiError::invalid(format!("unknown method `{other}`"))),
    }
}
const EVENT_LIMIT: usize = 500;
