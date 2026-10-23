# Agentic Browser

- 第一阶段 PoC；已授权模型设置、Jev 决策操控及 Windows/macOS/Linux × x64/arm64 的 GitHub CI 构建与 Release。跨平台构建、运行冒烟和完整功能验收分开记录，不扩展其他后续功能。
- 保持主 Space 仅人操作、所有 Space 共用 Profile。不要开放全局 CDP 或绕过租约。
- `chromium/` 保存原生定制源码，`upstream.patch` 保存对官方源码的文本差异，`upstream.json` 是上游版本/SHA 的唯一配置。
- `src/` 是启动器、测试页面、MCP 和 VNC；`assets/branding/portal.png` 是用户选定的图标母版。
- `npm run chromium:build` 只构建浏览器；不要并行运行两个构建，也不要替换正在运行的 component build 文件。
- Release 使用独立 CI checkout 和非 component 构建；六个目标的构建、打包及冒烟全部通过后才发布私有预发布版本。未配置签名／公证时必须说明，不能拿本机 component 产物充当安装包。
- UI 改动用独立测试 Profile 和 Computer Use 做直接相关的检查；不要机械重跑锁屏、手机、60 秒或全部测试。
- Chromium 版权、LICENSE 和 `chrome://credits` 必须保留。应用名为 Agentic Browser。
- 私有仓库为 `CharlesXu/AgenticBrowser`。运行时 Profile、token、连接二维码、缓存、构建产物和未经筛选的验收证据不提交。
- 自动上游更新按 [上游维护](上游维护.md) 执行；不得 stash、reset、覆盖用户改动或 force push。未构建验证的更新不能声称已可用。
