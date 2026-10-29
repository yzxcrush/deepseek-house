package com.deepseekhouse.app.agent;

import android.content.ContentValues;
import android.content.Context;
import android.content.ContextWrapper;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;

/**
 * 安全审计数据库（SPEC N1「模块七」）。
 *
 * <p>数据库落在 {@code filesDir/audit.db}，表结构固定为：</p>
 * <pre>
 * audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tool TEXT,
 *       args TEXT, result TEXT, ok INTEGER, confirmed INTEGER)
 * </pre>
 *
 * <p>每一次工具执行（成功 / 失败 / 用户拒绝 / 未知工具 / 参数非法）都必须写一条；
 * {@link #append} 由任意后台线程调用，{@link #recent(int)} 供 JsBridge 同步查询。</p>
 */
public final class AuditDb extends SQLiteOpenHelper {

    public static final String DB_NAME = "audit.db";
    public static final int DB_VERSION = 1;
    public static final String TABLE = "audit";

    /** args 落库上限，防止把超大参数写进 SQLite。 */
    private static final int MAX_ARGS_CHARS = 8 * 1024;
    /** result 落库上限。 */
    private static final int MAX_RESULT_CHARS = 16 * 1024;
    /** recent() 的默认与上限条数。 */
    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 200;

    private static final String SQL_CREATE =
            "CREATE TABLE IF NOT EXISTS " + TABLE + " ("
                    + "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                    + "ts INTEGER NOT NULL, "
                    + "tool TEXT NOT NULL, "
                    + "args TEXT, "
                    + "result TEXT, "
                    + "ok INTEGER NOT NULL DEFAULT 0, "
                    + "confirmed INTEGER NOT NULL DEFAULT 0)";

    private static final String SQL_CREATE_INDEX =
            "CREATE INDEX IF NOT EXISTS idx_audit_ts ON " + TABLE + " (ts)";

    public AuditDb(Context context) {
        super(contextFor(context), DB_NAME, null, DB_VERSION);
    }

    private static Context appContext(Context context) {
        Context app = context == null ? null : context.getApplicationContext();
        return app == null ? context : app;
    }

    /**
     * SPEC N1 要求数据库放在 {@code filesDir/audit.db}（默认 SQLiteOpenHelper 会放 databases/）。
     * 这里用最小 {@link ContextWrapper} 只覆盖 {@link Context#getDatabasePath(String)}，
     * 其余能力原样委托给 Application Context；不依赖“数据库名支持绝对路径”这一平台细节。
     */
    private static Context contextFor(Context context) {
        Context app = appContext(context);
        if (app == null) {
            return context;
        }
        final File target;
        try {
            File filesDir = app.getFilesDir();
            target = filesDir == null ? null : new File(filesDir, DB_NAME);
        } catch (Throwable t) {
            return app;
        }
        if (target == null) {
            return app;
        }
        return new ContextWrapper(app) {
            @Override
            public File getDatabasePath(String name) {
                return target;
            }
        };
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        try {
            db.execSQL(SQL_CREATE);
            db.execSQL(SQL_CREATE_INDEX);
        } catch (Throwable ignored) {
            // 建表失败时 append/recent 都会静默降级，不影响工具主流程
        }
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // v1 尚无升级路径；保留旧数据，仅确保表存在
        onCreate(db);
    }

    /** 追加一条审计记录；任何异常都吞掉（审计不能反过来阻断工具执行）。 */
    public synchronized void append(String tool, String args, String result,
                                    boolean ok, boolean confirmed) {
        try {
            ContentValues values = new ContentValues();
            values.put("ts", System.currentTimeMillis());
            values.put("tool", tool == null ? "" : tool);
            values.put("args", truncate(args, MAX_ARGS_CHARS));
            values.put("result", truncate(result, MAX_RESULT_CHARS));
            values.put("ok", ok ? 1 : 0);
            values.put("confirmed", confirmed ? 1 : 0);
            SQLiteDatabase db = getWritableDatabase();
            if (db == null) {
                return;
            }
            db.insert(TABLE, null, values);
        } catch (Throwable ignored) {
            // 忽略：磁盘满/数据库损坏时不影响主流程
        }
    }

    /**
     * SPEC auditRecent：最近 {@code limit} 条，新的在前。
     * 返回 JSON 数组字符串：{@code [{"id","ts","tool","args","result","ok","confirmed"}]}。
     */
    public synchronized String recent(int limit) {
        int safeLimit = limit;
        if (safeLimit <= 0) {
            safeLimit = DEFAULT_LIMIT;
        }
        if (safeLimit > MAX_LIMIT) {
            safeLimit = MAX_LIMIT;
        }
        JSONArray array = new JSONArray();
        Cursor cursor = null;
        try {
            SQLiteDatabase db = getReadableDatabase();
            if (db == null) {
                return "[]";
            }
            cursor = db.query(TABLE, null, null, null, null, null,
                    "id DESC", String.valueOf(safeLimit));
            while (cursor != null && cursor.moveToNext()) {
                JSONObject item = new JSONObject();
                item.put("id", cursor.getLong(cursor.getColumnIndexOrThrow("id")));
                item.put("ts", cursor.getLong(cursor.getColumnIndexOrThrow("ts")));
                item.put("tool", cursor.getString(cursor.getColumnIndexOrThrow("tool")));
                item.put("args", cursor.getString(cursor.getColumnIndexOrThrow("args")));
                item.put("result", cursor.getString(cursor.getColumnIndexOrThrow("result")));
                item.put("ok", cursor.getInt(cursor.getColumnIndexOrThrow("ok")) != 0);
                item.put("confirmed", cursor.getInt(cursor.getColumnIndexOrThrow("confirmed")) != 0);
                array.put(item);
            }
        } catch (JSONException e) {
            return "[]";
        } catch (Throwable t) {
            return "[]";
        } finally {
            if (cursor != null) {
                try {
                    cursor.close();
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        }
        return array.toString();
    }

    private static String truncate(String text, int max) {
        if (text == null) {
            return "";
        }
        if (text.length() <= max) {
            return text;
        }
        return text.substring(0, max) + "\n…（审计截断）";
    }
}
