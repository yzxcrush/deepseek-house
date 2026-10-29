package com.deepseekhouse.app.mcp;

import android.content.Context;

import com.deepseekhouse.app.Prefs;
import com.deepseekhouse.app.agent.ToolDef;
import com.deepseekhouse.app.agent.ToolRegistry;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * MCP 连接管理器（SPEC「ARCH v2 P2」N2）。
 *
 * <p>职责：</p>
 * <ul>
 *   <li>读写 {@code Prefs.mcpServers} 配置（[{id,name,url,token,enabled}]）；</li>
 *   <li>每服务器一个 {@link JsonRpcClient}，负责 connect / disconnect / 指数退避重连 / 25s 心跳；</li>
 *   <li>连接成功后 {@code tools/list} → 注册到 {@link ToolRegistry}
 *       （id {@code mcp:<serverId>:<name>}、risk MID、needConfirm true、remote=serverId）；断开时注销；</li>
 *   <li>把 {@code tools/call} 转发给远端服务器，结果文本交给 JsBridge 复用 {@code tool-result} 事件；</li>
 *   <li>事件：{@code mcp-status} / {@code mcp-tools} / {@code mcp-progress}。</li>
 * </ul>
 *
 * <p>线程模型：状态读写统一在 {@link #lock} 下；握手/刷新在 {@link #ioPool}；
 * 重连与心跳计时在单线程 {@link #scheduler}（心跳任务再转投 ioPool，避免阻塞计时线程）。</p>
 */
public final class McpManager {

    public interface EventSink {
        void emit(String json);
    }

    /** 一次 MCP 工具调用的结果。 */
    public static final class ToolCallResult {
        public final boolean ok;
        public final String text;

        private ToolCallResult(boolean ok, String text) {
            this.ok = ok;
            this.text = text == null ? "" : text;
        }

        public static ToolCallResult ok(String text) {
            return new ToolCallResult(true, text);
        }

        public static ToolCallResult fail(String text) {
            return new ToolCallResult(false, text);
        }
    }

    public static final String STATUS_CONNECTING = "connecting";
    public static final String STATUS_CONNECTED = "connected";
    public static final String STATUS_DISCONNECTED = "disconnected";
    public static final String STATUS_ERROR = "error";

    /** initialize.clientInfo.version（SPEC P2 指定 2.1.0）。 */
    public static final String CLIENT_VERSION = "2.1.0";

    /** 重连退避：1s/2s/4s/8s/16s/30s（上限 30s）。 */
    private static final long RECONNECT_BASE_MS = 1000L;
    private static final long RECONNECT_MAX_MS = 30 * 1000L;
    private static final int RECONNECT_MAX_STEPS = 6;
    /** 心跳间隔 25s（SPEC）。 */
    private static final long HEARTBEAT_INTERVAL_MS = 25 * 1000L;
    private static final int TOOL_ID_MAX_LENGTH = 64;
    private static final String TOOL_ID_PREFIX = "mcp:";
    private static final String FUNCTION_PREFIX = "mcp_";

    private static final SecureRandom RANDOM = new SecureRandom();

    private final Context context;
    private final Prefs prefs;
    private final EventSink sink;
    private final ToolRegistry registry;
    private final String clientVersion;

    private final Object lock = new Object();
    private final List<McpServerConfig> configs = new ArrayList<>();
    private final Map<String, ServerState> states = new LinkedHashMap<>();
    private final ScheduledExecutorService scheduler;
    private final ExecutorService ioPool;

    private volatile boolean closed;
    private volatile boolean autoConnectStarted;

    /** 单服务器运行时状态。 */
    private static final class ServerState {
        final String id;
        String name;
        String url;
        String token;
        boolean enabled;
        String status = STATUS_DISCONNECTED;
        String message = "";
        boolean desired;
        int attempt;
        /** 连接代际：只有最新一代的握手可以安装 client/调度重连，避免旧请求覆盖新配置。 */
        int generation;
        JsonRpcClient client;
        List<RemoteTool> tools = new ArrayList<>();
        ScheduledFuture<?> heartbeatFuture;
        ScheduledFuture<?> reconnectFuture;

        ServerState(McpServerConfig config) {
            this.id = config.id;
            this.name = config.name;
            this.url = config.url;
            this.token = config.token;
            this.enabled = config.enabled;
        }
    }

    /** 从 tools/list 解析出的远端工具。 */
    private static final class RemoteTool {
        final String name;
        final String description;
        final String inputSchemaJson;
        String functionName = "";

        RemoteTool(String name, String description, String inputSchemaJson) {
            this.name = name;
            this.description = description;
            this.inputSchemaJson = inputSchemaJson;
        }
    }

    public McpManager(Context context, Prefs prefs, EventSink sink, ToolRegistry registry) {
        if (context == null) {
            throw new IllegalArgumentException("context == null");
        }
        this.context = context.getApplicationContext();
        this.prefs = prefs == null ? new Prefs(this.context) : prefs;
        this.sink = sink;
        this.registry = registry == null ? ToolRegistry.getInstance() : registry;
        this.clientVersion = CLIENT_VERSION;
        loadConfigs();
        final AtomicInteger seq = new AtomicInteger(1);
        ThreadFactory ioFactory = new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "dsh-mcp-io-" + seq.getAndIncrement());
                t.setDaemon(true);
                return t;
            }
        };
        ThreadFactory schedulerFactory = new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "dsh-mcp-sched");
                t.setDaemon(true);
                return t;
            }
        };
        this.ioPool = Executors.newCachedThreadPool(ioFactory);
        this.scheduler = Executors.newSingleThreadScheduledExecutor(schedulerFactory);
    }

    public String clientVersion() {
        return clientVersion;
    }

    // ------------------------------------------------------------ 配置读写

    private void loadConfigs() {
        List<McpServerConfig> loaded = new ArrayList<>();
        String raw = "";
        try {
            raw = prefs.getMcpServersJson();
            JSONArray array = new JSONArray(raw == null || raw.trim().isEmpty() ? "[]" : raw);
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                McpServerConfig config = McpServerConfig.fromJson(item);
                if (config == null) {
                    continue;
                }
                String id = McpServerConfig.sanitizeId(config.id);
                if (id.isEmpty() || containsConfig(loaded, id)) {
                    id = generateId(loaded);
                }
                config.id = id;
                loaded.add(config);
            }
        } catch (Throwable ignored) {
            // 配置损坏时按空列表启动，不阻塞 App
        }
        synchronized (lock) {
            configs.clear();
            configs.addAll(loaded);
            states.clear();
            for (McpServerConfig config : configs) {
                states.put(config.id, new ServerState(config.copy()));
            }
        }
    }

    private static boolean containsConfig(List<McpServerConfig> list, String id) {
        for (McpServerConfig config : list) {
            if (config.id.equals(id)) {
                return true;
            }
        }
        return false;
    }

    private String generateId(List<McpServerConfig> known) {
        for (int i = 0; i < 100; i++) {
            byte[] bytes = new byte[4];
            RANDOM.nextBytes(bytes);
            StringBuilder sb = new StringBuilder("srv");
            for (byte b : bytes) {
                sb.append(String.format(Locale.US, "%02x", b & 0xFF));
            }
            String id = sb.toString();
            if (!containsConfig(known, id)) {
                return id;
            }
        }
        return "srv" + System.currentTimeMillis();
    }

    private void persistLocked() {
        JSONArray array = new JSONArray();
        for (McpServerConfig config : configs) {
            array.put(config.toJson());
        }
        try {
            prefs.setMcpServersJson(array.toString());
        } catch (Throwable ignored) {
            // 持久化失败不影响当前会话
        }
    }

    /**
     * SPEC {@code mcpServers()}：配置数组 + 运行时状态
     * （{@code status/message/toolCount/connected} 为附加字段）。
     */
    public String serversJson() {
        JSONArray array = new JSONArray();
        synchronized (lock) {
            for (McpServerConfig config : configs) {
                ServerState state = states.get(config.id);
                JSONObject item = config.toJson();
                try {
                    item.put("status", state == null ? STATUS_DISCONNECTED : state.status);
                    item.put("message", state == null || state.message == null ? "" : state.message);
                    item.put("toolCount", state == null ? 0 : state.tools.size());
                    item.put("connected", state != null && STATUS_CONNECTED.equals(state.status));
                } catch (JSONException ignored) {
                    // 忽略
                }
                array.put(item);
            }
        }
        return array.toString();
    }

    /**
     * SPEC {@code mcpSaveServer(json)}：新增/更新配置，无 id 自动生成。
     * URL 非法或 JSON 非法返回 false。
     */
    public boolean saveServer(String json) {
        if (json == null || json.trim().isEmpty()) {
            return false;
        }
        JSONObject input;
        try {
            input = new JSONObject(json);
        } catch (JSONException e) {
            return false;
        }
        McpServerConfig parsed = McpServerConfig.fromJson(input);
        if (parsed == null || !McpServerConfig.isValidUrl(parsed.url)) {
            return false;
        }
        String connectAfter = "";
        synchronized (lock) {
            String requestedId = McpServerConfig.sanitizeId(parsed.id);
            McpServerConfig existing = requestedId.isEmpty() ? null : findConfigLocked(requestedId);
            String targetId;
            if (existing == null) {
                String id = requestedId.isEmpty() ? generateIdLocked() : requestedId;
                McpServerConfig created = new McpServerConfig(id, parsed.name, parsed.url,
                        parsed.token, parsed.enabled);
                configs.add(created);
                states.put(created.id, new ServerState(created.copy()));
                targetId = created.id;
            } else {
                boolean endpointChanged = !existing.sameEndpoint(parsed);
                existing.name = parsed.name;
                existing.url = parsed.url;
                existing.token = parsed.token;
                existing.enabled = parsed.enabled;
                ServerState state = states.get(existing.id);
                if (state != null) {
                    state.name = existing.name;
                    state.url = existing.url;
                    state.token = existing.token;
                    state.enabled = existing.enabled;
                    boolean wasActive = state.desired || state.client != null
                            || STATUS_CONNECTED.equals(state.status)
                            || STATUS_CONNECTING.equals(state.status);
                    if ((endpointChanged || !existing.enabled) && wasActive) {
                        disconnectLocked(state, endpointChanged
                                ? "配置已更新，连接已断开" : "服务器已禁用");
                    }
                }
                targetId = existing.id;
            }
            persistLocked();
            // 页面就绪后保存 enabled 服务器 → 直接连接（UI「保存并连接」不用自己知道生成 id）
            ServerState targetState = states.get(targetId);
            if (autoConnectStarted && !closed && parsed.enabled && targetState != null
                    && !targetState.desired
                    && STATUS_DISCONNECTED.equals(targetState.status)) {
                connectAfter = targetId;
            }
        }
        if (!connectAfter.isEmpty()) {
            connect(connectAfter);
        }
        return true;
    }

    /** SPEC {@code mcpDeleteServer(id)}：断开并删除配置。 */
    public void deleteServer(String rawId) {
        String id = safeId(rawId);
        if (id.isEmpty()) {
            return;
        }
        synchronized (lock) {
            ServerState state = states.remove(id);
            if (state != null) {
                disconnectLocked(state, "服务器已删除");
            }
            McpServerConfig config = findConfigLocked(id);
            if (config != null) {
                configs.remove(config);
                persistLocked();
            }
        }
    }

    private McpServerConfig findConfigLocked(String id) {
        for (McpServerConfig config : configs) {
            if (config.id.equals(id)) {
                return config;
            }
        }
        return null;
    }

    private String generateIdLocked() {
        return generateId(configs);
    }

    // ------------------------------------------------------------ 连接生命周期

    /** SPEC {@code mcpConnect(id)}：连接（幂等；已连接/连接中直接返回）。 */
    public void connect(String rawId) {
        String id = safeId(rawId);
        ServerState state;
        int generation;
        synchronized (lock) {
            state = states.get(id);
            if (state == null) {
                emitStatus(id, STATUS_ERROR, "服务器不存在：" + id);
                return;
            }
            state.desired = true;
            if (!McpServerConfig.isValidUrl(state.url)) {
                state.desired = false;
                setStatusLocked(state, STATUS_ERROR,
                        "服务器 URL 不合法（仅支持 http/https 且需含主机名）");
                return;
            }
            if (STATUS_CONNECTING.equals(state.status) || STATUS_CONNECTED.equals(state.status)) {
                return;
            }
            state.attempt = 0;
            cancelFuture(state.reconnectFuture);
            state.reconnectFuture = null;
            state.generation++;
            setStatusLocked(state, STATUS_CONNECTING, "正在连接…");
            generation = state.generation;
        }
        startHandshake(state, generation);
    }

    /** SPEC {@code mcpDisconnect(id)}：断开并注销该服务器工具；保留配置。 */
    public void disconnect(String rawId) {
        String id = safeId(rawId);
        synchronized (lock) {
            ServerState state = states.get(id);
            if (state == null) {
                return;
            }
            disconnectLocked(state, "已断开");
        }
    }

    /** 用户主动刷新工具列表（未连接时回 error 状态事件）。 */
    public void refreshTools(String rawId) {
        String id = safeId(rawId);
        ServerState state;
        JsonRpcClient client;
        synchronized (lock) {
            state = states.get(id);
            if (state == null) {
                emitStatus(id, STATUS_ERROR, "服务器不存在：" + id);
                return;
            }
            client = state.client;
            if (client == null || !STATUS_CONNECTED.equals(state.status)) {
                setStatusLocked(state, STATUS_ERROR, "服务器未连接，无法刷新工具");
                return;
            }
        }
        final ServerState target = state;
        final JsonRpcClient activeClient = client;
        ioPool.execute(new Runnable() {
            @Override
            public void run() {
                refreshToolsAsync(target, activeClient);
            }
        });
    }

    /** 某个服务器当前工具列表 JSON（UI 渲染用，附加字段 function/id/risk）。 */
    public String toolsJson(String rawId) {
        String id = safeId(rawId);
        JSONArray array = new JSONArray();
        synchronized (lock) {
            ServerState state = states.get(id);
            if (state == null) {
                return "[]";
            }
            for (RemoteTool tool : state.tools) {
                JSONObject item = new JSONObject();
                try {
                    item.put("name", tool.name);
                    item.put("description", tool.description);
                    item.put("id", TOOL_ID_PREFIX + state.id + ":" + tool.name);
                    item.put("function", tool.functionName);
                    item.put("risk", "mid");
                } catch (JSONException ignored) {
                    // 忽略
                }
                array.put(item);
            }
        }
        return array.toString();
    }

    /**
     * WebView 页面就绪后自动连接所有 {@code enabled} 的服务器（只触发一次）。
     * 由 JsBridge.onPageFinished() 调用，保证 mcp-status/mcp-tools 事件不会在页面监听注册前丢失。
     */
    public void onPageReady() {
        List<String> ids = new ArrayList<>();
        synchronized (lock) {
            if (closed || autoConnectStarted) {
                return;
            }
            autoConnectStarted = true;
            for (McpServerConfig config : configs) {
                ServerState state = states.get(config.id);
                if (state != null && config.enabled
                        && STATUS_DISCONNECTED.equals(state.status) && !state.desired) {
                    ids.add(config.id);
                }
            }
        }
        for (String id : ids) {
            connect(id);
        }
    }

    /** JsBridge.release()：静默断开全部连接、注销远程工具、关闭线程池。 */
    public void shutdown() {
        List<JsonRpcClient> clients = new ArrayList<>();
        synchronized (lock) {
            if (closed) {
                return;
            }
            closed = true;
            for (ServerState state : states.values()) {
                state.desired = false;
                cancelFuture(state.heartbeatFuture);
                state.heartbeatFuture = null;
                cancelFuture(state.reconnectFuture);
                state.reconnectFuture = null;
                if (state.client != null) {
                    clients.add(state.client);
                    state.client = null;
                }
                state.tools = new ArrayList<>();
                state.status = STATUS_DISCONNECTED;
                state.message = "";
            }
            try {
                registry.clearRemote();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
        for (JsonRpcClient client : clients) {
            try {
                client.shutdown();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
        try {
            scheduler.shutdownNow();
        } catch (Throwable ignored) {
            // 忽略
        }
        try {
            ioPool.shutdownNow();
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    // ------------------------------------------------------------ 工具调用转发

    /**
     * 转发 {@code tools/call}。
     *
     * @param serverId   MCP 服务器 id（ToolDef.remote）
     * @param remoteTool 服务器上的原始工具名（ToolDef.remoteTool）
     * @param openAiTool OpenAI function 名（用于进度事件归属）
     */
    public ToolCallResult callTool(String serverId, String remoteTool,
                                   String openAiTool, JSONObject arguments) {
        String id = safeId(serverId);
        ServerState state;
        JsonRpcClient client;
        synchronized (lock) {
            state = states.get(id);
            if (state == null) {
                return ToolCallResult.fail("MCP 服务器不存在：" + id);
            }
            client = state.client;
            if (client == null || !STATUS_CONNECTED.equals(state.status)) {
                String label = state.name == null || state.name.isEmpty() ? id : state.name;
                return ToolCallResult.fail("MCP 服务器未连接：" + label
                        + "（请先在设置中连接，或检查 Termux 端是否在运行）");
            }
        }
        if (closed) {
            return ToolCallResult.fail("MCP 客户端已关闭");
        }
        try {
            JSONObject result = client.callTool(remoteTool, arguments, openAiTool,
                    JsonRpcClient.TOOL_CALL_TIMEOUT_MS);
            String text = extractContentText(result);
            boolean isError = result.optBoolean("isError", false);
            if (text.isEmpty()) {
                text = isError ? "MCP 工具返回错误（无文本内容）" : "MCP 工具执行完成（无文本内容）";
            }
            return new ToolCallResult(!isError, text);
        } catch (JsonRpcClient.RpcError e) {
            // 业务错误：连接本身仍可用，不触发重连
            return ToolCallResult.fail("MCP 工具错误：" + e.getMessage());
        } catch (Throwable t) {
            // 传输/超时错误：连接可能已失效，交给重连逻辑
            handleFailure(state, client, "MCP 调用失败：" + message(t));
            return ToolCallResult.fail("MCP 调用失败：" + message(t));
        }
    }

    /** 测试钩子（JVM 单测用，不改变生产行为）：解析 tools/call 结果文本。 */
    static String extractContentTextForTest(JSONObject result) {
        return extractContentText(result);
    }

    /** 拼接 tools/call result.content[] 里的 text（兼容 structuredContent）。 */
    private static String extractContentText(JSONObject result) {
        StringBuilder sb = new StringBuilder();
        JSONArray content = result.optJSONArray("content");
        if (content != null) {
            for (int i = 0; i < content.length(); i++) {
                Object raw = content.opt(i);
                String text = "";
                if (raw instanceof JSONObject) {
                    JSONObject item = (JSONObject) raw;
                    String type = item.optString("type", "");
                    if ("text".equals(type) || item.has("text")) {
                        text = item.optString("text", "");
                    }
                    if (text.isEmpty() && "resource".equals(type)) {
                        JSONObject resource = item.optJSONObject("resource");
                        if (resource != null) {
                            text = resource.optString("text", "");
                            if (text.isEmpty()) {
                                text = resource.toString();
                            }
                        }
                    }
                    if (text.isEmpty()) {
                        text = item.toString();
                    }
                } else if (raw != null && raw != JSONObject.NULL) {
                    text = String.valueOf(raw);
                }
                if (!text.isEmpty()) {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append(text);
                }
            }
        }
        if (sb.length() == 0) {
            JSONObject structured = result.optJSONObject("structuredContent");
            if (structured != null) {
                sb.append(structured.toString());
            }
        }
        return sb.toString().trim();
    }

    // ------------------------------------------------------------ 握手 / 重连 / 心跳

    private void startHandshake(final ServerState state, final int generation) {
        try {
            ioPool.execute(new Runnable() {
                @Override
                public void run() {
                    handshakeAsync(state, generation);
                }
            });
        } catch (Throwable ignored) {
            // ioPool 已关闭
        }
    }

    private void handshakeAsync(ServerState state, int generation) {
        JsonRpcClient client = null;
        try {
            String url;
            String token;
            synchronized (lock) {
                if (closed || !state.desired || state.generation != generation) {
                    return;
                }
                url = state.url;
                token = state.token;
            }
            client = new JsonRpcClient(state.id, url, token, clientVersion,
                    new JsonRpcClient.ProgressSink() {
                        @Override
                        public void onProgress(String serverId, String toolName,
                                               int percent, String line) {
                            emitProgress(serverId, toolName, percent, line);
                        }
                    });
            client.initialize();
            client.notificationsInitialized();
            JSONArray tools = client.listTools();

            synchronized (lock) {
                if (closed || !state.desired || state.generation != generation) {
                    client.shutdown();
                    return;
                }
                state.client = client;
                state.tools = parseTools(tools);
                registerToolsLocked(state);
                state.attempt = 0;
                setStatusLocked(state, STATUS_CONNECTED,
                        "已连接（" + state.tools.size() + " 个工具）");
                emitToolsLocked(state);
                scheduleHeartbeatLocked(state, client);
            }
        } catch (Throwable t) {
            if (client != null) {
                client.shutdown();
            }
            synchronized (lock) {
                if (closed || state.generation != generation) {
                    return;
                }
                if (!state.desired) {
                    state.client = null;
                    registry.removeRemote(state.id);
                    state.tools = new ArrayList<>();
                    setStatusLocked(state, STATUS_DISCONNECTED, "已断开");
                    return;
                }
                state.client = null;
                registry.removeRemote(state.id);
                state.tools = new ArrayList<>();
                setStatusLocked(state, STATUS_ERROR, "连接失败：" + message(t));
                scheduleReconnectLocked(state);
            }
        }
    }

    private void refreshToolsAsync(ServerState state, JsonRpcClient client) {
        try {
            JSONArray tools = client.listTools();
            synchronized (lock) {
                if (closed || !state.desired || state.client != client) {
                    return;
                }
                state.tools = parseTools(tools);
                registerToolsLocked(state);
                setStatusLocked(state, STATUS_CONNECTED,
                        "工具列表已刷新（" + state.tools.size() + " 个）");
                emitToolsLocked(state);
            }
        } catch (Throwable t) {
            handleFailure(state, client, "刷新工具失败：" + message(t));
        }
    }

    /** 心跳：25s 一次 ping；服务器未实现 ping（-32601）时退回 tools/list。 */
    private void scheduleHeartbeatLocked(final ServerState state, final JsonRpcClient client) {
        cancelFuture(state.heartbeatFuture);
        state.heartbeatFuture = scheduler.schedule(new Runnable() {
            @Override
            public void run() {
                try {
                    ioPool.execute(new Runnable() {
                        @Override
                        public void run() {
                            heartbeatAsync(state, client);
                        }
                    });
                } catch (Throwable ignored) {
                    // ioPool 已关闭（App 退出）：忽略
                }
            }
        }, HEARTBEAT_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    private void heartbeatAsync(ServerState state, JsonRpcClient client) {
        try {
            try {
                client.ping(JsonRpcClient.HEARTBEAT_TIMEOUT_MS);
            } catch (JsonRpcClient.RpcError e) {
                if (e.code == -32601) {
                    // 服务器未实现 ping，用 tools/list 代替心跳
                    client.listTools();
                } else {
                    throw e;
                }
            }
            synchronized (lock) {
                if (closed || !state.desired || state.client != client) {
                    return;
                }
                scheduleHeartbeatLocked(state, client);
            }
        } catch (Throwable t) {
            handleFailure(state, client, "心跳失败：" + message(t));
        }
    }

    /** 指数退避：1s/2s/4s/8s/16s/30s，成功后 attempt 归零。 */
    private void scheduleReconnectLocked(final ServerState state) {
        if (closed || !state.desired) {
            return;
        }
        cancelFuture(state.reconnectFuture);
        state.attempt = Math.min(state.attempt + 1, RECONNECT_MAX_STEPS);
        int shift = Math.min(state.attempt - 1, 5);
        long delay = Math.min(RECONNECT_BASE_MS * (1L << shift), RECONNECT_MAX_MS);
        final int attempt = state.attempt;
        state.reconnectFuture = scheduler.schedule(new Runnable() {
            @Override
            public void run() {
                int generation;
                synchronized (lock) {
                    if (closed || !state.desired) {
                        return;
                    }
                    if (STATUS_CONNECTED.equals(state.status)
                            || STATUS_CONNECTING.equals(state.status)) {
                        return;
                    }
                    state.generation++;
                    generation = state.generation;
                    setStatusLocked(state, STATUS_CONNECTING,
                            "重连中（第 " + attempt + " 次）…");
                }
                startHandshake(state, generation);
            }
        }, delay, TimeUnit.MILLISECONDS);
    }

    /**
     * 连接失效统一入口：注销工具、置 error、按退避计划重连。
     * 陈旧 client（已被替换/主动断开）的失败直接忽略。
     */
    private void handleFailure(ServerState state, JsonRpcClient expectedClient, String reason) {
        JsonRpcClient toClose = null;
        synchronized (lock) {
            if (closed) {
                return;
            }
            if (expectedClient != null && state.client != null
                    && state.client != expectedClient) {
                return;
            }
            if (!state.desired) {
                toClose = state.client;
                state.client = null;
                registry.removeRemote(state.id);
                state.tools = new ArrayList<>();
                cancelFuture(state.heartbeatFuture);
                state.heartbeatFuture = null;
                setStatusLocked(state, STATUS_DISCONNECTED, "已断开");
            } else {
                toClose = expectedClient;
                state.client = null;
                registry.removeRemote(state.id);
                state.tools = new ArrayList<>();
                cancelFuture(state.heartbeatFuture);
                state.heartbeatFuture = null;
                setStatusLocked(state, STATUS_ERROR, reason == null ? "连接异常" : reason);
                scheduleReconnectLocked(state);
            }
        }
        if (toClose != null) {
            try {
                toClose.shutdown();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
    }

    private void disconnectLocked(ServerState state, String message) {
        state.desired = false;
        state.generation++;
        cancelFuture(state.heartbeatFuture);
        state.heartbeatFuture = null;
        cancelFuture(state.reconnectFuture);
        state.reconnectFuture = null;
        JsonRpcClient client = state.client;
        state.client = null;
        registry.removeRemote(state.id);
        state.tools = new ArrayList<>();
        state.attempt = 0;
        setStatusLocked(state, STATUS_DISCONNECTED, message);
        if (client != null) {
            try {
                client.shutdown();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
    }

    private static void cancelFuture(ScheduledFuture<?> future) {
        if (future == null) {
            return;
        }
        try {
            future.cancel(false);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    // ------------------------------------------------------------ 工具注册

    private void registerToolsLocked(ServerState state) {
        registry.removeRemote(state.id);
        // 已注册的本地/其它服务器工具名先占位，保证本次注册后全局 function 名唯一
        Set<String> usedNames = new HashSet<>();
        for (ToolDef existing : registry.all()) {
            usedNames.add(existing.name());
        }
        for (RemoteTool tool : state.tools) {
            tool.functionName = resolveFunctionName(state.id, tool.name, usedNames);
            String toolId = TOOL_ID_PREFIX + state.id + ":" + tool.name;
            registry.register(new ToolDef(
                    tool.functionName,
                    tool.description,
                    tool.inputSchemaJson,
                    ToolDef.Risk.MID,
                    true,
                    toolId,
                    state.id,
                    tool.name));
        }
    }

    private static List<RemoteTool> parseTools(JSONArray array) {
        List<RemoteTool> list = new ArrayList<>();
        if (array == null) {
            return list;
        }
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) {
                continue;
            }
            String name = item.optString("name", "").trim();
            if (name.isEmpty() || seen.contains(name)) {
                continue;
            }
            seen.add(name);
            String description = item.optString("description", "");
            if (description == null) {
                description = "";
            }
            JSONObject schema = item.optJSONObject("inputSchema");
            String schemaJson = schema == null
                    ? "{\"type\":\"object\",\"properties\":{}}" : schema.toString();
            list.add(new RemoteTool(name, description, schemaJson));
        }
        return list;
    }

    /**
     * 选择 OpenAI function 名：优先使用 MCP 工具原始名（{@code pack_apk} 等，UI/日志更直观）；
     * 仅当原始名含非法字符、超长或与已注册工具重名时，回退为 {@code mcp_<serverId>_<toolName>}。
     */
    static String resolveFunctionName(String serverId, String toolName, Set<String> used) {
        String raw = toolName == null ? "" : toolName.trim();
        if (isPlainFunctionName(raw) && !used.contains(raw)) {
            used.add(raw);
            return raw;
        }
        return makeFunctionName(serverId, toolName, used);
    }

    private static boolean isPlainFunctionName(String raw) {
        if (raw == null || raw.isEmpty() || raw.length() > TOOL_ID_MAX_LENGTH) {
            return false;
        }
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            boolean allowed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '_' || c == '-';
            if (!allowed) {
                return false;
            }
        }
        return true;
    }

    /**
     * MCP 工具 → OpenAI function 名兜底：{@code mcp_<serverId>_<toolName>}。
     * OpenAI 只接受 [A-Za-z0-9_-] 且 ≤64 字符，因此做清洗 + 超长哈希后缀 + 同名去重。
     */
    static String makeFunctionName(String serverId, String toolName, Set<String> used) {
        String base = FUNCTION_PREFIX + sanitizePart(serverId) + "_" + sanitizePart(toolName);
        if (base.length() > TOOL_ID_MAX_LENGTH) {
            String hash = Integer.toHexString(base.hashCode());
            base = base.substring(0, Math.max(1, TOOL_ID_MAX_LENGTH - hash.length() - 1)) + "_" + hash;
        }
        if (base.length() > TOOL_ID_MAX_LENGTH) {
            base = base.substring(0, TOOL_ID_MAX_LENGTH);
        }
        String candidate = base;
        int suffix = 2;
        while (used.contains(candidate)) {
            String tail = "_" + suffix;
            candidate = base.length() + tail.length() > TOOL_ID_MAX_LENGTH
                    ? base.substring(0, TOOL_ID_MAX_LENGTH - tail.length()) + tail
                    : base + tail;
            suffix++;
        }
        used.add(candidate);
        return candidate;
    }

    private static String sanitizePart(String raw) {
        String value = raw == null ? "" : raw.trim();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '_' || c == '-') {
                sb.append(c);
            } else {
                sb.append('_');
            }
        }
        String result = sb.toString();
        return result.isEmpty() ? "tool" : result;
    }

    // ------------------------------------------------------------ 事件

    private void emitToolsLocked(ServerState state) {
        JSONArray array = new JSONArray();
        for (RemoteTool tool : state.tools) {
            JSONObject item = new JSONObject();
            try {
                item.put("name", tool.name);
                item.put("description", tool.description);
                item.put("id", TOOL_ID_PREFIX + state.id + ":" + tool.name);
                item.put("function", tool.functionName);
                item.put("risk", "mid");
            } catch (JSONException ignored) {
                // 忽略
            }
            array.put(item);
        }
        JSONObject event = new JSONObject();
        try {
            event.put("type", "mcp-tools");
            event.put("id", state.id);
            event.put("tools", array);
        } catch (JSONException ignored) {
            return;
        }
        emit(event);
    }

    private void setStatusLocked(ServerState state, String status, String message) {
        state.status = status == null ? STATUS_DISCONNECTED : status;
        state.message = message == null ? "" : message;
        emitStatus(state.id, state.status, state.message);
    }

    private void emitStatus(String id, String status, String message) {
        JSONObject event = new JSONObject();
        try {
            event.put("type", "mcp-status");
            event.put("id", id == null ? "" : id);
            event.put("status", status == null ? STATUS_DISCONNECTED : status);
            event.put("message", message == null ? "" : message);
        } catch (JSONException ignored) {
            return;
        }
        emit(event);
    }

    /** {@code {"type":"mcp-progress","id":serverId,"tool":functionName,"percent":0-100,"line":".."}} */
    private void emitProgress(String serverId, String toolName, int percent, String line) {
        if (closed) {
            return;
        }
        JSONObject event = new JSONObject();
        try {
            event.put("type", "mcp-progress");
            event.put("id", serverId == null ? "" : serverId);
            event.put("tool", toolName == null ? "" : toolName);
            event.put("percent", Math.max(0, Math.min(100, percent)));
            event.put("line", line == null ? "" : line);
        } catch (JSONException ignored) {
            return;
        }
        emit(event);
    }

    private void emit(JSONObject event) {
        if (event == null || sink == null) {
            return;
        }
        try {
            sink.emit(event.toString());
        } catch (Throwable ignored) {
            // 事件通道异常不影响 MCP 主流程
        }
    }

    // ------------------------------------------------------------ 工具方法

    private static String safeId(String raw) {
        return raw == null ? "" : raw.trim();
    }

    private static String message(Throwable t) {
        if (t == null) {
            return "未知错误";
        }
        String message = t.getMessage();
        return message == null || message.trim().isEmpty()
                ? t.getClass().getSimpleName() : message;
    }

}
