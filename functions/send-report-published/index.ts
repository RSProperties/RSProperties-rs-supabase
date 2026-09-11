// RS Properties — Supabase Edge Function
// Sends automated Report Published notification via Resend
// Deploy: supabase functions deploy send-report-published
// Secrets: RESEND_API_KEY, EMAIL_FROM (optional)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { logResend } from "../_shared/email_log.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const {
      to,
      ownerName,
      propName,
      month,
      income,
      netProfit,
      bookings,
      cleaning,
      mgmtFee,
      cityTax,
      otherExpenses = [],
      otherIncome = [],
      currency = "€",
      portalUrl,
      contactEmail = "info@rsproperties.sk",
      sigName = "Richard Sabol",
      sigTitle = "CEO",
      company = "RS Properties",
    } = await req.json();

    if (!to) {
      return new Response(
        JSON.stringify({ error: "Missing recipient email" }),
        { headers: { ...CORS, "Content-Type": "application/json" }, status: 400 }
      );
    }

    const monthLabel = month
      ? new Date(month + "-01").toLocaleDateString("en-GB", {
          month: "long",
          year: "numeric",
        })
      : "";

    const ownerFirst = (ownerName || "there").split(" ")[0];
    const npColor = Number(netProfit) >= 0 ? "#1a6b4a" : "#c0392b";

    const fmt = (n: number) =>
      currency +
      Number(n).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

    const esc = (s: unknown) =>
      String(s ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
      );

    // Other income rows go right after Income (they add to what the owner
    // earned); other expense rows join Cleaning/Mgmt/CityTax as deductions.
    // Both were previously missing from this summary entirely, which is
    // exactly what made Income - Cleaning - Mgmt - CityTax not match the
    // Net Profit shown below it with no way to see why.
    const otherIncomeRows = (Array.isArray(otherIncome) ? otherIncome : [])
      .filter((it: any) => Number(it?.amount) > 0)
      .map(
        (it: any) => `
      <div class="row">
        <span class="row-lbl">${esc(it.label)}</span>
        <span class="row-val" style="color:#1a6b4a">+${fmt(it.amount)}</span>
      </div>`
      )
      .join("");

    const detailRows = [
      { label: "Cleaning", val: cleaning },
      { label: "Management fee", val: mgmtFee },
      { label: "City tax", val: cityTax },
    ]
      .filter((d) => Number(d.val) > 0)
      .map(
        (d) => `
      <div class="row">
        <span class="row-lbl">${d.label}</span>
        <span class="row-val" style="color:#b83232">&minus;${fmt(d.val)}</span>
      </div>`
      )
      .join("") +
      (Array.isArray(otherExpenses) ? otherExpenses : [])
        .filter((it: any) => Number(it?.amount) > 0)
        .map(
          (it: any) => `
      <div class="row">
        <span class="row-lbl">${esc(it.label)}</span>
        <span class="row-val" style="color:#b83232">&minus;${fmt(it.amount)}</span>
      </div>`
        )
        .join("");

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
  .cta{display:block;text-align:center;background:#1a2e44;color:#fff;text-decoration:none;padding:13px 24px;border-radius:8px;font-size:14px;font-weight:600;margin-bottom:22px}
  .contact{font-size:12px;color:#aaa;text-align:center;margin:0}
  .contact a{color:#c9a96e;text-decoration:none}
  .footer{background:#f7f9fc;padding:16px 32px;border-top:1px solid #eee;font-size:12px;color:#aaa}
</style>
</head>
<body>
<div class="wrap">

  <div class="hdr">
    <div class="hdr-brand">${company}</div>
    <div class="hdr-sub">Owner Report</div>
  </div>

  <div class="body">
    <p class="greeting">Hello, <strong>${ownerFirst}</strong>,</p>
    <p class="intro">
      your monthly report for <strong>${propName}</strong>, <strong>${monthLabel}</strong>,
      is now available on the Owner Portal.
    </p>

    <div class="rows">
      <div class="row">
        <span class="row-lbl">Income</span>
        <span class="row-val">${fmt(income)}</span>
      </div>
      ${otherIncomeRows}
      ${detailRows}
      <div class="row">
        <span class="row-lbl">Net Profit</span>
        <span class="row-val" style="color:${npColor}">${fmt(netProfit)}</span>
      </div>
      <div class="row">
        <span class="row-lbl">Bookings</span>
        <span class="row-val">${bookings}</span>
      </div>
    </div>

    <a href="${portalUrl}" class="cta">View full report on the portal →</a>

    <p class="contact">
      Questions? <a href="mailto:${contactEmail}">${contactEmail}</a>
    </p>
  </div>

  <div class="footer">
    ${sigName}${sigTitle ? " · " + sigTitle : ""}, ${company}<br/>
    This email was sent automatically by RS Builder.
  </div>

</div>
</body>
</html>`;

    const fromAddr =
      Deno.env.get("EMAIL_FROM") || `${company} <noreply@rsproperties.sk>`;

    const toList = String(to).split(",").map((e: string) => e.trim()).filter(Boolean);

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddr,
        to: toList,
        subject: `Your monthly report is ready — ${propName}${monthLabel ? " · " + monthLabel : ""}`,
        html,
      }),
    });

    const result = await resendRes.json();
    await logResend(resendRes, result, {
      to: Array.isArray(toList) ? toList.join(", ") : String(toList),
      subject: `Your monthly report is ready — ${propName}${monthLabel ? " · " + monthLabel : ""}`,
      template: "report-published",
      meta: { from: fromAddr },
    });

    if (!resendRes.ok) {
      console.error("Resend error:", result);
      return new Response(JSON.stringify({ error: result }), {
        headers: { ...CORS, "Content-Type": "application/json" },
        status: 500,
      });
    }

    return new Response(JSON.stringify({ ok: true, id: result.id }), {
      headers: { ...CORS, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      headers: { ...CORS, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
