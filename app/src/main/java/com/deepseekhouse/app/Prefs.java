package com.deepseekhouse.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
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
    /** ARCH v2 P2：MCP 服务器配置 JSON 数组 [{id,name,url,token,enabled}]。 */
    public static final String KEY_MCP_SERVERS = "mcpServers";
    /** ARCH v2 P3：house-plugins 目录插件的 enabled 状态（JSON 对象 fileName→bool）。 */
    public static final String KEY_PLUGIN_ENABLED = "housePluginEnabled";
    /** v3.0.0：Bot 配置 JSON 数组 [{id,type,name,enabled,token,accessToken,baseUrl,...}]。 */
    public static final String KEY_BOTS = "bots";
    /** v3.3.0：多 API Key JSON 数组 [{id,name,apiKey,baseUrl,model?,enabled,createdAt}]（≤20）。 */
    public static final String KEY_API_KEYS = "apiKeys";
    /** v3.3.0：默认 API Key id。 */
    public static final String KEY_DEFAULT_KEY_ID = "defaultKeyId";
    /** v3.3.0：人设 JSON 数组 [{id,name,emoji,avatarDataUrl?,systemPrompt,...}]。 */
    public static final String KEY_PERSONAS = "personas";

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

    // ---------------------------------------------------------------- v3.0.0 Bot 配置

    /** Bot 配置原始 JSON 数组；缺省 "[]"。token/accessToken 仅在此与原生层出现，不写日志。 */
    public String getBotsJson() {
        String value = sp.getString(KEY_BOTS, "[]");
        return value == null || value.trim().isEmpty() ? "[]" : value;
    }

    public void setBotsJson(String json) {
        String value = json == null || json.trim().isEmpty() ? "[]" : json.trim();
        sp.edit().putString(KEY_BOTS, value).apply();
    }

    // ---------------------------------------------------------------- v3.3.0 多 API Key / 人设

    /**
     * 多 Key 数组 JSON。首次访问时把旧 {@code apiKey/baseUrl} 迁移成 id="default" 的一条
     * （无旧 Key 时写入 "[]"）。apiKey 明文只存在 SharedPreferences，不写日志。
     */
    public synchronized String getApiKeysJson() {
        try {
            if (!sp.contains(KEY_API_KEYS)) {
                JSONArray array = new JSONArray();
                String legacyKey = getApiKey();
                if (legacyKey != null && !legacyKey.trim().isEmpty()) {
                    JSONObject item = new JSONObject();
                    item.put("id", "default");
                    item.put("name", "默认");
                    item.put("apiKey", legacyKey.trim());
                    item.put("baseUrl", getBaseUrl());
                    item.put("enabled", true);
                    item.put("createdAt", System.currentTimeMillis());
                    array.put(item);
                    sp.edit().putString(KEY_API_KEYS, array.toString())
                            .putString(KEY_DEFAULT_KEY_ID, "default").apply();
                } else {
                    sp.edit().putString(KEY_API_KEYS, "[]").apply();
                }
            }
            String raw = sp.getString(KEY_API_KEYS, "[]");
            if (raw == null || raw.trim().isEmpty()) {
                return "[]";
            }
            // 数组为空但旧 apiKey 有值（例如旧版登录流程刚 setPrefs 完）→ 补迁移一条 default
            try {
                JSONArray current = new JSONArray(raw);
                if (current.length() == 0) {
                    String legacyKey = getApiKey();
                    if (legacyKey != null && !legacyKey.trim().isEmpty()) {
                        JSONObject item = new JSONObject();
                        item.put("id", "default");
                        item.put("name", "默认");
                        item.put("apiKey", legacyKey.trim());
                        item.put("baseUrl", getBaseUrl());
                        item.put("enabled", true);
                        item.put("createdAt", System.currentTimeMillis());
                        current.put(item);
                        sp.edit().putString(KEY_API_KEYS, current.toString())
                                .putString(KEY_DEFAULT_KEY_ID, "default").apply();
                        return current.toString();
                    }
                }
            } catch (Throwable ignored) {
                // 忽略
            }
            return raw;
        } catch (Throwable t) {
            return "[]";
        }
    }

    public void setApiKeysJson(String json) {
        String value = json == null || json.trim().isEmpty() ? "[]" : json.trim();
        sp.edit().putString(KEY_API_KEYS, value).apply();
    }

    /** 默认 Key id；未设置但数组非空时自动取第一条。 */
    public String getDefaultKeyId() {
        try {
            String stored = sp.getString(KEY_DEFAULT_KEY_ID, "");
            if (stored != null && !stored.trim().isEmpty()) {
                return stored.trim();
            }
            JSONArray array = new JSONArray(getApiKeysJson());
            if (array.length() > 0) {
                JSONObject first = array.optJSONObject(0);
                String id = first == null ? "" : first.optString("id", "");
                if (!id.isEmpty()) {
                    sp.edit().putString(KEY_DEFAULT_KEY_ID, id).apply();
                    return id;
                }
            }
        } catch (Throwable ignored) {
            // 忽略
        }
        return "";
    }

    public void setDefaultKeyId(String id) {
        sp.edit().putString(KEY_DEFAULT_KEY_ID, id == null ? "" : id.trim()).apply();
    }

    /** 默认 Key 条目（不存在返回 null）。 */
    public JSONObject findDefaultApiKey() {
        try {
            JSONArray array = new JSONArray(getApiKeysJson());
            String defaultId = getDefaultKeyId();
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item != null && item.optString("id", "").equals(defaultId)) {
                    return item;
                }
            }
        } catch (Throwable ignored) {
            // 忽略
        }
        return null;
    }

    /** 把默认 Key 的 apiKey/baseUrl 同步回旧字段（保证 getPrefs/老流程兼容）。 */
    public void syncLegacyFromDefaultKey() {
        try {
            JSONObject entry = findDefaultApiKey();
            if (entry == null) {
                return;
            }
            String apiKey = entry.optString("apiKey", "");
            String baseUrl = entry.optString("baseUrl", "");
            if (baseUrl == null || baseUrl.trim().isEmpty()) {
                baseUrl = DEFAULT_BASE_URL;
            }
            sp.edit().putString(KEY_API_KEY, apiKey == null ? "" : apiKey.trim())
                    .putString(KEY_BASE_URL, baseUrl.trim()).apply();
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    /** 旧代码 setPrefs({apiKey,baseUrl}) 时同步写回默认 Key 条目（数组尚未初始化则留给迁移）。 */
    public void syncDefaultKeyFromLegacy() {
        try {
            if (!sp.contains(KEY_API_KEYS)) {
                return;
            }
            JSONArray array = new JSONArray(getApiKeysJson());
            if (array.length() == 0) {
                // 旧 apiKey 在数组为空时补一条 default（保持老登录流程可用）
                String legacyKey = getApiKey();
                if (legacyKey != null && !legacyKey.trim().isEmpty()) {
                    JSONObject item = new JSONObject();
                    item.put("id", "default");
                    item.put("name", "默认");
                    item.put("apiKey", legacyKey.trim());
                    item.put("baseUrl", getBaseUrl());
                    item.put("enabled", true);
                    item.put("createdAt", System.currentTimeMillis());
                    array.put(item);
                    prefsSetKeysAndDefault(array);
                }
                return;
            }
            String defaultId = getDefaultKeyId();
            JSONObject target = null;
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item != null && item.optString("id", "").equals(defaultId)) {
                    target = item;
                    break;
                }
            }
            if (target == null) {
                target = array.optJSONObject(0);
                if (target != null) {
                    setDefaultKeyId(target.optString("id", ""));
                }
            }
            if (target == null) {
                return;
            }
            try {
                target.put("apiKey", getApiKey());
                target.put("baseUrl", getBaseUrl());
            } catch (JSONException ignored) {
                return;
            }
            sp.edit().putString(KEY_API_KEYS, array.toString()).apply();
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    private void prefsSetKeysAndDefault(JSONArray array) {
        try {
            sp.edit().putString(KEY_API_KEYS, array == null ? "[]" : array.toString())
                    .putString(KEY_DEFAULT_KEY_ID, "default").apply();
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    /** 删除全部 Key 后清掉旧字段（让旧登录流程回到未登录态）。 */
    public void clearLegacyApiKey() {
        sp.edit().putString(KEY_API_KEY, "")
                .putString(KEY_BASE_URL, DEFAULT_BASE_URL).apply();
    }

    /** 人设数组 JSON（原生只负责持久化，业务在 JS）。 */
    public String getPersonasJson() {
        String value = sp.getString(KEY_PERSONAS, "[]");
        return value == null || value.trim().isEmpty() ? "[]" : value;
    }

    public void setPersonasJson(String json) {
        String value = json == null || json.trim().isEmpty() ? "[]" : json.trim();
        sp.edit().putString(KEY_PERSONAS, value).apply();
    }

    // ---------------------------------------------------------------- 写

    public void setApiKey(String value) {
        sp.edit().putString(KEY_API_KEY, value == null ? "" : value.trim()).apply();
        syncDefaultKeyFromLegacy();
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
            if (hasValue(in, KEY_API_KEY) || hasValue(in, KEY_BASE_URL)) {
                syncDefaultKeyFromLegacy();
            }
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
