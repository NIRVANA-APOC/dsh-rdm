# Real-network multi-source benchmark — 2026-11-09

This is the first **real-network** measurement of the 0.3.0 multi-source
kernel. It downloads the same public object from real HTTP mirrors and compares
single-source, `select`, and `race` policies.

## Setup

| item | value |
|---|---|
| object | `alpine-standard-3.20.3-x86_64.iso` |
| size | 219,152,384 B (209 MiB) |
| SHA-256 | `c66fc1e0470781f8ecbab8eb9cc8d906066171a5e0c6c1ab20aedc7061836d27` (published by Alpine; verified after every run) |
| kernel | `rdm-kernel 0.3.0-alpha.1`, protocol 2, `bin/win32-x64` (5,349,376 B, sha256 `40BAD44D89F9312983721338CD9D29704D15FE4935FD376D185FB0D7873D5DCB`) |
| host | Windows 11 x64, wired network in this session; 2026-11-09 |
| kernel settings | `connections=8`, `maxConnections=32`, `maxAttempts=6`, `autoResume=false` |
| benchmark | [`tests/real-multi-source-bench.mjs`](../../tests/real-multi-source-bench.mjs) |

Mirrors used (all HTTP, all range-capable, same object and SHA):

* `dl-cdn.alpinelinux.org` — official CDN, the "go-to" default in many scripts
* `mirrors.bfsu.edu.cn` — BFSU mirror
* `mirrors.cernet.edu.cn` — CERNET mirror
* `mirror.nju.edu.cn` — NJU mirror

A shell reconnaissance of the first 20 MiB showed a wide spread (official
~2.4 MB/s, BFSU/CERNET ~53 MB/s, NJU ~25 MB/s); the kernel's 256 KiB probe then
picked BFSU automatically. Shell samples are context only; the numbers below
are the kernel runs.

## Results (final kernel, one run per scenario)

| scenario | policy | transfer | effective | avgBps | selected | bytes per source |
|---|---|---:|---:|---:|---:|---|
| single official CDN | `single` | **23.73 s** | **8.81 MiB/s** | 8.62 MiB/s | 0 | official 209 MiB |
| single BFSU | `single` | **2.11 s** | **99.24 MiB/s** | 91.63 MiB/s | 0 | BFSU 209 MiB |
| official + BFSU | `select` | **2.08 s** | **100.53 MiB/s** | 78.81 MiB/s | **1 (BFSU)** | official 0 / BFSU 209 MiB |
| BFSU + CERNET | `race` | **2.12 s** | 98.45 MiB/s | 90.28 MiB/s | 0 | BFSU 149 MiB / CERNET 60 MiB |
| BFSU + CERNET + NJU | `race` | **2.11 s** | 98.86 MiB/s | 84.04 MiB/s | 0 | BFSU 94.8 / CERNET 114.2 / NJU 0 MiB |

`effective` = object size ÷ kernel `timing.transferMs`; `avgBps` is the kernel's
whole-task average (includes the serial SHA-256 finalize, so it is lower).

### Headline

* **`select` vs single official CDN: 11.41× faster** (23,731 ms → 2,079 ms),
  and it picked the fast mirror without any URL ordering hint.
* **`select` vs the best single mirror: 1.01×** — selection matched the best
  manual choice instead of losing to it.
* **`race` vs the best single mirror: ~1.00×** on this object/network. It did
  use both fast sources (149+60 MiB and 95+114 MiB), but the last-mile/link
  ceiling (~100 MiB/s here) meant no aggregate gain over the best single
  mirror. It is a valid opt-in for genuinely independent bottlenecks, not a
  default speed switch.
* **Race scheduler defect found and fixed:** the first implementation picked the
  single highest-scored source and only moved to another when a per-source cap
  was hit. With 8 workers and a cap of 10, all bytes went to one mirror, so
  `race` looked identical to `select`. The final scheduler uses weighted
  least-loaded assignment and ignores a source measured below 50 % of the best
  until all better slots are busy. The before/after evidence is in
  `bench-before-race-fix.log` vs `bench-final.log`:
  * before: 3-source race = **3.99 s**, slow NJU still received a long-tail
    chunk (0.8 MiB) and dragged the finish;
  * after: 3-source race = **2.11 s**, NJU receives 0 bytes and is excluded.
* All runs completed with the published SHA-256 verified.

## Caveats

* One run per scenario; mirror load, CDN routing and local link conditions
  vary. The ~100 MiB/s ceiling is this host/network, not a kernel limit.
* The official CDN was unusually slow from this host in this session; that is
  exactly the condition `select` is designed for. Absolute numbers will differ
  elsewhere.
* `avgBps` includes the post-transfer SHA-256; `effective` uses the kernel's
  transfer timer and is the better throughput comparison.
* The benchmark downloads and deletes 209 MiB per scenario. The script uses
  per-scenario kernel data/download dirs so the origin ledger does not leak
  between runs.

## Reproduce

```bash
node tests/real-multi-source-bench.mjs
```

Output: `tests/.tmp-e2e/real-multi-source-bench.json` + console log. The
archived final run is in this directory (`bench-final.json`,
`bench-final.log`), with the pre-fix race log alongside.
