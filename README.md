# 报告老板

Internal operations system for Hanok Group.

## Current version

**报告老板 Android App v0.9.1 / code 14 (new-store candidate; not released)**

The HQ app is designed around the owner's daily operating workflow rather than a generic task list.

### Account and store management

- Active administrators can create new stores with a name and unique short code, then assign individual store-staff and partner accounts.
- Store staff belong to one store; partners can view and follow up on one or more assigned stores.
- Administrators can change those store assignments and deactivate an account without deleting history.
- Existing shared-store sign-ins remain compatible and keep their original store binding.
- Interrupted creation can be resumed from "Setup to finish" without resetting an existing password.
- There is no cost-approval workflow or creation of HQ/administrator roles.

The frontend and backend must be released together after the shared-project authorization audit. See `docs/ACCOUNT-MANAGEMENT.md` for the current validation and release gates and `docs/ACCOUNT-BACKEND.md` for security details.

### Today

- Critical items
- Due today
- Follow-ups
- New & unassigned tickets
- Active project next actions
- Quick Capture from text or Android voice input
- Today Brief with group-wide workload by store
- Procurement and Finance workspaces built from existing ticket categories

### Tickets

- Active / Mine / Today / Overdue / Urgent / Waiting / Completed views
- Full-text style search across ticket number, store, title, description, category and owner
- HQ owner assignment using the existing `assigned_to` field
- Attachments and comments
- New → Accepted → In Progress → Waiting → Completed workflow
- Reopen requests from stores

### 报告老板 AI

- AI-first Quick Capture with local-rule fallback
- Ask 报告老板 AI natural-language operations questions
- AI-generated Today Brief
- Ticket-level Next Action suggestions
- Ticket-level follow-up drafting
- Model calls run server-side through Vercel AI Gateway
- 报告老板 Supabase bearer token is verified server-side
- Only HQ/Admin roles can use the AI routes
- AI requests automatically refresh an expired HQ session token

### Android integrations

- Native voice capture
- Share text from other Android apps directly into Quick Capture
- Native background notification polling (periodic, subject to Android background scheduling)
- Foreground/background Supabase session synchronization

### Quick Capture

Quick Capture converts a short English or Chinese note into a reviewed ticket draft.

It currently suggests:

- Store
- Category
- Priority
- Due date
- Waiting / follow-up status

Example:

`Woden back door waiting for Westfield tomorrow`

### Projects

Projects v0.1 tracks HQ work such as new stores, relocations and renovations.

Stages:

- Lease
- Design
- Approval / DA
- Equipment
- Construction
- Health
- Staffing
- Marketing
- Opening
- Live

A project can have a location before it is linked to an operating store. Project data is stored only on the HQ device and is not yet synchronized across devices.

### Inbox

- New store tickets
- System notifications
- Read-all control
- Ticket deep links

### Store portal

Stores use the web portal to submit and track issues. Store users do not need the Android app.

## Apps

- `android/` — HQ Android app
- `store-portal/` — Store web portal
- `.github/workflows/` — Android and web deployment workflows
- `supabase/` — Database migrations and backend configuration

## Stores

- Hanok Woden (HWD)
- Hanok Wagga (HWG)
- Pandan Leaf (PDL)
- Meathouse (MTH)
- BBQTOWN Dickson (BTD)

This repository is independent from individual store repositories.

## Validation and release

Run `npm ci --ignore-scripts && npm run check && npm test` for mocked client regression checks. With JDK 17 and Android SDK 35 installed, run `cd android && ./gradlew --no-daemon assembleDebug lintDebug`.

The 0.9.1 new-store candidate is not deployed or released, and no signed 0.9.1 APK has been built. The previous 0.9.0 web/backend release and signed APK were verified separately. It preserves the 0.8.4 login-crash fix and approved release identity documented in `docs/ANDROID-SIGNING.md`; the private key is not stored in this repository. The public workflows run offline client regression tests plus Android compilation and lint. Live-service, account, deployment, and real-device validation are separate from this public source candidate. Never distribute a debug APK as a production update.
