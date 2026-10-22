# Ego 能力对齐与 CDP 对照

2026-10-23，macOS ARM64 第一阶段。模型未接入；没有扩展平台或更改全局浏览器权限。

## 结论

补齐此前主要页面操作缺口：跨域 iframe、选择器和引用、select/contenteditable、语义等待、页面 JS、键鼠快捷键、弹窗、动态文件选择器、上传下载、浏览器 fetch、整页截图。新增 TaskSpace/Page Node SDK 与脚本入口，MCP 从 18 增至 33 个工具，配套 Skill 0.4.0 和接入包 0.2.1。

这表示第一阶段常用网页任务的能力覆盖扩大，**不是 Ego 所有 API 和行为完全等价**。权限范围仍是一个明确授权的非主空间。

## 实现与实际验证

| 项目 | 实现位置 | 本轮证据 |
|---|---|---|
| 空间限定协议 | `chromium/agentic_poc.cc` | 原生增量构建成功；Browser/Target 命令、外部 frame session 与失效租约被拒绝 |
| 框架、引用、表单 | `src/page.mjs` | 同源与跨域页面、shadow input、中文填写、select、contenteditable、旧文档引用拒绝 |
| 输入和等待 | 同上 | 可信点击、Meta+A 替换输入、条件等待、无限 JS 超时后可恢复 |
| 弹窗和文件 | 同上 + 原生下载观察器 | prompt 处理、popup 识别、上传文件名、动态 chooser、下载实际字节、browser fetch |
| MCP | `src/mcp.ts` | 真实 stdio 发现 33 工具，跨域填写、引用、截图、全局命令和释放租约拒绝 |
| Node CLI 与套件 | `src/agentic-browser.mjs`、`scripts/package-integration.mjs` | 打包/独立运行结果在实施记录中记载 |
| Codex / Claude Code 安装 | 两种 Plugin 清单、`src/plugin-mcp.mjs` | 0.163.0 / 2.1.251 实装发现 Skill 和 33 工具，分别完成操作、暂停、原生界面交还、恢复及释放；没有调用模型推理 |

原始测试只在独立测试 Profile 和本地合成页面运行。凭据、截图及未经筛选的日志留在 `.runtime/`，不进入提交。此前手机、锁屏、60 秒测试不重复。

下载观察只记录本空间在 Agent 持有租约期间创建的下载；没有调用影响整个 Profile 的 `Page.setDownloadBehavior`。原生协议只挂接当前页及其 iframe，不提供全局端口/pipe。输入交还时释放按住的键和鼠标。

## 保留的差异与限制

- 单空间绑定，无 Ego 式全浏览器发现、自动创建/删除空间、全局 cookie/权限/下载偏好修改。共享 Profile 与主空间仅人操作要求优先。
- SDK 标签在当前实例内有效；`finish()` 默认保留全部标签。没有自动清理用户标签和下载目录，也不提供持久 Ego Node REPL。
- AX 快照最多 1000 节点；没有 viewport/subtree 模式。选择器支持常见角色，未实现完整 ARIA 命名算法；跨多个框架有同名元素时用框架内引用。
- 等待支持 load/domcontentloaded；没有 networkidle。仅 iframe 自动挂接，不支持 worker 操作。
- 富文本通过 top-document contenteditable 插入 HTML，不等于操作系统原生粘贴事件；普通文本使用浏览器输入接口。
- 下载用正常浏览器目录，下载/权限提示仍可能需要人处理。保存拒绝覆盖，删除需要明确授权。
- 有界 JS/请求超时不能撤销已经产生的异步副作用；遇到超时或交还先观察再决定，不自动重试提交。
- 网站 UI 变化、复杂 CSS 变换框架、拖放组件未穷举验证；Harness 实装仅验证上述 Codex / Claude Code 版本，其他组合未验证。

## Ego 到底是否使用 CDP

**使用。** 官方 [`page-model.ts`](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/page-model.ts) 的页面操作经 TaskSpace gate；[`browser-runtime.ts`](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/browser-runtime.ts) 的 `rawCdp` 构造 method/params/sessionId，通过 `runtime.sendCDPMessage` 发送，接收 onCDPMessage。公开 SDK 这一路径使用内部桥接，没有发现 `Runtime.enable` 调用；此结论不外推为未公开原生实现的全部行为。

Agentic 同样通过内部 DevToolsAgentHostClient 接入，保留 native lease/generation/tab 检查。没有启用 `--enable-automation`、无头模式或公共 remote-debugging 接口，没有覆盖 `navigator.webdriver`。`Runtime.enable` 不在对外白名单。

本机 Chromium 的 `navigator.cc` 和 `runtime_features.cc` 表明 webdriver 标志由 AutomationControlled 等机制决定，不能把“发过任何 CDP 命令”直接等同为 webdriver=true。

## BrowserScan 与小红书实测

用户提供的 [BrowserScan 检测页](https://www.browserscan.net/zh/bot-detection)，在同机、同网络、不同独立测试 Profile 下：

| 场景 | 可见结果 |
|---|---|
| Ego 0.6.0.16，Agent 已接管后打开 | 总结果正常；CDP 正常；Dev Tool 正常；webdriver=false |
| Agentic，Agent 已接管后重新加载 | 总结果正常；CDP 正常；Dev Tool 正常；webdriver=false |
| Agentic，释放租约后的界面回读 | Computer Use 显示正常及 CDP/Dev Tool 正常 |
| Ego 打开小红书 `/explore` | 公开内容卡片加载；未看到本次检查的异常/安全验证提示 |
| Agentic 打开同一公开入口 | 公开内容卡片加载，有登录提示；未看到本次检查的异常/安全验证提示 |

没有登录账号、发布内容、批量抓取或处理验证码。不同版本/不同 Profile 不是严格单变量实验；未复现“CDP 接管立即拒绝”的特定故障，不能由此保证登录、搜索或长期操作都不受网站策略影响。

## 旧 CDP 检测文章的适用范围

用户给出的 [CDP detection 文章](https://publish.obsidian.md/twsc-public/Web+Scraping/Wiki/concepts/cdp-detection) 指向的经典路径，是 `Runtime.enable` 后对象预览触发自定义 `Error.stack` getter。

[DataDome 2024 原始研究](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/) 描述了这一路径，也讨论手动打开开发者工具的误报。[DataDome 2026 更新](https://datadome.co/threat-research/how-browser-vendors-are-quietly-making-automation-harder-to-detect/) 指出 V8 已在 2025 年处理预览副作用，链接到官方变更 [6506243](https://chromium-review.googlesource.com/c/v8/v8/+/6506243) 和 [6513972](https://chromium-review.googlesource.com/c/v8/v8/+/6513972)。本项目当前 V8 `src/inspector/value-mirror.cc` 中也存在 `isBuiltinGetter` 与自定义 getter 拒绝路径。

因此，旧 `Error.stack` 探针未触发不能作为“CDP 不可检测”的证据。BrowserScan 正常仅是本次该检测站的结果；站点仍可能根据账号、网络、访问频率、行为等其他信号处理请求。本轮没有为某个检测页加入伪装补丁。
