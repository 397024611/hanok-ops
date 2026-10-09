#!/usr/bin/env python3
"""Account portal browser regressions. Every request is intercepted; no live services.
Run: python tests/store-accounts-browser.py
Requires the same Python Playwright/Chromium setup as store-portal-browser.py.
"""
import asyncio
import importlib.util
import json
from pathlib import Path
import unittest
from urllib.parse import parse_qs
from playwright.async_api import expect

spec = importlib.util.spec_from_file_location('portal_fixture', Path(__file__).with_name('store-portal-browser.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
FIRST = base.STORE
SECOND = '44444444-4444-4444-8444-444444444444'

class AccountPortalTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = base.PortalTests.asyncSetUp
    asyncTearDown = base.PortalTests.asyncTearDown

    async def open_accounts(self, role='partner', saved=True):
        self.backend.role = role
        self.active = True
        self.memberships = [FIRST, SECOND]
        second = base.ticket('second-ticket', 'SECOND STORE ISSUE')
        second['store_id'] = SECOND
        self.backend.rows['ops_tickets'] = [base.ticket(title='FIRST STORE ISSUE'), second]
        async def accounts(route, req, url):
            if url.path.endswith('/ops_profiles'):
                await route.fulfill(json=[{'user_id': base.USER, 'role': self.backend.role, 'active': self.active, 'display_name': 'Fixture user', 'store_id': FIRST if self.backend.role == 'store' else None}])
                return True
            if url.path.endswith('/ops_stores'):
                stores = [{'id': FIRST, 'name': 'First store', 'code': 'ONE', 'active': True}, {'id': SECOND, 'name': 'Second store', 'code': 'TWO', 'active': True}]
                query = parse_qs(url.query)
                await route.fulfill(json=[s for s in stores if s['id'] in self.memberships and ('id' not in query or query['id'] == ['eq.' + s['id']])])
                return True
            return False
        self.backend.hooks.append(accounts)
        if saved:
            await self.page.add_init_script("localStorage.setItem('hanok_store_session', " + json.dumps(json.dumps(base.SESSION)) + ");")
        await self.page.goto('https://portal.test/')
        if saved and role in ['partner', 'store']:
            await expect(self.page.locator('.ticket')).to_have_count(1)

    async def test_independent_and_shared_login_are_keyboard_accessible(self):
        await self.open_accounts(role='store', saved=False)
        await self.page.get_by_role('button', name='Staff / Partner', exact=True).click()
        await self.page.get_by_label('EMAIL', exact=True).fill('staff@example.test')
        await self.page.get_by_label('PASSWORD', exact=True).fill('fixture-only')
        await self.page.get_by_label('PASSWORD', exact=True).press('Enter')
        await expect(self.page.locator('.ticket')).to_have_count(1)
        self.assertEqual(json.loads(self.backend.calls('POST', '/auth/v1/token')[0][3])['email'], 'staff@example.test')
        await expect(self.page.get_by_role('button', name='Report an issue', exact=True)).to_be_visible()
        await expect(self.page.get_by_label('ASSIGNED STORE', exact=True)).to_have_count(0)
        await self.page.get_by_role('button', name='Sign out', exact=True).click()
        await self.page.get_by_role('button', name='Shared store', exact=True).click()
        await self.page.get_by_label('PASSWORD', exact=True).fill('fixture-only')
        await self.page.get_by_label('PASSWORD', exact=True).press('Enter')
        await expect(self.page.locator('.ticket')).to_have_count(1)
        self.assertEqual(json.loads(self.backend.calls('POST', '/auth/v1/token')[-1][3])['email'], 'store.hwd@hanokops.invalid')

    async def test_partner_switch_clears_old_details_draft_and_ignores_late_comments(self):
        await self.open_accounts()
        await expect(self.page.get_by_role('button', name='Report an issue', exact=True)).to_have_count(0)
        started = asyncio.Event()
        release = asyncio.Event()
        async def delayed(route, req, url):
            if url.path.endswith('/ops_ticket_comments') and base.ticket()['id'] in url.query:
                started.set()
                await release.wait()
                await route.fulfill(json=[{'id': 'private', 'body': 'OLD STORE PRIVATE COMMENT', 'created_at': base.NOW}])
                return True
            return False
        self.backend.hooks.append(delayed)
        await self.page.locator('.ticket').click()
        await started.wait()
        await self.page.get_by_label('Add comment', exact=True).fill('Old store unsent comment')
        await self.page.get_by_role('button', name='Close', exact=True).click()
        await self.page.get_by_label('ASSIGNED STORE', exact=True).select_option(SECOND)
        await expect(self.page.locator('.ticket')).to_contain_text('SECOND STORE ISSUE')
        release.set()
        await self.page.wait_for_timeout(100)
        await expect(self.page.get_by_role('dialog')).to_have_count(0)
        self.assertNotIn('FIRST STORE ISSUE', await self.page.locator('#app').inner_text())
        await self.page.locator('.ticket').click()
        await expect(self.page.get_by_label('Add comment', exact=True)).to_have_value('')
        self.assertNotIn('OLD STORE PRIVATE COMMENT', await self.page.locator('#overlay').inner_text())
        await self.page.screenshot(path=str(base.ARTIFACTS / 'reportboss-partner-detail.png'), full_page=True)
        await self.page.get_by_role('button', name='Close', exact=True).click()
        await self.page.screenshot(path=str(base.ARTIFACTS / 'reportboss-partner-stores.png'), full_page=True)

    async def test_dynamic_membership_and_account_deactivation_clear_access(self):
        await self.open_accounts()
        await self.page.locator('.ticket').click()
        await self.page.get_by_label('Add comment', exact=True).fill('Private draft')
        self.memberships = [SECOND]
        await self.page.evaluate('() => loadTickets()')
        await expect(self.page.get_by_role('dialog')).to_have_count(0)
        await expect(self.page.get_by_label('ASSIGNED STORE', exact=True)).to_have_value(SECOND)
        await expect(self.page.locator('.ticket')).to_contain_text('SECOND STORE ISSUE')
        self.active = False
        await self.page.evaluate('() => loadTickets()')
        await expect(self.page.get_by_role('button', name='Sign in', exact=True)).to_be_visible()
        self.assertIsNone(await self.page.evaluate('session'))
        self.assertIsNone(await self.page.evaluate("localStorage.getItem('hanok_store_session')"))
        self.assertNotIn('SECOND STORE ISSUE', await self.page.locator('#app').inner_text())

    async def test_partner_attachment_retry_and_close_reopen_do_not_duplicate(self):
        await self.open_accounts()
        await self.page.locator('.ticket').click()
        failing = True
        async def fail_metadata(route, req, url):
            if failing and req.method == 'POST' and url.path.endswith('/ops_ticket_attachments'):
                await route.fulfill(status=503, json={'message': 'temporary fixture failure'})
                return True
            return False
        self.backend.hooks.append(fail_metadata)
        await self.page.get_by_label('Add photo / video (up to 50 MB)').set_input_files({'name': 'repair.png', 'mimeType': 'image/png', 'buffer': b'fixture'})
        await self.page.evaluate('() => { addAttachment(); addAttachment(); }')
        await expect(self.page.get_by_role('button', name='Retry attachment', exact=True)).to_be_enabled()
        await self.page.get_by_role('button', name='Close', exact=True).click()
        await self.page.locator('.ticket').click()
        await expect(self.page.get_by_label('Add photo / video (up to 50 MB)')).to_be_disabled()
        failing = False
        await self.page.get_by_role('button', name='Retry attachment', exact=True).click()
        await expect(self.page.locator('#attachmentStatus')).to_contain_text('Attachment added.')
        self.assertEqual(len(self.backend.rows['ops_ticket_attachments']), 1)
        self.assertEqual(sum(1 for r in self.backend.requests if r[0] == 'POST' and r[1].startswith('/storage/')), 1)
        self.assertEqual(len(self.backend.calls('POST', '/rest/v1/ops_tickets')), 0)
        self.assertEqual(len(self.backend.calls('POST', '/rest/v1/ops_reopen_requests')), 0)

    async def test_hq_role_fails_closed_before_reading_store_data(self):
        await self.open_accounts(role='hq')
        await expect(self.page.locator('#err')).to_contain_text('cannot use the store portal')
        self.assertEqual(len(self.backend.calls('GET', '/rest/v1/ops_stores')), 0)
        self.assertEqual(len(self.backend.calls('GET', '/rest/v1/ops_tickets')), 0)
        self.assertIsNone(await self.page.evaluate('session'))

if __name__ == '__main__':
    unittest.main(verbosity=2)
