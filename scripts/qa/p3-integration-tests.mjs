/**
 * scripts/qa/p3-integration-tests.mjs
 * ARCH v2 P3（插件生态 + 记忆）集成用例：真实 index.html + 全部 JS + mock DSNative。
 *
 * 覆盖：
 *   - 插件市场：设置页入口 → #screen-market；renderMarket 卡片/状态徽章/按钮；
 *     onMarketFetch 拉取 https 索引（mock httpFetch）；非 https 拒绝；
 *     onMarketInstall 下载 → sha256/HMAC 校验 → pluginWrite；HMAC 不匹配不写入；卸载。
 *   - 记忆：设置页入口 → #screen-memory；memoryAll 渲染长期偏好/项目记忆/会话摘要；
 *     onMemorySave → memoryKvSet；onMemoryDelete → memoryKvDelete；onSummaryDelete。
 *   - 记忆注入与上下文压缩：>19200 字符历史 → memorySaveSummary + 裁剪 + 「已压缩」note
 *     + systemPrompt 注入长期偏好/项目记忆/会话摘要；未超预算时只注入不压缩。
 *   - 插件槽位：HousePlugin uiSlots → UI.renderPluginSlots → 点击 slot 按钮 → runSlotAction。
 *
 * 每条用例使用**独立 jsdom 窗口**，互不影响、可单独复现。
 */

import crypto from 'node:crypto';
import { suite, test, ok, equal, includes, isObject } from './lib/harness.mjs';
import { loadAppWindow, waitFor, click, isScreenActive } from './lib/env.mjs';

const API_KEY_PREFS = { apiKey: 'sk-qa-p3-valid-key' };
const INDEX_URL = 'https://market.example.com/index.json';
const DL_URL = 'https://market.example.com/plugins/market.qa-demo.js';

const byId = (app, id) => app.doc.getElementById(id);
const q = (app, sel) => app.doc.querySelector(sel);
const qa = (app, sel) => Array.from(app.doc.querySelectorAll(sel));
const el = (node, sel) => (node ? node.querySelector(sel) : null);
const els = (node, sel) => (node ? Array.from(node.querySelectorAll(sel)) : []);

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
function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}
function toastText(app) {
  return String(byId(app, 'toasts') ? byId(app, 'toasts').textContent : '');
}
function includesSafe(haystack, needle) {
  return String(haystack || '').indexOf(needle) !== -1;
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
  return w;
}

async function openMarketPage(app) {
  const w = await openSettings(app);
  click(w, byId(app, 'set-market-row'));
  await waitFor(() => isScreenActive(w, 'screen-market'), { timeout: 6000, label: '插件市场页显示' });
  return w;
}

async function openMemoryPage(app) {
  const w = await openSettings(app);
  click(w, byId(app, 'set-memory-row'));
  await waitFor(() => isScreenActive(w, 'screen-memory'), { timeout: 6000, label: '记忆页显示' });
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

function marketCard(app, id) {
  return q(app, `#market-list .market-card[data-market-id="${id}"]`);
}

/** 准备市场 mock：源码 + sha256 + mock HMAC，并写入运行时 httpFetch 响应表。 */
function prepareMarketMock(app) {
  const source = [
    "window.DSPlugins.register({",
    "  id: 'market.qa-demo',",
    "  name: '市场 QA 演示',",
    "  version: '1.0.0',",
    "  author: 'qa',",
    "  description: '用于 QA 的市场插件',",
    "  commands: [],",
    "  tools: []",
    "});",
  ].join('\n');
  const item = {
    id: 'market.qa-demo',
    name: '市场 QA 演示',
    version: '1.0.0',
    author: 'qa',
    description: '用于 QA 的市场插件',
    url: DL_URL,
    sha256: sha256(source),
    hmac: app.native.__p3.hmacFor(source),
    tags: ['qa', 'demo'],
  };
  app.native.__http.responses[INDEX_URL] = {
    status: 200,
    body: JSON.stringify({ version: 1, plugins: [item] }),
  };
  app.native.__http.responses[DL_URL] = { status: 200, body: source };
  return { source, item };
}

/** 打开市场页并拉取索引（等卡片渲染）。 */
async function fetchMarket(app) {
  const w = await openMarketPage(app);
  byId(app, 'market-url').value = INDEX_URL;
  const before = nativeCalls(app, 'httpFetch').length;
  click(w, byId(app, 'market-fetch'));
  await waitFor(() => nativeCalls(app, 'httpFetch').length > before, { timeout: 6000, label: 'Bridge.httpFetch 拉取索引' });
  await waitFor(() => qa(app, '#market-list .market-card').length === 1, { timeout: 8000, label: '市场索引卡片渲染' });
  return w;
}

export function registerP3IntegrationTests() {
  /* ================================================================ *
   * 插件市场
   * ================================================================ */
  suite('P3 集成 · 插件市场（渲染 / 索引 / 安装 / 校验失败 / 卸载）');

  test('设置页「插件市场」入口 → #screen-market；UI.renderMarket(2 items, statusMap) 渲染卡片/徽章/按钮', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const w = await openMarketPage(app);
      equal(byId(app, 'screen-market').getAttribute('aria-hidden'), 'false', '插件市场页应可见');
      ok(byId(app, 'set-market-row'), '设置页缺少「插件市场」入口');
      equal(byId(app, 'set-market-row').getAttribute('data-action'), 'open-market', '市场行 data-action 应为 open-market');
      await waitFor(() => byId(app, 'market-list'), { timeout: 4000, label: '市场列表容器' });

      const items = [
        { id: 'market.alpha', name: 'Alpha 插件', version: '1.2.0', author: 'alice', description: '第一个演示插件', tags: ['工具', 'qa'] },
        { id: 'market.beta', name: 'Beta 插件', version: '0.9.0', author: 'bob', description: '第二个演示插件' },
      ];
      const statusMap = {
        'market.alpha': { status: 'installed', version: '1.2.0' },
        'market.beta': { status: 'update', version: '0.8.0' },
      };
      w.UI.renderMarket(items, statusMap);
      await waitFor(() => qa(app, '#market-list .market-card').length === 2, { timeout: 4000, label: '市场卡片渲染 2 个' });

      const alpha = marketCard(app, 'market.alpha');
      const beta = marketCard(app, 'market.beta');
      ok(alpha && beta, '市场卡片缺少 alpha/beta');
      includes(String(el(alpha, '.market-name').textContent), 'Alpha 插件', '卡片名称未渲染');
      includes(String(el(alpha, '.market-version').textContent), 'v1.2.0', '卡片版本未渲染');
      includes(String(el(alpha, '.market-author').textContent), 'alice', '卡片作者未渲染');
      includes(String(el(alpha, '.market-desc').textContent), '第一个演示插件', '卡片描述未渲染');
      equal(els(alpha, '.market-tags .market-tag').length, 2, '卡片标签数量不正确');
      equal(el(alpha, '.market-badge').textContent, '已安装', '已安装徽章文案不正确');
      ok(el(alpha, '.market-act[data-action="market-remove"]'), '已安装卡片缺少卸载按钮');
      equal(el(beta, '.market-badge').textContent, '可更新', '可更新徽章文案不正确');
      ok(el(beta, '.market-act[data-action="market-install"]'), '可更新卡片缺少更新按钮');
      ok(el(beta, '.market-act[data-action="market-remove"]'), '可更新卡片缺少卸载按钮');
      includes(String(byId(app, 'market-count').textContent), '2 个插件', '#market-count 统计不正确');
      // UI 统计口径：installed + update 都计为「已安装」（待更新也是已装）
      includes(String(byId(app, 'market-count').textContent), '2 已安装', '#market-count 已安装数不正确');
      includes(String(byId(app, 'set-market-label').textContent), '2 个可用', '设置页市场统计未更新');
      equal(byId(app, 'market-empty').hidden, true, '有插件时不应显示空状态');
      equal(w.UI.renderMarket([], {}).length, 0, 'UI.renderMarket 应返回渲染条目数');
    } finally {
      closeApp(app);
    }
  });

  test('拉取市场索引：onMarketFetch(url) → mock httpFetch 返回索引 JSON → 卡片渲染；非 https 拒绝', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const w = await openMarketPage(app);
      app.native.__http.responses['https://market.example.com/demo-index.json'] = {
        status: 200,
        body: JSON.stringify({
          version: 1,
          plugins: [
            {
              id: 'market.fetch-a',
              name: '索引插件 A',
              version: '1.0.0',
              author: 'qa',
              description: '来自索引 A',
              url: 'https://market.example.com/a.js',
              sha256: 'a'.repeat(64),
              hmac: 'b'.repeat(64),
              tags: ['index'],
            },
            {
              id: 'market.fetch-b',
              name: '索引插件 B',
              version: '2.0.0',
              author: 'qa',
              description: '来自索引 B',
              url: 'https://market.example.com/b.js',
              sha256: 'c'.repeat(64),
              hmac: 'd'.repeat(64),
            },
          ],
        }),
      };
      const target = 'https://market.example.com/demo-index.json';
      byId(app, 'market-url').value = target;
      const before = nativeCalls(app, 'httpFetch').length;
      click(w, byId(app, 'market-fetch'));
      await waitFor(() => nativeCalls(app, 'httpFetch').length > before, { timeout: 6000, label: 'Bridge.httpFetch 拉取索引' });
      const httpCall = lastNative(app, 'httpFetch');
      const req = parseJson(httpCall.args[1]);
      equal(req && req.url, target, 'httpFetch 请求 URL 不正确');
      await waitFor(() => qa(app, '#market-list .market-card').length === 2, { timeout: 8000, label: '索引卡片渲染' });
      includes(String(marketCard(app, 'market.fetch-a').textContent), '索引插件 A', '索引 A 卡片未渲染');
      includes(String(marketCard(app, 'market.fetch-b').textContent), '索引插件 B', '索引 B 卡片未渲染');
      includes(toastText(app), '市场索引已加载', '拉取成功应 toast 提示');

      // 非 https：UI 层拒绝且不发起网络请求
      const httpBefore = nativeCalls(app, 'httpFetch').length;
      byId(app, 'market-url').value = 'http://market.example.com/demo-index.json';
      click(w, byId(app, 'market-fetch'));
      await waitFor(() => includesSafe(toastText(app), 'https://'), { timeout: 4000, label: '非 https 校验提示' });
      equal(nativeCalls(app, 'httpFetch').length, httpBefore, '非 https 索引不应发起网络请求');
      // app 层同样拒绝（返回 false）
      const rejected = await w.App.fetchMarketIndex('http://market.example.com/demo-index.json');
      equal(rejected, false, 'App.fetchMarketIndex 应拒绝非 https 索引');
    } finally {
      closeApp(app);
    }
  });

  test('安装插件：下载 → sha256/HMAC 校验通过 → pluginWrite 写入 + 已安装状态；卸载 → pluginDelete', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const { source } = prepareMarketMock(app);
      const w = await fetchMarket(app);
      const card = marketCard(app, 'market.qa-demo');
      ok(card, '市场卡片 market.qa-demo 未渲染');
      const writeBefore = nativeCalls(app, 'pluginWriteFile').length;
      click(w, el(card, '[data-action="market-install"]'));
      await waitFor(() => nativeCalls(app, 'pluginWriteFile').length > writeBefore, { timeout: 10000, label: 'Bridge.pluginWrite 写入插件' });
      const write = lastNative(app, 'pluginWriteFile');
      equal(write.args[0], 'market.qa-demo-1.0.0.js', '插件文件名不正确');
      equal(write.args[1], source, '写入内容应为下载的插件源码');
      // HMAC / sha256 均被校验
      ok(nativeCalls(app, 'pluginHmac').length > 0, '安装时未调用 Bridge.pluginHmac 校验 HMAC');
      ok(nativeCalls(app, 'httpFetch').length >= 2, '安装时应下载插件源码（第二次 httpFetch）');
      await waitFor(() => {
        const box = marketCard(app, 'market.qa-demo');
        return !!(box && box.querySelector('.market-badge--installed'));
      }, { timeout: 10000, label: '安装后状态改为已安装' });
      equal(el(marketCard(app, 'market.qa-demo'), '.market-badge').textContent, '已安装', '安装后徽章应为「已安装」');
      includes(toastText(app), '插件已安装', '安装成功应 toast 提示');
      includes(app.native.__p3.plugins.map((p) => p.fileName).join(','), 'market.qa-demo-1.0.0.js', 'mock 原生未写入插件文件');

      // 卸载：确认弹窗 → pluginDelete → 状态回未安装
      const delBefore = nativeCalls(app, 'pluginDeleteFile').length;
      click(w, el(marketCard(app, 'market.qa-demo'), '[data-action="market-remove"]'));
      await waitFor(() => byId(app, 'confirm-modal').classList.contains('is-open'), { timeout: 4000, label: '卸载确认弹窗' });
      click(w, byId(app, 'confirm-ok'));
      await waitFor(() => nativeCalls(app, 'pluginDeleteFile').length > delBefore, { timeout: 6000, label: 'Bridge.pluginDelete 删除插件' });
      equal(lastNative(app, 'pluginDeleteFile').args[0], 'market.qa-demo-1.0.0.js', '删除插件文件名不正确');
      await waitFor(() => {
        const box = marketCard(app, 'market.qa-demo');
        return !!(box && box.querySelector('.market-badge--not-installed'));
      }, { timeout: 8000, label: '卸载后状态回未安装' });
      includes(toastText(app), '插件已卸载', '卸载成功应 toast 提示');
    } finally {
      closeApp(app);
    }
  });

  test('安装失败：HMAC 不匹配 → 不写入 pluginWrite + 校验失败徽章/提示', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const { source } = prepareMarketMock(app);
      // 篡改索引中的 hmac（格式合法但内容不匹配）
      const index = parseJson(app.native.__http.responses[INDEX_URL].body);
      index.plugins[0].hmac = 'e'.repeat(64);
      app.native.__http.responses[INDEX_URL] = { status: 200, body: JSON.stringify(index) };
      const w = await fetchMarket(app);
      const card = marketCard(app, 'market.qa-demo');
      ok(card, '市场卡片未渲染');
      equal(app.native.__http.responses[DL_URL].body, source, '下载响应应保持原始源码');
      const writeBefore = nativeCalls(app, 'pluginWriteFile').length;
      click(w, el(card, '[data-action="market-install"]'));
      await waitFor(() => {
        const box = marketCard(app, 'market.qa-demo');
        return !!(box && box.querySelector('.market-badge--invalid'));
      }, { timeout: 10000, label: 'HMAC 失败后徽章为校验失败' });
      equal(el(marketCard(app, 'market.qa-demo'), '.market-badge').textContent, '校验失败', '校验失败徽章文案不正确');
      includes(String(el(marketCard(app, 'market.qa-demo'), '.market-error').textContent), '签名校验失败',
        '卡片应显示「签名校验失败」原因');
      includes(toastText(app), '签名校验失败', '应 toast 签名校验失败');
      equal(nativeCalls(app, 'pluginWriteFile').length, writeBefore, 'HMAC 不匹配时不应写入插件文件');
      equal(app.native.__p3.plugins.length, 0, 'HMAC 不匹配时 mock 原生不应出现插件文件');
      equal(marketCard(app, 'market.qa-demo').querySelector('[data-action="market-install"]') !== null, true,
        '校验失败后应提供「重新安装」按钮');
    } finally {
      closeApp(app);
    }
  });

  /* ================================================================ *
   * 记忆
   * ================================================================ */
  suite('P3 集成 · 记忆页（长期偏好 / 项目记忆 / 会话摘要）');

  test('设置页「记忆」入口 → #screen-memory；memoryAll 渲染长期偏好/项目记忆/会话摘要', async () => {
    const app = await bootApp({
      prefs: API_KEY_PREFS,
      p3: {
        memory: {
          long_term: { style: '结论先行', tone: '不用官方套话' },
          project: { tech_stack: 'Node 22 / Java 17', conventions: '提交信息用中文', decisions: '纯 Java 不用 AndroidX' },
          summaries: [{ chatId: 'qa-chat-1', summary: '之前聊过打包 APK 的流程', updatedAt: Date.parse('2026-10-29T10:00:00') }],
        },
      },
    });
    try {
      const w = await openMemoryPage(app);
      equal(byId(app, 'screen-memory').getAttribute('aria-hidden'), 'false', '记忆页应可见');
      ok(byId(app, 'set-memory-row'), '设置页缺少「记忆」入口');
      equal(byId(app, 'set-memory-row').getAttribute('data-action'), 'open-memory', '记忆行 data-action 应为 open-memory');
      ok(nativeCalls(app, 'memoryAll').length > 0, '打开记忆页应调用 Bridge.memoryAll');
      await waitFor(() => qa(app, '#memory-longterm .memory-row').length === 2, { timeout: 5000, label: '长期偏好渲染 2 条' });
      const longRows = qa(app, '#memory-longterm .memory-row');
      includes(String(longRows[0].textContent), '结论先行', '长期偏好 key 未渲染');
      includes(String(longRows[1].textContent), '不用官方套话', '长期偏好 value 未渲染');
      equal(byId(app, 'memory-tech-stack').value, 'Node 22 / Java 17', 'tech_stack 未回填');
      equal(byId(app, 'memory-conventions').value, '提交信息用中文', 'conventions 未回填');
      equal(byId(app, 'memory-decisions').value, '纯 Java 不用 AndroidX', 'decisions 未回填');
      await waitFor(() => qa(app, '#memory-summaries .memory-row').length === 1, { timeout: 5000, label: '会话摘要渲染 1 条' });
      const summaryRow = qa(app, '#memory-summaries .memory-row')[0];
      includes(String(summaryRow.textContent), '之前聊过打包 APK 的流程', '摘要内容未渲染');
      includes(String(summaryRow.textContent), 'qa-chat-', '摘要标题应回退为 chatId 前缀');
      includes(String(byId(app, 'memory-count').textContent), '2 条长期偏好', '#memory-count 长期偏好统计不正确');
      includes(String(byId(app, 'memory-count').textContent), '1 条会话摘要', '#memory-count 摘要统计不正确');
      includes(String(byId(app, 'set-memory-label').textContent), '2 条偏好', '设置页记忆统计未更新');
      equal(byId(app, 'memory-longterm-empty').hidden, true, '有长期偏好时不应显示空状态');
      equal(byId(app, 'memory-summaries-empty').hidden, true, '有摘要时不应显示空状态');
      ok(qa(app, '#memory-longterm [data-action="memory-delete-longterm"]').length === 2, '长期偏好缺少删除按钮');
      ok(qa(app, '#memory-summaries [data-action="memory-delete-summary"]').length === 1, '摘要缺少删除按钮');
      ok(w.App && typeof w.App.handlers.onMemorySave === 'function', '缺少 onMemorySave 回调');
    } finally {
      closeApp(app);
    }
  });

  test('记忆写入/删除：onMemorySave(long_term) → memoryKvSet；删除 → memoryKvDelete；项目记忆 3 字段', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS, p3: { memory: { long_term: {}, project: {}, summaries: [] } } });
    try {
      const w = await openMemoryPage(app);
      await waitFor(() => byId(app, 'memory-add-longterm'), { timeout: 4000, label: '记忆页渲染' });

      // 新增长期偏好 → onMemorySave → Bridge.memoryKvSet
      click(w, byId(app, 'memory-add-longterm'));
      await waitFor(() => byId(app, 'memory-item-modal').classList.contains('is-open'), { timeout: 4000, label: '长期偏好弹窗' });
      byId(app, 'memory-item-key').value = 'qa_key';
      byId(app, 'memory-item-value').value = 'qa_value';
      const kvBefore = nativeCalls(app, 'memoryKvSet').length;
      click(w, byId(app, 'memory-item-save'));
      await waitFor(() => nativeCalls(app, 'memoryKvSet').length > kvBefore, { timeout: 5000, label: 'Bridge.memoryKvSet 调用' });
      const kvCall = lastNative(app, 'memoryKvSet');
      equal(kvCall.args[0], 'long_term', 'memoryKvSet scope 应为 long_term');
      equal(kvCall.args[1], 'qa_key', 'memoryKvSet key 不正确');
      equal(kvCall.args[2], 'qa_value', 'memoryKvSet value 不正确');
      equal(byId(app, 'memory-item-modal').classList.contains('is-open'), false, '保存后应关闭弹窗');
      await waitFor(() => qa(app, '#memory-longterm .memory-row').length === 1, { timeout: 5000, label: '新增长期偏好渲染' });
      includes(String(byId(app, 'memory-longterm').textContent), 'qa_key', '新增长期偏好未显示');

      // 删除长期偏好 → onMemoryDelete → Bridge.memoryKvDelete
      const delBefore = nativeCalls(app, 'memoryKvDelete').length;
      click(w, q(app, '#memory-longterm [data-action="memory-delete-longterm"]'));
      await waitFor(() => byId(app, 'confirm-modal').classList.contains('is-open'), { timeout: 4000, label: '删除确认弹窗' });
      click(w, byId(app, 'confirm-ok'));
      await waitFor(() => nativeCalls(app, 'memoryKvDelete').length > delBefore, { timeout: 5000, label: 'Bridge.memoryKvDelete 调用' });
      const delCall = lastNative(app, 'memoryKvDelete');
      equal(delCall.args[0], 'long_term', 'memoryKvDelete scope 不正确');
      equal(delCall.args[1], 'qa_key', 'memoryKvDelete key 不正确');
      await waitFor(() => qa(app, '#memory-longterm .memory-row').length === 0, { timeout: 5000, label: '删除后长期偏好列表清空' });

      // 保存项目记忆 → 3 次 memoryKvSet('project', ...)
      byId(app, 'memory-tech-stack').value = 'Java 17 / WebView';
      byId(app, 'memory-conventions').value = '测试先行';
      byId(app, 'memory-decisions').value = '不引入第三方 SDK';
      const projectBefore = nativeCalls(app, 'memoryKvSet').length;
      click(w, byId(app, 'memory-save-project'));
      await waitFor(() => nativeCalls(app, 'memoryKvSet').length >= projectBefore + 3, { timeout: 5000, label: '项目记忆 3 次 memoryKvSet' });
      const projectCalls = nativeCalls(app, 'memoryKvSet').slice(projectBefore);
      deepEqualSorted(projectCalls.map((c) => [c.args[0], c.args[1], c.args[2]]), [
        ['project', 'tech_stack', 'Java 17 / WebView'],
        ['project', 'conventions', '测试先行'],
        ['project', 'decisions', '不引入第三方 SDK'],
      ], '项目记忆写入参数不正确');
    } finally {
      closeApp(app);
    }
  });

  test('会话摘要删除：onSummaryDelete(chatId) → memoryDeleteSummary 且列表移除', async () => {
    const app = await bootApp({
      prefs: API_KEY_PREFS,
      p3: { memory: { long_term: {}, project: {}, summaries: [{ chatId: 'qa-chat-del', summary: '待删除的摘要', updatedAt: Date.now() }] } },
    });
    try {
      const w = await openMemoryPage(app);
      await waitFor(() => qa(app, '#memory-summaries .memory-row').length === 1, { timeout: 5000, label: '摘要渲染' });
      const delBefore = nativeCalls(app, 'memoryDeleteSummary').length;
      click(w, q(app, '#memory-summaries [data-action="memory-delete-summary"]'));
      await waitFor(() => byId(app, 'confirm-modal').classList.contains('is-open'), { timeout: 4000, label: '删除摘要确认弹窗' });
      click(w, byId(app, 'confirm-ok'));
      await waitFor(() => nativeCalls(app, 'memoryDeleteSummary').length > delBefore, { timeout: 5000, label: 'Bridge.memoryDeleteSummary 调用' });
      equal(lastNative(app, 'memoryDeleteSummary').args[0], 'qa-chat-del', 'memoryDeleteSummary chatId 不正确');
      await waitFor(() => qa(app, '#memory-summaries .memory-row').length === 0, { timeout: 5000, label: '摘要删除后列表清空' });
      includes(toastText(app), '已删除会话摘要', '删除摘要应 toast 提示');
    } finally {
      closeApp(app);
    }
  });

  /* ================================================================ *
   * 记忆注入与上下文压缩
   * ================================================================ */
  suite('P3 集成 · 记忆注入与上下文压缩');

  test('超预算会话（>19200 字符）发送：memorySaveSummary + 历史裁剪 +「已压缩」note + systemPrompt 注入记忆', async () => {
    const app = await bootApp({
      prefs: API_KEY_PREFS,
      p3: {
        memory: {
          long_term: { style: '结论先行', tone: '不用官方套话' },
          project: { tech_stack: 'Node 22 / Java 17', conventions: '提交信息用中文', decisions: '纯 Java 不用 AndroidX' },
          summaries: [],
        },
      },
    });
    try {
      const w = app.win;
      await openChatScreen(app);
      const chat = w.Store.getActiveChat();
      ok(chat, '缺少活动会话');
      // 构造 26 条 × 1000 字符历史 ≈ 26000 字符 > 19200（24000 × 80%）
      for (let i = 0; i < 26; i += 1) {
        w.Store.appendMessage(chat.id, {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: '历史消息' + i + '：' + 'x'.repeat(1000),
        });
      }
      const historyChars = w.Store.getActiveChat().messages.reduce((sum, m) => sum + String(m.content || '').length, 0);
      ok(historyChars > 19200, `构造历史应超预算，实际 ${historyChars} 字符`);

      const saveBefore = nativeCalls(app, 'memorySaveSummary').length;
      const { body, requestId } = await sendMessage(app, '请总结一下上面的讨论');
      ok(requestId, 'startChat requestId 为空');

      // 1) 压缩摘要写入原生
      await waitFor(() => nativeCalls(app, 'memorySaveSummary').length > saveBefore, { timeout: 8000, label: 'Bridge.memorySaveSummary 调用' });
      const saveCall = lastNative(app, 'memorySaveSummary');
      equal(saveCall.args[0], chat.id, 'memorySaveSummary chatId 不正确');
      const summaryText = String(saveCall.args[1] || '');
      ok(summaryText.length > 0, '压缩摘要不能为空');
      includes(summaryText, '用户：', '摘要应包含用户消息片段');
      includes(summaryText, '助手：', '摘要应包含助手消息片段');

      // 2) 请求 messages 数/字符数下降（保留最近 10 条）
      ok(Array.isArray(body.messages), 'startChat 请求体缺少 messages');
      const kept = body.messages.filter((m) => m.role !== 'system');
      equal(kept.length, 10, '压缩后应保留最近 10 条消息');
      const bodyChars = kept.reduce((sum, m) => sum + String(m.content || '').length, 0);
      ok(bodyChars < historyChars, `压缩后字符数应下降（原 ${historyChars} / 请求 ${bodyChars}）`);
      const chatAfter = w.Store.getActiveChat();
      ok(chatAfter.messages.length > kept.length + 10, 'Store 历史应远多于请求消息数');

      // 3) role:'note' 压缩提示
      const note = chatAfter.messages.filter((m) => m.role === 'note').pop();
      ok(note, '压缩后缺少 role:"note" 提示');
      includes(String(note.content), '已压缩', 'note 应包含「已压缩」');
      includes(String(note.content), '条历史消息', 'note 应说明压缩条数');
      await waitFor(() => qa(app, '#messages .msg--note').length > 0, { timeout: 4000, label: '压缩提示渲染到消息流' });
      includes(String(q(app, '#messages .msg--note').textContent), '已压缩', '消息流中缺少压缩提示');

      // 4) systemPrompt 注入：长期偏好 + 项目记忆 + 会话摘要
      const systemPrompt = String(body.systemPrompt || '');
      includes(systemPrompt, '结论先行', 'systemPrompt 缺少长期偏好（key）');
      includes(systemPrompt, '不用官方套话', 'systemPrompt 缺少长期偏好 value');
      includes(systemPrompt, '用户偏好：', 'systemPrompt 缺少「用户偏好」段落');
      includes(systemPrompt, 'tech_stack', 'systemPrompt 缺少项目记忆 tech_stack');
      includes(systemPrompt, 'Node 22 / Java 17', 'systemPrompt 缺少项目记忆值');
      includes(systemPrompt, '项目记忆：', 'systemPrompt 缺少「项目记忆」段落');
      includes(systemPrompt, '之前对话摘要：', 'systemPrompt 缺少会话摘要段落');
      includes(systemPrompt, '用户：', 'systemPrompt 摘要内容缺失');
      includes(systemPrompt, 'DeepSeek House 助手', 'systemPrompt 丢失基础提示词');
      // 压缩后的摘要已进 contextSummaryOverride，同一会话继续请求仍会注入
      const summaryCalls = nativeCalls(app, 'memorySaveSummary');
      ok(summaryCalls.length >= 1, '应至少保存一次会话摘要');
    } finally {
      closeApp(app);
    }
  });

  test('未超预算：不压缩、不写摘要，但 systemPrompt 仍注入长期偏好/项目记忆', async () => {
    const app = await bootApp({
      prefs: API_KEY_PREFS,
      p3: {
        memory: {
          long_term: { style: '结论先行' },
          project: { tech_stack: 'Node 22' },
          summaries: [],
        },
      },
    });
    try {
      const w = app.win;
      await openChatScreen(app);
      const { body } = await sendMessage(app, '你好');
      await waitFor(() => lastChatBody(app), { timeout: 5000, label: 'startChat 请求体' });
      const note = w.Store.getActiveChat().messages.filter((m) => m.role === 'note');
      equal(note.length, 0, '未超预算不应出现压缩 note');
      equal(nativeCalls(app, 'memorySaveSummary').length, 0, '未超预算不应写入会话摘要');
      const systemPrompt = String(body.systemPrompt || '');
      includes(systemPrompt, '结论先行', 'systemPrompt 缺少长期偏好');
      includes(systemPrompt, 'tech_stack', 'systemPrompt 缺少项目记忆');
      includes(systemPrompt, 'Node 22', 'systemPrompt 缺少项目记忆值');
      equal(body.messages.filter((m) => m.role === 'tool').length, 0, '普通请求不应包含工具消息');
    } finally {
      closeApp(app);
    }
  });

  /* ================================================================ *
   * 插件槽位
   * ================================================================ */
  suite('P3 集成 · 插件面板（HousePlugin uiSlots）');

  const SLOT_SOURCE = [
    'window.DSPlugins.installHousePlugin({',
    "  id: 'user.qa-slot',",
    "  name: 'QA 面板插件',",
    "  version: '1.0.0',",
    "  author: 'qa',",
    "  description: 'uiSlots QA 插件',",
    '  tools: function () { return []; },',
    '  uiSlots: function () {',
    '    return [{',
    "      id: 'qa-panel',",
    "      title: 'QA 工具面板',",
    "      type: 'button',",
    "      description: '点击运行 QA 动作',",
    "      actions: [{ action: 'ping', label: 'Ping', style: 'primary' }],",
    '      onAction: function (action) { return "pong:" + action; }',
    '    }];',
    '  }',
    '});',
  ].join('\n');

  test('HousePlugin 加载 → getUiSlots → #plugin-slots 渲染；点击 slot 按钮 → runSlotAction 调用', async () => {
    const app = await bootApp({
      prefs: API_KEY_PREFS,
      p3: {
        plugins: [{ fileName: 'user.qa-slot-1.0.0.js', source: SLOT_SOURCE, enabled: true }],
      },
    });
    try {
      const w = app.win;
      // boot 时自动 loadHousePlugins：读取目录 → 执行源码 → 收集 uiSlots → UI 渲染
      await waitFor(() => qa(app, '#plugin-slots .plugin-slot').length === 1, { timeout: 10000, label: 'HousePlugin uiSlot 渲染' });
      ok(nativeCalls(app, 'pluginList').length > 0, '未调用 Bridge.pluginList 读取插件目录');
      ok(nativeCalls(app, 'pluginReadFile').length > 0, '未调用 Bridge.pluginRead 读取插件源码');
      const slot = q(app, '#plugin-slots .plugin-slot');
      includes(String(el(slot, '.plugin-slot-title').textContent), 'QA 工具面板', 'slot 标题未渲染');
      includes(String(slot.textContent), '按钮', 'slot 类型未渲染');
      const slotId = slot.getAttribute('data-slot-id');
      ok(slotId, 'slot 缺少 data-slot-id');
      equal(w.App.getState().pluginSlots.length, 1, 'App state.pluginSlots 数量不正确');
      ok(qa(app, '.plugin-slot [data-action="slot-action"]').length === 1, 'slot 动作按钮未渲染');

      // 进入对话页（保证 slot action payload 带 chatId）后再打开插件面板（聊天页顶栏入口）
      await openChatScreen(app);
      click(w, q(app, '[data-action="open-plugin-panel"]'));
      await waitFor(() => byId(app, 'plugin-panel').classList.contains('is-open'), { timeout: 4000, label: '插件面板打开' });
      equal(byId(app, 'plugin-panel').getAttribute('aria-hidden'), 'false', '插件面板 aria-hidden 应为 false');
      equal(byId(app, 'plugin-slots-empty').hidden, true, '有 slot 时不应显示空状态');

      // 点击 slot 按钮 → DSPlugins.runSlotAction → onAction → toast 结果
      const spy = { calls: [] };
      const original = w.DSPlugins.runSlotAction;
      w.DSPlugins.runSlotAction = function (slotIdArg, action, payload) {
        spy.calls.push({ slotId: slotIdArg, action, payload });
        return original.apply(this, arguments);
      };
      try {
        click(w, q(app, '.plugin-slot [data-action="slot-action"]'));
        await waitFor(() => spy.calls.length > 0, { timeout: 5000, label: 'DSPlugins.runSlotAction 调用' });
        equal(spy.calls[0].slotId, slotId, 'runSlotAction slotId 不正确');
        equal(spy.calls[0].action, 'ping', 'runSlotAction action 应为 ping');
        isObject(spy.calls[0].payload, 'runSlotAction payload 应为对象');
        ok(spy.calls[0].payload.chatId, 'runSlotAction payload 缺少 chatId');
      } finally {
        w.DSPlugins.runSlotAction = original;
      }
      await waitFor(() => includesSafe(toastText(app), 'pong:ping'), { timeout: 5000, label: 'slot 动作结果 toast' });
    } finally {
      closeApp(app);
    }
  });

  /* ================================================================ *
   * 收尾
   * ================================================================ */
  suite('P3 集成 · 收尾');

  test('P3 全流程后无未捕获脚本错误', async () => {
    const app = await bootApp({ prefs: API_KEY_PREFS });
    try {
      const errors = app.pageErrors.filter((err) => {
        const msg = String((err && err.message) || err);
        return !/Not implemented/i.test(msg) && !/Could not parse CSS/i.test(msg) && !/jsdom.*not implemented/i.test(msg);
      });
      ok(errors.length === 0, `P3 页面出现 ${errors.length} 个未捕获错误：\n${errors.map((e) => (e && e.message) || e).join('\n')}`);
      equal(app.win.Bridge.__isMock, false, '注入 DSNative 后 Bridge 不应处于 mock 模式');
    } finally {
      closeApp(app);
    }
  });
}

/** 排序后深比较（项目记忆 3 次调用顺序不敏感）。 */
function deepEqualSorted(actual, expected, message) {
  const norm = (list) => list.map((row) => row.join('\u0001')).sort();
  const a = norm(actual);
  const b = norm(expected);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${message || '期望相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
  }
}
