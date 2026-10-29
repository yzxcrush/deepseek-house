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
   * ARCH v2 P1：原生事件 Promise 桥（tool-confirm / tool-result / otp-* / auth-changed）
   * DSHost.onEvent 收到这些事件时先 emit，再结算 waitForEvent 注册的 Promise。
   * ------------------------------------------------------------------ */

  var AGENT_EVENT_TYPES = {
    'tool-confirm': true,
    'tool-result': true,
    'otp-sent': true,
    'otp-verified': true,
    'auth-changed': true,
    'workspace-changed': true,
    /* ARCH v2 P2：MCP Client 事件 */
    'mcp-status': true,
    'mcp-tools': true,
    'mcp-progress': true
  };

  var eventWaiters = Object.create(null); // type -> [{predicate, finish}]

  function waitForEvent(type, predicate, timeoutMs) {
    var key = String(type);
    var timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 30000;
    return new Promise(function (resolve) {
      var done = false;
      var entry = null;
      function finish(evt) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        var arr = eventWaiters[key];
        if (arr) {
          var idx = arr.indexOf(entry);
          if (idx >= 0) arr.splice(idx, 1);
        }
        resolve(evt || null);
      }
      var timer = setTimeout(function () { finish(null); }, timeout);
      entry = {
        predicate: typeof predicate === 'function' ? predicate : function () { return true; },
        finish: finish
      };
      if (!eventWaiters[key]) eventWaiters[key] = [];
      eventWaiters[key].push(entry);
    });
  }

  function settleEventWaiters(type, evt) {
    var key = String(type);
    var arr = eventWaiters[key];
    if (!arr || !arr.length) return;
    var copy = arr.slice();
    for (var i = 0; i < copy.length; i++) {
      var entry = copy[i];
      var match = false;
      try { match = !!entry.predicate(evt); } catch (e) { match = false; }
      if (!match) continue;
      try { entry.finish(evt); } catch (e2) { /* ignore */ }
    }
  }

  /** 原生 P1 事件统一入口：emit 给监听者 + 结算 Promise（mock 与真实原生共用） */
  function dispatchAgentEvent(evt) {
    if (!evt || !evt.type) return;
    var type = String(evt.type);
    emit(type, evt);
    settleEventWaiters(type, evt);
  }

  function emitAgentLater(delay, evt) {
    setTimeout(function () { dispatchAgentEvent(evt); }, Math.max(0, Number(delay) || 0));
  }

  /** plugin-file 事件：分发给监听者，并 resolve importPluginFile() 的 Promise */
  function dispatchPluginFile(evt) {
    emit('plugin-file', evt);
    var waiters = mockFileWaiters.slice();
    mockFileWaiters.length = 0;
    for (var i = 0; i < waiters.length; i++) {
      try { waiters[i](evt); } catch (e) { /* ignore */ }
    }
  }

  /** v2.0 F3：file-imported 事件（备份 JSON）：分发给监听者，并 resolve importTextFile() 的 Promise */
  function dispatchFileImported(evt) {
    emit('file-imported', evt);
    var waiters = fileImportWaiters.slice();
    fileImportWaiters.length = 0;
    for (var i = 0; i < waiters.length; i++) {
      try { waiters[i](evt); } catch (e) { /* ignore */ }
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

  function hasNativeMethod(method) {
    if (!hasNative) return false;
    try { return typeof DSNative[method] === 'function'; } catch (e) { return false; }
  }

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
  var fileImportWaiters = []; // v2.0 F3：Bridge.importTextFile() 等待 file-imported 事件

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

  /* ------------------------------------------------------------------ *
   * ARCH v2 P1：原生 Agent / 工作区 / 审计 / 手机号认证 —— mock 实现
   * 触发条件：无 DSNative（浏览器/Node），或真实原生缺少对应新方法（旧版本兜底）。
   * 行为：内存文件树/审计/OTP，事件走 dispatchAgentEvent（与原生同构）。
   * ------------------------------------------------------------------ */

  var MOCK_WORKSPACE_ROOT = '/sdcard/house-workspace';
  var mockWorkspace = { root: MOCK_WORKSPACE_ROOT, writable: true, allFilesAccess: false };
  var mockAuth = { loggedIn: false, phone: '' };
  var mockOtp = null; // {phone, code, ttl, sentAt, attempts, lockedUntil}
  var mockPendingTools = Object.create(null); // requestId -> {name, args, risk}
  var mockConfirmedMidTools = Object.create(null); // MID 工具首次确认后记住
  var mockAudit = [];
  var mockAuditSeq = 0;
  var mockFileContents = {};
  var mockTree = {};

  function mockSeedFs() {
    mockFileContents = {};
    mockFileContents[MOCK_WORKSPACE_ROOT + '/README.md'] =
      '# house-workspace（mock）\n\nBridge mock 模式下的工作区示例文件。\n\n- read_file / list_dir：只读\n- write_file：MID，首次确认\n- run_shell：HIGH，每次确认\n';
    mockFileContents[MOCK_WORKSPACE_ROOT + '/notes.txt'] = 'mock 工作区笔记\n';
    mockFileContents[MOCK_WORKSPACE_ROOT + '/src/app.js'] = '// mock 源文件\nconsole.log("hello from mock workspace");\n';
    mockTree = {};
    mockTree[MOCK_WORKSPACE_ROOT] = [
      { name: 'README.md', path: MOCK_WORKSPACE_ROOT + '/README.md', isDir: false, size: mockFileContents[MOCK_WORKSPACE_ROOT + '/README.md'].length },
      { name: 'notes.txt', path: MOCK_WORKSPACE_ROOT + '/notes.txt', isDir: false, size: 13 },
      { name: 'src', path: MOCK_WORKSPACE_ROOT + '/src', isDir: true, size: 0 }
    ];
    mockTree[MOCK_WORKSPACE_ROOT + '/src'] = [
      { name: 'app.js', path: MOCK_WORKSPACE_ROOT + '/src/app.js', isDir: false, size: mockFileContents[MOCK_WORKSPACE_ROOT + '/src/app.js'].length }
    ];
  }
  mockSeedFs();

  /** 归一化为工作区内绝对路径；越界返回 null */
  function mockResolvePath(p) {
    var s = String(p === null || p === undefined ? '' : p).replace(/^\s+|\s+$/g, '');
    if (!s) return mockWorkspace.root;
    var abs = s.charAt(0) === '/' ? s : (mockWorkspace.root + '/' + s);
    var parts = abs.replace(/\/+/g, '/').split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!out.length) return null;
        out.pop();
        continue;
      }
      out.push(part);
    }
    var norm = '/' + out.join('/');
    if (norm !== mockWorkspace.root && norm.indexOf(mockWorkspace.root + '/') !== 0) return null;
    return norm;
  }

  function mockListDir(path) {
    var dir = mockResolvePath(path);
    if (!dir) return [];
    var list = mockTree[dir];
    if (!list) return [];
    return list.map(function (item) {
      return { name: item.name, path: item.path, isDir: !!item.isDir, size: Number(item.size) || 0 };
    });
  }

  function mockReadFileText(path) {
    var p = mockResolvePath(path);
    if (!p) return { ok: false, result: '路径不在工作区范围内', path: String(path === null || path === undefined ? '' : path) };
    if (Object.prototype.hasOwnProperty.call(mockFileContents, p)) {
      return { ok: true, result: mockFileContents[p], path: p };
    }
    return { ok: false, result: '文件不存在：' + (String(path === null || path === undefined ? '' : path) || p), path: p };
  }

  function mockUpsertTreeEntry(parent, entry) {
    if (!mockTree[parent]) mockTree[parent] = [];
    var list = mockTree[parent];
    for (var i = 0; i < list.length; i++) {
      if (list[i].path === entry.path) { list[i] = entry; return; }
    }
    list.push(entry);
  }

  function mockWriteFileText(path, content) {
    var p = mockResolvePath(path);
    if (!p) return { ok: false, result: '仅允许写入工作区内的文件' };
    if (p === mockWorkspace.root) return { ok: false, result: '不能写入工作区根目录' };
    var text = String(content === null || content === undefined ? '' : content);
    if (text.length > 1024 * 1024) return { ok: false, result: '文件超过 1MB 大小限制' };
    mockFileContents[p] = text;
    var idx = p.lastIndexOf('/');
    var parent = idx > 0 ? p.slice(0, idx) : '/';
    var name = p.slice(idx + 1);
    /* 自动补父目录（模拟原生自动建目录） */
    if (parent !== mockWorkspace.root && !mockTree[parent]) mockTree[parent] = [];
    mockUpsertTreeEntry(parent, { name: name, path: p, isDir: false, size: text.length });
    var dirs = parent.split('/').filter(function (x) { return !!x; });
    var cur = '';
    for (var d = 0; d < dirs.length; d++) {
      cur += '/' + dirs[d];
      if (cur === mockWorkspace.root) continue;
      var curParent = cur.slice(0, cur.lastIndexOf('/')) || '/';
      mockUpsertTreeEntry(curParent || mockWorkspace.root, { name: dirs[d], path: cur, isDir: true, size: 0 });
    }
    return { ok: true, result: '已写入 ' + p + '（' + text.length + ' 字符）' };
  }

  function mockRunShellText(command) {
    var cmd = String(command === null || command === undefined ? '' : command);
    var m = /^\s*echo\s+([\s\S]*)$/.exec(cmd);
    if (m) return { ok: true, result: m[1] };
    if (/^\s*pwd\s*$/.test(cmd)) return { ok: true, result: mockWorkspace.root };
    if (/^\s*(ls|dir)(\s|$)/.test(cmd)) {
      var items = mockListDir(mockWorkspace.root);
      return { ok: true, result: items.map(function (x) { return x.name + (x.isDir ? '/' : ''); }).join('\n') };
    }
    if (/^\s*(whoami|id)\s*$/.test(cmd)) return { ok: true, result: 'u0_a455 (mock)' };
    return { ok: true, result: '（mock 终端）cwd=' + mockWorkspace.root + '\n$ ' + cmd + '\n（mock 模式不会真正执行命令）' };
  }

  /** mock 原生工具 schema（与 native ToolRegistry 的内置工具同名同风险） */
  function mockToolSchemas() {
    return [
      {
        type: 'function', risk: 'low',
        function: {
          name: 'read_file',
          description: '读取工作区内的文本文件（≤256KB）',
          parameters: { type: 'object', properties: { path: { type: 'string', description: '工作区内文件路径' } }, required: ['path'] }
        }
      },
      {
        type: 'function', risk: 'low',
        function: {
          name: 'list_dir',
          description: '列出工作区目录内容',
          parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径，缺省为工作区根' } }, required: [] }
        }
      },
      {
        type: 'function', risk: 'mid',
        function: {
          name: 'write_file',
          description: '写入工作区内的文本文件（仅限工作区）',
          parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
        }
      },
      {
        type: 'function', risk: 'high',
        function: {
          name: 'run_shell',
          description: '在工作区执行 shell 命令（/system/bin/sh -c，超时 30s）',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
      },
      {
        type: 'function', risk: 'low',
        function: {
          name: 'http_get',
          description: '发起受限 https GET 请求（≤1MB）',
          parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
        }
      }
    ].concat(mockMcpSchemaList());
  }

  function mockFindTool(name) {
    var list = mockToolSchemas();
    var key = String(name === null || name === undefined ? '' : name);
    for (var i = 0; i < list.length; i++) {
      var fn = list[i].function || {};
      if (fn.name === key) return list[i];
    }
    return null;
  }

  function mockRiskOf(name) {
    var schema = mockFindTool(name);
    return schema && schema.risk ? String(schema.risk).toLowerCase() : 'high';
  }

  function mockExecNativeTool(name, args) {
    var key = String(name === null || name === undefined ? '' : name);
    var a = args && typeof args === 'object' ? args : {};
    switch (key) {
      case 'read_file':
        return mockReadFileText(a.path);
      case 'list_dir':
        return { ok: true, result: JSON.stringify(mockListDir(a.path === undefined || a.path === null ? '' : a.path)) };
      case 'write_file':
        return mockWriteFileText(a.path, a.content);
      case 'run_shell':
        return mockRunShellText(a.command);
      case 'http_get':
        return { ok: true, result: '（mock）http_get ' + String(a.url || '') + '\n{"status":200,"body":"(mock)"}' };
      default:
        return { ok: false, result: '未知原生工具：' + key };
    }
  }

  function mockAuditPush(tool, args, result, ok, confirmed) {
    mockAuditSeq++;
    var argsText;
    if (typeof args === 'string') argsText = args;
    else {
      try { argsText = JSON.stringify(args === undefined || args === null ? {} : args); } catch (e) { argsText = String(args); }
    }
    mockAudit.unshift({
      id: 'audit_' + mockAuditSeq,
      ts: Date.now(),
      tool: String(tool === null || tool === undefined ? '' : tool),
      args: argsText,
      result: String(result === null || result === undefined ? '' : result),
      ok: !!ok,
      confirmed: !!confirmed
    });
    if (mockAudit.length > 200) mockAudit.length = 200;
  }

  function mockWorkspaceInfo() {
    return {
      root: mockWorkspace.root,
      writable: !!mockWorkspace.writable,
      allFilesAccess: !!mockWorkspace.allFilesAccess,
      defaultRoot: MOCK_WORKSPACE_ROOT,
      isDefault: mockWorkspace.root === MOCK_WORKSPACE_ROOT,
      mock: true
    };
  }

  function mockAuthState() {
    return { loggedIn: !!mockAuth.loggedIn, phone: String(mockAuth.phone || '') };
  }

  function mockSetWorkspace(path) {
    var p = String(path === null || path === undefined ? '' : path).replace(/^\s+|\s+$/g, '');
    if (!p) return false;
    var abs = p.charAt(0) === '/' ? p.replace(/\/+$/, '') : ('/' + p.replace(/\/+$/, ''));
    mockWorkspace.root = abs || '/';
    mockWorkspace.writable = true;
    if (!mockTree[mockWorkspace.root]) mockTree[mockWorkspace.root] = [];
    return true;
  }

  /* ------------------------------------------------------------------ *
   * ARCH v2 P2：MCP Client —— mock 实现
   * 触发条件：无 DSNative，或原生缺少 mcp* 方法（旧版本/半 mock 联调）。
   * 2 个示例服务器 + 连接/断开/刷新 + 工具发现 + pack_apk 构建进度 10→100。
   * ------------------------------------------------------------------ */

  var MOCK_MCP_DEFAULT_SERVERS = [
    {
      id: 'mcp-termux',
      name: 'Termux 本地构建',
      url: 'http://127.0.0.1:8787/mcp',
      token: 'demo-token',
      enabled: true,
      builtin: true
    },
    {
      id: 'mcp-remote-demo',
      name: '示例远程 MCP',
      url: 'https://mcp.example.com/mcp',
      token: '',
      enabled: true,
      builtin: true
    }
  ];

  var MOCK_MCP_TOOLS = {
    'mcp-termux': [
      { name: 'pack_apk', description: '打包 APK（调用 Termux 项目 scripts/build.sh，返回 ok/apk_path/size/sha256/log）' },
      { name: 'decompile_apk', description: '反编译 APK（apktool d；未安装时返回提示）' },
      { name: 'repack_apk', description: '回编译并签名 APK（apktool b + apksigner）' },
      { name: 'run_gradle', description: '执行 Gradle 任务（./gradlew <task>）' },
      { name: 'list_workspace', description: '列出 Termux 工作区目录内容' }
    ],
    'mcp-remote-demo': [
      { name: 'echo', description: '回显传入的文本' },
      { name: 'get_time', description: '返回服务器当前时间（ISO）' }
    ]
  };

  var MOCK_MCP_PROGRESS_STEPS = [
    { percent: 10, line: '准备构建环境…' },
    { percent: 25, line: '读取项目配置…' },
    { percent: 45, line: 'aapt 打包资源…' },
    { percent: 65, line: 'javac 编译 Java…' },
    { percent: 80, line: 'd8 生成 dex…' },
    { percent: 92, line: 'apksigner 签名…' },
    { percent: 100, line: '构建完成' }
  ];

  var mockMcpServers = [];
  var mockMcpStatus = Object.create(null); // id -> {status,message,tools:[{name,description}]}
  var mockMcpTimers = Object.create(null); // id -> 连接定时器

  function mockSeedMcp() {
    mockMcpServers = MOCK_MCP_DEFAULT_SERVERS.map(function (s) {
      return { id: s.id, name: s.name, url: s.url, token: s.token, enabled: s.enabled !== false, builtin: !!s.builtin };
    });
    mockMcpStatus = Object.create(null);
    mockMcpTimers = Object.create(null);
    for (var i = 0; i < mockMcpServers.length; i++) {
      mockMcpStatus[mockMcpServers[i].id] = { status: 'disconnected', message: '', tools: [] };
    }
  }
  mockSeedMcp();

  function mockMcpFindServer(id) {
    var key = String(id === null || id === undefined ? '' : id);
    for (var i = 0; i < mockMcpServers.length; i++) if (mockMcpServers[i].id === key) return mockMcpServers[i];
    return null;
  }

  function mockMcpStatusOf(id) {
    var key = String(id === null || id === undefined ? '' : id);
    if (!mockMcpStatus[key]) mockMcpStatus[key] = { status: 'disconnected', message: '', tools: [] };
    return mockMcpStatus[key];
  }

  function mockMcpToolsFor(id) {
    var list = MOCK_MCP_TOOLS[String(id === null || id === undefined ? '' : id)] || [];
    return list.map(function (t) { return { name: t.name, description: t.description }; });
  }

  /** 已连接服务器的工具（[{serverId,name,description}]） */
  function mockMcpConnectedTools() {
    var out = [];
    for (var i = 0; i < mockMcpServers.length; i++) {
      var server = mockMcpServers[i];
      if (mockMcpStatusOf(server.id).status !== 'connected') continue;
      var tools = mockMcpToolsFor(server.id);
      for (var j = 0; j < tools.length; j++) {
        out.push({ serverId: server.id, name: tools[j].name, description: tools[j].description });
      }
    }
    return out;
  }

  function mockMcpToolBaseName(name) {
    var raw = String(name === null || name === undefined ? '' : name);
    if (raw.indexOf('mcp:') === 0) {
      var parts = raw.split(':');
      if (parts.length >= 3) return parts[parts.length - 1];
    }
    return raw;
  }

  /** 按 name（或 mcp:<serverId>:<name> 形式）查找已连接的 MCP 工具 */
  function mockMcpFindTool(name) {
    var key = String(name === null || name === undefined ? '' : name);
    var list = mockMcpConnectedTools();
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === key) return list[i];
      if (('mcp:' + list[i].serverId + ':' + list[i].name) === key) return list[i];
    }
    return null;
  }

  /** MCP 工具 schema（risk=MID，needConfirm=true；注册语义与原生 ToolRegistry 一致） */
  function mockMcpSchemaList() {
    var list = mockMcpConnectedTools();
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var tool = list[i];
      if (seen[tool.name]) continue;
      seen[tool.name] = true;
      out.push({
        type: 'function',
        risk: 'mid',
        mcp: { serverId: tool.serverId },
        function: {
          name: tool.name,
          description: tool.description || ('MCP 工具 ' + tool.name),
          parameters: { type: 'object', properties: {}, required: [] }
        }
      });
    }
    return out;
  }

  function mockMcpEmitStatus(id, status, message) {
    emitAgentLater(10, {
      type: 'mcp-status',
      id: String(id === null || id === undefined ? '' : id),
      status: String(status || 'disconnected'),
      message: message === null || message === undefined ? '' : String(message)
    });
  }

  function mockMcpEmitTools(id) {
    var tools = mockMcpToolsFor(id);
    mockMcpStatusOf(id).tools = tools;
    emitAgentLater(10, {
      type: 'mcp-tools',
      id: String(id === null || id === undefined ? '' : id),
      tools: tools.map(function (t) { return { name: t.name, description: t.description }; })
    });
  }

  function mockMcpConnect(id) {
    var server = mockMcpFindServer(id);
    if (!server) return false;
    var st = mockMcpStatusOf(server.id);
    if (mockMcpTimers[server.id]) { clearTimeout(mockMcpTimers[server.id]); mockMcpTimers[server.id] = 0; }
    st.status = 'connecting';
    st.message = '';
    mockMcpEmitStatus(server.id, 'connecting', '正在连接 MCP 服务器…');
    mockMcpTimers[server.id] = setTimeout(function () {
      mockMcpTimers[server.id] = 0;
      var cur = mockMcpStatusOf(server.id);
      if (cur.status !== 'connecting') return; /* 期间断开/删除 */
      cur.status = 'connected';
      cur.message = '';
      mockMcpEmitStatus(server.id, 'connected', '已连接（mock）');
      mockMcpEmitTools(server.id);
    }, 160);
    return true;
  }

  function mockMcpDisconnect(id) {
    var server = mockMcpFindServer(id);
    if (!server) return false;
    if (mockMcpTimers[server.id]) { clearTimeout(mockMcpTimers[server.id]); mockMcpTimers[server.id] = 0; }
    var st = mockMcpStatusOf(server.id);
    st.status = 'disconnected';
    st.message = '';
    st.tools = [];
    mockMcpEmitStatus(server.id, 'disconnected', '已断开连接');
    emitAgentLater(20, { type: 'mcp-tools', id: server.id, tools: [] });
    return true;
  }

  function mockMcpRefreshTools(id) {
    var server = mockMcpFindServer(id);
    if (!server) return false;
    var st = mockMcpStatusOf(server.id);
    if (st.status === 'connected') {
      mockMcpEmitTools(server.id);
      return true;
    }
    emitAgentLater(10, {
      type: 'mcp-status',
      id: server.id,
      status: st.status || 'disconnected',
      message: '未连接，请先连接后再刷新工具'
    });
    return true;
  }

  function mockMcpSave(payload) {
    var data = payload && typeof payload === 'object' ? payload : {};
    var name = String(data.name === null || data.name === undefined ? '' : data.name).replace(/^\s+|\s+$/g, '');
    var url = String(data.url === null || data.url === undefined ? '' : data.url).replace(/^\s+|\s+$/g, '');
    if (!name) return false;
    if (!/^https?:\/\/\S+/i.test(url)) return false;
    var id = data.id ? String(data.id) : ('mcp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5));
    var existing = mockMcpFindServer(id);
    if (existing) {
      existing.name = name;
      existing.url = url;
      existing.token = data.token === undefined || data.token === null ? existing.token : String(data.token);
      existing.enabled = data.enabled !== false;
    } else {
      mockMcpServers.push({
        id: id,
        name: name,
        url: url,
        token: data.token === undefined || data.token === null ? '' : String(data.token),
        enabled: data.enabled !== false
      });
      mockMcpStatus[id] = { status: 'disconnected', message: '', tools: [] };
    }
    return true;
  }

  function mockMcpDelete(id) {
    var server = mockMcpFindServer(id);
    if (!server) return false;
    var idx = mockMcpServers.indexOf(server);
    if (idx >= 0) mockMcpServers.splice(idx, 1);
    if (mockMcpTimers[server.id]) { clearTimeout(mockMcpTimers[server.id]); delete mockMcpTimers[server.id]; }
    delete mockMcpStatus[server.id];
    return true;
  }

  function mockMcpServersJson() {
    return mockMcpServers.map(function (server) {
      var st = mockMcpStatusOf(server.id);
      return {
        id: server.id,
        name: server.name,
        url: server.url,
        token: server.token,
        enabled: server.enabled !== false,
        builtin: !!server.builtin,
        status: st.status,
        tools: (st.tools || []).map(function (t) { return { name: t.name, description: t.description }; })
      };
    });
  }

  function mockMcpBuildResult(name, args) {
    var a = args && typeof args === 'object' ? args : {};
    var out = { ok: true, tool: name, log: '（mock）' + name + ' 执行完成' };
    if (name === 'pack_apk') {
      out.apk_path = '/sdcard/house-workspace/build/deepseek-house-mock.apk';
      out.size = 1234567;
      out.sha256 = 'mock-sha256-0123456789abcdef';
    } else if (name === 'decompile_apk') {
      out.out_dir = '/sdcard/house-workspace/build/decompiled';
    } else if (name === 'repack_apk') {
      out.apk_path = '/sdcard/house-workspace/build/repacked-mock.apk';
    } else if (name === 'run_gradle') {
      out.task = String(a.task || 'assembleDebug');
      out.tail = 'BUILD SUCCESSFUL（mock）';
    }
    try { return JSON.stringify(out, null, 2); } catch (e) { return '{"ok":true}'; }
  }

  function mockMcpToolResult(name, args) {
    var base = mockMcpToolBaseName(name);
    var a = args && typeof args === 'object' ? args : {};
    if (base === 'list_workspace') {
      return JSON.stringify(mockListDir(a.path === undefined || a.path === null ? '' : a.path));
    }
    if (base === 'echo') return String(a.text === undefined || a.text === null ? '(echo)' : a.text);
    if (base === 'get_time') return new Date().toISOString();
    if (base === 'pack_apk' || base === 'decompile_apk' || base === 'repack_apk' || base === 'run_gradle') {
      return mockMcpBuildResult(base, a);
    }
    return '（mock MCP 工具）' + name + ' 执行完成';
  }

  function mockMcpIsBuildTool(name) {
    var base = mockMcpToolBaseName(name);
    return base === 'pack_apk' || base === 'decompile_apk' || base === 'repack_apk' || base === 'run_gradle';
  }

  /** mock MCP 工具执行：构建类按 MOCK_MCP_PROGRESS_STEPS 发 mcp-progress 10→100，再回 tool-result */
  function mockExecMcpToolFlow(requestId, pending) {
    var rid = String(requestId);
    var name = pending.name;
    var args = pending.args && typeof pending.args === 'object' ? pending.args : {};
    var confirmed = !!pending.confirmed;
    var meta = mockMcpFindTool(name);
    var serverId = pending.serverId || (meta ? meta.serverId : '');
    if (!meta) {
      mockAuditPush(name, args, 'MCP 工具不可用', false, confirmed);
      emitAgentLater(15, {
        type: 'tool-result',
        requestId: rid,
        tool: name,
        ok: false,
        result: 'MCP 工具不可用（服务器未连接）：' + name,
        confirmed: confirmed,
        serverId: serverId
      });
      return;
    }
    if (!mockMcpIsBuildTool(name)) {
      var text = mockMcpToolResult(name, args);
      mockAuditPush(name, args, text, true, confirmed);
      emitAgentLater(40, {
        type: 'tool-result',
        requestId: rid,
        tool: name,
        ok: true,
        result: String(text),
        confirmed: confirmed,
        serverId: serverId
      });
      return;
    }
    var idx = 0;
    function step() {
      if (idx >= MOCK_MCP_PROGRESS_STEPS.length) {
        var out = mockMcpBuildResult(mockMcpToolBaseName(name), args);
        mockAuditPush(name, args, out, true, confirmed);
        emitAgentLater(20, {
          type: 'tool-result',
          requestId: rid,
          tool: name,
          ok: true,
          result: String(out),
          confirmed: confirmed,
          serverId: serverId
        });
        return;
      }
      var st = MOCK_MCP_PROGRESS_STEPS[idx++];
      emitAgentLater(idx === 1 ? 10 : 85, {
        type: 'mcp-progress',
        id: serverId,
        tool: name,
        percent: st.percent,
        line: st.line
      });
      setTimeout(step, 90);
    }
    step();
  }

  /** 执行一条已确认（或无需确认）的 mock 工具调用：内置 native 工具 / MCP 工具二选一 */
  function mockExecutePendingTool(rid) {
    var pending = mockPendingTools[rid];
    if (!pending) return false;
    delete mockPendingTools[rid];
    if (mockMcpFindTool(pending.name)) {
      mockExecMcpToolFlow(rid, pending);
      return true;
    }
    var outcome = mockExecNativeTool(pending.name, pending.args || {});
    mockAuditPush(pending.name, pending.args || {}, outcome.result, outcome.ok, !!pending.confirmed);
    emitAgentLater(18, {
      type: 'tool-result',
      requestId: String(rid),
      tool: pending.name,
      ok: !!outcome.ok,
      result: String(outcome.result === null || outcome.result === undefined ? '' : outcome.result),
      confirmed: !!pending.confirmed
    });
    return true;
  }

  /** mock 下模拟「同一 requestId 的 execTool → tool-confirm → tool-result」完整事件流 */
  function mockExecToolFlow(requestId, name, argsJson) {
    var rid = String(requestId);
    var toolName = String(name === null || name === undefined ? '' : name);
    var args = parseJSON(argsJson, {}) || {};
    var mcp = mockMcpFindTool(toolName);
    var schema = mockFindTool(toolName);
    /* 名称未知：直接失败结果，避免调用方一直等 */
    if (!schema && !mcp) {
      mockAuditPush(toolName, args, '未知工具', false, false);
      emitAgentLater(10, { type: 'tool-result', requestId: rid, tool: toolName, ok: false, result: '未知原生工具：' + toolName, confirmed: false });
      return true;
    }
    var risk = mcp ? 'mid' : mockRiskOf(toolName);
    var needConfirm;
    if (risk === 'high') needConfirm = true;
    else if (risk === 'mid') needConfirm = !mockConfirmedMidTools[toolName];
    else needConfirm = false;
    mockPendingTools[rid] = {
      name: toolName,
      args: args,
      risk: risk,
      confirmed: false,
      serverId: mcp ? mcp.serverId : ''
    };
    if (needConfirm) {
      emitAgentLater(10, {
        type: 'tool-confirm',
        requestId: rid,
        tool: toolName,
        args: args,
        risk: risk,
        needConfirm: true
      });
      return true;
    }
    mockExecutePendingTool(rid);
    return true;
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
    '      name: "mockroll",',
    '      description: "掷骰子，例如 /mockroll 6",',
    '      usage: "/mockroll 6",',
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

  /* ------------------------------------------------------------------ *
   * ARCH v2 P1：返回值归一化 / Promise 辅助
   * ------------------------------------------------------------------ */

  var p1Seq = 0;
  var p1Errors = Object.create(null); // method -> 最近一次原生错误信息（listDir/workspaceInfo）

  function genP1RequestId(prefix) {
    p1Seq++;
    return (prefix || 'p1') + '_' + Date.now().toString(36) + '_' + p1Seq + '_' +
      Math.random().toString(36).slice(2, 7);
  }

  function normalizeWorkspaceInfo(raw) {
    var out = { root: '', writable: false, allFilesAccess: false };
    if (!raw || typeof raw !== 'object' || raw.error) return out;
    if (raw.root !== undefined && raw.root !== null) out.root = String(raw.root);
    out.writable = !!raw.writable;
    out.allFilesAccess = !!raw.allFilesAccess;
    /* 原生补充字段（SPEC 未定义）：defaultRoot/isDefault 用于设置页「恢复默认工作区」 */
    if (raw.defaultRoot !== undefined && raw.defaultRoot !== null) out.defaultRoot = String(raw.defaultRoot);
    if (raw.isDefault !== undefined) out.isDefault = !!raw.isDefault;
    else if (out.defaultRoot) out.isDefault = out.root === out.defaultRoot;
    return out;
  }

  function normalizeDirEntries(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      if (!item || typeof item !== 'object') continue;
      var name = item.name === undefined || item.name === null ? '' : String(item.name);
      if (!name) continue;
      out.push({
        name: name,
        path: item.path === undefined || item.path === null ? '' : String(item.path),
        isDir: !!item.isDir,
        size: Number(item.size) || 0
      });
    }
    return out;
  }

  function normalizeAuditList(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      if (!item || typeof item !== 'object') continue;
      var argsText;
      if (item.args === undefined || item.args === null) argsText = '';
      else if (typeof item.args === 'string') argsText = item.args;
      else {
        try { argsText = JSON.stringify(item.args); } catch (e) { argsText = String(item.args); }
      }
      out.push({
        id: item.id === undefined || item.id === null ? '' : String(item.id),
        ts: Number(item.ts) || 0,
        tool: item.tool === undefined || item.tool === null ? '' : String(item.tool),
        args: argsText,
        result: item.result === undefined || item.result === null ? '' : String(item.result),
        ok: item.ok !== false,
        confirmed: !!item.confirmed
      });
    }
    return out;
  }

  function normalizeAuthState(raw) {
    if (!raw || typeof raw !== 'object' || raw.error) return { loggedIn: false, phone: '' };
    return {
      loggedIn: !!raw.loggedIn,
      phone: raw.phone === undefined || raw.phone === null ? '' : String(raw.phone)
    };
  }

  /* ARCH v2 P2：MCP 配置/工具返回值归一化 */
  function normalizeMcpTools(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      if (!item || typeof item !== 'object') continue;
      var name = item.name === undefined || item.name === null ? '' : String(item.name);
      if (!name) continue;
      out.push({
        name: name,
        description: item.description === undefined || item.description === null ? '' : String(item.description)
      });
    }
    return out;
  }

  function normalizeMcpServers(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      if (!item || typeof item !== 'object') continue;
      var id = item.id === undefined || item.id === null ? '' : String(item.id);
      if (!id) continue;
      var server = {
        id: id,
        name: item.name === undefined || item.name === null ? id : String(item.name),
        url: item.url === undefined || item.url === null ? '' : String(item.url),
        token: item.token === undefined || item.token === null ? '' : String(item.token),
        enabled: item.enabled !== false
      };
      if (item.builtin) server.builtin = true;
      /* 原生 serversJson 附带的状态字段（status/message/toolCount/connected） */
      if (item.status !== undefined && item.status !== null) server.status = String(item.status);
      if (item.message !== undefined && item.message !== null) server.message = String(item.message);
      if (item.connected !== undefined) server.connected = !!item.connected;
      if (Array.isArray(item.tools)) server.tools = normalizeMcpTools(item.tools);
      if (item.toolCount !== undefined) server.toolCount = parseInt(item.toolCount, 10) || 0;
      out.push(server);
    }
    return out;
  }

  var Bridge = {
    __isMock: !hasNative,
    __native: hasNative,
    __mockConfig: { chunkDelay: 14, validateDelay: 180, otpCode: '123456', otpTtlSeconds: 300 },
    /** v2.0 F3：mock 模式下 Bridge.importTextFile() 返回的备份内容（QA/浏览器自测用） */
    __mockImportPayload: null,
    __setMockImport: function (name, content) {
      Bridge.__mockImportPayload = { name: String(name || 'mock-backup.json'), content: String(content || '') };
      return Bridge.__mockImportPayload;
    },
    __clearMockImport: function () {
      Bridge.__mockImportPayload = null;
    },

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
            dispatchPluginFile({
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

    /**
     * v2.0 F3：选择备份 JSON 文件（原生 ACTION_OPEN_DOCUMENT）。立即返回 Promise，
     * 由原生事件 {type:'file-imported', name, content, error?} 或 mock 数据 resolve。
     * 取消时 resolve {content:'', error:'cancelled'}（调用方静默处理）。
     */
    importTextFile: function () {
      return new Promise(function (resolve) {
        var done = false;
        function finish(evt) {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          var idx = fileImportWaiters.indexOf(waiter);
          if (idx >= 0) fileImportWaiters.splice(idx, 1);
          resolve(evt || null);
        }
        var timer = setTimeout(function () { finish(null); }, 120000);
        var waiter = function (evt) { finish(evt); };
        fileImportWaiters.push(waiter);
        if (!hasNative) {
          setTimeout(function () {
            var payload = Bridge.__mockImportPayload;
            if (payload && (payload.content || payload.error)) {
              dispatchFileImported({
                type: 'file-imported',
                name: String(payload.name || 'mock-backup.json'),
                content: String(payload.content || ''),
                error: payload.error || null
              });
            } else {
              dispatchFileImported({
                type: 'file-imported',
                name: '',
                content: '',
                error: 'cancelled'
              });
            }
          }, 120);
          return;
        }
        try {
          if (typeof DSNative.importTextFile !== 'function') {
            warn('原生缺少 importTextFile');
            finish(null);
            return;
          }
          DSNative.importTextFile();
        } catch (e) {
          warn('importTextFile 失败：' + (e && e.message));
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

    shareText: function (title, text) {
      var subject = String(title === null || title === undefined ? '' : title);
      var body = String(text === null || text === undefined ? '' : text);
      if (!hasNative) {
        mockClipboard = body;
        return true;
      }
      try {
        if (typeof DSNative.shareText === 'function') DSNative.shareText(subject, body);
        return true;
      } catch (e) { warn('shareText 失败：' + (e && e.message)); return false; }
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
    },

    /* ------------------------------------------------------------------ *
     * ARCH v2 P1/P2：原生 Agent 工具框架（内置工具 + MCP 远程工具）
     * ------------------------------------------------------------------ */
    toolSchemas: function () {
      if (hasNative && hasNativeMethod('toolSchemas')) {
        var raw = callNative('toolSchemas', [], true);
        var list = Array.isArray(raw)
          ? raw.filter(function (t) { return !!(t && t.function && t.function.name); })
          : [];
        /* 半 mock 联调：原生没有 MCP 方法时，把 Bridge mock 已连接的 MCP 工具补进 tools */
        if (!hasNativeMethod('mcpServers')) {
          var names = Object.create(null);
          for (var i = 0; i < list.length; i++) names[String(list[i].function.name)] = true;
          var extra = mockMcpSchemaList();
          for (var j = 0; j < extra.length; j++) {
            var en = String(extra[j].function.name);
            if (names[en]) continue;
            names[en] = true;
            list.push(extra[j]);
          }
        }
        return list;
      }
      return mockToolSchemas();
    },

    execTool: function (requestId, name, argsJson) {
      var rid = String(requestId === null || requestId === undefined ? '' : requestId);
      if (!rid) return false;
      var toolName = String(name === null || name === undefined ? '' : name);
      var argsStr;
      if (typeof argsJson === 'string') argsStr = argsJson;
      else {
        try { argsStr = JSON.stringify(argsJson === undefined || argsJson === null ? {} : argsJson); } catch (e) { argsStr = '{}'; }
      }
      /* 原生没有 MCP 方法（旧原生/半 mock），且工具来自 Bridge mock MCP：走 mock 执行（含进度事件） */
      if (mockMcpFindTool(toolName) && !(hasNative && hasNativeMethod('mcpServers'))) {
        return mockExecToolFlow(rid, toolName, argsStr);
      }
      if (hasNative && hasNativeMethod('execTool')) {
        try {
          DSNative.execTool(rid, toolName, argsStr);
          return true;
        } catch (e) {
          warn('execTool 失败：' + (e && e.message));
          return false;
        }
      }
      return mockExecToolFlow(rid, toolName, argsStr);
    },

    confirmTool: function (requestId, allow) {
      var rid = String(requestId === null || requestId === undefined ? '' : requestId);
      if (!rid) return false;
      /* 半 mock 联调：execTool 被 Bridge mock 接管（如 mock MCP 工具）时，确认也必须回到 mock */
      var pending = mockPendingTools[rid];
      if (!pending && hasNative && hasNativeMethod('confirmTool')) {
        try {
          DSNative.confirmTool(rid, !!allow);
          return true;
        } catch (e) {
          warn('confirmTool 失败：' + (e && e.message));
          return false;
        }
      }
      if (!pending) return false;
      if (!allow) {
        delete mockPendingTools[rid];
        mockAuditPush(pending.name, pending.args || {}, '用户拒绝执行', false, false);
        emitAgentLater(12, {
          type: 'tool-result',
          requestId: rid,
          tool: pending.name,
          ok: false,
          result: '用户拒绝执行',
          confirmed: false,
          serverId: pending.serverId || ''
        });
        return true;
      }
      pending.confirmed = true;
      if (String(pending.risk) === 'mid') mockConfirmedMidTools[pending.name] = true;
      return mockExecutePendingTool(rid);
    },

    /* ------------------------------------------------------------------ *
     * ARCH v2 P1：工作区 / 文件 / 终端 / 审计
     * ------------------------------------------------------------------ */
    workspaceInfo: function () {
      if (hasNative && hasNativeMethod('workspaceInfo')) {
        var raw = callNative('workspaceInfo', [], true);
        if (raw && typeof raw === 'object' && !raw.error) {
          delete p1Errors.workspaceInfo;
          return normalizeWorkspaceInfo(raw);
        }
        p1Errors.workspaceInfo = raw && raw.error ? String(raw.error) : 'workspaceInfo 返回异常';
        return { root: '', writable: false, allFilesAccess: false };
      }
      return mockWorkspaceInfo();
    },

    listDir: function (path) {
      var p = path === null || path === undefined ? '' : String(path);
      if (hasNative && hasNativeMethod('listDir')) {
        var raw = callNative('listDir', [p], true);
        /* SPEC：失败返回 {"error":..}（非数组）→ 兼容为 []，错误可通过 getLastError 取 */
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.error) {
          p1Errors.listDir = String(raw.error);
          return [];
        }
        delete p1Errors.listDir;
        return normalizeDirEntries(raw);
      }
      return mockListDir(p);
    },

    /** 最近一次原生错误（kind 省略时返回对象副本；用于 listDir/workspaceInfo 失败提示） */
    getLastError: function (kind) {
      if (kind === undefined || kind === null || kind === '') {
        var out = {};
        var keys = Object.keys(p1Errors);
        for (var i = 0; i < keys.length; i++) out[keys[i]] = p1Errors[keys[i]];
        return out;
      }
      return p1Errors[String(kind)] || '';
    },

    readFile: function (requestId, path) {
      var rid = String(requestId === null || requestId === undefined ? '' : requestId);
      if (!rid) return false;
      var p = String(path === null || path === undefined ? '' : path);
      if (hasNative && hasNativeMethod('readFile')) {
        try {
          DSNative.readFile(rid, p);
          return true;
        } catch (e) {
          warn('readFile 失败：' + (e && e.message));
          return false;
        }
      }
      var out = mockReadFileText(p);
      mockAuditPush('read_file', { path: p }, out.result, out.ok, false);
      emitAgentLater(8, {
        type: 'tool-result',
        requestId: rid,
        tool: 'read_file',
        ok: out.ok,
        result: String(out.result === null || out.result === undefined ? '' : out.result),
        confirmed: false
      });
      return true;
    },

    writeFile: function (requestId, path, content) {
      var rid = String(requestId === null || requestId === undefined ? '' : requestId);
      if (!rid) return false;
      var p = String(path === null || path === undefined ? '' : path);
      var text = content === null || content === undefined ? '' : String(content);
      if (hasNative && hasNativeMethod('writeFile')) {
        try {
          DSNative.writeFile(rid, p, text);
          return true;
        } catch (e) {
          warn('writeFile 失败：' + (e && e.message));
          return false;
        }
      }
      var out = mockWriteFileText(p, text);
      mockAuditPush('write_file', { path: p, content: text }, out.result, out.ok, false);
      emitAgentLater(8, {
        type: 'tool-result',
        requestId: rid,
        tool: 'write_file',
        ok: out.ok,
        result: String(out.result === null || out.result === undefined ? '' : out.result),
        confirmed: false
      });
      return true;
    },

    runShell: function (requestId, command) {
      var rid = String(requestId === null || requestId === undefined ? '' : requestId);
      if (!rid) return false;
      var cmd = String(command === null || command === undefined ? '' : command);
      if (hasNative && hasNativeMethod('runShell')) {
        try {
          DSNative.runShell(rid, cmd);
          return true;
        } catch (e) {
          warn('runShell 失败：' + (e && e.message));
          return false;
        }
      }
      var out = mockRunShellText(cmd);
      mockAuditPush('run_shell', { command: cmd }, out.result, out.ok, false);
      emitAgentLater(10, {
        type: 'tool-result',
        requestId: rid,
        tool: 'run_shell',
        ok: out.ok,
        result: String(out.result === null || out.result === undefined ? '' : out.result),
        confirmed: false
      });
      return true;
    },

    auditRecent: function (limit) {
      var n = parseInt(limit, 10);
      if (!(n > 0)) n = 50;
      if (n > 200) n = 200;
      if (hasNative && hasNativeMethod('auditRecent')) {
        var raw = callNative('auditRecent', [n], true);
        return normalizeAuditList(raw);
      }
      return normalizeAuditList(mockAudit.slice(0, n));
    },

    setWorkspace: function (path) {
      var p = String(path === null || path === undefined ? '' : path).replace(/^\s+|\s+$/g, '');
      if (!p) return false;
      if (hasNative && hasNativeMethod('setWorkspace')) {
        try {
          DSNative.setWorkspace(p);
          return true;
        } catch (e) {
          warn('setWorkspace 失败：' + (e && e.message));
          return false;
        }
      }
      var ok = mockSetWorkspace(p);
      if (ok) {
        emitAgentLater(10, {
          type: 'workspace-changed',
          ok: true,
          root: mockWorkspace.root,
          message: '工作区已切换',
          allFilesAccess: !!mockWorkspace.allFilesAccess
        });
      }
      return ok;
    },

    /** 补充（arch-native）：{"granted","root"}；旧原生/ mock 返回内存态 */
    allFilesAccess: function () {
      if (hasNative && hasNativeMethod('allFilesAccess')) {
        var raw = callNative('allFilesAccess', [], true);
        if (raw && typeof raw === 'object' && !raw.error) {
          return { granted: !!raw.granted, root: raw.root === undefined || raw.root === null ? '' : String(raw.root) };
        }
        return { granted: false, root: '' };
      }
      return { granted: !!mockWorkspace.allFilesAccess, root: mockWorkspace.root };
    },

    /** 补充（arch-native）：打开系统「所有文件访问权限」设置页 */
    openAllFilesAccessSettings: function () {
      if (hasNative && hasNativeMethod('openAllFilesAccessSettings')) {
        try { DSNative.openAllFilesAccessSettings(); return true; } catch (e) { warn('openAllFilesAccessSettings 失败：' + (e && e.message)); return false; }
      }
      warn('mock 模式：跳过打开「所有文件访问权限」设置页');
      return false;
    },

    /* ------------------------------------------------------------------ *
     * ARCH v2 P1：手机号登录（本地 OTP MVP）
     * ------------------------------------------------------------------ */
    requestOtp: function (phone) {
      var p = String(phone === null || phone === undefined ? '' : phone).replace(/[\s-]/g, '');
      if (!/^\+?\d{6,20}$/.test(p)) return false;
      if (hasNative && hasNativeMethod('requestOtp')) {
        try {
          DSNative.requestOtp(p);
          return true;
        } catch (e) {
          warn('requestOtp 失败：' + (e && e.message));
          return false;
        }
      }
      var now = Date.now();
      var cfg = Bridge.__mockConfig || {};
      var ttl = Number(cfg.otpTtlSeconds) || 300;
      var demoCode = String(cfg.otpCode || '123456');
      if (mockOtp && mockOtp.phone === p && now - mockOtp.sentAt < 60000) {
        emitAgentLater(10, {
          type: 'otp-sent',
          phone: p,
          ok: false,
          ttlSeconds: 0,
          demoCode: '',
          message: '发送过于频繁，请稍后重试'
        });
        return true;
      }
      mockOtp = { phone: p, code: demoCode, ttl: ttl, sentAt: now, attempts: 0, lockedUntil: 0 };
      emitAgentLater(20, { type: 'otp-sent', phone: p, ok: true, ttlSeconds: ttl, demoCode: demoCode, message: '' });
      return true;
    },

    verifyOtp: function (requestId, phone, code) {
      var rid = String(requestId === null || requestId === undefined ? '' : requestId);
      if (!rid) return false;
      var p = String(phone === null || phone === undefined ? '' : phone).replace(/[\s-]/g, '');
      var c = String(code === null || code === undefined ? '' : code).replace(/\s/g, '');
      if (hasNative && hasNativeMethod('verifyOtp')) {
        try {
          DSNative.verifyOtp(rid, p, c);
          return true;
        } catch (e) {
          warn('verifyOtp 失败：' + (e && e.message));
          return false;
        }
      }
      var now = Date.now();
      var fail = function (message) {
        emitAgentLater(10, { type: 'otp-verified', requestId: rid, ok: false, message: message });
      };
      if (!mockOtp || mockOtp.phone !== p) { fail('请先获取验证码'); return true; }
      if (mockOtp.lockedUntil && now < mockOtp.lockedUntil) { fail('验证码错误次数过多，请 5 分钟后再试'); return true; }
      if (now - mockOtp.sentAt > mockOtp.ttl * 1000) { fail('验证码已过期，请重新发送'); return true; }
      if (c !== mockOtp.code) {
        mockOtp.attempts = (mockOtp.attempts || 0) + 1;
        if (mockOtp.attempts >= 3) {
          mockOtp.lockedUntil = now + 5 * 60 * 1000;
          fail('验证码错误次数过多，请 5 分钟后再试');
        } else {
          fail('验证码错误，还可尝试 ' + (3 - mockOtp.attempts) + ' 次');
        }
        return true;
      }
      mockAuth = { loggedIn: true, phone: p };
      mockOtp = null;
      emitAgentLater(10, { type: 'otp-verified', requestId: rid, ok: true, message: '' });
      emitAgentLater(20, { type: 'auth-changed', loggedIn: true, phone: p });
      return true;
    },

    authState: function () {
      if (hasNative && hasNativeMethod('authState')) {
        var raw = callNative('authState', [], true);
        if (raw && typeof raw === 'object' && !raw.error) return normalizeAuthState(raw);
        return { loggedIn: false, phone: '' };
      }
      return mockAuthState();
    },

    logout: function () {
      if (hasNative && hasNativeMethod('logout')) {
        try {
          DSNative.logout();
          return true;
        } catch (e) {
          warn('logout 失败：' + (e && e.message));
          return false;
        }
      }
      mockAuth = { loggedIn: false, phone: '' };
      mockOtp = null;
      emitAgentLater(10, { type: 'auth-changed', loggedIn: false, phone: '' });
      return true;
    },

    /* ------------------------------------------------------------------ *
     * ARCH v2 P2：MCP Client（配置 CRUD / 连接管理 / 工具刷新）
     * 事件：mcp-status / mcp-tools / mcp-progress（native JsBridge 或 mock 发出）
     * ------------------------------------------------------------------ */
    mcpServers: function () {
      if (hasNative && hasNativeMethod('mcpServers')) {
        var raw = callNative('mcpServers', [], true);
        return normalizeMcpServers(raw);
      }
      return normalizeMcpServers(mockMcpServersJson());
    },

    mcpSaveServer: function (json) {
      var server = typeof json === 'string' ? parseJSON(json, null) : (json || null);
      if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
      if (hasNative && hasNativeMethod('mcpSaveServer')) {
        try {
          var str = typeof json === 'string' ? json : JSON.stringify(server);
          return !!DSNative.mcpSaveServer(str);
        } catch (e) {
          warn('mcpSaveServer 失败：' + (e && e.message));
          return false;
        }
      }
      return mockMcpSave(server);
    },

    mcpDeleteServer: function (id) {
      var key = String(id === null || id === undefined ? '' : id);
      if (!key) return false;
      if (hasNative && hasNativeMethod('mcpDeleteServer')) {
        try {
          DSNative.mcpDeleteServer(key);
          return true;
        } catch (e) {
          warn('mcpDeleteServer 失败：' + (e && e.message));
          return false;
        }
      }
      return mockMcpDelete(key);
    },

    mcpConnect: function (id) {
      var key = String(id === null || id === undefined ? '' : id);
      if (!key) return false;
      if (hasNative && hasNativeMethod('mcpConnect')) {
        try {
          DSNative.mcpConnect(key);
          return true;
        } catch (e) {
          warn('mcpConnect 失败：' + (e && e.message));
          return false;
        }
      }
      return mockMcpConnect(key);
    },

    mcpDisconnect: function (id) {
      var key = String(id === null || id === undefined ? '' : id);
      if (!key) return false;
      if (hasNative && hasNativeMethod('mcpDisconnect')) {
        try {
          DSNative.mcpDisconnect(key);
          return true;
        } catch (e) {
          warn('mcpDisconnect 失败：' + (e && e.message));
          return false;
        }
      }
      return mockMcpDisconnect(key);
    },

    mcpRefreshTools: function (id) {
      var key = String(id === null || id === undefined ? '' : id);
      if (!key) return false;
      if (hasNative && hasNativeMethod('mcpRefreshTools')) {
        try {
          DSNative.mcpRefreshTools(key);
          return true;
        } catch (e) {
          warn('mcpRefreshTools 失败：' + (e && e.message));
          return false;
        }
      }
      return mockMcpRefreshTools(key);
    },

    /** 补充（arch-native）：同步返回某服务器当前工具列表 JSON 数组（页面初次渲染/调试用） */
    mcpTools: function (id) {
      var key = String(id === null || id === undefined ? '' : id);
      if (!key) return [];
      if (hasNative && hasNativeMethod('mcpTools')) {
        var raw = callNative('mcpTools', [key], true);
        return normalizeMcpTools(raw);
      }
      var st = mockMcpStatusOf(key);
      return (st.status === 'connected' ? mockMcpToolsFor(key) : []).map(function (t) {
        return { name: t.name, description: t.description };
      });
    },

    /** 等待某服务器状态/工具事件（app.onMcpTest 用）：predicate 收到 (statusEvt) / (toolsEvt) */
    waitMcpStatus: function (id, timeoutMs) {
      var key = String(id === null || id === undefined ? '' : id);
      return waitForEvent('mcp-status', function (evt) {
        return !!evt && String(evt.id) === key;
      }, timeoutMs || 15000);
    },
    waitMcpTools: function (id, timeoutMs) {
      var key = String(id === null || id === undefined ? '' : id);
      return waitForEvent('mcp-tools', function (evt) {
        return !!evt && String(evt.id) === key;
      }, timeoutMs || 15000);
    },

    /* ------------------------------------------------------------------ *
     * ARCH v2 P1：事件 Promise 辅助（app.js / QA 使用）
     * ------------------------------------------------------------------ */
    waitForEvent: waitForEvent,
    waitToolResult: function (requestId, timeoutMs) {
      var rid = String(requestId === null || requestId === undefined ? '' : requestId);
      return waitForEvent('tool-result', function (evt) {
        return !!evt && String(evt.requestId) === rid;
      }, timeoutMs || 120000);
    },
    waitOtpVerified: function (requestId, timeoutMs) {
      var rid = String(requestId === null || requestId === undefined ? '' : requestId);
      return waitForEvent('otp-verified', function (evt) {
        return !!evt && String(evt.requestId) === rid;
      }, timeoutMs || 30000);
    },
    readFileAsync: function (path, timeoutMs) {
      var rid = genP1RequestId('file');
      var wait = waitForEvent('tool-result', function (evt) {
        return !!evt && String(evt.requestId) === rid;
      }, timeoutMs || 30000);
      var started = Bridge.readFile(rid, path);
      if (!started) return Promise.resolve({ ok: false, requestId: rid, result: '无法读取文件（原生不可用）' });
      return wait.then(function (evt) {
        return evt || { ok: false, requestId: rid, result: '读取文件超时' };
      });
    },
    writeFileAsync: function (path, content, timeoutMs) {
      var rid = genP1RequestId('write');
      var wait = waitForEvent('tool-result', function (evt) {
        return !!evt && String(evt.requestId) === rid;
      }, timeoutMs || 30000);
      var started = Bridge.writeFile(rid, path, content);
      if (!started) return Promise.resolve({ ok: false, requestId: rid, result: '无法写入文件（原生不可用）' });
      return wait.then(function (evt) {
        return evt || { ok: false, requestId: rid, result: '写入文件超时' };
      });
    },
    runShellAsync: function (command, timeoutMs) {
      var rid = genP1RequestId('shell');
      var wait = waitForEvent('tool-result', function (evt) {
        return !!evt && String(evt.requestId) === rid;
      }, timeoutMs || 60000);
      var started = Bridge.runShell(rid, command);
      if (!started) return Promise.resolve({ ok: false, requestId: rid, result: '无法执行命令（原生不可用）' });
      return wait.then(function (evt) {
        return evt || { ok: false, requestId: rid, result: '命令执行超时' };
      });
    },
    verifyOtpAsync: function (phone, code, timeoutMs) {
      var rid = genP1RequestId('otp');
      var wait = waitForEvent('otp-verified', function (evt) {
        return !!evt && String(evt.requestId) === rid;
      }, timeoutMs || 30000);
      var started = Bridge.verifyOtp(rid, phone, code);
      if (!started) return Promise.resolve({ ok: false, requestId: rid, message: '无法校验验证码（原生不可用）' });
      return wait.then(function (evt) {
        return evt || { ok: false, requestId: rid, message: '验证超时，请重试' };
      });
    }
  };

  /* ARCH v2 P1：mock 状态调试/QA 入口（仅测试使用） */
  Bridge.__mockAgent = {
    authState: function () { return mockAuthState(); },
    workspaceInfo: function () { return mockWorkspaceInfo(); },
    audit: function () { return mockAudit.slice(); },
    listDir: function (path) { return mockListDir(path); },
    readFile: function (path) { return mockReadFileText(path); },
    runShell: function (cmd) { return mockRunShellText(cmd); },
    execTool: function (name, args) { return mockExecNativeTool(name, args); },
    reset: function () {
      mockSeedFs();
      mockAuth = { loggedIn: false, phone: '' };
      mockOtp = null;
      mockAudit = [];
      mockAuditSeq = 0;
      mockPendingTools = Object.create(null);
      mockConfirmedMidTools = Object.create(null);
      mockWorkspace = { root: MOCK_WORKSPACE_ROOT, writable: true, allFilesAccess: false };
      mockSeedMcp();
      return true;
    }
  };

  /* ARCH v2 P2：MCP mock 调试/QA 入口（仅测试使用） */
  Bridge.__mockMcp = {
    servers: function () { return normalizeMcpServers(mockMcpServersJson()); },
    statusOf: function (id) {
      var st = mockMcpStatusOf(id);
      return { status: st.status, message: st.message, tools: (st.tools || []).slice() };
    },
    connectedTools: function () { return mockMcpConnectedTools(); },
    connect: function (id) { return mockMcpConnect(id); },
    disconnect: function (id) { return mockMcpDisconnect(id); },
    refresh: function (id) { return mockMcpRefreshTools(id); },
    save: function (server) { return mockMcpSave(server); },
    remove: function (id) { return mockMcpDelete(id); },
    reset: function () { mockSeedMcp(); return true; }
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
    if (now - lastBackAt < 120) return;
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
        dispatchPluginFile(evt);
        return;
      }
      if (type === 'file-imported') {
        dispatchFileImported(evt);
        return;
      }
      if (AGENT_EVENT_TYPES[type]) {
        dispatchAgentEvent(evt);
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
