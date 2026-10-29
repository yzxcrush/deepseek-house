package com.deepseekhouse.app;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * F7：生成期间的前台服务（{@code foregroundServiceType="dataSync"}）。
 *
 * <p>JS 在请求开始/结束分别调用 {@code DSNative.setForeground(true|false, text)}；
 * 本服务只负责让系统在 App 退到后台后仍允许网络流式读取，并常驻一条低优先级通知。
 * 不使用 START_STICKY：进程被杀后不应悄悄恢复。</p>
 */
public final class GenerationService extends Service {

    public static final String EXTRA_TEXT = "text";

    /** 启动前台服务（API 26+ 走 {@code startForegroundService}）。 */
    public static void start(Context context, String text) {
        if (context == null) {
            return;
        }
        try {
            Intent intent = new Intent(context, GenerationService.class);
            intent.putExtra(EXTRA_TEXT, text == null ? "" : text);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Throwable ignored) {
            // 后台启动限制 / 权限异常：放弃前台服务，SSE 仍可继续（只是可能被系统回收）
        }
    }

    /** 停止前台服务并移除常驻通知（onDestroy 里 stopForeground + cancel）。 */
    public static void stop(Context context) {
        if (context == null) {
            return;
        }
        try {
            context.stopService(new Intent(context, GenerationService.class));
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Notifications.ensureChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = intent == null ? null : intent.getStringExtra(EXTRA_TEXT);
        Notification notification;
        try {
            notification = Notifications.buildGenerating(this, text);
        } catch (Throwable t) {
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(Notifications.GENERATING_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(Notifications.GENERATING_ID, notification);
            }
        } catch (Throwable t) {
            // 类型声明不被 ROM 支持时退回普通 startForeground
            try {
                startForeground(Notifications.GENERATING_ID, notification);
            } catch (Throwable ignored) {
                stopSelf();
            }
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                //noinspection deprecation
                stopForeground(true);
            }
        } catch (Throwable ignored) {
            // 忽略
        }
        Notifications.cancelGenerating(this);
        super.onDestroy();
    }
}
