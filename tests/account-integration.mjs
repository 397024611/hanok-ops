/**
 * Real Supabase integration. Run only against a disposable Docker-local stack:
 * npm exec --yes --package=supabase@2.120.0 -- node tests/account-integration.mjs
 *
 * Uses the exact checked-in migrations/functions, not mocks. Fixtures exist only
 * in the throwaway containers and this process's memory. Never prints credentials,
 * provider responses, SQL, raw service logs, user identities, or Auth sessions.
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'reportboss-accounts-integration';
const CLI_VERSION = '2.120.0';
const BUCKET = 'ops-ticket-attachments';
const ORIGIN = 'https://baogaolaoban-report.vercel.app';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9kAAAAASUVORK5CYII=', 'base64');
class SafeFailure extends Error {}
function check(condition, message) { if (!condition) throw new SafeFailure(message); }

export function requireLoopback(value, kind) {
  let url;
  try { url = new URL(value); } catch { throw new SafeFailure(`Invalid ${kind} endpoint`); }
  check(['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname), `${kind} endpoint must be loopback`);
  check(!url.search && !url.hash, `${kind} endpoint cannot contain query or fragment`);
  if (kind === 'API') {
    check(url.protocol === 'http:' && url.port === '54321' && url.pathname === '/' && !url.username && !url.password,
      'API endpoint must be the isolated HTTP port');
  } else {
    check(['postgres:', 'postgresql:'].includes(url.protocol) && url.port === '54322' && url.pathname === '/postgres',
      'DB endpoint must be the isolated PostgreSQL port');
  }
  return url;
}

export function rejectRemoteEnvironment(env) {
  for (const key of ['SUPABASE_URL', 'API_URL', 'SUPABASE_DB_URL', 'DB_URL', 'DATABASE_URL']) {
    if (env[key]) requireLoopback(env[key], /DB|DATABASE/.test(key) ? 'DB' : 'API');
  }
  for (const key of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_ID', 'SUPABASE_PROJECT_REF', 'SUPABASE_DB_PASSWORD',
    'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY']) {
    check(!env[key], `External ${key} is forbidden in isolated integration`);
  }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const password = () => `Local-${randomBytes(24).toString('base64url')}!9`;
const email = label => `${label}-${randomUUID()}@example.invalid`;
function sqlString(value) { return `'${String(value).replaceAll("'", "''")}'`; }

async function run() {
  rejectRemoteEnvironment(process.env);
  const work = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'reportboss-account-integration-'));
  const home = path.join(work, 'home');
  const cwd = path.join(work, 'project');
  await mkdir(home, { mode: 0o700 });
  await mkdir(path.join(cwd, 'supabase'), { recursive: true, mode: 0o700 });
  // Never copy local links, .env files, signing keys, or saved Auth state.
  await cp(path.join(ROOT, 'supabase/config.toml'), path.join(cwd, 'supabase/config.toml'));
  await cp(path.join(ROOT, 'supabase/migrations'), path.join(cwd, 'supabase/migrations'), { recursive: true });
  for (const name of ['ops-admin-accounts', 'ops-admin-store-user']) {
    const dest = path.join(cwd, 'supabase/functions', name);
    await mkdir(dest, { recursive: true });
    for (const file of ['index.ts', 'deno.json', ...(name === 'ops-admin-accounts' ? ['handler.mjs'] : [])]) {
      await cp(path.join(ROOT, 'supabase/functions', name, file), path.join(dest, file));
    }
  }
  const env = { ...process.env, HOME: home, DO_NOT_TRACK: '1', SUPABASE_WORKDIR: cwd };
  // Credentials for the test stack are obtained from status in memory only.
  for (const key of Object.keys(env)) if (/^(SUPABASE_|PG|DATABASE_URL$|API_URL$|DB_URL$)/.test(key)) delete env[key];
  env.HOME = home;
  let edge;
  let started = false;
  let checks = 0;
  let stage = 'preflight';
  const pass = label => { checks++; console.log(`PASS ${label}`); };
  const command = (program, args, input, timeout = 180_000) => new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    // Discard all raw stderr: providers/CLI may include credentials in it.
    child.stderr.resume();
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 5_000_000) child.kill('SIGTERM'); });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new SafeFailure(`${stage}: local command timed out`)); }, timeout);
    child.on('error', () => { clearTimeout(timer); reject(new SafeFailure(`${stage}: required local executable unavailable`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new SafeFailure(`${stage}: local command failed (exit ${code})`));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
  const cli = args => command('supabase', ['--workdir', cwd, '--agent', 'no', ...args], undefined, 600_000);
  let status;
  let base;
  const sql = async text => {
    requireLoopback(status.DB_URL, 'DB');
    return command('docker', ['exec', '-i', `supabase_db_${PROJECT}`, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], text);
  };
  async function request(route, { token, method = 'GET', body, headers = {}, service = false, raw = false, noAuth = false } = {}) {
    requireLoopback(base, 'API');
    check(route.startsWith('/') && !route.startsWith('//'), 'Only local relative API routes are allowed');
    const url = new URL(route, base);
    check(url.origin === new URL(base).origin, 'Request attempted to leave local stack');
    const key = service ? status.SERVICE_ROLE_KEY : status.ANON_KEY;
    const outgoing = { apikey: key, ...(!noAuth ? { Authorization: `Bearer ${token || key}` } : {}), ...headers };
    if (body !== undefined && !raw) outgoing['Content-Type'] = 'application/json';
    let response;
    try { response = await fetch(url, { method, headers: outgoing, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
    catch { throw new SafeFailure(`${stage}: local HTTP request failed`); }
    const bytes = Buffer.from(await response.arrayBuffer());
    let data = null;
    try { data = JSON.parse(bytes.toString()); } catch { /* binary Storage responses */ }
    return { status: response.status, ok: response.ok, data, bytes, headers: response.headers };
  }
  const expect = (result, code, label) => {
    check(result.status === code, `${label}: expected HTTP ${code}, received ${result.status}`);
    return result.data;
  };
  const rows = (result, label) => {
    expect(result, 200, label); check(Array.isArray(result.data), `${label}: expected rows`); return result.data;
  };
  const read = (table, token, query = '') => request(`/rest/v1/${table}?select=*${query ? `&${query}` : ''}`, { token });
  const insert = (table, body, token, service = false) => request(`/rest/v1/${table}`, { method: 'POST', body, token, service, headers: { Prefer: 'return=representation' } });
  const update = (table, filter, body, token) => request(`/rest/v1/${table}?${filter}`, { method: 'PATCH', body, token, headers: { Prefer: 'return=representation' } });
  const accounts = (body, token) => request('/functions/v1/ops-admin-accounts', { method: 'POST', body, token, headers: { Origin: ORIGIN } });
  const legacyReset = (storeCode, newPassword, token) => request('/functions/v1/ops-admin-store-user', { method: 'POST', body: { storeCode, password: newPassword }, token, headers: { Origin: ORIGIN } });
  async function login(user, overridePassword) {
    const result = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: user.email, password: overridePassword || user.password } });
    const data = expect(result, 200, 'Password login');
    check(data.user?.id === user.id && typeof data.access_token === 'string', 'Password login retained identity');
    return data.access_token;
  }
  async function authFixture(label, address = email(label), metadata = {}) {
    const user = { email: address, password: password() };
    const data = expect(await request('/auth/v1/admin/users', { service: true, method: 'POST', body: {
      email: user.email, password: user.password, email_confirm: true, user_metadata: { display_name: label, ...metadata },
    } }), 200, 'Create isolated Auth fixture');
    user.id = data.id || data.user?.id;
    check(typeof user.id === 'string', 'Auth fixture identity missing');
    return user;
  }
  const deniedInsert = (result, label) => check([401, 403].includes(result.status), `${label}: expected permission denial, received ${result.status}`);
  const deniedMutation = (result, label) => check([401, 403].includes(result.status) || (result.status === 200 && Array.isArray(result.data) && result.data.length === 0), `${label}: mutation unexpectedly succeeded`);
  const upload = (objectPath, token, upsert = false, bytes = PNG) => request(`/storage/v1/object/${BUCKET}/${objectPath}`, {
    token, method: 'POST', raw: true, body: bytes, headers: { 'Content-Type': 'image/png', 'x-upsert': String(upsert) },
  });
  const download = (objectPath, token) => request(`/storage/v1/object/authenticated/${BUCKET}/${objectPath}`, { token });
  const deniedStorage = (result, label) => check([400, 401, 403, 404].includes(result.status), `${label}: Storage access unexpectedly succeeded`);
  try {
    check((await command('supabase', ['--version'])).trim() === CLI_VERSION, 'Supabase CLI must be pinned to 2.120.0');
    await command('docker', ['info', '--format', '{{.ServerVersion}}']);
    // Refuse to reuse or destroy any existing local stack with this project ID.
    const existing = (await command('docker', ['ps', '-a', '--filter', `name=supabase_db_${PROJECT}`, '--format', '{{.Names}}'])).trim();
    check(!existing, 'An integration stack already exists; refusing to reset it');
    stage = 'start disposable stack';
    started = true;
    await cli(['start', '--exclude', 'realtime,studio,postgres-meta,imgproxy,mailpit,logflare,vector,supavisor']);
    stage = 'reset baseline locally';
    await cli(['db', 'reset', '--local', '--version', '001', '--no-seed', '--yes']);
    stage = 'read local status';
    try { status = JSON.parse(await cli(['status', '--output', 'json'])); }
    catch { throw new SafeFailure('Unable to read local Supabase status safely'); }
    base = requireLoopback(status.API_URL, 'API').origin;
    requireLoopback(status.DB_URL, 'DB');
    check(Boolean(status.ANON_KEY && status.SERVICE_ROLE_KEY), 'Local status did not provide API keys');
    stage = 'seed baseline fixtures';
    const admin = await authFixture('Administrator');
    const hq = await authFixture('Head office');
    const pending = await authFixture('Untrusted metadata', undefined, { role: 'admin', active: true });
    await sql(`update public.ops_profiles set role='admin' where user_id=${sqlString(admin.id)};
      update public.ops_profiles set role='hq' where user_id=${sqlString(hq.id)};`);
    admin.token = await login(admin); hq.token = await login(hq); pending.token = await login(pending);
    const stores = rows(await read('ops_stores', admin.token, 'order=code'), 'Baseline stores');
    check(stores.length === 5, 'Expected all five original stores');
    const shared = [];
    for (const store of stores) {
      const user = await authFixture('Existing shared login', `store.${store.code.toLowerCase()}@hanokops.invalid`);
      await sql(`update public.ops_profiles set role='store',store_id=${sqlString(store.id)} where user_id=${sqlString(user.id)};`);
      user.token = await login(user); user.store = store;
      const ticket = expect(await insert('ops_tickets', { store_id: store.id, created_by: user.id, title: 'Existing completed ticket', status: 'completed', resolution: 'Resolved' }, user.token), 201, 'Seed historical ticket')[0];
      user.ticket = ticket;
      user.photo = `${ticket.id}/historical.png`;
      expect(await upload(user.photo, user.token), 200, 'Seed historical photo');
      expect(await insert('ops_ticket_comments', { ticket_id: ticket.id, author_id: user.id, body: 'Historical comment' }, user.token), 201, 'Seed historical comment');
      expect(await insert('ops_ticket_attachments', { ticket_id: ticket.id, uploaded_by: user.id, storage_path: user.photo, file_name: 'historical.png', mime_type: 'image/png', size_bytes: PNG.length }, user.token), 201, 'Seed historical attachment');
      expect(await insert('ops_reopen_requests', { ticket_id: ticket.id, store_id: store.id, requested_by: user.id, reason: 'Historical request' }, user.token), 201, 'Seed historical reopen request');
      shared.push(user);
    }
    pass('real Auth fixtures and historical data created before migration');
    stage = 'apply account migration locally';
    await cli(['migration', 'up', '--local']);
    await sql("notify pgrst, 'reload schema';");
    stage = 'serve exact Edge entrypoints';
    edge = spawn('supabase', ['--workdir', cwd, '--agent', 'no', 'functions', 'serve'], { cwd, env, stdio: 'ignore' });
    edge.on('error', () => { /* readiness check reports a safe failure */ });
    let ready = false;
    for (let i = 0; i < 90; i++) {
      const result = await accounts({ action: 'list' }, admin.token).catch(() => null);
      if (result?.status === 200) { ready = true; break; }
      if (edge.exitCode !== null) break;
      await pause(1000);
    }
    check(ready, 'Exact account Edge function did not become ready');
    pass('real migration applied and both JWT-verifying Edge functions served');

    stage = 'legacy compatibility';
    for (const user of shared) {
      const profile = rows(await read('ops_profiles', user.token), 'Shared profile')[0];
      check(profile?.user_id === user.id && profile.role === 'store' && profile.active && profile.is_legacy_shared && profile.store_id === user.store.id, 'Migration changed shared identity or binding');
      check(rows(await read('ops_store_memberships', user.token), 'Shared memberships').length === 1, 'Shared membership not backfilled');
      check(rows(await read('ops_tickets', user.token), 'Shared tickets').length === 1, 'Shared ticket scope changed');
      expect(await download(user.photo, user.token), 200, 'Shared historical download');
      const oldPassword = user.password; user.password = password();
      expect(await legacyReset(user.store.code, user.password, admin.token), 200, 'Shared password reset');
      user.token = await login(user);
      check((await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: user.email, password: oldPassword } })).status === 400, 'Shared reset retained old password');
      const after = rows(await read('ops_profiles', user.token), 'Shared profile after reset')[0];
      check(after.user_id === user.id && after.store_id === user.store.id && after.role === 'store' && after.active && after.is_legacy_shared, 'Legacy reset mutated identity or authorization');
      expect(await accounts({ action: 'assign', userId: user.id, storeIds: [stores.find(s => s.id !== user.store.id).id] }, admin.token), 409, 'Shared reassignment blocked');
    }
    check(rows(await read('ops_tickets', hq.token), 'HQ historical tickets').length === 5, 'HQ access regressed');
    for (const user of [hq, pending, ...shared]) expect(await accounts({ action: 'list', actorId: admin.id }, user.token), 403, 'Non-admin account management denied');
    expect(await request('/functions/v1/ops-admin-accounts', { method: 'POST', body: { action: 'list' }, noAuth: true }), 401, 'Gateway rejects missing bearer');
    pass('all five legacy logins reset without changing identity, active state, or store; HQ compatibility');

    stage = 'create individual accounts';
    async function create(role, selected) {
      const user = { email: email(role), password: password() };
      user.create = { action: 'create', requestId: randomUUID(), email: user.email, displayName: `Integration ${role}`, role, storeIds: selected.map(s => s.id), password: user.password };
      const response = await accounts(user.create, admin.token);
      const data = expect(response, 200, `Create ${role} account`);
      check(response.headers.get('cache-control') === 'no-store', 'Account responses must not be cached');
      check(data.ok && data.account.role === role && data.account.active, 'New account did not activate correctly');
      check(JSON.stringify([...data.account.store_ids].sort()) === JSON.stringify(selected.map(s => s.id).sort()), 'Created memberships differ');
      user.id = data.account.user_id; user.token = await login(user);
      const changedPassword = password();
      const retried = expect(await accounts({ ...user.create, password: changedPassword }, admin.token), 200, 'Idempotent completed retry');
      check(retried.account.user_id === user.id && retried.password_unchanged === true, 'Retry changed user identity');
      await login(user);
      check((await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: user.email, password: changedPassword } })).status === 400, 'Retry unexpectedly reset password');
      return user;
    }
    const staff = await create('store', [stores[0]]);
    const partner = await create('partner', stores.slice(0, 2));
    const invalid = { ...staff.create, requestId: randomUUID(), email: email('invalid'), storeIds: stores.slice(0, 2).map(s => s.id) };
    expect(await accounts(invalid, admin.token), 400, 'Staff multi-store creation denied');
    for (const user of [staff, partner]) {
      expect(await accounts({ action: 'list', actorId: admin.id }, user.token), 403, 'Operational users cannot manage accounts');
      deniedInsert(await request('/rest/v1/rpc/ops_admin_accounts_list', { token: user.token, method: 'POST', body: { p_actor_id: admin.id } }), 'Direct management RPC');
      deniedMutation(await update('ops_profiles', `user_id=eq.${user.id}`, { role: 'admin', active: true }, user.token), 'Self role escalation');
    }
    pass('staff/partner creation, real password login, idempotency, and server-owned authorization');

    stage = 'store scope and operations';
    const inTicket = shared[0].ticket, outTicket = shared[2].ticket;
    check(rows(await read('ops_tickets', partner.token), 'Partner initial tickets').length === 2, 'Partner multi-store scope incorrect');
    for (const table of ['ops_tickets', 'ops_ticket_comments', 'ops_ticket_attachments', 'ops_ticket_events', 'ops_reopen_requests']) {
      const filter = table === 'ops_tickets' ? `id=eq.${outTicket.id}` : `ticket_id=eq.${outTicket.id}`;
      check(rows(await read(table, partner.token, filter), `Partner ${table} out-of-store`).length === 0, 'Partner saw out-of-store data');
    }
    deniedInsert(await insert('ops_tickets', { store_id: stores[0].id, created_by: partner.id, title: 'Forbidden partner ticket' }, partner.token), 'Partner ticket write');
    deniedMutation(await update('ops_tickets', `id=eq.${inTicket.id}`, { status: 'new' }, partner.token), 'Partner status write');
    deniedInsert(await insert('ops_ticket_comments', { ticket_id: outTicket.id, author_id: partner.id, body: 'Forbidden' }, partner.token), 'Partner out-of-store comment');
    deniedStorage(await upload(`${outTicket.id}/forbidden.png`, partner.token), 'Partner out-of-store upload');
    deniedStorage(await download(shared[2].photo, partner.token), 'Partner out-of-store download');
    const ticket = expect(await insert('ops_tickets', { store_id: stores[0].id, created_by: staff.id, title: 'Staff submitted ticket', description: 'Real REST submission', reported_by: 'Local fixture', category: 'IT / POS', priority: 'normal' }, staff.token), 201, 'Staff ticket submission')[0];
    staff.ticket = ticket;
    deniedInsert(await insert('ops_tickets', { store_id: stores[2].id, created_by: staff.id, title: 'Forbidden store' }, staff.token), 'Staff out-of-store submission');
    deniedInsert(await insert('ops_tickets', { store_id: stores[0].id, created_by: staff.id, title: 'Forged status', status: 'completed', resolution: 'Forged' }, staff.token), 'Staff workflow forgery');
    for (const user of [staff, partner]) {
      expect(await insert('ops_ticket_comments', { ticket_id: ticket.id, author_id: user.id, body: 'Authorized comment' }, user.token), 201, 'Scoped comment');
      deniedInsert(await insert('ops_ticket_comments', { ticket_id: ticket.id, author_id: admin.id, body: 'Forged author' }, user.token), 'Comment author spoofing');
      user.photo = `${ticket.id}/${user === staff ? 'staff' : 'partner'}.png`;
      expect(await upload(user.photo, user.token), 200, 'Own photo upload');
      expect(await upload(user.photo, user.token, true), 200, 'Own photo x-upsert retry');
      const downloaded = await download(user.photo, user.token);
      expect(downloaded, 200, 'Own photo download'); check(downloaded.bytes.equals(PNG), 'Uploaded photo bytes changed');
      const owner = (await sql(`select owner_id from storage.objects where bucket_id=${sqlString(BUCKET)} and name=${sqlString(user.photo)};`)).trim();
      check(owner === user.id, 'Real Storage API failed owner assignment');
      expect(await insert('ops_ticket_attachments', { ticket_id: ticket.id, uploaded_by: user.id, storage_path: user.photo, file_name: 'photo.png', mime_type: 'image/png', size_bytes: PNG.length }, user.token), 201, 'Photo attachment metadata');
      expect(await insert('ops_push_subscriptions', { user_id: user.id, endpoint: `https://push.example.invalid/${randomUUID()}`, p256dh: 'fabricated-local-fixture', auth_key: 'fabricated-local-fixture' }, user.token), 201, 'Local push fixture');
      // In-memory values only; no push service is contacted.
      await insert('ops_notifications', { recipient_id: user.id, ticket_id: ticket.id, kind: 'new_ticket', title: 'Visible local notification', dedupe_key: randomUUID() }, null, true).then(r => expect(r, 201, 'Local notification fixture'));
      check(rows(await read('ops_notifications', user.token), 'Active own notifications').length === 1, 'Active user notification access missing');
    }
    deniedStorage(await upload(staff.photo, partner.token, true), 'Partner overwriting staff photo');
    deniedStorage(await upload(partner.photo, staff.token, true), 'Staff overwriting partner photo');
    deniedStorage(await upload(shared[0].photo, staff.token, true), 'Staff overwriting legacy photo');
    expect(await download(staff.photo, partner.token), 200, 'Partner reads scoped staff photo');
    expect(await update('ops_tickets', `id=eq.${ticket.id}`, { status: 'completed', resolution: 'HQ verified', completed_by: hq.id }, hq.token), 200, 'HQ workflow remains available');
    const reopen = expect(await insert('ops_reopen_requests', { ticket_id: ticket.id, store_id: stores[0].id, requested_by: staff.id, reason: 'Please review again' }, staff.token), 201, 'Staff reopen request')[0];
    check([200, 204].includes((await request('/rest/v1/rpc/ops_review_reopen_request', { token: hq.token, method: 'POST', body: { p_request_id: reopen.id, p_approve: true } })).status), 'HQ reopen review failed');
    pass('partner scope/write restrictions; staff submission/comment/photo; real Storage owner/upsert and HQ review');

    stage = 'assignment changes with existing JWTs';
    expect(await accounts({ action: 'assign', userId: staff.id, storeIds: [stores[2].id] }, admin.token), 200, 'Reassign staff single store');
    check(rows(await read('ops_tickets', staff.token, `id=eq.${ticket.id}`), 'Staff old store revoked').length === 0, 'Staff existing JWT retained old store');
    check(rows(await read('ops_tickets', staff.token, `id=eq.${outTicket.id}`), 'Staff new store available').length === 1, 'Staff existing JWT missed new store');
    expect(await accounts({ action: 'assign', userId: staff.id, storeIds: [stores[0].id, stores[1].id] }, admin.token), 400, 'Staff multi-store reassignment denied');
    expect(await accounts({ action: 'assign', userId: staff.id, storeIds: [stores[0].id] }, admin.token), 200, 'Restore staff fixture assignment');
    expect(await accounts({ action: 'assign', userId: partner.id, storeIds: [stores[1].id] }, admin.token), 200, 'Partner single-store assignment');
    check(rows(await read('ops_tickets', partner.token), 'Partner reduced scope').length === 1, 'Partner old scope survived assignment');
    deniedStorage(await download(partner.photo, partner.token), 'Partner photo revoked on reassignment');
    expect(await accounts({ action: 'assign', userId: partner.id, storeIds: stores.slice(0, 2).map(s => s.id) }, admin.token), 200, 'Partner multi-store assignment');
    pass('single/multiple-store assignment takes effect on already-issued JWTs');

    stage = 'deactivation using existing JWTs';
    for (const user of [staff, partner]) {
      const oldJWT = user.token;
      expect(await accounts({ action: 'deactivate', userId: user.id }, admin.token), 200, 'Deactivate personal account');
      // Auth still accepts this old JWT; every operations surface must deny it live.
      expect(await request('/auth/v1/user', { token: oldJWT }), 200, 'Old JWT remains cryptographically valid');
      for (const table of ['ops_stores', 'ops_store_memberships', 'ops_tickets', 'ops_ticket_comments', 'ops_ticket_attachments', 'ops_ticket_events', 'ops_reopen_requests', 'ops_notifications', 'ops_push_subscriptions']) {
        check(rows(await read(table, oldJWT), `Inactive ${table}`).length === 0, `Inactive ${table} leaked rows`);
      }
      const profile = rows(await read('ops_profiles', oldJWT), 'Inactive own profile');
      check(profile.length === 1 && profile[0].user_id === user.id && profile[0].active === false, 'Disabled profile state unavailable or leaked others');
      deniedInsert(await insert('ops_tickets', { store_id: stores[0].id, created_by: user.id, title: 'Inactive ticket' }, oldJWT), 'Inactive ticket insert');
      deniedInsert(await insert('ops_ticket_comments', { ticket_id: ticket.id, author_id: user.id, body: 'Inactive comment' }, oldJWT), 'Inactive comment insert');
      deniedInsert(await insert('ops_ticket_attachments', { ticket_id: ticket.id, uploaded_by: user.id, storage_path: `${ticket.id}/disabled.png`, file_name: 'disabled.png' }, oldJWT), 'Inactive attachment insert');
      deniedInsert(await insert('ops_reopen_requests', { ticket_id: inTicket.id, store_id: stores[0].id, requested_by: user.id, reason: 'Inactive request' }, oldJWT), 'Inactive reopen insert');
      deniedInsert(await insert('ops_push_subscriptions', { user_id: user.id, endpoint: 'https://push.example.invalid/disabled', p256dh: 'fixture', auth_key: 'fixture' }, oldJWT), 'Inactive push insert');
      deniedMutation(await update('ops_tickets', `id=eq.${ticket.id}`, { title: 'Disabled mutation' }, oldJWT), 'Inactive ticket update');
      deniedMutation(await update('ops_notifications', `recipient_id=eq.${user.id}`, { read_at: new Date().toISOString() }, oldJWT), 'Inactive notification update');
      deniedStorage(await download(user.photo, oldJWT), 'Inactive photo download');
      deniedStorage(await upload(`${ticket.id}/disabled-${randomUUID()}.png`, oldJWT), 'Inactive photo upload');
      deniedStorage(await upload(user.photo, oldJWT, true), 'Inactive photo upsert');
      const listed = await request(`/storage/v1/object/list/${BUCKET}`, { token: oldJWT, method: 'POST', body: { prefix: ticket.id, limit: 100 } });
      check([400, 401, 403].includes(listed.status) || (listed.status === 200 && listed.data?.length === 0), 'Inactive Storage list exposed files');
      const deleted = await request(`/storage/v1/object/${BUCKET}`, { token: oldJWT, method: 'DELETE', body: { prefixes: [user.photo] } });
      check([400, 401, 403].includes(deleted.status) || (deleted.status === 200 && deleted.data?.length === 0), 'Inactive Storage deletion succeeded');
      expect(await accounts({ action: 'list' }, oldJWT), 403, 'Inactive account Edge access');
      expect(await legacyReset(stores[0].code, password(), oldJWT), 403, 'Inactive legacy Edge access');
      expect(await accounts({ action: 'assign', userId: user.id, storeIds: [stores[0].id] }, admin.token), 409, 'Inactive reassignment blocked');
      const replay = expect(await accounts(user.create, admin.token), 200, 'Completed create retry after deactivation');
      check(replay.account.active === false && replay.account.user_id === user.id, 'Create retry reactivated disabled account');
      expect(await request(`/auth/v1/admin/users/${user.id}`, { service: true }), 200, 'Deactivation preserves Auth identity');
      check((await sql(`select count(*) from public.ops_push_subscriptions where user_id=${sqlString(user.id)};`)).trim() === '0', 'Deactivation failed to remove subscriptions');
      check((await sql(`select count(*) from storage.objects where bucket_id=${sqlString(BUCKET)} and name=${sqlString(user.photo)};`)).trim() === '1', 'Deactivation destroyed historical photo');
    }
    pass('old JWTs blocked across all operations REST tables, mutations, both Edge routes, and Storage; history preserved');

    stage = 'shared identity deactivation and inactive admin';
    const fixed = shared[0];
    expect(await accounts({ action: 'deactivate', userId: fixed.id }, admin.token), 200, 'Deactivate shared fixture');
    expect(await legacyReset(fixed.store.code, password(), admin.token), 409, 'Legacy reset cannot reactivate');
    const fixedProfile = rows(await read('ops_profiles', admin.token, `user_id=eq.${fixed.id}`), 'Disabled shared identity')[0];
    check(fixedProfile.user_id === fixed.id && fixedProfile.store_id === fixed.store.id && fixedProfile.active === false && fixedProfile.is_legacy_shared, 'Legacy reset changed disabled identity');
    await sql(`update public.ops_profiles set active=false where user_id in (${sqlString(admin.id)},${sqlString(hq.id)});`);
    expect(await accounts({ action: 'list' }, admin.token), 403, 'Inactive admin account endpoint');
    expect(await legacyReset(stores[1].code, password(), admin.token), 403, 'Inactive admin legacy endpoint');
    expect(await request('/rest/v1/rpc/ops_review_reopen_request', { token: hq.token, method: 'POST', body: { p_request_id: reopen.id, p_approve: true } }), 400, 'Inactive HQ review RPC');
    check(rows(await read('ops_tickets', admin.token), 'Inactive admin tickets').length === 0, 'Inactive admin retained data access');
    pass('legacy reset cannot create/reactivate/repurpose users; inactive HQ/admin rejected live');
    console.log(`PASS isolated real Supabase integration (${checks} scenario groups)`);
  } finally {
    stage = 'cleanup';
    if (edge && edge.exitCode === null) edge.kill('SIGTERM');
    let cleanupFailed = false;
    if (started) {
      try { await cli(['stop', '--project-id', PROJECT, '--no-backup']); }
      catch { cleanupFailed = true; }
    }
    await rm(work, { recursive: true, force: true });
    check(!cleanupFailed, 'Disposable stack cleanup failed; workflow cleanup must remove remaining containers');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => {
    console.error(`FAIL ${error instanceof SafeFailure ? error.message : 'Unexpected harness error; raw diagnostics suppressed for credential safety'}`);
    process.exitCode = 1;
  });
}
