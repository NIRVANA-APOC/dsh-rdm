# dsh-rdm 会话数据导出 — Qwen3.8-Flash-Next Coder IQ1_M（ModelScope）

导出时间：2026-11-09 12:2x (+08:00)　会话：`session-cf09812a-9a90-43db-b42c-827303a6c053`
内核：RDM 1.1.0，**本次会话跨越两个 build**（见 §4）

这份包有两个用途：一是回答"图里是哪一版量化、有没有国内源、下没下下来"；二是给 dsh-rdm 0.3.0 留一份
真实下载的逐样本记录（上一份基线是 `session_logs/` 根目录下 2026-11-09 00:40 的那一包）。

---

## 1. 图里的版本：Coder · IQ1_M

截图那一行是 Strata 目录里的 **`Qwen3.8-Flash-Next Coder` 家族唯一的规格 `IQ1_M`**
（ISTA-DASLab 的专家裁剪版，GSQ-RCO 量化族）：

| 界面字段 | 来源 | 核对 |
|---|---|---|
| `Coder IQ1_M` | `FAMILIES["coder"]` + `MODELS["IQ1_M"]`（`setup.py:448`、`setup.py:707`） | IQ1_M 只属于 `families=("coder",)` |
| `下载 58.4 GB` | `download_gb: 58.4` | 实际两分片 `29,608,446,496 + 28,800,138,432 = 58,408,584,928` B = 58.41 GB |
| `GSQ-RCO` | 仓库名与文件名前缀 `…-GSQ-RCO-IQ1_M-…` | 与 Unsloth 的 `UD-IQ1_M` 不是同一个文件 |
| `24.4 GB 内存 + 显存` | `arena_gb: 23.4` + ~1 GB dense | 23.4 + 1.0 = 24.4（`setup.py` 对同类数字的算法） |

即：**IQ1_M**（1.75 bpw 级别的 i-quant，专家裁剪到 256/512），不是 Q2_0 / IQ2_XS / IQ3_S，也不是 Unsloth 的 `UD-IQ1_M`。

已下载到 `D:\llm\models\coder-iq1_m\`：

| 文件 | 字节 | SHA-256（本机校验） |
|---|---:|---|
| `Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00001-of-00002.gguf` | 29,608,446,496 | `bfa3644d…6c211` ✅ |
| `Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00002-of-00002.gguf` | 28,800,138,432 | `316b46f3…1e113` ✅ |
| `mmproj-Qwen3.8-Flash-Next-BF16.gguf` | 907,543,008 | `b1a82259…49bd0` ✅ |

---

## 2. 国内源：有，但存在版本漂移（本次最重要的发现）

**有**：ModelScope 同名仓库 `ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF`，文件路径与文件名与 HF 完全一致；
`setup.py` 的 `--source modelscope` 就是走 `https://www.modelscope.cn/models/<repo>/resolve/master/<path>`。
实测吞吐：单连接 13.9 MiB/s，16→102 连接均值 **106 MiB/s**（同对象 HF 单连接只有 **0.13 MiB/s**）。

**但是**：魔搭给的是仓库**当前**文件，Strata 0.1.58 钉的是 2026-09-29 的修订 `5348543e`：

| 文件 | 0.1.58 钉住（HF 5348543e） | ModelScope / HF main | 结论 |
|---|---|---|---|
| 分片 1 | `e11083ba…87fad` | `bfa3644d…6c211` | **不同**（同大小、同头尾，中间大量不同） |
| 分片 2 | `316b46f3…1e113` | `316b46f3…1e113` | 相同（这份是共享的 n-gram 表） |
| mmproj | `b1a82259…49bd0` | `b1a82259…49bd0` | 相同 |

来源可考：HF API 上 main 的分片 1 最后一次提交是 `d1d94679`（2026-10-19）
"*Replace first shard with updated expert-pruned model*"，仓库 README 写着
"**Update, October 17, 2026.** … Only the first shard changed; if you downloaded the earlier build, re-download that shard"
（SWE-bench Verified 75.60 → 79.20，LiveCodeBench v6 86.28 → 87.43）。不是镜像篡改，是上游换版。

量化差异（`shard1-diff-probe.txt`）：在 29.6 GB 上均匀取 16 个 1 MiB 窗口对比两个版本 ——
**14 个不同、1 个相同、1 个取数失败**，即整个分片被重写，不是局部补丁。

**直接后果**：`setup.py:3314` 对 ModelScope 的副本也按**同一个 HF pin** 校验
（`pin = REPO_PINS.get(ms[0], ...)`），所以 0.1.58 用 `--source modelscope` 装 Coder IQ1_M 时，
分片 1 会被判为与 pin 不符 → `verify_sha256` 走 `.bad` + 重下，最终装不上。
本次是手工下载 + 按 **HF main 的 LFS oid**（`bfa3644d…`）校验通过，文件本身可用，只是与 0.1.58 的 pin 不是同一版。

> 给 Strata 侧的建议：`verify_sha256` 已有 `also=`（同一文件的多份可接受哈希）机制，
> 可以给 IQ1_M 分片 1 加上 2026-10-19 版的 `bfa3644d…`，或把"当前版"记进安装记录；
> 否则"国内源可用"这件事在产品上仍然走不通。

**旁证（12:20:36）**：两个分片的 `.done` 标记出现在 `D:\llm\models\coder-iq1_m\`，文本是
`whole (checked against its own tensor directory)` —— 这是 `mark_whole_unless_pinned` 给"手工拷入的文件"
写的标记，只证明**长度与它自己的 tensor 目录一致**，不校验 pin。本机有一个 2026-11-08 起就在跑的
Strata python 进程（pid 46168，`strata-data\terminal\current\python\python.exe`），标记应来自它。
因为 `download()` 对带 `.done` 的文件直接跳过，**之后的 Strata setup 不会再哈希这两个分片** ——
想确认拿到的是哪一版，看本包的 SHA-256（分片 1 = `bfa3644d…` = 10/19 版，不是 0.1.58 的 `e11083ba…`）。

---

## 3. 本次下载的完整记录

| 任务 | 文件 | 大小 | 请求/实际连接 | 传输 | 均值 | p50 / p95 | 峰值 | 校验 |
|---|---|---|---:|---:|---:|---:|---:|---|
| `t_248a5911009cc18d` | mmproj | 866 MiB | 8 / 8 | 20.3 s | 39.9 MiB/s | — | 56.7 | ✅ `b1a82259` |
| `t_7359f357ea3922cb` | 分片 2 | 26.82 GiB | 12 / 12 | 6 m 20 s（重启后 245 ms 收尾） | 72.3 MiB/s | — | 88.9 | ✅ `316b46f3` |
| `t_6a665d4e17fa3100` | 分片 1（第 1 次，取消） | 27.58 GiB | 12 / 12→20 | 7 m 17 s（下载 12%） | 5.7（旧 build）→ 20.5（新 build 58 s） | 10.9 / 51.4 | 55.3 | — 取消，`.part` 保留 |
| `t_ebda50bb99a77a14` | 分片 1（第 2 次） | 27.58 GiB | 16 / 16→102 | **5 m 24 s** | **106.3 MiB/s** | **107.5 / 114.1** | 102 | ✅ `bfa3644d` |

时间线（本地 +08:00）：

```
12:05:33  内核 A（pid 53520）启动；无 history 目录，rdm_history → unknown method history
12:05:49  分片1 probe：29,608,446,496 B，ranges=true，302 → cdn-lfs-cn-1
12:05:50  三个任务 plan + started（8 MiB 分块，12/12/8 连接）
12:06:11  mmproj 完成并校验 b1a82259
12:12:09  内核重启（pid 59852，0.3.0 build）→ 三个任务 interrupted，自动重排
12:12:39  自动恢复：分片1 从 2,359,836,648 B 续传；分片2 从 28,798,211,398 B 续传（几乎完整）
12:12:54  分片2 校验 316b46f3（哈希 15 s）
12:13:38  取消第一次分片1：保存恢复状态 3,676,430,303 B
12:13:42  第二次分片1（expected=bfa3644d，16 连接）从同一 `.part` 续传 3,676,430,303 B
12:15:10  控制器 grow 30 → … → 12:18:34 grow 102，instant 113 MiB/s
12:18:45  shrink 90 → 79 → 70（average rate falling）
12:18:56  尾部 chunk 两次 "no body data for 10 s (stalled connection)" 重试
12:19:06  完成（324,260 ms）；12:19:21 哈希校验通过
```

---

## 4. 与 2026-11-09 00:40 基线对比：修好了什么

| 00:40 的结论 | 本次观测 | 状态 |
|---|---|---|
| 续传是坏的（plan 恒为 `0 resumed bytes`） | 两次都 `resume decision=accepted reason=etag`：2.36 GB / 28.80 GB / 3.676 GB（跨任务、跨 build、甚至换了 expectedSha256 也接上了） | **已修** |
| 内核从不主动加并发 | `grow to N` 从 16 一路上到 102，`pool rebuild #1`、`revert`、`shrink` 都出现 | **已修** |
| 吞吐塌陷无恢复 | 本次未复现塌陷；103 MiB/s 平台期维持 ~3 分钟 | 未复现 |
| 逐样本 telemetry 不落盘 | `<data-dir>/history/<id>.{samples,events}.jsonl` 已落盘，2097 条 / 324 s ≈ 6.5 Hz | **已修**（但有缺口，见 §5.1） |
| 多源竞速 | 同对象 HF 0.13 MiB/s vs ModelScope 106 MiB/s | 仍然值得做 |

---

## 5. 仍然存在的问题（按建议优先级）

1. **history 的覆盖与 build 归属**：录制从 12:12:09 的新 build 才开始 ——
   mmproj 无记录（只有聚合值），分片 2 只有 2 条样本，第一次分片 1 的 5.7 MiB/s 阶段（12:05:50–12:12:09）无序列。
   一次会话跨两个 build 时，序列无法对齐。建议：`samples.jsonl` 首行写
   `{"kernel_build":…, "started":…, "resume":…}`（或在文件名里带 build），并在任务重建时把旧 build 的聚合值单列。
2. **控制器抖动**：12:16:47–12:18:05 之间 `grow to 72 → revert to 64` 连续 4 次，
   每次 16–21 s 后又 grow；期间 instant 一直在 107–113 MiB/s，属于"每连接速率稀释"阈值过敏感。
   建议 revert 后加 ≥30 s 冷却，或对 per-connection 速率做 EMA 再比较。
3. **尾部长尾**：最后 3 个 chunk 触发 2 次 10 s 无数据重试，同时 shrink 102→70。
   建议剩余 chunk ≤ target 时冻结 target，并对每个尾 chunk 单独 2 次快速重试（现在要等 10 s）。
4. **回执口径**：`plan` 写 `connections=8`（请求 16），实际 workers 16→102；
   `resume state saved: 17 chunks / 3,676,430,303 bytes` 与 8 MiB 分块自相矛盾（17×8 MiB=136 MB），
   下一次却报 `422 chunks / 3,676,430,303 bytes`。建议 plan 输出 requested/initial/target 三个数，
   chunk 计数和已落盘字节分开写。
5. **校验串行**：26.82 GiB 15 s、27.58 GiB 15 s（≈1.8 GB/s），占 339 s 的 4.4%；
   可以在最后 1–2 个 chunk 落地时就开始流式哈希。
6. **旧 build 的 `rdm_history` 返回 `unknown method history`**：工具 schema 有、内核没有；
   建议在 409/404 之外回一个可读的 `unsupported`，或在工具描述里标 build 要求。

---

## 6. 文件清单

| 文件 | 内容 |
|---|---|
| `tasks.json` | 4 个任务的最终内核记录（verbatim）+ 两个 build + 覆盖面（哪些任务有/没有 history） |
| `events.csv` | 内核事件流（`probe/plan/started/controller/resumed/retry/verify/completed/cancelled`），UTC + 本地时间 |
| `telemetry-kernel.csv` | **内核原始逐样本序列**（10 Hz 上限，2097+376+2 行）：bytes/bps/w1/w5/w30/w300/workers/stalled |
| `telemetry-kernel/` | 上述 CSV 的原始 `.samples.jsonl` / `.events.jsonl`（逐任务，未加工） |
| `telemetry-observed.csv` / `samples.jsonl` | 我的 2 s 外部采样（12:14:05–12:20:16，740 行），用于交叉校验内核记录 |
| `kernel-history.json` | 逐任务统计：样本数、时间跨度、均值/p50/p95/峰值、workers 区间、stall 峰值 |
| `record.json` | 任务级汇总（含 worker 变化点时间戳） |
| `tasks-final/` `snapshots/` | 内核任务记录原文件 / 终态快照 |
| `gguf-shard1.txt` `gguf-shard2.txt` | GGUF 头探测（v3；分片1 1223 tensors，分片2 是 n-gram 表） |
| `shard1-diff-probe.txt` | 16 个 1 MiB 窗口的版本差异对比 |
| `watch_tasks.py` `summarize.py` `build_package.py` `make_tasks_json.py` `diff_probe.py` | 采样/汇总/打包脚本，可原样重跑 |

---

## 7. 口径说明

- 时区：本地 +08:00；内核事件原始时间是 UTC（`events.csv` 两列都给）。
- 采样：内核 ≤10 Hz（实际 ~6.5 Hz），外部采样 2 s；两个任务并发时互相抢带宽，跨任务速率不可横向比较。
- `avgBps` 在续传任务上失真：分片 2 的 1.8 GiB/s 是"245 ms 内收尾"的产物，不是传输速率；看 `telemetry-kernel.csv` 的 `bps` 列。
- `max bps` 会包含 finalize 瞬间的突发（分片 1 的 8.7 GiB/s），不代表下载速度。
