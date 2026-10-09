// Kept runtime-independent so the exact request handler is exercised by node:test.
export const ALLOWED_ORIGINS = new Set([
  'https://hanokops.local',
  'https://baogaolaoban-report.vercel.app',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 16_384;
class ApiError extends Error {
  constructor(code, status = 400, retryable = false) { super(code); this.status = status; this.retryable = retryable; }
}
const KNOWN_ERRORS = {
  admin_required: 403, invalid_role: 400, invalid_stores: 400, invalid_account: 400,
  request_conflict: 409, email_reserved: 409, email_exists: 409, account_not_pending: 409,
  account_not_found: 404, account_protected: 403, account_inactive: 409, shared_store_fixed: 409,
  invalid_request_id: 400, invalid_store_name: 400, invalid_store_code: 400, store_code_exists: 409,
};
function uuid(value) { return typeof value === 'string' && UUID.test(value); }
function storeIds(value, role) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 || !value.every(uuid)
    || new Set(value.map(id => id.toLowerCase())).size !== value.length
    || (role === 'store' && value.length !== 1)) throw new ApiError('invalid_stores');
  return value.map(id => id.toLowerCase()).sort();
}
export function validatePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('invalid_payload');
  const { action } = value;
  if (action === 'list') return { action };
  if (action === 'create_store') {
    if (!uuid(value.requestId)) throw new ApiError('invalid_request_id');
    if (typeof value.name !== 'string' || Array.from(value.name.trim()).length < 1
      || Array.from(value.name.trim()).length > 100 || /[\u0000\uD800-\uDFFF]/u.test(value.name)) throw new ApiError('invalid_store_name');
    if (typeof value.code !== 'string' || !/^[A-Za-z0-9]{2,8}$/.test(value.code.trim())) throw new ApiError('invalid_store_code');
    return { action, requestId: value.requestId.toLowerCase(), name: value.name.trim(), code: value.code.trim().toUpperCase() };
  }
  if (action === 'deactivate' || action === 'assign') {
    if (!uuid(value.userId)) throw new ApiError('invalid_user');
    return { action, userId: value.userId.toLowerCase(), ...(action === 'assign' ? { storeIds: storeIds(value.storeIds) } : {}) };
  }
  if (action !== 'create') throw new ApiError('invalid_action');
  if (!uuid(value.requestId)) throw new ApiError('invalid_request_id');
  if (value.role !== 'store' && value.role !== 'partner') throw new ApiError('invalid_role');
  if (typeof value.email !== 'string' || value.email.trim().length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email.trim())) throw new ApiError('invalid_email');
  if (typeof value.displayName !== 'string' || !value.displayName.trim() || value.displayName.trim().length > 100) throw new ApiError('invalid_display_name');
  if (typeof value.password !== 'string' || Array.from(value.password).length < 12 || new TextEncoder().encode(value.password).byteLength > 72) throw new ApiError('invalid_password');
  return { action, requestId: value.requestId.toLowerCase(), email: value.email.trim().toLowerCase(),
    displayName: value.displayName.trim(), role: value.role, storeIds: storeIds(value.storeIds, value.role), password: value.password };
}
async function readPayload(req) {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiError('json_required', 415);
  if (Number(req.headers.get('content-length')) > MAX_BODY_BYTES) throw new ApiError('payload_too_large', 413);
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError('invalid_json');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new ApiError('payload_too_large', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return validatePayload(JSON.parse(new TextDecoder().decode(bytes))); }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('invalid_json'); }
}
async function rpc(admin, name, args) {
  const { data, error } = await admin.rpc(name, args);
  if (error) {
    const code = Object.keys(KNOWN_ERRORS).find(code => error.message === code);
    if (code) throw new ApiError(code, KNOWN_ERRORS[code]);
    throw new ApiError('database_unavailable', 503, true);
  }
  return data;
}
export function createAccountHandler({ createClient, env }) {
  return async function handle(req) {
    const origin = req.headers.get('origin');
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    if (origin && ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: 'origin_not_allowed' }, 403);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.get('authorization') || '');
    if (!match) return json({ error: 'unauthorized' }, 401);
    try {
      const url = env('SUPABASE_URL'), anonKey = env('SUPABASE_ANON_KEY'), serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
      if (!url || !anonKey || !serviceKey) throw new ApiError('server_configuration', 503);
      const caller = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${match[1]}` } } });
      const { data: identity, error: authError } = await caller.auth.getUser(match[1]);
      if (authError || !identity?.user?.id) throw new ApiError('unauthorized', 401);
      const actorId = identity.user.id;
      const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data: profile, error: profileError } = await admin.from('ops_profiles').select('role,active').eq('user_id', actorId).maybeSingle();
      if (profileError) throw new ApiError('database_unavailable', 503, true);
      if (profile?.role !== 'admin' || profile?.active !== true) throw new ApiError('admin_required', 403);
      const payload = await readPayload(req);
      if (payload.action === 'list') return json(await rpc(admin, 'ops_admin_accounts_list', { p_actor_id: actorId }));
      if (payload.action === 'create_store') {
        const store = await rpc(admin, 'ops_admin_stores_create', {
          p_actor_id: actorId, p_request_id: payload.requestId, p_name: payload.name, p_code: payload.code,
        });
        return json({ ok: true, request_id: payload.requestId, store });
      }
      if (payload.action === 'assign' || payload.action === 'deactivate') {
        if (payload.userId === actorId) throw new ApiError('account_protected', 403);
        const account = await rpc(admin, `ops_admin_accounts_${payload.action}`, {
          p_actor_id: actorId, p_user_id: payload.userId,
          ...(payload.action === 'assign' ? { p_store_ids: payload.storeIds } : {}),
        });
        return json({ ok: true, account });
      }
      const reservationArgs = { p_actor_id: actorId, p_request_id: payload.requestId, p_email: payload.email,
        p_display_name: payload.displayName, p_role: payload.role, p_store_ids: payload.storeIds };
      let reservation = await rpc(admin, 'ops_admin_accounts_reserve', reservationArgs);
      if (reservation.complete) return json({ ok: true, account: reservation.account, password_unchanged: true });
      const canonicalRequestId = reservation.request_id || payload.requestId;
      let userId = reservation.user_id;
      let passwordUnchanged = Boolean(userId);
      if (!userId) {
        // Never update an existing Auth user, reset its password, or trust user_metadata for roles.
        const { data, error } = await admin.auth.admin.createUser({ email: payload.email, password: payload.password,
          email_confirm: true, user_metadata: { display_name: payload.displayName },
          app_metadata: { ops_account_request_id: canonicalRequestId } });
        if (error || !data?.user?.id) {
          // Handles concurrent retries and a lost successful Auth response without overwriting credentials.
          reservation = await rpc(admin, 'ops_admin_accounts_reserve', reservationArgs);
          if (reservation.complete) return json({ ok: true, account: reservation.account, password_unchanged: true });
          userId = reservation.user_id;
          passwordUnchanged = Boolean(userId);
          if (!userId) {
            if (error?.code === 'weak_password') throw new ApiError('password_rejected');
            throw new ApiError('account_creation_incomplete', 503, true);
          }
        } else userId = data.user.id;
      }
      const account = await rpc(admin, 'ops_admin_accounts_finalize', { p_actor_id: actorId, p_request_id: canonicalRequestId, p_user_id: userId });
      return json({ ok: true, account, password_unchanged: passwordUnchanged });
    } catch (error) {
      // Deliberately do not log request bodies, provider error strings, tokens, or passwords.
      if (error instanceof ApiError) return json({ error: error.message, ...(error.retryable ? { retryable: true } : {}) }, error.status);
      return json({ error: 'service_unavailable', retryable: true }, 503);
    }
  };
}
