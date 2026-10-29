package com.deepseekhouse.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.GZIPInputStream;

/**
 * 网络层：DeepSeek Chat Completions（SSE 流式）、/models 校验、通用 httpFetch。
 *
 * <p>所有网络操作在后台线程执行，结果通过 {@link EventSink} 以 JSON 事件抛给 JS。
 * 按 requestId 维护连接，支持取消（disconnect）。API Key 只在 Authorization 头中出现，
 * 绝不写日志。</p>
 */
public final class ApiClient {

    /** 事件接收器：由 JsBridge 实现，负责切回主线程 evaluateJavascript。 */
    public interface EventSink {
        void emit(String json);
    }

    private static final int CONNECT_TIMEOUT_MS = 20 * 1000;
    private static final int READ_TIMEOUT_MS = 300 * 1000;
    private static final int MAX_ERROR_BODY = 16 * 1024;
    private static final int MAX_CHAT_BODY = 16 * 1024 * 1024;
    private static final int MAX_FETCH_BODY = 8 * 1024 * 1024;
    private static final String USER_AGENT = "DeepSeekHouse/1.0.0 (Android)";

    private final Prefs prefs;
    private final EventSink sink;
    private final ExecutorService pool;
    private final Map<String, Request> active = new ConcurrentHashMap<>();

    /** 一次请求的运行态。cancelled 由任意线程置位，conn 用于 disconnect。 */
    private static final class Request {
        volatile HttpURLConnection conn;
        volatile boolean cancelled;
    }

    public ApiClient(Prefs prefs, EventSink sink) {
        this.prefs = prefs;
        this.sink = sink;
        this.pool = Executors.newCachedThreadPool(new ThreadFactory() {
            private final AtomicInteger seq = new AtomicInteger(1);

            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "dsh-net-" + seq.getAndIncrement());
                t.setDaemon(true);
                return t;
            }
        });
    }

    // ------------------------------------------------------------ 取消 / 生命周期

    public void cancel(String requestId) {
        if (requestId == null) {
            return;
        }
        Request req = active.get(requestId);
        if (req == null) {
            return;
        }
        req.cancelled = true;
        disconnect(req);
        active.remove(requestId, req);
    }

    public void cancelAll() {
        for (Map.Entry<String, Request> entry : active.entrySet()) {
            Request req = entry.getValue();
            req.cancelled = true;
            disconnect(req);
        }
        active.clear();
    }

    public void shutdown() {
        cancelAll();
        pool.shutdownNow();
    }

    private static void disconnect(Request req) {
        HttpURLConnection conn = req == null ? null : req.conn;
        if (conn != null) {
            try {
                conn.disconnect();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
    }

    private Request register(String requestId) {
        Request req = new Request();
        Request previous = active.put(requestId, req);
        if (previous != null) {
            previous.cancelled = true;
            disconnect(previous);
        }
        return req;
    }

    private void finish(String requestId, Request req) {
        active.remove(requestId, req);
    }

    private void submit(String requestId, Request req, Runnable task) {
        try {
            pool.execute(task);
        } catch (RejectedExecutionException e) {
            finish(requestId, req);
            emitError(requestId, "应用正在关闭，请求已取消", 0);
        }
    }

    // ------------------------------------------------------------ chat/completions

    /** §3.2 startChat：POST {baseUrl}/chat/completions，stream=true 时逐行解析 SSE。 */
    public void startChat(final String requestId, final String bodyJson) {
        final Request req = register(requestId);
        submit(requestId, req, new Runnable() {
            @Override
            public void run() {
                try {
                    runChat(req, requestId, bodyJson);
                } finally {
                    req.conn = null;
                    finish(requestId, req);
                }
            }
        });
    }

    private void runChat(Request req, String requestId, String bodyJson) {
        if (req.cancelled) {
            return;
        }
        String apiKey = prefs.getApiKey();
        if (apiKey == null || apiKey.trim().isEmpty()) {
            emitError(requestId, "未配置 API Key，请先在设置中填写", 401);
            return;
        }
        String url = joinUrl(prefs.getBaseUrl(), "/chat/completions");
        if (url.isEmpty()) {
            emitError(requestId, "未配置 Base URL", 400);
            return;
        }
        JSONObject input;
        try {
            input = new JSONObject(bodyJson == null || bodyJson.trim().isEmpty() ? "{}" : bodyJson);
        } catch (JSONException e) {
            emitError(requestId, "请求体不是合法 JSON", 400);
            return;
        }
        JSONObject payload;
        try {
            payload = buildChatBody(input);
        } catch (JSONException e) {
            emitError(requestId, "组装请求失败", 400);
            return;
        }
        boolean stream = payload.optBoolean("stream", true);
        HttpURLConnection conn = null;
        try {
            conn = open(url, "POST", stream ? "text/event-stream" : "application/json", true);
            req.conn = conn;
            if (req.cancelled) {
                return;
            }
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(bytes.length);
            OutputStream out = conn.getOutputStream();
            out.write(bytes);
            out.flush();
            out.close();

            int status = conn.getResponseCode();
            if (req.cancelled) {
                return;
            }
            InputStream in = wrapStream(conn, status);
            if (status < 200 || status >= 300) {
                String body = readLimited(in, MAX_ERROR_BODY);
                emitError(requestId, friendlyHttp(status, body), status);
                return;
            }
            if (stream) {
                readSse(req, requestId, in);
            } else {
                readWholeBody(req, requestId, in);
            }
        } catch (Throwable t) {
            if (!req.cancelled) {
                emitError(requestId, netMessage(t), 0);
            }
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        }
    }

    /**
     * 把 JS 传入的 body 转成 OpenAI 兼容请求体：注入 systemPrompt、camelCase 转 snake_case、
     * 只透传已知的生成参数（不会把私有字段发给服务端）。
     */
    private JSONObject buildChatBody(JSONObject in) throws JSONException {
        String systemPrompt = optText(in, "systemPrompt", prefs.getSystemPrompt());
        JSONArray messages = in.optJSONArray("messages");
        if (messages == null) {
            messages = new JSONArray();
        }
        boolean hasSystem = false;
        if (messages.length() > 0) {
            JSONObject first = messages.optJSONObject(0);
            if (first != null && "system".equals(optText(first, "role", ""))) {
                hasSystem = true;
            }
        }
        JSONArray outMessages = new JSONArray();
        if (!hasSystem && systemPrompt != null && !systemPrompt.trim().isEmpty()) {
            JSONObject sys = new JSONObject();
            sys.put("role", "system");
            sys.put("content", systemPrompt);
            outMessages.put(sys);
        }
        for (int i = 0; i < messages.length(); i++) {
            outMessages.put(messages.get(i));
        }

        JSONObject out = new JSONObject();
        String model = optText(in, "model", "").trim();
        out.put("model", model.isEmpty() ? prefs.getModel() : model);
        out.put("messages", outMessages);

        copyField(in, out, "temperature");
        copyField(in, out, "top_p");
        copyField(in, out, "frequency_penalty");
        copyField(in, out, "presence_penalty");
        copyField(in, out, "stop");
        copyField(in, out, "tools");
        copyField(in, out, "tool_choice");
        copyField(in, out, "response_format");
        copyField(in, out, "stream_options");
        copyField(in, out, "seed");
        if (!out.has("temperature")) {
            out.put("temperature", prefs.getTemperature());
        }
        if (in.has("maxTokens") && !in.isNull("maxTokens")) {
            out.put("max_tokens", in.optInt("maxTokens", prefs.getMaxTokens()));
        } else if (in.has("max_tokens") && !in.isNull("max_tokens")) {
            copyField(in, out, "max_tokens");
        }
        if (!out.has("max_tokens")) {
            out.put("max_tokens", prefs.getMaxTokens());
        }
        boolean stream = !in.has("stream") || in.isNull("stream")
                ? prefs.isStream()
                : in.optBoolean("stream", prefs.isStream());
        out.put("stream", stream);
        return out;
    }

    /** 逐行读取 SSE，读到即发事件，不缓冲整包。 */
    private void readSse(Request req, String requestId, InputStream raw) throws IOException {
        if (raw == null) {
            emitError(requestId, "服务端未返回内容", 0);
            return;
        }
        BufferedReader reader = new BufferedReader(new InputStreamReader(raw, StandardCharsets.UTF_8));
        String finishReason = "";
        JSONObject usage = null;
        try {
            String line;
            while ((line = reader.readLine()) != null) {
                if (req.cancelled) {
                    return;
                }
                line = line.trim();
                if (line.isEmpty() || line.startsWith(":")) {
                    continue; // 空行 / SSE 心跳注释
                }
                if (!line.startsWith("data:")) {
                    continue; // event: / id: / retry: 等字段忽略
                }
                String data = line.substring(5).trim();
                if (data.isEmpty()) {
                    continue;
                }
                if ("[DONE]".equals(data)) {
                    break;
                }
                JSONObject chunk;
                try {
                    chunk = new JSONObject(data);
                } catch (JSONException e) {
                    continue; // 跳过非 JSON 的 data 行
                }
                if (chunk.has("error") && !chunk.isNull("error")) {
                    emitError(requestId, payloadErrorMessage(chunk), 0);
                    return;
                }
                JSONObject chunkUsage = chunk.optJSONObject("usage");
                if (chunkUsage != null) {
                    usage = chunkUsage;
                }
                JSONArray choices = chunk.optJSONArray("choices");
                if (choices == null || choices.length() == 0) {
                    continue;
                }
                JSONObject choice = choices.optJSONObject(0);
                if (choice == null) {
                    continue;
                }
                String fr = optText(choice, "finish_reason", "");
                if (!fr.isEmpty()) {
                    finishReason = fr;
                }
                JSONObject delta = choice.optJSONObject("delta");
                if (delta == null) {
                    delta = choice.optJSONObject("message"); // 兼容非流式结构
                }
                if (delta == null) {
                    continue;
                }
                String content = optText(delta, "content", "");
                String reasoning = optText(delta, "reasoning_content", "");
                if (reasoning.isEmpty()) {
                    // 兼容部分兼容层使用 "reasoning" 字段的情况
                    reasoning = optText(delta, "reasoning", "");
                }
                JSONArray toolCalls = delta.optJSONArray("tool_calls");
                if (content.isEmpty() && reasoning.isEmpty()
                        && (toolCalls == null || toolCalls.length() == 0)) {
                    continue;
                }
                emitChunk(requestId, content, reasoning, toolCalls);
            }
        } finally {
            try {
                reader.close();
            } catch (IOException ignored) {
                // 忽略
            }
        }
        if (req.cancelled) {
            return;
        }
        emitDone(requestId, finishReason.isEmpty() ? "stop" : finishReason, usage);
    }

    /** stream=false 时的一次性响应。 */
    private void readWholeBody(Request req, String requestId, InputStream raw) throws IOException {
        String body = readLimited(raw, MAX_CHAT_BODY);
        if (req.cancelled) {
            return;
        }
        JSONObject resp;
        try {
            resp = new JSONObject(body);
        } catch (JSONException e) {
            emitError(requestId, "服务端返回无法解析", 0);
            return;
        }
        if (resp.has("error") && !resp.isNull("error")) {
            emitError(requestId, payloadErrorMessage(resp), 0);
            return;
        }
        JSONObject usage = resp.optJSONObject("usage");
        JSONArray choices = resp.optJSONArray("choices");
        JSONObject choice = choices != null && choices.length() > 0 ? choices.optJSONObject(0) : null;
        JSONObject message = choice == null ? null : choice.optJSONObject("message");
        String finishReason = choice == null ? "stop" : optText(choice, "finish_reason", "stop");
        String content = message == null ? "" : optText(message, "content", "");
        String reasoning = message == null ? "" : optText(message, "reasoning_content", "");
        if (reasoning.isEmpty() && message != null) {
            reasoning = optText(message, "reasoning", "");
        }
        JSONArray toolCalls = message == null ? null : message.optJSONArray("tool_calls");
        if (!content.isEmpty() || !reasoning.isEmpty()
                || (toolCalls != null && toolCalls.length() > 0)) {
            emitChunk(requestId, content, reasoning, toolCalls);
        }
        emitDone(requestId, finishReason.isEmpty() ? "stop" : finishReason, usage);
    }

    // ------------------------------------------------------------ /models 校验

    /** §3.2 validateKey：GET {baseUrl}/models。 */
    public void validateKey(final String requestId) {
        final Request req = register(requestId);
        submit(requestId, req, new Runnable() {
            @Override
            public void run() {
                try {
                    runValidate(req, requestId);
                } finally {
                    req.conn = null;
                    finish(requestId, req);
                }
            }
        });
    }

    private void runValidate(Request req, String requestId) {
        if (req.cancelled) {
            return;
        }
        String apiKey = prefs.getApiKey();
        if (apiKey == null || apiKey.trim().isEmpty()) {
            String msg = "未配置 API Key";
            emitValidated(requestId, false, null, msg, 401);
            emitError(requestId, msg, 401);
            return;
        }
        String url = joinUrl(prefs.getBaseUrl(), "/models");
        if (url.isEmpty()) {
            String msg = "未配置 Base URL";
            emitValidated(requestId, false, null, msg, 400);
            emitError(requestId, msg, 400);
            return;
        }
        HttpURLConnection conn = null;
        try {
            conn = open(url, "GET", "application/json", true);
            req.conn = conn;
            if (req.cancelled) {
                return;
            }
            int status = conn.getResponseCode();
            if (req.cancelled) {
                return;
            }
            String body = readLimited(wrapStream(conn, status), MAX_ERROR_BODY * 32);
            if (status >= 200 && status < 300) {
                JSONArray models = new JSONArray();
                try {
                    JSONObject obj = new JSONObject(body);
                    JSONArray data = obj.optJSONArray("data");
                    if (data != null) {
                        for (int i = 0; i < data.length(); i++) {
                            JSONObject m = data.optJSONObject(i);
                            if (m == null) {
                                continue;
                            }
                            String id = optText(m, "id", "").trim();
                            if (!id.isEmpty()) {
                                models.put(id);
                            }
                        }
                    }
                } catch (JSONException ignored) {
                    // 200 但结构异常：当作空列表，仍算 key 可用
                }
                emitValidated(requestId, true, models, null, status);
            } else {
                String msg = friendlyHttp(status, body);
                emitValidated(requestId, false, null, msg, status);
                emitError(requestId, msg, status);
            }
        } catch (Throwable t) {
            if (!req.cancelled) {
                String msg = netMessage(t);
                emitValidated(requestId, false, null, msg, 0);
                emitError(requestId, msg, 0);
            }
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        }
    }

    // ------------------------------------------------------------ 通用 httpFetch

    /** §3.2 httpFetch：{"url","method","headers":{},"body"}；仅允许 https（本机 http 例外）。 */
    public void httpFetch(final String requestId, final String reqJson) {
        final Request req = register(requestId);
        submit(requestId, req, new Runnable() {
            @Override
            public void run() {
                try {
                    runHttpFetch(req, requestId, reqJson);
                } finally {
                    req.conn = null;
                    finish(requestId, req);
                }
            }
        });
    }

    private void runHttpFetch(Request req, String requestId, String reqJson) {
        if (req.cancelled) {
            return;
        }
        JSONObject in;
        try {
            in = new JSONObject(reqJson == null || reqJson.trim().isEmpty() ? "{}" : reqJson);
        } catch (JSONException e) {
            emitHttp(requestId, 0, "", "请求参数不是合法 JSON");
            return;
        }
        String url = optText(in, "url", "").trim();
        if (url.isEmpty()) {
            emitHttp(requestId, 0, "", "缺少 url");
            return;
        }
        String schemeError = checkFetchUrl(url);
        if (schemeError != null) {
            emitHttp(requestId, 0, "", schemeError);
            return;
        }
        String method = optText(in, "method", "GET").trim().toUpperCase(Locale.US);
        if (method.isEmpty()) {
            method = "GET";
        }
        if (!isSupportedMethod(method)) {
            emitHttp(requestId, 0, "", "不支持的 HTTP 方法：" + method);
            return;
        }
        JSONObject headers = in.optJSONObject("headers");
        String body = null;
        if (in.has("body") && !in.isNull("body")) {
            Object raw = in.opt("body");
            body = raw instanceof String ? (String) raw : String.valueOf(raw);
        }
        HttpURLConnection conn = null;
        try {
            conn = open(url, method, "application/json, text/plain, */*", false);
            conn.setInstanceFollowRedirects(true);
            if (headers != null) {
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    if (key == null || isManagedHeader(key)) {
                        continue;
                    }
                    String value = optText(headers, key, "");
                    if (value.isEmpty()) {
                        continue;
                    }
                    try {
                        conn.setRequestProperty(key, value);
                    } catch (Throwable ignored) {
                        // 非法 header 名/值直接跳过
                    }
                }
            }
            req.conn = conn;
            if (req.cancelled) {
                return;
            }
            if (body != null && hasRequestBody(method)) {
                if (conn.getRequestProperty("Content-Type") == null) {
                    conn.setRequestProperty("Content-Type", "application/json");
                }
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(bytes.length);
                OutputStream out = conn.getOutputStream();
                out.write(bytes);
                out.flush();
                out.close();
            }
            int status = conn.getResponseCode();
            if (req.cancelled) {
                return;
            }
            String respBody = readLimited(wrapStream(conn, status), MAX_FETCH_BODY);
            if (req.cancelled) {
                return;
            }
            emitHttp(requestId, status, respBody, null);
        } catch (Throwable t) {
            if (!req.cancelled) {
                emitHttp(requestId, 0, "", netMessage(t));
            }
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        }
    }

    // ------------------------------------------------------------ HTTP 基础

    /**
     * @param withAuth true 时附上 API Key（仅 DeepSeek 官方端点）；通用 httpFetch 绝不能带，
     *                 否则插件请求第三方 URL 会泄漏用户 Key。
     */
    private HttpURLConnection open(String url, String method, String accept, boolean withAuth)
            throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setUseCaches(false);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("Accept", accept);
        // 手动处理 gzip：见 wrapStream，兼容部分服务端/代理的压缩行为
        conn.setRequestProperty("Accept-Encoding", "gzip");
        conn.setRequestProperty("User-Agent", USER_AGENT);
        if (withAuth) {
            String apiKey = prefs.getApiKey();
            if (apiKey != null && !apiKey.trim().isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + apiKey.trim());
            }
        }
        return conn;
    }

    /** 按状态码取正常流/错误流，并按 Content-Encoding 解 gzip。 */
    private static InputStream wrapStream(HttpURLConnection conn, int status) throws IOException {
        InputStream raw = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
        if (raw == null) {
            return null;
        }
        String encoding = conn.getContentEncoding();
        if (encoding != null && encoding.toLowerCase(Locale.US).contains("gzip")) {
            try {
                return new GZIPInputStream(raw);
            } catch (IOException e) {
                return raw;
            }
        }
        return raw;
    }

    private static String readLimited(InputStream in, int max) {
        if (in == null) {
            return "";
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try {
            byte[] buf = new byte[8192];
            int total = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                if (total + n > max) {
                    bos.write(buf, 0, Math.max(0, max - total));
                    break;
                }
                bos.write(buf, 0, n);
                total += n;
            }
        } catch (IOException ignored) {
            // 返回已读到的部分
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
                // 忽略
            }
        }
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String joinUrl(String base, String path) {
        String b = base == null ? "" : base.trim();
        while (b.endsWith("/")) {
            b = b.substring(0, b.length() - 1);
        }
        if (b.isEmpty()) {
            return "";
        }
        if (!b.startsWith("http://") && !b.startsWith("https://")) {
            b = "https://" + b;
        }
        return b + path;
    }

    /** 插件网络请求只允许 https；http 仅限本机回环地址。返回 null 表示允许。 */
    private static String checkFetchUrl(String url) {
        String lower = url.toLowerCase(Locale.US);
        if (lower.startsWith("https://")) {
            return null;
        }
        if (!lower.startsWith("http://")) {
            return "仅支持 http(s) 地址";
        }
        String rest = lower.substring("http://".length());
        int end = rest.length();
        for (int i = 0; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (c == '/' || c == '?' || c == '#') {
                end = i;
                break;
            }
        }
        String authority = rest.substring(0, end);
        int at = authority.lastIndexOf('@');
        if (at >= 0) {
            authority = authority.substring(at + 1);
        }
        String host;
        if (authority.startsWith("[")) {
            int close = authority.indexOf(']');
            host = close > 1 ? authority.substring(1, close) : authority;
        } else {
            int colon = authority.indexOf(':');
            host = colon >= 0 ? authority.substring(0, colon) : authority;
        }
        boolean loopback = "localhost".equals(host) || "127.0.0.1".equals(host)
                || "::1".equals(host) || "0:0:0:0:0:0:0:1".equals(host);
        return loopback ? null : "插件网络请求仅允许 https（本机 http 除外）";
    }

    private static boolean isSupportedMethod(String method) {
        return "GET".equals(method) || "POST".equals(method) || "PUT".equals(method)
                || "DELETE".equals(method) || "HEAD".equals(method) || "OPTIONS".equals(method);
    }

    private static boolean hasRequestBody(String method) {
        return "POST".equals(method) || "PUT".equals(method) || "DELETE".equals(method);
    }

    private static boolean isManagedHeader(String key) {
        String k = key.toLowerCase(Locale.US);
        return "host".equals(k) || "content-length".equals(k) || "connection".equals(k)
                || "transfer-encoding".equals(k) || "upgrade".equals(k);
    }

    // ------------------------------------------------------------ 事件

    private void emitChunk(String requestId, String content, String reasoning, JSONArray toolCalls) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "chunk");
            o.put("requestId", requestId);
            o.put("delta", content == null ? "" : content);
            o.put("reasoning", reasoning == null ? "" : reasoning);
            if (toolCalls != null && toolCalls.length() > 0) {
                o.put("toolCalls", toolCalls);
            }
        } catch (JSONException ignored) {
            return;
        }
        emit(o);
    }

    private void emitDone(String requestId, String finishReason, JSONObject usage) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "done");
            o.put("requestId", requestId);
            o.put("finishReason", finishReason == null || finishReason.isEmpty() ? "stop" : finishReason);
            if (usage != null) {
                o.put("usage", usage);
            }
        } catch (JSONException ignored) {
            return;
        }
        emit(o);
    }

    private void emitError(String requestId, String message, int httpStatus) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "error");
            o.put("requestId", requestId == null ? "" : requestId);
            o.put("message", message == null ? "" : message);
            o.put("httpStatus", httpStatus);
        } catch (JSONException ignored) {
            return;
        }
        emit(o);
    }

    private void emitValidated(String requestId, boolean ok, JSONArray models,
                               String error, int httpStatus) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "validated");
            o.put("requestId", requestId);
            o.put("ok", ok);
            o.put("models", models == null ? new JSONArray() : models);
            if (error != null) {
                o.put("error", error);
                o.put("httpStatus", httpStatus);
            }
        } catch (JSONException ignored) {
            return;
        }
        emit(o);
    }

    private void emitHttp(String requestId, int status, String body, String error) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "http");
            o.put("requestId", requestId);
            o.put("status", status);
            o.put("body", body == null ? "" : body);
            if (error != null) {
                o.put("error", error);
            } else {
                o.put("error", JSONObject.NULL);
            }
        } catch (JSONException ignored) {
            return;
        }
        emit(o);
    }

    private void emit(JSONObject o) {
        try {
            sink.emit(o.toString());
        } catch (Throwable ignored) {
            // 事件通道异常不影响网络线程
        }
    }

    // ------------------------------------------------------------ 错误文案

    /** 从 {"error":{"message":...}} 或 {"error":"..."} 中取可读信息。 */
    private static String payloadErrorMessage(JSONObject payload) {
        if (payload == null) {
            return "服务端返回错误";
        }
        try {
            Object err = payload.opt("error");
            if (err instanceof JSONObject) {
                String msg = optText((JSONObject) err, "message", "");
                String type = optText((JSONObject) err, "type", "");
                if (!msg.isEmpty()) {
                    return msg;
                }
                if (!type.isEmpty()) {
                    return type;
                }
            } else if (err instanceof String) {
                String msg = ((String) err).trim();
                if (!msg.isEmpty()) {
                    return msg;
                }
            }
        } catch (Throwable ignored) {
            // 忽略
        }
        String msg = optText(payload, "message", "");
        return msg.isEmpty() ? "服务端返回错误" : msg;
    }

    private static String friendlyHttp(int status, String body) {
        String detail = "";
        if (body != null && !body.trim().isEmpty()) {
            try {
                detail = payloadErrorMessage(new JSONObject(body));
            } catch (JSONException ignored) {
                detail = body.trim();
            }
        }
        if (detail.length() > 240) {
            detail = detail.substring(0, 240) + "…";
        }
        String prefix;
        switch (status) {
            case 400:
                prefix = "请求参数错误";
                break;
            case 401:
                prefix = "API Key 无效或已过期";
                break;
            case 402:
                prefix = "账户余额不足";
                break;
            case 403:
                prefix = "没有访问权限";
                break;
            case 404:
                prefix = "接口地址不存在（请检查 Base URL）";
                break;
            case 429:
                prefix = "请求过于频繁（限流）";
                break;
            case 500:
            case 502:
            case 503:
            case 504:
                prefix = "服务端暂时不可用";
                break;
            default:
                prefix = status >= 500 ? "服务端错误" : "请求失败";
                break;
        }
        String msg = prefix + "（HTTP " + status + "）";
        return detail.isEmpty() ? msg : msg + "：" + detail;
    }

    private static String netMessage(Throwable t) {
        if (t instanceof SocketTimeoutException) {
            return "网络超时，请检查网络或 Base URL";
        }
        String detail = t == null ? null : t.getMessage();
        if (detail == null || detail.trim().isEmpty()) {
            detail = t == null ? "未知错误" : t.getClass().getSimpleName();
        }
        return "网络异常：" + detail;
    }

    // ------------------------------------------------------------ JSON 小工具

    /** org.json 在 Android 上对 JSON null 调 optString 会得到字符串 "null"，这里统一兜底。 */
    private static String optText(JSONObject o, String key, String fallback) {
        if (o == null || !o.has(key) || o.isNull(key)) {
            return fallback;
        }
        String v = o.optString(key, fallback);
        return v == null ? fallback : v;
    }

    private static void copyField(JSONObject from, JSONObject to, String key) throws JSONException {
        if (from.has(key) && !from.isNull(key)) {
            to.put(key, from.get(key));
        }
    }
}
