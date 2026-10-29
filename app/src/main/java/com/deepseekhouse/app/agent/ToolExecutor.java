package com.deepseekhouse.app.agent;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * 内置工具的定义 + 执行（SPEC N1）。
 *
 * <p>工具清单：</p>
 * <ul>
 *   <li>{@code read_file {path}} LOW：读工作区内文本，≤256KB，超限截断；</li>
 *   <li>{@code list_dir {path?}} LOW：列目录 [{name,path,isDir,size}]，默认工作区根；</li>
 *   <li>{@code write_file {path, content}} MID：仅工作区内写，自动建父目录，≤1MB；</li>
 *   <li>{@code run_shell {command}} HIGH：{@code /system/bin/sh -c}，cwd=工作区，30s 超时，输出≤64KB；</li>
 *   <li>{@code http_get {url}} LOW：仅 https（localhost 例外），≤1MB 读取，返回状态 + 前 200KB 文本。</li>
 * </ul>
 *
 * <p>每次执行（成功/失败）都写 {@link AuditDb}；路径全部经 {@link PathPolicy} 校验。
 * {@link #execute} 会阻塞（含网络/shell），只能在后台线程调用。</p>
 */
public final class ToolExecutor {

    public static final int MAX_READ_FILE_BYTES = Workspace.MAX_READ_BYTES;
    public static final int MAX_WRITE_FILE_BYTES = Workspace.MAX_WRITE_BYTES;
    public static final int MAX_HTTP_READ_BYTES = 1024 * 1024;
    public static final int MAX_HTTP_RETURN_CHARS = 200 * 1024;
    private static final int HTTP_CONNECT_TIMEOUT_MS = 10 * 1000;
    private static final int HTTP_READ_TIMEOUT_MS = 20 * 1000;
    private static final String USER_AGENT = "DeepSeekHouse/1.0.0 (Android)";

    private static boolean builtinsRegistered;

    private final Workspace workspace;
    private final AuditDb auditDb;
    private final ShellRunner shellRunner;

    /** 执行结果：ok 表示工具调用成功（进程退出码非 0 视为失败，但 output 仍会带回）。 */
    public static final class Outcome {
        public final boolean ok;
        public final String result;

        private Outcome(boolean ok, String result) {
            this.ok = ok;
            this.result = result == null ? "" : result;
        }

        public static Outcome ok(String result) {
            return new Outcome(true, result);
        }

        public static Outcome fail(String result) {
            return new Outcome(false, result);
        }
    }

    public ToolExecutor(Workspace workspace, AuditDb auditDb) {
        if (workspace == null) {
            throw new IllegalArgumentException("workspace == null");
        }
        this.workspace = workspace;
        this.auditDb = auditDb == null ? null : auditDb;
        this.shellRunner = new ShellRunner();
        registerBuiltins(ToolRegistry.getInstance());
    }

    // ------------------------------------------------------------ 注册

    /** 幂等注册五个内置工具（同一进程只注册一次）。 */
    public static synchronized void registerBuiltins(ToolRegistry registry) {
        if (registry == null || builtinsRegistered) {
            return;
        }
        registry.register(new ToolDef(
                "read_file",
                "读取工作区内的文本文件（UTF-8，最多 256KB，超出部分截断）。path 为相对工作区的路径。",
                "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\","
                        + "\"description\":\"相对工作区根的文件路径，例如 notes/todo.md\"}},"
                        + "\"required\":[\"path\"]}",
                ToolDef.Risk.LOW, false));
        registry.register(new ToolDef(
                "list_dir",
                "列出工作区内某个目录的内容，返回 JSON 数组 [{name,path,isDir,size}]；不传 path 时列出工作区根。",
                "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\","
                        + "\"description\":\"相对工作区根的目录路径，省略表示根目录\"}}}",
                ToolDef.Risk.LOW, false));
        registry.register(new ToolDef(
                "write_file",
                "把文本覆盖写入工作区内的文件（UTF-8，自动创建父目录，最多 1MB）。仅允许写工作区内。",
                "{\"type\":\"object\",\"properties\":{"
                        + "\"path\":{\"type\":\"string\",\"description\":\"相对工作区根的文件路径\"},"
                        + "\"content\":{\"type\":\"string\",\"description\":\"文件完整内容\"}},"
                        + "\"required\":[\"path\",\"content\"]}",
                ToolDef.Risk.MID, true));
        registry.register(new ToolDef(
                "run_shell",
                "在工作区目录下用 /system/bin/sh -c 执行 shell 命令，合并 stdout/stderr，30 秒超时，输出最多 64KB。",
                "{\"type\":\"object\",\"properties\":{\"command\":{\"type\":\"string\","
                        + "\"description\":\"要执行的 shell 命令\"}},\"required\":[\"command\"]}",
                ToolDef.Risk.HIGH, true));
        registry.register(new ToolDef(
                "http_get",
                "发起 HTTP GET 请求（仅允许 https，localhost 例外），返回状态码与响应文本（最多 200KB）。",
                "{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\","
                        + "\"description\":\"完整 URL，必须以 https:// 开头（localhost 可用 http）\"}},"
                        + "\"required\":[\"url\"]}",
                ToolDef.Risk.LOW, false));
        builtinsRegistered = true;
    }

    // ------------------------------------------------------------ 执行入口

    /**
     * 执行一个工具并写审计；从不抛异常。
     *
     * @param name      工具名
     * @param args      参数对象（null 视为空对象）
     * @param confirmed 本次执行是否已获得用户确认/直接由用户操作发起（写入审计）
     */
    public Outcome execute(String name, JSONObject args, boolean confirmed) {
        String tool = name == null ? "" : name.trim();
        JSONObject safeArgs = args == null ? new JSONObject() : args;
        Outcome outcome;
        try {
            outcome = run(tool, safeArgs);
        } catch (Throwable t) {
            outcome = Outcome.fail("工具执行失败：" + describe(t));
        }
        if (auditDb != null) {
            try {
                auditDb.append(tool, safeArgs.toString(), outcome.result, outcome.ok, confirmed);
            } catch (Throwable ignored) {
                // 审计失败不影响工具返回
            }
        }
        return outcome;
    }

    // ------------------------------------------------------------ 文件树 / 预览（用户直接操作，放宽上限）

    /** 文件树预览：读工作区文本，上限 {@link Workspace#MAX_PREVIEW_BYTES}，写审计（confirmed=true）。 */
    public Outcome readFileForPreview(String path) {
        String safePath = path == null ? "" : path;
        JSONObject args = argsOf("path", safePath);
        Outcome outcome;
        try {
            outcome = Outcome.ok(workspace.readText(safePath, Workspace.MAX_PREVIEW_BYTES));
        } catch (SecurityException e) {
            outcome = Outcome.fail(e.getMessage() == null ? "路径被拒绝" : e.getMessage());
        } catch (IOException e) {
            outcome = Outcome.fail(message(e));
        } catch (Throwable t) {
            outcome = Outcome.fail("读取失败：" + describe(t));
        }
        audit("read_file", args, outcome, true);
        return outcome;
    }

    /** 文件树保存：写工作区文本，上限 {@link Workspace#MAX_DIRECT_WRITE_BYTES}，写审计（confirmed=true）。 */
    public Outcome writeFileDirect(String path, String content) {
        String safePath = path == null ? "" : path;
        String safeContent = content == null ? "" : content;
        JSONObject args = argsOf("path", safePath);
        try {
            args.put("content", safeContent);
        } catch (JSONException ignored) {
            // 忽略
        }
        Outcome outcome;
        try {
            int bytes = workspace.writeText(safePath, safeContent, Workspace.MAX_DIRECT_WRITE_BYTES);
            outcome = Outcome.ok("已写入 " + bytes + " 字节：" + workspace.displayPath(safePath));
        } catch (SecurityException e) {
            outcome = Outcome.fail(e.getMessage() == null ? "路径被拒绝" : e.getMessage());
        } catch (IOException e) {
            outcome = Outcome.fail(message(e));
        } catch (Throwable t) {
            outcome = Outcome.fail("写入失败：" + describe(t));
        }
        audit("write_file", args, outcome, true);
        return outcome;
    }

    private void audit(String tool, JSONObject args, Outcome outcome, boolean confirmed) {
        if (auditDb == null) {
            return;
        }
        try {
            auditDb.append(tool, args == null ? "{}" : args.toString(),
                    outcome.result, outcome.ok, confirmed);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    private static JSONObject argsOf(String key, String value) {
        JSONObject o = new JSONObject();
        try {
            o.put(key, value == null ? "" : value);
        } catch (JSONException ignored) {
            // 忽略
        }
        return o;
    }

    private Outcome run(String tool, JSONObject args) {
        if ("read_file".equals(tool)) {
            return readFile(args);
        }
        if ("list_dir".equals(tool)) {
            return listDir(args);
        }
        if ("write_file".equals(tool)) {
            return writeFile(args);
        }
        if ("run_shell".equals(tool)) {
            return runShell(args);
        }
        if ("http_get".equals(tool)) {
            return httpGet(args);
        }
        return Outcome.fail("未知工具：" + tool);
    }

    // ------------------------------------------------------------ read_file / list_dir

    private Outcome readFile(JSONObject args) {
        String path = stringArg(args, "path");
        if (path.isEmpty()) {
            return Outcome.fail("缺少参数 path");
        }
        try {
            String text = workspace.readText(path, MAX_READ_FILE_BYTES);
            return Outcome.ok(text);
        } catch (SecurityException e) {
            return Outcome.fail(e.getMessage() == null ? "路径被拒绝" : e.getMessage());
        } catch (IOException e) {
            return Outcome.fail(message(e));
        }
    }

    private Outcome listDir(JSONObject args) {
        String path = stringArg(args, "path");
        try {
            return Outcome.ok(workspace.listDirJson(path));
        } catch (SecurityException e) {
            return Outcome.fail(e.getMessage() == null ? "路径被拒绝" : e.getMessage());
        } catch (IOException e) {
            return Outcome.fail(message(e));
        }
    }

    // ------------------------------------------------------------ write_file

    private Outcome writeFile(JSONObject args) {
        String path = stringArg(args, "path");
        if (path.isEmpty()) {
            return Outcome.fail("缺少参数 path");
        }
        String content = stringArg(args, "content");
        try {
            int bytes = workspace.writeText(path, content, MAX_WRITE_FILE_BYTES);
            return Outcome.ok("已写入 " + bytes + " 字节：" + workspace.displayPath(path));
        } catch (SecurityException e) {
            return Outcome.fail(e.getMessage() == null ? "路径被拒绝" : e.getMessage());
        } catch (IOException e) {
            return Outcome.fail(message(e));
        }
    }

    // ------------------------------------------------------------ run_shell

    private Outcome runShell(JSONObject args) {
        String command = stringArg(args, "command");
        if (command.trim().isEmpty()) {
            return Outcome.fail("缺少参数 command");
        }
        ShellRunner.Result result = shellRunner.run(command, workspace.root());
        StringBuilder output = new StringBuilder();
        if (result.output != null && !result.output.isEmpty()) {
            output.append(result.output);
            if (!result.output.endsWith("\n")) {
                output.append('\n');
            }
        }
        if (result.outputTruncated) {
            output.append("…（输出已截断，仅保留前 64KB）\n");
        }
        if (result.timedOut) {
            output.append("[超时] 命令超过 30 秒，已终止");
            return Outcome.fail(output.toString());
        }
        output.append("[exit ").append(result.exitCode).append(']');
        return result.exitCode == 0
                ? Outcome.ok(output.toString())
                : Outcome.fail(output.toString());
    }

    // ------------------------------------------------------------ http_get

    private Outcome httpGet(JSONObject args) {
        String rawUrl = stringArg(args, "url").trim();
        if (rawUrl.isEmpty()) {
            return Outcome.fail("缺少参数 url");
        }
        URL url;
        try {
            url = new URL(rawUrl);
        } catch (Throwable t) {
            return Outcome.fail("URL 不合法：" + rawUrl);
        }
        String protocol = url.getProtocol() == null
                ? "" : url.getProtocol().toLowerCase(Locale.US);
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.US);
        boolean local = isLocalHost(host);
        if (!"https".equals(protocol) && !("http".equals(protocol) && local)) {
            return Outcome.fail("仅允许 https 请求（localhost 可用 http）：" + rawUrl);
        }
        if (host.isEmpty()) {
            return Outcome.fail("URL 缺少主机名：" + rawUrl);
        }
        HttpURLConnection conn = null;
        InputStream in = null;
        try {
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(HTTP_CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(HTTP_READ_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", USER_AGENT);
            conn.setRequestProperty("Accept", "text/plain, text/html, application/json, */*");
            int status = conn.getResponseCode();
            in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String body;
            boolean truncated = false;
            if (in == null) {
                body = "";
            } else {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int total = 0;
                int n;
                while ((n = in.read(buffer)) >= 0) {
                    total += n;
                    if (out.size() < MAX_HTTP_READ_BYTES) {
                        out.write(buffer, 0, Math.min(n, MAX_HTTP_READ_BYTES - out.size()));
                    }
                    if (total >= MAX_HTTP_READ_BYTES) {
                        truncated = true;
                        break;
                    }
                }
                body = new String(out.toByteArray(), StandardCharsets.UTF_8);
            }
            if (body.length() > MAX_HTTP_RETURN_CHARS) {
                body = body.substring(0, MAX_HTTP_RETURN_CHARS);
                truncated = true;
            }
            StringBuilder sb = new StringBuilder();
            sb.append("HTTP ").append(status).append('\n');
            sb.append(body);
            if (truncated) {
                sb.append("\n…（响应体已截断）");
            }
            return status >= 200 && status < 400
                    ? Outcome.ok(sb.toString())
                    : Outcome.fail(sb.toString());
        } catch (IOException e) {
            return Outcome.fail("网络请求失败：" + message(e));
        } catch (Throwable t) {
            return Outcome.fail("网络请求失败：" + describe(t));
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // 忽略
                }
            }
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        }
    }

    private static boolean isLocalHost(String host) {
        if (host == null) {
            return false;
        }
        String h = host.trim().toLowerCase(Locale.US);
        if (h.startsWith("[") && h.endsWith("]")) {
            h = h.substring(1, h.length() - 1);
        }
        return "localhost".equals(h)
                || "127.0.0.1".equals(h)
                || "::1".equals(h)
                || "0:0:0:0:0:0:0:1".equals(h);
    }

    // ------------------------------------------------------------ 参数工具

    private static String stringArg(JSONObject args, String key) {
        if (args == null || !args.has(key) || args.isNull(key)) {
            return "";
        }
        String value = args.optString(key, "");
        return value == null || "null".equals(value) ? "" : value;
    }

    private static String message(Throwable t) {
        String message = t == null ? null : t.getMessage();
        return message == null || message.trim().isEmpty()
                ? "操作失败" : message;
    }

    private static String describe(Throwable t) {
        if (t == null) {
            return "未知错误";
        }
        String message = t.getMessage();
        return message == null || message.trim().isEmpty()
                ? t.getClass().getSimpleName() : message;
    }

}
