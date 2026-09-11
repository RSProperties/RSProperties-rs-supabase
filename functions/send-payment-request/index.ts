// RS Properties — Supabase Edge Function
// Sends automated Payment Request email via Resend
// Deploy: supabase functions deploy send-payment-request
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
      fixAmount,
      actualNP,
      owes,
      refNo,
      dueDate,
      subject: customSubject,
      bodyText,
    } = await req.json();

    if (!to) {
      return new Response(
        JSON.stringify({ error: "Missing recipient email" }),
        { headers: { ...CORS, "Content-Type": "application/json" }, status: 400 }
      );
    }

    const monthLabel = new Date(month + "-01").toLocaleDateString("sk-SK", {
      month: "long",
      year: "numeric",
    });

    // Manual send from the Settlements "📧 Poslať email" modal: the admin
    // may have edited the subject/body text there before sending, and
    // whatever they saw in that preview is what must actually go out - so a
    // custom subject+bodyText pair takes over the whole email instead of
    // silently falling back to the canonical template underneath it.
    if (customSubject && bodyText) {
      const escapeHtml = (s: string) =>
        String(s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      const customHtml = `<!DOCTYPE html>
<html lang="sk"><head><meta charset="UTF-8"/><meta name="color-scheme" content="light only"/><meta name="supported-color-schemes" content="light"/></head>
<body style="font-family:'DM Sans',Arial,sans-serif;background:#f5f1eb;margin:0;padding:32px 16px;color:#1a2e44">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
  <div style="background:#1a2e44;padding:22px 28px;color:#fff;font-size:16px;font-weight:700">RS Properties s.r.o.</div>
  <div style="padding:28px 32px;font-size:14px;line-height:1.7;white-space:pre-wrap">${escapeHtml(bodyText)}</div>
  <div style="border-top:1px solid #f0ece6;padding:16px 32px;text-align:center;font-size:11px;color:#a0aec0;background:#faf9f7">RS Properties s.r.o. · Správa krátkodobých prenájmov</div>
</div>
</body></html>`;

      const fromAddr =
        Deno.env.get("EMAIL_FROM") || "RS Properties <noreply@rsproperties.sk>";
      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromAddr,
          to: [to],
          subject: customSubject,
          html: customHtml,
        }),
      });
      const customResult = await resendRes.json();
      await logResend(resendRes, customResult, {
        to,
        subject: customSubject,
        template: "payment-request",
        meta: { from: fromAddr },
      });
      if (!resendRes.ok) {
        console.error("Resend error:", customResult);
        return new Response(JSON.stringify({ error: customResult }), {
          headers: { ...CORS, "Content-Type": "application/json" },
          status: 500,
        });
      }
      return new Response(JSON.stringify({ ok: true, id: customResult.id }), {
        headers: { ...CORS, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const html = `<!DOCTYPE html>
<html lang="sk">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light only"/>
<meta name="supported-color-schemes" content="light"/>
<style>
  body{font-family:'DM Sans',Arial,sans-serif;background:#f5f1eb;margin:0;padding:32px 16px;color:#1a2e44}
  .wrap{max-width:600px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  .hdr{background:#1a2e44;padding:28px 32px;display:flex;justify-content:space-between;align-items:flex-start}
  .hdr-brand{color:#fff;font-size:20px;font-weight:700;letter-spacing:-.3px}
  .hdr-sub{color:rgba(255,255,255,.55);font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-top:2px}
  .hdr-title{text-align:right}
  .hdr-doctype{color:#c9a96e;font-size:22px;font-weight:700;letter-spacing:-.5px}
  .hdr-ref{color:rgba(255,255,255,.5);font-size:11px;margin-top:3px}
  .body{padding:28px 32px}
  .greeting{font-size:15px;margin-bottom:20px;line-height:1.6;color:#2d3748}
  .info-row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #eee;font-size:13px}
  .info-row:last-child{border:none}
  .info-key{color:#718096}
  .info-val{font-weight:600;color:#1a2e44}
  .amount-box{background:#1a2e44;border-radius:10px;padding:20px 24px;margin:20px 0;display:flex;justify-content:space-between;align-items:center}
  .amount-label{color:rgba(255,255,255,.65);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
  .amount-val{color:#c9a96e;font-size:26px;font-weight:700}
  .pay-box{background:#f5f1eb;border-radius:10px;padding:18px 22px;margin-bottom:20px}
  .pay-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#718096;margin-bottom:10px}
  .pay-row{display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid #e2ddd6}
  .pay-row:last-child{border:none}
  .pay-key{color:#718096}
  .pay-val{font-weight:600;color:#1a2e44}
  .note{font-size:12px;color:#718096;line-height:1.6;margin-top:16px}
  .footer{border-top:1px solid #f0ece6;padding:16px 32px;text-align:center;font-size:11px;color:#a0aec0;background:#faf9f7}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <div>
      <div class="hdr-brand">RS Properties s.r.o.</div>
      <div class="hdr-sub">Property Management</div>
    </div>
    <div class="hdr-title">
      <div class="hdr-doctype">PAYMENT REQUEST</div>
      <div class="hdr-ref">Ref: ${refNo}</div>
      <div class="hdr-ref">Splatnosť: ${dueDate}</div>
    </div>
  </div>

  <div class="body">
    <div class="greeting">
      Dobrý deň, <strong>${ownerName || "vlastník"}</strong>,<br/>
      zasielame Vám výzvu na úhradu za mesiac <strong>${monthLabel}</strong>
      pre nehnuteľnosť <strong>${propName}</strong>.
    </div>

    <div style="margin-bottom:16px">
      <div class="info-row">
        <span class="info-key">Skutočný čistý zisk (NP)</span>
        <span class="info-val">€${Number(actualNP).toFixed(2)}</span>
      </div>
      <div class="info-row">
        <span class="info-key">Garantovaná fix suma</span>
        <span class="info-val">€${Number(fixAmount).toFixed(2)}</span>
      </div>
    </div>

    <div class="amount-box">
      <div>
        <div class="amount-label">Suma k úhrade</div>
        <div style="color:rgba(255,255,255,.5);font-size:11px;margin-top:3px">
          Skutočný výnos bol nižší ako garantovaná fix suma.
        </div>
      </div>
      <div class="amount-val">€${Number(owes).toFixed(2)}</div>
    </div>

    <div class="pay-box">
      <div class="pay-title">💳 Platobné údaje</div>
      <div class="pay-row"><span class="pay-key">Príjemca</span><span class="pay-val">RS Properties s.r.o.</span></div>
      <div class="pay-row"><span class="pay-key">IBAN</span><span class="pay-val">SK41 1100 0000 0029 4717 3464</span></div>
      <div class="pay-row"><span class="pay-key">Banka</span><span class="pay-val">Tatra banka, a.s.</span></div>
      <div class="pay-row"><span class="pay-key">Variabilný symbol</span><span class="pay-val">${refNo}</span></div>
      <div class="pay-row"><span class="pay-key">Splatnosť</span><span class="pay-val">${dueDate}</span></div>
    </div>

    <div class="note">
      V prípade otázok nás kontaktujte na <a href="mailto:info@rsproperties.sk" style="color:#c9a96e">info@rsproperties.sk</a>.<br/>
      Ďakujeme za spoluprácu.
    </div>
  </div>

  <div class="footer">
    RS Properties s.r.o. · Správa krátkodobých prenájmov<br/>
    Tento email bol odoslaný automaticky systémom RS Builder.
  </div>
</div>
</body>
</html>`;

    const fromAddr =
      Deno.env.get("EMAIL_FROM") || "RS Properties <noreply@rsproperties.sk>";

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddr,
        to: [to],
        subject: `Payment Request – ${propName} – ${monthLabel} [${refNo}]`,
        html,
      }),
    });

    const result = await resendRes.json();
    await logResend(resendRes, result, {
      to,
      subject: `Payment Request – ${propName} – ${monthLabel} [${refNo}]`,
      template: "payment-request",
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
