# dsh-rdm — architecture (0.3.0)

`dsh-rdm` embeds a **resident downloader kernel** into DeepSeek Harness: one
long-lived Rust process that stays warm and is driven by model-facing tools and
three human surfaces. Transfers are segmented, resumable, verifiable and
bandwidth-limited without starting a process per download.

0.2.0 reframed the product: the **agent operates** the downloader through
`rdm_*` tools that return bounded, structured facts; the **human reviews** what
happened in a global sidebar page and in a session-scoped right sidebar tab.
0.2.1 is an additive **real-data pass** on top of that: resume survives volatile
signed final URLs, the adaptive controller may grow past the requested connection
count (up to `maxConnections`, default 128), and per-task telemetry/events are
persisted as JSONL and exposed through `rdm_history`. 0.2.2 is the **live
ModelScope pass** (kernel identity 0.2.2 at the time): recordings gain a per-run
meta record for build attribution, rate accounting moves to this-run bytes
(`transferredBytes`), the controller judges growth on aggregate throughput with
saturation and tail-freeze policies, tail chunks retry fast, and an unknown RPC
method returns `unsupported_method`. 0.3.0 combines the **download workbench**
(the human can compose a download, filter/batch-manage records grouped by workspace
and real session title, open results on the desktop, and follow live progress in
a frame-wide top-right popup; the agent gains `rdm_search`) with **multi-source
scheduling**: a task may carry up to eight HTTP(S) candidates for one object; the
engine probes them, selects by measured throughput/health, and applies `select`,
`failover`, `hedge` or `race` per the task policy. A source pool
(`kernel/src/source.rs`) owns one client per source, content identity and
per-source health; the chunk engine asks the pool for a source per claim. Mixing
bytes is gated on a strong shared content identity. Metalink/HTTP
`Link: rel=duplicate` mirrors and `.meta4` documents are resolved before the
transfer.

The binding contract for the 0.2.0 framing is
[design/0.2.0-agent-native.md](design/0.2.0-agent-native.md); the 0.2.1 changes
are explained in [design/0.2.1-real-data-fixes.md](design/0.2.1-real-data-fixes.md);
the 0.2.2 changes are specified in [`.design/0.2.2-spec.md`](../.design/0.2.2-spec.md)
and explained in [design/0.2.2-live-modelscope-pass.md](design/0.2.2-live-modelscope-pass.md).
The 0.3.0 UI/API contract is [`.design/0.3.0-ui-spec.md`](../.design/0.3.0-ui-spec.md);
the multi-source design note is
[research/multi-source-scheduling.md](research/multi-source-scheduling.md).
The kernel wire contract is [PROTOCOL.md](../PROTOCOL.md) v2.

## Goals

1. A compact resident kernel with one job — serve the plugin's protocol — while
   covering probe (with server intelligence), segmented multi-connection
   transfer, dynamic work distribution, adaptive concurrency, retry/backoff,
   resume with validator safety, bandwidth limit, checksum verification,
   windowed telemetry and origin memory.
2. `dsh` always downloads through RDM: the plugin registers `rdm_*` tools, adds
   one short system-prompt section that prefers them over shell downloads, and
   exposes human surfaces: a workspace/session workbench (left global page), a
   session tab (right sidebar) and a frame-wide active-download popup. The
   workbench can also start a download from a pasted link.
3. Information over control: the tools answer "what does the server do?", "how
   is the transfer doing over several time windows?", "can I resume safely?",
   "does the result verify?" without follow-up calls. Human controls stay
   deliberately small: pause, resume, delete, open, filter, select.
4. Resident cost stays small and lazy: the kernel starts on the first tool /
   review use, then stays warm; it exits when the plugin unloads or stdin closes.

## Package layout

```
dsh-rdm/
├── package.json              # bundle patch + client manifest (injects sidebar-right) + exports
├── cordis.patch.yml          # inserts the dsh-rdm plugin row
├── icon.svg                  # display icon (original artwork)
├── locale/{en,zh}.json       # plugin metadata + UI strings
├── PROTOCOL.md               # kernel <-> plugin NDJSON contract (v2)
├── docs/
│   ├── ARCHITECTURE.md       # this file
│   ├── OPTIMIZATION.md       # measured kernel work
│   ├── verification.md       # QA report (verifier-owned; Lead publishes)
│   ├── design/0.2.0-agent-native.md  # 0.2.0 product/UX/agent contract
│   ├── design/0.2.1-real-data-fixes.md  # 0.2.1 evidence → fix note
│   ├── design/0.2.2-live-modelscope-pass.md  # 0.2.2 evidence → fix note
│   └── research/             # external evidence and reasoning notes
├── src/                      # TypeScript host + client sources
│   ├── index.ts              # host plugin: apply(ctx, config)
│   ├── config.ts             # schemastery Config (vendored schema lib)
│   ├── protocol.ts           # TS mirrors of PROTOCOL.md v2 types
│   ├── kernel-client.ts      # spawn + NDJSON RPC + task mirror + restart + session tagging
│   ├── session-catalog.ts    # session titles/workspaces + agent notices + desktop opener
│   ├── tools.ts              # seven model-facing tool registrations + line receipts
│   ├── tool-def.ts           # local defineTool: DSL→JSON Schema + arg validation
│   ├── host-api.ts           # POST /api/dsh-rdm/api browser route (list/get/stats/control/open/start)
│   ├── types.d.ts            # ambient declarations (local typecheck only)
│   └── client/
│       ├── index.tsx         # client plugin {inject, apply}: left entry, main page, overlay, native tab
│       ├── ledger.tsx        # global workbench (composer, cards, filters, workspace/session ledger)
│       ├── overlay.tsx       # frame-wide active-download popup (`shell.overlay`)
│       ├── session-tab.tsx   # session-scoped review tab body/title
│       ├── drawer.tsx        # evidence drawer
│       ├── icons.tsx         # 16 px stroke icon set
│       ├── primitives.tsx    # status glyph, seal, chips, meter, checkbox, buttons
│       ├── model.ts          # pure grouping/filter/connection/risk model
│       ├── data.ts           # shared global feed + scoped session feed
│       ├── api.ts            # fetch wrapper + v3 normalizers
│       └── review-css.ts     # theme-token CSS for the three surfaces
├── vendor/                   # schemastery + cosmokit (MIT), bundled into lib/
├── lib/                      # generated: index.js (host), client.js (browser)
├── kernel/                   # standalone Rust crate (own workspace)
│   ├── Cargo.toml            # rdm-kernel 0.3.0, protocol 2 (version unified with package.json)
│   ├── src/…                 # protocol, task, kernel, probe, telemetry, origins, engine,
│   │                         #   controller (adaptive growth/collapse/rebuild), history (JSONL recording)
│   └── tests/…               # unit + protocol smoke + in-process fixture e2e
├── bin/<platform>-<arch>/rdm-kernel[.exe]  # generated kernel binary per platform
└── scripts/
    ├── build.mjs             # canonical esbuild build (host + client)
    ├── dev-build.sh          # sandbox-safe shell build (Node cannot spawn in DSH sandbox)
    ├── build-kernel.mjs      # cargo build --release + install to bin/
    └── verify-*.mjs          # kernel/prebuilt verification harness
```

## Kernel (`kernel/`, Rust)

A standalone Cargo workspace (own `[workspace]`) built for one purpose: serve the
plugin's protocol.

| Concern | 0.3.0 kernel |
|---|---|
| Public API | NDJSON server + task manager (protocol 2; 0.2.1 additive fields + `history`, 0.2.2 `transferredBytes`/`requestedConnections`/history meta, `unsupported_method`) |
| GUI/CLI/IPC/MCP/resolver | not present |
| Probe | manual redirect chain + HEAD/ranged-GET, full `ServerFacts` |
| Multi-source | up to 8 HTTP(S) candidates, measured selection, `select`/`failover`/`hedge`/`race`, content-key resume, Metalink/HTTP `Link` + `.meta4` resolution (`source.rs`, `metalink.rs`) |
| Server intelligence | ranges/validators/resume safety, signed-URL expiry (AWS/GCS/Azure/generic) plus `auth_key` signed material, TLS leaf validity, checksum headers, Retry-After, timing |
| Telemetry | 1s/5s/30s/300s windows, peak/avg, stall, trend, ETA confidence; after a resume all rates start from this-run `transferredBytes` |
| Memory | bounded per-host origin ledger (`origins.json`, ≤256 hosts) |
| Adaptive controller | initial population `connections` (requested count reported separately); grows `targetWorkers` up to `maxConnections` (≤128) on **aggregate** throughput, reverts aggregate drops with a 30-tick cooldown, freezes growth at **saturation** (2 kept growths <2 % gain), freezes the target during **tail** drain, rebuilds the HTTP pool on throughput collapse, AIMD/429-503 backoff (`controller.rs`) |
| Resume state | `.part` + `.part.json`, stable-identity compatibility, `resumeSafety` + `resumeDecision`/`resumeReason`; events report ranges/chunks/bytes separately (chunks from the chunk plan) |
| Tail finish | stall budget tightens near completion (30 s → 10 s at ≥90 % → 5 s at ≥97 %); tail claims (remaining ≤ target) use a 3 s deadline and `min(250 ms × attempt, 1 s)` retry delay |
| Recording | append-only `<data-dir>/history/<id>.{samples,events}.jsonl`, with one per-run `kind:"meta"` build/plan record at the head of each run; bounded (≤100k samples, ≤20 meta records read back), redacted, advisory (`history.rs`) |
| Task store | kernel-owned `tasks/<id>.json` (v2 fields, v1 records load) |
| Logging | stderr `log` lines |
| Runtime | tokio, `min(4, cores)` worker threads (≥2) |

Engine flow: `probe (redirects → HEAD → ranged GET fallback, capture server
facts) → plan (recommendation-aware chunk size/connections, target name, resume
scan on stable identity, per-run history meta record, reporter baseline from
resumed bytes) → chunked worker pool with dynamic chunk queue driven by the
adaptive controller target → retries/backoff/Retry-After → SHA-256 verify →
atomic rename`. Servers without range support transparently fall back to one
stream. Pause/cancel are cooperative and event-driven; resume state persists every
~500 ms and fsyncs on pause/stop. Chunk sizing is automatic by default (4 chunks
per connection, 256 KiB..8 MiB). Completed files are renamed without fsync by
default (`fsyncOnComplete` opts back in). While a transfer runs, each reporter
sample and each task event is appended to the per-task JSONL recording; once the
remaining chunk count reaches the worker target the tail is drained with a frozen
target and fast per-claim retries.

### Controller loop

The requested `connections` is the task's initial worker population (the caller's
original count is reported as `requestedConnections`). A pure state machine
(`kernel/src/controller.rs`) owns the live `targetWorkers` and decides once per
sampling window:

* **grow** — when **aggregate** throughput shows headroom and the transfer is not
  stalled, raise the target by a small step, never past `maxConnections`. The
  verdict is aggregate-based: a probe is kept unless aggregate throughput drops
  below 95 % of its pre-probe value (per-connection dilution alone does not
  revert — that was the 0.2.1 jitter that produced 64→72→64 five times on a flat
  106 MiB/s plateau);
* **revert** — when a growth step lowers aggregate throughput, restore the
  previous target and wait out a **30-tick revert cooldown**;
* **saturation freeze** — two consecutive kept growths that raise aggregate by
  less than 2 % freeze growth until throughput falls below 90 % of the frozen
  peak (or 120 ticks pass), so the controller stops probing at a line ceiling;
* **collapse rebuild** — when instantaneous throughput falls below 50 % of peak
  while workers stay pinned (no meaningful stall), rebuild the HTTP connection
  pool with fresh TCP/TLS and then probe growth; the observed failure mode was
  32/32 workers with `w5` falling 56.4 → 9.4 MiB/s, which more workers on the same
  degraded connections cannot fix;
* **tail freeze** — when remaining claim units are at most the target, hold the
  target (no grow, shrink or collapse); draining tail chunks is not evidence
  that the average rate is falling;
* **backoff** — on 429/503 or `Retry-After` pushback, halve the target.

It also shrinks gently when the average rate falls and the pool is not pinned
(the collapse case is handled by the rebuild path, not by shrinking).

Every decision is emitted as a `controller` task event (free-form message
carrying the numbers) and recorded; `TaskView.connections` remains the initial
population while `TaskView.targetWorkers` reports the live target (0 before the
plan). A decision cooldown and a rebuild counter prevent oscillation; a rebuild
probe that does not recover throughput reverts to the pre-collapse target.

### Data dir and recorded history

The kernel's `--data-dir` (plugin config `dataDir`) holds:

```
<data-dir>/
  tasks/<task-id>.json              # task record (spec, status, result, server facts)
  origins.json                      # bounded per-host ledger (≤256 hosts)
  history/<task-id>.samples.jsonl   # per-run meta record + per-sample telemetry (append-only,
                                    #   ≤100k samples/task; meta records don't count)
  history/<task-id>.events.jsonl    # retained task events incl. controller decisions
```

Recording is owned by `kernel/src/history.rs`: append at the reporter cadence
(≤10/s), flush ≥1/s and at terminal transitions, redact event messages and the
meta URL, and treat write errors as advisory (a recording failure never fails or
slows a download). Each run first appends a `kind:"meta"` record — kernel
version, pid, run, phase, file/total/chunk, requested/initial/ceiling workers,
resumed bytes and resume decision — so a timeline that spans kernel builds keeps
its attribution (the 20261109 session spanned two builds that both reported
1.1.0 and could not otherwise be aligned). The `history` RPC pages samples and
events and returns the retained meta records (≤20); the host exposes the same
data through `rdm_history`, including derived `builds` tags. Files append across
pause/resume/retry/auto-resume and survive kernel restarts, so a transfer can be
replayed after the fact; recordings written by 0.2.1 (no meta) remain readable.

Design constraints: correctness over cleverness; no task panics (task errors
become `failed` states); stdout reserved for protocol; bounded memory (≤200
events/task, ≤3000 telemetry samples, ≤256 origins, no full-body buffering,
≤1 MiB write buffer per worker) and bounded recording (≤100k samples per task on
disk, ≤20 meta records per history response). Performance work and measurements
live in [OPTIMIZATION.md](OPTIMIZATION.md).

Kernel CLI: `rdm-kernel --data-dir <dir> [--log-level warn]`. Exit on stdin EOF.

## Host plugin (`src/index.ts`)

The host half is **self-contained**: it imports only Node built-ins at runtime.
The Harness packages a normal plugin would import (`@deepseek-ai/dsh-tools`,
`@deepseek-ai/schemastery`) are not resolvable from a *linked local* plugin
directory, so `src/tool-def.ts` reproduces the `defineTool` contract and
schemastery/cosmokit are vendored under `vendor/`.

* `inject: ['tools', 'connection', 'systemPrompt']`; `apply(ctx, config)` owns a
  `KernelService`:
  * lazy spawn of `bin/<platform>-<arch>/rdm-kernel[.exe]`, `--data-dir`
    (`config.dataDir` or `$DSH_HOME/dsh-rdm`), `--log-level`;
  * NDJSON RPC (ids, pending map, per-request timeout), task mirror updated by
    `task` notifications, spawn serialization, crash restart with backoff;
  * protocol handshake: a kernel whose ready frame reports protocol ≠ 2 fails
    with `protocol_mismatch` and an actionable message;
  * teardown: kill child on plugin dispose (`ctx.effect`).
* Owns one shared `SessionCatalog` (`src/session-catalog.ts`): resolves session
  titles from `sessionQuery.readTitleSnapshots`, live flags from `sessions.get`,
  workspace grouping from `workspaceRegistry.list()` (15 s title cache / 30 s
  workspace cache, single-flight batch, never throws), delivers user-action
  notices to a live agent through `sessionController.prompt`, and launches the
  host desktop opener detached. Every service is optional.
* Registers the seven tools below plus one system-prompt section
  (`dsh-rdm:downloads`) that states the "use rdm_* for downloads" policy exactly
  once (tool descriptions carry behavior only).
* Session attribution: `rdm_download` reads the calling agent's session id from
  the tool execution context and sends it with the request, so the kernel and
  review UI can scope by session. There is no model-supplied session parameter.
* Config (`schemastery`): `defaultDir`, `connections`, `maxConnections`,
  `chunkSizeMiB`, `speedLimitBps`, `maxAttempts`, `autoResume`, `dataDir`,
  `kernelPath`, `logLevel`, `startOnDemand`, `fsyncOnComplete`.

### Sandboxed hosts and the data dir

Some DSH deployments confine child-process filesystem writes to the session
workspace (observed on this Windows host: a kernel spawned by the Host process
gets `ACCESS_DENIED (os error 5)` creating `<data-dir>/tasks` outside the
workspace, while `~/AppData/Local/Temp` and `~/.dsh` are both denied; the same
binary succeeds with a workspace path). KernelService therefore retries once
when an **unconfigured** default data dir is denied:

1. `config.dataDir` (if set) → `$DSH_HOME/dsh-rdm` → `<plugin packageRoot>/.rdm-data`
2. Downloads default to `<active dataDir>/downloads` when `config.defaultDir` is
   empty, so a UI- or tool-started download never depends on the Host process
   cwd being writable. Task recording lands in `<active dataDir>/history/`.

The fallback is transparent to the caller (the first request succeeds), logged
at warn level, and visible as `dataDir` in kernel status/stats.

### Tool surface (model-facing)

Seven tools, bounded canonical outputs, line-oriented receipts. The **model reads
the render**, not the canonical JSON; receipts use stable `key=value` fields in a
fixed order (see `design/0.2.0-agent-native.md` §3.4).

| tool | params | returns |
|---|---|---|
| `rdm_download` | `url*`, `dir?`, `fileName?`, `connections?` (1..128), `maxConnections?`, `headers?` (json), `cookie?`, `referer?`, `userAgent?`, `expectedSha256?`, `speedLimitBps?`, `resume?`, `singleStream?`, `proxy?`, `insecure?`, `waitSec?` | task view + preflight `ServerFacts` (waits ≤2 s) + next-step hint; `waitSec` waits for completion (≤300 s) |
| `rdm_probe` | `url*`, `headers?`, `cookie?`, `referer?`, `userAgent?`, `proxy?`, `insecure?`, `timeoutMs?` | full `ServerFacts` receipt: ranges, resume safety, signed-URL expiry, TLS validity, redirects, timing, checksums, recommendation |
| `rdm_tasks` | `taskId?`, `status?`, `limit?`, `events?`, `scope?` (`session` default, `all`) | list: kernel + tasks + aggregate + counts; detail: task + telemetry + server + verification + diagnosis + events |
| `rdm_search` | `query?`, `taskId?`, `status?`, `limit?` (1..50, default 10), `scope?` (`all` default, `session`) | bounded records across sessions with id/state/progress/session title/workspace/connections + `total`; exact id shortcuts to one match; unknown id is a recoverable `not_found` envelope |
| `rdm_history` | `taskId*`, `limit?` (1..2000, default 300), `offset?`, `includeEvents?` (default true) | recorded per-sample telemetry + events + per-run build/plan meta for one task, with JSONL paths, totals, `truncated` and derived `builds` tags; survives kernel restarts |
| `rdm_wait` | `taskIds*` (1..20), `timeoutSec?` | tasks + timedOut + hint; wakes on status transitions, not polling |
| `rdm_control` | `taskId*`, `action` (`pause\|resume\|cancel\|retry\|remove`), `deletePart?` | task (or removed id) |

Tool descriptions are deliberately short; parameter rules live on parameters;
the policy sentence appears only in the system-prompt section (harness
`agent-experience` guidance).

`rdm_search` matches case-insensitive whitespace-separated terms against the
record's id, file name, URL, host, path, owning session title and workspace
title. It reads at most the newest 100 kernel records, filters locally, and
never dumps full URLs into the receipt.

## Client UI (`src/client/`)

Three surfaces, one visual language. The human reviews what agents did, and can
also intervene directly (start, pause, delete, open, filter, select).

* `sidebar.panellist` registers the global entry (`id:'rdm'`, `order:30`) whose
  icon opens the **download workbench** in the keyed `main` slot (`key:'rdm'`):
  a paste-a-link composer, three state cards that double as status filters, a
  text filter plus suffix multi-select dropdown, select-all/batch pause/delete,
  and a ledger grouped by workspace → real session title. Rows carry
  pause/resume, open-file, open-folder, delete, copy-id, the live adaptive
  connection count and the evidence drawer.
* `dsh.client.inject` additionally includes
  `@deepseek-ai/dsh-client-ui-sidebar-right`; the client registers a native
  right-sidebar tab type `dsh-rdm/downloads` (kind `rdm`) with a guide entry, a
  body slot and a title slot. The tab filters tasks by the session id the slot
  framework injects and reuses the same row/drawer with a micro pulse instead of
  the page meter.
* The client registers a frame-wide entry on `shell.overlay`
  (`id:'dsh-rdm-progress'`): the **active-download popup**, one row per session
  with running work (progress, speed, connections), collapsible to a pill and
  absent when nothing is active. Clicking a row opens the workbench through
  `ctx.layout.selectPanel('rdm')`.
* The workbench and popup share one module-level poll in `data.ts`; the session
  tab polls its own scope. A mutation (pause/delete/start) refreshes the shared
  feed immediately.
* All colors/spacings use `--dsw-alias-*`/`--dsw-specific-*` theme tokens; no
  Harness client package is imported beyond the injected client modules. Locale
  strings live in `locale/{en,zh}.json` and are bound through `ctx.locale`.
* The client tolerates an older host API (missing fields render as unknown,
  missing session catalog falls back to short ids) and missing right-sidebar
  services (the workbench and popup still work), so a partial deploy never
  crashes the page.

### Session / workspace catalog

`list` enriches the task rows with a host-resolved catalog so the ledger can
group by something a human recognizes:

- **title** — `sessionQuery.readTitleSnapshots(ids)`, which works for live and
  persisted sessions; null when the session log has no title event.
- **live** — `sessions.get(id) !== undefined` at poll time.
- **workspace** — `workspaceRegistry.list()` maps `sessionIds` first, then the
  session header `cwd` against the canonical workspace path; `workspaceId`,
  `workspaceTitle` and `workspacePath` are returned per session, plus the flat
  `workspaces` list.
- Caches: 15 s for title/header (negative entries included), 30 s for the
  workspace list, one single-flight title batch. A missing or throwing service
  contributes empty labels; the route never fails on catalog errors.

### Control notices and desktop open

- `control` on `pause`/`cancel`/`remove` (notify defaults true, `notify:false`
  opts out) reads the pre-action task, and only when it is unfinished, has a
  session id, and that session has a **live agent** (`ctx.get('agents').get`),
  queues a short model-facing notice through
  `sessionController.prompt({mode:'queue', content:[{type:'text',text}]})`.
  A cold session is never resumed for a notice. Failures are reported as
  `notified:false` and never fail the control result.
- `open` accepts only `{id, target:'file'|'folder'}`. The host resolves
  `task.path` (file) or `dirname(task.path) || task.dir` (folder), validates it,
  and spawns the platform opener detached (`explorer.exe`, `open`/`open -R`,
  `xdg-open`). The browser never supplies a path, and the action is not exposed
  as an agent tool.

### Browser route API

`POST /api/dsh-rdm/api` (registered through `ctx.connection.fetch`; the
connection service enforces Host/Origin/browser authentication), body:

```jsonc
{"action":"list","sessionId":"sess_abc","status":"running","limit":50}
// -> {kernel, tasks, aggregate, sessions: {…}, workspaces: […]}

{"action":"get","id":"t_…","events":20}
{"action":"stats"}

{"action":"control","ids":["t_…"],"control":"pause","deletePart":false,"notify":true}
// -> {action, results:[{id, ok, task?, error?, notified?}]}
// legacy single-id callers also get top-level task/removedId/deletePart.

{"action":"open","id":"t_…","target":"file"|"folder"}   // -> {opened, path}
{"action":"start","url":"…","dir":"…"}                  // used by the workbench composer
```

Envelope: `{"ok":true,"value":…}` or `{"ok":false,"error":{"code","message"}}`.
The action set is `list`, `get`, `start`, `control`, `stats`, `open`. All
surfaces and the tools call the same `KernelService` methods (one operation, two
callers).

## Build & install

```bash
cd dsh-rdm
npm install                     # local dev deps: esbuild, typescript
bash scripts/dev-build.sh all   # sandbox-safe: host + client (use this from an agent sandbox)
bash scripts/dev-build.sh kernel
node scripts/build.mjs          # canonical esbuild build, outside a sandbox
node scripts/build-kernel.mjs   # canonical cargo build + install, outside a sandbox
node scripts/verify-kernels.mjs --host --run
```

The sandbox note matters for agent-driven development: inside the DSH agent
sandbox a Node script cannot spawn child processes (EPERM), so
`scripts/build.mjs` / `scripts/build-kernel.mjs` are canonical for humans/CI
while `scripts/dev-build.sh` runs the same esbuild/cargo invocations from a
shell and produces byte-identical artifacts (same esbuild version/options and
wrapper text).

Verification paths that work in that sandbox:

```bash
bash scripts/dev-build.sh all && bash scripts/dev-build.sh kernel
python tests/verify_e2e.py            # protocol 2 against the real kernel binary
python tests/verify_extra.py          # independent extra cases (verifier-owned)
python tests/verify_claims.py         # redaction/preflight/flat-notification claims
node tests/tools-receipts.test.mjs    # host receipt contract
node scripts/verify-fixture.mjs       # fixture self-test
```

The repository ships prebuilt kernels for `linux-x64`, `linux-arm64`,
`win32-x64`, `darwin-x64` and `darwin-arm64` under `bin/<platform>-<arch>/`.
They are produced natively by `.github/workflows/prebuilt-kernels.yml` (manual
run commits them to `bin/`; a `v*` tag attaches the complete plugin tarball plus
per-platform kernels to a GitHub release). A **local checkout only has the
current host's kernel rebuilt**; the other platform binaries are regenerated by
that workflow before a release and are stale in a development tree (the host
rejects a protocol-mismatched kernel with a clear error).
`scripts/verify-kernels.mjs` validates the assembled set — existence, executable
format (ELF/PE/Mach-O), POSIX exec bit, SHA-256, and a `--help` start on native
hosts — and gates the release packaging job. Installing the plugin never
compiles the kernel: `package.json` has no `prepare`/`install`/`postinstall`
hook.

Install into a profile from GitHub:

```
dsh plugin --profile web add github:NIRVANA-APOC/dsh-rdm
```

From a release tarball (contains `lib/` and all five kernel directories):

```
dsh plugin --profile web add https://github.com/NIRVANA-APOC/dsh-rdm/releases/download/<tag>/dsh-rdm-<version>.tgz
```

Or install a local checkout as a directory bundle:

```
plugin_manager install_bundle target=<absolute path to dsh-rdm>
```

Then inspect `Tool.listTools` for `rdm_*`, `Slots.listSubTree` for the `rdm`
occupants (`sidebar.panellist`, `main`) and the `shell.overlay` popup
(`dsh-rdm-progress`), and the right-sidebar guide for the "Downloads" capsule.
The host half reloads with the plugin row; a **client bundle change needs one
page refresh** before the sidebar entry, workbench and popup register (the
desktop build does not expose a reload menu item; close/reopen the window or use
the host's page reload if available). After the refresh, confirm the sidebar
entry in `Slots.listSubTree` and open the workbench once.

## Acceptance criteria (0.3.0)

1. `bash scripts/dev-build.sh all` / `node scripts/build.mjs` produce
   `lib/index.js` + `lib/client.js`; the kernel builds and installs to
   `bin/<host>/`; `node scripts/verify-kernels.mjs` passes for all five prebuilt
   targets; kernel unit/integration tests pass.
2. Kernel protocol 2 unchanged: `ServerFacts`, telemetry, session round-trip,
   legacy task records, flat notifications; 0.3.0 only bumps kernel identity to
   `0.3.0`.
3. Tools: seven tools, line-oriented bounded receipts, preflight facts within
   2 s, signed-URL/resume safety, `rdm_search` across sessions with bounded
   matches, policy stated once.
4. Browser route v3: `list` carries session titles + workspace grouping and
   degrades without those services; batch `control` returns one result per id
   and notifies only unfinished tasks whose agent is live; `open` resolves a task
   id only; legacy single-id callers still work.
5. Workbench: composer, three state cards (with filters), kernel words + dot
   only, no page waveform, text + suffix filters, select-all/batch pause/delete,
   per-record pause/resume/open-file/open-folder/delete/copy-id, adaptive
   connection count, workspace → session-title grouping, evidence drawer.
6. Popup on `shell.overlay` id `dsh-rdm-progress`: appears only with active
   downloads, per-session progress/speed/connections, collapse pill, opens the
   workbench; reduced-motion respected.
7. Locale parity between `locale/en.json` and `locale/zh.json`; light/dark and
   1440/768/390/empty/loading/error screenshots from the real components;
   contrast, focus-visible and reduced-motion checks pass.
8. Independent verifier PASS with recorded evidence.
9. Docs: PROTOCOL (kernel), this file, `.design/0.3.0-ui-spec.md`, README (en/zh),
   CHANGELOG 0.3.0, verification report.
10. Live check: plugin installed from this workspace into a DSH profile; seven
    tools visible; `rdm_search` callable; workbench and popup registered
    (`Slots.listSubTree`); fixture download appears; honest limits recorded.

