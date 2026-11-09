# Analyze the Qwen3.6 live-download package with `scripts/analyze_history.py`

`analyze.sh` is a thin wrapper; the tool is pure Python 3 stdlib, no dependencies.

```bash
python scripts/analyze_history.py session_logs/20261109-qwen36 --tz +08:00
python scripts/analyze_history.py session_logs/20261109-qwen36/progress --tz +08:00
python scripts/analyze_history.py session_logs/20261109-qwen36 --tz +08:00 --json metrics-report.json --csv metrics-report.csv
```

## package kernel-history copies

```console
$ python scripts\analyze_history.py session_logs\20261109-qwen36 --tz +08:00

dsh-rdm download-history analysis
==============================================================================
tasks: 2  samples: 4248  events: 111  controller events: 77
builds seen: 1.2.0@pid46656, 1.2.0@pid52800, pre-1.2.0 (no meta)

------------------------------------------------------------------------------
t_0c48feb24198fef1
  source   : C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\session_logs\20261109-qwen36\history\t_0c48feb24198fef1.samples.jsonl ; C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\session_logs\20261109-qwen36\history\t_0c48feb24198fef1.events.jsonl
  format   : kernel-history
  samples  : 2644   span: 619.95 s   cadence: 4.26 Hz   max gap: 177779 ms
  first    : 2026-11-09T13:35:39.716+0800
  last     : 2026-11-09T13:45:59.662+0800
  bytes    : 0 -> 31,843,279,749  (delta 31,843,279,749)
  transferred: 0 -> 10,510,434,790  (this-run delta 10,510,434,790)
    run pre-meta (no meta record)  2026-11-09T13:35:39.716+0800 .. 2026-11-09T13:38:45.284+0800  samples=1193  bytes_delta=13,931,986,834  bps mean 70.76 / max 120.76 MiB/s
    run 1.2.0@pid52800  2026-11-09T13:41:43.063+0800 .. 2026-11-09T13:43:30.606+0800  samples=684  bytes_delta=7,298,195,731  bps mean 64.22 / max 114.91 MiB/s
    run 1.2.0@pid46656  2026-11-09T13:43:58.056+0800 .. 2026-11-09T13:45:59.662+0800  samples=767  bytes_delta=10,510,434,790  bps mean 82.42 / max 118.32 MiB/s
  bps MiB/s: mean 72.40  p50 104.43  p95 113.48  p99 116.00  max 120.76  (1 leading sample(s) excluded)
  bps[0]   : 0.00 MiB/s
  workers  : min 1  max 128  peakWorkers 128
  controller: grow=38 revert=2 shrink=0 backoff=0 rebuild=0 freeze=3 unfreeze=1 tail_freeze=1 other=0
  events   : 69 (completed=1, controller=45, info=5, interrupted=2, plan=3, probe=6, resumed=2, retry=1, started=3, verify=1)
  retries  : 1   tail stalls (no body data): 1
  builds   : 1.2.0@pid52800, 1.2.0@pid46656
    build[0] 1.2.0 pid=52800 run=1 phase=plan t=2026-11-09T13:41:42.962+0800 requested=16 initial=16 ceiling=128 resumedBytes=14008445673 decision=accepted reason=etag
    build[1] 1.2.0 pid=46656 run=1 phase=plan t=2026-11-09T13:43:57.956+0800 requested=16 initial=41 ceiling=128 resumedBytes=21332844959 decision=accepted reason=etag
------------------------------------------------------------------------------
t_eff93d4e8e7cbb78
  source   : C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\session_logs\20261109-qwen36\history\t_eff93d4e8e7cbb78.samples.jsonl ; C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\session_logs\20261109-qwen36\history\t_eff93d4e8e7cbb78.events.jsonl
  format   : kernel-history  (no meta/build records)
  samples  : 1604   span: 251.61 s   cadence: 6.37 Hz   max gap: 207 ms
  first    : 2026-11-09T13:30:39.519+0800
  last     : 2026-11-09T13:34:51.125+0800
  bytes    : 0 -> 22,359,992,847  (delta 22,359,992,847)
  bps MiB/s: mean 84.43  p50 108.18  p95 114.37  p99 117.12  max 126.52  (1 leading sample(s) excluded)
  bps[0]   : 0.00 MiB/s
  workers  : min 1  max 128  peakWorkers 128
  controller: grow=23 revert=4 shrink=4 backoff=0 rebuild=1 freeze=0 unfreeze=0 tail_freeze=0 other=0
  events   : 42 (completed=1, controller=32, info=1, plan=1, probe=2, retry=3, started=1, verify=1)
  retries  : 3   tail stalls (no body data): 3
  builds   : pre-1.2.0 (no meta)
------------------------------------------------------------------------------

[exit 0]
```

## package host-progress copies

```console
$ python scripts\analyze_history.py session_logs\20261109-qwen36\progress --tz +08:00

dsh-rdm download-history analysis
==============================================================================
tasks: 2  samples: 351  events: 0  controller events: 0
builds seen: pre-1.2.0 (no meta)

------------------------------------------------------------------------------
t_0c48feb24198fef1
  source   : C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\session_logs\20261109-qwen36\progress\q6.progress.jsonl
  format   : host-progress  (no meta/build records)
  samples  : 218   span: 638.55 s   cadence: 0.34 Hz   max gap: 179260 ms
  first    : 2026-11-09T13:35:39.238+0800
  last     : 2026-11-09T13:46:17.787+0800
  bytes    : 0 -> 31,843,777,504  (delta 31,843,777,504)
  bps MiB/s: mean 69.52  p50 103.50  p95 113.94  p99 115.97  max 117.75  (1 leading sample(s) excluded)
  bps[0]   : 0.00 MiB/s
  workers  : min 0  max 128  peakWorkers n/a
  controller: grow=0 revert=0 shrink=0 backoff=0 rebuild=0 freeze=0 unfreeze=0 tail_freeze=0 other=0
  events   : 0 (none)
  retries  : 0   tail stalls (no body data): 0
  builds   : pre-1.2.0 (no meta)
------------------------------------------------------------------------------
t_eff93d4e8e7cbb78
  source   : C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\session_logs\20261109-qwen36\progress\q4.progress.jsonl
  format   : host-progress  (no meta/build records)
  samples  : 133   span: 264.15 s   cadence: 0.50 Hz   max gap: 2005 ms
  first    : 2026-11-09T13:30:39.008+0800
  last     : 2026-11-09T13:35:03.160+0800
  bytes    : 0 -> 22,360,456,160  (delta 22,360,456,160)
  bps MiB/s: mean 81.11  p50 107.53  p95 113.80  p99 116.12  max 119.01  (1 leading sample(s) excluded)
  bps[0]   : 0.00 MiB/s
  workers  : min 0  max 128  peakWorkers n/a
  controller: grow=0 revert=0 shrink=0 backoff=0 rebuild=0 freeze=0 unfreeze=0 tail_freeze=0 other=0
  events   : 0 (none)
  retries  : 0   tail stalls (no body data): 0
  builds   : pre-1.2.0 (no meta)
------------------------------------------------------------------------------

[exit 0]
```

## 2026-11-09 real batch (pre-meta history)

```console
$ python scripts\analyze_history.py session_logs\20261109\telemetry-kernel --tz +08:00

dsh-rdm download-history analysis
==============================================================================
tasks: 3  samples: 2475  events: 73  controller events: 46
builds seen: pre-1.2.0 (no meta)

------------------------------------------------------------------------------
t_6a665d4e17fa3100
  source   : C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\session_logs\20261109\telemetry-kernel\t_6a665d4e17fa3100.samples.jsonl ; C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\session_logs\20261109\telemetry-kernel\t_6a665d4e17fa3100.events.jsonl
  format   : kernel-history  (no meta/build records)
  samples  : 376   span: 58.17 s   cadence: 6.45 Hz   max gap: 209 ms
  first    : 2026-11-09T12:12:39.918+0800
  last     : 2026-11-09T12:13:38.092+0800
  bytes    : 2,359,836,648 -> 3,669,075,254  (delta 1,309,238,606)
  bps MiB/s: mean 20.56  p50 10.92  p95 51.38  p99 53.98  max 55.33  (1 leading sample(s) excluded)
  bps[0]   : 0.00 MiB/s
  workers  : min 12  max 20  peakWorkers 20
  controller: grow=8 revert=3 shrink=0 backoff=0 rebuild=1 freeze=0 unfreeze=0 tail_freeze=0 other=0
  events   : 20 (cancelled=1, controller=12, info=2, plan=1, probe=2, resumed=1, started=1)
  retries  : 0   tail stalls (no body data): 0
  builds   : pre-1.2.0 (no meta)
------------------------------------------------------------------------------
t_7359f357ea3922cb
  source   : C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\session_logs\20261109\telemetry-kernel\t_7359f357ea3922cb.samples.jsonl ; C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\session_logs\20261109\telemetry-kernel\t_7359f357ea3922cb.events.jsonl
  format   : kernel-history  (no meta/build records)
  samples  : 2   span: 0.10 s   cadence: 10.00 Hz   max gap: 100 ms
  first    : 2026-11-09T12:12:39.951+0800
  last     : 2026-11-09T12:12:40.051+0800
  bytes    : 28,798,211,398 -> 28,799,193,076  (delta 981,678)
  bps MiB/s: mean 9.36  p50 9.36  p95 9.36  p99 9.36  max 9.36  (1 leading sample(s) excluded)
  bps[0]   : 0.00 MiB/s
  workers  : min 1  max 1  peakWorkers 12
  controller: grow=0 revert=0 shrink=0 backoff=0 rebuild=0 freeze=0 unfreeze=0 tail_freeze=0 other=0
  events   : 9 (completed=1, info=2, plan=1, probe=2, resumed=1, started=1, verify=1)
  retries  : 0   tail stalls (no body data): 0
  builds   : pre-1.2.0 (no meta)
------------------------------------------------------------------------------
t_ebda50bb99a77a14
  source   : C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\session_logs\20261109\telemetry-kernel\t_ebda50bb99a77a14.samples.jsonl ; C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\session_logs\20261109\telemetry-kernel\t_ebda50bb99a77a14.events.jsonl
  format   : kernel-history  (no meta/build records)
  samples  : 2097   span: 324.08 s   cadence: 6.47 Hz   max gap: 209 ms
  first    : 2026-11-09T12:13:42.684+0800
  last     : 2026-11-09T12:19:06.767+0800
  bytes    : 3,676,430,303 -> 29,607,989,747  (delta 25,931,559,444)
  bps MiB/s: mean 102.14  p50 107.45  p95 114.05  p99 279.13  max 8012.61  (1 leading sample(s) excluded)
  bps[0]   : 8862.39 MiB/s  spike x82.5 vs median
  workers  : min 1  max 102  peakWorkers 102
  controller: grow=24 revert=7 shrink=3 backoff=0 rebuild=0 freeze=0 unfreeze=0 tail_freeze=0 other=0
  events   : 44 (completed=1, controller=34, info=2, plan=1, probe=2, retry=2, started=1, verify=1)
  retries  : 2   tail stalls (no body data): 2
  builds   : pre-1.2.0 (no meta)
------------------------------------------------------------------------------

[exit 0]
```

## live kernel data dir

```console
$ python scripts\analyze_history.py D:\llm\models\.dsh-rdm-data --tz +08:00

dsh-rdm download-history analysis
==============================================================================
tasks: 2  samples: 4248  events: 111  controller events: 77
builds seen: 1.2.0@pid46656, 1.2.0@pid52800, pre-1.2.0 (no meta)

------------------------------------------------------------------------------
t_0c48feb24198fef1
  source   : D:\llm\models\.dsh-rdm-data\history\t_0c48feb24198fef1.samples.jsonl ; D:\llm\models\.dsh-rdm-data\history\t_0c48feb24198fef1.events.jsonl
  format   : kernel-history
  samples  : 2644   span: 619.95 s   cadence: 4.26 Hz   max gap: 177779 ms
  first    : 2026-11-09T13:35:39.716+0800
  last     : 2026-11-09T13:45:59.662+0800
  bytes    : 0 -> 31,843,279,749  (delta 31,843,279,749)
  transferred: 0 -> 10,510,434,790  (this-run delta 10,510,434,790)
    run pre-meta (no meta record)  2026-11-09T13:35:39.716+0800 .. 2026-11-09T13:38:45.284+0800  samples=1193  bytes_delta=13,931,986,834  bps mean 70.76 / max 120.76 MiB/s
    run 1.2.0@pid52800  2026-11-09T13:41:43.063+0800 .. 2026-11-09T13:43:30.606+0800  samples=684  bytes_delta=7,298,195,731  bps mean 64.22 / max 114.91 MiB/s
    run 1.2.0@pid46656  2026-11-09T13:43:58.056+0800 .. 2026-11-09T13:45:59.662+0800  samples=767  bytes_delta=10,510,434,790  bps mean 82.42 / max 118.32 MiB/s
  bps MiB/s: mean 72.40  p50 104.43  p95 113.48  p99 116.00  max 120.76  (1 leading sample(s) excluded)
  bps[0]   : 0.00 MiB/s
  workers  : min 1  max 128  peakWorkers 128
  controller: grow=38 revert=2 shrink=0 backoff=0 rebuild=0 freeze=3 unfreeze=1 tail_freeze=1 other=0
  events   : 69 (completed=1, controller=45, info=5, interrupted=2, plan=3, probe=6, resumed=2, retry=1, started=3, verify=1)
  retries  : 1   tail stalls (no body data): 1
  builds   : 1.2.0@pid52800, 1.2.0@pid46656
    build[0] 1.2.0 pid=52800 run=1 phase=plan t=2026-11-09T13:41:42.962+0800 requested=16 initial=16 ceiling=128 resumedBytes=14008445673 decision=accepted reason=etag
    build[1] 1.2.0 pid=46656 run=1 phase=plan t=2026-11-09T13:43:57.956+0800 requested=16 initial=41 ceiling=128 resumedBytes=21332844959 decision=accepted reason=etag
------------------------------------------------------------------------------
t_eff93d4e8e7cbb78
  source   : D:\llm\models\.dsh-rdm-data\history\t_eff93d4e8e7cbb78.samples.jsonl ; D:\llm\models\.dsh-rdm-data\history\t_eff93d4e8e7cbb78.events.jsonl
  format   : kernel-history  (no meta/build records)
  samples  : 1604   span: 251.61 s   cadence: 6.37 Hz   max gap: 207 ms
  first    : 2026-11-09T13:30:39.519+0800
  last     : 2026-11-09T13:34:51.125+0800
  bytes    : 0 -> 22,359,992,847  (delta 22,359,992,847)
  bps MiB/s: mean 84.43  p50 108.18  p95 114.37  p99 117.12  max 126.52  (1 leading sample(s) excluded)
  bps[0]   : 0.00 MiB/s
  workers  : min 1  max 128  peakWorkers 128
  controller: grow=23 revert=4 shrink=4 backoff=0 rebuild=1 freeze=0 unfreeze=0 tail_freeze=0 other=0
  events   : 42 (completed=1, controller=32, info=1, plan=1, probe=2, retry=3, started=1, verify=1)
  retries  : 3   tail stalls (no body data): 3
  builds   : pre-1.2.0 (no meta)
------------------------------------------------------------------------------

[exit 0]
```

## What the numbers mean

- `builds`/`run ...` lines come from 0.2.2 `kind:"meta"` records; the pre-1.2.0 phases have no meta and are labelled `pre-meta (no meta record)`.

- `bps[0]` is reported separately because a resumed task on the old rate accounting could ship a one-sample spike (e.g. 8,862 MiB/s in the 2026-11-09 batch); `--exclude-leading N` drops a longer spike tail.

- `transferred` is the 1.2.0 per-sample this-run byte counter; it is absent in pre-1.2.0 histories.

- `controller` counts are classified from the event messages: `grow`/`revert`/`shrink`/`backoff` (0.2.1) plus `freeze`/`unfreeze`/`tail_freeze` (0.2.2).

- `tail stalls` counts `retry` events whose message is `no body data ... stalled connection`.

