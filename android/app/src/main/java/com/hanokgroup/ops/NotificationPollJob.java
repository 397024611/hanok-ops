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
    public static volatile boolean foreground = false;
    public static final String PREFS = "hanok_ops_native";

    private static final String SB_URL = "https://tqfwbsjchespjkxliodo.supabase.co";
    private static final String SB_KEY = "sb_publishable_gzlaNquJPCOsgVMb1ZhRdw_X38GSi6s";
    private static final String CHANNEL_ID = "hanok_ops_alerts";

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            try {
                pollNotifications();
            } catch (Exception ignored) {
                recordPoll("unexpected_error");
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

    private void recordPoll(String result) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("last_poll_result", result).apply();
    }

    private void pollNotifications() throws Exception {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        prefs.edit().putLong("last_poll_at", System.currentTimeMillis()).apply();
        if (foreground) { recordPoll("foreground_skipped"); return; }
        String blocked = NotificationDelivery.blockedReason(this);
        if (!blocked.isEmpty()) { recordPoll(blocked); return; }
        String refreshToken = prefs.getString("refresh_token", null);
        if (refreshToken == null || refreshToken.isEmpty()) { recordPoll("no_session"); return; }

        JSONObject refreshed = refreshSession(refreshToken);
        if (refreshed == null) return;

        String accessToken = refreshed.optString("access_token", "");
        String newRefreshToken = refreshed.optString("refresh_token", refreshToken);
        if (accessToken.isEmpty()) { recordPoll("invalid_refresh_response"); return; }

        // Logout, foreground refresh, or another account may have changed the session.
        synchronized (NotificationDelivery.class) {
        if (!refreshToken.equals(prefs.getString("refresh_token", null))) { recordPoll("session_changed"); return; }
        prefs.edit()
                .putString("access_token", accessToken)
                .putString("refresh_token", newRefreshToken)
                .apply();
        }

        JSONArray notifications = getUnreadNotifications(accessToken);
        if (notifications == null) return;
        if (!newRefreshToken.equals(prefs.getString("refresh_token", null))) { recordPoll("session_changed"); return; }

        synchronized (NotificationDelivery.class) {
            if (foreground || !newRefreshToken.equals(prefs.getString("refresh_token", null))) {
                recordPoll("session_or_foreground_changed"); return;
            }
            boolean allPosted = NotificationDelivery.postBatchForSession(this, newRefreshToken, notifications);
            recordPoll(notifications.length() == 0 ? "no_unread_alerts" : allPosted ? "completed" : "delivery_blocked");
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

            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) { recordPoll("refresh_http_" + status); return null; }
            return new JSONObject(readAll(conn.getInputStream()));
        } catch (Exception e) {
            recordPoll("refresh_network_or_parse_error");
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

            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) { recordPoll("notifications_http_" + status); return null; }
            return new JSONArray(readAll(conn.getInputStream()));
        } catch (Exception e) {
            recordPoll("notifications_network_or_parse_error");
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

}
