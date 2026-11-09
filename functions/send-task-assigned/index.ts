// RS Properties — Supabase Edge Function
// Sends task assignment notification email via Resend
// Deploy: supabase functions deploy send-task-assigned

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { logResend } from "../_shared/email_log.ts";
import { callerAllowed } from "../_shared/caller_auth.ts";
import { renderTaskEmail } from "./render.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  // AUTH (2026-10-20): this function used to accept ANY caller holding the public anon key, i.e. an
  // open relay for email from our own domain. Now: service role (e.g. owner-auth) or an ACTIVE team
  // member's token only - the admin app sends window._authToken.
  if (!(await callerAllowed(req))) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      headers: { ...CORS, "Content-Type": "application/json" },
      status: 403,
    });
  }

  try {
    const body = await req.json();
    const { to, taskTitle } = body;

    if (!to || !taskTitle) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { headers: { ...CORS, "Content-Type": "application/json" }, status: 400 }
      );
    }

    // Wording (assignment / comment / @mention / change), quoted comment and the deep link to the
    // task all come from the caller; see render.mjs. Older callers that send only the original
    // fields still get the original "new task" e-mail.
    const { html, subject } = renderTaskEmail(body);

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
        subject,
        html,
      }),
    });

    const result = await resendRes.json();
    await logResend(resendRes, result, {
      to,
      subject,
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
