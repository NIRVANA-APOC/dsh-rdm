//! Multi-source pool (0.3.0): candidate HTTP(S) sources for one logical object.
//!
//! The pool owns one `reqwest::Client` per candidate, the selected/active index,
//! per-source health and measured throughput. It deliberately does not own the
//! transfer loop: `engine::chunked` asks for a source per claim and reports the
//! outcome. This keeps the scheduler, controller, telemetry, resume state and
//! finalize transport-neutral while adding mirror selection/failover/racing.
//!
//! Safety rule: bytes from two sources may only be mixed when every usable
//! source has a **strong, equal** content identity (expected SHA-256, a server
//! SHA-256/Content-Digest, or size + strong ETag). `select` is the only policy
//! that may choose one source without that proof, because it never mixes.

use crate::error::{EngineError, EngineResult};
use crate::facts;
use crate::http;
use crate::protocol::{redact_url, Meta, ServerFacts, SourceInput, SourcePolicy, SourceView, Spec, MAX_SOURCES};
use reqwest::header::{CONTENT_RANGE, IF_RANGE, RANGE};
use reqwest::Client;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How strongly the pool can prove that all candidates serve the same bytes.
/// Race never assigns a claim to a source already measured below this fraction
/// of the best healthy source; one slow mirror otherwise owns the long tail.
const RACE_MIN_SCORE_RATIO: f64 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum IdentityStrength {
    None,
    Weak,
    Strong,
}

#[derive(Debug, Clone)]
pub struct ContentIdentity {
    pub key: Option<String>,
    pub strength: IdentityStrength,
}

/// Derive the source-independent content identity for a probe result. This is
/// also what the resume state stores, so a resumed task can continue from a
/// different mirror when the key matches.
pub fn content_identity(spec: &Spec, facts: &ServerFacts) -> ContentIdentity {
    if let Some(expected) = spec.expected_sha256.as_deref() {
        return ContentIdentity { key: Some(format!("sha256:{}", expected.to_ascii_lowercase())), strength: IdentityStrength::Strong };
    }
    if let Some(digest) = facts.checksum.sha256.as_deref().filter(|value| !value.trim().is_empty()) {
        return ContentIdentity { key: Some(format!("sha256:{}", digest.trim().to_ascii_lowercase())), strength: IdentityStrength::Strong };
    }
    match (facts.total_bytes, facts.validators.strong_etag, facts.validators.etag.as_deref()) {
        (Some(total), true, Some(etag)) => ContentIdentity { key: Some(format!("size:{total};etag:{etag}")), strength: IdentityStrength::Strong },
        (Some(total), _, _) => {
            let key = match facts.validators.last_modified.as_deref() {
                Some(modified) => format!("size:{total};mtime:{modified}"),
                None => format!("size:{total}"),
            };
            ContentIdentity { key: Some(key), strength: IdentityStrength::Weak }
        }
        (None, _, _) => ContentIdentity { key: None, strength: IdentityStrength::None },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceState {
    Active,
    Standby,
    Bad,
}

impl SourceState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Standby => "standby",
            Self::Bad => "bad",
        }
    }
}

pub struct SourceRuntime {
    pub id: usize,
    pub input: SourceInput,
    pub facts: ServerFacts,
    pub meta: Meta,
    client: Mutex<Client>,
    if_range: Option<String>,
    role: &'static str,
    state: Mutex<SourceState>,
    bytes: AtomicU64,
    requests: AtomicU64,
    failures: AtomicU32,
    active_requests: AtomicUsize,
    ewma_bps: Mutex<f64>,
    last_error: Mutex<Option<String>>,
    content: ContentIdentity,
}

impl SourceRuntime {
    pub fn url(&self) -> &str {
        &self.input.url
    }

    pub fn client(&self) -> Client {
        self.client.lock().expect("source client mutex poisoned").clone()
    }

    pub fn if_range(&self) -> Option<&str> {
        self.if_range.as_deref()
    }

    pub fn replace_client(&self, client: Client) {
        *self.client.lock().expect("source client mutex poisoned") = client;
    }

    /// Fetch one contiguous range into memory for the hedge window. This is
    /// deliberately bounded (≤ 16 MiB) and only used before the chunk engine
    /// starts; normal transfer traffic stays streaming.
    pub async fn fetch_range(&self, start: u64, len: u64) -> EngineResult<Vec<u8>> {
        if len == 0 || len > 16 * 1024 * 1024 {
            return Err(EngineError::invalid("hedge range must be 1..=16 MiB".to_string()));
        }
        let end = start.saturating_add(len).saturating_sub(1);
        let mut request = self.client().get(self.url()).header(RANGE, format!("bytes={start}-{end}"));
        if let Some(etag) = self.if_range() {
            request = request.header(IF_RANGE, etag);
        }
        let mut response = tokio::time::timeout(Duration::from_secs(30), request.send())
            .await
            .map_err(|_| EngineError::network("hedge request timed out".to_string()))?
            .map_err(|error| EngineError::network(format!("hedge request failed: {error}")))?;
        if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(EngineError::http_status(response.status().as_u16(), self.url()));
        }
        let range = response.headers().get(CONTENT_RANGE).and_then(|value| value.to_str().ok()).and_then(http::parse_content_range);
        let valid = matches!(range, Some(range)
            if range.start == start
                && range.end == end
                && range.total.map(|total| total == self.meta.total_bytes.unwrap_or(total)).unwrap_or(true));
        if !valid {
            return Err(EngineError::network(format!("hedge source returned an unexpected Content-Range for {start}-{end}")));
        }
        let mut out = Vec::with_capacity(len as usize);
        while (out.len() as u64) < len {
            let chunk = tokio::time::timeout(Duration::from_secs(30), response.chunk())
                .await
                .map_err(|_| EngineError::network("hedge body timed out".to_string()))?
                .map_err(|error| EngineError::network(format!("hedge body failed: {error}")))?;
            let Some(chunk) = chunk else { break };
            let remaining = (len - out.len() as u64) as usize;
            out.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        }
        if (out.len() as u64) != len {
            return Err(EngineError::network(format!("hedge source returned {} of {len} bytes", out.len())));
        }
        Ok(out)
    }

    pub fn state_str(&self) -> &'static str {
        self.state.lock().expect("source state mutex poisoned").as_str()
    }

    fn is_healthy(&self) -> bool {
        matches!(*self.state.lock().expect("source state mutex poisoned"), SourceState::Active | SourceState::Standby)
    }

    fn begin_request(&self) {
        self.requests.fetch_add(1, Ordering::Relaxed);
        self.active_requests.fetch_add(1, Ordering::SeqCst);
    }

    fn end_request(&self) {
        self.active_requests.fetch_sub(1, Ordering::SeqCst);
    }

    fn success(&self, bytes: u64, elapsed: std::time::Duration) {
        self.end_request();
        self.bytes.fetch_add(bytes, Ordering::Relaxed);
        self.failures.store(0, Ordering::Relaxed);
        if let Ok(mut error) = self.last_error.lock() {
            *error = None;
        }
        let secs = elapsed.as_secs_f64().max(1e-6);
        let instant = bytes as f64 / secs;
        if instant.is_finite() && instant > 0.0 {
            let mut ewma = self.ewma_bps.lock().expect("source ewma mutex poisoned");
            *ewma = if *ewma <= 0.0 { instant } else { *ewma * 0.7 + instant * 0.3 };
        }
    }

    fn failure(&self, fatal: bool, reason: &str) {
        self.end_request();
        let failures = self.failures.fetch_add(1, Ordering::Relaxed) + 1;
        if let Ok(mut error) = self.last_error.lock() {
            *error = Some(reason.to_string());
        }
        if fatal || failures >= 3 {
            *self.state.lock().expect("source state mutex poisoned") = SourceState::Bad;
        }
    }

    fn score(&self) -> f64 {
        let sample = self.facts.timing.sample_bps.unwrap_or(0) as f64;
        let median = self.facts.origin.as_ref().and_then(|origin| origin.median_bps).unwrap_or(0) as f64;
        let best = self.facts.origin.as_ref().and_then(|origin| origin.best_bps).unwrap_or(0) as f64;
        let measured = *self.ewma_bps.lock().expect("source ewma mutex poisoned");
        // Once a real request has completed, its measured rate is a better
        // predictor than the short probe (the Alpine run saw a mirror probe at
        // ~25 MiB/s but deliver at ~0.2 MiB/s). Before that, fall back to the
        // probe sample and origin history.
        let mut predicted = if measured > 0.0 { measured } else { sample.max(median * 0.8).max(best * 0.5) };
        if predicted <= 0.0 {
            predicted = 1.0;
        }
        if !self.facts.range.supported {
            predicted *= 0.6;
        }
        if let Some(expires_in) = self.facts.signed_url.expires_in_secs {
            if self.facts.signed_url.signed && expires_in < 300 {
                predicted *= 0.5;
            }
        }
        if self.facts.rate_limit.remaining == Some(0) {
            predicted *= 0.25;
        }
        if self.facts.rate_limit.retry_after_secs.is_some() {
            predicted *= 0.25;
        }
        predicted - f64::from(self.failures.load(Ordering::Relaxed)) * 1_000_000.0
    }
}

/// One selection/failover decision surfaced to the task log.
pub struct Switch {
    pub from: usize,
    pub to: usize,
}

pub struct SourcePool {
    sources: Vec<Arc<SourceRuntime>>,
    policy: SourcePolicy,
    active: AtomicUsize,
    switches: AtomicU32,
    content_key: Option<String>,
    identity_strength: IdentityStrength,
    max_per_source: usize,
}

impl SourcePool {
    /// Build the pool from successful probes. `candidates` must preserve the
    /// caller's priority order and include the primary source. At least one
    /// candidate is required.
    pub fn new(spec: &Spec, candidates: Vec<(SourceInput, ServerFacts)>) -> EngineResult<Self> {
        if candidates.is_empty() {
            return Err(EngineError::network("multi-source pool has no successful probe".to_string()));
        }
        let mut sources = Vec::with_capacity(candidates.len());
        for (index, (input, facts)) in candidates.into_iter().enumerate() {
            let source_spec = spec.for_source(&input);
            let client = http::client_for_spec(&source_spec)?;
            let meta = facts.meta();
            let if_range = facts::if_range_etag(meta.etag.as_deref()).map(str::to_string);
            let content = content_identity(spec, &facts);
            let role = if input.url == spec.url { "primary" } else if input.discovered { "discovered" } else { "alternate" };
            sources.push(Arc::new(SourceRuntime {
                id: index,
                input,
                facts,
                meta,
                client: Mutex::new(client),
                if_range,
                role,
                state: Mutex::new(SourceState::Standby),
                bytes: AtomicU64::new(0),
                requests: AtomicU64::new(0),
                failures: AtomicU32::new(0),
                active_requests: AtomicUsize::new(0),
                ewma_bps: Mutex::new(0.0),
                last_error: Mutex::new(None),
                content,
            }));
        }
        let primary_identity = sources[0].content.clone();
        let identity_strength = primary_identity.strength;
        let content_key = primary_identity.key.clone();
        let mix_ok = identity_strength == IdentityStrength::Strong
            && sources.len() >= 2
            && sources.iter().all(|source| source.content.strength == IdentityStrength::Strong && source.content.key.as_deref() == content_key.as_deref());
        // `race`/`failover` are not safe without a strong shared identity;
        // downgrade to a single-source-at-a-time selection instead of silently
        // mixing bytes. `hedge` may still race the first range and then commits
        // to its winner; failover after that is disabled by `may_mix`.
        let policy = match spec.source_policy {
            SourcePolicy::Race | SourcePolicy::Failover if !mix_ok => SourcePolicy::Select,
            other => other,
        };
        let max_per_source = ((spec.max_connections / sources.len()).max(1)).min(crate::protocol::MAX_CONNECTIONS);
        let pool = Self {
            sources,
            policy,
            active: AtomicUsize::new(0),
            switches: AtomicU32::new(0),
            content_key,
            identity_strength,
            max_per_source,
        };
        pool.select_best();
        Ok(pool)
    }

    pub fn len(&self) -> usize {
        self.sources.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sources.is_empty()
    }

    pub fn policy(&self) -> SourcePolicy {
        self.policy
    }

    pub fn identity_strength(&self) -> IdentityStrength {
        self.identity_strength
    }

    pub fn content_key(&self) -> Option<&str> {
        self.content_key.as_deref()
    }

    /// Content key safe to persist in `.part.json`: only a strong identity may
    /// survive a later source switch. A weak size/mtime key would let two
    /// different same-size objects share resume state.
    pub fn resume_content_key(&self) -> Option<&str> {
        (self.identity_strength == IdentityStrength::Strong).then_some(self.content_key.as_deref()).flatten()
    }

    pub fn switches(&self) -> u32 {
        self.switches.load(Ordering::Relaxed)
    }

    /// True when the pool may move bytes between sources (policy allows it and
    /// every source has the same strong content identity).
    pub fn may_mix(&self) -> bool {
        self.policy.may_switch()
            && self.identity_strength == IdentityStrength::Strong
            && self.sources.len() >= 2
            && self.sources.iter().all(|source| source.content.strength == IdentityStrength::Strong && source.content.key.as_deref() == self.content_key.as_deref())
    }

    pub fn active_index(&self) -> usize {
        self.active.load(Ordering::SeqCst).min(self.sources.len().saturating_sub(1))
    }

    pub fn active(&self) -> Option<Arc<SourceRuntime>> {
        self.sources.get(self.active_index()).cloned()
    }

    pub fn source(&self, id: usize) -> Option<Arc<SourceRuntime>> {
        self.sources.get(id).cloned()
    }

    /// Pick the best healthy source, with explicit priority as the tie-breaker.
    pub fn select_best(&self) -> Option<usize> {
        let mut best: Option<(usize, f64, u32)> = None;
        for source in &self.sources {
            if !source.is_healthy() {
                continue;
            }
            let score = source.score();
            let priority = source.input.priority.unwrap_or(u32::MAX);
            let replace = match &best {
                Some((_, best_score, best_priority)) => score > *best_score || (score == *best_score && priority < *best_priority),
                None => true,
            };
            if replace {
                best = Some((source.id, score, priority));
            }
        }
        if let Some((id, _, _)) = best {
            self.active.store(id, Ordering::SeqCst);
            for source in &self.sources {
                if source.is_healthy() {
                    *source.state.lock().expect("source state mutex poisoned") = if source.id == id { SourceState::Active } else { SourceState::Standby };
                }
            }
            Some(id)
        } else {
            None
        }
    }

    /// Move to the best healthy alternate, if any. Returns the switch for the
    /// caller to log/record. Used by failover, hedge commit, controller
    /// collapse recovery and race quarantine.
    pub fn switch_active(&self) -> Option<Switch> {
        if !self.may_mix() {
            return None;
        }
        let previous = self.active_index();
        let mut best: Option<(usize, f64)> = None;
        for source in &self.sources {
            if source.id == previous || !source.is_healthy() {
                continue;
            }
            let score = source.score();
            if best.is_none_or(|(_, best_score)| score > best_score) {
                best = Some((source.id, score));
            }
        }
        let (next, _) = best?;
        self.active.store(next, Ordering::SeqCst);
        self.switches.fetch_add(1, Ordering::Relaxed);
        for source in &self.sources {
            if source.is_healthy() {
                *source.state.lock().expect("source state mutex poisoned") = if source.id == next { SourceState::Active } else { SourceState::Standby };
            }
        }
        Some(Switch { from: previous, to: next })
    }

    /// Force the active source (hedge winner, explicit selection).
    pub fn set_active(&self, id: usize) -> bool {
        let Some(source) = self.source(id) else { return false };
        if !source.is_healthy() {
            return false;
        }
        self.active.store(id, Ordering::SeqCst);
        for source in &self.sources {
            if source.is_healthy() {
                *source.state.lock().expect("source state mutex poisoned") = if source.id == id { SourceState::Active } else { SourceState::Standby };
            }
        }
        true
    }

    /// Healthy sources ordered by their current score (best first). Used by
    /// the hedge race; bounded by `MAX_SOURCES`.
    pub fn top_candidates(&self, limit: usize) -> Vec<Arc<SourceRuntime>> {
        let mut candidates: Vec<Arc<SourceRuntime>> = self.sources.iter().filter(|source| source.is_healthy()).cloned().collect();
        candidates.sort_by(|left, right| {
            right.score().partial_cmp(&left.score()).unwrap_or(std::cmp::Ordering::Equal).then_with(|| left.id.cmp(&right.id))
        });
        candidates.truncate(limit.min(MAX_SOURCES));
        candidates
    }

    /// Race the first range across the two best healthy sources. The winner's
    /// bytes are complete and validated; the loser is cancelled. This is the
    /// v2 hedge: it never mixes bytes, it commits to one source before the
    /// chunk engine starts.
    pub async fn hedge_first_range(&self, start: u64, len: u64) -> Option<(usize, Vec<u8>)> {
        let candidates = self.top_candidates(2);
        if candidates.len() < 2 {
            return None;
        }
        let mut set = tokio::task::JoinSet::new();
        for source in candidates {
            set.spawn(async move {
                let id = source.id;
                (id, source.fetch_range(start, len).await)
            });
        }
        while let Some(joined) = set.join_next().await {
            if let Ok((id, Ok(bytes))) = joined {
                set.abort_all();
                if self.set_active(id) {
                    return Some((id, bytes));
                }
            }
        }
        None
    }

    /// Claim a source for one request. `single`/`select`/`failover`/`hedge`
    /// use the active source; `race` picks the healthiest source under its
    /// per-source connection cap.
    pub fn acquire(&self, claim_start: u64) -> Option<Arc<SourceRuntime>> {
        if self.policy == SourcePolicy::Race {
            return self.acquire_race(claim_start);
        }
        let active = self.active();
        if let Some(source) = active.filter(|source| source.is_healthy()) {
            source.begin_request();
            return Some(source);
        }
        if self.policy.may_switch() {
            if let Some(switch) = self.switch_active() {
                if let Some(source) = self.source(switch.to) {
                    source.begin_request();
                    return Some(source);
                }
            }
        }
        None
    }

    fn acquire_race(&self, _claim_start: u64) -> Option<Arc<SourceRuntime>> {
        // Weighted least-loaded assignment: weights come from the measured
        // score, so a fast mirror gets proportionally more in-flight claims
        // while a slow mirror still receives its share of spare capacity.
        // Picking the single highest score (the first V3 shape) starved every
        // other source when the per-source cap exceeded the worker count; the
        // real Alpine run showed 209 MiB on one source and 0 on the other two.
        let max_score = self
            .sources
            .iter()
            .filter(|source| source.is_healthy())
            .map(|source| source.score())
            .fold(0.0f64, f64::max)
            .max(1.0);
        let minimum_score = max_score * RACE_MIN_SCORE_RATIO;
        let mut best: Option<(usize, f64, f64)> = None; // id, load, score
        for source in &self.sources {
            if !source.is_healthy() {
                continue;
            }
            let score = source.score();
            // Do not hand a race claim to a source already measured far below
            // the best one; it only adds a long-tail chunk and delays the
            // finish (real Alpine 3-mirror run: one 0.2 MiB/s source turned a
            // 2.1 s transfer into 4.0 s).
            if score < minimum_score {
                continue;
            }
            let active = source.active_requests.load(Ordering::SeqCst);
            if active >= self.max_per_source {
                continue;
            }
            let weight = (score / max_score).clamp(0.05, 1.0);
            let load = active as f64 / weight;
            let replace = match best {
                None => true,
                Some((_, best_load, best_score)) => load < best_load || (load == best_load && score > best_score),
            };
            if replace {
                best = Some((source.id, load, score));
            }
        }
        let id = best.map(|(id, _, _)| id).or_else(|| {
            // Every candidate is at its cap (or below the score floor): fall
            // back to the least loaded healthy source so the caller still makes
            // progress; the floor only applies while a better slot exists.
            self.sources.iter().filter(|source| source.is_healthy()).min_by_key(|source| source.active_requests.load(Ordering::SeqCst)).map(|source| source.id)
        })?;
        let source = self.source(id)?;
        source.begin_request();
        Some(source)
    }

    pub fn success(&self, id: usize, bytes: u64, elapsed: std::time::Duration) {
        if let Some(source) = self.source(id) {
            source.success(bytes, elapsed);
        }
    }

    pub fn failure(&self, id: usize, fatal: bool, reason: &str) {
        let mut became_bad = fatal;
        if let Some(source) = self.source(id) {
            source.failure(fatal, reason);
            became_bad = fatal || !source.is_healthy();
        }
        if became_bad && self.may_mix() {
            let _ = self.switch_active();
        }
    }

    /// Abort accounting for a request that was cancelled before completion.
    pub fn cancel(&self, id: usize) {
        if let Some(source) = self.source(id) {
            source.end_request();
        }
    }

    pub fn snapshot(&self) -> Vec<SourceView> {
        let active = self.active_index();
        self.sources
            .iter()
            .take(MAX_SOURCES)
            .map(|source| {
                let host = url::Url::parse(source.url()).ok().and_then(|url| url.host_str().map(str::to_string)).unwrap_or_default();
                let bps = {
                    let measured = *source.ewma_bps.lock().expect("source ewma mutex poisoned");
                    (measured > 0.0).then_some(measured.round() as u64)
                };
                SourceView {
                    id: source.id,
                    url: redact_url(source.url()),
                    host,
                    state: source.state_str().to_string(),
                    role: source.role.to_string(),
                    bytes: source.bytes.load(Ordering::Relaxed),
                    bps,
                    active: source.id == active,
                    last_error: source.last_error.lock().ok().and_then(|error| error.clone()).map(|error| crate::protocol::redact_text(&error)),
                }
            })
            .collect()
    }

    pub fn selected_meta(&self) -> Option<Meta> {
        self.active().map(|source| source.meta.clone())
    }

    pub fn selected_facts(&self) -> Option<ServerFacts> {
        self.active().map(|source| source.facts.clone())
    }

    /// Rebuild the active source's HTTP pool (fresh TCP/TLS) without switching.
    pub fn rebuild_active(&self, spec: &Spec) -> EngineResult<()> {
        let source = self.active().ok_or_else(|| EngineError::network("no active source to rebuild".to_string()))?;
        let source_spec = spec.for_source(&source.input);
        let client = http::client_for_spec(&source_spec)?;
        source.replace_client(client);
        Ok(())
    }

    /// Total bytes observed per source, for tests/diagnostics.
    pub fn bytes_by_source(&self) -> Vec<u64> {
        self.sources.iter().map(|source| source.bytes.load(Ordering::Relaxed)).collect()
    }
}

/// A wall-clock marker for per-request throughput measurement.
pub fn request_started() -> Instant {
    Instant::now()
}
