# 2026-11-10 下载器实测：dsh-rdm vs aria2 vs Gopeed

同一台 Windows 机器、同一网络、同一批 URL 上，对 **dsh-rdm 0.3.0-alpha.2**、**aria2 1.37.0**、
**Gopeed 1.9.3（web/daemon）** 做了 4 类、共 **62 次有效下载**（20.65 GiB）。
所有下载都按官方 SHA-256 校验，**62/62 通过**；原始逐次数据在
[rows.csv](rows.csv)，汇总在 [summary.json](summary.json)。

> 结论先行：**小文件、中文件和大型稳定镜像上 dsh-rdm 最快**；**GitHub 302/签名重定向场景
> aria2 最快**。dsh-rdm 与 aria2 在 1 GiB 稳定镜像上的差距只有约 1%–3.5%，不是数量级差异；
> 小文件上的优势主要来自常驻内核/预检开销更低。Gopeed 在中文件上接近 aria2，但大文件和
> 重定向场景慢 5%–13%，CPU/内存占用也更高。

## 1. 环境与版本

| 项 | 值 |
|---|---|
| 机器 | AMD Ryzen 7 9700X（8C/16T），32 GiB RAM，Windows 11 专业版 10.0.26300 |
| dsh-rdm | `0.3.0-alpha.2`，`bin/win32-x64/rdm-kernel.exe`，协议 2 |
| aria2 | `aria2 1.37.0`（win-64bit build1） |
| Gopeed | `1.9.3`，Windows amd64 web/daemon 版（同一 Go 下载内核；不是 Flutter GUI 前端） |
| 网络 | 本机宽带直连；BFSU 的 Alpine 请求 302 到清华 TUNA，GitHub Release 302 到 Azure 签名存储 |
| 统一 User-Agent | `curl/8.9.1`（原因见 §6：Gopeed 默认 Chrome UA 会被 BFSU/TUNA 以 403 拒绝） |
| 客户端连接数 | aria2 `-x16 -s16`；Gopeed `connections=16`；RDM 固定 `16/16`；RDM 自适应 `8..128` |

## 2. 测试任务

| 任务 | 文件 | 大小 | 重复次数/工具 | 覆盖点 |
|---|---|---:|---:|---|
| small | `alpine-minirootfs-3.20.3-x86_64.tar.gz` | 3,490,290 B（3.3 MiB） | 5 | 小文件、启动/解析开销 |
| medium | `alpine-virt-3.20.3-x86_64.iso` | 63,963,136 B（61.0 MiB） | 5 | 中等文件、16 连接并发 |
| large | `alpine-extended-3.20.3-x86_64.iso` | 1,033,895,936 B（986 MiB） | 5（2 + 3 两批） | 大文件、持续吞吐、内存 |
| redirect | `gopeed-web-v1.9.3-windows-amd64.zip` | 40,411,930 B（38.5 MiB） | 4 | GitHub 302 → Azure 签名 URL |

RDM 额外跑了 **自适应** 配置（`connections=8`，`maxConnections=128`）在 large 上的 5 次；
它不算“同配置”对手，单独列出。

## 3. 绝对结果（中位数）

`MiB/s` 按 1 MiB = 1,048,576 B 计算；耗时包含任务创建/探针/传输/收尾，**不包含** RDM 内核和
Gopeed 服务启动（见 §5 计时口径）。

| 任务 | 工具 | n | 校验 | 耗时中位数 | 耗时范围 | MiB/s | CPU 秒 | CPU % | 峰值 RSS | worker |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| small | aria2 | 5 | 5/5 | 0.247 s | 0.200–0.257 | 13.49 | 0.047 | 18.2% | 13.9 MB | 16 |
| small | Gopeed | 5 | 5/5 | 0.202 s | 0.161–0.213 | 16.47 | 0.047 | 23.2% | 31.5 MB | 16 |
| small | **RDM** | 5 | 5/5 | **0.138 s** | 0.133–0.511 | **24.05** | 0.125 | 67.7% | 18.0 MB | 14 |
| medium | aria2 | 5 | 5/5 | 0.865 s | 0.790–1.077 | 70.50 | 0.469 | 51.2% | 28.7 MB | 16 |
| medium | Gopeed | 5 | 5/5 | 0.851 s | 0.797–1.338 | 71.71 | 0.422 | 42.2% | 45.6 MB | 16 |
| medium | **RDM** | 5 | 5/5 | **0.719 s** | 0.699–1.891 | **84.86** | 0.469 | 67.1% | 40.1 MB | 16 |
| large | aria2 | 5 | 5/5 | 9.608 s | 9.381–15.688 | 102.63 | 6.875 | 71.1% | 29.2 MB | 16 |
| large | Gopeed | 5 | 5/5 | 10.826 s | 9.118–11.964 | 91.08 | 8.375 | 79.1% | 53.1 MB | 16 |
| large | RDM 固定 | 5 | 5/5 | 9.526 s | 9.104–10.072 | 103.50 | 6.594 | 68.6% | 50.1 MB | 16 |
| large | **RDM 自适应** | 5 | 5/5 | **9.272 s** | 9.163–10.841 | **106.35** | 6.062 | 65.4% | 37.5 MB | **10** |
| redirect | **aria2** | 4 | 4/4 | **7.085 s** | 6.158–7.809 | **5.48** | 0.219 | 3.2% | 24.3 MB | 16 |
| redirect | Gopeed | 4 | 4/4 | 7.480 s | 7.118–8.029 | 5.15 | 0.383 | 4.9% | 48.2 MB | 16 |
| redirect | RDM | 4 | 4/4 | 7.311 s | 6.366–7.971 | 5.27 | 0.227 | 3.3% | 37.4 MB | 16 |

## 4. 相对结果（以 aria2 为基准）

负的耗时变化 = 比 aria2 快；正的耗时变化 = 比 aria2 慢。

| 任务 | RDM 固定 16 | RDM 自适应 | Gopeed |
|---|---:|---:|---:|
| small | **−44.1%**（+78.3% 吞吐） | — | **−18.2%**（+22.1%） |
| medium | **−16.9%**（+20.4%） | — | −1.6%（+1.7%） |
| large | −0.9%（+0.8%） | **−3.5%**（+3.6%） | **+12.7%**（−11.3%） |
| redirect | **+3.2%**（−3.8%） | — | **+5.6%**（−6.0%） |

更直观地说：

- **small**：RDM 0.138 s，比 aria2 的 0.247 s 快 **0.109 s**；Gopeed 0.202 s 居中。绝对值都在
  0.25 s 内，适合看“启动/小文件体验”，不适合外推到公网大文件。
- **medium**：RDM 0.719 s，比 aria2 的 0.865 s 快 **16.9%**；Gopeed 0.851 s 与 aria2 基本打平。
- **large**：RDM 自适应 9.272 s < RDM 固定 9.526 s < aria2 9.608 s < Gopeed 10.826 s；
  RDM 固定只领先 aria2 **0.9%**，自适应领先 **3.5%**，都在网络抖动范围内，但方向一致。
- **redirect**：aria2 7.085 s 最快；RDM 7.311 s 慢 **3.2%**，Gopeed 7.480 s 慢 **5.6%**。
  这条链路是 GitHub 签名重定向 + Azure 存储，吞吐只有 5 MiB/s 左右，连接数继续增加没有收益。

## 5. 计时与测量口径

- **RDM**：内核进程启动并 `initialize` 完成后，从 `start` RPC 计时，到 `wait` 返回终态；
  不算内核冷启动。这符合插件中“内核常驻、任务按需启动”的实际形态。
- **Gopeed**：daemon 已启动，从 `POST /api/v1/tasks` 计时，到任务状态 `done`；不算 GUI/daemon
  冷启动。实际桌面用户第一次打开 Gopeed 的启动时间会更长。
- **aria2**：从 `aria2c` 进程启动计时，到进程退出；因此包含约几十毫秒的进程启动开销，对
  3.3 MiB 的 small 略不利。
- 所有工具都下载到本机 NVMe，下载完成后**外部**计算 SHA-256；没有让任何工具在计时窗口内做
  校验，避免把校验时间混入吞吐。每个文件下载后立即删除，避免磁盘空间影响。
- CPU 为该进程（Gopeed 为 daemon 进程在任务期间的增量）的 user+system 时间；CPU% =
  CPU 秒 / 墙钟秒。RSS 为采样峰值。
- 每次任务使用独立的输出文件名；每个工具的每轮顺序随机化；同一任务的所有工具使用同一个
  URL 和 User-Agent。网络、CDN 缓存和 TCP 状态无法完全隔离，所以结论以中位数和方向为主。

## 6. 实测中发现的问题

1. **Gopeed 默认 UA 在 BFSU/TUNA 上会 403。** Gopeed 1.9.3 默认
   `Mozilla/5.0 ... Chrome/116`，对 Alpine 镜像的 `resolve` 返回 `http request fail, code:403`；
   显式设置 `curl/8.9.1` 后正常。为公平比较，三个工具统一使用 `curl/8.9.1`。这说明“换个
   下载器”并不总能绕过镜像的 UA 策略，Gopeed 用户可能需要手动设置请求头。
2. **Gopeed 的 CPU 在大文件/重定向场景偏高。** large 的 CPU 中位数 8.38 s（79.1%），
   aria2 6.88 s（71.1%），RDM 固定 6.59 s（68.6%）；redirect 也更高（0.38 s vs 0.22 s）。
   墙钟上 large 慢 12.7%，所以不是单纯“多线程更吃 CPU 但更快”。
3. **RDM 的自适应不一定比固定 16 更快。** 在 1 GiB 稳定镜像上，自适应只到 10 个 worker，
   中位 9.272 s，比固定 16 的 9.526 s 快 2.7%，但另一批 5 次里固定 16 的某次更快；
   方向是“用更少连接达到同等或略好吞吐”。自适应峰值 RSS 37.5 MB，比固定 16 的 50.1 MB 低。
4. **RDM 小文件 CPU 更高。** small 的 RDM CPU 0.125 s，aria2/Gopeed 都是 0.047 s；
   RDM 的探针、计划和事件记录在 3.3 MiB 文件上摊不平。但墙钟仍最快（0.138 s）。
5. **异常值保留在原始数据中，汇总用中位数。** 例如 large 的 aria2 有一次 15.688 s，
   RDM medium 有一次 1.891 s，RDM small 有一次 0.511 s；这些是网络抖动/缓存边界，不删除，
   但中位数和 min/max 都列出，避免只报最好或最坏一次。

## 7. 结论与选型建议

- **dsh-rdm**：小文件、中文件、稳定大镜像的速度最好；大型文件与 aria2 的差距只有约 1%–3.5%，
  小文件优势约 44%。代价是内存更高（large 50.1 MB vs aria2 29.2 MB），小文件 CPU 更高。
  自适应模式用 10 个 worker 达到与固定 16 相同或略好的吞吐，RSS/CPU 更低，适合“不手工调参”
  的智能体场景。
- **aria2**：large 和 GitHub 重定向场景最快，内存最低，CPU 效率好；但 16 连接需要显式参数，
  小文件进程启动开销使它落后 RDM 约 0.1 s。纯 CLI/脚本、单 URL 大文件仍是强选择。
- **Gopeed**：medium 与 aria2 基本打平，small 也不差；large 慢 12.7%、redirect 慢 5.6%，
  CPU/内存更高，且默认 UA 在部分镜像会被 403。适合需要 GUI、BT/ED2K/扩展等协议面，
  而不是只追求单 HTTP 大文件极限吞吐的场景。

**这不是“dsh-rdm 全面碾压”的结论**：在 1 GiB 稳定镜像上三者都能把 100 MiB/s 级别的链路跑满，
差异主要来自启动开销、连接调度和重定向处理；在 5 MiB/s 的 GitHub 链路上，aria2 反而最好。
上述结果只代表本机、本网络、本次 4 个 HTTP(S) 任务，不外推到 BT、多源、断点续传或跨运营商场景。

## 8. 证据与复现

- 逐次原始数据：[results-final.json](results-final.json)（small/medium/redirect + large 前 2 次）、
  [results-large-3.json](results-large-3.json)（large 追加 3 次）；合并后的 62 行见
  [rows.csv](rows.csv)，汇总见 [summary.json](summary.json)。
- 运行日志：[bench-final.log](bench-final.log)、[bench-large-3.log](bench-large-3.log)。
- 复现脚本：[bench.py](bench.py)、[analyze.py](analyze.py)。依赖 Python 3.13+、`psutil`，
  需要本机存在 aria2 1.37.0 与 Gopeed 1.9.3 web 二进制（脚本中的绝对路径按本机环境设置）。
- 全部 62 次下载 SHA-256 校验通过；总下载量 20.65 GiB。
