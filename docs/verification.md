# dsh-rdm 0.2.0 — verification report

> **Historical report.** This file documents the **0.2.0** verification run and its
> artifacts (0.2.0 kernel sha256 `068319182e4a5cd1f6f81db8d0b5b5c2dc3838824f6dd991eb90bd8de4ca5406`,
> 4,974,080 bytes). Later passes are reported elsewhere:
> **0.2.1** gate/artifacts (kernel sha256
> `94AB6DCCB2B343B5CAFE4ABB5B51F73856E5CF2CCD1D1546EE8B77B33B612FDE`, 5,059,072
> bytes) in [`OPTIMIZATION.md`](OPTIMIZATION.md) §10 and
> [`design/0.2.1-real-data-fixes.md`](design/0.2.1-real-data-fixes.md); **0.2.2**
> (kernel 0.2.2, package 0.2.2) in [`OPTIMIZATION.md`](OPTIMIZATION.md) §11 and
> [`design/0.2.2-live-modelscope-pass.md`](design/0.2.2-live-modelscope-pass.md)
> — final artifacts kernel sha256
> `B322863E1BDBE342499BCCD9379B66823640C445165F9D7540053610BAFEAC77`, 5,101,056
> bytes; gate 146/0 cargo tests, 205/205 e2e checks, 43 receipt checks, 244/244
> legacy-matrix checks, 64/64 fixture checks.

Status: **PASS** on the release contract
([`docs/design/0.2.0-agent-native.md`](design/0.2.0-agent-native.md) §8), with one
documented environment limitation: the live in-profile install check could not be
driven from the development sandbox (see §6). This report summarises the
independent verification run; the full evidence bundle (commands, logs, contrast
matrices, captured screenshots, hashes) lives in the verifier workspace
`.design/reports-02/` and is intentionally not shipped with the package.

* Contract: `docs/design/0.2.0-agent-native.md` §8
* Protocol: [`PROTOCOL.md`](../PROTOCOL.md) (protocol 2, kernel 1.1.0)
* Verifier: independent teammate, not an implementer; no product code edited.

## 1. Verified artifacts (final closure)

| artifact | sha256 | bytes |
|---|---|---|
| `lib/index.js` | `58ff667940295279d48145c924115d9b1750788ac879ee24f2a93e823a6fafe3` | 161,528 |
| `lib/client.js` | `418da48a4155ef2b30fbfe103b283a4718ad0291ea8214f73beaebd07dae92e5` | 140,121 (esbuild body 139,801) |
| `bin/win32-x64/rdm-kernel.exe` | `068319182e4a5cd1f6f81db8d0b5b5c2dc3838824f6dd991eb90bd8de4ca5406` | 4,974,080 |
| `kernel/target/release/rdm-kernel.exe` | same as `bin/win32-x64/rdm-kernel.exe` | 4,974,080 |

Environment: Windows x64 (MSYS bash), Node v24.19.0, Python 3.14.7, cargo/rustc
1.99.1, Chromium 157.0.8103.38 (REA browser provider). Kernel ready frame:
`{"event":"ready","protocol":2,"kernel":{"version":"1.1.0",...}}`.

An independent rebuild (`bash scripts/dev-build.sh host|client`) is
**byte-identical** to both published JS bundles, including the closure pass after
the UI contrast fix.

## 2. Verdict table (contract §8)

| # | Acceptance criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Release builds: kernel → `bin/<host>/`, host + client bundles | **PASS** (sandbox-substituted) | independent byte-identical rebuilds; `bin` == `target/release`; kernel reports protocol 2. The canonical `node scripts/build.mjs` cannot spawn children in the DSH sandbox, so the shell-equivalent `scripts/dev-build.sh` was used. |
| 2 | Protocol 2: complete `ServerFacts`, telemetry windows, session round-trip, 0.1.x records load, flat notifications | **PASS** | 55/55 shipped e2e, 56/56 independent extra harness, 15/15 claim probes, 80/80 cargo tests, `cargo fmt` clean, flat-notification probe |
| 3 | Tools: schema cost ≤ 0.1.2; preflight ≤ 2 s; signed-URL/resume safety; bounded receipts; policy once | **PASS** | first-turn schema cost 7241 → **4966 chars (−31.4 %)**; preflight facts at **21.1 ms**; 31/31 receipt contract; policy sentence count = 1; 18/18 host-API checks |
| 4 | Session scoping: calling session on tool tasks; browser `list` filtered; unattributed tasks global | **PASS** (HTTP route static-only in sandbox) | kernel `list` isolation dynamic (56/56 extra); `exec.agent.session.id` propagation via mock execution; route code path in the built bundle |
| 5 | UI: both surfaces, evidence drawer, states, light/dark 1440/768/390, contrast, no literal colors, no composer, native right tab + guide | **PASS** | 21 real renders audited (12 global / 9 session; 6 dark; error states on both surfaces), plus 2 independent headless-Chromium captures; contrast **56/56 pairs pass** (light non-text marks ≥ 3:1 after ink-mix fix; dark restores host hues); 0 literal colours; no composer; `main` key `rdm` + `sidebar.right.pane.tab` key `dsh-rdm/downloads` (kind `rdm`, guide order 40) |
| 6 | Independent verifier PASS on kernel, host, client | **PASS** | this report + hashed evidence bundle |
| 7 | Docs: PROTOCOL v2, ARCHITECTURE, design contract, research note, README 0.2.0, this report | **PASS** | protocol-doc audit 13/13; design contract matches implementation; research note; English + Chinese README 0.2.0; this report replaces the 0.1.x QA report |
| 8 | Live check: installed in a DSH profile, `rdm_*` visible, fixture download in both review surfaces | **UNVERIFIED (documented)** | plugin installation/profile UI cannot be driven from the sandbox (Node child spawn EPERM, no profile control). Substitute evidence: real kernel fixture downloads through every harness and both review surfaces rendered from the rebuilt client in independent headless Chrome. |

Counts: **239 one-off checks passed** (55 e2e + 56 extra + 15 claims + 18 host-API
+ 31 receipts + 64 fixture) plus **80 cargo tests**; closure client checks:
rebuild byte-identical, `node --check` OK, `tsc --noEmit` clean, contrast 56/56,
protocol audit 13/13, 21/21 screenshots real and dimension-correct.

## 3. Method

Three independent evidence tiers:

1. **Re-derive from the contract.** Verifier-owned harnesses
   (`tests/verify_extra.py`, `tests/verify_claims.py`, host-API and
   contrast/protocol-audit scripts) assert the contract text rather than
   re-running implementer tests.
2. **Drive the real artifact.** Wire-level claims run against
   `bin/win32-x64/rdm-kernel.exe` over NDJSON (Python spawns it; Node cannot in
   this sandbox). Receipt/API claims run against the built `lib/index.js` through
   its exported helpers and a mock `KernelService`.
3. **Independent visual reproduction.** The preview harness is rebuilt from
   source, served locally, and captured in a fresh headless Chromium 157 (two
   captures) plus an audited 21-shot matrix (Pillow: dimensions, colour census,
   light/dark luminance, SHA-256); WCAG contrast is recomputed from the generated
   host palette and the product CSS token expressions.

Independent extra coverage worth naming:

* no-range origin → probe reports unsupported ranges and the download completes
  as a single stream, byte-identically;
* pause → **kill kernel process** → new kernel on the same data dir → resume
  completes the original bytes (partial `.part` and progress survive restart);
* session-scoped `list` excludes other sessions; session-less tasks stay global
  with `sessionId: null`;
* raw `initialize` frame with `protocol: 1` is rejected with
  `code: protocol_mismatch`;
* canonical credential redaction: every planted secret is absent from all
  protocol views; preflight facts available at 21.1 ms; notifications flat;
  shutdown replies and exits in milliseconds.

## 4. Findings resolved during verification

| id | severity | finding | resolution |
|---|---|---|---|
| F1 | LOW | light-mode non-text status marks below the design's 3:1 glyph floor (success 2.28:1, warn 2.15:1) | ink-mixed `--rdm2-graphic-ok/-warn` tokens; light success 4.14:1, warn 3.51:1; dark restored to host hues; independently re-measured 56/56 contrast pairs |
| F2 | LOW | evidence matrix missing 768 px dark shots and a session-surface error state | 21-shot matrix: light+dark 1440/768/390 on both surfaces, drawer/empty/loading/EN, error state on both surfaces |
| F3 | LOW | README task-list receipt example drifted from the renderer | example now matches actual output (`kernel` / `scope=` / `aggregate` / task line) |
| F4 | LOW | `README.zh-CN.md` still the 0.1.x page | rewritten as the 0.2.0 counterpart, structural parity verified |
| F5 | LOW | this file was still the 0.1.x QA report while the README pointed at it | replaced by this 0.2.0 report |
| F6 | LOW | design contract said credentials were redacted "in UI only" | contract now states canonical redaction; implementation was already safer |
| F7 | INFO | design example `valid(19m)` vs single-unit rule; PROTOCOL shutdown result wording | example corrected to `valid(19m40s)`; shutdown result documented as `{}` |

## 5. Performance (agent-facing layer vs 0.1.2)

Native range-origin A/B (pristine 0.1.2 vs 0.2.0 kernel, medians, two runs;
host load varies): 1 MiB 6.1 → 6.5 ms / 12.1 → 12.7 ms; 10 MiB 16.0 → 12.2 ms /
19.8 → 13.3 ms; 64 MiB/8 55.4 → 53.0 ms / 55.2 → 58.3 ms; 64 MiB/1 134.0 →
131.6 ms / 143.9 → 144.6 ms. Every difference is inside loopback variance; the
conclusion is parity. A real regression was found and fixed during the pass (the
origin-ledger disk save gated the terminal transition for small downloads; it now
runs on a coalescing background writer). Details and the reproduction harness:
[`OPTIMIZATION.md`](OPTIMIZATION.md) §9.

## 6. Limitations (honest)

1. **Live in-profile install / real DSH browser route / native sidebar shell**
   (§8.8) — not executable from the sandbox: Node cannot spawn children,
   plugin installation and profile UI control are unavailable. The preview
   renders the real client components against the same protocol-v2 route shape,
   and the kernel wire path is exercised for real, but the host-route HTTP layer
   and the native right-sidebar shell are verified statically rather than live
   by this report.
2. **Foreign prebuilt kernels** (linux/darwin) — presence and container format
   only in this checkout; they are regenerated by the release CI on native
   runners. A development checkout only has the current host's kernel rebuilt.
3. **Release packaging** (npm tarball file modes, five-platform CI) — not
   verifiable from a Windows checkout.
4. **Performance** — two of the four A/B cases were independently re-run with a
   different harness; loopback variance is large (see §5).
5. The design's "no literal colours" rule is enforced for `src/client`; the
   generated preview theme intentionally contains host hex tokens and is not
   product code.

## 7. Reproduce

```bash
# builds (sandbox-safe equivalents of scripts/build.mjs / build-kernel.mjs)
bash scripts/dev-build.sh all
bash scripts/dev-build.sh kernel
node --check lib/client.js
./node_modules/.bin/tsc --noEmit

# kernel
cd kernel && cargo test --all-targets && cargo fmt --check && cd ..
python tests/verify_e2e.py --kernel bin/win32-x64/rdm-kernel.exe
python tests/verify_extra.py            # independent cases (verifier-authored)
python tests/verify_claims.py           # redaction/preflight/flat-notification
node scripts/verify-fixture.mjs

# host / client
node tests/tools-receipts.test.mjs
node .design/preview-02/verify-contrast.mjs
bash .design/preview-02/build.sh        # preview harness; screenshots in .design/preview-02/shots

# perf study (needs rustc for the native origin)
rustc -O -o tests/.tmp-e2e/perf-origin.exe tests/perf-origin.rs
python tests/bench_native.py --old <pristine-0.1.2-kernel> \
  --new kernel/target/release/rdm-kernel.exe --origin tests/.tmp-e2e/perf-origin.exe
```

## 0.3.0-alpha.1 — multi-source acceptance (2026-11-09)

Gate run on the final artifacts (Windows 11 x64, rustc 1.99.1, Node 24.19.0):

| # | Check | Result |
|---|---|---|
| 1 | cargo test --all-targets | **157/157** (lib 78, engine 15, protocol 5, unit 17, v022 13, v030 21, multi_source 8) |
| 2 | python tests/verify_e2e.py | **205/205** |
| 3 | python tests/verify_extra.py / verify_claims.py | **56/56** / **15/15** |
| 4 | node tests/kernel-e2e.mjs (incl. multi-source select scenario) | **PASS** |
| 5 | node tests/tools-receipts.test.mjs | **PASS 50 checks** |
| 6 | node scripts/verify-fixture.mjs / verify-kernels.mjs --host --run | **64/64** / **PASS** (win32-x64 5.35 MB) |
| 7 | node scripts/check-release.mjs | **PASS** (package = kernel = 0.3.0-alpha.1) |
| 8 | npx tsc --noEmit -p tsconfig.json | **clean** |

Multi-source behavior is covered by the kernel multi_source suite (explicit selection, failover, unproven-identity refusal, 2-source race, slow-source exclusion, hedged first range, Metalink/HTTP Link discovery, .meta4 resolution and SHA-256). Intermediate versions 0.2.3–0.2.6 are recorded in the CHANGELOG stage table; the accepted artifact is the 0.3.0-alpha.1 pre-release.

A real-network benchmark (Alpine 3.20.3 ISO, 209 MiB) measured `select` at **11.41×** the single official CDN and matched the best manual mirror; the opt-in `race` policy was ~1.00× of the best single mirror on that link. See [session_logs/20261109-multisource/README.md](../session_logs/20261109-multisource/README.md).
