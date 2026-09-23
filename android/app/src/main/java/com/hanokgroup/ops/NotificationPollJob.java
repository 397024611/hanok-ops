package com.hanokgroup.ops;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

public class NotificationPollJob extends JobService {
    public static final int JOB_ID = 42001;
    public static final String PREFS = "hanok_ops_native";

    private static final String SB_URL = "https://lludyxgivnmmkovhhrgg.supabase.co";
    private static final String SB_KEY = "sb_publishable_YCeXPfqOdVS84ZRis-miEg_v7W0s3Dg";
    private static final String CHANNEL_ID = "hanok_ops_alerts";

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            try {
                pollNotifications();
            } catch (Exception ignored) {
            } finally {
                jobFinished(params, false);
            }
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }

    private void pollNotifications() throws Exception {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String refreshToken = prefs.getString("refresh_token", null);
        if (refreshToken == null || refreshToken.isEmpty()) return;

        JSONObject refreshed = refreshSession(refreshToken);
        if (refreshed == null) return;

        String accessToken = refreshed.optString("access_token", "");
        String newRefreshToken = refreshed.optString("refresh_token", refreshToken);
        if (accessToken.isEmpty()) return;

        prefs.edit()
                .putString("access_token", accessToken)
                .putString("refresh_token", newRefreshToken)
                .apply();

        JSONArray notifications = getUnreadNotifications(accessToken);
        if (notifications == null) return;

        Set<String> seen = new HashSet<>(prefs.getStringSet("notified_ids", Collections.emptySet()));
        boolean changed = false;

        for (int i = notifications.length() - 1; i >= 0; i--) {
            JSONObject n = notifications.optJSONObject(i);
            if (n == null) continue;
            String id = n.optString("id", "");
            if (id.isEmpty() || seen.contains(id)) continue;

            showNotification(
                    n.optString("title", "报告老板"),
                    n.optString("body", "New operations alert"),
                    n.optString("ticket_id", "")
            );
            seen.add(id);
            changed = true;
        }

        if (changed) {
            if (seen.size() > 300) {
                Set<String> recent = new HashSet<>();
                for (int i = 0; i < notifications.length(); i++) {
                    JSONObject n = notifications.optJSONObject(i);
                    if (n != null) {
                        String id = n.optString("id", "");
                        if (!id.isEmpty()) recent.add(id);
                    }
                }
                seen = recent;
            }
            prefs.edit().putStringSet("notified_ids", seen).apply();
        }
    }

    private JSONObject refreshSession(String refreshToken) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(SB_URL + "/auth/v1/token?grant_type=refresh_token");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setDoOutput(true);
            conn.setRequestProperty("apikey", SB_KEY);
            conn.setRequestProperty("Content-Type", "application/json");

            JSONObject body = new JSONObject();
            body.put("refresh_token", refreshToken);
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
            }

            if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300) return null;
            return new JSONObject(readAll(conn.getInputStream()));
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private JSONArray getUnreadNotifications(String accessToken) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(SB_URL + "/rest/v1/ops_notifications?select=id,ticket_id,title,body,priority,created_at&read_at=is.null&order=created_at.desc&limit=30");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("apikey", SB_KEY);
            conn.setRequestProperty("Authorization", "Bearer " + accessToken);

            if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300) return null;
            return new JSONArray(readAll(conn.getInputStream()));
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private String readAll(InputStream stream) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
        }
        return sb.toString();
    }

    private void showNotification(String title, String body, String ticketId) {
        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "报告老板 Alerts",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Urgent tickets, follow-ups, overdue items and store requests");
            manager.createNotificationChannel(channel);
        }

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        Intent launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (ticketId != null && !ticketId.isEmpty()) launch.putExtra("ticket_id", ticketId);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                ticketId == null ? 0 : ticketId.hashCode(),
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        builder.setSmallIcon(R.drawable.ic_launcher)
                .setContentIntent(pendingIntent)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true);

        manager.notify((int) (System.currentTimeMillis() & 0x0fffffff), builder.build());
    }
}
