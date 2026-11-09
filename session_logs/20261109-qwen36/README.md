# dsh-rdm 2026-11-09 live ModelScope pass — Qwen3.6 Q4/Q6 data package

Two real, verified ModelScope downloads of `unsloth/Qwen3.6-35B-A3B-GGUF` made with
dsh-rdm: **Q4** ran on the 0.2.1 build; **Q6** spans three phases — 0.2.1 start →
0.2.2 auto-resume at 13.05 GiB (14,008,445,673 B) → 0.2.2 auto-resume at
19.87 GiB (21,332,844,959 B) after a second kernel restart. All artifacts here are read-only copies of the kernel data dir
`D:\llm\models\.dsh-rdm-data` and the driver's `.tmp/live-qwen36/` output; the
originals were not modified.

- Generated: 2026-11-09 (analyst pass), package owned by `analyst`.
- **Version note:** the binaries in this run reported kernel `1.2.0`; kernel and
  plugin versions were unified afterwards to **0.2.2**. The raw history/meta
  files keep `1.2.0` exactly as recorded; only a current build reports 0.2.2.
- Kernel builds observed: `1.2.0` pid 52800 and pid 46656 (history meta); the
  first phase (Q4, Q6 phase A) ran on the **0.2.1** build whose history has no
  meta record.
- Model: `Qwen3.6-35B-A3B-GGUF`, repo `unsloth/Qwen3.6-35B-A3B-GGUF`,
  `https://www.modelscope.cn/models/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/master/<file>`
  (redirects to `cdn-lfs-cn-1.modelscope.cn`), destination `D:\llm\models`.

## 1. Downloads

| | Q4 | Q6 |
|---|---|---|
| Task id | `t_eff93d4e8e7cbb78` | `t_0c48feb24198fef1` |
| File | `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` | `Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf` |
| Bytes | 22,360,456,160 (20.83 GiB) | 31,843,777,504 (29.66 GiB) |
| SHA-256 | `707a55a8a4397ecde44de0c499d3e68c1ad1d240d1da65826b4949d1043f4450` | `f6b6c6d5cfa6f00d964eeb7add28eb14ce7481734d506b90681007678cd2c484` |
| Kernel verify | ✅ `verified: true` | ✅ `verified: true` |
| Build(s) | 0.2.1 / kernel 1.1.0 (history without meta) | 0.2.1 (phase A) → 0.2.2 / kernel 1.2.0 pid 52800 (phase B) → 0.2.2 / kernel 1.2.0 pid 46656 (phase C) |
| Transfer time | 251.739 s | 415.241 s active (3 phases) + 204.255 s restart downtime |
| Average | **84.71 MiB/s** (88.82 MB/s) over the transfer window | **73.13 MiB/s** (76.69 MB/s) over active transfer time; 49.99 MB/s over the whole wall clock |
| Peak `peakBps` | 138,096,155 B/s = 131.70 MiB/s | 184,254,279 B/s = 175.72 MiB/s |
| Peak workers | 128 | 128 |
| Final `targetWorkers` | 76 (after tail shrink) | 102 (tail target frozen) |
| Retries | 3 stall retries: 30 s + 10 s + 10 s waits, 1 s delays | 1 stall retry: 5 s wait, **250 ms** delay |
| Verify (SHA-256) | 11.475 s (`timing.finalizeMs`; event span 11.477 s) | 16.459 s |
| Wall clock start → completed | 263.621 s | 636.942 s |
| History coverage | 1,604 samples / 42 events, **0 meta lines** | 2,644 samples / 69 events, **2 meta lines**, samples continue across all 3 builds in one file |

The SHA-256 values are the kernel-verified digests (`TaskView.sha256` in
`tasks-final/*.json`, matching `verify` + `completed` events in `history/*.events.jsonl`).
This package does not re-hash the 54 GiB of model files.

### Timing basis used for the rates above

* **Q4 "active transfer" = the kernel task-record `timing.transferMs`:
  251,739 ms** (`progress/q4.result.json` → `detail.timing.transferMs`; identical
  to the `finished in 251739 ms` event). `84.71 MiB/s = 22,360,456,160 B /
  251.739 s`. Verify time is the record's `timing.finalizeMs = 11,475 ms`.
* **Q6 "active transfer" = the sum of the three per-phase transfer windows**
  taken from the kernel event stream (`started` → `interrupted` for phases A/B,
  `started` → `finished in` for phase C):
  **185.758 + 107.719 + 121.764 = 415.241 s**, so
  `73.13 MiB/s = 31,843,777,504 B / 415.241 s`. The 204.255 s of restart downtime
  (177.228 s + 27.027 s) is excluded. Per-phase bytes are the phase-end
  `resumedBytes` deltas and sum exactly to the file size.
* Caveat: the restored Q6 task record's own `timing.transferMs` is
  **229,845 ms**, which covers only the two post-restart phases (the phase B+C
  event windows sum to 229,483 ms; the record timer starts at status transitions
  and is ~0.36 s longer). Phase A's transfer timer did not survive the 0.2.1 →
  0.2.2 kernel restart, so **do not use the restored record's `transferMs` as the
  Q6 whole-run active time** — use the phase table above.

## 2. Q6 phase table

| Phase | Build | Transfer window (local +08:00) | Bytes | Share | Avg | History samples | Controller | Retries |
|---|---|---|---|---:|---:|---:|---|---:|
| A | 0.2.1 / kernel 1.1.0 (no meta) | 13:35:39.614 → 13:38:45.372 (185.758 s) | 14,008,445,673 | 43.99% | 71.92 MiB/s | 1,193 (pre-meta) | grow 20, revert 1 | 0 |
| B | 0.2.2 / kernel 1.2.0 pid 52800 | 13:41:42.962 → 13:43:30.681 (107.719 s) | 7,324,399,286 | 23.00% | 64.85 MiB/s | 684 | grow 10, revert 1, freeze 2, unfreeze 1 | 0 |
| C | 0.2.2 / kernel 1.2.0 pid 46656 | 13:43:57.956 → 13:45:59.720 (121.764 s) | 10,510,932,545 | 33.01% | 82.32 MiB/s | 767 | grow 8, freeze 1, tail_freeze 1 | 1 |

Phase bytes sum exactly to 31,843,777,504. Downtime between phases: **177.228 s**
(A→B, kernel restart + 0.2.2 deploy) and **27.027 s** (B→C, second kernel
restart). The two restarts are why the whole-file wall-clock average is much
lower than the active-transfer average.

Q4 was a single 0.2.1 phase: transfer 13:30:39.411 → 13:34:51.151, 84.71 MiB/s
over 251.739 s, then 11.475 s SHA-256 (`timing.finalizeMs = 11,475 ms`; the `verify`→`completed` event span is 11,477 ms).

## 3. History / build attribution

| Task | Samples | Events | Meta lines | Builds exposed by `rdm_history` | `transferred` field |
|---|---:|---:|---:|---|---|
| Q4 `t_eff93d4e8e7cbb78` | 1,604 | 42 | 0 | *(none — pre-1.2.0 result has no `builds`/`meta` keys; still readable)* | absent |
| Q6 `t_0c48feb24198fef1` | 2,644 | 69 | 2 | `["1.2.0@52800", "1.2.0@46656"]` | present in 1,451/2,644 samples (the two 1.2.0 phases) |

The 0.2.2 pieces this data verifies:

1. **One file per task across builds/restarts.** Q6 phase A samples, phase B
   samples and phase C samples are appended to the same
   `t_0c48feb24198fef1.samples.jsonl`; the only gap is the restart downtime
   (max sample gap 177,779 ms, exactly the A→B downtime).
2. **Meta record at plan time.** `history/t_0c48feb24198fef1.samples.jsonl` lines
   with `kind:"meta"` carry `kernelVersion:"1.2.0"`, `pid`, `run`, `phase`,
   `requestedConnections`, `initialWorkers`, `maxConnections`, `resumedBytes`,
   `resumeDecision`/`resumeReason`, `totalBytes`, `chunkSize`, `chunks` — see
   `metrics.json` → `q6.history.builds`.
3. **Old histories stay readable.** Q4's captured `rdm_history` result
   (`progress/q4.history.json`) has no `builds`/`meta` keys and no error.
4. **Pre-meta phases are visibly unattributed.** Q4's 1,604 samples and Q6
   phase A's 1,193 samples have no meta; they can only be attributed via this
   session record (`0.2.1 / kernel 1.1.0`), not from the JSONL itself. This is
   the exact gap 0.2.2 closes going forward.

## 4. Evidence → 0.2.2 fix mapping

| # | Observed in this package | 0.2.2 change |
|---|---|---|
| 1 | Q6 1.2.0 meta lines: pid 52800 resumedBytes 14,008,445,673 initialWorkers 16; pid 46656 resumedBytes 21,332,844,959 **initialWorkers 41**; `rdm_history` result `builds:["1.2.0@52800","1.2.0@46656"]` | §1.2 history meta record; `history`/`rdm_history` expose builds |
| 2 | First sample after each 0.2.2 resume: `bytes=14008445673, transferred=0, bps=0` and `bytes=21332844959, transferred=0, bps=0` (Q6 phase B/C) | §1.3 this-run rate baseline — no resume spike. Contrast the 2026-11-09 batch (`session_logs/20261109/`): first sample of `t_ebda50bb99a77a14` = **8,862.39 MiB/s** (9,292,890,994 B/s) because the ring was seeded with 0 while `downloaded` already held the 3,676,430,303-byte resume baseline |
| 3 | Plan receipts: `"…chunks=3797 chunk=8388608; requested=16 initial=16 ceiling=128; resumed=14008445673 bytes resume=accepted:etag"` then `"…requested=16 initial=41 ceiling=128; resumed=21332844959 …"` | §1.6 plan line prints requested / initial / ceiling explicitly |
| 4 | Resume-state receipts: 0.2.1 phase A wrote `"resume state saved: 125 chunks / 14008445673 bytes"`; 0.2.2 phase B wrote `"resume state saved: 41 ranges / 2502 chunks / 21332844959 bytes"` (41 ranges ≠ 41 chunks; 2,502 covered chunks) | §1.6 ranges / chunks / bytes printed separately |
| 5 | 0.2.2 controller text: `"revert to 16: growth dropped aggregate rate (12.7 -> 9.4 MiB/s)"`; `"growth frozen: aggregate gain < 2% at 9.0 MiB/s over 2 probes"`; `"growth unfrozen: aggregate 9.3 MiB/s vs frozen peak 12.7 MiB/s"`; Q6 phase C `"growth frozen: aggregate gain < 2% at 110.4 MiB/s over 2 probes"` — no 64↔72-style churn in the 1.2.0 phases (1 revert in B, 0 in C) | §1.4 aggregate growth verdict, revert cooldown, saturation backoff |
| 6 | Q6 phase C tail: `"tail: target frozen at 102 workers (remaining claim units 93)"`; one retry `"no body data for 5 s (stalled connection)"` with `delayMs=250` (0.2.2 fast retry) | §1.4 tail freeze; §1.5 tail stall/fast retry |
| 7 | 0.2.1 contrast (Q4): tail shrink 128→112→98→86→76 over 5 s and 3 retry waits of **30 s + 10 s + 10 s** with 1 s delays (50 s total stall wait) | §1.5 tail retry / §1.4 tail freeze — the pattern this pass fixes |

### Rate-accounting detail (Q6, 0.2.2)

- `transferredBytes` on the final task record is **10,510,932,545** = the phase C
  this-run bytes (`31,843,777,504 − 21,332,844,959`), not the whole-file bytes —
  the field is genuinely this-run.
- The 0.2.2 `TaskView.elapsedMs` / `avgBps` are **0** in `tasks-final/q6.json`
  because the task was re-loaded from disk after a restart and elapsed time is
  not persisted; `peakBps` (184,254,279 B/s) and `transferredBytes` are correct.
  Treat `elapsedMs`/`avgBps` on restarted tasks as unreliable and use the event
  `finished in … ms` / history spans instead (as done in `metrics.json`).

## 5. Tail behaviour in this run

- **Q4 (0.2.1, the pattern to fix).** After the last grow to 128 workers at
  13:32:50.411, the controller shrank 128→112→98→86→76 at
  13:34:23.411–13:34:28.413 ("average rate falling") while claims were finishing.
  Three stall retries followed: `no body data for 30 s` at 13:33:30.221 (chunk
  8,942,256,128), then `no body data for 10 s` at 13:34:35.329 (chunk
  21,088,960,512) and 13:34:38.162 (chunk 22,045,261,824), each retried after a
  1 s delay. Total guaranteed stall wait: 50 s.
- **Q6 phase C (0.2.2).** The target was frozen at 102 workers when remaining
  claim units hit 93 (13:45:28.956), no shrink occurred, and the only retry was
  detected 5 s after the stall stopped (13:45:36.377) and retried 250 ms later.
  This is the final-phase 5 s deadline (99.8% complete) on a claim that was
  taken before the tail freeze, so the 3 s tail deadline itself was not
  exercised by this run.

## 6. Package contents

```
session_logs/20261109-qwen36/
├── README.md                         this file
├── metrics.json                      machine-readable per-phase metrics, fix evidence, manifest
├── analyze.md                        analyzer usage + captured output for this package
├── analyze.sh                        one-line wrapper around scripts/analyze_history.py
├── tasks-final/
│   ├── q4.json                       kernel task record t_eff93d4e8e7cbb78 (verbatim)
│   └── q6.json                       kernel task record t_0c48feb24198fef1 (verbatim)
├── history/
│   ├── t_eff93d4e8e7cbb78.samples.jsonl   raw per-sample history (1,604 samples)
│   ├── t_eff93d4e8e7cbb78.events.jsonl    raw event history (42 events)
│   ├── t_0c48feb24198fef1.samples.jsonl   raw history across 3 builds (2,644 samples + 2 meta lines)
│   └── t_0c48feb24198fef1.events.jsonl    raw event history (69 events)
└── progress/
    ├── q4.progress.jsonl  q4.result.json  q4.history.json
    └── q6.progress.jsonl  q6.result.json  q6.history.json
```

`progress/q*.result.json` is the driver's captured final task view;
`progress/q*.history.json` is the captured `rdm_history` tool result (Q6 shows
`builds` + `meta`, Q4 shows the meta-less 0.2.1 format).

## 7. Reproduce the analysis

```bash
python scripts/analyze_history.py session_logs/20261109-qwen36 --tz +08:00
python scripts/analyze_history.py session_logs/20261109-qwen36/progress --tz +08:00
python scripts/analyze_history.py session_logs/20261109-qwen36 --tz +08:00 \
    --json /tmp/qwen36-report.json --csv /tmp/qwen36-report.csv
```

`analyze.md` contains the full captured output of these commands.
`python .design/20261109-qwen36-metrics.py` regenerates `metrics.json` from the
files in this package alone (it does not read `D:\llm\models`).

## 8. Open issues observed while building this package

> **Final-integration note (0.2.2 build sha256 `B47C04E0…`):** items 1 and 2
> below were fixed after this package was generated. Pre-field records now fall
> back to the recorded initial population for `requestedConnections`, and
> `elapsedMs`/`avgBps` are recovered/persisted across restarts. The observations
> are kept verbatim because they are the evidence that drove the fixes.

1. `TaskView.requestedConnections` is persisted as **1** on both finished task
   records and in the captured finals (`tasks-final/q4.json`, `q6.json`,
   `progress/*.result.json`) although `spec.connections` is 16 — the restore /
   persist path loses the requested count.
2. After a kernel restart, restored task records show `elapsedMs: 0` and
   `avgBps: 0` (see §4); elapsed/avg are not persisted across restarts.
3. History cadence is ~6.4 Hz, not 10 Hz: the 100 ms reporter tick and the
   100 ms sample gate are the same cadence, so scheduling jitter rejects about
   half of the ticks (Q4 6.37 Hz; Q6 overall 4.26 Hz because of the two restart
   gaps; `session_logs/20261109` batch: 6.47 Hz).
4. The 3 s tail stall deadline path was not exercised in this run (only the 5 s
   final-phase deadline was); a targeted fixture test is needed to cover it.
5. The two restarts cost 204.255 s of wall clock; nothing in 0.2.2 reduces the
   restart gap itself (out of scope), but meta + resume accounting make the
   cost measurable instead of invisible.
