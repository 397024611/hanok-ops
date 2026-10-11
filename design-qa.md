# ReportBoss 0.10.1 control-glass candidate — design QA

Status: local regression checks passed; browser and physical-device acceptance are pending. This document does not certify the previous 0.10.0 screenshots as evidence for this candidate.

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
- Automated suite: 237 tests passed, no failures or skips (227 existing plus 10 control-glass regressions).
- Independent source/DOM review: addressed shared-nav positioning/layering, standalone-login contrast, due/follow-up meaning, store-search reset, reduced-transparency fallback grammar and empty-state contrast.
- Native Java source compilation against Android API 35: passed using generated version constants and existing resource classes. This is not a Gradle APK build.
- Focused Android lint (API use, JavaScript interfaces and exported service): no issues found. Full Gradle assemble/lint remains pending.
- Text-token contrast: primary/canvas 14.54:1, secondary/canvas 5.18:1, urgency/canvas 5.75:1, blue/opaque control fallback 5.21:1.

## Browser gate prepared but not run locally

The fixture-only browser suite now checks generated entry, HQ, staff and partner screens; flat backgrounds; frosted primary actions; 320/375/390/768 widths and 844×390 landscape; floating navigation bounds; first/last ticket access in short landscape; reduced motion/transparency; local search; all ticket views; draft reopen; logout and account-help flows. Existing account, store, HQ and session browser suites remain required.

The local Chromium route is restricted and was not retried. Actual generated screenshots must be captured and inspected through the approved CI route before visual acceptance. Publication of this candidate, deployment and release require separate authorization.

## Physical-device gate

Still unverified: upgrading over 0.10.0 without uninstalling, Android status/navigation bars, keyboard and file chooser, large system text, orientation on a device, token rotation, actual server roles and background notification scheduling. A signed release additionally requires exact version, package, certificate, non-debuggable flag, ZIP alignment and embedded-asset checks.
