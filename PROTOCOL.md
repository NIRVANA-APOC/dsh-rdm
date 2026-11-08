# RDM Kernel Protocol v2

The kernel (`rdm-kernel`) is a resident child process of the `dsh-rdm` DSH plugin.
It speaks **newline-delimited JSON (NDJSON)** over its stdio pipes: one UTF-8 JSON
object per line, `\n` terminated, no pretty printing.

* `stdout` carries protocol messages only (responses + notifications).
* `stderr` carries human-readable logs; the plugin drains it and never parses it.
* The kernel exits when `stdin` reaches EOF (parent plugin gone) or on `shutdown`.
* The kernel never listens on a network port. All control is parent→child stdio.

Protocol v2 (kernel 1.1.0) is the first "agent-native" revision: tasks carry
session attribution and live telemetry windows, probes return a full server-fact
record (ranges, validators, signed-URL expiry, TLS validity, redirects, timing,
recommendation), and the hot path (`list`/notifications) stays a flat, cheap
`TaskView` while `get` returns a separate `TaskDetail`. Protocol v1 is not
supported: a plugin refuses a kernel whose ready frame reports `protocol != 2`.

This protocol is private to the plugin: it is versioned here, and no
compatibility with other downloaders, their CLIs or their persisted state is
promised or implemented.

## Lifecycle

1. Plugin spawns `rdm-kernel --data-dir <dir> [--log-level warn]`.
2. Kernel creates `<data-dir>/tasks/`, loads persisted task records, marks tasks
   that were `running`/`probing`/`queued` in the previous kernel generation as
   `interrupted` (or auto-resumes them when `autoResume` is true), then writes:

   ```json
   {"event":"ready","protocol":2,"kernel":{"version":"1.1.0","pid":1234,"dataDir":"C:\\\\...\\\\dsh-rdm"}}
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

**Credential redaction.** `ServerFacts.url/finalUrl` and the `url/finalUrl`
fields of `TaskView`/`TaskDetail` replace the values of credential-bearing query
parameters with `<redacted>` (`X-Amz-Signature`, `X-Amz-Credential`,
`X-Amz-Security-Token`, `Signature`, `sig`, `token`, `access_token`, `key`,
`api_key`, `secret`, …). The raw URL stays internal to the kernel. Request
`headers` and `cookie` never appear in any protocol view or event. Task records
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
  "chunkSize": 1572864,
  "resumedChunks": 0,
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
    "validatorsMatched": true
  },
  "timing": { "queuedMs": 100, "probeMs": 84, "transferMs": 17400, "finalizeMs": 0 },
  "diagnosis": [
    { "code": "on-track", "advice": "wait", "message": "ETA 20s at 5s rate" }
  ]
}
```

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
`resumed`, `verify`, `completed`, `failed`, `cancelled`. Events are a bounded
in-memory ring (last 200 per task) and are diagnostic only; task state is
authoritative.

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
{"defaultDir":"C:\\\\Downloads","connections":8,"chunkSizeBytes":0,
 "speedLimitBps":0,"maxAttempts":6,"autoResume":true,"logLevel":"warn",
 "fsyncOnComplete":false}
```

Result:

```jsonc
{"protocol":2,
 "kernel":{"version":"1.1.0","pid":1234,"dataDir":"C:\\\\Users\\\\x\\\\.dsh\\\\dsh-rdm"},
 "config":{"defaultDir":"C:\\\\Downloads","connections":8,"chunkSizeBytes":0,
           "speedLimitBps":0,"maxAttempts":6,"autoResume":true,"logLevel":"warn",
           "fsyncOnComplete":false}}
```

Defaults apply for omitted fields. `initialize` may be sent once; later calls
update defaults for *new* tasks only.

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
  "connections": 8,                             // 1..32, default initialize.connections (8)
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
  state; status becomes `paused`.
* `resume` — continues from `paused|interrupted|cancelled|failed` when a valid
  `.part` state exists, otherwise restarts from zero. Status returns to `queued`.
* `cancel` — stops the task; keeps `.part`/state; status `cancelled`.
* `retry` — discards `.part`/state and starts over from zero.
* `remove` — deletes the task record; when `deletePart` is true also deletes
  `.part`/state, never the completed target file. Running task is cancelled first.

Result: `{"task": TaskView | null}` (`null` for `remove`).

### `stats`

Result:

```jsonc
{"protocol":2,"kernel":{"version":"1.1.0","pid":1234,"uptimeMs":123456,
  "dataDir":"C:\\\\Users\\\\x\\\\.dsh\\\\dsh-rdm"},
 "tasks":{"total":3,"queued":0,"running":1,"paused":1,"completed":1,
          "failed":0,"cancelled":0,"interrupted":0},
 "totals":{"bytesDownloaded":987654321,"downloadsCompleted":12,"downloadsFailed":1},
 "throughput":{"nowBps":4404019,"w5Bps":3984588,"w30Bps":3523215,"w300Bps":null},
 "origins":7,
 "config":{...}}
```

### `shutdown`

Result: `{}`; kernel persists state and exits within 2 seconds.

## Notifications

```jsonc
{"event":"ready","protocol":2,"kernel":{"version":"1.1.0","pid":1234,"dataDir":"..."}}
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
| `internal` | unexpected kernel error |

## Guarantees / non-goals

* **Multi-connection**: when the origin advertises ranges, the kernel splits the
  file into fixed chunks, hands them out dynamically to a worker pool (slow
  chunks never pin the tail), and adapts the active worker count toward the
  configured cap.
* **Final snapshots are exact**: any terminal transition (completed, failed,
  cancelled) flushes a final task view; a completed task always reports
  `downloaded == total` and `finishedAt`/`elapsedMs` set, and pause/cancel/fail
  report the real byte count written so far.
* **Resumable**: `.part` + `<target>.part.json` resume state with validator
  checks under RFC 9110 strong comparison (strong ETag -> `If-Range`; weak
  validators are re-probed and `Content-Range`/length validated, never used as a
  strong precondition); resume survives kernel restarts; `resumeSafety` tells the
  caller how much the validators can be trusted.
* **Byte-level correctness**: every ranged response is validated against the
  expected Content-Range/total before writing; the final file size must equal the
  advertised total; `expectedSha256` is verified before renaming `.part`.
* **Failure isolation**: a chunk retries with exponential backoff on transport
  errors, 408/429/5xx (honoring `Retry-After`) before the task fails.
* **Telemetry is measured, not invented**: windows are byte deltas over trailing
  wall-clock intervals; `null` means "not enough data", never zero-as-unknown.
* Not supported (deliberately removed from the RDM core): mirrors, HTTP/2
  preference for range workers, per-origin learned budgets beyond the origin
  ledger, GUI/IPC/MCP, resolver/AI layers, legacy serialized state compatibility.

## Persistence layout

```
<data-dir>/
  tasks/<task-id>.json     # task record: spec + status + timestamps + result + server facts
  origins.json             # bounded per-host history (≤256 hosts), atomic replace
```

`TaskRecord` in v2 also stores `sessionId`, telemetry aggregates
(`avgBps`/`peakBps`), `rangeSupported`, `resumeSafety`, `signedUrlExpiresAt`,
`tlsNotAfter` and the last `ServerFacts` snapshot, so a completed download stays
reviewable after a kernel restart. Records written by protocol v1 load unchanged
(missing fields default). Download files live wherever the task requested (`dir`),
with `<target>.part` while incomplete and `<target>.part.json` as resume state;
both are removed on successful completion.
