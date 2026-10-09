-- Admin-only store creation. Apply only with the matching Edge handler release.
-- No existing store, profile, membership, Auth identity or operational row changes.
begin;

-- A completed request and its store are committed together; there is no partial setup.
create table ops_private.store_create_requests (
  request_id uuid primary key,
  actor_id uuid not null references public.ops_profiles(user_id),
  name text not null,
  code text not null,
  store_id uuid not null unique references public.ops_stores(id) on delete restrict,
  created_at timestamptz not null default now()
);
alter table ops_private.store_create_requests enable row level security;
revoke all on ops_private.store_create_requests from public,anon,authenticated,service_role;

create function public.ops_admin_stores_create(p_actor_id uuid,p_request_id uuid,p_name text,p_code text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  -- Match JavaScript String.trim(), including non-ASCII space characters.
  v_whitespace constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  v_name text := btrim(p_name,v_whitespace);
  v_code text := btrim(p_code,v_whitespace);
  v_req ops_private.store_create_requests%rowtype;
  v_store public.ops_stores%rowtype;
begin
  perform ops_private.assert_account_admin(p_actor_id);
  if p_request_id is null then raise exception 'invalid_request_id'; end if;
  if v_name is null or char_length(v_name) not between 1 and 100 then raise exception 'invalid_store_name'; end if;
  if v_code is null or v_code !~ '^[A-Za-z0-9]{2,8}$' then raise exception 'invalid_store_code'; end if;
  v_code := upper(v_code);

  -- Same request ID is serialized even when the competing bodies use different codes.
  -- The existing unique code constraint arbitrates different requests for the same code.
  perform pg_advisory_xact_lock(hashtextextended('ops_store_create:'||p_request_id::text,0));
  -- Recheck after waiting and lock the current actor row through commit. A revocation
  -- that already committed cannot be hidden by an earlier Edge profile read.
  perform 1 from public.ops_profiles where user_id=p_actor_id and active and role='admin' for share;
  if not found then raise exception using message='admin_required',errcode='42501'; end if;

  select * into v_req from ops_private.store_create_requests where request_id=p_request_id;
  if found then
    if v_req.actor_id is distinct from p_actor_id or v_req.name is distinct from v_name or v_req.code is distinct from v_code then
      raise exception 'request_conflict';
    end if;
    -- Return the current row without changing its name, code or active state.
    select * into strict v_store from public.ops_stores where id=v_req.store_id;
  else
    insert into public.ops_stores(name,code,active) values(v_name,v_code,true)
      on conflict(code) do nothing returning * into v_store;
    if not found then raise exception 'store_code_exists'; end if;
    insert into ops_private.store_create_requests(request_id,actor_id,name,code,store_id)
      values(p_request_id,p_actor_id,v_name,v_code,v_store.id);
  end if;
  return jsonb_build_object('id',v_store.id,'name',v_store.name,'code',v_store.code,'active',v_store.active);
end $$;

-- Actor IDs are supplied only by the verified Edge handler, never trusted from an
-- ordinary client. Existing table grants, RLS policies and role scopes stay intact.
revoke all on function public.ops_admin_stores_create(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.ops_admin_stores_create(uuid,uuid,text,text) to service_role;

commit;
