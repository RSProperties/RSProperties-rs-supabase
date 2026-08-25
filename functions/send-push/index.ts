// RS Properties - Supabase Edge Function
// Sends a push notification via OneSignal to one or more team members,
// targeted by their team_users.id (set client-side via OneSignal.login()).
// Deploy: supabase functions deploy send-push
// Secrets: ONESIGNAL_REST_API_KEY
//
// NOTE: keep this file plain ASCII. The Supabase Dashboard code editor has
// mangled non-ASCII bytes on save/copy-paste in this project before.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ONESIGNAL_APP_ID = "00e79d86-4f2f-4902-8c15-31e147836bd6";

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
    const { external_id, external_ids, title, message, url } = await req.json();

    const ids = external_ids || (external_id ? [external_id] : []);
    if (!ids.length) {
      return new Response(
        JSON.stringify({ error: "Missing external_id or external_ids" }),
        { headers: { ...CORS, "Content-Type": "application/json" }, status: 400 }
      );
    }
    if (!message) {
      return new Response(
        JSON.stringify({ error: "Missing message" }),
        { headers: { ...CORS, "Content-Type": "application/json" }, status: 400 }
      );
    }

    const body: Record<string, unknown> = {
      app_id: ONESIGNAL_APP_ID,
      include_aliases: { external_id: ids.map(String) },
      target_channel: "push",
      contents: { en: message },
      headings: { en: title || "RS Properties" },
    };
    if (url) body.url = url;

    const osRes = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${Deno.env.get("ONESIGNAL_REST_API_KEY")}`,
      },
      body: JSON.stringify(body),
    });

    const result = await osRes.json();

    if (!osRes.ok) {
      console.error("OneSignal error:", result);
      return new Response(JSON.stringify({ error: result }), {
        headers: { ...CORS, "Content-Type": "application/json" },
        status: 500,
      });
    }

    return new Response(JSON.stringify({ ok: true, result }), {
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
