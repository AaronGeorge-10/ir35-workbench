-- =====================================================================
-- ir35_pay04b_engagement_routes_2026-09-17.sql  —  engagement routes (Aaron, 17 Sep 2026)
-- Supabase project Orsted-IR35 (feevwggvgnhtikotixih). Author: Archie.
-- Paste at https://supabase.com/dashboard/project/feevwggvgnhtikotixih/sql/new AFTER
-- ir35_pay04_paywall_rules_2026-09-17.sql. No error = pass.
--
-- The line manager now chooses one of three:
--   'fms'            YunoJuno (replaces "Direct with Ørsted" AND "Through the managed service provider")
--   'agency'         Through a recruitment agency (agency name + email required)
--   'ascend_payroll' Through Ascend payroll - no fee (PAY-04); Ascend is the fee-payer, so
--                    the statement goes to payroll@ascend-people.com. Set HERE, server-side,
--                    whatever the browser sends, so nobody can divert a statement.
-- 'umbrella' is withdrawn: umbrella workers are the umbrella's PAYE employees, so Chapter 10
-- does not apply and there is nothing to determine (Aaron, 17 Sep). No worker uses it.
-- 'direct' is no longer accepted for NEW records; the 5 existing 'direct' rows stay valid.
-- Built from the LIVE definitions exported 17 Sep (same signatures - replaced, not overloaded).
-- =====================================================================
begin;

do $pre$
begin
  if exists (select 1 from public.workers where engagement_route = 'umbrella') then
    raise exception 'a worker is recorded as umbrella - resolve it before withdrawing the route';
  end if;
end $pre$;

alter table public.workers drop constraint if exists workers_route_ck;
alter table public.workers add constraint workers_route_ck check (
  engagement_route is null
  or engagement_route in ('direct','agency','fms','ascend_payroll'));
comment on column public.workers.engagement_route is
  'fms = the client''s managed service provider (Ørsted: YunoJuno); agency = through a recruitment agency; ascend_payroll = Ascend is the fee-payer, no assessment fee (PAY-04). direct = legacy, not accepted for new records.';

create or replace function public.set_engagement_details(p_worker_ref text, p_route text, p_agency_name text DEFAULT NULL::text, p_agency_email text DEFAULT NULL::text, p_line_manager_email text DEFAULT NULL::text, p_start_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role   text := auth.jwt() -> 'app_metadata' ->> 'role';
  v_client text := auth.jwt() -> 'app_metadata' ->> 'tenant';
  v_w public.workers%rowtype;
  v_n integer;
  -- Ascend as fee-payer. Fixed here so the browser cannot redirect the statement.
  c_ascend_name  constant text := 'Ascend People Solutions Ltd';
  c_ascend_email constant text := 'payroll@ascend-people.com';
  v_fp_name  text;
  v_fp_email text;
begin
  if coalesce(auth.jwt() ->> 'aal','') <> 'aal2' then
    raise exception 'MFA required' using errcode='42501'; end if;
  if v_role is null or v_role = '' or v_role = 'contractor' then
    raise exception 'only staff record engagement details' using errcode='42501'; end if;
  if p_route is null or p_route not in ('fms','agency','ascend_payroll') then
    raise exception 'engagement route must be the managed service provider (fms), a recruitment agency (agency) or Ascend payroll (ascend_payroll)'
      using errcode='22023'; end if;

  select * into v_w from public.workers
   where client_id = v_client and worker_ref = p_worker_ref for update;
  if not found then
    raise exception 'no worker record for %', p_worker_ref using errcode='P0002'; end if;

  if p_route = 'agency'
     and (coalesce(btrim(p_agency_name),'') = ''
          or position('@' in coalesce(p_agency_email,'')) < 2) then
    raise exception 'an agency engagement needs the agency name and email - they are entitled to the statement'
      using errcode='22023';
  end if;

  if position('@' in coalesce(p_line_manager_email, v_w.line_manager_email, '')) < 2 then
    raise exception 'the line manager email is needed - they receive the statement and load it into the FMS'
      using errcode='22023';
  end if;

  if coalesce(p_start_date, v_w.assignment_start_date) is null then
    raise exception 'the assignment start date is needed - it tells the fee-payer when to apply the tax treatment'
      using errcode='22023';
  end if;

  v_fp_name  := case p_route when 'agency' then btrim(p_agency_name)  when 'ascend_payroll' then c_ascend_name  end;
  v_fp_email := case p_route when 'agency' then btrim(p_agency_email) when 'ascend_payroll' then c_ascend_email end;

  update public.workers
     set engagement_route      = p_route,
         fee_payer_name        = v_fp_name,
         fee_payer_email       = v_fp_email,
         line_manager_email    = coalesce(p_line_manager_email, line_manager_email),
         assignment_start_date = coalesce(p_start_date, assignment_start_date)
   where id = v_w.id;

  select count(*) into v_n from public.client_contacts
   where client_id = v_client and contact_role = 'fms_fee_payer' and active;
  if v_n = 0 then
    raise exception 'this client has no FMS recorded - the FMS is a fee-payer and must receive every statement, so add one to client_contacts first'
      using errcode='22023';
  end if;

  insert into public.audit_log (client_id, entity, event_type, actor, detail)
  values (v_client, p_worker_ref, 'Engagement details recorded',
          coalesce(auth.jwt() ->> 'email', v_role),
          'Route: ' || p_route || '. Starts ' ||
          to_char(coalesce(p_start_date, v_w.assignment_start_date), 'DD Mon YYYY') ||
          '. Parties entitled to the statement: ' ||
          (select string_agg(r.recipient_role, ', ' order by r.recipient_role)
             from public.sds_recipients_for(v_client, p_worker_ref) r) || '.');

  return jsonb_build_object('worker_ref', p_worker_ref, 'route', p_route,
    'start_date', coalesce(p_start_date, v_w.assignment_start_date),
    'recipients', (select count(*) from public.sds_recipients_for(v_client, p_worker_ref)));
end $function$;

create or replace function public.wb_sds_requires_known_chain()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare w public.workers%rowtype; v_n integer;
begin
  select * into w from public.workers
   where client_id = new.client_id and worker_ref = new.worker_ref;
  if not found then
    raise exception 'no worker record for % - cannot issue a statement', new.worker_ref
      using errcode='P0002'; end if;

  if w.engagement_route is null then
    raise exception 'engagement route not recorded for % - the statement must be passed to every party in the chain, so they have to be known before it issues', new.worker_ref
      using errcode='22023'; end if;

  if w.engagement_route in ('agency','umbrella','ascend_payroll')
     and position('@' in coalesce(w.fee_payer_email,'')) < 2 then
    raise exception 'no fee-payer recorded for % - the agency (or Ascend, for Ascend payroll) is entitled to the statement', new.worker_ref
      using errcode='22023'; end if;

  if position('@' in coalesce(w.line_manager_email,'')) < 2 then
    raise exception 'no line manager recorded for % - they receive the statement and load it into the FMS', new.worker_ref
      using errcode='22023'; end if;

  if w.assignment_start_date is null then
    raise exception 'no assignment start date for % - the fee-payer is told to apply the tax treatment from that date, so it cannot be blank', new.worker_ref
      using errcode='22023'; end if;

  select count(*) into v_n from public.client_contacts
   where client_id = new.client_id and contact_role = 'fms_fee_payer' and active;
  if v_n = 0 then
    raise exception 'no FMS recorded for this client - the FMS is a fee-payer and must receive every statement'
      using errcode='22023'; end if;

  return new;
end $function$;

do $chk$
declare n integer;
begin
  select count(*) into n from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'set_engagement_details';
  if n <> 1 then raise exception 'self-check: set_engagement_details has % definitions (overload?)', n; end if;
  if pg_get_functiondef('public.set_engagement_details'::regproc) not like '%ascend_payroll%' then
    raise exception 'self-check: set_engagement_details not replaced'; end if;
  if pg_get_functiondef('public.wb_sds_requires_known_chain'::regproc) not like '%ascend_payroll%' then
    raise exception 'self-check: chain gate not replaced'; end if;
  select count(*) into n from public.workers
   where engagement_route is not null and engagement_route not in ('direct','agency','fms','ascend_payroll');
  if n <> 0 then raise exception 'self-check: % workers on a withdrawn route', n; end if;
end $chk$;

commit;
