/*!
 * DeepSeek House — util.js
 * 通用工具（DOM 查询/创建、HTML 转义、时间格式化、防抖节流、剪贴板等）。
 * 挂载：window.Util
 */
(function (global) {
  'use strict';

  function getDoc() {
    try {
      return (typeof document !== 'undefined' && document) ? document : null;
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * DOM 查询 / 创建
   * ------------------------------------------------------------------ */

  function $(selector, root) {
    var d = root || getDoc();
    if (!d || !selector) return null;
    try { return d.querySelector(selector); } catch (e) { return null; }
  }

  function $$(selector, root) {
    var d = root || getDoc();
    if (!d || !selector) return [];
    try { return Array.prototype.slice.call(d.querySelectorAll(selector)); } catch (e) { return []; }
  }

  /**
   * 创建元素。
   * el('div', {className:'x', text:'hi', dataset:{id:'1'}, style:{color:'red'},
   *             onclick: fn, 'aria-label': '…'}, [child, 'text', null])
   * 注意：attrs.html 仅用于完全受信任的内部静态片段，禁止传入用户输入。
   */
  function el(tag, attrs, children) {
    var d = getDoc();
    if (!d || !d.createElement) return null;
    var node = d.createElement(tag || 'div');
    attrs = attrs || {};
    var keys = Object.keys(attrs);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') { node.textContent = String(v); continue; }
      if (k === 'html') { node.innerHTML = String(v); continue; }
      if (k === 'class' || k === 'className') { node.className = String(v); continue; }
      if (k === 'dataset' && typeof v === 'object') {
        var dkeys = Object.keys(v);
        for (var j = 0; j < dkeys.length; j++) {
          try { node.dataset[dkeys[j]] = String(v[dkeys[j]]); }
          catch (e) { node.setAttribute('data-' + dkeys[j], String(v[dkeys[j]])); }
        }
        continue;
      }
      if (k === 'style' && typeof v === 'object') {
        var skeys = Object.keys(v);
        for (var s = 0; s < skeys.length; s++) {
          try { node.style[skeys[s]] = String(v[skeys[s]]); } catch (e2) { /* ignore */ }
        }
        continue;
      }
      if (k.length > 2 && k.slice(0, 2) === 'on' && typeof v === 'function') {
        try { node.addEventListener(k.slice(2).toLowerCase(), v); } catch (e3) { /* ignore */ }
        continue;
      }
      try {
        if (k in node && k !== 'list' && k !== 'form') node[k] = v;
        else node.setAttribute(k, String(v));
      } catch (e4) {
        try { node.setAttribute(k, String(v)); } catch (e5) { /* ignore */ }
      }
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    if (!node || children === null || children === undefined) return node;
    if (!Array.isArray(children)) children = [children];
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c === null || c === undefined || c === false) continue;
      if (typeof c === 'string' || typeof c === 'number') {
        var d = getDoc();
        node.appendChild(d ? d.createTextNode(String(c)) : String(c));
      } else if (c.nodeType) {
        node.appendChild(c);
      }
    }
    return node;
  }

  /* ------------------------------------------------------------------ *
   * 字符串 / HTML
   * ------------------------------------------------------------------ */

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, function (ch) {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#39;';
      }
    });
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function truncate(value, max, suffix) {
    var str = value === null || value === undefined ? '' : String(value);
    var limit = Number(max) > 0 ? Number(max) : 20;
    if (str.length <= limit) return str;
    return str.slice(0, limit) + (suffix === undefined ? '…' : String(suffix));
  }

  function clamp(n, min, max) {
    n = Number(n);
    if (isNaN(n)) n = min;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* ------------------------------------------------------------------ *
   * uuid
   * ------------------------------------------------------------------ */

  function uuid() {
    try {
      if (global.crypto && typeof global.crypto.randomUUID === 'function') {
        return global.crypto.randomUUID();
      }
      if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
        var bytes = new Uint8Array(16);
        global.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        var hex = [];
        for (var i = 0; i < bytes.length; i++) {
          var h = bytes[i].toString(16);
          hex.push(h.length === 1 ? '0' + h : h);
        }
        var s = hex.join('');
        return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' +
          s.slice(16, 20) + '-' + s.slice(20, 32);
      }
    } catch (e) { /* fall through */ }
    var t = Date.now().toString(36);
    var r = Math.random().toString(36).slice(2, 10);
    var r2 = Math.random().toString(36).slice(2, 10);
    return 'u-' + t + '-' + r + '-' + r2;
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  /* ------------------------------------------------------------------ *
   * 时间
   * ------------------------------------------------------------------ */

  function toDate(ts) {
    if (ts instanceof Date) return ts;
    if (ts === null || ts === undefined || ts === '') return new Date();
    if (typeof ts === 'string' && !/^\d+$/.test(ts)) {
      var pd = new Date(ts);
      return isNaN(pd.getTime()) ? new Date() : pd;
    }
    var n = Number(ts);
    if (!isFinite(n) || isNaN(n)) return new Date();
    // 兼容秒级时间戳
    if (n > 0 && n < 1e12) n = n * 1000;
    var d = new Date(n);
    return isNaN(d.getTime()) ? new Date() : d;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** HH:MM */
  function formatTime(ts) {
    var d = toDate(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** YYYY-MM-DD HH:MM */
  function formatDateTime(ts) {
    var d = toDate(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** YYYY-MM-DD */
  function formatDate(ts) {
    var d = toDate(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function isSameDay(a, b) {
    var da = toDate(a);
    var db = toDate(b);
    return da.getFullYear() === db.getFullYear() &&
      da.getMonth() === db.getMonth() &&
      da.getDate() === db.getDate();
  }

  /** 今天 / 昨天 / M月D日 / YYYY年M月D日 */
  function formatDay(ts) {
    var d = toDate(ts);
    var now = new Date();
    if (isSameDay(d, now)) return '今天';
    var yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
    if (isSameDay(d, yesterday)) return '昨天';
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  /** 相对时间：刚刚 / N分钟前 / N小时前 / 日期 */
  function timeAgo(ts) {
    var d = toDate(ts);
    var diff = Date.now() - d.getTime();
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 3600 * 1000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 24 * 3600 * 1000) return Math.floor(diff / 3600000) + '小时前';
    if (diff < 7 * 24 * 3600 * 1000) return Math.floor(diff / 86400000) + '天前';
    return formatDate(d);
  }

  /* ------------------------------------------------------------------ *
   * 函数调度
   * ------------------------------------------------------------------ */

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
  }

  function debounce(fn, wait, immediate) {
    var timer = null;
    var lastArgs = null;
    var lastThis = null;
    function debounced() {
      lastArgs = arguments;
      lastThis = this;
      var callNow = immediate && !timer;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        if (!immediate) {
          try { fn.apply(lastThis, lastArgs); } catch (e) { /* ignore */ }
        }
      }, Math.max(0, Number(wait) || 0));
      if (callNow) {
        try { fn.apply(lastThis, lastArgs); } catch (e2) { /* ignore */ }
      }
    }
    debounced.cancel = function () {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    debounced.flush = function () {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        try { fn.apply(lastThis, lastArgs); } catch (e) { /* ignore */ }
      }
    };
    return debounced;
  }

  function throttle(fn, wait) {
    var last = 0;
    var timer = null;
    var lastArgs = null;
    var lastThis = null;
    return function () {
      var now = Date.now();
      var remain = Math.max(0, (Number(wait) || 0) - (now - last));
      lastArgs = arguments;
      lastThis = this;
      if (remain === 0) {
        last = now;
        try { fn.apply(lastThis, lastArgs); } catch (e) { /* ignore */ }
        return;
      }
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        last = Date.now();
        try { fn.apply(lastThis, lastArgs); } catch (e2) { /* ignore */ }
      }, remain);
    };
  }

  function raf(fn) {
    try {
      if (typeof global.requestAnimationFrame === 'function') return global.requestAnimationFrame(fn);
    } catch (e) { /* ignore */ }
    return setTimeout(function () { fn(Date.now()); }, 16);
  }

  /** 批处理：多次 schedule(args) 合并为一次 fn(args)（rAF + 最小间隔） */
  function batch(fn, minInterval) {
    var timer = null;
    var lastRun = 0;
    var latestArgs = null;
    function run() {
      timer = null;
      lastRun = Date.now();
      try { fn.call(null, latestArgs || []); } catch (e) { /* ignore */ }
    }
    function schedule() {
      latestArgs = arguments;
      if (timer) return;
      var wait = Math.max(0, (Number(minInterval) || 50) - (Date.now() - lastRun));
      timer = setTimeout(function () {
        if (timer) clearTimeout(timer);
        timer = null;
        raf(run);
      }, wait);
    }
    schedule.cancel = function () {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    schedule.flush = function () {
      if (timer) clearTimeout(timer);
      timer = null;
      run();
    };
    schedule.pending = function () { return !!timer; };
    return schedule;
  }

  /* ------------------------------------------------------------------ *
   * 剪贴板（优先走原生 Bridge）
   * ------------------------------------------------------------------ */

  function copyText(text) {
    var value = text === null || text === undefined ? '' : String(text);
    var Bridge = global.Bridge;
    try {
      if (Bridge && typeof Bridge.setClipboard === 'function') {
        Bridge.setClipboard(value);
        return Promise.resolve(true);
      }
    } catch (e) { /* fall through */ }
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(value).then(function () { return true; }).catch(function () {
          return fallbackCopy(value);
        });
      }
    } catch (e2) { /* fall through */ }
    return Promise.resolve(fallbackCopy(value));

    function fallbackCopy(val) {
      var d = getDoc();
      if (!d) return false;
      try {
        var ta = d.createElement('textarea');
        ta.value = val;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.opacity = '0';
        d.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = d.execCommand('copy'); } catch (e) { ok = false; }
        d.body.removeChild(ta);
        return !!ok;
      } catch (e2) {
        return false;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 其他
   * ------------------------------------------------------------------ */

  function noop() { }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function assign(target) {
    var out = target || {};
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src || typeof src !== 'object') continue;
      var keys = Object.keys(src);
      for (var j = 0; j < keys.length; j++) {
        if (src[keys[j]] !== undefined) out[keys[j]] = src[keys[j]];
      }
    }
    return out;
  }

  function parseJSON(str, fallback) {
    if (str === null || str === undefined || str === '') return fallback;
    if (typeof str !== 'string') return str;
    try { return JSON.parse(str); } catch (e) { return fallback; }
  }

  /** 规范化 Base URL：补 https://，去尾斜杠；非法返回 '' */
  function normalizeBaseUrl(url) {
    var s = String(url === null || url === undefined ? '' : url).trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    if (!/^https?:\/\//i.test(s)) return '';
    s = s.replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(s)) return '';
    return s;
  }

  global.Util = {
    $: $,
    $$: $$,
    el: el,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    truncate: truncate,
    clamp: clamp,
    escapeRegExp: escapeRegExp,
    uuid: uuid,
    uid: uid,
    formatTime: formatTime,
    formatDateTime: formatDateTime,
    formatDate: formatDate,
    formatDay: formatDay,
    timeAgo: timeAgo,
    isSameDay: isSameDay,
    toDate: toDate,
    sleep: sleep,
    debounce: debounce,
    throttle: throttle,
    batch: batch,
    raf: raf,
    copyText: copyText,
    noop: noop,
    isPlainObject: isPlainObject,
    assign: assign,
    parseJSON: parseJSON,
    normalizeBaseUrl: normalizeBaseUrl
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
