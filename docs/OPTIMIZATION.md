# dsh-rdm — optimization study

This document records a measurement-driven optimization pass over the resident
download kernel: what was measured, what was changed, what it bought, and what
was deliberately left alone. Numbers in §1–9 come from a reproducible harness
([`tests/perf.mjs`](../tests/perf.mjs)); the scenario/behaviour side is covered by
[verification.md](verification.md). §10 and §11 are different by design: they
record **real-world** evidence passes whose sources are exported session logs and
live recordings, not a loopback benchmark — §10 is the 0.2.1 pass over the
2026-11-08/09 export, §11 is the 0.2.2 live ModelScope pass.

Host used for all measurements: Windows 11 (10.0.26300) x64, Node v24.19.0,
rustc 1.99.1 (x86_64-pc-windows-gnu), local SSD, loopback origin. Numbers are
machine-specific; the *ratios* and the phase decomposition are what generalize.

## 1. Summary

| Change | Effect (measured) |
|---|---|
| `wait` uses task status notifications instead of a 50 ms poll | 1 MiB download end-to-end **65 ms → 4.4 ms** (≈15x), 10 MiB **57.7 ms → 14.5 ms** |
| No `fsync` of the finished file unless `fsyncOnComplete` is set | finalize phase **23 ms → 1 ms** per 64 MiB (≈9 ms → 1 ms at 10 MiB) |
| 1 MiB per-worker write buffer (was 256 KiB) | time spent inside file writes **63 ms → 16 ms** per 64 MiB |
| tokio worker threads `min(4, cores)` (was fixed 2) | 64 MiB, 8 connections: transfer **59 ms → 41 ms** (peak 1.49 GiB/s) |
| Automatic chunk sizing is the config default (was a fixed 4 MiB) | 10 MiB download transfer **28 ms → 7-16 ms**; 64 MiB **666 → 1488 MiB/s** |
| Resume state: incremental merged ranges, no fsync on periodic saves | removes O(n log n) + fsync from every 500 ms save; matters for 10k+ chunk files |
| Task-record persistence coalesced to 1 s (status changes still immediate), compact JSON | removes ~4 file writes/s per active task |
| Pause/cancel via `Notify` instead of 10 ms polling | no timer wakeups during transfer; pause latency is immediate |

End-to-end, on the same origin and payload:

| payload (8 conns) | before | after | speed-up |
|---|---|---|---|
| 1 MiB | 65.3 ms wall | 4.4 ms wall | **14.8x** |
| 10 MiB | 57.7 ms wall | 14.5 ms wall | **4.0x** |
| 64 MiB | 113.9 ms wall (771 MiB/s) | 44.5 ms wall (1488 MiB/s) | **2.6x** |
| 64 MiB, single stream | 108.3 ms | 90.4 ms | 1.2x |
| idle CPU / RSS | 0 ms / 3 s, 6.39 MiB | 0 ms / 3 s, 6.42 MiB | unchanged |

Loopback runs vary by 15-25 % between sessions (page cache, AV, scheduler); the
64 MiB multi-connection result ranged 1049-1488 MiB/s for the new build and
667-771 MiB/s for the old one across sessions, so the comparison holds at the
low end too.

## 2. Method

Two origins are used because they answer different questions.

* **Native range origin** (`tests/perf-origin.rs`, ~120 lines of dependency-free
  Rust): serves a preallocated pattern buffer, single-range `206` responses,
  keep-alive, no artificial delay. This removes the Node fixture's event loop
  from the measurement, which otherwise caps range-heavy runs near 1 GiB/s and
  hides kernel-side effects.
* **Node fixture** (`tests/fixture-server.mjs`): the behavioural fixture used by
  the e2e suite (delays, redirects, flaky origin, ETag flips). Used for
  end-to-end checks, not for peak throughput.

`tests/perf.mjs` runs a parameter matrix (connections, chunk size, single
stream) against either origin and records, per run:

* wall time (`start` request → terminal state) and the kernel-reported
  `elapsedMs`;
* **phase decomposition** from task event timestamps: `probe` (IPC + probe),
  `transfer` (`started` → `finished in …`), `finalize` (`finished` → terminal);
* kernel process CPU time (delta of `TotalProcessorTime`, Windows 16 ms clock);
* range-request count / overlap when the fixture is in use;
* byte-exactness (SHA-256 for the fixture, size for the native origin).

Baselines in the same harness: `curl` single-stream to `NUL` (loopback + server,
no disk), `curl` single-stream to a real file (adds the write), N parallel
`curl` range requests, a Node client, and a raw `write+fsync` of the same
payload. A/B runs swap only the kernel binary: the pristine binary is built from
`HEAD` in a detached worktree, the new one from the working tree.

Caveats that shaped the conclusions:

* CPU time on Windows is quantized to ~15.6 ms, so single-run CPU deltas below
  ~30 ms are noise. Throughput conclusions use 3-5 runs and medians.
* Run-to-run variance on loopback is ±15-25 % (page cache, Defender, scheduler).
  Differences below ~20 % are treated as “no change”.
* The fixture's `rangedDelayMs` default is 2 ms; benchmarks pass `0` unless the
  delay is the variable under test.

## 3. Where the time went (baseline)

64 MiB, 8 connections, native origin, pristine `HEAD` kernel:

```
probe  4 ms | transfer 59 ms | finalize 23 ms  → wall 114 ms
```

The transfer itself was 771 MiB/s while `curl` single-stream to `NUL` measured
~950 MiB/s, so the ceiling was not the origin. Instrumenting the hot loop (time
inside `response.chunk()` vs inside `file.write_all`) gave the split:

| build (64 MiB, 8 conns) | transfer | of which read wait (sum over workers) | of which write (sum) |
|---|---|---|---|
| disk, 256 KiB buffer | 63 ms | 198 ms | **63 ms** |
| disk, 1 MiB buffer | 69 ms | 256 ms | **16 ms** |
| sink (no file writes) | 52 ms | 273 ms | 0 |

Two independent costs were visible:

1. **Write dispatch.** 64 MiB / 256 KiB = 256 `spawn_blocking` hand-offs, each
   copying the buffer into the blocking closure. 63 ms of the transfer was spent
   awaiting them (≈246 µs per write; a raw `std::fs::write` of the same size is
   ~70 µs). Raising the buffer to 1 MiB cut that to 16 ms. 4 MiB buffers were
   *worse* (27-45 ms): fewer, larger copies plus more memory per worker.
2. **CPU saturation.** Even with writes removed, 64 MiB cost ~94 ms of process
   CPU (1.47 ms/MiB) while the wall clock was 52 ms — with only two runtime
   threads the process was already >1 core busy. Raising the runtime to four
   threads moved the same sink run from 1123 to 1600 MiB/s.

The remaining latency was outside the transfer loop: a 1 MiB download showed
`probe 3 + transfer 2 + finalize 11 = 16 ms` but 65 ms wall. The missing ~49 ms
was `kernel wait` polling the task table every 50 ms, so a terminal task was
reported up to one poll interval late — the single largest user-visible cost for
small downloads.

## 4. Changes

### 4.1 `wait` wakes on status transitions

`Kernel::wait` used `sleep(min(remaining, 50ms))` and re-read every task. The
kernel already had a `watch` channel per task; a kernel-wide `Notify` is now
signalled from `Task::set_status`. `wait` registers with `Notify::notified()`
before re-checking, so a transition between check and await cannot be missed,
and still falls back to the timeout.

Result: 1 MiB wall 65 ms → 4.4 ms; 10 MiB 57.7 ms → 14.5 ms. This also fixes
`rdm_download { waitSec }` and `rdm_wait`, which both ride on `wait`.

### 4.2 Completion fsync is opt-in

`finalize()` called `sync_all()` on every finished file before the rename. That
cost 23 ms per 64 MiB and ~9-11 ms per 10 MiB — often more than the transfer of a
small file. It only protects against OS/power loss: a process crash keeps the
page cache, and the rename is already atomic w.r.t. other processes.

New default: no fsync. `fsyncOnComplete: true` (plugin config → `initialize`)
restores the old behaviour for archival workloads. Resume-state writes keep the
opposite policy: periodic saves skip fsync, while pause/stop/final saves fsync,
because that state is what a crash actually resumes from.

### 4.3 Write path: 1 MiB buffers sized from the chunk

`WRITE_BUFFER_BYTES` is 1 MiB and per-claim buffers are `chunk_size / 4` clamped
to [256 KiB, 1 MiB], so a 256 KiB chunk does not allocate a megabyte per worker.
Worst case at the 32-connection cap is 32 MiB of write buffers; the default
8-connection profile uses 8 MiB.

### 4.4 Runtime threads scale with the host

`worker_threads` was hard-coded to 2. It is now `min(4, available_parallelism)`
with a floor of 2 (`RDM_WORKER_THREADS` overrides it for tests). Idle cost is
unchanged (threads park; measured 0 ms CPU over 3 s), and RSS moved by <0.1 MiB.

### 4.5 Automatic chunk sizing becomes the default

The plugin default was a fixed `chunkSizeMiB: 4`. For a 10 MiB file that yields
three ranges, so five of the eight configured connections never start:

| 10 MiB, 8 conns | transfer |
|---|---|
| fixed 4 MiB chunks | 28 ms |
| fixed 1 MiB chunks | 14 ms |
| auto (4 chunks/conn = 320 KiB) | 16 ms |

The default is now `0` (auto), which keeps four chunks per connection and thus
always engages the pool, with the automatic size bounded to 256 KiB..8 MiB (the
previous upper bound was 4 MiB, which doubled the state file and request count of
multi-gigabyte transfers). The kernel keeps accepting explicit sizes unchanged.

### 4.6 Resume state and task records

Two I/O paths ran far more often than their value warranted:

* **Resume state** (`.part.json`) was re-merged from an unsorted `Vec` on every
  save (O(n log n) every 500 ms) and fsynced each time. Completed ranges are now
  inserted into a sorted, merged list incrementally (common case is an append),
  and periodic saves skip the fsync.
* **Task records** (`tasks/<id>.json`) were rewritten as pretty JSON whenever
  the dirty flag was set — i.e. every progress tick, four times a second per
  active task. They are now compact JSON, written at most once per second, with
  status changes still flushed immediately (a crash must not lose lifecycle
  transitions) and an explicit persist on start/finish/control.

### 4.7 Cancellation is event-driven

`Control::wait_stopped()` slept 10 ms in a loop and was polled from every
`select!` arm in the transfer loops: with 8-32 workers that is a steady stream of
timer wakeups, and pause latency was up to 10 ms. `Control` now carries a
`Notify`; `pause`/`cancel` signal it, `sleep` selects between the deadline and
the notification. Pause now takes effect at the next await point.

## 5. A/B results

Pristine `HEAD` binary vs optimized binary, same origin, same matrix, 3 runs,
median of the phase decomposition:

### 64 MiB

| config | before | after |
|---|---|---|
| auto, 8 conns | 771 MiB/s · transfer 59 ms · finalize 23 ms · wall 114 ms | **1488 MiB/s** · transfer 41 ms · finalize **1 ms** · wall **44.5 ms** |
| fixed 4 MiB, 8 conns | 667 MiB/s · transfer 66 ms · finalize 29 ms | 1255 MiB/s · transfer 50 ms · finalize 1 ms |
| auto, 1 conn | 376 MiB/s · transfer 140 ms | 520 MiB/s · transfer 121 ms |
| single stream | 634 MiB/s · wall 108 ms | 727 MiB/s · wall 90 ms |

### 10 MiB

| config | before | after |
|---|---|---|
| auto, 8 conns | 500 MiB/s · transfer 9 ms · finalize 9 ms · wall 57.7 ms | 833 MiB/s · transfer 7 ms · finalize 1 ms · wall **14.5 ms** |
| fixed 4 MiB, 8 conns | 476 MiB/s · transfer 11 ms · wall 57.4 ms | 588 MiB/s · transfer 16 ms · wall 19.4 ms |
| auto, 1 conn | 233 MiB/s · wall 64.5 ms | 455 MiB/s · wall 23.7 ms |
| single stream | 270 MiB/s · wall 57.5 ms | 667 MiB/s · wall 16.4 ms |

### 1 MiB (fixed overheads dominate)

| config | before | after |
|---|---|---|
| auto, 8 conns | — | 333 MiB/s · wall 4.9 ms |
| fixed 4 MiB, 8 conns | 76.9 MiB/s · wall 65.3 ms (finalize 11 ms) | 333 MiB/s · wall 4.4 ms |
| auto, 1 conn | 100 MiB/s · wall 55.9 ms | 333 MiB/s · wall 5.0 ms |
| single stream | 90.9 MiB/s · wall 55.7 ms | 250 MiB/s · wall 5.6 ms |

The baseline wall times here are ~50 ms larger than their phase sums: that is
the removed `wait` poll, now the dominant small-file cost is the probe round trip
and process/IPC hand-off (~3 ms).

### Resource cost (verification harness, 12 MiB transfer, Node fixture)

| metric | before (verification.md) | after |
|---|---|---|
| idle RSS after initialize | 5.67-6.73 MiB | 6.43 MiB |
| RSS after a 12 MiB transfer | 8.10-8.13 MiB | 9.21 MiB |
| peak RSS during transfer | 13.81-14.06 MiB | 14.78 MiB |
| 12 MiB, 8 conns | 109-145 MiB/s | 206.9 MiB/s |
| kernel binary | 4.60 MB | 4.60 MB |

The +1.1 MiB peak is the 1 MiB write buffers (8 workers) and is bounded by
design; idle RSS is unchanged.

## 6. Ideas examined and rejected (for now)

| idea | why not |
|---|---|
| HTTP/2 multiplexing for ranges over one connection | all ranges share one TCP flow-control window, so a slow/queued range blocks the others; HTTP/1.1 connection-per-range is the point of the design |
| `sendfile`/`splice` zero-copy | data arrives from TLS/HTTP framing and must be written at arbitrary offsets; zero-copy does not apply to a decrypted, segmented stream |
| `mmap` the `.part` file and write into it | page-fault churn and no gain over `write_all` for sequential ranges; complicates length changes on resume |
| dedicated writer thread per task instead of `spawn_blocking` | would remove the remaining ~16 ms/64 MiB of dispatch cost, but adds a thread, a queue and cancellation ordering; the 1 MiB buffer already captures most of the win |
| 4 MiB write buffers | measured *worse* (27-45 ms vs 16 ms) and 4x the memory per worker |
| hashing during the transfer | only possible for single-stream; chunked ranges arrive out of order and SHA-256 is not composable |
| binary resume state | the JSON state for a 100 GiB / 8 MiB-chunk transfer is ~300 KB; a binary format is a protocol/versioning cost for a once-per-second write |
| SSE/long-poll for the panel instead of 1 s `list` | the poll costs ~0.3-1 ms of host CPU and one RPC; the panel is hidden-tab aware and idle CPU measured 0 ms/3 s |
| BDP-derived chunk size (throughput × RTT) | promising next step, but needs a per-host latency estimator and interacts with tail stealing; auto mode already bounds request count |

## 7. Follow-up roadmap

**P1 — large-file scaling (needs a 100 GiB fixture to measure)**

1. Adaptive save cadence: when merged ranges exceed ~4k, save every 2 s instead
   of 500 ms (bounded write amplification: state ≈ 40 bytes/chunk).
2. Optional compact/binary resume state behind a version bump.

**P1 — transfer efficiency**

3. Per-connection read/write overlap: the hot loop currently awaits a write
   before reading the next chunk (read wait + write time are additive per
   worker). A single-slot double buffer would overlap them; expected a few
   percent on fast links, more on high-latency ones.
4. BDP-derived initial chunk size, refined by the measured rate of the first
   connection, keeping tail stealing for fairness.

**P2 — product surface**

5. `rdm_probe` reuse: cache `Accept-Ranges`/length per host for a few minutes to
   skip the HEAD on repeated downloads from the same origin (validators still
   decide resume compatibility).
6. Panel: batch `control` responses into the poll payload instead of a follow-up
   `get`, so a pause click costs one round trip.
7. Support `If-Range` for `Last-Modified`-only origins (currently ETag only).

## 8. Verification

```
cargo test --manifest-path kernel/Cargo.toml        # 12 + 3 + 13 tests
node scripts/build.mjs                              # lib/index.js + lib/client.js
node scripts/verify-kernel.mjs \
  --kernel kernel/target/release/rdm-kernel.exe     # 14/14 scenarios, 241/241 checks, 7/7 measurements
```

New unit coverage added for the changed invariants:

* `chunk_plan_geometry` — auto sizing (four chunks per connection, 256 KiB floor,
  8 MiB cap, explicit sizes untouched).
* `scheduler_merges_completed_ranges_incrementally` — out-of-order completion
  still yields sorted, merged ranges and a correct `done_bytes`.

Reproduce the performance numbers:

```
cargo build --release --manifest-path kernel/Cargo.toml
mkdir -p tests/.tmp-e2e
rustc -O -o tests/.tmp-e2e/perf-origin.exe tests/perf-origin.rs   # study-only native origin
node tests/perf.mjs --kernel kernel/target/release/rdm-kernel.exe \
  --origin tests/.tmp-e2e/perf-origin.exe --size 64 --runs 3 --out tests/.bench/result.json
```

`tests/perf.mjs --help` lists the options; `--matrix file.json` runs a custom
`{id, connections, chunkSizeBytes, singleStream}` matrix, `--no-baselines` skips
the curl/disk baselines when only the kernel is being compared.

The plugin loads `bin/<platform>-<arch>/rdm-kernel[.exe]`, which CI regenerates
with `.github/workflows/prebuilt-kernels.yml`; run `node scripts/build-kernel.mjs`
for a local host build before trying these changes through the installed plugin.

## 9. 0.2.0 pass — agent-facing information without a transfer regression

0.2.0 adds per-task server facts, four telemetry windows, session attribution,
credential redaction and a richer probe. The measured question for this pass:
**does the extra information cost transfer throughput?**

### Method

* Native range origin (`tests/perf-origin.rs`, keep-alive, no artificial delay),
  started per payload size with `--size` and a fresh kernel data dir per run.
* **Old** = pristine 0.1.2 kernel binary built from `HEAD`
  (`git show HEAD:bin/<host>/rdm-kernel[.exe]`), **New** = 0.2.0 kernel.
* `tests/bench_native.py` drives both kernels over NDJSON and alternates the
  order per round; reported value is the median of `start` request → terminal
  `wait` return, plus the kernel's own event phase marks (`probe`→`plan`→
  `started`→`completed`).
* Windows 11 x64, loopback, 10/8/5/3 rounds for 1/10/64/64-single MiB. Loopback
  variance is ±15-25 %; differences below ~20 % are treated as "no change".

### Results (medians of two runs, host load varies)

Two full runs on the same host at different system load; each value is
`old / new` wall time with the transfer phase in parentheses. The second run ran
while other verification work was active, which is why both sides rise together.

| payload · connections | run A wall (transfer) | run B wall (transfer) | probe phase (old/new) |
|---|---|---|---|
| 1 MiB · 8 | 6.1 / 6.5 ms (2.0 / 2.5) | 12.1 / 12.7 ms (7.5 / 8.5) | ~2 / 3 ms |
| 10 MiB · 8 | 16.0 / 12.2 ms (12 / 8) | 19.8 / 13.3 ms (16 / 8.5) | 3 / 3 ms |
| 64 MiB · 8 | 55.4 / 53.0 ms (51 / 49) | 55.2 / 58.3 ms (51 / 53) | 3 / 3 ms |
| 64 MiB · 1 | 134.0 / 131.6 ms (130 / 127) | 143.9 / 144.6 ms (116 / 140) | ~3 ms (one 26 ms old outlier) |

Read this as **parity**: every difference is inside the ±15–25 % loopback
variance, and both sides move together with host load. The 10 MiB case was
faster in both runs but is not claimed as a speed-up. The agent-facing layer
costs no measurable transfer throughput at these sizes.

### What the richer probe costs

0.2.0 proves range support with one 64-byte ranged `GET` after the `HEAD`
(a `HEAD` cannot prove ranges: origins advertise `Accept-Ranges: bytes` and still
answer `200` to a range request), so the probe phase gains ~1 ms on the native
origin. The sample is deliberately 64 bytes; `timing.sampleBps` is suppressed
below 64 KiB because a 64-byte sample cannot measure throughput. On the Node
fixture the same proof appears ~14 ms slower, but that fixture injects its own
ranged response delay and Node scheduling — a fixture artifact, not kernel cost.

### Regression found and fixed in this pass

The first A/B run showed 1 MiB wall 6.6 → 12.3 ms. Phase data localised it to
`finish()`: the terminal transition awaited the origin-ledger write+rename
before setting the terminal status. The ledger is advisory history, so the save
now runs on a spawned, coalescing writer (`AtomicBool` gate + `save_lock`) while
the in-memory record is still updated before the status transition and shutdown
still flushes. After the change the same case measured 6.1 → 6.5 ms. This is the
kind of cost the window/phase decomposition exists to catch.

### Coverage added alongside

* Kernel: 80 `cargo test --all-targets` checks (protocol shapes, telemetry
  windows/trend/ETA confidence, TLS DER validity, signed URLs, resume safety,
  origin coalescing, redaction, 0.1.x record compatibility).
* Protocol: `python tests/verify_e2e.py` — 55 checks against the real binary
  (probe facts, redirects, signed-URL expiry, session filters, telemetry,
  pause/resume, aggregate/stats, checksums).
* Host: `node tests/tools-receipts.test.mjs` — 31 checks (receipt contract,
  policy-once, schema cost, recoverable failures, auth-input leakage).

Reproduce the A/B numbers:

```
rustc -O -o tests/.tmp-e2e/perf-origin.exe tests/perf-origin.rs
git show HEAD:bin/<host>/rdm-kernel[.exe] > tests/.tmp-e2e/old-kernel[.exe]
cargo build --release --manifest-path kernel/Cargo.toml
python tests/bench_native.py \
  --old tests/.tmp-e2e/old-kernel.exe \
  --new kernel/target/release/rdm-kernel.exe \
  --origin tests/.tmp-e2e/perf-origin.exe \
  --out tests/.bench/native-0.2.0.json
```

## 10. 0.2.1 — real-data pass (2026-11-09)

Every previous section measured a **loopback** origin, which is excellent for
CPU/write-path/IPC costs and blind to WAN behavior. 0.2.1 is the first pass driven
by a real download session. The evidence is checked in under
[`session_logs/20261108/`](../session_logs/20261108/):

| file | contents |
|---|---|
| [`tasks.json`](../session_logs/20261108/tasks.json) | four live task records (one cancelled) + same-day Hugging Face baseline |
| [`events.csv`](../session_logs/20261108/events.csv) | kernel event stream (`probe`/`plan`/`started`/`controller`/`verify`/`completed`/`cancelled`) |
| [`telemetry-observed.csv`](../session_logs/20261108/telemetry-observed.csv) | the only instantaneous series — **sampled by hand** in the agent session |
| [`README.md`](../session_logs/20261108/README.md) | the session's own analysis and priority list |

Export: 2026-11-09 00:40 (+08:00), RDM kernel 1.1.0, pid 49308, ModelScope CDN
(`cdn-lfs-cn-1`), four tasks: a 37.1 GiB two-part model (10.8 GiB cancelled, then
restarted), its 26.4 GiB second part (completed), and a 866 MiB mmproj
(completed). Host: Windows 11 x64, local SSD.

**What this data can and cannot tell us.** The numbers are real transfer
throughput, not a fixture; but they are one session on one host/network path and
cannot be replayed in CI (origin token buckets, CDN routing and the ~95–100 MiB/s
observed line ceiling are not controlled). The controller/recording fixes
therefore ship with synthetic regression coverage (§4), and the real WAN run is
cited as evidence, never as a benchmark result. The session's own biggest
limitation is one of the fixes: per-sample telemetry lived only in kernel memory
(`samples=1907` for the cancelled task), so the 8-point series in
`telemetry-observed.csv` was reconstructed by repeatedly calling `rdm_tasks`.

### Evidence → fix

| # | Observation (real data) | Root cause | 0.2.1 change |
|---|---|---|---|
| 1 | All three plan events say `0 resumed bytes` although `.part` + `.part.json` exist. `t_c613ac42` was cancelled at **11.6 GB / 39.8 GB (29 %)**; the follow-up `t_3c58544c` re-probed the **same** object and started from zero. | Resume state was keyed on `finalUrl`; the final URL carries a per-request token (`auth_key=1794154377-…` on ModelScope, `Expires`/`Policy` on HF xet), so a new probe → new URL → identity mismatch → whole chunk table discarded. | Resume compatibility keyed on **stable identity** (requested URL, final URL scheme+host+path without query, size, validators); explicit `resumeDecision`/`resumeReason`. |
| 2 | `t_3c58544c` stayed **32/32 workers** while `w5` fell **56.4 → 9.4 MiB/s** (`w30` 56.9 → 9.3; instant 54.9 → 8.7), peak unchanged at ~70–71 MiB/s, `stalledMs` only **130 ms** (177 ms later). `avg` 38.4 with `w30` 9.3 proves a mid-transfer step drop, not a slow origin. | No throughput-collapse detection and no connection-pool recovery. | Collapse detection → rebuild the HTTP connection pool (fresh TCP/TLS) and probe growth. |
| 3 | Controller events only oscillate **inside** the requested count (16→13→16, 32→29→32); it never exceeds `connections`. The run's 16→32 recovery came from a human restart (avg 20.9 → 56.5 MiB/s). | Requested connections also acted as the ceiling. | `maxConnections` cap (default **128**, clamped `[connections, 128]`); controller may grow the target above `connections`, revert dilution, backoff. |
| 4 | ModelScope final URLs carry `auth_key=…`; HF xet URLs carry `Expires`/`Policy`. `signedUrl.signed` was `false` for ModelScope, and `finalUrl` / `redirects[].url` leaked the token into the MCP projection and the task record. | `auth_key` was not in the signed/credential vocabulary; redirect hops were not redacted. | `auth_key` treated as signed-URL material and redacted in every protocol projection, including all redirect hops; presence sets `signedUrl.signed = true`. |
| 5 | Per-sample telemetry existed only in kernel memory (`samples=1907`); the session had to reconstruct 8 points by hand; nothing was on disk. | No persistence of samples/events. | Per-task JSONL recording under `<data-dir>/history/` + `history` RPC + `rdm_history` tool. |
| 6 | Finish on the 26.4 GiB part showed the worker tail **9→3→2→1**: the last chunks are long-tail connections. | One uniform stall timeout, too long for the tail. | Stall timeout tightens **30 s → 10 s after 90 % → 5 s after 97 %**; pure unit-testable helper. |
| 7 | `32` was the hard maximum in every layer (kernel, HTTP pool, host config, tool schema, docs). Real runs already used 16–32, and HF needed 24+. | 0.1-era safety cap; also blocked fix #3. | `MAX_CONNECTIONS = 128` end to end; `connections`/`maxConnections` accept `1..128`. |

### What the run measured (context, not a regression target)

* **Source choice dominates scheduler tuning.** Same client and disk: Hugging
  Face 1.8–2.4 MiB/s at 8 connections, 3.6–6.5 MiB/s at 24; ModelScope 49.6
  MiB/s at 8, **68.5 MiB/s at 16** (peak 84.4), 56.5 MiB/s start at 32. The
  session README ranks preflight multi-source racing above any kernel tuning,
  and that remains out of scope for this pass (see §9 of the design note).
* **High concurrency is not monotonic.** 16 connections (68.5 MiB/s on the
  26.4 GiB part) beat 32 (56.5 MiB/s start on the 37.1 GiB part). Not a
  controlled A/B — they are different parts of the same model — but the run does
  not support "more connections is always better", which is one more reason the
  requested count is now the initial population rather than a hard target.
* **The 32→9 collapse was not a stall.** Stall time stayed ≤177 ms; the transfer
  moved bytes continuously, just far slower. This is why collapse detection keys
  on throughput vs. peak with workers pinned, not on stall time.

### Expected effect, and how it is checked

The real session cannot be replayed in CI; each fix gets a synthetic regression
instead (see [design/0.2.1-real-data-fixes.md](design/0.2.1-real-data-fixes.md)):

| change | expected effect | regression coverage |
|---|---|---|
| stable-identity resume | a cancel/restart no longer discards completed bytes; a changed remote is still rejected with a reason | `kernel/tests/**` resume cases + e2e `/volatile/...` fixture: restart adopts bytes, final file byte-identical |
| collapse rebuild + growth | throughput collapse is recovered without a human restart; growth dilution reverts; pushback halves | pure controller state-machine tests (collapse < 50 % peak workers pinned → rebuild + growth; dilution → revert; pushback → half; never > max) |
| `maxConnections` 128 | controller can exceed the requested count; caps clamp correctly end to end | e2e maxConnections accepted/clamped; `TaskView` field ranges |
| `auth_key` handling | no token in any protocol projection or recorded event; ModelScope URLs report `signed: true` | e2e redaction check (final URL, redirect hops, events) |
| JSONL recording | a transfer can be replayed/tuned after the fact and after a kernel restart | e2e history RPC (≥2 samples, files exist, survives restart) + writer/reader unit tests |
| tail stall timeout | the last long-tail chunks retry sooner instead of delaying the finish | pure helper unit test (30/10/5 s thresholds) |

### Final verification

Gate run **2026-11-09** on this host: Windows 11 x64, rustc 1.99.1
(`x86_64-pc-windows-gnu`), Node v24.19.0. All commands green:

| # | command | result |
|---|---|---|
| 1 | `cargo test --manifest-path kernel/Cargo.toml --all-targets` | **126 passed, 0 failed** — lib 68 · engine_tests 15 · protocol_tests 5 · unit 17 · v030_integration 21 |
| 2 | `cargo build --release --manifest-path kernel/Cargo.toml` | OK — `rdm-kernel.exe` **5,059,072 bytes (4.82 MiB)**, sha256 `94AB6DCCB2B343B5CAFE4ABB5B51F73856E5CF2CCD1D1546EE8B77B33B612FDE`; installed as `bin/win32-x64/rdm-kernel.exe` (same sha256, verified) |
| 3 | `node scripts/build.mjs` | built `lib/index.js` (173,276 bytes / 169.2 KiB; `lib/client.js` 139,567 bytes / 136.3 KiB); one pre-existing esbuild warning (CJS `module` variable in ESM at `src/client/index.tsx:91`), known and not a failure |
| 4 | `python tests/verify_e2e.py --kernel kernel/target/release/rdm-kernel.exe` | **145/145 checks passed**, 0 failed, 27.9–28.8 s; run three consecutive times on the final binary, all green (core group 55 + v030 group 90) |
| 5 | `node tests/tools-receipts.test.mjs` | **PASS 41 checks** |
| 6 | `node scripts/verify-fixture.mjs` | **64/64 checks passed** |
| 7 | `node scripts/verify-kernel.mjs --no-measure --allow-missing-artifacts` | **14/14 scenarios, 244/244 checks passed**, 101.5 s |
| 8 | Lead's independent black-box smoke (uncommitted `.tmp/lead-smoke.py`, real HTTP fixture) | **42/42 checks** — `maxConnections` 128 clamp, `auth_key` `signed=true` + redaction in `finalUrl` and redirect hops, cancel→restart resume across a *new* volatile final URL (`resumedChunks > 0`, byte-identical output), `resumeDecision`/`resumeReason`, JSONL/RPC/raw paging/restart persistence for `history`, controller growth past the requested connections reflected in `targetWorkers` |

Notes:

* Items 1–5 are the required gate from that pass's verification contract; 6–8 are
  additional coverage. Item 7 is the legacy Node matrix, which had stale
  protocol-1-era expectations: final integration refreshed it to protocol 2
  (`ready`/`initialize`/`stats`), protocol-2 `ServerFacts` in the probe scenario,
  and singleStream accounting as one rangeless transfer `GET` plus one 64-byte
  range-proof `GET`.
* Final integration also made `pause`/`resume` control verbs idempotent (`pause` on `paused` and `resume` on an active task are no-op successes) after an e2e run caught the pause→resume-before-engine-observed-it race; kernel coverage: `v030_integration::pause_and_resume_controls_are_idempotent`.
* A separate uncommitted check loaded the **real exported 0.2.0 task records** from `.rdm-data` with the new kernel: 24/24 checks (statuses/bytes/sha preserved, new view fields defaulted, `history` empty-but-valid, `auth_key` redacted from real server-fact projections).
* Release identity confirmed: `package.json` **0.2.0 → 0.2.1**; kernel protocol
  stays **2**, kernel identity stays **1.1.0**.
* These are correctness/coverage gate results, not throughput measurements. The
  real-data throughput evidence is the ModelScope/Hugging Face run tabulated
  above; the gate does not re-measure WAN throughput (the real session cannot be
  replayed in CI).

## 11. 0.2.2 — live ModelScope pass (2026-11-09)

0.2.2 was driven **live**: a working session on 2026-11-09 (12:05–12:20 +08:00)
downloaded a real model from ModelScope while the kernel's JSONL recording was
analysed in real time, the kernel was restarted mid-transfer (resume across
builds), and the experience fed straight back into the controller and accounting
fixes below. The evidence package is
[`session_logs/20261109/`](../session_logs/20261109/):

| file | contents |
|---|---|
| [`README.md`](../session_logs/20261109/README.md) | the session's own analysis: what was downloaded, the version/pin mismatch found, open issues with timestamps |
| [`tasks.json`](../session_logs/20261109/tasks.json) | four task records (final) + both kernel builds + which tasks have history coverage |
| [`events.csv`](../session_logs/20261109/events.csv) | kernel event stream (`probe`/`plan`/`started`/`controller`/`resumed`/`retry`/`verify`/`completed`/`cancelled`), UTC + local |
| [`telemetry-kernel.csv`](../session_logs/20261109/telemetry-kernel.csv) | **kernel-native** per-sample series (≤10 Hz, 2097 + 376 + 2 rows) |
| [`telemetry-kernel/`](../session_logs/20261109/telemetry-kernel/) | the raw per-task `.samples.jsonl` / `.events.jsonl` recordings |
| [`samples.jsonl`](../session_logs/20261109/samples.jsonl) | external 2 s sampling (740 rows) used to cross-check the kernel series |
| [`kernel-history.json`](../session_logs/20261109/kernel-history.json), [`record.json`](../session_logs/20261109/record.json) | per-task history stats and task-level change points |

Session: `Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M` (29,608,446,496 + 28,800,138,432 B
shards + 907,543,008 B mmproj) from the ModelScope mirror, plus two larger models
downloaded this round (`Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf`,
22,360,456,160 B, and `UD-Q6_K_XL.gguf`, 31,843,777,504 B) into `D:\llm\models`
(results in §11.6). Host: Windows 11 x64, local SSD.

### What the live session measured

| task | file | size | connections (requested → actual) | transfer | avg | p50 / p95 | peak | verify |
|---|---|---|---:|---:|---:|---:|---:|---:|---|
| `t_248a5911009cc18d` | mmproj | 866 MiB | 8 → 8 | 20.3 s | 39.9 MiB/s | — | 56.7 | ✅ `b1a82259` |
| `t_7359f357ea3922cb` | shard 2 | 26.82 GiB | 12 → 12 | 6 m 20 s (245 ms to finish after restart) | 72.3 MiB/s | — | 88.9 | ✅ `316b46f3` |
| `t_6a665d4e17fa3100` | shard 1, attempt 1 (cancelled) | 27.58 GiB | 12 → 12→20 | 7 m 17 s (12 % downloaded) | 5.7 (old build) → 20.5 (new build, 58 s) | 10.9 / 51.4 | 55.3 | cancelled, `.part` kept |
| `t_ebda50bb99a77a14` | shard 1, attempt 2 | 27.58 GiB | 16 → 16→102 | **5 m 24 s** | **106.3 MiB/s** | 107.5 / 114.1 | 102 | ✅ `bfa3644d` |

Source context (not a 0.2.2 fix): the same object over Hugging Face gave
**0.13 MiB/s** on a single connection, while ModelScope gave 13.9 MiB/s on one and
**106 MiB/s** at 16→102 connections. Source choice still dominates every scheduler
tuning decision.

Compared with the §10 baseline, the 0.2.1 fixes showed up as expected: both
resumes were `accepted`/`etag` (2,359,836,648 B; 28,798,211,398 B;
3,676,430,303 B — across tasks, across builds, and even after changing
`expectedSha256`); the controller grew 16 → 102 with `pool rebuild #1`, `revert`
and `shrink` events; and the kernel wrote 2097 samples over 324 s (≈6.5 Hz)
instead of leaving the series in memory (the §10 session had reconstructed 8
points by hand).

The live run also exposed what 0.2.2 had to fix:

1. **Build attribution.** The session spanned two kernels (pid 53520, then 59852
   after a restart) that both reported `1.1.0`, and history coverage was uneven:
   `mmproj` 0 samples, shard 2 only 2 samples, shard 1 attempt 1 only its 376
   post-restart samples. A series could not be attributed to a build or aligned
   across the restart.
2. **Controller jitter.** 12:16:47–12:17:40: `grow to 72 → revert to 64` five
   times, 16–21 s apart, while instantaneous throughput stayed 107–113 MiB/s and
   aggregate stayed 112–114 MiB/s — growth was being rejected on single-tick
   per-connection dilution at a flat line rate.
3. **Tail wait.** The last 3 chunks hit `no body data for 10 s` twice while the
   controller shrank 102→90→79→70 because fewer active workers read as "average
   rate falling".
4. **Receipt/plan ambiguity.** `plan` printed 8 workers while 16 were requested
   and 16→102 ran; `resume state saved: 17 chunks / 3,676,430,303 bytes`
   contradicted an 8 MiB chunk size (17 ranges, not 17 chunks — the next plan said
   422 chunks for the same bytes).
5. **Resumed-rate artifacts.** A resumed task's `avgBps` was 1.8 GiB/s and its
   first sample `bps` 8.6 GiB/s (peak 8.8 GiB/s): the rate ring had been seeded
   with absolute `downloaded` after the resume jump.
6. **Opaque method error.** An old-build kernel answered the new `rdm_history`
   tool with `unknown method history`.

### Evidence → fix (0.2.2)

| # | Observation (live session) | Fix |
|---|---|---|
| 1 | Two builds both `1.1.0`; uneven/unalignable history coverage across the restart | Kernel identity → **0.2.2** (same as the package version); history **meta record** at plan time (kernel version, pid, task/run, file/total/chunk, requested/initial/ceiling workers, resume decision); `history` exposes `meta`, `rdm_history` shows `builds` tags |
| 2 | Aggregate flat at 112–114 MiB/s while growth was rejected five times on per-connection dilution | Growth verdict is **aggregate-based** (keep unless aggregate drops below 95 %); revert only on aggregate drop, with a **30-tick revert cooldown** |
| 3 | Tail chunks waited 10 s twice while the controller shrank on tail drain | **Tail freeze** (`remaining ≤ target` holds the target) and **tail retries**: 3 s stall deadline, `min(250 ms × attempt, 1 s)` delay |
| 4 | Plan/worker counts and range-vs-chunk counts were ambiguous | Stable `plan` line with requested/initial/ceiling; `resume state saved` reports **ranges / chunks / bytes**; `resumeState.chunksDone` = chunks covered by merged ranges; `TaskView.requestedConnections` added |
| 5 | Resumed task reported multi-GiB/s averages from adopted bytes | Rate ring/EWMA/peak seeded from **this-run** `transferredBytes`; `avgBps` = whole-file progress / persisted lifetime elapsed; `TaskView.transferredBytes` exposes the run bytes |
| 6 | Old-build kernel returned opaque `unknown method history` | Unknown RPC method → stable **`unsupported_method`** error naming the method and kernel version with an upgrade hint |
| 7 | Verification runs serially after the transfer (15 s per 26.8 GiB ≈ 4.4 % of 339 s) | **Out of scope for 0.2.2** (documented): out-of-order chunks cannot stream into one SHA-256; a chunk-hash tree would change the verification contract |

### Expected effect, and how it is checked

| change | expected effect | regression coverage |
|---|---|---|
| history meta / build tags | a series spanning kernel builds is attributable; `history` reports which build produced which slice | kernel tests: one meta line per plan, skipped in totals, survives restart, second build appends a second meta line to the same file; e2e: `meta` has kernelVersion/pid, `builds` exposed, old format still reads |
| this-run rate accounting | a resumed task starts cold: no 8 GiB/s speed/peak, `transferredBytes` grows from 0, `avgBps` stays lifetime-correct | kernel tests: resumed first sample/peak are this-run, `transferredBytes` grows from 0; e2e: `transferredBytes < downloaded` on a resumed view |
| aggregate growth + saturation | growth is kept at a flat aggregate ceiling instead of 64↔72 jitter; saturation stops probing | controller tests: aggregate-kept growth does not revert on per-connection dilution; aggregate drop reverts; revert cooldown ≥ 30 ticks; saturation freeze |
| tail freeze + tail retries | tail drain does not shrink the pool and does not wait 10 s per dead claim | controller test: `cap <= target` holds the target; helper tests: `tail_retry_delay(1)=250 ms`, `(4)=1 s`, tail stall deadline 3 s |
| plan / resume-state receipts | operator can tell requested vs initial vs target and ranges vs chunks | kernel tests: covered-chunk count from merged ranges (one merged range covering 422 chunks reports 422), plan message contains requested/initial/ceiling; e2e: plan message contains `requested=`/`ceiling=` |
| `unsupported_method` | a new host against an old kernel gets an actionable error, not an opaque one | kernel test: unknown method → `unsupported_method` (with kernel version + upgrade hint) |

### Real Q4/Q6 downloads (this round)

Data package: [`session_logs/20261109-qwen36/`](../session_logs/20261109-qwen36/)
(live progress JSONL, kernel history JSONL, task records). Two real downloads
from ModelScope `unsloth/Qwen3.6-35B-A3B-GGUF` into `D:\llm\models`, both
SHA-256 verified by re-reading the finished files. **Q4 runs on the 0.2.1 build
as the baseline; Q6 starts on 0.2.1 and is resumed and finished across two 0.2.2
builds**, so the same object shows the old and the new behavior. Rates below use
the **task-record transfer window** (`timing.transferMs` plus the per-phase
transfer windows in the package) — the same basis as the package README; restart
downtime, wall clock and post-transfer verification are reported separately.

| file | bytes | build(s) | active transfer | avg (active) | wall clock | peak `peakBps` | peak workers | final target | retries | verify | sha256 |
|---|---:|---|---:|---:|---:|---:|---:|---:|---|---:|---|
| `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` | 22,360,456,160 (20.82 GiB) | 0.2.1 (kernel 1.1.0) | 251.739 s | 84.71 MiB/s (88.82 MB/s) | 263.621 s start→completed | 131.70 MiB/s (138,096,155 B/s) | 128 | 76 (0.2.1 tail shrink) | 3 (30 + 10 + 10 s waits, 1 s delays) | 11.477 s | `707a55a8a4397ecde44de0c499d3e68c1ad1d240d1da65826b4949d1043f4450` |
| `Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf` | 31,843,777,504 (29.66 GiB) | 0.2.1 + 0.2.2 ×2 | 415.241 s active + 204.255 s restart downtime | 73.13 MiB/s (76.69 MB/s) active; 49.99 MB/s whole wall | 636.942 s | 175.72 MiB/s (184,254,279 B/s) | 128 | 102 (tail frozen) | 1 (5 s wait, **250 ms** delay) | 16.459 s | `f6b6c6d5cfa6f00d964eeb7add28eb14ce7481734d506b90681007678cd2c484` |

Q6 phases (three transfer phases separated by clean kernel shutdown/auto-resume;
bytes sum exactly to **31,843,777,504 B**):

| phase | build | active | transferred | rate | resume / plan | controller |
|---|---|---:|---:|---:|---|---|
| A | 0.2.1 (kernel 1.1.0, no meta) | 185.758 s | 14,008,445,673 B (13.05 GiB) | 71.92 MiB/s | fresh | target 16→128; grow 20 / revert 1 |
| B | 0.2.2 pid 52800 | 107.719 s | 7,324,399,286 B (6.82 GiB) | 64.85 MiB/s | resumed 14,008,445,673 B (13.05 GiB); plan `initial=16` | grow 10 / revert 1 / freeze 2 / unfreeze 1 |
| C | 0.2.2 pid 46656 | 121.764 s | 10,510,932,545 B (9.79 GiB) | 82.32 MiB/s | resumed 21,332,844,959 B (19.87 GiB); **`initial=41` restored** | grow 8 / freeze 1 / tail freeze 1; the one 250 ms retry |

What the pair shows on the same object:

* **Tail behavior.** Q4 (0.2.1) took three retries with 30/10/10 s waits and 1 s
  delays, and its final target was 76 — the 0.2.1 tail shrink. Q6 (0.2.2) had
  one retry with a 5 s wait and a **250 ms** delay, a
  `tail: target frozen at 102 workers (remaining claim units 93)` event, and
  **no tail shrink** (final target 102). This is exactly the §11 evidence→fix
  items 2–3, measured on a second real object.
* **Controller.** Q4: grow 23, revert 4, pool rebuild 1, shrink 4 (the tail
  shrink above). Q6: grow 38, revert 2, `growth frozen: aggregate gain < 2%` 3×,
  unfrozen 1×, tail freeze 1×, no shrink — saturation replaced the 0.2.1-era
  walk toward 128.
* **Final-integration fixes from this run.** The live records drove two last
  board-level fixes before release: `requestedConnections` now falls back to the
  recorded initial population for pre-field 0.2.1 records, and
  `elapsedMs`/`avgBps` no longer reset to 0 after a kernel restart (terminal
  records recover wall time from `createdAt`→`finishedAt`; running records keep
  accumulated elapsed time). The final kernel hash below is the rebuilt artifact.
* **Resume across builds.** Q6 adopted 13.05 GiB then 19.87 GiB across two clean
  shutdown/auto-resume cycles, each `accepted:etag`; phase C restored the previous
  run's target (`initial=41` against `requested=16`).
* **Build attribution.** Q6's single JSONL timeline has **2 meta records**
  (`kernel 0.2.2 pid 52800 run 1 resumed 13.05 GiB …`, then
  `kernel 0.2.2 pid 46656 run 1 resumed 19.87 GiB …`; the raw copies record
  `1.2.0` because the version was unified with the package version after this
  run — only the current build reports 0.2.2); the 0.2.1 phase A has no
  meta, which is expected for a pre-0.2.2 build. Q4's 0.2.1 recording has
  **0 meta records**.
* **Receipts.** 0.2.1 wrote `resume state saved: 125 chunks / 14008445673 bytes`
  (chunks = merged ranges); 0.2.2 wrote `resume state saved: 41 ranges / 2502
  chunks / 21332844959 bytes` for the same state — the two numbers no longer
  contradict each other.
* **Verification cost.** Serial post-transfer SHA-256 took 11.477 s on Q4 and
  16.459 s on Q6 (the out-of-scope item below), measured as `verify` windows
  separate from the transfer times above.

### Final verification

Gate run **2026-11-09** on the final 0.2.2 artifacts: Windows 11 x64, rustc
1.99.1 (`x86_64-pc-windows-gnu`), Node v24.19.0. All commands green:

| # | command | result |
|---|---|---|
| 1 | `cargo test --manifest-path kernel/Cargo.toml --all-targets` | **146 passed, 0 failed** — lib 75 · engine_tests 15 · protocol_tests 5 · unit 17 · v022_integration 13 · v030_integration 21 |
| 2 | `cargo build --release --manifest-path kernel/Cargo.toml` | OK — `rdm-kernel.exe` **5,101,056 bytes (4.86 MiB)**, sha256 `B322863E1BDBE342499BCCD9379B66823640C445165F9D7540053610BAFEAC77`; installed as `bin/win32-x64/rdm-kernel.exe` (same sha256, independently re-verified) |
| 3 | `node scripts/build.mjs` | built `lib/index.js` **176,130 bytes (172.0 KiB)** and `lib/client.js` **139,567 bytes (136.3 KiB)**; one pre-existing esbuild warning (CJS `module` variable in ESM at `src/client/index.tsx:91`), known and not a failure |
| 4 | `python tests/verify_e2e.py --kernel kernel/target/release/rdm-kernel.exe` | **205/205 checks passed**, 0 failed, 45.2 s (core group 55 + v030 group 90 + v022 group 60) |
| 5 | `node tests/tools-receipts.test.mjs` | **PASS 43 checks** |
| 6 | `node scripts/verify-fixture.mjs` | **64/64 checks passed** |
| 7 | `node scripts/verify-kernel.mjs --no-measure --allow-missing-artifacts` | **14/14 scenarios, 244/244 checks passed**, 102.1 s |
| 8 | Lead's independent black-box checks (uncommitted) | smoke **46/46** — `requested`/`initial`/`ceiling` plan fields, fresh task `not-attempted`, cross-restart volatile-URL resume, history meta/builds + kernel 0.2.2, `transferredBytes < downloaded`, aggregate-growth controller, 0.2.2 clamp; real 0.2.0 task-record load **24/24**; history meta/builds + `unsupported_method` on the real Q4/Q6 data dir **14/14** |

Notes:

* Release identity on the final artifacts: `package.json` **0.2.2**,
  `kernel/Cargo.toml` **0.2.2**, protocol stays **2**.
* The 0.2.2 behavior was validated on **real WAN transfers**, not only fixtures:
  Q4 ran on 0.2.1 as the baseline, and Q6 spanned 0.2.1 + two 0.2.2 builds
  (previous target restored as `initial=41`, saturation freeze, tail freeze with
  no tail shrink, one 5 s / **250 ms** tail retry, 2 meta records in one JSONL
  timeline, SHA-256 verified).
* These are correctness/coverage gate results, not WAN throughput numbers — the
  real transfer evidence is tabulated in §11.6 above.

### Still out of scope (documented, not fixed here)

* **Serial post-transfer verification.** 26.82 GiB took 15 s and 27.58 GiB 15 s
  (≈1.8 GB/s), i.e. ≈4.4 % of a 339 s transfer. Streaming out-of-order chunks
  into one SHA-256 is impossible; a chunk-hash tree would change the verification
  contract and is a later release.
* **Multi-source racing.** The live session re-confirmed the §10 finding: the
  same content is 0.13 MiB/s on HF and 106 MiB/s on ModelScope. Preflight
  source racing is the roadmap item, not a controller fix.
