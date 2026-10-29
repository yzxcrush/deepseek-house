package com.deepseekhouse.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * JS ⇄ 原生的唯一桥（注入名 {@code DSNative}，见 SPEC §3）。
 *
 * <p>所有同步方法都返回 JSON 字符串（失败返回 {@code {"error":"..."}}），自定义异常绝不外抛；
 * 异步方法立即返回，结果通过 {@code window.DSHost.onEvent(json)} 回传（切主线程执行）。</p>
 */
public final class JsBridge {

    public static final String JS_NAME = "DSNative";

    private static final String EVENT_CALL_PREFIX = "window.DSHost && DSHost.onEvent(";
    private static final Pattern META_ID = Pattern.compile("@id\\s+([A-Za-z0-9._-]{1,64})");
    private static final long CLIPBOARD_TIMEOUT_MS = 2000L;

    private final MainActivity activity;
    private final Prefs prefs;
    private final PluginStore plugins;
    private final ApiClient api;
    private final Handler main;

    private volatile String pendingExportName = "";
    private volatile String pendingExportContent = "";
    private volatile boolean released;

    public JsBridge(MainActivity activity) {
        this.activity = activity;
        this.main = new Handler(Looper.getMainLooper());
        this.prefs = new Prefs(activity);
        this.plugins = new PluginStore(activity);
        this.api = new ApiClient(prefs, new ApiClient.EventSink() {
            @Override
            public void emit(String json) {
                emitEvent(json);
            }
        });
    }

    /** Activity 销毁时释放网络线程池与事件通道。 */
    public void release() {
        released = true;
        api.shutdown();
    }

    // ============================================================ §3.1 同步方法

    @JavascriptInterface
    public String appInfo() {
        try {
            JSONObject o = new JSONObject();
            String pkg = activity.getPackageName();
            o.put("versionName", "");
            o.put("versionCode", 0L);
            try {
                PackageInfo info = activity.getPackageManager().getPackageInfo(pkg, 0);
                o.put("versionName", info.versionName == null ? "" : info.versionName);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    o.put("versionCode", info.getLongVersionCode());
                } else {
                    o.put("versionCode", (long) info.versionCode);
                }
            } catch (Throwable ignored) {
                // 保持默认值
            }
            java.io.File filesDir = activity.getFilesDir();
            o.put("filesDir", filesDir == null ? "" : filesDir.getAbsolutePath());
            o.put("sdkInt", Build.VERSION.SDK_INT);
            return o.toString();
        } catch (Throwable t) {
            return errorJson("appInfo 失败：" + describe(t));
        }
    }

    @JavascriptInterface
    public String getPrefs() {
        try {
            JSONObject o = prefs.toJson();
            o.put(Prefs.KEY_BACK_DEPTH, activity.getBackDepth());
            return o.toString();
        } catch (Throwable t) {
            return errorJson("getPrefs 失败：" + describe(t));
        }
    }

    @JavascriptInterface
    public void setPrefs(String json) {
        try {
            prefs.applyJson(json);
        } catch (Throwable ignored) {
            // 部分合并失败时保持原设置
        }
    }

    @JavascriptInterface
    public String pluginsList() {
        try {
            return plugins.listJson();
        } catch (Throwable t) {
            return "[]";
        }
    }

    @JavascriptInterface
    public String pluginRead(String id) {
        try {
            String code = plugins.read(id);
            return code == null ? errorJson("插件不存在：" + (id == null ? "" : id)) : code;
        } catch (Throwable t) {
            return errorJson("pluginRead 失败：" + describe(t));
        }
    }

    @JavascriptInterface
    public void pluginWrite(String id, String code, String metaJson) {
        try {
            plugins.write(id, code, metaJson);
        } catch (Throwable ignored) {
            // 写入失败保持静默，JS 侧通过 pluginsList 复核
        }
    }

    @JavascriptInterface
    public void pluginDelete(String id) {
        try {
            plugins.delete(id);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    @JavascriptInterface
    public void pluginSetEnabled(String id, boolean enabled) {
        try {
            plugins.setEnabled(id, enabled);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    @JavascriptInterface
    public String getClipboard() {
        try {
            if (Looper.myLooper() == Looper.getMainLooper()) {
                return readClipboard();
            }
            final String[] result = new String[]{""};
            final CountDownLatch latch = new CountDownLatch(1);
            main.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        result[0] = readClipboard();
                    } catch (Throwable ignored) {
                        result[0] = "";
                    } finally {
                        latch.countDown();
                    }
                }
            });
            if (!latch.await(CLIPBOARD_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                return "";
            }
            return result[0] == null ? "" : result[0];
        } catch (Throwable t) {
            return "";
        }
    }

    @JavascriptInterface
    public void setClipboard(final String text) {
        main.post(new Runnable() {
            @Override
            public void run() {
                try {
                    ClipboardManager cm = (ClipboardManager)
                            activity.getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm == null) {
                        return;
                    }
                    cm.setPrimaryClip(ClipData.newPlainText(
                            activity.getString(R.string.clipboard_label), text == null ? "" : text));
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        });
    }

    @JavascriptInterface
    public void toast(final String msg) {
        if (msg == null || msg.isEmpty()) {
            return;
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                try {
                    Toast.makeText(activity.getApplicationContext(), msg, Toast.LENGTH_SHORT).show();
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        });
    }

    @JavascriptInterface
    public void openUrl(String url) {
        if (url == null || url.trim().isEmpty()) {
            return;
        }
        String lower = url.trim().toLowerCase(Locale.US);
        boolean allowed = lower.startsWith("http://") || lower.startsWith("https://")
                || lower.startsWith("mailto:") || lower.startsWith("tel:");
        if (allowed) {
            activity.openExternalUrl(url.trim());
        }
    }

    @JavascriptInterface
    public void setBackDepth(int depth) {
        int safe = Math.max(0, depth);
        activity.setBackDepth(safe);
        prefs.setBackDepth(safe);
    }

    /** bridge.js 会读取当前层级（SPEC 未强制，但 JS 侧在用，缺失时会退化为 0）。 */
    @JavascriptInterface
    public int getBackDepth() {
        return activity.getBackDepth();
    }

    @JavascriptInterface
    public void cancelRequest(String requestId) {
        try {
            api.cancel(requestId);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    @JavascriptInterface
    public void cancelAllRequests() {
        try {
            api.cancelAll();
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    @JavascriptInterface
    public void setStatusBar(String colorHex, boolean lightIcons) {
        activity.applyStatusBar(colorHex, lightIcons);
    }

    @JavascriptInterface
    public void finishApp() {
        activity.finishApp();
    }

    // ============================================================ §3.2 异步方法

    @JavascriptInterface
    public void startChat(String requestId, String bodyJson) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }
        try {
            api.startChat(requestId, bodyJson);
        } catch (Throwable t) {
            emitError(requestId, "启动请求失败：" + describe(t), 0);
        }
    }

    @JavascriptInterface
    public void validateKey(String requestId) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }
        try {
            api.validateKey(requestId);
        } catch (Throwable t) {
            emitError(requestId, "启动校验失败：" + describe(t), 0);
        }
    }

    @JavascriptInterface
    public void httpFetch(String requestId, String reqJson) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }
        try {
            api.httpFetch(requestId, reqJson);
        } catch (Throwable t) {
            emitError(requestId, "启动请求失败：" + describe(t), 0);
        }
    }

    @JavascriptInterface
    public void importPluginFile() {
        try {
            activity.startImportFile();
        } catch (Throwable t) {
            emitPluginFile("", "", "", "无法打开文件选择器");
        }
    }

    @JavascriptInterface
    public void saveTextFile(String suggestedName, String content) {
        String name = suggestedName == null ? "" : suggestedName.trim();
        if (name.isEmpty()) {
            name = "deepseek-house.txt";
        }
        pendingExportName = name;
        pendingExportContent = content == null ? "" : content;
        try {
            activity.startExportFile(name);
        } catch (Throwable t) {
            pendingExportName = "";
            pendingExportContent = "";
            emitSaved(name, false, "无法打开保存对话框");
        }
    }

    // ============================================================ SAF 回调（由 Activity 转发）

    void onImportCancelled(String reason) {
        emitPluginFile("", "", "", reason == null || reason.isEmpty() ? "cancelled" : reason);
    }

    void onImportResult(int resultCode, Intent data) {
        final Uri uri = (resultCode == Activity.RESULT_OK && data != null) ? data.getData() : null;
        if (uri == null) {
            emitPluginFile("", "", "", "cancelled");
            return;
        }
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                String fileName = null;
                try {
                    fileName = plugins.displayName(uri);
                    if (fileName == null || fileName.trim().isEmpty()) {
                        fileName = "plugin.js";
                    }
                    String content = plugins.readTextFromUri(uri);
                    String id = extractPluginId(content);
                    if (id.isEmpty()) {
                        id = idFromFileName(fileName);
                    }
                    emitPluginFile(id, fileName, content, null);
                } catch (Throwable t) {
                    emitPluginFile("", fileName == null ? "" : fileName, "", describe(t));
                }
            }
        }, "dsh-saf-import");
        thread.setDaemon(true);
        thread.start();
    }

    void onExportCancelled(String reason) {
        String name = pendingExportName;
        pendingExportName = "";
        pendingExportContent = "";
        emitSaved(name, false, reason == null || reason.isEmpty() ? "cancelled" : reason);
    }

    void onExportResult(int resultCode, Intent data) {
        final Uri uri = (resultCode == Activity.RESULT_OK && data != null) ? data.getData() : null;
        final String name = pendingExportName;
        final String content = pendingExportContent;
        pendingExportName = "";
        pendingExportContent = "";
        if (uri == null) {
            emitSaved(name, false, "cancelled");
            return;
        }
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    plugins.writeTextToUri(uri, content);
                    emitSaved(name, true, null);
                } catch (Throwable t) {
                    emitSaved(name, false, describe(t));
                }
            }
        }, "dsh-saf-export");
        thread.setDaemon(true);
        thread.start();
    }

    // ============================================================ 事件通道

    private void emitEvent(final String json) {
        if (json == null || released) {
            return;
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                if (released) {
                    return;
                }
                WebView view = activity.getWebView();
                if (view == null) {
                    return;
                }
                try {
                    view.evaluateJavascript(EVENT_CALL_PREFIX + json + ")", null);
                } catch (Throwable ignored) {
                    // 页面未就绪 / 已销毁时丢弃事件
                }
            }
        });
    }

    private void emitPluginFile(String id, String fileName, String content, String error) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "plugin-file");
            o.put("id", id == null ? "" : id);
            o.put("fileName", fileName == null ? "" : fileName);
            o.put("content", content == null ? "" : content);
            if (error != null) {
                o.put("error", error);
            }
        } catch (JSONException ignored) {
            return;
        }
        emitEvent(o.toString());
    }

    private void emitSaved(String name, boolean ok, String error) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "saved");
            o.put("ok", ok);
            o.put("name", name == null ? "" : name);
            if (error != null) {
                o.put("error", error);
            }
        } catch (JSONException ignored) {
            return;
        }
        emitEvent(o.toString());
    }

    private void emitError(String requestId, String message, int httpStatus) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "error");
            o.put("requestId", requestId == null ? "" : requestId);
            o.put("message", message == null ? "" : message);
            o.put("httpStatus", httpStatus);
        } catch (JSONException ignored) {
            return;
        }
        emitEvent(o.toString());
    }

    // ============================================================ 内部工具

    private String readClipboard() {
        ClipboardManager cm = (ClipboardManager)
                activity.getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) {
            return "";
        }
        ClipData clip = cm.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) {
            return "";
        }
        CharSequence text = clip.getItemAt(0).coerceToText(activity);
        return text == null ? "" : text.toString();
    }

    /** 从源码头部的 {@code // @id user.foo} 注释里取插件 id。 */
    private static String extractPluginId(String code) {
        if (code == null || code.isEmpty()) {
            return "";
        }
        String head = code.length() > 8192 ? code.substring(0, 8192) : code;
        Matcher matcher = META_ID.matcher(head);
        if (matcher.find()) {
            String id = matcher.group(1);
            if (PluginStore.isValidId(id)) {
                return id;
            }
        }
        return "";
    }

    /** 文件名 → 插件 id：无命名空间时补 "user." 前缀。 */
    private static String idFromFileName(String fileName) {
        if (fileName == null) {
            return "";
        }
        String base = fileName.trim();
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) {
            base = base.substring(slash + 1);
        }
        int dot = base.lastIndexOf('.');
        if (dot > 0) {
            base = base.substring(0, dot);
        }
        String id = PluginStore.sanitizeId(base);
        if (id.isEmpty()) {
            return "";
        }
        return id.indexOf('.') >= 0 ? id : "user." + id;
    }

    private static String errorJson(String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("error", message == null ? "unknown error" : message);
            return o.toString();
        } catch (JSONException e) {
            return "{\"error\":\"unknown error\"}";
        }
    }

    private static String describe(Throwable t) {
        if (t == null) {
            return "未知错误";
        }
        String message = t.getMessage();
        return message == null || message.trim().isEmpty() ? t.getClass().getSimpleName() : message;
    }
}
