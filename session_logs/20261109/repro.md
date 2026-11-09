# 复现这组测量

所有下载/采样调用都是 dsh-rdm 的 `rdm_*` 工具，参数原样记录，便于在内核侧重放。

## 0. 版本识别（不联网）

```powershell
# 目录里的 IQ1_M 规格：download_gb 58.4 / arena_gb 23.4 / 仅 coder 家族
Select-String -Path D:\llm\strata-data\terminal\0.1.58\setup.py -Pattern '"IQ1_M"|\"coder\": \{'
```

```
setup.py:448  "IQ1_M": {"about": "the Coder's only size: half the experts, stored like IQ3_S (3.5 bits)",
              "download_gb": 58.4, "ram_gb": 32, "arena_gb": 23.4, "families": ("coder",)}
setup.py:707  "coder": {"title": "Qwen3.8-Flash-Next Coder", ...}
setup.py:419  CODER_FILES = { 分片1 (29608446496, e11083ba…), 分片2 (28800138432, 316b46f3…), mmproj (907543008, b1a82259…) }
```

## 1. 找国内源

```powershell
# ModelScope 的文件清单（Size + Sha256 自报值）
python -c "import json,urllib.request; ..."   # 见本目录 tools 调用；等价于:
#   https://www.modelscope.cn/api/v1/models/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF/repo/files?Recursive=true

# HF 两个修订的 LFS oid（权威哈希）
https://huggingface.co/api/models/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF/tree/5348543e0147355ac9cbcb031184a3546350988e/IQ1_M?recursive=true
https://huggingface.co/api/models/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF/tree/main/IQ1_M?recursive=true&expand=true
```

## 2. 探针 + 下载

```
rdm_probe
  url=https://www.modelscope.cn/models/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF/resolve/master/IQ1_M/Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00001-of-00002.gguf
# -> 302 到 cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/bf/a3/644db4ad…，27.6GiB，range=bytes，resume=strong

rdm_download
  url=<同上>
  dir=D:\llm\models\coder-iq1_m
  expectedSha256=e11083ba855e7666b48ea3f2db6a9c3a20c18751a012cc24f948de91b7087fad   # 0.1.58 的 pin（第 1 次）
  connections=12
# 12% 时取消；同一 .part 用下面的参数重开（第 2 次），期望值换成 HF main 的 LFS oid:
#   expectedSha256=bfa3644db4adfff072fc946c20994f2909d2cf89879d83f80a4c811d4016c211
#   connections=16  resume=true
# -> resume decision=accepted reason=etag；16→102 workers；106 MiB/s；verify verified:bfa3644d

rdm_download   # 分片 2
  url=…/IQ1_M/Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00002-of-00002.gguf
  dir=D:\llm\models\coder-iq1_m
  expectedSha256=316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113
  connections=12

rdm_download   # 视觉编码器
  url=…/mmproj-Qwen3.8-Flash-Next-BF16.gguf
  expectedSha256=b1a82259702816a5330d7bd7607cd9676b11780e79ff7348c21103ff3ce49bd0
  connections=8
```

## 3. 采样

```
rdm_tasks  taskId=<id> events=30     # 完整记录 + 最近 30 条事件
rdm_tasks  scope=session             # 内核聚合
rdm_history taskId=<id> limit=2000   # 0.3.0 build 才有：samples/events 落盘路径
rdm_control action=cancel taskId=<id>
rdm_wait   taskIds=[…] timeoutSec=300
```

`rdm_history` 在 12:12:09 之前的内核上返回 `[invalid_request] unknown method 'history'`；
之后可用，指向 `.rdm-data/history/<id>.{samples,events}.jsonl`。

## 4. 外部采样（内核无 history 时的唯一序列）

```powershell
python D:\llm\rdm-record\watch_tasks.py --seconds 10800 --interval 2
# 每 2 s 读 .rdm-data/tasks/t_*.json，变化时追加到 samples.jsonl；终态时快照到 snapshots/
```

## 5. 版本差异取证

```powershell
python D:\llm\rdm-record\diff_probe.py    # 16 × 1 MiB 窗口，HF 5348543e vs ModelScope master
# 结果: windows=16 same=1 diff=14 err=1  (见 shard1-diff-probe.txt)

# 单连接吞吐对照（同一对象）
python -c "...Range: bytes=0-33554431..."   # HF: 32 MiB / 241.5 s = 0.13 MiB/s
                                            # MS: 32 MiB /   2.3 s = 13.9 MiB/s
```

## 6. 校验

- 内核 finalize 自己算 SHA-256：分片1 `verified:bfa3644d`（15 s）、分片2 `verified:316b46f3`（15 s）、
  mmproj `verified:b1a82259`（0.55 s）。
- 与 pin 的关系：分片2 与 mmproj 的哈希 = `CODER_FILES` 的 pin；分片1 = HF **main** 的 LFS oid，
  不是 0.1.58 pin 的 `e11083ba`。

## 已知观测偏差

- 12:05:50–12:12:09 的第一次分片1 没有逐样本序列（旧 build 不落盘），只有聚合值（avg 5.7 MiB/s、peak 13.4、12 workers、`origin-slow`）。
- 三个任务并发时互相抢带宽；跨任务速率不可横向比较。
- `avgBps` 在续传任务上失真（分片2 的 1.8 GiB/s 是 245 ms 收尾的产物）。
