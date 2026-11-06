# RDM Kernel Protocol v1

The kernel (`rdm-kernel`) is a resident child process of the `dsh-rdm` DSH plugin.
It speaks **newline-delimited JSON (NDJSON)** over its stdio pipes: one UTF-8 JSON
object per line, `\n` terminated, no pretty printing.

* `stdout` carries protocol messages only (responses + notifications).
* `stderr` carries human-readable logs; the plugin drains it and never parses it.
* The kernel exits when `stdin` reaches EOF (parent plugin gone) or on `shutdown`.
* The kernel never listens on a network port. All control is parent→child stdio.

This protocol is private to the plugin: it is versioned here, and no
compatibility with other downloaders, their CLIs or their persisted state is
promised or implemented.

## Lifecycle

1. Plugin spawns `rdm-kernel --data-dir <dir> [--log-level warn]`.
2. Kernel creates `<data-dir>/tasks/`, loads persisted task records, marks tasks
   that were `running`/`probing`/`queued` in the previous kernel generation as
   `interrupted` (or auto-resumes them when `autoResume` is true), then writes:

   ```json
   {"event":"ready","protocol":1,"kernel":{"version":"1.0.0","pid":1234,"dataDir":"C:\\...\\dsh-rdm"}}
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

### RequestSpec (input of `start`)

```jsonc
{
  "url": "https://example.com/file.iso", // required, http/https only
  "dir": "C:\\Downloads",                // absolute; default = initialize.defaultDir or process cwd
  "fileName": "file.iso",                // optional override; sanitized
  "connections": 8,                      // 1..32, default initialize.connections (8)
  "chunkSizeBytes": 0,                   // 0 = auto; otherwise 262144..67108864
  "headers": {"Authorization": "Bearer ..."}, // optional extra request headers
  "cookie": "a=1; b=2",                  // optional Cookie header
  "referer": "https://example.com/",     // optional
  "userAgent": "custom/1.0",             // optional (default "dsh-rdm/<version>")
  "expectedSha256": "<64 hex>",          // optional post-download verification
  "speedLimitBps": 1048576,              // optional per-task bandwidth cap
  "resume": true,                        // default true
  "singleStream": false,                 // force exactly one rangeless GET
  "proxy": "http://127.0.0.1:7890",      // optional HTTP proxy
  "insecure": false,                     // accept invalid TLS certs (debug only)
  "maxAttempts": 6                       // per-chunk retry budget, default 6
}
```

`dir` is created if missing. `start` returns immediately with a `TaskView`
(status usually `queued` or `probing`); the transfer runs in the background.

### TaskView

```jsonc
{
  "id": "t_9f3a1c2d5e6b7a80",
  "url": "https://example.com/file.iso",
  "finalUrl": "https://cdn.example.com/file.iso", // null until probed
  "fileName": "file.iso",
  "dir": "C:\\Downloads",
  "path": "C:\\Downloads\\file.iso",              // null until target resolved
  "status": "queued",                              // see Status
  "downloaded": 0,                                 // bytes written to .part
  "total": 123456789,                              // null until known
  "speedBps": 0,                                   // EWMA over ~2s, 0 when idle
  "etaSecs": null,
  "activeWorkers": 0,
  "peakWorkers": 0,
  "connections": 8,                                // planned cap
  "chunkSize": 4194304,                            // null for single-stream
  "resumedChunks": 0,
  "rangeSupported": null,                          // null until probed
  "expectedSha256": null,
  "sha256": null,                                  // set on success when verified
  "error": null,                                   // {"code","message"} on failure
  "retries": 0,
  "createdAt": 1762560000000,                      // ms epoch
  "startedAt": null,
  "finishedAt": null,
  "elapsedMs": 0,
  "resumable": false
}
```

Status values: `queued`, `probing`, `running`, `paused`, `completed`, `failed`,
`cancelled`, `interrupted`.

Terminal: `completed`, `failed`, `cancelled`. Resumable: `paused`, `interrupted`,
`cancelled` (when a valid `.part` + resume state exists), `failed` only after an
explicit `retry`.

### TaskEvent

```jsonc
{"seq":1,"at":1762560000000,"kind":"plan","message":null,"chunk":null,"attempt":null,"delayMs":null}
```

`kind` ∈ `info`, `probe`, `plan`, `started`, `retry`, `controller`, `paused`,
`resumed`, `verify`, `completed`, `failed`, `cancelled`. Events are a bounded
in-memory ring (last 200 per task) and are diagnostic only; task state is
authoritative.

### Meta (result of `probe`)

```jsonc
{
  "finalUrl": "https://cdn.example.com/file.iso",
  "fileName": "file.iso",
  "totalBytes": 123456789,          // null when unknown
  "supportsRanges": true,
  "contentType": "application/octet-stream",
  "etag": "\"v1\"",
  "lastModified": "Wed, 21 Oct 2026 07:28:00 GMT",
  "httpVersion": "HTTP/1.1"
}
```

## Methods

### `initialize`

```jsonc
{"defaultDir":"C:\\Downloads","connections":8,"chunkSizeBytes":0,
 "speedLimitBps":0,"maxAttempts":6,"autoResume":true,"logLevel":"warn",
 "fsyncOnComplete":false}
```

Result:

```jsonc
{"protocol":1,
 "kernel":{"version":"1.0.0","pid":1234,"dataDir":"C:\\Users\\x\\.dsh\\dsh-rdm"},
 "config":{"defaultDir":"C:\\Downloads","connections":8,"chunkSizeBytes":0,
           "speedLimitBps":0,"maxAttempts":6,"autoResume":true,"logLevel":"warn",
           "fsyncOnComplete":false}}
```

Defaults apply for omitted fields. `initialize` may be sent once; later calls
update defaults for *new* tasks only.

`chunkSizeBytes: 0` selects the automatic plan: four chunks per connection,
bounded to 256 KiB..8 MiB. `fsyncOnComplete: true` flushes each finished file to
stable storage before the atomic rename; the default (`false`) leaves the data in
the OS page cache, which protects against process crashes but not power loss.

### `probe`

`params`: `{url, headers?, cookie?, referer?, userAgent?, proxy?, insecure?, timeoutMs?}`

Result: `{"meta": Meta}`. Never downloads the body. On a server without
`Accept-Ranges` the kernel issues one ranged `GET` (bytes `0-0`) to prove range
support before reporting `supportsRanges`.

### `start`

`params`: `RequestSpec`. Result: `{"task": TaskView}`.

### `list`

`params`: `{"status"?: "running" | ["paused","failed"], "limit"?: 50}` (limit
1..200, default 50; newest first). Result: `{"tasks": [TaskView]}`.

### `get`

`params`: `{"id": "t_...", "events"?: 50}` (events 0..500, default 50, oldest
first). Result: `{"task": TaskView, "events": [TaskEvent]}`.

### `wait`

`params`: `{"ids": ["t_..."], "timeoutMs"?: 60000}` (1..20 ids, timeout
100..300000, default 60000). Waits until **every** id is terminal or the timeout
expires. Unknown ids fail with `not_found`. Result:
`{"tasks": [TaskView], "timedOut": false}`.

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

Result: `{"task": TaskView}` (`null` for `remove`).

### `stats`

Result:

```jsonc
{"protocol":1,"kernel":{"version":"1.0.0","pid":1234,"uptimeMs":123456,
  "dataDir":"C:\\Users\\x\\.dsh\\dsh-rdm"},
 "tasks":{"total":3,"queued":0,"running":1,"paused":1,"completed":1,
          "failed":0,"cancelled":0,"interrupted":0},
 "totals":{"bytesDownloaded":987654321,"downloadsCompleted":12,"downloadsFailed":1},
 "config":{...}}
```

### `shutdown`

Result `{"ok":true}`; kernel persists state and exits within 2 seconds.

## Notifications

```jsonc
{"event":"ready","protocol":1,"kernel":{"version":"1.0.0","pid":1234,"dataDir":"..."}}
{"event":"task","task": TaskView}
```

`task` notifications are sent on every status/error/summary transition and, while
a task is `running`, at most twice per second per task (progress is also readable
via `list`/`get`). Notifications may interleave with responses on stdout.

## Error codes

| code | meaning |
|---|---|
| `invalid_request` | malformed params/JSON, bad URL, bad range |
| `not_found` | unknown task id |
| `conflict` | action not valid for the current status |
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
  checks (ETag, Last-Modified, total length); resume survives kernel restarts.
* **Byte-level correctness**: every ranged response is validated against the
  expected Content-Range/total before writing; the final file size must equal
  the advertised total; `expectedSha256` is verified before renaming `.part`.
* **Failure isolation**: a chunk retries with exponential backoff on transport
  errors, 408/429/5xx (honoring `Retry-After`) before the task fails.
* Not supported (deliberately removed from the RDM core): mirrors, HTTP/2
  preference for range workers, per-origin learned budgets, GUI/IPC/MCP,
  resolver/AI layers, legacy serialized state compatibility.

## Persistence layout

```
<data-dir>/
  tasks/<task-id>.json     # task record: spec + status + timestamps + result
```

Download files live wherever the task requested (`dir`), with
`<target>.part` while incomplete and `<target>.part.json` as resume state;
both are removed on successful completion.
