package com.hanokgroup.ops;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.util.Log;
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
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.ArrayList;

import org.json.JSONArray;
import org.json.JSONObject;

// Permanent release signing pipeline.
public class MainActivity extends Activity {
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private static final int FILE_REQUEST = 1001;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1002;
    private static final int VOICE_REQUEST = 1003;
    private static final String LOCAL_HOST = "hanokops.local";
    private static final String CHANNEL_ID = "hanok_ops_alerts";
    private String pendingSharedText;
    private String pendingTicketId;
    private boolean pendingNotificationInbox;
    private final Object pendingRouteLock = new Object();
    private int ticketRouteGeneration, shareRouteGeneration;
    private int ticketDeliveryGeneration = -1, shareDeliveryGeneration = -1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createNotificationChannel();
        requestNotificationPermission();
        captureShareIntent(getIntent());
        captureTicketIntent(getIntent());

        webView = new WebView(this);
        webView.setBackgroundColor(0xFFF5F6F8);
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
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(true);

        webView.addJavascriptInterface(new AppBridge(), "AndroidApp");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equalsIgnoreCase(uri.getScheme()) && LOCAL_HOST.equals(uri.getHost())) return false;
                // External pages must never inherit the app's privileged AndroidApp bridge.
                if (request.isForMainFrame() && "https".equalsIgnoreCase(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) {}
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (LOCAL_HOST.equals(Uri.parse(url).getHost())) {
                    deliverPendingShare();
                    deliverPendingTicket();
                }
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (request.isForMainFrame() && !("https".equalsIgnoreCase(uri.getScheme()) && LOCAL_HOST.equals(uri.getHost()))) {
                    return blockedDocument(403, "External navigation blocked");
                }
                if ("https".equalsIgnoreCase(uri.getScheme()) && LOCAL_HOST.equals(uri.getHost())) {
                    String path = uri.getPath();
                    if (path == null || path.equals("/") || path.equals("/index.html")) path = "/index.html";
                    if (path.startsWith("/")) path = path.substring(1);
                    try {
                        InputStream stream = getAssets().open(path);
                        String ext = MimeTypeMap.getFileExtensionFromUrl(path);
                        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                        if (mime == null) mime = path.endsWith(".html") ? "text/html" : "application/octet-stream";
                        return new WebResourceResponse(mime, "UTF-8", stream);
                    } catch (Exception ignored) { return blockedDocument(404, "Local resource not found"); }
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
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);
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

    private WebResourceResponse blockedDocument(int status, String message) {
        return new WebResourceResponse("text/plain", "UTF-8", status, message,
                Collections.emptyMap(), new ByteArrayInputStream(message.getBytes(StandardCharsets.UTF_8)));
    }

    private void captureTicketIntent(Intent intent) {
        if (intent == null) return;
        synchronized (pendingRouteLock) {
        if (intent.getBooleanExtra("notification_inbox", false)) {
            ticketRouteGeneration++;
            pendingNotificationInbox = true;
            pendingTicketId = null;
            return;
        }
        String ticketId = intent.getStringExtra("ticket_id");
        if (ticketId != null && !ticketId.trim().isEmpty()) {
            ticketRouteGeneration++;
            pendingTicketId = ticketId.trim();
            pendingNotificationInbox = false;
        }
        }
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
        if (!text.trim().isEmpty()) {
            synchronized (pendingRouteLock) { shareRouteGeneration++; pendingSharedText = text.trim(); }
        }
    }

    private void deliverPendingTicket() {
        if (webView == null) return;
        final String ticket;
        final boolean inbox;
        final int generation;
        synchronized (pendingRouteLock) {
            ticket = pendingTicketId;
            inbox = pendingNotificationInbox;
            generation = ticketRouteGeneration;
            if ((!inbox && (ticket == null || ticket.isEmpty())) || ticketDeliveryGeneration == generation) return;
            ticketDeliveryGeneration = generation;
        }
        String invocation = inbox ? "receiveNotificationInbox()" : "receiveNotificationTicket(" + JSONObject.quote(ticket) + ")";
        String handler = inbox ? "receiveNotificationInbox" : "receiveNotificationTicket";
        webView.evaluateJavascript("(function(){if(!AndroidApp.isPendingRouteCurrent(\"ticket\"," + generation + "))return false;if(typeof window." + handler + "!==\"function\")return false;" + invocation + ";return true})()", result -> {
            synchronized (pendingRouteLock) {
                if (ticketDeliveryGeneration == generation) ticketDeliveryGeneration = -1;
                if (!"true".equals(result) || generation != ticketRouteGeneration) return;
                if (inbox) pendingNotificationInbox = false;
                else if (ticket.equals(pendingTicketId)) pendingTicketId = null;
            }
        });
    }

    private void deliverPendingShare() {
        if (webView == null) return;
        final String text;
        final int generation;
        synchronized (pendingRouteLock) {
            text = pendingSharedText;
            generation = shareRouteGeneration;
            if (text == null || text.isEmpty() || shareDeliveryGeneration == generation) return;
            shareDeliveryGeneration = generation;
        }
        webView.evaluateJavascript("(function(){if(!AndroidApp.isPendingRouteCurrent(\"share\"," + generation + "))return false;if(typeof window.receiveSharedText!==\"function\")return false;receiveSharedText(" + JSONObject.quote(text) + ");return true})()", result -> {
            synchronized (pendingRouteLock) {
                if (shareDeliveryGeneration == generation) shareDeliveryGeneration = -1;
                if ("true".equals(result) && generation == shareRouteGeneration && text.equals(pendingSharedText)) pendingSharedText = null;
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureShareIntent(intent);
        captureTicketIntent(intent);
        deliverPendingShare();
        deliverPendingTicket();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "报告老板提醒",
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

    private boolean saveNativeSession(String accessToken, String refreshToken, String role,
            String expectedRefreshToken, boolean compareAndSet) {
        synchronized (NotificationDelivery.class) {
            android.content.SharedPreferences prefs = getSharedPreferences(NotificationPollJob.PREFS, MODE_PRIVATE);
            String oldOwner = NativeSessionState.owner(prefs.getString("access_token", ""));
            String oldRole = prefs.getString("session_role", "");
            boolean saved = NativeSessionState.save(prefs,
                    accessToken, refreshToken, role, expectedRefreshToken, compareAndSet);
            if (saved) {
                if (!oldOwner.equals(NativeSessionState.owner(accessToken))
                        || (role != null && !oldRole.isEmpty() && !oldRole.equals(role))) {
                    NotificationDelivery.cancelPosted(this);
                }
                scheduleNotificationJob();
            }
            return saved;
        }
    }

    private boolean clearNativeSession(String expectedRefreshToken, boolean compareAndSet) {
        synchronized (NotificationDelivery.class) {
            if (!NativeSessionState.clear(getSharedPreferences(NotificationPollJob.PREFS, MODE_PRIVATE),
                    expectedRefreshToken, compareAndSet)) return false;
            NotificationDelivery.cancelPosted(this);
            JobScheduler scheduler = (JobScheduler) getSystemService(JOB_SCHEDULER_SERVICE);
            if (scheduler != null) scheduler.cancel(NotificationPollJob.JOB_ID);
            synchronized (pendingRouteLock) {
                ticketRouteGeneration++;
                shareRouteGeneration++;
                ticketDeliveryGeneration = -1;
                shareDeliveryGeneration = -1;
                pendingTicketId = null;
                pendingNotificationInbox = false;
                pendingSharedText = null;
            }
            return true;
        }
    }

    private void scheduleNotificationJob() {
        // Background reminders must never make a successful login crash.
        try {
            JobScheduler scheduler = (JobScheduler) getSystemService(JOB_SCHEDULER_SERVICE);
            if (scheduler == null) return;
            // Refreshing credentials must not continually reset the periodic job's deadline.
            if (scheduler.getPendingJob(NotificationPollJob.JOB_ID) != null) return;
            JobInfo info = new JobInfo.Builder(
                    NotificationPollJob.JOB_ID,
                    new ComponentName(this, NotificationPollJob.class)
            )
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(15 * 60 * 1000L)
                    .setPersisted(true)
                    .build();
            int result = scheduler.schedule(info);
            getSharedPreferences(NotificationPollJob.PREFS, MODE_PRIVATE).edit()
                    .putString("schedule_result", result == JobScheduler.RESULT_SUCCESS ? "scheduled" : "rejected").apply();
            if (result != JobScheduler.RESULT_SUCCESS) {
                Log.w("ReportBoss", "Background notification scheduling was rejected");
            }
        } catch (RuntimeException e) {
            getSharedPreferences(NotificationPollJob.PREFS, MODE_PRIVATE).edit().putString("schedule_result", "unavailable").apply();
            Log.w("ReportBoss", "Background notification scheduling is unavailable", e);
        }
    }

    private String storedNativeSession() {
        String access, refresh, role;
        synchronized (NotificationDelivery.class) {
            access = getSharedPreferences(NotificationPollJob.PREFS, MODE_PRIVATE).getString("access_token", "");
            refresh = getSharedPreferences(NotificationPollJob.PREFS, MODE_PRIVATE).getString("refresh_token", "");
            role = getSharedPreferences(NotificationPollJob.PREFS, MODE_PRIVATE).getString("session_role", "");
        }
        try {
            JSONObject out = new JSONObject();
            out.put("access_token", access);
            out.put("refresh_token", refresh);
            out.put("role", role);
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

    private String notificationStatus() {
        try {
            android.content.SharedPreferences prefs = getSharedPreferences(NotificationPollJob.PREFS, MODE_PRIVATE);
            JSONObject out = new JSONObject();
            String blocked = NotificationDelivery.blockedReason(this);
            out.put("delivery", blocked.isEmpty() ? "enabled" : blocked);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (Build.VERSION.SDK_INT >= 26 && manager != null) {
                NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
                out.put("channelImportance", channel == null ? -1 : channel.getImportance());
                out.put("channelSound", channel != null && channel.getSound() != null);
            }
            JobScheduler scheduler = getSystemService(JobScheduler.class);
            out.put("jobScheduled", scheduler != null && scheduler.getPendingJob(NotificationPollJob.JOB_ID) != null);
            out.put("sessionAvailable", !prefs.getString("refresh_token", "").isEmpty());
            out.put("sessionRole", prefs.getString("session_role", ""));
            android.os.PowerManager power = getSystemService(android.os.PowerManager.class);
            if (power != null) {
                out.put("batterySaver", power.isPowerSaveMode());
                out.put("deviceIdle", power.isDeviceIdleMode());
                out.put("batteryOptimizationExempt", power.isIgnoringBatteryOptimizations(getPackageName()));
            }
            if (Build.VERSION.SDK_INT >= 28) {
                android.app.ActivityManager activity = getSystemService(android.app.ActivityManager.class);
                out.put("backgroundRestricted", activity != null && activity.isBackgroundRestricted());
                android.app.usage.UsageStatsManager usage = getSystemService(android.app.usage.UsageStatsManager.class);
                if (usage != null) out.put("standbyBucket", usage.getAppStandbyBucket());
            }
            out.put("scheduleResult", prefs.getString("schedule_result", "unknown"));
            out.put("lastPollAt", prefs.getLong("last_poll_at", 0));
            out.put("lastPollResult", prefs.getString("last_poll_result", "not_run"));
            out.put("lastDeliveryResult", prefs.getString("last_delivery_result", "not_attempted"));
            out.put("lastPostedAt", prefs.getLong("last_posted_at", 0));
            return out.toString();
        } catch (Exception error) { return "{}"; }
    }

    public class AppBridge {
        @JavascriptInterface
        public boolean isPendingRouteCurrent(String kind, int generation) {
            synchronized (pendingRouteLock) {
                if ("ticket".equals(kind)) return generation == ticketRouteGeneration
                        && (pendingNotificationInbox || (pendingTicketId != null && !pendingTicketId.isEmpty()));
                return "share".equals(kind) && generation == shareRouteGeneration
                        && pendingSharedText != null && !pendingSharedText.isEmpty();
            }
        }

        @JavascriptInterface
        public boolean notifyAlerts(String rowsJson, String expectedRefreshToken) {
            try {
                return NotificationDelivery.postBatchForSession(MainActivity.this, expectedRefreshToken, new JSONArray(rowsJson));
            } catch (Exception error) {
                getSharedPreferences(NotificationPollJob.PREFS, MODE_PRIVATE).edit()
                        .putString("last_delivery_result", "invalid_batch").apply();
                return false;
            }
        }

        @JavascriptInterface
        public boolean notifyAlert(String id, String title, String body, String ticketId) {
            if (id == null || id.isEmpty()) return false;
            return NotificationDelivery.post(MainActivity.this, id, title, body, ticketId);
        }

        @JavascriptInterface
        public String getNotificationStatus() { return notificationStatus(); }

        @JavascriptInterface
        public boolean testNotification() {
            return NotificationDelivery.post(MainActivity.this, null, "报告老板通知测试",
                    "Local notification test. No ticket was created.", "");
        }

        @JavascriptInterface
        public void notify(String title, String body, String ticketId) {
            NotificationDelivery.post(MainActivity.this, null, title, body, ticketId);
        }

        @JavascriptInterface
        public void startVoiceCapture() {
            runOnUiThread(() -> startVoiceRecognition());
        }

        @JavascriptInterface
        public boolean saveRoleSession(String accessToken, String refreshToken, String role) {
            return saveNativeSession(accessToken, refreshToken, role, null, false);
        }

        @JavascriptInterface
        public boolean updateRoleSession(String accessToken, String refreshToken, String role, String expectedRefreshToken) {
            return saveNativeSession(accessToken, refreshToken, role, expectedRefreshToken, true);
        }

        @JavascriptInterface
        public boolean clearSessionIfCurrent(String expectedRefreshToken) {
            return clearNativeSession(expectedRefreshToken, true);
        }

        @JavascriptInterface
        public void saveSession(String accessToken, String refreshToken) {
            saveNativeSession(accessToken, refreshToken, null, null, false);
        }

        @JavascriptInterface
        public void clearSession() {
            clearNativeSession(null, false);
        }

        @JavascriptInterface
        public String getStoredSession() {
            return storedNativeSession();
        }

        @JavascriptInterface
        public String getVersionName() {
            return BuildConfig.VERSION_NAME;
        }

        @JavascriptInterface
        public int getVersionCode() {
            return BuildConfig.VERSION_CODE;
        }

        @JavascriptInterface
        public void openUpdateUrl(String url) {
            if (url == null || url.isEmpty()) return;
            try {
                Uri uri = Uri.parse(url);
                boolean trusted = "https".equalsIgnoreCase(uri.getScheme())
                        && "github.com".equalsIgnoreCase(uri.getHost())
                        && uri.getPath() != null
                        && uri.getPath().startsWith("/397024611/hanok-ops/releases/download/");
                if (!trusted) return;
                Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                startActivity(intent);
            } catch (Exception ignored) {
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        NotificationPollJob.foreground = true;
        if (webView != null) webView.evaluateJavascript("window.hydrateNativeSession && hydrateNativeSession(); window.refreshAll && refreshAll()", null);
    }

    @Override
    protected void onPause() {
        NotificationPollJob.foreground = false;
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        if (webView != null) { webView.removeJavascriptInterface("AndroidApp"); webView.destroy(); webView = null; }
        super.onDestroy();
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
                    webView.evaluateJavascript("window.receiveVoiceCapture && receiveVoiceCapture(" + JSONObject.quote(spoken) + ")", null);
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
        if (webView == null) { super.onBackPressed(); return; }
        webView.evaluateJavascript("window.handleAndroidBack ? handleAndroidBack() : false", handled -> {
            if (!"true".equals(handled)) finish();
        });
    }
}
