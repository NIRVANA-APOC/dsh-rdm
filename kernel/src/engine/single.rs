use crate::engine::{control_error, finalize, Counters, EngineError, Reporter, STALL_TIMEOUT};
use crate::error::EngineResult;
use crate::http;
use crate::protocol::{Spec, Status};
use crate::rate::TokenBucket;
use crate::source::SourcePool;
use crate::task::{Control, Task};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::time::timeout;
enum AttemptError {
    Stopped,
    Retry { reason: String, retry_after: Option<Duration> },
    Fatal(EngineError),
}
pub async fn run(task: &Arc<Task>, spec: &Spec, pool: &Arc<SourcePool>, total: Option<u64>, target: &Path, part: &Path, state_path: &Path) -> EngineResult<Option<String>> {
    let control = task.control();
    let meta = pool.selected_meta().ok_or_else(|| EngineError::network("no active source for single-stream transfer".to_string()))?;
    let _ = tokio::fs::remove_file(state_path).await;
    task.set_plan(1, None, 0, 0);
    task.set_controller_target(1);
    task.set_status(Status::Running);
    task.add_event("plan", Some(format!("{} bytes; chunks=0 chunk=none; requested={} initial=1 ceiling=1; resumed=0 bytes resume=not-attempted", total.map(|value| value.to_string()).unwrap_or_else(|| "unknown".to_string()), spec.connections)), None, None, None);
    task.record_history_meta(crate::history::MetaRecord {
        kind: "meta".to_string(),
        t: crate::protocol::now_ms(),
        kernel_version: crate::protocol::VERSION.to_string(),
        pid: std::process::id(),
        task_id: task.id.clone(),
        run: task.run_generation(),
        phase: "plan".to_string(),
        url: crate::protocol::redact_url(&spec.url),
        file_name: meta.file_name.clone(),
        total_bytes: total,
        chunk_size: None,
        chunks: None,
        requested_connections: spec.connections,
        initial_workers: 1,
        max_connections: 1,
        resumed_bytes: 0,
        resume_decision: "not-attempted".to_string(),
        resume_reason: None,
    });
    task.add_event("started", Some("transfer started".to_string()), None, None, None);
    if let Some(error) = control_error(&control) {
        return Err(error);
    }
    let limiter = (spec.speed_limit_bps > 0).then(|| Arc::new(TokenBucket::new(spec.speed_limit_bps)));
    let counters = Arc::new(Counters::default());
    let reporter = Reporter::start(Arc::clone(task), Arc::clone(&counters), total, 0);
    let mut attempt = 0u32;
    let mut result: EngineResult<()> = Ok(());
    loop {
        if let Some(error) = control_error(&control) {
            result = Err(error);
            break;
        }
        attempt += 1;
        counters.downloaded.store(0, std::sync::atomic::Ordering::Relaxed);
        let Some(source) = pool.acquire(0) else {
            result = Err(EngineError::network("no healthy source for single-stream transfer".to_string()));
            break;
        };
        let started = Instant::now();
        match attempt_once(task, &control, &source, total, part, &counters, limiter.as_ref()).await {
            Ok(()) => {
                pool.success(source.id, counters.downloaded(), started.elapsed());
                break;
            }
            Err(AttemptError::Stopped) => {
                pool.cancel(source.id);
                result = Err(control_error(&control).unwrap_or(EngineError::Cancelled));
                break;
            }
            Err(AttemptError::Fatal(error)) => {
                pool.failure(source.id, true, &error.info().message);
                result = Err(error);
                break;
            }
            Err(AttemptError::Retry { reason, retry_after }) => {
                pool.failure(source.id, false, &reason);
                let switched = pool.switch_active();
                if let Some(switch) = switched {
                    task.set_sources(pool.snapshot(), Some(switch.to), pool.policy().as_str(), pool.switches());
                    task.add_event("source", Some(format!("switched source {} -> {} after single-stream failure", switch.from, switch.to)), None, None, None);
                    attempt = 0;
                }
                if attempt >= spec.max_attempts.max(1) {
                    result = Err(EngineError::network(format!("single-stream download failed after {attempt} attempts: {reason}")));
                    break;
                }
                task.note_retry();
                let delay = retry_after.unwrap_or_else(|| http::backoff(attempt));
                task.add_event("retry", Some(reason), Some(0), Some(attempt), Some(delay.as_millis().min(u128::from(u64::MAX)) as u64));
                if !control.sleep(delay).await {
                    result = Err(control_error(&control).unwrap_or(EngineError::Cancelled));
                    break;
                }
            }
        }
    }
    reporter.stop().await;
    task.set_sources(pool.snapshot(), Some(pool.active_index()), pool.policy().as_str(), pool.switches());
    let final_bytes = counters.downloaded();
    task.report(final_bytes, final_bytes, total, 0, counters.peak());
    result?;
    let sha = finalize(task, spec, part, state_path, target, total).await?;
    if let Some(total) = total {
        task.report(total, total, Some(total), 0, counters.peak());
    }
    Ok(sha)
}
#[allow(clippy::too_many_arguments)]
async fn attempt_once(task: &Arc<Task>, control: &Arc<Control>, source: &crate::source::SourceRuntime, total: Option<u64>, part: &Path, counters: &Arc<Counters>, limiter: Option<&Arc<TokenBucket>>) -> Result<(), AttemptError> {
    let response = tokio::select! {
        result = source.client().get(&source.meta.final_url).send() => result,
        _ = control.wait_stopped() => return Err(AttemptError::Stopped),
    };
    let mut response = match response {
        Ok(response) => response,
        Err(error) => return Err(AttemptError::Retry { reason: format!("request failed: {error}"), retry_after: None }),
    };
    let status = response.status();
    if !status.is_success() {
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::SERVICE_UNAVAILABLE {
            task.note_throttled();
            return Err(AttemptError::Retry { reason: format!("server returned HTTP {}", status.as_u16()), retry_after: http::retry_after(response.headers()) });
        }
        if http::is_retryable_status(status.as_u16()) {
            return Err(AttemptError::Retry { reason: format!("server returned HTTP {}", status.as_u16()), retry_after: http::retry_after(response.headers()) });
        }
        return Err(AttemptError::Fatal(EngineError::http_status(status.as_u16(), &source.meta.final_url)));
    }
    if let (Some(expected), Some(advertised)) = (total, response.content_length()) {
        if advertised != expected {
            return Err(AttemptError::Fatal(EngineError::remote_changed(format!("advertised length {advertised} differs from probed {expected}"))));
        }
    }
    let mut file = tokio::fs::File::create(part).await.map_err(|error| AttemptError::Fatal(EngineError::io(format!("create .part: {error}"))))?;
    let outcome = stream_body(task, control, &mut response, &mut file, total, counters, limiter).await;
    // `tokio::fs::File` buffers up to 2 MiB of writes internally and polling only
    // spawns the blocking write; `Drop` does not wait for the final buffer. Flush
    // here or `finalize()` can stat a still-short .part (a spurious
    // `remote_changed`) and a retry's `File::create` can truncate the file while
    // a stale write is still in flight.
    if let Err(error) = file.flush().await {
        return Err(AttemptError::Fatal(EngineError::io(format!("flush .part: {error}"))));
    }
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn stream_body(task: &Arc<Task>, control: &Arc<Control>, response: &mut reqwest::Response, file: &mut tokio::fs::File, total: Option<u64>, counters: &Arc<Counters>, limiter: Option<&Arc<TokenBucket>>) -> Result<(), AttemptError> {
    let buffer_limit = super::WRITE_BUFFER_BYTES;
    let mut buffer: Vec<u8> = Vec::with_capacity(buffer_limit);
    let mut received: u64 = 0;
    loop {
        let chunk = tokio::select! {
            result = timeout(STALL_TIMEOUT, response.chunk()) => match result {
                Ok(result) => result,
                Err(_) => {
                    flush(&mut buffer, file, counters).await?;
                    return Err(AttemptError::Retry {
                        reason: format!(
                            "no body data for {} s (stalled connection)",
                            STALL_TIMEOUT.as_secs()
                        ),
                        retry_after: None,
                    });
                }
            },
            _ = control.wait_stopped() => {
                flush(&mut buffer, file, counters).await?;
                return Err(AttemptError::Stopped);
            }
        };
        let bytes = match chunk {
            Ok(Some(bytes)) => bytes,
            Ok(None) => break,
            Err(error) => {
                flush(&mut buffer, file, counters).await?;
                return Err(AttemptError::Retry { reason: format!("body read failed: {error}"), retry_after: None });
            }
        };
        let len = bytes.len() as u64;
        counters.add_net_rx(len);
        if let Some(limiter) = limiter {
            tokio::select! {
                _ = limiter.acquire(len) => {}
                _ = control.wait_stopped() => {
                    flush(&mut buffer, file, counters).await?;
                    return Err(AttemptError::Stopped);
                }
            }
        }
        received += len;
        if let Some(total) = total {
            if received > total {
                return Err(AttemptError::Fatal(EngineError::remote_changed(format!("server sent {received} bytes, more than the advertised {total}"))));
            }
        }
        buffer.extend_from_slice(&bytes);
        if buffer.len() >= buffer_limit {
            flush(&mut buffer, file, counters).await?;
        }
    }
    flush(&mut buffer, file, counters).await?;
    if let Some(total) = total {
        if received != total {
            task.add_event("info", Some(format!("short body: {received} of {total} bytes; retrying")), None, None, None);
            return Err(AttemptError::Retry { reason: format!("single-stream length mismatch: {received} of {total} bytes"), retry_after: None });
        }
    }
    Ok(())
}

async fn flush(buffer: &mut Vec<u8>, file: &mut tokio::fs::File, counters: &Arc<Counters>) -> Result<(), AttemptError> {
    if buffer.is_empty() {
        return Ok(());
    }
    let len = buffer.len() as u64;
    file.write_all(buffer).await.map_err(|error| AttemptError::Fatal(EngineError::io(format!("write .part: {error}"))))?;
    counters.add_downloaded(len);
    buffer.clear();
    Ok(())
}
