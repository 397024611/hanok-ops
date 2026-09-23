# Hanok Ops

Internal operations system for Hanok Group.

## Current version

**Hanok HQ Android App v0.6**

The HQ app is designed around the owner's daily operating workflow rather than a generic task list.

### Today

- Critical items
- Due today
- Follow-ups
- New & unassigned tickets
- Active project next actions
- Quick Capture from text or Android voice input
- Today Brief with group-wide workload by store

### Tickets

- Active / Mine / Today / Overdue / Urgent / Waiting / Completed views
- Full-text style search across ticket number, store, title, description, category and owner
- HQ owner assignment using the existing `assigned_to` field
- Attachments and comments
- New → Accepted → In Progress → Waiting → Completed workflow
- Reopen requests from stores

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

A project can have a location before it is linked to an operating store. Project data is currently stored on the HQ device while the Hanok Ops Supabase project remains unavailable to the connected schema-management account.

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
