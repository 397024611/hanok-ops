const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JSDOM, VirtualConsole } = require('jsdom');
const USER = '11111111-1111-4111-8111-111111111111';
const FIRST = '22222222-2222-4222-8222-222222222222';
const SECOND = '33333333-3333-4333-8333-333333333333';
const SESSION = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', user: { id: USER } };
const NOW = '2026-10-08T10:00:00Z';
const stores = [{ id: FIRST, code: 'ONE', name: 'First store', active: true }, { id: SECOND, code: 'TWO', name: 'Second store', active: true }];
const ticket = (store_id = FIRST, extra = {}) => ({ id: 'ticket-' + store_id, store_id, title: store_id === FIRST ? 'FIRST ISSUE' : 'SECOND ISSUE', description: 'Fixture only', category: 'Maintenance', priority: 'normal', status: 'new', ticket_no: 1, created_at: NOW, ...extra });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { const end = Date.now() + 2000; while (!fn()) { if (Date.now() > end) throw new Error('Fixture did not settle'); await sleep(5); } }
async function fixture(t, { role = 'partner', active = true, saved = true } = {}) {
  const b = { role, active, memberships: [FIRST, SECOND], rows: { ops_tickets: [ticket(), ticket(SECOND)], ops_ticket_comments: [], ops_ticket_attachments: [], ops_ticket_events: [], ops_reopen_requests: [] }, calls: [], hooks: [], revoked: [], intervals: [] };
  b.normal = r => {
    if (r.url.pathname === '/auth/v1/token') return response(SESSION);
    if (r.url.pathname === '/auth/v1/logout') return response({});
    if (r.url.pathname.startsWith('/storage/')) return r.method === 'POST' ? response({ Key: 'fixture' }) : new Response('fixture');
    const table = r.url.pathname.split('/').pop();
    if (table === 'ops_profiles') return response([{ user_id: USER, display_name: 'Fixture user', role: b.role, active: b.active, store_id: b.role === 'store' ? b.staffStore || FIRST : null }]);
    if (table === 'ops_stores') return response(stores.filter(s => b.memberships.includes(s.id) && (!r.url.searchParams.has('id') || r.url.searchParams.get('id') === 'eq.' + s.id)));
    assert.ok(b.rows[table], 'Unknown mocked endpoint: ' + r.url.pathname);
    if (r.method === 'POST') {
      if (b.rows[table].some(row => row.id === r.body.id)) return response({ message: 'duplicate' }, 409);
      const row = { ...r.body, created_at: NOW, status: 'new' }; b.rows[table].push(row); return response([row]);
    }
    let rows = b.rows[table];
    for (const key of ['id', 'ticket_id', 'store_id']) if (r.url.searchParams.has(key)) rows = rows.filter(row => row[key] === r.url.searchParams.get(key).slice(3));
    return response(rows);
  };
  const errors = [], vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(fs.readFileSync(path.resolve(__dirname, '../store-portal/index.html'), 'utf8'), {
    url: 'https://portal.test/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = async (input, opts = {}) => { const r = { url: new URL(input), method: opts.method || 'GET', body: typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body, signal: opts.signal }; assert.equal(r.url.origin, 'https://tqfwbsjchespjkxliodo.supabase.co'); b.calls.push(r); for (const hook of b.hooks) { const result = await hook(r); if (result) return result; } return b.normal(r); };
      w.AbortController = AbortController; w.AbortSignal = AbortSignal; w.crypto.randomUUID = randomUUID;
      w.CSS = { escape: s => String(s).replace(/["\\]/g, '\\$&') };
      w.URL.createObjectURL = () => 'blob:fixture-' + randomUUID(); w.URL.revokeObjectURL = url => b.revoked.push(url);
      w.setInterval = fn => { b.intervals.push(fn); return b.intervals.length; }; w.clearInterval = () => {};
      if (saved) w.localStorage.setItem('hanok_store_session', JSON.stringify(SESSION));
    }
  });
  const w = dom.window, d = w.document;
  t.after(() => { w.logout(false); w.close(); assert.deepEqual(errors, []); });
  const a = { w, d, b, value: code => w.eval(code), text: () => d.getElementById('app').textContent, fill(id, value) { const el = d.getElementById(id); el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); }, async ready() { await until(() => d.querySelector('.ticket')); }, async detail(id = ticket().id) { w.detail(id); await until(() => d.getElementById('comments')?.textContent.includes('Comments')); }, count(method, suffix) { return b.calls.filter(r => r.method === method && r.url.pathname.endsWith(suffix)).length; } };
  if (saved && active && ['store', 'partner'].includes(role)) await a.ready();
  return a;
}

test('accounts: shared and independent sign-in use separate identities and clear passwords', async t => {
  const a = await fixture(t, { saved: false, role: 'store' });
  a.fill('pwd', 'do-not-retain'); a.w.setLoginMode('independent'); assert.equal(a.d.getElementById('pwd').value, ''); assert.equal(a.d.getElementById('storeSel'), null);
  a.fill('email', 'staff@example.test'); a.fill('pwd', 'fixture-only'); await Promise.all([a.w.login(), a.w.login()]);
  assert.equal(a.count('POST', '/auth/v1/token'), 1); assert.equal(a.b.calls.find(r => r.method === 'POST').body.email, 'staff@example.test');
  assert.equal(a.d.getElementById('assignedStore'), null); a.w.logout(false); a.w.setLoginMode('shared'); a.fill('pwd', 'fixture-only'); await a.w.login();
  assert.equal(a.b.calls.filter(r => r.url.pathname === '/auth/v1/token').at(-1).body.email, 'store.hwd@hanokops.invalid');
  assert.equal(a.d.getElementById('pwd'), null); assert.ok(a.d.querySelector('.plus'));
});

test('accounts: sign-in mode cannot change underneath an in-flight sign-in', async t => {
  const a = await fixture(t, { saved: false }), started = deferred(), release = deferred();
  a.b.hooks.push(async r => { if (r.url.pathname === '/auth/v1/token') { started.resolve(); await release.promise; } });
  a.fill('pwd', 'fixture-only'); const logging = a.w.login(); await started.promise; a.w.setLoginMode('independent');
  assert.equal(a.value('loginMode'), 'shared'); assert.equal(a.d.getElementById('independentLogin').disabled, true);
  a.w.logout(false); release.resolve(); await logging; assert.equal(a.value('session'), null); assert.ok(a.d.getElementById('pwd'));
});

test('accounts: partner can view/comment but has no create or reopen entry points', async t => {
  const a = await fixture(t); assert.equal(a.d.querySelector('.plus'), null); assert.equal(a.d.getElementById('assignedStore').options.length, 2);
  a.w.newTicket(); assert.equal(a.value('draft'), null); a.b.rows.ops_tickets[0].status = 'completed'; await a.w.loadTickets(); await a.detail();
  assert.equal(a.d.getElementById('reopenButton'), null); a.w.reopenForm(ticket().id); assert.equal(a.value('view.kind'), 'detail');
  a.fill('comment', 'Partner follow-up'); await Promise.all([a.w.comment(), a.w.comment()]); assert.equal(a.count('POST', '/ops_ticket_comments'), 1); assert.equal(a.count('POST', '/ops_tickets'), 0); assert.equal(a.count('POST', '/ops_reopen_requests'), 0);
});

test('accounts: store switch clears detail, comment, draft, attachment state and ignores late response', async t => {
  const a = await fixture(t), started = deferred(), release = deferred();
  a.b.rows.ops_ticket_comments = [{ id: 'comment-first', ticket_id: ticket().id, body: 'PRIVATE FIRST COMMENT' }];
  a.b.hooks.push(async r => { if (r.url.pathname.endsWith('/ops_ticket_comments') && r.url.searchParams.get('ticket_id') === 'eq.' + ticket().id) { started.resolve(); await release.promise; } });
  a.w.detail(ticket().id); await started.promise; a.fill('comment', 'Unsent first-store draft'); a.value('draft={title:"old"};attachmentDrafts.set("old",{file:"private"})');
  await a.w.switchStore(SECOND); assert.equal(a.d.querySelector('[role=dialog]'), null); assert.equal(a.value('draft'), null); assert.equal(a.value('attachmentDrafts.size'), 0);
  release.resolve(); await sleep(20); assert.match(a.text(), /SECOND ISSUE/); assert.doesNotMatch(a.text(), /FIRST ISSUE/); assert.equal(a.d.getElementById('overlay').textContent, '');
  assert.ok(a.b.calls.filter(r => r.url.pathname.endsWith('/ops_tickets')).every(r => r.url.searchParams.has('store_id')));
});

test('accounts: late store list and comment writes cannot repaint another store', async t => {
  const a = await fixture(t), started = deferred(), release = deferred(); let hold = true;
  a.b.hooks.push(async r => { if (hold && r.url.pathname.endsWith('/ops_tickets') && r.url.searchParams.get('store_id') === 'eq.' + FIRST) { hold = false; started.resolve(); await release.promise; return response([ticket(FIRST, { title: 'STALE FIRST' })]); } });
  const old = a.w.loadTickets(); await started.promise; await a.w.switchStore(SECOND); release.resolve(); await old;
  assert.match(a.text(), /SECOND ISSUE/); assert.doesNotMatch(a.text(), /STALE FIRST/); await a.w.switchStore('unknown'); assert.equal(a.value('store.id'), SECOND);
});

for (const role of ['admin', 'hq', 'unknown']) test('accounts: ' + role + ' rejected before operational reads', async t => {
  const a = await fixture(t, { role }); await until(() => a.d.getElementById('err')?.textContent.includes('cannot use'));
  assert.equal(a.value('session'), null); assert.equal(a.count('GET', '/ops_stores'), 0); assert.equal(a.count('GET', '/ops_tickets'), 0); assert.equal(a.w.localStorage.getItem('hanok_store_session'), null);
});

test('accounts: disabled profile is rejected before reading assigned stores', async t => {
  const a = await fixture(t, { active: false }); await until(() => a.d.getElementById('err')?.textContent.includes('inactive'));
  assert.equal(a.value('session'), null); assert.equal(a.count('GET', '/ops_stores'), 0);
});

test('accounts: periodic access check clears disabled account and every operational view', async t => {
  const a = await fixture(t); await a.detail(); a.fill('comment', 'Private draft'); a.value('view.urls.add("blob:old-store");draft={title:"private"}'); a.b.active = false;
  a.b.intervals[0](); await until(() => a.value('session') === null);
  assert.equal(a.d.querySelector('[role=dialog]'), null); assert.equal(a.value('tickets.length'), 0); assert.equal(a.value('draft'), null); assert.deepEqual(a.b.revoked, ['blob:old-store']); assert.doesNotMatch(a.text(), /FIRST ISSUE/);
});

test('accounts: removing selected membership resets to remaining store and removing all signs out', async t => {
  const a = await fixture(t); await a.detail(); a.fill('comment', 'No longer authorized'); a.b.memberships = [SECOND]; await a.w.loadTickets();
  assert.equal(a.value('store.id'), SECOND); assert.equal(a.d.getElementById('assignedStore').options.length, 1); assert.equal(a.d.querySelector('[role=dialog]'), null); assert.match(a.text(), /SECOND ISSUE/); assert.doesNotMatch(a.text(), /FIRST ISSUE/);
  a.b.memberships = []; await a.w.loadTickets(); assert.equal(a.value('session'), null); assert.match(a.d.getElementById('err').textContent, /No active stores/);
});

test('accounts: staff reassignment clears an in-flight creation and prevents attachment continuation', async t => {
  const a = await fixture(t, { role: 'store' }), started = deferred(), release = deferred();
  a.w.newTicket(); a.fill('title', 'Old store draft'); a.value("draft.file=new File(['fixture'],'photo.png',{type:'image/png'})");
  a.b.hooks.push(async r => { if (r.method === 'POST' && r.url.pathname.endsWith('/ops_tickets')) { started.resolve(); await release.promise; } });
  const writing = a.w.createTicket(); await started.promise; a.b.staffStore = SECOND; await a.w.loadTickets(); release.resolve(); await writing;
  assert.equal(a.value('store.id'), SECOND); assert.equal(a.value('draft'), null); assert.equal(a.d.querySelector('[role=dialog]'), null); assert.equal(a.b.calls.filter(r => r.method === 'POST' && r.url.pathname.startsWith('/storage/')).length, 0); assert.doesNotMatch(a.text(), /Old store draft/);
});

test('accounts: follow-up photo retries preserve one storage object and one metadata row', async t => {
  const a = await fixture(t); await a.detail(); let fail = true;
  a.b.hooks.push(r => fail && r.method === 'POST' && r.url.pathname.endsWith('/ops_ticket_attachments') ? response({ message: 'temporary fixture outage' }, 503) : null);
  Object.defineProperty(a.d.getElementById('followupFile'), 'files', { value: [new a.w.File(['fixture'], 'repair.png', { type: 'image/png' })] });
  await Promise.all([a.w.addAttachment(), a.w.addAttachment()]); assert.equal(a.count('POST', '/ops_ticket_attachments'), 1); assert.match(a.d.getElementById('attachmentStatus').textContent, /Retry/);
  a.w.closeOverlay(); await a.detail(); assert.equal(a.d.getElementById('followupFile').disabled, true); fail = false; await a.w.addAttachment();
  assert.equal(a.b.rows.ops_ticket_attachments.length, 1); assert.equal(a.b.calls.filter(r => r.method === 'POST' && r.url.pathname.startsWith('/storage/')).length, 1); assert.equal(a.b.rows.ops_ticket_attachments[0].ticket_id, ticket().id); assert.equal(a.b.rows.ops_ticket_attachments[0].uploaded_by, USER);
});

test('accounts: switching during upload prevents late attachment metadata in another store', async t => {
  const a = await fixture(t); await a.detail(); const started = deferred(), release = deferred();
  Object.defineProperty(a.d.getElementById('followupFile'), 'files', { value: [new a.w.File(['fixture'], 'repair.png', { type: 'image/png' })] });
  a.b.hooks.push(async r => { if (r.method === 'POST' && r.url.pathname.startsWith('/storage/')) { started.resolve(); await release.promise; } });
  const writing = a.w.addAttachment(); await started.promise; await a.w.switchStore(SECOND); release.resolve(); await writing;
  assert.equal(a.count('POST', '/ops_ticket_attachments'), 0); assert.equal(a.value('attachmentDrafts.size'), 0); assert.match(a.text(), /SECOND ISSUE/); assert.equal(a.d.querySelector('[role=dialog]'), null);
});

test('accounts: assigned labels are escaped, and a mis-scoped row never renders', async t => {
  const original = stores[0].name; stores[0].name = '<img src=x onerror=alert(1)>';
  t.after(() => { stores[0].name = original; }); const a = await fixture(t);
  assert.equal(a.d.querySelector('#assignedStore img'), null); assert.equal(a.d.querySelector('.storeName img'), null);
  a.b.hooks.push(r => r.url.pathname.endsWith('/ops_tickets') ? response([ticket(), ticket(SECOND)]) : null); await a.w.loadTickets(); assert.equal(a.d.querySelectorAll('.ticket').length, 1); assert.doesNotMatch(a.text(), /SECOND ISSUE/);
});

test('accounts: assignment revocation clears old rendered data before next store query returns', async t => {
  const a = await fixture(t), started = deferred(), release = deferred();
  a.b.memberships = [SECOND];
  a.b.hooks.push(async r => { if (r.url.pathname.endsWith('/ops_tickets') && r.url.searchParams.get('store_id') === 'eq.' + SECOND) { started.resolve(); await release.promise; } });
  const reading = a.w.loadTickets(); await started.promise;
  assert.doesNotMatch(a.text(), /FIRST ISSUE/); assert.equal(a.d.querySelectorAll('.ticket').length, 0); assert.equal(a.d.getElementById('assignedStore').value, SECOND);
  release.resolve(); await reading; assert.match(a.text(), /SECOND ISSUE/);
});

test('accounts: closing and reopening during photo upload recovers the current controls', async t => {
  const a = await fixture(t); await a.detail(); const started = deferred(), release = deferred();
  Object.defineProperty(a.d.getElementById('followupFile'), 'files', { value: [new a.w.File(['fixture'], 'repair.png', { type: 'image/png' })] });
  a.b.hooks.push(async r => { if (r.method === 'POST' && r.url.pathname.startsWith('/storage/')) { started.resolve(); await release.promise; } });
  const writing = a.w.addAttachment(); await started.promise; a.w.closeOverlay(); await a.detail();
  assert.equal(a.d.getElementById('postAttachment').disabled, true); release.resolve(); await writing;
  assert.equal(a.d.getElementById('postAttachment').disabled, false); assert.equal(a.d.getElementById('followupFile').disabled, false); assert.match(a.d.getElementById('attachmentStatus').textContent, /Attachment added/);
  assert.equal(a.b.rows.ops_ticket_attachments.length, 1);
});

test('accounts: stale access response after sign-out never restores membership or data', async t => {
  const a = await fixture(t), started = deferred(), release = deferred();
  a.b.hooks.push(async r => { if (r.url.pathname.endsWith('/ops_stores')) { started.resolve(); await release.promise; } });
  const reading = a.w.loadTickets(); await started.promise; a.w.logout(false); release.resolve(); await reading;
  assert.equal(a.value('session'), null); assert.equal(a.value('assignedStores.length'), 0); assert.equal(a.value('tickets.length'), 0); assert.equal(a.d.querySelector('.ticket'), null);
});
