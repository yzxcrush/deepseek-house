#!/usr/bin/env node
/**
 * scripts/qa/run-tests.mjs — DeepSeek House QA 主入口
 *
 * 用法：
 *   npm test                 # 全部测试
 *   node scripts/qa/run-tests.mjs static      # 只跑名字包含 "static" 的测试（也可用 QA_FILTER 环境变量）
 *   QA_FILTER="store" npm test
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 */

import { runAll, printSummary } from './lib/harness.mjs';
import { registerStaticTests } from './static-checks.mjs';
import { registerUnitTests } from './unit-tests.mjs';

const filter = process.env.QA_FILTER || process.argv.slice(2).join(' ').trim();

const startedAt = Date.now();
console.log('DeepSeek House — QA test suite');
console.log(`cwd: ${process.cwd()}`);
console.log(`时间: ${new Date().toISOString()}`);
if (filter) console.log(`过滤: "${filter}"`);

registerStaticTests();
registerUnitTests();

// 集成测试模块在文件齐全后才有意义；模块本身始终存在，内部会给出缺失清单。
try {
  const integration = await import('./integration-tests.mjs');
  integration.registerIntegrationTests();
} catch (err) {
  console.error('\n⚠ 无法加载集成测试模块 integration-tests.mjs：', err && err.message);
  process.exitCode = 1;
}

const results = await runAll({ filter, defaultTimeout: 30000 });
const code = printSummary(results);
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`总耗时 ${seconds}s`);
process.exit(code);
