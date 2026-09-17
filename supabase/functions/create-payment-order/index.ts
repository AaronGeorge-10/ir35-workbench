// supabase/functions/create-payment-order/index.ts
// IR35 Workbench — PAY-02 v2 (PAY-04): mint a Revolut order + reserve the payments row.
// Called by the signed-in contractor's "Pay" buttons (Revolut Merchant Web SDK createOrder callback).
// Deployed with "Verify JWT with legacy secret" = OFF — this function does its own auth (below).
// v1 Archie 2026-09-16 (live-verified). v2 Archie 2026-09-17:
//   * price comes from wb_payment_quote() — ONE pricing rule, shared with the database gate
//     (first £90 / reassessment £78 by email / free for Ascend payroll / nothing while the paywall is off)
//   * FIX: an expired pending order (>2h) was handed back forever, locking the contractor out of paying
//   * FIX: a pending row with no Revolut token (crash between reserve and mint) returned 409 forever
//   * FIX: a pending order at a stale price (route or tier changed) is retired, not reused
//   * order metadata carries tenant / worker so the payment is attributable in Revolut (brief §5a)
// Secrets (dashboard, NOT code): REVOLUT_SECRET_KEY, REVOLUT_API_BASE, REVOLUT_API_VERSION.
// SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RV_BASE      = Deno.env.get("REVOLUT_API_BASE") ?? "https://merchant.revolut.com";
const RV_SECRET    = Deno.env.get("REVOLUT_SECRET_KEY")!;
const RV_VERSION   = Deno.env.get("REVOLUT_API_VERSION") ?? "2026-04-20";

const ORDER_TTL_MS   = 2 * 3600 * 1000;   // matches expire_pending_after PT2H
const REUSE_MARGIN_MS = 5 * 60 * 1000;    // never hand out a token with < 5 minutes left
const STUCK_RESERVE_MS = 2 * 60 * 1000;   // a reserve with no token after 2 minutes is dead

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return json(405, { error: "method_not_allowed" });

  try {
    // 1. Identity from the verified JWT only — never trust a worker_ref in the body.
    const authHeader = req.headers.get("Authorization") ?? "";
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
    });
    const { data: uinfo, error: uerr } = await caller.auth.getUser();
    if (uerr || !uinfo?.user) return json(401, { error: "unauthenticated" });
    const meta = uinfo.user.app_metadata ?? {};
    const workerRef = meta.worker_ref as string | undefined;
    const tenant    = meta.tenant as string | undefined;
    if (meta.role !== "contractor" || !workerRef || !tenant)
      return json(403, { error: "not_a_contractor_session" });

    const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // 2. The contractor's own assessment.
    const { data: worker, error: werr } = await svc.from("workers")
      .select("id,client_id,worker_ref").eq("client_id", tenant).eq("worker_ref", workerRef).maybeSingle();
    if (werr || !worker) return json(404, { error: "assessment_not_found" });

    // 3. Already unlocked? Never charge twice.
    const { data: ent } = await svc.from("entitlements")
      .select("id,unlocked_by").eq("client_id", tenant).eq("worker_id", worker.id).maybeSingle();
    if (ent) return json(200, { already_unlocked: true, unlocked_by: ent.unlocked_by });

    // 4. What does this worker owe? One rule, in the database.
    const { data: quote, error: qerr } = await svc.rpc("wb_payment_quote", { p_worker_id: worker.id });
    if (qerr || !quote) return json(500, { error: "quote_failed", detail: qerr?.message });
    if (!quote.required) {
      if (quote.tier === "free") {
        await svc.from("entitlements").upsert(
          { client_id: tenant, worker_id: worker.id, worker_ref: worker.worker_ref, unlocked_by: "free_tier" },
          { onConflict: "client_id,worker_id", ignoreDuplicates: true });
      }
      return json(200, { already_unlocked: true, unlocked_by: quote.tier === "free" ? "free_tier" : "not_required" });
    }
    const tier  = quote.tier as string;
    const gross = Number(quote.gross), net = Number(quote.net), vat = Number(quote.vat);
    if (!Number.isInteger(gross) || gross <= 0 || net + vat !== gross)
      return json(500, { error: "bad_quote", quote });

    // 5. An open order for this assessment? Reuse it only if it is fresh and at today's price.
    const { data: pend } = await svc.from("payments")
      .select("id,revolut_order_token,amount_gross,expires_at,created_at")
      .eq("client_id", tenant).eq("worker_id", worker.id).eq("state", "pending").maybeSingle();
    if (pend) {
      const now = Date.now();
      const exp = pend.expires_at ? Date.parse(pend.expires_at) : 0;
      if (pend.revolut_order_token && pend.amount_gross === gross && exp - now > REUSE_MARGIN_MS)
        return json(200, { token: pend.revolut_order_token, reused: true, tier, gross });
      if (!pend.revolut_order_token && now - Date.parse(pend.created_at) < STUCK_RESERVE_MS)
        return json(409, { error: "order_in_progress_retry" });
      // Stale: expired, about to expire, wrong price, or a dead reserve. Retire it and mint afresh.
      const { error: rtErr } = await svc.from("payments")
        .update({ state: pend.revolut_order_token ? "expired" : "failed" })
        .eq("id", pend.id).eq("state", "pending");
      if (rtErr) return json(500, { error: "retire_failed", detail: rtErr.message });
    }

    // 6. Reserve the slot FIRST. The partial unique index makes a concurrent second caller's insert
    //    fail, so two Revolut orders are never minted for one assessment.
    const { data: reserved, error: rerr } = await svc.from("payments").insert({
      client_id: tenant, worker_id: worker.id, worker_ref: worker.worker_ref,
      contractor_id: uinfo.user.id, fee_tier: tier,
      amount_net: net, vat_amount: vat, amount_gross: gross, currency: "GBP", state: "pending",
    }).select("id").single();
    if (rerr) {
      const { data: w2 } = await svc.from("payments").select("revolut_order_token")
        .eq("client_id", tenant).eq("worker_id", worker.id).eq("state", "pending").maybeSingle();
      if (w2?.revolut_order_token) return json(200, { token: w2.revolut_order_token, reused: true, tier, gross });
      return json(409, { error: "order_in_progress_retry" });
    }

    // 7. Mint the Revolut order. On failure free the slot so the contractor can retry.
    const rv = await fetch(`${RV_BASE}/api/orders`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${RV_SECRET}`, "Revolut-Api-Version": RV_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: gross, currency: "GBP", capture_mode: "automatic",
        description: `IR35 status assessment ${worker.worker_ref}`,
        merchant_order_data: { reference: worker.worker_ref },
        customer: { email: uinfo.user.email },
        expire_pending_after: "PT2H",
        metadata: { tenant, worker_ref: worker.worker_ref, payment_id: reserved.id, fee_tier: tier },
      }),
    });
    if (!rv.ok) {
      const detail = (await rv.text()).slice(0, 300);
      await svc.from("payments").update({ state: "failed" }).eq("id", reserved.id);
      return json(502, { error: "revolut_order_failed", status: rv.status, detail });
    }
    const order = await rv.json();
    if (!order?.id || !order?.token) {
      await svc.from("payments").update({ state: "failed" }).eq("id", reserved.id);
      return json(502, { error: "revolut_order_incomplete" });
    }

    // 8. Attach the order to the reserved row, and read it back (a 200 is not proof).
    const { error: uperr } = await svc.from("payments").update({
      revolut_order_id: order.id, revolut_order_token: order.token,
      expires_at: new Date(Date.now() + ORDER_TTL_MS).toISOString(),
    }).eq("id", reserved.id);
    if (uperr) return json(500, { error: "reserve_update_failed", detail: uperr.message });
    const { data: back } = await svc.from("payments").select("revolut_order_id").eq("id", reserved.id).maybeSingle();
    if (back?.revolut_order_id !== order.id) return json(500, { error: "reserve_not_persisted" });

    // 9. Audit + return the token for the widget.
    await svc.from("audit_log").insert({
      client_id: tenant, entity: worker.worker_ref, event_type: "Payment order created", actor: "Contractor",
      detail: JSON.stringify({ order_id: order.id, tier, gross }),
    });
    return json(200, { token: order.token, payment_id: reserved.id, tier, gross });
  } catch (e) {
    return json(500, { error: "exception", detail: String(e).slice(0, 300) });
  }
});
