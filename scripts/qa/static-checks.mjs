/**
 * scripts/qa/static-checks.mjs
 * 静态契约检查（SPEC §2 / §4.2 / §4.3 / §4.1 / §5.2）。
 * 纯文本/正则扫描，不需要执行页面。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { suite, test, ok, equal, includes, notIncludes, match, isString } from './lib/harness.mjs';
import { ROOT, WEB_DIR, JS_DIR, SPEC_JS_ORDER, readWeb, hasWebFile, listJsFiles } from './lib/env.mjs';

const CSS_REQUIRED = ['theme.css', 'markdown.css', 'app.css'];

/** SPEC §4.2：window.UI 的全部方法 */
const UI_METHODS = [
  'init',
  'showScreen',
  'toast',
  'setHeader',
  'renderChatList',
  'renderMessages',
  'appendMessage',
  'updateMessage',
  'removeMessage',
  'setStreaming',
  'setComposer',
  'getComposer',
  'scrollBottom',
  'setModel',
  'renderSettings',
  'renderPlugins',
  'renderLogin',
  'setUser',
  'confirm',
];

/** SPEC §4.3：window.Bridge 的公开 API（含契约中列出的方法） */
const BRIDGE_METHODS = [
  'prefs',
  'setPrefs',
  'getPrefs',
  'startChat',
  'validateKey',
  'httpFetch',
  'plugins',
  'pluginRead',
  'pluginWrite',
  'pluginDelete',
  'pluginSetEnabled',
  'importPluginFile',
  'saveTextFile',
  'toast',
  'openUrl',
  'clipboard',
  'setBackDepth',
  'setStatusBar',
  'finishApp',
  'onEvent',
  'emit',
  'cancelRequest',
  'cancelAllRequests',
];

/** SPEC §4.1：window.Store 的公开 API */
const STORE_METHODS = [
  'load',
  'save',
  'getPrefs',
  'setPrefs',
  'createChat',
  'deleteChat',
  'renameChat',
  'touchChat',
  'getChat',
  'listChats',
  'appendMessage',
  'updateMessage',
  'exportChatMarkdown',
  'clearAll',
];

/** SPEC §5.2：window.DSPlugins 的公开 API */
const PLUGIN_METHODS = [
  'list',
  'get',
  'register',
  'setEnabled',
  'isEnabled',
  'loadExternal',
  'toolSchemas',
  'runTool',
  'runCommand',
  'installFromCode',
  'installFromFile',
  'remove',
  'onChange',
];

/** SPEC §4.3：window.Api 的公开 API */
const API_METHODS = ['send', 'cancel', 'verifyKey'];

const MODULES = [
  { file: 'util.js', global: 'Util', methods: ['$', '$$', 'el', 'escapeHtml', 'formatTime', 'debounce', 'uuid', 'sleep', 'copyText'] },
  { file: 'bridge.js', global: 'Bridge', methods: BRIDGE_METHODS, required: true },
  { file: 'store.js', global: 'Store', methods: STORE_METHODS, required: true },
  { file: 'markdown.js', global: 'Markdown', methods: ['render'], required: true },
  { file: 'api.js', global: 'Api', methods: API_METHODS, required: true },
  { file: 'plugins.js', global: 'DSPlugins', methods: PLUGIN_METHODS, required: true },
  { file: 'ui.js', global: 'UI', methods: UI_METHODS, required: true },
  { file: 'app.js', global: null, methods: [], required: true },
];

function readJs(file) {
  return fs.readFileSync(path.join(JS_DIR, file), 'utf8');
}

/** 去掉注释，避免契约名只出现在注释里造成误判。 */
export function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

/** 判断源码中是否存在名为 name 的方法/属性定义（对象字面量、赋值、函数声明、带引号键）。 */
export function definesMethod(src, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`(^|[\\s,{;])["']?${escaped}["']?\\s*:`, 'm'),
    new RegExp(`(^|[\\s,;])${escaped}\\s*=\\s*(?:async\\s+)?(?:function|\\()`, 'm'),
    new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`, 'm'),
    new RegExp(`\\b${escaped}\\s*:\\s*(?:async\\s+)?function`, 'm'),
    new RegExp(`\\.${escaped}\\s*=\\s*function`, 'm'),
    new RegExp(`\\.${escaped}\\s*=\\s*\\(`, 'm'),
    new RegExp(`\\.${escaped}\\s*=\\s*\\{`, 'm'),
  ];
  return patterns.some((re) => re.test(src));
}

/** 判断源码是否把模块挂到全局（window.X / global.X / 裸 X =）。 */
function exportsGlobal(src, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:window|global|globalThis|self)\\.${escaped}\\s*=`, 'm').test(src) ||
    new RegExp(`(^|[\\s;])${escaped}\\s*=\\s*\\{`, 'm').test(src);
}

function parseHtmlRefs(html) {
  const scripts = [];
  const links = [];
  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = scriptRe.exec(html))) scripts.push(m[1]);
  const linkRe = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((m = linkRe.exec(html))) links.push(m[1]);
  return { scripts, links };
}

function normalizeWebPath(ref) {
  // 只取本地相对路径，去掉 query/hash
  const clean = String(ref).split('#')[0].split('?')[0];
  return clean.replace(/^\.\//, '');
}

export function registerStaticTests() {
  suite('静态契约检查（SPEC §2/§4/§5）');

  test('web 资源必需文件齐全（index.html / 3 个 css / 9 个 js）', () => {
    const missing = [];
    if (!hasWebFile('index.html')) missing.push('index.html');
    for (const css of CSS_REQUIRED) if (!hasWebFile('css', css)) missing.push(`css/${css}`);
    for (const js of SPEC_JS_ORDER) if (!hasWebFile('js', js)) missing.push(`js/${js}`);
    ok(missing.length === 0, `缺少 SPEC 要求的前端资源：${missing.join(', ')}`);
  });

  test('全部 js 文件语法合法（等价 node --check）', () => {
    const files = listJsFiles();
    ok(files.length > 0, 'js 目录下没有任何 .js 文件');
    const errors = [];
    for (const file of files) {
      const source = readJs(file);
      try {
        new vm.Script(source, { filename: `js/${file}` });
      } catch (e) {
        errors.push(`js/${file}: ${e.message}`);
      }
    }
    ok(errors.length === 0, `以下 JS 存在语法错误：\n${errors.join('\n')}`);
  });

  test('index.html 的 script 顺序符合 SPEC §2（defer，app.js 最后）', () => {
    ok(hasWebFile('index.html'), 'index.html 不存在');
    const html = readWeb('index.html');
    const { scripts } = parseHtmlRefs(html);
    const jsRefs = scripts
      .map((s) => normalizeWebPath(s))
      .filter((s) => s.startsWith('js/'))
      .map((s) => s.slice('js/'.length));
    const expected = SPEC_JS_ORDER.slice();
    equal(jsRefs.join(','), expected.join(','), 'script 顺序/数量与 SPEC §2 不一致');
    // 契约要求全部 defer
    const tags = html.match(/<script\b[^>]*>/gi) || [];
    const nonDefer = tags.filter((tag) => /src=/i.test(tag) && !/\bdefer\b/i.test(tag));
    ok(nonDefer.length === 0, `以下 script 缺少 defer：${nonDefer.join(' ')}`);
  });

  test('index.html 引用的脚本/CSS 全部存在（无 404 引用）', () => {
    const html = readWeb('index.html');
    const { scripts, links } = parseHtmlRefs(html);
    const missing = [];
    for (const ref of [...scripts, ...links]) {
      if (/^(https?:)?\/\//i.test(ref) || /^data:/i.test(ref)) continue;
      const rel = normalizeWebPath(ref);
      if (!rel) continue;
      if (!fs.existsSync(path.join(WEB_DIR, rel))) missing.push(ref);
    }
    ok(missing.length === 0, `index.html 引用了不存在的文件：${missing.join(', ')}`);
  });

  test('无外部 CDN / 远程资源引用（离线可用）', () => {
    const html = readWeb('index.html');
    const offenders = [];
    const attrRe = /\b(?:src|href)\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi;
    let m;
    while ((m = attrRe.exec(html))) offenders.push(`index.html: ${m[1]}`);
    // 内联 style/script 中的远程 url()
    const cssFiles = fs.existsSync(path.join(WEB_DIR, 'css')) ? fs.readdirSync(path.join(WEB_DIR, 'css')).filter((f) => f.endsWith('.css')) : [];
    for (const css of cssFiles) {
      const source = fs.readFileSync(path.join(WEB_DIR, 'css', css), 'utf8');
      if (/@import\s+(?:url\()?["']?(?:https?:)?\/\//i.test(source)) offenders.push(`css/${css}: 远程 @import`);
      if (/url\(\s*["']?(?:https?:)?\/\//i.test(source)) offenders.push(`css/${css}: 远程 url()`);
      if (/@font-face[^}]*https?:\/\//i.test(source)) offenders.push(`css/${css}: 远程字体`);
    }
    const inlineUrl = /style\s*=\s*["'][^"']*url\(\s*["']?(?:https?:)?\/\//i.exec(html);
    if (inlineUrl) offenders.push('index.html: 内联 style 远程 url()');
    ok(offenders.length === 0, `发现外部远程资源引用：${offenders.join('; ')}`);
  });

  test('index.html 不含硬编码 http:// 远程地址（SPEC §7.5）', () => {
    const html = readWeb('index.html');
    const hits = [];
    const re = /http:\/\/(?!127\.0\.0\.1|localhost|0\.0\.0\.0)[^\s"'<>)]+/gi;
    let m;
    while ((m = re.exec(html))) hits.push(m[0]);
    ok(hits.length === 0, `index.html 含 http:// 硬编码：${hits.join(', ')}`);
  });

  test('各 JS 模块挂载到全局且公开方法齐全（正则静态扫描）', () => {
    ok(hasWebFile('js'), 'web/js 目录不存在');
    const missingGlobals = [];
    const missingMethods = [];
    for (const mod of MODULES) {
      if (!hasWebFile('js', mod.file)) {
        if (mod.required) missingGlobals.push(`js/${mod.file}（文件缺失）`);
        continue;
      }
      const raw = readJs(mod.file);
      const code = stripComments(raw);
      if (mod.global && !exportsGlobal(code, mod.global)) {
        missingGlobals.push(`${mod.file} 未挂载 window.${mod.global}`);
      }
      for (const method of mod.methods) {
        if (!definesMethod(code, method)) missingMethods.push(`${mod.file} → ${mod.global || ''}.${method}`);
      }
    }
    ok(missingGlobals.length === 0, `全局导出缺失：${missingGlobals.join('; ')}`);
    ok(missingMethods.length === 0, `缺少 SPEC 契约方法：\n  ${missingMethods.join('\n  ')}`);
  });

  test('index.html 具备 SPEC §4.2 要求的关键 DOM 容器与 id', () => {
    const html = readWeb('index.html');
    const requiredIds = [
      'screen-login',
      'screen-chat',
      'screen-settings',
      'screen-plugins',
      'messages',
      'composer-input',
      'btn-send',
      'chat-list',
      'plugins-list',
      'settings-body',
      'login-key',
      'login-form',
    ];
    const missing = requiredIds.filter((id) => !new RegExp(`id\\s*=\\s*["']${id}["']`).test(html));
    ok(missing.length === 0, `index.html 缺少关键 id：${missing.join(', ')}`);
    // 事件委托锚点
    ok(/id\s*=\s*["']app["']/.test(html), 'index.html 缺少 #app 事件委托根节点');
  });

  test('未在 index.html 中引用的 js 文件（提示性，不算失败）', () => {
    const html = readWeb('index.html');
    const { scripts } = parseHtmlRefs(html);
    const referenced = new Set(scripts.map((s) => normalizeWebPath(s).replace(/^js\//, '')).filter(Boolean));
    const orphan = listJsFiles().filter((f) => !referenced.has(f));
    if (orphan.length) {
      console.log(`      ℹ 未被 index.html 引用的 js（可能是历史残留）：${orphan.join(', ')}`);
    }
    ok(true, '');
  });

  test('插件目录 / docs 示例与 SPEC 一致（存在且可解析）', () => {
    const example = path.join(ROOT, 'docs', 'examples', 'example-plugin.js');
    if (fs.existsSync(example)) {
      try {
        new vm.Script(fs.readFileSync(example, 'utf8'), { filename: 'docs/examples/example-plugin.js' });
      } catch (e) {
        throw new Error(`docs/examples/example-plugin.js 语法错误：${e.message}`);
      }
    }
    const builtin = readJs('plugins_builtin.js');
    const count = (builtin.match(/\bbuiltin\s*:\s*true/g) || []).length;
    ok(count >= 3, `SPEC §5.3 要求至少 3 个内置插件，静态扫描 builtin:true 仅 ${count} 处`);
  });

  suite('跨端静态核对（SPEC §3 / Manifest）');

  const JAVA_DIR = path.join(ROOT, 'app', 'src', 'main', 'java', 'com', 'deepseekhouse', 'app');
  const JS_BRIDGE = path.join(JAVA_DIR, 'JsBridge.java');
  const MAIN_ACTIVITY = path.join(JAVA_DIR, 'MainActivity.java');
  const MANIFEST = path.join(ROOT, 'app', 'AndroidManifest.xml');
  const STRINGS = path.join(ROOT, 'app', 'res', 'values', 'strings.xml');

  function readOrNull(file) {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }

  test('JsBridge.java 实现 SPEC §3.1/§3.2 全部方法', () => {
    const source = readOrNull(JS_BRIDGE);
    ok(source, 'app/src/main/java/com/deepseekhouse/app/JsBridge.java 不存在');
    const names = new Set();
    const re = /public\s+(?:static\s+)?(?:String|void|int|boolean)\s+([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(source))) names.add(m[1]);
    const expected = [
      'appInfo', 'getPrefs', 'setPrefs', 'pluginsList', 'pluginRead', 'pluginWrite', 'pluginDelete',
      'pluginSetEnabled', 'getClipboard', 'setClipboard', 'toast', 'openUrl', 'setBackDepth',
      'cancelRequest', 'cancelAllRequests', 'setStatusBar', 'finishApp',
      'startChat', 'validateKey', 'httpFetch', 'importPluginFile', 'saveTextFile',
    ];
    const missing = expected.filter((n) => !names.has(n));
    ok(missing.length === 0, `JsBridge.java 缺少 SPEC 方法：${missing.join(', ')}`);
  });

  test('JsBridge 注入名 DSNative、事件入口为 DSHost.onEvent', () => {
    const bridge = readOrNull(JS_BRIDGE) || '';
    const activity = readOrNull(MAIN_ACTIVITY) || '';
    match(bridge, /JS_NAME\s*=\s*"DSNative"/, 'JsBridge 未定义注入名 DSName="DSNative"');
    ok(/addJavascriptInterface\s*\(/.test(activity), 'MainActivity 未调用 addJavascriptInterface');
    ok(/DSHost\s*&&\s*DSHost\.onEvent\s*\(/.test(bridge) || /DSHost\.onEvent/.test(bridge), 'Java→JS 事件未通过 DSHost.onEvent');
    ok(/evaluateJavascript/.test(bridge), '事件未使用 evaluateJavascript 主线程回调');
  });

  test('AndroidManifest 符合 SPEC §3（权限/SDK/Activity/输入模式）', () => {
    const manifest = readOrNull(MANIFEST);
    ok(manifest, 'AndroidManifest.xml 不存在');
    for (const [re, description] of [
      [/android\.permission\.INTERNET/, '缺少 INTERNET 权限'],
      [/android:minSdkVersion="24"/, 'minSdkVersion 应为 24'],
      [/android:targetSdkVersion="34"/, 'targetSdkVersion 应为 34'],
      [/android:usesCleartextTraffic="true"/, '缺少 usesCleartextTraffic=true'],
      [/android:windowSoftInputMode="adjustResize"/, '缺少 adjustResize'],
      [/android:exported="true"/, 'Activity 缺少 exported=true'],
      [/android\.intent\.category\.LAUNCHER/, '缺少 LAUNCHER intent-filter'],
      [/android:configChanges="[^"]*orientation[^"]*"/, 'configChanges 缺少 orientation'],
      [/android:versionName="1\.0\.0"/, 'versionName 应为 1.0.0'],
      [/android:versionCode="1"/, 'versionCode 应为 1'],
    ]) {
      ok(re.test(manifest), description);
    }
    equal((manifest.match(/package="com\.deepseekhouse\.app"/) || []).length, 1, 'applicationId 应为 com.deepseekhouse.app');
  });

  test('资源：app_name = DeepSeek House、图标资源存在', () => {
    const strings = readOrNull(STRINGS);
    ok(strings, 'res/values/strings.xml 不存在');
    match(strings, /<string\s+name="app_name"\s*>\s*DeepSeek House\s*<\/string>/, 'app_name 应为 DeepSeek House');
    const manifest = readOrNull(MANIFEST) || '';
    ok(manifest.indexOf('@mipmap/ic_launcher') !== -1, 'Manifest 未使用 @mipmap/ic_launcher');
    for (const dpi of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
      ok(fs.existsSync(path.join(ROOT, 'app', 'res', `mipmap-${dpi}`, 'ic_launcher.png')), `缺少 mipmap-${dpi}/ic_launcher.png`);
    }
  });

  test('页面 CSS 使用 SPEC §4.4 深色变量', () => {
    const theme = fs.readFileSync(path.join(WEB_DIR, 'css', 'theme.css'), 'utf8').toLowerCase();
    const vars = ['#17212b', '#0e1621', '#182533', '#2b5278', '#5288c1'];
    const missing = vars.filter((v) => theme.indexOf(v) === -1);
    ok(missing.length === 0, `theme.css 缺少 SPEC §4.4 颜色变量：${missing.join(', ')}`);
  });
}
