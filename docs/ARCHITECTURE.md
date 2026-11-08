# dsh-rdm — architecture (0.2.0, agent-native)

`dsh-rdm` embeds a **resident downloader kernel** into DeepSeek Harness: one
long-lived Rust process that stays warm and is driven by model-facing tools and
two review surfaces. Transfers are segmented, resumable, verifiable and
bandwidth-limited without starting a process per download.

0.2.0 reframes the product: the **agent operates** the downloader through
`rdm_*` tools that return bounded, structured facts; the **human reviews** what
happened in a global sidebar page and in a session-scoped right sidebar tab.
The binding contract for this release is
[design/0.2.0-agent-native.md](design/0.2.0-agent-native.md); the kernel wire
contract is [PROTOCOL.md](../PROTOCOL.md) v2.

## Goals

1. A compact resident kernel with one job — serve the plugin's protocol — while
   covering probe (with server intelligence), segmented multi-connection
   transfer, dynamic work distribution, adaptive concurrency, retry/backoff,
   resume with validator safety, bandwidth limit, checksum verification,
   windowed telemetry and origin memory.
2. `dsh` always downloads through RDM: the plugin registers `rdm_*` tools, adds
   one short system-prompt section that prefers them over shell downloads, and
   exposes review-only UI (left global sheet + session right sidebar tab).
3. Information over control: the tools answer "what does the server do?", "how
   is the transfer doing over several time windows?", "can I resume safely?",
   "does the result verify?" without follow-up calls.
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
│   └── research/             # external evidence and reasoning notes
├── src/                      # TypeScript host + client sources
│   ├── index.ts              # host plugin: apply(ctx, config)
│   ├── config.ts             # schemastery Config (vendored schema lib)
│   ├── protocol.ts           # TS mirrors of PROTOCOL.md v2 types
│   ├── kernel-client.ts      # spawn + NDJSON RPC + task mirror + restart + session tagging
│   ├── tools.ts              # five model-facing tool registrations + line receipts
│   ├── tool-def.ts           # local defineTool: DSL→JSON Schema + arg validation
│   ├── host-api.ts           # POST /api/dsh-rdm/api browser route (list/get/stats/control)
│   ├── types.d.ts            # ambient declarations (local typecheck only)
│   └── client/
│       ├── index.tsx         # client plugin {inject, apply}; left entry + native right tab
│       ├── panel.tsx         # global review page (session-grouped ledger + evidence drawer)
│       ├── rightbar.tsx      # session-scoped review tab body/title
│       ├── components.tsx    # waveform, seals, chips, drawer primitives
│       ├── api.ts            # fetch wrapper for /api/dsh-rdm/api
│       └── styles.ts         # theme-token CSS string
├── vendor/                   # schemastery + cosmokit (MIT), bundled into lib/
├── lib/                      # generated: index.js (host), client.js (browser)
├── kernel/                   # standalone Rust crate (own workspace)
│   ├── Cargo.toml            # rdm-kernel 1.1.0, protocol 2
│   ├── src/…                 # protocol, task, kernel, probe, telemetry, origins, engine
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

| Concern | 0.2.0 kernel |
|---|---|
| Public API | NDJSON server + task manager (protocol 2) |
| GUI/CLI/IPC/MCP/resolver | not present |
| Probe | manual redirect chain + HEAD/ranged-GET, full `ServerFacts` |
| Server intelligence | ranges/validators/resume safety, signed-URL expiry (AWS/GCS/Azure/generic), TLS leaf validity, checksum headers, Retry-After, timing |
| Telemetry | 1s/5s/30s/300s windows, peak/avg, stall, trend, ETA confidence |
| Memory | bounded per-host origin ledger (`origins.json`, ≤256 hosts) |
| Adaptive controller | compact AIMD + 429/503 pushback |
| Resume state | `.part` + `.part.json`, `resumeSafety` reported |
| Task store | kernel-owned `tasks/<id>.json` (v2 fields, v1 records load) |
| Logging | stderr `log` lines |
| Runtime | tokio, `min(4, cores)` worker threads (≥2) |

Engine flow: `probe (redirects → HEAD → ranged GET fallback, capture server
facts) → plan (recommendation-aware chunk size/connections, target name, resume
scan) → chunked worker pool with dynamic chunk queue and AIMD concurrency →
retries/backoff/Retry-After → SHA-256 verify → atomic rename`. Servers without
range support transparently fall back to one stream. Pause/cancel are cooperative
and event-driven; resume state persists every ~500 ms and fsyncs on pause/stop.
Chunk sizing is automatic by default (4 chunks per connection, 256 KiB..8 MiB).
Completed files are renamed without fsync by default (`fsyncOnComplete` opts
back in).

Design constraints: correctness over cleverness; no task panics (task errors
become `failed` states); stdout reserved for protocol; bounded memory (≤200
events/task, ≤3000 telemetry samples, ≤256 origins, no full-body buffering,
≤1 MiB write buffer per worker). Performance work and measurements live in
[OPTIMIZATION.md](OPTIMIZATION.md).

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
* Registers the five tools below plus one system-prompt section
  (`dsh-rdm:downloads`) that states the "use rdm_* for downloads" policy exactly
  once (tool descriptions carry behavior only).
* Session attribution: `rdm_download` reads the calling agent's session id from
  the tool execution context and sends it with the request, so the kernel and
  review UI can scope by session. There is no model-supplied session parameter.
* Config (`schemastery`): `defaultDir`, `connections`, `chunkSizeMiB`,
  `speedLimitBps`, `maxAttempts`, `autoResume`, `dataDir`, `kernelPath`,
  `logLevel`, `startOnDemand`.

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
   cwd being writable.

The fallback is transparent to the caller (the first request succeeds), logged
at warn level, and visible as `dataDir` in kernel status/stats.

### Tool surface (model-facing)

Five tools, bounded canonical outputs, line-oriented receipts. The **model reads
the render**, not the canonical JSON; receipts use stable `key=value` fields in a
fixed order (see `design/0.2.0-agent-native.md` §3.4).

| tool | params | returns |
|---|---|---|
| `rdm_download` | `url*`, `dir?`, `fileName?`, `connections?`, `headers?` (json), `cookie?`, `referer?`, `userAgent?`, `expectedSha256?`, `speedLimitBps?`, `resume?`, `singleStream?`, `proxy?`, `insecure?`, `waitSec?` | task view + preflight `ServerFacts` (waits ≤2 s) + next-step hint; `waitSec` waits for completion (≤300 s) |
| `rdm_probe` | `url*`, `headers?`, `cookie?`, `referer?`, `userAgent?`, `proxy?`, `insecure?`, `timeoutMs?` | full `ServerFacts` receipt: ranges, resume safety, signed-URL expiry, TLS validity, redirects, timing, checksums, recommendation |
| `rdm_tasks` | `taskId?`, `status?`, `limit?`, `events?`, `scope?` (`session` default, `all`) | list: kernel + tasks + aggregate + counts; detail: task + telemetry + server + verification + diagnosis + events |
| `rdm_wait` | `taskIds*` (1..20), `timeoutSec?` | tasks + timedOut + hint; wakes on status transitions, not polling |
| `rdm_control` | `taskId*`, `action` (`pause\|resume\|cancel\|retry\|remove`), `deletePart?` | task (or removed id) |

Tool descriptions are deliberately short; parameter rules live on parameters;
the policy sentence appears only in the system-prompt section (harness
`agent-experience` guidance).

## Client UI (`src/client/`)

Two review surfaces, one visual language. There is **no download composer** and
no connection tuning: the human reviews what agents did.

* `sidebar.panellist` registers the global entry (`id:'rdm'`, `order:30`) whose
  icon opens the **global review page** in the keyed `main` slot (`key:'rdm'`).
* `dsh.client.inject` additionally includes
  `@deepseek-ai/dsh-client-ui-sidebar-right`; the client registers a native
  right-sidebar tab type `dsh-rdm/downloads` (kind `rdm`) with a guide entry, a
  body slot and a title slot. The tab filters tasks by the session id the slot
  framework injects, giving the **session review** surface.
* Both surfaces share components: aggregate header, 60–120 s throughput
  waveform, session-grouped ledger, server chips, verification seal, and an
  evidence drawer (server facts, timing, resume state, verification, events).
* All colors/spacings use `--dsw-alias-*`/`--dsw-specific-*` theme tokens; no
  Harness client package is imported beyond the injected client modules. Locale
  strings live in `locale/{en,zh}.json` and are bound through `ctx.locale`.
* The client tolerates an older host API (missing fields render as unknown) and
  missing right-sidebar services (the left page still works), so a partial
  deploy never crashes the page.

### Browser route API

`POST /api/dsh-rdm/api` (registered through `ctx.connection.fetch`; the
connection service enforces Host/Origin/browser authentication), body:

```jsonc
{"action":"list","sessionId":"sess_abc","status":"running","limit":50}
{"action":"get","id":"t_…","events":20}
{"action":"stats"}
{"action":"control","id":"t_…","action":"pause","deletePart":true}
{"action":"start","url":"…","dir":"…"}   // retained for tests/programmatic callers; the UI does not use it
```

Envelope: `{"ok":true,"value":…}` or `{"ok":false,"error":{"code","message"}}`.
`list` returns `{kernel, tasks, aggregate}`; both UI surfaces and tools call the
same `KernelService` methods (one operation, two callers).

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
occupants (`sidebar.panellist`, `main`), and the right-sidebar guide for the
"Downloads" capsule. A page refresh is not normally needed for a first install
(HMR); if the client bundle was replaced, restart the page/plugin per
plugin_manager output.

## Acceptance criteria (0.2.0)

1. `bash scripts/dev-build.sh all` / `node scripts/build.mjs` produce
   `lib/index.js` + `lib/client.js`; the kernel builds and installs to
   `bin/<host>/`; `node scripts/verify-kernels.mjs` passes for all five
   prebuilt targets; kernel unit/integration tests pass.
2. Kernel protocol 2: `ServerFacts` complete against the fixture (redirects,
   ranges, validators, signed URL, checksum/rate-limit headers), telemetry
   windows/peak/avg/stall/trend/ETA confidence correct, session id round-trips,
   0.1.x task records load, notification stays flat.
3. Tools: receipts line-oriented and bounded; preflight facts available within
   2 s; signed-URL expiry and resume safety reported; policy stated once.
4. Session scoping: tool-started tasks carry the calling session id; browser
   `list` filters by it; unattributed tasks stay global.
5. Client: global page and session right tab show live + historical tasks with
   evidence drawer; light/dark, 1440/768/390, empty/loading/error states
   verified from screenshots; contrast and reduced-motion checks pass; no
   composer.
6. Independent verifier PASS with recorded evidence.
7. Docs: PROTOCOL v2, this file, design contract, research note, README 0.2.0,
   verification report; performance changes measured and documented.
8. Live check: plugin installed from this workspace into a DSH profile; tools
   visible; a fixture download completes and appears in both review surfaces
   (screenshot evidence), or the limitation documented honestly.
