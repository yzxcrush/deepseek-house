package com.deepseekhouse.app.bot;

import android.content.Context;

import com.deepseekhouse.app.Prefs;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Bot 运行时管理器（v3.0.0）。
 *
 * <p>职责：配置持久化（{@code Prefs.bots}）、按配置启停、Telegram getUpdates 长轮询接收、
 * Telegram/OneBot 发送、连接测试、最近 200 条消息内存缓存，以及事件：</p>
 * <pre>
 * bot-status  {botId,status:"connected"|"error"|"stopped",message}
 * bot-message {botId,chatId,from,fromName,text,at}       // 仅 Telegram 收消息
 * bot-sent    {botId,chatId,ok,messageId,error?}
 * </pre>
 *
 * <p>线程：发送/测试用共享后台线程池（单例 ioPool）；每个 Telegram bot 一个独立轮询线程
 * （{@code dsh-bot-<id>}），stop 时设置 running=false 并 disconnect 在途请求使其尽快退出。
 * 所有状态读写统一在 {@link #lock} 下；缓存上限 {@link #RECENT_LIMIT}。</p>
 *
 * <p>安全：token/accessToken 只来自 Prefs 与内存，不写日志；错误信息由 API 层做 token scrub。</p>
 */
public final class BotManager {

    public interface EventSink {
        void emit(String json);
    }

    public static final int RECENT_LIMIT = 200;
    public static final String STATUS_CONNECTED = "connected";
    public static final String STATUS_ERROR = "error";
    public static final String STATUS_STOPPED = "stopped";

    private static final long POLL_TIMEOUT_SECONDS = 25L;
    private static final long ERROR_RETRY_DELAY_MS = 5 * 1000L;
    private static final int DEFAULT_RECENT = 50;
    private static final long TARGETS_CACHE_MS = 5 * 60 * 1000L;
    private static final int MAX_TARGETS = 50;
    private static final int MAX_GUILDS = 15;

    private final Context context;
    private final Prefs prefs;
    private final EventSink sink;
    private final Object lock = new Object();
    private final List<BotConfig> configs = new ArrayList<>();
    private final Map<String, BotState> states = new LinkedHashMap<>();
    private final ExecutorService ioPool;

    private volatile boolean closed;
    private volatile boolean autoStartDone;

    /** 单个 bot 的运行时状态。 */
    private static final class BotState {
        final String id;
        BotConfig config;
        String status = STATUS_STOPPED;
        String message = "";
        String botUsername = "";
        volatile boolean running;
        /** 连接代际：stop/restart 后旧的长轮询/异步启动结果必须失效。 */
        int generation;
        Thread pollThread;
        TelegramBotApi telegram;
        OneBotApi onebot;
        QqBotApi qqbot;
        JSONArray targetsCache;
        long targetsCacheAt;
        final Deque<JSONObject> recent = new ArrayDeque<>();

        BotState(String id, BotConfig config) {
            this.id = id;
            this.config = config;
        }
    }

    public BotManager(Context context, Prefs prefs, EventSink sink) {
        if (context == null) {
            throw new IllegalArgumentException("context == null");
        }
        this.context = context.getApplicationContext();
        this.prefs = prefs == null ? new Prefs(this.context) : prefs;
        this.sink = sink;
        loadConfigs();
        final AtomicInteger seq = new AtomicInteger(1);
        this.ioPool = Executors.newCachedThreadPool(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "dsh-bot-io-" + seq.getAndIncrement());
                t.setDaemon(true);
                return t;
            }
        });
    }

    // ------------------------------------------------------------ 配置加载/持久化

    private void loadConfigs() {
        List<BotConfig> loaded = new ArrayList<>();
        try {
            String raw = prefs.getBotsJson();
            JSONArray array = new JSONArray(raw == null || raw.trim().isEmpty() ? "[]" : raw);
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                BotConfig config = BotConfig.fromJson(item);
                if (config == null) {
                    continue;
                }
                if (config.id.isEmpty() || containsConfig(loaded, config.id)) {
                    config.id = generateId(loaded);
                }
                loaded.add(config);
            }
        } catch (Throwable ignored) {
            // 配置损坏按空列表启动
        }
        synchronized (lock) {
            configs.clear();
            configs.addAll(loaded);
            states.clear();
            for (BotConfig config : configs) {
                states.put(config.id, new BotState(config.id, config.copy()));
            }
        }
    }

    private static boolean containsConfig(List<BotConfig> list, String id) {
        for (BotConfig config : list) {
            if (config.id.equals(id)) {
                return true;
            }
        }
        return false;
    }

    private String generateId(List<BotConfig> known) {
        java.util.Random random = new java.util.Random();
        for (int i = 0; i < 100; i++) {
            StringBuilder sb = new StringBuilder("bot");
            for (int j = 0; j < 4; j++) {
                sb.append(String.format(java.util.Locale.US, "%02x", random.nextInt(256)));
            }
            String id = sb.toString();
            if (!containsConfig(known, id)) {
                return id;
            }
        }
        return "bot" + System.currentTimeMillis();
    }

    private void persistLocked() {
        JSONArray array = new JSONArray();
        for (BotConfig config : configs) {
            array.put(config.toJson());
        }
        try {
            prefs.setBotsJson(array.toString());
        } catch (Throwable ignored) {
            // 持久化失败不影响当前会话
        }
    }

    // ------------------------------------------------------------ 列表

    /** SPEC botsList：配置 + 运行时状态 JSON 数组。 */
    public String listJson() {
        JSONArray array = new JSONArray();
        synchronized (lock) {
            for (BotConfig config : configs) {
                BotState state = states.get(config.id);
                JSONObject item = config.toJson();
                try {
                    item.put("status", state == null ? STATUS_STOPPED : state.status);
                    item.put("message", state == null || state.message == null ? "" : state.message);
                    item.put("running", state != null && state.running);
                    item.put("recentCount", state == null ? 0 : state.recent.size());
                    String username = state == null ? "" : state.botUsername;
                    if (username != null && !username.isEmpty()) {
                        item.put("botUsername", username);
                    }
                } catch (JSONException ignored) {
                    // 忽略
                }
                array.put(item);
            }
        }
        return array.toString();
    }

    // ------------------------------------------------------------ 保存 / 删除

    /** SPEC botSave：新增/更新配置（无 id 自动生成）；非法配置返回 false。 */
    public boolean save(String json) {
        if (json == null || json.trim().isEmpty()) {
            return false;
        }
        JSONObject input;
        try {
            input = new JSONObject(json);
        } catch (JSONException e) {
            return false;
        }
        BotConfig parsed = BotConfig.fromJson(input);
        if (parsed == null) {
            return false;
        }
        List<Thread> toJoin = new ArrayList<>();
        String startAfter = "";
        synchronized (lock) {
            String requestedId = BotConfig.normalizeId(parsed.id);
            BotConfig existing = requestedId.isEmpty() ? null : findConfigLocked(requestedId);
            String targetId;
            if (existing == null) {
                targetId = requestedId.isEmpty() ? generateId(configs) : requestedId;
                BotConfig created = parsed.copy();
                created.id = targetId;
                configs.add(created);
                states.put(targetId, new BotState(targetId, created.copy()));
            } else {
                boolean endpointChanged = !existing.sameEndpoint(parsed);
                BotState state = states.get(existing.id);
                if (state != null && endpointChanged && state.running) {
                    stopStateLocked(state, toJoin);
                }
                BotConfig updated = parsed.copy();
                updated.id = existing.id;
                int index = configs.indexOf(existing);
                if (index >= 0) {
                    configs.set(index, updated);
                }
                if (state != null) {
                    state.config = updated.copy();
                    // 配置变化后频道/目标缓存作废
                    state.targetsCache = null;
                    state.targetsCacheAt = 0L;
                }
                targetId = existing.id;
            }
            persistLocked();
            BotState target = states.get(targetId);
            if (target != null) {
                if (!target.config.enabled && target.running) {
                    stopStateLocked(target, toJoin);
                }
                if (autoStartDone && !closed && target.config.enabled && !target.running) {
                    startAfter = targetId;
                }
            }
        }
        joinQuietly(toJoin);
        if (!startAfter.isEmpty()) {
            start(startAfter);
        }
        return true;
    }

    /** SPEC botDelete：停止并删除配置。 */
    public void delete(String rawId) {
        String id = rawId == null ? "" : rawId.trim();
        if (id.isEmpty()) {
            return;
        }
        List<Thread> toJoin = new ArrayList<>();
        synchronized (lock) {
            BotState state = states.remove(id);
            if (state != null) {
                stopStateLocked(state, toJoin);
            }
            BotConfig config = findConfigLocked(id);
            if (config != null) {
                configs.remove(config);
                persistLocked();
            }
        }
        joinQuietly(toJoin);
    }

    private BotConfig findConfigLocked(String id) {
        for (BotConfig config : configs) {
            if (config.id.equals(id)) {
                return config;
            }
        }
        return null;
    }

    // ------------------------------------------------------------ 启停

    /** SPEC botStart：异步连接 +（Telegram）启动长轮询；幂等。 */
    public void start(String rawId) {
        String id = rawId == null ? "" : rawId.trim();
        BotState state;
        synchronized (lock) {
            if (closed) {
                return;
            }
            state = states.get(id);
            if (state == null) {
                emitStatus(id, STATUS_ERROR, "Bot 不存在：" + id);
                return;
            }
            if (state.running) {
                return;
            }
            String validation = validateConfig(state.config);
            if (validation != null) {
                state.status = STATUS_ERROR;
                state.message = validation;
                emitStatus(id, STATUS_ERROR, validation);
                return;
            }
            state.generation++;
            state.running = true;
            state.message = "";
        }
        final int generation = state.generation;
        ioPool.execute(new Runnable() {
            @Override
            public void run() {
                startAsync(state, generation);
            }
        });
    }

    private static String validateConfig(BotConfig config) {
        if (config == null) {
            return "Bot 配置不存在";
        }
        if (config.isTelegram()) {
            if (config.token == null || config.token.trim().isEmpty()) {
                return "缺少 Telegram Bot Token";
            }
            if (!TelegramBotApi.isPlausibleToken(config.token.trim())) {
                return "Telegram Bot Token 格式无效";
            }
            return null;
        }
        if (config.isOneBot()) {
            if (!BotConfig.isValidOneBotUrl(config.baseUrl)) {
                return "OneBot 地址无效（仅支持 http/https）";
            }
            return null;
        }
        if (config.isQqBot()) {
            if (config.appId == null || config.appId.trim().isEmpty()) {
                return "缺少 QQ 机器人 AppID";
            }
            if (config.secret == null || config.secret.trim().isEmpty()) {
                return "缺少 QQ 机器人 Secret";
            }
            if (!BotConfig.isValidQqBotUrl(config.baseUrl)) {
                return "QQ 机器人 API 地址无效（仅支持 https）";
            }
            return null;
        }
        return "Bot 类型无效（仅支持 telegram/onebot/qqbot）";
    }

    private void startAsync(final BotState state, final int generation) {
        BotConfig config;
        synchronized (lock) {
            if (!state.running || closed || state.generation != generation) {
                return;
            }
            config = state.config.copy();
        }
        try {
            if (config.isTelegram()) {
                TelegramBotApi api = new TelegramBotApi(config.token);
                JSONObject me = api.getMe();
                String username = me.optString("username", "");
                String message = "已连接：" + (username.isEmpty() ? "Telegram Bot" : "@" + username);
                synchronized (lock) {
                    if (!state.running || closed || state.generation != generation) {
                        api.cancel();
                        return;
                    }
                    state.telegram = api;
                    state.onebot = null;
                    state.botUsername = username;
                    state.status = STATUS_CONNECTED;
                    state.message = message;
                }
                emitStatus(state.id, STATUS_CONNECTED, message);
                startTelegramPolling(state, api, generation);
            } else if (config.isOneBot()) {
                OneBotApi api = new OneBotApi(config.baseUrl, config.accessToken);
                JSONObject info = api.getLoginInfo();
                String nickname = info.optString("nickname", "");
                long userId = info.optLong("user_id", 0L);
                String who = nickname.isEmpty() ? String.valueOf(userId) : nickname;
                String message = "已连接：QQ " + who;
                synchronized (lock) {
                    if (!state.running || closed || state.generation != generation) {
                        api.cancel();
                        return;
                    }
                    state.onebot = api;
                    state.telegram = null;
                    state.botUsername = who;
                    state.status = STATUS_CONNECTED;
                    state.message = message;
                }
                emitStatus(state.id, STATUS_CONNECTED, message);
            } else {
                QqBotApi api = new QqBotApi(config.appId, config.secret, config.baseUrl);
                api.getAccessToken();
                long ttl = api.tokenTtlSeconds();
                String message = "已连接：QQ 机器人 appId=" + config.appId
                        + "（AccessToken 有效期 " + ttl + "s）";
                synchronized (lock) {
                    if (!state.running || closed || state.generation != generation) {
                        api.cancel();
                        return;
                    }
                    state.qqbot = api;
                    state.telegram = null;
                    state.onebot = null;
                    state.botUsername = "QQBot:" + config.appId;
                    state.status = STATUS_CONNECTED;
                    state.message = message;
                    state.targetsCache = null;
                    state.targetsCacheAt = 0L;
                }
                emitStatus(state.id, STATUS_CONNECTED, message);
            }
        } catch (Throwable t) {
            String message = message(t);
            synchronized (lock) {
                if (!state.running || state.generation != generation) {
                    return;
                }
                state.running = false;
                state.status = STATUS_ERROR;
                state.message = message;
            }
            emitStatus(state.id, STATUS_ERROR, message);
        }
    }

    /** SPEC botStop：停止轮询/取消在途请求 → bot-status stopped。 */
    public void stop(String rawId) {
        String id = rawId == null ? "" : rawId.trim();
        if (id.isEmpty()) {
            return;
        }
        List<Thread> toJoin = new ArrayList<>();
        synchronized (lock) {
            BotState state = states.get(id);
            if (state == null) {
                return;
            }
            stopStateLocked(state, toJoin);
        }
        joinQuietly(toJoin);
    }

    private void stopStateLocked(BotState state, List<Thread> toJoin) {
        if (state == null) {
            return;
        }
        state.generation++;
        state.running = false;
        TelegramBotApi telegram = state.telegram;
        state.telegram = null;
        if (telegram != null) {
            try {
                telegram.cancel();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
        OneBotApi onebot = state.onebot;
        state.onebot = null;
        if (onebot != null) {
            try {
                onebot.cancel();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
        QqBotApi qqbot = state.qqbot;
        state.qqbot = null;
        if (qqbot != null) {
            try {
                qqbot.cancel();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
        state.targetsCache = null;
        state.targetsCacheAt = 0L;
        Thread thread = state.pollThread;
        state.pollThread = null;
        if (thread != null && thread != Thread.currentThread()) {
            toJoin.add(thread);
        }
        state.status = STATUS_STOPPED;
        state.message = "";
        emitStatus(state.id, STATUS_STOPPED, "已停止");
    }

    private static void joinQuietly(List<Thread> threads) {
        if (threads == null) {
            return;
        }
        for (Thread thread : threads) {
            try {
                thread.join(1500L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    // ------------------------------------------------------------ 测试 / 发送

    /** SPEC botTest：连接测试（getMe / get_login_info），只 emit bot-status，不改变运行状态。 */
    public void test(String rawId) {
        String id = rawId == null ? "" : rawId.trim();
        BotConfig config;
        synchronized (lock) {
            BotState state = states.get(id);
            if (state == null) {
                emitStatus(id, STATUS_ERROR, "Bot 不存在：" + id);
                return;
            }
            config = state.config.copy();
        }
        ioPool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    String message;
                    if (config.isTelegram()) {
                        JSONObject me = new TelegramBotApi(config.token).getMe();
                        String username = me.optString("username", "");
                        message = "测试成功：" + (username.isEmpty()
                                ? "Telegram Bot 可用" : "@" + username + "（未启动）");
                    } else if (config.isQqBot()) {
                        QqBotApi api = new QqBotApi(config.appId, config.secret, config.baseUrl);
                        api.getAccessToken();
                        long ttl = api.tokenTtlSeconds();
                        String prefix = "鉴权成功：appId=" + config.appId
                                + "（token 有效期 " + ttl + "s）";
                        try {
                            JSONArray guilds = api.getGuilds();
                            message = prefix + "，频道 " + guilds.length() + " 个";
                        } catch (Throwable guildError) {
                            message = prefix + "，但无法列出频道：" + message(guildError);
                        }
                    } else {
                        JSONObject info = new OneBotApi(config.baseUrl, config.accessToken)
                                .getLoginInfo();
                        String nickname = info.optString("nickname", "");
                        long userId = info.optLong("user_id", 0L);
                        message = "测试成功：QQ "
                                + (nickname.isEmpty() ? String.valueOf(userId) : nickname)
                                + "（未启动）";
                    }
                    emitStatus(id, STATUS_CONNECTED, message);
                } catch (Throwable t) {
                    emitStatus(id, STATUS_ERROR, "测试失败：" + message(t));
                }
            }
        });
    }

    /** SPEC botSend：异步发送，结束 emit bot-sent（失败也发 ok:false+error）。 */
    public void send(String rawBotId, String chatId, String text) {
        final String botId = rawBotId == null ? "" : rawBotId.trim();
        final String target = chatId == null ? "" : chatId.trim();
        final String content = text == null ? "" : text;
        BotConfig config;
        TelegramBotApi telegram = null;
        OneBotApi onebot = null;
        QqBotApi qqbot = null;
        synchronized (lock) {
            BotState state = states.get(botId);
            if (state == null) {
                emitSent(botId, target, false, "", "Bot 不存在：" + botId);
                return;
            }
            config = state.config.copy();
            telegram = state.telegram;
            onebot = state.onebot;
            qqbot = state.qqbot;
        }
        final TelegramBotApi telegramApi = telegram;
        final OneBotApi onebotApi = onebot;
        final QqBotApi qqbotApi = qqbot;
        ioPool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    if (content.trim().isEmpty()) {
                        emitSent(botId, target, false, "", "消息内容为空");
                        return;
                    }
                    String messageId;
                    if (config.isTelegram()) {
                        TelegramBotApi api = telegramApi != null
                                ? telegramApi : new TelegramBotApi(config.token);
                        messageId = String.valueOf(api.sendMessage(target, content, ""));
                    } else if (config.isOneBot()) {
                        OneBotApi api = onebotApi != null
                                ? onebotApi : new OneBotApi(config.baseUrl, config.accessToken);
                        messageId = api.sendMessage(target, content);
                    } else {
                        QqBotApi api = qqbotApi != null
                                ? qqbotApi : new QqBotApi(config.appId, config.secret, config.baseUrl);
                        messageId = api.sendMessage(target, content);
                    }
                    cacheRecent(botId, target, "bot", "", content, System.currentTimeMillis(),
                            "out", true, messageId, null);
                    emitSent(botId, target, true, messageId, null);
                } catch (Throwable t) {
                    String error = message(t);
                    cacheRecent(botId, target, "bot", "", content, System.currentTimeMillis(),
                            "out", false, "", error);
                    emitSent(botId, target, false, "", error);
                }
            }
        });
    }

    // ------------------------------------------------------------ 最近消息

    /** SPEC botRecent：最近消息 JSON（新→旧），limit 默认 50 / 上限 200。 */
    public String recentJson(String rawBotId, int limit) {
        String botId = rawBotId == null ? "" : rawBotId.trim();
        int safeLimit = limit <= 0 ? DEFAULT_RECENT : Math.min(limit, RECENT_LIMIT);
        JSONArray array = new JSONArray();
        synchronized (lock) {
            BotState state = states.get(botId);
            if (state == null) {
                return "[]";
            }
            java.util.Iterator<JSONObject> iterator = state.recent.descendingIterator();
            while (iterator.hasNext() && array.length() < safeLimit) {
                array.put(iterator.next());
            }
        }
        return array.toString();
    }

    private void cacheRecent(String botId, String chatId, String from, String fromName,
                             String text, long at, String direction, boolean ok,
                             String messageId, String error) {
        JSONObject item = new JSONObject();
        try {
            item.put("botId", botId);
            item.put("chatId", chatId == null ? "" : chatId);
            item.put("from", from == null ? "" : from);
            item.put("fromName", fromName == null ? "" : fromName);
            item.put("text", text == null ? "" : text);
            item.put("at", at);
            item.put("direction", direction);
            if ("out".equals(direction)) {
                item.put("ok", ok);
                item.put("messageId", messageId == null ? "" : messageId);
                if (error != null && !error.isEmpty()) {
                    item.put("error", error);
                }
            }
        } catch (JSONException ignored) {
            return;
        }
        synchronized (lock) {
            BotState state = states.get(botId);
            if (state == null) {
                return;
            }
            state.recent.addLast(item);
            while (state.recent.size() > RECENT_LIMIT) {
                state.recent.removeFirst();
            }
        }
    }

    // ------------------------------------------------------------ 可发送目标（botTargets）

    /** SPEC botTargets：可发送目标 JSON 数组（qqbot 频道 / telegram 最近会话 / onebot 好友）；失败 "[]"。 */
    public String targetsJson(String rawBotId) {
        String botId = rawBotId == null ? "" : rawBotId.trim();
        BotState state;
        BotConfig config;
        synchronized (lock) {
            state = states.get(botId);
            if (state == null) {
                return "[]";
            }
            config = state.config.copy();
            if (config.isQqBot() && state.targetsCache != null
                    && System.currentTimeMillis() - state.targetsCacheAt < TARGETS_CACHE_MS) {
                return state.targetsCache.toString();
            }
        }
        try {
            if (config.isQqBot()) {
                return qqTargets(state, config);
            }
            if (config.isTelegram()) {
                return telegramTargets(state);
            }
            if (config.isOneBot()) {
                return oneBotTargets(state, config);
            }
        } catch (Throwable ignored) {
            // 失败返回空数组
        }
        return "[]";
    }

    /** qqbot：拉 guilds + channels，只返回可发送的文字子频道（type==0），缓存 5 分钟。 */
    private String qqTargets(BotState state, BotConfig config) {
        try {
            QqBotApi api;
            synchronized (lock) {
                api = state.qqbot;
            }
            if (api == null) {
                api = new QqBotApi(config.appId, config.secret, config.baseUrl);
            }
            JSONArray guilds = api.getGuilds();
            JSONArray out = new JSONArray();
            int guildsSeen = 0;
            for (int i = 0; i < guilds.length() && guildsSeen < MAX_GUILDS; i++) {
                JSONObject guild = guilds.optJSONObject(i);
                if (guild == null) {
                    continue;
                }
                String guildId = valueString(guild.opt("id"));
                String guildName = guild.optString("name", "");
                if (guildId.isEmpty()) {
                    continue;
                }
                guildsSeen++;
                JSONArray channels = null;
                try {
                    channels = api.getChannels(guildId);
                } catch (Throwable ignored) {
                    // 单个频道失败不影响其它
                }
                if (channels == null) {
                    continue;
                }
                for (int j = 0; j < channels.length() && out.length() < MAX_TARGETS; j++) {
                    JSONObject channel = channels.optJSONObject(j);
                    if (channel == null || channel.optInt("type", 0) != 0) {
                        continue; // 只要文字子频道
                    }
                    String channelId = valueString(channel.opt("id"));
                    if (channelId.isEmpty()) {
                        continue;
                    }
                    String channelName = channel.optString("name", "");
                    JSONObject item = new JSONObject();
                    item.put("id", "channel:" + guildId + ":" + channelId);
                    item.put("label", (guildName.isEmpty() ? guildId : guildName)
                            + " / " + (channelName.isEmpty() ? channelId : channelName));
                    item.put("type", "channel");
                    item.put("guildId", guildId);
                    item.put("channelId", channelId);
                    item.put("guildName", guildName);
                    item.put("name", channelName);
                    out.put(item);
                }
            }
            synchronized (lock) {
                state.targetsCache = out;
                state.targetsCacheAt = System.currentTimeMillis();
            }
            return out.toString();
        } catch (Throwable t) {
            return "[]";
        }
    }

    /** telegram：从最近消息缓存去重得到最近会话。 */
    private String telegramTargets(BotState state) {
        try {
            java.util.LinkedHashMap<String, JSONObject> unique = new java.util.LinkedHashMap<>();
            synchronized (lock) {
                java.util.Iterator<JSONObject> iterator = state.recent.descendingIterator();
                while (iterator.hasNext() && unique.size() < MAX_TARGETS) {
                    JSONObject item = iterator.next();
                    String chatId = item.optString("chatId", "");
                    if (chatId.isEmpty() || unique.containsKey(chatId)) {
                        continue;
                    }
                    String fromName = item.optString("fromName", "");
                    String text = item.optString("text", "");
                    String label = !fromName.isEmpty() ? fromName
                            : (!text.isEmpty() ? text : "会话 " + chatId);
                    if (label.length() > 40) {
                        label = label.substring(0, 40);
                    }
                    JSONObject target = new JSONObject();
                    target.put("id", chatId);
                    target.put("label", label);
                    target.put("type", "chat");
                    target.put("chatId", chatId);
                    unique.put(chatId, target);
                }
            }
            JSONArray out = new JSONArray();
            for (JSONObject item : unique.values()) {
                out.put(item);
            }
            return out.toString();
        } catch (Throwable t) {
            return "[]";
        }
    }

    /** onebot：好友列表（网络失败返回空）。 */
    private String oneBotTargets(BotState state, BotConfig config) {
        try {
            OneBotApi api;
            synchronized (lock) {
                api = state.onebot;
            }
            if (api == null) {
                api = new OneBotApi(config.baseUrl, config.accessToken);
            }
            JSONArray friends = api.getFriendList();
            JSONArray out = new JSONArray();
            for (int i = 0; i < friends.length() && out.length() < MAX_TARGETS; i++) {
                JSONObject friend = friends.optJSONObject(i);
                if (friend == null) {
                    continue;
                }
                String userId = valueString(friend.opt("user_id"));
                if (userId.isEmpty()) {
                    continue;
                }
                String nickname = friend.optString("nickname", "");
                JSONObject item = new JSONObject();
                item.put("id", "private:" + userId);
                item.put("label", nickname.isEmpty() ? userId : nickname);
                item.put("type", "chat");
                item.put("userId", userId);
                out.put(item);
            }
            return out.toString();
        } catch (Throwable t) {
            return "[]";
        }
    }

    // ------------------------------------------------------------ 轮询

    private void startTelegramPolling(final BotState state, final TelegramBotApi api,
                                      final int generation) {
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                pollLoop(state, api, generation);
            }
        }, "dsh-bot-" + state.id);
        thread.setDaemon(true);
        state.pollThread = thread;
        thread.start();
    }

    private void pollLoop(BotState state, TelegramBotApi api, int generation) {
        long offset = -1L;
        while (isRunning(state, generation)) {
            try {
                if (offset < 0L) {
                    JSONArray drain = api.getUpdates(-1L, 0);
                    long lastId = -1L;
                    for (int i = 0; i < drain.length(); i++) {
                        JSONObject update = drain.optJSONObject(i);
                        if (update != null) {
                            lastId = Math.max(lastId, update.optLong("update_id", -1L));
                        }
                    }
                    offset = lastId >= 0L ? lastId + 1L : 0L;
                    markConnected(state, generation);
                    continue;
                }
                JSONArray updates = api.getUpdates(offset, (int) POLL_TIMEOUT_SECONDS);
                markConnected(state, generation);
                for (int i = 0; i < updates.length(); i++) {
                    JSONObject update = updates.optJSONObject(i);
                    if (update == null) {
                        continue;
                    }
                    long updateId = update.optLong("update_id", -1L);
                    if (updateId >= offset) {
                        offset = updateId + 1L;
                    }
                    handleUpdate(state, update);
                    if (!isRunning(state, generation)) {
                        break;
                    }
                }
            } catch (BotException e) {
                int code = e.code;
                boolean fatal = code == 401 || code == 403 || code == 404 || code == 409;
                boolean stillRunning = isRunning(state, generation);
                if (stillRunning) {
                    synchronized (lock) {
                        if (state.running && state.generation == generation) {
                            state.status = STATUS_ERROR;
                            state.message = e.getMessage();
                        }
                    }
                    emitStatus(state.id, STATUS_ERROR, e.getMessage());
                }
                if (fatal) {
                    synchronized (lock) {
                        if (state.generation == generation) {
                            state.running = false;
                            state.status = STATUS_ERROR;
                            state.message = e.getMessage();
                        }
                    }
                    break;
                }
                sleepQuietly(ERROR_RETRY_DELAY_MS);
            } catch (Throwable t) {
                if (!isRunning(state, generation)) {
                    break;
                }
                String error = "网络错误：" + message(t);
                synchronized (lock) {
                    if (state.running && state.generation == generation) {
                        state.status = STATUS_ERROR;
                        state.message = error;
                    }
                }
                emitStatus(state.id, STATUS_ERROR, error);
                sleepQuietly(ERROR_RETRY_DELAY_MS);
            }
        }
        synchronized (lock) {
            if (state.generation == generation) {
                state.running = false;
                state.pollThread = null;
            }
        }
    }

    private void markConnected(BotState state, int generation) {
        boolean recovered = false;
        String message;
        synchronized (lock) {
            if (!state.running || state.generation != generation) {
                return;
            }
            message = state.botUsername == null || state.botUsername.isEmpty()
                    ? "已连接" : "已连接：@" + state.botUsername;
            if (!STATUS_CONNECTED.equals(state.status)) {
                state.status = STATUS_CONNECTED;
                state.message = message;
                recovered = true;
            }
        }
        if (recovered) {
            emitStatus(state.id, STATUS_CONNECTED, message);
        }
    }

    private void handleUpdate(BotState state, JSONObject update) {
        JSONObject message = update.optJSONObject("message");
        if (message == null) {
            return;
        }
        String text = message.optString("text", "");
        if (text == null || text.trim().isEmpty()) {
            text = message.optString("caption", "");
        }
        if (text == null || text.trim().isEmpty()) {
            return;
        }
        JSONObject chat = message.optJSONObject("chat");
        String chatId = chat == null ? "" : valueString(chat.opt("id"));
        JSONObject from = message.optJSONObject("from");
        String fromId = from == null ? chatId : valueString(from.opt("id"));
        String fromName = "";
        if (from != null) {
            fromName = firstNonEmpty(from.optString("username", ""),
                    from.optString("first_name", ""), from.optString("last_name", ""));
        }
        if (fromName.isEmpty() && chat != null) {
            fromName = firstNonEmpty(chat.optString("title", ""),
                    chat.optString("username", ""));
        }
        long at = message.optLong("date", 0L) * 1000L;
        if (at <= 0L) {
            at = System.currentTimeMillis();
        }
        cacheRecent(state.id, chatId, fromId, fromName, text, at, "in", true, "", null);
        JSONObject event = new JSONObject();
        try {
            event.put("type", "bot-message");
            event.put("botId", state.id);
            event.put("chatId", chatId);
            event.put("from", fromId);
            event.put("fromName", fromName);
            event.put("text", text);
            event.put("at", at);
        } catch (JSONException ignored) {
            return;
        }
        emit(event);
    }

    private static String valueString(Object value) {
        if (value == null || value == JSONObject.NULL) {
            return "";
        }
        return String.valueOf(value);
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

    private boolean isRunning(BotState state, int generation) {
        return state != null && state.running && !closed && state.generation == generation;
    }

    private static void sleepQuietly(long millis) {
        try {
            Thread.sleep(Math.max(1L, millis));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // ------------------------------------------------------------ 生命周期

    /**
     * WebView 页面就绪后自动启动所有 enabled 的 bot（只触发一次），保证 bot-status/bot-message
     * 事件不会在页面监听注册前丢失。
     */
    public void onPageReady() {
        List<String> ids = new ArrayList<>();
        synchronized (lock) {
            if (closed || autoStartDone) {
                return;
            }
            autoStartDone = true;
            for (BotConfig config : configs) {
                BotState state = states.get(config.id);
                if (state != null && config.enabled && !state.running) {
                    ids.add(config.id);
                }
            }
        }
        for (String id : ids) {
            start(id);
        }
    }

    /** JsBridge.release()：停止所有轮询、取消在途请求、关闭线程池。 */
    public void shutdown() {
        List<Thread> toJoin = new ArrayList<>();
        synchronized (lock) {
            if (closed) {
                return;
            }
            closed = true;
            for (BotState state : states.values()) {
                state.running = false;
                TelegramBotApi telegram = state.telegram;
                state.telegram = null;
                if (telegram != null) {
                    try {
                        telegram.cancel();
                    } catch (Throwable ignored) {
                        // 忽略
                    }
                }
                OneBotApi onebot = state.onebot;
                state.onebot = null;
                if (onebot != null) {
                    try {
                        onebot.cancel();
                    } catch (Throwable ignored) {
                        // 忽略
                    }
                }
                QqBotApi qqbot = state.qqbot;
                state.qqbot = null;
                if (qqbot != null) {
                    try {
                        qqbot.cancel();
                    } catch (Throwable ignored) {
                        // 忽略
                    }
                }
                state.targetsCache = null;
                state.targetsCacheAt = 0L;
                Thread thread = state.pollThread;
                state.pollThread = null;
                if (thread != null && thread != Thread.currentThread()) {
                    toJoin.add(thread);
                }
                state.status = STATUS_STOPPED;
                state.message = "";
            }
        }
        joinQuietly(toJoin);
        try {
            ioPool.shutdownNow();
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    // ------------------------------------------------------------ 事件

    private void emitStatus(String botId, String status, String message) {
        JSONObject event = new JSONObject();
        try {
            event.put("type", "bot-status");
            event.put("botId", botId == null ? "" : botId);
            event.put("status", status == null ? STATUS_STOPPED : status);
            event.put("message", message == null ? "" : message);
        } catch (JSONException ignored) {
            return;
        }
        emit(event);
    }

    private void emitSent(String botId, String chatId, boolean ok, String messageId, String error) {
        JSONObject event = new JSONObject();
        try {
            event.put("type", "bot-sent");
            event.put("botId", botId == null ? "" : botId);
            event.put("chatId", chatId == null ? "" : chatId);
            event.put("ok", ok);
            event.put("messageId", messageId == null ? "" : messageId);
            if (error != null && !error.isEmpty()) {
                event.put("error", error);
            }
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
            // 事件通道异常不影响 Bot 主流程
        }
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
