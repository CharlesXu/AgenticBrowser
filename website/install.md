# Install Agentic Browser / 安装 Agentic Browser

Status: developer preview. No public browser installer has been released yet.
当前为开发预览，尚无公开发布的浏览器安装包。

Do not describe a source checkout or component build as an installed release.
不要把源码检出或 component 开发构建表述为已安装的发布版本。

1. Detect the operating system and CPU architecture. If uncertain, ask or use the host's OS tools; an Intel-looking Mac browser user agent is not reliable evidence. 检查系统与 CPU，无法判断时明确确认。
2. Read [release manifest](releases.json). Choose an exact OS/architecture match. If absent, report that the package is not available and stop the installation. 清单没有匹配包时停止，不使用第三方镜像或替代架构。
3. Download the matching official Release and verify its published SHA-256 before installation. Preserve the user's existing browser profile. 下载正式包并核对校验值，保留原有个人资料。
4. Install the version-matched Agentic Browser integration kit for the chosen Harness. Prefer the packaged plugin, which includes the canonical Skill. Do not install duplicate Skill copies. Use the kit's instructions to configure its stdio MCP with an explicitly chosen non-main space. 安装同版本接入套件，优先 Plugin 内的统一 Skill，并为 MCP 指定非主空间。
5. Preserve other Harness configuration. Never print tokens or put them in prompts. Verify observation, claim, a harmless action, and release in the authorized task space. Check that main-space access is rejected. 保留其他配置、保护凭据，验证观察、获取控制权、简单操作和释放；主空间不可访问。

The source repository is private. Private GitHub Release links are not public download links. The download manifest remains empty until a public distribution location and actual packages are available.
源码仓库保持私有。在确定公开分发位置并实际发布安装包前，下载清单保持为空。

Platform status / 平台状态: macOS ARM64 has a local development build. Windows, Linux and x64 installers have not been released.
