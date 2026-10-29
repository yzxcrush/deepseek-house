/*!
 * DeepSeek House — app.js
 * 业务控制器：启动流程、登录校验、会话 CRUD、发送/流式渲染/停止/重试、
 * 标题自动生成、推理展示、插件工具调用循环（最多 3 轮）、斜杠命令、
 * 设置保存、插件页、导出、返回键分层、复制。
 *
 * 约束：只通过 window.UI 改 DOM；不操作 index.html 中的节点。
 * 依赖：window.Util / Bridge / Store / Markdown / Api / DSPlugins / UI
 */
(function (global) {
  'use strict';

  var MODELS = [
    { id: 'deepseek-chat', name: 'DeepSeek-V3.2 通用' },
    { id: 'deepseek-reasoner', name: 'DeepSeek-R1 推理' }
  ];
  var MAX_INPUT = 8000;
  var MAX_TOOL_ROUNDS = 3;
  var FLUSH_INTERVAL = 50;
  var TOAST_THROTTLE = 700;

  var state = {
    started: false,
    ready: false,
    busy: false,
    loginBusy: false,
    apiKey: '',
    prefs: {},
    requestId: null,
    requestChatId: null,
    assistantMsgId: null,
    buf: { content: '', reasoning: '', toolCalls: [] },
    toolRounds: 0,
    stopping: false,
    lastSentText: '',
    lastSentAt: 0,
    flushTimer: null,
    lastFlushAt: 0,
    lastToastAt: 0,
    backDepth: 0,
    nav: { screen: 'login', drawerOpen: false },
    pluginsBound: false
  };

  var App = { handlers: null, MODELS: MODELS, MAX_TOOL_ROUNDS: MAX_TOOL_ROUNDS };

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  function warn() {
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn.apply(console, ['[App]'].concat(Array.prototype.slice.call(arguments)));
      }
    } catch (e) { /* ignore */ }
  }

  function errText(err) {
    if (err === null || err === undefined) return '未知错误';
    if (typeof err === 'string') return err;
    if (err.message) return String(err.message);
    return String(err);
  }

  function safe(fn, name) {
    return function () {
      try {
        return fn.apply(null, arguments);
      } catch (e) {
        warn((name || 'handler') + ' 异常：' + errText(e));
        return undefined;
      }
    };
  }

  function getUI() {
    return global.UI || null;
  }

  function ui(name) {
    var U = getUI();
    if (!U || typeof U[name] !== 'function') return undefined;
    var args = Array.prototype.slice.call(arguments, 1);
    try {
      return U[name].apply(U, args);
    } catch (e) {
      warn('UI.' + name + ' 异常：' + errText(e));
      return undefined;
    }
  }

  function toast(msg, force) {
    var text = String(msg === null || msg === undefined ? '' : msg);
    if (!text) return;
    var t = Date.now();
    if (!force && t - state.lastToastAt < TOAST_THROTTLE) return;
    state.lastToastAt = t;
    ui('toast', text);
  }

  function normalizeUrl(url) {
    var s = String(url === null || url === undefined ? '' : url).replace(/^\s+|\s+$/g, '');
    if (!s) return '';
    try {
      if (global.Util && typeof global.Util.normalizeBaseUrl === 'function') return global.Util.normalizeBaseUrl(s);
    } catch (e) { /* ignore */ }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    if (!/^https?:\/\//i.test(s)) return '';
    return s.replace(/\/+$/, '');
  }

  function clampNum(n, min, max) {
    n = Number(n);
    if (!isFinite(n)) return min;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function safeStringify(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }

  function dateStamp() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function safeFileName(name) {
    var s = String(name === null || name === undefined ? '对话' : name)
      .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^\s+|\s+$/g, '');
    if (!s) s = '对话';
    return s.slice(0, 40);
  }

  function confirmAsync(title, text) {
    var U = getUI();
    if (U && typeof U.confirm === 'function') {
      try {
        var result = U.confirm(title, text);
        return Promise.resolve(result).then(function (v) { return !!v; }, function () { return false; });
      } catch (e) { warn('UI.confirm 异常：' + errText(e)); }
    }
    if (typeof global.confirm === 'function') {
      try { return Promise.resolve(!!global.confirm(title + '\n' + text)); } catch (e2) { /* ignore */ }
    }
    return Promise.resolve(true);
  }

  function promptAsync(title, value, placeholder) {
    var U = getUI();
    if (U && typeof U.prompt === 'function') {
      try { return Promise.resolve(U.prompt(title, value, placeholder)); } catch (e) { /* ignore */ }
    }
    if (typeof global.prompt === 'function') {
      try { return Promise.resolve(global.prompt(title, value)); } catch (e2) { /* ignore */ }
    }
    return Promise.resolve(null);
  }

  /* ------------------------------------------------------------------ *
   * prefs
   * ------------------------------------------------------------------ */

  function defaultPrefs() {
    try { return Store.defaultPrefs(); } catch (e) {
      return {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        temperature: 1.0,
        maxTokens: 4096,
        stream: true,
        theme: 'dark',
        systemPrompt: ''
      };
    }
  }

  function readNativePrefs() {
    try {
      var p = global.Bridge && typeof global.Bridge.prefs === 'function' ? global.Bridge.prefs() : null;
      return p && typeof p === 'object' ? p : {};
    } catch (e) {
      warn('读取原生 prefs 失败：' + errText(e));
      return {};
    }
  }

  function mergePrefs(storePrefs, nativePrefs) {
    var out = defaultPrefs();
    var base = storePrefs && typeof storePrefs === 'object' ? storePrefs : {};
    var native = nativePrefs && typeof nativePrefs === 'object' ? nativePrefs : {};
    var keys = Object.keys(base);
    for (var i = 0; i < keys.length; i++) {
      if (base[keys[i]] !== undefined && base[keys[i]] !== null) out[keys[i]] = base[keys[i]];
    }
    var nkeys = ['baseUrl', 'model', 'temperature', 'maxTokens', 'stream', 'theme', 'systemPrompt'];
    for (var j = 0; j < nkeys.length; j++) {
      var k = nkeys[j];
      var v = native[k];
      if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
    out.baseUrl = normalizeUrl(out.baseUrl) || 'https://api.deepseek.com';
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  function boot() {
    if (state.started) return App;
    state.started = true;
    try { Store.load(); } catch (e) { warn('Store.load 失败：' + errText(e)); }
    var nativePrefs = readNativePrefs();
    state.apiKey = nativePrefs.apiKey ? String(nativePrefs.apiKey) : '';
    state.prefs = mergePrefs(Store.getPrefs(), nativePrefs);

    bindBridgeEvents();
    bindPluginFileFallback();

    var handlers = buildHandlers();
    App.handlers = handlers;
    try {
      if (getUI() && typeof getUI().init === 'function') getUI().init(handlers);
    } catch (e2) {
      warn('UI.init 失败：' + errText(e2));
    }

    try { if (global.Bridge && global.Bridge.setStatusBar) global.Bridge.setStatusBar('#17212B', false); } catch (e3) { /* ignore */ }

    state.ready = true;

    if (!state.apiKey) {
      state.nav = { screen: 'login', drawerOpen: false };
      setBackDepth(0);
      ui('showScreen', 'login');
      ui('renderLogin', { hasKey: false, busy: false });
    } else {
      enterChat();
    }

    loadPlugins(false);
    return App;
  }

  function enterChat() {
    state.nav = { screen: 'chat', drawerOpen: false };
    ui('showScreen', 'chat');
    ui('setUser', { name: 'DeepSeek 用户' });
    ui('setModel', state.prefs.model);
    ensureActiveChat();
    refreshChatList();
    renderActiveChat();
    ui('setStreaming', false);
    ui('setComposer', { value: '', busy: false });
    setHeader(null, '');
    setBackDepth(0);
  }

  function ensureActiveChat() {
    var chat = Store.getActiveChat();
    if (chat) return chat;
    var chats = Store.listChats();
    if (chats.length) {
      Store.setActiveChat(chats[0].id);
      return Store.getChat(chats[0].id);
    }
    chat = Store.createChat({ model: state.prefs.model });
    Store.setActiveChat(chat.id);
    return chat;
  }

  function refreshChatList(list) {
    ui('renderChatList', list || Store.listChats(), Store.getActiveChatId());
  }

  function renderActiveChat() {
    var chat = Store.getActiveChat();
    if (!chat) return;
    ui('renderMessages', chat);
    ui('scrollBottom', true);
  }

  function setHeader(chat, subtitle) {
    chat = chat || Store.getActiveChat();
    var title = chat ? chat.title : 'DeepSeek House';
    ui('setHeader', { title: title || '', subtitle: subtitle === undefined ? '' : subtitle });
  }

  function setBackDepth(depth) {
    var n = Math.max(0, parseInt(depth, 10) || 0);
    state.backDepth = n;
    try {
      if (global.Bridge && global.Bridge.setBackDepth) global.Bridge.setBackDepth(n);
    } catch (e) { warn('setBackDepth 失败：' + errText(e)); }
  }

  function navTo(screen) {
    state.nav.screen = screen;
    state.nav.drawerOpen = false;
    if (screen === 'settings' || screen === 'plugins') setBackDepth(1);
    else setBackDepth(0);
  }

  function closeDrawer() {
    var U = getUI();
    if (!U) return;
    try {
      if (typeof U.closeDrawer === 'function') { U.closeDrawer(); return; }
      if (typeof U.setDrawerOpen === 'function') { U.setDrawerOpen(false); return; }
    } catch (e) { /* ignore */ }
  }

  function onBack() {
    var screen = state.nav.screen;
    if (screen !== 'chat') {
      closeDrawer();
      ui('showScreen', 'chat');
      navTo('chat');
      var chat = Store.getActiveChat();
      if (chat) {
        setHeader(chat, '');
        ui('renderMessages', chat);
        ui('scrollBottom', true);
      }
      return;
    }
    closeDrawer();
    setBackDepth(0);
  }

  /* ------------------------------------------------------------------ *
   * Bridge 事件
   * ------------------------------------------------------------------ */

  function bindBridgeEvents() {
    var B = global.Bridge;
    if (!B || typeof B.onEvent !== 'function') return;
    B.onEvent('saved', function (evt) {
      if (evt && evt.ok) toast('已导出：' + (evt.name || '文件'), true);
      else if (evt && (evt.error || evt.ok === false)) toast('导出失败', true);
    });
    B.onEvent('back', function () { onBack(); });
  }

  function bindPluginFileFallback() {
    var B = global.Bridge;
    var P = global.DSPlugins;
    if (P && typeof P.installFromFile === 'function') return;
    if (!B || typeof B.onEvent !== 'function') return;
    B.onEvent('plugin-file', function (evt) {
      if (!evt || !evt.content) return;
      installPlugin(evt.content);
    });
  }

  /* ------------------------------------------------------------------ *
   * UI 回调
   * ------------------------------------------------------------------ */

  function buildHandlers() {
    return {
      onSend: safe(function (text) { handleSend(text); }, 'onSend'),
      onStop: safe(function () { stopGeneration(); }, 'onStop'),
      onNewChat: safe(function () { newChat(); }, 'onNewChat'),
      onSelectChat: safe(function (id) { selectChat(id); }, 'onSelectChat'),
      onDeleteChat: safe(function (id) { deleteChat(id, true); }, 'onDeleteChat'),
      onRenameChat: safe(function (id, title) { renameChat(id, title); }, 'onRenameChat'),
      onRetry: safe(function (msgId) { retryMessage(msgId); return true; }, 'onRetry'),
      onRegenerate: safe(function (msgId) { retryMessage(msgId); return true; }, 'onRegenerate'),
      onOpenSettings: safe(function () { openSettings(); }, 'onOpenSettings'),
      onOpenPlugins: safe(function () { openPlugins(); }, 'onOpenPlugins'),
      onSaveSettings: safe(function (patch) { return saveSettings(patch) !== false; }, 'onSaveSettings'),
      onLogin: safe(function (data) { login(data); return true; }, 'onLogin'),
      onLogout: safe(function () { logout(true); }, 'onLogout'),
      onPluginToggle: safe(function (id, enabled) { togglePlugin(id, enabled); }, 'onPluginToggle'),
      onPluginInstall: safe(function (code) { installPlugin(code); return true; }, 'onPluginInstall'),
      onPluginInstallFile: safe(function () { installPluginFile(); return true; }, 'onPluginInstallFile'),
      onPluginRemove: safe(function (id) { removePlugin(id, true); }, 'onPluginRemove'),
      onPluginRefresh: safe(function () { refreshPlugins(); }, 'onPluginRefresh'),
      onExportChat: safe(function (id) { exportChat(id); }, 'onExportChat'),
      onSearch: safe(function (q) { search(q); }, 'onSearch'),
      onCommand: safe(function (text) { handleCommand(text); }, 'onCommand'),
      onBack: safe(function () { onBack(); return true; }, 'onBack'),
      onCopy: safe(function (text) { copyText(text); return true; }, 'onCopy'),
      onDeleteMessage: safe(function (msgId) { deleteMessage(msgId); }, 'onDeleteMessage'),
      onPasteApiKey: safe(function () {
        try { return global.Bridge && global.Bridge.getClipboard ? String(global.Bridge.getClipboard() || '') : ''; }
        catch (e) { return ''; }
      }, 'onPasteApiKey'),
      onOpenSignup: safe(function () {
        if (global.Bridge && global.Bridge.openUrl) global.Bridge.openUrl('https://platform.deepseek.com/api_keys');
        return true;
      }, 'onOpenSignup'),
      onOpenUrl: safe(function (url) {
        if (global.Bridge && global.Bridge.openUrl) global.Bridge.openUrl(String(url || ''));
      }, 'onOpenUrl'),
      onPinChat: safe(function (id, pinned) {
        var chat = Store.getChat(id);
        if (!chat) return;
        var next = pinned === undefined ? !chat.pinned : !!pinned;
        Store.updateChat(chat.id, { pinned: next });
        refreshChatList();
        toast(next ? '已置顶' : '已取消置顶');
      }, 'onPinChat'),
      onTogglePin: safe(function (id, pinned) {
        var chat = Store.getChat(id);
        if (!chat) return;
        var next = pinned === undefined ? !chat.pinned : !!pinned;
        Store.updateChat(chat.id, { pinned: next });
        refreshChatList();
        toast(next ? '已置顶' : '已取消置顶');
      }, 'onTogglePin')
    };
  }

  /* ------------------------------------------------------------------ *
   * 登录 / 退出
   * ------------------------------------------------------------------ */

  function login(data) {
    data = data || {};
    if (state.loginBusy) return;
    var key = String(data.apiKey === null || data.apiKey === undefined ? '' : data.apiKey).replace(/^\s+|\s+$/g, '');
    var baseUrl = normalizeUrl(data.baseUrl || state.prefs.baseUrl || 'https://api.deepseek.com');
    if (!key) {
      ui('renderLogin', { hasKey: false, busy: false, error: '请输入 API Key' });
      return;
    }
    if (!baseUrl) {
      ui('renderLogin', { hasKey: false, busy: false, error: 'Base URL 格式不正确' });
      return;
    }
    state.loginBusy = true;
    ui('renderLogin', { hasKey: false, busy: true, error: '' });
    try {
      if (global.Bridge && global.Bridge.setPrefs) global.Bridge.setPrefs({ apiKey: key, baseUrl: baseUrl });
    } catch (e) { warn('写入 prefs 失败：' + errText(e)); }

    Api.verifyKey({ timeout: 20000 }).then(function (res) {
      state.loginBusy = false;
      res = res || {};
      if (res.ok) {
        state.apiKey = key;
        Store.setPrefs({ baseUrl: baseUrl });
        try { if (global.Bridge && global.Bridge.setPrefs) global.Bridge.setPrefs({ baseUrl: baseUrl }); } catch (e2) { /* ignore */ }
        state.prefs = mergePrefs(Store.getPrefs(), readNativePrefs());
        state.prefs.baseUrl = baseUrl;
        ui('renderLogin', { hasKey: true, busy: false, error: '' });
        enterChat();
        toast('登录成功', true);
        return;
      }
      var status = Number(res.httpStatus) || 0;
      if (status === 401 && !res.timeout) {
        try { if (global.Bridge && global.Bridge.setPrefs) global.Bridge.setPrefs({ apiKey: '' }); } catch (e3) { /* ignore */ }
        state.apiKey = '';
      }
      var text = res.message || '验证失败，请检查 API Key 或网络连接';
      if (status === 401) text = 'API Key 无效，请检查后重试';
      ui('renderLogin', { hasKey: false, busy: false, error: text });
    }).catch(function (e) {
      state.loginBusy = false;
      ui('renderLogin', { hasKey: false, busy: false, error: '验证失败：' + errText(e) });
    });
  }

  function logout(skipConfirm) {
    var doLogout = function () {
      if (state.busy) stopGeneration();
      try { if (global.Bridge && global.Bridge.setPrefs) global.Bridge.setPrefs({ apiKey: '' }); } catch (e) { /* ignore */ }
      state.apiKey = '';
      state.nav = { screen: 'login', drawerOpen: false };
      ui('showScreen', 'login');
      ui('renderLogin', { hasKey: false, busy: false });
      setBackDepth(0);
    };
    if (skipConfirm) { doLogout(); return; }
    confirmAsync('退出登录', '将清除本机保存的 API Key（会话记录保留）。').then(function (ok) {
      if (ok) doLogout();
    });
  }

  /* ------------------------------------------------------------------ *
   * 发送
   * ------------------------------------------------------------------ */

  function handleSend(text) {
    if (state.loginBusy) return;
    if (state.busy) { toast('正在生成回复，请先停止'); return; }
    var raw = String(text === null || text === undefined ? '' : text);
    var trimmed = raw.replace(/^\s+|\s+$/g, '');
    if (!trimmed) return;
    if (trimmed.charAt(0) === '/') { handleCommand(trimmed); return; }
    if (trimmed.length > MAX_INPUT) { toast('消息太长，最多 ' + MAX_INPUT + ' 字'); return; }
    var t = Date.now();
    if (trimmed === state.lastSentText && t - state.lastSentAt < 800) return;
    state.lastSentText = trimmed;
    state.lastSentAt = t;

    var chat = ensureActiveChat();
    if (!chat) return;
    var userMsg = Store.appendMessage(chat.id, { role: 'user', content: trimmed });
    if (!userMsg) return;
    state.toolRounds = 0;
    resetBuffer();
    ui('appendMessage', userMsg);
    ui('setComposer', { value: '', busy: true });
    ui('scrollBottom', true);
    refreshChatList();
    maybeAutoTitle(chat, trimmed);
    startAssistantRound(chat.id);
  }

  function startAssistantRound(chatId) {
    var chat = Store.getChat(chatId);
    if (!chat) { finishBusy(); return; }
    var aMsg = Store.appendMessage(chatId, { role: 'assistant', content: '', reasoning: '', streaming: true });
    if (!aMsg) { finishBusy(); return; }
    resetBuffer();
    state.busy = true;
    state.stopping = false;
    state.assistantMsgId = aMsg.id;
    state.requestChatId = chatId;
    ui('appendMessage', aMsg);
    ui('setStreaming', true);
    ui('setComposer', { busy: true });
    setHeader(chat, '正在输入…');
    ui('scrollBottom', true);

    var messages = requestHistory(chatId, aMsg.id);
    var tools = getToolSchemas();
    var requestId = Api.send({
      chat: chat,
      messages: messages,
      tools: tools,
      prefs: state.prefs,
      onChunk: onChunk,
      onDone: onDone,
      onError: onError
    });
    state.requestId = requestId;
  }

  function requestHistory(chatId, excludeId) {
    var chat = Store.getChat(chatId);
    if (!chat) return [];
    return chat.messages.filter(function (m) { return m.id !== excludeId; });
  }

  function resetBuffer() {
    state.buf = { content: '', reasoning: '', toolCalls: [] };
  }

  function onChunk(patch) {
    if (!patch || !state.assistantMsgId) return;
    if (patch.delta) state.buf.content += patch.delta;
    if (patch.reasoning) state.buf.reasoning += patch.reasoning;
    if (patch.toolCalls && patch.toolCalls.length) state.buf.toolCalls = patch.toolCalls;
    scheduleFlush();
  }

  function scheduleFlush() {
    if (state.flushTimer) return;
    var wait = Math.max(0, FLUSH_INTERVAL - (Date.now() - state.lastFlushAt));
    state.flushTimer = setTimeout(function () {
      state.flushTimer = null;
      var run = function () { doFlush(); };
      if (typeof global.requestAnimationFrame === 'function') {
        try { global.requestAnimationFrame(run); return; } catch (e) { /* ignore */ }
      }
      run();
    }, wait);
  }

  function doFlush() {
    state.lastFlushAt = Date.now();
    if (!state.assistantMsgId) return;
    var patch = {
      content: state.buf.content,
      reasoning: state.buf.reasoning,
      streaming: true
    };
    if (state.buf.toolCalls && state.buf.toolCalls.length) patch.toolCalls = state.buf.toolCalls;
    ui('updateMessage', state.assistantMsgId, patch);
    if (!state.buf.content && state.buf.reasoning) {
      var chat = Store.getChat(state.requestChatId);
      if (chat) setHeader(chat, '思考中…');
    }
    ui('scrollBottom');
  }

  function flushNow() {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    doFlush();
  }

  function onDone(result) {
    result = result || {};
    var chatId = state.requestChatId;
    var aId = state.assistantMsgId;
    if (!chatId || !aId) { finishBusy(); return; }
    flushNow();
    var chat = Store.getChat(chatId);
    if (!chat) { finishBusy(); return; }

    var content = state.buf.content;
    var reasoning = state.buf.reasoning;
    var toolCalls = (result.toolCalls && result.toolCalls.length) ? result.toolCalls : state.buf.toolCalls;
    var finalPatch = {
      content: content,
      reasoning: reasoning,
      streaming: false
    };
    if (result.usage) finalPatch.usage = result.usage;
    if (result.finishReason) finalPatch.finishReason = result.finishReason;
    if (toolCalls && toolCalls.length) finalPatch.toolCalls = toolCalls;
    Store.updateMessage(chatId, aId, finalPatch);
    ui('updateMessage', aId, finalPatch);

    if (toolCalls && toolCalls.length) {
      Store.touchChat(chatId);
      if (state.toolRounds >= MAX_TOOL_ROUNDS) {
        appendNote(chatId, '已达到最大工具调用轮数（' + MAX_TOOL_ROUNDS + '），停止继续调用工具。');
        finishBusy();
        refreshChatList();
        return;
      }
      state.toolRounds++;
      ui('setStreaming', true);
      runToolCalls(chatId, toolCalls);
      return;
    }

    if (!content && !reasoning) {
      Store.updateMessage(chatId, aId, { content: '（未收到回复）' });
      ui('updateMessage', aId, { content: '（未收到回复）' });
    }
    Store.touchChat(chatId);
    finishBusy();
    maybeAutoTitle(chat, null);
    refreshChatList();
  }

  function onError(err) {
    err = err || {};
    var chatId = state.requestChatId;
    var aId = state.assistantMsgId;
    var status = Number(err.httpStatus) || 0;
    var message;
    if (status === 401) message = 'API Key 无效或已过期，请在设置中更新 Key';
    else if (status === 402) message = '账户余额不足，请前往 DeepSeek 开放平台充值';
    else if (status === 403) message = '没有权限访问该接口（403）';
    else if (status === 404) message = '接口不存在（404），请检查 Base URL 是否为 /v1 兼容地址';
    else if (status === 429) message = '请求过于频繁（429），请稍后重试';
    else if (status >= 500) message = '服务暂时不可用（' + status + '），请稍后重试';
    else if (status === 0) message = '网络错误：' + (err.message || '连接失败') + '（请检查网络后重试）';
    else message = (err.message || '请求失败') + '（' + status + '）';

    if (chatId && aId) {
      flushNow();
      var patch = {
        content: state.buf.content || '',
        reasoning: state.buf.reasoning || '',
        streaming: false,
        error: message
      };
      Store.updateMessage(chatId, aId, patch);
      ui('updateMessage', aId, patch);
      Store.touchChat(chatId);
    }
    if (status === 401 && state.apiKey) {
      toast('API Key 无效，请更新设置', true);
      setTimeout(function () { openSettings(); }, 450);
    } else {
      toast(message, true);
    }
    finishBusy();
    refreshChatList();
  }

  function finishBusy() {
    state.busy = false;
    state.stopping = false;
    state.requestId = null;
    state.assistantMsgId = null;
    state.requestChatId = null;
    state.toolRounds = 0;
    resetBuffer();
    ui('setStreaming', false);
    ui('setComposer', { busy: false });
    var chat = Store.getActiveChat();
    setHeader(chat, '');
  }

  function stopGeneration() {
    if (!state.busy) {
      ui('setStreaming', false);
      ui('setComposer', { busy: false });
      return;
    }
    state.stopping = true;
    if (state.requestId && global.Api && typeof global.Api.cancel === 'function') {
      try { global.Api.cancel(state.requestId); } catch (e) { warn('取消请求失败：' + errText(e)); }
    }
    flushNow();
    var chatId = state.requestChatId;
    var aId = state.assistantMsgId;
    if (chatId && aId) {
      var content = state.buf.content;
      var reasoning = state.buf.reasoning;
      if (!content) content = '（已停止生成）';
      var patch = {
        content: content,
        reasoning: reasoning || '',
        streaming: false,
        stopped: true
      };
      Store.updateMessage(chatId, aId, patch);
      ui('updateMessage', aId, patch);
      Store.touchChat(chatId);
      toast('已停止生成', true);
    }
    finishBusy();
    refreshChatList();
  }

  function retryMessage(msgId) {
    if (state.busy) stopGeneration();
    var chat = Store.getChat(state.requestChatId) || Store.getActiveChat();
    if (!chat) return;
    var idx = -1;
    var i;
    if (msgId !== undefined && msgId !== null && msgId !== '') {
      for (i = 0; i < chat.messages.length; i++) {
        if (chat.messages[i].id === String(msgId)) { idx = i; break; }
      }
    }
    if (idx < 0) {
      for (i = chat.messages.length - 1; i >= 0; i--) {
        if (chat.messages[i].role === 'assistant') { idx = i; break; }
      }
    }
    if (idx < 0) { toast('没有可重新生成的消息'); return; }
    var userIdx = -1;
    for (i = idx - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'user') { userIdx = i; break; }
    }
    if (userIdx < 0) { toast('找不到对应的用户消息'); return; }

    Store.truncateMessages(chat.id, userIdx + 1);
    chat = Store.getChat(chat.id) || chat;
    state.toolRounds = 0;
    resetBuffer();
    ui('renderMessages', chat);
    refreshChatList();
    startAssistantRound(chat.id);
  }

  /* ------------------------------------------------------------------ *
   * 工具调用循环
   * ------------------------------------------------------------------ */

  function parseToolArgs(args) {
    if (args && typeof args === 'object') return args;
    var s = String(args === null || args === undefined ? '' : args).replace(/^\s+|\s+$/g, '');
    if (!s) return {};
    try {
      var parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object') return parsed;
      return { value: parsed };
    } catch (e) {
      return { _raw: s };
    }
  }

  function execOneTool(chat, toolCall, ctx, index) {
    return new Promise(function (resolve) {
      var name = toolCall && (toolCall.name || 'unknown') || 'unknown';
      var args = parseToolArgs(toolCall ? toolCall.arguments : '');
      var toolCallId = (toolCall && toolCall.id) || ('call_' + index);
      var resultPromise;
      try {
        if (global.DSPlugins && typeof global.DSPlugins.runTool === 'function') {
          resultPromise = global.DSPlugins.runTool(name, args, ctx);
        } else {
          resultPromise = '插件系统不可用（DSPlugins 未加载）';
        }
      } catch (e) {
        resultPromise = '工具执行失败：' + errText(e);
      }
      Promise.resolve(resultPromise).then(function (result) {
        var content;
        if (typeof result === 'string') content = result;
        else content = safeStringify(result);
        if (!content) content = '（工具未返回内容）';
        var toolMsg = Store.appendMessage(chat.id, {
          role: 'tool',
          content: content,
          toolName: name,
          toolCallId: toolCallId
        });
        if (toolMsg) {
          ui('appendMessage', toolMsg);
          ui('scrollBottom');
        }
        resolve(toolMsg);
      }).catch(function (e2) {
        var content = '工具执行失败：' + errText(e2);
        var toolMsg = Store.appendMessage(chat.id, {
          role: 'tool',
          content: content,
          toolName: name,
          toolCallId: toolCallId
        });
        if (toolMsg) {
          ui('appendMessage', toolMsg);
          ui('scrollBottom');
        }
        resolve(toolMsg);
      });
    });
  }

  function runToolCalls(chatId, toolCalls) {
    var chat = Store.getChat(chatId);
    if (!chat) { finishBusy(); return; }
    var ctx = pluginCtx(chat);
    var jobs = [];
    for (var i = 0; i < toolCalls.length; i++) {
      jobs.push(execOneTool(chat, toolCalls[i], ctx, i));
    }
    Promise.all(jobs).then(function () {
      var latest = Store.getChat(chatId);
      if (!latest) { finishBusy(); return; }
      // 继续请求：历史中已包含 assistant(tool_calls) 与 tool 结果
      startAssistantRound(chatId);
    }).catch(function (e) {
      warn('工具调用循环异常：' + errText(e));
      appendNote(chatId, '工具执行失败：' + errText(e));
      finishBusy();
      refreshChatList();
    });
  }

  function getToolSchemas() {
    try {
      if (global.DSPlugins && typeof global.DSPlugins.toolSchemas === 'function') {
        var tools = global.DSPlugins.toolSchemas();
        return Array.isArray(tools) ? tools : [];
      }
    } catch (e) {
      warn('获取工具列表失败：' + errText(e));
    }
    return [];
  }

  function pluginCtx(chat) {
    var base = {
      settings: {
        get: function (key) { return Store.getPluginSetting('global', key); },
        set: function (key, value) { return Store.setPluginSetting('global', key, value); }
      },
      toast: function (msg) { toast(String(msg)); },
      ui: getUI(),
      http: {
        fetch: function (url, opts) {
          if (global.Api && typeof global.Api.fetchUrl === 'function') return global.Api.fetchUrl(url, opts);
          return Promise.resolve({ ok: false, status: 0, body: '', error: 'http 不可用' });
        }
      },
      chat: chat ? {
        id: chat.id,
        title: chat.title,
        messages: chat.messages,
        systemPrompt: state.prefs.systemPrompt
      } : null,
      addNote: function (text) { if (chat) appendNote(chat.id, text); },
      appendMessage: function (msg) {
        if (!chat) return null;
        var m = Store.appendMessage(chat.id, msg);
        if (m) ui('appendMessage', m);
        return m;
      },
      store: Store
    };
    try {
      if (global.DSPlugins && typeof global.DSPlugins.createContext === 'function') {
        var ctx = global.DSPlugins.createContext(base);
        if (ctx) return ctx;
      }
    } catch (e) {
      warn('DSPlugins.createContext 失败：' + errText(e));
    }
    return base;
  }

  function appendNote(chatId, text) {
    var chat = Store.getChat(chatId) || Store.getActiveChat();
    if (!chat) return null;
    var msg = Store.appendMessage(chat.id, { role: 'note', content: String(text === null || text === undefined ? '' : text) });
    if (msg) {
      ui('appendMessage', msg);
      ui('scrollBottom');
    }
    return msg;
  }

  /* ------------------------------------------------------------------ *
   * 会话操作
   * ------------------------------------------------------------------ */

  function maybeAutoTitle(chat, sourceText) {
    chat = chat || Store.getActiveChat();
    if (!chat) return;
    var title = String(chat.title || '');
    var isDefault = !title || title === '新的对话' || title === '新对话';
    var userCount = 0;
    var i;
    for (i = 0; i < chat.messages.length; i++) {
      if (chat.messages[i].role === 'user') userCount++;
    }
    if (!isDefault && userCount > 1) return;
    var source = sourceText;
    if (!source) {
      for (i = 0; i < chat.messages.length; i++) {
        if (chat.messages[i].role === 'user') { source = chat.messages[i].content; break; }
      }
    }
    if (!source) return;
    var t = String(source)
      .replace(/[#>*_`~\[\]()!]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^\s+|\s+$/g, '');
    if (!t) return;
    if (t.length > 20) t = t.slice(0, 20) + '…';
    Store.renameChat(chat.id, t);
    if (Store.getActiveChatId() === chat.id) {
      ui('setHeader', { title: t, subtitle: '' });
    }
    refreshChatList();
  }

  function newChat() {
    if (state.busy) stopGeneration();
    var active = Store.getActiveChat();
    if (active && active.messages.length === 0 && (!active.title || active.title === '新的对话')) {
      closeDrawer();
      ui('showScreen', 'chat');
      navTo('chat');
      toast('已经是新会话');
      return;
    }
    var chat = Store.createChat({ model: state.prefs.model });
    Store.setActiveChat(chat.id);
    closeDrawer();
    ui('showScreen', 'chat');
    ui('renderMessages', chat);
    ui('setHeader', { title: chat.title, subtitle: '' });
    ui('setStreaming', false);
    ui('setComposer', { value: '', busy: false });
    refreshChatList();
    navTo('chat');
    ui('scrollBottom', true);
  }

  function selectChat(id) {
    if (state.busy) stopGeneration();
    var chat = Store.getChat(id);
    if (!chat) return;
    Store.setActiveChat(chat.id);
    closeDrawer();
    ui('showScreen', 'chat');
    ui('renderMessages', chat);
    ui('setHeader', { title: chat.title, subtitle: '' });
    ui('setStreaming', false);
    ui('setComposer', { value: '', busy: false });
    refreshChatList();
    navTo('chat');
    ui('scrollBottom', true);
  }

  function deleteChat(id, skipConfirm) {
    var chat = Store.getChat(id);
    if (!chat) chat = Store.getActiveChat();
    if (!chat) return;
    var doDelete = function () {
      var wasActive = Store.getActiveChatId() === chat.id;
      Store.deleteChat(chat.id);
      var next = Store.getActiveChat();
      if (!next) {
        next = Store.createChat({ model: state.prefs.model });
        Store.setActiveChat(next.id);
      }
      refreshChatList();
      if (wasActive) {
        ui('renderMessages', next);
        ui('setHeader', { title: next.title, subtitle: '' });
        ui('scrollBottom', true);
      }
      toast('会话已删除');
    };
    if (skipConfirm) { doDelete(); return; }
    confirmAsync('删除会话', '确定删除「' + (chat.title || '该会话') + '」吗？删除后不可恢复。').then(function (ok) {
      if (ok) doDelete();
    });
  }

  function applyRename(chatId, title) {
    var t = String(title === null || title === undefined ? '' : title).replace(/^\s+|\s+$/g, '');
    if (!t) { toast('名称不能为空'); return; }
    var chat = Store.renameChat(chatId, t);
    if (!chat) return;
    refreshChatList();
    if (Store.getActiveChatId() === chat.id) {
      ui('setHeader', { title: chat.title, subtitle: '' });
    }
  }

  function renameChat(id, title) {
    var chat = Store.getChat(id) || Store.getActiveChat();
    if (!chat) return;
    if (title === undefined || title === null) {
      promptAsync('重命名会话', chat.title, '会话名称').then(function (value) {
        if (value === null || value === undefined) return;
        applyRename(chat.id, value);
      });
      return;
    }
    applyRename(chat.id, title);
  }

  function search(q) {
    var query = String(q === null || q === undefined ? '' : q);
    var list = query.replace(/^\s+|\s+$/g, '') ? Store.searchChats(query) : Store.listChats();
    ui('renderChatList', list, Store.getActiveChatId());
  }

  function clearActiveChat() {
    var chat = Store.getActiveChat();
    if (!chat) { toast('当前没有会话'); return; }
    confirmAsync('清空会话', '确定清空「' + (chat.title || '当前会话') + '」的全部消息吗？').then(function (ok) {
      if (!ok) return;
      Store.clearMessages(chat.id);
      var fresh = Store.getChat(chat.id);
      if (fresh) {
        ui('renderMessages', fresh);
        ui('setHeader', { title: fresh.title, subtitle: '' });
        ui('scrollBottom', true);
      }
      refreshChatList();
      toast('会话已清空');
    });
  }

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */

  function openSettings() {
    closeDrawer();
    ui('renderSettings', state.prefs, MODELS);
    ui('showScreen', 'settings');
    navTo('settings');
  }

  function saveSettings(patch) {
    patch = patch || {};
    var next = {};
    if (patch.baseUrl !== undefined) {
      var baseUrl = normalizeUrl(patch.baseUrl);
      if (!baseUrl) { toast('Base URL 格式不正确'); return false; }
      next.baseUrl = baseUrl;
    }
    if (patch.model !== undefined) {
      var model = String(patch.model || '').replace(/^\s+|\s+$/g, '');
      if (model) next.model = model;
    }
    if (patch.temperature !== undefined) next.temperature = clampNum(patch.temperature, 0, 2);
    if (patch.maxTokens !== undefined) next.maxTokens = Math.round(clampNum(patch.maxTokens, 16, 8192));
    if (patch.stream !== undefined) next.stream = !!patch.stream;
    if (patch.theme !== undefined) next.theme = patch.theme === 'light' ? 'light' : 'dark';
    if (patch.systemPrompt !== undefined) next.systemPrompt = String(patch.systemPrompt || '').slice(0, 16000);

    Store.setPrefs(next);
    try {
      if (global.Bridge && global.Bridge.setPrefs) global.Bridge.setPrefs(next);
    } catch (e) { warn('保存原生 prefs 失败：' + errText(e)); }

    if (patch.apiKey !== undefined && String(patch.apiKey || '').replace(/^\s+|\s+$/g, '')) {
      var newKey = String(patch.apiKey).replace(/^\s+|\s+$/g, '');
      state.apiKey = newKey;
      try { if (global.Bridge && global.Bridge.setPrefs) global.Bridge.setPrefs({ apiKey: newKey }); } catch (e2) { /* ignore */ }
    }

    state.prefs = mergePrefs(Store.getPrefs(), readNativePrefs());
    var active = Store.getActiveChat();
    if (active && next.model) {
      Store.updateChat(active.id, { model: next.model });
      active.model = next.model;
    }
    ui('setModel', state.prefs.model);
    ui('renderSettings', state.prefs, MODELS);
    setHeader(active, '');
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 插件页
   * ------------------------------------------------------------------ */

  function bindPluginsChange() {
    if (state.pluginsBound) return;
    var P = global.DSPlugins;
    if (!P || typeof P.onChange !== 'function') return;
    try {
      P.onChange(function () { refreshPlugins(); });
      state.pluginsBound = true;
    } catch (e) {
      warn('DSPlugins.onChange 失败：' + errText(e));
    }
  }

  function loadPlugins(whenOpen) {
    var P = global.DSPlugins;
    if (!P) { refreshPlugins(); return; }
    var work = null;
    try {
      if (typeof P.loadExternal === 'function') work = P.loadExternal();
    } catch (e) {
      warn('loadExternal 失败：' + errText(e));
    }
    Promise.resolve(work).then(function () {
      refreshPlugins();
    }).catch(function (e2) {
      warn('loadExternal 异常：' + errText(e2));
      refreshPlugins();
    });
  }

  function pluginListNormalized() {
    var raw = [];
    try {
      if (global.DSPlugins && typeof global.DSPlugins.list === 'function') {
        raw = global.DSPlugins.list() || [];
      }
    } catch (e) { warn('DSPlugins.list 失败：' + errText(e)); }
    if (!Array.isArray(raw)) raw = [];
    if (!raw.length) {
      try {
        if (global.Bridge && typeof global.Bridge.plugins === 'function') raw = global.Bridge.plugins() || [];
      } catch (e2) { raw = []; }
    }
    var seen = {};
    var list = [];
    for (var i = 0; i < raw.length; i++) {
      var p = raw[i];
      if (!p || !p.id) continue;
      var id = String(p.id);
      if (seen[id]) continue;
      seen[id] = true;
      var enabled;
      if (p.enabled !== undefined) enabled = !!p.enabled;
      else {
        try { enabled = Store.getPluginEnabled(id, true); } catch (e3) { enabled = true; }
      }
      list.push({
        id: id,
        name: p.name || id,
        version: p.version || '1.0.0',
        author: p.author || '',
        description: p.description || '',
        enabled: enabled,
        builtin: !!p.builtin,
        external: !!p.external,
        fileName: p.fileName || '',
        error: p.error || null
      });
    }
    return list;
  }

  function refreshPlugins() {
    ui('renderPlugins', pluginListNormalized());
  }

  function openPlugins() {
    closeDrawer();
    bindPluginsChange();
    refreshPlugins();
    ui('showScreen', 'plugins');
    navTo('plugins');
    loadPlugins(true);
  }

  function togglePlugin(id, enabled) {
    var on = !!enabled;
    var work = null;
    try {
      if (global.DSPlugins && typeof global.DSPlugins.setEnabled === 'function') {
        work = global.DSPlugins.setEnabled(id, on);
      } else if (global.Bridge && global.Bridge.pluginSetEnabled) {
        global.Bridge.pluginSetEnabled(id, on);
      }
    } catch (e) {
      warn('插件开关失败：' + errText(e));
    }
    try { Store.setPluginEnabled(id, on); } catch (e2) { /* ignore */ }
    Promise.resolve(work).then(function () {
      refreshPlugins();
      toast(on ? '插件已启用' : '插件已禁用');
    }).catch(function (e3) {
      toast('插件切换失败：' + errText(e3));
      refreshPlugins();
    });
  }

  function installPlugin(code) {
    var src = String(code === null || code === undefined ? '' : code);
    if (!src.replace(/\s+/g, '')) { toast('插件代码为空'); return; }
    var work = null;
    try {
      if (global.DSPlugins && typeof global.DSPlugins.installFromCode === 'function') {
        work = global.DSPlugins.installFromCode(src);
      } else {
        throw new Error('插件系统不可用（DSPlugins 未加载）');
      }
    } catch (e) {
      toast('安装失败：' + errText(e));
      return;
    }
    Promise.resolve(work).then(function () {
      toast('插件已安装', true);
      refreshPlugins();
    }).catch(function (e2) {
      toast('安装失败：' + errText(e2));
      refreshPlugins();
    });
  }

  function installPluginFile() {
    var P = global.DSPlugins;
    if (P && typeof P.installFromFile === 'function') {
      toast('请选择插件文件…');
      Promise.resolve(P.installFromFile()).then(function (view) {
        if (!view) return; // 用户取消 / 空文件：静默
        toast('插件已安装', true);
        refreshPlugins();
      }).catch(function (e) {
        toast('安装失败：' + errText(e));
      });
      return;
    }
    toast('请选择插件文件…');
    try {
      if (global.Bridge && global.Bridge.importPluginFile) global.Bridge.importPluginFile();
    } catch (e2) {
      toast('无法打开文件选择器');
    }
  }

  function removePlugin(id, skipConfirm) {
    if (!id) return;
    var list = pluginListNormalized();
    var target = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === String(id)) { target = list[i]; break; }
    }
    if (target && target.builtin) {
      toast('内置插件不可删除，只能禁用');
      return;
    }
    var doRemove = function () {
      var work = null;
      try {
        if (global.DSPlugins && typeof global.DSPlugins.remove === 'function') {
          work = global.DSPlugins.remove(id);
        } else if (global.Bridge && global.Bridge.pluginDelete) {
          global.Bridge.pluginDelete(id);
          Store.setPluginEnabled(id, true);
        }
      } catch (e) {
        toast('删除失败：' + errText(e));
        return;
      }
      Promise.resolve(work).then(function () {
        toast('插件已删除', true);
        refreshPlugins();
      }).catch(function (e2) {
        toast('删除失败：' + errText(e2));
      });
    };
    if (skipConfirm) { doRemove(); return; }
    confirmAsync('删除插件', '确定删除插件「' + (target ? target.name : id) + '」吗？').then(function (ok) {
      if (ok) doRemove();
    });
  }

  /* ------------------------------------------------------------------ *
   * 导出 / 复制
   * ------------------------------------------------------------------ */

  function exportChat(id) {
    var chat = Store.getChat(id) || Store.getActiveChat();
    if (!chat) { toast('没有可导出的会话'); return; }
    var markdown = Store.exportChatMarkdown(chat.id);
    if (!markdown) { toast('导出失败：会话为空'); return; }
    var fileName = safeFileName(chat.title) + '-' + dateStamp() + '.md';
    var ok = false;
    try {
      if (global.Bridge && global.Bridge.saveTextFile) ok = global.Bridge.saveTextFile(fileName, markdown);
    } catch (e) {
      warn('导出失败：' + errText(e));
    }
    if (ok === false) toast('导出失败');
    else toast('正在导出…');
  }

  /** 删除单条消息（UI 会自己移除 DOM，此处只改 Store） */
  function deleteMessage(msgId) {
    if (msgId === null || msgId === undefined || msgId === '') return;
    var chat = Store.getActiveChat();
    if (!chat) return;
    var ok = Store.removeMessage(chat.id, msgId);
    if (ok) {
      refreshChatList();
      toast('消息已删除');
    }
  }

  function copyText(text) {
    if (text === null || text === undefined || text === '') return;
    var work;
    try {
      if (global.Util && typeof global.Util.copyText === 'function') {
        work = global.Util.copyText(String(text));
      } else if (global.Bridge && global.Bridge.setClipboard) {
        global.Bridge.setClipboard(String(text));
        work = true;
      } else {
        work = false;
      }
    } catch (e) {
      work = false;
    }
    Promise.resolve(work).then(function (ok) {
      toast(ok ? '已复制' : '复制失败');
    }).catch(function () {
      toast('复制失败');
    });
  }

  /* ------------------------------------------------------------------ *
   * 斜杠命令
   * ------------------------------------------------------------------ */

  function commandHelpText() {
    var lines = [
      '**可用命令**',
      '',
      '- `/help` 查看命令',
      '- `/new` 新建会话',
      '- `/clear` 清空当前会话',
      '- `/export` 导出当前会话',
      '- `/stop` 停止生成',
      '- `/model` 查看 / 切换模型',
      '- `/settings` 打开设置'
    ];
    try {
      if (global.DSPlugins && typeof global.DSPlugins.list === 'function') {
        var plugins = global.DSPlugins.list() || [];
        var seen = false;
        for (var i = 0; i < plugins.length; i++) {
          var cmds = plugins[i] && plugins[i].commands;
          if (!Array.isArray(cmds) || !cmds.length) continue;
          if (!seen) { lines.push(''); lines.push('**插件命令**'); lines.push(''); seen = true; }
          for (var j = 0; j < cmds.length; j++) {
            var c = cmds[j] || {};
            lines.push('- `/' + (c.name || '') + '` ' + (c.description || '') + (c.usage ? ' · 用法：`' + c.usage + '`' : ''));
          }
        }
      }
    } catch (e) { /* ignore */ }
    return lines.join('\n');
  }

  /** 返回 null 表示未处理；返回 {handled:true, text?} */
  function localCommand(cmd, args) {
    if (cmd === 'help' || cmd === '?' || cmd === 'h') {
      return { handled: true, text: commandHelpText() };
    }
    if (cmd === 'new' || cmd === '去新会话') {
      newChat();
      return { handled: true };
    }
    if (cmd === 'clear' || cmd === '清空') {
      clearActiveChat();
      return { handled: true };
    }
    if (cmd === 'export' || cmd === '导出') {
      var active = Store.getActiveChat();
      if (active) exportChat(active.id);
      return { handled: true };
    }
    if (cmd === 'stop' || cmd === '停止') {
      if (!state.busy) return { handled: true, text: '当前没有生成中的回复。' };
      stopGeneration();
      return { handled: true };
    }
    if (cmd === 'settings' || cmd === '设置') {
      openSettings();
      return { handled: true };
    }
    if (cmd === 'model' || cmd === '模型') {
      var target = String(args || '').replace(/^\s+|\s+$/g, '');
      if (!target) {
        var names = [];
        for (var i = 0; i < MODELS.length; i++) names.push('`' + MODELS[i].id + '`（' + MODELS[i].name + '）');
        return { handled: true, text: '当前模型：`' + state.prefs.model + '`\n\n可用模型：' + names.join('、') };
      }
      var found = null;
      for (var j = 0; j < MODELS.length; j++) {
        if (MODELS[j].id === target) { found = MODELS[j]; break; }
      }
      if (!found) return { handled: true, text: '未知模型：`' + target + '`' };
      saveSettings({ model: found.id });
      return { handled: true, text: '已切换模型：`' + found.id + '`（' + found.name + '）' };
    }
    return null;
  }

  function appendCommandResult(userText, resultText) {
    var chat = ensureActiveChat();
    if (!chat) return;
    var userMsg = Store.appendMessage(chat.id, { role: 'user', content: userText });
    var noteMsg = Store.appendMessage(chat.id, {
      role: 'note',
      content: resultText === null || resultText === undefined || resultText === '' ? '（命令无输出）' : String(resultText)
    });
    if (userMsg) {
      ui('appendMessage', userMsg);
      maybeAutoTitle(chat, userText);
    }
    if (noteMsg) ui('appendMessage', noteMsg);
    ui('scrollBottom', true);
    refreshChatList();
  }

  function handleCommand(text) {
    var raw = String(text === null || text === undefined ? '' : text).replace(/^\s+|\s+$/g, '');
    if (!raw) return;
    var m = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(raw);
    if (!m) { toast('未知命令，输入 /help 查看可用命令'); return; }
    var cmd = m[1].toLowerCase();
    var args = m[2] ? m[2].replace(/^\s+|\s+$/g, '') : '';

    if (state.busy) {
      if (cmd === 'stop' || cmd === 'new') stopGeneration();
      else { toast('正在生成回复，请先停止'); return; }
    }

    var local = localCommand(cmd, args);
    if (local && local.handled) {
      if (local.text) appendCommandResult(raw, local.text);
      return;
    }

    var work = null;
    try {
      if (global.DSPlugins && typeof global.DSPlugins.runCommand === 'function') {
        var chat = ensureActiveChat();
        work = global.DSPlugins.runCommand(cmd, args, pluginCtx(chat));
      }
    } catch (e) {
      toast('命令执行失败：' + errText(e));
      return;
    }
    if (work === null || work === undefined) {
      toast('未知命令 /' + cmd + '，输入 /help 查看可用命令');
      return;
    }
    Promise.resolve(work).then(function (result) {
      if (result === null || result === undefined) {
        toast('未知命令 /' + cmd + '，输入 /help 查看可用命令');
        return;
      }
      var textOut = typeof result === 'string' ? result : safeStringify(result);
      appendCommandResult(raw, textOut || '（命令无输出）');
    }).catch(function (e2) {
      toast('命令执行失败：' + errText(e2));
    });
  }

  /* ------------------------------------------------------------------ *
   * DOM ready / 对外接口
   * ------------------------------------------------------------------ */

  App.boot = boot;
  App.start = boot;
  App.getState = function () { return state; };
  App.getPrefs = function () { return state.prefs; };
  App.send = safe(function (text) { handleSend(text); }, 'App.send');
  App.stop = safe(function () { stopGeneration(); }, 'App.stop');
  App.retry = safe(function (id) { retryMessage(id); }, 'App.retry');
  App.newChat = safe(function () { newChat(); }, 'App.newChat');
  App.selectChat = safe(function (id) { selectChat(id); }, 'App.selectChat');
  App.deleteChat = safe(function (id) { deleteChat(id); }, 'App.deleteChat');
  App.renameChat = safe(function (id, title) { renameChat(id, title); }, 'App.renameChat');
  App.search = safe(function (q) { search(q); }, 'App.search');
  App.login = safe(function (data) { login(data); }, 'App.login');
  App.logout = safe(function () { logout(); }, 'App.logout');
  App.openSettings = safe(function () { openSettings(); }, 'App.openSettings');
  App.openPlugins = safe(function () { openPlugins(); }, 'App.openPlugins');
  App.saveSettings = safe(function (patch) { saveSettings(patch); }, 'App.saveSettings');
  App.exportChat = safe(function (id) { exportChat(id); }, 'App.exportChat');
  App.copyText = safe(function (t) { copyText(t); }, 'App.copyText');
  App.command = safe(function (t) { handleCommand(t); }, 'App.command');
  App.back = safe(function () { onBack(); }, 'App.back');
  App.refreshChatList = safe(function () { refreshChatList(); }, 'App.refreshChatList');
  App.refreshPlugins = safe(function () { refreshPlugins(); }, 'App.refreshPlugins');
  App.pluginList = function () { return pluginListNormalized(); };
  App.openDrawer = function () { state.nav.drawerOpen = true; };
  App.closeDrawer = function () { closeDrawer(); };

  global.App = App;

  function startApp() {
    try {
      boot();
    } catch (e) {
      warn('启动失败：' + errText(e));
      try { if (getUI() && typeof getUI().toast === 'function') getUI().toast('启动失败：' + errText(e)); } catch (e2) { /* ignore */ }
    }
  }

  try {
    if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startApp);
      } else {
        setTimeout(startApp, 0);
      }
    }
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('pagehide', function () {
        try {
          if (global.Api && typeof global.Api.cancelAll === 'function') global.Api.cancelAll();
        } catch (e) { /* ignore */ }
        try { Store.save(); } catch (e2) { /* ignore */ }
      });
    }
  } catch (e3) {
    warn('注册启动事件失败：' + errText(e3));
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
