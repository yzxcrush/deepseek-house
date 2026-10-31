/* ==========================================================================
   DeepSeek House — ui.js
   DOM / 外观层：实现 window.UI 全部 API（SPEC §4.2）。
   只负责渲染、动画、屏幕切换、抽屉、表单、插件列表、登录页、弹窗、Toast。
   不直接发网络请求；不读写 localStorage；所有业务通过 UI.init(cb) 注入的回调。
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 内联 SVG 图标（动态渲染用；静态图标在 index.html 中）
   * ------------------------------------------------------------------ */
  var ICON = {
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"></rect><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4H6.5A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"></path></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 1 1-2.4-5.9"></path><path d="M20.5 4v7h-7"></path></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"></path><path d="M10 11v6M14 11v6"></path><path d="M6.5 7 7.5 19a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4L17.5 7"></path><path d="M9.5 7V4.8h5V7"></path></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L20 8l-4-4L4 16v4Z"></path><path d="m14 6 4 4"></path></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"></path><path d="m7 10 5 5 5-5"></path><path d="M4 19h16"></path></svg>',
    wrench: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.8 6.2a4.2 4.2 0 0 0-5.5 5.5L4 17v3h3l5.3-5.3a4.2 4.2 0 0 0 5.5-5.5l-2.6 2.6-2.4-2.4 2.5-2.7Z"></path></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"></path></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>',
    checkDouble: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.8 12.4 5.4 16 12 8.6"></path><path d="M8.8 12.4 12.4 16 22 5.6"></path></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6l-1.2 6.2L17 12.5H7l3.2-3.3L9 3Z"></path><path d="M12 12.5V21"></path></svg>',
    archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.4 5.6A1.6 1.6 0 0 1 5 4h14a1.6 1.6 0 0 1 1.6 1.6V8H3.4V5.6Z"></path><path d="M4.6 8v10.4A1.6 1.6 0 0 0 6.2 20h11.6a1.6 1.6 0 0 0 1.6-1.6V8"></path><path d="M10 12h4"></path></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 13.5a4.2 4.2 0 0 0 6 0l2.7-2.7a4.2 4.2 0 0 0-6-6l-1.5 1.5"></path><path d="M13.5 10.5a4.2 4.2 0 0 0-6 0l-2.7 2.7a4.2 4.2 0 0 0 6 6l1.5-1.5"></path></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>',
    puzzle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4.8a2 2 0 0 1 4 0V6h3.2c.4 0 .8.4.8.8V10h1.2a2 2 0 0 1 0 4H17v3.2c0 .4-.4.8-.8.8H13v1.2a2 2 0 0 1-4 0V18H5.8a.8.8 0 0 1-.8-.8V14h1.2a2 2 0 0 1 0-4H5V6.8c0-.4.4-.8.8-.8H9V4.8Z"></path></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2l1.8 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9Z"></path><path d="M3.5 10h17"></path></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"></path><path d="M14 3.5V8h4"></path><path d="M8.5 12.5h7M8.5 16h5"></path></svg>',
    terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2.5"></rect><path d="m7 9.5 3 2.5-3 2.5"></path><path d="M13 15h4"></path></svg>',
    fork: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2.2"></circle><circle cx="18" cy="5" r="2.2"></circle><circle cx="12" cy="19" r="2.2"></circle><path d="M6 7.2v2.3a2.5 2.5 0 0 0 2.5 2.5h7A2.5 2.5 0 0 0 18 9.5V7.2"></path><path d="M12 12v4.8"></path></svg>',
    audit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"></path><path d="M9 4v4h6"></path><path d="M8.5 12.5h7M8.5 16h7"></path></svg>',
    backup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v11"></path><path d="m8 10 4 4 4-4"></path><path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"></path></svg>'
  };

  var MODEL_LABELS = {
    'deepseek-chat': 'DeepSeek-V3.2 通用',
    'deepseek-reasoner': 'DeepSeek-R1 推理'
  };

  var raf = window.requestAnimationFrame
    ? function (cb) { return window.requestAnimationFrame(cb); }
    : function (cb) { return setTimeout(cb, 16); };
  var caf = window.cancelAnimationFrame
    ? function (id) { window.cancelAnimationFrame(id); }
    : function (id) { clearTimeout(id); };

  /* ------------------------------------------------------------------ *
   * 内部状态（不暴露给业务层）
   * ------------------------------------------------------------------ */
  var state = {
    cb: {},
    initialized: false,
    refs: {},
    screen: 'chat',

    /* 消息 */
    order: [],
    msgData: Object.create(null),
    msgNodes: Object.create(null),
    lastDateKey: '',
    typingEl: null,
    dirty: Object.create(null),
    pendingRaf: 0,

    /* 生成 / 输入 */
    streaming: false,
    composerBusy: false,
    composerDisabled: false,
    autoScroll: true,

    /* 抽屉 / 搜索 / 菜单 */
    drawerOpen: false,
    searchQuery: '',
    searchTimer: 0,
    emojiOpen: false,
    chatTab: 'all',
    chats: [],
    activeChatId: null,
    /* 智能体预设（SPEC v2.0 F1） */
    agents: [],

    /* 模型 */
    model: 'deepseek-chat',
    models: [],
    modelLabel: '',
    modelLabelId: '',
    subtitleOverride: '',

    /* 模型选择器（SPEC v1.1 B2） */
    modelPicker: {
      open: false,
      models: [],
      currentId: '',
      onPick: null,
      resolved: false,
      query: '',
      customOpen: false,
      opts: {},
      refreshTimer: 0
    },

    /* 智能体选择器（SPEC v2.0 F1） */
    agentPicker: {
      open: false,
      agents: [],
      currentId: '',
      onPick: null,
      resolved: false,
      opts: {}
    },

    /* 各页数据 */
    prefs: {},
    plugins: [],
    login: { hasKey: false, error: '', busy: false },

    /* 弹窗 Promise */
    confirmResolve: null,
    renameResolve: null,

    /* 长按菜单 */
    menuOpen: false,
    menuItems: [],
    pressTimer: 0,
    pressStart: null,
    pressFired: false,

    /* ARCH v2 P1：文件树抽屉 / 工作区 / 终端 / 高危确认 / 审计 */
    fileDrawer: {
      open: false,
      entries: [],
      root: '',
      path: '',
      writable: true,
      loading: false,
      dragX: 0
    },
    workspace: {
      root: '',
      writable: false,
      allFilesAccess: false,
      loaded: false
    },
    terminal: {
      open: false,
      running: false,
      timer: 0
    },
    riskResolve: null,
    audit: [],
    /* ARCH v2 P2：MCP 服务器管理 */
    mcp: {
      servers: [],
      statusMap: {},
      editingId: '',
      loading: false
    },
    /* ARCH v2 P3：插件市场 / 记忆 / 插件面板 */
    market: {
      items: [],
      statusMap: {},
      url: '',
      loaded: false,
      source: null,
      query: '',
      category: 'all',
      sort: 'recommended',
      loading: false,
      error: '',
      installProgress: {},
      detailId: null,
      searchTimer: 0,
      filteredCount: 0
    },
    memory: {
      longTerm: [],
      project: { tech_stack: '', conventions: '', decisions: '' },
      summaries: [],
      loaded: false
    },
    pluginSlots: [],
    pluginPanelOpen: false,
    /* ARCH v2 P4：工作台 / 构建任务 / 待发送图片 / 安全设置 */
    workbench: {
      enabled: false,
      active: false,
      terminalHeight: 0,
      resizing: false
    },
    pendingImages: [],
    buildTasks: [],
    buildPanelOpen: false,
    security: {
      appLock: false,
      encrypted: false,
      rootMode: false,
      rootMessage: '',
      pin: false,
      pinLocked: false
    },
    /* 批次 1 v2.6.0：轨迹 / 成本 / 工具权限 / 斜杠命令 */
    trace: {
      events: [],
      chatId: null,
      chatTitle: '',
      query: '',
      loaded: false
    },
    cost: {
      data: null,
      alert: null,
      loaded: false
    },
    toolPolicies: {
      list: [],
      loaded: false
    },
    slash: {
      open: false,
      commands: [],
      filtered: [],
      index: 0,
      query: '',
      custom: null
    },
    /* 批次 2 · v2.7.0：快照 / PIN / 密码输入 */
    snapshots: {
      list: [],
      diffs: {},
      openId: null,
      loadingId: null,
      loaded: false
    },
    pin: {
      resolve: null,
      passwordResolve: null,
      setupForToggle: false
    },
    /* 批次 3 · v2.8.0：外观 / 引用 / 编辑 / 会话搜索 / i18n */
    appearance: {
      theme: 'dark',
      fontScale: 1,
      wallpaper: '',
      glass: { intensity: 60, speed: 1 }
    },
    quote: null,
    edit: { msgId: null },
    chatSearch: { keyword: '', matches: [], index: 0 },
    locale: 'zh',
    /* v3.0.0：Bot 集成 */
    bots: {
      list: [],
      messages: {},
      targets: {},
      currentId: null,
      form: { id: null, type: 'telegram', editing: false }
    }
  };

  var WORKBENCH_KEY = 'dsh.workbench';

  var UI = {};
  window.UI = UI;

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */
  function r(id) {
    return state.refs[id] || document.getElementById(id) || null;
  }

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function makeText(tag, cls, text) {
    var node = el(tag, cls);
    node.textContent = text == null ? '' : String(text);
    return node;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function toDate(value) {
    if (value instanceof Date) return value;
    if (typeof value === 'number' && isFinite(value)) {
      var d = new Date(value);
      if (!isNaN(d.getTime())) return d;
    }
    if (typeof value === 'string' && value) {
      var parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return parsed;
    }
    return new Date();
  }

  function formatTime(value) {
    var d = toDate(value);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function dayKey(value) {
    var d = toDate(value);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function dateLabel(value) {
    var d = toDate(value);
    var now = new Date();
    var key = dayKey(d);
    if (key === dayKey(now)) return '今天';
    if (key === dayKey(new Date(now.getTime() - 86400000))) return '昨天';
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function listTime(value) {
    var d = toDate(value);
    var now = new Date();
    var key = dayKey(d);
    if (key === dayKey(now)) return formatTime(d);
    if (key === dayKey(new Date(now.getTime() - 86400000))) return '昨天';
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '/' + d.getDate();
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  function truncate(text, max) {
    var s = String(text == null ? '' : text);
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
  }

  function invoke(name) {
    var fn = state.cb ? state.cb[name] : null;
    if (typeof fn !== 'function') return false;
    try {
      fn.apply(null, Array.prototype.slice.call(arguments, 1));
    } catch (err) {
      console.warn('[UI] 回调 ' + name + ' 执行出错:', err);
    }
    return true;
  }

  /* 需要回调返回值（Promise/boolean）时使用；不存在返回 undefined */
  function callHandler(name) {
    var fn = state.cb ? state.cb[name] : null;
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(null, Array.prototype.slice.call(arguments, 1));
    } catch (err) {
      console.warn('[UI] 回调 ' + name + ' 执行出错:', err);
      return undefined;
    }
  }

  function modelLabel(model) {
    var id = model || state.model;
    for (var i = 0; i < state.models.length; i++) {
      if (state.models[i].id === id) return state.models[i].label;
    }
    return MODEL_LABELS[id] || String(id || 'deepseek-chat');
  }

  function md(text) {
    var source = text == null ? '' : String(text);
    var M = window.Markdown;
    var candidates = [];
    if (M) {
      candidates.push(M.render, M.renderMarkdown);
    }
    candidates.push(window.renderMarkdown);
    for (var i = 0; i < candidates.length; i++) {
      if (typeof candidates[i] === 'function') {
        try {
          var out = candidates[i](source);
          if (typeof out === 'string') return out;
        } catch (err) {
          console.warn('[UI] Markdown 渲染失败，降级为纯文本:', err);
        }
      }
    }
    return '<div class="md-fallback">' + escapeHtml(source) + '</div>';
  }

  /* ------------------------------------------------------------------ *
   * 模型选择器（SPEC v1.1 B2）
   * 数据完全由 app.js 构造（ModelInfo），UI 只负责分组渲染与交互。
   * ------------------------------------------------------------------ */
  var PICKER_GROUPS = [
    { key: 'V4', title: 'V4 系列' },
    { key: 'V3', title: 'V3 系列' },
    { key: 'V2', title: 'V2 系列' },
    { key: 'V1', title: 'V1 系列' },
    { key: '自定义', title: '自定义' },
    { key: '其他', title: '其他' }
  ];
  var PICKER_TAGS = { pro: 1, flash: 1, chat: 1, reasoner: 1, free: 1, vision: 1 };

  function labelForModel(id) {
    var value = id == null ? '' : String(id);
    for (var i = 0; i < state.models.length; i++) {
      if (String(state.models[i].id) === value) return state.models[i].label;
    }
    return MODEL_LABELS[value] || value;
  }

  /* 顶栏副标题 / 设置页模型行统一显示 */
  function updateModelLabelUI() {
    var label = state.modelLabel || labelForModel(state.model);
    var subtitle = r('header-subtitle');
    if (subtitle && !state.subtitleOverride) subtitle.textContent = label;
    var rowLabel = r('set-model-label');
    if (rowLabel) rowLabel.textContent = label;
  }

  function normalizePickerModels(models) {
    var list = [];
    (Array.isArray(models) ? models : []).forEach(function (item) {
      if (!item) return;
      if (typeof item === 'string') {
        list.push({ id: item, label: item, series: '', tag: '', desc: '', fallback: false, custom: false, remote: false });
        return;
      }
      if (typeof item !== 'object') return;
      var id = item.id == null ? '' : String(item.id);
      if (!id) return;
      var series = item.series == null ? '' : String(item.series);
      list.push({
        id: id,
        label: item.label ? String(item.label) : id,
        series: series,
        tag: item.tag ? String(item.tag).toLowerCase() : '',
        desc: item.desc ? String(item.desc) : '',
        fallback: !!item.fallback,
        custom: !!(item.custom || series === '自定义'),
        remote: !!item.remote
      });
    });
    return list;
  }

  function pickerGroupKey(model) {
    if (!model) return '其他';
    if (model.custom || String(model.series || '') === '自定义') return '自定义';
    var match = /V(\d+)/i.exec(String(model.series || ''));
    if (match) return 'V' + match[1];
    return '其他';
  }

  function findPickerModel(id) {
    var value = id == null ? '' : String(id);
    for (var i = 0; i < state.modelPicker.models.length; i++) {
      if (String(state.modelPicker.models[i].id) === value) return state.modelPicker.models[i];
    }
    return null;
  }

  function pickerShowsRefresh() {
    if (typeof state.cb.onRefreshModels !== 'function') return false;
    var picker = state.modelPicker;
    if (picker.opts && (picker.opts.fallbackOnly || picker.opts.fallback || picker.opts.refreshable)) return true;
    if (!picker.models.length) return true;
    for (var i = 0; i < picker.models.length; i++) {
      if (picker.models[i].fallback) return true;
    }
    return false;
  }

  function buildModelPickerRow(model) {
    var picker = state.modelPicker;
    var current = String(model.id) === String(picker.currentId);
    var row = el('div', 'model-row' + (current ? ' is-current' : ''));
    row.setAttribute('data-action', 'pick-model');
    row.setAttribute('data-id', String(model.id));
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', current ? 'true' : 'false');
    row.setAttribute('tabindex', '0');

    var main = el('div', 'model-row-main');
    main.appendChild(makeText('div', 'model-row-label', model.label || model.id));
    main.appendChild(makeText('div', 'model-row-id', model.id));
    row.appendChild(main);

    if (model.tag) {
      var tagKey = PICKER_TAGS[model.tag] ? model.tag : '';
      row.appendChild(makeText('span', 'model-tag' + (tagKey ? ' model-tag--' + tagKey : ''), String(model.tag).toUpperCase()));
    }
    if (model.desc) row.title = String(model.desc);

    var customRow = model.custom || pickerGroupKey(model) === '自定义';
    if (customRow && typeof state.cb.onDeleteCustomModel === 'function') {
      var del = el('span', 'model-del');
      del.setAttribute('data-action', 'delete-custom-model');
      del.setAttribute('data-id', String(model.id));
      del.setAttribute('role', 'button');
      del.setAttribute('aria-label', '删除自定义模型');
      del.innerHTML = ICON.trash;
      row.appendChild(del);
    }
    if (current) {
      var check = el('span', 'model-check');
      check.innerHTML = ICON.check;
      row.appendChild(check);
    }
    return row;
  }

  function renderModelPickerList() {
    var listEl = r('model-picker-list');
    if (!listEl) return;
    var picker = state.modelPicker;
    listEl.textContent = '';
    var query = String(picker.query || '').trim().toLowerCase();
    var buckets = Object.create(null);
    PICKER_GROUPS.forEach(function (group) { buckets[group.key] = []; });

    picker.models.forEach(function (model) {
      if (query) {
        var hay = (String(model.label) + ' ' + String(model.id)).toLowerCase();
        if (hay.indexOf(query) === -1) return;
      }
      var key = pickerGroupKey(model);
      if (!buckets[key]) key = '其他';
      buckets[key].push(model);
    });

    var rendered = 0;
    PICKER_GROUPS.forEach(function (group) {
      var items = buckets[group.key];
      if (!items || !items.length) return;
      rendered += items.length;
      var wrapper = el('div', 'picker-group');
      wrapper.appendChild(makeText('div', 'picker-group-title', group.title));
      items.forEach(function (model) { wrapper.appendChild(buildModelPickerRow(model)); });
      listEl.appendChild(wrapper);
    });

    if (!rendered) {
      listEl.appendChild(makeText('div', 'picker-empty', query ? '没有找到匹配的模型' : '暂无可用模型'));
    }
    var refresh = r('model-picker-refresh');
    if (refresh) refresh.hidden = !pickerShowsRefresh();
  }

  function openModelPickerPanel(models, currentId, onPick, opts) {
    var picker = state.modelPicker;
    if (picker.refreshTimer) {
      clearTimeout(picker.refreshTimer);
      picker.refreshTimer = 0;
    }
    picker.models = normalizePickerModels(models);
    picker.currentId = currentId == null ? state.model : String(currentId);
    picker.onPick = typeof onPick === 'function' ? onPick : null;
    picker.opts = opts && typeof opts === 'object' ? opts : {};
    picker.query = '';
    picker.resolved = false;
    picker.customOpen = false;
    picker.open = true;

    /* 当前模型不在目录中时补一条并选中（app.js 一般已补，这里兜底） */
    if (picker.currentId && !findPickerModel(picker.currentId)) {
      picker.models.unshift({
        id: picker.currentId,
        label: state.modelLabel || picker.currentId,
        series: '自定义',
        tag: '',
        desc: '',
        fallback: false,
        custom: true,
        remote: false
      });
    }

    var search = r('model-picker-search');
    if (search) search.value = '';
    var clearBtn = r('model-picker-search-clear');
    if (clearBtn) clearBtn.hidden = true;
    var customWrap = r('model-picker-custom');
    if (customWrap) customWrap.hidden = true;
    var customInput = r('model-picker-custom-input');
    if (customInput) customInput.value = '';
    var toggle = document.querySelector('[data-action="toggle-custom-model"]');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    var refreshLabel = r('model-picker-refresh-label');
    if (refreshLabel) refreshLabel.textContent = '从 API 获取模型列表';
    var refreshBtn = r('model-picker-refresh');
    if (refreshBtn) refreshBtn.disabled = false;

    renderModelPickerList();

    var panel = r('model-picker');
    if (panel) {
      var sheet = panel.querySelector('.model-picker-sheet');
      if (sheet) sheet.style.transform = '';
      panel.classList.add('is-open');
      panel.setAttribute('aria-hidden', 'false');
    }
    var listEl = r('model-picker-list');
    if (listEl) listEl.scrollTop = 0;
    syncDepth();
  }

  function closeModelPickerPanel(notify) {
    var picker = state.modelPicker;
    if (picker.refreshTimer) {
      clearTimeout(picker.refreshTimer);
      picker.refreshTimer = 0;
    }
    if (!picker.open) return;
    picker.open = false;
    var panel = r('model-picker');
    if (panel) {
      panel.classList.remove('is-open');
      panel.setAttribute('aria-hidden', 'true');
      var sheet = panel.querySelector('.model-picker-sheet');
      if (sheet) sheet.style.transform = '';
    }
    var callback = picker.onPick;
    var notifyCallback = notify && !picker.resolved && typeof callback === 'function' ? callback : null;
    picker.onPick = null;
    picker.resolved = false;
    picker.models = [];
    syncDepth();
    if (notifyCallback) {
      try { notifyCallback(null); } catch (err) { console.warn('[UI] 模型选择器 onPick(null) 回调异常:', err); }
    }
  }

  function syncHiddenModelSelect(id) {
    var select = r('set-model');
    if (!select || id == null) return;
    var value = String(id);
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].value === value) { select.value = value; return; }
    }
  }

  function pickModel(id) {
    var value = id == null ? '' : String(id).trim();
    if (!value) return;
    var picker = state.modelPicker;
    if (!picker.open) return;
    var callback = picker.onPick;
    var selected = findPickerModel(value);
    picker.resolved = true;
    closeModelPickerPanel(false);
    state.model = value;
    state.modelLabel = selected ? (selected.label || value) : (state.modelLabel || value);
    state.modelLabelId = value;
    updateModelLabelUI();
    syncHiddenModelSelect(value);
    if (typeof callback === 'function') {
      try { callback(value); } catch (err) { console.warn('[UI] 模型选择回调异常:', err); }
    } else if (!invoke('onSelectModel', value)) {
      /* 没有回调时保持 UI 乐观更新即可 */
    }
  }

  function requestModelPicker() {
    if (invoke('onOpenModelPicker')) return;
    if (!state.models.length) return;
    openModelPickerPanel(
      state.models.map(function (model) {
        return { id: model.id, label: model.label, series: model.series || '', tag: model.tag || '' };
      }),
      state.model,
      function (id) { if (id) invoke('onSelectModel', id); }
    );
  }

  function toggleCustomModel() {
    var picker = state.modelPicker;
    if (!picker.open) return;
    picker.customOpen = !picker.customOpen;
    var wrap = r('model-picker-custom');
    if (wrap) wrap.hidden = !picker.customOpen;
    var toggle = document.querySelector('[data-action="toggle-custom-model"]');
    if (toggle) toggle.setAttribute('aria-expanded', picker.customOpen ? 'true' : 'false');
    if (picker.customOpen) {
      var input = r('model-picker-custom-input');
      setTimeout(function () {
        if (input) { try { input.focus(); } catch (err) { /* 静默 */ } }
      }, 60);
    }
  }

  function addCustomModel() {
    var input = r('model-picker-custom-input');
    var value = input ? String(input.value || '').trim() : '';
    if (!value) {
      UI.toast('请输入模型 ID');
      if (input) { try { input.focus(); } catch (err) { /* 静默 */ } }
      return;
    }
    pickModel(value);
  }

  function deleteCustomModel(id) {
    if (!id) return;
    if (!invoke('onDeleteCustomModel', id)) return;
    state.modelPicker.models = state.modelPicker.models.filter(function (model) {
      return String(model.id) !== String(id);
    });
    renderModelPickerList();
  }

  function refreshModelPicker() {
    var picker = state.modelPicker;
    if (!picker.open) return;
    var button = r('model-picker-refresh');
    var label = r('model-picker-refresh-label');
    if (button) button.disabled = true;
    if (label) label.textContent = '获取中…';
    if (picker.refreshTimer) clearTimeout(picker.refreshTimer);
    picker.refreshTimer = setTimeout(function () {
      var btn = r('model-picker-refresh');
      var lbl = r('model-picker-refresh-label');
      if (btn) btn.disabled = false;
      if (lbl) lbl.textContent = '从 API 获取模型列表';
    }, 4000);
    if (!invoke('onRefreshModels')) {
      if (button) button.disabled = false;
      if (label) label.textContent = '从 API 获取模型列表';
    }
  }

  function clearModelPickerSearch() {
    var input = r('model-picker-search');
    if (input) input.value = '';
    state.modelPicker.query = '';
    var clearBtn = r('model-picker-search-clear');
    if (clearBtn) clearBtn.hidden = true;
    renderModelPickerList();
    if (input) { try { input.focus(); } catch (err) { /* 静默 */ } }
  }

  function bindModelPickerEvents() {
    var panel = r('model-picker');
    if (!panel) return;
    panel.addEventListener('click', function (event) {
      if (event.target === panel) closeModelPickerPanel(true);
    });
    var sheet = panel.querySelector('.model-picker-sheet');
    var handle = r('model-picker-handle');
    if (!sheet || !handle) return;
    var startY = 0;
    var delta = 0;
    var dragging = false;
    handle.addEventListener('pointerdown', function (event) {
      dragging = true;
      startY = event.clientY;
      delta = 0;
      sheet.style.transition = 'none';
      try {
        if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
      } catch (err) { /* 静默 */ }
    });
    handle.addEventListener('pointermove', function (event) {
      if (!dragging) return;
      delta = Math.max(0, event.clientY - startY);
      sheet.style.transform = 'translateY(' + delta + 'px)';
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (delta > 90) closeModelPickerPanel(true);
      delta = 0;
    }
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }

  /* ------------------------------------------------------------------ *
   * 智能体预设（SPEC v2.0 F1）
   * - openAgentPicker：底部弹层（默认会话 + 预设列表 + 管理预设按钮）
   * - renderAgents：设置页「智能体预设」管理列表
   * - 新建 / 编辑：连续两次 UI.prompt 收集「名称」「系统提示词」
   * ------------------------------------------------------------------ */
  var AGENT_DEFAULT_DESC = '使用全局系统提示词与当前模型';
  var AGENT_DESC_MAX = 40;

  function normalizeAgents(agents) {
    var list = [];
    (Array.isArray(agents) ? agents : []).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var id = item.id == null ? '' : String(item.id);
      if (!id) return;
      list.push({
        id: id,
        name: item.name ? String(item.name) : id,
        description: item.description ? String(item.description) : '',
        systemPrompt: item.systemPrompt == null ? '' : String(item.systemPrompt),
        model: item.model == null ? '' : String(item.model),
        builtin: !!item.builtin
      });
    });
    return list;
  }

  function normalizeAgentDesc(text) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > AGENT_DESC_MAX ? s.slice(0, AGENT_DESC_MAX - 1) + '…' : s;
  }

  function findAgent(id) {
    var value = id == null ? '' : String(id);
    for (var i = 0; i < state.agents.length; i++) {
      if (String(state.agents[i].id) === value) return state.agents[i];
    }
    return null;
  }

  function agentDefaultLabel() {
    var opts = state.agentPicker.opts || {};
    return opts.defaultLabel ? String(opts.defaultLabel) : '默认会话';
  }

  function makeAgentAvatar() {
    var img = document.createElement('img');
    img.className = 'agent-avatar';
    img.src = 'img/agent-avatar.jpg';
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    return img;
  }

  function buildAgentPickerRow(agent, isDefault) {
    var picker = state.agentPicker;
    var id = isDefault ? '' : String(agent.id);
    var current = String(id) === String(picker.currentId || '');
    var row = el('div', 'model-row agent-row' + (current ? ' is-current' : ''));
    row.setAttribute('data-action', 'pick-agent');
    row.setAttribute('data-id', id);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', current ? 'true' : 'false');
    row.setAttribute('tabindex', '0');

    row.appendChild(makeAgentAvatar());

    var main = el('div', 'agent-row-main');
    var name = isDefault ? agentDefaultLabel() : (agent.name || agent.id);
    main.appendChild(makeText('div', 'agent-row-name', name));
    var desc = isDefault
      ? ((picker.opts && picker.opts.defaultDesc) ? String(picker.opts.defaultDesc) : AGENT_DEFAULT_DESC)
      : (agent.description || normalizeAgentDesc(agent.systemPrompt) || '自定义智能体');
    main.appendChild(makeText('div', 'agent-row-desc', desc));
    row.appendChild(main);

    if (isDefault) row.appendChild(makeText('span', 'agent-tag', '默认'));
    else if (agent.builtin) row.appendChild(makeText('span', 'agent-tag', '内置'));

    if (current) {
      var check = el('span', 'agent-row-check');
      check.innerHTML = ICON.check;
      row.appendChild(check);
    }
    return row;
  }

  function renderAgentPickerList() {
    var listEl = r('agent-picker-list');
    if (!listEl) return;
    var picker = state.agentPicker;
    listEl.textContent = '';
    listEl.appendChild(buildAgentPickerRow({ id: '', name: agentDefaultLabel() }, true));
    if (!picker.agents.length) {
      listEl.appendChild(makeText('div', 'picker-empty', '还没有智能体预设，点下方「管理预设」新建'));
      return;
    }
    var wrapper = el('div', 'picker-group');
    wrapper.appendChild(makeText('div', 'picker-group-title', '预设智能体'));
    picker.agents.forEach(function (agent) {
      wrapper.appendChild(buildAgentPickerRow(agent, false));
    });
    listEl.appendChild(wrapper);
  }

  function openAgentPickerPanel(agents, currentId, onPick, opts) {
    var picker = state.agentPicker;
    if (state.modelPicker.open) closeModelPickerPanel(false);
    picker.agents = normalizeAgents(agents);
    picker.currentId = currentId == null ? '' : String(currentId);
    picker.onPick = typeof onPick === 'function' ? onPick : null;
    picker.opts = opts && typeof opts === 'object' ? opts : {};
    picker.resolved = false;
    picker.open = true;

    renderAgentPickerList();

    var panel = r('agent-picker');
    if (panel) {
      var sheet = panel.querySelector('.model-picker-sheet');
      if (sheet) sheet.style.transform = '';
      panel.classList.add('is-open');
      panel.setAttribute('aria-hidden', 'false');
    }
    var listEl = r('agent-picker-list');
    if (listEl) listEl.scrollTop = 0;
    syncDepth();
  }

  function closeAgentPickerPanel(notify) {
    var picker = state.agentPicker;
    if (!picker.open) return;
    picker.open = false;
    var panel = r('agent-picker');
    if (panel) {
      panel.classList.remove('is-open');
      panel.setAttribute('aria-hidden', 'true');
      var sheet = panel.querySelector('.model-picker-sheet');
      if (sheet) sheet.style.transform = '';
    }
    var callback = picker.onPick;
    var notifyCallback = notify && !picker.resolved && typeof callback === 'function' ? callback : null;
    picker.onPick = null;
    picker.resolved = false;
    picker.agents = [];
    syncDepth();
    if (notifyCallback) {
      try { notifyCallback(null); } catch (err) { console.warn('[UI] 智能体选择器 onPick(null) 回调异常:', err); }
    }
  }

  function pickAgent(id) {
    var value = id == null ? '' : String(id);
    var picker = state.agentPicker;
    if (!picker.open) return;
    var callback = picker.onPick;
    picker.resolved = true;
    closeAgentPickerPanel(false);
    if (typeof callback === 'function') {
      try { callback(value); } catch (err) { console.warn('[UI] 智能体选择回调异常:', err); }
    } else {
      invoke('onPickAgent', value);
    }
  }

  function manageAgentsFromPicker() {
    var opts = state.agentPicker.opts || {};
    var manage = typeof opts.manage === 'function' ? opts.manage : null;
    closeAgentPickerPanel(false);
    if (manage) {
      try { manage(); } catch (err) { console.warn('[UI] 管理预设回调异常:', err); }
      return;
    }
    if (invoke('onManageAgents')) return;
    openAgentsPage();
  }

  function renderAgentsList() {
    var list = r('agents-list');
    if (list) {
      list.textContent = '';
      state.agents.forEach(function (agent) {
        var item = el('div', 'agent-item');
        item.setAttribute('data-agent-id', String(agent.id));
        item.appendChild(makeAgentAvatar());

        var body = el('div', 'agent-item-body');
        var nameRow = el('div', 'agent-item-name');
        nameRow.appendChild(makeText('span', '', agent.name || agent.id));
        if (agent.builtin) nameRow.appendChild(makeText('span', 'agent-tag', '内置'));
        body.appendChild(nameRow);
        body.appendChild(makeText('div', 'agent-item-desc',
          agent.description || normalizeAgentDesc(agent.systemPrompt) || '未填写简介'));
        item.appendChild(body);

        var actions = el('div', 'agent-item-actions');
        var edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'agent-mini-btn';
        edit.setAttribute('data-action', 'edit-agent');
        edit.setAttribute('data-id', String(agent.id));
        edit.textContent = '编辑';
        actions.appendChild(edit);

        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'agent-mini-btn agent-mini-btn--danger';
        remove.setAttribute('data-action', 'delete-agent');
        remove.setAttribute('data-id', String(agent.id));
        remove.textContent = '删除';
        actions.appendChild(remove);

        item.appendChild(actions);
        list.appendChild(item);
      });
    }

    var empty = r('agents-empty');
    if (empty) empty.hidden = state.agents.length > 0;

    var count = r('agents-count');
    if (count) {
      var builtin = state.agents.filter(function (agent) { return !!agent.builtin; }).length;
      count.textContent = state.agents.length
        ? state.agents.length + ' 个预设' + (builtin ? ' · 内置 ' + builtin + ' 个' : '')
        : '内置与自定义预设';
    }
    var settingsLabel = r('set-agents-label');
    if (settingsLabel) settingsLabel.textContent = state.agents.length ? state.agents.length + ' 个' : '管理';
  }

  function renderAgents(agents) {
    state.agents = normalizeAgents(agents);
    renderAgentsList();
  }

  function openAgentsPage() {
    closeDrawer();
    if (invoke('onOpenAgents')) return;
    /* app.js 未接管时：直接用缓存数据打开管理页，保证 UI 可独立浏览 */
    showScreenImpl('agents');
    renderAgentsList();
  }

  function genAgentId() {
    return 'agent-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function upsertAgentLocal(agent) {
    var id = agent.id ? String(agent.id) : genAgentId();
    var entry = {
      id: id,
      name: String(agent.name || ''),
      description: agent.description || normalizeAgentDesc(agent.systemPrompt),
      systemPrompt: agent.systemPrompt == null ? '' : String(agent.systemPrompt),
      model: agent.model == null ? '' : String(agent.model),
      builtin: !!agent.builtin
    };
    var replaced = false;
    state.agents = state.agents.map(function (item) {
      if (String(item.id) !== id) return item;
      replaced = true;
      return {
        id: id,
        name: entry.name,
        description: entry.description,
        systemPrompt: entry.systemPrompt,
        model: entry.model,
        builtin: item.builtin || entry.builtin
      };
    });
    if (!replaced) state.agents.push(entry);
    return entry;
  }

  function saveAgent(agent) {
    agent = agent || {};
    var payload = {
      id: agent.id ? String(agent.id) : '',
      name: String(agent.name || '').trim(),
      description: agent.description == null ? '' : String(agent.description),
      systemPrompt: agent.systemPrompt == null ? '' : String(agent.systemPrompt),
      model: agent.model == null ? '' : String(agent.model)
    };
    if (!payload.name) { UI.toast('名称不能为空'); return; }
    if (!payload.description) payload.description = normalizeAgentDesc(payload.systemPrompt);
    var handled = invoke('onSaveAgent', payload);
    if (!handled) {
      /* app.js 未接管时本地乐观更新，保证管理页可用 */
      upsertAgentLocal(payload);
      renderAgentsList();
      UI.toast(payload.id ? '预设已更新' : '预设已创建');
    }
    /* app.js 接管时会持久化并调用 UI.renderAgents 刷新列表（含新 id） */
    return payload;
  }

  function newAgentFlow() {
    UI.prompt('智能体名称', '', '例如：程序员').then(function (name) {
      if (name == null) return;
      var title = String(name).trim();
      if (!title) { UI.toast('名称不能为空'); return; }
      UI.prompt('系统提示词', '', '例如：你是一名资深工程师，回答尽量给出可运行代码…').then(function (systemPrompt) {
        if (systemPrompt == null) return;
        var prompt = String(systemPrompt);
        saveAgent({ id: '', name: title, description: normalizeAgentDesc(prompt), systemPrompt: prompt });
      });
    });
  }

  function editAgentFlow(id) {
    var agent = findAgent(id);
    if (!agent) return;
    UI.prompt('智能体名称', agent.name, '例如：程序员').then(function (name) {
      if (name == null) return;
      var title = String(name).trim();
      if (!title) { UI.toast('名称不能为空'); return; }
      UI.prompt('系统提示词', agent.systemPrompt, '该预设的系统提示词').then(function (systemPrompt) {
        if (systemPrompt == null) return;
        var prompt = String(systemPrompt);
        var oldDesc = agent.description ? String(agent.description) : '';
        var autoDesc = !oldDesc || oldDesc === normalizeAgentDesc(agent.systemPrompt);
        saveAgent({
          id: agent.id,
          name: title,
          description: autoDesc ? normalizeAgentDesc(prompt) : oldDesc,
          systemPrompt: prompt,
          model: agent.model,
          builtin: agent.builtin
        });
      });
    });
  }

  function deleteAgentFlow(id) {
    var agent = findAgent(id);
    if (!agent) return;
    var name = agent.name ? '「' + agent.name + '」' : '该预设';
    confirmDialog('删除预设', '确定删除' + name + '吗？删除后新建会话时将不再显示。').then(function (ok) {
      if (!ok) return;
      var handled = invoke('onDeleteAgent', agent.id);
      if (!handled) {
        state.agents = state.agents.filter(function (item) {
          return String(item.id) !== String(agent.id);
        });
        renderAgentsList();
        UI.toast('预设已删除');
      }
      /* app.js 接管时会持久化并刷新列表（内置预设会提示不可删除） */
    });
  }

  function bindAgentPickerEvents() {
    var panel = r('agent-picker');
    if (!panel) return;
    panel.addEventListener('click', function (event) {
      if (event.target === panel) closeAgentPickerPanel(true);
    });
    var sheet = panel.querySelector('.model-picker-sheet');
    var handle = r('agent-picker-handle');
    if (!sheet || !handle) return;
    var startY = 0;
    var delta = 0;
    var dragging = false;
    handle.addEventListener('pointerdown', function (event) {
      dragging = true;
      startY = event.clientY;
      delta = 0;
      sheet.style.transition = 'none';
      try {
        if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
      } catch (err) { /* 静默 */ }
    });
    handle.addEventListener('pointermove', function (event) {
      if (!dragging) return;
      delta = Math.max(0, event.clientY - startY);
      sheet.style.transform = 'translateY(' + delta + 'px)';
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (delta > 90) closeAgentPickerPanel(true);
      delta = 0;
    }
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }

  /* ------------------------------------------------------------------ *
   * 剪贴板 / 外链（只作为回调缺失时的兜底，全部 try/catch）
   * ------------------------------------------------------------------ */
  function normalizeClipText(value) {
    if (value == null) return '';
    var text = String(value);
    if (/^\s*[{[]/.test(text) && text.length < 20000) {
      try {
        var parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          return String(parsed.text || parsed.value || parsed.data || '');
        }
      } catch (err) { /* 普通文本 */ }
    }
    return text;
  }

  function readClipboard(done) {
    var B = window.Bridge;
    function finish(value) {
      if (value && typeof value.then === 'function') {
        value.then(function (t) { done(normalizeClipText(t)); }, function () { done(''); });
        return;
      }
      done(normalizeClipText(value));
    }
    try {
      if (B) {
        if (typeof B.getClipboard === 'function') { finish(B.getClipboard()); return; }
        if (typeof B.clipboard === 'function') { finish(B.clipboard('get')); return; }
        if (B.clipboard && typeof B.clipboard.get === 'function') { finish(B.clipboard.get()); return; }
      }
    } catch (err) { /* fallthrough */ }
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      navigator.clipboard.readText().then(function (t) { done(normalizeClipText(t)); }, function () { done(''); });
      return;
    }
    done('');
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      document.execCommand('copy');
      document.body.removeChild(ta);
      UI.toast('已复制');
    } catch (err) {
      /* 静默失败 */
    }
  }

  function copyText(text) {
    var value = String(text == null ? '' : text);
    if (!value) return;
    if (invoke('onCopy', value)) return;
    var U = window.Util;
    if (U && typeof U.copyText === 'function') {
      try { U.copyText(value); return; } catch (err) { /* fallthrough */ }
    }
    var B = window.Bridge;
    try {
      if (B) {
        if (typeof B.setClipboard === 'function') { B.setClipboard(value); return; }
        if (B.clipboard && typeof B.clipboard.set === 'function') { B.clipboard.set(value); return; }
        if (typeof B.clipboard === 'function') { B.clipboard('set', value); return; }
      }
    } catch (err) { /* fallthrough */ }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(value).then(function () { UI.toast('已复制'); }, function () { legacyCopy(value); });
      return;
    }
    legacyCopy(value);
  }

  function openExternal(url) {
    var B = window.Bridge;
    if (B && typeof B.openUrl === 'function') {
      try { B.openUrl(url); return; } catch (err) { /* fallthrough */ }
    }
    try { window.location.href = url; } catch (err) { /* 静默 */ }
  }

  /* ------------------------------------------------------------------ *
   * 顶栏 / 深度（与 app.js 的 setBackDepth 层级协作）
   * ------------------------------------------------------------------ */
  function syncDepth() {
    var base;
    if (state.screen === 'chats') base = 0;
    else if (state.screen === 'chat') base = 1;
    else if (state.screen === 'settings' || state.screen === 'plugins' || state.screen === 'agents' ||
             state.screen === 'audit' || state.screen === 'mcp' || state.screen === 'market' ||
             state.screen === 'memory' || state.screen === 'trace' || state.screen === 'cost' ||
             state.screen === 'tool-policy' || state.screen === 'snapshots' ||
             state.screen === 'appearance' || state.screen === 'bots') base = 2;
    else return; /* login 由 app.js 决定 */
    var overlay = state.drawerOpen || state.menuOpen || state.modelPicker.open ||
      state.agentPicker.open || state.fileDrawer.open || state.pluginPanelOpen || state.buildPanelOpen ||
      state.slash.open ||
      isModalOpen(r('install-modal')) || isModalOpen(r('confirm-modal')) || isModalOpen(r('rename-modal')) ||
      isModalOpen(r('risk-modal')) || isModalOpen(r('backup-modal')) || isModalOpen(r('file-preview-modal')) ||
      isModalOpen(r('mcp-form-modal')) || isModalOpen(r('memory-item-modal')) ||
      isModalOpen(r('attachment-sheet')) || isModalOpen(r('image-viewer')) ||
      isModalOpen(r('pin-modal')) || isModalOpen(r('pin-setup-modal')) || isModalOpen(r('password-modal')) ||
      isModalOpen(r('edit-message-modal')) || isModalOpen(r('market-detail-modal')) ||
      isModalOpen(r('market-url-install-modal')) || isModalOpen(r('market-code-modal')) ||
      isModalOpen(r('bot-form-modal')) || isModalOpen(r('bot-detail-modal'));
    var B = window.Bridge;
    if (B && typeof B.setBackDepth === 'function') {
      try { B.setBackDepth(base + (overlay ? 1 : 0)); } catch (err) { /* 静默 */ }
    }
  }

  /* ------------------------------------------------------------------ *
   * 弹窗基础
   * ------------------------------------------------------------------ */
  function isModalOpen(node) {
    return !!(node && node.classList && node.classList.contains('is-open'));
  }

  function openModal(node) {
    if (!node) return;
    node.classList.add('is-open');
    node.setAttribute('aria-hidden', 'false');
    syncDepth();
  }

  function closeModal(node) {
    if (!node) return;
    node.classList.remove('is-open');
    node.setAttribute('aria-hidden', 'true');
    syncDepth();
  }

  function closeAllModals() {
    if (isModalOpen(r('confirm-modal'))) resolveConfirm(false);
    if (isModalOpen(r('rename-modal'))) resolveRename(null);
    if (isModalOpen(r('risk-modal'))) resolveRisk(false);
    if (isModalOpen(r('pin-modal'))) resolvePin(false);
    if (isModalOpen(r('pin-setup-modal'))) closePinSetup();
    if (isModalOpen(r('password-modal'))) resolvePassword(null);
    if (isModalOpen(r('edit-message-modal'))) closeEditMessage();
    ['install-modal', 'confirm-modal', 'rename-modal', 'risk-modal', 'backup-modal', 'file-preview-modal',
      'mcp-form-modal', 'memory-item-modal', 'pin-modal', 'pin-setup-modal', 'password-modal',
      'edit-message-modal', 'market-detail-modal', 'market-url-install-modal', 'market-code-modal',
      'bot-form-modal', 'bot-detail-modal'].forEach(function (id) {
      closeModal(document.getElementById(id));
    });
  }

  function resolveConfirm(value) {
    closeModal(r('confirm-modal'));
    var resolve = state.confirmResolve;
    state.confirmResolve = null;
    if (typeof resolve === 'function') resolve(!!value);
  }

  function resolveRename(value) {
    closeModal(r('rename-modal'));
    var resolve = state.renameResolve;
    state.renameResolve = null;
    if (typeof resolve === 'function') resolve(value);
  }

  function confirmDialog(title, text) {
    if (state.confirmResolve) resolveConfirm(false);
    if (state.screen === 'chat' && state.drawerOpen) closeDrawer();
    var titleEl = r('confirm-title');
    var textEl = r('confirm-text');
    if (titleEl) titleEl.textContent = title == null ? '确认' : String(title);
    if (textEl) textEl.textContent = text == null ? '' : String(text);
    openModal(r('confirm-modal'));
    return new Promise(function (resolve) {
      state.confirmResolve = resolve;
    });
  }

  function promptRename(initial) {
    return inputDialog('重命名会话', initial, '会话标题');
  }

  /* 通用文本输入对话框：供重命名与 app.js 的 promptAsync 使用 */
  function inputDialog(title, value, placeholder) {
    if (state.renameResolve) resolveRename(null);
    if (state.screen === 'chat' && state.drawerOpen) closeDrawer();
    var titleEl = r('rename-title');
    var input = r('rename-input');
    if (titleEl) titleEl.textContent = title == null || title === '' ? '请输入' : String(title);
    if (input) {
      input.value = value == null ? '' : String(value);
      input.placeholder = placeholder == null || placeholder === '' ? '请输入' : String(placeholder);
    }
    openModal(r('rename-modal'));
    setTimeout(function () {
      if (!input) return;
      try {
        input.focus();
        input.select();
      } catch (err) { /* 静默 */ }
    }, 80);
    return new Promise(function (resolve) {
      state.renameResolve = resolve;
    });
  }

  function commitRename() {
    var input = r('rename-input');
    if (!input) { resolveRename(null); return; }
    var title = String(input.value || '').trim();
    if (!title) {
      try { input.focus(); } catch (err) { /* 静默 */ }
      return;
    }
    resolveRename(title);
  }

  /* ================================================================== *
   * ARCH v2 P1：工作区文件树抽屉
   * ================================================================== */
  function updateWorkspaceDom() {
    var ws = state.workspace;
    var root = ws.root || '';
    var rootEl = r('file-root');
    if (rootEl) {
      rootEl.textContent = root || '未设置工作区';
      rootEl.title = root;
    }
    var valueEl = r('set-workspace-value');
    if (valueEl) {
      valueEl.textContent = root || '未设置';
      valueEl.title = root;
    }
    var writableEl = r('set-workspace-writable');
    if (writableEl) {
      var text = '未知';
      if (root) {
        if (!ws.writable) text = '只读';
        else text = ws.allFilesAccess ? '可读写 · 全部文件访问' : '可读写';
      }
      writableEl.textContent = text;
      writableEl.classList.toggle('is-readonly', !!root && !ws.writable);
    }
    var accessEl = r('set-workspace-access');
    if (accessEl) {
      var accessText = '未知';
      if (root) {
        if (ws.allFilesAccess) accessText = '已授权（可访问所有文件）';
        else if (ws.isDefault === false) accessText = '需要授予所有文件访问权限';
        else accessText = '应用私有目录（无需额外权限）';
      }
      accessEl.textContent = accessText;
      accessEl.classList.toggle('is-warn', !!root && ws.isDefault === false && !ws.allFilesAccess);
    }
    /* 非默认工作区时提供「恢复默认工作区」入口 */
    var resetRow = r('set-workspace-reset');
    if (resetRow) {
      var canReset = !!root && ws.isDefault === false;
      resetRow.hidden = !canReset;
      var resetHint = r('set-workspace-reset-hint');
      if (resetHint && ws.defaultRoot) resetHint.textContent = ws.defaultRoot;
    }
  }

  function setWorkspaceInfo(info) {
    var data = info && typeof info === 'object' ? info : {};
    var ws = state.workspace;
    if (data.root != null) {
      ws.root = String(data.root);
      state.fileDrawer.root = ws.root;
    }
    if (Object.prototype.hasOwnProperty.call(data, 'writable')) ws.writable = !!data.writable;
    if (Object.prototype.hasOwnProperty.call(data, 'allFilesAccess')) ws.allFilesAccess = !!data.allFilesAccess;
    if (Object.prototype.hasOwnProperty.call(data, 'defaultRoot')) ws.defaultRoot = data.defaultRoot == null ? '' : String(data.defaultRoot);
    if (Object.prototype.hasOwnProperty.call(data, 'isDefault')) ws.isDefault = !!data.isDefault;
    ws.loaded = true;
    updateWorkspaceDom();
    return {
      root: ws.root,
      writable: ws.writable,
      allFilesAccess: ws.allFilesAccess,
      defaultRoot: ws.defaultRoot || '',
      isDefault: ws.isDefault === true
    };
  }

  function normalizeFileEntries(entries) {
    var out = [];
    (Array.isArray(entries) ? entries : []).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var path = item.path == null ? '' : String(item.path);
      var name = item.name == null ? '' : String(item.name);
      if (!name && path) {
        var parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
        name = parts.length ? parts[parts.length - 1] : path;
      }
      if (!name) return;
      out.push({
        name: name,
        path: path,
        isDir: item.isDir === true || item.isDir === 'true' || item.dir === true,
        size: Number(item.size) || 0,
        depth: typeof item.depth === 'number' && isFinite(item.depth) ? item.depth : null
      });
    });
    out.sort(function (a, b) {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    });
    return out;
  }

  function fileDepth(entry) {
    if (entry.depth != null) return Math.max(0, entry.depth);
    var base = String(state.fileDrawer.path || state.fileDrawer.root || '');
    var path = String(entry.path || '');
    var rel = path;
    if (base && path.indexOf(base) === 0) rel = path.slice(base.length);
    rel = rel.replace(/^[\\/]+/, '');
    if (!rel) return 0;
    var parts = rel.split(/[\\/]+/).filter(Boolean);
    return Math.max(0, parts.length - 1);
  }

  function fileSizeText(size) {
    var value = Number(size) || 0;
    if (value <= 0) return '';
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10240 ? 1 : 0) + ' KB';
    return (value / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function joinPath(base, name) {
    var root = String(base || '');
    var leaf = String(name || '');
    if (!root) return leaf;
    if (root.charAt(root.length - 1) === '/') return root + leaf;
    return root + '/' + leaf;
  }

  function renderFileCrumbs() {
    var box = r('file-crumbs');
    if (!box) return;
    box.textContent = '';
    var data = state.fileDrawer;
    var root = String(data.root || state.workspace.root || '');
    var current = String(data.path || root || '');
    var parts = root ? root.replace(/\\/g, '/').split('/').filter(Boolean) : [];

    function addCrumb(label, path, isCurrent) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'file-crumb' + (isCurrent ? ' is-current' : '');
      btn.setAttribute('data-action', 'file-crumb');
      btn.setAttribute('data-path', String(path));
      btn.setAttribute('aria-current', isCurrent ? 'true' : 'false');
      btn.textContent = label;
      box.appendChild(btn);
    }

    function addSeparator() {
      box.appendChild(makeText('span', 'file-crumb-sep', '/'));
    }

    if (!root) {
      addCrumb('工作区', '', true);
      return;
    }

    addCrumb(parts.length ? parts[parts.length - 1] : '工作区', root, current === root);
    if (current && current !== root && current.indexOf(root) === 0) {
      var rel = current.slice(root.length).replace(/^[\\/]+/, '');
      var segs = rel.split(/[\\/]+/).filter(Boolean);
      var acc = root;
      segs.forEach(function (seg) {
        acc = joinPath(acc, seg);
        addSeparator();
        addCrumb(seg, acc, acc === current);
      });
    }
  }

  function buildFileNodeEl(entry) {
    var node = document.createElement('button');
    node.type = 'button';
    node.className = 'file-node ' + (entry.isDir ? 'file-node--dir' : 'file-node--file');
    node.setAttribute('data-action', 'file-node');
    node.setAttribute('data-path', entry.path);
    node.setAttribute('data-dir', entry.isDir ? '1' : '0');
    node.setAttribute('role', 'listitem');
    node.style.paddingLeft = (10 + Math.min(fileDepth(entry), 6) * 14) + 'px';

    var icon = el('span', 'file-node-icon');
    icon.innerHTML = entry.isDir ? ICON.folder : ICON.file;
    node.appendChild(icon);
    node.appendChild(makeText('span', 'file-node-name', entry.name));
    var size = fileSizeText(entry.size);
    if (!entry.isDir && size) node.appendChild(makeText('span', 'file-node-size', size));
    return node;
  }

  function fillFileTreeBox(box, entries, errorText) {
    if (!box) return;
    box.textContent = '';
    if (errorText) {
      box.appendChild(makeText('div', 'file-empty file-empty--error', '目录读取失败：' + errorText));
      return;
    }
    if (!entries.length) {
      box.appendChild(makeText('div', 'file-empty', '空目录'));
      return;
    }
    entries.forEach(function (entry) {
      box.appendChild(buildFileNodeEl(entry));
    });
  }

  function renderFileTree(entries, opts) {
    var data = state.fileDrawer;
    var options = {};
    if (typeof opts === 'string') options.path = opts;
    else if (opts && typeof opts === 'object') options = opts;

    /* listDir 失败时原生返回 {"error":".."}：渲染为错误行 */
    var errorText = '';
    if (!Array.isArray(entries)) {
      if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
        errorText = entries.error == null ? '' : String(entries.error);
        if (!errorText && entries.message != null) errorText = String(entries.message);
      } else if (typeof entries === 'string' && entries) {
        errorText = entries;
      }
    }

    if (options.root != null && String(options.root) !== '') {
      state.workspace.root = String(options.root);
      data.root = state.workspace.root;
      updateWorkspaceDom();
    }
    if (options.path != null) data.path = String(options.path);
    data.entries = normalizeFileEntries(Array.isArray(entries) ? entries : []);
    data.loading = false;

    var box = r('file-tree');
    if (box) {
      box.textContent = '';
      if (errorText) {
        var errorRow = el('div', 'file-empty file-empty--error');
        errorRow.id = 'file-empty';
        errorRow.textContent = '目录读取失败：' + errorText;
        state.refs['file-empty'] = errorRow;
        box.appendChild(errorRow);
      } else if (!data.entries.length) {
        var empty = el('div', 'file-empty');
        empty.id = 'file-empty';
        empty.textContent = '空目录';
        state.refs['file-empty'] = empty;
        box.appendChild(empty);
      } else {
        data.entries.forEach(function (entry) { box.appendChild(buildFileNodeEl(entry)); });
      }
    }

    /* ARCH v2 P4：工作台左栏复用同一份目录数据 */
    fillFileTreeBox(r('workbench-tree'), data.entries, errorText);
    updateWorkbenchPath();

    renderFileCrumbs();
    var foot = r('file-foot');
    if (foot) {
      if (errorText) foot.textContent = '目录读取失败';
      else if (data.entries.length) foot.textContent = data.entries.length + ' 项 · 点击目录进入，点击文件打开';
      else foot.textContent = '工作区目录为空';
    }
    return data.entries;
  }

  function showFilePlaceholder(text) {
    var box = r('file-tree');
    if (!box) return;
    box.textContent = '';
    var empty = el('div', 'file-empty');
    empty.id = 'file-empty';
    empty.textContent = text;
    state.refs['file-empty'] = empty;
    box.appendChild(empty);
  }

  function requestFilePath(path, isDir) {
    var value = path == null ? '' : String(path);
    if (!isDir) {
      if (!invoke('onOpenFile', value, false)) UI.toast('打开文件服务尚未就绪');
      return;
    }
    state.fileDrawer.path = value;
    renderFileCrumbs();
    var handled = invoke('onOpenFile', value, true);
    if (!handled) {
      var listed = invoke('onListDir', value);
      if (!listed) showFilePlaceholder('文件服务尚未就绪');
    }
  }

  function refreshFileTree() {
    var path = state.fileDrawer.path || state.workspace.root || '';
    var handled = invoke('onOpenFile', path, true);
    if (!handled) {
      var listed = invoke('onListDir', path);
      if (!listed) showFilePlaceholder('文件服务尚未就绪');
    }
  }

  function openFileDrawer() {
    if (state.fileDrawer.open) return;
    state.fileDrawer.open = true;
    var drawer = r('file-drawer');
    var overlay = r('file-overlay');
    if (drawer) {
      drawer.style.transform = '';
      drawer.classList.remove('is-dragging');
      drawer.classList.add('is-open');
      drawer.setAttribute('aria-hidden', 'false');
    }
    if (overlay) {
      overlay.classList.add('is-open');
      overlay.setAttribute('aria-hidden', 'false');
    }
    updateWorkspaceDom();
    renderFileCrumbs();
    syncDepth();
    var handled = invoke('onOpenFile');
    if (!handled) {
      var listed = invoke('onListDir', state.fileDrawer.path || state.workspace.root || '');
      if (!listed) showFilePlaceholder('文件服务尚未就绪');
    }
  }

  function closeFileDrawer() {
    if (!state.fileDrawer.open) return;
    state.fileDrawer.open = false;
    state.fileDrawer.dragX = 0;
    var drawer = r('file-drawer');
    var overlay = r('file-overlay');
    if (drawer) {
      drawer.classList.remove('is-open');
      drawer.classList.remove('is-dragging');
      drawer.style.transform = '';
      drawer.setAttribute('aria-hidden', 'true');
    }
    if (overlay) {
      overlay.classList.remove('is-open');
      overlay.setAttribute('aria-hidden', 'true');
    }
    syncDepth();
  }

  /* 文件抽屉左滑关闭（移动端手势） */
  var fileDrag = { active: false, startX: 0, dx: 0, pointerId: null };

  function onFileDrawerDragStart(event) {
    if (!state.fileDrawer.open) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target && event.target.closest && event.target.closest('button, input')) return;
    fileDrag.active = true;
    fileDrag.startX = event.clientX;
    fileDrag.dx = 0;
    fileDrag.pointerId = event.pointerId;
    var drawer = r('file-drawer');
    if (drawer) drawer.classList.add('is-dragging');
  }

  function onFileDrawerDragMove(event) {
    if (!fileDrag.active) return;
    var dx = event.clientX - fileDrag.startX;
    if (dx > 0) dx = 0;
    fileDrag.dx = dx;
    var drawer = r('file-drawer');
    if (!drawer) return;
    var width = drawer.offsetWidth || window.innerWidth || 360;
    var offset = Math.max(dx, -width);
    drawer.style.transform = 'translateX(' + offset + 'px)';
  }

  function onFileDrawerDragEnd() {
    if (!fileDrag.active) return;
    fileDrag.active = false;
    var drawer = r('file-drawer');
    var dx = fileDrag.dx;
    fileDrag.dx = 0;
    if (!drawer) return;
    drawer.classList.remove('is-dragging');
    drawer.style.transform = '';
    var width = drawer.offsetWidth || window.innerWidth || 360;
    if (dx < -72 || (width > 0 && dx / width < -0.22)) closeFileDrawer();
  }

  /* ================================================================== *
   * ARCH v2 P1：底部终端面板
   * ================================================================== */
  function setTerminalOpen(open) {
    state.terminal.open = !!open;
    var panel = r('terminal-panel');
    if (panel) {
      panel.hidden = !state.terminal.open;
      panel.setAttribute('aria-hidden', state.terminal.open ? 'false' : 'true');
    }
    var app = r('app');
    if (app) app.classList.toggle('is-terminal-open', state.terminal.open);
    if (state.terminal.open) {
      var output = r('terminal-output');
      if (output) output.scrollTop = output.scrollHeight;
      var input = r('terminal-input');
      if (input) { try { input.focus(); } catch (err) { /* 静默 */ } }
      scrollToBottom();
    }
  }

  function toggleTerminal(force) {
    var open = force === undefined ? !state.terminal.open : !!force;
    if (open === state.terminal.open) return state.terminal.open;
    setTerminalOpen(open);
    return state.terminal.open;
  }

  function terminalOutputEl() {
    return r('terminal-output');
  }

  function setTerminalBusy(busy) {
    state.terminal.running = !!busy;
    if (state.terminal.timer) {
      clearTimeout(state.terminal.timer);
      state.terminal.timer = 0;
    }
    var input = r('terminal-input');
    var runBtn = r('terminal-run');
    if (input) input.disabled = state.terminal.running;
    if (runBtn) {
      runBtn.disabled = state.terminal.running;
      runBtn.textContent = state.terminal.running ? '执行中…' : '执行';
    }
    if (state.terminal.running) {
      /* 兜底 65s 解除（与原生 run_shell 30s 超时 + 事件回传错开） */
      state.terminal.timer = setTimeout(function () {
        state.terminal.timer = 0;
        setTerminalBusy(false);
      }, 65000);
    }
  }

  function appendTerminal(text, opts) {
    var output = terminalOutputEl();
    if (!output) return;
    var options = opts && typeof opts === 'object' ? opts : {};
    if (options.command != null && String(options.command) !== '') {
      output.appendChild(document.createTextNode('$ ' + String(options.command) + '\n'));
    }
    var value = text == null ? '' : String(text);
    if (!value) {
      if (options.command != null) output.scrollTop = output.scrollHeight;
      return;
    }
    output.appendChild(document.createTextNode(value));
    if (options.raw !== true && !/\n$/.test(value)) output.appendChild(document.createTextNode('\n'));
    output.scrollTop = output.scrollHeight;
    /* 收到执行结果 → 恢复终端输入 */
    if (state.terminal.running) setTerminalBusy(false);
  }

  function clearTerminal() {
    var output = terminalOutputEl();
    if (output) output.textContent = '';
  }

  function copyTerminal() {
    var output = terminalOutputEl();
    var text = output ? String(output.textContent || '') : '';
    if (!text) {
      UI.toast('终端没有内容');
      return;
    }
    copyText(text);
  }

  function runTerminalCommand() {
    var input = r('terminal-input');
    if (!input) return;
    var command = String(input.value || '').trim();
    if (!command) {
      try { input.focus(); } catch (err) { /* 静默 */ }
      return;
    }
    input.value = '';
    if (!invoke('onRunShell', command)) {
      appendTerminal('', { command: command });
      appendTerminal('[系统] 终端服务尚未就绪');
      return;
    }
    /* 执行期间禁用输入，结果回填（appendTerminal）或 65s 兜底后恢复 */
    setTerminalBusy(true);
    try { input.focus(); } catch (err) { /* 静默 */ }
  }

  /* ================================================================== *
   * ARCH v2 P1：工具调用卡片（role:'tool'）
   * ================================================================== */
  function toolArgsText(args) {
    if (args == null || args === '') return '';
    if (typeof args === 'string') {
      var raw = args;
      try {
        return JSON.stringify(JSON.parse(raw), null, 2);
      } catch (err) {
        return raw;
      }
    }
    try {
      return JSON.stringify(args, null, 2);
    } catch (err) {
      try { return String(args); } catch (err2) { return ''; }
    }
  }

  function toolResultText(msg) {
    if (!msg) return '';
    var value = msg.result != null ? msg.result : msg.content;
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch (err) {
      try { return String(value); } catch (err2) { return ''; }
    }
  }

  function toolStatusOf(msg) {
    var source = msg || {};
    var cs = String(source.confirmState == null ? '' : source.confirmState).toLowerCase();
    var hasResult = (source.result != null && String(source.result) !== '') ||
      (source.content != null && String(source.content) !== '');
    if ((cs === 'pending' || cs === 'waiting' || cs === 'confirm' || cs === 'confirming' || source.pending === true) &&
        source.ok !== true && source.ok !== false && !hasResult) {
      return { key: 'pending', label: '等待确认' };
    }
    /* 用户拒绝执行：优先级高于 ok=false，显示「已拒绝」而不是笼统失败 */
    if (cs === 'rejected' || cs === 'denied' || source.rejected === true) {
      return { key: 'rejected', label: '已拒绝' };
    }
    if (source.ok === false || cs === 'error' || cs === 'failed' || cs === 'fail') {
      return { key: 'error', label: '失败' };
    }
    /* 完成态（ok=true / success）优先显示「成功」 */
    if (source.ok === true || cs === 'success' || cs === 'ok' || cs === 'done' || cs === 'confirmed') {
      return { key: 'success', label: '成功' };
    }
    /* P4 修复：运行中优先于 content/result 判定（流式工具输出时不应误显示成功） */
    if (cs === 'running' || cs === 'executing' || source.running === true) {
      return { key: 'running', label: '运行中' };
    }
    if (hasResult) {
      return { key: 'success', label: '成功' };
    }
    return { key: 'running', label: '运行中' };
  }

  function applyToolCardFields(msg, refs) {
    var card = refs.toolCard;
    if (!card) return;
    var name = msg.toolName || msg.name || 'tool';
    var nameText = String(name);
    if (card.name.textContent !== nameText) card.name.textContent = nameText;

    var status = toolStatusOf(msg);
    if (refs.lastToolStatus !== status.key) {
      card.badge.className = 'tool-badge tool-badge--' + status.key;
      card.badge.textContent = status.label;
      refs.lastToolStatus = status.key;
    }

    var argsFullText = toolArgsText(msg.args);
    if (refs.lastToolArgs !== argsFullText) {
      if (argsFullText) {
        card.args.hidden = false;
        var flat = argsFullText.replace(/\s+/g, ' ').trim();
        card.argsSummary.textContent = truncate(flat, 120);
        card.argsSummary.title = flat;
        card.argsFull.textContent = argsFullText;
      } else {
        card.args.hidden = true;
        card.args.open = false;
        card.argsSummary.textContent = '';
        card.argsFull.textContent = '';
      }
      refs.lastToolArgs = argsFullText;
    }

    var resultText = toolResultText(msg);
    if (refs.lastToolResult !== resultText) {
      var hasResult = resultText !== '';
      card.result.hidden = !hasResult;
      card.resultBody.textContent = resultText;
      card.resultSummary.textContent = hasResult
        ? truncate(resultText.replace(/\s+/g, ' ').trim(), 48)
        : '暂无输出';
      card.resultSummary.title = hasResult ? resultText.replace(/\s+/g, ' ').trim() : '';
      refs.lastToolResult = resultText;
    }

    /* ARCH v2 P2：构建类工具进度条 + 日志流 */
    applyToolBuildFields(msg, refs);

    /* 批次2 v2.7.0：快照徽标 + 失败诊断卡 */
    applyToolSnapshotBadge(msg, refs);
    applyToolDiagnostics(msg, refs);
  }

  /* ================================================================== *
   * ARCH v2 P1：高危工具确认弹窗
   * ================================================================== */
  function normalizeRiskLevel(risk) {
    var value = String(risk == null ? '' : risk).trim().toLowerCase();
    if (value === 'high' || value === 'mid' || value === 'low') return value;
    return 'mid';
  }

  function resolveRisk(value) {
    closeModal(r('risk-modal'));
    var resolve = state.riskResolve;
    state.riskResolve = null;
    if (typeof resolve === 'function') resolve(!!value);
  }

  function confirmRisk(tool, args, risk) {
    if (state.riskResolve) resolveRisk(false);
    var level = normalizeRiskLevel(risk);
    var badge = r('risk-badge');
    if (badge) {
      badge.className = 'risk-badge risk-badge--' + level;
      badge.textContent = level.toUpperCase();
    }
    var toolEl = r('risk-tool');
    if (toolEl) toolEl.textContent = tool == null ? 'tool' : String(tool);
    var hint = r('risk-hint');
    if (hint) {
      hint.textContent = level === 'high'
        ? '该工具风险较高，可能修改或删除本机文件、执行任意命令，请确认参数后再允许执行：'
        : '该工具会访问本机数据，确认参数后才会执行：';
    }
    var argsEl = r('risk-args');
    if (argsEl) argsEl.textContent = toolArgsText(args);
    openModal(r('risk-modal'));
    return new Promise(function (resolve) {
      state.riskResolve = resolve;
    });
  }

  /* ================================================================== *
   * ARCH v2 P1：审计日志页
   * ================================================================== */
  function formatAuditTime(ts) {
    var date = toDate(ts);
    if (!date) return ts == null ? '' : String(ts);
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
      ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
  }

  function normalizeAuditItems(items) {
    var out = [];
    (Array.isArray(items) ? items : []).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      out.push({
        ts: item.ts,
        tool: item.tool == null ? '' : String(item.tool),
        args: item.args,
        result: item.result,
        ok: item.ok,
        confirmed: item.confirmed
      });
    });
    return out;
  }

  function renderAudit(items) {
    state.audit = normalizeAuditItems(items);
    var box = r('audit-list');
    if (box) {
      box.textContent = '';
      state.audit.forEach(function (item) {
        var row = el('div', 'audit-row');
        var head = el('div', 'audit-row-head');
        head.appendChild(makeText('span', 'audit-time', formatAuditTime(item.ts)));
        head.appendChild(makeText('span', 'audit-tool', item.tool || 'tool'));
        var failed = item.ok === false || item.ok === 0 || item.ok === '0' || item.ok === 'false';
        var okFlag = makeText('span', 'audit-flag ' + (failed ? 'audit-flag--fail' : 'audit-flag--ok'),
          failed ? '失败' : '成功');
        head.appendChild(okFlag);
        var confirmed = item.confirmed === true || item.confirmed === 1 || item.confirmed === '1';
        var confirmFlag;
        if (failed && !confirmed) {
          /* 被拒绝 / 未确认的失败调用单独标记 */
          confirmFlag = makeText('span', 'audit-flag audit-flag--unconfirmed', '未确认/拒绝');
        } else {
          confirmFlag = makeText('span', 'audit-flag ' + (confirmed ? 'audit-flag--confirmed' : 'audit-flag--auto'),
            confirmed ? '已确认' : '免确认');
        }
        head.appendChild(confirmFlag);
        row.appendChild(head);

        var argsText = toolArgsText(item.args);
        if (argsText) {
          var argsNode = makeText('div', 'audit-code', '参数 ' + argsText.replace(/\s+/g, ' '));
          argsNode.title = argsText;
          row.appendChild(argsNode);
        }
        var resultText = toolResultText(item);
        if (resultText) {
          var resultNode = makeText('div', 'audit-code audit-code--result', '结果 ' + resultText.replace(/\s+/g, ' '));
          resultNode.title = resultText;
          row.appendChild(resultNode);
        }
        box.appendChild(row);
      });
    }
    var empty = r('audit-empty');
    if (empty) empty.hidden = state.audit.length > 0;
    var count = r('audit-count');
    if (count) {
      count.textContent = state.audit.length ? state.audit.length + ' 条记录' : '工具调用记录';
    }
    return state.audit;
  }

  function openAudit() {
    showScreenImpl('audit');
    if (!invoke('onOpenAudit')) {
      renderAudit(state.audit);
      UI.toast('审计服务尚未就绪');
    }
  }

  function refreshAudit() {
    if (!invoke('onOpenAudit')) {
      renderAudit(state.audit);
      UI.toast('审计服务尚未就绪');
    }
  }

  /* ================================================================== *
   * ARCH v2 P1：工作区文件预览弹窗（app.js 的 onOpenFile → readFile 后调用）
   * ================================================================== */
  function openFilePreview(info) {
    var data = info && typeof info === 'object' ? info : { content: info };
    var path = data.path == null ? '' : String(data.path);
    var content = data.content == null ? '' : String(data.content);
    var parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    var nameEl = r('file-preview-name');
    if (nameEl) nameEl.textContent = parts.length ? parts[parts.length - 1] : '文件预览';
    var pathEl = r('file-preview-path');
    if (pathEl) {
      pathEl.textContent = path;
      pathEl.title = path;
    }
    var contentEl = r('file-preview-content');
    if (contentEl) contentEl.textContent = content || '（空文件）';
    openModal(r('file-preview-modal'));
    return true;
  }

  function closeFilePreview() {
    closeModal(r('file-preview-modal'));
  }

  function copyFilePreview() {
    var contentEl = r('file-preview-content');
    var text = contentEl ? String(contentEl.textContent || '') : '';
    if (!text || text === '（空文件）') {
      UI.toast('文件为空');
      return;
    }
    copyText(text);
  }

  /* ================================================================== *
   * ARCH v2 P2：MCP 服务器管理页
   * list: [{id,name,url,token?,enabled?}]
   * statusMap: { id: 'connected'|'connecting'|'disconnected'|'error' } 或
   *            { id: {status,message?,toolCount?,tools?:[{name}]} }
   * ================================================================== */
  function normalizeMcpStatus(value) {
    var status = '';
    var message = '';
    var tools = null;
    var toolCount = null;
    if (typeof value === 'string') {
      status = value;
    } else if (value && typeof value === 'object') {
      status = value.status == null ? '' : String(value.status);
      message = value.message == null ? '' : String(value.message);
      if (Array.isArray(value.tools)) tools = value.tools;
      if (value.toolCount != null) {
        var count = parseInt(value.toolCount, 10);
        if (isFinite(count)) toolCount = Math.max(0, count);
      }
    }
    status = status.toLowerCase();
    if (status === 'ready' || status === 'online' || status === 'ok') status = 'connected';
    else if (status === 'connecting' || status === 'reconnecting' || status === 'pending') status = 'connecting';
    else if (status === 'error' || status === 'failed' || status === 'fail') status = 'error';
    else if (status !== 'connected') status = 'disconnected';
    return { status: status, message: message, tools: tools, toolCount: toolCount };
  }

  function normalizeMcpList(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (item, index) {
      if (!item || typeof item !== 'object') return;
      var id = item.id != null ? String(item.id)
        : (item.serverId != null ? String(item.serverId) : ('mcp_' + index));
      out.push({
        id: id,
        name: item.name ? String(item.name) : ('MCP 服务器 ' + (index + 1)),
        url: item.url ? String(item.url) : '',
        token: item.token == null ? '' : String(item.token),
        enabled: item.enabled !== false,
        tools: Array.isArray(item.tools) ? item.tools.slice() : null,
        toolCount: item.toolCount,
        status: item.status,
        lastMessage: item.lastMessage
      });
    });
    return out;
  }

  function mcpStatusFor(server) {
    var map = state.mcp.statusMap || {};
    var entry = map[server.id];
    if (entry == null && server.status != null) {
      entry = {
        status: server.status,
        message: server.lastMessage,
        toolCount: server.toolCount,
        tools: server.tools
      };
    }
    return normalizeMcpStatus(entry);
  }

  function mcpToolCount(server, status) {
    if (status && Array.isArray(status.tools)) return status.tools.length;
    if (status && status.toolCount != null) return status.toolCount;
    if (server && Array.isArray(server.tools)) return server.tools.length;
    if (server && server.toolCount != null) {
      var count = parseInt(server.toolCount, 10);
      if (isFinite(count)) return Math.max(0, count);
    }
    return 0;
  }

  function mcpStatusText(status) {
    if (!status) return '未连接';
    if (status.status === 'connected') return '已连接';
    if (status.status === 'connecting') return '连接中…';
    if (status.status === 'error') return status.message ? ('连接失败：' + status.message) : '连接失败';
    return '未连接';
  }

  function updateMcpCounts() {
    var servers = state.mcp.servers || [];
    var connected = 0;
    servers.forEach(function (server) {
      if (mcpStatusFor(server).status === 'connected') connected += 1;
    });
    var rowValue = r('set-mcp-count');
    if (rowValue) rowValue.textContent = servers.length ? (servers.length + ' 个 · ' + connected + ' 已连接') : '未配置';
    var subtitle = r('mcp-count');
    if (subtitle) subtitle.textContent = servers.length
      ? (servers.length + ' 个服务器 · ' + connected + ' 已连接')
      : '管理外部工具服务器';
    var empty = r('mcp-empty');
    if (empty) empty.hidden = servers.length > 0;
  }

  function buildMcpRow(server) {
    var status = mcpStatusFor(server);
    var row = el('div', 'mcp-row');
    row.setAttribute('data-mcp-id', server.id);
    row.setAttribute('data-id', server.id);
    row.setAttribute('data-action', 'mcp-edit');
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-label', '编辑 ' + server.name);

    var top = el('div', 'mcp-row-top');
    top.appendChild(el('span', 'mcp-dot mcp-dot--' + status.status));

    var main = el('div', 'mcp-row-main');
    var nameRow = el('div', 'mcp-row-name');
    nameRow.appendChild(makeText('span', 'mcp-row-name-text', server.name));
    var badgeLabel = status.status === 'connected' ? '已连接'
      : (status.status === 'connecting' ? '连接中' : (status.status === 'error' ? '错误' : '未连接'));
    nameRow.appendChild(makeText('span', 'mcp-status-badge mcp-status-badge--' + status.status, badgeLabel));
    main.appendChild(nameRow);
    main.appendChild(makeText('div', 'mcp-row-url', server.url || '未填写 URL'));
    var sub = makeText('div', 'mcp-row-sub', '工具 ' + mcpToolCount(server, status) + ' 个 · ' + mcpStatusText(status));
    if (status.status === 'error') sub.classList.add('is-error');
    main.appendChild(sub);
    top.appendChild(main);
    row.appendChild(top);

    var actions = el('div', 'mcp-row-actions');
    function addAction(action, label, extraCls) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mcp-act' + (extraCls ? ' ' + extraCls : '');
      btn.setAttribute('data-action', action);
      btn.setAttribute('data-id', server.id);
      btn.textContent = label;
      actions.appendChild(btn);
      return btn;
    }
    if (status.status === 'connected') {
      addAction('mcp-disconnect', '断开');
      addAction('mcp-refresh', '刷新工具');
    } else if (status.status === 'connecting') {
      addAction('mcp-disconnect', '取消连接');
    } else {
      addAction('mcp-connect', '连接', 'mcp-act--primary');
      addAction('mcp-test', '测试');
    }
    addAction('mcp-edit', '编辑');
    addAction('mcp-delete', '删除', 'mcp-act--danger');
    row.appendChild(actions);
    return row;
  }

  function renderMcpRows() {
    var list = r('mcp-list');
    if (list) {
      list.textContent = '';
      (state.mcp.servers || []).forEach(function (server) {
        list.appendChild(buildMcpRow(server));
      });
    }
    updateMcpCounts();
    return state.mcp.servers;
  }

  function renderMcpServers(list, statusMap) {
    state.mcp.servers = normalizeMcpList(list);
    if (statusMap && typeof statusMap === 'object' && !Array.isArray(statusMap)) {
      var next = {};
      Object.keys(statusMap).forEach(function (key) {
        next[String(key)] = normalizeMcpStatus(statusMap[key]);
      });
      state.mcp.statusMap = next;
    }
    state.mcp.loading = false;
    return renderMcpRows();
  }

  function setMcpStatus(id, status) {
    if (id == null) return null;
    var key = String(id);
    state.mcp.statusMap = state.mcp.statusMap || {};
    state.mcp.statusMap[key] = normalizeMcpStatus(status);
    renderMcpRows();
    return state.mcp.statusMap[key];
  }

  function loadMcpServers() {
    if (invoke('onOpenMcp')) return true;
    if (invoke('onMcpList')) return true;
    renderMcpRows();
    return false;
  }

  function openMcpPage() {
    showScreenImpl('mcp');
    loadMcpServers();
  }

  function refreshMcpPage() {
    if (!loadMcpServers()) UI.toast('MCP 服务尚未就绪');
  }

  function findMcpServer(id) {
    var key = String(id == null ? '' : id);
    var found = null;
    (state.mcp.servers || []).forEach(function (server) {
      if (server.id === key) found = server;
    });
    return found;
  }

  function setMcpFormError(text) {
    var error = r('mcp-form-error');
    var message = text == null ? '' : String(text);
    if (error) {
      error.textContent = message;
      error.hidden = !message;
    }
  }

  function showMcpFormError(text) {
    setMcpFormError(text);
    var input = r('mcp-form-url');
    if (input) { try { input.focus(); } catch (err) { /* 静默 */ } }
  }

  function openMcpServerForm(server) {
    var target = server;
    if (typeof server === 'string') target = findMcpServer(server);
    if (!target || typeof target !== 'object') target = null;
    state.mcp.editingId = target && target.id ? String(target.id) : '';

    var nameInput = r('mcp-form-name');
    var urlInput = r('mcp-form-url');
    var tokenInput = r('mcp-form-token');
    if (nameInput) nameInput.value = target ? String(target.name || '') : '';
    if (urlInput) urlInput.value = target ? String(target.url || '') : '';
    if (tokenInput) {
      tokenInput.value = target ? String(target.token || '') : '';
      tokenInput.type = 'password';
    }
    var toggle = document.querySelector('[data-action="mcp-toggle-token"]');
    if (toggle) toggle.classList.remove('is-on');
    var title = r('mcp-form-title');
    if (title) title.textContent = state.mcp.editingId ? '编辑 MCP 服务器' : '添加 MCP 服务器';
    var save = r('mcp-form-save');
    if (save) save.textContent = state.mcp.editingId ? '保存并重新连接' : '保存并连接';
    setMcpFormError('');
    openModal(r('mcp-form-modal'));
    setTimeout(function () {
      if (!nameInput) return;
      try { nameInput.focus(); } catch (err) { /* 静默 */ }
    }, 80);
  }

  function closeMcpForm() {
    closeModal(r('mcp-form-modal'));
    state.mcp.editingId = '';
    setMcpFormError('');
  }

  function toggleMcpToken() {
    var input = r('mcp-form-token');
    if (!input) return;
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    var btn = document.querySelector('[data-action="mcp-toggle-token"]');
    if (btn) {
      btn.classList.toggle('is-on', show);
      btn.setAttribute('aria-label', show ? '隐藏 Token' : '显示或隐藏 Token');
    }
  }

  function mcpDefaultName(url) {
    var value = String(url || '');
    var match = /^(?:https?:\/\/)?([^/?#]+)/i.exec(value);
    return match && match[1] ? match[1] : 'MCP 服务器';
  }

  function submitMcpForm() {
    var nameInput = r('mcp-form-name');
    var urlInput = r('mcp-form-url');
    var tokenInput = r('mcp-form-token');
    var url = urlInput ? String(urlInput.value || '').trim() : '';
    var name = nameInput ? String(nameInput.value || '').trim() : '';
    var token = tokenInput ? String(tokenInput.value || '').trim() : '';
    if (!url) {
      showMcpFormError('请输入服务器 URL');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      showMcpFormError('URL 需以 http:// 或 https:// 开头');
      return;
    }
    if (!name) name = mcpDefaultName(url);
    var payload = { name: name, url: url.replace(/\s+/g, ''), token: token, enabled: true, connect: true };
    if (state.mcp.editingId) payload.id = state.mcp.editingId;
    setMcpFormError('');
    if (!invoke('onMcpSave', payload)) {
      setMcpFormError('MCP 服务尚未就绪');
      return;
    }
    closeMcpForm();
  }

  function deleteMcpServer(id) {
    var server = findMcpServer(id);
    var name = server && server.name ? '「' + server.name + '」' : '该 MCP 服务器';
    confirmDialog('删除 MCP 服务器', '确定删除' + name + '吗？删除后其工具会立即从模型中移除。').then(function (ok) {
      if (ok) invoke('onMcpDelete', id);
    });
  }

  /* ================================================================== *
   * ARCH v2 P2：构建类工具卡（进度条 + 日志流）
   * ================================================================== */
  var BUILD_TOOL_NAMES = { pack_apk: 1, repack_apk: 1, decompile_apk: 1, run_gradle: 1 };

  function isBuildToolName(name) {
    var value = String(name == null ? '' : name).toLowerCase();
    if (!value) return false;
    if (BUILD_TOOL_NAMES[value]) return true;
    /* 兼容 mcp:<server>:pack_apk（冒号）与 mcp_<server>_pack_apk（下划线，原生重名冲突时） */
    var names = Object.keys(BUILD_TOOL_NAMES);
    for (var i = 0; i < names.length; i++) {
      var suffix = names[i];
      var tail = value.slice(-(suffix.length + 1));
      if (tail === ':' + suffix || tail === '_' + suffix) return true;
    }
    return false;
  }

  function clampPercent(value) {
    var n = Number(value);
    if (!isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function buildLogLines(value) {
    var out = [];
    if (value == null) return out;
    if (Array.isArray(value)) {
      value.forEach(function (item) {
        String(item == null ? '' : item).split('\n').forEach(function (line) { out.push(line); });
      });
    } else {
      String(value).split('\n').forEach(function (line) { out.push(line); });
    }
    return out;
  }

  function ensureToolBuildNodes(refs) {
    if (refs.toolBuild) return refs.toolBuild;
    var card = refs.toolCard;
    if (!card) return null;

    var wrap = el('div', 'tool-progress');
    wrap.hidden = true;
    var head = el('div', 'tool-progress-head');
    var label = makeText('span', 'tool-progress-label', '构建中…');
    var percentEl = makeText('span', 'tool-progress-percent', '0%');
    head.appendChild(label);
    head.appendChild(percentEl);
    var track = el('div', 'tool-progress-track');
    var fill = el('div', 'tool-progress-fill');
    track.appendChild(fill);
    wrap.appendChild(head);
    wrap.appendChild(track);

    var logDetails = document.createElement('details');
    logDetails.className = 'tool-details tool-log-details';
    logDetails.hidden = true;
    var summary = document.createElement('summary');
    summary.appendChild(makeText('span', 'tool-details-label', '构建日志'));
    var countEl = makeText('span', 'tool-log-count', '0 行');
    summary.appendChild(countEl);
    var caret = el('span', 'tool-details-caret');
    caret.innerHTML = ICON.chevronDown;
    summary.appendChild(caret);
    var logPre = el('pre', 'tool-log');
    logDetails.appendChild(summary);
    logDetails.appendChild(logPre);
    logDetails.addEventListener('toggle', function () {
      if (logDetails.open) logPre.scrollTop = logPre.scrollHeight;
    });

    if (card.result && card.result.parentNode === card.card) {
      card.card.insertBefore(wrap, card.result);
      card.card.insertBefore(logDetails, card.result);
    } else {
      card.card.appendChild(wrap);
      card.card.appendChild(logDetails);
    }

    refs.toolBuild = {
      wrap: wrap,
      label: label,
      percentEl: percentEl,
      fill: fill,
      logDetails: logDetails,
      logCount: countEl,
      logPre: logPre,
      lines: [],
      percent: -1,
      lastLogKey: ''
    };
    return refs.toolBuild;
  }

  function setToolBuildLog(refs, lines) {
    var build = ensureToolBuildNodes(refs);
    if (!build) return;
    var next = (Array.isArray(lines) ? lines : []).slice(-200);
    build.lines = next;
    build.logPre.textContent = next.join('\n');
    build.logDetails.hidden = next.length === 0;
    build.logCount.textContent = next.length + ' 行';
    if (next.length) build.logPre.scrollTop = build.logPre.scrollHeight;
  }

  function collectToolProgress(msg) {
    var source = msg || {};
    var progress = null;
    if (source.progress != null) {
      progress = typeof source.progress === 'number' ? { percent: source.progress } : source.progress;
    }
    if (!progress && source.toolProgress != null) {
      progress = typeof source.toolProgress === 'number' ? { percent: source.toolProgress } : source.toolProgress;
    }
    if (!progress && source.percent != null) progress = { percent: source.percent };
    var percent = progress && progress.percent != null ? clampPercent(progress.percent) : null;
    var status = progress && progress.status != null ? String(progress.status) : '';
    var line = progress && progress.line != null ? String(progress.line) : '';
    return { percent: percent, status: status, line: line };
  }

  function applyToolBuildFields(msg, refs) {
    var name = msg.toolName || msg.name || '';
    if (!isBuildToolName(name)) {
      if (refs.toolBuild) {
        refs.toolBuild.wrap.hidden = true;
        refs.toolBuild.logDetails.hidden = true;
      }
      return;
    }
    var build = ensureToolBuildNodes(refs);
    if (!build) return;
    var info = collectToolProgress(msg);
    var percent = info.percent;
    /* 完成/失败为权威状态：成功后强制 100%，失败保留当前进度 */
    if (msg.ok === true) percent = 100;
    else if (percent == null) percent = 0;
    var failed = msg.ok === false;
    /* 完成态只由 ok=true 决定：进度 100% 但结果未回时仍算运行中（避免提前显示完成/成功） */
    var done = msg.ok === true;
    var statusKey = String(info.status || '').toLowerCase();
    var statusText;
    if (failed) statusText = '构建失败';
    else if (statusKey === 'pending' || statusKey === 'waiting') statusText = '等待确认…';
    else if (statusKey === 'rejected' || statusKey === 'denied') statusText = '已拒绝';
    else if (statusKey === 'error' || statusKey === 'failed') statusText = '构建失败';
    else if (done) statusText = '完成';
    else if (statusKey === 'success' || statusKey === 'done' || statusKey === 'ok') statusText = '完成';
    else statusText = '构建中…';

    build.wrap.hidden = false;
    build.wrap.classList.toggle('is-done', done && !failed);
    build.wrap.classList.toggle('is-error', failed);
    if (build.percent !== percent) {
      build.fill.style.width = percent + '%';
      build.percentEl.textContent = percent + '%';
      build.percent = percent;
    }
    if (build.label.textContent !== statusText) build.label.textContent = statusText;

    /* 日志来源：消息字段（msg.logs/toolLog/log）为主；仅当没有日志时退回当前进度行 */
    var lines = buildLogLines(msg.logs != null ? msg.logs : (msg.toolLog != null ? msg.toolLog : msg.log));
    if (!lines.length && info.line) lines = buildLogLines(info.line);
    var key = lines.length + '|' + (lines.length ? lines[lines.length - 1] : '');
    if (build.lastLogKey !== key) {
      setToolBuildLog(refs, lines);
      build.lastLogKey = key;
    }
  }

  /** 追加日志行（同一行连续重复时去重：app.js 会同时调 setToolProgress(line) 与 appendToolLog） */
  function pushToolLogLines(msg, text) {
    if (text == null || String(text) === '') return false;
    var logs = Array.isArray(msg.logs) ? msg.logs.slice() : [];
    var added = false;
    String(text).split('\n').forEach(function (piece) {
      if (logs.length && logs[logs.length - 1] === piece) return;
      logs.push(piece);
      added = true;
    });
    if (added) msg.logs = logs.slice(-200);
    return added;
  }

  function setToolProgress(msgId, data) {
    if (msgId == null) return null;
    var id = String(msgId);
    var options = data && typeof data === 'object' ? data : { percent: data };
    var msg = state.msgData[id];
    if (!msg) {
      msg = { id: msgId, role: 'tool', toolName: '', content: '' };
      state.msgData[id] = msg;
    }
    var progress = msg.progress && typeof msg.progress === 'object' ? msg.progress : {};
    var percent = options.percent != null ? clampPercent(options.percent) : null;
    if (percent != null) {
      progress.percent = percent;
      msg.percent = percent;
    }
    if (options.status != null) progress.status = String(options.status);
    if (options.line != null) progress.line = String(options.line);
    msg.progress = progress;
    if (options.line != null) pushToolLogLines(msg, options.line);
    var refs = state.msgNodes[id];
    if (refs && refs.toolCard) applyToolBuildFields(msg, refs);
    return progress;
  }

  function appendToolLog(msgId, line) {
    if (msgId == null || line == null) return null;
    var id = String(msgId);
    var msg = state.msgData[id];
    if (!msg) {
      msg = { id: msgId, role: 'tool', toolName: '', content: '' };
      state.msgData[id] = msg;
    }
    var added = pushToolLogLines(msg, String(line));
    var refs = state.msgNodes[id];
    if (refs && refs.toolCard) applyToolBuildFields(msg, refs);
    return added;
  }

  /* ================================================================== *
   * 插件市场（v2.9.0：搜索 / 分类 / 排序 / 详情 / URL 安装 / 代码安装）
   * renderMarketPage({items,status,source,state}) 为主要入口，旧 renderMarket 保留兼容
   * ================================================================== */
  var MARKET_DEFAULT_CATEGORIES = ['语言', '生活', '网络', '效率', '其它'];

  function normalizeMarketCategory(value) {
    var text = value == null ? '' : String(value).trim();
    if (!text || text === '全部' || text.toLowerCase() === 'all' || text === '*') return 'all';
    return text;
  }

  function normalizeMarketStatus(value) {
    var status = '';
    var message = '';
    var version = '';
    if (typeof value === 'string') {
      status = value;
    } else if (value && typeof value === 'object') {
      status = value.status == null ? '' : String(value.status);
      message = value.message == null ? '' : String(value.message);
      version = value.version == null ? '' : String(value.version);
    }
    status = status.toLowerCase().replace(/-/g, '_');
    if (status === 'available' || status === 'new' || status === 'unknown' || status === 'not_installed') status = 'not-installed';
    else if (status === 'ok' || status === 'active') status = 'installed';
    else if (status === 'update_available' || status === 'outdated') status = 'update';
    else if (status === 'error' || status === 'failed' || status === 'checksum_failed' || status === 'invalid') status = 'invalid';
    else if (status === 'installing' || status === 'pending') status = 'installing';
    else if (status !== 'installed' && status !== 'update' && status !== 'not-installed') status = 'not-installed';
    return { status: status, message: message, version: version };
  }

  function normalizeMarketItems(items) {
    var out = [];
    (Array.isArray(items) ? items : []).forEach(function (item, index) {
      if (!item || typeof item !== 'object') return;
      var id = item.id != null ? String(item.id) : ('market_' + index);
      var tags = [];
      if (Array.isArray(item.tags)) {
        item.tags.forEach(function (tag) { if (tag != null && String(tag) !== '') tags.push(String(tag)); });
      }
      var size = Number(item.size);
      out.push({
        id: id,
        name: item.name ? String(item.name) : id,
        version: item.version ? String(item.version) : '',
        installedVersion: item.installedVersion ? String(item.installedVersion) : '',
        author: item.author ? String(item.author) : '',
        description: item.description ? String(item.description) : '',
        url: item.url ? String(item.url) : '',
        sha256: item.sha256 ? String(item.sha256) : '',
        hmac: item.hmac ? String(item.hmac) : '',
        tags: tags,
        category: item.category ? String(item.category) : '',
        size: isFinite(size) && size > 0 ? size : 0,
        updatedAt: item.updatedAt != null ? item.updatedAt : (item.updated_at != null ? item.updated_at : 0),
        installed: item.installed === true,
        status: item.status,
        message: item.lastMessage || item.message || ''
      });
    });
    return out;
  }

  function marketStatusFor(item) {
    var map = state.market.statusMap || {};
    var entry = map[item.id];
    if (entry == null) return normalizeMarketStatus(item);
    return normalizeMarketStatus(entry);
  }

  function marketStatusLabel(status) {
    var key = status && status.status ? status.status : 'not-installed';
    if (key === 'installed') return '已安装';
    if (key === 'update') return '可更新';
    if (key === 'invalid') return '校验失败';
    if (key === 'installing') return '安装中…';
    if (key === 'error') return '安装失败';
    return '未安装';
  }

  function marketSignatureOf(item, status) {
    var st = status || marketStatusFor(item);
    if (st.status === 'invalid') return { key: 'invalid', label: '校验失败' };
    if (item.hmac && item.sha256) return { key: 'signed', label: '已签名' };
    return { key: 'unsigned', label: '未签名' };
  }

  function marketSizeText(size) {
    var value = Number(size);
    if (!isFinite(value) || value <= 0) return '';
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10240 ? 1 : 0) + ' KB';
    return (value / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function marketTimeText(value) {
    if (value == null || value === '') return '';
    var date = toDate(value);
    if (!date) return '';
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
      ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function normalizeMarketSource(source) {
    var data = source;
    if (typeof data === 'string') {
      var key = String(data).toLowerCase();
      return {
        type: key === 'custom' ? 'custom' : 'official',
        label: key === 'custom' ? '自定义源' : '官方市场',
        url: '',
        updatedAt: state.market.source ? state.market.source.updatedAt : 0
      };
    }
    data = data && typeof data === 'object' ? data : {};
    var type = String(data.type || data.source || '').toLowerCase() === 'custom' ? 'custom' : 'official';
    return {
      type: type,
      label: data.label ? String(data.label) : (type === 'custom' ? '自定义源' : '官方市场'),
      url: data.url ? String(data.url) : '',
      updatedAt: data.updatedAt != null ? data.updatedAt : (data.updated_at != null ? data.updated_at : 0)
    };
  }

  function setMarketSourceLabel(source) {
    var normalized = normalizeMarketSource(source);
    var previous = state.market.source || {};
    normalized.updatedAt = normalized.updatedAt || previous.updatedAt || 0;
    state.market.source = normalized;
    if (normalized.url) state.market.url = normalized.url;
    var label = r('market-source-label');
    if (label) label.textContent = normalized.label;
    var setLabel = r('set-market-label');
    if (setLabel) setLabel.textContent = normalized.label;
    var updated = r('market-updated');
    if (updated) {
      var timeText = marketTimeText(normalized.updatedAt);
      updated.textContent = timeText ? ('更新于 ' + timeText) : '';
    }
    return normalized;
  }

  function updateMarketLabels() {
    var items = state.market.items || [];
    var installed = 0;
    items.forEach(function (item) {
      var st = marketStatusFor(item);
      if (st.status === 'installed' || st.status === 'update') installed += 1;
    });
    var label = r('set-market-label');
    if (label) {
      if (state.market.url) label.textContent = items.length ? (items.length + ' 个可用') : '已配置索引';
      else label.textContent = items.length ? (items.length + ' 个可用') : '官方市场（点击加载）';
    }
    var count = r('market-count');
    if (count) {
      var filtered = state.market.filteredCount;
      if (items.length && typeof filtered === 'number' && filtered !== items.length) {
        count.textContent = filtered + '/' + items.length + ' 个插件 · ' + installed + ' 已安装';
      } else {
        count.textContent = items.length
          ? (items.length + ' 个插件 · ' + installed + ' 已安装')
          : '从 https 索引安装插件';
      }
    }
  }

  function marketCategories() {
    var seen = {};
    var out = [];
    MARKET_DEFAULT_CATEGORIES.forEach(function (category) {
      seen[category] = true;
      out.push(category);
    });
    (state.market.items || []).forEach(function (item) {
      var category = item.category || '其它';
      if (!seen[category]) {
        seen[category] = true;
        out.push(category);
      }
    });
    return out;
  }

  function renderMarketCategories() {
    var box = r('market-categories');
    if (!box) return;
    box.textContent = '';
    var current = state.market.category || 'all';
    var all = document.createElement('button');
    all.type = 'button';
    all.className = 'market-cat' + (current === 'all' ? ' is-active' : '');
    all.setAttribute('data-action', 'market-category');
    all.setAttribute('data-category', 'all');
    all.textContent = '全部';
    box.appendChild(all);
    marketCategories().forEach(function (category) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'market-cat' + (current === category ? ' is-active' : '');
      btn.setAttribute('data-action', 'market-category');
      btn.setAttribute('data-category', category);
      btn.textContent = category;
      box.appendChild(btn);
    });
  }

  function syncMarketToolbar() {
    var searchInput = r('market-search');
    if (searchInput && searchInput.value !== state.market.query) searchInput.value = state.market.query || '';
    var clear = r('market-search-clear');
    if (clear) clear.hidden = !state.market.query;
    var sortInput = r('market-sort');
    if (sortInput) sortInput.value = state.market.sort || 'recommended';
    renderMarketCategories();
  }

  function filteredMarketItems() {
    var query = String(state.market.query || '').trim().toLowerCase();
    var category = normalizeMarketCategory(state.market.category);
    var sort = state.market.sort || 'recommended';
    var list = (state.market.items || []).filter(function (item) {
      if (category !== 'all') {
        var itemCategory = item.category || '其它';
        if (itemCategory !== category) return false;
      }
      if (!query) return true;
      var hay = (item.name + ' ' + item.description + ' ' + item.author + ' ' + item.tags.join(' ') + ' ' + item.id).toLowerCase();
      return hay.indexOf(query) >= 0;
    });
    if (sort === 'name') {
      list.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'); });
    } else if (sort === 'updated') {
      list.sort(function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); });
    }
    return list;
  }

  function buildMarketCard(item) {
    var status = marketStatusFor(item);
    var signature = marketSignatureOf(item, status);
    var progress = state.market.installProgress[item.id];
    var card = el('div', 'market-card');
    card.setAttribute('data-market-id', item.id);

    var head = el('div', 'market-card-head');
    var titleWrap = el('div', 'market-card-title');
    titleWrap.appendChild(makeText('span', 'market-name', item.name));
    if (item.version) titleWrap.appendChild(makeText('span', 'market-version', 'v' + item.version));
    head.appendChild(titleWrap);
    head.appendChild(makeText('span', 'market-badge market-badge--' + status.status, marketStatusLabel(status)));
    card.appendChild(head);
    if (status.status === 'update') card.appendChild(el('span', 'market-update-dot'));

    if (item.author) card.appendChild(makeText('div', 'market-author', '作者 ' + item.author));
    if (item.description) card.appendChild(makeText('div', 'market-desc', item.description));

    if (item.tags.length) {
      var tags = el('div', 'market-tags');
      item.tags.forEach(function (tag) { tags.appendChild(makeText('span', 'market-tag', tag)); });
      card.appendChild(tags);
    }

    var metaRow = el('div', 'market-card-meta');
    var sizeText = marketSizeText(item.size);
    if (sizeText) metaRow.appendChild(makeText('span', 'market-size', sizeText));
    metaRow.appendChild(makeText('span', 'market-signature market-signature--' + signature.key, signature.label));
    if (item.category) metaRow.appendChild(makeText('span', 'market-size', item.category));
    if (item.installedVersion && item.installedVersion !== item.version) {
      metaRow.appendChild(makeText('span', 'market-size', '已装 v' + item.installedVersion));
    }
    card.appendChild(metaRow);

    if (status.status === 'invalid' && status.message) {
      card.appendChild(makeText('div', 'market-error', '校验失败：' + status.message));
    } else if (status.message && (status.status === 'invalid' || status.status === 'not-installed' || status.status === 'error')) {
      card.appendChild(makeText('div', 'market-error', status.message));
    }

    if (progress) {
      var progressBox = el('div', 'market-card-progress');
      var progressEl = el('div', 'tool-progress');
      if ((Number(progress.percent) || 0) >= 100) progressEl.classList.add('is-done');
      var progressHead = el('div', 'tool-progress-head');
      progressHead.appendChild(makeText('span', 'tool-progress-label', progress.message || '安装中…'));
      progressHead.appendChild(makeText('span', 'tool-progress-percent', Math.round(Number(progress.percent) || 0) + '%'));
      var track = el('div', 'tool-progress-track');
      var fill = el('div', 'tool-progress-fill');
      fill.style.width = Math.max(0, Math.min(100, Math.round(Number(progress.percent) || 0))) + '%';
      track.appendChild(fill);
      progressEl.appendChild(progressHead);
      progressEl.appendChild(track);
      progressBox.appendChild(progressEl);
      card.appendChild(progressBox);
    }

    var actions = el('div', 'market-actions');
    function addAction(action, labelText, cls, disabled) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'market-act' + (cls ? ' ' + cls : '');
      btn.setAttribute('data-action', action);
      btn.setAttribute('data-id', item.id);
      btn.textContent = labelText;
      if (disabled) btn.disabled = true;
      actions.appendChild(btn);
      return btn;
    }
    if (status.status === 'installed') {
      addAction('market-remove', '卸载', 'market-act--danger');
    } else if (status.status === 'update') {
      addAction('market-install', '更新', 'market-act--primary');
      addAction('market-remove', '卸载', 'market-act--danger');
    } else if (status.status === 'installing') {
      addAction('market-install', '安装中…', 'market-act--primary', true);
    } else if (status.status === 'invalid') {
      addAction('market-install', '重新安装', 'market-act--primary');
    } else if (status.status === 'error') {
      addAction('market-install', '重试安装', 'market-act--primary');
    } else {
      addAction('market-install', '安装', 'market-act--primary');
      addAction('market-remove', '卸载', 'market-act--danger');
    }
    var detailBtn = document.createElement('button');
    detailBtn.type = 'button';
    detailBtn.className = 'market-detail-btn';
    detailBtn.setAttribute('data-action', 'market-detail');
    detailBtn.setAttribute('data-id', item.id);
    detailBtn.textContent = '详情';
    actions.appendChild(detailBtn);
    card.appendChild(actions);
    return card;
  }

  function renderMarketRows() {
    var list = r('market-list');
    var items = filteredMarketItems();
    state.market.filteredCount = items.length;
    if (list) {
      list.textContent = '';
      items.forEach(function (item) {
        list.appendChild(buildMarketCard(item));
      });
    }
    updateMarketLabels();
    syncMarketToolbar();
    var loading = r('market-loading');
    if (loading) loading.hidden = !state.market.loading;
    var error = r('market-error');
    if (error) error.hidden = !state.market.error;
    var errorText = r('market-error-text');
    if (errorText && state.market.error) errorText.textContent = state.market.error;
    var empty = r('market-empty');
    if (empty) {
      var hasFilter = !!(state.market.query || (state.market.category && state.market.category !== 'all'));
      empty.hidden = items.length > 0 || !!state.market.loading || !!state.market.error;
      var emptyTitle = empty.querySelector('p');
      var emptySmall = empty.querySelector('small');
      if (hasFilter && emptyTitle) emptyTitle.textContent = '没有匹配的插件';
      else if (emptyTitle) emptyTitle.textContent = '还没有市场插件';
      if (emptySmall) emptySmall.textContent = hasFilter
        ? '试试清空搜索或切换分类。'
        : '可刷新官方市场、切换自定义索引，或从 URL / 粘贴代码安装插件。';
    }
    return items;
  }

  function renderMarketPage(data) {
    var info = data && typeof data === 'object' ? data : {};
    if (Array.isArray(info.items) || Array.isArray(info.plugins)) {
      state.market.items = normalizeMarketItems(info.items || info.plugins);
    }
    var statusSource = info.status != null ? info.status : info.statusMap;
    if (statusSource && typeof statusSource === 'object' && !Array.isArray(statusSource)) {
      var next = {};
      Object.keys(statusSource).forEach(function (key) {
        next[String(key)] = normalizeMarketStatus(statusSource[key]);
      });
      state.market.statusMap = next;
    }
    if (info.source != null) setMarketSourceLabel(info.source);
    var pageState = info.state && typeof info.state === 'object' ? info.state : {};
    if (pageState.loading != null) state.market.loading = !!pageState.loading;
    if (pageState.error != null) state.market.error = pageState.error ? String(pageState.error) : '';
    if (pageState.query != null) state.market.query = String(pageState.query);
    if (pageState.category != null) state.market.category = normalizeMarketCategory(pageState.category);
    if (pageState.sort != null) state.market.sort = String(pageState.sort);
    if (pageState.updatedAt != null) {
      state.market.source = state.market.source || normalizeMarketSource('official');
      state.market.source.updatedAt = pageState.updatedAt;
      setMarketSourceLabel(state.market.source);
    }
    state.market.loaded = true;
    if (info.items != null || info.state != null || info.status != null) {
      state.market.loading = false;
      state.market.error = '';
    }
    renderMarketRows();
    return state.market.items;
  }

  function renderMarket(items, statusMap) {
    state.market.items = normalizeMarketItems(items);
    if (statusMap && typeof statusMap === 'object' && !Array.isArray(statusMap)) {
      var next = {};
      Object.keys(statusMap).forEach(function (key) {
        next[String(key)] = normalizeMarketStatus(statusMap[key]);
      });
      state.market.statusMap = next;
    }
    state.market.loaded = true;
    state.market.loading = false;
    state.market.error = '';
    renderMarketRows();
    return state.market.items;
  }

  function setMarketStatus(id, status) {
    if (id == null) return null;
    var key = String(id);
    state.market.statusMap = state.market.statusMap || {};
    state.market.statusMap[key] = normalizeMarketStatus(status);
    renderMarketRows();
    return state.market.statusMap[key];
  }

  function setMarketUrl(url) {
    var value = url == null ? '' : String(url);
    state.market.url = value;
    var input = r('market-url');
    if (input && (!String(input.value || '').trim() || value)) input.value = value;
    updateMarketLabels();
    return value;
  }

  function openMarketPage() {
    showScreenImpl('market');
    if (!invoke('onOpenMarket')) renderMarketRows();
  }

  function marketFetchUrl() {
    var input = r('market-url');
    var inputValue = input ? String(input.value || '').trim() : '';
    if (inputValue) return inputValue;
    return (state.market.source && state.market.source.url) || state.market.url || '';
  }

  function fetchMarketIndex(force) {
    var url = marketFetchUrl();
    if (url && !/^https:\/\//i.test(url)) {
      UI.toast('索引地址需以 https:// 开头');
      var input = r('market-url');
      if (input) { try { input.focus(); } catch (err) { /* 静默 */ } }
      return;
    }
    if (!url) {
      UI.toast('请填写市场索引 URL');
      return;
    }
    state.market.url = url;
    state.market.loading = true;
    state.market.error = '';
    renderMarketRows();
    var result = callHandler('onFetchMarket', { url: url, force: !!force });
    if (result === undefined) result = callHandler('onMarketFetch', url);
    if (result === undefined) {
      state.market.loading = false;
      state.market.error = '市场服务尚未就绪';
      UI.toast('市场服务尚未就绪');
      renderMarketRows();
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then(function (res) {
        if (res === false && state.market.loading) {
          state.market.loading = false;
          state.market.error = state.market.error || '市场加载失败，请重试';
          renderMarketRows();
        }
      }, function () {
        state.market.loading = false;
        state.market.error = '市场加载失败，请重试';
        renderMarketRows();
      });
    } else if (result === false) {
      state.market.loading = false;
      state.market.error = '市场加载失败，请重试';
      renderMarketRows();
    }
  }

  function setMarketQuery(query) {
    state.market.query = query == null ? '' : String(query);
    var clear = r('market-search-clear');
    if (clear) clear.hidden = !state.market.query;
    renderMarketRows();
    clearTimeout(state.market.searchTimer);
    state.market.searchTimer = setTimeout(function () {
      if (typeof state.cb.onSearchMarket === 'function') {
        invoke('onSearchMarket', {
          query: state.market.query,
          category: normalizeMarketCategory(state.market.category) === 'all' ? '' : normalizeMarketCategory(state.market.category),
          sort: state.market.sort
        });
      }
    }, 250);
  }

  function setMarketCategory(category) {
    state.market.category = normalizeMarketCategory(category);
    renderMarketRows();
    if (typeof state.cb.onSearchMarket === 'function') {
      invoke('onSearchMarket', {
        query: state.market.query,
        category: state.market.category === 'all' ? '' : state.market.category,
        sort: state.market.sort
      });
    }
  }

  function setMarketSort(sort) {
    var value = sort === 'updated' || sort === 'name' ? sort : 'recommended';
    state.market.sort = value;
    renderMarketRows();
    if (typeof state.cb.onSearchMarket === 'function') {
      invoke('onSearchMarket', {
        query: state.market.query,
        category: state.market.category === 'all' ? '' : state.market.category,
        sort: value
      });
    }
  }

  function findMarketItem(id) {
    var key = String(id == null ? '' : id);
    var found = null;
    (state.market.items || []).forEach(function (item) {
      if (item.id === key) found = item;
    });
    return found;
  }

  function installMarketItem(id) {
    var item = findMarketItem(id);
    if (!item) return;
    var result = callHandler('onInstallMarket', item);
    if (result === undefined) result = callHandler('onMarketInstall', item);
    if (result === undefined) UI.toast('市场服务尚未就绪');
    if (state.market.detailId === item.id) renderMarketDetail(item);
  }

  function removeMarketItem(id) {
    var item = findMarketItem(id);
    var name = item && item.name ? '「' + item.name + '」' : '该插件';
    confirmDialog('卸载插件', '确定卸载' + name + '吗？其工具与面板会立即移除。').then(function (ok) {
      if (!ok) return;
      var result = callHandler('onRemoveMarket', item ? item.id : id);
      if (result === undefined) result = callHandler('onMarketRemove', item ? item.id : id);
      if (result === undefined) UI.toast('市场服务尚未就绪');
    });
  }

  function marketDetailActions() {
    var box = r('market-detail-actions');
    if (!box) return;
    box.textContent = '';
    var item = state.market.detailId ? findMarketItem(state.market.detailId) : null;
    if (!item) return;
    var status = marketStatusFor(item);
    function add(action, label, cls, disabled) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ' + (cls || 'btn--ghost');
      btn.setAttribute('data-action', action);
      btn.setAttribute('data-id', item.id);
      btn.textContent = label;
      if (disabled) btn.disabled = true;
      box.appendChild(btn);
      return btn;
    }
    if (status.status === 'installed') add('market-remove', '卸载', 'btn--danger');
    else if (status.status === 'update') {
      add('market-install', '更新', 'btn--primary');
      add('market-remove', '卸载', 'btn--danger');
    } else if (status.status === 'installing') add('market-install', '安装中…', 'btn--primary', true);
    else if (status.status === 'invalid') add('market-install', '重新安装', 'btn--primary');
    else if (status.status === 'error') add('market-install', '重试安装', 'btn--primary');
    else add('market-install', '安装', 'btn--primary');
    add('close-market-detail', '关闭', 'btn--ghost');
  }

  function renderMarketDetail(item) {
    if (!item) return;
    var status = marketStatusFor(item);
    var signature = marketSignatureOf(item, status);
    var nameEl = r('market-detail-name');
    if (nameEl) nameEl.textContent = item.name;
    var subEl = r('market-detail-sub');
    if (subEl) subEl.textContent = (item.author ? ('作者 ' + item.author + ' · ') : '') + 'v' + (item.version || '—');
    var descEl = r('market-detail-desc');
    if (descEl) descEl.textContent = item.description || '（暂无描述）';
    var tagsBox = r('market-detail-tags');
    if (tagsBox) {
      tagsBox.textContent = '';
      item.tags.forEach(function (tag) { tagsBox.appendChild(makeText('span', 'market-tag', tag)); });
    }
    setVal('market-detail-version', item.version ? ('v' + item.version) : '—');
    setVal('market-detail-author', item.author || '—');
    setVal('market-detail-size', marketSizeText(item.size) || '—');
    setVal('market-detail-category', item.category || '其它');
    var signatureEl = r('market-detail-signature');
    if (signatureEl) {
      signatureEl.textContent = signature.label;
      signatureEl.classList.remove('is-signed', 'is-unsigned', 'is-invalid');
      signatureEl.classList.add('is-' + signature.key);
    }
    setVal('market-detail-status', marketStatusLabel(status));
    var errorEl = r('market-detail-error');
    if (errorEl) {
      var message = status.status === 'invalid' ? (status.message || '签名校验失败') : (status.status === 'error' ? (status.message || '安装失败') : '');
      errorEl.textContent = message;
      errorEl.hidden = !message;
    }
    var progress = state.market.installProgress[item.id];
    var progressBox = r('market-detail-progress');
    if (progressBox) {
      progressBox.hidden = !progress;
      if (progress) {
        var percent = Math.max(0, Math.min(100, Math.round(Number(progress.percent) || 0)));
        var fill = r('market-detail-progress-fill');
        if (fill) fill.style.width = percent + '%';
        var text = r('market-detail-progress-text');
        if (text) text.textContent = (progress.message || '安装中…') + ' · ' + percent + '%';
      }
    }
    marketDetailActions();
  }

  function openMarketDetail(id) {
    var item = findMarketItem(id);
    if (!item) return false;
    state.market.detailId = item.id;
    renderMarketDetail(item);
    openModal(r('market-detail-modal'));
    return true;
  }

  function closeMarketDetail() {
    closeModal(r('market-detail-modal'));
    state.market.detailId = null;
  }

  function renderInstallProgress(id, data) {
    var key = String(id == null ? '' : id);
    if (!key) return null;
    var info = data && typeof data === 'object' ? data : { percent: data };
    var percent = Number(info.percent);
    if (!isFinite(percent)) percent = null;
    var record = state.market.installProgress[key] || { percent: 0, message: '' };
    if (percent != null) record.percent = Math.max(0, Math.min(100, Math.round(percent)));
    if (info.message != null) record.message = String(info.message);
    else if (record.percent > 0 && !record.message) record.message = '安装中…';
    state.market.installProgress[key] = record;
    if (state.market.detailId === key) {
      var item = findMarketItem(key);
      if (item) renderMarketDetail(item);
    }
    renderMarketRows();
    return record;
  }

  function openMarketUrlInstall() {
    var error = r('market-install-url-error');
    if (error) { error.textContent = ''; error.hidden = true; }
    var input = r('market-install-url');
    if (input) input.value = '';
    openModal(r('market-url-install-modal'));
    setTimeout(function () {
      var field = r('market-install-url');
      if (!field) return;
      try { field.focus(); } catch (err) { /* 静默 */ }
    }, 80);
  }

  function submitMarketUrlInstall() {
    var input = r('market-install-url');
    var url = input ? String(input.value || '').trim() : '';
    var error = r('market-install-url-error');
    function fail(message) {
      if (error) { error.textContent = message; error.hidden = false; }
    }
    if (!url) { fail('请输入插件 URL'); return; }
    if (!/^https:\/\//i.test(url)) { fail('仅支持 https:// 直链'); return; }
    var result = callHandler('onInstallMarketFromUrl', url);
    if (result === undefined) { fail('市场服务尚未就绪'); return; }
    Promise.resolve(result).then(function (ok) {
      if (ok === false) { fail('从 URL 安装失败'); return; }
      closeModal(r('market-url-install-modal'));
      UI.toast('已开始安装插件');
    }, function () { fail('从 URL 安装失败'); });
  }

  function openMarketCodeInstall() {
    var error = r('market-code-error');
    if (error) { error.textContent = ''; error.hidden = true; }
    var input = r('market-code-input');
    if (input) input.value = '';
    var risk = r('market-code-risk');
    if (risk) risk.checked = false;
    openModal(r('market-code-modal'));
  }

  function submitMarketCodeInstall() {
    var input = r('market-code-input');
    var source = input ? String(input.value || '') : '';
    var risk = r('market-code-risk');
    var error = r('market-code-error');
    function fail(message) {
      if (error) { error.textContent = message; error.hidden = false; }
    }
    if (!source.trim()) { fail('请粘贴插件代码'); return; }
    if (!risk || !risk.checked) { fail('请先勾选「我已了解风险」'); return; }
    var result = callHandler('onInstallMarketSource', source);
    if (result === undefined) { fail('市场服务尚未就绪'); return; }
    Promise.resolve(result).then(function (ok) {
      if (ok === false) { fail('安装失败，请检查插件代码'); return; }
      closeModal(r('market-code-modal'));
      UI.toast('插件安装已提交');
    }, function () { fail('安装失败，请检查插件代码'); });
  }

  function saveCustomMarketSource() {
    var input = r('market-url');
    var url = input ? String(input.value || '').trim() : '';
    if (!url) { UI.toast('请输入索引 URL'); return; }
    if (!/^https:\/\//i.test(url)) { UI.toast('索引地址需以 https:// 开头'); return; }
    var result = callHandler('onSetMarketSource', 'custom', url);
    if (result === undefined) { UI.toast('市场服务尚未就绪'); return; }
    setMarketSourceLabel({ type: 'custom', label: '自定义源', url: url });
    UI.toast('已保存自定义源');
  }

  function resetOfficialMarketSource() {
    var result = callHandler('onSetMarketSource', 'official', '');
    if (result === undefined) { UI.toast('市场服务尚未就绪'); return; }
    state.market.url = '';
    state.market.source = normalizeMarketSource('official');
    var input = r('market-url');
    if (input) input.value = '';
    setMarketSourceLabel(state.market.source);
    UI.toast('已恢复官方市场');
  }

  function toggleMarketSourcePanel() {
    var panel = r('market-source-panel');
    if (!panel) return;
    panel.open = !panel.open;
  }

  /* ================================================================== *
   * ARCH v2 P3：记忆页
   * renderMemory({long_term, project:{tech_stack,conventions,decisions}, summaries})
   * ================================================================== */
  function normalizeLongTerm(value) {
    var out = [];
    if (Array.isArray(value)) {
      value.forEach(function (item) {
        if (!item) return;
        if (typeof item === 'string') {
          out.push({ key: item, value: '' });
          return;
        }
        if (typeof item !== 'object') return;
        var key = item.key != null ? String(item.key) : (item.name != null ? String(item.name) : '');
        if (!key) return;
        out.push({ key: key, value: item.value == null ? '' : String(item.value) });
      });
    } else if (value && typeof value === 'object') {
      Object.keys(value).forEach(function (key) {
        out.push({ key: String(key), value: value[key] == null ? '' : String(value[key]) });
      });
    }
    return out;
  }

  function normalizeProject(value) {
    var source = value && typeof value === 'object' ? value : {};
    return {
      tech_stack: source.tech_stack == null ? '' : String(source.tech_stack),
      conventions: source.conventions == null ? '' : String(source.conventions),
      decisions: source.decisions == null ? '' : String(source.decisions)
    };
  }

  function normalizeSummaries(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var chatId = item.chatId != null ? String(item.chatId) : (item.chat_id != null ? String(item.chat_id) : '');
      if (!chatId) return;
      out.push({
        chatId: chatId,
        title: item.title == null ? '' : String(item.title),
        summary: item.summary == null ? '' : String(item.summary),
        updatedAt: item.updatedAt != null ? item.updatedAt : item.updated_at
      });
    });
    return out;
  }

  function memoryTimeText(value) {
    if (value == null || value === '') return '';
    var date = toDate(value);
    if (!date) return '';
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
      ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function updateMemoryLabels() {
    var lt = state.memory.longTerm || [];
    var summaries = state.memory.summaries || [];
    var label = r('set-memory-label');
    if (label) {
      label.textContent = (lt.length || summaries.length)
        ? (lt.length + ' 条偏好 · ' + summaries.length + ' 条摘要')
        : '长期偏好 / 项目记忆';
    }
    var count = r('memory-count');
    if (count) {
      count.textContent = (lt.length || summaries.length)
        ? (lt.length + ' 条长期偏好 · ' + summaries.length + ' 条会话摘要')
        : '长期偏好 / 项目记忆 / 会话摘要';
    }
  }

  function renderMemoryLongTerm() {
    var box = r('memory-longterm');
    var list = state.memory.longTerm || [];
    if (box) {
      box.textContent = '';
      list.forEach(function (item) {
        var row = el('div', 'memory-row');
        var main = el('div', 'memory-row-main');
        main.appendChild(makeText('div', 'memory-row-key', item.key));
        if (item.value) main.appendChild(makeText('div', 'memory-row-value', item.value));
        row.appendChild(main);
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'memory-del';
        del.setAttribute('data-action', 'memory-delete-longterm');
        del.setAttribute('data-key', item.key);
        del.textContent = '删除';
        row.appendChild(del);
        box.appendChild(row);
      });
    }
    var empty = r('memory-longterm-empty');
    if (empty) empty.hidden = list.length > 0;
  }

  function renderMemorySummaries() {
    var box = r('memory-summaries');
    var list = state.memory.summaries || [];
    if (box) {
      box.textContent = '';
      list.forEach(function (item) {
        var row = el('div', 'memory-row');
        var main = el('div', 'memory-row-main');
        main.appendChild(makeText('div', 'memory-row-key', item.title || item.chatId));
        main.appendChild(makeText('div', 'memory-row-value', item.summary || '（空摘要）'));
        var timeText = memoryTimeText(item.updatedAt);
        if (timeText) main.appendChild(makeText('div', 'memory-row-meta', '更新于 ' + timeText));
        row.appendChild(main);
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'memory-del';
        del.setAttribute('data-action', 'memory-delete-summary');
        del.setAttribute('data-chat-id', item.chatId);
        del.textContent = '删除';
        row.appendChild(del);
        box.appendChild(row);
      });
    }
    var empty = r('memory-summaries-empty');
    if (empty) empty.hidden = list.length > 0;
  }

  function renderMemory(data) {
    var info = data && typeof data === 'object' ? data : {};
    if (Object.prototype.hasOwnProperty.call(info, 'long_term')) {
      state.memory.longTerm = normalizeLongTerm(info.long_term);
    }
    if (Object.prototype.hasOwnProperty.call(info, 'project')) {
      state.memory.project = normalizeProject(info.project);
    }
    if (Object.prototype.hasOwnProperty.call(info, 'summaries')) {
      state.memory.summaries = normalizeSummaries(info.summaries);
    }
    var project = state.memory.project || {};
    setVal('memory-tech-stack', project.tech_stack || '');
    setVal('memory-conventions', project.conventions || '');
    setVal('memory-decisions', project.decisions || '');
    renderMemoryLongTerm();
    renderMemorySummaries();
    updateMemoryLabels();
    state.memory.loaded = true;
    return state.memory;
  }

  function openMemoryPage() {
    showScreenImpl('memory');
    if (invoke('onOpenMemory')) return true;
    renderMemory({ long_term: state.memory.longTerm, project: state.memory.project, summaries: state.memory.summaries });
    return false;
  }

  function setMemoryItemError(text) {
    var error = r('memory-item-error');
    var message = text == null ? '' : String(text);
    if (error) {
      error.textContent = message;
      error.hidden = !message;
    }
  }

  function openMemoryItemForm() {
    setVal('memory-item-key', '');
    setVal('memory-item-value', '');
    setMemoryItemError('');
    openModal(r('memory-item-modal'));
    setTimeout(function () {
      var input = r('memory-item-key');
      if (!input) return;
      try { input.focus(); } catch (err) { /* 静默 */ }
    }, 80);
  }

  function closeMemoryItemForm() {
    closeModal(r('memory-item-modal'));
    setMemoryItemError('');
  }

  function submitMemoryItem() {
    var keyInput = r('memory-item-key');
    var valueInput = r('memory-item-value');
    var key = keyInput ? String(keyInput.value || '').trim() : '';
    var value = valueInput ? String(valueInput.value || '').trim() : '';
    if (!key) {
      setMemoryItemError('请输入偏好名称');
      return;
    }
    if (!invoke('onMemorySave', 'long_term', key, value)) {
      setMemoryItemError('记忆服务尚未就绪');
      return;
    }
    closeMemoryItemForm();
  }

  function deleteLongTermMemory(key) {
    if (!key) return;
    confirmDialog('删除长期偏好', '确定删除「' + key + '」吗？').then(function (ok) {
      if (ok) {
        if (!invoke('onMemoryDelete', 'long_term', key)) UI.toast('记忆服务尚未就绪');
      }
    });
  }

  function saveProjectMemory() {
    var fields = [
      ['tech_stack', r('memory-tech-stack')],
      ['conventions', r('memory-conventions')],
      ['decisions', r('memory-decisions')]
    ];
    var handled = false;
    fields.forEach(function (pair) {
      var value = pair[1] ? String(pair[1].value || '') : '';
      if (invoke('onMemorySave', 'project', pair[0], value)) handled = true;
    });
    if (!handled) UI.toast('记忆服务尚未就绪');
  }

  function deleteSummaryMemory(chatId) {
    if (!chatId) return;
    confirmDialog('删除会话摘要', '确定删除该会话摘要吗？删除后下次请求不再注入。').then(function (ok) {
      if (ok) {
        if (!invoke('onSummaryDelete', chatId)) UI.toast('记忆服务尚未就绪');
      }
    });
  }

  /* ================================================================== *
   * ARCH v2 P3：插件面板（uiSlots）
   * slot: {id,title,description?,icon?,type:'button'|'panel',
   *        actions?:[{action|id,label,style?,payload?}], html?, payload?}
   * ================================================================== */
  function normalizePluginSlots(slots) {
    var out = [];
    (Array.isArray(slots) ? slots : []).forEach(function (slot, index) {
      if (!slot || typeof slot !== 'object') return;
      var id = slot.id != null ? String(slot.id) : ('slot_' + index);
      var actions = [];
      (Array.isArray(slot.actions) ? slot.actions : []).forEach(function (action, actionIndex) {
        if (!action) return;
        if (typeof action === 'string') {
          actions.push({ id: action, label: action, style: '', payload: null });
          return;
        }
        if (typeof action !== 'object') return;
        var actionId = action.action != null ? String(action.action)
          : (action.id != null ? String(action.id) : ('action_' + actionIndex));
        actions.push({
          id: actionId,
          label: action.label ? String(action.label) : actionId,
          style: action.style ? String(action.style) : '',
          payload: action.payload === undefined ? null : action.payload
        });
      });
      out.push({
        id: id,
        title: slot.title ? String(slot.title) : id,
        description: slot.description ? String(slot.description) : '',
        icon: slot.icon,
        type: slot.type === 'panel' ? 'panel' : 'button',
        actions: actions,
        html: typeof slot.html === 'string' ? slot.html : '',
        payload: slot.payload === undefined ? null : slot.payload
      });
    });
    return out;
  }

  function buildPluginSlot(slot) {
    var card = el('div', 'plugin-slot');
    card.setAttribute('data-slot-id', slot.id);

    var head = el('div', 'plugin-slot-head');
    var icon = el('span', 'plugin-slot-icon');
    if (typeof slot.icon === 'string' && slot.icon) {
      if (/^\s*<svg/i.test(slot.icon)) icon.innerHTML = slot.icon;
      else icon.textContent = slot.icon;
    } else {
      icon.innerHTML = ICON.puzzle;
    }
    head.appendChild(icon);
    head.appendChild(makeText('span', 'plugin-slot-title', slot.title));
    head.appendChild(makeText('span', 'plugin-slot-type', slot.type === 'panel' ? '面板' : '按钮'));
    card.appendChild(head);

    if (slot.description) card.appendChild(makeText('div', 'plugin-slot-desc', slot.description));
    if (slot.html) {
      var htmlBox = el('div', 'plugin-slot-html');
      try {
        htmlBox.innerHTML = slot.html;
      } catch (err) {
        htmlBox.textContent = String(slot.html);
      }
      card.appendChild(htmlBox);
    }

    var actions = slot.actions.slice();
    if (!actions.length && slot.type === 'button') {
      actions.push({ id: 'run', label: '运行', style: 'primary', payload: null });
    }
    if (actions.length) {
      var row = el('div', 'plugin-slot-actions');
      actions.forEach(function (action) {
        var btn = document.createElement('button');
        btn.type = 'button';
        var cls = 'plugin-slot-btn';
        if (action.style === 'primary') cls += ' plugin-slot-btn--primary';
        else if (action.style === 'danger') cls += ' plugin-slot-btn--danger';
        btn.className = cls;
        btn.setAttribute('data-action', 'slot-action');
        btn.setAttribute('data-slot-id', slot.id);
        btn.setAttribute('data-slot-action', action.id);
        btn.textContent = action.label;
        row.appendChild(btn);
      });
      card.appendChild(row);
    }
    return card;
  }

  function renderPluginSlots(slots) {
    state.pluginSlots = normalizePluginSlots(slots);
    var box = r('plugin-slots');
    if (box) {
      box.textContent = '';
      state.pluginSlots.forEach(function (slot) {
        box.appendChild(buildPluginSlot(slot));
      });
    }
    var empty = r('plugin-slots-empty');
    if (empty) empty.hidden = state.pluginSlots.length > 0;
    return state.pluginSlots;
  }

  function openPluginPanel() {
    if (state.pluginPanelOpen) { syncDepth(); return; }
    state.pluginPanelOpen = true;
    var panel = r('plugin-panel');
    if (panel) {
      panel.classList.add('is-open');
      panel.setAttribute('aria-hidden', 'false');
    }
    syncDepth();
    if (!invoke('onOpenPluginPanel')) renderPluginSlots(state.pluginSlots);
  }

  function closePluginPanel() {
    if (!state.pluginPanelOpen) return;
    state.pluginPanelOpen = false;
    var panel = r('plugin-panel');
    if (panel) {
      panel.classList.remove('is-open');
      panel.setAttribute('aria-hidden', 'true');
    }
    syncDepth();
  }

  function findPluginSlot(slotId) {
    var key = String(slotId == null ? '' : slotId);
    var found = null;
    (state.pluginSlots || []).forEach(function (slot) {
      if (slot.id === key) found = slot;
    });
    return found;
  }

  function runPluginSlotAction(slotId, actionId) {
    var slot = findPluginSlot(slotId);
    var payload = {};
    if (slot && slot.payload && typeof slot.payload === 'object') {
      for (var key in slot.payload) {
        if (Object.prototype.hasOwnProperty.call(slot.payload, key)) payload[key] = slot.payload[key];
      }
    }
    if (slot) {
      var action = null;
      (slot.actions || []).forEach(function (item) {
        if (item.id === actionId) action = item;
      });
      if (action && action.payload && typeof action.payload === 'object') {
        for (var actionKey in action.payload) {
          if (Object.prototype.hasOwnProperty.call(action.payload, actionKey)) payload[actionKey] = action.payload[actionKey];
        }
      }
    }
    if (!invoke('onSlotAction', slotId, actionId, payload)) UI.toast('插件动作尚未就绪');
  }

  /* ================================================================== *
   * ARCH v2 P4：工作台三栏（宽屏/横屏）
   * 持久化：localStorage['dsh.workbench'] = {enabled, terminalHeight}
   * ================================================================== */
  function readWorkbenchPrefs() {
    try {
      if (!window.localStorage) return null;
      var raw = window.localStorage.getItem(WORKBENCH_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : null;
    } catch (err) {
      return null;
    }
  }

  function saveWorkbenchPrefs() {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(WORKBENCH_KEY, JSON.stringify({
        enabled: !!state.workbench.enabled,
        terminalHeight: Math.round(state.workbench.terminalHeight) || 0
      }));
    } catch (err) { /* 静默 */ }
  }

  function loadWorkbenchPrefs() {
    var data = readWorkbenchPrefs();
    if (data) {
      state.workbench.enabled = data.enabled === true;
      var stored = Number(data.terminalHeight);
      state.workbench.terminalHeight = isFinite(stored) && stored > 0 ? Math.round(stored) : 0;
    }
    applyTerminalHeight();
    applyWorkbench();
    if (state.workbench.active) requestWorkbenchTree();
  }

  function isWorkbenchWide() {
    var width = Number(window.innerWidth) || 0;
    var height = Number(window.innerHeight) || 0;
    if (width >= 600) return true;
    return width > 0 && height > 0 && width > height;
  }

  function applyWorkbench() {
    var active = !!state.workbench.enabled && isWorkbenchWide();
    state.workbench.active = active;
    var screen = r('screen-chat');
    if (screen) screen.classList.toggle('is-workbench', active);
    var aside = r('workbench-files');
    if (aside) aside.setAttribute('aria-hidden', active ? 'false' : 'true');
    var btn = r('workbench-toggle');
    if (btn) {
      btn.classList.toggle('is-on', !!state.workbench.enabled);
      btn.setAttribute('aria-pressed', state.workbench.enabled ? 'true' : 'false');
    }
    updateWorkbenchPath();
    return active;
  }

  function updateWorkbenchPath() {
    var el = r('workbench-path');
    if (!el) return;
    var data = state.fileDrawer;
    var path = data.path || data.root || state.workspace.root || '';
    el.textContent = path || '未设置工作区';
    el.title = path;
  }

  function requestWorkbenchTree() {
    var handled = invoke('onOpenFile');
    if (!handled) handled = invoke('onListDir', state.fileDrawer.path || '');
    return handled;
  }

  function refreshWorkbenchTree() {
    var path = state.fileDrawer.path || state.workspace.root || '';
    if (invoke('onOpenFile', path, true)) return true;
    if (invoke('onListDir', path)) return true;
    showFilePlaceholder('文件服务尚未就绪');
    return false;
  }

  function toggleWorkbench(force) {
    var next = force === undefined ? !state.workbench.enabled : !!force;
    state.workbench.enabled = next;
    saveWorkbenchPrefs();
    applyWorkbench();
    if (next) {
      if (isWorkbenchWide()) {
        requestWorkbenchTree();
      } else {
        UI.toast('竖屏为文件抽屉模式，横屏自动切换工作台');
        openFileDrawer();
      }
    }
    if (typeof state.cb.onToggleWorkbench === 'function') invoke('onToggleWorkbench', next);
    return next;
  }

  function setWorkbenchEnabled(on) {
    return toggleWorkbench(!!on);
  }

  function getWorkbenchState() {
    return {
      enabled: !!state.workbench.enabled,
      active: !!state.workbench.active,
      terminalHeight: state.workbench.terminalHeight || 0
    };
  }

  /* ---------- 终端高度拖拽 + 记忆 ---------- */
  function applyTerminalHeight() {
    var panel = r('terminal-panel');
    if (!panel) return;
    var height = state.workbench.terminalHeight;
    panel.style.height = height > 0 ? (Math.round(height) + 'px') : '';
  }

  function setTerminalHeight(px) {
    var height = Number(px);
    if (!isFinite(height) || height <= 0) {
      state.workbench.terminalHeight = 0;
      applyTerminalHeight();
      saveWorkbenchPrefs();
      return 0;
    }
    var maxHeight = Math.max(180, Math.round((Number(window.innerHeight) || 640) * 0.7));
    height = Math.max(120, Math.min(maxHeight, Math.round(height)));
    state.workbench.terminalHeight = height;
    applyTerminalHeight();
    saveWorkbenchPrefs();
    return height;
  }

  function getTerminalHeight() {
    return state.workbench.terminalHeight || 0;
  }

  var terminalResize = { active: false, startY: 0, startHeight: 0, pointerId: null };

  function onTerminalResizeStart(event) {
    var panel = r('terminal-panel');
    if (!panel || panel.hidden) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    var startHeight = panel.offsetHeight || Math.round((Number(window.innerHeight) || 640) * 0.4);
    terminalResize.active = true;
    terminalResize.startY = event.clientY;
    terminalResize.startHeight = startHeight;
    terminalResize.pointerId = event.pointerId;
    state.workbench.resizing = true;
    var screen = r('screen-chat');
    if (screen) screen.classList.add('is-resizing-terminal');
    if (event.target && event.target.setPointerCapture) {
      try { event.target.setPointerCapture(event.pointerId); } catch (err) { /* 静默 */ }
    }
    if (event.preventDefault) event.preventDefault();
  }

  function onTerminalResizeMove(event) {
    if (!terminalResize.active) return;
    var panel = r('terminal-panel');
    if (!panel) return;
    var height = terminalResize.startHeight - (event.clientY - terminalResize.startY);
    var maxHeight = Math.max(180, Math.round((Number(window.innerHeight) || 640) * 0.7));
    height = Math.max(120, Math.min(maxHeight, height));
    state.workbench.terminalHeight = Math.round(height);
    panel.style.height = Math.round(height) + 'px';
  }

  function onTerminalResizeEnd() {
    if (!terminalResize.active) return;
    terminalResize.active = false;
    state.workbench.resizing = false;
    var screen = r('screen-chat');
    if (screen) screen.classList.remove('is-resizing-terminal');
    saveWorkbenchPrefs();
    if (typeof state.cb.onTerminalResized === 'function') invoke('onTerminalResized', state.workbench.terminalHeight);
  }

  /* ================================================================== *
   * ARCH v2 P4：构建任务面板
   * tasks: [{id,toolName|tool,serverId|server,percent,status,line?,lines?,logs?}]
   * ================================================================== */
  function normalizeBuildStatus(value) {
    var status = String(value == null ? '' : value).toLowerCase();
    if (status === 'success' || status === 'ok' || status === 'done' || status === 'complete' ||
        status === 'completed' || status === 'finished') return 'success';
    if (status === 'error' || status === 'failed' || status === 'fail' || status === 'rejected') return 'error';
    return 'running';
  }

  function buildStatusLabel(status) {
    if (status === 'success') return '完成';
    if (status === 'error') return '失败';
    return '构建中';
  }

  function appendBuildLines(target, value) {
    if (value == null) return;
    buildLogLines(value).forEach(function (line) {
      /* 连续重复行去重（任务同时带 lines 与 line 时避免重复） */
      if (target.length && target[target.length - 1] === line) return;
      target.push(line);
    });
  }

  function createBuildTask(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    var tool = raw.toolName || raw.tool || raw.name || 'build';
    var id = raw.id != null ? String(raw.id) : (String(tool) + '#' + index);
    var lines = [];
    appendBuildLines(lines, raw.lines != null ? raw.lines : (raw.logs != null ? raw.logs : raw.log));
    appendBuildLines(lines, raw.line);
    var percent = raw.percent != null ? clampPercent(raw.percent) : null;
    return {
      id: id,
      toolName: String(tool),
      server: raw.serverId != null ? String(raw.serverId) : (raw.server != null ? String(raw.server) : ''),
      percent: percent,
      status: normalizeBuildStatus(raw.status),
      line: raw.line != null ? String(raw.line) : '',
      lines: lines.slice(-200),
      updatedAt: raw.updatedAt != null ? raw.updatedAt : Date.now()
    };
  }

  function applyBuildTaskPatch(task, patch) {
    if (!task || !patch || typeof patch !== 'object') return task;
    if (patch.status != null) task.status = normalizeBuildStatus(patch.status);
    if (patch.percent != null) task.percent = clampPercent(patch.percent);
    if (patch.serverId != null) task.server = String(patch.serverId);
    else if (patch.server != null) task.server = String(patch.server);
    if (patch.toolName != null) task.toolName = String(patch.toolName);
    else if (patch.tool != null) task.toolName = String(patch.tool);
    if (patch.lines != null || patch.logs != null || patch.log != null) {
      task.lines = [];
      appendBuildLines(task.lines, patch.lines != null ? patch.lines : (patch.logs != null ? patch.logs : patch.log));
      task.lines = task.lines.slice(-200);
    }
    if (patch.line != null) {
      appendBuildLines(task.lines, patch.line);
      task.lines = task.lines.slice(-200);
      task.line = String(patch.line);
    }
    if (patch.updatedAt != null) task.updatedAt = patch.updatedAt;
    else task.updatedAt = Date.now();
    return task;
  }

  function findBuildTask(id) {
    var key = String(id == null ? '' : id);
    var found = null;
    (state.buildTasks || []).forEach(function (task) {
      if (task.id === key) found = task;
    });
    return found;
  }

  function buildTaskNode(task) {
    var card = el('div', 'build-task');
    card.setAttribute('data-build-id', task.id);

    var head = el('div', 'build-task-head');
    head.appendChild(makeText('span', 'build-task-name', task.toolName));
    if (task.server) head.appendChild(makeText('span', 'build-task-server', task.server));
    head.appendChild(makeText('span', 'build-task-badge build-task-badge--' + task.status, buildStatusLabel(task.status)));
    card.appendChild(head);

    var percent = task.percent;
    if (percent == null) percent = task.status === 'success' ? 100 : 0;
    var progress = el('div', 'tool-progress');
    if (task.status === 'success') progress.classList.add('is-done');
    if (task.status === 'error') progress.classList.add('is-error');
    var progressHead = el('div', 'tool-progress-head');
    progressHead.appendChild(makeText('span', 'tool-progress-label',
      task.status === 'success' ? '完成' : (task.status === 'error' ? '构建失败' : '构建中…')));
    progressHead.appendChild(makeText('span', 'tool-progress-percent', percent + '%'));
    var track = el('div', 'tool-progress-track');
    var fill = el('div', 'tool-progress-fill');
    fill.style.width = percent + '%';
    track.appendChild(fill);
    progress.appendChild(progressHead);
    progress.appendChild(track);
    card.appendChild(progress);

    card.appendChild(makeText('div', 'build-task-meta',
      '日志 ' + task.lines.length + ' 行 · ' + buildStatusLabel(task.status)));

    if (task.lines.length) {
      var details = document.createElement('details');
      details.className = 'tool-details tool-log-details';
      details.open = false;
      var summary = document.createElement('summary');
      summary.appendChild(makeText('span', 'tool-details-label', '日志'));
      summary.appendChild(makeText('span', 'tool-log-count', task.lines.length + ' 行'));
      var caret = el('span', 'tool-details-caret');
      caret.innerHTML = ICON.chevronDown;
      summary.appendChild(caret);
      var pre = el('pre', 'tool-log');
      pre.textContent = task.lines.join('\n');
      details.appendChild(summary);
      details.appendChild(pre);
      details.addEventListener('toggle', function () {
        if (details.open) pre.scrollTop = pre.scrollHeight;
      });
      card.appendChild(details);
      card.addEventListener('click', function (event) {
        if (event.target && event.target.closest && event.target.closest('summary')) return;
        details.open = !details.open;
      });
    }
    return card;
  }

  function renderBuildTaskList() {
    var box = r('build-tasks');
    if (box) {
      box.textContent = '';
      (state.buildTasks || []).forEach(function (task) {
        box.appendChild(buildTaskNode(task));
      });
    }
    var empty = r('build-empty');
    if (empty) empty.hidden = (state.buildTasks || []).length > 0;
    return state.buildTasks;
  }

  function renderBuildTasks(tasks) {
    var list = [];
    (Array.isArray(tasks) ? tasks : []).forEach(function (item, index) {
      var task = createBuildTask(item, index);
      if (task) list.push(task);
    });
    state.buildTasks = list;
    return renderBuildTaskList();
  }

  function updateBuildTask(taskOrId, patch) {
    var target = null;
    if (taskOrId && typeof taskOrId === 'object') {
      var created = createBuildTask(taskOrId, state.buildTasks.length);
      if (!created) return null;
      var existing = findBuildTask(created.id);
      if (existing) {
        applyBuildTaskPatch(existing, taskOrId);
        if (patch && typeof patch === 'object') applyBuildTaskPatch(existing, patch);
        target = existing;
      } else {
        state.buildTasks.push(created);
        target = created;
      }
    } else if (taskOrId != null) {
      var key = String(taskOrId);
      target = findBuildTask(key);
      if (!target) {
        target = createBuildTask({ id: key, status: 'running' }, state.buildTasks.length);
        if (!target) return null;
        state.buildTasks.push(target);
      }
      applyBuildTaskPatch(target, patch);
    }
    renderBuildTaskList();
    return target;
  }

  function openBuildPanel() {
    if (!state.buildPanelOpen) {
      state.buildPanelOpen = true;
      var panel = r('build-panel');
      if (panel) {
        panel.classList.add('is-open');
        panel.setAttribute('aria-hidden', 'false');
      }
      syncDepth();
    }
    /* 防重入：app.js 的 onOpenBuildPanel 会再调 UI.openBuildPanel 刷新任务 */
    if (!state.buildPanelLoading) {
      state.buildPanelLoading = true;
      try { invoke('onOpenBuildPanel'); } finally { state.buildPanelLoading = false; }
    }
    renderBuildTaskList();
  }

  function closeBuildPanel() {
    if (!state.buildPanelOpen) return;
    state.buildPanelOpen = false;
    var panel = r('build-panel');
    if (panel) {
      panel.classList.remove('is-open');
      panel.setAttribute('aria-hidden', 'true');
    }
    syncDepth();
  }

  /* ================================================================== *
   * ARCH v2 P4：待发送图片 + 图片消息 + 全屏预览
   * ================================================================== */
  function normalizePendingImage(image) {
    if (!image) return null;
    if (typeof image === 'string') {
      return { dataUrl: image, width: 0, height: 0, name: '' };
    }
    if (typeof image !== 'object' || !image.dataUrl) return null;
    return {
      dataUrl: String(image.dataUrl),
      width: Number(image.width) || 0,
      height: Number(image.height) || 0,
      name: image.name == null ? '' : String(image.name)
    };
  }

  function renderPendingImages() {
    var box = r('composer-images');
    if (!box) return;
    box.textContent = '';
    state.pendingImages.forEach(function (image, index) {
      var chip = el('div', 'composer-image-chip');
      var img = document.createElement('img');
      img.src = image.dataUrl;
      img.alt = image.name || ('图片 ' + (index + 1));
      chip.appendChild(img);
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'composer-image-remove';
      remove.setAttribute('data-action', 'remove-pending-image');
      remove.setAttribute('data-index', String(index));
      remove.setAttribute('aria-label', '移除图片');
      remove.innerHTML = ICON.x;
      chip.appendChild(remove);
      box.appendChild(chip);
    });
    box.hidden = state.pendingImages.length === 0;
  }

  function getPendingImages() {
    return state.pendingImages.map(function (image) {
      return {
        dataUrl: image.dataUrl,
        width: image.width,
        height: image.height,
        name: image.name
      };
    });
  }

  function setPendingImages(images) {
    var list = [];
    (Array.isArray(images) ? images : []).forEach(function (image) {
      var normalized = normalizePendingImage(image);
      if (normalized) list.push(normalized);
    });
    if (list.length > 4) {
      list = list.slice(0, 4);
      UI.toast('最多添加 4 张图片');
    }
    state.pendingImages = list;
    renderPendingImages();
    return getPendingImages();
  }

  function addPendingImage(image) {
    var normalized = normalizePendingImage(image);
    if (!normalized) return false;
    if (state.pendingImages.length >= 4) {
      UI.toast('最多添加 4 张图片');
      return false;
    }
    state.pendingImages.push(normalized);
    renderPendingImages();
    return true;
  }

  function removePendingImage(index) {
    var position = Number(index);
    if (!isFinite(position) || position < 0 || position >= state.pendingImages.length) return null;
    state.pendingImages.splice(position, 1);
    renderPendingImages();
    invoke('onRemoveImage', position);
    return state.pendingImages.length;
  }

  function clearPendingImages() {
    state.pendingImages = [];
    renderPendingImages();
  }

  function openAttachmentSheet() {
    closeEmojiPanel();
    var sheet = r('attachment-sheet');
    if (!sheet) return;
    sheet.classList.add('is-open');
    sheet.setAttribute('aria-hidden', 'false');
    syncDepth();
  }

  function closeAttachmentSheet() {
    var sheet = r('attachment-sheet');
    if (!sheet) return;
    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');
    syncDepth();
  }

  function pickImage(source) {
    var value = source === 'camera' ? 'camera' : 'gallery';
    closeAttachmentSheet();
    if (!invoke('onPickImage', value)) UI.toast('图片选择服务尚未就绪');
  }

  function openImageViewer(src) {
    var value = src == null ? '' : String(src);
    if (!value) return;
    var viewer = r('image-viewer');
    var img = r('image-viewer-img');
    if (!viewer || !img) return;
    img.src = value;
    viewer.classList.add('is-open');
    viewer.setAttribute('aria-hidden', 'false');
    syncDepth();
  }

  function closeImageViewer() {
    var viewer = r('image-viewer');
    if (!viewer) return;
    viewer.classList.remove('is-open');
    viewer.setAttribute('aria-hidden', 'true');
    var img = r('image-viewer-img');
    if (img) img.src = '';
    syncDepth();
  }

  function imageListOf(value) {
    var out = [];
    (Array.isArray(value) ? value : []).forEach(function (item) {
      if (item == null || item === '') return;
      if (typeof item === 'string') out.push(item);
      else if (typeof item === 'object' && item.dataUrl) out.push(String(item.dataUrl));
    });
    return out.slice(0, 4);
  }

  function renderMessageImages(container, images) {
    if (!container) return;
    var list = imageListOf(images);
    var key = list.length + '|' + list.map(function (src) {
      return String(src.length) + ':' + String(src).slice(-16);
    }).join(',');
    if (container.getAttribute('data-image-key') === key) return;
    container.setAttribute('data-image-key', key);
    container.textContent = '';
    if (!list.length) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    container.className = 'msg-images' + (list.length === 1 ? ' msg-images--single' : '');
    list.forEach(function (src, index) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'msg-image-btn';
      btn.setAttribute('data-action', 'open-image-viewer');
      btn.setAttribute('data-src', src);
      btn.setAttribute('aria-label', '查看图片 ' + (index + 1));
      var img = document.createElement('img');
      img.className = 'msg-image';
      img.src = src;
      img.alt = '图片 ' + (index + 1);
      img.loading = 'lazy';
      btn.appendChild(img);
      container.appendChild(btn);
    });
  }

  /* ================================================================== *
   * ARCH v2 P4：应用锁 / 本地加密状态
   * ================================================================== */
  function setSecurityInfo(info) {
    var data = info && typeof info === 'object' ? info : {};
    if (Object.prototype.hasOwnProperty.call(data, 'appLock')) state.security.appLock = !!data.appLock;
    if (Object.prototype.hasOwnProperty.call(data, 'encrypted')) state.security.encrypted = !!data.encrypted;
    if (Object.prototype.hasOwnProperty.call(data, 'rootMode')) state.security.rootMode = !!data.rootMode;
    if (Object.prototype.hasOwnProperty.call(data, 'rootMessage')) state.security.rootMessage = String(data.rootMessage || '');
    if (Object.prototype.hasOwnProperty.call(data, 'pin')) state.security.pin = !!data.pin;
    if (Object.prototype.hasOwnProperty.call(data, 'pinSet')) state.security.pin = !!data.pinSet;
    if (Object.prototype.hasOwnProperty.call(data, 'pinLocked')) state.security.pinLocked = !!data.pinLocked;
    var rootToggle = r('set-rootmode');
    if (rootToggle) rootToggle.checked = !!state.security.rootMode;
    var rootStatus = r('set-root-status');
    if (rootStatus) {
      rootStatus.classList.remove('is-on', 'is-warn');
      if (state.security.rootMode) {
        rootStatus.textContent = state.security.rootMessage || '已启用（su 执行）';
        rootStatus.classList.add('is-on');
      } else {
        rootStatus.textContent = state.security.rootMessage || '未启用';
        rootStatus.classList.add('is-warn');
      }
    }
    updatePinStatusDom();
    var toggle = r('set-applock');
    if (toggle) toggle.checked = !!state.security.appLock;
    var status = r('set-encryption-status');
    if (status) {
      status.classList.remove('is-on', 'is-warn');
      if (data.message != null && String(data.message) !== '') {
        status.textContent = String(data.message);
        status.classList.add(state.security.encrypted ? 'is-on' : 'is-warn');
      } else if (state.security.encrypted) {
        status.textContent = '已启用 · AES-GCM（本机密钥）';
        status.classList.add('is-on');
      } else {
        status.textContent = '未启用（明文存储）';
        status.classList.add('is-warn');
      }
    }
    return {
      appLock: !!state.security.appLock,
      encrypted: !!state.security.encrypted,
      rootMode: !!state.security.rootMode,
      pin: !!state.security.pin,
      pinLocked: !!state.security.pinLocked
    };
  }

  function toggleAppLock(enabled) {
    var next = !!enabled;
    var toggle = r('set-applock');
    if (!invoke('onToggleAppLock', next)) {
      if (toggle) toggle.checked = !next;
      UI.toast('应用锁服务尚未就绪');
      return false;
    }
    state.security.appLock = next;
    if (toggle) toggle.checked = next;
    return true;
  }

  function toggleRootMode(enabled) {
    var next = !!enabled;
    var toggle = r('set-rootmode');
    if (!invoke('onToggleRootMode', next)) {
      if (toggle) toggle.checked = !next;
      UI.toast('Root 模式服务尚未就绪');
      return false;
    }
    state.security.rootMode = next;
    if (toggle) toggle.checked = next;
    return true;
  }

  /* 打开设置页时刷新 MCP 服务器统计与安全状态（不依赖进入 MCP 管理页） */
  function refreshSettingsStats() {
    if (!invoke('onRefreshMcpStats')) invoke('onOpenMcp');
    if (!invoke('onRefreshSecurity')) {
      setSecurityInfo({ appLock: state.security.appLock, encrypted: state.security.encrypted });
    }
  }

  /* ================================================================== *
   * 批次 1 · v2.6.0：运行轨迹
   * events: [{id,type,at|ts,text?,name|tool,args,risk,confirmed,ok,summary,durationMs}]
   * ================================================================== */
  function traceTypeKey(type) {
    var value = String(type == null ? '' : type).toLowerCase().replace(/-/g, '_');
    if (value === 'user' || value === 'human') return 'user';
    if (value === 'thinking' || value === 'reasoning' || value === 'thought') return 'thinking';
    if (value === 'tool_call' || value === 'toolcall' || value === 'tool') return 'tool_call';
    if (value === 'tool_result' || value === 'toolresult' || value === 'result') return 'tool_result';
    if (value === 'assistant' || value === 'message') return 'assistant';
    return 'note';
  }

  var TRACE_META = {
    user: { label: '用户', badge: 'user' },
    thinking: { label: '思考', badge: 'thinking' },
    assistant: { label: '回复', badge: 'note' },
    tool_call: { label: '工具调用', badge: 'tool_call' },
    tool_result: { label: '工具结果', badge: 'tool_result' },
    note: { label: '注记', badge: 'note' }
  };

  function traceTextOf(event) {
    if (!event) return '';
    if (event.text != null) return String(event.text);
    if (event.content != null) return String(event.content);
    if (event.summary != null) return String(event.summary);
    return '';
  }

  function traceToolOf(event) {
    if (!event) return '';
    return event.name != null ? String(event.name) : (event.tool != null ? String(event.tool) : '');
  }

  function traceTimeText(value) {
    var date = toDate(value);
    if (!date) return '';
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
  }

  function traceDurationText(ms) {
    var value = Number(ms);
    if (!isFinite(value) || value < 0) return '';
    if (value < 1000) return Math.round(value) + 'ms';
    if (value < 60000) return (value / 1000).toFixed(1) + 's';
    return Math.floor(value / 60000) + 'm' + Math.round((value % 60000) / 1000) + 's';
  }

  function traceSearchText(event) {
    var parts = [
      traceTypeKey(event.type),
      traceTextOf(event),
      traceToolOf(event),
      event.summary != null ? String(event.summary) : '',
      event.result != null ? String(event.result) : '',
      event.args != null ? toolArgsText(event.args) : '',
      event.risk != null ? String(event.risk) : '',
      event.confirmed != null ? String(event.confirmed) : ''
    ];
    return parts.join(' ').toLowerCase();
  }

  function normalizeTraceEvents(data) {
    var events = [];
    var chatId = '';
    var chatTitle = '';
    if (Array.isArray(data)) {
      events = data;
    } else if (data && typeof data === 'object') {
      if (Array.isArray(data.events)) events = data.events;
      else if (Array.isArray(data.trace)) events = data.trace;
      if (data.chatId != null) chatId = String(data.chatId);
      if (data.chatTitle != null) chatTitle = String(data.chatTitle);
    }
    var list = [];
    events.forEach(function (event, index) {
      if (!event || typeof event !== 'object') return;
      list.push({
        raw: event,
        id: event.id != null ? String(event.id) : ('trace_' + index),
        type: traceTypeKey(event.type),
        at: event.at != null ? event.at : event.ts,
        text: traceTextOf(event),
        tool: traceToolOf(event),
        args: event.args,
        risk: event.risk != null ? String(event.risk) : '',
        confirmed: event.confirmed != null ? String(event.confirmed) : '',
        ok: event.ok,
        summary: event.summary != null ? String(event.summary) : '',
        result: event.result,
        durationMs: event.durationMs != null ? event.durationMs : event.duration
      });
    });
    return { events: list, chatId: chatId, chatTitle: chatTitle };
  }

  function traceFilteredEvents() {
    var query = String(state.trace.query || '').trim().toLowerCase();
    var list = state.trace.events || [];
    if (!query) return list.slice();
    return list.filter(function (event) {
      return traceSearchText(event.raw).indexOf(query) >= 0;
    });
  }

  function traceConfirmedLabel(value) {
    var key = String(value == null ? '' : value).toLowerCase();
    if (key === 'auto') return '自动';
    if (key === 'pending') return '等待确认';
    if (key === 'confirmed') return '已确认';
    if (key === 'denied' || key === 'rejected') return '已拒绝';
    return value ? String(value) : '';
  }

  function buildTraceNode(event) {
    var meta = TRACE_META[event.type] || TRACE_META.note;
    var failed = (event.type === 'tool_result' && event.ok === false) ||
      String(event.confirmed || '').toLowerCase() === 'denied';
    var node = el('div', 'trace-item trace-item--' + event.type + (failed ? ' is-fail' : ''));
    node.setAttribute('data-trace-id', event.id);
    node.appendChild(el('span', 'trace-dot'));

    var card = el('div', 'trace-card');
    var head = el('div', 'trace-head');
    head.appendChild(makeText('span', 'trace-time', traceTimeText(event.at)));
    var badgeClass = 'trace-badge trace-badge--' + meta.badge + (event.type === 'tool_result' && event.ok === false ? ' trace-badge--fail' : '');
    head.appendChild(makeText('span', badgeClass, meta.label));
    var title = event.tool || event.text || meta.label;
    head.appendChild(makeText('span', 'trace-title', title));
    card.appendChild(head);

    var metaRow = null;
    function chip(text, cls) {
      if (!metaRow) metaRow = el('div', 'trace-meta');
      metaRow.appendChild(makeText('span', 'trace-chip' + (cls ? ' ' + cls : ''), text));
    }
    if (event.type === 'tool_call') {
      if (event.risk) chip('风险 ' + event.risk.toUpperCase(), 'trace-chip--' + event.risk.toLowerCase());
      if (event.confirmed) chip(traceConfirmedLabel(event.confirmed), String(event.confirmed).toLowerCase() === 'denied' ? 'trace-chip--fail' : '');
    }
    if (event.type === 'tool_result') {
      chip(event.ok === false ? '失败' : '成功', event.ok === false ? 'trace-chip--fail' : 'trace-chip--ok');
      var duration = traceDurationText(event.durationMs);
      if (duration) chip('耗时 ' + duration);
      if (event.confirmed) chip(traceConfirmedLabel(event.confirmed));
    }
    if (event.type === 'thinking') chip('思考片段');
    if (event.summary && event.summary !== event.text) chip(truncate(event.summary.replace(/\s+/g, ' ').trim(), 40));
    if (metaRow) card.appendChild(metaRow);

    if (event.type === 'thinking' || event.type === 'user' || event.type === 'assistant' || event.type === 'note') {
      if (event.text) card.appendChild(makeText('div', 'trace-text', truncate(event.text, 1200)));
    }

    if (event.type === 'tool_call') {
      var argsText = toolArgsText(event.args);
      if (argsText) card.appendChild(traceDetailsNode('参数', argsText));
    }
    if (event.type === 'tool_result') {
      var resultText = event.result != null ? String(event.result) : (event.summary || '');
      if (resultText) card.appendChild(traceDetailsNode('结果', resultText));
    }

    if (event.type === 'tool_call' || event.type === 'tool_result') {
      var replay = document.createElement('button');
      replay.type = 'button';
      replay.className = 'trace-replay';
      replay.setAttribute('data-action', 'replay-tool');
      replay.setAttribute('data-trace-id', event.id);
      replay.textContent = '重放';
      card.appendChild(replay);
    }

    node.appendChild(card);
    return node;
  }

  function traceDetailsNode(label, text) {
    var details = document.createElement('details');
    details.className = 'trace-details';
    var summary = document.createElement('summary');
    summary.appendChild(makeText('span', 'tool-details-label', label));
    summary.appendChild(makeText('span', 'tool-args-summary', truncate(String(text).replace(/\s+/g, ' ').trim(), 80)));
    var caret = el('span', 'tool-details-caret');
    caret.innerHTML = ICON.chevronDown;
    summary.appendChild(caret);
    var pre = el('pre', 'trace-code');
    pre.textContent = String(text);
    details.appendChild(summary);
    details.appendChild(pre);
    return details;
  }

  function renderTraceList() {
    var box = r('trace-list');
    var filtered = traceFilteredEvents();
    if (box) {
      box.textContent = '';
      filtered.forEach(function (event) {
        box.appendChild(buildTraceNode(event));
      });
    }
    var empty = r('trace-empty');
    if (empty) empty.hidden = filtered.length > 0;
    var count = r('trace-count');
    if (count) {
      var total = (state.trace.events || []).length;
      var title = state.trace.chatTitle ? state.trace.chatTitle : '当前会话';
      count.textContent = state.trace.query
        ? ('搜索「' + state.trace.query + '」· ' + filtered.length + '/' + total + ' 条')
        : (title + ' · ' + total + ' 条事件');
    }
    var clear = r('trace-search-clear');
    if (clear) clear.hidden = !state.trace.query;
  }

  function renderTrace(data) {
    var normalized = normalizeTraceEvents(data);
    if (Array.isArray(data) || (data && typeof data === 'object' && (Array.isArray(data.events) || Array.isArray(data.trace)))) {
      state.trace.events = normalized.events;
    }
    if (normalized.chatId) state.trace.chatId = normalized.chatId;
    if (normalized.chatTitle) state.trace.chatTitle = normalized.chatTitle;
    state.trace.loaded = true;
    renderTraceList();
    return state.trace.events;
  }

  function openTracePage(chatId) {
    if (chatId != null && String(chatId) !== '') state.trace.chatId = String(chatId);
    showScreenImpl('trace');
    var input = r('trace-search');
    if (input) input.value = state.trace.query || '';
    if (!invoke('onOpenTrace', state.trace.chatId || undefined)) renderTraceList();
  }

  function searchTrace(keyword) {
    state.trace.query = keyword == null ? '' : String(keyword);
    var input = r('trace-search');
    if (input && input.value !== state.trace.query) input.value = state.trace.query;
    renderTraceList();
  }

  function replayToolTrace(traceId) {
    if (!traceId) return;
    if (!invoke('onReplayTool', traceId)) UI.toast('轨迹重放服务尚未就绪');
  }

  /* ================================================================== *
   * 批次 1 · v2.6.0：用量与成本
   * ================================================================== */
  var COST_CURRENCY_SYMBOL = { CNY: '¥', USD: '$', EUR: '€', JPY: 'JP¥', GBP: '£' };

  function costNumber(value) {
    var n = Number(value);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function formatTokenCount(value) {
    var n = costNumber(value);
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  function formatCostValue(value, currency) {
    var n = costNumber(value);
    var symbol = COST_CURRENCY_SYMBOL[String(currency || 'CNY').toUpperCase()] || '';
    if (n === 0) return symbol + '0.00';
    if (n < 0.01) return symbol + n.toFixed(4);
    return symbol + n.toFixed(2);
  }

  function normalizeCostPeriod(period) {
    if (period == null) return { tokens: 0, cost: 0, requests: 0 };
    if (typeof period === 'number') return { tokens: costNumber(period), cost: 0, requests: 0 };
    var tokens = costNumber(period.tokens);
    if (!tokens) tokens = costNumber(period.promptTokens) + costNumber(period.completionTokens);
    if (!tokens) tokens = costNumber(period.prompt_tokens) + costNumber(period.completion_tokens);
    return {
      tokens: tokens,
      cost: costNumber(period.cost != null ? period.cost : period.estimatedCost),
      requests: costNumber(period.requests != null ? period.requests : period.count)
    };
  }

  function normalizeCostData(data) {
    var src = data && typeof data === 'object' ? data : {};
    var currency = src.currency ? String(src.currency).toUpperCase() : 'CNY';
    var today = normalizeCostPeriod(src.today || { tokens: src.todayTokens, cost: src.todayCost });
    var week = normalizeCostPeriod(src.week || { tokens: src.weekTokens, cost: src.weekCost });
    var month = normalizeCostPeriod(src.month || { tokens: src.monthTokens, cost: src.monthCost });

    var models = [];
    var rawModels = src.byModel != null ? src.byModel : src.models;
    if (Array.isArray(rawModels)) {
      rawModels.forEach(function (item, index) {
        if (!item || typeof item !== 'object') return;
        models.push({
          model: item.model != null ? String(item.model) : ('model_' + index),
          tokens: costNumber(item.tokens),
          cost: costNumber(item.cost),
          requests: costNumber(item.requests)
        });
      });
    } else if (rawModels && typeof rawModels === 'object') {
      Object.keys(rawModels).forEach(function (key) {
        var item = rawModels[key];
        if (item && typeof item === 'object') {
          models.push({
            model: String(key),
            tokens: costNumber(item.tokens),
            cost: costNumber(item.cost),
            requests: costNumber(item.requests)
          });
        } else {
          models.push({ model: String(key), tokens: costNumber(item), cost: 0, requests: 0 });
        }
      });
    }
    models.sort(function (a, b) { return b.cost - a.cost || b.tokens - a.tokens; });

    var budgetSrc = src.budget && typeof src.budget === 'object' ? src.budget : {};
    var percentSrc = src.percent && typeof src.percent === 'object' ? src.percent : {};
    var budgets = [];
    function addBudget(key, label, limitValue, usedCost, percentValue) {
      var limit = costNumber(limitValue);
      if (!limit) return;
      var used = costNumber(usedCost);
      var percent = percentValue != null ? costNumber(percentValue) : (used / limit) * 100;
      budgets.push({
        key: key,
        label: label,
        limit: limit,
        used: used,
        percent: Math.max(0, Math.min(500, Math.round(percent)))
      });
    }
    addBudget('daily', '今日预算', budgetSrc.daily != null ? budgetSrc.daily : budgetSrc.dailyLimit, today.cost, percentSrc.daily);
    addBudget('monthly', '本月预算', budgetSrc.monthly != null ? budgetSrc.monthly : budgetSrc.monthlyLimit, month.cost, percentSrc.monthly);

    var alert = null;
    budgets.forEach(function (budget) {
      if (budget.percent > 100) alert = { level: 'over', message: budget.label + '已超限 ' + budget.percent + '%' };
      else if (budget.percent >= 80 && !alert) alert = { level: 'warn', message: budget.label + '已使用 ' + budget.percent + '%' };
    });
    if (src.alert && typeof src.alert === 'object') {
      alert = { level: src.alert.level === 'over' ? 'over' : 'warn', message: src.alert.message != null ? String(src.alert.message) : '' };
    }

    return {
      currency: currency,
      today: today,
      week: week,
      month: month,
      models: models,
      budgets: budgets,
      alert: alert
    };
  }

  function renderCostPeriods(cost) {
    var box = r('cost-periods');
    if (!box) return;
    box.textContent = '';
    var periods = [
      { label: '今日', data: cost.today },
      { label: '本周', data: cost.week },
      { label: '本月', data: cost.month }
    ];
    periods.forEach(function (item) {
      var card = el('div', 'cost-period');
      card.appendChild(makeText('span', 'cost-period-label', item.label));
      card.appendChild(makeText('div', 'cost-period-tokens', formatTokenCount(item.data.tokens)));
      card.appendChild(makeText('div', 'cost-period-cost', formatCostValue(item.data.cost, cost.currency)));
      box.appendChild(card);
    });
  }

  function renderCostModels(cost) {
    var box = r('cost-models');
    if (!box) return;
    box.textContent = '';
    var maxCost = 0;
    cost.models.forEach(function (item) { if (item.cost > maxCost) maxCost = item.cost; });
    cost.models.forEach(function (item) {
      var card = el('div', 'cost-model');
      var head = el('div', 'cost-model-head');
      head.appendChild(makeText('span', 'cost-model-name', item.model));
      head.appendChild(makeText('span', 'cost-model-cost', formatCostValue(item.cost, cost.currency)));
      card.appendChild(head);
      var metaText = formatTokenCount(item.tokens) + ' tokens';
      if (item.requests) metaText += ' · ' + item.requests + ' 次请求';
      card.appendChild(makeText('div', 'cost-model-meta', metaText));
      var track = el('div', 'cost-share-track');
      var fill = el('div', 'cost-share-fill');
      var share = maxCost > 0 ? Math.round((item.cost / maxCost) * 100) : 0;
      fill.style.width = share + '%';
      track.appendChild(fill);
      card.appendChild(track);
      box.appendChild(card);
    });
    var empty = r('cost-empty');
    if (empty) {
      var hasData = cost.models.length > 0 || cost.today.tokens > 0 || cost.week.tokens > 0 || cost.month.tokens > 0;
      empty.hidden = hasData || cost.budgets.length > 0;
    }
  }

  function renderCostBudgets(cost) {
    var box = r('cost-budget');
    if (!box) return;
    box.textContent = '';
    if (!cost.budgets.length) {
      box.appendChild(makeText('div', 'cost-budget-row', '尚未设置预算'));
      return;
    }
    cost.budgets.forEach(function (budget) {
      var row = el('div', 'cost-budget');
      var head = el('div', 'cost-budget-row');
      head.appendChild(makeText('span', 'cost-budget-label', budget.label));
      head.appendChild(makeText('span', 'cost-budget-value',
        formatCostValue(budget.used, cost.currency) + ' / ' + formatCostValue(budget.limit, cost.currency) + ' · ' + budget.percent + '%'));
      row.appendChild(head);
      var track = el('div', 'cost-budget-track');
      var fill = el('div', 'cost-budget-fill');
      fill.style.width = Math.min(100, budget.percent) + '%';
      if (budget.percent > 100) fill.classList.add('is-over');
      else if (budget.percent >= 80) fill.classList.add('is-warn');
      track.appendChild(fill);
      row.appendChild(track);
      box.appendChild(row);
    });
  }

  function renderCostAlert(alert) {
    var box = r('cost-alert');
    if (!box) return;
    if (!alert || !alert.message) {
      box.hidden = true;
      box.textContent = '';
      box.classList.remove('is-over');
      return;
    }
    box.hidden = false;
    box.textContent = alert.message;
    box.classList.toggle('is-over', alert.level === 'over');
  }

  function renderCostPanels() {
    var data = state.cost.data;
    if (!data) {
      var periods = r('cost-periods');
      if (periods) periods.textContent = '';
      var models = r('cost-models');
      if (models) models.textContent = '';
      var budget = r('cost-budget');
      if (budget) budget.textContent = '';
      var empty = r('cost-empty');
      if (empty) empty.hidden = false;
      renderCostAlert(null);
      return;
    }
    renderCostPeriods(data);
    renderCostModels(data);
    renderCostBudgets(data);
    renderCostAlert(state.cost.alert || data.alert);
    var count = r('cost-count');
    if (count) {
      count.textContent = '今日 ' + formatTokenCount(data.today.tokens) + ' tokens · ' +
        formatCostValue(data.today.cost, data.currency) + ' · 本月 ' + formatCostValue(data.month.cost, data.currency);
    }
    var label = r('set-cost-label');
    if (label) label.textContent = '今日 ' + formatCostValue(data.today.cost, data.currency);
  }

  function renderCost(data) {
    state.cost.data = normalizeCostData(data);
    state.cost.alert = state.cost.data.alert;
    state.cost.loaded = true;
    renderCostPanels();
    return state.cost.data;
  }

  function openCostPage() {
    showScreenImpl('cost');
    if (!invoke('onOpenCost')) renderCostPanels();
  }

  function setCostAlert(info) {
    if (!info || typeof info !== 'object') {
      state.cost.alert = null;
      renderCostAlert(null);
      return null;
    }
    state.cost.alert = { level: info.level === 'over' ? 'over' : 'warn', message: info.message == null ? '' : String(info.message) };
    renderCostAlert(state.cost.alert);
    return state.cost.alert;
  }

  /* ================================================================== *
   * 批次 1 · v2.6.0：工具权限策略
   * ================================================================== */
  var POLICY_MODES = [
    { key: 'auto', label: '自动' },
    { key: 'once', label: '首次确认' },
    { key: 'always', label: '每次确认' },
    { key: 'deny', label: '禁止' }
  ];

  function normalizeToolMode(mode) {
    var value = String(mode == null ? '' : mode).toLowerCase();
    if (value === 'auto' || value === 'allow' || value === 'always_allow') return 'auto';
    if (value === 'once' || value === 'first' || value === 'ask_once') return 'once';
    if (value === 'always' || value === 'ask' || value === 'every' || value === 'confirm') return 'always';
    if (value === 'deny' || value === 'block' || value === 'never') return 'deny';
    return 'auto';
  }

  function normalizeToolPolicyList(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (item, index) {
      if (!item) return;
      if (typeof item === 'string') item = { tool: item };
      if (typeof item !== 'object') return;
      var tool = item.tool != null ? String(item.tool) : (item.name != null ? String(item.name) : '');
      if (!tool) return;
      var source = item.source === 'mcp' ? 'mcp'
        : (item.source === 'builtin' ? 'builtin'
          : (tool.indexOf('mcp:') === 0 || tool.indexOf('mcp_') === 0 || tool.indexOf(':') > 0 ? 'mcp' : 'builtin'));
      out.push({
        tool: tool,
        name: item.name != null ? String(item.name) : tool,
        source: source,
        server: item.server != null ? String(item.server) : (item.serverId != null ? String(item.serverId) : ''),
        risk: item.risk != null ? String(item.risk).toLowerCase() : '',
        mode: normalizeToolMode(item.mode),
        explicit: item.explicit === true
      });
    });
    return out;
  }

  function buildToolPolicyRow(item) {
    var row = el('div', 'tool-policy-row');
    row.setAttribute('data-tool', item.tool);
    var head = el('div', 'tool-policy-head');
    head.appendChild(makeText('span', 'tool-policy-name', item.name || item.tool));
    if (item.risk) head.appendChild(makeText('span', 'tool-policy-risk tool-policy-risk--' + item.risk, item.risk.toUpperCase()));
    head.appendChild(makeText('span', 'tool-policy-source', item.source === 'mcp' ? 'MCP' : '内置'));
    row.appendChild(head);

    var modes = el('div', 'policy-modes');
    POLICY_MODES.forEach(function (mode) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'policy-mode' + (mode.key === item.mode ? ' is-active' : '') + (mode.key === 'deny' ? ' policy-mode--danger' : '');
      btn.setAttribute('data-action', 'tool-policy');
      btn.setAttribute('data-tool', item.tool);
      btn.setAttribute('data-mode', mode.key);
      btn.textContent = mode.label;
      modes.appendChild(btn);
    });
    row.appendChild(modes);
    return row;
  }

  function renderToolPolicyRows() {
    var builtinBox = r('tool-policy-list');
    var mcpBox = r('tool-policy-mcp-list');
    var builtin = [];
    var mcpItems = [];
    (state.toolPolicies.list || []).forEach(function (item) {
      if (item.source === 'mcp') mcpItems.push(item);
      else builtin.push(item);
    });
    if (builtinBox) {
      builtinBox.textContent = '';
      builtin.forEach(function (item) { builtinBox.appendChild(buildToolPolicyRow(item)); });
    }
    if (mcpBox) {
      mcpBox.textContent = '';
      mcpItems.forEach(function (item) { mcpBox.appendChild(buildToolPolicyRow(item)); });
    }
    var mcpLabel = r('tool-policy-mcp-label');
    if (mcpLabel) mcpLabel.hidden = mcpItems.length === 0;
    var total = (state.toolPolicies.list || []).length;
    var empty = r('tool-policy-empty');
    if (empty) empty.hidden = total > 0;
    var count = r('tool-policy-count');
    if (count) count.textContent = total ? (total + ' 个工具 · 点击切换策略') : '自动 / 首次确认 / 每次确认 / 禁止';
    var label = r('set-tool-policy-label');
    if (label) label.textContent = total ? (total + ' 个工具') : '自动 / 确认 / 禁止';
  }

  function renderToolPolicies(list) {
    state.toolPolicies.list = normalizeToolPolicyList(list);
    state.toolPolicies.loaded = true;
    renderToolPolicyRows();
    return state.toolPolicies.list;
  }

  function openToolPolicyPage() {
    showScreenImpl('tool-policy');
    if (!invoke('onOpenToolPolicies')) renderToolPolicyRows();
  }

  function setToolPolicyMode(tool, mode) {
    var key = String(tool == null ? '' : tool);
    var next = normalizeToolMode(mode);
    var target = null;
    (state.toolPolicies.list || []).forEach(function (item) {
      if (item.tool === key) target = item;
    });
    if (!target) return false;
    var previous = target.mode;
    target.mode = next;
    target.explicit = true;
    renderToolPolicyRows();
    if (!invoke('onSaveToolPolicy', key, next)) {
      target.mode = previous;
      renderToolPolicyRows();
      UI.toast('工具权限服务尚未就绪');
      return false;
    }
    return true;
  }

  /* ================================================================== *
   * 批次 1 · v2.6.0：斜杠命令面板
   * ================================================================== */
  var DEFAULT_SLASH_COMMANDS = [
    { cmd: '/new', desc: '新建会话' },
    { cmd: '/clear', desc: '清空当前会话' },
    { cmd: '/model', desc: '选择或切换模型' },
    { cmd: '/export', desc: '导出当前会话 Markdown' },
    { cmd: '/audit', desc: '查看审计日志' },
    { cmd: '/trace', desc: '查看运行轨迹' },
    { cmd: '/cost', desc: '查看用量与成本' },
    { cmd: '/mcp', desc: '管理 MCP 服务器' },
    { cmd: '/workbench', desc: '切换工作台三栏' },
    { cmd: '/stop', desc: '停止当前生成' },
    { cmd: '/help', desc: '查看全部命令' },
    { cmd: '/settings', desc: '打开设置' },
    { cmd: '/models', desc: '从 API 刷新模型列表' }
  ];

  function normalizeSlashCommands(commands) {
    var out = [];
    var seen = {};
    (Array.isArray(commands) ? commands : []).forEach(function (item) {
      if (item == null) return;
      if (typeof item === 'string') item = { cmd: item };
      if (typeof item !== 'object') return;
      var cmd = item.cmd != null ? String(item.cmd) : (item.name != null ? String(item.name) : (item.command != null ? String(item.command) : ''));
      cmd = cmd.trim();
      if (!cmd) return;
      if (cmd.charAt(0) !== '/') cmd = '/' + cmd;
      if (seen[cmd]) return;
      seen[cmd] = true;
      out.push({
        cmd: cmd,
        desc: item.desc != null ? String(item.desc) : (item.description != null ? String(item.description) : ''),
        usage: item.usage != null ? String(item.usage) : ''
      });
    });
    return out;
  }

  function slashCommandSource() {
    if (state.slash.custom) return state.slash.custom;
    try {
      if (window.App && typeof window.App.getSlashCommands === 'function') {
        var list = normalizeSlashCommands(window.App.getSlashCommands());
        if (list.length) return list;
      }
    } catch (err) { /* 静默 */ }
    return normalizeSlashCommands(DEFAULT_SLASH_COMMANDS);
  }

  function slashQueryFromComposer() {
    var input = r('composer-input');
    if (!input) return null;
    var value = String(input.value || '');
    var match = /^\/([^\s]*)$/.exec(value);
    if (!match) return null;
    return match[1].toLowerCase();
  }

  function renderSlashMenu() {
    var box = r('slash-list');
    if (!box) return;
    var query = String(state.slash.query || '').toLowerCase();
    var list = state.slash.commands.filter(function (command) {
      if (!query) return true;
      return command.cmd.toLowerCase().indexOf('/' + query) === 0 ||
        command.cmd.toLowerCase().indexOf(query) >= 0 ||
        command.desc.toLowerCase().indexOf(query) >= 0;
    });
    state.slash.filtered = list;
    if (state.slash.index >= list.length) state.slash.index = Math.max(0, list.length - 1);
    box.textContent = '';
    list.forEach(function (command, index) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'slash-item' + (index === state.slash.index ? ' is-active' : '');
      item.setAttribute('data-action', 'slash-pick');
      item.setAttribute('data-index', String(index));
      item.appendChild(makeText('span', 'slash-cmd', command.cmd));
      item.appendChild(makeText('span', 'slash-desc', command.desc || command.usage || ''));
      box.appendChild(item);
    });
    var menu = r('slash-menu');
    if (menu) {
      menu.hidden = list.length === 0;
      if (list.length) positionSlashMenu();
    }
  }

  function positionSlashMenu() {
    var menu = r('slash-menu');
    var composer = r('composer');
    if (!menu || !composer) return;
    var height = composer.offsetHeight || 62;
    menu.style.bottom = (height + 8) + 'px';
  }

  function openSlashMenu(commands) {
    state.slash.commands = normalizeSlashCommands(commands || slashCommandSource());
    state.slash.open = true;
    state.slash.index = 0;
    state.slash.query = slashQueryFromComposer() || '';
    var menu = r('slash-menu');
    if (menu) {
      menu.hidden = false;
      menu.setAttribute('aria-hidden', 'false');
    }
    renderSlashMenu();
  }

  function closeSlashMenu() {
    state.slash.open = false;
    state.slash.filtered = [];
    state.slash.index = 0;
    var menu = r('slash-menu');
    if (menu) {
      menu.hidden = true;
      menu.setAttribute('aria-hidden', 'true');
    }
  }

  function moveSlashMenu(delta) {
    var count = state.slash.filtered.length;
    if (!count) return;
    state.slash.index = (state.slash.index + delta + count) % count;
    renderSlashMenu();
    var active = document.querySelector('#slash-list .slash-item.is-active');
    if (active && active.scrollIntoView) {
      try { active.scrollIntoView({ block: 'nearest' }); } catch (err) { /* 静默 */ }
    }
  }

  function pickSlashCommand(index) {
    var position = Number(index);
    var command = state.slash.filtered[position];
    if (!command) return;
    var input = r('composer-input');
    if (input) {
      input.value = command.cmd + ' ';
      autosize();
      try { input.focus(); } catch (err) { /* 静默 */ }
    }
    closeSlashMenu();
  }

  function updateSlashFromComposer() {
    var query = slashQueryFromComposer();
    if (query === null) {
      if (state.slash.open) closeSlashMenu();
      return;
    }
    if (!state.slash.open) openSlashMenu();
    else {
      state.slash.query = query;
      state.slash.index = 0;
      renderSlashMenu();
    }
  }

  function setSlashCommands(commands) {
    state.slash.custom = normalizeSlashCommands(commands);
    if (state.slash.open) openSlashMenu(state.slash.custom);
    return state.slash.custom;
  }

  /* ================================================================== *
   * 批次 2 · v2.7.0：快照与回滚
   * data: [{id,label?,reason?,ts|createdAt,count|fileCount,files?,size?,changes?/diffs?}]
   * diff: {id,changes:[{path,status:'added'|'modified'|'deleted',oldSize,newSize}]}
   * ================================================================== */
  function formatByteSize(value) {
    var size = Number(value);
    if (!isFinite(size) || size <= 0) return '0 B';
    if (size < 1024) return Math.round(size) + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10240 ? 1 : 0) + ' KB';
    if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB';
    return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function snapshotTimeText(value) {
    var date = toDate(value);
    if (!date) return '';
    var now = new Date();
    var sameDay = date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    var time = pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    if (sameDay) return '今天 ' + time;
    return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + time;
  }

  function normalizeSnapshotChange(change) {
    if (!change || typeof change !== 'object') return null;
    var path = change.path != null ? String(change.path)
      : (change.file != null ? String(change.file) : '');
    if (!path) return null;
    var status = String(change.status == null ? '' : change.status).toLowerCase();
    if (status === 'add' || status === 'added' || status === 'create' || status === 'created' || status === 'new') status = 'added';
    else if (status === 'delete' || status === 'deleted' || status === 'remove' || status === 'removed') status = 'deleted';
    else status = 'modified';
    var before = change.oldSize != null ? change.oldSize : change.sizeBefore;
    var after = change.newSize != null ? change.newSize : change.sizeAfter;
    if (before == null && change.before != null) before = change.before;
    if (after == null && change.after != null) after = change.after;
    return {
      path: path,
      status: status,
      oldSize: before == null ? null : Number(before),
      newSize: after == null ? null : Number(after)
    };
  }

  function normalizeSnapshotChanges(value) {
    var out = [];
    (Array.isArray(value) ? value : []).forEach(function (change) {
      var normalized = normalizeSnapshotChange(change);
      if (normalized) out.push(normalized);
    });
    return out;
  }

  function normalizeSnapshotList(data) {
    var list = [];
    var source = data;
    if (data && typeof data === 'object' && !Array.isArray(data)) source = data.snapshots || data.list || [];
    (Array.isArray(source) ? source : []).forEach(function (item, index) {
      if (!item || typeof item !== 'object') return;
      var id = item.id != null ? String(item.id) : ('snapshot_' + index);
      var changes = normalizeSnapshotChanges(item.changes != null ? item.changes : item.diffs);
      var count = item.count != null ? item.count : (item.fileCount != null ? item.fileCount : (Array.isArray(item.files) ? item.files.length : changes.length));
      list.push({
        id: id,
        label: item.label != null ? String(item.label) : '',
        reason: item.reason != null ? String(item.reason) : (item.label != null ? String(item.label) : '工作区快照'),
        ts: item.ts != null ? item.ts : (item.createdAt != null ? item.createdAt : item.at),
        count: Number(count) || 0,
        size: item.size != null ? item.size : item.totalSize,
        changes: changes
      });
    });
    return list;
  }

  function snapshotDiffText(change) {
    var before = change.oldSize;
    var after = change.newSize;
    if (change.status === 'added') return after != null ? '新增 ' + formatByteSize(after) : '新增';
    if (change.status === 'deleted') return before != null ? '删除 ' + formatByteSize(before) : '删除';
    if (before != null && after != null) return formatByteSize(before) + ' → ' + formatByteSize(after);
    if (after != null) return formatByteSize(after);
    if (before != null) return formatByteSize(before);
    return '修改';
  }

  function snapshotStatusText(status) {
    if (status === 'added') return 'A';
    if (status === 'deleted') return 'D';
    return 'M';
  }

  function findSnapshot(id) {
    var key = String(id == null ? '' : id);
    var found = null;
    (state.snapshots.list || []).forEach(function (item) {
      if (item.id === key) found = item;
    });
    return found;
  }

  function snapshotChangesFor(snapshot) {
    var id = snapshot.id;
    var cached = state.snapshots.diffs[id];
    if (Array.isArray(cached)) return cached;
    if (Array.isArray(snapshot.changes) && snapshot.changes.length) {
      state.snapshots.diffs[id] = snapshot.changes.slice();
      return state.snapshots.diffs[id];
    }
    return null;
  }

  function renderSnapshotDiffList(container, changes) {
    if (!container) return;
    container.textContent = '';
    if (!changes || !changes.length) {
      container.appendChild(makeText('div', 'snapshot-diff-empty', '没有文件差异'));
      return;
    }
    changes.forEach(function (change) {
      var row = el('div', 'snapshot-diff snapshot-diff--' + change.status);
      row.appendChild(makeText('span', 'snapshot-diff-icon', snapshotStatusText(change.status)));
      row.appendChild(makeText('span', 'snapshot-diff-path', change.path));
      row.appendChild(makeText('span', 'snapshot-diff-size', snapshotDiffText(change)));
      container.appendChild(row);
    });
  }

  function snapshotCardNode(snapshot) {
    var open = state.snapshots.openId === snapshot.id;
    var card = el('div', 'snapshot-card' + (open ? ' is-open' : ''));
    card.setAttribute('data-snapshot-id', snapshot.id);

    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'snapshot-head';
    head.setAttribute('data-action', 'snapshot-toggle');
    head.setAttribute('data-id', snapshot.id);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    var icon = el('span', 'snapshot-icon');
    icon.innerHTML = ICON.folder;
    head.appendChild(icon);
    var main = el('div', 'snapshot-main');
    var titleRow = el('div', 'snapshot-title-row');
    titleRow.appendChild(makeText('span', 'snapshot-reason', snapshot.reason || '工作区快照'));
    titleRow.appendChild(makeText('span', 'snapshot-time', snapshotTimeText(snapshot.ts)));
    main.appendChild(titleRow);
    var metaText = snapshot.count + ' 个文件';
    if (snapshot.size != null) metaText += ' · ' + formatByteSize(snapshot.size);
    main.appendChild(makeText('div', 'snapshot-meta', metaText));
    head.appendChild(main);
    var caret = el('span', 'snapshot-caret');
    caret.innerHTML = ICON.chevronDown;
    head.appendChild(caret);
    card.appendChild(head);

    var body = el('div', 'snapshot-body');
    var diffList = el('div', 'snapshot-diff-list');
    if (state.snapshots.loadingId === snapshot.id) {
      body.appendChild(makeText('div', 'snapshot-loading', '正在加载差异…'));
    } else {
      var changes = snapshotChangesFor(snapshot);
      if (changes) renderSnapshotDiffList(diffList, changes);
      else {
        body.appendChild(makeText('div', 'snapshot-diff-empty', '展开后加载文件差异'));
      }
      body.appendChild(diffList);
    }
    var actions = el('div', 'snapshot-actions');
    var restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'snapshot-act snapshot-act--primary';
    restore.setAttribute('data-action', 'restore-snapshot');
    restore.setAttribute('data-id', snapshot.id);
    restore.textContent = '恢复此快照';
    actions.appendChild(restore);
    var diffBtn = document.createElement('button');
    diffBtn.type = 'button';
    diffBtn.className = 'snapshot-act';
    diffBtn.setAttribute('data-action', 'snapshot-diff');
    diffBtn.setAttribute('data-id', snapshot.id);
    diffBtn.textContent = '查看差异';
    actions.appendChild(diffBtn);
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'snapshot-act snapshot-act--ghost';
    del.setAttribute('data-action', 'delete-snapshot');
    del.setAttribute('data-id', snapshot.id);
    del.textContent = '删除';
    actions.appendChild(del);
    body.appendChild(actions);
    card.appendChild(body);
    return card;
  }

  function renderSnapshotList() {
    var box = r('snapshots-list');
    if (box) {
      box.textContent = '';
      (state.snapshots.list || []).forEach(function (snapshot) {
        box.appendChild(snapshotCardNode(snapshot));
      });
    }
    var empty = r('snapshots-empty');
    if (empty) empty.hidden = (state.snapshots.list || []).length > 0;
    var count = r('snapshots-count');
    if (count) count.textContent = state.snapshots.list.length
      ? (state.snapshots.list.length + ' 个快照 · 点击展开差异')
      : '工作区改动前的备份';
    var label = r('set-snapshots-label');
    if (label) label.textContent = state.snapshots.list.length ? (state.snapshots.list.length + ' 个快照') : '未创建';
  }

  function renderSnapshots(data) {
    state.snapshots.list = normalizeSnapshotList(data);
    state.snapshots.loaded = true;
    if (state.snapshots.openId && !findSnapshot(state.snapshots.openId)) state.snapshots.openId = null;
    renderSnapshotList();
    return state.snapshots.list;
  }

  function renderSnapshotDiff(diff) {
    var id = '';
    var changes = [];
    if (Array.isArray(diff)) {
      id = state.snapshots.openId || '';
      changes = normalizeSnapshotChanges(diff);
    } else if (diff && typeof diff === 'object') {
      id = diff.id != null ? String(diff.id) : (state.snapshots.openId || '');
      changes = normalizeSnapshotChanges(diff.changes != null ? diff.changes : diff.diffs);
    }
    if (!id) return [];
    state.snapshots.diffs[id] = changes;
    state.snapshots.loadingId = null;
    state.snapshots.openId = id;
    var snapshot = findSnapshot(id);
    if (snapshot) snapshot.changes = changes;
    renderSnapshotList();
    return changes;
  }

  function renderSnapshotDiffs(id, changes) {
    return renderSnapshotDiff({ id: id, changes: changes });
  }

  function toggleSnapshot(snapshotId) {
    var id = String(snapshotId == null ? '' : snapshotId);
    if (!id) return;
    if (state.snapshots.openId === id) {
      state.snapshots.openId = null;
      renderSnapshotList();
      return;
    }
    state.snapshots.openId = id;
    var snapshot = findSnapshot(id);
    var cached = snapshot ? snapshotChangesFor(snapshot) : null;
    if (!cached && typeof state.cb.onDiffSnapshot === 'function') {
      state.snapshots.loadingId = id;
      renderSnapshotList();
      invoke('onDiffSnapshot', id);
    } else {
      state.snapshots.loadingId = null;
      renderSnapshotList();
    }
  }

  function loadSnapshotDiff(snapshotId) {
    var id = String(snapshotId == null ? '' : snapshotId);
    if (!id) return;
    state.snapshots.openId = id;
    var snapshot = findSnapshot(id);
    var cached = snapshot ? snapshotChangesFor(snapshot) : null;
    if (cached) {
      renderSnapshotList();
      return;
    }
    if (typeof state.cb.onDiffSnapshot === 'function') {
      state.snapshots.loadingId = id;
      renderSnapshotList();
      invoke('onDiffSnapshot', id);
    } else {
      state.snapshots.loadingId = null;
      renderSnapshotList();
      UI.toast('暂无可用的差异数据');
    }
  }

  function refreshSnapshotsAfterAction() {
    if (state.screen !== 'snapshots') return;
    if (!invoke('onOpenSnapshots')) renderSnapshotList();
  }

  function openSnapshotsPage() {
    showScreenImpl('snapshots');
    if (!invoke('onOpenSnapshots')) renderSnapshotList();
  }

  function createSnapshot() {
    var result = callHandler('onCreateSnapshot');
    if (result === undefined) {
      UI.toast('快照服务尚未就绪');
      return;
    }
    if (typeof result.then === 'function') result.then(refreshSnapshotsAfterAction, function () { /* 静默 */ });
    else refreshSnapshotsAfterAction();
  }

  function restoreSnapshot(snapshotId) {
    if (!snapshotId) return;
    var result = callHandler('onRestoreSnapshot', snapshotId);
    if (result === undefined) {
      UI.toast('快照回滚服务尚未就绪');
      return;
    }
    if (result && typeof result.then === 'function') result.then(refreshSnapshotsAfterAction, function () { /* 静默 */ });
    else refreshSnapshotsAfterAction();
  }

  function deleteSnapshot(snapshotId) {
    if (!snapshotId) return;
    var snapshot = findSnapshot(snapshotId);
    var label = snapshot && snapshot.reason ? '「' + snapshot.reason + '」' : '该快照';
    confirmDialog('删除快照', '确定删除' + label + '吗？删除后无法再回滚到该状态。').then(function (ok) {
      if (!ok) return;
      if (!invoke('onDeleteSnapshot', snapshotId)) UI.toast('快照服务尚未就绪');
      else refreshSnapshotsAfterAction();
    });
  }

  /* ================================================================== *
   * 批次 2 · v2.7.0：安全 PIN / 密码输入
   * ================================================================== */
  function isPinDigits(value) {
    return /^\d{4,6}$/.test(String(value == null ? '' : value));
  }

  function setPinError(elementId, text) {
    var el = r(elementId);
    var message = text == null ? '' : String(text);
    if (el) {
      el.textContent = message;
      el.hidden = !message;
    }
  }

  function updatePinStatusDom() {
    var toggle = r('set-pin');
    if (toggle) toggle.checked = !!state.security.pin;
    var status = r('set-pin-status');
    if (!status) return;
    status.classList.remove('is-on', 'is-warn', 'is-locked');
    if (state.security.pinLocked) {
      status.textContent = '已锁定，请稍后重试';
      status.classList.add('is-locked');
    } else if (state.security.pin) {
      status.textContent = '已设置';
      status.classList.add('is-on');
    } else {
      status.textContent = '未设置';
      status.classList.add('is-warn');
    }
  }

  function resolvePin(value) {
    closeModal(r('pin-modal'));
    var resolve = state.pin.resolve;
    state.pin.resolve = null;
    if (typeof resolve === 'function') resolve(!!value);
  }

  function requirePin(title) {
    if (state.pin.resolve) resolvePin(false);
    var titleEl = r('pin-title');
    if (titleEl) titleEl.textContent = title == null || title === '' ? '验证安全 PIN' : String(title);
    var messageEl = r('pin-message');
    if (messageEl) messageEl.textContent = '请输入 4-6 位安全 PIN 以继续。';
    var input = r('pin-input');
    if (input) input.value = '';
    setPinError('pin-error', '');
    openModal(r('pin-modal'));
    setTimeout(function () {
      var field = r('pin-input');
      if (!field) return;
      try { field.focus(); } catch (err) { /* 静默 */ }
    }, 80);
    return new Promise(function (resolve) {
      state.pin.resolve = resolve;
    });
  }

  function submitPin() {
    var input = r('pin-input');
    var pin = input ? String(input.value || '').replace(/\s/g, '') : '';
    if (!isPinDigits(pin)) {
      setPinError('pin-error', '请输入 4-6 位数字 PIN');
      return;
    }
    var result = callHandler('onVerifyPin', pin);
    if (result === undefined) {
      setPinError('pin-error', 'PIN 服务尚未就绪');
      resolvePin(false);
      return;
    }
    Promise.resolve(result).then(function (ok) {
      if (ok) {
        setPinError('pin-error', '');
        resolvePin(true);
        return;
      }
      setPinError('pin-error', 'PIN 不正确或已锁定');
      setTimeout(function () {
        if (state.pin.resolve) resolvePin(false);
        else closeModal(r('pin-modal'));
      }, 700);
      if (state.pin.resolve) {
        var resolve = state.pin.resolve;
        state.pin.resolve = null;
        resolve(false);
      }
    }, function () {
      setPinError('pin-error', 'PIN 校验失败');
      resolvePin(false);
    });
  }

  function openPinSetup() {
    setVal('pin-setup-new', '');
    setVal('pin-setup-confirm', '');
    setPinError('pin-setup-error', '');
    openModal(r('pin-setup-modal'));
    setTimeout(function () {
      var input = r('pin-setup-new');
      if (!input) return;
      try { input.focus(); } catch (err) { /* 静默 */ }
    }, 80);
  }

  function closePinSetup() {
    closeModal(r('pin-setup-modal'));
    setPinError('pin-setup-error', '');
    if (state.pin.setupForToggle) {
      state.pin.setupForToggle = false;
      var toggle = r('set-pin');
      if (toggle) toggle.checked = !!state.security.pin;
    }
  }

  function submitPinSetup() {
    var newInput = r('pin-setup-new');
    var confirmInput = r('pin-setup-confirm');
    var pin = newInput ? String(newInput.value || '').replace(/\s/g, '') : '';
    var confirm = confirmInput ? String(confirmInput.value || '').replace(/\s/g, '') : '';
    if (!isPinDigits(pin)) {
      setPinError('pin-setup-error', '请输入 4-6 位数字 PIN');
      return;
    }
    if (pin !== confirm) {
      setPinError('pin-setup-error', '两次输入的 PIN 不一致');
      return;
    }
    var result = callHandler('onSetPin', pin);
    if (result === undefined) {
      setPinError('pin-setup-error', 'PIN 服务尚未就绪');
      return;
    }
    Promise.resolve(result).then(function (ok) {
      if (ok === false) {
        setPinError('pin-setup-error', '设置 PIN 失败');
        return;
      }
      state.security.pin = true;
      state.pin.setupForToggle = false;
      closeModal(r('pin-setup-modal'));
      setPinError('pin-setup-error', '');
      updatePinStatusDom();
      UI.toast('安全 PIN 已设置');
    }, function () {
      setPinError('pin-setup-error', '设置 PIN 失败');
    });
  }

  function setPinEnabled(enabled) {
    var toggle = r('set-pin');
    if (enabled) {
      state.pin.setupForToggle = true;
      openPinSetup();
      return;
    }
    confirmDialog('关闭安全 PIN', '关闭后恢复快照等敏感操作将不再需要 PIN。确定关闭吗？').then(function (ok) {
      if (!ok) {
        if (toggle) toggle.checked = true;
        return;
      }
      var result = typeof state.cb.onDisablePin === 'function'
        ? callHandler('onDisablePin')
        : callHandler('onSetPin', '');
      if (result === undefined) {
        UI.toast('PIN 服务尚未就绪');
        if (toggle) toggle.checked = true;
        return;
      }
      Promise.resolve(result).then(function (done) {
        if (done === false) {
          UI.toast('关闭 PIN 失败');
          if (toggle) toggle.checked = true;
          return;
        }
        state.security.pin = false;
        updatePinStatusDom();
        UI.toast('安全 PIN 已关闭');
      }, function () {
        if (toggle) toggle.checked = true;
      });
    });
  }

  function setPasswordError(text) {
    setPinError('password-error', text);
  }

  function resolvePassword(value) {
    closeModal(r('password-modal'));
    var resolve = state.pin.passwordResolve;
    state.pin.passwordResolve = null;
    if (typeof resolve === 'function') resolve(value == null ? null : String(value));
  }

  function requirePassword(titleOrOptions) {
    if (state.pin.passwordResolve) resolvePassword(null);
    var options = typeof titleOrOptions === 'string' ? { title: titleOrOptions }
      : (titleOrOptions && typeof titleOrOptions === 'object' ? titleOrOptions : {});
    var titleEl = r('password-title');
    if (titleEl) titleEl.textContent = options.title ? String(options.title) : '输入密码';
    var messageEl = r('password-message');
    if (messageEl) messageEl.textContent = options.message ? String(options.message) : '请输入密码以继续。';
    var input = r('password-input');
    if (input) input.value = '';
    setPasswordError('');
    openModal(r('password-modal'));
    setTimeout(function () {
      var field = r('password-input');
      if (!field) return;
      try { field.focus(); } catch (err) { /* 静默 */ }
    }, 80);
    return new Promise(function (resolve) {
      state.pin.passwordResolve = resolve;
    });
  }

  function submitPassword() {
    var input = r('password-input');
    var value = input ? String(input.value || '') : '';
    if (!value) {
      setPasswordError('请输入密码');
      return;
    }
    setPasswordError('');
    resolvePassword(value);
  }

  /* ================================================================== *
   * 批次 2 · v2.7.0：加密备份
   * ================================================================== */
  function setBackupError(text) {
    var error = r('backup-error');
    var message = text == null ? '' : String(text);
    if (error) {
      error.textContent = message;
      error.hidden = !message;
    }
  }

  function readBackupForm() {
    var encryptInput = r('backup-encrypt');
    var passwordInput = r('backup-password');
    return {
      encrypt: !!(encryptInput && encryptInput.checked),
      password: passwordInput ? String(passwordInput.value || '') : ''
    };
  }

  function doExportBackup() {
    var form = readBackupForm();
    if (form.encrypt && !form.password) {
      setBackupError('勾选「使用密码加密」后请输入密码');
      return;
    }
    setBackupError('');
    closeModal(r('backup-modal'));
    if (!invoke('onExportBackup', { encrypt: form.encrypt, password: form.password })) {
      UI.toast('备份服务尚未就绪');
    }
  }

  function doImportBackup() {
    var form = readBackupForm();
    setBackupError('');
    closeModal(r('backup-modal'));
    if (!invoke('onImportBackup', { password: form.password })) {
      UI.toast('备份服务尚未就绪');
    }
  }

  /* ================================================================== *
   * 批次 2 · v2.7.0：失败诊断卡 / 工具卡快照徽标
   * ================================================================== */
  function toolDiagnosticsOf(msg) {
    var source = msg || {};
    var diag = source.diagnostics && typeof source.diagnostics === 'object' ? source.diagnostics : {};
    var exitCode = diag.exitCode != null ? diag.exitCode : (source.exitCode != null ? source.exitCode : null);
    var stderr = diag.stderrTail != null ? diag.stderrTail
      : (diag.stderr != null ? diag.stderr : (source.stderr != null ? source.stderr : ''));
    var hint = diag.hint != null ? diag.hint : (diag.suggestion != null ? diag.suggestion : (source.suggestion != null ? source.suggestion : ''));
    var hints = [];
    if (Array.isArray(diag.hints)) hints = diag.hints.map(function (item) { return String(item); });
    else if (Array.isArray(source.hints)) hints = source.hints.map(function (item) { return String(item); });
    return {
      exitCode: exitCode,
      stderr: stderr == null ? '' : String(stderr),
      hint: hint == null ? '' : String(hint),
      hints: hints,
      path: diag.path != null ? String(diag.path) : '',
      command: diag.command != null ? String(diag.command) : '',
      durationMs: diag.durationMs
    };
  }

  function applyToolDiagnostics(msg, refs) {
    var diag = refs.toolDiag;
    if (!diag) return;
    var info = toolDiagnosticsOf(msg);
    var hasAny = info.exitCode != null || info.stderr !== '' || info.hint !== '' ||
      info.hints.length > 0 || info.path !== '' || info.command !== '';
    diag.root.hidden = !hasAny;
    if (!hasAny) return;

    var key = [info.exitCode, info.stderr.length, info.hint, info.hints.join('|'), info.path, info.command].join('~');
    if (refs.diagKey !== key) {
      refs.diagKey = key;
      diag.body.textContent = '';

      function addRow(label, value) {
        if (value == null || String(value) === '') return;
        var row = el('div', 'tool-diag-row');
        row.appendChild(makeText('span', 'tool-diag-label', label));
        row.appendChild(makeText('span', 'tool-diag-value', String(value)));
        diag.body.appendChild(row);
      }
      if (info.exitCode != null) addRow('退出码', String(info.exitCode));
      if (info.command) addRow('命令', info.command);
      if (info.path) addRow('路径', info.path);
      if (info.durationMs != null) addRow('耗时', traceDurationText(info.durationMs));
      if (info.stderr) {
        var stderrRow = el('div', 'tool-diag-row');
        stderrRow.appendChild(makeText('span', 'tool-diag-label', 'stderr'));
        stderrRow.appendChild(makeText('span', 'tool-diag-value', '错误输出（尾部）'));
        diag.body.appendChild(stderrRow);
        var pre = el('pre', 'tool-diag-code');
        var stderrText = info.stderr.length > 4000 ? info.stderr.slice(-4000) : info.stderr;
        pre.textContent = stderrText;
        diag.body.appendChild(pre);
      }
      if (info.hint) {
        var hintRow = el('div', 'tool-diag-row');
        hintRow.appendChild(makeText('span', 'tool-diag-label', '建议'));
        hintRow.appendChild(makeText('span', 'tool-diag-value', info.hint));
        diag.body.appendChild(hintRow);
      }
      if (info.hints.length) {
        var list = el('ul', 'tool-diag-hints');
        info.hints.forEach(function (item) { list.appendChild(makeText('li', '', item)); });
        diag.body.appendChild(list);
      }
      if (msg.ok === false && !refs.diagUserToggled) diag.root.open = true;
    }
  }

  function applyToolSnapshotBadge(msg, refs) {
    var badge = refs.snapshotBadge;
    if (!badge) return;
    var snapshotId = msg.snapshotId != null ? msg.snapshotId : msg.lastSnapshotId;
    if (snapshotId == null || snapshotId === '') {
      badge.hidden = true;
      return;
    }
    var count = Number(msg.snapshotCount);
    badge.hidden = false;
    badge.textContent = isFinite(count) && count > 1 ? ('已备份 · ' + count) : '已备份';
    badge.title = '快照：' + String(snapshotId);
  }

  /* ================================================================== *
   * 批次 3 · v2.8.0：外观（主题 / 字号 / 壁纸 / 液态玻璃 / 语言）
   * ================================================================== */
  var THEME_VALUES = { dark: 1, midnight: 1, black: 1 };
  var FONT_SCALES = [0.9, 1, 1.1, 1.2];

  function normalizeThemeName(theme) {
    var value = String(theme == null ? '' : theme).toLowerCase();
    if (value === 'midnight' || value === 'blue' || value === 'midnight_blue') return 'midnight';
    if (value === 'black' || value === 'oled' || value === 'pure_black') return 'black';
    return 'dark';
  }

  function normalizeFontScale(value) {
    var scale = Number(value);
    if (!isFinite(scale)) return 1;
    var best = 1;
    var bestDiff = Infinity;
    FONT_SCALES.forEach(function (item) {
      var diff = Math.abs(item - scale);
      if (diff < bestDiff) { bestDiff = diff; best = item; }
    });
    return best;
  }

  function clampNumber(value, min, max, fallback) {
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function applyTheme(theme) {
    var value = normalizeThemeName(theme);
    state.appearance.theme = value;
    var root = document.documentElement;
    if (root) root.setAttribute('data-theme', value);
    var cards = document.querySelectorAll('#appearance-theme-list [data-theme]');
    Array.prototype.forEach.call(cards, function (card) {
      card.classList.toggle('is-active', card.getAttribute('data-theme') === value);
    });
    return value;
  }

  function setFontScale(scale) {
    var value = normalizeFontScale(scale);
    state.appearance.fontScale = value;
    var root = document.documentElement;
    if (root) root.setAttribute('data-font-scale', String(value));
    var buttons = document.querySelectorAll('#appearance-font-list [data-scale]');
    Array.prototype.forEach.call(buttons, function (button) {
      button.classList.toggle('is-active', Number(button.getAttribute('data-scale')) === value);
    });
    return value;
  }

  function applyWallpaper(dataUrl) {
    var value = dataUrl == null ? '' : String(dataUrl);
    state.appearance.wallpaper = value;
    var root = document.documentElement;
    try {
      if (root) root.style.setProperty('--chat-wallpaper', value ? ('url("' + value + '")') : 'none');
    } catch (err) { /* 静默 */ }
    var img = r('appearance-wallpaper-img');
    var empty = r('appearance-wallpaper-empty');
    if (img) {
      if (value) {
        img.src = value;
        img.hidden = false;
      } else {
        img.src = '';
        img.hidden = true;
      }
    }
    if (empty) empty.hidden = !!value;
    return value;
  }

  function clearWallpaper() {
    return applyWallpaper('');
  }

  function applyGlassOptions(options) {
    var data = options && typeof options === 'object' ? options : {};
    var intensity = clampNumber(data.intensity, 0, 100, state.appearance.glass.intensity);
    var speed = clampNumber(data.speed, 0.2, 3, state.appearance.glass.speed);
    state.appearance.glass = { intensity: Math.round(intensity), speed: Math.round(speed * 10) / 10 };
    var root = document.documentElement;
    if (root) {
      var alpha = 0.3 + (state.appearance.glass.intensity / 100) * 0.45;
      var blur = 6 + (state.appearance.glass.intensity / 100) * 30;
      var sheen = 0.2 + (state.appearance.glass.intensity / 100) * 0.7;
      var duration = 9 / state.appearance.glass.speed;
      root.style.setProperty('--glass-surface-alpha', alpha.toFixed(3));
      root.style.setProperty('--glass-blur', blur.toFixed(1) + 'px');
      root.style.setProperty('--glass-sheen-opacity', sheen.toFixed(3));
      root.style.setProperty('--liquid-speed', duration.toFixed(2) + 's');
    }
    var intensityInput = r('appearance-glass-intensity');
    if (intensityInput) intensityInput.value = String(state.appearance.glass.intensity);
    var speedInput = r('appearance-glass-speed');
    if (speedInput) speedInput.value = String(state.appearance.glass.speed);
    var intensityVal = r('appearance-glass-intensity-val');
    if (intensityVal) intensityVal.textContent = String(state.appearance.glass.intensity);
    var speedVal = r('appearance-glass-speed-val');
    if (speedVal) speedVal.textContent = state.appearance.glass.speed.toFixed(1) + 'x';
    var values = r('appearance-glass-values');
    if (values) values.textContent = '强度 ' + state.appearance.glass.intensity + ' · 速度 ' + state.appearance.glass.speed.toFixed(1) + 'x';
    return state.appearance.glass;
  }

  function applyAppearance(data) {
    var info = data && typeof data === 'object' ? data : {};
    if (info.theme != null) applyTheme(info.theme);
    if (info.fontScale != null) setFontScale(info.fontScale);
    if (Object.prototype.hasOwnProperty.call(info, 'wallpaper')) applyWallpaper(info.wallpaper);
    if (info.glass && typeof info.glass === 'object') applyGlassOptions(info.glass);
    else if (info.glassIntensity != null || info.glassSpeed != null) {
      applyGlassOptions({ intensity: info.glassIntensity, speed: info.glassSpeed });
    }
    var label = r('set-appearance-label');
    if (label) {
      label.textContent = ({
        dark: '暗黑', midnight: '午夜蓝', black: '纯黑 OLED'
      }[state.appearance.theme] || '暗黑') + ' · ' + Math.round(state.appearance.fontScale * 100) + '%';
    }
    return getAppearance();
  }

  function getAppearance() {
    return {
      theme: state.appearance.theme,
      fontScale: state.appearance.fontScale,
      wallpaper: state.appearance.wallpaper,
      glass: {
        intensity: state.appearance.glass.intensity,
        speed: state.appearance.glass.speed
      }
    };
  }

  function openAppearancePage() {
    showScreenImpl('appearance');
    if (!invoke('onOpenAppearance')) {
      applyAppearance(state.appearance);
    }
  }

  /* ================================================================== *
   * 批次 3 · v2.8.0：i18n（语言切换 / 静态文案替换）
   * ================================================================== */
  var UI_LOCALES = {
    zh: {
      'settings.interface': '界面',
      'appearance': '外观',
      'appearance.subtitle': '主题 / 字号 / 壁纸 / 液态玻璃',
      'appearance.theme': '主题色',
      'appearance.font': '字号',
      'appearance.wallpaper': '聊天壁纸',
      'appearance.glass': '液态玻璃',
      'appearance.language': '语言 / Language',
      'appearance.tip.title': '实时预览',
      'appearance.tip.body': '主题、字号、壁纸与液态玻璃参数即时生效并保存到本机；壁纸会显示在聊天背景中。',
      'theme.dark': '暗黑',
      'theme.midnight': '午夜蓝',
      'theme.black': '纯黑 OLED',
      'nav.chats': '聊天',
      'nav.share': '分享',
      'nav.profile': '个人资料',
      'settings.title': '设置',
      'plugins.title': '插件',
      'composer.placeholder': '消息',
      'profile.share': '分享聊天记录',
      'profile.clear': '清空所有会话',
      'profile.about': '关于 DeepSeek House',
      'profile.logout': '退出登录',
      'profile.audit': '审计日志',
      'profile.backup': '备份与恢复',
      'profile.settings': '设置',
      'profile.edit': '编辑资料',
      'settings.save': '保存设置',
      'settings.general': '模型与生成',
      'settings.server': '服务器',
      'settings.workspace': '工作区',
      'settings.prompt': '系统提示词',
      'settings.agents': '智能体',
      'settings.mcp': 'MCP 与构建',
      'settings.plugins': '插件与记忆',
      'settings.observability': '可观测性与权限',
      'settings.security': '安全与快照',
      'settings.account': '账户',
      'settings.about': '关于',
      'share.exportImage': '复制会话为长图',
      'login.submit': '登录'
    },
    en: {
      'settings.interface': 'Interface',
      'appearance': 'Appearance',
      'appearance.subtitle': 'Theme / Font size / Wallpaper / Glass',
      'appearance.theme': 'Theme color',
      'appearance.font': 'Font size',
      'appearance.wallpaper': 'Chat wallpaper',
      'appearance.glass': 'Liquid glass',
      'appearance.language': 'Language / 语言',
      'appearance.tip.title': 'Live preview',
      'appearance.tip.body': 'Theme, font size, wallpaper and glass options apply instantly and are saved locally.',
      'theme.dark': 'Dark',
      'theme.midnight': 'Midnight',
      'theme.black': 'OLED black',
      'nav.chats': 'Chats',
      'nav.share': 'Share',
      'nav.profile': 'Profile',
      'settings.title': 'Settings',
      'plugins.title': 'Plugins',
      'composer.placeholder': 'Message',
      'profile.share': 'Share chat history',
      'profile.clear': 'Clear all chats',
      'profile.about': 'About DeepSeek House',
      'profile.logout': 'Log out',
      'profile.audit': 'Audit log',
      'profile.backup': 'Backup & restore',
      'profile.settings': 'Settings',
      'profile.edit': 'Edit profile',
      'settings.save': 'Save settings',
      'settings.general': 'Model & generation',
      'settings.server': 'Server',
      'settings.workspace': 'Workspace',
      'settings.prompt': 'System prompt',
      'settings.agents': 'Agents',
      'settings.mcp': 'MCP & builds',
      'settings.plugins': 'Plugins & memory',
      'settings.observability': 'Observability & permissions',
      'settings.security': 'Security & snapshots',
      'settings.account': 'Account',
      'settings.about': 'About',
      'share.exportImage': 'Copy chat as image',
      'login.submit': 'Log in'
    }
  };

  function normalizeLocaleName(value) {
    return String(value == null ? '' : value).toLowerCase().indexOf('en') === 0 ? 'en' : 'zh';
  }

  function applyLocale(source) {
    var dict = null;
    var locale = state.locale || 'zh';
    if (typeof source === 'string') {
      locale = normalizeLocaleName(source);
      dict = UI_LOCALES[locale] || {};
    } else if (source && typeof source === 'object') {
      dict = source;
      if (source.locale != null) locale = normalizeLocaleName(source.locale);
    }
    state.locale = locale;
    var root = document.documentElement;
    if (root) root.setAttribute('lang', locale === 'en' ? 'en' : 'zh-CN');
    var nodes = document.querySelectorAll('[data-i18n]');
    Array.prototype.forEach.call(nodes, function (node) {
      var key = node.getAttribute('data-i18n');
      if (!key) return;
      if (!node.getAttribute('data-i18n-original')) node.setAttribute('data-i18n-original', node.textContent);
      var value = dict && dict[key] != null ? String(dict[key]) : '';
      if (!value) {
        var fallback = UI_LOCALES[locale] && UI_LOCALES[locale][key];
        value = fallback != null ? String(fallback) : '';
      }
      if (!value) value = node.getAttribute('data-i18n-original') || '';
      if (value) node.textContent = value;
    });
    var placeholders = document.querySelectorAll('[data-i18n-placeholder]');
    Array.prototype.forEach.call(placeholders, function (node) {
      var key = node.getAttribute('data-i18n-placeholder');
      if (!key) return;
      var value = dict && dict[key] != null ? String(dict[key]) : '';
      if (!value && UI_LOCALES[locale] && UI_LOCALES[locale][key] != null) value = String(UI_LOCALES[locale][key]);
      if (value) node.setAttribute('placeholder', value);
    });
    var langButtons = document.querySelectorAll('[data-locale]');
    Array.prototype.forEach.call(langButtons, function (button) {
      button.classList.toggle('is-active', button.getAttribute('data-locale') === locale);
    });
    var composeInput = r('composer-input');
    if (composeInput) {
      var ph = dict && dict['composer.placeholder'] != null ? String(dict['composer.placeholder'])
        : (UI_LOCALES[locale] && UI_LOCALES[locale]['composer.placeholder']) || '消息';
      composeInput.setAttribute('placeholder', ph);
    }
    return locale;
  }

  function setLocale(locale) {
    var value = normalizeLocaleName(locale);
    applyLocale(value);
    if (!invoke('onSetLocale', value)) UI.toast('语言设置服务尚未就绪');
    return value;
  }

  /* ================================================================== *
   * 批次 3 · v2.8.0：引用回复 / 编辑消息 / 消息长图
   * ================================================================== */
  function normalizeQuoted(quoted) {
    if (!quoted || typeof quoted !== 'object') return null;
    var role = quoted.role === 'assistant' ? 'assistant' : 'user';
    var text = quoted.text != null ? String(quoted.text)
      : (quoted.preview != null ? String(quoted.preview) : (quoted.content != null ? String(quoted.content) : ''));
    return {
      msgId: quoted.msgId != null ? quoted.msgId : quoted.id,
      role: role,
      name: quoted.name != null ? String(quoted.name) : '',
      text: text
    };
  }

  function setQuotedMessage(quoted) {
    var normalized = normalizeQuoted(quoted);
    state.quote = normalized;
    var bar = r('quote-bar');
    var roleEl = r('quote-role');
    var textEl = r('quote-text');
    if (!bar) return normalized;
    if (!normalized) {
      bar.hidden = true;
      if (roleEl) roleEl.textContent = '';
      if (textEl) textEl.textContent = '';
      return null;
    }
    bar.hidden = false;
    if (roleEl) roleEl.textContent = '引用 · ' + (normalized.name || (normalized.role === 'assistant' ? 'AI 回复' : '用户消息'));
    if (textEl) textEl.textContent = truncate(normalized.text.replace(/\s+/g, ' ').trim(), 160);
    return normalized;
  }

  function cancelQuote() {
    setQuotedMessage(null);
    if (!invoke('onCancelQuote')) {
      /* 无需提示：取消引用是本地行为 */
    }
  }

  function quoteMessage(msgId) {
    if (msgId == null) return;
    if (!invoke('onQuoteMessage', msgId)) UI.toast('引用服务尚未就绪');
  }

  function findMessageData(msgId) {
    var id = String(msgId == null ? '' : msgId);
    return state.msgData[id] || null;
  }

  function openEditMessage(msgId) {
    var data = findMessageData(msgId);
    if (!data || data.role !== 'user') return;
    state.edit.msgId = String(msgId);
    var input = r('edit-message-input');
    if (input) input.value = data.content == null ? '' : String(data.content);
    var error = r('edit-message-error');
    if (error) {
      error.textContent = '';
      error.hidden = true;
    }
    openModal(r('edit-message-modal'));
    setTimeout(function () {
      var field = r('edit-message-input');
      if (!field) return;
      try { field.focus(); } catch (err) { /* 静默 */ }
    }, 80);
  }

  function closeEditMessage() {
    closeModal(r('edit-message-modal'));
    state.edit.msgId = null;
  }

  function editMessageError(text) {
    var error = r('edit-message-error');
    var message = text == null ? '' : String(text);
    if (error) {
      error.textContent = message;
      error.hidden = !message;
    }
  }

  function submitEditMessage() {
    var msgId = state.edit.msgId;
    var input = r('edit-message-input');
    var text = input ? String(input.value || '').trim() : '';
    if (!msgId) return;
    if (!text) {
      editMessageError('消息内容不能为空');
      return;
    }
    var data = findMessageData(msgId);
    if (data && String(data.content == null ? '' : data.content) === text) {
      closeEditMessage();
      return;
    }
    var result = callHandler('onEditMessage', msgId, text);
    if (result === undefined) {
      editMessageError('编辑服务尚未就绪');
      return;
    }
    Promise.resolve(result).then(function (done) {
      if (done === false) {
        editMessageError('编辑失败，请重试');
        return;
      }
      closeEditMessage();
      UI.toast('已更新消息，正在重新生成');
    }, function () {
      editMessageError('编辑失败，请重试');
    });
  }

  function exportMessageImage(msgId) {
    if (msgId == null) return;
    if (!invoke('onExportMessageImage', msgId)) UI.toast('长图导出服务尚未就绪');
  }

  function exportChatImage() {
    if (!invoke('onExportChatImage')) UI.toast('长图导出服务尚未就绪');
  }

  /* ================================================================== *
   * 批次 3 · v2.8.0：会话内搜索
   * ================================================================== */
  function clearSearchHighlights() {
    Object.keys(state.msgNodes || {}).forEach(function (id) {
      var refs = state.msgNodes[id];
      if (!refs || !refs.root) return;
      refs.root.classList.remove('is-search-hit', 'is-search-current');
    });
  }

  function messageSearchText(data) {
    if (!data) return '';
    var parts = [data.content, data.result, data.summary, data.reasoning];
    if (data.args != null) parts.push(toolArgsText(data.args));
    if (Array.isArray(data.images)) parts.push('图片');
    return parts.map(function (item) { return item == null ? '' : String(item); }).join(' ');
  }

  function openChatSearch() {
    var bar = r('chat-search-in');
    if (bar) bar.hidden = false;
    var input = r('chat-search-in-input');
    if (input) {
      try { input.focus(); input.select(); } catch (err) { /* 静默 */ }
    }
  }

  function closeChatSearch() {
    var bar = r('chat-search-in');
    if (bar) bar.hidden = true;
    clearSearchHighlights();
    state.chatSearch = { keyword: '', matches: [], index: 0 };
    var input = r('chat-search-in-input');
    if (input) input.value = '';
    var count = r('chat-search-in-count');
    if (count) count.textContent = '0/0';
  }

  function updateChatSearchCount() {
    var count = r('chat-search-in-count');
    if (!count) return;
    var total = state.chatSearch.matches.length;
    if (!total) { count.textContent = '0/0'; return; }
    count.textContent = (state.chatSearch.index + 1) + '/' + total;
  }

  function searchInChat(keyword) {
    var query = String(keyword == null ? '' : keyword).trim().toLowerCase();
    state.chatSearch.keyword = query;
    clearSearchHighlights();
    var matches = [];
    if (query) {
      state.order.forEach(function (id) {
        var data = state.msgData[id];
        if (!data) return;
        if (messageSearchText(data).toLowerCase().indexOf(query) >= 0) matches.push(String(id));
      });
    }
    state.chatSearch.matches = matches;
    state.chatSearch.index = 0;
    matches.forEach(function (id) {
      var refs = state.msgNodes[id];
      if (refs && refs.root) refs.root.classList.add('is-search-hit');
    });
    if (matches.length) highlightMessage(matches[0]);
    else updateChatSearchCount();
    return matches.slice();
  }

  function highlightMessage(msgId) {
    var id = String(msgId == null ? '' : msgId);
    if (!id) return;
    var refs = state.msgNodes[id];
    if (!refs || !refs.root) return;
    Object.keys(state.msgNodes).forEach(function (key) {
      if (state.msgNodes[key] && state.msgNodes[key].root) state.msgNodes[key].root.classList.remove('is-search-current');
    });
    refs.root.classList.add('is-search-hit', 'is-search-current');
    state.chatSearch.index = Math.max(0, state.chatSearch.matches.indexOf(id));
    updateChatSearchCount();
    try {
      if (refs.root.scrollIntoView) refs.root.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (err) { /* 静默 */ }
    return id;
  }

  function moveChatSearch(delta) {
    var matches = state.chatSearch.matches || [];
    if (!matches.length) return;
    var next = (state.chatSearch.index + Number(delta || 1) + matches.length) % matches.length;
    state.chatSearch.index = next;
    highlightMessage(matches[next]);
  }

  function renderMessageSearch(results, keyword) {
    var list = Array.isArray(results) ? results : [];
    searchInChat(keyword);
    if (!list.length) return state.chatSearch.matches;
    var ids = [];
    list.forEach(function (item) {
      if (!item) return;
      var id = item.msgId != null ? String(item.msgId) : (item.id != null ? String(item.id) : '');
      if (id && ids.indexOf(id) < 0) ids.push(id);
    });
    if (!ids.length) return state.chatSearch.matches;
    state.chatSearch.matches = ids.filter(function (id) {
      return !!state.msgNodes[id];
    });
    state.chatSearch.index = 0;
    if (state.chatSearch.matches.length) highlightMessage(state.chatSearch.matches[0]);
    else updateChatSearchCount();
    return state.chatSearch.matches.slice();
  }

  /* ================================================================== *
   * v3.0.0：Bot 集成（Telegram / QQ OneBot）
   * ================================================================== */
  var BOT_TYPE_LABELS = { telegram: 'Telegram Bot', onebot: 'QQ OneBot', qqbot: 'QQ 官方机器人' };

  function normalizeBotType(type) {
    var value = String(type == null ? '' : type).toLowerCase().replace(/-/g, '_');
    if (value === 'qqbot' || value === 'qq_official' || value === 'official_qq' || value === 'qq') return 'qqbot';
    if (value === 'onebot') return 'onebot';
    return 'telegram';
  }

  function normalizeBotStatus(value) {
    var status = '';
    var message = '';
    if (value && typeof value === 'object') {
      status = value.status == null ? '' : String(value.status);
      message = value.message == null ? '' : String(value.message);
    } else if (value != null) {
      status = String(value);
    }
    var key = status.toLowerCase().replace(/-/g, '_');
    if (key === 'connected' || key === 'online' || key === 'ok' || key === 'ready') return { key: 'connected', message: message };
    if (key === 'connecting' || key === 'pending' || key === 'starting') return { key: 'connecting', message: message };
    if (key === 'error' || key === 'failed' || key === 'invalid') return { key: 'error', message: message };
    if (key === 'stopped' || key === 'disabled' || key === 'offline') return { key: 'stopped', message: message };
    if (key === 'disconnected' || key === 'closed') return { key: 'disconnected', message: message };
    return { key: 'idle', message: message };
  }

  function botStatusLabel(key) {
    if (key === 'connected') return '已连接';
    if (key === 'connecting') return '连接中…';
    if (key === 'error') return '连接失败';
    if (key === 'stopped') return '已停止';
    if (key === 'disconnected') return '已断开';
    return '未连接';
  }

  function botStatusClass(key) {
    var allowed = { connected: 1, connecting: 1, error: 1, stopped: 1, disconnected: 1, idle: 1 };
    return 'is-' + (allowed[key] ? key : 'idle');
  }

  function normalizeBot(item) {
    if (!item || typeof item !== 'object') return null;
    var type = normalizeBotType(item.type);
    var status = normalizeBotStatus(item.status);
    var whitelist = [];
    if (Array.isArray(item.whitelist)) {
      item.whitelist.forEach(function (id) { if (id != null && String(id).trim() !== '') whitelist.push(String(id).trim()); });
    } else if (typeof item.whitelist === 'string') {
      whitelist = item.whitelist.split(',').map(function (id) { return id.trim(); }).filter(Boolean);
    }
    var recentCount = Number(item.recentCount != null ? item.recentCount : item.messageCount);
    return {
      id: item.id != null ? String(item.id) : '',
      type: type,
      name: item.name ? String(item.name) : BOT_TYPE_LABELS[type],
      enabled: item.enabled !== false,
      autoReply: type === 'qqbot' ? false : (item.autoReply === true || item.auto_reply === true),
      status: status.key,
      appId: item.appId != null ? String(item.appId) : '',
      appIdMasked: item.appIdMasked ? String(item.appIdMasked) : '',
      appSecretMasked: item.appSecretMasked ? String(item.appSecretMasked) : '',
      sandbox: item.sandbox === true || String(item.env || '').toLowerCase() === 'sandbox',
      statusMessage: status.message,
      baseUrl: item.baseUrl ? String(item.baseUrl) : '',
      whitelist: whitelist,
      cooldownSec: Number(item.cooldownSec) || 8,
      hourlyLimit: Number(item.hourlyLimit) || 60,
      systemPrompt: item.systemPrompt != null ? String(item.systemPrompt) : (item.prompt != null ? String(item.prompt) : ''),
      recentCount: isFinite(recentCount) && recentCount > 0 ? recentCount : 0,
      recentMessages: Array.isArray(item.recentMessages) ? item.recentMessages : [],
      tokenMasked: item.tokenMasked ? String(item.tokenMasked) : '',
      accessTokenMasked: item.accessTokenMasked ? String(item.accessTokenMasked) : ''
    };
  }

  function normalizeBotMessage(msg, fallbackBotId) {
    if (!msg || typeof msg !== 'object') return null;
    var direction = String(msg.direction || '').toLowerCase() === 'out' ? 'out' : 'in';
    return {
      id: msg.id != null ? String(msg.id) : ('botmsg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
      botId: msg.botId != null ? String(msg.botId) : (fallbackBotId != null ? String(fallbackBotId) : ''),
      chatId: msg.chatId != null ? String(msg.chatId) : '',
      from: msg.from != null ? String(msg.from) : (msg.sender != null ? String(msg.sender) : ''),
      fromName: msg.fromName != null ? String(msg.fromName) : (msg.senderName != null ? String(msg.senderName) : (msg.from != null ? String(msg.from) : (msg.sender != null ? String(msg.sender) : ''))),
      text: msg.text != null ? String(msg.text) : (msg.content != null ? String(msg.content) : ''),
      at: msg.at != null ? msg.at : (msg.ts != null ? msg.ts : (msg.time != null ? msg.time : Date.now())),
      direction: direction
    };
  }

  function botTimeText(value) {
    var date = toDate(value);
    if (!date) return '';
    var now = new Date();
    var sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    var time = pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    return sameDay ? time : ((date.getMonth() + 1) + '/' + date.getDate() + ' ' + time);
  }

  function findBot(id) {
    var key = String(id == null ? '' : id);
    var found = null;
    (state.bots.list || []).forEach(function (bot) {
      if (bot.id === key) found = bot;
    });
    return found;
  }

  function updateBotsLabels() {
    var list = state.bots.list || [];
    var enabled = 0;
    var auto = 0;
    list.forEach(function (bot) {
      if (bot.enabled) enabled += 1;
      if (bot.enabled && bot.autoReply) auto += 1;
    });
    var count = r('bots-count');
    if (count) {
      count.textContent = list.length
        ? (list.length + ' 个机器人 · ' + enabled + ' 已启用' + (auto ? ' · ' + auto + ' 自动回复' : ''))
        : '在对话框里接入 Telegram Bot / QQ OneBot';
    }
    var label = r('set-bots-label');
    if (label) label.textContent = list.length ? (list.length + ' 个机器人') : 'Telegram / QQ OneBot';
    var empty = r('bots-empty');
    if (empty) empty.hidden = list.length > 0;
  }

  function buildBotCard(bot) {
    var card = el('div', 'bot-card');
    card.setAttribute('data-bot-id', bot.id);
    var head = el('div', 'bot-card-head');
    var icon = makeText('span', 'bot-card-icon', bot.type === 'telegram' ? '✈' : (bot.type === 'qqbot' ? 'QQ' : 'Q'));
    head.appendChild(icon);
    var main = el('div', 'bot-card-main');
    var nameRow = el('div', 'bot-card-name-row');
    nameRow.appendChild(makeText('span', 'bot-card-name', bot.name));
    nameRow.appendChild(makeText('span', 'bot-card-type', BOT_TYPE_LABELS[bot.type]));
    main.appendChild(nameRow);
    var sub = el('div', 'bot-card-sub');
    var dot = el('span', 'bot-status-dot bot-card-status-dot ' + botStatusClass(bot.status));
    sub.appendChild(dot);
    sub.appendChild(makeText('span', 'bot-status-text', botStatusLabel(bot.status)));
    sub.appendChild(makeText('span', 'bot-card-recent', ' · 最近 ' + bot.recentCount + ' 条消息'));
    main.appendChild(sub);
    head.appendChild(main);
    var switchLabel = document.createElement('label');
    switchLabel.className = 'switch bot-card-switch';
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'bot-toggle';
    checkbox.setAttribute('data-bot-id', bot.id);
    checkbox.checked = !!bot.enabled;
    checkbox.setAttribute('aria-label', '启用机器人');
    switchLabel.appendChild(checkbox);
    switchLabel.appendChild(el('span', 'switch-track'));
    head.appendChild(switchLabel);
    card.appendChild(head);

    var meta = el('div', 'bot-card-meta');
    if (bot.type === 'qqbot') {
      meta.appendChild(makeText('span', 'bot-meta-chip is-on', bot.sandbox ? '沙箱环境' : '正式环境'));
      if (bot.appIdMasked || bot.appId) meta.appendChild(makeText('span', 'bot-meta-chip', 'AppID ' + (bot.appIdMasked || bot.appId)));
    } else {
      if (bot.autoReply) meta.appendChild(makeText('span', 'bot-meta-chip is-on', '自动回复'));
      else meta.appendChild(makeText('span', 'bot-meta-chip', '自动回复关闭'));
      meta.appendChild(makeText('span', 'bot-meta-chip', bot.type === 'onebot' ? (bot.baseUrl || '未配置 Base URL') : 'Telegram Bot API'));
    }
    if (bot.whitelist.length) meta.appendChild(makeText('span', 'bot-meta-chip', '白名单 ' + bot.whitelist.length));
    card.appendChild(meta);

    var actions = el('div', 'bot-card-actions');
    function addAction(action, label, cls) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bot-act' + (cls ? ' ' + cls : '');
      btn.setAttribute('data-action', action);
      btn.setAttribute('data-id', bot.id);
      btn.textContent = label;
      actions.appendChild(btn);
    }
    addAction('bot-detail', '详情', 'bot-act--primary');
    addAction('bot-edit', '编辑');
    addAction('bot-test', '测试连接');
    card.appendChild(actions);
    return card;
  }

  function renderBots(list) {
    state.bots.list = (Array.isArray(list) ? list : []).map(normalizeBot).filter(Boolean);
    var box = r('bots-list');
    if (box) {
      box.textContent = '';
      state.bots.list.forEach(function (bot) { box.appendChild(buildBotCard(bot)); });
    }
    updateBotsLabels();
    return state.bots.list;
  }

  function openBotsPage() {
    showScreenImpl('bots');
    if (!invoke('onOpenBots')) renderBots(state.bots.list);
  }

  function setBotFormType(type) {
    var value = normalizeBotType(type);
    state.bots.form.type = value;
    var buttons = document.querySelectorAll('#bot-type-list [data-type]');
    Array.prototype.forEach.call(buttons, function (button) {
      var active = button.getAttribute('data-type') === value;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    var telegramGroup = r('bot-field-telegram');
    if (telegramGroup) telegramGroup.hidden = value !== 'telegram';
    var onebotGroup = r('bot-field-onebot');
    if (onebotGroup) onebotGroup.hidden = value !== 'onebot';
    var qqbotGroup = r('bot-field-qqbot');
    if (qqbotGroup) qqbotGroup.hidden = value !== 'qqbot';
    var autoWrap = r('bot-auto-reply-wrap');
    if (autoWrap) autoWrap.hidden = value === 'qqbot';
    var qqbotHint = r('bot-qqbot-hint');
    if (qqbotHint) qqbotHint.hidden = value !== 'qqbot';
    if (value === 'qqbot') {
      var auto = r('bot-field-auto-reply');
      if (auto) auto.checked = false;
    }
  }

  function botFormError(text) {
    var error = r('bot-form-error');
    var message = text == null ? '' : String(text);
    if (error) {
      error.textContent = message;
      error.hidden = !message;
    }
  }

  function botFormStatus(text, kind) {
    var status = r('bot-form-status');
    if (!status) return;
    var message = text == null ? '' : String(text);
    status.textContent = message;
    status.hidden = !message;
    status.classList.remove('is-error', 'is-ok');
    if (kind === 'error') status.classList.add('is-error');
    else if (kind === 'ok') status.classList.add('is-ok');
  }

  function openBotForm(cfg) {
    var bot = cfg && typeof cfg === 'object' ? normalizeBot(cfg) : null;
    state.bots.form = { id: bot ? bot.id : null, type: bot ? bot.type : 'telegram', editing: !!bot };
    var title = r('bot-form-title');
    if (title) title.textContent = bot ? '编辑机器人' : '添加机器人';
    setVal('bot-field-name', bot ? bot.name : '');
    setVal('bot-field-token', '');
    setVal('bot-field-onebot-token', '');
    setVal('bot-field-onebot-base', bot && bot.baseUrl ? bot.baseUrl : 'http://127.0.0.1:3000');
    setVal('bot-field-app-id', '');
    setVal('bot-field-app-secret', '');
    var appIdInput = r('bot-field-app-id');
    if (appIdInput) appIdInput.placeholder = bot && bot.appIdMasked ? ('当前：' + bot.appIdMasked + '（留空保持不变）') : 'QQ 开放平台机器人 AppID';
    var appSecretInput = r('bot-field-app-secret');
    if (appSecretInput) {
      appSecretInput.type = 'password';
      appSecretInput.placeholder = bot ? '留空保持不变（仅保存在本机）' : 'QQ 开放平台机器人 ClientSecret';
    }
    var secretToggle = r('bot-secret-toggle');
    if (secretToggle) secretToggle.classList.remove('is-on');
    var sandboxInput = r('bot-field-sandbox');
    if (sandboxInput) sandboxInput.checked = bot ? !!bot.sandbox : false;
    var tokenInput = r('bot-field-token');
    if (tokenInput) tokenInput.placeholder = bot ? '留空保持不变（仅保存在本机）' : '123456789:AA…（从 @BotFather 获取）';
    var onebotTokenInput = r('bot-field-onebot-token');
    if (onebotTokenInput) onebotTokenInput.placeholder = bot ? '留空保持不变（可留空）' : '可留空（OneBot 未设置 token 时）';
    var enabled = r('bot-field-enabled');
    if (enabled) enabled.checked = bot ? !!bot.enabled : true;
    var auto = r('bot-field-auto-reply');
    if (auto) auto.checked = bot ? !!bot.autoReply : false;
    setVal('bot-field-cooldown', bot ? String(bot.cooldownSec) : '8');
    setVal('bot-field-limit', bot ? String(bot.hourlyLimit) : '60');
    setVal('bot-field-prompt', bot ? bot.systemPrompt : '');
    setVal('bot-field-whitelist', bot ? bot.whitelist.join(', ') : '');
    setBotFormType(bot ? bot.type : 'telegram');
    botFormError('');
    botFormStatus('');
    openModal(r('bot-form-modal'));
    setTimeout(function () {
      var field = r('bot-field-name');
      if (!field) return;
      try { field.focus(); } catch (err) { /* 静默 */ }
    }, 80);
  }

  function closeBotForm() {
    closeModal(r('bot-form-modal'));
    botFormError('');
    botFormStatus('');
  }

  function collectBotForm() {
    var whitelistInput = r('bot-field-whitelist');
    var whitelist = whitelistInput
      ? String(whitelistInput.value || '').split(/[,，\s]+/).map(function (id) { return id.trim(); }).filter(Boolean)
      : [];
    var cooldown = Number(r('bot-field-cooldown') ? r('bot-field-cooldown').value : 8);
    var limit = Number(r('bot-field-limit') ? r('bot-field-limit').value : 60);
    var cfg = {
      id: state.bots.form.id || undefined,
      type: state.bots.form.type || 'telegram',
      name: String((r('bot-field-name') || {}).value || '').trim(),
      token: String((r('bot-field-token') || {}).value || '').trim(),
      accessToken: String((r('bot-field-onebot-token') || {}).value || '').trim(),
      baseUrl: String((r('bot-field-onebot-base') || {}).value || '').trim(),
      enabled: !!(r('bot-field-enabled') && r('bot-field-enabled').checked),
      autoReply: !!(r('bot-field-auto-reply') && r('bot-field-auto-reply').checked),
      cooldownSec: isFinite(cooldown) ? Math.max(1, Math.min(3600, Math.round(cooldown))) : 8,
      hourlyLimit: isFinite(limit) ? Math.max(1, Math.min(600, Math.round(limit))) : 60,
      systemPrompt: String((r('bot-field-prompt') || {}).value || ''),
      whitelist: whitelist,
      appId: String((r('bot-field-app-id') || {}).value || '').trim(),
      secret: String((r('bot-field-app-secret') || {}).value || '').trim(),
      sandbox: !!(r('bot-field-sandbox') && r('bot-field-sandbox').checked)
    };
    if (cfg.type === 'qqbot') {
      cfg.autoReply = false;
      cfg.token = '';
      cfg.accessToken = '';
      cfg.baseUrl = '';
    } else if (cfg.type === 'telegram') {
      cfg.appId = '';
      cfg.secret = '';
      cfg.sandbox = false;
    } else if (cfg.type === 'onebot') {
      cfg.appId = '';
      cfg.secret = '';
      cfg.sandbox = false;
    }
    return cfg;
  }

  function validateBotForm(cfg) {
    if (!cfg.name) return '请填写机器人名称';
    if (cfg.type === 'telegram' && !state.bots.form.id && !cfg.token) return '请填写 Telegram Bot Token（从 @BotFather 获取）';
    if (cfg.type === 'onebot') {
      if (!cfg.baseUrl) return '请填写 OneBot Base URL';
      if (!/^https?:\/\//i.test(cfg.baseUrl)) return 'Base URL 需以 http:// 或 https:// 开头';
    }
    if (cfg.type === 'qqbot') {
      if (!state.bots.form.id && !cfg.appId) return '请填写 QQ 开放平台 AppID';
      if (!state.bots.form.id && !cfg.secret) return '请填写 QQ 开放平台 ClientSecret';
      if (cfg.appId && !/^\d{5,20}$/.test(cfg.appId)) return 'AppID 应为 5-20 位数字';
    }
    return '';
  }

  function saveBotForm() {
    var cfg = collectBotForm();
    var error = validateBotForm(cfg);
    if (error) { botFormError(error); return; }
    botFormError('');
    botFormStatus('正在保存并连接…');
    var result = callHandler('onBotSave', cfg);
    if (result === undefined) {
      botFormStatus('');
      botFormError('Bot 服务尚未就绪');
      return;
    }
    Promise.resolve(result).then(function (done) {
      if (done === false) {
        botFormStatus('');
        botFormError('保存失败，请检查 Token / Base URL');
        return;
      }
      var botId = (done && typeof done === 'object' && done.id != null) ? String(done.id) : cfg.id;
      if (botId && typeof state.cb.onBotAutoReply === 'function') {
        invoke('onBotAutoReply', botId, {
          autoReply: cfg.autoReply,
          cooldownSec: cfg.cooldownSec,
          hourlyLimit: cfg.hourlyLimit,
          whitelist: cfg.whitelist,
          systemPrompt: cfg.systemPrompt
        });
      }
      closeBotForm();
      UI.toast('机器人已保存并连接');
    }, function () {
      botFormStatus('');
      botFormError('保存失败，请检查 Token / Base URL');
    });
  }

  function testBotForm() {
    var cfg = collectBotForm();
    var error = validateBotForm(cfg);
    if (error) { botFormError(error); return; }
    botFormError('');
    botFormStatus('正在测试连接…');
    var result = state.bots.form.id
      ? callHandler('onBotTest', state.bots.form.id, cfg)
      : callHandler('onBotTest', null, cfg);
    if (result === undefined) {
      botFormStatus('');
      botFormError('Bot 服务尚未就绪');
      return;
    }
    Promise.resolve(result).then(function (res) {
      var ok = res === true || (res && typeof res === 'object' && res.ok === true);
      var message = res && typeof res === 'object' && res.message ? String(res.message) : '';
      if (ok || res === undefined) botFormStatus('连接成功' + (message ? '：' + message : ''), 'ok');
      else botFormStatus('连接失败' + (message ? '：' + message : '，请检查 Token / Base URL'), 'error');
    }, function (err) {
      botFormStatus('连接失败：' + errText(err), 'error');
    });
  }

  function toggleBot(id, enabled) {
    var bot = findBot(id);
    if (!bot) return;
    var result = callHandler('onBotToggle', bot.id, !!enabled);
    if (result === undefined) {
      UI.toast('Bot 服务尚未就绪');
      renderBots(state.bots.list);
      return;
    }
    bot.enabled = !!enabled;
    updateBotsLabels();
    Promise.resolve(result).then(function (ok) {
      if (ok === false) {
        bot.enabled = !enabled;
        renderBots(state.bots.list);
        UI.toast(enabled ? '启用失败' : '停用失败');
      }
    }, function () {
      bot.enabled = !enabled;
      renderBots(state.bots.list);
    });
  }

  function normalizeBotMessages(list, botId) {
    return (Array.isArray(list) ? list : []).map(function (msg) { return normalizeBotMessage(msg, botId); }).filter(Boolean);
  }

  function renderBotMessages(list) {
    var botId = state.bots.currentId;
    var messages = normalizeBotMessages(list, botId);
    if (botId) state.bots.messages[botId] = messages;
    var box = r('bot-detail-messages');
    if (box) {
      box.textContent = '';
      messages.forEach(function (msg) {
        var row = el('div', 'bot-message' + (msg.direction === 'out' ? ' is-out' : ''));
        var head = el('div', 'bot-message-head');
        head.appendChild(makeText('span', 'bot-message-from', msg.fromName || (msg.direction === 'out' ? '我' : msg.from || '对方')));
        head.appendChild(makeText('span', 'bot-message-time', botTimeText(msg.at)));
        row.appendChild(head);
        row.appendChild(makeText('div', 'bot-message-text', msg.text || ''));
        box.appendChild(row);
      });
    }
    var empty = r('bot-detail-messages-empty');
    if (empty) empty.hidden = messages.length > 0;
    if (box) box.hidden = messages.length === 0;
    updateBotDetailCount();
    return messages;
  }

  function updateBotDetailCount() {
    var count = r('bot-detail-count');
    var bot = state.bots.currentId ? findBot(state.bots.currentId) : null;
    if (count) {
      var list = state.bots.currentId ? (state.bots.messages[state.bots.currentId] || []) : [];
      count.textContent = list.length + ' 条消息' + (bot && bot.whitelist.length ? ' · 白名单 ' + bot.whitelist.length : '');
    }
    var sub = r('bot-detail-sub');
    if (sub && bot) sub.textContent = BOT_TYPE_LABELS[bot.type] + (bot.baseUrl ? ' · ' + bot.baseUrl : '');
  }

  function updateBotDetailHeader() {
    var bot = state.bots.currentId ? findBot(state.bots.currentId) : null;
    var name = r('bot-detail-name');
    var status = r('bot-detail-status');
    var dot = r('bot-detail-status-dot');
    if (name) name.textContent = bot ? bot.name : '机器人';
    if (status) status.textContent = bot ? (botStatusLabel(bot.status) + (bot.statusMessage ? ' · ' + bot.statusMessage : '')) : '未连接';
    if (dot) {
      dot.className = 'bot-status-dot ' + botStatusClass(bot ? bot.status : 'idle');
    }
    var meta = r('bot-detail-meta');
    if (meta) {
      meta.textContent = '';
      if (bot) {
        meta.hidden = false;
        meta.appendChild(makeText('span', 'bot-detail-chip is-accent', BOT_TYPE_LABELS[bot.type] || 'Bot'));
        if (bot.type === 'qqbot') {
          meta.appendChild(makeText('span', 'bot-detail-chip is-sandbox', bot.sandbox ? '沙箱环境' : '正式环境'));
          var masked = bot.appIdMasked || bot.appId;
          if (masked) meta.appendChild(makeText('span', 'bot-detail-chip', 'AppID ' + masked));
        } else if (bot.type === 'onebot' && bot.baseUrl) {
          meta.appendChild(makeText('span', 'bot-detail-chip', bot.baseUrl));
        }
      } else {
        meta.hidden = true;
      }
    }
    var chatHint = r('bot-detail-chat-hint');
    var chatInput = r('bot-detail-chat-id');
    if (chatHint) {
      if (bot && bot.type === 'qqbot') {
        chatHint.hidden = false;
        chatHint.textContent = '格式：channel:<guildId>:<channelId> / group:<group_openid> / user:<openid>';
        if (chatInput) chatInput.placeholder = 'channel:<guildId>:<channelId> 等';
      } else if (bot && bot.type === 'onebot') {
        chatHint.hidden = false;
        chatHint.textContent = '格式：用户 ID 或 group:<群号>（私聊/群聊）';
        if (chatInput) chatInput.placeholder = '用户 ID 或 group:<群号>';
      } else {
        chatHint.hidden = true;
        if (chatInput) chatInput.placeholder = 'chatId（可空）';
      }
    }
    var messagesLabel = r('bot-detail-messages-label');
    if (messagesLabel) messagesLabel.textContent = bot && bot.type === 'qqbot' ? '发送记录' : '最近消息';
    updateBotDetailCount();
    return bot;
  }

  function renderBotTargets(list) {
    var raw = list && typeof list === 'object' && !Array.isArray(list) ? list.targets : list;
    var targets = (Array.isArray(raw) ? raw : []).map(function (item) {
      if (!item || typeof item !== 'object') return null;
      var id = item.id != null ? String(item.id) : '';
      if (!id) return null;
      return { id: id, label: item.label != null ? String(item.label) : id, type: item.type ? String(item.type) : '' };
    }).filter(Boolean);
    var botId = state.bots.currentId;
    if (botId) state.bots.targets[botId] = targets;
    var box = r('bot-detail-targets-list');
    if (box) {
      box.textContent = '';
      targets.forEach(function (target) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bot-target';
        btn.setAttribute('data-action', 'bot-target');
        btn.setAttribute('data-target-id', target.id);
        var iconText = target.id.indexOf('channel:') === 0 ? '频道' : (target.id.indexOf('group:') === 0 ? '群' : '用户');
        btn.appendChild(makeText('span', 'bot-target-icon', iconText));
        var main = el('div', 'bot-target-main');
        main.appendChild(makeText('span', 'bot-target-label', target.label));
        main.appendChild(makeText('span', 'bot-target-id', target.id));
        btn.appendChild(main);
        box.appendChild(btn);
      });
    }
    var empty = r('bot-detail-targets-empty');
    if (empty) empty.hidden = targets.length > 0;
    return targets;
  }

  function openBotDetail(id) {
    var bot = findBot(id);
    if (!bot) return false;
    state.bots.currentId = bot.id;
    state.bots.messages[bot.id] = normalizeBotMessages(bot.recentMessages, bot.id);
    updateBotDetailHeader();
    renderBotMessages(state.bots.messages[bot.id]);
    var error = r('bot-detail-error');
    if (error) { error.textContent = ''; error.hidden = true; }
    setVal('bot-detail-send-text', '');
    setVal('bot-detail-chat-id', '');
    var targetsBox = r('bot-detail-targets');
    if (targetsBox) targetsBox.hidden = bot.type !== 'qqbot';
    if (bot.type === 'qqbot') {
      renderBotTargets(state.bots.targets[bot.id] || []);
      if (typeof state.cb.onBotTargets === 'function') invoke('onBotTargets', bot.id);
    }
    openModal(r('bot-detail-modal'));
    if (typeof state.cb.onOpenBotDetail === 'function') invoke('onOpenBotDetail', bot.id);
    else if (typeof state.cb.onBotFetchMessages === 'function') invoke('onBotFetchMessages', bot.id);
    return true;
  }

  function closeBotDetail() {
    closeModal(r('bot-detail-modal'));
    state.bots.currentId = null;
  }

  function setBotStatus(id, statusOrObj) {
    var bot = findBot(id);
    var status = normalizeBotStatus(statusOrObj);
    if (!bot) return status;
    bot.status = status.key;
    bot.statusMessage = status.message;
    var box = r('bots-list');
    if (box) {
      var card = box.querySelector('.bot-card[data-bot-id="' + String(bot.id).replace(/"/g, '\\"') + '"]');
      if (card) {
        var dot = card.querySelector('.bot-card-status-dot');
        if (dot) dot.className = 'bot-status-dot bot-card-status-dot ' + botStatusClass(status.key);
        var text = card.querySelector('.bot-status-text');
        if (text) text.textContent = botStatusLabel(status.key);
      }
    }
    if (state.bots.currentId === bot.id) updateBotDetailHeader();
    return status;
  }

  function appendBotMessage(msg) {
    var normalized = normalizeBotMessage(msg, state.bots.currentId);
    if (!normalized || !normalized.botId) return null;
    var bot = findBot(normalized.botId);
    if (bot) {
      bot.recentCount += 1;
      var listEl = r('bots-list');
      if (listEl) {
        var card = listEl.querySelector('.bot-card[data-bot-id="' + String(bot.id).replace(/"/g, '\\"') + '"]');
        if (card) {
          var recent = card.querySelector('.bot-card-recent');
          if (recent) recent.textContent = ' · 最近 ' + bot.recentCount + ' 条消息';
        }
      }
    }
    var bucket = state.bots.messages[normalized.botId] || (state.bots.messages[normalized.botId] = []);
    bucket.push(normalized);
    if (bucket.length > 50) bucket.splice(0, bucket.length - 50);
    if (state.bots.currentId === normalized.botId) {
      var box = r('bot-detail-messages');
      if (box) {
        box.hidden = false;
        var row = el('div', 'bot-message' + (normalized.direction === 'out' ? ' is-out' : ''));
        var head = el('div', 'bot-message-head');
        head.appendChild(makeText('span', 'bot-message-from', normalized.fromName || (normalized.direction === 'out' ? '我' : normalized.from || '对方')));
        head.appendChild(makeText('span', 'bot-message-time', botTimeText(normalized.at)));
        row.appendChild(head);
        row.appendChild(makeText('div', 'bot-message-text', normalized.text || ''));
        box.appendChild(row);
        var empty = r('bot-detail-messages-empty');
        if (empty) empty.hidden = true;
        try { box.scrollTop = box.scrollHeight; } catch (err) { /* 静默 */ }
      }
      updateBotDetailCount();
    }
    return normalized;
  }

  function botDetailError(text) {
    var error = r('bot-detail-error');
    var message = text == null ? '' : String(text);
    if (error) {
      error.textContent = message;
      error.hidden = !message;
    }
  }

  function sendBotTest() {
    var botId = state.bots.currentId;
    var bot = botId ? findBot(botId) : null;
    if (!bot) return;
    var textInput = r('bot-detail-send-text');
    var chatInput = r('bot-detail-chat-id');
    var text = textInput ? String(textInput.value || '').trim() : '';
    var chatId = chatInput ? String(chatInput.value || '').trim() : '';
    if (!text) {
      botDetailError('请输入要发送的测试消息');
      return;
    }
    if (bot.type === 'qqbot' && chatId && !/^(user|group|channel):/i.test(chatId)) {
      botDetailError('QQ 官方机器人 chatId 需为 user: / group: / channel: 格式');
      return;
    }
    botDetailError('');
    var result = callHandler('onBotSend', bot.id, chatId, text);
    if (result === undefined) {
      botDetailError('Bot 服务尚未就绪');
      return;
    }
    Promise.resolve(result).then(function (res) {
      var ok = res === true || (res && typeof res === 'object' && res.ok === true) || res === undefined;
      if (!ok) {
        botDetailError((res && res.message) ? String(res.message) : '发送失败，请检查连接与 chatId');
        return;
      }
      if (textInput) textInput.value = '';
      UI.toast('测试消息已发送');
    }, function (err) {
      botDetailError('发送失败：' + errText(err));
    });
  }

  function deleteBotFromDetail() {
    var bot = state.bots.currentId ? findBot(state.bots.currentId) : null;
    if (!bot) return;
    confirmDialog('删除机器人', '确定删除「' + bot.name + '」吗？其 Token 与本机消息记录会一并移除。').then(function (ok) {
      if (!ok) return;
      var result = callHandler('onBotDelete', bot.id);
      if (result === undefined) {
        UI.toast('Bot 服务尚未就绪');
        return;
      }
      closeBotDetail();
      state.bots.list = state.bots.list.filter(function (item) { return item.id !== bot.id; });
      renderBots(state.bots.list);
      UI.toast('机器人已删除');
    });
  }

  function openBotChatFromDetail() {
    var bot = state.bots.currentId ? findBot(state.bots.currentId) : null;
    if (!bot) return;
    var chatInput = r('bot-detail-chat-id');
    var chatId = chatInput ? String(chatInput.value || '').trim() : '';
    var result = callHandler('onOpenBotChat', bot.id, chatId);
    if (result === undefined) {
      UI.toast('打开会话服务尚未就绪');
    } else {
      Promise.resolve(result).then(function (ok) {
        if (ok === false) UI.toast('打开会话失败');
      }, function () { UI.toast('打开会话失败'); });
    }
  }

  function editBotFromDetail() {
    var bot = state.bots.currentId ? findBot(state.bots.currentId) : null;
    if (!bot) return;
    closeBotDetail();
    openBotForm(bot);
  }

  function handleBotAutoReplyToggle(checked) {
    var auto = r('bot-field-auto-reply');
    if (!checked) return;
    confirmDialog('开启自动回复', '自动回复仅限合规 Bot API（Telegram 官方 Bot / QQ OneBot）；请勿用于真人账号骚扰、欺诈或违反平台规则的行为。确定开启吗？').then(function (ok) {
      if (!ok && auto) auto.checked = false;
    });
  }

  /* ------------------------------------------------------------------ *
   * 屏幕切换
   * ------------------------------------------------------------------ */
  var SCREEN_IDS = {
    login: 'screen-login',
    chats: 'screen-chats',
    share: 'screen-share',
    profile: 'screen-profile',
    chat: 'screen-chat',
    settings: 'screen-settings',
    plugins: 'screen-plugins',
    agents: 'screen-agents',
    audit: 'screen-audit',
    mcp: 'screen-mcp',
    market: 'screen-market',
    memory: 'screen-memory',
    trace: 'screen-trace',
    cost: 'screen-cost',
    'tool-policy': 'screen-tool-policy',
    snapshots: 'screen-snapshots',
    appearance: 'screen-appearance',
    bots: 'screen-bots'
  };

  function syncBottomNav(name) {
    var map = { chats: 'nav-chats', share: 'nav-share', profile: 'nav-profile' };
    ['nav-chats', 'nav-share', 'nav-profile'].forEach(function (id) {
      var node = r(id);
      if (!node) return;
      node.classList.toggle('is-active', map[name] === id);
    });
  }

  function setNavBadge(count) {
    var badge = r('nav-badge');
    if (!badge) return;
    var n = Math.max(0, parseInt(count, 10) || 0);
    badge.hidden = n <= 0;
    badge.textContent = n > 99 ? '99+' : String(n);
  }

  function showScreenImpl(name) {
    if (!SCREEN_IDS[name]) return;
    state.screen = name;
    Object.keys(SCREEN_IDS).forEach(function (key) {
      var node = document.getElementById(SCREEN_IDS[key]);
      if (!node) return;
      var active = key === name;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-hidden', active ? 'false' : 'true');
    });
    var app = r('app');
    if (app) app.setAttribute('data-screen', name);
    syncBottomNav(name);
    closeMenu();
    if (name !== 'chat') closeDrawer();
    if (name !== 'chat') closeFileDrawer();
    closeAllModals();
    closeModelPickerPanel(true);
    closeAgentPickerPanel(true);
    closePluginPanel();
    closeAttachmentSheet();
    closeBuildPanel();
    closeImageViewer();
    if (name !== 'chat') { closeEmojiPanel(); closeSlashMenu(); closeChatSearch(); }
    if (name === 'settings') refreshSettingsStats();
    syncDepth();
  }

  /* ------------------------------------------------------------------ *
   * 抽屉 / 搜索
   * ------------------------------------------------------------------ */
  function openDrawer() {
    if (state.drawerOpen) return;
    state.drawerOpen = true;
    var drawer = r('drawer');
    var overlay = r('overlay');
    if (drawer) {
      drawer.classList.add('is-open');
      drawer.setAttribute('aria-hidden', 'false');
    }
    if (overlay) {
      overlay.classList.add('is-open');
      overlay.setAttribute('aria-hidden', 'false');
    }
    syncDepth();
  }

  function closeDrawer() {
    var hasOverlay = state.drawerOpen || state.menuOpen || state.modelPicker.open ||
      state.agentPicker.open ||
      isModalOpen(r('confirm-modal')) || isModalOpen(r('rename-modal')) || isModalOpen(r('install-modal'));
    if (!hasOverlay) return;
    if (state.drawerOpen) {
      state.drawerOpen = false;
      var drawer = r('drawer');
      var overlay = r('overlay');
      if (drawer) {
        drawer.classList.remove('is-open');
        drawer.setAttribute('aria-hidden', 'true');
      }
      if (overlay) {
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden', 'true');
      }
    }
    dismissOverlays();
    syncDepth();
  }

  /* app.js 的返回键会调用 UI.closeDrawer()：同时收起长按菜单、弹窗与模型选择器，避免返回后残留浮层 */
  function dismissOverlays() {
    if (state.menuOpen) closeMenu();
    if (isModalOpen(r('confirm-modal'))) resolveConfirm(false);
    if (isModalOpen(r('rename-modal'))) resolveRename(null);
    if (isModalOpen(r('install-modal'))) closeModal(r('install-modal'));
    if (state.modelPicker.open) closeModelPickerPanel(true);
    if (state.agentPicker.open) closeAgentPickerPanel(true);
  }

  function focusSearch() {
    setTimeout(function () {
      var input = r('search-input');
      if (!input) return;
      try {
        input.focus();
        input.select();
      } catch (err) { /* 静默 */ }
    }, 230);
  }

  function updateSearchClear() {
    var btn = r('search-clear');
    if (btn) btn.hidden = !state.searchQuery;
  }

  function onSearchInput() {
    var input = r('search-input');
    if (!input) return;
    state.searchQuery = String(input.value || '');
    updateSearchClear();
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(function () {
      if (typeof state.cb.onSearch === 'function') {
        invoke('onSearch', state.searchQuery);
      } else {
        renderChatListImpl(state.chats, state.activeChatId);
      }
    }, 180);
  }

  function clearSearch() {
    var input = r('search-input');
    if (input) input.value = '';
    state.searchQuery = '';
    updateSearchClear();
    clearTimeout(state.searchTimer);
    if (typeof state.cb.onSearch === 'function') invoke('onSearch', '');
    else renderChatListImpl(state.chats, state.activeChatId);
    try { if (input) input.focus(); } catch (err) { /* 静默 */ }
  }

  /* ------------------------------------------------------------------ *
   * 首页会话搜索（Telegram 式首屏）
   * ------------------------------------------------------------------ */
  function onChatSearchInput() {
    var input = r('chat-search-input');
    state.searchQuery = input ? String(input.value || '') : '';
    var clearBtn = r('chat-search-clear');
    if (clearBtn) clearBtn.hidden = !state.searchQuery;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(function () {
      if (typeof state.cb.onSearch === 'function') invoke('onSearch', state.searchQuery);
      else renderChatListImpl(state.chats, state.activeChatId);
    }, 180);
  }

  function toggleChatSearch(forceOpen) {
    var wrap = r('chat-search-wrap');
    if (!wrap) return;
    var open = forceOpen === undefined ? wrap.hidden : !!forceOpen;
    wrap.hidden = !open;
    var input = r('chat-search-input');
    if (open) {
      if (input) { try { input.focus(); input.select(); } catch (err) { /* 静默 */ } }
    } else {
      if (input) input.value = '';
      state.searchQuery = '';
      clearTimeout(state.searchTimer);
      if (typeof state.cb.onSearch === 'function') invoke('onSearch', '');
      else renderChatListImpl(state.chats, state.activeChatId);
    }
  }

  /* 文件夹标签：全部 / 归档（SPEC v2.0 F2） */
  function syncFolderTabActive() {
    var tabs = document.querySelectorAll('#chat-tabs [data-tab]');
    Array.prototype.forEach.call(tabs, function (node) {
      var active = node.getAttribute('data-tab') === state.chatTab;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function updateFolderTabs(archivedCount, allCount) {
    syncFolderTabActive();
    var allCountEl = r('chat-tab-count-all');
    if (allCountEl) {
      allCountEl.hidden = !(allCount > 0);
      allCountEl.textContent = String(allCount > 99 ? '99+' : allCount);
    }
    var archivedEl = r('chat-tab-count-archived');
    if (archivedEl) {
      archivedEl.hidden = !(archivedCount > 0);
      archivedEl.textContent = String(archivedCount > 99 ? '99+' : archivedCount);
    }
  }

  function switchChatTab(tab) {
    var next = tab === 'archived' ? 'archived' : (tab === 'unread' ? 'unread' : 'all');
    if (state.chatTab === next) return;
    state.chatTab = next;
    syncFolderTabActive();
    invoke('onChatTab', next);
    /* 搜索在当前标签内过滤：app.js 接管 onSearch 时让它重新给列表，UI 再按标签过滤 */
    if (typeof state.cb.onSearch === 'function' && String(state.searchQuery || '').trim()) {
      invoke('onSearch', state.searchQuery);
    } else {
      renderChatListImpl(state.chats, state.activeChatId);
    }
    var homeList = r('chats-list');
    if (homeList) homeList.scrollTop = 0;
  }

  /* ------------------------------------------------------------------ *
   * 表情面板
   * ------------------------------------------------------------------ */
  var EMOJI_LIST = ['😀','😄','😁','😆','😅','🤣','🥲','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😜','😝','🤪','🤨','🧐','🤓','😎','🥳','😏','😒','😞','😔','😟','😕','🙁','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🫣','🤭','🫢','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕'];

  function buildEmojiPanel() {
    var grid = r('emoji-grid');
    if (!grid || grid.childElementCount) return;
    EMOJI_LIST.forEach(function (emoji) {
      var btn = el('button', 'emoji-item', emoji);
      btn.type = 'button';
      btn.setAttribute('data-emoji', emoji);
      btn.setAttribute('aria-label', '表情 ' + emoji);
      grid.appendChild(btn);
    });
  }

  function insertEmoji(emoji) {
    var input = r('composer-input');
    if (!input || !emoji) return;
    var value = String(input.value || '');
    var start = input.selectionStart == null ? value.length : input.selectionStart;
    var end = input.selectionEnd == null ? value.length : input.selectionEnd;
    input.value = value.slice(0, start) + emoji + value.slice(end);
    var caret = start + emoji.length;
    try { input.setSelectionRange(caret, caret); } catch (err) { /* 静默 */ }
    autosize();
    try { input.focus(); } catch (err) { /* 静默 */ }
  }

  function toggleEmojiPanel(forceOpen) {
    var panel = r('emoji-panel');
    if (!panel) return;
    var open = forceOpen === undefined ? panel.hidden : !!forceOpen;
    if (open) {
      buildEmojiPanel();
      panel.hidden = false;
      var grid = r('emoji-grid');
      if (grid) grid.scrollTop = grid.scrollHeight;
      var input = r('composer-input');
      if (input) { try { input.focus(); } catch (err) { /* 静默 */ } }
    } else {
      panel.hidden = true;
    }
    state.emojiOpen = open;
    if (state.autoScroll) scrollToBottom();
  }

  function closeEmojiPanel() {
    var panel = r('emoji-panel');
    state.emojiOpen = false;
    if (panel && !panel.hidden) panel.hidden = true;
  }

  /* ------------------------------------------------------------------ *
   * 聊天页顶栏：滚动阴影 + 会话头像
   * ------------------------------------------------------------------ */
  function syncHeaderShadow(scrolled) {
    var header = r('chat-header');
    if (header) header.classList.toggle('is-scrolled', !!scrolled);
  }

  function applyChatHeadAvatar(chat) {
    var node = r('chat-head-avatar');
    if (!node) return;
    if (node.tagName === 'IMG') {
      node.src = 'img/agent-avatar.jpg';
      node.alt = chat && chat.title ? String(chat.title) : '';
    } else {
      node.textContent = chat ? chatAvatarText(chat) : 'D';
      node.className = 'chat-head-avatar' + (chat ? chatAvatarClass(chat.id) : '');
    }
  }

  /* ------------------------------------------------------------------ *
   * 水波纹（ripple）：Android 触感
   * ------------------------------------------------------------------ */
  function spawnRipple(event, node) {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      var rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var size = Math.max(rect.width, rect.height) * 1.15;
      var ink = document.createElement('span');
      ink.className = 'ripple-ink';
      ink.style.width = size + 'px';
      ink.style.height = size + 'px';
      ink.style.left = (event.clientX - rect.left - size / 2) + 'px';
      ink.style.top = (event.clientY - rect.top - size / 2) + 'px';
      var style = window.getComputedStyle(node);
      if (style && style.position === 'static') node.classList.add('ripple-host');
      node.appendChild(ink);
      setTimeout(function () {
        if (ink.parentNode) ink.parentNode.removeChild(ink);
      }, 480);
    } catch (err) { /* 静默 */ }
  }

  function onRipplePointerDown(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var host = target.closest('button, .chat-item, .model-row, .drawer-item, .fab, .emoji-item');
    if (!host || host.disabled) return;
    spawnRipple(event, host);
  }

  /* ------------------------------------------------------------------ *
   * 会话列表
   * ------------------------------------------------------------------ */
  function previewOf(chat) {
    var messages = chat && chat.messages;
    if (!messages || !messages.length) return '暂无消息';
    var last = messages[messages.length - 1] || {};
    var content = last.content == null ? '' : String(last.content);
    content = content.replace(/\s+/g, ' ').trim();
    if (!content) return last.role === 'assistant' ? '…' : '暂无消息';
    return truncate(content, 90);
  }

  var CHAT_AVATAR_VARIANTS = ['', ' chat-avatar--c1', ' chat-avatar--c2', ' chat-avatar--c3', ' chat-avatar--c4', ' chat-avatar--c5'];

  function chatAvatarClass(id) {
    var text = String(id == null ? '' : id);
    var hash = 0;
    for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return CHAT_AVATAR_VARIANTS[hash % CHAT_AVATAR_VARIANTS.length];
  }

  function chatAvatarText(chat) {
    var title = String((chat && chat.title) || '新对话').trim();
    var chars = Array.from(title);
    var first = chars.length ? chars[0] : 'D';
    return /[a-z]/i.test(first) ? first.toUpperCase() : first;
  }

  var ICON_PIN = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.5 3.2a1.4 1.4 0 0 0-2 0l-1.6 1.6 1.1 1.1-3.9 3.9-2.4-.5a1 1 0 0 0-.9 1.7l2.7 2.7-3.4 3.4a1 1 0 0 0 1.4 1.4l3.4-3.4 2.7 2.7a1 1 0 0 0 1.7-.9l-.5-2.4 3.9-3.9 1.1 1.1 1.6-1.6a1.4 1.4 0 0 0 0-2l-4.9-4.9Z"/></svg>';

  function buildChatItem(chat) {
    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'chat-item' + (String(chat.id) === String(state.activeChatId) ? ' is-active' : '');
    item.setAttribute('data-id', String(chat.id));
    item.setAttribute('role', 'listitem');

    /* 所有 DeepSeek 智能体统一使用 App 图标，靠名字区分 */
    var avatar = document.createElement('img');
    avatar.className = 'chat-avatar';
    avatar.src = 'img/agent-avatar.jpg';
    avatar.alt = '';
    avatar.setAttribute('aria-hidden', 'true');

    var body = el('div', 'chat-item-body');
    var top = el('div', 'chat-item-top');
    top.appendChild(makeText('span', 'chat-item-title', chat.title || 'DeepSeek'));
    body.appendChild(top);
    body.appendChild(makeText('span', 'chat-item-preview', previewOf(chat)));

    var meta = el('div', 'chat-item-meta');
    meta.appendChild(makeText('span', 'chat-item-time', listTime(chat.updatedAt || chat.createdAt)));
    var unread = Math.max(0, parseInt(chat.unread, 10) || 0);
    if (unread > 0 && state.chatTab !== 'unread') {
      var badge = makeText('span', 'unread-badge', unread > 99 ? '99+' : String(unread));
      meta.appendChild(badge);
    } else if (chat.pinned) {
      var pin = el('span', 'chat-pin');
      pin.innerHTML = ICON_PIN;
      meta.appendChild(pin);
    }

    item.appendChild(avatar);
    item.appendChild(body);
    item.appendChild(meta);
    return item;
  }

  function renderChatListImpl(chats, activeId) {
    state.chats = Array.isArray(chats) ? chats.slice() : [];
    if (activeId !== undefined) state.activeChatId = activeId;
    var homeList = r('chats-list');
    var drawerList = r('chat-list');
    if (!homeList && !drawerList) return;

    var query = String(state.searchQuery || '').trim().toLowerCase();
    var items = state.chats;
    if (query && typeof state.cb.onSearch !== 'function') {
      items = state.chats.filter(function (chat) {
        var hay = String(chat.title || '') + ' ' + previewOf(chat);
        return hay.toLowerCase().indexOf(query) >= 0;
      });
    }

    var unreadTotal = 0;
    var archivedCount = 0;
    state.chats.forEach(function (chat) {
      unreadTotal += Math.max(0, parseInt(chat.unread, 10) || 0);
      if (chat && chat.archived) archivedCount++;
    });
    setNavBadge(unreadTotal);
    /* 搜索时 app.js 传入的是过滤后的列表，标签计数沿用上次全量结果，避免数字跳动 */
    if (!(query && typeof state.cb.onSearch === 'function')) {
      updateFolderTabs(archivedCount, state.chats.length - archivedCount);
    }
    var visible;
    if (state.chatTab === 'archived') {
      visible = items.filter(function (chat) { return !!chat.archived; });
    } else if (state.chatTab === 'unread') {
      visible = items.filter(function (chat) { return (parseInt(chat.unread, 10) || 0) > 0; });
    } else {
      visible = items.filter(function (chat) { return !chat.archived; });
    }

    [homeList, drawerList].forEach(function (list) {
      if (!list) return;
      list.textContent = '';
      visible.forEach(function (chat) { list.appendChild(buildChatItem(chat)); });
    });

    var homeEmpty = r('chats-empty');
    if (homeEmpty) {
      homeEmpty.hidden = visible.length > 0;
      if (!visible.length) {
        var title = homeEmpty.querySelector('.chatlist-empty-title');
        var sub = homeEmpty.querySelector('.chatlist-empty-sub');
        var tab = state.chatTab;
        var archivedMode = tab === 'archived';
        var unreadMode = tab === 'unread';
        if (title) {
          title.textContent = query
            ? '没有找到会话'
            : (archivedMode ? '暂无归档会话' : (unreadMode ? '没有未读消息' : '还没有聊天'));
        }
        if (sub) {
          sub.textContent = query
            ? '换个关键词试试'
            : (archivedMode ? '长按会话，选择「归档」即可移入此处' : (unreadMode ? '所有消息都读过了' : '点右下角按钮，开始一段新对话'));
        }
        var emptyBtn = homeEmpty.querySelector('.chatlist-empty-btn');
        if (emptyBtn) emptyBtn.hidden = archivedMode;
      }
    }

    var empty = r('chat-list-empty');
    if (empty) {
      empty.hidden = visible.length > 0;
      empty.textContent = visible.length
        ? ''
        : (query ? '没有找到匹配的会话' : (state.chatTab === 'archived' ? '暂无归档会话' : '暂无会话'));
    }
  }

  function findChat(id) {
    for (var i = 0; i < state.chats.length; i++) {
      if (String(state.chats[i].id) === String(id)) return state.chats[i];
    }
    return null;
  }

  function renameChatById(id) {
    var chat = findChat(id);
    var current = chat && chat.title ? String(chat.title) : '';
    promptRename(current).then(function (title) {
      if (title == null) return;
      var next = String(title).trim();
      if (!next) return;
      invoke('onRenameChat', chat ? chat.id : id, next);
    });
  }

  /* ------------------------------------------------------------------ *
   * 消息气泡
   * ------------------------------------------------------------------ */
  function lastMessageId() {
    return state.order.length ? state.order[state.order.length - 1] : '';
  }

  function lastData() {
    var id = lastMessageId();
    return id ? state.msgData[id] : null;
  }

  function lastAssistantData() {
    var id = lastAssistantId();
    return id ? state.msgData[id] : null;
  }

  function lastAssistantId() {
    for (var i = state.order.length - 1; i >= 0; i--) {
      var data = state.msgData[state.order[i]];
      if (data && data.role === 'assistant') return state.order[i];
    }
    return '';
  }

  function origMsgId(idString) {
    var data = state.msgData[idString];
    return data && data.id != null ? data.id : idString;
  }

  function makeActionButton(action, label, icon, id) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-action';
    btn.setAttribute('data-action', action);
    btn.setAttribute('data-id', String(id));
    btn.setAttribute('aria-label', label);
    btn.innerHTML = icon;
    return btn;
  }

  function buildMessageNode(msg) {
    var role = msg.role || 'assistant';
    var id = String(msg.id);
    var root = el('div', 'msg msg--' + role);
    root.setAttribute('data-msg-id', id);

    var bubble = el('div', 'bubble');
    var refs = { root: root, bubble: bubble, role: role };

    if (role === 'user' || role === 'note') {
      /* ARCH v2 P4：用户消息图片网格（≤4 张，点击全屏预览） */
      if (role === 'user') {
        var msgImages = el('div', 'msg-images');
        msgImages.hidden = true;
        bubble.appendChild(msgImages);
        refs.images = msgImages;
      }
      var plain = el('div', 'msg-content');
      plain.textContent = msg.content == null ? '' : String(msg.content);
      bubble.appendChild(plain);
      refs.content = plain;
      refs.textMode = true;
    } else if (role === 'tool') {
      /* ARCH v2 P1：工具调用卡片（状态徽章 + 参数折叠 + 结果折叠） */
      var toolCard = el('div', 'tool-card');
      var cardHead = el('div', 'tool-card-head');
      var cardIcon = el('span', 'tool-card-icon');
      cardIcon.innerHTML = ICON.wrench;
      var cardName = makeText('span', 'tool-card-name', 'tool');
      var cardBadge = makeText('span', 'tool-badge tool-badge--running', '运行中');
      var snapshotBadge = makeText('span', 'tool-snapshot-badge', '已备份');
      snapshotBadge.hidden = true;
      cardHead.appendChild(cardIcon);
      cardHead.appendChild(cardName);
      cardHead.appendChild(snapshotBadge);
      cardHead.appendChild(cardBadge);

      var argsDetails = document.createElement('details');
      argsDetails.className = 'tool-details tool-args';
      argsDetails.hidden = true;
      var argsSummary = document.createElement('summary');
      argsSummary.appendChild(makeText('span', 'tool-details-label', '参数'));
      var argsTextEl = makeText('span', 'tool-args-summary', '');
      argsSummary.appendChild(argsTextEl);
      var argsCaret = el('span', 'tool-details-caret');
      argsCaret.innerHTML = ICON.chevronDown;
      argsSummary.appendChild(argsCaret);
      var argsFull = el('pre', 'tool-code');
      argsDetails.appendChild(argsSummary);
      argsDetails.appendChild(argsFull);

      var resultDetails = document.createElement('details');
      resultDetails.className = 'tool-details tool-result';
      var resultSummary = document.createElement('summary');
      resultSummary.appendChild(makeText('span', 'tool-details-label', '结果'));
      var resultTextEl = makeText('span', 'tool-args-summary', '暂无输出');
      resultSummary.appendChild(resultTextEl);
      var resultCaret = el('span', 'tool-details-caret');
      resultCaret.innerHTML = ICON.chevronDown;
      resultSummary.appendChild(resultCaret);
      var resultBody = el('div', 'msg-content msg-content--tool');
      resultDetails.appendChild(resultSummary);
      resultDetails.appendChild(resultBody);

      /* 批次2：失败诊断折叠卡（退出码 / stderr / 建议） */
      var diagRoot = document.createElement('details');
      diagRoot.className = 'tool-diag';
      diagRoot.hidden = true;
      var diagSummary = document.createElement('summary');
      diagSummary.appendChild(makeText('span', 'tool-details-label', '失败诊断'));
      var diagCaret = el('span', 'tool-diag-caret');
      diagCaret.innerHTML = ICON.chevronDown;
      diagSummary.appendChild(diagCaret);
      var diagBody = el('div', 'tool-diag-body');
      diagRoot.appendChild(diagSummary);
      diagRoot.appendChild(diagBody);
      diagSummary.addEventListener('click', function () { refs.diagUserToggled = true; });

      toolCard.appendChild(cardHead);
      toolCard.appendChild(argsDetails);
      toolCard.appendChild(resultDetails);
      toolCard.appendChild(diagRoot);
      bubble.appendChild(toolCard);

      refs.toolCard = {
        card: toolCard,
        name: cardName,
        badge: cardBadge,
        args: argsDetails,
        argsSummary: argsTextEl,
        argsFull: argsFull,
        result: resultDetails,
        resultSummary: resultTextEl,
        resultBody: resultBody
      };
      refs.snapshotBadge = snapshotBadge;
      refs.toolDiag = { root: diagRoot, body: diagBody };
      refs.lastToolStatus = '';
      refs.lastToolArgs = null;
      refs.lastToolResult = null;
      refs.content = resultBody;
      refs.textMode = true;
    } else {
      /* assistant：推理折叠块 + 工具 chip + markdown 内容 + 错误块 */
      var details = document.createElement('details');
      details.className = 'reasoning';
      details.hidden = true;

      var summary = document.createElement('summary');
      summary.className = 'reasoning-summary';
      var spark = el('span', 'reasoning-spark');
      spark.innerHTML = ICON.spark;
      var label = el('span', 'reasoning-label');
      label.textContent = '思考过程';
      var caret = el('span', 'reasoning-caret');
      caret.innerHTML = ICON.chevronDown;
      summary.appendChild(spark);
      summary.appendChild(label);
      summary.appendChild(caret);

      var reasoningBody = el('div', 'reasoning-body md');
      details.appendChild(summary);
      details.appendChild(reasoningBody);

      var chips = el('div', 'tool-chips');
      chips.hidden = true;

      var content = el('div', 'msg-content md');

      /* SPEC v2.0 F5：引用来源卡（Telegram 链接预览风格） */
      var citations = el('div', 'msg-citations');
      citations.hidden = true;

      var error = el('div', 'msg-error');
      error.hidden = true;

      bubble.appendChild(details);
      bubble.appendChild(chips);
      bubble.appendChild(content);
      bubble.appendChild(citations);
      bubble.appendChild(error);

      refs.reasoning = details;
      refs.reasoningLabel = label;
      refs.reasoningBody = reasoningBody;
      refs.userToggled = false;
      refs.tools = chips;
      refs.content = content;
      refs.citations = citations;
      refs.error = error;

      summary.addEventListener('click', function () {
        refs.userToggled = true;
      });
    }

    /* 底部：操作 + 时间 */
    var foot = el('div', 'msg-foot');
    if (role === 'assistant' || role === 'tool') {
      var actions = el('div', 'msg-actions');
      actions.appendChild(makeActionButton('copy-msg', '复制', ICON.copy, msg.id));
      var retryBtn = makeActionButton('retry-msg', '重新生成', ICON.refresh, msg.id);
      retryBtn.hidden = true;
      actions.appendChild(retryBtn);
      refs.retryBtn = retryBtn;
      foot.appendChild(actions);
    }
    var time = makeText('span', 'msg-time', formatTime(msg.createdAt));
    refs.time = time;
    foot.appendChild(time);
    if (role === 'user') {
      var status = el('span', 'msg-status');
      status.innerHTML = ICON.checkDouble;
      foot.appendChild(status);
    }
    bubble.appendChild(foot);
    root.appendChild(bubble);
    return refs;
  }

  function renderToolChips(container, toolCalls) {
    container.textContent = '';
    (Array.isArray(toolCalls) ? toolCalls : []).forEach(function (tc) {
      var name = 'tool';
      var args = '';
      if (tc && typeof tc === 'object') {
        if (tc.function && tc.function.name) name = String(tc.function.name);
        else if (tc.name) name = String(tc.name);
        if (tc.function && tc.function.arguments != null) args = String(tc.function.arguments);
        else if (tc.arguments != null) args = String(tc.arguments);
      } else if (typeof tc === 'string') {
        name = tc;
      }
      var chip = el('span', 'tool-chip');
      var icon = el('span', 'tool-chip-icon');
      icon.innerHTML = ICON.wrench;
      chip.appendChild(icon);
      chip.appendChild(makeText('span', 'tool-name', name));
      if (args) {
        chip.appendChild(makeText('span', 'tool-args', truncate(args, 40)));
        chip.title = name + ' ' + args;
      }
      container.appendChild(chip);
    });
  }

  /* ------------------------------------------------------------------ *
   * 引用来源（SPEC v2.0 F5）
   * msg.citations = [{title,url,snippet,domain?}]
   * 渲染为 Telegram 链接预览卡；点击走 Bridge.openUrl（openExternal 兜底）。
   * ------------------------------------------------------------------ */
  function citationDomain(url) {
    var value = String(url == null ? '' : url);
    var match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(value);
    var host = match ? match[1] : value.replace(/^\/\//, '').split(/[/?#]/)[0];
    host = String(host || '').replace(/^www\./i, '');
    return host || '链接';
  }

  function normalizeCitations(citations) {
    var list = [];
    (Array.isArray(citations) ? citations : []).forEach(function (item) {
      if (!item) return;
      if (typeof item === 'string') {
        if (/^https?:\/\//i.test(item)) {
          list.push({ title: citationDomain(item), url: item, snippet: '', domain: citationDomain(item) });
        }
        return;
      }
      if (typeof item !== 'object') return;
      var url = item.url ? String(item.url) : '';
      if (!url) return;
      var snippet = item.snippet != null ? String(item.snippet)
        : (item.content != null ? String(item.content) : (item.description != null ? String(item.description) : ''));
      list.push({
        title: item.title ? String(item.title) : citationDomain(url),
        url: url,
        snippet: snippet,
        domain: item.domain ? String(item.domain) : citationDomain(url)
      });
    });
    return list;
  }

  function renderCitations(container, citations) {
    var list = normalizeCitations(citations);
    container.textContent = '';
    if (!list.length) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    list.forEach(function (item) {
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'citation-card';
      card.setAttribute('data-action', 'open-citation');
      card.setAttribute('data-url', item.url);
      card.setAttribute('aria-label', '打开来源 ' + item.title);

      var accent = el('span', 'citation-accent');
      var main = el('div', 'citation-main');
      main.appendChild(makeText('div', 'citation-title', item.title));
      main.appendChild(makeText('div', 'citation-domain', item.domain));
      if (item.snippet) main.appendChild(makeText('div', 'citation-snippet', item.snippet));

      card.appendChild(accent);
      card.appendChild(main);
      container.appendChild(card);
    });
  }

  function applyMessageFields(msg, refs) {
    var role = refs.role || msg.role || 'assistant';
    var id = String(msg.id);

    /* ARCH v2 P1：工具调用卡片字段（状态/参数/结果） */
    if (refs.toolCard) applyToolCardFields(msg, refs);

    /* ARCH v2 P4：用户消息图片网格 */
    if (refs.images) renderMessageImages(refs.images, msg.images);

    /* 正文 */
    if (refs.textMode) {
      var text = role === 'tool'
        ? toolResultText(msg)
        : (msg.content == null ? '' : String(msg.content));
      if (refs.lastText !== text) {
        refs.content.textContent = text;
        refs.lastText = text;
      }
    } else {
      var source = msg.content == null ? '' : String(msg.content);
      if (refs.lastMd !== source) {
        refs.content.innerHTML = md(source);
        refs.lastMd = source;
      }
    }

    /* 推理内容 */
    if (refs.reasoning) {
      var reasoning = msg.reasoning == null ? '' : String(msg.reasoning);
      if (reasoning) {
        refs.reasoning.hidden = false;
        if (refs.lastReasoning !== reasoning) {
          refs.reasoningBody.innerHTML = md(reasoning);
          refs.lastReasoning = reasoning;
        }
        var reasoningLabel = msg.streaming ? '思考中…' : '思考过程';
        if (refs.reasoningLabel.textContent !== reasoningLabel) {
          refs.reasoningLabel.textContent = reasoningLabel;
        }
        if (!refs.userToggled) {
          if (msg.streaming) refs.reasoning.open = true;
          else if (refs.reasoning.open) refs.reasoning.open = false;
        }
      } else if (!refs.reasoning.hidden) {
        refs.reasoning.hidden = true;
        refs.reasoning.open = false;
        refs.lastReasoning = '';
      }
    }

    /* 工具调用 chip */
    if (refs.tools) {
      if (role === 'tool') {
        var toolName = msg.toolName ? String(msg.toolName) : '';
        if (toolName) {
          if (refs.lastToolJson !== toolName) {
            refs.tools.hidden = false;
            renderToolChips(refs.tools, [{ name: toolName }]);
            refs.lastToolJson = toolName;
          }
        } else if (!refs.tools.hidden) {
          refs.tools.hidden = true;
        }
      } else if (Array.isArray(msg.toolCalls) && msg.toolCalls.length) {
        var toolJson = JSON.stringify(msg.toolCalls);
        if (refs.lastToolJson !== toolJson) {
          refs.tools.hidden = false;
          renderToolChips(refs.tools, msg.toolCalls);
          refs.lastToolJson = toolJson;
        }
      } else if (refs.lastToolJson !== '') {
        refs.tools.hidden = true;
        refs.tools.textContent = '';
        refs.lastToolJson = '';
      }
    }

    /* 错误 */
    if (refs.error) {
      if (msg.error) {
        refs.error.hidden = false;
        var errorText = String(msg.error);
        if (refs.lastErr !== errorText) {
          refs.error.textContent = '';
          refs.error.appendChild(makeText('div', 'msg-error-text', errorText));
          var retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'retry';
          retry.setAttribute('data-action', 'retry-msg');
          retry.setAttribute('data-id', id);
          retry.innerHTML = ICON.refresh + '<span>重试</span>';
          refs.error.appendChild(retry);
          refs.lastErr = errorText;
        }
      } else if (!refs.error.hidden) {
        refs.error.hidden = true;
        refs.error.textContent = '';
        refs.lastErr = '';
      }
    }

    /* 引用来源（SPEC v2.0 F5）：流式/增量更新时按 JSON 变化重渲染 */
    if (refs.citations) {
      var citationList = Array.isArray(msg.citations) ? msg.citations : [];
      var citationKey = '';
      try {
        citationKey = JSON.stringify(citationList);
      } catch (errCit) {
        citationKey = citationList.length ? 'len:' + citationList.length : '';
      }
      if (refs.lastCitations !== citationKey) {
        renderCitations(refs.citations, citationList);
        refs.lastCitations = citationKey;
      }
    }

    /* 时间 */
    if (refs.time && msg.createdAt) {
      var timeText = formatTime(msg.createdAt);
      if (refs.time.textContent !== timeText) refs.time.textContent = timeText;
    }

    /* 流式光标：由全局 streaming 状态控制；内容为空时改用 typing 三点，避免空气泡光标 */
    var hasContent = String(msg.content == null ? '' : msg.content).length > 0;
    var streaming = state.streaming && hasContent && (role === 'assistant' || role === 'tool') && id === lastAssistantId();
    if (refs.streaming !== streaming) {
      refs.bubble.classList.toggle('is-streaming', streaming);
      refs.streaming = streaming;
    }
  }

  function updateRetryVisibility() {
    var lastId = lastAssistantId();
    for (var i = 0; i < state.order.length; i++) {
      var id = state.order[i];
      var refs = state.msgNodes[id];
      if (!refs || !refs.retryBtn) continue;
      var data = state.msgData[id] || {};
      var show = !!data.error || (id === lastId && !data.streaming && !state.streaming);
      refs.retryBtn.hidden = !show;
    }
  }

  function markStreamingCursor() {
    var lastId = lastAssistantId();
    Object.keys(state.msgNodes).forEach(function (id) {
      var refs = state.msgNodes[id];
      if (!refs || !refs.bubble) return;
      var data = state.msgData[id] || {};
      var hasContent = String(data.content == null ? '' : data.content).length > 0;
      var should = state.streaming && hasContent && id === lastId;
      if (refs.streaming !== should) {
        refs.bubble.classList.toggle('is-streaming', should);
        refs.streaming = should;
      }
    });
  }

  function buildTypingNode() {
    var root = el('div', 'msg msg--assistant msg--typing');
    root.setAttribute('aria-hidden', 'true');
    var bubble = el('div', 'bubble bubble--typing');
    for (var i = 0; i < 3; i++) bubble.appendChild(el('span', 'typing-dot'));
    root.appendChild(bubble);
    return root;
  }

  function updateTyping() {
    var box = r('messages');
    if (!box) return;
    if (!state.typingEl) state.typingEl = buildTypingNode();
    var generating = state.streaming || state.composerBusy;
    var last = lastAssistantData();
    var contentEmpty = !last || !String(last.content == null ? '' : last.content).trim();
    var show = generating && contentEmpty;
    if (show) {
      if (state.typingEl.parentNode !== box) box.appendChild(state.typingEl);
      state.typingEl.hidden = false;
    } else {
      state.typingEl.hidden = true;
    }
  }

  function updateEmptyState() {
    var empty = r('empty-state');
    if (!empty) return;
    var hasMessages = state.order.length > 0;
    empty.hidden = hasMessages || state.streaming || state.composerBusy;
  }

  function insertDateChip(ts, box) {
    var key = dayKey(ts);
    if (key === state.lastDateKey) return;
    state.lastDateKey = key;
    var chip = el('div', 'date-chip');
    chip.appendChild(makeText('span', '', dateLabel(ts)));
    box.appendChild(chip);
  }

  function appendToBox(msg) {
    var box = r('messages');
    if (!box) return null;
    var id = String(msg.id);
    insertDateChip(msg.createdAt, box);
    state.msgData[id] = msg;
    var refs = buildMessageNode(msg);
    state.msgNodes[id] = refs;
    state.order.push(id);
    if (state.typingEl && state.typingEl.parentNode === box) box.insertBefore(refs.root, state.typingEl);
    else box.appendChild(refs.root);
    applyMessageFields(msg, refs);
    return refs;
  }

  function scrollToBottom() {
    var box = r('messages');
    if (!box) return;
    box.scrollTop = box.scrollHeight;
    state.autoScroll = true;
    var btn = r('scroll-bottom');
    if (btn) btn.hidden = true;
  }

  function onMessagesScroll() {
    var box = r('messages');
    if (!box) return;
    var distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    state.autoScroll = distance < 80;
    var btn = r('scroll-bottom');
    if (btn) btn.hidden = distance <= 220;
    syncHeaderShadow(box.scrollTop > 4);
  }

  function scheduleFlush() {
    if (state.pendingRaf) return;
    state.pendingRaf = raf(function () {
      state.pendingRaf = 0;
      flushDirty();
    });
  }

  function flushDirty() {
    var ids = Object.keys(state.dirty);
    state.dirty = Object.create(null);
    for (var i = 0; i < ids.length; i++) {
      var refs = state.msgNodes[ids[i]];
      var data = state.msgData[ids[i]];
      if (refs && data) applyMessageFields(data, refs);
    }
    updateRetryVisibility();
    updateTyping();
    updateEmptyState();
    if (state.autoScroll) scrollToBottom();
  }

  /* ------------------------------------------------------------------ *
   * 输入框
   * ------------------------------------------------------------------ */
  function autosize() {
    var input = r('composer-input');
    if (!input) return;
    var maxHeight = 120;
    input.style.height = 'auto';
    var height = input.scrollHeight || 36;
    input.style.height = Math.min(height, maxHeight) + 'px';
    input.style.overflowY = height > maxHeight ? 'auto' : 'hidden';
  }

  function syncSendButton() {
    var stop = state.streaming || state.composerBusy;
    var app = r('app');
    if (app) app.classList.toggle('is-streaming', stop);
    var btn = r('btn-send');
    if (btn) {
      btn.classList.toggle('is-stop', stop);
      btn.disabled = !stop && state.composerDisabled;
      btn.setAttribute('aria-label', stop ? '停止生成' : '发送');
    }
  }

  function fillComposer(text) {
    var input = r('composer-input');
    if (!input || input.disabled) return;
    input.value = text == null ? '' : String(text);
    autosize();
    try { input.focus(); } catch (err) { /* 静默 */ }
  }

  function handleSend() {
    if (state.streaming || state.composerBusy) {
      invoke('onStop');
      return;
    }
    if (state.composerDisabled) return;
    var input = r('composer-input');
    if (!input) return;
    var text = String(input.value || '').trim();
    var images = state.pendingImages.slice();
    if (!text && !images.length) return;
    var isCommand = text.charAt(0) === '/';

    /* ARCH v2 P4：带图片发送走 onSendWithImages(text, [dataUrl...]) */
    if (images.length && !isCommand) {
      if (typeof state.cb.onSendWithImages !== 'function') {
        UI.toast('图片发送服务尚未就绪');
        return;
      }
      var dataUrls = images.map(function (image) { return image.dataUrl; });
      if (!invoke('onSendWithImages', text, dataUrls)) return;
      input.value = '';
      autosize();
      clearPendingImages();
      closeDrawer();
      try { input.focus(); } catch (err) { /* 静默 */ }
      return;
    }

    if (!text) return;
    var fn = isCommand ? state.cb.onCommand : state.cb.onSend;
    if (typeof fn !== 'function') return;
    invoke(isCommand ? 'onCommand' : 'onSend', text);
    input.value = '';
    autosize();
    closeDrawer();
    try { input.focus(); } catch (err) { /* 静默 */ }
  }

  /* ------------------------------------------------------------------ *
   * 登录页
   * ------------------------------------------------------------------ */
  function showLoginError(text) {
    var error = r('login-error');
    var message = text == null ? '' : String(text);
    state.login.error = message;
    if (error) {
      error.textContent = message;
      error.hidden = !message;
    }
  }
  function doLogin() {
    var keyInput = r('login-key');
    var baseInput = r('login-baseurl');
    var apiKey = keyInput ? String(keyInput.value || '').trim() : '';
    var baseUrl = baseInput ? String(baseInput.value || '').trim() : '';
    if (!baseUrl) baseUrl = 'https://api.deepseek.com';
    if (!apiKey) {
      showLoginError('请输入 API Key');
      if (keyInput) { try { keyInput.focus(); } catch (err) { /* 静默 */ } }
      return;
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      showLoginError('Base URL 需以 http:// 或 https:// 开头');
      if (baseInput) { try { baseInput.focus(); } catch (err) { /* 静默 */ } }
      return;
    }
    showLoginError('');
    if (!invoke('onLogin', { apiKey: apiKey, baseUrl: baseUrl })) {
      showLoginError('登录服务尚未就绪');
    }
  }

  function toggleKeyVisible() {
    var input = r('login-key');
    if (!input) return;
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    var btn = document.querySelector('[data-action="toggle-key"]');
    if (btn) {
      btn.classList.toggle('is-on', show);
      btn.setAttribute('aria-label', show ? '隐藏 Key' : '显示或隐藏 Key');
    }
  }

  function toggleBaseUrl() {
    var field = r('login-advanced');
    if (!field) return;
    var visible = field.classList.toggle('is-visible');
    var btn = document.querySelector('[data-action="toggle-baseurl"]');
    if (btn) btn.textContent = visible ? '隐藏服务器地址' : '自定义服务器地址';
    if (visible) {
      var input = r('login-baseurl');
      if (input) { try { input.focus(); } catch (err) { /* 静默 */ } }
    }
  }

  function doPasteKey() {
    if (typeof state.cb.onPasteApiKey === 'function') {
      try {
        var result = state.cb.onPasteApiKey();
        if (result && typeof result.then === 'function') {
          result.then(function (text) { applyPastedKey(text); }, function () { /* 静默 */ });
        } else {
          applyPastedKey(result);
        }
        return;
      } catch (err) { /* 回退到剪贴板 */ }
    }
    readClipboard(applyPastedKey);
    function applyPastedKey(text) {
      var value = normalizeClipText(text).trim();
      if (!value) {
        UI.toast('剪贴板为空');
        return;
      }
      var input = r('login-key');
      if (input) {
        input.value = value;
        showLoginError('');
        try { input.focus(); } catch (err) { /* 静默 */ }
      }
    }
  }

  function doOpenSignup() {
    if (invoke('onOpenSignup')) return;
    openExternal('https://platform.deepseek.com/api_keys');
  }

  /* 登录页被多次打开时需要保证表单状态 */
  function resetLoginScreen() {
    var error = r('login-error');
    if (error) {
      error.hidden = true;
      error.textContent = '';
    }
    state.login.error = '';
    state.login.busy = false;
    var keyInput = r('login-key');
    if (keyInput) {
      keyInput.value = '';
      keyInput.type = 'password';
    }
    var toggle = document.querySelector('[data-action="toggle-key"]');
    if (toggle) toggle.classList.remove('is-on');

  }

  /* ------------------------------------------------------------------ *
   * 设置页
   * ------------------------------------------------------------------ */
  function setVal(id, value) {
    var node = r(id);
    if (node) node.value = value == null ? '' : String(value);
  }

  function normalizeModels(models) {
    var list = [];
    if (Array.isArray(models)) {
      models.forEach(function (model) {
        if (!model) return;
        if (typeof model === 'string') {
          list.push({ id: model, label: MODEL_LABELS[model] || model });
        } else if (typeof model === 'object') {
          var id = model.id || model.name;
          if (!id) return;
          list.push({ id: String(id), label: String(model.label || model.name || MODEL_LABELS[id] || id) });
        }
      });
    }
    if (!list.length) {
      list = [
        { id: 'deepseek-chat', label: MODEL_LABELS['deepseek-chat'] },
        { id: 'deepseek-reasoner', label: MODEL_LABELS['deepseek-reasoner'] }
      ];
    }
    return list;
  }

  function fillModelSelect(current) {
    var select = r('set-model');
    if (!select) return;
    select.textContent = '';
    var found = false;
    state.models.forEach(function (model) {
      var option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.label;
      select.appendChild(option);
      if (model.id === current) found = true;
    });
    if (!found && current) {
      var extra = document.createElement('option');
      extra.value = current;
      extra.textContent = modelLabel(current);
      select.appendChild(extra);
    }
    select.value = current || (state.models[0] && state.models[0].id) || 'deepseek-chat';
  }

  function collectSettings() {
    var baseInput = r('set-baseurl');
    var baseUrl = baseInput ? String(baseInput.value || '').trim() : '';
    if (!baseUrl) baseUrl = 'https://api.deepseek.com';
    if (!/^https?:\/\//i.test(baseUrl)) {
      UI.toast('Base URL 需以 http:// 或 https:// 开头');
      return null;
    }

    var temperatureInput = r('set-temperature');
    var temperature = temperatureInput ? parseFloat(temperatureInput.value) : 1;
    if (!isFinite(temperature)) temperature = 1;
    temperature = Math.max(0, Math.min(2, Math.round(temperature * 10) / 10));

    var maxTokensInput = r('set-maxtokens');
    var maxTokens = maxTokensInput ? parseInt(maxTokensInput.value, 10) : 4096;
    if (!isFinite(maxTokens)) maxTokens = 4096;
    maxTokens = Math.max(16, Math.min(8192, maxTokens));

    var modelSelect = r('set-model');
    var streamInput = r('set-stream');
    var systemPromptInput = r('set-systemprompt');

    return {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model: modelSelect ? modelSelect.value : state.model,
      temperature: temperature,
      maxTokens: maxTokens,
      stream: streamInput ? !!streamInput.checked : true,
      theme: 'dark',
      systemPrompt: systemPromptInput ? String(systemPromptInput.value || '') : ''
    };
  }

  function doSaveSettings() {
    var patch = collectSettings();
    if (!patch) return;
    if (!invoke('onSaveSettings', patch)) return;
    state.prefs = state.prefs || {};
    for (var key in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) state.prefs[key] = patch[key];
    }
    UI.setModel(patch.model);
    /* 保存成功的 toast 由 app.js 统一提示，避免重复 */
  }

  function doLogout() {
    /* app.js 的 onLogout 以 skipConfirm=true 调用，确认框由 UI 负责 */
    confirmDialog('退出登录', '将清除本机保存的 API Key（聊天记录保留）。确定要退出吗？').then(function (ok) {
      if (ok) invoke('onLogout');
    });
  }

  /* ------------------------------------------------------------------ *
   * 插件页
   * ------------------------------------------------------------------ */
  function pluginRow(plugin) {
    var row = el('div', 'plugin-row');
    row.setAttribute('data-plugin-id', String(plugin.id));

    var icon = el('div', 'plugin-icon');
    icon.innerHTML = ICON.puzzle;
    row.appendChild(icon);

    var main = el('div', 'plugin-main');
    var nameRow = el('div', 'plugin-name');
    nameRow.appendChild(makeText('span', 'plugin-title', plugin.name || plugin.id));
    if (plugin.version) nameRow.appendChild(makeText('span', 'plugin-version', 'v' + String(plugin.version)));
    if (plugin.builtin) nameRow.appendChild(makeText('span', 'plugin-badge', '内置'));
    main.appendChild(nameRow);

    if (plugin.description) main.appendChild(makeText('div', 'plugin-desc', plugin.description));
    if (plugin.author) main.appendChild(makeText('div', 'plugin-meta', '作者 ' + String(plugin.author)));
    row.appendChild(main);

    var switchLabel = el('label', 'switch');
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!plugin.enabled;
    checkbox.setAttribute('data-plugin-toggle', String(plugin.id));
    if (plugin.name) checkbox.setAttribute('aria-label', String(plugin.name) + ' 启用');
    switchLabel.appendChild(checkbox);
    switchLabel.appendChild(el('span', 'switch-track'));
    row.appendChild(switchLabel);

    if (!plugin.builtin) {
      var remove = el('button', 'plugin-del');
      remove.type = 'button';
      remove.setAttribute('data-action', 'remove-plugin');
      remove.setAttribute('data-id', String(plugin.id));
      remove.setAttribute('aria-label', '删除插件');
      remove.innerHTML = ICON.trash;
      row.appendChild(remove);
    }
    return row;
  }

  function findPlugin(id) {
    for (var i = 0; i < state.plugins.length; i++) {
      if (String(state.plugins[i].id) === String(id)) return state.plugins[i];
    }
    return null;
  }

  function openInstallModal() {
    var error = r('install-error');
    if (error) {
      error.hidden = true;
      error.textContent = '';
    }
    openModal(r('install-modal'));
    setTimeout(function () {
      var input = r('install-code');
      if (input) { try { input.focus(); } catch (err) { /* 静默 */ } }
    }, 140);
  }

  function showInstallError(text) {
    var error = r('install-error');
    if (!error) return;
    error.textContent = text == null ? '' : String(text);
    error.hidden = !text;
  }

  function doInstallPlugin() {
    var input = r('install-code');
    var code = input ? String(input.value || '').trim() : '';
    if (!code) {
      showInstallError('请先粘贴插件代码');
      return;
    }
    if (!invoke('onPluginInstall', code)) {
      showInstallError('当前版本暂不支持安装插件');
      return;
    }
    if (input) input.value = '';
    closeModal(r('install-modal'));
  }

  function doPickPluginFile() {
    closeModal(r('install-modal'));
    if (invoke('onPluginInstallFile')) return;
    var manager = window.DSPlugins;
    if (manager && typeof manager.installFromFile === 'function') {
      try {
        var result = manager.installFromFile();
        if (result && typeof result.catch === 'function') result.catch(function () { /* 静默 */ });
      } catch (err) {
        console.warn('[UI] 从文件安装插件失败:', err);
      }
      return;
    }
    if (window.Bridge && typeof window.Bridge.importPluginFile === 'function') {
      try { window.Bridge.importPluginFile(); } catch (err) { /* 静默 */ }
    }
  }

  function doRemovePlugin(id) {
    if (!id) return;
    var plugin = findPlugin(id);
    var name = plugin && plugin.name ? '「' + plugin.name + '」' : '该插件';
    /* app.js 的 onPluginRemove 以 skipConfirm=true 调用，确认框由 UI 负责 */
    confirmDialog('删除插件', '确定要删除' + name + '吗？删除后它的命令和工具将不可用。').then(function (ok) {
      if (ok) invoke('onPluginRemove', plugin ? plugin.id : id);
    });
  }

  /* ------------------------------------------------------------------ *
   * 长按菜单
   * ------------------------------------------------------------------ */
  function pressContext(target) {
    var msgEl = target.closest('.msg[data-msg-id]');
    if (msgEl) return { type: 'msg', id: msgEl.getAttribute('data-msg-id'), el: msgEl };
    var chatEl = target.closest('.chat-item[data-id]');
    if (chatEl) return { type: 'chat', id: chatEl.getAttribute('data-id'), el: chatEl };
    return null;
  }

  function openContextMenu(context, x, y) {
    if (!context) return;
    var items = [];

    if (context.type === 'msg') {
      var data = state.msgData[context.id] || {};
      var content = data.content == null ? '' : String(data.content);
      if (content) {
        items.push({
          label: '复制',
          icon: ICON.copy,
          run: function () { copyText(content); }
        });
      }
      /* SPEC v2.0 F4：从此消息创建分支（ARCH v2 P1 接入长按菜单） */
      if (typeof state.cb.onForkMessage === 'function') {
        items.push({
          label: '从此处新建分支',
          icon: ICON.fork,
          run: function () { invoke('onForkMessage', origMsgId(context.id)); }
        });
      }
      /* 批次3 v2.8.0：引用 / 编辑 / 复制为图片 */
      if (content) {
        items.push({
          label: '引用',
          icon: ICON.link,
          run: function () { quoteMessage(origMsgId(context.id)); }
        });
      }
      if ((data.role || '') === 'user' && content) {
        items.push({
          label: '编辑',
          icon: ICON.edit,
          run: function () { openEditMessage(context.id); }
        });
      }
      if (content || (Array.isArray(data.images) && data.images.length)) {
        items.push({
          label: '复制为图片',
          icon: ICON.download,
          run: function () { exportMessageImage(origMsgId(context.id)); }
        });
      }
      if ((data.role || 'assistant') === 'assistant') {
        items.push({
          label: '重新生成',
          icon: ICON.refresh,
          run: function () {
            var id = origMsgId(context.id);
            if (!invoke('onRetry', id)) invoke('onRegenerate', id);
          }
        });
      }
      if (typeof state.cb.onDeleteMessage === 'function') {
        items.push({
          label: '删除消息',
          icon: ICON.trash,
          danger: true,
          run: function () {
            confirmDialog('删除消息', '删除后不可恢复，确定要删除这条消息吗？').then(function (ok) {
              if (!ok) return;
              invoke('onDeleteMessage', origMsgId(context.id));
              UI.removeMessage(context.id);
            });
          }
        });
      }
    } else if (context.type === 'chat') {
      var chat = findChat(context.id) || { id: context.id };
      var pinHandler = state.cb.onPinChat || state.cb.onTogglePin;
      if (typeof pinHandler === 'function') {
        items.push({
          label: chat.pinned ? '取消置顶' : '置顶会话',
          icon: ICON.pin,
          run: function () {
            invoke(state.cb.onPinChat ? 'onPinChat' : 'onTogglePin', chat.id, !chat.pinned);
          }
        });
      }
      /* SPEC v2.0 F2：归档 / 取消归档 */
      items.push({
        label: chat.archived ? '取消归档' : '归档',
        icon: ICON.archive,
        run: function () {
          var nextArchived = !chat.archived;
          var handled = invoke('onArchiveChat', chat.id, nextArchived);
          if (!handled) {
            state.chats.forEach(function (item) {
              if (String(item.id) === String(chat.id)) item.archived = nextArchived;
            });
            renderChatListImpl(state.chats, state.activeChatId);
            UI.toast(nextArchived ? '已归档' : '已取消归档');
          }
          /* app.js 接管时由它持久化、刷新列表并 toast */
        }
      });
      items.push({
        label: '重命名',
        icon: ICON.edit,
        run: function () { renameChatById(context.id); }
      });
      items.push({
        label: '导出 Markdown',
        icon: ICON.download,
        run: function () { invoke('onExportChat', context.id); }
      });
      items.push({
        label: '复制为长图',
        icon: ICON.download,
        run: function () { exportChatImage(); }
      });
      items.push({
        label: '删除会话',
        icon: ICON.trash,
        danger: true,
        run: function () {
          /* app.js 的 onDeleteChat 以 skipConfirm=true 调用，确认框由 UI 负责 */
          var name = chat.title ? '「' + chat.title + '」' : '该会话';
          confirmDialog('删除会话', '确定删除' + name + '吗？删除后不可恢复。').then(function (ok) {
            if (ok) invoke('onDeleteChat', chat.id);
          });
        }
      });
    }

    if (!items.length) return;
    renderMenu(items, x, y);
  }

  function renderMenu(items, x, y) {
    var menu = r('longpress');
    if (!menu) return;
    menu.classList.remove('is-open');
    menu.textContent = '';
    state.menuItems = items.slice();

    items.forEach(function (item, index) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu-item' + (item.danger ? ' menu-item--danger' : '');
      button.setAttribute('data-action', 'menu-item');
      button.setAttribute('data-index', String(index));
      var icon = el('span', 'menu-icon');
      icon.innerHTML = item.icon || ICON.copy;
      button.appendChild(icon);
      button.appendChild(makeText('span', 'menu-label', item.label));
      menu.appendChild(button);
    });

    var menuWidth = menu.offsetWidth || 200;
    var menuHeight = menu.offsetHeight || (items.length * 40 + 10);
    var viewportWidth = window.innerWidth || 360;
    var viewportHeight = window.innerHeight || 640;
    var left = Math.max(8, Math.min(x, viewportWidth - menuWidth - 10));
    var top = Math.max(8, Math.min(y, viewportHeight - menuHeight - 10));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.setAttribute('aria-hidden', 'false');
    state.menuOpen = true;
    raf(function () { menu.classList.add('is-open'); });
    syncDepth();
  }

  function closeMenu() {
    var menu = r('longpress');
    if (menu) {
      menu.classList.remove('is-open');
      menu.setAttribute('aria-hidden', 'true');
    }
    if (state.menuOpen) {
      state.menuOpen = false;
      state.menuItems = [];
      syncDepth();
    }
  }

  function onPointerDown(event) {
    state.pressFired = false;
    var target = event.target;
    if (!target || !target.closest) return;

    if (state.menuOpen && !target.closest('#longpress')) closeMenu();
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (target.closest('.modal, #longpress, input, textarea, select, label, summary')) return;
    /* 消息气泡里的操作按钮不触发长按；会话列表项本身就是 button，需放行 */
    if (target.closest('button, a') && !target.closest('.chat-item')) return;

    var context = pressContext(target);
    if (!context) return;

    state.pressStart = { x: event.clientX, y: event.clientY, context: context, fired: false };
    clearTimeout(state.pressTimer);
    state.pressTimer = setTimeout(function fireLongPress() {
      var press = state.pressStart;
      if (!press) return;
      press.fired = true;
      state.pressFired = true;
      try {
        if (navigator.vibrate) navigator.vibrate(12);
      } catch (err) { /* 静默 */ }
      openContextMenu(press.context, press.x, press.y);
    }, 480);
  }

  function onPointerMove(event) {
    var press = state.pressStart;
    if (!press) return;
    var dx = event.clientX - press.x;
    var dy = event.clientY - press.y;
    if (dx * dx + dy * dy > 100) {
      clearTimeout(state.pressTimer);
      state.pressStart = null;
    }
  }

  function onPointerUp() {
    clearTimeout(state.pressTimer);
    state.pressStart = null;
  }

  function onContextMenu(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var context = pressContext(target);
    if (!context) return;
    event.preventDefault();
    clearTimeout(state.pressTimer);
    openContextMenu(context, event.clientX, event.clientY);
  }

  /* ------------------------------------------------------------------ *
   * 动作分发（#app 事件委托）
   * ------------------------------------------------------------------ */
  function handleHeaderBack() {
    /* ARCH v2 P1：审计页返回个人资料（不经过 app.js 的导航栈） */
    if (state.screen === 'audit') {
      showScreenImpl('profile');
      return;
    }
    /* ARCH v2 P2：MCP 页返回设置页 */
    if (state.screen === 'mcp') {
      showScreenImpl('settings');
      if (typeof state.cb.onCloseMcp === 'function') invoke('onCloseMcp');
      return;
    }
    /* 批次 1 v2.6.0：轨迹返回对话页；成本/工具权限返回设置页 */
    if (state.screen === 'trace') {
      showScreenImpl('chat');
      if (typeof state.cb.onCloseTrace === 'function') invoke('onCloseTrace');
      return;
    }
    if (state.screen === 'appearance') {
      showScreenImpl('settings');
      if (typeof state.cb.onCloseAppearance === 'function') invoke('onCloseAppearance');
      return;
    }
    if (state.screen === 'bots') {
      showScreenImpl('settings');
      if (typeof state.cb.onCloseBots === 'function') invoke('onCloseBots');
      return;
    }
    if (state.screen === 'cost' || state.screen === 'tool-policy' || state.screen === 'snapshots') {
      var closeSnapKey = state.screen === 'snapshots' ? 'onCloseSnapshots' : (state.screen === 'cost' ? 'onCloseCost' : 'onCloseToolPolicies');
      var snapScreen = state.screen;
      showScreenImpl('settings');
      if (typeof state.cb[closeSnapKey] === 'function') invoke(closeSnapKey);
      return;
    }
    /* ARCH v2 P3：插件市场 / 记忆返回设置页 */
    if (state.screen === 'market' || state.screen === 'memory') {
      var closeKey = state.screen === 'market' ? 'onCloseMarket' : 'onCloseMemory';
      showScreenImpl('settings');
      if (typeof state.cb[closeKey] === 'function') invoke(closeKey);
      return;
    }
    /* 智能体预设管理页：优先用 onCloseAgents 恢复导航，否则交给 app.js 的 onBack */
    if (state.screen === 'agents' && typeof state.cb.onCloseAgents === 'function') {
      invoke('onCloseAgents');
      return;
    }
    if (!invoke('onBack')) showScreenImpl('chat');
  }

  function handleBack() {
    if (state.menuOpen) { closeMenu(); return true; }
    if (isModalOpen(r('install-modal'))) { closeModal(r('install-modal')); return true; }
    if (isModalOpen(r('rename-modal'))) { resolveRename(null); return true; }
    if (isModalOpen(r('confirm-modal'))) { resolveConfirm(false); return true; }
    if (isModalOpen(r('risk-modal'))) { resolveRisk(false); return true; }
    if (isModalOpen(r('backup-modal'))) { closeModal(r('backup-modal')); return true; }
    if (isModalOpen(r('file-preview-modal'))) { closeFilePreview(); return true; }
    if (isModalOpen(r('mcp-form-modal'))) { closeMcpForm(); return true; }
    if (isModalOpen(r('memory-item-modal'))) { closeMemoryItemForm(); return true; }
    if (isModalOpen(r('image-viewer'))) { closeImageViewer(); return true; }
    if (isModalOpen(r('attachment-sheet'))) { closeAttachmentSheet(); return true; }
    if (state.buildPanelOpen) { closeBuildPanel(); return true; }
    if (isModalOpen(r('pin-modal'))) { resolvePin(false); return true; }
    if (isModalOpen(r('pin-setup-modal'))) { closePinSetup(); return true; }
    if (isModalOpen(r('password-modal'))) { resolvePassword(null); return true; }
    if (isModalOpen(r('edit-message-modal'))) { closeEditMessage(); return true; }
    if (isModalOpen(r('market-detail-modal'))) { closeMarketDetail(); return true; }
    if (isModalOpen(r('market-url-install-modal'))) { closeModal(r('market-url-install-modal')); return true; }
    if (isModalOpen(r('market-code-modal'))) { closeModal(r('market-code-modal')); return true; }
    if (isModalOpen(r('bot-form-modal'))) { closeBotForm(); return true; }
    if (isModalOpen(r('bot-detail-modal'))) { closeBotDetail(); return true; }
    var searchBar = r('chat-search-in');
    if (searchBar && !searchBar.hidden) { closeChatSearch(); return true; }
    if (state.pluginPanelOpen) { closePluginPanel(); return true; }
    if (state.fileDrawer.open) { closeFileDrawer(); return true; }
    if (state.modelPicker.open) { closeModelPickerPanel(true); return true; }
    if (state.agentPicker.open) { closeAgentPickerPanel(true); return true; }
    if (state.drawerOpen) { closeDrawer(); return true; }
    if (state.emojiOpen) { closeEmojiPanel(); return true; }
    if (state.terminal.open) { toggleTerminal(false); return true; }
    if (state.screen === 'audit') { showScreenImpl('profile'); return true; }
    if (state.screen === 'mcp') { showScreenImpl('settings'); return true; }
    if (state.screen === 'market' || state.screen === 'memory') { showScreenImpl('settings'); return true; }
    if (state.screen === 'trace') { showScreenImpl('chat'); return true; }
    if (state.screen === 'cost' || state.screen === 'tool-policy' || state.screen === 'snapshots') { showScreenImpl('settings'); return true; }
    if (state.screen === 'appearance') { showScreenImpl('settings'); return true; }
    if (state.screen === 'bots') { showScreenImpl('settings'); return true; }
    if (state.screen === 'agents') { handleHeaderBack(); return true; }
    if (state.screen === 'chat') { showScreenImpl('chats'); return true; }
    return false;
  }

  function codeFromCopyButton(button) {
    var scope = button.closest('.md-code, .code-block, .md-pre, pre');
    var code = null;
    if (scope) code = scope.querySelector('code');
    if (!code) {
      var pre = button.closest('pre');
      code = pre ? (pre.querySelector('code') || pre) : null;
    }
    return code ? code.textContent : '';
  }

  function handleAction(action, node) {
    switch (action) {
      case 'open-drawer':
        openDrawer();
        break;
      case 'close-drawer':
        closeDrawer();
        break;
      case 'new-chat':
        closeDrawer();
        invoke('onNewChat');
        break;
      case 'open-settings':
      case 'composer-settings':
        closeDrawer();
        invoke('onOpenSettings');
        showScreenImpl('settings');
        break;
      case 'open-plugins':
      case 'composer-plugins':
        closeDrawer();
        invoke('onOpenPlugins');
        showScreenImpl('plugins');
        break;
      case 'open-agents':
        openAgentsPage();
        break;
      case 'new-agent':
        newAgentFlow();
        break;
      case 'edit-agent':
        editAgentFlow(node.getAttribute('data-id'));
        break;
      case 'delete-agent':
        deleteAgentFlow(node.getAttribute('data-id'));
        break;
      case 'refresh-plugins':
        invoke('onPluginRefresh');
        break;
      case 'back':
        handleHeaderBack();
        break;
      case 'nav-chats':
        closeDrawer();
        invoke('onNavChats');
        break;
      case 'nav-share':
        closeDrawer();
        invoke('onNavShare');
        break;
      case 'nav-profile':
        closeDrawer();
        invoke('onNavProfile');
        break;
      case 'clear-chat-search': {
        var searchInput = r('chat-search-input');
        if (searchInput) searchInput.value = '';
        state.searchQuery = '';
        var clearBtn2 = r('chat-search-clear');
        if (clearBtn2) clearBtn2.hidden = true;
        clearTimeout(state.searchTimer);
        if (typeof state.cb.onSearch === 'function') invoke('onSearch', '');
        else renderChatListImpl(state.chats, state.activeChatId);
        break;
      }
      case 'copy-current':
        invoke('onCopyCurrent');
        break;
      case 'export-current':
        invoke('onExportCurrent');
        break;
      case 'edit-profile':
        invoke('onEditProfile');
        break;
      case 'export-all':
        invoke('onExportAll');
        break;
      case 'clear-all':
        invoke('onClearAll');
        break;
      case 'about':
        invoke('onAbout');
        break;
      /* -------- ARCH v2 P1：文件树 / 终端 / 高危确认 / 登录 / 工作区 / 审计 / 备份 -------- */
      case 'open-files':
        openFileDrawer();
        break;
      case 'close-files':
        closeFileDrawer();
        break;
      case 'files-refresh':
        refreshFileTree();
        break;
      case 'file-crumb':
        requestFilePath(node.getAttribute('data-path'), true);
        break;
      case 'file-node':
        requestFilePath(node.getAttribute('data-path'), node.getAttribute('data-dir') === '1');
        break;
      case 'toggle-terminal':
        toggleTerminal();
        break;
      case 'terminal-close':
        toggleTerminal(false);
        break;
      case 'terminal-clear':
        clearTerminal();
        break;
      case 'terminal-copy':
        copyTerminal();
        break;
      case 'terminal-run':
        runTerminalCommand();
        break;
      case 'risk-accept':
        resolveRisk(true);
        break;
      case 'risk-deny':
        resolveRisk(false);
        break;
      case 'set-workspace':
        if (!invoke('onSetWorkspace')) UI.toast('工作区服务尚未就绪');
        break;
      case 'reset-workspace': {
        /* 优先 onResetWorkspace；旧逻辑层没有时用 defaultRoot 调 onSetWorkspace(defaultRoot) */
        if (typeof state.cb.onResetWorkspace === 'function') {
          invoke('onResetWorkspace');
        } else if (state.workspace.defaultRoot) {
          if (!invoke('onSetWorkspace', state.workspace.defaultRoot)) UI.toast('工作区服务尚未就绪');
        } else {
          UI.toast('没有可用的默认工作区');
        }
        break;
      }
      case 'open-audit':
        openAudit();
        break;
      case 'refresh-audit':
        refreshAudit();
        break;
      /* -------- ARCH v2 P2：MCP 服务器管理 -------- */
      case 'open-mcp':
        openMcpPage();
        break;
      case 'mcp-page-refresh':
        refreshMcpPage();
        break;
      case 'mcp-add':
        openMcpServerForm();
        break;
      case 'mcp-edit': {
        var editId = node.getAttribute('data-id') || node.getAttribute('data-mcp-id');
        openMcpServerForm(editId);
        break;
      }
      case 'mcp-connect':
        if (!invoke('onMcpConnect', node.getAttribute('data-id'))) UI.toast('MCP 服务尚未就绪');
        break;
      case 'mcp-disconnect':
        if (!invoke('onMcpDisconnect', node.getAttribute('data-id'))) UI.toast('MCP 服务尚未就绪');
        break;
      case 'mcp-refresh':
        if (!invoke('onMcpRefresh', node.getAttribute('data-id'))) UI.toast('MCP 服务尚未就绪');
        break;
      case 'mcp-test':
        if (!invoke('onMcpTest', node.getAttribute('data-id'))) UI.toast('MCP 服务尚未就绪');
        break;
      case 'mcp-delete':
        deleteMcpServer(node.getAttribute('data-id'));
        break;
      case 'mcp-form-save':
        submitMcpForm();
        break;
      case 'mcp-form-cancel':
        closeMcpForm();
        break;
      case 'mcp-toggle-token':
        toggleMcpToken();
        break;
      /* -------- ARCH v2 P3：插件市场 / 记忆 / 插件面板 -------- */
      case 'open-market':
        openMarketPage();
        break;
      case 'market-refresh':
        fetchMarketIndex(true);
        break;
      case 'market-fetch':
        fetchMarketIndex(false);
        break;
      case 'market-retry':
        fetchMarketIndex(true);
        break;
      case 'market-search-clear':
        setMarketQuery('');
        break;
      case 'market-category':
        setMarketCategory(node.getAttribute('data-category'));
        break;
      case 'market-detail':
        openMarketDetail(node.getAttribute('data-id'));
        break;
      case 'close-market-detail':
        closeMarketDetail();
        break;
      case 'market-url-install':
        openMarketUrlInstall();
        break;
      case 'close-market-url-install':
        closeModal(r('market-url-install-modal'));
        break;
      case 'install-market-url':
        submitMarketUrlInstall();
        break;
      case 'market-code-install':
        openMarketCodeInstall();
        break;
      case 'close-market-code':
        closeModal(r('market-code-modal'));
        break;
      case 'install-market-code':
        submitMarketCodeInstall();
        break;
      case 'market-toggle-source':
        toggleMarketSourcePanel();
        break;
      case 'market-set-source':
        saveCustomMarketSource();
        break;
      case 'market-reset-source':
        resetOfficialMarketSource();
        break;
      /* -------- v3.0.0：Bot 集成 -------- */
      case 'open-bots':
        openBotsPage();
        break;
      case 'bot-add':
        openBotForm();
        break;
      case 'bot-detail':
        openBotDetail(node.getAttribute('data-id'));
        break;
      case 'bot-edit': {
        var editId = node.getAttribute('data-id');
        var editBot = editId ? findBot(editId) : (state.bots.currentId ? findBot(state.bots.currentId) : null);
        if (editBot) {
          if (isModalOpen(r('bot-detail-modal'))) closeBotDetail();
          openBotForm(editBot);
        }
        break;
      }
      case 'bot-test': {
        var testId = node.getAttribute('data-id') || state.bots.currentId;
        var testBot = findBot(testId);
        if (testBot) {
          var testResult = callHandler('onBotTest', testBot.id, testBot);
          if (testResult === undefined) UI.toast('Bot 服务尚未就绪');
          else Promise.resolve(testResult).then(function (res) {
            var ok = res === true || (res && typeof res === 'object' && res.ok === true);
            UI.toast(ok ? '连接成功' : ((res && res.message) ? String(res.message) : '连接失败'));
          }, function () { UI.toast('连接失败'); });
        }
        break;
      }
      case 'bot-delete':
        deleteBotFromDetail();
        break;
      case 'bot-open-chat':
        openBotChatFromDetail();
        break;
      case 'close-bot-detail':
        closeBotDetail();
        break;
      case 'bot-send-test':
        sendBotTest();
        break;
      case 'bot-form-save':
        saveBotForm();
        break;
      case 'bot-form-test':
        testBotForm();
        break;
      case 'bot-form-cancel':
      case 'close-bot-form':
        closeBotForm();
        break;
      case 'bot-type':
        setBotFormType(node.getAttribute('data-type'));
        break;
      case 'bot-secret-toggle': {
        var secretInput = r('bot-field-app-secret');
        if (secretInput) {
          var show = secretInput.type === 'password';
          secretInput.type = show ? 'text' : 'password';
          node.classList.toggle('is-on', show);
          node.setAttribute('aria-pressed', show ? 'true' : 'false');
        }
        break;
      }
      case 'bot-target': {
        var targetId = node.getAttribute('data-target-id');
        if (targetId) {
          setVal('bot-detail-chat-id', targetId);
          botDetailError('');
          var targetBox = r('bot-detail-targets-list');
          if (targetBox) {
            Array.prototype.forEach.call(targetBox.querySelectorAll('.bot-target'), function (item) {
              item.classList.toggle('is-selected', item === node);
            });
          }
        }
        break;
      }
      case 'market-install':
        installMarketItem(node.getAttribute('data-id'));
        break;
      case 'market-remove':
        removeMarketItem(node.getAttribute('data-id'));
        break;
      case 'open-memory':
        openMemoryPage();
        break;
      case 'memory-add-longterm':
        openMemoryItemForm();
        break;
      case 'memory-item-save':
        submitMemoryItem();
        break;
      case 'memory-item-cancel':
        closeMemoryItemForm();
        break;
      case 'memory-save-project':
        saveProjectMemory();
        break;
      case 'memory-delete-longterm':
        deleteLongTermMemory(node.getAttribute('data-key'));
        break;
      case 'memory-delete-summary':
        deleteSummaryMemory(node.getAttribute('data-chat-id'));
        break;
      case 'open-plugin-panel':
        closeDrawer();
        openPluginPanel();
        break;
      case 'close-plugin-panel':
        closePluginPanel();
        break;
      case 'slot-action':
        runPluginSlotAction(node.getAttribute('data-slot-id'), node.getAttribute('data-slot-action'));
        break;
      /* -------- ARCH v2 P4：工作台 / 构建任务 / 图片 -------- */
      case 'toggle-workbench':
        toggleWorkbench();
        break;
      case 'collapse-workbench':
        toggleWorkbench(false);
        break;
      case 'workbench-refresh':
        refreshWorkbenchTree();
        break;
      case 'open-build-panel':
        closePluginPanel();
        closeDrawer();
        openBuildPanel();
        break;
      case 'close-build-panel':
        closeBuildPanel();
        break;
      case 'open-attachment-sheet':
        openAttachmentSheet();
        break;
      case 'close-attachment-sheet':
        closeAttachmentSheet();
        break;
      case 'pick-image':
        pickImage(node.getAttribute('data-source'));
        break;
      case 'remove-pending-image':
        removePendingImage(node.getAttribute('data-index'));
        break;
      case 'open-image-viewer':
        openImageViewer(node.getAttribute('data-src'));
        break;
      case 'close-image-viewer':
        closeImageViewer();
        break;
      /* -------- 批次1 v2.6.0：轨迹 / 成本 / 工具权限 / 审计导出 / 斜杠命令 -------- */
      case 'open-trace':
        openTracePage();
        break;
      case 'export-trace':
        if (!invoke('onExportTrace')) UI.toast('轨迹导出服务尚未就绪');
        break;
      case 'replay-tool':
        replayToolTrace(node.getAttribute('data-trace-id'));
        break;
      case 'clear-trace-search':
        searchTrace('');
        break;
      case 'open-cost':
        openCostPage();
        break;
      case 'open-tool-policies':
        openToolPolicyPage();
        break;
      /* -------- 批次2 v2.7.0：快照 / PIN / 加密备份 -------- */
      case 'open-snapshots':
        openSnapshotsPage();
        break;
      case 'create-snapshot':
        createSnapshot();
        break;
      case 'snapshot-toggle':
        toggleSnapshot(node.getAttribute('data-id'));
        break;
      case 'snapshot-diff':
        loadSnapshotDiff(node.getAttribute('data-id'));
        break;
      case 'restore-snapshot':
        restoreSnapshot(node.getAttribute('data-id'));
        break;
      case 'delete-snapshot':
        deleteSnapshot(node.getAttribute('data-id'));
        break;
      case 'pin-confirm':
        submitPin();
        break;
      case 'pin-cancel':
        resolvePin(false);
        break;
      case 'pin-setup-save':
        submitPinSetup();
        break;
      case 'pin-setup-cancel':
        closePinSetup();
        break;
      case 'password-confirm':
        submitPassword();
        break;
      case 'password-cancel':
        resolvePassword(null);
        break;
      /* -------- 批次3 v2.8.0：外观 / 引用 / 编辑 / 搜索 / 长图 / 语言 -------- */
      case 'open-appearance':
        openAppearancePage();
        break;
      case 'set-theme': {
        var themeValue = node.getAttribute('data-theme');
        applyTheme(themeValue);
        if (!invoke('onSetTheme', themeValue)) UI.toast('主题服务尚未就绪');
        break;
      }
      case 'set-font-scale': {
        var scaleValue = Number(node.getAttribute('data-scale'));
        setFontScale(scaleValue);
        if (!invoke('onSetFontScale', scaleValue)) UI.toast('字号服务尚未就绪');
        break;
      }
      case 'pick-wallpaper':
        if (!invoke('onPickWallpaper')) UI.toast('壁纸选择服务尚未就绪');
        break;
      case 'clear-wallpaper':
        clearWallpaper();
        if (!invoke('onClearWallpaper')) UI.toast('壁纸服务尚未就绪');
        break;
      case 'set-locale':
        setLocale(node.getAttribute('data-locale'));
        break;
      case 'cancel-quote':
        cancelQuote();
        break;
      case 'edit-message-save':
        submitEditMessage();
        break;
      case 'edit-message-cancel':
        closeEditMessage();
        break;
      case 'chat-search-prev':
        moveChatSearch(-1);
        break;
      case 'chat-search-next':
        moveChatSearch(1);
        break;
      case 'close-chat-search':
        closeChatSearch();
        break;
      case 'export-chat-image':
        exportChatImage();
        break;
      case 'tool-policy':
        setToolPolicyMode(node.getAttribute('data-tool'), node.getAttribute('data-mode'));
        break;
      case 'export-audit-json':
        if (!invoke('onExportAudit', 'json')) UI.toast('审计导出服务尚未就绪');
        break;
      case 'export-audit-csv':
        if (!invoke('onExportAudit', 'csv')) UI.toast('审计导出服务尚未就绪');
        break;
      case 'slash-pick':
        pickSlashCommand(node.getAttribute('data-index'));
        break;
      case 'open-backup':
        setBackupError('');
        openModal(r('backup-modal'));
        break;
      case 'close-backup':
        closeModal(r('backup-modal'));
        break;
      case 'export-backup':
        doExportBackup();
        break;
      case 'import-backup':
        doImportBackup();
        break;
      case 'close-file-preview':
        closeFilePreview();
        break;
      case 'copy-file-preview':
        copyFilePreview();
        break;
      case 'dismiss-tip':
        setTipVisible(false);
        if (typeof state.cb.onDismissTip === 'function') invoke('onDismissTip');
        break;
      case 'back-to-chats':
        closeEmojiPanel();
        showScreenImpl('chats');
        break;
      case 'toggle-chat-search':
        toggleChatSearch();
        break;
      case 'close-chat-search':
        toggleChatSearch(false);
        break;
      case 'toggle-emoji':
        toggleEmojiPanel();
        break;
      case 'open-search':
        if (state.screen === 'chat') { openChatSearch(); }
        else if (state.screen === 'chats') { toggleChatSearch(true); }
        else { openDrawer(); focusSearch(); }
        break;
      case 'clear-search':
        clearSearch();
        break;
      case 'scroll-bottom':
        UI.scrollBottom(true);
        break;
      case 'send':
        handleSend();
        break;
      case 'suggest':
        fillComposer(node.getAttribute('data-text') || '');
        break;
      case 'copy-msg': {
        var msgId = node.getAttribute('data-id');
        var data = state.msgData[msgId];
        if (data) {
          var copyValue = data.role === 'tool'
            ? toolResultText(data)
            : (data.content == null ? '' : String(data.content));
          if (copyValue) copyText(copyValue);
        }
        break;
      }
      case 'retry-msg': {
        var retryId = node.getAttribute('data-id');
        if (!retryId) break;
        if (!invoke('onRetry', origMsgId(retryId))) invoke('onRegenerate', origMsgId(retryId));
        break;
      }
      case 'copy-code': {
        var code = codeFromCopyButton(node);
        if (code) copyText(code);
        break;
      }
      case 'open-install':
        closeDrawer();
        openInstallModal();
        break;
      case 'close-install':
        closeModal(r('install-modal'));
        break;
      case 'install-plugin':
        doInstallPlugin();
        break;
      case 'pick-plugin-file':
        doPickPluginFile();
        break;
      case 'confirm-cancel':
        resolveConfirm(false);
        break;
      case 'confirm-ok':
        resolveConfirm(true);
        break;
      case 'rename-cancel':
        resolveRename(null);
        break;
      case 'rename-save':
        commitRename();
        break;
      case 'save-settings':
        doSaveSettings();
        break;
      case 'logout':
        doLogout();
        break;
      case 'toggle-key':
        toggleKeyVisible();
        break;
      case 'toggle-baseurl':
        toggleBaseUrl();
        break;
      case 'paste-key':
        doPasteKey();
        break;
      case 'open-signup':
        doOpenSignup();
        break;
      case 'remove-plugin':
        doRemovePlugin(node.getAttribute('data-id'));
        break;
      case 'menu-item': {
        var index = parseInt(node.getAttribute('data-index'), 10);
        var item = state.menuItems[index];
        closeMenu();
        if (item && typeof item.run === 'function') {
          try { item.run(); } catch (err) { console.warn('[UI] 菜单动作失败:', err); }
        }
        break;
      }
      case 'open-model-picker':
        requestModelPicker();
        break;
      case 'close-model-picker':
        closeModelPickerPanel(true);
        break;
      case 'clear-model-search':
        clearModelPickerSearch();
        break;
      case 'pick-model':
        pickModel(node.getAttribute('data-id'));
        break;
      case 'toggle-custom-model':
        toggleCustomModel();
        break;
      case 'add-custom-model':
        addCustomModel();
        break;
      case 'delete-custom-model':
        deleteCustomModel(node.getAttribute('data-id'));
        break;
      case 'refresh-models':
        refreshModelPicker();
        break;
      case 'close-agent-picker':
        closeAgentPickerPanel(true);
        break;
      case 'pick-agent':
        pickAgent(node.getAttribute('data-id'));
        break;
      case 'manage-agents':
        manageAgentsFromPicker();
        break;
      case 'open-citation': {
        var citationUrl = node.getAttribute('data-url') || '';
        if (/^https?:\/\//i.test(citationUrl)) openExternal(citationUrl);
        else if (citationUrl) UI.toast('无法打开该链接');
        break;
      }
      default:
        break;
    }
  }

  function onClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;

    /* 长按触发后吞掉一次 click */
    if (state.pressFired) {
      state.pressFired = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (state.menuOpen && !target.closest('#longpress')) closeMenu();

    if (state.slash.open && !target.closest('#slash-menu') && !target.closest('#composer')) {
      closeSlashMenu();
    }

    var shareNode = target.closest('[data-share-id]');
    if (shareNode) {
      invoke('onShareChat', shareNode.getAttribute('data-share-id'));
      return;
    }
    var tabNode = target.closest('#chat-tabs [data-tab]');
    if (tabNode) {
      switchChatTab(tabNode.getAttribute('data-tab'));
      return;
    }
    if (target.closest('#chat-tabs')) return;

    var emojiNode = target.closest('[data-emoji]');
    if (emojiNode) {
      insertEmoji(emojiNode.getAttribute('data-emoji'));
      return;
    }

    var actionNode = target.closest('[data-action]');
    if (actionNode && actionNode.getAttribute('data-action')) {
      handleAction(actionNode.getAttribute('data-action'), actionNode);
      return;
    }

    var chatItem = target.closest('.chat-item[data-id]');
    if (chatItem) {
      var chatId = chatItem.getAttribute('data-id');
      var chat = findChat(chatId);
      closeDrawer();
      invoke('onSelectChat', chat ? chat.id : chatId);
    }
  }

  function onInput(event) {
    var target = event.target;
    if (!target) return;
    if (target.id === 'composer-input') {
      autosize();
      updateSlashFromComposer();
      return;
    }
    if (target.id === 'trace-search') {
      searchTrace(target.value);
      return;
    }
    if (target.id === 'chat-search-in-input') {
      searchInChat(target.value);
      return;
    }
    if (target.id === 'market-search') {
      setMarketQuery(target.value);
      return;
    }
    if (target.id === 'appearance-glass-intensity' || target.id === 'appearance-glass-speed') {
      applyGlassOptions({
        intensity: r('appearance-glass-intensity') ? Number(r('appearance-glass-intensity').value) : state.appearance.glass.intensity,
        speed: r('appearance-glass-speed') ? Number(r('appearance-glass-speed').value) : state.appearance.glass.speed
      });
      return;
    }
    if (target.id === 'search-input') {
      onSearchInput();
      return;
    }
    if (target.id === 'chat-search-input') {
      onChatSearchInput();
      return;
    }
    if (target.id === 'model-picker-search') {
      state.modelPicker.query = String(target.value || '');
      var pickerClear = r('model-picker-search-clear');
      if (pickerClear) pickerClear.hidden = !state.modelPicker.query;
      renderModelPickerList();
      return;
    }
    if (target.id === 'set-temperature') {
      var value = r('set-temperature-val');
      if (value) value.textContent = Number(target.value).toFixed(1);
    }
  }

  function onChange(event) {
    var target = event.target;
    if (!target || !target.getAttribute) return;
    var shareOpt = target.getAttribute('data-share-opt');
    if (shareOpt) {
      invoke('onShareOption', shareOpt, !!target.checked);
      return;
    }
    var pluginId = target.getAttribute('data-plugin-toggle');
    if (pluginId) {
      invoke('onPluginToggle', pluginId, !!target.checked);
      return;
    }
    /* ARCH v2 P4：应用锁开关 */
    if (target.id === 'set-applock') {
      toggleAppLock(!!target.checked);
      return;
    }
    /* 批次2：安全 PIN 开关 */
    if (target.id === 'set-pin') {
      setPinEnabled(!!target.checked);
      return;
    }
    /* 批次3 v2.9.0：市场排序 */
    if (target.id === 'market-sort') {
      setMarketSort(target.value);
      return;
    }
    /* v3.0.0：Bot 启用开关 / 自动回复风险确认 */
    if (target.classList && target.classList.contains('bot-toggle')) {
      toggleBot(target.getAttribute('data-bot-id'), target.checked);
      return;
    }
    if (target.id === 'bot-field-auto-reply') {
      handleBotAutoReplyToggle(!!target.checked);
      return;
    }
    /* 批次3：液态玻璃滑块（松手/change 时保存） */
    if (target.id === 'appearance-glass-intensity' || target.id === 'appearance-glass-speed') {
      if (!invoke('onSetGlassOptions', {
        intensity: state.appearance.glass.intensity,
        speed: state.appearance.glass.speed
      })) UI.toast('液态玻璃设置服务尚未就绪');
    }
    /* Root 模式开关 */
    if (target.id === 'set-rootmode') {
      toggleRootMode(!!target.checked);
    }
  }

  function onKeyDown(event) {
    var target = event.target;
    if (!target) return;
    var key = event.key;
    if (key === 'Escape') {
      if (handleBack()) event.preventDefault();
      return;
    }
    if (target.id === 'composer-input') {
      if (state.slash.open) {
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          event.preventDefault();
          moveSlashMenu(key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (key === 'Escape') {
          event.preventDefault();
          closeSlashMenu();
          return;
        }
        if ((key === 'Enter' || key === 'Tab') && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          pickSlashCommand(state.slash.index);
          return;
        }
      }
      if (key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        handleSend();
      }
      return;
    }
    if (target.id === 'rename-input') {
      if (key === 'Enter') {
        event.preventDefault();
        commitRename();
      }
      return;
    }
    if (target.id === 'search-input') {
      if (key === 'Enter') {
        event.preventDefault();
        clearTimeout(state.searchTimer);
        if (typeof state.cb.onSearch === 'function') invoke('onSearch', state.searchQuery);
      }
      return;
    }
    if (target.id === 'login-key' || target.id === 'login-baseurl') {
      if (key === 'Enter') {
        event.preventDefault();
        doLogin();
      }
      return;
    }
    if (target.id === 'terminal-input') {
      if (key === 'Enter') {
        event.preventDefault();
        runTerminalCommand();
      }
      return;
    }
    if (target.id === 'mcp-form-name' || target.id === 'mcp-form-url' || target.id === 'mcp-form-token') {
      if (key === 'Enter') {
        event.preventDefault();
        submitMcpForm();
      }
      return;
    }
    if (target.id === 'bot-detail-send-text') {
      if (key === 'Enter') {
        event.preventDefault();
        sendBotTest();
      }
      return;
    }
    if (target.id === 'chat-search-in-input') {
      if (key === 'Enter') {
        event.preventDefault();
        moveChatSearch(event.shiftKey ? -1 : 1);
      }
      return;
    }
    if (target.id === 'pin-input') {
      if (key === 'Enter') {
        event.preventDefault();
        submitPin();
      }
      return;
    }
    if (target.id === 'pin-setup-new' || target.id === 'pin-setup-confirm') {
      if (key === 'Enter') {
        event.preventDefault();
        submitPinSetup();
      }
      return;
    }
    if (target.id === 'password-input') {
      if (key === 'Enter') {
        event.preventDefault();
        submitPassword();
      }
      return;
    }
    if (target.id === 'model-picker-custom-input') {
      if (key === 'Enter') {
        event.preventDefault();
        addCustomModel();
      }
      return;
    }
    if (target.id === 'memory-item-key' || target.id === 'memory-item-value') {
      if (key === 'Enter') {
        event.preventDefault();
        submitMemoryItem();
      }
      return;
    }
    if (target.classList && target.classList.contains('agent-row')) {
      if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        pickAgent(target.getAttribute('data-id'));
      }
      return;
    }
    if (target.classList && target.classList.contains('model-row')) {
      if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        pickModel(target.getAttribute('data-id'));
      }
    }
  }

  function onSubmit(event) {
    var form = event.target;
    if (form && form.id === 'login-form') {
      event.preventDefault();
      doLogin();
      return;
    }
  }

  function bindModalBackdrop(node, cancel) {
    if (!node) return;
    node.addEventListener('click', function (event) {
      if (event.target !== node) return;
      cancel();
    });
  }

  function bindEvents() {
    var app = r('app');
    if (!app) return;
    app.addEventListener('click', onClick);
    app.addEventListener('input', onInput);
    app.addEventListener('change', onChange);
    app.addEventListener('keydown', onKeyDown);
    app.addEventListener('submit', onSubmit);
    app.addEventListener('pointerdown', onPointerDown, { passive: true });
    app.addEventListener('pointerdown', onRipplePointerDown, { passive: true });
    app.addEventListener('pointermove', onPointerMove, { passive: true });
    app.addEventListener('pointerup', onPointerUp);
    app.addEventListener('pointercancel', onPointerUp);
    app.addEventListener('contextmenu', onContextMenu);

    var messages = r('messages');
    if (messages) messages.addEventListener('scroll', onMessagesScroll, { passive: true });

    window.addEventListener('resize', function () {
      if (state.autoScroll) scrollToBottom();
      applyWorkbench();
    });

    bindModalBackdrop(r('install-modal'), function () { closeModal(r('install-modal')); });
    bindModalBackdrop(r('confirm-modal'), function () { resolveConfirm(false); });
    bindModalBackdrop(r('rename-modal'), function () { resolveRename(null); });
    bindModalBackdrop(r('risk-modal'), function () { resolveRisk(false); });
    bindModalBackdrop(r('backup-modal'), function () { closeModal(r('backup-modal')); });
    bindModalBackdrop(r('file-preview-modal'), function () { closeFilePreview(); });
    bindModalBackdrop(r('mcp-form-modal'), function () { closeMcpForm(); });
    bindModalBackdrop(r('memory-item-modal'), function () { closeMemoryItemForm(); });
    bindModalBackdrop(r('bot-form-modal'), function () { closeBotForm(); });
    bindModalBackdrop(r('bot-detail-modal'), function () { closeBotDetail(); });
    bindModalBackdrop(r('market-detail-modal'), function () { closeMarketDetail(); });
    bindModalBackdrop(r('market-url-install-modal'), function () { closeModal(r('market-url-install-modal')); });
    bindModalBackdrop(r('market-code-modal'), function () { closeModal(r('market-code-modal')); });
    bindModalBackdrop(r('pin-modal'), function () { resolvePin(false); });
    bindModalBackdrop(r('pin-setup-modal'), function () { closePinSetup(); });
    bindModalBackdrop(r('password-modal'), function () { resolvePassword(null); });
    var pluginPanel = r('plugin-panel');
    if (pluginPanel) {
      pluginPanel.addEventListener('click', function (event) {
        if (event.target === pluginPanel) closePluginPanel();
      });
    }
    /* ARCH v2 P4：附件操作表 / 构建任务面板 / 图片预览 点击遮罩关闭 */
    bindModalBackdrop(r('attachment-sheet'), function () { closeAttachmentSheet(); });
    bindModalBackdrop(r('build-panel'), function () { closeBuildPanel(); });
    var imageViewer = r('image-viewer');
    if (imageViewer) {
      imageViewer.addEventListener('click', function (event) {
        if (event.target === imageViewer) closeImageViewer();
      });
    }
    /* 终端高度拖拽 */
    var resizeHandle = r('terminal-resize');
    if (resizeHandle) resizeHandle.addEventListener('pointerdown', onTerminalResizeStart, { passive: false });
    window.addEventListener('pointermove', onTerminalResizeMove, { passive: true });
    window.addEventListener('pointerup', onTerminalResizeEnd);
    window.addEventListener('pointercancel', onTerminalResizeEnd);
    bindModelPickerEvents();
    bindAgentPickerEvents();
    bindFileDrawerDrag();
  }

  function bindFileDrawerDrag() {
    var drawer = r('file-drawer');
    if (!drawer) return;
    drawer.addEventListener('pointerdown', onFileDrawerDragStart, { passive: true });
    window.addEventListener('pointermove', onFileDrawerDragMove, { passive: true });
    window.addEventListener('pointerup', onFileDrawerDragEnd);
    window.addEventListener('pointercancel', onFileDrawerDragEnd);
  }

  function cacheRefs() {
    var ids = [
      'app', 'screens',
      'screen-login', 'screen-chats', 'screen-chat', 'screen-settings', 'screen-plugins', 'screen-agents',
      'chats-list', 'chats-empty', 'chats-title', 'chat-search-wrap', 'chat-search-input', 'chat-search-clear',
      'chat-tabs', 'chat-tab-count-all', 'chat-tab-count-archived',
      'share-list', 'share-empty', 'profile-status', 'profile-info', 'profile-chat-count', 'profile-msg-count',
      'share-opt-time', 'share-opt-reasoning', 'share-opt-signature',
      'share-chat-count', 'share-msg-count', 'share-history', 'share-history-count',
      'profile-name', 'profile-bio', 'profile-plugin-count',
      'nav-badge', 'nav-chats', 'nav-share', 'nav-profile', 'tip-card',
      'chat-header', 'chat-head-avatar', 'emoji-panel', 'emoji-grid',
      'login-form', 'login-key', 'login-baseurl', 'login-error', 'login-submit', 'login-advanced',
      'header-title', 'header-subtitle',
      'messages', 'empty-state', 'scroll-bottom',
      'composer-input', 'btn-send',
      'chat-list', 'chat-list-empty',
      'search-input', 'search-clear',
      'user-avatar', 'user-name', 'user-status',
      'set-baseurl', 'set-model', 'set-temperature', 'set-temperature-val',
      'set-maxtokens', 'set-stream', 'set-systemprompt',
      'plugins-list', 'plugins-empty', 'plugins-count',
      'install-modal', 'install-code', 'install-error',
      'confirm-modal', 'confirm-title', 'confirm-text', 'confirm-ok',
      'rename-modal', 'rename-input', 'rename-title',
      'agent-picker', 'agent-picker-list', 'agent-picker-handle', 'agent-picker-title',
      'agents-list', 'agents-empty', 'agents-count', 'set-agents-label',
      'longpress', 'toasts', 'overlay', 'drawer',
      /* ARCH v2 P1：文件树 / 终端 / 高危确认 / 备份 / 登录 tab / 工作区 / 审计 */
      'file-overlay', 'file-drawer', 'file-root', 'file-crumbs', 'file-tree', 'file-empty',
      'file-refresh', 'file-close', 'file-foot',
      'terminal-panel', 'terminal-output', 'terminal-input', 'terminal-run',
      'risk-modal', 'risk-tool', 'risk-badge', 'risk-args', 'risk-hint', 'risk-deny', 'risk-accept',
      'backup-modal', 'backup-export', 'backup-import',
      'file-preview-modal', 'file-preview-name', 'file-preview-path', 'file-preview-content',
      'set-workspace-row', 'set-workspace-value', 'set-workspace-writable',
      'set-workspace-access', 'set-workspace-reset', 'set-workspace-reset-hint',
      'screen-audit', 'audit-list', 'audit-empty', 'audit-count',
      /* ARCH v2 P2：MCP 服务器管理 + 构建进度 */
      'screen-mcp', 'mcp-list', 'mcp-empty', 'mcp-count', 'mcp-add',
      'set-mcp-row', 'set-mcp-count',
      'mcp-form-modal', 'mcp-form-title', 'mcp-form-name', 'mcp-form-url',
      'mcp-form-token', 'mcp-form-error', 'mcp-form-save',
      /* ARCH v2 P3：插件市场 / 记忆 / 插件面板 */
      'screen-market', 'market-url', 'market-fetch', 'market-list', 'market-empty', 'market-count',
      'set-market-row', 'set-market-label',
      'screen-memory', 'memory-longterm', 'memory-longterm-empty', 'memory-add-longterm',
      'memory-tech-stack', 'memory-conventions', 'memory-decisions', 'memory-save-project',
      'memory-summaries', 'memory-summaries-empty', 'memory-count', 'set-memory-row', 'set-memory-label',
      'memory-item-modal', 'memory-item-title', 'memory-item-key', 'memory-item-value',
      'memory-item-error', 'memory-item-save',
      'plugin-panel', 'plugin-panel-title', 'plugin-panel-handle', 'plugin-slots', 'plugin-slots-empty',
      /* ARCH v2 P4：工作台 / 构建任务 / 图片 / 安全 */
      'workbench-toggle', 'workbench-files', 'workbench-tree', 'workbench-path',
      'workbench-refresh', 'terminal-resize',
      'composer-images', 'attachment-sheet', 'image-viewer', 'image-viewer-img',
      'build-panel', 'build-panel-title', 'build-tasks', 'build-empty',
      'set-applock', 'set-encryption-status', 'set-rootmode', 'set-root-status',
      /* 批次1 v2.6.0：轨迹 / 成本 / 工具权限 / 斜杠命令 / 审计导出 */
      'trace-toggle', 'screen-trace', 'trace-count', 'trace-export', 'trace-search',
      'trace-search-wrap', 'trace-search-clear', 'trace-list', 'trace-empty',
      'screen-cost', 'cost-count', 'cost-alert', 'cost-periods', 'cost-models', 'cost-empty', 'cost-budget',
      'set-cost-row', 'set-cost-label',
      'screen-tool-policy', 'tool-policy-count', 'tool-policy-list', 'tool-policy-mcp-list',
      'tool-policy-mcp-label', 'tool-policy-empty', 'set-tool-policy-row', 'set-tool-policy-label',
      'audit-export-json', 'audit-export-csv',
      'slash-menu', 'slash-list',
      /* 批次2 v2.7.0：快照 / PIN / 密码 / 加密备份 / 失败诊断 */
      'screen-snapshots', 'snapshots-count', 'snapshot-create', 'snapshots-list', 'snapshots-empty',
      'set-snapshots-row', 'set-snapshots-label',
      'set-pin', 'set-pin-status',
      'pin-modal', 'pin-title', 'pin-message', 'pin-input', 'pin-error',
      'pin-setup-modal', 'pin-setup-new', 'pin-setup-confirm', 'pin-setup-error',
      'password-modal', 'password-title', 'password-message', 'password-input', 'password-error',
      'backup-modal', 'backup-encrypt', 'backup-password', 'backup-error',
      /* 批次3 v2.8.0：外观 / 引用 / 编辑 / 会话搜索 / i18n */
      'screen-appearance', 'set-appearance-row', 'set-appearance-label',
      'appearance-theme-list', 'appearance-font-list', 'appearance-font-preview',
      'appearance-wallpaper-preview', 'appearance-wallpaper-img', 'appearance-wallpaper-empty',
      'appearance-glass-intensity', 'appearance-glass-speed',
      'appearance-glass-intensity-val', 'appearance-glass-speed-val', 'appearance-glass-values',
      'quote-bar', 'quote-role', 'quote-text',
      'edit-message-modal', 'edit-message-input', 'edit-message-error',
      'chat-search-in', 'chat-search-in-input', 'chat-search-in-count',
      /* 批次3 v2.9.0：市场升级 */
      'market-search', 'market-search-clear', 'market-categories', 'market-sort',
      'market-source-label', 'market-updated', 'market-source-panel', 'market-set-source', 'market-reset-source',
      'market-loading', 'market-error', 'market-error-text', 'market-url-install', 'market-code-install',
      'market-detail-modal', 'market-detail-name', 'market-detail-sub', 'market-detail-desc',
      'market-detail-tags', 'market-detail-version', 'market-detail-author', 'market-detail-size',
      'market-detail-category', 'market-detail-signature', 'market-detail-status',
      'market-detail-progress', 'market-detail-progress-fill', 'market-detail-progress-text',
      'market-detail-error', 'market-detail-actions',
      'market-url-install-modal', 'market-install-url', 'market-install-url-error',
      'market-code-modal', 'market-code-input', 'market-code-risk', 'market-code-error',
      /* v3.0.0：Bot 集成 */
      'screen-bots', 'bots-count', 'bots-list', 'bots-empty', 'set-bots-row', 'set-bots-label',
      'bot-form-modal', 'bot-form-title', 'bot-type-list', 'bot-field-name', 'bot-field-token',
      'bot-field-onebot-token', 'bot-field-onebot-base', 'bot-field-telegram', 'bot-field-onebot',
      'bot-field-enabled', 'bot-field-auto-reply', 'bot-field-cooldown', 'bot-field-limit',
      'bot-field-prompt', 'bot-field-whitelist', 'bot-form-error', 'bot-form-status',
      'bot-detail-modal', 'bot-detail-name', 'bot-detail-sub', 'bot-detail-status',
      'bot-detail-status-dot', 'bot-detail-count', 'bot-detail-messages', 'bot-detail-messages-empty',
      'bot-detail-send-text', 'bot-detail-chat-id', 'bot-detail-error',
      /* v3.1.0：QQ 官方机器人 */
      'bot-field-qqbot', 'bot-field-app-id', 'bot-field-app-secret', 'bot-secret-toggle',
      'bot-field-sandbox', 'bot-auto-reply-wrap', 'bot-qqbot-hint',
      'bot-detail-meta', 'bot-detail-targets', 'bot-detail-targets-list', 'bot-detail-targets-empty',
      'bot-detail-chat-hint', 'bot-detail-messages-label'
    ];
    ids.forEach(function (id) {
      state.refs[id] = document.getElementById(id);
    });
  }

  /* ------------------------------------------------------------------ *
   * 联系人（智能体列表）/ 个人资料 / 提示卡
   * ------------------------------------------------------------------ */
  function renderShareList(chats) {
    var list = r('share-list');
    if (!list) return;
    list.textContent = '';
    var items = Array.isArray(chats) ? chats : [];
    items.forEach(function (chat) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'chat-item chat-item--share';
      item.setAttribute('data-share-id', String(chat.id));

      var avatar = document.createElement('img');
      avatar.className = 'chat-avatar';
      avatar.src = 'img/agent-avatar.jpg';
      avatar.alt = '';
      avatar.setAttribute('aria-hidden', 'true');

      var body = el('div', 'chat-item-body');
      var top = el('div', 'chat-item-top');
      top.appendChild(makeText('span', 'chat-item-title', chat.title || 'DeepSeek'));
      body.appendChild(top);
      body.appendChild(makeText('span', 'chat-item-preview', previewOf(chat)));

      var meta = el('div', 'chat-item-meta');
      meta.appendChild(makeText('span', 'chat-item-time', listTime(chat.updatedAt || chat.createdAt)));
      var shareIcon = el('span', 'share-icon');
      shareIcon.innerHTML = ICON.share || '';
      meta.appendChild(shareIcon);

      item.appendChild(avatar);
      item.appendChild(body);
      item.appendChild(meta);
      list.appendChild(item);
    });
    var total = 0;
    items.forEach(function (chat) { total += (chat.messages || []).length; });
    var chatCount = r('share-chat-count');
    if (chatCount) chatCount.textContent = String(items.length);
    var msgCount = r('share-msg-count');
    if (msgCount) msgCount.textContent = String(total);

    var empty = r('share-empty');
    if (empty) empty.hidden = items.length > 0;
  }

  function renderShareHistory(items) {
    var box = r('share-history');
    if (!box) return;
    box.textContent = '';
    var list = Array.isArray(items) ? items : [];
    var countEl = r('share-history-count');
    if (countEl) countEl.textContent = String(list.length);
    if (!list.length) {
      box.appendChild(makeText('div', 'share-history-empty', '还没有分享记录，点上面的会话即可分享'));
      return;
    }
    list.forEach(function (item) {
      if (!item) return;
      var row = el('div', 'info-row info-row--history');
      row.appendChild(makeText('span', 'info-label', String(item.title || '聊天记录')));
      row.appendChild(makeText('span', 'info-value', String(item.time || '')));
      box.appendChild(row);
    });
  }

  function renderProfile(info) {
    info = info || {};
    var nameEl = r('profile-name');
    if (nameEl && info.name) nameEl.textContent = String(info.name);
    var status = r('profile-status');
    if (status) status.textContent = info.status == null ? '' : String(info.status);
    var bioEl = r('profile-bio');
    if (bioEl) {
      var bio = info.bio == null ? '' : String(info.bio).trim();
      bioEl.hidden = !bio;
      bioEl.textContent = bio;
    }

    var box = r('profile-info');
    if (box) {
      box.textContent = '';
      (Array.isArray(info.rows) ? info.rows : []).forEach(function (row) {
        if (!row) return;
        var node = el('div', 'info-row');
        node.appendChild(makeText('span', 'info-label', row.label == null ? '' : String(row.label)));
        node.appendChild(makeText('span', 'info-value', row.value == null ? '' : String(row.value)));
        box.appendChild(node);
      });
    }
    var chatCount = r('profile-chat-count');
    if (chatCount) chatCount.textContent = String(Math.max(0, parseInt(info.chats, 10) || 0));
    var msgCount = r('profile-msg-count');
    if (msgCount) msgCount.textContent = String(Math.max(0, parseInt(info.messages, 10) || 0));
    var pluginCount = r('profile-plugin-count');
    if (pluginCount) pluginCount.textContent = String(Math.max(0, parseInt(info.plugins, 10) || 0));
  }

  function setShareOptions(opts) {
    opts = opts || {};
    ['time', 'reasoning', 'signature'].forEach(function (key) {
      var input = r('share-opt-' + key);
      if (input) input.checked = !!opts[key];
    });
  }

  function setTipVisible(visible) {
    var tip = r('tip-card');
    if (tip) tip.hidden = !visible;
  }

  /* ------------------------------------------------------------------ *
   * 公开 API（SPEC §4.2 全部实现）
   * ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------ *
   * 液态玻璃 / 毛玻璃（v2.5.0，自动降级）
   * - liquid：Android 12+（API 31+）且 WebView 支持 backdrop-filter
   * - frost ：低版本 / 不支持背景模糊时使用毛玻璃
   * ------------------------------------------------------------------ */
  function detectGlassMode() {
    var sdk = 0;
    try {
      if (global.Bridge && typeof global.Bridge.appInfo === 'function') {
        var info = global.Bridge.appInfo();
        if (info && typeof info === 'object' && info.sdkInt) sdk = Number(info.sdkInt) || 0;
      }
    } catch (e) { /* ignore */ }
    var canBlur = false;
    try {
      canBlur = !!(global.CSS && typeof global.CSS.supports === 'function' &&
        (global.CSS.supports('backdrop-filter', 'blur(2px)') ||
         global.CSS.supports('-webkit-backdrop-filter', 'blur(2px)')));
    } catch (e2) { canBlur = false; }
    /* Android 12+ 一律使用液态玻璃（现代 WebView 均支持 backdrop-filter）；
       低版本走毛玻璃，避免 GPU 压力。canBlur 仅用于无 sdkInt 的浏览器环境兜底。 */
    var picked;
    if (sdk) picked = sdk >= 31 ? 'liquid' : 'frost';
    else picked = canBlur ? 'liquid' : 'frost';
    try {
      global.localStorage.setItem('dsh.glassDebug', JSON.stringify({ sdk: sdk, canBlur: canBlur, mode: picked }));
    } catch (e3) { /* ignore */ }
    return picked;
  }

  function applyGlassMode(mode) {
    var next = mode === 'liquid' ? 'liquid' : 'frost';
    var root = document.documentElement;
    root.classList.remove('glass-liquid', 'glass-frost');
    root.classList.add(next === 'liquid' ? 'glass-liquid' : 'glass-frost');
    state.glassMode = next;
    return next;
  }

  UI.init = function (callbacks) {
    if (state.initialized) return;
    state.cb = callbacks && typeof callbacks === 'object' ? callbacks : {};
    cacheRefs();
    try { applyGlassMode(detectGlassMode()); } catch (eGlass) { state.glassMode = 'frost'; }
    state.initialized = true;
    bindEvents();
    loadWorkbenchPrefs();
    renderPendingImages();
    renderBuildTaskList();
    showScreenImpl('chats');
    buildEmojiPanel();
    setTerminalOpen(false);
    syncSendButton();
    autosize();
    updateEmptyState();
    updateTyping();
    var subtitle = r('header-subtitle');
    if (subtitle && !subtitle.textContent) subtitle.textContent = modelLabel(state.model);
    var status = r('user-status');
    if (status && !status.textContent) status.textContent = 'API Key 已配置';
  };

  UI.showScreen = function (name) {
    showScreenImpl(name);
    if (name === 'login') resetLoginScreen();
  };

  UI.toast = function (text) {
    var wrapper = r('toasts');
    if (!wrapper) return;
    var message = text == null ? '' : String(text);
    if (!message) return;
    var toast = makeText('div', 'toast', message);
    wrapper.appendChild(toast);
    while (wrapper.children.length > 3) wrapper.removeChild(wrapper.firstChild);
    raf(function () { toast.classList.add('is-in'); });
    setTimeout(function () {
      toast.classList.remove('is-in');
      toast.classList.add('is-out');
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 220);
    }, 2100);
  };

  UI.setHeader = function (header) {
    var data = header || {};
    var title = data.title == null || data.title === '' ? 'DeepSeek House' : String(data.title);
    var subtitle = data.subtitle == null ? '' : String(data.subtitle);
    var titleEl = r('header-title');
    if (titleEl) titleEl.textContent = title;
    state.subtitleOverride = subtitle;
    var subtitleEl = r('header-subtitle');
    if (subtitleEl) subtitleEl.textContent = subtitle || modelLabel(state.model);
  };

  UI.renderChatList = function (chats, activeId) {
    renderChatListImpl(chats, activeId);
    updateSearchClear();
  };

  UI.renderMessages = function (chat) {
    var box = r('messages');
    if (!box) return;
    state.order = [];
    state.msgData = Object.create(null);
    state.msgNodes = Object.create(null);
    state.dirty = Object.create(null);
    state.lastDateKey = '';
    if (state.pendingRaf) {
      caf(state.pendingRaf);
      state.pendingRaf = 0;
    }
    box.textContent = '';
    if (state.typingEl && state.typingEl.parentNode) state.typingEl.parentNode.removeChild(state.typingEl);
    state.typingEl = null;

    var messages = chat && Array.isArray(chat.messages) ? chat.messages : [];
    messages.forEach(function (message) {
      if (message && message.id != null) appendToBox(message);
    });

    updateRetryVisibility();
    updateTyping();
    updateEmptyState();
    state.autoScroll = true;
    scrollToBottom();
  };

  UI.appendMessage = function (message) {
    if (!message || message.id == null) return;
    var id = String(message.id);
    if (state.msgNodes[id]) {
      UI.updateMessage(id, message);
      return;
    }
    appendToBox(message);
    updateRetryVisibility();
    updateTyping();
    updateEmptyState();
    if (state.autoScroll) scrollToBottom();
  };

  UI.updateMessage = function (msgId, patch) {
    if (msgId == null) return;
    var id = String(msgId);
    var data = state.msgData[id];
    if (!data) {
      data = { id: msgId, role: 'assistant' };
      state.msgData[id] = data;
    }
    if (patch && typeof patch === 'object') {
      for (var key in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) data[key] = patch[key];
      }
    }
    if (!state.msgNodes[id]) {
      appendToBox(data);
      updateRetryVisibility();
      updateTyping();
      updateEmptyState();
      if (state.autoScroll) scrollToBottom();
      return;
    }
    state.dirty[id] = true;
    scheduleFlush();
  };

  UI.removeMessage = function (msgId) {
    if (msgId == null) return;
    var id = String(msgId);
    var refs = state.msgNodes[id];
    if (refs && refs.root && refs.root.parentNode) refs.root.parentNode.removeChild(refs.root);
    delete state.msgNodes[id];
    delete state.msgData[id];
    var index = state.order.indexOf(id);
    if (index >= 0) state.order.splice(index, 1);
    delete state.dirty[id];
    updateRetryVisibility();
    updateTyping();
    updateEmptyState();
  };

  UI.setStreaming = function (streaming) {
    state.streaming = !!streaming;
    /* 流式结束时立刻结算挂起的增量渲染（推理标题/收起、重新生成按钮、光标），避免等下一帧 */
    if (!state.streaming && state.pendingRaf) {
      caf(state.pendingRaf);
      state.pendingRaf = 0;
      flushDirty();
    }
    syncSendButton();
    markStreamingCursor();
    updateTyping();
    updateEmptyState();
    if (state.streaming) {
      state.autoScroll = true;
      scrollToBottom();
    }
  };

  UI.setComposer = function (options) {
    var opts = options || {};
    var input = r('composer-input');
    if (Object.prototype.hasOwnProperty.call(opts, 'value') && input) {
      input.value = opts.value == null ? '' : String(opts.value);
      autosize();
    }
    if (Object.prototype.hasOwnProperty.call(opts, 'busy')) state.composerBusy = !!opts.busy;
    if (Object.prototype.hasOwnProperty.call(opts, 'disabled')) {
      state.composerDisabled = !!opts.disabled;
      if (input) input.disabled = state.composerDisabled;
    }
    if (Object.prototype.hasOwnProperty.call(opts, 'placeholder') && input) {
      input.placeholder = opts.placeholder == null ? '发消息…' : String(opts.placeholder);
    }
    syncSendButton();
    updateTyping();
    updateEmptyState();
  };

  UI.getComposer = function () {
    var input = r('composer-input');
    return input ? String(input.value || '') : '';
  };

  UI.scrollBottom = function (force) {
    if (force) {
      state.autoScroll = true;
    } else if (!state.autoScroll) {
      return;
    }
    scrollToBottom();
  };

  UI.setModel = function (model) {
    state.model = model == null ? 'deepseek-chat' : String(model);
    var select = r('set-model');
    if (select) {
      var has = false;
      for (var i = 0; i < select.options.length; i++) {
        if (select.options[i].value === state.model) { has = true; break; }
      }
      if (has) select.value = state.model;
    }
    if (!state.subtitleOverride) {
      var subtitle = r('header-subtitle');
      if (subtitle) subtitle.textContent = modelLabel(state.model);
    }
  };

  UI.renderSettings = function (prefs, models, presets) {
    state.prefs = prefs || {};
    state.models = normalizeModels(models);
    if (presets !== undefined) {
      state.agents = normalizeAgents(presets);
      renderAgentsList();
    }
    var data = state.prefs;
    setVal('set-baseurl', data.baseUrl || 'https://api.deepseek.com');
    setVal('set-maxtokens', data.maxTokens == null ? 4096 : data.maxTokens);
    var temperature = data.temperature == null ? 1 : Number(data.temperature);
    if (!isFinite(temperature)) temperature = 1;
    setVal('set-temperature', temperature);
    var temperatureValue = r('set-temperature-val');
    if (temperatureValue) temperatureValue.textContent = Number(temperature).toFixed(1);
    var stream = r('set-stream');
    if (stream) stream.checked = data.stream !== false;
    setVal('set-systemprompt', data.systemPrompt || '');
    fillModelSelect(data.model || state.model);
    if (data.model) UI.setModel(data.model);
  };

  UI.renderPlugins = function (plugins) {
    state.plugins = Array.isArray(plugins) ? plugins.slice() : [];
    var list = r('plugins-list');
    if (list) {
      list.textContent = '';
      state.plugins.forEach(function (plugin) {
        list.appendChild(pluginRow(plugin));
      });
    }
    var empty = r('plugins-empty');
    if (empty) empty.hidden = state.plugins.length > 0;
    var count = r('plugins-count');
    if (count) {
      var enabled = state.plugins.filter(function (plugin) { return !!plugin.enabled; }).length;
      count.textContent = state.plugins.length
        ? state.plugins.length + ' 个 · 已启用 ' + enabled + ' 个'
        : '内置与自定义插件';
    }
  };

  UI.renderLogin = function (info) {
    var data = info || {};
    if (Object.prototype.hasOwnProperty.call(data, 'hasKey')) state.login.hasKey = !!data.hasKey;
    if (Object.prototype.hasOwnProperty.call(data, 'error')) state.login.error = data.error ? String(data.error) : '';
    /* busy 未传视为“当前不在验证中”，避免上一轮 busy 状态残留 */
    state.login.busy = Object.prototype.hasOwnProperty.call(data, 'busy') ? !!data.busy : false;

    var error = r('login-error');
    if (error) {
      error.textContent = state.login.error;
      error.hidden = !state.login.error;
    }

    var submit = r('login-submit');
    if (submit) {
      submit.disabled = state.login.busy;
      submit.textContent = state.login.busy ? '验证中…' : (state.login.hasKey ? '进入' : '登录');
    }
    var keyInput = r('login-key');
    if (keyInput) keyInput.disabled = state.login.busy;
    var baseInput = r('login-baseurl');
    if (baseInput) baseInput.disabled = state.login.busy;

    var note = document.querySelector('.login-note');
    if (note) {
      note.textContent = state.login.hasKey
        ? '已检测到本机保存的 Key。输入新的 Key 可替换，直接重新登录即可验证。'
        : 'Key 只保存在本机的设备私有存储中，不会上传。支持自定义 OpenAI 兼容端点。';
    }
  };

  UI.setUser = function (user) {
    var data = user || {};
    var name = data.name == null || data.name === '' ? 'DeepSeek House' : String(data.name);
    var nameEl = r('user-name');
    if (nameEl) nameEl.textContent = name;
    var avatar = r('user-avatar');
    if (avatar) {
      var chars = Array.from(name.trim());
      var first = chars.length ? chars[0] : 'D';
      avatar.textContent = /[a-z]/i.test(first) ? first.toUpperCase() : first;
    }
    var status = r('user-status');
    if (status) {
      status.textContent = data.status != null ? String(data.status) : 'API Key 已配置';
    }
  };

  UI.confirm = function (title, text) {
    return confirmDialog(title, text);
  };

  /* 通用输入框（app.js 的 promptAsync 会优先使用它，替代 window.prompt） */
  UI.prompt = function (title, value, placeholder) {
    return inputDialog(title, value, placeholder);
  };

  /* 扩展辅助 API（非 SPEC 必需，提供给 app.js 做返回键/层级协作） */
  UI.getScreen = function () { return state.screen; };
  UI.renderShareList = renderShareList;
  UI.setShareOptions = setShareOptions;
  UI.renderShareHistory = renderShareHistory;
  UI.renderProfile = renderProfile;
  UI.setNavBadge = setNavBadge;
  UI.setTipVisible = setTipVisible;
  UI.syncBottomNav = syncBottomNav;
  UI.setChatAvatar = function (chat) { applyChatHeadAvatar(chat); };
  UI.toggleEmoji = toggleEmojiPanel;
  UI.closeEmoji = closeEmojiPanel;
  UI.handleBack = handleBack;
  UI.openDrawer = openDrawer;
  UI.closeDrawer = closeDrawer;
  UI.setDrawerOpen = function (open) {
    if (open) openDrawer();
    else closeDrawer();
  };
  UI.isDrawerOpen = function () { return state.drawerOpen; };
  /* SPEC v1.1 B2：模型选择器 / 模型标签（app.js 通过这三个入口驱动 UI） */
  UI.openModelPicker = function (models, currentId, onPick, opts) {
    openModelPickerPanel(models, currentId, onPick, opts);
  };
  UI.closeModelPicker = function () {
    closeModelPickerPanel(false);
  };
  UI.setModelLabel = function (label) {
    state.modelLabel = label == null ? '' : String(label);
    updateModelLabelUI();
  };

  /* SPEC v2.0 F1：智能体预设（app.js 通过这些入口驱动 UI） */
  UI.openAgentPicker = function (agents, currentId, onPick, opts) {
    openAgentPickerPanel(agents, currentId, onPick, opts);
  };
  UI.closeAgentPicker = function () {
    closeAgentPickerPanel(false);
  };
  UI.renderAgents = function (agents) {
    renderAgents(agents);
  };
  UI.openAgents = openAgentsPage;

  /* SPEC v2.0 F2：会话文件夹标签（'all' | 'archived'） */
  UI.setChatTab = function (tab) {
    switchChatTab(tab);
  };
  UI.getChatTab = function () {
    return state.chatTab;
  };

  /* ARCH v2 P1：本地 Agent 工作站 UI API */
  UI.renderFileTree = function (entries, opts) { return renderFileTree(entries, opts); };
  UI.openFileDrawer = openFileDrawer;
  UI.closeFileDrawer = closeFileDrawer;
  UI.isFileDrawerOpen = function () { return state.fileDrawer.open; };
  UI.setWorkspaceInfo = setWorkspaceInfo;
  UI.appendTerminal = function (text, opts) { appendTerminal(text, opts); };
  UI.clearTerminal = clearTerminal;
  UI.toggleTerminal = function (open) { return toggleTerminal(open); };
  UI.isTerminalOpen = function () { return state.terminal.open; };
  UI.confirmRisk = function (tool, args, risk) { return confirmRisk(tool, args, risk); };
  UI.renderAudit = function (items) { return renderAudit(items); };
  UI.openAudit = openAudit;
  UI.renderFilePreview = openFilePreview;
  UI.showFilePreview = openFilePreview;
  UI.previewFile = openFilePreview;
  UI.closeFilePreview = closeFilePreview;

  /* ARCH v2 P2：MCP 服务器管理 + 构建进度工具卡 */
  UI.renderMcpServers = function (list, statusMap) { return renderMcpServers(list, statusMap); };
  UI.openMcpServerForm = openMcpServerForm;
  UI.closeMcpForm = closeMcpForm;
  UI.openMcpPage = openMcpPage;
  UI.refreshMcpPage = refreshMcpPage;
  UI.setMcpStatus = function (id, status) { return setMcpStatus(id, status); };
  UI.getMcpServers = function () { return (state.mcp.servers || []).slice(); };
  UI.getMcpStatusMap = function () { return state.mcp.statusMap || {}; };
  UI.setToolProgress = function (msgId, data) { return setToolProgress(msgId, data); };
  UI.appendToolLog = function (msgId, line) { return appendToolLog(msgId, line); };

  /* ARCH v2 P3：插件市场 / 记忆 / 插件面板 */
  UI.renderMarket = function (items, statusMap) { return renderMarket(items, statusMap); };
  UI.openMarketPage = openMarketPage;
  UI.setMarketUrl = setMarketUrl;
  UI.getMarketUrl = function () { return state.market.url || ''; };
  UI.getMarketItems = function () { return (state.market.items || []).slice(); };
  UI.setMarketStatus = function (id, status) { return setMarketStatus(id, status); };
  UI.renderMarketStatus = function (id, status) { return setMarketStatus(id, status); };
  UI.renderMemory = function (data) { return renderMemory(data); };
  UI.openMemoryPage = openMemoryPage;
  UI.getMemory = function () {
    return {
      long_term: (state.memory.longTerm || []).slice(),
      project: {
        tech_stack: state.memory.project.tech_stack || '',
        conventions: state.memory.project.conventions || '',
        decisions: state.memory.project.decisions || ''
      },
      summaries: (state.memory.summaries || []).slice()
    };
  };
  UI.renderPluginSlots = function (slots) { return renderPluginSlots(slots); };
  UI.openPluginPanel = openPluginPanel;
  UI.closePluginPanel = closePluginPanel;
  UI.isPluginPanelOpen = function () { return state.pluginPanelOpen; };
  UI.getPluginSlots = function () { return (state.pluginSlots || []).slice(); };

  /* ARCH v2 P4：工作台 / 构建任务 / 图片消息 / 应用锁 */
  UI.toggleWorkbench = function (open) { return toggleWorkbench(open); };
  UI.setWorkbenchEnabled = function (on) { return setWorkbenchEnabled(on); };
  UI.isWorkbenchOpen = function () { return !!state.workbench.enabled; };
  UI.isWorkbenchActive = function () { return !!state.workbench.active; };
  UI.getWorkbenchState = getWorkbenchState;
  UI.setTerminalHeight = function (px) { return setTerminalHeight(px); };
  UI.getTerminalHeight = getTerminalHeight;
  UI.renderBuildTasks = function (tasks) { return renderBuildTasks(tasks); };
  UI.updateBuildTask = function (taskOrId, patch) { return updateBuildTask(taskOrId, patch); };
  UI.getBuildTasks = function () { return (state.buildTasks || []).slice(); };
  UI.openBuildPanel = openBuildPanel;
  UI.closeBuildPanel = closeBuildPanel;
  UI.isBuildPanelOpen = function () { return !!state.buildPanelOpen; };
  UI.setPendingImages = function (images) { return setPendingImages(images); };
  UI.addPendingImage = function (image) { return addPendingImage(image); };
  UI.getPendingImages = getPendingImages;
  UI.removePendingImage = function (index) { return removePendingImage(index); };
  UI.clearPendingImages = clearPendingImages;
  UI.openAttachmentSheet = openAttachmentSheet;
  UI.closeAttachmentSheet = closeAttachmentSheet;
  UI.openImageViewer = function (src) { openImageViewer(src); };
  UI.closeImageViewer = closeImageViewer;
  UI.setSecurityInfo = setSecurityInfo;
  UI.refreshSettingsStats = refreshSettingsStats;

  /* 批次 1 · v2.6.0：轨迹 / 成本 / 工具权限 / 斜杠命令 */
  UI.renderTrace = function (events) { return renderTrace(events); };
  UI.openTracePage = openTracePage;
  UI.searchTrace = searchTrace;
  UI.getTraceEvents = function () { return state.trace.events.slice(); };
  UI.renderCost = function (data) { return renderCost(data); };
  UI.openCostPage = openCostPage;
  UI.openCostPanel = openCostPage;
  UI.setCostAlert = setCostAlert;
  UI.getCostData = function () { return state.cost.data; };
  UI.renderToolPolicies = function (list) { return renderToolPolicies(list); };
  UI.openToolPolicyPage = openToolPolicyPage;
  UI.openToolPoliciesPage = openToolPolicyPage;
  UI.setToolPolicyMode = setToolPolicyMode;
  UI.openSlashMenu = openSlashMenu;
  UI.closeSlashMenu = closeSlashMenu;
  UI.isSlashMenuOpen = function () { return !!state.slash.open; };
  UI.setSlashCommands = setSlashCommands;
  UI.renderSlashCommands = setSlashCommands;
  UI.getSlashCommands = function () { return (state.slash.custom || slashCommandSource()).slice(); };
  UI.pickSlashCommand = pickSlashCommand;

  /* 批次 2 · v2.7.0：快照 / 安全 PIN / 加密密码 */
  UI.renderSnapshots = function (data) { return renderSnapshots(data); };
  UI.openSnapshotsPage = openSnapshotsPage;
  UI.openSnapshotPage = openSnapshotsPage;
  UI.renderSnapshotDiff = function (diff) { return renderSnapshotDiff(diff); };
  UI.renderSnapshotDiffs = function (id, changes) { return renderSnapshotDiffs(id, changes); };
  UI.getSnapshots = function () { return (state.snapshots.list || []).slice(); };
  UI.requirePin = requirePin;
  UI.openPinSetup = openPinSetup;
  UI.setPinEnabled = setPinEnabled;
  UI.requirePassword = requirePassword;
  UI.promptPassword = requirePassword;

  /* 批次 3 · v2.8.0：外观 / 引用 / 编辑 / 搜索 / 语言 */
  UI.applyAppearance = function (data) { return applyAppearance(data); };
  UI.applyTheme = applyTheme;
  UI.setFontScale = setFontScale;
  UI.applyWallpaper = applyWallpaper;
  UI.clearWallpaper = clearWallpaper;
  UI.applyGlassOptions = function (options) { return applyGlassOptions(options); };
  UI.getAppearance = getAppearance;
  UI.openAppearancePage = openAppearancePage;
  UI.setQuotedMessage = setQuotedMessage;
  UI.quoteMessage = quoteMessage;
  UI.cancelQuote = cancelQuote;
  UI.clearQuote = function () { return setQuotedMessage(null); };
  UI.openEditMessage = openEditMessage;
  UI.closeEditMessage = closeEditMessage;
  UI.exportMessageImage = exportMessageImage;
  UI.exportChatImage = exportChatImage;
  UI.searchInChat = searchInChat;
  UI.highlightMessage = highlightMessage;
  UI.renderMessageSearch = renderMessageSearch;
  UI.openChatSearch = openChatSearch;
  UI.closeChatSearch = closeChatSearch;
  UI.moveChatSearch = moveChatSearch;
  UI.applyLocale = applyLocale;
  UI.setLocale = setLocale;
  UI.getLocale = function () { return state.locale || 'zh'; };

  /* 批次 3 · v2.9.0：插件市场升级 */
  UI.renderMarketPage = function (data) { return renderMarketPage(data); };
  UI.openMarketDetail = openMarketDetail;
  UI.closeMarketDetail = closeMarketDetail;
  UI.renderInstallProgress = function (id, data) { return renderInstallProgress(id, data); };
  UI.setMarketSourceLabel = setMarketSourceLabel;
  UI.setMarketQuery = setMarketQuery;
  UI.setMarketCategory = setMarketCategory;
  UI.setMarketSort = setMarketSort;
  UI.openMarketUrlInstall = openMarketUrlInstall;
  UI.openMarketCodeInstall = openMarketCodeInstall;
  /* v3.0.0：Bot 集成 */
  UI.renderBots = function (list) { return renderBots(list); };
  UI.openBotsPage = openBotsPage;
  UI.openBotForm = openBotForm;
  UI.openBotDetail = openBotDetail;
  UI.closeBotDetail = closeBotDetail;
  UI.renderBotMessages = function (list) { return renderBotMessages(list); };
  UI.setBotStatus = setBotStatus;
  UI.appendBotMessage = appendBotMessage;
  UI.renderBotTargets = function (list) { return renderBotTargets(list); };
  UI.getBotTargets = function () {
    return state.bots.currentId ? (state.bots.targets[state.bots.currentId] || []).slice() : [];
  };
  UI.getBots = function () { return (state.bots.list || []).slice(); };
  UI.getBotState = function () {
    return {
      list: (state.bots.list || []).slice(),
      currentId: state.bots.currentId,
      messages: state.bots.currentId ? (state.bots.messages[state.bots.currentId] || []).slice() : []
    };
  };

  UI.getMarketState = function () {
    return {
      items: (state.market.items || []).slice(),
      source: state.market.source,
      query: state.market.query,
      category: state.market.category,
      sort: state.market.sort,
      loading: !!state.market.loading,
      error: state.market.error || ''
    };
  };

  /* 液态玻璃 / 毛玻璃 */
  UI.setGlassMode = function (mode) { return applyGlassMode(mode); };
  UI.getGlassMode = function () { return state.glassMode || 'frost'; };
  UI.detectGlassMode = detectGlassMode;

  UI.version = '3.1.0';
})();
