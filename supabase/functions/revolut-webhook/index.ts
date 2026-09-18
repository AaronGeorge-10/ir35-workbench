// supabase/functions/revolut-webhook/index.ts
// IR35 Workbench - Revolut webhook -> fulfil_payment() -> VAT invoice. verify_jwt = FALSE.
// Security rests ENTIRELY on the HMAC signature check below.
// v1 Archie 2026-09-16 (PAY-03, live-verified).
// v2 Archie 2026-09-17 (PAY-05):
//   * asks Revolut for the order itself (amount, currency, state, payment method) - the webhook body
//     carries none of that - and fulfils only if the amount taken equals the price (brief 3.2)
//   * a mismatch issues nothing and emails accounts@ascend-people.com
//   * issues the VAT invoice: builds the data snapshot, draws the PDF (invoice_pdf.ts, inside this
//     London function - no new sub-processor), stores it once, reads it back, emails it once
//   * every step is idempotent, so a Revolut retry finishes whatever a failed attempt left undone
// Files: index.ts, invoice_pdf.ts, invoice_assets.ts, invoice_config.ts
// Secrets: REVOLUT_WEBHOOK_SECRET, REVOLUT_SECRET_KEY, REVOLUT_API_BASE, REVOLUT_API_VERSION, RESEND_API_KEY.
// AFTER EVERY DEPLOY: Settings -> "Verify JWT with legacy secret" must be OFF.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import * as pdfLib from "https://esm.sh/pdf-lib@1.17.1";
import fontkit from "https://esm.sh/@pdf-lib/fontkit@1.1.1";
import { makeInvoiceRenderer } from "./invoice_pdf.ts";
import { SANS_REGULAR_B64, SANS_BOLD_B64, MONO_B64, LOGO_PDF_B64 } from "./invoice_assets.ts";
import { INVOICE_CONFIG } from "./invoice_config.ts";

const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("REVOLUT_WEBHOOK_SECRET") ?? "";
const RV_BASE        = (Deno.env.get("REVOLUT_API_BASE") ?? "https://merchant.revolut.com").trim().replace(/\/+$/, "");
const RV_SECRET      = (Deno.env.get("REVOLUT_SECRET_KEY") ?? "").trim();
const RV_VERSION     = (Deno.env.get("REVOLUT_API_VERSION") ?? "2026-08-17").trim();
const RESEND         = Deno.env.get("RESEND_API_KEY") ?? "";

const FROM        = "IR35 Workbench <assessments@ir35workbench.co.uk>";
const ASSESSMENTS = "assessments@ir35workbench.co.uk";
const SITE        = "https://ir35workbench.co.uk";

const b64ToBytes = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
const bytesToB64 = (u: Uint8Array) => {
  let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const sha256Hex = async (u: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", u))].map((b) => b.toString(16).padStart(2, "0")).join("");

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

// ---------- pure helpers (exported for the tests) ----------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function londonDate(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(d).reduce((o: Record<string, string>, x) => (o[x.type] = x.value, o), {});
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]} ${p.year}`;
}
export function pence(p: number): string {
  if (!Number.isInteger(p) || p < 0) throw new Error("pence must be a non-negative integer");
  return `${Math.floor(p / 100)}.${String(p % 100).padStart(2, "0")}`;
}
export function methodOf(order: any): { method: string | null; label: string } {
  const pays = Array.isArray(order?.payments) ? order.payments : [];
  const done = pays.find((p: any) => ["completed", "captured", "authorised", "settled"].includes(String(p?.state).toLowerCase())) ?? pays[pays.length - 1];
  const pm = done?.payment_method ?? {};
  const t = String(pm.type ?? "").toLowerCase();
  const last4 = /^\d{4}$/.test(String(pm.card_last_four ?? "")) ? String(pm.card_last_four) : "";
  // HOTFIX 2026-09-18: the first live Pay by Bank payment (IRW-000100) came back as an unrecognised type and was
  // printed "Card". Recognise every open-banking spelling, and NEVER default to "Card" - an unknown type is labelled
  // neutrally and logged so the mapping can be tightened.
  if (t.startsWith("revolut_pay")) return { method: "revolut_pay", label: "Revolut Pay" };
  if (/bank|open_?banking|obp|pis/.test(t)) return { method: "pay_by_bank", label: "Pay by Bank" };
  if (t === "card" || t === "apple_pay" || t === "google_pay") return { method: "card", label: last4 ? `Card ending ${last4}` : "Card" };
  if (last4) return { method: "card", label: `Card ending ${last4}` };
  return { method: null, label: "Online (Revolut)" };
}
export function invoiceNumber(n: number): string {
  const f = INVOICE_CONFIG.invoice_number_format;
  return f.prefix + String(n).padStart(f.pad_to, "0");
}
const TIER_KEY: Record<string, string> = { first: "first_assessment", reassessment: "reassessment" };
export function buildInvoiceData(p: any, w: any, clientName: string) {
  const tier = (INVOICE_CONFIG.fee_tiers as any)[TIER_KEY[p.fee_tier] ?? ""];
  if (!tier) throw new Error(`no invoice tier for fee_tier ${p.fee_tier}`);
  if (Math.round(tier.net_pence * INVOICE_CONFIG.vat_rate_percent / 100) !== tier.vat_pence || tier.net_pence + tier.vat_pence !== tier.gross_pence)
    throw new Error("invoice_config tier arithmetic is wrong");
  if (p.amount_net !== tier.net_pence || p.vat_amount !== tier.vat_pence || p.amount_gross !== tier.gross_pence)
    throw new Error(`payment amounts ${p.amount_net}/${p.vat_amount}/${p.amount_gross} do not match the ${p.fee_tier} tier`);
  if (p.confirmed_amount !== tier.gross_pence) throw new Error(`Revolut amount ${p.confirmed_amount} does not match the invoice gross ${tier.gross_pence}`);
  const roleRef = w.role_ref || w.prefill_role_ref || "-";
  const date = londonDate(p.paid_at);
  return {
    supplier: INVOICE_CONFIG.supplier,
    invoice_number: invoiceNumber(p.invoice_number),
    invoice_seq: p.invoice_number,
    gross_pence: tier.gross_pence,
    is_paid: true,
    invoice_date: date,
    tax_point_date: null,
    payment_date: date,
    payment_method: p.payment_method_label || "Online (Revolut)",
    payment_reference: p.revolut_order_id,
    contractor: {
      full_name: p.bill_full_name || w.worker_name,
      company_name: p.bill_company_name || null,
      address_lines: (p.bill_address_lines || []).filter((s: string) => s && s.trim()),
      vat_number: p.bill_vat_number || null,
      email: p.bill_email || w.worker_email,
    },
    assessment: { end_client_name: clientName, role_title: w.role_title, role_reference: roleRef, reference: w.worker_ref },
    line_items: [{ description: tier.description, detail: `${w.role_title} · role ${roleRef}`, quantity: 1,
      unit_price: pence(tier.net_pence), vat_rate: INVOICE_CONFIG.vat_rate_percent, net: pence(tier.net_pence) }],
    totals: { net: pence(tier.net_pence), vat_rate: INVOICE_CONFIG.vat_rate_percent, vat: pence(tier.vat_pence),
      gross: pence(tier.gross_pence), paid: pence(p.confirmed_amount), balance: pence(tier.gross_pence - p.confirmed_amount) },
  };
}

// ---------- side effects ----------
const renderInvoicePdf = makeInvoiceRenderer(pdfLib, fontkit);
let ASSETS: any = null;
const assets = () => ASSETS ??= { sansRegular: b64ToBytes(SANS_REGULAR_B64), sansBold: b64ToBytes(SANS_BOLD_B64), mono: b64ToBytes(MONO_B64), logoPdf: b64ToBytes(LOGO_PDF_B64) };

async function sendEmail(body: Record<string, unknown>): Promise<{ id: string | null; error: string | null }> {
  if (!RESEND) return { id: null, error: "RESEND_API_KEY not set" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, ...body }),
    });
    const out = await res.json().catch(() => ({}));
    return res.ok ? { id: out?.id ?? null, error: null } : { id: null, error: out?.message ?? `resend ${res.status}` };
  } catch (e) { return { id: null, error: String(e) }; }
}

async function alertAscend(subject: string, text: string) {
  await sendEmail({ to: [INVOICE_CONFIG.supplier.contact_email], subject: `[IR35 Workbench] ${subject}`, text });
}

async function ensureInvoice(svc: any, paymentId: string): Promise<string> {
  const { data: p, error } = await svc.from("payments").select("*").eq("id", paymentId).maybeSingle();
  if (error || !p) throw new Error("payment not readable: " + (error?.message ?? paymentId));
  if (p.state !== "completed" || p.invoice_number == null) return "not_completed";

  if (!p.invoice_pdf_b64) {
    const { data: w, error: we } = await svc.from("workers")
      .select("worker_ref,worker_name,worker_email,role_title,role_ref,prefill_role_ref").eq("id", p.worker_id).maybeSingle();
    if (we || !w) throw new Error("worker not readable for invoice");
    const { data: c } = await svc.from("clients").select("client_name").eq("client_id", p.client_id).maybeSingle();
    const data = buildInvoiceData(p, w, c?.client_name ?? p.client_id);
    const pdf = await renderInvoicePdf(data as any, assets());
    const b64 = bytesToB64(pdf), sha = await sha256Hex(pdf);
    const { data: st, error: se } = await svc.rpc("store_invoice", { p_payment_id: p.id, p_data: data, p_pdf_b64: b64, p_sha256: sha });
    if (se) throw new Error("store_invoice: " + se.message);
    // Convention 1: read the stored invoice back before anything is sent.
    const { data: back } = await svc.from("payments").select("invoice_pdf_sha256,invoice_pdf_b64").eq("id", p.id).maybeSingle();
    if (!back?.invoice_pdf_b64 || back.invoice_pdf_sha256 !== (st?.sha256 ?? sha)) throw new Error("invoice did not persist");
    p.invoice_pdf_b64 = back.invoice_pdf_b64; p.invoice_data = data; p.invoice_pdf_sha256 = back.invoice_pdf_sha256;
  }
  if (p.invoice_emailed_at) return "already_emailed";

  const { data: claimed, error: ce } = await svc.rpc("claim_invoice_email", { p_payment_id: p.id });
  if (ce) throw new Error("claim_invoice_email: " + ce.message);
  if (!claimed) return "email_in_progress";

  const d = p.invoice_data;
  const appUrl = `${SITE}/${p.client_id}/`;
  const first = String(d.contractor.full_name || "").trim().split(/\s+/)[0] || "there";
  const text =
`Hello ${first},

Thank you. We have received your payment of £${d.totals.gross} for your IR35 status assessment (${d.assessment.reference}, ${d.assessment.role_title}) with ${d.assessment.end_client_name}.

Your VAT invoice ${d.invoice_number} is attached. You can also download it at any time from My IR35 status in the IR35 Workbench:
${appUrl}

You can now complete your IR35 Workbench SDS Questionnaire at the same address.

Questions about this invoice: ${INVOICE_CONFIG.supplier.contact_email} (please quote ${d.invoice_number}).
Questions about your assessment: ${ASSESSMENTS}

Kind regards,
The IR35 Workbench Team`;
  const sent = await sendEmail({
    to: [d.contractor.email],
    bcc: [INVOICE_CONFIG.supplier.contact_email],
    reply_to: INVOICE_CONFIG.supplier.contact_email,
    subject: `Payment received - IR35 Workbench invoice ${d.invoice_number}`,
    text,
    attachments: [{ filename: `IR35-Workbench-Invoice-${d.invoice_number}.pdf`, content: p.invoice_pdf_b64 }],
  });
  const { error: re } = await svc.rpc("record_invoice_email", { p_payment_id: p.id, p_message_id: sent.id, p_error: sent.error });
  if (re) throw new Error("record_invoice_email: " + re.message);
  if (sent.error) throw new Error("invoice email not sent: " + sent.error);
  return "emailed";
}

export async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  const raw = await req.text();
  const ts  = req.headers.get("Revolut-Request-Timestamp") ?? "";
  const sigHeader = req.headers.get("Revolut-Signature") ?? "";
  if (!ts || !sigHeader) return new Response("missing_signature_headers", { status: 401 });

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 5 * 60 * 1000)
    return new Response("stale_timestamp", { status: 401 });

  const expected = await hmacHex(WEBHOOK_SECRET, `v1.${ts}.${raw}`);
  const provided = sigHeader.split(",").map((s) => s.trim()).map((s) => (s.startsWith("v1=") ? s.slice(3) : ""));
  if (!WEBHOOK_SECRET || !provided.some((p) => p && safeEqual(p, expected)))
    return new Response("bad_signature", { status: 401 });

  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response("bad_json", { status: 400 }); }
  const event = body.event as string | undefined;
  const orderId = body.order_id as string | undefined;
  if (!event || !orderId) return new Response("missing_fields", { status: 400 });

  const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: pay, error: perr } = await svc.from("payments")
    .select("id,client_id,worker_ref").eq("revolut_order_id", orderId).maybeSingle();
  if (perr) return new Response("lookup_error", { status: 500 });
  if (!pay) return Response.json({ ignored: true, reason: "unknown_order", orderId });

  // Revolut's own record of the order - never the webhook body - decides what was paid.
  let amount: number | null = null, currency: string | null = null, state: string | null = null;
  let method: { method: string | null; label: string } = { method: null, label: "Online (Revolut)" };
  if (event === "ORDER_COMPLETED") {
    try {
      const r = await fetch(`${RV_BASE}/api/orders/${encodeURIComponent(orderId)}`, {
        headers: { Authorization: `Bearer ${RV_SECRET}`, "Revolut-Api-Version": RV_VERSION, Accept: "application/json" },
      });
      if (!r.ok) return new Response(`order_lookup_failed ${r.status}`, { status: 502 });
      const order = await r.json();
      if (order?.id && order.id !== orderId) return new Response("order_id_mismatch", { status: 502 });
      amount = Number.isInteger(order?.amount) ? order.amount : null;
      currency = typeof order?.currency === "string" ? order.currency : null;
      state = typeof order?.state === "string" ? order.state : null;
      method = methodOf(order);
      // HOTFIX 2026-09-18: record what Revolut actually reported, so the method mapping is based on evidence.
      const seen = (Array.isArray(order?.payments) ? order.payments : []).map((p: any) => `${p?.state}:${p?.payment_method?.type}`);
      console.log("revolut-webhook: order", orderId, "payments", JSON.stringify(seen).slice(0, 300), "->", method.label);
    } catch (e) { return new Response("order_lookup_error: " + String(e).slice(0, 200), { status: 502 }); }
  }

  const { data: res, error } = await svc.rpc("fulfil_payment", {
    p_client_id: pay.client_id,
    p_revolut_order_id: orderId,
    p_event_type: event,
    p_idempotency_key: `${event}.${orderId}.${ts}`,
    p_revolut_request_timestamp: ts,
    p_raw_payload: raw,
    p_payment_method: method.method,
    p_order_amount: amount,
    p_order_currency: currency,
    p_order_state: state,
    p_payment_method_label: event === "ORDER_COMPLETED" ? method.label : null,
  });
  if (error) return new Response("fulfil_error: " + error.message, { status: 500 }); // Revolut retries; safe

  if (res?.review) {
    if (res.first_alert) {
      await alertAscend(`Payment needs checking - ${pay.worker_ref}`,
`Revolut order ${orderId} for assessment ${pay.worker_ref} (${pay.client_id}) completed for ${res.received} ${res.currency} (minor units), but the price on the payment was ${res.expected}.

No invoice has been issued and the questionnaire has NOT been unlocked. The payment is in state "review".
Check the order in the Revolut Business dashboard and decide whether to refund or unlock manually.`);
    }
    return Response.json({ ok: false, review: true });
  }

  let invoice = "not_applicable";
  const pid = res?.payment_id ?? pay.id;
  if (event === "ORDER_COMPLETED" || res?.duplicate) {
    try { invoice = await ensureInvoice(svc, pid); }
    catch (e) {
      const msg = String((e as any)?.message ?? e).slice(0, 400);
      await alertAscend(`Invoice not issued - ${pay.worker_ref}`,
`The payment for ${pay.worker_ref} (Revolut order ${orderId}) is complete and the questionnaire is unlocked, but the VAT invoice step failed:

${msg}

Revolut will retry this notification. If this message repeats, the invoice needs issuing by hand.`);
      return new Response("invoice_error: " + msg, { status: 500 });
    }
  }
  return Response.json({ ...(res ?? { ok: true }), invoice });
}

if (typeof Deno !== "undefined" && (Deno as any).serve) Deno.serve(handle);
