// RS Properties — one-off migration helper (2026-09-08)
// Overwrites an existing object in the 'attachments' Storage bucket with
// pre-recompressed bytes at the SAME path (so every existing reference/URL
// keeps working). Anon key can INSERT new objects in this bucket but not
// overwrite existing ones (no anon UPDATE policy on storage.objects) - this
// runs with the service role, which bypasses that, purely for this
// one-time cleanup script driven from recompress_storage.py.
// Deploy: supabase functions deploy storage-recompress

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "attachments";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { headers: { ...CORS, "Content-Type": "application/json" }, status });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const path = String(body.path || "");
    const contentType = String(body.contentType || "application/octet-stream");
    const dataB64 = String(body.dataB64 || "");
    if (!path || !dataB64) return json({ error: "missing_fields" }, 400);

    const bytes = Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0));

    const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": contentType,
        "x-upsert": "true",
      },
      body: bytes,
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return json({ error: "upload_failed", detail: t.slice(0, 300) }, 500);
    }
    return json({ ok: true });
  } catch (err) {
    console.error("storage-recompress error:", err);
    return json({ error: "server_error" }, 500);
  }
});
