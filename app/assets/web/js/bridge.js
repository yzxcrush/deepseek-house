/*!
 * DeepSeek House — bridge.js
 * 原生 JsBridge（window.DSNative）的防御式封装 + 事件分发 + mock 模式。
 *
 * 原生注入：window.DSNative（Java addJavascriptInterface）
 * 原生事件：window.DSHost.onEvent(<json>) / window.DSHost.back()
 * 对外：window.Bridge
 *   无 DSNative（浏览器/Node 自测）时自动进入 mock 模式：Bridge.__isMock === true，
 *   内存 prefs / 模拟流式 chunk / validateKey 成功 / 内存插件存储。
 */
(function (global) {
  'use strict';

  var KNOWN_PREFS = ['apiKey', 'baseUrl', 'model', 'temperature', 'maxTokens', 'stream', 'theme', 'systemPrompt', 'backDepth'];

  function defaultPrefs() {
    return {
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      temperature: 1.0,
      maxTokens: 4096,
      stream: true,
      theme: 'dark',
      systemPrompt: '你是 DeepSeek House 助手，一个运行在安卓 WebView 中的 AI 聊天助手。请用简体中文回答（除非用户要求其他语言），回答准确、简洁、有条理，适当使用 Markdown 排版。',
      backDepth: 0
    };
  }

  function parseJSON(str, fallback) {
    if (str === null || str === undefined || str === '') return fallback;
    if (typeof str !== 'string') return str;
    try { return JSON.parse(str); } catch (e) { return fallback; }
  }

  function warn() {
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn.apply(console, ['[Bridge]'].concat(Array.prototype.slice.call(arguments)));
      }
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * 事件分发
   * ------------------------------------------------------------------ */

  var listeners = Object.create(null); // type -> [fn]

  function onEvent(type, fn) {
    if (typeof fn !== 'function' || !type) return function () { };
    var key = String(type);
    if (!listeners[key]) listeners[key] = [];
    listeners[key].push(fn);
    var removed = false;
    return function off() {
      if (removed) return;
      removed = true;
      var arr = listeners[key];
      if (!arr) return;
      var idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    };
  }

  function offEvent(type, fn) {
    var arr = listeners[String(type)];
    if (!arr) return;
    if (!fn) { delete listeners[String(type)]; return; }
    var idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  }

  function emit(type, data) {
    var arr = listeners[String(type)];
    if (!arr || !arr.length) return;
    var copy = arr.slice();
    for (var i = 0; i < copy.length; i++) {
      try { copy[i](data); } catch (e) { warn('listener error:', e && e.message); }
    }
  }

  /* ------------------------------------------------------------------ *
   * 原生可用性 & 底层调用
   * ------------------------------------------------------------------ */

  function nativeAvailable() {
    try {
      return typeof DSNative !== 'undefined' && DSNative !== null && typeof DSNative === 'object';
    } catch (e) {
      return false;
    }
  }

  var hasNative = nativeAvailable();

  function callNative(method, args, asJson) {
    if (!hasNative) return null;
    try {
      var fn = DSNative[method];
      if (typeof fn !== 'function') { warn('原生缺少方法 ' + method); return null; }
      var raw = fn.apply(DSNative, args || []);
      if (asJson) {
        if (raw === null || raw === undefined || raw === '') return null;
        if (typeof raw !== 'string') return raw;
        var parsed = parseJSON(raw, null);
        if (parsed === null) warn(method + ' 返回了非 JSON 字符串');
        return parsed;
      }
      return raw;
    } catch (e) {
      warn(method + ' 调用失败：' + (e && e.message ? e.message : e));
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * mock 存储
   * ------------------------------------------------------------------ */

  var mockPrefs = defaultPrefs();
  var mockClipboard = '';
  var mockBackDepth = 0;
  var mockPlugins = Object.create(null); // id -> {code, meta, enabled}
  var mockRequests = Object.create(null); // requestId -> {cancelled, timer}
  var mockFileWaiters = [];

  function mockPluginList() {
    return Object.keys(mockPlugins).map(function (id) {
      var item = mockPlugins[id];
      var meta = item.meta || {};
      return {
        id: id,
        name: meta.name || id,
        version: meta.version || '1.0.0',
        author: meta.author || 'mock',
        description: meta.description || '',
        enabled: item.enabled !== false,
        fileName: id + '.js'
      };
    });
  }

  function mockSetPlugin(id, code, meta) {
    mockPlugins[id] = { code: String(code || ''), meta: meta || {}, enabled: true };
  }

  function mockPluginReadSafe(id) {
    var item = mockPlugins[id];
    return item ? item.code : '';
  }

  function mockCopyPrefs() {
    var out = {};
    var keys = Object.keys(mockPrefs);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = mockPrefs[keys[i]];
    return out;
  }

  function emitLater(delay, type, data) {
    setTimeout(function () { emit(type, data); }, Math.max(0, Number(delay) || 0));
  }

  function chunkize(text, size) {
    var arr = [];
    var s = String(text || '');
    var step = size || 3;
    for (var i = 0; i < s.length; i += step) arr.push(s.slice(i, i + step));
    return arr;
  }

  /* mock 流式回复正文（含 Markdown / 代码块 / 表格 / reasoning 演示） */
  function mockReasoningText() {
    return '用户发来了一条新消息。当前没有检测到 Android 原生 DSNative，所以运行在 mock 模式：' +
      '我需要生成一段本地伪造的流式回复，用来演示推理折叠、流式渲染与 Markdown 排版。';
  }

  function mockAnswerText() {
    return '你好！我是 **DeepSeek House** 的 mock 流式回复 👋\n\n' +
      '当前没有检测到 Android 原生 `DSNative`，因此处于离线自测模式：\n\n' +
      '- 登录校验会直接成功（`validateKey`）\n' +
      '- 回复由本地逐段伪造，用于验证流式渲染与停止按钮\n' +
      '- 会话 / 设置 / 插件数据保存在内存中\n\n' +
      '```js\n// mock 模式下的事件流\nwindow.DSHost.onEvent({ type: "chunk", delta: "..." });\n```\n\n' +
      '> 发送 `/help` 可以查看可用命令；打开「插件」页可以体验工具调用。\n\n' +
      '| 能力 | 状态 |\n| --- | --- |\n| 流式输出 | ✅ |\n| 推理折叠 | ✅ |\n| Markdown 排版 | ✅ |\n\n' +
      '更多信息见 [DeepSeek 开放平台](https://platform.deepseek.com)。';
  }

  function mockStartChat(requestId, bodyArg) {
    var body = typeof bodyArg === 'string' ? parseJSON(bodyArg, {}) : (bodyArg || {});
    var req = { cancelled: false, timer: null };
    mockRequests[requestId] = req;
    var cfg = global.Bridge && global.Bridge.__mockConfig ? global.Bridge.__mockConfig : {};
    var delay = typeof cfg.chunkDelay === 'number' ? cfg.chunkDelay : 14;
    var reasoning = chunkize(mockReasoningText(), 4);
    var answer = chunkize(mockAnswerText(), 3);
    var steps = [];
    var i;
    for (i = 0; i < reasoning.length; i++) steps.push({ reasoning: reasoning[i], delta: '' });
    for (i = 0; i < answer.length; i++) steps.push({ reasoning: '', delta: answer[i] });
    var idx = 0;

    function finish() {
      delete mockRequests[requestId];
      var usage = {
        prompt_tokens: 36,
        completion_tokens: Math.max(1, Math.round(mockAnswerText().length / 2)),
        total_tokens: 36 + Math.max(1, Math.round(mockAnswerText().length / 2))
      };
      emit('done', {
        type: 'done',
        requestId: requestId,
        finishReason: 'stop',
        usage: usage,
        model: (body && body.model) || mockPrefs.model
      });
    }

    function next() {
      if (req.cancelled) { delete mockRequests[requestId]; return; }
      if (idx >= steps.length) { finish(); return; }
      var step = steps[idx++];
      emit('chunk', {
        type: 'chunk',
        requestId: requestId,
        delta: step.delta,
        reasoning: step.reasoning
      });
      req.timer = setTimeout(next, delay);
    }

    req.timer = setTimeout(next, Math.min(120, Math.max(0, delay)));
    return true;
  }

  function mockCancelRequest(requestId) {
    var req = mockRequests[requestId];
    if (!req) return;
    req.cancelled = true;
    if (req.timer) clearTimeout(req.timer);
    delete mockRequests[requestId];
  }

  var MOCK_SAMPLE_PLUGIN = [
    '// @id user.mock-sample',
    '// @name Mock 示例插件',
    '(function () {',
    '  if (!window.DSPlugins) return;',
    '  window.DSPlugins.register({',
    '    id: "user.mock-sample",',
    '    name: "Mock 示例插件",',
    '    version: "1.0.0",',
    '    author: "DeepSeek House (mock)",',
    '    description: "mock 模式下从文件导入的示例插件（随机骰子）。",',
    '    commands: [{',
    '      name: "roll",',
    '      description: "掷骰子，例如 /roll 6",',
    '      usage: "/roll 6",',
    '      run: async function (ctx, args) {',
    '        var n = parseInt(args, 10);',
    '        if (!(n > 1)) n = 6;',
    '        if (n > 1000) n = 1000;',
    '        return "🎲 掷出：" + (Math.floor(Math.random() * n) + 1);',
    '      }',
    '    }]',
    '  });',
    '})();'
  ].join('\n');

  /* ------------------------------------------------------------------ *
   * Bridge 对外 API
   * ------------------------------------------------------------------ */

  var Bridge = {
    __isMock: !hasNative,
    __native: hasNative,
    __mockConfig: { chunkDelay: 14, validateDelay: 180 },

    /* ---- 底层 / 事件 ---- */
    call: function (method) {
      var args = Array.prototype.slice.call(arguments, 1);
      return callNative(method, args, true);
    },
    onEvent: onEvent,
    offEvent: offEvent,
    emit: emit,

    /* ---- 同步信息 / prefs ---- */
    appInfo: function () {
      if (!hasNative) {
        return { versionName: '1.0.0', versionCode: '1', filesDir: '(mock)', sdkInt: 34 };
      }
      return callNative('appInfo', [], true) || { versionName: '1.0.0', versionCode: '1', filesDir: '', sdkInt: 0 };
    },

    prefs: function () {
      if (!hasNative) return mockCopyPrefs();
      var raw = callNative('getPrefs', [], false);
      var parsed = parseJSON(raw, null);
      if (!parsed || typeof parsed !== 'object' || parsed.error) {
        var fallback = defaultPrefs();
        fallback.apiKey = '';
        return fallback;
      }
      var out = {};
      for (var i = 0; i < KNOWN_PREFS.length; i++) {
        var k = KNOWN_PREFS[i];
        if (parsed[k] !== undefined && parsed[k] !== null) out[k] = parsed[k];
      }
      if (out.apiKey === undefined) out.apiKey = '';
      return out;
    },

    setPrefs: function (prefs) {
      var patch = typeof prefs === 'string' ? parseJSON(prefs, {}) : (prefs || {});
      if (!patch || typeof patch !== 'object') return false;
      var clean = {};
      for (var i = 0; i < KNOWN_PREFS.length; i++) {
        var k = KNOWN_PREFS[i];
        if (patch[k] !== undefined) clean[k] = patch[k];
      }
      if (!hasNative) {
        var keys = Object.keys(clean);
        for (var j = 0; j < keys.length; j++) mockPrefs[keys[j]] = clean[keys[j]];
        return true;
      }
      try {
        DSNative.setPrefs(JSON.stringify(clean));
        return true;
      } catch (e) {
        warn('setPrefs 失败：' + (e && e.message));
        return false;
      }
    },
    getPrefs: function () { return Bridge.prefs(); },

    /* ---- 异步：聊天 ---- */
    startChat: function (requestId, body) {
      if (!requestId) return false;
      var bodyStr = typeof body === 'string' ? body : JSON.stringify(body || {});
      if (!hasNative) return mockStartChat(requestId, bodyStr);
      try {
        var fn = DSNative.startChat;
        if (typeof fn !== 'function') { warn('原生缺少 startChat'); return false; }
        fn.call(DSNative, requestId, bodyStr);
        return true;
      } catch (e) {
        warn('startChat 失败：' + (e && e.message));
        return false;
      }
    },

    validateKey: function (requestId) {
      if (!hasNative) {
        var cfg = Bridge.__mockConfig || {};
        var ok = mockPrefs.apiKey ? !/^invalid/i.test(String(mockPrefs.apiKey)) : true;
        setTimeout(function () {
          if (ok) {
            emit('validated', {
              type: 'validated',
              requestId: requestId,
              ok: true,
              models: ['deepseek-chat', 'deepseek-reasoner']
            });
          } else {
            emit('error', {
              type: 'error',
              requestId: requestId,
              message: 'API Key 无效（mock 校验失败）',
              httpStatus: 401
            });
          }
        }, typeof cfg.validateDelay === 'number' ? cfg.validateDelay : 180);
        return true;
      }
      try {
        if (typeof DSNative.validateKey !== 'function') { warn('原生缺少 validateKey'); return false; }
        DSNative.validateKey(requestId);
        return true;
      } catch (e) {
        warn('validateKey 失败：' + (e && e.message));
        return false;
      }
    },

    httpFetch: function (requestId, req) {
      var reqStr = typeof req === 'string' ? req : JSON.stringify(req || {});
      if (!hasNative) {
        var opts = parseJSON(reqStr, {}) || {};
        function reply(status, body, error) {
          emit('http', { type: 'http', requestId: requestId, status: status, body: body, error: error || null });
        }
        if (typeof fetch !== 'function' || !opts.url) {
          setTimeout(function () { reply(0, '', 'mock 环境不支持网络请求'); }, 0);
          return true;
        }
        try {
          fetch(opts.url, {
            method: opts.method || 'GET',
            headers: opts.headers || {},
            body: opts.body
          }).then(function (res) {
            return res.text().then(function (text) {
              reply(res.status, text, res.status >= 200 && res.status < 300 ? null : ('HTTP ' + res.status));
            });
          }).catch(function (err) {
            reply(0, '', String((err && err.message) || err));
          });
        } catch (e2) {
          reply(0, '', String((e2 && e2.message) || e2));
        }
        return true;
      }
      try {
        if (typeof DSNative.httpFetch !== 'function') { warn('原生缺少 httpFetch'); return false; }
        DSNative.httpFetch(requestId, reqStr);
        return true;
      } catch (e) {
        warn('httpFetch 失败：' + (e && e.message));
        return false;
      }
    },

    cancelRequest: function (requestId) {
      if (!hasNative) { mockCancelRequest(requestId); return true; }
      try {
        if (typeof DSNative.cancelRequest === 'function') DSNative.cancelRequest(String(requestId));
        return true;
      } catch (e) { warn('cancelRequest 失败：' + (e && e.message)); return false; }
    },

    cancelAllRequests: function () {
      if (!hasNative) {
        Object.keys(mockRequests).forEach(function (id) { mockCancelRequest(id); });
        return true;
      }
      try {
        if (typeof DSNative.cancelAllRequests === 'function') DSNative.cancelAllRequests();
        return true;
      } catch (e) { warn('cancelAllRequests 失败：' + (e && e.message)); return false; }
    },

    /* ---- 插件存储 ---- */
    plugins: function () {
      if (!hasNative) return mockPluginList();
      var raw = callNative('pluginsList', [], false);
      var parsed = parseJSON(raw, null);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (p) { return !!p; }).map(function (p) {
        return {
          id: p.id || '',
          name: p.name || p.id || '未命名插件',
          version: p.version || '1.0.0',
          author: p.author || '',
          description: p.description || '',
          enabled: p.enabled !== false,
          fileName: p.fileName || ''
        };
      });
    },

    pluginRead: function (id) {
      if (!hasNative) return mockPluginReadSafe(id);
      try {
        if (typeof DSNative.pluginRead !== 'function') return '';
        var raw = DSNative.pluginRead(String(id));
        if (raw === null || raw === undefined) return '';
        var str = String(raw);
        if (str === '') return '';
        var trimmed = str.replace(/^\s+|\s+$/g, '');
        if (trimmed.charAt(0) === '{' && trimmed.indexOf('"error"') !== -1) {
          var parsed = parseJSON(trimmed, null);
          if (parsed && parsed.error) return '';
        }
        return str;
      } catch (e) {
        warn('pluginRead 失败：' + (e && e.message));
        return '';
      }
    },

    pluginWrite: function (id, code, metaJson) {
      var metaStr = typeof metaJson === 'string' ? metaJson : JSON.stringify(metaJson || {});
      if (!hasNative) {
        mockSetPlugin(String(id), code, parseJSON(metaStr, {}) || {});
        return true;
      }
      try {
        if (typeof DSNative.pluginWrite !== 'function') return false;
        DSNative.pluginWrite(String(id), String(code || ''), metaStr);
        return true;
      } catch (e) {
        warn('pluginWrite 失败：' + (e && e.message));
        return false;
      }
    },

    pluginDelete: function (id) {
      if (!hasNative) { delete mockPlugins[String(id)]; return true; }
      try {
        if (typeof DSNative.pluginDelete === 'function') DSNative.pluginDelete(String(id));
        return true;
      } catch (e) { warn('pluginDelete 失败：' + (e && e.message)); return false; }
    },

    pluginSetEnabled: function (id, enabled) {
      if (!hasNative) {
        var item = mockPlugins[String(id)];
        if (item) item.enabled = !!enabled;
        return true;
      }
      try {
        if (typeof DSNative.pluginSetEnabled === 'function') DSNative.pluginSetEnabled(String(id), !!enabled);
        return true;
      } catch (e) { warn('pluginSetEnabled 失败：' + (e && e.message)); return false; }
    },

    importPluginFile: function () {
      return new Promise(function (resolve) {
        var done = false;
        function finish(evt) {
          if (done) return;
          done = true;
          resolve(evt || null);
        }
        var timer = setTimeout(function () {
          var idx = mockFileWaiters.indexOf(finish);
          if (idx >= 0) mockFileWaiters.splice(idx, 1);
          finish(null);
        }, 120000);
        var waiter = function (evt) {
          clearTimeout(timer);
          var idx = mockFileWaiters.indexOf(waiter);
          if (idx >= 0) mockFileWaiters.splice(idx, 1);
          finish(evt);
        };
        mockFileWaiters.push(waiter);
        if (!hasNative) {
          setTimeout(function () {
            emit('plugin-file', {
              type: 'plugin-file',
              id: 'user.mock-sample',
              fileName: 'mock-sample.js',
              content: MOCK_SAMPLE_PLUGIN
            });
          }, 150);
          return;
        }
        try {
          if (typeof DSNative.importPluginFile !== 'function') {
            clearTimeout(timer);
            finish(null);
            return;
          }
          DSNative.importPluginFile();
        } catch (e) {
          warn('importPluginFile 失败：' + (e && e.message));
          clearTimeout(timer);
          finish(null);
        }
      });
    },

    saveTextFile: function (suggestedName, content) {
      if (!hasNative) {
        var name = String(suggestedName || 'deepseek-house.md');
        try {
          if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof document !== 'undefined' && document.createElement) {
            var blob = new Blob([String(content || '')], { type: 'text/markdown;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = name;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () {
              try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
              if (a.parentNode) a.parentNode.removeChild(a);
            }, 1000);
          }
        } catch (e2) { warn('mock 下载失败：' + (e2 && e2.message)); }
        emitLater(60, 'saved', { type: 'saved', ok: true, name: name });
        return true;
      }
      try {
        if (typeof DSNative.saveTextFile !== 'function') return false;
        DSNative.saveTextFile(String(suggestedName || 'deepseek-house.md'), String(content || ''));
        return true;
      } catch (e) {
        warn('saveTextFile 失败：' + (e && e.message));
        return false;
      }
    },

    /* ---- 剪贴板 / UI / 系统 ---- */
    getClipboard: function () {
      if (!hasNative) return mockClipboard;
      try {
        if (typeof DSNative.getClipboard !== 'function') return '';
        var raw = DSNative.getClipboard();
        return raw === null || raw === undefined ? '' : String(raw);
      } catch (e) { warn('getClipboard 失败：' + (e && e.message)); return ''; }
    },

    setClipboard: function (text) {
      var value = String(text === null || text === undefined ? '' : text);
      if (!hasNative) { mockClipboard = value; return true; }
      try {
        if (typeof DSNative.setClipboard === 'function') DSNative.setClipboard(value);
        return true;
      } catch (e) { warn('setClipboard 失败：' + (e && e.message)); return false; }
    },

    toast: function (msg) {
      var text = String(msg === null || msg === undefined ? '' : msg);
      if (!hasNative) {
        try {
          if (global.UI && typeof global.UI.toast === 'function') { global.UI.toast(text); return true; }
        } catch (e) { /* ignore */ }
        try { console.log('[toast] ' + text); } catch (e2) { /* ignore */ }
        return true;
      }
      try {
        if (typeof DSNative.toast === 'function') DSNative.toast(text);
        return true;
      } catch (e) { return false; }
    },

    openUrl: function (url) {
      var u = String(url === null || url === undefined ? '' : url).replace(/^\s+|\s+$/g, '');
      if (!/^(https?:\/\/|mailto:)/i.test(u)) { warn('openUrl 拒绝非 http(s)/mailto 链接'); return false; }
      if (!hasNative) {
        try {
          if (typeof global.open === 'function') { global.open(u, '_blank'); return true; }
        } catch (e) { /* ignore */ }
        return true;
      }
      try {
        if (typeof DSNative.openUrl === 'function') DSNative.openUrl(u);
        return true;
      } catch (e) { warn('openUrl 失败：' + (e && e.message)); return false; }
    },

    setBackDepth: function (depth) {
      var n = Number(depth);
      if (isNaN(n) || n < 0) n = 0;
      n = Math.floor(n);
      if (!hasNative) { mockBackDepth = n; return n; }
      try {
        if (typeof DSNative.setBackDepth === 'function') DSNative.setBackDepth(n);
      } catch (e) { warn('setBackDepth 失败：' + (e && e.message)); }
      return n;
    },

    getBackDepth: function () {
      if (!hasNative) return mockBackDepth;
      var v = callNative('getBackDepth', [], true);
      return typeof v === 'number' ? v : 0;
    },

    setStatusBar: function (colorHex, lightIcons) {
      if (!hasNative) return true;
      try {
        if (typeof DSNative.setStatusBar === 'function') DSNative.setStatusBar(String(colorHex || '#17212B'), !!lightIcons);
        return true;
      } catch (e) { return false; }
    },

    finishApp: function () {
      if (!hasNative) {
        try {
          if (global.UI && typeof global.UI.toast === 'function') global.UI.toast('（mock 模式）已模拟退出');
        } catch (e) { /* ignore */ }
        return true;
      }
      try {
        if (typeof DSNative.finishApp === 'function') DSNative.finishApp();
        return true;
      } catch (e) { return false; }
    }
  };

  Bridge.clipboard = {
    get: function () { return Bridge.getClipboard(); },
    set: function (text) { return Bridge.setClipboard(text); }
  };

  /* ------------------------------------------------------------------ *
   * window.DSHost —— 原生事件入口
   * ------------------------------------------------------------------ */

  var lastBackAt = 0;

  function dispatchBack() {
    var now = Date.now();
    if (now - lastBackAt < 250) return;
    lastBackAt = now;
    emit('back', { type: 'back' });
  }

  global.DSHost = {
    onEvent: function (payload) {
      var evt = payload;
      try {
        if (typeof payload === 'string') evt = JSON.parse(payload);
      } catch (e) {
        warn('DSHost.onEvent 收到非法 JSON');
        return;
      }
      if (!evt || !evt.type) return;
      var type = String(evt.type);
      if (type === 'back') { dispatchBack(); return; }
      if (type === 'plugin-file') {
        emit(type, evt);
        var waiters = mockFileWaiters.slice();
        mockFileWaiters.length = 0;
        for (var i = 0; i < waiters.length; i++) {
          try { waiters[i](evt); } catch (e2) { /* ignore */ }
        }
        return;
      }
      emit(type, evt);
    },
    back: function () {
      dispatchBack();
    }
  };

  global.Bridge = Bridge;

  if (!hasNative) {
    warn('未检测到 DSNative，Bridge 进入 mock 模式（Bridge.__isMock = true）');
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
