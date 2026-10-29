#!/usr/bin/env bash
# Asset/contract checks for the WebView layer (no network, no Android needed).
# Exit code 1 on any FAIL. Run standalone or from build.sh (strict mode).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/app/assets/web"
HTML="$WEB/index.html"
FAILS=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }

echo "asset contract checks: $WEB"

[ -f "$HTML" ] || { fail "index.html missing"; exit 1; }

# 1. every referenced local script/link target must exist
echo "- referenced assets"
while IFS= read -r ref; do
  [ -z "$ref" ] && continue
  case "$ref" in
    http*|//*|data:*|"#") fail "external/prohibited reference in index.html: $ref" ;;
    *) [ -f "$WEB/$ref" ] && pass "$ref" || fail "missing referenced file: $ref" ;;
  esac
done < <(grep -oE '(src|href)="[^"]+"' "$HTML" | sed -E 's/^(src|href)="//; s/"$//' | sort -u)

# 2. required modules from SPEC §2
echo "- required modules"
for f in js/util.js js/bridge.js js/store.js js/markdown.js js/api.js \
         js/plugins.js js/plugins_builtin.js js/ui.js js/app.js index.html; do
  [ -s "$WEB/$f" ] && pass "$f" || fail "required file missing/empty: $f"
done
[ -s "$WEB/css/theme.css" ] || fail "css/theme.css missing"

# 3. script order must follow SPEC §2
echo "- script order"
ORDER="util bridge store markdown api plugins plugins_builtin ui app"
last=-1; ordered=1
for m in $ORDER; do
  line=$(grep -nE "js/$m\.js" "$HTML" | head -1 | cut -d: -f1)
  if [ -z "$line" ]; then fail "script js/$m.js not referenced in index.html"; ordered=0; continue; fi
  [ "$line" -gt "$last" ] || { fail "script order wrong at js/$m.js"; ordered=0; }
  last=$line
done
[ "$ordered" -eq 1 ] && pass "script load order"

# 4. no external runtime resources in html/css (offline app)
echo "- offline-only"
if grep -nE '(src|href)="(https?:)?//' "$HTML" >/dev/null; then
  fail "index.html loads a remote resource"
else pass "no remote <script>/<link>"; fi
if grep -rnE 'url\((https?:)?//|@import\s+url?\(?(https?:)?//' "$WEB/css" >/dev/null 2>&1; then
  fail "css loads remote resource"; else pass "no remote css url()"; fi

# 5. JS contract markers
echo "- JS contract markers"
check_marker() { # file pattern label
  if grep -qE "$2" "$1" 2>/dev/null; then pass "$3"; else fail "$3 ($1)"; fi
}
check_marker "$WEB/js/ui.js" '(window|global|globalThis|self)\.UI\s*[=:]' "ui.js exports window.UI"
check_marker "$WEB/js/ui.js" 'UI\.(init|renderMessages|renderChatList|renderSettings|renderPlugins)\s*[=:]' "ui.js implements core UI API"
check_marker "$WEB/js/bridge.js" '(window|global|globalThis|self)\.Bridge\s*[=:]' "bridge.js exports window.Bridge"
check_marker "$WEB/js/bridge.js" 'DSHost\s*[=:]' "bridge.js exposes DSHost event sink"
check_marker "$WEB/js/bridge.js" 'DSNative' "bridge.js calls native DSNative"
check_marker "$WEB/js/store.js" '(window|global|globalThis|self)\.Store\s*[=:]' "store.js exports window.Store"
check_marker "$WEB/js/markdown.js" '(window|global|globalThis|self)\.Markdown\s*[=:]' "markdown.js exports window.Markdown"
check_marker "$WEB/js/api.js" '(window|global|globalThis|self)\.Api\s*[=:]' "api.js exports window.Api"
check_marker "$WEB/js/plugins.js" '(window|global|globalThis|self)\.DSPlugins\s*[=:]' "plugins.js exports window.DSPlugins"
check_marker "$WEB/js/plugins_builtin.js" 'DSPlugins\.register' "plugins_builtin.js registers builtins"
check_marker "$WEB/js/app.js" 'UI\.init' "app.js boots UI"
check_marker "$WEB/js/app.js" 'DSPlugins' "app.js integrates plugins"

# 6. SPEC §4.2 UI API coverage (method names present)
echo "- UI API coverage"
for m in init showScreen toast setHeader renderChatList renderMessages appendMessage updateMessage \
         removeMessage setStreaming setComposer getComposer scrollBottom setModel renderSettings \
         renderPlugins renderLogin setUser confirm; do
  grep -qE "(^|[^A-Za-z])$m\s*[:(=]" "$WEB/js/ui.js" 2>/dev/null && : || fail "UI.$m not found in ui.js"
done
pass "UI API scan done"

# 7. no debug leftovers / secrets
echo "- hygiene"
if grep -rnE 'console\.log\(' "$WEB/js" >/dev/null 2>&1; then
  echo "  NOTE console.log found (allowed for diagnostics)"
else pass "no console.log"; fi
if grep -rniE 'sk-[a-zA-Z0-9]{20,}' "$WEB" "$ROOT/app/src" >/dev/null 2>&1; then
  fail "hardcoded API key pattern found"; else pass "no hardcoded api key"; fi

echo
if [ "$FAILS" -eq 0 ]; then echo "ASSET CHECKS: OK"; exit 0; else echo "ASSET CHECKS: $FAILS problem(s)"; exit 1; fi
