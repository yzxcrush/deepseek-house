package com.deepseekhouse.app.agent;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import com.deepseekhouse.app.Prefs;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;

/**
 * 工作区（SPEC N1「模块四：工作区与文件管理」）。
 *
 * <p>默认根目录 {@code getExternalFilesDir("workspace")}（App 私有外部目录，不需要权限）；
 * 可通过 {@link #setRoot(String)} 切换到 {@code /sdcard/house-workspace} 这类公共目录，
 * 此时需要「所有文件访问权限」（{@code MANAGE_EXTERNAL_STORAGE}，Android 11+）。</p>
 *
 * <p>所有文件操作都先经 {@link PathPolicy} canonical 白名单校验；root 会被持久化到
 * SharedPreferences（{@link Prefs#getWorkspaceRoot()}），App 重启后沿用。</p>
 */
public final class Workspace {

    /** read_file 工具默认上限：256KB。 */
    public static final int MAX_READ_BYTES = 256 * 1024;
    /** 文件树直接预览上限：512KB。 */
    public static final int MAX_PREVIEW_BYTES = 512 * 1024;
    /** write_file 工具上限：1MB。 */
    public static final int MAX_WRITE_BYTES = 1024 * 1024;
    /** 文件树直接写入上限：4MB（用户手动保存，放宽一些）。 */
    public static final int MAX_DIRECT_WRITE_BYTES = 4 * 1024 * 1024;
    /** list_dir 单次最多返回条目数，避免超大目录撑爆事件 JSON。 */
    public static final int MAX_DIR_ENTRIES = 2000;

    private final Context context;
    private final Prefs prefs;

    private volatile PathPolicy policy;
    private volatile File defaultRoot;
    private volatile String lastError;

    public Workspace(Context context) {
        if (context == null) {
            throw new IllegalArgumentException("context == null");
        }
        this.context = context.getApplicationContext();
        this.prefs = new Prefs(this.context);
        init();
    }

    // ------------------------------------------------------------ 初始化 / 根目录

    private void init() {
        File computed = computeDefaultRoot();
        if (computed != null) {
            computed.mkdirs();
        }
        defaultRoot = computed;
        String stored = prefs.getWorkspaceRoot();
        if (stored != null && !stored.trim().isEmpty()) {
            File wanted = new File(stored.trim());
            if (applyRoot(wanted)) {
                return;
            }
            lastError = "上次设置的工作区不可用，已回退到默认目录";
            prefs.setWorkspaceRoot("");
        }
        if (applyRoot(computed)) {
            return;
        }
        // 外部存储完全不可用时退回应用内部存储，保证基础文件工具仍可用
        File fallback = new File(context.getFilesDir(), "workspace");
        fallback.mkdirs();
        defaultRoot = canonical(fallback);
        if (applyRoot(fallback)) {
            lastError = "外部存储不可用，工作区已回退到应用内部存储";
        } else {
            lastError = "无法初始化工作区目录";
        }
    }

    private File computeDefaultRoot() {
        File external = null;
        try {
            external = context.getExternalFilesDir("workspace");
        } catch (Throwable ignored) {
            external = null;
        }
        if (external == null) {
            external = new File(context.getFilesDir(), "workspace");
        }
        return canonical(external);
    }

    private static File canonical(File file) {
        if (file == null) {
            return null;
        }
        try {
            return file.getCanonicalFile();
        } catch (IOException e) {
            return file.getAbsoluteFile();
        }
    }

    /** 应用根目录（canonical）下的实际工作区。 */
    public File root() {
        return policy.root();
    }

    public String rootPath() {
        return policy.rootPath();
    }

    public File defaultRoot() {
        return defaultRoot;
    }

    public String defaultRootPath() {
        return defaultRoot == null ? "" : defaultRoot.getAbsolutePath();
    }

    public boolean isDefaultRoot() {
        try {
            return policy.root().getCanonicalPath().equals(defaultRoot.getCanonicalPath());
        } catch (Throwable t) {
            return false;
        }
    }

    /** 上一次 setWorkspace/初始化失败的原因；成功时为 null。 */
    public String lastError() {
        return lastError;
    }

    public PathPolicy pathPolicy() {
        return policy;
    }

    /** 仅当前进程内切换：创建目录 + 构造新策略；不持久化、不检查权限（调用方负责）。 */
    private boolean applyRoot(File dir) {
        if (dir == null) {
            return false;
        }
        try {
            if (dir.exists() && !dir.isDirectory()) {
                return false;
            }
            if (!dir.exists() && !dir.mkdirs()) {
                return false;
            }
            if (!dir.canWrite()) {
                return false;
            }
            PathPolicy next = new PathPolicy(dir);
            policy = next;
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * SPEC setWorkspace：切换工作区根。
     *
     * <ul>
     *   <li>空字符串 → 恢复默认目录；</li>
     *   <li>必须是绝对路径；</li>
     *   <li>公共存储（{@code /sdcard|/storage/...}）需要 All-Files-Access，未授予时
     *       直接打开系统授权页并返回 false；</li>
     *   <li>失败时不改变当前工作区，原因见 {@link #lastError()}。</li>
     * </ul>
     *
     * @return 是否切换成功
     */
    public synchronized boolean setRoot(String rawPath) {
        String path = rawPath == null ? "" : rawPath.trim();
        if (path.isEmpty()) {
            boolean ok = applyRoot(defaultRoot);
            if (ok) {
                prefs.setWorkspaceRoot("");
                lastError = null;
            } else {
                lastError = "默认工作区不可用：" + defaultRootPath();
            }
            return ok;
        }
        File requested = new File(path);
        if (!requested.isAbsolute()) {
            lastError = "工作区路径必须是绝对路径：" + path;
            return false;
        }
        File dest = canonical(requested);
        if (requiresAllFilesAccess(dest) && !hasAllFilesAccess()) {
            lastError = "切换到公共目录需要「所有文件访问权限」，请在系统设置中授予后重试";
            openAllFilesAccessSettings();
            return false;
        }
        if (!applyRoot(dest)) {
            lastError = "无法使用该工作区目录（请确认目录存在且可写）：" + dest.getAbsolutePath();
            return false;
        }
        prefs.setWorkspaceRoot(dest.getAbsolutePath());
        lastError = null;
        return true;
    }

    // ------------------------------------------------------------ 权限

    /**
     * 是否已获得「所有文件访问权限」。
     * Android 11+ 用 {@link Environment#isExternalStorageManager()}；更低版本返回
     * {@code WRITE_EXTERNAL_STORAGE} 的授予状态（本 App 未声明该权限，因此实际上恒为 false）。
     */
    public boolean hasAllFilesAccess() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                return Environment.isExternalStorageManager();
            }
            return context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 打开系统「所有文件访问权限」页（Android 11+；低版本无对应页面，静默忽略）。 */
    public void openAllFilesAccessSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            return;
        } catch (Throwable ignored) {
            // 部分 ROM 没有 App 专属页面，退回全局页面
        }
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Throwable ignored) {
            // 忽略：无法打开设置页时由调用方把 lastError 展示给用户
        }
    }

    /** 目标目录是否在 App 私有目录之外（= 需要 All-Files-Access）。 */
    public boolean requiresAllFilesAccess(File target) {
        if (target == null) {
            return true;
        }
        try {
            String candidate = target.getCanonicalPath();
            for (File dir : appPrivateDirs()) {
                if (dir == null) {
                    continue;
                }
                String prefix = dir.getCanonicalPath();
                if (candidate.equals(prefix) || candidate.startsWith(prefix + File.separator)) {
                    return false;
                }
            }
            return true;
        } catch (Throwable t) {
            return true;
        }
    }

    private File[] appPrivateDirs() {
        File[] external = null;
        File[] cache = null;
        try {
            external = context.getExternalFilesDirs(null);
        } catch (Throwable ignored) {
            external = null;
        }
        try {
            cache = context.getExternalCacheDirs();
        } catch (Throwable ignored) {
            cache = null;
        }
        return new File[]{
                context.getFilesDir(),
                context.getCacheDir(),
                context.getNoBackupFilesDir(),
                context.getExternalFilesDir(null),
                context.getExternalCacheDir(),
                external == null ? null : external.length > 0 ? external[0] : null,
                cache == null ? null : cache.length > 0 ? cache[0] : null,
        };
    }

    // ------------------------------------------------------------ 信息 / 列目录

    /** SPEC workspaceInfo：{@code {"root","writable","allFilesAccess"}} + 默认根与错误信息。 */
    public String infoJson() {
        JSONObject o = new JSONObject();
        try {
            PathPolicy current = policy;
            o.put("root", current.rootPath());
            o.put("writable", current.root().canWrite());
            o.put("allFilesAccess", hasAllFilesAccess());
            o.put("defaultRoot", defaultRootPath());
            o.put("isDefault", isDefaultRoot());
            String error = lastError;
            if (error != null && !error.isEmpty()) {
                o.put("error", error);
            }
        } catch (JSONException e) {
            return "{\"error\":\"workspaceInfo 失败\"}";
        } catch (Throwable t) {
            return "{\"error\":\"workspaceInfo 失败\"}";
        }
        return o.toString();
    }

    /** SPEC listDir：JSON 数组 [{name,path,isDir,size}]，path 为工作区内相对路径。 */
    public String listDirJson(String rawPath) throws IOException {
        PathPolicy current = policy;
        File dir = current.resolveForRead(rawPath);
        if (!dir.exists()) {
            throw new IOException("目录不存在：" + current.relativePath(dir));
        }
        if (!dir.isDirectory()) {
            throw new IOException("不是目录：" + current.relativePath(dir));
        }
        File[] children = dir.listFiles();
        if (children == null) {
            throw new IOException("无法读取目录：" + current.relativePath(dir));
        }
        Arrays.sort(children, new Comparator<File>() {
            @Override
            public int compare(File a, File b) {
                boolean ad = a.isDirectory();
                boolean bd = b.isDirectory();
                if (ad != bd) {
                    return ad ? -1 : 1;
                }
                return a.getName().toLowerCase(Locale.US)
                        .compareTo(b.getName().toLowerCase(Locale.US));
            }
        });
        JSONArray array = new JSONArray();
        int count = 0;
        for (File child : children) {
            if (count >= MAX_DIR_ENTRIES) {
                break;
            }
            // symlink 可能指向工作区外：canonical 校验不通过的条目不展示
            if (!current.isAllowed(child.getAbsolutePath())) {
                continue;
            }
            try {
                JSONObject item = new JSONObject();
                item.put("name", child.getName());
                item.put("path", current.relativePath(child));
                item.put("isDir", child.isDirectory());
                item.put("size", child.isDirectory() ? 0L : child.length());
                array.put(item);
                count++;
            } catch (JSONException ignored) {
                // 单条失败不影响其余条目
            }
        }
        return array.toString();
    }

    // ------------------------------------------------------------ 读写

    /**
     * 读取工作区内文本文件（UTF-8），最多 {@code maxBytes} 字节，超限截断并附加提示。
     */
    public String readText(String rawPath, int maxBytes) throws IOException {
        PathPolicy current = policy;
        File file = current.resolveForRead(rawPath);
        if (!file.exists()) {
            throw new IOException("文件不存在：" + current.relativePath(file));
        }
        if (file.isDirectory()) {
            throw new IOException("这是一个目录：" + current.relativePath(file));
        }
        if (!file.isFile()) {
            throw new IOException("不是普通文件：" + current.relativePath(file));
        }
        int limit = maxBytes <= 0 ? MAX_READ_BYTES : maxBytes;
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
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // 忽略
                }
            }
        }
        String text = new String(buffer, 0, read, java.nio.charset.StandardCharsets.UTF_8);
        if (length > read) {
            text = text + "\n\n…（已截断：文件 " + length + " 字节，仅读取前 " + read + " 字节）";
        }
        return text;
    }

    /**
     * 覆盖写工作区内文本文件（UTF-8）：自动创建父目录，超过 {@code maxBytes} 拒绝。
     *
     * @return 实际写入的字节数
     */
    public int writeText(String rawPath, String content, int maxBytes) throws IOException {
        if (rawPath == null || rawPath.trim().isEmpty()) {
            throw new IOException("缺少文件路径");
        }
        PathPolicy current = policy;
        File file = current.resolveForWrite(rawPath);
        if (file.isDirectory()) {
            throw new IOException("目标是一个目录：" + current.relativePath(file));
        }
        String text = content == null ? "" : content;
        byte[] bytes = text.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        int limit = maxBytes <= 0 ? MAX_WRITE_BYTES : maxBytes;
        if (bytes.length > limit) {
            throw new IOException("内容过大（" + bytes.length + " 字节，上限 " + limit + " 字节）");
        }
        File parent = file.getParentFile();
        if (parent != null) {
            if (!parent.exists() && !parent.mkdirs()) {
                throw new IOException("无法创建父目录：" + current.relativePath(parent));
            }
            if (!current.isAllowed(parent.getAbsolutePath())) {
                throw new IOException("父目录越出工作区：" + parent.getAbsolutePath());
            }
        }
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(file, false);
            out.write(bytes);
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
        return bytes.length;
    }

    /** 工作区内路径的展示形式（相对根；根为 "."）。 */
    public String displayPath(String rawPath) {
        try {
            return policy.relativePath(policy.resolve(rawPath));
        } catch (Throwable t) {
            return rawPath == null ? "" : rawPath;
        }
    }

}
