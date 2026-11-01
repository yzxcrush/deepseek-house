package com.deepseekhouse.app.bot;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * QQ 官方机器人 WebSocket 网关客户端（v3.2.0，纯 Java，无第三方库）。
 *
 * <p>流程：GET {base}/gateway（Authorization: QQBot &lt;token&gt;）→ wss URL →
 * 手写 RFC6455 握手（SSLSocket）→ Hello(op10) → Identify(op2) →
 * 心跳(op1，携带 d=last_seq) / Ack(op11) → Dispatch(op0) 事件 → Reconnect(op7)/InvalidSession(op9) 处理。</p>
 *
 * <p>仅使用 core Java（SSLSocket / org.json），可在 JVM 上对本地 mock WS server 做端到端测试
 * （测试用构造允许 ws:// 与 http gateway）。</p>
 *
 * <p>线程：manager 线程负责连接与指数退避重连（1s→30s，用户 stop 才停）；每个连接一个读线程
 * （解析帧/事件）与一个心跳线程。token 只经 {@link TokenProvider} 获取，不写日志。</p>
 */
public final class QqBotWsClient {

    public static final String STATUS_CONNECTING = "connecting";
    public static final String STATUS_CONNECTED = "connected";
    public static final String STATUS_RECONNECTING = "reconnecting";
    public static final String STATUS_ERROR = "error";
    public static final String STATUS_STOPPED = "stopped";

    public static final int MAX_MESSAGE_BYTES = 1024 * 1024;

    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final long[] RECONNECT_DELAYS = new long[]{
            1000L, 2000L, 4000L, 8000L, 16000L, 30000L
    };
    private static final int CONNECT_TIMEOUT_MS = 20 * 1000;
    private static final long READY_TIMEOUT_MS = 40 * 1000L;
    private static final long MAX_HEARTBEAT_INTERVAL_MS = 120 * 1000L;

    private static final int OP_CONTINUATION = 0x0;
    private static final int OP_TEXT = 0x1;
    private static final int OP_BINARY = 0x2;
    private static final int OP_CLOSE = 0x8;
    private static final int OP_PING = 0x9;
    private static final int OP_PONG = 0xA;

    private static final int INTENT_GROUP_AND_C2C = 1 << 25;   // 33554432
    private static final int INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30; // 1073741824

    /** access_token 提供者（QqBotApi.getAccessToken()）。 */
    public interface TokenProvider {
        String getAccessToken() throws IOException;
    }

    /** 事件与状态回调（在后台线程调用，实现方需自己保证线程安全/切主线程）。 */
    public interface Listener {
        void onStatus(String status, String message);

        void onReady(String sessionId);

        void onMessage(Incoming message);
    }

    /** 一条 QQ 入站消息（已归一为 chatId）。 */
    public static final class Incoming {
        public final String chatId;
        public final String from;
        public final String fromName;
        public final String text;
        public final String eventId;
        public final String msgType;
        public final String source;
        public final String groupId;
        public final String channelId;
        public final String guildId;
        public final String userId;
        public final long at;

        Incoming(String chatId, String from, String fromName, String text, String eventId,
                 String msgType, String source, String groupId, String channelId,
                 String guildId, String userId, long at) {
            this.chatId = chatId == null ? "" : chatId;
            this.from = from == null ? "" : from;
            this.fromName = fromName == null ? "" : fromName;
            this.text = text == null ? "" : text;
            this.eventId = eventId == null ? "" : eventId;
            this.msgType = msgType == null ? "" : msgType;
            this.source = source == null ? "" : source;
            this.groupId = groupId == null ? "" : groupId;
            this.channelId = channelId == null ? "" : channelId;
            this.guildId = guildId == null ? "" : guildId;
            this.userId = userId == null ? "" : userId;
            this.at = at;
        }
    }

    /** 一帧 WebSocket 数据（测试可见）。 */
    static final class Frame {
        final boolean fin;
        final int opcode;
        final byte[] payload;

        Frame(boolean fin, int opcode, byte[] payload) {
            this.fin = fin;
            this.opcode = opcode;
            this.payload = payload == null ? new byte[0] : payload;
        }
    }

    private final String apiBase;
    private final TokenProvider tokenProvider;
    private final Listener listener;
    private final boolean allowInsecure;
    private final SecureRandom random = new SecureRandom();
    private final Object writeLock = new Object();

    private volatile boolean running;
    private volatile boolean stopped = true;
    private volatile Socket socket;
    private volatile InputStream input;
    private volatile OutputStream output;
    private volatile Thread managerThread;
    private volatile Thread readerThread;
    private volatile Thread heartbeatThread;

    private volatile String status = STATUS_STOPPED;
    private volatile String statusMessage = "";
    private volatile long heartbeatIntervalMs = 40000L;
    private volatile long lastSeq = -1L;
    private volatile long eventCount;
    private volatile long lastEventAt;
    private volatile String sessionId = "";
    private volatile boolean heartbeatAcked = true;
    private volatile CountDownLatch readyLatch;
    private volatile CountDownLatch closedLatch;

    public QqBotWsClient(String apiBase, TokenProvider tokenProvider, Listener listener) {
        this(apiBase, tokenProvider, listener, false);
    }

    /** 测试用构造：allowInsecure=true 时允许 ws:// 与 http gateway（生产仅 wss/https）。 */
    QqBotWsClient(String apiBase, TokenProvider tokenProvider, Listener listener,
                  boolean allowInsecure) {
        if (tokenProvider == null || listener == null) {
            throw new IllegalArgumentException("tokenProvider/listener == null");
        }
        this.apiBase = stripTrailingSlash(apiBase);
        this.tokenProvider = tokenProvider;
        this.listener = listener;
        this.allowInsecure = allowInsecure;
    }

    // ------------------------------------------------------------ 生命周期

    public void start() {
        if (running && !stopped) {
            return;
        }
        running = true;
        stopped = false;
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                managerLoop();
            }
        }, "dsh-qqbot-ws");
        thread.setDaemon(true);
        managerThread = thread;
        thread.start();
    }

    public void stop() {
        stopped = true;
        running = false;
        closeSocketQuietly();
        interrupt(heartbeatThread);
        interrupt(readerThread);
        interrupt(managerThread);
    }

    public boolean isRunning() {
        return running && !stopped;
    }

    public String status() {
        return status;
    }

    public String statusMessage() {
        return statusMessage;
    }

    public long eventCount() {
        return eventCount;
    }

    public long lastEventAt() {
        return lastEventAt;
    }

    public long lastSeq() {
        return lastSeq;
    }

    public String sessionId() {
        return sessionId;
    }

    // ------------------------------------------------------------ 连接管理

    private void managerLoop() {
        int attempt = 0;
        while (!stopped) {
            boolean wasReady = false;
            try {
                notifyStatus(attempt == 0 ? STATUS_CONNECTING : STATUS_RECONNECTING,
                        attempt == 0
                                ? "正在连接 QQ WebSocket 网关…"
                                : "WebSocket 重连中（第 " + attempt + " 次）…");
                wasReady = connectOnce();
            } catch (Throwable t) {
                if (!stopped) {
                    notifyStatus(STATUS_ERROR, wsError(t));
                }
            }
            if (stopped) {
                break;
            }
            if (wasReady) {
                attempt = 0;
            } else {
                attempt = Math.min(attempt + 1, RECONNECT_DELAYS.length - 1);
            }
            long delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
            notifyStatus(STATUS_RECONNECTING,
                    "WebSocket 已断开，" + (delay / 1000L) + " 秒后重连…");
            sleepWithStop(delay);
        }
        notifyStatus(STATUS_STOPPED, "WebSocket 已停止");
    }

    /** 建立一次连接并服务到断开；返回是否曾经 READY（用于退避归零）。 */
    private boolean connectOnce() throws IOException {
        String token = tokenProvider.getAccessToken();
        String gatewayUrl = discoverGateway(token);
        java.net.URI uri;
        try {
            uri = new java.net.URI(gatewayUrl);
        } catch (Throwable t) {
            throw new IOException("QQ WebSocket 网关地址无效");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
        if (!"wss".equals(scheme) && !("ws".equals(scheme) && allowInsecure)) {
            throw new IOException("QQ WebSocket 网关必须为 wss://");
        }
        String host = uri.getHost();
        if (host == null || host.isEmpty()) {
            throw new IOException("QQ WebSocket 网关缺少主机名");
        }
        int port = uri.getPort() > 0 ? uri.getPort() : ("wss".equals(scheme) ? 443 : 80);
        String path = uri.getRawPath();
        if (path == null || path.isEmpty()) {
            path = "/";
        }
        if (uri.getRawQuery() != null && !uri.getRawQuery().isEmpty()) {
            path = path + "?" + uri.getRawQuery();
        }

        Socket sock = openSocket(host, port, scheme);
        CountDownLatch ready = new CountDownLatch(1);
        CountDownLatch closed = new CountDownLatch(1);
        readyLatch = ready;
        closedLatch = closed;
        boolean wasReady = false;
        try {
            performHandshake(sock, host, port, path);
            InputStream socketIn = sock.getInputStream();
            OutputStream socketOut = sock.getOutputStream();
            this.input = socketIn;
            this.output = socketOut;
            // 每次连接重置协议状态（重新 Identify，不做 Resume）
            lastSeq = -1L;
            sessionId = "";
            heartbeatIntervalMs = 40000L;
            heartbeatAcked = true;
            final String identifyToken = token;
            Thread reader = new Thread(new Runnable() {
                @Override
                public void run() {
                    readerLoop(identifyToken, closed);
                }
            }, "dsh-qqbot-ws-reader");
            reader.setDaemon(true);
            readerThread = reader;
            reader.start();

            wasReady = ready.await(READY_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            if (!wasReady) {
                throw new IOException("等待 QQ WebSocket READY 超时");
            }
            startHeartbeat();
            closed.await();
            return true;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("QQ WebSocket 连接被中断");
        } finally {
            cleanupConnection();
        }
    }

    private void cleanupConnection() {
        closeSocketQuietly();
        interrupt(heartbeatThread);
        heartbeatThread = null;
        Thread reader = readerThread;
        if (reader != null && reader != Thread.currentThread()) {
            try {
                reader.join(1500L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        readerThread = null;
        synchronized (writeLock) {
            input = null;
            output = null;
        }
        socket = null;
    }

    private String discoverGateway(String token) throws IOException {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(apiBase + "/gateway");
            String scheme = url.getProtocol() == null ? "" : url.getProtocol().toLowerCase(Locale.US);
            if (!"https".equals(scheme) && !("http".equals(scheme) && allowInsecure)) {
                throw new IOException("QQ 网关发现接口必须使用 https");
            }
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(CONNECT_TIMEOUT_MS);
            conn.setUseCaches(false);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("Authorization", "QQBot " + token);
            conn.setRequestProperty("User-Agent", "DeepSeekHouse/3.2.0 (Android)");
            int httpStatus = conn.getResponseCode();
            InputStream in = httpStatus >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String body = readBody(in, 512 * 1024);
            if (httpStatus < 200 || httpStatus >= 300) {
                throw new IOException("获取 QQ WebSocket 网关失败：HTTP " + httpStatus);
            }
            JSONObject root;
            try {
                root = new JSONObject(body);
            } catch (JSONException e) {
                throw new IOException("QQ WebSocket 网关响应不是合法 JSON");
            }
            String urlText = root.optString("url", "");
            if (urlText == null || urlText.trim().isEmpty()) {
                throw new IOException("QQ WebSocket 网关响应缺少 url");
            }
            return urlText.trim();
        } catch (BotException e) {
            throw e;
        } catch (java.net.SocketTimeoutException e) {
            throw new IOException("获取 QQ WebSocket 网关超时");
        } catch (IOException e) {
            throw e;
        } catch (Throwable t) {
            throw new IOException("获取 QQ WebSocket 网关失败：" + message(t));
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        }
    }

    private Socket openSocket(String host, int port, String scheme) throws IOException {
        if ("wss".equals(scheme)) {
            SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
            SSLSocket ssl = (SSLSocket) factory.createSocket();
            ssl.setSoTimeout(0);
            ssl.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
            try {
                SSLParameters params = ssl.getSSLParameters();
                params.setEndpointIdentificationAlgorithm("HTTPS");
                ssl.setSSLParameters(params);
            } catch (Throwable ignored) {
                // 个别平台不支持，忽略
            }
            ssl.startHandshake();
            return ssl;
        }
        Socket plain = new Socket();
        plain.setSoTimeout(0);
        plain.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
        return plain;
    }

    // ------------------------------------------------------------ RFC6455 握手

    private void performHandshake(Socket sock, String host, int port, String path) throws IOException {
        byte[] nonce = new byte[16];
        random.nextBytes(nonce);
        String key = base64Encode(nonce);
        String hostHeader = port == 443 || port == 80 ? host : host + ":" + port;
        StringBuilder request = new StringBuilder();
        request.append("GET ").append(path).append(" HTTP/1.1\r\n");
        request.append("Host: ").append(hostHeader).append("\r\n");
        request.append("Upgrade: websocket\r\n");
        request.append("Connection: Upgrade\r\n");
        request.append("Sec-WebSocket-Key: ").append(key).append("\r\n");
        request.append("Sec-WebSocket-Version: 13\r\n");
        request.append("User-Agent: DeepSeekHouse/3.2.0 (Android)\r\n");
        request.append("\r\n");
        OutputStream out = sock.getOutputStream();
        out.write(request.toString().getBytes(StandardCharsets.UTF_8));
        out.flush();

        InputStream in = sock.getInputStream();
        String statusLine = readHttpLine(in);
        if (statusLine == null || !statusLine.contains(" 101")) {
            throw new IOException("QQ WebSocket 握手失败：" + (statusLine == null ? "无响应" : statusLine));
        }
        String acceptExpected = computeAccept(key);
        boolean upgradeOk = false;
        boolean acceptOk = false;
        for (int i = 0; i < 100; i++) {
            String line = readHttpLine(in);
            if (line == null || line.isEmpty()) {
                break;
            }
            int colon = line.indexOf(':');
            if (colon <= 0) {
                continue;
            }
            String name = line.substring(0, colon).trim().toLowerCase(Locale.US);
            String value = line.substring(colon + 1).trim();
            if ("upgrade".equals(name) && "websocket".equalsIgnoreCase(value)) {
                upgradeOk = true;
            } else if ("sec-websocket-accept".equals(name)) {
                acceptOk = acceptExpected.equals(value);
            }
        }
        if (!upgradeOk) {
            throw new IOException("QQ WebSocket 握手失败：缺少 Upgrade 头");
        }
        if (!acceptOk) {
            throw new IOException("QQ WebSocket 握手失败：Sec-WebSocket-Accept 校验不通过");
        }
        socket = sock;
    }

    private static String readHttpLine(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        while (true) {
            int b = in.read();
            if (b < 0) {
                return out.size() == 0 ? null : out.toString("UTF-8");
            }
            if (b == '\n') {
                String line = out.toString("UTF-8");
                return line.endsWith("\r") ? line.substring(0, line.length() - 1) : line;
            }
            out.write(b);
            if (out.size() > 16 * 1024) {
                throw new IOException("QQ WebSocket 握手响应过大");
            }
        }
    }

    static String computeAccept(String key) {
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            byte[] digest = sha1.digest((key + WS_GUID).getBytes(StandardCharsets.UTF_8));
            return base64Encode(digest);
        } catch (Throwable t) {
            return "";
        }
    }

    // ------------------------------------------------------------ 读线程 / 心跳

    private void readerLoop(String identifyToken, CountDownLatch closed) {
        ByteArrayOutputStream fragments = null;
        int fragmentOpcode = OP_TEXT;
        try {
            InputStream in = input;
            while (!stopped && in != null) {
                Frame frame = readFrame(in);
                if (frame == null) {
                    break;
                }
                if (frame.opcode == OP_PING) {
                    sendFrame(OP_PONG, frame.payload, true);
                    continue;
                }
                if (frame.opcode == OP_PONG) {
                    continue;
                }
                if (frame.opcode == OP_CLOSE) {
                    sendFrame(OP_CLOSE, new byte[0], true);
                    break;
                }
                if (frame.opcode == OP_TEXT || frame.opcode == OP_BINARY) {
                    if (frame.fin) {
                        handlePayload(new String(frame.payload, StandardCharsets.UTF_8),
                                identifyToken);
                    } else {
                        fragmentOpcode = frame.opcode;
                        fragments = new ByteArrayOutputStream();
                        fragments.write(frame.payload);
                        if (fragments.size() > MAX_MESSAGE_BYTES) {
                            throw new IOException("WebSocket 消息超过 1MB 上限");
                        }
                    }
                    continue;
                }
                if (frame.opcode == OP_CONTINUATION && fragments != null) {
                    fragments.write(frame.payload);
                    if (fragments.size() > MAX_MESSAGE_BYTES) {
                        throw new IOException("WebSocket 消息超过 1MB 上限");
                    }
                    if (frame.fin) {
                        byte[] payload = fragments.toByteArray();
                        fragments = null;
                        if (fragmentOpcode == OP_TEXT) {
                            handlePayload(new String(payload, StandardCharsets.UTF_8),
                                    identifyToken);
                        }
                    }
                }
            }
        } catch (Throwable t) {
            if (!stopped) {
                notifyStatus(STATUS_ERROR, "WebSocket 读取失败：" + wsError(t));
            }
        } finally {
            closed.countDown();
        }
    }

    private void startHeartbeat() {
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                heartbeatLoop();
            }
        }, "dsh-qqbot-ws-heartbeat");
        thread.setDaemon(true);
        heartbeatThread = thread;
        thread.start();
    }

    private void heartbeatLoop() {
        int unacked = 0;
        while (!stopped && socket != null && !socket.isClosed()) {
            long interval = Math.max(1000L, Math.min(MAX_HEARTBEAT_INTERVAL_MS, heartbeatIntervalMs));
            if (!sleepWithStop(interval)) {
                break;
            }
            if (stopped || socket == null || socket.isClosed()) {
                break;
            }
            if (heartbeatAcked) {
                unacked = 0;
            } else {
                unacked++;
            }
            if (unacked >= 2) {
                notifyStatus(STATUS_ERROR, "心跳超时（2 次未收到 ACK），准备重连");
                closeSocketQuietly();
                break;
            }
            heartbeatAcked = false;
            JSONObject beat = new JSONObject();
            try {
                beat.put("op", 1);
                beat.put("d", lastSeq >= 0L ? lastSeq : JSONObject.NULL);
            } catch (JSONException ignored) {
                // 忽略
            }
            try {
                sendJson(beat);
            } catch (Throwable t) {
                break;
            }
        }
    }

    private void handlePayload(String text, String identifyToken) {
        if (text == null || text.trim().isEmpty()) {
            return;
        }
        JSONObject message;
        try {
            message = new JSONObject(text);
        } catch (JSONException e) {
            return;
        }
        int op = message.optInt("op", -1);
        JSONObject data = message.optJSONObject("d");
        switch (op) {
            case 10: { // Hello
                long interval = data == null ? 40000L : data.optLong("heartbeat_interval", 40000L);
                heartbeatIntervalMs = Math.max(1000L, Math.min(MAX_HEARTBEAT_INTERVAL_MS, interval));
                sendIdentify(identifyToken);
                break;
            }
            case 11: // Heartbeat ACK
                heartbeatAcked = true;
                break;
            case 0: { // Dispatch
                long seq = message.has("s") ? message.optLong("s", -1L) : -1L;
                if (seq >= 0L) {
                    lastSeq = seq;
                }
                String type = message.optString("t", "");
                if ("READY".equals(type)) {
                    sessionId = data == null ? "" : data.optString("session_id", "");
                    notifyStatus(STATUS_CONNECTED, "WebSocket 已连接，事件接收中…");
                    CountDownLatch latch = readyLatch;
                    if (latch != null) {
                        latch.countDown();
                    }
                    listener.onReady(sessionId);
                } else if (!type.isEmpty()) {
                    Incoming incoming = parseEvent(type, data);
                    if (incoming != null) {
                        eventCount++;
                        lastEventAt = System.currentTimeMillis();
                        listener.onMessage(incoming);
                    }
                }
                break;
            }
            case 7: // Reconnect
                notifyStatus(STATUS_RECONNECTING, "收到 Reconnect 指令，准备重连…");
                closeSocketQuietly();
                break;
            case 9: // Invalid Session
                sessionId = "";
                lastSeq = -1L;
                notifyStatus(STATUS_ERROR, "会话失效（Invalid Session），准备重新 Identify…");
                closeSocketQuietly();
                break;
            default:
                break;
        }
    }

    private void sendIdentify(String token) {
        JSONObject payload = new JSONObject();
        try {
            JSONObject d = new JSONObject();
            d.put("token", "QQBot " + (token == null ? "" : token));
            d.put("intents", INTENT_GROUP_AND_C2C | INTENT_PUBLIC_GUILD_MESSAGES);
            JSONArray shard = new JSONArray();
            shard.put(0);
            shard.put(1);
            d.put("shard", shard);
            JSONObject properties = new JSONObject();
            properties.put("os", "android");
            properties.put("browser", "deepseek-house");
            properties.put("device", "phone");
            d.put("properties", properties);
            payload.put("op", 2);
            payload.put("d", d);
        } catch (JSONException ignored) {
            // 忽略
        }
        try {
            sendJson(payload);
        } catch (Throwable t) {
            notifyStatus(STATUS_ERROR, "发送 Identify 失败：" + wsError(t));
            closeSocketQuietly();
        }
    }

    /**
     * 解析 Dispatch 事件为统一 Incoming（测试可见）。
     * 支持 GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE / AT_MESSAGE_CREATE / MESSAGE_CREATE。
     */
    static Incoming parseEvent(String type, JSONObject d) {
        if (type == null || d == null) {
            return null;
        }
        String text = d.optString("content", "");
        if (text == null || text.trim().isEmpty()) {
            return null;
        }
        String eventId = d.optString("id", "");
        long at = parseIsoTime(d.optString("timestamp", ""));
        JSONObject author = d.optJSONObject("author");
        String from = "";
        String fromName = "";
        if (author != null) {
            fromName = firstNonEmpty(author.optString("username", ""),
                    author.optString("nickname", ""),
                    author.optString("member_nick", ""));
        }
        String chatId;
        String source;
        String groupId = "";
        String channelId = "";
        String guildId = "";
        String userId = "";
        if ("GROUP_AT_MESSAGE_CREATE".equals(type) || "GROUP_MESSAGE_CREATE".equals(type)) {
            groupId = d.optString("group_openid", "");
            if (groupId.isEmpty()) {
                return null;
            }
            chatId = "group:" + groupId;
            source = "group";
            from = author == null ? "" : firstNonEmpty(author.optString("member_openid", ""),
                    author.optString("id", ""));
            userId = from;
            if (fromName.isEmpty()) {
                fromName = from;
            }
        } else if ("C2C_MESSAGE_CREATE".equals(type)) {
            userId = author == null ? "" : firstNonEmpty(author.optString("user_openid", ""),
                    author.optString("id", ""));
            if (userId.isEmpty()) {
                return null;
            }
            chatId = "user:" + userId;
            source = "user";
            from = userId;
            if (fromName.isEmpty()) {
                fromName = userId;
            }
        } else if ("AT_MESSAGE_CREATE".equals(type) || "MESSAGE_CREATE".equals(type)) {
            guildId = d.optString("guild_id", "");
            channelId = d.optString("channel_id", "");
            if (channelId.isEmpty()) {
                return null;
            }
            chatId = "channel:" + guildId + ":" + channelId;
            source = "channel";
            from = author == null ? "" : firstNonEmpty(author.optString("id", ""),
                    author.optString("user_openid", ""));
            if (fromName.isEmpty()) {
                fromName = from;
            }
        } else {
            return null;
        }
        return new Incoming(chatId, from, fromName, text, eventId, type, source,
                groupId, channelId, guildId, userId, at);
    }

    static long parseIsoTime(String raw) {
        if (raw == null || raw.trim().isEmpty()) {
            return System.currentTimeMillis();
        }
        String value = raw.trim();
        String[] patterns = new String[]{
                "yyyy-MM-dd'T'HH:mm:ssXXX",
                "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
                "yyyy-MM-dd'T'HH:mm:ss'Z'",
                "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
                "yyyy-MM-dd HH:mm:ss"
        };
        for (String pattern : patterns) {
            try {
                SimpleDateFormat format = new SimpleDateFormat(pattern, Locale.US);
                if (pattern.endsWith("'Z'")) {
                    format.setTimeZone(TimeZone.getTimeZone("UTC"));
                }
                Date date = format.parse(value);
                if (date != null) {
                    return date.getTime();
                }
            } catch (Throwable ignored) {
                // 尝试下一种
            }
        }
        return System.currentTimeMillis();
    }

    // ------------------------------------------------------------ 发送 / 帧

    private void sendJson(JSONObject payload) throws IOException {
        byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
        sendFrame(OP_TEXT, bytes, true);
    }

    private void sendFrame(int opcode, byte[] payload, boolean fin) throws IOException {
        OutputStream out = output;
        if (out == null) {
            throw new IOException("WebSocket 未连接");
        }
        synchronized (writeLock) {
            writeFrame(out, opcode, payload, fin, true, random);
            try {
                out.flush();
            } catch (IOException e) {
                throw e;
            }
        }
    }

    /** 写一帧（客户端默认 masked=true；测试可直接调用，测试可见）。 */
    static void writeFrame(OutputStream out, int opcode, byte[] payload, boolean fin,
                           boolean masked, SecureRandom secureRandom) throws IOException {
        byte[] data = payload == null ? new byte[0] : payload;
        int length = data.length;
        int firstByte = (fin ? 0x80 : 0x00) | (opcode & 0x0F);
        out.write(firstByte);
        int maskBit = masked ? 0x80 : 0x00;
        if (length <= 125) {
            out.write(maskBit | length);
        } else if (length <= 0xFFFF) {
            out.write(maskBit | 126);
            out.write((length >>> 8) & 0xFF);
            out.write(length & 0xFF);
        } else {
            out.write(maskBit | 127);
            for (int i = 7; i >= 0; i--) {
                out.write((int) ((((long) length) >>> (8 * i)) & 0xFF));
            }
        }
        if (masked) {
            byte[] mask = new byte[4];
            if (secureRandom != null) {
                secureRandom.nextBytes(mask);
            } else {
                new SecureRandom().nextBytes(mask);
            }
            out.write(mask);
            byte[] maskedData = new byte[length];
            for (int i = 0; i < length; i++) {
                maskedData[i] = (byte) (data[i] ^ mask[i % 4]);
            }
            out.write(maskedData);
        } else {
            out.write(data);
        }
        out.flush();
    }

    /** 读一帧（EOF 返回 null；大于 1MB 抛 IOException）。 */
    static Frame readFrame(InputStream in) throws IOException {
        int first = in.read();
        if (first < 0) {
            return null;
        }
        int second = readByte(in);
        boolean fin = (first & 0x80) != 0;
        int opcode = first & 0x0F;
        boolean masked = (second & 0x80) != 0;
        long length = second & 0x7F;
        if (length == 126L) {
            length = (readByte(in) << 8) | readByte(in);
        } else if (length == 127L) {
            length = 0L;
            for (int i = 0; i < 8; i++) {
                length = (length << 8) | readByte(in);
            }
        }
        if (length < 0L || length > MAX_MESSAGE_BYTES) {
            throw new IOException("WebSocket 帧超过 1MB 上限");
        }
        byte[] mask = null;
        if (masked) {
            mask = new byte[4];
            readFully(in, mask, 0, 4);
        }
        byte[] payload = new byte[(int) length];
        readFully(in, payload, 0, payload.length);
        if (mask != null) {
            for (int i = 0; i < payload.length; i++) {
                payload[i] = (byte) (payload[i] ^ mask[i % 4]);
            }
        }
        return new Frame(fin, opcode, payload);
    }

    private static int readByte(InputStream in) throws IOException {
        int b = in.read();
        if (b < 0) {
            throw new EOFException("WebSocket 连接已关闭");
        }
        return b;
    }

    private static void readFully(InputStream in, byte[] buffer, int offset, int length)
            throws IOException {
        int read = 0;
        while (read < length) {
            int n = in.read(buffer, offset + read, length - read);
            if (n < 0) {
                throw new EOFException("WebSocket 连接已关闭");
            }
            read += n;
        }
    }

    // ------------------------------------------------------------ 状态 / 工具

    private void notifyStatus(String newStatus, String message) {
        status = newStatus == null ? STATUS_ERROR : newStatus;
        statusMessage = message == null ? "" : message;
        try {
            listener.onStatus(status, statusMessage);
        } catch (Throwable ignored) {
            // 回调异常不影响连接
        }
    }

    private void closeSocketQuietly() {
        Socket sock = socket;
        if (sock != null) {
            try {
                sock.close();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
    }

    private boolean sleepWithStop(long millis) {
        long remaining = millis;
        while (remaining > 0 && !stopped) {
            long chunk = Math.min(remaining, 200L);
            try {
                Thread.sleep(chunk);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
            remaining -= chunk;
        }
        return !stopped;
    }

    private static void interrupt(Thread thread) {
        if (thread != null) {
            try {
                thread.interrupt();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
    }

    private static String wsError(Throwable t) {
        String message = message(t);
        // 不把 Authorization/token 带进消息（本类从不打印 token，网关 URL 也不含 token）
        return message.length() > 300 ? message.substring(0, 300) : message;
    }

    private static String message(Throwable t) {
        if (t == null) {
            return "未知错误";
        }
        String message = t.getMessage();
        return message == null || message.trim().isEmpty()
                ? t.getClass().getSimpleName() : message.trim();
    }

    private static String firstNonEmpty(String... values) {
        if (values == null) {
            return "";
        }
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) {
                return value.trim();
            }
        }
        return "";
    }

    private static String stripTrailingSlash(String raw) {
        String value = raw == null ? "" : raw.trim();
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    private static String readBody(InputStream in, int maxBytes) {
        if (in == null) {
            return "";
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        try {
            int n;
            while ((n = in.read(buffer)) >= 0) {
                if (total < maxBytes) {
                    int take = Math.min(n, maxBytes - total);
                    out.write(buffer, 0, take);
                    total += take;
                }
                if (total >= maxBytes) {
                    break;
                }
            }
        } catch (IOException ignored) {
            // 忽略
        } finally {
            try {
                in.close();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    /** 小体积 base64 编码（minSdk 24 无 java.util.Base64）。 */
    static String base64Encode(byte[] data) {
        if (data == null || data.length == 0) {
            return "";
        }
        final char[] table =
                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();
        StringBuilder sb = new StringBuilder((data.length + 2) / 3 * 4);
        int i = 0;
        while (i < data.length) {
            int b0 = data[i++] & 0xFF;
            int b1 = i < data.length ? data[i++] & 0xFF : -1;
            int b2 = i < data.length ? data[i++] & 0xFF : -1;
            sb.append(table[b0 >>> 2]);
            if (b1 >= 0) {
                sb.append(table[((b0 & 0x03) << 4) | (b1 >>> 4)]);
            } else {
                sb.append(table[(b0 & 0x03) << 4]).append("==");
                break;
            }
            if (b2 >= 0) {
                sb.append(table[((b1 & 0x0F) << 2) | (b2 >>> 6)]);
                sb.append(table[b2 & 0x3F]);
            } else {
                sb.append(table[(b1 & 0x0F) << 2]).append('=');
                break;
            }
        }
        return sb.toString();
    }

    @Override
    public String toString() {
        return "QqBotWsClient{apiBase=" + apiBase + ", status=" + status
                + ", events=" + eventCount + "}";
    }
}
