-- =====================================================================
-- ir35_pay04_paywall_rules_2026-09-17.sql  —  IR35 Workbench PAY-04 (database half)
-- Supabase project Orsted-IR35 (feevwggvgnhtikotixih). Author: Archie, 17 Sep 2026.
-- Paste at https://supabase.com/dashboard/project/feevwggvgnhtikotixih/sql/new
-- SUCCESS WITH NO ERROR IS THE PROOF - Supabase hides "raise notice".
--
-- What this does
--  1. A per-client paywall switch (clients.paywall_enabled / paywall_from).
--     Nothing is charged until Aaron switches it on. Workers created BEFORE
--     paywall_from are never charged (no retrospective demands).
--  2. FIXES a PAY-01 defect: the contractor read policies on payments and
--     entitlements used wb_tenant_ok(), which requires aal2. Contractors are
--     aal1 (decision 8 Sep), so a contractor could never see their own
--     payment. They now use wb_contractor_ok(), like every other contractor policy.
--  3. wb_payment_quote(worker_id) - the ONE place that decides what a worker
--     pays: not required / free (Ascend payroll) / reassessment £78 / first £90.
--     Reassessment = the same contractor EMAIL was assessed before FOR THIS
--     CLIENT (Aaron 17 Sep: email, no NI number). Service role only.
--  4. contractor_payment_state() - what the contractor's screen asks.
--  5. waive_contractor_payment() - brief §4: the client administrator (or
--     Ascend) proceeds without payment, reason recorded to the audit trail.
--  6. THE GATE, on the TABLE: a contractor submission cannot be recorded for
--     a worker who owes the fee and has no entitlement. Holds whichever
--     function writes the submission, today or later.
-- =====================================================================
begin;

-- 1. Per-client switch --------------------------------------------------
alter table public.clients add column if not exists paywall_enabled boolean not null default false;
alter table public.clients add column if not exists paywall_from    timestamptz;
comment on column public.clients.paywall_enabled is
  'PAY-04. True = contractors of this client pay the assessment fee before their questionnaire unlocks.';
comment on column public.clients.paywall_from is
  'PAY-04. Only workers created at or after this moment are charged. Set when the paywall is switched on.';

-- 2. Contractor read policies (PAY-01 defect) ---------------------------
drop policy if exists entitlements_contractor_read on public.entitlements;
create policy entitlements_contractor_read on public.entitlements
  as permissive for select to authenticated
  using (public.wb_contractor_ok(client_id)
         and worker_ref = (auth.jwt() -> 'app_metadata' ->> 'worker_ref'));

drop policy if exists payments_contractor_read on public.payments;
create policy payments_contractor_read on public.payments
  as permissive for select to authenticated
  using (public.wb_contractor_ok(client_id)
         and worker_ref = (auth.jwt() -> 'app_metadata' ->> 'worker_ref'));

-- 3. The quote ------------------------------------------------------------
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
comment on function public.wb_payment_quote(uuid) is
  'PAY-04. The single pricing rule. Amounts are MINOR UNITS. Called by create-payment-order (service role), contractor_payment_state() and the submission gate.';

-- 4. What the contractor's screen asks -------------------------------------
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

-- 5. Waive and proceed (brief §4) -------------------------------------------
create or replace function public.waive_contractor_payment(p_worker_ref text, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_role   text := auth.jwt() -> 'app_metadata' ->> 'role';
  v_client text := auth.jwt() -> 'app_metadata' ->> 'tenant';
  v_actor  text := coalesce(auth.jwt() ->> 'email', v_role);
  w public.workers%rowtype;
  v_by text;
begin
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'MFA required' using errcode = '42501';
  end if;
  if coalesce(v_role, '') not in ('clientadmin', 'platform') then
    raise exception 'only the client administrator can proceed without payment' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason is required (at least 10 characters) - it is recorded on the audit trail'
      using errcode = '22023';
  end if;

  select * into w from public.workers
   where client_id = v_client and worker_ref = p_worker_ref
   for update;
  if not found then
    raise exception 'no worker record for %', p_worker_ref using errcode = 'P0002';
  end if;

  select unlocked_by into v_by from public.entitlements
   where client_id = v_client and worker_id = w.id;
  if found then
    raise exception '% is already unlocked (%) - nothing to waive', p_worker_ref, v_by
      using errcode = '22023';
  end if;

  insert into public.entitlements (client_id, worker_id, worker_ref, unlocked_by, waiver_reason, waived_by)
  values (v_client, w.id, p_worker_ref, 'orsted_waiver', btrim(p_reason), auth.uid());

  -- An unpaid order must not be taken after a waiver.
  update public.payments set state = 'expired'
   where client_id = v_client and worker_id = w.id and state = 'pending';

  insert into public.audit_log (client_id, entity, event_type, actor, detail)
  values (v_client, p_worker_ref, 'Assessment fee waived', v_actor,
          'Proceeding without payment. Reason: ' || btrim(p_reason));

  return jsonb_build_object('ok', true, 'worker_ref', p_worker_ref, 'unlocked_by', 'orsted_waiver');
end $$;

revoke all on function public.waive_contractor_payment(text, text) from public, anon;
grant execute on function public.waive_contractor_payment(text, text) to authenticated;

-- 6. THE GATE ----------------------------------------------------------------
create or replace function public.wb_submission_requires_entitlement()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_q jsonb;
begin
  if new.contractor_submitted_on is not distinct from old.contractor_submitted_on then
    return new;
  end if;
  if exists (select 1 from public.entitlements
              where client_id = new.client_id and worker_id = new.id) then
    return new;
  end if;
  v_q := public.wb_payment_quote(new.id);
  if coalesce((v_q ->> 'required')::boolean, false) then
    raise exception 'the assessment fee for % has not been paid - the questionnaire unlocks once payment is confirmed', new.worker_ref
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists workers_submission_requires_entitlement on public.workers;
create trigger workers_submission_requires_entitlement
  before update of contractor_submitted_on on public.workers
  for each row execute function public.wb_submission_requires_entitlement();

-- 7. Self-checks. Any failure rolls the whole thing back. ---------------------
do $chk$
declare n integer; v jsonb;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public' and policyname in ('entitlements_contractor_read','payments_contractor_read')
     and qual like '%wb_contractor_ok%';
  if n <> 2 then raise exception 'self-check: contractor policies not repointed (%)', n; end if;

  select count(*) into n from pg_trigger
   where tgname = 'workers_submission_requires_entitlement' and not tgisinternal;
  if n <> 1 then raise exception 'self-check: gate trigger missing'; end if;

  select count(*) into n from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('wb_payment_quote','contractor_payment_state','waive_contractor_payment','wb_submission_requires_entitlement');
  if n <> 4 then raise exception 'self-check: expected 4 functions, found %', n; end if;

  if not has_function_privilege('authenticated', 'public.wb_contractor_ok(text)', 'execute') then
    raise exception 'self-check: authenticated cannot execute wb_contractor_ok, so the contractor policies would fail';
  end if;
  if has_function_privilege('authenticated', 'public.wb_payment_quote(uuid)', 'execute') then
    raise exception 'self-check: wb_payment_quote must not be callable by authenticated';
  end if;
  if has_function_privilege('anon', 'public.contractor_payment_state()', 'execute')
     or has_function_privilege('anon', 'public.waive_contractor_payment(text,text)', 'execute') then
    raise exception 'self-check: anon can execute a paywall function';
  end if;

  -- Paywall is OFF for every client until Aaron switches it on.
  select count(*) into n from public.clients where paywall_enabled;
  if n <> 0 then raise exception 'self-check: a client already has the paywall on'; end if;

  -- With the paywall off, every existing worker quotes as not required.
  select count(*) into n from public.workers w
   where (public.wb_payment_quote(w.id) ->> 'required')::boolean;
  if n <> 0 then raise exception 'self-check: % workers quote as chargeable while the paywall is off', n; end if;
end $chk$;

commit;

-- ---------------------------------------------------------------------
-- TO SWITCH THE PAYWALL ON FOR ØRSTED (separate step - Aaron decides when):
--   update public.clients set paywall_enabled = true, paywall_from = now()
--    where client_id = 'orsted';
-- Only workers created after that moment are charged.
-- TO SWITCH IT OFF:  update public.clients set paywall_enabled = false where client_id = 'orsted';
-- ---------------------------------------------------------------------
