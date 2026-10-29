package com.deepseekhouse.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.util.Base64;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * 图片读取 → 按 EXIF 方向纠正 → 等比缩放到最长边 ≤ {@link #MAX_EDGE} → JPEG {@link #JPEG_QUALITY} → Base64 dataURL。
 *
 * <p>F6 图片输入（相册 / 相机）与 F8 其他 App 分享图片共用；全部方法都有大小上限，
 * 解码在后台线程调用，避免 UI 卡顿/内存爆掉。</p>
 */
public final class ImageTools {

    /** SPEC F6：最长边 ≤1280。 */
    public static final int MAX_EDGE = 1280;
    /** SPEC F6：JPEG 质量 80。 */
    public static final int JPEG_QUALITY = 80;

    private static final int MAX_SOURCE_BYTES = 32 * 1024 * 1024;
    private static final String DATA_URL_PREFIX = "data:image/jpeg;base64,";

    /** 处理结果：可直接拼进事件 JSON。 */
    public static final class Prepared {
        public final String dataUrl;
        public final int width;
        public final int height;

        Prepared(String dataUrl, int width, int height) {
            this.dataUrl = dataUrl;
            this.width = width;
            this.height = height;
        }
    }

    private ImageTools() {
    }

    /** 从 SAF / 分享 URI 读取图片。 */
    public static Prepared prepareFromUri(Context context, Uri uri) throws IOException {
        if (context == null || uri == null) {
            throw new IOException("未选择图片");
        }
        InputStream in = null;
        try {
            in = context.getContentResolver().openInputStream(uri);
            if (in == null) {
                throw new IOException("无法打开图片");
            }
            return prepare(readAll(in));
        } finally {
            closeQuietly(in);
        }
    }

    /** 从本地文件（相机临时文件）读取图片。 */
    public static Prepared prepareFromFile(File file) throws IOException {
        if (file == null || !file.isFile() || file.length() <= 0L) {
            throw new IOException("未获取到照片");
        }
        if (file.length() > MAX_SOURCE_BYTES) {
            throw new IOException("图片过大");
        }
        FileInputStream in = null;
        try {
            in = new FileInputStream(file);
            return prepare(readAll(in));
        } finally {
            closeQuietly(in);
        }
    }

    /** 处理一张已经解码的 Bitmap（相机会在 data extras 里返回缩略图时使用）。会回收传入的 Bitmap。 */
    public static Prepared prepare(Bitmap bitmap) throws IOException {
        if (bitmap == null) {
            throw new IOException("无法解码图片");
        }
        Bitmap current = bitmap;
        try {
            current = scaleToMaxEdge(current);
            return encodeJpeg(current);
        } finally {
            if (current != null && !current.isRecycled()) {
                current.recycle();
            }
        }
    }

    // ------------------------------------------------------------ 内部实现

    private static Prepared prepare(byte[] data) throws IOException {
        if (data == null || data.length == 0) {
            throw new IOException("图片内容为空");
        }
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try {
            BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
        } catch (Throwable ignored) {
            // 下面统一报错
        }
        int width = bounds.outWidth;
        int height = bounds.outHeight;
        if (width <= 0 || height <= 0) {
            throw new IOException("无法识别图片格式");
        }
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sampleSize(width, height);
        opts.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap current = null;
        try {
            try {
                current = BitmapFactory.decodeByteArray(data, 0, data.length, opts);
            } catch (Throwable t) {
                current = null;
            }
            if (current == null) {
                throw new IOException("图片解码失败");
            }
            current = applyOrientation(current, readOrientation(data));
            current = scaleToMaxEdge(current);
            return encodeJpeg(current);
        } finally {
            if (current != null && !current.isRecycled()) {
                current.recycle();
            }
        }
    }

    /** 采样率：解码后最长边落在 [MAX_EDGE, 2*MAX_EDGE] 附近，兼顾清晰度与内存。 */
    private static int sampleSize(int width, int height) {
        int longest = Math.max(width, height);
        int sample = 1;
        while (longest / (sample * 2) >= MAX_EDGE) {
            sample *= 2;
        }
        return Math.max(1, sample);
    }

    private static int readOrientation(byte[] data) {
        try {
            ExifInterface exif = new ExifInterface(new ByteArrayInputStream(data));
            return exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (Throwable ignored) {
            return ExifInterface.ORIENTATION_NORMAL;
        }
    }

    private static Bitmap applyOrientation(Bitmap src, int orientation) {
        if (src == null) {
            return null;
        }
        Matrix matrix = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_ROTATE_90:
                matrix.setRotate(90f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_180:
                matrix.setRotate(180f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_270:
                matrix.setRotate(270f);
                break;
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL:
                matrix.setScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL:
                matrix.setScale(1f, -1f);
                break;
            default:
                return src;
        }
        try {
            Bitmap out = Bitmap.createBitmap(src, 0, 0, src.getWidth(), src.getHeight(), matrix, true);
            if (out != src) {
                src.recycle();
            }
            return out;
        } catch (Throwable t) {
            return src;
        }
    }

    private static Bitmap scaleToMaxEdge(Bitmap src) {
        if (src == null) {
            return null;
        }
        int width = src.getWidth();
        int height = src.getHeight();
        int longest = Math.max(width, height);
        if (longest <= MAX_EDGE) {
            return src;
        }
        float ratio = (float) MAX_EDGE / (float) longest;
        int targetWidth = Math.max(1, Math.round(width * ratio));
        int targetHeight = Math.max(1, Math.round(height * ratio));
        try {
            Bitmap out = Bitmap.createScaledBitmap(src, targetWidth, targetHeight, true);
            if (out != src) {
                src.recycle();
            }
            return out;
        } catch (Throwable t) {
            return src;
        }
    }

    private static Prepared encodeJpeg(Bitmap bitmap) throws IOException {
        if (bitmap == null || bitmap.isRecycled()) {
            throw new IOException("图片处理失败");
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        boolean ok;
        try {
            ok = bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out);
        } catch (Throwable t) {
            throw new IOException("图片编码失败");
        }
        byte[] bytes = out.toByteArray();
        if (!ok || bytes.length == 0) {
            throw new IOException("图片编码失败");
        }
        String dataUrl = DATA_URL_PREFIX + Base64.encodeToString(bytes, Base64.NO_WRAP);
        return new Prepared(dataUrl, bitmap.getWidth(), bitmap.getHeight());
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int total = 0;
        int n;
        while ((n = in.read(buf)) != -1) {
            total += n;
            if (total > MAX_SOURCE_BYTES) {
                throw new IOException("图片过大（超过 32MB）");
            }
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    private static void closeQuietly(InputStream in) {
        if (in != null) {
            try {
                in.close();
            } catch (IOException ignored) {
                // 忽略
            }
        }
    }
}
