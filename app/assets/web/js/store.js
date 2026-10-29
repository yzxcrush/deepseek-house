/*!
 * DeepSeek House — store.js
 * localStorage 数据层（key: dsh.v1）。
 *
 * state = {
 *   version: 1,
 *   prefs: {baseUrl, model, temperature, maxTokens, stream, theme, systemPrompt}, // apiKey 不落 localStorage
 *   chats: [{id,title,createdAt,updatedAt,pinned,archived,model,messages:[]}],
 *   activeChatId,
 *   plugins: {enabled:{<id>:true}, settings:{<id>:{...}}},
 *   customModels: ["<自定义模型 id>"],   // B1：用户自定义模型 ID（任意字符串）
 *   ui: {drawerOpen:false}
 * }
 * msg = {id, role:"user"|"assistant"|"tool"|"note", content, reasoning?, toolCalls?, toolName?,
 *        toolCallId?, error?, usage?, streaming?, createdAt}
 *
 * 挂载：window.Store
 */
(function (global) {
  'use strict';

  var KEY = 'dsh.v1';
  var VERSION = 1;

  var DEFAULT_SYSTEM_PROMPT = '你是 DeepSeek House 助手，一个运行在安卓 WebView 中的 AI 聊天助手。请用简体中文回答（除非用户要求其他语言），回答准确、简洁、有条理，适当使用 Markdown 排版。';

  var DEFAULT_PREFS = {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    temperature: 1.0,
    maxTokens: 4096,
    stream: true,
    theme: 'dark',
    systemPrompt: DEFAULT_SYSTEM_PROMPT
  };

  var ROLES = { user: true, assistant: true, tool: true, note: true };

  var memoryStore = {};
  var state = null;

  function warn() {
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn.apply(console, ['[Store]'].concat(Array.prototype.slice.call(arguments)));
      }
    } catch (e) { /* ignore */ }
  }

  function detectStorage() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        var probe = '__dsh_probe__';
        localStorage.setItem(probe, '1');
        localStorage.removeItem(probe);
        return localStorage;
      }
    } catch (e) { /* fall through */ }
    return {
      getItem: function (k) {
        return Object.prototype.hasOwnProperty.call(memoryStore, k) ? memoryStore[k] : null;
      },
      setItem: function (k, v) { memoryStore[k] = String(v); },
      removeItem: function (k) { delete memoryStore[k]; }
    };
  }

  var storage = detectStorage();

  function now() { return Date.now(); }

  function uid() {
    try {
      if (global.Util && typeof global.Util.uuid === 'function') return global.Util.uuid();
    } catch (e) { /* ignore */ }
    return 'u-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function clone(obj) {
    try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
  }

  function clampNum(n, min, max) {
    n = Number(n);
    if (!isFinite(n)) n = min;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function normalizeUrl(url) {
    var s = String(url === null || url === undefined ? '' : url).replace(/^\s+|\s+$/g, '');
    if (!s) return '';
    if (typeof global.Util !== 'undefined' && global.Util && typeof global.Util.normalizeBaseUrl === 'function') {
      return global.Util.normalizeBaseUrl(s);
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    if (!/^https?:\/\//i.test(s)) return '';
    return s.replace(/\/+$/, '');
  }

  function formatTime(ts) {
    try {
      if (global.Util && typeof global.Util.formatDateTime === 'function') return global.Util.formatDateTime(ts);
    } catch (e) { /* ignore */ }
    var d = new Date(Number(ts) || now());
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ------------------------------------------------------------------ *
   * 数据结构
   * ------------------------------------------------------------------ */

  function defaultPrefs() {
    return {
      baseUrl: DEFAULT_PREFS.baseUrl,
      model: DEFAULT_PREFS.model,
      temperature: DEFAULT_PREFS.temperature,
      maxTokens: DEFAULT_PREFS.maxTokens,
      stream: DEFAULT_PREFS.stream,
      theme: DEFAULT_PREFS.theme,
      systemPrompt: DEFAULT_PREFS.systemPrompt
    };
  }

  function freshState() {
    return {
      version: VERSION,
      prefs: defaultPrefs(),
      chats: [],
      activeChatId: null,
      customModels: [],
      plugins: { enabled: {}, settings: {} },
      ui: { drawerOpen: false }
    };
  }

  function normalizeCustomModels(raw) {
    var out = [];
    var seen = {};
    if (!Array.isArray(raw)) return out;
    for (var i = 0; i < raw.length && out.length < 50; i++) {
      var v = raw[i];
      if (v === null || v === undefined) continue;
      var id = String(v).replace(/^\s+|\s+$/g, '');
      if (!id || id.length > 120 || seen[id]) continue;
      seen[id] = true;
      out.push(id);
    }
    return out;
  }

  function normalizePrefs(raw) {
    var p = defaultPrefs();
    if (!raw || typeof raw !== 'object') return p;
    if (raw.baseUrl !== undefined) {
      var b = normalizeUrl(raw.baseUrl);
      if (b) p.baseUrl = b;
    }
    if (raw.model && typeof raw.model === 'string' && raw.model.trim()) p.model = raw.model.trim().slice(0, 80);
    if (raw.temperature !== undefined) p.temperature = clampNum(raw.temperature, 0, 2);
    if (raw.maxTokens !== undefined) p.maxTokens = Math.round(clampNum(raw.maxTokens, 16, 8192));
    if (raw.stream !== undefined) p.stream = !!raw.stream;
    if (raw.theme === 'light' || raw.theme === 'dark') p.theme = raw.theme;
    if (raw.systemPrompt !== undefined) p.systemPrompt = String(raw.systemPrompt).slice(0, 16000);
    // 安全：apiKey 永远不写入 localStorage
    return p;
  }

  function normalizeMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var role = ROLES[raw.role] ? raw.role : 'assistant';
    var msg = {
      id: raw.id ? String(raw.id) : uid(),
      role: role,
      content: raw.content === null || raw.content === undefined ? '' : String(raw.content),
      createdAt: Number(raw.createdAt) || now()
    };
    if (raw.reasoning) msg.reasoning = String(raw.reasoning);
    if (raw.toolName) msg.toolName = String(raw.toolName);
    if (raw.toolCallId) msg.toolCallId = String(raw.toolCallId);
    if (raw.error) msg.error = String(raw.error);
    if (raw.streaming) msg.streaming = true;
    if (raw.stopped) msg.stopped = true;
    if (raw.usage && typeof raw.usage === 'object') msg.usage = raw.usage;
    if (Array.isArray(raw.toolCalls) && raw.toolCalls.length) {
      msg.toolCalls = raw.toolCalls.map(function (tc) {
        if (!tc || typeof tc !== 'object') return null;
        var out = { id: tc.id || '', type: tc.type || 'function' };
        var fn = tc.function || {};
        out.name = tc.name || fn.name || '';
        var args = tc.arguments !== undefined ? tc.arguments : fn.arguments;
        out.arguments = typeof args === 'string' ? args : (args === undefined ? '' : JSON.stringify(args));
        return out;
      }).filter(function (x) { return !!x; });
    }
    return msg;
  }

  function normalizeChat(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var chat = {
      id: raw.id ? String(raw.id) : uid(),
      title: raw.title ? String(raw.title).slice(0, 80) : '新的对话',
      createdAt: Number(raw.createdAt) || now(),
      updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || now(),
      pinned: !!raw.pinned,
      archived: !!raw.archived,
      model: raw.model ? String(raw.model) : DEFAULT_PREFS.model,
      messages: []
    };
    if (Array.isArray(raw.messages)) {
      chat.messages = raw.messages.map(normalizeMessage).filter(function (m) { return !!m; });
    }
    return chat;
  }

  function normalizeState(raw) {
    var next = freshState();
    if (!raw || typeof raw !== 'object') return next;
    next.version = VERSION;
    next.prefs = normalizePrefs(raw.prefs);
    if (Array.isArray(raw.chats)) {
      next.chats = raw.chats.map(normalizeChat).filter(function (c) { return !!c; });
    }
    if (raw.plugins && typeof raw.plugins === 'object') {
      if (raw.plugins.enabled && typeof raw.plugins.enabled === 'object') {
        var ekeys = Object.keys(raw.plugins.enabled);
        for (var i = 0; i < ekeys.length; i++) next.plugins.enabled[ekeys[i]] = !!raw.plugins.enabled[ekeys[i]];
      }
      if (raw.plugins.settings && typeof raw.plugins.settings === 'object') {
        var skeys = Object.keys(raw.plugins.settings);
        for (var j = 0; j < skeys.length; j++) {
          var value = raw.plugins.settings[skeys[j]];
          if (value && typeof value === 'object') next.plugins.settings[skeys[j]] = value;
        }
      }
    }
    if (raw.ui && typeof raw.ui === 'object' && typeof raw.ui.drawerOpen === 'boolean') {
      next.ui.drawerOpen = raw.ui.drawerOpen;
    }
    if (raw.customModels !== undefined) {
      next.customModels = normalizeCustomModels(raw.customModels);
    }
    var ids = next.chats.map(function (c) { return c.id; });
    if (raw.activeChatId && ids.indexOf(String(raw.activeChatId)) !== -1) {
      next.activeChatId = String(raw.activeChatId);
    } else {
      next.activeChatId = next.chats.length ? sortedChats(next.chats)[0].id : null;
    }
    return next;
  }

  /* ------------------------------------------------------------------ *
   * 持久化
   * ------------------------------------------------------------------ */

  function load(force) {
    if (state && !force) return state;
    var raw = null;
    try { raw = storage.getItem(KEY); } catch (e) { raw = null; }
    var parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch (e2) { parsed = null; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (raw) warn('本地数据损坏，已重置');
      state = freshState();
      save();
      return state;
    }
    state = normalizeState(parsed);
    save();
    return state;
  }

  function save() {
    if (!state) return false;
    try {
      storage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      warn('保存失败（可能存储空间不足）：' + (e && e.message));
      return false;
    }
  }

  function getState() {
    load();
    return state;
  }

  function sortedChats(list) {
    return list.slice().sort(function (a, b) {
      var pa = a.pinned ? 1 : 0;
      var pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      var ua = Number(a.updatedAt) || 0;
      var ub = Number(b.updatedAt) || 0;
      if (ub !== ua) return ub - ua;
      return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
    });
  }

  /* ------------------------------------------------------------------ *
   * prefs
   * ------------------------------------------------------------------ */

  function getPrefs() {
    load();
    var out = {};
    var keys = Object.keys(state.prefs);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = state.prefs[keys[i]];
    return out;
  }

  function setPrefs(patch) {
    load();
    if (!patch || typeof patch !== 'object') return getPrefs();
    if (patch.baseUrl !== undefined) {
      var b = normalizeUrl(patch.baseUrl);
      if (b) state.prefs.baseUrl = b;
    }
    if (patch.model !== undefined && typeof patch.model === 'string' && patch.model.trim()) {
      state.prefs.model = patch.model.trim().slice(0, 80);
    }
    if (patch.temperature !== undefined) state.prefs.temperature = clampNum(patch.temperature, 0, 2);
    if (patch.maxTokens !== undefined) state.prefs.maxTokens = Math.round(clampNum(patch.maxTokens, 16, 8192));
    if (patch.stream !== undefined) state.prefs.stream = !!patch.stream;
    if (patch.theme !== undefined) state.prefs.theme = patch.theme === 'light' ? 'light' : 'dark';
    if (patch.systemPrompt !== undefined) state.prefs.systemPrompt = String(patch.systemPrompt).slice(0, 16000);
    // apiKey 不落 localStorage（由原生 SharedPreferences 保存）
    save();
    return getPrefs();
  }

  /* ------------------------------------------------------------------ *
   * 会话 CRUD
   * ------------------------------------------------------------------ */

  function getChat(id) {
    load();
    if (id === null || id === undefined || id === '') return getActiveChat();
    var key = String(id);
    for (var i = 0; i < state.chats.length; i++) {
      if (state.chats[i].id === key) return state.chats[i];
    }
    return null;
  }

  function getActiveChat() {
    load();
    if (!state.activeChatId) return null;
    return getChat(state.activeChatId);
  }

  function getActiveChatId() {
    load();
    return state.activeChatId;
  }

  function setActiveChat(id) {
    load();
    if (id === null || id === undefined) { state.activeChatId = null; save(); return null; }
    var chat = getChat(id);
    state.activeChatId = chat ? chat.id : state.activeChatId;
    save();
    return state.activeChatId;
  }

  function listChats(opts) {
    load();
    var list = sortedChats(state.chats);
    if (opts && opts.includeArchived === false) {
      list = list.filter(function (c) { return !c.archived; });
    }
    return list;
  }

  function createChat(opts) {
    load();
    opts = opts || {};
    var chat = {
      id: uid(),
      title: opts.title ? String(opts.title).slice(0, 80) : '新的对话',
      createdAt: now(),
      updatedAt: now(),
      pinned: !!opts.pinned,
      archived: false,
      model: opts.model || state.prefs.model || DEFAULT_PREFS.model,
      messages: []
    };
    state.chats.push(chat);
    state.activeChatId = chat.id;
    save();
    return chat;
  }

  function deleteChat(id) {
    load();
    var key = String(id);
    var idx = -1;
    for (var i = 0; i < state.chats.length; i++) {
      if (state.chats[i].id === key) { idx = i; break; }
    }
    if (idx < 0) return false;
    var removed = state.chats.splice(idx, 1)[0];
    if (state.activeChatId === key) {
      var remain = sortedChats(state.chats);
      state.activeChatId = remain.length ? remain[0].id : null;
    }
    save();
    return removed;
  }

  function renameChat(id, title) {
    load();
    var chat = getChat(id);
    if (!chat) return null;
    var t = String(title === null || title === undefined ? '' : title).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (!t) return null;
    chat.title = t.slice(0, 80);
    chat.updatedAt = now();
    save();
    return chat;
  }

  function touchChat(id) {
    load();
    var chat = getChat(id);
    if (!chat) return null;
    chat.updatedAt = now();
    save();
    return chat;
  }

  function updateChat(id, patch) {
    load();
    var chat = getChat(id);
    if (!chat || !patch || typeof patch !== 'object') return null;
    if (patch.title !== undefined) chat.title = String(patch.title).slice(0, 80) || chat.title;
    if (patch.model !== undefined) chat.model = String(patch.model);
    if (patch.pinned !== undefined) chat.pinned = !!patch.pinned;
    if (patch.archived !== undefined) chat.archived = !!patch.archived;
    if (patch.updatedAt !== undefined) chat.updatedAt = Number(patch.updatedAt) || now();
    save();
    return chat;
  }

  function searchChats(query) {
    load();
    var q = String(query === null || query === undefined ? '' : query).replace(/^\s+|\s+$/g, '').toLowerCase();
    if (!q) return listChats();
    var result = state.chats.filter(function (chat) {
      if (String(chat.title || '').toLowerCase().indexOf(q) !== -1) return true;
      for (var i = 0; i < chat.messages.length; i++) {
        var m = chat.messages[i];
        if (String(m.content || '').toLowerCase().indexOf(q) !== -1) return true;
        if (String(m.reasoning || '').toLowerCase().indexOf(q) !== -1) return true;
      }
      return false;
    });
    return sortedChats(result);
  }

  /* ------------------------------------------------------------------ *
   * 消息
   * ------------------------------------------------------------------ */

  function resolveChat(chatId) {
    if (chatId && typeof chatId === 'object') return chatId;
    if (chatId === null || chatId === undefined || chatId === '') return getActiveChat();
    return getChat(chatId);
  }

  function appendMessage(chatId, rawMsg) {
    load();
    if (chatId && typeof chatId === 'object' && rawMsg === undefined) {
      rawMsg = chatId;
      chatId = undefined;
    }
    var chat = resolveChat(chatId);
    if (!chat) return null;
    var msg = normalizeMessage(rawMsg);
    if (!msg) return null;
    chat.messages.push(msg);
    chat.updatedAt = now();
    save();
    return msg;
  }

  /**
   * store.updateMessage(chatId, msgId, patch) 或 store.updateMessage(msgId, patch)（当前会话）
   */
  function updateMessage(chatId, msgId, patch) {
    load();
    if (patch === undefined && msgId && typeof msgId === 'object') {
      patch = msgId;
      msgId = chatId;
      chatId = undefined;
    }
    var chat = resolveChat(chatId);
    if (!chat) return null;
    var key = String(msgId);
    for (var i = 0; i < chat.messages.length; i++) {
      if (chat.messages[i].id !== key) continue;
      var msg = chat.messages[i];
      patch = patch || {};
      var patchKeys = Object.keys(patch);
      for (var j = 0; j < patchKeys.length; j++) {
        var k = patchKeys[j];
        if (k === 'id' || k === 'role' || k === 'createdAt') continue;
        if (patch[k] === undefined) continue;
        msg[k] = patch[k];
      }
      if (patch.streaming !== true) chat.updatedAt = now();
      save();
      return msg;
    }
    return null;
  }

  function removeMessage(chatId, msgId) {
    load();
    if (msgId === undefined) { msgId = chatId; chatId = undefined; }
    var chat = resolveChat(chatId);
    if (!chat) return false;
    var key = String(msgId);
    for (var i = 0; i < chat.messages.length; i++) {
      if (chat.messages[i].id === key) {
        chat.messages.splice(i, 1);
        chat.updatedAt = now();
        save();
        return true;
      }
    }
    return false;
  }

  /** 只保留前 keepCount 条消息（keepCount<=0 即清空） */
  function truncateMessages(chatId, keepCount) {
    load();
    var chat = resolveChat(chatId);
    if (!chat) return null;
    var keep = Math.max(0, parseInt(keepCount, 10) || 0);
    chat.messages = chat.messages.slice(0, keep);
    chat.updatedAt = now();
    save();
    return chat;
  }

  function clearMessages(chatId) {
    return truncateMessages(chatId, 0);
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  function roleLabel(msg) {
    if (msg.role === 'user') return '用户';
    if (msg.role === 'tool') return '工具结果' + (msg.toolName ? ' · ' + msg.toolName : '');
    if (msg.role === 'note') return '备注';
    return 'DeepSeek';
  }

  function quoteBlock(text) {
    return String(text || '').split('\n').map(function (line) { return '> ' + line; }).join('\n');
  }

  function exportChatMarkdown(id) {
    load();
    var chat = id === null || id === undefined || id === '' ? getActiveChat() : getChat(id);
    if (!chat) return '';
    var lines = [];
    lines.push('# ' + (chat.title || '对话'));
    lines.push('');
    lines.push('- 导出时间：' + formatTime(now()));
    lines.push('- 创建时间：' + formatTime(chat.createdAt));
    lines.push('- 模型：' + (chat.model || state.prefs.model));
    lines.push('');
    lines.push('---');
    lines.push('');
    for (var i = 0; i < chat.messages.length; i++) {
      var msg = chat.messages[i];
      lines.push('## ' + roleLabel(msg) + '  (' + formatTime(msg.createdAt) + ')');
      lines.push('');
      if (msg.reasoning) {
        lines.push('**思考过程**');
        lines.push('');
        lines.push(quoteBlock(msg.reasoning));
        lines.push('');
      }
      if (msg.toolCalls && msg.toolCalls.length) {
        for (var t = 0; t < msg.toolCalls.length; t++) {
          var tc = msg.toolCalls[t];
          lines.push('- 调用工具：`' + (tc.name || 'unknown') + '` 参数：`' + String(tc.arguments || '').replace(/`/g, "'") + '`');
        }
        lines.push('');
      }
      if (msg.content) {
        lines.push(msg.content);
        lines.push('');
      }
      if (msg.error) {
        lines.push('> ⚠️ 错误：' + msg.error);
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 自定义模型（追加需求 v1.1 B1）
   * ------------------------------------------------------------------ */

  function getCustomModels() {
    load();
    return (state.customModels || []).slice();
  }

  function setCustomModels(list) {
    load();
    state.customModels = normalizeCustomModels(list);
    save();
    return getCustomModels();
  }

  function addCustomModel(id) {
    load();
    var value = String(id === null || id === undefined ? '' : id).replace(/^\s+|\s+$/g, '');
    if (!value) return getCustomModels();
    var list = (state.customModels || []).slice();
    if (list.indexOf(value) === -1) {
      if (value.length > 120) value = value.slice(0, 120);
      list.push(value);
      state.customModels = normalizeCustomModels(list);
      save();
    }
    return getCustomModels();
  }

  function removeCustomModel(id) {
    load();
    var value = String(id === null || id === undefined ? '' : id);
    if (!value) return getCustomModels();
    var list = (state.customModels || []).filter(function (item) { return item !== value; });
    state.customModels = list;
    save();
    return getCustomModels();
  }

  /* ------------------------------------------------------------------ *
   * 插件状态
   * ------------------------------------------------------------------ */

  function getPluginEnabled(id, defaultValue) {
    load();
    var key = String(id);
    if (!Object.prototype.hasOwnProperty.call(state.plugins.enabled, key)) {
      return defaultValue === undefined ? true : !!defaultValue;
    }
    return !!state.plugins.enabled[key];
  }

  function setPluginEnabled(id, enabled) {
    load();
    state.plugins.enabled[String(id)] = !!enabled;
    save();
    return !!enabled;
  }

  function getPluginSettings(id) {
    load();
    var s = state.plugins.settings[String(id)];
    return s && typeof s === 'object' ? clone(s) : {};
  }

  function getPluginSetting(id, key) {
    load();
    var s = state.plugins.settings[String(id)];
    if (!s || typeof s !== 'object') return undefined;
    return s[String(key)];
  }

  function setPluginSetting(id, key, value) {
    load();
    var pid = String(id);
    if (!state.plugins.settings[pid] || typeof state.plugins.settings[pid] !== 'object') {
      state.plugins.settings[pid] = {};
    }
    state.plugins.settings[pid][String(key)] = value;
    save();
    return value;
  }

  /* ------------------------------------------------------------------ *
   * ui / 全局
   * ------------------------------------------------------------------ */

  function getUI() {
    load();
    var out = {};
    var keys = Object.keys(state.ui || {});
    for (var i = 0; i < keys.length; i++) out[keys[i]] = state.ui[keys[i]];
    return out;
  }

  function setUI(patch) {
    load();
    if (!patch || typeof patch !== 'object') return getUI();
    state.ui = state.ui || {};
    var keys = Object.keys(patch);
    for (var i = 0; i < keys.length; i++) state.ui[keys[i]] = patch[keys[i]];
    save();
    return getUI();
  }

  /** 清空会话/插件/UI（保留 prefs 设置） */
  function clearAll() {
    var prefs = state ? getPrefs() : defaultPrefs();
    state = freshState();
    state.prefs = prefs;
    save();
    return state;
  }

  global.Store = {
    KEY: KEY,
    VERSION: VERSION,
    DEFAULT_PREFS: DEFAULT_PREFS,
    defaultPrefs: defaultPrefs,
    load: load,
    save: save,
    getState: getState,

    getPrefs: getPrefs,
    setPrefs: setPrefs,

    createChat: createChat,
    deleteChat: deleteChat,
    renameChat: renameChat,
    touchChat: touchChat,
    updateChat: updateChat,
    getChat: getChat,
    getActiveChat: getActiveChat,
    getActiveChatId: getActiveChatId,
    setActiveChat: setActiveChat,
    listChats: listChats,
    searchChats: searchChats,

    appendMessage: appendMessage,
    updateMessage: updateMessage,
    removeMessage: removeMessage,
    truncateMessages: truncateMessages,
    clearMessages: clearMessages,

    exportChatMarkdown: exportChatMarkdown,
    clearAll: clearAll,

    getCustomModels: getCustomModels,
    setCustomModels: setCustomModels,
    addCustomModel: addCustomModel,
    removeCustomModel: removeCustomModel,

    getPluginEnabled: getPluginEnabled,
    setPluginEnabled: setPluginEnabled,
    getPluginSettings: getPluginSettings,
    getPluginSetting: getPluginSetting,
    setPluginSetting: setPluginSetting,

    getUI: getUI,
    setUI: setUI
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
