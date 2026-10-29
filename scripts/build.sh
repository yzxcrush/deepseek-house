#!/usr/bin/env bash
# DeepSeek House APK builder: aapt -> javac -> d8 -> zipalign -> apksigner
# Works in Termux (on-device) and on Linux/CI runners with an Android SDK.
#
#   bash scripts/build.sh              # build dist/DeepSeekHouse-1.0.7.apk
#   ANDROID_HOME=/opt/android bash scripts/build.sh
#   DSH_STRICT_CHECKS=1 bash scripts/build.sh   # fail on asset contract violations
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/app"
BUILD="$ROOT/build"
DIST="$ROOT/dist"
KEYSTORE="${DSH_KEYSTORE:-$ROOT/keystore/dsh-release.keystore}"
KS_PASS="${DSH_KS_PASS:-deepseekhouse}"
KS_ALIAS="deepseekhouse"
APK_NAME="DeepSeekHouse-1.0.7.apk"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ---- toolchain discovery ---------------------------------------------------
find_android_jar() {
  local candidates=(
    "${ANDROID_JAR:-}"
    "${ANDROID_HOME:-}/platforms/android-34/android.jar"
    "${ANDROID_SDK_ROOT:-}/platforms/android-34/android.jar"
    "/data/data/com.termux/files/home/1/build/sdk/android-34/android.jar"
    "/usr/lib/android-sdk/platforms/android-34/android.jar"
  )
  local c
  for c in "${candidates[@]}"; do [ -n "$c" ] && [ -f "$c" ] && { echo "$c"; return 0; }; done
  return 1
}
ANDROID_JAR="$(find_android_jar || true)"
[ -n "$ANDROID_JAR" ] || die "android.jar not found; set ANDROID_JAR or ANDROID_HOME (expects platforms/android-34)"

# Android build-tools binaries (aapt/d8/zipalign/apksigner) may not be on PATH
for sd in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "/data/data/com.termux/files/usr"; do
  [ -n "$sd" ] || continue
  bt="$(ls -d "$sd"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$bt" ] && [ -x "$bt/aapt" ] && PATH="$bt:$PATH"
done
export PATH
for tool in aapt javac d8 zipalign apksigner keytool python3; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool missing: $tool"
done

[ -f "$APP/AndroidManifest.xml" ] || die "missing app/AndroidManifest.xml"
[ -f "$APP/assets/web/index.html" ] || die "missing app/assets/web/index.html"

# ---- 0. contract / syntax checks -------------------------------------------
if [ "${DSH_STRICT_CHECKS:-0}" = "1" ]; then
  step "Asset contract checks (strict)"
  bash "$ROOT/scripts/check-assets.sh" || die "asset contract check failed"
else
  step "Asset contract checks (warn only)"
  bash "$ROOT/scripts/check-assets.sh" || echo "WARNING: asset contract check reported problems (continuing)"
fi

if command -v node >/dev/null 2>&1; then
  step "Checking JS syntax"
  node "$ROOT/scripts/check-js.mjs" || die "JS syntax check failed"
else
  echo "node not found: skipping JS syntax check"
fi

# ---- 1. clean --------------------------------------------------------------
step "Preparing build dir"
rm -rf "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" \
       "$BUILD/app.unsigned.apk" "$BUILD/aligned.apk" "$BUILD/signed.apk"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$DIST"

# ---- 2. resources -> R.java + unsigned apk ---------------------------------
step "aapt: packaging resources + assets"
aapt package -f -m \
  -J "$BUILD/gen" \
  -M "$APP/AndroidManifest.xml" \
  -S "$APP/res" \
  -A "$APP/assets" \
  -I "$ANDROID_JAR" \
  -F "$BUILD/app.unsigned.apk"
echo "resources packaged: $(du -h "$BUILD/app.unsigned.apk" | cut -f1)"

# ---- 3. javac --------------------------------------------------------------
step "javac: compiling java sources"
mapfile -t JAVA_SRC < <(find "$APP/src" -name '*.java' | sort)
mapfile -t R_SRC   < <(find "$BUILD/gen" -name 'R.java' | sort)
[ "${#JAVA_SRC[@]}" -gt 0 ] || die "no java sources found"
javac -source 17 -target 17 -encoding UTF-8 -nowarn \
  -classpath "$ANDROID_JAR" \
  -d "$BUILD/classes" \
  "${JAVA_SRC[@]}" "${R_SRC[@]}"
[ -n "$(find "$BUILD/classes" -name '*.class' -print -quit)" ] || die "javac produced no classes"
echo "classes: $(find "$BUILD/classes" -name '*.class' | wc -l)"

# ---- 4. d8 -> dex ----------------------------------------------------------
step "d8: dexing"
mapfile -t CLASS_FILES < <(find "$BUILD/classes" -name '*.class' | sort)
d8 --lib "$ANDROID_JAR" --min-api 24 --output "$BUILD/dex" "${CLASS_FILES[@]}"
[ -f "$BUILD/dex/classes.dex" ] || die "classes.dex not produced"
echo "classes.dex: $(du -h "$BUILD/dex/classes.dex" | cut -f1)"

# ---- 5. inject dex ---------------------------------------------------------
step "Injecting classes.dex into apk"
python3 - "$BUILD/app.unsigned.apk" "$BUILD/dex/classes.dex" <<'PY'
import sys, zipfile, shutil
apk, dex = sys.argv[1], sys.argv[2]
shutil.copy(apk, apk + ".tmp")
with zipfile.ZipFile(apk + ".tmp", "a", zipfile.ZIP_DEFLATED) as z:
    z.write(dex, "classes.dex")
shutil.move(apk + ".tmp", apk)
print("classes.dex injected")
PY

# ---- 6. zipalign -----------------------------------------------------------
step "zipalign"
zipalign -f -p 4 "$BUILD/app.unsigned.apk" "$BUILD/aligned.apk"

# ---- 7. sign ---------------------------------------------------------------
step "Signing"
if [ ! -f "$KEYSTORE" ]; then
  echo "creating release keystore: $KEYSTORE"
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -alias "$KS_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10950 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=DeepSeek House, O=DeepSeekHouse, C=CN" >/dev/null 2>&1
fi
apksigner sign --ks "$KEYSTORE" --ks-key-alias "$KS_ALIAS" \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out "$BUILD/signed.apk" "$BUILD/aligned.apk"

# ---- 8. verify + report ----------------------------------------------------
step "Verifying"
apksigner verify --verbose "$BUILD/signed.apk" | sed -n '1,6p'
FINAL="$DIST/$APK_NAME"
cp "$BUILD/signed.apk" "$FINAL"
aapt dump badging "$FINAL" 2>/dev/null | sed -n '1,10p'

step "Assets inside apk"
unzip -l "$FINAL" | awk '{print $4}' | grep -E '^assets/' | sed 's|^|  |'

printf '\n\033[1;32mBUILD OK\033[0m  %s  (%s)\n' "$FINAL" "$(du -h "$FINAL" | cut -f1)"

# convenience copy for manual install via phone file manager (Termux only)
if [ -d /sdcard/Download ] && [ -w /sdcard/Download ]; then
  cp "$FINAL" /sdcard/Download/DeepSeekHouse.apk && echo "copied to /sdcard/Download/DeepSeekHouse.apk"
fi
