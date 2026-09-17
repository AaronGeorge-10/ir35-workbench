-- ir35_pay01_data_layer.sql — IR35 Workbench PAY-01 (contractor paywall data layer)
-- STATUS: APPLIED to Orsted-IR35 (feevwggvgnhtikotixih) on 2026-09-16 via the SQL editor.
-- PROVENANCE: the original script was pasted in chat and never saved. This file was EXPORTED FROM THE
-- LIVE DATABASE CATALOG on 2026-09-17 (pg_attribute / pg_constraint / pg_indexes / pg_policies /
-- pg_get_functiondef), so it is the deployed truth, not a draft. Export body sha256 prefix ba40d2068759.
-- CAVEATS OF A CATALOG EXPORT (read before replaying on a new project):
--   * payment_events.id is an identity column (fulfil_payment inserts without an id); the export
--     prints it as plain 'bigint not null' — add 'generated ... as identity' when replaying.
--   * Order: tables, then PK/UNIQUE/CHECK, then FOREIGN KEYs (reordered 17 Sep so the file replays
--     cleanly - proven on a scratch Postgres 16). FKs reference public.workers, which must already exist.
--   * Grants are listed as comments (authenticated = SELECT only; no anon grants).
--   * invoice_sequence seed: insert (id,last_number) values (1,0). Live value at export = 99
--     (Aaron set 17 Sep via R-16 so the first invoice is #100).
--   * wb_touch_row() and wb_tenant_ok() are pre-existing helpers from earlier migrations.

create table public.entitlements (
  id uuid not null default gen_random_uuid(),
  client_id text not null,
  worker_id uuid not null,
  worker_ref text not null,
  unlocked_by text not null,
  payment_id uuid,
  waiver_reason text,
  waived_by uuid,
  unlocked_at timestamp with time zone not null default now(),
  created_at timestamp with time zone not null default now()
);

create table public.invoice_sequence (
  id integer not null default 1,
  last_number bigint not null default 0,
  updated_at timestamp with time zone not null default now()
);

create table public.payment_events (
  id bigint not null,
  client_id text not null,
  idempotency_key text not null,
  event_type text not null,
  order_id text,
  revolut_request_timestamp text,
  raw_payload text,
  processed_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

create table public.payments (
  id uuid not null default gen_random_uuid(),
  client_id text not null,
  worker_id uuid not null,
  worker_ref text not null,
  contractor_id uuid,
  work_order_reference text,
  revolut_order_id text,
  revolut_order_token text,
  payment_method text,
  fee_tier text not null,
  amount_net integer not null,
  vat_amount integer not null,
  amount_gross integer not null,
  currency text not null default 'GBP'::text,
  state text not null default 'pending'::text,
  invoice_number bigint,
  expires_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  created_by uuid default auth.uid(),
  paid_at timestamp with time zone,
  fulfilled_at timestamp with time zone,
  updated_at timestamp with time zone not null default now(),
  version integer not null default 1
);

alter table entitlements add constraint entitlements_one_per_assessment UNIQUE (client_id, worker_id);

alter table entitlements add constraint entitlements_pkey PRIMARY KEY (id);

alter table entitlements add constraint entitlements_unlocked_by_check CHECK ((unlocked_by = ANY (ARRAY['payment'::text, 'free_tier'::text, 'orsted_waiver'::text])));

alter table invoice_sequence add constraint invoice_sequence_id_check CHECK ((id = 1));

alter table invoice_sequence add constraint invoice_sequence_pkey PRIMARY KEY (id);

alter table payment_events add constraint payment_events_idempotency_key_key UNIQUE (idempotency_key);

alter table payment_events add constraint payment_events_pkey PRIMARY KEY (id);

alter table payments add constraint payments_fee_tier_check CHECK ((fee_tier = ANY (ARRAY['first'::text, 'reassessment'::text, 'free'::text, 'waived'::text])));

alter table payments add constraint payments_invoice_number_key UNIQUE (invoice_number);

alter table payments add constraint payments_payment_method_check CHECK ((payment_method = ANY (ARRAY['pay_by_bank'::text, 'card'::text, 'revolut_pay'::text])));

alter table payments add constraint payments_pkey PRIMARY KEY (id);

alter table payments add constraint payments_revolut_order_id_key UNIQUE (revolut_order_id);

alter table payments add constraint payments_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'expired'::text, 'refunded'::text, 'credited'::text])));

alter table entitlements add constraint entitlements_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments(id);

alter table entitlements add constraint entitlements_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE RESTRICT;

alter table payments add constraint payments_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE RESTRICT;

CREATE INDEX payments_client_idx ON public.payments USING btree (client_id);

CREATE UNIQUE INDEX payments_one_pending_per_assessment ON public.payments USING btree (client_id, worker_id) WHERE (state = 'pending'::text);

CREATE INDEX payments_state_idx ON public.payments USING btree (client_id, state);

CREATE INDEX payments_worker_idx ON public.payments USING btree (worker_id);

alter table public.entitlements enable row level security;

alter table public.invoice_sequence enable row level security;

alter table public.payment_events enable row level security;

alter table public.payments enable row level security;

create policy entitlements_contractor_read on public.entitlements as PERMISSIVE for SELECT to authenticated using ((wb_tenant_ok(client_id) AND (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'contractor'::text) AND (worker_ref = ((auth.jwt() -> 'app_metadata'::text) ->> 'worker_ref'::text))));

create policy entitlements_staff_read on public.entitlements as PERMISSIVE for SELECT to authenticated using ((wb_tenant_ok(client_id) AND (COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) <> 'contractor'::text)));

create policy payevents_staff_read on public.payment_events as PERMISSIVE for SELECT to authenticated using ((wb_tenant_ok(client_id) AND (COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) <> 'contractor'::text)));

create policy payments_contractor_read on public.payments as PERMISSIVE for SELECT to authenticated using ((wb_tenant_ok(client_id) AND (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'contractor'::text) AND (worker_ref = ((auth.jwt() -> 'app_metadata'::text) ->> 'worker_ref'::text))));

create policy payments_staff_read on public.payments as PERMISSIVE for SELECT to authenticated using ((wb_tenant_ok(client_id) AND (COALESCE(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) <> 'contractor'::text)));

-- grants on public.entitlements to authenticated: SELECT

-- grants on public.entitlements to postgres: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE

-- grants on public.entitlements to service_role: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE

-- grants on public.invoice_sequence to postgres: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE

-- grants on public.invoice_sequence to service_role: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE

-- grants on public.payment_events to authenticated: SELECT

-- grants on public.payment_events to postgres: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE

-- grants on public.payment_events to service_role: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE

-- grants on public.payments to authenticated: SELECT

-- grants on public.payments to postgres: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE

-- grants on public.payments to service_role: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE

CREATE TRIGGER payments_touch BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION wb_touch_row();

CREATE OR REPLACE FUNCTION public.fulfil_payment(p_client_id text, p_revolut_order_id text, p_event_type text, p_idempotency_key text, p_revolut_request_timestamp text, p_raw_payload text, p_payment_method text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_payment public.payments; v_inv bigint; v_ent_id uuid;
begin
  -- idempotency gate (brief S5d.1): record the event; a duplicate loses the race and stops here.
  insert into public.payment_events(client_id, idempotency_key, event_type, order_id,
                                    revolut_request_timestamp, raw_payload, processed_at)
  values (p_client_id, p_idempotency_key, p_event_type, p_revolut_order_id,
          p_revolut_request_timestamp, p_raw_payload, now())
  on conflict (idempotency_key) do nothing;
  if not found then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  -- only ORDER_COMPLETED fulfils (we use automatic capture); others are recorded, not fulfilled.
  if p_event_type <> 'ORDER_COMPLETED' then
    return jsonb_build_object('ok', true, 'recorded_only', true, 'event_type', p_event_type);
  end if;

  select * into v_payment from public.payments
    where client_id = p_client_id and revolut_order_id = p_revolut_order_id for update;
  if not found then
    raise exception 'fulfil_payment: no payment for order % in %', p_revolut_order_id, p_client_id;
  end if;
  if v_payment.state = 'completed' then
    return jsonb_build_object('ok', true, 'already_completed', true, 'payment_id', v_payment.id);
  end if;

  v_inv := public.next_invoice_number();

  update public.payments
     set state = 'completed',
         payment_method = coalesce(p_payment_method, payment_method),
         invoice_number = v_inv, paid_at = now(), fulfilled_at = now()
   where id = v_payment.id;

  insert into public.entitlements(client_id, worker_id, worker_ref, unlocked_by, payment_id)
  values (v_payment.client_id, v_payment.worker_id, v_payment.worker_ref, 'payment', v_payment.id)
  on conflict (client_id, worker_id) do nothing
  returning id into v_ent_id;

  -- Convention 1: read the entitlement back and assert it persisted. A 200 is not proof.
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
                             'invoice_number', v_inv, 'payment_id', v_payment.id)::text);

  return jsonb_build_object('ok', true, 'payment_id', v_payment.id,
                            'invoice_number', v_inv, 'entitlement_id', v_ent_id);
end; $function$
;

CREATE OR REPLACE FUNCTION public.next_invoice_number()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_n bigint;
begin
  update public.invoice_sequence set last_number = last_number + 1, updated_at = now()
    where id = 1 returning last_number into v_n;      -- UPDATE ... RETURNING row-locks, so callers serialise
  if v_n is null then raise exception 'next_invoice_number: invoice_sequence row missing'; end if;
  return v_n;
end; $function$
;

-- acl fulfil_payment(p_client_id text, p_revolut_order_id text, p_event_type text, p_idempotency_key text, p_revolut_request_timestamp text, p_raw_payload text, p_payment_method text): postgres=X/postgres, service_role=X/postgres

-- acl next_invoice_number(): postgres=X/postgres, service_role=X/postgres

-- invoice_sequence rows at export: [{"id":1,"last_number":99,"updated_at":"2026-09-16T15:50:53.614254+00:00"}]

comment on table public.entitlements is 'PAY-01. One per assessment. unlocked_by records payment / free_tier / orsted_waiver (brief S4).';

comment on table public.invoice_sequence is 'PAY-01. Single row. Ascend-wide sequential VAT invoice numbers. Starting number is Aarons to set.';

comment on table public.payment_events is 'PAY-01. Append-only. Unique idempotency_key gives DB-level dedupe - Revolut retries, so duplicates are certain.';

comment on table public.payments is 'PAY-01. One row per assessment commercial treatment. amount_* are MINOR UNITS (pence).';
