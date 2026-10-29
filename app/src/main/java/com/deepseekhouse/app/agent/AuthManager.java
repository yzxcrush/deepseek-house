package com.deepseekhouse.app.agent;

import android.content.Context;

import com.deepseekhouse.app.Notifications;
import com.deepseekhouse.app.Prefs;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 手机号登录（本地 OTP MVP，SPEC N1 AuthManager）。
 *
 * <p><b>演示模式</b>：验证码不真正发短信，而是通过通知渠道「登录验证码」展示，
 * 同时随 {@code otp-sent} 事件带 {@code demoCode} 便于本机联调。后续接自建后端/短信服务商时，
 * 只需替换 {@link SmsProvider} 实现，其余逻辑（有效期/限频/锁定/token）不变。</p>
 *
 * <ul>
 *   <li>6 位数字验证码，5 分钟有效；</li>
 *   <li>同一手机号 60 秒内只能发送一次；</li>
 *   <li>连续输错 3 次锁定 5 分钟；</li>
 *   <li>验证成功生成 32 位 hex token 存 {@link Prefs}，并保存手机号；</li>
 *   <li>{@link #logout()} 只清 token，保留手机号（便于下次启动识别“已绑定未登录”）。</li>
 * </ul>
 */
public final class AuthManager {

    public static final int OTP_LENGTH = 6;
    public static final int OTP_TTL_SECONDS = 300;
    public static final long OTP_TTL_MS = 5 * 60 * 1000L;
    public static final long RESEND_INTERVAL_MS = 60 * 1000L;
    public static final int MAX_ATTEMPTS = 3;
    public static final long LOCK_MS = 5 * 60 * 1000L;

    private static final char[] HEX = "0123456789abcdef".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();

    /** 短信发送抽象：默认 {@link LocalNotificationSmsProvider}（本地演示），后续可换成真实短信。 */
    public interface SmsProvider {
        boolean send(String phone, String code);
    }

    /** requestOtp 的结果（JsBridge 负责转成 otp-sent 事件）。 */
    public static final class OtpResult {
        public final boolean ok;
        public final String phone;
        public final int ttlSeconds;
        public final String demoCode;
        public final String message;

        public OtpResult(boolean ok, String phone, int ttlSeconds, String demoCode, String message) {
            this.ok = ok;
            this.phone = phone == null ? "" : phone;
            this.ttlSeconds = ttlSeconds;
            this.demoCode = demoCode == null ? "" : demoCode;
            this.message = message == null ? "" : message;
        }
    }
    /** verifyOtp 的结果（JsBridge 负责转成 otp-verified 事件）。 */
    public static final class VerifyResult {
        public final boolean ok;
        public final String message;
        public final String phone;
        public final boolean loggedIn;

        public VerifyResult(boolean ok, String message, String phone, boolean loggedIn) {
            this.ok = ok;
            this.message = message == null ? "" : message;
            this.phone = phone == null ? "" : phone;
            this.loggedIn = loggedIn;
        }
    }

    /** 待验证的一次验证码状态。 */
    private static final class Pending {
        final String code;
        final long expiresAt;
        long sentAt;
        int attempts;
        long lockedUntil;

        Pending(String code, long expiresAt, long sentAt) {
            this.code = code;
            this.expiresAt = expiresAt;
            this.sentAt = sentAt;
        }
    }

    private final Context context;
    private final Prefs prefs;
    private final SmsProvider smsProvider;
    private final Map<String, Pending> pending = new HashMap<>();

    public AuthManager(Context context, Prefs prefs) {
        this(context, prefs, null);
    }

    public AuthManager(Context context, Prefs prefs, SmsProvider smsProvider) {
        if (context == null) {
            throw new IllegalArgumentException("context == null");
        }
        this.context = context.getApplicationContext();
        this.prefs = prefs == null ? new Prefs(this.context) : prefs;
        this.smsProvider = smsProvider == null
                ? new LocalNotificationSmsProvider(this.context)
                : smsProvider;
    }

    // ------------------------------------------------------------ 发送验证码

    /** 生成并“发送”验证码；限频检查失败时 {@code ok=false} 且不覆盖已有验证码。 */
    public synchronized OtpResult requestOtp(String rawPhone) {
        String phone = normalizePhone(rawPhone);
        if (!isValidPhone(phone)) {
            return new OtpResult(false, phone, 0, "", "手机号格式不正确（请输入 6–20 位数字）");
        }
        long now = System.currentTimeMillis();
        Pending previous = pending.get(phone);
        if (previous != null && previous.sentAt > 0L
                && now - previous.sentAt < RESEND_INTERVAL_MS) {
            long waitSeconds = (RESEND_INTERVAL_MS - (now - previous.sentAt) + 999L) / 1000L;
            return new OtpResult(false, phone, 0, "",
                    "发送过于频繁，请 " + Math.max(1L, waitSeconds) + " 秒后重试");
        }
        String code = randomCode();
        boolean sent;
        try {
            sent = smsProvider.send(phone, code);
        } catch (Throwable t) {
            sent = false;
        }
        if (!sent) {
            return new OtpResult(false, phone, 0, "", "验证码发送失败，请稍后重试");
        }
        pending.put(phone, new Pending(code, now + OTP_TTL_MS, now));
        return new OtpResult(true, phone, OTP_TTL_SECONDS, code, "验证码已发送");
    }

    // ------------------------------------------------------------ 校验验证码

    /** 校验验证码；成功时生成 token 并写 Prefs。 */
    public synchronized VerifyResult verifyOtp(String rawPhone, String rawCode) {
        String phone = normalizePhone(rawPhone);
        if (!isValidPhone(phone)) {
            return new VerifyResult(false, "手机号格式不正确", phone, isLoggedIn());
        }
        String code = rawCode == null ? "" : rawCode.trim();
        if (code.isEmpty()) {
            return new VerifyResult(false, "请输入验证码", phone, isLoggedIn());
        }
        Pending state = pending.get(phone);
        if (state == null) {
            return new VerifyResult(false, "请先获取验证码", phone, isLoggedIn());
        }
        long now = System.currentTimeMillis();
        if (state.lockedUntil > now) {
            long waitSeconds = (state.lockedUntil - now + 999L) / 1000L;
            return new VerifyResult(false,
                    "错误次数过多，请 " + Math.max(1L, waitSeconds) + " 秒后再试",
                    phone, isLoggedIn());
        }
        if (now > state.expiresAt) {
            pending.remove(phone);
            return new VerifyResult(false, "验证码已过期，请重新获取", phone, isLoggedIn());
        }
        if (!state.code.equals(code)) {
            state.attempts++;
            if (state.attempts >= MAX_ATTEMPTS) {
                state.attempts = 0;
                state.lockedUntil = now + LOCK_MS;
                return new VerifyResult(false,
                        "验证码错误次数过多，已锁定 5 分钟", phone, isLoggedIn());
            }
            return new VerifyResult(false,
                    "验证码错误（还可尝试 " + (MAX_ATTEMPTS - state.attempts) + " 次）",
                    phone, isLoggedIn());
        }

        String token = randomToken();
        prefs.setAuthToken(token);
        prefs.setAuthPhone(phone);
        pending.remove(phone);
        return new VerifyResult(true, "登录成功", phone, true);
    }

    // ------------------------------------------------------------ 状态 / 登出

    public boolean isLoggedIn() {
        String token = prefs.getAuthToken();
        return token != null && !token.isEmpty();
    }

    /** 已绑定的手机号（登出后仍保留，用于“已绑定未登录”的启动分支）。 */
    public String phone() {
        String phone = prefs.getAuthPhone();
        return phone == null ? "" : phone;
    }

    /** SPEC authState：{@code {"loggedIn":bool,"phone":".."}}。 */
    public String authStateJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("loggedIn", isLoggedIn());
            o.put("phone", phone());
        } catch (JSONException e) {
            return "{\"loggedIn\":false,\"phone\":\"\"}";
        }
        return o.toString();
    }

    /** 登出：清 token（手机号保留，便于重新登录）。 */
    public synchronized void logout() {
        prefs.setAuthToken("");
        pending.clear();
    }

    // ------------------------------------------------------------ 内部工具

    /** 默认演示实现：用通知渠道「登录验证码」展示验证码。 */
    public static final class LocalNotificationSmsProvider implements SmsProvider {
        private final Context context;

        public LocalNotificationSmsProvider(Context context) {
            this.context = context.getApplicationContext();
        }

        @Override
        public boolean send(String phone, String code) {
            try {
                Notifications.showLoginCode(context, phone, code);
                return true;
            } catch (Throwable t) {
                return false;
            }
        }
    }

    private static String randomCode() {
        int value = RANDOM.nextInt(1000000);
        return String.format(Locale.US, "%06d", value);
    }

    private static String randomToken() {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            int b = bytes[i] & 0xFF;
            out[i * 2] = HEX[b >>> 4];
            out[i * 2 + 1] = HEX[b & 0x0F];
        }
        return new String(out);
    }

    /** 只保留数字（去掉空格/横线/括号/前导 +）。 */
    public static String normalizePhone(String raw) {
        if (raw == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c >= '0' && c <= '9') {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private static boolean isValidPhone(String phone) {
        return phone.length() >= 6 && phone.length() <= 20;
    }
}
