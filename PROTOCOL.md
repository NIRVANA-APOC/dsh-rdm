# RDM Kernel Protocol v2

The kernel (`rdm-kernel`) is a resident child process of the `dsh-rdm` DSH plugin.
It speaks **newline-delimited JSON (NDJSON)** over its stdio pipes: one UTF-8 JSON
object per line, `\n` terminated, no pretty printing.

* `stdout` carries protocol messages only (responses + notifications).
* `stderr` carries human-readable logs; the plugin drains it and never parses it.
* The kernel exits when `stdin` reaches EOF (parent plugin gone) or on `shutdown`.
* The kernel never listens on a network port. All control is parent→child stdio.

Protocol v2 (kernel 0.3.0) is the first "agent-native" revision: tasks carry
session attribution and live telemetry windows, probes return a full server-fact
record (ranges, validators, signed-URL expiry, TLS validity, redirects, timing,
recommendation), and the hot path (`list`/notifications) stays a flat, cheap
`TaskView` while `get` returns a separate `TaskDetail`. Protocol v1 is not
supported: a plugin refuses a kernel whose ready frame reports `protocol != 2`.

0.2.1 is an **additive** revision of protocol 2 (the wire envelope, methods and
existing fields are unchanged): the connection hard cap rises to 128, a task
gains an adaptive `maxConnections` ceiling that the controller may grow toward,
resume compatibility is keyed on stable identity with an explicit
`resumeDecision`/`resumeReason`, and per-sample telemetry + task events are
persisted as JSONL under the kernel data dir and read back through the new
`history` method. See [0.2.1 additive changes](#021-additive-changes) at the end.

0.2.2 was the **live ModelScope pass** (kernel identity 0.2.2 at the time) and
is additive as well: every JSONL samples file gains one per-run **meta record**
for build attribution (a session may span kernel builds), `TaskView` gains
`transferredBytes` (this-run rate accounting) and `requestedConnections`
(requested vs initial workers), the controller judges growth on **aggregate**
throughput with saturation backoff and tail freeze, tail chunks retry fast, and
an unknown RPC method returns the stable `unsupported_method` error. See
[0.2.2 additive changes](#022-additive-changes).

**0.3.0** keeps the protocol-2 envelope: every method, field and
notification keeps its shape, and the kernel identity is unified with the plugin
package. The multi-source pass is additive/defaulted: `start` accepts candidate
`sources[]` plus `sourcePolicy`/`sourceRaceBytes`/`discoverSources`/`metalinkFile`,
`TaskView`/`TaskDetail` expose the selected source pool, `ServerFacts` exposes
Metalink/HTTP mirrors, and `.part.json` gains a source-independent `contentKey`.
See [0.3.0 additive changes](#030-additive-changes).

This protocol is private to the plugin: it is versioned here, and no
compatibility with other downloaders, their CLIs or their persisted state is
promised or implemented.

## Lifecycle

1. Plugin spawns `rdm-kernel --data-dir <dir> [--log-level warn]`.
2. Kernel creates `<data-dir>/tasks/`, loads persisted task records, marks tasks
   that were `running`/`probing`/`queued` in the previous kernel generation as
   `interrupted` (or auto-resumes them when `autoResume` is true), then writes:

   ```json
   {"event":"ready","protocol":2,"kernel":{"version":"0.3.0","pid":1234,"dataDir":"C:\\\\...\\\\dsh-rdm"}}
   ```

3. Plugin sends `initialize` (optional but recommended) with session defaults.
4. Plugin issues tool/UI requests; kernel emits throttled `task` notifications.
5. On unload the plugin kills the child (or closes stdin); kernel persists state
   and exits.

Request envelope:

```json
{"id":"<opaque string>","method":"start","params":{}}
```

Success response:

```json
{"id":"<same>","ok":true,"result":{}}
```

Failure response:

```json
{"id":"<same>","ok":false,"error":{"code":"not_found","message":"task t_1 does not exist"}}
```

`id` is a string chosen by the plugin; responses may arrive out of order. Requests
are handled concurrently; a long `wait` does not block other methods.

## Types

### Connection limits

| constant | value | meaning |
|---|---:|---|
| `MIN_CONNECTIONS` | `1` | lowest accepted `connections` value |
| `MAX_CONNECTIONS` | `128` | hard cap for `connections` and `maxConnections` (was `32` before 0.2.1) |
| `DEFAULT_CONNECTIONS` | `8` | `initialize.connections` default |
| `DEFAULT_MAX_CONNECTIONS` | `128` | `initialize.maxConnections` default |

`connections` is the initial worker population of a task (1..128) and is what
`TaskView.connections` reports. `maxConnections` is the adaptive ceiling the
controller may grow the worker target toward — and never exceed — while a
transfer is healthy; it is clamped to `[connections, 128]`, so it can never be
lower than the starting count. `singleStream: true` forces both to `1`.

### ServerFacts

The result of `probe`, also retained on a started task. Every optional field is
`null` (never omitted, never `""`).

```jsonc
{
  "url": "https://cdn.example.com/app.zip?sig=...",
  "finalUrl": "https://cdn.example.com/app.zip?sig=...",
  "host": "cdn.example.com",
  "httpVersion": "HTTP/2.0",
  "status": 200,
  "fileName": "app.zip",
  "fileNameSource": "content-disposition",
  "totalBytes": 50406400,
  "contentType": "application/zip",
  "contentEncoding": null,
  "contentDisposition": "attachment; filename=\"app.zip\"",
  "range": {
    "supported": true,
    "acceptRanges": "bytes",
    "ifRange": true,
    "probedBy": "head",
    "probeStatus": 206,
    "probeBytes": 0
  },  "validators": {
    "etag": "\"9b2cf5\"",
    "strongEtag": true,
    "lastModified": "Wed, 21 Oct 2026 07:28:00 GMT"
  },
  "resume": { "possible": true, "safety": "strong", "reason": "strong-etag" },
  "signedUrl": {
    "signed": true,
    "expiresAt": 1763000123000,
    "expiresInSecs": 1180,
    "source": "aws-sigv4",
    "state": "valid"
  },
  "tls": {
    "https": true,
    "notAfter": 1767000000000,
    "expiresInSecs": 3456000,
    "issuer": "R11",
    "subject": "cdn.example.com",
    "state": "valid"
  },
  "redirects": [{ "status": 301, "url": "https://cdn2.example.com/app.zip" }],
  "headers": {
    "server": "nginx",
    "date": "Wed, 21 Oct 2026 07:28:00 GMT",
    "cacheControl": "max-age=3600",
    "expires": null,
    "vary": "Accept-Encoding"
  },
  "rateLimit": { "retryAfterSecs": null, "limit": null, "remaining": null },
  "timing": { "probeMs": 84, "ttfbMs": 61, "sampleBps": null },
  "checksum": { "contentDigest": null, "contentMd5": null, "sha256": null, "crc32c": null },
  "warnings": ["weak-validators"],
  "recommendation": {
    "start": "now",
    "connections": 8,
    "chunkSizeBytes": 1572864,
    "singleStream": false,
    "reason": "ranges+strong-etag",
    "verify": "unavailable"
  },
  "origin": {
    "known": true,
    "attempts": 3,
    "completed": 2,
    "medianBps": 14680064,
    "bestBps": 23068672,
    "lastError": "network",
    "lastAt": 1762990000000
  }
}
```

`resume.safety` follows RFC 9110 strong comparison: `strong` (ranges + strong
ETag + known length; `If-Range` may be sent), `weak` (ranges + weak ETag or
Last-Modified only; `If-Range` must NOT be sent, the kernel re-probes the
validator and validates `Content-Range`/length, falling back to a full body on a
200), or `none` (no usable validator, no ranges, or unknown length).
`resume.reason` is one of `strong-etag`, `last-modified-only`,
`no-validators`, `no-range-support`. Last-Modified is implicitly weak
(RFC 9110 §8.8.2.2) and is never reported as `strong`.

`signedUrl.source` is one of `aws-sigv4`, `aws-sigv2`, `gcs-sigv4`,
`azure-sas`, `generic-expires`, `unknown`, and describes the family used to
derive `expiresAt` from the **final** URL (redirects may land on a differently
signed URL). SigV4/GCS V4 expiry = signed date + relative TTL; SigV2/generic use
an absolute `Expires`; Azure SAS uses absolute `se`. Expiry is evaluated by the
origin at request time: an in-flight transfer survives expiry, a resume after
expiry fails. `signedUrl.state` is `valid` (more than 300 s left), `expiring`
(≤ 300 s), `expired`, or `unknown`.
`auth_key` (ModelScope) is recognised as signed-URL material: its presence sets
`signedUrl.signed=true`. It carries no parseable expiry, so `expiresAt` /
`expiresInSecs` stay `null` and `signedUrl.state` is `unknown` — the URL must be
treated as expiring-unknown, never as durable.
`tls` is `null` for plain HTTP or when the leaf certificate cannot be read;
`tls.state` uses the same `valid|expiring|expired|unknown` vocabulary with a
30-day "expiring" boundary.

`warnings` is a bounded set of stable codes: `no-range-support`,
`no-validators`, `weak-validators`, `unknown-size`, `signed-url-expiring`,
`signed-url-expired`, `tls-expiring`, `tls-expired`, `rate-limited`,
`head-failed`, `redirected`, `content-encoding`.

`recommendation.verify` describes integrity leverage: `unavailable` = the origin
declares no checksum, so verifying requires a caller-supplied `expectedSha256`;
`recommended` = the origin declares a checksum worth comparing; `required` is
reserved for callers/providers that mandate verification.

**Credential redaction.** `ServerFacts.url/finalUrl`, every
`ServerFacts.redirects[].url`, and the `url/finalUrl` fields of
`TaskView`/`TaskDetail` replace the values of credential-bearing query
parameters with `<redacted>` (`X-Amz-Signature`, `X-Amz-Credential`,
`X-Amz-Security-Token`, `Signature`, `sig`, `token`, `access_token`,
`auth_key`, `key`, `api_key`, `secret`, …). The raw URL stays internal to the
kernel; redirect hops are redacted at every hop, not just the final URL. Request
`headers` and `cookie` never appear in any protocol view or event, and
`redact_text` applies the same rules to persisted event messages. Task records
on disk may retain them so resume works after a restart; they live only under
the kernel data dir.

`recommendation` is advisory. Missing data must degrade toward safe defaults
(`singleStream: true` when ranges are unknown) and never the opposite. `start`
is `now`, `later`, or `avoid`.

### TaskView

The hot path: returned by `list`/`wait`, attached to every `task` notification.
Flat and cheap; heavy data lives in `TaskDetail`.

```jsonc
{
  "id": "t_9f3a1c2d5e6b7a80",
  "sessionId": "sess_abc",
  "url": "https://cdn.example.com/app.zip",
  "host": "cdn.example.com",
  "finalUrl": "https://cdn.example.com/app.zip",
  "fileName": "app.zip",
  "dir": "C:\\Downloads",
  "path": "C:\\Downloads\\app.zip",
  "status": "running",
  "downloaded": 21184000,
  "total": 50406400,
  "percent": 42,
  "speedBps": 1468006,
  "speed1sBps": 1625292,
  "speed5sBps": 1400000,
  "speed30sBps": 1310000,
  "speed300sBps": null,
  "avgBps": 1200000,
  "peakBps": 2306867,
  "etaSecs": 20,
  "etaConfidence": "high",
  "stalledMs": 0,
  "activeWorkers": 8,
  "peakWorkers": 8,
  "connections": 8,
  "requestedConnections": 16,
  "maxConnections": 128,
  "targetWorkers": 8,
  "chunkSize": 1572864,
  "resumedChunks": 0,
  "resumedBytes": 0,
  "transferredBytes": 21184000,
  "rangeSupported": true,
  "resumable": true,
  "resumeSafety": "strong",
  "expectedSha256": null,
  "sha256": null,
  "verified": null,
  "error": null,
  "retries": 0,
  "createdAt": 1762990000000,
  "startedAt": 1762990000100,
  "finishedAt": null,
  "elapsedMs": 17500,
  "signedUrlExpiresAt": 1763000123000,
  "tlsNotAfter": 1767000000000
}
```

Status values: `queued`, `probing`, `running`, `paused`, `completed`, `failed`,
`cancelled`, `interrupted`.

Terminal: `completed`, `failed`, `cancelled`. Resumable: `paused`, `interrupted`,
`cancelled` (when a valid `.part` + resume state exists), `failed` only after an
explicit `retry`.

`percent` is an integer 0..100 floor, `null` when `total` is unknown. Unknown
numerics are `null`; live rates are `0` when known-idle. `verified` is `true`
(compared equal), `false` (compared and mismatched), or `null` (no hash was
compared). `sessionId` is `null` for tasks started outside an agent session.

`connections` is the initial worker population planned for the task (it can be
lower than the requested count when there are fewer chunks than requested
workers); it stays constant for the task's lifetime. `requestedConnections` is
the count the caller asked for in `start` before that clamping (0.2.2).
`maxConnections` is the adaptive ceiling the controller may grow toward.
`targetWorkers` is the controller's current target (`0` before the plan is built;
it may sit below `connections`, equal to it, or above it up to `maxConnections`
while the controller probes growth). `resumedBytes` is the number of bytes
adopted from an existing `.part` at plan time (`0` when the task started from
zero).

`transferredBytes` (0.2.2) is the number of bytes transferred by the **current
run only** — it excludes `resumedBytes` and never jumps when a task resumes.
`downloaded` stays absolute progress. The speed fields (`speedBps`,
`speed1sBps`…`speed300sBps`, `peakBps`) and the ETA are computed from
`transferredBytes`, so a resumed task starts its rate history cold. `avgBps` is
whole-file progress over the task's accumulated lifetime (`downloaded /
elapsedMs`), and elapsed time is persisted across kernel restarts — a completed
resumed task reports a truthful overall average, while no rate or peak ever
inherits the adopted `.part` bytes.

### TaskDetail

Returned only by `get`, next to the flat `TaskView`.

```jsonc
{
  "telemetry": {
    "windows": { "1s": 1625292, "5s": 1400000, "30s": 1310000, "300s": null },
    "peakBps": 2306867,
    "avgBps": 1200000,
    "stalledMs": 0,
    "trend": "rising",
    "etaConfidence": "high",
    "samples": 78,
    "lastSampleAt": 1762990000123
  },
  "server": { /* ServerFacts or null before probe completes */ },
  "target": {
    "dir": "C:\\Downloads",
    "path": "C:\\Downloads\\app.zip",
    "part": "C:\\Downloads\\app.zip.part",
    "resumeState": "C:\\Downloads\\app.zip.part.json"
  },
  "verification": {
    "expectedSha256": null,
    "sha256": null,
    "verified": null,
    "serverChecksums": { "contentDigest": null, "contentMd5": null, "sha256": null, "crc32c": null }
  },
  "resumeState": {
    "chunksDone": 0,
    "bytesDone": 0,
    "resumedChunks": 0,
    "resumedBytes": 0,
    "validatorsMatched": true,
    "resumeDecision": "not-attempted",
    "resumeReason": null
  },
  "timing": { "queuedMs": 100, "probeMs": 84, "transferMs": 17400, "finalizeMs": 0 },
  "diagnosis": [
    { "code": "on-track", "advice": "wait", "message": "ETA 20s at 5s rate" }
  ]
}
```

`resumeState.resumeDecision` is `accepted`, `rejected`, or `not-attempted`.
`not-attempted` means there was nothing to evaluate: it is the pre-plan value and
the outcome of a fresh transfer (with resume enabled) whose `.part.json` does not
exist. A fresh plan is therefore not a rejection; an explicit `resume: false`
still reports `rejected`/`disabled`. `resumeReason` is `null` for
`not-attempted`, a matched-evidence code when accepted, and a failure code when
rejected:

* accepted — `etag`, `last-modified`, `url`, `final-url` (which evidence
  accepted the stored state; listed strongest first);
* rejected — `disabled`, `size-mismatch`, `validators-mismatch`,
  `url-mismatch`, `file-name-mismatch`, `ranges-invalid`, `version-mismatch`,
  `state-corrupt`, `part-missing`, `part-truncated`. `state-corrupt` is a
  present-but-unreadable state file; `version-mismatch` is an understood file
  with an unknown format version; `disabled` means the start had `resume: false`
  (a stored state is never adopted).

`resumeState.chunksDone` is the number of **chunks covered** by the merged
completed ranges (derived from the chunk plan), not the number of stored ranges;
`bytesDone` is the byte count of those ranges (0.2.2). `resumedChunks` /
`resumedBytes` are what the plan actually adopted from that state.

`validatorsMatched` is a boolean: `true` when a stored state was accepted (or no
comparison was made), `false` when a stored state was rejected on identity /
validator / size grounds; `null` only on 0.1.x records that predate the field.

Resume compatibility is decided on **stable identity**, never on the raw final
URL: the requested URL, the final URL reduced to scheme+host+path (query and
fragment removed), the advertised size, and the validators (strong ETag /
Last-Modified). A per-request token in the final URL query — `auth_key`
(ModelScope), `Expires`/`Policy` (Hugging Face xet), `X-Amz-*` (S3), … — is
therefore not part of the identity: a fresh probe that yields a new tokenized
final URL still accepts the existing `.part.json`. A changed size or validator
still rejects it (`size-mismatch` / `validators-mismatch`).

Telemetry windows and peak (and the matching `TaskView` fields) are computed
from this-run transferred bytes after a resume (0.2.2). `avgBps` is
`downloaded / elapsed` over the task's accumulated lifetime, persisted across
restarts; neither a window nor a peak ever inherits the adopted `.part` bytes.

`telemetry.trend`: `rising|steady|falling|stalled|unknown`. ETA confidence is
`high` (total known, no stall, ≥5 samples, window CV < 0.35), `medium` (total
known, no stall, ≥2 samples), `low` (total known but unstable/stalling), or
`unknown`. A window rate is measured over the samples available inside that
trailing window (≥2 samples required; `null` below that). A transfer shorter than
a window therefore reports its measured rate in every non-empty window — the
value is a measured rate over the available span, not a claim of full-window
coverage.

`diagnosis` is a bounded list (max 4) of stable codes with machine advice:
`on-track` (wait), `stalled` (inspect-or-restart), `throttled` (wait/lower
connections), `origin-slow` (retry later), `no-range` (single stream, do not
resume), `weak-validators` (avoid resume if remote changes), `checksum-available`
(verify), `signed-url-expiring` (do not pause), `disk-slow` (io wait),
`retrying` (wait), `almost-done` (wait).

### TaskEvent

```jsonc
{"seq":1,"at":1762560000000,"kind":"plan","message":null,"chunk":null,"attempt":null,"delayMs":null}
```

`kind` ∈ `info`, `probe`, `plan`, `started`, `retry`, `controller`, `paused`,
`resumed`, `verify`, `completed`, `failed`, `cancelled`. No new event kinds were
added in 0.2.1 or 0.2.2. Events are a bounded in-memory ring (last 200 per task;
every event is also appended to the per-task recording, see
[Recording](#recording)) and are diagnostic only; task state is authoritative.

Two event messages have a stable shape (0.2.2):

* `plan` — one line:
  `"{total} bytes; chunks={chunks} chunk={chunk_size}; requested={requested} initial={initial} ceiling={max}; resumed={resumed_bytes} bytes resume={decision}"`,
  where `resume={decision}` is `not-attempted` on a fresh transfer and
  `{decision}:{reason}` when a reason exists (e.g. `resume=accepted:etag`).
  `initial` is the planned worker population, `ceiling` is the effective
  `maxConnections`, `requested` is the caller's count.
* `resume state saved` — `"resume state saved: {ranges} ranges / {chunks}
  chunks / {bytes} bytes"` where `ranges` is the merged-range count and `chunks`
  is the number of chunks those ranges cover (so the numbers stop contradicting
  each other on multi-chunk ranges).

`controller` messages are free-form but state the decision and its numbers. The
vocabulary is stable — grow, revert, shrink, collapse-driven pool rebuild,
backoff, saturation freeze/unfreeze, tail hold; the shipped 0.2.2 shapes are:

```text
grow to 24: aggregate 113.0 MiB/s, per-connection 1.8 MiB/s
revert to 64: growth dropped aggregate rate (114.0 -> 112.5 MiB/s)
growth frozen: aggregate gain < 2% at 113.0 MiB/s over 2 probes
growth unfrozen: aggregate 99.0 MiB/s vs frozen peak 113.0 MiB/s
pool rebuild #1: 70.4 -> 9.4 MiB/s at 32 workers
backoff to 8: server pushback (429/503)
shrink to 12: average rate falling
tail: target frozen at 70 workers (remaining claim units 70)
```

### Aggregate

Included in `list` results.

```jsonc
{
  "total": 12, "active": 2, "paused": 1, "failed": 1,
  "completed": 8, "bytesDownloaded": 918273645,
  "nowBps": 4404019, "w5Bps": 3984588, "w30Bps": 3523215, "w300Bps": null,
  "riskCount": 0
}
```

`riskCount` counts live tasks whose server facts carry an expiring/expired signed
URL or TLS certificate, or whose task has no usable resume support.

## Methods

### `initialize`

```jsonc
{"defaultDir":"C:\\\\Downloads","connections":8,"maxConnections":128,
 "chunkSizeBytes":0,"speedLimitBps":0,"maxAttempts":6,"autoResume":true,
 "logLevel":"warn","fsyncOnComplete":false}
```

Result:

```jsonc
{"protocol":2,
 "kernel":{"version":"0.3.0","pid":1234,"dataDir":"C:\\\\Users\\\\x\\\\.dsh\\\\dsh-rdm"},
 "config":{"defaultDir":"C:\\\\Downloads","connections":8,"maxConnections":128,
           "chunkSizeBytes":0,"speedLimitBps":0,"maxAttempts":6,"autoResume":true,
           "logLevel":"warn","fsyncOnComplete":false}}
```

Defaults apply for omitted fields. `initialize` may be sent once; later calls
update defaults for *new* tasks only. `maxConnections` defaults to `128` and is
normalized to `[connections, 128]`; it is the authoritative adaptive ceiling for
tasks whose `start` does not override it.

`chunkSizeBytes: 0` selects the automatic plan: four chunks per connection,
bounded to 256 KiB..8 MiB. `fsyncOnComplete: true` flushes each finished file to
stable storage before the atomic rename; the default (`false`) leaves the data in
the OS page cache.

### `probe`

`params`: `{url, headers?, cookie?, referer?, userAgent?, proxy?, insecure?, timeoutMs?}`

Result: `{"server": ServerFacts}`. Never downloads the body. Redirects are
followed manually (≤ 8) and reported. On a server without `Accept-Ranges` the
kernel issues one ranged `GET` (`bytes=0-0`) to prove range support before
reporting `range.supported`. `timing.sampleBps` is emitted only when the proving
request actually read at least 64 KiB (a 64-byte range probe cannot measure
throughput; the field is `null` otherwise). If the HEAD succeeds but that ranged
proving request fails transiently, the probe degrades safely to
`range.supported: false` (single-stream; no range-support claim either way)
without raising a warning. TLS validity comes from the leaf certificate of the
final response when the transport exposes it.

### `start`

`params`: `RequestSpec`:

```jsonc
{
  "url": "https://example.com/file.iso",       // required, http/https only
  "dir": "C:\\Downloads",                       // absolute; default = initialize.defaultDir or process cwd
  "fileName": "file.iso",                       // optional override; sanitized
  "connections": 8,                             // 1..128, default initialize.connections (8)
  "maxConnections": 128,                        // optional adaptive ceiling, default initialize.maxConnections; clamped to [connections, 128]
  "chunkSizeBytes": 0,                          // 0 = auto; otherwise 262144..67108864
  "headers": {"Authorization": "Bearer ..."},
  "cookie": "a=1; b=2",
  "referer": "https://example.com/",
  "userAgent": "custom/1.0",
  "expectedSha256": "<64 hex>",
  "speedLimitBps": 1048576,
  "resume": true,
  "singleStream": false,
  "proxy": "http://127.0.0.1:7890",
  "insecure": false,
  "maxAttempts": 6,
  "sessionId": "sess_abc"                       // owning agent session; ≤160 chars of [A-Za-z0-9._:-]
}
```

`dir` is created if missing. `start` returns immediately with a `TaskView`
(status usually `queued` or `probing`); the transfer runs in the background. The
owning plugin should wait for the probe phase (poll `get`/observe the first
notification with `rangeSupported != null`) when it wants preflight server facts.

`connections` accepts `1..128` and is the task's initial worker population
(reported back as `TaskView.connections`). The optional `maxConnections`
overrides the task's adaptive ceiling: the resolved value is
`raw.maxConnections ?? initialize.maxConnections`, clamped to
`[connections, 128]`. The controller starts at `connections` workers and may
grow `targetWorkers` beyond it up to `maxConnections` — and revert or rebuild
the pool — based on measured per-connection throughput. `singleStream: true`
forces both `connections` and `maxConnections` to `1`.

### `list`

`params`: `{"status"?: "running" | ["paused","failed"], "sessionId"?: "sess_abc", "limit"?: 50}`
(limit 1..200, default 50; newest first).

Result: `{"tasks": [TaskView], "aggregate": Aggregate}`.

### `get`

`params`: `{"id": "t_...", "events"?: 50}` (events 0..500, default 50, oldest
first).

Result: `{"task": TaskView, "detail": TaskDetail, "events": [TaskEvent]}`.

### `wait`

`params`: `{"ids": ["t_..."], "timeoutMs"?: 60000}` (1..20 ids, timeout
100..300000, default 60000). Waits until **every** id is terminal or the timeout
expires. Unknown ids fail with `not_found`.

Result: `{"tasks": [TaskView], "timedOut": false}`.

### `control`

`params`: `{"id":"t_...","action":"pause|resume|cancel|retry|remove","deletePart"?:false}`

* `pause` — cooperative stop of a `queued|probing|running` task; persists resume
  state; status becomes `paused`. A second `pause` on an already-paused task is a
  no-op success (controls are safe to retry).
* `resume` — continues from `paused|interrupted|cancelled|failed` when a valid
  `.part` state exists, otherwise restarts from zero. Compatibility is decided on
  stable identity (so a new volatile token in the final URL does not discard the
  state); the decision and its reason are reported in
  `TaskDetail.resumeState` as `resumeDecision`/`resumeReason`. Status returns to
  `queued`. `resume` on a still-active task is a no-op success: the engine may
  need a moment to observe a preceding `pause`, and agents retry tool calls.
* `cancel` — stops the task; keeps `.part`/state; status `cancelled`.
* `retry` — discards `.part`/state and starts over from zero.
* `remove` — deletes the task record; when `deletePart` is true also deletes
  `.part`/state, never the completed target file. Running task is cancelled first.

Result: `{"task": TaskView | null}` (`null` for `remove`).

### `stats`

Result:

```jsonc
{"protocol":2,"kernel":{"version":"0.3.0","pid":1234,"uptimeMs":123456,
  "dataDir":"C:\\\\Users\\\\x\\\\.dsh\\\\dsh-rdm"},
 "tasks":{"total":3,"queued":0,"running":1,"paused":1,"completed":1,
          "failed":0,"cancelled":0,"interrupted":0},
 "totals":{"bytesDownloaded":987654321,"downloadsCompleted":12,"downloadsFailed":1},
 "throughput":{"nowBps":4404019,"w5Bps":3984588,"w30Bps":3523215,"w300Bps":null},
 "origins":7,
 "config":{...}}
```

### `history`

Reads the persisted per-task recording (see [Recording](#recording)): the
per-run meta/build records, the per-sample telemetry series and the retained task
events, including `controller` decisions. Survives kernel restarts and kernel
generations.

`params`:

```jsonc
{ "id": "t_…", "offset": 0, "limit": 500, "raw": false, "includeEvents": true, "eventsLimit": 200 }
```

`id` is required. `limit` clamps `1..5000` (default 500). `offset` is `≥ 0`
(default 0) and selects the literal first sample only when `raw` is true; the
default view is a review series (see below). `raw` (default `false`) selects a
literal sample page from `offset` instead of the evenly downsampled review
series. `eventsLimit` clamps `1..2000` (default 200) and returns the **most
recent** events (ring semantics, not offset-paged). `includeEvents: false` skips
reading/returning events (default `true`).

Samples are bounded twice: the JSONL writer stops at `MAX_RECORDED_SAMPLES`, and
a `limit` below the recorded count yields an evenly downsampled series (first and
last samples always included) with `sampleStride > 1` when `raw` is false. This
keeps a 100k-sample recording readable in one bounded response without lying
about the returned rows: `sampleStride` / `offset` say what was returned.

Result:

```jsonc
{
  "taskId": "t_…",
  "samplesPath": "<dataDir>/history/t_….samples.jsonl",   // null if never recorded
  "eventsPath": "<dataDir>/history/t_….events.jsonl",
  "samples": [ {
    "t": 1794154378463, "bytes": 11596411699, "bps": 21893785,
    "w1Bps": 40799331, "w5Bps": 27746112, "w30Bps": 26249892, "w300Bps": 23727081,
    "workers": 16, "peakWorkers": 16, "stalledMs": 0
  } ],
  "events": [ {
    "t": 1794154378463, "seq": 3, "kind": "plan", "message": "…",
    "chunk": null, "attempt": null, "delayMs": null
  } ],
  "totalSamples": 1907, "totalEvents": 42,
  "truncated": false,
  "sampleStride": 1,     // 1 = consecutive rows; >1 = evenly downsampled
  "offset": 0,           // resolved first-sample offset of the returned page
  "meta": [ {            // per-run build/plan attribution (0.2.2; empty for 0.2.1-era files)
    "kind": "meta", "t": 1794197622684, "kernelVersion": "0.3.0", "pid": 1234,
    "taskId": "t_…", "run": 1, "phase": "plan", "url": "<redacted>",
    "fileName": "a.gguf", "totalBytes": 22360456160, "chunkSize": 8388608,
    "chunks": 2666, "requestedConnections": 16, "initialWorkers": 16,
    "maxConnections": 128, "resumedBytes": 0,
    "resumeDecision": "not-attempted", "resumeReason": null
  } ]
}
```

Unknown task id → `not_found`. A task with no recording yet returns `samples:
[]`, `events: []`, `meta: []`, both paths `null` — unless a history file for
that task id already exists on disk from an earlier kernel generation, in which
case it is read. `totalSamples` / `totalEvents` count the retained samples/events
on disk (meta and truncation-marker lines are not samples). `truncated` is `true`
only when the sample recorder hit its per-task cap (the marker was seen).

`meta` carries up to the most recent `MAX_META_RECORDS = 20` per-run records;
it is empty for 0.2.1-era recordings. The host projects it as `builds` tags on
`rdm_history`; the RPC returns the raw records.

### `shutdown`

Result: `{}`; kernel persists state and exits within 2 seconds.

## Notifications

```jsonc
{"event":"ready","protocol":2,"kernel":{"version":"0.3.0","pid":1234,"dataDir":"..."}}
{"event":"task","task": TaskView}
```

`task` notifications are sent on every status/error/summary transition and, while
a task is `running`, at most twice per second per task (progress is also readable
via `list`/`get`). They always carry the flat `TaskView`, never `TaskDetail`.
Notifications may interleave with responses on stdout.

## Error codes

| code | meaning |
|---|---|
| `invalid_request` | malformed params/JSON, bad URL, bad range |
| `not_found` | unknown task id |
| `conflict` | action not valid for the current status |
| `protocol_mismatch` | the peer kernel reports an unsupported protocol version |
| `http_status` | non-success HTTP status from origin (message carries status) |
| `network` | DNS/connect/TLS/body failure after retries |
| `remote_changed` | validators/size changed during resume |
| `checksum_mismatch` | `expectedSha256` mismatch |
| `io` | local filesystem failure |
| `cancelled` | control-flow result reported by long operations |
| `unsupported` | kernel cannot honor the request |
| `unsupported_method` | the kernel does not implement the requested RPC method (0.2.2; message names the method and kernel version and carries an upgrade hint) |
| `internal` | unexpected kernel error |

## Guarantees / non-goals

* **Multi-connection**: when the origin advertises ranges, the kernel splits the
  file into fixed chunks, hands them out dynamically to a worker pool (slow
  chunks never pin the tail), and adapts the active worker count toward the
  configured cap. 0.2.1: the controller starts at `connections`, may grow the
  target up to `maxConnections` while per-connection throughput shows headroom,
  reverts growth that dilutes throughput, backs off on server pushback, and
  rebuilds the HTTP connection pool (fresh TCP/TLS) when throughput collapses
  while workers stay pinned — every decision is a `controller` event. 0.2.2:
  growth is judged on **aggregate** rate (a probe is kept unless aggregate drops
  below 95 %); a revert waits out a 30-tick cooldown; two consecutive kept
  growths that raise aggregate by less than 2 % put the controller in a
  **saturation** freeze until throughput falls below 90 % of the frozen peak (or
  120 ticks pass); when `remaining → target` the controller **freezes the target**
  (no grow/shrink/collapse) so tail draining does not read as "average rate
  falling".
* **Final snapshots are exact**: any terminal transition (completed, failed,
  cancelled) flushes a final task view; a completed task always reports
  `downloaded == total` and `finishedAt`/`elapsedMs` set, and pause/cancel/fail
  report the real byte count written so far.
* **Resumable**: `.part` + `<target>.part.json` resume state with validator
  checks under RFC 9110 strong comparison (strong ETag -> `If-Range`; weak
  validators are re-probed and `Content-Range`/length validated, never used as a
  strong precondition); resume survives kernel restarts; `resumeSafety` tells the
  caller how much the validators can be trusted. 0.2.1: compatibility is decided
  on stable identity (URL path, size, validators), so a *new* per-request
  `auth_key`/`Expires`/`Policy` token in the final URL no longer discards a
  completed chunk table, and every attempt reports `resumeDecision` /
  `resumeReason`. 0.2.2: resume-state events and `resumeState.chunksDone` report
  **ranges / chunks / bytes** separately, with chunks derived from the chunk
  plan, and the rate history restarts at zero on the resumed run.
* **Byte-level correctness**: every ranged response is validated against the
  expected Content-Range/total before writing; the final file size must equal the
  advertised total; `expectedSha256` is verified before renaming `.part`. The
  verification is serial after the transfer in 0.2.2 (out-of-order chunks cannot
  be streamed into one SHA-256; a chunk-hash tree would change the contract).
* **Failure isolation**: a chunk retries with exponential backoff on transport
  errors, 408/429/5xx (honoring `Retry-After`) before the task fails. Near
  completion the stall timeout tightens: 30 s normally, 10 s after 90 % done,
  5 s after 97 %. 0.2.2: once the remaining chunk count is ≤ the worker target,
  a **tail** claim uses a 3 s stall deadline and fast retries — delay
  `min(250 ms × attempt, 1 s)` instead of the normal backoff — so the last few
  long-tail connections do not hold up the finish for 10 s at a time.
* **Telemetry is measured, not invented**: windows are byte deltas over trailing
  wall-clock intervals; `null` means "not enough data", never zero-as-unknown.
  0.2.2: after a resume the windows and peak start from the resumed run's
  baseline (`transferredBytes`); `avgBps` uses whole-file progress over the
  persisted lifetime — neither inherits the adopted bytes as a rate.
* **Recording is advisory**: per-sample telemetry, per-run meta records and
  events are appended to JSONL under `<data-dir>/history/`; a recording write
  error must never fail or slow a download, and the recording is bounded per
  task. The meta record is what attributes a JSONL timeline to the kernel build
  that produced it when a session spans builds.
* Not supported (deliberately removed from the RDM core): mirrors, HTTP/2
  preference for range workers, per-origin learned budgets beyond the origin
  ledger, GUI/IPC/MCP, resolver/AI layers, legacy serialized state compatibility.

## Recording

0.2.1 persists download data instead of keeping it only in kernel memory; 0.2.2
adds a per-run **meta record** so a JSONL timeline that spans kernel builds can
be attributed. The directory is `<data-dir>/history/`, created on demand under
the kernel's `--data-dir`; files append across pause/resume/retry/auto-resume
(same task id, same files) and survive kernel restarts.

`<taskId>.samples.jsonl` — one JSON object per line, appended at the reporter
cadence (≤ 10/s) while a transfer is running, flushed at least once per second
and at terminal transitions:

```json
{"t":1794154378463,"bytes":11596411699,"bps":21893785,"w1Bps":40799331,"w5Bps":27746112,"w30Bps":26249892,"w300Bps":23727081,"workers":16,"peakWorkers":16,"stalledMs":0}
```

Fields: `t` (sample wall-clock ms), cumulative `bytes`, instantaneous `bps`, the
four trailing-window rates (last one `null` when the window has too little data),
`workers` (active at sample time), `peakWorkers`, `stalledMs`.

Before the first sample of **each run**, the same file gets one meta record
(0.2.2; written at plan time, `kind` distinguishes it from samples):

```jsonc
{"kind":"meta","t":1794197622684,"kernelVersion":"0.2.2","pid":1234,
 "taskId":"t_…","run":3,"phase":"plan",
 "url":"<redacted>","fileName":"a.gguf","totalBytes":22360456160,
 "chunkSize":8388608,"chunks":2666,
 "requestedConnections":16,"initialWorkers":16,"maxConnections":128,
 "resumedBytes":0,"resumeDecision":"not-attempted","resumeReason":null}
```

Rules for meta: one record per run (a retry or a new kernel build appends
another record to the same file); `run` is a monotonic 1-based run generation
within the kernel process; `url` is redacted like every protocol projection;
`totalBytes`/`chunkSize`/`chunks` are `null` only when the plan does not know
them (unknown size / single stream); the reader skips meta lines when counting
samples and exposes up to the most recent `MAX_META_RECORDS = 20` records.
Histories written by 0.2.1 (no meta) remain readable.

`<taskId>.events.jsonl` — one JSON object per retained task event, the same
events `get` returns (including `controller` decisions):

```json
{"t":1794154378463,"seq":3,"kind":"plan","message":"…","chunk":null,"attempt":null,"delayMs":null}
```

Rules:

* **Bounded**: hard cap `MAX_RECORDED_SAMPLES = 100_000` samples per task
  (meta records are not samples and do not count); on overflow the writer
  appends `{"t":<ms>,"truncated":true}` once (the shipped kernel also includes
  `"reason":"sample-cap"`) and stops sampling. Events keep appending (they are
  already bounded per task).
* **Redacted**: event messages and the meta `url` pass through `redact_text`
  before being written, the same as the in-memory event ring.
* **Advisory**: a recording write error must never fail or slow a download.
  Recording is best-effort diagnostics, not part of the durability contract.
* **Read back** with [`history`](#history), which returns a bounded sample page
  (evenly downsampled by default), the most recent events, and the retained meta
  records, and reports the paths plus `truncated`.

## Persistence layout

```
<data-dir>/
  tasks/<task-id>.json     # task record: spec + status + timestamps + result + server facts
  origins.json             # bounded per-host history (≤256 hosts), atomic replace
  history/<task-id>.samples.jsonl   # per-sample telemetry series (appended, bounded)
  history/<task-id>.events.jsonl    # retained task events (appended, redacted)
```

`TaskRecord` in v2 also stores `sessionId`, telemetry aggregates
(`avgBps`/`peakBps`), `rangeSupported`, `resumeSafety`, `signedUrlExpiresAt`,
`tlsNotAfter` and the last `ServerFacts` snapshot, so a completed download stays
reviewable after a kernel restart. Records written by protocol v1 load unchanged
(missing fields default); `.part.json` resume state written before 0.2.1 also
loads (stable-identity compatibility re-evaluates it rather than refusing it).
Download files live wherever the task requested (`dir`), with `<target>.part`
while incomplete and `<target>.part.json` as resume state; both are removed on
successful completion.

## 0.2.1 additive changes

Protocol stays **2** and the envelope is unchanged; release 0.2.1 (kernel
1.1.0) is additive — it adds fields and one method, breaks nothing:

1. `MAX_CONNECTIONS` 32 → **128**; `DEFAULT_MAX_CONNECTIONS = 128`.
2. `initialize` gains `maxConnections` (default 128, clamped `[connections, 128]`);
   its result `config` echoes it.
3. `start` `RequestSpec` gains optional `maxConnections`; `connections` now
   accepts `1..128`; `singleStream` forces both to 1.
4. `TaskView` gains `maxConnections`, `targetWorkers`, `resumedBytes`.
5. `TaskDetail.resumeState` gains `resumeDecision` (`accepted` | `rejected` |
   `not-attempted`) and `resumeReason` (see [TaskDetail](#taskdetail)); resume
   compatibility is now decided on stable identity, not the volatile final URL.
6. New `history` method: bounded (evenly downsampled by default) per-task sample
   page + the most recent events + file paths; `raw: true` returns a literal
   sample page from `offset`.
7. New on-disk recording format under `<data-dir>/history/` (see
   [Recording](#recording)); the in-memory event ring and telemetry windows are
   unchanged.
8. `auth_key` is treated as signed-URL material and redacted in every protocol
   projection, including redirect hops; controller growth toward
   `maxConnections`, reverts, shrink steps, collapse-driven pool rebuilds and
   backoffs are reported as `controller` events (no new event kinds).
9. Near completion the stall timeout tightens (30 s → 10 s after 90 % → 5 s
   after 97 %).

## 0.2.2 additive changes

Protocol stays **2** and the envelope is unchanged; release 0.2.2 (kernel
**0.2.2**) is additive — no existing field changes meaning:

1. **Kernel identity** is `0.2.2` — the same version as the plugin package
   (`package.json` and `kernel/Cargo.toml`) — in the ready/initialize/stats
   frames, so a recording can be attributed to the build that produced it.
   Historical recordings keep recorded strings: 0.2.1 kernel = `1.1.0`,
   pre-unification 0.2.2 builds = `1.2.0`; only the current build reports 0.2.2.
2. **History meta record**: `<task>.samples.jsonl` gains one
   `{"kind":"meta",…}` record before the first sample of each run — kernel
   version, pid, task/run/phase, redacted url, file name, total/chunk/chunks,
   requested/initial/ceiling workers, resumed bytes + resume decision/reason.
   Meta lines are skipped by sample totals; `history` adds `meta` (most recent
   ≤ 20 records); 0.2.1-era files without meta stay readable.
3. **`TaskView`** gains `transferredBytes` (bytes transferred by the current run
   only) and `requestedConnections` (the caller's requested count; `connections`
   remains the initial planned population).
4. **Rate accounting**: reporter windows/EWMA/peak and the ETA start from a
   this-run baseline (`transferredBytes`); `avgBps = downloaded / elapsed` over
   the persisted task lifetime. No speed, peak or average inherits the adopted
   `.part` bytes.
5. **Controller policy**: growth verdict is aggregate-based (a probe is kept
   unless aggregate throughput drops below 95 % of its pre-probe value; revert
   cooldown 30 ticks); saturation freeze (two consecutive kept growths that add
   < 2 % aggregate stop growth until throughput falls below 90 % of the frozen
   peak or 120 ticks pass); tail freeze (when remaining claim units ≤ target, no
   grow/shrink/collapse).
6. **Tail retries**: tail claims use a 3 s stall deadline and retry delay
   `min(250 ms × attempt, 1 s)`; non-tail retry backoff is unchanged.
7. **Stable event/receipt shapes**: the `plan` event carries requested/initial/
   ceiling plus resume info; `resume state saved` reports ranges / chunks /
   bytes; `resumeState.chunksDone` is the number of chunks covered by the merged
   ranges.
8. **`unsupported_method`** error code for an RPC method the kernel does not
   implement (message names the method and kernel version, with an upgrade hint).
9. No tool parameter changes; `rdm_history` derives `builds` tags from the meta
   records and adds one `build=` receipt line when they exist. No new event
   kinds.

## 0.3.0 additive changes

Protocol stays **2**; release **0.3.0** (kernel identity
`0.3.0`) adds multi-source scheduling with defaulted fields, so an older
task record still loads and a single-URL request is unchanged.

1. **`start` request fields** (all optional):
   - `sources[]` — up to seven additional HTTP(S) candidates:
     `{url, headers?, cookie?, priority?}`; the primary `url` is always source 0.
     Duplicate URLs are dropped and the list is capped at 8.
   - `sourcePolicy` — `single | select | failover | hedge | race`. Omitted means
     `select` when `sources[]` is non-empty, otherwise `single`.
   - `sourceRaceBytes` — hedge window, clamped to 64 KiB..64 MiB (default 1 MiB).
   - `discoverSources` — parse Metalink/HTTP `Link: rel=duplicate` mirrors
     (default true; HTTP(S) only).
   - `metalinkFile` — select a file by name when `url` is a `.meta4`/`.metalink`
     document. A single-file document needs no selector.
2. **`ServerFacts.mirrors[]`** — discovered mirrors
   `{url, priority, geo, source}`; URLs are redacted. Only HTTP(S) mirrors are
   accepted; FTP/torrent entries in a Metalink document are ignored.
3. **`TaskView`/`TaskDetail`** gain:
   - `sourcePolicy` (effective policy; a `race`/`failover` without a strong
     shared content identity is downgraded to `select` and a `source` event says
     why),
   - `selectedSource` (index into `sources[]` or `null`),
   - `sourceSwitches` (count of active-source changes),
   - `sources[]` — bounded to 8 rows:
     `{id, url, host, state:"active"|"standby"|"bad",
       role:"primary"|"alternate"|"discovered", bytes, bps, active, lastError}`.
     `url` is redacted.
4. **Resume state** `.part.json` gains `contentKey`: a source-independent
   identity (`sha256:<hex>`, or `size:<n>;etag:<strong>`, or a weak
   size/mtime key). When both saved and current keys are strong and equal, a
   resumed task may continue from a different mirror and reports
   `resumeDecision: "accepted"` with a `content-key` reason; a mismatch is
   `validators-mismatch`. Legacy records without `contentKey` keep the
   URL/validator identity path.
5. **New `source` event kind** (free-form, bounded): selection, switch, hedge,
   quarantine, discovery and policy-downgrade messages. Receipts add a
   `source=` line (policy/selected/count/switches) and per-source lines in the
   task detail; probe receipts add `mirrors=` when discovery found any.
6. **Safety**: `race`/`failover` may move bytes between sources only when every
   source has the same strong content identity (`expectedSha256`, server
   SHA-256/Content-Digest, or equal size + strong ETag). `select`/`hedge` never
   mix bytes: they choose/commit to one source. This is a product contract, not
   just an implementation detail.
7. **No RPC or envelope changes**; `stats`/`list`/`wait`/`control`/`history`
   keep their shapes. Single-source requests keep the 64-byte probe; multi-source
   probes use a 256 KiB ranged sample so the selection is measured rather than
   noise.
