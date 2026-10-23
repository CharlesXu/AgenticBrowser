# GitHub CI 与 Release

2026-10-23：按用户新要求，增加 Windows、macOS、Linux × x64、arm64 的构建与私有 Release。当前浏览器仍为 PoC；构建成功、运行冒烟和完整平台功能验收分别记录。

## 工作流

[Browser Release](https://github.com/CharlesXu/AgenticBrowser/actions/workflows/release.yml) 仅手动触发，支持：

- `preflight`：默认模式。实际检查六种 runner 的架构、内存、磁盘和基础工具链，不下载 Chromium。
- `build-one`：只构建所选 `target`，完成编译、运行冒烟、打包并上传 artifact，不发布 Release。默认 `macos-x64`，用于先测完整构建的实际磁盘峰值。
- `build-release`：在同一资源检查通过后，拉取 `chromium/upstream.json` 中的官方 tag，核对 SHA，同步依赖、应用源码与品牌、构建、检查实际二进制架构、运行小范围冒烟、打包。

每个任务使用独立 checkout 和 `out/AgenticRelease-<arch>`，`is_component_build=false`、`is_debug=false`，不使用本机运行中的 component build 或 Profile。不同 runner 可以并行；同一发布工作流不重叠，不缓存整个 Chromium 源码树。

六个目标全部成功后才进入发布任务。发布任务再次核对源码 SHA、上游版本、架构、冒烟结果、包大小和 SHA-256。先创建私有草稿并上传所有资产，回读完整后才发布为 **Pre-release**；任一目标失败不会创建可下载的完整 Release，不覆盖已有同名版本。

版本标签为 `v<产品版本>-poc.<Git SHA 前 16 位>`。文件名为：

| 平台 | x64 / arm64 产物 |
|---|---|
| macOS | `Agentic-Browser-0.1.0-macos-<arch>.dmg` |
| Windows | `Agentic-Browser-0.1.0-windows-<arch>.zip`，免安装包 |
| Linux | `Agentic-Browser-0.1.0-linux-<arch>.tar.xz` |

三个平台的默认用户数据目录独立于 Chromium；不迁移或覆盖已有 Profile，显式 `--user-data-dir` 仍优先。

同时附带 Skill/Plugin/MCP 接入套件、SHA256SUMS、构建清单、Chromium LICENSE 与 NOTICE。源码库和 Release 保持 Private；这不会自动让公开网站出现可匿名下载的链接。

## 构建机器

目前使用已有 GitHub 托管 runner，不新增机器。已取消原先未经完整编译实测的 100 GiB 磁盘拦截；磁盘预检只报告可用量。仍检查目标架构、基础工具链和 8 GiB 级内存（允许系统预留后可用内存降至 7.5 GiB）。GitHub 托管 job 限时 360 分钟，预检通过不等于编译一定能完成。

构建期间每 5 秒记录工作目录所在文件系统的剩余磁盘，报告 `disk-<target>.json` 保留最低剩余、相对构建开始的峰值增长、文件系统使用峰值及阶段采样。数字包含系统后台活动，短于采样间隔的尖峰可能遗漏；失败也保留报告。

仅在 `RUNNER_ENVIRONMENT=github-hosted` 的临时机器内，清理 Android、无关运行时等明确列出的预装目录；macOS 保留实际选中的 Xcode，清理其他 Xcode，使用 `simctl runtime delete all` 卸载并删除模拟器运行时，避免递归遍历只读挂载卷。自托管 runner 与本机不执行这些清理。继续浅克隆、无调试符号、关闭 ThinLTO；macOS 将应用移动到打包目录，阶段冒烟成功后删除本次输出目录中的中间文件，再压缩打包。

macOS 托管 runner 先通过进程级 `DEVELOPER_DIR` 选择已预装的最高正式 Xcode，再执行预检和清理；下载源码前检查 Chromium 模块构建实际需要的四个 SDK modulemap 文件。

单次编译最多 285 分钟，整个下载／构建／打包步骤最多 330 分钟，为总计 360 分钟的 job 留出缓存与报告上传时间。使用独立 ccache 4.14.2，校验官方资产 SHA-256，缓存上限 8 GiB；只缓存编译结果，不缓存 Profile、凭据或整个源码树。Clang 模块使用 depend 模式与官方文档要求的 `modules,time_macros` 设置，编译器按内容校验。缓存按平台、架构及上游配置隔离；每次使用新 key，失败也保存，以便下次重跑同一目标复用。达到时间片仍记为未完成，不跳过最终链接、原生冒烟或发布门槛。Actions 缓存可能被配额淘汰，实际命中和用量记录在 `cache-<target>.json`；没有增购缓存容量或机器。

默认 runner 为 `macos-15-intel`、`macos-15`、`windows-2025`、`windows-11-arm`、`ubuntu-24.04`、`ubuntu-24.04-arm`。可在仓库 Actions Variables 中为以下变量设置 JSON 标签数组，指向已配置、专用于此私有仓库的 runner：

| 变量 | 本机目标 |
|---|---|
| `CHROMIUM_RUNNER_MACOS_X64` | macOS x64 |
| `CHROMIUM_RUNNER_MACOS_ARM64` | macOS arm64 |
| `CHROMIUM_RUNNER_WINDOWS_X64` | Windows x64 |
| `CHROMIUM_RUNNER_WINDOWS_ARM64` | Windows arm64 |
| `CHROMIUM_RUNNER_LINUX_X64` | Linux x64 |
| `CHROMIUM_RUNNER_LINUX_ARM64` | Linux arm64 |

例如 `CHROMIUM_RUNNER_LINUX_ARM64` 的值为 `["self-hosted","Linux","ARM64","chromium"]`。不要绑定日常开发 checkout；首次源码与依赖下载较大。当前脚本要求在对应原生架构上编译及启动，不将交叉编译当作原生启动验证。

工具链：

- macOS：完整 Xcode、macOS SDK、Metal 工具；通过 `DEVELOPER_DIR` 或 `xcode-select` 正确选择。默认只有 Command Line Tools 时不会通过。
- Windows：固定 Chromium 源码要求 Visual Studio 2026 C++、ATL/MFC；ARM64 还需 ARM64 工具与库。Windows SDK 10.0.28000.2270、相应 Debugging Tools 及 x64 调试工具按该版本官方文档安装。流水线不自动接受额外软件许可或购买构建资源。
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
