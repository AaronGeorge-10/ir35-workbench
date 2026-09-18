-- =====================================================================================
-- IR35 Workbench - PAY-06 internal test tier (Ascend staff test the live platform free)
-- Aaron, 18 Sep 2026: domains ascend-people.ai and ascend-people.com.
-- Built on the LIVE definitions (md5 checked 18 Sep: wb_payment_quote d311b288..., contractor_payment_state c68b1a89...).
-- Safe to re-run. Paywall setting is NOT touched.
-- =====================================================================================
begin;

-- 0. Refuse to run if either function has changed since it was checked.
do $pre$
begin
  if (select md5(replace(prosrc, chr(13), '')) from pg_proc
       where pronamespace = 'public'::regnamespace and proname = 'wb_payment_quote') not in
     ('d311b2884e6db7fe98e6681f3eaf82d5') and not exists (select 1 from information_schema.columns
       where table_schema='public' and table_name='clients' and column_name='test_email_domains') then
    raise exception 'wb_payment_quote has changed since 18 Sep - stop and tell Archie';
  end if;
  if (select md5(replace(prosrc, chr(13), '')) from pg_proc
       where pronamespace = 'public'::regnamespace and proname = 'contractor_payment_state') not in
     ('c68b1a89f7b8c4da3d9e1dd2cd819416') and not exists (select 1 from information_schema.columns
       where table_schema='public' and table_name='clients' and column_name='test_email_domains') then
    raise exception 'contractor_payment_state has changed since 18 Sep - stop and tell Archie';
  end if;
end $pre$;

-- 1. Per-client list of internal test email domains. Only settable by SQL
--    (public.clients has row level security with a SELECT-only policy for users).
alter table public.clients add column if not exists test_email_domains text[] not null default '{}';
comment on column public.clients.test_email_domains is
  'PAY-06. Workers whose email domain is listed here are internal Ascend tests: never charged, unlocked_by = internal_test.';
update public.clients set test_email_domains = array['ascend-people.ai','ascend-people.com']
 where client_id = 'orsted';

-- 2. New unlock reason.
alter table public.entitlements drop constraint if exists entitlements_unlocked_by_check;
alter table public.entitlements add constraint entitlements_unlocked_by_check
  check (unlocked_by = any (array['payment','free_tier','orsted_waiver','internal_test']));

-- 3. The single pricing rule, with the internal test tier.
create or replace function public.wb_payment_quote(p_worker_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  w public.workers%rowtype;
  c public.clients%rowtype;
  v_prior boolean;
begin
  select * into w from public.workers where id = p_worker_id;
  if not found then
    raise exception 'wb_payment_quote: no worker %', p_worker_id using errcode = 'P0002';
  end if;

  select * into c from public.clients where client_id = w.client_id;
  if not found or not c.paywall_enabled
     or c.paywall_from is null or w.created_at < c.paywall_from then
    return jsonb_build_object('required', false, 'tier', null, 'reason', 'paywall_off');
  end if;

  -- PAY-06: internal test tier. A worker whose email is on one of this client's internal test
  -- domains (Ascend staff testing the live platform) is never charged and never reaches checkout.
  -- Recorded as 'internal_test', never as a client waiver, so the client's audit trail stays honest.
  if w.worker_email is not null
     and lower(split_part(w.worker_email, '@', 2)) = any (coalesce(c.test_email_domains, '{}'::text[])) then
    return jsonb_build_object('required', false, 'tier', 'internal_test', 'reason', 'internal_test');
  end if;

  -- Free tier: engaged through Ascend payroll. Never reaches checkout.
  if w.engagement_route = 'ascend_payroll' then
    return jsonb_build_object('required', false, 'tier', 'free', 'reason', 'ascend_payroll');
  end if;

  -- Reassessment: this contractor's email was assessed before, for this client.
  select exists (
    select 1 from public.workers p
     where p.client_id = w.client_id
       and p.id <> w.id
       and p.created_at < w.created_at
       and w.worker_email is not null
       and lower(p.worker_email) = lower(w.worker_email)
       and (exists (select 1 from public.entitlements e where e.worker_id = p.id)
            or exists (select 1 from public.sds s
                        where s.client_id = p.client_id and s.worker_ref = p.worker_ref))
  ) into v_prior;

  if v_prior then
    return jsonb_build_object('required', true, 'tier', 'reassessment',
      'net', 6500, 'vat', 1300, 'gross', 7800, 'currency', 'GBP');
  end if;
  return jsonb_build_object('required', true, 'tier', 'first',
    'net', 7500, 'vat', 1500, 'gross', 9000, 'currency', 'GBP');
end $$;

revoke all on function public.wb_payment_quote(uuid) from public, anon, authenticated;
grant execute on function public.wb_payment_quote(uuid) to service_role;

-- 4. What the contractor's screen asks, with the internal test tier.
create or replace function public.contractor_payment_state()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_role   text := auth.jwt() -> 'app_metadata' ->> 'role';
  v_client text := auth.jwt() -> 'app_metadata' ->> 'tenant';
  v_ref    text := auth.jwt() -> 'app_metadata' ->> 'worker_ref';
  w public.workers%rowtype;
  e public.entitlements%rowtype;
  v_q jsonb;
  v_last text;
begin
  if coalesce(auth.jwt() ->> 'aal', '') not in ('aal1','aal2')
     or coalesce(v_role, '') <> 'contractor' then
    raise exception 'this is for contractors only' using errcode = '42501';
  end if;
  if coalesce(v_client, '') = '' or coalesce(v_ref, '') = '' then
    raise exception 'this account is not linked to an engagement' using errcode = '42501';
  end if;

  select * into w from public.workers where client_id = v_client and worker_ref = v_ref;
  if not found then
    raise exception 'no assessment on the register for %', v_ref using errcode = 'P0002';
  end if;

  select * into e from public.entitlements where client_id = v_client and worker_id = w.id;
  if found then
    return jsonb_build_object('unlocked', true, 'unlocked_by', e.unlocked_by, 'worker_ref', v_ref);
  end if;

  v_q := public.wb_payment_quote(w.id);

  if v_q ->> 'tier' = 'internal_test' then
    insert into public.entitlements (client_id, worker_id, worker_ref, unlocked_by)
    values (v_client, w.id, v_ref, 'internal_test')
    on conflict (client_id, worker_id) do nothing;
    insert into public.audit_log (client_id, entity, event_type, actor, detail)
    values (v_client, v_ref, 'Assessment fee not applicable', 'System',
            'Internal Ascend test account - no fee. Questionnaire unlocked without checkout.');
    return jsonb_build_object('unlocked', true, 'unlocked_by', 'internal_test', 'worker_ref', v_ref);
  end if;

  if v_q ->> 'tier' = 'free' then
    insert into public.entitlements (client_id, worker_id, worker_ref, unlocked_by)
    values (v_client, w.id, v_ref, 'free_tier')
    on conflict (client_id, worker_id) do nothing;
    insert into public.audit_log (client_id, entity, event_type, actor, detail)
    values (v_client, v_ref, 'Assessment fee not applicable', 'System',
            'Engaged through Ascend payroll - no fee. Questionnaire unlocked without checkout.');
    return jsonb_build_object('unlocked', true, 'unlocked_by', 'free_tier', 'worker_ref', v_ref);
  end if;

  if not coalesce((v_q ->> 'required')::boolean, false) then
    return jsonb_build_object('unlocked', true, 'unlocked_by', 'not_required', 'worker_ref', v_ref);
  end if;

  select state into v_last from public.payments
   where client_id = v_client and worker_id = w.id
   order by created_at desc limit 1;

  return v_q || jsonb_build_object('unlocked', false, 'worker_ref', v_ref, 'last_payment_state', v_last);
end $$;

revoke all on function public.contractor_payment_state() from public, anon;
grant execute on function public.contractor_payment_state() to authenticated;

-- 5. Self-checks. Any failure rolls the whole thing back.
do $chk$
declare v text[];
begin
  select test_email_domains into v from public.clients where client_id = 'orsted';
  if v is distinct from array['ascend-people.ai','ascend-people.com'] then
    raise exception 'self-check: orsted test domains not set';
  end if;
  if position('internal_test' in (select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='wb_payment_quote')) = 0 then
    raise exception 'self-check: wb_payment_quote not updated';
  end if;
  if position('internal_test' in (select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='contractor_payment_state')) = 0 then
    raise exception 'self-check: contractor_payment_state not updated';
  end if;
  if has_function_privilege('authenticated', 'public.wb_payment_quote(uuid)', 'execute') then
    raise exception 'self-check: wb_payment_quote must not be callable by users';
  end if;
  -- Users must not be able to edit clients (and so the test domains). Supabase grants table
  -- privileges by default; row level security is what blocks writes, so check that instead.
  if not (select relrowsecurity from pg_class where oid = 'public.clients'::regclass) then
    raise exception 'self-check: row level security is off on clients';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'clients'
              and cmd <> 'SELECT') then
    raise exception 'self-check: a policy lets users write to clients';
  end if;
end $chk$;

commit;

select client_id, paywall_enabled, test_email_domains from public.clients where client_id = 'orsted';
