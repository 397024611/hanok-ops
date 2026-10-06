# 报告老板 Android Release Signing

The Android application id is `com.hanokgroup.ops`.

All installable production APKs must use the same release signing key. Do not ship debug-signed builds to users.

## GitHub Actions secrets

Configure these repository Actions secrets:

- `ANDROID_KEYSTORE_B64`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_PASSWORD`

The repository owner must enter these values personally in **Settings → Secrets and variables → Actions**. Do not paste them into issues, pull requests, chat, source files, workflow logs, or Library.

The workflow decodes the keystore only inside the temporary GitHub Actions runner, builds `assembleRelease`, verifies the APK identity, and uploads `Baogao-Laoban-Release.apk` as a 30-day Actions artifact. It does not publish a GitHub Release.

## Release certificate identity

Public SHA-256 certificate fingerprint:

`CC:4E:04:6B:6C:EC:58:9A:C0:03:10:EE:4E:A8:F6:25:06:CF:D4:5A:44:11:4E:15:C2:38:75:F4:FD:D9:F9:2F`

Use this fingerprint to verify that future production APKs are signed by the new 报告老板 release key created on 2026-10-06.

## Local custody

Keep the canonical keystore only in owner-controlled local storage outside the repository, with owner-only directory and file permissions. Store its password in the operating system credential manager. The key alias is `reportboss-release`; the PKCS12 key password is the same as the keystore password.

When adding GitHub Actions secrets, copy each value directly from the local keystore or Keychain into GitHub. The person performing this handoff must not print or save the values in a shell history, text file, chat, or pull request.

## Key continuity

The release private key is the identity of the Android app. If the key is lost, a new APK signed with a different key cannot update an installation signed by this key.

Keep at least one secure offline backup of the keystore and its credentials.

Never commit the keystore, base64 form, or passwords to this public repository.

## Upgrade rule

For each release:

1. Keep `applicationId` unchanged: `com.hanokgroup.ops`.
2. Increment `versionCode`.
3. Update `versionName`.
4. Build only through the signed release workflow.
5. Distribute the signed release APK.

Android will then allow the new APK to install directly over a previous release signed by this same key. Installations signed with the retired key or a debug key must be uninstalled before the first installation using this new identity; that uninstall can remove app-local data. Do not uninstall an existing app until its local data has been reviewed and backed up.
