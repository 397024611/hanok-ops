# 报告老板 Android Release Signing

The Android application id is `com.hanokgroup.ops`.

All installable production APKs must use the same release signing key. Do not ship debug-signed builds to users.

## GitHub Actions secrets

Configure these repository Actions secrets:

- `ANDROID_KEYSTORE_B64`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_PASSWORD`

The workflow decodes the keystore only inside the temporary GitHub Actions runner, builds `assembleRelease`, verifies the APK certificate, and uploads `Baogao-Laoban-Release.apk`.

## Key continuity

The release private key is the identity of the Android app. If the key is lost, a new APK signed with a different key cannot update an existing installation.

Keep at least one secure offline backup of the keystore and its credentials.

Never commit the keystore, base64 form, or passwords to this public repository.

## Upgrade rule

For each release:

1. Keep `applicationId` unchanged: `com.hanokgroup.ops`.
2. Increment `versionCode`.
3. Update `versionName`.
4. Build only through the signed release workflow.
5. Distribute the signed release APK.

Android will then allow the new APK to install directly over the previous release without uninstalling it, provided the installed copy was also signed by this same release key.
