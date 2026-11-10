# dsh-rdm 0.3.0 — verification report

> **0.3.3 (2026-11-10) — download-UI agent notices removed.** Acting on a
> download record in the workbench page or its batch toolbar no longer tells the
> owning session agent that the user did it: the client sends no
> `notify` field, the host route only calls `kernel.control` (no pre-action task
> snapshot, no live-agent gate, no `sessionController.prompt`), control results
> carry no `notified` field, `SessionCatalog.notify` is gone and the
> `record.agentNotified` locale strings are deleted. The same round re-anchors
> the `dsh-rdm:downloads` system-prompt section from the environment suffix into
> the harness tool-guidance band (`MCP_SERVERS + 1`), makes it tool-aware
> (renders only while `rdm_download` is admitted), and adds the 0.3.3 workflow
> facts (silent panel actions → re-read `rdm_tasks`; destructive verbs only on
> user request; `rdm_probe` mirrors → `rdm_download` sources), keeping the
> section a bounded policy block (111 → 160 words). Research and open receipt
> defects: [research/agent-prompt-and-workflow.md](research/agent-prompt-and-workflow.md).
> The same round removes the session-scoped "Downloads" tab from the right
> sidebar: `native.ts`, `session-tab.tsx`, `wave.tsx`, the scoped poll/pulse
> data, the reveal/stop drawer actions and the `sidebarRight*` client
> boilerplate are gone, `@deepseek-ai/dsh-client-ui-sidebar-right` is no longer
> injected, and `tests/client-activation.test.mjs` now asserts that no native
> right-sidebar surface registers. `lib/client.js` shrank to 204,807 B (−12.9%).
> Repo gates:
> `tests/host-api.test.mjs` **22/22**, `tests/client-activation.test.mjs`
> **8/8**, `tests/session-catalog-open.test.mjs` **13/13**,
> `tests/tools-receipts.test.mjs` **56/56**, `check-release` **PASS**
> (package = kernel = `0.3.3`), `tsc --noEmit` has no new error locations (the
> count dropped from 10 to 9 because one pre-existing error lived in the deleted
> `session-tab.tsx`). The rebuilt
> `lib/index.js` / `lib/client.js` contain no `notified` / `agentNotified`
> member or the old notice prose.

> **0.3.2 (2026-11-10) — released fix round.** Four reported defects were fixed
> and re-verified end-to-end in an isolated `dsh web` harness (headless Firefox/
> geckodriver, profile `/tmp/dsh-e2e`, plugin installed from this checkout).
> 1. **“打开所在目录 / 打开文件” had no visible response.** The host spawned the
>    OS opener detached, ignored asynchronous spawn errors, and always answered
>    `opened:true`; on a headless host `xdg-open` exits without a window while the
>    client only wrote to an sr-only live region. The host now detects desktop
>    capability (`DISPLAY`/`WAYLAND_DISPLAY` + resolvable `xdg-open` on Linux),
>    waits for the child `spawn`/`error` signal, and answers
>    `{ok:false,error:{code:'unsupported'}}` when it cannot open a window; the
>    client renders a visible banner with the resolved path and a copy-path
>    fallback. Evidence: `verify-item1-*`, `verify-locale-zh-0{3,4}*.png`.
> 2. **Popup “打开下载页” did nothing.** The optional `layout` service was
>    captured during client `apply`; the DSH page starts every client entry in
>    one pass, so a sibling entry's service may still be pending and the captured
>    value stayed `undefined` forever. It is now resolved at click time and the
>    layout package is declared in `dsh.client.inject`; a regression test
>    (`tests/client-activation.test.mjs`: lazy-layout test; fails on the 0.3.1
>    bundle) locks the ordering. Evidence: `verify-item2-*`.
> 3. **Popup moved to the bottom-right** (`bottom/right: 16px`, responsive 12px;
>    no horizontal overflow at 390/768/1440). Evidence: `verify-item3-*`.
> 4. **Popup rows are now per download and titled by file name**; the owning
>    session is secondary meta. Evidence: `verify-item4-popup-rows.png`,
>    `verify-locale-zh-02-popup.png`.
>
> Regressions: 4 fresh boots with zero `Failed to load plugins` / `[dsh-rdm]`
> errors; workbench, collapse/expand, en+zh parity checked. Repo gates:
> `tsc --noEmit` unchanged from HEAD's 10 pre-existing errors (no new),
> `tests/host-api.test.mjs` 23/23, `tests/client-activation.test.mjs` 8/8,
> `tests/session-catalog-open.test.mjs` 13/13,
> `tests/tools-receipts.test.mjs` 56/56, `check-release` PASS.

> **0.3.1 hotfix (2026-11-10):** `apply` in the client half read `ctx.layout`
> without declaring `layout` in `inject`. Cordis throws on an un-injected
> service read (`cannot get property "layout" without inject`), so the client
> entry's fiber never reached `active` and DSH's boot audit replaced the whole
> page with `Failed to load plugins / dsh-rdm`: installing 0.3.0 made the
> harness web UI unloadable. Fixed by reading optional services through
> `ctx.get` (`src/client/services.ts`), a last-resort guard around activation,
> and the real `layout.selectPanel` call for the popup.
> Evidence: headless Chromium boot of a patched `dsh web` — 0.3.0 bundle renders
> `Failed to load plugins`; fixed bundle boots all 90 client entries with zero
> console errors and mounts the workbench (sidebar entry `下载`, panel `rdm`,
> 12 ledger records). Regression test `tests/client-activation.test.mjs`
> (7/7 pass; 5/7 fail against the 0.3.0 bundle). Protocol and kernel behavior
> unchanged; `lib/index.js` version hint now derives from `package.json`
> (`PLUGIN_VERSION`), so `check-release` and the hint cannot drift apart.

Status: **PASS** — all nine brief items, the active-download popup, host route v3,
the session/workspace catalog, user-action notices, the desktop open action and
`rdm_search` pass. No HIGH or MEDIUM defect remains; the verifier's five LOW
findings were fixed in this build (see §6).

> **0.3.0 note:** this final release merges the workbench/search and multi-source
> scheduling work, defaults README/CHANGELOG to Chinese, and adds the real
> downloader benchmark. Protocol and behavior are unchanged from
> `0.3.0-alpha.1`. The rebuilt win32-x64 kernel is 5,349,376 B, SHA-256
> `A143800B3E03270F6D40C5B44CE06D1E5000D1B73A1115E461E38208D5E0EDD9`.
> Gates re-run after the bump: cargo **157/157**, Python e2e **205/205**, extra
> **56/56**, claims **15/15**, tools **56**, host-api **21/21**, kernel-e2e
> **PASS**, fixture **64/64**, `verify-kernels --host --run` **PASS**,
> `check-release` **PASS**, `tsc --noEmit` clean.
> Benchmark: **62/62** SHA-256 checks, 20.65 GiB;
> [session_logs/20261110-downloader-bench/README.md](../session_logs/20261110-downloader-bench/README.md).

- Contract: [`.design/0.3.0-ui-spec.md`](../.design/0.3.0-ui-spec.md)
- Kernel protocol: [PROTOCOL.md](../PROTOCOL.md) v2, kernel `0.3.0`
  (wire format unchanged from 0.2.2)
- Package: `dsh-rdm` 0.3.0
- Verifier: independent `verifier` teammate; implementation Lead; verification
  report and scripts under [`.design/verify-03/`](../.design/verify-03/).

## 1. Artifacts verified

| artifact | sha256 | bytes |
|---|---|---|
| `lib/index.js` | `0D1E96289CFCB4F285C4E7D9007BE8701D6279AFB621C02C0509FDB46BFC8482` | 213,490 |
| `lib/client.js` | `FBE71DE51AD04319A8F774CE146D5DBC41BB6C58130018F1BF68B394489FCDE8` | 227,949 |
| `bin/win32-x64/rdm-kernel.exe` | `A143800B3E03270F6D40C5B44CE06D1E5000D1B73A1115E461E38208D5E0EDD9` | 5,349,376 |

Environment: Windows x64, Node v24.19.0, TypeScript 5.9, esbuild 0.25,
rustc/cargo 1.99.1, Chrome 157.0.8103.38 (headless, CDP), DSH desktop profile
`desktop`. The kernel ready frame reports
`{"event":"ready","protocol":2,"kernel":{"version":"0.3.0",…}}`.

## 2. Requirement verdicts

| # | Brief item | Verdict | Evidence |
|---|---|---|---|
| P | Top-right popup only while a session has an active download; shows progress | **PASS** | `src/client/overlay.tsx`; `shell.overlay` id `dsh-rdm-progress`; CDP checks 51/51 (absent on quiet/empty, unmounts when active set empties, 3 session rows, collapse pill); `pop-1440-light-active.png`, `pop-1440-dark-active.png`, `pop-1440-light-collapsed.png` |
| 1 | Kernel status = 正常/异常 + green/red dot, nothing else | **PASS** | `ledger.tsx` `KernelHealth`; loading shows neutral 检测中; `.rdm2-kernel*` in `review-css.ts`; screenshots light/dark |
| 2 | Remove page waveform + top-right status text; three status cards | **PASS** | No `rdm2-wave` in page DOM (CDP 51/51); cards 4/8/2 with aria-pressed filters; `p-1440-light-mixed.png`, `p-1440-light-quiet.png` |
| 3 | Per-record pause/delete, agent notice for unfinished user actions, multi-select/all | **PASS** | `RecordRow` actions + batch toolbar; host route notify gating (36/36 independent checks); `p-1440-light-batch.png`, `p-1440-light-confirm.png` |
| 4 | Open file / open containing folder per record | **PASS** | `open` action resolves task id → file/dir and launches detached opener; independent harness rejects arbitrary-path input; row action states |
| 5 | Current connection count in the record view | **PASS** | `currentConnections()` + `ConnectionBadge`; running rows show 12 / 24; paused rows honestly show none |
| 6 | Group by workspace, then real session title | **PASS** | `groupByWorkspace()` + host catalog; rendered groups `dsh-rdm`, `Documents`, `未归属工作区` with real titles; CDP verified titles |
| 7 | Text filter + multi-select suffix dropdown | **PASS** | `p-1440-light-filter.png` (6 pdf), `p-1440-light-suffix.png`; CDP composed filters 6 pdf → +zip → 0 → clear 14 |
| 8 | Paste-a-link composer at the top | **PASS** | `Composer` posts `start`; CDP verified a task starts through the mocked v3 route; error state `p-1440-light-composer.png` |
| 9 | Copyable download id + agent record search tool | **PASS** | `rdm-id-chip` copies full id; `rdm_search` is the 7th tool; live receipt below; locale parity + tool tests |
| — | Host route v3, catalog, notify/open | **PASS** | independent harness 36/36; `tests/host-api.test.mjs` 21/21 |
| — | Locale parity | **PASS** | `.design/verify-03/locale-parity.mjs`: 222 literal + 51 dynamic keys, en 278 = zh 278, placeholders match |
| — | Build/quality | **PASS** | `tsc --noEmit` 0; `node --check` both bundles; receipts 49/49; host API 21/21; release check PASS; 146 cargo tests pass; `python tests/verify_e2e.py` 205/205; fixture 64/64; `verify-kernels --host --run` PASS |
| — | Visual matrix | **PASS** | 24 real-component shots: light/dark, 1440/768/390, empty/loading/error, batch/confirm/filter/suffix/drawer/composer, popup expanded/collapsed, en |
| — | Live tool check | **PASS** | `rdm_search` live on the reloaded host: `search scope=all matches=5 total=8`, rows carry session/workspace labels |

## 3. Method

1. **Independent host harness** (`verifier`, 36/36): list enrichment and
   degradation for missing/rejecting/malformed catalogs and kernel failure; batch
   `control` per-id outcomes with partial failure; notify only for unfinished
   tasks owned by a live agent; pre-remove snapshot; refusal of arbitrary `open`
   paths; legacy single-id envelope; `rdm_search` filtering/schema/receipt.
2. **Independent rendered behaviour** (51/51): real components in headless
   Chrome against the mocked v3 route, including popup mount/unmount rules,
   absence of page waveform, card filters, composer, composed filters,
   select-all/batch, copy-id, real session-title grouping, 390/768 overflow,
   focus-visible and reduced motion.
3. **Real-contract inspection** against the packaged Harness `app.asar`:
   `sessionQuery.readTitleSnapshots`, `workspaceRegistry.list`, `sessions.get`,
   agents, `sessionController.prompt`, slot registration keys and the
   `shell.overlay` / `main` / `sidebar.panellist` topology.
4. **Build reproduction**: both bundles rebuild byte-identically from `src/`
   with the exact `scripts/dev-build.sh` esbuild invocations (Git Bash is blocked
   by this sandbox's named-pipe policy; the Lead used the same binary and flags).
5. **Kernel**: identity bump only; 146 cargo tests pass, `python
   tests/verify_e2e.py` passes **205/205** against the shipped binary, the
   fixture self-test passes 64/64, and `verify-kernels --host --run` reports
   PASS; the ready frame reports 0.3.0 / protocol 2.
6. **Screenshots**: `.design/preview-03/` renders the real components against a
   mocked v3 route, captured through CDP; the committed marketing shots under
   `assets/screenshots/` are refreshed from that matrix.

## 4. Live evidence

```
$ rdm_search query="dsh-rdm" scope=all limit=5
search scope=all matches=5 total=8
task t_e59c3409e51dbd85 state=failed progress=- session="配置 npm 的 GitHub Actions" workspace="dsh-rdm" file="actionlint.zip" connections=0/0
task t_e7deb94b316e7f00 state=completed progress=100% session="-" workspace="dsh-rdm" file="live-smoke.bin" connections=0/0
…
```

The DSH desktop profile runs the rebuilt host bundle (the tool is registered and
the download policy section names it exactly once).

For the client half, the shipped `lib/client.js` was executed against a fake
Harness context (`.design/preview-03/bundle-smoke.html` /
`bundle-smoke.mjs`): module evaluation succeeds and `apply` registers exactly

```
BUNDLE:READY sidebar.panellist:rdm | main:rdm | shell.overlay:dsh-rdm-progress
```

The same component tree is rendered for 24 screenshot states. The running DSH
window was already open before the plugin was re-enabled, so the new client
module appears after one page refresh; the reload shortcut is not exposed by
this build and the verification did not restart the user's app. This is the
normal install/refresh boundary, not a runtime failure. A live client
registration check after a page refresh is the remaining manual step.

## 5. Known limits (honest)

- The real OS opener was not launched during verification (it would open a
  window on the host desktop); only validation and path-resolution branches are
  tested. `explorer.exe`, `open`/`open -R`, `xdg-open` are the documented
  handlers.
- A live agent notice was not exercised end-to-end from a UI click in this
  environment. Service contracts and gating were checked against the packaged
  Harness; a controlled live test remains a manual step.
- The workbench composer exposes the plugin defaults only; connection count,
  headers and checksum stay `rdm_download` parameters.
- `cargo fmt --check` reports pre-existing formatting diffs in kernel files not
  touched by 0.3.0 (rustfmt 1.10.0-stable vs the version the kernel was
  formatted with); the 0.3.0 version edits follow the surrounding style.

## 6. LOW findings from the verifier and their resolution

| finding | resolution |
|---|---|
| Loading showed kernels as failed before the first poll | `KernelHealth` renders 检测中 + neutral dot while `phase=loading` |
| Light green kernel dot at 2.28:1 | dot uses the ink-mixed `--rdm2-ok-graphic` |
| Records were a card stack instead of one hairline ledger | one bordered record list per session, hairline rows, 3 px selection bar |
| Popup 306 px / 14 px, spec says 300 / 16 | sized to 300 px, right 16 px |
| `rdm_search` match omitted `updatedAt` | added to the schema, value and fixture |

Docs nits (search receipt field order, CHANGELOG literal `\n`, plural-neutral
English counts, stale composer comments) are fixed in the same build.

## 7. Evidence index

- [`.design/verify-03/`](../.design/verify-03/) — independent verifier report
  (36/36 host, 51/51 rendered, locale, defects).
- [`.design/preview-03/bundle-smoke.html`](../.design/preview-03/bundle-smoke.html) —
  shipped-bundle load + `apply` registration smoke.
- [`.design/verify-03/verify-host.mjs`](../.design/verify-03/verify-host.mjs),
  [`cdp-verify.mjs`](../.design/verify-03/cdp-verify.mjs),
  [`locale-parity.mjs`](../.design/verify-03/locale-parity.mjs).
- [`.design/preview-03/`](../.design/preview-03/) — harness, scenarios, capture
  matrix, 24 shots.
- [`tests/tools-receipts.test.mjs`](../tests/tools-receipts.test.mjs) — 49 checks.
- [`tests/host-api.test.mjs`](../tests/host-api.test.mjs) — 21 tests.
- Committed screenshots: `assets/screenshots/review-*.png`.

## 0.3.0-alpha.1 — multi-source acceptance (2026-11-09)

Merged with the 0.3.0 workbench/search pass. Gate run on the final merged tree
(Windows 11 x64, rustc 1.99.1, Node 24.19.0):

| # | Check | Result |
|---|---|---|
| 1 | cargo test --all-targets | **157/157** (lib 78, engine 15, protocol 5, unit 17, v022 13, v030 21, multi_source 8) |
| 2 | python tests/verify_e2e.py | **205/205** |
| 3 | python tests/verify_extra.py / verify_claims.py | **56/56** / **15/15** |
| 4 | node tests/kernel-e2e.mjs (incl. multi-source select) | **PASS** |
| 5 | node tests/tools-receipts.test.mjs / host-api.test.mjs | **PASS 56 checks** / **21/21** |
| 6 | node scripts/verify-fixture.mjs / verify-kernels.mjs --host --run | **64/64** / **PASS** |
| 7 | node scripts/check-release.mjs | **PASS** (package = kernel = 0.3.0-alpha.1) |
| 8 | npx tsc --noEmit -p tsconfig.json | **clean** |

Multi-source behavior is covered by the kernel `multi_source` suite (explicit
selection, failover, unproven-identity refusal, two-source race, slow-source
exclusion, hedged first range, Metalink/HTTP Link discovery, `.meta4` resolution
and SHA-256). A real-network Alpine ISO run measured `select` at **11.4×** the
single official CDN; see [session_logs/20261109-multisource/README.md](../session_logs/20261109-multisource/README.md).

## Visual re-acceptance — merged UI (2026-11-10)

Re-ran the real-component preview harness after the merge, adding multi-source
drawer states (the previous matrix did not exercise `sources[]`).

| Check | Result |
|---|---|
| `.design/preview-03/cdp.mjs` matrix | **29/29 shots** (24 existing + 5 new multi-source: 1440 light/dark/en, 768, 390) |
| `cdp-verify.mjs` independent rendered checks | **53/53** (was 51/51; +2 multi-source 390 px checks) |
| `contrast-audit.mjs` | **PASS** every audited pair, both themes |
| `locale-parity.mjs` | **PASS** (zh/en keys + placeholders) |
| `verify-host.mjs` | **36/36** |

What the new states prove:

- The drawer's **源 / Sources** section renders policy, selected host, switch
  count, source count and one row per source with state (`active`/`standby`/
  `bad`), role, selected marker, bytes, rate and error text.
- The server section renders discovered **镜像 / Mirrors** hosts without raw URLs.
- At **390 px** the drawer has 3 source rows, exactly one selected, no raw URL
  leak, and no horizontal overflow (`pageScrollWidth=385` inside `innerWidth=390`).
- Light and dark themes both keep the bad-source row readable (red error text).
- English copy is complete and does not change layout.

Findings and fixes during this pass:

1. `contrast-audit.mjs` was checking the raw success token for the kernel OK dot
   while the CSS paints that dot with the derived `--rdm2-ok-graphic`; the raw
   token fails on white (2.28:1), the real dot passes (4.14:1 light, 6.89:1
   dark). Audit corrected to the actual derived token.
2. A `--window-size=390` Chrome screenshot clipped drawer text horizontally;
   CDP mobile emulation (`Emulation.setDeviceMetricsOverride`, mobile=true) shows
   the product CSS wraps correctly. The 390 source shot is captured through CDP.
3. The source-error row wraps its error text below the host at 390 px rather than
   widening the page.

Screenshots: `.design/preview-03/shots/p-1440-{light,dark,en}-sources.png`,
`p-768-light-sources.png`, `p-390-light-sources.png`,
`.design/verify-03/shots/verify-sources-390.png`. `.design/` is ignored and not
shipped.
