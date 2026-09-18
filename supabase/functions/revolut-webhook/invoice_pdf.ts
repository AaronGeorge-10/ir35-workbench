// invoice_pdf.ts - IR35 Workbench contractor VAT invoice, drawn with pdf-lib.
// PAY-05 (Archie, 17 Sep 2026). Runs inside the Supabase Edge Function in London, so the
// invoice (which carries contractor personal data) never leaves the existing processor.
//
// DESIGN SOURCE: Olivia's approved template
//   AI Platform/Orsted IR35 Demo/Invoice Template/IR35_Workbench_Contractor_Invoice_Template_v1.0.hbs
// This file reproduces that layout. Every constant below is the template's CSS converted to
// points (1mm = 2.8346pt), cross-checked by pixel comparison against the template rendered in Chromium.
// Aaron's change of 17 Sep: the "Work order ref." box shows the role reference ("Role ref.").
// Change the design in the .hbs first, then here - never here alone.
//
// Runtime-agnostic: pdf-lib and fontkit are passed in, so the same code runs in Deno and in the tests.

export type InvoiceData = {
  supplier: { legal_name: string; address_lines: string[]; company_number: string; vat_number: string; contact_email: string };
  invoice_number: string; is_paid: boolean; invoice_date: string; tax_point_date: string | null;
  payment_date: string; payment_method: string; payment_reference: string;
  contractor: { full_name: string; company_name?: string | null; address_lines?: string[] | null; vat_number?: string | null; email: string };
  assessment: { end_client_name: string; role_title: string; role_reference: string; reference: string };
  line_items: { description: string; detail: string; quantity: number; unit_price: string; vat_rate: number; net: string }[];
  totals: { net: string; vat_rate: number; vat: string; gross: string; paid: string; balance: string };
};
export type InvoiceAssets = { sansRegular: Uint8Array; sansBold: Uint8Array; mono: Uint8Array; logoPdf: Uint8Array };

const MINUS = String.fromCharCode(0x2212);
const POUND = String.fromCharCode(0xa3);

export function makeInvoiceRenderer(lib: any, fontkit: any) {
  const { PDFDocument, rgb } = lib;
  const PW = 595.28, PH = 841.89, MM = 72 / 25.4;
  const X0 = 18 * MM, XR = PW - 18 * MM, CW = XR - X0;
  const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
  const C = { navy: hex('#003182'), teal: hex('#218380'), tealSoft: hex('#E3F0EF'), magenta: hex('#9C2373'),
    ink: hex('#231F20'), muted: hex('#6B6B6B'), line: hex('#DBDBDB'), soft: hex('#F7F7F8'), white: rgb(1, 1, 1) };
  const SANS = { asc: 1854 / 2048, desc: 434 / 2048 }, MONO = { asc: 1705 / 2048, desc: 615 / 2048 };
  const HAIR = 0.75;               // Chromium draws every sub-2px CSS border in this template as 1 device px
  const BODY = 9.5, BODY_LH = 9.5 * 1.45, SMALL = 8.5, SMALL_LH = 8.5 * 1.45, LABEL = 7.5, LABEL_LH = 7.5 * 1.45;
  const LABEL_GAP = 1.6 * MM;
  const PAGE_BOTTOM_LIMIT = 765.54; // the footer's top edge on a single A4 page

  return async function renderInvoicePdf(d: InvoiceData, a: InvoiceAssets): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    pdf.setTitle(`Invoice ${d.invoice_number} - IR35 Workbench`);
    pdf.setAuthor(d.supplier.legal_name);
    pdf.setCreator('IR35 Workbench');
    pdf.setProducer('IR35 Workbench');
    const fixed = new Date(0);
    pdf.setCreationDate(fixed); pdf.setModificationDate(fixed);
    const R = await pdf.embedFont(a.sansRegular, { subset: true });
    const B = await pdf.embedFont(a.sansBold, { subset: true });
    const M = await pdf.embedFont(a.mono, { subset: true });
    const [logo] = await pdf.embedPdf(a.logoPdf, [0]);
    // Layout runs first as a dry run. If the content would spill past one A4 page, the vertical gaps
    // between sections are tightened step by step (never the text). Only then is the page drawn.
    const NOOP = { drawText() {}, drawLine() {}, drawRectangle() {}, drawSvgPath() {}, drawPage() {} };
    let page: any = NOOP;
    let GS = 1, BILL = BODY;   // gap scale, and the Bill-to text size (only ever reduced as a last resort)

    // ---- text helpers (top-down coordinates; y converted at draw time) ----
    const clean = (f: any, s: unknown) => {
      const t = Array.from(String(s ?? '')).map((ch) => (ch.codePointAt(0)! < 32 || ch.codePointAt(0) === 127) ? ' ' : ch).join('');
      const set = f.getCharacterSet ? new Set(f.getCharacterSet()) : null;
      if (!set) return t;
      return Array.from(t).map((ch) => {
        if (set.has(ch.codePointAt(0)!)) return ch;
        const base = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        return base && Array.from(base).every((c) => set.has(c.codePointAt(0)!)) ? base : '?';
      }).join('');
    };
    const width = (f: any, s: string, size: number, ls = 0) => f.widthOfTextAtSize(s, size) + ls * Array.from(s).length;
    // Chromium lays text out in whole CSS pixels: ascent and descent are rounded and the
    // half-leading is floored. Doing the same keeps each baseline within a fraction of a point.
    const PXU = 4 / 3;
    const baseline = (top: number, size: number, lh: number, m = SANS) => {
      const asc = Math.round(m.asc * size * PXU), desc = Math.round(m.desc * size * PXU);
      return top + (Math.floor((lh * PXU - asc - desc) / 2) + asc) / PXU;
    };
    function draw(s: string, x: number, top: number, o: { f: any; size: number; lh: number; color: any; ls?: number; align?: 'left' | 'right'; m?: any }) {
      const t = clean(o.f, s); if (!t) return 0;
      const w = width(o.f, t, o.size, o.ls || 0);
      let cx = o.align === 'right' ? x - w : x;
      const y = PH - baseline(top, o.size, o.lh, o.m);
      if (!o.ls) { page.drawText(t, { x: cx, y, size: o.size, font: o.f, color: o.color }); return w; }
      for (const ch of Array.from(t)) {
        page.drawText(ch, { x: cx, y, size: o.size, font: o.f, color: o.color });
        cx += o.f.widthOfTextAtSize(ch, o.size) + o.ls;
      }
      return w;
    }
    // greedy word wrap; a token wider than the line breaks by character (CSS break-word)
    function wrap(s: string, f: any, size: number, maxW: number, breakAll = false): string[] {
      const t = clean(f, s).replace(/\s+/g, ' ').trim();
      if (!t) return [];
      const lines: string[] = [];
      const hard = (tok: string) => { let cur = ''; for (const ch of Array.from(tok)) { if (cur && width(f, cur + ch, size) > maxW + 0.01) { lines.push(cur); cur = ch; } else cur += ch; } return cur; };
      if (breakAll) { const last = hard(t); if (last) lines.push(last); return lines; }
      let line = '';
      for (const word of t.split(' ')) {
        const cand = line ? line + ' ' + word : word;
        if (width(f, cand, size) <= maxW + 0.01) { line = cand; continue; }
        if (line) lines.push(line);
        line = width(f, word, size) <= maxW + 0.01 ? word : hard(word);
      }
      if (line) lines.push(line);
      return lines;
    }
    const svgRect = (x: number, top: number, w: number, h: number, r: number) => {
      r = Math.min(r, h / 2, w / 2);
      return { path: `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${h - r} Q ${w} ${h} ${w - r} ${h} L ${r} ${h} Q 0 ${h} 0 ${h - r} L 0 ${r} Q 0 0 ${r} 0 Z`, x, y: PH - top };
    };
    const label = (s: string, x: number, top: number) => draw(s.toUpperCase(), x, top, { f: B, size: LABEL, lh: LABEL_LH, color: C.muted, ls: 0.8 });
    const hline = (x1: number, x2: number, yCenterTop: number, color: any, t = HAIR) =>
      page.drawLine({ start: { x: x1, y: PH - yCenterTop }, end: { x: x2, y: PH - yCenterTop }, thickness: t, color });

    const layout = (): number => {
      // ---- 1. brand accent (three teal diagonals, top right) ----
      const AX = PW - 62 * MM, SX = MM, SY = MM;
      for (const [x1, y1, x2, y2] of [[22, 0, 62, 28], [32, 0, 62, 21], [42, 0, 62, 14]])
        page.drawLine({ start: { x: AX + x1 * SX, y: PH - y1 * SY }, end: { x: AX + x2 * SX, y: PH - y2 * SY }, thickness: 1.1 * SX, color: C.teal, opacity: 0.55 });

      // ---- 2. masthead ----
      const top0 = 16 * MM;
      const LOGO_W = 52 * MM, LOGO_H = LOGO_W * 849 / 2048;
      page.drawPage(logo, { x: X0, y: PH - top0 - LOGO_H, width: LOGO_W, height: LOGO_H });
      let tTop = top0 + 2 * MM;
      draw('Tax invoice', XR, tTop, { f: B, size: 22, lh: 22, color: C.navy, ls: -0.2, align: 'right' });
      tTop += 22 + 2 * MM;
      draw('IR35 WORKBENCH', XR, tTop, { f: B, size: 9, lh: 9 * 1.45, color: C.teal, ls: 0.6, align: 'right' });
      tTop += 9 * 1.45;
      if (d.is_paid) {
        tTop += 3 * MM;
        const tw = width(B, 'PAID', 9, 1.2), padX = 3.5 * MM, padY = 1.2 * MM;
        const bw = tw + 2 * padX + 2 * HAIR, bh = 9 * 1.45 + 2 * padY + 2 * HAIR, bx = XR - bw;
        const r = svgRect(bx + HAIR / 2, tTop + HAIR / 2, bw - HAIR, bh - HAIR, 1.5 * MM - HAIR / 2);
        page.drawSvgPath(r.path, { x: r.x, y: r.y, borderColor: C.teal, borderWidth: HAIR });
        draw('PAID', bx + HAIR + padX, tTop + HAIR + padY - 0.75, { f: B, size: 9, lh: 9 * 1.45, color: C.teal, ls: 1.2 });
        tTop += bh;
      }
      const mastBottom = Math.max(top0 + LOGO_H, tTop);

      // ---- 3. tri-colour rule ----
      let y = mastBottom + 8 * MM * GS;
      const RH = 1.6 * MM, rr = RH / 2;
      const s1 = CW * 0.6, s2 = CW * 0.88;
      page.drawSvgPath(`M ${rr} 0 L ${s1} 0 L ${s1} ${RH} L ${rr} ${RH} Q 0 ${RH} 0 ${rr} Q 0 0 ${rr} 0 Z`, { x: X0, y: PH - y, color: C.navy });
      page.drawRectangle({ x: X0 + s1, y: PH - y - RH, width: s2 - s1, height: RH, color: C.teal });
      page.drawSvgPath(`M 0 0 L ${CW - s2 - rr} 0 Q ${CW - s2} 0 ${CW - s2} ${rr} Q ${CW - s2} ${RH} ${CW - s2 - rr} ${RH} L 0 ${RH} Z`, { x: X0 + s2, y: PH - y, color: C.magenta });
      y += RH + 7 * MM * GS;

      // ---- 4. parties + meta ----
      const G6 = 6 * MM, frU = (CW - 2 * G6) / (0.95 + 0.95 + 1.25);
      const colX = [X0, X0 + 0.95 * frU + G6, X0 + 1.9 * frU + 2 * G6], colW = [0.95 * frU, 0.95 * frU, 1.25 * frU];
      const pTop = y;
      const para = (lines: { s: string; f: any; mt?: number }[], x: number, w: number, startTop: number, size = BODY) => {
        let t = startTop; const lh = size * 1.45;
        for (const ln of lines) {
          t += ln.mt || 0;
          for (const part of wrap(ln.s, ln.f, size, w)) { draw(part, x, t, { f: ln.f, size, lh, color: C.ink }); t += lh; }
        }
        return t;
      };
      // From
      label('From', colX[0], pTop);
      let t1 = pTop + LABEL_LH + LABEL_GAP;
      t1 = para([{ s: d.supplier.legal_name, f: B }, ...d.supplier.address_lines.map((s) => ({ s, f: R }))], colX[0], colW[0], t1);
      t1 += LABEL_GAP;
      { const lead = 'VAT reg. no. '; const w0 = draw(lead, colX[0], t1, { f: R, size: BODY, lh: BODY_LH, color: C.ink });
        draw(d.supplier.vat_number, colX[0] + w0, t1, { f: B, size: BODY, lh: BODY_LH, color: C.ink }); t1 += BODY_LH; }
      t1 = para([{ s: `Company no. ${d.supplier.company_number}`, f: R }], colX[0], colW[0], t1);
      // Bill to
      const k = d.contractor;
      label('Bill to', colX[1], pTop);
      const billLines: { s: string; f: any; mt?: number }[] = [];
      if (k.company_name && k.company_name.trim()) { billLines.push({ s: k.company_name, f: B }, { s: `FAO ${k.full_name}`, f: R }); }
      else billLines.push({ s: k.full_name, f: B });
      for (const s of k.address_lines || []) if (String(s).trim()) billLines.push({ s, f: R });
      const hasVat = !!(k.vat_number && k.vat_number.trim());
      if (hasVat) billLines.push({ s: `VAT reg. no. ${k.vat_number}`, f: R, mt: LABEL_GAP });
      billLines.push({ s: k.email, f: R, mt: hasVat ? 0 : LABEL_GAP });
      const t2 = para(billLines, colX[1], colW[1], pTop + LABEL_LH + LABEL_GAP, BILL);
      // meta table
      const PADV = 0.7 * MM, refW = 97.75, valRight = XR, labX = colX[2];
      const metaRows: [string, string, boolean?][] = [['Invoice no.', d.invoice_number], ['Invoice date', d.invoice_date]];
      if (d.tax_point_date) metaRows.push(['Tax point', d.tax_point_date]);
      metaRows.push(['Payment received', d.payment_date], ['Paid by', d.payment_method], ['Payment ref.', d.payment_reference, true]);
      let t3 = pTop;
      for (const [l, v, isRef] of metaRows) {
        draw(l, labX, t3 + PADV, { f: R, size: BODY, lh: BODY_LH, color: C.muted });
        let h = BODY_LH;
        if (isRef) {
          const lines = wrap(v, M, 7, refW, true); const lh = 7 * 1.45;
          lines.forEach((ln, i) => draw(ln, valRight, t3 + PADV + i * lh, { f: M, size: 7, lh, color: C.ink, align: 'right', m: MONO }));
          h = Math.max(h, lines.length * lh);
        } else draw(v, valRight, t3 + PADV, { f: B, size: BODY, lh: BODY_LH, color: C.ink, align: 'right' });
        t3 += h + 2 * PADV;
      }
      y = Math.max(t1, t2, t3);

      // ---- 5. assessment context ----
      const aTop = y + 8 * MM * GS, PAD4 = 4 * MM, BL = 3;
      const aX = X0 + BL + 5 * MM, aInner = CW - BL - 10 * MM, G4 = 4 * MM, aColW = (aInner - 3 * G4) / 4;
      const cells: [string, string][] = [['End client', d.assessment.end_client_name], ['Role', d.assessment.role_title],
        ['Role ref.', d.assessment.role_reference], ['Assessment ref.', d.assessment.reference]];
      const cellLines = cells.map(([, v]) => wrap(v, B, BODY, aColW));
      const aH = PAD4 + LABEL_LH + LABEL_GAP + Math.max(1, ...cellLines.map((l) => l.length)) * BODY_LH + PAD4;
      { const r = svgRect(X0, aTop, CW, aH, 1 * MM); page.drawSvgPath(r.path, { x: r.x, y: r.y, color: C.soft });
        const rad = 1 * MM;
        page.drawSvgPath(`M ${BL} 0 L ${rad} 0 Q 0 0 0 ${rad} L 0 ${aH - rad} Q 0 ${aH} ${rad} ${aH} L ${BL} ${aH} Z`, { x: X0, y: PH - aTop, color: C.teal }); }
      cells.forEach(([l], i) => {
        const cx = aX + i * (aColW + G4);
        label(l, cx, aTop + PAD4);
        cellLines[i].forEach((ln, j) => draw(ln, cx, aTop + PAD4 + LABEL_LH + LABEL_GAP + j * BODY_LH, { f: B, size: BODY, lh: BODY_LH, color: C.ink }));
      });
      y = aTop + aH;

      // ---- 6. line items ----
      const tTopL = y + 8 * MM * GS, PX3 = 3 * MM;
      const cols = [X0, X0 + CW * 0.52, 342.69, 410.09, 469.39, XR];   // auto-sized from the fixed header text
      const headH = 2 * 2.4 * MM + LABEL_LH;
      page.drawRectangle({ x: X0, y: PH - tTopL - headH, width: CW, height: headH, color: C.navy });
      const heads = ['Description', 'Qty', 'Unit price', 'VAT rate', 'Net amount'];
      heads.forEach((h, i) => draw(h.toUpperCase(), i === 0 ? cols[0] + PX3 : cols[i + 1] - PX3, tTopL + 2.4 * MM,
        { f: B, size: LABEL, lh: LABEL_LH, color: C.white, ls: 0.6, align: i === 0 ? 'left' : 'right' }));
      let rowTop = tTopL + headH;
      const PADR = 3.4 * MM, descW = cols[1] - cols[0] - 2 * PX3;
      for (const li of d.line_items) {
        let ty = rowTop + PADR;
        for (const ln of wrap(li.description, B, BODY, descW)) { draw(ln, cols[0] + PX3, ty, { f: B, size: BODY, lh: BODY_LH, color: C.ink }); ty += BODY_LH; }
        ty += 0.8 * MM;
        for (const ln of wrap(li.detail, R, SMALL, descW)) { draw(ln, cols[0] + PX3, ty, { f: R, size: SMALL, lh: SMALL_LH, color: C.muted }); ty += SMALL_LH; }
        const nums = [String(li.quantity), `${POUND}${li.unit_price}`, `${li.vat_rate}%`, `${POUND}${li.net}`];
        nums.forEach((n, i) => draw(n, cols[i + 2] - PX3, rowTop + PADR, { f: R, size: BODY, lh: BODY_LH, color: C.ink, align: 'right' }));
        const rowBottom = ty + PADR;
        hline(X0, XR, rowBottom + HAIR / 2, C.line);
        rowTop = rowBottom + HAIR;
      }
      y = rowTop;

      // ---- 7. totals ----
      let tt = y + 5 * MM * GS;
      const TW = 78 * MM, TX = XR - TW, P16 = 1.6 * MM, LX = TX + PX3, VX = XR - PX3;
      const trow = (l: string, v: string, o: { f: any; fv: any; size: number; color: any; padTop?: number; bg?: any }) => {
        const lh = o.size * 1.45, pt = o.padTop ?? P16, h = pt + lh + P16;
        if (o.bg) page.drawRectangle({ x: TX, y: PH - tt - h, width: TW, height: h, color: o.bg });
        draw(l, LX, tt + pt, { f: o.f, size: o.size, lh, color: o.color });
        draw(v, VX, tt + pt, { f: o.fv, size: o.size, lh, color: o.color, align: 'right' });
        tt += h;
      };
      trow('Total excluding VAT', `${POUND}${d.totals.net}`, { f: R, fv: B, size: BODY, color: C.ink });
      trow(`VAT at ${d.totals.vat_rate}%`, `${POUND}${d.totals.vat}`, { f: R, fv: B, size: BODY, color: C.ink });
      tt += HAIR / 2; hline(TX, XR, tt, C.ink); tt += HAIR / 2;
      trow('Total including VAT', `${POUND}${d.totals.gross}`, { f: B, fv: B, size: 11.5, color: C.navy, padTop: 2.6 * MM });
      trow('Amount paid', `${MINUS}${POUND}${d.totals.paid}`, { f: B, fv: B, size: BODY, color: C.teal });
      trow('Balance due', `${POUND}${d.totals.balance}`, { f: B, fv: B, size: BODY, color: C.ink, bg: C.tealSoft });
      y = tt;

      // ---- 8. notes ----
      const nTop = y + 9 * MM * GS, G8 = 8 * MM, nfr = (CW - G8) / 2.3;
      const n1x = X0, n1w = 1.3 * nfr, n2x = X0 + 1.3 * nfr + G8, n2w = nfr;
      label('About this invoice', n1x, nTop);
      let nt1 = nTop + LABEL_LH + LABEL_GAP;
      const about = 'This invoice covers the IR35 status assessment service provided through the IR35 Workbench for the engagement shown above, including your IR35 Workbench SDS Questionnaire. The status determination itself is made by the end client.';
      for (const ln of wrap(about, R, BODY, n1w)) { draw(ln, n1x, nt1, { f: R, size: BODY, lh: BODY_LH, color: C.ink }); nt1 += BODY_LH; }
      nt1 += LABEL_GAP;
      for (const ln of wrap('Paid in full at the time of purchase. No further payment is due. Please keep this invoice for your records.', R, SMALL, n1w)) { draw(ln, n1x, nt1, { f: R, size: SMALL, lh: SMALL_LH, color: C.muted }); nt1 += SMALL_LH; }
      nt1 += LABEL_GAP;
      label('Questions', n2x, nTop);
      let nt2 = nTop + LABEL_LH + LABEL_GAP;
      for (const ln of wrap('Log in to the IR35 Workbench, or email', R, BODY, n2w)) { draw(ln, n2x, nt2, { f: R, size: BODY, lh: BODY_LH, color: C.ink }); nt2 += BODY_LH; }
      for (const ln of wrap(d.supplier.contact_email, B, BODY, n2w)) { draw(ln, n2x, nt2, { f: B, size: BODY, lh: BODY_LH, color: C.ink }); nt2 += BODY_LH; }
      nt2 += LABEL_GAP;
      for (const ln of wrap(`Please quote invoice ${d.invoice_number}.`, R, SMALL, n2w)) { draw(ln, n2x, nt2, { f: R, size: SMALL, lh: SMALL_LH, color: C.muted }); nt2 += SMALL_LH; }
      nt2 += LABEL_GAP;
      const contentBottom = Math.max(nt1, nt2);

      // ---- 9. footer (pinned to the foot of the page) ----
      const fTop = PAGE_BOTTOM_LIMIT;
      hline(X0, XR, fTop + HAIR / 2, C.line);
      const ftTop = fTop + HAIR + 5 * MM;
      const w1 = draw('IR35 Workbench', X0, ftTop, { f: B, size: LABEL, lh: LABEL_LH, color: C.ink });
      draw(` is a service of ${d.supplier.legal_name}.`, X0 + w1, ftTop, { f: R, size: LABEL, lh: LABEL_LH, color: C.muted });
      draw(`Registered in England and Wales, company no. ${d.supplier.company_number}`, XR, ftTop, { f: R, size: LABEL, lh: LABEL_LH, color: C.muted, align: 'right' });
      draw(`VAT reg. no. ${d.supplier.vat_number}`, XR, ftTop + LABEL_LH, { f: R, size: LABEL, lh: LABEL_LH, color: C.muted, align: 'right' });

      return contentBottom;
    };
    let fitted = false;
    for (const [g, b] of [[1, BODY], [0.8, BODY], [0.6, BODY], [0.45, BODY], [0.3, BODY], [0.3, 8.5], [0.3, 7.5]]) {
      GS = g; BILL = b;
      if (layout() <= PAGE_BOTTOM_LIMIT + 0.5) { fitted = true; break; }
    }
    if (!fitted) throw new Error('invoice_overflow: the details do not fit on one A4 page');
    page = pdf.addPage([PW, PH]);
    layout();

    return await pdf.save({ useObjectStreams: false });
  };
}
