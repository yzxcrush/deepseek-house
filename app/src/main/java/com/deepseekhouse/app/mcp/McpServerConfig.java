package com.deepseekhouse.app.mcp;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;

/**
 * 一个 MCP 服务器的持久化配置（SPEC「ARCH v2 P2」N2：{@code [{id,name,url,token,enabled}]}）。
 *
 * <p>存储在 {@code Prefs} 的 {@code mcpServers} JSON 数组里；token 只存在 App 私有
 * SharedPreferences，不写日志。</p>
 */
public final class McpServerConfig {

    public String id;
    public String name;
    public String url;
    public String token;
    public boolean enabled;

    public McpServerConfig(String id, String name, String url, String token, boolean enabled) {
        this.id = id == null ? "" : id.trim();
        this.name = name == null ? "" : name.trim();
        this.url = url == null ? "" : url.trim();
        this.token = token == null ? "" : token.trim();
        this.enabled = enabled;
    }

    /** 从 JSON 解析；缺少 id/url 等关键字段返回 null（由调用方决定报错或忽略）。 */
    public static McpServerConfig fromJson(JSONObject o) {
        if (o == null) {
            return null;
        }
        String url = text(o, "url").trim();
        if (url.isEmpty()) {
            return null;
        }
        String id = text(o, "id").trim();
        String name = text(o, "name").trim();
        if (name.isEmpty()) {
            name = hostOf(url);
        }
        String token = text(o, "token").trim();
        boolean enabled = !o.has("enabled") || o.isNull("enabled") || o.optBoolean("enabled", true);
        return new McpServerConfig(id, name, url, token, enabled);
    }

    public JSONObject toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("id", id == null ? "" : id);
            o.put("name", name == null ? "" : name);
            o.put("url", url == null ? "" : url);
            o.put("token", token == null ? "" : token);
            o.put("enabled", enabled);
        } catch (JSONException ignored) {
            // 不可能失败：key 均非 null
        }
        return o;
    }

    /** 复制一份（避免 manager 状态与配置数组互相影响）。 */
    public McpServerConfig copy() {
        return new McpServerConfig(id, name, url, token, enabled);
    }

    public boolean sameEndpoint(McpServerConfig other) {
        if (other == null) {
            return false;
        }
        return eq(url, other.url) && eq(token, other.token);
    }

    private static boolean eq(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }

    private static String text(JSONObject o, String key) {
        if (o == null || !o.has(key) || o.isNull(key)) {
            return "";
        }
        String value = o.optString(key, "");
        return value == null || "null".equals(value) ? "" : value;
    }

    private static String hostOf(String url) {
        try {
            java.net.URL parsed = new java.net.URL(url);
            String host = parsed.getHost();
            return host == null || host.isEmpty() ? url : host;
        } catch (Throwable t) {
            return url;
        }
    }

    @Override
    public String toString() {
        return "McpServerConfig{" + id + ", " + name + ", " + url
                + ", enabled=" + enabled + ", token=" + (token.isEmpty() ? "" : "***") + "}";
    }

    /** 合法服务器 id 只允许字母/数字/下划线/中划线（会进入工具 id 与 OpenAI 函数名）。 */
    public static String sanitizeId(String raw) {
        if (raw == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        String trimmed = raw.trim();
        for (int i = 0; i < trimmed.length() && sb.length() < 32; i++) {
            char c = trimmed.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '_' || c == '-') {
                sb.append(c);
            } else {
                sb.append('_');
            }
        }
        return sb.toString();
    }

    /** 校验 URL：仅 http/https（Termux 本地 MCP 用 http://127.0.0.1:8787/mcp）。 */
    public static boolean isValidUrl(String raw) {
        if (raw == null || raw.trim().isEmpty()) {
            return false;
        }
        try {
            java.net.URL parsed = new java.net.URL(raw.trim());
            String protocol = parsed.getProtocol() == null
                    ? "" : parsed.getProtocol().toLowerCase(Locale.US);
            if (!"http".equals(protocol) && !"https".equals(protocol)) {
                return false;
            }
            String host = parsed.getHost();
            return host != null && !host.isEmpty();
        } catch (Throwable t) {
            return false;
        }
    }
}
