# Hanok Ops

Internal operations system for Hanok Group.

## Current version

**HQ Android App v0.5**

The HQ app is now centred around a daily operations view instead of a simple ticket feed.

### HQ app

- Today dashboard: Critical, Due Today, Follow-ups, New & Unassigned
- Priority sorting for urgent, overdue and follow-up work
- Ticket filters: Active, Today, Overdue, Urgent, Waiting, Completed
- Store dashboards with store-level Open / Critical / Waiting / Completed counts
- Ticket lifecycle: New → Accepted → In Progress → Waiting → Completed
- Attachments, comments, reopen requests and notifications
- Inbox for operational alerts
- Supabase live sync

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
