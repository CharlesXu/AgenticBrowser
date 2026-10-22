# Agentic Browser 图标

`portal.png` 为用户指定的 **02 PORTAL**：蓝紫色窗口与光标。来源为用户在“设计 Agentic Browser 图标组”对话中选择的第二个概念；2026-10-23 使用内置 imagegen 从原概念板提取为独立透明底素材。

`scripts/prepare-branding.mjs` 只进行尺寸与格式转换，生成 Chromium UI 资源、macOS `app.icns` 和 `Assets.car`。派生产物缓存于 `.runtime/branding/`，不提交构建缓存。

产品版权行显示 The Agentic Browser Team；Chromium 上游源码版权、LICENSE、关于页中的 Chromium 项目链接和 `chrome://credits` 保留。

`portal-mono.png` 从同一 Portal 母版转换为单色透明图标，用于零任务空间入口和地址栏；不再使用手绘简化几何。显示时等比缩放并按主题着色。
