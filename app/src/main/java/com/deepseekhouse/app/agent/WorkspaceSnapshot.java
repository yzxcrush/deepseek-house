package com.deepseekhouse.app.agent;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

/**
 * 工作区快照 / 差异 / 恢复（ROADMAP 批次 2 · v2.7.0）。
 *
 * <p>快照目录：{@code filesDir/snapshots/<ts>/}：</p>
 * <pre>
 * snapshots/&lt;id&gt;/manifest.json        {id,createdAt,reason,files:[{path,size,sha256}]}
 * snapshots/&lt;id&gt;/data/&lt;relative path&gt;  工作区文件副本（放在 data/ 下避免与 manifest.json 重名）
 * </pre>
 *
 * <p>限制：单文件 ≤4MB、单次快照总量 ≤200MB、最多 5000 个文件；跳过超限文件并在结果里计数。
 * 最多保留 10 个快照（按 createdAt 新→旧，超出删除最旧）。</p>
 *
 * <p>线程：JsBridge 方法需要同步返回 JSON，因此把文件 IO 提交到单线程后台执行器再
 * {@code Future.get(timeout)} 等待结果（WebView 的 JS 桥线程可以被阻塞，不会卡 UI 主线程）。
 * 内部 {@code coreXxx} 静态方法为纯文件操作，便于 JVM 单测。</p>
 */
public final class WorkspaceSnapshot {

    public static final String DIR_NAME = "snapshots";
    public static final int MAX_SNAPSHOTS = 10;
    public static final long MAX_FILE_BYTES = 4L * 1024 * 1024;
    public static final long MAX_TOTAL_BYTES = 200L * 1024 * 1024;
    public static final int MAX_FILES = 5000;
    public static final int MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
    private static final int MAX_DEPTH = 64;
    private static final long CREATE_TIMEOUT_MS = 180 * 1000L;
    private static final long RESTORE_TIMEOUT_MS = 300 * 1000L;
    private static final long READ_TIMEOUT_MS = 120 * 1000L;

    private static final Pattern SNAPSHOT_ID = Pattern.compile("^[0-9]{10,20}(?:-[0-9]{1,3})?$");
    private static final String EMPTY_OBJECT = "{\"ok\":false,\"error\":\"快照操作失败\"}";

    private final Workspace workspace;
    private final File snapshotsRoot;
    private final ExecutorService io;

    public WorkspaceSnapshot(Context context, Workspace workspace) {
        if (context == null || workspace == null) {
            throw new IllegalArgumentException("context/workspace == null");
        }
        this.workspace = workspace;
        File filesDir;
        try {
            filesDir = context.getApplicationContext().getFilesDir();
        } catch (Throwable t) {
            filesDir = context.getFilesDir();
        }
        this.snapshotsRoot = new File(filesDir == null ? context.getFilesDir() : filesDir, DIR_NAME);
        this.io = Executors.newSingleThreadExecutor(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "dsh-snapshot-io");
                t.setDaemon(true);
                return t;
            }
        });
    }

    /** 当前快照根目录（filesDir/snapshots）。 */
    public File snapshotsRoot() {
        return snapshotsRoot;
    }

    public void close() {
        try {
            io.shutdownNow();
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    // ------------------------------------------------------------ JsBridge 用的同步包装

    /** 创建快照；返回 {"ok":true,"id":..,"createdAt":..,"reason":..,"fileCount":..,"size":..,"skipped":..}。 */
    public String create(String reason) {
        final File root = currentWorkspaceRoot();
        final String safeReason = sanitizeReason(reason);
        return run(EMPTY_OBJECT, CREATE_TIMEOUT_MS, new Callable<String>() {
            @Override
            public String call() {
                return coreCreate(root, snapshotsRoot, safeReason);
            }
        });
    }

    /** 快照列表 JSON 数组 [{id,createdAt,reason,fileCount,size}]（新→旧）。 */
    public String list() {
        return run("[]", READ_TIMEOUT_MS, new Callable<String>() {
            @Override
            public String call() {
                return coreList(snapshotsRoot);
            }
        });
    }

    /** 与当前工作区比较：JSON 数组 [{path,status,sizeBefore,sizeAfter}]。 */
    public String diff(String id) {
        final File root = currentWorkspaceRoot();
        final String safeId = id == null ? "" : id.trim();
        return run("[]", READ_TIMEOUT_MS, new Callable<String>() {
            @Override
            public String call() {
                return coreDiff(root, snapshotsRoot, safeId);
            }
        });
    }

    /** 恢复快照（恢复前先自动为当前状态创建 safety 快照）。 */
    public String restore(String id) {
        final File root = currentWorkspaceRoot();
        final String safeId = id == null ? "" : id.trim();
        return run(EMPTY_OBJECT, RESTORE_TIMEOUT_MS, new Callable<String>() {
            @Override
            public String call() {
                return coreRestore(root, snapshotsRoot, safeId);
            }
        });
    }

    /** 删除全部快照。 */
    public String clear() {
        return run(EMPTY_OBJECT, READ_TIMEOUT_MS, new Callable<String>() {
            @Override
            public String call() {
                return coreClear(snapshotsRoot);
            }
        });
    }

    private File currentWorkspaceRoot() {
        try {
            return workspace.root();
        } catch (Throwable t) {
            return null;
        }
    }

    private String run(String fallback, long timeoutMs, Callable<String> task) {
        Future<String> future = null;
        try {
            future = io.submit(task);
            String result = future.get(timeoutMs, TimeUnit.MILLISECONDS);
            return result == null ? fallback : result;
        } catch (TimeoutException e) {
            if (future != null) {
                future.cancel(true);
            }
            return "{\"ok\":false,\"error\":\"快照操作超时\"}";
        } catch (Throwable t) {
            if (future != null) {
                future.cancel(true);
            }
            return fallback;
        }
    }

    private static String sanitizeReason(String reason) {
        String value = reason == null ? "" : reason.trim();
        if (value.isEmpty()) {
            return "manual";
        }
        if (value.length() > 200) {
            value = value.substring(0, 200);
        }
        return value;
    }

    // ------------------------------------------------------------ 核心（纯文件操作，JVM 可测）

    /** 创建快照。工作区根为空/不可用时返回 {"ok":false,...}。 */
    static String coreCreate(File workspaceRoot, File snapshotsRoot, String reason) {
        return coreCreate(workspaceRoot, snapshotsRoot, reason, "");
    }

    /**
     * 创建快照；{@code excludeId} 指定一个必须保留的快照 id（恢复时保护被恢复的快照不被
     * 保留上限清理掉）。
     */
    static String coreCreate(File workspaceRoot, File snapshotsRoot, String reason,
                             String excludeId) {
        try {
            PathPolicy policy = newPolicy(workspaceRoot);
            if (policy == null) {
                return error("工作区不可用");
            }
            if (snapshotsRoot == null) {
                return error("快照目录不可用");
            }
            if (!snapshotsRoot.isDirectory() && !snapshotsRoot.mkdirs()) {
                return error("无法创建快照目录");
            }
            long createdAt = System.currentTimeMillis();
            String id = nextSnapshotId(snapshotsRoot, createdAt);
            File snapshotDir = new File(snapshotsRoot, id);
            if (!snapshotDir.mkdirs()) {
                return error("无法创建快照目录：" + id);
            }
            File dataDir = new File(snapshotDir, "data");
            if (!dataDir.mkdirs()) {
                deleteRecursively(snapshotDir);
                return error("无法创建快照数据目录");
            }
            File snapshotsCanonical = canonical(snapshotsRoot);
            List<File> files = new ArrayList<>();
            List<String> paths = new ArrayList<>();
            long[] total = new long[]{0L};
            int[] skipped = new int[]{0};
            Set<String> visitedDirs = new HashSet<>();
            Set<String> visitedFiles = new HashSet<>();
            walk(workspaceRoot, workspaceRoot, policy, snapshotsCanonical,
                    files, paths, visitedDirs, visitedFiles, total, skipped, 0);

            JSONArray manifestFiles = new JSONArray();
            byte[] buffer = new byte[64 * 1024];
            int copied = 0;
            for (int i = 0; i < files.size(); i++) {
                File source = files.get(i);
                String relative = paths.get(i);
                File dest = new File(dataDir, relative);
                File parent = dest.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                    skipped[0]++;
                    continue;
                }
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long size = copyWithHash(source, dest, digest, buffer);
                if (size < 0) {
                    skipped[0]++;
                    //noinspection ResultOfMethodCallIgnored
                    dest.delete();
                    continue;
                }
                JSONObject entry = new JSONObject();
                entry.put("path", relative);
                entry.put("size", size);
                entry.put("sha256", toHex(digest.digest()));
                manifestFiles.put(entry);
                copied++;
            }

            JSONObject manifest = new JSONObject();
            manifest.put("id", id);
            manifest.put("createdAt", createdAt);
            manifest.put("reason", reason == null ? "" : reason);
            manifest.put("files", manifestFiles);
            if (!writeManifest(snapshotDir, manifest)) {
                deleteRecursively(snapshotDir);
                return error("写入快照 manifest 失败");
            }
            pruneOldSnapshots(snapshotsRoot, excludeId);
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("id", id);
            result.put("createdAt", createdAt);
            result.put("reason", reason == null ? "" : reason);
            result.put("fileCount", copied);
            result.put("size", total[0]);
            result.put("skipped", skipped[0]);
            return result.toString();
        } catch (Throwable t) {
            return error("快照失败：" + message(t));
        }
    }

    /** 快照列表。 */
    static String coreList(File snapshotsRoot) {
        JSONArray array = new JSONArray();
        try {
            List<JSONObject> items = listManifests(snapshotsRoot);
            Collections.sort(items, new Comparator<JSONObject>() {
                @Override
                public int compare(JSONObject a, JSONObject b) {
                    long left = a.optLong("createdAt", 0L);
                    long right = b.optLong("createdAt", 0L);
                    if (left == right) {
                        return b.optString("id", "").compareTo(a.optString("id", ""));
                    }
                    return Long.compare(right, left);
                }
            });
            for (JSONObject item : items) {
                JSONObject out = new JSONObject();
                out.put("id", item.optString("id", ""));
                out.put("createdAt", item.optLong("createdAt", 0L));
                out.put("reason", item.optString("reason", ""));
                JSONArray files = item.optJSONArray("files");
                out.put("fileCount", files == null ? 0 : files.length());
                long size = 0L;
                if (files != null) {
                    for (int i = 0; i < files.length(); i++) {
                        JSONObject file = files.optJSONObject(i);
                        if (file != null) {
                            size += file.optLong("size", 0L);
                        }
                    }
                }
                out.put("size", size);
                array.put(out);
            }
        } catch (Throwable ignored) {
            // 返回已收集部分
        }
        return array.toString();
    }

    /** 与当前工作区比较差异。 */
    static String coreDiff(File workspaceRoot, File snapshotsRoot, String id) {
        JSONArray array = new JSONArray();
        try {
            if (!isValidSnapshotId(id)) {
                return "[]";
            }
            File snapshotDir = snapshotDir(snapshotsRoot, id);
            JSONObject manifest = readManifest(snapshotDir);
            if (manifest == null) {
                return "[]";
            }
            PathPolicy policy = newPolicy(workspaceRoot);
            if (policy == null) {
                return "[]";
            }
            Set<String> before = new HashSet<>();
            JSONArray beforeFiles = manifest.optJSONArray("files");
            java.util.Map<String, JSONObject> beforeMap = new java.util.LinkedHashMap<>();
            if (beforeFiles != null) {
                for (int i = 0; i < beforeFiles.length(); i++) {
                    JSONObject entry = beforeFiles.optJSONObject(i);
                    if (entry == null) {
                        continue;
                    }
                    String path = normalizeRelative(entry.optString("path", ""));
                    if (path.isEmpty() || !before.add(path)) {
                        continue;
                    }
                    beforeMap.put(path, entry);
                }
            }
            File snapshotsCanonical = canonical(snapshotsRoot);
            List<File> files = new ArrayList<>();
            List<String> paths = new ArrayList<>();
            long[] total = new long[]{0L};
            int[] skipped = new int[]{0};
            walk(workspaceRoot, workspaceRoot, policy, snapshotsCanonical,
                    files, paths, new HashSet<String>(), new HashSet<String>(),
                    total, skipped, 0);
            Set<String> after = new HashSet<>();
            byte[] buffer = new byte[64 * 1024];
            for (int i = 0; i < files.size(); i++) {
                String path = paths.get(i);
                if (path.isEmpty() || !after.add(path)) {
                    continue;
                }
                File source = files.get(i);
                long sizeNow = source.length();
                JSONObject beforeEntry = beforeMap.get(path);
                String shaNow = sha256(source, buffer);
                if (beforeEntry == null) {
                    JSONObject item = new JSONObject();
                    item.put("path", path);
                    item.put("status", "added");
                    item.put("sizeBefore", 0L);
                    item.put("sizeAfter", sizeNow);
                    array.put(item);
                } else {
                    long sizeBefore = beforeEntry.optLong("size", 0L);
                    String shaBefore = beforeEntry.optString("sha256", "");
                    if (!shaNow.equals(shaBefore) || sizeNow != sizeBefore) {
                        JSONObject item = new JSONObject();
                        item.put("path", path);
                        item.put("status", "modified");
                        item.put("sizeBefore", sizeBefore);
                        item.put("sizeAfter", sizeNow);
                        array.put(item);
                    }
                }
            }
            for (String path : before) {
                if (after.contains(path)) {
                    continue;
                }
                JSONObject beforeEntry = beforeMap.get(path);
                JSONObject item = new JSONObject();
                item.put("path", path);
                item.put("status", "deleted");
                item.put("sizeBefore", beforeEntry == null ? 0L : beforeEntry.optLong("size", 0L));
                item.put("sizeAfter", 0L);
                array.put(item);
            }
        } catch (Throwable ignored) {
            // 返回已收集部分
        }
        return array.toString();
    }

    /** 恢复快照；恢复前自动创建 safety 快照（失败则中止恢复，保护当前状态）。 */
    static String coreRestore(File workspaceRoot, File snapshotsRoot, String id) {
        try {
            if (!isValidSnapshotId(id)) {
                return error("快照 id 不合法");
            }
            File snapshotDir = snapshotDir(snapshotsRoot, id);
            JSONObject manifest = readManifest(snapshotDir);
            if (manifest == null) {
                return error("快照不存在：" + id);
            }
            String safetyId = "";
            try {
                String safetyJson = coreCreate(workspaceRoot, snapshotsRoot,
                        "safety-before-restore", id);
                JSONObject safety = new JSONObject(safetyJson);
                if (!safety.optBoolean("ok", false)) {
                    return error("无法创建安全快照，已中止恢复："
                            + safety.optString("error", "未知错误"));
                }
                safetyId = safety.optString("id", "");
            } catch (Throwable t) {
                return error("无法创建安全快照，已中止恢复：" + message(t));
            }
            PathPolicy policy = newPolicy(workspaceRoot);
            if (policy == null) {
                return error("工作区不可用");
            }
            File dataDir = new File(snapshotDir, "data");
            JSONArray files = manifest.optJSONArray("files");
            int restored = 0;
            int failed = 0;
            byte[] buffer = new byte[64 * 1024];
            if (files != null) {
                for (int i = 0; i < files.length(); i++) {
                    JSONObject entry = files.optJSONObject(i);
                    if (entry == null) {
                        continue;
                    }
                    String relative = normalizeRelative(entry.optString("path", ""));
                    String expectedSha = entry.optString("sha256", "");
                    if (relative.isEmpty()) {
                        failed++;
                        continue;
                    }
                    File source = new File(dataDir, relative);
                    if (!source.isFile()) {
                        failed++;
                        continue;
                    }
                    try {
                        File dest = policy.resolveForWrite(relative);
                        File parent = dest.getParentFile();
                        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                            failed++;
                            continue;
                        }
                        MessageDigest digest = MessageDigest.getInstance("SHA-256");
                        long written = copyWithHash(source, dest, digest, buffer);
                        if (written < 0) {
                            failed++;
                            continue;
                        }
                        String sha = toHex(digest.digest());
                        if (!expectedSha.isEmpty() && !expectedSha.equals(sha)) {
                            failed++;
                            continue;
                        }
                        restored++;
                    } catch (SecurityException e) {
                        failed++;
                    } catch (Throwable t) {
                        failed++;
                    }
                }
            }
            JSONObject result = new JSONObject();
            result.put("ok", failed == 0);
            result.put("id", id);
            result.put("restored", restored);
            result.put("failed", failed);
            result.put("safetySnapshotId", safetyId);
            if (failed > 0) {
                result.put("warning", "部分文件恢复失败（" + failed + " 个），可重试或从 safety 快照恢复");
            }
            return result.toString();
        } catch (Throwable t) {
            return error("恢复失败：" + message(t));
        }
    }

    /** 删除全部快照。 */
    static String coreClear(File snapshotsRoot) {
        try {
            int removed = 0;
            for (File dir : listSnapshotDirs(snapshotsRoot)) {
                if (deleteRecursively(dir)) {
                    removed++;
                }
            }
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("removed", removed);
            return result.toString();
        } catch (Throwable t) {
            return error("清理失败：" + message(t));
        }
    }

    // ------------------------------------------------------------ 遍历 / 拷贝

    private static void walk(File file, File root, PathPolicy policy, File snapshotsCanonical,
                             List<File> outFiles, List<String> outPaths,
                             Set<String> visitedDirs, Set<String> visitedFiles,
                             long[] total, int[] skipped, int depth) {
        if (depth > MAX_DEPTH || file == null || policy == null) {
            return;
        }
        File[] children = file.listFiles();
        if (children == null) {
            return;
        }
        Arrays.sort(children, new Comparator<File>() {
            @Override
            public int compare(File a, File b) {
                return a.getName().compareToIgnoreCase(b.getName());
            }
        });
        for (File child : children) {
            if (child == null) {
                continue;
            }
            File canonical = canonical(child);
            if (canonical == null || !policy.isUnderRoot(canonical)) {
                continue;
            }
            if (snapshotsCanonical != null) {
                String candidate = canonical.getAbsolutePath();
                String snapshotsPath = snapshotsCanonical.getAbsolutePath();
                if (candidate.equals(snapshotsPath)
                        || candidate.startsWith(snapshotsPath + File.separator)) {
                    continue; // 避免把快照目录本身再快照进去
                }
            }
            if (canonical.isDirectory()) {
                String dirKey = canonical.getAbsolutePath();
                if (!visitedDirs.add(dirKey)) {
                    continue;
                }
                walk(canonical, root, policy, snapshotsCanonical, outFiles, outPaths,
                        visitedDirs, visitedFiles, total, skipped, depth + 1);
                continue;
            }
            if (!canonical.isFile()) {
                continue;
            }
            String relative = policy.relativePath(canonical);
            if (relative.isEmpty() || ".".equals(relative) || !visitedFiles.add(relative)) {
                continue;
            }
            long size = canonical.length();
            if (size < 0 || size > MAX_FILE_BYTES || total[0] + size > MAX_TOTAL_BYTES
                    || outFiles.size() >= MAX_FILES) {
                skipped[0]++;
                continue;
            }
            outFiles.add(canonical);
            outPaths.add(relative);
            total[0] += size;
        }
    }

    private static long copyWithHash(File source, File dest, MessageDigest digest, byte[] buffer) {
        FileInputStream in = null;
        FileOutputStream out = null;
        try {
            long total = 0L;
            in = new FileInputStream(source);
            out = new FileOutputStream(dest, false);
            int n;
            while ((n = in.read(buffer)) >= 0) {
                out.write(buffer, 0, n);
                if (digest != null) {
                    digest.update(buffer, 0, n);
                }
                total += n;
            }
            out.flush();
            return total;
        } catch (Throwable t) {
            return -1L;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // 忽略
                }
            }
            if (out != null) {
                try {
                    out.close();
                } catch (IOException ignored) {
                    // 忽略
                }
            }
        }
    }

    private static String sha256(File file, byte[] buffer) {
        FileInputStream in = null;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            in = new FileInputStream(file);
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

    // ------------------------------------------------------------ manifest / 目录

    private static JSONObject readManifest(File snapshotDir) {
        if (snapshotDir == null || !snapshotDir.isDirectory()) {
            return null;
        }
        File manifest = new File(snapshotDir, "manifest.json");
        if (!manifest.isFile() || manifest.length() > MAX_MANIFEST_BYTES) {
            return null;
        }
        FileInputStream in = null;
        try {
            in = new FileInputStream(manifest);
            byte[] data = new byte[(int) manifest.length()];
            int read = 0;
            int n;
            while (read < data.length) {
                n = in.read(data, read, data.length - read);
                if (n < 0) {
                    break;
                }
                read += n;
            }
            JSONObject object = new JSONObject(new String(data, 0, read, StandardCharsets.UTF_8));
            return object;
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
    }

    private static boolean writeManifest(File snapshotDir, JSONObject manifest) {
        File file = new File(snapshotDir, "manifest.json");
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(file, false);
            out.write(manifest.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();
            return true;
        } catch (Throwable t) {
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

    private static String nextSnapshotId(File snapshotsRoot, long createdAt) {
        String base = String.valueOf(createdAt);
        File candidate = new File(snapshotsRoot, base);
        if (!candidate.exists()) {
            return base;
        }
        for (int i = 1; i < 1000; i++) {
            String id = base + "-" + i;
            if (!new File(snapshotsRoot, id).exists()) {
                return id;
            }
        }
        return base + "-" + (System.nanoTime() % 1000);
    }

    private static void pruneOldSnapshots(File snapshotsRoot, String excludeId) {
        try {
            final List<File> dirs = listSnapshotDirs(snapshotsRoot);
            final java.util.Map<File, Long> created = new java.util.HashMap<>();
            for (File dir : dirs) {
                JSONObject manifest = readManifest(dir);
                long ts = manifest == null ? 0L : manifest.optLong("createdAt", 0L);
                if (ts <= 0L) {
                    ts = parseIdTimestamp(dir.getName());
                }
                created.put(dir, ts);
            }
            Collections.sort(dirs, new Comparator<File>() {
                @Override
                public int compare(File a, File b) {
                    long left = created.containsKey(a) ? created.get(a) : 0L;
                    long right = created.containsKey(b) ? created.get(b) : 0L;
                    if (left == right) {
                        return b.getName().compareTo(a.getName());
                    }
                    return Long.compare(right, left);
                }
            });
            String protectedId = excludeId == null ? "" : excludeId;
            for (int i = 0; i < dirs.size(); i++) {
                File dir = dirs.get(i);
                boolean keep = i < MAX_SNAPSHOTS || dir.getName().equals(protectedId);
                if (!keep) {
                    deleteRecursively(dir);
                }
            }
        } catch (Throwable ignored) {
            // 清理失败不影响本次快照
        }
    }

    private static long parseIdTimestamp(String id) {
        try {
            int dash = id.indexOf('-');
            String value = dash > 0 ? id.substring(0, dash) : id;
            return Long.parseLong(value);
        } catch (Throwable t) {
            return 0L;
        }
    }

    private static List<JSONObject> listManifests(File snapshotsRoot) {
        List<JSONObject> items = new ArrayList<>();
        for (File dir : listSnapshotDirs(snapshotsRoot)) {
            JSONObject manifest = readManifest(dir);
            if (manifest == null) {
                continue;
            }
            if (manifest.optString("id", "").isEmpty()) {
                try {
                    manifest.put("id", dir.getName());
                } catch (JSONException ignored) {
                    // 忽略
                }
            }
            items.add(manifest);
        }
        return items;
    }

    private static List<File> listSnapshotDirs(File snapshotsRoot) {
        List<File> dirs = new ArrayList<>();
        if (snapshotsRoot == null) {
            return dirs;
        }
        File[] children;
        try {
            children = snapshotsRoot.listFiles();
        } catch (Throwable t) {
            return dirs;
        }
        if (children == null) {
            return dirs;
        }
        for (File child : children) {
            if (child != null && child.isDirectory() && isValidSnapshotId(child.getName())) {
                dirs.add(child);
            }
        }
        return dirs;
    }

    private static File snapshotDir(File snapshotsRoot, String id) {
        if (snapshotsRoot == null || !isValidSnapshotId(id)) {
            return null;
        }
        File dir = new File(snapshotsRoot, id);
        File canonical;
        try {
            canonical = dir.getCanonicalFile();
            File rootCanonical = snapshotsRoot.getCanonicalFile();
            if (!canonical.getAbsolutePath().startsWith(
                    rootCanonical.getAbsolutePath() + File.separator)) {
                return null;
            }
        } catch (Throwable t) {
            return null;
        }
        return canonical;
    }

    static boolean isValidSnapshotId(String id) {
        return id != null && SNAPSHOT_ID.matcher(id.trim()).matches();
    }

    // ------------------------------------------------------------ 小工具

    private static PathPolicy newPolicy(File workspaceRoot) {
        if (workspaceRoot == null) {
            return null;
        }
        try {
            if (!workspaceRoot.isDirectory()) {
                return null;
            }
            return new PathPolicy(workspaceRoot);
        } catch (Throwable t) {
            return null;
        }
    }

    private static File canonical(File file) {
        if (file == null) {
            return null;
        }
        try {
            return file.getCanonicalFile();
        } catch (Throwable t) {
            return file.getAbsoluteFile();
        }
    }

    private static boolean deleteRecursively(File file) {
        if (file == null) {
            return false;
        }
        try {
            if (file.isDirectory()) {
                File[] children = file.listFiles();
                if (children != null) {
                    for (File child : children) {
                        deleteRecursively(child);
                    }
                }
            }
            return file.delete() || !file.exists();
        } catch (Throwable t) {
            return false;
        }
    }

    private static String normalizeRelative(String path) {
        if (path == null) {
            return "";
        }
        String value = path.trim().replace('\\', '/');
        while (value.startsWith("./")) {
            value = value.substring(2);
        }
        if (value.startsWith("/") || value.isEmpty()) {
            return "";
        }
        String[] segments = value.split("/");
        for (String segment : segments) {
            if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment)) {
                return "";
            }
        }
        return value;
    }

    private static String error(String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false);
            o.put("error", message == null ? "未知错误" : message);
        } catch (JSONException ignored) {
            return EMPTY_OBJECT;
        }
        return o.toString();
    }

    private static String message(Throwable t) {
        if (t == null) {
            return "未知错误";
        }
        String message = t.getMessage();
        return message == null || message.trim().isEmpty()
                ? t.getClass().getSimpleName() : message;
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
