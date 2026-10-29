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
├── static-checks.mjs      # 静态契约扫描（前端 + Java/Manifest 跨端核对；含 ARCH v2 P1）
├── unit-tests.mjs         # 单元测试（util/markdown/store/bridge mock/plugins + Bridge P1 原生封装）
├── integration-tests.mjs  # jsdom 集成冒烟（真实 index.html + 全部脚本 + DSNative mock）
└── p1-integration-tests.mjs # ARCH v2 P1 集成：工具循环/文件树/终端/审计/OTP/工作区（每条独立窗口）
```

> `lib/env.mjs` 的 `createMockNative()` 同时实现了 SPEC §3 旧方法与 **ARCH v2 P1 的 14 个新方法**
> （`toolSchemas/execTool/confirmTool/workspaceInfo/listDir/readFile/writeFile/runShell/auditRecent/
> setWorkspace/requestOtp/verifyOtp/authState/logout`）；P1 事件默认不自动产生，由用例通过
> `app.native.__emit(evt)` 精确注入；运行时状态（`listDirError`/`dirs`/`files`/`audit`/`auth` 等）
> 可通过 `app.native.__p1` 读写。旧用例（82 项）在扩展后保持全绿。

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
| P1 N1 手机号登录（本地 OTP） | 登录页 tab「API Key ↔ 手机号登录」表单互斥 + aria-selected；输入手机号发送 → `requestOtp(phone)` + 60s 倒计时；注入 `otp-sent{demoCode,ttlSeconds}` → `#login-otp-hint` 显示「演示验证码：xxxxxx」与倒计时；输入验证码提交 → `verifyOtp(requestId,phone,code)` → 注入 `otp-verified ok` → 进入会话列表、`App.getAuthState()` 已登录；注入 `otp-verified ok:false` → `#login-phone-error` 显示原生 message、停留登录页、busy 复位；`authState` 已登录启动（无 API Key）→ 直接进入会话列表并提示配置 Key；设置页退出登录 → 确认弹窗 → `Bridge.logout()` 被调用 + 清空 prefs.apiKey + 回登录页 | P1 集成 · 手机号登录 6 项 |
| P1 N1 工作区切换 | 启动即调用 `workspaceInfo()`；设置页 `#set-workspace-row` 显示根目录/读写状态/存储权限（需要 All-Files-Access 提示）/「恢复默认工作区」入口与默认路径；`App.setWorkspace(newPath)` → `setWorkspace(path)` → `workspace-changed` 事件回填（file-root/设置行/`listDir(新根)`）→ 恢复默认 → `setWorkspace(defaultRoot)` + isDefault=true + 入口隐藏 | P1 集成 · 工作区 2 项 |
| P1 跨端静态契约 | `index.html` 必备 id（`file-drawer/terminal-panel/risk-modal/login-tabs/screen-audit/set-workspace-row` 等 40+）与 `data-action`；`ui.js` P1 API（`confirmRisk/renderFileTree/appendTerminal/renderAudit/setWorkspaceInfo/renderFilePreview/onOtpSent/onOtpVerified`）；`app.js` P1 handlers/对外接口/事件监听；`bridge.js` 14 个原生封装 + `waitForEvent/getLastError/readFileAsync/...`；`JsBridge.java` 14 个 `@JavascriptInterface` 方法与 6 类事件 + `requiresConfirmation/sessionConfirmedTools/pendingTools/auditTool`；原生 `agent/` 8 个类（ToolDef/ToolRegistry/ToolExecutor/PathPolicy/ShellRunner/AuditDb/AuthManager/Workspace）、5 个内置工具与风险级别、审计表字段、OTP `demoCode`/60s、Shell 30s、Manifest `MANAGE_EXTERNAL_STORAGE` | P1 静态 5 项 |
| P1 单元（Bridge 原生分支） | 原生返回值归一化：`toolSchemas/workspaceInfo/listDir/auditRecent/authState`；`listDir {error}` → `[]` + `getLastError('listDir')`；方法转发参数透传：`execTool/confirmTool/readFile/writeFile/runShell/setWorkspace/requestOtp/verifyOtp/logout`；`waitOtpVerified/waitToolResult` 事件 Promise 通道 | 单元 · bridge.js P1 原生封装 2 项 |
| P1 收尾 | P1 全流程后无未捕获脚本错误；Bridge 保持真实模式；API Key 不落 localStorage | P1 集成 · 收尾 1 项 |

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
| `authState()/logout()` | 返回 `__p1.auth`；`logout` 清登录态但保留绑定手机号并异步回 `auth-changed` | 启动分支 / 退出登录用例 |

P1 用例**每条使用独立 jsdom 窗口**（`loadAppWindow` + `close()`），不共享会话状态，可单独复现；窗口内页面错误（排除 jsdom 已知噪音）按失败处理。

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
6. 测试不做 APK 打包与真实网络请求：`scripts/build.sh`、`apksigner`、真实 DeepSeek SSE、原生 Toast/剪贴板/SAF 由 Lead 与人工验收覆盖（见 §8）。

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
- **ARCH v2 P1 真机验证**（jsdom 无法覆盖）：AI 触发 `read_file/list_dir` 的确认/结果卡片；`write_file`（MID 首次确认）与 `run_shell`（HIGH 每次确认）真机弹窗与审计落库（`filesDir/audit.db`）；PathPolicy 拒绝 `..`/symlink 越界与 `/sdcard` 未授权场景；文件树列出 `/sdcard/house-workspace`、点击预览；终端执行 `echo hi`；手机号登录通知渠道「登录验证码」显示 OTP、60s 限频/错 3 次锁 5 分钟；`setWorkspace('/sdcard/house-workspace')` 在授予 MANAGE_EXTERNAL_STORAGE 后生效；Android 11+ 「所有文件访问权限」跳转。

## 9. 最近一次执行结果

```
ALL TESTS PASSED (107)
```

- 覆盖：静态 23 项（SPEC 基线静态 10 + 跨端核对 8 + **ARCH v2 P1 静态 5**）+ 单元 41 项（基线 39 + **Bridge P1 原生封装 2**）+ 集成冒烟 25 项（v1.x 基线）+ **P1 集成 18 项** = 107 项 / 25 个 suite。
- 本次 P1 新增 **25 项**：工具链 4（tools 去重 / LOW 直执 / MID 允许 / HIGH 拒绝）、文件树 3、终端 1、审计 1、手机号登录 6、工作区 2、P1 收尾 1、P1 静态 5、Bridge P1 单元 2。
- 运行耗时约 7s；无需网络；退出码 0；旧 82 项用例在 mock 原生扩展后无回归。
- 若产品代码后续变更导致失败，`npm test` 会列出每个失败项的 suite/测试名/断言信息，退出码非 0。
