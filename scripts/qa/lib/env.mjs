/**
 * scripts/qa/lib/env.mjs
 * 测试环境：路径、web 资源读取、jsdom 窗口创建、DOM 加载、stub、DSNative mock、等待工具。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { JSDOM, ResourceLoader, VirtualConsole } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 项目根目录：scripts/qa/lib -> ../../.. */
export const ROOT = path.resolve(HERE, '..', '..', '..');
export const WEB_DIR = path.join(ROOT, 'app', 'assets', 'web');
export const JS_DIR = path.join(WEB_DIR, 'js');

export const SPEC_JS_ORDER = ['util.js', 'bridge.js', 'store.js', 'markdown.js', 'api.js', 'plugins.js', 'plugins_builtin.js', 'ui.js', 'app.js'];

export function webPath(...parts) {
  return path.join(WEB_DIR, ...parts);
}

export function readWeb(...parts) {
  return fs.readFileSync(webPath(...parts), 'utf8');
}

export function hasWebFile(...parts) {
  return fs.existsSync(webPath(...parts));
}

/** 读取 js 目录下全部文件（按 SPEC 顺序，未知文件排最后）。 */
export function listJsFiles() {
  if (!fs.existsSync(JS_DIR)) return [];
  const names = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
  const ordered = SPEC_JS_ORDER.filter((f) => names.includes(f));
  const rest = names.filter((f) => !ordered.includes(f)).sort();
  return [...ordered, ...rest];
}

/* ------------------------------------------------------------------ *
 * 环境 stub（jsdom 不实现布局 / 动画 / 部分平台 API）
 * ------------------------------------------------------------------ */
export function installStubs(win) {
  const noop = () => {};
  // 布局 / 滚动
  win.scrollTo = noop;
  win.scrollBy = noop;
  win.scroll = noop;
  if (win.Element && win.Element.prototype) {
    win.Element.prototype.scrollTo = win.Element.prototype.scrollTo || noop;
    win.Element.prototype.scrollIntoView = noop;
    win.Element.prototype.scrollBy = win.Element.prototype.scrollBy || noop;
    // jsdom 无布局：clientHeight/scrollHeight 恒为 0，部分实现会判断“是否在底部”，这里给可控实现
    try {
      Object.defineProperty(win.Element.prototype, 'scrollHeight', {
        configurable: true,
        get() {
          return 1200;
        },
      });
      Object.defineProperty(win.Element.prototype, 'clientHeight', {
        configurable: true,
        get() {
          return 600;
        },
      });
      Object.defineProperty(win.Element.prototype, 'scrollTop', {
        configurable: true,
        get() {
          return 1200;
        },
        set() {
          /* noop */
        },
      });
    } catch {
      /* ignore */
    }
  }
  // matchMedia
  if (!win.matchMedia) {
    win.matchMedia = (query) => ({
      matches: false,
      media: String(query || ''),
      onchange: null,
      addListener: noop,
      removeListener: noop,
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: () => false,
    });
  }
  // rAF：优先 jsdom（pretendToBeVisual 已提供），否则 setTimeout 兜底
  if (typeof win.requestAnimationFrame !== 'function') {
    win.requestAnimationFrame = (cb) => win.setTimeout(() => cb(Date.now()), 16);
    win.cancelAnimationFrame = (id) => win.clearTimeout(id);
  }
  // URL.createObjectURL（jsdom 默认无）
  try {
    if (win.URL && typeof win.URL.createObjectURL !== 'function') {
      win.URL.createObjectURL = () => 'blob:mock';
      win.URL.revokeObjectURL = noop;
    }
  } catch {
    /* ignore */
  }
  // 平台 API
  win.open = noop;
  win.alert = noop;
  win.confirm = () => true;
  win.prompt = () => null;
  if (win.navigator && typeof win.navigator.vibrate !== 'function') win.navigator.vibrate = noop;
  return win;
}

/* ------------------------------------------------------------------ *
 * 单元测试窗口：jsdom（http origin → localStorage 可用）+ 手动执行 IIFE
 * ------------------------------------------------------------------ */
export function createUnitWindow(opts = {}) {
  const quietConsole = new VirtualConsole(); // 单元测试静默页面 console，避免噪音
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
    url: 'http://localhost/unit',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: quietConsole,
  });
  const win = dom.window;
  installStubs(win);
  if (opts.prefs) {
    for (const [key, value] of Object.entries(opts.prefs)) {
      win.localStorage.setItem(key, value);
    }
  }
  const context = dom.getInternalVMContext();
  const execute = (filename, code) => {
    vm.runInContext(code, context, { filename });
  };
  return { dom, win, context, execute };
}

/** 在单元窗口中按顺序执行 web/js 文件（默认仅前 N 个，缺文件则跳过）。 */
export function runWebScripts(ctx, files, { stopOnMissing = false } = {}) {
  const loaded = [];
  for (const name of files) {
    const abs = path.join(JS_DIR, name);
    if (!fs.existsSync(abs)) {
      if (stopOnMissing) throw new Error(`缺少脚本：js/${name}`);
      continue;
    }
    vm.runInContext(fs.readFileSync(abs, 'utf8'), ctx.context, { filename: `js/${name}` });
    loaded.push(name);
  }
  return loaded;
}

/* ------------------------------------------------------------------ *
 * DSNative mock（集成测试用）
 * ------------------------------------------------------------------ */
export function createMockNative(opts = {}) {
  const prefs = Object.assign(
    {
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      temperature: 1.0,
      maxTokens: 4096,
      stream: true,
      theme: 'dark',
      systemPrompt: '你是 DeepSeek House 助手…（测试）',
      backDepth: 0,
    },
    opts.prefs || {}
  );
  const calls = [];
  const pending = { validate: [], chat: [], http: [], save: [] };
  const plugins = opts.plugins ? opts.plugins.slice() : [];
  let clipboard = opts.clipboard || '';
  let winRef = null;
  const auto = Object.assign({ validateKey: true, startChat: false }, opts.auto || {});

  /* ------------------------------------------------------------------ *
   * ARCH v2 P1：mock 原生 Agent 工具 / 工作区 / 审计 / 手机号登录（OTP）
   *
   * 契约与 JsBridge.java 保持一致：
   *   toolSchemas()/workspaceInfo()/listDir()/auditRecent()/authState()
   *   同步返回 **JSON 字符串**（Bridge 会 JSON.parse）；
   *   execTool/confirmTool/readFile/writeFile/runShell/setWorkspace/
   *   requestOtp/verifyOtp/logout 只记录调用，**事件（tool-confirm / tool-result /
   *   otp-sent / otp-verified / workspace-changed / auth-changed）默认由测试通过
   *   app.native.__emit(evt) 主动注入**，保证用例可精确控制时序。
   *   例外：setWorkspace 默认自动回 workspace-changed（原生异步 setRoot 的等价物），
   *        logout 默认自动回 auth-changed；均可用 opts.p1.auto* 关闭。
   *
   * 可通过 opts.p1 配置（测试里也可直接修改 app.native.__p1 运行时状态）：
   *   { tools, workspace:{root,writable,allFilesAccess,defaultRoot,isDefault},
   *     dirs:{path:[entries]}, files:{path:content}, audit:[...],
   *     auth:{loggedIn,phone}, otp:{ttlSeconds,demoCode},
   *     listDirError, workspaceInfoError,
   *     autoWorkspaceChanged:true, autoAuthChanged:true,
   *     autoToolEvents:false, autoDirectResults:false }
   * ------------------------------------------------------------------ */
  const P1_DEFAULT_ROOT = '/sdcard/house-workspace';
  const P1_PRIVATE_ROOT = '/data/user/0/com.deepseekhouse.app/files/workspace';
  const p1cfg = opts.p1 && typeof opts.p1 === 'object' ? opts.p1 : {};

  function p1DefaultToolSchemas() {
    const fn = (name, description, properties, required, risk) => ({
      type: 'function',
      risk,
      function: { name, description, parameters: { type: 'object', properties, required } },
    });
    return [
      fn('read_file', '读取工作区内的文本文件（≤256KB）', { path: { type: 'string', description: '工作区内文件路径' } }, ['path'], 'low'),
      fn('list_dir', '列出工作区目录内容', { path: { type: 'string', description: '目录路径，缺省为工作区根' } }, [], 'low'),
      fn('write_file', '写入工作区内的文本文件（仅限工作区）', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content'], 'mid'),
      fn('run_shell', '在工作区执行 shell 命令（超时 30s）', { command: { type: 'string' } }, ['command'], 'high'),
      fn('http_get', '发起受限 https GET 请求（≤1MB）', { url: { type: 'string' } }, ['url'], 'low'),
    ];
  }

  const p1 = {
    tools: Array.isArray(p1cfg.tools) ? p1cfg.tools.map((t) => JSON.parse(JSON.stringify(t))) : p1DefaultToolSchemas(),
    workspace: Object.assign(
      { root: P1_DEFAULT_ROOT, writable: true, allFilesAccess: false, defaultRoot: P1_PRIVATE_ROOT },
      p1cfg.workspace && typeof p1cfg.workspace === 'object' ? p1cfg.workspace : {}
    ),
    dirs: p1cfg.dirs && typeof p1cfg.dirs === 'object' ? p1cfg.dirs : {},
    files: p1cfg.files && typeof p1cfg.files === 'object' ? p1cfg.files : {},
    audit: Array.isArray(p1cfg.audit) ? p1cfg.audit.slice() : [],
    auth: Object.assign({ loggedIn: false, phone: '' }, p1cfg.auth && typeof p1cfg.auth === 'object' ? p1cfg.auth : {}),
    otp: Object.assign({ ttlSeconds: 300, demoCode: '123456' }, p1cfg.otp && typeof p1cfg.otp === 'object' ? p1cfg.otp : {}),
    listDirError: p1cfg.listDirError ? String(p1cfg.listDirError) : '',
    workspaceInfoError: p1cfg.workspaceInfoError ? String(p1cfg.workspaceInfoError) : '',
    autoWorkspaceChanged: p1cfg.autoWorkspaceChanged !== false,
    autoAuthChanged: p1cfg.autoAuthChanged !== false,
    autoToolEvents: !!p1cfg.autoToolEvents,
    autoDirectResults: !!p1cfg.autoDirectResults,
    pendingTools: [], // execTool 记录（等待 tool-confirm / tool-result）
    confirmations: [], // confirmTool 记录
    fileRequests: [], // readFile 记录
    shellRequests: [], // runShell 记录
    writeRequests: [], // writeFile 记录
    otpRequests: [], // requestOtp 记录
    verifyRequests: [], // verifyOtp 记录
  };

  function p1ResolvePath(p) {
    const raw = p === null || p === undefined ? '' : String(p).trim();
    if (!raw) return String(p1.workspace.root || '');
    const abs = raw.charAt(0) === '/' ? raw : String(p1.workspace.root || '') + '/' + raw;
    return abs.replace(/\/+$/, '') || '/';
  }

  function p1DefaultEntries(dir) {
    const root = String(p1.workspace.root || '');
    const readme = p1DefaultFile(root + '/README.md');
    const notes = 'mock 工作区笔记\n';
    const appjs = '// mock 源文件\nconsole.log("hello from mock workspace");\n';
    if (dir === root) {
      return [
        { name: 'README.md', path: root + '/README.md', isDir: false, size: readme.length },
        { name: 'notes.txt', path: root + '/notes.txt', isDir: false, size: notes.length },
        { name: 'src', path: root + '/src', isDir: true, size: 0 },
      ];
    }
    if (dir === root + '/src') {
      return [{ name: 'app.js', path: root + '/src/app.js', isDir: false, size: appjs.length }];
    }
    return [];
  }

  function p1DefaultFile(path) {
    const root = String(p1.workspace.root || '');
    if (path === root + '/README.md') {
      return '# house-workspace（mock）\n\nBridge mock 模式下的工作区示例文件。\n\n- read_file / list_dir：只读\n- write_file：MID，首次确认\n- run_shell：HIGH，每次确认\n';
    }
    if (path === root + '/notes.txt') return 'mock 工作区笔记\n';
    if (path === root + '/src/app.js') return '// mock 源文件\nconsole.log("hello from mock workspace");\n';
    return '';
  }

  function p1ListEntries(path) {
    const dir = p1ResolvePath(path);
    if (Object.prototype.hasOwnProperty.call(p1.dirs, dir)) {
      const list = Array.isArray(p1.dirs[dir]) ? p1.dirs[dir] : [];
      return list.map((item) => ({
        name: item && item.name != null ? String(item.name) : '',
        path: item && item.path != null ? String(item.path) : '',
        isDir: !!(item && item.isDir),
        size: Number(item && item.size) || 0,
      }));
    }
    return p1DefaultEntries(dir);
  }

  function p1ReadText(path) {
    const file = p1ResolvePath(path);
    if (Object.prototype.hasOwnProperty.call(p1.files, file)) return String(p1.files[file]);
    return p1DefaultFile(file);
  }

  function p1RiskOf(name) {
    const tool = String(name === null || name === undefined ? '' : name);
    for (const schema of p1.tools) {
      const fn = (schema && schema.function) || schema || {};
      if (String(fn.name || '') !== tool) continue;
      const risk = String((schema && schema.risk) || fn.risk || 'high').toLowerCase();
      if (risk === 'low' || risk === 'mid' || risk === 'high') return risk;
    }
    return 'high';
  }

  function p1ExtractArgs(argsJson) {
    if (argsJson && typeof argsJson === 'object') return argsJson;
    try {
      const parsed = JSON.parse(String(argsJson == null ? '' : argsJson));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function p1ToolResult(name, args) {
    const tool = String(name === null || name === undefined ? '' : name);
    const a = args && typeof args === 'object' ? args : {};
    if (tool === 'list_dir') return JSON.stringify(p1ListEntries(a.path === undefined || a.path === null ? '' : a.path));
    if (tool === 'read_file') return p1ReadText(a.path);
    if (tool === 'write_file') return '已写入 ' + String(a.path === undefined || a.path === null ? '' : a.path);
    if (tool === 'run_shell') {
      const m = /^\s*echo\s+([\s\S]*)$/.exec(String(a.command === undefined || a.command === null ? '' : a.command));
      return m ? m[1] : '（mock）' + String(a.command || '');
    }
    if (tool === 'http_get') return '{"status":200,"body":"(mock)"}';
    return '（mock）' + tool + ' 执行完成';
  }

  function p1WorkspaceJson() {
    const root = String(p1.workspace.root || '');
    const body = {
      root,
      writable: !!p1.workspace.writable,
      allFilesAccess: !!p1.workspace.allFilesAccess,
      defaultRoot: p1.workspace.defaultRoot == null ? '' : String(p1.workspace.defaultRoot),
    };
    body.isDefault = p1.workspace.isDefault !== undefined ? !!p1.workspace.isDefault : root === body.defaultRoot;
    return body;
  }

  function record(method, args) {
    calls.push({ method, args, at: Date.now() });
  }

  function emit(evt) {
    if (!winRef) return;
    try {
      winRef.DSHost && winRef.DSHost.onEvent(typeof evt === 'string' ? evt : JSON.stringify(evt));
    } catch (e) {
      /* ignore */
    }
  }

  const native = {
    appInfo() {
      record('appInfo', []);
      return JSON.stringify({ versionName: '1.0.0', versionCode: '1', filesDir: '/data/user/0/com.deepseekhouse.app/files', sdkInt: 34 });
    },
    getPrefs() {
      record('getPrefs', []);
      return JSON.stringify(prefs);
    },
    setPrefs(json) {
      record('setPrefs', [json]);
      try {
        const patch = JSON.parse(json);
        Object.assign(prefs, patch);
      } catch {
        /* ignore */
      }
    },
    pluginsList() {
      record('pluginsList', []);
      return JSON.stringify(plugins);
    },
    pluginRead(id) {
      record('pluginRead', [id]);
      const p = plugins.find((x) => x.id === id);
      return p ? p.code || '' : '';
    },
    pluginWrite(id, code, meta) {
      record('pluginWrite', [id, code, meta]);
      const existing = plugins.find((x) => x.id === id);
      const metaObj = (() => {
        try {
          return JSON.parse(meta || '{}');
        } catch {
          return {};
        }
      })();
      if (existing) {
        existing.code = code;
        Object.assign(existing, metaObj);
      } else {
        plugins.push(Object.assign({ id, name: id, enabled: true }, metaObj, { code }));
      }
    },
    pluginDelete(id) {
      record('pluginDelete', [id]);
      const i = plugins.findIndex((x) => x.id === id);
      if (i >= 0) plugins.splice(i, 1);
    },
    pluginSetEnabled(id, enabled) {
      record('pluginSetEnabled', [id, enabled]);
      const p = plugins.find((x) => x.id === id);
      if (p) p.enabled = !!enabled;
    },
    getClipboard() {
      record('getClipboard', []);
      return clipboard;
    },
    shareText(title, text) {
      record('shareText', [title, text]);
    },

    setClipboard(text) {
      record('setClipboard', [text]);
      clipboard = String(text == null ? '' : text);
    },
    toast(msg) {
      record('toast', [msg]);
    },
    openUrl(url) {
      record('openUrl', [url]);
    },
    setBackDepth(depth) {
      record('setBackDepth', [depth]);
      prefs.backDepth = depth;
    },
    cancelRequest(id) {
      record('cancelRequest', [id]);
    },
    cancelAllRequests() {
      record('cancelAllRequests', []);
    },
    setStatusBar(color, light) {
      record('setStatusBar', [color, light]);
    },
    finishApp() {
      record('finishApp', []);
    },
    startChat(requestId, bodyJson) {
      record('startChat', [requestId, bodyJson]);
      pending.chat.push({ requestId, bodyJson });
      if (auto.startChat) setTimeout(() => autoStream(requestId), 10);
    },
    validateKey(requestId) {
      record('validateKey', [requestId]);
      pending.validate.push(requestId);
      if (auto.validateKey) {
        setTimeout(() => {
          emit({ type: 'validated', requestId, ok: true, models: ['deepseek-chat', 'deepseek-reasoner'] });
        }, 5);
      }
    },
    httpFetch(requestId, reqJson) {
      record('httpFetch', [requestId, reqJson]);
      pending.http.push({ requestId, reqJson });
      setTimeout(() => {
        emit({ type: 'http', requestId, status: 200, body: '{}', error: null });
      }, 5);
    },
    importPluginFile() {
      record('importPluginFile', []);
      setTimeout(() => {
        emit({
          type: 'plugin-file',
          id: 'user.mock',
          fileName: 'mock.js',
          content: "window.DSPlugins.register({id:'user.mock',name:'Mock 插件',version:'1.0.0',commands:[],tools:[]})",
        });
      }, 5);
    },
    saveTextFile(name, content) {
      record('saveTextFile', [name, content]);
      pending.save.push({ name, content });
      setTimeout(() => emit({ type: 'saved', ok: true, name }), 5);
    },

    /* ---------------- ARCH v2 P1：原生 Agent 工具框架（JsBridge 契约） ---------------- */
    toolSchemas() {
      record('toolSchemas', []);
      return JSON.stringify(p1.tools);
    },
    execTool(requestId, name, argsJson) {
      record('execTool', [requestId, name, argsJson]);
      const entry = {
        requestId: String(requestId == null ? '' : requestId),
        name: String(name == null ? '' : name),
        args: p1ExtractArgs(argsJson),
        argsJson: typeof argsJson === 'string' ? argsJson : JSON.stringify(argsJson || {}),
      };
      p1.pendingTools.push(entry);
      if (!p1.autoToolEvents) return;
      const risk = p1RiskOf(entry.name);
      if (risk === 'low') {
        const result = p1ToolResult(entry.name, entry.args);
        setTimeout(() => emit({ type: 'tool-result', requestId: entry.requestId, tool: entry.name, ok: true, result, confirmed: false }), 5);
        return;
      }
      setTimeout(() => emit({ type: 'tool-confirm', requestId: entry.requestId, tool: entry.name, args: entry.args, risk, needConfirm: true }), 5);
    },
    confirmTool(requestId, allow) {
      record('confirmTool', [requestId, !!allow]);
      const rid = String(requestId == null ? '' : requestId);
      const entry = p1.pendingTools.find((x) => x.requestId === rid) || null;
      p1.confirmations.push({ requestId: rid, allow: !!allow });
      if (!p1.autoToolEvents || !entry) return;
      const result = allow ? p1ToolResult(entry.name, entry.args) : '用户拒绝执行';
      setTimeout(() => emit({
        type: 'tool-result', requestId: rid, tool: entry.name, ok: !!allow, result, confirmed: !!allow,
      }), 5);
    },

    /* ---------------- ARCH v2 P1：工作区 / 文件 / 终端 / 审计 ---------------- */
    workspaceInfo() {
      record('workspaceInfo', []);
      if (p1.workspaceInfoError) return JSON.stringify({ error: p1.workspaceInfoError });
      return JSON.stringify(p1WorkspaceJson());
    },
    listDir(path) {
      record('listDir', [path]);
      if (p1.listDirError) return JSON.stringify({ error: p1.listDirError });
      return JSON.stringify(p1ListEntries(path));
    },
    readFile(requestId, path) {
      record('readFile', [requestId, path]);
      p1.fileRequests.push({ requestId: String(requestId == null ? '' : requestId), path: String(path == null ? '' : path) });
      if (!p1.autoDirectResults) return;
      const text = p1ReadText(path);
      setTimeout(() => emit({
        type: 'tool-result', requestId: String(requestId), tool: 'read_file', ok: true, result: text, confirmed: true,
      }), 5);
    },
    writeFile(requestId, path, content) {
      record('writeFile', [requestId, path, content]);
      p1.writeRequests.push({ requestId: String(requestId == null ? '' : requestId), path: String(path == null ? '' : path), content: String(content == null ? '' : content) });
      if (!p1.autoDirectResults) return;
      setTimeout(() => emit({
        type: 'tool-result', requestId: String(requestId), tool: 'write_file', ok: true,
        result: '已写入 ' + String(path == null ? '' : path), confirmed: true,
      }), 5);
    },
    runShell(requestId, command) {
      record('runShell', [requestId, command]);
      p1.shellRequests.push({ requestId: String(requestId == null ? '' : requestId), command: String(command == null ? '' : command) });
      if (!p1.autoDirectResults) return;
      setTimeout(() => emit({
        type: 'tool-result', requestId: String(requestId), tool: 'run_shell', ok: true,
        result: p1ToolResult('run_shell', { command }), confirmed: false,
      }), 5);
    },
    auditRecent(limit) {
      record('auditRecent', [limit]);
      const n = Number(limit) > 0 ? Number(limit) : 50;
      return JSON.stringify(p1.audit.slice(0, n));
    },
    setWorkspace(path) {
      record('setWorkspace', [path]);
      const root = p1ResolvePath(path);
      p1.workspace.root = root;
      p1.workspace.writable = true;
      p1.workspace.isDefault = root === String(p1.workspace.defaultRoot || '');
      if (p1.autoWorkspaceChanged) {
        setTimeout(() => emit({
          type: 'workspace-changed', ok: true, root,
          message: '工作区已切换', allFilesAccess: !!p1.workspace.allFilesAccess,
        }), 5);
      }
    },

    /* ---------------- ARCH v2 P1：手机号登录（本地 OTP MVP） ---------------- */
    requestOtp(phone) {
      record('requestOtp', [phone]);
      const p = String(phone == null ? '' : phone).replace(/[\s-]/g, '');
      p1.otpRequests.push({ phone: p, at: Date.now() });
      p1.otp.phone = p;
      p1.otp.sentAt = Date.now();
    },
    verifyOtp(requestId, phone, code) {
      record('verifyOtp', [requestId, phone, code]);
      p1.verifyRequests.push({
        requestId: String(requestId == null ? '' : requestId),
        phone: String(phone == null ? '' : phone),
        code: String(code == null ? '' : code),
      });
    },
    authState() {
      record('authState', []);
      return JSON.stringify({ loggedIn: !!p1.auth.loggedIn, phone: p1.auth.phone == null ? '' : String(p1.auth.phone) });
    },
    logout() {
      record('logout', []);
      const phone = p1.auth.phone == null ? '' : String(p1.auth.phone);
      p1.auth = { loggedIn: false, phone };
      if (p1.autoAuthChanged) setTimeout(() => emit({ type: 'auth-changed', loggedIn: false, phone }), 5);
    },

    __calls: calls,
    __pending: pending,
    __prefs: prefs,
    __plugins: plugins,
    /** P1 mock 运行时状态（测试可读写：listDirError / dirs / files / audit / auth / workspace ...） */
    __p1: p1,
    __setClipboard: (t) => {
      clipboard = String(t);
    },
    __getClipboard: () => clipboard,
    __emit: emit,
    __bind(win) {
      winRef = win;
      return this;
    },
  };

  async function autoStream(requestId) {
    const chunks = ['你好！', '这是', ' mock ', '流式回复。'];
    for (let i = 0; i < chunks.length; i++) {
      await new Promise((r) => setTimeout(r, 5));
      emit({ type: 'chunk', requestId, delta: chunks[i], reasoning: '' });
    }
    emit({ type: 'done', requestId, finishReason: 'stop', usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 } });
  }

  return native;
}

/* ------------------------------------------------------------------ *
 * 集成窗口：jsdom 加载真实 index.html（http origin + 本地文件 loader）
 * ------------------------------------------------------------------ */
class LocalFileLoader extends ResourceLoader {
  constructor(baseDir) {
    super();
    this.baseDir = path.resolve(baseDir);
    this.missing = [];
    this.loaded = [];
  }

  fetch(url) {
    try {
      const u = new URL(url);
      let rel = decodeURIComponent(u.pathname || '/');
      rel = rel.replace(/^\/+/, '');
      if (!rel) rel = 'index.html';
      const abs = path.resolve(this.baseDir, rel);
      const base = path.resolve(this.baseDir);
      if (abs !== base && !abs.startsWith(base + path.sep)) {
        return Promise.reject(new Error(`拒绝越界资源：${url}`));
      }
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        this.loaded.push(rel);
        return Promise.resolve(fs.readFileSync(abs));
      }
      this.missing.push(rel);
      return Promise.resolve(Buffer.from(''));
    } catch (e) {
      this.missing.push(url);
      return Promise.resolve(Buffer.from(''));
    }
  }
}

/**
 * 加载真实 app/assets/web/index.html。
 * @returns {Promise<{dom:JSDOM, win:Window, native:object, loader:LocalFileLoader, pageErrors:Error[], consoleLogs:Array}>}
 */
export async function loadAppWindow(opts = {}) {
  const loader = new LocalFileLoader(WEB_DIR);
  const pageErrors = [];
  const consoleLogs = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    pageErrors.push(err);
  });
  for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
    virtualConsole.on(level, (...args) => {
      consoleLogs.push({ level, args: args.map((a) => String(a)) });
    });
  }

  const native = createMockNative(opts.native || {});
  const dom = new JSDOM(fs.readFileSync(webPath('index.html'), 'utf8'), {
    url: 'http://deepseek.house/index.html',
    contentType: 'text/html',
    runScripts: 'dangerously',
    resources: loader,
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(win) {
      installStubs(win);
      native.__bind(win);
      win.DSNative = native;
      win.__qaErrors = pageErrors;
      // 收集脚本运行期异常（app.js 若抛错，load 仍会完成，这里可发现）
      win.addEventListener('error', (ev) => {
        pageErrors.push(ev.error || new Error(ev.message || 'window error'));
      });
      win.addEventListener('unhandledrejection', (ev) => {
        pageErrors.push(ev.reason instanceof Error ? ev.reason : new Error(String(ev.reason)));
      });
      if (opts.beforeParse) opts.beforeParse(win, native);
    },
  });

  const win = dom.window;
  await waitForLoad(win, opts.loadTimeout || 10000);
  return { dom, win, native, loader, pageErrors, consoleLogs };
}

export function waitForLoad(win, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setTimeout(() => finish(), timeoutMs);
    function finish() {
      clearTimeout(timer);
      win.removeEventListener('load', onLoad);
      resolve();
    }
    function onLoad() {
      finish();
    }
    win.addEventListener('load', onLoad, { once: true });
    if (win.document.readyState === 'complete') {
      // 等一个 tick，确保 defer 脚本后的 app.js 启动逻辑执行
      const check = () => {
        if (win.document.readyState === 'complete') {
          const wait = Math.max(0, 60 - (Date.now() - start));
          setTimeout(finish, wait);
        } else if (Date.now() - start < timeoutMs) setTimeout(check, 10);
        else finish();
      };
      check();
    }
  });
}

/* ------------------------------------------------------------------ *
 * 等待工具
 * ------------------------------------------------------------------ */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 predicate 返回真值；超时抛错（带描述）。 */
export async function waitFor(predicate, { timeout = 4000, interval = 20, label = '条件' } = {}) {
  const start = Date.now();
  let lastErr = null;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() - start >= timeout) {
      throw new Error(`等待${label}超时（${timeout}ms）${lastErr ? '：' + lastErr.message : ''}`);
    }
    await sleep(interval);
  }
}

/** 让浏览器事件循环/定时器/rAF 跑一会儿。 */
export async function flush(win, ms = 120) {
  await sleep(ms);
}

/* ------------------------------------------------------------------ *
 * DOM 可见性判定（jsdom 无布局，用 aria-hidden / hidden / class / computed style 综合判断）
 * ------------------------------------------------------------------ */
const HIDDEN_CLASSES = ['hidden', 'hide', 'is-hidden', 'u-hidden'];

export function isHidden(win, el) {
  if (!el) return true;
  let node = el;
  while (node && node.nodeType === 1) {
    if (node.hidden) return true;
    if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return true;
    if (node.style && (node.style.display === 'none' || node.style.visibility === 'hidden')) return true;
    if (node.classList && HIDDEN_CLASSES.some((c) => node.classList.contains(c))) return true;
    node = node.parentElement;
  }
  try {
    const cs = win.getComputedStyle(el);
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** 屏幕是否“显示中”：去除隐藏后，且存在屏幕激活标记（is-active/active）或 aria-hidden=false。 */
export function isScreenActive(win, screenId) {
  const doc = win.document;
  const el = doc.getElementById(screenId);
  if (!el || isHidden(win, el)) return false;
  const cls = el.classList || { contains: () => false };
  if (cls.contains('is-active') || cls.contains('active') || cls.contains('screen--active')) return true;
  if (el.getAttribute('aria-hidden') === 'false') return true;
  // 兜底：computed display 不是 none 且没有其他屏幕标记时，视为可见
  try {
    const cs = win.getComputedStyle(el);
    if (cs && cs.display !== 'none') return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function bodyText(win) {
  return (win.document.body && win.document.body.textContent) || '';
}

export function textOf(win, selector) {
  const el = win.document.querySelector(selector);
  return el ? el.textContent || '' : '';
}

export function click(win, el) {
  if (!el) return false;
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, view: win }));
  return true;
}

export function setValue(win, el, value) {
  if (!el) return false;
  el.value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
  return true;
}
