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

  /* 追加需求 v1.1 B1：内置回退模型目录（无 key 或 GET /models 失败时展示，顺序固定） */
  var MODEL_FALLBACK = {
    V4: [
      'deepseek-v4-pro',
      'deepseek-v4.1-flash',
      'deepseek-v4-flash',
      'deepseek-v4-pro-0813',
      'deepseek-v4-flash-0731',
      'deepseek-v4.1-flash-free'
    ],
    V3: ['deepseek-v3.2', 'deepseek-chat', 'deepseek-reasoner'],
    '其他': ['deepseek-flash']
  };

  var MODEL_FALLBACK_GROUPS = ['V4', 'V3', 'V2', 'V1', '其他'];
  /* 内置目录里已知模型的系列（deepseek-chat / deepseek-reasoner 无版本号，但归属 V3 系列，保持目录顺序固定） */
  var MODEL_SERIES_HINTS = (function () {
    var map = {};
    for (var g = 0; g < MODEL_FALLBACK_GROUPS.length; g++) {
      var group = MODEL_FALLBACK_GROUPS[g];
      if (!/^V\d+$/.test(group)) continue;
      var ids = MODEL_FALLBACK[group];
      if (!Array.isArray(ids)) continue;
      for (var i = 0; i < ids.length; i++) map[ids[i]] = group;
    }
    return map;
  })();
  var MODEL_LABEL_OVERRIDES = {
    'deepseek-chat': 'DeepSeek Chat',
    'deepseek-reasoner': 'DeepSeek Reasoner'
  };
  var MODEL_WORD_CASE = {
    deepseek: 'DeepSeek',
    gpt: 'GPT',
    glm: 'GLM',
    qwen: 'Qwen',
    llama: 'Llama',
    mistral: 'Mistral',
    moonshot: 'Moonshot',
    ai: 'AI'
  };
  var MODEL_TAG_ORDER = ['free', 'pro', 'flash', 'reasoner', 'chat', 'vision'];

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
    remoteModels: [],
    remoteModelsLoaded: false,
    remoteModelsPromise: null,
    customModels: [],
    modelCatalog: [],
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

  var App = { handlers: null, MODEL_FALLBACK: MODEL_FALLBACK, MAX_TOOL_ROUNDS: MAX_TOOL_ROUNDS };

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
    var nkeys = ['baseUrl', 'temperature', 'maxTokens', 'stream', 'theme', 'systemPrompt'];
    for (var j = 0; j < nkeys.length; j++) {
      var k = nkeys[j];
      var v = native[k];
      if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
    // 模型：Store 与原生都会持久化；原生若仍为旧默认值（deepseek-chat）而 Store 已切换，以 Store 为准，
    // 保证「选择后重启仍保持」；原生非默认模型（例如旧版本写入）优先。
    var nativeModel = native.model ? String(native.model) : '';
    var storeModel = base.model ? String(base.model) : '';
    if (nativeModel && nativeModel !== 'deepseek-chat') out.model = nativeModel;
    else if (storeModel) out.model = storeModel;
    else if (nativeModel) out.model = nativeModel;
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
    loadCustomModels();
    state.modelCatalog = buildModelCatalog(state.remoteModels, state.customModels);

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
    applyModelLabel();
    ensureActiveChat();
    // B1：启动/登录成功后静默拉取 GET /models，失败则保留内置回退目录
    refreshModelsFromApi({});
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
      onOpenModelPicker: safe(function () { openModelPicker(); return true; }, 'onOpenModelPicker'),
      onSelectModel: safe(function (id) { selectModel(id); return true; }, 'onSelectModel'),
      onRefreshModels: safe(function () {
        refreshModelsFromApi({ toast: true }).then(function (res) {
          if (!res || !res.ok) return;
          var U = getUI();
          // 面板打开时用新目录重开；UI 未提供 closeModelPicker 时不重复 open，避免叠层
          if (U && typeof U.closeModelPicker === 'function') {
            try { U.closeModelPicker(); } catch (e) { /* ignore */ }
            setTimeout(function () { openModelPicker(); }, 80);
          }
        });
        return true;
      }, 'onRefreshModels'),
      onDeleteCustomModel: safe(function (id) { removeCustomModel(id); return true; }, 'onDeleteCustomModel'),
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
   * 模型目录 / 选择器（追加需求 v1.1 B1）+ 自定义模型
   * ------------------------------------------------------------------ */

  function trimModelId(value) {
    return String(value === null || value === undefined ? '' : value).replace(/^\s+|\s+$/g, '');
  }

  /** 由 id 推断 series：含 v1/v2/v3/v4… → "V<n>"，无版本号 → "其他" */
  function inferModelSeries(id) {
    var text = String(id === null || id === undefined ? '' : id);
    var m = /(?:^|[^a-z0-9])v(\d+)/i.exec(text);
    if (m) return 'V' + m[1];
    return '其他';
  }

  /** 由 id 推断 tag：pro/flash/chat/reasoner/free/vision */
  function inferModelTag(id) {
    var s = String(id === null || id === undefined ? '' : id).toLowerCase();
    var matchers = {
      free: function () { return s.indexOf('free') !== -1; },
      pro: function () { return /(^|[-_.])pro($|[-_.\d])/.test(s); },
      flash: function () { return /(^|[-_.])flash($|[-_.\d])/.test(s); },
      reasoner: function () { return s.indexOf('reasoner') !== -1 || s.indexOf('reasoning') !== -1; },
      chat: function () { return /(^|[-_.])chat($|[-_.\d])/.test(s); },
      vision: function () { return /(^|[-_.])(vision|vlm|vl)($|[-_.\d])/.test(s); }
    };
    for (var i = 0; i < MODEL_TAG_ORDER.length; i++) {
      var tag = MODEL_TAG_ORDER[i];
      if (matchers[tag] && matchers[tag]()) return tag;
    }
    return '';
  }

  /** deepseek-v4.1-flash → "DeepSeek V4.1 Flash"；deepseek-chat → "DeepSeek Chat"；未知 id 原样美化 */
  function humanizeModelId(id) {
    var s = trimModelId(id);
    if (!s) return '未命名模型';
    if (MODEL_LABEL_OVERRIDES[s]) return MODEL_LABEL_OVERRIDES[s];
    var parts = s.split(/[-_]+/);
    var words = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part) continue;
      if (/^v\d+(?:\.\d+)*$/i.test(part)) { words.push(part.toUpperCase()); continue; }
      if (/^\d+$/.test(part)) { words.push(part); continue; }
      var lower = part.toLowerCase();
      if (MODEL_WORD_CASE[lower]) { words.push(MODEL_WORD_CASE[lower]); continue; }
      words.push(part.charAt(0).toUpperCase() + part.slice(1));
    }
    var label = words.join(' ').replace(/[\/]+/g, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    return label || s;
  }

  function makeModelInfo(id, opts) {
    var modelId = trimModelId(id);
    if (!modelId) return null;
    opts = opts || {};
    var custom = !!opts.custom;
    return {
      id: modelId,
      label: humanizeModelId(modelId),
      series: custom ? '自定义' : (MODEL_SERIES_HINTS[modelId] || inferModelSeries(modelId)),
      tag: inferModelTag(modelId),
      custom: custom,
      remote: !!opts.remote,
      fallback: !!opts.fallback
    };
  }

  function seriesRank(series) {
    if (series === '自定义') return 1000;
    if (series === '其他') return 1001;
    var m = /^V(\d+)$/.exec(String(series || ''));
    if (m) return 1000 - Number(m[1]);
    return 999;
  }

  function compareModelInfo(a, b) {
    var ra = seriesRank(a.series);
    var rb = seriesRank(b.series);
    if (ra !== rb) return ra - rb;
    return (Number(a._idx) || 0) - (Number(b._idx) || 0);
  }

  /**
   * 合并回退目录 + 远端 GET /models ids + 用户自定义 ids。
   * 去重规则：先出现者保留（回退 → 远端 → 自定义），远端可覆盖同 id 的回退条目展示。
   * 展示顺序：V10…V4→V3→V2→V1 → 自定义 → 其他；组内按来源/添加顺序。
   */
  function buildModelCatalog(remoteIds, customIds) {
    var remote = Array.isArray(remoteIds) ? remoteIds : (Array.isArray(state.remoteModels) ? state.remoteModels : []);
    var custom = Array.isArray(customIds) ? customIds : (Array.isArray(state.customModels) ? state.customModels : []);
    var catalog = [];
    var seen = Object.create(null);

    function push(id, opts) {
      var modelId = trimModelId(id);
      if (!modelId || seen[modelId]) return;
      var info = makeModelInfo(modelId, opts);
      if (!info) return;
      seen[modelId] = true;
      info._idx = catalog.length;
      catalog.push(info);
    }

    for (var g = 0; g < MODEL_FALLBACK_GROUPS.length; g++) {
      var groupName = MODEL_FALLBACK_GROUPS[g];
      var ids = MODEL_FALLBACK[groupName];
      if (!Array.isArray(ids)) continue;
      for (var i = 0; i < ids.length; i++) push(ids[i], { fallback: true });
    }
    var remoteSeen = Object.create(null);
    for (var r = 0; r < remote.length; r++) {
      var remoteId = trimModelId(remote[r]);
      if (!remoteId) continue;
      remoteSeen[remoteId] = true;
      push(remoteId, { remote: true });
    }
    for (var c = 0; c < custom.length; c++) push(custom[c], { custom: true });

    // 远端 /models 已合并的条目不再标记为 fallback（UI 据此决定是否显示「从 API 获取」按钮）
    for (var f = 0; f < catalog.length; f++) {
      if (remoteSeen[catalog[f].id]) catalog[f].fallback = false;
    }

    catalog.sort(compareModelInfo);
    for (var k = 0; k < catalog.length; k++) delete catalog[k]._idx;
    return catalog;
  }

  /** 当前选中但不在目录中的 id（如手输）也补一条，保证可显示/选中 */
  function catalogWithCurrent(catalog, currentId) {
    var id = trimModelId(currentId);
    if (!id) return catalog;
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].id === id) return catalog;
    }
    var copy = catalog.slice();
    var extra = makeModelInfo(id, { custom: true });
    if (!extra) return copy;
    extra._idx = copy.length;
    copy.forEach(function (item, idx) { item._idx = idx; });
    extra._idx = copy.length;
    copy.push(extra);
    copy.sort(compareModelInfo);
    copy.forEach(function (item) { delete item._idx; });
    return copy;
  }

  function findModelInfo(id, catalog) {
    var key = trimModelId(id);
    catalog = catalog || currentModelCatalog();
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].id === key) return catalog[i];
    }
    return null;
  }

  function labelForModelId(id) {
    var info = findModelInfo(id);
    return info ? info.label : humanizeModelId(id);
  }

  function currentModelCatalog() {
    return catalogWithCurrent(buildModelCatalog(state.remoteModels, state.customModels), state.prefs.model);
  }

  function loadCustomModels() {
    var list = [];
    try {
      if (global.Store && typeof Store.getCustomModels === 'function') list = Store.getCustomModels();
    } catch (e) {
      warn('读取自定义模型失败：' + errText(e));
    }
    if (!Array.isArray(list)) list = [];
    state.customModels = list.map(function (item) { return String(item); });
    return state.customModels;
  }

  function persistCustomModels(list) {
    state.customModels = Array.isArray(list) ? list.slice() : [];
    try {
      if (global.Store && typeof Store.setCustomModels === 'function') {
        state.customModels = Store.setCustomModels(state.customModels);
      }
    } catch (e) {
      warn('保存自定义模型失败：' + errText(e));
    }
    state.modelCatalog = buildModelCatalog(state.remoteModels, state.customModels);
    return state.customModels;
  }

  /** 顶栏副标题 / 设置页当前模型名（UI.setModelLabel 优先；缺失时用 UI.setModel 兜底） */
  function applyModelLabel() {
    var modelId = state.prefs.model || 'deepseek-chat';
    var info = findModelInfo(modelId);
    var label = info ? info.label : humanizeModelId(modelId);
    ui('setModel', modelId);
    var U = getUI();
    if (U && typeof U.setModelLabel === 'function') {
      ui('setModelLabel', label);
    } else {
      var chat = Store.getActiveChat();
      if (chat) setHeader(chat, '');
    }
    return label;
  }

  /**
   * 选择模型：写 state.prefs.model + 当前 chat.model，持久化到 Store + Bridge，
   * 更新 UI 标签并 toast；不在目录中的 id 自动进入「自定义」组。
   */
  function selectModel(id, opts) {
    opts = opts || {};
    var modelId = trimModelId(id);
    if (!modelId) return false;
    if (modelId.length > 120) { toast('模型 ID 太长（最多 120 字符）'); return false; }

    var catalog = buildModelCatalog(state.remoteModels, state.customModels);
    var isKnown = false;
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].id === modelId) { isKnown = true; break; }
    }
    if (!isKnown) {
      var list = (state.customModels || []).slice();
      if (list.indexOf(modelId) === -1) list.push(modelId);
      persistCustomModels(list);
    }

    state.prefs.model = modelId;
    try { Store.setPrefs({ model: modelId }); } catch (e) { warn('Store.setPrefs(model) 失败：' + errText(e)); }
    try {
      if (global.Bridge && typeof global.Bridge.setPrefs === 'function') global.Bridge.setPrefs({ model: modelId });
    } catch (e2) { warn('Bridge.setPrefs(model) 失败：' + errText(e2)); }

    var chat = Store.getActiveChat();
    if (chat) {
      try {
        if (typeof Store.updateChat === 'function') Store.updateChat(chat.id, { model: modelId });
        chat.model = modelId;
      } catch (e3) { warn('更新会话模型失败：' + errText(e3)); }
    }

    state.modelCatalog = buildModelCatalog(state.remoteModels, state.customModels);
    var label = applyModelLabel();
    if (!opts.silent) toast('已切换到 ' + label, true);
    return true;
  }

  function modelCatalogText() {
    var catalog = currentModelCatalog();
    var lines = ['当前模型：`' + (state.prefs.model || '') + '` ' + '（' + labelForModelId(state.prefs.model) + '）', ''];
    var lastGroup = '';
    for (var i = 0; i < catalog.length; i++) {
      var m = catalog[i];
      var group = m.custom ? '自定义' : m.series;
      if (group !== lastGroup) {
        lines.push('**' + (group === '其他' ? '其他' : group + ' 系列') + '**');
        lastGroup = group;
      }
      lines.push('- ' + m.label + ' · `' + m.id + '`' + (m.tag ? ' [' + m.tag + ']' : '') + (m.id === state.prefs.model ? ' ← 当前' : ''));
    }
    return lines.join('\n');
  }

  function openModelPicker() {
    var catalog = currentModelCatalog();
    state.modelCatalog = catalog;
    var current = state.prefs.model;
    var U = getUI();
    if (U && typeof U.openModelPicker === 'function') {
      try {
        U.openModelPicker(catalog, current, function (id) {
          if (id === null || id === undefined || id === '') return; // 关闭面板
          selectModel(String(id));
        });
        return true;
      } catch (e) {
        warn('UI.openModelPicker 失败：' + errText(e));
      }
    }
    // 兜底：UI 尚未实现 openModelPicker 时，用输入框选择
    toast('当前模型：' + labelForModelId(current), true);
    promptAsync('选择模型（输入模型 ID）', current, '例如 deepseek-v4-pro').then(function (value) {
      if (value === null || value === undefined) return;
      var v = trimModelId(value);
      if (!v) return;
      selectModel(v);
    });
    return false;
  }

  function refreshModelsFromApi(opts) {
    opts = opts || {};
    if (state.remoteModelsPromise && !opts.force) return state.remoteModelsPromise;
    if (!global.Api || typeof global.Api.verifyKey !== 'function') {
      return Promise.resolve({ ok: false, models: [], error: 'Api 不可用' });
    }
    var promise = Api.verifyKey({ timeout: opts.timeout || 15000 }).then(function (res) {
      state.remoteModelsPromise = null;
      res = res || {};
      if (res.ok && Array.isArray(res.models) && res.models.length) {
        var list = [];
        var seen = Object.create(null);
        for (var i = 0; i < res.models.length; i++) {
          var id = trimModelId(res.models[i]);
          if (!id || seen[id]) continue;
          seen[id] = true;
          list.push(id);
        }
        state.remoteModels = list;
        state.remoteModelsLoaded = true;
        state.modelCatalog = buildModelCatalog(state.remoteModels, state.customModels);
        applyModelLabel();
        if (opts.toast) toast('已获取 ' + list.length + ' 个模型', true);
        return { ok: true, models: list.slice(), count: list.length };
      }
      if (opts.toast) {
        var message = res.timeout ? '获取模型列表超时' : (res.message || '获取模型列表失败');
        toast(message + '，继续使用内置目录', true);
      }
      return { ok: false, models: [], error: res.message || '获取模型列表失败' };
    }).catch(function (e) {
      state.remoteModelsPromise = null;
      if (opts.toast) toast('获取模型列表失败：' + errText(e), true);
      return { ok: false, models: [], error: errText(e) };
    });
    state.remoteModelsPromise = promise;
    return promise;
  }

  function removeCustomModel(id) {
    var modelId = trimModelId(id);
    if (!modelId) return false;
    var list = (state.customModels || []).slice();
    var idx = list.indexOf(modelId);
    if (idx < 0) {
      toast('「' + modelId + '」不是自定义模型');
      return false;
    }
    list.splice(idx, 1);
    persistCustomModels(list);
    if (state.prefs.model === modelId) applyModelLabel();
    toast('已删除自定义模型「' + humanizeModelId(modelId) + '」', true);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */

  function openSettings() {
    closeDrawer();
    state.modelCatalog = currentModelCatalog();
    ui('renderSettings', state.prefs, state.modelCatalog);
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
    // B1：设置页保存 model 时同样走 selectModel 逻辑（含自定义模型落目录/持久化/标签更新）
    var requestedModel = patch.model !== undefined ? trimModelId(patch.model) : '';
    if (requestedModel) {
      selectModel(requestedModel, { silent: true });
    } else {
      applyModelLabel();
    }
    state.modelCatalog = currentModelCatalog();
    ui('renderSettings', state.prefs, state.modelCatalog);
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
      '- `/model` 打开模型选择器',
      '- `/model <id>` 直接切换模型（自动加入自定义）',
      '- `/model list` 列出模型目录',
      '- `/model remove <id>` 删除自定义模型',
      '- `/models` 从 API 获取模型列表',
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
        // 无参数：打开选择器（UI 支持时）；否则返回目录文本
        openModelPicker();
        return { handled: true };
      }
      var lower = target.toLowerCase();
      if (lower === 'list' || lower === '列表') {
        return { handled: true, text: modelCatalogText() };
      }
      if (lower === 'refresh' || lower === '刷新') {
        refreshModelsFromApi({ toast: true });
        return { handled: true };
      }
      if (/^remove\s+/i.test(target)) {
        var removeId = target.replace(/^remove\s+/i, '').replace(/^\s+|\s+$/g, '');
        var removed = removeCustomModel(removeId);
        return { handled: true, text: removed ? '已删除自定义模型：`' + removeId + '`' : '「' + removeId + '」不在自定义模型中。' };
      }
      if (selectModel(target, { silent: true })) {
        return { handled: true, text: '已切换模型：`' + target + '`（' + labelForModelId(target) + '）' };
      }
      return { handled: true, text: '无法切换到模型：`' + target + '`' };
    }
    if (cmd === 'models' || cmd === '模型列表') {
      refreshModelsFromApi({ toast: true });
      return { handled: true };
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
  App.buildModelCatalog = function (remoteIds, customIds) { return buildModelCatalog(remoteIds, customIds); };
  App.currentModelCatalog = function () { return currentModelCatalog(); };
  App.selectModel = safe(function (id, opts) { return selectModel(id, opts); }, 'App.selectModel');
  App.openModelPicker = safe(function () { return openModelPicker(); }, 'App.openModelPicker');
  App.refreshModels = safe(function (opts) { return refreshModelsFromApi(opts || {}); }, 'App.refreshModels');
  App.removeCustomModel = safe(function (id) { return removeCustomModel(id); }, 'App.removeCustomModel');
  App.getCustomModels = function () { try { return (Store.getCustomModels ? Store.getCustomModels() : state.customModels).slice(); } catch (e) { return (state.customModels || []).slice(); } };
  App.labelForModelId = function (id) { return labelForModelId(id); };
  App.humanizeModelId = function (id) { return humanizeModelId(id); };
  App.inferModelSeries = function (id) { return inferModelSeries(id); };
  App.inferModelTag = function (id) { return inferModelTag(id); };
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
