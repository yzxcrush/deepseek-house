/**
 * scripts/qa/integration-tests.mjs
 * jsdom 集成冒烟：加载真实 app/assets/web/index.html（含全部 9 个 defer 脚本），
 * 注入 window.DSNative mock，覆盖 SPEC §7.4 的关键交互流：
 *   登录 → 发送/流式 → 停止 → 新建/切换会话 → 设置保存 → 插件开关。
 *
 * jsdom 无布局/动画：env.mjs 已对 scrollTo/scrollIntoView/matchMedia/rAF 等做 stub。
 */

import {
  suite,
  test,
  ok,
  equal,
  includes,
  notIncludes,
  isFunction,
  isObject,
  isString,
  fail,
} from './lib/harness.mjs';
import {
  loadAppWindow,
  waitFor,
  flush,
  sleep,
  isScreenActive,
  isHidden,
  click,
  hasWebFile,
  SPEC_JS_ORDER,
  bodyText,
} from './lib/env.mjs';

/* ------------------------------------------------------------------ *
 * 共享 app 窗口与会话状态
 * ------------------------------------------------------------------ */
const ctx = {
  app: null,
  loggedIn: false,
  chatAId: null,
  chatBId: null,
};

function missingScripts() {
  return SPEC_JS_ORDER.filter((name) => !hasWebFile('js', name));
}

async function getApp() {
  if (ctx.app) return ctx.app;
  const missing = missingScripts();
  if (missing.length) {
    throw new Error(`前端脚本缺失，无法进行集成测试：${missing.join(', ')}（等待其他成员完成）`);
  }
  const app = await loadAppWindow({ native: { prefs: { apiKey: '' } } });
  app.doc = app.win.document;
  ctx.app = app;
  return app;
}

const docOf = (app) => app.win.document;
const win = () => ctx.app.win;

function $id(id) {
  return docOf(ctx.app).getElementById(id);
}

function $sel(sel) {
  return docOf(ctx.app).querySelector(sel);
}

function $$(sel) {
  return Array.from(docOf(ctx.app).querySelectorAll(sel));
}

function clickAction(action) {
  const el = $sel(`[data-action="${action}"]`);
  if (!el) throw new Error(`页面上找不到 [data-action="${action}"]`);
  click(ctx.app.win, el);
  return el;
}

function msgText() {
  const el = $id('messages');
  return el ? el.textContent || '' : '';
}

function userContents() {
  return $$('.msg--user .msg-content').map((n) => n.textContent || '');
}

function assistantContents() {
  return $$('.msg--assistant .msg-content').map((n) => n.textContent || '');
}

function lastAssistantText() {
  const list = assistantContents();
  return list.length ? list[list.length - 1] : '';
}

function isStreaming() {
  const appEl = $id('app');
  return !!appEl && appEl.classList.contains('is-streaming');
}

function isStopMode() {
  const btn = $id('btn-send');
  if (!btn) return false;
  const label = btn.getAttribute('aria-label') || '';
  return btn.classList.contains('is-stop') || label.indexOf('停止') !== -1;
}

function nativeCalls(method) {
  return ctx.app.native.__calls.filter((c) => c.method === method);
}

function lastSetPrefsPayload() {
  const calls = nativeCalls('setPrefs');
  if (!calls.length) return null;
  try {
    return JSON.parse(calls[calls.length - 1].args[0]);
  } catch {
    return null;
  }
}

function emit(evt) {
  ctx.app.native.__emit(evt);
}

function pendingChat() {
  const list = ctx.app.native.__pending.chat;
  return list.length ? list[list.length - 1] : null;
}

async function loginIfNeeded() {
  const app = await getApp();
  if (ctx.loggedIn && isScreenActive(app.win, 'screen-chat')) return app;
  if (isScreenActive(app.win, 'screen-login')) {
    const keyInput = $id('login-key');
    ok(keyInput, '登录页缺少 #login-key');
    keyInput.value = 'sk-qa-test-valid-key';
    const form = $id('login-form');
    ok(form, '登录页缺少 #login-form');
    form.dispatchEvent(new app.win.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => nativeCalls('validateKey').length > 0, { timeout: 3000, label: 'Bridge.validateKey 调用' });
    await waitFor(() => isScreenActive(app.win, 'screen-chat'), { timeout: 5000, label: '登录成功后进入聊天界面' });
  }
  ctx.loggedIn = true;
  return app;
}

function setComposer(text) {
  const input = $id('composer-input');
  ok(input, '找不到 #composer-input');
  input.value = text;
  input.dispatchEvent(new ctx.app.win.Event('input', { bubbles: true }));
  return input;
}

/** 发送一条消息并等待 DSNative.startChat 被调用，返回 requestId。 */
async function sendAndWaitRequest(text) {
  const before = nativeCalls('startChat').length;
  setComposer(text);
  clickAction('send');
  await waitFor(() => nativeCalls('startChat').length > before, { timeout: 5000, label: 'Bridge.startChat 调用' });
  const call = nativeCalls('startChat')[nativeCalls('startChat').length - 1];
  return call.args[0];
}

async function emitChunkAndWait(requestId, delta, minLength) {
  const prev = lastAssistantText();
  emit({ type: 'chunk', requestId, delta, reasoning: '' });
  await waitFor(
    () => {
      const text = lastAssistantText();
      return text.indexOf(delta) !== -1 && text.length > (minLength || prev.length);
    },
    { timeout: 4000, label: `助手气泡出现「${delta}」` },
  );
  return lastAssistantText();
}

async function emitDoneAndWait(requestId) {
  emit({ type: 'done', requestId, finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
  await waitFor(() => !isStreaming(), { timeout: 4000, label: 'done 后退出流式状态' });
}

/** 过滤 jsdom 已知限制造成的噪音（布局/滚动/CSS 解析），其余视为页面错误。 */
function filteredPageErrors(app) {
  return app.pageErrors.filter((err) => {
    const msg = String((err && err.message) || err);
    if (/Not implemented/i.test(msg)) return false;
    if (/Could not parse CSS/i.test(msg)) return false;
    if (/jsdom.*not implemented/i.test(msg)) return false;
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */
export function registerIntegrationTests() {
  suite('集成冒烟 · 页面加载与契约');

  test('加载 index.html：9 个脚本全部执行，全局模块与契约方法齐全', async () => {
    const app = await getApp();
    const w = app.win;
    const doc = w.document;
    ok(doc.getElementById('app'), '页面缺少 #app');
    isObject(w.UI, 'window.UI 未定义');
    isObject(w.Bridge, 'window.Bridge 未定义');
    isObject(w.Store, 'window.Store 未定义');
    isObject(w.Api, 'window.Api 未定义');
    isObject(w.DSPlugins, 'window.DSPlugins 未定义');
    isFunction(w.Markdown.render, 'window.Markdown.render 未定义');

    // 运行时契约（比静态正则更可靠）
    const uiMethods = [
      'init', 'showScreen', 'toast', 'setHeader', 'renderChatList', 'renderMessages', 'appendMessage',
      'updateMessage', 'removeMessage', 'setStreaming', 'setComposer', 'getComposer', 'scrollBottom',
      'setModel', 'renderSettings', 'renderPlugins', 'renderLogin', 'setUser', 'confirm',
    ];
    for (const name of uiMethods) isFunction(w.UI[name], `UI.${name} 缺失`);
    for (const name of [
      'prefs', 'setPrefs', 'startChat', 'validateKey', 'httpFetch', 'plugins', 'pluginRead', 'pluginWrite',
      'pluginDelete', 'pluginSetEnabled', 'importPluginFile', 'saveTextFile', 'toast', 'openUrl',
      'setBackDepth', 'setStatusBar', 'finishApp', 'onEvent', 'emit',
    ]) {
      isFunction(w.Bridge[name], `Bridge.${name} 缺失`);
    }
    isObject(w.Bridge.clipboard, 'Bridge.clipboard 缺失');
    for (const name of ['send', 'cancel', 'verifyKey']) isFunction(w.Api[name], `Api.${name} 缺失`);
    for (const name of [
      'list', 'get', 'register', 'setEnabled', 'isEnabled', 'loadExternal', 'toolSchemas', 'runTool',
      'runCommand', 'installFromCode', 'installFromFile', 'remove', 'onChange',
    ]) {
      isFunction(w.DSPlugins[name], `DSPlugins.${name} 缺失`);
    }
    for (const name of [
      'load', 'save', 'getPrefs', 'setPrefs', 'createChat', 'deleteChat', 'renameChat', 'touchChat',
      'getChat', 'listChats', 'appendMessage', 'updateMessage', 'exportChatMarkdown', 'clearAll',
    ]) {
      isFunction(w.Store[name], `Store.${name} 缺失`);
    }

    equal(w.Bridge.__isMock, false, '注入 DSNative 后不应处于 mock 模式');
    ok(w.DSNative === app.native, 'window.DSNative 不是测试注入的 mock');

    const errors = filteredPageErrors(app);
    ok(errors.length === 0, `页面加载出现 ${errors.length} 个脚本错误：\n${errors.map((e) => (e && e.message) || e).join('\n')}`);
  });

  suite('集成冒烟 · 登录');

  test('首次启动无 Key → 登录页可见，聊天页隐藏', async () => {
    const app = await getApp();
    await waitFor(() => isScreenActive(app.win, 'screen-login'), { timeout: 4000, label: '登录页显示' });
    ok(!isScreenActive(app.win, 'screen-chat'), '无 Key 时不应显示聊天页');
    ok($id('login-form'), '缺少登录表单');
    ok($id('login-submit'), '缺少登录按钮');
    const keyInput = $id('login-key');
    ok(!isHidden(app.win, keyInput), 'API Key 输入框不可见');
    equal($id('login-submit').textContent.trim(), '登录', '登录按钮文案应为「登录」');
    equal(nativeCalls('validateKey').length, 0, '启动时不应调用 validateKey');
  });

  test('登录：提交 Key → Bridge.validateKey 被调用 → validated 成功 → 进入聊天界面', async () => {
    const app = await getApp();
    const keyInput = $id('login-key');
    keyInput.value = 'sk-qa-test-valid-key';
    const form = $id('login-form');
    const beforeSetPrefs = nativeCalls('setPrefs').length;
    form.dispatchEvent(new app.win.Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => nativeCalls('validateKey').length > 0, { timeout: 3000, label: 'validateKey 调用' });
    const validateCall = nativeCalls('validateKey')[0];
    ok(validateCall.args[0], 'validateKey 应携带 requestId');

    await waitFor(() => isScreenActive(app.win, 'screen-chat'), { timeout: 5000, label: '进入聊天界面' });
    ok(!isScreenActive(app.win, 'screen-login'), '登录成功后登录页应隐藏');
    ok(nativeCalls('setPrefs').length > beforeSetPrefs, '登录时应调用 Bridge.setPrefs 保存 apiKey');
    const keyPayloads = nativeCalls('setPrefs')
      .map((c) => {
        try {
          return JSON.parse(c.args[0]);
        } catch {
          return {};
        }
      })
      .filter((p) => p.apiKey);
    ok(keyPayloads.some((p) => p.apiKey === 'sk-qa-test-valid-key'), 'setPrefs 应写入 apiKey');
    equal(app.native.__prefs.apiKey, 'sk-qa-test-valid-key', '原生 prefs 未更新 apiKey');
    // SPEC §7.5：API Key 只存在原生 SharedPreferences + 请求头，不落 localStorage、不写日志
    const stored = app.win.localStorage.getItem('dsh.v1') || '';
    notIncludes(stored, 'sk-qa-test-valid-key', 'API Key 被写入了 localStorage');
    const leakedLogs = app.consoleLogs.filter((entry) => entry.args.join(' ').indexOf('sk-qa-test-valid-key') !== -1);
    ok(leakedLogs.length === 0, 'API Key 出现在 console 日志中');
    // 进入聊天后应自动创建一个活动会话
    ok(app.win.Store.getActiveChat(), '进入聊天界面后应存在活动会话');
    ctx.loggedIn = true;
  });

  test('已配置 Key 时二次启动直接进入聊天页', async () => {
    const app2 = await loadAppWindow({ native: { prefs: { apiKey: 'sk-qa-existing-key' } } });
    try {
      await waitFor(() => isScreenActive(app2.win, 'screen-chat'), { timeout: 5000, label: '有 Key 启动进入聊天页' });
      ok(!isScreenActive(app2.win, 'screen-login'), '有 Key 启动不应显示登录页');
    } finally {
      app2.dom.window.close();
    }
  });

  suite('集成冒烟 · 发送 / 流式渲染 / 停止');

  test('发送消息 → 用户气泡出现 → 流式 chunk 逐段增长 → done 后恢复发送按钮', async () => {
    const app = await loginIfNeeded();
    const w = app.win;
    const text = '你好，请介绍一下 DeepSeek House';
    const requestId = await sendAndWaitRequest(text);
    const startBody = nativeCalls('startChat')[nativeCalls('startChat').length - 1].args[1];
    notIncludes(String(startBody), 'sk-qa-test-valid-key', 'startChat 请求体不应包含 API Key（应只在原生请求头中）');

    await waitFor(() => userContents().some((c) => c.indexOf(text) !== -1), { timeout: 4000, label: '用户气泡出现' });
    await waitFor(() => isStreaming(), { timeout: 3000, label: '进入流式状态' });
    ok(isStopMode(), '流式时发送按钮应变为停止按钮');

    const t1 = await emitChunkAndWait(requestId, '第一段流式内容。', 0);
    const len1 = t1.length;
    includes(t1, '第一段流式内容。');

    const t2 = await emitChunkAndWait(requestId, '第二段内容继续增长。', len1);
    includes(t2, '第一段流式内容。');
    includes(t2, '第二段内容继续增长。');
    ok(t2.length > len1, '助手气泡文字未随 chunk 增长');

    await emitDoneAndWait(requestId);
    await waitFor(() => !isStopMode(), { timeout: 3000, label: 'done 后发送按钮恢复' });
    const btn = $id('btn-send');
    equal(btn.getAttribute('aria-label'), '发送', 'done 后发送按钮 aria-label 应恢复为「发送」');
    includes(lastAssistantText(), '第二段内容继续增长。', 'done 后助手消息内容丢失');

    // Store 中的消息内容也应完整
    const chat = w.Store.getActiveChat();
    const assistantMsg = chat.messages.filter((m) => m.role === 'assistant').pop();
    isString(assistantMsg.content);
    includes(assistantMsg.content, '第二段内容继续增长。');
    equal(assistantMsg.streaming, false, 'done 后 assistant 消息不应仍标记 streaming');
  });

  test('停止生成 → 调用 cancelRequest → 保留已生成内容', async () => {
    const app = await loginIfNeeded();
    const text = '请写一段很长的话，我要测试停止';
    const requestId = await sendAndWaitRequest(text);
    await emitChunkAndWait(requestId, '这是停止前已经生成的文字。', 0);

    const beforeCancel = nativeCalls('cancelRequest').length;
    clickAction('send'); // 流式中点击发送按钮 = 停止
    await waitFor(() => !isStreaming(), { timeout: 4000, label: '停止后退出流式状态' });
    await waitFor(() => nativeCalls('cancelRequest').length > beforeCancel, { timeout: 3000, label: 'Bridge.cancelRequest 调用' });
    const cancelCall = nativeCalls('cancelRequest')[nativeCalls('cancelRequest').length - 1];
    equal(cancelCall.args[0], requestId, 'cancelRequest 的 requestId 不正确');

    const textAfterStop = lastAssistantText();
    includes(textAfterStop, '这是停止前已经生成的文字。', '停止后已生成内容应保留');

    // 停止后再来的 chunk/done 不应破坏界面
    emit({ type: 'chunk', requestId, delta: '停止后不应追加。', reasoning: '' });
    emit({ type: 'done', requestId, finishReason: 'stop', usage: {} });
    await sleep(200);
    ok(!isStreaming(), '迟到事件后不应重新进入流式状态');
    includes(lastAssistantText(), '这是停止前已经生成的文字。', '迟到事件破坏了已停止的消息');
  });

  suite('集成冒烟 · 会话管理');

  test('新建会话 → 会话列表增加且切换到空会话', async () => {
    const app = await loginIfNeeded();
    const w = app.win;
    const before = w.Store.listChats();
    const beforeDomCount = $$('#chat-list .chat-item').length;
    const beforeActive = w.Store.getActiveChatId();
    clickAction('new-chat');
    await waitFor(() => w.Store.listChats().length === before.length + 1, { timeout: 3000, label: '会话数量 +1' });
    const lists = w.Store.listChats();
    ok(w.Store.getActiveChatId() !== beforeActive, '新建会话后活动会话应切换');
    ok(w.Store.getActiveChat().messages.length === 0, '新会话应为空');
    await waitFor(() => $$('#chat-list .chat-item').length >= beforeDomCount + 1, { timeout: 3000, label: '会话列表 DOM 增加' });
    ctx.chatBId = w.Store.getActiveChatId();
    // chatA 是上一步的会话（含消息）
    const chatA = lists.find((c) => c.id !== ctx.chatBId && c.messages.length > 0);
    ok(chatA, '未找到之前有消息的会话');
    ctx.chatAId = chatA.id;
  });

  test('切换会话 → 消息内容正确对应', async () => {
    const app = await loginIfNeeded();
    const w = app.win;
    // 在当前（新）会话发一条标记消息并结束流式
    const markerB = '会话B专属标记消息';
    const requestId = await sendAndWaitRequest(markerB);
    await waitFor(() => userContents().some((c) => c.indexOf(markerB) !== -1), { timeout: 4000, label: '会话B用户消息' });
    await emitChunkAndWait(requestId, '会话B的回复。', 0);
    await emitDoneAndWait(requestId);

    const chatA = w.Store.getChat(ctx.chatAId);
    ok(chatA, '会话 A 不存在');
    const lastUserA = chatA.messages.filter((m) => m.role === 'user').pop();
    ok(lastUserA, '会话 A 没有用户消息');

    // 点击会话列表中的会话 A
    const item = $sel(`#chat-list .chat-item[data-id="${ctx.chatAId}"]`);
    ok(item, `会话列表中找不到会话 A（${ctx.chatAId}）`);
    click(w, item);
    await waitFor(() => w.Store.getActiveChatId() === ctx.chatAId, { timeout: 3000, label: '切换到会话 A' });
    await waitFor(() => msgText().indexOf(lastUserA.content) !== -1, { timeout: 3000, label: '会话 A 消息渲染' });
    notIncludes(msgText(), markerB, '切换会话后仍显示会话 B 的消息');
    const activeItem = $sel('#chat-list .chat-item.is-active');
    ok(activeItem && activeItem.getAttribute('data-id') === ctx.chatAId, '会话列表高亮未切换到会话 A');
  });

  suite('集成冒烟 · 设置页');

  test('设置页：修改 model → 保存 → Bridge.setPrefs 被调用且生效', async () => {
    const app = await loginIfNeeded();
    const w = app.win;
    clickAction('open-settings');
    await waitFor(() => isScreenActive(w, 'screen-settings'), { timeout: 3000, label: '设置页显示' });

    const select = $id('set-model');
    ok(select, '设置页缺少 #set-model');
    const optionValues = Array.from(select.options || []).map((o) => o.value);
    includes(optionValues.join(','), 'deepseek-reasoner', `模型下拉缺少 deepseek-reasoner（实际：${optionValues.join(',')}）`);

    // spy Bridge.setPrefs
    const spy = { calls: [] };
    const original = w.Bridge.setPrefs;
    w.Bridge.setPrefs = function (patch) {
      spy.calls.push(patch);
      return original.apply(this, arguments);
    };

    try {
      const nativeBefore = nativeCalls('setPrefs').length;
      select.value = 'deepseek-reasoner';
      select.dispatchEvent(new w.Event('change', { bubbles: true }));
      clickAction('save-settings');

      await waitFor(() => spy.calls.length > 0, { timeout: 3000, label: 'Bridge.setPrefs 被调用' });
      const patch = spy.calls[spy.calls.length - 1] || {};
      equal(patch.model, 'deepseek-reasoner', 'Bridge.setPrefs 未携带新 model');
      await waitFor(() => nativeCalls('setPrefs').length > nativeBefore, { timeout: 3000, label: '原生 setPrefs 调用' });
      equal(lastSetPrefsPayload().model, 'deepseek-reasoner', '原生 setPrefs 未收到新 model');
      equal(w.Store.getPrefs().model, 'deepseek-reasoner', 'Store prefs 未更新 model');
    } finally {
      w.Bridge.setPrefs = original;
    }

    // 返回聊天页
    clickAction('back');
    await waitFor(() => isScreenActive(w, 'screen-chat'), { timeout: 3000, label: '从设置页返回聊天页' });
  });

  suite('集成冒烟 · 插件页');

  test('插件页：渲染内置插件并可切换开关（禁用后工具不再暴露）', async () => {
    const app = await loginIfNeeded();
    const w = app.win;
    clickAction('open-plugins');
    await waitFor(() => isScreenActive(w, 'screen-plugins'), { timeout: 3000, label: '插件页显示' });
    await waitFor(() => $$('#plugins-list .plugin-row').length >= 3, { timeout: 5000, label: '插件列表渲染 ≥3 项' });

    const rows = $$('#plugins-list .plugin-row');
    const plugins = w.DSPlugins.list();
    ok(plugins.length >= 3, `内置插件应 ≥3 个，实际 ${plugins.length}`);
    equal(rows.length, plugins.length, '插件页渲染数量与 DSPlugins.list() 不一致');
    const listText = $id('plugins-list').textContent;
    for (const name of ['计算器', '时间', '网页', '提示词']) {
      includes(listText, name, `插件列表缺少内置插件「${name}」`);
    }

    const checkbox = $sel('#plugins-list input[data-plugin-toggle="calculator"]');
    ok(checkbox, '找不到 calculator 插件的开关');
    equal(checkbox.checked, true, 'calculator 默认应为启用状态');
    ok(w.DSPlugins.isEnabled('calculator'), 'calculator 初始应 isEnabled=true');
    ok(w.DSPlugins.toolSchemas().some((s) => s.function.name === 'calculator'), '初始 toolSchemas 应含 calculator');

    // 关闭
    checkbox.checked = false;
    checkbox.dispatchEvent(new w.Event('change', { bubbles: true }));
    await waitFor(() => w.DSPlugins.isEnabled('calculator') === false, { timeout: 3000, label: 'calculator 被禁用' });
    ok(!w.DSPlugins.toolSchemas().some((s) => s.function.name === 'calculator'), '禁用后 toolSchemas 仍暴露 calculator');
    await waitFor(() => {
      const cb = $sel('#plugins-list input[data-plugin-toggle="calculator"]');
      return cb && cb.checked === false;
    }, { timeout: 3000, label: '插件开关 UI 刷新为关闭' });

    // 重新启用（清理状态）
    const cb2 = $sel('#plugins-list input[data-plugin-toggle="calculator"]');
    cb2.checked = true;
    cb2.dispatchEvent(new w.Event('change', { bubbles: true }));
    await waitFor(() => w.DSPlugins.isEnabled('calculator') === true, { timeout: 3000, label: 'calculator 重新启用' });
    ok(w.DSPlugins.toolSchemas().some((s) => s.function.name === 'calculator'), '重新启用后 toolSchemas 应恢复 calculator');
  });

  suite('集成冒烟 · 搜索 / 返回层级 / 工具调用');

  test('会话搜索：抽屉输入关键词 → 会话列表过滤', async () => {
    const app = await loginIfNeeded();
    const w = app.win;
    // 回到聊天页并打开抽屉
    if (!isScreenActive(w, 'screen-chat')) {
      clickAction('back');
      await waitFor(() => isScreenActive(w, 'screen-chat'), { timeout: 3000, label: '返回聊天页' });
    }
    clickAction('open-drawer');
    await waitFor(() => {
      const drawer = $id('drawer');
      return drawer && drawer.classList.contains('is-open');
    }, { timeout: 3000, label: '抽屉打开' });

    const allItems = $$('#chat-list .chat-item');
    ok(allItems.length >= 2, `搜索前应至少有 2 个会话，实际 ${allItems.length}`);
    const chatA = w.Store.getChat(ctx.chatAId);
    ok(chatA, '会话 A 不存在');

    const search = $id('search-input');
    ok(search, '抽屉缺少 #search-input');
    search.value = 'DeepSeek House';
    search.dispatchEvent(new w.Event('input', { bubbles: true }));
    await waitFor(() => $$('#chat-list .chat-item').length === 1, { timeout: 4000, label: '搜索结果只剩会话 A' });
    equal($sel('#chat-list .chat-item').getAttribute('data-id'), ctx.chatAId, '搜索结果不是会话 A');

    // 清空搜索恢复列表
    search.value = '';
    search.dispatchEvent(new w.Event('input', { bubbles: true }));
    await waitFor(() => $$('#chat-list .chat-item').length >= 2, { timeout: 4000, label: '清空搜索恢复列表' });
    clickAction('close-drawer');
  });

  test('返回键分层：设置页 → 原生 back 事件 → 回到聊天页且 backDepth 归零', async () => {
    const app = await loginIfNeeded();
    const w = app.win;
    clickAction('open-settings');
    await waitFor(() => isScreenActive(w, 'screen-settings'), { timeout: 3000, label: '设置页显示' });
    await waitFor(() => {
      const calls = nativeCalls('setBackDepth');
      return calls.length && Number(calls[calls.length - 1].args[0]) === 1;
    }, { timeout: 3000, label: 'setBackDepth(1)' });

    app.native.__emit({ type: 'back' });
    await waitFor(() => isScreenActive(w, 'screen-chat'), { timeout: 3000, label: 'back 事件回到聊天页' });
    await waitFor(() => {
      const calls = nativeCalls('setBackDepth');
      return calls.length && Number(calls[calls.length - 1].args[0]) === 0;
    }, { timeout: 3000, label: 'setBackDepth(0)' });
  });

  test('插件工具调用循环：done(toolCalls) → 执行插件工具 → 结果回传 → 继续请求', async () => {
    const app = await loginIfNeeded();
    const w = app.win;
    if (!isScreenActive(w, 'screen-chat')) {
      clickAction('back');
      await waitFor(() => isScreenActive(w, 'screen-chat'), { timeout: 3000, label: '返回聊天页' });
    }
    // 确保 calculator 处于启用状态
    if (!w.DSPlugins.isEnabled('calculator')) w.DSPlugins.setEnabled('calculator', true);
    ok(w.DSPlugins.toolSchemas().some((t) => t.function.name === 'calculator'), 'calculator 工具未暴露');

    const beforeStarts = nativeCalls('startChat').length;
    const requestId = await sendAndWaitRequest('请用计算器算 2+3*4');
    // 1) 第一轮：模型返回 tool_calls
    app.native.__emit({
      type: 'chunk',
      requestId,
      delta: '',
      reasoning: '',
      toolCalls: [{ index: 0, id: 'call_qa_1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"2+3*4"}' } }],
    });
    app.native.__emit({ type: 'done', requestId, finishReason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });

    // 2) 应用应执行工具、追加 role:"tool" 消息并发起第二轮请求
    await waitFor(() => nativeCalls('startChat').length >= beforeStarts + 2, { timeout: 8000, label: '工具执行后继续请求（第二轮 startChat）' });
    await waitFor(() => {
      const chat = w.Store.getActiveChat();
      return chat.messages.some((m) => m.role === 'tool' && String(m.content || '').indexOf('14') !== -1);
    }, { timeout: 5000, label: '工具结果消息（含 14）' });
    const toolMsg = w.Store.getActiveChat().messages.filter((m) => m.role === 'tool').pop();
    equal(toolMsg.toolName, 'calculator', '工具消息 toolName 应为 calculator');
    await waitFor(() => {
      const node = $$('.msg--tool .msg-content').pop();
      return node && String(node.textContent || '').indexOf('14') !== -1;
    }, { timeout: 4000, label: '工具消息渲染到 DOM' });

    // 3) 第二轮：模型正常回复并结束
    const secondRequest = nativeCalls('startChat')[nativeCalls('startChat').length - 1].args[0];
    await emitChunkAndWait(secondRequest, '计算结果是 14。', 0);
    await emitDoneAndWait(secondRequest);
    includes(lastAssistantText(), '14', '工具调用后的最终回复未渲染');

    // 历史顺序：assistant(tool_calls) 之后是 tool 消息
    const msgs = w.Store.getActiveChat().messages;
    const toolIdx = msgs.findIndex((m) => m.role === 'tool');
    ok(toolIdx > 0, '未找到 tool 消息');
    const prev = msgs[toolIdx - 1];
    ok(prev.role === 'assistant' && prev.toolCalls && prev.toolCalls.length, 'tool 消息前的 assistant 消息缺少 toolCalls');
  });

  suite('集成冒烟 · 错误与收尾');

  test('完整交互后页面无未捕获错误', async () => {
    const app = await getApp();
    const errors = filteredPageErrors(app);
    if (errors.length) {
      throw new Error(`交互过程中出现 ${errors.length} 个未捕获错误：\n${errors.map((e) => (e && (e.stack || e.message)) || e).join('\n')}`);
    }
    // 关键：Bridge 仍处于真实模式，没有被 mock 兜底
    equal(app.win.Bridge.__isMock, false);
  });
}
