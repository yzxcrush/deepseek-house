package com.deepseekhouse.app.mcp;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * MCP 传输层：JSON-RPC 2.0 over streamable-http（SPEC「ARCH v2 P2」N2）。
 *
 * <p>每个 MCP 服务器一个实例。请求 = 一次 {@code POST {url}}：</p>
 * <pre>
 * Content-Type: application/json
 * Accept: application/json, text/event-stream
 * Authorization: Bearer &lt;token&gt;   （可选）
 * </pre>
 *
 * <p>响应可能是 {@code application/json} 单对象（或 batch 数组），也可能是
 * {@code text/event-stream}（逐行 {@code data: {json}}）；SSE 中会先到达
 * {@code notifications/progress} 等通知，最终才是与请求 id 匹配的响应。
 * 本类维护单调递增的 requestId 与 pending 表，超时由 HTTP readTimeout + 截止时间双重保证。</p>
 *
 * <p>只应在后台线程调用（方法会阻塞网络 IO）。</p>
 */
public final class JsonRpcClient {

    public static final String PROTOCOL_VERSION = "2024-11-05";
    /** 普通 JSON-RPC 请求超时（initialize / tools/list / ping）。 */
    public static final long RPC_TIMEOUT_MS = 30 * 1000L;
    /** tools/call 超时（Termux 构建类工具可能跑数分钟；SPEC M2 允许 300s）。 */
    public static final long TOOL_CALL_TIMEOUT_MS = 300 * 1000L;
    /** 心跳 ping 超时。 */
    public static final long HEARTBEAT_TIMEOUT_MS = 10 * 1000L;

    private static final int CONNECT_TIMEOUT_MS = 10 * 1000;
    private static final int MAX_BODY_BYTES = 8 * 1024 * 1024;
    private static final int MAX_ERROR_BODY = 16 * 1024;
    private static final int MAX_SSE_CHARS = 8 * 1024 * 1024;
    private static final int MAX_TOOL_PAGES = 10;

    /** 进度回调：把 MCP notifications/progress、日志类通知转成 mcp-progress 事件。 */
    public interface ProgressSink {
        void onProgress(String serverId, String toolName, int percent, String line);
    }

    /** JSON-RPC 业务错误（服务器返回 error 字段）；与网络/超时错误区分，后者是普通 IOException。 */
    public static final class RpcError extends IOException {
        public final int code;

        RpcError(int code, String message) {
            super(message == null || message.trim().isEmpty() ? "JSON-RPC 错误" : message);
            this.code = code;
        }
    }

    /** 进行中的请求（pending 表），用于进度通知归属与最近工具调用匹配。 */
    private static final class Pending {
        final String openAiTool;
        volatile int lastPercent;

        Pending(String openAiTool) {
            this.openAiTool = openAiTool;
        }
    }

    private final String serverId;
    private final String url;
    private final String token;
    private final String clientVersion;
    private final ProgressSink progressSink;
    private final AtomicInteger sequence = new AtomicInteger(1);
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();
    private final List<HttpURLConnection> connections =
            Collections.synchronizedList(new ArrayList<HttpURLConnection>());
    private volatile boolean closed;

    public JsonRpcClient(String serverId, String url, String token,
                         String clientVersion, ProgressSink progressSink) {
        this.serverId = serverId == null ? "" : serverId;
        this.url = url == null ? "" : url.trim();
        this.token = token == null ? "" : token.trim();
        this.clientVersion = clientVersion == null || clientVersion.trim().isEmpty()
                ? "2.1.0" : clientVersion.trim();
        this.progressSink = progressSink;
    }

    // ------------------------------------------------------------ MCP 生命周期方法

    /** {@code initialize}：protocolVersion 2024-11-05、capabilities {}、clientInfo。 */
    public JSONObject initialize() throws IOException {
        JSONObject params = new JSONObject();
        try {
            params.put("protocolVersion", PROTOCOL_VERSION);
            params.put("capabilities", new JSONObject());
            JSONObject clientInfo = new JSONObject();
            clientInfo.put("name", "DeepSeekHouse");
            clientInfo.put("version", clientVersion);
            params.put("clientInfo", clientInfo);
        } catch (JSONException e) {
            throw new IOException("构造 initialize 参数失败");
        }
        return request("initialize", params, RPC_TIMEOUT_MS, null);
    }

    /** {@code notifications/initialized}：通知，无响应。 */
    public void notificationsInitialized() throws IOException {
        notification("notifications/initialized", null);
    }

    /** {@code tools/list}（支持 nextCursor 分页，最多 10 页）。 */
    public JSONArray listTools() throws IOException {
        JSONArray all = new JSONArray();
        String cursor = "";
        for (int page = 0; page < MAX_TOOL_PAGES; page++) {
            JSONObject params = new JSONObject();
            try {
                if (!cursor.isEmpty()) {
                    params.put("cursor", cursor);
                }
            } catch (JSONException ignored) {
                // 忽略
            }
            JSONObject result = request("tools/list", params, RPC_TIMEOUT_MS, null);
            JSONArray tools = result.optJSONArray("tools");
            if (tools != null) {
                for (int i = 0; i < tools.length(); i++) {
                    all.put(tools.opt(i));
                }
            }
            cursor = result.optString("nextCursor", "");
            if (cursor == null) {
                cursor = "";
            }
            cursor = cursor.trim();
            if (cursor.isEmpty()) {
                break;
            }
        }
        return all;
    }

    /** {@code ping}：心跳。 */
    public JSONObject ping(long timeoutMs) throws IOException {
        return request("ping", new JSONObject(), Math.max(1000L, timeoutMs), null);
    }

    /**
     * {@code tools/call}：转发工具调用。
     *
     * @param openAiTool OpenAI function 名，用于把进度事件映射到聊天里的工具卡
     */
    public JSONObject callTool(String toolName, JSONObject arguments,
                               String openAiTool, long timeoutMs) throws IOException {
        JSONObject params = new JSONObject();
        try {
            params.put("name", toolName == null ? "" : toolName);
            params.put("arguments", arguments == null ? new JSONObject() : arguments);
        } catch (JSONException e) {
            throw new IOException("构造 tools/call 参数失败");
        }
        return request("tools/call", params, Math.max(1000L, timeoutMs), openAiTool);
    }

    /** 关闭客户端：断开所有在途连接并清空 pending。 */
    public void shutdown() {
        closed = true;
        List<HttpURLConnection> snapshot;
        synchronized (connections) {
            snapshot = new ArrayList<>(connections);
            connections.clear();
        }
        for (HttpURLConnection conn : snapshot) {
            try {
                conn.disconnect();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
        pending.clear();
    }

    public boolean isClosed() {
        return closed;
    }

    public String serverId() {
        return serverId;
    }

    // ------------------------------------------------------------ JSON-RPC 请求

    private JSONObject request(String method, JSONObject params, long timeoutMs,
                               String openAiTool) throws IOException {
        if (closed) {
            throw new IOException("MCP 连接已关闭");
        }
        int numericId = sequence.getAndIncrement();
        String id = String.valueOf(numericId);
        JSONObject payload = new JSONObject();
        try {
            payload.put("jsonrpc", "2.0");
            payload.put("id", numericId);
            payload.put("method", method);
            if (params != null) {
                payload.put("params", params);
                if (openAiTool != null) {
                    // MCP 约定：progressToken 放在 params._meta 里，进度通知会原样带回
                    JSONObject meta = params.optJSONObject("_meta");
                    if (meta == null) {
                        meta = new JSONObject();
                    }
                    meta.put("progressToken", id);
                    params.put("_meta", meta);
                }
            }
        } catch (JSONException e) {
            throw new IOException("构造 JSON-RPC 请求失败");
        }
        Pending state = new Pending(openAiTool);
        pending.put(id, state);
        long deadline = System.currentTimeMillis() + Math.max(1000L, timeoutMs);
        try {
            JSONObject response = post(payload, timeoutMs, deadline, id);
            JSONObject error = response.optJSONObject("error");
            if (error != null) {
                throw new RpcError(error.optInt("code", -1),
                        error.optString("message", "JSON-RPC 错误"));
            }
            JSONObject result = response.optJSONObject("result");
            return result == null ? new JSONObject() : result;
        } finally {
            pending.remove(id);
        }
    }

    private void notification(String method, JSONObject params) throws IOException {
        if (closed) {
            throw new IOException("MCP 连接已关闭");
        }
        JSONObject payload = new JSONObject();
        try {
            payload.put("jsonrpc", "2.0");
            payload.put("method", method);
            if (params != null) {
                payload.put("params", params);
            }
        } catch (JSONException e) {
            throw new IOException("构造 JSON-RPC 通知失败");
        }
        postNotification(payload);
    }

    // ------------------------------------------------------------ HTTP 传输

    private JSONObject post(JSONObject payload, long timeoutMs, long deadline,
                            String expectId) throws IOException {
        HttpURLConnection conn = null;
        try {
            conn = open(payload, timeoutMs);
            int status = conn.getResponseCode();
            String contentType = lower(conn.getContentType());
            if (status < 200 || status >= 300) {
                String body = readBody(conn.getErrorStream(), MAX_ERROR_BODY);
                String hint = (status == 401 || status == 403)
                        ? "（鉴权失败，请检查 Token）" : "";
                throw new IOException("HTTP " + status + hint
                        + (body.isEmpty() ? "" : "：" + truncate(singleLine(body), 300)));
            }
            InputStream raw = conn.getInputStream();
            if (raw == null) {
                throw new IOException("服务器返回空响应（HTTP " + status + "）");
            }
            if (contentType.contains("text/event-stream")) {
                return readSse(raw, expectId, deadline, timeoutMs);
            }
            String body = readBody(raw, MAX_BODY_BYTES);
            if (body.trim().isEmpty()) {
                throw new IOException("服务器返回空响应（HTTP " + status + "）");
            }
            try {
                return parseBody(body, expectId);
            } catch (JSONException parseError) {
                // 个别服务器 Content-Type 标注不准：body 实际是 SSE 文本
                try {
                    return readSse(new ByteArrayInputStream(
                            body.getBytes(StandardCharsets.UTF_8)), expectId, deadline, timeoutMs);
                } catch (IOException sseError) {
                    throw new IOException("响应不是合法 JSON："
                            + truncate(singleLine(body), 200));
                }
            }
        } catch (SocketTimeoutException e) {
            throw new IOException("请求超时（" + Math.max(1L, timeoutMs / 1000L) + " 秒）");
        } finally {
            closeConnection(conn);
        }
    }

    private void postNotification(JSONObject payload) throws IOException {
        HttpURLConnection conn = null;
        try {
            conn = open(payload, RPC_TIMEOUT_MS);
            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                String body = readBody(conn.getErrorStream(), MAX_ERROR_BODY);
                throw new IOException("通知发送失败：HTTP " + status
                        + (body.isEmpty() ? "" : "：" + truncate(singleLine(body), 200)));
            }
            try {
                InputStream in = conn.getInputStream();
                if (in != null) {
                    readBody(in, 4096);
                }
            } catch (Throwable ignored) {
                // 202/204 通常没有 body
            }
        } catch (SocketTimeoutException e) {
            throw new IOException("通知发送超时");
        } finally {
            closeConnection(conn);
        }
    }

    private HttpURLConnection open(JSONObject payload, long timeoutMs) throws IOException {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            long readTimeout = timeoutMs <= 0 ? RPC_TIMEOUT_MS : timeoutMs;
            readTimeout = Math.min(readTimeout + 5000L, 305 * 1000L);
            conn.setReadTimeout((int) readTimeout);
            conn.setDoOutput(true);
            conn.setUseCaches(false);
            // 不自动跟随重定向：避免 token 被转发到第三方主机
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "application/json, text/event-stream");
            conn.setRequestProperty("User-Agent", "DeepSeekHouse/" + clientVersion + " (Android)");
            if (!token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
            byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(bytes.length);
            OutputStream out = conn.getOutputStream();
            try {
                out.write(bytes);
                out.flush();
            } finally {
                out.close();
            }
            connections.add(conn);
            return conn;
        } catch (IOException e) {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
            throw e;
        }
    }

    private void closeConnection(HttpURLConnection conn) {
        if (conn == null) {
            return;
        }
        connections.remove(conn);
        try {
            conn.disconnect();
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    // ------------------------------------------------------------ 响应解析

    private JSONObject parseBody(String body, String expectId) throws IOException, JSONException {
        String trimmed = body == null ? "" : body.trim();
        if (trimmed.startsWith("[")) {
            JSONArray array = new JSONArray(trimmed);
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item == null) {
                    continue;
                }
                if (item.has("id") && expectId.equals(idString(item))) {
                    return item;
                }
                if (item.has("method")) {
                    handleNotification(item);
                }
            }
            throw new IOException("响应中缺少 id=" + expectId + " 的结果");
        }
        JSONObject obj = new JSONObject(trimmed);
        if (obj.has("id") && expectId.equals(idString(obj))) {
            return obj;
        }
        if (obj.has("method")) {
            handleNotification(obj);
            throw new IOException("只收到通知，未收到 JSON-RPC 响应");
        }
        throw new IOException("响应 id 与请求不匹配（期望 " + expectId + "）");
    }

    /** 读 SSE 流，直到匹配期望 id 的响应；期间处理 progress/log 通知。 */
    private JSONObject readSse(InputStream in, String expectId, long deadline,
                               long timeoutMs) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        StringBuilder data = new StringBuilder();
        int consumed = 0;
        try {
            String line;
            while ((line = reader.readLine()) != null) {
                if (System.currentTimeMillis() > deadline) {
                    throw new IOException("请求超时（" + Math.max(1L, timeoutMs / 1000L) + " 秒）");
                }
                consumed += line.length() + 1;
                if (consumed > MAX_SSE_CHARS) {
                    throw new IOException("SSE 响应过大");
                }
                if (line.isEmpty()) {
                    JSONObject response = dispatchSseData(data, expectId);
                    data.setLength(0);
                    if (response != null) {
                        return response;
                    }
                    continue;
                }
                if (line.charAt(0) == ':') {
                    continue; // SSE 注释/心跳
                }
                int colon = line.indexOf(':');
                String field = colon >= 0 ? line.substring(0, colon) : line;
                String value = colon >= 0 ? line.substring(colon + 1) : "";
                if (!value.isEmpty() && value.charAt(0) == ' ') {
                    value = value.substring(1);
                }
                if ("data".equals(field)) {
                    if (data.length() > 0) {
                        data.append('\n');
                    }
                    data.append(value);
                }
                // event:/id:/retry: 忽略
            }
        } catch (SocketTimeoutException e) {
            throw new IOException("请求超时（" + Math.max(1L, timeoutMs / 1000L) + " 秒）");
        }
        JSONObject response = dispatchSseData(data, expectId);
        if (response != null) {
            return response;
        }
        throw new IOException("SSE 流结束但未收到 id=" + expectId + " 的响应");
    }

    private JSONObject dispatchSseData(StringBuilder data, String expectId) {
        if (data == null || data.length() == 0) {
            return null;
        }
        String payload = data.toString().trim();
        if (payload.isEmpty() || "[DONE]".equalsIgnoreCase(payload)) {
            return null;
        }
        try {
            JSONObject obj = new JSONObject(payload);
            if (obj.has("id") && expectId.equals(idString(obj))) {
                return obj;
            }
            if (obj.has("method")) {
                handleNotification(obj);
            }
        } catch (JSONException ignored) {
            // 非 JSON 的 data 行（心跳文本等）忽略
        }
        return null;
    }

    private static String idString(JSONObject obj) {
        Object id = obj.opt("id");
        if (id == null || id == JSONObject.NULL) {
            return "";
        }
        return String.valueOf(id);
    }

    // ------------------------------------------------------------ 进度 / 日志通知

    private void handleNotification(JSONObject obj) {
        String method = obj.optString("method", "");
        if (method == null || method.isEmpty()) {
            return;
        }
        String lower = method.toLowerCase(Locale.US);
        boolean isProgress = lower.contains("progress");
        boolean isLog = lower.contains("message") || lower.contains("log")
                || lower.contains("output") || lower.contains("line");
        if (!isProgress && !isLog) {
            return;
        }
        JSONObject params = obj.optJSONObject("params");
        if (params == null) {
            return;
        }
        Pending target = null;
        Object token = params.opt("progressToken");
        if (token != null && token != JSONObject.NULL) {
            target = pending.get(String.valueOf(token));
        }
        if (target == null) {
            target = latestToolPending();
        }
        if (target == null || target.openAiTool == null) {
            return;
        }
        int percent = computePercent(params, target.lastPercent);
        if (percent < 0) {
            percent = target.lastPercent;
        }
        percent = Math.max(0, Math.min(100, percent));
        target.lastPercent = percent;
        String line = lineFromParams(params);
        if (progressSink != null && (percent > 0 || !line.isEmpty())) {
            progressSink.onProgress(serverId, target.openAiTool, percent, line);
        }
    }

    private Pending latestToolPending() {
        Pending best = null;
        long bestId = -1L;
        for (Map.Entry<String, Pending> entry : pending.entrySet()) {
            Pending value = entry.getValue();
            if (value == null || value.openAiTool == null) {
                continue;
            }
            long id = 0L;
            try {
                id = Long.parseLong(entry.getKey());
            } catch (Throwable ignored) {
                id = 0L;
            }
            if (id >= bestId) {
                bestId = id;
                best = value;
            }
        }
        return best;
    }

    private static int computePercent(JSONObject params, int fallback) {
        try {
            double total = params.optDouble("total", -1);
            double progress = params.optDouble("progress", -1);
            if (!Double.isNaN(total) && !Double.isNaN(progress) && total > 0 && progress >= 0) {
                long percent = Math.round(progress * 100.0d / total);
                return (int) Math.max(0L, Math.min(100L, percent));
            }
            int percent = params.optInt("percent", -1);
            if (percent >= 0) {
                return Math.max(0, Math.min(100, percent));
            }
        } catch (Throwable ignored) {
            // 忽略
        }
        return fallback;
    }

    private static String lineFromParams(JSONObject params) {
        String[] keys = new String[]{"message", "line", "text", "data", "log"};
        for (String key : keys) {
            if (!params.has(key) || params.isNull(key)) {
                continue;
            }
            Object value = params.opt(key);
            if (value instanceof String) {
                return (String) value;
            }
            if (value instanceof JSONObject || value instanceof JSONArray) {
                return value.toString();
            }
            if (value != null) {
                return String.valueOf(value);
            }
        }
        if (params.has("params")) {
            JSONObject nested = params.optJSONObject("params");
            if (nested != null) {
                return lineFromParams(nested);
            }
        }
        return "";
    }

    // ------------------------------------------------------------ 工具方法

    private static String readBody(InputStream in, int maxBytes) {
        if (in == null) {
            return "";
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        try {
            int n;
            while ((n = in.read(buffer)) >= 0) {
                if (total < maxBytes) {
                    int take = Math.min(n, maxBytes - total);
                    out.write(buffer, 0, take);
                    total += take;
                }
            }
        } catch (IOException ignored) {
            // 读取中断时返回已读部分
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
                // 忽略
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String lower(String value) {
        return value == null ? "" : value.toLowerCase(Locale.US);
    }

    private static String singleLine(String text) {
        if (text == null) {
            return "";
        }
        return text.replace('\r', ' ').replace('\n', ' ').trim();
    }

    private static String truncate(String text, int max) {
        if (text == null) {
            return "";
        }
        if (text.length() <= max) {
            return text;
        }
        return text.substring(0, max) + "…";
    }
}
