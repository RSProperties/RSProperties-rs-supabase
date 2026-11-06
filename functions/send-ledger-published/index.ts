// RS Properties - Supabase Edge Function
// Tells an owner (via Resend) that a monthly accounting-ledger statement was published
// on the Owner Portal. Same look and behaviour as send-report-published, but with
// ledger figures (revenue / expenses / credit / balance / To Pay).
// Deploy: supabase functions deploy send-ledger-published
// Secrets: RESEND_API_KEY, EMAIL_FROM (optional)
//
// AUTH: unlike send-report-published (open to anyone holding the public anon key), this
// only accepts the service role or an ACTIVE team member's Supabase Auth token - same
// allow-rule as send-push. The admin app sends window._authToken.
//
// NOTE: keep this file plain ASCII (the Dashboard editor has mangled non-ASCII before).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { logResend } from "../_shared/email_log.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

function sbHeaders() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
}
function jwtRole(tok: string): string {
  try {
    const p = JSON.parse(atob(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return p.role || "";
  } catch {
    return "";
  }
}
async function callerAllowed(req: Request): Promise<boolean> {
  const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (auth && (auth === SERVICE_KEY || jwtRole(auth) === "service_role")) return true;
  if (!auth) return false;
  try {
    const ur = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${auth}` } });
    if (!ur.ok) return false;
    const uid = (await ur.json())?.id;
    if (!uid) return false;
    const tr = await fetch(
      `${SB_URL}/rest/v1/team_users?select=active&auth_user_id=eq.${encodeURIComponent(uid)}&limit=1`,
      { headers: sbHeaders() },
    );
    const rows = await tr.json().catch(() => []);
    return Array.isArray(rows) && rows[0]?.active === true;
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (!(await callerAllowed(req))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { headers: JSON_HEADERS, status: 403 });
  }

  try {
    const {
      to,
      ownerName,
      propName,
      month,
      revenue,
      expenses,
      credit,
      prevBalance,
      toPay,
      currency = "\u20ac",
      portalUrl,
      contactEmail = "info@rsproperties.sk",
      sigName = "Richard Sabol",
      sigTitle = "CEO",
      company = "RS Properties",
    } = await req.json();

    if (!to) {
      return new Response(JSON.stringify({ error: "Missing recipient email" }), { headers: JSON_HEADERS, status: 400 });
    }

    const monthLabel = month
      ? new Date(month + "-01").toLocaleDateString("en-GB", { month: "long", year: "numeric" })
      : "";
    const ownerFirst = (ownerName || "there").split(" ")[0];

    const esc = (s: unknown) =>
      String(s ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
      );
    const fmt = (n: unknown) => {
      const v = Number(n) || 0;
      return (v < -0.004 ? "&minus;" : "") + esc(currency) +
        Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };
    const tp = Number(toPay) || 0;
    const tpColor = tp > 0.004 ? "#b83232" : "#1a6b4a";
    const tpNote = tp > 0.004 ? "You owe RS Properties" : tp < -0.004 ? "RS Properties holds a surplus in your favour" : "Settled";
    // The carried balance is LAST month's closing To Pay: name that month, colour the sign, say what it means.
    const prevN = Number(prevBalance) || 0;
    let prevLabel = "the previous month";
    if (month && /^\d{4}-\d{2}$/.test(String(month))) {
      const [py, pmn] = String(month).split("-").map(Number);
      prevLabel = new Date(Date.UTC(py, pmn - 2, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    }
    const prevColor = prevN > 0.004 ? "#b83232" : prevN < -0.004 ? "#1a6b4a" : "#1a2e44";
    const prevNote = prevN > 0.004
      ? "Still open at the end of " + esc(prevLabel) + ": you owed RS Properties this amount."
      : prevN < -0.004
        ? "At the end of " + esc(prevLabel) + ", RS Properties was holding a surplus in your favour."
        : "Nothing was outstanding at the end of " + esc(prevLabel) + ".";
    const calcLine = fmt(prevN) + " + " + fmt(expenses) + " &minus; " + fmt(credit) + " = " + fmt(tp);
    const href = /^https?:\/\//.test(String(portalUrl || "")) ? String(portalUrl) : "https://" + String(portalUrl || "app.rsproperties.sk/owner-portal/");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light only"/>
<meta name="supported-color-schemes" content="light"/>
<style>
  body{font-family:'DM Sans',Arial,sans-serif;background:#f5f1eb;margin:0;padding:32px 16px;color:#1a2e44}
  .wrap{max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  .hdr{background:#1a2e44;padding:28px 32px 24px}
  .hdr-brand{font-family:Georgia,serif;font-size:22px;color:#c9a96e;margin-bottom:4px}
  .hdr-sub{color:rgba(255,255,255,.55);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
  .body{padding:28px 32px}
  .greeting{font-size:15px;color:#1a2e44;margin:0 0 18px;line-height:1.6}
  .intro{font-size:14px;color:#444;line-height:1.65;margin:0 0 22px}
  .rows{background:#f7f9fc;border-radius:10px;padding:4px 0;margin-bottom:24px}
  .row{display:flex;justify-content:space-between;align-items:center;padding:13px 20px;border-bottom:1px solid #eef0f3;font-size:14px}
  .row:last-child{border:none}
  .row-lbl{color:#888}
  .row-val{font-weight:700;color:#1a2e44}
  .note{font-size:11px;color:#999;text-align:right;padding:0 20px 10px}
  .how{font-size:12px;color:#666;line-height:1.65;margin:-8px 0 22px}
  .cta{display:block;text-align:center;background:#1a2e44;color:#fff;text-decoration:none;padding:13px 24px;border-radius:8px;font-size:14px;font-weight:600;margin-bottom:22px}
  .contact{font-size:12px;color:#aaa;text-align:center;margin:0}
  .contact a{color:#c9a96e;text-decoration:none}
  .footer{background:#f7f9fc;padding:16px 32px;border-top:1px solid #eee;font-size:12px;color:#aaa}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <div class="hdr-brand">${esc(company)}</div>
    <div class="hdr-sub">Accounting statement</div>
  </div>
  <div class="body">
    <p class="greeting">Hello, <strong>${esc(ownerFirst)}</strong>,</p>
    <p class="intro">
      your accounting statement for <strong>${esc(propName)}</strong>, <strong>${esc(monthLabel)}</strong>,
      is now available on the Owner Portal, together with a PDF you can download.
    </p>
    <div class="rows">
      <div class="row"><span class="row-lbl">Revenue</span><span class="row-val">${fmt(revenue)}</span></div>
      <div class="row"><span class="row-lbl">Expenses</span><span class="row-val" style="color:#b83232">${fmt(expenses)}</span></div>
      <div class="row"><span class="row-lbl">Credit received</span><span class="row-val">${fmt(credit)}</span></div>
      <div class="row"><span class="row-lbl">Balance from ${esc(prevLabel)}</span><span class="row-val" style="color:${prevColor}">${fmt(prevN)}</span></div>
      <div class="note">${prevNote}</div>
      <div class="row"><span class="row-lbl">To Pay</span><span class="row-val" style="color:${tpColor}">${fmt(tp)}</span></div>
      <div class="note">${esc(tpNote)}</div>
    </div>
    <p class="how"><strong>How to read this:</strong> a positive balance means you owe RS Properties that amount; a negative balance means RS Properties holds a surplus in your favour.
      <strong>To Pay</strong> = balance from ${esc(prevLabel)} + this month's expenses &minus; credit received:<br/>
      <strong style="color:#1a2e44">${calcLine}</strong></p>
    <a href="${esc(href)}" class="cta">View the full statement on the portal &rarr;</a>
    <p class="contact">Questions? <a href="mailto:${esc(contactEmail)}">${esc(contactEmail)}</a></p>
  </div>
  <div class="footer">
    ${esc(sigName)}${sigTitle ? " &middot; " + esc(sigTitle) : ""}, ${esc(company)}<br/>
    This email was sent automatically by RS Builder.
  </div>
</div>
</body>
</html>`;

    const fromAddr = Deno.env.get("EMAIL_FROM") || `${company} <noreply@rsproperties.sk>`;
    const toList = String(to).split(",").map((e: string) => e.trim()).filter(Boolean);
    const subject = `Your accounting statement is ready - ${propName}${monthLabel ? " \u00b7 " + monthLabel : ""}`;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromAddr, to: toList, subject, html }),
    });
    const result = await resendRes.json();
    await logResend(resendRes, result, {
      to: toList.join(", "),
      subject,
      template: "ledger-published",
      meta: { from: fromAddr },
    });

    if (!resendRes.ok) {
      console.error("Resend error:", result);
      return new Response(JSON.stringify({ error: result }), { headers: JSON_HEADERS, status: 500 });
    }
    return new Response(JSON.stringify({ ok: true, id: result.id }), { headers: JSON_HEADERS, status: 200 });
  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { headers: JSON_HEADERS, status: 500 });
  }
});
