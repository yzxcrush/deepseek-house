/**
 * scripts/qa/p1-integration-tests.mjs
 * ARCH v2 P1（本地 Agent 工作站）集成用例：真实 index.html + 全部 JS + mock DSNative。
 *
 * 覆盖：
 *   - 原生工具框架：tools 合并/去重（native 优先）、LOW 直接执行、
 *     MID/HIGH tool-confirm → UI 风险弹窗 → confirmTool → tool-result →
 *     role:'tool' 消息（toolName/args/result/ok/confirmState）→ 继续请求、拒绝路径。
 *   - 文件树抽屉：open-files → listDir → renderFileTree → 目录/文件点击参数 → listDir 错误行。
 *   - 终端面板：toggle-terminal → terminal-run → runShell → tool-result → appendTerminal → 输入恢复。
 *   - 审计日志：个人资料 → open-audit → auditRecent → renderAudit 字段/时间/状态。
 *   - 手机号登录：登录 tab 切换、requestOtp + otp-sent（demoCode/倒计时）、
 *     verifyOtp + otp-verified 成功进入会话列表 / 失败错误提示、authState 启动分支、logout。
 *   - 工作区：workspaceInfo 设置行、setWorkspace → workspace-changed 回填、恢复默认。
 *
 * 每个用例使用**独立 jsdom 窗口**，保证互不影响、可单独复现。
 */

import { suite, test, ok, equal, includes, notIncludes, isObject } from './lib/harness.mjs';
import { loadAppWindow, waitFor, click, isScreenActive } from './lib/env.mjs';

const P1_ROOT = '/sdcard/house-workspace';
const P1_PRIVATE_ROOT = '/data/user/0/com.deepseekhouse.app/files/workspace';
const API_KEY_PREFS = { apiKey: 'sk-qa-p1-valid-key' };

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
const byId = (app, id) => app.doc.getElementById(id);
const q = (app, sel) => app.doc.querySelector(sel);
const qa = (app, sel) => Array.from(app.doc.querySelectorAll(sel));

function nativeCalls(app, method) {
  return app.native.__calls.filter((c) => c.method === method);
}
function lastNative(app, method) {
  const list = nativeCalls(app, method);
  return list.length ? list[list.length - 1] : null;
}
function emit(app, evt) {
  app.native.__emit(evt);
}
function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function lastChatBody(app) {
  const call = lastNative(app, 'startChat');
  return call ? parseJson(call.args[1]) : null;
}
function toolSchemaNames(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((t) => (t && ((t.function && t.function.name) || t.name)) || '')
    .filter(Boolean);
}

/** 载入并等待启动结束（有 Key → 会话列表；无 Key → 登录页；authState 已登录 → 会话列表）。 */
async function bootApp(nativeOpts = {}) {
  const app = await loadAppWindow({ native: nativeOpts });
  app.doc = app.win.document;
  await waitFor(
    () => isScreenActive(app.win, 'screen-chats') || isScreenActive(app.win, 'screen-login'),
    { timeout: 8000, label: '应用启动（会话列表/登录页）' },
  );
  return app;
}

function closeApp(app) {
  try {
    app.dom.window.close();
  } catch {
    /* ignore */
  }
}

/** 从会话列表点 FAB 进入对话页（fresh 窗口无历史会话）。 */
async function openChatScreen(app) {
  const w = app.win;
  await waitFor(() => isScreenActive(w, 'screen-chats'), { timeout: 6000, label: '会话列表显示' });
  const fab = q(app, '.fab[data-action="new-chat"]');
  ok(fab, '缺少 FAB 新建会话按钮');
  click(w, fab);
  await waitFor(() => isScreenActive(w, 'screen-chat'), { timeout: 6000, label: '进入对话页' });
  return w;
}

/** 在输入框输入文本并点发送，返回本轮 startChat 的 requestId 与请求体。 */
async function sendMessage(app, text) {
  const w = app.win;
  const before = nativeCalls(app, 'startChat').length;
  const input = byId(app, 'composer-input');
  ok(input, '缺少 #composer-input');
  input.value = text;
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  click(w, q(app, '[data-action="send"]'));
  await waitFor(() => nativeCalls(app, 'startChat').length > before, { timeout: 6000, label: 'Bridge.startChat 调用' });
  const call = lastNative(app, 'startChat');
  return { requestId: call.args[0], body: parseJson(call.args[1]) };
}

/** 模型返回一轮 tool_calls（chunk 携带 + done finishReason=tool_calls）。 */
function emitToolCalls(app, requestId, calls) {
  emit(app, { type: 'chunk', requestId, delta: '', reasoning: '', toolCalls: calls });
  emit(app, {
    type: 'done',
    requestId,
    finishReason: 'tool_calls',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function oneToolCall(id, name, args) {
  return [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }];
}

/** 触发一次 native 工具调用，等待 execTool 被调用，返回 execTool 的参数。 */
async function triggerNativeTool(app, text, name, args, callId) {
  const { requestId } = await sendMessage(app, text);
  const before = nativeCalls(app, 'execTool').length;
  emitToolCalls(app, requestId, oneToolCall(callId, name, args));
  await waitFor(() => nativeCalls(app, 'execTool').length > before, { timeout: 6000, label: `Bridge.execTool(${name}) 调用` });
  const call = lastNative(app, 'execTool');
  return { requestId, toolRequestId: call.args[0], name: call.args[1], argsJson: call.args[2], args: parseJson(call.args[2]) };
}

async function waitToolMessage(app, predicate) {
  await waitFor(
    () => {
      const chat = app.win.Store.getActiveChat();
      return !!chat && chat.messages.some((m) => m.role === 'tool' && predicate(m));
    },
    { timeout: 6000, label: 'role:"tool" 消息入库' },
  );
  const chat = app.win.Store.getActiveChat();
  return chat.messages.filter((m) => m.role === 'tool').pop();
}

async function waitRiskModal(app, open) {
  await waitFor(
    () => byId(app, 'risk-modal').classList.contains('is-open') === open,
    { timeout: 5000, label: open ? '高危风险弹窗打开' : '高危风险弹窗关闭' },
  );
}

async function waitContinueRequest(app, expected) {
  await waitFor(() => nativeCalls(app, 'startChat').length >= expected, { timeout: 8000, label: '工具循环继续请求（下一轮 startChat）' });
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */
export function registerP1IntegrationTests() {
  /* ================================================================ *
   * 原生工具框架
   * ================================================================ */
  suite('P1 集成 · 原生工具框架（tools / 确认 / 结果 / 拒绝）');

  test('发送消息：startChat 请求 tools = 插件工具 + 原生工具，同名工具 native 优先且去重', async () => {
    const app = await bootApp({
      prefs: API_KEY_PREFS,
      p1: {
        tools: [
          {
            type: 'function',
            risk: 'low',
            function: {
              name: 'calculator',
              description: 'NATIVE_CALCULATOR（原生同名工具，应覆盖插件版本）',
              parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
            },
          },
          {
            type: 'function',
            risk: 'low',
            function: {
              name: 'list_dir',
              description: 'NATIVE_LIST_DIR',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          },
        ],
      },
    });
    try {
      const w = app.win;
      await openChatScreen(app);
      // 插件侧确实存在同名工具，才能证明「去重」
      ok(w.DSPlugins.toolSchemas().some((t) => t.function && t.function.name === 'calculator'),
        '插件未暴露 calculator，无法验证同名去重');

      const { body } = await sendMessage(app, '请调用工具');
      ok(nativeCalls(app, 'toolSchemas').length > 0, '应用未调用 DSNative.toolSchemas()');
      ok(Array.isArray(body && body.tools), 'startChat 请求体缺少 tools 数组');
      const names = toolSchemaNames(body.tools);
      includes(names.join(','), 'list_dir', 'startChat tools 缺少原生工具 list_dir');
      includes(names.join(','), 'calculator', 'startChat tools 缺少工具 calculator');
      equal(new Set(names).size, names.length, `tools 存在重名（未去重）：${names.join(',')}`);
      const calc = body.tools.filter((t) => (t.function && t.function.name) === 'calculator');
      equal(calc.length, 1, 'calculator 应只出现一次（native 优先）');
      includes(String(calc[0].function.description || ''), 'NATIVE_CALCULATOR', '同名校验失败：calculator 未使用 native 定义（native 应优先）');
      // 非冲突插件工具仍保留
      ok(w.DSPlugins.toolSchemas().some((t) => t.function && t.function.name === 'current_time'), '插件工具 current_time 缺失');
      includes(names.join(','), 'current_time', 'startChat tools 丢失非冲突插件工具');
      equal(w.App.isNativeTool('calculator'), true, 'App.isNativeTool(calculator) 应为 true');
      equal(w.App.isNativeTool('current_time'), false, 'App.isNativeTool(current_time) 应为 false');
    } finally {
      closeApp(app);
    }
  });

  test('LOW 工具（list_dir）不需要确认：直接 execTool → tool-result → tool 消息（confirmState=success）', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      await openChatScreen(app);
      const tool = await triggerNativeTool(app, '列出工作区文件', 'list_dir', { path: '' }, 'call_p1_list');
      equal(tool.name, 'list_dir', 'execTool 工具名应为 list_dir');
      isObject(tool.args, 'execTool 第三参应为 JSON 字符串（可解析为对象）');
      ok(String(tool.toolRequestId).length > 0, 'execTool requestId 不能为空');
      equal(byId(app, 'risk-modal').classList.contains('is-open'), false, 'LOW 工具不应弹出风险确认');

      const resultText = JSON.stringify([{ name: 'README.md', path: P1_ROOT + '/README.md', isDir: false, size: 12 }]);
      emit(app, { type: 'tool-result', requestId: tool.toolRequestId, tool: 'list_dir', ok: true, result: resultText, confirmed: false });
      const msg = await waitToolMessage(app, (m) => m.toolName === 'list_dir');
      equal(msg.toolName, 'list_dir', 'tool 消息 toolName 不正确');
      equal(msg.toolCallId, 'call_p1_list', 'tool 消息 toolCallId 未透传');
      equal(msg.ok, true, 'tool 消息 ok 应为 true');
      equal(msg.confirmed, false, 'LOW 工具 confirmed 应为 false');
      equal(msg.confirmState, 'success', 'LOW 工具 confirmState 应为 success');
      includes(String(msg.result), 'README.md', 'tool 消息 result 丢失工具结果');
      equal(nativeCalls(app, 'confirmTool').length, 0, 'LOW 工具不应调用 confirmTool');

      await waitContinueRequest(app, 2);
      const cont = lastChatBody(app);
      const toolIdx = cont.messages.findIndex((m) => m.role === 'tool');
      ok(toolIdx > 0, '继续请求历史缺少 role:"tool" 消息');
      equal(cont.messages[toolIdx - 1].role, 'assistant', 'tool 消息前应为 assistant(tool_calls)');
      const apiToolCalls = cont.messages[toolIdx - 1].tool_calls;
      ok(Array.isArray(apiToolCalls) && apiToolCalls.length > 0,
        'assistant 消息缺少 tool_calls 记录（OpenAI 工具调用回传格式）');
      equal(apiToolCalls[0].function.name, 'list_dir', 'tool_calls 工具名不正确');
      includes(String(apiToolCalls[0].function.arguments), '"path"', 'tool_calls 参数丢失原始 arguments');
    } finally {
      closeApp(app);
    }
  });

  test('MID 工具（write_file）：tool-confirm → 风险弹窗 → 允许 → confirmTool(true) → tool-result → tool 消息 + 继续请求', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const w = app.win;
      await openChatScreen(app);
      const tool = await triggerNativeTool(app, '把 hello 写入 qa.txt', 'write_file', { path: 'qa.txt', content: 'hello' }, 'call_p1_write');
      equal(tool.name, 'write_file', 'execTool 工具名应为 write_file');
      equal(tool.args.path, 'qa.txt', 'execTool 参数丢失 path');

      // 原生侧发出 tool-confirm（MID 风险）
      emit(app, { type: 'tool-confirm', requestId: tool.toolRequestId, tool: 'write_file', args: tool.args, risk: 'mid' });
      await waitRiskModal(app, true);
      equal(byId(app, 'risk-tool').textContent, 'write_file', '#risk-tool 应显示工具名');
      includes(byId(app, 'risk-badge').textContent, 'MID', '#risk-badge 应显示 MID');
      includes(byId(app, 'risk-args').textContent, 'qa.txt', '#risk-args 应显示参数 JSON');
      equal(byId(app, 'risk-modal').getAttribute('aria-hidden'), 'false', '风险弹窗 aria-hidden 应为 false');

      // 允许执行 → confirmTool(requestId, true)
      const confirmBefore = nativeCalls(app, 'confirmTool').length;
      click(w, byId(app, 'risk-accept'));
      await waitFor(() => nativeCalls(app, 'confirmTool').length > confirmBefore, { timeout: 5000, label: 'Bridge.confirmTool 调用' });
      const confirm = lastNative(app, 'confirmTool');
      equal(confirm.args[0], tool.toolRequestId, 'confirmTool requestId 与 execTool 不一致');
      equal(confirm.args[1], true, '允许执行时 confirmTool 第二参应为 true');
      await waitRiskModal(app, false);

      // 原生回 tool-result
      emit(app, {
        type: 'tool-result',
        requestId: tool.toolRequestId,
        tool: 'write_file',
        ok: true,
        result: '已写入 ' + P1_ROOT + '/qa.txt（5 字符）',
        confirmed: true,
      });
      const msg = await waitToolMessage(app, (m) => m.toolName === 'write_file');
      equal(msg.toolName, 'write_file', 'tool 消息 toolName 不正确');
      isObject(msg.args, 'tool 消息 args 应为对象');
      equal(msg.args.path, 'qa.txt', 'tool 消息 args.path 丢失');
      equal(msg.args.content, 'hello', 'tool 消息 args.content 丢失');
      includes(String(msg.result), '已写入', 'tool 消息 result 丢失');
      equal(msg.ok, true, 'tool 消息 ok 应为 true');
      equal(msg.confirmed, true, '确认执行后 tool 消息 confirmed 应为 true');
      equal(msg.confirmState, 'success', '确认执行后 confirmState 应为 success');

      // 消息流渲染工具卡片
      await waitFor(() => qa(app, '.msg--tool').length > 0, { timeout: 4000, label: '工具卡片渲染到消息流' });
      const card = qa(app, '.msg--tool').pop();
      includes(String(card.textContent), 'write_file', '工具卡片未显示工具名');
      includes(String(card.textContent), '成功', '工具卡片未显示成功状态');
      includes(String(card.textContent), '已写入', '工具卡片未显示结果');

      // 工具循环继续请求（同一 assistant 轮次 → 下一轮 startChat）
      await waitContinueRequest(app, 2);
      const cont = lastChatBody(app);
      ok(Array.isArray(cont.tools) && toolSchemaNames(cont.tools).includes('write_file'), '继续请求丢失 tools');
      const toolIdx = cont.messages.findIndex((m) => m.role === 'tool');
      ok(toolIdx > 0, '继续请求历史缺少 role:"tool" 消息');
      includes(String(cont.messages[toolIdx].content), '已写入', '继续请求中 tool 消息内容丢失');
    } finally {
      closeApp(app);
    }
  });

  test('HIGH 工具（run_shell）拒绝：confirmTool(false) → 用户拒绝执行 → tool 消息 confirmState=rejected + 继续请求', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const w = app.win;
      await openChatScreen(app);
      const tool = await triggerNativeTool(app, '执行 echo hi', 'run_shell', { command: 'echo hi' }, 'call_p1_shell');
      equal(tool.name, 'run_shell', 'execTool 工具名应为 run_shell');
      equal(tool.args.command, 'echo hi', 'execTool 参数丢失 command');

      emit(app, { type: 'tool-confirm', requestId: tool.toolRequestId, tool: 'run_shell', args: tool.args, risk: 'high' });
      await waitRiskModal(app, true);
      includes(byId(app, 'risk-badge').textContent, 'HIGH', '#risk-badge 应显示 HIGH');
      includes(byId(app, 'risk-hint').textContent, '风险较高', 'HIGH 风险弹窗应显示更高风险提示');

      const confirmBefore = nativeCalls(app, 'confirmTool').length;
      click(w, byId(app, 'risk-deny'));
      await waitFor(() => nativeCalls(app, 'confirmTool').length > confirmBefore, { timeout: 5000, label: '拒绝时 Bridge.confirmTool 调用' });
      const confirm = lastNative(app, 'confirmTool');
      equal(confirm.args[0], tool.toolRequestId, 'confirmTool requestId 不正确');
      equal(confirm.args[1], false, '拒绝时 confirmTool 第二参应为 false');
      await waitRiskModal(app, false);

      // 原生拒绝后回 tool-result（SPEC：ok:false,result:"用户拒绝执行"）
      emit(app, { type: 'tool-result', requestId: tool.toolRequestId, tool: 'run_shell', ok: false, result: '用户拒绝执行', confirmed: false });
      const msg = await waitToolMessage(app, (m) => m.toolName === 'run_shell');
      equal(msg.toolName, 'run_shell', 'tool 消息 toolName 不正确');
      equal(msg.ok, false, '拒绝后 tool 消息 ok 应为 false');
      equal(msg.confirmed, false, '拒绝后 tool 消息 confirmed 应为 false');
      equal(msg.confirmState, 'rejected', '拒绝后 confirmState 应为 rejected');
      includes(String(msg.content), '用户拒绝执行', '拒绝后 tool 消息应包含「用户拒绝执行」');
      includes(String(msg.result), '用户拒绝执行', '拒绝后 tool 消息 result 应包含「用户拒绝执行」');
      await waitFor(() => qa(app, '.msg--tool .tool-badge--rejected').length > 0, { timeout: 4000, label: '工具卡片显示已拒绝' });
      equal(qa(app, '.msg--tool .tool-badge--rejected').pop().textContent, '已拒绝', '工具卡片状态应为「已拒绝」');

      await waitContinueRequest(app, 2);
      const cont = lastChatBody(app);
      const toolMsg = cont.messages.filter((m) => m.role === 'tool').pop();
      ok(toolMsg, '继续请求历史缺少 tool 消息');
      includes(String(toolMsg.content), '用户拒绝执行', '继续请求中拒绝结果丢失');
    } finally {
      closeApp(app);
    }
  });

  /* ================================================================ *
   * 工作区文件树
   * ================================================================ */
  suite('P1 集成 · 工作区文件树（listDir / 目录 / 文件 / 错误）');

  test('点顶栏「文件」→ 抽屉打开 → listDir(工作区根) → 渲染目录与文件行', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const w = app.win;
      await openChatScreen(app);
      const before = nativeCalls(app, 'listDir').length;
      click(w, q(app, '[data-action="open-files"]'));
      await waitFor(() => nativeCalls(app, 'listDir').length > before, { timeout: 5000, label: 'Bridge.listDir 调用' });
      const call = lastNative(app, 'listDir');
      equal(call.args[0], P1_ROOT, 'listDir 默认应列出工作区根目录');

      await waitFor(() => byId(app, 'file-drawer').classList.contains('is-open'), { timeout: 4000, label: '文件抽屉打开' });
      equal(byId(app, 'file-drawer').getAttribute('aria-hidden'), 'false', '文件抽屉 aria-hidden 应为 false');
      equal(byId(app, 'file-root').textContent, P1_ROOT, '#file-root 应显示工作区根路径');
      await waitFor(() => qa(app, '#file-tree .file-node').length >= 3, { timeout: 4000, label: '文件树渲染行' });
      const rows = qa(app, '#file-tree .file-node');
      equal(rows.length, 3, '默认 mock 工作区应渲染 3 行');
      includes(String(byId(app, 'file-tree').textContent), 'README.md', '文件树缺少 README.md');
      includes(String(byId(app, 'file-tree').textContent), 'notes.txt', '文件树缺少 notes.txt');
      includes(String(byId(app, 'file-tree').textContent), 'src', '文件树缺少目录 src');
      equal(qa(app, '#file-tree .file-node--dir').length, 1, '应渲染 1 个目录行');
      equal(qa(app, '#file-tree .file-node--file').length, 2, '应渲染 2 个文件行');
      includes(String(byId(app, 'file-foot').textContent), '3 项', '#file-foot 应显示条目数');
    } finally {
      closeApp(app);
    }
  });

  test('点目录 → listDir(目录路径)；点文件 → readFile(文件路径) → tool-result → 文件预览弹窗', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const w = app.win;
      await openChatScreen(app);
      click(w, q(app, '[data-action="open-files"]'));
      await waitFor(() => qa(app, '#file-tree .file-node').length >= 3, { timeout: 5000, label: '文件树渲染' });

      // 1) 点目录 src → listDir(<root>/src)
      const dirRow = q(app, '#file-tree .file-node--dir');
      ok(dirRow, '未找到目录行');
      const dirPath = dirRow.getAttribute('data-path');
      const listBefore = nativeCalls(app, 'listDir').length;
      click(w, dirRow);
      await waitFor(() => nativeCalls(app, 'listDir').length > listBefore, { timeout: 5000, label: '点目录后 listDir 调用' });
      equal(lastNative(app, 'listDir').args[0], dirPath, '点目录应 listDir(目录路径)');
      await waitFor(() => qa(app, '#file-tree .file-node').length === 1, { timeout: 4000, label: '目录内容渲染' });
      includes(String(byId(app, 'file-tree').textContent), 'app.js', '目录内容缺少 app.js');
      includes(String(byId(app, 'file-crumbs').textContent), 'src', '面包屑未显示 src');

      // 2) 点文件 → readFile(requestId, 文件路径) + tool-result → 预览弹窗
      const fileRow = q(app, '#file-tree .file-node--file');
      ok(fileRow, '未找到文件行');
      const filePath = fileRow.getAttribute('data-path');
      const readBefore = nativeCalls(app, 'readFile').length;
      click(w, fileRow);
      await waitFor(() => nativeCalls(app, 'readFile').length > readBefore, { timeout: 5000, label: '点文件后 readFile 调用' });
      const read = lastNative(app, 'readFile');
      equal(read.args[1], filePath, '点文件应 readFile(文件路径)');
      ok(String(read.args[0]).length > 0, 'readFile requestId 不能为空');
      emit(app, {
        type: 'tool-result',
        requestId: read.args[0],
        tool: 'read_file',
        ok: true,
        result: '// mock 源文件\nconsole.log("hello from mock workspace");\n',
        confirmed: true,
      });
      await waitFor(() => byId(app, 'file-preview-modal').classList.contains('is-open'), { timeout: 5000, label: '文件预览弹窗打开' });
      equal(byId(app, 'file-preview-name').textContent, 'app.js', '#file-preview-name 应显示文件名');
      equal(byId(app, 'file-preview-path').textContent, filePath, '#file-preview-path 应显示完整路径');
      includes(String(byId(app, 'file-preview-content').textContent), 'hello from mock workspace', '预览内容缺失');
      equal(app.win.App.getFilePreview().path, filePath, 'App.getFilePreview() 路径不正确');
    } finally {
      closeApp(app);
    }
  });

  test('listDir 返回 {error} → 文件树显示错误行（目录读取失败）', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const w = app.win;
      await openChatScreen(app);
      app.native.__p1.listDirError = '权限被拒绝：无法访问 /sdcard/house-workspace';
      click(w, q(app, '[data-action="open-files"]'));
      await waitFor(() => qa(app, '#file-tree .file-empty--error').length > 0, { timeout: 5000, label: '文件树错误行' });
      const errorRow = q(app, '#file-tree .file-empty--error');
      includes(String(errorRow.textContent), '目录读取失败', '错误行文案不正确');
      includes(String(errorRow.textContent), '权限被拒绝', '错误行未显示原生错误信息');
      includes(String(byId(app, 'file-foot').textContent), '目录读取失败', '#file-foot 未显示错误状态');
      equal(qa(app, '#file-tree .file-node').length, 0, '错误时不应渲染目录行');
    } finally {
      closeApp(app);
    }
  });

  /* ================================================================ *
   * 终端
   * ================================================================ */
  suite('P1 集成 · 终端面板（runShell / appendTerminal）');

  test('切换终端 → 输入命令执行 → runShell 调用 → tool-result → appendTerminal 输出 → 输入恢复', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const w = app.win;
      await openChatScreen(app);
      const panel = byId(app, 'terminal-panel');
      ok(panel, '缺少 #terminal-panel');
      equal(panel.getAttribute('aria-hidden'), 'true', '终端面板初始应为收起状态（aria-hidden=true）');

      click(w, q(app, '[data-action="toggle-terminal"]'));
      await waitFor(() => panel.hidden === false, { timeout: 4000, label: '终端面板展开' });
      equal(panel.getAttribute('aria-hidden'), 'false', '终端面板 aria-hidden 应为 false');
      ok(byId(app, 'app').classList.contains('is-terminal-open'), '聊天页应带 is-terminal-open');

      const input = byId(app, 'terminal-input');
      input.value = 'echo hi';
      const shellBefore = nativeCalls(app, 'runShell').length;
      click(w, byId(app, 'terminal-run'));
      await waitFor(() => nativeCalls(app, 'runShell').length > shellBefore, { timeout: 5000, label: 'Bridge.runShell 调用' });
      const call = lastNative(app, 'runShell');
      equal(call.args[1], 'echo hi', 'runShell 命令参数不正确');
      ok(String(call.args[0]).length > 0, 'runShell requestId 不能为空');
      equal(byId(app, 'terminal-input').disabled, true, '执行期间终端输入应禁用');
      includes(String(byId(app, 'terminal-run').textContent), '执行中', '执行期间按钮应显示「执行中…」');

      // 原生回 tool-result → appendTerminal 输出
      emit(app, { type: 'tool-result', requestId: call.args[0], tool: 'run_shell', ok: true, result: 'hi\n', confirmed: false });
      await waitFor(() => String(byId(app, 'terminal-output').textContent).indexOf('hi') !== -1, { timeout: 5000, label: '终端输出渲染' });
      const output = String(byId(app, 'terminal-output').textContent);
      includes(output, '$ echo hi', '终端输出缺少命令回显');
      includes(output, 'hi', '终端输出缺少命令结果');
      await waitFor(() => byId(app, 'terminal-input').disabled === false, { timeout: 4000, label: '终端输入恢复可用' });
      equal(byId(app, 'terminal-run').textContent, '执行', '执行完成后按钮文案应恢复为「执行」');
      // 再次输入可用
      input.value = 'pwd';
      equal(input.value, 'pwd', '终端输入框不可再次输入');
    } finally {
      closeApp(app);
    }
  });

  /* ================================================================ *
   * 审计日志
   * ================================================================ */
  suite('P1 集成 · 审计日志（auditRecent / renderAudit）');

  test('个人资料 → 审计日志 → auditRecent(50) → 列表渲染时间/工具/成功失败/是否确认', async () => {
    const audit = [
      { id: 'a2', ts: Date.parse('2026-10-29T10:20:30'), tool: 'write_file', args: '{"path":"qa.txt"}', result: '已写入', ok: true, confirmed: true },
      { id: 'a1', ts: Date.parse('2026-10-29T10:18:00'), tool: 'run_shell', args: '{"command":"rm -rf /"}', result: '用户拒绝执行', ok: false, confirmed: false },
    ];
    const app = await bootApp({ prefs: API_KEY_PREFS, p1: { audit } });
    try {
      const w = app.win;
      click(w, q(app, '[data-action="nav-profile"]'));
      await waitFor(() => isScreenActive(w, 'screen-profile'), { timeout: 5000, label: '个人资料页' });
      const auditBefore = nativeCalls(app, 'auditRecent').length;
      click(w, q(app, '#screen-profile [data-action="open-audit"]'));
      await waitFor(() => nativeCalls(app, 'auditRecent').length > auditBefore, { timeout: 5000, label: 'Bridge.auditRecent 调用' });
      equal(lastNative(app, 'auditRecent').args[0], 50, 'auditRecent 默认 limit 应为 50');
      await waitFor(() => isScreenActive(w, 'screen-audit'), { timeout: 4000, label: '审计日志页' });
      await waitFor(() => qa(app, '#audit-list .audit-row').length === 2, { timeout: 4000, label: '审计列表渲染 2 行' });

      const rows = qa(app, '#audit-list .audit-row');
      const row0 = rows[0].textContent || '';
      const row1 = rows[1].textContent || '';
      includes(row0, 'write_file', '第 1 行缺少工具名');
      includes(row0, '成功', '第 1 行应显示成功');
      includes(row0, '已确认', '第 1 行应显示已确认');
      includes(row1, 'run_shell', '第 2 行缺少工具名');
      includes(row1, '失败', '第 2 行应显示失败');
      includes(row1, '未确认/拒绝', '失败且未确认应显示「未确认/拒绝」');
      includes(row1, '用户拒绝执行', '第 2 行应显示结果');
      // 时间格式 YYYY-MM-DD HH:MM:SS
      const timeText = String(q(app, '#audit-list .audit-time').textContent || '');
      ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timeText), `审计时间格式不正确：${timeText}`);
      includes(String(byId(app, 'audit-count').textContent), '2 条记录', '#audit-count 应显示条数');
      equal(byId(app, 'audit-empty').hidden, true, '有记录时不应显示空状态');
      ok(byId(app, 'screen-audit').getAttribute('aria-hidden') === 'false', '审计页应可见');
    } finally {
      closeApp(app);
    }
  });

  /* ================================================================ *
   * 手机号登录
   * ================================================================ */
  suite('P1 集成 · 手机号登录（OTP）');

  test('登录页 tab 切换：API Key ↔ 手机号登录表单互斥显示', async () => {
    const app = await bootApp({ prefs: { apiKey: '' } });
    try {
      const w = app.win;
      await waitFor(() => isScreenActive(w, 'screen-login'), { timeout: 5000, label: '登录页显示' });
      ok(byId(app, 'login-tabs'), '缺少 #login-tabs');
      equal(qa(app, '#login-tabs [data-login-tab]').length, 2, '登录 tab 应有 2 个');
      ok(byId(app, 'login-form').hidden === false, '默认应显示 API Key 表单');
      ok(byId(app, 'login-phone-form').hidden === true, '默认应隐藏手机号表单');

      click(w, q(app, '#login-tabs [data-login-tab="phone"]'));
      await waitFor(() => byId(app, 'login-phone-form').hidden === false, { timeout: 3000, label: '手机号表单显示' });
      equal(byId(app, 'login-form').hidden, true, '切换到手机号后 API Key 表单应隐藏');
      equal(q(app, '#login-tabs [data-login-tab="phone"]').getAttribute('aria-selected'), 'true', '手机号 tab aria-selected 应为 true');
      ok(q(app, '#login-tabs [data-login-tab="phone"]').classList.contains('is-active'), '手机号 tab 应高亮');

      click(w, q(app, '#login-tabs [data-login-tab="apikey"]'));
      await waitFor(() => byId(app, 'login-form').hidden === false, { timeout: 3000, label: '切回 API Key 表单' });
      equal(byId(app, 'login-phone-form').hidden, true, '切回后手机号表单应隐藏');
    } finally {
      closeApp(app);
    }
  });

  test('发送验证码：requestOtp(phone) → otp-sent(demoCode/ttl) → 60s 倒计时 + demoCode 提示', async () => {
    const app = await bootApp({ prefs: { apiKey: '' } });
    try {
      const w = app.win;
      await waitFor(() => isScreenActive(w, 'screen-login'), { timeout: 5000, label: '登录页显示' });
      click(w, q(app, '#login-tabs [data-login-tab="phone"]'));
      const phone = '13800000000';
      const phoneInput = byId(app, 'login-phone');
      phoneInput.value = phone;
      phoneInput.dispatchEvent(new w.Event('input', { bubbles: true }));
      const otpBefore = nativeCalls(app, 'requestOtp').length;
      click(w, byId(app, 'login-send-otp'));
      await waitFor(() => nativeCalls(app, 'requestOtp').length > otpBefore, { timeout: 5000, label: 'Bridge.requestOtp 调用' });
      equal(lastNative(app, 'requestOtp').args[0], phone, 'requestOtp 手机号参数不正确');
      await waitFor(() => byId(app, 'login-send-otp').disabled === true, { timeout: 3000, label: '发送按钮进入倒计时' });
      ok(/60s 后重发/.test(String(byId(app, 'login-send-otp').textContent)), `倒计时文案不正确：${byId(app, 'login-send-otp').textContent}`);

      emit(app, { type: 'otp-sent', phone, ttlSeconds: 300, demoCode: '654321', message: '' });
      await waitFor(() => byId(app, 'login-otp-hint').hidden === false, { timeout: 4000, label: '验证码提示显示' });
      const hint = String(byId(app, 'login-otp-hint').textContent);
      includes(hint, '654321', '验证码提示缺少 demoCode');
      includes(hint, '演示验证码', '验证码提示缺少「演示验证码」说明');
      includes(hint, '验证码已发送', '验证码提示缺少发送成功文案');
      ok(/^\d+s 后重发$/.test(String(byId(app, 'login-send-otp').textContent)), 'otp-sent 后应继续倒计时');
    } finally {
      closeApp(app);
    }
  });

  test('验证码登录成功：verifyOtp(requestId,phone,code) → otp-verified ok → 进入会话列表', async () => {
    const app = await bootApp({ prefs: { apiKey: '' } });
    try {
      const w = app.win;
      await waitFor(() => isScreenActive(w, 'screen-login'), { timeout: 5000, label: '登录页显示' });
      click(w, q(app, '#login-tabs [data-login-tab="phone"]'));
      const phone = '13800000001';
      byId(app, 'login-phone').value = phone;
      byId(app, 'login-otp').value = '246810';
      const verifyBefore = nativeCalls(app, 'verifyOtp').length;
      const form = byId(app, 'login-phone-form');
      form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await waitFor(() => nativeCalls(app, 'verifyOtp').length > verifyBefore, { timeout: 5000, label: 'Bridge.verifyOtp 调用' });
      const call = lastNative(app, 'verifyOtp');
      equal(call.args[1], phone, 'verifyOtp 手机号参数不正确');
      equal(call.args[2], '246810', 'verifyOtp 验证码参数不正确');
      const requestId = call.args[0];
      ok(String(requestId).length > 0, 'verifyOtp requestId 不能为空');

      emit(app, { type: 'otp-verified', requestId, ok: true, message: '' });
      await waitFor(() => isScreenActive(w, 'screen-chats'), { timeout: 6000, label: '登录成功进入会话列表' });
      ok(!isScreenActive(w, 'screen-login'), '登录成功后登录页应隐藏');
      const auth = app.win.App.getAuthState();
      equal(auth.loggedIn, true, 'App.getAuthState().loggedIn 应为 true');
      equal(auth.phone, phone, 'App.getAuthState().phone 不正确');
      includes(String(byId(app, 'toasts').textContent), '登录成功', '登录成功应 toast 提示');
    } finally {
      closeApp(app);
    }
  });

  test('验证码登录失败：otp-verified ok:false → 手机号表单错误提示，停留在登录页', async () => {
    const app = await bootApp({ prefs: { apiKey: '' } });
    try {
      const w = app.win;
      await waitFor(() => isScreenActive(w, 'screen-login'), { timeout: 5000, label: '登录页显示' });
      click(w, q(app, '#login-tabs [data-login-tab="phone"]'));
      byId(app, 'login-phone').value = '13800000002';
      byId(app, 'login-otp').value = '000000';
      const verifyBefore = nativeCalls(app, 'verifyOtp').length;
      byId(app, 'login-phone-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await waitFor(() => nativeCalls(app, 'verifyOtp').length > verifyBefore, { timeout: 5000, label: 'Bridge.verifyOtp 调用' });
      const requestId = lastNative(app, 'verifyOtp').args[0];
      emit(app, { type: 'otp-verified', requestId, ok: false, message: '验证码错误，还可尝试 2 次' });
      await waitFor(() => byId(app, 'login-phone-error').hidden === false, { timeout: 5000, label: '登录错误提示显示' });
      includes(String(byId(app, 'login-phone-error').textContent), '验证码错误', '错误提示未显示原生 message');
      ok(isScreenActive(w, 'screen-login'), '失败后应停留在登录页');
      ok(!isScreenActive(w, 'screen-chats'), '失败后不应进入会话列表');
      equal(byId(app, 'login-phone-submit').textContent, '登录', '失败后提交按钮应恢复可用文案');
      equal(app.win.App.getAuthState().loggedIn, false, '失败后登录态应为 false');
    } finally {
      closeApp(app);
    }
  });

  test('启动时 authState 已登录（无 API Key）→ 直接进入会话列表并提示配置 Key', async () => {
    const app = await bootApp({
      prefs: { apiKey: '' },
      p1: { auth: { loggedIn: true, phone: '13900000000' } },
    });
    try {
      const w = app.win;
      await waitFor(() => isScreenActive(w, 'screen-chats'), { timeout: 6000, label: '已登录启动进入会话列表' });
      ok(!isScreenActive(w, 'screen-login'), '已登录时不应停留在登录页');
      equal(app.win.App.getAuthState().loggedIn, true, 'App.getAuthState().loggedIn 应为 true');
      equal(app.win.App.getAuthState().phone, '13900000000', 'App.getAuthState().phone 不正确');
      includes(String(byId(app, 'toasts').textContent), '配置 API Key', '应提示配置 API Key');
    } finally {
      closeApp(app);
    }
  });

  test('退出登录：Bridge.logout() 被调用 + 清除 API Key + 回到登录页', async () => {
    const app = await bootApp({
      prefs: { apiKey: 'sk-qa-p1-valid-key' },
      p1: { auth: { loggedIn: true, phone: '13900000001' } },
    });
    try {
      const w = app.win;
      await waitFor(() => isScreenActive(w, 'screen-chats'), { timeout: 6000, label: '会话列表' });
      click(w, q(app, '[data-action="open-settings"]'));
      await waitFor(() => isScreenActive(w, 'screen-settings'), { timeout: 5000, label: '设置页' });
      const logoutBefore = nativeCalls(app, 'logout').length;
      click(w, q(app, '#screen-settings [data-action="logout"]'));
      await waitFor(() => byId(app, 'confirm-modal').classList.contains('is-open'), { timeout: 4000, label: '退出确认弹窗' });
      click(w, byId(app, 'confirm-ok'));
      await waitFor(() => nativeCalls(app, 'logout').length > logoutBefore, { timeout: 5000, label: 'Bridge.logout 调用' });
      await waitFor(() => isScreenActive(w, 'screen-login'), { timeout: 5000, label: '退出后回到登录页' });
      equal(app.native.__prefs.apiKey, '', '退出登录后原生 prefs.apiKey 应被清空');
      equal(app.win.App.getAuthState().loggedIn, false, '退出登录后 auth 应为未登录');
    } finally {
      closeApp(app);
    }
  });

  /* ================================================================ *
   * 工作区
   * ================================================================ */
  suite('P1 集成 · 工作区（workspaceInfo / setWorkspace / 恢复默认）');

  test('设置页工作区行：workspaceInfo 渲染根目录/读写/存储权限与恢复默认入口', async () => {
    const app = await bootApp({
      prefs: API_KEY_PREFS,
      p1: {
        workspace: {
          root: P1_ROOT,
          writable: true,
          allFilesAccess: false,
          defaultRoot: P1_PRIVATE_ROOT,
          isDefault: false,
        },
      },
    });
    try {
      const w = app.win;
      ok(nativeCalls(app, 'workspaceInfo').length > 0, '启动时应调用 DSNative.workspaceInfo()');
      click(w, q(app, '[data-action="open-settings"]'));
      await waitFor(() => isScreenActive(w, 'screen-settings'), { timeout: 5000, label: '设置页' });
      ok(byId(app, 'set-workspace-row'), '缺少 #set-workspace-row');
      equal(byId(app, 'set-workspace-value').textContent, P1_ROOT, '#set-workspace-value 应显示工作区根目录');
      includes(String(byId(app, 'set-workspace-writable').textContent), '可读写', '读写权限行应显示「可读写」');
      includes(String(byId(app, 'set-workspace-access').textContent), '需要授予所有文件访问权限', '存储权限行应提示需要授权');
      equal(byId(app, 'set-workspace-reset').hidden, false, '非默认工作区应显示「恢复默认工作区」');
      includes(String(byId(app, 'set-workspace-reset-hint').textContent), P1_PRIVATE_ROOT, '恢复默认提示应显示默认路径');
      equal(app.win.App.getWorkspaceInfo().root, P1_ROOT, 'App.getWorkspaceInfo().root 不正确');
    } finally {
      closeApp(app);
    }
  });

  test('setWorkspace(newPath) → workspace-changed 事件回填 → 文件树/设置行更新；恢复默认工作区', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const w = app.win;
      await openChatScreen(app);
      // 先打开文件抽屉，便于验证工作区切换后文件树刷新到新根
      click(w, q(app, '[data-action="open-files"]'));
      await waitFor(() => qa(app, '#file-tree .file-node').length >= 3, { timeout: 5000, label: '文件树渲染' });

      const newRoot = '/sdcard/qa-workspace';
      const before = nativeCalls(app, 'setWorkspace').length;
      const applied = w.App.setWorkspace(newRoot);
      equal(applied, true, 'App.setWorkspace 应返回 true');
      await waitFor(() => nativeCalls(app, 'setWorkspace').length > before, { timeout: 5000, label: 'Bridge.setWorkspace 调用' });
      equal(lastNative(app, 'setWorkspace').args[0], newRoot, 'setWorkspace 路径参数不正确');
      // workspace-changed 由 mock 原生自动回传 → 应用刷新 workspaceInfo + 文件树
      await waitFor(() => String(byId(app, 'file-root').textContent) === newRoot, { timeout: 6000, label: '文件树根路径回填新工作区' });
      await waitFor(() => lastNative(app, 'listDir') && lastNative(app, 'listDir').args[0] === newRoot,
        { timeout: 6000, label: '切换后 listDir(新工作区根)' });
      equal(app.win.App.getWorkspaceInfo().root, newRoot, 'App.getWorkspaceInfo() 未更新新根');
      await waitFor(() => byId(app, 'set-workspace-reset').hidden === false,
        { timeout: 5000, label: '设置页显示恢复默认入口' });

      // 恢复默认工作区
      click(w, q(app, '[data-action="open-settings"]'));
      await waitFor(() => isScreenActive(w, 'screen-settings'), { timeout: 5000, label: '设置页' });
      const resetBefore = nativeCalls(app, 'setWorkspace').length;
      click(w, q(app, '#screen-settings [data-action="reset-workspace"]'));
      await waitFor(() => nativeCalls(app, 'setWorkspace').length > resetBefore, { timeout: 5000, label: '恢复默认触发 setWorkspace' });
      equal(lastNative(app, 'setWorkspace').args[0], P1_PRIVATE_ROOT, '恢复默认应 setWorkspace(defaultRoot)');
      await waitFor(() => byId(app, 'set-workspace-value').textContent === P1_PRIVATE_ROOT,
        { timeout: 6000, label: '设置行回填默认工作区' });
      equal(app.win.App.getWorkspaceInfo().isDefault, true, '恢复默认后 isDefault 应为 true');
      await waitFor(() => byId(app, 'set-workspace-reset').hidden === true,
        { timeout: 4000, label: '恢复默认入口隐藏' });
    } finally {
      closeApp(app);
    }
  });

  /* ================================================================ *
   * 收尾
   * ================================================================ */
  suite('P1 集成 · 收尾');

  test('P1 全流程后无未捕获脚本错误', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const errors = app.pageErrors.filter((err) => {
        const msg = String((err && err.message) || err);
        return !/Not implemented/i.test(msg) && !/Could not parse CSS/i.test(msg) && !/jsdom.*not implemented/i.test(msg);
      });
      ok(errors.length === 0, `P1 页面出现 ${errors.length} 个未捕获错误：\n${errors.map((e) => (e && e.message) || e).join('\n')}`);
      equal(app.win.Bridge.__isMock, false, '注入 DSNative 后 Bridge 不应处于 mock 模式');
      notIncludes(String(app.win.localStorage.getItem('dsh.v1') || ''), 'sk-qa-p1-valid-key', 'API Key 不应写入 localStorage');
    } finally {
      closeApp(app);
    }
  });
}
