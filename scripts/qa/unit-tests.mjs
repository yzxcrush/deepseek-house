/**
 * scripts/qa/unit-tests.mjs
 * 单元测试：util / markdown / store / bridge(mock) / plugins（vm + jsdom window，stub localStorage/document）。
 */

import { JSDOM } from 'jsdom';
import { suite, test, ok, equal, deepEqual, includes, notIncludes, match, isString, isFunction, isArray, isObject } from './lib/harness.mjs';
import { createUnitWindow, runWebScripts, sleep, waitFor, createMockNative } from './lib/env.mjs';

/** SPEC §2 顺序的前端逻辑模块（不含 ui/app，两者依赖真实 DOM） */
const LOGIC_FILES = ['util.js', 'bridge.js', 'store.js', 'markdown.js', 'api.js', 'plugins.js', 'plugins_builtin.js'];

function loadLogic(opts = {}) {
  const ctx = createUnitWindow(opts);
  const loaded = runWebScripts(ctx, LOGIC_FILES);
  return { ...ctx, loaded };
}

async function assertRejects(fn, messagePart) {
  let threw = false;
  let err = null;
  try {
    await fn();
  } catch (e) {
    threw = true;
    err = e;
  }
  ok(threw, `期望抛出异常，但正常返回（${messagePart || ''}）`);
  if (messagePart) includes(String((err && err.message) || err), messagePart, '异常信息不符合预期');
  return err;
}

export function registerUnitTests() {
  /* ================================================================== *
   * util.js
   * ================================================================== */
  suite('单元测试 · util.js');
  const u = loadLogic();
  const U = u.win.Util;

  test('window.Util 导出且 SPEC §4.3 方法齐全', () => {
    isObject(U);
    for (const name of ['$', '$$', 'el', 'escapeHtml', 'debounce', 'uuid', 'sleep', 'copyText']) {
      isFunction(U[name], `Util.${name} 应为函数`);
    }
  });

  test('escapeHtml 转义 <script> / 引号 / &', () => {
    const html = U.escapeHtml('<script>alert("x&y")</script>');
    notIncludes(html, '<script>', 'escapeHtml 未转义 <script>');
    includes(html, '&lt;script&gt;', 'escapeHtml 应输出 &lt;script&gt;');
    includes(html, '&amp;', 'escapeHtml 应转义 &');
    includes(html, '&quot;', 'escapeHtml 应转义双引号');
    equal(U.escapeHtml(null), '');
    equal(U.escapeHtml(undefined), '');
    equal(U.escapeHtml(0), '0');
  });

  test('uuid 唯一且非空（200 次）', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const id = U.uuid();
      isString(id);
      ok(id.length >= 8, `uuid 太短：${id}`);
      ok(!seen.has(id), `uuid 重复：${id}`);
      seen.add(id);
    }
    equal(seen.size, 200);
  });

  test('formatTime 返回合理的 HH:MM（补零、可解析）', () => {
    const d = new Date(2024, 0, 2, 3, 4, 5);
    equal(U.formatTime(d.getTime()), '03:04');
    equal(U.formatTime(d), '03:04');
    const now = U.formatTime(Date.now());
    match(now, /^\d{2}:\d{2}$/, 'formatTime 格式应为 HH:MM');
    const [hh, mm] = now.split(':').map(Number);
    ok(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59, `formatTime 越界：${now}`);
  });

  test('normalizeBaseUrl / parseJSON / debounce 基础行为', () => {
    equal(U.normalizeBaseUrl('api.deepseek.com'), 'https://api.deepseek.com');
    equal(U.normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
    equal(U.normalizeBaseUrl('ftp://x'), '');
    deepEqual(U.parseJSON('{"a":1}', null), { a: 1 });
    equal(U.parseJSON('{bad', 'fb'), 'fb');
    isFunction(U.debounce(() => {}, 10));
  });

  /* ================================================================== *
   * markdown.js
   * ================================================================== */
  suite('单元测试 · markdown.js');
  const m = loadLogic();
  const M = m.win.Markdown;

  test('window.Markdown.render 存在（SPEC §4.3）', () => {
    isFunction(M.render);
    isFunction(M.renderMarkdown);
  });

  test('HTML 被转义：<script> 不会成为标签', () => {
    const html = M.render('<script>alert(1)</script>');
    notIncludes(html, '<script>', 'Markdown.render 输出了原始 <script> 标签');
    includes(html, '&lt;script&gt;', '应转义为 &lt;script&gt;');
  });

  test('javascript: / data: 链接被过滤（不生成 href）', () => {
    for (const url of ['javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>', 'vbscript:msgbox']) {
      const html = M.render(`[点我](${url})`);
      notIncludes(html.toLowerCase(), 'href="javascript', 'javascript: 链接未被过滤');
      notIncludes(html.toLowerCase(), 'href="data:', 'data: 链接未被过滤');
      notIncludes(html.toLowerCase(), 'href="vbscript:', 'vbscript: 链接未被过滤');
    }
    const good = M.render('[官网](https://platform.deepseek.com)');
    includes(good, 'href="https://platform.deepseek.com"', '合法 https 链接应保留');
    includes(good, 'rel="noopener', '外链应带 rel=noopener');
  });

  test('代码块：语言标签 + 复制按钮 data-action="copy-code"', () => {
    const html = M.render('```js\nconst a = 1;\n```');
    includes(html, 'data-action="copy-code"', '代码块缺少复制按钮');
    includes(html, 'md-code', '代码块缺少 md-code 容器');
    includes(html, 'js', '代码块缺少语言标签');
    includes(html, 'md-pre', '代码块缺少 <pre>');
  });

  test('表格 / 列表 / 粗体 / 行内代码渲染', () => {
    const table = M.render('| 名称 | 值 |\n| --- | --- |\n| a | 1 |');
    includes(table, '<table', '表格未渲染');
    includes(table, '<th', '表格缺少表头');
    includes(table, '<td', '表格缺少单元格');

    const ul = M.render('- 第一项\n- 第二项');
    includes(ul, '<ul', '无序列表未渲染');
    includes(ul, '<li', '列表缺少 li');

    const ol = M.render('1. 一\n2. 二');
    includes(ol, '<ol', '有序列表未渲染');

    const bold = M.render('普通 **粗体** 文字');
    includes(bold, '<strong', '粗体未渲染');

    const code = M.render('行内 `code` 测试');
    includes(code, '<code', '行内代码未渲染');
  });

  test('引用块渲染为 <blockquote>（SPEC §4.3）', () => {
    const quote = M.render('> 引用内容');
    includes(quote, '<blockquote', `引用未渲染为 blockquote，实际输出：${quote}`);
    const multi = M.render('段落\n\n> 第一行\n> 第二行');
    includes(multi, '<blockquote', '段落后的多行引用未渲染');
    includes(multi, '第一行');
    includes(multi, '第二行');
  });

  test('恶意 Markdown DOM 解析后无脚本/事件属性（XSS 回归）', () => {
    const payloads = [
      '<img src=x onerror=alert(1)>',
      '<svg/onload=alert(1)>',
      '<script>alert(1)</script>',
      '[x](javascript:alert(1))',
      '[x](JaVaScRiPt:alert(1))',
      '[x](java\tscript:alert(1))',
      '[x](data:text/html;base64,PHNjcmlwdD4=)',
      '[x](vbscript:msgbox(1))',
      '[x](file:///etc/passwd)',
      '[x](https://a.com" onmouseover="alert(1))',
      '![img](javascript:alert(1))',
      '**<script>alert(1)</script>**',
      '`</code><script>alert(1)</script>`',
      '```js\n</code></pre><script>alert(1)</script>\n```',
      '| a |\n| --- |\n| <img src=x onerror=alert(1)> |',
      '> <script>alert(1)</script>',
      '- <img src=x onerror=alert(1)>',
      '# <script>alert(1)</script>',
      '<a href="javascript:alert(1)">x</a>',
    ];
    const problems = [];
    for (const payload of payloads) {
      const html = M.render(payload);
      const dom = new JSDOM('<!doctype html><html><body><div id="out"></div></body></html>', { url: 'http://localhost/' });
      try {
        dom.window.document.getElementById('out').innerHTML = html;
        const out = dom.window.document.getElementById('out');
        for (const tag of ['script', 'img', 'svg', 'iframe', 'object', 'embed', 'link', 'style']) {
          if (out.querySelector(tag)) problems.push(`${JSON.stringify(payload)} → 生成 <${tag}>`);
        }
        for (const node of out.querySelectorAll('*')) {
          for (const attr of Array.from(node.attributes || [])) {
            const name = attr.name.toLowerCase();
            const value = String(attr.value).replace(/[\u0000-\u0020]/g, '').toLowerCase();
            if (/^on/.test(name)) problems.push(`${JSON.stringify(payload)} → 属性 ${name}`);
            if ((name === 'href' || name === 'src') && /^(javascript|data|vbscript|file):/.test(value)) {
              problems.push(`${JSON.stringify(payload)} → ${name}=${value.slice(0, 40)}`);
            }
          }
        }
      } finally {
        dom.window.close();
      }
    }
    ok(problems.length === 0, `发现 XSS 风险渲染：\n  ${problems.join('\n  ')}`);
  });

  test('流式未闭合围栏不崩溃且自动闭合', () => {
    let html;
    try {
      html = M.render('```js\nconst a = 1');
    } catch (e) {
      throw new Error(`未闭合围栏导致 render 抛异常：${e.message}`);
    }
    includes(html, 'md-code-open', '未闭合代码块应带 md-code-open 标记');
    includes(html, '生成中', '未闭合代码块应提示生成中');
    // 不应产生未闭合的 <pre> 之外的明显结构错误
    ok(html.indexOf('<pre') !== -1, '未闭合围栏仍应渲染 pre');
    // 流式空文本 / null 不崩
    equal(M.render(''), '');
    equal(M.render(null), '');
    equal(M.render(undefined), '');
  });

  /* ================================================================== *
   * store.js
   * ================================================================== */
  suite('单元测试 · store.js');

  test('默认 prefs 符合 SPEC §6', () => {
    const { win } = loadLogic();
    const prefs = win.Store.getPrefs();
    equal(prefs.baseUrl, 'https://api.deepseek.com');
    equal(prefs.model, 'deepseek-chat');
    equal(prefs.temperature, 1.0);
    equal(prefs.maxTokens, 4096);
    equal(prefs.stream, true);
    equal(prefs.theme, 'dark');
    isString(prefs.systemPrompt);
    ok(prefs.systemPrompt.length > 0, 'systemPrompt 默认值不能为空');
    ok(!('apiKey' in prefs), 'apiKey 不应落 localStorage');
  });

  test('会话 CRUD：创建/追加/更新/删除/重命名', () => {
    const { win } = loadLogic();
    const S = win.Store;
    equal(S.listChats().length, 0);

    const chat = S.createChat({ title: '测试会话' });
    isObject(chat);
    isString(chat.id);
    equal(S.listChats().length, 1);
    equal(S.getActiveChatId(), chat.id, '新建会话应自动激活');

    S.appendMessage(chat.id, { role: 'user', content: '你好' });
    S.appendMessage({ role: 'assistant', content: '收到' }); // 默认活动会话重载形式
    const loaded = S.getChat(chat.id);
    equal(loaded.messages.length, 2, '追加消息失败');
    equal(loaded.messages[0].role, 'user');
    equal(loaded.messages[1].role, 'assistant');

    const msgId = loaded.messages[0].id;
    S.updateMessage(chat.id, msgId, { content: '你好世界' });
    equal(S.getChat(chat.id).messages[0].content, '你好世界', 'updateMessage 未生效');

    S.renameChat(chat.id, '  新标题  ');
    equal(S.getChat(chat.id).title, '新标题', 'renameChat 应 trim 标题');

    const chat2 = S.createChat({ title: '待删除' });
    ok(S.deleteChat(chat2.id), 'deleteChat 应返回真值');
    equal(S.getChat(chat2.id), null, 'deleteChat 后仍能取到会话');
    equal(S.listChats().length, 1);
  });

  test('会话排序：pinned 优先，其余按 updatedAt 降序', () => {
    const { win } = loadLogic();
    const S = win.Store;
    const base = Date.now();
    const c1 = S.createChat({ title: '旧会话' });
    const c2 = S.createChat({ title: '最新会话' });
    const c3 = S.createChat({ title: '中间会话' });
    S.updateChat(c1.id, { updatedAt: base + 1000 });
    S.updateChat(c2.id, { updatedAt: base + 5000 });
    S.updateChat(c3.id, { updatedAt: base + 3000 });
    equal(S.listChats().map((c) => c.id).join(','), [c2.id, c3.id, c1.id].join(','), 'updatedAt 降序失败');

    S.updateChat(c1.id, { pinned: true });
    equal(S.listChats()[0].id, c1.id, 'pinned 会话应排在最前');
  });

  test('坏 localStorage 数据自动恢复为默认状态', () => {
    const corrupt = loadLogic({ prefs: { 'dsh.v1': '{这不是 JSON' } });
    const S = corrupt.win.Store;
    const state = S.load();
    isObject(state);
    equal(state.version, 1);
    isArray(state.chats);
    equal(state.chats.length, 0);
    equal(S.getPrefs().model, 'deepseek-chat');
    // 恢复后应写回合法 JSON
    const raw = corrupt.win.localStorage.getItem('dsh.v1');
    ok(raw, '恢复后 localStorage 未被重写');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`恢复后 localStorage 仍不是合法 JSON：${String(raw).slice(0, 100)}`);
    }
    equal(parsed.version, 1);

    // 合法 JSON 但结构错误也必须自愈
    const wrongShape = loadLogic({ prefs: { 'dsh.v1': '{"version":1,"chats":"oops","prefs":null}' } });
    const st2 = wrongShape.win.Store.load();
    isArray(st2.chats);
    equal(st2.chats.length, 0);
    equal(wrongShape.win.Store.getPrefs().model, 'deepseek-chat');
  });

  test('数据持久化：save 后 load(true) 可恢复', () => {
    const { win } = loadLogic();
    const S = win.Store;
    const chat = S.createChat({ title: '持久化' });
    S.appendMessage(chat.id, { role: 'user', content: '持久消息' });
    S.load(true); // 强制从 localStorage 重读
    const again = S.getChat(chat.id);
    ok(again, '重新加载后会话丢失');
    equal(again.messages[0].content, '持久消息');
  });

  test('exportChatMarkdown 含标题与角色标签', () => {
    const { win } = loadLogic();
    const S = win.Store;
    const chat = S.createChat({ title: '导出测试' });
    S.appendMessage(chat.id, { role: 'user', content: '用户问题' });
    S.appendMessage({ role: 'assistant', content: '助手回答' });
    const md = S.exportChatMarkdown(chat.id);
    isString(md);
    includes(md, '导出测试', '导出内容缺少会话标题');
    includes(md, '用户', '导出内容缺少用户角色');
    includes(md, 'DeepSeek', '导出内容缺少助手角色');
    includes(md, '用户问题');
    includes(md, '助手回答');
    equal(S.exportChatMarkdown('不存在的 id'), '');
  });

  test('clearAll 清空会话但保留 prefs', () => {
    const { win } = loadLogic();
    const S = win.Store;
    S.setPrefs({ model: 'deepseek-reasoner' });
    S.createChat({ title: '会被清空' });
    S.clearAll();
    equal(S.listChats().length, 0);
    equal(S.getPrefs().model, 'deepseek-reasoner', 'clearAll 不应清空 prefs');
  });

  /* ================================================================== *
   * bridge.js mock 模式
   * ================================================================== */
  suite('单元测试 · bridge.js（mock 模式）');

  test('无 DSNative 时进入 mock 模式（Bridge.__isMock）', () => {
    const { win } = loadLogic();
    isObject(win.Bridge);
    equal(win.Bridge.__isMock, true, '无 DSNative 时应为 mock 模式');
    isFunction(win.Bridge.startChat);
    isFunction(win.Bridge.validateKey);
    isFunction(win.Bridge.onEvent);
  });

  test('mock startChat 能回调多次 chunk 并最终 done', async () => {
    const { win } = loadLogic();
    const B = win.Bridge;
    B.__mockConfig.chunkDelay = 0;
    const chunks = [];
    let doneEvt = null;
    B.onEvent('chunk', (evt) => chunks.push(evt));
    B.onEvent('done', (evt) => {
      doneEvt = evt;
    });
    ok(B.startChat('req-qa-1', { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }) !== false, 'startChat 返回 false');
    await waitFor(() => doneEvt, { timeout: 15000, label: 'mock 流式 done 事件' });
    ok(chunks.length >= 2, `期望至少 2 次 chunk，实际 ${chunks.length}`);
    const text = chunks.map((c) => c.delta || '').join('');
    ok(text.length > 0, 'chunk delta 拼接为空');
    for (const c of chunks) {
      equal(c.type, 'chunk');
      equal(c.requestId, 'req-qa-1');
    }
    equal(doneEvt.type, 'done');
    equal(doneEvt.requestId, 'req-qa-1');
    ok(doneEvt.finishReason, 'done 事件缺少 finishReason');
  });

  test('mock cancelRequest 后不再产生 chunk', async () => {
    const { win } = loadLogic();
    const B = win.Bridge;
    B.__mockConfig.chunkDelay = 5;
    let count = 0;
    B.onEvent('chunk', (evt) => {
      if (evt.requestId === 'req-cancel') count += 1;
    });
    B.startChat('req-cancel', { messages: [] });
    await sleep(30);
    B.cancelRequest('req-cancel');
    const countAfterCancel = count;
    await sleep(120);
    equal(count, countAfterCancel, '取消后仍收到 chunk');
    ok(count >= 1, '取消前应至少收到一个 chunk');
  });

  test('mock prefs 读写（setPrefs/prefs），未知字段忽略', async () => {
    const { win } = loadLogic();
    const B = win.Bridge;
    const before = B.prefs();
    isString(before.baseUrl);
    B.setPrefs({ model: 'deepseek-reasoner', temperature: 0.5, unknownField: 123 });
    const after = B.prefs();
    equal(after.model, 'deepseek-reasoner');
    equal(after.temperature, 0.5);
    ok(!('unknownField' in after), '未知字段不应出现在 prefs 中');
    // getPrefs 别名
    equal(B.getPrefs().model, 'deepseek-reasoner');
  });

  test('mock validateKey 成功触发 validated 事件', async () => {
    const { win } = loadLogic();
    const B = win.Bridge;
    let evt = null;
    B.onEvent('validated', (e) => {
      evt = e;
    });
    B.validateKey('req-valid-1');
    await waitFor(() => evt, { timeout: 5000, label: 'validated 事件' });
    equal(evt.ok, true);
    equal(evt.requestId, 'req-valid-1');
    isArray(evt.models);
    ok(evt.models.includes('deepseek-chat'));
  });

  test('mock 插件存储：pluginWrite → plugins/pluginRead', () => {
    const { win } = loadLogic();
    const B = win.Bridge;
    const code = "window.DSPlugins.register({id:'user.mockqa',name:'QA'})";
    B.pluginWrite('user.mockqa', code, { name: 'QA 插件', version: '1.0.0' });
    const list = B.plugins();
    const item = list.find((p) => p.id === 'user.mockqa');
    ok(item, 'plugins() 中找不到刚写入的插件');
    equal(B.pluginRead('user.mockqa'), code);
    B.pluginSetEnabled('user.mockqa', false);
    equal(B.plugins().find((p) => p.id === 'user.mockqa').enabled, false);
    B.pluginDelete('user.mockqa');
    equal(B.plugins().find((p) => p.id === 'user.mockqa'), undefined);
  });

  test('mock 事件分发：DSHost.onEvent 接受 JSON 字符串并路由', () => {
    const { win } = loadLogic();
    const B = win.Bridge;
    let got = null;
    const off = B.onEvent('chunk', (e) => {
      got = e;
    });
    win.DSHost.onEvent(JSON.stringify({ type: 'chunk', requestId: 'x', delta: 'abc' }));
    ok(got, 'DSHost.onEvent 未路由 chunk 事件');
    equal(got.delta, 'abc');
    off();
    got = null;
    win.DSHost.onEvent(JSON.stringify({ type: 'chunk', requestId: 'x', delta: 'def' }));
    equal(got, null, 'offEvent 后仍收到事件');
  });

  /* ================================================================== *
   * plugins.js + plugins_builtin.js
   * ================================================================== */
  suite('单元测试 · plugins.js / plugins_builtin.js');

  test('内置插件注册（≥3 个，含计算器/时间/网页/提示词）', () => {
    const { win } = loadLogic();
    const P = win.DSPlugins;
    isObject(P);
    const list = P.list();
    ok(list.length >= 3, `SPEC §5.3 要求至少 3 个内置插件，实际 ${list.length}`);
    const ids = list.map((p) => p.id);
    for (const id of ['calculator', 'time', 'web', 'prompts']) {
      ok(ids.includes(id), `缺少内置插件：${id}`);
    }
    for (const p of list) {
      isString(p.id);
      isString(p.name);
      isString(p.version);
      equal(p.builtin, true, `内置插件 ${p.id} 的 builtin 应为 true`);
      ok(p.description, `插件 ${p.id} 缺少 description`);
    }
  });

  test('toolSchemas 结构合法（OpenAI function calling）', () => {
    const { win } = loadLogic();
    const P = win.DSPlugins;
    const schemas = P.toolSchemas();
    isArray(schemas);
    ok(schemas.length >= 1, 'toolSchemas() 为空');
    const names = new Set();
    for (const s of schemas) {
      equal(s.type, 'function');
      isObject(s.function);
      isString(s.function.name);
      ok(s.function.name.length > 0);
      ok(!names.has(s.function.name), `工具名重复：${s.function.name}`);
      names.add(s.function.name);
      isObject(s.function.parameters);
      equal(s.function.parameters.type, 'object', `工具 ${s.function.name} 的 parameters.type 应为 object`);
      isObject(s.function.parameters.properties);
    }
    ok(names.has('calculator'), 'toolSchemas 中缺少内置 calculator 工具');
  });

  test('计算器正确求值：2+3*4=14、(1+2)^3=27、非法表达式不崩', async () => {
    const { win } = loadLogic();
    const P = win.DSPlugins;
    const ctx = P.createContext();
    const r1 = await P.runTool('calculator', { expression: '2+3*4' }, ctx);
    isString(r1, 'runTool 返回值必须是 string');
    includes(r1, '14', `2+3*4 结果错误：${r1}`);

    const r2 = await P.runTool('calculator', { expression: '(1+2)^3' }, ctx);
    includes(r2, '27', `(1+2)^3 结果错误：${r2}`);

    const r3 = await P.runTool('calculator', { expression: '2++' }, ctx);
    isString(r3, '非法表达式应返回错误字符串（不是抛异常）');
    ok(/出错|错误|无法|非法|无效|失败/.test(r3), `非法表达式返回内容不像错误：${r3}`);

    const r4 = await P.runTool('calculator', { expression: 'sqrt(16)+2' }, ctx);
    includes(r4, '6', `sqrt(16)+2 结果错误：${r4}`);
  });

  test('runTool 对未知工具返回 string 而不抛异常', async () => {
    const { win } = loadLogic();
    const P = win.DSPlugins;
    const r = await P.runTool('不存在的工具', {}, P.createContext());
    isString(r);
    ok(r.length > 0, '未知工具应返回说明文本');
  });

  test('禁用内置插件后不暴露工具、isEnabled=false', async () => {
    const { win } = loadLogic();
    const P = win.DSPlugins;
    const before = P.toolSchemas().map((s) => s.function.name);
    ok(before.includes('calculator'), '初始 toolSchemas 应包含 calculator');
    equal(P.setEnabled('calculator', false), true);
    equal(P.isEnabled('calculator'), false);
    const after = P.toolSchemas().map((s) => s.function.name);
    ok(!after.includes('calculator'), '禁用后 toolSchemas 仍暴露 calculator');
    const r = await P.runTool('calculator', { expression: '1+1' }, P.createContext());
    isString(r);
    ok(r.indexOf('未找到') !== -1, `禁用后 runTool 应提示未找到：${r}`);
    // 恢复
    P.setEnabled('calculator', true);
    equal(P.isEnabled('calculator'), true);
  });

  test('register 自定义插件 → toolSchemas/runTool/onChange 生效', async () => {
    const { win } = loadLogic();
    const P = win.DSPlugins;
    let changed = 0;
    const off = P.onChange(() => {
      changed += 1;
    });
    P.register({
      id: 'user.qa',
      name: 'QA 插件',
      version: '1.0.0',
      author: 'verifier',
      description: '测试用插件',
      builtin: false,
      commands: [
        {
          name: 'qa',
          description: '回显',
          run: async (ctx, args) => 'qa:' + args,
        },
      ],
      tools: [
        {
          name: 'qa_echo',
          description: '回显输入',
          parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          run: async (ctx, args) => 'echo:' + (args && args.text),
        },
      ],
    });
    ok(changed >= 1, 'register 后应触发 onChange');
    ok(P.list().some((p) => p.id === 'user.qa'), 'list() 中找不到自定义插件');
    ok(P.get('user.qa'), 'get() 取不到自定义插件');
    const names = P.toolSchemas().map((s) => s.function.name);
    ok(names.includes('qa_echo'), 'toolSchemas 缺少自定义工具');
    const r = await P.runTool('qa_echo', { text: 'hi' }, P.createContext());
    equal(r, 'echo:hi', '自定义工具执行结果错误');
    const cmdResult = await P.runCommand('qa', 'abc', P.createContext());
    equal(cmdResult, 'qa:abc', '自定义命令执行结果错误');
    off();
  });

  test('installFromCode 安装插件并可用；非法代码被拒绝', async () => {
    const { win } = loadLogic();
    const P = win.DSPlugins;
    const code = `// @id user.installed
// @name 安装测试插件
// @version 1.0.0
window.DSPlugins.register({
      id: 'user.installed',
      name: '安装测试插件',
      version: '1.0.0',
      builtin: false,
      commands: [],
      tools: [{
        name: 'installed_tool',
        description: '安装测试工具',
        parameters: { type: 'object', properties: {} },
        run: function () { return 'installed-ok'; }
      }]
    });`;
    await P.installFromCode(code);
    ok(P.list().some((p) => p.id === 'user.installed'), '安装后 list() 中找不到插件');
    const r = await P.runTool('installed_tool', {}, P.createContext());
    equal(r, 'installed-ok', '安装插件的工具执行失败');
    // 源码写入了 Bridge mock 插件存储
    ok(win.Bridge.plugins().some((p) => p.id === 'user.installed'), '安装后未调用 Bridge.pluginWrite 持久化');

    await assertRejects(() => P.installFromCode('// @id user.noreg\nvar noop = 1;'), '没有调用');
    await assertRejects(() => P.installFromCode(''), '空');
  });

  test('installFromCode 无需注释头（SPEC §5.1 元数据「可选」，id 从 register 推导）', async () => {
    const { win } = loadLogic();
    const P = win.DSPlugins;
    const code = `window.DSPlugins.register({
      id: 'user.noheader',
      name: '无注释头插件',
      version: '1.0.0',
      builtin: false,
      commands: [{ name: 'noheader', description: '测试', run: function () { return 'ok'; } }],
      tools: []
    });`;
    await P.installFromCode(code);
    ok(P.list().some((p) => p.id === 'user.noheader'), '无注释头安装后 list() 中找不到插件（SPEC 要求注释头可选）');
    ok(win.Bridge.plugins().some((p) => p.id === 'user.noheader'), '无注释头安装后未持久化');
  });

  test('installFromFile 从 mock 事件导入插件', async () => {
    const { win } = loadLogic();
    const P = win.DSPlugins;
    const result = await P.installFromFile();
    ok(result, 'installFromFile 应返回插件对象/id');
    const id = typeof result === 'string' ? result : result.id;
    isString(id, 'installFromFile 返回值缺少 id');
    ok(P.list().some((p) => p.id === id), `导入后 list() 中没有 ${id}`);
  });

  test('remove 外部插件成功、内置插件不可删除', async () => {
    const { win } = loadLogic();
    const P = win.DSPlugins;
    const code = `// @id user.temp
// @name 临时
window.DSPlugins.register({id:'user.temp',name:'临时',version:'1.0.0',builtin:false,commands:[{name:'temp',description:'t',run:function(){return 't';}}],tools:[]})`;
    await P.installFromCode(code);
    ok(P.list().some((p) => p.id === 'user.temp'));
    equal(await P.remove('user.temp'), true);
    ok(!P.list().some((p) => p.id === 'user.temp'), 'remove 后插件仍存在');
    await assertRejects(() => P.remove('calculator'), '内置插件不能删除');
  });

  test('runCommand：内置 /calc 命令与未知命令', async () => {
    const { win } = loadLogic();
    const P = win.DSPlugins;
    const r = await P.runCommand('calc', '1+2*3', P.createContext());
    isString(r);
    includes(r, '7', `/calc 1+2*3 结果错误：${r}`);
    const unknown = await P.runCommand('不存在的命令', '', P.createContext());
    equal(unknown, null);
  });

  test('DSPlugins 公开 API 齐全（SPEC §5.2）', () => {
    const { win } = loadLogic();
    const P = win.DSPlugins;
    for (const name of [
      'list',
      'get',
      'register',
      'setEnabled',
      'isEnabled',
      'loadExternal',
      'toolSchemas',
      'runTool',
      'runCommand',
      'installFromCode',
      'installFromFile',
      'remove',
      'onChange',
    ]) {
      isFunction(P[name], `DSPlugins.${name} 缺失`);
    }
  });

  /* ================================================================== *
   * bridge.js · ARCH v2 P1 原生封装（DSNative 可用分支）
   * ================================================================== */
  suite('单元测试 · bridge.js P1 原生封装');

  function p1BridgeWindow() {
    const ctx = createUnitWindow();
    const native = createMockNative({
      p1: {
        workspace: { root: '/sdcard/house-workspace', writable: true, allFilesAccess: true, defaultRoot: '/data/private/workspace', isDefault: false },
        auth: { loggedIn: true, phone: '13800000000' },
        audit: [{ id: 'a1', ts: 1700000000000, tool: 'list_dir', args: '{"path":""}', result: 'README.md', ok: true, confirmed: false }],
      },
    });
    native.__bind(ctx.win);
    ctx.win.DSNative = native;
    runWebScripts(ctx, ['util.js', 'bridge.js']);
    return { ...ctx, native };
  }

  test('P1 原生返回值归一化：toolSchemas / workspaceInfo / listDir / auditRecent / authState / getLastError', () => {
    const { win, native } = p1BridgeWindow();
    const B = win.Bridge;
    equal(B.__isMock, false, '注入 DSNative 后不应处于 mock 模式');

    const schemas = B.toolSchemas();
    isArray(schemas, 'toolSchemas() 应返回数组');
    includes(schemas.map((t) => t.function && t.function.name).join(','), 'read_file', 'toolSchemas 缺少 read_file');
    includes(schemas.map((t) => t.function && t.function.name).join(','), 'run_shell', 'toolSchemas 缺少 run_shell');
    ok(native.__calls.some((c) => c.method === 'toolSchemas'), 'Bridge.toolSchemas 未调用原生');

    const ws = B.workspaceInfo();
    isObject(ws, 'workspaceInfo() 应返回对象');
    equal(ws.root, '/sdcard/house-workspace', 'workspaceInfo.root 不正确');
    equal(ws.writable, true, 'workspaceInfo.writable 不正确');
    equal(ws.allFilesAccess, true, 'workspaceInfo.allFilesAccess 不正确');
    equal(ws.defaultRoot, '/data/private/workspace', 'workspaceInfo.defaultRoot 未透传');
    equal(ws.isDefault, false, 'workspaceInfo.isDefault 不正确');

    const entries = B.listDir('');
    isArray(entries, 'listDir() 应返回数组');
    equal(entries.length, 3, 'listDir 应返回 3 个默认条目');
    ok(entries.some((e) => e.name === 'src' && e.isDir === true), 'listDir 结果缺少目录 src');

    // 原生返回 {"error":...} → 归一化为 []，错误经 getLastError 取
    native.__p1.listDirError = '权限被拒绝';
    deepEqual(B.listDir('/sdcard/house-workspace'), [], 'listDir 错误应归一化为空数组');
    equal(B.getLastError('listDir'), '权限被拒绝', 'getLastError(listDir) 未记录原生错误');
    native.__p1.listDirError = '';
    equal(B.listDir('').length, 3, '错误清除后 listDir 应恢复');

    const audit = B.auditRecent(50);
    isArray(audit, 'auditRecent() 应返回数组');
    equal(audit.length, 1, 'auditRecent 数量不正确');
    equal(audit[0].tool, 'list_dir', '审计 tool 字段不正确');
    equal(audit[0].ok, true, '审计 ok 字段不正确');
    equal(audit[0].confirmed, false, '审计 confirmed 字段不正确');

    const auth = B.authState();
    equal(auth.loggedIn, true, 'authState.loggedIn 不正确');
    equal(auth.phone, '13800000000', 'authState.phone 不正确');
  });

  test('P1 方法转发：execTool/confirmTool/readFile/writeFile/runShell/setWorkspace/requestOtp/verifyOtp/logout', async () => {
    const { win, native } = p1BridgeWindow();
    const B = win.Bridge;

    equal(B.execTool('rid_tool', 'write_file', '{"path":"a.txt"}'), true, 'execTool 应返回 true');
    const exec = native.__calls.filter((c) => c.method === 'execTool').pop();
    deepEqual(exec.args, ['rid_tool', 'write_file', '{"path":"a.txt"}'], 'execTool 参数未透传');
    equal(B.confirmTool('rid_tool', true), true, 'confirmTool 应返回 true');
    deepEqual(native.__calls.filter((c) => c.method === 'confirmTool').pop().args, ['rid_tool', true], 'confirmTool 参数未透传');

    B.readFile('rid_read', 'README.md');
    B.writeFile('rid_write', 'a.txt', 'hello');
    B.runShell('rid_shell', 'echo hi');
    deepEqual(native.__calls.filter((c) => c.method === 'readFile').pop().args, ['rid_read', 'README.md'], 'readFile 参数未透传');
    deepEqual(native.__calls.filter((c) => c.method === 'writeFile').pop().args, ['rid_write', 'a.txt', 'hello'], 'writeFile 参数未透传');
    deepEqual(native.__calls.filter((c) => c.method === 'runShell').pop().args, ['rid_shell', 'echo hi'], 'runShell 参数未透传');

    equal(B.setWorkspace('/sdcard/qa-ws'), true, 'setWorkspace 应返回 true');
    equal(native.__calls.filter((c) => c.method === 'setWorkspace').pop().args[0], '/sdcard/qa-ws', 'setWorkspace 参数未透传');

    equal(B.requestOtp('138-0000-0001'), true, 'requestOtp 应返回 true 且手机号需去除分隔符');
    equal(native.__calls.filter((c) => c.method === 'requestOtp').pop().args[0], '13800000001', 'requestOtp 手机号归一化不正确');

    // verifyOtp + waitOtpVerified：事件由 __emit 注入
    equal(B.verifyOtp('rid_otp', '13800000001', '123456'), true, 'verifyOtp 应返回 true');
    deepEqual(native.__calls.filter((c) => c.method === 'verifyOtp').pop().args, ['rid_otp', '13800000001', '123456'], 'verifyOtp 参数未透传');
    const otpWaiter = B.waitOtpVerified('rid_otp', 1000);
    native.__emit({ type: 'otp-verified', requestId: 'rid_otp', ok: true, message: '' });
    const otpEvt = await otpWaiter;
    equal(otpEvt && otpEvt.ok, true, 'waitOtpVerified 未收到 otp-verified');

    // tool-result 的 Promise 通道
    const toolWaiter = B.waitToolResult('rid_tool', 1000);
    native.__emit({ type: 'tool-result', requestId: 'rid_tool', tool: 'write_file', ok: true, result: 'ok', confirmed: true });
    const toolEvt = await toolWaiter;
    equal(toolEvt && toolEvt.result, 'ok', 'waitToolResult 未收到 tool-result');

    equal(B.logout(), true, 'logout 应返回 true');
    ok(native.__calls.some((c) => c.method === 'logout'), 'Bridge.logout 未调用原生');
    const after = B.authState();
    equal(after.loggedIn, false, 'logout 后 authState.loggedIn 应为 false');
    equal(after.phone, '13800000000', 'logout 后应保留绑定手机号');
  });

}
