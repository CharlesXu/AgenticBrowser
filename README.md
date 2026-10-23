# Agentic Browser 第一阶段 PoC

macOS ARM64 原生 Chromium 开发构建；共享登录态的多空间、主空间仅人操作、33 个受空间凭证约束的 MCP 工具，以及可选择非主空间的单路 noVNC。已增加[模型设置与决策任务](docs/模型接入与决策操控.md)，真实 API 验收后补。当前界面、Harness 接入、产品站点和 CI/CD 见 [接入与发布](docs/接入与发布.md)，实际验证记录见 [实施记录](第一阶段实施记录.md)。目前没有公开浏览器安装包。

## 当前运行方式

需要 macOS arm64、Node.js 24 或更新版本。基础启动器使用 Node 内置模块；MCP/VNC 使用锁定版本的 MCP SDK、Zod、WebSocket 和 noVNC 依赖，先运行 `npm ci`。当前仅支持本机开发用构建，不是分发安装包。

### 官方预编译浏览器预备验证

```bash
npm run baseline:prepare
npm run baseline:verify -- --testing
```

这里明确使用 **Chrome for Testing 156.0.8078.47**，是校验测试页面和共享存储行为的临时基线，不是自编译 Chromium，也不是最终产品。来源为 Google 官方 Chrome for Testing 分发；没有换用 Electron/WebView。

验证会创建全新的项目内测试 Profile，依次启动三个窗口，检查同一浏览器主进程、共享 HttpOnly Cookie 登录态、LocalStorage、IndexedDB、共享退出状态，以及独立的 sessionStorage。测试结束关闭本次浏览器；证据写入 `evidence/baseline-<run-id>.json`，不覆盖旧记录。

人工查看三个窗口：

```bash
npm run baseline -- --testing
```

主窗口点击“登录测试账号”，其他窗口会读取相同登录态。Ctrl+C 关闭本次启动的测试浏览器。窗口中的账号完全由本地页面模拟，不连接真实账号，不导入 Chrome/Ego 的数据。

这条预备命令只验证浏览器存储和窗口基础行为；页面自报告不是可信的权限边界测试。原生 Space 的入口拒绝与独立输入检查见下文。

### 原生 Chromium 基线

固定版本为 **156.0.8078.48**；该版本来自 2026-10-21 的 ChromiumDash Mac Stable 记录。源码 SHA 为 `d0c02bfad08ec92a6ffcf989e53cd995e6381a4c`。

```bash
npm run chromium:sync
npm run chromium:build
npm run baseline:verify
```

脚本将 `depot_tools` 放在 `.tools/`，源码与构建产物放在 `.chromium/`。Xcode 通过进程内的 `DEVELOPER_DIR` 指定，不改变系统 `xcode-select` 设置。构建只指定 `chrome` 目标，不构建全部测试，按本机 18 核限制为 18 个编译任务。同步/构建脚本不会切换已有源码版本或回滚修改。自动上游更新与独立 commit 规则见 [上游维护](上游维护.md)。

源码同步采用上游提供的 `checkout_configuration=small`，跳过非开发构建必需的性能基准和测试素材。已有下载缓存保留。

本机首次安装 Chromium Python 环境时出现镜像连接超时，使用 4 路下载并发和 60 秒超时后成功。脚本仅为子进程设置这两个 [uv 参数](https://docs.astral.sh/uv/reference/environment/)，保留上游依赖版本，不修改系统代理或全局包源。

构建还需要 Xcode 的 Metal Toolchain。若 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun metal --version` 报缺失，按 [Apple 官方说明](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components) 运行 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -downloadComponent MetalToolchain`。这是 Xcode 的额外构建组件；脚本会提前检查，不通过关闭图形后端绕过。

原生程序已生成于 `.chromium/src/out/AgenticPoC/Agentic Browser.app`。不带 `--testing` 的启动命令只使用这个程序；不存在就明确报错，不静默降级。当前是本机开发用 component build，依赖相邻构建文件，不能只复制 `.app` 就作为安装包分发。

### 原生 Space

```bash
npm run spaces
npm run extension:prepare
npm run spaces:verify -- --extension
```

普通启动、新窗口及其他常规 Profile 均自动带有空间；`--spaces` 启动器另提供本地测试页面与 MCP/VNC 连接文件。标题栏右上角点击 **空间入口**（或 `⌥S`）打开同窗口总览，点击卡片进入主空间或按活动顺序编号的任务空间；每个 Space 有自己的标签集合、当前标签和控制权，共用一个 Profile。总览中可用 `←` / `→` 或再次按 `⌥S` 选择工作区，`Enter` 进入；`Esc` 或右上角返回箭头关闭总览。

总览将标签栏、地址栏和真实页面画面按整个工作区的比例缩小，不再把标签栏放大成卡片标题。卡片下显示 Space 名称、页数和操作者；标签较多时保留当前标签可见。画面来自该 Space 选中页的 Chromium 合成输出，打开总览期间每秒更新，关闭后停止捕获。这是浏览器内的工作区合成预览，不是操作系统整窗截图；暂不包含扩展弹窗等独立浮层。

Agent 控制时，总览卡片和展开后的整个工作区均显示蓝色渐变、细点纹理及约 3.6 秒周期的轻微呼吸动效；中心区域保持可读。动画只在相关视图可见时刷新，不提高页面截图频率。进入 Space 只观察，不改变控制权。底部居中的浮条显示工作区及操作者，提供“接管”或“交还给 Agent”；人工接管时蓝色蒙版撤去，交还后显示等待原 Agent 恢复，原 Harness 重新观察后继续。主 Space 始终标为“仅人操作”，不显示浮条或接管／交还按钮，不发放 Agent 凭证，不开放全局 CDP 端口。

颜色由实际状态驱动：Agent 控制为蓝色；RFB 观看连接建立后为绿色；远端成功取得控制权后为红色。优先级为红、绿、蓝。交还后连接仍在则恢复绿色，断开后按 Agent／本机当前控制权恢复，不在仅发起连接或申请接管时提前变色。

标签组及 Focus Mode 仅用于展示对应 Space 的标签；Space 成员归属和权限另行保存，不能通过修改分组获取控制权。关闭一个 Space 的最后一页会补一张空白页，保留该 Space。固定标签、自定义分组及跨窗口拖拽暂不作为 PoC 支持方式。

原生归属与控制代码在 `chromium/agentic_poc.cc`，界面在 `chromium/agentic_space_controls.cc`，`scripts/apply-chromium-poc.mjs` 将其加入固定版本源码，通过可审查的上游补丁挂接。构建脚本自动应用；遇到版本不符或覆盖文件不同会停止，不回滚已有改动。

每次运行在独立测试 Profile 内生成仅当前用户可读的 `agentic-poc.json`，含随机端口、任务凭证及各非主空间的 VNC 凭证；启动器另生成 `task-a.json`、`task-b.json` 供各 MCP 实例使用。普通启动按窗口保存到实际 Profile 下的 `agentic-poc-<窗口ID>.json`；每个窗口独立端口和凭证，默认 A/B 从空白页开始。它们属于运行时秘密，不应打印或复制到聊天、日志、证据。原生接口为 `POST http://127.0.0.1:<port>/space`；任务凭证支持 `observe`、`claim`、`release`、`handOff`、`resume`、`navigate`、`click`、`type`、`scroll`，VNC 凭证分别限于所属非主空间的画面、观看和远端控制动作。

修改页面前先 `claim`，将返回的 `lease`、`generation` 和 `observe` 返回的 `tab` 带入后续动作。重新取得控制权后旧代次失效。导航仅允许 HTTP/HTTPS；点击和滚动坐标为视口 CSS 像素。响应中的 `dispatched` 只表示动作已派发，效果以页面实际结果为准；例如先观察到点击使输入框获得页面内焦点，再输入文本。MCP 只操作该 Space 的选中页，不开放任意脚本执行或全局标签管理；画面由独立授权的 VNC 链路读取。

人工接管后旧 lease 立即失效。交还后，原 Harness 用旧 lease 作为原持有者证明调用 `resume`，得到新 lease/代次；随后带新 lease/代次调用 `observe`，再使用返回的当前 `tab` 执行动作。不带控制权的观察者仍可读取任务页元信息，但不能解除恢复前的观察门槛。

`spaces:verify` 复用存储页面，一并检查主 Space 拒绝访问、错误凭证、跨任务标签、重复占用、旧控制权，以及两个客户端的独立输入。它不代替 60 秒人工并行输入和 VNC 验收。

页面输入已接入显式接管/交还；Agent、远端控制或等待恢复期间，本机页面输入被阻止，蒙版只放行 Space 总览入口和底部浮条。总览及观察期间拦截地址栏、新标签、关闭标签、刷新等常用快捷键；主 Space 正常浏览时保留这些操作。系统菜单等入口尚未全部接入控制权检查，不能据此宣称所有入口已隔离。macOS 沉浸式全屏、浏览器侧 OpenURL、独立弹窗和完整跨窗口流程尚未覆盖。

任务结束应显式释放租约。MCP 正常 EOF／退出尝试释放自己持有的租约；强制杀进程不保证清理。VNC 断开会释放远端输入并交还，浏览器另以心跳超时回收失联会话；重新连接只观看，不自动恢复控制权。

扩展样例使用 [Dark Reader 4.9.133 官方 MV3 发布包](https://github.com/darkreader/darkreader/releases/tag/v4.9.133)，加一处本地修复，只载入测试 Profile。`npm run extension:prepare` 保留并校验原始 ZIP，再让页面连接登记依次完成保存，避免扩展首次同时登记多个页面时丢失记录；没有修改 Chromium 核心。`--extension` 检查样式，证据中的 `localPatch` 标明该修复。Computer Use 已在全新 Profile 验证首次关闭、重新开启：三个 Space 同步生效，关闭后残留样式为 0，全程无刷新。见 [修复验收](evidence/extension-first-load-fix-20261022.json)。该结果限于这一带本地修复的扩展样例，不承诺全部扩展兼容。

不要同时启动多个源码同步/构建进程。源码目录尚有未完成的下载时，应先等待该进程结束，再运行同步命令。

### MCP 与 VNC

先启动 `npm run spaces`，记下启动器报告的测试 Profile 路径。两个 Harness 分别使用各自的私有连接文件：

```bash
npm run mcp -- --connection "/测试Profile路径/task-a.json"
npm run mcp -- --connection "/测试Profile路径/task-b.json"
```

Harness 配置应直接启动 `node /项目绝对路径/src/mcp.ts --connection /连接文件绝对路径`，避免 npm 启动提示混入 stdio 协议；本项目不自动修改全局 Harness 配置。MCP 提供 33 个工具，保留的控制与坐标工具为：`space_list`、`space_observe`、`space_claim`、`space_release`、`space_handoff`、`space_resume`、`space_navigate`、`space_click`、`space_type`、`space_scroll`。另有 `space_snapshot`、`space_screenshot`、`space_click_ref`、`space_fill`、`space_tabs`、`space_new_tab`、`space_select_tab`、`space_close_tab`。新增 15 个 `page_*` 工具覆盖跨域框架、表单、条件等待、页面 JS、键鼠、截图、弹窗和文件操作，并提供 `src/page.mjs` 的 TaskSpace/Page SDK；详细能力与限制见 [Ego 能力对齐](docs/Ego能力对齐.md)。单进程只能操作其连接文件授权的一个非主空间，不能通过工具参数指定其他 Space。用法见 [项目 Skill](skills/agentic-browser/SKILL.md)。

VNC 本地依赖和启动：

```bash
npm ci
npm run vnc:prepare
npm run vnc:build
npm run vnc -- --profile "/测试Profile路径" --keep-awake
```

`vnc:prepare` 从固定官方源码和校验值准备项目内 LibVNC 0.9.15，不启用系统屏幕共享；缺少 CMake、pkg-config、libpng、JPEG 或 OpenSSL 时会报告所需前置依赖。`vnc:build` 生成 `.runtime/bin/agentic-vnc`，不改 Chromium 的内核或链接库。

服务默认只监听 `127.0.0.1`。局域网试用时显式追加 `--listen <本机私有IPv4>`，不支持公网地址或 `0.0.0.0`。在本地读取 Profile 中权限为 0600 的 `vnc-session.json`，打开其中的 `url`；它含临时观看凭证，不要打印或发到聊天／日志。当前是可信局域网 PoC 的 HTTP/WS 与 VNC 会话认证，没有生产用 TLS、设备配对或云中继。

当前开放 **所有非主空间中的一路 RFB 流、一个观看客户端**；连接页提供缩略图选择，切换前先断开。noVNC 连接默认只观看，显式点“接管”后才允许输入，点“交还”或断开后撤销远端操作权。原 Harness 仍须 `resume` 并携带新控制权重新 `observe`。主 Space 不开放画面或控制接口。

手机输入：接管后先点远程页面的输入框，再点顶部“键盘”，在本地输入区用手机输入法编辑，点“发送文字”；支持中文、表情和换行，每次最多 256 字符，另有退格与回车。画布点击本身不会自动弹出手机输入法。交还、断开或失去控制权时收起输入区并停止尚未发出的文字。真实文字传输已验证，用户已在 iPhone 确认输入法弹出、中文组词和发送均正常，见 [手机输入验收](evidence/vnc-mobile-keyboard-20261022.json)。

输出为 **1280×720、最高 15 FPS**，取自原 WebContents 的 Chromium 合成结果；保留页面视口比例，以留边方式填充。VNC 只覆盖网页视口，不包含本机浏览器工具栏、蒙版或独立原生弹窗。输入经过留边反算、浏览器缩放换算、帧有效期、视口版本、标签归属和控制权代次检查；目标标签、窗口视口尺寸或浏览器缩放改变会撤销远程 lease、退回观看，必须再次明确接管。过期帧会清理输入；双指 pinch 视觉缩放状态暂拒绝远程输入，未宣称支持所有缩放。

`--keep-awake` 只在 VNC 运行期间申请防止系统空闲休眠，允许锁屏与息屏，不保证强制休眠、合盖或注销后继续运行。是否达到锁屏产帧及操作目标以本机验收记录为准。

LibVNCServer/LibVNCClient 使用 **GPL-2.0-or-later**，本项目 helper 是独立可执行程序；noVNC 主体使用 **MPL-2.0**，其随附第三方文件另有许可。独立进程是当前实现方式，不构成发布时的许可隔离结论；分发时须保留并核对相应源码和许可义务。

需要复验 MCP 时，在 A/B 空闲且都打开本地 fixture 的条件下运行：

```bash
npm run mcp:verify -- "/测试Profile路径/task-a.json" "/测试Profile路径/task-b.json" "evidence/mcp-复验.json"
```

## 小范围验证

- 已做：Chromium 156.0.8078.48 原生构建，同窗口工作区总览、键盘切换、蓝色渐变呼吸动效、底部浮条及本机观察/接管/交还；[最新验收记录](evidence/ego-v2-ui-20261022.json)、[总览截图](evidence/ego-v2-final-overview-20261022.png)、[观察与浮条](evidence/ego-v2-final-observe-20261022.png)。详细过程见 [实施记录](第一阶段实施记录.md)。
- 已验证：同一浏览器实例和 Profile、共享 Cookie/LocalStorage/IndexedDB/退出状态、独立 sessionStorage、任务 A/B 输入不串 Space、主 Space 与错误归属拒绝、重复占用和旧控制权拒绝、后台任务不切换可见 Space。
- 此前解锁后补验通过：空 Space 补页归属，以及交还后只有当前 lease/代次的观察能允许后续动作。见 [两项回归结果](evidence/space-regression-20261022.json)。本轮 UI 改造后再次通过基础检查及一次完整本机交接。
- 并行补验：用户已确认观察 A/B 时无串台或抢焦点，以及主 Space 连续输入正常；另以 Computer Use 原生输入补齐 60 秒与两个真实 MCP 客户端同时运行的记录，A/B 各 67 轮、文字完整、无串台。真人确认和工具补测分别保留，见 [完整时间段补测](evidence/native-ui-parallel-final-20261022.json)。扩展样例已修复并通过首次无刷新开关验收。
- 工作区基本管理已补齐：总览显示稳定编号，提供“＋ 新建工作区”和卡片“×”关闭；主 Space 保留，Agent／远端使用中的工作区禁止直接关闭。返回按钮移出标题栏拖动区。新增与关闭已通过 Computer Use；[本轮记录](evidence/space-lifecycle-20261022.json)。启动仍为主/A/B，新增区支持私有 MCP 绑定和 VNC 选择；尚不支持跨启动恢复空间布局。
- Space 入口已改到工具栏右上角，显示工作区总数和蓝／绿／红状态点；悬停查看各 Space 的控制状态。增量构建、数量显示与总览切换已检查；Computer Use 已验证蓝+绿、远程接管后的蓝+红、交还后的蓝+绿及断开后的空闲状态，见 [状态点记录](evidence/toolbar-status-dots-20261022.json)。
- MCP：两个实际 stdio 客户端的初始化、工具发现、独立导航、权限拒绝、旧租约及正常关闭释放均通过，见 [MCP 记录](evidence/mcp-20261022.json)。
- VNC：本机 noVNC／RFB 的观看、接管、交还及重连已验证；Computer Use 验证红色远程控制、绿色本机接管与交还原 Agent。[最终构建的坐标与边界检查](evidence/vnc-mapping-boundary-final-20261022.json)各坐标轴最大误差为 0.668 CSS px，边缘松开无按键粘连。解锁后 [125% 缩放检查](evidence/vnc-mapping-125-20261022.json)四个目标均命中，各坐标轴最大误差 1.10 CSS px；[实际改变缩放](evidence/vnc-zoom-revocation-20261022.json)会撤销旧远程控制，重新接管后恢复操作。[局域网 iPhone 实测](evidence/lan-acceptance-20261022.json)已完成三轮接管／交还、原 MCP 恢复和重连仅观看；最终 20／20 次有效，P50 115 ms、P95 143 ms、最大 144 ms，达到本次粗测 P95 ≤ 200 ms 目标。临时服务已关闭，模型未接入。
- [冻结页面像素比对](evidence/vnc-pixels-20261022.json)和[高细节页面比对](evidence/vnc-detail-20261022.json)均为原 WebContents 合成 PNG 对真实 RFB 解码结果，2,764,800 个 RGB 通道值零差异。
- 最终构建在 Mac 实际锁屏 62.315 秒期间收到 914 个独立解码帧，约 14.67 FPS；完成 1 次真实 MCP 导航及 30 轮点击／输入，以及锁屏后新建 VNC 连接、重连和交还。Canvas、WebGL、跨源 iframe 均继续推进，见 [最终锁屏记录](evidence/vnc-locked-final-20261022.json)。这次使用本机客户端，未代替局域网第二设备验收。
- 手机锁屏组合操作已由用户确认正常；本轮采样也确认手机 B 点击、中文输入与 MCP A 并行，1280×720、约 14.71 次画面更新/秒。连续锁屏记录约 20 秒，手机全程 60 秒及期间重连证据仍不齐，不计作 A09 全项通过，也不再要求用户重复手工验收。见 [收尾记录](evidence/phone-lock-closeout-20261022.json)。当前已恢复普通 VNC 页面并保留服务，[本次连接页](.runtime/lan-connect.html)使用新二维码；模型未接入。
- 真实模型按用户要求暂不接入。当前仍仅验证 Mac；Windows/Linux 和后续阶段没有扩展。

查看 [第一阶段实施记录](第一阶段实施记录.md) 了解实际状态；功能尚未通过的项目不会标记完成。

## 官方参考

- [Chromium macOS 构建说明](https://chromium.googlesource.com/chromium/src/+/main/docs/mac_build_instructions.md)
- [Chrome for Testing 官方分发](https://googlechromelabs.github.io/chrome-for-testing/)
- [ChromiumDash Mac Stable](https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=1)
- [MCP SDK stdio](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html)
- [LibVNC](https://libvnc.github.io/) · [noVNC API](https://novnc.com/noVNC/docs/API.html)

## 品牌、语言与版本（2026-10-23）

应用名为 **Agentic Browser**；产品版本由 `package.json` 管理，关于页显示产品版本、实际 Git commit 的前 16 个十六进制字符（8 字节）和进程架构，下一行显示 Chromium 内核版本。未提交源码会额外标识 `+modified`，没有提交时显示 `uncommitted`。不伪装正式发行或最新版本。

标题栏入口始终显示选定 Portal 图标的单色缩小版，不计算主空间；有任务空间时，箭头位置覆盖圆形数字角标，零任务空间时不显示角标。浅色模式为黑边、白底、黑字，深色模式反之；单色图标随主题改变颜色。状态点上蓝、中绿、下红，靠近图标；Tab 卡片不显示空间标记。中文产品术语用“空间”，英文用 Space；新增文案统一位于 `locales/en-US.json` 与 `locales/zh-CN.json`，原生界面按浏览器语言，noVNC 按客户端语言选择。其他语言暂回退英文。

应用、设置、地址栏和默认浏览器提示采用 Portal 品牌；关于页的产品版权归属显示 The Agentic Browser Team；Chromium 内核版本、上游源码版权、LICENSE 及开源链接保留。图标母版在 `assets/branding/`。首页及新 Profile 默认启动地址为 [项目站点](https://charlesxu.github.io/AgenticBrowser/)，站点与下载清单代码已实现；下载只在真实公开安装包发布后启用，不改用户已保存的首页/启动设置。浏览器自身更新以后接 GitHub Releases；本期不接更新下载或安装功能。

MCP 的 `space_handoff` 主动将当前空间交给人；原 Agent 保留旧 lease 作为身份证明，在人交还后 `space_resume` 并重新观察。`agentic-browser://guide` 返回与适配器一起发布的当前 Skill。参考 Ego 的任务连续性和交接方式，没有引入其完整 SDK 或扩大 PoC 权限。

私有源码仓库：[CharlesXu/AgenticBrowser](https://github.com/CharlesXu/AgenticBrowser)。Chromium 定制代码、上游补丁、版本 SHA 均随 commit 管理。历史验收 `evidence/` 和运行数据仅保存在本地，详见 [上游维护](上游维护.md)。本节功能验证结果见实施记录，不由“已写入源码”推导为“已验证”。

## 六目标 CI 与 Release

已增加 Windows/macOS/Linux × x64/arm64 的手动构建、冒烟、打包及私有预发布流程。先检查 runner 资源，六个目标全部成功后才发布；当前不提供开发者证书签名或公证。配置、执行方式与实际状态见 [CI 与 Release](docs/CI与Release.md)。
