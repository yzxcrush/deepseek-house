# DeepSeek House 插件开发指南

本文档对应实现：`app/assets/web/js/plugins.js`（管理器）与 `app/assets/web/js/plugins_builtin.js`（内置插件）。
契约来源：`SPEC.md` §5。接口若与本文件不一致，以 `SPEC.md` 与源码为准。

DeepSeek House 的插件是**纯 JavaScript**：一段代码在 App 的 WebView 里注册若干「斜杠命令 / 模型工具 / 生命周期钩子」，
即可扩展客户端能力。插件完全离线安装，不需要打包，也不需要任何第三方依赖。

---

## 1. 快速开始：5 分钟写一个插件

把下面代码保存为 `my-plugin.js`（或者直接在 App 的插件页粘贴）：

```js
// @id user.hello
// @name 打招呼
// @version 1.0.0
// @author 你的名字
// @description 一个最小可用的示例插件。

(function () {
  "use strict";

  function helloCommand(ctx, args) {
    var name = (typeof args === "string" && args.trim()) || "世界";
    return "你好，" + name + "！";
  }

  function helloTool(ctx, args) {
    var name = args && args.name ? String(args.name) : "世界";
    return "你好，" + name + "！这是来自 hello 工具的问候。";
  }

  window.DSPlugins.register({
    id: "user.hello",
    name: "打招呼",
    version: "1.0.0",
    author: "你的名字",
    description: "示例：/hello 或让模型调用 hello 工具。",
    commands: [
      {
        name: "hello",
        description: "向某人打招呼",
        usage: "/hello 小明",
        run: helloCommand
      }
    ],
    tools: [
      {
        name: "hello",
        description: "返回一句中文问候语。",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "要问候的名字" } },
          required: []
        },
        run: helloTool
      }
    ]
  });
})();
```

安装后：

- 在输入框发送 `/hello 小明` → 回复「你好，小明！」；
- 模型（function calling）可在需要时调用 `hello` 工具。

一个可以直接安装的完整示例见 [`docs/examples/example-plugin.js`](examples/example-plugin.js)。

---

## 2. 插件文件结构

### 2.1 元数据注释（`installFromCode` 校验用）

插件文件开头 25 行内用注释声明元数据（`//`、`/* */`、`#` 均可）：

```
// @id user.demo
// @name 随机名言
// @version 1.0.0
// @author 你的名字
// @description 一句话说明插件用途
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `@id` | 是 | 外部插件必须以 `user.` 开头，只含字母/数字/下划线/短横线，例如 `user.weather` |
| `@name` | 是 | 展示名称，最多 60 字符 |
| `@version` | 否 | 默认 `1.0.0`，建议语义化版本 |
| `@author` | 否 | 作者 |
| `@description` | 否 | 插件页显示的一句话描述 |

### 2.2 代码约定

- 整段代码通过 `new Function("window", "DSPlugins", "console", code)` 在全局作用域执行；
- 必须调用 `window.DSPlugins.register({...})`（或 `DSPlugins.register`）且**只注册一个插件**；
- 注册的 `id` 必须与 `@id` 一致；
- 一个插件文件上限 512KB；命令最多 100 个，工具最多 50 个；
- 建议用 IIFE 包裹，避免污染全局变量；**不要依赖 `this`**（插件内请显式使用 `window` / `DSPlugins`）；
- 可用语法：ES2020（Android WebView 较新）。不要使用外部依赖、CDN 或 `require`。

---

## 3. `DSPlugins.register(def)` 完整定义

```js
DSPlugins.register({
  id: "user.demo",              // 唯一 id；内置用内置名，外部必须 user.*
  name: "随机名言",              // 展示名称
  version: "1.0.0",             // 版本
  author: "你的名字",            // 可选
  description: "一句话描述",      // 可选
  builtin: false,               // 外部插件不要传；内置插件为 true
  settings: {},                 // 可选：插件设置项 schema（简化 JSON）
  commands: [ /* 见 3.1 */ ],
  tools:    [ /* 见 3.2 */ ],
  hooks:    { /* 见 3.3 */ }
});
```

`register()` 返回注册后的插件对象；如果 id 与内置插件冲突，外部插件会被忽略并输出
`console.warn("[DSPlugins] ...")` 警告。

### 3.1 命令（`commands`）

命令由用户输入 `/命令名 参数` 触发。

```js
{
  name: "hello",                  // 必填；小写字母/数字/_/-，最长 32
  aliases: ["hi"],                // 可选：别名
  description: "向某人打招呼",     // 命令列表里显示
  usage: "/hello 小明",           // 用法提示
  run: async function (ctx, args) {
    // args 为用户输入命令名之后的参数文本（字符串，可能为空）
    return "字符串结果";           // 也可是对象（会被 JSON.stringify）
  }
}
```

- 返回值必须是字符串（或可 JSON 序列化的对象）；返回值会作为一条系统消息/提示显示；
- 命令名大小写不敏感，支持 `/` 前缀与不带前缀两种写法；
- 同一插件内命令名不可重复；
- 命令执行抛错会被捕获，返回「插件命令 /xxx 执行失败：…」，不会影响其它插件。

### 3.2 工具（`tools`，暴露给模型做 function calling）

```js
{
  name: "random_quote",           // 工具名；只允许字母/数字/_/-，最长 64
  description: "工具用途（模型据此判断何时调用）",
  parameters: {                   // 标准 OpenAI function parameters（JSON Schema）
    type: "object",
    properties: {
      topic: { type: "string", description: "可选关键词" }
    },
    required: []
  },
  run: async function (ctx, args) {
    // args 是模型生成的参数对象（已 JSON.parse）
    return "字符串结果";
  }
}
```

- `toolSchemas()` 会把这些工具转换成 `{type:"function",function:{name,description,parameters}}` 数组，
  交给聊天接口的 `tools` 字段；
- 工具返回值会被转成字符串（`null/undefined → ""`，对象 → JSON，其它 → `String()`）；
- 工具执行异常会被捕获并返回中文错误串，不会中断对话。

### 3.3 生命周期钩子（`hooks`，可选）

```js
hooks: {
  // 发送前：payload = {model, messages, temperature, maxTokens, stream, systemPrompt, tools}
  // 可以直接修改 payload（例如追加 system 提示）；抛错会被捕获，不影响发送。
  onBeforeSend: async function (ctx, payload) { /* ... */ },

  // 收到一条完整回复后（流式结束后）：
  onResponse: async function (ctx, msg) { /* msg = {id, role, content, reasoning, ...} */ },

  // 用户输入任意斜杠命令时优先触发；返回非空字符串则直接作为命令结果，
  // 返回 null/undefined/false 则继续走 {commands} 匹配。
  onCommand: async function (ctx, cmd, args) { /* cmd 为小写命令名，不带 / */ }
}
```

App 侧通过 `DSPlugins.runHook(name, arg1, arg2)` 调用钩子（见 §4.3）。

---

## 4. 管理器 API（`window.DSPlugins`）

所有方法都不直接操作 DOM：插件列表变化通过 `onChange` 通知，由 `app.js` / `ui.js` 刷新界面。

### 4.1 注册表

| 方法 | 返回 | 说明 |
|---|---|---|
| `list()` | `Array<View>` | 全部插件（内置在前，按注册顺序），见下方 View |
| `get(id)` | `View \| null` | 单个插件信息 |
| `register(def)` | `def \| null` | 注册插件；id 与内置冲突时返回 `null` |
| `onChange(fn)` | `Function` | 订阅插件列表变化；返回取消订阅函数 |
| `emitChange()` | `void` | 手动触发一次变更通知 |

`View` 结构（UI 渲染用）：

```js
{
  id, name, version, author, description,
  builtin: true|false,        // 是否内置（内置不可删除，只可禁用）
  external: true|false,       // 是否外部插件
  enabled: true|false,        // 当前生效的启用状态
  error: null | "中文错误信息", // 外部插件加载失败的标记
  fileName: "user.demo.js",
  commands: ["quote"],        // 命令名列表
  tools: ["random_quote"]     // 工具名列表（插件内原始名）
}
```

### 4.2 启用 / 禁用

| 方法 | 返回 | 说明 |
|---|---|---|
| `isEnabled(id)` | `boolean` | 当前是否启用；加载失败（`error`）的插件恒为 `false` |
| `setEnabled(id, on)` | `boolean` | 启用/禁用并持久化；插件不存在返回 `false` |

持久化规则：

- **内置插件**：只存 `Store`（`state.plugins.enabled[id]`，localStorage `dsh.v1`）；
- **外部插件**：同时写 `Store` 与原生（`Bridge.pluginSetEnabled`）；
- 读取时合并两侧：任一侧显式 `false` → 禁用；任一侧显式 `true` → 启用；两侧都未记录 → 默认启用；
- 外部插件被禁用时不会执行其代码，只显示占位信息；再次启用时自动懒加载源码；
- `setEnabled` 之后会自动 `emitChange()` 通知 UI。

### 4.3 工具与命令

| 方法 | 返回 | 说明 |
|---|---|---|
| `toolSchemas()` | `Array` | 所有「已启用且有 tools」的插件的 OpenAI tools 数组 |
| `runTool(name, args, ctx?)` | `Promise<string>` | 执行工具；找不到返回中文提示串，异常返回中文错误串 |
| `runCommand(cmd, args, ctx?)` | `Promise<string\|null>` | 执行斜杠命令；无匹配返回 `null` |
| `runHook(name, arg1?, arg2?, ctx?)` | `Promise<Array>` | 依次执行各启用插件的钩子，返回结果数组（失败项为 `undefined`） |
| `createContext(extra?)` | `object` | 构造一个 ctx（需要手动运行插件时用，一般不需要） |

`ctx` 由管理器构造：即使 App 传入 `ctx.settings` / `ctx.http`，也会被替换为**插件专属**的实现
（每个插件有独立的 settings 命名空间，网络请求强制安全限制）。

### 4.4 外部插件加载

| 方法 | 返回 | 说明 |
|---|---|---|
| `loadExternal()` | `Promise<Array<View>>` | 读取原生插件列表 → 逐项读取源码 → 执行注册；单个插件失败会被隔离 |

建议 `app.js` 启动时调用一次；安装/删除插件后无需重新调用（管理器会即时维护注册表）。

### 4.5 安装与卸载

| 方法 | 返回 | 说明 |
|---|---|---|
| `installFromCode(code, meta?)` | `Promise<View>` | 校验并安装代码，成功后落盘 + 注册 + 启用 |
| `installFromFile()` | `Promise<View>` | 调起原生文件选择器（.js / .json / .txt），等 `plugin-file` 事件后安装；约 120s 超时 |
| `remove(id)` | `Promise<true>` | 删除外部插件（内置不可删）；抛中文错误说明原因 |

`installFromCode` 的校验流程：

1. 解析 `@id/@name/@version` 注释（`.json` 安装时可用 JSON 的 id/name/version 兜底）；
2. 校验 id 前缀 `user.`、name、版本号格式、id 是否与内置冲突、代码大小；
3. **先执行一次验证**（注册被捕获，不会污染正式注册表），确认恰好注册一个插件、id 与元数据一致、
   且至少提供命令/工具/钩子之一；
4. 调用 `Bridge.pluginWrite(id, code, metaJson)` 落盘；
5. 正式注册、写入启用状态并 `emitChange()`。

任一步失败都会抛中文 `Error`，且不会留下半安装状态（不会写入文件、不会污染注册表）。

---

## 5. `ctx` 能力参考

`ctx` 在命令 / 工具的 `run(ctx, args)` 与钩子中提供：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ctx.pluginId` | `string` | 当前插件 id |
| `ctx.settings.get(key, default?)` | `any` | 读取本插件设置（自动按插件隔离） |
| `ctx.settings.set(key, value)` | `boolean` | 写入本插件设置并持久化 |
| `ctx.settings.all()` | `object` | 读取本插件全部设置 |
| `ctx.toast(msg)` | `void` | 显示短提示（优先 `UI.toast`，其次原生 Toast） |
| `ctx.ui` | `window.UI \| null` | UI 层对象；插件一般不需要直接操作 |
| `ctx.http.fetch(url, opts?)` | `Promise<{status, ok, body, text}>` | 受控网络请求，见下 |
| `ctx.chat` | `object \| null` | 当前会话 `{id,title,messages,systemPrompt}`（由 App 传入） |
| `ctx.addNote(text)` | `object \| null` | 向当前会话追加一条 `role:"note"` 消息 |
| `ctx.appendMessage(msg)` | `boolean` | 追加一条完整消息（由 App 提供实现，否则降级到 `UI.appendMessage`） |
| `ctx.store` | `window.Store \| null` | 只读/谨慎使用；插件设置请优先用 `ctx.settings` |
| `ctx.plugins` | `window.DSPlugins` | 管理器自身 |

### 5.1 `ctx.http.fetch`

```js
try {
  const res = await ctx.http.fetch("https://api.example.com/data", {
    method: "GET",                       // 默认 GET
    headers: { Accept: "application/json" },
    body: null,                          // POST 时传字符串
    timeout: 20000                       // 毫秒，默认 30000，最大 120000
  });
  // res = { status: 200, ok: true, body: "响应文本", text: "同 body" }
} catch (e) {
  // e.message 为中文错误，例如：
  // "安全限制：插件网络请求只允许 https（http 仅限 localhost / 127.0.0.1）：..."
  // "网络请求超时（30 秒）：..."
}
```

**安全限制（硬性）**：只允许 `https://`；仅 `localhost` / `127.0.0.1` / `::1` 可以用 `http://`。
不满足条件会直接 reject，不会发出请求。

---

## 6. 安装插件

### 6.1 App 内安装（推荐）

1. 打开左侧抽屉 →「插件」（或设置 → 插件）；
2. 点击「安装插件」；
3. 二选一：
   - **粘贴代码**：把完整插件代码粘贴到输入框 → 安装；
   - **选择文件**：调起系统文件选择器，选 `.js`（或 `.json` / `.txt`）；若为 `.json` 需形如
     ```json
     { "id": "user.demo", "name": "随机名言", "version": "1.0.0", "code": "……插件源码……" }
     ```
4. 安装成功后插件立即出现在列表并默认启用；`/命令` 与工具随即可用。

### 6.2 文件位置与备份

- 原生把插件源码保存为 `getFilesDir()/plugins/<id>.js`，并维护 `index.json`；
- 卸载 App 会一并删除；想备份就把 `.js` 文件自己保存好；
- 同一个 id 重新安装 = 覆盖升级；卸载后再安装会重新读取文件。

### 6.3 删除与禁用

- 插件列表里的开关 → 启用/禁用（内置插件也可以禁用，但不能删除）；
- 外部插件「删除」→ 调 `Bridge.pluginDelete` 并清理启用状态；
- 加载失败的插件会显示错误信息，修好代码后重新安装即可。

---

## 7. 调试技巧

1. **看日志**：插件里的 `console.warn(...)` / `console.error(...)` 会出现在 WebView 控制台。
   管理器自身的提示统一带 `[DSPlugins]` 前缀（例如插件加载失败、工具名冲突、钩子异常）。
2. **在 WebView 控制台直接调用**（需桌面 Chrome 的 `chrome://inspect`，或 App 调试模式）：
   ```js
   DSPlugins.list();                       // 看插件与错误状态
   DSPlugins.isEnabled("user.demo");
   await DSPlugins.runCommand("/quote");
   await DSPlugins.runTool("calculator", { expression: "1+2*3" });
   DSPlugins.toolSchemas();                 // 看暴露给模型的工具
   ```
3. **常见错误与含义**：
   | 报错 | 原因 |
   |---|---|
   | `插件缺少 id：请在代码开头添加注释 // @id user.xxx` | 缺 `@id` 或 id 不以 `user.` 开头 |
   | `插件代码没有调用 window.DSPlugins.register({...})` | 代码未注册，或注册代码在异步回调里（必须同步注册） |
   | `插件注册的 id（x）与元数据 id（y）不一致` | `@id` 与 `register({id})` 不同，请统一 |
   | `一个插件文件只能注册一个插件` | 一个文件里调用了多次 `register` |
   | `插件没有提供任何命令、工具或钩子，无法安装` | 定义了空插件 |
   | `插件代码语法错误：...` | JS 语法错误（可先用 `node --check` 检查） |
   | `外部插件加载失败（user.x）：...` | 已安装但加载执行报错，`error` 字段可见 |
   | `工具名冲突且无法生成稳定别名，已跳过` | 工具名冲突太多（见 §8） |
4. **自测**：仓库内可用 Node 做快速冒烟（无需 Android）：
   ```bash
   node --check app/assets/web/js/plugins.js
   node --check app/assets/web/js/plugins_builtin.js
   ```
   并在 Node 里用 `vm` 模拟 `window` / `Bridge` / `Store` 后加载两个脚本，直接调用
   `DSPlugins.runCommand("/calc 1+2*3")` 验证命令、`DSPlugins.toolSchemas()` 验证工具。

---

## 8. 工具名冲突规则（稳定可预期）

模型看到的工具名必须全局唯一。管理器的规则：

1. 按**注册顺序**（内置插件先注册，因此内置工具优先）遍历所有已启用插件的工具；
2. 工具名只保留 `[A-Za-z0-9_-]`，长度 ≤ 64；
3. **裸名先到先得**：第一个使用该名字的工具直接占用；
4. 冲突时生成别名：`<插件前缀>_<工具名>`，插件前缀来自 id（去掉 `user.`，非法字符替换为 `_`），
   例如 `user.weather` 的 `forecast` 工具 → `weather_forecast`；
5. 别名仍冲突则追加 `_2`、`_3` …（最多尝试 30 次）；
6. 全部失败则**跳过该工具**并 `console.warn`，不影响其它工具。

补充：
- `toolSchemas()` 返回的是上表中的**暴露名**；
- `runTool(name)` 同时接受暴露名和插件内原始名；用原始名且多个插件重名时，取注册顺序中第一个；
- 因此建议给自己的工具起一个较独特的名字（如 `weather_forecast`），避免被加前缀。

---

## 9. 安全提醒（务必阅读）

- **只安装你信任来源的插件代码。** 插件与 App 同权限运行，可以读取 `window` 上的对象、
  调用 `Bridge.*`（如 Toast、剪贴板、打开链接、写插件文件等），也可以发起网络请求；
- 管理器做的是「隔离错误」而不是「沙箱」：单个插件报错不会影响其它插件，但无法阻止恶意代码；
- 网络能力通过 `ctx.http.fetch` 强制 HTTPS（本地回环地址除外）。请勿在插件里绕过该封装；
- **不要**把 API Key、Token 或其它敏感信息硬编码进插件，也不要写入 `localStorage`；
  插件的 `ctx.settings` 存在 `localStorage`（`dsh.v1` → `plugins.settings`），不适合存密钥；
- 插件应避免 `document` 级全局修改（App 的 UI 由 web-shell 管理，直接改 DOM 可能被重渲染覆盖，
  也可能破坏界面）；需要反馈请用 `ctx.toast(...)` / `ctx.addNote(...)`；
- 内置插件不可删除但可以禁用；外部插件删除后其启用状态一并清理；
- 发布插件时请附版本号与变更说明；升级同一 id 即覆盖安装。

---

## 10. 内置插件清单

| id | 名称 | 命令 | 工具 | 说明 |
|---|---|---|---|---|
| `calculator` | 计算器 | `/calc <表达式>` | `calculator` | 手写词法/语法分析，**不使用 eval / new Function**；支持 `+ - * / % ^`、括号、小数、负数、`sqrt/abs/sin/cos/tan/log/ln/exp/round/floor/ceil`、`pi/e` |
| `time` | 时间日期 | `/time [时区]` | `current_time`、`countdown` | 本地日期/星期/时间/时区；倒计时 |
| `web` | 网页抓取 | `/fetch <url>` | `fetch_url` | 仅 https（localhost 例外），返回状态码与前 4000 字文本 |
| `prompts` | 提示词模板库 | `/prompt <模板> <内容>` | `use_prompt_template` | 写作/翻译/总结/代码解释/润色/邮件/计划，纯本地 |
| `random` | 随机数与骰子 | `/roll [NdM]`、`/random [min] [max]` | `roll_dice`、`random_number` | 骰子与随机整数 |
| `units` | 单位换算 | `/convert <值> <原单位> <目标单位>` | `convert_units` | 长度/质量/温度/体积/时间/数据 |

内置插件源码见 `app/assets/web/js/plugins_builtin.js`，可作为编写插件的参考实现。

---

## 11. 示例插件

- [`docs/examples/example-plugin.js`](examples/example-plugin.js) —— 「随机名言」：
  完整的元数据注释、`/quote` 命令、`random_quote` 工具，可直接在 App 中安装，也可作为自己的模板。
- 内置插件（§10）覆盖了计算、网络、模板、随机、换算等常见模式，推荐对照阅读。

---

## 12. 约束一览（安装时会被校验）

| 项目 | 限制 |
|---|---|
| 外部插件 id | 必须 `user.` 开头，`[A-Za-z0-9_-]`，总长 ≤ 56（`user.` + 1~48） |
| 插件名称 | 1~60 字符 |
| 版本号 | `[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}`，如 `1.0.0` |
| 源码大小 | ≤ 512KB |
| 每个文件的插件数 | 恰好 1 个 |
| 命令数 / 工具数 | ≤ 100 / ≤ 50 |
| 命令名 / 工具名 | 命令 `[a-z0-9_-]{1,32}`；工具 `[A-Za-z0-9_-]{1,64}` |
| 网络 | 仅 https；`http` 仅 `localhost` / `127.0.0.1` / `::1` |
| 运行环境 | WebView（ES2020），无 DOM 构建步骤、无 npm 依赖、无 CDN |
