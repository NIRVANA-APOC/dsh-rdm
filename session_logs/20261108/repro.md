# 复现这组测量

所有调用都是 MCP `rdm_*` 工具，参数原样记录，便于在内核侧重放。

## 1. 选源前的探针

```
rdm_probe
  url=https://modelscope.cn/models/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF/resolve/master/Q2_0/Qwen3.8-Flash-Next-GSQ-RCO-Q2_0-00001-of-00002.gguf
```
返回：`hop 302 → cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/69/82/0c02…`，`range=bytes resume=strong`，`probe=479ms`。
同一 URL 走 huggingface.co 时：单连接 16 MiB 需 56.1 s（0.29 MB/s）。

## 2. 启动下载（带内容校验）

```
rdm_download
  url=https://modelscope.cn/models/ukisai/Swift-1.5-Qwen3.8-Flash-Next-GSQ-RCO-GGUF/resolve/master/Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-00001-of-00002.gguf
  dir=D:\llm\models\swift-iq2_xs
  fileName=Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-00001-of-00002.gguf
  expectedSha256=ca3b302d3d1eb6eddce3ea4acc79854e6cc5fdc0583e374a6a8b6bb67327743b
  connections=32
```

`expectedSha256` 来自 Strata `setup.py` 的 `SWIFT_FILES` 钉住值，与 HF LFS oid、ModelScope 仓库元数据三方一致。

## 3. 采样

```
rdm_tasks taskId=<id> events=30        # 完整记录 + 最近 30 条事件
rdm_tasks                              # 内核聚合（scope=session）
rdm_tasks scope=all status=running     # 跨会话视图
rdm_wait taskIds=[...] timeoutSec=300  # 长轮询，替代忙等
```

## 4. 取消与重启（用于验证续传）

```
rdm_control action=cancel taskId=t_c613ac4273c89aa9
rdm_download ... resume=true connections=32
```
重启后的 plan 事件：`4744 chunks of 8388608 bytes, 32 workers, 0 resumed bytes` → **续传未生效**。

## 5. 校验

内核在 finalize 阶段自行 SHA-256：
- 分片2：`verify state=verified sha=verified:e4996a6d…`（16 s）
- mmproj：`verify state=verified sha=verified:cd1140f4…`
- 分片1：进行中，导出时 `verify state=not-compared`

## 已知观测偏差

- 瞬时速率来自会话内多次 `rdm_tasks` 采样（8 个点），不是内核的逐样本序列，不能用于画秒级曲线。
- 事件时间戳为 UTC，本地为 UTC+08:00。
- 同一时刻三个任务并发时会互相争抢带宽，跨任务的速率不可直接横向比较；同一任务内部的时序比较有效。
