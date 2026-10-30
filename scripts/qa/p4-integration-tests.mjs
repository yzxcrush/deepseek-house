/**
 * scripts/qa/p4-integration-tests.mjs
 * ARCH v2 P4（工作台 / 构建任务面板 / 图片消息 / 前台通知 / 分享进入 / 应用锁 + 本地加密）
 * 集成用例：真实 index.html + 全部 JS + mock DSNative。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite, test, ok, equal, includes } from './lib/harness.mjs';
import { loadAppWindow, waitFor, click, isScreenActive, flush } from './lib/env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const byId = (app, id) => app.doc.getElementById(id);
const q = (app, sel) => app.doc.querySelector(sel);
function nativeCalls(app, method) { return app.native.__calls.filter((c) => c.method === method); }
function lastNative(app, method) { const l = nativeCalls(app, method); return l.length ? l[l.length - 1] : null; }
function emit(app, evt) { app.native.__emit(evt); }
function parseJson(v) { try { return JSON.parse(v); } catch { return null; } }
function lastChatBody(app) { const c = lastNative(app, 'startChat'); return c ? parseJson(c.args[1]) : null; }
async function bootApp(nativeOpts = {}) {
  const native = Object.assign({ prefs: { apiKey: 'sk-qa-p4-valid-key' } }, nativeOpts || {});
  if (nativeOpts && nativeOpts.prefs) native.prefs = Object.assign({ apiKey: 'sk-qa-p4-valid-key' }, nativeOpts.prefs);
  const app = await loadAppWindow({ native });
  app.doc = app.win.document;
  await waitFor(() => isScreenActive(app.win, 'screen-chats') || isScreenActive(app.win, 'screen-login'),
    { timeout: 8000, label: '启动' });
  return app;
}
function closeApp(app) { try { app.dom.window.close(); } catch { /* ignore */ } }
async function openChat(app) {
  const w = app.win;
  await waitFor(() => isScreenActive(w, 'screen-chats'), { timeout: 6000, label: '会话列表' });
  const fab = q(app, '.fab[data-action="new-chat"]');
  ok(fab, '缺少新建会话按钮');
  click(w, fab);
  await waitFor(() => isScreenActive(w, 'screen-chat'), { timeout: 6000, label: '对话页' });
  return w;
}

export function registerP4IntegrationTests() {
  suite('ARCH v2 P4 集成（工作台 / 图片 / 通知 / 分享 / 应用锁加密 / 构建任务）');
  test('图片：pickImage → 待发送 → sendWithImages 请求 content 数组（text + image_url）', async () => {
    const image = { dataUrl: 'data:image/png;base64,AAABAAE=', width: 2, height: 2, name: 'qa.png' };
    const app = await bootApp({ p4: { image } });
    try {
      await openChat(app);
      await app.win.App.pickImage('gallery');
      await waitFor(() => (app.win.App.getPendingImages() || []).length === 1, { timeout: 4000, label: '待发送图片' });
      const pending = app.win.App.getPendingImages();
      await app.win.App.sendWithImages('看看这张图', pending);
      await waitFor(() => lastNative(app, 'startChat'), { timeout: 8000, label: 'startChat' });
      const body = lastChatBody(app);
      const users = (body.messages || []).filter((m) => m.role === 'user');
      const last = users[users.length - 1];
      ok(Array.isArray(last.content), 'user content 应为数组');
      const json = JSON.stringify(last.content);
      includes(json, 'image_url', 'content 应包含 image_url');
      includes(json, '看看这张图', 'content 应包含文本');
      equal((app.win.App.getPendingImages() || []).length, 0, '发送后清空待发送图片');
      ok(nativeCalls(app, 'pickImage').length >= 1, '应调用原生 pickImage');
    } finally { closeApp(app); }
  });

  test('通知：生成开始 setForeground(true)，完成 setForeground(false)', async () => {
    const app = await bootApp();
    try {
      await openChat(app);
      await app.win.App.send('你好');
      await waitFor(() => lastNative(app, 'startChat'), { timeout: 8000, label: 'startChat' });
      await waitFor(() => nativeCalls(app, 'setForeground').some((c) => c.args[0] === true),
        { timeout: 4000, label: 'setForeground(true)' });
      const call = lastNative(app, 'startChat');
      emit(app, { type: 'done', requestId: call.args[0], finishReason: 'stop' });
      await waitFor(() => nativeCalls(app, 'setForeground').some((c) => c.args[0] === false),
        { timeout: 6000, label: 'setForeground(false)' });
    } finally { closeApp(app); }
  });

  test('通知：app-state 后台 + done → notify 完成通知', async () => {
    const app = await bootApp();
    try {
      await openChat(app);
      emit(app, { type: 'app-state', foreground: false });
      await app.win.App.send('后台通知测试');
      await waitFor(() => lastNative(app, 'startChat'), { timeout: 8000, label: 'startChat' });
      const call = lastNative(app, 'startChat');
      emit(app, { type: 'done', requestId: call.args[0], finishReason: 'stop' });
      await waitFor(() => nativeCalls(app, 'notify').length >= 1, { timeout: 6000, label: 'notify' });
      includes(String(lastNative(app, 'notify').args[0]), '回复完成', '通知标题');
    } finally { closeApp(app); }
  });

  test('F8 分享进入：shared 事件 → 新建会话并填入文本', async () => {
    const app = await bootApp();
    try {
      await waitFor(() => isScreenActive(app.win, 'screen-chats'), { timeout: 6000 });
      const before = app.win.Store.listChats().length;
      emit(app, { type: 'shared', text: '来自其他 App 的分享内容' });
      await waitFor(() => app.win.Store.listChats().length > before, { timeout: 5000, label: '新会话' });
      await waitFor(() => {
        const input = byId(app, 'composer-input');
        return input && String(input.value || '').indexOf('来自其他 App') >= 0;
      }, { timeout: 5000, label: 'composer 文本' });
    } finally { closeApp(app); }
  });

  test('F9 应用锁：toggleAppLock → 原生 setAppLock', async () => {
    const app = await bootApp();
    try {
      await app.win.App.toggleAppLock(true);
      await waitFor(() => lastNative(app, 'setAppLock'), { timeout: 4000, label: 'setAppLock' });
      equal(lastNative(app, 'setAppLock').args[0], true, 'setAppLock(true)');
      await app.win.App.toggleAppLock(false);
      equal(lastNative(app, 'setAppLock').args[0], false, 'setAppLock(false)');
    } finally { closeApp(app); }
  });

  test('F9 本地加密：启用后 localStorage 只存密文（dsh.v1.enc）', async () => {
    const secret = Buffer.alloc(32, 7).toString('base64');
    const app = await bootApp({ prefs: { apiKey: 'sk-qa-p4' }, p4: { storageSecret: secret } });
    try {
      await waitFor(() => isScreenActive(app.win, 'screen-chats'), { timeout: 8000 });
      await openChat(app);
      await waitFor(() => app.win.Store.listChats().length > 0, { timeout: 5000, label: '会话创建' });
      await waitFor(() => !!app.win.localStorage.getItem('dsh.v1.enc'), { timeout: 6000, label: '密文写入' });
      const plain = app.win.localStorage.getItem('dsh.v1');
      ok(!plain, '启用加密后不应保留明文键 dsh.v1（实际：' + String(plain).slice(0, 40) + '）');
      ok(String(app.win.localStorage.getItem('dsh.v1.enc')).length > 20, '密文内容非空');
    } finally { closeApp(app); }
  });

  test('工作台：toggleWorkbench(true) → 状态与持久化生效', async () => {
    const app = await bootApp();
    try {
      await app.win.App.toggleWorkbench(true);
      await flush(app.win, 80);
      equal(app.win.App.getWorkbenchState().enabled, true, 'getWorkbenchState().enabled');
      const stored = parseJson(app.win.localStorage.getItem('dsh.workbench') || '') || {};
      if (Object.keys(stored).length) equal(!!stored.enabled, true, 'localStorage dsh.workbench');
    } finally { closeApp(app); }
  });

  test('构建任务面板：renderBuildTasks / updateBuildTask 渲染进度与状态', async () => {
    const app = await bootApp();
    try {
      app.win.UI.renderBuildTasks([{ id: 'qa-build-1', tool: 'pack_apk', server: 'termux', percent: 30, status: 'running', logs: ['开始构建'] }]);
      await flush(app.win, 80);
      const list = byId(app, 'build-tasks');
      ok(list, '缺少 #build-tasks');
      const card = list.querySelector('[data-build-id="qa-build-1"]') || list.querySelector('.build-task');
      ok(card, '构建任务卡片未渲染');
      app.win.UI.updateBuildTask('qa-build-1', { percent: 80, status: 'running', logs: ['开始构建', 'aapt', 'javac'] });
      await flush(app.win, 80);
      includes(String(list.textContent), '80', '进度未更新为 80%');
      app.win.UI.openBuildPanel();
      await flush(app.win, 80);
      ok(byId(app, 'build-panel') && byId(app, 'build-panel').getAttribute('aria-hidden') === 'false', '构建面板未打开');
    } finally { closeApp(app); }
  });

  test('静态契约：P4 UI/逻辑/桥接方法与 DOM id', () => {
    const html = read('app/assets/web/index.html');
    ['workbench-toggle', 'build-panel', 'build-tasks', 'set-applock'].forEach((id) => includes(html, id, '缺少 DOM id ' + id));
    const ui = read('app/assets/web/js/ui.js');
    ['UI.renderBuildTasks', 'UI.updateBuildTask', 'UI.openBuildPanel', 'UI.toggleWorkbench', 'UI.setPendingImages'].forEach((s) => includes(ui, s, '缺少 UI API ' + s));
    const appjs = read('app/assets/web/js/app.js');
    ['function sendWithImages', 'function pickImageSource', 'function toggleAppLock', 'function startForegroundService', 'function onSharedEvent'].forEach((s) => includes(appjs, s, '缺少 app.js ' + s));
    const bridge = read('app/assets/web/js/bridge.js');
    ['pickImage:', 'setForeground:', 'notify:', 'setAppLock:', 'getStorageSecret:'].forEach((s) => includes(bridge, s, '缺少 Bridge ' + s));
    const bridge2 = read('app/assets/web/js/bridge.js');
    ['checkRoot:', 'setRootMode:', 'isRootMode:'].forEach((x) => includes(bridge2, x, '缺少 Bridge root ' + x));
    const jb = read('app/src/main/java/com/deepseekhouse/app/JsBridge.java');
    ['checkRoot', 'setRootMode', 'isRootMode'].forEach((x) => includes(jb, x, '缺少 JsBridge root ' + x));
    includes(read('app/src/main/java/com/deepseekhouse/app/agent/RootManager.java'), 'uid=0', 'RootManager 缺少 uid=0 检测');
    const store = read('app/assets/web/js/store.js');
    ['dsh.v1.enc', 'AES-GCM'].forEach((s) => includes(store, s, '缺少 Store 加密 ' + s));
  });
}
