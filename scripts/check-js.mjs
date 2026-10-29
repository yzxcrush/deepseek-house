#!/usr/bin/env node
/**
 * Syntax-check every JS file in the WebView layer.
 * Uses vm.Script so it works on Termux's node wrapper (which rejects `node --check`).
 * Usage: node scripts/check-js.mjs [dir]
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = process.argv[2] || path.resolve(import.meta.dirname, "..", "app", "assets", "web");

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith(".js")) out.push(p);
  }
  return out.sort();
}

const files = walk(root);
let failed = 0;
for (const file of files) {
  const rel = path.relative(root, file);
  try {
    new vm.Script(fs.readFileSync(file, "utf8"), { filename: rel });
  } catch (err) {
    failed++;
    console.error(`SYNTAX ERROR  ${rel}\n  ${err.message}`);
  }
}
if (failed) {
  console.error(`\n${failed} file(s) with syntax errors (of ${files.length})`);
  process.exit(1);
}
console.log(`syntax OK: ${files.length} file(s) under ${root}`);
