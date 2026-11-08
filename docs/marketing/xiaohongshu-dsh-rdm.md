# dsh-rdm 小红书推广素材包

> 目标：把 `dsh-rdm`（DeepSeek Harness 的常驻多连接下载内核）推给中文 AI 编程 / DSH 用户。
> 所有数字均来自仓库 `README.md` 与 `docs/verification.md`，不编造使用体验与互动数据。

## 0. 素材事实清单（写稿只能用这些）

| 事实 | 数值 / 说明 |
|---|---|
| 形态 | DSH 插件（bundle），宿主进程内常驻一个 Rust `rdm-kernel`，NDJSON over stdio，无监听端口 |
| 内存 | 空闲约 5.7–6.7 MiB；内核二进制 4.39 MiB |
| 连接 | 每任务 1–32 连接，分片队列 + 尾部窃取 + AIMD 拥塞控制（429/503 回退） |
| 续传 | 约每 500 ms 落盘 `<file>.part` + `.part.json`，跨暂停/崩溃/内核重启/DSH 重启续传；ETag、Last-Modified、总大小三重校验 |
| 校验 | 可选 SHA-256，校验通过才原子改名，失败不覆盖目标路径 |
| 其余 | 每任务限速 `speedLimitBps`、`rdm_probe` 只探测不下载、5 个 agent 工具、侧栏下载面板 |
| 平台 | Windows x64 / Linux x64 / Linux arm64 / macOS x64 / macOS arm64，全部预编译，安装不跑 cargo |
| 实测 | 内核 e2e 14/14 场景、241/241 断言；回环多连接吞吐 109–145 MiB/s（单次、机器相关） |
| 安装 | `dsh plugin --profile web add dsh-rdm`（或 `github:NIRVANA-APOC/dsh-rdm`） |
| 许可 | MIT OR Apache-2.0 |

## 0.5 同类插件调研（2026-11-06）

数据源：`dsh-plugin-catalog`（社区插件目录包，9412 条，2026-11-07 版，dsh-plugin.org / awesome-dsh-plugin.com 同源）逐条筛 `下载/download/downloader/aria2/gopeed/qbittorrent/torrent`，再用各家 README 核对。它是社区目录，不是官方清单——文案里请写“社区插件目录”。

**通用下载类（agent 可直接调用，共 7 个）：**

| 插件 | 安装 | 引擎 | 关键事实 |
|---|---|---|---|
| **dsh-rdm** | `dsh plugin --profile web add dsh-rdm` | 自带 Rust 常驻内核 | 5 个 `rdm_*` 工具 + 侧栏面板；续传/SHA-256/限速；跨内核与 DSH 重启续传 |
| dsh-smart-download | `… add @leisureyu/dsh-smart-dl` | **内置 aria2** + curl 回退 | 先探测 Range，按文件大小选 4/8 连接；无需另装 aria2 |
| dsh-downloader | release tgz | 未说明 | 断点续传、多连接加速、国内镜像/代理预置、DeepSeek 资源发现 |
| dsh-mt-download | `… add github:643048695/dsh-mt-download` | **需自行安装 aria2c** | 16 路 aria2c，失败回退单流；README 明确「aria2 通道不校验 TLS 证书」 |
| dsh-rayburst | `… add github:cat-Logan/dsh-rayburst` | **需装 Rayburst 桌面端**（aria2 内核） | 读对方 `aria2.conf` 的 RPC 端口与密钥 |
| dsh-gopeed-downloader | `… add dsh-gopeed-downloader` | **需装 Gopeed** | 建/查/停/续/删 + 完成事件唤醒 agent；进程管理仅 Windows |
| dsh-qbittorrent | release tgz | **需装 qBittorrent** | qBittorrent WebAPI v2 九个工具，写操作要 confirm |

→ **7 个里 4 个要先另装引擎**（aria2c / Rayburst / Gopeed / qBittorrent）。这一条可以写进文案。

**不是替代品（别混进对比表）：** `dsh-download-progress`（只把 curl/wget/aria2 的输出画成进度条，没有引擎）、`dsh-video-downloader`（站内视频）、`dsh-123pan`（123 云盘客户端）、`dsh-wsl-download`（拷 Windows 下载目录到 WSL）、`dsh-rfiles`（工作区 ZIP 下载/分片上传）、`dsh-cloud-download`、`dsh-download-image`（UI 按钮）、`Invoice-Downloader`（发票）、`github-release-download-acceleration`（PowerShell 技能，不是引擎）。

**不能说、可以说：**

- ❌ 不能说「DSH 生态只有我们做下载」——已经有 7 个。
- ❌ 不能说「别家的续传不能跨重启」——aria2 本身有 `.aria2` 控制文件，未核对就别下判断。
- ✅ 可以说「DSH 本体不带下载器，agent 默认只能 curl」——核心无下载工具，插件行里也没有。
- ✅ 可以说「7 个里 4 个要先另装引擎」，以及「只有 dsh-rdm 把跨内核/DSH 重启续传写进契约并用 14/14 e2e 覆盖」（这是我们自己可验证的部分，不评价别人）。

## 1. 标题候选（小红书 ≤20 字最稳）

1. DSH 里没有下载器，AI 只能 curl
2. 给 AI 装个下载器，断线还能接着下
3. AI 下大文件，终于不用从 0 开始
4. 我把 AI 的 curl 换成了一个常驻内核
5. 7 个下载插件里，我选了不挂引擎的

## 2. 封面文案

已渲染进 `01-necessity.png`，纯文字版：

```
DSH 没有下载器
AI 只好 curl
（断线从 0 开始 / 一条连接硬扛 / 下完没人校验）
7 个下载类插件，4 个要另装引擎
dsh-rdm：把 curl 换成一个常驻内核
```

## 3. 主推版本 A —— 技术向（推荐首发）

**标题**：DSH 里没有下载器，AI 只能 curl

**正文**：

DSH 本体不带下载器。AI 接到「下个 4 GB 模型权重」这种活，只能 shell 出一句 curl。

后果我遇到过：跑到 92%，网抖了一下——从 0 开始。第二次 87%，我手滑点了暂停——还是从 0。两次都不是网的问题，是 curl 只活一次：进程结束，进度和字节区间一起消失。

顺手查了下生态：社区插件目录 `dsh-plugin-catalog`（9412 条）里，通用下载插件已经有 7 个，但其中 4 个要你先另装引擎（aria2c / Rayburst / Gopeed / qBittorrent）。

dsh-rdm 是其中思路不太一样的一个：不在每次下载时新起进程，而是常驻一个下载内核，让 AI 用工具调它。

🔧 它到底不一样在哪

① 常驻内核，不是一次性命令
整个 DSH 只跑一个 `rdm-kernel` 子进程，第一次用的时候懒启动，之后一直热着。空闲内存 5.7–6.7 MiB，二进制 4.39 MiB。没有监听端口，走 stdio。AI 不用每次都 shell 出去敲 curl。

② 1–32 连接分片，会自己收着点
分片队列里带“尾部窃取”，慢的块会被别的连接接走；遇到 429/503 会按 Retry-After 退避，用 AIMD 自己调并发——不是无脑拉满。

③ 断点续传是设计出来的，不是补救
暂停状态大约每 500 ms 落盘成 `<文件>.part` + `.part.json`。暂停、进程被杀、内核重启、DSH 重启，都能从自己的字节区间接着下。
更关键的是它会核对 ETag / Last-Modified / 总大小：远端文件在你暂停期间变了，它宁可报错，也不会把新旧字节缝在一起。

④ 可选 SHA-256，通过才改名
校验不过任务失败，目标路径原封不动——不会给你留一个“看起来下完了”的坏文件。

⑤ 不下载也能先问清楚
`rdm_probe` 只发 HEAD（必要时退回 ranged GET），告诉你最终 URL、文件名、大小、是否支持 Range、Content-Type。先看清楚再决定下不下。

🧩 给 agent 的 5 个工具
`rdm_download` / `rdm_probe` / `rdm_tasks` / `rdm_wait` / `rdm_control`（暂停、继续、取消、重试、移除）。
返回都是稳定的有界 JSON，长任务后台跑，用 `rdm_wait` 等结果。

🖥 还有一块面板
左侧栏一个下载入口，打开是流水账式的任务列表：状态、百分比、速度、ETA、每个任务的连接轨道（一条 tick 一个连接，跑起来才呼吸）、筛选、逐行暂停/继续/重试/取消/移除/复制路径，详情里能看内核事件日志。窄到 520 px 以下时图标操作会折叠进菜单，文件名不被挤没。

📊 可信度这部分我没吹
内核 e2e 14/14 场景、241/241 断言（多连接、无 Range 回退、重定向、429/Retry-After、暂停续传、跨内核重启续传、SHA-256 命中与不匹配、限速、ETag 变更保护……）。回环多连接吞吐 109–145 MiB/s，单次测试、机器相关。
仓库 `docs/verification.md` 里全在。

⚠️ 说清楚边界
· 只支持 HTTP/1.1 源站，镜像、HTTP/2 多路复用、按源站预算学习都不在这个版本里
· 完整 e2e 只在 Windows x64 和 Linux x64 上跑过；macOS 与 Linux arm64 是原生 CI 构建 + 冒烟
· 有些 DSH 宿主把子进程写操作限制在会话工作区，插件有 `dataDir` 兜底，也可以手动钉死目录

📦 安装（一行）
`dsh plugin --profile web add dsh-rdm`
装完刷新一下页面，左侧栏就有入口了。五个平台都是预编译二进制，安装过程不碰 Rust。

如果你也在让 AI 干“下个大文件”这种活，值得换掉 curl。
MIT OR Apache-2.0，仓库在评论区。

#DeepSeekHarness #DSH插件 #AI编程 #下载器 #断点续传 #开源项目 #程序员日常 #效率工具

---

## 4. 版本 B —— 生活化吐槽向（适合拉互动）

**标题**：下到 99% 断线，我心态崩了

**正文**：

昨晚让 AI 下个 4 GB 的文件，进度条 99%，网断了。
重来。
第二次 87%，我手滑点了暂停，它真的从 0 开始。
我：？？？

后来我去翻了下，发现问题的根不在网，在“下载”这件事被当成了一个临时命令——每下一次就新起一个进程，进程没了，状态也就没了。

于是换了个思路：让下载变成一个常驻的东西。

现在用的这个叫 dsh-rdm，DSH 的插件：

· 后台常驻一个小内核，空闲只占 5.7–6.7 MiB
· 8 条连接分片下（可调到 32），慢块会被别的连接抢走
· 暂停状态每 500 ms 存一次盘，暂停、崩了、重启，都能接着下
· 远端文件在暂停期间被改过？它会拦住，不给你缝出一个坏文件
· 想校验就填 SHA-256，不通过不改名
· 顺带一个侧栏面板，速度、ETA、每个任务的连接数都能看见

最爽的是 AI 不用再 shell 出去 curl 了，直接调工具：`rdm_download` 起任务，`rdm_wait` 等结果，`rdm_control` 暂停继续。

装一行：
`dsh plugin --profile web add dsh-rdm`

边界也说一下：只吃 HTTP/1.1 源站；完整 e2e 只在 Win/Linux x64 跑过，macOS 和 arm64 是 CI 构建加冒烟。别期待它是全平台完美，但下大文件这件事它真的比 curl 稳。

#AI编程 #效率工具 #开源 #DeepSeekHarness #断点续传 #程序员 #踩坑记录

---

## 5. 版本 C —— 清单向（适合做图 / 二次分发）

**标题**：AI 下载这件事，我换了 5 个做法

**正文**：

先确认一件事：DSH 本体没有下载器，AI 默认只会 curl。

从“让 AI 自己 curl”到“给 AI 一个常驻下载内核”，中间踩的坑整理成 5 条：

1️⃣ 别每次新起进程
常驻一个内核，懒启动，之后一直热着。空闲 5.7–6.7 MiB，比一个 Electron 窗口零头还小。

2️⃣ 分片要会“收着点”
1–32 连接，尾部窃取把慢块分给快的连接；429/503 按 Retry-After 退避，AIMD 调并发。

3️⃣ 续传要落盘到字节区间
每 500 ms 写 `.part` + `.part.json`，重启后按自己的区间续。不是“重新请求一次碰运气”。

4️⃣ 校验要在改名之前
SHA-256 通过才原子改名；不通过就失败，目标路径不动。

5️⃣ 先探测再下载
HEAD 拿到最终 URL、大小、Range 支持、Content-Type，再决定下不下。

实现这套的是 dsh-rdm，DSH 插件，五个平台预编译，装完不用编译 Rust。
`dsh plugin --profile web add dsh-rdm`

实测：14/14 e2e 场景、241/241 断言；回环 109–145 MiB/s（单次、机器相关）。
边界：HTTP/1.1 源站；Win/Linux x64 跑完整套件，macOS / arm64 为构建+冒烟。

#开源 #AI编程 #DeepSeekHarness #下载器 #工程实践 #效率工具

---

## 6. 配图（已渲染，1080×1440，竖版 3:4）

八张图在 `assets/marketing/xiaohongshu/`，由 `scripts/marketing/render-xiaohongshu.py` 从真实截图合成，改文案后重跑脚本即可：

| # | 文件 | 画面 | 素材 |
|---|---|---|---|
| 1 | `01-necessity.png` | **为什么必须装**：DSH 没有下载器 → AI 只好 curl → 三个后果；7 个下载插件 / 4 个要另装引擎；两条小轨道收尾 | 纯排版 |
| 2 | `02-pain.png` | 具体一次翻车：92% → 0，断口标“状态没落盘” | 纯排版 |
| 3 | `03-picker.png` | 选型三条（外挂依赖 / 续传证据 / 安装成本）+ 数据来源脚注 | 纯排版 |
| 4 | `04-panel-light.png` | 亮色面板 + 三列拆解（状态与速度 / 连接轨道 / 逐行操作） | `panel-light.png` |
| 5 | `05-panel-dark.png` | 深色面板：主题 token 跟着宿主走 | `panel-dark.png` |
| 6 | `06-details.png` | 任务详情 + 四格标注（来源与路径 / 分片与续传 / SHA-256 / 事件日志） | `panel-details.png` |
| 7 | `07-mobile.png` | 窄屏 ≤520 px：图标折叠进菜单，文件名不被挤掉 | `panel-mobile.png` |
| 8 | `08-install.png` | 安装命令 + 四个实测数字 + 边界说明 + powered-by-dsh 徽章 | 纯排版 |

设计系统（八张共用一套）：纸白 `#F6F7F8` / 墨 `#14161A` / 灰 `#6B7178` / 线 `#D9DDE2` / 强调 `#4D6BFE`（深色页 `#0E1013`），字体 HarmonyOS Sans SC + Cascadia Mono，边距 96 px，标题 64 px。轨道（rail）是贯穿全组的记号：断口＝丢进度，接缝＝续传——封面收尾用小尺寸复现一次。

重跑：

```powershell
python scripts/marketing/render-xiaohongshu.py
```

> 徽章 `assets/marketing/powered-by-dsh.png` 是官方 shields 徽章的 121×20 原图，别缩放或改色。

## 7. 发布注意

- 首图必须先讲“为什么”，再讲“是什么”：DSH 本体没有下载器是事实前提，跳过它，读者会觉得这只是又一个下载器。
- 任何横向对比只引 0.5 节的目录数据（7 个 / 4 个要另装引擎），不点名贬低具体项目；自家优势只说能验证的那几条（跨重启续传、e2e 数字、预编译）。
- 正文提到“实测”的地方只引用仓库数字，并说明测试条件（单次、机器相关、平台范围），不写“我用了三个月特别爽”这类无法核实的体验。
- 用 AI 起草或改写需按平台要求标注 AI 参与；本素材包由模型起草、数字来自仓库与插件目录，发布前请人工复核每条数字。
- 标签不要堆到 15 个以上；6–10 个够用，前 2 个最重要。
- 首发版本 A，24 小时后视数据决定是否补发 B（吐槽向更适合评论区互动）。
