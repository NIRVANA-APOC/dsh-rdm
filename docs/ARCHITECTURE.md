# dsh-rdm — architecture

`dsh-rdm` embeds a **resident downloader kernel** into DeepSeek Harness: one
long-lived Rust process that stays warm and is driven by model-facing tools and a
sidebar panel. Transfers are segmented, resumable, verifiable and
bandwidth-limited without starting a process per download.

## Goals

1. A compact kernel with one job — serve the plugin's protocol — while covering
   the whole download feature set: probe, segmented multi-connection transfer,
   dynamic work distribution, adaptive concurrency, retry/backoff, resume,
   bandwidth limit, checksum verification, progress events.
2. `dsh` always downloads through RDM: the plugin registers `rdm_*` tools, adds a
   short system-prompt section that prefers them over shell downloads, and shows
   live tasks in a left-sidebar entry + main panel.
3. Resident cost is small and paid lazily: the kernel starts on the first tool /
   panel use, then stays warm; it exits when the plugin unloads or stdin closes.

## Package layout

```
dsh-rdm/
├── package.json              # bundle patch + client manifest + exports
├── cordis.patch.yml          # inserts the dsh-rdm plugin row
├── icon.svg                  # display icon (original artwork)
├── locale/{en,zh}.json       # plugin metadata + UI strings
├── PROTOCOL.md               # kernel <-> plugin NDJSON contract (v1)
├── docs/ARCHITECTURE.md      # this file
├── docs/verification.md      # QA report (QA owner)
├── src/                      # TypeScript host + client sources
│   ├── index.ts              # host plugin: apply(ctx, config)
│   ├── config.ts             # schemastery Config (vendored schema lib)
│   ├── protocol.ts           # TS mirrors of PROTOCOL.md types
│   ├── kernel-client.ts      # spawn + NDJSON RPC + task mirror + restart
│   ├── tools.ts              # tool registrations (5 tools)
│   ├── tool-def.ts           # local defineTool: DSL→JSON Schema + arg validation
│   ├── host-api.ts           # POST /api/dsh-rdm/api browser route
│   ├── types.d.ts            # ambient declarations (local typecheck only)
│   └── client/
│       ├── index.tsx         # client plugin {inject, apply}
│       ├── panel.tsx         # main panel (task list / controls / new download)
│       ├── api.ts            # fetch wrapper for /api/dsh-rdm/api
│       └── styles.ts         # theme-token CSS string
├── vendor/                   # schemastery + cosmokit (MIT), bundled into lib/
├── lib/                      # generated: index.js (host), client.js (browser)
├── kernel/                   # standalone Rust crate (own workspace)
│   ├── Cargo.toml
│   ├── src/…
│   └── tests/…
├── bin/<platform>-<arch>/rdm-kernel[.exe]  # generated kernel binary, built per platform
└── scripts/
    ├── build.mjs             # esbuild host + client bundles
    ├── build-kernel.mjs      # cargo build --release + copy binary (kernel owner)
    └── verify-*.mjs          # QA harness
```

## Kernel (`kernel/`, Rust)

A standalone Cargo workspace (own `[workspace]`, not a member of the repo
workspace) built for one purpose: serve the plugin's protocol.

| Concern | dsh-rdm kernel |
|---|---|
| Public API | NDJSON server + task manager |
| GUI/CLI/IPC/MCP/resolver | not present |
| Adaptive controller | compact AIMD + 429/503 pushback |
| Probe | HEAD with ranged-GET fallback; returns metadata only |
| Resume state | `.part` + `.part.json` |
| Task store | kernel-owned `tasks/<id>.json` |
| Logging | stderr `log` lines |
| Runtime | tokio with 2 worker threads |

Engine flow: `probe (HEAD → ranged GET fallback) → plan (chunk size, target
name, resume scan) → chunked worker pool with dynamic chunk queue and AIMD
concurrency → retries/backoff/Retry-After → SHA-256 verify → atomic rename`.
Servers without range support transparently fall back to one stream.
Pause/cancel are cooperative; resume state is persisted every ~500 ms.

Design constraints: correctness over cleverness; no task panics (task errors
become `failed` states); stdout reserved for protocol; bounded memory
(≤ 200 events/task, no full-body buffering).

Kernel CLI: `rdm-kernel --data-dir <dir> [--log-level warn]`. Exit on stdin EOF.

## Host plugin (`src/index.ts`)

The host half is **self-contained**: it imports only Node built-ins at runtime.
The Harness packages a normal plugin would import (`@deepseek-ai/dsh-tools`,
`@deepseek-ai/schemastery`) are not resolvable from a *linked local* plugin
directory, so:

* `src/tool-def.ts` reproduces the `defineTool` contract used here — it compiles
  the author schema DSL to the raw JSON Schema subset (the registry still
  validates canonical outputs itself) and validates model arguments before
  `execute`;
* `@deepseek-ai/schemastery` + `@deepseek-ai/cosmokit` are vendored under
  `vendor/` (MIT, license files retained) and bundled into `lib/index.js` for
  the exported `Config` schema.

* `inject: ['tools', 'connection', 'systemPrompt']`; `apply(ctx, config)` owns a
  `KernelService`:
  * lazy spawn of `bin/<platform>-<arch>/rdm-kernel[.exe]`, `--data-dir`
    (`config.dataDir` or `$DSH_HOME/dsh-rdm`), `--log-level`;
  * NDJSON RPC (ids, pending map, per-request timeout), task mirror updated by
    `task` notifications, spawn serialization, crash restart with backoff;
  * teardown: kill child on plugin dispose (`ctx.effect`).
* Registers the five tools below and the browser route (see UI API).
* Registers one system-prompt section (`dsh-rdm:downloads`) telling the model to
  use `rdm_*` for every download instead of `bash`/`curl`.
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
at warn level, and visible as `dataDir` in kernel status/stats. A configured
`dataDir` is never overridden, so fixed deployments keep full control.


### Tool surface (model-facing)

| tool | params | returns |
|---|---|---|
| `rdm_download` | `url*`, `dir?`, `fileName?`, `connections?`, `headers?` (json), `cookie?`, `referer?`, `userAgent?`, `expectedSha256?`, `speedLimitBps?`, `resume?`, `singleStream?`, `proxy?`, `insecure?`, `waitSec?` | task view (+ waits ≤ 300 s when `waitSec>0`) |
| `rdm_probe` | `url*`, `headers?`, `cookie?`, `referer?`, `userAgent?` | metadata |
| `rdm_tasks` | `taskId?`, `status?`, `limit?`, `events?` | kernel status + task(s) (+ events for `taskId`) |
| `rdm_wait` | `taskIds*` (1..20), `timeoutSec?` | tasks + `timedOut` |
| `rdm_control` | `taskId*`, `action` (`pause\|resume\|cancel\|retry\|remove`) | task (or removed id) |

Tool descriptions state: use these for every file download; they are the
resident RDM kernel (multi-connection, resumable, verifiable); use
`bash`/`curl` only if the user explicitly demands it. Outputs are bounded
(task views, ≤ 20 events) and stable JSON.

## Client UI (`src/client/`)

Registers into two live slots (confirmed via `Slots.listSubTree`):

* `sidebar.panellist` — `{name:'sidebar.panellist', id:'rdm', order:30,
  label:()=>t('panel.title'), locale:'dsh-rdm'}`, component receives
  `{size, active}` and renders the original download icon.
* `main` — keyed `{name:'main', key:'rdm', locale:'dsh-rdm'}`; renders the
  **RDM panel**: engine status line, a compact start composer (URL bar with
  collapsible directory/connection options), a filterable transfer ledger whose
  rows are state-aware (status, filename, percent, a connection-split lane
  rail plus a connection-lane meter, and only the telemetry that matters for
  that state), per-row
  pause/resume/retry/copy-path + details + overflow actions, an inline details
  region with task facts and recent kernel events, loading skeleton, empty
  state, and an inline route-error banner.

The panel polls `POST /api/dsh-rdm/api {action:'list'}` every 1000 ms while it
is mounted and the document is visible; each action reports its own error. All
colors/spacings use `--dsw-alias-*`/`--dsw-specific-*` theme tokens; no Harness
client package is imported. Locale strings live in `locale/{en,zh}.json` and are
bound through `ctx.locale`.

### Browser route API

`POST /api/dsh-rdm/api` (registered through `ctx.connection.fetch`; the
connection service enforces Host/Origin/browser authentication), body:

```jsonc
{"action":"list"}
{"action":"start","url":"…","dir":"…","fileName":"…","connections":8}
{"action":"get","id":"t_…","events":20}
{"action":"control","id":"t_…","action":"pause"}
{"action":"stats"}
```

Envelope: `{"ok":true,"value":…}` or `{"ok":false,"error":{"code","message"}}`.
`list` returns `{kernel:{running,version?,pid?,error?}, tasks:[TaskView]}`.
Both UI and tools call the same `KernelService` methods (one operation, two
callers); `start`/`control` validate the same way the tools do.

## Build & install

```bash
cd dsh-rdm
npm install                     # local dev deps: esbuild, typescript
node scripts/build-kernel.mjs   # cargo build --release → bin/<platform>-<arch>/rdm-kernel[.exe]
node scripts/build.mjs          # esbuild → lib/index.js + lib/client.js
node scripts/verify-kernels.mjs --host --run   # host kernel present, right format, starts
```

The repository ships prebuilt kernels for `linux-x64`, `linux-arm64`,
`win32-x64`, `darwin-x64` and `darwin-arm64` under
`bin/<platform>-<arch>/`. They are produced natively by
`.github/workflows/prebuilt-kernels.yml` (manual run commits them to `bin/`;
a `v*` tag attaches the complete plugin tarball plus per-platform kernels to a
GitHub release). `scripts/verify-kernels.mjs` validates the assembled set —
existence, executable format (ELF/PE/Mach-O), POSIX exec bit, SHA-256, and a
`--help` start on native hosts — and gates the release packaging job. Installing
the plugin never compiles the kernel: `package.json` has no `prepare`/`install`/
`postinstall` hook, so `dsh plugin add`/`plugin_manager install_bundle` only
unpacks files and the host resolves the bundled binary lazily.

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

Then inspect `Tool.listTools` for `rdm_*` and `Slots.listSubTree root=main /
root=sidebar.panellist` for the `rdm` occupants. A page refresh is not normally
needed for a first install (HMR); if the client bundle was replaced, restart the
page/plugin per plugin_manager output.

## Acceptance criteria

1. `node scripts/build-kernel.mjs` produces `bin/<platform>-<arch>/rdm-kernel[.exe]`;
   `node scripts/build.mjs` produces `lib/index.js` + `lib/client.js`;
   `node scripts/verify-kernels.mjs` passes for all five prebuilt targets;
   kernel unit/integration tests pass.
2. Kernel supports, against a local fixture server: ranged multi-connection
   download, no-range single-stream fallback, pause→resume (same kernel) and
   resume across kernel restart, cancel, retry, SHA-256 mismatch/success,
   speed limit, redirects, probe metadata, filename derivation/sanitization.
3. Plugin installed: `rdm_*` tools are visible to agents; calling `rdm_download`
   downloads a fixture and `rdm_wait` reports `completed`; `rdm_tasks` reflects
   live progress; `rdm_control` pauses/resumes.
4. Live slots show `rdm` in `sidebar.panellist` and `main`; no client slot crash.
5. Kernel idle resident cost, binary size and source line count are measured and
   documented.
6. README + verification report document build/install/usage/limits honestly
   (which hosts run the full e2e suite vs. CI smoke tests; visual UI verification
   limits).
