# DeepSeek House

**DeepSeek House** 是一个把 DeepSeek 变成「手机端本地 Agent 工作站」的安卓第三方客户端：**Telegram 风格界面 + AI 工具调用 + MCP 远程工具 + 插件生态 + 本地记忆 + 工作台三栏**。纯 **Java + WebView** 实现，不用 Gradle/Kotlin/AndroidX，可在 Termux 里手工构建。

一句话：**它不只会聊天——AI 可以在你手机上读写文件、执行终端命令、通过 MCP 调用 Termux 构建服务，让「AI 自己把 APK 打包出来」在手机上成为现实。**

> 非官方项目，与 DeepSeek 官方无关。API Key 仅保存在本机，直接与 `api.deepseek.com` 通信。

## 📱 简介

- **形态**：单 Activity + WebView（HTML/CSS/JS 前端）+ Java 原生桥接；深色 Telegram 风格 UI，支持壁纸、气泡分组、抽屉、表情面板
- **对话**：流式输出、推理过程折叠、Markdown/代码块、多会话、置顶/归档/搜索、智能体预设、备份恢复、对话分支、引用来源卡
- **Agent 工具**：5 个内置工具（读写文件 / 列目录 / 执行 shell / HTTP GET）+ 风险分级（low 直接执行、mid 首次确认、high 每次确认）+ SQLite 审计日志 + 工作区路径白名单
- **工作台**：文件树抽屉/宽屏固定栏、文件预览、底部终端（可拖拽）、全局构建任务面板、工具调用卡片（参数/状态/结果）
- **MCP**：内置 MCP Client（JSON-RPC 2.0 / streamable-http / 自动重连 / 心跳），可连接 Termux 里的 Python MCP Server，获得 `pack_apk`、`decompile_apk`、`repack_apk`、`run_gradle`、`run_shell`、`list_workspace` 等能力；**`pack_apk` 已实测可在手机上直接构建本 App**
- **插件生态**：HousePlugin 生命周期（onLoad/onUnload/tools/uiSlots）、插件市场（SHA-256 + HMAC 校验）、侧边栏面板、内置示例插件
- **记忆**：SQLite 存会话摘要 / 长期偏好 / 项目记忆，自动注入 systemPrompt；上下文超过预算 80% 自动摘要压缩
- **移动端集成**：图片消息（拍照/相册 + 全屏预览）、生成期前台通知 / 后台完成通知、其他 App 分享进入、应用锁 + AES-GCM 本地加密
- **可选 Root**：设置里开启后，终端与 `run_shell` 通过 `su` 执行（需 KernelSU/Magisk 授权；未授权时自动关闭，不影响其他功能）
- **液态玻璃 / 毛玻璃**：仿酷安液态玻璃（背景模糊 + 高光边缘 + 流动光泽）；Android 12 以下或 WebView 不支持背景模糊时自动降级为毛玻璃，兼顾低版本性能
- **开源与构建**：MIT；`aapt → javac → d8 → zipalign → apksigner` 手工链，Termux 可直接构建；GitHub Actions 自动出包并发布 Release


<p align="center">
  <img src="docs/icon.png" width="120" alt="DeepSeek House icon">
</p>

## ✨ 功能

- **多会话聊天**：会话列表抽屉、置顶、重命名、删除、搜索、导出 Markdown
- **流式输出**：SSE 逐 token 渲染，可随时停止；停止后保留已生成内容
- **推理模型**：`deepseek-reasoner` 的思考过程折叠展示
- **Telegram 式界面**：会话列表为首屏（头像 / 最后消息 / 时间 / 置顶分组）、右下角 FAB 新建对话、
  对话页从右侧推入；气泡尾巴与连续消息分组、时间与已读双勾、输入栏附件/表情/实心发送钮、
  表情面板、Android 水波纹、顶栏滚动阴影、220ms 抽屉动画
- **聊天壁纸**：由作者相册第一张照片重度模糊衍生的深蓝抽象壁纸（`scripts/make_wallpaper.py` 可复现）
- **Markdown**：代码块（语言标签 + 一键复制）、表格、引用、列表、链接
- **插件系统**：内置计算器 / 时间 / 网页抓取 / 提示词模板；支持安装任意 `.js` 插件，
  插件可注册**斜杠命令**与**模型工具**（function calling），模型可自动调用插件
- **登录与设置**：API Key、自定义 Base URL（兼容自建/中转 endpoint）、模型、温度、最大 token、系统提示词
- **Agent 工具调用**：函数调用循环（最多 5 轮）、工具结果卡片、危险操作确认弹窗、审计日志
- **MCP 远程工具**：MCP 服务器管理页、连接状态/工具发现、构建进度卡与日志流
- **插件市场**：https 索引、SHA-256/HMAC 校验、安装/更新/卸载、插件侧边栏面板
- **记忆与上下文**：长期偏好/项目记忆/会话摘要、80% 自动压缩、记忆管理页
- **工作台**：三栏布局（宽屏）+ 可拖拽终端 + 构建任务面板
- **图片与系统集成**：拍照/相册发图、前台服务通知、分享进入、应用锁、本地加密
- **可选 Root 模式**：终端/命令以 root 执行（KernelSU/Magisk 授权后）
- **零依赖前端**：无 CDN、无外部字体图片，离线可用

## 📦 安装

1. 从 [Releases](../../releases) 下载 `DeepSeekHouse-2.5.5.apk`
2. 手机允许「安装未知来源应用」后安装
3. 打开 App → 填入 DeepSeek API Key（[platform.deepseek.com](https://platform.deepseek.com/api_keys)）→ 开始使用

也可以自行从源码构建（见下）。签名密钥随仓库提供（`keystore/dsh-release.keystore`，密码 `deepseekhouse`），
因此所有构建产物的签名一致，可直接覆盖升级。

## 🛠 构建

本项目**不使用 Gradle**，使用 Android SDK 的原始工具链（`aapt → javac → d8 → zipalign → apksigner`），
因此可以在 **Termux（手机端）** 或任何装了 Android SDK 的机器上构建。

```bash
# Termux（需要：openjdk-17 aapt d8 apksigner zipalign python3）
ANDROID_JAR=/path/to/android.jar bash scripts/build.sh

# Linux / CI（已安装 SDK，ANDROID_HOME 指向 SDK）
ANDROID_HOME=$ANDROID_HOME bash scripts/build.sh
```

产物：`dist/DeepSeekHouse-2.5.5.apk`

### 云端构建（GitHub Actions）

推 tag 或手动触发 `Build & Release APK` workflow 即可：

```bash
git tag v2.2.0 && git push origin v2.2.0
```

CI 会自动：静态契约检查 → JS 语法/冒烟测试 → 构建 APK → `apksigner verify` → 上传 artifact →
创建 Release 并附上 APK 与 SHA256。手机上直接从 Release 下载安装即可。

## 🤖 Agent 工作站（P1，v2.2.0）

从「聊天客户端」升级为手机端本地 Agent 工作站的第一阶段，**纯 Java + 现有手工构建链，无 Gradle/AndroidX**：

- **函数调用框架**：`ToolRegistry` 注册/注销工具，自动注入 `tools` 请求；5 个内置工具（`read_file` / `list_dir` / `write_file` / `run_shell` / `http_get`），风险分级 `low/mid/high`：low 直接执行、mid 会话内首次确认、high 每次确认（风险弹窗），拒绝也写审计
- **安全与审计**：所有工具调用写入 SQLite 审计库（时间/工具/参数/结果/是否确认）；`PathPolicy` 路径白名单（工作区 canonical 前缀、拒绝 `..` 与 symlink 越界）；可选的 All-Files-Access 授权
- **工作区**：默认 `Android/data/com.deepseekhouse.app/files/workspace`，可切换到 `/sdcard/house-workspace`；聊天页「文件」抽屉 = 目录树 + 文件预览；底部「终端」面板 = 输入命令 → `/system/bin/sh` 执行 → 实时输出
- **工具调用可视化**：消息流里显示工具卡片（工具名/参数摘要/状态：等待确认/成功/失败/已拒绝/结果折叠）

## 🔓 Root 模式（v2.4.0，可选）

- 设置页新增「Root 模式（终端 / run_shell）」开关与状态行；开启前自动 `su -c id` 检测
- 开启后：App 内置终端、AI 的 `run_shell` 工具通过 `/system/bin/su -c` 执行，可读写 root 路径
- 前提：设备已 root（KernelSU/Magisk），并在 root 管理器里**允许「DeepSeek House」**（未授权时开关会提示并保持关闭）
- 也可不改 App：用 `su` 启动 `termux-mcp/server.py`，通过 MCP 的 `run_shell` 获得 root（见 termux-mcp/README.md）

## 🧩 插件生态与记忆（P3，v2.2.0）

- **HousePlugin 插件系统**：生命周期 `onLoad/onUnload/tools()/uiSlots()`，从 App 私有插件目录（复制即装）或 `/sdcard/house-plugins` 加载 JS 插件；manifest 校验（id/name/version/author/tools/permissions）；单个插件异常隔离；插件可注册工具与**侧边栏面板**（uiSlots），示例见 `docs/examples/house-plugin-file-manager.js`
- **插件市场**：https 索引 JSON（`{version,plugins:[{id,name,version,author,description,url,sha256,hmac,tags}]}`）→ 拉取/安装/更新/卸载；安装前 **SHA-256 + HMAC 双重校验**，校验失败不落盘
- **记忆系统**：SQLite 存储会话摘要 / 长期偏好 / 项目记忆；每次请求自动注入 system prompt；超过上下文预算 80% 时自动摘要旧消息并保留最近对话，消息流显示「已压缩」提示
- 已内置示例插件与文档：`docs/PLUGINS.md`

## 🖥 工作台与移动端 AI 工作站收尾（P4，v2.3.0）

- **工作台三栏**：聊天顶栏「工作台」开关，宽屏/横屏下左侧固定文件树、中间对话、底部终端（可拖拽高度并记忆）；手机竖屏保持抽屉模式
- **全局构建任务面板**：聚合 `pack_apk`/`repack_apk`/`decompile_apk`/`run_gradle` 等构建任务，进度条 + 日志，实时状态（构建中/完成/失败）
- **图片消息**：拍照/相册 → 缩略图待发送 → 气泡图片网格与全屏预览；请求自动使用 `content` 数组（`image_url`）
- **系统集成**：生成期前台服务通知、完成通知（后台时）、从其他 App 分享文本/图片直接进入新会话
- **应用锁 + 本地加密**：指纹/密码锁开关；启用后 localStorage 以 AES-GCM 加密（密钥来自 Android Keystore 包裹的随机密钥）

路线图：P2 = MCP Client（JSON-RPC 2.0 / streamable-http）+ Termux 构建服务（pack_apk 等）；P3 = 插件系统（HousePlugin / 市场 / HMAC）+ 记忆与上下文压缩；P4 = 三栏 UI 与构建进度。

## 🧩 插件

应用内「插件」页 → 安装 → 粘贴代码或选择 `.js` 文件。插件可以：

- 注册斜杠命令（如 `/calc 2+3*4`）
- 注册模型工具（function calling，模型会自己决定何时调用）
- 订阅发送/响应钩子

开发文档见 [docs/PLUGINS.md](docs/PLUGINS.md)，示例见 [docs/examples/example-plugin.js](docs/examples/example-plugin.js)。

```js
DSPlugins.register({
  id: "user.hello", name: "打招呼", version: "1.0.0",
  builtin: false, description: "示例插件",
  commands: [{ name: "hello", description: "打个招呼",
    run: async (ctx, args) => `你好，${args || "世界"}！` }],
});
```

## 🏗 项目结构

```
app/
  AndroidManifest.xml
  src/main/java/com/deepseekhouse/app/   # MainActivity / JsBridge / ApiClient / PluginStore / Prefs
  res/                                    # 图标、颜色、主题、字符串
  assets/web/                             # 全部 UI（HTML/CSS/JS，WebView 加载）
    index.html  css/  js/{app,ui,bridge,store,api,markdown,util,plugins,plugins_builtin}.js
scripts/
  build.sh          # 打包流水线
  make_icons.py     # 从照片生成各分辨率图标
  check-assets.sh   # 资产/契约静态检查
  qa/               # jsdom 冒烟测试
docs/               # 插件文档、QA 文档
```

## 🖼 界面预览

<p align="center">
  <img src="docs/preview-telegram.jpg" width="420" alt="Telegram 风格界面预览（壁纸 candidates 与气泡可读性）">
</p>

## 💧 水印 / 署名

应用内多处以 **@惜白.** 作为水印署名：聊天界面右下角、登录页、侧边栏底部、设置「关于」、导出的 Markdown 结尾。
本项目由 **@惜白.**（GitHub: [yzxcrush](https://github.com/yzxcrush)）定制并完全开源。

## 🔒 隐私与安全

- API Key 仅存储在本机 `SharedPreferences`，仅用于请求 `Authorization: Bearer` 头，不写日志、不上传
- 会话数据保存在应用私有目录（localStorage），不离开设备
- 插件为用户主动安装的本地 JS，**只安装可信来源的插件**；插件网络请求默认仅允许 `https`
- 仓库内的签名密钥仅用于本应用的个人构建（公开仓库中一并开源，便于任何人复现同签名构建）；
  它**不是秘密**，只用于保证本项目的版本可覆盖升级，请勿复用到其它应用
- 若你自行 fork 并发布，请务必重新生成自己的签名密钥（见 `scripts/build.sh`）

## 📄 License

MIT — 见 [LICENSE](LICENSE)。由 **@惜白.** 定制。
图标素材来自作者本人提供的照片，仅用于本应用图标。
