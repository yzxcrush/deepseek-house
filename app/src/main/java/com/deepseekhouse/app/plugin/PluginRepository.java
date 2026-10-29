package com.deepseekhouse.app.plugin;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.Toast;

import com.deepseekhouse.app.Prefs;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * P3 插件目录（SPEC「ARCH v2 P3」N3，包 com.deepseekhouse.app.plugin）。
 *
 * <p>目录：</p>
 * <ul>
 *   <li>app：{@code getExternalFilesDir("house-plugins")}（默认，无需权限，可写；不可用时回退
 *       {@code filesDir/house-plugins}）；</li>
 *   <li>sdcard：{@code /sdcard/house-plugins}（可选，只读扫描；不存在/无权限时忽略）。</li>
 * </ul>
 *
 * <p>安全：文件名白名单（仅 .js/.json、≤128 字符、禁止 {@code / \ NUL ..} 与隐藏文件）；
 * 读写上限 512KB；{@link #write} / {@link #delete} 只允许 app 目录。</p>
 *
 * <p>列表项 JSON：{@code {id,name,version,author,fileName,size,sha256,source,enabled}}，
 * source ∈ {@code "app"|"sdcard"}；enabled 持久化在 {@link Prefs#getPluginEnabledJson()}
 * （fileName → bool，未记录默认 true）。</p>
 */
public final class PluginRepository {

    public static final int MAX_FILE_BYTES = 512 * 1024;
    public static final int MAX_FILE_NAME_CHARS = 128;
    public static final long MAX_SCAN_BYTES = 2L * 1024 * 1024;

    public static final String SOURCE_APP = "app";
    public static final String SOURCE_SDCARD = "sdcard";

    private static final String DIR_NAME = "house-plugins";
    private static final String SDCARD_DIR = "/sdcard/house-plugins";
    private static final int META_HEAD_BYTES = 32 * 1024;

    /** 市场签名内置密钥（HMAC-SHA256）；仅用于 App 与官方索引之间的完整性校验。 */
    private static final byte[] HMAC_KEY = new byte[]{
            (byte) 0xD5, (byte) 0x48, (byte) 0x6F, (byte) 0x75,
            (byte) 0x73, (byte) 0x65, (byte) 0x2D, (byte) 0x50,
            (byte) 0x6C, (byte) 0x75, (byte) 0x67, (byte) 0x69,
            (byte) 0x6E, (byte) 0x2D, (byte) 0x48, (byte) 0x4D,
            (byte) 0x41, (byte) 0x43, (byte) 0x2D, (byte) 0x76,
            (byte) 0x32, (byte) 0x30, (byte) 0x32, (byte) 0x36
    };

    private static final Pattern VERSION_SUFFIX = Pattern.compile(
            "^(.*?)-v?(\\d+(?:\\.\\d+){1,3}(?:[-+][0-9A-Za-z.]+)?)$");

    private final Context context;
    private final Prefs prefs;
    private final File appDir;
    private final File sdcardDir;

    public PluginRepository(Context context) {
        if (context == null) {
            throw new IllegalArgumentException("context == null");
        }
        this.context = context.getApplicationContext();
        this.prefs = new Prefs(this.context);
        this.appDir = resolveAppDir(this.context);
        this.sdcardDir = new File(SDCARD_DIR);
        ensureAppDir();
    }

    private static File resolveAppDir(Context context) {
        File external = null;
        try {
            external = context.getExternalFilesDir(DIR_NAME);
        } catch (Throwable ignored) {
            external = null;
        }
        if (external == null) {
            external = new File(context.getFilesDir(), DIR_NAME);
        }
        return external;
    }

    private void ensureAppDir() {
        try {
            if (!appDir.isDirectory()) {
                //noinspection ResultOfMethodCallIgnored
                appDir.mkdirs();
            }
        } catch (Throwable ignored) {
            // 目录不可用时不阻塞后续调用（写会返回 false）
        }
    }

    public File appDir() {
        return appDir;
    }

    public File sdcardDir() {
        return sdcardDir;
    }

    // ------------------------------------------------------------ 文件名 / 安全校验

    /** 文件名白名单：仅 .js/.json、无路径分隔符、非隐藏、不含 ".."、长度 ≤128。 */
    public static boolean isValidFileName(String raw) {
        if (raw == null) {
            return false;
        }
        String name = raw.trim();
        if (name.isEmpty() || name.length() > MAX_FILE_NAME_CHARS) {
            return false;
        }
        if (name.charAt(0) == '.') {
            return false;
        }
        if (name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || name.indexOf('\u0000') >= 0) {
            return false;
        }
        if (name.contains("..")) {
            return false;
        }
        String lower = name.toLowerCase(Locale.US);
        return lower.endsWith(".js") || lower.endsWith(".json");
    }

    /** 从文件名推断 id/version（形如 {@code my-plugin-1.0.0.js} → id=my-plugin, version=1.0.0）。 */
    static String[] fallbackIdAndVersion(String fileName) {
        String base = fileName == null ? "" : fileName.trim();
        int dot = base.lastIndexOf('.');
        if (dot > 0) {
            base = base.substring(0, dot);
        }
        String version = "";
        Matcher matcher = VERSION_SUFFIX.matcher(base);
        if (matcher.matches()) {
            base = matcher.group(1);
            version = matcher.group(2);
        }
        String id = sanitizeId(base);
        if (id.isEmpty()) {
            id = base.isEmpty() ? "plugin" : base;
        }
        return new String[]{id, version};
    }

    /** 插件 id 只保留 [A-Za-z0-9._-]，其余替换为 '_'，最长 64 字符。 */
    static String sanitizeId(String raw) {
        if (raw == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        String text = raw.trim();
        for (int i = 0; i < text.length() && sb.length() < 64; i++) {
            char c = text.charAt(i);
            boolean allowed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
            sb.append(allowed ? c : '_');
        }
        return sb.toString();
    }

    // ------------------------------------------------------------ 列表

    /** SPEC pluginList：JSON 数组字符串（按 fileName 排序；app 与 sdcard 同名时 app 优先）。 */
    public String listJson() {
        JSONArray array = new JSONArray();
        try {
            JSONObject enabledMap = loadEnabledMap();
            Set<String> seen = new HashSet<>();
            List<JSONObject> items = new ArrayList<>();
            for (File file : listPluginFiles(appDir)) {
                JSONObject item = entryFor(file, SOURCE_APP, enabledMap);
                if (item != null && seen.add(file.getName())) {
                    items.add(item);
                }
            }
            for (File file : listPluginFiles(sdcardDir)) {
                if (seen.contains(file.getName())) {
                    continue;
                }
                JSONObject item = entryFor(file, SOURCE_SDCARD, enabledMap);
                if (item != null && seen.add(file.getName())) {
                    items.add(item);
                }
            }
            Collections.sort(items, new Comparator<JSONObject>() {
                @Override
                public int compare(JSONObject a, JSONObject b) {
                    return a.optString("fileName", "")
                            .compareToIgnoreCase(b.optString("fileName", ""));
                }
            });
            for (JSONObject item : items) {
                array.put(item);
            }
        } catch (Throwable ignored) {
            // 列表失败返回 []（JS 侧显示空）
        }
        return array.toString();
    }

    private static List<File> listPluginFiles(File dir) {
        List<File> out = new ArrayList<>();
        if (dir == null) {
            return out;
        }
        try {
            if (!dir.isDirectory() || !dir.canRead()) {
                return out;
            }
            File[] files = dir.listFiles();
            if (files == null) {
                return out;
            }
            for (File file : files) {
                if (file != null && file.isFile() && isValidFileName(file.getName())) {
                    out.add(file);
                }
            }
        } catch (Throwable ignored) {
            // 直接忽略该来源
        }
        return out;
    }

    private JSONObject entryFor(File file, String source, JSONObject enabledMap) {
        try {
            String fileName = file.getName();
            long size = file.length();
            String id = "";
            String name = "";
            String version = "";
            String author = "";
            String lower = fileName.toLowerCase(Locale.US);
            if (lower.endsWith(".json") && size <= MAX_SCAN_BYTES) {
                JSONObject meta = readJsonMeta(file);
                id = meta.optString("id", "");
                name = meta.optString("name", "");
                version = meta.optString("version", "");
                author = meta.optString("author", "");
            } else if (size <= MAX_SCAN_BYTES) {
                JSONObject meta = readJsMeta(file);
                id = meta.optString("id", "");
                name = meta.optString("name", "");
                version = meta.optString("version", "");
                author = meta.optString("author", "");
            }
            if (id.isEmpty() || version.isEmpty()) {
                String[] fallback = fallbackIdAndVersion(fileName);
                if (id.isEmpty()) {
                    id = fallback[0];
                }
                if (version.isEmpty()) {
                    version = fallback[1];
                }
            }
            if (name.isEmpty()) {
                name = id;
            }
            JSONObject item = new JSONObject();
            item.put("id", id);
            item.put("name", name);
            item.put("version", version);
            item.put("author", author);
            item.put("fileName", fileName);
            item.put("size", size);
            item.put("sha256", sha256(file));
            item.put("source", source);
            item.put("enabled", enabledFor(fileName, enabledMap));
            return item;
        } catch (Throwable t) {
            return null;
        }
    }

    private static JSONObject readJsonMeta(File file) {
        JSONObject result = new JSONObject();
        try {
            String text = readFileText(file, MAX_FILE_BYTES);
            if (text == null || text.trim().isEmpty()) {
                return result;
            }
            JSONObject obj = new JSONObject(text);
            JSONObject meta = obj.optJSONObject("manifest");
            if (meta == null) {
                meta = obj.optJSONObject("plugin");
            }
            if (meta == null) {
                meta = obj;
            }
            copyString(meta, result, "id");
            copyString(meta, result, "name");
            copyString(meta, result, "version");
            copyString(meta, result, "author");
        } catch (Throwable ignored) {
            // 非法 JSON → 回退文件名
        }
        return result;
    }

    private static JSONObject readJsMeta(File file) {
        JSONObject result = new JSONObject();
        try {
            String head = readFileText(file, META_HEAD_BYTES);
            if (head == null) {
                return result;
            }
            String[] lines = head.split("\n", 400);
            for (String line : lines) {
                String text = line == null ? "" : line.trim();
                if (text.startsWith("//")) {
                    text = text.substring(2).trim();
                } else if (text.startsWith("/*")) {
                    text = text.substring(2).trim();
                } else if (text.startsWith("*")) {
                    text = text.substring(1).trim();
                } else {
                    continue;
                }
                if (!text.startsWith("@")) {
                    continue;
                }
                int split = indexOfWhitespace(text);
                if (split <= 1) {
                    continue;
                }
                String key = text.substring(1, split).trim().toLowerCase(Locale.US);
                String value = text.substring(split).trim();
                if (value.endsWith("*/")) {
                    value = value.substring(0, value.length() - 2).trim();
                }
                if (value.length() > 200) {
                    value = value.substring(0, 200).trim();
                }
                if (("id".equals(key) || "name".equals(key)
                        || "version".equals(key) || "author".equals(key))
                        && !result.has(key) && !value.isEmpty()) {
                    try {
                        result.put(key, value);
                    } catch (JSONException ignored) {
                        // 忽略
                    }
                }
            }
        } catch (Throwable ignored) {
            // 回退文件名
        }
        return result;
    }

    private static int indexOfWhitespace(String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
                return i;
            }
        }
        return -1;
    }

    private static void copyString(JSONObject from, JSONObject to, String key) {
        try {
            if (from != null && from.has(key) && !from.isNull(key)) {
                String value = from.optString(key, "").trim();
                if (!value.isEmpty()) {
                    to.put(key, value.length() > 200 ? value.substring(0, 200) : value);
                }
            }
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    // ------------------------------------------------------------ 读 / 写 / 删

    /**
     * 读取插件源码（app 目录优先，其次 sdcard）：文件名非法/不存在/超过 512KB 返回 null。
     * JsBridge 会把 null 转成空串。
     */
    public String read(String fileName) {
        String name = safeName(fileName);
        if (name == null) {
            return null;
        }
        File file = findFile(name);
        if (file == null || !file.isFile() || file.length() > MAX_FILE_BYTES) {
            return null;
        }
        return readFileText(file, MAX_FILE_BYTES);
    }

    /** 写入 app 插件目录（仅 .js/.json，≤512KB）；成功 true。 */
    public boolean write(String fileName, String content) {
        String name = safeName(fileName);
        if (name == null) {
            return false;
        }
        String text = content == null ? "" : content;
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_FILE_BYTES) {
            return false;
        }
        ensureAppDir();
        if (!appDir.isDirectory()) {
            return false;
        }
        File target = new File(appDir, name);
        File temp = new File(appDir, "." + name + ".writing");
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(temp, false);
            out.write(bytes);
            out.flush();
            out.close();
            out = null;
            if (target.exists() && !target.delete()) {
                // 个别文件系统 delete 失败时直接覆盖写
                FileOutputStream direct = new FileOutputStream(target, false);
                try {
                    direct.write(bytes);
                    direct.flush();
                } finally {
                    direct.close();
                }
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
                return true;
            }
            if (!temp.renameTo(target)) {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
                return false;
            }
            // 重新安装/更新时保持已有 enabled 状态；新文件默认 enabled=true
            return true;
        } catch (Throwable t) {
            try {
                if (out != null) {
                    out.close();
                }
            } catch (Throwable ignored) {
                // 忽略
            }
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
            return false;
        }
    }

    /** 删除 app 目录插件（sdcard 只读，不删）；成功 true。 */
    public boolean delete(String fileName) {
        String name = safeName(fileName);
        if (name == null) {
            return false;
        }
        try {
            File file = new File(appDir, name);
            boolean deleted = file.isFile() && file.delete();
            if (deleted) {
                JSONObject enabledMap = loadEnabledMap();
                enabledMap.remove(name);
                saveEnabledMap(enabledMap);
            }
            return deleted;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 设置 enabled（app/sdcard 中存在的文件均可），持久化到 Prefs；成功 true。 */
    public boolean setEnabled(String fileName, boolean enabled) {
        String name = safeName(fileName);
        if (name == null) {
            return false;
        }
        if (findFile(name) == null) {
            return false;
        }
        try {
            JSONObject enabledMap = loadEnabledMap();
            enabledMap.put(name, enabled);
            saveEnabledMap(enabledMap);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 该文件当前是否启用（未记录默认 true）。 */
    public boolean isEnabled(String fileName) {
        String name = safeName(fileName);
        if (name == null) {
            return false;
        }
        return enabledFor(name, loadEnabledMap());
    }

    // ------------------------------------------------------------ 摘要 / 签名

    /** HMAC-SHA256(内置 key, content) 小写 hex；失败返回空串。 */
    public String hmac(String content) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(HMAC_KEY, "HmacSHA256"));
            byte[] digest = mac.doFinal((content == null ? "" : content)
                    .getBytes(StandardCharsets.UTF_8));
            return toHex(digest);
        } catch (Throwable t) {
            return "";
        }
    }

    /** SHA-256(content) 小写 hex；失败返回空串（市场校验用，避免依赖 WebCrypto）。 */
    public String sha256Of(String content) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return toHex(digest.digest((content == null ? "" : content)
                    .getBytes(StandardCharsets.UTF_8)));
        } catch (Throwable t) {
            return "";
        }
    }

    // ------------------------------------------------------------ 打开目录

    /**
     * 打开系统文件管理器到 app 插件目录（best-effort）。
     * API 24+ 对 file:// Uri 有 FileUriExposed 限制，失败时把路径复制到剪贴板并 Toast 提示。
     */
    public void openDir(Context hostContext) {
        File dir = appDir;
        try {
            ensureAppDir();
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(Uri.fromFile(dir), "resource/folder");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            (hostContext == null ? context : hostContext).startActivity(intent);
            return;
        } catch (Throwable ignored) {
            // 继续尝试无 MIME 的 ACTION_VIEW
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setData(Uri.fromFile(dir));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            (hostContext == null ? context : hostContext).startActivity(intent);
            return;
        } catch (Throwable ignored) {
            // 回退：剪贴板 + Toast
        }
        String path = dir == null ? "" : dir.getAbsolutePath();
        try {
            ClipboardManager manager = (ClipboardManager)
                    context.getSystemService(Context.CLIPBOARD_SERVICE);
            if (manager != null && !path.isEmpty()) {
                manager.setPrimaryClip(ClipData.newPlainText("插件目录", path));
            }
        } catch (Throwable ignored) {
            // 忽略
        }
        try {
            Toast.makeText(context, "插件目录：" + path, Toast.LENGTH_LONG).show();
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    // ------------------------------------------------------------ 内部工具

    private String safeName(String raw) {
        String name = raw == null ? "" : raw.trim();
        return isValidFileName(name) ? name : null;
    }

    private File findFile(String fileName) {
        try {
            File app = new File(appDir, fileName);
            if (app.isFile()) {
                return app;
            }
            File sd = new File(sdcardDir, fileName);
            if (sd.isFile() && sd.canRead()) {
                return sd;
            }
        } catch (Throwable ignored) {
            // 忽略
        }
        return null;
    }

    private JSONObject loadEnabledMap() {
        try {
            String raw = prefs.getPluginEnabledJson();
            if (raw == null || raw.trim().isEmpty()) {
                return new JSONObject();
            }
            return new JSONObject(raw);
        } catch (Throwable t) {
            return new JSONObject();
        }
    }

    private void saveEnabledMap(JSONObject map) {
        try {
            prefs.setPluginEnabledJson(map == null ? "{}" : map.toString());
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    private static boolean enabledFor(String fileName, JSONObject enabledMap) {
        try {
            if (enabledMap != null && enabledMap.has(fileName) && !enabledMap.isNull(fileName)) {
                return enabledMap.optBoolean(fileName, true);
            }
        } catch (Throwable ignored) {
            // 忽略
        }
        return true;
    }

    private static String readFileText(File file, int maxBytes) {
        if (file == null || !file.isFile()) {
            return null;
        }
        int limit = maxBytes <= 0 ? MAX_FILE_BYTES : maxBytes;
        long length = file.length();
        int want = (int) Math.min(length, (long) limit);
        byte[] buffer = new byte[want];
        int read = 0;
        FileInputStream in = null;
        try {
            in = new FileInputStream(file);
            while (read < want) {
                int n = in.read(buffer, read, want - read);
                if (n < 0) {
                    break;
                }
                read += n;
            }
        } catch (Throwable t) {
            return null;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // 忽略
                }
            }
        }
        return new String(buffer, 0, read, StandardCharsets.UTF_8);
    }

    private static String sha256(File file) {
        if (file == null || !file.isFile()) {
            return "";
        }
        InputStream in = null;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            in = new FileInputStream(file);
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) >= 0) {
                digest.update(buffer, 0, n);
            }
            return toHex(digest.digest());
        } catch (Throwable t) {
            return "";
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // 忽略
                }
            }
        }
    }

    private static String toHex(byte[] bytes) {
        if (bytes == null) {
            return "";
        }
        char[] hex = "0123456789abcdef".toCharArray();
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            int value = bytes[i] & 0xFF;
            out[i * 2] = hex[value >>> 4];
            out[i * 2 + 1] = hex[value & 0x0F];
        }
        return new String(out);
    }
}
