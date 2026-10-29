#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
termux-mcp/server.py — DeepSeek House 的 Termux 侧 MCP Server（零第三方依赖）

协议：JSON-RPC 2.0 over streamable-http（POST /mcp）
  - initialize / notifications/initialized / tools/list / tools/call / ping
  - Authorization: Bearer <token>（除 --no-token 调试模式外强制校验）
  - 响应可为 application/json（默认）或 text/event-stream（Accept 请求 SSE 时）

工具：
  - pack_apk       调用本仓库 scripts/build.sh 打包 APK（超时 300s）
  - decompile_apk  apktool d 反编译 APK（apktool 未安装时返回提示）
  - repack_apk     apktool b 重打包 + zipalign + apksigner 签名
  - run_gradle     运行 ./gradlew <task> 或 gradle <task>
  - list_workspace 列出允许根目录内的目录内容（调试用）

安全：
  - 默认只监听 127.0.0.1（非回环地址会告警）
  - token 使用 hmac.compare_digest 常量时间比较，失败返回 HTTP 401
  - 所有工具路径 realpath 解析后必须位于 --allow-root（默认 Termux home）内，
    同时防御 `..` 穿越与 symlink 越界
  - 子进程使用参数列表调用（不用 shell=True），超时后杀整个进程组

用法：
  python3 termux-mcp/server.py --port 8787 --token "$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
  python3 termux-mcp/server.py --help
"""

import argparse
import hashlib
import hmac
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# --------------------------------------------------------------------------- #
# 常量 / 全局
# --------------------------------------------------------------------------- #
SERVER_NAME = "deepseek-house-termux-mcp"
SERVER_VERSION = "1.0.0"
PROTOCOL_VERSION = "2024-11-05"
MCP_PATH = "/mcp"

MAX_REQUEST_BYTES = 2 * 1024 * 1024  # 单个 JSON-RPC 请求体上限
LOG_TAIL_LINES = 200                 # 工具结果里保留的日志行数
MAX_LOG_CHARS = 200 * 1024           # 工具结果日志字符上限（防止超大 JSON）
MAX_LIST_ENTRIES = 500               # list_workspace 最多返回条目数

BUILD_TIMEOUT = 300
DECOMPILE_TIMEOUT = 300
REPACK_TIMEOUT = 300
GRADLE_TIMEOUT = 600

DEFAULT_ALLOW_ROOT = "/data/data/com.termux/files/home"

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PROJECT = os.path.dirname(HERE)  # termux-mcp 的上一级 = 本仓库根目录

_MISSING = object()
_LOG_LOCK = threading.Lock()


class Config:
    """进程级配置（main() 中填充）。"""

    host = "127.0.0.1"
    port = 8787
    token = ""
    no_token = False
    allow_root = DEFAULT_ALLOW_ROOT
    project = DEFAULT_PROJECT
    keystore = ""
    ks_pass = "deepseekhouse"
    ks_alias = "deepseekhouse"


CONFIG = Config()


class RpcError(Exception):
    """JSON-RPC 错误；dispatch 会转换成 {"error":{code,message,data?}}。"""

    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def log(message):
    with _LOG_LOCK:
        try:
            sys.stderr.write("[mcp] %s\n" % message)
            sys.stderr.flush()
        except Exception:
            pass


def jdump(obj):
    """把对象序列化成给客户端看的 JSON 文本（保留中文）。"""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def pretty(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2)


# --------------------------------------------------------------------------- #
# 路径策略
# --------------------------------------------------------------------------- #
def _expand(path):
    return os.path.expanduser(str(path).strip())


def realpath(path):
    return os.path.realpath(os.path.abspath(_expand(path)))


def is_within(root, target):
    root = os.path.realpath(root)
    target = os.path.realpath(target)
    return target == root or target.startswith(root + os.sep)


def resolve_allowed(path, *, must_exist=False, expect_dir=False, label="路径"):
    """把 path 解析为绝对 realpath 并校验位于 allow-root 内；否则抛 RpcError(-32602)。"""
    if path is None or not str(path).strip():
        raise RpcError(-32602, "缺少%s" % label)
    raw = _expand(path)
    if "\x00" in raw:
        raise RpcError(-32602, "%s包含非法字符" % label)
    resolved = realpath(raw)
    if not is_within(CONFIG.allow_root, resolved):
        raise RpcError(
            -32602,
            "%s超出允许范围（必须位于 --allow-root %s 内）：%s"
            % (label, CONFIG.allow_root, resolved),
            {"type": "path-policy", "allowRoot": CONFIG.allow_root, "resolved": resolved},
        )
    if must_exist and not os.path.exists(resolved):
        raise RpcError(-32602, "%s不存在：%s" % (label, resolved))
    if expect_dir and not os.path.isdir(resolved):
        raise RpcError(-32602, "%s不是目录：%s" % (label, resolved))
    return resolved


def arg_str(args, key, *, required=False, label=None):
    value = args.get(key, "")
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise RpcError(-32602, "参数 %s 必须是字符串" % key)
    value = value.strip()
    if required and not value:
        raise RpcError(-32602, "缺少必填参数 %s" % (label or key))
    return value


# --------------------------------------------------------------------------- #
# 子进程 / 文件工具
# --------------------------------------------------------------------------- #
def tail_lines(text, limit=LOG_TAIL_LINES):
    if not text:
        return ""
    s = str(text)
    if len(s) > MAX_LOG_CHARS:
        s = s[-MAX_LOG_CHARS:]
    lines = s.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if len(lines) > limit:
        lines = lines[-limit:]
    return "\n".join(lines)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def run_command(cmd, cwd=None, timeout=300):
    """
    运行命令并合并 stdout/stderr；超时后杀掉整个进程组。
    返回 {ok, exit_code, output, timed_out, duration_ms, error?}
    """
    started = time.time()
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            start_new_session=True,  # 便于超时时整组终止
        )
    except FileNotFoundError:
        return {
            "ok": False,
            "exit_code": None,
            "output": "",
            "timed_out": False,
            "duration_ms": int((time.time() - started) * 1000),
            "error": "找不到可执行文件：%s" % cmd[0],
        }
    except OSError as exc:
        return {
            "ok": False,
            "exit_code": None,
            "output": "",
            "timed_out": False,
            "duration_ms": int((time.time() - started) * 1000),
            "error": "启动命令失败：%s" % exc,
        }

    timed_out = False
    try:
        output, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        try:
            output, _ = proc.communicate(timeout=5)
        except Exception:
            output = ""
        output = (output or "") + "\n[timeout] 命令超过 %d 秒，已终止进程组" % timeout

    output = output or ""
    return {
        "ok": (not timed_out) and proc.returncode == 0,
        "exit_code": (None if timed_out else proc.returncode),
        "output": output,
        "timed_out": timed_out,
        "duration_ms": int((time.time() - started) * 1000),
        "error": ("命令超时（%d 秒）" % timeout) if timed_out else None,
    }


def command_error(result, fallback="命令执行失败"):
    # run_command 在超时/启动失败时会给出准确的中文 error，这里优先使用
    if result.get("error"):
        return result["error"]
    code = result.get("exit_code")
    return "%s（exit code: %s）" % (fallback, code)


def find_on_path(name):
    return shutil.which(name)


# --------------------------------------------------------------------------- #
# 工具实现
# --------------------------------------------------------------------------- #
def tool_pack_apk(args):
    """pack_apk {project_dir?, out_apk?} -> {ok,apk_path,size,sha256,log,...}"""
    project = resolve_allowed(
        arg_str(args, "project_dir") or CONFIG.project,
        must_exist=True,
        expect_dir=True,
        label="项目目录",
    )
    build_script = os.path.join(project, "scripts", "build.sh")
    if not os.path.isfile(build_script):
        return {
            "ok": False,
            "apk_path": "",
            "size": 0,
            "sha256": "",
            "log": "",
            "error": "未找到 scripts/build.sh：%s" % build_script,
        }

    out_apk = arg_str(args, "out_apk")
    out_apk_path = ""
    if out_apk:
        out_apk_path = resolve_allowed(out_apk, label="输出 APK 路径")
        if os.path.isdir(out_apk_path):
            raise RpcError(-32602, "输出 APK 路径是目录：%s" % out_apk_path)

    log("pack_apk: project=%s out_apk=%s" % (project, out_apk_path or "(dist)"))
    result = run_command(["bash", build_script], cwd=project, timeout=BUILD_TIMEOUT)
    out_log = tail_lines(result["output"], LOG_TAIL_LINES)

    # 找出构建产物：优先 dist 下最新的 .apk
    candidates = []
    if out_apk_path and os.path.isfile(out_apk_path):
        candidates.append(out_apk_path)
    dist_dir = os.path.join(project, "dist")
    if os.path.isdir(dist_dir):
        try:
            apks = [
                os.path.join(dist_dir, name)
                for name in os.listdir(dist_dir)
                if name.lower().endswith(".apk")
                and os.path.isfile(os.path.join(dist_dir, name))
            ]
            apks.sort(key=lambda p: os.path.getmtime(p), reverse=True)
            candidates.extend(apks)
        except OSError:
            pass

    built = candidates[0] if candidates else ""
    ok = bool(result["ok"]) and bool(built)

    # 指定了 out_apk 且构建成功：复制过去
    if ok and out_apk_path and built != out_apk_path:
        try:
            parent = os.path.dirname(out_apk_path)
            if parent and not os.path.isdir(parent):
                os.makedirs(parent, exist_ok=True)
            shutil.copy2(built, out_apk_path)
            built = out_apk_path
        except OSError as exc:
            return {
                "ok": False,
                "apk_path": "",
                "size": 0,
                "sha256": "",
                "log": out_log,
                "error": "构建成功但复制到 out_apk 失败：%s" % exc,
                "exit_code": result["exit_code"],
                "duration_ms": result["duration_ms"],
            }

    payload = {
        "ok": ok,
        "apk_path": built if ok else "",
        "size": 0,
        "sha256": "",
        "log": out_log,
        "exit_code": result["exit_code"],
        "duration_ms": result["duration_ms"],
    }
    if ok:
        try:
            payload["size"] = os.path.getsize(built)
            payload["sha256"] = sha256_file(built)
        except OSError as exc:
            payload["ok"] = False
            payload["error"] = "读取 APK 信息失败：%s" % exc
    else:
        payload["error"] = result.get("error") or "构建失败（未生成 APK）"
    return payload


def tool_decompile_apk(args):
    """decompile_apk {apk_path, out_dir?} -> {ok,out_dir,log,...}"""
    apk = resolve_allowed(arg_str(args, "apk_path", required=True), must_exist=True, label="APK 路径")
    if not os.path.isfile(apk):
        raise RpcError(-32602, "APK 路径不是文件：%s" % apk)
    if not apk.lower().endswith(".apk"):
        raise RpcError(-32602, "文件不是 .apk：%s" % apk)

    out_dir = arg_str(args, "out_dir")
    if out_dir:
        out_dir_path = resolve_allowed(out_dir, label="输出目录")
    else:
        out_dir_path = resolve_allowed(os.path.splitext(apk)[0] + "_decompiled", label="输出目录")

    apktool = find_on_path("apktool")
    if not apktool:
        return {
            "ok": False,
            "out_dir": out_dir_path,
            "log": "",
            "error": "未安装 apktool：请运行 `pkg install apktool`（或 pip install apktool）后重试",
        }

    log("decompile_apk: apk=%s out=%s" % (apk, out_dir_path))
    result = run_command(
        [apktool, "d", "-f", "-o", out_dir_path, apk],
        cwd=os.path.dirname(apk),
        timeout=DECOMPILE_TIMEOUT,
    )
    payload = {
        "ok": result["ok"] and os.path.isdir(out_dir_path),
        "out_dir": out_dir_path,
        "log": tail_lines(result["output"], LOG_TAIL_LINES),
        "exit_code": result["exit_code"],
        "duration_ms": result["duration_ms"],
    }
    if not payload["ok"]:
        payload["error"] = command_error(result, "apktool 反编译失败")
    return payload


def tool_repack_apk(args):
    """repack_apk {dir, out_apk?} -> {ok,apk_path,size?,sha256?,log,...}"""
    work_dir = resolve_allowed(arg_str(args, "dir", required=True), must_exist=True, expect_dir=True, label="反编译目录")
    out_apk = arg_str(args, "out_apk")
    if out_apk:
        out_apk_path = resolve_allowed(out_apk, label="输出 APK 路径")
    else:
        out_apk_path = resolve_allowed(
            os.path.join(os.path.dirname(work_dir), os.path.basename(work_dir) + "-repacked.apk"),
            label="输出 APK 路径",
        )
    if os.path.isdir(out_apk_path):
        raise RpcError(-32602, "输出 APK 路径是目录：%s" % out_apk_path)

    apktool = find_on_path("apktool")
    if not apktool:
        return {
            "ok": False,
            "apk_path": "",
            "log": "",
            "error": "未安装 apktool：请运行 `pkg install apktool`（或 pip install apktool）后重试",
        }
    apksigner = find_on_path("apksigner")
    if not apksigner:
        return {
            "ok": False,
            "apk_path": "",
            "log": "",
            "error": "未找到 apksigner：请运行 `pkg install apksigner` 后重试",
        }

    keystore = os.path.realpath(CONFIG.keystore) if CONFIG.keystore else ""
    if not keystore or not os.path.isfile(keystore):
        return {
            "ok": False,
            "apk_path": "",
            "log": "",
            "error": "未找到签名 keystore：%s（可用 --keystore 指定）"
            % (keystore or CONFIG.keystore or "(未配置)"),
        }
    if not is_within(CONFIG.allow_root, keystore):
        return {
            "ok": False,
            "apk_path": "",
            "log": "",
            "error": "keystore 超出允许范围（--allow-root）：%s" % keystore,
        }

    logs = []
    unsigned = out_apk_path + ".unsigned.apk"
    aligned = out_apk_path + ".aligned.apk"
    try:
        log("repack_apk: dir=%s out=%s" % (work_dir, out_apk_path))
        step = run_command(
            [apktool, "b", "-f", "-o", unsigned, work_dir],
            cwd=os.path.dirname(work_dir),
            timeout=REPACK_TIMEOUT,
        )
        logs.append("== apktool b ==\n" + tail_lines(step["output"], 80))
        if not step["ok"]:
            return {
                "ok": False,
                "apk_path": "",
                "log": "\n".join(logs),
                "error": command_error(step, "apktool 重打包失败"),
            }

        to_sign = unsigned
        zipalign = find_on_path("zipalign")
        if zipalign:
            align_step = run_command(
                [zipalign, "-f", "-p", "4", unsigned, aligned],
                cwd=os.path.dirname(work_dir),
                timeout=120,
            )
            logs.append("== zipalign ==\n" + tail_lines(align_step["output"], 40))
            if align_step["ok"]:
                to_sign = aligned

        parent = os.path.dirname(out_apk_path)
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        sign_step = run_command(
            [
                apksigner,
                "sign",
                "--ks",
                keystore,
                "--ks-key-alias",
                CONFIG.ks_alias,
                "--ks-pass",
                "pass:" + CONFIG.ks_pass,
                "--key-pass",
                "pass:" + CONFIG.ks_pass,
                "--out",
                out_apk_path,
                to_sign,
            ],
            cwd=os.path.dirname(work_dir),
            timeout=REPACK_TIMEOUT,
        )
        logs.append("== apksigner sign ==\n" + tail_lines(sign_step["output"], 60))

        ok = sign_step["ok"] and os.path.isfile(out_apk_path)
        payload = {
            "ok": ok,
            "apk_path": out_apk_path if ok else "",
            "log": "\n".join(logs),
            "exit_code": sign_step["exit_code"],
            "duration_ms": step["duration_ms"] + sign_step["duration_ms"],
        }
        if ok:
            try:
                payload["size"] = os.path.getsize(out_apk_path)
                payload["sha256"] = sha256_file(out_apk_path)
            except OSError:
                pass
        else:
            payload["error"] = command_error(sign_step, "apksigner 签名失败")
        return payload
    finally:
        for tmp in (unsigned, aligned):
            try:
                if os.path.isfile(tmp):
                    os.remove(tmp)
            except OSError:
                pass


def tool_run_gradle(args):
    """run_gradle {project_dir, task} -> {ok,task,log,tail,...}"""
    project = resolve_allowed(
        arg_str(args, "project_dir") or CONFIG.project,
        must_exist=True,
        expect_dir=True,
        label="项目目录",
    )
    task = arg_str(args, "task", required=True)
    if len(task) > 200 or not re.match(r"^[A-Za-z0-9_.:\-]+$", task):
        raise RpcError(-32602, "task 参数不合法（只允许字母/数字/_/./:/-，最长 200）：%s" % task)

    gradlew = os.path.join(project, "gradlew")
    if os.path.isfile(gradlew):
        if os.access(gradlew, os.X_OK):
            cmd = [gradlew, task]
        else:
            cmd = ["bash", gradlew, task]
    else:
        gradle = find_on_path("gradle")
        if not gradle:
            return {
                "ok": False,
                "task": task,
                "log": "",
                "tail": "",
                "error": "未找到 ./gradlew，也未安装 gradle：请运行 `pkg install gradle` 或使用 Gradle 项目",
            }
        cmd = [gradle, task]

    log("run_gradle: project=%s task=%s" % (project, task))
    result = run_command(cmd, cwd=project, timeout=GRADLE_TIMEOUT)
    payload = {
        "ok": result["ok"],
        "task": task,
        "log": tail_lines(result["output"], LOG_TAIL_LINES),
        "tail": tail_lines(result["output"], 20),
        "exit_code": result["exit_code"],
        "duration_ms": result["duration_ms"],
    }
    if not payload["ok"]:
        payload["error"] = command_error(result, "Gradle 执行失败")
    return payload


def tool_list_workspace(args):
    """list_workspace {path?} -> {ok,path,entries:[...],...}"""
    target = arg_str(args, "path") or CONFIG.allow_root
    path = resolve_allowed(target, must_exist=True, expect_dir=True, label="目录")
    entries = []
    truncated = False
    try:
        with os.scandir(path) as it:
            items = list(it)
    except OSError as exc:
        return {"ok": False, "path": path, "entries": [], "count": 0, "truncated": False, "error": "读取目录失败：%s" % exc}

    def sort_key(entry):
        try:
            is_dir = entry.is_dir(follow_symlinks=False)
        except OSError:
            is_dir = False
        return (0 if is_dir else 1, entry.name.lower())

    items.sort(key=sort_key)
    total = len(items)
    if total > MAX_LIST_ENTRIES:
        items = items[:MAX_LIST_ENTRIES]
        truncated = True

    for entry in items:
        try:
            stat = entry.stat(follow_symlinks=False)
            is_dir = entry.is_dir(follow_symlinks=False)
            item = {
                "name": entry.name,
                "path": os.path.join(path, entry.name),
                "is_dir": bool(is_dir),
                "is_symlink": bool(entry.is_symlink()),
                "size": 0 if is_dir else int(stat.st_size),
                "modified": int(stat.st_mtime),
            }
        except OSError:
            item = {
                "name": entry.name,
                "path": os.path.join(path, entry.name),
                "is_dir": False,
                "is_symlink": bool(entry.is_symlink()),
                "size": 0,
                "modified": 0,
            }
        entries.append(item)

    return {
        "ok": True,
        "path": path,
        "allow_root": CONFIG.allow_root,
        "count": len(entries),
        "total": total,
        "truncated": truncated,
        "entries": entries,
    }


TOOLS = [
    {
        "name": "pack_apk",
        "description": "在 Termux 本机构建 DeepSeek House APK：运行 <project_dir>/scripts/build.sh（超时 300 秒），返回 APK 路径、大小、SHA-256 与日志尾部 200 行。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {
                    "type": "string",
                    "description": "项目根目录（默认服务启动时的 --project，即本仓库；必须位于 --allow-root 内）",
                },
                "out_apk": {
                    "type": "string",
                    "description": "可选：把构建出的 APK 复制到该路径（必须位于 --allow-root 内）",
                },
            },
            "required": [],
        },
        "handler": tool_pack_apk,
    },
    {
        "name": "decompile_apk",
        "description": "用 apktool d 反编译 APK 到目录（apktool 未安装会返回安装提示），返回输出目录与日志。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "apk_path": {"type": "string", "description": "要反编译的 .apk 路径（必须位于 --allow-root 内）"},
                "out_dir": {"type": "string", "description": "可选：输出目录（默认 <apk 同目录>/<apk 名>_decompiled）"},
            },
            "required": ["apk_path"],
        },
        "handler": tool_decompile_apk,
    },
    {
        "name": "repack_apk",
        "description": "用 apktool b 重打包反编译目录，zipalign 后调用 apksigner 以仓库 keystore 签名，返回签名后的 APK 路径与日志。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "dir": {"type": "string", "description": "apktool 反编译出来的目录（必须位于 --allow-root 内）"},
                "out_apk": {"type": "string", "description": "可选：输出 APK 路径（默认 <dir 的父目录>/<dir 名>-repacked.apk）"},
            },
            "required": ["dir"],
        },
        "handler": tool_repack_apk,
    },
    {
        "name": "run_gradle",
        "description": "在指定项目目录运行 ./gradlew <task>（无 wrapper 时用 gradle <task>），返回是否成功、日志尾部 200 行与最后 20 行。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_dir": {"type": "string", "description": "Gradle 项目目录（默认本仓库；必须位于 --allow-root 内）"},
                "task": {"type": "string", "description": "Gradle 任务名，例如 assembleDebug / clean / :app:build"},
            },
            "required": ["task"],
        },
        "handler": tool_run_gradle,
    },
    {
        "name": "list_workspace",
        "description": "列出允许根目录内的目录内容（名称/路径/是否目录/大小/修改时间），便于 App 端调试工作区。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "要列出的目录（默认 --allow-root；必须位于 --allow-root 内）"},
            },
            "required": [],
        },
        "handler": tool_list_workspace,
    },
]

TOOLS_BY_NAME = {tool["name"]: tool for tool in TOOLS}


# --------------------------------------------------------------------------- #
# JSON-RPC 处理
# --------------------------------------------------------------------------- #
def rpc_error(req_id, code, message, data=None):
    err = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": req_id, "error": err}


def make_result(req_id, result):
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def tool_payload_result(payload):
    text = jdump(payload)
    result = {"content": [{"type": "text", "text": text}]}
    if isinstance(payload, dict) and payload.get("ok") is False:
        result["isError"] = True
    return result


def dispatch(request):
    """
    处理单个 JSON-RPC 消息。
    - 返回 dict 响应；通知（notifications/* 或没有 id）返回 None。
    """
    if not isinstance(request, dict):
        return rpc_error(None, -32600, "Invalid Request：JSON-RPC 消息必须是对象")

    jsonrpc = request.get("jsonrpc")
    method = request.get("method")
    req_id = request.get("id", _MISSING)

    if jsonrpc != "2.0":
        return rpc_error(None if req_id is _MISSING else req_id, -32600, 'Invalid Request：jsonrpc 必须为 "2.0"')
    if not isinstance(method, str) or not method:
        return rpc_error(None if req_id is _MISSING else req_id, -32600, "Invalid Request：缺少 method")

    is_notification = req_id is _MISSING or method.startswith("notifications/")
    if is_notification:
        # notifications/initialized、notifications/cancelled 等：不需要响应
        return None

    try:
        if method == "initialize":
            result = {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "instructions": "DeepSeek House Termux MCP Server：提供 pack_apk / decompile_apk / repack_apk / run_gradle / list_workspace 工具。",
            }
            return make_result(req_id, result)

        if method == "ping":
            return make_result(req_id, {})

        if method == "tools/list":
            return make_result(
                req_id,
                {
                    "tools": [
                        {
                            "name": tool["name"],
                            "description": tool["description"],
                            "inputSchema": tool["inputSchema"],
                        }
                        for tool in TOOLS
                    ]
                },
            )

        if method == "tools/call":
            params = request.get("params")
            if not isinstance(params, dict):
                raise RpcError(-32602, "Invalid params：params 必须是对象")
            name = params.get("name")
            if not isinstance(name, str) or not name.strip():
                raise RpcError(-32602, "Invalid params：缺少工具名 name")
            name = name.strip()
            tool = TOOLS_BY_NAME.get(name)
            if not tool:
                raise RpcError(-32602, "未知工具：%s（可用：%s）" % (name, ", ".join(sorted(TOOLS_BY_NAME))))
            arguments = params.get("arguments")
            if arguments is None:
                arguments = {}
            if not isinstance(arguments, dict):
                raise RpcError(-32602, "Invalid params：arguments 必须是对象")
            started = time.time()
            try:
                payload = tool["handler"](arguments)
            except RpcError:
                raise
            except Exception as exc:  # 工具实现异常：返回 ok:false 的 JSON，而不是让对话崩溃
                log("tool %s 异常：%s" % (name, traceback.format_exc()))
                payload = {
                    "ok": False,
                    "error": "工具执行异常：%s" % exc,
                    "log": "",
                }
            elapsed = int((time.time() - started) * 1000)
            ok = bool(payload.get("ok")) if isinstance(payload, dict) else False
            log("tools/call %s ok=%s %dms" % (name, ok, elapsed))
            return make_result(req_id, tool_payload_result(payload))

        raise RpcError(-32601, "Method not found：%s" % method)
    except RpcError as exc:
        return rpc_error(req_id, exc.code, exc.message, exc.data)
    except Exception as exc:  # 兜底：不让异常冒泡到 HTTP 层
        log("dispatch 内部错误：%s" % traceback.format_exc())
        return rpc_error(req_id, -32603, "Internal error：%s" % exc)


# --------------------------------------------------------------------------- #
# HTTP 层
# --------------------------------------------------------------------------- #
class McpHandler(BaseHTTPRequestHandler):
    server_version = "DeepSeekHouseMCP/" + SERVER_VERSION
    protocol_version = "HTTP/1.1"

    # 不在访问日志里打印 Authorization 头（log_message 只输出请求行）
    def log_message(self, fmt, *args):
        log("%s - %s" % (self.address_string(), fmt % args))

    # ---- 响应辅助 -------------------------------------------------------- #
    def _send_json(self, status, payload, extra_headers=None):
        data = jdump(payload).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            for key, value in (extra_headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _send_empty(self, status, extra_headers=None):
        try:
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            for key, value in (extra_headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _accepts_sse(self):
        accept = self.headers.get("Accept", "") or ""
        return "text/event-stream" in accept.lower()

    def _send_rpc_response(self, payload):
        # 客户端请求 SSE 时按 streamable-http 返回单条 SSE 事件；否则普通 JSON
        if self._accepts_sse():
            data = ("event: message\ndata: " + jdump(payload) + "\n\n").encode("utf-8")
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
            return
        self._send_json(200, payload)

    # ---- 鉴权 ------------------------------------------------------------ #
    def _authorized(self):
        if CONFIG.no_token:
            return True
        token = CONFIG.token or ""
        header = self.headers.get("Authorization", "") or ""
        parts = header.strip().split(None, 1)
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return False
        supplied = parts[1].strip()
        if not supplied:
            return False
        try:
            return hmac.compare_digest(supplied.encode("utf-8"), token.encode("utf-8"))
        except Exception:
            return False

    # ---- 路由 ------------------------------------------------------------ #
    def do_GET(self):
        path = urlparse(self.path).path
        if path.rstrip("/") == MCP_PATH:
            self._send_json(
                405,
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Method Not Allowed：MCP 端点只接受 POST"}},
                {"Allow": "POST"},
            )
            return
        self._send_json(404, {"error": "Not Found", "path": path})

    def do_POST(self):
        path = urlparse(self.path).path
        if path.rstrip("/") != MCP_PATH:
            self._send_json(404, {"error": "Not Found", "path": path})
            return

        if not self._authorized():
            self.close_connection = True
            self._send_json(
                401,
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32001, "message": "Unauthorized：缺少或错误的 Bearer Token"}},
                {
                    "WWW-Authenticate": 'Bearer realm="DeepSeek House MCP"',
                    "Connection": "close",
                },
            )
            return

        length_header = self.headers.get("Content-Length")
        if length_header is None:
            self._send_json(
                411,
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Length Required：缺少 Content-Length"}},
            )
            return
        try:
            length = int(length_header)
        except ValueError:
            length = -1
        if length < 0:
            self._send_json(
                400,
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Bad Request：Content-Length 无效"}},
            )
            return
        if length > MAX_REQUEST_BYTES:
            self.close_connection = True
            self._send_json(
                413,
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Payload Too Large：请求体超过 %d 字节" % MAX_REQUEST_BYTES}},
                {"Connection": "close"},
            )
            return

        raw = self.rfile.read(length)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            self._send_json(200, rpc_error(None, -32700, "Parse error：请求体不是 UTF-8"))
            return
        try:
            payload = json.loads(text)
        except (json.JSONDecodeError, ValueError) as exc:
            self._send_json(200, rpc_error(None, -32700, "Parse error：%s" % exc))
            return

        # JSON-RPC 批量请求
        if isinstance(payload, list):
            if not payload:
                self._send_json(200, rpc_error(None, -32600, "Invalid Request：空 batch"))
                return
            responses = [dispatch(item) for item in payload]
            responses = [item for item in responses if item is not None]
            if not responses:
                self._send_empty(202)
            else:
                self._send_rpc_response(responses)
            return

        response = dispatch(payload)
        if response is None:
            # 通知（notifications/initialized 等）：空响应
            self._send_empty(202)
            return
        self._send_rpc_response(response)


class McpHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


# --------------------------------------------------------------------------- #
# 启动
# --------------------------------------------------------------------------- #
def mask_token(token):
    token = token or ""
    if not token:
        return "(未设置)"
    if len(token) <= 8:
        return token[0] + "…" + token[-1]
    return token[:4] + "…" + token[-4:]


def build_parser():
    parser = argparse.ArgumentParser(
        prog="termux-mcp/server.py",
        description="DeepSeek House 的 Termux 侧 MCP Server（Python 标准库，零第三方依赖）",
    )
    parser.add_argument("--host", default=os.environ.get("DSH_MCP_HOST", "127.0.0.1"), help="监听地址（默认 127.0.0.1）")
    parser.add_argument("--port", type=int, default=int(os.environ.get("DSH_MCP_PORT", "8787")), help="监听端口（默认 8787）")
    parser.add_argument(
        "--token",
        default=os.environ.get("DSH_MCP_TOKEN", ""),
        help="Bearer Token（也可用环境变量 DSH_MCP_TOKEN，避免出现在进程列表）",
    )
    parser.add_argument("--no-token", action="store_true", help="关闭 Token 校验，仅限本机调试（危险）")
    parser.add_argument(
        "--allow-root",
        default=os.environ.get("DSH_MCP_ALLOW_ROOT", DEFAULT_ALLOW_ROOT),
        help="允许访问的根目录（默认 %s）" % DEFAULT_ALLOW_ROOT,
    )
    parser.add_argument(
        "--project",
        default=os.environ.get("DSH_MCP_PROJECT", DEFAULT_PROJECT),
        help="默认项目目录（默认本仓库根目录）",
    )
    parser.add_argument("--keystore", default=os.environ.get("DSH_MCP_KEYSTORE", ""), help="repack_apk 使用的 keystore（默认 <project>/keystore/dsh-release.keystore）")
    parser.add_argument("--ks-pass", default=os.environ.get("DSH_KS_PASS", "deepseekhouse"), help="keystore 密码（默认 deepseekhouse）")
    parser.add_argument("--ks-alias", default=os.environ.get("DSH_KS_ALIAS", "deepseekhouse"), help="keystore key alias（默认 deepseekhouse）")
    parser.add_argument("--version", action="version", version="%(prog)s " + SERVER_VERSION)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.no_token and not (args.token or "").strip():
        parser.error(
            "必须提供访问令牌：--token <TOKEN> 或环境变量 DSH_MCP_TOKEN；"
            "仅本机临时调试可加 --no-token（不校验，危险）"
        )
    if not (0 < args.port < 65536):
        parser.error("--port 必须在 1–65535 之间")

    allow_root = realpath(args.allow_root)
    if not os.path.isdir(allow_root):
        parser.error("--allow-root 不是目录：%s" % allow_root)
    project = realpath(args.project)
    if not os.path.isdir(project):
        parser.error("--project 不是目录：%s" % project)
    if not is_within(allow_root, project):
        parser.error("--project 必须位于 --allow-root 内：%s 不在 %s 内" % (project, allow_root))
    keystore = realpath(args.keystore) if args.keystore else os.path.join(project, "keystore", "dsh-release.keystore")

    CONFIG.host = args.host
    CONFIG.port = args.port
    CONFIG.token = "" if args.no_token else (args.token or "").strip()
    CONFIG.no_token = bool(args.no_token)
    CONFIG.allow_root = allow_root
    CONFIG.project = project
    CONFIG.keystore = keystore
    CONFIG.ks_pass = args.ks_pass
    CONFIG.ks_alias = args.ks_alias

    is_loopback = args.host in ("127.0.0.1", "localhost", "::1")
    try:
        httpd = McpHTTPServer((args.host, args.port), McpHandler)
    except OSError as exc:
        log("启动失败：无法监听 %s:%d（%s）" % (args.host, args.port, exc))
        return 1

    log("=" * 62)
    log("DeepSeek House Termux MCP Server v%s" % SERVER_VERSION)
    log("URL          : http://%s:%d%s" % (args.host, args.port, MCP_PATH))
    if CONFIG.no_token:
        log("Token        : 未启用（--no-token 调试模式，仅限本机！）")
    else:
        log("Token        : 已设置 %s" % mask_token(CONFIG.token))
    log("协议版本      : %s" % PROTOCOL_VERSION)
    log("allow-root   : %s" % CONFIG.allow_root)
    log("project      : %s" % CONFIG.project)
    log("keystore     : %s" % CONFIG.keystore)
    log("工具          : %s" % ", ".join(tool["name"] for tool in TOOLS))
    log("已安装工具    : apktool=%s gradle=%s apksigner=%s aapt=%s d8=%s zipalign=%s"
        % tuple("是" if find_on_path(name) else "否" for name in ("apktool", "gradle", "apksigner", "aapt", "d8", "zipalign")))
    if not is_loopback:
        log("警告：正在监听非回环地址 %s，Token 会以明文 HTTP 传输，请确保网络可信！" % args.host)
    log("=" * 62)
    log("按 Ctrl+C 停止。客户端请填：http://%s:%d%s" % (args.host, args.port, MCP_PATH))

    try:
        httpd.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        log("收到 Ctrl+C，正在停止…")
    finally:
        try:
            httpd.server_close()
        finally:
            log("MCP Server 已停止")
    return 0


if __name__ == "__main__":
    sys.exit(main())
