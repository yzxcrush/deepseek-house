package com.deepseekhouse.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * 偏好设置存储。
 *
 * <p>apiKey 只保存在 SharedPreferences（私有目录），不写入 localStorage，也不允许打印到日志。</p>
 */
public final class Prefs {

    private static final String SP_FILE = "dsh_prefs";

    public static final String KEY_API_KEY = "apiKey";
    public static final String KEY_BASE_URL = "baseUrl";
    public static final String KEY_MODEL = "model";
    public static final String KEY_TEMPERATURE = "temperature";
    public static final String KEY_MAX_TOKENS = "maxTokens";
    public static final String KEY_STREAM = "stream";
    public static final String KEY_THEME = "theme";
    public static final String KEY_SYSTEM_PROMPT = "systemPrompt";
    public static final String KEY_BACK_DEPTH = "backDepth";
    /** F9 应用锁开关（只存原生 SharedPreferences，JS 通过 isAppLockEnabled() 查询）。 */
    public static final String KEY_APP_LOCK = "appLock";
    public static final String KEY_ROOT_MODE = "rootMode";
    /** ARCH v2 P1：工作区根目录（空字符串 = 使用默认 getExternalFilesDir("workspace")）。 */
    public static final String KEY_WORKSPACE_ROOT = "workspaceRoot";
    /** ARCH v2 P1：手机号登录 token（32 位 hex，绝不进入 getPrefs() 的 JS 载荷）。 */
    public static final String KEY_AUTH_TOKEN = "authToken";
    /** ARCH v2 P1：最近一次绑定的手机号（登出后保留，用于识别“已绑定未登录”）。 */
    public static final String KEY_AUTH_PHONE = "authPhone";
    /** ARCH v2 P2：MCP 服务器配置 JSON 数组 [{id,name,url,token,enabled}]。 */
    public static final String KEY_MCP_SERVERS = "mcpServers";
    /** ARCH v2 P3：house-plugins 目录插件的 enabled 状态（JSON 对象 fileName→bool）。 */
    public static final String KEY_PLUGIN_ENABLED = "housePluginEnabled";

    public static final String DEFAULT_BASE_URL = "https://api.deepseek.com";
    public static final String DEFAULT_MODEL = "deepseek-chat";
    public static final String DEFAULT_TEMPERATURE_TEXT = "1.0";
    public static final int DEFAULT_MAX_TOKENS = 4096;
    public static final boolean DEFAULT_STREAM = true;
    public static final String DEFAULT_THEME = "dark";
    public static final String DEFAULT_SYSTEM_PROMPT =
            "你是 DeepSeek House 助手，请始终使用简体中文回答，回答清晰、准确、简洁。";

    private final SharedPreferences sp;

    public Prefs(Context context) {
        this.sp = context.getApplicationContext()
                .getSharedPreferences(SP_FILE, Context.MODE_PRIVATE);
    }

    // ---------------------------------------------------------------- 读

    public String getApiKey() {
        return sp.getString(KEY_API_KEY, "");
    }

    public String getBaseUrl() {
        String v = sp.getString(KEY_BASE_URL, DEFAULT_BASE_URL);
        return v == null || v.trim().isEmpty() ? DEFAULT_BASE_URL : v.trim();
    }

    public String getModel() {
        String v = sp.getString(KEY_MODEL, DEFAULT_MODEL);
        return v == null || v.trim().isEmpty() ? DEFAULT_MODEL : v.trim();
    }

    public double getTemperature() {
        String raw = sp.getString(KEY_TEMPERATURE, DEFAULT_TEMPERATURE_TEXT);
        try {
            return Double.parseDouble(raw);
        } catch (Throwable ignored) {
            return Double.parseDouble(DEFAULT_TEMPERATURE_TEXT);
        }
    }

    public int getMaxTokens() {
        return sp.getInt(KEY_MAX_TOKENS, DEFAULT_MAX_TOKENS);
    }

    public boolean isStream() {
        return sp.getBoolean(KEY_STREAM, DEFAULT_STREAM);
    }

    public String getTheme() {
        String v = sp.getString(KEY_THEME, DEFAULT_THEME);
        return v == null || v.trim().isEmpty() ? DEFAULT_THEME : v.trim();
    }

    public String getSystemPrompt() {
        String v = sp.getString(KEY_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT);
        return v == null ? DEFAULT_SYSTEM_PROMPT : v;
    }

    public int getBackDepth() {
        return sp.getInt(KEY_BACK_DEPTH, 0);
    }

    /** F9：应用锁是否开启（开启后启动时需系统身份验证）。 */
    public boolean isAppLockEnabled() {
        try {
            return sp.getBoolean(KEY_APP_LOCK, false);
        } catch (Throwable t) {
            return false;
        }
    }

    /** ARCH v2 P4+：Root 模式（终端/run_shell 是否通过 su 执行）。 */
    public boolean isRootMode() {
        try {
            return sp.getBoolean(KEY_ROOT_MODE, false);
        } catch (Throwable t) {
            return false;
        }
    }

    public void setRootMode(boolean enabled) {
        try {
            sp.edit().putBoolean(KEY_ROOT_MODE, enabled).apply();
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    public void setAppLockEnabled(boolean enabled) {
        try {
            sp.edit().putBoolean(KEY_APP_LOCK, enabled).apply();
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    // ---------------------------------------------------------------- ARCH v2 P1 工作区 / 登录态

    /** 已持久化的工作区根；空字符串表示使用默认目录。 */
    public String getWorkspaceRoot() {
        String value = sp.getString(KEY_WORKSPACE_ROOT, "");
        return value == null ? "" : value;
    }

    public void setWorkspaceRoot(String path) {
        sp.edit().putString(KEY_WORKSPACE_ROOT, path == null ? "" : path.trim()).apply();
    }

    /** 手机号登录 token（空 = 未登录）。只给 AuthManager/原生层使用，不暴露给 JS。 */
    public String getAuthToken() {
        String value = sp.getString(KEY_AUTH_TOKEN, "");
        return value == null ? "" : value;
    }

    public void setAuthToken(String token) {
        sp.edit().putString(KEY_AUTH_TOKEN, token == null ? "" : token.trim()).apply();
    }

    /** 已绑定手机号（登出后保留）。 */
    public String getAuthPhone() {
        String value = sp.getString(KEY_AUTH_PHONE, "");
        return value == null ? "" : value;
    }

    public void setAuthPhone(String phone) {
        sp.edit().putString(KEY_AUTH_PHONE, phone == null ? "" : phone.trim()).apply();
    }

    // ---------------------------------------------------------------- ARCH v2 P2 MCP 配置

    /** MCP 服务器配置原始 JSON 数组；缺省 {@code "[]"}。token 只在这里与原生层出现。 */
    public String getMcpServersJson() {
        String value = sp.getString(KEY_MCP_SERVERS, "[]");
        return value == null || value.trim().isEmpty() ? "[]" : value;
    }

    public void setMcpServersJson(String json) {
        String value = json == null || json.trim().isEmpty() ? "[]" : json.trim();
        sp.edit().putString(KEY_MCP_SERVERS, value).apply();
    }

    // ---------------------------------------------------------------- ARCH v2 P3 插件 enabled

    /** house-plugins 插件的启用状态 JSON（fileName→bool）；缺省 "{}"，未记录的默认 true。 */
    public String getPluginEnabledJson() {
        String value = sp.getString(KEY_PLUGIN_ENABLED, "{}");
        return value == null || value.trim().isEmpty() ? "{}" : value;
    }

    public void setPluginEnabledJson(String json) {
        String value = json == null || json.trim().isEmpty() ? "{}" : json.trim();
        sp.edit().putString(KEY_PLUGIN_ENABLED, value).apply();
    }

    // ---------------------------------------------------------------- 写

    public void setApiKey(String value) {
        sp.edit().putString(KEY_API_KEY, value == null ? "" : value.trim()).apply();
    }

    public void setBackDepth(int depth) {
        sp.edit().putInt(KEY_BACK_DEPTH, Math.max(0, depth)).apply();
    }

    /** 组装给 JS 的 JSON 对象（§3.1 getPrefs）。 */
    public JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put(KEY_API_KEY, getApiKey());
        o.put(KEY_BASE_URL, getBaseUrl());
        o.put(KEY_MODEL, getModel());
        o.put(KEY_TEMPERATURE, getTemperature());
        o.put(KEY_MAX_TOKENS, getMaxTokens());
        o.put(KEY_STREAM, isStream());
        o.put(KEY_THEME, getTheme());
        o.put(KEY_SYSTEM_PROMPT, getSystemPrompt());
        o.put(KEY_BACK_DEPTH, getBackDepth());
        return o;
    }

    public String toJsonString() {
        try {
            return toJson().toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    /**
     * 部分合并（§3.1 setPrefs）：只接受已知字段，未知字段一律忽略。
     *
     * @return 是否有字段被更新
     */
    public boolean applyJson(String json) {
        if (json == null || json.trim().isEmpty()) {
            return false;
        }
        JSONObject in;
        try {
            in = new JSONObject(json);
        } catch (JSONException e) {
            return false;
        }
        SharedPreferences.Editor ed = sp.edit();
        boolean changed = false;

        if (hasValue(in, KEY_API_KEY)) {
            ed.putString(KEY_API_KEY, text(in, KEY_API_KEY, "").trim());
            changed = true;
        }
        if (hasValue(in, KEY_BASE_URL)) {
            String base = text(in, KEY_BASE_URL, "").trim();
            ed.putString(KEY_BASE_URL, base.isEmpty() ? DEFAULT_BASE_URL : base);
            changed = true;
        }
        if (hasValue(in, KEY_MODEL)) {
            String model = text(in, KEY_MODEL, "").trim();
            ed.putString(KEY_MODEL, model.isEmpty() ? DEFAULT_MODEL : model);
            changed = true;
        }
        if (hasValue(in, KEY_TEMPERATURE)) {
            double t = in.optDouble(KEY_TEMPERATURE, Double.NaN);
            if (Double.isNaN(t) || Double.isInfinite(t)) {
                t = Double.parseDouble(DEFAULT_TEMPERATURE_TEXT);
            }
            if (t < 0d) {
                t = 0d;
            }
            if (t > 2d) {
                t = 2d;
            }
            ed.putString(KEY_TEMPERATURE, String.valueOf(t));
            changed = true;
        }
        if (hasValue(in, KEY_MAX_TOKENS)) {
            int max = in.optInt(KEY_MAX_TOKENS, DEFAULT_MAX_TOKENS);
            if (max < 1) {
                max = DEFAULT_MAX_TOKENS;
            }
            if (max > 65536) {
                max = 65536;
            }
            ed.putInt(KEY_MAX_TOKENS, max);
            changed = true;
        }
        if (hasValue(in, KEY_STREAM)) {
            ed.putBoolean(KEY_STREAM, in.optBoolean(KEY_STREAM, DEFAULT_STREAM));
            changed = true;
        }
        if (hasValue(in, KEY_THEME)) {
            String theme = text(in, KEY_THEME, DEFAULT_THEME).trim();
            ed.putString(KEY_THEME, theme.isEmpty() ? DEFAULT_THEME : theme);
            changed = true;
        }
        if (hasValue(in, KEY_SYSTEM_PROMPT)) {
            ed.putString(KEY_SYSTEM_PROMPT, text(in, KEY_SYSTEM_PROMPT, ""));
            changed = true;
        }
        if (changed) {
            ed.apply();
        }
        return changed;
    }

    private static boolean hasValue(JSONObject o, String key) {
        return o.has(key) && !o.isNull(key);
    }

    /** org.json 在 Android 上对 JSON null 调 optString 会得到字符串 "null"，这里统一兜底。 */
    private static String text(JSONObject o, String key, String fallback) {
        if (!hasValue(o, key)) {
            return fallback;
        }
        String v = o.optString(key, fallback);
        return v == null ? fallback : v;
    }
}
