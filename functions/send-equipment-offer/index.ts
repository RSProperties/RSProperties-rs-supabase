// RS Properties - Supabase Edge Function
// Sends the equipment price offer to ONE client via Resend: branded HTML e-mail (summary card + button
// to the PDF) with the PDF (and optionally the .xlsx) attached.
// Deploy: supabase functions deploy send-equipment-offer
// Secrets: RESEND_API_KEY, EMAIL_FROM (optional)
// Caller gate: service role or an ACTIVE team member (same rule as send-payment-request).
// A copy goes to info@rsproperties.sk (bcc) and client replies go there too (reply_to).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { logResend } from "../_shared/email_log.ts";
import { callerAllowed } from "../_shared/caller_auth.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const JSON_H = { ...CORS, "Content-Type": "application/json" };
const TEAM_ADDR = "info@rsproperties.sk";
const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const MAX_TOTAL_B64 = 6_000_000; // ~4.5 MB of files in total
const MONTHS = ["januára","februára","marca","apríla","mája","júna","júla","augusta","septembra","októbra","novembra","decembra"];

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const eur = (n: unknown) =>
  (Number(n) || 0).toLocaleString("sk-SK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
function dateSk(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${Number(m[3])}. ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(await callerAllowed(req))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { headers: JSON_H, status: 403 });
  }
  try {
    const { to, subject, bodyText, attachments, pdfUrl, summary } = await req.json();
    const bad = (m: string) => new Response(JSON.stringify({ error: m }), { headers: JSON_H, status: 400 });

    if (typeof to !== "string" || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to.trim())) return bad("Invalid recipient email");
    if (typeof subject !== "string" || !subject.trim() || subject.length > 200) return bad("Invalid subject");
    if (typeof bodyText !== "string" || !bodyText.trim() || bodyText.length > 6000) return bad("Invalid body");
    if (!Array.isArray(attachments) || attachments.length < 1 || attachments.length > 3) return bad("Invalid attachments");
    let total = 0;
    for (const a of attachments) {
      if (!a || typeof a.filename !== "string" || !/^[\w .\-()]+\.(pdf|xlsx)$/i.test(a.filename) || a.filename.length > 120) return bad("Invalid filename");
      if (typeof a.b64 !== "string" || !a.b64 || !/^[A-Za-z0-9+/=]+$/.test(a.b64)) return bad("Invalid attachment");
      total += a.b64.length;
    }
    if (total > MAX_TOTAL_B64) return bad("Attachments too large");
    // the button may only point at our own public storage (no arbitrary links in mail sent from our domain)
    const linkOk = typeof pdfUrl === "string" && SB_URL && pdfUrl.startsWith(`${SB_URL}/storage/v1/object/public/`) && pdfUrl.length < 600;
    const sm = summary && typeof summary === "object" ? summary : {};
    const recipient = to.trim();

    const navy = "#1a2e44", gold = "#c9a96e", goldD = "#9a6f1a", cream = "#faf8f4", line = "#e8e4dd", mu = "#7a8694";
    const row = (k: string, v: string) =>
      `<tr><td style="padding:6px 0;color:${mu};font-size:13px">${k}</td><td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:${navy}">${v}</td></tr>`;
    const valid = dateSk(String(sm.validUntil || ""));
    const summaryHtml = `
  <div style="margin:22px 0 6px;background:${cream};border-left:4px solid ${gold};border-radius:0 12px 12px 0;padding:16px 20px">
    <div style="font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${goldD};margin-bottom:6px">Zhrnutie ponuky</div>
    <table role="presentation" style="width:100%;border-collapse:collapse">
      ${sm.propName ? row("Apartmán", esc(sm.propName)) : ""}
      ${Number(sm.persons) ? row("Kapacita", `${Number(sm.persons)} os.`) : ""}
      ${Number(sm.items) ? row("Počet položiek", String(Number(sm.items))) : ""}
      ${row("Spolu bez DPH", eur(sm.net))}
      ${row(Number(sm.vatPct) ? `DPH ${Number(sm.vatPct)} %` : "DPH", eur(sm.vat))}
    </table>
    <div style="margin-top:10px;background:${navy};border-radius:10px;padding:13px 16px;display:flex;justify-content:space-between;align-items:center">
      <span style="color:#fff;font-size:11px;letter-spacing:.1em;text-transform:uppercase;font-weight:700">Spolu s DPH</span>
      <span style="color:${gold};font-size:22px;font-weight:700">${eur(sm.gross)}</span>
    </div>
    ${valid ? `<div style="margin-top:10px;font-size:12px;color:${mu}">Platnosť ponuky do <b style="color:${navy}">${esc(valid)}</b></div>` : ""}
  </div>`;
    const buttonHtml = linkOk
      ? `<div style="text-align:center;margin:22px 0 4px"><a href="${esc(pdfUrl)}" style="display:inline-block;background:${navy};color:#fff;text-decoration:none;font-weight:700;font-size:14px;border-radius:99px;padding:13px 30px;border:2px solid ${gold}">Zobraziť cenovú ponuku (PDF)</a></div>`
      : "";
    const html = `<!DOCTYPE html>
<html lang="sk"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="color-scheme" content="light only"/><meta name="supported-color-schemes" content="light"/></head>
<body style="font-family:'DM Sans',Arial,sans-serif;background:#f5f1eb;margin:0;padding:28px 12px;color:${navy}">
<div style="max-width:620px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
  <div style="background:${navy};padding:20px 28px;border-bottom:4px solid ${gold}">
    <table role="presentation" style="width:100%;border-collapse:collapse"><tr>
      <td style="vertical-align:middle;width:56px"><img src="https://app.rsproperties.sk/icon-192.png" width="44" height="44" alt="RS" style="display:block;border-radius:10px"/></td>
      <td style="vertical-align:middle"><div style="color:#fff;font-size:18px;font-weight:700;letter-spacing:-.2px">RS Properties</div><div style="color:${gold};font-size:10px;letter-spacing:.14em;text-transform:uppercase;margin-top:2px">Správa krátkodobých prenájmov</div></td>
      <td style="vertical-align:middle;text-align:right"><div style="color:${gold};font-size:15px;font-weight:700">Cenová ponuka</div>${sm.no ? `<div style="color:rgba(255,255,255,.65);font-size:11px;margin-top:2px">č. ${esc(sm.no)}</div>` : ""}</td>
    </tr></table>
  </div>
  <div style="padding:28px 32px 24px">
    <div style="font-size:14px;line-height:1.7;white-space:pre-wrap">${esc(bodyText)}</div>
    ${summaryHtml}
    ${buttonHtml}
  </div>
  <div style="border-top:1px solid ${line};padding:16px 32px;text-align:center;font-size:11px;color:#a0aec0;background:${cream};line-height:1.6">
    RS Properties s.r.o. · <a href="mailto:${TEAM_ADDR}" style="color:#a0aec0">${TEAM_ADDR}</a> · www.rsproperties.sk
  </div>
</div>
</body></html>`;

    const fromAddr = Deno.env.get("EMAIL_FROM") || "RS Properties <noreply@rsproperties.sk>";
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromAddr,
        to: [recipient],
        bcc: [TEAM_ADDR],
        reply_to: TEAM_ADDR,
        subject,
        html,
        text: bodyText,
        attachments: attachments.map((a: { filename: string; b64: string }) => ({ filename: a.filename, content: a.b64 })),
      }),
    });
    const result = await resendRes.json();
    await logResend(resendRes, result, {
      to: recipient, subject, template: "equipment-offer",
      meta: { from: fromAddr, files: attachments.map((a: { filename: string }) => a.filename) },
    });
    if (!resendRes.ok) {
      console.error("Resend error:", result);
      return new Response(JSON.stringify({ error: result }), { headers: JSON_H, status: 500 });
    }
    return new Response(JSON.stringify({ ok: true, id: result.id }), { headers: JSON_H, status: 200 });
  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { headers: JSON_H, status: 500 });
  }
});
