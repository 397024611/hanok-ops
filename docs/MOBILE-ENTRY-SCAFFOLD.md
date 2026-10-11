# ReportBoss unified Android entry

Version: 0.10.0 / versionCode 16 candidate, based on v0.9.2.

## Architecture

`mobile/index.html` is the bilingual Boss/Staff selector. `mobile/access.js` verifies Supabase Auth identity, the matching active profile, and current visible active stores before routing. Boss accepts admin/HQ and partners; Staff accepts staff and the existing shared-store identities. Entry choice never grants a role.

`npm run build:mobile` produces `mobile-dist/`: the selector, generated HQ/store workspaces, shared session coordination, glass styles and local icon/background assets. Android Gradle runs that builder before packaging and exclusively uses the generated assets directory. It fails rather than silently shipping the legacy HQ-only entry.

`mobile/session.js` coordinates the existing `hanokops_session` and `hanok_store_session` keys with native refresh-token compare-and-set. `mobile/workspace.js` adds identity revalidation, native token synchronization and unified logout around the existing workspaces. Build-time hooks leave the standalone staff web login and URL intact.

## Preserved boundaries

- Production Supabase project remains `tqfwbsjchespjkxliodo`; only the already-public publishable key is bundled.
- No backend migrations, grants, RLS changes, account provisioning, credentials or new notification generators are part of this change.
- Partner scope is current assigned active stores and existing view/comment/photo permissions. Staff scope is its current bound active store. No HQ operations are added to either role.
- Android application ID remains `com.hanokgroup.ops`; release certificate verification remains pinned to the existing certificate.
- Origin remains `https://hanokops.local`; storage and existing per-user Projects are not reset or moved.
- Existing pending submission, comments, photo/video, Projects, stores/accounts, AI/capture, finance/procurement, updater and notification-test functionality remains in its existing workspace.
- Old staff web deployment can retain the same URL; deploy `store-portal/` including its local glass assets. No APK is required for that URL.

## Session and routing behavior

Restoration verifies the Auth user and fresh profile/store access before showing a workspace. Temporary outages keep the session and expose retry/sign-out. Invalid identities, inactive accounts and unavailable store assignments fail closed. Leaving or changing entry invalidates pending login responses.

Successful sign-in clears opposite-role session caches. Logout clears both same-owner caches and native session state without allowing a stale request to clear a newly active account. Foreground/background token rotation uses atomic native compare-and-set. Native pending ticket, Inbox and shared-text callbacks survive entry navigation; ticket access and store membership are rechecked before opening. Shared text updates the actual staff submission draft, not only the input's displayed value.

Native polling remains Android-scheduled (approximately 15 minutes), with v0.9.2 acknowledgement/digest diagnostics retained. Polling verifies the current active profile and queries only that account's recipient rows under existing RLS. This does not create staff/partner notification recipients, add FCM, or promise instant delivery. Canceled old jobs cannot post for a replacement session.

## Visual design

Neutral silver-white refractive background, highly transparent white panels, charcoal type, blue primary/selected states and red urgent signals. Real API content replaces all prototype samples and demo roles. Existing wider HQ functionality is retained within the new visual language. Reduced transparency can be toggled in Profile and also respects the OS preference. Icons are local Radix Icons assets; the license is shipped with them.

## Verification

- `npm run check`
- `npm test`
- `npm run build:mobile`
- `python tests/glass-browser.py`: actual generated selector and workspaces, mock-only APIs, staff/partner/HQ entry, ticket/detail, draft close/reopen, profile and cross-workspace logout, 390px screenshots plus narrow/wide overflow assertions.
- Existing browser suites plus `tests/mobile-entry-browser.py`.
- `cd android && ./gradlew --no-daemon assembleDebug lintDebug`.
- Authorized signed build must pass certificate, application ID, versionCode 16/versionName 0.10.0, non-debuggable and zipalign checks before distribution.

The local restricted executor cannot launch Chromium because socket creation is denied. Authorized repository CI subsequently passed all six browser suites, Android debug build/lint and isolated account integration on candidate `049f6dc34a4b7f2745f6c12eb8da9dc64d47bfb7`. Actual 390 × 844 screenshots were inspected; see `design-qa.md`. Local syntax and 227 automated tests passed. Signed-artifact identity checks remain a separate distribution gate. A real-device v0.9.2 upgrade without uninstalling, background notification delivery, upload chooser and token rotation remain device acceptance checks. Do not claim these passed from unit tests.

This is an Android direct-APK candidate. Google Play account registration/submission and iOS are outside this release. Store-specific compliance, account deletion, privacy/support links and update-channel changes must be handled before any store submission.
