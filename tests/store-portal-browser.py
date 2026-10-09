#!/usr/bin/env python3
"""Browser regressions with an in-memory Supabase double. No live service requests.
Run: python tests/store-portal-browser.py
Requires Python playwright and Chromium (CHROMIUM_PATH optionally overrides it).
"""
import asyncio
import copy
import json
import os
from pathlib import Path
import unittest
from urllib.parse import parse_qs, urlsplit
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "tests" / "artifacts"
USER = "11111111-1111-4111-8111-111111111111"
STORE = "22222222-2222-4222-8222-222222222222"
SESSION = {"access_token": "test-access", "refresh_token": "test-refresh", "user": {"id": USER}}
NOW = "2026-10-05T10:00:00Z"

def ticket(id="33333333-3333-4333-8333-333333333333", title="Broken fridge", **kw):
    return dict(id=id, title=title, store_id=STORE, ticket_no=1, description="Needs repair", reported_by="Sam", category="Maintenance", priority="normal", status="new", created_at=NOW, updated_at=NOW, **kw)

class Backend:
    def __init__(self):
        self.rows = {"ops_tickets": [ticket()], "ops_ticket_comments": [], "ops_ticket_events": [], "ops_ticket_attachments": [], "ops_reopen_requests": []}
        self.requests = []
        self.hooks = []
        self.role = "store"
        self.objects = {}
        self.refreshes = 0

    async def handle(self, route):
        req = route.request
        url = urlsplit(req.url)
        if url.netloc == "portal.test":
            name = "admin.html" if url.path == "/admin.html" else "index.html"
            await route.fulfill(status=200, content_type="text/html", body=(ROOT / "store-portal" / name).read_text())
            return
        if url.netloc != "tqfwbsjchespjkxliodo.supabase.co":
            await route.abort()
            return
        self.requests.append((req.method, url.path, parse_qs(url.query), req.post_data, req.headers))
        for hook in self.hooks:
            if await hook(route, req, url):
                return
        await self.normal(route, req, url)

    async def normal(self, route, req, url):
        async def result(data, status=200):
            await route.fulfill(status=status, content_type="application/json", body=json.dumps(data))
        query = parse_qs(url.query)
        if url.path == "/auth/v1/token":
            if query.get("grant_type") == ["refresh_token"]:
                self.refreshes += 1
                await result({**SESSION, "access_token": "fresh-access", "refresh_token": "fresh-refresh"})
            else:
                await result(SESSION)
            return
        if url.path == "/auth/v1/logout":
            await result({})
            return
        if url.path == "/functions/v1/ops-admin-store-user":
            await result({"ok": True, "username": "BBQTOWN Dickson"})
            return
        if url.path.startswith("/storage/"):
            if req.method == "POST":
                self.objects[url.path] = True
                await result({"Key": "mock-file"})
            else:
                await route.fulfill(status=200, content_type="image/png", body=b"fake fixture bytes")
            return
        table = url.path.rsplit("/", 1)[-1]
        if table == "ops_profiles":
            await result([{"user_id": USER, "role": self.role, "display_name": "Test", "store_id": STORE}])
            return
        if table == "ops_stores":
            await result([{"id": STORE, "code": "HWD", "name": "Hanok Woden", "active": True}])
            return
        if table not in self.rows:
            await result({"message": "Unexpected mock path: " + url.path}, 500)
            return
        if req.method == "POST":
            data = req.post_data_json
            if any(r["id"] == data["id"] for r in self.rows[table]):
                await result({"message": "duplicate", "code": "23505"}, 409)
                return
            data = {"created_at": NOW, "updated_at": NOW, **data}
            if table == "ops_tickets":
                data = {"status": "new", "ticket_no": len(self.rows[table]) + 1, **data}
            if table == "ops_reopen_requests":
                if any(r["ticket_id"] == data["ticket_id"] and r["status"] == "pending" for r in self.rows[table]):
                    await result({"message": "pending reopen", "code": "23505"}, 409)
                    return
                data["status"] = "pending"
            self.rows[table].append(data)
            await result([data])
            return
        rows = copy.deepcopy(self.rows[table])
        for field in ["id", "ticket_id", "store_id"]:
            if field in query:
                target = query[field][0].removeprefix("eq.")
                rows = [r for r in rows if r.get(field) == target]
        offset = int(query.get("offset", [0])[0]); limit = int(query.get("limit", [len(rows)])[0])
        await result(rows[offset:offset+limit])

    def calls(self, method, path):
        return [r for r in self.requests if r[0] == method and r[1] == path]

class PortalTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        ARTIFACTS.mkdir(exist_ok=True)
        self.pw = await async_playwright().start()
        executable = os.environ.get("CHROMIUM_PATH") or None
        try:
            self.browser = await self.pw.chromium.launch(executable_path=executable, headless=True, args=["--no-sandbox"])
        except Exception:
            await self.pw.stop()
            raise
        self.context = await self.browser.new_context(viewport={"width": 390, "height": 844}, service_workers="block")
        self.backend = Backend()
        await self.context.route("**/*", self.backend.handle)
        self.page = await self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    async def asyncTearDown(self):
        await self.browser.close()
        await self.pw.stop()
        self.assertEqual(self.errors, [], "Unhandled page errors")

    async def open(self, session=True, admin=False):
        if session:
            await self.page.add_init_script("localStorage.setItem('hanok_store_session', " + json.dumps(json.dumps(SESSION)) + ");")
        await self.page.goto("https://portal.test/" + ("admin.html" if admin else ""))
        if session and not admin:
            await expect(self.page.get_by_role("button", name="Report an issue", exact=True)).to_be_visible()
            await expect(self.page.locator(".ticket")).to_have_count(len(self.backend.rows["ops_tickets"]))

    async def new_issue(self, title="Leaking pipe"):
        await self.page.get_by_role("button", name="Report an issue", exact=True).click()
        await self.page.get_by_label("Title", exact=True).fill(title)
        await self.page.get_by_label("Description", exact=True).fill("Water by the sink")

    async def test_corrupt_session_keyboard_login_and_accessible_close(self):
        await self.page.add_init_script("localStorage.setItem('hanok_store_session', '{broken');")
        await self.open(session=False)
        await self.page.get_by_label("PASSWORD", exact=True).fill("fake-password")
        await self.page.get_by_label("PASSWORD", exact=True).press("Enter")
        await expect(self.page.locator(".ticket")).to_have_count(1)
        await self.page.screenshot(path=str(ARTIFACTS / "store-portal-tickets.png"), full_page=True)
        await self.new_issue()
        await expect(self.page.get_by_role("dialog", name="Report Issue")).to_be_visible()
        await self.page.screenshot(path=str(ARTIFACTS / "store-portal-report.png"), full_page=True)
        await self.page.keyboard.press("Escape")
        await expect(self.page.get_by_role("dialog")).to_have_count(0)
        await expect(self.page.get_by_role("button", name="Report an issue", exact=True)).to_be_focused()
        self.assertEqual(len(self.backend.calls("POST", "/auth/v1/token")), 1)

    async def test_attachment_partial_failure_retries_without_duplicate_ticket_or_object(self):
        failing = True
        async def hook(route, req, url):
            if failing and req.method == "POST" and url.path == "/rest/v1/ops_ticket_attachments":
                await route.fulfill(status=503, json={"message": "temporary metadata outage"}); return True
            return False
        self.backend.hooks.append(hook)
        await self.open(); await self.new_issue()
        await self.page.get_by_label("Photo / Video (up to 50 MB)").set_input_files({"name": "photo.png", "mimeType": "image/png", "buffer": b"test"})
        await self.page.evaluate("() => {createTicket();createTicket()}")
        await expect(self.page.get_by_role("button", name="Retry attachment")).to_be_enabled()
        self.assertEqual(len(self.backend.calls("POST", "/rest/v1/ops_tickets")), 1)
        self.assertIn("Ticket sent to HQ", await self.page.locator("#submitStatus").inner_text())
        failing = False
        await self.page.get_by_role("button", name="Retry attachment").click()
        await expect(self.page.get_by_role("dialog")).to_have_count(0)
        self.assertEqual(len(self.backend.rows["ops_tickets"]), 2)
        self.assertEqual(len(self.backend.rows["ops_ticket_attachments"]), 1)
        self.assertEqual(sum(1 for r in self.backend.requests if r[0] == "POST" and r[1].startswith("/storage/")), 1)

    async def test_lost_ticket_response_is_reconciled(self):
        async def hook(route, req, url):
            if req.method == "POST" and url.path == "/rest/v1/ops_tickets":
                self.backend.rows["ops_tickets"].append({**req.post_data_json, "status": "new", "ticket_no": 2, "created_at": NOW})
                await route.abort("failed"); return True
            return False
        self.backend.hooks.append(hook)
        await self.open(); await self.new_issue()
        await self.page.get_by_role("button", name="Submit to HQ").click()
        await expect(self.page.get_by_role("dialog")).to_have_count(0)
        self.assertEqual(len(self.backend.rows["ops_tickets"]), 2)

    async def test_close_during_create_does_not_reopen_or_lose_payload(self):
        started = asyncio.Event(); release = asyncio.Event()
        async def hook(route, req, url):
            if req.method == "POST" and url.path == "/rest/v1/ops_tickets":
                started.set(); await release.wait(); await self.backend.normal(route, req, url); return True
            return False
        self.backend.hooks.append(hook)
        await self.open(); await self.new_issue()
        await self.page.get_by_role("button", name="Submit to HQ").click(); await started.wait()
        await self.page.get_by_role("button", name="Close", exact=True).click(); release.set()
        await expect(self.page.locator(".ticket")).to_have_count(2)
        await expect(self.page.get_by_role("dialog")).to_have_count(0)
        self.assertEqual(self.backend.rows["ops_tickets"][-1]["description"], "Water by the sink")

    async def test_old_detail_responses_cannot_overwrite_new_ticket(self):
        second = ticket("44444444-4444-4444-8444-444444444444", "Router offline")
        self.backend.rows["ops_tickets"].append(second)
        self.backend.rows["ops_ticket_comments"] = [{"id": "first", "ticket_id": ticket()["id"], "body": "FIRST ONLY", "created_at": NOW}, {"id": "second", "ticket_id": second["id"], "body": "SECOND ONLY", "created_at": NOW}]
        async def hook(route, req, url):
            if req.method == "GET" and url.path.endswith("ops_ticket_comments") and ticket()["id"] in url.query:
                await asyncio.sleep(.3); await self.backend.normal(route, req, url); return True
            return False
        self.backend.hooks.append(hook)
        await self.open(); await self.page.locator(".ticket").first.click()
        await self.page.get_by_role("button", name="Close", exact=True).click()
        await self.page.locator(".ticket").nth(1).click()
        await expect(self.page.locator("#comments")).to_contain_text("SECOND ONLY")
        await self.page.wait_for_timeout(400)
        self.assertNotIn("FIRST ONLY", await self.page.locator("#overlay").inner_text())

    async def test_comment_duplicate_submit_and_close_stay_closed(self):
        started = asyncio.Event(); release = asyncio.Event()
        async def hook(route, req, url):
            if req.method == "POST" and url.path.endswith("ops_ticket_comments"):
                started.set(); await release.wait(); await self.backend.normal(route, req, url); return True
            return False
        self.backend.hooks.append(hook)
        await self.open(); await self.page.locator(".ticket").click()
        await self.page.get_by_label("Add comment", exact=True).fill("Please check tomorrow")
        await self.page.evaluate("() => {comment();comment()}"); await started.wait()
        await self.page.get_by_role("button", name="Close", exact=True).click(); release.set()
        await self.page.wait_for_timeout(150)
        await expect(self.page.get_by_role("dialog")).to_have_count(0)
        self.assertEqual(len(self.backend.rows["ops_ticket_comments"]), 1)

    async def test_concurrent_401_refreshes_once(self):
        async def hook(route, req, url):
            if url.path.endswith("ops_tickets") and req.headers.get("authorization") == "Bearer test-access":
                await route.fulfill(status=401, json={"message": "expired"}); return True
            return False
        await self.open(); self.backend.hooks.append(hook)
        await self.page.evaluate("() => Promise.all([api('/rest/v1/ops_tickets'),api('/rest/v1/ops_tickets'),api('/rest/v1/ops_tickets')])")
        self.assertEqual(self.backend.refreshes, 1)
        self.assertEqual(await self.page.evaluate("session.access_token"), "fresh-access")

    async def test_repeated_401_stops_after_one_retry_and_cleans_overlay(self):
        await self.open(); await self.page.locator(".ticket").click()
        async def hook(route, req, url):
            if url.path.endswith("ops_tickets"):
                await route.fulfill(status=401, json={"message": "expired"}); return True
            return False
        self.backend.hooks.append(hook)
        count = len(self.backend.calls("GET", "/rest/v1/ops_tickets"))
        await self.page.evaluate("() => api('/rest/v1/ops_tickets').catch(() => null)")
        await expect(self.page.get_by_role("button", name="Sign in", exact=True)).to_be_visible()
        await expect(self.page.get_by_role("dialog")).to_have_count(0)
        self.assertEqual(len(self.backend.calls("GET", "/rest/v1/ops_tickets")) - count, 2)
        self.assertEqual(self.backend.refreshes, 1)
        self.assertIsNone(await self.page.evaluate("localStorage.getItem('hanok_store_session')"))

    async def test_logout_during_refresh_does_not_restore_session(self):
        await self.open(); started = asyncio.Event(); release = asyncio.Event()
        async def hook(route, req, url):
            if url.path == "/auth/v1/token":
                started.set(); await release.wait(); await self.backend.normal(route, req, url); return True
            return False
        self.backend.hooks.append(hook)
        await self.page.evaluate("() => {refresh().catch(() => null)}"); await started.wait()
        await self.page.get_by_role("button", name="Sign out", exact=True).click(); release.set()
        await self.page.wait_for_timeout(100)
        self.assertIsNone(await self.page.evaluate("session"))
        self.assertIsNone(await self.page.evaluate("localStorage.getItem('hanok_store_session')"))
        await expect(self.page.get_by_role("button", name="Sign in", exact=True)).to_be_visible()

    async def test_transient_refresh_error_does_not_destroy_session(self):
        await self.open()
        async def hook(route, req, url):
            if url.path == "/auth/v1/token":
                await route.fulfill(status=503, json={"message": "temporary"}); return True
            return False
        self.backend.hooks.append(hook)
        await self.page.evaluate("() => refresh().catch(() => null)")
        self.assertIsNotNone(await self.page.evaluate("session"))
        await expect(self.page.get_by_role("button", name="Sign out", exact=True)).to_be_visible()

    async def test_progress_refresh_preserves_comment_and_reopen_review(self):
        await self.open(); await self.page.locator(".ticket").click()
        await self.page.get_by_label("Add comment", exact=True).fill("Unsent update")
        self.backend.rows["ops_tickets"][0].update(status="completed", resolution="Repaired")
        await self.page.evaluate("() => loadTickets()")
        await expect(self.page.locator("#ticketSummary")).to_contain_text("Repaired")
        await expect(self.page.get_by_label("Add comment", exact=True)).to_have_value("Unsent update")
        await expect(self.page.get_by_role("button", name="Issue not resolved")).to_be_visible()
        await self.page.get_by_role("button", name="Issue not resolved").click()
        await self.page.get_by_label("What is still wrong?").fill("Still leaking")
        await self.page.evaluate("() => {requestReopen();requestReopen()}")
        await expect(self.page.locator("#reopenWrap")).to_contain_text("Reopen requested")
        self.assertEqual(len(self.backend.rows["ops_reopen_requests"]), 1)
        self.backend.rows["ops_reopen_requests"][0].update(status="rejected", reviewed_at=NOW)
        await self.page.evaluate("() => loadTickets()")
        await expect(self.page.locator("#reopenWrap")).to_contain_text("Reopen rejected")

    async def test_pagination_includes_older_tickets_and_errors_are_visible(self):
        self.backend.rows["ops_tickets"] = [ticket(str(i), "Issue " + str(i)) for i in range(151)]
        await self.open()
        calls = self.backend.calls("GET", "/rest/v1/ops_tickets")
        self.assertEqual([r[2]["offset"] for r in calls], [["0"], ["150"]])
        self.assertTrue(all(r[2]["store_id"] == ["eq." + STORE] for r in calls))
        async def hook(route, req, url):
            if url.path.endswith("ops_tickets"):
                await route.fulfill(status=503, json={"message": "offline"}); return True
            return False
        self.backend.hooks.append(hook)
        await self.page.evaluate("() => loadTickets()")
        await expect(self.page.locator(".sync")).to_contain_text("Refresh failed")
        await expect(self.page.locator(".ticket")).to_have_count(151)

    async def test_attachment_refresh_blob_cleanup_and_video_controls(self):
        self.backend.rows["ops_ticket_attachments"] = [{"id": "a", "ticket_id": ticket()["id"], "storage_path": ticket()["id"] + "/video.mp4", "file_name": "repair.mp4", "mime_type": "video/mp4", "created_at": NOW}]
        await self.open()
        await self.page.evaluate("() => {window.revoked=[];const original=URL.revokeObjectURL;URL.revokeObjectURL=u=>{window.revoked.push(u);original(u)}}")
        async def hook(route, req, url):
            if url.path.startswith("/storage/") and req.headers.get("authorization") == "Bearer test-access":
                await route.fulfill(status=401, json={"message": "expired"}); return True
            return False
        self.backend.hooks.append(hook)
        await self.page.locator(".ticket").click()
        await expect(self.page.locator("video[controls]")).to_have_count(1)
        self.assertEqual(self.backend.refreshes, 1)
        await self.page.get_by_role("button", name="Close", exact=True).click()
        self.assertEqual(len(await self.page.evaluate("window.revoked")), 1)

    async def admin_login(self):
        self.backend.role = "admin"
        await self.open(session=False, admin=True)
        await self.page.get_by_label("Email", exact=True).fill("admin@example.test")
        await self.page.get_by_label("Password", exact=True).fill("fake-admin-password")
        await self.page.get_by_label("Password", exact=True).press("Enter")
        await expect(self.page.get_by_role("button", name="Reset Shared Store Password", exact=True)).to_be_visible()

    async def test_admin_no_shared_password_duplicate_save_and_cleanup(self):
        await self.admin_login()
        await expect(self.page.get_by_label("Temporary password")).to_have_value("")
        await expect(self.page.locator("#pass")).to_have_value("")
        await self.page.get_by_label("Temporary password").fill("unique-test-password")
        await self.page.evaluate("() => {saveStore();saveStore()}")
        await expect(self.page.locator("#out")).to_contain_text("is ready")
        self.assertEqual(len(self.backend.calls("POST", "/functions/v1/ops-admin-store-user")), 1)
        await expect(self.page.get_by_label("Temporary password")).to_have_value("")
        await self.page.get_by_role("button", name="Sign out", exact=True).click()
        self.assertIsNone(await self.page.evaluate("session"))
        await expect(self.page.locator("#out")).to_have_text("")

    async def test_admin_logout_during_save_cannot_restore_success_or_password(self):
        await self.admin_login(); started = asyncio.Event(); release = asyncio.Event()
        async def hook(route, req, url):
            if url.path == "/functions/v1/ops-admin-store-user":
                started.set(); await release.wait(); await self.backend.normal(route, req, url); return True
            return False
        self.backend.hooks.append(hook)
        await self.page.get_by_label("Temporary password").fill("unique-test-password")
        await self.page.get_by_role("button", name="Reset Shared Store Password", exact=True).click(); await started.wait()
        await self.page.get_by_role("button", name="Sign out", exact=True).click(); release.set()
        await self.page.wait_for_timeout(100)
        await expect(self.page.locator("#out")).to_have_text("")
        await expect(self.page.locator("#storePass")).to_have_value("")
        await expect(self.page.get_by_role("button", name="Sign in", exact=True)).to_be_visible()

    async def test_admin_rejects_store_role_and_clears_session(self):
        await self.open(session=False, admin=True)
        await self.page.get_by_label("Email", exact=True).fill("store@example.test")
        await self.page.get_by_label("Password", exact=True).fill("fake-password")
        await self.page.get_by_role("button", name="Sign in", exact=True).click()
        await expect(self.page.locator("#loginOut")).to_contain_text("not an Admin")
        self.assertIsNone(await self.page.evaluate("session"))
        await expect(self.page.get_by_label("Password", exact=True)).to_have_value("")

if __name__ == "__main__":
    unittest.main(verbosity=2)
