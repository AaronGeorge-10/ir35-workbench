// =====================================================================
//  IR35 Workbench - Edge Function: invite-contractor
//
//  Mints the contractor's account for ONE worker record and emails them a
//  link to set a password and answer their part of the assessment.
//
//  Order matters and is not negotiable: the worker record must exist FIRST,
//  because submit_contractor_answers() resolves the engagement from
//  app_metadata.worker_ref on the contractor's token. An account minted
//  before the worker exists has nothing to point at.
//
//  Deploy: Supabase Dashboard -> Edge Functions -> Deploy a new function
//  Name:   invite-contractor
//  Secret needed: RESEND_API_KEY   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
//                                   are injected by the platform)
//  Leave "Verify JWT" ON - this is called by a signed-in platform admin.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const FROM       = "Ascend Workforce Solutions <assessments@ir35workbench.co.uk>";
const APP_URL    = "https://ir35workbench.co.uk/orsted/";
const WINDOW_DAYS = 7;
// Who may cause an invitation to be sent. Widened 8 Sep (Aaron) so that the
// line manager's own submission sends it, rather than the case sitting in a
// queue waiting for a second person to press a button.
// Widen this list deliberately, never by accident - each addition can send mail
// to a real contractor in a client's name.
const MAY_INVITE = ["platform", "clientadmin", "linemanager"];

const CORS = {
  "Access-Control-Allow-Origin":  "https://ir35workbench.co.uk",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** aal is a top-level JWT claim and is not returned by getUser(). The gateway
 *  has already verified the signature, so reading the payload is safe here. */
function aalOf(token: string): string {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "=".repeat((4 - p.length % 4) % 4))).aal ?? "";
  } catch { return ""; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405);

  const runId = crypto.randomUUID().slice(0, 8);
  const log = (...a: unknown[]) => console.log(`[invite ${runId}]`, ...a);

  // --- Convention 3: pre-flight. Fail loudly, before any work. -----------
  const SB_URL  = Deno.env.get("SUPABASE_URL");
  const SB_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const RESEND  = Deno.env.get("RESEND_API_KEY");
  // NB no SUPABASE_ANON_KEY here. It is marked DEPRECATED in this project's
  // default secrets, and depending on it would make this function fail the day
  // Supabase stops injecting it. The caller's token is verified by passing it
  // to getUser() on the service client instead - same verification, one fewer
  // moving part.
  const missing = [["SUPABASE_URL",SB_URL],["SUPABASE_SERVICE_ROLE_KEY",SB_KEY],
                   ["RESEND_API_KEY",RESEND]]
                  .filter(([,v]) => !v).map(([k]) => k);
  if (missing.length) {
    log("PREFLIGHT FAILED", missing);
    return json({ error: `not configured: ${missing.join(", ")} missing` }, 500);
  }

  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer /i, "");
  if (!token) return json({ error: "sign in first" }, 401);

  const svc = createClient(SB_URL!, SB_KEY!, { auth: { persistSession: false } });

  const { data: who, error: whoErr } = await svc.auth.getUser(token);
  if (whoErr || !who?.user) return json({ error: "sign in first" }, 401);

  const meta   = (who.user.app_metadata ?? {}) as Record<string, string>;
  const role   = meta.role   ?? "";
  const tenant = meta.tenant ?? "";
  const actor  = (who.user.user_metadata?.full_name as string) ?? meta.full_name ?? who.user.email ?? "Unknown";

  if (aalOf(token) !== "aal2")   return json({ error: "MFA required to send an invitation" }, 403);
  if (!MAY_INVITE.includes(role)) return json({ error: "you are not permitted to send contractor invitations" }, 403);
  if (!tenant)                    return json({ error: "no tenant on this account" }, 403);

  let workerRef = "";
  try { workerRef = String(((await req.json()) ?? {}).worker_ref ?? "").trim().toUpperCase(); }
  catch { return json({ error: "expected a JSON body" }, 400); }
  if (!workerRef) return json({ error: "worker_ref is required" }, 400);

  // --- Convention 5: the worker is resolved WITHIN the caller's tenant.
  //     A platform admin still has to say which tenant they are acting for,
  //     so an invite can never cross from one client to another.
  const { data: w, error: wErr } = await svc.from("workers")
    .select("worker_ref, worker_name, worker_email, role_title, role_ref, client_id, contractor_user_id, invited_at, invite_count")
    .eq("client_id", tenant).eq("worker_ref", workerRef).maybeSingle();
  if (wErr) { log("worker lookup failed", wErr.message); return json({ error: wErr.message }, 500); }
  if (!w)   return json({ error: `no worker ${workerRef} in ${tenant}` }, 404);
  if (!w.worker_email) return json({ error: `${workerRef} has no email address on file` }, 422);

  // Double-click guard. Revolut aside, this is the cheapest idempotency there
  // is: the worker row itself. Two clicks a second apart must not mean two
  // emails and two audit lines.
  if (w.invited_at && Date.now() - Date.parse(w.invited_at) < 60_000) {
    log("duplicate suppressed", workerRef);
    return json({ ok: true, duplicate: true, message: "an invitation was just sent - not sending another" });
  }

  const appMeta = { role: "contractor", tenant, worker_ref: w.worker_ref, full_name: w.worker_name };
  let userId = w.contractor_user_id as string | null;

  try {
    if (userId) {
      // A re-send. Update the existing account rather than trying to mint a
      // second one for the same address - that is what contractor_user_id is for.
      const { error } = await svc.auth.admin.updateUserById(userId, { app_metadata: appMeta });
      if (error) throw new Error(`could not update the contractor account: ${error.message}`);
    } else {
      const { data: made, error } = await svc.auth.admin.createUser({
        email: w.worker_email, email_confirm: true, app_metadata: appMeta,
      });
      if (error || !made?.user) throw new Error(`could not create the contractor account: ${error?.message ?? "no user returned"}`);
      userId = made.user.id;
    }

    // 'recovery' rather than 'invite': it works for a first invitation AND a
    // re-send, and the front end already routes type=invite|recovery to the
    // set-a-password screen. One code path, not two.
    const { data: link, error: linkErr } = await svc.auth.admin.generateLink({
      type: "recovery", email: w.worker_email, options: { redirectTo: APP_URL },
    });
    if (linkErr || !link?.properties?.action_link) {
      throw new Error(`could not generate the sign-in link: ${linkErr?.message ?? "no link returned"}`);
    }

    const due = new Date(Date.now() + WINDOW_DAYS * 864e5)
      .toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    const url = link.properties.action_link;

    const sent = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [w.worker_email],
        subject: `Your IR35 status assessment - ${w.role_title} (${w.role_ref})`,
        text:
`Dear ${w.worker_name},

You are being assessed for IR35 status in connection with your engagement as
${w.role_title} (role reference ${w.role_ref}).

There are two questions only you can answer - about your contract and about
how you work generally. No status determination can be issued until you have
answered them.

Set your password and answer here:
${url}

Please complete this by ${due}.

If you were not expecting this, or you are not engaged in this role, reply to
this email and we will look into it.

Ascend Workforce Solutions
assessments@ir35workbench.co.uk`,
      }),
    });
    if (!sent.ok) throw new Error(`the email could not be sent (${sent.status}: ${(await sent.text()).slice(0, 200)})`);

    // --- Convention 1: write, then READ IT BACK. A 200 is not proof, and an
    //     invitation that sent but did not record is a 7-day clock nobody
    //     can see running.
    const { error: upErr } = await svc.from("workers").update({
      contractor_user_id: userId,
      invited_at:        new Date().toISOString(),
      invite_sent_to:    w.worker_email,
      invite_count:      (w.invite_count ?? 0) + 1,
      invite_last_error: null,
    }).eq("client_id", tenant).eq("worker_ref", w.worker_ref);
    if (upErr) throw new Error(`the invitation was SENT but could not be recorded: ${upErr.message}`);

    const { data: back } = await svc.from("workers")
      .select("invited_at, invite_count, contractor_user_id")
      .eq("client_id", tenant).eq("worker_ref", w.worker_ref).maybeSingle();
    if (!back?.invited_at || back.contractor_user_id !== userId) {
      throw new Error("the invitation was SENT but the record did not persist - investigate before re-sending");
    }

    await svc.from("audit_log").insert({
      client_id: tenant, entity: w.worker_ref, event_type: "Contractor invited", actor,
      detail: `Invitation ${back.invite_count} sent to ${w.worker_email} for ${w.role_title} (${w.role_ref}). Response due ${due}.`,
    });

    log("sent", w.worker_ref, "count", back.invite_count);
    return json({ ok: true, worker_ref: w.worker_ref, sent_to: w.worker_email, invite_count: back.invite_count, due });

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("FAILED", msg);
    // Record the failure on the row so a silent bounce becomes visible rather
    // than a window quietly running down on an invitation that never arrived.
    await svc.from("workers").update({ invite_last_error: msg.slice(0, 500) })
      .eq("client_id", tenant).eq("worker_ref", workerRef);
    await svc.from("audit_log").insert({
      client_id: tenant, entity: workerRef, event_type: "Contractor invitation FAILED", actor,
      detail: msg.slice(0, 500),
    });
    return json({ error: msg }, 500);
  }
});
