-- Account management: server-owned authorization, no changes to Auth passwords.
-- Apply only after the shared-project access audit in docs/ACCOUNT-BACKEND.md.
begin;

alter table public.ops_profiles add column active boolean not null default true;
alter table public.ops_profiles add column is_legacy_shared boolean not null default false;
alter table public.ops_profiles drop constraint ops_profiles_role_check;
alter table public.ops_profiles add constraint ops_profiles_role_check
  check (role in ('admin','hq','store','partner','pending'));
update public.ops_profiles p set is_legacy_shared=true
from public.ops_stores s where p.role='store' and p.store_id=s.id
  and lower(p.email)='store.'||lower(s.code)||'@hanokops.invalid'
  and s.code in ('HWD','HWG','PDL','MTH','BTD');

-- Keep authorization columns unreachable even if an old project has broad grants.
revoke insert,update,delete on public.ops_profiles,public.ops_stores from public,anon,authenticated;
revoke update(user_id,email,display_name,role,store_id,created_at,updated_at,active,is_legacy_shared),
  insert(user_id,email,display_name,role,store_id,created_at,updated_at,active,is_legacy_shared) on public.ops_profiles from public,anon,authenticated;
revoke update(id,code,name,active,created_at),insert(id,code,name,active,created_at) on public.ops_stores from public,anon,authenticated;

create table public.ops_store_memberships (
  user_id uuid not null references public.ops_profiles(user_id) on delete cascade,
  store_id uuid not null references public.ops_stores(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key(user_id,store_id)
);
create index ops_store_memberships_store_idx on public.ops_store_memberships(store_id,user_id);
insert into public.ops_store_memberships(user_id,store_id)
select user_id,store_id from public.ops_profiles where role='store' and store_id is not null;
alter table public.ops_store_memberships enable row level security;
revoke all on public.ops_store_memberships from public,anon,authenticated;
grant select on public.ops_store_memberships to authenticated;
grant all on public.ops_store_memberships to service_role;

create or replace function ops_private.current_role()
returns text language sql stable security definer set search_path=''
as $$ select p.role from public.ops_profiles p
  where p.user_id=(select auth.uid()) and p.active and p.role<>'pending' $$;
create or replace function ops_private.current_store_id()
returns uuid language sql stable security definer set search_path=''
as $$ select p.store_id from public.ops_profiles p
  where p.user_id=(select auth.uid()) and p.active and p.role='store'
  and exists(select 1 from public.ops_store_memberships m where m.user_id=p.user_id and m.store_id=p.store_id) $$;
create function ops_private.can_access_store(p_store_id uuid)
returns boolean language sql stable security definer set search_path=''
as $$ select exists(select 1 from public.ops_profiles p
  where p.user_id=(select auth.uid()) and p.active and (
    p.role in ('admin','hq') or (p.role in ('store','partner') and exists(
      select 1 from public.ops_store_memberships m where m.user_id=p.user_id and m.store_id=p_store_id)))) $$;
revoke all on function ops_private.can_access_store(uuid) from public,anon;
grant execute on function ops_private.can_access_store(uuid) to authenticated;

create policy ops_memberships_select on public.ops_store_memberships for select to authenticated
  using (ops_private.current_role() in ('admin','hq') or (user_id=(select auth.uid()) and ops_private.current_role() in ('store','partner')));
drop policy ops_stores_select on public.ops_stores;
create policy ops_stores_select on public.ops_stores for select to authenticated using (ops_private.can_access_store(id));
drop policy ops_tickets_select on public.ops_tickets;
create policy ops_tickets_select on public.ops_tickets for select to authenticated using (ops_private.can_access_store(store_id));
drop policy ops_tickets_insert on public.ops_tickets;
create policy ops_tickets_insert on public.ops_tickets for insert to authenticated with check (
  created_by=(select auth.uid()) and ops_private.current_role() in ('admin','hq','store') and ops_private.can_access_store(store_id));
drop policy ops_reopen_select on public.ops_reopen_requests;
create policy ops_reopen_select on public.ops_reopen_requests for select to authenticated using (
  ops_private.can_access_store(store_id) and exists(select 1 from public.ops_tickets t where t.id=ticket_id and t.store_id=ops_reopen_requests.store_id));
drop policy ops_reopen_insert_store on public.ops_reopen_requests;
create policy ops_reopen_insert_store on public.ops_reopen_requests for insert to authenticated with check (
  requested_by=(select auth.uid()) and ops_private.current_role()='store' and ops_private.can_access_store(store_id)
  and exists(select 1 from public.ops_tickets t where t.id=ticket_id and t.store_id=ops_reopen_requests.store_id and t.status='completed'));

-- Restrictive guards also intersect any older permissive policies in a target DB.
create policy ops_stores_access_guard on public.ops_stores as restrictive for all to authenticated
  using (ops_private.can_access_store(id)) with check(false);
create policy ops_stores_delete_guard on public.ops_stores as restrictive for delete to authenticated using(false);
create policy ops_profiles_access_guard on public.ops_profiles as restrictive for select to authenticated
  using (user_id=(select auth.uid()) or ops_private.current_role() in ('admin','hq'));
create policy ops_profiles_insert_guard on public.ops_profiles as restrictive for insert to public with check(false);
create policy ops_profiles_delete_guard on public.ops_profiles as restrictive for delete to public using(false);
create policy ops_profiles_update_guard on public.ops_profiles as restrictive for update to public
  using(false) with check(false);
create policy ops_tickets_access_guard on public.ops_tickets as restrictive for all to authenticated
  using (ops_private.can_access_store(store_id)) with check (ops_private.can_access_store(store_id));
create policy ops_tickets_create_guard on public.ops_tickets as restrictive for insert to authenticated
  with check (created_by=(select auth.uid()) and (ops_private.current_role() in ('admin','hq') or (
    ops_private.current_role()='store' and status='new' and assigned_to is null and due_at is null
    and follow_up_at is null and waiting_reason is null and resolution is null and accepted_at is null
    and completed_at is null and completed_by is null)));
create policy ops_tickets_update_guard on public.ops_tickets as restrictive for update to authenticated
  using (ops_private.current_role() in ('admin','hq')) with check (ops_private.current_role() in ('admin','hq'));
create policy ops_comments_access_guard on public.ops_ticket_comments as restrictive for all to authenticated
  using (exists(select 1 from public.ops_tickets t where t.id=ticket_id))
  with check (author_id=(select auth.uid()) and exists(select 1 from public.ops_tickets t where t.id=ticket_id));
create policy ops_attachments_access_guard on public.ops_ticket_attachments as restrictive for all to authenticated
  using (exists(select 1 from public.ops_tickets t where t.id=ticket_id))
  with check (uploaded_by=(select auth.uid()) and split_part(storage_path,'/',1)=ticket_id::text
    and exists(select 1 from public.ops_tickets t where t.id=ticket_id));
create policy ops_events_access_guard on public.ops_ticket_events as restrictive for select to authenticated
  using (exists(select 1 from public.ops_tickets t where t.id=ticket_id));
create policy ops_reopen_access_guard on public.ops_reopen_requests as restrictive for all to authenticated
  using (ops_private.can_access_store(store_id) and exists(select 1 from public.ops_tickets t where t.id=ticket_id and t.store_id=ops_reopen_requests.store_id))
  with check (requested_by=(select auth.uid()) and ops_private.current_role()='store' and ops_private.can_access_store(store_id)
    and status='pending' and reviewed_by is null and reviewed_at is null
    and exists(select 1 from public.ops_tickets t where t.id=ticket_id and t.store_id=ops_reopen_requests.store_id and t.status='completed'));
create policy ops_push_active_guard on public.ops_push_subscriptions as restrictive for all to authenticated
  using (user_id=(select auth.uid()) and ops_private.current_role() is not null)
  with check (user_id=(select auth.uid()) and ops_private.current_role() is not null);
create policy ops_notifications_active_guard on public.ops_notifications as restrictive for all to authenticated
  using (recipient_id=(select auth.uid()) and ops_private.current_role() is not null
    and (ticket_id is null or exists(select 1 from public.ops_tickets t where t.id=ticket_id)))
  with check (recipient_id=(select auth.uid()) and ops_private.current_role() is not null
    and (ticket_id is null or exists(select 1 from public.ops_tickets t where t.id=ticket_id)));
create policy ops_storage_access_guard on storage.objects as restrictive for all to authenticated
  using (bucket_id<>'ops-ticket-attachments' or exists(select 1 from public.ops_tickets t where t.id::text=(storage.foldername(name))[1]))
  with check (bucket_id<>'ops-ticket-attachments' or exists(select 1 from public.ops_tickets t where t.id::text=(storage.foldername(name))[1]));

-- Own-object retries use INSERT + SELECT + UPDATE; historical files remain readable.
create policy ops_storage_insert_owner_guard on storage.objects as restrictive for insert to authenticated
  with check (bucket_id<>'ops-ticket-attachments' or owner_id=(select auth.uid())::text);
create policy ops_storage_update_owner_guard on storage.objects as restrictive for update to authenticated
  using (bucket_id<>'ops-ticket-attachments' or owner_id=(select auth.uid())::text or ops_private.current_role() in ('admin','hq'))
  with check (bucket_id<>'ops-ticket-attachments' or owner_id=(select auth.uid())::text or ops_private.current_role() in ('admin','hq'));

-- Unsupported mutations stay forbidden even under inherited grants or older permissive policies.
create policy ops_ticket_events_insert_deny on public.ops_ticket_events as restrictive for insert to public with check(false);
create policy ops_ticket_events_update_deny on public.ops_ticket_events as restrictive for update to public using(false) with check(false);
create policy ops_ticket_events_delete_deny on public.ops_ticket_events as restrictive for delete to public using(false);
create policy ops_ticket_comments_update_deny on public.ops_ticket_comments as restrictive for update to public using(false) with check(false);
create policy ops_ticket_comments_delete_deny on public.ops_ticket_comments as restrictive for delete to public using(false);
create policy ops_ticket_attachments_update_deny on public.ops_ticket_attachments as restrictive for update to public using(false) with check(false);
create policy ops_ticket_attachments_delete_deny on public.ops_ticket_attachments as restrictive for delete to public using(false);
create policy ops_reopen_requests_update_deny on public.ops_reopen_requests as restrictive for update to public using(false) with check(false);
create policy ops_reopen_requests_delete_deny on public.ops_reopen_requests as restrictive for delete to public using(false);
create policy ops_tickets_delete_deny on public.ops_tickets as restrictive for delete to public using(false);
create policy ops_notifications_insert_deny on public.ops_notifications as restrictive for insert to public with check(false);
create policy ops_notifications_delete_deny on public.ops_notifications as restrictive for delete to public using(false);
create policy ops_storage_delete_role_guard on storage.objects as restrictive for delete to authenticated
  using (bucket_id<>'ops-ticket-attachments' or ops_private.current_role() in ('admin','hq'));
revoke update on public.ops_notifications from public,anon,authenticated;
revoke update(id,recipient_id,ticket_id,kind,title,body,priority,dedupe_key,data,read_at,created_at) on public.ops_notifications from public,anon,authenticated;
grant update(read_at) on public.ops_notifications to authenticated;
revoke truncate on public.ops_stores,public.ops_profiles,public.ops_store_memberships,public.ops_tickets,
  public.ops_ticket_comments,public.ops_ticket_attachments,public.ops_ticket_events,
  public.ops_reopen_requests,public.ops_notifications,public.ops_push_subscriptions from public,anon,authenticated;

-- A shared project may have inherited PUBLIC grants. Lock down only ops-owned objects.
do $$
declare v_table text; v_columns text;
begin
  foreach v_table in array array['ops_stores','ops_profiles','ops_store_memberships','ops_tickets',
    'ops_ticket_comments','ops_ticket_attachments','ops_ticket_events','ops_push_subscriptions','ops_notifications','ops_reopen_requests'] loop
    execute format('revoke all on table public.%I from public,anon',v_table);
    select string_agg(quote_ident(attname),',') into v_columns from pg_attribute
      where attrelid=format('public.%I',v_table)::regclass and attnum>0 and not attisdropped;
    execute format('revoke all (%s) on table public.%I from public,anon',v_columns,v_table);
    execute format('create policy ops_anon_deny on public.%I as restrictive for all to anon using(false) with check(false)',v_table);
  end loop;
end $$;
revoke all on sequence public.ops_tickets_ticket_no_seq,public.ops_ticket_events_id_seq from public,anon;
-- This guard needs no private function or ops-table privileges, so other anonymous buckets are unaffected.
create policy ops_storage_anon_deny on storage.objects as restrictive for all to anon
  using(bucket_id<>'ops-ticket-attachments') with check(bucket_id<>'ops-ticket-attachments');

-- New Auth signups never obtain operational access from user-editable metadata.
create or replace function ops_private.handle_new_user()
returns trigger language plpgsql security definer set search_path=''
as $$ begin
  insert into public.ops_profiles(user_id,email,display_name,role,store_id,active)
  values(new.id,new.email,left(coalesce(nullif(new.raw_user_meta_data->>'display_name',''),split_part(coalesce(new.email,'user'),'@',1)),100),'pending',null,false)
  on conflict(user_id) do nothing;
  return new;
end $$;

-- Private recovery ledger contains no passwords or password hashes.
create table ops_private.account_create_requests (
  request_id uuid primary key,
  actor_id uuid not null references public.ops_profiles(user_id),
  email text not null unique,
  display_name text not null,
  account_role text not null check(account_role in ('store','partner')),
  store_ids uuid[] not null,
  user_id uuid references public.ops_profiles(user_id),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table ops_private.account_create_requests enable row level security;
revoke all on ops_private.account_create_requests from public,anon,authenticated;

create function ops_private.assert_account_admin(p_actor_id uuid)
returns void language plpgsql security definer set search_path=''
as $$ begin
  if p_actor_id is null or not exists(select 1 from public.ops_profiles where user_id=p_actor_id and active and role='admin') then
    raise exception using message='admin_required',errcode='42501';
  end if;
end $$;
create function ops_private.validate_account_stores(p_role text,p_store_ids uuid[])
returns uuid[] language plpgsql security definer set search_path=''
as $$ declare v_ids uuid[]; begin
  if p_role is null or p_role not in ('store','partner') then raise exception 'invalid_role'; end if;
  if p_store_ids is null or cardinality(p_store_ids)<1 or cardinality(p_store_ids)>100 or array_position(p_store_ids,null) is not null then raise exception 'invalid_stores'; end if;
  select array_agg(distinct id order by id) into v_ids from unnest(p_store_ids) id;
  if cardinality(v_ids)<>cardinality(p_store_ids) or (p_role='store' and cardinality(v_ids)<>1)
    or (select count(*) from public.ops_stores where id=any(v_ids) and active)<>cardinality(v_ids) then raise exception 'invalid_stores'; end if;
  return v_ids;
end $$;
create function ops_private.account_json(p_user_id uuid)
returns jsonb language sql stable security definer set search_path=''
as $$ select jsonb_build_object('user_id',p.user_id,'email',p.email,'display_name',p.display_name,'role',p.role,
  'active',p.active,'created_at',p.created_at,'is_legacy_shared',p.is_legacy_shared,
  'store_ids',coalesce((select jsonb_agg(m.store_id order by m.store_id) from public.ops_store_memberships m where m.user_id=p.user_id),'[]'::jsonb))
  from public.ops_profiles p where p.user_id=p_user_id $$;

create function public.ops_admin_accounts_list(p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$ begin
  perform ops_private.assert_account_admin(p_actor_id);
  return jsonb_build_object(
    'accounts',coalesce((select jsonb_agg(ops_private.account_json(p.user_id) order by p.created_at,p.user_id) from public.ops_profiles p where p.role in ('admin','hq','store','partner')),'[]'::jsonb),
    'pending_requests',coalesce((select jsonb_agg(jsonb_build_object('request_id',r.request_id,'email',r.email,'display_name',r.display_name,'role',r.account_role,'store_ids',r.store_ids,'created_at',r.created_at) order by r.created_at) from ops_private.account_create_requests r where r.actor_id=p_actor_id and r.completed_at is null),'[]'::jsonb),
    'stores',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'code',s.code,'name',s.name,'active',s.active) order by s.code) from public.ops_stores s),'[]'::jsonb));
end $$;

create function public.ops_admin_accounts_reserve(p_actor_id uuid,p_request_id uuid,p_email text,p_display_name text,p_role text,p_store_ids uuid[])
returns jsonb language plpgsql security definer set search_path=''
as $$ declare v_ids uuid[]; v_req ops_private.account_create_requests%rowtype; v_auth auth.users%rowtype; v_request_id uuid; begin
  perform ops_private.assert_account_admin(p_actor_id);
  if p_request_id is null or p_email is null or length(p_email)>254 or p_email<>lower(trim(p_email)) or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_display_name is null or length(trim(p_display_name)) not between 1 and 100 then raise exception 'invalid_account'; end if;
  if p_role is null or p_role not in ('store','partner') then raise exception 'invalid_role'; end if;
  -- Serialize competing reservations for the same address, including different request IDs.
  perform pg_advisory_xact_lock(hashtextextended(p_email,0));
  select * into v_req from ops_private.account_create_requests where request_id=p_request_id for update;
  if not found then
    select * into v_req from ops_private.account_create_requests where email=p_email for update;
    if found and v_req.completed_at is not null then raise exception 'email_exists'; end if;
  end if;
  if v_req.request_id is not null then
    select array_agg(distinct id order by id) into v_ids from unnest(p_store_ids) id;
    if v_req.actor_id is distinct from p_actor_id or v_req.email is distinct from p_email or v_req.display_name is distinct from trim(p_display_name)
      or v_req.account_role is distinct from p_role or v_req.store_ids is distinct from v_ids then raise exception 'request_conflict'; end if;
    v_request_id:=v_req.request_id;
    if v_req.completed_at is not null then
      return jsonb_build_object('complete',true,'request_id',v_request_id,'user_id',v_req.user_id,'account',ops_private.account_json(v_req.user_id));
    end if;
  else
    v_ids:=ops_private.validate_account_stores(p_role,p_store_ids);
    if exists(select 1 from auth.users where lower(email)=p_email) then raise exception 'email_exists'; end if;
    v_request_id:=p_request_id;
    insert into ops_private.account_create_requests(request_id,actor_id,email,display_name,account_role,store_ids)
      values(v_request_id,p_actor_id,p_email,trim(p_display_name),p_role,v_ids);
  end if;
  select * into v_auth from auth.users where lower(email)=p_email limit 1;
  if found and coalesce(v_auth.raw_app_meta_data->>'ops_account_request_id','')<>v_request_id::text then raise exception 'email_exists'; end if;
  return jsonb_build_object('complete',false,'request_id',v_request_id,'user_id',v_auth.id);
end $$;

create function public.ops_admin_accounts_finalize(p_actor_id uuid,p_request_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$ declare v_req ops_private.account_create_requests%rowtype; v_profile public.ops_profiles%rowtype; v_ids uuid[]; begin
  perform ops_private.assert_account_admin(p_actor_id);
  select * into v_req from ops_private.account_create_requests where request_id=p_request_id for update;
  if not found or v_req.actor_id<>p_actor_id then raise exception 'request_conflict'; end if;
  if v_req.completed_at is not null then
    if v_req.user_id<>p_user_id then raise exception 'request_conflict'; end if;
    return ops_private.account_json(p_user_id);
  end if;
  if not exists(select 1 from auth.users u where u.id=p_user_id and lower(u.email)=v_req.email
    and u.raw_app_meta_data->>'ops_account_request_id'=p_request_id::text) then raise exception 'request_conflict'; end if;
  select * into v_profile from public.ops_profiles where user_id=p_user_id for update;
  if not found or v_profile.role<>'pending' or v_profile.active
    or exists(select 1 from public.ops_store_memberships where user_id=p_user_id) then raise exception 'account_not_pending'; end if;
  v_ids:=ops_private.validate_account_stores(v_req.account_role,v_req.store_ids);
  insert into public.ops_store_memberships(user_id,store_id) select p_user_id,unnest(v_ids);
  update public.ops_profiles set email=v_req.email,display_name=v_req.display_name,role=v_req.account_role,
    store_id=case when v_req.account_role='store' then v_ids[1] else null end,active=true where user_id=p_user_id;
  update ops_private.account_create_requests set user_id=p_user_id,completed_at=now() where request_id=p_request_id;
  return ops_private.account_json(p_user_id);
end $$;

create function public.ops_admin_accounts_assign(p_actor_id uuid,p_user_id uuid,p_store_ids uuid[])
returns jsonb language plpgsql security definer set search_path=''
as $$ declare v_profile public.ops_profiles%rowtype; v_ids uuid[]; begin
  perform ops_private.assert_account_admin(p_actor_id);
  select * into v_profile from public.ops_profiles where user_id=p_user_id for update;
  if not found then raise exception 'account_not_found'; end if;
  if p_user_id=p_actor_id or v_profile.role not in ('store','partner') then raise exception 'account_protected'; end if;
  if not v_profile.active then raise exception 'account_inactive'; end if;
  v_ids:=ops_private.validate_account_stores(v_profile.role,p_store_ids);
  -- Fixed shared login names keep their original store binding.
  if v_profile.is_legacy_shared then raise exception 'shared_store_fixed'; end if;
  delete from public.ops_store_memberships where user_id=p_user_id;
  insert into public.ops_store_memberships(user_id,store_id) select p_user_id,unnest(v_ids);
  update public.ops_profiles set store_id=case when role='store' then v_ids[1] else null end where user_id=p_user_id;
  return ops_private.account_json(p_user_id);
end $$;

create function public.ops_admin_accounts_deactivate(p_actor_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$ declare v_profile public.ops_profiles%rowtype; begin
  perform ops_private.assert_account_admin(p_actor_id);
  select * into v_profile from public.ops_profiles where user_id=p_user_id for update;
  if not found then raise exception 'account_not_found'; end if;
  if p_user_id=p_actor_id or v_profile.role not in ('store','partner') then raise exception 'account_protected'; end if;
  update public.ops_profiles set active=false where user_id=p_user_id;
  -- Do not delete Auth or operational history. Old JWTs immediately fail live RLS.
  delete from public.ops_push_subscriptions where user_id=p_user_id;
  return ops_private.account_json(p_user_id);
end $$;

revoke all on function ops_private.assert_account_admin(uuid),ops_private.validate_account_stores(text,uuid[]),ops_private.account_json(uuid) from public,anon,authenticated;
revoke all on function public.ops_admin_accounts_list(uuid),public.ops_admin_accounts_reserve(uuid,uuid,text,text,text,uuid[]),
  public.ops_admin_accounts_finalize(uuid,uuid,uuid),public.ops_admin_accounts_assign(uuid,uuid,uuid[]),public.ops_admin_accounts_deactivate(uuid,uuid) from public,anon,authenticated;
grant execute on function public.ops_admin_accounts_list(uuid),public.ops_admin_accounts_reserve(uuid,uuid,text,text,text,uuid[]),
  public.ops_admin_accounts_finalize(uuid,uuid,uuid),public.ops_admin_accounts_assign(uuid,uuid,uuid[]),public.ops_admin_accounts_deactivate(uuid,uuid) to service_role;

-- Rebuild privileged operations with live active checks.
create or replace function ops_private.queue_ticket_created_notification()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  insert into public.ops_notifications(recipient_id,ticket_id,kind,title,body,priority,dedupe_key,data)
  select p.user_id,new.id,'new_ticket',
    case when new.priority='urgent' then 'Urgent new ticket' else 'New store ticket' end,
    s.name||' - '||new.title,
    case when new.priority='urgent' then 'urgent' else 'normal' end,
    'new_ticket:'||new.id::text||':'||p.user_id::text,
    jsonb_build_object('store_id',new.store_id,'ticket_no',new.ticket_no)
  from public.ops_profiles p join public.ops_stores s on s.id=new.store_id
  where p.active and p.role in ('admin','hq')
  on conflict(dedupe_key) do nothing;
  return new;
end $$;

create or replace function ops_private.queue_reopen_notification()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  insert into public.ops_ticket_events(ticket_id,actor_id,event_type,message,details)
  values(new.ticket_id,new.requested_by,'reopen_requested','Store requested ticket to be reopened',jsonb_build_object('request_id',new.id,'reason',new.reason));
  insert into public.ops_notifications(recipient_id,ticket_id,kind,title,body,priority,dedupe_key,data)
  select p.user_id,new.ticket_id,'reopen_requested','Store requested reopen',s.name||' - '||t.title,'normal',
    'reopen_requested:'||new.id::text||':'||p.user_id::text,
    jsonb_build_object('request_id',new.id,'reason',new.reason)
  from public.ops_profiles p join public.ops_tickets t on t.id=new.ticket_id join public.ops_stores s on s.id=new.store_id
  where p.active and p.role in ('admin','hq')
  on conflict(dedupe_key) do nothing;
  return new;
end $$;

create or replace function ops_private.generate_reminders()
returns void language plpgsql security definer set search_path=''
as $$
begin
  insert into public.ops_notifications(recipient_id,ticket_id,kind,title,body,priority,dedupe_key,data)
  select p.user_id,t.id,'urgent_unaccepted','Urgent ticket still unaccepted',s.name||' - '||t.title,'urgent',
    'urgent_unaccepted:'||t.id::text||':'||p.user_id::text||':'||floor(extract(epoch from (now()-(t.created_at+interval '1 hour')))/10800)::bigint::text,
    jsonb_build_object('store_id',t.store_id,'ticket_no',t.ticket_no)
  from public.ops_tickets t join public.ops_stores s on s.id=t.store_id cross join public.ops_profiles p
  where p.active and p.role in ('admin','hq') and t.priority='urgent' and t.status='new' and now()>=t.created_at+interval '1 hour'
  on conflict(dedupe_key) do nothing;

  insert into public.ops_notifications(recipient_id,ticket_id,kind,title,body,priority,dedupe_key,data)
  select p.user_id,t.id,'normal_unaccepted','Ticket still unaccepted',s.name||' - '||t.title,'normal',
    'normal_unaccepted:'||t.id::text||':'||p.user_id::text||':'||floor(extract(epoch from (now()-(t.created_at+interval '24 hours')))/86400)::bigint::text,
    jsonb_build_object('store_id',t.store_id,'ticket_no',t.ticket_no)
  from public.ops_tickets t join public.ops_stores s on s.id=t.store_id cross join public.ops_profiles p
  where p.active and p.role in ('admin','hq') and t.priority='normal' and t.status='new' and now()>=t.created_at+interval '24 hours'
  on conflict(dedupe_key) do nothing;

  insert into public.ops_notifications(recipient_id,ticket_id,kind,title,body,priority,dedupe_key,data)
  select p.user_id,t.id,'due_soon','Ticket due soon',s.name||' - '||t.title,'normal',
    'due_soon:'||t.id::text||':'||p.user_id::text,jsonb_build_object('due_at',t.due_at,'store_id',t.store_id)
  from public.ops_tickets t join public.ops_stores s on s.id=t.store_id cross join public.ops_profiles p
  where p.active and p.role in ('admin','hq') and t.status<>'completed' and t.due_at is not null and t.due_at>now() and t.due_at<=now()+interval '24 hours'
  on conflict(dedupe_key) do nothing;

  insert into public.ops_notifications(recipient_id,ticket_id,kind,title,body,priority,dedupe_key,data)
  select p.user_id,t.id,'overdue','Ticket overdue',s.name||' - '||t.title,case when t.priority='urgent' then 'urgent' else 'normal' end,
    'overdue:'||t.id::text||':'||p.user_id::text||':'||((now() at time zone 'Australia/Sydney')::date)::text,
    jsonb_build_object('due_at',t.due_at,'store_id',t.store_id)
  from public.ops_tickets t join public.ops_stores s on s.id=t.store_id cross join public.ops_profiles p
  where p.active and p.role in ('admin','hq') and t.status<>'completed' and t.due_at is not null and t.due_at<now()
  on conflict(dedupe_key) do nothing;

  insert into public.ops_notifications(recipient_id,ticket_id,kind,title,body,priority,dedupe_key,data)
  select p.user_id,t.id,'follow_up_due','Waiting follow-up due',s.name||' - '||t.title,'normal',
    'follow_up_due:'||t.id::text||':'||p.user_id::text||':'||floor(extract(epoch from (now()-t.follow_up_at))/10800)::bigint::text,
    jsonb_build_object('follow_up_at',t.follow_up_at,'waiting_reason',t.waiting_reason,'store_id',t.store_id)
  from public.ops_tickets t join public.ops_stores s on s.id=t.store_id cross join public.ops_profiles p
  where p.active and p.role in ('admin','hq') and t.status='waiting' and t.follow_up_at is not null and t.follow_up_at<=now()
  on conflict(dedupe_key) do nothing;
end $$;

create or replace function public.ops_review_reopen_request(p_request_id uuid,p_approve boolean)
returns void language plpgsql security definer set search_path=''
as $$
declare v_role text; v_req public.ops_reopen_requests%rowtype;
begin
  select p.role into v_role from public.ops_profiles p where p.user_id=(select auth.uid()) and p.active;
  if v_role is null or v_role not in ('admin','hq') then raise exception 'Admin or HQ role required'; end if;
  select * into v_req from public.ops_reopen_requests where id=p_request_id for update;
  if not found then raise exception 'Reopen request not found'; end if;
  if v_req.status<>'pending' then raise exception 'Reopen request already reviewed'; end if;
  update public.ops_reopen_requests set status=case when p_approve then 'approved' else 'rejected' end,reviewed_by=(select auth.uid()),reviewed_at=now() where id=p_request_id;
  if p_approve then
    update public.ops_tickets set status='in_progress' where id=v_req.ticket_id;
    insert into public.ops_ticket_events(ticket_id,actor_id,event_type,message,details)
    values(v_req.ticket_id,(select auth.uid()),'reopened','Ticket reopened after store request',jsonb_build_object('request_id',p_request_id));
  else
    insert into public.ops_ticket_events(ticket_id,actor_id,event_type,message,details)
    values(v_req.ticket_id,(select auth.uid()),'reopen_rejected','Store reopen request rejected',jsonb_build_object('request_id',p_request_id));
  end if;
end $$;

commit;
