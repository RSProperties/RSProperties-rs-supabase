// RS Properties — one-off migration Edge Function (2026-09-09)
// Moves existing property "Access" tab files (door codes, keybox codes,
// wifi note photos) out of the fully-public `attachments` bucket into the
// new private `property-access` bucket — see
// sql_migrations/2026-09-09_property_access_private_bucket.sql for why.
// Run once via: curl -X POST .../functions/v1/migrate-property-access
// Safe to re-run: skips any file that already has a `path` (already
// migrated) instead of a legacy `url`.
// Deploy: supabase functions deploy migrate-property-access

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SB_URL = "https://jswqdjevbncfqinntajg.supabase.co";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SB_H = { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY };
const OLD_BUCKET = "attachments";
const NEW_BUCKET = "property-access";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { ...CORS, "Content-Type": "application/json" },
    status,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const wsRes = await fetch(`${SB_URL}/rest/v1/workspace?key=eq.propTabFiles&select=value`, {
      headers: SB_H,
    });
    const wsRows = await wsRes.json();
    const propTabFiles = wsRows[0]?.value || {};

    let migrated = 0, skipped = 0, failed: string[] = [];

    for (const propId of Object.keys(propTabFiles)) {
      const tabs = propTabFiles[propId];
      const access = tabs && Array.isArray(tabs.access) ? tabs.access : null;
      if (!access) continue;

      for (let i = 0; i < access.length; i++) {
        const f = access[i];
        if (f.path) { skipped++; continue; } // already migrated
        if (!f.url) continue;

        // Old url shape: {SB_URL}/storage/v1/object/public/attachments/{path}
        const marker = `/storage/v1/object/public/${OLD_BUCKET}/`;
        const idx = f.url.indexOf(marker);
        if (idx === -1) { failed.push(`${propId}:${f.name} (unrecognized url)`); continue; }
        const relPath = f.url.slice(idx + marker.length);

        try {
          const fileRes = await fetch(f.url);
          if (!fileRes.ok) { failed.push(`${propId}:${f.name} (download ${fileRes.status})`); continue; }
          const bytes = await fileRes.arrayBuffer();

          const uploadRes = await fetch(`${SB_URL}/storage/v1/object/${NEW_BUCKET}/${relPath}`, {
            method: "POST",
            headers: {
              ...SB_H,
              "Content-Type": f.type || "application/octet-stream",
              "x-upsert": "true",
            },
            body: bytes,
          });
          if (!uploadRes.ok) {
            failed.push(`${propId}:${f.name} (upload ${uploadRes.status})`);
            continue;
          }

          // Delete original from the public bucket now that the copy exists.
          await fetch(`${SB_URL}/storage/v1/object/${OLD_BUCKET}/${relPath}`, {
            method: "DELETE",
            headers: SB_H,
          }).catch(() => {});

          delete f.url;
          f.path = relPath;
          migrated++;
        } catch (e) {
          failed.push(`${propId}:${f.name} (${String(e)})`);
        }
      }
    }

    if (migrated > 0) {
      const saveRes = await fetch(`${SB_URL}/rest/v1/workspace`, {
        method: "POST",
        headers: { ...SB_H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key: "propTabFiles", value: propTabFiles }),
      });
      if (!saveRes.ok) {
        return json({ error: "save_failed", detail: await saveRes.text(), migrated, skipped, failed }, 500);
      }
    }

    // Optional cleanup pass: delete specific properties/*/access/* paths in
    // the old public bucket that the caller has confirmed are orphaned
    // (found via a direct storage.objects query - not exposed over REST,
    // so this can't discover them itself). Never deletes anything still
    // referenced by a current propTabFiles.access entry, as a safety net.
    const body = await req.clone().json().catch(() => ({}));
    const knownOrphans: string[] = Array.isArray(body.knownOrphans) ? body.knownOrphans : [];
    const referenced = new Set<string>();
    for (const propId of Object.keys(propTabFiles)) {
      const acc = propTabFiles[propId]?.access;
      if (Array.isArray(acc)) for (const f of acc) if (f.path) referenced.add(f.path);
    }
    const orphansDeleted: string[] = [];
    for (const p of knownOrphans) {
      if (referenced.has(p)) continue;
      const delRes = await fetch(`${SB_URL}/storage/v1/object/${OLD_BUCKET}/${p}`, {
        method: "DELETE",
        headers: SB_H,
      });
      if (delRes.ok) orphansDeleted.push(p);
    }

    return json({ ok: true, migrated, alreadyMigrated: skipped, failed, orphansDeleted });
  } catch (err) {
    console.error("migrate-property-access error:", err);
    return json({ error: String(err) }, 500);
  }
});
