package com.deepseekhouse.app;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 插件文件存储。
 *
 * <p>目录结构：{@code getFilesDir()/plugins/} 下 {@code index.json} 保存元数据，
 * {@code <id>.js} 保存插件源码。SAF 的导入/导出通过 ContentResolver 完成。</p>
 */
public final class PluginStore {

    private static final String DIR_NAME = "plugins";
    private static final String INDEX_FILE = "index.json";
    private static final String SUFFIX = ".js";
    private static final int MAX_TEXT_BYTES = 4 * 1024 * 1024;

    private final Context ctx;
    private final File dir;

    public PluginStore(Context context) {
        this.ctx = context.getApplicationContext();
        this.dir = new File(this.ctx.getFilesDir(), DIR_NAME);
        ensureDir();
    }

    public File getDir() {
        return dir;
    }

    private void ensureDir() {
        if (!dir.isDirectory()) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
    }

    // ------------------------------------------------------------ 列表 / 读写

    /** §3.1 pluginsList(): [{"id","name","version","author","description","enabled","fileName"}] */
    public synchronized String listJson() {
        JSONArray out = new JSONArray();
        JSONArray index = readIndex();
        for (int i = 0; i < index.length(); i++) {
            JSONObject entry = index.optJSONObject(i);
            if (entry == null) {
                continue;
            }
            String id = text(entry, "id", "");
            if (!isValidId(id)) {
                continue;
            }
            File file = fileFor(id);
            if (!file.isFile()) {
                continue; // 源文件已被删除，列表里不再展示
            }
            JSONObject item = new JSONObject();
            try {
                item.put("id", id);
                item.put("name", defaultIfEmpty(text(entry, "name", ""), id));
                item.put("version", defaultIfEmpty(text(entry, "version", ""), "1.0.0"));
                item.put("author", text(entry, "author", ""));
                item.put("description", text(entry, "description", ""));
                item.put("enabled", !entry.has("enabled") || entry.isNull("enabled")
                        || entry.optBoolean("enabled", true));
                item.put("fileName", id + SUFFIX);
            } catch (JSONException ignored) {
                continue;
            }
            out.put(item);
        }
        return out.toString();
    }

    /** 读取插件源码；不存在返回 null。 */
    public synchronized String read(String id) {
        if (!isValidId(id)) {
            return null;
        }
        File file = fileFor(id);
        if (!file.isFile()) {
            return null;
        }
        return readFileText(file);
    }

    /** 写入（覆盖）插件源码并更新 index.json。 */
    public synchronized boolean write(String id, String code, String metaJson) {
        if (!isValidId(id)) {
            return false;
        }
        ensureDir();
        File file = fileFor(id);
        if (!writeFileText(file, code == null ? "" : code)) {
            return false;
        }
        JSONObject meta = null;
        if (metaJson != null && !metaJson.trim().isEmpty()) {
            try {
                meta = new JSONObject(metaJson);
            } catch (JSONException ignored) {
                meta = null;
            }
        }
        JSONArray index = readIndex();
        int at = indexOf(index, id);
        JSONObject entry = at >= 0 ? index.optJSONObject(at) : null;
        if (entry == null) {
            entry = new JSONObject();
            try {
                entry.put("enabled", true);
            } catch (JSONException ignored) {
                // 不会发生：put(String, boolean) 只在 key 为 null 时抛
            }
        }
        try {
            entry.put("id", id);
            entry.put("name", defaultIfEmpty(meta == null ? "" : text(meta, "name", ""), id));
            entry.put("version", defaultIfEmpty(meta == null ? "" : text(meta, "version", ""), "1.0.0"));
            entry.put("author", meta == null ? "" : text(meta, "author", ""));
            entry.put("description", meta == null ? "" : text(meta, "description", ""));
            entry.put("fileName", id + SUFFIX);
            if (at >= 0) {
                index.put(at, entry);
            } else {
                index.put(entry);
            }
        } catch (JSONException ignored) {
            return false;
        }
        writeIndex(index);
        return true;
    }

    /** 删除插件文件与索引项。 */
    public synchronized boolean delete(String id) {
        if (!isValidId(id)) {
            return false;
        }
        File file = fileFor(id);
        boolean deleted = true;
        if (file.isFile()) {
            deleted = file.delete();
        }
        JSONArray index = readIndex();
        JSONArray next = new JSONArray();
        for (int i = 0; i < index.length(); i++) {
            JSONObject entry = index.optJSONObject(i);
            if (entry == null) {
                continue;
            }
            if (id.equals(text(entry, "id", ""))) {
                continue; // 已被删除，跳过
            }
            next.put(entry);
        }
        writeIndex(next);
        return deleted;
    }

    /** 启用/禁用插件（仅改 index.json）。 */
    public synchronized boolean setEnabled(String id, boolean enabled) {
        if (!isValidId(id)) {
            return false;
        }
        JSONArray index = readIndex();
        int at = indexOf(index, id);
        if (at < 0) {
            return false;
        }
        JSONObject entry = index.optJSONObject(at);
        if (entry == null) {
            return false;
        }
        try {
            entry.put("enabled", enabled);
            index.put(at, entry);
        } catch (JSONException ignored) {
            return false;
        }
        writeIndex(index);
        return true;
    }

    // ------------------------------------------------------------ SAF 导入 / 导出

    public String displayName(Uri uri) {
        if (uri == null) {
            return null;
        }
        Cursor cursor = null;
        try {
            cursor = ctx.getContentResolver().query(
                    uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int col = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (col >= 0) {
                    String name = cursor.getString(col);
                    if (name != null && !name.trim().isEmpty()) {
                        return name.trim();
                    }
                }
            }
        } catch (Throwable ignored) {
            // 查询失败时退回默认文件名
        } finally {
            if (cursor != null) {
                try {
                    cursor.close();
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        }
        String last = uri.getLastPathSegment();
        return last == null || last.trim().isEmpty() ? null : last.trim();
    }

    public String readTextFromUri(Uri uri) throws IOException {
        if (uri == null) {
            throw new IOException("未选择文件");
        }
        InputStream in = ctx.getContentResolver().openInputStream(uri);
        if (in == null) {
            throw new IOException("无法打开所选文件");
        }
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int total = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > MAX_TEXT_BYTES) {
                    throw new IOException("文件过大（超过 4MB）");
                }
                bos.write(buf, 0, n);
            }
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
                // 忽略
            }
        }
    }

    public void writeTextToUri(Uri uri, String text) throws IOException {
        if (uri == null) {
            throw new IOException("未选择保存位置");
        }
        OutputStream out = null;
        try {
            out = ctx.getContentResolver().openOutputStream(uri, "wt");
            if (out == null) {
                out = ctx.getContentResolver().openOutputStream(uri);
            }
            if (out == null) {
                throw new IOException("无法写入所选位置");
            }
            out.write((text == null ? "" : text).getBytes(StandardCharsets.UTF_8));
            out.flush();
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (IOException ignored) {
                    // 忽略
                }
            }
        }
    }

    // ------------------------------------------------------------ 内部工具

    private File fileFor(String id) {
        return new File(dir, id + SUFFIX);
    }

    /** 只允许安全字符，避免路径穿越。插件 id 建议形如 "user.foo"。 */
    public static boolean isValidId(String id) {
        if (id == null) {
            return false;
        }
        String v = id.trim();
        if (v.isEmpty() || v.length() > 64) {
            return false;
        }
        if (v.equals(".") || v.equals("..")) {
            return false;
        }
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
            if (!ok) {
                return false;
            }
        }
        return true;
    }

    /** 把任意字符串清洗为合法 id 片段；全无可用字符时返回空串。 */
    public static String sanitizeId(String raw) {
        if (raw == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < raw.length() && sb.length() < 64; i++) {
            char c = raw.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
            sb.append(ok ? c : '_');
        }
        String out = sb.toString().replaceAll("\\.+", ".").replaceAll("^[._-]+", "");
        return out;
    }

    private static int indexOf(JSONArray index, String id) {
        for (int i = 0; i < index.length(); i++) {
            JSONObject entry = index.optJSONObject(i);
            if (entry != null && id.equals(text(entry, "id", ""))) {
                return i;
            }
        }
        return -1;
    }

    private JSONArray readIndex() {
        File file = new File(dir, INDEX_FILE);
        if (!file.isFile()) {
            return new JSONArray();
        }
        String raw = readFileText(file);
        if (raw == null || raw.trim().isEmpty()) {
            return new JSONArray();
        }
        try {
            return new JSONArray(raw);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    /** 先写临时文件再改名，尽量避免 index.json 写一半损坏。 */
    private void writeIndex(JSONArray index) {
        File tmp = new File(dir, INDEX_FILE + ".tmp");
        if (!writeFileText(tmp, index.toString())) {
            return;
        }
        File target = new File(dir, INDEX_FILE);
        if (target.exists() && !target.delete()) {
            return;
        }
        //noinspection ResultOfMethodCallIgnored
        tmp.renameTo(target);
    }

    private static String readFileText(File file) {
        FileInputStream in = null;
        try {
            in = new FileInputStream(file);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) {
                bos.write(buf, 0, n);
                if (bos.size() > MAX_TEXT_BYTES) {
                    return null;
                }
            }
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException e) {
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
    }

    private static boolean writeFileText(File file, String text) {
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(file);
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.flush();
            return true;
        } catch (IOException e) {
            return false;
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (IOException ignored) {
                    // 忽略
                }
            }
        }
    }

    private static String text(JSONObject o, String key, String fallback) {
        if (o == null || !o.has(key) || o.isNull(key)) {
            return fallback;
        }
        String v = o.optString(key, fallback);
        return v == null ? fallback : v;
    }

    private static String defaultIfEmpty(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }
}
