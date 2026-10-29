package com.deepseekhouse.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.text.TextUtils;

/**
 * F7 通知：两个渠道 + 构建/投递工具。
 *
 * <ul>
 *   <li>{@link #CHANNEL_GENERATING}「生成中」：{@code IMPORTANCE_LOW}，生成期间常驻的前台服务通知。</li>
 *   <li>{@link #CHANNEL_MESSAGES}「消息」：{@code IMPORTANCE_DEFAULT}，生成完成等一次性通知。</li>
 * </ul>
 *
 * <p>API 33+ 发通知需要 {@code POST_NOTIFICATIONS} 运行时权限（MainActivity 启动时请求），
 * 未授权时静默丢弃，不抛异常。</p>
 */
public final class Notifications {

    public static final String CHANNEL_GENERATING = "dsh_generating";
    public static final String CHANNEL_MESSAGES = "dsh_messages";

    /** 前台服务通知 id（固定，重复 startForeground 会复用同一条）。 */
    public static final int GENERATING_ID = 1001;

    private static final int MESSAGE_ID_BASE = 2001;

    private Notifications() {
    }

    /** 幂等创建两个通知渠道（API 26+）。 */
    public static void ensureChannels(Context context) {
        if (context == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = manager(context);
        if (manager == null) {
            return;
        }
        try {
            NotificationChannel generating = new NotificationChannel(
                    CHANNEL_GENERATING,
                    context.getString(R.string.notify_channel_generating),
                    NotificationManager.IMPORTANCE_LOW);
            generating.setDescription(context.getString(R.string.notify_channel_generating_desc));
            generating.setShowBadge(false);
            manager.createNotificationChannel(generating);

            NotificationChannel messages = new NotificationChannel(
                    CHANNEL_MESSAGES,
                    context.getString(R.string.notify_channel_messages),
                    NotificationManager.IMPORTANCE_DEFAULT);
            messages.setDescription(context.getString(R.string.notify_channel_messages_desc));
            manager.createNotificationChannel(messages);
        } catch (Throwable ignored) {
            // 渠道创建失败（个别 ROM）不影响主流程
        }
    }

    /** 生成期间的前台服务通知：低优先级、持续、不可划掉。 */
    public static Notification buildGenerating(Context context, String text) {
        ensureChannels(context);
        String content = TextUtils.isEmpty(text)
                ? context.getString(R.string.notify_generating_text)
                : text;
        Notification.Builder builder = newBuilder(context, CHANNEL_GENERATING);
        builder.setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(context.getString(R.string.notify_generating_title))
                .setContentText(content)
                .setStyle(new Notification.BigTextStyle().bigText(content))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setContentIntent(openAppIntent(context, 0));
        return builder.build();
    }

    /** F7 完成通知：默认优先级，可点击回到 App，可划掉。 */
    public static void showMessage(Context context, String title, String text) {
        if (context == null || !canNotify(context)) {
            return;
        }
        ensureChannels(context);
        String safeTitle = TextUtils.isEmpty(title)
                ? context.getString(R.string.app_name)
                : title;
        String safeText = text == null ? "" : text;
        Notification.Builder builder = newBuilder(context, CHANNEL_MESSAGES);
        builder.setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(safeTitle)
                .setContentText(safeText)
                .setStyle(new Notification.BigTextStyle().bigText(safeText))
                .setAutoCancel(true)
                .setShowWhen(true)
                .setContentIntent(openAppIntent(context, MESSAGE_ID_BASE + 1));
        int id = MESSAGE_ID_BASE + (int) (System.currentTimeMillis() % 1000);
        NotificationManager manager = manager(context);
        if (manager == null) {
            return;
        }
        try {
            manager.notify(id, builder.build());
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    /** 移除前台服务通知（服务 onDestroy 兜底）。 */
    public static void cancelGenerating(Context context) {
        NotificationManager manager = manager(context);
        if (manager == null) {
            return;
        }
        try {
            manager.cancel(GENERATING_ID);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    /** API 33+ 检查 POST_NOTIFICATIONS；低版本始终允许。 */
    public static boolean canNotify(Context context) {
        if (context == null) {
            return false;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true;
        }
        try {
            return context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    // ------------------------------------------------------------ 内部工具

    private static Notification.Builder newBuilder(Context context, String channel) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return new Notification.Builder(context, channel);
        }
        //noinspection deprecation
        return new Notification.Builder(context);
    }

    private static PendingIntent openAppIntent(Context context, int requestCode) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        try {
            return PendingIntent.getActivity(context, requestCode, intent, flags);
        } catch (Throwable t) {
            return null;
        }
    }

    private static NotificationManager manager(Context context) {
        if (context == null) {
            return null;
        }
        try {
            return (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        } catch (Throwable t) {
            return null;
        }
    }
}
