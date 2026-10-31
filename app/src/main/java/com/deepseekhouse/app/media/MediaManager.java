package com.deepseekhouse.app.media;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * 批次 3（v2.8.0）原生小能力：壁纸存取 + 图片保存到相册。
 *
 * <ul>
 *   <li>壁纸：{@code filesDir/wallpaper/wallpaper.jpg}（JPEG，≤4MB），
 *       附带 {@code wallpaper.name} 保存用户可读名称；</li>
 *   <li>保存图片：API 29+ 写 MediaStore {@code Pictures/DeepSeekHouse}（无需存储权限）；
 *       API 24–28 兜底写 {@code getExternalFilesDir("Pictures")}（App 私有外部目录，无需权限）。</li>
 * </ul>
 *
 * <p>线程：所有 IO 提交到单线程后台执行器再 {@code Future.get(timeout)} 同步等待，
 * 阻塞的是 WebView JS 桥线程，不是 UI 主线程。内部 {@code coreXxx} 为纯文件/纯算法实现，
 * 便于 JVM 单测。</p>
 */
public final class MediaManager {

    public static final int MAX_WALLPAPER_BYTES = 4 * 1024 * 1024;
    /** saveImage 解码后上限（长截图可能较大，仍做保护）。 */
    public static final int MAX_IMAGE_BYTES = 24 * 1024 * 1024;

    private static final String WALLPAPER_DIR = "wallpaper";
    private static final String WALLPAPER_FILE = "wallpaper.jpg";
    private static final String WALLPAPER_NAME_FILE = "wallpaper.name";
    private static final String ALBUM_DIR = "DeepSeekHouse";
    private static final String DATA_URL_PREFIX = "data:image/jpeg;base64,";

    private static final long WALLPAPER_TIMEOUT_MS = 60 * 1000L;
    private static final long IMAGE_TIMEOUT_MS = 150 * 1000L;

    private static final char[] BASE64_TABLE =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

    private final Context context;
    private final File wallpaperDir;
    private final ExecutorService io;

    public MediaManager(Context context) {
        if (context == null) {
            throw new IllegalArgumentException("context == null");
        }
        this.context = context.getApplicationContext();
        this.wallpaperDir = new File(this.context.getFilesDir(), WALLPAPER_DIR);
        this.io = Executors.newSingleThreadExecutor(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "dsh-media-io");
                t.setDaemon(true);
                return t;
            }
        });
    }

    public File wallpaperDir() {
        return wallpaperDir;
    }

    public void close() {
        try {
            io.shutdownNow();
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    // ------------------------------------------------------------ 公开同步包装（JsBridge 调用）

    /** saveWallpaper：data URL 或纯 base64 均可；成功 {"ok":true,"path","size"}。 */
    public String saveWallpaper(final String base64Jpeg, final String name) {
        final File dir = wallpaperDir;
        return run(errorJson("壁纸保存失败"), WALLPAPER_TIMEOUT_MS, new Callable<String>() {
            @Override
            public String call() {
                return coreSaveWallpaper(dir, base64Jpeg, name);
            }
        });
    }

    /** getWallpaper：{"ok":true,"dataUrl":"data:image/jpeg;base64,..."}；无壁纸 dataUrl=""。 */
    public String getWallpaper() {
        final File dir = wallpaperDir;
        return run(errorJson("壁纸读取失败"), WALLPAPER_TIMEOUT_MS, new Callable<String>() {
            @Override
            public String call() {
                return coreGetWallpaper(dir);
            }
        });
    }

    /** clearWallpaper：{"ok":true,"removed":bool}。 */
    public String clearWallpaper() {
        final File dir = wallpaperDir;
        return run(errorJson("壁纸清理失败"), WALLPAPER_TIMEOUT_MS, new Callable<String>() {
            @Override
            public String call() {
                return coreClearWallpaper(dir);
            }
        });
    }

    /** wallpaperInfo：{hasWallpaper,path,size,name,updatedAt}。 */
    public String wallpaperInfo() {
        final File dir = wallpaperDir;
        return run(errorJson("壁纸信息读取失败"), WALLPAPER_TIMEOUT_MS, new Callable<String>() {
            @Override
            public String call() {
                return coreWallpaperInfo(dir);
            }
        });
    }

    /** saveImage：dataUrl → MediaStore/应用相册目录；{"ok":true,"uri","path"}。 */
    public String saveImage(final String dataUrl, final String fileName) {
        final Context ctx = context;
        return run(errorJson("图片保存失败"), IMAGE_TIMEOUT_MS, new Callable<String>() {
            @Override
            public String call() {
                return coreSaveImage(ctx, dataUrl, fileName);
            }
        });
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
            return errorJson("图片/壁纸操作超时");
        } catch (Throwable t) {
            if (future != null) {
                future.cancel(true);
            }
            return fallback;
        }
    }

    // ------------------------------------------------------------ 壁纸核心（纯文件，JVM 可测）

    static String coreSaveWallpaper(File dir, String base64Jpeg, String name) {
        try {
            if (dir == null) {
                return errorJson("壁纸目录不可用");
            }
            String payload = extractBase64Payload(base64Jpeg);
            if (payload == null || payload.isEmpty()) {
                return errorJson("壁纸数据为空");
            }
            byte[] bytes = decodeBase64(payload);
            if (bytes == null) {
                return errorJson("壁纸 base64 解码失败");
            }
            if (bytes.length == 0) {
                return errorJson("壁纸数据为空");
            }
            if (bytes.length > MAX_WALLPAPER_BYTES) {
                return errorJson("壁纸超过 4MB 上限（" + bytes.length + " 字节）");
            }
            if (!isJpeg(bytes)) {
                return errorJson("壁纸必须是 JPEG 图片（data:image/jpeg;base64）");
            }
            if (!dir.isDirectory() && !dir.mkdirs()) {
                return errorJson("无法创建壁纸目录");
            }
            File target = new File(dir, WALLPAPER_FILE);
            File temp = new File(dir, WALLPAPER_FILE + ".writing");
            FileOutputStream out = null;
            try {
                out = new FileOutputStream(temp, false);
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
            } else if (!temp.renameTo(target)) {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
                return errorJson("壁纸写入失败");
            }
            writeWallpaperName(dir, name);
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("path", target.getAbsolutePath());
            result.put("size", bytes.length);
            return result.toString();
        } catch (Throwable t) {
            return errorJson("壁纸保存失败：" + message(t));
        }
    }

    static String coreGetWallpaper(File dir) {
        try {
            JSONObject result = new JSONObject();
            result.put("ok", true);
            if (dir == null) {
                result.put("dataUrl", "");
                return result.toString();
            }
            File file = new File(dir, WALLPAPER_FILE);
            if (!file.isFile() || file.length() <= 0L) {
                result.put("dataUrl", "");
                return result.toString();
            }
            if (file.length() > MAX_WALLPAPER_BYTES) {
                return errorJson("壁纸文件超过 4MB 上限");
            }
            byte[] bytes = readAll(file, (int) file.length());
            if (bytes == null) {
                return errorJson("壁纸读取失败");
            }
            result.put("dataUrl", DATA_URL_PREFIX + encodeBase64(bytes));
            result.put("size", bytes.length);
            String name = readWallpaperName(dir);
            if (!name.isEmpty()) {
                result.put("name", name);
            }
            return result.toString();
        } catch (Throwable t) {
            return errorJson("壁纸读取失败：" + message(t));
        }
    }

    static String coreClearWallpaper(File dir) {
        try {
            JSONObject result = new JSONObject();
            boolean removed = false;
            if (dir != null && dir.isDirectory()) {
                File file = new File(dir, WALLPAPER_FILE);
                if (file.isFile()) {
                    removed = file.delete();
                }
                File nameFile = new File(dir, WALLPAPER_NAME_FILE);
                if (nameFile.isFile()) {
                    //noinspection ResultOfMethodCallIgnored
                    nameFile.delete();
                }
            }
            result.put("ok", true);
            result.put("removed", removed);
            return result.toString();
        } catch (Throwable t) {
            return errorJson("壁纸清理失败：" + message(t));
        }
    }

    static String coreWallpaperInfo(File dir) {
        try {
            JSONObject result = new JSONObject();
            boolean has = false;
            long size = 0L;
            long updatedAt = 0L;
            String path = "";
            File file = dir == null ? null : new File(dir, WALLPAPER_FILE);
            if (file != null && file.isFile() && file.length() > 0L) {
                has = true;
                size = file.length();
                updatedAt = file.lastModified();
                path = file.getAbsolutePath();
            }
            result.put("ok", true);
            result.put("hasWallpaper", has);
            result.put("path", path);
            result.put("size", size);
            result.put("name", has ? readWallpaperName(dir) : "");
            result.put("updatedAt", updatedAt);
            return result.toString();
        } catch (Throwable t) {
            return errorJson("壁纸信息读取失败：" + message(t));
        }
    }

    private static void writeWallpaperName(File dir, String name) {
        try {
            File file = new File(dir, WALLPAPER_NAME_FILE);
            String safe = sanitizeWallpaperName(name);
            if (safe.isEmpty()) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                return;
            }
            FileOutputStream out = new FileOutputStream(file, false);
            try {
                out.write(safe.getBytes(StandardCharsets.UTF_8));
                out.flush();
            } finally {
                out.close();
            }
        } catch (Throwable ignored) {
            // 名称只是展示信息，失败不影响壁纸
        }
    }

    private static String readWallpaperName(File dir) {
        try {
            File file = new File(dir, WALLPAPER_NAME_FILE);
            if (!file.isFile() || file.length() <= 0L || file.length() > 512L) {
                return "";
            }
            byte[] bytes = readAll(file, (int) file.length());
            return bytes == null ? "" : new String(bytes, StandardCharsets.UTF_8).trim();
        } catch (Throwable t) {
            return "";
        }
    }

    static String sanitizeWallpaperName(String name) {
        String raw = name == null ? "" : name.trim();
        if (raw.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < raw.length() && sb.length() < 80; i++) {
            char c = raw.charAt(i);
            if (c == '\n' || c == '\r' || c == '\t' || c == '\u0000') {
                sb.append(' ');
            } else {
                sb.append(c);
            }
        }
        return sb.toString().trim();
    }

    // ------------------------------------------------------------ 图片保存（MediaStore / 私有目录）

    static String coreSaveImage(Context context, String dataUrl, String fileName) {
        try {
            if (context == null) {
                return errorJson("上下文不可用");
            }
            ParsedData parsed = parseImageData(dataUrl);
            if (parsed == null || parsed.bytes == null || parsed.bytes.length == 0) {
                return errorJson("图片数据为空或 base64 解码失败");
            }
            if (parsed.bytes.length > MAX_IMAGE_BYTES) {
                return errorJson("图片过大（" + parsed.bytes.length + " 字节，上限 "
                        + MAX_IMAGE_BYTES + " 字节）");
            }
            // 文件头优先（避免 data URL 的 MIME 与实际内容不一致导致扩展名错误）
            String detected = detectMime(parsed.bytes);
            String mime = detected == null || detected.isEmpty() ? parsed.mime : detected;
            if (mime == null || !mime.startsWith("image/")) {
                return errorJson("不支持的图片格式");
            }
            String extension = extensionForMime(mime);
            String safeName = sanitizeImageFileName(fileName, extension);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                return saveViaMediaStore(context, parsed.bytes, mime, safeName, extension);
            }
            return saveToAppPictures(context, parsed.bytes, safeName);
        } catch (Throwable t) {
            return errorJson("图片保存失败：" + message(t));
        }
    }

    private static String saveViaMediaStore(Context context, byte[] bytes, String mime,
                                            String safeName, String extension) {
        ContentResolver resolver = context.getContentResolver();
        if (resolver == null) {
            return errorJson("无法访问相册（ContentResolver 不可用）");
        }
        Uri collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                Environment.DIRECTORY_PICTURES + File.separator + ALBUM_DIR);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = null;
        OutputStream out = null;
        try {
            uri = resolver.insert(collection, values);
            if (uri == null) {
                return errorJson("无法创建相册条目（MediaStore.insert 返回 null）");
            }
            out = resolver.openOutputStream(uri);
            if (out == null) {
                return errorJson("无法写入相册文件");
            }
            out.write(bytes);
            out.flush();
            out.close();
            out = null;
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(uri, done, null, null);
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("uri", uri.toString());
            result.put("path", Environment.DIRECTORY_PICTURES + "/" + ALBUM_DIR + "/" + safeName);
            result.put("name", safeName);
            result.put("mime", mime);
            result.put("size", bytes.length);
            result.put("sdkInt", Build.VERSION.SDK_INT);
            return result.toString();
        } catch (Throwable t) {
            if (uri != null) {
                try {
                    resolver.delete(uri, null, null);
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
            return errorJson("写入相册失败：" + message(t));
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

    private static String saveToAppPictures(Context context, byte[] bytes, String safeName) {
        File base = null;
        try {
            base = context.getExternalFilesDir(Environment.DIRECTORY_PICTURES);
        } catch (Throwable ignored) {
            base = null;
        }
        if (base == null) {
            base = new File(context.getFilesDir(), Environment.DIRECTORY_PICTURES);
        }
        if (!base.isDirectory() && !base.mkdirs()) {
            return errorJson("无法创建图片目录");
        }
        File target = uniqueFile(base, safeName);
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(target, false);
            out.write(bytes);
            out.flush();
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("uri", Uri.fromFile(target).toString());
            result.put("path", target.getAbsolutePath());
            result.put("name", target.getName());
            result.put("size", bytes.length);
            result.put("sdkInt", Build.VERSION.SDK_INT);
            return result.toString();
        } catch (Throwable t) {
            return errorJson("写入图片目录失败：" + message(t));
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

    private static File uniqueFile(File dir, String name) {
        File target = new File(dir, name);
        if (!target.exists()) {
            return target;
        }
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            File candidate = new File(dir, base + "-" + i + ext);
            if (!candidate.exists()) {
                return candidate;
            }
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }

    // ------------------------------------------------------------ 图片解析 / 命名

    /** 解析后的 data URL。 */
    static final class ParsedData {
        final byte[] bytes;
        final String mime;

        ParsedData(byte[] bytes, String mime) {
            this.bytes = bytes;
            this.mime = mime;
        }
    }

    static ParsedData parseImageData(String dataUrl) {
        if (dataUrl == null) {
            return null;
        }
        String raw = dataUrl.trim();
        if (raw.isEmpty()) {
            return null;
        }
        String mime = "";
        String payload = raw;
        if (raw.regionMatches(true, 0, "data:", 0, 5)) {
            int comma = raw.indexOf(',');
            if (comma < 0) {
                return null;
            }
            String header = raw.substring(5, comma).toLowerCase(Locale.US);
            int semicolon = header.indexOf(';');
            mime = semicolon >= 0 ? header.substring(0, semicolon) : header;
            payload = raw.substring(comma + 1);
        }
        byte[] bytes = decodeBase64(payload);
        if (bytes == null) {
            return null;
        }
        return new ParsedData(bytes, mime);
    }

    /** 从文件头识别图片 MIME；识别失败返回 "". */
    static String detectMime(byte[] bytes) {
        if (bytes == null || bytes.length < 4) {
            return "";
        }
        if ((bytes[0] & 0xFF) == 0xFF && (bytes[1] & 0xFF) == 0xD8
                && (bytes[2] & 0xFF) == 0xFF) {
            return "image/jpeg";
        }
        if ((bytes[0] & 0xFF) == 0x89 && bytes[1] == 'P' && bytes[2] == 'N'
                && bytes[3] == 'G') {
            return "image/png";
        }
        if (bytes[0] == 'G' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == '8') {
            return "image/gif";
        }
        if (bytes.length >= 12 && bytes[0] == 'R' && bytes[1] == 'I'
                && bytes[2] == 'F' && bytes[3] == 'F'
                && bytes[8] == 'W' && bytes[9] == 'E' && bytes[10] == 'B' && bytes[11] == 'P') {
            return "image/webp";
        }
        return "";
    }

    static String extensionForMime(String mime) {
        String value = mime == null ? "" : mime.toLowerCase(Locale.US);
        if (value.contains("png")) {
            return ".png";
        }
        if (value.contains("webp")) {
            return ".webp";
        }
        if (value.contains("gif")) {
            return ".gif";
        }
        return ".jpg";
    }

    static String sanitizeImageFileName(String rawName, String extension) {
        String ext = extension == null || extension.isEmpty() ? ".jpg" : extension;
        String name = rawName == null ? "" : rawName.trim();
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (slash >= 0) {
            name = name.substring(slash + 1);
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < name.length() && sb.length() < 90; i++) {
            char c = name.charAt(i);
            if (c < 0x20 || c == '\u007F') {
                continue;
            }
            boolean bad = c == '/' || c == '\\' || c == ':' || c == '*' || c == '?'
                    || c == '"' || c == '<' || c == '>' || c == '|';
            sb.append(bad ? '_' : c);
        }
        String base = sb.toString().trim();
        String lower = base.toLowerCase(Locale.US);
        String[] known = new String[]{".jpeg", ".jpg", ".png", ".webp", ".gif"};
        for (String suffix : known) {
            if (lower.endsWith(suffix)) {
                base = base.substring(0, base.length() - suffix.length());
                break;
            }
        }
        base = base.trim();
        if (base.isEmpty()) {
            base = "DeepSeekHouse-" + System.currentTimeMillis();
        }
        return base + ext;
    }

    static boolean isJpeg(byte[] bytes) {
        return bytes != null && bytes.length >= 3
                && (bytes[0] & 0xFF) == 0xFF
                && (bytes[1] & 0xFF) == 0xD8
                && (bytes[2] & 0xFF) == 0xFF;
    }

    // ------------------------------------------------------------ Base64（纯 Java，minSdk 24 无 java.util.Base64）

    /** 提取 data URL 的 base64 负载（纯 base64 原样返回；null/空返回 ""）。 */
    static String extractBase64Payload(String raw) {
        if (raw == null) {
            return "";
        }
        String value = raw.trim();
        if (value.regionMatches(true, 0, "data:", 0, 5)) {
            int comma = value.indexOf(',');
            if (comma < 0) {
                return "";
            }
            value = value.substring(comma + 1);
        }
        return value;
    }

    /** 标准 base64 解码（忽略空白；兼容 URL-safe -_；非法返回 null）。 */
    static byte[] decodeBase64(String raw) {
        if (raw == null) {
            return null;
        }
        StringBuilder sb = new StringBuilder(raw.length());
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c == ' ' || c == '\n' || c == '\r' || c == '\t') {
                continue;
            }
            if (c == '-') {
                c = '+';
            } else if (c == '_') {
                c = '/';
            }
            if (c == '=') {
                sb.append('=');
                continue;
            }
            if (base64Value(c) < 0) {
                return null;
            }
            sb.append(c);
        }
        int len = sb.length();
        if (len == 0) {
            return new byte[0];
        }
        int pad = 0;
        while (len > 0 && sb.charAt(len - 1) == '=') {
            pad++;
            len--;
        }
        if (pad > 2 || len == 0) {
            return null;
        }
        for (int i = 0; i < len; i++) {
            if (sb.charAt(i) == '=') {
                return null;
            }
        }
        if (len % 4 == 1) {
            return null;
        }
        if (pad > 0 && (len + pad) % 4 != 0) {
            return null;
        }
        int outLength = len * 6 / 8;
        byte[] out = new byte[outLength];
        int buffer = 0;
        int bits = 0;
        int index = 0;
        for (int i = 0; i < len; i++) {
            int value = base64Value(sb.charAt(i));
            if (value < 0) {
                return null;
            }
            buffer = (buffer << 6) | value;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                if (index < out.length) {
                    out[index++] = (byte) ((buffer >> bits) & 0xFF);
                }
            }
        }
        return out;
    }

    /** 标准 base64 编码（带 = 填充）。 */
    static String encodeBase64(byte[] data) {
        if (data == null || data.length == 0) {
            return "";
        }
        StringBuilder sb = new StringBuilder((data.length + 2) / 3 * 4);
        int i = 0;
        while (i < data.length) {
            int b0 = data[i++] & 0xFF;
            int b1 = i < data.length ? data[i++] & 0xFF : -1;
            int b2 = i < data.length ? data[i++] & 0xFF : -1;
            sb.append(BASE64_TABLE[b0 >>> 2]);
            if (b1 >= 0) {
                sb.append(BASE64_TABLE[((b0 & 0x03) << 4) | (b1 >>> 4)]);
            } else {
                sb.append(BASE64_TABLE[(b0 & 0x03) << 4]).append('=').append('=');
                break;
            }
            if (b2 >= 0) {
                sb.append(BASE64_TABLE[((b1 & 0x0F) << 2) | (b2 >>> 6)]);
                sb.append(BASE64_TABLE[b2 & 0x3F]);
            } else {
                sb.append(BASE64_TABLE[(b1 & 0x0F) << 2]).append('=');
                break;
            }
        }
        return sb.toString();
    }

    private static int base64Value(char c) {
        if (c >= 'A' && c <= 'Z') {
            return c - 'A';
        }
        if (c >= 'a' && c <= 'z') {
            return c - 'a' + 26;
        }
        if (c >= '0' && c <= '9') {
            return c - '0' + 52;
        }
        if (c == '+') {
            return 62;
        }
        if (c == '/') {
            return 63;
        }
        return -1;
    }

    // ------------------------------------------------------------ 小工具

    private static byte[] readAll(File file, int maxBytes) {
        FileInputStream in = null;
        try {
            in = new FileInputStream(file);
            int size = (int) Math.min(file.length(), (long) maxBytes);
            byte[] bytes = new byte[size];
            int read = 0;
            while (read < size) {
                int n = in.read(bytes, read, size - read);
                if (n < 0) {
                    break;
                }
                read += n;
            }
            if (read == bytes.length) {
                return bytes;
            }
            byte[] trimmed = new byte[read];
            System.arraycopy(bytes, 0, trimmed, 0, read);
            return trimmed;
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

    private static String errorJson(String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false);
            o.put("error", message == null ? "操作失败" : message);
        } catch (JSONException ignored) {
            return "{\"ok\":false,\"error\":\"操作失败\"}";
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

    /** 供测试/调试：壁纸文件路径。 */
    static File wallpaperFile(File dir) {
        return dir == null ? null : new File(dir, WALLPAPER_FILE);
    }

    /** 供测试/调试：同时返回解码后的 base64（JVM 单测用）。 */
    static byte[] decodeForTest(String payload) {
        return decodeBase64(payload);
    }
}
