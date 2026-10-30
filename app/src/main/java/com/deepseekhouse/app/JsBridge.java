package com.deepseekhouse.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import com.deepseekhouse.app.agent.AuditDb;
import com.deepseekhouse.app.agent.ToolDef;
import com.deepseekhouse.app.agent.RootManager;
import com.deepseekhouse.app.agent.ToolExecutor;
import com.deepseekhouse.app.agent.ToolRegistry;
import com.deepseekhouse.app.agent.Workspace;
import com.deepseekhouse.app.mcp.McpManager;
import com.deepseekhouse.app.memory.MemoryDb;
import com.deepseekhouse.app.plugin.PluginRepository;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.Collections;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * JS ⇄ 原生的唯一桥（注入名 {@code DSNative}，见 SPEC §3）。
 *
 * <p>所有同步方法都返回 JSON 字符串（失败返回 {@code {"error":"..."}}），自定义异常绝不外抛；
 * 异步方法立即返回，结果通过 {@code window.DSHost.onEvent(json)} 回传（切主线程执行）。</p>
 *
 * <p>v2.0 追加：F3 {@link #importTextFile()}（file-imported）、F6 {@link #pickImage(String)}
 * （image-picked / image-error）、F7 {@link #setForeground(boolean, String)} + {@link #notify(String, String)}
 * + app-state、F8 分享进入（shared）、F9 {@link #setAppLock(boolean)} / {@link #isAppLockEnabled()} /
 * {@link #getStorageSecret()}。</p>
 *
 * <p>ARCH v2 P1 追加：本地 Agent 工具框架 {@link #execTool(String, String, String)} /
 * {@link #confirmTool(String, boolean)} / {@link #toolSchemas()}（tool-confirm / tool-result）、
 * 工作区 {@link #workspaceInfo()} / {@link #listDir(String)} / {@link #readFile(String, String)} /
 * {@link #writeFile(String, String, String)} / {@link #runShell(String, String)} / {@link #setWorkspace(String)}、
 * 审计 {@link #auditRecent(int)}、工作区 {@link #setWorkspace(String)}、Root 检测 {@link #checkRoot()}。</p>
 *
 * <p>ARCH v2 P2 追加：MCP Client {@link #mcpServers()} / {@link #mcpSaveServer(String)} /
 * {@link #mcpDeleteServer(String)} / {@link #mcpConnect(String)} / {@link #mcpDisconnect(String)} /
 * {@link #mcpRefreshTools(String)}（mcp-status / mcp-tools / mcp-progress）；MCP 工具注册进
 * {@link ToolRegistry} 后由 {@link #execTool(String, String, String)} 按 {@code ToolDef.remote}
 * 转发为 tools/call，结果复用 tool-result。</p>
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

    // ARCH v2 P1：工作区 / 审计 / 内置工具
    private final Workspace workspace;
    private final AuditDb auditDb;
    private final ToolExecutor toolExecutor;
    /** ARCH v2 P2：MCP 客户端（连接管理 / tools/list 注册 / tools/call 转发）。 */
    private final McpManager mcp;
    /** ARCH v2 P3：house-plugins 插件目录（app 可写 + sdcard 只读扫描）。 */
    private final PluginRepository housePlugins;
    /** ARCH v2 P3：记忆 SQLite（filesDir/memory.db）。 */
    private final MemoryDb memoryDb;
    /** 记忆写操作单线程队列（保持调用顺序，异常静默）。 */
    private final ExecutorService memoryPool;
    private final ExecutorService toolPool;
    /** requestId → 等待确认的工具调用（confirmTool 消费）。 */
    private final Map<String, PendingTool> pendingTools = new ConcurrentHashMap<>();
    /** 本 App 会话内已经确认过的 MID 工具（同一工具只确认一次）。 */
    private final Set<String> sessionConfirmedTools =
            Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());

    private static final int MAX_PENDING_TOOLS = 64;

    /** 一次“已发起、等待 confirmTool”的工具调用。 */
    private static final class PendingTool {
        final String requestId;
        final ToolDef def;
        final JSONObject args;

        PendingTool(String requestId, ToolDef def, JSONObject args) {
            this.requestId = requestId;
            this.def = def;
            this.args = args == null ? new JSONObject() : args;
        }
    }

    private volatile String pendingExportName = "";
    private volatile String pendingExportContent = "";
    private volatile boolean released;

    // F8 分享进入：先暂存，页面加载完成（onPageFinished）后只投递一次
    private final Object shareLock = new Object();
    private volatile boolean pageReady;
    private boolean sharePending;
    private String sharedTextValue = "";
    private String sharedImageValue = "";

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
        // ARCH v2 P1：工作区 > 审计库 > 工具执行器（构造时幂等注册 5 个内置工具）
        this.workspace = new Workspace(activity);
        this.auditDb = new AuditDb(activity);
        this.toolExecutor = new ToolExecutor(workspace, auditDb);
        this.toolExecutor.setRootMode(prefs.isRootMode());
        this.toolPool = Executors.newCachedThreadPool(new ThreadFactory() {
            private final AtomicInteger seq = new AtomicInteger(1);

            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "dsh-tool-" + seq.getAndIncrement());
                t.setDaemon(true);
                return t;
            }
        });
        // ARCH v2 P2：MCP 连接管理器（配置来自 Prefs；页面就绪后自动连接 enabled 服务器）
        this.mcp = new McpManager(activity, prefs, new McpManager.EventSink() {
            @Override
            public void emit(String json) {
                emitEvent(json);
            }
        }, ToolRegistry.getInstance());
        // ARCH v2 P3：插件目录 + 记忆库（写入排队到单后台线程）
        this.housePlugins = new PluginRepository(activity);
        this.memoryDb = new MemoryDb(activity);
        this.memoryPool = Executors.newSingleThreadExecutor(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "dsh-memory-writer");
                t.setDaemon(true);
                return t;
            }
        });
    }

    /** Activity 销毁时释放网络线程池与事件通道。 */
    public void release() {
        released = true;
        api.shutdown();
        try {
            mcp.shutdown();
        } catch (Throwable ignored) {
            // 忽略
        }
        try {
            memoryPool.shutdownNow();
        } catch (Throwable ignored) {
            // 忽略
        }
        try {
            memoryDb.close();
        } catch (Throwable ignored) {
            // 忽略
        }
        try {
            toolPool.shutdownNow();
        } catch (Throwable ignored) {
            // 忽略
        }
        try {
            auditDb.close();
        } catch (Throwable ignored) {
            // 忽略
        }
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

    /** 系统分享：把聊天记录明文交给其它 App（ACTION_SEND text/plain）。 */
    @JavascriptInterface
    public void shareText(final String title, final String text) {
        main.post(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType("text/plain");
                    send.putExtra(Intent.EXTRA_SUBJECT, title == null ? "" : title);
                    send.putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
                    Intent chooser = Intent.createChooser(send,
                            activity.getString(R.string.share_chat));
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    activity.startActivity(chooser);
                } catch (Throwable ignored) {
                    // 没有可分享的 App 时静默
                }
            }
        });
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

    // ------------------------------------------------------------ F9 应用锁 / 本地加密

    /**
     * F9：应用锁开关（存 SharedPreferences）。开启后下次启动在加载 WebView 前要求系统身份验证。
     */
    @JavascriptInterface
    public void setAppLock(boolean enabled) {
        try {
            prefs.setAppLockEnabled(enabled);
            activity.onAppLockSettingChanged(enabled);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    /** F9：应用锁是否开启（设置页开关初值）。 */
    @JavascriptInterface
    public boolean isAppLockEnabled() {
        try {
            return prefs.isAppLockEnabled();
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * F9：返回 32 字节随机密钥的 Base64（首次调用生成，用 Android Keystore AES 包裹后存 SP）。
     * 任何失败返回 ""，JS 侧回退明文 localStorage。
     */
    @JavascriptInterface
    public String getStorageSecret() {
        try {
            return KeyVault.getOrCreateSecret(activity);
        } catch (Throwable t) {
            return "";
        }
    }

    // ============================================================ ARCH v2 P1 本地 Agent 工具框架

    /** SPEC N1 {@code toolSchemas()}：OpenAI tools 数组（内置 5 个工具）。 */
    @JavascriptInterface
    public String toolSchemas() {
        try {
            return ToolRegistry.getInstance().schemasJson();
        } catch (Throwable t) {
            return "[]";
        }
    }

    /**
     * SPEC N1 {@code execTool}：执行模型发起的工具调用。
     *
     * <p>风险策略：LOW 直接执行；MID 同一工具本 App 会话内首次确认；HIGH 每次确认。
     * 需要确认时先发 {@code tool-confirm} 并保存调用，等待 {@link #confirmTool}；
     * 不需要确认时进后台线程执行并回 {@code tool-result}。</p>
     */
    @JavascriptInterface
    public void execTool(final String requestId, final String name, final String argsJson) {
        final String rid = requestId == null ? "" : requestId;
        if (rid.isEmpty()) {
            return;
        }
        final String toolName = name == null ? "" : name.trim();
        JSONObject args;
        try {
            String raw = argsJson == null ? "" : argsJson.trim();
            args = raw.isEmpty() ? new JSONObject() : new JSONObject(raw);
        } catch (Throwable t) {
            auditTool(toolName, argsJson == null ? "" : argsJson, "参数不是合法 JSON", false, false);
            emitToolResult(rid, toolName, false, "参数不是合法 JSON：" + describe(t), false);
            return;
        }
        ToolDef def = ToolRegistry.getInstance().find(toolName);
        if (def == null) {
            auditTool(toolName, args.toString(), "未知工具", false, false);
            emitToolResult(rid, toolName, false, "未知工具：" + toolName, false);
            return;
        }
        if (requiresConfirmation(def)) {
            prunePendingTools();
            pendingTools.put(rid, new PendingTool(rid, def, args));
            emitToolConfirm(rid, def, args);
            return;
        }
        // LOW 风险工具直接执行；MID/HIGH 若走到这里说明已获会话内确认
        executeToolAsync(rid, def, args, def.risk() != ToolDef.Risk.LOW);
    }

    /**
     * SPEC N1 {@code confirmTool}：确认/拒绝一次待确认的工具调用。
     * 拒绝时回 {@code tool-result ok:false,result:"用户拒绝执行"} 并写审计。
     */
    @JavascriptInterface
    public void confirmTool(final String requestId, final boolean allow) {
        final String rid = requestId == null ? "" : requestId;
        if (rid.isEmpty()) {
            return;
        }
        PendingTool pending = pendingTools.remove(rid);
        if (pending == null) {
            emitToolResult(rid, "", false, "没有待确认的工具调用", false);
            return;
        }
        if (!allow) {
            auditTool(pending.def.id(), pending.args.toString(), "用户拒绝执行", false, false);
            emitToolResult(rid, pending.def.name(), false, "用户拒绝执行", false);
            return;
        }
        if (pending.def.risk() == ToolDef.Risk.MID) {
            sessionConfirmedTools.add(pending.def.name());
        }
        executeToolAsync(rid, pending.def, pending.args, true);
    }

    /**
     * SPEC 风险策略（权威）：LOW 永不确认；MID 本 App 会话内首次确认；HIGH 每次确认。
     * {@link ToolDef#needConfirm()} 只是工具元数据（供 UI/未来策略使用），不改变这里的判定。
     */
    private boolean requiresConfirmation(ToolDef def) {
        if (def == null) {
            return true;
        }
        if (def.risk() == ToolDef.Risk.HIGH) {
            return true;
        }
        if (def.risk() == ToolDef.Risk.MID) {
            return !sessionConfirmedTools.contains(def.name());
        }
        return false;
    }

    private void executeToolAsync(final String requestId, final ToolDef def,
                                  final JSONObject args, final boolean confirmed) {
        // ARCH v2 P2：MCP 远程工具 → tools/call 转发；结果文本复用 tool-result 事件
        if (def != null && def.isRemote()) {
            submitTool(new Runnable() {
                @Override
                public void run() {
                    McpManager.ToolCallResult result =
                            mcp.callTool(def.remote(), def.remoteTool(), def.name(), args);
                    // 审计 tool 字段用稳定 id（含 serverId），事件里的 tool 仍是模型调用的函数名
                    auditTool(def.id(), args.toString(), result.text, result.ok, confirmed);
                    emitToolResult(requestId, def.name(), result.ok, result.text,
                            confirmed, def.remote());
                }
            });
            return;
        }
        submitTool(new Runnable() {
            @Override
            public void run() {
                ToolExecutor.Outcome outcome = toolExecutor.execute(def.name(), args, confirmed);
                emitToolResult(requestId, def.name(), outcome.ok, outcome.result, confirmed);
            }
        });
    }

    /** 用户直接操作的桥接方法（文件树/终端/预览）：后台执行 + 直接回 tool-result，同时写审计。 */
    private void runDirectTool(final String requestId, final String toolName, final JSONObject args) {
        final String rid = requestId == null ? "" : requestId;
        if (rid.isEmpty()) {
            return;
        }
        submitTool(new Runnable() {
            @Override
            public void run() {
                ToolExecutor.Outcome outcome = toolExecutor.execute(toolName, args, true);
                emitToolResult(rid, toolName, outcome.ok, outcome.result, true);
            }
        });
    }

    /** SPEC N1 {@code workspaceInfo()}：{@code {"root","writable","allFilesAccess"}}。 */
    @JavascriptInterface
    public String workspaceInfo() {
        try {
            return workspace.infoJson();
        } catch (Throwable t) {
            return errorJson("workspaceInfo 失败：" + describe(t));
        }
    }

    /** SPEC N1 {@code listDir(path)}：同步返回 JSON 数组；失败返回 {@code {"error"}}。 */
    @JavascriptInterface
    public String listDir(String path) {
        try {
            return workspace.listDirJson(path);
        } catch (SecurityException e) {
            return errorJson(e.getMessage() == null ? "路径被拒绝" : e.getMessage());
        } catch (Throwable t) {
            return errorJson("listDir 失败：" + describe(t));
        }
    }

    /** SPEC N1 {@code readFile(requestId,path)}：后台读工作区文本，回 {@code tool-result}（tool=read_file）。 */
    @JavascriptInterface
    public void readFile(final String requestId, final String path) {
        final String rid = requestId == null ? "" : requestId;
        if (rid.isEmpty()) {
            return;
        }
        final String safePath = path == null ? "" : path;
        submitTool(new Runnable() {
            @Override
            public void run() {
                ToolExecutor.Outcome outcome = toolExecutor.readFileForPreview(safePath);
                emitToolResult(rid, "read_file", outcome.ok, outcome.result, true);
            }
        });
    }

    /** SPEC N1 {@code writeFile(requestId,path,content)}：后台写工作区文件，回 {@code tool-result}（tool=write_file）。 */
    @JavascriptInterface
    public void writeFile(final String requestId, final String path, final String content) {
        final String rid = requestId == null ? "" : requestId;
        if (rid.isEmpty()) {
            return;
        }
        final String safePath = path == null ? "" : path;
        final String safeContent = content == null ? "" : content;
        submitTool(new Runnable() {
            @Override
            public void run() {
                ToolExecutor.Outcome outcome = toolExecutor.writeFileDirect(safePath, safeContent);
                emitToolResult(rid, "write_file", outcome.ok, outcome.result, true);
            }
        });
    }

    /** SPEC N1 {@code runShell(requestId,command)}：用户手动终端命令（不经确认弹窗，但写审计）。 */
    @JavascriptInterface
    public void runShell(final String requestId, final String command) {
        runDirectTool(requestId, "run_shell", args("command", command == null ? "" : command));
    }

    /** Root 模式：是否让 run_shell/终端 通过 su 执行。 */
    @JavascriptInterface
    public boolean isRootMode() {
        return prefs.isRootMode();
    }

    @JavascriptInterface
    public void setRootMode(boolean enabled) {
        prefs.setRootMode(enabled);
        try {
            toolExecutor.setRootMode(enabled);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    /** Root 检测：{"root":bool,"uid":0,"message":"..."}（会阻塞最多 4 秒，建议后台调用）。 */
    @JavascriptInterface
    public String checkRoot() {
        try {
            return RootManager.checkJson();
        } catch (Throwable t) {
            return "{\"root\":false,\"uid\":-1,\"message\":\"检测失败\"}";
        }
    }

    /** SPEC N1 {@code auditRecent(limit)}：最近审计记录 JSON 数组（新的在前）。 */
    @JavascriptInterface
    public String auditRecent(int limit) {
        try {
            return auditDb.recent(limit);
        } catch (Throwable t) {
            return "[]";
        }
    }

    /**
     * SPEC N1 {@code setWorkspace(path)}：切换工作区（空串恢复默认）。
     * 结果通过 {@code workspace-changed} 事件回传（SPEC 未定义事件名，属本层补充）。
     */
    @JavascriptInterface
    public void setWorkspace(final String path) {
        submitTool(new Runnable() {
            @Override
            public void run() {
                boolean ok;
                try {
                    ok = workspace.setRoot(path);
                } catch (Throwable t) {
                    ok = false;
                }
                String message = ok
                        ? "工作区已切换"
                        : (workspace.lastError() == null ? "工作区切换失败" : workspace.lastError());
                emitWorkspaceChanged(ok, workspaceRootSafe(), message);
            }
        });
    }

    /** 补充：当前是否已授予「所有文件访问权限」（UI 可据此提示）。 */
    @JavascriptInterface
    public String allFilesAccess() {
        JSONObject o = new JSONObject();
        try {
            o.put("granted", workspace.hasAllFilesAccess());
            o.put("root", workspaceRootSafe());
        } catch (JSONException e) {
            return "{\"granted\":false}";
        }
        return o.toString();
    }

    /** 补充：打开系统「所有文件访问权限」页（Android 11+）。 */
    @JavascriptInterface
    public void openAllFilesAccessSettings() {
        try {
            workspace.openAllFilesAccessSettings();
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    // ============================================================ ARCH v2 P2 MCP Client

    /** SPEC N2 {@code mcpServers()}：配置数组 + status/message/toolCount/connected。 */
    @JavascriptInterface
    public String mcpServers() {
        try {
            return mcp.serversJson();
        } catch (Throwable t) {
            return "[]";
        }
    }

    /** SPEC N2 {@code mcpSaveServer(json)}：新增/更新（无 id 自动生成）；非法输入返回 false。 */
    @JavascriptInterface
    public boolean mcpSaveServer(String json) {
        try {
            return mcp.saveServer(json);
        } catch (Throwable t) {
            return false;
        }
    }

    /** SPEC N2 {@code mcpDeleteServer(id)}：断开并删除配置。 */
    @JavascriptInterface
    public void mcpDeleteServer(String id) {
        try {
            mcp.deleteServer(id);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    /** SPEC N2 {@code mcpConnect(id)}：后台握手（initialize → initialized → tools/list）。 */
    @JavascriptInterface
    public void mcpConnect(String id) {
        try {
            mcp.connect(id);
        } catch (Throwable t) {
            emitMcpStatus(id, McpManager.STATUS_ERROR, "连接失败：" + describe(t));
        }
    }

    /** SPEC N2 {@code mcpDisconnect(id)}：断开并注销该服务器注册的工具。 */
    @JavascriptInterface
    public void mcpDisconnect(String id) {
        try {
            mcp.disconnect(id);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    /** SPEC N2 {@code mcpRefreshTools(id)}：重新 tools/list 并刷新 ToolRegistry。 */
    @JavascriptInterface
    public void mcpRefreshTools(String id) {
        try {
            mcp.refreshTools(id);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    /** 补充：某个服务器当前工具列表 JSON 数组（UI 初次渲染/调试用）。 */
    @JavascriptInterface
    public String mcpTools(String id) {
        try {
            return mcp.toolsJson(id);
        } catch (Throwable t) {
            return "[]";
        }
    }

    private void emitMcpStatus(String id, String status, String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "mcp-status");
            o.put("id", id == null ? "" : id);
            o.put("status", status == null ? "error" : status);
            o.put("message", message == null ? "" : message);
        } catch (JSONException ignored) {
            return;
        }
        emitEvent(o.toString());
    }

    // ============================================================ ARCH v2 P3 插件目录 + 记忆

    /** SPEC P3 {@code pluginList()}：house-plugins 列表 JSON 数组。 */
    @JavascriptInterface
    public String pluginList() {
        try {
            return housePlugins.listJson();
        } catch (Throwable t) {
            return "[]";
        }
    }

    /** SPEC P3 {@code pluginRead(fileName)}（注入名 pluginReadFile）：源码文本；失败返回 ""。 */
    @JavascriptInterface
    public String pluginReadFile(String fileName) {
        try {
            String code = housePlugins.read(fileName);
            return code == null ? "" : code;
        } catch (Throwable t) {
            return "";
        }
    }

    /** SPEC P3 {@code pluginWrite(fileName,content)}：仅 app 目录；成功返回 true。 */
    @JavascriptInterface
    public boolean pluginWriteFile(String fileName, String content) {
        try {
            return housePlugins.write(fileName, content);
        } catch (Throwable t) {
            return false;
        }
    }

    /** SPEC P3 {@code pluginDelete(fileName)}：仅 app 目录；成功返回 true。 */
    @JavascriptInterface
    public boolean pluginDeleteFile(String fileName) {
        try {
            return housePlugins.delete(fileName);
        } catch (Throwable t) {
            return false;
        }
    }

    /** SPEC P3 {@code pluginSetEnabled(fileName,enabled)}：持久化 enabled；成功返回 true。 */
    @JavascriptInterface
    public boolean pluginSetEnabledFile(String fileName, boolean enabled) {
        try {
            return housePlugins.setEnabled(fileName, enabled);
        } catch (Throwable t) {
            return false;
        }
    }

    /** SPEC P3 {@code pluginHmac(content)}：HMAC-SHA256 小写 hex（市场签名校验）。 */
    @JavascriptInterface
    public String pluginHmac(String content) {
        try {
            return housePlugins.hmac(content);
        } catch (Throwable t) {
            return "";
        }
    }

    /** 补充：SHA-256(content) 小写 hex（WebCrypto 不可用时的市场校验兜底）。 */
    @JavascriptInterface
    public String pluginSha256(String content) {
        try {
            return housePlugins.sha256Of(content);
        } catch (Throwable t) {
            return "";
        }
    }

    /** SPEC P3 {@code pluginOpenDir()}：打开系统文件管理器到插件目录（失败回退剪贴板路径）。 */
    @JavascriptInterface
    public void pluginOpenDir() {
        try {
            housePlugins.openDir(activity);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    // ------------------------------------------------------------ 记忆（MemoryDb）

    /** SPEC P3 {@code memoryGetSummaries()}：[{chatId,summary,updatedAt}]。 */
    @JavascriptInterface
    public String memoryGetSummaries() {
        try {
            return memoryDb.summariesJson();
        } catch (Throwable t) {
            return "[]";
        }
    }

    /** SPEC P3 {@code memorySaveSummary}：后台排队写入（upsert）。 */
    @JavascriptInterface
    public void memorySaveSummary(final String chatId, final String summary) {
        submitMemoryWrite(new Runnable() {
            @Override
            public void run() {
                try {
                    memoryDb.saveSummary(chatId, summary);
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        });
    }

    /** SPEC P3 {@code memoryDeleteSummary}：后台排队删除。 */
    @JavascriptInterface
    public void memoryDeleteSummary(final String chatId) {
        submitMemoryWrite(new Runnable() {
            @Override
            public void run() {
                try {
                    memoryDb.deleteSummary(chatId);
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        });
    }

    /** SPEC P3 {@code memoryKvGet(scope)}：JSON 对象 {"key":"value"}。 */
    @JavascriptInterface
    public String memoryKvGet(String scope) {
        try {
            return memoryDb.kvJson(scope);
        } catch (Throwable t) {
            return "{}";
        }
    }

    /** SPEC P3 {@code memoryKvSet(scope,key,value)}：后台排队写入（scope ∈ long_term/project）。 */
    @JavascriptInterface
    public void memoryKvSet(final String scope, final String key, final String value) {
        submitMemoryWrite(new Runnable() {
            @Override
            public void run() {
                try {
                    memoryDb.setKv(scope, key, value);
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        });
    }

    /** SPEC P3 {@code memoryKvDelete(scope,key)}：后台排队删除。 */
    @JavascriptInterface
    public void memoryKvDelete(final String scope, final String key) {
        submitMemoryWrite(new Runnable() {
            @Override
            public void run() {
                try {
                    memoryDb.deleteKv(scope, key);
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        });
    }

    /** SPEC P3 {@code memoryAll()}：{summaries,long_term,project}。 */
    @JavascriptInterface
    public String memoryAll() {
        try {
            return memoryDb.allJson();
        } catch (Throwable t) {
            return "{\"summaries\":[],\"long_term\":{},\"project\":{}}";
        }
    }

    private void submitMemoryWrite(final Runnable task) {
        if (task == null || released) {
            return;
        }
        try {
            memoryPool.execute(task);
        } catch (Throwable ignored) {
            // 线程池已关闭（App 退出）时丢弃
        }
    }

    // ------------------------------------------------------------ P1 内部工具

    private void submitTool(final Runnable task) {
        if (task == null || released) {
            return;
        }
        try {
            toolPool.execute(task);
        } catch (Throwable t) {
            Thread thread = new Thread(task, "dsh-tool-fallback");
            thread.setDaemon(true);
            thread.start();
        }
    }

    /** 控制待确认队列规模：超过上限时丢弃最老的一半。 */
    private void prunePendingTools() {
        if (pendingTools.size() < MAX_PENDING_TOOLS) {
            return;
        }
        Iterator<Map.Entry<String, PendingTool>> iterator = pendingTools.entrySet().iterator();
        while (iterator.hasNext() && pendingTools.size() > MAX_PENDING_TOOLS / 2) {
            iterator.next();
            iterator.remove();
        }
    }

    /** 工作区根（初始化极端失败时返回空串而不是抛异常）。 */
    private String workspaceRootSafe() {
        try {
            return workspace.rootPath();
        } catch (Throwable t) {
            return "";
        }
    }

    private void auditTool(String tool, String args, String result, boolean ok, boolean confirmed) {
        try {
            auditDb.append(tool, args, result, ok, confirmed);
        } catch (Throwable ignored) {
            // 审计失败不影响工具返回
        }
    }

    private static JSONObject args(String key, String value) {
        JSONObject o = new JSONObject();
        try {
            o.put(key, value == null ? "" : value);
        } catch (JSONException ignored) {
            // 不可能失败：key 非 null
        }
        return o;
    }

    private static JSONObject args(String key1, String value1, String key2, String value2) {
        JSONObject o = args(key1, value1);
        try {
            o.put(key2, value2 == null ? "" : value2);
        } catch (JSONException ignored) {
            // 忽略
        }
        return o;
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

    // ------------------------------------------------------------ F3 备份导入

    /** F3：选一个文本/JSON 文件（SAF），读取后发 {@code file-imported} 事件。 */
    @JavascriptInterface
    public void importTextFile() {
        try {
            activity.startTextImport();
        } catch (Throwable t) {
            emitFileImported("", "", "无法打开文件选择器");
        }
    }

    // ------------------------------------------------------------ F6 图片输入

    /**
     * F6：source='gallery' 从相册选择，'camera' 调用系统相机拍照；
     * 结果缩放到最长边 ≤1280、JPEG 80、Base64 dataURL 后发 {@code image-picked}，
     * 失败发 {@code image-error}。
     */
    @JavascriptInterface
    public void pickImage(String source) {
        try {
            activity.startPickImage("camera".equalsIgnoreCase(source) ? "camera" : "gallery");
        } catch (Throwable t) {
            emitImageError("无法打开图片来源");
        }
    }

    // ------------------------------------------------------------ F7 后台生成 / 通知

    /** F7：生成开始/结束切换前台服务（低优先级「生成中」常驻通知）。 */
    @JavascriptInterface
    public void setForeground(boolean active, String text) {
        try {
            if (active) {
                GenerationService.start(activity, text);
            } else {
                GenerationService.stop(activity);
            }
        } catch (Throwable ignored) {
            // 前台服务失败不影响 SSE 流式读取（只是后台可能被系统回收）
        }
    }

    /** F7：完成通知（渠道「消息」）；API 33+ 未授予通知权限时静默丢弃。 */
    @JavascriptInterface
    public void notify(String title, String text) {
        try {
            Notifications.showMessage(activity, title, text);
        } catch (Throwable ignored) {
            // 忽略
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

    // ------------------------------------------------------------ F3 / F6 结果回调

    /** F3：备份文件读取结果（Activity.onActivityResult 转发）。 */
    void onTextImportResult(int resultCode, Intent data) {
        Uri uri = (resultCode == Activity.RESULT_OK && data != null) ? data.getData() : null;
        if (uri == null) {
            emitFileImported("", "", "cancelled");
            return;
        }
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                String name = "";
                try {
                    name = SafIo.displayName(activity, uri);
                    String content = SafIo.readText(activity, uri, SafIo.MAX_IMPORT_BYTES);
                    emitFileImported(name, content, null);
                } catch (Throwable t) {
                    emitFileImported(name, "", describe(t));
                }
            }
        }, "dsh-saf-text-import");
        thread.setDaemon(true);
        thread.start();
    }

    void onTextImportCancelled(String reason) {
        emitFileImported("", "", reason == null || reason.isEmpty() ? "cancelled" : reason);
    }

    /** F6：相机在 data extras 里返回的缩略图（部分机型无 EXTRA_OUTPUT 写入时兜底）。 */
    private static Bitmap extractThumbnail(Intent data) {
        if (data == null) {
            return null;
        }
        try {
            Bundle extras = data.getExtras();
            Object value = extras == null ? null : extras.get("data");
            return value instanceof Bitmap ? (Bitmap) value : null;
        } catch (Throwable t) {
            return null;
        }
    }

    /** F6：图片选择/拍照结果（Activity.onActivityResult 转发），解码缩图在后台线程。 */
    void onImageResult(int resultCode, Intent data, String source) {
        final boolean camera = "camera".equals(source);
        if (resultCode != Activity.RESULT_OK) {
            if (camera) {
                CameraFileProvider.cleanup(activity);
            }
            emitImageError("cancelled");
            return;
        }
        final Uri uri = data == null ? null : data.getData();
        final Bitmap thumbnail = camera ? extractThumbnail(data) : null;
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    ImageTools.Prepared prepared = null;
                    String imageName;
                    if (camera) {
                        File file = CameraFileProvider.fileFor(activity);
                        if (file != null && file.isFile() && file.length() > 0L) {
                            try {
                                prepared = ImageTools.prepareFromFile(file);
                            } catch (Throwable ignored) {
                                prepared = null; // 个别相机写坏文件时退回 data extras 缩略图
                            }
                        }
                        if (prepared == null && thumbnail != null) {
                            prepared = ImageTools.prepare(thumbnail);
                        }
                        if (prepared == null) {
                            throw new IOException("相机未返回照片");
                        }
                        imageName = CameraFileProvider.displayName();
                    } else {
                        if (uri == null) {
                            throw new IOException("未选择图片");
                        }
                        prepared = ImageTools.prepareFromUri(activity, uri);
                        imageName = SafIo.displayName(activity, uri);
                        if (imageName.isEmpty()) {
                            imageName = "image.jpg";
                        }
                    }
                    emitImagePicked(prepared, imageName);
                } catch (Throwable t) {
                    emitImageError(describe(t));
                } finally {
                    if (thumbnail != null && !thumbnail.isRecycled()) {
                        thumbnail.recycle();
                    }
                    if (camera) {
                        CameraFileProvider.cleanup(activity);
                    }
                }
            }
        }, "dsh-image-pick");
        thread.setDaemon(true);
        thread.start();
    }

    /** F6：直接上报图片错误（Activity 侧启动 Intent 失败时用）。 */
    void onImageError(String message) {
        emitImageError(message);
    }

    // ------------------------------------------------------------ F7 / F8 生命周期与分享

    /** F7：MainActivity onResume/onPause 变化时上报 {@code app-state} 事件。 */
    void onAppState(boolean foreground) {
        emitAppState(foreground);
    }

    /** WebView 首次加载完成：补发一次前台状态，并投递暂存的分享内容（只消费一次）。 */
    void onPageFinished() {
        pageReady = true;
        emitAppState(activity.isAppForeground());
        flushShare();
        // ARCH v2 P2：页面就绪后再自动连接 enabled 的 MCP 服务器（保证事件不丢）
        try {
            mcp.onPageReady();
        } catch (Throwable ignored) {
            // MCP 自动连接失败不影响首屏
        }
    }

    /**
     * F8：解析 {@code ACTION_SEND}（text/plain、image/*）的 EXTRA_TEXT / EXTRA_STREAM；
     * 图片在后台缩图，页面就绪后由 {@link #flushShare()} 一次性发 {@code shared} 事件。
     */
    void onShareIntent(final Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) {
            return;
        }
        String text = "";
        try {
            CharSequence cs = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (cs != null) {
                text = cs.toString();
            }
        } catch (Throwable ignored) {
            // 保持空文本
        }
        Uri stream = null;
        try {
            Object extra = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (extra instanceof Uri) {
                stream = (Uri) extra;
            }
        } catch (Throwable ignored) {
            // 保持 null
        }
        if (stream == null) {
            try {
                stream = intent.getData();
            } catch (Throwable ignored) {
                // 保持 null
            }
        }
        final String sharedText = text == null ? "" : text;
        final Uri sharedUri = stream;
        if (sharedText.isEmpty() && sharedUri == null) {
            return;
        }
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                String imageDataUrl = "";
                if (sharedUri != null) {
                    try {
                        imageDataUrl = ImageTools.prepareFromUri(activity, sharedUri).dataUrl;
                    } catch (Throwable ignored) {
                        // 非图片 / 无权限：只投递文本
                    }
                }
                synchronized (shareLock) {
                    sharedTextValue = sharedText;
                    sharedImageValue = imageDataUrl;
                    sharePending = true;
                }
                flushShare();
            }
        }, "dsh-shared-intent");
        thread.setDaemon(true);
        thread.start();
    }

    private void flushShare() {
        String text;
        String image;
        synchronized (shareLock) {
            if (!sharePending || !pageReady || released) {
                return;
            }
            sharePending = false;
            text = sharedTextValue == null ? "" : sharedTextValue;
            image = sharedImageValue == null ? "" : sharedImageValue;
            sharedTextValue = "";
            sharedImageValue = "";
        }
        emitShared(text, image);
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

    /** F3：{@code {"type":"file-imported","name":..,"content":..}}；取消/失败带 error。 */
    private void emitFileImported(String name, String content, String error) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "file-imported");
            o.put("content", content == null ? "" : content);
            if (name != null && !name.isEmpty()) {
                o.put("name", name);
            }
            if (error != null) {
                o.put("error", error);
            }
        } catch (JSONException ignored) {
            return;
        }
        emitEvent(o.toString());
    }

    /** F6：{@code {"type":"image-picked","dataUrl":..,"width":..,"height":..,"name":..}} */
    private void emitImagePicked(ImageTools.Prepared prepared, String name) {
        if (prepared == null || prepared.dataUrl == null || prepared.dataUrl.isEmpty()) {
            emitImageError("图片处理失败");
            return;
        }
        JSONObject o = new JSONObject();
        try {
            o.put("type", "image-picked");
            o.put("dataUrl", prepared.dataUrl);
            o.put("width", prepared.width);
            o.put("height", prepared.height);
            o.put("name", name == null ? "" : name);
        } catch (JSONException ignored) {
            return;
        }
        emitEvent(o.toString());
    }

    /** F6：{@code {"type":"image-error","message":..}} */
    private void emitImageError(String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "image-error");
            o.put("message", message == null || message.isEmpty() ? "图片处理失败" : message);
        } catch (JSONException ignored) {
            return;
        }
        emitEvent(o.toString());
    }

    /** F8：{@code {"type":"shared","text":..,"imageDataUrl":..}} */
    private void emitShared(String text, String imageDataUrl) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "shared");
            o.put("text", text == null ? "" : text);
            o.put("imageDataUrl", imageDataUrl == null ? "" : imageDataUrl);
        } catch (JSONException ignored) {
            return;
        }
        emitEvent(o.toString());
    }

    /** F7：{@code {"type":"app-state","foreground":true|false}} */
    private void emitAppState(boolean foreground) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "app-state");
            o.put("foreground", foreground);
        } catch (JSONException ignored) {
            return;
        }
        emitEvent(o.toString());
    }

    // ------------------------------------------------------------ ARCH v2 P1 事件

    /** {@code {"type":"tool-confirm","requestId":..,"tool":..,"args":{..},"risk":"high"}} */
    private void emitToolConfirm(String requestId, ToolDef def, JSONObject args) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "tool-confirm");
            o.put("requestId", requestId == null ? "" : requestId);
            o.put("tool", def == null ? "" : def.name());
            o.put("args", args == null ? new JSONObject() : args);
            o.put("risk", def == null ? "high" : def.risk().wireName());
            if (def != null && def.isRemote()) {
                // 附加字段（不影响 SPEC 既有字段）：UI 可显示原始工具名与来源服务器
                o.put("serverId", def.remote());
                o.put("displayName", def.displayName());
            }
        } catch (JSONException ignored) {
            return;
        }
        emitEvent(o.toString());
    }

    /** {@code {"type":"tool-result","requestId":..,"tool":..,"ok":true,"result":"..","confirmed":true}} */
    private void emitToolResult(String requestId, String tool, boolean ok,
                                String result, boolean confirmed) {
        emitToolResult(requestId, tool, ok, result, confirmed, "");
    }

    /** 同上；MCP 远程工具额外带 {@code serverId}（SPEC N2 可选 meta.serverId）。 */
    private void emitToolResult(String requestId, String tool, boolean ok,
                                String result, boolean confirmed, String serverId) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "tool-result");
            o.put("requestId", requestId == null ? "" : requestId);
            o.put("tool", tool == null ? "" : tool);
            o.put("ok", ok);
            o.put("result", result == null ? "" : result);
            o.put("confirmed", confirmed);
            if (serverId != null && !serverId.isEmpty()) {
                o.put("serverId", serverId);
            }
        } catch (JSONException ignored) {
            return;
        }
        emitEvent(o.toString());
    }

    /** 补充事件：{@code {"type":"workspace-changed","ok":true,"root":"..","message":".."}} */
    private void emitWorkspaceChanged(boolean ok, String root, String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "workspace-changed");
            o.put("ok", ok);
            o.put("root", root == null ? "" : root);
            o.put("message", message == null ? "" : message);
            o.put("allFilesAccess", workspace.hasAllFilesAccess());
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
