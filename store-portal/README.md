# 报告老板 — Store Report Portal

Standalone store-facing portal for Hanok Group operations.

## Vercel
- Project name: `baogaolaoban-report`
- Root Directory: `store-portal`
- Framework Preset: Other
- Production domain: `report.baogaolaoban.com`

This portal connects to the Supabase project configured in the client source.

## Reliability and local verification

The portal uses the existing Supabase project and row-level policies. It requires
modern browsers with `crypto.randomUUID`, `AbortSignal.any`, and `AbortSignal.timeout`.
Uploads are limited to photos/videos up to 50 MB, matching the checked-in bucket limit.
SVG uploads are rejected; images are expanded inline rather than opening authenticated
blob documents in a new tab.

- Ticket submissions use stable client-generated IDs. Retrying an unconfirmed
  submission reconciles the same ticket rather than creating another one.
- An attachment failure leaves the created ticket intact and offers an
  attachment-only retry. The file and draft stay in memory when closing and
  reopening the report form; they do not survive reloading the page or signing out.
- Storage retries reuse the same path. The existing bucket's INSERT, SELECT, and
  UPDATE policies are required for authenticated upsert retries.
- Details, timeline, comments, attachment links, and reopen review status refresh
  with the ticket list. Background refresh preserves an unfinished comment.
- Signing out clears local session and draft state, cancels pending reads,
  releases media URLs, and makes a best-effort local-session revocation request.
- Admin account setup has no prefilled/shared temporary password.

From the repository root:

```sh
npm ci
node --test tests/store-portal.test.cjs
npm run check
python tests/store-portal-browser.py
```

The DOM and Playwright tests replace every backend request with fixtures. They
do not use live credentials or modify remote data. The Playwright suite requires
Python `playwright` and Chromium (`CHROMIUM_PATH` can select the executable).
DOM tests verify logic and markup, not visual layout or native browser behavior.
