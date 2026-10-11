package com.hanokgroup.ops;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** One delivery ledger shared by foreground and scheduled polling. Never records blocked alerts. */
final class NotificationDelivery {
    static final String CHANNEL = "hanok_ops_alerts";
    static final String ACKS = "posted_notification_ids_v2";

    static void cancelPosted(Context context) {
        try {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager != null) manager.cancelAll();
        } catch (RuntimeException ignored) {
            // Session transitions must still finish if the system service is unavailable.
        }
    }

    static String blockedReason(Context context) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return "permission_denied";
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return "notification_service_unavailable";
        if (!manager.areNotificationsEnabled()) return "app_notifications_disabled";
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
            if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE)
                return "channel_disabled";
        }
        return "";
    }

    private static boolean sameSession(Context context, String expectedRefreshToken) {
        SharedPreferences prefs = context.getSharedPreferences(NotificationPollJob.PREFS, Context.MODE_PRIVATE);
        if (expectedRefreshToken == null || expectedRefreshToken.isEmpty()
                || !expectedRefreshToken.equals(prefs.getString("refresh_token", ""))) {
            prefs.edit().putString("last_delivery_result", "session_changed").apply();
            return false;
        }
        return true;
    }

    static synchronized boolean postForSession(Context context, String expectedRefreshToken,
            String id, String title, String body, String ticketId) {
        return sameSession(context, expectedRefreshToken) && post(context, id, title, body, ticketId);
    }

    static synchronized boolean postBatchForSession(Context context, String expectedRefreshToken, JSONArray rows) {
        return sameSession(context, expectedRefreshToken) && postBatch(context, rows);
    }

    private static Set<String> postedIds(SharedPreferences prefs) {
        Set<String> posted = new LinkedHashSet<>();
        try {
            JSONArray saved = new JSONArray(prefs.getString(ACKS, "[]"));
            for (int i = 0; i < saved.length(); i++) {
                String id = saved.optString(i, "");
                if (!id.isEmpty()) posted.add(id);
            }
        } catch (Exception ignored) { /* A corrupt ledger must not suppress future alerts. */ }
        return posted;
    }

    static synchronized boolean postBatch(Context context, JSONArray rows) {
        SharedPreferences prefs = context.getSharedPreferences(NotificationPollJob.PREFS, Context.MODE_PRIVATE);
        Set<String> posted = postedIds(prefs);
        LinkedHashMap<String, JSONObject> fresh = new LinkedHashMap<>();
        if (rows == null) return false;
        // Both callers fetch newest first. Keep acknowledgment order oldest first for bounded retention.
        for (int i = rows.length() - 1; i >= 0; i--) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null || row.isNull("id") || !row.isNull("read_at")) continue;
            String id = row.optString("id", "");
            if (!id.isEmpty() && !posted.contains(id)) fresh.put(id, row);
        }
        if (fresh.isEmpty()) return true;
        if (fresh.size() == 1) {
            String id = fresh.keySet().iterator().next();
            JSONObject row = fresh.get(id);
            return postNotification(context, id, row.isNull("title") ? "报告老板" : row.optString("title", "报告老板"),
                    row.isNull("body") ? "New operations alert" : row.optString("body", "New operations alert"),
                    row.isNull("ticket_id") ? "" : row.optString("ticket_id", ""),
                    posted, fresh.keySet());
        }
        // One Android post per fetched batch prevents an upgrade backlog from flooding the tray.
        return postNotification(context, "reportboss-inbox-digest", "报告老板 · " + fresh.size() + " new alerts",
                fresh.size() + " new operations alerts. Open Inbox to review them.", "", posted, fresh.keySet());
    }

    static synchronized boolean post(Context context, String id, String title, String body, String ticketId) {
        SharedPreferences prefs = context.getSharedPreferences(NotificationPollJob.PREFS, Context.MODE_PRIVATE);
        Set<String> posted = postedIds(prefs);
        if (id != null && posted.contains(id)) return true;
        return postNotification(context, id == null ? "reportboss-local-test" : id, title, body, ticketId,
                posted, id == null ? Collections.emptySet() : Collections.singleton(id));
    }

    private static boolean postNotification(Context context, String tag, String title, String body,
            String ticketId, Set<String> posted, Collection<String> deliveredIds) {
        SharedPreferences prefs = context.getSharedPreferences(NotificationPollJob.PREFS, Context.MODE_PRIVATE);
        String blocked = blockedReason(context);
        if (!blocked.isEmpty()) { prefs.edit().putString("last_delivery_result", blocked).apply(); return false; }
        try {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel channel = new NotificationChannel(CHANNEL, "报告老板提醒", NotificationManager.IMPORTANCE_HIGH);
                channel.setDescription("Urgent tickets, follow-ups, overdue items and store requests");
                manager.createNotificationChannel(channel);
            }
            Intent launch = new Intent(context, MainActivity.class);
            launch.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            if (ticketId != null && !ticketId.isEmpty()) {
                launch.putExtra("ticket_id", ticketId);
                launch.setAction("com.hanokgroup.ops.NOTIFICATION_TICKET." + ticketId);
            } else {
                launch.putExtra("notification_inbox", true);
                launch.setAction("com.hanokgroup.ops.NOTIFICATION_INBOX");
            }
            PendingIntent pending = PendingIntent.getActivity(context, 0, launch,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(context, CHANNEL) : new Notification.Builder(context);
            builder.setSmallIcon(R.drawable.ic_launcher).setContentIntent(pending).setContentTitle(title)
                    .setContentText(body).setStyle(new Notification.BigTextStyle().bigText(body)).setAutoCancel(true);
            manager.notify(tag, 1, builder.build());
            // A blocked/failed digest acknowledges none of its IDs; the whole batch stays retryable.
            for (String id : deliveredIds) posted.add(id);
            while (posted.size() > 300) posted.remove(posted.iterator().next());
            prefs.edit().putString(ACKS, new JSONArray(posted).toString()).putString("last_delivery_result", "posted_to_android")
                    .putLong("last_posted_at", System.currentTimeMillis()).apply();
            return true;
        } catch (RuntimeException error) {
            prefs.edit().putString("last_delivery_result", "post_failed").apply();
            return false;
        }
    }
}
