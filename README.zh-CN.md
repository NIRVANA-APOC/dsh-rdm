# dsh-rdm

[English](README.md) | [简体中文](README.zh-CN.md)

**面向 DeepSeek Harness 的智能体原生下载器。** 一个常驻 Rust 内核、五个面向模型且返回决策级事实的工具，以及两个面向人类的审阅界面：左侧边栏的全局下载台账，以及右侧边栏的会话级审阅标签页。

智能体负责操作，人类负责审阅。

![全局下载审阅 — 浅色](assets/screenshots/review-light.png)

## “智能体原生”在这里的含义

被模型使用的下载器，不是“恰好带 API 的 GUI”。智能体必须用尽可能少的模型步数回答：*这个 URL 是否可用、应该怎么取、现在发生了什么、是否需要干预、结果是否可信？* `dsh-rdm` 0.2.0 就是围绕这些问题构建的。

* **决策级探测。** `rdm_probe` 返回完整的服务器事实记录——经证实的字节范围支持、校验器与 RFC 9110 续传安全性、签名链接过期、TLS 证书有效期、重定向链、校验和可用性、速率限制响应头、耗时、稳定的警告码，以及具体建议。而不是一句“200 OK，48 MB”。
* **启动时预检。** `rdm_download` 会把同一份服务器事实附着到任务上（有界等待，默认 2 秒），这样智能体无需第二次调用就能决定暂停、校验还是继续等待。
* **诚实的实时遥测。** 四个实测吞吐窗口（1 s / 5 s / 30 s / 300 s）、峰值、平均、停滞时长、趋势，以及一个在数据不足时会降级为 `unknown` 的 `etaConfidence`，而不是伪造精度。
* **长轮询，而非高频轮询。** `rdm_wait` 阻塞到任务全部进入终态或超时，并返回类型化的 `timedOut`；状态结果扁平且有界。
* **结构化回执、有界的规范 JSON。** 模型读取字段顺序稳定的行式 `key=value` 回执；程序调用方拿到规范 JSON。可恢复失败是值（`error code=…` 加 `next …`），而不是会丢失结构的抛出字符串。
* **会话归属。** 智能体发起的每个下载都携带其所属的会话 id，因此人类可以精确审阅*这个*智能体下载了什么。
* **一条策略，只声明一次。** 一段简短的系统提示词段告诉每个智能体把下载交给 `rdm_*`；工具定义保持精简（首轮 schema 成本 7241 → 4966 字符，比 0.1.2 减少 31%）。

## 两个审阅界面

人类在这里从不组合下载：没有 URL 输入框，也没有连接数滑块。

* **全局审阅**（左侧边栏入口 → 页面）：一条覆盖整个内核的吞吐记录条、按会话分组的下载台账、风险标记，以及每条记录都可展开的证据抽屉（请求链、服务器事实、耗时、续传状态、校验、有界事件日志）。只有进行中的记录使用高饱和颜色；记录不会声称执行过它没有执行的校验。
* **会话审阅**（右侧边栏标签页，“下载”）：同一套证据语言，但只筛选当前会话。没有下载的会话为空；它从不抢焦点。
* **证据语言**：一条**吞吐脉冲**（客户端采样、如实标注）和一个**校验印记**（预期与实际哈希，仅在确实比较过哈希时出现）。未知值渲染为 `—`。

![会话下载审阅 — 深色](assets/screenshots/review-session-dark.png)

## 工具

五个工具。所有输出都有界；模型看到回执，调用方看到规范 JSON。

| 工具 | 作用 | 返回 |
|---|---|---|
| `rdm_probe` | 检查 HTTP(S) 源而不下载文件本体 | `ServerFacts`：字节范围、校验器、续传安全性、签名链接/TLS 过期、重定向、校验和、速率限制、耗时、警告、建议 |
| `rdm_download` | 在常驻内核中启动传输 | 任务视图 + 预检 `ServerFacts`（≤2 s）+ 下一步提示；`waitSec` 可选阻塞 |
| `rdm_tasks` | 列出本会话的下载，或深入查看单个下载 | 扁平任务视图 + 聚合；带 `taskId` 时返回遥测、服务器事实、校验、诊断、有界事件 |
| `rdm_wait` | 长轮询直到终态或超时 | 已结算的任务视图 + `timedOut` |
| `rdm_control` | 暂停、继续、取消、重试、移除 | 更新后的任务视图（或已移除的 id） |

一次探测回执：

```text
probe host=cdn.example.com status=200 http=HTTP/2.0
url https://cdn.example.com/app.zip?sig=<redacted>
file name=app.zip source=content-disposition size=48.1MiB type=application/zip encoding=-
range=bytes resume=strong signed=valid(19m40s) tls=valid(40d) checksum=none
plan start=now connections=8 chunk=1.5MiB singleStream=false verify=recommended reason=ranges+strong-etag
headers server=nginx cache=max-age=3600 vary=Accept-Encoding
warnings=- redirects=0
timing probe=84ms ttfb=61ms sample=- origin=known attempts=3 completed=2 median=14MiB/s best=22MiB/s lastError=-
next rdm_download url=https://cdn.example.com/app.zip?sig=<redacted>
```

一次任务列表回执：

```text
kernel state=running version=1.1.0 pid=4212
scope=session count=1
aggregate total=3 active=1 paused=0 failed=1 completed=1 bytes=2.5GiB now=12.4MiB/s w5=12MiB/s w30=11.5MiB/s w300=- risk=0
t_9f3a1c2d5e6b7a80 running 68% 1.6/2.4GiB 12.4MiB/s w5=12.0MiB/s eta=1m12s(high) workers=8/8 range=bytes resume=strong name=ubuntu-24.04.iso
```

## 内核智能

Rust 内核（`rdm-kernel` 1.1.0，协议 2）是一个常驻子进程：不监听端口，惰性启动并保持常驻。

* **服务器事实** —— 手动跟随的重定向链（最多 8 跳）、经证实的字节范围支持（带已验证 `Content-Range` 的 206，而不是只看 `Accept-Ranges` 响应头）、按 RFC 9110 对校验器做强/弱分类、从最终 URL 推导的各类签名链接过期时间（AWS SigV4/SigV2、GCS SigV4、Azure SAS、通用 `Expires`）、TLS 叶子证书 `notAfter`、校验和可用性（`Content-Digest`/`Content-MD5`/S3 SHA-256/CRC32C）、`Retry-After`、探测/TTFB 耗时，以及有界警告码。
* **保持诚实的续传** —— `.part` + 续传状态、校验器兼容性检查，以及显式的 `resumeSafety`：`strong`/`weak`/`none`。内核只为强 ETag 发送 `If-Range`；弱校验器续传会重新探测并校验 `Content-Range`/长度，若源站忽略字节范围则回退为完整响应体。进行中的下载在签名链接过期后仍会继续；过期后再续传则不会——诊断会给出“不要暂停”。
* **实测遥测** —— 以 100 ms 节奏采样的有界 3000 样本环驱动四个窗口、峰值/平均、停滞和趋势，不额外增加定时器。
* **来源台账** —— 有界 256 台主机的记忆：尝试/完成/中位/最佳吞吐/最近错误，由 `rdm_probe`（`origin=…`）和 `stats` 报告。
* **分段传输** —— 每个任务 1–32 条连接，带尾部窃取的动态分块队列，带 429/503 回退的 AIMD 并发，指数退避重试，每任务带宽上限，以及原子重命名前可选的 SHA-256 校验。
* **有界** —— 每个任务 ≤200 条事件、≤3000 个遥测样本、≤256 个来源，不缓冲完整响应体，stdout 专供协议使用。

性能工作与测量见 [docs/OPTIMIZATION.md](docs/OPTIMIZATION.md)；架构与协议见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 和 [PROTOCOL.md](PROTOCOL.md)。0.2.0 的设计推理见 [docs/design/0.2.0-agent-native.md](docs/design/0.2.0-agent-native.md)，证据笔记见 [docs/research/agent-native-downloader.md](docs/research/agent-native-downloader.md)。

## 安装

包内附带 Windows x64、Linux x64/arm64 与 macOS x64/arm64 的预编译内核；安装过程从不编译 Rust。

从 GitHub 安装到某个 DSH profile：

```bash
dsh plugin --profile web add github:NIRVANA-APOC/dsh-rdm
```

从 release tarball 安装：

```bash
dsh plugin --profile web add https://github.com/NIRVANA-APOC/dsh-rdm/releases/download/<tag>/dsh-rdm-<version>.tgz
```

把本地检出作为目录 bundle 安装（DSH UI → Plugins → Install from folder，或 `plugin_manager` 工具）：

```text
plugin_manager install_bundle target=<absolute path to dsh-rdm>
```

安装后，智能体可以看到 `rdm_*`；左侧边栏出现下载入口，右侧边栏指南新增一个“下载”标签页。通常无需重启，刷新一次页面也是安全的。

### 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `defaultDir` | `<data-dir>/downloads`（`defaultDir` 未设置时） | 未指定 `dir` 时启动的下载所用目录 |
| `connections` | `8` | 每个任务默认并行连接数（1–32） |
| `chunkSizeMiB` | `0`（自动） | 固定分块大小；0 = 每连接四块，256 KiB–8 MiB |
| `speedLimitBps` | `0` | profile 级默认带宽上限；0 = 不限速 |
| `maxAttempts` | `6` | 每块重试预算 |
| `autoResume` | `true` | 内核启动时续传被中断的任务 |
| `dataDir` | `$DSH_HOME/dsh-rdm` | 内核数据（任务记录、来源台账） |
| `kernelPath` | 随包的 `bin/<platform>-<arch>/rdm-kernel` | 覆盖内核二进制路径 |
| `startOnDemand` | `true` | 首次使用时启动内核，而不是插件加载时启动 |
| `logLevel` | `warn` | 内核 stderr 日志级别 |

## 验证

* `node scripts/verify-kernel.mjs` —— 针对本地 fixture 的内核 e2e（这是规范套件；它会启动内核，因此需要允许创建子进程的宿主）。
* `python tests/verify_e2e.py` —— 进程外协议 2 驱动，用于 Node 无法创建子进程的宿主（见下文）：探测事实、签名链接、重定向、会话范围、遥测、暂停/继续、统计、聚合。
* `node tests/tools-receipts.test.mjs` —— 回执契约、策略只声明一次、schema 成本守卫、可恢复错误回执。
* `node scripts/verify-fixture.mjs` —— fixture 自测。
* `node scripts/verify-kernels.mjs --host --run` —— 当前宿主的随包内核存在、格式正确且能启动。

本版本实测的 QA 报告见 [docs/verification.md](docs/verification.md)。

## 安全与隐私

* 携带凭据的查询参数值会在**规范层脱敏**，而不只是在 UI 里：`ServerFacts`/任务视图会把 `X-Amz-Signature`、`Signature`、`sig`、`token`、访问密钥及类似的值替换为 `<redacted>`。请求头和 cookie 从不出现在任何协议视图、回执或 UI 中。
* 磁盘上的任务记录可能保留请求凭据，以便内核重启后续传时能够认证。它们只存放在内核数据目录下；请将该目录视为所有者敏感（owner-sensitive）。
* 浏览器路由由 Harness 的 connection 服务认证；内核不开放任何网络监听，只通过 stdio 使用 NDJSON。
* `insecure: true` 会为单个任务禁用 TLS 验证（仅限调试）；探测仍会报告它能读取到的证书事实。

## 限制（如实说明）

* 镜像、多源调度、下载审批门禁、按源站强制执行的并发预算，以及 MCP 暴露，都是 0.2.0 有意的非目标。
* 远端变化导致的续传问题通过校验器发现；只有弱校验器的源站仍可能返回在同一秒内发生变化过的字节——此时 `weak` 安全性标签就是如实的信号。
* ETA 置信度是对实测窗口的启发式判断；数据不足时它是 `unknown`，而不是猜出来的数字。
* 五个平台的预编译内核由 release 工作流在原生 runner 上构建；在工作流刷新 `bin/` 之前，本地检出只包含当前宿主最新构建的内核。
* 沙箱化的智能体宿主可能拒绝 Node 创建子进程；这种环境下请用 `bash scripts/dev-build.sh` 构建，用 `python tests/verify_e2e.py` 运行内核套件（两者都记录在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）。

## 开发

```bash
npm install
bash scripts/dev-build.sh all      # 宿主 + 客户端，沙箱安全
bash scripts/dev-build.sh kernel   # cargo release 构建并安装到 bin/
node scripts/build.mjs             # 沙箱外的规范构建
node scripts/build-kernel.mjs      # 沙箱外的规范内核构建
python tests/verify_e2e.py         # 协议 2 内核套件（沙箱安全）
node tests/tools-receipts.test.mjs # 宿主回执契约
```

宿主半边只导入 Node 内置模块（schema 库以 vendor 方式内置）；客户端半边注册到 `sidebar.panellist`、带 key 的 `main` 槽位和原生右侧边栏标签座位，并且只使用宿主主题 token。

## 许可

MIT OR Apache-2.0。
