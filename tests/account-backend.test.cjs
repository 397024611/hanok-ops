const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const root = path.resolve(__dirname, '..');
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema cron;
    create table auth.users(id uuid primary key,email text unique,raw_user_meta_data jsonb default '{}'::jsonb,raw_app_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    grant execute on function auth.uid() to public;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner_id text);
    alter table storage.objects enable row level security;
    grant select,insert,update,delete on storage.objects to authenticated;
    create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
    create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
  `);
  const baseline = fs.readFileSync(path.join(root, 'supabase/migrations/001_initial_hanok_ops.sql'), 'utf8')
    .replace('create extension if not exists pg_cron;', '-- Cron scheduler alone is stubbed; all ops schema, functions and policies run unchanged.');
  await db.exec(baseline);
  const stores = (await db.query('select * from ops_stores order by code')).rows;
  await db.query(`insert into auth.users(id,email) values($1,'admin@example.test'),($2,'hq@example.test'),($3,'pending@example.test')`, [uid(1),uid(2),uid(3)]);
  await db.query(`update ops_profiles set role=case when user_id=$1 then 'admin' else 'hq' end where user_id in ($1,$2)`,[uid(1),uid(2)]);
  for (let i=0;i<stores.length;i++) {
    const id=uid(10+i), store=stores[i];
    await db.query('insert into auth.users(id,email) values($1,$2)',[id,`store.${store.code.toLowerCase()}@hanokops.invalid`]);
    await db.query("update ops_profiles set role='store',store_id=$2 where user_id=$1",[id,store.id]);
    await db.query(`insert into ops_tickets(id,store_id,created_by,title,status,resolution) values($1,$2,$3,$4,'completed','Done')`,[uid(100+i),store.id,id,store.name]);
    await db.query('insert into ops_ticket_comments(ticket_id,author_id,body) values($1,$2,$3)',[uid(100+i),id,'Existing comment']);
    await db.query('insert into ops_ticket_attachments(ticket_id,uploaded_by,storage_path,file_name) values($1,$2,$3,$4)',[uid(100+i),id,`${uid(100+i)}/existing.txt`,'existing.txt']);
    await db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['ops-ticket-attachments',`${uid(100+i)}/existing.txt`]);
  }
  // Mimic production's legacy table-level profile grants; the migration must narrow them.
  await db.exec(`grant insert,update on ops_profiles to authenticated;
    grant update on ops_profiles to public;
    grant update(role) on ops_profiles to public,anon;
    create policy legacy_broad_profile_update on ops_profiles for update to public using(true) with check(true);`);
  // Adversarial legacy state: table and column permissions plus broad authenticated policies.
  for(const table of ['ops_tickets','ops_ticket_comments','ops_ticket_attachments','ops_ticket_events','ops_reopen_requests','ops_notifications']) {
    await db.exec(`grant all on public.${table} to public,authenticated; create policy broad_legacy_${table} on public.${table} for all to authenticated using(true) with check(true);`);
  }
  await db.exec('grant update(title,body,recipient_id) on ops_notifications to public,anon,authenticated;');
  await db.exec('create policy broad_legacy_storage_delete on storage.objects for delete to authenticated using(true);');
  const migration=fs.readdirSync(path.join(root,'supabase/migrations')).find(x=>x.endsWith('_account_memberships_and_active_access.sql'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',migration),'utf8'));
  async function as(id,sql,params=[],role='authenticated') {
    await db.exec(`set role ${role};`);
    try { await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']); return await db.query(sql,params); }
    finally { await db.exec('reset role;'); }
  }
  async function create(id,role,ids,email=`person${id.slice(-4)}@example.test`,requestId=uid(Number(id.slice(-4))+1000)) {
    const reserved=await db.query('select ops_admin_accounts_reserve($1,$2,$3,$4,$5,$6) result',[uid(1),requestId,email,'Person',role,ids]);
    await db.query('insert into auth.users(id,email,raw_app_meta_data) values($1,$2,$3)',[id,email,JSON.stringify({ops_account_request_id:requestId})]);
    assert.equal((await db.query('select active from ops_profiles where user_id=$1',[id])).rows[0].active,false);
    return (await db.query('select ops_admin_accounts_finalize($1,$2,$3) result',[uid(1),requestId,id])).rows[0].result;
  }
  return {db,stores,as,create};
}

test('real PostgreSQL migration: memberships, role boundaries, retries and stale-JWT revocation', async t => {
  const f=await fixture(); const {db,stores,as,create}=f; t.after(()=>db.close());
  await t.test('preserves all five shared store accounts and HQ/admin access',async()=>{
    assert.equal((await db.query('select * from ops_store_memberships')).rows.length,5);
    for(let i=0;i<5;i++) {
      assert.equal((await as(uid(10+i),'select * from ops_tickets')).rows.length,1);
      assert.equal((await as(uid(10+i),'select * from ops_ticket_comments')).rows.length,1);
      assert.equal((await as(uid(10+i),'select * from storage.objects')).rows.length,1);
      assert.equal((await db.query('select is_legacy_shared from ops_profiles where user_id=$1',[uid(10+i)])).rows[0].is_legacy_shared,true);
    }
    for(const id of [uid(1),uid(2)]) assert.equal((await as(id,'select * from ops_tickets')).rows.length,5);
    assert.equal((await as(uid(3),'select * from ops_tickets')).rows.length,0);
    assert.equal((await as(null,'select * from ops_tickets',[],'anon').catch(()=>({rows:[]}))).rows.length,0);
  });
  await t.test('management RPCs are service-role only; SQL never trusts a supplied actor from authenticated',async()=>{
    for(const role of ['anon','authenticated']) await assert.rejects(as(uid(1),'select ops_admin_accounts_list($1)',[uid(1)],role),/permission denied/);
    for(const id of [uid(2),uid(3),uid(10),null]) await assert.rejects(db.query('select ops_admin_accounts_list($1)',[id]),/admin_required/);
    assert.equal((await as(null,'select ops_admin_accounts_list($1) result',[uid(1)],'service_role')).rows[0].result.accounts.length,7);
    await assert.rejects(as(uid(10),"update ops_profiles set role='admin' where user_id=$1",[uid(10)]),/permission denied/);
    // Even a later accidental inherited grant cannot defeat the restrictive mutation deny.
    await db.exec('grant update(role) on ops_profiles to public;');
    assert.equal((await as(uid(10),"update ops_profiles set role='admin' where user_id=$1 returning user_id",[uid(10)])).rows.length,0);
    assert.equal((await db.query('select role from ops_profiles where user_id=$1',[uid(10)])).rows[0].role,'store');
    await db.exec('revoke update(role) on ops_profiles from public;');
    await assert.rejects(as(uid(10),'insert into ops_store_memberships(user_id,store_id) values($1,$2)',[uid(10),stores[1].id]),/permission denied/);
  });
  const partner=uid(30),staff=uid(31);
  await t.test('anonymous operations data stays closed under PUBLIC grants without breaking unrelated anonymous storage',async()=>{
    for(const table of ['ops_stores','ops_profiles','ops_store_memberships','ops_tickets','ops_ticket_comments','ops_ticket_attachments','ops_ticket_events','ops_push_subscriptions','ops_notifications','ops_reopen_requests']) {
      // Reintroduce a bad old grant/policy after migration: the restrictive anon policy still wins.
      await db.exec(`grant select on public.${table} to public; create policy public_legacy_read on public.${table} for select to public using(true);`);
      assert.equal((await as(null,`select * from public.${table}`,[],'anon')).rows.length,0,table);
      await db.exec(`revoke select on public.${table} from public; drop policy public_legacy_read on public.${table};`);
    }
    await db.exec('grant select on storage.objects to anon; create policy public_storage_read on storage.objects for select to anon using(true);');
    await db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['another-public-app','public.png']);
    const visible=(await as(null,'select bucket_id,name from storage.objects',[],'anon')).rows;
    assert.deepEqual(visible,[{bucket_id:'another-public-app',name:'public.png'}]);
    await db.exec('revoke select on storage.objects from anon; drop policy public_storage_read on storage.objects;');
  });
  await t.test('creates pending-safe staff and multi-store partner atomically',async()=>{
    const p=await create(partner,'partner',[stores[0].id,stores[1].id]); assert.equal(p.active,true); assert.equal(p.store_ids.length,2);
    await create(staff,'store',[stores[2].id]);
    assert.equal((await as(partner,'select * from ops_tickets')).rows.length,2);
    assert.equal((await as(partner,'select * from ops_stores')).rows.length,2);
    assert.equal((await as(partner,'select * from ops_ticket_events')).rows.length,2);
    assert.equal((await as(staff,'select * from ops_tickets')).rows.length,1);
    assert.equal((await db.query('select store_id from ops_profiles where user_id=$1',[staff])).rows[0].store_id,stores[2].id);
    assert.equal((await db.query('select store_id from ops_profiles where user_id=$1',[partner])).rows[0].store_id,null);
  });
  await t.test('partner can follow up/upload only in assigned stores, never submit or change status',async()=>{
    await as(partner,'insert into ops_ticket_comments(ticket_id,author_id,body) values($1,$2,$3)',[uid(100),partner,'Partner comment']);
    await assert.rejects(as(partner,'insert into ops_ticket_comments(ticket_id,author_id,body) values($1,$2,$3)',[uid(102),partner,'Denied']),/row-level security/);
    await assert.rejects(as(partner,'insert into ops_ticket_comments(ticket_id,author_id,body) values($1,$2,$3)',[uid(100),uid(10),'Spoofed']),/row-level security/);
    await as(partner,'insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)',['ops-ticket-attachments',`${uid(100)}/partner.txt`,partner]);
    assert.equal((await as(partner,'update storage.objects set name=$1 where name=$2 returning id',[`${uid(100)}/stolen.txt`,`${uid(100)}/existing.txt`])).rows.length,0);
    await as(partner,'update storage.objects set name=$1 where name=$2',[`${uid(100)}/renamed.txt`,`${uid(100)}/partner.txt`]);
    await assert.rejects(as(partner,'update storage.objects set name=$1 where name=$2',[`${uid(102)}/moved.txt`,`${uid(100)}/renamed.txt`]),/row-level security/);
    await as(partner,'insert into ops_ticket_attachments(ticket_id,uploaded_by,storage_path,file_name) values($1,$2,$3,$4)',[uid(100),partner,`${uid(100)}/renamed.txt`,'renamed.txt']);
    await assert.rejects(as(partner,'insert into ops_tickets(store_id,created_by,title) values($1,$2,$3)',[stores[0].id,partner,'No']),/row-level security/);
    assert.equal((await as(partner,"update ops_tickets set status='in_progress' where id=$1 returning id",[uid(100)])).rows.length,0);
    await assert.rejects(as(partner,'insert into ops_reopen_requests(ticket_id,store_id,requested_by,reason) values($1,$2,$3,$4)',[uid(100),stores[0].id,partner,'Not allowed']),/row-level security/);
  });
  await t.test('staff submission/reopen and HQ review still work; pending/null role review is rejected',async()=>{
    for(const [column,value] of [['status','completed'],['assigned_to',uid(1)],['completed_by',uid(1)],['accepted_at','2026-01-01'],['due_at','2026-01-01'],['resolution','Already done']]) {
      await assert.rejects(as(staff,`insert into ops_tickets(store_id,created_by,title,${column}) values($1,$2,$3,$4)`,[stores[2].id,staff,'Forged',value]),/row-level security|check constraint/);
    }
    await assert.rejects(as(staff,"insert into ops_tickets(store_id,created_by,title,status,resolution,completed_by,assigned_to) values($1,$2,'Forged','completed','Done',$3,$3)",[stores[2].id,staff,uid(1)]),/row-level security/);
    for(const [column,value] of [['status','approved'],['reviewed_by',uid(1)],['reviewed_at','2026-01-01']]) {
      await assert.rejects(as(staff,`insert into ops_reopen_requests(ticket_id,store_id,requested_by,reason,${column}) values($1,$2,$3,$4,$5)`,[uid(102),stores[2].id,staff,'Forged review',value]),/row-level security/);
    }
    await as(staff,'insert into ops_tickets(id,store_id,created_by,title) values($1,$2,$3,$4)',[uid(200),stores[2].id,staff,'Staff issue']);
    await assert.rejects(as(staff,'insert into ops_tickets(store_id,created_by,title) values($1,$2,$3)',[stores[0].id,staff,'Wrong store']),/row-level security/);
    await as(staff,'insert into ops_reopen_requests(id,ticket_id,store_id,requested_by,reason) values($1,$2,$3,$4,$5)',[uid(201),uid(102),stores[2].id,staff,'Still broken']);
    await assert.rejects(as(uid(3),'select ops_review_reopen_request($1,true)',[uid(201)]),/Admin or HQ/);
    await assert.rejects(as(uid(999),'select ops_review_reopen_request($1,true)',[uid(201)]),/Admin or HQ/);
    await as(uid(2),'select ops_review_reopen_request($1,true)',[uid(201)]);
    assert.equal((await db.query('select status from ops_tickets where id=$1',[uid(102)])).rows[0].status,'in_progress');
  });
  await t.test('broad legacy grants/policies cannot hijack comments/files/reviews, forge events, delete tickets or mutate notices',async()=>{
    assert.equal((await as(staff,"update ops_ticket_comments set author_id=$1,body='Hijacked' where ticket_id=$2 returning id",[staff,uid(102)])).rows.length,0);
    assert.equal((await as(staff,'delete from ops_ticket_comments where ticket_id=$1 returning id',[uid(102)])).rows.length,0);
    assert.equal((await as(staff,'update ops_ticket_attachments set uploaded_by=$1 where ticket_id=$2 returning id',[staff,uid(102)])).rows.length,0);
    assert.equal((await as(staff,'delete from ops_ticket_attachments where ticket_id=$1 returning id',[uid(102)])).rows.length,0);
    await assert.rejects(as(staff,"insert into ops_ticket_events(ticket_id,actor_id,event_type) values($1,$2,'forged')",[uid(102),uid(1)]),/row-level security/);
    assert.equal((await as(staff,"update ops_ticket_events set actor_id=$1 where ticket_id=$2 returning id",[uid(1),uid(102)])).rows.length,0);
    assert.equal((await as(staff,'delete from ops_ticket_events where ticket_id=$1 returning id',[uid(102)])).rows.length,0);
    assert.equal((await as(staff,"update ops_reopen_requests set status='rejected',reviewed_by=$1 where id=$2 returning id",[uid(1),uid(201)])).rows.length,0);
    assert.equal((await as(staff,'delete from ops_reopen_requests where id=$1 returning id',[uid(201)])).rows.length,0);
    assert.equal((await as(staff,'delete from ops_tickets where id=$1 returning id',[uid(102)])).rows.length,0);
    assert.equal((await as(uid(1),'delete from ops_tickets where id=$1 returning id',[uid(102)])).rows.length,0);
    await assert.rejects(as(staff,"insert into ops_notifications(recipient_id,ticket_id,kind,title,dedupe_key) values($1,$2,'new_ticket','Forged','forged')",[staff,uid(102)]),/row-level security/);
    await db.query("insert into ops_notifications(id,recipient_id,ticket_id,kind,title,dedupe_key) values($1,$2,$3,'new_ticket','Notice','staff-notice')",[uid(202),staff,uid(102)]);
    assert.equal((await as(staff,'delete from ops_notifications where id=$1 returning id',[uid(202)])).rows.length,0);
    await assert.rejects(as(staff,"update ops_notifications set title='Forged' where id=$1",[uid(202)]),/permission denied/);
    assert.equal((await as(staff,'update ops_notifications set read_at=now() where id=$1 returning id',[uid(202)])).rows.length,1);
    assert.equal((await as(staff,'delete from storage.objects where name=$1 returning id',[`${uid(102)}/existing.txt`])).rows.length,0);
    await db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['ops-ticket-attachments',`${uid(102)}/hq-delete.txt`]);
    assert.equal((await as(uid(2),'delete from storage.objects where name=$1 returning id',[`${uid(102)}/hq-delete.txt`])).rows.length,1);
    assert.equal((await db.query('select status from ops_reopen_requests where id=$1',[uid(201)])).rows[0].status,'approved');
    assert.equal((await db.query('select * from ops_ticket_comments where ticket_id=$1',[uid(102)])).rows.length,1);
  });
  await t.test('atomic reassignment removes old store access immediately and rejects invalid changes without damage',async()=>{
    for(const ids of [[],[stores[0].id,stores[1].id],[stores[0].id,stores[0].id],[uid(999)]]) await assert.rejects(db.query('select ops_admin_accounts_assign($1,$2,$3)',[uid(1),staff,ids]),/invalid_stores/);
    assert.equal((await db.query('select store_id from ops_store_memberships where user_id=$1',[staff])).rows[0].store_id,stores[2].id);
    await db.query('select ops_admin_accounts_assign($1,$2,$3)',[uid(1),staff,[stores[3].id]]);
    assert.equal((await as(staff,'select * from ops_tickets')).rows.length,1);
    assert.equal((await as(staff,'select * from ops_tickets where id=$1',[uid(200)])).rows.length,0);
    assert.equal((await db.query('select store_id from ops_profiles where user_id=$1',[staff])).rows[0].store_id,stores[3].id);
    await assert.rejects(db.query('select ops_admin_accounts_assign($1,$2,$3)',[uid(1),uid(10),[stores[4].id]]),/shared_store_fixed/);
  });
  await t.test('retries never adopt duplicates, change roles, or resurrect deactivated completed requests',async()=>{
    const params=[uid(1),uid(1030),'person0030@example.test','Person','partner',[stores[0].id,stores[1].id]];
    const retry=(await db.query('select ops_admin_accounts_reserve($1,$2,$3,$4,$5,$6) result',params)).rows[0].result; assert.equal(retry.complete,true);assert.equal(retry.user_id,partner);
    await assert.rejects(db.query('select ops_admin_accounts_reserve($1,$2,$3,$4,$5,$6)',[...params.slice(0,4),'admin',params[5]]),/invalid_role/);
    await assert.rejects(db.query('select ops_admin_accounts_reserve($1,$2,$3,$4,$5,$6)',[uid(1),uid(2030),'admin@example.test','Duplicate','store',[stores[0].id]]),/email_exists/);
    await assert.rejects(db.query('select ops_admin_accounts_finalize($1,$2,$3)',[uid(1),uid(1030),uid(1)]),/request_conflict/);
    for(const target of [uid(1),uid(2)]) await assert.rejects(db.query('select ops_admin_accounts_deactivate($1,$2)',[uid(1),target]),/account_protected/);
  });
  await t.test('deactivated existing JWT loses tickets/comments/files/events/reopens/notifications/push without deleting history',async()=>{
    await as(partner,'insert into ops_push_subscriptions(user_id,endpoint,p256dh,auth_key) values($1,$2,$3,$4)',[partner,'https://push.test/one','fake','fake']);
    await db.query("insert into ops_notifications(recipient_id,ticket_id,kind,title,dedupe_key) values($1,$2,'new_ticket','Private','partner-notice')",[partner,uid(100)]);
    assert.equal((await as(partner,'select * from ops_notifications')).rows.length,1);
    await db.query('select ops_admin_accounts_deactivate($1,$2)',[uid(1),partner]);
    for(const table of ['ops_stores','ops_store_memberships','ops_tickets','ops_ticket_comments','ops_ticket_attachments','ops_ticket_events','ops_reopen_requests','ops_notifications','ops_push_subscriptions','storage.objects']) {
      assert.equal((await as(partner,`select * from ${table}`)).rows.length,0,table);
    }
    assert.equal((await as(partner,'select active from ops_profiles where user_id=$1',[partner])).rows[0].active,false);
    await assert.rejects(as(partner,'insert into ops_push_subscriptions(user_id,endpoint,p256dh,auth_key) values($1,$2,$3,$4)',[partner,'https://push.test/new','fake','fake']),/row-level security/);
    await assert.rejects(as(partner,'insert into storage.objects(bucket_id,name) values($1,$2)',['ops-ticket-attachments',`${uid(100)}/denied.txt`]),/row-level security/);
    await assert.rejects(as(partner,'insert into ops_ticket_comments(ticket_id,author_id,body) values($1,$2,$3)',[uid(100),partner,'Denied']),/row-level security/);
    await assert.rejects(db.query('select ops_admin_accounts_assign($1,$2,$3)',[uid(1),partner,[stores[0].id]]),/account_inactive/);
    const retry=(await db.query('select ops_admin_accounts_finalize($1,$2,$3) result',[uid(1),uid(1030),partner])).rows[0].result; assert.equal(retry.active,false);
    assert.equal((await db.query('select * from ops_ticket_comments where author_id=$1',[partner])).rows.length,1);
    assert.equal((await db.query('select * from ops_push_subscriptions where user_id=$1',[partner])).rows.length,0);
  });
  await t.test('unfinished requests are actor-scoped, discoverable and safely recoverable with the same or new request ID',async()=>{
    const req=uid(3000), user=uid(300), email='unfinished@example.test';
    const args=[uid(1),req,email,'Unfinished','store',[stores[0].id]];
    await db.query('select ops_admin_accounts_reserve($1,$2,$3,$4,$5,$6)',args);
    let list=(await db.query('select ops_admin_accounts_list($1) result',[uid(1)])).rows[0].result;
    assert.equal(list.pending_requests.length,1);assert.equal(list.pending_requests[0].request_id,req);
    assert.equal(list.accounts.some(a=>a.role==='pending'),false);
    assert.deepEqual(Object.keys(list.pending_requests[0]).sort(),['created_at','display_name','email','request_id','role','store_ids']);
    const resumed=(await db.query('select ops_admin_accounts_reserve($1,$2,$3,$4,$5,$6) result',[uid(1),uid(3001),...args.slice(2)])).rows[0].result;
    assert.equal(resumed.request_id,req);assert.equal(resumed.user_id,null);
    await assert.rejects(db.query('select ops_admin_accounts_reserve($1,$2,$3,$4,$5,$6)',[uid(1),uid(3002),email,'Changed','store',[stores[0].id]]),/request_conflict/);
    await db.query("insert into auth.users(id,email) values($1,'second-admin@example.test')",[uid(4)]);
    await db.query("update ops_profiles set role='admin',active=true where user_id=$1",[uid(4)]);
    assert.equal((await db.query('select ops_admin_accounts_list($1) result',[uid(4)])).rows[0].result.pending_requests.length,0);
    await assert.rejects(db.query('select ops_admin_accounts_reserve($1,$2,$3,$4,$5,$6)',[uid(4),uid(3003),...args.slice(2)]),/request_conflict/);
    await db.query('insert into auth.users(id,email,raw_app_meta_data) values($1,$2,$3)',[user,email,JSON.stringify({ops_account_request_id:req})]);
    assert.equal((await as(user,'select * from ops_tickets')).rows.length,0);
    const authResume=(await db.query('select ops_admin_accounts_reserve($1,$2,$3,$4,$5,$6) result',[uid(1),uid(3004),...args.slice(2)])).rows[0].result;
    assert.equal(authResume.request_id,req);assert.equal(authResume.user_id,user);
    await db.query('select ops_admin_accounts_finalize($1,$2,$3)',[uid(1),req,user]);
    assert.equal((await db.query('select ops_admin_accounts_list($1) result',[uid(1)])).rows[0].result.pending_requests.length,0);
    await assert.rejects(db.query('select ops_admin_accounts_reserve($1,$2,$3,$4,$5,$6)',[uid(1),uid(3005),...args.slice(2)]),/email_exists/);
    await db.query('update ops_profiles set active=false where user_id=$1',[uid(4)]);
  });
  await t.test('user-editable metadata grants no access and cannot finalize a reserved account',async()=>{
    const req=uid(5000), user=uid(500), email='spoofed@example.test';
    await db.query('select ops_admin_accounts_reserve($1,$2,$3,$4,$5,$6)',[uid(1),req,email,'Spoofed','store',[stores[0].id]]);
    await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[user,email,JSON.stringify({role:'admin',active:true,store_id:stores[0].id,ops_account_request_id:req})]);
    const profile=(await db.query('select role,active from ops_profiles where user_id=$1',[user])).rows[0];assert.deepEqual(profile,{role:'pending',active:false});
    assert.equal((await as(user,'select * from ops_tickets')).rows.length,0);
    await assert.rejects(db.query('select ops_admin_accounts_finalize($1,$2,$3)',[uid(1),req,user]),/request_conflict/);
    await assert.rejects(db.query('select ops_admin_accounts_reserve($1,$2,$3,$4,$5,$6)',[uid(1),req,email,'Spoofed','store',[stores[0].id]]),/email_exists/);
  });
  await t.test('disabled HQ/admin and missing profiles cannot bypass live checks or receive newly queued notices',async()=>{
    await db.query('update ops_profiles set active=false where user_id in ($1,$2)',[uid(1),uid(2)]);
    for(const id of [uid(1),uid(2)]) {
      assert.equal((await as(id,'select * from ops_tickets')).rows.length,0);
      await assert.rejects(as(id,'select ops_review_reopen_request($1,true)',[uid(201)]),/Admin or HQ/);
    }
    await assert.rejects(db.query('select ops_admin_accounts_list($1)',[uid(1)]),/admin_required/);
    await db.query('insert into ops_tickets(id,store_id,created_by,title) values($1,$2,$3,$4)',[uid(210),stores[0].id,uid(10),'No notification to disabled HQ']);
    assert.equal((await db.query('select * from ops_notifications where ticket_id=$1',[uid(210)])).rows.length,0);
  });
});
