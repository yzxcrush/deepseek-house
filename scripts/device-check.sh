#!/data/data/com.termux/files/usr/bin/bash
# 开发机辅助：root 静默安装最新 APK、启动 App、截图（仅本机使用，不参与 CI/发布）
# 用法：
#   bash scripts/device-check.sh                 # 安装 dist 下最新 apk 并截图到 inbox
#   bash scripts/device-check.sh --tap 636 2655  # 先点一下屏幕坐标再截图
#   bash scripts/device-check.sh --wait 6        # 启动后等待秒数
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="com.deepseekhouse.app"
OUT="${DEVICE_SHOT:-/data/data/com.termux/files/home/1/inbox/device-$(date +%H%M%S).png}"
WAIT=5
TAPS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --tap) TAPS+=("$2 $3"); shift 3 ;;
    --wait) WAIT="$2"; shift 2 ;;
    --apk) APK_OVERRIDE="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

APK="${APK_OVERRIDE:-$(ls -t "$ROOT"/dist/*.apk 2>/dev/null | head -1)}"
[ -f "$APK" ] || { echo "找不到 APK：$APK"; exit 1; }
command -v su >/dev/null 2>&1 || { echo "需要 root(su)"; exit 1; }
mkdir -p "$(dirname "$OUT")"

echo "== 安装 $(basename "$APK") =="
su -c "cp '$APK' /data/local/tmp/dsh.apk && chmod 644 /data/local/tmp/dsh.apk && pm install -r /data/local/tmp/dsh.apk" 2>&1 | tail -1
echo "== 启动 =="
su -c "am force-stop $PKG"
su -c "am start -n $PKG/.MainActivity" >/dev/null 2>&1
sleep "$WAIT"

for t in "${TAPS[@]}"; do
  echo "== tap $t =="
  su -c "input tap $t"
  sleep 1.2
done

su -c "screencap -p /sdcard/_dsh_shot.png"
cp /sdcard/_dsh_shot.png "$OUT"
echo "== screenshot: $OUT =="
su -c "dumpsys package $PKG" 2>/dev/null | grep -E "versionName" | head -1
