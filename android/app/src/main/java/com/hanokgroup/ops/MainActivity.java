package com.hanokgroup.ops;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.InputStream;
import java.util.ArrayList;

import org.json.JSONObject;

public class MainActivity extends Activity {
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private static final int FILE_REQUEST = 1001;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1002;
    private static final int VOICE_REQUEST = 1003;
    private static final String LOCAL_HOST = "hanokops.local";
    private static final String CHANNEL_ID = "hanok_ops_alerts";
    private String pendingSharedText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createNotificationChannel();
        requestNotificationPermission();
        captureShareIntent(getIntent());

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF071A29);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);

        webView.addJavascriptInterface(new AppBridge(), "AndroidApp");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                deliverPendingShare();
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (LOCAL_HOST.equals(uri.getHost())) {
                    String path = uri.getPath();
                    if (path == null || path.equals("/") || path.equals("/index.html")) path = "/index.html";
                    if (path.startsWith("/")) path = path.substring(1);
                    try {
                        InputStream stream = getAssets().open(path);
                        String ext = MimeTypeMap.getFileExtensionFromUrl(path);
                        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                        if (mime == null) mime = path.endsWith(".html") ? "text/html" : "application/octet-stream";
                        return new WebResourceResponse(mime, "UTF-8", stream);
                    } catch (Exception ignored) {}
                }
                return super.shouldInterceptRequest(view, request);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(intent, FILE_REQUEST);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        if (savedInstanceState == null) webView.loadUrl("https://" + LOCAL_HOST + "/index.html");
        else webView.restoreState(savedInstanceState);
    }

    private void captureShareIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String type = intent.getType();
        if (type == null || !"text/plain".equals(type)) return;

        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        CharSequence extra = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String text = extra == null ? "" : extra.toString().trim();
        if (subject != null && !subject.trim().isEmpty() && !text.startsWith(subject.trim())) {
            text = subject.trim() + "\n" + text;
        }
        if (!text.trim().isEmpty()) pendingSharedText = text.trim();
    }

    private void deliverPendingShare() {
        if (pendingSharedText == null || pendingSharedText.isEmpty() || webView == null) return;
        String quoted = JSONObject.quote(pendingSharedText);
        pendingSharedText = null;
        webView.evaluateJavascript("window.receiveSharedText && receiveSharedText(" + quoted + ")", null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureShareIntent(intent);
        deliverPendingShare();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Hanok Ops Alerts",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Urgent tickets, follow-ups, overdue items and store requests");
            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.createNotificationChannel(channel);
        }
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
        }
    }

    private void saveNativeSession(String accessToken, String refreshToken) {
        if (accessToken == null || refreshToken == null || refreshToken.isEmpty()) return;
        getSharedPreferences(NotificationPollJob.PREFS, MODE_PRIVATE)
                .edit()
                .putString("access_token", accessToken)
                .putString("refresh_token", refreshToken)
                .apply();
        scheduleNotificationJob();
    }

    private void clearNativeSession() {
        getSharedPreferences(NotificationPollJob.PREFS, MODE_PRIVATE)
                .edit()
                .remove("access_token")
                .remove("refresh_token")
                .apply();
        JobScheduler scheduler = (JobScheduler) getSystemService(JOB_SCHEDULER_SERVICE);
        if (scheduler != null) scheduler.cancel(NotificationPollJob.JOB_ID);
    }

    private void scheduleNotificationJob() {
        JobScheduler scheduler = (JobScheduler) getSystemService(JOB_SCHEDULER_SERVICE);
        if (scheduler == null) return;
        JobInfo info = new JobInfo.Builder(
                NotificationPollJob.JOB_ID,
                new ComponentName(this, NotificationPollJob.class)
        )
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60 * 1000L)
                .setPersisted(true)
                .build();
        scheduler.schedule(info);
    }

    private String storedNativeSession() {
        String access = getSharedPreferences(NotificationPollJob.PREFS, MODE_PRIVATE)
                .getString("access_token", "");
        String refresh = getSharedPreferences(NotificationPollJob.PREFS, MODE_PRIVATE)
                .getString("refresh_token", "");
        try {
            JSONObject out = new JSONObject();
            out.put("access_token", access);
            out.put("refresh_token", refresh);
            return out.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    private void startVoiceRecognition() {
        try {
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "Quick capture");
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
            startActivityForResult(intent, VOICE_REQUEST);
        } catch (Exception e) {
            runOnUiThread(() -> webView.evaluateJavascript(
                    "window.toast && toast('Voice input is unavailable on this device')", null));
        }
    }

    private void showNotification(String title, String body) {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        builder.setSmallIcon(com.hanokgroup.ops.R.drawable.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true);
        manager.notify((int) (System.currentTimeMillis() & 0x0fffffff), builder.build());
    }

    public class AppBridge {
        @JavascriptInterface
        public void notify(String title, String body) {
            runOnUiThread(() -> showNotification(title, body));
        }

        @JavascriptInterface
        public void startVoiceCapture() {
            runOnUiThread(() -> startVoiceRecognition());
        }

        @JavascriptInterface
        public void saveSession(String accessToken, String refreshToken) {
            runOnUiThread(() -> saveNativeSession(accessToken, refreshToken));
        }

        @JavascriptInterface
        public void clearSession() {
            runOnUiThread(() -> clearNativeSession());
        }

        @JavascriptInterface
        public String getStoredSession() {
            return storedNativeSession();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == VOICE_REQUEST) {
            if (resultCode == RESULT_OK && data != null) {
                ArrayList<String> results = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
                if (results != null && !results.isEmpty()) {
                    String spoken = results.get(0);
                    String safe = spoken.replace("\\", "\\\\")
                            .replace("'", "\\'")
                            .replace("\n", "\\n")
                            .replace("\r", "");
                    webView.evaluateJavascript("window.receiveVoiceCapture && receiveVoiceCapture('" + safe + "')", null);
                }
            }
            return;
        }

        if (requestCode != FILE_REQUEST || fileCallback == null) return;
        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                results = new Uri[n];
                for (int i = 0; i < n; i++) results[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(results);
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
