# Termux MCP Server（DeepSeek House）

DeepSeek House 的 **Termux 侧 MCP Server**：用手机上的 Python 3 标准库直接提供构建/反编译/重打包/目录查看能力，
App 的 MCP Client 通过 **JSON-RPC 2.0 over streamable-http** 调用。零第三方 Python 依赖。

- 协议版本：`2024-11-05`
- 端点：`POST http://127.0.0.1:8787/mcp`
- 鉴权：`Authorization: Bearer <token>`（失败返回 HTTP 401）
- 响应：默认 `application/json`；客户端 `Accept: text/event-stream` 时返回单条 SSE 事件
- 默认只监听 `127.0.0.1`

```
termux-mcp/
├── server.py            # MCP Server（Python 标准库，零依赖）
├── setup.sh             # 依赖检查 / 生成 config.example.json、config.json、start.sh
├── start.sh             # 启动/停止/状态（后台 + server.log + server.pid）
├── config.example.json  # 配置模板
└── README.md
```

---

## 1. 快速开始（Termux）

```bash
cd /data/data/com.termux/files/home/1/deepseek-house/termux-mcp

# 1) 准备依赖（只提示；加 --install 自动 pkg install）
./setup.sh
#    或：./setup.sh --install

# 2) 前台试运行（首次推荐，Ctrl+C 停止）
./start.sh --foreground

# 3) 日志出现 http://127.0.0.1:8787/mcp 后，另开一个 Termux 会话自测
curl -sS -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $(python3 -c 'import json;print(json.load(open("config.json"))["token"])')" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# 4) 正式后台运行
./start.sh
tail -f server.log
./start.sh stop
```

`setup.sh` 会：

1. 打印推荐安装命令：`pkg install -y python openjdk-17 aapt d8 apksigner zipalign git`（不自动执行，除非 `--install`）；
2. 提示可选工具 `apktool` / `gradle`；
3. 缺失时生成 `config.example.json` 与可执行 `start.sh`；
4. 用 `secrets.token_urlsafe(32)` 生成随机 Token 的 `config.json`（权限 `600`）。

也可以完全手动启动（Token 建议用环境变量，避免出现在 `ps`）：

```bash
export DSH_MCP_TOKEN="$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
python3 server.py --host 127.0.0.1 --port 8787 \
  --allow-root /data/data/com.termux/files/home \
  --project /data/data/com.termux/files/home/1/deepseek-house
```

### 命令行参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--host` | `127.0.0.1` | 监听地址（非回环地址会告警） |
| `--port` | `8787` | 监听端口 |
| `--token` | 环境变量 `DSH_MCP_TOKEN` | Bearer Token；与 `--no-token` 二选一，否则启动报错 |
| `--no-token` | 关 | **仅本机调试**：关闭 Token 校验（危险） |
| `--allow-root` | `/data/data/com.termux/files/home` | 所有工具路径必须位于此目录内 |
| `--project` | 本仓库根目录（`termux-mcp/..`） | 默认项目目录（pack_apk/run_gradle） |
| `--keystore` | `<project>/keystore/dsh-release.keystore` | repack_apk 签名用 keystore |
| `--ks-pass` | `deepseekhouse` | keystore 密码（环境变量 `DSH_KS_PASS`） |
| `--ks-alias` | `deepseekhouse` | key alias |
| `--version` | — | 打印版本 |

环境变量：`DSH_MCP_HOST` / `DSH_MCP_PORT` / `DSH_MCP_TOKEN` / `DSH_MCP_ALLOW_ROOT` /
`DSH_MCP_PROJECT` / `DSH_MCP_KEYSTORE` / `DSH_KS_PASS` / `DSH_KS_ALIAS`。

---

## 2. App 端填写

App：**设置 → MCP 服务器 → 添加服务器**（v2.1.0+ 的 MCP Client）

| 字段 | 值 |
|---|---|
| 名称 | `Termux 构建`（任意） |
| URL | `http://127.0.0.1:8787/mcp` |
| Token | `termux-mcp/config.json` 里的 `token`（`./setup.sh` 生成） |
| 启用 | 是 |

保存并连接后，`tools/list` 会返回 5 个工具，App 工具列表应显示
`pack_apk` / `decompile_apk` / `repack_apk` / `run_gradle` / `list_workspace`。
App 调用 `tools/call` 后，把 `result.content[].text`（JSON 字符串）展示在工具卡片里即可。

> 注意：手机与 App 在同一台设备上，因此用 `127.0.0.1` 即可；**不要**把 server 绑到
> `0.0.0.0` 后又没有可信网络保护，Token 会以明文 HTTP 传输。

---

## 3. curl 验证

设一个变量方便复制（Token 从 `config.json` 读取）：

```bash
cd /data/data/com.termux/files/home/1/deepseek-house/termux-mcp
TOKEN="$(python3 -c 'import json;print(json.load(open("config.json"))["token"])')"
URL="http://127.0.0.1:8787/mcp"
```

### 3.1 initialize

```bash
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'
```

预期：

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"deepseek-house-termux-mcp","version":"1.0.0"},"instructions":"DeepSeek House Termux MCP Server：…"}}
```

### 3.2 notifications/initialized（通知，无响应体，HTTP 202）

```bash
curl -i -sS -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
```

预期状态行：`HTTP/1.1 202 Accepted`，`Content-Length: 0`。

### 3.3 tools/list

```bash
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

预期 `result.tools` 包含 5 项：`pack_apk`、`decompile_apk`、`repack_apk`、`run_gradle`、`list_workspace`，
每项带 `name` / `description` / `inputSchema`。

### 3.4 tools/call（list_workspace）

```bash
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_workspace","arguments":{"path":"/data/data/com.termux/files/home/1/deepseek-house"}}}'
```

`result.content[0].text` 是一段 JSON 字符串：

```json
{"ok":true,"path":"/data/data/com.termux/files/home/1/deepseek-house","allow_root":"/data/data/com.termux/files/home","count":12,"total":12,"truncated":false,"entries":[{"name":"app","path":"…/app","is_dir":true,"is_symlink":false,"size":0,"modified":1761…}]}
```

### 3.5 ping

```bash
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"ping"}'
# {"jsonrpc":"2.0","id":4,"result":{}}
```

### 3.6 错误 Token → 401

```bash
curl -i -sS -X POST "$URL" \
  -H "Authorization: Bearer wrong-token" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":5,"method":"ping"}'
```

预期：`HTTP/1.1 401 Unauthorized`，`WWW-Authenticate: Bearer realm="DeepSeek House MCP"`，
body 为 JSON-RPC 错误 `{"code":-32001,"message":"Unauthorized：缺少或错误的 Bearer Token"}`。

### 3.7 路径越界被拒

```bash
# /etc 不在 --allow-root 内 → JSON-RPC -32602
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"list_workspace","arguments":{"path":"/etc"}}}'
# {"jsonrpc":"2.0","id":6,"error":{"code":-32602,"message":"目录超出允许范围（必须位于 --allow-root /data/data/com.termux/files/home 内）：/etc", ...}}
```

`..` 穿越与 symlink 越界同样会被 realpath 校验拦截（例如
`/data/data/com.termux/files/home/../../etc` 会被解析到 `/etc` 后拒绝）。

### 3.8 SSE 响应（可选）

客户端 `Accept: text/event-stream` 时返回单条 SSE 事件：

```bash
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":7,"method":"tools/list"}'
# event: message
# data: {"jsonrpc":"2.0","id":7,"result":{"tools":[…]}}
```

---

## 4. 工具

所有工具成功/失败都返回 `result.content=[{"type":"text","text":"<JSON>"}]`；
失败时 JSON 里 `ok:false` 且 `result.isError=true`（路径越界/参数错误则返回 JSON-RPC `-32602` 错误）。

| 工具 | 参数 | 返回 / 说明 |
|---|---|---|
| `pack_apk` | `project_dir?`、`out_apk?` | 运行 `<project>/scripts/build.sh`（**超时 300s**），返回 `{ok, apk_path, size, sha256, log, exit_code, duration_ms}`；`log` 为输出尾部 200 行；`out_apk` 指定时构建成功会复制到该路径 |
| `decompile_apk` | `apk_path`（必填）、`out_dir?` | `apktool d -f -o <out> <apk>`，返回 `{ok, out_dir, log, …}`；未安装 apktool 返回 `{ok:false,error:"未安装 apktool：请运行 pkg install apktool…"}` |
| `repack_apk` | `dir`（必填）、`out_apk?` | `apktool b` → `zipalign -p 4`（有则用）→ `apksigner sign`（默认 keystore `<project>/keystore/dsh-release.keystore`，密码/alias `deepseekhouse`），返回 `{ok, apk_path, size, sha256, log}` |
| `run_gradle` | `project_dir?`、`task`（必填） | 优先 `./gradlew <task>`（不可执行时用 `bash gradlew <task>`），否则 `gradle <task>`；任务名只允许 `[A-Za-z0-9_.:-]`，返回 `{ok, task, log, tail, …}`（`log` 尾部 200 行、`tail` 最后 20 行） |
| `list_workspace` | `path?` | 列出 `<allow-root>`（或指定目录）内容，返回 `{ok, path, allow_root, count, total, truncated, entries:[{name,path,is_dir,is_symlink,size,modified}]}`，最多 500 条 |

构建/反编译/重打包均为**同步执行**：请确保一次只触发一个构建任务（App 侧工具确认弹窗会阻止并发误触）。

`pack_apk` 需要 Termux 侧具备 `scripts/build.sh` 要求的工具链：
`ANDROID_JAR`（默认仓库 `build/sdk/android-34/android.jar`）、`aapt`、`javac`、`d8`、`zipalign`、`apksigner`、`python3`。

---

## 5. 安全说明

- **只监听 127.0.0.1**（默认）；监听非回环地址时启动日志会明确告警；
- **Token 强制校验**：`Authorization: Bearer <token>`，使用 `hmac.compare_digest` 常量时间比较，
  失败返回 HTTP 401；`--no-token` 仅限本机临时调试；`start.sh` 通过环境变量传 Token，避免出现在 `ps`；
- **路径限制**：所有工具路径先 `expanduser` + `abspath` + `realpath`，必须是 `--allow-root`
  目录本身或其后代；`..` 穿越、symlink 越界、NUL 字符都会被拒绝；输出路径同样受限；
- **无 shell 注入**：子进程用参数列表调用（`shell=False`），`run_gradle` 的 `task` 额外做白名单校验；
- **超时保护**：pack/decompile/repack 300s、gradle 600s；超时后 `SIGKILL` 整个进程组；
  `pack_apk` 的日志与结果中不会包含 Token；
- **日志脱敏**：启动时 Token 只显示 `abcd…wxyz`，请求日志只记录方法/URL/状态，不打印请求头；
- 签名 keystore 密码默认 `deepseekhouse`（与仓库 `scripts/build.sh` 一致），可用 `--ks-pass` 覆盖。

> 这是一个**本机开发辅助服务**：任何拿到 Token 的进程都能构建/反编译本机 APK 并读取
> `--allow-root` 内的目录列表（不提供文件内容读取）。请勿在有不可信应用的设备上使用弱 Token，
> 也勿把端口转发到公网。

---

## 6. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| App 连接失败 `connect failed` | server 未运行或端口不对：`./start.sh status`、`tail -n 50 server.log`；确认 URL 是 `http://127.0.0.1:8787/mcp`（带 `/mcp`） |
| HTTP 401 | Token 不一致：检查 App 里填的 Token 与 `config.json` 相同；`start.sh` 启动时若看到 “Token 为空或仍是示例占位符”，先跑 `./setup.sh`；请求头必须是 `Authorization: Bearer <token>`（Bearer 区分大小写不敏感，但格式不能少空格） |
| HTTP 404 / Method Not Allowed | 路径必须是 `/mcp` 且用 POST（GET 返回 405） |
| `Address already in use` | 端口被占用：`./start.sh stop`，或换 `--port 8788` 并同步改 App URL |
| 路径越界 `-32602` | 路径不在 `--allow-root` 内：把 `--allow-root` 改成包含项目的目录（默认 Termux home 已包含 `/home/1/deepseek-house`），注意不要用 `/sdcard` 之外的挂载点 |
| `decompile_apk`/`repack_apk` 返回 “未安装 apktool” | `pkg install apktool`（或 `pip install apktool`）；Termux 上 apktool 需要 Java：`pkg install openjdk-17` |
| `run_gradle` 返回 “未找到 ./gradlew，也未安装 gradle” | 项目没有 wrapper 时 `pkg install gradle`；或给项目生成 `gradlew` |
| `pack_apk` 失败 | 先手动 `bash scripts/build.sh` 看缺失工具；常见：`ANDROID_JAR` 路径不对、缺 `aapt/d8/apksigner`、`node` 不在 PATH；返回的 `log` 尾部 200 行会给出 build.sh 的 ERROR |
| `pack_apk` 超时 | 构建超过 300s：先手动构建确认设备性能；或在 App 侧重试，避免并发 |
| 返回的不是标准 JSON | 若请求 `Accept: text/event-stream`，响应是 `event: message` + `data: {...}`；App 的 MCP Client 两种都支持（默认 JSON） |
| 日志出现 “警告：正在监听非回环地址” | 你把 `--host` 设成了 `0.0.0.0`/局域网 IP：Token 会明文传输，请改回 `127.0.0.1` |

---

## 7. 协议细节（客户端实现参考）

请求（HTTP）：

```
POST /mcp HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json, text/event-stream

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_workspace","arguments":{"path":"."}}}
```

方法：

| method | 说明 |
|---|---|
| `initialize` | 返回 `protocolVersion:"2024-11-05"`、`capabilities:{tools:{}}`、`serverInfo` |
| `notifications/initialized` | 通知，HTTP 202 空响应（无需 `id`） |
| `tools/list` | 返回 `{tools:[{name,description,inputSchema}]}` |
| `tools/call` | `params:{name,arguments}`；结果 `result.content[]` |
| `ping` | `result:{}`（客户端心跳） |

错误码：`-32700` 解析错误、`-32600` 非法请求、`-32601` 方法不存在、
`-32602` 参数/路径非法、`-32603` 内部错误、`-32001` 未授权（HTTP 401）。
支持 JSON-RPC 批量请求；通知类消息只返回 202。

---

## 8. 与 App 的版本对应

| App | Termux MCP Server |
|---|---|
| v2.1.0（ARCH v2 P2） | 本目录（M2 模块） |

App 侧的 MCP Client（Java）会：`initialize` → `notifications/initialized` → `tools/list` →
把工具注册成 `mcp:<serverId>:<name>`（risk=MID、needConfirm=true）→ 用户确认后 `tools/call`，
拼接 `result.content[].text` 作为工具结果。断开连接后注销这些工具。
