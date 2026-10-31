/*!
 * DeepSeek House — store.js
 * localStorage 数据层（key: dsh.v1）。
 *
 * state = {
 *   version: 1,
 *   prefs: {baseUrl, model, temperature, maxTokens, stream, theme, systemPrompt}, // apiKey 不落 localStorage
 *   chats: [{id,title,createdAt,updatedAt,pinned,archived,model,messages:[],
 *            presetId?, systemPrompt?}],   // v2.0 F1/F4：会话绑定的智能体预设 / 会话级 system prompt
 *   activeChatId,
 *   plugins: {enabled:{<id>:true}, settings:{<id>:{...}}},
 *   customModels: ["<自定义模型 id>"],   // B1：用户自定义模型 ID（任意字符串）
 *   presets: [{id,name,description,systemPrompt,model?,builtin?}],   // v2.0 F1：智能体预设
 *   ui: {drawerOpen:false}
 * }
 * msg = {id, role:"user"|"assistant"|"tool"|"note", content, reasoning?, toolCalls?, toolName?,
 *        toolCallId?, error?, usage?, streaming?, citations?, createdAt}
 * citations = [{title,url,snippet}]   // v2.0 F5：web_search 结果引用（最多 5 条，仅 https）
 *
 * 挂载：window.Store
 */
(function (global) {
  'use strict';

  var KEY = 'dsh.v1';
  var VERSION = 1;

  var DEFAULT_SYSTEM_PROMPT = '你是 DeepSeek House 助手，一个运行在安卓 WebView 中的 AI 聊天助手。请用简体中文回答（除非用户要求其他语言），回答准确、简洁、有条理，适当使用 Markdown 排版。';

  /**
   * v2.0 F1：内置智能体预设（4 个）。
   * 首次启动/旧数据升级时写入 state.presets；用户可编辑；内置项不可删除（可 resetPresets 恢复）。
   */
  var DEFAULT_PRESETS = [
    {
      id: 'general',
      name: '通用助手',
      description: '日常问答、信息整理与灵感发散',
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      builtin: true
    },
    {
      id: 'coder',
      name: '程序员',
      description: '代码编写、调试与架构建议',
      systemPrompt: '你是一名资深软件工程师，擅长需求分析、代码实现与调试。回答时优先给出可运行的代码示例，说明关键实现思路与潜在坑点；涉及多种方案时先给推荐方案，再简要对比利弊。默认使用简体中文。',
      builtin: true
    },
    {
      id: 'translator',
      name: '翻译',
      description: '中英互译，保留语气与格式',
      systemPrompt: '你是一名专业中英翻译。用户给出中文时翻译成英文，给出英文时翻译成简体中文；保留原文的语气、专业术语与 Markdown 格式，只输出译文，不做额外解释（用户明确要求解释时除外）。',
      builtin: true
    },
    {
      id: 'writer',
      name: '写作',
      description: '文案、文章与创意写作',
      systemPrompt: '你是一名中文写作助手，擅长文案、文章、脚本与创意构思。先理解读者与场景，再给出结构清晰、语言自然的文字；可按用户要求调整语气、篇幅与体裁。',
      builtin: true
    }
  ];

  var MAX_PRESETS = 100;
  var MAX_CITATIONS = 5;

  var DEFAULT_PREFS = {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    temperature: 1.0,
    maxTokens: 4096,
    stream: true,
    theme: 'dark',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    contextBudget: 24000, /* ARCH v2 P3：上下文预算（字符），压缩阈值 80% */
    /* ARCH v2 P4：工作台 / 终端高度 / 应用锁 */
    workbench: false,
    terminalHeight: 260,
    appLock: false,
    /* 批次1 v2.6.0：成本预算 / 自定义价格 / 工具权限策略 */
    costBudget: { daily: 0, monthly: 0 },
    costPrice: {},
    toolPolicies: {},
    /* 批次2 v2.7.0：安全 PIN（PBKDF2-SHA256 派生，仅存 salt/hash） */
    appPin: { enabled: false, salt: '', hash: '', iterations: 100000, failures: 0, lockUntil: 0 },
    /* 批次3 v2.8.0：主题 / 字号 / 壁纸 / 液态玻璃 / 语言 */
    fontScale: 1,
    wallpaper: '',
    glassIntensity: 60,
    glassSpeed: 1,
    locale: 'zh'
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
      systemPrompt: DEFAULT_PREFS.systemPrompt,
      contextBudget: DEFAULT_PREFS.contextBudget,
      workbench: DEFAULT_PREFS.workbench,
      terminalHeight: DEFAULT_PREFS.terminalHeight,
      appLock: DEFAULT_PREFS.appLock,
      costBudget: { daily: DEFAULT_PREFS.costBudget.daily, monthly: DEFAULT_PREFS.costBudget.monthly },
      costPrice: {},
      toolPolicies: {},
      appPin: normalizeAppPin(DEFAULT_PREFS.appPin),
      fontScale: DEFAULT_PREFS.fontScale,
      wallpaper: DEFAULT_PREFS.wallpaper,
      glassIntensity: DEFAULT_PREFS.glassIntensity,
      glassSpeed: DEFAULT_PREFS.glassSpeed,
      locale: DEFAULT_PREFS.locale
    };
  }

  function freshState() {
    return {
      version: VERSION,
      prefs: defaultPrefs(),
      chats: [],
      activeChatId: null,
      customModels: [],
      presets: defaultPresets(),
      plugins: { enabled: {}, settings: {} },
      ui: { drawerOpen: false },
      usage: normalizeUsage(null)
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

  /* ------------------------------------------------------------------ *
   * 智能体预设（追加需求 v2.0 F1）
   * ------------------------------------------------------------------ */

  function defaultPresets() {
    return clone(DEFAULT_PRESETS);
  }

  /** 单条预设归一化：name 必填，systemPrompt/description/model 可选；builtin 只能由默认目录或显式传入决定 */
  function normalizePreset(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var name = String(raw.name === null || raw.name === undefined ? '' : raw.name)
      .replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (!name) return null;
    var preset = {
      id: raw.id ? String(raw.id).slice(0, 80) : ('preset-' + uid()),
      name: name.slice(0, 40),
      description: raw.description === null || raw.description === undefined ? '' : String(raw.description).slice(0, 160),
      systemPrompt: raw.systemPrompt === null || raw.systemPrompt === undefined ? '' : String(raw.systemPrompt).slice(0, 16000),
      builtin: !!raw.builtin
    };
    if (raw.model !== null && raw.model !== undefined) {
      var model = String(raw.model).replace(/^\s+|\s+$/g, '');
      if (model) preset.model = model.slice(0, 80);
    }
    return preset;
  }

  function normalizePresets(raw) {
    var out = [];
    var seen = {};
    if (!Array.isArray(raw)) return out;
    for (var i = 0; i < raw.length && out.length < MAX_PRESETS; i++) {
      var preset = normalizePreset(raw[i]);
      if (!preset || seen[preset.id]) continue;
      seen[preset.id] = true;
      out.push(preset);
    }
    return out;
  }

  /** 批次2：PIN 归一化（PBKDF2 参数/失败次数/锁定时间） */
  function normalizeAppPin(raw) {
    var out = { enabled: false, salt: '', hash: '', iterations: 100000, failures: 0, lockUntil: 0 };
    if (!raw || typeof raw !== 'object') return out;
    out.enabled = !!raw.enabled;
    out.salt = raw.salt ? String(raw.salt).slice(0, 300) : '';
    out.hash = raw.hash ? String(raw.hash).slice(0, 300) : '';
    var iterations = Number(raw.iterations);
    out.iterations = iterations >= 1000 && iterations <= 1000000 ? Math.round(iterations) : 100000;
    out.failures = Math.max(0, parseInt(raw.failures, 10) || 0);
    out.lockUntil = Math.max(0, Number(raw.lockUntil) || 0);
    if (!out.salt || !out.hash) out.enabled = false;
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
    if (raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'midnight' || raw.theme === 'black') p.theme = raw.theme;
    if (raw.fontScale !== undefined) {
      var fs = Number(raw.fontScale);
      p.fontScale = (fs === 0.9 || fs === 1 || fs === 1.1 || fs === 1.2) ? fs : 1;
    }
    if (raw.wallpaper !== undefined) p.wallpaper = String(raw.wallpaper === null ? '' : raw.wallpaper).slice(0, 4000000);
    if (raw.glassIntensity !== undefined) p.glassIntensity = Math.round(clampNum(raw.glassIntensity, 0, 100));
    if (raw.glassSpeed !== undefined) p.glassSpeed = Math.round(clampNum(raw.glassSpeed, 0.2, 3) * 10) / 10;
    if (raw.locale === 'zh' || raw.locale === 'en') p.locale = raw.locale;
    if (raw.systemPrompt !== undefined) p.systemPrompt = String(raw.systemPrompt).slice(0, 16000);
    if (raw.contextBudget !== undefined) p.contextBudget = Math.round(clampNum(raw.contextBudget, 500, 200000));
    if (raw.workbench !== undefined) p.workbench = !!raw.workbench;
    if (raw.terminalHeight !== undefined) p.terminalHeight = Math.round(clampNum(raw.terminalHeight, 120, 800));
    if (raw.appLock !== undefined) p.appLock = !!raw.appLock;
    /* 批次1：预算 / 价格 / 工具策略（结构化，做安全归一化） */
    if (raw.costBudget && typeof raw.costBudget === 'object') {
      var budget = raw.costBudget;
      p.costBudget = {
        daily: Math.max(0, Number(budget.daily) || 0),
        monthly: Math.max(0, Number(budget.monthly) || 0)
      };
    }
    if (raw.costPrice && typeof raw.costPrice === 'object') {
      var prices = {};
      var priceKeys = Object.keys(raw.costPrice);
      for (var pi = 0; pi < priceKeys.length && pi < 50; pi++) {
        var priceKey = String(priceKeys[pi]).slice(0, 80);
        var priceVal = raw.costPrice[priceKeys[pi]];
        if (!priceVal || typeof priceVal !== 'object') continue;
        prices[priceKey] = {
          input: Math.max(0, Number(priceVal.input) || 0),
          output: Math.max(0, Number(priceVal.output) || 0)
        };
      }
      p.costPrice = prices;
    }
    if (raw.appPin !== undefined) p.appPin = normalizeAppPin(raw.appPin);
    if (raw.toolPolicies && typeof raw.toolPolicies === 'object') {
      var policies = {};
      var policyKeys = Object.keys(raw.toolPolicies);
      for (var po = 0; po < policyKeys.length && po < 200; po++) {
        var toolKey = String(policyKeys[po]).slice(0, 120);
        var mode = String(raw.toolPolicies[policyKeys[po]] || '');
        if (mode === 'auto' || mode === 'once' || mode === 'always' || mode === 'deny') policies[toolKey] = mode;
      }
      p.toolPolicies = policies;
    }
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
    /* ARCH v2 P1：工具调用卡片字段（args/result/ok/confirmState/confirmed） */
    if (raw.args !== undefined && raw.args !== null) {
      msg.args = typeof raw.args === 'object' ? clone(raw.args) : String(raw.args);
    }
    if (raw.result !== undefined && raw.result !== null) msg.result = String(raw.result);
    if (raw.ok !== undefined) msg.ok = !!raw.ok;
    if (raw.confirmState) msg.confirmState = String(raw.confirmState);
    if (raw.confirmed !== undefined) msg.confirmed = !!raw.confirmed;
    if (raw.toolRisk) msg.toolRisk = String(raw.toolRisk);
    /* ARCH v2 P2：构建/MCP 工具卡进度与日志（mcp-progress → UI.setToolProgress / appendToolLog） */
    if (raw.progress !== undefined && raw.progress !== null) {
      msg.progress = typeof raw.progress === 'object' ? clone(raw.progress) : (Number(raw.progress) || 0);
    }
    /* 批次3 v2.8.0：引用回复 / 编辑标记 */
    if (raw.quoted && typeof raw.quoted === 'object') {
      var quotedRole = String(raw.quoted.role || '');
      if (quotedRole !== 'user' && quotedRole !== 'assistant' && quotedRole !== 'tool') quotedRole = 'user';
      msg.quoted = {
        msgId: raw.quoted.msgId === undefined || raw.quoted.msgId === null ? '' : String(raw.quoted.msgId).slice(0, 120),
        role: quotedRole,
        text: String(raw.quoted.text === undefined || raw.quoted.text === null ? '' : raw.quoted.text).slice(0, 500)
      };
    }
    if (raw.editedAt !== undefined && raw.editedAt !== null) msg.editedAt = Number(raw.editedAt) || 0;
    /* 批次2 v2.7.0：工具失败诊断 + 快照标记 */
    if (raw.diagnostics && typeof raw.diagnostics === 'object') {
      var diag = {};
      if (raw.diagnostics.exitCode !== undefined && raw.diagnostics.exitCode !== null) diag.exitCode = raw.diagnostics.exitCode;
      if (raw.diagnostics.stderrTail !== undefined && raw.diagnostics.stderrTail !== null) diag.stderrTail = String(raw.diagnostics.stderrTail).slice(0, 1200);
      if (raw.diagnostics.stderr !== undefined && raw.diagnostics.stderr !== null && diag.stderrTail === undefined) diag.stderrTail = String(raw.diagnostics.stderr).slice(0, 1200);
      if (raw.diagnostics.path !== undefined && raw.diagnostics.path !== null) diag.path = String(raw.diagnostics.path).slice(0, 500);
      if (raw.diagnostics.hint !== undefined && raw.diagnostics.hint !== null) diag.hint = String(raw.diagnostics.hint).slice(0, 500);
      if (Array.isArray(raw.diagnostics.hints)) diag.hints = raw.diagnostics.hints.slice(0, 6).map(function (h) { return String(h).slice(0, 300); });
      if (Object.keys(diag).length) msg.diagnostics = diag;
    }
    if (raw.snapshotId) msg.snapshotId = String(raw.snapshotId).slice(0, 120);
    if (raw.snapshotCount !== undefined && raw.snapshotCount !== null) msg.snapshotCount = Math.max(0, parseInt(raw.snapshotCount, 10) || 0);
    if (raw.percent !== undefined && raw.percent !== null) {
      var pct = Number(raw.percent);
      if (isFinite(pct)) msg.percent = Math.max(0, Math.min(100, Math.round(pct)));
    }
    if (raw.log !== undefined && raw.log !== null) msg.log = String(raw.log).slice(0, 40000);
    if (Array.isArray(raw.toolLog)) {
      msg.toolLog = raw.toolLog.slice(-200).map(function (line) { return String(line === null || line === undefined ? '' : line).slice(0, 500); });
    } else if (Array.isArray(raw.logs)) {
      msg.toolLog = raw.logs.slice(-200).map(function (line) { return String(line === null || line === undefined ? '' : line).slice(0, 500); });
    }
    /* ARCH v2 P4：F6 图片消息（dataUrl 数组，最多 4 张） */
    if (Array.isArray(raw.images) && raw.images.length) {
      var images = [];
      for (var im = 0; im < raw.images.length && images.length < 4; im++) {
        var dataUrl = raw.images[im];
        if (typeof dataUrl === 'string' && /^data:image\//i.test(dataUrl)) images.push(dataUrl);
      }
      if (images.length) msg.images = images;
    }
    if (Array.isArray(raw.imageMeta) && raw.imageMeta.length) {
      msg.imageMeta = raw.imageMeta.slice(0, 4).map(function (item) {
        if (!item || typeof item !== 'object') return { width: 0, height: 0, name: '' };
        return {
          width: Number(item.width) || 0,
          height: Number(item.height) || 0,
          name: item.name === null || item.name === undefined ? '' : String(item.name)
        };
      });
    }
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
    // v2.0 F5：引用来源（最多 5 条，仅 https）
    if (Array.isArray(raw.citations) && raw.citations.length) {
      msg.citations = raw.citations.map(function (item) {
        if (!item || typeof item !== 'object') return null;
        var url = String(item.url === null || item.url === undefined ? '' : item.url).replace(/^\s+|\s+$/g, '');
        if (!/^https:\/\//i.test(url)) return null;
        return {
          title: String(item.title === null || item.title === undefined ? url : item.title).slice(0, 200),
          url: url.slice(0, 2048),
          snippet: String(item.snippet === null || item.snippet === undefined ? '' : item.snippet).slice(0, 400)
        };
      }).filter(function (x) { return !!x; }).slice(0, MAX_CITATIONS);
    }
    return msg;
  }

  /* 批次1 v2.6.0：Trace 步骤（每会话 ≤500 条） */
  var TRACE_TYPES = { thinking: true, tool_call: true, tool_result: true, note: true };
  var TRACE_MAX = 500;

  function cloneSafe(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.slice(0, 2000);
    try { return JSON.parse(JSON.stringify(value)); } catch (e) { return String(value).slice(0, 2000); }
  }

  function normalizeTraceStep(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var type = String(raw.type || 'note');
    if (!TRACE_TYPES[type]) return null;
    var step = {
      id: raw.id ? String(raw.id) : uid(),
      type: type,
      at: Number(raw.at) || now()
    };
    if (raw.chatId !== undefined && raw.chatId !== null) step.chatId = String(raw.chatId);
    if (type === 'thinking') {
      step.text = raw.text === null || raw.text === undefined ? '' : String(raw.text).slice(0, 600);
    } else if (type === 'note') {
      step.text = raw.text === null || raw.text === undefined ? '' : String(raw.text).slice(0, 600);
    } else if (type === 'tool_call') {
      step.name = raw.name === null || raw.name === undefined ? 'unknown' : String(raw.name).slice(0, 120);
      step.args = raw.args === undefined || raw.args === null ? {} : cloneSafe(raw.args);
      step.risk = String(raw.risk || 'mid').toLowerCase();
      if (step.risk !== 'low' && step.risk !== 'mid' && step.risk !== 'high') step.risk = 'mid';
      var confirmed = String(raw.confirmed || 'auto');
      if (confirmed !== 'auto' && confirmed !== 'pending' && confirmed !== 'confirmed' && confirmed !== 'denied' && confirmed !== 'replayed') confirmed = 'auto';
      step.confirmed = confirmed;
      if (raw.callId) step.callId = String(raw.callId);
      if (raw.requestId) step.requestId = String(raw.requestId);
      if (raw.toolCallId) step.toolCallId = String(raw.toolCallId);
    } else if (type === 'tool_result') {
      step.name = raw.name === null || raw.name === undefined ? 'unknown' : String(raw.name).slice(0, 120);
      step.ok = raw.ok !== false;
      step.summary = raw.summary === null || raw.summary === undefined ? '' : String(raw.summary).slice(0, 600);
      step.durationMs = Math.max(0, Number(raw.durationMs) || 0);
      step.confirmed = raw.confirmed === true;
      if (raw.callId) step.callId = String(raw.callId);
    }
    return step;
  }

  function normalizeTrace(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var step = normalizeTraceStep(raw[i]);
      if (step) out.push(step);
    }
    return out.length > TRACE_MAX ? out.slice(out.length - TRACE_MAX) : out;
  }

  /* 批次1：用量/成本聚合 */
  function emptyUsageBucket() {
    return { prompt: 0, completion: 0, total: 0, cost: 0, requests: 0 };
  }
  function normalizeUsageBucket(raw) {
    var bucket = emptyUsageBucket();
    if (!raw || typeof raw !== 'object') return bucket;
    bucket.prompt = Math.max(0, Number(raw.prompt) || 0);
    bucket.completion = Math.max(0, Number(raw.completion) || 0);
    bucket.total = Math.max(0, Number(raw.total) || 0);
    bucket.cost = Math.max(0, Number(raw.cost) || 0);
    bucket.requests = Math.max(0, Number(raw.requests) || 0);
    return bucket;
  }
  function normalizeUsageEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      prompt: Math.max(0, Number(raw.prompt) || 0),
      completion: Math.max(0, Number(raw.completion) || 0),
      total: Math.max(0, Number(raw.total) || 0),
      cost: Math.max(0, Number(raw.cost) || 0),
      requests: Math.max(0, Number(raw.requests) || 0)
    };
  }
  function normalizeUsage(raw) {
    var usage = {
      total: emptyUsageBucket(),
      byDay: {},
      byModel: {},
      byChat: {},
      updatedAt: 0
    };
    if (!raw || typeof raw !== 'object') return usage;
    usage.total = normalizeUsageBucket(raw.total);
    usage.updatedAt = Number(raw.updatedAt) || 0;
    var groups = ['byDay', 'byModel', 'byChat'];
    for (var g = 0; g < groups.length; g++) {
      var source = raw[groups[g]];
      if (!source || typeof source !== 'object') continue;
      var keys = Object.keys(source);
      for (var k = 0; k < keys.length && k < 400; k++) {
        var entry = normalizeUsageEntry(source[keys[k]]);
        if (entry) usage[groups[g]][String(keys[k]).slice(0, 120)] = entry;
      }
    }
    return usage;
  }

  function normalizeChat(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var chat = {
      id: raw.id ? String(raw.id) : uid(),
      title: raw.title ? String(raw.title).slice(0, 80) : '新的对话',
      createdAt: Number(raw.createdAt) || now(),
      updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || now(),
      pinned: !!raw.pinned,
      unread: Math.max(0, parseInt(raw.unread, 10) || 0),
      archived: !!raw.archived,
      model: raw.model ? String(raw.model) : DEFAULT_PREFS.model,
      messages: []
    };
    if (Array.isArray(raw.messages)) {
      chat.messages = raw.messages.map(normalizeMessage).filter(function (m) { return !!m; });
    }
    // v2.0 F1/F4：预设绑定 + 会话级 system prompt（预设提示词复制到会话，便于用户单独修改）
    if (raw.presetId) chat.presetId = String(raw.presetId).slice(0, 80);
    if (raw.systemPrompt) chat.systemPrompt = String(raw.systemPrompt).slice(0, 16000);
    if (Array.isArray(raw.trace)) chat.trace = normalizeTrace(raw.trace);
    if (raw.lastSnapshotId) chat.lastSnapshotId = String(raw.lastSnapshotId).slice(0, 120);
    if (raw.lastSnapshotCount !== undefined && raw.lastSnapshotCount !== null) chat.lastSnapshotCount = Math.max(0, parseInt(raw.lastSnapshotCount, 10) || 0);
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
    // v2.0 F1：旧数据没有 presets 字段时补默认内置预设；显式数组（含空数组，来自备份导入）按原样归一化
    if (Array.isArray(raw.presets)) {
      next.presets = normalizePresets(raw.presets);
    }
    if (raw.usage !== undefined) next.usage = normalizeUsage(raw.usage);
    var ids = next.chats.map(function (c) { return c.id; });
    if (raw.activeChatId && ids.indexOf(String(raw.activeChatId)) !== -1) {
      next.activeChatId = String(raw.activeChatId);
    } else {
      next.activeChatId = next.chats.length ? sortedChats(next.chats)[0].id : null;
    }
    return next;
  }

  /* ------------------------------------------------------------------ *
   * 持久化（ARCH v2 P4 F9：WebCrypto AES-GCM 本地加密）
   * - 有 Bridge.getStorageSecret()（Base64 32B）且 WebCrypto 可用：状态 JSON 加密后写
   *   localStorage['dsh.v1.enc']，写成功后删除明文键 'dsh.v1'；无密钥/无 WebCrypto 回退明文。
   * - 首次从明文迁移：先成功写 enc 再删明文，失败保留旧键（不丢数据）。
   * - 加密为异步：save() 去抖后排队写入；Store.flush()/loadAsync() 可等待。
   * ------------------------------------------------------------------ */

  var ENC_KEY = 'dsh.v1.enc';
  var ENC_VERSION = 1;
  var secretCache; /* undefined=未探测；null=不可用；string=Base64 */
  var cryptoKeyCache = null;
  var ready = false;
  var loadPromise = null;
  var loadListeners = [];
  var errorListeners = [];
  var saveTimer = null;
  var saveChain = Promise.resolve();
  var latestJson = null;
  var lastError = '';
  var lastSaveAt = 0;

  function bridgeRef() {
    try { return global.Bridge || null; } catch (e) { return null; }
  }

  function getSecret() {
    if (secretCache !== undefined) return secretCache;
    var secret = '';
    try {
      var B = bridgeRef();
      if (B && typeof B.getStorageSecret === 'function') secret = String(B.getStorageSecret() || '');
    } catch (e) { secret = ''; }
    secretCache = secret || null;
    return secretCache;
  }

  function notifyLoad() {
    ready = true;
    var copy = loadListeners.slice();
    for (var i = 0; i < copy.length; i++) {
      try { copy[i](state); } catch (e) { warn('load listener 异常：' + (e && e.message)); }
    }
  }

  function notifyError(message) {
    lastError = String(message || '');
    warn(lastError);
    var copy = errorListeners.slice();
    for (var i = 0; i < copy.length; i++) {
      try { copy[i](lastError); } catch (e) { /* ignore */ }
    }
  }

  function base64ToBytes(b64) {
    var text = String(b64 || '');
    if (!text) return new Uint8Array(0);
    try {
      var bin = global.atob(text);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) { return new Uint8Array(0); }
  }

  function bytesToBase64(bytes) {
    var chunks = [];
    var limit = 0x8000;
    for (var i = 0; i < bytes.length; i += limit) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + limit)));
    }
    try { return global.btoa(chunks.join('')); } catch (e) { return ''; }
  }

  function getCryptoKey() {
    if (cryptoKeyCache) return Promise.resolve(cryptoKeyCache);
    var secret = getSecret();
    if (!secret) return Promise.resolve(null);
    var cryptoObj = global.crypto;
    if (!cryptoObj || !cryptoObj.subtle || typeof global.TextEncoder === 'undefined') return Promise.resolve(null);
    try {
      var raw = base64ToBytes(secret);
      if (!raw || raw.length < 16) return Promise.resolve(null);
      return cryptoObj.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']).then(function (key) {
        cryptoKeyCache = key;
        return key;
      }, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function encryptJson(json) {
    return getCryptoKey().then(function (key) {
      if (!key) return null;
      var cryptoObj = global.crypto;
      var iv = new Uint8Array(12);
      try { cryptoObj.getRandomValues(iv); } catch (e) { return null; }
      var data = new global.TextEncoder().encode(json);
      return cryptoObj.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data).then(function (buffer) {
        return {
          v: ENC_VERSION,
          iv: bytesToBase64(iv),
          data: bytesToBase64(new Uint8Array(buffer)),
          updatedAt: Date.now()
        };
      });
    }).catch(function (e) {
      warn('加密失败：' + (e && e.message));
      return null;
    });
  }

  function decryptPayload(payload) {
    return getCryptoKey().then(function (key) {
      if (!key) throw new Error('无可用的本地加密密钥');
      if (!payload || !payload.iv || !payload.data) throw new Error('加密数据格式错误');
      var cryptoObj = global.crypto;
      var iv = base64ToBytes(payload.iv);
      var data = base64ToBytes(payload.data);
      if (!iv.length || !data.length) throw new Error('加密数据为空');
      return cryptoObj.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data).then(function (buffer) {
        return new global.TextDecoder().decode(new Uint8Array(buffer));
      });
    });
  }

  function readPlainRaw() {
    try { return storage.getItem(KEY); } catch (e) { return null; }
  }

  function readEncRaw() {
    try { return storage.getItem(ENC_KEY); } catch (e) { return null; }
  }

  function writeEnc(raw) {
    try { storage.setItem(ENC_KEY, raw); return true; } catch (e) { return false; }
  }

  function removePlain() {
    try { storage.removeItem(KEY); return true; } catch (e) { return false; }
  }

  function encryptedSave(json) {
    return encryptJson(json).then(function (payload) {
      if (!payload) {
        /* 加密不可用：回退明文（保留旧键；不删除 enc，避免丢数据） */
        var fallback = false;
        try { storage.setItem(KEY, json); fallback = true; } catch (e) { /* ignore */ }
        notifyError(fallback ? '本地加密不可用，已回退明文存储' : '本地存储写入失败');
        return false;
      }
      var raw = '';
      try { raw = JSON.stringify(payload); } catch (e2) { raw = ''; }
      if (!raw || !writeEnc(raw)) {
        notifyError('本地加密写入失败（已保留旧数据）');
        return false;
      }
      /* 加密写成功后才删除明文键：首次迁移/后续保存都不丢数据 */
      removePlain();
      lastSaveAt = Date.now();
      return true;
    });
  }

  function scheduleEncryptedSave(json) {
    latestJson = json;
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      var target = latestJson;
      latestJson = null;
      if (!target) return;
      saveChain = saveChain.then(function () { return encryptedSave(target); }, function () { return encryptedSave(target); });
    }, 80);
  }

  function load(force) {
    if (state && !force) { ready = true; return state; }
    if (force) {
      secretCache = undefined;
      cryptoKeyCache = null;
      loadPromise = null;
      ready = false;
    }
    var plainRaw = readPlainRaw();
    var encRaw = readEncRaw();
    var parsed = null;
    if (plainRaw) {
      try { parsed = JSON.parse(plainRaw); } catch (e) { parsed = null; }
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      state = normalizeState(parsed);
      ready = true;
      notifyLoad();
      /* 有密钥时把明文数据迁移为加密存储（异步；失败保留明文键） */
      if (getSecret()) save();
      return state;
    }
    if (plainRaw) warn('本地数据损坏，已重置');
    if (encRaw && !plainRaw) {
      /* 仅有加密数据：先返回空态，异步解密后通知 listener；App.boot 会 loadAsync 后刷新 */
      state = freshState();
      loadPromise = (function () {
        var payload = null;
        try { payload = JSON.parse(encRaw); } catch (e) { payload = null; }
        return decryptPayload(payload).then(function (text) {
          var decrypted = null;
          try { decrypted = JSON.parse(text); } catch (e2) { decrypted = null; }
          if (decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)) {
            state = normalizeState(decrypted);
            save(); /* 重新排队加密保存（保持 enc 最新） */
          } else {
            notifyError('本地加密数据解密后格式异常，已使用空数据');
          }
          notifyLoad();
          return state;
        }, function (err) {
          notifyError('本地数据解密失败：' + (err && err.message ? err.message : err));
          notifyLoad();
          return state;
        });
      })();
      return state;
    }
    state = freshState();
    ready = true;
    notifyLoad();
    save();
    return state;
  }

  function save() {
    if (!state) return false;
    var json = '';
    try { json = JSON.stringify(state); } catch (e) {
      warn('保存失败（序列化错误）：' + (e && e.message));
      return false;
    }
    if (!getSecret()) {
      /* 无密钥 / 无 WebCrypto：回退明文存储 */
      try { storage.setItem(KEY, json); return true; } catch (e2) {
        warn('保存失败（可能存储空间不足）：' + (e2 && e2.message));
        return false;
      }
    }
    scheduleEncryptedSave(json);
    return true;
  }

  function flush() {
    if (saveTimer && latestJson) {
      clearTimeout(saveTimer);
      saveTimer = null;
      var target = latestJson;
      latestJson = null;
      saveChain = saveChain.then(function () { return encryptedSave(target); }, function () { return encryptedSave(target); });
    }
    return saveChain;
  }

  function loadAsync(force) {
    load(force);
    if (loadPromise) return loadPromise.then(function () { return state; }, function () { return state; });
    return Promise.resolve(state);
  }

  function isReady() {
    return !!ready;
  }

  function getEncryptionState() {
    var plain = !!readPlainRaw();
    var enc = !!readEncRaw();
    return {
      ready: !!ready,
      secretAvailable: !!getSecret(),
      encrypted: enc,
      plaintext: plain,
      saving: !!saveTimer || !!latestJson,
      lastSaveAt: lastSaveAt,
      error: lastError
    };
  }

  function onLoad(fn) {
    if (typeof fn !== 'function') return function () { };
    loadListeners.push(fn);
    return function () {
      var idx = loadListeners.indexOf(fn);
      if (idx >= 0) loadListeners.splice(idx, 1);
    };
  }

  function onError(fn) {
    if (typeof fn !== 'function') return function () { };
    errorListeners.push(fn);
    return function () {
      var idx = errorListeners.indexOf(fn);
      if (idx >= 0) errorListeners.splice(idx, 1);
    };
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
    if (patch.contextBudget !== undefined) state.prefs.contextBudget = Math.round(clampNum(patch.contextBudget, 500, 200000));
    if (patch.workbench !== undefined) state.prefs.workbench = !!patch.workbench;
    if (patch.terminalHeight !== undefined) state.prefs.terminalHeight = Math.round(clampNum(patch.terminalHeight, 120, 800));
    if (patch.appLock !== undefined) state.prefs.appLock = !!patch.appLock;
    if (patch.costBudget !== undefined && patch.costBudget && typeof patch.costBudget === 'object') {
      state.prefs.costBudget = {
        daily: Math.max(0, Number(patch.costBudget.daily) || 0),
        monthly: Math.max(0, Number(patch.costBudget.monthly) || 0)
      };
    }
    if (patch.costPrice !== undefined && patch.costPrice && typeof patch.costPrice === 'object') {
      var nextPrices = {};
      var npKeys = Object.keys(patch.costPrice);
      for (var npi = 0; npi < npKeys.length && npi < 50; npi++) {
        var npv = patch.costPrice[npKeys[npi]];
        if (!npv || typeof npv !== 'object') continue;
        nextPrices[String(npKeys[npi]).slice(0, 80)] = {
          input: Math.max(0, Number(npv.input) || 0),
          output: Math.max(0, Number(npv.output) || 0)
        };
      }
      state.prefs.costPrice = nextPrices;
    }
    if (patch.appPin !== undefined) state.prefs.appPin = normalizeAppPin(patch.appPin);
    if (patch.toolPolicies !== undefined && patch.toolPolicies && typeof patch.toolPolicies === 'object') {
      var nextPolicies = {};
      var npKeys2 = Object.keys(patch.toolPolicies);
      for (var npj = 0; npj < npKeys2.length && npj < 200; npj++) {
        var npm = String(patch.toolPolicies[npKeys2[npj]] || '');
        if (npm === 'auto' || npm === 'once' || npm === 'always' || npm === 'deny') {
          nextPolicies[String(npKeys2[npj]).slice(0, 120)] = npm;
        }
      }
      state.prefs.toolPolicies = nextPolicies;
    }
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

  function filterArchived(list, opts) {
    if (!opts || typeof opts !== 'object') return list;
    var result = list;
    if (opts.includeArchived === false) result = result.filter(function (c) { return !c.archived; });
    if (opts.archived === true) result = result.filter(function (c) { return !!c.archived; });
    else if (opts.archived === false) result = result.filter(function (c) { return !c.archived; });
    return result;
  }

  /**
   * 会话列表（pinned 优先，updatedAt 降序）。
   * opts.includeArchived === false / opts.archived === false → 排除已归档；
   * opts.archived === true → 仅已归档（v2.0 F2 归档标签页由 UI 过滤，这里提供数据层支持）。
   */
  function listChats(opts) {
    load();
    return filterArchived(sortedChats(state.chats), opts);
  }

  function setUnread(id, count) {
    load();
    var chat = getChat(id);
    if (!chat) return null;
    chat.unread = Math.max(0, parseInt(count, 10) || 0);
    save();
    return chat;
  }

  function incrementUnread(id) {
    load();
    var chat = getChat(id);
    if (!chat) return null;
    chat.unread = Math.max(0, chat.unread || 0) + 1;
    save();
    return chat;
  }

  function clearUnread(id) {
    return setUnread(id, 0);
  }

  function totalUnread() {
    load();
    var n = 0;
    for (var i = 0; i < state.chats.length; i++) n += Math.max(0, state.chats[i].unread || 0);
    return n;
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
      unread: 0,
      archived: false,
      model: opts.model || state.prefs.model || DEFAULT_PREFS.model,
      messages: []
    };
    // v2.0 F1：从智能体预设创建会话时，绑定 presetId 并把提示词复制到会话（用户可单独修改）
    if (opts.presetId) chat.presetId = String(opts.presetId).slice(0, 80);
    if (opts.systemPrompt) chat.systemPrompt = String(opts.systemPrompt).slice(0, 16000);
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
    if (patch.unread !== undefined) chat.unread = Math.max(0, parseInt(patch.unread, 10) || 0);
    if (patch.archived !== undefined) chat.archived = !!patch.archived;
    if (patch.presetId !== undefined) chat.presetId = patch.presetId ? String(patch.presetId).slice(0, 80) : '';
    if (patch.systemPrompt !== undefined) chat.systemPrompt = String(patch.systemPrompt).slice(0, 16000);
    if (patch.lastSnapshotId !== undefined) chat.lastSnapshotId = patch.lastSnapshotId ? String(patch.lastSnapshotId).slice(0, 120) : '';
    if (patch.lastSnapshotCount !== undefined) chat.lastSnapshotCount = Math.max(0, parseInt(patch.lastSnapshotCount, 10) || 0);
    if (patch.updatedAt !== undefined) chat.updatedAt = Number(patch.updatedAt) || now();
    save();
    return chat;
  }

  /**
   * 搜索会话（标题 / 正文 / 思考过程），返回结果始终带 archived 字段。
   * opts 同 listChats（按当前标签页过滤由 UI 决定，这里可选过滤）。
   */
  function searchChats(query, opts) {
    load();
    var q = String(query === null || query === undefined ? '' : query).replace(/^\s+|\s+$/g, '').toLowerCase();
    if (!q) return listChats(opts);
    var result = state.chats.filter(function (chat) {
      if (String(chat.title || '').toLowerCase().indexOf(q) !== -1) return true;
      for (var i = 0; i < chat.messages.length; i++) {
        var m = chat.messages[i];
        if (String(m.content || '').toLowerCase().indexOf(q) !== -1) return true;
        if (String(m.reasoning || '').toLowerCase().indexOf(q) !== -1) return true;
      }
      return false;
    });
    return filterArchived(sortedChats(result), opts);
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
   * 批次1 v2.6.0：Trace 记录（chat.trace，≤500 条/会话，持久化）
   * ------------------------------------------------------------------ */

  function getTrace(chatId) {
    load();
    var chat = resolveChat(chatId);
    if (!chat || !Array.isArray(chat.trace)) return [];
    return chat.trace.slice();
  }

  function appendTrace(chatId, step) {
    load();
    var chat = resolveChat(chatId);
    if (!chat) return null;
    var normalized = normalizeTraceStep(step);
    if (!normalized) return null;
    if (!Array.isArray(chat.trace)) chat.trace = [];
    chat.trace.push(normalized);
    if (chat.trace.length > TRACE_MAX) chat.trace = chat.trace.slice(chat.trace.length - TRACE_MAX);
    save();
    return normalized;
  }

  /** 更新单条 trace 步骤（用于工具确认状态等就地更新） */
  function updateTrace(chatId, traceId, patch) {
    load();
    var chat = resolveChat(chatId);
    if (!chat || !Array.isArray(chat.trace)) return null;
    var key = String(traceId);
    for (var i = 0; i < chat.trace.length; i++) {
      if (String(chat.trace[i].id) !== key) continue;
      var step = chat.trace[i];
      var keys = Object.keys(patch || {});
      for (var j = 0; j < keys.length; j++) {
        var prop = keys[j];
        if (prop === 'id' || prop === 'type' || prop === 'at') continue;
        if (patch[prop] === undefined) continue;
        step[prop] = patch[prop];
      }
      save();
      return step;
    }
    return null;
  }

  function clearTrace(chatId) {
    load();
    var chat = resolveChat(chatId);
    if (!chat) return false;
    chat.trace = [];
    save();
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 批次1 v2.6.0：用量/成本聚合（总量 / 天 / 模型 / 会话）
   * ------------------------------------------------------------------ */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function dayKey(ts) {
    var d = new Date(Number(ts) || now());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function accumulateUsage(bucket, entry) {
    bucket.prompt += entry.prompt || 0;
    bucket.completion += entry.completion || 0;
    bucket.total += entry.total || ((entry.prompt || 0) + (entry.completion || 0));
    bucket.cost += entry.cost || 0;
    bucket.requests += entry.requests === undefined ? 1 : (Number(entry.requests) || 0);
    return bucket;
  }

  /**
   * 记录一次请求用量：{prompt,completion,total,cost,model,chatId,day?,at?}
   * 返回最新的 usage 快照（JSON 副本）。
   */
  function addUsage(entry) {
    load();
    var raw = normalizeUsageEntry(entry) || emptyUsageBucket();
    raw.requests = entry && entry.requests !== undefined ? Math.max(0, Number(entry.requests) || 0) : 1;
    if (!raw.total) raw.total = raw.prompt + raw.completion;
    if (!state.usage) state.usage = normalizeUsage(null);
    var usage = state.usage;
    accumulateUsage(usage.total, raw);
    var day = dayKey(entry && (entry.at || entry.day));
    if (!usage.byDay[day]) usage.byDay[day] = emptyUsageBucket();
    accumulateUsage(usage.byDay[day], raw);
    var model = String((entry && entry.model) || 'unknown').slice(0, 120);
    if (!usage.byModel[model]) usage.byModel[model] = emptyUsageBucket();
    accumulateUsage(usage.byModel[model], raw);
    var chatId = entry && entry.chatId ? String(entry.chatId) : '';
    if (chatId) {
      if (!usage.byChat[chatId]) usage.byChat[chatId] = emptyUsageBucket();
      accumulateUsage(usage.byChat[chatId], raw);
    }
    usage.updatedAt = now();
    save();
    return clone(usage);
  }

  function getUsage() {
    load();
    return clone(state.usage || normalizeUsage(null));
  }

  function resetUsage() {
    load();
    state.usage = normalizeUsage(null);
    save();
    return getUsage();
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
   * 智能体预设 CRUD（追加需求 v2.0 F1）
   * ------------------------------------------------------------------ */

  /** 全部预设（含内置）快照 */
  function getPresets() {
    load();
    return clone(state.presets || []);
  }

  function getPreset(id) {
    load();
    var key = String(id);
    var list = state.presets || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === key) return clone(list[i]);
    }
    return null;
  }

  /**
   * 新增或更新预设：有 id 且命中 → 覆盖（builtin 标记保留）；否则新增（id 自动生成，builtin=false）。
   * 返回保存后的预设快照；name 为空返回 null。
   */
  function savePreset(agent) {
    load();
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return null;
    var preset = normalizePreset(agent);
    if (!preset) return null;
    if (!state.presets) state.presets = defaultPresets();
    var list = state.presets;
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === preset.id) { idx = i; break; }
    }
    if (idx >= 0) {
      // 内置预设可编辑但保持 builtin 标记（不可删除）
      preset.builtin = !!list[idx].builtin || !!preset.builtin;
      list[idx] = preset;
    } else {
      if (list.length >= MAX_PRESETS) return null;
      preset.builtin = !!preset.builtin;
      list.push(preset);
    }
    save();
    return clone(preset);
  }

  /** 删除预设；内置预设受保护（返回 false），可用 resetPresets() 恢复默认目录 */
  function deletePreset(id) {
    load();
    var key = String(id);
    var list = state.presets || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== key) continue;
      if (list[i].builtin) return false;
      list.splice(i, 1);
      save();
      return true;
    }
    return false;
  }

  function setPresets(list) {
    load();
    state.presets = normalizePresets(list);
    save();
    return getPresets();
  }

  /** 恢复内置默认预设（4 个），用户自建预设保留并排在后面 */
  function resetPresets() {
    load();
    var kept = (state.presets || []).filter(function (item) { return item && !item.builtin; });
    state.presets = defaultPresets().concat(kept).slice(0, MAX_PRESETS);
    save();
    return getPresets();
  }

  /* ------------------------------------------------------------------ *
   * 会话分支 fork（追加需求 v2.0 F4）
   * ------------------------------------------------------------------ */

  /**
   * 复制 chatId 会话中「从开头到 msgId（含）」的消息为新会话。
   * 新消息 id、title 追加「 · 分支」、model 沿用、archived=false；返回新 chat 并设为当前会话。
   * msgId 为空/null → 复制全部消息；msgId 找不到 / 会话无消息 → 返回 null。
   */
  function forkChat(chatId, msgId) {
    load();
    var chat = getChat(chatId);
    if (!chat) return null;
    var end = chat.messages.length;
    if (msgId !== null && msgId !== undefined && String(msgId) !== '') {
      var key = String(msgId);
      var idx = -1;
      for (var i = 0; i < chat.messages.length; i++) {
        if (chat.messages[i].id === key) { idx = i; break; }
      }
      if (idx < 0) return null;
      end = idx + 1;
    }
    if (end <= 0) return null;
    var messages = [];
    for (var m = 0; m < end; m++) {
      var copy = normalizeMessage(clone(chat.messages[m]));
      if (!copy) continue;
      copy.id = uid();
      delete copy.streaming;
      messages.push(copy);
    }
    var baseTitle = String(chat.title || '对话').slice(0, 74);
    var forked = {
      id: uid(),
      title: (baseTitle + ' · 分支').slice(0, 80),
      createdAt: now(),
      updatedAt: now(),
      pinned: false,
      unread: 0,
      archived: false,
      model: chat.model || state.prefs.model || DEFAULT_PREFS.model,
      messages: messages
    };
    if (chat.presetId) forked.presetId = chat.presetId;
    if (chat.systemPrompt) forked.systemPrompt = chat.systemPrompt;
    state.chats.push(forked);
    state.activeChatId = forked.id;
    save();
    return clone(forked);
  }

  /* ------------------------------------------------------------------ *
   * 备份 / 恢复（追加需求 v2.0 F3）
   * ------------------------------------------------------------------ */

  /** 导出用的数据快照（prefs 不含 apiKey） */
  function exportBackupData() {
    load();
    var prefs = {};
    var keys = Object.keys(state.prefs || {});
    for (var i = 0; i < keys.length; i++) prefs[keys[i]] = state.prefs[keys[i]];
    delete prefs.apiKey;
    /* 批次2：PIN 凭据不进入备份（防止迁移后锁定/泄露） */
    delete prefs.appPin;
    var enabled = {};
    var source = state.plugins && state.plugins.enabled ? state.plugins.enabled : {};
    var ekeys = Object.keys(source);
    for (var j = 0; j < ekeys.length; j++) enabled[ekeys[j]] = !!source[ekeys[j]];
    return {
      prefs: prefs,
      chats: clone(state.chats || []),
      customModels: (state.customModels || []).slice(),
      presets: clone(state.presets || []),
      plugins: { enabled: enabled }
    };
  }

  /**
   * 用备份数据整体替换 Store（导入备份）。缺省字段回退到默认值；activeChatId 指向排序后的第一个会话。
   * data = {prefs, chats, customModels, presets, plugins:{enabled}}
   */
  function replaceData(data) {
    load();
    data = data && typeof data === 'object' ? data : {};
    var next = freshState();
    if (data.prefs && typeof data.prefs === 'object') next.prefs = normalizePrefs(data.prefs);
    if (Array.isArray(data.chats)) {
      next.chats = data.chats.map(normalizeChat).filter(function (c) { return !!c; });
    }
    if (data.customModels !== undefined) next.customModels = normalizeCustomModels(data.customModels);
    if (Array.isArray(data.presets)) next.presets = normalizePresets(data.presets);
    if (data.plugins && typeof data.plugins === 'object') {
      var enabled = data.plugins.enabled;
      if (enabled && typeof enabled === 'object') {
        var ekeys = Object.keys(enabled);
        for (var i = 0; i < ekeys.length; i++) next.plugins.enabled[ekeys[i]] = !!enabled[ekeys[i]];
      }
    } else if (data.pluginStates && typeof data.pluginStates === 'object') {
      /* 兼容 SPEC v2.0 F3 中的 pluginStates 命名 */
      var pkeys = Object.keys(data.pluginStates);
      for (var j = 0; j < pkeys.length; j++) next.plugins.enabled[pkeys[j]] = !!data.pluginStates[pkeys[j]];
    }
    next.activeChatId = next.chats.length ? sortedChats(next.chats)[0].id : null;
    state = next;
    save();
    return state;
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

  /** 清空会话/插件/UI（保留 prefs 设置与智能体预设） */
  function clearAll() {
    var prefs = state ? getPrefs() : defaultPrefs();
    var presets = state && Array.isArray(state.presets) ? clone(state.presets) : defaultPresets();
    state = freshState();
    state.prefs = prefs;
    state.presets = presets;
    save();
    return state;
  }

  global.Store = {
    KEY: KEY,
    VERSION: VERSION,
    DEFAULT_PREFS: DEFAULT_PREFS,
    defaultPrefs: defaultPrefs,
    load: load,
    loadAsync: loadAsync,
    save: save,
    flush: flush,
    isReady: isReady,
    getEncryptionState: getEncryptionState,
    onLoad: onLoad,
    onError: onError,
    getState: getState,
    ENC_KEY: ENC_KEY,

    getPrefs: getPrefs,
    setPrefs: setPrefs,

    setUnread: setUnread,
    incrementUnread: incrementUnread,
    clearUnread: clearUnread,
    totalUnread: totalUnread,
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

    /* v2.0 F1：智能体预设 */
    DEFAULT_PRESETS: DEFAULT_PRESETS,
    defaultPresets: defaultPresets,
    getPresets: getPresets,
    getPreset: getPreset,
    savePreset: savePreset,
    deletePreset: deletePreset,
    setPresets: setPresets,
    resetPresets: resetPresets,

    /* v2.0 F4：分支 */
    forkChat: forkChat,

    /* v2.0 F3：备份 / 恢复 */
    exportBackupData: exportBackupData,
    replaceData: replaceData,

    /* 批次1 v2.6.0：Trace / 用量成本 */
    getTrace: getTrace,
    appendTrace: appendTrace,
    updateTrace: updateTrace,
    clearTrace: clearTrace,
    addUsage: addUsage,
    getUsage: getUsage,
    resetUsage: resetUsage,

    getPluginEnabled: getPluginEnabled,
    setPluginEnabled: setPluginEnabled,
    getPluginSettings: getPluginSettings,
    getPluginSetting: getPluginSetting,
    setPluginSetting: setPluginSetting,

    getUI: getUI,
    setUI: setUI
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
