#!/data/data/com.termux/files/usr/bin/bash
# setup.sh — DeepSeek House Termux MCP Server 一键准备
#
#   ./setup.sh              只检查/提示依赖，不自动安装
#   ./setup.sh --install    自动执行 pkg install（等价 -y）
#
# 作用：
#   1. 检查 python3 / curl，提示推荐安装的 Termux 包；
#   2. 提示可选的 apktool / gradle；
#   3. 生成 config.example.json 与可执行 start.sh（缺失时）；
#   4. 若 config.json 不存在，用随机 Token 生成一份并 chmod 600。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

INSTALL=0
case "${1:-}" in
  --install|-y|--yes) INSTALL=1 ;;
  "") ;;
  *)
    echo "用法：$0 [--install]" >&2
    exit 2
    ;;
esac

echo "== DeepSeek House Termux MCP Server 安装检查 =="
echo "目录：$HERE"
echo

# ---- 1. 基础包 ------------------------------------------------------------- #
PKGS=(python openjdk-17 aapt d8 apksigner zipalign git)

if command -v pkg >/dev/null 2>&1; then
  echo "[1/4] 推荐安装（Termux）："
  echo "      pkg install -y ${PKGS[*]}"
  if [ "$INSTALL" = "1" ]; then
    echo "      正在执行 pkg update / pkg install …"
    pkg update -y || true
    if ! pkg install -y "${PKGS[@]}"; then
      echo "警告：pkg install 有失败项，请手动安装缺失的包。" >&2
    fi
  else
    echo "      未自动安装；需要时运行：./setup.sh --install"
  fi
else
  echo "[1/4] 未检测到 pkg（非 Termux 环境）"
  echo "      请自行安装 python3（3.9+）；可选 openjdk-17 / apktool / gradle。"
fi
echo

# ---- 2. 必需 / 可选工具检查 ------------------------------------------------- #
echo "[2/4] 工具检查："
if command -v python3 >/dev/null 2>&1; then
  PY_VER="$(python3 -c 'import sys;print(".".join(map(str,sys.version_info[:3])))' 2>/dev/null || echo '?')"
  echo "      必需 python3: 已安装（$PY_VER）"
else
  echo "      必需 python3: 未安装！请先 pkg install python" >&2
fi
if command -v curl >/dev/null 2>&1; then
  echo "      建议 curl   : 已安装"
else
  echo "      建议 curl   : 未安装（pkg install curl，用于自测）"
fi
for opt in apktool gradle; do
  if command -v "$opt" >/dev/null 2>&1; then
    echo "      可选 $opt: 已安装"
  else
    case "$opt" in
      apktool) echo "      可选 apktool: 未安装（decompile_apk / repack_apk 需要）→ pkg install apktool 或 pip install apktool" ;;
      gradle)  echo "      可选 gradle : 未安装（run_gradle 需要；项目自带 ./gradlew 时可不装）→ pkg install gradle" ;;
    esac
  fi
done
echo

# ---- 3. 生成 config.example.json / start.sh（缺失时） ----------------------- #
echo "[3/4] 生成配置模板："
if [ ! -f "$HERE/config.example.json" ]; then
  cat >"$HERE/config.example.json" <<'JSON'
{
  "host": "127.0.0.1",
  "port": 8787,
  "token": "CHANGE_ME_RUN_SETUP_SH_TO_GENERATE_RANDOM_TOKEN",
  "allow_root": "/data/data/com.termux/files/home",
  "project": "",
  "keystore": "",
  "ks_pass": "deepseekhouse",
  "ks_alias": "deepseekhouse"
}
JSON
  echo "      已生成 config.example.json"
else
  echo "      config.example.json 已存在"
fi

if [ ! -f "$HERE/start.sh" ]; then
  echo "      警告：start.sh 不存在（应随仓库提供），请检查文件是否完整。" >&2
else
  chmod +x "$HERE/start.sh" 2>/dev/null || true
  echo "      start.sh 已就绪（可执行）"
fi
chmod +x "$HERE/setup.sh" 2>/dev/null || true
echo

# ---- 4. 生成带随机 Token 的 config.json ------------------------------------ #
echo "[4/4] 生成运行配置 config.json："
if [ -f "$HERE/config.json" ]; then
  echo "      config.json 已存在，保留现有 Token（如需轮换：删除后重跑本脚本）"
  chmod 600 "$HERE/config.json" 2>/dev/null || true
else
  if ! command -v python3 >/dev/null 2>&1; then
    echo "      跳过：缺少 python3，无法生成随机 Token。" >&2
  else
    if [ ! -f "$HERE/config.example.json" ]; then
      echo "      错误：config.example.json 不存在，无法生成 config.json。" >&2
      exit 1
    fi
    TOKEN_GEN="$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
    python3 - "$HERE/config.example.json" "$HERE/config.json" "$TOKEN_GEN" <<'PY'
import json
import sys

src, dst, token = sys.argv[1], sys.argv[2], sys.argv[3]
with open(src, encoding="utf-8") as fh:
    cfg = json.load(fh)
cfg["token"] = token
with open(dst, "w", encoding="utf-8") as fh:
    json.dump(cfg, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY
    chmod 600 "$HERE/config.json" 2>/dev/null || true
    echo "      已生成 config.json（权限 600），随机 Token：$TOKEN_GEN"
    echo "      提示：Token 也可用环境变量 DSH_MCP_TOKEN 覆盖。"
  fi
fi
echo

cat <<'TIP'
== 下一步 ==
  1. 前台试运行（推荐首次）：  ./start.sh --foreground
  2. 或后台启动：              ./start.sh
  3. 查看日志：                tail -f server.log
  4. 停止：                    ./start.sh stop
  5. App 内填写：设置 → MCP 服务器 → 添加
       URL   : http://127.0.0.1:8787/mcp
       Token : config.json 里的 token
  6. curl 自测示例见 termux-mcp/README.md
TIP
