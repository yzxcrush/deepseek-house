#!/data/data/com.termux/files/usr/bin/bash
# start.sh — 启动 / 停止 DeepSeek House Termux MCP Server
#
#   ./start.sh                 后台启动（日志写入 server.log，PID 写入 server.pid）
#   ./start.sh --foreground    前台启动（Ctrl+C 停止）
#   ./start.sh stop            停止后台进程
#   ./start.sh status          查看运行状态
#
# 配置优先级：环境变量 > config.json > config.example.json
#   可用环境变量覆盖：DSH_MCP_CONFIG / DSH_MCP_TOKEN / DSH_MCP_HOST / DSH_MCP_PORT
#                     DSH_MCP_ALLOW_ROOT / DSH_MCP_PROJECT / DSH_MCP_KEYSTORE
#                     DSH_KS_PASS / DSH_KS_ALIAS / DSH_MCP_LOG
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

CONFIG="${DSH_MCP_CONFIG:-$HERE/config.json}"
if [ ! -f "$CONFIG" ]; then
  CONFIG="$HERE/config.example.json"
fi
LOG="${DSH_MCP_LOG:-$HERE/server.log}"
PIDFILE="$HERE/server.pid"

read_conf() {
  python3 - "$CONFIG" "$1" <<'PY'
import json
import sys

path, key = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8") as fh:
        cfg = json.load(fh)
except Exception:
    cfg = {}
value = cfg.get(key, "")
print("" if value is None else value)
PY
}

runtime_config() {
  HOST="${DSH_MCP_HOST:-$(read_conf host)}"; HOST="${HOST:-127.0.0.1}"
  PORT="${DSH_MCP_PORT:-$(read_conf port)}"; PORT="${PORT:-8787}"
  TOKEN="${DSH_MCP_TOKEN:-$(read_conf token)}"
  ALLOW_ROOT="${DSH_MCP_ALLOW_ROOT:-$(read_conf allow_root)}";
  ALLOW_ROOT="${ALLOW_ROOT:-/data/data/com.termux/files/home}"
  PROJECT="${DSH_MCP_PROJECT:-$(read_conf project)}"
  KEYSTORE="${DSH_MCP_KEYSTORE:-$(read_conf keystore)}"
  KS_PASS="${DSH_KS_PASS:-$(read_conf ks_pass)}"; KS_PASS="${KS_PASS:-deepseekhouse}"
  KS_ALIAS="${DSH_KS_ALIAS:-$(read_conf ks_alias)}"; KS_ALIAS="${KS_ALIAS:-deepseekhouse}"
}

server_args() {
  ARGS=(--host "$HOST" --port "$PORT" --allow-root "$ALLOW_ROOT")
  [ -n "$PROJECT" ] && ARGS+=(--project "$PROJECT")
  [ -n "$KEYSTORE" ] && ARGS+=(--keystore "$KEYSTORE")
  ARGS+=(--ks-pass "$KS_PASS" --ks-alias "$KS_ALIAS")
}

cmd="${1:-start}"

case "$cmd" in
  stop)
    if [ -f "$PIDFILE" ]; then
      PID="$(cat "$PIDFILE" 2>/dev/null || true)"
      if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null || true
        for _ in 1 2 3 4 5 6 7 8 9 10; do
          kill -0 "$PID" 2>/dev/null || break
          sleep 0.2
        done
        kill -9 "$PID" 2>/dev/null || true
        rm -f "$PIDFILE"
        echo "已停止 MCP Server（PID $PID）"
      else
        rm -f "$PIDFILE"
        echo "未在运行（PID 文件已过期，已清理）"
      fi
    else
      echo "未在运行（没有 server.pid）"
    fi
    exit 0
    ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null || echo -1)" 2>/dev/null; then
      runtime_config
      echo "运行中：PID $(cat "$PIDFILE")  http://$HOST:$PORT/mcp  日志：$LOG"
    else
      echo "未在运行"
    fi
    exit 0
    ;;
  start|--foreground|-f|foreground) ;;
  *)
    echo "用法：$0 [start|--foreground|stop|status]" >&2
    exit 2
    ;;
esac

runtime_config

if [ -z "$TOKEN" ] || printf '%s' "$TOKEN" | grep -q 'CHANGE_ME'; then
  echo "错误：config.json 中 Token 为空或仍是示例占位符。" >&2
  echo "请先运行：./setup.sh   （会生成随机 Token 的 config.json）" >&2
  exit 1
fi

server_args

# 后台模式：已有实例则拒绝重复启动
if [ "$cmd" = "start" ] && [ -f "$PIDFILE" ]; then
  old_pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    echo "MCP Server 已在运行：PID $old_pid（先执行 ./start.sh stop）" >&2
    exit 1
  fi
  rm -f "$PIDFILE"
fi

# Token 通过环境变量传给子进程，避免出现在 ps 的 argv 中
export DSH_MCP_TOKEN="$TOKEN"

if [ "$cmd" = "--foreground" ] || [ "$cmd" = "-f" ] || [ "$cmd" = "foreground" ]; then
  exec python3 "$HERE/server.py" "${ARGS[@]}"
fi

mkdir -p "$(dirname "$LOG")"
if command -v nohup >/dev/null 2>&1; then
  nohup python3 "$HERE/server.py" "${ARGS[@]}" >>"$LOG" 2>&1 &
else
  python3 "$HERE/server.py" "${ARGS[@]}" >>"$LOG" 2>&1 &
fi
NEW_PID=$!
echo "$NEW_PID" >"$PIDFILE"

sleep 0.8
if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "MCP Server 已启动"
  echo "  URL   : http://$HOST:$PORT/mcp"
  echo "  Token : ${TOKEN:0:4}…${TOKEN: -4}（完整值见 config.json）"
  echo "  PID   : $NEW_PID   日志：$LOG"
  echo "  停止  : ./start.sh stop"
else
  echo "启动失败，最近日志：" >&2
  tail -n 20 "$LOG" >&2 || true
  rm -f "$PIDFILE"
  exit 1
fi
