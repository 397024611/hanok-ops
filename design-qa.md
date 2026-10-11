# ReportBoss 0.10.1 control-glass candidate — design QA

Status: browser visual acceptance passed for source candidate 50ab06b7b3e7fe0dae4d54918681f080a8e0bc29. Physical-device acceptance remains pending.

[Full validation and rendered screenshot artifact](https://github.com/397024611/hanok-ops/actions/runs/38145607717) and [isolated backend integration](https://github.com/397024611/hanok-ops/actions/runs/38145607711) passed for that candidate. All six browser suites, Android debug assembly and full lint passed.

## Visual target

Approved direction: flat cool-white canvas (#F5F6F8), dark readable typography, frosted pill buttons and segmented filters, floating navigation, compact ticket rows and restrained blue selection. Glass is confined to controls. Content surfaces, backgrounds and detail pages are opaque or flat. No background texture, refraction or blue light field is applied.

The implementation stays within the existing HTML/JavaScript WebView app. It does not embed prototype business logic, sample data or preview accounts.

## Preserved functionality

- Boss/Staff entry; actual account role and store scope determine access.
- HQ Today, Tickets, Stores, Projects and Inbox; all seven existing ticket views remain in the view selector. Active, Waiting and Done have primary segmented controls.
- Existing sign-in, account creation, recovery and help; shared-store login compatibility.
- Real ticket creation, comments, attachments, status transitions, ownership, follow-up, reopen, local projects and recoverable drafts.
- Session replacement/CAS, BFCache access refresh, stale-response guards, Android origin, application identity, update entry and notifications.
- Partners retain view/comment/photo access without report/status controls. Search in staff/partner views is client-side and scoped to already authorized tickets; scope changes clear it.

## Local checks

- JavaScript syntax and generated mobile bundle: passed.
- Automated suite: 238 tests passed, no failures or skips (227 existing plus 11 control-glass regressions).
- Independent source/DOM review: addressed shared-nav positioning/layering, standalone-login contrast, due/follow-up meaning, store-search reset, reduced-transparency fallback grammar and empty-state contrast.
- Native Java source compilation against Android API 35: passed using generated version constants and existing resource classes. This is not a Gradle APK build.
- Focused Android lint (API use, JavaScript interfaces and exported service): no issues found. Full Gradle assembleDebug/lintDebug subsequently passed in CI.
- Text-token contrast: primary/canvas 14.54:1, secondary/canvas 5.18:1, urgency/canvas 5.75:1, blue/opaque control fallback 5.21:1.

## Browser visual acceptance

The fixture-only browser suite now checks generated entry, HQ, staff and partner screens; flat backgrounds; frosted primary actions; 320/375/390/768 widths and 844×390 landscape; floating navigation bounds; first/last ticket access in short landscape; reduced motion/transparency; local search; all ticket views; draft reopen; logout and account-help flows. Existing account, store, HQ and session browser suites remain required.

The local Chromium route is restricted and was not retried. Actual generated screenshots from the approved CI route were inspected against the approved concept, including entry, account help, HQ, staff, partner and ticket detail. Independent visual review found no remaining blocking clipping, overlap, role-control or material-treatment issue. The staff search row was corrected after the first render and verified as a single row at 320px and above. Landscape screenshots intentionally show the last-ticket scrolled state, with navigation fully on-screen. Entry utility controls are visible. Preserved native upload fields and existing HQ actions are intentional functional constraints.

The user approved public source and conditional APK release. Merge and signed distribution remain gated on final exact-head CI and artifact verification.

## Physical-device gate

Still unverified: upgrading over 0.10.0 without uninstalling, Android status/navigation bars, keyboard and file chooser, large system text, orientation on a device, token rotation, actual server roles and background notification scheduling. A signed release additionally requires exact version, package, certificate, non-debuggable flag, ZIP alignment and embedded-asset checks.
