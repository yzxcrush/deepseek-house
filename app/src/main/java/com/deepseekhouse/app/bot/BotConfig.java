package com.deepseekhouse.app.bot;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Iterator;
import java.util.Locale;

/**
 * 一个 Bot 的持久化配置（v3.0.0）。
 *
 * <p>JSON 存储于 {@code Prefs.bots} 数组；核心字段：</p>
 * <pre>
 * {id, type:"telegram"|"onebot", name, enabled,
 *  token (telegram), accessToken (onebot), baseUrl (onebot，默认 http://127.0.0.1:3000),
 *  appId?, secret?}
 * </pre>
 *
 * <p>未知字段（如 autoReply/whitelist/systemPrompt/cooldownSec/hourlyLimit 等 JS 侧配置）
 * 会原样保存在 {@link #extra} 里并随列表回传，原生不使用。</p>
 *
 * <p>安全：token/accessToken/secret 只存在 Prefs 与内存，绝不写日志。</p>
 */
public final class BotConfig {

    public static final String TYPE_TELEGRAM = "telegram";
    public static final String TYPE_ONEBOT = "onebot";
    public static final String DEFAULT_ONEBOT_BASE = "http://127.0.0.1:3000";

    private static final String[] CORE_KEYS = new String[]{
            "id", "type", "name", "enabled", "token", "accessToken", "baseUrl", "appId", "secret"
    };

    public String id;
    public String type;
    public String name;
    public boolean enabled;
    /** Telegram BotFather Token。 */
    public String token;
    /** OneBot Access Token（可空）。 */
    public String accessToken;
    /** OneBot HTTP API 地址。 */
    public String baseUrl;
    public String appId;
    public String secret;

    private final JSONObject extra;

    public BotConfig() {
        this.extra = new JSONObject();
    }

    private BotConfig(JSONObject extra) {
        this.extra = extra == null ? new JSONObject() : extra;
    }

    /** 解析配置；type 非法、telegram 缺 token、onebot baseUrl 非法时返回 null。 */
    public static BotConfig fromJson(JSONObject o) {
        if (o == null) {
            return null;
        }
        String type = normalizeType(text(o, "type"));
        if (type.isEmpty()) {
            return null;
        }
        String token = text(o, "token").trim();
        String accessToken = text(o, "accessToken").trim();
        String baseUrl = text(o, "baseUrl").trim();
        if (TYPE_TELEGRAM.equals(type)) {
            if (token.isEmpty()) {
                return null;
            }
            baseUrl = "";
        } else if (TYPE_ONEBOT.equals(type)) {
            if (baseUrl.isEmpty()) {
                baseUrl = DEFAULT_ONEBOT_BASE;
            }
            if (!isValidOneBotUrl(baseUrl)) {
                return null;
            }
        } else {
            return null;
        }
        BotConfig config = new BotConfig(extractExtra(o));
        config.id = normalizeId(text(o, "id"));
        config.type = type;
        config.name = text(o, "name").trim();
        if (config.name.isEmpty()) {
            config.name = TYPE_TELEGRAM.equals(type) ? "Telegram Bot" : "OneBot";
        }
        config.enabled = !o.has("enabled") || o.isNull("enabled") || o.optBoolean("enabled", true);
        config.token = token;
        config.accessToken = accessToken;
        config.baseUrl = baseUrl;
        config.appId = text(o, "appId").trim();
        config.secret = text(o, "secret").trim();
        return config;
    }

    /** 序列化（核心字段覆盖 extra 中的同名键）。 */
    public JSONObject toJson() {
        JSONObject out = new JSONObject();
        try {
            Iterator<String> keys = extra.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                out.put(key, extra.opt(key));
            }
            out.put("id", id == null ? "" : id);
            out.put("type", type == null ? "" : type);
            out.put("name", name == null ? "" : name);
            out.put("enabled", enabled);
            out.put("token", token == null ? "" : token);
            out.put("accessToken", accessToken == null ? "" : accessToken);
            out.put("baseUrl", baseUrl == null ? "" : baseUrl);
            out.put("appId", appId == null ? "" : appId);
            out.put("secret", secret == null ? "" : secret);
        } catch (JSONException ignored) {
            // 忽略
        }
        return out;
    }

    public BotConfig copy() {
        BotConfig copy = new BotConfig(extractExtra(toJson()));
        copy.id = id;
        copy.type = type;
        copy.name = name;
        copy.enabled = enabled;
        copy.token = token;
        copy.accessToken = accessToken;
        copy.baseUrl = baseUrl;
        copy.appId = appId;
        copy.secret = secret;
        return copy;
    }

    public boolean isTelegram() {
        return TYPE_TELEGRAM.equals(type);
    }

    public boolean isOneBot() {
        return TYPE_ONEBOT.equals(type);
    }

    /** 端点是否变化（type/token/baseUrl 变化时需要重启轮询）。 */
    public boolean sameEndpoint(BotConfig other) {
        if (other == null) {
            return false;
        }
        return eq(type, other.type) && eq(token, other.token)
                && eq(accessToken, other.accessToken) && eq(baseUrl, other.baseUrl);
    }

    // ------------------------------------------------------------ 校验 / 清洗

    public static String normalizeType(String raw) {
        String value = raw == null ? "" : raw.trim().toLowerCase(Locale.US);
        if (TYPE_TELEGRAM.equals(value) || TYPE_ONEBOT.equals(value)) {
            return value;
        }
        return "";
    }

    /** Bot id 只允许 [A-Za-z0-9_-]，最长 32；空返回空（由 manager 生成）。 */
    public static String normalizeId(String raw) {
        if (raw == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        String value = raw.trim();
        for (int i = 0; i < value.length() && sb.length() < 32; i++) {
            char c = value.charAt(i);
            boolean allowed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '_' || c == '-';
            if (allowed) {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    /** OneBot 地址只允许 http/https 且必须有主机名。 */
    public static boolean isValidOneBotUrl(String raw) {
        String value = normalizeBaseUrl(raw);
        if (value.isEmpty()) {
            return false;
        }
        try {
            java.net.URL url = new java.net.URL(value);
            String protocol = url.getProtocol() == null ? "" : url.getProtocol().toLowerCase(Locale.US);
            if (!"http".equals(protocol) && !"https".equals(protocol)) {
                return false;
            }
            String host = url.getHost();
            return host != null && !host.isEmpty();
        } catch (Throwable t) {
            return false;
        }
    }

    /** 去空白/去尾部斜杠；空返回默认地址。 */
    public static String normalizeBaseUrl(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            return DEFAULT_ONEBOT_BASE;
        }
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    private static JSONObject extractExtra(JSONObject o) {
        JSONObject extra = new JSONObject();
        if (o == null) {
            return extra;
        }
        Iterator<String> keys = o.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (isCoreKey(key)) {
                continue;
            }
            try {
                extra.put(key, o.opt(key));
            } catch (JSONException ignored) {
                // 忽略
            }
        }
        return extra;
    }

    private static boolean isCoreKey(String key) {
        for (String core : CORE_KEYS) {
            if (core.equals(key)) {
                return true;
            }
        }
        return false;
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

    @Override
    public String toString() {
        return "BotConfig{" + id + ", " + type + ", " + name
                + ", enabled=" + enabled + ", token=" + (token.isEmpty() ? "" : "***") + "}";
    }
}
