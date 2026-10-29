/*!
 * plugins.js — DeepSeek House 插件管理器（SPEC §5.2）
 *
 * 职责：
 *   1. 维护插件注册表（内置 builtin + 用户外部插件），并持久化启用状态；
 *   2. 加载原生插件列表 → 读取源码 → 在全局作用域执行注册；
 *   3. 汇总已启用插件的 tools 为 OpenAI function calling schema；
 *   4. 执行工具 / 斜杠命令 / 生命周期钩子；
 *   5. 安装（粘贴代码或选择文件）、卸载外部插件。
 *
 * 设计约定：
 *   - 本文件只依赖全局 Bridge / Store / UI / Util（均可缺失，缺失时降级），
 *     不直接操作 DOM；插件列表变化通过 onChange 通知 UI 层。
 *   - 外部插件代码用 new Function("window","DSPlugins","console", code) 执行，
 *     显式把 window 与 DSPlugins 作为参数传入，插件内 this 亦指向 window。
 *   - 内置插件 id 不可被外部插件覆盖；内置插件不可删除，只可禁用。
 *   - 网络能力统一由 ctx.http.fetch 提供，强制 https（http 仅 localhost/127.0.0.1）。
 */
(function (global) {
  "use strict";

  var STORE_KEY = "dsh.v1";
  var MAX_CODE_LENGTH = 512 * 1024; // 单个插件源码上限 512KB
  var FILE_INSTALL_TIMEOUT = 120000; // 等待用户选择文件的最长时间 120s
  var TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

  /* ------------------------------------------------------------------ *
   * 模块内部状态
   * ------------------------------------------------------------------ */
  var registry = Object.create(null); // id -> def
  var regOrder = []; // 注册顺序（决定列表与工具名竞争顺序）
  var changeListeners = [];
  var toolIndex = Object.create(null); // 对外工具名 -> {name, bare, pluginId, tool}
  var exposedTools = []; // 有序的对外工具列表
  var suppressChange = 0; // >0 时批量操作不触发 onChange
  var installing = null; // 安装验证期的注册捕获 {defs:[]}
  var fileListenerBound = false;
  var pendingFileInstall = null; // {resolve,reject,timer}
  var httpListenerBound = false;
  var httpPending = Object.create(null); // requestId -> {resolve,reject,timer}
  var externalLoading = null; // 并发 loadExternal 去重
  var seq = 0;

  var DSPlugins = null; // 在文件末尾赋值

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */
  function warn(message) {
    try {
      (global.console || console).warn("[DSPlugins] " + message);
    } catch (e) {
      /* ignore */
    }
  }

  function errText(err) {
    if (err == null) return "未知错误";
    if (typeof err === "string") return err;
    if (err.message) return String(err.message);
    return String(err);
  }

  function isFn(v) {
    return typeof v === "function";
  }

  function isObj(v) {
    return v !== null && typeof v === "object";
  }

  function trimStr(v) {
    return v == null ? "" : String(v).trim();
  }

  function uuid() {
    try {
      if (global.Util && isFn(global.Util.uuid)) return global.Util.uuid();
    } catch (e) {
      /* ignore */
    }
    seq += 1;
    return (
      "p" +
      Date.now().toString(36) +
      "-" +
      seq.toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10)
    );
  }

  function getBridge() {
    return isObj(global.Bridge) ? global.Bridge : null;
  }

  function getStore() {
    return isObj(global.Store) ? global.Store : null;
  }

  function getUI() {
    return isObj(global.UI) ? global.UI : null;
  }

  function normalizeResult(out) {
    if (out == null) return "";
    if (typeof out === "string") return out;
    if (typeof out === "number" || typeof out === "boolean" || typeof out === "bigint") {
      return String(out);
    }
    try {
      return JSON.stringify(out);
    } catch (e) {
      return String(out);
    }
  }

  /* ------------------------------------------------------------------ *
   * Store 持久化（state.plugins.enabled / state.plugins.settings）
   * 优先用 Store 暴露的接口，其次尝试拿到 state 引用后 save()，最后直接写
   * localStorage（dsh.v1）。store.js 若提供 setPluginEnabled(id,on) 最稳。
   * ------------------------------------------------------------------ */
  function readStoreState() {
    var S = getStore();
    if (S) {
      try {
        if (isFn(S.getState)) {
          var st = S.getState();
          if (isObj(st)) return { state: st, live: true };
        }
      } catch (e) {
        /* ignore */
      }
      try {
        if (isObj(S.state)) return { state: S.state, live: true };
      } catch (e2) {
        /* ignore */
      }
    }
    try {
      var ls = global.localStorage;
      if (ls && isFn(ls.getItem)) {
        var raw = ls.getItem(STORE_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (isObj(parsed)) return { state: parsed, live: false };
        }
      }
    } catch (e3) {
      /* ignore */
    }
    return null;
  }

  function persistStoreState(info) {
    var S = getStore();
    if (info && info.live && S && isFn(S.save)) {
      try {
        S.save();
        return true;
      } catch (e) {
        warn("Store.save 失败：" + errText(e));
      }
    }
    try {
      var ls = global.localStorage;
      if (ls && isFn(ls.setItem)) {
        ls.setItem(STORE_KEY, JSON.stringify((info && info.state) || {}));
        return true;
      }
    } catch (e2) {
      warn("保存插件状态失败：" + errText(e2));
    }
    return false;
  }

  function ensurePluginsBucket(state) {
    var st = state;
    if (!isObj(st)) st = {};
    if (!isObj(st.plugins)) st.plugins = {};
    if (!isObj(st.plugins.enabled)) st.plugins.enabled = {};
    if (!isObj(st.plugins.settings)) st.plugins.settings = {};
    return st;
  }

  function readEnabledRaw(id) {
    var info = readStoreState();
    if (!info) return undefined;
    var map = info.state.plugins && info.state.plugins.enabled;
    if (isObj(map) && typeof map[id] === "boolean") return map[id];
    return undefined;
  }

  function persistEnabled(id, on) {
    var S = getStore();
    if (S) {
      var methodNames = ["setPluginEnabled", "setPluginEnabledState", "setPluginsEnabled"];
      for (var i = 0; i < methodNames.length; i++) {
        var fn = S[methodNames[i]];
        if (isFn(fn)) {
          try {
            fn.call(S, id, !!on);
            return true;
          } catch (e) {
            warn("Store." + methodNames[i] + " 调用失败：" + errText(e));
          }
        }
      }
    }
    var info = readStoreState();
    if (!info) info = { state: { version: 1 }, live: false };
    info.state = ensurePluginsBucket(info.state);
    info.state.plugins.enabled[id] = !!on;
    return persistStoreState(info);
  }

  function removeEnabledFromStore(id) {
    var info = readStoreState();
    if (!info) return;
    var st = ensurePluginsBucket(info.state);
    if (Object.prototype.hasOwnProperty.call(st.plugins.enabled, id)) delete st.plugins.enabled[id];
    if (Object.prototype.hasOwnProperty.call(st.plugins.settings, id)) delete st.plugins.settings[id];
    persistStoreState(info);
  }

  function createSettingsApi(pluginId) {
    return {
      get: function (key, defaultValue) {
        var info = readStoreState();
        var map = info && info.state.plugins && info.state.plugins.settings;
        var own = map && isObj(map[pluginId]) ? map[pluginId] : null;
        if (own && Object.prototype.hasOwnProperty.call(own, key)) return own[key];
        return defaultValue;
      },
      set: function (key, value) {
        if (!pluginId || key == null) return false;
        var info = readStoreState();
        if (!info) info = { state: { version: 1 }, live: false };
        var st = ensurePluginsBucket(info.state);
        var bucket = st.plugins.settings[pluginId];
        if (!isObj(bucket)) bucket = st.plugins.settings[pluginId] = {};
        bucket[String(key)] = value;
        return persistStoreState(info);
      },
      all: function () {
        var info = readStoreState();
        var map = info && info.state.plugins && info.state.plugins.settings;
        return map && isObj(map[pluginId]) ? map[pluginId] : {};
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * 上下文 ctx（SPEC §5.1）
   * ------------------------------------------------------------------ */
  function defaultCtx(pluginId) {
    var ctx = {
      pluginId: pluginId || null,
      settings: createSettingsApi(pluginId),
      toast: function (text) {
        var t = trimStr(text);
        if (!t) return;
        try {
          var ui = getUI();
          if (ui && isFn(ui.toast)) {
            ui.toast(t);
            return;
          }
        } catch (e) {
          /* ignore */
        }
        try {
          var B = getBridge();
          if (B && isFn(B.toast)) B.toast(t);
        } catch (e2) {
          /* ignore */
        }
      },
      ui: getUI(),
      http: { fetch: safeFetch },
      chat: null,
      store: getStore(),
      plugins: null, // 下面填入 DSPlugins
      _append: null,
      _note: null
    };

    ctx.addNote = function (text) {
      var t = trimStr(text);
      if (!t) return null;
      if (isFn(ctx._note)) {
        try {
          return ctx._note(t);
        } catch (e) {
          warn("ctx.addNote 失败：" + errText(e));
          return null;
        }
      }
      var msg = { id: uuid(), role: "note", content: t, createdAt: Date.now() };
      var done = ctx.appendMessage(msg);
      if (!done) warn("ctx.addNote：当前上下文不支持追加消息");
      return done ? msg : null;
    };

    ctx.appendMessage = function (msg) {
      if (!isObj(msg)) return false;
      if (isFn(ctx._append)) {
        try {
          ctx._append(msg);
          return true;
        } catch (e) {
          warn("ctx.appendMessage 失败：" + errText(e));
        }
      }
      try {
        var ui = getUI();
        if (ui && isFn(ui.appendMessage)) {
          ui.appendMessage(msg);
          return true;
        }
      } catch (e2) {
        warn("ctx.appendMessage 失败：" + errText(e2));
      }
      return false;
    };

    return ctx;
  }

  function makeCtx(pluginId, extra) {
    var ctx = defaultCtx(pluginId);
    if (isObj(extra)) {
      if (isFn(extra.appendMessage)) ctx._append = extra.appendMessage;
      if (isFn(extra.addNote)) ctx._note = extra.addNote;
      Object.keys(extra).forEach(function (k) {
        if (
          k === "http" ||
          k === "settings" ||
          k === "pluginId" ||
          k === "addNote" ||
          k === "appendMessage" ||
          k === "_append" ||
          k === "_note" ||
          k === "plugins"
        ) {
          return;
        }
        if (extra[k] !== undefined) ctx[k] = extra[k];
      });
    }
    ctx.plugins = DSPlugins;
    return ctx;
  }

  /* ------------------------------------------------------------------ *
   * 网络能力：ctx.http.fetch（强制 https / localhost）
   * ------------------------------------------------------------------ */
  function ensureHttpListener() {
    if (httpListenerBound) return;
    var B = getBridge();
    if (!B || !isFn(B.onEvent)) return;
    try {
      B.onEvent("http", function (ev) {
        if (!isObj(ev)) return;
        var rid = ev.requestId;
        var entry = rid == null ? null : httpPending[rid];
        if (!entry) return;
        delete httpPending[rid];
        if (entry.timer) {
          try {
            clearTimeout(entry.timer);
          } catch (e) {
            /* ignore */
          }
        }
        if (ev.error) {
          entry.reject(new Error(String(ev.error)));
          return;
        }
        var status = typeof ev.status === "number" ? ev.status : 0;
        var body = ev.body == null ? "" : typeof ev.body === "string" ? ev.body : normalizeResult(ev.body);
        entry.resolve({
          status: status,
          ok: status >= 200 && status < 300,
          body: body,
          text: body
        });
      });
      httpListenerBound = true;
    } catch (e) {
      warn("注册 http 事件监听失败：" + errText(e));
    }
  }

  function safeFetch(url, opts) {
    return new Promise(function (resolve, reject) {
      var raw = trimStr(url);
      var parsed;
      try {
        parsed = new URL(raw);
      } catch (e) {
        reject(new Error("无效的 URL：" + raw));
        return;
      }
      var proto = String(parsed.protocol || "").toLowerCase();
      var host = String(parsed.hostname || "").toLowerCase();
      var isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
      if (!(proto === "https:" || (proto === "http:" && isLocalHost))) {
        reject(new Error("安全限制：插件网络请求只允许 https（http 仅限 localhost / 127.0.0.1）：" + raw));
        return;
      }
      var B = getBridge();
      if (!B || !isFn(B.httpFetch)) {
        reject(new Error("当前环境不支持网络请求（Bridge.httpFetch 不可用）"));
        return;
      }
      ensureHttpListener();

      var o = isObj(opts) ? opts : {};
      var timeout = Number(o.timeout) > 0 ? Math.min(Number(o.timeout), 120000) : 30000;
      var requestId = "plugin-http-" + uuid();
      var reqJson;
      try {
        reqJson = JSON.stringify({
          url: raw,
          method: (trimStr(o.method) || "GET").toUpperCase(),
          headers: isObj(o.headers) ? o.headers : {},
          body: o.body == null ? null : typeof o.body === "string" ? o.body : normalizeResult(o.body)
        });
      } catch (e2) {
        reject(new Error("构造网络请求失败：" + errText(e2)));
        return;
      }

      var entry = { resolve: resolve, reject: reject, timer: null };
      entry.timer = setTimeout(function () {
        if (!httpPending[requestId]) return;
        delete httpPending[requestId];
        reject(new Error("网络请求超时（" + Math.round(timeout / 1000) + " 秒）：" + raw));
      }, timeout);
      httpPending[requestId] = entry;
      try {
        B.httpFetch(requestId, reqJson);
      } catch (e3) {
        try {
          clearTimeout(entry.timer);
        } catch (e4) {
          /* ignore */
        }
        delete httpPending[requestId];
        reject(new Error("发起网络请求失败：" + errText(e3)));
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 工具名 / 命令名
   * ------------------------------------------------------------------ */
  function isValidToolName(name) {
    return TOOL_NAME_RE.test(name);
  }

  function truncateName(name, max) {
    if (name.length <= max) return name;
    return name.slice(0, max);
  }

  function sanitizeToolBase(name) {
    var base = trimStr(name).replace(/[^A-Za-z0-9_-]/g, "_");
    if (!base) base = "tool";
    return truncateName(base, 48);
  }

  function pluginPrefix(id) {
    var p = trimStr(id).replace(/^user\./i, "").replace(/[^A-Za-z0-9_-]/g, "_");
    if (!p) p = "plugin";
    if (!/^[A-Za-z]/.test(p)) p = "p_" + p;
    return truncateName(p, 24);
  }

  // 工具名稳定规则：先到先得占用裸名；冲突时改用「插件前缀_工具名」；
  // 若仍冲突则追加 _2、_3 …；都失败则跳过并告警。
  function pickToolName(base, def, used) {
    if (isValidToolName(base) && !used[base]) return base;
    var prefix = pluginPrefix(def.id);
    var candidate = truncateName(prefix + "_" + base, 64);
    if (isValidToolName(candidate) && !used[candidate]) return candidate;
    for (var n = 2; n <= 30; n += 1) {
      var alt = truncateName(prefix + "_" + base + "_" + n, 64);
      if (isValidToolName(alt) && !used[alt]) return alt;
    }
    return null;
  }

  function buildToolIndex() {
    toolIndex = Object.create(null);
    exposedTools = [];
    var used = Object.create(null);
    for (var i = 0; i < regOrder.length; i += 1) {
      var id = regOrder[i];
      var def = registry[id];
      if (!def || def.error || !isEnabled(id)) continue;
      var tools = def.tools || [];
      for (var j = 0; j < tools.length; j += 1) {
        var tool = tools[j];
        if (!tool || !isFn(tool.run)) continue;
        var base = sanitizeToolBase(tool.name);
        var exposed = pickToolName(base, def, used);
        if (!exposed) {
          warn("工具名冲突且无法生成稳定别名，已跳过：" + id + " / " + tool.name);
          continue;
        }
        used[exposed] = true;
        var entry = { name: exposed, bare: base, pluginId: id, tool: tool };
        toolIndex[exposed] = entry;
        exposedTools.push(entry);
      }
    }
  }

  function resolveTool(name) {
    buildToolIndex();
    var key = trimStr(name);
    if (!key) return null;
    if (toolIndex[key]) return toolIndex[key];
    for (var i = 0; i < exposedTools.length; i += 1) {
      var entry = exposedTools[i];
      if (entry.bare === key || entry.tool.name === key) return entry;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 插件定义校验 / 注册表
   * ------------------------------------------------------------------ */
  function normalizeDef(input) {
    if (!isObj(input)) throw new Error("插件定义必须是对象");
    var id = trimStr(input.id);
    if (!id) throw new Error("插件定义缺少 id");
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
      throw new Error("插件 id 只能包含字母、数字、点、下划线、短横线（最长 64）：" + id);
    }
    var name = trimStr(input.name) || id;
    if (name.length > 60) name = name.slice(0, 60);
    var version = trimStr(input.version) || "1.0.0";

    var def = {
      id: id,
      name: name,
      version: version,
      author: trimStr(input.author),
      description: trimStr(input.description),
      builtin: input.builtin === true,
      external: false,
      settings: isObj(input.settings) ? input.settings : null,
      commands: [],
      tools: [],
      hooks: {},
      error: null,
      fileName: "",
      _loaded: false,
      _nativeEnabled: undefined
    };

    var seenCmd = Object.create(null);
    var rawCommands = Array.isArray(input.commands) ? input.commands : [];
    for (var i = 0; i < rawCommands.length && def.commands.length < 100; i += 1) {
      var c = rawCommands[i];
      if (!isObj(c)) continue;
      var cn = trimStr(c.name).replace(/^\/+/, "").toLowerCase();
      if (!cn || !/^[a-z0-9_-]{1,32}$/.test(cn)) {
        warn("插件 " + id + " 的命令名无效，已跳过：" + trimStr(c.name));
        continue;
      }
      if (!isFn(c.run)) {
        warn("插件 " + id + " 的命令 /" + cn + " 缺少 run 函数，已跳过");
        continue;
      }
      if (seenCmd[cn]) {
        warn("插件 " + id + " 的命令 /" + cn + " 重复，已跳过");
        continue;
      }
      seenCmd[cn] = true;
      var aliases = [];
      if (Array.isArray(c.aliases)) {
        c.aliases.forEach(function (a) {
          var an = trimStr(a).replace(/^\/+/, "").toLowerCase();
          if (an && /^[a-z0-9_-]{1,32}$/.test(an) && !seenCmd[an]) {
            seenCmd[an] = true;
            aliases.push(an);
          }
        });
      }
      def.commands.push({
        name: cn,
        aliases: aliases,
        description: trimStr(c.description),
        usage: trimStr(c.usage),
        run: c.run
      });
    }

    var seenTool = Object.create(null);
    var rawTools = Array.isArray(input.tools) ? input.tools : [];
    for (var j = 0; j < rawTools.length && def.tools.length < 50; j += 1) {
      var t = rawTools[j];
      if (!isObj(t)) continue;
      var tn = trimStr(t.name);
      if (!tn) {
        warn("插件 " + id + " 的工具缺少 name，已跳过");
        continue;
      }
      if (!isFn(t.run)) {
        warn("插件 " + id + " 的工具 " + tn + " 缺少 run 函数，已跳过");
        continue;
      }
      var toolKey = tn.toLowerCase();
      if (seenTool[toolKey]) {
        warn("插件 " + id + " 的工具名 " + tn + " 重复，已跳过");
        continue;
      }
      seenTool[toolKey] = true;
      def.tools.push({
        name: tn,
        description: trimStr(t.description),
        parameters: isObj(t.parameters) ? t.parameters : { type: "object", properties: {} },
        run: t.run
      });
    }

    if (isObj(input.hooks)) {
      Object.keys(input.hooks).forEach(function (k) {
        if (isFn(input.hooks[k])) def.hooks[k] = input.hooks[k];
      });
    }

    return def;
  }

  function addDef(def) {
    var existing = registry[def.id];
    if (existing && existing.builtin && !def.builtin) return null;
    if (!existing) regOrder.push(def.id);
    registry[def.id] = def;
    return def;
  }

  function removeFromRegistry(id) {
    if (!registry[id]) return false;
    delete registry[id];
    var idx = regOrder.indexOf(id);
    if (idx >= 0) regOrder.splice(idx, 1);
    return true;
  }

  function publicView(def) {
    return {
      id: def.id,
      name: def.name,
      version: def.version,
      author: def.author || "",
      description: def.description || "",
      builtin: !!def.builtin,
      external: !!def.external,
      enabled: isEnabled(def.id),
      error: def.error || null,
      fileName: def.fileName || "",
      // 命令/工具以对象形式返回，便于 UI 生成帮助列表
      commands: (def.commands || []).map(function (c) {
        return { name: c.name, description: c.description, usage: c.usage };
      }),
      tools: (def.tools || []).map(function (t) {
        return { name: t.name, description: t.description };
      })
    };
  }

  function list() {
    var out = [];
    for (var i = 0; i < regOrder.length; i += 1) {
      var def = registry[regOrder[i]];
      if (def) out.push(publicView(def));
    }
    return out;
  }

  function get(id) {
    var def = registry[trimStr(id)];
    return def ? publicView(def) : null;
  }

  function register(input) {
    // 安装验证阶段只捕获、不真正注册
    if (installing) {
      installing.defs.push(input);
      return input;
    }
    var def;
    try {
      def = normalizeDef(input);
    } catch (e) {
      warn("插件注册失败：" + errText(e));
      return null;
    }
    var existing = registry[def.id];
    if (existing && existing.builtin && !def.builtin) {
      warn("插件 id「" + def.id + "」与内置插件冲突，外部插件不能覆盖内置插件，已忽略");
      return null;
    }
    if (existing && !existing.builtin) {
      // 外部插件重载 / 升级：保留文件与状态信息
      if (!def.fileName && existing.fileName) def.fileName = existing.fileName;
      if (def._nativeEnabled === undefined) def._nativeEnabled = existing._nativeEnabled;
      if (existing._loaded) def._loaded = true;
    }
    if (!def.builtin) def.external = true;
    addDef(def);
    if (suppressChange === 0) emitChange();
    return def;
  }

  /* ------------------------------------------------------------------ *
   * 启用状态（内置只看 Store；外部合并 Store + 原生）
   *   合并规则：任一侧显式为 false → 禁用；任一侧显式为 true → 启用；
   *             两侧都未记录 → 默认启用（内置 / 外部一致）。
   * ------------------------------------------------------------------ */
  function externalEnabled(id, nativeFlag, defaultValue) {
    var stored = readEnabledRaw(id);
    if (stored === false || nativeFlag === false) return false;
    if (stored === true || nativeFlag === true) return true;
    return defaultValue !== false;
  }

  function isEnabled(id) {
    var def = registry[id];
    if (!def || def.error) return false;
    if (def.builtin) {
      var stored = readEnabledRaw(id);
      return stored === undefined ? true : !!stored;
    }
    return externalEnabled(id, def._nativeEnabled, true);
  }

  function setEnabled(id, on) {
    var def = registry[id];
    if (!def) {
      warn("插件不存在：" + id);
      return false;
    }
    on = !!on;
    persistEnabled(id, on);
    if (!def.builtin) {
      def._nativeEnabled = on;
      var B = getBridge();
      if (B && isFn(B.pluginSetEnabled)) {
        try {
          B.pluginSetEnabled(id, on);
        } catch (e) {
          warn("同步插件开关到原生失败：" + errText(e));
        }
      }
      // 未加载或上次加载失败时，重新启用会再次尝试加载源码
      if (on && def.external && !def._loaded) {
        loadExternalOne(def).then(
          function () {
            emitChange();
          },
          function (e) {
            warn("启用外部插件失败：" + errText(e));
            emitChange();
          }
        );
      }
    }
    emitChange();
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 工具调用（SPEC §5.2）
   * ------------------------------------------------------------------ */
  function toolSchemas() {
    buildToolIndex();
    return exposedTools.map(function (entry) {
      var tool = entry.tool;
      return {
        type: "function",
        function: {
          name: entry.name,
          description:
            trimStr(tool.description) || "插件 " + entry.pluginId + " 提供的工具 " + entry.bare,
          parameters: isObj(tool.parameters) ? tool.parameters : { type: "object", properties: {} }
        }
      };
    });
  }

  async function runTool(name, args, ctx) {
    var target = resolveTool(name);
    if (!target) return "未找到插件工具：" + trimStr(name);
    var callArgs = isObj(args) ? args : {};
    try {
      var out = await target.tool.run.call(target.tool, makeCtx(target.pluginId, ctx), callArgs);
      return normalizeResult(out);
    } catch (e) {
      warn("插件工具执行失败（" + target.pluginId + " / " + target.name + "）：" + errText(e));
      return "插件工具「" + target.name + "」执行失败：" + errText(e);
    }
  }

  /* ------------------------------------------------------------------ *
   * 斜杠命令 / 钩子（SPEC §5.2）
   * ------------------------------------------------------------------ */
  // 兼容两种调用风格：runCommand("/calc 1+2") 或 runCommand("calc", "1+2")
  function parseCommandInput(cmd) {
    var s = trimStr(cmd).replace(/^\/+/, "");
    var m = /^(\S+)\s*([\s\S]*)$/.exec(s);
    if (!m) return { name: "", rest: "" };
    return { name: m[1].toLowerCase(), rest: m[2].trim() };
  }

  function argsEmpty(args) {
    if (args == null) return true;
    if (typeof args === "string") return !args.trim();
    if (Array.isArray(args)) return args.length === 0;
    return false;
  }

  async function runCommand(cmd, args, ctx) {
    var parsed = parseCommandInput(cmd);
    var name = parsed.name;
    if (!name) return null;
    var cmdArgs = argsEmpty(args) ? parsed.rest : args;
    var i;
    var j;

    // 1) hooks.onCommand 优先（返回非空则直接作为命令结果）
    for (i = 0; i < regOrder.length; i += 1) {
      var hdef = registry[regOrder[i]];
      if (!hdef || hdef.error || !isEnabled(hdef.id)) continue;
      var hook = hdef.hooks && hdef.hooks.onCommand;
      if (!isFn(hook)) continue;
      try {
        var hookRes = await hook.call(hdef, makeCtx(hdef.id, ctx), name, cmdArgs);
        if (hookRes != null && hookRes !== false && hookRes !== "") {
          return normalizeResult(hookRes);
        }
      } catch (e) {
        warn("插件 hooks.onCommand 执行失败（" + hdef.id + "）：" + errText(e));
      }
    }

    // 2) 命令表
    for (i = 0; i < regOrder.length; i += 1) {
      var def = registry[regOrder[i]];
      if (!def || def.error || !isEnabled(def.id)) continue;
      var commands = def.commands || [];
      for (j = 0; j < commands.length; j += 1) {
        var c = commands[j];
        var matched = c.name === name || c.aliases.indexOf(name) >= 0;
        if (!matched) continue;
        try {
          var out = await c.run.call(c, makeCtx(def.id, ctx), cmdArgs);
          return normalizeResult(out);
        } catch (e2) {
          warn("插件命令执行失败（" + def.id + " / /" + c.name + "）：" + errText(e2));
          return "插件命令 /" + c.name + " 执行失败：" + errText(e2);
        }
      }
    }
    return null;
  }

  /**
   * 运行生命周期钩子。app.js 建议用法：
   *   await DSPlugins.runHook("onBeforeSend", payload)   // 可在插件内修改 payload
   *   await DSPlugins.runHook("onResponse", msg)
   * 返回各插件返回值组成的数组（失败项为 undefined，已 console.warn）。
   */
  async function runHook(hookName, arg1, arg2, ctxExtra) {
    var name = trimStr(hookName);
    if (!name) return [];
    var results = [];
    for (var i = 0; i < regOrder.length; i += 1) {
      var def = registry[regOrder[i]];
      if (!def || def.error || !isEnabled(def.id)) continue;
      var fn = def.hooks && def.hooks[name];
      if (!isFn(fn)) continue;
      try {
        results.push(await fn.call(def, makeCtx(def.id, ctxExtra), arg1, arg2));
      } catch (e) {
        warn("插件钩子 " + name + " 执行失败（" + def.id + "）：" + errText(e));
        results.push(undefined);
      }
    }
    return results;
  }

  /* ------------------------------------------------------------------ *
   * 外部插件：执行 / 加载
   * ------------------------------------------------------------------ */
  function execPluginCode(code, sourceId) {
    var fn;
    try {
      fn = new Function(
        "window",
        "DSPlugins",
        "console",
        String(code) +
          "\n//# sourceURL=deepseek-house-plugin://" +
          encodeURIComponent(sourceId || "plugin") +
          ".js"
      );
    } catch (e) {
      throw new Error("插件代码语法错误：" + errText(e));
    }
    fn.call(global, global, DSPlugins, global.console || console);
  }

  function decodePluginList(raw) {
    var value = raw;
    if (typeof value === "string") {
      var s = value.trim();
      if (!s) return [];
      try {
        value = JSON.parse(s);
      } catch (e) {
        warn("解析插件列表失败：" + errText(e));
        return [];
      }
    }
    if (Array.isArray(value)) return value;
    if (isObj(value) && Array.isArray(value.plugins)) return value.plugins;
    if (isObj(value) && value.error) {
      warn("读取插件列表失败：" + value.error);
      return [];
    }
    return [];
  }

  function makeStub(item) {
    var id = trimStr(item && item.id);
    var nativeFlag;
    if (item && item.enabled === false) nativeFlag = false;
    else if (item && item.enabled === true) nativeFlag = true;
    return {
      id: id,
      name: trimStr(item && item.name) || id,
      version: trimStr(item && item.version) || "1.0.0",
      author: trimStr(item && item.author),
      description: trimStr(item && item.description),
      builtin: false,
      external: true,
      fileName: trimStr(item && item.fileName),
      commands: [],
      tools: [],
      hooks: {},
      error: null,
      _loaded: false,
      _nativeEnabled: nativeFlag
    };
  }

  function addExternalStub(stub) {
    if (!stub || !stub.id) return null;
    var existing = registry[stub.id];
    if (existing && existing.builtin) return null;
    stub.external = true;
    stub.builtin = false;
    if (!existing) regOrder.push(stub.id);
    registry[stub.id] = stub;
    return stub;
  }

  function addErrorStub(stub, message) {
    var d = {
      id: stub.id,
      name: stub.name || stub.id,
      version: stub.version || "1.0.0",
      author: stub.author || "",
      description: stub.description || "",
      builtin: false,
      external: true,
      fileName: stub.fileName || "",
      commands: [],
      tools: [],
      hooks: {},
      error: message,
      _loaded: false,
      _nativeEnabled: stub._nativeEnabled
    };
    if (!registry[d.id]) regOrder.push(d.id);
    registry[d.id] = d;
    warn("外部插件加载失败（" + d.id + "）：" + message);
    return d;
  }

  // 加载单个外部插件：读取源码 → 全局执行 → 校验注册结果
  async function loadExternalOne(stub) {
    var id = stub.id;
    var B = getBridge();
    if (!B || !isFn(B.pluginRead)) {
      addErrorStub(stub, "Bridge.pluginRead 不可用");
      return null;
    }
    var code;
    try {
      code = await Promise.resolve(B.pluginRead(id));
    } catch (e) {
      addErrorStub(stub, "读取插件源码失败：" + errText(e));
      return null;
    }
    if (isObj(code) && code.error) {
      addErrorStub(stub, "读取插件源码失败：" + code.error);
      return null;
    }
    if (typeof code !== "string" || !code.trim()) {
      addErrorStub(stub, "插件源码为空或读取失败");
      return null;
    }
    if (/^\s*\{\s*"error"\s*:/.test(code)) {
      addErrorStub(stub, "读取插件源码失败：" + code.slice(0, 200));
      return null;
    }
    if (code.length > MAX_CODE_LENGTH) {
      addErrorStub(stub, "插件源码过大（超过 512KB）");
      return null;
    }

    removeFromRegistry(id);
    var beforeKeys = Object.keys(registry);
    var execError = null;
    suppressChange += 1;
    try {
      execPluginCode(code, id);
    } catch (e2) {
      execError = e2;
    } finally {
      suppressChange -= 1;
    }

    // 清理插件代码额外注册的 id（一个文件只允许一个插件）
    var added = Object.keys(registry).filter(function (k) {
      return beforeKeys.indexOf(k) < 0;
    });
    for (var i = 0; i < added.length; i += 1) {
      var extraId = added[i];
      if (extraId === id) continue;
      removeFromRegistry(extraId);
      warn("一个插件文件只允许注册一个插件，已忽略额外插件：" + extraId);
    }

    if (execError) {
      removeFromRegistry(id);
      addErrorStub(stub, "执行插件代码失败：" + errText(execError));
      return null;
    }
    var def = registry[id];
    if (!def) {
      addErrorStub(stub, "插件代码未调用 window.DSPlugins.register({...})");
      return null;
    }
    def.builtin = false;
    def.external = true;
    def.fileId = id;
    if (stub.fileName) def.fileName = stub.fileName;
    def._loaded = true;
    def._nativeEnabled = stub._nativeEnabled;
    def.error = null;
    return def;
  }

  async function doLoadExternal() {
    var B = getBridge();
    if (!B || !isFn(B.plugins)) {
      warn("Bridge.plugins 不可用，跳过外部插件加载");
      return [];
    }
    var raw;
    try {
      raw = await Promise.resolve(B.plugins());
    } catch (e) {
      warn("读取插件列表失败：" + errText(e));
      return [];
    }
    var pluginList = decodePluginList(raw);
    var loaded = [];
    suppressChange += 1;
    try {
      for (var i = 0; i < pluginList.length; i += 1) {
        var item = pluginList[i];
        var id = trimStr(item && item.id);
        if (!id) continue;
        var existing = registry[id];
        if (existing && existing.builtin) {
          warn("插件 id 与内置插件冲突，已忽略外部插件：" + id);
          continue;
        }
        if (existing && existing.external && existing._loaded) {
          loaded.push(existing);
          continue;
        }
        var stub = makeStub(item);
        if (!externalEnabled(id, stub._nativeEnabled, true)) {
          addExternalStub(stub);
          continue;
        }
        var loadedDef = await loadExternalOne(stub);
        if (loadedDef) loaded.push(loadedDef);
      }
    } finally {
      suppressChange -= 1;
    }
    emitChange();
    return loaded;
  }

  function loadExternal() {
    if (externalLoading) return externalLoading;
    externalLoading = doLoadExternal().then(
      function (res) {
        externalLoading = null;
        return res;
      },
      function (e) {
        externalLoading = null;
        throw e;
      }
    );
    return externalLoading;
  }

  /* ------------------------------------------------------------------ *
   * 安装 / 卸载
   * ------------------------------------------------------------------ */
  function parseMeta(code) {
    var meta = Object.create(null);
    var lines = String(code || "").split(/\r?\n/).slice(0, 25);
    var re = /^\s*(?:\/\/+|\/\*+|\*|#)\s*@([A-Za-z][A-Za-z0-9_-]*)\s*:?\s*(.+?)\s*$/;
    for (var i = 0; i < lines.length; i += 1) {
      var m = re.exec(lines[i]);
      if (!m) continue;
      var key = m[1].toLowerCase();
      if (key !== "id" && key !== "name" && key !== "version" && key !== "author" && key !== "description") {
        continue;
      }
      var val = m[2].replace(/\*\/\s*$/, "").trim();
      if (!meta[key] && val) meta[key] = val;
    }
    return meta;
  }

  async function installFromCode(code, extraMeta) {
    var src = typeof code === "string" ? code : "";
    if (!src.trim()) throw new Error("插件代码不能为空");
    if (src.length > MAX_CODE_LENGTH) throw new Error("插件代码过大（超过 512KB）");

    var B = getBridge();
    if (!B || !isFn(B.pluginWrite)) {
      throw new Error("当前环境不支持安装插件（Bridge.pluginWrite 不可用）");
    }

    // 元数据注释头是可选的（SPEC §5.1）；真正的 id 优先从 register({id}) 推导。
    var fallback = isObj(extraMeta) ? extraMeta : {};
    var meta = parseMeta(src);

    // 先执行验证（注册被捕获到 installing.defs，不污染正式注册表）
    installing = { defs: [] };
    var execError = null;
    var captured = null;
    try {
      execPluginCode(src, "install");
    } catch (e) {
      execError = e;
    } finally {
      captured = installing;
      installing = null;
    }
    if (execError) throw new Error("插件代码执行失败：" + errText(execError));

    var defs = captured && captured.defs ? captured.defs : [];
    if (!defs.length) throw new Error("插件代码没有调用 window.DSPlugins.register({...})");
    if (defs.length > 1) {
      throw new Error("一个插件文件只能注册一个插件（检测到 " + defs.length + " 个）");
    }

    var rawDef = defs[0];
    if (!isObj(rawDef)) throw new Error("插件定义必须是对象");
    var registeredId = trimStr(rawDef.id);
    var metaId = trimStr(meta.id || fallback.id);
    var id = registeredId || metaId;
    if (!id) {
      throw new Error("插件没有提供 id：请在 register({id:...}) 中设置，或添加注释 // @id user.xxx");
    }
    if (registeredId && metaId && registeredId !== metaId) {
      warn("插件注释头 id（" + metaId + "）与 register id（" + registeredId + "）不一致，以 register id 为准");
    }
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
      throw new Error("插件 id 只能包含字母、数字、点、下划线、短横线（最长 64）：" + id);
    }
    if (id.indexOf("user.") !== 0) {
      warn("外部插件 id 建议以 user. 开头（当前：" + id + "），以免与内置插件混淆");
    }
    if (registry[id] && registry[id].builtin) {
      throw new Error("插件 id 与内置插件冲突：" + id);
    }

    var def;
    try {
      def = normalizeDef(Object.assign({}, rawDef, { id: id }));
    } catch (e2) {
      throw new Error("插件定义无效：" + errText(e2));
    }
    var name = trimStr(meta.name || fallback.name) || def.name;
    var version = trimStr(meta.version || fallback.version) || def.version || "1.0.0";
    if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/.test(version)) {
      warn("插件版本号格式不规范（" + version + "），已按 1.0.0 记录");
      version = "1.0.0";
    }
    var author = trimStr(meta.author || fallback.author) || def.author || "";
    var description = trimStr(meta.description || fallback.description) || def.description || "";
    var hasHook = Object.keys(def.hooks).some(function (k) {
      return isFn(def.hooks[k]);
    });
    if (!def.commands.length && !def.tools.length && !hasHook) {
      throw new Error("插件没有提供任何命令、工具或钩子，无法安装");
    }

    def.builtin = false;
    def.external = true;
    def.fileId = id;
    def.fileName = trimStr(fallback.fileName) || id + ".js";
    def._loaded = true;
    def._nativeEnabled = true;
    def.error = null;

    var metaJson;
    try {
      metaJson = JSON.stringify({
        id: id,
        name: name,
        version: version,
        author: author,
        description: description,
        installedAt: Date.now()
      });
    } catch (e3) {
      throw new Error("构造插件元数据失败：" + errText(e3));
    }

    // 落盘（成功后才进入正式注册表）
    try {
      await Promise.resolve(B.pluginWrite(id, src, metaJson));
    } catch (e4) {
      throw new Error("写入插件文件失败：" + errText(e4));
    }

    addDef(def);
    persistEnabled(id, true);
    if (isFn(B.pluginSetEnabled)) {
      try {
        B.pluginSetEnabled(id, true);
      } catch (e5) {
        warn("同步插件开关到原生失败：" + errText(e5));
      }
    }
    emitChange();
    return publicView(def);
  }

  function ensureFileListener() {
    if (fileListenerBound) return;
    var B = getBridge();
    if (!B || !isFn(B.onEvent)) return;
    try {
      B.onEvent("plugin-file", onPluginFileEvent);
      fileListenerBound = true;
    } catch (e) {
      warn("注册 plugin-file 事件监听失败：" + errText(e));
    }
  }

  function onPluginFileEvent(ev) {
    var pending = pendingFileInstall;
    if (!pending) {
      warn("收到未预期的 plugin-file 事件，已忽略");
      return;
    }
    pendingFileInstall = null;
    if (pending.timer) {
      try {
        clearTimeout(pending.timer);
      } catch (e) {
        /* ignore */
      }
    }
    try {
      var evObj = ev || {};
      var content = typeof evObj.content === "string" ? evObj.content : "";
      var cancelled = evObj.error === "cancelled" || evObj.cancelled === true;
      // 用户取消选择（或空内容）：静默 resolve(null)，不抛错、不弹错误提示
      if (cancelled || !content.trim()) {
        if (!cancelled) warn("插件文件内容为空或读取失败，已忽略");
        pending.resolve(null);
        return;
      }
      var fileName = trimStr(evObj.fileName || evObj.id);
      var looksJson = /\.json$/i.test(fileName) || /^\s*\{/.test(content);
      if (looksJson) {
        var obj;
        try {
          obj = JSON.parse(content);
        } catch (e2) {
          throw new Error("JSON 插件文件解析失败：" + errText(e2));
        }
        if (!isObj(obj)) throw new Error("JSON 插件文件格式不正确");
        if (typeof obj.code !== "string" || !obj.code.trim()) {
          throw new Error("JSON 插件文件需要包含 code 字段（格式：{id,name,version,code}）");
        }
        pending.resolve(
          installFromCode(obj.code, {
            id: obj.id,
            name: obj.name,
            version: obj.version,
            author: obj.author,
            description: obj.description,
            fileName: fileName
          })
        );
        return;
      }
      pending.resolve(installFromCode(content, { fileName: fileName }));
    } catch (e3) {
      pending.reject(e3 instanceof Error ? e3 : new Error(String(e3)));
    }
  }

  function installFromFile() {
    return new Promise(function (resolve, reject) {
      var B = getBridge();
      if (!B || !isFn(B.importPluginFile)) {
        reject(new Error("当前环境不支持选择插件文件（Bridge.importPluginFile 不可用）"));
        return;
      }
      if (pendingFileInstall) {
        reject(new Error("已有插件文件安装等待中，请先完成选择"));
        return;
      }
      ensureFileListener();
      var timer = setTimeout(function () {
        if (!pendingFileInstall) return;
        pendingFileInstall = null;
        reject(new Error("等待选择插件文件超时（" + Math.round(FILE_INSTALL_TIMEOUT / 1000) + " 秒）"));
      }, FILE_INSTALL_TIMEOUT);
      pendingFileInstall = { resolve: resolve, reject: reject, timer: timer };
      try {
        B.importPluginFile();
      } catch (e) {
        try {
          clearTimeout(timer);
        } catch (e2) {
          /* ignore */
        }
        pendingFileInstall = null;
        reject(new Error("打开文件选择器失败：" + errText(e)));
      }
    });
  }

  async function remove(id) {
    var def = registry[trimStr(id)];
    if (!def) throw new Error("插件不存在：" + id);
    if (def.builtin) throw new Error("内置插件不能删除（可以禁用）：" + id);
    var B = getBridge();
    if (!B || !isFn(B.pluginDelete)) {
      throw new Error("当前环境不支持删除插件（Bridge.pluginDelete 不可用）");
    }
    try {
      await Promise.resolve(B.pluginDelete(id));
    } catch (e) {
      throw new Error("删除插件失败：" + errText(e));
    }
    removeFromRegistry(id);
    removeEnabledFromStore(id);
    emitChange();
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 变更通知
   * ------------------------------------------------------------------ */
  function onChange(fn) {
    if (!isFn(fn)) return function () {};
    changeListeners.push(fn);
    var removed = false;
    return function () {
      if (removed) return;
      removed = true;
      var idx = changeListeners.indexOf(fn);
      if (idx >= 0) changeListeners.splice(idx, 1);
    };
  }

  function emitChange() {
    if (suppressChange > 0) return;
    buildToolIndex();
    var snapshot = list();
    for (var i = 0; i < changeListeners.length; i += 1) {
      try {
        changeListeners[i](snapshot, DSPlugins);
      } catch (e) {
        warn("onChange 回调异常：" + errText(e));
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 对外 API（SPEC §5.2）
   * ------------------------------------------------------------------ */
  DSPlugins = {
    VERSION: "1.0.0",
    register: register,
    list: list,
    get: get,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    loadExternal: loadExternal,
    toolSchemas: toolSchemas,
    runTool: runTool,
    runCommand: runCommand,
    runHook: runHook,
    installFromCode: installFromCode,
    installFromFile: installFromFile,
    remove: remove,
    onChange: onChange,
    emitChange: emitChange,
    // 辅助：供 app.js 构造插件上下文（可选）
    createContext: function (extra) {
      return makeCtx(null, extra);
    }
  };

  global.DSPlugins = DSPlugins;
})(typeof window !== "undefined" ? window : globalThis);
