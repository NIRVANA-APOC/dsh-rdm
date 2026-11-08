# dsh-rdm

[English](README.md) | [简体中文](README.zh-CN.md)

**An agent-native downloader for DeepSeek Harness.** One resident Rust kernel,
five model-facing tools that return decision-grade facts, and two review surfaces
for the human: a global download ledger in the left sidebar, and a
session-scoped review tab in the right sidebar.

The agent operates. The human reviews.

![Global download review — light](assets/screenshots/review-light.png)

## What "agent-native" means here

A downloader used by a model is not a GUI that happens to have an API. The agent
has to answer, in as few model steps as possible: *is this URL usable, how should
I fetch it, what is happening now, should I intervene, and can I trust the
result?* `dsh-rdm` 0.2.0 is built around those questions.

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
* **Long-poll, not tight polling.** `rdm_wait` blocks until terminal or timeout
  and returns a typed `timedOut`; status results are flat and bounded.
* **Structured receipts, bounded canonical JSON.** The model reads line-oriented
  `key=value` receipts with stable field order; programmatic callers get the
  canonical JSON. Recoverable failures are values (`error code=…` + `next …`),
  not thrown strings that lose structure.
* **Session attribution.** Every download started by an agent carries its
  session id, so the human can review exactly what *this* agent downloaded.
* **One policy, stated once.** A short system-prompt section tells every agent
  to route downloads through `rdm_*`; the tool definitions stay small
  (first-turn schema cost 7241 → 4966 chars, −31 % vs 0.1.2).

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

Five tools. All outputs are bounded; the model sees a receipt, the caller sees
canonical JSON.

| tool | what it does | what comes back |
|---|---|---|
| `rdm_probe` | inspect an HTTP(S) source without downloading the file body | `ServerFacts`: ranges, validators, resume safety, signed-URL/TLS expiry, redirects, checksums, rate limit, timing, warnings, recommendation |
| `rdm_download` | start a transfer in the resident kernel | task view + preflight `ServerFacts` (≤2 s) + next-step hint; `waitSec` optionally blocks |
| `rdm_tasks` | list this session's downloads, or inspect one in depth | flat task views + aggregate; with `taskId`: telemetry, server facts, verification, diagnosis, bounded events |
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
kernel state=running version=1.1.0 pid=4212
scope=session count=1
aggregate total=3 active=1 paused=0 failed=1 completed=1 bytes=2.5GiB now=12.4MiB/s w5=12MiB/s w30=11.5MiB/s w300=- risk=0
t_9f3a1c2d5e6b7a80 running 68% 1.6/2.4GiB 12.4MiB/s w5=12.0MiB/s eta=1m12s(high) workers=8/8 range=bytes resume=strong name=ubuntu-24.04.iso
```

## Kernel intelligence

The Rust kernel (`rdm-kernel` 1.1.0, protocol 2) is a resident child process; it
does not listen on a port, starts lazily and stays warm.

* **Server facts** — manual redirect chain (up to 8 hops), proven range support
  (a 206 with a validated `Content-Range`, never just an `Accept-Ranges` header),
  strong/weak validator classification under RFC 9110, signed-URL expiry families
  (AWS SigV4/SigV2, GCS SigV4, Azure SAS, generic `Expires`) derived from the
  final URL, TLS leaf `notAfter`, checksum availability
  (`Content-Digest`/`Content-MD5`/S3 SHA-256/CRC32C), `Retry-After`, probe/TTFB
  timing and bounded warning codes.
* **Resume that stays honest** — `.part` + resume state, validator compatibility
  checks, and an explicit `resumeSafety` of `strong`/`weak`/`none`. The kernel
  sends `If-Range` only for strong ETags; weak-validator resumes re-probe and
  validate `Content-Range`/length, and fall back to a full body if the origin
  ignores ranges. A download in flight survives a signed-URL expiry; a resume
  after expiry does not — the diagnosis says "do not pause".
* **Telemetry, measured** — a bounded 3000-sample ring at 100 ms cadence feeds
  the four windows, peak/average, stall and trend without extra timers.
* **Origin ledger** — a bounded 256-host memory of attempts/completed/median/best
  throughput/last error, reported by `rdm_probe` (`origin=…`) and `stats`.
* **Segmented transfer** — 1–32 connections, dynamic chunk queue with tail
  stealing, AIMD concurrency with 429/503 pushback, retries with backoff,
  per-task bandwidth cap and optional SHA-256 verification before the atomic
  rename.
* **Bounded** — ≤200 events/task, ≤3000 telemetry samples, ≤256 origins, no
  full-body buffering, stdout reserved for protocol.

Performance work and measurements live in
[docs/OPTIMIZATION.md](docs/OPTIMIZATION.md); the architecture and protocol are
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [PROTOCOL.md](PROTOCOL.md). The
design reasoning for 0.2.0 is
[docs/design/0.2.0-agent-native.md](docs/design/0.2.0-agent-native.md), with an
evidence note at
[docs/research/agent-native-downloader.md](docs/research/agent-native-downloader.md).

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
| `connections` | `8` | default parallel connections per task (1–32) |
| `chunkSizeMiB` | `0` (auto) | fixed chunk size; 0 = four chunks per connection, 256 KiB–8 MiB |
| `speedLimitBps` | `0` | profile-wide default bandwidth cap; 0 = unlimited |
| `maxAttempts` | `6` | per-chunk retry budget |
| `autoResume` | `true` | resume interrupted tasks when the kernel starts |
| `dataDir` | `$DSH_HOME/dsh-rdm` | kernel data (task records, origin ledger) |
| `kernelPath` | bundled `bin/<platform>-<arch>/rdm-kernel` | override the kernel binary |
| `startOnDemand` | `true` | spawn the kernel on first use instead of at plugin load |
| `logLevel` | `warn` | kernel stderr log level |

## Verification

* `node scripts/verify-kernel.mjs` — kernel e2e against a local fixture (this is
  the canonical suite; it spawns the kernel, so it requires a host where child
  processes are permitted).
* `python tests/verify_e2e.py` — out-of-process protocol-2 driver used on hosts
  where Node cannot spawn children (see below): probe facts, signed URLs,
  redirects, session scoping, telemetry, pause/resume, stats, aggregate.
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
  `token`, access keys and similar values with `<redacted>`. Request headers and
  cookies never appear in any protocol view, receipt, or UI.
* Task records on disk may retain request credentials so a resume after a kernel
  restart can authenticate. They live only under the kernel data directory; treat
  that directory as owner-sensitive.
* The browser route is authenticated by the Harness connection service; the
  kernel opens no network listener and speaks NDJSON over stdio only.
* `insecure: true` disables TLS verification for one task (debug only); the probe
  still reports the certificate facts it can read.

## Limits (honest)

* Mirrors, multi-source scheduling, download approval gates, per-origin enforced
  concurrency budgets and MCP exposure are deliberate non-goals for 0.2.0.
* Resume across a remote change is detected through validators; a weak-validator
  origin can still serve bytes that changed within the same second — the
  `weak` safety label is the honest signal there.
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

The host half imports only Node built-ins (the schema library is vendored); the
client half registers into `sidebar.panellist`, the keyed `main` slot and the
native right-sidebar tab seat, with host theme tokens only.

## License

MIT OR Apache-2.0.
