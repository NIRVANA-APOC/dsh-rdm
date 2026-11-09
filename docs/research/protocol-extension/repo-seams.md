# Repo seams: what it costs to teach the rdm kernel a second protocol

Scope: code-grounded analysis of the resident Rust kernel in this repository
(`kernel/`, `rdm-kernel` 0.2.2, wire protocol 2, HTTP/HTTPS only) and of the
TypeScript host that gates and renders it. This note answers *where HTTP is
assumed*, *what the minimal source abstraction should be*, *what changes on the
wire/tool/config surface*, *what it costs in tests/build/size*, and *per-family
effort*. Read-only analysis: no kernel source, test or other doc was modified,
and no cargo build/test was run.

Evidence conventions: `path:line` points at the code that proves the claim.
Statements marked **(inference)** follow from reading the code but were not
executed; **(open question)** is a design/ownership decision I could not settle
from the repo. A sibling task owns crate selection and real-world protocol
demand; this note only records the *dependency-policy and size constraints* those
choices must satisfy.

Ground truth for versioning: the kernel reports `PROTOCOL = 2` and version
`0.2.2` (`kernel/src/protocol.rs:8-9`); the ready frame carries both
(`kernel/src/main.rs:73`); the host pins protocol equality at every handshake
(`src/kernel-client.ts:1643-1649`, `1827-1837`, `2263-2264`).

---

## 0. TL;DR

1. **Scheme admission is cheap; semantics are not.** There are only two gates:
   the host's `assertHttpUrl` (`src/kernel-client.ts:527-546`) and the kernel's
   `Spec::resolve` scheme match (`kernel/src/protocol.rs:148-153`). Everything
   expensive sits *behind* them: `probe` is an HTTP header/status state machine
   (`kernel/src/probe.rs`), `ServerFacts` is an HTTP vocabulary
   (`kernel/src/protocol.rs:457-482`), and the two transfer loops speak
   `reqwest`/`Content-Range` directly (`kernel/src/engine/chunked.rs:585-692`,
   `kernel/src/engine/single.rs:99-198`).
2. **Most of the transfer machinery is already transport-neutral.** `scheduler.rs`,
   `plan.rs`, `rate.rs`, `telemetry.rs`, `controller.rs`, `history.rs`,
   `engine/mod.rs::finalize`, and the `.part`/`.part.json` mechanics never touch
   HTTP. `chunked.rs` has **seven** HTTP call sites and `single.rs` **one request
   site + status/length handling**; those are the only places a byte-range
   abstraction must reach.
3. **`ServerFacts` must grow a discriminator + nullable status + new enum
   values.** It currently *requires* `status: u16` and `http_version`, and its
   `range/probedBy/acceptRanges/fileNameSource/signedUrl/tls` fields are HTTP
   vocabulary (`kernel/src/protocol.rs:269-307`, `330-482`). Tool output schemas
   are closed (`objectNode(..., false)` at `src/tools.ts:708-710`), so a kernel
   that emits new fields against an old host schema fails Harness output
   validation (`src/tool-def.ts:12-18`, `272-284`). Kernel and plugin ship
   together (same version, `docs/ARCHITECTURE.md:80`), but this is the argument
   for a **protocol 3 bump** when the first non-HTTP scheme lands.
4. **Cheapest sequence from the code's perspective:** Phase 0 seam refactor
   (HTTP-only, no wire change) → FTP/FTPS and S3-native credentials (both reuse
   the byte-range engine) → HLS as a *virtual byte stream* over the existing
   single-stream loop → SFTP (new transport stack) → DASH / BitTorrent (new
   engines, multi-file wire).
5. **Size/build is the sleeper constraint.** The shipped model is exactly **one
   binary per platform for five targets** (`bin/*` are 4.03–4.86 MiB / 4.2–5.1 MB
   today), all built natively, no cross-compilation
   (`.github/workflows/prebuilt-kernels.yml:28-29,50-68`), and the release asserts
   exactly five kernels (`:169-174`, `:406-410`). An SSH/BitTorrent dependency
   subtree can plausibly 1.5–3× the binary; `scripts/verify-kernels.mjs:33` only
   enforces a *minimum* size, so nothing in CI stops that. Add a size budget as
   part of the extension work.

---

## 1. HTTP coupling map: URL in → completed file out

Stages S0–S10: one request's path through the code, with what a non-HTTP source
would hit.

### S0 — host admission (tools + browser route)

| Where | What it does | Non-HTTP consequence |
|---|---|---|
| `src/kernel-client.ts:527-546` | `assertHttpUrl`: parse with WHATWG `URL`, reject any protocol other than `http:`/`https:` | **hard block before the kernel ever sees the URL** |
| `src/kernel-client.ts:632` | `normalizeRequestSpec` uses `assertHttpUrl(raw.url)` | `start` (tools + `POST /api/dsh-rdm/api {"action":"start"}`, `src/host-api.ts:210-212`) rejected |
| `src/kernel-client.ts:2040-2041` | `probe()` uses `assertHttpUrl(url)` | `rdm_probe` rejected |
| `src/tools.ts:1335,1340,1460,1464` | tool descriptions/params say "Absolute http:// or https:// URL" | model is told only HTTP(S) exists |

This is the **single host choke point**: one function with two direct call sites
(`start` spec normalization and `probe`; the browser route reuses
`normalizeRequestSpec`). It must become capability-driven (see §4.1) but is not a
structural obstacle.

### S1 — kernel admission

`kernel/src/protocol.rs:147-203` `Spec::resolve`:

* `url::Url::parse(raw.url.trim())` (line 149), then
  `match url.scheme() { "http"|"https" => {}, other => Err(...) }`
  (lines 150-153) — **the only kernel scheme gate**, and it only guards `start`.
* The URL is normalized back to a string (line 183), so an `ftp://user:pass@host/x`
  URL survives into `Spec.url` with credentials intact.
* `Spec::host()` (`protocol.rs:209-211`) parses the URL again and returns
  `host_str()`; works for `ftp://`/`sftp://`/`s3://` (authority present), returns
  `""` for opaque URLs such as `magnet:?xt=…` **(inference from the `url` crate's
  non-special-scheme behaviour; not executed)**.
* `probe` does **not** go through `Spec::resolve`; `probe_params`
  (`kernel/src/probe.rs:321-342`) only checks non-empty, then builds an HTTP
  client. A `probe` of `ftp://…` therefore fails as a *transport* error
  (`network`, via `probe.rs:146-175`), not as `invalid_request` — an asymmetry
  worth fixing regardless of extension.

### S2 — probe (the HTTP state machine)

`kernel/src/probe.rs` is HTTP end to end:

* HEAD first, then fall back to a ranged GET on 403/405/501 (`:146-157`);
* range proof is one `Range: bytes=0-63` GET, 64-byte body sample (`:19-23`,
  `:159-172`, `:197-204`);
* `Accept-Ranges` is read and `none` is trusted (`:162-163` →
  `kernel/src/facts.rs:169-175`);
* metadata comes from `Content-Length`/`Content-Range`/`ETag`/`Last-Modified`/
  `Content-Disposition`/`Content-Type`/`Content-Encoding`
  (`:92-118`, `kernel/src/http.rs:60-100`);
* redirects are followed manually by parsing `Location`, capped at 8, with a
  scheme whitelist `"http" | "https"` (`:34-35`, `:44-78`, gate at `:68-70`);
* response status/version are `reqwest::StatusCode`/`Version` (`:55-56`,
  `kernel/src/http.rs:82-84`);
* TLS leaf comes from `reqwest::tls::TlsInfo` response extensions (`:58`), then
  is DER-walked in `kernel/src/tls.rs:224-232`;
* the result is assembled field by field in `:291-316`.

Non-HTTP impact: **`probe_with` cannot be reused**. Each family needs its own
probe, but it should still return the same `ProbeOutcome { facts, meta }` type
(`kernel/src/probe.rs:26-29`) so the engine's contract is unchanged.

### S3 — fact derivation (`kernel/src/facts.rs`)

Pure functions over HTTP headers/URL query:

| Fact | Code | Protocol assumption |
|---|---|---|
| signed-URL expiry | `facts.rs:114-163` | HTTP query params (`X-Amz-*`, `X-Goog-*`, Azure `se`, `auth_key`) |
| `Accept-Ranges` | `facts.rs:169-175` | `bytes`/`none` HTTP vocabulary |
| `If-Range` validator | `facts.rs:193-203` | quoted strong HTTP entity-tag |
| resume safety | `facts.rs:212-229` | RFC 9110 strong comparison |
| file-name source | `facts.rs:231-237` | Content-Disposition vs URL |
| checksums | `facts.rs:249-270` | `Content-Digest`, `Content-MD5`, `x-amz-checksum-*`, `x-goog-hash` |
| rate limit | `facts.rs:272-283` | `Retry-After`, `x-ratelimit-*` |
| warnings | `facts.rs:313-354` | includes `head-failed`, `content-encoding` |
| recommendation | `facts.rs:368-398` | reasons like `ranges+strong-etag`, `no-range-support` |

Most of this is **HTTP-provider-local** and can stay where it is once `probe.rs`
becomes the HTTP implementation. The protocol-neutral residue is
`resume_facts`, `recommendation`, `sample_bps`, and `validity_state` — those can
be shared by every source.

### S4 — plan / engine selection

`kernel/src/engine/mod.rs:197-230`:

* build the transfer client and probe client from the spec (`:199-200`);
* probe, store facts, derive `Meta` (`:206-216`);
* create the destination directory, resolve the target name
  (`filename::resolve_target`, `:217-222`);
* choose the engine: **chunked iff `total_bytes` known AND `supports_ranges` AND
  not `single_stream`, else single-stream** (`:226-229`).

All four drivers are protocol-neutral; only the client construction is HTTP.
`Meta` (`kernel/src/protocol.rs:99-108`) is the compact engine view
(`final_url`, `file_name`, `total_bytes`, `supports_ranges`, `content_type`,
`etag`, `last_modified`, `http_version`) and is the natural place to add a
protocol/identity discriminator.

### S5 — transfer loops (the real coupling)

**Chunked** (`kernel/src/engine/chunked.rs`) — the seven HTTP sites:

1. `Shared` holds **`reqwest::Client`** and a raw URL string, plus an `if_range`
   string (`:27-63`, client accessor `:82-84`; fields set at `:337-347`).
2. Per-claim request construction: `client.get(&url).header(RANGE, "bytes=start-end")`
   and optional `IF_RANGE` (`:585-590`).
3. Status/`Content-Range` validation:
   `StatusCode::PARTIAL_CONTENT`, parse `Content-Range`, require exact
   `start`/`end`/`total` (`:613-631`).
4. `200 OK` → downgrade to single stream (`:670-672` → `:424-428`).
5. `416` → fatal `remote_changed` (`:673-676`).
6. `429/503` + `Retry-After` pushback and retry classification
   (`:677-692`; helpers `kernel/src/http.rs:89-100`).
7. Body streaming over `reqwest::Response::chunk()` (`:711-785`).

Everything else in that file — scheduler claims, counters, adaptive controller,
reporter, resume save/load, fsync, finalize — is transport-neutral. The pool
rebuild effect is the eighth HTTP-shaped spot: `ControllerEffect::RebuildPool`
is mapped to `http::client_for_spec(&shared.spec)` (`:485-491`).

**Single stream** (`kernel/src/engine/single.rs`) — one request site plus
response plumbing: `client.get(&meta.final_url)` (`:99`), status classification
(`:106-116`), `response.content_length()` check (`:117-121`), body
`response.chunk()` loop (`:136-198`). The retry loop, token bucket, reporter and
finalize around it are neutral (`:18-95`).

### S6 — finalize / verify (already neutral)

`kernel/src/engine/mod.rs:231-259`: stat `.part`, compare to advertised total,
optional fsync, optional SHA-256 (`:242-254`), atomic rename (`:255`), remove
resume state (`:256`). Works for any source that can produce a byte-accurate
`.part`.

### S7 — naming

`kernel/src/filename.rs:6-19`: Content-Disposition first, then last URL path
segment (`:164-173`), then sanitize (`:46-69`), then collision numbering that
prefers an existing `.part.json` (`:70-91`). URL-path naming works for
`ftp://`, `sftp://`, `s3://` objects **(inference: `url` crate path segments)**;
it does **not** work for `magnet:`/torrent metadata (no path), and would name an
HLS output after the playlist (`index.m3u8`) unless the source supplies a name.

### S8 — resume state and identity

* `.part` / `.part.json` naming and atomic save are neutral
  (`kernel/src/state.rs:198-259`).
* The schema is HTTP-shaped: `url`, `final_url`, `etag`, `last_modified`,
  `chunk_size`, `completed_ranges`, `downloaded_bytes`, controller target, plus
  query-stripped `url_identity`/`final_url_identity` (`state.rs:39-63`).
* Compatibility is decided on ETag → Last-Modified → same requested URL → same
  final path (`state.rs:118-161`); a weak-but-stable `Last-Modified` + same path
  is enough (`:148-150`).
* `url_identity` strips query and fragment, keeps scheme/host/port/path
  (`kernel/src/protocol.rs:847-853`); non-parseable inputs fall back to the raw
  string (so a `magnet:` identity would be the whole magnet URI — wrong identity
  for torrents).

Good news: FTP `MDTM` or SFTP `mtime` can be rendered into `Meta.last_modified`
and the *existing weak-resume path* works unchanged, if the provider supplies
identity. Bad news: strong conditional ranges (`If-Range`) are HTTP-specific, so
non-HTTP resume is "weak" by construction unless the protocol has an equivalent
precondition.

### S9 — task store / projection / wire

* `Task::set_server` copies HTTP facts into the flat view
  (`final_url`, `total`, `range_supported`, `resume_safety`,
  `signed_url_expires_at`, `tls_not_after`) — `kernel/src/task.rs:455-471`.
* `TaskView` has one `path` (`protocol.rs:521-574`, `:529`) and a `host`
  (`:751` in `task.rs` uses `Spec::host()`).
* `TaskDetail.target` has one `{dir, path, part, resumeState}`
  (`protocol.rs:659-665`).
* `TaskRecord` persists the whole `Spec` — including headers/cookie
  (`protocol.rs:766-773`, `task.rs:861-867`; documented at `PROTOCOL.md:214-217`).
* Kernel RPC `start` eagerly builds an HTTP client before creating the task
  (`kernel/src/kernel.rs:246-262`, client at `:249`) — a non-HTTP spec would fail
  here even before the engine.
* `probe` recomputes `host` from `facts.url` and then reads the origin ledger
  (`kernel.rs:235-245`); `spawn_engine` keys the ledger on `spec.host()`
  (`:263-272`); terminal transitions record on `view.host` (`:306-317`).
  `OriginLedger::record` ignores an empty host (`kernel/src/origins.rs:136-148`),
  so hostless schemes (magnet) silently lose origin learning, while authority
  schemes (ftp/sftp/s3) keep it.
* Wire dispatch: `kernel/src/rpc.rs:102-163` (`probe` `:111-115`, `start`
  `:116-120`); unknown method → `unsupported_method` (`:158-162`).

### S10 — redaction (a security gap for URL-embedded credentials)

* `ServerFacts::redacted` replaces credential **query** values only
  (`kernel/src/protocol.rs:499-511`, `810-839`).
* URL **userinfo** (`ftp://user:pass@host/…`) is left untouched: `redact_url`
  splits on `?` and only rewrites query pairs (`:810-839`), and the projected
  `url` comes from `request_url.to_string()` (`kernel/src/probe.rs:292`), which
  keeps userinfo. `TaskView.url` goes through the same function
  (`kernel/src/task.rs:750`).
* `redact_text` only recognizes links beginning with `http://`/`https://`
  (`protocol.rs:855-879`), so a transport error message echoing
  `ftp://user:pass@host` is **not redacted** and would reach event messages,
  `error.message` (`task.rs:652-656`) and the recording (`history.rs`).
* In contrast, `url_identity` *does* drop userinfo and query (`:847-853`), so
  identity is safe while projections are not.

### 1.1 Break inventory (the short list)

| HTTP assumption | Where | Breaks for |
|---|---|---|
| host scheme whitelist | `kernel-client.ts:527-546`; `protocol.rs:148-153` | every new scheme |
| HEAD + ranged-GET probe | `probe.rs:139-319` | FTP/SFTP/HLS/torrent |
| `Location` redirects | `probe.rs:44-78` | FTP (no redirects), magnet, sftp |
| `Content-Range`/206/416/200 semantics | `probe.rs:192-218`; `chunked.rs:613-692` | FTP (`REST`), SFTP (seek), WebDAV ok |
| `ETag`/`Last-Modified`/`If-Range` | `facts.rs:193-229`; `chunked.rs:342,588-590` | FTP (`MDTM` weak), SFTP (weak), torrent (piece hashes) |
| `Content-Disposition` filename | `filename.rs:6-19`; `probe.rs:273-275` | FTP/SFTP listings, torrent metadata, playlists |
| `Accept-Ranges` vocabulary | `facts.rs:169-175`; `protocol.rs:269` | every non-HTTP source |
| checksum/rate-limit headers | `facts.rs:249-283` | FTP (`XMD5`?), SFTP (none), torrent (piece hashes) |
| TLS from `reqwest` extension | `probe.rs:58`; `tls.rs:224-232` | FTPS/SFTP certs (different transport) |
| HTTP status as `u16` | `protocol.rs:462`; receipts `tools.ts:298-300,338` | every non-HTTP source |
| single output file | `protocol.rs:529,659-665`; `engine/mod.rs:251-256` | BitTorrent/containers |
| `reqwest::Client` in engine | `chunked.rs:27-63`; `single.rs:18,99` | every non-HTTP source |
| URL/query redaction | `protocol.rs:810-879` | FTP/SFTP userinfo, URL-embedded keys |
| host-keyed origin ledger | `origins.rs:136-148`; `kernel.rs:266,315` | magnet/hostless schemes |
| tool text + UI labels | `tools.ts:1335,1340,1460,1464`; `drawer.tsx:325-332`; `locale/*.json:100-101,105,249` | every non-HTTP source |

### 1.2 What is already transport-neutral (do not touch)

Verified by reading and by grepping `kernel/src` for `https?|scheme|Url::parse|url::Url`:

* `kernel/src/scheduler.rs` — byte-range claim queue, coalescing, tail stealing
  (`:1-195`); ranges are `(start,end)` `u64` only.
* `kernel/src/plan.rs` — chunk math, splitting, covered-chunk accounting
  (`:1-62`).
* `kernel/src/rate.rs` — token bucket (41 lines; no HTTP tokens in the grep).
* `kernel/src/telemetry.rs` — trailing-window rates (290 lines; no HTTP tokens).
* `kernel/src/controller.rs` — rate/worker state machine; only `RebuildPool`
  (`:91-100`) is HTTP-named, and the engine decides what rebuilding means.
* `kernel/src/history.rs` — JSONL sample/event/meta recording (`:31-120`).
* `kernel/src/log.rs`, `kernel/src/error.rs` structure, `kernel/src/tls.rs`
  DER walk (X.509 dates/names) — reusable for FTPS/SFTP leaf certs.
* `kernel/src/engine/mod.rs:231-282` — finalize/prepare/sync/hash.
* `kernel/src/state.rs` merge/load/save mechanics (identity injection is the
  only change).
* `kernel/src/task.rs` telemetry/event/status machinery (projection of server
  facts is the only change).
* `kernel/src/diagnosis.rs` rules (HTTP-flavored codes/messages to review, but
  the state inputs are neutral).
* `kernel/src/rpc.rs` dispatch (same methods; params grow).

---

## 2. A minimal Source seam

### 2.1 Invariants to preserve (from `PROTOCOL.md:716-772`)

1. Byte-level correctness: every ranged response is validated against the
   expected range/total before writing (`PROTOCOL.md:748-750`; code
   `chunked.rs:613-631`).
2. Final size equals advertised total; `.part` → target is one atomic rename
   (`engine/mod.rs:231-259`).
3. Resume safety is a reported fact, not a guess (`resume.safety/reason`,
   `protocol.rs:353-357`, `facts.rs:212-229`).
4. Telemetry is measured from bytes written; the reporter/controller do not know
   the transport (`engine/mod.rs:148-180`, `task.rs:579-634`).
5. Cooperative pause/cancel + bounded memory + stdout reserved for protocol.

A seam that preserves 1–5 can be introduced **without any wire change** while
HTTP remains the only implementation. That is Phase 0.

### 2.2 Trait sketch (no new dependencies; object-safe)

Deliberately hand-rolled futures instead of `async fn` in traits: the crate has
no `async-trait`, and `tls.rs:1-7` states the dependency set is frozen. Returning
`Pin<Box<dyn Future + Send>>` keeps `dyn Source` object-safe on stable Rust.

```rust
// kernel/src/source.rs  (new)
use crate::error::{EngineError, EngineResult};
use crate::probe::ProbeOutcome;
use crate::protocol::{Meta, OriginFacts, Spec};
use std::pin::Pin;
use std::time::Duration;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme { Http, Https, Ftp, Ftps, Sftp, S3, Magnet, Ipfs, /* … */ }

impl Scheme {
    pub fn from_url(url: &url::Url) -> Option<Self>;      // replaces protocol.rs:150-153
    pub fn supports_range_engine(self) -> bool;           // engine hint for §3.1
}

/// One protocol backend for one task. Built from the resolved `Spec`
/// (credentials included) by the registry; never rebuilt per chunk.
pub trait Source: Send + Sync {
    fn scheme(&self) -> Scheme;

    /// Same contract as today's `probe_spec`: return full facts + compact meta.
    fn probe(&self, spec: &Spec, origin: Option<OriginFacts>) -> BoxFut<'_, EngineResult<ProbeOutcome>>;

    /// One byte range. `validator` is the resume precondition, if the protocol
    /// has one (HTTP `If-Range`; FTP/SFTP ignore it and resume weakly).
    fn open_range(&self, req: RangeRequest<'_>) -> BoxFut<'_, EngineResult<RangeReply>>;

    /// Whole-object stream, unknown length allowed (today's single-stream path).
    fn open_stream(&self) -> BoxFut<'_, EngineResult<RangeReply>>;

    /// Stable identity for `.part.json` matching. Default: today's
    /// `protocol::url_identity(meta.final_url)`.
    fn resource_identity(&self, meta: &Meta) -> String {
        crate::protocol::url_identity(&meta.final_url)
    }

    /// Controller collapse recovery: fresh pool / new session (no-op otherwise).
    fn rebuild(&self) -> EngineResult<()> { Ok(()) }
}

pub struct RangeRequest<'a> {
    pub start: u64,
    pub end: u64,                    // exclusive, as `Claim` is (scheduler.rs:67-88)
    pub validator: Option<&'a str>,  // strong ETag only, as if_range_etag() yields
}

pub enum RangeReply {
    Partial { start: u64, end: u64, total: Option<u64>, content_type: Option<String>, body: BodyStream },
    /// Source ignored the range / has no ranges: caller falls back to single.
    Full { total: Option<u64>, body: BodyStream },
    /// No bytes for this range (HTTP 416, FTP 550 on REST): fatal for the task.
    Unsatisfiable { reason: String },
    /// Transient: engine retries with its own budget/backoff.
    Retry { after: Option<Duration>, reason: String },
}
```

`RangeReply::Partial` replaces the `Content-Range` re-derivation in
`chunked.rs:613-631`: the *provider* proves the range (HTTP parses the header;
FTP knows the REST offset; SFTP read exactly `end-start` bytes), and the engine
keeps the same invariant by comparing `RangeReply::Partial.start/end/total`
against the claim. `RangeReply::Full` preserves the 200-downgrade path
(`chunked.rs:670-672`). `Retry` preserves `retry_schedule` + `Retry-After`
(`chunked.rs:695-710`, `http.rs:89-100`).

Body abstraction, also dependency-free:

```rust
pub enum BodyStream {
    /// HTTP provider only; keeps the existing stall/select loop semantics.
    Http(reqwest::Response),
    /// FTP data socket, SFTP handle, file handle, segment concat, …
    Io(Box<dyn tokio::io::AsyncRead + Send + Unpin>),
}

impl BodyStream {
    pub async fn next_chunk(&mut self) -> EngineResult<Option<Vec<u8>>>;
}
```

`tokio::io::AsyncRead` is already in the feature set (`tokio … "io-util"`,
`kernel/Cargo.toml:20`) and `AsyncReadExt` is already imported
(`engine/mod.rs:14`), so `Io` costs no dependency. The HTTP variant leaks
`reqwest` into `source.rs`; if that is unacceptable, swap it for a private
`Box<dyn Body>` with the same `next_chunk` method — the trait stays clean and the
HTTP type is private to the HTTP provider. (open question: aesthetic, not
functional.)

Registry / construction, replacing `http::client_for_spec` at every engine call
site:

```rust
pub fn source_for(spec: &Spec) -> EngineResult<Box<dyn Source>>;
pub fn probe_source_for(params: &ProbeParams) -> EngineResult<Box<dyn Source>>;
```

### 2.3 Module-by-module map

| Module | Verdict | Change |
|---|---|---|
| `scheduler.rs`, `plan.rs`, `rate.rs`, `telemetry.rs`, `history.rs`, `log.rs` | **unchanged** | none |
| `controller.rs` | unchanged policy | `RebuildPool` stays; the engine maps it to `Source::rebuild` |
| `tls.rs` | unchanged | reused for FTPS/SFTP leaf facts (its input is DER, not HTTP) |
| `error.rs` | additive | new stable codes/messages for non-HTTP failures; `http_status` stays |
| `filename.rs` | small | add a name source; `sanitize`/`resolve_target` untouched |
| `state.rs` | small | inject source-provided identity; optional new `version` if fields change (`STATE_VERSION`, `state.rs:5`) |
| `task.rs` | small | `set_server` copies the few neutral fields it needs; add protocol/multi-output projection |
| `diagnosis.rs` | small | protocol-neutral warnings; review `no-range`/`weak-validators` wording |
| `origins.rs` | small | key by source identity (host for authority schemes, info-hash for magnet) |
| `rpc.rs` | unchanged | same methods; `RequestSpec`/`ProbeParams` grow optional fields |
| `protocol.rs` | **medium** | scheme registry, `protocol` discriminator, nullable status, enum variants, credential objects, identity, redaction |
| `http.rs` | **medium** | keep header helpers; wrap `build_client`/`ContentRange`/backoff into `HttpSource` |
| `probe.rs` | **medium** | becomes `HttpSource::probe` (code mostly moved, not rewritten) |
| `engine/mod.rs` | small | `source_for(spec)` instead of two clients; everything else stays |
| `engine/chunked.rs` | **medium** | 7 fetch sites → `source.open_range`/`body.next_chunk`; `Shared.client` → `Arc<dyn Source>`; `if_range` → `validator` |
| `engine/single.rs` | **medium** | 1 request + status/length → `source.open_stream`/`RangeReply` |
| `kernel.rs` | small | provider dispatch in `probe`/`start`; origin identity |
| **new** `source.rs` + `source/http.rs` | new | trait + HTTP impl (thin wrapper over `http.rs`/`probe.rs`) |

### 2.4 Engine diff shape (estimate, not measured)

* `chunked.rs`: `Shared.client/url/if_range` fields `:27-63`; `client()` `:82-84`;
  `Shared` init `:337-367`; `download_claim` request/response block `:585-692`;
  `stream_body` signature/loop `:711-785`; rebuild `:485-491`. Roughly 150–220
  lines touched of 795.
* `single.rs`: `run`/`attempt_once` signatures `:18,97`; request + status +
  length `:99-121`; `stream_body` `:136-198`. Roughly 60–90 lines of 209.
* `engine/mod.rs`: `:197-230` only.
* The scheduler plan (`plan.rs`), claim boundaries and resume files are untouched,
  which is why Phase 0 is a refactor rather than a redesign.

(Estimate marked **(inference)**; line counts are from reading the files, not from
a patch.)

### 2.5 Identity and resume

Two small changes make the existing resume machinery usable for new protocols:

1. `ResumeState::new` (`state.rs:66-82`) currently derives both identities from
   raw URL strings. Pass in the source identity (or a `ResumeIdentity` struct)
   from the provider so magnet/`s3://`/FTP identities are correct.
2. Providers fill `Meta.etag` / `Meta.last_modified`. The existing weak path
   (`state.rs:136-160`) then resumes on `MDTM`/`mtime` + same path with **no**
   schema change, and `resume.safety` honestly reports `weak`
   (`facts.rs:212-229`). Strong `If-Range` remains HTTP-only; do not fake it for
   other protocols.
3. `url_identity` (`protocol.rs:847-853`) already strips query/userinfo for
   authority URLs, so FTP/SFTP/S3 are fine; only opaque identities (magnet
   info-hash) need the provider override.

(open question) Whether `state.rs` should bump `STATE_VERSION` for a protocol
field: additive `#[serde(default)]` fields are the established pattern
(`state.rs:55-62`), so no bump is needed unless `completed_ranges` semantics
change (e.g. segment indices instead of byte offsets for HLS).

### 2.6 Alternatives considered

* **Generic engine over `S: Source`** instead of `dyn`: no vtable, but
  `Shared<S>`, controller tasks and `Vec<JoinHandle<…>>` would all become
  generic; more churn than value for one task per source. Keep `dyn`.
* **One engine per protocol** (no seam): duplicate scheduler/controller/finalize
  and abandon the measured tuning (`docs/OPTIMIZATION.md`). Only BitTorrent/DASH
  plausibly justify a separate engine (§3.2), and even those should reuse
  `task.rs`, `history.rs`, `rate.rs`, `finalize`.
* **Delegate to an external downloader** (`curl`/`aria2`/`yt-dlp`) from the
  kernel: rejects the resident-kernel premise (no extra process, packaged
  binaries, unified facts/telemetry) and the non-goal statement
  (`PROTOCOL.md:770-772`); also inherits an external binary on five platforms.
  Mentioned only to record the tradeoff.

---

## 3. Protocols grouped by engine reuse

### 3.1 Families that can reuse the byte-range engine

These need a `Source` + probe; scheduler/controller/resume/finalize are reused
as-is. Requirements: random access, known-or-discoverable total, a usable
validator (even weak).

| Family | Range mechanism | Total | Validator | Notes |
|---|---|---|---|---|
| **FTP** (`ftp://`) | `REST <offset>` + `RETR`, size `SIZE` | yes | `MDTM` (weak) | passive mode, control channel, no TLS in v1 |
| **FTPS** (explicit/implicit) | same + TLS | yes | `MDTM` | needs a TLS stack (rustls already transitively in `Cargo.lock:782`) |
| **SFTP** (`sftp://`) | seek+read via SSH | `stat` | `mtime` (weak) | new SSH transport stack; key/passphrase auth; host-key policy |
| **S3/GCS/Azure native** (`s3://`) | `Range` GET on signed requests | HEAD | ETag | SigV4 signing on top of the existing HTTP source; presigned URLs already work today (`facts.rs:114-163`) |
| **WebDAV** | ordinary HTTP ranges (`Range`/`If`) | `HEAD`/`PROPFIND` | ETag | **already works as HTTP**; only probe enrichment (S) |
| **HTTP/3 (QUIC)** | same HTTP semantics | HEAD | ETag | engine untouched; transport feature + facts + size cost |
| **IPFS via gateway** | gateway is HTTPS | HEAD | ETag | URL rewrite only (S); native `ipfs://` is a different protocol stack (XL) |

### 3.2 Families that need a new engine path

| Family | Why not the byte-range engine | Reuse | New code |
|---|---|---|---|
| **HLS (`.m3u8`)** | object is a playlist; transfer is N HTTP GETs + concatenation; total often unknown; AES-128 keys; variant selection | **virtual byte stream** reuses the single-stream loop (after the Phase 0 seam): reporter, token bucket, pause/cancel, finalize; random-access/segment-resume needs a global offset→(segment, offset) map and a new plan/state format | playlist parser, segment fetcher, optional key fetch/decrypt, concat body; probe facts (variants, duration, segments, encryption) |
| **DASH (`.mpd`)** | same as HLS + XML + representations + DRM | same as HLS | HLS work + MPD/XML + representation selection; DRM is out of scope |
| **BitTorrent (`magnet:`/`.torrent`)** | pieces hash-verified, peer selection, DHT/trackers, **multi-file** outputs, upload while downloading | task/telemetry/history/finalize concepts, but not scheduler/claims | bencode/metainfo, tracker/DHT, peer wire protocol, piece picker/verifier, multi-file target layout |
| **RTSP/RTMP/live capture** | live, unbounded, no resume | reporter/limit only | capture pipeline; likely not worth it |
| **SMB/NFS** | block/byte access over another session protocol | could fit byte-range if a mature pure-Rust crate exists | new transport; crate risk (open question) |

### 3.3 Not engine work (protocol-adjacent)

* Native S3 *listing*/prefix sync, bucket policies → new probe/task semantics, not
  transfer (`ListObjectsV2` XML, pagination).
* HLS master-playlist *selection* policy is a product decision (highest bitrate
  vs user cap), and for encrypted streams a key-management decision.
* BitTorrent multi-file selection (`magnet` `so=`/file priorities) is a wire/API
  change (§4.3), not just transport.

---

## 4. Wire protocol, tool surface, config

### 4.1 Scheme routing

**Kernel.** Replace the whitelist at `protocol.rs:148-153` with a registry:

```rust
let url = url::Url::parse(raw.url.trim())…?;
let scheme = Scheme::from_url(&url)
    .ok_or_else(|| format!("unsupported url scheme `{}`; supported: …", url.scheme()))?;
```

* `Spec` gains the resolved scheme (or re-derives it) so `engine`, `kernel` and
  `rpc` never string-match again.
* `probe` must call the same check before building a client, so
  `probe ftp://…` is `invalid_request` today-if-unimplemented rather than
  `network` (`probe.rs:321-342`).
* Capability advertisement: add `protocols: ["http","https",…]` to the ready
  frame (`main.rs:73`) and `initialize` result (`kernel.rs:229-233`), and
  `stats` (`kernel.rs:493-508`). This lets an old host refuse politely and a new
  host enable UI text per capability instead of hard-coding.
* Keep "unsupported but known" distinct from "unknown": an extension that is
  compiled out should be `unsupported` (`PROTOCOL.md:712` lists the code) with a
  hint, not `invalid_request`.

**Host.** `assertHttpUrl` (`kernel-client.ts:527-546`) becomes
`assertSupportedUrl(value, capabilities)`: scheme allowlist from the kernel
handshake, same non-empty/parse checks. Call sites `:632`, `:2041` and the
browser route through `normalizeRequestSpec` (`host-api.ts:210-212`) need no
further change. Tool descriptions (`tools.ts:1335,1340,1460,1464`) must list
supported schemes from the same capability set — otherwise the model will keep
believing HTTP(S) is the only option.

### 4.2 Credentials

Current credential surface: `RequestSpec.headers/cookie/referer/user_agent/proxy/insecure`
(`protocol.rs:111-124`) and `ProbeParams.headers/cookie/referer/user_agent/proxy/insecure`
(`:215-221`), threaded into `ClientOptions` (`http.rs:11-23`). There is no
scheme-specific auth and no credential store in config
(`src/config.ts:33-62`, kernel `Config` `protocol.rs:50-63`).

Needed shapes (one decision, not many):

```rust
pub enum AuthSpec {
    Http    { headers: BTreeMap<String, String>, cookie: Option<String>, … },   // today
    Ftp     { user: Option<String>, password: Option<String>,   // or userinfo
              implicit_tls: bool },
    Sftp    { user: String, key_path: Option<String>, key_passphrase: Option<String>,
              password: Option<String>, known_hosts: Option<String>,
              accept_unknown_host_key: bool },
    S3      { access_key_id: String, secret_access_key: String, session_token: Option<String>,
              region: Option<String>, endpoint: Option<String> },
    None,
}
```

Design constraints the repo already implies:

* **Secrets are persisted.** `TaskRecord` stores the whole `Spec`
  (`task.rs:861-867`, `protocol.rs:766-773`), and `PROTOCOL.md:214-217` says the
  on-disk record may retain headers/cookie so resume works after a restart. So
  prefer *key paths* over key material; if a passphrase must be stored, that is a
  security review, not a code detail. (open question: credential store vs
  per-call; this note recommends per-call + path indirection, consistent with the
  existing `headers`/`cookie` parameters.)
* **Redaction must learn non-HTTP credentials.** `redact_url` must scrub
  userinfo (`protocol.rs:810-839`), and `redact_text` must recognize `ftp://`,
  `sftp://`, `s3://` and `magnet:` tokens (currently only `http(s)` at
  `protocol.rs:855-879`). Add explicit redaction of `AuthSpec` fields so an
  `AuthSpec` never enters a protocol projection (it currently has no `Serialize`
  and no projection — keep it that way; do **not** add it to `TaskView`).
* **Probe credentials vs transfer credentials** should share one type: a probe
  needs the same credentials as the transfer for nearly every family.
* **Host-side**: `rdm_probe`/`rdm_download` params gain `auth` (or family
  sub-objects). Tool schema is a closed object (`objectNode(..., false)`), so
  this is a host+kernel lockstep change (`tools.ts:708-710`,
  `src/tool-def.ts:272-284`).

### 4.3 Multi-file outputs

Only BitTorrent/containers need this today; HLS/DASH/FTP/SFTP/S3 produce one
file. The current model is single-output in these places:

* `TaskView.path` (`protocol.rs:529`), `fileName` (`:527`), `dir` (`:528`);
* `TaskDetail.target { dir, path, part, resumeState }` (`protocol.rs:659-665`);
* `finalize` renames exactly one `.part` (`engine/mod.rs:251-256`);
* `control remove deletePart` removes one `.part`/`.part.json`
  (`kernel.rs:478-486`); `reset_for_retry` collapses to one path
  (`task.rs:906-957`).

Minimal additive shape (protocol 3):

```jsonc
"outputs": [
  { "path": "…/movie.mkv", "bytes": 123, "sha256": "…", "role": "primary", "verified": true }
],
"progress": { "filesDone": 3, "filesTotal": 8 }   // optional aggregate
```

with `path` retained as the primary file for backward-compatible UI, `target.dir`
as the task root, and `remove/deletePart` defined as "task root directory".
`fileName` collision logic (`filename.rs:70-91`) must move to a directory-level
policy for multi-file tasks.

### 4.4 ServerFacts shape

`ServerFacts` (`protocol.rs:457-482`) is serialized to the tool surface
(`src/tools.ts:819-905`), typed twice (`src/protocol.ts:320-347`,
`src/kernel-client.ts:1128-1169`) and normalized again for the browser route
(`src/client/api.ts:433-570`). Changes:

1. **Add a discriminator**: `protocol: "http" | "ftp" | "sftp" | "s3" | "hls" | …`.
   Default `"http"` so old records load (`#[serde(default)]` pattern,
   `protocol.rs:761-773`).
2. **Make `status` nullable** (or add `reply` for protocol-native codes). Today
   `status: u16` and `httpVersion: Option<String>` are unconditional
   (`protocol.rs:461-462`); FTP has reply codes but "HTTP status" is the wrong
   label, SFTP has none, HLS has per-segment statuses. `src/protocol.ts:327`
   says `status: number`; the tool schema `status: num()` (`tools.ts:824`) and
   UI label "HTTP status" (`locale/en.json:100`) follow.
3. **Add protocol facts** as a tagged union:
   `facts: { kind: "http", … } | { kind: "ftp", rest: true, sizeCommand: true, … }
   | { kind: "sftp", … } | { kind: "playlist", variants, segments, durationSecs, encrypted }
   | { kind: "torrent", infoHash, files, trackers, … }`.
   The tool DSL supports `oneOf` (`src/tool-def.ts:122-130`,
   `219-227`) so this is expressible without a schema-DSL change.
4. **Field semantics to review**: `range.acceptRanges` (`protocol.rs:269`,
   `bytes|none|unknown`), `probeBy` (`head|range-get`, `:274`), `fileNameSource`
   (`url|content-disposition`, `:279`), `signedUrl` (`:300-307, 362-368`, HTTP
   query signing), `tls.https` (`:373-380`), `headers/rateLimit` (`:393-408`).
   For non-HTTP: set the HTTP-only blocks to neutral/absent values, add
   protocol-native equivalents in `facts`, and add enum variants where the
   vocabulary is real (e.g. `probeBy: "stat"`/`"list"`, `fileNameSource:
   "remote-listing"|"playlist"|"metadata"`).
5. **Keep `resume.safety` honest**: FTP/SFTP map to `weak` (mtime) or `none`
   (no validator); do not claim `strong` without a protocol precondition.
6. **`warnings`**: add stable codes per family (e.g. `plaintext-ftp`,
   `unknown-host-key`, `playlist-encrypted`, `no-discard-files`); the current
   list is fixed in `facts.rs:313-354` and mirrored in the TS union
   (`src/protocol.ts:172-186`).

### 4.5 Protocol version bump

**Recommendation: bump `PROTOCOL` 2 → 3 with the first non-HTTP scheme.** The
current wire is "protocol 2 is the only protocol" (`PROTOCOL.md:12-17`), and the
0.2.1/0.2.2 releases deliberately stayed additive (`PROTOCOL.md:856-922`). But
`status` nullability, new enum variants and `outputs[]` are not additive-safe for
a *closed* output schema and an *equal-protocol* handshake. A bump is honest and
cheap because the plugin and kernel are versioned together
(`docs/ARCHITECTURE.md:80`, `PROTOCOL.md:885-892`).

Mechanics of a bump (concrete list):

| Kind | Locations |
|---|---|
| constants | `kernel/src/protocol.rs:8`; `src/protocol.ts:18` |
| handshake/messages | `src/kernel-client.ts:1643-1649`, `1827-1837`, `2262-2264`; message text at `:453` |
| docs | `PROTOCOL.md:1-17` and the additive-change sections |
| kernel tests pinning 2 | `kernel/tests/protocol_tests.rs:122,141,283,469`; `kernel/tests/v022_integration.rs:715` |
| host tests pinning 2 | `tests/kernel-e2e.mjs:28,226,240,248`; `tests/tools-receipts.test.mjs:216,220`; `tests/verify_e2e.py:382,402,501`; `tests/verify_extra.py:330-360` |
| docs tests | `tests/verify_claims.py` (protocol claims) |

If a smaller step is preferred, stay at protocol 2 and make the first family
(e.g. FTP) **additive**: new optional `ServerFacts` fields only, `status` kept
(mapped to the FTP final reply code or `0` with a `protocol` discriminator). That
avoids the test churn above but leaves `status` dishonest — a product call, not a
code call. (open question)

### 4.6 Tool surface

Tools: `rdm_download`, `rdm_probe`, `rdm_tasks`, `rdm_wait`, `rdm_control`,
`rdm_history` (`docs/ARCHITECTURE.md:249-256`; definitions `src/tools.ts:1330+`).

Parameter changes:

* `url` descriptions become capability-driven (`tools.ts:1340,1464`).
* new auth/credential params per §4.2, plus family options:
  `ftp:{user,password,implicitTls}`, `sftp:{…}`, `s3:{…}`,
  `playlist:{variant,maxHeight,format}`, `torrent:{files,seedAfter}`.
* `fileName`/`dir` semantics unchanged for single-output families.
* `insecure`/`proxy` remain HTTP-transport flags; they must be rejected (or
  ignored loudly) for families that do not use HTTP.

Receipt changes (the model reads the render, not the JSON,
`docs/ARCHITECTURE.md:243-256`):

* `renderProbeReceipt` prints `http=` and `status=` (`src/tools.ts:338`) — needs
  `protocol=` and protocol-native status, plus one line per protocol fact block.
* `renderServerLines` prints `range= resume= signed= tls= checksum=`
  (`tools.ts:296-302`) — non-HTTP lines should say `ranges=n/a`, `resume=weak
  (mtime)` etc. rather than pretending.
* `renderDownloadReceipt`/`nextLine` are mostly neutral
  (`tools.ts:311-326,306-308`).
* `rdm_tasks` detail renders the `server` block and diagnosis; protocol fact
  blocks need a renderer.
* Error hints (`tools.ts:549-565`) need protocol-flavored codes (e.g.
  `auth-failed`, `host-key-rejected`).

Schemas: `SERVER_FACTS_SCHEMA` (`tools.ts:819-905`) and `TASK_VIEW_SCHEMA`
(`:907+`) must gain the new optional fields and enum variants; output objects are
closed (`objectNode(..., false)`), so kernel and host must change together
(§4.5).

### 4.7 Config, UI, docs

* **Config** (`src/config.ts:33-62`, kernel `Config` `protocol.rs:50-63`): no new
  keys are strictly required for URL-level credentials; a credential store, a
  per-protocol enable/disable set, a default HLS variant selector and a
  `sizeLimitMiB` for torrents would each be new keys. The kernel's `Config` is
  persisted into `initialize` results and task defaults; adding optional keys is
  additive.
* **Data dir/records**: a new `protocol` field in `tasks/<id>.json` and in the
  history meta record (`history.rs:66-89`, PROTOCOL.md:794-812) keeps recorded
  timelines attributable; meta `url` redaction (`history.rs` + `redact_text`)
  must cover non-HTTP schemes.
* **UI**: drawer shows `facts.status`/`facts.http` (`drawer.tsx:325-332`) with
  locale labels "HTTP status"/"HTTP version" (`locale/en.json:100-101`,
  `locale/zh.json:100-101`) — add protocol labels and optional protocol facts;
  the client tolerates absent fields (`docs/ARCHITECTURE.md:280-282`), so additive
  fields degrade safely. Two normalizers must learn the new fields
  (`kernel-client.ts:1128-1169`, `client/api.ts:433-570`).
* **Docs/policy**: system-prompt section says prefer `rdm_*` for downloads
  (`docs/ARCHITECTURE.md:216-218`); tool texts and README mention HTTP(S)
  (`README.md` tool table); `PROTOCOL.md` §start (`:514-553`) and §probe
  (`:499-513`) need protocol wording.

---

## 5. Tests, fixtures, prebuilt build, size

### 5.1 What exists today

**Kernel integration tests** use one in-process, dependency-free HTTP fixture:
`kernel/tests/common/mod.rs:1-6` (doc), `:44-84` (`Fixture::start`), `:150-183`
(raw HTTP request parser), `:185-264` (HEAD/206/200/416/429/redirect), `:266-275`
(range parsing). It covers ranges, ETag change, 302, 429+Retry-After, chunked
body, Content-Disposition. Consumers: `kernel/tests/engine_tests.rs` (ranged/
no-range/redirect/retry/checksum/pause/restart/ETag/filename/cancel/probe/
telemetry/session/origins) and `kernel/tests/protocol_tests.rs` (NDJSON
round-trip, redirect/signed URL/redaction, legacy record, EOF, malformed) plus
`v022_integration.rs` / `v030_integration.rs` (resume matrix, controller,
history).

**Host tests**: `tests/fixture-server.mjs` is an HTTP-only fixture with modes
`ranged/norange/redirect/slow/changed/flaky/corrupt/chunked/volatile/authkey`
(`:1-30`); `tests/kernel-e2e.mjs` drives scenarios against it (`:274-308` probe
matrix); `tests/verify_e2e.py` is the out-of-process protocol driver
(`scenario_v030` at `:545`, `scenario_v022` at `:1006`); `tests/kernel-client.mjs`
covers spawn/RPC/restart; `tests/tools-receipts.test.mjs` pins tool schemas and
receipts (`:233-267`, `:385`, `:424-433`, `:886-1005`);
`tests/verify_claims.py` / `verify_extra.py` check documented claims.

### 5.2 Fixture cost per family

| Family | Fixture approach | Cost / risk |
|---|---|---|
| **FTP** | a second std-only `TcpListener` control/data server in `kernel/tests/common/` (same style as the HTTP fixture: parse `USER/PASS/PASV/SIZE/MDTM/REST/RETR`, send 150/226) | **S** — no new deps; ~200–300 lines; the existing test harness style transfers directly |
| **HLS** | extend the HTTP fixture with `/playlist.m3u8`, `/seg-N.ts`, optional AES key routes; host fixture `tests/fixture-server.mjs` gains a `playlist` mode | **S** — reuses HTTP fixture |
| **FTPS** | same FTP fixture + TLS listener; needs a cert/key fixture (check in a test PEM) | **M** |
| **S3 native** | HTTP fixture that validates `Authorization` SigV4 headers (or a tiny signer oracle) | **M** — signing vectors can be unit-tested |
| **SFTP** | hermetic in-process SSH server requires a real SSH crypto stack (host key, kex, auth) — either a dev-dependency on the same SSH crate (`russh`-style) or a CI service + OpenSSH | **L** — the weakest part of the SFTP story; non-hermetic CI is a durability risk |
| **BitTorrent** | need a seeder: generate a metainfo from a temp file and run an in-process seeder (same crate as client, dev-dependency) or an external `transmission`-style service | **L/XL** — hermetic seeding is possible but is its own project |
| **HTTP/3** | HTTP/3 origin (quinn-based) or a local `h3` test server | **M/L** |

Fixture policy implications: the repo's kernel integration tests are explicitly
offline and use a std-only fixture (`kernel/tests/v030_integration.rs:19-20`,
`kernel/tests/common/mod.rs:1-6`), so an SSH/BT dev stack is a philosophical
change, not just a line item.

### 5.3 Existing tests that must change

* `kernel/tests/protocol_tests.rs:502-504` asserts `ftp://x/y` is
  `invalid_request` — directly encodes today's HTTP-only contract.
* Any test that asserts `ServerFacts` keys exhaustively
  (`protocol_tests.rs:150-177`, `engine_tests.rs:318-362`,
  `tests/kernel-e2e.mjs:274-308`, `tests/tools-receipts.test.mjs:886-1005`)
  gains protocol fact blocks.
* Protocol-pin tests listed in §4.5.
* Fixture mode lists in `tests/fixture-server.mjs` and the kernel fixture doc.

### 5.4 Five-platform prebuilt build

Shipped model: five native runners, no cross-compilation
(`.github/workflows/prebuilt-kernels.yml:28-29` comment, matrix `:50-68`), each
runs `node scripts/build-kernel.mjs` → `cargo build --release` → installs to
`bin/<platform>-<arch>/` (`scripts/build-kernel.mjs:14-29,71-88,90-120`), then a
`--help` smoke test (`verify-kernels.mjs:142-149`). Package job asserts exactly
five kernels and their names/modes (`prebuilt-kernels.yml:163-175,387-410`).

Consequences for new protocol deps:

* Every new crate/toolchain must build natively on ubuntu-24.04 (x64/arm64),
  windows-latest, macos-15-intel, macos-15 — **no cross tooling is set up**
  (`build-kernel.mjs` only adds cargo and optional MinGW to PATH, `:33-69`).
* No system libraries (OpenSSL/libssh2) unless vendored/pure-Rust; the Windows
  build script already prepends a WinLibs MinGW `bin` directory to `PATH`
  (`:33-57`), so the Windows toolchain is not plain MSVC — check any new
  dependency against that setup rather than assuming the default.
* Multiple binaries (e.g. feature-gated protocol builds) would break the "exactly
  five" release assertions and the `bin/**` packaging check
  (`verify-kernels.mjs:86-94`, `prebuilt-kernels.yml:169-174`). **If feature
  gating is used, it must be compile-time features on one binary, not extra
  artifacts.**
* The kernel is spawned from the installed package (`resolveKernelPath`,
  `src/kernel-client.ts:505-511`); a missing/failed binary has no fallback. A new
  dependency that fails on one platform breaks installs there only after release,
  so the matrix build is the gate.

### 5.5 Dependency policy and binary size

Current dependency surface is deliberately tiny: nine direct deps — `tokio`,
`reqwest` (rustls-tls, http2, stream), `serde`, `serde_json`, `sha2`, `hex`,
`url`, `httpdate`, `percent-encoding` (`kernel/Cargo.toml:19-28`) — against 152
packages in `Cargo.lock`. `kernel/src/tls.rs:1-7` records the policy explicitly:
"the dependency set is frozen (no `x509-parser`)", which is why the kernel
hand-walks ASN.1. Release profile: `lto="thin"`, `codegen-units=1`, `strip`
(`Cargo.toml:30-34`).

Observed shipped sizes (this worktree):

| target | bytes | MiB |
|---|---:|---:|
| `bin/win32-x64/rdm-kernel.exe` | 5,101,056 | 4.86 |
| `bin/linux-x64/rdm-kernel` | 4,857,944 | 4.63 |
| `bin/darwin-x64/rdm-kernel` | 4,490,448 | 4.28 |
| `bin/linux-arm64/rdm-kernel` | 4,404,112 | 4.20 |
| `bin/darwin-arm64/rdm-kernel` | 4,227,856 | 4.03 |

The marketing/README claim is 4.39 MiB
(`docs/marketing/xiaohongshu-dsh-rdm.md:15,59`); `docs/OPTIMIZATION.md:478`
records the 0.2.2 build at 5,059,072 bytes. `scripts/verify-kernels.mjs:33` only
enforces a **minimum** of 1 MB — no upper bound anywhere in CI.

Size impact estimates (order-of-magnitude, **(inference)**; crate-level numbers
belong to the sibling crate analysis):

| Addition | Likely delta per binary | Note |
|---|---|---|
| seam refactor only | ~0 | moves code, adds a vtable |
| FTP (hand-rolled, `tokio` only) | +0.1–0.3 MiB | control lines + passive data sockets |
| FTPS | +0.3–0.8 MiB | rustls/tokio-rustls are transitively present already (`Cargo.lock:782,1028`) but become direct deps |
| native S3 (SigV4, hand-rolled HMAC over `sha2`) | +0.1–0.3 MiB | `hmac` crate optional; can be ~30 lines |
| HLS (parser + segment fetch/concat) | +0.1–0.4 MiB | no new crypto unless AES decryption is added (then +aes/cbc crates) |
| HTTP/3 (`reqwest` `http3` feature → quinn/h3) | +0.5–1.5 MiB | quinn/quinn-proto/quinn-udp already appear in `Cargo.lock:608,628,650` (optional deps in reqwest's manifest), but are not compiled today: `Cargo.toml:21` enables only `rustls-tls, http2, stream` |
| SSH/SFTP stack | +1.5–3.0 MiB | crypto/kex suites dominate; roughly doubles-to-1.6× the binary |
| BitTorrent (bencode, DHT, peer wire, SHA-1) | +1.0–3.0 MiB | plus test/dev seeders |
| DASH (XML + DRM out of scope) | +0.2–0.6 MiB | XML parser or hand-rolled |

Recommendation: add a **maximum binary size gate** to
`scripts/verify-kernels.mjs` (e.g. fail above an agreed budget, measured per
target) and a `cargo build --release` size report in `scripts/build-kernel.mjs`
(it already prints MiB at `:117-120`). Without it, the "slim resident kernel"
goal (`docs/ARCHITECTURE.md:30-43`) erodes silently.

---

## 6. Effort table (from the code's perspective)

Legend: **S** = provider/probe only, no engine or wire break, ≤ ~300 net new
kernel lines; **M** = new provider module + probe + credentials + scheme routing,
engine seam required, ~500–1,200 lines; **L** = new transfer path or transport
stack + wire/state changes, ~1.5–3k lines; **XL** = new engine + multi-file wire +
large dependency subtree, > 4k lines and a new test infrastructure.

| # | Family | Reuse | Effort | Kernel files to touch (main) | Host files | Test/fixture cost |
|---|---|---|---|---|---|---|
| 0 | **Phase 0 seam** (HTTP only, no wire change) | — | **M** | new `source.rs`; `protocol.rs`; `http.rs`; `probe.rs`; `engine/mod.rs`; `engine/chunked.rs`; `engine/single.rs`; `kernel.rs` | none (behavior identical) | all existing tests must stay green; add one "engine works through Source" path |
| 1 | **WebDAV probe enrichment** | full byte-range | **S** | `probe.rs`/`facts.rs` (PROPFIND optional), `protocol.rs` | `tools.ts` descriptions only | fixture: HTTP routes |
| 2 | **HTTP/3** | full byte-range | **M** (engine S, build M) | `Cargo.toml` (reqwest `http3`), `http.rs`, `probe.rs` (`version_string`), `facts.rs` warnings | none | new h3 origin fixture; 5-platform size |
| 3 | **FTP** | full byte-range | **M** | `protocol.rs` (scheme+auth), new `source/ftp.rs`, `probe.rs` split, `state.rs` identity, `kernel.rs`/`rpc.rs` dispatch, `task.rs` projection, redaction `protocol.rs` | `kernel-client.ts` (scheme gate), `tools.ts` (params+receipts), `protocol.ts`, `client/api.ts`, locale, docs | std-only FTP fixture; e2e; receipts |
| 4 | **FTPS** | full byte-range | **M/L** | above + `tls.rs` (server leaf), `http.rs` client options, `Cargo.toml` (rustls/tokio-rustls) | `tools.ts` (`implicitTls`), receipts | TLS certs in fixture |
| 5 | **Native S3/GCS/Azure** | full byte-range (HTTP + signing) | **M** | new `source/s3.rs`, `protocol.rs` auth, `probe.rs`/`facts.rs` checksum mapping, `kernel.rs` dispatch | `tools.ts` auth params + receipts, `protocol.ts`, docs | signing vectors + HTTP fixture |
| 6 | **HLS** (virtual byte stream) | single-stream engine | **L** | new `source/hls.rs` (playlist parse, variant pick, segment fetch/concat, optional AES), `protocol.rs` playlist facts, `filename.rs`/`state.rs` naming+resume, `engine/single.rs` body wiring | `tools.ts` playlist params + receipts, `protocol.ts`, UI facts, docs | playlist/segment fixtures (HTTP), AES fixture |
| 6b | **HLS** (random-access + segment resume) | chunked engine via offset map | **XL** | above + `plan.rs`/`state.rs` segment mapping, `engine/chunked.rs` claim→segment translation | wire (`outputs`? not needed), tools | same + resume matrix |
| 7 | **DASH** | single-stream engine (variant) | **XL** | HLS work + `source/dash.rs` (MPD/XML, representations) | tools/receipts/UI + docs | MPD fixtures; DRM excluded |
| 8 | **BitTorrent** (`magnet:`) | task/telemetry/history only | **XL** | new `engine/torrent/` (bencode, metainfo, tracker/DHT, peer wire, piece picker+verify), `protocol.rs` scheme + multi-output, `task.rs`/`kernel.rs`/`rpc.rs` multi-file, `state.rs` per-file resume, redaction | `tools.ts` (files/seed), multi-output UI, `protocol.ts`, docs | seeder fixtures; multi-file e2e; largest test cost |
| 9 | **IPFS gateway** | full (HTTP) | **S** | `protocol.rs` (URL rewrite + scheme), `probe.rs`? | tools text | HTTP fixture |
| 9b | **IPFS native** | no | **XL** | new transport + block store | — | — |
| 10 | **SMB/NFS** | byte-range if a pure-Rust client exists | **L** (uncertain) | new `source/smb.rs` | tools | crate/CI risk |
| 11 | **RTSP/RTMP live** | reporter/limit only | **XL** (likely no) | new capture engine | — | live fixtures |

Sequencing implication: **Phase 0 is a prerequisite for 3–11** (and for 6 if the
virtual stream uses the `BodyStream` seam); 1, 2, 9 do not strictly need it but
are cheaper after it. If the goal is "maximum protocols for minimum risk", the
order is **Phase 0 → FTP → HLS virtual stream → native S3 → SFTP → HTTP/3**, with
BitTorrent/DASH deliberately deferred.

---

## 7. Where I am unsure (marked honestly)

1. **`probe` failure code for unsupported schemes today.** By reading,
   `probe_params` (`probe.rs:321-342`) does not scheme-check, `fetch`
   (`:44-78`) sends the URL through `reqwest`, and failures are mapped to
   `EngineError::network` (`:53`, `:153-175`). I did not execute a `probe
   ftp://…` to confirm the exact `reqwest` error kind mapped to `network`.
2. **`reqwest`/`url` behaviour on opaque schemes.** I did not run
   `Url::parse("magnet:?xt=…")`/`host_str()`; the claim that `Spec::host()` is
   empty for magnet is from the `url` crate's documented behaviour for
   non-special schemes (inference).
3. **Crate availability/size.** The §5.5 deltas are order-of-magnitude and
   assume pure-Rust crates; actual numbers belong to the sibling crate analysis.
   No `cargo build` was run (brief forbids it), so this note cannot confirm that
   any candidate dependency compiles on all five targets.
4. **Whether `ServerFacts` should be nullable-status (protocol 3) or
   status-as-reply-code (protocol 2 additive)** is a product/wire decision. I
   recommend protocol 3, but a smaller first step is defensible.
5. **HLS resume model** (segment index vs byte offsets vs no resume in v1) is a
   product decision; the code supports either but the `.part.json` schema
   (`state.rs:39-63`) assumes byte ranges.
6. **SFTP hermetic testing** is the largest unknown cost: an in-process SSH
   server needs real crypto/host-key setup; without it, SFTP tests are
   non-hermetic, which conflicts with the repo's offline-test stance
   (`v030_integration.rs:19-20`).
7. **Whether SFTP/BitTorrent are even demanded** is the demand-evidence task's
   call; this note only prices them.
8. **Line-count estimates in §2.4/§6** are derived from reading and grep, not
   from an actual patch.
