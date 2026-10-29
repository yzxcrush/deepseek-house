/*!
 * DeepSeek House — api.js
 * 聊天请求组装 + 原生事件路由（chunk/done/error/validated/http）+ 取消。
 *
 * 对外：window.Api
 *   Api.send({chat, messages, tools, prefs, onChunk, onDone, onError}) -> requestId
 *   Api.cancel(requestId) / Api.cancelAll()
 *   Api.verifyKey(opts?) -> Promise<{ok, models?, message?, httpStatus?}>
 *   Api.fetchUrl(url, opts?) -> Promise<{ok, status, body, error, json(), text()}>
 *   Api.regenerate(opts)  // 同 send（app 决定历史）
 *   Api.buildBody(opts) / Api.toApiMessage(msg)（调试/测试）
 */
(function (global) {
  'use strict';

  var Bridge = global.Bridge;
  var pending = Object.create(null); // requestId -> request entry
  var verifying = Object.create(null); // requestId -> resolve fn
  var httpPending = Object.create(null); // requestId -> resolve fn
  var bound = false;
  var seq = 0;

  function warn() {
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn.apply(console, ['[Api]'].concat(Array.prototype.slice.call(arguments)));
      }
    } catch (e) { /* ignore */ }
  }

  function ensureBridge() {
    if (Bridge && typeof Bridge.startChat === 'function') return true;
    warn('Bridge 不可用');
    return false;
  }

  function genRequestId(prefix) {
    seq++;
    return (prefix || 'req') + '_' + Date.now().toString(36) + '_' + seq + '_' +
      Math.random().toString(36).slice(2, 7);
  }

  function now() { return Date.now(); }

  function normalizeText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (typeof value === 'object') {
      return normalizeText(value.content !== undefined ? value.content : (value.text !== undefined ? value.text : ''));
    }
    return '';
  }

  function getPrefs() {
    try { return (Bridge && typeof Bridge.prefs === 'function' ? Bridge.prefs() : null) || {}; }
    catch (e) { return {}; }
  }

  /* ------------------------------------------------------------------ *
   * body 组装
   * ------------------------------------------------------------------ */

  function toApiMessage(msg) {
    if (!msg || !msg.role) return null;
    if (msg.role === 'note') return null;

    if (msg.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: msg.toolCallId || ('call_' + (msg.id || 'unknown')),
        content: msg.content === null || msg.content === undefined ? '' : String(msg.content)
      };
    }

    var out = {
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content === null || msg.content === undefined ? '' : String(msg.content)
    };

    if (out.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length) {
      out.tool_calls = msg.toolCalls.map(function (tc) {
        var fn = (tc && tc.function) || {};
        var name = tc && (tc.name || fn.name) ? (tc.name || fn.name) : 'unknown';
        var args = tc && tc.arguments !== undefined ? tc.arguments : fn.arguments;
        if (typeof args !== 'string') {
          try { args = JSON.stringify(args === undefined ? {} : args); } catch (e) { args = '{}'; }
        }
        return {
          id: (tc && tc.id) || ('call_' + (msg.id || 'unknown')),
          type: 'function',
          function: { name: String(name), arguments: args || '{}' }
        };
      });
    }

    // 空的失败/流式占位消息不进入请求历史
    if (out.role === 'assistant' && !out.content && !out.tool_calls && (msg.error || msg.streaming)) return null;
    if (!out.content && !out.tool_calls && out.role === 'assistant') return null;
    if (!out.content && out.role === 'user') return null;
    return out;
  }

  function buildMessages(messages, prefs) {
    var out = [];
    var systemPrompt = prefs && prefs.systemPrompt ? String(prefs.systemPrompt) : '';
    if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
    var list = Array.isArray(messages) ? messages : [];
    for (var i = 0; i < list.length; i++) {
      var converted = toApiMessage(list[i]);
      if (converted) out.push(converted);
    }
    return out;
  }

  function buildBody(opts) {
    opts = opts || {};
    var prefs = opts.prefs || getPrefs();
    var chat = opts.chat || {};
    var tools = Array.isArray(opts.tools) ? opts.tools : [];
    var body = {
      model: chat.model || prefs.model || 'deepseek-chat',
      messages: buildMessages(opts.messages, prefs),
      temperature: typeof prefs.temperature === 'number' ? prefs.temperature : 1.0,
      maxTokens: prefs.maxTokens || 4096,
      stream: true,
      systemPrompt: prefs.systemPrompt || ''
    };
    if (tools.length) body.tools = tools;
    return body;
  }

  /* ------------------------------------------------------------------ *
   * 工具调用增量合并
   * ------------------------------------------------------------------ */

  function cloneToolCalls(list) {
    return (list || []).filter(function (x) { return !!x; }).map(function (tc) {
      return {
        id: tc.id || '',
        type: tc.type || 'function',
        name: tc.name || '',
        arguments: tc.arguments || ''
      };
    });
  }

  function mergeToolDeltas(acc, deltas) {
    if (!Array.isArray(deltas) || !deltas.length) return;
    for (var i = 0; i < deltas.length; i++) {
      var d = deltas[i];
      if (!d || typeof d !== 'object') continue;
      var idx = typeof d.index === 'number' ? d.index : parseInt(d.index, 10);
      if (isNaN(idx) || idx < 0) idx = i;
      var cur = acc[idx];
      if (!cur) {
        cur = { id: '', type: 'function', name: '', arguments: '' };
        acc[idx] = cur;
      }
      if (d.id && !cur.id) cur.id = String(d.id);
      if (d.type) cur.type = String(d.type);
      var fn = d.function || {};
      var namePart = d.name !== undefined ? d.name : fn.name;
      var argPart = d.arguments !== undefined ? d.arguments : fn.arguments;
      if (namePart) cur.name += String(namePart);
      if (argPart !== undefined && argPart !== null) {
        if (typeof argPart === 'string') cur.arguments += argPart;
        else {
          try { cur.arguments += JSON.stringify(argPart); } catch (e) { /* ignore */ }
        }
      }
    }
    // 压缩稀疏数组
    var compact = [];
    for (var k = 0; k < acc.length; k++) {
      if (acc[k]) compact.push(acc[k]);
    }
    acc.length = 0;
    for (var c = 0; c < compact.length; c++) acc.push(compact[c]);
  }

  function fillToolIds(acc, requestId) {
    for (var i = 0; i < acc.length; i++) {
      if (acc[i] && !acc[i].id) acc[i].id = 'call_' + requestId + '_' + i;
      if (acc[i] && !acc[i].name) acc[i].name = 'unknown';
    }
  }

  /* ------------------------------------------------------------------ *
   * 事件路由
   * ------------------------------------------------------------------ */

  function ensureBound() {
    if (bound) return;
    if (!Bridge || typeof Bridge.onEvent !== 'function') return;
    bound = true;
    Bridge.onEvent('chunk', handleChunk);
    Bridge.onEvent('done', handleDone);
    Bridge.onEvent('error', handleError);
    Bridge.onEvent('validated', handleValidated);
    Bridge.onEvent('http', handleHttp);
  }

  function handleChunk(evt) {
    if (!evt || !evt.requestId) return;
    var entry = pending[evt.requestId];
    if (!entry || entry.done) return;
    var delta = normalizeText(evt.delta);
    var reasoning = normalizeText(evt.reasoning);
    var hasTools = Array.isArray(evt.toolCalls) && evt.toolCalls.length > 0;
    if (hasTools) {
      mergeToolDeltas(entry.toolCalls, evt.toolCalls);
      fillToolIds(entry.toolCalls, evt.requestId);
    }
    if (!delta && !reasoning && !hasTools) return;
    entry.gotChunk = true;
    try {
      if (entry.onChunk) {
        entry.onChunk({
          requestId: evt.requestId,
          delta: delta,
          reasoning: reasoning,
          toolCalls: entry.toolCalls.length ? cloneToolCalls(entry.toolCalls) : null
        });
      }
    } catch (e) {
      warn('onChunk 回调异常：' + (e && e.message));
    }
  }

  function handleDone(evt) {
    if (!evt || !evt.requestId) return;
    var entry = pending[evt.requestId];
    if (!entry || entry.done) return;
    if (!entry.gotChunk) {
      // 兜底：非流式实现可能把整段内容放在 done 里
      var full = normalizeText(evt.content !== undefined ? evt.content : evt.delta);
      if (full) {
        try {
          if (entry.onChunk) entry.onChunk({ requestId: evt.requestId, delta: full, reasoning: '' });
        } catch (e) { /* ignore */ }
      }
    }
    entry.done = true;
    delete pending[evt.requestId];
    var toolCalls = cloneToolCalls(entry.toolCalls);
    try {
      if (entry.onDone) {
        entry.onDone({
          requestId: evt.requestId,
          finishReason: evt.finishReason || 'stop',
          usage: evt.usage || null,
          toolCalls: toolCalls,
          model: evt.model || null
        });
      }
    } catch (e2) {
      warn('onDone 回调异常：' + (e2 && e2.message));
    }
  }

  function handleError(evt) {
    if (!evt) return;
    var requestId = evt.requestId || '';

    var entry = pending[requestId];
    if (entry) {
      if (entry.done) return;
      entry.done = true;
      delete pending[requestId];
      try {
        if (entry.onError) {
          entry.onError({
            requestId: requestId,
            message: evt.message || evt.error || '请求失败',
            httpStatus: Number(evt.httpStatus || evt.status || 0) || 0
          });
        }
      } catch (e) {
        warn('onError 回调异常：' + (e && e.message));
      }
      return;
    }

    var verifyCb = verifying[requestId];
    if (verifyCb) {
      delete verifying[requestId];
      verifyCb({
        ok: false,
        message: evt.message || evt.error || '验证失败',
        httpStatus: Number(evt.httpStatus || evt.status || 0) || 0
      });
      return;
    }

    var httpCb = httpPending[requestId];
    if (httpCb) {
      delete httpPending[requestId];
      httpCb({
        ok: false,
        status: Number(evt.httpStatus || evt.status || 0) || 0,
        body: '',
        error: evt.message || evt.error || '网络请求失败'
      });
    }
  }

  function handleValidated(evt) {
    if (!evt || !evt.requestId) return;
    var cb = verifying[evt.requestId];
    if (!cb) return;
    delete verifying[evt.requestId];
    cb({
      ok: !!evt.ok,
      models: Array.isArray(evt.models) ? evt.models : [],
      message: evt.ok ? '' : (evt.message || evt.error || 'API Key 无效'),
      httpStatus: evt.ok ? 200 : (Number(evt.httpStatus || evt.status || 0) || 0)
    });
  }

  function handleHttp(evt) {
    if (!evt || !evt.requestId) return;
    var cb = httpPending[evt.requestId];
    if (!cb) return;
    delete httpPending[evt.requestId];
    var status = Number(evt.status) || 0;
    var body = evt.body === null || evt.body === undefined ? '' : String(evt.body);
    var error = evt.error || (status >= 200 && status < 300 ? null : ('HTTP ' + status));
    var result = {
      ok: !error && status >= 200 && status < 300,
      status: status,
      body: body,
      error: error || null
    };
    result.text = function () { return body; };
    result.json = function () {
      try { return JSON.parse(body); } catch (e) { return null; }
    };
    cb(result);
  }

  /* ------------------------------------------------------------------ *
   * 对外 API
   * ------------------------------------------------------------------ */

  function send(opts) {
    opts = opts || {};
    if (!ensureBridge()) {
      var msg = '原生 Bridge 不可用';
      if (opts.onError) {
        try { opts.onError({ requestId: '', message: msg, httpStatus: 0 }); } catch (e) { /* ignore */ }
      }
      return '';
    }
    ensureBound();
    var requestId = opts.requestId || genRequestId('req');
    if (pending[requestId]) {
      // 防止同一 requestId 重复注册
      try { delete pending[requestId]; } catch (e) { /* ignore */ }
    }
    pending[requestId] = {
      onChunk: opts.onChunk,
      onDone: opts.onDone,
      onError: opts.onError,
      toolCalls: [],
      done: false,
      gotChunk: false,
      startedAt: now()
    };
    var body = buildBody(opts);
    var ok = false;
    try {
      ok = Bridge.startChat(requestId, JSON.stringify(body));
    } catch (e) {
      warn('startChat 异常：' + (e && e.message));
      ok = false;
    }
    if (ok === false) {
      delete pending[requestId];
      if (opts.onError) {
        try { opts.onError({ requestId: requestId, message: '无法发起请求', httpStatus: 0 }); } catch (e2) { /* ignore */ }
      }
    }
    return requestId;
  }

  function cancel(requestId) {
    if (!requestId) return false;
    var existed = !!pending[requestId];
    delete pending[requestId];
    try {
      if (Bridge && typeof Bridge.cancelRequest === 'function') Bridge.cancelRequest(requestId);
    } catch (e) {
      warn('cancel 失败：' + (e && e.message));
    }
    return existed;
  }

  function cancelAll() {
    var ids = Object.keys(pending);
    for (var i = 0; i < ids.length; i++) delete pending[ids[i]];
    try {
      if (Bridge && typeof Bridge.cancelAllRequests === 'function') Bridge.cancelAllRequests();
    } catch (e) {
      warn('cancelAll 失败：' + (e && e.message));
    }
    return ids.length;
  }

  function verifyKey(opts) {
    opts = opts || {};
    if (!ensureBridge()) {
      return Promise.resolve({ ok: false, message: '原生 Bridge 不可用', httpStatus: 0 });
    }
    ensureBound();
    return new Promise(function (resolve) {
      var requestId = genRequestId('verify');
      var finished = false;
      var timeout = typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : 20000;
      var timer = setTimeout(function () {
        if (finished) return;
        finished = true;
        delete verifying[requestId];
        resolve({ ok: false, message: '验证超时，请检查网络或 Base URL', httpStatus: 0, timeout: true });
      }, timeout);
      verifying[requestId] = function (result) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(result);
      };
      var started = false;
      try {
        started = Bridge.validateKey(requestId);
      } catch (e) {
        warn('validateKey 异常：' + (e && e.message));
        started = false;
      }
      if (started === false) {
        finished = true;
        clearTimeout(timer);
        delete verifying[requestId];
        resolve({ ok: false, message: '原生 Bridge 不可用', httpStatus: 0 });
      }
    });
  }

  function fetchUrl(url, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var u = String(url === null || url === undefined ? '' : url).replace(/^\s+|\s+$/g, '');
      var schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(u);
      var scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
      var isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(u);
      if (!u || (scheme !== 'https' && !(scheme === 'http' && isLocal))) {
        resolve({
          ok: false,
          status: 0,
          body: '',
          error: '仅允许 https:// 链接（http 仅限 127.0.0.1 / localhost）',
          text: function () { return ''; },
          json: function () { return null; }
        });
        return;
      }
      if (!ensureBridge()) {
        resolve({
          ok: false, status: 0, body: '', error: '原生 Bridge 不可用',
          text: function () { return ''; },
          json: function () { return null; }
        });
        return;
      }
      ensureBound();
      var requestId = genRequestId('http');
      var finished = false;
      var timeout = typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : 30000;
      var timer = setTimeout(function () {
        if (finished) return;
        finished = true;
        delete httpPending[requestId];
        resolve({
          ok: false, status: 0, body: '', error: '请求超时',
          text: function () { return ''; },
          json: function () { return null; }
        });
      }, timeout);
      httpPending[requestId] = function (result) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(result);
      };
      var req = {
        url: u,
        method: String(opts.method || 'GET').toUpperCase(),
        headers: opts.headers && typeof opts.headers === 'object' ? opts.headers : {}
      };
      if (opts.body !== undefined && opts.body !== null) req.body = opts.body;
      var started = false;
      try {
        started = Bridge.httpFetch(requestId, JSON.stringify(req));
      } catch (e) {
        warn('httpFetch 异常：' + (e && e.message));
        started = false;
      }
      if (started === false) {
        finished = true;
        clearTimeout(timer);
        delete httpPending[requestId];
        resolve({
          ok: false, status: 0, body: '', error: '原生 Bridge 不可用',
          text: function () { return ''; },
          json: function () { return null; }
        });
      }
    });
  }

  function regenerate(opts) {
    return send(opts);
  }

  global.Api = {
    send: send,
    cancel: cancel,
    cancelAll: cancelAll,
    regenerate: regenerate,
    verifyKey: verifyKey,
    fetchUrl: fetchUrl,
    buildBody: buildBody,
    buildMessages: buildMessages,
    toApiMessage: toApiMessage,
    isMock: !!(Bridge && Bridge.__isMock),
    pendingCount: function () { return Object.keys(pending).length; }
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
