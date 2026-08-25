// RS Properties - Supabase Edge Function
// Returns a safe, minimal subset of one property's access instructions for
// a given share token - used by access.html (no login, external technicians).
// Deploy: supabase functions deploy get-property-access
//
// Runs server-side on purpose: the full "properties" record in the
// workspace table also holds owner contact info, management fee, contract
// terms etc. This function fetches that full record internally but only
// ever returns the handful of access-related fields below, so an
// unauthenticated visitor with a valid token can never see the rest.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SB_URL = "https://jswqdjevbncfqinntajg.supabase.co";
const SB_KEY = Deno.env.get("SUPABASE_ANON_KEY") ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impzd3FkamV2Ym5jZnFpbm50YWpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzNTUxOTYsImV4cCI6MjA5MTkzMTE5Nn0.n2SGQBgr1ZQw3g9oUIKDqOc6MaDMk8X7Q1OrQuO7228";
const SB_H = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY };

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const { token } = await req.json();
    if (!token) {
      return new Response(JSON.stringify({ error: "Missing token" }), {
        headers: { ...CORS, "Content-Type": "application/json" },
        status: 400,
      });
    }

    const tokenRes = await fetch(
      `${SB_URL}/rest/v1/property_share_tokens?token=eq.${encodeURIComponent(token)}&select=*`,
      { headers: SB_H },
    );
    const tokenRows = await tokenRes.json();
    const rec = tokenRows[0];

    if (!rec) {
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        headers: { ...CORS, "Content-Type": "application/json" },
        status: 404,
      });
    }
    if (new Date(rec.expires_at).getTime() < Date.now()) {
      return new Response(JSON.stringify({ error: "expired" }), {
        headers: { ...CORS, "Content-Type": "application/json" },
        status: 410,
      });
    }

    const propsRes = await fetch(
      `${SB_URL}/rest/v1/workspace?key=eq.properties&select=value`,
      { headers: SB_H },
    );
    const propsRows = await propsRes.json();
    const properties = propsRows[0]?.value || [];
    const p = properties.find((x: any) => x.id === rec.property_id);

    if (!p) {
      return new Response(JSON.stringify({ error: "property_not_found" }), {
        headers: { ...CORS, "Content-Type": "application/json" },
        status: 404,
      });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          name: p.name || "",
          address: p.address || "",
          keybox: p.keybox || "",
          door: p.door || "",
          wn: p.wn || "",
          wp: p.wp || "",
          loc: p.loc || "",
          park: p.park || "",
          instr: p.instr || "",
          expiresAt: rec.expires_at,
        },
      }),
      { headers: { ...CORS, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      headers: { ...CORS, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
