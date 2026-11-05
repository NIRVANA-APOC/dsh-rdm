# dsh-rdm — verification report

Measured verification of the `dsh-rdm` plugin: the resident Rust download
kernel (`bin/win32-x64/rdm-kernel.exe`) driven over its documented NDJSON
protocol ([PROTOCOL.md](../PROTOCOL.md)), the live plugin path through the
installed DSH plugin, measured size/resource/throughput numbers, and static
sanity of the built plugin bundles.

* Host: Windows x64 only for the 0.1.0 run below. **2026-11-05 refresh:** the
  0.1.1 prebuilt kernel set covers `linux-x64`, `linux-arm64`, `win32-x64`,
  `darwin-x64` and `darwin-arm64`, built on native CI runners and committed
  under `bin/`; Linux x64 is e2e-verified and the others are smoke-tested by
  their build runner. See §7.
* Status legend: `PASS` = observed and asserted by the harness; `FAIL` =
  observed and not meeting the stated criterion; `NOT VERIFIED` = explicitly out
  of scope / no evidence, never claimed as success.

**Final verdict (2026-11-03, shipped build): `verify: PASS`** — 14/14 kernel e2e
scenarios, 241/241 assertions, 7/7 measurements, fixture self-test 64/64; kernel
binary sha256
`5ad09db39c3f8075eb5eaa1f22f69e25167ca55e484d9dcdf85d28de697b3d2d`; live
`rdm_*` agent-tool path independently exercised through the installed plugin.
Items **not** verified are listed explicitly in §5.

## 1. How to reproduce

Run everything from the package directory:

```powershell
cd dsh-rdm

# 0) fixture self-test (no kernel binary needed): 64 checks
node scripts/verify-fixture.mjs

# 1) full verification: 14 kernel e2e scenarios + measurements
#    exit 0 = pass, 1 = failures, 2 = kernel binary missing
node scripts/verify-kernel.mjs

# machine-readable report + log
node scripts/verify-kernel.mjs --json="%TEMP%\dsh-rdm-verify-report.json"

# useful partial runs
node scripts/verify-kernel.mjs --list
node scripts/verify-kernel.mjs --only=pause --no-measure
node scripts/verify-kernel.mjs --allow-missing-artifacts   # e2e only, bundles optional
```

`npm run verify` in `package.json` invokes `node scripts/verify-kernel.mjs`.

Harness files: [`tests/fixture-server.mjs`](../tests/fixture-server.mjs),
[`tests/kernel-client.mjs`](../tests/kernel-client.mjs),
[`tests/kernel-e2e.mjs`](../tests/kernel-e2e.mjs),
[`tests/measure.mjs`](../tests/measure.mjs),
[`scripts/verify-fixture.mjs`](../scripts/verify-fixture.mjs),
[`scripts/verify-kernel.mjs`](../scripts/verify-kernel.mjs).

## 2. Environment

| item | value |
|---|---|
| OS | Windows (`win32` 10.0.26300), x64 |
| Node.js | v24.19.0 |
| npm | 11.17.0 |
| Rust | rustc 1.99.1 (58cf8f9c3 2026-10-13), cargo 1.99.1 |
| package | `dsh-rdm` 0.1.0 (`kernel` crate 1.0.0) |
| kernel binary | `bin/win32-x64/rdm-kernel.exe`, 4,600,320 bytes (4.39 MiB), sha256 `5ad09db39c3f8075eb5eaa1f22f69e25167ca55e484d9dcdf85d28de697b3d2d` |
| DSH version exercised | 0.2.1-rc.5 |
| network under test | loopback HTTP fixture server on a random `127.0.0.1` port (no real internet) |

### Sandboxed hosts and the data directory

On hosts that confine child-process writes, the kernel process can be denied
creation of `<data-dir>/tasks` (`ACCESS_DENIED`, `os error 5`) outside the
session workspace. This is an environment write policy, not a kernel defect: the
same binary succeeds with a workspace-owned data dir, and a trivial Rust
`std::fs::create_dir_all` probe shows the same location-dependent behaviour.

The test harness therefore keeps all kernel data dirs and download dirs under a
workspace-owned root, `tests/.tmp-e2e/` (override with
`DSH_RDM_TEST_TMP_ROOT`), and removes it after each run. The installed plugin has
the same protection: when no `dataDir` is configured and the kernel fails on a
data-dir I/O error, the host side retries once with
`<plugin packageRoot>/.rdm-data` and defaults download destinations to
`<dataDir>/downloads`.

## 3. E2E results

Final acceptance run against the shipped binary above: **14/14 scenarios passed,
241/241 assertions passed, e2e time 103.6 s; measurements 7/7 passed;
`verify: PASS` (exit code 0).**

Fixture server self-test: **64/64 checks passed** (`node scripts/verify-fixture.mjs`).

| # | scenario | what the assertions prove | checks | time |
|---|---|---|---|---|
| 1 | lifecycle: ready / initialize / stats | one valid `ready` notification with `protocol:1`, version, pid, dataDir; stdout is protocol-only JSON; `initialize` echoes clamped config; later `initialize` updates new-task defaults; `stats` shape/counts/totals/config | 30/30 | 18 ms |
| 2 | probe: ranged / no-range / redirect / chunked metadata | `probe` returns file name, `totalBytes`, `supportsRanges`, `contentType`, `finalUrl`; ranged probe issues **no GET** (HEAD only); no-range reports `supportsRanges:false`; 2-hop redirect `finalUrl` differs from requested and is the final ranged URL; chunked origin reports `totalBytes:null`; a full download through the redirect chain completes byte-exact | 29/29 | 87 ms |
| 3 | download: full ranged transfer | `completed`; `downloaded == total == 2 MiB`; file sha256 equals fixture digest; target path in requested dir; no `.part`/`.part.json` leftovers; task notifications observed incl. `completed`; `get` returns events (bounded, monotonic, known kinds); `list` includes task and honours `status`/`limit` | 30/30 | 79 ms |
| 4 | multi-connection: 12 MiB, connections=8 + singleStream | fixture recorded 32 range GETs with **max overlap 8**; kernel `peakWorkers > 1` (observed 8); byte-exact; `singleStream:true` issues **exactly one rangeless GET** (200, no `Range` header) with `chunkSize:null` | 27/27 | 254 ms |
| 5 | no-range fallback | `rangeSupported:false`; completes byte-exact through a single rangeless stream (exactly one rangeless GET, no 206) | 14/14 | 74 ms |
| 6 | retry: 429 + Retry-After | first two range GETs answered `429` + `Retry-After: 1`; task completes with `retries:2` and elapsed ≈ 2.0 s (Retry-After honoured), bytes exact | 11/11 | 2.1 s |
| 7 | pause → resume (same kernel) | pause mid-transfer → `paused`; `.part` + `.part.json` retained with data; `.part` is `<target>.part`; resume → `completed`, exact bytes, no leftovers; observed `resumedChunks:4` | 15/15 | 18.1 s |
| 8 | resume across kernel restart | kill kernel child after ≥1 MiB with persisted resume state; new kernel on same `--data-dir` reloads the task as `interrupted`; `control resume` → `completed`, byte-exact, no leftovers | 16/16 | 36.7 s |
| 9 | cancel → retry → remove | cancel → `cancelled`, `.part` retained; `retry` restarts and completes byte-exact; `remove` deletes the record (`get` → `not_found`, gone from list) and **never deletes the completed target file** | 15/15 | 18.5 s |
| 10 | sha256 success + mismatch | `expectedSha256` success sets `task.sha256`, exact bytes; corrupt origin → `failed` with `error.code: "checksum_mismatch"`, `.part` is **not** renamed to the target path | 13/13 | 144 ms |
| 11 | speed limit: 256 KiB/s | completes byte-exact; measured average **234 KiB/s** over 8.76 s (< 2× cap; ≈0.92× cap), i.e. the global cap is enforced | 10/10 | 8.8 s |
| 12 | error codes + stdin EOF | unknown id → `not_found`; `control pause` on completed task → `conflict`; invalid action rejected (`invalid_request`/`conflict`); stdin EOF → kernel exits in **1 ms** (exit code 0) | 10/10 | 91 ms |
| 13 | resume after remote change (ETag flip) | pause mid-transfer, flip origin ETag+bytes, resume: kernel detected the validator change and **transparently restarted**, completing with the new content's sha256 (no stale-byte mix). Accepted outcome: `failed(remote_changed)` or verified restart; observed restart | 9/9 | 18.5 s |
| 14 | unknown-length chunked origin | no `Content-Length`/no ranges → single-stream until EOF; `rangeSupported:false`; `downloaded` = 256 KiB; `total:null`; bytes exact; no 206 | 12/12 | 80 ms |

Total: **241/241 assertions**. The suite runs in ~104 s, well inside the 5-minute
budget.

### Live plugin / agent-tool verification

This part runs through the **installed plugin**, not the direct-kernel harness.
After installing the bundle into a profile, the live surfaces were checked:
`rdm_*` tools + system-prompt section live; `sidebar.panellist` occupant
`{registrant: dsh-rdm, id: rdm, order: 30, active: true}`; `main` occupant
`{dsh-rdm, key rdm, active: true}`; Config schema registered; browser route
envelope set (`list/start/get/control/stats` + bad-request, `no-store`)
exercised in a built-bundle harness.

Live tool pass against a loopback fixture serving a 256 KiB ranged file with
sha256 `618fb5f028437d2b62a19845c0687ae48101a04e465cd0c42c8702668fb6b7f4`:

| step | observed |
|---|---|
| `rdm_probe` | `live-agent-tool.bin · 256 KiB · application/octet-stream · ranges supported` |
| `rdm_download` (`expectedSha256`, `connections:8`, `waitSec:60`) | task `t_f50297955d9829c8` **completed**, `100%`, `256 KiB / 256 KiB`, result rendered `Completed and SHA-256 verified.` |
| `rdm_tasks` (task detail) | kernel `running · v1.0.0`; task completed; events `probe 262144 bytes, ranges=true`, `plan 1 chunks/1 worker/0 resumed`, `started`, `finished in 1 ms`, `verify: hashing file for sha256` |
| independent file hash | sha256 of the downloaded file = `618fb5f0…b6b7f4` (equals fixture digest) |
| live kernel memory | `WorkingSet64` 7.29 MiB / `PeakWorkingSet64` 7.32 MiB with existing tasks |
| `rdm_control remove` (`deletePart:true`) | task removed; gone from `rdm_tasks` and the data dir |

Not verified by QA: browser-route authentication from a shell (the action
envelopes were verified in a built-bundle harness), and visual panel rendering in
a real browser (no browser control in that session).

### PROTOCOL guarantee coverage

| PROTOCOL.md guarantee | evidence in this run |
|---|---|
| NDJSON only on stdout; responses may be out of order; notifications interleave | all stdout lines parsed as JSON objects across the run, 0 malformed lines; request/notification interleaving exercised by every scenario |
| `ready` fields `{protocol,kernel:{version,pid,dataDir}}` | scenario 1 |
| `initialize` defaults + config echo | scenario 1 |
| `probe` never downloads body; range-support proof only for non-ranged origins | scenario 2 (ranged probe: 0 GETs; no-range probe issues only the documented `0-0` proof) |
| `start` returns TaskView immediately, transfer runs in background | scenarios 3–14 |
| Multi-connection: fixed chunks, dynamic worker pool, adaptive concurrency | scenario 4 (32 range GETs, max wire overlap 8, `peakWorkers:8`) |
| Single-stream fallback when ranges unsupported / unknown total | scenarios 5, 14; `singleStream` forced path in scenario 4 |
| Retry/backoff honouring `429` + `Retry-After` | scenario 6 |
| Pause is cooperative; `.part` + `.part.json` persisted; resume continues | scenario 7 |
| Resume survives kernel restart (persisted task records; interrupted → resume) | scenario 8 |
| Validator checks on resume (ETag/Last-Modified/total) | scenario 13 |
| Cancel keeps `.part`; retry restarts; remove deletes record not completed file | scenario 9 |
| `expectedSha256` verified before rename; mismatch → `checksum_mismatch` | scenario 10 |
| Per-task bandwidth cap (`speedLimitBps`) | scenario 11 |
| Error codes `not_found`, `conflict`, `invalid_request` | scenario 12 |
| stdin EOF exits (parent gone) | scenario 12 (1 ms) |
| `control.remove` never deletes completed target | scenario 9 |
| Chunked/unknown-length single-stream completion at EOF | scenario 14 |

## 4. Measurements

Numbers from the final run (single run, machine-specific).

| measurement | value | verdict | method |
|---|---|---|---|
| kernel source LOC | **3224** raw lines in 18 files; 3171 non-blank lines outside `#[cfg(test)]` items | PASS | recursive raw-line count over `kernel/src/**/*.rs`; unit tests live in `kernel/tests/` |
| kernel binary size | 4,600,320 bytes (4.39 MiB), sha256 `5ad09db39c3f8075eb5eaa1f22f69e25167ca55e484d9dcdf85d28de697b3d2d` | PASS | `fs.stat` + SHA-256 of `bin/win32-x64/rdm-kernel.exe` |
| kernel idle resident memory | WorkingSet64 **5.67–6.73 MiB** across runs after `initialize` + 3 s idle (this run 5.67 MiB; earlier run 6.73 MiB; a dev measurement of the same binary reports 5.71 MiB) — single-run variance, all sub-10 MiB | PASS | spawn the real kernel, `powershell -NoProfile -Command "(Get-Process -Id <pid>).WorkingSet64"` / `.PeakWorkingSet64` |
| kernel memory during transfer | WorkingSet after 12 MiB download **8.10–8.13 MiB**; **peak WorkingSet 13.81–14.06 MiB** during the run | PASS (documented) | same PowerShell query right after completion, before shutdown |
| loopback throughput (multi-connection) | **109.1–144.6 MiB/s** for 12 MiB with `connections=8` across runs (this run 144.58 MiB/s, 32 range GETs, max overlap 8, sha256 verified) | PASS | full e2e download from fixture, `elapsedMs` → MiB/s |
| `curl.exe` single-stream reference | **426.85–536.03 MiB/s** (12 MiB full-body GET, no ranges) | PASS (reference) | async `curl.exe -sS -o NUL -w "%{speed_download}" --noproxy '*' -4 <url>`; 12 MiB is too small to isolate Rust/reqwest startup overhead, so curl's single-stream number is higher — the kernel's value is segmented/resumable transfer, not raw single-stream peak |
| plugin host bundle `lib/index.js` | 120,053 bytes; ESM export surface (`export … apply`), **no `require(` calls**, generated banner, `node --check` OK, delimiter counts balanced | PASS | static checks in `tests/measure.mjs` |
| plugin client bundle `lib/client.js` | 87,331 bytes; starts with `window.__ModuleLoader__.load(` wrapper and `id: 'dsh-rdm'`, `node --check` OK, delimiter counts balanced | PASS | static checks in `tests/measure.mjs` |

## 5. What could NOT be verified

* **Visual client UI in a real browser by the kernel harness.** Rendering,
  click-through, locale switching and theme tokens are covered by separate
  browser-capture and DOM-contract work, not by this kernel suite; static bundle
  sanity of `lib/client.js` is reported above.
* **Full Linux/macOS e2e coverage** — the 0.1.0 run documented here was Windows
  x64 only. For 0.1.1, Linux x64 ran the full 14-scenario suite (§7); the macOS
  x64/arm64 and Linux arm64 binaries are only smoke-tested (`--help`) on native
  CI runners, and the Windows binary was rebuilt with MSVC and smoke-tested
  there too. The suite has not been executed on macOS or on any arm64 host.
* **HTTPS/TLS** (valid, invalid/`insecure`, SNI), **HTTP proxy** (`proxy`), custom
  **headers/cookie/referer/userAgent**, HTTP redirect auth semantics, HTTP/2,
  mirrors, and per-origin budget learning are not covered by this suite (the
  fixture is plain HTTP/1.1 loopback).
* **Adversarial origin behaviour**: multipart `Range` responses are rejected by
  the fixture for the ranged route, but an origin returning `200` to a `Range`
  request mid-download, mismatched `Content-Range`, truncated bodies and
  connection-reset storms are not fuzzed; only the covered modes are asserted.
* **Local I/O failure paths** (disk full, permission errors, path length,
  file-name sanitization edge cases, unicode names) are not covered.
* **Network failure paths** (DNS failure, connect timeout, TLS error, body
  timeout) are not exercised; fixture failures are limited to `429`/`Retry-After`
  and an ETag change.
* **Pause during real network jitter / mid-chunk abort semantics** are
  approximated by a trickling fixture; timing-sensitive race windows (pause
  exactly at chunk boundary, kill exactly during `.part.json` write) are sampled,
  not exhaustively tested.
* **Speed-limit measurement is an average** over a 2 MiB transfer; burst
  behaviour and many-concurrent-worker fairness are not characterised.
* **Memory/throughput numbers are single-run and machine-specific**; Windows
  WorkingSet64 includes shared pages and varies between runs.
* **Kernel unit/integration tests** (`cargo test` in `kernel/`) report
  `cargo test --release --no-fail-fast` = 27 passed / 0 failed and
  `cargo fmt --all --check` passing; this harness does not run cargo itself.

## 6. Notes

* The kernel surfaces the documented `remote_changed` error code for some
  validator changes, but on the ETag-flip scenario it transparently restarted and
  completed with the new content (verified byte-exact). Both outcomes are safe for
  users; the harness accepts either and records which happened.
* Sandboxed-host data-dir behaviour is described in §2; it is a host environment
  limitation, not kernel behaviour.

## 7. Prebuilt kernel refresh (2026-11-05, dsh-rdm 0.1.1 / kernel 1.0.1)

A Linux x64 e2e run of the 0.1.1 kernel surfaced one real defect that the
Windows 0.1.0 run had not caught, and it was fixed before this refresh:

* **Defect:** `tokio::fs::File` buffers up to 2 MiB of writes internally and
  only spawns the blocking write; dropping the handle does not wait for it. The
  single-stream path could therefore reach `finalize()` while the `.part` inode
  was still short, failing a healthy download with `remote_changed: file size
  425984 does not match advertised 524288` (reproduced deterministically as
  scenario 4 of the suite; a retry could also truncate over a stale write).
* **Fix:** `kernel/src/engine/single.rs` flushes the response file before
  returning and propagates write errors; `kernel/src/engine/chunked.rs` flushes
  when its workers exit (commit `109e7d8`).
* **Verification after the fix:** full suite on the local Linux x64 build —
  14/14 scenarios, 241/241 checks, run twice; full suite on the CI-built
  `linux-x64` binary — 14/14 scenarios, 241/241 checks; `cargo test --release`
  27 passed / 0 failed across the crate; `cargo fmt --all --check` passing.

Prebuilt kernels were produced by GitHub Actions workflow run
[41987197780](https://github.com/NIRVANA-APOC/dsh-rdm/actions/runs/41987197780)
(all `Build *` jobs, `Assemble plugin package` and `Commit kernels into bin/`
succeeded; the release job is tag-only and was skipped on this manual run),
built from commit `d1cbed7` on native runners and committed by CI as `9109739`:

| target | built on | size (bytes) | sha256 |
|---|---|---|---|
| `bin/linux-x64/rdm-kernel` | `ubuntu-24.04` | 4,863,920 | `321a9d446396e88aaad5c3cd4976677c9ffe9c1571ff07a587290e155ffed091` |
| `bin/linux-arm64/rdm-kernel` | `ubuntu-24.04-arm` | 4,404,112 | `76432ed43a6ee2aaa404d42f8b149da1ee7130abe8f879c0af21375a26c9d2bd` |
| `bin/win32-x64/rdm-kernel.exe` | `windows-latest` (MSVC) | 5,328,384 | `40d750d4b154b2ee1ad3793092545e8e90baac8d7297e637fb4880c22fdd11f9` |
| `bin/darwin-x64/rdm-kernel` | `macos-15-intel` | 4,498,496 | `3dc3ac8fac05e0d20d7bc228117a7a802487714039bc1558a3f2744c1281c0df` |
| `bin/darwin-arm64/rdm-kernel` | `macos-15` (arm64) | 4,227,600 | `3661c6d54a27f056e99fde359d78e4b6262a5e36048941928de772f74689577c` |

`node scripts/verify-kernels.mjs` passes 5/5 on the committed tree: every file
exists, matches its target executable format (ELF / PE / Mach-O), keeps the
POSIX executable bit, and reports the SHA-256 above; each CI build also starts
its own binary (`--help`) natively. `npm pack` of the committed tree produces
`dsh-rdm-0.1.1.tgz` (11,092,948 bytes) containing `lib/` plus all five kernel
directories, with `755` modes preserved for the Unix binaries.

**Not verified on the other hosts:** the macOS x64/arm64 and Linux arm64
binaries only receive the native `--help` smoke test (no e2e suite there), and
the Windows 0.1.1 MSVC binary replaces the 0.1.0 MinGW binary that passed the
Windows 14/14 run; both are the same crate source, but the toolchains differ.
