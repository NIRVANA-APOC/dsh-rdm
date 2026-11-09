# Changelog

All notable changes to `dsh-rdm` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

**Release/tag policy:** every tag (`vX.Y.Z`) must ship with a matching
`[X.Y.Z]` section in this file, added in the same change that bumps the version
or creates the tag. There is no release without a changelog entry; run
`node scripts/check-release.mjs` to enforce it (checks package/kernel version
equality and the matching `[X.Y.Z]` section).

Starting with **0.2.2**, the resident kernel and the plugin package share one
version number. **0.3.0** ships kernel `0.3.0` (protocol stays 2); the kernel
code is unchanged apart from its identity, because 0.3.0 is a review-surface
release. Historical recordings keep the strings their binaries actually wrote
(`0.2.1` kernel = `1.1.0`; pre-unification `0.2.2` builds = `1.2.0`).

## [0.3.0] — 2026-11-09

Download workbench rework: the human can now compose a download, filter and
batch-manage records by workspace/session, open results on the desktop, and see
live progress outside the plugin panel. The agent gains a cross-session record
search tool.

### Added
- **Download workbench (left sidebar).** Paste-a-link composer, three state
  cards (正在下载 / 已完成 / 失败任务) that double as status filters, text plus
  suffix multi-select filters, select-all and batch pause/delete with a
  confirmation bar, per-record pause/resume/open-file/open-containing-folder/
  delete/copy-id actions, and the live adaptive connection count in every row.
- **Workspace → session-title grouping.** Records are grouped by their owning
  workspace (durable workspace registry, cwd fallback), then by the real
  session title folded from the session log; the raw session id is only a
  fallback and the unattributed bucket is explicit.
- **Top-right active-download popup** on `shell.overlay` (id
  `dsh-rdm-progress`): per-session progress, speed and connection totals, with a
  collapsed pill. It exists only while at least one download is active.
- **`rdm_search`**, the seventh model-facing tool: find download records across
  sessions by keyword (id, file name, URL, host, path, session title) or exact
  task id, with scope/status/limit, returning bounded matches with their
  session/workspace labels.
- **Host route v3.** `list` now returns resolved session titles and workspace
  rows; `control` accepts `ids[]` (1–100) and returns one outcome per id;
  `pause`/`cancel`/`remove` can queue a short user-action notice to the owning
  live agent; a new `open` action resolves a task id to its saved file or
  containing folder and launches the host desktop opener (the browser never
  supplies a path). The legacy single-`id` control envelope is kept.
- Copyable download id in both the record row and the evidence drawer; the
  drawer also reports active / target / requested / ceiling worker counts.
- `.design/preview-03/` static preview harness (24 states, mocked v3 route);
  not shipped in the package.

### Changed
- Kernel status is now the words `内核正常` / `内核异常` plus one green/red dot;
  the page waveform recorder and the top-right counts/rates line are gone.
- The global page is a single 1040 px workbench column with the composer,
  cards, filter/selection toolbar and a calm workspace → session ledger; the
  session tab keeps the evidence language and row actions.
- Retuned light/dark token usage for the new cards and popup; responsive layouts
  for 1440 / 768 / 390, focus-visible rings, and reduced-motion handling.
- Full Chinese/English copy for the new surfaces; English counts are
  plural-safe.

### Fixed
- Session right-sidebar rows no longer overflow their column: the waveform is
  styled again, the action cluster is anchored to the row, and the group-title
  dot no longer leaks into the tab header.
- A record without a saved path offers only the folder action; a paused record
  no longer claims a live connection count.

### Security
- `open` accepts only a task id and a fixed target, resolves the path from the
  kernel record, and validates absolute path/existence before spawning the OS
  opener detached. User notices are only delivered when the owning agent is
  live; a cold session is never resumed for a UI click.

## [0.2.2] — 2026-11-09

Live-ModelScope optimization pass, driven by `session_logs/20261109/` and two
real, SHA-256-verified downloads from `unsloth/Qwen3.6-35B-A3B-GGUF`.

### Changed
- **One version number.** Kernel crate identity unified with the plugin package:
  `rdm-kernel` `1.2.0` → `0.2.2`; `package.json` → `0.2.2`; protocol remains 2.
- **Adaptive controller rewritten for real WAN behavior.** Growth probes are
  judged on aggregate throughput (keep while ≥95 % of pre-probe rate), reverts
  carry a 30-tick cooldown, two flat growth probes trigger a saturation freeze,
  and the target freezes when the remaining claim count is ≤ the target (tail).
- **Tail handling.** Tail claims get a 3 s stall deadline and fast retries
  (250 ms × attempt, capped at 1 s) instead of multi-second backoff.
- **Resume restores learned concurrency.** The controller target is persisted in
  `.part.json` and restored (`initial=41` observed in the live Q6 run) instead of
  restarting at the requested connection count.
- `avgBps` is whole-file progress over the task's accumulated lifetime; speed
  windows/EWMA/peak remain this-run rates. Elapsed time is persisted across
  restarts, and legacy terminal records recover it from
  `createdAt`→`finishedAt`.

### Added
- Per-run history **meta record** (`kind:"meta"`) with kernel version, pid, run,
  file/total/chunk, requested/initial/ceiling workers and resume decision; the
  `history` RPC returns `meta` + `builds`, and `rdm_history` renders a `build=`
  line. One task timeline now stays attributable across kernel builds/restarts.
- Plan receipts with `requested=`, `initial=`, `ceiling=`, `chunks=`, `chunk=`,
  resumed bytes and resume decision/reason; resume-state events distinguish
  `ranges / chunks / bytes`.
- Stable `unsupported_method` error naming the method and kernel version, with an
  upgrade hint (replaces the opaque `unknown method …`).

### Fixed
- Resumed tasks no longer report multi-GiB/s averages/peaks inherited from the
  adopted `.part` bytes (live artifact: 8.6 GiB/s first sample, 1.8 GiB/s avg).
- Tail workers no longer shrink the target while finishing (`102→90→79→70` in
  the 20261109 batch); one live tail retry now uses 5 s / 250 ms instead of
  30 s / 10 s + 1000 ms.
- `resume_state.chunksDone` and post-cancel receipts report covered chunks (e.g.
  `41 ranges / 2502 chunks`), not the merged-range count.
- `requestedConnections` survives reloads (falls back to the recorded initial
  population for pre-field records); `elapsedMs`/`avgBps` no longer reset to 0
  after a kernel restart.
- Old 0.2.1 histories and `.part.json` files remain readable.

### Verification
- Gate: `cargo test --all-targets` **146 passed / 0 failed**; Python e2e
  **205/205** (core 55 + v030 90 + v022 60); legacy Node matrix **14/14
  scenarios, 244/244 checks**; tool receipts **43**; fixture **64/64**; independent
  black-box smoke **46/46**; real 0.2.0 task-record load **24/24**.
- Real downloads (both saved in `D:\llm\models`, SHA-256 verified):
  `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` 22,360,456,160 B,
  sha256 `707a55a8a4397ecde44de0c499d3e68c1ad1d240d1da65826b4949d1043f4450`;
  `Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf` 31,843,777,504 B,
  sha256 `f6b6c6d5cfa6f00d964eeb7add28eb14ce7481734d506b90681007678cd2c484`.
- Evidence: [docs/OPTIMIZATION.md](docs/OPTIMIZATION.md) §11,
  [docs/design/0.2.2-live-modelscope-pass.md](docs/design/0.2.2-live-modelscope-pass.md),
  data package [session_logs/20261109-qwen36/](session_logs/20261109-qwen36/).

### Known limitations (documented, not regressions)
- SHA-256 verification still runs serially after the transfer (~4.4 % of a
  26.8 GiB run); out-of-order chunks cannot be streamed into a single hash
  without changing the verification contract.
- Multi-source racing remains roadmap (source choice dominated this session:
  0.13 MiB/s HF vs ~106 MiB/s ModelScope).
- History cadence is ~6.4 Hz rather than the nominal 10 Hz (100 ms reporter tick
  and 100 ms sample gate); the 3 s tail stall path is covered by synthetic tests
  but not by the live run (the 5 s final-phase deadline fired).

## [0.2.1] — 2026-11-09

Real-data fix pass for the `20261108`/`20261109` exports (documented as "0.3.0"
during development; renamed to 0.2.1 when the 0.2.2 release was versioned).

### Added
- Per-task persistent download-data recording: `<dataDir>/history/<task>.samples.jsonl`
  and `.events.jsonl`, a `history` RPC and the `rdm_history` tool; recording
  survives kernel restarts and is bounded per task.
- Adaptive controller growth/collapse handling with HTTP pool rebuild and an
  explicit `maxConnections` ceiling (default 128; `MAX_CONNECTIONS` 32 → 128).
- Stable-identity resume decisions (`resumeDecision`/`resumeReason`) covering
  ETag, Last-Modified, request/final URL path identity, part length and corrupt
  state; `auth_key`/signed-URL material redacted from every projection including
  redirect hops.
- Tail stall deadline tightening (30 s → 10 s ≥90 % → 5 s ≥97 %).

### Fixed
- Resume no longer discards the completed chunk table when the final URL carries
  a fresh per-request token (`auth_key`, `Expires`/`Policy`).
- `auth_key` no longer leaks to the host projection or task records.
- ModelScope Tengine `auth_key` presence is reported as `signedUrl.signed=true`.

## [0.2.0] — 2026-11-08

- Agent-native revision of the plugin: protocol 2 `ServerFacts`/`TaskDetail`,
  per-task session attribution, live telemetry windows, bounded receipts,
  browser route and review-first sidebar UI.
- Slim resident Rust kernel with probe/plan/verify, resumable chunked transfers,
  bandwidth limits, SHA-256 verification and prebuilt kernels for
  Windows/Linux/macOS.

## [0.1.2] — 2026-11-06

- Small-download latency and multi-connection throughput improvements; refreshed
  prebuilt kernel binaries.

## [0.1.1] — 2026-11-05

- Prebuilt Windows, Linux and macOS kernels shipped with the package.
- npm packaging and install documentation; release-hash provenance notes.

## [0.1.0] — 2026-11-04

- First public `dsh-rdm` release: resident multi-connection download engine for
  DeepSeek Harness with `rdm_*` tools.
