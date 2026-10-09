const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const root = path.resolve(__dirname, '..');
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const migrations = path.join(root, 'supabase/migrations');
const createSQL = 'select public.ops_admin_stores_create($1,$2,$3,$4) result';
const unchangedTables = ['auth.users', 'public.ops_profiles', 'public.ops_store_memberships', 'public.ops_tickets',
  'public.ops_ticket_comments', 'public.ops_ticket_attachments', 'public.ops_ticket_events', 'public.ops_notifications',
  'public.ops_reopen_requests', 'public.ops_push_subscriptions', 'storage.objects', 'ops_private.account_create_requests'];
async function snapshot(db, tables) {
  const result = {};
  for (const table of tables) result[table] = (await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from ${table} t`)).rows[0].rows;
  return result;
}
async function fixture(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema cron;
    create table auth.users(id uuid primary key,email text unique,raw_user_meta_data jsonb default '{}'::jsonb,raw_app_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner_id text);
    alter table storage.objects enable row level security;
    grant select,insert,update,delete on storage.objects to authenticated;
    create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
    create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
  `);
  const baseline = fs.readFileSync(path.join(migrations, '001_initial_hanok_ops.sql'), 'utf8')
    .replace('create extension if not exists pg_cron;', '-- Only the external cron scheduler is stubbed.');
  await db.exec(baseline);
  const stores = (await db.query('select * from ops_stores order by code')).rows;
  for (const n of [1, 2, 3, 4, 5, 6, 7]) await db.query('insert into auth.users(id,email) values($1,$2)', [uid(n), `fixture${n}@example.invalid`]);
  await db.query("update ops_profiles set role='admin' where user_id=any($1)", [[uid(1),uid(3),uid(4)]]);
  await db.query("update ops_profiles set role='hq' where user_id=$1", [uid(2)]);
  for (let i=0; i<5; i++) {
    const id=uid(10+i), store=stores[i], ticket=uid(100+i);
    await db.query('insert into auth.users(id,email) values($1,$2)',[id,`store.${store.code.toLowerCase()}@hanokops.invalid`]);
    await db.query("update ops_profiles set role='store',store_id=$2 where user_id=$1",[id,store.id]);
    await db.query("insert into ops_tickets(id,store_id,created_by,title,status,resolution) values($1,$2,$3,'Historical ticket','completed','Done')",[ticket,store.id,id]);
    await db.query("insert into ops_ticket_comments(ticket_id,author_id,body) values($1,$2,'Historical comment')",[ticket,id]);
    await db.query('insert into ops_ticket_attachments(ticket_id,uploaded_by,storage_path,file_name) values($1,$2,$3,$4)',[ticket,id,`${ticket}/history.txt`,'history.txt']);
    await db.query('insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)',['ops-ticket-attachments',`${ticket}/history.txt`,id]);
    await db.query("insert into ops_reopen_requests(ticket_id,store_id,requested_by,reason) values($1,$2,$3,'Historical reopen')",[ticket,store.id,id]);
  }
  await db.exec(fs.readFileSync(path.join(migrations, fs.readdirSync(migrations).find(x=>x.endsWith('_account_memberships_and_active_access.sql'))), 'utf8'));
  await db.query('update ops_profiles set active=false where user_id=$1',[uid(4)]);
  await db.query("update ops_profiles set role='partner' where user_id=$1",[uid(5)]);
  await db.query('insert into ops_store_memberships(user_id,store_id) values($1,$2),($1,$3)',[uid(5),stores[0].id,stores[1].id]);
  await db.query("update ops_profiles set role='store',store_id=$2 where user_id=$1",[uid(6),stores[2].id]);
  await db.query('insert into ops_store_memberships(user_id,store_id) values($1,$2)',[uid(6),stores[2].id]);
  async function as(id, sql, params=[], role='authenticated') {
    await db.exec(`set role ${role}`);
    try { await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']); return await db.query(sql,params); }
    finally { await db.exec('reset role'); }
  }
  const before = await snapshot(db, [...unchangedTables, 'public.ops_stores']);
  const policies = (await db.query("select * from pg_policies where schemaname in ('public','storage') order by schemaname,tablename,policyname")).rows;
  const grants = (await db.query("select * from information_schema.role_table_grants where table_schema in ('public','storage') order by table_schema,table_name,grantee,privilege_type")).rows;
  await db.exec(fs.readFileSync(path.join(migrations, fs.readdirSync(migrations).find(x=>x.endsWith('_admin_store_creation.sql'))), 'utf8'));
  return {db, stores, as, before, policies, grants, create: async (requestId,name,code,actor=uid(1)) => (await db.query(createSQL,[actor,requestId,name,code])).rows[0].result};
}

test('store creation SQL preserves existing data and role scopes; validates and commits idempotently', async t => {
  const {db, stores, as, before, policies, grants, create} = await fixture(t);
  await t.test('migration changes no existing data, grants or access policies', async () => {
    assert.deepEqual(await snapshot(db,[...unchangedTables,'public.ops_stores']),before);
    assert.deepEqual((await db.query("select * from pg_policies where schemaname in ('public','storage') order by schemaname,tablename,policyname")).rows,policies);
    assert.deepEqual((await db.query("select * from information_schema.role_table_grants where table_schema in ('public','storage') order by table_schema,table_name,grantee,privilege_type")).rows,grants);
    assert.equal(stores.length,5);
  });
  await t.test('RPC is service-role-only and rejects spoofed, absent, inactive and non-admin actors', async () => {
    for (const role of ['anon','authenticated']) {
      for (const user of [null,uid(1),uid(2),uid(5),uid(6),uid(10)]) {
        await assert.rejects(as(user,createSQL,[uid(1),uid(200),'Denied','NO01'],role),/permission denied/);
      }
      await assert.rejects(as(uid(1),'select * from ops_private.store_create_requests',[],role),/permission denied/);
    }
    for (const actor of [null,uid(2),uid(4),uid(5),uid(6),uid(7),uid(10),uid(999)]) await assert.rejects(create(uid(200),'Denied','NO01',actor),/admin_required/);
    assert.equal((await db.query('select * from ops_stores')).rows.length,5);
    assert.equal((await db.query('select * from ops_private.store_create_requests')).rows.length,0);
    const acl=(await db.query("select has_function_privilege('service_role','public.ops_admin_stores_create(uuid,uuid,text,text)','execute') allowed")).rows[0];
    assert.equal(acl.allowed,true);
  });
  await t.test('SQL validates request ID, Unicode character limits and ASCII-only store code', async () => {
    await assert.rejects(create(null,'Valid','OK01'),/invalid_request_id/);
    for (const name of [null,'',' \t\n\u00a0\u3000\uFEFF','店'.repeat(101),'😀'.repeat(101)]) await assert.rejects(create(uid(200),name,'OK01'),/invalid_store_name/);
    for (const code of [null,'','A','ABCDEFGHI','A B','A-B','中文','ß1']) await assert.rejects(create(uid(200),'Valid',code),/invalid_store_code/);
    assert.equal((await db.query('select * from ops_private.store_create_requests')).rows.length,0);
  });
  let store;
  await t.test('active service actor creates exactly one trimmed store and no accounts, assignments or history', async () => {
    store=(await as(null,createSQL,[uid(1),uid(200),'\u3000新店 😀\u00a0',' \t nw01 \n'],'service_role')).rows[0].result;
    assert.deepEqual(store,{id:store.id,name:'新店 😀',code:'NW01',active:true});
    assert.match(store.id,/^[0-9a-f-]{36}$/);
    assert.deepEqual(await snapshot(db,unchangedTables),Object.fromEntries(unchangedTables.map(table=>[table,before[table]])));
    assert.deepEqual((await db.query('select * from ops_stores where id=any($1) order by code',[stores.map(s=>s.id)])).rows,stores);
    assert.equal((await db.query('select * from ops_store_memberships where store_id=$1',[store.id])).rows.length,0);
    const requests=(await db.query('select * from ops_private.store_create_requests')).rows;
    assert.equal(requests.length,1);assert.equal(requests[0].actor_id,uid(1));assert.equal(requests[0].store_id,store.id);
    assert.equal((await db.query('select ops_admin_accounts_list($1) result',[uid(1)])).rows[0].result.stores.some(s=>s.id===store.id),true);
  });
  await t.test('normalized retry returns the same row; actor/name/code changes conflict without mutation', async () => {
    assert.deepEqual(await create(uid(200),' 新店 😀 ','nw01'),store);
    for (const [name,code,actor] of [['Changed','NW01',uid(1)],['新店 😀','NW02',uid(1)],['新店 😀','NW01',uid(3)]]) await assert.rejects(create(uid(200),name,code,actor),/request_conflict/);
    assert.equal((await db.query('select * from ops_stores')).rows.length,6);
    assert.equal((await db.query('select * from ops_private.store_create_requests')).rows.length,1);
    await db.query('update ops_profiles set active=false where user_id=$1',[uid(1)]);
    await assert.rejects(create(uid(200),'新店 😀','NW01'),/admin_required/);
    await db.query('update ops_profiles set active=true where user_id=$1',[uid(1)]);
  });
  await t.test('duplicate existing/new code is a conflict and never consumes the request or renames a store', async () => {
    for (const code of [stores[0].code,'nw01']) await assert.rejects(create(uid(201),'Duplicate',code),/store_code_exists/);
    assert.equal((await db.query('select * from ops_private.store_create_requests where request_id=$1',[uid(201)])).rows.length,0);
    assert.equal((await db.query('select name from ops_stores where id=$1',[store.id])).rows[0].name,'新店 😀');
    const fixed=await create(uid(201),'Corrected','FIX1');assert.equal(fixed.code,'FIX1');
  });
  await t.test('queued duplicate requests create once and duplicate-code requests have one winner', async () => {
    // PGlite serializes statements; the Docker-local integration exercises separate concurrent requests.
    const replays=await Promise.all(Array.from({length:6},()=>create(uid(202),'Repeated','REP1')));
    assert.ok(replays.every(row=>row.id===replays[0].id));
    const race=await Promise.allSettled([create(uid(203),'Code race A','RACE'),create(uid(204),'Code race B','RACE')]);
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
    assert.match(race.find(r=>r.status==='rejected').reason.message,/store_code_exists/);
    assert.equal((await db.query("select * from ops_stores where code='RACE'")).rows.length,1);
    const conflict=await Promise.allSettled([create(uid(205),'Request race A','RA01'),create(uid(205),'Request race B','RA02')]);
    assert.equal(conflict.filter(r=>r.status==='fulfilled').length,1);
    assert.match(conflict.find(r=>r.status==='rejected').reason.message,/request_conflict/);
  });
  await t.test('a ledger failure rolls back the store insert in the same transaction', async () => {
    await db.exec("alter table ops_private.store_create_requests add constraint fixture_ledger_failure check(code<>'ROLL')");
    await assert.rejects(create(uid(206),'Must roll back','ROLL'),/fixture_ledger_failure/);
    assert.equal((await db.query("select * from ops_stores where code='ROLL'")).rows.length,0);
    assert.equal((await db.query('select * from ops_private.store_create_requests where request_id=$1',[uid(206)])).rows.length,0);
    await db.exec('alter table ops_private.store_create_requests drop constraint fixture_ledger_failure');
    assert.equal((await create(uid(206),'Can retry','ROLL')).code,'ROLL');
  });
  await t.test('Unicode limits work in SQL and inactive replay never reactivates a store', async () => {
    const long=await create(uid(207),'😀'.repeat(100),'EMOJI');assert.equal(Array.from(long.name).length,100);
    await db.query('update ops_stores set active=false where id=$1',[store.id]);
    assert.deepEqual(await create(uid(200),'新店 😀','NW01'),{...store,active:false});
    await assert.rejects(create(uid(208),'Cannot reuse inactive code','NW01'),/store_code_exists/);
    await db.query('update ops_stores set active=true where id=$1',[store.id]);
    await db.query("update ops_stores set name='Renamed store',code='RENAME' where id=$1",[store.id]);
    assert.deepEqual(await create(uid(200),'新店 😀','NW01'),{...store,name:'Renamed store',code:'RENAME'});
    await db.query('update ops_stores set name=$2,code=$3 where id=$1',[store.id,store.name,store.code]);
  });
  await t.test('new store stays invisible to all old scoped users; group-wide HQ/admin access remains', async () => {
    const ticket=uid(300);
    await db.query("insert into ops_tickets(id,store_id,created_by,title) values($1,$2,$3,'New store issue')",[ticket,store.id,uid(1)]);
    await db.query("insert into ops_ticket_comments(ticket_id,author_id,body) values($1,$2,'Private comment')",[ticket,uid(1)]);
    await db.query('insert into ops_ticket_attachments(ticket_id,uploaded_by,storage_path,file_name) values($1,$2,$3,$4)',[ticket,uid(1),`${ticket}/new.txt`,'new.txt']);
    await db.query('insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)',['ops-ticket-attachments',`${ticket}/new.txt`,uid(1)]);
    for (const user of [uid(5),uid(6),...Array.from({length:5},(_,i)=>uid(10+i))]) {
      assert.equal((await as(user,'select * from ops_stores where id=$1',[store.id])).rows.length,0);
      assert.equal((await as(user,'select * from ops_tickets where id=$1',[ticket])).rows.length,0);
      for (const table of ['ops_ticket_comments','ops_ticket_attachments','ops_ticket_events']) assert.equal((await as(user,`select * from ${table} where ticket_id=$1`,[ticket])).rows.length,0);
      assert.equal((await as(user,'select * from storage.objects where name=$1',[`${ticket}/new.txt`])).rows.length,0);
      await assert.rejects(as(user,"insert into ops_ticket_comments(ticket_id,author_id,body) values($1,$2,'Forbidden')",[ticket,user]),/row-level security/);
      await assert.rejects(as(user,"insert into ops_tickets(store_id,created_by,title) values($1,$2,'Forbidden')",[store.id,user]),/row-level security/);
    }
    assert.equal((await as(uid(5),'select * from ops_stores')).rows.length,2);
    assert.equal((await as(uid(6),'select * from ops_stores')).rows.length,1);
    for (let i=0;i<5;i++) assert.equal((await as(uid(10+i),'select * from ops_stores')).rows.length,1);
    for (const user of [uid(1),uid(2)]) assert.equal((await as(user,'select * from ops_tickets where id=$1',[ticket])).rows.length,1);
    for (const user of [uid(4),uid(7)]) assert.equal((await as(user,'select * from ops_stores')).rows.length,0);
    assert.equal((await db.query('select * from ops_store_memberships where store_id=$1',[store.id])).rows.length,0);
    await db.query('select ops_admin_accounts_assign($1,$2,$3)',[uid(1),uid(5),[stores[0].id,stores[1].id,store.id]]);
    assert.equal((await as(uid(5),'select * from ops_tickets where id=$1',[ticket])).rows.length,1);
  });
});
