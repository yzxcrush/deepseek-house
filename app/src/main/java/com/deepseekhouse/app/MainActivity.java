package com.deepseekhouse.app;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.util.Locale;

/**
 * 唯一 Activity：一个 WebView 承载全部 UI，原生层只提供桥接与系统能力。
 *
 * <p>页面来自 {@code file:///android_asset/web/index.html}；外部链接交给系统浏览器；
 * 返回键按 JS 上报的 backDepth 分层，到达根界面后把任务切到后台。</p>
 */
public final class MainActivity extends Activity {

    private static final String ASSET_URL = "file:///android_asset/web/index.html";
    private static final String COLOR_BG = "#17212B";
    private static final String COLOR_PANEL = "#0E1621";

    private static final int REQ_APP_LOCK = 1000;
    private static final int REQ_IMPORT = 1001;
    private static final int REQ_EXPORT = 1002;
    private static final int REQ_PICK_TEXT = 1003;
    private static final int REQ_PICK_IMAGE = 1004;
    private static final int REQ_CAMERA = 1005;
    private static final int REQ_NOTIFICATION_PERMISSION = 2001;

    /** F9：同一进程内验证过一次后不再拦截（进程重启后自动重新要求验证）。 */
    private static volatile boolean sUnlockedInProcess;

    private volatile WebView webView;
    private JsBridge bridge;
    private Prefs prefs;
    private volatile int backDepth;
    private volatile boolean foreground = true;
    /** 正在由 App 自己拉起系统界面（SAF / 相机 / 应用锁）：这期间的 onPause 不算“退到后台”。 */
    private volatile boolean internalActivity;
    private boolean notificationPermissionRequested;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureWindow();
        prefs = new Prefs(this);

        WebView view = new WebView(this);
        view.setBackgroundColor(parseColor(COLOR_BG, Color.BLACK));
        configureWebView(view);
        setContentView(view);
        webView = view;

        // Bridge 需要在 webView 就绪后创建，事件回调用到 activity.getWebView()
        bridge = new JsBridge(this);
        view.addJavascriptInterface(bridge, JsBridge.JS_NAME);

        // F8：从其他 App 分享进来的内容，页面加载完成（onPageFinished）后一次性投递
        bridge.onShareIntent(getIntent());

        // F9：开启应用锁时，先做系统身份验证，成功后才加载 WebView
        if (prefs.isAppLockEnabled() && !sUnlockedInProcess) {
            startLockPrompt();
        } else {
            sUnlockedInProcess = true;
            loadStartUrl();
        }
    }

    private void loadStartUrl() {
        WebView view = webView;
        if (view == null) {
            return;
        }
        try {
            view.loadUrl(ASSET_URL);
        } catch (Throwable ignored) {
            // 加载失败时界面保持深色空屏，用户可重开
        }
    }

    // ------------------------------------------------------------ WebView 配置

    @SuppressWarnings("deprecation")
    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        // assets 页面需要读取本地资源，并允许跨源请求（file:// -> 远端 API）
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        // 自建 endpoint 可能是 http，允许混合内容
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setGeolocationEnabled(false);
        settings.setSaveFormData(false);
        settings.setDefaultTextEncodingName("utf-8");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                // 深色 UI 由页面自身负责，关闭系统强制深色/反色
                settings.setForceDark(WebSettings.FORCE_DARK_OFF);
            } catch (Throwable ignored) {
                // 部分机型不支持，忽略
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                // API 33+ 用算法深色替代已废弃的 setForceDark，明确关闭反色
                settings.setAlgorithmicDarkeningAllowed(false);
            } catch (Throwable ignored) {
                // 忽略
            }
        }

        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                return handleNavigation(request == null || request.getUrl() == null
                        ? null : request.getUrl().toString());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                return handleNavigation(url);
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                super.onPageFinished(v, url);
                if (url == null || !url.startsWith("file:///android_asset/")) {
                    return;
                }
                JsBridge b = bridge;
                if (b != null) {
                    // F7 上报前台状态（页面刚就绪时补发一次）+ F8 投递一次分享内容
                    b.onPageFinished();
                }
            }
        });
    }

    /** 外部 http(s)/mailto 走系统；assets 内部导航放行；未知 scheme 一律拦截。 */
    private boolean handleNavigation(String url) {
        if (url == null || url.isEmpty()) {
            return false;
        }
        if (url.startsWith("file:///android_asset/")) {
            return false;
        }
        String lower = url.toLowerCase(Locale.US);
        if (lower.startsWith("about:") || lower.startsWith("javascript:")
                || lower.startsWith("data:") || lower.startsWith("blob:")) {
            return false;
        }
        if (lower.startsWith("file:")) {
            return true; // 只允许 assets 内页面，其它本地文件拦截
        }
        if (lower.startsWith("http://") || lower.startsWith("https://")) {
            openExternalUrl(url);
            return true;
        }
        if (lower.startsWith("mailto:") || lower.startsWith("tel:") || lower.startsWith("sms:")) {
            startExternal(url);
            return true;
        }
        return true; // intent:// 等未知 scheme 一律不加载
    }

    // ------------------------------------------------------------ 窗口 / 状态栏

    private void configureWindow() {
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
                | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
        window.setStatusBarColor(parseColor(COLOR_BG, Color.BLACK));
        window.setNavigationBarColor(parseColor(COLOR_PANEL, Color.BLACK));
        applyLightStatusIcons(false);
    }

    @SuppressWarnings("deprecation")
    private void applyLightStatusIcons(boolean lightIcons) {
        View decor = getWindow().getDecorView();
        int flags = decor.getSystemUiVisibility();
        if (lightIcons) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        } else {
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        }
        decor.setSystemUiVisibility(flags);
    }

    /** §3.1 setStatusBar：在 UI 线程设置状态栏颜色与图标明暗。 */
    public void applyStatusBar(final String colorHex, final boolean lightIcons) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                int color = parseColor(colorHex, parseColor(COLOR_BG, Color.BLACK));
                getWindow().setStatusBarColor(color);
                applyLightStatusIcons(lightIcons);
            }
        });
    }

    // ------------------------------------------------------------ F7 通知权限

    private void requestNotificationPermissionIfNeeded() {
        if (notificationPermissionRequested || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        notificationPermissionRequested = true;
        try {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED) {
                return;
            }
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    REQ_NOTIFICATION_PERMISSION);
        } catch (Throwable ignored) {
            // 权限请求失败时通知静默丢弃，不影响主流程
        }
    }

    // ------------------------------------------------------------ F9 应用锁

    /** 启动时用系统凭证（PIN/图案/密码/指纹）验证身份；取消则退出 App。 */
    @SuppressWarnings("deprecation")
    private void startLockPrompt() {
        Intent intent = null;
        try {
            KeyguardManager keyguard =
                    (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
            if (keyguard != null) {
                intent = keyguard.createConfirmDeviceCredentialIntent(
                        getString(R.string.app_lock_title),
                        getString(R.string.app_lock_subtitle));
            }
        } catch (Throwable ignored) {
            intent = null;
        }
        if (intent == null) {
            // 设备未设置锁屏密码时无法验证；直接放行并提示（否则用户会被永久锁在门外）
            Toast.makeText(this, R.string.app_lock_unavailable, Toast.LENGTH_LONG).show();
            sUnlockedInProcess = true;
            loadStartUrl();
            return;
        }
        try {
            internalActivity = true;
            startActivityForResult(intent, REQ_APP_LOCK);
        } catch (Throwable t) {
            internalActivity = false;
            sUnlockedInProcess = true;
            loadStartUrl();
        }
    }

    /** F9：设置页开关变化后，当前会话不再拦截（下次启动生效）。 */
    public void onAppLockSettingChanged(boolean enabled) {
        sUnlockedInProcess = true;
    }

    // ------------------------------------------------------------ SAF：插件导入 / 导出

    public void startImportFile() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                            "application/javascript", "text/javascript",
                            "application/json", "text/plain"});
                    internalActivity = true;
                    startActivityForResult(intent, REQ_IMPORT);
                } catch (Throwable t) {
                    internalActivity = false;
                    JsBridge b = bridge;
                    if (b != null) {
                        b.onImportCancelled(getString(R.string.err_no_file_manager));
                    }
                }
            }
        });
    }

    public void startExportFile(final String suggestedName) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("text/plain");
                    if (suggestedName != null && !suggestedName.trim().isEmpty()) {
                        intent.putExtra(Intent.EXTRA_TITLE, suggestedName.trim());
                    }
                    internalActivity = true;
                    startActivityForResult(intent, REQ_EXPORT);
                } catch (Throwable t) {
                    internalActivity = false;
                    JsBridge b = bridge;
                    if (b != null) {
                        b.onExportCancelled(getString(R.string.err_no_file_manager));
                    }
                }
            }
        });
    }

    // ------------------------------------------------------------ F3 备份导入

    /** F3：选择 .json 文本文件（SAF），读取后由 JsBridge 发 file-imported 事件。 */
    public void startTextImport() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    // 放开到 */*：部分文件管理器把 .json 标成 octet-stream；内容由 JS 侧校验
                    intent.setType("*/*");
                    intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                            "application/json", "text/plain", "*/*"});
                    internalActivity = true;
                    startActivityForResult(intent, REQ_PICK_TEXT);
                } catch (Throwable t) {
                    internalActivity = false;
                    JsBridge b = bridge;
                    if (b != null) {
                        b.onTextImportCancelled(getString(R.string.err_no_file_manager));
                    }
                }
            }
        });
    }

    // ------------------------------------------------------------ F6 图片输入

    /** F6：source='gallery' 从相册选；'camera' 调系统相机拍照。 */
    public void startPickImage(final String source) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if ("camera".equalsIgnoreCase(source)) {
                    startCameraCapture();
                } else {
                    startGalleryPick();
                }
            }
        });
    }

    private void startGalleryPick() {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("image/*");
            internalActivity = true;
            startActivityForResult(intent, REQ_PICK_IMAGE);
        } catch (Throwable t) {
            internalActivity = false;
            JsBridge b = bridge;
            if (b != null) {
                b.onImageError(getString(R.string.err_no_file_manager));
            }
        }
    }

    private void startCameraCapture() {
        CameraFileProvider.cleanup(this);
        Uri output = CameraFileProvider.uriFor();
        Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        intent.putExtra(MediaStore.EXTRA_OUTPUT, output);
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        internalActivity = true;
        try {
            startActivityForResult(intent, REQ_CAMERA);
        } catch (Throwable t) {
            internalActivity = false;
            CameraFileProvider.cleanup(this);
            JsBridge b = bridge;
            if (b != null) {
                b.onImageError(getString(R.string.err_no_camera));
            }
        }
    }

    // ------------------------------------------------------------ Activity 结果

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        internalActivity = false;
        JsBridge b = bridge;

        if (requestCode == REQ_APP_LOCK) {
            if (resultCode == RESULT_OK) {
                sUnlockedInProcess = true;
                loadStartUrl();
            } else {
                Toast.makeText(this, R.string.app_lock_verify_failed, Toast.LENGTH_SHORT).show();
                finish();
            }
            return;
        }
        if (b == null) {
            return;
        }
        if (requestCode == REQ_IMPORT) {
            b.onImportResult(resultCode, data);
        } else if (requestCode == REQ_EXPORT) {
            b.onExportResult(resultCode, data);
        } else if (requestCode == REQ_PICK_TEXT) {
            b.onTextImportResult(resultCode, data);
        } else if (requestCode == REQ_PICK_IMAGE) {
            b.onImageResult(resultCode, data, "gallery");
        } else if (requestCode == REQ_CAMERA) {
            b.onImageResult(resultCode, data, "camera");
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent == null) {
            return;
        }
        setIntent(intent);
        JsBridge b = bridge;
        if (b != null) {
            // F8：App 已在运行时再次收到分享
            b.onShareIntent(intent);
        }
    }

    // ------------------------------------------------------------ 系统能力

    /** §3.1 openUrl：交给系统浏览器/其他 App 打开。 */
    public void openExternalUrl(final String url) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                startExternal(url);
            }
        });
    }

    private void startExternal(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Throwable t) {
            Toast.makeText(this, R.string.err_no_browser, Toast.LENGTH_SHORT).show();
        }
    }

    /** §3.1 finishApp：退出应用。 */
    public void finishApp() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                finish();
            }
        });
    }

    // ------------------------------------------------------------ 返回键分层

    public void setBackDepth(int depth) {
        backDepth = Math.max(0, depth);
    }

    public int getBackDepth() {
        return backDepth;
    }

    @Override
    public void onBackPressed() {
        WebView view = webView;
        if (backDepth > 0 && view != null) {
            try {
                view.evaluateJavascript(
                        "if (window.DSHost && window.DSHost.back) { window.DSHost.back(); }", null);
                return;
            } catch (Throwable ignored) {
                // JS 通道异常时退回后台
            }
        }
        moveTaskToBack(true);
    }

    // ------------------------------------------------------------ 生命周期

    @Override
    protected void onResume() {
        super.onResume();
        // 从 SAF / 相机 / 应用锁返回时 onResume 在 onActivityResult 之后执行
        internalActivity = false;
        WebView view = webView;
        if (view != null) {
            view.onResume();
        }
        updateForeground(true);
        // F7：等应用锁验证/首屏就绪后再请求通知权限，避免和系统验证界面叠在一起
        if (sUnlockedInProcess) {
            requestNotificationPermissionIfNeeded();
        }
    }

    @Override
    protected void onPause() {
        WebView view = webView;
        if (view != null) {
            // 不调用 pauseTimers()：后台时仍允许 SSE 流式回调继续投递
            view.onPause();
        }
        // 选择文件/拍照/验证身份导致的 onPause 不算退到后台（F7 完成通知只针对真正离开 App）
        if (!internalActivity) {
            updateForeground(false);
        }
        super.onPause();
    }

    /** F7：给 JS 上报前台状态（onResume/onPause 变化时 + 页面加载完成时补发）。 */
    private void updateForeground(boolean isForeground) {
        if (foreground == isForeground) {
            return;
        }
        foreground = isForeground;
        JsBridge b = bridge;
        if (b != null) {
            b.onAppState(isForeground);
        }
    }

    public boolean isAppForeground() {
        return foreground;
    }

    @Override
    protected void onDestroy() {
        JsBridge b = bridge;
        bridge = null;
        if (b != null) {
            b.release();
        }
        // F7：Activity 销毁后 SSE 线程随 bridge 一起释放，前台服务也不应继续常驻
        GenerationService.stop(this);
        WebView view = webView;
        webView = null;
        if (view != null) {
            try {
                view.removeJavascriptInterface(JsBridge.JS_NAME);
            } catch (Throwable ignored) {
                // 忽略
            }
            try {
                view.loadUrl("about:blank");
            } catch (Throwable ignored) {
                // 忽略
            }
            try {
                view.destroy();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------ 工具

    public WebView getWebView() {
        return webView;
    }

    private static int parseColor(String hex, int fallback) {
        if (hex == null) {
            return fallback;
        }
        String value = hex.trim();
        if (value.isEmpty()) {
            return fallback;
        }
        if (!value.startsWith("#")) {
            value = "#" + value;
        }
        try {
            return Color.parseColor(value);
        } catch (Throwable t) {
            return fallback;
        }
    }
}
