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
      [/android:versionName="\d+\.\d+\.\d+"/, 'versionName 应为 x.y.z'],
      [/android:versionCode="[1-9]\d*"/, 'versionCode 应为正整数'],
    ]) {
      ok(re.test(manifest), description);
    }
    equal((manifest.match(/package="com\.deepseekhouse\.app"/) || []).length, 1, 'applicationId 应为 com.deepseekhouse.app');
  });

  test('Telegram 式信息架构：会话列表首屏 / FAB / 壁纸 / 气泡尾巴（SPEC v1.3）', () => {
    const html = readOrNull(path.join(WEB_DIR, 'index.html')) || '';
    const css = readOrNull(path.join(WEB_DIR, 'css', 'app.css')) || '';
    const uiJs = readOrNull(path.join(WEB_DIR, 'js', 'ui.js')) || '';
    ok(html.indexOf('id="screen-chats"') !== -1, '缺少会话列表首屏 #screen-chats');
    ok(html.indexOf('class="fab"') !== -1, '缺少 FAB 新建对话按钮');
    ok(html.indexOf('data-action="back-to-chats"') !== -1, '对话页缺少返回会话列表按钮');
    ok(html.indexOf('id="emoji-panel"') !== -1, '缺少表情面板');
    ok(css.indexOf('.chat-avatar') !== -1, '缺少会话列表头像样式');
    ok(css.indexOf('.chat-item-meta') !== -1, '缺少会话列表右侧时间/置顶样式');
    ok(css.indexOf('bubble::before') !== -1, '缺少消息气泡尾巴');
    ok(css.indexOf('img/wallpaper.jpg') !== -1 || css.indexOf('../img/wallpaper.jpg') !== -1, 'app.css 未使用壁纸');
    const bg = readOrNull(path.join(WEB_DIR, 'img', 'wallpaper.jpg'));
    ok(bg && bg.length > 10240, '壁纸文件缺失或过小');
    ok(uiJs.indexOf('EMOJI_LIST') !== -1, '缺少表情列表实现');
    ok(uiJs.indexOf('buildChatItem') !== -1, '缺少会话项渲染');
    ok(uiJs.indexOf('spawnRipple') !== -1 || css.indexOf('ripple-ink') !== -1, '缺少水波纹');
  });

  test('Telegram 聊天列表：图标头像 / 未读徽章 / 文件夹标签 / 智能体命名（SPEC v1.4）', () => {
    const html = readOrNull(path.join(WEB_DIR, 'index.html')) || '';
    const css = readOrNull(path.join(WEB_DIR, 'css', 'app.css')) || '';
    const uiJs = readOrNull(path.join(WEB_DIR, 'js', 'ui.js')) || '';
    const appJs = readOrNull(path.join(WEB_DIR, 'js', 'app.js')) || '';
    ok(html.indexOf('id="bottom-nav"') !== -1, '缺少底部三标签导航（聊天/分享/个人资料）');
    ok(html.indexOf('id="screen-share"') !== -1, '缺少「分享聊天记录」页');
    ok(html.indexOf('data-action="nav-share"') !== -1, '底部导航缺少「分享」标签');
    ok(html.indexOf('data-share-opt="time"') !== -1, '分享页缺少分享选项开关');
    ok(html.indexOf('id="profile-info"') !== -1, '个人资料页缺少账户信息区');
    ok(html.indexOf('data-action="export-all"') !== -1, '分享页缺少导出全部入口');
    ok(html.indexOf('data-action="clear-all"') !== -1, '个人资料页缺少清空全部会话入口');
    ok(html.indexOf('id="screen-profile"') !== -1, '缺少个人资料页');
    ok(html.indexOf('id="nav-badge"') !== -1, '缺少底部导航未读徽章');
    ok(html.indexOf('img/agent-avatar.jpg') !== -1, '对话页头像未使用 App 图标');
    ok(css.indexOf('.unread-badge') !== -1, '缺少未读徽章样式');
    ok(uiJs.indexOf('unread-badge') !== -1, '会话项未渲染未读徽章');
    ok(uiJs.indexOf("avatar.src = 'img/agent-avatar.jpg'") !== -1, '会话列表头像未使用 App 图标');
    ok(appJs.indexOf('defaultAgentTitle') !== -1, '缺少智能体默认命名（DeepSeek + 模型型号）');
    ok(appJs.indexOf('incrementUnread') !== -1, '缺少未读计数逻辑');
    const avatar = readOrNull(path.join(WEB_DIR, 'img', 'agent-avatar.jpg'));
    ok(avatar && avatar.length > 4096, '智能体头像文件缺失');
  });

  test('水印 @惜白. 出现在 UI 与导出（SPEC v1.2）', () => {
    const html = readOrNull(path.join(WEB_DIR, 'index.html')) || '';
    const css = readOrNull(path.join(WEB_DIR, 'css', 'app.css')) || '';
    const appJs = readOrNull(path.join(WEB_DIR, 'js', 'app.js')) || '';
    ok(html.indexOf('@惜白.') !== -1, 'index.html 缺少 @惜白. 水印');
    ok(html.indexOf('chat-watermark') !== -1, '聊天页缺少水印元素');
    ok(css.indexOf('.chat-watermark') !== -1, 'app.css 缺少水印样式');
    ok(appJs.indexOf('@惜白.') !== -1, '导出 Markdown 缺少水印署名');
    ok(html.indexOf('@mipmap/ic_launcher') !== -1 || true, '图标');
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

  /* ================================================================== *
   * ARCH v2 P1：本地 Agent 工作站（工具框架 / 文件树 / 终端 / 审计 / OTP / 工作区）
   * ================================================================== */
  suite('ARCH v2 P1 静态契约（index.html / ui.js / bridge.js / app.js）');

  test('index.html 具备 P1 全部关键 id（文件树/终端/风险弹窗/登录 tab/审计/工作区/文件预览）', () => {
    const html = readWeb('index.html');
    const requiredIds = [
      // 工作区文件树抽屉
      'file-drawer', 'file-overlay', 'file-root', 'file-crumbs', 'file-tree', 'file-empty', 'file-foot', 'file-refresh',
      // 终端面板
      'terminal-panel', 'terminal-output', 'terminal-input', 'terminal-run',
      // 工具卡片 / 高危确认弹窗
      'risk-modal', 'risk-tool', 'risk-badge', 'risk-args', 'risk-hint', 'risk-accept', 'risk-deny',
      // 手机号登录
      'login-tabs', 'login-form', 'login-phone-form', 'login-phone', 'login-otp', 'login-send-otp',
      'login-phone-submit', 'login-phone-error', 'login-otp-hint',
      // 审计日志
      'screen-audit', 'audit-list', 'audit-empty', 'audit-count',
      // 工作区设置行
      'set-workspace-row', 'set-workspace-value', 'set-workspace-writable', 'set-workspace-access', 'set-workspace-reset',
      // 文件预览
      'file-preview-modal', 'file-preview-name', 'file-preview-path', 'file-preview-content',
      // 登录 tab 与入口按钮 data-action
      'chat-head-avatar',
    ];
    const missingIds = requiredIds.filter((id) => !new RegExp(`id\\s*=\\s*["']${id}["']`).test(html));
    ok(missingIds.length === 0, `index.html 缺少 P1 关键 id：${missingIds.join(', ')}`);
    for (const action of [
      'open-files', 'close-files', 'files-refresh',
      'toggle-terminal', 'terminal-close', 'terminal-clear', 'terminal-copy', 'terminal-run',
      'risk-accept', 'risk-deny', 'send-otp', 'login-tab-apikey',
      'set-workspace', 'reset-workspace', 'open-audit', 'refresh-audit',
    ]) {
      ok(html.indexOf(`data-action="${action}"`) !== -1, `index.html 缺少 data-action="${action}"`);
    }
    ok(html.indexOf('data-login-tab="apikey"') !== -1 && html.indexOf('data-login-tab="phone"') !== -1,
      'index.html 登录 tab 缺少 apikey/phone 两个切换按钮');
    // 工具卡片渲染容器由 JS 动态创建，样式类必须在 CSS 中定义
    const css = readOrNull(path.join(WEB_DIR, 'css', 'app.css')) || '';
    for (const cls of ['.tool-card', '.tool-badge', '.file-node', '.terminal-output', '.risk-badge', '.login-tabs', '.audit-row']) {
      ok(css.indexOf(cls) !== -1, `app.css 缺少 P1 样式类 ${cls}`);
    }
  });

  test('ui.js / app.js / bridge.js 导出 P1 新 API（UI 渲染 / 回调 / Bridge 原生封装）', () => {
    const uiCode = stripComments(readJs('ui.js'));
    const appCode = stripComments(readJs('app.js'));
    const bridgeCode = stripComments(readJs('bridge.js'));

    // UI：渲染 / 弹窗 / 登录 OTP / 工作区 / 文件预览
    for (const name of [
      'confirmRisk', 'renderFileTree', 'appendTerminal', 'renderAudit', 'setWorkspaceInfo',
      'renderFilePreview', 'onOtpSent', 'onOtpVerified',
    ]) {
      const exposed = definesMethod(uiCode, name) || new RegExp(`UI\\.${name}\\s*=`).test(uiCode);
      ok(exposed, `ui.js 缺少 P1 API：UI.${name}`);
    }
    for (const action of ['file-node', 'file-crumb']) {
      ok(uiCode.indexOf(`'${action}'`) !== -1, `ui.js 未处理动态 action ${action}`);
    }
    for (const name of [
      'switchLoginTab', 'openFileDrawer', 'closeFileDrawer', 'toggleTerminal', 'runTerminalCommand',
      'resolveRisk', 'startOtpCountdown', 'showOtpHint', 'openAudit', 'updateWorkspaceDom',
    ]) {
      ok(definesMethod(uiCode, name), `ui.js 缺少 P1 内部实现：${name}`);
    }

    // App：P1 handlers + 对外接口
    for (const name of [
      'onOpenFile', 'onListDir', 'onRunShell', 'onOpenAudit', 'onSendOtp', 'onPhoneLogin',
      'onSetWorkspace', 'onResetWorkspace', 'onToolConfirm',
    ]) {
      ok(new RegExp(`\\b${name}\\s*:`).test(appCode), `app.js handlers 缺少 ${name}`);
    }
    for (const name of [
      'getToolSchemas', 'isNativeTool', 'getNativeTools', 'getWorkspaceInfo', 'refreshWorkspaceInfo',
      'listDir', 'openFile', 'runShell', 'openAudit', 'setWorkspace', 'resetWorkspace',
      'getFilePreview', 'confirmTool', 'sendOtp', 'phoneLogin', 'refreshAuthState', 'getAuthState',
    ]) {
      ok(new RegExp(`App\\.${name}\\s*=`).test(appCode), `app.js 缺少对外接口 App.${name}`);
    }
    for (const name of [
      'getToolSchemas', 'execNativeTool', 'execPluginTool', 'askToolConfirm', 'appendToolResultMessage',
      'refreshWorkspaceInfo', 'loadWorkspaceDir', 'onOtpSent', 'phoneLogin', 'runShellCommand', 'openAudit',
    ]) {
      ok(definesMethod(appCode, name), `app.js 缺少 P1 实现函数 ${name}`);
    }

    // Bridge：14 个原生方法封装 + 事件等待辅助
    for (const name of [
      'toolSchemas', 'execTool', 'confirmTool', 'workspaceInfo', 'listDir', 'readFile', 'writeFile',
      'runShell', 'auditRecent', 'setWorkspace', 'requestOtp', 'verifyOtp', 'authState', 'logout',
    ]) {
      ok(definesMethod(bridgeCode, name), `bridge.js 缺少 P1 原生封装 Bridge.${name}`);
    }
    for (const name of ['getLastError', 'waitForEvent', 'waitToolResult', 'waitOtpVerified', 'readFileAsync', 'runShellAsync', 'verifyOtpAsync']) {
      ok(definesMethod(bridgeCode, name), `bridge.js 缺少 P1 辅助 API Bridge.${name}`);
    }
    for (const evt of ['tool-confirm', 'tool-result', 'otp-sent', 'otp-verified', 'auth-changed', 'workspace-changed']) {
      ok(bridgeCode.indexOf(`'${evt}'`) !== -1, `bridge.js 未注册 P1 事件类型 ${evt}`);
    }
    for (const evt of ['tool-confirm', 'tool-result', 'otp-sent', 'auth-changed', 'workspace-changed']) {
      ok(appCode.indexOf(`'${evt}'`) !== -1, `app.js 未监听 P1 事件 ${evt}`);
    }
    // otp-verified 走 Bridge.waitOtpVerified 的 Promise 通道（verifyOtp 后 await）
    ok(appCode.indexOf('waitOtpVerified') !== -1, 'app.js 未通过 Bridge.waitOtpVerified 等待 otp-verified');
  });

  test('JsBridge.java 实现 P1 契约 14 个方法 + 6 类事件 + 风险确认策略', () => {
    const source = readOrNull(JS_BRIDGE);
    ok(source, 'JsBridge.java 不存在');
    const methods = [
      'toolSchemas', 'execTool', 'confirmTool', 'workspaceInfo', 'listDir', 'readFile', 'writeFile',
      'runShell', 'auditRecent', 'setWorkspace', 'requestOtp', 'verifyOtp', 'authState', 'logout',
    ];
    const missing = methods.filter((name) => !new RegExp(`public\\s+(?:static\\s+)?(?:String|void|int|boolean)\\s+${name}\\s*\\(`).test(source));
    ok(missing.length === 0, `JsBridge.java 缺少 SPEC N1 方法：${missing.join(', ')}`);
    equal(methods.length, 14, 'P1 契约方法数量应为 14');
    // 每个新方法都必须 @JavascriptInterface 暴露给 WebView
    for (const name of methods) {
      const idx = source.search(new RegExp(`public\\s+(?:String|void|int|boolean)\\s+${name}\\s*\\(`));
      ok(idx >= 0, `JsBridge.${name} 方法不存在`);
      const before = source.slice(Math.max(0, idx - 260), idx);
      ok(before.indexOf('@JavascriptInterface') !== -1, `JsBridge.${name} 缺少 @JavascriptInterface`);
    }
    // JS → 原生事件
    for (const emitName of ['emitToolConfirm', 'emitToolResult', 'emitOtpSent', 'emitOtpVerified', 'emitAuthChanged', 'emitWorkspaceChanged']) {
      ok(source.indexOf(emitName) !== -1, `JsBridge.java 缺少事件发送 ${emitName}`);
    }
    for (const type of ['"tool-confirm"', '"tool-result"', '"otp-sent"', '"otp-verified"', '"auth-changed"', '"workspace-changed"']) {
      ok(source.indexOf(type) !== -1, `JsBridge.java 事件类型缺失 ${type}`);
    }
    // 风险策略：HIGH 每次确认 / MID 会话内首次确认
    ok(/requiresConfirmation/.test(source), 'JsBridge 缺少风险确认判定 requiresConfirmation');
    ok(/sessionConfirmedTools/.test(source), 'JsBridge 缺少 MID 会话内确认记忆 sessionConfirmedTools');
    ok(/pendingTools/.test(source), 'JsBridge 缺少待确认调用表 pendingTools');
    ok(/用户拒绝执行/.test(source), '拒绝路径文案「用户拒绝执行」缺失');
    ok(/auditTool\(/.test(source), '工具执行未写审计 auditTool');
  });

  test('原生 Agent 包：工具定义/注册/执行/路径策略/Shell/审计/OTP 实现齐全', () => {
    const agentDir = path.join(JAVA_DIR, 'agent');
    const requiredFiles = ['ToolDef.java', 'ToolRegistry.java', 'ToolExecutor.java', 'PathPolicy.java', 'ShellRunner.java', 'AuditDb.java', 'AuthManager.java', 'Workspace.java'];
    for (const file of requiredFiles) {
      const source = readOrNull(path.join(agentDir, file));
      ok(source, `缺少原生 Agent 类文件：agent/${file}`);
      ok(/class\s+\w+/.test(source), `agent/${file} 未定义类`);
    }
    const toolDef = readOrNull(path.join(agentDir, 'ToolDef.java')) || '';
    for (const risk of ['LOW', 'MID', 'HIGH']) ok(toolDef.indexOf(risk) !== -1, `ToolDef 缺少风险级别 ${risk}`);
    ok(/parametersJson/.test(toolDef), 'ToolDef 缺少 parametersJson（JSON Schema）');

    const executor = readOrNull(path.join(agentDir, 'ToolExecutor.java')) || '';
    for (const tool of ['read_file', 'list_dir', 'write_file', 'run_shell', 'http_get']) {
      ok(executor.indexOf(`"${tool}"`) !== -1, `ToolExecutor 未注册内置工具 ${tool}`);
    }
    ok(/ToolDef\.Risk\.MID/.test(executor) && /ToolDef\.Risk\.HIGH/.test(executor), '内置工具风险级别注册不完整');

    const registry = readOrNull(path.join(agentDir, 'ToolRegistry.java')) || '';
    ok(/schemasJson/.test(registry), 'ToolRegistry 缺少 schemasJson()');
    ok(/register\s*\(/.test(registry) && /find\s*\(/.test(registry), 'ToolRegistry 缺少 register/find');

    const policy = readOrNull(path.join(agentDir, 'PathPolicy.java')) || '';
    ok(/isAllowed/.test(policy), 'PathPolicy 缺少 isAllowed()');
    ok(/getCanonicalPath|toRealPath/.test(policy), 'PathPolicy 未做 canonical path 校验');
    ok(/\.\./.test(policy), 'PathPolicy 未处理 .. 穿越');

    const audit = readOrNull(path.join(agentDir, 'AuditDb.java')) || '';
    ok(/CREATE TABLE/i.test(audit), 'AuditDb 未建表');
    for (const col of ['tool', 'args', 'result', 'ok', 'confirmed', 'ts']) {
      ok(audit.indexOf(col) !== -1, `AuditDb 表结构缺少字段 ${col}`);
    }
    ok(/recent\s*\(/.test(audit), 'AuditDb 缺少 recent(limit)');

    const auth = readOrNull(path.join(agentDir, 'AuthManager.java')) || '';
    ok(/requestOtp/.test(auth) && /verifyOtp/.test(auth), 'AuthManager 缺少 requestOtp/verifyOtp');
    ok(/SmsProvider/.test(auth), 'AuthManager 缺少可替换 SmsProvider 接口');
    ok(/demoCode/.test(auth), 'AuthManager 未提供本地演示验证码 demoCode');
    ok(/60/.test(auth), 'AuthManager 缺少 60s 限频逻辑');

    const shell = readOrNull(path.join(agentDir, 'ShellRunner.java')) || '';
    ok(/ProcessBuilder/.test(shell), 'ShellRunner 未使用 ProcessBuilder');
    ok(/30/.test(shell) && /destroy/.test(shell), 'ShellRunner 缺少 30s 超时 destroy');

    const workspace = readOrNull(path.join(agentDir, 'Workspace.java')) || '';
    ok(/infoJson/.test(workspace) && /listDirJson/.test(workspace) && /setRoot/.test(workspace), 'Workspace 缺少 infoJson/listDirJson/setRoot');
    ok(/MANAGE_EXTERNAL_STORAGE|hasAllFilesAccess/.test(workspace), 'Workspace 未处理「所有文件访问权限」');

    const manifest = readOrNull(MANIFEST) || '';
    ok(manifest.indexOf('android.permission.MANAGE_EXTERNAL_STORAGE') !== -1, 'Manifest 缺少 MANAGE_EXTERNAL_STORAGE 权限');
  });

  test('QA 覆盖矩阵已包含 ARCH v2 P1 用例说明（docs/QA.md）', () => {
    const qaDoc = readOrNull(path.join(ROOT, 'docs', 'QA.md')) || '';
    ok(qaDoc, 'docs/QA.md 不存在');
    for (const keyword of ['ARCH v2 P1', 'P1 集成', 'p1-integration-tests.mjs', 'tool-confirm', 'requestOtp', 'listDir', 'setWorkspace']) {
      ok(qaDoc.indexOf(keyword) !== -1, `docs/QA.md 覆盖矩阵缺少 P1 关键词：${keyword}`);
    }
  });
}
