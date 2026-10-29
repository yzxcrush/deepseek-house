/**
 * scripts/qa/p2-integration-tests.mjs
 * ARCH v2 P2（MCP Client + Termux 构建服务）集成用例：真实 index.html + 全部 JS + mock DSNative。
 *
 * 覆盖：
 *   - MCP 服务器管理页：设置页入口 → #screen-mcp → 列表渲染（名称/URL/状态点/工具数/按钮）；
 *   - 添加服务器：表单非法 URL 校验 → 合法保存（onMcpSave → mcpSaveServer JSON）→ 列表 +1 → 自动连接；
 *   - 连接流程：mcpConnect → mcp-status connecting/connected → 状态点变绿 → mcp-tools 工具数/映射更新；
 *   - mcp-tools 事件：工具数实时更新 + state.mcpToolMap 重建；
 *   - 构建进度卡：pack_apk 工具暴露（risk=mid）→ running 工具卡 → tool-confirm → mcp-progress
 *     10→100 进度条/日志流 → tool-result ok → 工具卡「完成」；失败路径 → is-error/「构建失败」。
 *
 * 每条用例使用**独立 jsdom 窗口**，互不影响、可单独复现。
 */

import { suite, test, ok, equal, includes, isObject } from './lib/harness.mjs';
import { loadAppWindow, waitFor, click, isScreenActive } from './lib/env.mjs';

const API_KEY_PREFS = { apiKey: 'sk-qa-p2-valid-key' };
const MCP_ROOT = 'http://127.0.0.1:8787/mcp';

const byId = (app, id) => app.doc.getElementById(id);
const q = (app, sel) => app.doc.querySelector(sel);
const qa = (app, sel) => Array.from(app.doc.querySelectorAll(sel));
const el = (node, sel) => (node ? node.querySelector(sel) : null);

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
function toolNames(body) {
  return ((body && body.tools) || [])
    .map((t) => (t && ((t.function && t.function.name) || t.name)) || '')
    .filter(Boolean);
}

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

async function openSettings(app) {
  const w = app.win;
  await waitFor(() => isScreenActive(w, 'screen-chats'), { timeout: 6000, label: '会话列表显示' });
  click(w, q(app, '[data-action="open-settings"]'));
  await waitFor(() => isScreenActive(w, 'screen-settings'), { timeout: 6000, label: '设置页显示' });
}

/** 设置页 →「MCP 服务器」行 → 管理页（等待 mcpServers 调用与列表渲染）。 */
async function openMcpPage(app) {
  const w = app.win;
  await openSettings(app);
  const before = nativeCalls(app, 'mcpServers').length;
  const row = byId(app, 'set-mcp-row');
  ok(row, '设置页缺少 #set-mcp-row');
  click(w, row);
  await waitFor(() => isScreenActive(w, 'screen-mcp'), { timeout: 6000, label: 'MCP 管理页显示' });
  await waitFor(() => nativeCalls(app, 'mcpServers').length > before, { timeout: 6000, label: 'Bridge.mcpServers 调用' });
  return w;
}

async function openChatScreen(app) {
  const w = app.win;
  await waitFor(() => isScreenActive(w, 'screen-chats'), { timeout: 6000, label: '会话列表显示' });
  const fab = q(app, '.fab[data-action="new-chat"]');
  ok(fab, '缺少 FAB 新建会话按钮');
  click(w, fab);
  await waitFor(() => isScreenActive(w, 'screen-chat'), { timeout: 6000, label: '进入对话页' });
  return w;
}

async function sendMessage(app, text) {
  const w = app.win;
  const before = nativeCalls(app, 'startChat').length;
  const input = byId(app, 'composer-input');
  input.value = text;
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  click(w, q(app, '[data-action="send"]'));
  await waitFor(() => nativeCalls(app, 'startChat').length > before, { timeout: 6000, label: 'Bridge.startChat 调用' });
  const call = lastNative(app, 'startChat');
  return { requestId: call.args[0], body: parseJson(call.args[1]) };
}

async function waitRiskModal(app, open) {
  await waitFor(
    () => byId(app, 'risk-modal').classList.contains('is-open') === open,
    { timeout: 5000, label: open ? '高危风险弹窗打开' : '高危风险弹窗关闭' },
  );
}

function mcpRow(app, id) {
  return q(app, `#mcp-list .mcp-row[data-mcp-id="${id}"]`);
}

function rowText(app, id) {
  const row = mcpRow(app, id);
  return row ? row.textContent || '' : '';
}

/** 触发 MCP 构建工具（pack_apk）调用：返回 execTool 参数。 */
async function triggerPackApk(app) {
  const { requestId, body } = await sendMessage(app, '请打包 APK');
  const names = toolNames(body);
  includes(names.join(','), 'pack_apk', 'startChat tools 缺少连接后 MCP 工具 pack_apk');
  const packTool = body.tools.find((t) => (t.function && t.function.name) === 'pack_apk');
  ok(packTool, 'tools 中找不到 pack_apk');
  equal(String(packTool.risk || '').toLowerCase(), 'mid', 'MCP 工具 pack_apk 风险级别应为 mid');

  const args = { project_dir: '/data/data/com.termux/files/home/1/deepseek-house' };
  const before = nativeCalls(app, 'execTool').length;
  emit(app, {
    type: 'chunk',
    requestId,
    delta: '',
    reasoning: '',
    toolCalls: [{ index: 0, id: 'call_p2_pack', type: 'function', function: { name: 'pack_apk', arguments: JSON.stringify(args) } }],
  });
  emit(app, { type: 'done', requestId, finishReason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  await waitFor(() => nativeCalls(app, 'execTool').length > before, { timeout: 6000, label: 'Bridge.execTool(pack_apk) 调用' });
  const exec = lastNative(app, 'execTool');
  equal(exec.args[1], 'pack_apk', 'execTool 工具名应为 pack_apk');
  // running 工具卡：进度条 / 日志流容器
  await waitFor(() => qa(app, '#messages .msg--tool .tool-progress').length > 0, { timeout: 5000, label: 'running 构建工具卡渲染' });
  return { requestId, toolRequestId: exec.args[0], args };
}

/** 找到当前 running 的 pack_apk 工具消息。 */
function runningPackMsg(app) {
  const chat = app.win.Store.getActiveChat();
  if (!chat) return null;
  return chat.messages.filter((m) => m.role === 'tool' && m.toolName === 'pack_apk').pop() || null;
}

function toolCardEl(app) {
  return qa(app, '#messages .msg--tool').pop() || null;
}

export function registerP2IntegrationTests() {
  /* ================================================================ *
   * MCP 服务器管理
   * ================================================================ */
  suite('P2 集成 · MCP 服务器管理（列表 / 添加 / 连接 / 工具发现）');

  test('设置页 MCP 入口 → #screen-mcp 渲染 2 个服务器（名称/URL/状态点/工具数）', async () => {
    const app = await bootApp({
      prefs: API_KEY_PREFS,
      p2: {
        servers: [
          { id: 'mcp-termux', name: 'Termux 本地构建', url: MCP_ROOT, token: 'demo-token', enabled: true, status: 'connected' },
          { id: 'mcp-remote-demo', name: '示例远程 MCP', url: 'https://mcp.example.com/mcp', token: '', enabled: true, status: 'disconnected' },
        ],
      },
    });
    try {
      const w = await openMcpPage(app);
      ok(byId(app, 'set-mcp-row'), '设置页缺少 MCP 服务器入口行');
      equal(byId(app, 'set-mcp-row').getAttribute('data-action'), 'open-mcp', 'MCP 行 data-action 应为 open-mcp');
      equal(byId(app, 'screen-mcp').getAttribute('aria-hidden'), 'false', 'MCP 管理页应可见');
      await waitFor(() => qa(app, '#mcp-list .mcp-row').length === 2, { timeout: 5000, label: 'MCP 列表渲染 2 行' });

      const rows = qa(app, '#mcp-list .mcp-row');
      equal(rows.length, 2, 'MCP 列表行数不正确');
      // 已连接服务器
      const term = mcpRow(app, 'mcp-termux');
      ok(term, '找不到 mcp-termux 行');
      includes(String(el(term, '.mcp-row-name-text').textContent), 'Termux 本地构建', '服务器名称未渲染');
      includes(String(el(term, '.mcp-row-url').textContent), '127.0.0.1:8787/mcp', '服务器 URL 未渲染');
      ok(el(term, '.mcp-dot--connected'), '已连接服务器状态点应为 connected');
      equal(el(term, '.mcp-status-badge').textContent, '已连接', '已连接徽章文案不正确');
      includes(String(el(term, '.mcp-row-sub').textContent), '工具 5 个', '工具数未渲染（应为 5）');
      includes(String(el(term, '.mcp-row-sub').textContent), '已连接', '状态文案不正确');
      ok(el(term, '[data-action="mcp-disconnect"]'), '已连接服务器缺少「断开」按钮');
      ok(el(term, '[data-action="mcp-refresh"]'), '已连接服务器缺少「刷新工具」按钮');
      // 未连接服务器
      const remote = mcpRow(app, 'mcp-remote-demo');
      ok(remote, '找不到 mcp-remote-demo 行');
      ok(el(remote, '.mcp-dot--disconnected'), '未连接服务器状态点应为 disconnected');
      equal(el(remote, '.mcp-status-badge').textContent, '未连接', '未连接徽章文案不正确');
      includes(String(el(remote, '.mcp-row-sub').textContent), '工具 0 个', '未连接服务器工具数应为 0');
      ok(el(remote, '[data-action="mcp-connect"]'), '未连接服务器缺少「连接」按钮');
      ok(el(remote, '[data-action="mcp-test"]'), '未连接服务器缺少「测试」按钮');
      ok(el(remote, '[data-action="mcp-delete"]'), '服务器行缺少「删除」按钮');
      // 统计与空态
      includes(String(byId(app, 'mcp-count').textContent), '2 个服务器', '#mcp-count 统计不正确');
      includes(String(byId(app, 'mcp-count').textContent), '1 已连接', '#mcp-count 已连接数不正确');
      includes(String(byId(app, 'set-mcp-count').textContent), '2 个', '设置页 MCP 统计未更新');
      includes(String(byId(app, 'set-mcp-count').textContent), '1 已连接', '设置页已连接数未更新');
      equal(byId(app, 'mcp-empty').hidden, true, '有服务器时不应显示空状态');
      ok(byId(app, 'mcp-add'), '缺少「添加服务器」按钮');
      ok(nativeCalls(app, 'mcpServers').length > 0, '未调用 DSNative.mcpServers()');
    } finally {
      closeApp(app);
    }
  });

  test('添加服务器：非法 URL 校验提示；合法保存 → onMcpSave({name,url,token,connect:true}) → 列表 +1 并自动连接', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const w = await openMcpPage(app);
      await waitFor(() => qa(app, '#mcp-list .mcp-row').length === 2, { timeout: 5000, label: '初始 2 个服务器' });

      click(w, byId(app, 'mcp-add'));
      await waitFor(() => byId(app, 'mcp-form-modal').classList.contains('is-open'), { timeout: 4000, label: 'MCP 表单弹窗打开' });
      equal(byId(app, 'mcp-form-modal').getAttribute('aria-hidden'), 'false', '表单弹窗 aria-hidden 应为 false');
      equal(byId(app, 'mcp-form-title').textContent, '添加 MCP 服务器', '新增表单标题不正确');

      // 非法 URL → 前端校验提示，不写原生
      byId(app, 'mcp-form-name').value = 'Termux QA';
      byId(app, 'mcp-form-url').value = 'not-a-url';
      byId(app, 'mcp-form-token').value = 'qa-token';
      const saveBefore = nativeCalls(app, 'mcpSaveServer').length;
      const saveSpy = { calls: [] };
      const originalOnMcpSave = w.App.handlers.onMcpSave;
      w.App.handlers.onMcpSave = function (server) {
        saveSpy.calls.push(server);
        return originalOnMcpSave(server);
      };
      click(w, byId(app, 'mcp-form-save'));
      await waitFor(() => byId(app, 'mcp-form-error').hidden === false, { timeout: 4000, label: 'URL 校验错误提示' });
      includes(String(byId(app, 'mcp-form-error').textContent), 'http', '非法 URL 提示应说明需 http(s)://');
      equal(nativeCalls(app, 'mcpSaveServer').length, saveBefore, '非法 URL 不应调用原生 save');
      ok(byId(app, 'mcp-form-modal').classList.contains('is-open'), '校验失败时表单应保持打开');

      // 合法保存并连接
      byId(app, 'mcp-form-url').value = 'http://127.0.0.1:9999/mcp';
      click(w, byId(app, 'mcp-form-save'));
      await waitFor(() => nativeCalls(app, 'mcpSaveServer').length > saveBefore, { timeout: 5000, label: 'onMcpSave → DSNative.mcpSaveServer 调用' });
      // UI → app 的 onMcpSave 回调参数（含 connect:true；app 归一化后写入原生时不含 connect 字段）
      ok(saveSpy.calls.length > 0, 'UI 未调用 onMcpSave 回调');
      const onSave = saveSpy.calls[0];
      equal(onSave.name, 'Termux QA', 'onMcpSave 名称不正确');
      equal(onSave.url, 'http://127.0.0.1:9999/mcp', 'onMcpSave URL 不正确');
      equal(onSave.token, 'qa-token', 'onMcpSave Token 不正确');
      equal(onSave.connect, true, '「保存并连接」onMcpSave 应携带 connect:true');
      const call = lastNative(app, 'mcpSaveServer');
      const payload = parseJson(call.args[0]);
      isObject(payload, 'mcpSaveServer 入参应为 JSON 对象字符串');
      equal(payload.name, 'Termux QA', '原生保存名称不正确');
      equal(payload.url, 'http://127.0.0.1:9999/mcp', '原生保存 URL 不正确');
      equal(payload.token, 'qa-token', '原生保存 Token 不正确');
      await waitFor(() => !byId(app, 'mcp-form-modal').classList.contains('is-open'), { timeout: 4000, label: '保存成功后关闭表单' });

      // 列表 +1，并自动连接（mock 原生 save 后自动 connect）
      await waitFor(() => qa(app, '#mcp-list .mcp-row').length === 3, { timeout: 5000, label: '列表新增 1 个服务器' });
      equal(app.native.__p2.servers.length, 3, 'mock 原生未新增服务器配置');
      const newServer = app.native.__p2.servers.find((s) => s.name === 'Termux QA');
      ok(newServer, 'mock 原生缺少新服务器');
      const newRow = mcpRow(app, newServer.id);
      ok(newRow, '列表缺少新服务器行');
      await waitFor(() => {
        const row = mcpRow(app, newServer.id);
        return !!(row && row.querySelector('.mcp-dot--connected'));
      }, { timeout: 6000, label: '新增服务器自动连接（状态点变绿）' });
      equal(el(mcpRow(app, newServer.id), '.mcp-status-badge').textContent, '已连接', '新增服务器连接后徽章应为「已连接」');
      includes(String(byId(app, 'set-mcp-count').textContent), '3 个', '设置页服务器统计应为 3 个');
    } finally {
      closeApp(app);
    }
  });

  test('连接服务器：mcpConnect → mcp-status connected → 状态点变绿 + mcp-tools 更新工具数与工具映射', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const w = await openMcpPage(app);
      await waitFor(() => qa(app, '#mcp-list .mcp-row').length === 2, { timeout: 5000, label: '初始 2 个服务器' });
      const connectBefore = nativeCalls(app, 'mcpConnect').length;
      click(w, el(mcpRow(app, 'mcp-remote-demo'), '[data-action="mcp-connect"]'));
      await waitFor(() => nativeCalls(app, 'mcpConnect').length > connectBefore, { timeout: 5000, label: 'Bridge.mcpConnect 调用' });
      equal(lastNative(app, 'mcpConnect').args[0], 'mcp-remote-demo', 'mcpConnect 参数 id 不正确');

      await waitFor(() => {
        const row = mcpRow(app, 'mcp-remote-demo');
        return !!(row && row.querySelector('.mcp-dot--connected'));
      }, { timeout: 6000, label: 'mcp-status connected → 状态点变绿' });
      const row = mcpRow(app, 'mcp-remote-demo');
      equal(el(row, '.mcp-status-badge').textContent, '已连接', '连接后徽章应为「已连接」');
      includes(String(el(row, '.mcp-row-sub').textContent), '工具 2 个', 'mcp-tools 后工具数应为 2');
      equal(app.win.App.getMcpTools('mcp-remote-demo').length, 2, 'App.getMcpTools 工具缓存不正确');
      equal(app.win.App.getMcpToolMap().echo, 'mcp-remote-demo', 'echo 工具应映射到 mcp-remote-demo');
      includes(String(byId(app, 'mcp-count').textContent), '1 已连接', 'MCP 页统计已连接数应为 1');
      ok(nativeCalls(app, 'mcpTools').length > 0, '连接后应调用 DSNative.mcpTools 补全工具数');
      // 连接后的 MCP 工具应进入 toolSchemas（原生 ToolRegistry 注册语义）
      ok(app.win.App.getToolSchemas().some((t) => t.function && t.function.name === 'echo'),
        '连接后 toolSchemas 缺少 MCP 工具 echo');
    } finally {
      closeApp(app);
    }
  });

  test('mcp-tools 事件 → 工具数实时更新与工具映射重建（不依赖连接流程）', async () => {
    const app = await bootApp({
      prefs: API_KEY_PREFS,
      p2: {
        servers: [
          { id: 'mcp-termux', name: 'Termux 本地构建', url: MCP_ROOT, token: '', enabled: true, status: 'connected' },
          { id: 'mcp-remote-demo', name: '示例远程 MCP', url: 'https://mcp.example.com/mcp', token: '', enabled: true, status: 'disconnected' },
        ],
      },
    });
    try {
      await openMcpPage(app);
      await waitFor(() => qa(app, '#mcp-list .mcp-row').length === 2, { timeout: 5000, label: '初始 2 个服务器' });
      includes(String(rowText(app, 'mcp-termux')), '工具 5 个', '初始 termux 工具数应为 5');

      emit(app, {
        type: 'mcp-tools',
        id: 'mcp-remote-demo',
        tools: [{ name: 'echo', description: '回显' }, { name: 'get_time', description: '时间' }, { name: 'custom_tool', description: '自定义' }],
      });
      await waitFor(() => includesSafe(rowText(app, 'mcp-remote-demo'), '工具 3 个'), { timeout: 5000, label: 'mcp-tools 更新 remote 工具数为 3' });
      equal(app.win.App.getMcpTools('mcp-remote-demo').length, 3, 'App.getMcpTools 未更新');
      equal(app.win.App.getMcpToolMap().custom_tool, 'mcp-remote-demo', '工具映射未重建（custom_tool）');
      ok(mcpRow(app, 'mcp-remote-demo').querySelector('.mcp-dot--connected'), 'mcp-tools 到达后状态应变为 connected');

      emit(app, {
        type: 'mcp-tools',
        id: 'mcp-termux',
        tools: [{ name: 'pack_apk', description: '打包' }, { name: 'list_workspace', description: '列目录' }],
      });
      await waitFor(() => includesSafe(rowText(app, 'mcp-termux'), '工具 2 个'), { timeout: 5000, label: 'mcp-tools 更新 termux 工具数为 2' });
      equal(app.win.App.getMcpToolMap().pack_apk, 'mcp-termux', '工具映射未重建（pack_apk）');
      includes(String(byId(app, 'mcp-count').textContent), '2 个服务器', 'MCP 页统计未刷新');
    } finally {
      closeApp(app);
    }
  });

  /* ================================================================ *
   * 构建进度卡
   * ================================================================ */
  suite('P2 集成 · 构建进度卡（mcp-progress / 日志 / 完成与失败）');

  test('pack_apk：running 卡 → mcp-progress 10→100 进度条与日志 → tool-result ok → 工具卡「完成」', async () => {
    const app = await bootApp({
      prefs: API_KEY_PREFS,
      p2: {
        servers: [
          { id: 'mcp-termux', name: 'Termux 本地构建', url: MCP_ROOT, token: 'demo-token', enabled: true, status: 'connected' },
        ],
      },
    });
    try {
      const w = app.win;
      await openChatScreen(app);
      const tool = await triggerPackApk(app);

      // running 工具消息：存在且为 running 状态；构建卡进度 0%
      const running = runningPackMsg(app);
      ok(running, '未创建 running 工具消息');
      equal(running.confirmState, 'running', 'running 工具消息 confirmState 应为 running');
      equal(el(toolCardEl(app), '.tool-progress') ? el(toolCardEl(app), '.tool-progress').hidden : null, false, '构建卡进度区应可见');
      equal(String(el(toolCardEl(app), '.tool-progress-percent').textContent), '0%', '初始进度应为 0%');

      // 原生 tool-confirm（MCP 工具 risk=mid）
      emit(app, { type: 'tool-confirm', requestId: tool.toolRequestId, tool: 'pack_apk', args: tool.args, risk: 'mid' });
      await waitRiskModal(app, true);
      includes(String(byId(app, 'risk-badge').textContent), 'MID', 'pack_apk 确认弹窗风险应为 MID');
      click(w, byId(app, 'risk-accept'));
      await waitFor(() => nativeCalls(app, 'confirmTool').length > 0, { timeout: 5000, label: 'Bridge.confirmTool 调用' });
      equal(lastNative(app, 'confirmTool').args[1], true, '允许执行时 confirmTool 应为 true');
      await waitRiskModal(app, false);

      // mcp-progress 10 → 100：进度条 / 百分比 / 日志流
      const steps = [
        { percent: 10, line: '准备构建环境…' },
        { percent: 45, line: 'javac 编译 Java…' },
        { percent: 75, line: 'd8 生成 dex…' },
        { percent: 100, line: '构建完成' },
      ];
      for (const step of steps) {
        emit(app, { type: 'mcp-progress', id: 'mcp-termux', tool: 'pack_apk', percent: step.percent, line: step.line });
        await waitFor(() => String(el(toolCardEl(app), '.tool-progress-percent').textContent) === step.percent + '%',
          { timeout: 5000, label: `进度更新到 ${step.percent}%` });
      }
      const card = toolCardEl(app);
      equal(String(el(card, '.tool-progress-fill').style.width), '100%', '进度条宽度应为 100%');
      equal(String(el(card, '.tool-progress-percent').textContent), '100%', '百分比文案应为 100%');
      const logText = String(el(card, '.tool-log').textContent);
      for (const step of steps) includes(logText, step.line, `日志缺少「${step.line}」`);
      equal(el(card, '.tool-log-details').hidden, false, '日志区应展开可见');
      includes(String(el(card, '.tool-log-count').textContent), '4 行', '日志行数应为 4');
      // Store 中 running 消息同步了进度与日志
      const runningStore = runningPackMsg(app);
      equal(runningStore.progress.percent, 100, 'Store running 消息进度应为 100');
      ok(Array.isArray(runningStore.toolLog) && runningStore.toolLog.length === 4, 'Store running 消息日志应记录 4 行');

      // tool-result 完成 → 工具卡「完成」/ is-done
      const result = JSON.stringify({ ok: true, apk_path: '/data/data/com.termux/files/home/1/deepseek-house/dist/app-v2.1.0.apk', size: 1234567, sha256: 'abc123' });
      emit(app, { type: 'tool-result', requestId: tool.toolRequestId, tool: 'pack_apk', ok: true, result, confirmed: true });
      await waitFor(() => {
        const msg = runningPackMsg(app);
        return !!(msg && msg.ok === true && msg.confirmState === 'success');
      }, { timeout: 6000, label: '工具消息完成态' });
      const finished = runningPackMsg(app);
      includes(String(finished.content), 'app-v2.1.0.apk', '完成消息 content 应包含 APK 路径');
      includes(String(finished.result), 'sha256', '完成消息 result 应保留工具 JSON 结果');
      equal(finished.progress.percent, 100, '完成后进度应为 100');
      await waitFor(() => {
        const el = toolCardEl(app);
        return !!(el && el.querySelector('.tool-progress.is-done'));
      }, { timeout: 5000, label: '工具卡完成态 is-done' });
      const doneCard = toolCardEl(app);
      equal(String(el(doneCard, '.tool-progress-label').textContent), '完成', '完成态标签应为「完成」');
      equal(String(el(doneCard, '.tool-progress-percent').textContent), '100%', '完成态百分比应为 100%');
      includes(String(el(doneCard, '.tool-badge').textContent), '成功', '完成态徽章应为「成功」');
      equal(app.win.App.getState().runningToolMsgs.length, 0, '完成后 running 工具卡栈应清空');

      // 工具循环继续请求
      await waitFor(() => nativeCalls(app, 'startChat').length >= 2, { timeout: 8000, label: '工具循环继续请求' });
      const cont = lastChatBody(app);
      const toolIdx = cont.messages.findIndex((m) => m.role === 'tool');
      ok(toolIdx > 0, '继续请求历史缺少 role:"tool"');
      includes(String(cont.messages[toolIdx].content), 'app-v2.1.0.apk', '继续请求中工具结果丢失');
    } finally {
      closeApp(app);
    }
  });

  test('pack_apk 失败：tool-result ok:false → 工具卡 is-error /「构建失败」并继续请求', async () => {
    const app = await bootApp({
      prefs: API_KEY_PREFS,
      p2: {
        servers: [
          { id: 'mcp-termux', name: 'Termux 本地构建', url: MCP_ROOT, token: 'demo-token', enabled: true, status: 'connected' },
        ],
      },
    });
    try {
      const w = app.win;
      await openChatScreen(app);
      const tool = await triggerPackApk(app);
      emit(app, { type: 'tool-confirm', requestId: tool.toolRequestId, tool: 'pack_apk', args: tool.args, risk: 'mid' });
      await waitRiskModal(app, true);
      click(w, byId(app, 'risk-accept'));
      await waitFor(() => nativeCalls(app, 'confirmTool').length > 0, { timeout: 5000, label: 'Bridge.confirmTool 调用' });
      await waitRiskModal(app, false);

      emit(app, { type: 'mcp-progress', id: 'mcp-termux', tool: 'pack_apk', percent: 45, line: 'javac 编译 Java…' });
      await waitFor(() => String(el(toolCardEl(app), '.tool-progress-percent').textContent) === '45%',
        { timeout: 5000, label: '进度更新到 45%' });

      emit(app, { type: 'tool-result', requestId: tool.toolRequestId, tool: 'pack_apk', ok: false, result: '构建失败：javac 编译错误', confirmed: true });
      await waitFor(() => {
        const msg = runningPackMsg(app);
        return !!(msg && msg.ok === false && msg.confirmState === 'error');
      }, { timeout: 6000, label: '工具消息失败态' });
      const failed = runningPackMsg(app);
      includes(String(failed.content), '构建失败', '失败消息应包含错误结果');
      equal(failed.progress.percent, 45, '失败时保留最后进度百分比');
      await waitFor(() => {
        const el = toolCardEl(app);
        return !!(el && el.querySelector('.tool-progress.is-error'));
      }, { timeout: 5000, label: '工具卡失败态 is-error' });
      const card = toolCardEl(app);
      equal(String(el(card, '.tool-progress-label').textContent), '构建失败', '失败态标签应为「构建失败」');
      includes(String(el(card, '.tool-badge').textContent), '失败', '失败态徽章应为「失败」');
      equal(app.win.App.getState().runningToolMsgs.length, 0, '失败后 running 工具卡栈应清空');
      await waitFor(() => nativeCalls(app, 'startChat').length >= 2, { timeout: 8000, label: '工具循环继续请求' });
    } finally {
      closeApp(app);
    }
  });

  /* ================================================================ *
   * 收尾
   * ================================================================ */
  suite('P2 集成 · 收尾');

  test('P2 全流程后无未捕获脚本错误', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const errors = app.pageErrors.filter((err) => {
        const msg = String((err && err.message) || err);
        return !/Not implemented/i.test(msg) && !/Could not parse CSS/i.test(msg) && !/jsdom.*not implemented/i.test(msg);
      });
      ok(errors.length === 0, `P2 页面出现 ${errors.length} 个未捕获错误：\n${errors.map((e) => (e && e.message) || e).join('\n')}`);
      equal(app.win.Bridge.__isMock, false, '注入 DSNative 后 Bridge 不应处于 mock 模式');
    } finally {
      closeApp(app);
    }
  });
}

/** 轮询辅助：includes 是断言（抛错），这里返回布尔供 waitFor 使用。 */
function includesSafe(haystack, needle) {
  return String(haystack || '').indexOf(needle) !== -1;
}
