# dsh-rdm — optimization study

This document records a measurement-driven optimization pass over the resident
download kernel: what was measured, what was changed, what it bought, and what
was deliberately left alone. Every number below comes from a reproducible
harness ([`tests/perf.mjs`](../tests/perf.mjs)); the scenario/behaviour side is
covered by [verification.md](verification.md).

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
