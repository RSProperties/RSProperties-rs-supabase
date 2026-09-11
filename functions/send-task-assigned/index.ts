// RS Properties — Supabase Edge Function
// Sends task assignment notification email via Resend
// Deploy: supabase functions deploy send-task-assigned

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
      assigneeName,
      taskTitle,
      taskDesc,
      assignerName,
      dueDate,
      projectName,
      priority,
      company,
      appUrl,
    } = await req.json();

    if (!to || !taskTitle) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { headers: { ...CORS, "Content-Type": "application/json" }, status: 400 }
      );
    }

    const safeCompany = company || "RS Properties";
    const safeName = assigneeName || to;
    const safeAssigner = assignerName || "tvoj tím";
    const safeAppUrl = appUrl || "https://rsproperties.sk";

    const prioMap: Record<string, { label: string; color: string }> = {
      U: { label: "🔴 Urgent",  color: "#b83232" },
      H: { label: "🟠 High",    color: "#e67e22" },
      M: { label: "🟡 Medium",  color: "#9a6f1a" },
      L: { label: "⚪ Low",     color: "#95a5a6" },
    };
    const prio = prioMap[priority || "M"];

    const dueLine = dueDate
      ? new Date(dueDate + "T00:00:00").toLocaleDateString("sk-SK", {
          day: "2-digit",
          month: "long",
          year: "numeric",
        })
      : null;

    const html = `<!DOCTYPE html>
<html lang="sk">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Nová úloha pre teba — ${safeCompany}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#e8e4dc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;padding:32px 16px}
.wrap{max-width:520px;margin:0 auto;background:#0f1e2e;border-radius:16px;overflow:hidden}
.top-bar{padding:20px 26px;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,.07)}
.logo-sq{width:32px;height:32px;background:#c9a96e;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#0f1e2e;flex-shrink:0}
.logo-name{font-size:11px;font-weight:700;color:#fff;letter-spacing:.12em;text-transform:uppercase;line-height:1.4}
.body{padding:32px 26px}
.label{font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#c9a96e;margin-bottom:12px}
.heading{font-size:22px;font-weight:800;color:#fff;line-height:1.25;margin-bottom:8px}
.sub{font-size:13px;color:rgba(255,255,255,.5);line-height:1.6;margin-bottom:24px}
.task-card{background:#1a2e44;border-radius:10px;padding:18px 20px;margin-bottom:20px}
.task-title{font-size:15px;font-weight:700;color:#fff;margin-bottom:8px;line-height:1.4}
.task-desc{font-size:13px;color:rgba(255,255,255,.55);line-height:1.6;margin-bottom:12px}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.pill{display:inline-block;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:600}
.btn{display:block;padding:14px 22px;background:#c9a96e;color:#0f1e2e;text-align:center;text-decoration:none;border-radius:9px;font-size:14px;font-weight:800;margin-bottom:18px}
.footer{border-top:1px solid rgba(255,255,255,.07);padding:14px 26px;font-size:11px;color:rgba(255,255,255,.3);line-height:1.6}
</style>
</head>
<body>
<div class="wrap">
  <div class="top-bar">
    <div class="logo-sq">RS</div>
    <div class="logo-name">RS<br>Builder</div>
  </div>
  <div class="body">
    <div class="label">Nová úloha</div>
    <h1 class="heading">Ahoj, ${safeName}!</h1>
    <p class="sub">${safeAssigner} ti pridelil/a novú úlohu v RS Builder. Tu sú detaily:</p>

    <div class="task-card">
      <div class="task-title">${taskTitle}</div>
      ${taskDesc ? `<div class="task-desc">${taskDesc}</div>` : ""}
      <div class="meta">
        <span class="pill" style="background:${prio.color}22;color:${prio.color}">${prio.label}</span>
        ${dueLine ? `<span class="pill" style="background:rgba(255,255,255,.08);color:rgba(255,255,255,.7)">📅 Termín: ${dueLine}</span>` : ""}
        ${projectName ? `<span class="pill" style="background:rgba(201,169,110,.15);color:#c9a96e">📁 ${projectName}</span>` : ""}
      </div>
    </div>

    <a href="${safeAppUrl}" class="btn">Otvoriť RS Builder →</a>
    <p style="font-size:12px;color:rgba(255,255,255,.3);line-height:1.5">Tento email bol odoslaný automaticky, keď ti bola pridelená úloha v systéme RS Builder.</p>
  </div>
  <div class="footer">
    ${safeCompany} · RS Builder — Team Task Management
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
        subject: `Nová úloha: "${taskTitle}" — ${safeCompany}`,
        html,
      }),
    });

    const result = await resendRes.json();
    await logResend(resendRes, result, {
      to,
      subject: `Nová úloha: "${taskTitle}" — ${safeCompany}`,
      template: "task-assigned",
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
