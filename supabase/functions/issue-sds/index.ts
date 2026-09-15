// =====================================================================
//  IR35 Workbench - Edge Function: issue-sds
//
//  Sends a SIGNED Status Determination Statement to every party entitled
//  to receive it, attaches it as a PDF, and records each send as evidence.
//
//  Under Chapter 10 the client passes the SDS to the worker AND to the
//  party it contracts with. Until it is passed down the chain the PAYE
//  liability stays with the client - so the delivery record here is
//  EVIDENCE, not logging.
//
//  🔴 AFTER EVERY DEPLOY: Settings -> turn OFF "Verify JWT with legacy
//     secret". A redeploy silently re-enables it, and this project issues
//     ES256 while the legacy secret is HS256.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

const FROM    = "Ascend Workforce Solutions <assessments@ir35workbench.co.uk>";
const ARCHIVE = "assessments@ir35workbench.co.uk";
const APP_URL = "https://ir35workbench.co.uk/orsted/";
const MAY_ISSUE = ["platform", "clientadmin", "internalreviewer"];

const CORS = {
  "Access-Control-Allow-Origin":  "https://ir35workbench.co.uk",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

function aalOf(token: string): string {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "=".repeat((4 - p.length % 4) % 4))).aal ?? "";
  } catch { return ""; }
}
const b64ToBytes = (b: string) => Uint8Array.from(atob(b), c => c.charCodeAt(0));
const bytesToB64 = (u: Uint8Array) => {
  let s = ""; for (let i = 0; i < u.length; i += 0x8000)
    s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

const hex = (h: string) => rgb(parseInt(h.slice(1,3),16)/255, parseInt(h.slice(3,5),16)/255, parseInt(h.slice(5,7),16)/255);
const NAVY=hex('#003182'), TEAL=hex('#218380'), TEAL_D=hex('#176561'), INK=hex('#231F20'),
      MUTED=hex('#6b7280'), LINE=hex('#DBDBDB'), GREENBG=hex('#E3F0EF'), AMBERBG=hex('#E6EBF5'),
      REDBG=hex('#F5E4EF'), MAGENTA=hex('#9C2373'), HAIR=hex('#f0f0f0'), META_HR=hex('#eeeeee'),
      STMT_BG=hex('#f7f9fb'), NEU_BG=hex('#eef1f5'), GREY=hex('#999999');
const PX = 0.85, A4: [number, number] = [595.28, 841.89], M = 40, W = A4[0] - M * 2;
const sgn = (n: unknown) => { const v = Number(n) || 0; return v > 0 ? `+${v}` : String(v); };

async function buildSdsPdf(doc: any, row: any, opts: any = {}) {
  if (!doc?.items?.length) throw new Error("no sealed document - a statement is never rebuilt from the register");
  const pdf = await PDFDocument.create();
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let logo: any = null;
  if (opts.logoPng) { try { logo = await pdf.embedPng(opts.logoPng); } catch { logo = null; } }

  pdf.setTitle(`Status Determination Statement ${row.ref ?? ""}`);
  pdf.setAuthor(doc.client_name ?? "");
  pdf.setSubject("Status Determination Statement (Chapter 10, Part 2 ITEPA 2003)");
  pdf.setProducer("Ascend IR35 Workbench");

  let page = pdf.addPage(A4), y = A4[1] - M;
  const newPage = () => { page = pdf.addPage(A4); y = A4[1] - M; };
  const need = (h: number) => { if (y - h < M + 30) newPage(); };

  function roundRect(x:number,yTop:number,w:number,h:number,r:number,fill:any,stroke:any) {
    const t = A4[1]-yTop, b = t+h;
    const d = `M ${x+r} ${t} L ${x+w-r} ${t} Q ${x+w} ${t} ${x+w} ${t+r}`
            + ` L ${x+w} ${b-r} Q ${x+w} ${b} ${x+w-r} ${b}`
            + ` L ${x+r} ${b} Q ${x} ${b} ${x} ${b-r}`
            + ` L ${x} ${t+r} Q ${x} ${t} ${x+r} ${t} Z`;
    const o: any = { x:0, y:A4[1], color:fill };
    if (stroke) { o.borderColor = stroke; o.borderWidth = 1; }
    page.drawSvgPath(d, o);
  }
  function wrapRuns(runs:any[], width:number) {
    const lines:any[] = []; let line:any[] = [], w = 0;
    for (const run of runs) for (const p of String(run.t ?? "").split(/(\s+)/)) {
      if (p === "") continue;
      const pw = run.f.widthOfTextAtSize(p, run.s);
      if (w + pw > width && line.length && p.trim() !== "") { lines.push(line); line = []; w = 0; }
      if (line.length === 0 && p.trim() === "") continue;
      line.push({ ...run, t:p, w:pw }); w += pw;
    }
    if (line.length) lines.push(line);
    return lines;
  }
  function drawRuns(runs:any[], o:any = {}) {
    for (const ln of wrapRuns(runs, o.width ?? W)) {
      const size = Math.max(...ln.map((s:any)=>s.s)); need(size*1.45);
      let cx = o.x ?? M;
      for (const seg of ln) { page.drawText(seg.t,{x:cx,y:y-size,size:seg.s,font:seg.f,color:seg.c}); cx += seg.w; }
      y -= size*1.45;
    }
    y -= o.after ?? 0;
  }
  function h2(text:string) {
    need(30); y -= 12;
    page.drawText(String(text), { x:M, y:y-14.5*PX, size:14.5*PX, font:bold, color:NAVY });
    y -= 14.5*PX + 5;
    page.drawLine({ start:{x:M,y}, end:{x:M+W,y}, thickness:0.8, color:LINE }); y -= 8;
  }
  function statementBox(text:string) {
    const lines = wrapRuns([{t:String(text??""),f:reg,s:12.5*PX,c:INK}], W-32);
    const h = lines.length*12.5*PX*1.5 + 20; need(h+6);
    roundRect(M,y,W,h,8*PX,STMT_BG,LINE);
    const top = y; y -= 12;
    for (const ln of lines) { let cx = M+16;
      for (const seg of ln) { page.drawText(seg.t,{x:cx,y:y-seg.s,size:seg.s,font:seg.f,color:seg.c}); cx += seg.w; }
      y -= 12.5*PX*1.5; }
    y = top - h - 6;
  }
  function qRow(it:any) {
    const tag = it.tag_label ? String(it.tag_label) : "";
    const cls = ["pos","att","neu"].includes(it.tag_class) ? it.tag_class : "neu";
    const tagS = 9.5*PX, tagW = tag ? bold.widthOfTextAtSize(tag,tagS)+14*PX : 0;
    const lines = wrapRuns([
      { t:(it.question ?? "")+": ", f:reg,  s:13*PX, c:INK },
      { t:it.answer_text ?? "",     f:bold, s:13*PX, c:INK },
    ], W - (tag ? tagW+12 : 0));
    need(lines.length*13*PX*1.5 + 16);
    const top = y; y -= 6;
    for (const ln of lines) { let cx = M;
      for (const seg of ln) { page.drawText(seg.t,{x:cx,y:y-seg.s,size:seg.s,font:seg.f,color:seg.c}); cx += seg.w; }
      y -= 13*PX*1.5; }
    if (tag) {
      const bg = cls==="pos"?GREENBG:cls==="att"?AMBERBG:NEU_BG;
      const fg = cls==="pos"?TEAL_D :cls==="att"?NAVY   :MUTED;
      const px = M + W - tagW;
      roundRect(px, top-4, tagW, tagS+6*PX, 5*PX, bg, null);
      page.drawText(tag, { x:px+7*PX, y:top-4-tagS-1, size:tagS, font:bold, color:fg });
    }
    y -= 6; page.drawLine({ start:{x:M,y}, end:{x:M+W,y}, thickness:0.7, color:HAIR });
  }

  const kick = [`Issued by ${doc.client_name ?? ""}`, "Status Determination Statement", String(row.ref ?? "")];
  const ks = 11*PX;
  if (logo) { const h=30, w=(logo.width/logo.height)*h; page.drawImage(logo,{x:M,y:y-h,width:w,height:h}); }
  let ky = y-2;
  for (const k of kick) { const t = k.toUpperCase();
    page.drawText(t,{x:M+W-reg.widthOfTextAtSize(t,ks),y:ky-ks,size:ks,font:reg,color:MUTED}); ky -= ks*1.3; }
  y = Math.min(y-34, ky) - 10;
  page.drawLine({ start:{x:M,y}, end:{x:M+W,y}, thickness:3*PX, color:TEAL }); y -= 18;

  page.drawText("Status Determination Statement",{x:M,y:y-23*PX,size:23*PX,font:bold,color:NAVY});
  y -= 23*PX + 6;
  drawRuns([{t:"Issued under the off-payroll working rules (Chapter 10, Part 2 ITEPA 2003).",f:reg,s:11*PX,c:MUTED}],{after:8});

  const meta:[string,string][] = [
    ["Worker / PSC", doc.worker ?? "—"], ["Role / assignment", doc.role_title ?? "—"],
    ["Role reference", doc.role_ref ?? "—"], ["Reference", row.ref ?? "—"],
    ["Date issued", opts.issuedOn ?? "—"], ["Review by", opts.reviewBy ?? "—"],
  ];
  const colW = (W-24)/2;
  for (let i=0;i<meta.length;i+=2) { need(34);
    [meta[i],meta[i+1]].forEach((cell,j)=>{ if(!cell) return;
      const cx = M + j*(colW+24);
      page.drawText(cell[0].toUpperCase(),{x:cx,y:y-10.5*PX,size:10.5*PX,font:bold,color:MUTED});
      page.drawText(String(cell[1]),{x:cx,y:y-10.5*PX-14,size:13*PX,font:reg,color:INK});
      page.drawLine({start:{x:cx,y:y-32},end:{x:cx+colW,y:y-32},thickness:0.7,color:META_HR}); });
    y -= 40; }
  y -= 2;

  const isOut = doc.outcome === "out", isIn = doc.outcome === "in";
  need(60);
  roundRect(M,y,W,52,10*PX, isOut?GREENBG:isIn?REDBG:AMBERBG, null);
  page.drawText(String(doc.verdict_label ?? (isOut?"OUTSIDE IR35":isIn?"INSIDE IR35":"BORDERLINE")),
    { x:M+20*PX, y:y-16-22*PX*0.72, size:22*PX, font:bold, color: isOut?TEAL_D:isIn?MAGENTA:NAVY });
  page.drawText(doc.office_holder ? "Office-holder override"
      : `Key ${sgn(doc.key_score)} / 30 · combined ${sgn(doc.total_score)}`,
    { x:M+20*PX, y:y-42, size:12*PX, font:reg, color:INK });
  y -= 66;

  if (doc.role_summary) { h2("Role summary"); statementBox(doc.role_summary); }
  if (row.reviewerReasoning) { h2("Review"); statementBox(row.reviewerReasoning); }

  const groups: Record<string, any[]> = {};
  for (const it of doc.items) (groups[it.group ?? "Assessment"] ||= []).push(it);
  for (const g of Object.keys(groups)) { h2(g); for (const it of groups[g]) qRow(it); }

  if (doc.evidence?.length) { h2("Evidence recorded");
    for (const e of doc.evidence)
      drawRuns([{t:(e.question??"")+": ",f:bold,s:13*PX,c:INK},{t:e.note??"",f:reg,s:13*PX,c:INK}],{after:4}); }

  const st = doc.statements ?? {};
  if (st.reasonable_care) { h2("Statement of reasonable care"); statementBox(st.reasonable_care); }
  if (st.disagreement)    { h2("If the worker disagrees");      statementBox(st.disagreement); }

  h2("Determined by (end-hirer)");
  need(96); y -= 6;
  const sigH = 40;
  if (opts.signaturePng) { try {
      const sig = await pdf.embedPng(opts.signaturePng);
      page.drawImage(sig,{x:M,y:y-sigH,width:Math.min((sig.width/sig.height)*sigH,210),height:sigH});
    } catch { } }
  y -= sigH + 12;
  page.drawLine({start:{x:M,y},end:{x:M+230,y},thickness:0.9,color:GREY});
  page.drawLine({start:{x:M+W-230,y},end:{x:M+W,y},thickness:0.9,color:GREY});
  page.drawText("NAME",{x:M,y:y+5,size:10.5*PX,font:bold,color:MUTED});
  page.drawText("DATE",{x:M+W-230,y:y+5,size:10.5*PX,font:bold,color:MUTED});
  page.drawText(String(opts.signedOffBy ?? "—"),{x:M,y:y-15,size:13*PX,font:bold,color:INK});
  page.drawText(String(opts.signedOffAt ?? opts.issuedOn ?? "—"),{x:M+W-230,y:y-15,size:13*PX,font:bold,color:INK});

  const pages = pdf.getPages();
  pages.forEach((p:any,i:number)=>{
    p.drawLine({start:{x:M,y:M+24},end:{x:M+W,y:M+24},thickness:0.8,color:LINE});
    p.drawText(String(st.footer ?? ""),{x:M,y:M+13,size:11*PX*0.8,font:reg,color:MUTED,maxWidth:W-50});
    if (row.documentSha) p.drawText(`Document seal (SHA-256): ${row.documentSha}`,{x:M,y:M+4,size:6.2,font:reg,color:MUTED});
    const n = `${i+1} / ${pages.length}`;
    p.drawText(n,{x:M+W-reg.widthOfTextAtSize(n,7.5),y:M+13,size:7.5,font:reg,color:MUTED});
  });
  return await pdf.save();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405);

  const runId = crypto.randomUUID().slice(0, 8);
  const log = (...a: unknown[]) => console.log(`[issue-sds ${runId}]`, ...a);

  const SB_URL = Deno.env.get("SUPABASE_URL");
  const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const RESEND = Deno.env.get("RESEND_API_KEY");
  const missing = [["SUPABASE_URL",SB_URL],["SUPABASE_SERVICE_ROLE_KEY",SB_KEY],["RESEND_API_KEY",RESEND]]
    .filter(([,v]) => !v).map(([k]) => k);
  if (missing.length) { log("missing secrets", missing); return json({ error: `missing secrets: ${missing.join(", ")}` }, 500); }

  const auth  = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "no token" }, 401);

  // NB no SUPABASE_ANON_KEY: it is DEPRECATED in this project, so there is no
  // anon client to build. Hand the caller's token to getUser() on the SERVICE
  // client instead - same verification, one fewer key to keep alive. Passing
  // the token as the API key (which this did first) makes the client reject
  // its own caller with "not signed in".
  const svc = createClient(SB_URL!, SB_KEY!, { auth: { persistSession: false } });
  const { data: who, error: whoErr } = await svc.auth.getUser(token);
  if (whoErr || !who?.user) return json({ error: "not signed in" }, 401);

  const role = (who.user.app_metadata as any)?.role ?? "";
  const tenant = (who.user.app_metadata as any)?.tenant ?? "";
  if (aalOf(token) !== "aal2") return json({ error: "MFA required" }, 403);
  if (!MAY_ISSUE.includes(role)) return json({ error: `role ${role || "(none)"} may not issue a statement` }, 403);

  let body: any = {};
  try { body = await req.json(); } catch { }
  const workerRef = String(body.worker_ref ?? "").trim();
  if (!workerRef) return json({ error: "worker_ref is required" }, 400);

  const db = svc;

  const { data: sdsRows, error: sdsErr } = await db.from("sds")
    .select("sds_ref,worker_ref,client_id,outcome,issued_on,review_by,signed_off_by,signed_off_at,reviewer_reasoning,document,document_sha256")
    .eq("client_id", tenant).eq("worker_ref", workerRef)
    .order("issued_on", { ascending: false }).limit(1);
  if (sdsErr) { log("sds read failed", sdsErr.message); return json({ error: sdsErr.message }, 500); }
  const sds = sdsRows?.[0];
  if (!sds) return json({ error: `no statement has been issued for ${workerRef}` }, 404);
  if (!sds.document?.items?.length)
    return json({ error: `${sds.sds_ref} has no stored statement - it is deliberately not rebuilt from the register` }, 409);
  if (!sds.signed_off_by)
    return json({ error: `${sds.sds_ref} has not been signed off - a statement is never issued before the client signs it` }, 409);

  const { data: recips, error: rErr } = await db.rpc("sds_recipients_for",
    { p_client_id: tenant, p_worker_ref: workerRef });
  if (rErr) { log("recipients failed", rErr.message); return json({ error: rErr.message }, 500); }
  if (!recips?.length) return json({ error: "no recipients resolved - the chain is unknown" }, 409);

  const { data: client } = await db.from("clients")
    .select("client_name,logo_png_base64").eq("client_id", tenant).maybeSingle();
  const { data: worker } = await db.from("workers")
    .select("worker_name,role_title,assignment_start_date,prefill_role_ref").eq("client_id", tenant)
    .eq("worker_ref", workerRef).maybeSingle();

  const fmtDate = (d: unknown) => {
    if (!d) return "—";
    const t = new Date(String(d));
    return isNaN(t.getTime()) ? "—"
      : t.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  };
  const doc = sds.document;
  const issuedOn = fmtDate(sds.issued_on), reviewBy = fmtDate(sds.review_by);
  const startDate = fmtDate(worker?.assignment_start_date);
  const roleRef = doc.role_ref ?? worker?.prefill_role_ref ?? "—";
  const roleTitle = doc.role_title ?? worker?.role_title ?? "";
  const contractorName = doc.worker ?? worker?.worker_name ?? "";
  const firstName = String(contractorName).split(/\s+/).filter(Boolean).slice(-2, -1)[0] ?? String(contractorName).split(/\s+/)[0] ?? "";
  const verdict = doc.verdict_label ?? (doc.outcome === "out" ? "OUTSIDE IR35" : "INSIDE IR35");

  let pdfB64 = "";
  try {
    const bytes = await buildSdsPdf(doc, { ref: sds.sds_ref, documentSha: sds.document_sha256,
                                           reviewerReasoning: sds.reviewer_reasoning },
      { logoPng: client?.logo_png_base64 ? b64ToBytes(client.logo_png_base64) : null,
        issuedOn, reviewBy,
        signedOffBy: sds.signed_off_by, signedOffAt: fmtDate(sds.signed_off_at) });
    pdfB64 = bytesToB64(bytes);
    log("pdf built", bytes.length, "bytes");
  } catch (e) {
    log("pdf failed", String(e));
    return json({ error: `could not build the statement PDF: ${String(e)}` }, 500);
  }
  const filename = `Status_Determination_Statement_${sds.sds_ref}.pdf`;

  const sign = "\n\nKind regards,\nThe IR35 Workbench Team\n\n" +
    `Administered by Ascend People Solutions Ltd on behalf of ${client?.client_name ?? tenant} using the ` +
    "IR35 Workbench.";

  const body6a =
`Dear ${firstName},

Thank you for completing your IR35 Workbench SDS Questionnaire.

${client?.client_name ?? tenant} has now determined your employment status for tax purposes for this
assignment. Your Status Determination Statement is attached, and sets out the
outcome together with the reasons for it. It is also available at any time by
logging in to the IR35 Workbench.

  Role:            ${roleTitle}
  Reference:       ${roleRef}
  Determination:   ${verdict}
  Date issued:     ${issuedOn}
  Review date:     ${reviewBy}

IF YOU DISAGREE WITH THIS DETERMINATION

You can make representations through the IR35 Workbench:

  ${APP_URL}

Log in, select "Dispute this determination", and set out the grounds for your
disagreement. ${client?.client_name ?? tenant} will consider your representations and respond with
its decision and the reasons for it within 45 days, as required by the
off-payroll working rules.

REVIEW AND CHANGES

This determination will be reviewed by ${reviewBy}, or sooner if the role, the
contract terms or the working practices materially change.

Your hiring manager is copied for their records.

If you have any questions, reply to this email or write to
${ARCHIVE}.` + sign;

  const body6b =
`Dear colleague,

Please find attached the Status Determination Statement issued by ${client?.client_name ?? tenant} for
the following engagement, provided to you as a party ${client?.client_name ?? tenant} contracts with
for the supply of this worker.

  Consultant:      ${contractorName}
  Role:            ${roleTitle}
  Reference:       ${roleRef}
  Determination:   ${verdict}
  Date issued:     ${issuedOn}

The reasons for the determination are set out in the attached statement. Please
apply the appropriate tax treatment from ${startDate} or the date of this
statement, whichever is later.

If you wish to make representations against this determination, please write to
${ARCHIVE} and we will pass them to ${client?.client_name ?? tenant}.
${client?.client_name ?? tenant} will respond with its decision and the reasons for it within 45 days.` + sign;

  const contractor  = recips.find((r: any) => r.recipient_role === "contractor");
  const lineManager = recips.find((r: any) => r.recipient_role === "line_manager");
  const feePayers   = recips.filter((r: any) => r.recipient_role === "fms" || r.recipient_role === "agency");
  const results: any[] = [];

  async function send(to: string[], cc: string[], subject: string, text: string, roles: any[]) {
    let messageId: string | null = null, error: string | null = null;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM, to, cc: cc.length ? cc : undefined, bcc: [ARCHIVE],
          reply_to: ARCHIVE, subject, text,
          attachments: [{ filename, content: pdfB64 }],
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) error = out?.message ?? `resend ${res.status}`;
      else messageId = out?.id ?? null;
    } catch (e) { error = String(e); }

    for (const r of roles) {
      const row = {
        client_id: tenant, sds_ref: sds.sds_ref, worker_ref: workerRef,
        recipient_role: r.recipient_role, recipient_name: r.recipient_name,
        recipient_email: r.recipient_email,
        status: error ? "failed" : "sent",
        provider_message_id: messageId, error,
        sent_at: error ? null : new Date().toISOString(),
      };
      const { error: insErr } = await db.from("sds_deliveries").insert(row);
      if (insErr) log("delivery row failed", r.recipient_role, insErr.message);
      results.push({ role: r.recipient_role, to: r.recipient_email, status: row.status, error });
    }
    return !error;
  }

  if (contractor) {
    await send([contractor.recipient_email], lineManager ? [lineManager.recipient_email] : [],
      `Your IR35 Status Determination Statement - ${roleTitle} (${roleRef})`,
      body6a, lineManager ? [contractor, lineManager] : [contractor]);
  } else {
    log("no contractor email - statement not sent to the worker");
  }

  for (const fp of feePayers) {
    await send([fp.recipient_email], [],
      `IR35 Status Determination Statement - ${contractorName}, ${roleTitle} (${roleRef})`,
      body6b, [fp]);
  }

  const failed = results.filter(r => r.status === "failed");
  await db.from("audit_log").insert({
    client_id: tenant, entity: sds.sds_ref, event_type: "Statement issued to the chain",
    actor: who.user.email ?? role,
    detail: `Sent to ${results.length - failed.length} of ${results.length} entitled parties (` +
            results.map(r => r.role).join(", ") + ")." +
            (failed.length ? ` FAILED: ${failed.map(r => r.role + " " + r.to).join("; ")}.` : ""),
  });

  log("done", JSON.stringify(results));
  return json({ sds_ref: sds.sds_ref, sent: results.length - failed.length,
                failed: failed.length, results }, failed.length ? 207 : 200);
});