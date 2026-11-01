# GitHub CI 与 Release

2026-10-23：按用户新要求，增加 Windows、macOS、Linux × x64、arm64 的构建与私有 Release。当前浏览器仍为 PoC；构建成功、运行冒烟和完整平台功能验收分别记录。

2026-10-31：用户授权公开仓库，并直接运行六目标 `build-release`。保留标准托管 runner、编译缓存、磁盘记录以及六目标全部通过后的发布条件；既有历史结果不代表本轮已通过。

## 工作流

[Browser Release](https://github.com/CharlesXu/AgenticBrowser/actions/workflows/release.yml) 仅手动触发，支持：

- `preflight`：默认模式。实际检查六种 runner 的架构、内存、磁盘和基础工具链，不下载 Chromium。
- `build-one`：只构建所选 `target`，完成编译、运行冒烟、打包并上传 artifact，不发布 Release。默认 `macos-x64`，用于先测完整构建的实际磁盘峰值。
- `build-release`：在同一资源检查通过后，拉取 `chromium/upstream.json` 中的官方 tag，核对 SHA，同步依赖、应用源码与品牌、构建、检查实际二进制架构、运行小范围冒烟、打包。

每个任务使用独立 checkout 和 `out/AgenticRelease-<arch>`，`is_component_build=false`、`is_debug=false`，不使用本机运行中的 component build 或 Profile。不同 runner 可以并行；同一发布工作流不重叠，不缓存整个 Chromium 源码树。

六个目标全部成功后才进入发布任务。发布任务再次核对源码 SHA、上游版本、架构、冒烟结果、包大小和 SHA-256。先创建草稿并上传所有资产，回读完整后才发布为 **Pre-release**；任一目标失败不会创建可下载的完整 Release，不覆盖已有同名版本。

版本标签为 `v<产品版本>-poc.<Git SHA 前 16 位>`。文件名为：

| 平台 | x64 / arm64 产物 |
|---|---|
| macOS | `Agentic-Browser-0.1.0-macos-<arch>.dmg` |
| Windows | `Agentic-Browser-0.1.0-windows-<arch>.zip`，免安装包 |
| Linux | `Agentic-Browser-0.1.0-linux-<arch>.tar.xz` |

三个平台的默认用户数据目录独立于 Chromium；不迁移或覆盖已有 Profile，显式 `--user-data-dir` 仍优先。

同时附带 Skill/Plugin/MCP 接入套件、SHA256SUMS、构建清单、Chromium LICENSE 与 NOTICE。按 2026-10-31 用户授权，源码库改为 Public；发布后的 Release 资产可匿名下载。

## 构建机器

目前使用已有 GitHub 托管 runner，不新增机器。已取消原先未经完整编译实测的 100 GiB 磁盘拦截；磁盘预检只报告可用量。仍检查目标架构、基础工具链和 7 GiB 级内存（允许系统预留后可用内存降至 6.5 GiB）。GitHub 托管 job 限时 360 分钟，预检通过不等于编译一定能完成。

构建期间每 5 秒记录工作目录所在文件系统的剩余磁盘，报告 `disk-<target>.json` 保留最低剩余、相对构建开始的峰值增长、文件系统使用峰值及阶段采样。数字包含系统后台活动，短于采样间隔的尖峰可能遗漏；失败也保留报告。

仅在 `RUNNER_ENVIRONMENT=github-hosted` 的临时机器内，清理 Android、无关运行时等明确列出的预装目录；macOS 保留实际选中的 Xcode，清理其他 Xcode，使用 `simctl runtime delete all` 卸载并删除模拟器运行时，避免递归遍历只读挂载卷。自托管 runner 与本机不执行这些清理。继续浅克隆、无调试符号、关闭 ThinLTO；macOS 将应用移动到打包目录，阶段冒烟成功后删除本次输出目录中的中间文件，再压缩打包。

macOS 托管 runner 先通过进程级 `DEVELOPER_DIR` 选择已预装的最高正式 Xcode，再执行预检和清理；下载源码前检查 Chromium 模块构建实际需要的四个 SDK modulemap 文件。

单次编译最多 285 分钟，整个下载／构建／打包步骤最多 330 分钟，为总计 360 分钟的 job 留出缓存与报告上传时间。使用独立 ccache 4.14.2，校验官方资产 SHA-256，缓存上限 8 GiB；只缓存编译结果，不缓存 Profile、凭据或整个源码树。Clang 模块使用 depend 模式与官方文档要求的 `modules,time_macros` 设置，编译器按内容校验。缓存按平台、架构及上游配置隔离；每次使用新 key，失败也保存，以便下次重跑同一目标复用。达到时间片仍记为未完成，不跳过最终链接、原生冒烟或发布门槛。Actions 缓存可能被配额淘汰，实际命中和用量记录在 `cache-<target>.json`；没有增购缓存容量或机器。

默认构建 runner 为 `macos-15-intel`、`macos-15`、`windows-2025`、`windows-11-arm` 和 `ubuntu-24.04`。Linux ARM64 在 x64 上交叉编译，再在 `ubuntu-24.04-arm` 上原生启动验收。可在仓库 Actions Variables 中为以下变量设置 JSON 标签数组，指向已配置、专用于此仓库的 runner：

| 变量 | 本机目标 |
|---|---|
| `CHROMIUM_RUNNER_MACOS_X64` | macOS x64 |
| `CHROMIUM_RUNNER_MACOS_ARM64` | macOS arm64 |
| `CHROMIUM_RUNNER_WINDOWS_X64` | Windows x64 |
| `CHROMIUM_RUNNER_WINDOWS_ARM64` | Windows arm64 |
| `CHROMIUM_RUNNER_LINUX_X64` | Linux x64 |
| `CHROMIUM_RUNNER_LINUX_ARM64` | Linux x64 构建机，产出 arm64 |

不要绑定日常开发 checkout；首次源码与依赖下载较大。五个目标在对应原生架构上编译及启动；Linux ARM64 使用固定上游提供的 x64 Clang 和 gperf，并通过 `.gclient` 的 `target_cpu` 同步 ARM64 sysroot，不改上游 DEPS。交叉编译包先上传为 `candidate-linux-arm64`，清单记为 `smoke: pending`。全部构建完成后，独立 ARM64 runner 校验同一提交、上游配置、包散列和 ELF 架构，运行三个空间等原生冒烟；通过后保留原压缩包字节，仅补齐通过清单和报告，再上传 `browser-linux-arm64`。发布依赖这一任务，不把交叉编译成功计作原生启动通过。

工具链：

- macOS：完整 Xcode、macOS SDK、Metal 工具；通过 `DEVELOPER_DIR` 或 `xcode-select` 正确选择。默认只有 Command Line Tools 时不会通过。
- Windows：固定 Chromium 源码要求 Visual Studio 2026 C++、ATL/MFC；ARM64 还需 ARM64 工具与库。仅在临时托管 runner 上，从微软固定地址安装 SDK 10.0.28000.2270；执行前核对 SHA-256、Microsoft Authenticode 签名和固定上游的 SDK 要求。安装后检查头文件、三种架构库以及所需调试工具的版本和 PE 架构。ARM64 安装器缺少 x64 Debuggers 时，采用 runner-images 的方式，从同版 SDK 的 bin 目录补齐已有官方 DLL，不降低 Chromium 的 SDK 要求。本机和自托管环境不会自动安装，不购买构建资源。
- Linux：Python 3、Git、可运行 `sudo -n build/install-build-deps.sh` 的专用 runner、Xvfb，以及可用的用户命名空间沙箱。不会通过 `--no-sandbox` 绕过沙箱。

## 验证范围与签名

只做版本交付直接相关的检查：三个原生空间启动、共享 Cookie/localStorage 登录与退出、独立 sessionStorage、主空间拒绝接管、任务空间输入不串台。使用一次性本地页面、Profile 和测试凭据；上传报告只有布尔结果和工具链信息，不上传 Profile、token、网页截图或模型 Key。

macOS 保留构建产生的临时签名并验证包结构，**没有 Developer ID 签名／Apple 公证**。Windows **没有 Authenticode 签名**。本轮不冒充已签名安装包，也不自动绕过系统提示。Windows 发布免安装 ZIP，在打包目录中验证浏览器运行时，不包含安装器、默认浏览器或系统服务注册流程。

Windows/Linux 的人工界面、VNC、锁屏和真实模型使用仍需对应平台的后续针对性验收；不把 macOS 的历史结果套到这些平台。

## 本轮记录

- 工作流静态校验（actionlint）、项目语法/i18n/清单检查、模型协议边界检查通过。
- 新冒烟脚本在本机已有 macOS ARM64 构建上通过；这验证脚本与现有运行时，不算新的六目标 Release 编译。
- 图标处理改用跨平台 sharp；独立目录中的 PNG、Windows ICO、macOS 图标转换通过。空间模块从仅 macOS 编译扩大到三个桌面平台；Windows capability 文件增加当前用户专用 DACL。Windows/Linux 编译结果尚待 CI。
- 工作流及源码已推送私有 `main`。常规 [Project CI](https://github.com/CharlesXu/AgenticBrowser/actions/runs/39890884371) 通过，初次 [六目标预检](https://github.com/CharlesXu/AgenticBrowser/actions/runs/39890673466) 已运行。修正标称 8 GiB VM 被系统预留内存误拦截的问题，报告保留一位小数。
- [第二轮执行](https://github.com/CharlesXu/AgenticBrowser/actions/runs/39890907427) 的实际资源如下（GiB），不是官方规格承诺；后续 runner 镜像可能改变可用空间。

| 目标 | 可用磁盘 | 系统内存 | CPU | 资源与基础工具预检 |
|---|---:|---:|---:|---|
| macOS x64 | 107.1 | 14.0 | 4 | 通过 |
| macOS arm64 | 43.0 | 14.0 | 5 | 磁盘不足 |
| Windows x64 | 73.0 | 8.0 | 2 | 磁盘不足 |
| Windows arm64 | 124.1 | 8.0 | 2 | 通过 |
| Linux x64 | 13.1 | 7.8 | 2 | 磁盘不足 |
| Linux arm64 | 35.1 | 7.7 | 2 | 磁盘不足 |

- macOS x64 实际完成官方源码／依赖同步和品牌补丁应用，随后在 `gn gen` 前因缺少 `python3_bin_reldir.txt` 失败，尚未编译。原因是关闭 depot_tools 自动更新同时跳过首次 Python 初始化；脚本已补显式 `ensure_bootstrap`，Windows 对应 `bootstrap/win_tools.bat`，并先验证 Python wrapper 后再下载 Chromium。本机独立全新 depot_tools checkout 在关闭自动更新时初始化成功，wrapper 返回 Python 3.11.8；这只验证 macOS ARM64 上的初始化修正，未重新跑完整远端构建。
- 用户随后确认“尚无，先完成流水线和资源检查”，已停止第二轮剩余构建；Windows ARM64 的构建步骤取消，四个资源不足的目标未进入源码下载。两个预检通过的目标均不计为构建成功。
- 当前无六目标产物，无 Release。发布 gate、安装包和新跨平台原生代码仍待真实构建／冒烟验证。没有注册自托管 runner、开通收费机器或改变本机浏览器。

上述资源表是旧阈值下的历史结果，“磁盘不足”不代表已编译到磁盘耗尽。用户随后要求先优化现有 runner：先以 `build-one / macos-x64` 验证完整链路和磁盘峰值，再推进 `build-release` 六目标；不能只凭旧阈值要求增加机器。

### 取消固定阈值后的第一次单目标尝试

[运行 39897857971](https://github.com/CharlesXu/AgenticBrowser/actions/runs/39897857971)，源码 `c7c7c924a57fc07a17c37b78fd5dc3c87d78456f`，macOS x64，33 分 36 秒：

- 初始可用磁盘 107.8 GiB；清理无关软件后约 192.7 GiB，释放约 84.9 GiB。
- 完成源码、依赖、图标和补丁准备；到 GN 配置失败时，最低剩余 155.4 GiB，相对清理后的占用增长峰值为 37.3 GiB。该数值**仅覆盖准备和配置阶段，不是完整编译／打包峰值**。
- 失败原因：默认 Xcode 16.4 / SDK 15.5 缺少 `DarwinFoundation1/2/3.modulemap`，而 Chromium `build/modules/BUILD.gn` 将这些文件作为输入。没有磁盘耗尽；编译、打包、冒烟尚未开始。
- 修正：选择 runner 已有的较新正式 Xcode，并将 modulemap 检查提前；未采购机器、未更换运行中的本机工具链。随后继续同一目标的完整构建。

### 第二次单目标尝试：磁盘充足，达到任务时限

[运行 39901246954](https://github.com/CharlesXu/AgenticBrowser/actions/runs/39901246954)，源码 `5df670c641dae5a031c08a9d581096365230b43d`，macOS x64：

- 已使用 Xcode 26.3 / SDK 26.2，源码同步和 GN 配置成功，进入真实 C++ 编译。
- 初始可用 107.1 GiB，清理后 192.9 GiB；最低剩余 157.3 GiB，相对清理后占用增长峰值 35.6 GiB。仍是**未完成编译的观测值，不是完整编译／打包峰值**。
- 编译约 5 小时 19 分钟，日志进度 18,531 / 79,388，约 23% 的构建步骤；不是时间完成百分比。构建步骤达到原设 350 分钟时限时仍正常编译。没有磁盘耗尽，也没有浏览器包、冒烟结果或 Release。
- 修正 macOS 清理方式，使用 `simctl` 卸载模拟器，消除递归删除只读挂载卷产生的大量错误日志。
- 下一次采用编译缓存跨轮复用。隔离的小型 Clang 模块验证确认同内容文件可命中、头文件变化会重编；使用现有 Chromium `base/logging.cc` 的真实命令，仅将输出改到独立临时目录，首次 0.92 秒、第二次缓存命中 0.01 秒。这只证明本机缓存路径可用，完整 CI 命中率和完成时间仍待验证，没有更改运行中的浏览器文件。

官方依据：[GitHub runner 规格](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[Actions 缓存](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)、[ccache 手册](https://ccache.dev/manual/latest.html)、[Chromium Windows 构建](https://chromium.googlesource.com/chromium/src/+/156.0.8078.48/docs/windows_build_instructions.md)、[Linux 构建](https://chromium.googlesource.com/chromium/src/+/156.0.8078.48/docs/linux/build_instructions.md)、[macOS 构建](https://chromium.googlesource.com/chromium/src/+/156.0.8078.48/docs/mac_build_instructions.md)。

### 公开仓库后的六目标启动

2026-10-31：仓库已改为 Public，匿名访问确认成功。首轮 [41167162521](https://github.com/CharlesXu/AgenticBrowser/actions/runs/41167162521) 的校验通过，六目标均启动，未再受到此前计费限制拦截。macOS arm64 实测为 7 GiB / 3 核，被旧 7.5 GiB 内存阈值拦截；Xcode 26.3、SDK 26.2 和 Metal 检查均通过。停止该轮后，最低内存改为覆盖官方 7 GiB 标准 runner，并按每个编译任务约 3 GiB 限制并发（该 runner 为 2 个任务）。此修正只解除预检误拦截，不表示完整编译的内存和耗时已通过验证。

### 六目标完整报告与针对性修正

[运行 41167340049](https://github.com/CharlesXu/AgenticBrowser/actions/runs/41167340049)，源码 `2b24b47268f9e02cc75d73f62fbbfe0e8827e793`，六目标均已结束，发布跳过。没有目标完成打包或原生冒烟。

| 目标 | 最低剩余磁盘 GiB | 结果 |
|---|---:|---|
| Windows x64 | 192.6 | 补丁检查失败 |
| Windows arm64 | 97.1 | 补丁检查失败 |
| Linux arm64 | 88.1 | 官方 gperf 3.2 CIPD 包缺少 ARM64 tag |
| Linux x64 | 72.2 | 编译时间片结束，27,945 / 75,650 步 |
| macOS arm64 | 173.7 | 编译时间片结束，26,090 / 76,641 步 |
| macOS x64 | 205.0 | 编译时间片结束，22,125 / 77,115 步 |

上述数字来自磁盘采样与任务日志；编译步数不能换算为耗时完成率。三个进入编译的目标均达到预设 285 分钟时间片，已上传约 1.7 GB 编译缓存，下一轮复用；未观察到磁盘耗尽。

- Windows：在固定上游源码及其 `.gitattributes` 上，复现了远端全部 35 个补丁失败文件和行号。只固定补丁 LF 仍有 12 个源码文件失败；补丁 LF 且源码检出前 `core.autocrlf=false` 时，43 个文件全部通过补丁检查。本轮同时实施两处修正，并将检查提前至依赖同步前。该复现不等于 Windows 编译已通过，也不是上游版本漂移造成的代码冲突。
- Linux arm64：官方 CIPD 查询确认同版本 x64 包存在、ARM64 tag 不存在。仅在临时 CI checkout 中禁用这一条 CIPD 条件，再从 [GNU 官方 gperf 3.2 源码](https://ftp.gnu.org/gnu/gperf/gperf-3.2.tar.gz) 原生编译到原工具路径；下载校验固定 SHA-256，安装后验证 ELF ARM64 和版本，并保存报告。用实际 depot_tools 验证发现 `custom_deps=None` 不会禁用这一 CIPD 包，因此没有采用该配置。Chromium 固定版本及其他依赖保持不变；Linux ARM64 实际构建验证仍待下一轮。
- 失败任务重跑时允许替换同名目标报告和产物，避免已存在的 artifact 名称阻断上传；成功目标不主动重跑。发布仍要求六目标同一源码、非 component 构建和原生冒烟全部通过。

本地已通过项目检查与 actionlint；本轮未迁移仓库维护方式、增加收费资源或修改运行中的浏览器。新的完整编译、缓存命中、打包和冒烟结果以随后 Actions 报告为准。

### 第二轮完整报告与工具链修正

[运行 41188981769](https://github.com/CharlesXu/AgenticBrowser/actions/runs/41188981769)，源码 `9d87cf27617a5c142c75ecc516896e45605c834c`，六目标已全部结束，发布跳过；没有目标完成打包或原生冒烟。

| 目标 | 最低剩余磁盘 GiB | 实际结果 |
|---|---:|---|
| Windows x64 | 119.7 | 补丁检查、依赖和定制补丁应用通过；GN 缺少 SDK 10.0.28000.0 的 include/um |
| Windows arm64 | 97.1 | 同上 |
| Linux arm64 | 83.5 | gperf 原生构建及 GN 通过；首批 C++ 编译退出 255/signal 127 |
| Linux x64 | 66.7 | 285 分钟时间片；缓存命中 22,200/42,223（52.58%） |
| macOS arm64 | 171.4 | 285 分钟时间片；缓存命中 20,906/27,967（74.75%） |
| macOS x64 | 203.0 | 285 分钟时间片；缓存命中 16,766/22,113（75.82%） |

三个时间片目标的缓存均成功保存，日志末构建步数分别为 52,532/60,910、34,710/72,593、27,932/74,866；不是耗时完成率。未观察到磁盘耗尽或新增编译诊断。

- Windows 增加上述官方 SDK 安装与检查，不再仅凭 Visual Studio 已安装就认为 SDK 就绪。[微软下载页](https://learn.microsoft.com/en-us/windows/apps/windows-sdk/downloads)列出与固定 Chromium 文档一致的 10.0.28000.2270；下载后检查了安装器内的版本、组件清单及 SHA-256。实际 Windows 安装和完整编译仍待新一轮 CI。
- Linux ARM64：固定 DEPS 对所有 Linux 主机选择 `Linux_x64` Clang。已下载固定官方归档并校验 SHA-256，`clang` 和 `llvm-ar` 的 ELF machine 均为 62（x64），与原 ARM64 runner 不匹配；原始编译器 stderr 未包含在报告中，不能把静态架构核验说成完整运行复现。改为上述 x64 交叉编译加独立 ARM64 原生冒烟，撤掉不再需要的 gperf 源码替换，不跳过依赖或冒烟。
- GitHub 托管 job 硬上限为 6 小时，不能将 285 分钟直接扩大五倍。保持有效的时间片和缓存接续；需要代码修正时六目标从同一新提交重新构建，仅超时且缓存有效时可在同一运行重跑失败目标。

本次本地检查：项目语法/i18n/清单、actionlint、PowerShell 语法解析通过；候选包校验接受匹配提交，拒绝旧提交、错误架构、component 构建、提前标记通过和损坏包，并拒绝在非 Linux ARM64 主机执行原生冒烟。这里只验证流水线边界，不代表 Windows SDK 已实际安装或六目标编译通过。

### 第三轮完整报告与缓存、冒烟诊断修正

[运行 41213678913](https://github.com/CharlesXu/AgenticBrowser/actions/runs/41213678913)，源码 `b8c5fe87714d117782210fbd958b69a2aacd22e6`，六目标全部结束；原生 Linux ARM64 冒烟和发布任务跳过，没有目标完成打包或通过原生冒烟。

| 目标 | 最低剩余磁盘 GiB | 实际结果 |
|---|---:|---|
| Linux x64 | 64.4 | C++ 编译及 `LINK ./chrome` 完成，ELF x64 检查通过；原生冒烟出现 `Browser exited` |
| Linux arm64 | 70.2 | x64 主机交叉编译进入正常 C++ 阶段；285 分钟时间片结束，新增 33,302 次编译 |
| macOS arm64 | 169.7 | 285 分钟时间片；缓存命中 27,966/40,011（69.90%），新增 12,045 次 |
| macOS x64 | 203.1 | 285 分钟时间片；缓存命中 21,910/24,452（89.60%），新增 2,542 次 |
| Windows x64 | 187.4 | 固定 SDK 安装、检查及 GN 通过；285 分钟时间片，21,517 次编译均无法缓存 |
| Windows arm64 | 90.4 | 固定 SDK 安装、检查及 GN 通过；整个构建步骤达到 330 分钟，未写出缓存统计 |

Linux x64 缓存命中 42,223/46,652（90.51%）。四个 Unix 目标的缓存上传成功；Windows x64 的缓存文件数和写入数都是零，上传成功不代表有可复用产物。Windows ARM64 没有统计报告，不能套用 x64 的数字。未观察到磁盘耗尽；编译步数不能换算为耗时完成率。

- Windows 缓存：固定版 ccache 4.14.2 拒绝 `/clang:` 参数，而 Chromium 默认使用 `/clang:-fno-strict-overflow` 等。增加一个仅用于 Windows 的小型编译包装脚本，对明确列出的七个单参数代码生成／诊断选项使用 [`--ccache-skip`](https://ccache.dev/manual/4.14.2.html#_extra_options)。参数仍交给编译器并进入缓存哈希，顺序保持不变；未知参数与响应文件保持原样，不扩大跳过范围。每台 Windows runner 在完整编译前验证缓存命中、头文件及参数变化失效、未知转发不缓存，以及缓存与直接编译的对象文件一致性。
- 时间预算：Windows ARM64 的准备阶段用了约 45 分钟，固定 285 分钟编译片使总时长触及 330 分钟步骤上限。编译仍最多 285 分钟，但扣除准备耗时后须在步骤约 320 分钟内停止，为保存统计留出十分钟；不突破托管 runner 硬上限。
- Linux 冒烟：原脚本丢弃退出码、信号和启动错误，也没有输出收集的 stderr，当前日志无法确定退出原因。增加有长度限制并遮盖临时会话数据的失败报告，保存阶段、已通过检查、退出信息和 stderr。保持原验收条件与沙箱要求；没有将未知原因归为沙箱、缺库或产品崩溃。

本地验证：固定 Clang/ccache 在 macOS 上生成 Windows x64、ARM64 小型 COFF 对象，复现原参数拒绝并通过上述缓存测试；使用与 Chromium 相同的 `/Brepro` 排除对象时间戳差异。启动失败（ENOENT）与进程非零退出的诊断检查、项目检查、Python 语法与 actionlint 通过。这些不等于 Windows 原生大编译或 Linux 浏览器冒烟通过；实际结果继续以新一轮六目标报告为准。

### 第四轮完整报告与运行包准备

[运行 41242734198](https://github.com/CharlesXu/AgenticBrowser/actions/runs/41242734198)，源码 `431040fa1a99d2aa926d498dd29bdbbc96b84cf5`，六目标均失败，Linux ARM64 原生冒烟及发布跳过。七份已执行任务日志和全部六份报告 artifact 已保留在本地；本轮没有完成打包或通过原生冒烟的目标。

| 目标 | 最低剩余磁盘 GiB | 结果与缓存 |
|---|---:|---|
| Linux x64 | 64.4 | 编译及 ELF x64 检查通过；冒烟以 `No usable sandbox!`、SIGABRT 退出。命中 46,648/46,652，2.1 GiB 缓存保存 |
| Linux arm64 | 66.8 | 285 分钟时间片；命中 33,301/44,641（74.60%），新增 11,340，1.4 GiB 保存 |
| macOS arm64 | 167.6 | 完整编译成功；stage 的严格签名校验失败，架构检查、冒烟及打包未到达。命中 40,010/46,882，2.1 GiB 保存 |
| macOS x64 | 201.8 | 285 分钟时间片；命中 24,655/30,191（81.66%），新增 5,536，1.2 GiB 保存 |
| Windows x64 | 115.2 | SDK、原生缓存探针通过；285 分钟结束。4,427/17,918 次可缓存，13,491 次参数不支持，0.2 GiB 保存 |
| Windows arm64 | 90.1 | SDK、原生缓存探针通过；285 分钟结束。4,963/21,007 次可缓存，其中 235 次命中；16,044 次参数不支持，0.2 GiB 保存 |

没有磁盘耗尽。时间片目标没有观察到新增编译错误；步数不代表耗时完成率。缓存探针通过也不代表完整 Chromium 参数集合均可缓存。

- Linux：固定源码发现 `chrome-sandbox` 或 `CHROME_DEVEL_SANDBOX`，原 CI 只携带 `chrome_sandbox`，未配置可用 helper。新流程把同次构建、同架构且散列一致的 helper 安装到临时 runner 的独立 root 目录，核对 root 所有权与 4755 权限，仅向原生冒烟传入环境变量，最后移除临时 helper。覆盖 x64 和独立 ARM64 冒烟；不修改全局 AppArmor/sysctl，不关闭 Chromium 沙箱。报告补充实际用户命名空间策略值。安装在 runner 上不等于给用户设备安装；包内 README 说明宿主沙箱要求。
- macOS：原 CI 在 stage 后直接严格验签，没有完整应用包签名步骤，报 `code has no resources but signature indicates they must be present`。最小嵌套应用在本机复现同一诊断；远端失败包未上传，其资源封存内容没有直接检查。对 stage 内 Mach-O 和嵌套 bundle 按由内到外的顺序作 ad-hoc 签名，保留已有 entitlements/flags，再执行原有深度严格校验。这遵循 [Apple 嵌套代码签名顺序](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)，不使用 `--deep` 代替逐项签名。ad-hoc 仅验证完整性，仍没有 Developer ID 签名或公证。
- Windows：保留七个已验证参数的精确处理范围。完整构建的实际拒绝参数尚无证据，不盲目添加跳过项；每个 job 最多采集四类真实编译命令和对应 [ccache 日志](https://ccache.dev/manual/4.14.2.html#config_log_file)，与资源报告一同上传，供下一轮精确修正。既有缓存继续保存。

本地检查：小型嵌套 macOS 应用签名后严格验签及启动成功，修改内层资源后校验拒绝；固定 Clang/ccache 的两种 Windows COFF 探针及有限诊断采样通过。Linux helper 的平台保护检查、项目检查、Python 语法和 actionlint 通过。完整 macOS 浏览器及 Linux 原生沙箱启动仍待新一轮验证，Windows 完整缓存兼容仍未解决。
