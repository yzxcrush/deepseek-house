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
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>',
    puzzle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4.8a2 2 0 0 1 4 0V6h3.2c.4 0 .8.4.8.8V10h1.2a2 2 0 0 1 0 4H17v3.2c0 .4-.4.8-.8.8H13v1.2a2 2 0 0 1-4 0V18H5.8a.8.8 0 0 1-.8-.8V14h1.2a2 2 0 0 1 0-4H5V6.8c0-.4.4-.8.8-.8H9V4.8Z"></path></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>'
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
    pressFired: false
  };

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
    else if (state.screen === 'settings' || state.screen === 'plugins') base = 2;
    else return; /* login 由 app.js 决定 */
    var overlay = state.drawerOpen || state.menuOpen || state.modelPicker.open ||
      isModalOpen(r('install-modal')) || isModalOpen(r('confirm-modal')) || isModalOpen(r('rename-modal'));
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
    ['install-modal', 'confirm-modal', 'rename-modal'].forEach(function (id) {
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
    plugins: 'screen-plugins'
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
    closeAllModals();
    closeModelPickerPanel(true);
    if (name !== 'chat') closeEmojiPanel();
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

  function switchChatTab(tab) {
    var next = tab === 'unread' ? 'unread' : 'all';
    if (state.chatTab === next) return;
    state.chatTab = next;
    var tabs = document.querySelectorAll('#chat-tabs [data-tab]');
    Array.prototype.forEach.call(tabs, function (node) {
      var active = node.getAttribute('data-tab') === next;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderChatListImpl(state.chats, state.activeChatId);
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
    items.forEach(function (chat) { unreadTotal += Math.max(0, parseInt(chat.unread, 10) || 0); });
    setNavBadge(unreadTotal);
    var visible = state.chatTab === 'unread'
      ? items.filter(function (chat) { return (parseInt(chat.unread, 10) || 0) > 0; })
      : items;

    [homeList, drawerList].forEach(function (list) {
      if (!list) return;
      list.textContent = '';
      visible.forEach(function (chat) { list.appendChild(buildChatItem(chat)); });
    });

    /* 标签页未读计数（Telegram 文件夹式） */
    var unreadTab = document.querySelector('#chat-tabs [data-tab="unread"]');
    if (unreadTab) {
      unreadTab.textContent = unreadTotal > 0 ? '未读 ' + (unreadTotal > 99 ? '99+' : unreadTotal) : '未读';
      unreadTab.classList.toggle('has-unread', unreadTotal > 0);
    }

    var homeEmpty = r('chats-empty');
    if (homeEmpty) {
      homeEmpty.hidden = visible.length > 0;
      if (!visible.length) {
        var title = homeEmpty.querySelector('.chatlist-empty-title');
        var sub = homeEmpty.querySelector('.chatlist-empty-sub');
        var unreadMode = state.chatTab === 'unread';
        if (title) title.textContent = query ? '没有找到会话' : (unreadMode ? '没有未读消息' : '还没有聊天');
        if (sub) sub.textContent = query ? '换个关键词试试' : (unreadMode ? '所有消息都读过了' : '点右下角按钮，开始一段新对话');
      }
    }

    var empty = r('chat-list-empty');
    if (empty) {
      empty.hidden = visible.length > 0;
      empty.textContent = visible.length ? '' : (query ? '没有找到匹配的会话' : '暂无会话');
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
      var plain = el('div', 'msg-content');
      plain.textContent = msg.content == null ? '' : String(msg.content);
      bubble.appendChild(plain);
      refs.content = plain;
      refs.textMode = true;
    } else if (role === 'tool') {
      var toolChips = el('div', 'tool-chips');
      toolChips.hidden = true;
      bubble.appendChild(toolChips);
      refs.tools = toolChips;
      refs.toolRole = true;

      var toolContent = el('div', 'msg-content msg-content--tool');
      toolContent.textContent = msg.content == null ? '' : String(msg.content);
      bubble.appendChild(toolContent);
      refs.content = toolContent;
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

      var error = el('div', 'msg-error');
      error.hidden = true;

      bubble.appendChild(details);
      bubble.appendChild(chips);
      bubble.appendChild(content);
      bubble.appendChild(error);

      refs.reasoning = details;
      refs.reasoningLabel = label;
      refs.reasoningBody = reasoningBody;
      refs.userToggled = false;
      refs.tools = chips;
      refs.content = content;
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

  function applyMessageFields(msg, refs) {
    var role = refs.role || msg.role || 'assistant';
    var id = String(msg.id);

    /* 正文 */
    if (refs.textMode) {
      var text = msg.content == null ? '' : String(msg.content);
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
    if (!text) return;
    var isCommand = text.charAt(0) === '/';
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
    if (!invoke('onBack')) showScreenImpl('chat');
  }

  function handleBack() {
    if (state.menuOpen) { closeMenu(); return true; }
    if (isModalOpen(r('install-modal'))) { closeModal(r('install-modal')); return true; }
    if (isModalOpen(r('rename-modal'))) { resolveRename(null); return true; }
    if (isModalOpen(r('confirm-modal'))) { resolveConfirm(false); return true; }
    if (state.modelPicker.open) { closeModelPickerPanel(true); return true; }
    if (state.drawerOpen) { closeDrawer(); return true; }
    if (state.emojiOpen) { closeEmojiPanel(); return true; }
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
        if (state.screen === 'chats') { toggleChatSearch(true); } else { openDrawer(); focusSearch(); }
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
        if (data && data.content != null) copyText(data.content);
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
    var pluginId = target.getAttribute('data-plugin-toggle');
    if (pluginId) {
      invoke('onPluginToggle', pluginId, !!target.checked);
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
    if (target.id === 'model-picker-custom-input') {
      if (key === 'Enter') {
        event.preventDefault();
        addCustomModel();
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
    });

    bindModalBackdrop(r('install-modal'), function () { closeModal(r('install-modal')); });
    bindModalBackdrop(r('confirm-modal'), function () { resolveConfirm(false); });
    bindModalBackdrop(r('rename-modal'), function () { resolveRename(null); });
    bindModelPickerEvents();
  }

  function cacheRefs() {
    var ids = [
      'app', 'screens',
      'screen-login', 'screen-chats', 'screen-chat', 'screen-settings', 'screen-plugins',
      'chats-list', 'chats-empty', 'chats-title', 'chat-search-wrap', 'chat-search-input', 'chat-search-clear',
      'share-list', 'share-empty', 'profile-status', 'nav-badge', 'nav-chats', 'nav-share', 'nav-profile', 'tip-card',
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
      'longpress', 'toasts', 'overlay', 'drawer'
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
    var empty = r('share-empty');
    if (empty) empty.hidden = items.length > 0;
  }

  function renderProfile(info) {
    info = info || {};
    var status = r('profile-status');
    if (status) status.textContent = info.status == null ? '' : String(info.status);
  }

  function setTipVisible(visible) {
    var tip = r('tip-card');
    if (tip) tip.hidden = !visible;
  }

  /* ------------------------------------------------------------------ *
   * 公开 API（SPEC §4.2 全部实现）
   * ------------------------------------------------------------------ */
  UI.init = function (callbacks) {
    if (state.initialized) return;
    state.cb = callbacks && typeof callbacks === 'object' ? callbacks : {};
    cacheRefs();
    state.initialized = true;
    bindEvents();
    showScreenImpl('chats');
    buildEmojiPanel();
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

  UI.renderSettings = function (prefs, models) {
    state.prefs = prefs || {};
    state.models = normalizeModels(models);
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

  UI.version = '1.0.9';
})();
