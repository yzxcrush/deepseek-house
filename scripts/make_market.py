#!/usr/bin/env python3
"""生成官方插件市场索引 market/index.json。

用法：python3 scripts/make_market.py
- 扫描 market/plugins/*.js
- 读取文件头注释 @id/@name/@version/@author/@description/@tags/@category
- 计算 sha256 与 HMAC-SHA256（与 App 内置 PluginRepository.HMAC_KEY 一致）写入索引
"""
import hashlib
import hmac
import json
import pathlib
import re
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
PLUGIN_DIR = ROOT / "market" / "plugins"
INDEX = ROOT / "market" / "index.json"
RAW_BASE = "https://raw.githubusercontent.com/yzxcrush/deepseek-house/main/market/plugins/"
# 与 app/src/main/java/com/deepseekhouse/app/plugin/PluginRepository.java 的 HMAC_KEY 完全一致
HMAC_KEY = bytes([
    0xD5, 0x48, 0x6F, 0x75, 0x73, 0x65, 0x2D, 0x50,
    0x6C, 0x75, 0x67, 0x69, 0x6E, 0x2D, 0x48, 0x4D,
    0x41, 0x43, 0x2D, 0x76, 0x32, 0x30, 0x32, 0x36,
])
META_RE = re.compile(r"^//\s*@(id|name|version|author|description|tags|category|homepage)\s+(.+?)\s*$")


def parse_meta(text: str):
    meta = {}
    for line in text.splitlines()[:40]:
        m = META_RE.match(line)
        if m:
            meta[m.group(1)] = m.group(2)
    return meta


def main():
    items = []
    for path in sorted(PLUGIN_DIR.glob("*.js")):
        raw = path.read_bytes()
        text = raw.decode("utf-8")
        meta = parse_meta(text)
        sha = hashlib.sha256(raw).hexdigest()
        mac = hmac.new(HMAC_KEY, raw, hashlib.sha256).hexdigest()
        tags = [t.strip() for t in (meta.get("tags") or "").split(",") if t.strip()]
        items.append({
            "id": meta.get("id") or path.stem,
            "name": meta.get("name") or path.stem,
            "version": meta.get("version") or "1.0.0",
            "author": meta.get("author") or "DeepSeek House",
            "description": meta.get("description") or "",
            "category": meta.get("category") or "其它",
            "tags": tags,
            "url": RAW_BASE + path.name,
            "sha256": sha,
            "hmac": mac,
            "size": len(raw),
        })
    index = {
        "version": 1,
        "name": "DeepSeek House 官方插件市场",
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "baseUrl": RAW_BASE,
        "plugins": items,
    }
    INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"market/index.json: {len(items)} plugins")
    for it in items:
        print(f"  - {it['id']} v{it['version']} ({it['size']}B) sha={it['sha256'][:12]}… hmac={it['hmac'][:12]}…")


if __name__ == "__main__":
    main()
