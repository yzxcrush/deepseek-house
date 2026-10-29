/**
 * scripts/qa/lib/harness.mjs
 * 零依赖测试框架：suite / test / 断言 / 超时 / 失败详情。
 * 由 run-tests.mjs 调用。
 */

export const results = {
  passed: 0,
  failed: 0,
  skipped: 0,
  failures: [],
};

const tests = [];
let currentSuite = '(未分组)';

export function suite(name) {
  currentSuite = String(name);
}

/**
 * 注册一个测试。
 * @param {string} name
 * @param {(ctx:any)=>any|Promise<any>} fn
 * @param {{skip?: boolean|string, timeout?: number}} [opts]
 */
export function test(name, fn, opts = {}) {
  tests.push({
    suite: currentSuite,
    name,
    fn,
    skip: opts.skip,
    timeout: opts.timeout,
  });
}

export function skip(name, reason) {
  tests.push({ suite: currentSuite, name, skip: true, skipReason: reason || 'skipped', timeout: 1000 });
}

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */
class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

function short(value, max = 220) {
  let s;
  if (typeof value === 'string') s = JSON.stringify(value);
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  if (s === undefined) s = String(value);
  return s.length > max ? s.slice(0, max) + `…(${s.length} chars)` : s;
}

export function fail(message) {
  throw new AssertionError(message);
}

export function ok(cond, message) {
  if (!cond) fail(message || '期望为真，实际为假');
}

export function equal(actual, expected, message) {
  if (actual !== expected) {
    fail(`${message || '期望相等'}：期望 ${short(expected)}，实际 ${short(actual)}`);
  }
}

export function notEqual(actual, unexpected, message) {
  if (actual === unexpected) {
    fail(`${message || '期望不相等'}：不应等于 ${short(unexpected)}`);
  }
}

export function deepEqual(actual, expected, message) {
  const a = stableJson(actual);
  const b = stableJson(expected);
  if (a !== b) fail(`${message || '期望深相等'}：期望 ${short(expected)}，实际 ${short(actual)}`);
}

function stableJson(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (k, v) => {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
      if (Array.isArray(v)) return v;
      return Object.keys(v)
        .sort()
        .reduce((o, key) => {
          o[key] = v[key];
          return o;
        }, {});
    }
    return v;
  });
}

export function includes(haystack, needle, message) {
  const h = String(haystack === null || haystack === undefined ? '' : haystack);
  const n = String(needle);
  if (h.indexOf(n) === -1) fail(`${message || '期望包含'}：${short(n)} 不在 ${short(h, 500)} 中`);
}

export function notIncludes(haystack, needle, message) {
  const h = String(haystack === null || haystack === undefined ? '' : haystack);
  const n = String(needle);
  if (h.indexOf(n) !== -1) fail(`${message || '期望不包含'}：${short(n)} 出现在 ${short(h, 500)} 中`);
}

export function match(value, re, message) {
  const s = String(value === null || value === undefined ? '' : value);
  if (!re.test(s)) fail(`${message || '期望匹配'}：${short(s, 300)} 不匹配 ${re}`);
}

export function isString(value, message) {
  if (typeof value !== 'string') fail(`${message || '期望字符串'}：实际类型 ${typeof value}，值 ${short(value)}`);
}

export function isFunction(value, message) {
  if (typeof value !== 'function') fail(`${message || '期望函数'}：实际类型 ${typeof value}，值 ${short(value)}`);
}

export function isArray(value, message) {
  if (!Array.isArray(value)) fail(`${message || '期望数组'}：实际 ${short(value)}`);
}

export function isObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${message || '期望对象'}：实际 ${short(value)}`);
  }
}

export function isTrue(value, message) {
  equal(value, true, message);
}

export function isFalse(value, message) {
  equal(value, false, message);
}

export const assert = { ok, equal, notEqual, deepEqual, includes, notIncludes, match, isString, isFunction, isArray, isObject, isTrue, isFalse, fail };

/* ------------------------------------------------------------------ *
 * 运行
 * ------------------------------------------------------------------ */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`测试超时（>${ms}ms）：${label}`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function reportOne(t, err, durationMs) {
  const label = `[${t.suite}] ${t.name}`;
  if (err) {
    results.failed += 1;
    results.failures.push({ suite: t.suite, name: t.name, error: err, durationMs });
    console.log(`  ✗ ${t.name}  (${durationMs}ms)`);
    const lines = String((err && err.stack) || err).split('\n');
    for (const line of lines.slice(0, 8)) console.log(`      ${line}`);
  } else {
    results.passed += 1;
    console.log(`  ✓ ${t.name}  (${durationMs}ms)`);
  }
  return label;
}

/**
 * 按注册顺序执行全部测试。每个测试独立超时，失败不中断后续测试。
 * @param {{defaultTimeout?:number, filter?:string}} [opts]
 */
export async function runAll(opts = {}) {
  const defaultTimeout = opts.defaultTimeout || 20000;
  const filter = opts.filter ? String(opts.filter) : '';
  let lastSuite = '';
  for (const t of tests) {
    if (filter && `${t.suite} ${t.name}`.indexOf(filter) === -1) continue;
    if (t.suite !== lastSuite) {
      console.log(`\n▶ ${t.suite}`);
      lastSuite = t.suite;
    }
    if (t.skip) {
      results.skipped += 1;
      console.log(`  - ${t.name}  (跳过：${t.skipReason || 'skipped'})`);
      continue;
    }
    const start = Date.now();
    try {
      await withTimeout(t.fn(), t.timeout || defaultTimeout, t.name);
      reportOne(t, null, Date.now() - start);
    } catch (err) {
      reportOne(t, err, Date.now() - start);
    }
  }
  return results;
}

export function printSummary() {
  const total = results.passed + results.failed + results.skipped;
  console.log('\n' + '='.repeat(64));
  if (results.failed === 0) {
    console.log(`ALL TESTS PASSED (${results.passed})`);
    if (results.skipped) console.log(`（跳过 ${results.skipped} 项，共 ${total} 项）`);
  } else {
    console.log(`FAILED: ${results.failed} 项失败，${results.passed} 项通过，${results.skipped} 项跳过（共 ${total} 项）`);
    for (const f of results.failures) {
      const msg = String((f.error && f.error.message) || f.error);
      console.log(`  ✗ [${f.suite}] ${f.name}\n      ${msg.split('\n')[0]}`);
    }
  }
  console.log('='.repeat(64));
  return results.failed === 0 ? 0 : 1;
}
