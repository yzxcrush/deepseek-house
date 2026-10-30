# QA 测试说明（DeepSeek House）

> 负责人：verifier ｜ 入口：`npm test` ｜ 契约：`SPEC.md`（唯一真相来源）
> 原则：QA **只写测试**，不改 `app/**`、`scripts/build.sh`、`scripts/check-assets.sh`、`SPEC.md`。发现产品缺陷只上报 Lead。

## 1. 快速开始

```bash
cd deepseek-house
npm install          # 仅安装 devDependency: jsdom（应用本身零 npm 依赖）
npm test             # 跑全部测试；全部通过输出 ALL TESTS PASSED (n)
```

其他用法：

```bash
# 只跑某一组（按 suite/test 名称子串过滤，中英文皆可）
QA_FILTER="单元测试" npm test
QA_FILTER="集成冒烟" npm test
QA_FILTER="P1" npm test        # 只跑 ARCH v2 P1（集成 + 静态 + Bridge P1 单元）
node scripts/qa/run-tests.mjs static
node scripts/qa/run-tests.mjs "markdown"
```

- 退出码：`0` = 全部通过；`1` = 有失败项（失败项会逐条打印，含断言信息与堆栈前 8 行）。
- 运行环境：Node ≥ 20（本机 Termux Node v24）。测试不访问网络、不写 `app/`、不产生构建产物。
- jsdom 是本项目**唯一**的 npm 依赖，已位于 `devDependencies`；`node_modules/` 已被 `.gitignore` 忽略。

## 2. 目录结构

```
scripts/qa/
├── run-tests.mjs          # 主入口：注册并运行全部 suite
├── lib/harness.mjs        # 零依赖测试框架（suite/test/断言/超时/汇总）
├── lib/env.mjs            # jsdom 窗口、真实 index.html 加载、DSNative mock、stub、等待/可见性工具
├── static-checks.mjs      # 静态契约扫描（前端 + Java/Manifest 跨端核对 + P1/P2/P3 + python py_compile）
├── unit-tests.mjs         # 单元测试（util/markdown/store/bridge mock/plugins + Bridge P1/P2/P3 原生封装）
├── integration-tests.mjs  # jsdom 集成冒烟（真实 index.html + 全部脚本 + DSNative mock）
├── p1-integration-tests.mjs # ARCH v2 P1 集成：工具循环/文件树/终端/审计/工作区（每条独立窗口）
├── p2-integration-tests.mjs # ARCH v2 P2 集成：MCP 服务器管理/连接/工具发现/构建进度卡（每条独立窗口）
└── p3-integration-tests.mjs # ARCH v2 P3 集成：插件市场/HMAC/记忆注入与压缩/插件槽位（每条独立窗口）
```

> `lib/env.mjs` 的 `createMockNative()` 同时实现了 SPEC §3 旧方法与 **ARCH v2 P1 的 14 个新方法**
> （`toolSchemas/execTool/confirmTool/workspaceInfo/listDir/readFile/writeFile/runShell/auditRecent/
> setWorkspace/requestOtp/verifyOtp/authState/logout`）；P1 事件默认不自动产生，由用例通过
> `app.native.__emit(evt)` 精确注入；运行时状态（`listDirError`/`dirs`/`files`/`audit`/`auth` 等）
> 可通过 `app.native.__p1` 读写。**ARCH v2 P2 的 6 个 MCP 方法与 `mcpTools`** 也已加入
> `createMockNative()`（默认 2 个示例服务器、连接后自动发 `mcp-status`/`mcp-tools`，
> 已连接服务器的工具以 risk=MID 合并进 `toolSchemas()`；运行时状态经 `app.native.__p2` 读写）。
> **ARCH v2 P3 的插件目录 / 记忆 / HMAC 方法**同样已加入 `createMockNative()`（`opts.p3.plugins` /
> `opts.p3.memory` + `app.native.__p3` 运行时状态、`__p3.hmacFor/sha256For` 签名助手），并支持
> `opts.httpResponses` 驱动 `Bridge.httpFetch`（市场索引/源码下载）。旧用例（82→122 项）在三次扩展后均保持全绿。

## 3. 覆盖矩阵（对应 SPEC 章节）

### 3.1 v1.x 基线能力

| SPEC 章节 | 验证内容 | 测试位置 |
|---|---|---|
| §2 文件名/顺序 | 9 个 JS 按 `util→bridge→store→markdown→api→plugins→plugins_builtin→ui→app` 顺序 defer；引用文件全部存在；无 404；无外部 CDN/远程字体/图片；无 `http://` 硬编码 | 静态 · index.html 相关 6 项 |
| §3 Native 契约 | `JsBridge.java` 实现 §3.1/§3.2 全部 22 个方法；注入名 `DSNative`；事件经 `DSHost.onEvent` + `evaluateJavascript`；Manifest 权限/SDK/Activity/adjustResize/configChanges/version 完整 | 跨端静态核对 · 4 项 |
| §4.1 数据模型 | `window.Store` 全部 14 个 API；默认 prefs 符合 §6；CRUD/追加/更新/重命名/删除；排序（pinned 优先 + updatedAt 降序）；坏 localStorage 自动恢复并重写；持久化；`exportChatMarkdown` 含标题/角色；`clearAll` 保留 prefs | 单元 · store.js · 7 项 |
| §4.2 UI API | `window.UI` 全部 19 个方法存在（静态正则 + 集成运行时 typeof 双校验）；关键 DOM 容器/id 齐全；`#app` 事件委托根节点 | 静态 · 方法扫描；集成 · 页面加载 |
| §4.3 JS 模块职责 | `Util`/`Bridge`/`Store`/`Markdown`/`Api`/`DSPlugins` 全局导出与方法齐全；bridge 无原生时 mock 模式；`Api.send/cancel/verifyKey` 存在 | 静态 + 单元 + 集成运行时 |
| §4.3 markdown | `<script>` 转义；`javascript:`/`data:`/`vbscript:`/`file:` 链接过滤；代码块语言标签+复制按钮；表格/列表/引用/粗体/行内代码；流式未闭合围栏自动闭合；19 组恶意 payload DOM 验证无 XSS | 单元 · markdown.js · 8 项 |
| §4.3 util | `escapeHtml` 转义、`uuid` 200 次唯一、`formatTime` HH:MM、`normalizeBaseUrl`/`parseJSON`/`debounce` | 单元 · util.js · 5 项 |
| §4.3 bridge mock | 无 `DSNative` → `__isMock=true`；`startChat` 多次 chunk + done；cancel 后不再 chunk；prefs 读写且过滤未知字段；`validateKey` → validated；插件存储读写删；事件分发/off | 单元 · bridge.js · 7 项 |
| §5.1/§5.2 插件 | 内置插件注册（≥3，计算器/时间/网页/提示词）；`toolSchemas` OpenAI 结构合法且工具名唯一；`runTool` 返回 string；计算器 `2+3*4=14`、`(1+2)^3=27`、非法表达式返回错误串不崩；禁用后工具不再暴露；register/自定义命令/工具；`installFromCode`（含无注释头，id 从 register 推导）+ 非法代码拒绝；`installFromFile`；`remove` 外部插件、内置不可删；`onChange` | 单元 · plugins · 12 项 |
| §6 默认值/登录 | 默认 prefs 全字段；无 Key → 登录页；提交 Key → `Bridge.validateKey` → validated → 进入聊天；已配置 Key 二次启动直达聊天 | 单元 · store 默认值；集成 · 登录 3 项 |
| §6 流式与错误 | 用户气泡 → 分片 chunk → 助手气泡逐段增长 → done 后停止按钮恢复、Store 消息落定；停止 → `cancelRequest` → 保留已生成文本、迟到事件不破坏界面 | 集成 · 发送/停止 2 项 |
| §4.4 视觉基础 | `theme.css` 含 §4.4 全部核心色值（`#17212B/#0E1621/#182533/#2B5278/#5288C1`） | 静态 · CSS 变量 |
| §7.5 安全 | API Key 不落 localStorage（`dsh.v1` 不含 Key）、不出现在 console 日志、不出现在 `startChat` 请求体（只走原生 SharedPreferences + 请求头）；markdown 外链仅 http(s)/mailto，19 组 XSS payload DOM 验证；`http://` 仅允许 localhost 的内置插件抓取（Api.fetchUrl） | 集成 · 登录/发送；单元 · markdown XSS |
| §7.4 关键交互流 | 新建会话 → 列表增加；切换会话 → 消息正确；设置页改 model → `Bridge.setPrefs` spy 命中 + Store/原生同步；插件页渲染内置插件、开关实时生效；抽屉搜索过滤；返回键分层（设置页 back → 聊天 + `setBackDepth` 1→0）；插件工具调用循环（done(toolCalls) → 执行 calculator → role:"tool" 消息 → 第二轮请求 → 最终回复） | 集成 · 会话/设置/插件/搜索/返回/工具 7 项 |
| 全局 | 全部交互后页面无未捕获脚本错误；Bridge 全程保持真实模式 | 集成 · 收尾 |

### 3.2 ARCH v2 P1：本地 Agent 工作站（本次新增 25 项）

| P1 章节 | 验证内容 | 测试位置 |
|---|---|---|
| P1 N1 原生工具框架（tools 合并/去重） | 发送消息 → `startChat` 请求体 `tools` = 插件 `DSPlugins.toolSchemas()` + 原生 `DSNative.toolSchemas()`；同名工具 **native 优先**、只出现一次，非冲突插件工具保留；`App.isNativeTool()` 判定正确；请求 `toolSchemas` 有原生调用记录 | P1 集成 · 原生工具框架 1 项 |
| P1 N1 风险策略（LOW 直执 / MID 确认 / HIGH 确认） | LOW `list_dir`：`execTool` → 无确认弹窗 → `tool-result` → `role:"tool"` 消息（`toolName/toolCallId/args/result/ok/confirmed/confirmState=success`）→ 下一轮 `startChat`（历史含 assistant `tool_calls` + tool 消息）；MID `write_file`：注入 `tool-confirm(risk=mid)` → `#risk-modal` 打开（badge=MID、参数 JSON、aria-hidden=false）→ 点「允许执行」→ `confirmTool(requestId,true)` → `tool-result` → tool 消息 `confirmState=success/confirmed=true` + 工具卡片渲染（成功/结果）→ 继续请求；HIGH `run_shell`：`tool-confirm(risk=high)` → 更高风险提示 → 点「拒绝」→ `confirmTool(requestId,false)` → `tool-result ok:false,result:"用户拒绝执行"` → tool 消息 `confirmState=rejected`、卡片「已拒绝」、继续请求历史保留拒绝结果 | P1 集成 · 原生工具框架 3 项 |
| P1 U1/L1 工作区文件树 | 聊天页顶栏「文件」→ `#file-drawer` 打开（aria-hidden=false）→ `listDir(工作区根)` → `#file-root` 显示根路径 → 目录/文件行渲染（默认 3 行、目录 1 + 文件 2、`#file-foot` 计数）；点目录 → `listDir(目录路径)` + 面包屑；点文件 → `readFile(requestId, 文件路径)` → 注入 `tool-result` → `#file-preview-modal` 打开（文件名/路径/内容）；`listDir` 返回 `{error}` → `#file-tree .file-empty--error`「目录读取失败：<原生错误>」+ foot 状态 | P1 集成 · 工作区文件树 3 项 |
| P1 U1 终端面板 | 聊天页「终端」→ `#terminal-panel` 展开（hidden=false / aria-hidden=false）；输入 `echo hi` 点执行 → `runShell(requestId,'echo hi')`、执行中输入禁用且按钮「执行中…」→ 注入 `tool-result` → `#terminal-output` 出现 `$ echo hi` 与输出、`appendTerminal` 后输入恢复可用、按钮恢复「执行」 | P1 集成 · 终端 1 项 |
| P1 U1 审计日志 | 个人资料 →「审计日志」→ `auditRecent(50)` → `#audit-list` 渲染时间（`YYYY-MM-DD HH:MM:SS`）/工具/成功失败/已确认·免确认·未确认拒绝、参数与结果、`#audit-count` 条数、空状态隐藏 | P1 集成 · 审计 1 项 |
| P1 N1 工作区切换 | 启动即调用 `workspaceInfo()`；设置页 `#set-workspace-row` 显示根目录/读写状态/存储权限（需要 All-Files-Access 提示）/「恢复默认工作区」入口与默认路径；`App.setWorkspace(newPath)` → `setWorkspace(path)` → `workspace-changed` 事件回填（file-root/设置行/`listDir(新根)`）→ 恢复默认 → `setWorkspace(defaultRoot)` + isDefault=true + 入口隐藏 | P1 集成 · 工作区 2 项 |
| P1 跨端静态契约 | `index.html` 必备 id（`file-drawer/terminal-panel/risk-modal/login-tabs/screen-audit/set-workspace-row` 等 40+）与 `data-action`；`ui.js` P1 API（`confirmRisk/renderFileTree/appendTerminal/renderAudit/setWorkspaceInfo/renderFilePreview/onOtpSent/onOtpVerified`）；`app.js` P1 handlers/对外接口/事件监听；`bridge.js` 14 个原生封装 + `waitForEvent/getLastError/readFileAsync/...`；`JsBridge.java` 14 个 `@JavascriptInterface` 方法与 6 类事件 + `requiresConfirmation/sessionConfirmedTools/pendingTools/auditTool`；原生 `agent/` 8 个类（ToolDef/ToolRegistry/ToolExecutor/PathPolicy/ShellRunner/AuditDb/AuthManager/Workspace）、5 个内置工具与风险级别、审计表字段、OTP `demoCode`/60s、Shell 30s、Manifest `MANAGE_EXTERNAL_STORAGE` | P1 静态 5 项 |
| P1 单元（Bridge 原生分支） | 原生返回值归一化：`toolSchemas/workspaceInfo/listDir/auditRecent/authState`；`listDir {error}` → `[]` + `getLastError('listDir')`；方法转发参数透传：`execTool/confirmTool/readFile/writeFile/runShell/setWorkspace/requestOtp/verifyOtp/logout`；`waitOtpVerified/waitToolResult` 事件 Promise 通道 | 单元 · bridge.js P1 原生封装 2 项 |
| P1 收尾 | P1 全流程后无未捕获脚本错误；Bridge 保持真实模式；API Key 不落 localStorage | P1 集成 · 收尾 1 项 |

### 3.3 ARCH v2 P2：MCP Client + Termux 构建服务（本次新增 15 项）

| P2 章节 | 验证内容 | 测试位置 |
|---|---|---|
| P2 U2 MCP 管理页渲染 | 设置页 `#set-mcp-row`（data-action=open-mcp）→ `#screen-mcp` 可见 → `mcpServers()` 返回 2 个服务器 → `#mcp-list` 2 行；名称/URL/状态圆点（`.mcp-dot--connected/--disconnected`）/状态徽章（已连接/未连接）/工具数（`工具 5 个`、`工具 0 个`）/连接·断开·刷新·测试·编辑·删除按钮；`#mcp-count` 与设置页 `#set-mcp-count` 统计（2 个 · 1 已连接）；空状态隐藏 | P2 集成 · MCP 管理 1 项 |
| P2 U2 添加/保存服务器 | `#mcp-add` → `#mcp-form-modal` 打开；名称+非法 URL 保存 → `#mcp-form-error` 提示需 `http(s)://` 且**不调用原生**；改为合法 URL+Token 保存 → UI 回调 `onMcpSave({name,url,token,connect:true})` → `mcpSaveServer(json)` 参数透传（app 归一化后原生入参不含 connect）→ 表单关闭 → 列表 3 行 → mock 原生自动连接（状态点变绿、徽章已连接）→ 设置页统计 3 个 | P2 集成 · MCP 管理 1 项 |
| P2 N2/L2 连接与工具发现 | 点未连接行的「连接」→ `mcpConnect(id)`；mock 原生自动发 `mcp-status connecting→connected` → 状态点变绿、徽章已连接；`mcp-tools` 到达 → 工具数 2、`App.getMcpTools()`/`App.getMcpToolMap()`（echo→serverId）正确；连接后 `toolSchemas()` 包含 MCP 工具 `echo`；`mcpTools()` 补全调用 | P2 集成 · MCP 管理 1 项 |
| P2 N2 mcp-tools 事件 | 注入 `mcp-tools`（3 个工具）→ 对应行工具数实时更新为 3、状态升为 connected、`custom_tool` 映射重建；再注入另一服务器 2 个工具 → 工具数/映射同步；`#mcp-count` 刷新 | P2 集成 · MCP 管理 1 项 |
| P2 U2/L2 构建进度卡（成功） | 已连接 MCP 服务器 → `startChat` 的 tools 含 `pack_apk`（risk=mid）；模型 toolCalls → `execTool('pack_apk')` → 先建 running 工具卡（`confirmState=running`、进度 0%）；`tool-confirm(risk=mid)` → 风险弹窗 → 允许 → `confirmTool(true)`；注入 `mcp-progress` 10/45/75/100 + 日志行 → 进度条宽度/百分比、`.tool-log` 日志、行数、Store `progress/toolLog` 同步；`tool-result ok` → 工具卡「完成」/`.is-done`/100%/徽章成功、running 栈清空 → 继续请求历史含工具结果 | P2 集成 · 构建进度卡 1 项 |
| P2 U2/L2 构建进度卡（失败） | 同上流程，注入 `mcp-progress` 45% 后 `tool-result ok:false` → 工具消息 `confirmState=error`、保留最后进度 45%、`.tool-progress.is-error`、标签「构建失败」、徽章「失败」、running 栈清空、继续请求 | P2 集成 · 构建进度卡 1 项 |
| P2 静态契约 | `index.html` MCP 页/表单 id（`screen-mcp/mcp-list/mcp-add/mcp-form-modal/...`）与静态 data-action + 动态行动作；`ui.js` API（`renderMcpServers/openMcpServerForm/closeMcpForm/setMcpStatus/setToolProgress/appendToolLog/openMcpPage`）与构建卡实现；`app.js` MCP handlers/对外接口/事件监听/进度卡映射；`bridge.js` 6 个 MCP 封装 + `mcpTools/waitMcpStatus/waitMcpTools` + 3 类事件 + mock（2 示例服务器/pack_apk 进度）；`JsBridge.java` 6 个 `mcp*` `@JavascriptInterface` + `mcpTools` + `emitMcpStatus` + execTool→`mcp.callTool`；`mcp/` 包（JsonRpcClient 的 2024-11-05/streamable-http/Bearer/tools.list·call、McpManager 心跳/重连/MID+needConfirm/ToolRegistry、McpServerConfig、Prefs.mcpServers）；`termux-mcp/`（server.py 5 工具 + 5 个 JSON-RPC 方法 + Token/allow-root 安全默认、setup.sh 包清单、start.sh、README）；**实际执行 `python3 -m py_compile termux-mcp/server.py`（exit 0，缓存重定向到临时目录）** | P2 静态 6 项 |
| P2 单元（Bridge 原生分支） | MCP 返回值归一化（`mcpServers` 状态/工具数/tools、`mcpTools`）；方法转发（save/delete/connect/disconnect/refreshTools 参数透传）；`waitMcpStatus/waitMcpTools` 事件 Promise 通道（mock 原生自动 connecting→connected + tools；断开回 disconnected） | 单元 · bridge.js P2 原生封装 2 项 |
| P2 收尾 | P2 全流程后无未捕获脚本错误；Bridge 保持真实模式 | P2 集成 · 收尾 1 项 |

### 3.4 ARCH v2 P3：插件生态 + 记忆与上下文（本次新增 17 项）

| P3 章节 | 验证内容 | 测试位置 |
|---|---|---|
| P3 U3 插件市场渲染 | 设置页 `#set-market-row`（data-action=open-market）→ `#screen-market` 可见；`UI.renderMarket(2 items, statusMap)` → 2 张 `.market-card`；名称/版本/作者/描述/标签/状态徽章（已安装/可更新）/按钮（卸载；更新+卸载）/`#market-count` 与设置页统计/空状态隐藏 | P3 集成 · 插件市场 1 项 |
| P3 L3 市场索引拉取 | `#market-url` + «拉取索引» → `onMarketFetch(url)` → `DSPlugins.fetchMarketIndex` → `Bridge.httpFetch`（mock 返回索引 JSON）→ 2 卡片渲染 + toast「市场索引已加载」；非 https 索引在 UI 层拒绝（toast 含 https）且不发请求，`App.fetchMarketIndex('http://…')` 返回 false | P3 集成 · 插件市场 1 项 |
| P3 L3 市场安装/HMAC | 下载源码（第二次 httpFetch）→ sha256（JS 计算）与 `Bridge.pluginHmac` 双重校验 → `pluginWrite('<id>-<version>.js', source)` 写入（mock `pluginWriteFile`）→ 状态徽章「已安装」+ toast；卸载 → 确认弹窗 → `pluginDelete`（mock `pluginDeleteFile`）→ 状态回「未安装」 | P3 集成 · 插件市场 1 项 |
| P3 L3 签名校验失败 | 篡改索引 hmac（格式合法但不匹配）→ 安装 → 不调用 `pluginWrite`、mock 原生无插件文件、卡片徽章「校验失败」+ `.market-error`「签名校验失败」+ toast；提供「重新安装」按钮 | P3 集成 · 插件市场 1 项 |
| P3 U3 记忆页渲染 | 设置页 `#set-memory-row`（data-action=open-memory）→ `#screen-memory`；`Bridge.memoryAll` → 长期偏好 2 条（key/value + 删除按钮）/项目记忆 3 个 textarea 回填/会话摘要 1 条（摘要+chatId 标题回退+删除按钮）/计数统计/空状态/`onMemorySave` 回调存在 | P3 集成 · 记忆页 1 项 |
| P3 L3 记忆写入/删除 | 添加长期偏好（UI 弹窗）→ `onMemorySave('long_term',k,v)` → `memoryKvSet` 参数透传 + 列表刷新；删除 → 确认弹窗 → `onMemoryDelete` → `memoryKvDelete`；项目记忆保存 → 3 次 `memoryKvSet('project',tech_stack/conventions/decisions)` | P3 集成 · 记忆页 1 项 |
| P3 L3 摘要删除 | 摘要行「删除」→ 确认弹窗 → `onSummaryDelete(chatId)` → `memoryDeleteSummary(chatId)` + 列表移除 + toast | P3 集成 · 记忆页 1 项 |
| P3 L3 上下文压缩与记忆注入 | 构造 26×1000 字符（>19200）历史发送 → `Bridge.memorySaveSummary(chatId, 摘要)`（摘要含「用户：/助手：」片段）；请求 messages 保留最近 10 条且字符数下降；Store/DOM 出现 role:'note'「已压缩 X 条历史消息」；`systemPrompt` 含基础提示词 + 长期偏好（结论先行/不用官方套话）+ 项目记忆（tech_stack 等）+「之前对话摘要：」+ 摘要内容 | P3 集成 · 记忆注入 1 项 |
| P3 L3 未超预算 | 短会话发送：不写摘要、无压缩 note；`systemPrompt` 仍注入长期偏好/项目记忆 | P3 集成 · 记忆注入 1 项 |
| P3 L3 插件槽位 | mock `Bridge.pluginList/pluginRead` 返回 1 个 HousePlugin（`uiSlots()` 返回 1 个 slot）→ `DSPlugins.loadHousePlugins` 沙箱执行 → `getUiSlots` → `UI.renderPluginSlots` 渲染 `#plugin-slots .plugin-slot`（标题/类型/动作按钮）；打开插件面板（`.is-open` / aria-hidden=false）；点击 slot 按钮 → `DSPlugins.runSlotAction(slotId,'ping',{chatId})` 被调用（spy）+ toast 结果 | P3 集成 · 插件面板 1 项 |
| P3 静态契约 | `index.html` 市场/记忆/插件面板 id 与静态 data-action + 动态按钮；`ui.js` P3 API（renderMarket/openMarketPage/setMarketUrl/renderMemory/openMemoryPage/renderPluginSlots/openPluginPanel）；`plugins.js` DSPlugins 导出（loadHousePlugins/reloadHousePlugin/installHousePlugin/getUiSlots/runSlotAction/fetchMarketIndex/marketStatusMap/installMarketPlugin/removeMarketPlugin）与 HousePlugin/manifest/market 校验实现；`app.js` P3 handlers、记忆注入/压缩/handlers、`已压缩`/`之前对话摘要`/`用户偏好：`/`项目记忆：`；`JsBridge.java` 插件目录 7 方法（pluginList/pluginRead/pluginWrite/pluginDelete/pluginSetEnabled/pluginHmac/pluginOpenDir 及文件式变体）与 7 个 memory* 方法 + `@JavascriptInterface`；`plugin/PluginRepository.java`（house-plugins/sdcard/listJson/read/write/delete/setEnabled/hmac/sha256Of/openDir/文件名白名单/512KB）与 `memory/MemoryDb.java`（session_summary/memory_kv/CREATE TABLE/long_term/project/saveSummary/deleteSummary/summariesJson/kvJson/setKv/deleteKv/allJson/PRIMARY KEY） | P3 静态 4 项 |
| P3 单元（Bridge 原生分支） | `pluginList/pluginRead/pluginHmac/pluginSha256/memoryAll/memoryKvGet/memoryGetSummaries` 归一化；`pluginWrite/delete/setEnabled/openDir` 与 `memoryKvSet/Delete`、`memorySaveSummary/DeleteSummary` 参数透传（文件式方法路由） | 单元 · bridge.js P3 原生封装 2 项 |
| P3 收尾 | P3 全流程后无未捕获脚本错误；Bridge 保持真实模式 | P3 集成 · 收尾 1 项 |

## 4. jsdom 局限与测试 stub

jsdom 没有真实布局/渲染/原生桥，集成测试用以下 stub 保证可测（见 `lib/env.mjs`）：

| 缺失能力 | 处理方式 |
|---|---|
| `window.scrollTo/scrollBy`、`Element.scrollIntoView` | no-op stub |
| `Element.scrollHeight/clientHeight/scrollTop`（无布局恒 0） | 定义为可控值（1200/600/1200），供「自动滚动到底」逻辑判断 |
| `window.matchMedia` | 返回 `matches:false` 的兼容对象 |
| `requestAnimationFrame` | 优先用 jsdom（`pretendToBeVisual: true`）；缺失时 `setTimeout(16)` 兜底 |
| `URL.createObjectURL`、`window.open`、`alert/confirm`、`navigator.vibrate` | stub/no-op |
| `file://` origin 下 localStorage 不可用 | 用 `http://deepseek.house/` + 自定义 `ResourceLoader` 从磁盘读真实资源，保证 localStorage 可用 |
| 平台 API | `window.DSNative` 用完整 mock 注入（记录调用、手工驱动 chunk/done/validated/back 等事件） |
| CSS 解析报错、`Not implemented` 日志 | 集成测试过滤这些已知噪音，其余页面错误判失败 |

集成测试的 `DSNative` mock 行为：`getPrefs` 返回内存 prefs；`validateKey` 自动回 `validated ok`；`startChat` **不自动推流**，由测试逐条 `DSHost.onEvent` 注入 chunk/done，从而能精确断言「气泡逐段增长」「done 后按钮恢复」「停止后迟到事件不生效」。所有原生调用（`setPrefs`/`startChat`/`cancelRequest`/`setBackDepth`/`pluginSetEnabled` 等）均可断言。

### 4.1 ARCH v2 P1 mock 原生（`createMockNative(opts.p1)`）

| 方法 | mock 行为 | 测试注入/断言方式 |
|---|---|---|
| `toolSchemas()` | 返回 5 个内置工具 schema（`read_file`/`list_dir` LOW、`write_file` MID、`run_shell` HIGH、`http_get` LOW），可用 `opts.p1.tools` 覆盖（用于同名去重用例） | 断言 `native.__calls` 中 `toolSchemas` 调用；解析 `startChat` body.tools |
| `execTool(requestId,name,argsJson)` | 仅记录到 `__p1.pendingTools`；`autoToolEvents=true` 时按风险自动发 `tool-confirm`/`tool-result`（默认 **false**） | 断言 `execTool` 参数；用 `__emit({type:'tool-confirm',...})` 驱动弹窗 |
| `confirmTool(requestId,allow)` | 记录到 `__p1.confirmations`；`autoToolEvents` 时自动回 `tool-result`（拒绝 → `用户拒绝执行`） | 断言 `confirmTool(requestId,true/false)`；再 `__emit` `tool-result` 走拒绝/成功路径 |
| `workspaceInfo()` | 返回 `{root,writable,allFilesAccess,defaultRoot,isDefault}` JSON；`__p1.workspaceInfoError` 可模拟错误 | 设置页工作区行、`workspace-changed` 回填 |
| `listDir(path)` | 默认根目录 3 项（README.md/notes.txt/src），`src` 下 1 项；`opts.p1.dirs` 可覆盖；`__p1.listDirError` → `{"error":...}` | 文件树渲染 / 目录点击参数 / 错误行 |
| `readFile/writeFile/runShell` | 记录 requestId+参数；`autoDirectResults=true` 时自动回 `tool-result`（默认 false） | 点文件 → 断言 `readFile` 参数；终端 → 断言 `runShell` 后注入结果 |
| `auditRecent(limit)` | 返回 `opts.p1.audit` 前 N 条 | 审计页字段/时间/状态渲染 |
| `setWorkspace(path)` | 更新 `__p1.workspace.root`；默认异步回 `workspace-changed{ok,root}`（`autoWorkspaceChanged` 可关） | 断言 `setWorkspace` 参数 + 等待回填 |
| `requestOtp/verifyOtp` | 记录到 `__p1.otpRequests/verifyRequests`，**不自动发事件** | 注入 `otp-sent{demoCode,ttlSeconds}`、`otp-verified{requestId,ok,message}` |

P1 用例**每条使用独立 jsdom 窗口**（`loadAppWindow` + `close()`），不共享会话状态，可单独复现；窗口内页面错误（排除 jsdom 已知噪音）按失败处理。

### 4.2 ARCH v2 P2 mock 原生 MCP（`createMockNative(opts.p2)`）

| 方法 | mock 行为 | 测试注入/断言方式 |
|---|---|---|
| `mcpServers()` | 返回服务器数组 JSON：`{id,name,url,token,enabled,status,message,connected,toolCount,tools}`；默认 2 个示例服务器（`mcp-termux` / `mcp-remote-demo`，默认 disconnected），`opts.p2.servers` 可覆盖 | 管理页列表/统计/状态点断言；`__p2.servers` 读写 |
| `mcpSaveServer(json)` | 校验 name + `http(s)://` URL；无 id 自动生成；`enabled` 且 `saveConnect!==false` 时自动连接（同步置 connecting，异步发 connected+tools）；返回 boolean | 断言原生入参 JSON；保存后列表 +1 / 自动连接 |
| `mcpDeleteServer(id)` | 删除配置（记录 `__p2.deleted`） | 删除流程断言 |
| `mcpConnect(id)` | 置 connecting 并异步发 `mcp-status connecting→connected` + `mcp-tools`（`autoConnect:false` 可关闭自动事件） | 连接流程 / 状态点 / 工具数断言 |
| `mcpDisconnect(id)` | 置 disconnected 并异步发 `mcp-status disconnected` + 空 `mcp-tools` | 断开流程断言 |
| `mcpRefreshTools(id)` | 已连接 → 重发 `mcp-tools`；未连接 → 发 `mcp-status`（message=未连接…） | 刷新流程断言 |
| `mcpTools(id)` | 返回该服务器已连接工具 JSON 数组；未连接返回 `[]` | 工具缓存/映射断言 |
| `toolSchemas()` | 在 P1 5 个本地工具基础上，把**已连接** MCP 工具以 risk=MID 合并（名称去重、本地优先）；默认 2 个服务器 disconnected 故不影响旧用例 | `startChat` body.tools / `App.getToolSchemas()` |
| 事件 | `mcp-status`/`mcp-tools`/`mcp-progress` 经 `app.native.__emit` 注入或 mock 自动产生；`mcp-progress` 固定由用例注入以精确断言进度/日志 | 进度卡/工具数/状态断言 |

### 4.3 ARCH v2 P3 mock 原生（`createMockNative(opts.p3 / opts.httpResponses)`）

| 方法/能力 | mock 行为 | 测试注入/断言方式 |
|---|---|---|
| `pluginList()` | 返回 `opts.p3.plugins`（`{fileName,source,enabled,meta}`）派生的 JSON：id/version 从 `<id>-<version>.js` 文件名或 meta 解析，含 fileName/size/sha256/source/enabled | HousePlugin 目录加载；市场已安装判定 |
| `pluginReadFile(fileName)` | 返回对应源码（支持按 fileName 或 id 回退），缺失返回 `''` | `loadHousePlugins` 沙箱执行 |
| `pluginWriteFile/pluginDeleteFile/pluginSetEnabledFile` | 写入/删除/启停内存插件文件并记录 `__p3.writes/deletes`；文件名白名单 `.js/.json`、≤512KB | 市场安装 → `pluginWrite`；卸载 → `pluginDelete` |
| `pluginHmac(content)/pluginSha256(content)` | 确定性 64 hex mock 哈希；测试用 `app.native.__p3.hmacFor/sha256For` 取同值 | 市场索引的 hmac 生成与校验失败用例 |
| `pluginOpenDir()` | 记录调用（`__p3.dirOpens`） | 目录打开入口 |
| `memoryGetSummaries()/memorySaveSummary()/memoryDeleteSummary()` | 内存摘要表；保存/删除同步更新 `__p3.memoryWrites` | 记忆页摘要渲染/删除、压缩写摘要 |
| `memoryKvGet(scope)/memoryKvSet()/memoryKvDelete()` | 内存 KV（long_term/project），同步更新 `__p3.kv` | 长期偏好/项目记忆 CRUD、systemPrompt 注入 |
| `memoryAll()` | `{summaries,long_term,project}` JSON | 记忆页一次加载 |
| `Bridge.httpFetch` 响应表 | `opts.httpResponses[url] = {status,body}`（运行时可用 `app.native.__http.responses[url]` 改写），未配置仍回 `'{}'` | 市场索引 JSON / 插件源码下载 |

## 5. 已知说明 / SPEC 解释

1. **返回值不属 SPEC 契约**：`Store.deleteChat` 返回被删除会话对象（非 `true`）、`DSPlugins.installFromFile` 返回插件 public view（非 id 字符串）——SPEC 未规定返回类型，测试按真值/取 `id` 兼容，不视为缺陷。
2. **QA 期间发现并已修复的缺陷**（留档，防回归测试已覆盖）：
   - `markdown.js` 曾在块级解析前整体 `escapeHtml`，导致 `>` 引用块永远不生效（渲染为字面 `&gt;`）。已修复为 `<blockquote>`，单测「引用块渲染为 `<blockquote>`」防回归。
   - `plugins.js` `installFromCode` 曾强制要求 `// @id user.xxx` 注释头（与 SPEC §5.1「元数据可选」不符，且强制 `user.` 前缀）。已修复为从 `register({id})` 推导 id，单测已改为严格断言。
3. **`pluginSetEnabled` 对内置插件不调用原生**：内置插件开关状态存 localStorage（`Store.setPluginEnabled`），外部插件才同步原生，符合 §5.1「内置不可删除」的语义，不算缺陷。
4. **P1 测试假设（非 SPEC 契约，已按实现兼容）**：
   - 原生 `listDir` 失败按 SPEC 返回 `{"error":...}`（非数组）；`Bridge.listDir()` 归一化为 `[]`，错误经 `Bridge.getLastError('listDir')` 透出，UI 用 `renderFileTree({error})` 渲染错误行 —— 这是 bridge/UI 的约定，测试按此断言。
   - `workspace-changed` / `auth-changed` 事件名 SPEC 未定义（SPEC N1 只定义 tool/otp 事件），由 arch-native 补充；测试按补充契约断言。
   - 工具循环"继续请求"的 assistant 消息在 API body 中使用 OpenAI `tool_calls`（snake_case）+ tool 消息 `tool_call_id`，Store 内部为 `toolCalls`（camelCase）；测试两者都覆盖。
5. **QA 观察（低风险，仅报告，未改产品代码）**：
   - `app/assets/web/js/ui.js:4608-4624` `UI.init` 未显式调用 `setTerminalOpen(false)` 初始化终端面板：初始收起仅依赖 `index.html` 的 `aria-hidden="true"` + CSS。jsdom/真机若 CSS 加载失败，终端面板可能闪现。建议 init 末尾补一次 `setTerminalOpen(false)`（防御性，不影响现有用例）。
   - `app/assets/web/js/app.js:3403-3418` `listDir` 失败时同时渲染文件树错误行 **和** toast（`toast('无法列出目录：...')`）；真机上属重复提示，建议只保留错误行或改为单条 toast（UX 细节）。
   - 未发现阻断性/功能性缺陷；P1 实现与 SPEC N1/U1/L1 契约一致（详见覆盖矩阵）。
6. **P2 测试假设（非 SPEC 契约，已按实现兼容）**：
   - UI 回调 `onMcpSave(server)` 参数含 `connect:true`（SPEC U2「保存并连接」），但 app 归一化后写入原生的 JSON 不含 `connect` 字段（原生按 enabled+页面就绪自动连接）——测试分别断言回调与原生入参。
   - mock 原生 `mcpSaveServer`/`mcpConnect` 自动发 `mcp-status`/`mcp-tools` 以等价真实原生异步行为；`mcp-progress` 由 Termux server 可选发送（SPEC「无则仅最终结果」），测试用显式注入。
   - 已连接 MCP 工具以 OpenAI function 原始名（如 `pack_apk`）暴露；重名/非法字符时才回退 `mcp_<server>_<tool>`（`McpManager.resolveFunctionName`），JS 侧 `mcpBaseName` 两种都能识别。
7. **P2 QA 观察（低风险，仅报告，未改产品代码）**：
   - `app/assets/web/js/ui.js:1778-1802` `toolStatusOf()` 把**非空 content 一律视为「已有结果」**（`hasResult` 在 success 判定中优先于 `running`）。P2 构建进度卡的 running 消息 content 固定为「执行中…」（`app.js:1716`、`:3968`），导致构建/等待确认期间工具卡状态徽章显示「成功」（实测 `tool-badge--success`），与进度区「构建中…/等待确认…」矛盾。建议：把 `confirmState==='running'/'executing'` 判定提前到 `hasResult` 之前，或 `hasResult` 只认 `result` 字段/`ok===true`。属视觉状态误导，不影响进度条/日志/最终结果。
   - `app/assets/web/js/ui.js:2304-2318` `updateMcpCounts()` 只在 `renderMcpRows()`（进入 MCP 管理页）时执行：冷启动后直接打开设置页时「MCP 服务器」行仍显示「未配置」，直到进过一次 MCP 管理页才显示真实数量。建议 app 启动/进入设置页时调用 `UI.renderMcpServers` 或单独刷新统计。低优先级 UX。
9. **P3 测试假设（非 SPEC 契约，已按实现兼容）**：
   - 市场安装由 `plugins.js installMarketPlugin` 负责：sha256 用 JS 本地 `sha256Hex` 计算（不是 `Bridge.pluginSha256`），HMAC 用 `Bridge.pluginHmac`；索引条目的 `sha256/hmac` 必须为 64 位小写 hex，否则索引校验阶段即被过滤/报错。
   - mock 原生 `pluginHmac/pluginSha256` 用确定性 mock 哈希（非真实 SHA-256/HMAC），仅用于校验「比对逻辑」；真实算法由 Java `PluginRepository` 保证。
   - `Bridge.pluginWrite/pluginDelete/pluginSetEnabled` 对 `*.js/*.json` 文件名会自动路由到 P3 文件式原生方法（`pluginWriteFile/...`）；测试两者都覆盖。
   - 压缩阈值 = `prefs.contextBudget`（默认 24000）×80% = 19200 字符；压缩保留最近 10 条，旧消息每条前 160 字、最多 20 条写入 `session_summary`；「已压缩」提示为 `role:'note'`。
10. **P3 QA 观察（低风险，仅报告，未改产品代码）**：
   - 设置页三处入口统计（`#set-market-label` / `#set-memory-label` / P2 的 `#set-mcp-count`）都只在对应管理页 `render*` 时刷新：冷启动直接打开设置页时分别显示「未配置索引」「长期偏好 / 项目记忆」「未配置」，需进过一次管理页才显示真实数量（`ui.js` 的 `updateMarketLabels/updateMemoryLabels/updateMcpCounts` 调用点只在 render 流程）。建议 app 启动或进入设置页时统一刷新。低优先级 UX。
   - 市场索引 URL 的 localhost 例外不一致：`app.js fetchMarketIndex` 对 `http://127.0.0.1` 放行（`isLocal`），但 `plugins.js fetchMarketIndex` 只接受 `https://`（直接 `marketFail`），UI 层 `#market-fetch` 也先拒绝非 https → app 的 localhost 分支实际不可达。建议统一策略（要么插件层允许 localhost，要么删除 app 分支/注释）。
   - 未发现阻断性/功能性缺陷；P3 实现与 SPEC N3/U3/L3 契约一致（详见覆盖矩阵）。
11. 测试不做 APK 打包与真实网络请求：`scripts/build.sh`、`apksigner`、真实 DeepSeek SSE、原生 Toast/剪贴板/SAF 由 Lead 与人工验收覆盖（见 §8）。

## 6. CI 命令（GitHub Actions 片段）

QA job 不依赖 Android SDK，纯 Node 即可：

```yaml
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci            # 若 lockfile 同步；否则 npm install
      - run: npm test
```

建议在 `build-apk` 之前跑：契约/交互回归失败时不浪费 APK 构建时间。也可手动：

```bash
npm install && npm test && echo "QA OK"
```

## 7. 新增测试约定

```js
import { suite, test, ok, equal, includes } from './lib/harness.mjs';
import { createUnitWindow, runWebScripts } from './lib/env.mjs';

suite('单元测试 · 新模块');
test('行为描述', () => {
  const ctx = createUnitWindow();                 // 独立 jsdom 窗口（独立 localStorage）
  runWebScripts(ctx, ['util.js', 'bridge.js', 'store.js', 'markdown.js']); // 按 SPEC 顺序
  ok(ctx.win.Store.getPrefs().model === 'deepseek-chat', '默认模型不符');
});
```

- 每个单元测试用**独立窗口**，避免 localStorage/模块级缓存串扰；集成测试按顺序共享一个真实页面窗口（模拟真实使用轨迹）；**ARCH v2 P1 用例每条独立 `loadAppWindow` 并在 finally 中 `window.close()`**，可单独复现。
- P1 用例约定：需要 `tool-confirm/tool-result/otp-sent/otp-verified` 等异步事件时，先断言原生方法已被调用（拿 `native.__calls` 里的 `requestId`），再 `app.native.__emit({...})` 注入；需要失败分支时改 `app.native.__p1.listDirError/workspaceInfoError` 或注入 `ok:false` 事件。
- 断言信息写清「期望/实际/复现路径」，便于 Lead 分流「产品 bug vs 测试假设」。
- 测试自身失败（选择器/假设与实现不符）应先修测试；确认是 SPEC 违背才作为产品缺陷上报。

## 8. 未覆盖、建议人工/后续验证

- **原生运行时**：真机 WebView 加载 `file:///android_asset/web/index.html`、`addJavascriptInterface` 权限、`evaluateJavascript` 主线程回调、返回键分层真机表现。
- **真实网络**：DeepSeek SSE 真流式（逐行 readLine 不缓冲）、401/429/超时/断网错误提示与重试、`baseUrl` 自建端点、`deepseek-reasoner` 的 `reasoning_content` 折叠。
- **原生能力**：剪贴板、Toast、文件选择器导入插件、导出 Markdown 保存、状态栏色、退出 App。
- **视觉/交互**（jsdom 无布局）：Telegram 深色质感、气泡圆角/尾角、抽屉 220ms 动画、长按菜单（复制/删除/重命名/导出）、滚动到底悬浮按钮、输入中三点动画、`prefers-reduced-motion`、安全区 `env(safe-area-inset-*)`、键盘 `adjustResize` 行为。
- **构建验收**：`bash scripts/build.sh`、`apksigner verify`、`aapt dump badging`、`unzip -l` 资源清单（Lead 负责）。
- **APK 安装冒烟**：安装/首次启动/登录/退出登录后保留会话。
- **ARCH v2 P1 真机验证**（jsdom 无法覆盖）：AI 触发 `read_file/list_dir` 的确认/结果卡片；`write_file`（MID 首次确认）与 `run_shell`（HIGH 每次确认）真机弹窗与审计落库（`filesDir/audit.db`）；PathPolicy 拒绝 `..`/symlink 越界与 `/sdcard` 未授权场景；文件树列出 `/sdcard/house-workspace`、点击预览；终端执行 `echo hi`；`setWorkspace('/sdcard/house-workspace')` 在授予 MANAGE_EXTERNAL_STORAGE 后生效；Android 11+ 「所有文件访问权限」跳转。
- **ARCH v2 P2 真机验证**（jsdom 无法覆盖）：Termux 内 `./termux-mcp/setup.sh` + `./start.sh` 启动 Python MCP Server（127.0.0.1:8787 + Token）；App 设置 → MCP 服务器 → 添加 `http://127.0.0.1:8787/mcp` + Token → 显示已连接与 5 个工具；让 AI 调 `list_workspace` / `pack_apk`，确认弹窗（MID）→ 结果卡片与进度条/日志（Termux server 是否发 `mcp-progress` 决定进度是否实时）→ 审计落库与 tool-result；断网/Token 错误时的 error 状态与重连（1s/2s/4s/8s/30s）；`python3 -m py_compile`、`curl initialize`、`tools/list` 手工验证。
- **ARCH v2 P3 真机验证**（jsdom 无法覆盖）：插件目录（`getExternalFilesDir("house-plugins")` 与可选 `/sdcard/house-plugins`）真实读写、`.js/.json` 文件名白名单与 512KB 限制、`pluginOpenDir` 打开系统文件管理器到插件目录；用真实 `PluginRepository.hmac/sha256` 签名的本地市场索引（https 或真实部署）安装插件 → 工具出现在工具列表；HMAC/sha256 被篡改时拒绝写入；记忆页增删长期偏好/项目记忆后重启仍在（`filesDir/memory.db` 的 `session_summary`/`memory_kv` 表）；真实超长会话（>19200 字符）压缩后 `memorySaveSummary` 落库、重启后摘要仍注入 system prompt；HousePlugin `uiSlots` 面板在真机聊天页打开与动作执行。

## 9. 最近一次执行结果

```
ALL TESTS PASSED (139)
```

- 覆盖：静态 33 项（SPEC 基线静态 10 + 跨端核对 8 + **P1 静态 5** + **P2 静态 6** + **P3 静态 4**）+ 单元 45 项（基线 39 + **Bridge P1 2** + **Bridge P2 2** + **Bridge P3 2**）+ 集成冒烟 25 项（v1.x 基线）+ **P1 集成 18 项** + **P2 集成 7 项** + **P3 集成 11 项** = 139 项 / 37 个 suite。
- 本次 P3 新增 **17 项**：插件市场 4（渲染/索引拉取+非 https 拒绝/安装+HMAC 校验+卸载/HMAC 不匹配失败路径）、记忆页 3（渲染/长期&项目写入删除/摘要删除）、记忆注入与压缩 2（>19200 压缩+注入；未超预算仅注入）、插件槽位 1（HousePlugin uiSlots + runSlotAction）、P3 收尾 1、P3 静态 4、Bridge P3 单元 2。
- 此前 P1 新增 25 项、P2 新增 15 项，基线 82 项；四次扩展均保持旧用例全绿（122→139）。
- 运行耗时约 11s；无需网络；退出码 0（仅 `py_compile` 用例需要本机 `python3`，缺失会给出明确失败信息）。
- 若产品代码后续变更导致失败，`npm test` 会列出每个失败项的 suite/测试名/断言信息，退出码非 0。


## 10. ARCH v2 P4 覆盖（v2.3.0，142 项）

`scripts/qa/p4-integration-tests.mjs`（9 项）：
- 图片消息：`App.pickImage('gallery')` → 待发送队列 → `App.sendWithImages` → startChat 请求 `messages[].content` 为 `[{type:'text'},{type:'image_url',image_url:{url}}]`，发送后队列清空
- 前台通知：发送触发 `setForeground(true,'正在生成回复…')`，done 触发 `setForeground(false)`；`app-state foreground=false` + done → `notify('回复完成', …)`
- 分享进入：注入 `shared` 事件 → 新建会话 + composer 预填文本
- 应用锁：`App.toggleAppLock(true/false)` → 原生 `setAppLock` 同步
- 本地加密：`getStorageSecret` 非空时 localStorage 仅写 `dsh.v1.enc`，不保留明文 `dsh.v1`
- 工作台：`App.toggleWorkbench(true)` → 状态/持久化生效
- 构建任务面板：`UI.renderBuildTasks/updateBuildTask/openBuildPanel` 渲染进度与打开面板
- 静态契约：`workbench-toggle/build-panel/build-tasks/set-applock` 等 DOM id，UI/App/Bridge/Store 的 P4 API 与加密实现
