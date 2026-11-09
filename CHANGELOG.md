# 更新日志

`dsh-rdm` 的所有重要变更记录于此。格式遵循
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/)。

**发布/tag 政策：** 每个 tag（`vX.Y.Z`）必须在本文中有对应的 `[X.Y.Z]` 章节，
并与版本号变更或创建 tag 在同一次改动中提交。没有更新日志就不算发布；运行
`node scripts/check-release.mjs` 会检查 package/kernel 版本一致性和对应章节是否存在。

从 **0.2.2** 起，常驻内核与插件包共用同一版本号。当前合并树为
**0.3.1**（协议 2）：`package.json`、`kernel/Cargo.toml` 以及内核的
ready/initialize/stats 帧都报告 `0.3.1`。历史录制保留二进制实际写入的
版本串（0.2.1 内核 = `1.1.0`；版本统一前的 0.2.2 构建 = `1.2.0`）。

## [0.3.1] — 2026-11-10

### 修复
- **严重：安装本插件后 DSH Web UI 直接打不开（`Failed to load plugins`）。**
  0.3.0 的客户端半边在 `apply` 里读 `ctx.layout`，却没有把 `layout` 声明进
  `inject`。Cordis 对未注入的服务访问是抛错
  （`cannot get property "layout" without inject`），`apply` 同步抛异常 →
  该客户端条目的 fiber 停在 `failed`；而 DSH 的启动审计把「任一客户端条目未
  active」当成致命错误，于是整页被替换成 `Failed to load plugins / dsh-rdm`。
  换句话说：只要装了 0.3.0，那个 dsh 的浏览器 UI 就起不来（已用无头浏览器
  复现并验证修复）。
  修复内容：可选服务一律通过 `ctx.get(name)`（Cordis 的反射读取，不受
  `inject` 约束）读取，见新增的 `src/client/services.ts`；`apply` 增加兜底
  帧，任何可选面板注册失败只写一条 warning，绝不再让 fiber 失败；原生右侧
  边栏标签的 `sidebarRightTabs`/`sidebarRight` 读取同样改为安全读取，并且
  等待座位的正常路径不再误报「未注册」；弹窗的「打开面板」改用真实的
  `layout.selectPanel`（`layout.navigation` 是 shell 内部的 AbortController，
  不是导航 API）。
- 新增 `tests/client-activation.test.mjs`：用 Cordis 语义的严格上下文（未注入
  的属性读取直接抛错）加载 `lib/client.js`，锁定上述三种失败模式。

## [0.3.0] — 2026-11-10

0.3.0 正式版：合并下载工作台/搜索与多源调度，中文化 README/CHANGELOG，并补齐
与 aria2、Gopeed 的真实下载对比。协议仍为 **2**。

### 新增
- **多源调度 V1–V4**：`sources[]`、实测选择、失败切换、首段对冲、按分块竞速、
  Metalink/HTTP `Link` 与 `.meta4` 解析；`race`/`failover` 只在强共享内容身份
  下混用字节。详见 [0.3.0-alpha.1] 章节。
- **下载工作台与 `rdm_search`**：左侧边栏工作台、工作区/会话分组、批量操作、
  右上角活动下载弹窗；第七个模型工具 `rdm_search` 支持跨会话记录检索。
- **安装体验**：README 首推 DSH 插件页安装，输入 `dsh-rdm` 即可从 npm 安装。
- **真实下载基准**：4 个 HTTP(S) 任务（3.3 MiB / 61 MiB / 986 MiB / 38.5 MiB
  GitHub 重定向）共 62 次下载、20.65 GiB，SHA-256 全部通过。dsh-rdm 在小文件
  （−44.1%）、中文件（−16.9%）和稳定大镜像（自适应 −3.5%）上快于 aria2；
  GitHub 慢链路由 aria2 领先（dsh-rdm +3.2% 耗时）。完整数据见
  [session_logs/20261110-downloader-bench/README.md](session_logs/20261110-downloader-bench/README.md)。

### 变更
- **README/CHANGELOG 默认中文**：`README.md`、`CHANGELOG.md` 为简体中文；
  英文版分别保留为 `README.en.md`、`CHANGELOG.en.md`。
- **版本统一**：包、内核与默认 User-Agent 统一为 `0.3.0`；`bin/win32-x64`
  预编译内核重建，协议保持 2。
- README 新增「实测成绩」区块，直接给出四个场景的结果与复现入口。

### 验证
- `cargo test --all-targets`：**157 通过 / 0 失败**。
- Python e2e **205/205**；extra **56/56**；claims **15/15**。
- 工具回执 **56 项通过**；host-api **21/21**；kernel-e2e **PASS**。
- fixture **64/64**；`verify-kernels --host --run` **PASS**；
  `check-release` **PASS**（package = kernel = `0.3.0`）；`tsc --noEmit` 干净。
- 基准：**62/62** SHA-256 校验通过，20.65 GiB；Gopeed 的默认 Chrome UA 在
  BFSU/TUNA 返回 403，基准统一使用 `curl/8.9.1`，详见基准报告。

## [0.3.0-alpha.2] — 2026-11-10

文档本地化与发布整理；协议仍为 **2**，运行时行为不变。

### 变更
- **README 安装方式**：`README.md` 与 `README.en.md` 增加 DSH 插件页安装截图，
  把「插件页输入 `dsh-rdm`」作为首推安装方式，并把整个安装章节移到「智能体原生」
  之前；GitHub、release tarball 与本地 bundle 保留为其他安装方式。
- **README 默认中文**：`README.md` 现在是简体中文版；原英文版迁移为
  `README.en.md`，中英文语言切换链接同步更新。
- **CHANGELOG 默认中文**：`CHANGELOG.md` 现在是简体中文版；原英文记录保留为
  `CHANGELOG.en.md`。
- 包与内核版本统一为 **0.3.0-alpha.2**；重新构建并提交 win32-x64 预编译内核，
  ready/initialize/stats 帧与默认 User-Agent 同步为新版本。
- 包清单更新：`README.en.md`、`CHANGELOG.en.md` 随包发布，不再包含旧的
  `README.zh-CN.md`。

### 验证
- `cargo test --all-targets`：**157 通过 / 0 失败**。
- Python e2e **205/205**；extra **56/56**；claims **15/15**。
- 工具回执 **56 项通过**；host-api **21/21**；kernel-e2e **PASS**。
- fixture **64/64**；`verify-kernels --host --run` **PASS**；
  `check-release` **PASS**（package = kernel = `0.3.0-alpha.2`）；
  `tsc --noEmit` 干净。

## [0.3.0-alpha.1] — 2026-11-09

同一逻辑对象的多源调度：显式候选源、实测选择、失败切换、首段对冲、按分块并发
竞速，以及 Metalink/HTTP 发现。协议仍为 **2**（所有新增字段可选且有默认值）；
内核与包版本为 **0.3.0-alpha.1**。

### 新增
- **`rdm_download` 的 `sources[]`**：主 `url` 之外最多七个候选镜像，每个可有
  自己的 headers/cookie 和可选优先级。`sourcePolicy` 选择 `single`、`select`、
  `failover`、`hedge` 或 `race`（省略时，如果存在 sources 则用 `select`）。
- **实测选择**：并发探测所有候选；多源时探测采样为 256 KiB（高于 64 KiB 的
  吞吐噪声下限），并结合来源台账、范围支持、签名链接过期与限流事实排序。
  `TaskView`/`TaskDetail` 通过 `sources[]`、`selectedSource`、`sourceSwitches`
  与 `sourcePolicy` 报告选中源和备选。
- **失败切换（V1）**：失败或停滞的源被标记为 bad，传输从健康备选继续；已完成的
  分块范围保留。
- **首段对冲（V2）**：`hedge` 在前 64 KiB–8 MiB（`sourceRaceBytes`，默认 1 MiB）
  范围内让两个最优源竞速，校验完整范围后写入胜者字节，并提交到该源。
- **传输中切换（V2）**：控制器在吞吐塌陷恢复时优先切换到健康备选源，而不是直接
  重建同一连接池；选择使用每源 EWMA/健康度。
- **按分块竞速（V3）**：`race` 在每源连接上限内把每个 claim 分配给最佳健康源，
  对反复失败的源做隔离，并报告每源字节/速率。它要求强共享内容身份
  （`expectedSha256`、服务器 SHA-256/Content-Digest，或相同大小 + 强 ETag）；
  否则降级为 `select` 并记录事件。
- **Metalink/HTTP 发现（V4）**：从探测响应解析
  `Link: <mirror>; rel=duplicate; pri=N`，探测镜像后加入源池（仅 HTTP(S)）。
  `.meta4`/`.metalink` 请求会在传输前解析为所选文件的 HTTP(S) 镜像与 SHA-256；
  文档包含多个文件时用 `metalinkFile` 按名称选择。
- **内容键续传**：`.part.json` 记录与源无关的 `contentKey`；键匹配时续传任务可以
  从不同镜像继续，不匹配时拒绝（`validators-mismatch`/`content-mismatch`）。
- **来源投影**：任务视图/详情与证据抽屉展示脱敏后的每源 URL/状态/字节/速率；
  新增 `source` 任务事件，覆盖选择、切换、对冲与发现。

### 变更
- `rdm_download` 的描述和参数文档列出多源字段。
- 控制器 `RebuildPool` 语义：先尝试切换来源，再重建当前源的连接池。
- 有界任务事件环与 JSONL 录制新增 `source` 事件类型。

### 版本阶段
该功能分四阶段实现；每完成一阶段内核版本号 +`0.0.1`，验收后的版本如下。

| 阶段 | 内核版本 | 范围 |
|---|---|---|
| V1 | `0.2.3` | `sources[]`、选择、失败切换、内容键续传、任务视图 |
| V2 | `0.2.4` | 首段对冲、传输中切换、每源健康度/EWMA |
| V3 | `0.2.5` | 按分块竞速调度、每源上限、隔离 |
| V4 | `0.2.6` | Metalink/HTTP `Link` 发现、`.meta4` 解析 |
| 验收 | `0.3.0-alpha.1` | 版本统一 + 验收测试 |

### 限制（已记录）
- 候选源仅支持 **HTTP(S)**；跨协议源（FTP/S3/torrent）属于后续协议工作。
- `race`/`failover` 只有在共享强内容身份时才混用字节；`select`/`hedge` 从不混用
  （它们只提交到一个源）。
- 包含多个文件的 `.meta4` 文档需要 `metalinkFile`；DRM/直播媒体与站点提取器不在
  范围内。
- 多源探测最多增加七个并发探测；多源任务每个候选使用 256 KiB 采样。单源下载
  仍使用 64 字节探测。

### 验证
- `cargo test --manifest-path kernel/Cargo.toml --all-targets`：
  **157 通过 / 0 失败** —— lib 78 · engine_tests 15 · protocol_tests 5 · unit 17 ·
  v022_integration 13 · v030_integration 21 · multi_source 8（选择、失败切换、
  无身份拒绝、竞速、慢源排除、对冲、Metalink/HTTP 发现、`.meta4` 解析）。
- **真实网络基准**（Alpine 3.20.3 ISO，209 MiB，SHA-256 已验证；官方 CDN 对比
  BFSU/CERNET/NJU 镜像）：`select` 比单一官方 CDN **快 11.41×**
  （23.73 s → 2.08 s），与最佳手动镜像持平；`race` 使用了多个镜像，但在该链路上
  约为最佳单源的 **1.00×**。第一版 race 调度器只把字节分给最优源，后来改为
  加权 least-loaded 分配并加入 50% 分数下限（三源 race 3.99 s → 2.11 s）。证据：
  [session_logs/20261109-multisource/README.md](session_logs/20261109-multisource/README.md)。
- `python tests/verify_e2e.py`：**205/205**；`python tests/verify_extra.py`：
  **56/56**；`python tests/verify_claims.py`：**15/15**。
- `node tests/tools-receipts.test.mjs`：**56 项通过**；
  `node tests/kernel-e2e.mjs`：**PASS**（包含新的多源显式镜像场景）。
- `node scripts/verify-fixture.mjs`：**64/64**；
  `node scripts/verify-kernels.mjs --host --run`：**PASS**（host win32-x64，
  5.35 MB）；`node scripts/check-release.mjs`：**PASS**
  （package = kernel = `0.3.0-alpha.1`）。
- 使用 `node scripts/build.mjs`（esbuild）重建 Host 产物，
  `npx tsc --noEmit -p tsconfig.json` 干净。

### 0.3.0 工作台与搜索（合并）

#### 新增
- **下载工作台（左侧边栏）。** 粘贴链接输入框；三张状态卡（正在下载 / 已完成 /
  失败任务）同时作为状态筛选；文本加后缀多选筛选；全选与批量暂停/删除及确认栏；
  每记录的暂停/继续/打开文件/打开所在文件夹/删除/复制 ID 操作；每行显示实时自适应
  连接数。
- **工作区 → 会话标题分组。** 记录先按所属工作区分组（持久化工作区注册表，cwd
  回退），再按从会话日志折叠出的真实会话标题分组；原始会话 ID 只作回退，未归属
  桶明确显示。
- **右上角活动下载弹窗**（`shell.overlay`，id `dsh-rdm-progress`）：按会话显示
  进度、速度与连接总数，可折叠为胶囊。只在至少一个下载活动时存在。
- **`rdm_search`**，第七个面向模型的工具：按关键词（ID、文件名、URL、主机、路径、
  会话标题）或精确 task ID 跨会话查找下载记录，支持 scope/status/limit，返回带
  会话/工作区标签的有界匹配。
- **Host 路由 v3。** `list` 返回解析后的会话标题和工作区行；`control` 接受
  `ids[]`（1–100）并按 ID 返回结果；`pause`/`cancel`/`remove` 可向所属活跃
  agent 排队一条简短用户操作通知；新增 `open` 操作把 task ID 解析为已保存文件或
  所在文件夹并调用宿主机桌面打开器（浏览器从不提供路径）。保留旧的单 `id`
  control 信封。
- 记录行和证据抽屉都可复制下载 ID；抽屉还报告 active / target / requested /
  ceiling worker 数。
- `.design/preview-03/` 静态预览 harness（24 个状态，mock v3 路由）；不随包发布。

#### 变更
- 内核状态改为文字 `内核正常` / `内核异常` 加一个绿/红点；页面波形录制器和右上角
  计数/速率行移除。
- 全局页面变为单一 1040 px 工作台列，包含输入框、卡片、筛选/选择工具栏和安静的
  工作区 → 会话账本；会话标签页保留证据语言与行操作。
- 为新卡片和弹窗重新调整明/暗 token；支持 1440 / 768 / 390 响应式布局、
  focus-visible 焦点环和 reduced-motion 处理。
- 新界面提供完整中英文案；英文计数复数安全。

#### 修复
- 会话右侧边栏行不再溢出列：波形恢复样式，操作簇锚定在行上，分组标题圆点不再
  泄漏到标签页头部。
- 没有保存路径的记录只提供文件夹操作；暂停记录不再声称有实时连接数。

#### 安全
- `open` 只接受 task ID 与固定 target，从内核记录解析路径，并在 detached 启动
  OS 打开器前验证绝对路径/存在性。用户通知只在所属 agent 活跃时投递；不会因为
  一次 UI 点击而恢复冷会话。

## [0.2.2] — 2026-11-09

Live-ModelScope 优化轮次，由 `session_logs/20261109/` 和两次来自
`unsloth/Qwen3.6-35B-A3B-GGUF` 的真实、SHA-256 已验证下载驱动。

### 变更
- **统一版本号。** 内核 crate 标识与插件包统一：`rdm-kernel` `1.2.0` →
  `0.2.2`；`package.json` → `0.2.2`；协议保持 2。
- **按真实广域网行为重写自适应控制器。** 增长探测按聚合吞吐判断（保持到探测前
  速率的 ≥95% 为止），回退带 30 tick 冷却，两次平增长探测触发饱和冻结，剩余
  claim 数 ≤ 目标时进入 tail 并冻结目标。
- **尾部处理。** Tail claim 使用 3 秒停滞期限和快速重试（250 ms × 尝试次数，
  封顶 1 秒），取代多秒退避。
- **续传恢复已学习的并发。** 控制器目标持久化在 `.part.json` 并恢复（真实 Q6
  运行观察到 `initial=41`），而不是从请求连接数重新开始。
- `avgBps` 是任务累计生命周期内的整文件进度；速率窗口/EWMA/峰值仍是本次运行速率。
  耗时跨重启持久化，旧终端记录通过 `createdAt`→`finishedAt` 恢复。

### 新增
- 每次运行的 history **meta 记录**（`kind:"meta"`），包含内核版本、pid、run、
  file/total/chunk、requested/initial/ceiling workers 与续传决策；`history` RPC
  返回 `meta` + `builds`，`rdm_history` 渲染一行 `build=`。一条任务时间线现在
  可跨内核构建/重启保持归属。
- 计划回执包含 `requested=`、`initial=`、`ceiling=`、`chunks=`、`chunk=`、
  已续传字节与续传决策/原因；续传状态事件区分 `ranges / chunks / bytes`。
- 稳定的 `unsupported_method` 错误，包含方法名、内核版本与升级提示（取代不透明的
  `unknown method …`）。

### 修复
- 续传任务不再报告从继承 `.part` 字节产生的多 GiB/s 平均/峰值（真实产物：首个
  样本 8.6 GiB/s，平均 1.8 GiB/s）。
- Tail worker 在收尾时不再缩小目标（20261109 批次中 `102→90→79→70`）；一次真实
  尾部重试现在使用 5 s / 250 ms，而不是 30 s / 10 s + 1000 ms。
- `resume_state.chunksDone` 和取消后的回执报告已覆盖分块（例如
  `41 ranges / 2502 chunks`），而不是合并范围数量。
- `requestedConnections` 在重载后保留（旧记录字段缺失时回退到记录的初始 worker
  数）；`elapsedMs`/`avgBps` 在内核重启后不再重置为 0。
- 旧 0.2.1 history 与 `.part.json` 仍可读取。

### 验证
- 门禁：`cargo test --all-targets` **146 通过 / 0 失败**；Python e2e
  **205/205**（core 55 + v030 90 + v022 60）；旧 Node 矩阵 **14/14 场景，
  244/244 检查**；工具回执 **43**；fixture **64/64**；独立黑盒 smoke
  **46/46**；真实 0.2.0 任务记录加载 **24/24**。
- 真实下载（均保存在 `D:\llm\models`，SHA-256 已验证）：
  `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` 22,360,456,160 B，
  sha256 `707a55a8a4397ecde44de0c499d3e68c1ad1d240d1da65826b4949d1043f4450`；
  `Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf` 31,843,777,504 B，
  sha256 `f6b6c6d5cfa6f00d964eeb7add28eb14ce7481734d506b90681007678cd2c484`。
- 证据：[docs/OPTIMIZATION.md](docs/OPTIMIZATION.md) §11、
  [docs/design/0.2.2-live-modelscope-pass.md](docs/design/0.2.2-live-modelscope-pass.md)、
  数据包 [session_logs/20261109-qwen36/](session_logs/20261109-qwen36/)。

### 已知限制（已记录，不是回归）
- SHA-256 校验仍在传输后串行执行（26.8 GiB 运行约 4.4%）；乱序分块无法在不改变
  校验契约的情况下流入单一哈希。
- 多源竞速仍在路线图中（本次会话主要是源选择问题：HF 0.13 MiB/s 对比
  ModelScope 约 106 MiB/s）。
- history 采样节奏约 6.4 Hz，而非标称 10 Hz（100 ms reporter tick 与 100 ms
  sample gate）；3 秒尾部停滞路径由合成测试覆盖，但真实运行未触发（最终阶段
  5 秒期限先触发）。

## [0.2.1] — 2026-11-09

`20261108`/`20261109` 导出的真实数据修复轮次（开发期间文档称 “0.3.0”；在
0.2.2 发布定版时重命名为 0.2.1）。

### 新增
- 每任务持久化下载数据记录：`<dataDir>/history/<task>.samples.jsonl` 与
  `.events.jsonl`、`history` RPC 和 `rdm_history` 工具；记录跨内核重启存活，且
  每任务有界。
- 自适应控制器增长/塌陷处理，带 HTTP 连接池重建和显式 `maxConnections` 上限
  （默认 128；`MAX_CONNECTIONS` 32 → 128）。
- 稳定身份续传决策（`resumeDecision`/`resumeReason`），覆盖 ETag、Last-Modified、
  请求/最终 URL 路径身份、part 长度和损坏状态；`auth_key`/签名 URL 材料在所有
  投影（包括重定向跳点）中脱敏。
- 尾部停滞期限收紧（30 s → ≥90% 时 10 s → ≥97% 时 5 s）。

### 修复
- 最终 URL 携带新的按请求令牌（`auth_key`、`Expires`/`Policy`）时，续传不再丢弃
  已完成分块表。
- `auth_key` 不再泄漏到 host 投影或任务记录。
- ModelScope Tengine `auth_key` 存在时报告为 `signedUrl.signed=true`。

## [0.2.0] — 2026-11-08

- 插件智能体原生修订：协议 2 `ServerFacts`/`TaskDetail`、每任务会话归属、实时
  遥测窗口、有界回执、浏览器路由和评审优先的侧边栏 UI。
- 精简常驻 Rust 内核，包含探测/计划/校验、可续传分块传输、带宽限制、SHA-256
  校验，以及 Windows/Linux/macOS 预编译内核。

## [0.1.2] — 2026-11-06

- 小文件下载延迟与多连接吞吐改进；刷新预编译内核二进制。

## [0.1.1] — 2026-11-05

- 包内附带 Windows、Linux 和 macOS 预编译内核。
- npm 打包与安装文档；发布哈希来源说明。

## [0.1.0] — 2026-11-04

- `dsh-rdm` 首个公开版本：面向 DeepSeek Harness 的常驻多连接下载引擎，提供
  `rdm_*` 工具。
