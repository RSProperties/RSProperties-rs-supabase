// RS Properties - Supabase Edge Function
// Sends automated Owner Portal welcome / password-setup email via Resend
// Deploy: supabase functions deploy send-welcome-email
// Secrets: RESEND_API_KEY, EMAIL_FROM (optional)
//
// NOTE: every character in this file is kept plain ASCII on purpose. The
// Supabase Dashboard code editor has previously mangled non-ASCII bytes
// (smart dashes, arrows, emoji) on save/copy-paste, which both breaks the
// rendered email AND is a strong spam signal for mail filters. Do not
// reintroduce em-dashes, arrows, or emoji here - use "-", "->", plain words.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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
      company,
      portalUrl,
      username,
      password,
      setupLink,
      expiresHours,
      compEmail,
      compWeb,
    } = await req.json();

    if (!to) {
      return new Response(
        JSON.stringify({ error: "Missing recipient email" }),
        { headers: { ...CORS, "Content-Type": "application/json" }, status: 400 }
      );
    }

    const safeCompany = company || "RS Properties";
    const safePortalUrl = portalUrl || "rsproperties.sk";
    const portalHref = /^https?:\/\//.test(safePortalUrl)
      ? safePortalUrl
      : `https://${safePortalUrl}`;
    const safeWeb = (compWeb || safePortalUrl).replace(/^https?:\/\//, "");
    const safeUser = username || "-";
    const safeEmail = compEmail || "info@rsproperties.sk";
    const safeName = ownerName || "";
    const safeHours = expiresHours || 48;

    const isSetup = !!setupLink;

    const subject = isSetup
      ? `Create your Owner Portal password - ${safeCompany}`
      : `Your Owner Portal is now live - ${safeCompany}`;

    const sharedHead = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${subject}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#e8e4dc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;padding:32px 16px}
.wrap{max-width:560px;margin:0 auto;background:#0f1e2e;border-radius:16px;overflow:hidden}
.top-bar{padding:24px 32px;display:flex;align-items:center;justify-content:space-between}
.logo-box{display:flex;align-items:center;gap:10px}
.logo-sq{width:34px;height:34px;background:#c9a96e;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#0f1e2e;letter-spacing:.5px;flex-shrink:0}
.logo-name{font-size:11px;font-weight:700;color:#fff;letter-spacing:.12em;text-transform:uppercase;line-height:1.4}
.hero{padding:40px 32px 36px;position:relative;overflow:hidden}
.intro-label{font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#c9a96e;margin-bottom:14px}
.hero-h1{font-size:34px;font-weight:800;color:#fff;line-height:1.15;margin-bottom:14px}
.hero-h1 em{color:#c9a96e;font-style:italic}
.hero-sub{font-size:13.5px;color:rgba(255,255,255,.55);line-height:1.6;max-width:400px}
.divider{height:1px;background:rgba(255,255,255,.07);margin:0 32px}
.section{padding:32px 32px}
.sec-label{font-size:10px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:rgba(255,255,255,.35);margin-bottom:20px}
.body-text{font-size:14px;color:rgba(255,255,255,.65);line-height:1.75}
.feat-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.feat-card{background:#1a2e44;border-radius:10px;padding:18px 16px}
.feat-icon{width:32px;height:32px;background:rgba(201,169,110,.12);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:#c9a96e;margin-bottom:12px}
.feat-title{font-size:13px;font-weight:700;color:#fff;margin-bottom:5px}
.feat-desc{font-size:12px;color:rgba(255,255,255,.45);line-height:1.55}
.steps{display:flex;flex-direction:column;gap:16px}
.step{display:flex;align-items:flex-start;gap:14px}
.step-num{width:26px;height:26px;border-radius:50%;background:#c9a96e;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#0f1e2e;flex-shrink:0;margin-top:1px}
.step-body h4{font-size:13.5px;font-weight:700;color:#fff;margin-bottom:3px}
.step-body p{font-size:12px;color:rgba(255,255,255,.45);line-height:1.5}
.cred-box{background:#1a2e44;border-radius:12px;padding:24px}
.cred-label{font-size:9.5px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:#c9a96e;margin-bottom:16px}
.cred-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)}
.cred-row:last-child{border-bottom:none}
.cred-key{font-size:12px;color:rgba(255,255,255,.4)}
.cred-val{font-size:12px;font-family:monospace;color:#c9a96e;text-align:right;font-weight:600}
.cta-wrap{padding:0 32px 28px}
.cta-btn{display:block;width:100%;padding:17px;background:#c9a96e;color:#0f1e2e;text-align:center;text-decoration:none;border-radius:10px;font-size:15px;font-weight:800;letter-spacing:.02em}
.expiry-note{margin-top:14px;text-align:center;font-size:11.5px;color:rgba(255,255,255,.35)}
.security-badge{display:inline-flex;align-items:center;gap:8px;background:rgba(201,169,110,.1);border:1px solid rgba(201,169,110,.25);border-radius:99px;padding:8px 16px;font-size:11px;color:#c9a96e;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:18px}
.privacy{padding:16px 32px 28px;display:flex;align-items:flex-start;gap:10px}
.privacy-icon{width:16px;height:16px;border-radius:50%;border:1px solid rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;font-size:9px;color:rgba(255,255,255,.3)}
.privacy p{font-size:11.5px;color:rgba(255,255,255,.3);line-height:1.55}
.privacy a{color:#c9a96e;text-decoration:none}
.footer{padding:20px 32px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid rgba(255,255,255,.07)}
.foot-logo{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:rgba(255,255,255,.5)}
.foot-links{display:flex;gap:20px}
.foot-links a{font-size:11.5px;color:rgba(255,255,255,.35);text-decoration:none}
.note{text-align:center;padding:16px;font-size:11px;color:#aaa}
@media(max-width:420px){.feat-grid{grid-template-columns:1fr}.hero-h1{font-size:26px}.cred-val{font-size:11px}}
</style></head><body>
<div class="wrap">
  <div class="top-bar">
    <div class="logo-box">
      <div class="logo-sq">RS</div>
      <div class="logo-name">RS<br>Properties</div>
    </div>
  </div>`;

    const sharedFooter = `
  <div class="privacy">
    <div class="privacy-icon">i</div>
    <p>This link is personal to you - please don't forward it. Questions? Contact us at <a href="mailto:${safeEmail}">${safeEmail}</a></p>
  </div>

  <div class="footer">
    <div class="foot-logo"><div class="logo-sq" style="width:22px;height:22px;font-size:9px">RS</div> ${safeCompany}</div>
    <div class="foot-links">
      <a href="mailto:${safeEmail}">${safeEmail}</a>
      <a href="${portalHref}">${safeWeb}</a>
    </div>
  </div>
</div>
<div class="note">Best viewed in Chrome or Safari - works on mobile &amp; desktop</div>
</body></html>`;

    // --- Password-setup email (owner creates their own password) ---
    const setupHtml = `${sharedHead}
  <div class="hero">
    <div class="security-badge">Owner Portal</div>
    <div class="intro-label">Getting started</div>
    <h1 class="hero-h1">Create your <em>portal password</em></h1>
    <p class="hero-sub">${safeName ? `Hi ${safeName}, you` : "You"} can now set your own password for the Owner Portal - it takes less than a minute, and only you will know it.</p>
  </div>

  <div class="divider"></div>

  <div class="section">
    <div class="sec-label">How it works</div>
    <div class="steps">
      <div class="step"><div class="step-num">1</div><div class="step-body"><h4>Click the button below</h4><p>It opens a one-time page just for your account.</p></div></div>
      <div class="step"><div class="step-num">2</div><div class="step-body"><h4>Choose a password</h4><p>Pick something only you know - we never see or store it in plain text.</p></div></div>
      <div class="step"><div class="step-num">3</div><div class="step-body"><h4>Log in at ${safeWeb}</h4><p>Use your username <strong style="color:#c9a96e">${safeUser}</strong> together with your new password.</p></div></div>
    </div>
  </div>

  <div class="divider"></div>

  <div class="cta-wrap" style="padding-top:28px">
    <a href="${setupLink}" class="cta-btn">Create My Password</a>
    <p class="expiry-note">This link is valid for ${safeHours} hours and can only be used once.</p>
  </div>
${sharedFooter}`;

    const setupText = `${safeName ? `Hi ${safeName},` : "Hi,"}

You can now set your own password for the Owner Portal - it takes less than a minute.

Create your password here (valid for ${safeHours} hours, single use):
${setupLink}

Once done, log in at ${safeWeb} with:
Username: ${safeUser}

Questions? Contact us at ${safeEmail}

- ${safeCompany}`;

    // --- Legacy welcome email (plaintext credentials - kept only for
    // backward compatibility with older manual sends; new flow always
    // uses setupLink above) ---
    const safePass = password || "-";
    const welcomeHtml = `${sharedHead}
  <div class="hero">
    <div class="intro-label">Introducing</div>
    <h1 class="hero-h1">Your <em>Owner Portal</em><br>is now live.</h1>
    <p class="hero-sub">A private, always-on window into your property's performance - built exclusively for you.</p>
  </div>

  <div class="divider"></div>

  <div class="section">
    <p class="body-text">We believe that transparency is the foundation of great partnership. That's why we built the ${safeCompany} Owner Portal - so you can access every report, reservation, and document tied to your property, any time, from any device. No waiting on emails. No chasing numbers. Everything in one place, always current.</p>
  </div>

  <div class="divider"></div>

  <div class="section">
    <div class="sec-label">What's inside</div>
    <div class="feat-grid">
      <div class="feat-card"><div class="feat-icon">$</div><div class="feat-title">Monthly statements</div><div class="feat-desc">Full financial breakdown - revenue, deductions, and net profit, line by line.</div></div>
      <div class="feat-card"><div class="feat-icon">#</div><div class="feat-title">Reservation overview</div><div class="feat-desc">All stays at a glance - guest names, dates, platforms, and per-booking earnings.</div></div>
      <div class="feat-card"><div class="feat-icon">+</div><div class="feat-title">Documents &amp; attachments</div><div class="feat-desc">Invoices and contracts attached directly to each monthly report - download any time.</div></div>
      <div class="feat-card"><div class="feat-icon">%</div><div class="feat-title">Private &amp; secure access</div><div class="feat-desc">Your own credentials. You see only your properties - nothing else.</div></div>
    </div>
  </div>

  <div class="divider"></div>

  <div class="section">
    <div class="sec-label">How to get in - 4 steps</div>
    <div class="steps">
      <div class="step"><div class="step-num">1</div><div class="step-body"><h4>Open ${safeWeb} in your browser</h4><p>Works on desktop and mobile - Chrome or Safari recommended.</p></div></div>
      <div class="step"><div class="step-num">2</div><div class="step-body"><h4>Click "Owner Login" in the navigation</h4><p>You'll find it in the top menu bar.</p></div></div>
      <div class="step"><div class="step-num">3</div><div class="step-body"><h4>Enter your username and password</h4><p>Your credentials are listed below - keep them private.</p></div></div>
      <div class="step"><div class="step-num">4</div><div class="step-body"><h4>Select a month and property</h4><p>Browse your statements, download PDFs, and open attached documents.</p></div></div>
    </div>
  </div>

  <div class="divider"></div>

  <div class="section">
    <div class="sec-label">Your login credentials</div>
    <div class="cred-box">
      <div class="cred-label">Access details</div>
      <div class="cred-row"><span class="cred-key">Website</span><span class="cred-val">${safeWeb}</span></div>
      <div class="cred-row"><span class="cred-key">Username</span><span class="cred-val">${safeUser}</span></div>
      <div class="cred-row"><span class="cred-key">Password</span><span class="cred-val">${safePass}</span></div>
    </div>
  </div>

  <div class="cta-wrap">
    <a href="${portalHref}" class="cta-btn">Open Owner Portal</a>
  </div>
${sharedFooter}`;

    const welcomeText = `Your Owner Portal is now live.

Website: ${safeWeb}
Username: ${safeUser}
Password: ${safePass}

Open: ${portalHref}

Questions? Contact us at ${safeEmail}

- ${safeCompany}`;

    const html = isSetup ? setupHtml : welcomeHtml;
    const text = isSetup ? setupText : welcomeText;

    const fromAddr =
      Deno.env.get("EMAIL_FROM") || "RS Properties <noreply@rsproperties.sk>";

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
        subject,
        html,
        text,
      }),
    });

    const result = await resendRes.json();

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
