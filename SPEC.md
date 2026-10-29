# DeepSeek House — 构建契约（SPEC v1）

安卓第三方 DeepSeek 客户端 APK。界面仿 Telegram（深色），支持 API Key / Token 登录，支持自由安装插件。
本文件是**唯一协作契约**：各成员只按此处定义的接口实现，不要自行改名/改签名。

## 0. 构建环境（Termux, 无 Gradle / 无 AndroidX / 无 Kotlin）
- 手工构建：`aapt` → `javac` → `d8` → `zipalign` → `apksigner`（Lead 负责 `scripts/build.sh`）。
- `android.jar`：`/data/data/com.termux/files/home/1/build/sdk/android-34/android.jar`（API 34）。
- Java 语言级别 17，**仅**可用 Android 平台 API + `org.json`（android.jar 自带）。禁止 androidx / kotlin / 第三方 jar。
- minSdk 24，targetSdk 34，applicationId `com.deepseekhouse.app`，versionName `1.0.0`，versionCode `1`。
- UI 全部是 WebView 加载 `file:///android_asset/web/index.html`，**纯 HTML/CSS/JS，无构建步骤、无 npm 依赖、无 CDN**（离线可用）。
- 界面语言：简体中文。

## 1. 目录与写入归属（严格不可越界）
| 目录/文件 | 负责人 |
|---|---|
| `app/AndroidManifest.xml`, `app/src/main/java/**`, `app/res/values/**`, `app/res/drawable/**` | native |
| `app/assets/web/index.html`, `app/assets/web/css/**`, `app/assets/web/js/ui.js` | web-shell |
| `app/assets/web/js/{app,bridge,store,api,markdown,util}.js` | web-logic |
| `app/assets/web/js/{plugins,plugins_builtin}.js`, `docs/PLUGINS.md`, `docs/examples/**` | plugins |
| `scripts/build.sh`, `keystore/**`, `dist/**`, `app/res/mipmap-*/*.png`, `SPEC.md` | lead |

只写自己名下的文件；需要改别人的接口 → 发消息给 lead。不要运行完整打包（Lead 负责），可用 `node --check` 自检 JS，Java 成员可在 `build/check-native/` 下用 javac 自检（只用该目录做输出）。

## 2. 文件名 / 资源名 / id 命名
- Java 包：`com.deepseekhouse.app`；Activity：`MainActivity`；JS 接口类：`JsBridge`。
- 资产脚本按此顺序（index.html 中 `<script>`）：`util.js`, `bridge.js`, `store.js`, `markdown.js`, `api.js`, `plugins.js`, `plugins_builtin.js`, `ui.js`, `app.js`（defer，最后 app.js 启动）。
- 资源 id 全局唯一，前缀无关；字符串集中在 `res/values/strings.xml`（`app_name` = `DeepSeek House`）。
- 图标资源：`@mipmap/ic_launcher`（Lead 生成 PNG：mipmap-mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi，48/72/96/144/192）。

## 3. Native Bridge 契约（Java `JsBridge` ⇄ JS `bridge.js`）
注入名：`DSNative`（`webView.addJavascriptInterface(new JsBridge(...), "DSNative")`）。
所有方法必须 try/catch 并返回 JSON 字符串（出错返回 `{"error":"..."}`），JS 侧永不抛异常。

### 3.1 同步方法（返回值 String，内容为 JSON）
```
String appInfo()            -> {"versionName","versionCode","filesDir","sdkInt"}
String getPrefs()           -> {"apiKey","baseUrl","model","temperature","maxTokens","stream",
                                "theme","systemPrompt","backDepth"}   // 缺省值见 §6
void   setPrefs(String json)// 部分合并；只接受已知字段；apiKey 存 SharedPreferences
String pluginsList()        -> [{"id","name","version","author","description","enabled","fileName"}]
String pluginRead(String id)-> 源码字符串（失败返回 {"error"} 形式则 JS 侧判空）
void   pluginWrite(String id, String code, String metaJson)   // 覆盖写 plugins/<id>.js + index.json
void   pluginDelete(String id)
void   pluginSetEnabled(String id, boolean enabled)
String getClipboard()
void   setClipboard(String text)
void   toast(String msg)                  // 原生 Toast
void   openUrl(String url)                // 外部浏览器
void   setBackDepth(int depth)            // JS 每次分层变化时调用；0 = 根界面
void   cancelRequest(String requestId)
void   cancelAllRequests()
void   setStatusBar(String colorHex, boolean lightIcons)
void   finishApp()                        // 退出 App
```
### 3.2 异步方法（立即返回，通过事件回调）
```
void startChat(String requestId, String bodyJson)
   bodyJson: {"model","messages":[...],"temperature","maxTokens","stream":true,
              "tools":[...opena i 风格...],"systemPrompt"}
   -> 原生 POST {baseUrl}/chat/completions，Header: Authorization: Bearer <apiKey>，
      Content-Type: application/json，Accept: text/event-stream；stream=true 时逐行解析 SSE。
void validateKey(String requestId)   // GET {baseUrl}/models，验证 key/model 列表
void httpFetch(String requestId, String reqJson)  // {"url","method","headers":{},"body"}
void importPluginFile()              // ACTION_OPEN_DOCUMENT 选 .js/.json/.txt，读文本后发事件
void saveTextFile(String suggestedName, String content)  // ACTION_CREATE_DOCUMENT，保存导出
```
### 3.3 事件（Java → JS，主线程 evaluateJavascript 调用 `window.DSHost && DSHost.onEvent(<json>)`）
```
{"type":"chunk","requestId":..,"delta":"...","reasoning":"...","toolCalls":[..]?}
{"type":"done","requestId":..,"finishReason":"stop","usage":{...}}
{"type":"error","requestId":..,"message":"...","httpStatus":401}
{"type":"validated","requestId":..,"ok":true,"models":["deepseek-chat","deepseek-reasoner"]}
{"type":"http","requestId":..,"status":200,"body":"...","error":null}
{"type":"plugin-file","id":"..","fileName":"..","content":".."}   // 用户选完插件文件
{"type":"saved","ok":true,"name":".."}
{"type":"back"}                       // 可选：原生返回键（推荐用 §3.1 setBackDepth 方案）
```
实现要点：HttpURLConnection；超时 connect 20s / read 300s；`setRequestProperty("Accept-Encoding","gzip")` 或手动处理；
SSE 读取必须**流式**（逐行 readLine，读到即发事件，不可缓冲到结束）；按 requestId 维护连接表以便 cancel（disconnect）。
`plugins/<id>.js` 与 `index.json` 位于 `getFilesDir()/plugins/`，首次创建目录。SAF 读取用 ContentResolver。
WebView 设置：JS、DOM storage、allowFileAccess、allowContentAccess、allowUniversalAccess+allowFileAccessFromFileURLs、
mixedContent=ALWAYS、媒体无手势、背景色 #17212B、禁止缩放、`WebViewClient` 拦截外部 URL 走系统浏览器。
`onBackPressed`：`backDepth>0` → `evaluateJavascript("DSHost.back()")`；否则 `moveTaskToBack(true)`。
Manifest：`INTERNET` 权限；`android:usesCleartextTraffic="true"`（允许自建 endpoint）；`configChanges` 齐全；深色主题无 ActionBar；
Activity `exported=true` + LAUNCHER；`android:windowSoftInputMode="adjustResize"`。

## 4. Web 契约
### 4.1 数据模型（localStorage key `dsh.v1`，由 `store.js` 负责）
```
state = {version:1,
  prefs:{baseUrl,model,temperature,maxTokens,stream,theme,systemPrompt},   // apiKey 不落 localStorage，走原生
  chats:[{id,title,createdAt,updatedAt,pinned,archived,model,messages:[]}],
  activeChatId,
  plugins:{enabled:{<builtinId>:true}},
  ui:{drawerOpen:false}
}
msg = {id, role:"user"|"assistant"|"tool"|"note", content, reasoning?, toolCalls?, toolName?, error?, createdAt, streaming?}
chat = {id,title,createdAt,updatedAt,pinned,model,messages}
```
`store.js` 导出 `Store`：`load/save/getPrefs/setPrefs/createChat/deleteChat/renameChat/touchChat/getChat/listChats(sorted by pinned,updatedAt)/appendMessage/updateMessage/exportChatMarkdown(id)/clearAll`。

### 4.2 UI API（web-shell 实现于 `ui.js`，web-logic 只通过它改 DOM）
`window.UI`：
```
UI.init(cb)                      // cb 见下；在 DOMContentLoaded 后由 app.js 调用一次
UI.showScreen(name)              // 'login'|'chat'|'settings'|'plugins'
UI.toast(text)                   // 短提示
UI.setHeader({title, subtitle})  // 会话标题/状态行（如 "正在输入…"）
UI.renderChatList(chats, activeId)
UI.renderMessages(chat)          // 全量渲染
UI.appendMessage(msg)            // 追加一条
UI.updateMessage(msgId, patch)   // 增量更新（流式 token 必须高效：只改该气泡内容）
UI.removeMessage(msgId)
UI.setStreaming(bool)            // 显示/隐藏停止按钮、typing 指示、光标
UI.setComposer({value?,busy?,disabled?,placeholder?})
UI.getComposer()
UI.scrollBottom(force?)
UI.setModel(model)
UI.renderSettings(prefs, models)         // 填充设置页表单
UI.renderPlugins(plugins)                // [{id,name,version,author,description,enabled,builtin}]
UI.renderLogin({hasKey,error?,busy?})
UI.setUser({name})                       // 抽屉里的用户信息（Key 已配置态）
UI.confirm(title, text) -> Promise<bool>
```
回调 `cb`：`{onSend(text), onStop(), onNewChat(), onSelectChat(id), onDeleteChat(id), onRenameChat(id,title),
onRetry(msgId), onOpenSettings(), onOpenPlugins(), onSaveSettings(patch), onLogin({apiKey,baseUrl}),
onLogout(), onPluginToggle(id,enabled), onPluginInstall(code), onPluginRemove(id), onExportChat(id),
onSearch(q), onCommand(text), onBack(), onCopy(text)}`
（事件挂到 `#app` 的事件委托上；web-shell 负责调用这些回调，web-logic 只提供实现。）

### 4.3 JS 模块职责
- `util.js`：`$`/`$$`、`el()`、`escapeHtml`、`formatTime`、`debounce`、`uuid()`、`sleep`、`copyText`（内部调 bridge）。挂 `window.Util`。
- `bridge.js`：`window.Bridge = {prefs,setPrefs,startChat,validateKey,httpFetch,plugins,pluginRead,pluginWrite,pluginDelete,pluginSetEnabled,importPluginFile,saveTextFile,toast,openUrl,clipboard,setBackDepth,setStatusBar,finishApp,onEvent(type,fn), emit}`；
  内部 `call(method,...args)` 包 try/catch；事件从 `window.DSHost.onEvent` 分发；**无 DSNative 时进入 mock 模式**（本地伪造流式回复，便于浏览器/Node 自测）。
- `api.js`：`Api.send({chat,messages,onChunk,onDone,onError})` 组装 body（含插件 tools）、发 requestId、事件路由、取消；`Api.regenerate`；`Api.verifyKey()`。
- `app.js`：状态机与全部业务：登录/校验、聊天 CRUD、发送/流式渲染/停止/重试、标题自动生成、插件命令与工具调用循环（tool_calls → 执行插件工具 → 追加 role:"tool" 消息 → 继续请求，最多 3 轮）、搜索、导出、返回键、启动引导。
- `markdown.js`：`renderMarkdown(text)` 安全渲染（先 escape；支持 ```代码块```+复制按钮、行内 code、粗体/斜体/删除线、标题、有序/无序列表、引用、链接、表格、hr）；代码块含语言标签与「复制」`data-action="copy-code"`。
- `plugins.js`：`window.DSPlugins` 插件管理器（§5）。
- `plugins_builtin.js`：内置插件注册（§5）。
- `ui.js`：所有 DOM/渲染/动画/屏幕切换/抽屉/设置表单/插件列表/登录页；不直接发网络请求。

### 4.4 视觉规范（Telegram 风格，必须移动端原生质感）
- 深色：`--bg:#17212B; --panel:#0E1621; --sidebar:#17212B; --header:#17212B; --bubble-in:#182533;
  --bubble-out:#2B5278; --accent:#5288C1; --accent-2:#6AB2F2; --text:#FFFFFF; --muted:#7D8E98;
  --divider:#101921; --danger:#E05D5D; --online:#4FD05B;` 气泡圆角 18px，外侧角 6px，尾部伪元素可选。
- 布局：顶栏 56px（左汉堡 / 标题+副标题 / 右搜索或更多）；抽屉宽 min(78vw,320px)，遮罩 rgba(0,0,0,.45)，
  220ms `cubic-bezier(.2,.9,.3,1)` 滑动；消息区 `flex:1; overflow-y:auto`；输入栏底部固定，含插件/附件圆钮、圆角输入框、发送圆钮（流式时变停止方块）。
- 气泡：用户右侧蓝(`--bubble-out`)，AI 左侧深蓝(`--bubble-in`)，`max-width:82%`，时间戳小字右下，AI 消息含"复制/重新生成"快捷，
  推理内容(`reasoning`)折叠块（"思考中…"/"已思考"），工具调用显示为小 chip。
- 细节：日期分隔 chip、空状态 logo + 建议提示词 4 个卡片、滚动到底部悬浮按钮、输入中三点动画、`100dvh` + 安全区 `env(safe-area-inset-*)`、
  禁用文本选中拖拽、`-webkit-tap-highlight-color:transparent`、`prefers-reduced-motion`、长按菜单（复制/删除）。
- 字体栈：`-apple-system, "Segoe UI", Roboto, "Noto Sans SC", "PingFang SC", sans-serif`；等宽 `ui-monospace, "JetBrains Mono", monospace`。
- 不使用外部字体/图片/CDN；图标用内联 SVG。

## 5. 插件系统契约
### 5.1 插件定义
```
DSPlugins.register({
  id:"calculator",            // 唯一，内置用内置名，外部插件建议 "user.<name>"
  name:"计算器", version:"1.0.0", author:"...", description:"...",
  builtin:true,               // 内置插件为 true（不可删除，可禁用）
  commands:[{name:"calc", description:"计算表达式", usage:"/calc 1+2*3", run:async(ctx,args)=>string}],
  tools:[{name:"calculator", description:"计算数学表达式", parameters:{type:"object",properties:{...},required:[...]},
          run:async(ctx,args)=>string}],   // 会作为 function calling 工具暴露给模型
  hooks:{ onBeforeSend?(ctx,payload), onResponse?(ctx,msg), onCommand?(ctx,cmd,args) },
  settings?:{...}             // 可选，插件设置项 schema（json 简化版），由插件页渲染
})
```
`ctx` = `{settings:{get,set}, toast(msg), ui, http:{fetch(url,opts)}, chat:{id,title,messages,systemPrompt},
addNote(text), appendMessage(msg), store}`。
### 5.2 管理器 API（`window.DSPlugins`）
```
list() / get(id) / register(def) / setEnabled(id,on) / isEnabled(id)
async loadExternal()        // 原生 pluginsList + pluginRead + eval 注册（沙箱：new Function("ctx", code)? 用 (0,eval) 全局）
toolSchemas()              // 已启用插件的 tools → OpenAI tools 数组
async runTool(name,args,ctx) -> string
async runCommand(cmd,args,ctx) -> string|null
async installFromCode(code)  // 校验 id/name 后 Bridge.pluginWrite 并注册
async installFromFile()      // Bridge.importPluginFile → 事件回填 → installFromCode
async remove(id)
onChange(fn)                // 状态变化通知（UI 刷新插件列表）
```
外部插件文件格式（`.js`，亦可 `.json` = `{"id","name","version","code"}`）：整段代码在全局作用域执行，须调用
`window.DSPlugins.register({...})`；以注释头提供元数据 `// @id user.foo` 等可选。
安全：仅本机用户主动安装的插件才执行；http 只允许 https（http 仅 127.0.0.1/localhost）。
### 5.3 内置插件（至少 3 个，全部可禁用）
计算器（安全表达式求值，无 eval/Function，支持 + - * / % ^ 括号与常见函数）、时间日期（当前时间/倒计时）、
网页抓取（通过 ctx.http.fetch 拉取 URL 文本并摘要，要求 https）、提示词库/翻译模板（本地模板，无需网络）。

## 6. 默认值 / 行为
- 默认 prefs：`baseUrl=https://api.deepseek.com`，`model=deepseek-chat`，`temperature=1.0`，`maxTokens=4096`，
  `stream=true`，`theme=dark`，`systemPrompt="你是 DeepSeek House 助手…（中文回答）"`。
- 模型列表：`deepseek-chat`（DeepSeek-V3.2 通用）、`deepseek-reasoner`（推理模型，含 reasoning_content）。
- 首次启动无 key → 登录页（输入 Key / 从剪贴板粘贴 / 去 platform.deepseek.com 申请 / 可改 Base URL）→ validateKey 成功才进入。
- `deepseek-reasoner` 的 `reasoning_content` 必须显示在折叠的"思考过程"里，正文流式照常渲染。
- 错误处理：401 → 提示 Key 无效并跳设置；429 → 提示限流；网络错误 → 消息气泡内错误 + 重试按钮；停止后保留已生成内容。
- 流式渲染性能：每 ~50ms 批量刷新一次 DOM（rAF），不要每个 token 全量重渲染。

## 7. 验收清单（Lead 会逐条检查）
1. `bash scripts/build.sh` 成功产出 `dist/DeepSeekHouse.apk`，`apksigner verify` 通过，`aapt dump badging` 含图标/标签/权限。
2. `unzip -l` 含 `assets/web/index.html` 及全部 js/css；无 404 引用（HTML 引用的文件都存在）。
3. `node --check` 全部 JS 通过；无语法错；`window.UI`/`window.Bridge`/`window.DSPlugins` 契约齐全。
4. 关键交互流（用 Node 冒烟测试 + 代码审查）：登录→发消息→流式渲染→停止→重试→新建/删除会话→切换会话→设置保存→
   插件启用/禁用/安装/工具调用→导出→返回键分层。
5. 无外部网络资源引用；无 `http://` 硬编码（默认 https）；API Key 只在 SharedPreferences + 请求头，不写日志。
6. 界面视觉符合 §4.4（深色、Telegram 布局、气泡、抽屉、动画）。

---

# 追加需求 v1.1（2026-10-29）：深色锁定 + 模型选择器

## A. 深色主题（强制，所有成员遵守）
- 界面只能是**深色**：`html/body/#app` 背景 `#17212B`，无任何白色/浅色整屏幕；控件（输入框、弹窗、按钮、开关、设置行、下拉/选择器）一律深色；
  禁止 `background:#fff`/`#f*`/浅色渐变作为面板底色（`#fff` 仅允许用于开关圆点、按钮文字等前景细节）。
- `<meta name="color-scheme" content="dark">`、`color-scheme: dark`、WebView 背景 `#17212B`、状态栏 `#17212B`、导航栏 `#0E1621`（已有）。
- 系统深浅色跟随无效：App 永远深色。登录页、设置页、插件页、模型选择器、Toast、确认弹窗、长按菜单全部深色。
- 无白色闪屏：原生窗口背景与 WebView 背景均已深色（已实现）；CSS 首屏不得有浅色骨架。

## B. 模型选择器（对标 DeepSeek Harness 网页版）
### B1. 模型条目结构（app.js 构造，UI 只渲染）
```
ModelInfo = { id:string, label:string, series:"V4"|"V3"|"V2"|"V1"|"其他", tag:"pro"|"flash"|"chat"|"reasoner"|"free"|"vision"|"", desc?:string }
```
- `label` 人类可读：`deepseek-v4-pro` → `DeepSeek V4 Pro`；`deepseek-v4.1-flash` → `DeepSeek V4.1 Flash`；`deepseek-reasoner` → `DeepSeek Reasoner`。
- `series` 由 id 推断（含 `v1`/`v2`/`v3`/`v4` 分组；无版本号归"其他"），**允许任意数量/任意版本**，不要写死只有 V3/V4。
- 内置回退目录（无 key 或 /models 失败时展示，顺序固定）：
  V4: deepseek-v4-pro, deepseek-v4.1-flash, deepseek-v4-flash, deepseek-v4-pro-0813, deepseek-v4-flash-0731, deepseek-v4.1-flash-free
  V3: deepseek-v3.2, deepseek-chat, deepseek-reasoner
  其他: deepseek-flash
- 运行时以 `GET /models`（现有 `Bridge.validateKey` 返回的 `models` 字符串数组）**合并覆盖**回退目录：远端返回的 id 全部展示，未知 id 自动推断 series/label。
- 用户可添加**自定义模型 ID**（任意字符串，持久化到 `state.customModels`，出现在"自定义"分组），也可删除自定义项。
- 选择结果：`state.prefs.model` 全局默认 + 当前 `chat.model`；持久化走 `Bridge.setPrefs` + `Store`；模型与当前会话绑定，新建会话继承全局默认。
- 当前模型不在目录中时（例如手输 id），目录里要显示一条该 id 的条目并选中。

### B2. UI API 追加（web-shell 实现于 ui.js；web-logic 只调用）
```
UI.openModelPicker(models, currentId, onPick)   // 底部弹出面板；onPick(id) 选中，关闭时 onPick(null)
UI.setModelLabel(label)                        // 顶栏副标题 / 设置页当前模型名
UI.closeModelPicker()
```
- 视觉：底部弹层（圆角顶部 20px、拖拽把手、深色 `#0E1621`、260ms 上滑、遮罩 rgba(0,0,0,.5)）；顶部标题"选择模型"+关闭钮；
  搜索框（按 label/id 过滤）；分组标题（V4 系列/V3 系列/V2 系列/V1 系列/自定义/其他），每行：左侧名称+id 小字，右侧 tag 徽章与选中勾；
  底部"＋ 自定义模型 ID"：展开输入框 + 添加并选中；键盘弹出时面板随 adjustResize 上移，可滚动，安全区适配。
- 设置页"模型"行改为显示当前模型名 + 右侧"更改"箭头，点击打开同一选择器；聊天页顶部副标题显示当前模型名（如 `DeepSeek V4 Pro`），点击打开选择器。
- 新回调（UI.init cb 追加，app.js 提供）：`onOpenModelPicker()`；`onSelectModel(id)`。
- 打开选择器时若目录为空/仅回退，显示"从 API 获取模型列表"按钮（触发 `onRefreshModels()`）。

### B3. 测试要求
- QA 增加：模型选择器渲染分组、选择后 `Bridge.setPrefs({model})` 被调用、重启后 model 保持、自定义模型添加/删除、远端目录合并、深色断言（jsdom `getComputedStyle(document.body).backgroundColor` 为深色）。

---

# 追加需求 v2.0（2026-10-29）：⭐⭐ 功能清单（F1–F9）

版本规划：v1.2.0 = F1/F2/F3/F4/F5；v1.3.0 = F6/F7/F8；v1.4.0 = F9。
所有新 UI 继续遵循「Telegram 深色 / #181818 / #517AF6」设计语言；新增功能必须有 QA 用例。

## F1 智能体预设（Agents）
- `Store.presets: [{id,name,systemPrompt,model?,builtin?}]`，内置 4 个（通用助手/程序员/翻译/写作），支持增删改（后端持久化到 `dsh.v1`）。
- 新建会话流程：点 FAB/新会话 → 底部弹层「选择智能体」（预设列表 + 默认会话 + 管理预设）；选中后新建 chat：`title=预设名`，消息请求的 system prompt = `preset.systemPrompt`（若为空用 prefs.systemPrompt），`model` 用预设指定的模型或当前模型。
- 设置页新增「智能体预设」入口 → 管理页：列表（名称/简介/编辑/删除）+「新建预设」（名称 + 提示词，用现有 UI.prompt/输入弹窗）。
- UI API：`UI.openAgentPicker(agents, currentId, onPick)`、`UI.renderAgents(agents)`；回调：`onPickAgent(id)`、`onSaveAgent(agent)`、`onDeleteAgent(id)`。
- 聊天页顶栏标题使用 chat.title（预设名），副标题仍显示模型。

## F2 归档 / 聊天文件夹
- 会话列表顶部标签：`全部` / `归档`（复用 Telegram 文件夹样式，含计数）。
- 长按会话菜单新增「归档 / 取消归档」（`Store.updateChat(id,{archived:bool})`）。
- `全部` 不显示 archived；`归档` 只显示 archived；搜索在当前标签内过滤。
- UI 内部维护 `state.chatTab`（'all'|'archived'），渲染时过滤；回调 `onArchiveChat(id, archived)`。

## F3 备份 / 导入导出（JSON）
- 导出：`{app:'DeepSeekHouse', version, exportedAt, prefs(不含 apiKey), chats, customModels, presets, pluginStates}` → `Bridge.saveTextFile('DeepSeekHouse-backup-YYYYMMDD.json', json)`。
- 导入：`Bridge.importTextFile()`（原生 SAF 选 .json）→ 事件 `{type:"file-imported", name, content}`；JS 校验后**整体替换**（二次确认），刷新列表/设置。
- 入口：个人资料「更多」新增「备份与恢复」→ 弹窗两个按钮（导出备份 / 导入备份）。
- 原生新增：`void importTextFile()`（ACTION_OPEN_DOCUMENT，text/json），事件 `file-imported`。

## F4 对话分支（简化 fork）
- 长按任意消息菜单新增「从此处新建分支」：复制该会话从开头到该条消息的副本为新会话（新 id、title 加「 · 分支」、model 沿用），设为当前并进入对话。
- `Store.forkChat(chatId, msgId)` 返回新 chat；UI 菜单项通过回调 `onForkMessage(msgId)`。

## F5 联网搜索插件 + 引用来源
- `plugins_builtin.js` 新增内置插件 `websearch`（可禁用）：
  - 工具 `web_search`：参数 `{query, max_results?}`；通过 `ctx.http.fetch` 调用可配置搜索端点：
    - SearXNG 兼容：`GET {endpoint}?q=...&format=json`，解析 `results[{title,url,content}]`
    - Serper 兼容：`POST {endpoint}` header `X-API-KEY`，body `{q}`，解析 `organic[{title,link,snippet}]`
  - 插件设置项（endpoint/apiKey/类型）存 Store 插件设置；未配置时返回中文错误提示引导去设置。
  - 工具返回 JSON 字符串：`{query, results:[{title,url,snippet}]}`（最多 5 条，仅 https）。
- 聊天集成：当工具名 `web_search` 的结果被回填后，把解析出的 results 存到该 assistant 消息的 `citations` 字段（`[{title,url,snippet}]`），并在气泡下方渲染引用卡片（Telegram 链接预览风格：标题、域名、摘要，点击 `Bridge.openUrl`）。
- UI API：`UI.renderCitations` 由消息渲染内部处理；`msg.citations` 数据结构固定。

## F6 图片输入（多模态）
- 原生新增：`void pickImage(String source)`（source='gallery'|'camera'）；读取后等比缩放到最长边 ≤1280、JPEG 80，回调事件
  `{type:"image-picked", dataUrl:"data:image/jpeg;base64,...", width, height, name}`；失败事件 `{type:"image-error", message}`。
- 输入栏附件按钮：点击弹出操作表（拍照 / 从相册选择 / 插件）；选图后显示缩略图 chip（可删除），发送时：
  - 消息结构 `msg.images:[dataUrl...]`，气泡内渲染缩略图（点击全屏预览用 `<img>` 覆盖层）。
  - API body：`messages[].content` 改为数组 `[{type:"text",text:...},{type:"image_url",image_url:{url:dataUrl}}]`（仅当有图片；无图保持字符串）。
  - 非 vision 模型发图时 toast 提醒（仍允许发送）。
- 存储注意：图片 base64 体积大，localStorage 限制 ~5MB → 保存前压缩到 ≤160KB/图，且会话内最多保留最近 4 张；超出提示。

## F7 后台继续生成 + 完成通知
- 原生：`void setForeground(boolean active, String text)` → 生成期间启动前台服务（通知渠道「生成中」，低优先级，停止时移除）；`void notify(String title, String text)` → 完成通知（渠道「消息」）；Manifest：`FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_DATA_SYNC`（按 target 34）、`POST_NOTIFICATIONS`（运行时请求，API33+）。
- JS：请求开始 `Bridge.setForeground(true,'正在生成回复…')`；done/error/stop 时 `setForeground(false)`；若完成时 App 不在前台（原生事件 `{type:"app-state", foreground:false}`），再 `Bridge.notify('回复完成', 摘要)`。
- 原生需上报前台状态事件：`{type:"app-state", foreground:true|false}`（onResume/onPause）。

## F8 从其他 App 分享进入
- Manifest 增加 `ACTION_SEND`（text/plain、image/*）intent-filter。
- `MainActivity` 处理 `onCreate/onNewIntent`：读取 EXTRA_TEXT 与图片（缩图后 dataURL），暂存；WebView 加载完成后发事件 `{type:"shared", text, imageDataUrl}`（只消费一次）。
- JS：收到后新建会话（默认预设/当前模型）→ 若有 text 填入输入框并聚焦；若有图片加入待发送图片队列；toast「已接收分享内容」。

## F9 锁屏 / 指纹解锁 + 本地加密
- 原生：设置 `appLock`（SharedPreferences）开启后，`MainActivity.onCreate` 在加载 WebView 前用 `KeyguardManager.createConfirmDeviceCredentialIntent` 验证（PIN/图案/指纹均可）；取消则 `finish()`。桥接 `void setAppLock(boolean enabled)`、`boolean isAppLockEnabled()`（JS 设置页开关）。
- 本地加密：原生 `String getStorageSecret()` 返回 32 字节随机密钥的 Base64（用 Android Keystore AES 包裹后存 SharedPreferences，首次生成）；
  JS `Store` 在密钥可用时用 WebCrypto AES-GCM 加密整个状态 JSON 再写入 localStorage（key `dsh.v1.enc`），加载时解密；无 WebCrypto/无 bridge 时回退明文并标记 `dsh.v1`（向后兼容：检测到明文自动迁移加密）。加密失败不得丢数据（保留旧键）。
- 设置页新增「应用锁（指纹/密码）」开关；开启后下次启动需验证。
- QA：mock bridge 提供固定密钥，断言加密后 localStorage 无明文（如聊天内容字符串不出现），解密后数据一致，明文数据可迁移。

---

# ARCH v2 P1（2026-10-29）：本地 Agent 工作站 — 工具框架 / 安全审计 / 工作区
技术栈：**纯 Java（手工 aapt→javac→d8→apksigner，无 Gradle/AndroidX/Kotlin）**。UI 仍为 WebView。
本批 = 模块一（函数调用框架）+ 模块七（安全与审计）+ 模块四（工作区与文件管理）+ 手机号登录（本地 OTP MVP）。
后续批次：P2 模块二/六（MCP Client + Termux 构建服务）、P3 模块三/五（插件市场 + 记忆）、P4 模块八（UI 深化）。

## 写入归属
- `native`：`app/src/main/java/com/deepseekhouse/app/agent/**`（新包）+ `JsBridge.java` / `MainActivity.java` / `Prefs.java` / `AndroidManifest.xml` / `res/values/**`
- `ui`：`app/assets/web/index.html`、`css/**`、`js/ui.js`
- `logic`：`app/assets/web/js/app.js`、`store.js`、`bridge.js`
- `scripts/**`、构建、发布、真机验证：Lead

## N1. 原生工具框架（包 com.deepseekhouse.app.agent）
- `ToolDef`：name / description / parametersJson(JSON Schema) / risk(LOW|MID|HIGH) / needConfirm
- `ToolRegistry`（单例）：register / unregister / schemasJson()（OpenAI tools 数组）/ find(name)
- 内置工具（全部经过 PathPolicy + AuditDb）：
  - `read_file {path}` LOW：读取工作区内文本（≤256KB，UTF-8，超限截断+提示）
  - `list_dir {path?}` LOW：列目录 [{name,path,isDir,size}]（默认工作区根）
  - `write_file {path, content}` MID：仅工作区内写（自动建父目录，≤1MB，覆盖写）
  - `run_shell {command}` HIGH：`/system/bin/sh -c`，cwd=工作区，超时 30s，stdout+stderr 合并 ≤64KB
  - `http_get {url}` LOW：仅 https（localhost 例外），≤1MB，返回状态与前 200KB 文本
- `PathPolicy`：工作区根默认 `getExternalFilesDir("workspace")`；可通过 `setWorkspace` 改为 `/sdcard/house-workspace`（若已授予 All-Files-Access，否则返回需要授权的错误）；`isAllowed()` 必须 canonical path 前缀匹配 + 拒绝 `..` 穿越与 symlink 越界；写操作仅工作区内。
- `ShellRunner`：ProcessBuilder，读取合并输出，超时 destroy。
- `AuditDb`（SQLiteOpenHelper，filesDir/audit.db）：表 `audit(id, ts, tool, args, result, ok, confirmed)`；每次 exec（成功/失败/被拒绝）必须写一条；提供 recent(limit)。
- `AuthManager`（手机号登录 MVP）：`requestOtp(phone)` 生成 6 位码（5 分钟有效、同一手机号 60s 限频），通过通知渠道「登录验证码」显示（同时事件带 `demoCode` 便于本机验证）；`verifyOtp` 校验（错 3 次锁 5 分钟）成功后生成随机 token 存 Prefs；`authState()`、`logout()`。预留 `interface SmsProvider { boolean send(String phone, String code); }`，后续接自建后端/阿里云短信时替换实现即可。
- JsBridge 新方法（注入名仍 DSNative）：
```
String  toolSchemas()
void    execTool(String requestId, String name, String argsJson)
void    confirmTool(String requestId, boolean allow)
String  workspaceInfo()      -> {"root":..,"writable":bool,"allFilesAccess":bool}
String  listDir(String path) -> JSON array
void    readFile(String requestId, String path)
void    writeFile(String requestId, String path, String content)
void    runShell(String requestId, String command)
String  auditRecent(int limit) -> JSON array
void    setWorkspace(String path)
void    requestOtp(String phone)
void    verifyOtp(String requestId, String phone, String code)
String  authState()          -> {"loggedIn":bool,"phone":".."}
void    logout()
```
- 事件（主线程 evaluateJavascript → `window.DSHost.onEvent(json)`）：
```
{"type":"tool-confirm","requestId":..,"tool":..,"args":{..},"risk":"high"}
{"type":"tool-result","requestId":..,"tool":..,"ok":true,"result":"..","confirmed":true}
{"type":"otp-sent","phone":"..","ttlSeconds":300,"demoCode":"123456"}   // demoCode 仅本地模拟模式
{"type":"otp-verified","requestId":..,"ok":true,"message":".."}
{"type":"auth-changed","loggedIn":true,"phone":".."}
```
- 风险策略：LOW 直接执行；MID 首次执行前确认（同一工具会话内确认一次即可）；HIGH **每次**确认；用户拒绝时返回 `ok:false,result:"用户拒绝执行"` 并写审计。

## U1. UI（web 壳）
- 聊天页顶栏新增「文件」按钮 → 左侧文件树抽屉（覆盖层 82% 宽，面包屑 + 目录树 + 刷新；点击文件预览/插入路径；显示 workspace 根路径）。
- 聊天页底部新增可折叠「终端」面板（等宽输出、输入命令、执行/清空/复制；高度可展开/收起）。
- 消息流中的工具调用卡片：工具名 + 参数摘要 + 状态（等待确认/运行中/成功/失败）+ 结果折叠（默认收起，点击展开）。
- 高危工具确认弹窗：显示工具名/风险/参数 JSON，按钮「拒绝 / 允许执行」。
- 登录页新增 tab：「API Key」与「手机号登录」（手机号、验证码、发送（60s 倒计时）、登录、验证码提示位）。
- 设置页新增「工作区」行（显示当前根目录 + 更改按钮）；个人资料「更多」新增「审计日志」入口（列表：时间/工具/结果/是否确认）与「备份与恢复」（F3 已实现的导出/导入回调接线）。
- 消息长按菜单新增「从此处新建分支」（F4 已实现回调 onForkMessage）。
- 风格继续 Telegram 深色 #181818 / #517AF6 / 卡片 #1f1f1f / 次要文字 #8b8b8b。

## L1. JS 逻辑
- 工具循环升级：请求 `tools = 插件 tools + DSNative.toolSchemas()`（native 工具优先匹配）；收到 tool_calls 后：
  - native 工具 → `DSNative.execTool(requestId,name,argsJson)`；等待 `tool-confirm` 事件 → `UI` 确认弹窗 → `DSNative.confirmTool`；等待 `tool-result` → 追加 `role:"tool"` 消息（带 toolName/args/result/ok）→ 继续请求，最多 5 轮。
  - 插件工具保持现有 DSPlugins.runTool 路径。
- 认证：登录页手机号模式 → `DSNative.requestOtp` → `DSNative.verifyOtp`；启动时 `authState()`，已绑定手机号但未登录 → 显示手机号登录页；退出登录调用 `DSNative.logout()`；API Key 模式保留。
- 工作区/终端/审计：`workspaceInfo/listDir/readFile/runShell/auditRecent` 的 Promise 封装（bridge.js），app.js 负责调用与数据流转，UI 只渲染。
- 备份/恢复、fork 的 UI 回调接线（F3/F4 后端已就绪）。
- 必须保持现有 82 项测试全绿，并给新能力补测试。

## 验收
1. `node scripts/check-js.mjs` + `bash scripts/check-assets.sh` 通过；`javac` 0 error。
2. 真机（root 安装）验证：文件树能列出工作区、终端能执行 `echo hi`、AI 触发 read_file 会走确认/结果卡片、手机号登录可用本地验证码完成、审计日志有记录。
3. 无 AndroidX/Gradle/Kotlin 依赖；APK 体积增长 ≤300KB。

---

# ARCH v2 P2（2026-10-29）：MCP Client + Termux 构建服务
模块二 + 模块六。目标版本 v2.1.0。纯 Java/WebView/Python 标准库，无第三方 SDK。

## 写入归属
- `native`：`app/src/main/java/com/deepseekhouse/app/mcp/**`（新包）+ JsBridge/Prefs/Agent 工具注册
- `ui`：index.html / css/** / js/ui.js
- `logic`：app.js / store.js / bridge.js
- `mcp-server`：`termux-mcp/**`（Python MCP Server + 安装/启动脚本 + README）
- 构建/发布/真机：Lead

## N2. MCP Client（Java）
- 协议：JSON-RPC 2.0 over **streamable-http**：POST `{url}`，Header `Content-Type: application/json`、`Accept: application/json, text/event-stream`、可选 `Authorization: Bearer <token>`；响应可能是 application/json 单对象，或 `text/event-stream`（逐行 `data: {json}`，取 responses）。
- 生命周期：`initialize`（protocolVersion `2024-11-05`，capabilities {}，clientInfo {name:"DeepSeekHouse",version}）→ `notifications/initialized` → `tools/list` → `tools/call`。每服务器维护 requestId 递增、pending 表、后台线程。
- 连接管理：connect/disconnect/reconnect（指数退避 1s/2s/4s/8s/最大 30s）/heartbeat（每 25s `tools/list` 或 `ping`）。
- 工具发现：`tools/list` 结果 `{tools:[{name,description,inputSchema}]}` → 注册到 ToolRegistry：id `mcp:<serverId>:<name>`，显示名 `<name>`，risk=MID、needConfirm=true、remote=serverId；断开后注销。
- 调用转发：execTool 命中 remote 工具 → `tools/call {name, arguments}` → 解析 `result.content[]` 里的 `{type:"text",text}` 拼接，返回 tool-result；失败返回错误串。审计记录 serverId。
- 配置：`Prefs` 存 JSON `mcpServers:[{id,name,url,token,enabled}]`。
- JsBridge 新方法：`String mcpServers()`；`boolean mcpSaveServer(String json)`（无 id 自动生成）；`void mcpDeleteServer(String id)`；`void mcpConnect(String id)`；`void mcpDisconnect(String id)`；`void mcpRefreshTools(String id)`。
- 事件：`{"type":"mcp-status","id":..,"status":"connecting|connected|disconnected|error","message":".."}`；`{"type":"mcp-tools","id":..,"tools":[{name,description}]}`；调用结果复用 `tool-result`（result 为文本；meta.serverId 可选）。

## U2. UI
- 设置页新增「MCP 服务器」入口 → 管理页：列表行（名称、URL、状态圆点、工具数、连接/断开按钮、删除），底部「添加服务器」→ 弹层表单（名称/URL/Token/保存并连接）；支持编辑。
- 聊天消息中的工具卡片：当工具名为 `pack_apk`/`repack_apk`/`decompile_apk`/`run_gradle` 时，卡片内显示进度条（UI.setToolProgress(msgId, percent, line)）与日志流（最多 200 行，折叠）。
- UI API：`UI.renderMcpServers(list, statusMap)`、`UI.openMcpServerForm(server?)`、`UI.openMcpPage()`、`UI.setToolProgress(msgId, {percent,line})`；回调：`onMcpSave(server)`、`onMcpDelete(id)`、`onMcpConnect(id)`、`onMcpDisconnect(id)`、`onMcpRefresh(id)`、`onMcpTest(id)`。
- 构建进度事件：原生转发 `{"type":"mcp-progress","id":..,"tool":..,"percent":0-100,"line":".."}`（Termux server 可选发；无则仅最终结果）。

## L2. JS
- bridge.js：封装 6 个 MCP 方法 + 事件 mcp-status/mcp-tools/mcp-progress；mock 内存实现（2 个示例服务器、连接成功、工具列表、pack_apk 模拟进度）。
- app.js：MCP 配置 CRUD、连接流程、mcp-tools 刷新设置页、mcp-progress 映射到聊天中当前工具卡（按 toolName 匹配最近 running 工具消息）→ UI.setToolProgress；工具执行走 native execTool 已有路径（MCP 工具已在 ToolRegistry，无需额外逻辑）。
- 保持 107 项测试全绿。

## M2. Termux MCP Server（Python 标准库）
目录 `termux-mcp/`：
- `server.py`：零依赖（http.server + json + subprocess + threading + sse 手写）；路径 `/mcp`；JSON-RPC 2.0 方法：`initialize`、`notifications/initialized`（通知无响应）、`tools/list`、`tools/call`、`ping`；支持 `Authorization: Bearer <token>`（配置文件中 token）。
- 工具（每个返回 content:[{type:"text",text:"<json 或日志>"}]）：
  - `pack_apk {project_dir?, out_apk?}`：调用项目 `scripts/build.sh`（或本机 aapt/javac/d8），返回 JSON `{ok,apk_path,size,sha256,log}`；超时 300s。
  - `decompile_apk {apk_path, out_dir?}`：优先 `apktool d`，未安装返回提示；返回 `{ok,out_dir,log}`。
  - `repack_apk {dir, out_apk?}`：`apktool b` + 签名（apksigner），返回 `{ok,apk_path,log}`。
  - `run_gradle {project_dir, task}`：`./gradlew <task>` 或 `gradle <task>`，返回 `{ok,task,log,tail}`。
  - `list_workspace {path?}`：列出目录（便于调试）。
- 安全：默认只监听 127.0.0.1；token 必填（除 --no-token 调试）；所有路径必须在 `--allow-root` 内（默认 `/data/data/com.termux/files/home`）。
- `setup.sh`：`pkg install -y python openjdk-17 aapt d8 apksigner zipalign git`（apktool/gradle 可选提示），生成 `config.example.json`、`start.sh`（后台启动 + 日志）。
- `README.md`：在 Termux 里运行、客户端填写 `http://127.0.0.1:8787/mcp` + Token、验证 `curl` 示例、故障排查。

## 验收
1. `javac` 0 error；`npm test` 107+ 全绿；Python `python3 -m py_compile termux-mcp/server.py` 通过。
2. 真机：App 内添加 MCP 服务器 → 连接 Termux 本地 server → 看到 tools 列表 → 让 AI 调 `pack_apk`/`list_workspace` 返回结果（截图）。
3. CI 构建 Release v2.1.0。

---

# ARCH v2 P3（2026-10-29）：插件生态（模块三）+ 记忆与上下文（模块五）
目标版本 v2.2.0。纯 Java/WebView，JS 插件仍由 WebView 执行；原生只提供目录/文件/校验/存储能力。

## 写入归属
- `native`：`app/src/main/java/com/deepseekhouse/app/plugin/**` + `memory/**`（新包）+ JsBridge 接入 + Prefs
- `ui`：index.html / css/** / js/ui.js
- `logic`：app.js / store.js / bridge.js
- `plugins-js`：plugins.js / plugins_builtin.js（HousePlugin 宿主与内置插件适配）+ docs/
- Lead：构建/发布/真机/QA 调度

## N3. 原生能力
### 插件目录（com.deepseekhouse.app.plugin）
- 目录优先级：`getExternalFilesDir("house-plugins")`（默认，无需权限）；若存在 `/sdcard/house-plugins` 且可读则同时扫描（第二来源，可选）。
- `String pluginList()` → [{id,name,version,author,fileName,size,sha256,source:"app|sdcard","enabled":bool}]
- `String pluginRead(String fileName)` → 源码文本（≤512KB）
- `boolean pluginWrite(String fileName, String content)` → 写入 app 目录（仅 .js/.json，文件名白名单）
- `boolean pluginDelete(String fileName)`
- `boolean pluginSetEnabled(String fileName, boolean)`
- `String pluginHmac(String content)` → HMAC-SHA256(内置密钥, content) hex（用于市场签名校验）
- `void pluginOpenDir()` → 打开系统文件管理器到插件目录（Intent）
### 记忆（com.deepseekhouse.app.memory，SQLiteOpenHelper filesDir/memory.db）
- 表 `session_summary(chat_id TEXT PRIMARY KEY, summary TEXT, updated_at INTEGER)`
- 表 `memory_kv(scope TEXT, key TEXT, value TEXT, updated_at INTEGER, PRIMARY KEY(scope,key))`，scope ∈ `long_term` / `project`
- Bridge：`String memoryGetSummaries()`（全部摘要 JSON）、`void memorySaveSummary(String chatId, String summary)`、`void memoryDeleteSummary(String chatId)`、`String memoryKvGet(String scope)`（JSON 对象）、`void memoryKvSet(String scope, String key, String value)`、`void memoryKvDelete(String scope,String key)`、`String memoryAll()`（{summaries,long_term,project}）
- 写入全部在主线程排队 + 后台线程执行；异常不崩。

## U3. UI
- 设置页新增「插件市场」入口（与旧「插件」页并存）→ `#screen-market`：索引来源输入（URL 可配置，默认空）、刷新、插件卡片列表（name/version/author/description/标签/安装/更新/卸载按钮、状态：未安装/已安装/可更新/校验失败）。
- 设置页新增「记忆」入口 → `#screen-memory`：
  - 长期偏好（列表增删，如「结论先行」「不用官方套话」）——由 UI 编辑后回调；
  - 项目记忆（tech_stack / conventions / decisions 三个多行输入）；
  - 会话摘要列表（chat 标题 + 摘要预览 + 删除）；显示「上下文压缩阈值」说明（默认 80%）。
- 插件侧边栏面板：聊天页右侧/抽屉内新增「插件面板」容器 `#plugin-slots`，渲染 HousePlugin 的 uiSlots（按钮或面板），由 plugins.js 注册、ui.js 渲染。
- UI API：`UI.renderMarket(items, statusMap)`、`UI.renderMemory({long_term,project,summaries})`、`UI.renderPluginSlots(slots)`、`UI.openPluginPanel()`；回调 `onMarketFetch(url)`、`onMarketInstall(item)`、`onMarketRemove(id)`、`onMemorySave(scope,key,value)`、`onMemoryDelete(scope,key)`、`onSummaryDelete(chatId)`、`onSlotAction(id,action,payload)`。

## L3. JS 逻辑
### HousePlugin 宿主（plugins.js）
- 兼容旧 DSPlugins.register；新增 `DSPlugins.installHousePlugin(def)` / HousePlugin 生命周期：`onLoad(host)`、`onUnload()`、`tools()`、`uiSlots()`。
- 加载器：`Bridge.pluginList()` → 对 enabled 的 app 目录插件 `Bridge.pluginRead` → 沙箱执行（new Function，注入 window/DSPlugins/console）→ manifest 校验（id/name/version/author/tools/permissions）→ 注册；单个插件异常隔离。
- uiSlots：插件注册的 slot（{id,title,icon,type:'button'|'panel',render(ctx)->HTML 或 actions}）→ app.js 收集 → UI.renderPluginSlots；点击 slot → 回调插件 action。
- 卸载/禁用时调用 onUnload 并注销其 tools/commands/slots。
### 市场
- 索引格式：`{version:1, plugins:[{id,name,version,author,description,url,sha256,hmac,tags:[]}]}`；`Bridge.httpFetch` 拉取（仅 https）；安装流程：下载 source(url) → 计算 sha256（用 JS 的 crypto.subtle 或 Bridge）→ 与索引比对 + `Bridge.pluginHmac(source)` 与条目 hmac 比对 → 写入 `pluginWrite(<id>-<version>.js)` → 刷新列表。
- 校验失败：不安装，提示「签名校验失败」。
### 记忆
- 请求构造：system prompt = 预设/prefs prompt + 长期偏好（memoryKvGet('long_term') 格式化为列表）+ 项目记忆（project）+ 当前会话摘要（memoryGetSummaries 匹配 chatId）。
- 压缩：发送前估算字符数（tokens≈chars/3.5）；若 > 上下文预算 80%（预算取 state.prefs.contextBudget 默认 24000 字符），保留最近 N 条消息，把更早消息拼接摘要（每条前 160 字，最多 20 条）→ `Bridge.memorySaveSummary(chatId, summary)` → 后续请求注入摘要并在气泡上方显示「已压缩 X 条历史」提示（role:'note'）。
- 设置页保存后刷新 memory 状态；会话删除时 `memoryDeleteSummary`。

## 验收
1. javac 0 error；122+ 测试全绿（新增 P3 用例）；`node scripts/qa/run-tests.mjs`。
2. 真机：插件市场页可打开/刷新（无索引时提示）；安装本地示例插件（通过文件或市场假数据）后工具出现在工具列表；记忆页可增删长期偏好并在请求 system prompt 中出现；超长会话触发压缩提示。
3. CI Release v2.2.0。
