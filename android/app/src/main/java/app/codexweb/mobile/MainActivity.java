package app.codexweb.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int PICK_FILES = 10;
    private static final int SAVE_FILE = 11;
    private static final int MICROPHONE = 12;
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    private FrameLayout root;
    private WebView web;
    private ProgressBar progress;
    private View connectionScreen;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest microphoneRequest;
    private String server;
    private String downloadUrl;
    private String downloadMime;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        root = new FrameLayout(this);
        root.setFitsSystemWindows(true);
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((view, windowInsets) -> {
                Insets bars = windowInsets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        server = getPreferences(MODE_PRIVATE).getString("server", "");
        if (state != null) {
            downloadUrl = state.getString("downloadUrl");
            downloadMime = state.getString("downloadMime");
        }
        if (server.isEmpty()) showConnection(null);
        else {
            try {
                server = ServerPolicy.normalize(server);
                createWebView();
                web.loadUrl(server);
            } catch (IllegalArgumentException error) {
                server = "";
                showConnection(error.getMessage());
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        if (web != null) return;
        web = new WebView(this);
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setUserAgentString(settings.getUserAgentString() + " CodexWebAndroid/0.1.0");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (!request.isForMainFrame()) return !ServerPolicy.inApp(server, url);
                if (url.equals("codexweb://settings") && request.hasGesture() && trustedPage()) {
                    showSettings();
                    return true;
                }
                if (ServerPolicy.inApp(server, url)) return false;
                if (request.hasGesture()) openExternal(url);
                else showConnection("已阻止跳转到服务范围以外的页面。请检查服务地址。原会话仍保留。");
                return true;
            }

            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                denyMicrophone();
                if (!ServerPolicy.inApp(server, url)) {
                    view.stopLoading();
                    showConnection("已阻止不受信任的页面。");
                }
            }

            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
            }

            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showConnection("HTTPS 证书验证失败。请修复服务器证书，App 不会绕过验证。");
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showConnection("暂时无法连接服务器。请检查网络或 VPN 后重试。服务器上的任务不会因此停止。");
            }

            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 400) showConnection("服务器返回 HTTP " + response.getStatusCode() + "。请检查部署状态和地址。");
            }

            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                denyMicrophone();
                cancelFilePicker();
                root.removeView(view);
                view.destroy();
                web = null;
                if (progress != null) root.removeView(progress);
                showConnection("页面进程已被系统回收。重新连接将恢复服务器上已保存的会话与草稿。");
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsAlert(WebView view, String url, String text, JsResult result) {
                if (!ServerPolicy.inApp(server, url)) { result.cancel(); return true; }
                new AlertDialog.Builder(MainActivity.this).setMessage(text)
                        .setPositiveButton("确定", (dialog, which) -> result.confirm())
                        .setOnCancelListener(dialog -> result.cancel()).show();
                return true;
            }

            @Override public boolean onJsConfirm(WebView view, String url, String text, JsResult result) {
                if (!ServerPolicy.inApp(server, url)) { result.cancel(); return true; }
                new AlertDialog.Builder(MainActivity.this).setMessage(text)
                        .setPositiveButton("确认", (dialog, which) -> result.confirm())
                        .setNegativeButton("取消", (dialog, which) -> result.cancel())
                        .setOnCancelListener(dialog -> result.cancel()).show();
                return true;
            }

            @Override public boolean onJsPrompt(WebView view, String url, String text, String initial, JsPromptResult result) {
                if (!ServerPolicy.inApp(server, url)) { result.cancel(); return true; }
                EditText input = new EditText(MainActivity.this);
                input.setText(initial);
                input.setSelectAllOnFocus(true);
                new AlertDialog.Builder(MainActivity.this).setMessage(text).setView(input)
                        .setPositiveButton("保存", (dialog, which) -> result.confirm(input.getText().toString()))
                        .setNegativeButton("取消", (dialog, which) -> result.cancel())
                        .setOnCancelListener(dialog -> result.cancel()).show();
                return true;
            }

            @Override public void onProgressChanged(WebView view, int value) {
                if (progress != null) {
                    progress.setProgress(value);
                    progress.setVisibility(value == 100 ? View.GONE : View.VISIBLE);
                }
            }

            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                cancelFilePicker();
                if (!trustedPage()) { callback.onReceiveValue(null); return true; }
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                ArrayList<String> accepted = new ArrayList<>();
                for (String type : params.getAcceptTypes()) if (type.matches("[\\w.+-]+/[\\w.+*-]+")) accepted.add(type);
                if (!accepted.isEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, accepted.toArray(new String[0]));
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(intent, PICK_FILES); }
                catch (ActivityNotFoundException error) { cancelFilePicker(); message("未找到系统文件选择器。"); }
                return true;
            }

            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    denyMicrophone();
                    if (!trustedPage() || !ServerPolicy.sameOrigin(server, request.getOrigin().toString())
                            || !Arrays.equals(request.getResources(), new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE})) {
                        request.deny();
                        return;
                    }
                    microphoneRequest = request;
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) grantMicrophone();
                    else requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MICROPHONE);
                });
            }

            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (microphoneRequest == request) microphoneRequest = null;
            }

            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, Message result) {
                if (!gesture || !trustedPage()) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.getSettings().setJavaScriptEnabled(false);
                popup.getSettings().setAllowFileAccess(false);
                popup.getSettings().setAllowContentAccess(false);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView child, WebResourceRequest request) {
                        openExternal(request.getUrl().toString());
                        child.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) result.obj).setWebView(popup);
                result.sendToTarget();
                return true;
            }
        });
        web.setDownloadListener((url, agent, disposition, mime, size) -> {
            if (!trustedPage() || !ServerPolicy.inApp(server, url)) { message("仅支持下载当前服务内的文件。"); return; }
            if (downloadUrl != null) { message("请先完成当前保存位置的选择。"); return; }
            downloadUrl = url;
            downloadMime = mime;
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(mime == null || mime.isBlank() ? "application/octet-stream" : mime);
            String filename = URLUtil.guessFileName(url, disposition, mime).replaceAll("[\\\\/\\p{Cntrl}]", "_");
            intent.putExtra(Intent.EXTRA_TITLE, filename);
            try { startActivityForResult(intent, SAVE_FILE); }
            catch (ActivityNotFoundException error) { downloadUrl = null; message("未找到系统文件保存器。"); }
        });
        root.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        root.addView(progress, new FrameLayout.LayoutParams(-1, dp(3), Gravity.TOP));
    }

    private boolean trustedPage() { return web != null && ServerPolicy.inApp(server, web.getUrl()); }

    private void showSettings() {
        new AlertDialog.Builder(this).setTitle("安卓连接设置")
                .setMessage("当前服务：\n" + server + "\n\n切换服务会清除本 App 的本地登录和缓存。服务器上的任务、文件和已保存草稿不受影响。请先等待草稿保存完成。")
                .setPositiveButton("更改服务地址", (dialog, which) -> showConnection(null))
                .setNeutralButton("在浏览器打开", (dialog, which) -> openExternal(server))
                .setNegativeButton("取消", null).show();
    }

    private void showConnection(String error) {
        if (isFinishing() || isDestroyed()) return;
        if (connectionScreen != null) root.removeView(connectionScreen);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        android.util.TypedValue background = new android.util.TypedValue();
        getTheme().resolveAttribute(android.R.attr.colorBackground, background, true);
        scroll.setBackgroundColor(background.data);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER_VERTICAL);
        content.setPadding(dp(28), dp(32), dp(28), dp(32));
        TextView title = new TextView(this);
        title.setText(R.string.app_name);
        title.setTextSize(32);
        content.addView(title);
        TextView description = new TextView(this);
        description.setText(error == null ? "连接你的工作台\n\n输入现有 Codex Web 的 HTTPS 地址。聊天、文件和任务继续保存在你的服务器，不会上传到其他服务。" : error);
        description.setTextSize(16);
        description.setPadding(0, dp(20), 0, dp(24));
        content.addView(description);
        EditText address = new EditText(this);
        address.setSingleLine(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("https://example.org/codex-web/");
        address.setText(server);
        address.setContentDescription("Codex Web HTTPS 服务地址");
        content.addView(address, new LinearLayout.LayoutParams(-1, dp(60)));
        Button connect = new Button(this);
        connect.setText(server.isEmpty() ? "连接工作台" : "重新连接");
        connect.setOnClickListener(view -> {
            try {
                String destination = ServerPolicy.normalize(address.getText().toString());
                if (!server.isEmpty() && !destination.equals(server)) {
                    new AlertDialog.Builder(this).setTitle("切换服务器？")
                            .setMessage("将清除当前登录状态和本地缓存。未保存的输入可能丢失；服务端已保存的数据不会删除。")
                            .setPositiveButton("切换", (dialog, which) -> { connect.setEnabled(false); connect(destination, true); })
                            .setNegativeButton("取消", null).show();
                } else { connect.setEnabled(false); connect(destination, false); }
            } catch (IllegalArgumentException invalid) { address.setError(invalid.getMessage()); }
        });
        content.addView(connect, new LinearLayout.LayoutParams(-1, dp(56)));
        if (web != null) {
            Button cancel = new Button(this);
            cancel.setText("返回当前页面");
            cancel.setOnClickListener(view -> { root.removeView(connectionScreen); connectionScreen = null; });
            content.addView(cancel);
        }
        TextView note = new TextView(this);
        note.setText("独立社区客户端 · 非 OpenAI 官方应用\n需要联网；不提供离线执行或后台录音。");
        note.setTextSize(12);
        note.setPadding(0, dp(24), 0, 0);
        content.addView(note);
        scroll.addView(content);
        connectionScreen = scroll;
        root.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
    }

    private void connect(String destination, boolean clearSession) {
        Runnable load = () -> {
            server = destination;
            getPreferences(MODE_PRIVATE).edit().putString("server", server).apply();
            createWebView();
            if (connectionScreen != null) root.removeView(connectionScreen);
            connectionScreen = null;
            web.loadUrl(server);
        };
        if (!clearSession) { load.run(); return; }
        denyMicrophone();
        cancelFilePicker();
        if (web != null) {
            web.stopLoading();
            web.clearCache(true);
            root.removeView(web);
            web.destroy();
            web = null;
            root.removeView(progress);
        }
        WebStorage.getInstance().deleteAllData();
        CookieManager.getInstance().removeAllCookies(done -> { CookieManager.getInstance().flush(); load.run(); });
    }

    private void openExternal(String url) {
        String scheme = Uri.parse(url).getScheme();
        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)
                && !"mailto".equalsIgnoreCase(scheme) && !"tel".equalsIgnoreCase(scheme)) {
            message("已阻止不支持的外部链接类型。");
            return;
        }
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException error) { message("没有可以打开此链接的应用。"); }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_FILES && fileCallback != null) {
            ArrayList<Uri> uris = new ArrayList<>();
            if (result == RESULT_OK && data != null && trustedPage()) {
                if (data.getClipData() != null) {
                    for (int index = 0; index < Math.min(12, data.getClipData().getItemCount()); index++) uris.add(data.getClipData().getItemAt(index).getUri());
                } else if (data.getData() != null) uris.add(data.getData());
            }
            uris.removeIf(uri -> !"content".equals(uri.getScheme()));
            fileCallback.onReceiveValue(uris.isEmpty() ? null : uris.toArray(new Uri[0]));
            fileCallback = null;
        }
        if (request == SAVE_FILE) {
            String url = downloadUrl;
            String mime = downloadMime;
            downloadUrl = null;
            downloadMime = null;
            if (result == RESULT_OK && data != null && data.getData() != null && url != null && ServerPolicy.inApp(server, url)) saveDownload(url, mime, data.getData());
        }
    }

    private void saveDownload(String url, String expectedMime, Uri destination) {
        String sourceServer = server;
        String cookie = CookieManager.getInstance().getCookie(url);
        String userAgent = web == null ? "CodexWebAndroid/0.1.0" : web.getSettings().getUserAgentString();
        message("开始下载，完成后将显示提示。");
        downloads.execute(() -> {
            HttpURLConnection connection = null;
            try {
                URI current = new URI(url);
                for (int redirects = 0; redirects <= 5; redirects++) {
                    if (!ServerPolicy.inApp(sourceServer, current.toString())) throw new IllegalStateException("已阻止跨服务下载跳转。");
                    connection = (HttpURLConnection) current.toURL().openConnection();
                    connection.setInstanceFollowRedirects(false);
                    connection.setConnectTimeout(20000);
                    connection.setReadTimeout(60000);
                    if (cookie != null) connection.setRequestProperty("Cookie", cookie);
                    connection.setRequestProperty("User-Agent", userAgent);
                    int status = connection.getResponseCode();
                    if (status >= 300 && status < 400) {
                        String location = connection.getHeaderField("Location");
                        if (location == null || redirects == 5) throw new IllegalStateException("下载重定向无效或次数过多。");
                        current = current.resolve(location);
                        connection.disconnect();
                        connection = null;
                        continue;
                    }
                    if (status != 200) throw new IllegalStateException("下载失败，HTTP " + status);
                    String actualMime = connection.getContentType();
                    if (actualMime != null && actualMime.startsWith("text/html") && expectedMime != null && !expectedMime.startsWith("text/html")) throw new IllegalStateException("服务器返回了网页而非文件，请检查登录状态。");
                    try (InputStream input = connection.getInputStream(); OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
                        if (output == null) throw new IllegalStateException("无法写入所选位置。");
                        byte[] buffer = new byte[65536];
                        int count;
                        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                    }
                    runOnUiThread(() -> message("下载完成，文件已保存到所选位置。"));
                    return;
                }
            } catch (Exception error) {
                runOnUiThread(() -> message("下载未完成，保存位置可能存在不完整文件。请重新下载。"));
            } finally { if (connection != null) connection.disconnect(); }
        });
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == MICROPHONE) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) grantMicrophone();
            else { denyMicrophone(); message("麦克风权限未开启，仍可使用文字和附件。"); }
        }
    }

    private void grantMicrophone() {
        PermissionRequest request = microphoneRequest;
        microphoneRequest = null;
        if (request == null) return;
        if (trustedPage() && ServerPolicy.sameOrigin(server, request.getOrigin().toString())) request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        else request.deny();
    }

    private void denyMicrophone() {
        if (microphoneRequest != null) { microphoneRequest.deny(); microphoneRequest = null; }
    }

    private void cancelFilePicker() {
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
    }

    @SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() { handleBack(); }

    private void handleBack() {
        if (connectionScreen != null) {
            if (web == null) { moveTaskToBack(true); return; }
            root.removeView(connectionScreen);
            connectionScreen = null;
            return;
        }
        if (web == null) { moveTaskToBack(true); return; }
        web.evaluateJavascript("Boolean(window.codexMobileBack && window.codexMobileBack())", result -> {
            if ("true".equals(result) || web == null) return;
            if (web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
        });
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString("downloadUrl", downloadUrl);
        state.putString("downloadMime", downloadMime);
    }

    @Override protected void onPause() {
        if (web != null) { web.evaluateJavascript("window.dispatchEvent(new Event('codex-native-pause'))", null); web.onPause(); }
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }

    @Override protected void onDestroy() {
        denyMicrophone();
        cancelFilePicker();
        if (web != null) { root.removeView(web); web.destroy(); web = null; }
        downloads.shutdown();
        super.onDestroy();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private void message(String text) { Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
}
