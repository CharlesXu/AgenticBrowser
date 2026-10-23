# GitHub CI 与 Release

2026-10-23：按用户新要求，增加 Windows、macOS、Linux × x64、arm64 的构建与私有 Release。当前浏览器仍为 PoC；构建成功、运行冒烟和完整平台功能验收分别记录。

## 工作流

[Browser Release](https://github.com/CharlesXu/AgenticBrowser/actions/workflows/release.yml) 仅手动触发，支持：

- `preflight`：默认模式。实际检查六种 runner 的架构、内存、磁盘和基础工具链，不下载 Chromium。
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

目前仓库没有注册自托管 runner。标准 GitHub runner 文档只保证 14 GB 磁盘，不能假定足以完整构建 Chromium。流水线要求开始 checkout 前至少 100 GiB 可用磁盘、8 GiB 内存；建议专用机器 200 GiB 可用磁盘、32 GiB 内存和 8 核以上。实际结果以预检报告为准，未通过时不开始大规模下载。

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
- GitHub 执行链接与六目标实际预检结果在触发后补录。

官方依据：[GitHub runner 规格](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[大型 runner 规格](https://docs.github.com/en/actions/reference/runners/larger-runners)、[Chromium Windows 构建](https://chromium.googlesource.com/chromium/src/+/156.0.8078.48/docs/windows_build_instructions.md)、[Linux 构建](https://chromium.googlesource.com/chromium/src/+/156.0.8078.48/docs/linux/build_instructions.md)、[macOS 构建](https://chromium.googlesource.com/chromium/src/+/156.0.8078.48/docs/mac_build_instructions.md)。
