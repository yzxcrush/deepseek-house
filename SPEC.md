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
