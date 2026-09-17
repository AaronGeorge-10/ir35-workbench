// supabase/functions/revolut-webhook/index.ts
// IR35 Workbench — PAY-03: Revolut webhook → fulfil_payment(). verify_jwt = FALSE.
// Security rests ENTIRELY on the HMAC signature check below. Author: Archie 2026-09-16.
// Secret required: REVOLUT_WEBHOOK_SECRET (the wsk_… signing secret from webhook creation).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("REVOLUT_WEBHOOK_SECRET") ?? "";

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  // Raw body — MUST be the exact bytes; re-serialising breaks the signature.
  const raw = await req.text();
  const ts  = req.headers.get("Revolut-Request-Timestamp") ?? "";
  const sigHeader = req.headers.get("Revolut-Signature") ?? "";
  if (!ts || !sigHeader) return new Response("missing_signature_headers", { status: 401 });

  // Replay guard: within 5 minutes of now.
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 5 * 60 * 1000)
    return new Response("stale_timestamp", { status: 401 });

  // Verify HMAC over v1.{ts}.{raw}; accept if ANY comma-separated v1= signature matches.
  const expected = await hmacHex(WEBHOOK_SECRET, `v1.${ts}.${raw}`);
  const provided = sigHeader.split(",").map((s) => s.trim())
    .map((s) => (s.startsWith("v1=") ? s.slice(3) : ""));
  if (!provided.some((p) => p && safeEqual(p, expected)))
    return new Response("bad_signature", { status: 401 });

  // Signature good — parse and route.
  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response("bad_json", { status: 400 }); }
  const event = body.event as string | undefined;
  const orderId = body.order_id as string | undefined;
  if (!event || !orderId) return new Response("missing_fields", { status: 400 });

  const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Derive the tenant from the order (no hardcoded tenant). order_id is globally unique.
  const { data: pay, error: perr } = await svc.from("payments")
    .select("client_id").eq("revolut_order_id", orderId).maybeSingle();
  if (perr) return new Response("lookup_error", { status: 500 });
  if (!pay) return new Response(JSON.stringify({ ignored: true, reason: "unknown_order", orderId }),
    { status: 200, headers: { "Content-Type": "application/json" } });

  // Fulfil (atomic + idempotent in the DB). Row-level completed-check dedupes retries too.
  const { data, error } = await svc.rpc("fulfil_payment", {
    p_client_id: pay.client_id,
    p_revolut_order_id: orderId,
    p_event_type: event,
    p_idempotency_key: `${event}.${orderId}.${ts}`,
    p_revolut_request_timestamp: ts,
    p_raw_payload: raw,
    p_payment_method: null,
  });
  if (error) return new Response("fulfil_error: " + error.message, { status: 500 }); // Revolut retries; safe
  return new Response(JSON.stringify(data ?? { ok: true }),
    { status: 200, headers: { "Content-Type": "application/json" } });
});