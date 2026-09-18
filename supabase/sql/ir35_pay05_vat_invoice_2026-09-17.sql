-- =====================================================================
-- ir35_pay05_vat_invoice_2026-09-17.sql  —  IR35 Workbench PAY-05: contractor VAT invoice (database half)
-- Supabase project Orsted-IR35 (feevwggvgnhtikotixih). Author: Archie, 17 Sep 2026.
-- Brief: AI Platform/Sessions/BRIEF_2026-09-17_Archie_IR35_Workbench_VAT_Invoice_Template.md (Olivia, Aaron-approved)
-- Paste at https://supabase.com/dashboard/project/feevwggvgnhtikotixih/sql/new
-- SUCCESS WITH NO ERROR IS THE PROOF - Supabase hides "raise notice".
--
-- What this does
--  1. payments gains: the billing details captured at checkout (name, email, optional company,
--     address, VAT number), what Revolut confirmed (amount, currency, method label), and the
--     ISSUED INVOICE - its data snapshot, the PDF (base64) and its sha256 - plus email-delivery state.
--     The PDF lives in the table, not in Storage: Storage is not covered by point-in-time recovery.
--  2. An issued invoice can never be changed or re-rendered (trigger). Corrections = credit note.
--  3. fulfil_payment() now takes what Revolut says the order is (amount, currency, state, method)
--     and allocates the invoice number ONLY when that amount equals the price on the payments row
--     (brief section 3.2). A mismatch issues nothing, parks the payment in state 'review' and tells
--     the caller to alert Ascend. The old 7-argument version is dropped (no overload).
--  4. store_invoice(), claim_invoice_email(), record_invoice_email() - service role only - are the
--     only ways to write an invoice or its delivery record.
-- Numbering is unchanged: next_invoice_number() inside fulfil_payment(), counter at 99 -> IRW-000100.
-- =====================================================================
begin;

-- 1. columns ---------------------------------------------------------------
alter table public.payments
  add column if not exists bill_full_name          text,
  add column if not exists bill_email              text,
  add column if not exists bill_company_name       text,
  add column if not exists bill_address_lines      text[],
  add column if not exists bill_vat_number         text,
  add column if not exists confirmed_amount        integer,
  add column if not exists confirmed_currency      text,
  add column if not exists payment_method_label    text,
  add column if not exists invoice_data            jsonb,
  add column if not exists invoice_pdf_b64         text,
  add column if not exists invoice_pdf_sha256      text,
  add column if not exists invoice_issued_at       timestamptz,
  add column if not exists invoice_email_claimed_at timestamptz,
  add column if not exists invoice_emailed_at      timestamptz,
  add column if not exists invoice_email_id        text,
  add column if not exists invoice_email_error     text,
  add column if not exists review_reason           text;

alter table public.payments drop constraint if exists payments_state_check;
alter table public.payments add constraint payments_state_check check (state = any (array[
  'pending','completed','failed','expired','refunded','credited','review']));

alter table public.payments drop constraint if exists payments_amounts_ck;
alter table public.payments add constraint payments_amounts_ck check (
  amount_gross = amount_net + vat_amount and vat_amount = round(amount_net * 0.2));

create or replace function public.wb_bill_lines_ok(p text[])
returns boolean language sql immutable as $$
  select p is null or (cardinality(p) <= 4 and coalesce((select max(length(l)) from unnest(p) l), 0) <= 35);
$$;

alter table public.payments drop constraint if exists payments_bill_ck;
alter table public.payments add constraint payments_bill_ck check (
      (bill_company_name  is null or length(bill_company_name)  <= 50)
  and (bill_vat_number    is null or length(bill_vat_number)    <= 20)
  and public.wb_bill_lines_ok(bill_address_lines));

alter table public.payments drop constraint if exists payments_invoice_complete_ck;
alter table public.payments add constraint payments_invoice_complete_ck check (
  invoice_pdf_b64 is null
  or (invoice_number is not null and invoice_data is not null and invoice_pdf_sha256 is not null and invoice_issued_at is not null));

comment on column public.payments.invoice_pdf_b64 is
  'PAY-05. The issued VAT invoice PDF, base64. Immutable once set. The contractor download and the email attachment are both this value.';
comment on column public.payments.invoice_data is
  'PAY-05. JSON snapshot of exactly what was printed on the invoice. Never re-render from live data.';

-- 2. immutability -----------------------------------------------------------
create or replace function public.wb_invoice_immutable()
returns trigger
language plpgsql
as $$
begin
  if old.invoice_number is not null and new.invoice_number is distinct from old.invoice_number then
    raise exception 'invoice % is issued - its number cannot change', old.invoice_number using errcode = '42501';
  end if;
  if old.invoice_pdf_b64 is not null and (
       new.invoice_pdf_b64    is distinct from old.invoice_pdf_b64
    or new.invoice_data       is distinct from old.invoice_data
    or new.invoice_pdf_sha256 is distinct from old.invoice_pdf_sha256
    or new.invoice_issued_at  is distinct from old.invoice_issued_at
    or new.amount_net   is distinct from old.amount_net
    or new.vat_amount   is distinct from old.vat_amount
    or new.amount_gross is distinct from old.amount_gross
    or new.bill_full_name    is distinct from old.bill_full_name
    or new.bill_email        is distinct from old.bill_email
    or new.bill_company_name is distinct from old.bill_company_name
    or new.bill_address_lines is distinct from old.bill_address_lines
    or new.bill_vat_number   is distinct from old.bill_vat_number) then
    raise exception 'invoice % is issued and cannot be altered - issue a credit note instead', old.invoice_number
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists payments_invoice_immutable on public.payments;
create trigger payments_invoice_immutable
  before update on public.payments
  for each row execute function public.wb_invoice_immutable();

-- 3. fulfil_payment with the Revolut amount check ----------------------------
drop function if exists public.fulfil_payment(text, text, text, text, text, text, text);

create or replace function public.fulfil_payment(
  p_client_id                 text,
  p_revolut_order_id          text,
  p_event_type                text,
  p_idempotency_key           text,
  p_revolut_request_timestamp text,
  p_raw_payload               text,
  p_payment_method            text    default null,
  p_order_amount              integer default null,
  p_order_currency            text    default null,
  p_order_state               text    default null,
  p_payment_method_label      text    default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_payment public.payments; v_inv bigint; v_ent_id uuid; v_first boolean;
begin
  -- idempotency gate (brief S5d.1): record the event; an exact duplicate stops here.
  insert into public.payment_events(client_id, idempotency_key, event_type, order_id,
                                    revolut_request_timestamp, raw_payload, processed_at)
  values (p_client_id, p_idempotency_key, p_event_type, p_revolut_order_id,
          p_revolut_request_timestamp, p_raw_payload, now())
  on conflict (idempotency_key) do nothing;
  if not found then
    select * into v_payment from public.payments
     where client_id = p_client_id and revolut_order_id = p_revolut_order_id;
    return jsonb_build_object('ok', true, 'duplicate', true, 'payment_id', v_payment.id,
                              'state', v_payment.state, 'invoice_number', v_payment.invoice_number);
  end if;

  if p_event_type <> 'ORDER_COMPLETED' then
    return jsonb_build_object('ok', true, 'recorded_only', true, 'event_type', p_event_type);
  end if;

  select * into v_payment from public.payments
    where client_id = p_client_id and revolut_order_id = p_revolut_order_id for update;
  if not found then
    raise exception 'fulfil_payment: no payment for order % in %', p_revolut_order_id, p_client_id;
  end if;
  if v_payment.state = 'completed' then
    return jsonb_build_object('ok', true, 'already_completed', true, 'payment_id', v_payment.id,
                              'invoice_number', v_payment.invoice_number);
  end if;
  if v_payment.state = 'review' then
    return jsonb_build_object('ok', false, 'review', true, 'first_alert', false, 'payment_id', v_payment.id,
                              'reason', v_payment.review_reason);
  end if;

  -- What Revolut says must be known, and complete.
  if p_order_amount is null or p_order_currency is null or p_order_state is null then
    raise exception 'fulfil_payment: the Revolut order details are required (amount, currency, state)';
  end if;
  if lower(p_order_state) <> 'completed' then
    raise exception 'fulfil_payment: order % is %, not completed - not fulfilled yet', p_revolut_order_id, p_order_state;
  end if;

  -- Brief S3.2: the amount taken must be exactly the price on this payment. Otherwise issue nothing.
  if p_order_amount <> v_payment.amount_gross or upper(p_order_currency) <> v_payment.currency then
    update public.payments
       set state = 'review',
           confirmed_amount = p_order_amount, confirmed_currency = upper(p_order_currency),
           review_reason = format('Revolut took %s %s; the price on this payment is %s %s',
                                  p_order_amount, upper(p_order_currency), v_payment.amount_gross, v_payment.currency)
     where id = v_payment.id;
    insert into public.audit_log(client_id, entity, event_type, actor, detail)
    values (v_payment.client_id, v_payment.worker_ref, 'Payment amount mismatch', 'Revolut webhook',
            format('Order %s: Revolut took %s %s, the price was %s %s. No invoice issued and the questionnaire was not unlocked. Ascend alerted.',
                   p_revolut_order_id, p_order_amount, upper(p_order_currency), v_payment.amount_gross, v_payment.currency));
    return jsonb_build_object('ok', false, 'review', true, 'first_alert', true, 'payment_id', v_payment.id,
                              'expected', v_payment.amount_gross, 'received', p_order_amount,
                              'currency', upper(p_order_currency));
  end if;

  v_inv := public.next_invoice_number();

  update public.payments
     set state = 'completed',
         payment_method = coalesce(p_payment_method, payment_method),
         payment_method_label = coalesce(p_payment_method_label, payment_method_label),
         confirmed_amount = p_order_amount, confirmed_currency = upper(p_order_currency),
         invoice_number = v_inv, paid_at = now(), fulfilled_at = now()
   where id = v_payment.id;

  insert into public.entitlements(client_id, worker_id, worker_ref, unlocked_by, payment_id)
  values (v_payment.client_id, v_payment.worker_id, v_payment.worker_ref, 'payment', v_payment.id)
  on conflict (client_id, worker_id) do nothing
  returning id into v_ent_id;

  -- Convention 1: read the entitlement back and assert it persisted.
  if v_ent_id is null then
    select id into v_ent_id from public.entitlements
      where client_id = v_payment.client_id and worker_id = v_payment.worker_id;
    if v_ent_id is null then
      raise exception 'fulfil_payment: entitlement did not persist for %', v_payment.worker_ref;
    end if;
  end if;

  insert into public.audit_log(client_id, entity, event_type, actor, detail)
  values (v_payment.client_id, v_payment.worker_ref, 'Payment fulfilled', 'Revolut webhook',
          jsonb_build_object('order_id', p_revolut_order_id,
                             'invoice_number', v_inv, 'payment_id', v_payment.id,
                             'amount', p_order_amount)::text);

  return jsonb_build_object('ok', true, 'payment_id', v_payment.id,
                            'invoice_number', v_inv, 'entitlement_id', v_ent_id);
end; $function$;

revoke all on function public.fulfil_payment(text,text,text,text,text,text,text,integer,text,text,text) from public, anon, authenticated;
grant execute on function public.fulfil_payment(text,text,text,text,text,text,text,integer,text,text,text) to service_role;

-- 4. store the issued invoice (once) ------------------------------------------
create or replace function public.store_invoice(p_payment_id uuid, p_data jsonb, p_pdf_b64 text, p_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare p public.payments; v_sha text;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if not found then raise exception 'store_invoice: no payment %', p_payment_id; end if;
  if p.invoice_pdf_b64 is not null then
    return jsonb_build_object('ok', true, 'already_stored', true, 'sha256', p.invoice_pdf_sha256);
  end if;
  if p.state <> 'completed' or p.invoice_number is null then
    raise exception 'store_invoice: payment % is not completed with an invoice number', p_payment_id;
  end if;
  if coalesce((p_data ->> 'invoice_seq')::bigint, -1) <> p.invoice_number then
    raise exception 'store_invoice: snapshot is for invoice %, the payment holds %', p_data ->> 'invoice_seq', p.invoice_number;
  end if;
  if coalesce((p_data ->> 'gross_pence')::integer, -1) <> p.amount_gross then
    raise exception 'store_invoice: snapshot gross % does not match the payment %', p_data ->> 'gross_pence', p.amount_gross;
  end if;
  v_sha := encode(sha256(decode(p_pdf_b64, 'base64')), 'hex');
  if v_sha <> lower(p_sha256) then
    raise exception 'store_invoice: PDF hash mismatch (received %, computed %)', p_sha256, v_sha;
  end if;
  if substring(decode(p_pdf_b64, 'base64') from 1 for 5) <> '\x255044462d'::bytea then
    raise exception 'store_invoice: that is not a PDF';
  end if;

  update public.payments
     set invoice_data = p_data, invoice_pdf_b64 = p_pdf_b64,
         invoice_pdf_sha256 = v_sha, invoice_issued_at = now()
   where id = p_payment_id;

  insert into public.audit_log(client_id, entity, event_type, actor, detail)
  values (p.client_id, p.worker_ref, 'VAT invoice issued', 'System',
          format('Invoice %s issued for %s pence. PDF sha256 %s.', p_data ->> 'invoice_number', p.amount_gross, v_sha));

  -- Convention 1: read it back.
  select * into p from public.payments where id = p_payment_id;
  if p.invoice_pdf_sha256 is distinct from v_sha or p.invoice_pdf_b64 is distinct from p_pdf_b64 then
    raise exception 'store_invoice: invoice did not persist for payment %', p_payment_id;
  end if;
  return jsonb_build_object('ok', true, 'stored', true, 'sha256', v_sha);
end $$;

revoke all on function public.store_invoice(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.store_invoice(uuid, jsonb, text, text) to service_role;

-- 5. email delivery: claim once, then record ----------------------------------
create or replace function public.claim_invoice_email(p_payment_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare n integer;
begin
  update public.payments
     set invoice_email_claimed_at = now()
   where id = p_payment_id
     and invoice_pdf_b64 is not null
     and invoice_emailed_at is null
     and (invoice_email_claimed_at is null or invoice_email_claimed_at < now() - interval '10 minutes');
  get diagnostics n = row_count;
  return n = 1;
end $$;

create or replace function public.record_invoice_email(p_payment_id uuid, p_message_id text, p_error text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare p public.payments;
begin
  if p_error is null then
    update public.payments
       set invoice_emailed_at = now(), invoice_email_id = p_message_id, invoice_email_error = null
     where id = p_payment_id returning * into p;
  else
    update public.payments
       set invoice_email_claimed_at = null, invoice_email_error = left(p_error, 500)
     where id = p_payment_id returning * into p;
  end if;
  if not found then raise exception 'record_invoice_email: no payment %', p_payment_id; end if;
  insert into public.audit_log(client_id, entity, event_type, actor, detail)
  values (p.client_id, p.worker_ref,
          case when p_error is null then 'VAT invoice emailed' else 'VAT invoice email failed' end, 'System',
          case when p_error is null
               then format('Invoice %s handed to the email service for %s (message %s).', p.invoice_data ->> 'invoice_number', p.bill_email, p_message_id)
               else format('Invoice %s NOT sent: %s', p.invoice_data ->> 'invoice_number', left(p_error, 300)) end);
end $$;

revoke all on function public.claim_invoice_email(uuid) from public, anon, authenticated;
revoke all on function public.record_invoice_email(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_invoice_email(uuid) to service_role;
grant execute on function public.record_invoice_email(uuid, text, text) to service_role;

-- 6. self-checks ------------------------------------------------------------------
do $chk$
declare n integer;
begin
  select count(*) into n from pg_proc where pronamespace = 'public'::regnamespace and proname = 'fulfil_payment';
  if n <> 1 then raise exception 'self-check: fulfil_payment has % definitions', n; end if;
  if has_function_privilege('authenticated', 'public.fulfil_payment(text,text,text,text,text,text,text,integer,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.store_invoice(uuid,jsonb,text,text)', 'execute')
     or has_function_privilege('anon', 'public.store_invoice(uuid,jsonb,text,text)', 'execute') then
    raise exception 'self-check: an invoice function is callable from the browser';
  end if;
  select count(*) into n from pg_trigger where tgname = 'payments_invoice_immutable' and not tgisinternal;
  if n <> 1 then raise exception 'self-check: immutability trigger missing'; end if;
  select count(*) into n from pg_constraint where conname = 'payments_invoice_number_key';
  if n <> 1 then raise exception 'self-check: unique invoice number constraint missing'; end if;
  select last_number into n from public.invoice_sequence where id = 1;
  if n < 99 then raise exception 'self-check: invoice counter is %, first invoice would not be IRW-000100', n; end if;
end $chk$;

commit;
