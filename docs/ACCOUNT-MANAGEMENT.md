# Report Boss account management 0.9.0 candidate

## Feature scope

The Android app's Profile has an **Account management** entry visible only to an active administrator. It lists active/inactive accounts, account type, and assigned stores. Administrators can:

1. Create an independent store-staff or partner account with a name, email, initial password, and permitted stores.
2. Change a staff account's single store or a partner's selected stores.
3. Confirm deactivation, immediately blocking new operational requests made with existing JWTs while retaining reports/comments/history.

A staff account uses one store and can submit, comment, upload photos, and request reopening. A partner can view assigned-store issues, comment, and attach photos. Partners cannot create tickets, change workflow state, review reopening, approve expenses, or manage accounts. The owner and existing HQ role keep existing group-wide operations. Creating HQ/admin accounts, changing role, resetting personal passwords, reactivating accounts, and creating stores are intentionally outside this version.

The store web portal includes **Individual account** email login and the existing **Shared store login** option. Partners can switch between only their assigned stores. Membership changes invalidate in-flight reads/writes and clear old tickets, comments, forms, and object URLs before showing a new store. Periodic access checks clear signed-in disabled users' UI; database policies block the next request immediately.

## Credential and recovery behavior

- The human enters the initial password in the app. It is sent only to the authenticated account endpoint and Auth, never stored in localStorage, listed, logged, or saved in the request ledger.
- New passwords need 12 Unicode characters and at most 72 UTF-8 bytes. Non-Latin characters can use several bytes each. This is an initial password, not an automatically expiring password.
- Duplicate emails never reset or adopt an unrelated existing sign-in.
- Repeated submission uses the same request ID. An incomplete request remains safely pending/inactive and appears under **Setup to finish** for its creating administrator.
- A rejected password can be corrected without changing the reserved identity.
- If Auth already created the sign-in, finishing setup does not change its original password; the UI explicitly confirms this. A lost original password requires a separate authorized recovery flow.
- Leaving a form or signing out clears its password and in-memory payload. A late response cannot reopen a dismissed screen or restore cleared private data.

## Compatibility

The development tree starts from PR #2 head `189da2079856ff6e0e95de22597ef547ce1c78c8`. It retains the Android `ACCESS_NETWORK_STATE` permission, safe notification-scheduling failure handling, and approved release certificate verification. Java source, manifest, and certificate verifier are unchanged by this feature. Version metadata is advanced together to 0.9.0 / code 13, keeping `com.hanokgroup.ops`.

The five preexisting shared store logins are backfilled into the new membership model and cannot be rebound to another store. The old administrator webpage retains password reset for an existing active shared login only; independent account creation happens in the app. The hardened legacy function never reactivates a disabled login.

## Verification

The regression suites use fictional fixtures only. They cover DOM flows, exact HTTP handlers, PostgreSQL grants/RLS/transactions, duplicate and interrupted creation, stale JWTs, membership changes, role spoofing, and protected history. PGlite is pinned as a development dependency; it does not replace Supabase Auth or Storage integration tests.

Run `npm ci --ignore-scripts && npm run check && npm test`. Browser suites are `npm run test:browser:accounts` and `npm run test:browser:partners`, in addition to the existing HQ/store browser suites. CI runs the browser suites and Android compilation/lint without production credentials. Physical-device and release-signing verification remain separate release gates.

## Release gates and sequence

Do not deploy this candidate yet. Before provisioning accounts in any target project, audit all applications that use its Auth service, including grants, policies, triggers, views, and service-role endpoints. Isolated application tests do not establish project-wide isolation. Detailed requirements are in `ACCOUNT-BACKEND.md`.

1. Complete an explicitly authorized read-only target inventory and compare actual schema, permissions, triggers, and storage ownership behavior with migration assumptions. Verify that a newly provisioned operational identity cannot gain access to the other application.
2. Run real isolated Supabase integration tests and advisors, browser suites, and normal Android Gradle compilation/lint. Review any externally issued signed-file links and service-role APIs.
3. Keep this feature isolated from PR #2 while it is under review. Do not merge or deploy as a side effect of CI.
4. Obtain action-time approval for the production authorization migration and related function deployment. Apply the reviewed migration and both function versions together, retaining gateway JWT verification. Publish frontend only after backend compatibility is confirmed.
5. Perform explicitly approved smoke tests with isolated test identities, including legacy logins, membership removal and already-signed-in deactivation. Build the signed APK with the existing approved signing identity, verify it, and test installation before distribution.

The validation workflows do not connect to production or deploy this candidate.
