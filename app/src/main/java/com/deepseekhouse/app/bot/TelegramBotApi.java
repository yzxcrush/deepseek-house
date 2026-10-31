package com.deepseekhouse.app.bot;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Telegram Bot API 客户端（v3.0.0）。
 *
 * <p>固定 {@code https://api.telegram.org/bot<token>/<method>}；实现 getMe / sendMessage /
 * getUpdates 长轮询。错误统一转中文 {@link BotException}；任何异常消息都经过 token scrub，
 * token 不写日志、不出现在错误串里。</p>
 *
 * <p>只应在后台线程调用（网络 IO 会阻塞）。</p>
 */
public final class TelegramBotApi {

    public static final String API_BASE = "https://api.telegram.org";

    private static final int CONNECT_TIMEOUT_MS = 15 * 1000;
    private static final int DEFAULT_READ_TIMEOUT_MS = 20 * 1000;
    private static final int MAX_BODY_BYTES = 4 * 1024 * 1024;

    private final String token;
    private final String apiBase;
    private final List<HttpURLConnection> activeConnections =
            Collections.synchronizedList(new ArrayList<HttpURLConnection>());

    public TelegramBotApi(String token) {
        this(token, API_BASE);
    }

    /** 测试用构造：允许替换 apiBase（生产恒为 {@link #API_BASE}）。 */
    TelegramBotApi(String token, String apiBase) {
        String safeToken = token == null ? "" : token.trim();
        if (safeToken.isEmpty()) {
            throw new IllegalArgumentException("缺少 Telegram Bot Token");
        }
        if (!isPlausibleToken(safeToken)) {
            throw new IllegalArgumentException("Telegram Bot Token 含非法字符");
        }
        this.token = safeToken;
        this.apiBase = apiBase == null || apiBase.trim().isEmpty()
                ? API_BASE : apiBase.trim();
    }

    static boolean isPlausibleToken(String token) {
        if (token == null || token.trim().isEmpty() || token.length() > 256) {
            return false;
        }
        for (int i = 0; i < token.length(); i++) {
            char c = token.charAt(i);
            if (c == '/' || c == '?' || c == '#' || c == ' ' || c == '\n'
                    || c == '\r' || c == '\t') {
                return false;
            }
        }
        return true;
    }

    // ------------------------------------------------------------ 方法

    /** getMe：返回 result 对象（含 id/username/first_name 等）。 */
    public JSONObject getMe() throws IOException {
        JSONObject root = call("getMe", "GET", null, DEFAULT_READ_TIMEOUT_MS);
        JSONObject result = root.optJSONObject("result");
        if (result == null) {
            throw new BotException(0, "Telegram getMe 响应缺少 result");
        }
        return result;
    }

    /** sendMessage：返回 message_id（失败抛中文 BotException）。 */
    public long sendMessage(String chatId, String text, String parseMode) throws IOException {
        String target = chatId == null ? "" : chatId.trim();
        if (target.isEmpty()) {
            throw new BotException(0, "缺少聊天 ID（chatId）");
        }
        String content = text == null ? "" : text;
        if (content.trim().isEmpty()) {
            throw new BotException(0, "消息内容为空");
        }
        LinkedHashMap<String, String> params = new LinkedHashMap<>();
        params.put("chat_id", target);
        params.put("text", content);
        if (parseMode != null && !parseMode.trim().isEmpty()) {
            params.put("parse_mode", parseMode.trim());
        }
        params.put("disable_web_page_preview", "true");
        JSONObject root = call("sendMessage", "POST", params, DEFAULT_READ_TIMEOUT_MS);
        JSONObject result = root.optJSONObject("result");
        if (result == null) {
            throw new BotException(0, "Telegram sendMessage 响应缺少 result");
        }
        return result.optLong("message_id", 0L);
    }

    /**
     * getUpdates：长轮询。offset=-1 表示“取最后一条 update 的 id”（用于启动时跳过积压）。
     *
     * @param timeoutSeconds 服务器长轮询等待秒数（0 = 立即返回；通常 25）
     */
    public JSONArray getUpdates(long offset, int timeoutSeconds) throws IOException {
        int hold = Math.max(0, Math.min(50, timeoutSeconds));
        LinkedHashMap<String, String> params = new LinkedHashMap<>();
        params.put("offset", String.valueOf(offset));
        params.put("timeout", String.valueOf(hold));
        params.put("limit", "100");
        params.put("allowed_updates", "[\"message\"]");
        int readTimeout = (hold + 20) * 1000;
        JSONObject root = call("getUpdates", "GET", params, readTimeout);
        JSONArray result = root.optJSONArray("result");
        return result == null ? new JSONArray() : result;
    }

    /** 取消在途请求（botStop 时尽快退出长轮询）。 */
    public void cancel() {
        List<HttpURLConnection> snapshot;
        synchronized (activeConnections) {
            snapshot = new ArrayList<>(activeConnections);
            activeConnections.clear();
        }
        for (HttpURLConnection conn : snapshot) {
            try {
                conn.disconnect();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
    }

    // ------------------------------------------------------------ HTTP

    private JSONObject call(String method, String httpMethod,
                            Map<String, String> params, int readTimeoutMs) throws IOException {
        if (!TelegramBotApi.isPlausibleToken(token)) {
            throw new BotException(0, "Telegram Bot Token 无效");
        }
        URL url;
        try {
            String path = "/bot" + token + "/" + method;
            String query = httpMethod.equals("GET") ? buildQuery(params) : null;
            url = new URL(apiBase + path + (query == null || query.isEmpty() ? "" : "?" + query));
        } catch (Throwable t) {
            // 不把异常 message（可能含 URL/token）直接抛出
            throw new BotException(0, "Telegram API 地址无效");
        }
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod(httpMethod);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(Math.max(1000, readTimeoutMs));
            conn.setUseCaches(false);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("User-Agent", "DeepSeekHouse/3.0.0 (Android)");
            if (!"GET".equals(httpMethod)) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type",
                        "application/x-www-form-urlencoded; charset=utf-8");
                byte[] body = buildQuery(params).getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(body.length);
                OutputStream out = conn.getOutputStream();
                try {
                    out.write(body);
                    out.flush();
                } finally {
                    out.close();
                }
            }
            activeConnections.add(conn);
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String body = readBody(in, MAX_BODY_BYTES);
            if (body.trim().isEmpty()) {
                int code = status >= 400 ? status : 0;
                throw new BotException(code, chineseError(code,
                        status >= 400 ? "HTTP " + status : "服务器返回空响应"));
            }
            JSONObject root;
            try {
                root = new JSONObject(body);
            } catch (JSONException e) {
                throw new BotException(status >= 400 ? status : 0,
                        "Telegram 响应不是合法 JSON（HTTP " + status + "）");
            }
            if (root.optBoolean("ok", false)) {
                return root;
            }
            int code = root.optInt("error_code", status);
            String description = scrub(root.optString("description", ""), token);
            throw new BotException(code, chineseError(code, description));
        } catch (BotException e) {
            throw e;
        } catch (java.net.SocketTimeoutException e) {
            throw new BotException(0, "Telegram 请求超时（网络较慢或被墙）");
        } catch (java.net.MalformedURLException e) {
            throw new BotException(0, "Telegram API 地址无效");
        } catch (IOException e) {
            throw new BotException(0, "Telegram 网络错误：" + scrub(e.getMessage(), token));
        } catch (Throwable t) {
            throw new BotException(0, "Telegram 调用失败：" + scrub(t.getMessage(), token));
        } finally {
            if (conn != null) {
                activeConnections.remove(conn);
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        }
    }

    private static String buildQuery(Map<String, String> params) {
        if (params == null || params.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> entry : params.entrySet()) {
            if (sb.length() > 0) {
                sb.append('&');
            }
            sb.append(encode(entry.getKey())).append('=').append(encode(entry.getValue()));
        }
        return sb.toString();
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value == null ? "" : value, "UTF-8");
        } catch (Throwable t) {
            return "";
        }
    }

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
                if (total >= maxBytes) {
                    break;
                }
            }
        } catch (IOException ignored) {
            // 读取中断时返回已读部分
        } finally {
            try {
                in.close();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    // ------------------------------------------------------------ 错误映射 / 脱敏

    static String chineseError(int code, String description) {
        String d = description == null ? "" : description.trim();
        String base;
        switch (code) {
            case 400:
                base = "请求参数错误（400）";
                break;
            case 401:
                base = "Token 无效或已过期（401）";
                break;
            case 403:
                base = "Bot 无权限或已被用户拉黑（403）";
                break;
            case 404:
                base = "Bot Token 无效或接口不存在（404）";
                break;
            case 409:
                base = "Bot 已启用 Webhook，请先删除 Webhook（409）";
                break;
            case 429:
                base = "请求过于频繁（429），请稍后再试";
                break;
            default:
                if (code >= 500) {
                    base = "Telegram 服务异常（" + code + "）";
                } else if (code > 0) {
                    base = "Telegram 错误（" + code + "）";
                } else {
                    base = "Telegram 调用失败";
                }
                break;
        }
        if (d.isEmpty() || d.startsWith("HTTP ") || base.contains(d)) {
            return base;
        }
        return base + "：" + d;
    }

    /** 把错误文本里的 token 替换成 ***（防止日志/事件泄漏）。 */
    static String scrub(String text, String secret) {
        if (text == null) {
            return "";
        }
        if (secret == null || secret.isEmpty()) {
            return text;
        }
        return text.replace(secret, "***");
    }

    @Override
    public String toString() {
        return "TelegramBotApi{base=" + apiBase + ", token=***}";
    }
}
