package com.deepseekhouse.app;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * SAF（Storage Access Framework）文件读取工具。
 *
 * <p>与 {@link PluginStore} 的插件文件读写分离：插件源码限制 4MB，备份导入允许到 8MB；
 * 两者都只读文本，不碰外部存储权限（走 ContentResolver）。</p>
 */
public final class SafIo {

    /** F3 备份导入的文本上限（SPEC v2.0 F3）。 */
    public static final int MAX_IMPORT_BYTES = 8 * 1024 * 1024;

    private SafIo() {
    }

    /** 取 SAF URI 的显示名（{@link OpenableColumns#DISPLAY_NAME}），失败时退回路径尾段。 */
    public static String displayName(Context context, Uri uri) {
        if (context == null || uri == null) {
            return "";
        }
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(
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
            // 查询失败时退回路径尾段
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
        return last == null ? "" : last.trim();
    }

    /** 读文本（UTF-8），超过 {@code maxBytes} 抛 {@link IOException}；调用方需在后台线程执行。 */
    public static String readText(Context context, Uri uri, int maxBytes) throws IOException {
        if (context == null || uri == null) {
            throw new IOException("未选择文件");
        }
        InputStream in = null;
        try {
            in = context.getContentResolver().openInputStream(uri);
            if (in == null) {
                throw new IOException("无法打开所选文件");
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int total = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > maxBytes) {
                    throw new IOException("文件过大（超过 " + (maxBytes / (1024 * 1024)) + "MB）");
                }
                out.write(buf, 0, n);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
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
}
