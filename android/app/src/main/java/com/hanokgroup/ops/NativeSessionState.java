package com.hanokgroup.ops;

import android.content.SharedPreferences;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Local concurrency bookkeeping only. JWTs and role access remain server-validated. */
final class NativeSessionState {
    static boolean knownRole(String role) {
        return "admin".equals(role) || "hq".equals(role) || "partner".equals(role) || "store".equals(role);
    }

    static String owner(String accessToken) {
        try {
            String[] parts = accessToken.split("\\.");
            if (parts.length != 3) return "";
            JSONObject claims = new JSONObject(new String(Base64.decode(parts[1],
                    Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP), StandardCharsets.UTF_8));
            String subject = claims.optString("sub", "");
            return subject.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}") ? subject : "";
        } catch (Exception ignored) { return ""; }
    }

    // Every caller holds NotificationDelivery.class, including worker refresh and logout.
    static boolean save(SharedPreferences prefs, String access, String refresh, String role,
            String expectedRefresh, boolean compareAndSet) {
        if (access == null || refresh == null || refresh.isEmpty()) return false;
        String nextOwner = owner(access);
        if (nextOwner.isEmpty() || (role != null && !knownRole(role))) return false;
        String currentRefresh = prefs.getString("refresh_token", "");
        String currentOwner = owner(prefs.getString("access_token", ""));
        if (compareAndSet && (expectedRefresh == null || expectedRefresh.isEmpty()
                || !expectedRefresh.equals(currentRefresh) || !nextOwner.equals(currentOwner))) return false;
        SharedPreferences.Editor edit = prefs.edit();
        if (!nextOwner.equals(currentOwner)) {
            edit.remove(NotificationDelivery.ACKS).remove("notified_ids")
                    .remove("last_poll_at").remove("last_poll_result")
                    .remove("last_posted_at").remove("last_delivery_result");
        }
        edit.putString("access_token", access).putString("refresh_token", refresh)
                .putString("session_owner", nextOwner)
                .putString("session_role", role != null ? role : nextOwner.equals(currentOwner)
                        ? prefs.getString("session_role", "") : "").apply();
        return true;
    }

    static boolean clear(SharedPreferences prefs, String expectedRefresh, boolean compareAndSet) {
        if (compareAndSet && (expectedRefresh == null || expectedRefresh.isEmpty()
                || !expectedRefresh.equals(prefs.getString("refresh_token", "")))) return false;
        prefs.edit().remove("access_token").remove("refresh_token").remove("session_owner")
                .remove("session_role").remove("notified_ids").remove(NotificationDelivery.ACKS)
                .remove("last_poll_at").remove("last_poll_result").remove("last_posted_at")
                .remove("last_delivery_result").putString("schedule_result", "signed_out").apply();
        return true;
    }
}
