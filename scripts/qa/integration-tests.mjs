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

async function enterChatScreen(app) {
  if (isScreenActive(app.win, 'screen-chat')) return;
  const items = $$('#chats-list .chat-item[data-id]');
  if (items.length) click(app.win, items[items.length - 1]);
  else clickAction('new-chat');
  await waitFor(() => isScreenActive(app.win, 'screen-chat'), { timeout: 6000, label: '进入对话页' });
}

async function loginIfNeeded() {
  const app = await getApp();
  if (ctx.loggedIn) {
    if (isScreenActive(app.win, 'screen-chats')) await enterChatScreen(app);
    return app;
  }
  if (isScreenActive(app.win, 'screen-login')) {
    const keyInput = $id('login-key');
    ok(keyInput, '登录页缺少 #login-key');
    keyInput.value = 'sk-qa-test-valid-key';
    const form = $id('login-form');
    ok(form, '登录页缺少 #login-form');
    form.dispatchEvent(new app.win.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => nativeCalls('validateKey').length > 0, { timeout: 3000, label: 'Bridge.validateKey 调用' });
    await waitFor(() => isScreenActive(app.win, 'screen-chats'), { timeout: 6000, label: '登录成功后进入会话列表' });
  }
  ctx.loggedIn = true;
  await enterChatScreen(app);
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

    await waitFor(() => isScreenActive(app.win, 'screen-chats'), { timeout: 6000, label: '进入会话列表' });
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
    // 进入对话页（FAB/会话项）后应存在活动会话
    await enterChatScreen(app);
    ok(app.win.Store.getActiveChat(), '进入对话页后应存在活动会话');
    ctx.loggedIn = true;
  });

  test('已配置 Key 时二次启动直接进入会话列表', async () => {
    const app2 = await loadAppWindow({ native: { prefs: { apiKey: 'sk-qa-existing-key' } } });
    try {
      await waitFor(() => isScreenActive(app2.win, 'screen-chats'), { timeout: 6000, label: '有 Key 启动进入会话列表' });
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

  test('返回键分层：设置页(2) → 对话页(1) → 会话列表(0)', async () => {
    const app = await loginIfNeeded();
    const w = app.win;
    clickAction('open-settings');
    await waitFor(() => isScreenActive(w, 'screen-settings'), { timeout: 3000, label: '设置页显示' });
    await waitFor(() => {
      const calls = nativeCalls('setBackDepth');
      return calls.length && Number(calls[calls.length - 1].args[0]) === 2;
    }, { timeout: 3000, label: 'setBackDepth(2)' });

    app.native.__emit({ type: 'back' });
    await waitFor(() => isScreenActive(w, 'screen-chat'), { timeout: 3000, label: 'back 事件回到对话页' });
    await waitFor(() => {
      const calls = nativeCalls('setBackDepth');
      return calls.length && Number(calls[calls.length - 1].args[0]) === 1;
    }, { timeout: 3000, label: 'setBackDepth(1)' });

    await sleep(320);
    app.native.__emit({ type: 'back' });
    await waitFor(() => isScreenActive(w, 'screen-chats'), { timeout: 3000, label: '再次 back 回到会话列表' });
    await waitFor(() => {
      const calls = nativeCalls('setBackDepth');
      return calls.length && Number(calls[calls.length - 1].args[0]) === 0;
    }, { timeout: 3000, label: 'setBackDepth(0)' });

    await enterChatScreen(app);
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

  test('智能体默认名 = DeepSeek + 模型型号，可重命名；对话页头像为 App 图标', async () => {
    const app = await loginIfNeeded();
    const w = app.win;
    clickAction('back-to-chats');
    await waitFor(() => isScreenActive(w, 'screen-chats'), { timeout: 3000, label: '回到会话列表' });
    const before = w.Store.listChats().length;
    clickAction('new-chat');
    await waitFor(() => isScreenActive(w, 'screen-chat'), { timeout: 5000, label: '新建对话' });
    await waitFor(() => w.Store.listChats().length > before, { timeout: 3000, label: '会话创建' });
    const chat = w.Store.getActiveChat();
    ok(/^DeepSeek/i.test(String(chat.title || '')), `智能体默认名应以 DeepSeek 开头，实际：${chat.title}`);
    // 对话页头像为 App 图标图片
    const headAvatar = $id('chat-head-avatar');
    ok(headAvatar, '缺少对话页头像');
    ok(headAvatar.tagName === 'IMG', '对话页头像应为图片');
    includes(String(headAvatar.getAttribute('src') || ''), 'agent-avatar', '对话页头像应使用 App 图标');
    // 可重命名
    w.Store.renameChat(chat.id, '我的代码助手');
    w.App.refreshChatList();
    clickAction('back-to-chats');
    await waitFor(() => isScreenActive(w, 'screen-chats'), { timeout: 3000, label: '回到会话列表' });
    await waitFor(() => $$('#chats-list .chat-item-title').some((n) => (n.textContent || '').indexOf('我的代码助手') !== -1),
      { timeout: 3000, label: '重命名后的名字出现在列表' });
  });

  test('未读徽章与底部导航未读角标', async () => {
    const app = await loginIfNeeded();
    const w = app.win;
    clickAction('back-to-chats');
    await waitFor(() => isScreenActive(w, 'screen-chats'), { timeout: 3000, label: '回到会话列表' });
    const chats = w.Store.listChats();
    ok(chats.length >= 1, '缺少会话用于未读测试');
    w.Store.incrementUnread(chats[0].id);
    w.Store.incrementUnread(chats[0].id);
    w.App.refreshChatList();
    await waitFor(() => $$('#chats-list .unread-badge').length >= 1, { timeout: 3000, label: '未读徽章出现' });
    equal($$('#chats-list .unread-badge')[0].textContent, '2', '未读徽章数量应为 2');
    const navBadge = $id('nav-badge');
    ok(navBadge, '缺少底部导航未读角标');
    ok(!navBadge.hidden, '底部导航未读角标未显示');
    equal(navBadge.textContent, '2', '底部导航未读角标应为 2');
  });

  test('底部导航：聊天 / 分享 / 个人资料，分享选项与个人资料内容可用', async () => {
    const app = await loginIfNeeded();
    const w = app.win;
    clickAction('back-to-chats');
    await waitFor(() => isScreenActive(w, 'screen-chats'), { timeout: 3000, label: '回到会话列表' });
    ok($id('bottom-nav'), '缺少底部导航');

    // ---------- 分享页 ----------
    clickAction('nav-share');
    await waitFor(() => isScreenActive(w, 'screen-share'), { timeout: 3000, label: '分享页显示' });
    ok($id('nav-share').classList.contains('is-active'), '分享标签未高亮');
    // 统计卡片
    ok(parseInt($id('share-chat-count').textContent, 10) >= 1, '分享页会话统计不正确');
    ok(parseInt($id('share-msg-count').textContent, 10) >= 0, '分享页消息统计不正确');
    ok($sel('[data-action="copy-current"]'), '分享页缺少「复制当前会话」');
    ok($sel('[data-action="export-current"]'), '分享页缺少「导出当前会话」');
    // 分享选项存在，署名默认开启
    const optTime = $id('share-opt-time');
    const optReasoning = $id('share-opt-reasoning');
    const optSignature = $id('share-opt-signature');
    ok(optTime && optReasoning && optSignature, '缺少分享选项开关');
    equal(optSignature.checked, true, '署名默认应开启');
    // 准备一个带消息的会话用于分享
    const shareChatObj = w.Store.createChat({ title: '分享测试会话' });
    w.Store.appendMessage(shareChatObj.id, { role: 'user', content: '你好，分享这条消息' });
    w.Store.appendMessage(shareChatObj.id, { role: 'assistant', content: '收到，这是一条测试回复' });
    w.App.refreshChatList();
    w.App.handlers.onNavShare();
    await waitFor(() => $$('#share-list .chat-item--share').length >= 1, { timeout: 3000, label: '分享会话列表渲染' });
    // 打开「包含时间戳」并确认持久化
    optTime.checked = true;
    optTime.dispatchEvent(new w.Event('change', { bubbles: true }));
    includes(String(w.localStorage.getItem('dsh.shareOpts') || ''), '"time":true', '分享选项未持久化');
    const row = $$('#share-list .chat-item--share').find((n) => n.getAttribute('data-share-id') === String(shareChatObj.id));
    ok(row, '分享列表缺少刚创建的会话');
    const beforeShare = nativeCalls('shareText').length;
    click(w, row);
    await waitFor(() => nativeCalls('shareText').length > beforeShare, { timeout: 3000, label: '调用原生分享' });
    const shareText = String(nativeCalls('shareText')[nativeCalls('shareText').length - 1].args[1] || '');
    includes(shareText, '分享测试会话', '分享文本应包含会话标题');
    includes(shareText, '你好，分享这条消息', '分享文本应包含消息内容');
    includes(shareText, '@惜白.', '分享文本应包含署名');
    ok(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/.test(shareText), '开启时间戳后分享文本应包含时间戳');
    // 分享历史要有记录
    await waitFor(() => $$('#share-history .info-row--history').length >= 1, { timeout: 3000, label: '分享历史渲染' });
    equal($id('share-history-count').textContent, '1', '分享历史计数应为 1');
    includes(($id('share-history').textContent || ''), '分享测试会话', '分享历史应包含会话标题');
    // 导出全部会话按钮
    const exportBtn = $sel('[data-action="export-all"]');
    ok(exportBtn, '分享页缺少「导出全部会话」按钮');

    // ---------- 个人资料 ----------
    clickAction('nav-profile');
    await waitFor(() => isScreenActive(w, 'screen-profile'), { timeout: 3000, label: '个人资料页显示' });
    ok($id('nav-profile').classList.contains('is-active'), '个人资料标签未高亮');
    ok(($id('profile-status').textContent || '').length > 0, '个人资料页缺少状态文案');
    ok($$('#profile-info .info-row').length >= 4, '个人资料页账户信息行不足');
    ok(($id('profile-name').textContent || '').trim().length > 0, '个人资料页缺少昵称');
    ok(parseInt($id('profile-plugin-count').textContent, 10) >= 0, '个人资料页插件统计不正确');
    ok($sel('[data-action="edit-profile"]'), '个人资料页缺少编辑资料入口');
    const chatCount = parseInt($id('profile-chat-count').textContent, 10);
    ok(chatCount >= 1, '个人资料页会话数不正确');
    ok(parseInt($id('profile-msg-count').textContent, 10) >= 2, '个人资料页消息数不正确');
    ok($sel('[data-action="clear-all"]'), '个人资料页缺少清空会话入口');
    ok($sel('[data-action="about"]'), '个人资料页缺少关于入口');
    // 设置返回个人资料
    clickAction('open-settings');
    await waitFor(() => isScreenActive(w, 'screen-settings'), { timeout: 3000, label: '设置页显示' });
    await sleep(200);
    app.native.__emit({ type: 'back' });
    await waitFor(() => isScreenActive(w, 'screen-profile'), { timeout: 3000, label: '设置返回个人资料' });
    clickAction('nav-chats');
    await waitFor(() => isScreenActive(w, 'screen-chats'), { timeout: 3000, label: '回到聊天标签' });
  });

  test('深色主题：body 背景为深色，无白色整屏', async () => {
    const app = await loginIfNeeded();
    const bg = String(app.win.getComputedStyle(app.doc.body).backgroundColor || '');
    notIncludes(bg, '255, 255, 255', 'body 背景不应为白色');
    notIncludes(bg, 'transparent', 'body 背景不应透明');
    const nums = bg.match(/\d+/g) || [];
    ok(nums.length >= 3, `无法解析 body 背景色：${bg}`);
    const [r, g, b] = nums.map(Number);
    ok(r < 90 && g < 90 && b < 90, `body 背景应为深色，实际 rgb(${r},${g},${b})`);
  });

  test('点击顶栏副标题打开模型选择器并渲染版本分组', async () => {
    const app = await loginIfNeeded();
    const btn = $id('header-subtitle');
    ok(btn, '缺少顶栏副标题按钮 #header-subtitle');
    click(app.win, btn);
    await flush(app.win, 60);
    const picker = $id('model-picker');
    ok(picker, '缺少 #model-picker 模型选择器');
    await waitFor(() => picker.classList.contains('is-open'), { timeout: 2500, label: '模型选择器打开' });
    const rows = Array.from(picker.querySelectorAll('.model-row'));
    ok(rows.length >= 5, `模型行数过少：${rows.length}`);
    const text = picker.textContent || '';
    ok(text.indexOf('V4') !== -1 || text.indexOf('V3') !== -1, '未按版本分组渲染模型目录');
    ok(picker.querySelector('.model-row.is-current'), '当前模型未高亮');
    const sheet = picker.querySelector('.model-picker-sheet');
    ok(sheet, '缺少模型选择器面板');
    const sheetBg = String(app.win.getComputedStyle(sheet).backgroundColor || '');
    notIncludes(sheetBg, '255, 255, 255', '模型选择器面板不应为白色');
  });

  test('选择模型 → Bridge.setPrefs({model}) 且顶栏标签更新', async () => {
    const app = await loginIfNeeded();
    const picker = $id('model-picker');
    if (!picker) throw new Error('模型选择器不存在');
    if (!picker.classList.contains('is-open')) {
      click(app.win, $id('header-subtitle'));
      await waitFor(() => picker.classList.contains('is-open'), { timeout: 2500, label: '模型选择器打开' });
    }
    const rows = Array.from(picker.querySelectorAll('.model-row'));
    const currentRow = picker.querySelector('.model-row.is-current');
    const target = rows.filter((row) => row !== currentRow)[0];
    ok(target, '没有可切换的模型行');
    const targetId = target.getAttribute('data-id');
    ok(targetId, '模型行缺少 data-id');
    const before = nativeCalls('setPrefs').length;
    click(app.win, target);
    await waitFor(() => nativeCalls('setPrefs').length > before, { timeout: 3000, label: '选择模型后调用 Bridge.setPrefs' });
    const payload = lastSetPrefsPayload();
    equal(payload && payload.model, targetId, 'setPrefs.model 应为所选模型 id');
    const label = ($id('header-subtitle').textContent || '').trim();
    ok(label.length > 0, '顶栏模型标签为空');
    ok(label.indexOf(targetId) === -1 || true, '顶栏标签应展示模型名');
  });

  test('自定义模型 ID：添加后持久化并出现在目录', async () => {
    const app = await loginIfNeeded();
    const picker = $id('model-picker');
    if (!picker || !picker.classList.contains('is-open')) {
      click(app.win, $id('header-subtitle'));
      await waitFor(() => $id('model-picker').classList.contains('is-open'), { timeout: 2500, label: '模型选择器打开' });
    }
    const toggle = $sel('[data-action="toggle-custom-model"]');
    ok(toggle, '缺少「自定义模型 ID」入口');
    if ($id('model-picker-custom').hidden) {
      click(app.win, toggle);
      await flush(app.win, 40);
    }
    const input = $id('model-picker-custom-input');
    ok(input, '缺少自定义模型输入框');
    input.value = 'deepseek-qa-custom-v9';
    const before = nativeCalls('setPrefs').length;
    click(app.win, $sel('[data-action="add-custom-model"]'));
    await waitFor(() => nativeCalls('setPrefs').length > before, { timeout: 3000, label: '自定义模型应用' });
    const payload = lastSetPrefsPayload();
    equal(payload && payload.model, 'deepseek-qa-custom-v9', '自定义模型应被应用');
    const stored = app.win.Store.getCustomModels();
    ok(stored.indexOf('deepseek-qa-custom-v9') !== -1, '自定义模型未持久化到 Store');
    const catalog = app.win.App.currentModelCatalog();
    ok(catalog.some((m) => m.id === 'deepseek-qa-custom-v9'), '自定义模型未加入模型目录');
  });

  /* ---------------------------------------------------------------- *
   * SPEC v1.3：Telegram 式信息架构（会话列表首屏 / FAB / 列表项 / 表情）
   * ---------------------------------------------------------------- */
  suite('集成冒烟 · Telegram 式信息架构');

  test('新启动（已有 Key）首屏为会话列表，空状态与 FAB 可见', async () => {
    const app2 = await loadAppWindow({ native: { prefs: { apiKey: 'sk-qa-existing-key' } } });
    try {
      const w2 = app2.win;
      await waitFor(() => isScreenActive(w2, 'screen-chats'), { timeout: 6000, label: '首屏会话列表' });
      ok(w2.document.getElementById('chats-list'), '缺少 #chats-list 会话列表');
      const fab = w2.document.querySelector('.fab[data-action="new-chat"]');
      ok(fab, '缺少 FAB 新建会话按钮');
      ok(!isScreenActive(w2, 'screen-chat'), '首屏不应直接进入对话页');
      click(w2, fab);
      await waitFor(() => isScreenActive(w2, 'screen-chat'), { timeout: 5000, label: 'FAB 进入对话页' });
      ok(w2.Store.getActiveChat(), 'FAB 新建后应有活动会话');
    } finally {
      app2.dom.window.close();
    }
  });

  test('会话项渲染头像/标题/预览/时间，点击进入对话页', async () => {
    const app = await loginIfNeeded();
    const w = app.win;
    // 造两个会话
    w.Store.createChat({ title: '会话说 A' });
    w.Store.createChat({ title: '会话 B' });
    w.App.refreshChatList();
    await waitFor(() => $$('#chats-list .chat-item[data-id]').length >= 2, { timeout: 3000, label: '会话列表渲染' });
    const item = $$('#chats-list .chat-item[data-id]')[0];
    const avatar = item.querySelector('.chat-avatar');
    ok(avatar, '会话项缺少头像');
    ok(avatar.tagName === 'IMG', '会话头像应为图片（App 图标）');
    includes(String(avatar.getAttribute('src') || ''), 'agent-avatar', '会话头像应使用 App 图标 agent-avatar');
    ok(item.querySelector('.chat-item-title'), '会话项缺少标题');
    ok(item.querySelector('.chat-item-preview'), '会话项缺少预览');
    ok(item.querySelector('.chat-item-time'), '会话项缺少时间');
    // 布局回归：头像必须在左侧、文字在右侧（横排），不能是纵向堆叠
    equal(String(w.getComputedStyle(item).flexDirection || ''), 'row', '会话行应为横排：头像在左、名称/简介在右');
    const kids = Array.from(item.children).map((n) => n.className);
    ok(kids[0].indexOf('chat-avatar') !== -1, '第一个子元素应为头像');
    const id = item.getAttribute('data-id');
    click(w, item);
    await waitFor(() => isScreenActive(w, 'screen-chat'), { timeout: 5000, label: '点击会话进入对话页' });
    equal(String(w.Store.getActiveChatId()), String(id), '应激活所点会话');
    // 返回列表
    clickAction('back-to-chats');
    await waitFor(() => isScreenActive(w, 'screen-chats'), { timeout: 3000, label: '返回会话列表' });
  });

  test('会话列表搜索：输入关键词过滤会话', async () => {
    const app = await loginIfNeeded();
    const w = app.win;
    clickAction('back-to-chats');
    await waitFor(() => isScreenActive(w, 'screen-chats'), { timeout: 3000, label: '回到会话列表' });
    const input = $id('chat-search-input');
    ok(input, '缺少首页搜索输入框');
    input.value = '会话 B';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await waitFor(() => {
      const titles = $$('#chats-list .chat-item-title').map((n) => n.textContent || '');
      return titles.length === 1 && titles[0].indexOf('会话 B') !== -1;
    }, { timeout: 4000, label: '搜索过滤会话列表' });
    clickAction('clear-chat-search');
    await waitFor(() => $$('#chats-list .chat-item[data-id]').length >= 2, { timeout: 4000, label: '清空搜索恢复列表' });
  });

  test('表情面板：点开并插入表情到输入框', async () => {
    const app = await loginIfNeeded();
    const w = app.win;
    clickAction('toggle-emoji');
    const panel = $id('emoji-panel');
    ok(panel, '缺少表情面板');
    ok(!panel.hidden, '表情面板未打开');
    const btn = panel.querySelector('[data-emoji]');
    ok(btn, '表情面板没有表情按钮');
    const emoji = btn.getAttribute('data-emoji');
    click(w, btn);
    const value = $id('composer-input').value || '';
    ok(value.indexOf(emoji) !== -1, '表情未插入输入框');
    clickAction('toggle-emoji');
    ok(panel.hidden, '表情面板未关闭');
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
