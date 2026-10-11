# Android ticket notifications (0.9.2)

The app uses foreground REST polling (about 12 seconds) and a persisted Android JobScheduler background job (about 15 minutes). Android may delay background work for battery, connectivity, standby, Doze or vendor-specific restrictions. This release does not add FCM or guarantee instant background push. Force-stopped apps must be reopened.

## Reliability changes

- Foreground and background delivery use one native submission ledger.
- Denied app permission, blocked channels and native posting errors remain retryable.
- New unread rows from a fetch are combined into one notification submission to avoid flooding the notification tray when an old backlog is first fetched.
- The old ledgers did not prove native submission and are not migrated. Previously unconfirmed unread rows may therefore be submitted once after upgrading; already-read rows are not replayed.
- Worker refresh updates, logout, session snapshots and session-bound delivery share a lock to prevent stale background alerts after account changes.
- Android accepting `NotificationManager.notify()` is a submission acknowledgement, not proof of a displayed banner, audible sound or user attention.

## Diagnose on the phone

Open Profile and choose **Send local test notification**, then check the Android notification tray. The test does not create a ticket or contact the server. A banner may be suppressed by silent channel settings or Do Not Disturb even when the tray entry exists.

**Show notification status** reports only local diagnostic state: app/channel availability, channel importance and sound configuration, scheduled-job presence, whether a refresh session exists, battery/standby restrictions, last poll time/result and last native submission. No access/refresh tokens or ticket text are included in the status output.

- Local test blocked or absent: inspect Android app notifications and the 报告老板提醒 channel. Check the tray as well as banners/sounds.
- Local test works, but the job is absent or has never run: inspect background/battery restrictions and Samsung sleeping/deep-sleeping lists. Keep the app signed in and do not force-stop it.
- `refresh_http_*` or `refresh_network_or_parse_error`: native session refresh failed; these are not proof that the notification channel failed.
- `notifications_http_*` or `notifications_network_or_parse_error`: notification fetch failed.
- `no_unread_alerts`: the server returned no unread notification rows at that poll. An already-read ticket notification will not be replayed.
- `posted_to_android`: Android accepted a native submission. Confirm its actual presentation on the device.

The battery state shown after opening Profile is a current snapshot, not proof of what restricted the device while the app was closed.

## Release verification

Automated checks cover JavaScript behavior, native API compatibility, permission/channel gating, retries, shared deduplication and session changes. CI must pass all client tests, mocked browser suites, isolated account integration, Android debug compilation and full Gradle lint. The signed APK must retain the approved certificate, package `com.hanokgroup.ops`, version `0.9.2` and code `15`.

Physical-device acceptance remains separate: denied→allowed permission; disabled→enabled channel; local test; new unread alerts in foreground and background; locked screen/Doze; logout while a worker is running; and a large unread backlog. Use isolated fixtures or an explicitly authorized test account/ticket rather than creating real operational tickets without permission.
