package com.deepseekhouse.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
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

    private static final int REQ_IMPORT = 1001;
    private static final int REQ_EXPORT = 1002;

    private volatile WebView webView;
    private JsBridge bridge;
    private volatile int backDepth;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureWindow();

        WebView view = new WebView(this);
        view.setBackgroundColor(parseColor(COLOR_BG, Color.BLACK));
        configureWebView(view);
        setContentView(view);
        webView = view;

        // Bridge 需要在 webView 就绪后创建，事件回调用到 activity.getWebView()
        bridge = new JsBridge(this);
        view.addJavascriptInterface(bridge, JsBridge.JS_NAME);
        view.loadUrl(ASSET_URL);
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

    // ------------------------------------------------------------ SAF

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
                    startActivityForResult(intent, REQ_IMPORT);
                } catch (Throwable t) {
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
                    startActivityForResult(intent, REQ_EXPORT);
                } catch (Throwable t) {
                    JsBridge b = bridge;
                    if (b != null) {
                        b.onExportCancelled(getString(R.string.err_no_file_manager));
                    }
                }
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        JsBridge b = bridge;
        if (b == null) {
            return;
        }
        if (requestCode == REQ_IMPORT) {
            b.onImportResult(resultCode, data);
        } else if (requestCode == REQ_EXPORT) {
            b.onExportResult(resultCode, data);
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
        WebView view = webView;
        if (view != null) {
            view.onResume();
        }
    }

    @Override
    protected void onPause() {
        WebView view = webView;
        if (view != null) {
            // 不调用 pauseTimers()：后台时仍允许 SSE 流式回调继续投递
            view.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        JsBridge b = bridge;
        bridge = null;
        if (b != null) {
            b.release();
        }
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
