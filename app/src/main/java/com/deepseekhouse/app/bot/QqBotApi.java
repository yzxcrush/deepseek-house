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
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * QQ 官方机器人 v2 API 客户端（v3.1.0）。
 *
 * <p>鉴权：{@code POST https://bots.qq.com/app/getAppAccessToken}
 * body {@code {"appId","clientSecret"}} → {@code {access_token, expires_in}}；
 * token 缓存并提前 60s 刷新。</p>
 *
 * <p>业务 API（默认 base {@code https://api.sgroup.qq.com}，可切 sandbox）：</p>
 * <ul>
 *   <li>GET /users/@me、GET /users/@me/guilds、GET /guilds/{guild_id}/channels</li>
 *   <li>POST /channels/{channel_id}/messages（频道；404 时回退 /v2/guilds/{guild}/channels/{channel}/messages）</li>
 *   <li>POST /v2/groups/{group_openid}/messages、POST /v2/users/{openid}/messages</li>
 * </ul>
 *
 * <p>Header：{@code Authorization: QQBot <access_token>}、{@code Content-Type: application/json}；
 * body 发送消息为 {@code {content,msg_type:0,msg_seq:<递增>}}。
 * secret/access_token 不写日志，错误串统一脱敏。</p>
 */
public final class QqBotApi {

    public static final String TOKEN_BASE = "https://bots.qq.com";
    public static final String TOKEN_PATH = "/app/getAppAccessToken";
    public static final String DEFAULT_API_BASE = BotConfig.DEFAULT_QQ_API_BASE;

    private static final int CONNECT_TIMEOUT_MS = 15 * 1000;
    private static final int READ_TIMEOUT_MS = 15 * 1000;
    private static final int MAX_BODY_BYTES = 2 * 1024 * 1024;
    private static final long TOKEN_EARLY_REFRESH_MS = 60 * 1000L;

    private final String appId;
    private final String clientSecret;
    private final String apiBase;
    private final String tokenBase;
    private final AtomicInteger msgSeq = new AtomicInteger(1);
    private final List<HttpURLConnection> activeConnections =
            Collections.synchronizedList(new ArrayList<HttpURLConnection>());

    private volatile String accessToken = "";
    private volatile long tokenExpiresAt = 0L;

    public QqBotApi(String appId, String clientSecret, String baseUrl) {
        this(appId, clientSecret,
                baseUrl == null || baseUrl.trim().isEmpty()
                        ? DEFAULT_API_BASE : baseUrl.trim(),
                TOKEN_BASE, true);
    }

    /** 测试用构造：允许自定义 tokenBase/apiBase（生产 tokenBase 恒为 https://bots.qq.com）。 */
    QqBotApi(String appId, String clientSecret, String apiBase, String tokenBase) {
        this(appId, clientSecret, apiBase, tokenBase, false);
    }

    private QqBotApi(String appId, String clientSecret, String apiBase,
                     String tokenBase, boolean enforceHttps) {
        String safeAppId = appId == null ? "" : appId.trim();
        String safeSecret = clientSecret == null ? "" : clientSecret.trim();
        if (safeAppId.isEmpty() || safeSecret.isEmpty()) {
            throw new IllegalArgumentException("缺少 QQ 机器人 AppID 或 Secret");
        }
        if (enforceHttps && !BotConfig.isValidQqBotUrl(apiBase)) {
            throw new IllegalArgumentException("QQ 机器人 API 地址无效（仅支持 https）");
        }
        this.appId = safeAppId;
        this.clientSecret = safeSecret;
        this.apiBase = stripTrailingSlash(apiBase);
        this.tokenBase = stripTrailingSlash(tokenBase);
    }

    public String appId() {
        return appId;
    }

    // ------------------------------------------------------------ 鉴权

    /** 获取（并缓存）AppAccessToken；失败抛中文 BotException。 */
    public String getAccessToken() throws IOException {
        long now = System.currentTimeMillis();
        String token = accessToken;
        if (token != null && !token.isEmpty()
                && tokenExpiresAt - TOKEN_EARLY_REFRESH_MS > now) {
            return token;
        }
        synchronized (this) {
            now = System.currentTimeMillis();
            token = accessToken;
            if (token != null && !token.isEmpty()
                    && tokenExpiresAt - TOKEN_EARLY_REFRESH_MS > now) {
                return token;
            }
            refreshToken();
            return accessToken;
        }
    }

    /** 当前 token 剩余有效秒数（未获取过返回 0）。 */
    public long tokenTtlSeconds() {
        long remaining = tokenExpiresAt - System.currentTimeMillis();
        return remaining <= 0L ? 0L : remaining / 1000L;
    }

    public void invalidateToken() {
        synchronized (this) {
            accessToken = "";
            tokenExpiresAt = 0L;
        }
    }

    private void refreshToken() throws IOException {
        JSONObject payload = new JSONObject();
        try {
            payload.put("appId", appId);
            payload.put("clientSecret", clientSecret);
        } catch (JSONException ignored) {
            // 忽略
        }
        HttpURLConnection conn = null;
        try {
            conn = openConnection(tokenBase + TOKEN_PATH, "POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(bytes.length);
            OutputStream out = conn.getOutputStream();
            try {
                out.write(bytes);
                out.flush();
            } finally {
                out.close();
            }
            activeConnections.add(conn);
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String body = readBody(in, MAX_BODY_BYTES);
            JSONObject root = parseObject(body);
            int code = errorCode(root);
            if (status >= 400 || code != 0) {
                throw new BotException(code == 0 ? status : code,
                        chineseTokenError(code == 0 ? status : code,
                                scrub(root.optString("message", ""))));
            }
            String token = root.optString("access_token", "");
            if (token == null || token.isEmpty()) {
                throw new BotException(0, "获取 QQ 机器人 AccessToken 失败：响应缺少 access_token");
            }
            long expiresIn = parseExpiresIn(root.opt("expires_in"));
            if (expiresIn < 60L) {
                expiresIn = 60L;
            }
            accessToken = token;
            tokenExpiresAt = System.currentTimeMillis() + expiresIn * 1000L;
        } catch (BotException e) {
            throw e;
        } catch (java.net.SocketTimeoutException e) {
            throw new BotException(0, "获取 QQ 机器人 AccessToken 超时（15 秒）");
        } catch (IOException e) {
            throw new BotException(0, "获取 QQ 机器人 AccessToken 网络错误：" + scrub(e.getMessage()));
        } catch (Throwable t) {
            throw new BotException(0, "获取 QQ 机器人 AccessToken 失败：" + scrub(t.getMessage()));
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

    private static long parseExpiresIn(Object value) {
        if (value == null) {
            return 7200L;
        }
        try {
            return Long.parseLong(String.valueOf(value).trim());
        } catch (Throwable t) {
            return 7200L;
        }
    }

    // ------------------------------------------------------------ 查询

    /** 机器人所在频道（guild）列表；失败抛中文 BotException。 */
    public JSONArray getGuilds() throws IOException {
        Object result = request("GET", "/users/@me/guilds", null, true);
        JSONArray array = asArray(result);
        if (array == null) {
            throw new BotException(0, "QQ 频道列表响应格式异常");
        }
        return array;
    }

    /** 子频道列表。 */
    public JSONArray getChannels(String guildId) throws IOException {
        String safeGuild = safeSegment(guildId, "频道 ID");
        Object result = request("GET", "/guilds/" + safeGuild + "/channels", null, true);
        JSONArray array = asArray(result);
        if (array == null) {
            throw new BotException(0, "QQ 子频道列表响应格式异常");
        }
        return array;
    }

    /** 机器人自身信息（部分权限/版本可能 404，调用方自行处理）。 */
    public JSONObject getMe() throws IOException {
        Object result = request("GET", "/users/@me", null, true);
        return result instanceof JSONObject ? (JSONObject) result : new JSONObject();
    }

    // ------------------------------------------------------------ 发送

    /** 发送到频道子频道：POST /channels/{channel_id}/messages（404 回退 v2 路径）。 */
    public String sendChannelMessage(String guildId, String channelId, String content) throws IOException {
        String safeGuild = safeSegment(guildId, "频道 ID");
        String safeChannel = safeSegment(channelId, "子频道 ID");
        JSONObject body = messageBody(content);
        try {
            Object result = request("POST", "/channels/" + safeChannel + "/messages", body, true);
            return extractMessageId(result);
        } catch (BotException e) {
            if (e.code != 404 && e.code != 405) {
                throw e;
            }
            Object result = request("POST",
                    "/v2/guilds/" + safeGuild + "/channels/" + safeChannel + "/messages",
                    messageBody(content), true);
            return extractMessageId(result);
        }
    }

    /** 发送到 QQ 群（需要 group_openid）。 */
    public String sendGroupMessage(String groupOpenid, String content) throws IOException {
        String openid = safeSegment(groupOpenid, "group_openid");
        Object result = request("POST", "/v2/groups/" + openid + "/messages",
                messageBody(content), true);
        return extractMessageId(result);
    }

    /** 发送到 QQ 用户（需要 openid）。 */
    public String sendUserMessage(String userOpenid, String content) throws IOException {
        String openid = safeSegment(userOpenid, "openid");
        Object result = request("POST", "/v2/users/" + openid + "/messages",
                messageBody(content), true);
        return extractMessageId(result);
    }

    /**
     * 按 chatId 前缀路由：
     * {@code channel:<guild_id>:<channel_id>} / {@code guild:<guild_id>:<channel_id>} /
     * {@code group:<group_openid>} / {@code user:<openid>}。
     */
    public String sendMessage(String chatId, String content) throws IOException {
        String target = chatId == null ? "" : chatId.trim();
        if (target.isEmpty()) {
            throw new BotException(0, "缺少聊天 ID（chatId）");
        }
        String text = content == null ? "" : content;
        if (text.trim().isEmpty()) {
            throw new BotException(0, "消息内容为空");
        }
        String lower = target.toLowerCase(Locale.US);
        if (lower.startsWith("channel:") || lower.startsWith("guild:")) {
            String rest = target.substring(target.indexOf(':') + 1);
            int split = rest.indexOf(':');
            if (split <= 0 || split >= rest.length() - 1) {
                throw new BotException(0, "chatId 格式应为 channel:<guild_id>:<channel_id>");
            }
            String guildId = rest.substring(0, split);
            String channelId = rest.substring(split + 1);
            return sendChannelMessage(guildId, channelId, text);
        }
        if (lower.startsWith("group:")) {
            return sendGroupMessage(target.substring("group:".length()), text);
        }
        if (lower.startsWith("user:")) {
            return sendUserMessage(target.substring("user:".length()), text);
        }
        throw new BotException(0,
                "qqbot chatId 需使用 channel:<guild_id>:<channel_id> / group:<group_openid> / user:<openid> 前缀");
    }

    /** 取消在途请求（botStop/release）。 */
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

    private Object request(String method, String path, JSONObject body,
                           boolean allowRetryAuth) throws IOException {
        String token = getAccessToken();
        HttpURLConnection conn = null;
        try {
            conn = openConnection(apiBase + path, method);
            conn.setRequestProperty("Authorization", "QQBot " + token);
            conn.setRequestProperty("X-Union-Appid", appId);
            if (body != null && !"GET".equals(method)) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(bytes.length);
                OutputStream out = conn.getOutputStream();
                try {
                    out.write(bytes);
                    out.flush();
                } finally {
                    out.close();
                }
            }
            activeConnections.add(conn);
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String responseBody = readBody(in, MAX_BODY_BYTES);
            if (status == 401 && allowRetryAuth) {
                invalidateToken();
                return request(method, path, body, false);
            }
            Object parsed = parseAny(responseBody);
            if (status >= 400) {
                int code = status;
                String message = "";
                if (parsed instanceof JSONObject) {
                    JSONObject object = (JSONObject) parsed;
                    int serverCode = errorCode(object);
                    if (serverCode != 0) {
                        code = serverCode;
                    }
                    message = object.optString("message", "");
                }
                throw new BotException(code, chineseApiError(code, scrub(message)));
            }
            if (parsed instanceof JSONObject) {
                JSONObject object = (JSONObject) parsed;
                int code = errorCode(object);
                if (code != 0) {
                    throw new BotException(code,
                            chineseApiError(code, scrub(object.optString("message", ""))));
                }
            }
            return parsed;
        } catch (BotException e) {
            throw e;
        } catch (java.net.SocketTimeoutException e) {
            throw new BotException(0, "QQ 机器人请求超时（15 秒）");
        } catch (IOException e) {
            throw new BotException(0, "QQ 机器人网络错误：" + scrub(e.getMessage()));
        } catch (Throwable t) {
            throw new BotException(0, "QQ 机器人调用失败：" + scrub(t.getMessage()));
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

    private HttpURLConnection openConnection(String url, String method) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setUseCaches(false);
        conn.setInstanceFollowRedirects(false);
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("User-Agent", "DeepSeekHouse/3.1.0 (Android)");
        return conn;
    }

    private JSONObject messageBody(String content) {
        JSONObject body = new JSONObject();
        try {
            body.put("content", content == null ? "" : content);
            body.put("msg_type", 0);
            body.put("msg_seq", msgSeq.getAndIncrement());
        } catch (JSONException ignored) {
            // 忽略
        }
        return body;
    }

    private static JSONObject parseObject(String body) throws IOException {
        try {
            return new JSONObject(body == null || body.trim().isEmpty() ? "{}" : body);
        } catch (JSONException e) {
            throw new BotException(0, "QQ 机器人响应不是合法 JSON");
        }
    }

    private static Object parseAny(String body) throws IOException {
        String trimmed = body == null ? "" : body.trim();
        if (trimmed.isEmpty()) {
            return new JSONObject();
        }
        try {
            if (trimmed.startsWith("[")) {
                return new JSONArray(trimmed);
            }
            return new JSONObject(trimmed);
        } catch (JSONException e) {
            throw new BotException(0, "QQ 机器人响应不是合法 JSON");
        }
    }

    private static JSONArray asArray(Object value) {
        if (value instanceof JSONArray) {
            return (JSONArray) value;
        }
        if (value instanceof JSONObject) {
            JSONArray data = ((JSONObject) value).optJSONArray("data");
            if (data != null) {
                return data;
            }
            JSONArray items = ((JSONObject) value).optJSONArray("items");
            if (items != null) {
                return items;
            }
        }
        return null;
    }

    private static int errorCode(JSONObject object) {
        if (object == null) {
            return 0;
        }
        if (object.has("code") && !object.isNull("code")) {
            int code = object.optInt("code", 0);
            if (code != 0) {
                return code;
            }
        }
        if (object.has("err_code") && !object.isNull("err_code")) {
            int code = object.optInt("err_code", 0);
            if (code != 0) {
                return code;
            }
        }
        return 0;
    }

    private static String extractMessageId(Object result) {
        if (result instanceof JSONObject) {
            JSONObject object = (JSONObject) result;
            String id = object.optString("id", "");
            if (id != null && !id.isEmpty()) {
                return id;
            }
            JSONObject data = object.optJSONObject("data");
            if (data != null) {
                return data.optString("id", "");
            }
        }
        return "";
    }

    // ------------------------------------------------------------ 错误映射 / 脱敏

    static String chineseTokenError(int code, String detail) {
        String base;
        switch (code) {
            case 100016:
            case 100017:
                base = "AppID 或 Secret 无效，请检查 QQ 开放平台配置";
                break;
            case 401:
            case 403:
                base = "AppID/Secret 无权限或已失效（" + code + "）";
                break;
            case 429:
                base = "请求过于频繁（429），请稍后再试";
                break;
            default:
                base = code >= 500 ? "QQ 开放平台服务异常（" + code + "）"
                        : "获取 QQ 机器人 AccessToken 失败" + (code > 0 ? "（" + code + "）" : "");
                break;
        }
        return appendDetail(base, detail);
    }

    static String chineseApiError(int code, String detail) {
        String base;
        switch (code) {
            case 11244:
                base = "AccessToken 已过期，请重试";
                break;
            case 401:
                base = "AccessToken 无效或已过期（401）";
                break;
            case 403:
                base = "QQ 机器人无权限（403），请检查频道权限/API 权限";
                break;
            case 404:
                base = "目标不存在或接口不支持（404）";
                break;
            case 429:
                base = "请求过于频繁（429），请稍后再试";
                break;
            default:
                base = code >= 500 ? "QQ 机器人服务异常（" + code + "）"
                        : "QQ 机器人错误" + (code > 0 ? "（" + code + "）" : "");
                break;
        }
        return appendDetail(base, detail);
    }

    private static String appendDetail(String base, String detail) {
        String d = detail == null ? "" : detail.trim();
        if (d.isEmpty() || base.contains(d)) {
            return base;
        }
        return base + "：" + d;
    }

    private String scrub(String text) {
        if (text == null) {
            return "";
        }
        String value = text;
        if (clientSecret != null && !clientSecret.isEmpty()) {
            value = value.replace(clientSecret, "***");
        }
        if (accessToken != null && !accessToken.isEmpty()) {
            value = value.replace(accessToken, "***");
        }
        return value;
    }

    private static String safeSegment(String raw, String label) throws BotException {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            throw new BotException(0, "缺少" + label);
        }
        if (value.length() > 128) {
            throw new BotException(0, label + "过长");
        }
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean allowed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.';
            if (!allowed) {
                throw new BotException(0, label + " 含非法字符");
            }
        }
        return value;
    }

    private static String stripTrailingSlash(String raw) {
        String value = raw == null ? "" : raw.trim();
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
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
            // 忽略
        } finally {
            try {
                in.close();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    @Override
    public String toString() {
        return "QqBotApi{appId=" + appId + ", base=" + apiBase + ", secret=***}";
    }
}
