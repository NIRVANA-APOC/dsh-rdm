# dsh-rdm

[English](README.md) | [简体中文](README.zh-CN.md)

**An agent-native downloader for DeepSeek Harness.** One resident Rust kernel,
six model-facing tools that return decision-grade facts, and two review surfaces
for the human: a global download ledger in the left sidebar, and a
session-scoped review tab in the right sidebar.

The agent operates. The human reviews.

![Global download review — light](assets/screenshots/review-light.png)

## What "agent-native" means here

A downloader used by a model is not a GUI that happens to have an API. The agent
has to answer, in as few model steps as possible: *is this URL usable, how should
I fetch it, what is happening now, should I intervene, and can I trust the
result?* `dsh-rdm` 0.3.0-alpha.1 is built around those questions.

* **Decision-grade probe.** `rdm_probe` returns a full server-fact record —
  proven range support, validators and RFC 9110 resume safety, signed-URL
  expiry, TLS certificate validity, redirect chain, checksum availability,
  rate-limit headers, timing, stable warning codes, and a concrete
  recommendation. Not just "200 OK, 48 MB".
* **Preflight on start.** `rdm_download` attaches the same server facts to the
  task (bounded wait, 2 s default) so the agent does not need a second call
  before it can decide to pause, verify, or wait.
* **Honest live telemetry.** Four measured throughput windows (1 s / 5 s /
  30 s / 300 s), peak, average, stall time, trend, and an `etaConfidence` that
  degrades to `unknown` instead of faking precision.
* **Adaptive concurrency that can exceed the request.** A task starts at the
  requested connection count, but the controller may grow the worker target —
  up to `maxConnections` (default 128) — while aggregate throughput shows
  headroom, revert growth that dilutes it, stop growing at a saturated ceiling,
  and rebuild the connection pool when throughput collapses mid-transfer.
  `connections` stays the initial population; `requestedConnections` reports
  what was asked for. During tail drain the target is frozen so the last chunks
  do not read as "throughput falling".
* **Resume that survives volatile URLs.** Resume state is matched on stable
  identity (URL path, size, validators), not the per-request `auth_key` /
  `Expires` / `Policy` token on a signed final URL — so a fresh probe no longer
  throws away already-completed bytes. Every attempt reports `resumeDecision` /
  `resumeReason`.
* **Multi-source scheduling.** `rdm_download` accepts up to eight HTTP(S)
  candidates for one object and a policy: `select` probes them concurrently and
  picks the measured fastest, `failover` switches on failure, `hedge` races the
  first range across the top two, and `race` assigns chunks across the pool under
  per-source caps. Mixing bytes requires a strong shared content identity
  (`expectedSha256`, a server SHA-256/Content-Digest, or equal size + strong
  ETag), so a wrong mirror is refused rather than silently spliced. Metalink/HTTP
  `Link: rel=duplicate` mirrors and `.meta4` documents are discovered
  automatically. The task view/detail show the selected source, alternates,
  switches and per-source bytes/rates. On a real Alpine ISO run, `select` was
  **11.4×** the single official CDN and matched the best manual mirror; see
  [session_logs/20261109-multisource/README.md](session_logs/20261109-multisource/README.md).
* **Recorded download data.** While a task runs, its per-sample telemetry and
  events are appended as JSONL under `<dataDir>/history/`; `rdm_history` reads
  the recording back (bounded) after the fact or after a kernel restart, so a
  transfer can be replayed and the kernel tuned without hand-sampling.
* **Build-attributed recording.** Each run first writes a meta record — kernel
  version, pid, run, file/total/chunk, requested/initial/ceiling workers, resume
  decision — so a recording that spans kernel builds (a restart mid-transfer)
  still says which build produced each slice. `rdm_history` surfaces these as
  build tags instead of silently mixing series.
* **Rates that start cold after a resume.** `transferredBytes` and every
  speed/peak/ETA calculation use this-run bytes, while `avgBps` is whole-file
  progress over the persisted lifetime; a resumed task no longer reports
  multi-GiB/s rates or peaks inherited from the adopted `.part` bytes.
* **Long-poll, not tight polling.** `rdm_wait` blocks until terminal or timeout
  and returns a typed `timedOut`; status results are flat and bounded.
* **Structured receipts, bounded canonical JSON.** The model reads line-oriented
  `key=value` receipts with stable field order; programmatic callers get the
  canonical JSON. Recoverable failures are values (`error code=…` + `next …`),
  not thrown strings that lose structure.
* **Session attribution.** Every download started by an agent carries its
  session id, so the human can review exactly what *this* agent downloaded.
* **One policy, stated once.** A short system-prompt section tells every agent
  to route downloads through `rdm_*`; the tool definitions stay small (0.2.0 cut
  the first-turn schema cost 7241 → 4966 chars, −31 % vs 0.1.2; the receipt test
  guards it under 6000 even with 0.2.1's extra tool).

## The two review surfaces

The human never composes a download here; there is no URL bar, no connection
slider.

* **Global review** (left sidebar entry → page): a throughput recorder strip for
  the whole kernel, session-grouped ledger of every download, risk markers, and
  a per-record evidence drawer (request chain, server facts, timing, resume
  state, verification, bounded event log). Only live records use saturated
  colour; a record never claims a verification it did not perform.
* **Session review** (right sidebar tab, "Downloads"): the same evidence
  language, filtered to the active session. Empty for a session with no
  downloads; it never steals focus.
* **Evidence language**: a **throughput pulse** (client-sampled, honestly
  labelled) and a **verification seal** (expected vs actual hash, only when a
  hash was compared). Unknowns render `—`.

![Session download review — dark](assets/screenshots/review-session-dark.png)

## Tools

Six tools. All outputs are bounded; the model sees a receipt, the caller sees
canonical JSON.

| tool | what it does | what comes back |
|---|---|---|
| `rdm_probe` | inspect an HTTP(S) source without downloading the file body | `ServerFacts`: ranges, validators, resume safety, signed-URL/TLS expiry, redirects, checksums, rate limit, timing, warnings, recommendation |
| `rdm_download` | start a transfer in the resident kernel; optional `sources[]` mirrors, `sourcePolicy` (`single`/`select`/`failover`/`hedge`/`race`), `sourceRaceBytes`, `discoverSources`, `metalinkFile` | task view (with selected source/alternates) + preflight `ServerFacts` (≤2 s) + next-step hint; `waitSec` optionally blocks |
| `rdm_tasks` | list this session's downloads, or inspect one in depth | flat task views + aggregate; with `taskId`: telemetry, server facts, verification, diagnosis, bounded events |
| `rdm_history` | read the persisted per-task recording (telemetry samples + events + per-run build/plan meta, JSONL under the kernel data dir) | bounded samples/events + `samplesPath`/`eventsPath` + totals; `builds` tags (and one `build=` receipt line) when a recording carries meta; evenly downsampled review series by default, `offset` pages the literal recording; survives kernel restarts |
| `rdm_wait` | long-poll until terminal or timeout | settled task views + `timedOut` |
| `rdm_control` | pause, resume, cancel, retry, remove | updated task view (or removed id) |

A probe receipt:

```text
probe host=cdn.example.com status=200 http=HTTP/2.0
url https://cdn.example.com/app.zip?sig=<redacted>
file name=app.zip source=content-disposition size=48.1MiB type=application/zip encoding=-
range=bytes resume=strong signed=valid(19m40s) tls=valid(40d) checksum=none
plan start=now connections=8 chunk=1.5MiB singleStream=false verify=recommended reason=ranges+strong-etag
headers server=nginx cache=max-age=3600 vary=Accept-Encoding
warnings=- redirects=0
timing probe=84ms ttfb=61ms sample=- origin=known attempts=3 completed=2 median=14MiB/s best=22MiB/s lastError=-
next rdm_download url=https://cdn.example.com/app.zip?sig=<redacted>
```

A task list receipt:

```text
kernel state=running version=0.2.2 pid=4212
scope=session count=1
aggregate total=3 active=1 paused=0 failed=1 completed=1 bytes=2.5GiB now=12.4MiB/s w5=12MiB/s w30=11.5MiB/s w300=- risk=0
t_9f3a1c2d5e6b7a80 running 68% 1.6/2.4GiB 12.4MiB/s w5=12.0MiB/s eta=1m12s(high) workers=8/8 range=bytes resume=strong name=ubuntu-24.04.iso
```

A recorded-history receipt:

```text
history task=t_9f3a1c2d5e6b7a80 samples=1907 peak=70.4MiB/s avg=20.9MiB/s
samples <dataDir>/history/t_9f3a1c2d5e6b7a80.samples.jsonl
events <dataDir>/history/t_9f3a1c2d5e6b7a80.events.jsonl
range 0..300 of 1907
```

## Kernel intelligence

The Rust kernel (`rdm-kernel` 0.3.0-alpha.1, protocol 2) is a resident child process; it
does not listen on a port, starts lazily and stays warm.

* **Server facts** — manual redirect chain (up to 8 hops), proven range support
  (a 206 with a validated `Content-Range`, never just an `Accept-Ranges` header),
  strong/weak validator classification under RFC 9110, signed-URL expiry families
  (AWS SigV4/SigV2, GCS SigV4, Azure SAS, generic `Expires`, ModelScope
  `auth_key`) derived from the final URL, TLS leaf `notAfter`, checksum
  availability (`Content-Digest`/`Content-MD5`/S3 SHA-256/CRC32C),
  `Retry-After`, probe/TTFB timing and bounded warning codes. Credential values
  (including `auth_key` and every redirect hop) are redacted in every projection.
* **Resume that stays honest** — `.part` + resume state, validator compatibility
  checks, and an explicit `resumeSafety` of `strong`/`weak`/`none`. The kernel
  sends `If-Range` only for strong ETags; weak-validator resumes re-probe and
  validate `Content-Range`/length, and fall back to a full body if the origin
  ignores ranges. Compatibility is decided on stable identity (URL path, size,
  validators), so a *new* per-request `auth_key`/`Expires`/`Policy` token on the
  final URL no longer discards a completed chunk table; every attempt reports
  `resumeDecision`/`resumeReason`. A download in flight survives a signed-URL
  expiry; a resume after expiry does not — the diagnosis says "do not pause".
* **Telemetry, measured** — a bounded 3000-sample ring at 100 ms cadence feeds
  the four windows, peak/average, stall and trend without extra timers. After a
  resume every window and cumulative rate starts from the run's own baseline
  (`transferredBytes`); `avgBps` uses whole-file progress over the persisted
  lifetime, so neither inherits the adopted bytes as a rate.
* **Recorded, not just measured** — while a task runs, every reporter sample and
  task event is appended as JSONL under `<data-dir>/history/` (≤100k samples per
  task; redacted; a write error is advisory and never slows the download). Each
  run first appends a meta record (kernel version, pid, run, plan/resume state),
  so a recording that spans a kernel restart or build change keeps its
  attribution; `rdm_history` reads it back and shows the build tags.
* **Origin ledger** — a bounded 256-host memory of attempts/completed/median/best
  throughput/last error, reported by `rdm_probe` (`origin=…`) and `stats`.
* **Segmented transfer** — 1–128 connections plus an adaptive ceiling
  (`maxConnections`, default 128): the controller grows on aggregate throughput,
  reverts when aggregate drops, freezes at saturation, holds the target during
  tail drain, backs off on server pushback and rebuilds the connection pool on
  throughput collapse, with a dynamic chunk queue and tail stealing, retries with
  backoff, per-task bandwidth cap and optional SHA-256 verification before the
  atomic rename.
* **Tail-aware finish** — once the remaining chunk count is at most the worker
  target, claims use a 3 s stall deadline and fast retries (250 ms × attempt,
  capped at 1 s) instead of waiting 10 s on a dead long-tail connection.
* **Bounded** — ≤200 events/task in the view ring, ≤3000 in-memory telemetry
  samples, ≤100k recorded samples per task, ≤20 build/plan meta records per
  response, ≤256 origins, no full-body buffering, stdout reserved for protocol.

Performance work and measurements live in
[docs/OPTIMIZATION.md](docs/OPTIMIZATION.md); the architecture and protocol are
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [PROTOCOL.md](PROTOCOL.md). The
0.2.0 design reasoning is
[docs/design/0.2.0-agent-native.md](docs/design/0.2.0-agent-native.md); the 0.2.1
real-data evidence and fixes are
[docs/design/0.2.1-real-data-fixes.md](docs/design/0.2.1-real-data-fixes.md); the
0.2.2 live-ModelScope pass and its controller/tail/accounting changes are
[docs/design/0.2.2-live-modelscope-pass.md](docs/design/0.2.2-live-modelscope-pass.md),
with a research note at
[docs/research/agent-native-downloader.md](docs/research/agent-native-downloader.md).
The 0.3.0 multi-source decision and design options are in
[docs/research/multi-source-scheduling.md](docs/research/multi-source-scheduling.md)
and [docs/research/protocol-extension-priorities.md](docs/research/protocol-extension-priorities.md);
the stage/version record is
[docs/design/0.3.0-multi-source-stages.md](docs/design/0.3.0-multi-source-stages.md).

Release notes live in [CHANGELOG.md](CHANGELOG.md) with one section per tag;
the same change must update both the version and this changelog. From 0.2.2 the
kernel and plugin package share one version number (currently
`0.3.0-alpha.1`, protocol 2); historical recordings keep the strings their
binaries actually wrote (0.2.1 kernel = `1.1.0`, pre-unification 0.2.2 builds =
`1.2.0`).

## Install

The package ships prebuilt kernels for Windows x64, Linux x64/arm64 and macOS
x64/arm64; installing never compiles Rust.

From GitHub into a DSH profile:

```bash
dsh plugin --profile web add github:NIRVANA-APOC/dsh-rdm
```

From a release tarball:

```bash
dsh plugin --profile web add https://github.com/NIRVANA-APOC/dsh-rdm/releases/download/<tag>/dsh-rdm-<version>.tgz
```

Local checkout as a directory bundle (DSH UI → Plugins → Install from folder, or
the `plugin_manager` tool):

```text
plugin_manager install_bundle target=<absolute path to dsh-rdm>
```

After installing, agents see `rdm_*`; the left sidebar gains the downloads entry
and the right sidebar guide gains a "Downloads" tab. No restart is normally
required, though a page refresh is safe.

### Configuration

| key | default | meaning |
|---|---|---|
| `defaultDir` | `<data-dir>/downloads` when `defaultDir` is unset | directory for downloads started without `dir` |
| `connections` | `8` | default parallel connections per task (1–128) — the initial worker population |
| `maxConnections` | `128` | authoritative adaptive ceiling per task, clamped to `connections..128`; the controller may grow beyond `connections` up to this while throughput is healthy |
| `chunkSizeMiB` | `0` (auto) | fixed chunk size; 0 = four chunks per connection, 256 KiB–8 MiB |
| `speedLimitBps` | `0` | profile-wide default bandwidth cap; 0 = unlimited |
| `maxAttempts` | `6` | per-chunk retry budget |
| `autoResume` | `true` | resume interrupted tasks when the kernel starts |
| `dataDir` | `$DSH_HOME/dsh-rdm` | kernel data (task records, origin ledger, `history/` recordings) |
| `kernelPath` | bundled `bin/<platform>-<arch>/rdm-kernel` | override the kernel binary |
| `startOnDemand` | `true` | spawn the kernel on first use instead of at plugin load |
| `fsyncOnComplete` | `false` | flush each completed file to stable storage before the atomic rename |
| `logLevel` | `warn` | kernel stderr log level |

## Verification

* `node scripts/verify-kernel.mjs` — kernel e2e against a local fixture (this is
  the canonical suite; it spawns the kernel, so it requires a host where child
  processes are permitted).
* `python tests/verify_e2e.py` — out-of-process protocol-2 driver used on hosts
  where Node cannot spawn children (see below): probe facts, signed URLs,
  redirects, session scoping, telemetry, pause/resume (including resume across a
  volatile tokenized final URL), `maxConnections` clamping, recorded history with
  per-run build meta, `transferredBytes`/`requestedConnections`, plan/receipt
  message shapes, `unsupported_method`, `auth_key` redaction, stats, aggregate.
* `node tests/tools-receipts.test.mjs` — receipt contract, policy-once,
  schema-cost guard, recoverable-error receipts.
* `node scripts/verify-fixture.mjs` — fixture self-test.
* `node scripts/verify-kernels.mjs --host --run` — the bundled kernel for this
  host exists, has the right format, and starts.

The measured QA report for the release lives in
[docs/verification.md](docs/verification.md).

## Security and privacy

* Credential-bearing query values are **redacted canonically**, not just in the
  UI: `ServerFacts`/task views replace `X-Amz-Signature`, `Signature`, `sig`,
  `token`, `auth_key`, access keys and similar values with `<redacted>` — in the
  final URL and in every redirect hop. Request headers and cookies never appear
  in any protocol view, receipt, or UI.
* Task records on disk may retain request credentials so a resume after a kernel
  restart can authenticate. They live only under the kernel data directory; treat
  that directory as owner-sensitive.
* The browser route is authenticated by the Harness connection service; the
  kernel opens no network listener and speaks NDJSON over stdio only.
* `insecure: true` disables TLS verification for one task (debug only); the probe
  still reports the certificate facts it can read.

## Limits (honest)

* **Mirrors/multi-source:** implemented as **HTTP(S) candidates for one
  object** (`sources[]`, up to 8). Cross-protocol sources (FTP/S3/torrent),
  automatic public-mirror scraping, and multi-file/prefix results remain out of
  scope. `race`/`failover` only mix bytes when every source has the same strong
  content identity; `select`/`hedge` commit to one source.
* Download approval gates, per-origin enforced concurrency budgets and MCP
  exposure remain deliberate non-goals.
* `maxConnections: 128` is a safety ceiling, not a promise of 128 parallel
  connections: actual concurrency is controller-driven and starts at
  `connections`.
* Resume across a remote change is detected through validators; a weak-validator
  origin can still serve bytes that changed within the same second — the
  `weak` safety label is the honest signal there. A rejected resume says why
  (`resumeDecision`/`resumeReason`) instead of silently restarting.
* The JSONL recording is diagnostics, not a durability contract: it is bounded,
  best-effort, and a recording failure never affects the download. A recording
  that started before 0.2.1 has no samples, and a 0.2.1-era file has no build
  meta — the tool reports what exists instead of inventing a series.
* Post-transfer SHA-256 verification still runs serially after the download
  (out-of-order chunks cannot be streamed into one hash; a chunk-hash tree would
  change the verification contract). On multi-GiB files it costs a few percent
  of wall time.
* Controller growth/saturation decisions are heuristics over measured windows;
  they only move the worker target and never change task state or correctness.
* ETA confidence is a heuristic over measured windows; it is `unknown` rather
  than guessed when data is insufficient.
* The five-platform prebuilt kernels are built by the release workflow on native
  runners; a local checkout only contains the current host's freshly built
  kernel until the workflow refreshes `bin/`.
* A sandboxed agent host may deny Node child-process creation; in that
  environment use `bash scripts/dev-build.sh` for builds and
  `python tests/verify_e2e.py` for the kernel suite (both are documented in
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

## Development

```bash
npm install
bash scripts/dev-build.sh all      # host + client, sandbox-safe
bash scripts/dev-build.sh kernel   # cargo release build + install to bin/
node scripts/build.mjs             # canonical build outside a sandbox
node scripts/build-kernel.mjs      # canonical kernel build outside a sandbox
python tests/verify_e2e.py         # protocol-2 kernel suite (sandbox-safe)
node tests/tools-receipts.test.mjs # host receipts contract
```

Releasing — the five-platform kernel matrix, GitHub release, npm trusted
publishing and retry semantics — is documented in
[docs/release.md](docs/release.md).

The host half imports only Node built-ins (the schema library is vendored); the
client half registers into `sidebar.panellist`, the keyed `main` slot and the
native right-sidebar tab seat, with host theme tokens only.

## License

MIT OR Apache-2.0.
