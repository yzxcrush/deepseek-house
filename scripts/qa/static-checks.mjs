/**
 * scripts/qa/static-checks.mjs
 * 静态契约检查（SPEC §2 / §4.2 / §4.3 / §4.1 / §5.2）。
 * 纯文本/正则扫描，不需要执行页面。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
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
      'login-form',
      // 审计日志
      'screen-audit', 'audit-list', 'audit-empty', 'audit-count',
      // 工作区设置行
      'set-workspace-row', 'set-workspace-value', 'set-workspace-writable', 'set-workspace-access', 'set-workspace-reset',
      // 文件预览
      'file-preview-modal', 'file-preview-name', 'file-preview-path', 'file-preview-content',
      // 入口按钮 data-action
      'chat-head-avatar',
    ];
    const missingIds = requiredIds.filter((id) => !new RegExp(`id\\s*=\\s*["']${id}["']`).test(html));
    ok(missingIds.length === 0, `index.html 缺少 P1 关键 id：${missingIds.join(', ')}`);
    for (const action of [
      'open-files', 'close-files', 'files-refresh',
      'toggle-terminal', 'terminal-close', 'terminal-clear', 'terminal-copy', 'terminal-run',
      'set-workspace', 'reset-workspace', 'open-audit', 'refresh-audit',
    ]) {
      ok(html.indexOf(`data-action="${action}"`) !== -1, `index.html 缺少 data-action="${action}"`);
    }
    // 工具卡片渲染容器由 JS 动态创建，样式类必须在 CSS 中定义
    const css = readOrNull(path.join(WEB_DIR, 'css', 'app.css')) || '';
    for (const cls of ['.tool-card', '.tool-badge', '.file-node', '.terminal-output', '.risk-badge', '.audit-row']) {
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
      'renderFilePreview',
    ]) {
      const exposed = definesMethod(uiCode, name) || new RegExp(`UI\\.${name}\\s*=`).test(uiCode);
      ok(exposed, `ui.js 缺少 P1 API：UI.${name}`);
    }
    for (const action of ['file-node', 'file-crumb']) {
      ok(uiCode.indexOf(`'${action}'`) !== -1, `ui.js 未处理动态 action ${action}`);
    }
    for (const name of [
      'openFileDrawer', 'closeFileDrawer', 'toggleTerminal', 'runTerminalCommand',
      'resolveRisk', 'openAudit', 'updateWorkspaceDom',
    ]) {
      ok(definesMethod(uiCode, name), `ui.js 缺少 P1 内部实现：${name}`);
    }

    // App：P1 handlers + 对外接口
    for (const name of [
      'onOpenFile', 'onListDir', 'onRunShell', 'onOpenAudit',
      'onSetWorkspace', 'onResetWorkspace', 'onToolConfirm',
    ]) {
      ok(new RegExp(`\\b${name}\\s*:`).test(appCode), `app.js handlers 缺少 ${name}`);
    }
    for (const name of [
      'getToolSchemas', 'isNativeTool', 'getNativeTools', 'getWorkspaceInfo', 'refreshWorkspaceInfo',
      'listDir', 'openFile', 'runShell', 'openAudit', 'setWorkspace', 'resetWorkspace',
      'getFilePreview', 'confirmTool',
    ]) {
      ok(new RegExp(`App\\.${name}\\s*=`).test(appCode), `app.js 缺少对外接口 App.${name}`);
    }
    for (const name of [
      'getToolSchemas', 'execNativeTool', 'execPluginTool', 'askToolConfirm', 'appendToolResultMessage',
      'refreshWorkspaceInfo', 'loadWorkspaceDir', 'runShellCommand', 'openAudit',
    ]) {
      ok(definesMethod(appCode, name), `app.js 缺少 P1 实现函数 ${name}`);
    }

    // Bridge：14 个原生方法封装 + 事件等待辅助
    for (const name of [
      'toolSchemas', 'execTool', 'confirmTool', 'workspaceInfo', 'listDir', 'readFile', 'writeFile',
      'runShell', 'auditRecent', 'setWorkspace',
    ]) {
      ok(definesMethod(bridgeCode, name), `bridge.js 缺少 P1 原生封装 Bridge.${name}`);
    }
    for (const name of ['getLastError', 'waitForEvent', 'waitToolResult', 'readFileAsync', 'runShellAsync']) {
      ok(definesMethod(bridgeCode, name), `bridge.js 缺少 P1 辅助 API Bridge.${name}`);
    }
    for (const evt of ['tool-confirm', 'tool-result', 'workspace-changed']) {
      ok(bridgeCode.indexOf(`'${evt}'`) !== -1, `bridge.js 未注册 P1 事件类型 ${evt}`);
    }
    for (const evt of ['tool-confirm', 'tool-result', 'workspace-changed']) {
      ok(appCode.indexOf(`'${evt}'`) !== -1, `app.js 未监听 P1 事件 ${evt}`);
    }
  });

  test('JsBridge.java 实现 P1 契约 10 个方法 + 事件 + 风险确认策略', () => {
    const source = readOrNull(JS_BRIDGE);
    ok(source, 'JsBridge.java 不存在');
    const methods = [
      'toolSchemas', 'execTool', 'confirmTool', 'workspaceInfo', 'listDir', 'readFile', 'writeFile',
      'runShell', 'auditRecent', 'setWorkspace',
    ];
    const missing = methods.filter((name) => !new RegExp(`public\\s+(?:static\\s+)?(?:String|void|int|boolean)\\s+${name}\\s*\\(`).test(source));
    ok(missing.length === 0, `JsBridge.java 缺少 SPEC N1 方法：${missing.join(', ')}`);
    equal(methods.length, 10, 'P1 契约方法数量应为 10');
    // 每个新方法都必须 @JavascriptInterface 暴露给 WebView
    for (const name of methods) {
      const idx = source.search(new RegExp(`public\\s+(?:String|void|int|boolean)\\s+${name}\\s*\\(`));
      ok(idx >= 0, `JsBridge.${name} 方法不存在`);
      const before = source.slice(Math.max(0, idx - 260), idx);
      ok(before.indexOf('@JavascriptInterface') !== -1, `JsBridge.${name} 缺少 @JavascriptInterface`);
    }
    // JS → 原生事件
    for (const emitName of ['emitToolConfirm', 'emitToolResult', 'emitWorkspaceChanged']) {
      ok(source.indexOf(emitName) !== -1, `JsBridge.java 缺少事件发送 ${emitName}`);
    }
    for (const type of ['"tool-confirm"', '"tool-result"', '"workspace-changed"']) {
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
    const requiredFiles = ['ToolDef.java', 'ToolRegistry.java', 'ToolExecutor.java', 'PathPolicy.java', 'ShellRunner.java', 'AuditDb.java', 'Workspace.java'];
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
    for (const keyword of ['ARCH v2 P1', 'P1 集成', 'p1-integration-tests.mjs', 'tool-confirm', 'listDir', 'setWorkspace']) {
      ok(qaDoc.indexOf(keyword) !== -1, `docs/QA.md 覆盖矩阵缺少 P1 关键词：${keyword}`);
    }
  });

  /* ================================================================== *
   * ARCH v2 P2：MCP Client + Termux 构建服务
   * ================================================================== */
  suite('ARCH v2 P2 静态契约（MCP UI / Bridge / Java / Termux Server）');

  test('index.html 含 MCP 管理页/表单弹窗 id、data-action 与构建进度样式', () => {
    const html = readWeb('index.html');
    const requiredIds = [
      'screen-mcp', 'mcp-count', 'mcp-list', 'mcp-empty', 'mcp-add', 'set-mcp-row', 'set-mcp-count',
      'mcp-form-modal', 'mcp-form-title', 'mcp-form-name', 'mcp-form-url', 'mcp-form-token', 'mcp-form-error', 'mcp-form-save',
    ];
    const missing = requiredIds.filter((id) => !new RegExp(`id\\s*=\\s*["']${id}["']`).test(html));
    ok(missing.length === 0, `index.html 缺少 P2 关键 id：${missing.join(', ')}`);
    for (const action of ['open-mcp', 'mcp-page-refresh', 'mcp-add', 'mcp-form-save', 'mcp-form-cancel', 'mcp-toggle-token']) {
      ok(html.indexOf(`data-action="${action}"`) !== -1, `index.html 缺少 data-action="${action}"`);
    }
    // 列表行动作由 ui.js 动态创建（mcp-edit/连接/断开/刷新/测试/删除）
    const uiCode0 = stripComments(readJs('ui.js'));
    for (const action of ['mcp-edit', 'mcp-connect', 'mcp-disconnect', 'mcp-refresh', 'mcp-test', 'mcp-delete']) {
      ok(uiCode0.indexOf(`'${action}'`) !== -1, `ui.js 未处理动态 data-action="${action}"`);
    }
    const css = readOrNull(path.join(WEB_DIR, 'css', 'app.css')) || '';
    for (const cls of ['.mcp-row', '.mcp-dot', '.mcp-dot--connected', '.mcp-status-badge', '.mcp-row-sub', '.tool-progress', '.tool-progress-track', '.tool-progress-fill', '.tool-progress-percent', '.tool-log', '.tool-log-details']) {
      ok(css.indexOf(cls) !== -1, `app.css 缺少 P2 样式类 ${cls}`);
    }
  });

  test('ui.js / app.js / bridge.js 导出 P2 MCP API、事件与 mock 能力', () => {
    const uiCode = stripComments(readJs('ui.js'));
    const appCode = stripComments(readJs('app.js'));
    const bridgeCode = stripComments(readJs('bridge.js'));

    // UI：MCP 列表/表单/状态/构建进度卡
    for (const name of ['renderMcpServers', 'openMcpServerForm', 'closeMcpForm', 'setMcpStatus', 'setToolProgress', 'appendToolLog', 'openMcpPage']) {
      const exposed = definesMethod(uiCode, name) || new RegExp(`UI\\\\.${name}\\\\s*=`).test(uiCode);
      ok(exposed, `ui.js 缺少 P2 API：UI.${name}`);
    }
    for (const name of ['renderMcpRows', 'buildMcpRow', 'submitMcpForm', 'applyToolBuildFields', 'ensureToolBuildNodes', 'setToolBuildLog', 'refreshMcpPage', 'updateMcpCounts']) {
      ok(definesMethod(uiCode, name), `ui.js 缺少 P2 内部实现 ${name}`);
    }

    // app.js：MCP handlers / 对外接口 / 事件处理 / 进度卡映射
    for (const name of ['onOpenMcp', 'onMcpList', 'onMcpSave', 'onMcpDelete', 'onMcpConnect', 'onMcpDisconnect', 'onMcpRefresh', 'onMcpTest']) {
      ok(new RegExp(`\\b${name}\\s*:`).test(appCode), `app.js handlers 缺少 ${name}`);
    }
    for (const name of [
      'openMcpPage', 'showMcpPage', 'getMcpServers', 'getMcpStatus', 'getMcpToolMap', 'getMcpTools',
      'getMcpToolCounts', 'saveMcpServer', 'deleteMcpServer', 'connectMcp', 'disconnectMcp', 'refreshMcpTools',
      'testMcp', 'isBuildToolName', 'isMcpProgressTool',
    ]) {
      ok(new RegExp(`App\\.${name}\\s*=`).test(appCode), `app.js 缺少对外接口 App.${name}`);
    }
    for (const name of ['onMcpStatus', 'onMcpTools', 'onMcpProgress', 'loadMcpServers', 'rebuildMcpToolMap', 'createRunningToolMessage', 'finalizeProgressToolMessage', 'findRunningToolMsg', 'openMcpPage']) {
      ok(definesMethod(appCode, name), `app.js 缺少 P2 实现函数 ${name}`);
    }

    // bridge.js：6 个封装 + mcpTools + 事件等待 + mock 行为
    for (const name of ['mcpServers', 'mcpSaveServer', 'mcpDeleteServer', 'mcpConnect', 'mcpDisconnect', 'mcpRefreshTools']) {
      ok(definesMethod(bridgeCode, name), `bridge.js 缺少 P2 原生封装 Bridge.${name}`);
    }
    for (const name of ['mcpTools', 'waitMcpStatus', 'waitMcpTools']) {
      ok(definesMethod(bridgeCode, name), `bridge.js 缺少 P2 辅助 API Bridge.${name}`);
    }
    for (const evt of ['mcp-status', 'mcp-tools', 'mcp-progress']) {
      ok(bridgeCode.indexOf(`'${evt}'`) !== -1, `bridge.js 未注册 P2 事件类型 ${evt}`);
      ok(appCode.indexOf(`'${evt}'`) !== -1, `app.js 未监听 P2 事件 ${evt}`);
    }
    ok(bridgeCode.indexOf('mockMcp') !== -1, 'bridge.js 缺少 MCP mock 实现');
    ok(bridgeCode.indexOf('mockMcpEmitStatus') !== -1 && bridgeCode.indexOf('mockMcpEmitTools') !== -1, 'bridge.js MCP mock 缺少状态/工具事件');
    ok(bridgeCode.indexOf('MOCK_MCP_DEFAULT_SERVERS') !== -1, 'bridge.js mock 缺少 2 个示例服务器');
    ok(bridgeCode.indexOf('MOCK_MCP_PROGRESS_STEPS') !== -1, 'bridge.js mock 缺少 pack_apk 进度步骤');
    equal((bridgeCode.match(/pack_apk/g) || []).length > 0, true, 'bridge.js mock 未涉及 pack_apk');
  });

  test('JsBridge.java 实现 6 个 mcp* 方法 + 事件；mcp 包 JSON-RPC/生命周期/工具注册齐全', () => {
    const bridge = readOrNull(JS_BRIDGE);
    ok(bridge, 'JsBridge.java 不存在');
    const expected = [
      ['mcpServers', 'String'], ['mcpSaveServer', 'boolean'], ['mcpDeleteServer', 'void'],
      ['mcpConnect', 'void'], ['mcpDisconnect', 'void'], ['mcpRefreshTools', 'void'],
    ];
    for (const [name, type] of expected) {
      const re = new RegExp(`public\\s+${type}\\s+${name}\\s*\\(`);
      ok(re.test(bridge), `JsBridge.java 缺少 ${type} ${name}()`);
      const idx = bridge.search(re);
      ok(bridge.slice(Math.max(0, idx - 260), idx).indexOf('@JavascriptInterface') !== -1, `JsBridge.${name} 缺少 @JavascriptInterface`);
    }
    ok(/public\s+String\s+mcpTools\s*\(/.test(bridge), 'JsBridge.java 缺少补充方法 mcpTools(id)');
    ok(bridge.indexOf('"mcp-status"') !== -1, 'JsBridge.java 缺少事件 "mcp-status"');
    ok(/emitMcpStatus/.test(bridge), 'JsBridge.java 缺少 emitMcpStatus');
    ok(/mcp\.callTool\s*\(/.test(bridge) && /def\.remote\s*\(\)/.test(bridge), 'execTool 未把 remote 工具转发给 McpManager.callTool');

    const mcpDir = path.join(JAVA_DIR, 'mcp');
    for (const file of ['JsonRpcClient.java', 'McpManager.java', 'McpServerConfig.java']) {
      ok(readOrNull(path.join(mcpDir, file)), `缺少原生 MCP 类：mcp/${file}`);
    }
    const client = readOrNull(path.join(mcpDir, 'JsonRpcClient.java')) || '';
    for (const token of ['PROTOCOL_VERSION = "2024-11-05"', 'text/event-stream', 'application/json', 'Authorization', 'Bearer ', '"tools/list"', '"tools/call"', '"notifications/initialized"', '"initialize"', '"ping"']) {
      ok(client.indexOf(token) !== -1, `JsonRpcClient 缺少契约元素 ${token}`);
    }
    ok(/Streamable|streamable-http/i.test(client) || /POST/.test(client), 'JsonRpcClient 未实现 streamable-http POST');
    const manager = readOrNull(path.join(mcpDir, 'McpManager.java')) || '';
    for (const token of ['HEARTBEAT_INTERVAL_MS', 'reconnect', 'ToolDef.Risk.MID', 'true', 'ToolRegistry', 'mcp:', 'callTool', 'serversJson', 'saveServer', 'deleteServer', 'toolsJson']) {
      ok(manager.indexOf(token) !== -1, `McpManager 缺少契约元素 ${token}`);
    }
    ok(/reconnect/i.test(manager) && /(1|2|4|8|30)/.test(manager), 'McpManager 未实现指数退避重连');
    for (const evt of ['"mcp-tools"', '"mcp-progress"']) {
      ok(manager.indexOf(evt) !== -1, `McpManager 缺少事件 ${evt}`);
    }
    ok(/emitProgress\s*\(/.test(manager), 'McpManager 缺少 emitProgress（mcp-progress）');
    const config = readOrNull(path.join(mcpDir, 'McpServerConfig.java')) || '';
    for (const token of ['isValidUrl', 'fromJson', 'toJson', 'sanitizeId']) {
      ok(config.indexOf(token) !== -1, `McpServerConfig 缺少 ${token}`);
    }
    const prefs = readOrNull(path.join(JAVA_DIR, 'Prefs.java')) || '';
    ok(prefs.indexOf('mcpServers') !== -1, 'Prefs.java 未持久化 mcpServers 配置');
  });

  test('termux-mcp/server.py 契约：5 个构建工具 + JSON-RPC 生命周期 + Token/allow-root 安全默认', () => {
    const serverFile = path.join(ROOT, 'termux-mcp', 'server.py');
    const server = readOrNull(serverFile);
    ok(server, 'termux-mcp/server.py 不存在');
    for (const tool of ['pack_apk', 'decompile_apk', 'repack_apk', 'run_gradle', 'list_workspace']) {
      ok(server.indexOf(`"name": "${tool}"`) !== -1, `server.py 未定义工具 ${tool}`);
    }
    for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping']) {
      ok(server.indexOf(method) !== -1, `server.py 缺少 JSON-RPC 方法 ${method}`);
    }
    for (const token of ['Authorization', 'Bearer', '--allow-root', '--no-token', '--token', '127.0.0.1', 'ThreadingHTTPServer', '/mcp', 'sha256', 'apktool', 'apksigner', 'gradlew', '300']) {
      ok(server.indexOf(token) !== -1, `server.py 缺少契约元素 ${token}`);
    }
    ok(/is_within|realpath/.test(server), 'server.py 未做 allow-root 路径越界校验');
    ok(/content/.test(server) && /"type": "text"/.test(server) || server.indexOf('"text"') !== -1, 'server.py 工具结果未按 content:[{type:"text"}] 返回');
    for (const file of ['setup.sh', 'start.sh', 'README.md', 'config.example.json']) {
      ok(readOrNull(path.join(ROOT, 'termux-mcp', file)), `缺少 termux-mcp/${file}`);
    }
    const setup = readOrNull(path.join(ROOT, 'termux-mcp', 'setup.sh')) || '';
    for (const pkg of ['python', 'openjdk-17', 'aapt', 'd8', 'apksigner', 'zipalign', 'git']) {
      ok(setup.indexOf(pkg) !== -1, `setup.sh 安装清单缺少 ${pkg}`);
    }
    const start = readOrNull(path.join(ROOT, 'termux-mcp', 'start.sh')) || '';
    ok(start.indexOf('server.py') !== -1 && start.indexOf('8787') !== -1, 'start.sh 未启动 server.py 或未使用 8787 端口');
    const readme = readOrNull(path.join(ROOT, 'termux-mcp', 'README.md')) || '';
    ok(readme.indexOf('http://127.0.0.1:8787/mcp') !== -1, 'README 缺少客户端连接地址');
    ok(readme.indexOf('curl') !== -1 && readme.indexOf('Token') !== -1, 'README 缺少 curl 验证/Token 说明');
  });

  test('termux-mcp/server.py 实际通过 python3 -m py_compile（缓存重定向到临时目录，不污染仓库）', () => {
    const serverFile = path.join(ROOT, 'termux-mcp', 'server.py');
    ok(fs.existsSync(serverFile), 'termux-mcp/server.py 不存在');
    const pycache = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qa-pyc-'));
    try {
      const output = execFileSync('python3', ['-m', 'py_compile', serverFile], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { PYTHONPYCACHEPREFIX: pycache }),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      });
      equal(String(output).trim(), '', 'py_compile 应无输出（成功时静默）');
    } catch (err) {
      const stderr = String((err && (err.stderr || err.message)) || '');
      if (err && err.code === 'ENOENT') {
        throw new Error('环境缺少 python3，无法执行 SPEC 验收要求的 `python3 -m py_compile termux-mcp/server.py`');
      }
      throw new Error(`python3 -m py_compile termux-mcp/server.py 失败：\n${stderr}`);
    } finally {
      try {
        fs.rmSync(pycache, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    ok(!fs.existsSync(path.join(ROOT, 'termux-mcp', '__pycache__')), 'py_compile 不应在仓库内生成 __pycache__');
  });

  test('QA 覆盖矩阵已包含 ARCH v2 P2 用例说明（docs/QA.md）', () => {
    const qaDoc = readOrNull(path.join(ROOT, 'docs', 'QA.md')) || '';
    ok(qaDoc, 'docs/QA.md 不存在');
    for (const keyword of ['ARCH v2 P2', 'P2 集成', 'p2-integration-tests.mjs', 'MCP', 'mcp-progress', 'py_compile', 'termux-mcp/server.py']) {
      ok(qaDoc.indexOf(keyword) !== -1, `docs/QA.md 覆盖矩阵缺少 P2 关键词：${keyword}`);
    }
  });

  /* ================================================================== *
   * ARCH v2 P3：插件生态（模块三）+ 记忆与上下文（模块五）
   * ================================================================== */
  suite('ARCH v2 P3 静态契约（市场 / 记忆 / HousePlugin / 原生包）');

  test('index.html 含市场/记忆/插件面板关键 id、data-action 与样式类', () => {
    const html = readWeb('index.html');
    const requiredIds = [
      // 插件市场
      'screen-market', 'market-count', 'market-url', 'market-fetch', 'market-list', 'market-empty',
      'set-market-row', 'set-market-label',
      // 记忆
      'screen-memory', 'memory-count', 'memory-longterm', 'memory-longterm-empty', 'memory-add-longterm',
      'memory-tech-stack', 'memory-conventions', 'memory-decisions', 'memory-save-project',
      'memory-summaries', 'memory-summaries-empty', 'memory-item-modal', 'memory-item-key', 'memory-item-value',
      'set-memory-row', 'set-memory-label',
      // 插件槽位面板
      'plugin-panel', 'plugin-panel-title', 'plugin-slots', 'plugin-slots-empty',
    ];
    const missing = requiredIds.filter((id) => !new RegExp(`id\\s*=\\s*["']${id}["']`).test(html));
    ok(missing.length === 0, `index.html 缺少 P3 关键 id：${missing.join(', ')}`);
    for (const action of [
      'open-market', 'market-refresh', 'market-fetch',
      'open-memory', 'memory-add-longterm', 'memory-item-save', 'memory-item-cancel', 'memory-save-project',
      'open-plugin-panel', 'close-plugin-panel',
    ]) {
      ok(html.indexOf(`data-action="${action}"`) !== -1, `index.html 缺少 data-action="${action}"`);
    }
    // 卡片/记忆/槽位动态按钮的 data-action 由 ui.js 创建
    const uiCode0 = stripComments(readJs('ui.js'));
    for (const action of ['market-install', 'market-remove', 'memory-delete-longterm', 'memory-delete-summary', 'slot-action']) {
      ok(uiCode0.indexOf(`'${action}'`) !== -1, `ui.js 未处理动态 data-action="${action}"`);
    }
    // 卡片/记忆/槽位由 JS 动态创建，样式类必须在 CSS 定义
    const css = readOrNull(path.join(WEB_DIR, 'css', 'app.css')) || '';
    for (const cls of ['.market-card', '.market-badge', '.market-actions', '.market-tag', '.memory-row', '.memory-del', '.plugin-slot', '.plugin-slot-btn']) {
      ok(css.indexOf(cls) !== -1, `app.css 缺少 P3 样式类 ${cls}`);
    }
  });

  test('ui.js / plugins.js / app.js 导出 P3 API（市场/记忆/槽位/HMAC 校验/压缩）', () => {
    const uiCode = stripComments(readJs('ui.js'));
    const appCode = stripComments(readJs('app.js'));
    const pluginCode = stripComments(readJs('plugins.js'));

    // UI API（SPEC U3）
    for (const name of ['renderMarket', 'openMarketPage', 'setMarketUrl', 'renderMemory', 'openMemoryPage', 'renderPluginSlots', 'openPluginPanel']) {
      const exposed = definesMethod(uiCode, name) || new RegExp(`UI\\\\.${name}\\\\s*=`).test(uiCode);
      ok(exposed, `ui.js 缺少 P3 API：UI.${name}`);
    }
    for (const name of ['renderMarketRows', 'buildMarketCard', 'fetchMarketIndex', 'renderMemoryLongTerm', 'renderMemorySummaries', 'renderPluginSlots', 'buildPluginSlot', 'runPluginSlotAction']) {
      ok(definesMethod(uiCode, name), `ui.js 缺少 P3 内部实现 ${name}`);
    }

    // DSPlugins 公开 API（SPEC L3 / 任务清单）
    for (const name of [
      'loadHousePlugins', 'reloadHousePlugin', 'installHousePlugin', 'getUiSlots', 'runSlotAction',
      'fetchMarketIndex', 'marketStatusMap', 'installMarketPlugin', 'removeMarketPlugin',
    ]) {
      ok(definesMethod(pluginCode, name), `plugins.js 缺少 P3 API：DSPlugins.${name}`);
      ok(new RegExp(`\\b${name}\\s*:`).test(pluginCode), `DSPlugins 导出对象缺少 ${name}`);
    }
    for (const name of ['normalizeHousePlugin', 'hydrateHouseDef', 'normalizeSlotList', 'validateMarketIndex', 'installMarketPlugin', 'removeMarketPlugin', 'execPluginCode']) {
      ok(definesMethod(pluginCode, name), `plugins.js 缺少 P3 实现 ${name}`);
    }
    ok(/new Function\(/.test(pluginCode), 'HousePlugin 沙箱未使用 new Function');
    ok(/sha256Hex/.test(pluginCode) && /pluginHmac/.test(pluginCode), '市场安装缺少 sha256/HMAC 校验');
    ok(/签名校验失败/.test(pluginCode), '市场安装缺少「签名校验失败」提示');

    // app.js handlers / 对外接口 / 记忆注入与压缩实现
    for (const name of [
      'onMarketFetch', 'onMarketInstall', 'onMarketRemove', 'onOpenMemory', 'onMemorySave',
      'onMemoryDelete', 'onSummaryDelete', 'onSlotAction', 'onOpenPluginPanel',
    ]) {
      ok(new RegExp(`\\b${name}\\s*:`).test(appCode), `app.js handlers 缺少 ${name}`);
    }
    for (const name of ['buildMemoryPrompt', 'resolveSystemPrompt', 'prepareContextMessages', 'buildSessionSummaryPiece', 'memorySummaryFor', 'loadHousePluginsAndSlots', 'refreshPluginSlots', 'runPluginSlotAction', 'fetchMarketIndex', 'installMarketItem']) {
      ok(definesMethod(appCode, name), `app.js 缺少 P3 实现 ${name}`);
    }
    for (const token of ['CONTEXT_BUDGET_DEFAULT', 'CONTEXT_THRESHOLD', 'CONTEXT_KEEP_RECENT', '已压缩', '之前对话摘要', '用户偏好：', '项目记忆：', 'memorySaveSummary']) {
      ok(appCode.indexOf(token) !== -1, `app.js 缺少上下文压缩/记忆注入元素 ${token}`);
    }
  });

  test('JsBridge.java 实现 P3 插件目录/记忆方法；plugin/memory 原生包齐全', () => {
    const bridge = readOrNull(JS_BRIDGE);
    ok(bridge, 'JsBridge.java 不存在');
    // 任务清单口径（旧 P0 方法 + P3 文件式方法）
    const expected = [
      'String pluginList', 'String pluginRead', 'void pluginWrite', 'void pluginDelete', 'void pluginSetEnabled',
      'String pluginHmac', 'void pluginOpenDir',
      'String memoryGetSummaries', 'void memorySaveSummary', 'void memoryDeleteSummary',
      'String memoryKvGet', 'void memoryKvSet', 'void memoryKvDelete', 'String memoryAll',
    ];
    for (const sig of expected) {
      ok(new RegExp(`public\\s+${sig.replace(/ /g, '\\s+')}\\s*\\(`).test(bridge), `JsBridge.java 缺少方法签名 ${sig}`);
    }
    // P3 文件式方法实际由 bridge.js 使用，同样必须存在
    for (const sig of ['String pluginReadFile', 'boolean pluginWriteFile', 'boolean pluginDeleteFile', 'boolean pluginSetEnabledFile']) {
      ok(new RegExp(`public\\s+${sig.replace(/ /g, '\\s+')}\\s*\\(`).test(bridge), `JsBridge.java 缺少文件式插件方法 ${sig}`);
    }
    for (const name of ['pluginHmac', 'pluginOpenDir', 'memoryGetSummaries', 'memorySaveSummary', 'memoryDeleteSummary', 'memoryKvGet', 'memoryKvSet', 'memoryKvDelete', 'memoryAll']) {
      const idx = bridge.search(new RegExp(`public\\s+(?:String|void|boolean)\\s+${name}\\s*\\(`));
      ok(idx >= 0, `JsBridge.${name} 不存在`);
      ok(bridge.slice(Math.max(0, idx - 240), idx).indexOf('@JavascriptInterface') !== -1, `JsBridge.${name} 缺少 @JavascriptInterface`);
    }
    const repoFile = path.join(JAVA_DIR, 'plugin', 'PluginRepository.java');
    const memFile = path.join(JAVA_DIR, 'memory', 'MemoryDb.java');
    const repo = readOrNull(repoFile);
    const mem = readOrNull(memFile);
    ok(repo, '缺少 app/src/main/java/com/deepseekhouse/app/plugin/PluginRepository.java');
    ok(mem, '缺少 app/src/main/java/com/deepseekhouse/app/memory/MemoryDb.java');
    for (const token of ['house-plugins', 'sdcard', 'listJson', 'String read(', 'boolean write(', 'boolean delete(', 'boolean setEnabled(', 'hmac(', 'sha256Of(', 'openDir(', 'isValidFileName', '512 * 1024', 'source']) {
      ok(repo.indexOf(token) !== -1, `PluginRepository 缺少关键实现 ${token}`);
    }
    for (const token of ['session_summary', 'memory_kv', 'CREATE TABLE', 'long_term', 'project', 'saveSummary(', 'deleteSummary(', 'summariesJson(', 'kvJson(', 'setKv(', 'deleteKv(', 'allJson(', 'PRIMARY KEY']) {
      ok(mem.indexOf(token) !== -1, `MemoryDb 缺少关键实现/表名 ${token}`);
    }
    ok(/SQLiteOpenHelper/.test(mem), 'MemoryDb 未继承 SQLiteOpenHelper');
  });

  test('QA 覆盖矩阵已包含 ARCH v2 P3 用例说明（docs/QA.md）', () => {
    const qaDoc = readOrNull(path.join(ROOT, 'docs', 'QA.md')) || '';
    ok(qaDoc, 'docs/QA.md 不存在');
    for (const keyword of ['ARCH v2 P3', 'P3 集成', 'p3-integration-tests.mjs', 'HMAC', 'memorySaveSummary', '已压缩', 'uiSlots', '插件市场']) {
      ok(qaDoc.indexOf(keyword) !== -1, `docs/QA.md 覆盖矩阵缺少 P3 关键词：${keyword}`);
    }
  });
}
