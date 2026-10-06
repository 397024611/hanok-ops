const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { randomUUID } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const USER = '11111111-1111-4111-8111-111111111111';
const STORE = '22222222-2222-4222-8222-222222222222';
const SESSION = { access_token: 'test-access', refresh_token: 'test-refresh', user: { id: USER } };
const NOW = '2026-10-05T10:00:00Z';
const ticket = (id = '33333333-3333-4333-8333-333333333333', extra = {}) => ({ id, store_id: STORE, title: 'Broken fridge', description: 'Needs repair', reported_by: 'Sam', ticket_no: 1, category: 'Maintenance', priority: 'normal', status: 'new', created_at: NOW, updated_at: NOW, ...extra });
const response = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(condition, message = 'condition', timeout = 2000) { const end = Date.now() + timeout; while (!condition()) { if (Date.now() > end) throw new Error('Timed out: ' + message); await sleep(5); } }

async function fixture(t, { admin = false, saved = SESSION, rows = {}, role = 'store', hook = null } = {}) {
  const backend = {
    rows: { ops_tickets: [ticket()], ops_ticket_comments: [], ops_ticket_events: [], ops_ticket_attachments: [], ops_reopen_requests: [], ...rows },
    calls: [], hooks: hook ? [hook] : [], role, refreshes: 0, revoked: [],
    count(method, endpoint) { return this.calls.filter(c => c.method === method && c.url.pathname === endpoint).length; },
    async fetch(input, opts = {}) {
      const url = new URL(input), method = opts.method || 'GET';
      assert.equal(url.origin, 'https://tqfwbsjchespjkxliodo.supabase.co', 'Only the mocked existing backend is reachable');
      const req = { url, method, body: typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body, headers: opts.headers || {}, signal: opts.signal };
      this.calls.push(req);
      for (const h of this.hooks) { const result = await h(req, this); if (result) return result; }
      return this.normal(req);
    },
    normal(req) {
      const { url, method, body } = req;
      if (url.pathname === '/auth/v1/token') { if (url.searchParams.get('grant_type') === 'refresh_token') { this.refreshes++; return response({ ...SESSION, access_token: 'fresh-access', refresh_token: 'fresh-refresh' }); } return response(SESSION); }
      if (url.pathname === '/auth/v1/logout') return response({});
      if (url.pathname === '/functions/v1/ops-admin-store-user') return response({ ok: true, username: 'Hanok Woden' });
      if (url.pathname.startsWith('/storage/')) return method === 'POST' ? response({ Key: 'fixture' }) : new Response('fixture bytes');
      const table = url.pathname.split('/').pop();
      if (table === 'ops_profiles') return response([{ user_id: USER, role: this.role, display_name: 'Test', store_id: STORE }]);
      if (table === 'ops_stores') return response([{ id: STORE, code: 'HWD', name: 'Hanok Woden', active: true }]);
      assert.ok(this.rows[table], 'Expected mocked table: ' + table);
      if (method === 'POST') {
        if (this.rows[table].some(r => r.id === body.id)) return response({ code: '23505', message: 'duplicate' }, 409);
        if (table === 'ops_reopen_requests' && this.rows[table].some(r => r.ticket_id === body.ticket_id && r.status === 'pending')) return response({ code: '23505', message: 'pending request' }, 409);
        const row = { created_at: NOW, updated_at: NOW, ...body };
        if (table === 'ops_tickets') Object.assign(row, { status: 'new', ticket_no: this.rows[table].length + 1 });
        if (table === 'ops_reopen_requests') row.status = 'pending';
        this.rows[table].push(row); return response([row]);
      }
      let list = this.rows[table];
      for (const key of ['id', 'ticket_id', 'store_id']) if (url.searchParams.has(key)) list = list.filter(r => r[key] === url.searchParams.get(key).slice(3));
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || list.length);
      return response(list.slice(offset, offset + limit));
    }
  };
  const errors = [], vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'store-portal', admin ? 'admin.html' : 'index.html'), 'utf8'), {
    url: 'https://portal.test/' + (admin ? 'admin.html' : ''), runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = backend.fetch.bind(backend); w.AbortController = AbortController; w.AbortSignal = AbortSignal;
      w.CSS = { escape: s => String(s).replace(/["\\]/g, '\\$&') };
      w.crypto.randomUUID = randomUUID; w.URL.createObjectURL = () => 'blob:https://portal.test/' + randomUUID(); w.URL.revokeObjectURL = u => backend.revoked.push(u);
      if (saved !== null) w.localStorage.setItem('hanok_store_session', typeof saved === 'string' ? saved : JSON.stringify(saved));
      // Timer callbacks are tested explicitly; do not allow wall-clock polling in unit tests.
      w.setInterval = () => 1; w.clearInterval = () => {};
    }
  });
  const w = dom.window, doc = w.document;
  t.after(() => { dom.window.close(); assert.deepEqual(errors, [], 'No uncaught DOM errors'); });
  const app = { w, doc, backend, evaluate: code => w.eval(code), text: id => doc.getElementById(id)?.textContent || '', fill(id, value) { const el = doc.getElementById(id); assert.ok(el, id); el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); }, async ready() { await until(() => doc.querySelector('.ticket') || (backend.rows.ops_tickets.length === 0 && doc.querySelector('.plus')), 'ticket list'); }, newIssue() { w.newTicket(); this.fill('title', 'Leaking pipe'); this.fill('desc', 'Water by sink'); }, async details(id = ticket().id) { w.detail(id); await until(() => this.text('comments').includes('Comments'), 'detail data'); } };
  if (!admin && saved && typeof saved !== 'string') await app.ready();
  return app;
}

test('store: corrupt saved session and associated labels do not crash', async t => {
  const a = await fixture(t, { saved: '{bad' }); assert.ok(a.doc.getElementById('pwd'));
  for (const id of ['storeSel', 'pwd']) assert.ok(a.doc.querySelector('label[for="' + id + '"]'));
  a.fill('pwd', 'fake-password'); a.doc.querySelector('form').dispatchEvent(new a.w.Event('submit', { bubbles: true, cancelable: true }));
  await a.ready(); assert.equal(a.backend.count('POST', '/auth/v1/token'), 1);
  a.newIssue(); assert.equal(a.doc.getElementById('overlay').getAttribute('role'), 'dialog');
  a.w.dispatchEvent(new a.w.KeyboardEvent('keydown', { key: 'Escape' })); assert.equal(a.doc.querySelector('[role=dialog]'), null);
});

test('store: duplicate submit and partial attachment metadata failure retry one ticket/object', async t => {
  const a = await fixture(t); let fail = true;
  a.backend.hooks.push(req => req.method === 'POST' && req.url.pathname.endsWith('ops_ticket_attachments') && fail ? response({ message: 'metadata unavailable' }, 503) : null);
  a.newIssue(); a.evaluate("draft.file = new File(['fixture'], 'photo.png', {type:'image/png'})");
  await Promise.all([a.w.createTicket(), a.w.createTicket()]);
  assert.equal(a.backend.count('POST', '/rest/v1/ops_tickets'), 1); assert.match(a.text('submitStatus'), /Ticket sent to HQ/);
  assert.equal(a.text('submitTicket'), 'Retry attachment'); fail = false;
  await a.w.createTicket(); assert.equal(a.backend.rows.ops_tickets.length, 2); assert.equal(a.backend.rows.ops_ticket_attachments.length, 1);
  assert.equal(a.backend.calls.filter(r => r.method === 'POST' && r.url.pathname.startsWith('/storage/')).length, 1);
  assert.equal(a.doc.querySelector('[role=dialog]'), null);
});

test('store: lost creation response reconciles server-committed stable client ID', async t => {
  const a = await fixture(t); a.backend.hooks.push((req, b) => { if (req.method === 'POST' && req.url.pathname.endsWith('ops_tickets')) { b.normal(req); throw new TypeError('network response lost'); } });
  a.newIssue(); await a.w.createTicket(); assert.equal(a.backend.rows.ops_tickets.length, 2); assert.equal(a.doc.querySelector('[role=dialog]'), null);
});

test('store: failed creation retains same ID and immutable payload on retry', async t => {
  const a = await fixture(t); let fail = true;
  a.backend.hooks.push(req => req.method === 'POST' && req.url.pathname.endsWith('ops_tickets') && fail ? response({ message: 'offline' }, 503) : null);
  a.newIssue(); await a.w.createTicket(); const id = a.evaluate('draft.id'); a.w.closeOverlay(); a.w.newTicket(); assert.equal(a.evaluate('draft.id'), id);
  assert.equal(a.doc.getElementById('title').value, 'Leaking pipe'); fail = false; await a.w.createTicket();
  assert.equal(a.backend.rows.ops_tickets[1].id, id); assert.equal(a.backend.rows.ops_tickets.length, 2);
});

test('store: file validation prevents ticket creation before unsupported upload', async t => {
  const a = await fixture(t); a.newIssue(); a.evaluate("draft.file = new File(['fixture'], 'document.txt', {type:'text/plain'})"); await a.w.createTicket();
  assert.equal(a.backend.count('POST', '/rest/v1/ops_tickets'), 0); assert.match(a.text('toast'), /photo or video/);
});

test('store: closing in-flight creation preserves captured fields and stays closed', async t => {
  const a = await fixture(t), started = deferred(), release = deferred();
  a.backend.hooks.push(async req => { if (req.method === 'POST' && req.url.pathname.endsWith('ops_tickets')) { started.resolve(); await release.promise; } });
  a.newIssue(); const writing = a.w.createTicket(); await started.promise; a.w.closeOverlay(); release.resolve(); await writing;
  assert.equal(a.doc.querySelector('[role=dialog]'), null); assert.equal(a.backend.rows.ops_tickets[1].description, 'Water by sink');
});

test('store: slower older ticket reads cannot overwrite newer detail', async t => {
  const second = ticket('44444444-4444-4444-8444-444444444444', { title: 'Router offline' });
  const a = await fixture(t, { rows: { ops_tickets: [ticket(), second], ops_ticket_comments: [{ id: 'c1', ticket_id: ticket().id, body: 'FIRST ONLY', created_at: NOW }, { id: 'c2', ticket_id: second.id, body: 'SECOND ONLY', created_at: NOW }] } });
  const started = deferred(), release = deferred();
  a.backend.hooks.push(async req => { if (req.url.pathname.endsWith('ops_ticket_comments') && req.url.searchParams.get('ticket_id') === 'eq.' + ticket().id) { started.resolve(); await release.promise; } });
  a.w.detail(ticket().id); await started.promise; a.w.closeOverlay(); await a.details(second.id); release.resolve(); await sleep(20);
  assert.match(a.text('comments'), /SECOND ONLY/); assert.doesNotMatch(a.text('overlay'), /FIRST ONLY/);
});

test('store: closing a comment mutation prevents surprise navigation and double submit', async t => {
  const a = await fixture(t); await a.details(); a.fill('comment', 'Check tomorrow'); const started = deferred(), release = deferred();
  a.backend.hooks.push(async req => { if (req.method === 'POST' && req.url.pathname.endsWith('ops_ticket_comments')) { started.resolve(); await release.promise; } });
  const first = a.w.comment(), second = a.w.comment(); await started.promise; a.w.closeOverlay(); release.resolve(); await Promise.all([first, second]);
  assert.equal(a.backend.rows.ops_ticket_comments.length, 1); assert.equal(a.doc.querySelector('[role=dialog]'), null);
});

test('store: concurrent expired requests share one refresh', async t => {
  const a = await fixture(t); a.backend.hooks.push(req => req.url.pathname.endsWith('ops_tickets') && req.headers.Authorization === 'Bearer test-access' ? response({ message: 'expired' }, 401) : null);
  await Promise.all([a.w.api('/rest/v1/ops_tickets'), a.w.api('/rest/v1/ops_tickets'), a.w.api('/rest/v1/ops_tickets')]);
  assert.equal(a.backend.refreshes, 1); assert.equal(a.evaluate('session.access_token'), 'fresh-access');
});

test('store: repeated 401 is bounded and fully logs out', async t => {
  const a = await fixture(t); await a.details(); const before = a.backend.count('GET', '/rest/v1/ops_tickets');
  a.backend.hooks.push(req => req.url.pathname.endsWith('ops_tickets') ? response({ message: 'expired' }, 401) : null);
  await assert.rejects(a.w.api('/rest/v1/ops_tickets'));
  assert.equal(a.backend.refreshes, 1); assert.equal(a.backend.count('GET', '/rest/v1/ops_tickets') - before, 2);
  assert.equal(a.evaluate('session'), null); assert.equal(a.w.localStorage.getItem('hanok_store_session'), null); assert.equal(a.doc.querySelector('[role=dialog]'), null); assert.equal(a.doc.getElementById('app').inert, false);
});

test('store: logout while refresh response is pending cannot resurrect auth', async t => {
  const a = await fixture(t), started = deferred(), release = deferred();
  a.backend.hooks.push(async req => { if (req.url.pathname === '/auth/v1/token') { started.resolve(); await release.promise; } });
  const refresh = a.w.refresh().catch(e => e); await started.promise; a.w.logout(); release.resolve(); await refresh;
  assert.equal(a.evaluate('session'), null); assert.equal(a.w.localStorage.getItem('hanok_store_session'), null); assert.ok(a.doc.getElementById('pwd'));
});

test('store: transient refresh failure preserves existing session for retry', async t => {
  const a = await fixture(t); a.backend.hooks.push(req => req.url.pathname === '/auth/v1/token' ? response({ message: 'temporary' }, 503) : null);
  await assert.rejects(a.w.refresh()); assert.equal(a.evaluate('session.access_token'), 'test-access');
  a.backend.hooks.length = 0; await a.w.refresh(); assert.equal(a.evaluate('session.access_token'), 'fresh-access');
});

test('store: list request ordering rejects older snapshot after newer refresh', async t => {
  const a = await fixture(t), started = deferred(), release = deferred(); let once = true;
  a.backend.hooks.push(async req => { if (req.url.pathname.endsWith('ops_tickets') && once) { once = false; started.resolve(); await release.promise; return response([ticket(undefined, { title: 'OLD SNAPSHOT' })]); } });
  const old = a.w.loadTickets(); await started.promise; a.backend.rows.ops_tickets[0].title = 'LATEST SNAPSHOT'; await a.w.loadTickets(); release.resolve(); await old;
  assert.match(a.doc.querySelector('.ticket').textContent, /LATEST SNAPSHOT/);
});

test('store: progress, resolution and reopen reviews update without losing comment draft', async t => {
  const a = await fixture(t); await a.details(); a.fill('comment', 'Unsent update');
  Object.assign(a.backend.rows.ops_tickets[0], { status: 'completed', resolution: 'Repaired' }); await a.w.loadTickets();
  await until(() => a.doc.getElementById('reopenButton')); assert.match(a.text('ticketSummary'), /Repaired/); assert.equal(a.doc.getElementById('comment').value, 'Unsent update');
  a.doc.getElementById('reopenButton').click(); a.fill('reopenReason', 'Still leaking'); await Promise.all([a.w.requestReopen(), a.w.requestReopen()]);
  await until(() => a.text('reopenWrap').includes('Reopen requested')); assert.equal(a.backend.rows.ops_reopen_requests.length, 1);
  Object.assign(a.backend.rows.ops_reopen_requests[0], { status: 'rejected', reviewed_at: NOW }); await a.w.loadTickets();
  await until(() => a.text('reopenWrap').includes('Reopen rejected'));
});

test('store: one failed detail section does not hide other successful sections', async t => {
  const a = await fixture(t); a.backend.hooks.push(req => req.url.pathname.endsWith('ops_ticket_events') ? response({ message: 'offline' }, 503) : null);
  await a.details(); await until(() => a.text('events').includes('Could not load timeline'));
  assert.match(a.text('comments'), /No comments yet/); assert.match(a.text('attachments'), /No attachments/);
});

test('store: pagination reads beyond 150 with store filter and retains data on network errors', async t => {
  const all = Array.from({ length: 151 }, (_, i) => ticket(String(i)));
  const a = await fixture(t, { rows: { ops_tickets: all } }); await until(() => a.doc.querySelectorAll('.ticket').length === 151);
  const calls = a.backend.calls.filter(r => r.url.pathname.endsWith('ops_tickets'));
  assert.deepEqual(calls.map(r => r.url.searchParams.get('offset')), ['0', '150']); assert.ok(calls.every(r => r.url.searchParams.get('store_id') === 'eq.' + STORE));
  a.backend.hooks.push(req => req.url.pathname.endsWith('ops_tickets') ? response({ message: 'offline' }, 503) : null); await a.w.loadTickets();
  assert.match(a.doc.querySelector('.sync').textContent, /Refresh failed/); assert.equal(a.doc.querySelectorAll('.ticket').length, 151);
});

test('store: authenticated media retry refreshes once and blob URLs are revoked on close', async t => {
  const attachment = { id: 'a', ticket_id: ticket().id, storage_path: ticket().id + '/clip.mp4', file_name: 'repair.mp4', mime_type: 'video/mp4', created_at: NOW };
  const a = await fixture(t, { rows: { ops_ticket_attachments: [attachment] } });
  a.backend.hooks.push(req => req.url.pathname.startsWith('/storage/') && req.headers.Authorization === 'Bearer test-access' ? response({ message: 'expired' }, 401) : null);
  await a.details(); await until(() => a.doc.querySelector('video[controls]')); assert.equal(a.backend.refreshes, 1); a.w.closeOverlay(); assert.equal(a.backend.revoked.length, 1);
});

test('store: HTML from backend is escaped and ticket cards are keyboard buttons', async t => {
  const a = await fixture(t, { rows: { ops_tickets: [ticket(undefined, { title: '<img src=x onerror=alert(1)>', status: '<svg/onload=alert(1)>' })] } });
  assert.equal(a.doc.querySelector('.ticket').tagName, 'BUTTON'); assert.equal(a.doc.querySelector('.ticket img'), null); assert.equal(a.doc.querySelector('.ticket svg'), null);
});

async function adminLogin(t) {
  const a = await fixture(t, { admin: true, saved: null, role: 'admin' }); a.fill('email', 'admin@example.test'); a.fill('pass', 'fake-password'); await a.w.signIn(); assert.equal(a.doc.getElementById('panel').style.display, 'block'); return a;
}
test('admin: no shared password, duplicate actions blocked and credentials cleared', async t => {
  const a = await adminLogin(t); assert.equal(a.doc.getElementById('pass').value, ''); assert.equal(a.doc.getElementById('storePass').value, '');
  a.fill('storePass', 'unique-test-password'); await Promise.all([a.w.saveStore(), a.w.saveStore()]);
  assert.equal(a.backend.count('POST', '/functions/v1/ops-admin-store-user'), 1); assert.match(a.text('out'), /is ready/); assert.equal(a.doc.getElementById('storePass').value, '');
  a.w.logout(); assert.equal(a.evaluate('session'), null); assert.equal(a.text('out'), '');
});

test('admin: logout during save cannot restore response or password', async t => {
  const a = await adminLogin(t), started = deferred(), release = deferred();
  a.backend.hooks.push(async req => { if (req.url.pathname === '/functions/v1/ops-admin-store-user') { started.resolve(); await release.promise; } });
  a.fill('storePass', 'unique-test-password'); const saving = a.w.saveStore(); await started.promise; a.w.logout(); release.resolve(); await saving;
  assert.equal(a.doc.getElementById('panel').style.display, 'none'); assert.equal(a.text('out'), ''); assert.equal(a.doc.getElementById('storePass').value, '');
});

test('admin: non-admin profile fails closed without keeping session', async t => {
  const a = await fixture(t, { admin: true, saved: null }); a.fill('email', 'store@example.test'); a.fill('pass', 'fake-password'); await a.w.signIn();
  assert.match(a.text('loginOut'), /not an Admin/); assert.equal(a.evaluate('session'), null); assert.equal(a.doc.getElementById('pass').value, '');
});

test('admin: authorization refresh is bounded and concurrent saves are single-flight', async t => {
  const a = await adminLogin(t); a.backend.hooks.push(req => req.url.pathname === '/functions/v1/ops-admin-store-user' && req.headers.Authorization === 'Bearer test-access' ? response({ message: 'expired' }, 401) : null);
  a.fill('storePass', 'unique-test-password'); await a.w.saveStore(); assert.equal(a.backend.refreshes, 1); assert.match(a.text('out'), /is ready/);
});

test('admin: success-looking but unconfirmed server response never reports ready', async t => {
  const a = await adminLogin(t); a.backend.hooks.push(req => req.url.pathname === '/functions/v1/ops-admin-store-user' ? response({ username: 'Store' }) : null);
  a.fill('storePass', 'unique-test-password'); await a.w.saveStore(); assert.match(a.text('out'), /Could not confirm/); assert.equal(a.doc.getElementById('storePass').value, 'unique-test-password');
});

test('store: SVG uploads are rejected before ticket or storage mutation', async t => {
  const a = await fixture(t); a.newIssue(); a.evaluate("draft.file = new File(['<svg></svg>'], 'unsafe.svg', {type:'image/svg+xml'})"); await a.w.createTicket();
  assert.equal(a.backend.count('POST', '/rest/v1/ops_tickets'), 0); assert.match(a.text('toast'), /SVG files are not supported/);
});

test('store: legacy image previews expand inline without blob document navigation', async t => {
  const attachment = { id: 'a', ticket_id: ticket().id, storage_path: ticket().id + '/legacy.svg', file_name: 'legacy.svg', mime_type: 'image/svg+xml', created_at: NOW };
  const a = await fixture(t, { rows: { ops_ticket_attachments: [attachment] } }); await a.details(); await until(() => a.doc.querySelector('#attachments img'));
  assert.equal(a.doc.querySelector('#attachments a'), null); assert.equal(a.doc.querySelector('[target="_blank"]'), null);
  const button = a.doc.querySelector('#attachments button'); button.click(); assert.equal(button.getAttribute('aria-expanded'), 'true'); button.click(); assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('store: temporary startup outage offers retry without discarding session', async t => {
  let fail = true;
  const a = await fixture(t, { saved: JSON.stringify(SESSION), hook: req => req.url.pathname.endsWith('ops_profiles') && fail ? response({message:'Temporary outage'}, 503) : null });
  await until(() => a.doc.body.textContent.includes('Retry connection')); assert.equal(a.evaluate('session.access_token'), 'test-access');
  fail = false; await a.w.boot(); await a.ready(); assert.equal(a.doc.querySelectorAll('.ticket').length, 1);
});
