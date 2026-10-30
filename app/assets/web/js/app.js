/*!
 * DeepSeek House — app.js
 * 业务控制器：启动流程、登录校验、会话 CRUD、发送/流式渲染/停止/重试、
 * 标题自动生成、推理展示、插件工具调用循环（最多 3 轮）、斜杠命令、
 * 设置保存、插件页、导出、返回键分层、复制。
 *
 * v2.0 追加：
 *   F1 智能体预设（Store.presets + 新建会话选择器 + 请求 systemPrompt 解析）
 *   F2 归档（handlers.onArchiveChat）
 *   F3 JSON 备份导出 / 导入（Bridge.saveTextFile / Bridge.importTextFile + file-imported 事件）
 *   F4 会话分支（Store.forkChat + handlers.onForkMessage）
 *   F5 web_search 工具结果 → assistant 消息 citations（最多 5 条，仅 https）
 *
 * ARCH v2 P1 追加（本地 Agent 工作站）：
 *   L1 原生工具循环（插件 tools + native toolSchemas；execTool/confirmTool/tool-result，最多 5 轮）
 *   工具循环、文件树、终端、审计、工作区
 *   工作区文件树（listDir/readFile）、终端（runShell）、审计（auditRecent）、备份/恢复/fork 回调接线
 *
 * ARCH v2 P2 追加（MCP Client + Termux 构建服务）：
 *   bridge.js 封装 mcpServers/mcpSaveServer/mcpDeleteServer/mcpConnect/mcpDisconnect/mcpRefreshTools
 *   + 事件 mcp-status/mcp-tools/mcp-progress（完整 mock：2 个示例服务器、工具发现、pack_apk 10→100 进度）
 *   app.js：MCP 配置 CRUD / 连接 / 工具缓存（state.mcpTools/mcpToolMap）/ 构建进度映射到 running 工具卡
 *   工具调用本身仍由原生 ToolRegistry 注册并走现有 execTool 路径（MCP 工具自动转发）
 *
 * 约束：只通过 window.UI 改 DOM；不操作 index.html 中的节点。
 * 依赖：window.Util / Bridge / Store / Markdown / Api / DSPlugins / UI
 */
(function (global) {
  'use strict';

  /* v2.0 F3：备份文件格式 */
  var BACKUP_APP_ID = 'DeepSeekHouse';
  var BACKUP_VERSION = 1;
  /* v2.0 F5：引用来源上限 */
  var MAX_CITATIONS = 5;

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
  /* ARCH v2 P1：工具调用最多 5 轮（插件工具 + 原生工具混合） */
  var MAX_TOOL_ROUNDS = 5;
  /* ARCH v2 P2：MCP 构建类工具（工具卡显示进度条 + 日志流） */
  var BUILD_TOOL_NAMES = { 'pack_apk': true, 'repack_apk': true, 'decompile_apk': true, 'run_gradle': true };
  var MCP_LOG_MAX = 200;
  /* ARCH v2 P3：记忆 / 上下文压缩 / 插件市场 */
  var CONTEXT_BUDGET_DEFAULT = 24000; /* 字符预算（tokens ≈ chars / 3.5） */
  var CONTEXT_THRESHOLD = 0.8; /* 预算 80% 触发压缩 */
  var CONTEXT_KEEP_RECENT = 10; /* 压缩时保留最近 N 条消息 */
  var SUMMARY_ENTRY_CHARS = 160;
  var SUMMARY_MAX_ENTRIES = 20;
  var MARKET_URL_KEY = 'dsh.marketUrl';
  var MEMORY_SCOPES = { 'long_term': true, 'project': true };
  /* ARCH v2 P4（F6–F9 / 工作台 / 构建任务） */
  var MAX_PENDING_IMAGES = 4;
  var MAX_IMAGE_DATAURL_CHARS = 220000; /* ≈160KB 图片（base64）阈值：前端无法再压缩时提示 */
  var MAX_BUILD_TASKS = 20;
  var VISION_MODEL_RE = /(vision|vl[-_.]|gpt-4o|gpt-4\.1|gpt-4-turbo|claude|gemini|qwen-vl|glm-4v|omni|multimodal)/i;
  var AUTO_TITLE = false; /* 会话名=智能体名，默认「DeepSeek + 模型型号」，不随首条消息自动改名 */
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
    pluginsBound: false,
    presets: [], /* v2.0 F1：智能体预设（Store.presets 快照） */
    pendingAgentChatId: null, /* v2.0 F1：新建会话时先创建、等待智能体选择的占位会话 */
    /* ARCH v2 P1：原生 Agent / 认证 / 工作区 / 终端 / 审计 */
    nativeTools: {}, /* 原生工具 schema：name -> {risk, def}（native 名称优先） */
    workspace: null,
    filePreview: null,
    pendingShell: {}, /* runShell requestId -> {command, at}（区分终端与工具循环） */
    pendingConfirm: null, /* UI 以 handler 方式确认时使用：allow => void */
    confirmChain: Promise.resolve(),
    /* ARCH v2 P2：MCP Client（配置/状态/工具缓存/构建进度） */
    mcpServers: [], /* [{id,name,url,token,enabled,builtin?}] */
    mcpStatus: {}, /* id -> {status,message,tools:[{name,description}],toolCount} */
    mcpTools: {}, /* id -> [{name,description}]（mcp-tools 缓存快照） */
    mcpToolMap: {}, /* 工具名（base） -> serverId（MCP 工具识别/进度匹配） */
    mcpPageLoaded: false,
    mcpOpening: false, /* 防 UI.openMcpPage → onOpenMcp 重入 */
    /* 工具进度：running 工具消息栈（mcp-progress 事件无 requestId，按工具名/服务器匹配） */
    runningToolMsgs: [], /* [{msgId,chatId,name,base,serverId}] */
    currentToolMsgId: null,
    currentToolName: '',
    currentToolServerId: '',
    mcpProgressByMsg: {}, /* msgId -> {percent,line} */
    /* ARCH v2 P3：插件面板 / 市场 / 记忆 / 上下文压缩 */
    pluginSlots: [],
    market: { url: '', items: [], statusMap: {}, fetchedAt: 0, loading: false, error: '' },
    memory: { loaded: false, long_term: {}, project: {}, summaries: [] },
    memoryOpening: false,
    marketOpening: false,
    pluginPanelOpening: false,
    contextCompressed: {}, /* chatId -> { markerId, count } */
    contextSummaryOverride: {}, /* chatId -> 最新会话摘要（压缩后立即注入，避免原生异步写延迟） */
    /* ARCH v2 P4：待发送图片 / 前台状态 / 构建任务 */
    pendingImages: [], /* [{dataUrl,width,height,name}]（≤4 张） */
    appForeground: true, /* 原生 app-state 事件 */
    foregroundActive: false, /* 是否已启动 F7 前台服务 */
    buildTasks: [], /* [{id,toolName,serverId,percent,status,line,lines,updatedAt}] */
    buildTaskByMsg: {}, /* msgId -> buildTask id */
    buildTaskSeq: 0
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

  /** v2.0 F3：备份文件名用 YYYYMMDD */
  function backupDateStamp() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate());
  }

  /** v2.0 F3：备份内的 exportedAt 展示（容错解析 ISO / 数字时间戳） */
  function formatBackupTime(value) {
    var ts = NaN;
    if (typeof value === 'number') ts = value;
    else if (typeof value === 'string') ts = Date.parse(value);
    if (!isFinite(ts) || isNaN(ts)) return '';
    try {
      var d = new Date(ts);
      function p(n) { return n < 10 ? '0' + n : String(n); }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) {
      return '';
    }
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
    loadPresets();
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
    /* ARCH v2 P1：初始化工作区信息（设置页文件树头部显示 root；旧原生会得到空值） */
    try { refreshWorkspaceInfo(); } catch (e4) { warn('初始化工作区失败：' + errText(e4)); }

    if (!state.apiKey) {
      state.nav = { screen: 'login', drawerOpen: false };
      setBackDepth(0);
      ui('showScreen', 'login');
      ui('renderLogin', { hasKey: false, busy: false });
    } else {
      enterChats();
    }

    loadPlugins(false);
    /* ARCH v2 P3：HousePlugin 宿主加载 + uiSlots 渲染（plugins.js 未实现时安全跳过） */
    try { loadHousePluginsAndSlots(); } catch (e5) { warn('加载 HousePlugin 失败：' + errText(e5)); }

    /* ARCH v2 P4：应用锁初值 / 工作台布局 / 本地加密加载与错误提示 */
    try {
      if (global.Bridge && typeof global.Bridge.isAppLockEnabled === 'function') {
        state.prefs.appLock = !!global.Bridge.isAppLockEnabled();
      }
    } catch (e6) { warn('读取应用锁状态失败：' + errText(e6)); }
    try { applyWorkbenchFromPrefs(); } catch (e7) { warn('应用工作台布局失败：' + errText(e7)); }
    try {
      if (global.Store && typeof global.Store.onError === 'function') {
        global.Store.onError(function (message) { if (message) toast(String(message), true); });
      }
    } catch (e8) { /* ignore */ }
    try {
      if (global.Store && typeof global.Store.onLoad === 'function') {
        global.Store.onLoad(function () { refreshAfterStoreLoad(); });
      }
      if (global.Store && typeof global.Store.isReady === 'function' && !global.Store.isReady()) {
        Promise.resolve(global.Store.loadAsync()).then(function () { refreshAfterStoreLoad(); });
      }
    } catch (e9) { warn('注册本地存储加载监听失败：' + errText(e9)); }
    return App;
  }

  /* ---------------- 底部三标签：聊天 / 联系人 / 个人资料 ---------------- */

  var TIP_KEY = 'dsh.tipDismissed';

  function isTipDismissed() {
    try { return global.localStorage.getItem(TIP_KEY) === '1'; } catch (e) { return false; }
  }

  function dismissTip() {
    try { global.localStorage.setItem(TIP_KEY, '1'); } catch (e) { /* ignore */ }
    var U = getUI();
    if (U && typeof U.setTipVisible === 'function') U.setTipVisible(false);
  }

  function applyTipVisibility() {
    var U = getUI();
    if (U && typeof U.setTipVisible === 'function') U.setTipVisible(!isTipDismissed());
  }

  function showChatsScreen() {
    state.nav = { screen: 'chats', drawerOpen: false };
    ui('showScreen', 'chats');
    refreshChatList();
    applyTipVisibility();
    setBackDepth(0);
  }

  var PROFILE_KEY = 'dsh.profile';
  var SHARE_HISTORY_KEY = 'dsh.shareHistory';
  var SHARE_OPTS_KEY = 'dsh.shareOpts';

  function loadProfile() {
    var defaults = { name: 'DeepSeek House', bio: '' };
    try {
      var raw = global.localStorage.getItem(PROFILE_KEY);
      if (!raw) return defaults;
      var parsed = JSON.parse(raw) || {};
      return {
        name: parsed.name ? String(parsed.name).slice(0, 40) : defaults.name,
        bio: parsed.bio ? String(parsed.bio).slice(0, 200) : ''
      };
    } catch (e) { return defaults; }
  }

  function saveProfile(profile) {
    try { global.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (e) { /* ignore */ }
  }

  function enabledPluginCount() {
    try {
      var P = global.DSPlugins;
      if (!P || typeof P.list !== 'function') return 0;
      return (P.list() || []).filter(function (plugin) { return plugin && plugin.enabled; }).length;
    } catch (e) { return 0; }
  }

  function loadShareHistory() {
    try {
      var raw = global.localStorage.getItem(SHARE_HISTORY_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.slice(0, 10) : [];
    } catch (e) { return []; }
  }

  function pushShareHistory(title) {
    var list = loadShareHistory();
    list.unshift({ title: String(title || '聊天记录'), time: shareTimestamp(Date.now()) });
    list = list.slice(0, 10);
    try { global.localStorage.setItem(SHARE_HISTORY_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
    var U = getUI();
    if (U && typeof U.renderShareHistory === 'function') U.renderShareHistory(list);
    return list;
  }

  function copyCurrentChat() {
    var chat = Store.getActiveChat();
    if (!chat) { toast('没有当前会话'); return; }
    var text = buildShareText(chat, getShareOptions());
    if (!text) { toast('会话为空，暂无可复制内容'); return; }
    var B = global.Bridge;
    try {
      if (B && typeof B.setClipboard === 'function') { B.setClipboard(text); toast('已复制当前会话'); return; }
    } catch (e) { warn('复制失败：' + errText(e)); }
    toast('复制失败');
  }

  function exportCurrentChat() {
    var chat = Store.getActiveChat();
    if (!chat) { toast('没有当前会话'); return; }
    var md = '';
    try { md = Store.exportChatMarkdown(chat.id) || ''; } catch (e) { warn('导出失败：' + errText(e)); }
    if (!md) { toast('会话为空，暂无可导出内容'); return; }
    var text = md + '\n\n—— DeepSeek House · @惜白.\n';
    var B = global.Bridge;
    try {
      if (B && typeof B.saveTextFile === 'function') { B.saveTextFile((chat.title || 'DeepSeek-对话') + '.md', text); toast('正在导出…'); return; }
      if (B && typeof B.setClipboard === 'function') { B.setClipboard(text); toast('已复制 Markdown'); return; }
    } catch (e2) { warn('导出失败：' + errText(e2)); }
    toast('导出失败');
  }

  function editProfile() {
    var profile = loadProfile();
    promptAsync('编辑昵称', profile.name, '例如 DeepSeek House').then(function (name) {
      if (name === null || name === undefined) return;
      profile.name = String(name).replace(/^\s+|\s+$/g, '') || 'DeepSeek House';
      return promptAsync('编辑简介', profile.bio || '', '一句话介绍自己（可留空）').then(function (bio) {
        if (bio === null || bio === undefined) return;
        profile.bio = String(bio).replace(/^\s+|\s+$/g, '').slice(0, 200);
        saveProfile(profile);
        if (state.nav.screen === 'profile') showProfile();
        toast('资料已更新');
      });
    });
  }

  function getShareOptions() {
    var defaults = { time: false, reasoning: false, signature: true };
    try {
      var raw = global.localStorage.getItem(SHARE_OPTS_KEY);
      if (!raw) return defaults;
      var parsed = JSON.parse(raw) || {};
      return {
        time: !!parsed.time,
        reasoning: !!parsed.reasoning,
        signature: parsed.signature === undefined ? true : !!parsed.signature
      };
    } catch (e) { return defaults; }
  }

  function saveShareOptions(opts) {
    try { global.localStorage.setItem(SHARE_OPTS_KEY, JSON.stringify(opts)); } catch (e) { /* ignore */ }
  }

  function shareTimestamp(ts) {
    try {
      var d = new Date(Number(ts) || Date.now());
      var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
        ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    } catch (e) { return ''; }
  }

  /** 按分享选项生成纯文本聊天记录 */
  function buildShareText(chat, opts) {
    opts = opts || getShareOptions();
    var title = chat && chat.title ? String(chat.title) : 'DeepSeek 对话';
    var lines = ['【' + title + '】', ''];
    var messages = (chat && chat.messages) || [];
    var speaker = title;
    messages.forEach(function (m) {
      if (!m || m.role === 'tool' || m.role === 'note') return;
      var content = String(m.content == null ? '' : m.content).replace(/\s+$/, '');
      var reasoning = String(m.reasoning == null ? '' : m.reasoning).replace(/\s+$/, '');
      if (!content && !reasoning) return;
      var who = m.role === 'user' ? '我' : speaker;
      var prefix = opts.time ? '[' + shareTimestamp(m.createdAt) + '] ' : '';
      if (opts.reasoning && reasoning) {
        lines.push(prefix + who + '（思考过程）：');
        lines.push(reasoning);
        lines.push('');
      }
      if (content) {
        lines.push(prefix + who + '：');
        lines.push(content);
        lines.push('');
      }
    });
    if (opts.signature) lines.push('—— DeepSeek House · @惜白.');
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
  }

  function setShareOption(key, on) {
    var opts = getShareOptions();
    if (key !== 'time' && key !== 'reasoning' && key !== 'signature') return;
    opts[key] = !!on;
    saveShareOptions(opts);
    var U = getUI();
    if (U && typeof U.setShareOptions === 'function') U.setShareOptions(opts);
  }

  function exportAllChats() {
    var chats = Store.listChats();
    if (!chats.length) { toast('还没有可导出的会话'); return; }
    var parts = [];
    chats.forEach(function (chat) {
      var md = '';
      try { md = Store.exportChatMarkdown(chat.id) || ''; } catch (e) { warn('导出失败：' + errText(e)); }
      if (md) parts.push(md);
    });
    if (!parts.length) { toast('会话为空，暂无可导出内容'); return; }
    var text = '# DeepSeek House 聊天记录\n\n' + parts.join('\n\n---\n\n') +
      '\n\n---\n\n*DeepSeek House · @惜白.*\n';
    var B = global.Bridge;
    try {
      if (B && typeof B.saveTextFile === 'function') {
        if (B.saveTextFile('DeepSeekHouse-聊天记录.md', text) !== false) {
          toast('正在导出全部会话…');
          return;
        }
      }
      if (B && typeof B.setClipboard === 'function') { B.setClipboard(text); toast('已复制全部聊天记录'); return; }
    } catch (e2) { warn('导出全部失败：' + errText(e2)); }
    toast('导出失败');
  }

  function clearAllChats() {
    confirmAsync('清空所有会话', '将删除本机保存的全部会话记录（不可恢复），API Key 与设置保留。').then(function (ok2) {
      if (!ok2) return;
      try { Store.clearAll(); } catch (e) { warn('清空失败：' + errText(e)); }
      refreshChatList();
      if (state.nav.screen === 'chat') { ui('showScreen', 'chats'); state.nav = { screen: 'chats', drawerOpen: false }; setBackDepth(0); }
      toast('已清空所有会话');
    });
  }

  function showAbout() {
    confirmAsync('关于 DeepSeek House',
      '版本 1.1.0 · 开源 MIT\n仿 Telegram 的 DeepSeek 安卓客户端\n由 @惜白. 定制\nhttps://github.com/yzxcrush/deepseek-house')
      .then(function () { /* 仅展示 */ });
  }

  function showShare() {
    state.nav = { screen: 'share', drawerOpen: false };
    var chats = [];
    try { chats = Store.listChats(); } catch (e) { chats = []; }
    ui('renderShareList', chats);
    var U = getUI();
    if (U && typeof U.setShareOptions === 'function') U.setShareOptions(getShareOptions());
    if (U && typeof U.renderShareHistory === 'function') U.renderShareHistory(loadShareHistory());
    ui('showScreen', 'share');
    setBackDepth(0);
  }

  /** 分享整段聊天记录：系统分享面板（原生 ACTION_SEND） */
  function shareChat(id) {
    var chat = Store.getChat(id) || Store.getActiveChat();
    if (!chat) { toast('没有可分享的会话'); return; }
    var text = buildShareText(chat, getShareOptions());
    if (!text) { toast('会话为空，暂无可分享内容'); return; }
    var B = global.Bridge;
    try {
      if (B && typeof B.shareText === 'function') {
        if (B.shareText(chat.title || '聊天记录', text) !== false) {
          pushShareHistory(chat.title || '聊天记录');
          return;
        }
      }
      if (B && typeof B.setClipboard === 'function') {
        B.setClipboard(text);
        toast('已复制聊天记录，可粘贴分享');
        return;
      }
    } catch (e2) { warn('分享失败：' + errText(e2)); }
    toast('分享失败');
  }

  function showProfile() {
    state.nav = { screen: 'profile', drawerOpen: false };
    var status = state.apiKey
      ? 'API Key 已配置 · ' + labelForModelId(state.prefs.model)
      : '未配置 API Key';
    var chats = [];
    try { chats = Store.listChats(); } catch (e) { chats = []; }
    var messages = 0;
    chats.forEach(function (chat) { messages += (chat.messages || []).length; });
    var infoRows = [
      { label: 'API Key', value: state.apiKey ? '已配置' : '未配置' },
      { label: 'Base URL', value: state.prefs.baseUrl || 'https://api.deepseek.com' },
      { label: '当前模型', value: labelForModelId(state.prefs.model) },
      { label: '版本', value: '2.4.1' }
    ];
    var profile = loadProfile();
    ui('renderProfile', {
      name: profile.name,
      bio: profile.bio,
      status: status,
      rows: infoRows,
      chats: chats.length,
      messages: messages,
      plugins: enabledPluginCount()
    });
    ui('showScreen', 'profile');
    setBackDepth(0);
  }

  /* Telegram 式首屏：会话列表（Home） */
  function enterChats() {
    state.nav = { screen: 'chats', drawerOpen: false };
    ui('showScreen', 'chats');
    ui('setUser', { name: 'DeepSeek 用户' });
    ui('setModel', state.prefs.model);
    applyModelLabel();
    // B1：启动/登录成功后静默拉取 GET /models，失败则保留内置回退目录
    refreshModelsFromApi({});
    refreshChatList();
    applyTipVisibility();
    setBackDepth(0);
  }

  /* 进入某个会话（对话页从右侧推入） */
  function enterChat(chat) {
    chat = chat || ensureActiveChat();
    var cameFrom = state.nav && state.nav.from ? state.nav.from : 'chats';
    state.nav = { screen: 'chat', drawerOpen: false, from: cameFrom };
    ui('showScreen', 'chat');
    ui('setUser', { name: 'DeepSeek 用户' });
    ui('setModel', state.prefs.model);
    applyModelLabel();
    refreshChatList();
    try { if (typeof Store.clearUnread === 'function') Store.clearUnread(chat.id); } catch (e0) { /* ignore */ }
    refreshChatList();
    ui('renderMessages', chat);
    ui('setChatAvatar', chat);
    ui('setStreaming', false);
    ui('setComposer', { value: '', busy: false });
    setHeader(chat, '');
    setBackDepth(1);
    ui('scrollBottom', true);
  }

  function ensureActiveChat() {
    var chat = Store.getActiveChat();
    if (chat) return chat;
    var chats = Store.listChats();
    if (chats.length) {
      Store.setActiveChat(chats[0].id);
      return Store.getChat(chats[0].id);
    }
    chat = Store.createChat({ model: state.prefs.model, title: defaultAgentTitle(state.prefs.model) });
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
    if (screen === 'settings' || screen === 'plugins') setBackDepth(state.nav.from === 'chat' ? 2 : 1);
    else if (screen === 'agents') setBackDepth(state.nav.from === 'chat' ? 3 : 2);
    else if (screen === 'chat') setBackDepth(1);
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
    /* ARCH v2 P1：审计日志是 UI 内部屏幕（state.nav 仍是 profile）—— 硬件返回键先回个人资料，
       与 UI 顶栏返回/ESC 行为保持一致（arch-ui 契约）。 */
    var U = getUI();
    if (U && typeof U.getScreen === 'function') {
      var uiScreen = '';
      try { uiScreen = String(U.getScreen() || ''); } catch (e) { uiScreen = ''; }
      if (uiScreen === 'audit') {
        closeDrawer();
        showProfile();
        return;
      }
      /* ARCH v2 P2：MCP 管理页是 UI 内部屏幕（nav.screen 仍是 settings/来源页）→ 硬件返回回设置页 */
      if (uiScreen === 'mcp') {
        closeDrawer();
        if (state.nav.screen !== 'settings') {
          state.nav = { screen: 'settings', drawerOpen: false, from: state.nav.screen || 'chats' };
        }
        ui('showScreen', 'settings');
        setBackDepth(state.nav.from === 'chat' ? 2 : 1);
        return;
      }
      /* ARCH v2 P3：市场/记忆页是 UI 内部屏幕 → 硬件返回回设置页 */
      if (uiScreen === 'market' || uiScreen === 'memory') {
        closeDrawer();
        if (state.nav.screen !== 'settings') {
          state.nav = { screen: 'settings', drawerOpen: false, from: state.nav.screen || 'chats' };
        }
        ui('showScreen', 'settings');
        setBackDepth(state.nav.from === 'chat' ? 2 : 1);
        return;
      }
    }
    /* ARCH v2 P3：插件面板打开时，硬件返回先关闭面板（面板从聊天页打开，不清空返回栈） */
    if (U && typeof U.isPluginPanelOpen === 'function' && U.isPluginPanelOpen()) {
      try {
        if (typeof U.closePluginPanel === 'function') U.closePluginPanel();
      } catch (e) { /* ignore */ }
      return;
    }
    if (screen === 'chats') {
      closeDrawer();
      try { if (global.Bridge && global.Bridge.finishApp) global.Bridge.finishApp(); } catch (e) { /* ignore */ }
      return;
    }
    if (screen === 'share' || screen === 'profile') {
      closeDrawer();
      showChatsScreen();
      return;
    }
    if (screen === 'chat') {
      closeDrawer();
      var from = state.nav.from === 'share' ? 'share' : 'chats';
      if (from === 'share') showShare(); else showChatsScreen();
      return;
    }
    /* 设置 / 插件页 → 回到来源页（对话页或某个标签页） */
    if (screen === 'agents') { closeAgents(); return; }
    closeDrawer();
    var back = state.nav.from || 'chats';
    if (back === 'share') { showShare(); return; }
    if (back === 'profile') { showProfile(); return; }
    if (back !== 'chat') { showChatsScreen(); return; }
    var chat = Store.getActiveChat();
    ui('showScreen', 'chat');
    state.nav.screen = 'chat';
    setBackDepth(1);
    if (chat) {
      ui('setChatAvatar', chat);
      setHeader(chat, '');
      ui('renderMessages', chat);
      ui('scrollBottom', true);
    }
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
    /* v2.0 F3：备份文件导入事件（{name, content}；取消时 content 为空 / error:'cancelled'，静默） */
    B.onEvent('file-imported', function (evt) { onFileImported(evt); });
    B.onEvent('tool-result', function (evt) {
      if (!evt || !evt.requestId) return;
      var pending = state.pendingShell[evt.requestId];
      if (!pending) return; /* 不是终端请求：交给工具循环的 per-request 监听 */
      delete state.pendingShell[evt.requestId];
      appendTerminalResult(evt, pending);
    });
    /* 原生 setWorkspace 异步完成后的补充事件 {ok,root,message,allFilesAccess} */
    B.onEvent('workspace-changed', function (evt) { onWorkspaceChanged(evt); });
    /* ARCH v2 P2：MCP 状态 / 工具发现 / 构建进度事件 */
    B.onEvent('mcp-status', function (evt) { onMcpStatus(evt); });
    B.onEvent('mcp-tools', function (evt) { onMcpTools(evt); });
    B.onEvent('mcp-progress', function (evt) { onMcpProgress(evt); });
    /* ARCH v2 P4：F7 前台状态 / F8 分享进入 */
    B.onEvent('app-state', function (evt) {
      if (!evt) return;
      state.appForeground = evt.foreground !== false;
    });
    B.onEvent('shared', function (evt) { onSharedEvent(evt); });
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
      /* v2.0 F1：智能体预设 */
      onPickAgent: safe(function (id) { return onPickAgent(id); }, 'onPickAgent'),
      onOpenAgents: safe(function () { return openAgents(); }, 'onOpenAgents'),
      onManageAgents: safe(function () { return openAgents(); }, 'onManageAgents'),
      /* 智能体预设管理页返回：恢复打开前的界面（对话页 / 设置页 / 会话列表） */
      onCloseAgents: safe(function () { return closeAgents(); }, 'onCloseAgents'),
      onSaveAgent: safe(function (agent) { return saveAgent(agent); }, 'onSaveAgent'),
      onDeleteAgent: safe(function (id) { return deleteAgent(id); }, 'onDeleteAgent'),
      onResetAgents: safe(function () { return resetAgents(); }, 'onResetAgents'),
      /* v2.0 F2：归档 */
      onArchiveChat: safe(function (id, archived) { return archiveChat(id, archived); }, 'onArchiveChat'),
      onToggleArchive: safe(function (id, archived) { return archiveChat(id, archived); }, 'onToggleArchive'),
      onChatTab: safe(function (tab) {
        state.chatTab = tab === 'archived' ? 'archived' : (tab === 'unread' ? 'unread' : 'all');
        return true;
      }, 'onChatTab'),
      /* v2.0 F4：从消息新建分支 */
      onForkMessage: safe(function (msgId) { return forkMessage(msgId); }, 'onForkMessage'),
      /* v2.0 F3：备份 / 恢复 */
      onExportBackup: safe(function () { return exportBackup(); }, 'onExportBackup'),
      onImportBackup: safe(function () { return importBackup(); }, 'onImportBackup'),
      onBackupExport: safe(function () { return exportBackup(); }, 'onBackupExport'),
      onBackupImport: safe(function () { return importBackup(); }, 'onBackupImport'),
      onSelectChat: safe(function (id) { selectChat(id); }, 'onSelectChat'),
      onDeleteChat: safe(function (id) { deleteChat(id, true); }, 'onDeleteChat'),
      onRenameChat: safe(function (id, title) { renameChat(id, title); }, 'onRenameChat'),
      onRetry: safe(function (msgId) { retryMessage(msgId); return true; }, 'onRetry'),
      onRegenerate: safe(function (msgId) { retryMessage(msgId); return true; }, 'onRegenerate'),
      onNavChats: safe(function () { showChatsScreen(); return true; }, 'onNavChats'),
      onNavShare: safe(function () { showShare(); return true; }, 'onNavShare'),
      onNavProfile: safe(function () { showProfile(); return true; }, 'onNavProfile'),
      onShareChat: safe(function (id) { shareChat(id); return true; }, 'onShareChat'),
      onShareOption: safe(function (key, on) { setShareOption(key, on); return true; }, 'onShareOption'),
      onExportAll: safe(function () { exportAllChats(); return true; }, 'onExportAll'),
      onClearAll: safe(function () { clearAllChats(); return true; }, 'onClearAll'),
      onAbout: safe(function () { showAbout(); return true; }, 'onAbout'),
      onCopyCurrent: safe(function () { copyCurrentChat(); return true; }, 'onCopyCurrent'),
      onExportCurrent: safe(function () { exportCurrentChat(); return true; }, 'onExportCurrent'),
      onEditProfile: safe(function () { editProfile(); return true; }, 'onEditProfile'),
      onDismissTip: safe(function () { dismissTip(); return true; }, 'onDismissTip'),
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
      }, 'onTogglePin'),
      /* ARCH v2 P1：工作区文件树 / 终端 / 审计 / 工作区切换 */
      onOpenFile: safe(function (path, isDir) { return onOpenFile(path, isDir); }, 'onOpenFile'),
      onListDir: safe(function (path) { return loadWorkspaceDir(path); }, 'onListDir'),
      onOpenWorkspace: safe(function () { refreshWorkspaceInfo(); return loadWorkspaceDir(''); }, 'onOpenWorkspace'),
      onRefreshWorkspace: safe(function () { return loadWorkspaceDir(''); }, 'onRefreshWorkspace'),
      onRunShell: safe(function (command) { return runShellCommand(command); }, 'onRunShell'),
      onOpenAudit: safe(function () { return openAudit(); }, 'onOpenAudit'),
      onSetWorkspace: safe(function (path) { return setWorkspace(path); }, 'onSetWorkspace'),
      /* 恢复默认工作区（UI 设置页「恢复默认工作区」按钮；无 defaultRoot 时返回 false 由 UI 兜底） */
      onResetWorkspace: safe(function () { return resetWorkspace(); }, 'onResetWorkspace'),
      /* UI 以 handler 方式确认高危工具时（UI.confirmRisk 存在则优先用 Promise 版本） */
      onToolConfirm: safe(function (allow) {
        if (typeof state.pendingConfirm === 'function') { state.pendingConfirm(!!allow); return true; }
        return false;
      }, 'onToolConfirm'),
      /* ARCH v2 P2：MCP 服务器管理 */
      onOpenMcp: safe(function () {
        if (state.mcpOpening) return state.mcpServers;
        return openMcpPage();
      }, 'onOpenMcp'),
      onMcpList: safe(function () {
        if (state.mcpOpening) return state.mcpServers;
        return openMcpPage();
      }, 'onMcpList'),
      onCloseMcp: safe(function () { return true; }, 'onCloseMcp'),
      onMcpSave: safe(function (server) { return saveMcpServer(server); }, 'onMcpSave'),
      onMcpDelete: safe(function (id) { return deleteMcpServer(id); }, 'onMcpDelete'),
      onMcpConnect: safe(function (id) { return connectMcpServer(id); }, 'onMcpConnect'),
      onMcpDisconnect: safe(function (id) { return disconnectMcpServer(id); }, 'onMcpDisconnect'),
      onMcpRefresh: safe(function (id) { return refreshMcpServerTools(id); }, 'onMcpRefresh'),
      onMcpTest: safe(function (id) { return testMcpServer(id); }, 'onMcpTest'),
      /* ARCH v2 P3：插件面板 / 插件市场 / 记忆 */
      onOpenPluginPanel: safe(function () {
        if (state.pluginPanelOpening) return state.pluginSlots;
        return refreshPluginSlots();
      }, 'onOpenPluginPanel'),
      onSlotAction: safe(function (slotId, action, payload) { return runPluginSlotAction(slotId, action, payload); }, 'onSlotAction'),
      onOpenMarket: safe(function () { return loadMarketData(); }, 'onOpenMarket'),
      onMarketFetch: safe(function (url) { return fetchMarketIndex(url); }, 'onMarketFetch'),
      onMarketInstall: safe(function (item) { return installMarketItem(item); }, 'onMarketInstall'),
      onMarketRemove: safe(function (id) { return removeMarketItem(id); }, 'onMarketRemove'),
      onCloseMarket: safe(function () { return true; }, 'onCloseMarket'),
      onOpenMemory: safe(function () { return refreshMemoryPage(); }, 'onOpenMemory'),
      onMemorySave: safe(function (scope, key, value) { return saveMemoryItem(scope, key, value); }, 'onMemorySave'),
      onMemoryDelete: safe(function (scope, key) { return deleteMemoryItem(scope, key); }, 'onMemoryDelete'),
      onSummaryDelete: safe(function (chatId) { return deleteSessionSummary(chatId); }, 'onSummaryDelete'),
      onCloseMemory: safe(function () { return true; }, 'onCloseMemory'),
      /* ARCH v2 P4：工作台 / 图片 / 通知 / 应用锁 / 构建任务 / MCP 统计 */
      onToggleWorkbench: safe(function (enabled) { return toggleWorkbench(enabled); }, 'onToggleWorkbench'),
      onTerminalResized: safe(function (height) { return persistTerminalHeight(height); }, 'onTerminalResized'),
      onPickImage: safe(function (source) { return pickImageSource(source); }, 'onPickImage'),
      onRemoveImage: safe(function (index) { return removePendingImageAt(index); }, 'onRemoveImage'),
      onSendWithImages: safe(function (text, images) { return sendWithImages(text, images); }, 'onSendWithImages'),
      onToggleAppLock: safe(function (enabled) { return toggleAppLock(enabled); }, 'onToggleAppLock'),
      onToggleRootMode: safe(function (enabled) { return toggleRootMode(enabled); }, 'onToggleRootMode'),
      onRefreshSecurity: safe(function () { return refreshSecurityInfo(); }, 'onRefreshSecurity'),
      onGetSecurity: safe(function () { return refreshSecurityInfo(); }, 'onGetSecurity'),
      onOpenBuildPanel: safe(function () { return openBuildPanel(); }, 'onOpenBuildPanel'),
      onRefreshMcpStats: safe(function () { return refreshMcpStatsUI(); }, 'onRefreshMcpStats')
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
        enterChats();
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
    /* ARCH v2 P4 F6：普通发送也会带上待发送图片队列（UI 有图时通常会走 onSendWithImages） */
    var images = takePendingImages();
    return handleSendInternal(text, images);
  }

  /** 发送（可带图片 dataUrl 数组）；返回是否已开始请求 */
  function handleSendInternal(text, images) {
    if (state.loginBusy) return false;
    if (state.busy) { toast('正在生成回复，请先停止'); return false; }
    var raw = String(text === null || text === undefined ? '' : text);
    var trimmed = raw.replace(/^\s+|\s+$/g, '');
    var imageList = normalizeImageDataUrls(images);
    if (!trimmed && !imageList.length) return false;
    if (trimmed.charAt(0) === '/' && !imageList.length) { handleCommand(trimmed); return false; }
    if (trimmed.length > MAX_INPUT) { toast('消息太长，最多 ' + MAX_INPUT + ' 字'); return false; }
    if (!imageList.length) {
      var t = Date.now();
      if (trimmed === state.lastSentText && t - state.lastSentAt < 800) return false;
      state.lastSentText = trimmed;
      state.lastSentAt = t;
    } else {
      state.lastSentText = trimmed;
      state.lastSentAt = Date.now();
    }

    var chat = ensureActiveChat();
    if (!chat) return false;
    var meta = imageMetaFrom(images);
    var payload = { role: 'user', content: trimmed };
    if (imageList.length) {
      payload.images = imageList;
      payload.imageMeta = meta.length === imageList.length ? meta : imageList.map(function (url, idx) {
        return meta[idx] || { width: 0, height: 0, name: '图片 ' + (idx + 1) };
      });
    }
    var userMsg = Store.appendMessage(chat.id, payload);
    if (!userMsg) return false;
    state.toolRounds = 0;
    resetBuffer();
    ui('appendMessage', userMsg);
    ui('setComposer', { value: '', busy: true });
    ui('scrollBottom', true);
    refreshChatList();
    if (imageList.length && !modelSupportsVision(chat.model || state.prefs.model)) {
      toast('当前模型可能不支持图片识别，仍将发送', true);
    }
    maybeAutoTitle(chat, trimmed || '图片消息');
    startAssistantRound(chat.id);
    return true;
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
    /* ARCH v2 P4 F7：生成期间启动前台服务 */
    startForegroundService();

    var tools = getToolSchemas();
    var baseMessages = requestHistory(chatId, aMsg.id);
    /* v2.0 F1：system prompt 取值 chat.systemPrompt → preset.systemPrompt → prefs.systemPrompt */
    var sendPrefs = {};
    var prefKeys = Object.keys(state.prefs || {});
    for (var pk = 0; pk < prefKeys.length; pk++) sendPrefs[prefKeys[pk]] = state.prefs[prefKeys[pk]];
    var basePrompt = resolveSystemPrompt(chat);
    /* ARCH v2 P3：超预算先压缩历史（保留最近 10 条），再按新摘要重新组装 system prompt */
    var messages = prepareContextMessages(chat, baseMessages, basePrompt, tools);
    sendPrefs.systemPrompt = resolveSystemPrompt(chat);
    var requestId = Api.send({
      chat: chat,
      messages: messages,
      tools: tools,
      prefs: sendPrefs,
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
        endGeneration(chatId, content);
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
    endGeneration(chatId, content || reasoning);
    Store.touchChat(chatId);
    if (typeof Store.incrementUnread === 'function') {
      var viewing = String(Store.getActiveChatId()) === String(chatId) && state.nav && state.nav.screen === 'chat';
      if (!viewing) Store.incrementUnread(chatId);
    }
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
    endGeneration(chatId, '生成失败');
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
      endGeneration(chatId, content === '（已停止生成）' ? '已停止生成' : content);
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

  /* ------------------------------------------------------------------ *
   * v2.0 F5：web_search 结果 → citations
   * ------------------------------------------------------------------ */

  /** 解析工具返回的 {query,results:[{title,url,snippet}]}；失败/无 https 结果返回 null */
  function extractSearchCitations(resultText) {
    var text = String(resultText === null || resultText === undefined ? '' : resultText).replace(/^\s+|\s+$/g, '');
    if (!text || text.charAt(0) !== '{') return null;
    var parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { return null; }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.results)) return null;
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < parsed.results.length && out.length < MAX_CITATIONS; i++) {
      var item = parsed.results[i];
      if (!item || typeof item !== 'object') continue;
      var url = String(item.url === null || item.url === undefined ? '' : item.url).replace(/^\s+|\s+$/g, '');
      if (!/^https:\/\//i.test(url)) continue; /* 仅 https */
      if (seen[url]) continue;
      seen[url] = true;
      var title = String(item.title === null || item.title === undefined ? url : item.title).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
      var snippet = String(item.snippet === null || item.snippet === undefined
        ? (item.content === undefined ? '' : item.content)
        : item.snippet).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
      out.push({
        title: (title || url).slice(0, 200),
        url: url.slice(0, 2048),
        snippet: snippet.slice(0, 400)
      });
    }
    return out.length ? out : null;
  }

  /** 把 web_search 结果写入当前 assistant 消息 citations（去重、最多 5 条） */
  function captureCitations(toolName, resultText) {
    if (String(toolName || '') !== 'web_search') return false;
    var list = extractSearchCitations(resultText);
    if (!list || !list.length) return false;
    var assistantId = state.assistantMsgId;
    if (!assistantId) return false;
    var chatId = state.requestChatId;
    var chat = chatId ? Store.getChat(chatId) : Store.getActiveChat();
    if (!chat) return false;
    var target = null;
    for (var i = 0; i < chat.messages.length; i++) {
      if (chat.messages[i].id === assistantId) { target = chat.messages[i]; break; }
    }
    if (!target) return false;
    var merged = Array.isArray(target.citations) ? target.citations.slice() : [];
    var seen = Object.create(null);
    for (var m = 0; m < merged.length; m++) seen[merged[m].url] = true;
    for (var k = 0; k < list.length && merged.length < MAX_CITATIONS; k++) {
      if (seen[list[k].url]) continue;
      seen[list[k].url] = true;
      merged.push(list[k]);
    }
    if (!merged.length) return false;
    try {
      Store.updateMessage(chat.id, assistantId, { citations: merged });
    } catch (e) {
      warn('写入引用失败：' + errText(e));
      return false;
    }
    ui('updateMessage', assistantId, { citations: merged });
    return true;
  }

  /* ------------------------------------------------------------------ *
   * ARCH v2 P1：工具循环（插件工具 + 原生工具，native 名称优先）
   * ------------------------------------------------------------------ */

  var requestSeq = 0;

  function genAgentRequestId(prefix) {
    requestSeq++;
    return (prefix || 'p1') + '_' + Date.now().toString(36) + '_' + requestSeq + '_' +
      Math.random().toString(36).slice(2, 7);
  }

  function toolSchemaName(schema) {
    if (!schema || typeof schema !== 'object') return '';
    var fn = schema.function || schema;
    var name = schema.name !== undefined && schema.name !== null ? schema.name : fn.name;
    return name === null || name === undefined ? '' : String(name);
  }

  function toolSchemaRisk(schema) {
    if (!schema || typeof schema !== 'object') return 'high';
    var risk = schema.risk || (schema.function && schema.function.risk) || '';
    var s = String(risk).toLowerCase();
    return s === 'low' || s === 'mid' || s === 'high' ? s : 'high';
  }

  function isNativeTool(name) {
    return !!(state.nativeTools && Object.prototype.hasOwnProperty.call(state.nativeTools, String(name || '')));
  }

  /**
   * 请求 tools = 已启用插件 toolSchemas() + Bridge.toolSchemas()（原生工具）。
   * 去重：native 名称优先；同名插件工具被忽略并 console.warn。
   * 同时刷新 state.nativeTools（execOneTool 用它判定走原生还是插件路径）。
   */
  function getToolSchemas() {
    var pluginTools = [];
    try {
      if (global.DSPlugins && typeof global.DSPlugins.toolSchemas === 'function') {
        var list = global.DSPlugins.toolSchemas();
        if (Array.isArray(list)) pluginTools = list;
      }
    } catch (e) {
      warn('获取插件工具列表失败：' + errText(e));
    }
    var nativeTools = [];
    try {
      if (global.Bridge && typeof global.Bridge.toolSchemas === 'function') {
        var nlist = global.Bridge.toolSchemas();
        if (Array.isArray(nlist)) nativeTools = nlist;
      }
    } catch (e2) {
      warn('获取原生工具列表失败：' + errText(e2));
    }
    var nativeMap = {};
    var i;
    for (i = 0; i < nativeTools.length; i++) {
      var n = toolSchemaName(nativeTools[i]);
      if (!n) continue;
      nativeMap[n] = { risk: toolSchemaRisk(nativeTools[i]), def: nativeTools[i] };
    }
    state.nativeTools = nativeMap;

    var out = [];
    var seen = {};
    for (i = 0; i < pluginTools.length; i++) {
      var pn = toolSchemaName(pluginTools[i]);
      if (!pn) continue;
      if (nativeMap[pn]) {
        warn('工具名冲突：' + pn + '（native 优先，已忽略同名插件工具）');
        continue;
      }
      if (seen[pn]) continue;
      seen[pn] = true;
      out.push(pluginTools[i]);
    }
    for (i = 0; i < nativeTools.length; i++) {
      var kn = toolSchemaName(nativeTools[i]);
      if (!kn || seen[kn]) continue;
      seen[kn] = true;
      out.push(nativeTools[i]);
    }
    return out;
  }

  /** 追加 role:'tool' 消息（P1 字段：toolName/args/result/ok/confirmState/confirmed） */
  function appendToolResultMessage(chat, name, args, toolCallId, content, ok, confirmState, confirmed) {
    var text = content === null || content === undefined || content === '' ? (ok ? '（工具未返回内容）' : '工具执行失败') : String(content);
    var toolMsg = Store.appendMessage(chat.id, {
      role: 'tool',
      content: text,
      toolName: name,
      toolCallId: toolCallId,
      args: args === undefined || args === null ? {} : args,
      result: text,
      ok: !!ok,
      confirmState: confirmState || (ok ? 'success' : 'error'),
      confirmed: !!confirmed
    });
    if (toolMsg) {
      ui('appendMessage', toolMsg);
      ui('scrollBottom');
    }
    /* v2.0 F5：web_search 结果 JSON → 当前 assistant 消息 citations */
    captureCitations(name, text);
    return toolMsg;
  }

  function execOneTool(chat, toolCall, ctx, index) {
    var name = toolCall && (toolCall.name || (toolCall.function && toolCall.function.name)) || 'unknown';
    var rawArgs = toolCall
      ? (toolCall.arguments !== undefined ? toolCall.arguments : (toolCall.function ? toolCall.function.arguments : ''))
      : '';
    var args = parseToolArgs(rawArgs);
    var toolCallId = (toolCall && toolCall.id) || ('call_' + index);
    if (isNativeTool(name)) return execNativeTool(chat, name, args, toolCallId);
    return execPluginTool(chat, name, args, toolCallId, ctx);
  }

  /** 插件工具：保持原有 DSPlugins.runTool 路径 */
  function execPluginTool(chat, name, args, toolCallId, ctx) {
    return new Promise(function (resolve) {
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
        resolve(appendToolResultMessage(chat, name, args, toolCallId, content, true, 'success', false));
      }, function (e2) {
        resolve(appendToolResultMessage(chat, name, args, toolCallId, '工具执行失败：' + errText(e2), false, 'error', false));
      });
    });
  }

  /** 把高危工具确认串行化（多个工具同时返回 tool-confirm 时避免弹窗叠层） */
  function askToolConfirm(tool, args, risk) {
    var run = function () { return promptToolRisk(tool, args, risk); };
    var next = state.confirmChain.then(run, run);
    state.confirmChain = next.then(function () { }, function () { });
    return next;
  }

  function promptToolRisk(tool, args, risk) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(allow) {
        if (done) return;
        done = true;
        state.pendingConfirm = null;
        resolve(!!allow);
      }
      state.pendingConfirm = finish;
      var U = getUI();
      if (U && typeof U.confirmRisk === 'function') {
        try {
          var work = U.confirmRisk(String(tool || 'unknown'), args && typeof args === 'object' ? args : String(args || ''), String(risk || 'high'));
          Promise.resolve(work).then(function (v) { finish(!!v); }, function () { finish(false); });
          return;
        } catch (e) {
          warn('UI.confirmRisk 异常：' + errText(e));
        }
      }
      confirmAsync('高危操作确认', '工具：' + tool + '\n风险：' + String(risk || 'high').toUpperCase() + '\n参数：' + safeStringify(args || {})).then(finish);
    });
  }

  /** 原生工具：Bridge.execTool → (tool-confirm → UI.confirmRisk → Bridge.confirmTool) → tool-result
   *  P2：构建类 / MCP 工具先 append 一条 running tool 消息（进度条 + 日志流复用同一条消息）。 */
  function execNativeTool(chat, name, args, toolCallId) {
    return new Promise(function (resolve) {
      var B = global.Bridge;
      var requestId = genAgentRequestId('tool');
      var settled = false;
      var confirmAsked = false;
      var offs = [];
      var timer = null;
      var progressEntry = null;

      function cleanup() {
        if (timer) { clearTimeout(timer); timer = null; }
        for (var i = 0; i < offs.length; i++) {
          try { offs[i](); } catch (e) { /* ignore */ }
        }
        offs = [];
      }

      function finish(evt, forcedOk, forcedResult) {
        if (settled) return;
        settled = true;
        cleanup();
        var ok = evt ? evt.ok !== false : !!forcedOk;
        var resultText = '';
        if (evt && evt.result !== undefined && evt.result !== null) resultText = String(evt.result);
        else if (forcedResult !== undefined && forcedResult !== null) resultText = String(forcedResult);
        if (!resultText) resultText = ok ? '（工具未返回内容）' : '工具执行失败';
        var confirmed = evt ? !!evt.confirmed : false;
        var stateText = ok ? 'success' : (String(resultText).indexOf('用户拒绝') !== -1 ? 'rejected' : 'error');
        if (progressEntry) {
          resolve(finalizeProgressToolMessage(progressEntry, resultText, ok, stateText, confirmed));
        } else {
          resolve(appendToolResultMessage(chat, name, args, toolCallId, resultText, ok, stateText, confirmed));
        }
      }

      /* P2：构建类工具 / MCP 工具先建 running 卡片，供 mcp-progress 映射 */
      var runningMsg = null;
      if (isMcpProgressTool(name)) {
        runningMsg = createRunningToolMessage(chat, name, args, toolCallId);
        if (runningMsg) progressEntry = findRunningEntry(runningMsg.id);
      }
      /* P4：构建类工具聚合到构建任务面板 */
      if (isBuildToolName(name)) {
        try { beginBuildTask(name, requestId, runningMsg ? runningMsg.id : '', args); } catch (e0) { warn('创建构建任务失败：' + errText(e0)); }
      }

      offs.push(B.onEvent('tool-result', function (evt) {
        if (!evt || String(evt.requestId) !== requestId) return;
        finish(evt);
      }));
      offs.push(B.onEvent('tool-confirm', function (evt) {
        if (!evt || String(evt.requestId) !== requestId) return;
        if (confirmAsked) return;
        confirmAsked = true;
        var tool = evt.tool ? String(evt.tool) : name;
        var eArgs = evt.args && typeof evt.args === 'object' ? evt.args : args;
        var risk = evt.risk ? String(evt.risk).toLowerCase() : (state.nativeTools[name] ? state.nativeTools[name].risk : 'high');
        if (progressEntry) {
          updateRunningToolMessage(progressEntry, {
            confirmState: 'pending',
            content: '等待确认…',
            progress: { percent: 0, line: '' }
          });
        }
        askToolConfirm(tool, eArgs, risk).then(function (allow) {
          if (progressEntry && allow) {
            updateRunningToolMessage(progressEntry, {
              confirmState: 'running',
              content: '执行中…',
              progress: { percent: 0, line: '开始执行…' }
            });
          }
          try { B.confirmTool(requestId, !!allow); } catch (e) { warn('confirmTool 失败：' + errText(e)); }
          if (!allow) {
            /* 兜底：原生拒绝后必须回 tool-result；300ms 内未回则本地结束，避免卡住 */
            setTimeout(function () {
              if (!settled) finish(null, false, '用户拒绝执行');
            }, 300);
          }
        });
      }));
      timer = setTimeout(function () {
        if (!settled) finish(null, false, '工具执行超时（120 秒）');
      }, 120000);

      var started = false;
      try {
        started = B.execTool(requestId, name, JSON.stringify(args || {}));
      } catch (e) {
        started = false;
      }
      if (started === false) finish(null, false, '原生工具执行不可用');
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
        systemPrompt: resolveSystemPrompt(chat)
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
    if (!AUTO_TITLE) return;
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

  /* ------------------------------------------------------------------ *
   * v2.0 F1：智能体预设
   * ------------------------------------------------------------------ */

  function getPresets() {
    try {
      if (global.Store && typeof global.Store.getPresets === 'function') {
        var list = global.Store.getPresets();
        if (Array.isArray(list)) {
          state.presets = list;
          return list;
        }
      }
    } catch (e) {
      warn('读取预设失败：' + errText(e));
    }
    return Array.isArray(state.presets) ? state.presets.slice() : [];
  }

  function loadPresets() {
    state.presets = getPresets();
    return state.presets;
  }

  function findPreset(id) {
    if (id === null || id === undefined || id === '') return null;
    var key = String(id);
    var list = Array.isArray(state.presets) && state.presets.length ? state.presets : getPresets();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === key) return list[i];
    }
    return null;
  }

  /** 放弃「新建会话」时创建的空白占位会话（如从选择器直接进入预设管理） */
  function discardPendingAgentChat() {
    var id = state.pendingAgentChatId;
    state.pendingAgentChatId = null;
    if (!id) return false;
    var chat = Store.getChat(id);
    if (!chat || chat.messages.length) return false;
    try { Store.deleteChat(id); } catch (e) {
      warn('清理占位会话失败：' + errText(e));
      return false;
    }
    return true;
  }

  /** 打开「智能体预设」管理页（设置页入口 / 选择器「管理预设」） */
  function openAgents() {
    discardPendingAgentChat();
    if (state.nav.screen !== 'agents') {
      state.nav.agentsFrom = state.nav.screen && state.nav.screen !== 'agents'
        ? state.nav.screen
        : (state.nav.from || 'chats');
      state.nav.from = state.nav.agentsFrom;
    }
    closeDrawer();
    state.nav.screen = 'agents';
    refreshAgents();
    var U = getUI();
    if (U && typeof U.renderAgents === 'function' && typeof U.showScreen === 'function') {
      ui('showScreen', 'agents');
      setBackDepth(state.nav.from === 'chat' ? 3 : 2);
      return true;
    }
    // 兜底：UI 尚未实现管理页时，用输入框创建一个自定义预设
    toast('当前版本暂不支持预设管理页', true);
    promptAsync('新建智能体预设（输入名称）', '', '例如 代码审查员').then(function (name) {
      var presetName = String(name === null || name === undefined ? '' : name).replace(/^\s+|\s+$/g, '');
      if (!presetName) return;
      return promptAsync('预设提示词（System Prompt）', '', '例如 你是一名严格的代码审查员…').then(function (prompt) {
        var text = String(prompt === null || prompt === undefined ? '' : prompt);
        if (!text.replace(/\s+/g, '')) { toast('提示词不能为空'); return; }
        saveAgent({ name: presetName, description: '', systemPrompt: text });
      });
    });
    return false;
  }

  /** 关闭「智能体预设」管理页，恢复到打开前的界面（对话页 / 设置页 / 会话列表） */
  function closeAgents() {
    var from = state.nav.agentsFrom || state.nav.from || 'chats';
    if (from === 'chat') {
      var chat = Store.getActiveChat();
      if (!chat) { showChatsScreen(); return true; }
      state.nav.from = 'chats';
      state.nav.screen = 'chat';
      navTo('chat');
      ui('showScreen', 'chat');
      ui('setUser', { name: 'DeepSeek 用户' });
      ui('setModel', state.prefs.model);
      applyModelLabel();
      ui('setChatAvatar', chat);
      setHeader(chat, '');
      ui('renderMessages', chat);
      ui('setStreaming', state.busy);
      ui('setComposer', { value: '', busy: !!state.busy });
      ui('scrollBottom', true);
      refreshChatList();
      setBackDepth(1);
      return true;
    }
    if (from === 'settings') { openSettings(); return true; }
    if (from === 'profile') { showProfile(); return true; }
    if (from === 'share') { showShare(); return true; }
    showChatsScreen();
    return true;
  }

  function refreshAgents() {
    ui('renderAgents', getPresets());
  }

  /** 保存预设（新增或更新）：handlers.onSaveAgent(agent) */
  function saveAgent(agent) {
    if (!agent || typeof agent !== 'object') { toast('预设数据无效'); return null; }
    var saved = null;
    try {
      if (global.Store && typeof global.Store.savePreset === 'function') saved = global.Store.savePreset(agent);
    } catch (e) {
      warn('保存预设失败：' + errText(e));
    }
    if (!saved) { toast('保存失败：预设名称不能为空'); return null; }
    loadPresets();
    refreshAgents();
    toast('预设已保存', true);
    return saved;
  }

  /** 删除预设：handlers.onDeleteAgent(id)（内置预设受保护） */
  function deleteAgent(id) {
    if (id === null || id === undefined || id === '') return false;
    var preset = findPreset(id);
    if (!preset) { toast('预设不存在'); return false; }
    if (preset.builtin) { toast('内置预设不可删除'); return false; }
    var ok = false;
    try {
      if (global.Store && typeof global.Store.deletePreset === 'function') ok = global.Store.deletePreset(id);
    } catch (e) {
      warn('删除预设失败：' + errText(e));
    }
    loadPresets();
    refreshAgents();
    toast(ok ? '预设已删除' : '删除失败');
    return !!ok;
  }

  /** 恢复内置默认预设（4 个），自定义预设保留 */
  function resetAgents() {
    try {
      if (global.Store && typeof global.Store.resetPresets === 'function') global.Store.resetPresets();
    } catch (e) {
      warn('恢复默认预设失败：' + errText(e));
    }
    loadPresets();
    refreshAgents();
    toast('已恢复默认预设', true);
    return true;
  }

  /** 供 UI.openAgentPicker 渲染的预设条目（UI 自行追加「默认会话」与「管理预设」入口） */
  function agentPickerItems() {
    return getPresets().map(function (preset) {
      return {
        id: preset.id,
        name: preset.name,
        description: preset.description || '',
        systemPrompt: preset.systemPrompt || '',
        model: preset.model || '',
        builtin: !!preset.builtin
      };
    });
  }

  /** 解析请求使用的 system prompt：chat.systemPrompt → preset.systemPrompt → prefs.systemPrompt */
  function resolveSystemPrompt(chat) {
    chat = chat || Store.getActiveChat();
    var base = '';
    if (chat) {
      var chatPrompt = chat.systemPrompt === null || chat.systemPrompt === undefined ? '' : String(chat.systemPrompt);
      if (chatPrompt.replace(/\s+/g, '')) base = chatPrompt;
      else if (chat.presetId) {
        var preset = findPreset(chat.presetId);
        var presetPrompt = preset && preset.systemPrompt ? String(preset.systemPrompt) : '';
        if (presetPrompt.replace(/\s+/g, '')) base = presetPrompt;
      }
    }
    if (!base) base = state.prefs.systemPrompt || '';
    /* ARCH v2 P3：记忆注入（顺序：预设/prefs → 长期偏好 → 项目记忆 → 当前会话摘要） */
    var memoryPrompt = buildMemoryPrompt(chat);
    if (!memoryPrompt) return base;
    return base ? (base + '\n\n' + memoryPrompt) : memoryPrompt;
  }

  /** 会话历史摘要：优先使用本轮压缩后的 override（原生写库为异步），否则读 Bridge.memoryGetSummaries */
  function memorySummaryFor(chatId) {
    var id = String(chatId === null || chatId === undefined ? '' : chatId);
    if (!id) return '';
    var override = state.contextSummaryOverride && state.contextSummaryOverride[id];
    if (override) return String(override);
    try {
      if (global.Bridge && typeof global.Bridge.memoryGetSummaries === 'function') {
        var list = global.Bridge.memoryGetSummaries();
        if (Array.isArray(list)) {
          for (var i = 0; i < list.length; i++) {
            if (String(list[i].chatId) === id) return String(list[i].summary || '');
          }
        }
      }
    } catch (e) { warn('读取会话摘要失败：' + errText(e)); }
    return '';
  }

  /** 组装记忆上下文（长期偏好 / 项目记忆 / 会话摘要） */
  function buildMemoryPrompt(chat) {
    var parts = [];
    try {
      if (global.Bridge && typeof global.Bridge.memoryKvGet === 'function') {
        var longTerm = global.Bridge.memoryKvGet('long_term') || {};
        var keys = Object.keys(longTerm);
        if (keys.length) {
          var ltLines = [];
          for (var i = 0; i < keys.length; i++) {
            var lv = String(longTerm[keys[i]] === null || longTerm[keys[i]] === undefined ? '' : longTerm[keys[i]]).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
            if (!lv) continue;
            ltLines.push('- ' + keys[i] + '：' + lv);
          }
          if (ltLines.length) parts.push('用户偏好：\n' + ltLines.join('\n'));
        }
        var project = global.Bridge.memoryKvGet('project') || {};
        var pkeys = Object.keys(project);
        var order = ['tech_stack', 'conventions', 'decisions'];
        var pLines = [];
        for (var j = 0; j < order.length; j++) {
          var ov = project[order[j]];
          if (ov === undefined || ov === null || String(ov) === '') continue;
          pLines.push('- ' + order[j] + '：' + String(ov).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''));
        }
        for (var k = 0; k < pkeys.length; k++) {
          if (order.indexOf(pkeys[k]) !== -1) continue;
          var pv = project[pkeys[k]];
          if (pv === undefined || pv === null || String(pv) === '') continue;
          pLines.push('- ' + pkeys[k] + '：' + String(pv).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''));
        }
        if (pLines.length) parts.push('项目记忆：\n' + pLines.join('\n'));
      }
      var chatId = chat ? chat.id : Store.getActiveChatId();
      var summary = memorySummaryFor(chatId);
      if (summary) parts.push('之前对话摘要：\n' + summary);
    } catch (e) { warn('组装记忆上下文失败：' + errText(e)); }
    return parts.join('\n\n');
  }

  /* ---------------- 上下文压缩（ARCH v2 P3） ---------------- */

  function contextBudgetChars() {
    var budget = Number(state.prefs && state.prefs.contextBudget);
    if (!(budget > 0)) budget = CONTEXT_BUDGET_DEFAULT;
    return Math.max(500, Math.min(200000, Math.round(budget)));
  }

  function estimateContextChars(messages) {
    var total = 0;
    var list = Array.isArray(messages) ? messages : [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || m.role === 'note') continue;
      total += String(m.content === null || m.content === undefined ? '' : m.content).length;
      total += String(m.reasoning === null || m.reasoning === undefined ? '' : m.reasoning).length;
      if (m.toolCalls && m.toolCalls.length) {
        try { total += JSON.stringify(m.toolCalls).length; } catch (e) { /* ignore */ }
      }
      total += 16; /* 角色 / 分隔开销 */
    }
    return total;
  }

  /** 旧消息 → 摘要文本（每条前 160 字，最多 20 条） */
  function buildSessionSummaryPiece(older) {
    var lines = [];
    var list = Array.isArray(older) ? older : [];
    for (var i = 0; i < list.length && lines.length < SUMMARY_MAX_ENTRIES; i++) {
      var m = list[i];
      if (!m || m.role === 'note') continue;
      var text = String(m.content === null || m.content === undefined ? '' : m.content)
        .replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
      if (!text) continue;
      var label = m.role === 'user' ? '用户' : (m.role === 'assistant' ? '助手' : (m.role === 'tool' ? '工具结果' : '系统'));
      lines.push('- ' + label + '：' + (text.length > SUMMARY_ENTRY_CHARS ? (text.slice(0, SUMMARY_ENTRY_CHARS) + '…') : text));
    }
    return lines.join('\n');
  }

  /**
   * 发送前上下文压缩：
   * 字符估算 tokens≈chars/3.5；超过预算 80% 时保留最近 10 条消息，其余（≤20 条）每条前 160 字
   * 拼成摘要 → Bridge.memorySaveSummary(chatId, 摘要) → append role:'note'「已压缩 X 条历史消息」。
   */
  function prepareContextMessages(chat, messages, systemPrompt, tools) {
    if (!chat || !Array.isArray(messages) || !messages.length) return messages;
    var budget = contextBudgetChars();
    var threshold = Math.floor(budget * CONTEXT_THRESHOLD);
    var chars = estimateContextChars(messages) + String(systemPrompt || '').length;
    try { if (tools && tools.length) chars += JSON.stringify(tools).length; } catch (e) { /* ignore */ }
    if (chars <= threshold) return messages;
    var keep = Math.min(CONTEXT_KEEP_RECENT, messages.length);
    var cut = messages.length - keep;
    while (cut > 0 && messages[cut] && messages[cut].role === 'tool') cut--;
    if (cut <= 0) return messages;
    var older = messages.slice(0, cut);
    var marker = older.length ? String(older[older.length - 1].id || '') : '';
    var prev = state.contextCompressed[chat.id];
    var toSummarize = older;
    if (prev && prev.markerId) {
      var idx = -1;
      for (var k = 0; k < messages.length; k++) {
        if (messages[k] && String(messages[k].id) === String(prev.markerId)) { idx = k; break; }
      }
      if (idx >= 0) toSummarize = messages.slice(idx + 1, cut);
      if (!toSummarize.length) return messages.slice(cut);
    }
    var piece = buildSessionSummaryPiece(toSummarize);
    if (piece) {
      var existing = memorySummaryFor(chat.id);
      var merged = existing ? (existing + '\n' + piece) : piece;
      if (merged.length > 16000) merged = merged.slice(merged.length - 16000);
      var saved = false;
      try {
        if (global.Bridge && typeof global.Bridge.memorySaveSummary === 'function') {
          saved = global.Bridge.memorySaveSummary(chat.id, merged) !== false;
        }
      } catch (e) { warn('保存会话摘要失败：' + errText(e)); }
      if (saved) {
        state.contextSummaryOverride[chat.id] = merged;
        state.contextCompressed[chat.id] = { markerId: marker, count: toSummarize.length };
        appendNote(chat.id, '已压缩 ' + toSummarize.length + ' 条历史消息为摘要（当前上下文约 ' + Math.round(chars) +
          ' 字符 ≈ ' + Math.round(chars / 3.5) + ' tokens / 预算 ' + budget + ' 字符，阈值 80%）');
      }
    }
    return messages.slice(cut);
  }

  /** 会话删除：清理摘要 + 压缩标记 */
  function cleanupChatMemory(chatId) {
    var id = String(chatId === null || chatId === undefined ? '' : chatId);
    if (!id) return;
    try {
      if (global.Bridge && typeof global.Bridge.memoryDeleteSummary === 'function') global.Bridge.memoryDeleteSummary(id);
    } catch (e) { warn('清理会话摘要失败：' + errText(e)); }
    delete state.contextCompressed[id];
    delete state.contextSummaryOverride[id];
  }

  /**
   * 新会话流程（v2.0 F1）：先创建/进入默认会话，UI 提供选择器时再以底部弹层
   * 覆盖在当前页上（选中预设 → 替换为预设会话；选「默认会话」/关闭 → 保留默认会话）。
   * UI 未实现 openAgentPicker 时行为与旧版一致（直接新建）。
   */
  function newChat() {
    if (state.busy) stopGeneration();
    state.nav.from = 'chats';
    var chat = ensureFreshDefaultChat();
    closeDrawer();
    navTo('chat');
    enterChat(chat);

    var U = getUI();
    if (!U || typeof U.openAgentPicker !== 'function') return chat;
    state.pendingAgentChatId = chat.id;
    var opened = false;
    try {
      opened = U.openAgentPicker(agentPickerItems(), '', function (id) {
        onPickAgent(id);
      });
    } catch (e) {
      warn('UI.openAgentPicker 失败：' + errText(e));
      opened = false;
    }
    if (opened === false) state.pendingAgentChatId = null;
    return chat;
  }

  /** 保证有一个空白的默认会话并返回（当前会话已是空白默认会话时直接复用） */
  function ensureFreshDefaultChat() {
    var active = Store.getActiveChat();
    if (active && active.messages.length === 0 && isDefaultAgentTitle(active.title)) return active;
    return Store.createChat({ model: state.prefs.model, title: defaultAgentTitle(state.prefs.model) });
  }

  /**
   * handlers.onPickAgent(id)：id 为空 = 默认会话（使用 prefs.systemPrompt）；
   * 否则用对应预设创建 chat（title=预设名，model=预设模型或当前模型，复制 systemPrompt，存 presetId）。
   */
  function onPickAgent(idOrAgent) {
    var preset = null;
    if (idOrAgent && typeof idOrAgent === 'object') {
      preset = idOrAgent.id ? findPreset(idOrAgent.id) : null;
      if (!preset) preset = idOrAgent; /* UI 直接回传预设对象时兜底 */
    } else if (idOrAgent !== null && idOrAgent !== undefined && String(idOrAgent) !== '') {
      preset = findPreset(String(idOrAgent));
      if (!preset) toast('预设不存在，已使用默认会话');
    }
    var U = getUI();
    if (U && typeof U.closeAgentPicker === 'function') {
      try { U.closeAgentPicker(); } catch (e) { /* ignore */ }
    }
    var placeholderId = state.pendingAgentChatId;
    state.pendingAgentChatId = null;

    if (!preset) {
      /* 默认会话：保留 newChat() 已创建的占位会话 */
      var placeholder = placeholderId ? Store.getChat(placeholderId) : null;
      if (placeholder) {
        Store.setActiveChat(placeholder.id);
        state.nav.from = 'chats';
        if (state.nav.screen !== 'chat') { navTo('chat'); enterChat(placeholder); }
        return placeholder;
      }
      return createChatForAgent(null);
    }

    /* 预设会话：丢弃空的占位会话，避免列表里多出一个空对话 */
    if (placeholderId) {
      var ph = Store.getChat(placeholderId);
      if (ph && ph.messages.length === 0) {
        try { Store.deleteChat(placeholderId); } catch (e2) { warn('清理占位会话失败：' + errText(e2)); }
      }
    }
    return createChatForAgent(preset);
  }

  /** 用预设（或 null = 默认）创建并进入新会话 */
  function createChatForAgent(preset) {
    state.nav.from = 'chats';
    if (!preset) {
      var active = Store.getActiveChat();
      if (active && active.messages.length === 0 && isDefaultAgentTitle(active.title)) {
        closeDrawer();
        navTo('chat');
        enterChat(active);
        toast('已经是新会话');
        return active;
      }
    }
    var model = preset && preset.model ? String(preset.model) : state.prefs.model;
    var title = preset && preset.name ? String(preset.name) : defaultAgentTitle(model);
    var chat = Store.createChat({
      model: model,
      title: title,
      presetId: preset ? preset.id : '',
      systemPrompt: preset ? String(preset.systemPrompt || '') : ''
    });
    Store.setActiveChat(chat.id);
    closeDrawer();
    navTo('chat');
    enterChat(chat);
    return chat;
  }

  /* ------------------------------------------------------------------ *
   * v2.0 F2：归档
   * ------------------------------------------------------------------ */

  /** handlers.onArchiveChat(id, archived)：archived 省略时切换状态 */
  function archiveChat(id, archived) {
    var chat = Store.getChat(id) || Store.getActiveChat();
    if (!chat) { toast('会话不存在'); return false; }
    var next = archived === undefined || archived === null ? !chat.archived : !!archived;
    try {
      Store.updateChat(chat.id, { archived: next });
    } catch (e) {
      warn('归档失败：' + errText(e));
      return false;
    }
    refreshChatList();
    toast(next ? '已归档' : '已取消归档');
    return true;
  }

  /* ------------------------------------------------------------------ *
   * v2.0 F4：从消息处新建分支
   * ------------------------------------------------------------------ */

  /** handlers.onForkMessage(msgId)：复制当前会话到该消息（含）为新分支并进入 */
  function forkMessage(msgId) {
    var chat = Store.getActiveChat();
    if (!chat) { toast('没有可分支的会话'); return null; }
    if (state.busy) stopGeneration();
    var forked = null;
    try {
      if (global.Store && typeof global.Store.forkChat === 'function') forked = global.Store.forkChat(chat.id, msgId);
    } catch (e) {
      warn('创建分支失败：' + errText(e));
    }
    if (!forked) { toast('找不到要分支的消息'); return null; }
    Store.setActiveChat(forked.id);
    closeDrawer();
    navTo('chat');
    enterChat(forked);
    toast('已创建分支会话', true);
    return forked;
  }

  /* ------------------------------------------------------------------ *
   * v2.0 F3：备份 / 恢复
   * ------------------------------------------------------------------ */

  /** 组装备份对象：{app,version,exportedAt,prefs(不含 apiKey),chats,customModels,presets,plugins:{enabled}} */
  function buildBackupObject() {
    var data = {};
    try {
      data = Store.exportBackupData ? Store.exportBackupData() : {};
    } catch (e) {
      warn('读取备份数据失败：' + errText(e));
      data = {};
    }
    var prefs = {};
    var source = data.prefs || state.prefs || {};
    var keys = Object.keys(source);
    for (var i = 0; i < keys.length; i++) prefs[keys[i]] = source[keys[i]];
    delete prefs.apiKey; /* 安全：API Key 不进入备份 */
    var enabled = data.plugins && data.plugins.enabled ? data.plugins.enabled : {};
    return {
      app: BACKUP_APP_ID,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      prefs: prefs,
      chats: Array.isArray(data.chats) ? data.chats : [],
      customModels: Array.isArray(data.customModels) ? data.customModels : [],
      presets: Array.isArray(data.presets) ? data.presets : [],
      plugins: { enabled: enabled }
    };
  }

  /** App.exportBackup()：导出 JSON 备份到用户选择的文件 */
  function exportBackup() {
    var payload = buildBackupObject();
    var json = '';
    try {
      json = JSON.stringify(payload, null, 2);
    } catch (e) {
      warn('序列化备份失败：' + errText(e));
      toast('导出备份失败：数据序列化错误', true);
      return false;
    }
    var name = 'DeepSeekHouse-backup-' + backupDateStamp() + '.json';
    var B = global.Bridge;
    if (!B || typeof B.saveTextFile !== 'function') { toast('当前环境不支持导出文件', true); return false; }
    var ok = false;
    try {
      ok = B.saveTextFile(name, json);
    } catch (e2) {
      warn('保存备份失败：' + errText(e2));
    }
    if (ok === false) { toast('导出备份失败', true); return false; }
    toast('正在导出备份（' + payload.chats.length + ' 个会话）…', true);
    return true;
  }

  /** App.importBackup()：选择 JSON 文件；结果通过 file-imported 事件回填 */
  function importBackup() {
    var B = global.Bridge;
    if (!B || typeof B.importTextFile !== 'function') { toast('当前环境不支持导入文件', true); return false; }
    toast('请选择备份文件…', true);
    try {
      var work = B.importTextFile();
      if (work && typeof work.catch === 'function') work.catch(function (e) { warn('导入文件失败：' + errText(e)); });
    } catch (e2) {
      warn('importTextFile 失败：' + errText(e2));
      toast('无法打开文件选择器', true);
      return false;
    }
    return true;
  }

  /** file-imported 事件：取消静默；非法文件给出提示 */
  function onFileImported(evt) {
    if (!evt || typeof evt !== 'object') return false;
    if (evt.cancelled || evt.error === 'cancelled') return false; /* 用户取消：静默 */
    var content = evt.content;
    if (content === null || content === undefined || String(content).replace(/\s+/g, '') === '') return false;
    var name = evt.name ? String(evt.name) : '';
    var text = String(content);
    var parsed = null;
    if (text.replace(/^\s+|\s+$/g, '').charAt(0) === '{') {
      try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      /* 兼容：通过同一原生入口误选的插件文件 → 交给插件安装 */
      if (/\.js$/i.test(name) || text.indexOf('DSPlugins.register') !== -1) {
        installPlugin(text);
        return true;
      }
      toast('导入失败：不是有效的备份 JSON', true);
      return false;
    }
    if (String(parsed.app || '') !== BACKUP_APP_ID) {
      toast('导入失败：不是 DeepSeek House 备份文件', true);
      return false;
    }
    if (!Array.isArray(parsed.chats)) {
      toast('导入失败：备份缺少会话数据（chats）', true);
      return false;
    }
    var when = formatBackupTime(parsed.exportedAt);
    var detail = '将用备份中的 ' + parsed.chats.length + ' 个会话覆盖当前全部会话、设置、模型与预设' +
      (when ? '（备份时间 ' + when + '）' : '') + '，且不可恢复。确定继续吗？';
    confirmAsync('导入备份', detail).then(function (ok) {
      if (ok) applyBackup(parsed);
    });
    return true;
  }

  /** 应用备份：整体替换 Store → 同步原生 prefs / 插件启用态 → 刷新 UI */
  function applyBackup(data) {
    if (state.busy) stopGeneration();
    try {
      if (global.Store && typeof global.Store.replaceData === 'function') global.Store.replaceData(data);
    } catch (e) {
      warn('写入备份数据失败：' + errText(e));
      toast('导入失败：数据写入异常', true);
      return false;
    }
    /* 原生 prefs（不含 apiKey，保留本机 Key） */
    try {
      var nativePatch = {};
      var prefs = data && data.prefs && typeof data.prefs === 'object' ? data.prefs : {};
      var keys = ['baseUrl', 'temperature', 'maxTokens', 'stream', 'theme', 'systemPrompt', 'model'];
      for (var i = 0; i < keys.length; i++) {
        if (prefs[keys[i]] !== undefined && prefs[keys[i]] !== null) nativePatch[keys[i]] = prefs[keys[i]];
      }
      if (Object.keys(nativePatch).length && global.Bridge && typeof global.Bridge.setPrefs === 'function') {
        global.Bridge.setPrefs(nativePatch);
      }
    } catch (e2) { warn('同步原生设置失败：' + errText(e2)); }

    state.prefs = mergePrefs(Store.getPrefs(), readNativePrefs());
    loadCustomModels();
    loadPresets();
    state.modelCatalog = buildModelCatalog(state.remoteModels, state.customModels);
    var importedPluginStates = data && data.plugins && data.plugins.enabled
      ? data.plugins.enabled
      : (data && data.pluginStates ? data.pluginStates : null);
    applyImportedPluginStates(importedPluginStates);

    var chat = Store.getActiveChat();
    if (state.nav.screen === 'settings') ui('renderSettings', state.prefs, currentModelCatalog(), getPresets());
    else if (state.nav.screen === 'agents') refreshAgents();
    else if (state.nav.screen === 'profile') showProfile();
    else if (state.nav.screen === 'share') showShare();
    refreshChatList();
    if (state.nav.screen === 'chat') {
      if (chat) {
        ui('renderMessages', chat);
        ui('setChatAvatar', chat);
        setHeader(chat, '');
        ui('scrollBottom', true);
      } else {
        showChatsScreen();
      }
    }
    applyModelLabel();
    loadPlugins(false);
    toast('备份已导入', true);
    return true;
  }

  /** 导入插件启用状态：Store + DSPlugins + 原生三层同步 */
  function applyImportedPluginStates(enabled) {
    if (!enabled || typeof enabled !== 'object') { refreshPlugins(); return; }
    var ids = Object.keys(enabled);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var on = !!enabled[id];
      try { if (global.Store && Store.setPluginEnabled) Store.setPluginEnabled(id, on); } catch (e) { /* ignore */ }
      try {
        if (global.DSPlugins && typeof global.DSPlugins.setEnabled === 'function') global.DSPlugins.setEnabled(id, on);
      } catch (e2) { warn('同步插件状态失败：' + errText(e2)); }
      try { if (global.Bridge && typeof global.Bridge.pluginSetEnabled === 'function') global.Bridge.pluginSetEnabled(id, on); } catch (e3) { /* ignore */ }
    }
    refreshPlugins();
  }

  function selectChat(id) {
    if (state.busy) stopGeneration();
    state.nav.from = state.nav.screen === 'share' ? 'share' : 'chats';
    var chat = Store.getChat(id);
    if (!chat) return;
    Store.setActiveChat(chat.id);
    closeDrawer();
    navTo('chat');
    enterChat(chat);
  }

  function deleteChat(id, skipConfirm) {
    var chat = Store.getChat(id);
    if (!chat) chat = Store.getActiveChat();
    if (!chat) return;
    var doDelete = function () {
      var wasActive = Store.getActiveChatId() === chat.id;
      Store.deleteChat(chat.id);
      /* ARCH v2 P3：会话删除时清理记忆摘要 */
      cleanupChatMemory(chat.id);
      var next = Store.getActiveChat();
      if (!next) {
        next = Store.createChat({ model: state.prefs.model, title: defaultAgentTitle(state.prefs.model) });
        Store.setActiveChat(next.id);
      }
      refreshChatList();
      if (wasActive) {
        ui('renderMessages', next);
        ui('setChatAvatar', next);
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
      ui('setChatAvatar', chat);
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

  /** 会话/智能体默认名：DeepSeek + 模型型号（如 DeepSeek V4 Pro） */
  function defaultAgentTitle(modelId) {
    var label = labelForModelId(modelId || state.prefs.model);
    if (!label) return 'DeepSeek';
    return /^deepseek/i.test(label) ? label : 'DeepSeek ' + label;
  }

  function isDefaultAgentTitle(title) {
    var t = String(title || '');
    if (!t) return true;
    if (t === '新的对话' || t === '新对话') return true;
    return t === defaultAgentTitle(state.prefs.model);
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
    var previousDefaultTitle = chat ? defaultAgentTitle(state.prefs.model) : '';
    if (chat) {
      try {
        if (typeof Store.updateChat === 'function') Store.updateChat(chat.id, { model: modelId });
        chat.model = modelId;
        /* 智能体名仍是默认名时，跟着模型一起变；用户自定义的名字不动 */
        if (String(chat.title || '') === previousDefaultTitle) {
          var newTitle = defaultAgentTitle(modelId);
          Store.renameChat(chat.id, newTitle);
          chat.title = newTitle;
          if (state.nav && state.nav.screen === 'chat') ui('setHeader', { title: newTitle, subtitle: '' });
          refreshChatList();
        }
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
    /* 从「智能体预设」管理页返回时保留最初的来源，避免返回层级丢失 */
    if (state.nav.screen !== 'agents') state.nav.from = state.nav.screen;
    if (!state.nav.from) state.nav.from = 'chats';
    state.modelCatalog = currentModelCatalog();
    ui('renderSettings', state.prefs, state.modelCatalog, getPresets());
    ui('showScreen', 'settings');
    navTo('settings');
    /* ARCH v2 P4：打开设置页刷新 MCP 统计 + 应用锁/加密状态 */
    try { refreshMcpStatsUI(); } catch (e1) { warn('刷新 MCP 统计失败：' + errText(e1)); }
    try { refreshSecurityInfo(); } catch (e2) { warn('刷新安全信息失败：' + errText(e2)); }
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
    if (patch.contextBudget !== undefined) next.contextBudget = Math.round(clampNum(patch.contextBudget, 500, 200000));

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
    ui('renderSettings', state.prefs, state.modelCatalog, getPresets());
    setHeader(active, '');
    /* ARCH v2 P3：设置保存后刷新记忆状态（若记忆页已加载过） */
    if (state.memory && state.memory.loaded) refreshMemorySoon(60);
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
      P.onChange(function () {
        refreshPlugins();
        refreshPluginSlots();
        if (state.market && state.market.items.length) refreshMarketStatusSoon();
      });
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
    state.nav.from = state.nav.screen;
    bindPluginsChange();
    refreshPlugins();
    ui('showScreen', 'plugins');
    navTo('plugins');
    loadPlugins(true);
    /* ARCH v2 P3：插件页打开时确保 HousePlugin 已加载并刷新 slots */
    try { loadHousePluginsAndSlots(); } catch (e) { warn('加载 HousePlugin 失败：' + errText(e)); }
    refreshPluginSlots();
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
    if (markdown.indexOf('@惜白.') === -1) {
      markdown += '\n\n---\n\n*DeepSeek House · @惜白.*\n';
    }
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
   * ARCH v2 P1：工作区 / 文件树 / 终端 / 审计
   * ------------------------------------------------------------------ */

  function refreshWorkspaceInfo() {
    var info = null;
    try {
      if (global.Bridge && typeof global.Bridge.workspaceInfo === 'function') info = global.Bridge.workspaceInfo();
    } catch (e) {
      warn('读取 workspaceInfo 失败：' + errText(e));
    }
    if (!info || typeof info !== 'object') info = { root: '', writable: false, allFilesAccess: false };
    var normalized = {
      root: info.root === null || info.root === undefined ? '' : String(info.root),
      writable: !!info.writable,
      allFilesAccess: !!info.allFilesAccess
    };
    /* 原生补充字段透传（设置页「恢复默认工作区」/权限提示需要） */
    if (info.defaultRoot !== undefined && info.defaultRoot !== null) normalized.defaultRoot = String(info.defaultRoot);
    if (info.isDefault !== undefined) normalized.isDefault = !!info.isDefault;
    else if (normalized.defaultRoot) normalized.isDefault = normalized.root === normalized.defaultRoot;
    state.workspace = normalized;
    ui('setWorkspaceInfo', normalized);
    return normalized;
  }

  /** 加载目录并交给 UI.renderFileTree(entries, {root, path}) */
  function loadWorkspaceDir(path) {
    var info = state.workspace || refreshWorkspaceInfo();
    var p = path === null || path === undefined || path === '' ? (info.root || '') : String(path);
    var entries = [];
    try {
      if (global.Bridge && typeof global.Bridge.listDir === 'function') entries = global.Bridge.listDir(p);
    } catch (e) {
      warn('listDir 失败：' + errText(e));
    }
    if (!Array.isArray(entries)) entries = [];
    var listErr = '';
    try {
      if (global.Bridge && typeof global.Bridge.getLastError === 'function') listErr = global.Bridge.getLastError('listDir') || '';
    } catch (e1) { /* ignore */ }
    var U = getUI();
    if (U && typeof U.renderFileTree === 'function') {
      try {
        /* UI 支持非数组 entries：{error} → 抽屉内显示「目录读取失败」行 */
        U.renderFileTree(listErr ? { error: listErr } : entries, { root: info.root || '', path: p });
      } catch (e2) { warn('UI.renderFileTree 异常：' + errText(e2)); }
    } else if (listErr) {
      toast('无法列出目录：' + listErr, true);
    } else {
      toast('目录 ' + (p || info.root || '/') + '：' + entries.length + ' 项');
    }
    if (listErr) toast('无法列出目录：' + listErr, true);
    return entries;
  }

  /**
   * handlers.onOpenFile(path, isDir)：UI 文件树回调。
   * 无参 → 列工作区根目录；isDir=true → 列目录；isDir=false/null → readFile 预览。
   */
  function onOpenFile(path, isDir) {
    refreshWorkspaceInfo();
    var hasPath = !(path === undefined || path === null || String(path) === '');
    if (!hasPath) return loadWorkspaceDir('');
    var target = String(path);
    if (isDir === true) return loadWorkspaceDir(target);
    return openWorkspaceFile(target);
  }

  function openWorkspaceFile(path) {
    var B = global.Bridge;
    if (!B || typeof B.readFileAsync !== 'function') {
      toast('当前环境不支持读取文件', true);
      return false;
    }
    B.readFileAsync(path, 30000).then(function (evt) {
      evt = evt || {};
      if (evt.ok === false) {
        toast('读取失败：' + (evt.result || '未知错误'), true);
        return;
      }
      var content = evt.result === undefined || evt.result === null ? '' : String(evt.result);
      state.filePreview = { path: path, content: content };
      showFilePreview(path, content);
    }).catch(function (e) {
      warn('读取文件失败：' + errText(e));
      toast('读取失败：' + errText(e), true);
    });
    return true;
  }

  function showFilePreview(path, content) {
    var text = String(content === null || content === undefined ? '' : content);
    var U = getUI();
    if (U) {
      var names = ['renderFilePreview', 'showFilePreview', 'previewFile'];
      for (var i = 0; i < names.length; i++) {
        if (typeof U[names[i]] !== 'function') continue;
        try { U[names[i]]({ path: path, content: text }); return; } catch (e) { warn('文件预览渲染失败：' + errText(e)); }
      }
    }
    var name = String(path || '').split('/').pop() || String(path || '文件');
    if (!text) { toast('📄 ' + name + '（空文件）', true); return; }
    var head = text.length > 160 ? (text.slice(0, 160) + '…') : text;
    toast('📄 ' + name + '：' + head.replace(/\s+/g, ' '), true);
  }

  function appendTerminal(text, opts) {
    var value = String(text === null || text === undefined ? '' : text);
    var U = getUI();
    if (U && typeof U.appendTerminal === 'function') {
      try { U.appendTerminal(value, opts || {}); return; } catch (e) { warn('UI.appendTerminal 异常：' + errText(e)); }
    }
    toast('终端：' + (value || '（无输出）'));
  }

  /** runShell 的 tool-result（按 requestId 区分，不发聊天消息，只进终端面板） */
  function appendTerminalResult(evt, pending) {
    var ok = evt.ok !== false;
    var text = evt.result === undefined || evt.result === null ? '' : String(evt.result);
    if (!text) text = ok ? '（无输出）' : '命令执行失败';
    var command = pending && pending.command ? String(pending.command) : '';
    appendTerminal(text, { requestId: evt.requestId, ok: ok, command: command });
  }

  /** handlers.onRunShell(command) */
  function runShellCommand(command) {
    var cmd = String(command === null || command === undefined ? '' : command).replace(/^\s+|\s+$/g, '');
    if (!cmd) return false;
    var B = global.Bridge;
    if (!B || typeof B.runShell !== 'function') {
      toast('当前环境不支持终端', true);
      return false;
    }
    var requestId = genAgentRequestId('shell');
    state.pendingShell[requestId] = { command: cmd, at: Date.now() };
    setTimeout(function () {
      var pending = state.pendingShell[requestId];
      if (!pending) return;
      delete state.pendingShell[requestId];
      appendTerminal('（命令执行超时）', { requestId: requestId, ok: false, command: pending.command });
    }, 60000);
    var started = false;
    try { started = B.runShell(requestId, cmd) !== false; } catch (e) {
      warn('runShell 失败：' + errText(e));
      started = false;
    }
    if (!started) {
      delete state.pendingShell[requestId];
      appendTerminal('（无法执行命令：原生不可用）', { requestId: requestId, ok: false, command: cmd });
      return false;
    }
    return true;
  }

  /** handlers.onOpenAudit()：Bridge.auditRecent(50) → UI.renderAudit(items) */
  function openAudit() {
    var items = [];
    try {
      if (global.Bridge && typeof global.Bridge.auditRecent === 'function') items = global.Bridge.auditRecent(50);
    } catch (e) {
      warn('读取审计日志失败：' + errText(e));
    }
    if (!Array.isArray(items)) items = [];
    var U = getUI();
    if (U && typeof U.renderAudit === 'function') {
      try { U.renderAudit(items); } catch (e2) { warn('UI.renderAudit 异常：' + errText(e2)); }
    } else {
      toast('审计日志：' + items.length + ' 条', true);
    }
    return items;
  }

  /** handlers.onSetWorkspace([path])：可传路径；无参时先用 UI.prompt 收集，成功后刷新 workspaceInfo */
  /** 原生 setWorkspace 异步完成：更新 workspaceInfo + 刷新文件树（由 bindBridgeEvents 调用） */
  function onWorkspaceChanged(evt) {
    if (!evt || typeof evt !== 'object') return;
    if (evt.ok === false) {
      toast('更改工作区失败：' + (evt.message || '路径无效或缺少存储权限'), true);
      refreshWorkspaceInfo();
      return;
    }
    refreshWorkspaceInfo(); /* 原生 setRoot 已完成，重新读取完整 workspaceInfo（含 defaultRoot/isDefault） */
    loadWorkspaceDir('');
  }

  /**
   * 应用新工作区：Bridge.setWorkspace → 等待 workspace-changed（原生异步 setRoot）
   * → 刷新 workspaceInfo/文件树；旧原生无该事件时用 900ms 兜底刷新。
   */
  function applyWorkspacePath(path) {
    var p = String(path === null || path === undefined ? '' : path).replace(/^\s+|\s+$/g, '');
    if (!p) { toast('路径不能为空'); return false; }
    var B = global.Bridge;
    if (!B || typeof B.setWorkspace !== 'function') { toast('当前环境不支持更改工作区', true); return false; }
    var ok = false;
    try { ok = B.setWorkspace(p) !== false; } catch (e) {
      warn('setWorkspace 失败：' + errText(e));
      ok = false;
    }
    if (!ok) { toast('更改工作区失败（路径无效或缺少存储权限）', true); return false; }
    var settled = false;
    var fallbackTimer = setTimeout(function () {
      if (settled) return;
      settled = true;
      var info = refreshWorkspaceInfo();
      toast('工作区已切换：' + (info.root || p), true);
      loadWorkspaceDir('');
    }, 900);
    if (typeof B.waitForEvent === 'function') {
      B.waitForEvent('workspace-changed', function (evt) { return !evt || evt.ok !== false; }, 3000).then(function (evt) {
        if (settled) return;
        settled = true;
        clearTimeout(fallbackTimer);
        if (evt && evt.ok === false) {
          toast('更改工作区失败：' + (evt.message || p), true);
          refreshWorkspaceInfo();
          return;
        }
        var info = refreshWorkspaceInfo();
        var root = (info && info.root) || (evt && evt.root ? String(evt.root) : p);
        toast('工作区已切换：' + root, true);
        loadWorkspaceDir('');
      });
    }
    return true;
  }

  function setWorkspace(path) {
    if (path !== undefined && path !== null && String(path) !== '') return applyWorkspacePath(path);
    var current = state.workspace && state.workspace.root ? state.workspace.root : '';
    return promptAsync('更改工作区', current, '例如 /sdcard/house-workspace').then(function (value) {
      if (value === null || value === undefined) return false;
      return applyWorkspacePath(value);
    });
  }

  /** handlers.onResetWorkspace()：从 workspaceInfo.defaultRoot 恢复默认工作区 */
  function resetWorkspace() {
    var info = refreshWorkspaceInfo();
    var def = info && info.defaultRoot ? String(info.defaultRoot) : '';
    if (!def) {
      toast('当前原生未返回默认工作区路径', true);
      return false;
    }
    return applyWorkspacePath(def);
  }

  /* ------------------------------------------------------------------ *
   * ARCH v2 P2：MCP Client —— 配置 CRUD / 连接管理 / 工具缓存 / 构建进度
   * 工具调用本身仍由原生 ToolRegistry 注册并走现有 execTool 路径；
   * 这里只负责：服务器列表/状态、mcp-tools 缓存、mcp-progress → 工具卡进度/日志。
   * ------------------------------------------------------------------ */

  /** 工具名 → 基础名（兼容 `mcp:<serverId>:<tool>` 与原生重名去重后的 `mcp_<server>_<tool>` 形式） */
  function mcpBaseName(name) {
    var raw = String(name === null || name === undefined ? '' : name);
    if (raw.indexOf('mcp:') === 0) {
      var parts = raw.split(':');
      if (parts.length >= 3) return parts[parts.length - 1];
    }
    /* 原始名直接命中构建工具 */
    if (BUILD_TOOL_NAMES[raw]) return raw;
    /* 原生 ToolRegistry 重名去重：mcp_<server>_<tool>（server 里可能有 -/_，用后缀匹配构建工具名） */
    if (raw.indexOf('mcp') === 0) {
      var keys = Object.keys(BUILD_TOOL_NAMES);
      for (var i = 0; i < keys.length; i++) {
        var suffix = '_' + keys[i];
        if (raw.length > suffix.length && raw.slice(-suffix.length) === suffix) return keys[i];
      }
    }
    return raw;
  }

  /** 解析 mcp:<serverId>:<tool>；非该形式时 serverId 为空 */
  function parseMcpToolName(name) {
    var raw = String(name === null || name === undefined ? '' : name);
    if (raw.indexOf('mcp:') === 0) {
      var parts = raw.split(':');
      if (parts.length >= 3) return { serverId: parts[1], base: parts[parts.length - 1] };
    }
    return { serverId: '', base: raw };
  }

  function isBuildToolName(name) {
    return !!BUILD_TOOL_NAMES[mcpBaseName(name)];
  }

  /** 是否需要 running 工具卡（构建类工具或来自 MCP 的工具） */
  function isMcpProgressTool(name) {
    var parsed = parseMcpToolName(name);
    if (isBuildToolName(parsed.base)) return true;
    if (parsed.serverId) return true;
    return !!(state.mcpToolMap[parsed.base] || state.mcpToolMap[String(name === null || name === undefined ? '' : name)]);
  }

  function findMcpServer(id) {
    var key = String(id === null || id === undefined ? '' : id);
    for (var i = 0; i < state.mcpServers.length; i++) {
      if (String(state.mcpServers[i].id) === key) return state.mcpServers[i];
    }
    return null;
  }

  /** 服务端 mcp-tools / 配置里的 tools 归一化 */
  function normalizeMcpToolList(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      if (!item || typeof item !== 'object') continue;
      var name = item.name === null || item.name === undefined ? '' : String(item.name);
      if (!name) continue;
      out.push({ name: name, description: item.description === null || item.description === undefined ? '' : String(item.description) });
    }
    return out;
  }

  function ensureMcpStatusEntries(list) {
    for (var i = 0; i < list.length; i++) {
      var server = list[i];
      var st = state.mcpStatus[server.id];
      if (!st) {
        var initialStatus = server.status ? String(server.status) : (server.connected ? 'connected' : 'disconnected');
        st = {
          status: initialStatus,
          message: server.message ? String(server.message) : '',
          tools: normalizeMcpToolList(server.tools),
          toolCount: 0
        };
        st.toolCount = st.tools.length || (Number(server.toolCount) || 0);
        state.mcpStatus[server.id] = st;
      } else {
        if (!st.status) st.status = server.status ? String(server.status) : 'disconnected';
        if ((!st.tools || !st.tools.length) && Array.isArray(server.tools) && server.tools.length) {
          st.tools = normalizeMcpToolList(server.tools);
          st.toolCount = st.tools.length;
        }
      }
    }
  }

  /** 读取服务器配置（Bridge.mcpServers 同步 JSON），刷新 state.mcpServers/mcpStatus */
  function loadMcpServers(force) {
    var list = [];
    try {
      if (global.Bridge && typeof global.Bridge.mcpServers === 'function') list = global.Bridge.mcpServers();
    } catch (e) {
      warn('读取 MCP 服务器失败：' + errText(e));
    }
    if (!Array.isArray(list)) list = [];
    state.mcpServers = list;
    ensureMcpStatusEntries(list);
    rebuildMcpToolMap();
    return state.mcpServers;
  }

  /** state.mcpStatus → 工具名（base）→ serverId 映射（MCP 工具识别/进度匹配） */
  function rebuildMcpToolMap() {
    var map = {};
    var toolsById = {};
    var ids = Object.keys(state.mcpStatus);
    for (var i = 0; i < ids.length; i++) {
      var st = state.mcpStatus[ids[i]];
      var tools = st && Array.isArray(st.tools) ? st.tools : [];
      toolsById[ids[i]] = tools.map(function (t) { return { name: t.name, description: t.description }; });
      for (var j = 0; j < tools.length; j++) {
        var name = tools[j] && tools[j].name ? String(tools[j].name) : '';
        if (!name) continue;
        map[name] = ids[i];
      }
    }
    state.mcpToolMap = map;
    state.mcpTools = toolsById;
  }

  /** UI.renderMcpServers 的第二参数：{id:{status,message,toolCount,tools}} */
  function buildMcpStatusMap() {
    var map = {};
    for (var i = 0; i < state.mcpServers.length; i++) {
      var server = state.mcpServers[i];
      var st = state.mcpStatus[server.id] || {};
      var tools = Array.isArray(st.tools) ? st.tools : normalizeMcpToolList(server.tools);
      map[server.id] = {
        status: st.status || (server.status ? String(server.status) : 'disconnected'),
        message: st.message || '',
        toolCount: tools.length || st.toolCount || Number(server.toolCount) || 0,
        tools: tools
      };
    }
    return map;
  }

  function renderMcpServers() {
    if (!state.mcpPageLoaded) return;
    ui('renderMcpServers', state.mcpServers, buildMcpStatusMap());
  }

  /** handlers.onOpenMcp / App.openMcpPage：加载配置 + 渲染列表（UI.openMcpPage 由 UI 负责显示屏幕） */
  function openMcpPage() {
    var list = loadMcpServers(true);
    state.mcpPageLoaded = true;
    /* 已连接但本地还没有工具缓存（如原生启动后自动连接）→ 同步 mcpTools 补全，UI 直接显示工具数 */
    for (var i = 0; i < list.length; i++) {
      var st = state.mcpStatus[list[i].id];
      if (!st || (st.status !== 'connected' && st.status !== 'connecting')) continue;
      if (Array.isArray(st.tools) && st.tools.length) continue;
      try {
        if (global.Bridge && typeof global.Bridge.mcpTools === 'function') {
          var tools = global.Bridge.mcpTools(list[i].id);
          if (Array.isArray(tools) && tools.length) {
            st.tools = tools;
            st.toolCount = tools.length;
          }
        }
      } catch (e) { warn('读取 MCP 工具失败：' + errText(e)); }
    }
    rebuildMcpToolMap();
    ui('renderMcpServers', list, buildMcpStatusMap());
    return list;
  }

  /** App.showMcpPage()：从任意入口打开 MCP 页（必要时先让 UI 显示 #screen-mcp） */
  function showMcpPage() {
    if (state.mcpOpening) return state.mcpServers;
    var U = getUI();
    var screen = U && typeof U.getScreen === 'function' ? String(U.getScreen() || '') : '';
    if (screen !== 'mcp') {
      state.mcpOpening = true;
      try { ui('openMcpPage'); } finally { state.mcpOpening = false; }
    }
    return openMcpPage();
  }

  /* ---------------- MCP 事件：状态 / 工具发现 / 构建进度 ---------------- */

  function onMcpStatus(evt) {
    if (!evt) return;
    var id = evt.id === null || evt.id === undefined ? '' : String(evt.id);
    if (!id) return;
    var status = String(evt.status || 'disconnected');
    if (status !== 'connecting' && status !== 'connected' && status !== 'disconnected' && status !== 'error') status = 'disconnected';
    var st = state.mcpStatus[id];
    if (!st) st = state.mcpStatus[id] = { status: 'disconnected', message: '', tools: [], toolCount: 0 };
    st.status = status;
    st.message = evt.message === null || evt.message === undefined ? '' : String(evt.message);
    if (status === 'disconnected') {
      st.tools = [];
      st.toolCount = 0;
      rebuildMcpToolMap();
    }
    if (status === 'connected' && (!Array.isArray(st.tools) || !st.tools.length)) {
      try {
        if (global.Bridge && typeof global.Bridge.mcpTools === 'function') {
          var hydrated = global.Bridge.mcpTools(id);
          if (Array.isArray(hydrated) && hydrated.length) {
            st.tools = hydrated;
            st.toolCount = hydrated.length;
            rebuildMcpToolMap();
          }
        }
      } catch (e) { /* ignore */ }
    }
    renderMcpServers();
    if (status === 'connected') toast('MCP 服务器已连接' + (id ? '：' + id : ''));
    else if (status === 'error') toast('MCP 连接失败：' + (st.message || id), true);
  }

  function onMcpTools(evt) {
    if (!evt) return;
    var id = evt.id === null || evt.id === undefined ? '' : String(evt.id);
    if (!id) return;
    var tools = normalizeMcpToolList(evt.tools);
    var st = state.mcpStatus[id];
    if (!st) st = state.mcpStatus[id] = { status: 'connected', message: '', tools: [], toolCount: 0 };
    st.tools = tools;
    st.toolCount = tools.length;
    if (!st.status || st.status === 'disconnected' || st.status === 'connecting') {
      /* 工具列表到达意味着连接可用（兼容只发 mcp-tools 的实现） */
      if (tools.length) st.status = 'connected';
    }
    rebuildMcpToolMap();
    renderMcpServers();
  }

  function findRunningEntry(msgId) {
    for (var i = 0; i < state.runningToolMsgs.length; i++) {
      if (state.runningToolMsgs[i].msgId === msgId) return state.runningToolMsgs[i];
    }
    return null;
  }

  /** 按工具名（兼容 mcp:server:tool 后缀）匹配最近一条 running 工具卡 */
  function findRunningToolMsg(toolName, serverId) {
    var base = mcpBaseName(toolName);
    for (var i = state.runningToolMsgs.length - 1; i >= 0; i--) {
      var item = state.runningToolMsgs[i];
      if (item.base !== base) continue;
      if (serverId && item.serverId && String(item.serverId) !== String(serverId)) continue;
      return item;
    }
    /* 兜底：server 侧 progress.tool 为原始名，工具调用名可能是 mcp_<server>_<tool> → 后缀匹配 */
    var rawTool = String(toolName === null || toolName === undefined ? '' : toolName);
    for (var j = state.runningToolMsgs.length - 1; j >= 0; j--) {
      var candidate = state.runningToolMsgs[j];
      if (!candidate.base) continue;
      var suffix = '_' + candidate.base;
      if (rawTool.length > suffix.length && rawTool.slice(-suffix.length) === suffix) {
        if (serverId && candidate.serverId && String(candidate.serverId) !== String(serverId)) continue;
        return candidate;
      }
    }
    if (state.currentToolMsgId) {
      var cur = findRunningEntry(state.currentToolMsgId);
      if (cur && cur.base === base && (!serverId || !cur.serverId || String(cur.serverId) === String(serverId))) return cur;
    }
    return null;
  }

  /** 建 running 工具卡（进度条/日志流后续 update 同一条消息） */
  function createRunningToolMessage(chat, name, args, toolCallId) {
    if (!chat) return null;
    var parsed = parseMcpToolName(name);
    var serverId = parsed.serverId || state.mcpToolMap[parsed.base] || state.mcpToolMap[String(name === null || name === undefined ? '' : name)] || '';
    var msg = Store.appendMessage(chat.id, {
      role: 'tool',
      content: '执行中…',
      toolName: name,
      toolCallId: toolCallId,
      args: args === undefined || args === null ? {} : args,
      result: '',
      confirmState: 'running',
      progress: { percent: 0, line: '' },
      toolLog: []
    });
    if (!msg) return null;
    var entry = {
      msgId: msg.id,
      chatId: chat.id,
      name: name,
      base: parsed.base,
      serverId: String(serverId || '')
    };
    state.runningToolMsgs.push(entry);
    state.currentToolMsgId = msg.id;
    state.currentToolName = name;
    state.currentToolServerId = entry.serverId;
    state.mcpProgressByMsg[msg.id] = { percent: 0, line: '' };
    ui('appendMessage', msg);
    ui('scrollBottom');
    ui('setToolProgress', msg.id, { percent: 0, line: '' });
    return msg;
  }

  function updateRunningToolMessage(entry, patch) {
    if (!entry || !patch) return null;
    try {
      var updated = Store.updateMessage(entry.chatId, entry.msgId, patch);
      if (updated) ui('updateMessage', entry.msgId, patch);
      return updated || null;
    } catch (e) {
      warn('更新工具卡失败：' + errText(e));
      return null;
    }
  }

  function cleanupRunningToolMsg(entry) {
    if (!entry) return;
    for (var i = state.runningToolMsgs.length - 1; i >= 0; i--) {
      if (state.runningToolMsgs[i].msgId === entry.msgId) state.runningToolMsgs.splice(i, 1);
    }
    if (state.currentToolMsgId === entry.msgId) {
      state.currentToolMsgId = null;
      state.currentToolName = '';
      state.currentToolServerId = '';
    }
  }

  /** tool-result 到达：把 running 卡 update 成完成/失败态（不新增消息） */
  function finalizeProgressToolMessage(entry, resultText, ok, stateText, confirmed) {
    if (!entry) return null;
    var prog = state.mcpProgressByMsg[entry.msgId] || { percent: 0, line: '' };
    var percent = Number(prog.percent) || 0;
    if (ok && percent <= 0) percent = 100;
    var line = prog.line || (ok ? '完成' : '执行失败');
    var patch = {
      content: resultText,
      result: resultText,
      ok: !!ok,
      confirmState: stateText || (ok ? 'success' : 'error'),
      confirmed: !!confirmed,
      progress: { percent: percent, line: line }
    };
    var updated = updateRunningToolMessage(entry, patch);
    /* P4：同步构建任务状态 */
    try {
      var task = findBuildTaskForMsg(entry.msgId);
      if (task) finalizeBuildTask(task, !!ok, stateText, line);
    } catch (e) { warn('更新构建任务失败：' + errText(e)); }
    delete state.mcpProgressByMsg[entry.msgId];
    cleanupRunningToolMsg(entry);
    return updated;
  }

  /** mcp-progress → 最近 running 的对应工具卡：进度条 + 日志（最多 200 行） */
  function onMcpProgress(evt) {
    if (!evt) return;
    var toolName = evt.tool === null || evt.tool === undefined ? '' : String(evt.tool);
    var serverId = evt.id === null || evt.id === undefined ? '' : String(evt.id);
    var percent = Number(evt.percent);
    if (!isFinite(percent)) percent = 0;
    percent = Math.max(0, Math.min(100, Math.round(percent)));
    var line = evt.line === null || evt.line === undefined ? '' : String(evt.line);
    var entry = findRunningToolMsg(toolName, serverId);
    if (!entry) return; /* 没有对应 running 工具卡：忽略（可能已完成或非工具发起的进度） */
    var prev = state.mcpProgressByMsg[entry.msgId] || { percent: 0, line: '' };
    state.mcpProgressByMsg[entry.msgId] = { percent: percent, line: line || prev.line };
    var logs = [];
    try {
      var chat = Store.getChat(entry.chatId);
      var msg = null;
      if (chat) {
        for (var i = 0; i < chat.messages.length; i++) {
          if (chat.messages[i].id === entry.msgId) { msg = chat.messages[i]; break; }
        }
      }
      if (msg && Array.isArray(msg.toolLog)) logs = msg.toolLog.slice();
    } catch (e) { logs = []; }
    var patch = {
      progress: { percent: percent, line: line || prev.line },
      percent: percent
    };
    if (line) {
      logs.push(line);
      while (logs.length > MCP_LOG_MAX) logs.shift();
      patch.toolLog = logs;
      patch.log = logs.join('\n');
    }
    try { Store.updateMessage(entry.chatId, entry.msgId, patch); } catch (e2) { /* ignore */ }
    ui('setToolProgress', entry.msgId, { percent: percent, line: line });
    if (line) ui('appendToolLog', entry.msgId, line);
    /* P4：同步构建任务面板进度 */
    try {
      var task = findBuildTaskForMsg(entry.msgId) || findBuildTaskForTool(toolName, serverId);
      if (task) updateBuildTaskProgress(task, percent, line);
    } catch (e) { warn('更新构建任务进度失败：' + errText(e)); }
  }

  /* ---------------- MCP 配置 CRUD / 连接 ---------------- */

  function normalizeMcpServerPayload(server) {
    if (!server || typeof server !== 'object') return null;
    var name = String(server.name === null || server.name === undefined ? '' : server.name).replace(/^\s+|\s+$/g, '');
    var url = String(server.url === null || server.url === undefined ? '' : server.url).replace(/^\s+|\s+$/g, '');
    if (!name) return null;
    if (!/^https?:\/\/\S+/i.test(url)) return null;
    var out = {
      name: name,
      url: url,
      token: server.token === null || server.token === undefined ? '' : String(server.token),
      enabled: server.enabled !== false
    };
    if (server.id) out.id = String(server.id);
    return out;
  }

  /** handlers.onMcpSave(server)：新增/编辑；server.connect=true 时保存后自动连接 */
  function saveMcpServer(server) {
    var payload = normalizeMcpServerPayload(server);
    if (!payload) { toast('请填写名称与 http(s):// URL', true); return false; }
    var beforeIds = {};
    for (var i = 0; i < state.mcpServers.length; i++) beforeIds[state.mcpServers[i].id] = true;
    var ok = false;
    try {
      if (global.Bridge && typeof global.Bridge.mcpSaveServer === 'function') ok = global.Bridge.mcpSaveServer(payload) !== false;
    } catch (e) {
      warn('保存 MCP 服务器失败：' + errText(e));
      ok = false;
    }
    if (!ok) { toast('保存 MCP 服务器失败', true); return false; }
    var list = loadMcpServers(true);
    var savedId = payload.id || '';
    if (!savedId) {
      for (var j = 0; j < list.length; j++) {
        if (!beforeIds[list[j].id]) { savedId = list[j].id; break; }
      }
      if (!savedId) {
        for (var k = 0; k < list.length; k++) {
          if (String(list[k].name) === payload.name && String(list[k].url) === payload.url) { savedId = list[k].id; break; }
        }
      }
    }
    renderMcpServers();
    toast(payload.id ? 'MCP 服务器已更新' : 'MCP 服务器已添加', true);
    var wantConnect = !!server.connect;
    if (wantConnect && savedId) {
      /* 原生 mcpSaveServer 会对 enabled 服务器自动连接（status connecting/connected）；
         只有原生没有自动连接时才由 JS 补一次 mcpConnect，避免重复连接。 */
      var savedServer = findMcpServer(savedId);
      var autoConnecting = !!(savedServer && (savedServer.connected === true
        || savedServer.status === 'connecting' || savedServer.status === 'connected'
        || (state.mcpStatus[savedId] && (state.mcpStatus[savedId].status === 'connecting' || state.mcpStatus[savedId].status === 'connected'))));
      if (!autoConnecting) connectMcpServer(savedId);
    }
    return true;
  }

  /** handlers.onMcpDelete(id) */
  function deleteMcpServer(id) {
    var key = String(id === null || id === undefined ? '' : id);
    if (!key) return false;
    var ok = false;
    try {
      if (global.Bridge && typeof global.Bridge.mcpDeleteServer === 'function') ok = global.Bridge.mcpDeleteServer(key) !== false;
    } catch (e) { warn('删除 MCP 服务器失败：' + errText(e)); }
    if (!ok) { toast('删除 MCP 服务器失败', true); return false; }
    delete state.mcpStatus[key];
    loadMcpServers(true);
    renderMcpServers();
    toast('已删除 MCP 服务器', true);
    return true;
  }

  /** handlers.onMcpConnect(id)：connecting 状态由 mcp-status 事件推进 */
  function connectMcpServer(id) {
    var key = String(id === null || id === undefined ? '' : id);
    if (!key) return false;
    if (!findMcpServer(key)) { toast('服务器不存在', true); return false; }
    var st = state.mcpStatus[key];
    if (!st) st = state.mcpStatus[key] = { status: 'disconnected', message: '', tools: [], toolCount: 0 };
    st.status = 'connecting';
    st.message = '';
    renderMcpServers();
    var ok = false;
    try {
      if (global.Bridge && typeof global.Bridge.mcpConnect === 'function') ok = global.Bridge.mcpConnect(key) !== false;
    } catch (e) { warn('连接 MCP 服务器失败：' + errText(e)); }
    if (!ok) {
      st.status = 'error';
      st.message = '无法连接（原生不可用）';
      renderMcpServers();
      toast('连接 MCP 服务器失败', true);
      return false;
    }
    return true;
  }

  function disconnectMcpServer(id) {
    var key = String(id === null || id === undefined ? '' : id);
    if (!key) return false;
    var ok = false;
    try {
      if (global.Bridge && typeof global.Bridge.mcpDisconnect === 'function') ok = global.Bridge.mcpDisconnect(key) !== false;
    } catch (e) { warn('断开 MCP 服务器失败：' + errText(e)); }
    var st = state.mcpStatus[key];
    if (st) { st.status = 'disconnected'; st.message = ''; st.tools = []; st.toolCount = 0; }
    rebuildMcpToolMap();
    renderMcpServers();
    if (ok) toast('已断开 MCP 服务器');
    return ok;
  }

  function refreshMcpServerTools(id) {
    var key = String(id === null || id === undefined ? '' : id);
    if (!key) return false;
    var ok = false;
    try {
      if (global.Bridge && typeof global.Bridge.mcpRefreshTools === 'function') ok = global.Bridge.mcpRefreshTools(key) !== false;
    } catch (e) { warn('刷新 MCP 工具失败：' + errText(e)); }
    if (ok) toast('正在刷新 MCP 工具列表…');
    else toast('刷新 MCP 工具失败', true);
    return ok;
  }

  /** handlers.onMcpTest(id)：连接并等待 mcp-tools（成功提示工具数，失败/超时提示） */
  function testMcpServer(id) {
    var key = String(id === null || id === undefined ? '' : id);
    if (!key) return false;
    if (!findMcpServer(key)) { toast('服务器不存在', true); return false; }
    if (!connectMcpServer(key)) return false;
    var B = global.Bridge;
    if (!B || typeof B.waitMcpTools !== 'function') return true;
    var finished = false;
    function finish(message, force) {
      if (finished) return;
      finished = true;
      toast(message, !!force);
    }
    var statusWait = typeof B.waitMcpStatus === 'function'
      ? B.waitMcpStatus(key, 12000)
      : null;
    var toolsWait = B.waitMcpTools(key, 12000);
    if (statusWait && typeof statusWait.then === 'function') {
      statusWait.then(function (evt) {
        if (evt && evt.status === 'error') finish('MCP 连接失败：' + (evt.message || '未知错误'), true);
      });
    }
    if (toolsWait && typeof toolsWait.then === 'function') {
      toolsWait.then(function (evt) {
        if (evt && Array.isArray(evt.tools)) {
          onMcpTools(evt);
          finish('MCP 连接成功，发现 ' + evt.tools.length + ' 个工具', true);
        } else {
          finish('MCP 连接超时，请检查 URL / Token', true);
        }
      });
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * ARCH v2 P3：HousePlugin 插件面板 / 插件市场 / 记忆（UI 只渲染，逻辑在这里）
   * ------------------------------------------------------------------ */

  function dsPlugins() {
    return global.DSPlugins || null;
  }

  /** 加载 HousePlugin（plugins.js 未实现时安全跳过）；完成后刷新插件列表与 slots */
  function loadHousePluginsAndSlots() {
    var P = dsPlugins();
    if (!P || typeof P.loadHousePlugins !== 'function') { refreshPluginSlots(); return Promise.resolve([]); }
    var work;
    try { work = P.loadHousePlugins(); } catch (e) {
      warn('DSPlugins.loadHousePlugins 失败：' + errText(e));
      refreshPluginSlots();
      return Promise.resolve([]);
    }
    return Promise.resolve(work).then(function (res) {
      try { refreshPlugins(); } catch (e1) { /* ignore */ }
      refreshPluginSlots();
      return res || [];
    }, function (err) {
      warn('HousePlugin 加载异常：' + errText(err));
      refreshPluginSlots();
      return [];
    });
  }

  function pluginSlotContext() {
    var chat = Store.getActiveChat();
    if (!chat) return { chatId: Store.getActiveChatId() };
    return {
      chatId: chat.id,
      chat: { id: chat.id, title: chat.title, model: chat.model }
    };
  }

  /** 收集 DSPlugins.getUiSlots(ctx)（兼容 uiSlots/listSlots），返回纯数据数组 */
  function collectPluginSlots() {
    var P = dsPlugins();
    var slots = [];
    try {
      if (P) {
        var ctx = pluginSlotContext();
        if (typeof P.getUiSlots === 'function') slots = P.getUiSlots(ctx);
        else if (typeof P.uiSlots === 'function') slots = P.uiSlots(ctx);
        else if (typeof P.listSlots === 'function') slots = P.listSlots(ctx);
      }
    } catch (e) { warn('收集插件 slots 失败：' + errText(e)); }
    if (!Array.isArray(slots)) return [];
    var out = [];
    for (var i = 0; i < slots.length; i++) {
      if (slots[i] && typeof slots[i] === 'object') out.push(slots[i]);
    }
    return out;
  }

  function refreshPluginSlots() {
    state.pluginSlots = collectPluginSlots();
    ui('renderPluginSlots', state.pluginSlots);
    return state.pluginSlots;
  }

  /** App.showPluginPanel()：必要时让 UI 打开面板（UI.openPluginPanel 会回调 onOpenPluginPanel） */
  function showPluginPanel() {
    if (state.pluginPanelOpening) return state.pluginSlots;
    refreshPluginSlots();
    var U = getUI();
    var open = U && typeof U.isPluginPanelOpen === 'function' ? !!U.isPluginPanelOpen() : false;
    if (!open && U && typeof U.openPluginPanel === 'function') {
      state.pluginPanelOpening = true;
      try { ui('openPluginPanel'); } finally { state.pluginPanelOpening = false; }
      refreshPluginSlots();
    }
    return state.pluginSlots;
  }

  function pluginSlotResultText(res) {
    if (res === null || res === undefined) return '';
    if (typeof res === 'string') return res;
    if (typeof res === 'object') {
      if (res.ok === false && res.error) return '插件操作失败：' + String(res.error);
      var value = res.result !== undefined ? res.result : (res.message !== undefined ? res.message : '');
      if (value === null || value === undefined || value === '') return res.ok === true ? '插件操作完成' : '';
      return typeof value === 'string' ? value : safeStringify(value);
    }
    return String(res);
  }

  /** handlers.onSlotAction(slotId, action, payload) → DSPlugins.runSlotAction */
  function runPluginSlotAction(slotId, actionId, payload) {
    var P = dsPlugins();
    var id = String(slotId === null || slotId === undefined ? '' : slotId);
    if (!id) { toast('插件动作无效', true); return false; }
    var action = String(actionId === null || actionId === undefined || actionId === '' ? 'run' : actionId);
    var ctxPayload = payload && typeof payload === 'object' ? payload : {};
    if (ctxPayload.chatId === undefined) ctxPayload.chatId = Store.getActiveChatId();
    var fn = null;
    if (P) {
      if (typeof P.runSlotAction === 'function') fn = P.runSlotAction;
      else if (typeof P.dispatchSlotAction === 'function') fn = P.dispatchSlotAction;
      else if (typeof P.triggerSlot === 'function') fn = P.triggerSlot;
    }
    if (!fn) { toast('插件面板功能尚未实现', true); return false; }
    return Promise.resolve(fn.call(P, id, action, ctxPayload)).then(function (res) {
      try { refreshPluginSlots(); } catch (e) { /* ignore */ }
      var text = pluginSlotResultText(res);
      if (text) toast(text.length > 200 ? (text.slice(0, 200) + '…') : text, true);
      return res;
    }, function (err) {
      toast('插件操作失败：' + errText(err), true);
      return false;
    });
  }

  /* ---------------- 插件市场 ---------------- */

  function marketUrlSaved() {
    try { return String(global.localStorage.getItem(MARKET_URL_KEY) || ''); } catch (e) { return ''; }
  }

  function saveMarketUrl(url) {
    try { global.localStorage.setItem(MARKET_URL_KEY, String(url || '')); } catch (e) { /* ignore */ }
  }

  function httpGetText(url, timeoutMs) {
    var target = String(url === null || url === undefined ? '' : url);
    if (global.Api && typeof global.Api.fetchUrl === 'function') {
      return global.Api.fetchUrl(target, { timeout: timeoutMs || 15000 });
    }
    return Promise.resolve({ ok: false, status: 0, body: '', error: '网络模块不可用' });
  }

  function sanitizePluginFilePart(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 80);
  }

  function normalizeMarketItems(source) {
    var raw = [];
    if (Array.isArray(source)) raw = source;
    else if (source && Array.isArray(source.plugins)) raw = source.plugins;
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      if (!item || typeof item !== 'object') continue;
      var id = item.id === null || item.id === undefined ? '' : String(item.id);
      if (!id) continue;
      out.push({
        id: id,
        name: item.name === null || item.name === undefined ? id : String(item.name),
        version: item.version === null || item.version === undefined ? '1.0.0' : String(item.version),
        author: item.author === null || item.author === undefined ? '' : String(item.author),
        description: item.description === null || item.description === undefined ? '' : String(item.description),
        url: item.url === null || item.url === undefined ? '' : String(item.url),
        sha256: item.sha256 === null || item.sha256 === undefined ? '' : String(item.sha256),
        hmac: item.hmac === null || item.hmac === undefined ? '' : String(item.hmac),
        tags: Array.isArray(item.tags) ? item.tags.map(function (t) { return String(t); }) : []
      });
    }
    return out;
  }

  /** Bridge.pluginList() → 已安装插件（id → {version,fileName}）；并兼容 "<id>-<version>.js" 文件名 */
  function installedPluginMap() {
    var list = [];
    try {
      if (global.Bridge && typeof global.Bridge.pluginList === 'function') list = global.Bridge.pluginList();
    } catch (e) { warn('读取插件目录失败：' + errText(e)); }
    if (!Array.isArray(list)) list = [];
    var map = {};
    for (var i = 0; i < list.length; i++) {
      var plugin = list[i];
      if (!plugin || typeof plugin !== 'object') continue;
      var id = String(plugin.id || '');
      var fileName = String(plugin.fileName || '');
      var version = String(plugin.version || '');
      var entry = { version: version, fileName: fileName, enabled: plugin.enabled !== false };
      if (id) map[id] = entry;
      var m = /^(.+)-(\d[\w.+-]*)\.js$/i.exec(fileName);
      if (m && !map[m[1]]) map[m[1]] = { version: m[2], fileName: fileName, enabled: plugin.enabled !== false };
    }
    return { list: list, map: map };
  }

  function computeMarketStatusMap(items) {
    var map = {};
    var list = Array.isArray(items) ? items : [];
    var installed = installedPluginMap().map;
    var P = dsPlugins();
    var usedPluginHelper = false;
    if (P && typeof P.marketStatusMap === 'function') {
      try {
        var helper = P.marketStatusMap(list);
        if (helper && typeof helper === 'object') { map = helper; usedPluginHelper = true; }
      } catch (e) { warn('DSPlugins.marketStatusMap 失败：' + errText(e)); }
    }
    if (!usedPluginHelper) {
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        var id = String(item.id || '');
        if (!id) continue;
        var inst = installed[id];
        if (!inst) map[id] = { status: 'not_installed' };
        else if (String(inst.version) === String(item.version)) map[id] = { status: 'installed', version: inst.version };
        else map[id] = { status: 'update', version: inst.version };
      }
    }
    /* 保留瞬态状态（安装中 / 校验失败 / 安装失败），直到下次显式刷新 */
    var prev = state.market.statusMap || {};
    var ids = Object.keys(prev);
    for (var j = 0; j < ids.length; j++) {
      var value = prev[ids[j]];
      var status = value && typeof value === 'object' ? value.status : value;
      if (status === 'installing' || status === 'invalid' || status === 'error') map[ids[j]] = value;
    }
    return map;
  }

  function renderMarketPage() {
    ui('renderMarket', state.market.items, state.market.statusMap);
    if (state.market.url) ui('setMarketUrl', state.market.url);
  }

  function refreshMarketStatusSoon() {
    setTimeout(function () {
      if (!state.market || !state.market.items.length) return;
      state.market.statusMap = computeMarketStatusMap(state.market.items);
      renderMarketPage();
    }, 80);
  }

  /** handlers.onOpenMarket：读取已保存索引 URL → 有则拉取，无则渲染空列表（含已装状态） */
  function loadMarketData() {
    var saved = marketUrlSaved();
    if (saved) state.market.url = saved;
    state.market.statusMap = computeMarketStatusMap(state.market.items);
    renderMarketPage();
    if (state.market.url) return fetchMarketIndex(state.market.url);
    return Promise.resolve(false);
  }

  function showMarketPage() {
    if (state.marketOpening) return loadMarketData();
    var U = getUI();
    var screen = U && typeof U.getScreen === 'function' ? String(U.getScreen() || '') : '';
    if (screen !== 'market') {
      state.marketOpening = true;
      try { ui('openMarketPage'); } finally { state.marketOpening = false; }
    }
    return loadMarketData();
  }

  /** handlers.onMarketFetch(url)：Bridge.httpFetch（Api.fetchUrl 封装）拉索引 → 解析 → renderMarket */
  function fetchMarketIndex(url) {
    var target = String(url === null || url === undefined ? '' : url).replace(/^\s+|\s+$/g, '');
    if (!target) { toast('请输入市场索引 URL', true); renderMarketPage(); return Promise.resolve(false); }
    var isLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(target);
    if (!/^https:\/\//i.test(target) && !isLocal) {
      toast('市场索引仅支持 https://（本地 http://127.0.0.1 例外）', true);
      renderMarketPage();
      return Promise.resolve(false);
    }
    saveMarketUrl(target);
    state.market.url = target;
    state.market.loading = true;
    var P = dsPlugins();
    var work;
    if (P && typeof P.fetchMarketIndex === 'function') {
      try { work = P.fetchMarketIndex(target, { timeout: 15000 }); } catch (e) { work = Promise.reject(e); }
    } else {
      work = httpGetText(target, 15000).then(function (res) {
        if (!res || !res.ok) return { ok: false, error: (res && res.error) ? String(res.error) : ('HTTP ' + ((res && res.status) || 0)) };
        var index = null;
        try { index = JSON.parse(String(res.body || '')); } catch (e) { index = null; }
        if (!index || !Array.isArray(index.plugins)) return { ok: false, error: '索引格式不正确（缺少 plugins 数组）' };
        return { ok: true, index: index, items: index.plugins, fetchedAt: Date.now() };
      });
    }
    return Promise.resolve(work).then(function (res) {
      state.market.loading = false;
      if (!res || res.ok === false) {
        var msg = res && res.error ? String(res.error) : '拉取失败';
        state.market.error = msg;
        state.market.items = [];
        state.market.statusMap = {};
        renderMarketPage();
        toast('市场索引拉取失败：' + msg, true);
        return false;
      }
      var items = normalizeMarketItems(res.items || res.index);
      state.market.items = items;
      state.market.fetchedAt = Number(res.fetchedAt) || Date.now();
      state.market.error = '';
      state.market.statusMap = computeMarketStatusMap(items);
      renderMarketPage();
      if (!items.length) toast('市场索引为空（0 个插件）');
      else toast('市场索引已加载：' + items.length + ' 个插件', true);
      return true;
    }, function (err) {
      state.market.loading = false;
      state.market.error = errText(err);
      renderMarketPage();
      toast('市场索引拉取失败：' + errText(err), true);
      return false;
    });
  }

  function findMarketItem(ref) {
    if (ref && typeof ref === 'object') return ref;
    var id = String(ref === null || ref === undefined ? '' : ref);
    for (var i = 0; i < state.market.items.length; i++) {
      if (String(state.market.items[i].id) === id) return state.market.items[i];
    }
    return null;
  }

  function updateMarketStatus(id, status, message) {
    var key = String(id || '');
    if (!key) return;
    var cur = state.market.statusMap[key];
    var next = cur && typeof cur === 'object' ? cur : {};
    next.status = status;
    if (message !== undefined) next.message = String(message || '');
    state.market.statusMap[key] = next;
    renderMarketPage();
  }

  /** 安装结果统一收尾：校验失败 → invalid（提示「签名校验失败」），成功 → 刷新插件/市场 */
  function afterMarketInstall(item, res) {
    var id = String(item && item.id ? item.id : '');
    if (!res || res.ok === false) {
      var msg = res && res.error ? String(res.error) : '安装失败';
      var invalid = /校验|签名|sha|hmac|hash/i.test(msg);
      updateMarketStatus(id, invalid ? 'invalid' : 'error', msg);
      toast((invalid ? '签名校验失败：' : '插件安装失败：') + msg, true);
      return false;
    }
    try { refreshPlugins(); } catch (e1) { /* ignore */ }
    try { loadHousePluginsAndSlots(); } catch (e2) { /* ignore */ }
    refreshPluginSlots();
    state.market.statusMap = computeMarketStatusMap(state.market.items);
    updateMarketStatus(id, 'installed', '');
    state.market.statusMap = computeMarketStatusMap(state.market.items);
    renderMarketPage();
    toast('插件已安装：' + (item.name || id), true);
    return res;
  }

  function computeSha256Hex(text) {
    var source = String(text === null || text === undefined ? '' : text);
    if (global.Bridge && typeof global.Bridge.pluginSha256 === 'function') {
      try {
        var nativeSha = global.Bridge.pluginSha256(source);
        if (nativeSha) return Promise.resolve(String(nativeSha).toLowerCase());
      } catch (e) { /* fall through */ }
    }
    try {
      if (global.crypto && global.crypto.subtle && typeof global.TextEncoder !== 'undefined') {
        var data = new global.TextEncoder().encode(source);
        return global.crypto.subtle.digest('SHA-256', data).then(function (buffer) {
          var bytes = new Uint8Array(buffer);
          var hex = '';
          for (var i = 0; i < bytes.length; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
          return hex;
        }, function () { return ''; });
      }
    } catch (e2) { /* ignore */ }
    return Promise.resolve('');
  }

  /** 无 DSPlugins.installMarketPlugin 时的回退安装：下载 → sha256/hmac 校验 → pluginWrite → 重载 */
  function installMarketPluginFallback(item) {
    var id = sanitizePluginFilePart(item.id);
    var version = sanitizePluginFilePart(item.version || '1.0.0') || '1.0.0';
    if (!id) return Promise.resolve({ ok: false, error: '插件 id 非法' });
    var url = String(item.url || '');
    var isLocal = /^http:\/\/(127\.0\.0\.1|localhost)/i.test(url);
    if (!/^https:\/\//i.test(url) && !isLocal) return Promise.resolve({ ok: false, error: '下载 URL 需为 https' });
    return httpGetText(url, 30000).then(function (res) {
      if (!res || !res.ok) return { ok: false, error: '下载失败：' + ((res && res.error) || ('HTTP ' + ((res && res.status) || 0))) };
      var source = res.body === null || res.body === undefined ? '' : String(res.body);
      if (!source) return { ok: false, error: '插件源码为空' };
      if (source.length > 512 * 1024) return { ok: false, error: '插件源码超过 512KB' };
      var hmacWork = Promise.resolve('');
      if (item.hmac && global.Bridge && typeof global.Bridge.pluginHmac === 'function') {
        hmacWork = Promise.resolve(global.Bridge.pluginHmac(source));
      }
      return hmacWork.then(function (hmac) {
        if (item.hmac && String(item.hmac).toLowerCase() !== String(hmac || '').toLowerCase()) {
          return { ok: false, error: '签名校验失败：hmac 不匹配' };
        }
        return computeSha256Hex(source).then(function (sha) {
          if (item.sha256 && sha && String(item.sha256).toLowerCase() !== String(sha).toLowerCase()) {
            return { ok: false, error: '签名校验失败：sha256 不匹配' };
          }
          var fileName = id + '-' + version + '.js';
          var written = false;
          try {
            if (global.Bridge && typeof global.Bridge.pluginWrite === 'function') {
              written = global.Bridge.pluginWrite(fileName, source) !== false;
            }
          } catch (e) { warn('写入插件目录失败：' + errText(e)); }
          if (!written) return { ok: false, error: '写入插件目录失败' };
          return { ok: true, id: id, version: version, fileName: fileName, source: source };
        });
      });
    }, function (err) {
      return { ok: false, error: errText(err) };
    });
  }

  /** handlers.onMarketInstall(item)：优先 DSPlugins.installMarketPlugin，否则回退实现 */
  function installMarketItem(ref) {
    var item = findMarketItem(ref);
    if (!item) { toast('市场条目不存在', true); return Promise.resolve(false); }
    var id = String(item.id || '');
    if (!id) { toast('插件条目缺少 id', true); return Promise.resolve(false); }
    updateMarketStatus(id, 'installing', '安装中…');
    var P = dsPlugins();
    if (P && typeof P.installMarketPlugin === 'function') {
      return Promise.resolve().then(function () { return P.installMarketPlugin(item); }).then(function (res) {
        return afterMarketInstall(item, res);
      }, function (err) {
        return afterMarketInstall(item, { ok: false, error: errText(err) });
      });
    }
    return installMarketPluginFallback(item).then(function (res) {
      return afterMarketInstall(item, res);
    }, function (err) {
      return afterMarketInstall(item, { ok: false, error: errText(err) });
    });
  }

  /** handlers.onMarketRemove(id)：优先 DSPlugins.removeMarketPlugin，否则按 pluginList 删文件 */
  function removeMarketItem(ref) {
    var id = ref && typeof ref === 'object' ? String(ref.id || '') : String(ref === null || ref === undefined ? '' : ref);
    if (!id) { toast('插件 id 无效', true); return Promise.resolve(false); }
    var P = dsPlugins();
    function finish(res) {
      if (!res || res.ok === false) {
        toast('插件卸载失败：' + ((res && res.error) || '未知错误'), true);
        return false;
      }
      try { refreshPlugins(); } catch (e1) { /* ignore */ }
      try { loadHousePluginsAndSlots(); } catch (e2) { /* ignore */ }
      refreshPluginSlots();
      delete state.market.statusMap[id];
      if (state.market.items.length) state.market.statusMap = computeMarketStatusMap(state.market.items);
      renderMarketPage();
      toast('插件已卸载', true);
      return res;
    }
    if (P && typeof P.removeMarketPlugin === 'function') {
      return Promise.resolve().then(function () { return P.removeMarketPlugin(id); }).then(finish, function (err) {
        return finish({ ok: false, error: errText(err) });
      });
    }
    var installed = installedPluginMap().list;
    var removed = 0;
    for (var i = 0; i < installed.length; i++) {
      var plugin = installed[i];
      var fileName = String(plugin.fileName || '');
      var pid = String(plugin.id || '');
      var base = fileName.replace(/\.js$/i, '');
      var match = pid === id || (fileName && (fileName === id || fileName.indexOf(id + '-') === 0 || base === id));
      if (!match || !fileName) continue;
      try {
        if (global.Bridge && typeof global.Bridge.pluginDeleteFile === 'function' && global.Bridge.pluginDeleteFile(fileName)) removed++;
      } catch (e3) { warn('删除插件失败：' + errText(e3)); }
    }
    return Promise.resolve(finish(removed > 0 ? { ok: true, removed: removed } : { ok: false, error: '未找到已安装插件' }));
  }

  /* ---------------- 记忆页 ---------------- */

  function normalizeMemoryKvToObject(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    var keys = Object.keys(raw);
    for (var i = 0; i < keys.length; i++) {
      var value = raw[keys[i]];
      out[keys[i]] = value === null || value === undefined ? '' : String(value);
    }
    return out;
  }

  function buildMemoryViewModel() {
    var all = { summaries: [], long_term: {}, project: {} };
    try {
      if (global.Bridge && typeof global.Bridge.memoryAll === 'function') {
        var loaded = global.Bridge.memoryAll();
        if (loaded && typeof loaded === 'object') all = loaded;
      }
    } catch (e) { warn('读取记忆失败：' + errText(e)); }
    var longTermMap = normalizeMemoryKvToObject(all.long_term);
    var longTermList = [];
    var ltKeys = Object.keys(longTermMap);
    for (var i = 0; i < ltKeys.length; i++) longTermList.push({ key: ltKeys[i], value: longTermMap[ltKeys[i]] });
    var project = normalizeMemoryKvToObject(all.project);
    project.tech_stack = project.tech_stack || '';
    project.conventions = project.conventions || '';
    project.decisions = project.decisions || '';
    var summaries = [];
    var rawSummaries = Array.isArray(all.summaries) ? all.summaries : [];
    for (var j = 0; j < rawSummaries.length; j++) {
      var item = rawSummaries[j];
      if (!item || typeof item !== 'object') continue;
      var chatId = String(item.chatId || '');
      if (!chatId) continue;
      var chat = Store.getChat(chatId);
      summaries.push({
        chatId: chatId,
        title: chat && chat.title ? String(chat.title) : ('会话 ' + chatId.slice(0, 8)),
        summary: item.summary === null || item.summary === undefined ? '' : String(item.summary),
        updatedAt: Number(item.updatedAt) || 0
      });
    }
    summaries.sort(function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); });
    return { long_term: longTermList, project: project, summaries: summaries };
  }

  /** handlers.onOpenMemory：Bridge.memoryAll() → UI.renderMemory({long_term,project,summaries}) */
  function refreshMemoryPage() {
    var data = buildMemoryViewModel();
    state.memory = {
      loaded: true,
      long_term: normalizeMemoryKvToObject((function () { var map = {}; for (var i = 0; i < data.long_term.length; i++) map[data.long_term[i].key] = data.long_term[i].value; return map; })()),
      project: data.project,
      summaries: data.summaries
    };
    ui('renderMemory', data);
    return data;
  }

  function showMemoryPage() {
    if (state.memoryOpening) return refreshMemoryPage();
    var U = getUI();
    var screen = U && typeof U.getScreen === 'function' ? String(U.getScreen() || '') : '';
    if (screen !== 'memory') {
      state.memoryOpening = true;
      try { ui('openMemoryPage'); } finally { state.memoryOpening = false; }
    }
    return refreshMemoryPage();
  }

  /** 原生记忆写为异步排队：保存后稍等再读回（默认 120ms） */
  function refreshMemorySoon(delay) {
    setTimeout(function () {
      try { refreshMemoryPage(); } catch (e) { warn('刷新记忆页失败：' + errText(e)); }
    }, typeof delay === 'number' && delay >= 0 ? delay : 120);
  }

  function normalizeMemoryScope(scope) {
    var key = String(scope === null || scope === undefined ? '' : scope);
    return MEMORY_SCOPES[key] ? key : '';
  }

  /** handlers.onMemorySave(scope,key,value)：长期偏好 / 项目记忆统一入口 */
  function saveMemoryItem(scope, key, value) {
    var scopeKey = normalizeMemoryScope(scope);
    var name = String(key === null || key === undefined ? '' : key).replace(/^\s+|\s+$/g, '');
    var text = String(value === null || value === undefined ? '' : value);
    if (!scopeKey) { toast('未知记忆范围', true); return false; }
    if (!name) { toast('记忆条目名称不能为空', true); return false; }
    var ok = false;
    try {
      if (global.Bridge && typeof global.Bridge.memoryKvSet === 'function') ok = global.Bridge.memoryKvSet(scopeKey, name, text) !== false;
    } catch (e) { warn('保存记忆失败：' + errText(e)); }
    if (!ok) { toast('保存记忆失败', true); return false; }
    toast(scopeKey === 'long_term' ? '已保存长期偏好' : '已保存项目记忆', true);
    refreshMemorySoon(120);
    return true;
  }

  function deleteMemoryItem(scope, key) {
    var scopeKey = normalizeMemoryScope(scope);
    var name = String(key === null || key === undefined ? '' : key).replace(/^\s+|\s+$/g, '');
    if (!scopeKey || !name) { toast('记忆条目无效', true); return false; }
    var ok = false;
    try {
      if (global.Bridge && typeof global.Bridge.memoryKvDelete === 'function') ok = global.Bridge.memoryKvDelete(scopeKey, name) !== false;
    } catch (e) { warn('删除记忆失败：' + errText(e)); }
    if (!ok) { toast('删除记忆失败', true); return false; }
    toast('已删除', true);
    refreshMemorySoon(120);
    return true;
  }

  function deleteSessionSummary(chatId) {
    var id = String(chatId === null || chatId === undefined ? '' : chatId);
    if (!id) { toast('会话 id 无效', true); return false; }
    var ok = false;
    try {
      if (global.Bridge && typeof global.Bridge.memoryDeleteSummary === 'function') ok = global.Bridge.memoryDeleteSummary(id) !== false;
    } catch (e) { warn('删除会话摘要失败：' + errText(e)); }
    if (!ok) { toast('删除会话摘要失败', true); return false; }
    delete state.contextCompressed[id];
    delete state.contextSummaryOverride[id];
    toast('已删除会话摘要', true);
    refreshMemorySoon(120);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * ARCH v2 P4：F6 图片 / F7 通知 / F8 分享进入 / F9 应用锁与加密（逻辑侧）
   * ------------------------------------------------------------------ */

  function modelSupportsVision(model) {
    return VISION_MODEL_RE.test(String(model === null || model === undefined ? '' : model));
  }

  function normalizeImageDataUrls(images) {
    var out = [];
    if (!Array.isArray(images)) return out;
    for (var i = 0; i < images.length && out.length < MAX_PENDING_IMAGES; i++) {
      var item = images[i];
      var dataUrl = typeof item === 'string' ? item : (item && item.dataUrl ? String(item.dataUrl) : '');
      if (!dataUrl || !/^data:image\//i.test(dataUrl)) continue;
      if (out.indexOf(dataUrl) !== -1) continue;
      out.push(dataUrl);
    }
    return out;
  }

  function imageMetaFrom(images) {
    var out = [];
    if (!Array.isArray(images)) return out;
    for (var i = 0; i < images.length && out.length < MAX_PENDING_IMAGES; i++) {
      var item = images[i];
      if (item && typeof item === 'object') {
        out.push({
          width: Number(item.width) || 0,
          height: Number(item.height) || 0,
          name: item.name === null || item.name === undefined ? '' : String(item.name)
        });
      } else {
        out.push({ width: 0, height: 0, name: '图片 ' + (i + 1) });
      }
    }
    return out;
  }

  function pendingImagePayload() {
    var out = [];
    for (var i = 0; i < state.pendingImages.length; i++) {
      var item = state.pendingImages[i];
      out.push({ dataUrl: item.dataUrl, width: item.width || 0, height: item.height || 0, name: item.name || '' });
    }
    return out;
  }

  function syncPendingImagesUI() {
    var U = getUI();
    var payload = pendingImagePayload();
    if (U && typeof U.setPendingImages === 'function') {
      try { U.setPendingImages(payload); return; } catch (e) { warn('UI.setPendingImages 异常：' + errText(e)); }
    }
    if (U && typeof U.renderPendingImages === 'function') {
      try { U.renderPendingImages(payload); return; } catch (e2) { /* ignore */ }
    }
    ui('renderPendingImages', payload);
  }

  /** 取走待发送图片（发送后清空队列与 chip） */
  function takePendingImages() {
    var list = state.pendingImages.slice();
    state.pendingImages = [];
    syncPendingImagesUI();
    return list;
  }

  function addPendingImage(image) {
    if (!image || typeof image !== 'object') return false;
    var dataUrl = String(image.dataUrl || '');
    if (!/^data:image\//i.test(dataUrl)) { toast('不支持的图片格式', true); return false; }
    if (state.pendingImages.length >= MAX_PENDING_IMAGES) {
      toast('最多添加 ' + MAX_PENDING_IMAGES + ' 张图片', true);
      return false;
    }
    for (var i = 0; i < state.pendingImages.length; i++) {
      if (state.pendingImages[i].dataUrl === dataUrl) { toast('该图片已在待发送队列'); return false; }
    }
    if (dataUrl.length > MAX_IMAGE_DATAURL_CHARS) {
      toast('图片较大（约 ' + Math.round(dataUrl.length / 1024) + 'KB），前端压缩不可用，可能发送失败', true);
    }
    var item = {
      dataUrl: dataUrl,
      width: Number(image.width) || 0,
      height: Number(image.height) || 0,
      name: image.name === null || image.name === undefined ? '' : String(image.name)
    };
    state.pendingImages.push(item);
    var U = getUI();
    if (U && typeof U.addPendingImage === 'function') {
      try { U.addPendingImage({ dataUrl: item.dataUrl, width: item.width, height: item.height, name: item.name }); } catch (e) { warn('UI.addPendingImage 异常：' + errText(e)); syncPendingImagesUI(); }
    } else {
      syncPendingImagesUI();
    }
    return true;
  }

  function removePendingImageAt(index) {
    var idx = parseInt(index, 10);
    if (isNaN(idx) || idx < 0 || idx >= state.pendingImages.length) return false;
    state.pendingImages.splice(idx, 1);
    syncPendingImagesUI();
    return true;
  }

  function clearPendingImagesUI() {
    state.pendingImages = [];
    var U = getUI();
    if (U && typeof U.clearPendingImages === 'function') {
      try { U.clearPendingImages(); return; } catch (e) { /* ignore */ }
    }
    syncPendingImagesUI();
  }

  /** handlers.onPickImage(source)：Bridge.pickImage → image-picked 事件 → 待发送图片队列 */
  function pickImageSource(source) {
    var src = String(source === null || source === undefined ? '' : source).toLowerCase() === 'camera' ? 'camera' : 'gallery';
    var B = global.Bridge;
    if (!B || typeof B.pickImage !== 'function') { toast('当前环境不支持选择图片', true); return false; }
    if (state.pendingImages.length >= MAX_PENDING_IMAGES) { toast('最多添加 ' + MAX_PENDING_IMAGES + ' 张图片', true); return false; }
    toast(src === 'camera' ? '正在打开相机…' : '正在打开相册…');
    var work = null;
    try {
      if (typeof B.pickImageAsync === 'function') work = B.pickImageAsync(src, 120000);
      else work = null;
    } catch (e) { warn('pickImage 失败：' + errText(e)); work = null; }
    if (work && typeof work.then === 'function') {
      work.then(function (res) {
        if (!res || res.ok === false) {
          toast('图片获取失败：' + ((res && res.error) || '未知错误'), true);
          return;
        }
        addPendingImage(res);
        if (getUI() && typeof getUI().focusComposer === 'function') { try { getUI().focusComposer(); } catch (e) { /* ignore */ } }
      });
      return true;
    }
    /* 兼容只发事件、无 Promise 的环境：直接调用原生，事件仍由 pickImageAsync 场景处理 */
    try { return B.pickImage(src) !== false; } catch (e2) { toast('图片获取失败：' + errText(e2), true); return false; }
  }

  /** handlers.onSendWithImages(text, images)：UI 传来的 dataUrl 数组优先 */
  function sendWithImages(text, images) {
    var payload = Array.isArray(images) && images.length ? images : state.pendingImages;
    if (Array.isArray(images) && images.length) {
      state.pendingImages = [];
      syncPendingImagesUI();
    }
    return handleSendInternal(text, payload);
  }

  /* ---------------- F7 前台服务 + 完成通知 ---------------- */

  function startForegroundService() {
    if (state.foregroundActive) return;
    state.foregroundActive = true;
    try {
      if (global.Bridge && typeof global.Bridge.setForeground === 'function') {
        global.Bridge.setForeground(true, '正在生成回复…');
      }
    } catch (e) { warn('setForeground(true) 失败：' + errText(e)); }
  }

  function buildReplySummary(content) {
    var text = String(content === null || content === undefined ? '' : content)
      .replace(/[#*`>|]/g, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (!text) return '回复已完成';
    return text.length > 80 ? (text.slice(0, 80) + '…') : text;
  }

  /** done/error/stop 后收尾：关闭前台服务；若 App 在后台则发完成通知 */
  function endGeneration(chatId, content) {
    if (!state.foregroundActive) return;
    state.foregroundActive = false;
    try {
      if (global.Bridge && typeof global.Bridge.setForeground === 'function') global.Bridge.setForeground(false, '');
    } catch (e) { warn('setForeground(false) 失败：' + errText(e)); }
    if (state.appForeground === false) {
      var summary = buildReplySummary(content);
      try {
        if (global.Bridge && typeof global.Bridge.notify === 'function') global.Bridge.notify('回复完成', summary);
      } catch (e2) { warn('notify 失败：' + errText(e2)); }
    }
  }

  /* ---------------- F8 分享进入 ---------------- */

  function onSharedEvent(evt) {
    if (!evt) return null;
    var text = evt.text === null || evt.text === undefined ? '' : String(evt.text);
    var image = evt.imageDataUrl === null || evt.imageDataUrl === undefined ? '' : String(evt.imageDataUrl);
    if (!text && !image) return null;
    if (state.busy) { try { stopGeneration(); } catch (e) { /* ignore */ } }
    closeDrawer();
    /* 新建会话（当前模型/默认预设） */
    var title = '';
    try { title = defaultAgentTitle(state.prefs.model); } catch (e1) { title = '新的对话'; }
    var chat = Store.createChat({ model: state.prefs.model, title: title });
    if (!chat) return null;
    Store.setActiveChat(chat.id);
    navTo('chat');
    enterChat(chat);
    clearPendingImagesUI();
    if (text) ui('setComposer', { value: text });
    if (image) addPendingImage({ dataUrl: image, width: 0, height: 0, name: '分享图片' });
    refreshChatList();
    toast('已接收分享内容', true);
    return chat;
  }

  /* ---------------- 工作台 / 终端高度 ---------------- */

  function toggleWorkbench(enabled) {
    var current = !!(state.prefs && state.prefs.workbench);
    var next = enabled === undefined || enabled === null ? !current : !!enabled;
    state.prefs.workbench = next;
    try { Store.setPrefs({ workbench: next }); } catch (e) { warn('保存工作台开关失败：' + errText(e)); }
    try { if (global.Bridge && typeof global.Bridge.setPrefs === 'function') global.Bridge.setPrefs({ workbench: next }); } catch (e2) { /* ignore */ }
    var U = getUI();
    if (U && typeof U.setWorkbenchEnabled === 'function') {
      try { U.setWorkbenchEnabled(next); } catch (e3) { warn('UI.setWorkbenchEnabled 异常：' + errText(e3)); }
    } else if (U && typeof U.toggleWorkbench === 'function') {
      try { U.toggleWorkbench(next); } catch (e4) { /* ignore */ }
    }
    if (next) { try { loadWorkspaceDir(''); } catch (e5) { /* ignore */ } }
    toast(next ? '已开启工作台' : '已关闭工作台');
    return next;
  }

  function persistTerminalHeight(height) {
    var h = Math.round(clampNum(height, 120, 800));
    state.prefs.terminalHeight = h;
    try { Store.setPrefs({ terminalHeight: h }); } catch (e) { warn('保存终端高度失败：' + errText(e)); }
    return h;
  }

  /** boot / 解密完成后把工作台与终端高度应用到 UI（UI 自身 localStorage 优先） */
  function applyWorkbenchFromPrefs() {
    var U = getUI();
    if (!U) return;
    var uiState = null;
    if (typeof U.getWorkbenchState === 'function') {
      try { uiState = U.getWorkbenchState(); } catch (e) { uiState = null; }
    }
    var enabled = uiState && typeof uiState.enabled === 'boolean' ? !!uiState.enabled : !!(state.prefs && state.prefs.workbench);
    var height = (uiState && Number(uiState.terminalHeight)) || Number(state.prefs && state.prefs.terminalHeight) || 260;
    if (!uiState) {
      /* UI 无本地记录时用 prefs 兜底 */
      if (typeof U.setWorkbenchEnabled === 'function') { try { U.setWorkbenchEnabled(enabled); } catch (e1) { /* ignore */ } }
      if (typeof U.setTerminalHeight === 'function') { try { U.setTerminalHeight(height); } catch (e2) { /* ignore */ } }
    }
  }

  /* ---------------- F9 应用锁 / 加密状态 ---------------- */

  function readAppLockEnabled() {
    try {
      if (global.Bridge && typeof global.Bridge.isAppLockEnabled === 'function') return !!global.Bridge.isAppLockEnabled();
    } catch (e) { warn('读取应用锁失败：' + errText(e)); }
    return !!(state.prefs && state.prefs.appLock);
  }

  /** Root 模式：开启前先 checkRoot；未授权则提示去 KernelSU/Magisk 授权 */
  function toggleRootMode(enabled) {
    var B = global.Bridge;
    var U = getUI();
    var next = enabled === undefined || enabled === null
      ? !(B && typeof B.isRootMode === 'function' && B.isRootMode()) : !!enabled;
    if (next) {
      var check = null;
      try { if (B && typeof B.checkRoot === 'function') check = B.checkRoot(); } catch (e) { warn('checkRoot 失败：' + errText(e)); }
      if (!check || !check.root) {
        try { if (B && typeof B.setRootMode === 'function') B.setRootMode(false); } catch (e2) { /* ignore */ }
        state.prefs.rootMode = false;
        try { Store.setPrefs({ rootMode: false }); } catch (e3) { /* ignore */ }
        if (U && typeof U.setSecurityInfo === 'function') {
          U.setSecurityInfo({ rootMode: false, rootMessage: (check && check.message) ? String(check.message) : '未获得 root 授权' });
        }
        toast('未获得 root 授权：请在 KernelSU / Magisk 管理器中允许「DeepSeek House」后重试');
        return false;
      }
    }
    var ok = false;
    try { if (B && typeof B.setRootMode === 'function') ok = B.setRootMode(next) !== false; } catch (e4) { warn('setRootMode 失败：' + errText(e4)); }
    state.prefs.rootMode = next;
    try { Store.setPrefs({ rootMode: next }); } catch (e5) { /* ignore */ }
    refreshSecurityInfo();
    toast(ok ? (next ? 'Root 模式已开启：终端与 run_shell 将以 su 执行' : 'Root 模式已关闭') : 'Root 模式设置失败', !ok);
    return ok;
  }

  function toggleAppLock(enabled) {
    var next = enabled === undefined || enabled === null ? !readAppLockEnabled() : !!enabled;
    var ok = false;
    try {
      if (global.Bridge && typeof global.Bridge.setAppLock === 'function') ok = global.Bridge.setAppLock(next) !== false;
    } catch (e) { warn('设置应用锁失败：' + errText(e)); }
    state.prefs.appLock = next;
    try { Store.setPrefs({ appLock: next }); } catch (e2) { /* ignore */ }
    refreshSecurityInfo();
    toast(ok ? (next ? '应用锁已开启（下次启动需验证）' : '应用锁已关闭') : '应用锁设置失败', !ok);
    return ok;
  }

  /** handlers.onRefreshSecurity：读应用锁 + 本地加密状态 → UI.setSecurityInfo({appLock,encrypted}) */
  function refreshSecurityInfo() {
    var enc = { ready: true, encrypted: false, plaintext: false, secretAvailable: false, error: '' };
    try {
      if (global.Store && typeof global.Store.getEncryptionState === 'function') enc = global.Store.getEncryptionState() || enc;
    } catch (e) { warn('读取加密状态失败：' + errText(e)); }
    var appLock = readAppLockEnabled();
    state.prefs.appLock = appLock;
    var rootMode = false;
    var rootMessage = '未启用';
    try {
      if (global.Bridge) {
        rootMode = typeof global.Bridge.isRootMode === 'function' ? !!global.Bridge.isRootMode() : false;
        if (rootMode) {
          var rc = typeof global.Bridge.checkRoot === 'function' ? global.Bridge.checkRoot() : null;
          rootMode = !!(rc && rc.root);
          rootMessage = rc && rc.message ? String(rc.message) : (rootMode ? '已获得 root（uid=0）' : '未获得 root 授权');
          if (!rootMode && typeof global.Bridge.setRootMode === 'function') global.Bridge.setRootMode(false);
        }
      }
    } catch (eRoot) { warn('读取 Root 状态失败：' + errText(eRoot)); }
    state.prefs.rootMode = rootMode;
    var info = {
      appLock: appLock,
      encrypted: !!(enc.encrypted || enc.secretAvailable),
      message: enc.error ? String(enc.error) : '',
      rootMode: rootMode,
      rootMessage: rootMessage
    };
    var U = getUI();
    if (U && typeof U.setSecurityInfo === 'function') {
      try { U.setSecurityInfo(info); } catch (e2) { warn('UI.setSecurityInfo 异常：' + errText(e2)); }
    }
    return { appLock: info.appLock, encrypted: info.encrypted, state: enc };
  }

  /* ---------------- P4 构建任务跟踪 ---------------- */

  function trimBuildTasks() {
    if (state.buildTasks.length <= MAX_BUILD_TASKS) return;
    var kept = [];
    for (var i = 0; i < state.buildTasks.length && kept.length < MAX_BUILD_TASKS; i++) {
      var task = state.buildTasks[i];
      if (kept.length < MAX_BUILD_TASKS) kept.push(task);
    }
    state.buildTasks = kept;
  }

  function beginBuildTask(toolName, requestId, msgId, args) {
    var parsed = parseMcpToolName(toolName);
    var serverId = parsed.serverId || state.mcpToolMap[parsed.base] || '';
    state.buildTaskSeq++;
    var id = 'build_' + state.buildTaskSeq + '_' + String(requestId || '').slice(-6);
    var now = Date.now();
    var task = {
      id: id,
      toolName: String(toolName || ''),
      serverId: String(serverId || ''),
      percent: 0,
      status: 'running',
      line: '开始执行…',
      lines: ['开始执行…'],
      updatedAt: now
    };
    state.buildTasks.unshift(task);
    if (msgId) state.buildTaskByMsg[String(msgId)] = id;
    trimBuildTasks();
    renderBuildTasks();
    return task;
  }

  function findBuildTaskById(id) {
    var key = String(id || '');
    for (var i = 0; i < state.buildTasks.length; i++) {
      if (String(state.buildTasks[i].id) === key) return state.buildTasks[i];
    }
    return null;
  }

  function findBuildTaskForMsg(msgId) {
    var id = state.buildTaskByMsg[String(msgId || '')];
    if (!id) return null;
    return findBuildTaskById(id);
  }

  function findBuildTaskForTool(toolName, serverId) {
    var base = mcpBaseName(toolName);
    for (var i = 0; i < state.buildTasks.length; i++) {
      var task = state.buildTasks[i];
      if (task.status !== 'running') continue;
      if (mcpBaseName(task.toolName) !== base) continue;
      if (serverId && task.serverId && String(task.serverId) !== String(serverId)) continue;
      return task;
    }
    return null;
  }

  function updateBuildTaskProgress(task, percent, line) {
    if (!task) return null;
    var pct = Number(percent);
    if (isFinite(pct)) task.percent = Math.max(0, Math.min(100, Math.round(pct)));
    if (line !== undefined && line !== null && String(line) !== '') {
      var text = String(line);
      task.line = text;
      if (!Array.isArray(task.lines)) task.lines = [];
      task.lines.push(text);
      if (task.lines.length > 200) task.lines = task.lines.slice(task.lines.length - 200);
    }
    task.updatedAt = Date.now();
    var U = getUI();
    if (U && typeof U.updateBuildTask === 'function') {
      try {
        U.updateBuildTask(task.id, { percent: task.percent, line: task.line, lines: task.lines, status: 'running', updatedAt: task.updatedAt });
      } catch (e) { warn('UI.updateBuildTask 异常：' + errText(e)); }
    }
    return task;
  }

  function finalizeBuildTask(task, ok, stateText, line) {
    if (!task) return null;
    task.status = ok ? 'success' : 'error';
    if (ok) task.percent = 100;
    if (line !== undefined && line !== null && String(line) !== '') task.line = String(line);
    else if (!task.line) task.line = ok ? '完成' : '失败';
    task.updatedAt = Date.now();
    var U = getUI();
    if (U && typeof U.updateBuildTask === 'function') {
      try {
        U.updateBuildTask(task.id, {
          percent: task.percent,
          line: task.line,
          lines: task.lines,
          status: task.status,
          updatedAt: task.updatedAt
        });
      } catch (e) { warn('UI.updateBuildTask 异常：' + errText(e)); }
    }
    renderBuildTasks();
    return task;
  }

  function renderBuildTasks() {
    ui('renderBuildTasks', state.buildTasks);
  }

  function openBuildPanel() {
    renderBuildTasks();
    var U = getUI();
    if (U && typeof U.openBuildPanel === 'function') {
      try { U.openBuildPanel(); } catch (e) { warn('UI.openBuildPanel 异常：' + errText(e)); }
    }
    return state.buildTasks;
  }

  function clearBuildTasks() {
    state.buildTasks = [];
    state.buildTaskByMsg = {};
    renderBuildTasks();
    return true;
  }

  /* ---------------- 启动后刷新 / MCP 统计 ---------------- */

  /** 本地加密数据异步解密完成 / 存储错误后刷新界面数据 */
  function refreshAfterStoreLoad() {
    try {
      state.prefs = mergePrefs(Store.getPrefs(), readNativePrefs());
      state.prefs.appLock = readAppLockEnabled();
    } catch (e) { warn('刷新 prefs 失败：' + errText(e)); }
    try { loadCustomModels(); } catch (e1) { /* ignore */ }
    try { loadPresets(); } catch (e2) { /* ignore */ }
    try { state.modelCatalog = buildModelCatalog(state.remoteModels, state.customModels); } catch (e3) { /* ignore */ }
    try { applyWorkbenchFromPrefs(); } catch (e4) { /* ignore */ }
    try { applyModelLabel(); } catch (e5) { /* ignore */ }
    try { refreshChatList(); } catch (e6) { /* ignore */ }
    var chat = Store.getActiveChat();
    if (chat && state.nav && state.nav.screen === 'chat') {
      try {
        ui('renderMessages', chat);
        ui('setChatAvatar', chat);
        setHeader(chat, '');
        ui('scrollBottom', true);
      } catch (e7) { /* ignore */ }
    }
    if (state.nav && state.nav.screen === 'settings') {
      try { ui('renderSettings', state.prefs, state.modelCatalog, getPresets()); } catch (e8) { /* ignore */ }
    }
  }

  /** 打开设置页时刷新 MCP 服务器统计到 UI（不进入 MCP 管理页） */
  function refreshMcpStatsUI() {
    try { loadMcpServers(true); } catch (e) { warn('刷新 MCP 列表失败：' + errText(e)); }
    try { ui('renderMcpServers', state.mcpServers, buildMcpStatusMap()); } catch (e2) { /* ignore */ }
    return state.mcpServers;
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

  /* v2.0 F1–F5 对外接口（UI 回调 / QA 可直接调用） */
  App.getPresets = function () { return getPresets(); };
  App.getPreset = function (id) { return findPreset(id); };
  App.loadPresets = safe(function () { return loadPresets(); }, 'App.loadPresets');
  App.openAgents = safe(function () { return openAgents(); }, 'App.openAgents');
  App.saveAgent = safe(function (agent) { return saveAgent(agent); }, 'App.saveAgent');
  App.deleteAgent = safe(function (id) { return deleteAgent(id); }, 'App.deleteAgent');
  App.resetAgents = safe(function () { return resetAgents(); }, 'App.resetAgents');
  App.pickAgent = safe(function (id) { return onPickAgent(id); }, 'App.pickAgent');
  App.createChatForAgent = safe(function (preset) { return createChatForAgent(preset || null); }, 'App.createChatForAgent');
  App.resolveSystemPrompt = function (chat) { return resolveSystemPrompt(chat); };
  App.archiveChat = safe(function (id, archived) { return archiveChat(id, archived); }, 'App.archiveChat');
  App.forkMessage = safe(function (msgId) { return forkMessage(msgId); }, 'App.forkMessage');
  App.exportBackup = safe(function () { return exportBackup(); }, 'App.exportBackup');
  App.importBackup = safe(function () { return importBackup(); }, 'App.importBackup');
  App.buildBackupObject = function () { return buildBackupObject(); };
  App.applyBackup = safe(function (data) { return applyBackup(data); }, 'App.applyBackup');
  App.onFileImported = safe(function (evt) { return onFileImported(evt); }, 'App.onFileImported');
  App.extractSearchCitations = function (text) { return extractSearchCitations(text); };
  App.captureCitations = safe(function (name, text) { return captureCitations(name, text); }, 'App.captureCitations');

  /* ARCH v2 P1 对外接口（UI 回调 / QA 可直接调用） */
  App.getToolSchemas = function () { return getToolSchemas(); };
  App.isNativeTool = function (name) { return isNativeTool(name); };
  App.getNativeTools = function () { return state.nativeTools; };
  App.getWorkspaceInfo = function () { return state.workspace; };
  App.refreshWorkspaceInfo = safe(function () { return refreshWorkspaceInfo(); }, 'App.refreshWorkspaceInfo');
  App.listDir = safe(function (path) { return loadWorkspaceDir(path); }, 'App.listDir');
  App.openFile = safe(function (path, isDir) { return onOpenFile(path, isDir); }, 'App.openFile');
  App.runShell = safe(function (command) { return runShellCommand(command); }, 'App.runShell');
  App.openAudit = safe(function () { return openAudit(); }, 'App.openAudit');
  App.setWorkspace = safe(function (path) { return setWorkspace(path); }, 'App.setWorkspace');
  App.resetWorkspace = safe(function () { return resetWorkspace(); }, 'App.resetWorkspace');
  /* ARCH v2 P2：MCP 对外接口（UI 回调 / QA 可直接调用） */
  App.openMcpPage = safe(function () { return openMcpPage(); }, 'App.openMcpPage');
  App.showMcpPage = safe(function () { return showMcpPage(); }, 'App.showMcpPage');
  App.getMcpServers = function () { return state.mcpServers.slice(); };
  App.getMcpStatus = function () { return buildMcpStatusMap(); };
  App.getMcpToolMap = function () { return state.mcpToolMap; };
  App.getMcpTools = function (id) {
    var key = String(id === null || id === undefined ? '' : id);
    var tools = state.mcpTools[key];
    if (Array.isArray(tools)) return tools.slice();
    var st = state.mcpStatus[key];
    return st && Array.isArray(st.tools) ? st.tools.slice() : [];
  };
  App.getMcpToolCounts = function () {
    var out = {};
    var ids = Object.keys(state.mcpTools);
    for (var i = 0; i < ids.length; i++) out[ids[i]] = (state.mcpTools[ids[i]] || []).length;
    return out;
  };
  App.saveMcpServer = safe(function (server) { return saveMcpServer(server); }, 'App.saveMcpServer');
  App.deleteMcpServer = safe(function (id) { return deleteMcpServer(id); }, 'App.deleteMcpServer');
  App.connectMcp = safe(function (id) { return connectMcpServer(id); }, 'App.connectMcp');
  App.disconnectMcp = safe(function (id) { return disconnectMcpServer(id); }, 'App.disconnectMcp');
  App.refreshMcpTools = safe(function (id) { return refreshMcpServerTools(id); }, 'App.refreshMcpTools');
  App.testMcp = safe(function (id) { return testMcpServer(id); }, 'App.testMcp');
  App.isBuildToolName = function (name) { return isBuildToolName(name); };
  App.isMcpProgressTool = function (name) { return isMcpProgressTool(name); };

  /* ARCH v2 P3：插件面板 / 市场 / 记忆 / 上下文压缩 对外接口 */
  App.loadHousePlugins = safe(function (opts) {
    var P = dsPlugins();
    if (!P || typeof P.loadHousePlugins !== 'function') return Promise.resolve([]);
    return Promise.resolve(P.loadHousePlugins(opts));
  }, 'App.loadHousePlugins');
  App.refreshPluginSlots = safe(function () { return refreshPluginSlots(); }, 'App.refreshPluginSlots');
  App.getPluginSlots = function () { return state.pluginSlots.slice(); };
  App.showPluginPanel = safe(function () { return showPluginPanel(); }, 'App.showPluginPanel');
  App.runSlotAction = safe(function (slotId, action, payload) { return runPluginSlotAction(slotId, action, payload); }, 'App.runSlotAction');
  App.openMarketPage = safe(function () { return loadMarketData(); }, 'App.openMarketPage');
  App.showMarketPage = safe(function () { return showMarketPage(); }, 'App.showMarketPage');
  App.fetchMarketIndex = safe(function (url) { return fetchMarketIndex(url); }, 'App.fetchMarketIndex');
  App.installMarketItem = safe(function (item) { return installMarketItem(item); }, 'App.installMarketItem');
  App.removeMarketItem = safe(function (id) { return removeMarketItem(id); }, 'App.removeMarketItem');
  App.getMarketState = function () {
    return {
      url: state.market.url || '',
      items: state.market.items.slice(),
      statusMap: JSON.parse(JSON.stringify(state.market.statusMap || {})),
      fetchedAt: state.market.fetchedAt || 0,
      loading: !!state.market.loading,
      error: state.market.error || ''
    };
  };
  App.openMemoryPage = safe(function () { return refreshMemoryPage(); }, 'App.openMemoryPage');
  App.showMemoryPage = safe(function () { return showMemoryPage(); }, 'App.showMemoryPage');
  App.refreshMemoryPage = safe(function () { return refreshMemoryPage(); }, 'App.refreshMemoryPage');
  App.getMemoryData = function () { return buildMemoryViewModel(); };
  App.saveMemoryItem = safe(function (scope, key, value) { return saveMemoryItem(scope, key, value); }, 'App.saveMemoryItem');
  App.deleteMemoryItem = safe(function (scope, key) { return deleteMemoryItem(scope, key); }, 'App.deleteMemoryItem');
  App.deleteSessionSummary = safe(function (chatId) { return deleteSessionSummary(chatId); }, 'App.deleteSessionSummary');
  App.buildMemoryPrompt = function (chat) { return buildMemoryPrompt(chat || Store.getActiveChat()); };
  App.contextBudgetChars = function () { return contextBudgetChars(); };
  App.estimateContextChars = function (messages) { return estimateContextChars(messages); };
  App.buildSessionSummaryPiece = function (older) { return buildSessionSummaryPiece(older); };
  App.getContextCompressed = function () { return JSON.parse(JSON.stringify(state.contextCompressed || {})); };

  /* ARCH v2 P4 对外接口 */
  App.toggleWorkbench = safe(function (enabled) { return toggleWorkbench(enabled); }, 'App.toggleWorkbench');
  App.getWorkbenchState = function () {
    var U = getUI();
    if (U && typeof U.getWorkbenchState === 'function') {
      try { return U.getWorkbenchState(); } catch (e) { /* ignore */ }
    }
    return { enabled: !!(state.prefs && state.prefs.workbench), terminalHeight: Number(state.prefs && state.prefs.terminalHeight) || 260, active: false };
  };
  App.setTerminalHeight = safe(function (height) { return persistTerminalHeight(height); }, 'App.setTerminalHeight');
  App.pickImage = safe(function (source) { return pickImageSource(source); }, 'App.pickImage');
  App.addPendingImage = safe(function (image) { return addPendingImage(image); }, 'App.addPendingImage');
  App.removePendingImage = safe(function (index) { return removePendingImageAt(index); }, 'App.removePendingImage');
  App.clearPendingImages = function () { clearPendingImagesUI(); return true; };
  App.getPendingImages = function () { return pendingImagePayload(); };
  App.sendWithImages = safe(function (text, images) { return sendWithImages(text, images); }, 'App.sendWithImages');
  App.getAppLock = function () { return readAppLockEnabled(); };
  App.toggleAppLock = safe(function (enabled) { return toggleAppLock(enabled); }, 'App.toggleAppLock');
  App.refreshSecurityInfo = safe(function () { return refreshSecurityInfo(); }, 'App.refreshSecurityInfo');
  App.getEncryptionState = function () {
    try { if (global.Store && typeof global.Store.getEncryptionState === 'function') return global.Store.getEncryptionState(); } catch (e) { /* ignore */ }
    return { ready: true, encrypted: false, plaintext: false, secretAvailable: false, error: '' };
  };
  App.getForegroundState = function () { return { active: !!state.foregroundActive, appForeground: state.appForeground !== false }; };
  App.getBuildTasks = function () { return state.buildTasks.slice(); };
  App.openBuildPanel = safe(function () { return openBuildPanel(); }, 'App.openBuildPanel');
  App.clearBuildTasks = safe(function () { return clearBuildTasks(); }, 'App.clearBuildTasks');
  App.onSharedEvent = safe(function (evt) { return onSharedEvent(evt); }, 'App.onSharedEvent');
  App.refreshMcpStats = safe(function () { return refreshMcpStatsUI(); }, 'App.refreshMcpStats');
  App.refreshAfterStoreLoad = safe(function () { refreshAfterStoreLoad(); return true; }, 'App.refreshAfterStoreLoad');
  App.getFilePreview = function () { return state.filePreview; };
  App.confirmTool = safe(function (allow) {
    if (typeof state.pendingConfirm === 'function') { state.pendingConfirm(!!allow); return true; }
    return false;
  }, 'App.confirmTool');

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
