// RS Properties - Supabase Edge Function
// Sends a push notification via OneSignal to one or more team members or
// owners, targeted by their OneSignal external_id (team members: their
// team_users.id, set client-side via OneSignal.login(); owners: their
// owner_users.id prefixed 'owner_', see the 2026-09-22 Owner Portal push
// notifications CLAUDE.md entry).
// Deploy: supabase functions deploy send-push
// Secrets: ONESIGNAL_REST_API_KEY
//
// AUTH (added 2026-09-22): this function used to have no auth check at
// all - any caller with the public anon key (which ships in the page
// source, not a secret) could push an arbitrary title/message/url to any
// external_id they could guess. All real callers are from the admin app
// (index.html) - the owner portal only ever RECEIVES pushes, it never
// calls this function itself - so the gate only ever needs to recognize
// an active team member, same allow-rule every other Edge Function here
// uses. The client (index.html's _sendPushTo) was updated in the same
// change to send window._authToken instead of the anon key alone.
//
// NOTE: keep this file plain ASCII. The Supabase Dashboard code editor has
// mangled non-ASCII bytes on save/copy-paste in this project before.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ONESIGNAL_APP_ID = "00e79d86-4f2f-4902-8c15-31e147836bd6";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  if (!(await callerAllowed(req))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { headers: JSON_HEADERS, status: 403 });
  }

  try {
    const { external_id, external_ids, title, message, url } = await req.json();

    const ids = external_ids || (external_id ? [external_id] : []);
    if (!ids.length) {
      return new Response(
        JSON.stringify({ error: "Missing external_id or external_ids" }),
        { headers: JSON_HEADERS, status: 400 }
      );
    }
    if (!message) {
      return new Response(
        JSON.stringify({ error: "Missing message" }),
        { headers: JSON_HEADERS, status: 400 }
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
        headers: JSON_HEADERS,
        status: 500,
      });
    }

    return new Response(JSON.stringify({ ok: true, result }), {
      headers: JSON_HEADERS,
      status: 200,
    });
  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      headers: JSON_HEADERS,
      status: 500,
    });
  }
});
