package com.deepseekhouse.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 最小化的 FileProvider 替代（本项目禁止 androidx，无法使用 {@code androidx.core.content.FileProvider}）。
 *
 * <p>只把一个固定文件 {@code cacheDir/camera_capture.jpg} 暴露给系统相机 App 写入
 * （{@code ACTION_IMAGE_CAPTURE} 的 {@code MediaStore.EXTRA_OUTPUT} content URI），
 * 不暴露目录，也不允许外部 App 自选路径；配合 intent 的
 * {@code FLAG_GRANT_WRITE_URI_PERMISSION} 使用，无需任何存储权限。</p>
 *
 * <p>Manifest 中注册为 {@code exported=false} + {@code grantUriPermissions=true}，
 * authority 为 {@link #AUTHORITY}。</p>
 */
public final class CameraFileProvider extends ContentProvider {

    public static final String AUTHORITY = "com.deepseekhouse.app.camerafiles";

    private static final String FILE_NAME = "camera_capture.jpg";

    /** 相机临时文件（cacheDir，系统可随时清理，不需要存储权限）。 */
    public static File fileFor(Context context) {
        if (context == null) {
            return null;
        }
        return new File(context.getApplicationContext().getCacheDir(), FILE_NAME);
    }

    /** 交给 {@code MediaStore.EXTRA_OUTPUT} 的 content URI。 */
    public static Uri uriFor() {
        return Uri.parse("content://" + AUTHORITY + "/" + FILE_NAME);
    }

    /** 照片的展示文件名（F6 事件里的 name 字段）。 */
    public static String displayName() {
        return FILE_NAME;
    }

    /** 删除上一次拍照的临时文件。 */
    public static void cleanup(Context context) {
        File file = fileFor(context);
        if (file != null && file.exists()) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        if (!isAllowed(uri)) {
            return null;
        }
        Context context = getContext();
        File file = fileFor(context);
        String[] columns = projection != null && projection.length > 0
                ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        Object[] row = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) {
            String column = columns[i];
            if (OpenableColumns.DISPLAY_NAME.equals(column)) {
                row[i] = FILE_NAME;
            } else if (OpenableColumns.SIZE.equals(column)) {
                row[i] = file == null ? 0L : file.length();
            } else {
                row[i] = null;
            }
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        return isAllowed(uri) ? "image/jpeg" : null;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!isAllowed(uri)) {
            throw new SecurityException("不允许访问该文件");
        }
        Context context = getContext();
        File file = fileFor(context);
        if (file == null) {
            throw new FileNotFoundException("缓存目录不可用");
        }
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory()) {
            //noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        }
        int flags = mode != null && mode.contains("w")
                ? ParcelFileDescriptor.MODE_WRITE_ONLY
                        | ParcelFileDescriptor.MODE_CREATE
                        | ParcelFileDescriptor.MODE_TRUNCATE
                : ParcelFileDescriptor.MODE_READ_ONLY;
        return ParcelFileDescriptor.open(file, flags);
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("只读/只写单文件 provider");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }

    private static boolean isAllowed(Uri uri) {
        if (uri == null || !AUTHORITY.equals(uri.getAuthority())) {
            return false;
        }
        String last = uri.getLastPathSegment();
        return FILE_NAME.equals(last);
    }
}
