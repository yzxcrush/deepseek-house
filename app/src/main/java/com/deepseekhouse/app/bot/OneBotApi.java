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

/**
 * OneBot v11 HTTP API 客户端（v3.0.0，配合 NapCat / LLOneBot 等本地端）。
 *
 * <p>{@code POST {baseUrl}/<action>}，JSON body；{@code Authorization: Bearer <accessToken>}
 * （accessToken 可空）；连接/读取超时 15s。支持：</p>
 * <ul>
 *   <li>get_login_info / get_friend_list</li>
 *   <li>send_private_msg / send_group_msg</li>
 * </ul>
 *
 * <p>只支持“主动发送/查询”，不包含接收消息通道（OneBot 入站需要本地 HTTP 上报服务）。
 * accessToken 不写日志、不出现在错误串里。</p>
 */
public final class OneBotApi {

    public static final int TIMEOUT_MS = 15 * 1000;
    private static final int MAX_BODY_BYTES = 2 * 1024 * 1024;

    private final String baseUrl;
    private final String accessToken;
    private final List<HttpURLConnection> activeConnections =
            Collections.synchronizedList(new ArrayList<HttpURLConnection>());

    public OneBotApi(String baseUrl, String accessToken) {
        String base = BotConfig.normalizeBaseUrl(baseUrl);
        if (!BotConfig.isValidOneBotUrl(base)) {
            throw new IllegalArgumentException("OneBot 地址无效（仅支持 http/https）");
        }
        this.baseUrl = base;
        this.accessToken = accessToken == null ? "" : accessToken.trim();
    }

    // ------------------------------------------------------------ 查询

    /** get_login_info：返回 data 对象（user_id/nickname）。 */
    public JSONObject getLoginInfo() throws IOException {
        JSONObject root = post("get_login_info", new JSONObject(), TIMEOUT_MS);
        JSONObject data = root.optJSONObject("data");
        if (data == null) {
            throw new BotException(0, "OneBot get_login_info 响应缺少 data");
        }
        return data;
    }

    /** get_friend_list：返回 data 数组。 */
    public JSONArray getFriendList() throws IOException {
        JSONObject root = post("get_friend_list", new JSONObject(), TIMEOUT_MS);
        JSONArray data = root.optJSONArray("data");
        return data == null ? new JSONArray() : data;
    }

    // ------------------------------------------------------------ 发送

    /** 发送私聊消息，返回 message_id 字符串。 */
    public String sendPrivateMsg(long userId, String text) throws IOException {
        if (userId <= 0L) {
            throw new BotException(0, "私聊 QQ 号无效");
        }
        JSONObject params = new JSONObject();
        try {
            params.put("user_id", userId);
            params.put("message", text == null ? "" : text);
            params.put("auto_escape", false);
        } catch (JSONException ignored) {
            // 忽略
        }
        JSONObject root = post("send_private_msg", params, TIMEOUT_MS);
        return extractMessageId(root);
    }

    /** 发送群消息，返回 message_id 字符串。 */
    public String sendGroupMsg(long groupId, String text) throws IOException {
        if (groupId <= 0L) {
            throw new BotException(0, "群号无效");
        }
        JSONObject params = new JSONObject();
        try {
            params.put("group_id", groupId);
            params.put("message", text == null ? "" : text);
            params.put("auto_escape", false);
        } catch (JSONException ignored) {
            // 忽略
        }
        JSONObject root = post("send_group_msg", params, TIMEOUT_MS);
        return extractMessageId(root);
    }

    /**
     * 通用发送：chatId 支持 "private:123456" / "group:123456"；不带前缀的纯数字按私聊处理。
     */
    public String sendMessage(String chatId, String text) throws IOException {
        String target = chatId == null ? "" : chatId.trim();
        if (target.isEmpty()) {
            throw new BotException(0, "缺少聊天 ID（chatId）");
        }
        String content = text == null ? "" : text;
        if (content.trim().isEmpty()) {
            throw new BotException(0, "消息内容为空");
        }
        String lower = target.toLowerCase(Locale.US);
        if (lower.startsWith("group:")) {
            long groupId = parseLong(target.substring("group:".length()));
            return sendGroupMsg(groupId, content);
        }
        if (lower.startsWith("private:")) {
            long userId = parseLong(target.substring("private:".length()));
            return sendPrivateMsg(userId, content);
        }
        long userId = parseLong(target);
        if (userId > 0L) {
            return sendPrivateMsg(userId, content);
        }
        // 非数字 target（如 QQ 频道/自定义标识）：作为字符串 user_id 发送
        JSONObject params = new JSONObject();
        try {
            params.put("user_id", target);
            params.put("message", content);
            params.put("auto_escape", false);
        } catch (JSONException ignored) {
            // 忽略
        }
        JSONObject root = post("send_private_msg", params, TIMEOUT_MS);
        return extractMessageId(root);
    }

    /** 取消在途请求。 */
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

    private JSONObject post(String action, JSONObject params, int timeoutMs) throws IOException {
        URL url;
        try {
            url = new URL(baseUrl + "/" + action);
        } catch (Throwable t) {
            throw new BotException(0, "OneBot 地址无效");
        }
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setUseCaches(false);
            conn.setInstanceFollowRedirects(false);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("User-Agent", "DeepSeekHouse/3.0.0 (Android)");
            if (!accessToken.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + accessToken);
            }
            byte[] body = (params == null ? new JSONObject() : params)
                    .toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(body.length);
            OutputStream out = conn.getOutputStream();
            try {
                out.write(body);
                out.flush();
            } finally {
                out.close();
            }
            activeConnections.add(conn);
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String bodyText = readBody(in, MAX_BODY_BYTES);
            if (status == 401 || status == 403) {
                throw new BotException(status, chineseError(status, ""));
            }
            if (bodyText.trim().isEmpty()) {
                throw new BotException(status >= 400 ? status : 0,
                        chineseError(status >= 400 ? status : 0,
                                "服务器返回空响应（HTTP " + status + "）"));
            }
            JSONObject root;
            try {
                root = new JSONObject(bodyText);
            } catch (JSONException e) {
                throw new BotException(status >= 400 ? status : 0,
                        "OneBot 响应不是合法 JSON（HTTP " + status + "）");
            }
            int retcode = root.optInt("retcode", 0);
            String statusField = root.optString("status", "");
            boolean ok = retcode == 0 && ("ok".equalsIgnoreCase(statusField)
                    || "async".equalsIgnoreCase(statusField) || statusField.isEmpty());
            if (!ok) {
                String message = root.optString("message", "");
                String wording = root.optString("wording", "");
                String detail = !wording.isEmpty() ? wording : message;
                throw new BotException(retcode == 0 ? (status >= 400 ? status : -1) : retcode,
                        chineseError(retcode == 0 ? status : retcode, detail));
            }
            return root;
        } catch (BotException e) {
            throw e;
        } catch (java.net.SocketTimeoutException e) {
            throw new BotException(0, "OneBot 请求超时（15 秒），请确认本地端在运行");
        } catch (IOException e) {
            throw new BotException(0, "OneBot 网络错误：" + scrub(e.getMessage()));
        } catch (Throwable t) {
            throw new BotException(0, "OneBot 调用失败：" + scrub(t.getMessage()));
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

    private String extractMessageId(JSONObject root) throws BotException {
        JSONObject data = root.optJSONObject("data");
        if (data == null) {
            return "";
        }
        if (data.has("message_id") && !data.isNull("message_id")) {
            Object value = data.opt("message_id");
            return value == null ? "" : String.valueOf(value);
        }
        return "";
    }

    private static long parseLong(String raw) {
        try {
            return Long.parseLong(raw == null ? "" : raw.trim());
        } catch (Throwable t) {
            return -1L;
        }
    }

    // ------------------------------------------------------------ 错误映射 / 工具

    static String chineseError(int code, String detail) {
        String d = detail == null ? "" : detail.trim();
        String base;
        switch (code) {
            case 401:
                base = "Access Token 无效或缺失（401）";
                break;
            case 403:
                base = "OneBot 拒绝访问（403），请检查 Access Token";
                break;
            case 100:
            case 1400:
                base = "OneBot 请求参数错误";
                break;
            case 1401:
                base = "OneBot 不支持该操作";
                break;
            case 1404:
                base = "OneBot 目标不存在";
                break;
            default:
                if (code >= 500) {
                    base = "OneBot 服务异常（" + code + "）";
                } else if (code > 0) {
                    base = "OneBot 错误（" + code + "）";
                } else {
                    base = "OneBot 调用失败";
                }
                break;
        }
        if (d.isEmpty() || base.contains(d)) {
            return base;
        }
        return base + "：" + d;
    }

    private String scrub(String text) {
        if (text == null) {
            return "";
        }
        if (accessToken.isEmpty()) {
            return text;
        }
        return text.replace(accessToken, "***");
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
        return "OneBotApi{base=" + baseUrl + ", accessToken=" + (accessToken.isEmpty() ? "" : "***") + "}";
    }
}
