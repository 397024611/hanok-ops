# Public validation guide

The 0.9.1 source tree is an unreleased new-store candidate based on the released 0.9.0 tree. Read `ACCOUNT-MANAGEMENT.md` and `ACCOUNT-BACKEND.md` before any publication or deployment. Do not distribute debug-signed APKs.

## Offline automated checks

Run the client checks from the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

The Node tests use local fixtures and mocked responses. They do not require live credentials or modify a remote service.

With JDK 17 and the Android SDK installed, run:

```sh
cd android
./gradlew --no-daemon assembleDebug lintDebug
```

The pull-request validation workflow runs these same checks without release-signing material.

## Signed build checks

Repository owners must configure the four Actions secrets described in `ANDROID-SIGNING.md`. The signed-build workflow then verifies:

- package name `com.hanokgroup.ops`;
- `versionName` and `versionCode`;
- the pinned public certificate fingerprint;
- APK alignment and signature validity; and
- that the release APK is not debuggable.

The workflow uploads an Actions artifact and does not publish a GitHub Release.

## Release checklist

- Require passing client tests, Android compilation, and lint.
- Perform authorized integration tests with non-production fixtures outside the public repository.
- Verify voice input, file selection, notifications, lifecycle behavior, and installation on a supported Android device.
- Protect the release keystore and credentials outside the repository.
- Review app-local data before uninstalling any build signed with a different key.
- Keep deployment, live-service changes, and release publication as separately authorized operations.
