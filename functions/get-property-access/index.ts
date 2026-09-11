// RS Properties - Supabase Edge Function
// Two jobs, both around property_share_tokens (locked down 2026-09-07 —
// the anon key can no longer read or write that table at all):
//   1. action=create - admin app mints a new share token for a property
//      (used by puShareAccess() in index.html).
//   2. default/action=get - access.html resolves a token into the safe,
//      minimal subset of that property's access instructions.
//
// Both run server-side with the SERVICE ROLE key on purpose:
//  - property_share_tokens rows ARE valid credentials (a matching token
//    grants access), so anon must never be able to list or forge them.
//  - The full "properties" record in the workspace table also holds
//    owner contact info, management fee, contract terms etc. - action=get
//    fetches that full record internally but only ever returns the
//    handful of access-related fields below.
// Deploy: supabase functions deploy get-property-access

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SB_URL = "https://jswqdjevbncfqinntajg.supabase.co";
// Service role - required now that property_share_tokens has zero anon
// grants. Supabase injects this automatically for every Edge Function.
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SB_H = { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { ...CORS, "Content-Type": "application/json" },
    status,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const payload = await req.json();
    const action = payload.action || "get";

    if (action === "create") {
      const { propertyId, propertyName } = payload;
      if (!propertyId) return json({ error: "missing_property_id" }, 400);

      const tokenBytes = new Uint8Array(24);
      crypto.getRandomValues(tokenBytes);
      const token = Array.from(tokenBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const expiresAt = new Date(Date.now() + 72 * 3600000).toISOString();

      const insertRes = await fetch(`${SB_URL}/rest/v1/property_share_tokens`, {
        method: "POST",
        headers: {
          ...SB_H,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          token,
          property_id: propertyId,
          property_name: propertyName || "",
          expires_at: expiresAt,
        }),
      });
      if (!insertRes.ok) {
        const t = await insertRes.text();
        return json({ error: "insert_failed", detail: t.slice(0, 200) }, 500);
      }
      return json({ ok: true, token, expiresAt });
    }

    // action === "get" (default) - resolve a token, used by access.html
    const { token } = payload;
    if (!token) return json({ error: "Missing token" }, 400);

    const tokenRes = await fetch(
      `${SB_URL}/rest/v1/property_share_tokens?token=eq.${encodeURIComponent(token)}&select=*`,
      { headers: SB_H },
    );
    const tokenRows = await tokenRes.json();
    const rec = tokenRows[0];

    if (!rec) return json({ error: "invalid_token" }, 404);
    if (new Date(rec.expires_at).getTime() < Date.now()) {
      return json({ error: "expired" }, 410);
    }

    const propsRes = await fetch(
      `${SB_URL}/rest/v1/workspace?key=eq.properties&select=value`,
      { headers: SB_H },
    );
    const propsRows = await propsRes.json();
    const properties = propsRows[0]?.value || [];
    const p = properties.find((x: any) => x.id === rec.property_id);

    if (!p) return json({ error: "property_not_found" }, 404);

    return json({
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
    });
  } catch (err) {
    console.error("Edge function error:", err);
    return json({ error: String(err) }, 500);
  }
});
