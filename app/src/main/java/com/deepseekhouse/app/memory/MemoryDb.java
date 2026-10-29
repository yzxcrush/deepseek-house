package com.deepseekhouse.app.memory;

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
 * P3 记忆库（SPEC「ARCH v2 P3」N3，包 com.deepseekhouse.app.memory）。
 *
 * <p>SQLiteOpenHelper，数据库固定 {@code filesDir/memory.db}：</p>
 * <pre>
 * session_summary(chat_id TEXT PRIMARY KEY, summary TEXT, updated_at INTEGER)
 * memory_kv(scope TEXT, key TEXT, value TEXT, updated_at INTEGER, PRIMARY KEY(scope,key))
 * </pre>
 *
 * <p>scope 只允许 {@code long_term} / {@code project}。读方法同步返回 JSON 字符串，
 * 写方法由 JsBridge 排队到后台单线程执行；这里所有方法都吞异常，绝不崩 App。</p>
 *
 * <p>JSON 格式（供 JS 直接使用）：</p>
 * <ul>
 *   <li>summaries：{@code [{"chatId":"..","summary":"..","updatedAt":1720000000000}]}（新→旧）</li>
 *   <li>kv：{@code {"key":"value"}}</li>
 *   <li>all：{@code {"summaries":[...],"long_term":{...},"project":{...}}}</li>
 * </ul>
 */
public final class MemoryDb extends SQLiteOpenHelper {

    public static final String DB_NAME = "memory.db";
    public static final int DB_VERSION = 1;

    public static final String SCOPE_LONG_TERM = "long_term";
    public static final String SCOPE_PROJECT = "project";

    public static final String TABLE_SUMMARIES = "session_summary";
    public static final String TABLE_KV = "memory_kv";

    /** 单条摘要/记忆值上限（字符），防止 localStorage/DB 被超大内容拖垮。 */
    public static final int MAX_SUMMARY_CHARS = 64 * 1024;
    public static final int MAX_VALUE_CHARS = 64 * 1024;
    public static final int MAX_KEY_CHARS = 128;
    public static final int MAX_ROWS = 500;

    private static final String SQL_SUMMARIES =
            "CREATE TABLE IF NOT EXISTS " + TABLE_SUMMARIES + " ("
                    + "chat_id TEXT PRIMARY KEY, "
                    + "summary TEXT, "
                    + "updated_at INTEGER NOT NULL DEFAULT 0)";
    private static final String SQL_SUMMARIES_INDEX =
            "CREATE INDEX IF NOT EXISTS idx_session_summary_updated ON "
                    + TABLE_SUMMARIES + " (updated_at)";
    private static final String SQL_KV =
            "CREATE TABLE IF NOT EXISTS " + TABLE_KV + " ("
                    + "scope TEXT NOT NULL, "
                    + "key TEXT NOT NULL, "
                    + "value TEXT, "
                    + "updated_at INTEGER NOT NULL DEFAULT 0, "
                    + "PRIMARY KEY(scope, key))";

    public MemoryDb(Context context) {
        super(contextFor(context), DB_NAME, null, DB_VERSION);
    }

    private static Context appContext(Context context) {
        Context app = context == null ? null : context.getApplicationContext();
        return app == null ? context : app;
    }

    /** 固定数据库路径为 {@code filesDir/memory.db}（与 AuditDb 同样用 ContextWrapper 技巧）。 */
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
            db.execSQL(SQL_SUMMARIES);
            db.execSQL(SQL_SUMMARIES_INDEX);
            db.execSQL(SQL_KV);
        } catch (Throwable ignored) {
            // 建表失败时各方法静默降级
        }
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // v1 暂无迁移；确保表存在
        onCreate(db);
    }

    // ------------------------------------------------------------ scope / 校验

    public static boolean isValidScope(String scope) {
        return SCOPE_LONG_TERM.equals(scope) || SCOPE_PROJECT.equals(scope);
    }

    // ------------------------------------------------------------ 会话摘要

    /** 保存/更新会话摘要（chatId 为空忽略；summary 超 64KB 截断）。 */
    public synchronized void saveSummary(String chatId, String summary) {
        String id = trim(chatId);
        if (id.isEmpty()) {
            return;
        }
        try {
            ContentValues values = new ContentValues();
            values.put("chat_id", id);
            values.put("summary", truncate(summary, MAX_SUMMARY_CHARS));
            values.put("updated_at", System.currentTimeMillis());
            SQLiteDatabase db = getWritableDatabase();
            if (db == null) {
                return;
            }
            db.insertWithOnConflict(TABLE_SUMMARIES, null, values,
                    SQLiteDatabase.CONFLICT_REPLACE);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    public synchronized boolean deleteSummary(String chatId) {
        String id = trim(chatId);
        if (id.isEmpty()) {
            return false;
        }
        try {
            SQLiteDatabase db = getWritableDatabase();
            if (db == null) {
                return false;
            }
            return db.delete(TABLE_SUMMARIES, "chat_id=?", new String[]{id}) > 0;
        } catch (Throwable t) {
            return false;
        }
    }

    /** SPEC memoryGetSummaries：JSON 数组 [{chatId,summary,updatedAt}]，新→旧。 */
    public synchronized String summariesJson() {
        JSONArray array = new JSONArray();
        Cursor cursor = null;
        try {
            SQLiteDatabase db = getReadableDatabase();
            if (db == null) {
                return "[]";
            }
            cursor = db.query(TABLE_SUMMARIES, new String[]{"chat_id", "summary", "updated_at"},
                    null, null, null, null, "updated_at DESC", String.valueOf(MAX_ROWS));
            while (cursor != null && cursor.moveToNext()) {
                JSONObject item = new JSONObject();
                item.put("chatId", cursor.getString(0));
                item.put("summary", cursor.isNull(1) ? "" : cursor.getString(1));
                item.put("updatedAt", cursor.getLong(2));
                array.put(item);
            }
        } catch (Throwable t) {
            return array.toString();
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

    // ------------------------------------------------------------ KV 记忆

    /** SPEC memoryKvGet：JSON 对象 {"key":"value"}（scope 非法返回 "{}"）。 */
    public synchronized String kvJson(String scope) {
        if (!isValidScope(trim(scope))) {
            return "{}";
        }
        JSONObject object = new JSONObject();
        Cursor cursor = null;
        try {
            SQLiteDatabase db = getReadableDatabase();
            if (db == null) {
                return "{}";
            }
            cursor = db.query(TABLE_KV, new String[]{"key", "value"},
                    "scope=?", new String[]{scope.trim()},
                    null, null, "key ASC", String.valueOf(MAX_ROWS));
            while (cursor != null && cursor.moveToNext()) {
                object.put(cursor.getString(0), cursor.isNull(1) ? "" : cursor.getString(1));
            }
        } catch (Throwable t) {
            return "{}";
        } finally {
            if (cursor != null) {
                try {
                    cursor.close();
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        }
        return object.toString();
    }

    /** 写入/更新 KV（scope 非法、key 为空忽略；value 超 64KB 截断）。 */
    public synchronized void setKv(String scope, String key, String value) {
        String safeScope = trim(scope);
        String safeKey = truncate(trim(key), MAX_KEY_CHARS);
        if (!isValidScope(safeScope) || safeKey.isEmpty()) {
            return;
        }
        try {
            ContentValues values = new ContentValues();
            values.put("scope", safeScope);
            values.put("key", safeKey);
            values.put("value", truncate(value, MAX_VALUE_CHARS));
            values.put("updated_at", System.currentTimeMillis());
            SQLiteDatabase db = getWritableDatabase();
            if (db == null) {
                return;
            }
            db.insertWithOnConflict(TABLE_KV, null, values, SQLiteDatabase.CONFLICT_REPLACE);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    public synchronized boolean deleteKv(String scope, String key) {
        String safeScope = trim(scope);
        String safeKey = trim(key);
        if (!isValidScope(safeScope) || safeKey.isEmpty()) {
            return false;
        }
        try {
            SQLiteDatabase db = getWritableDatabase();
            if (db == null) {
                return false;
            }
            return db.delete(TABLE_KV, "scope=? AND key=?",
                    new String[]{safeScope, safeKey}) > 0;
        } catch (Throwable t) {
            return false;
        }
    }

    // ------------------------------------------------------------ 聚合

    /** SPEC memoryAll：{@code {"summaries":[...],"long_term":{...},"project":{...}}}。 */
    public String allJson() {
        JSONObject out = new JSONObject();
        try {
            out.put("summaries", new JSONArray(summariesJson()));
            out.put("long_term", new JSONObject(kvJson(SCOPE_LONG_TERM)));
            out.put("project", new JSONObject(kvJson(SCOPE_PROJECT)));
        } catch (Throwable t) {
            return "{\"summaries\":[],\"long_term\":{},\"project\":{}}";
        }
        return out.toString();
    }

    // ------------------------------------------------------------ 工具

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }

    private static String truncate(String value, int maxChars) {
        String text = value == null ? "" : value;
        if (text.length() <= maxChars) {
            return text;
        }
        return text.substring(0, maxChars) + "\n…（已截断）";
    }
}
