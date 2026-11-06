// RS Properties / Keystone - Supabase Edge Function (PUBLIC, no login)
// Lets cleaners without a Keystone account report what is missing in an apartment (public page /doplnit/).
// The public page has no database access: everything goes through here, guarded by a secret key (?z=...) that
// the admin creates and can rotate (table supply_public_tokens). The service role never leaves this function.
//
// POST { action, t, ... }   (t = public key; not needed for "notify", which needs a team member's login)
//   catalog { t, prop_id? } -> { ok, tiles, props, locations, prop?, open:[...] }
//   Target of a request (prop_id): a warehouse location 'wh:presov' | 'wh:bratislava' | 'wh:poprad' | 'wh:trnava' (the normal case)
//   or an apartment id (only for something specific to that apartment).
//   submit  { t, prop_id, who, note?, urgent?, photo?(data:image/jpeg;base64), items:[{catalog_id?, name, qty}] }
//           -> { ok, n } | { ok:false, error:'duplicate', open:[...] }.  Sends an e-mail to the buyer (SUPPLY_NOTIFY_TO).
//   more    { t, id } -> { ok }   (+1 on an existing OPEN request)
//   notify  { ids:[...] } (team member / service role) -> e-mails the buyer about requests created inside the app.
// Duplicates: at most one open request per apartment and item (unique index in the DB), checked here as well.
// Deploy: npx --yes supabase@2.121.0 functions deploy supply-public --project-ref jswqdjevbncfqinntajg --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callerAllowed } from "../_shared/caller_auth.ts";
import { logResend } from "../_shared/email_log.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const J = { ...CORS, "Content-Type": "application/json" };
const reply = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: J });
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...((init.headers as Record<string, string>) || {}) } });

// warehouse locations (same keys as the Sklad module); the target is stored as prop_id 'wh:<key>' so the unique index
// (prop_id, lower(name)) gives one open request per item PER location without any schema change
const LOCS = [
  { id: "wh:presov", key: "presov", name: "Prešov" },
  { id: "wh:bratislava", key: "bratislava", name: "Bratislava" },
  { id: "wh:poprad", key: "poprad", name: "Poprad (Gerlachov)" },
  { id: "wh:trnava", key: "trnava", name: "Trnava" },
];
const locTarget = (id: string) => { const l = LOCS.find((x) => x.id === id); return l ? { id: l.id, name: "Sklad " + l.name } : null; };
const MAX_HOUR_ALL = 300;
const MAX_HOUR_PROP = 60;
const MAX_PHOTO_CHARS = 600_000; // base64 of a ~1000px JPEG is ~100-200 kB; this is a hard ceiling
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
const clean = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function tokenOk(t: unknown): Promise<boolean> {
  const tok = String(t ?? "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(tok)) return false;
  const r = await rest(`supply_public_tokens?token=eq.${encodeURIComponent(tok)}&active=eq.true&select=token&limit=1`);
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows.length === 1;
}

async function workspaceArray(key: string): Promise<any[]> {
  const r = await rest(`workspace?key=eq.${key}&select=value&limit=1`);
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && Array.isArray(rows[0]?.value) ? rows[0].value : [];
}

async function properties(): Promise<{ id: string; name: string }[]> {
  return (await workspaceArray("properties"))
    .filter((p: any) => p && p.id && p.name && !(Array.isArray(p.combinesPropertyIds) && p.combinesPropertyIds.length) && !/neakt|inactive|archiv/i.test(String(p.stav || p.status || "")))
    .map((p: any) => ({ id: String(p.id), name: String(p.name).trim() }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name, "sk"));
}

async function openFor(propId: string) {
  const r = await rest(`supply_requests?status=eq.requested&prop_id=eq.${encodeURIComponent(propId)}&select=id,name,qty,unit,requested_by,requested_at,urgent&order=requested_at.desc`);
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) ? rows.map((x: any) => ({ id: x.id, name: x.name, qty: x.qty, unit: x.unit, by: x.requested_by, at: x.requested_at, urgent: !!x.urgent })) : [];
}

// stores one small JPEG in the public "attachments" bucket (service role) and returns its public URL, or '' when invalid
async function storePhoto(data: unknown, id: string): Promise<string> {
  const s = String(data ?? "");
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m || s.length > MAX_PHOTO_CHARS) return "";
  try {
    const bin = atob(m[1]);
    if (bin.length < 200 || bin.charCodeAt(0) !== 0xff || bin.charCodeAt(1) !== 0xd8) return "";
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const path = `supplies/${id}.jpg`;
    const r = await fetch(`${SB_URL}/storage/v1/object/attachments/${path}`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "image/jpeg" },
      body: bytes,
    });
    return r.ok ? `${SB_URL}/storage/v1/object/public/attachments/${path}` : "";
  } catch {
    return "";
  }
}

// one e-mail per submission to the buyer; urgent ones are marked in the subject. Never throws.
async function notifyBuyer(propName: string, who: string, rows: { name: string; qty: unknown; unit: unknown }[], note: string, urgent: boolean, photo: string, source: string) {
  try {
    // recipients chosen in the app (workspace.supplySettings.notify = [{name,email}]); fallback SUPPLY_NOTIFY_TO / info@
    let to: string[] = [];
    try {
      const sr = await rest("workspace?key=eq.supplySettings&select=value&limit=1");
      const sj = await sr.json().catch(() => []);
      const list = sj?.[0]?.value?.notify;
      if (Array.isArray(list)) to = list.map((x: any) => String(x?.email || "").trim()).filter((e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)).slice(0, 10);
    } catch (_e) { /* use fallback */ }
    if (!to.length) to = (Deno.env.get("SUPPLY_NOTIFY_TO") || "info@rsproperties.sk").split(",").map((x) => x.trim()).filter(Boolean);
    if (!to.length || !Deno.env.get("RESEND_API_KEY")) return;
    const from = Deno.env.get("EMAIL_FROM") || "RS Properties <info@rsproperties.sk>";
    const subject = `${urgent ? "NALIEHAVE: " : ""}Zasoby - ${propName} (${rows.length} ${rows.length === 1 ? "polozka" : "poloziek"})`;
    const list = rows.map((r) => `<li>${esc(r.name)} &times; ${esc(r.qty)} ${esc(r.unit)}</li>`).join("");
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a2e44">`
      + (urgent ? `<p style="background:#fdeaea;border:1px solid #b83232;color:#b83232;padding:8px 12px;border-radius:8px;font-weight:700">NALIEHAVE - treba doplnit co najskor</p>` : "")
      + `<p><b>${esc(propName)}</b><br>Nahlasil/a: ${esc(who)}${source === "public" ? " (verejny odkaz)" : ""}</p><ul>${list}</ul>`
      + (note ? `<p>Poznamka: ${esc(note)}</p>` : "")
      + (photo ? `<p><a href="${esc(photo)}">Fotka</a></p>` : "")
      + `<p><a href="https://app.rsproperties.sk/">Otvorit Keystone &rarr; Doplnit zasoby &rarr; Na nakup</a></p></body></html>`;
    const rr = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
    });
    const parsed = await rr.json().catch(() => ({}));
    await logResend(rr, parsed, { to: to.join(","), subject, template: "supply-request", meta: { from, prop: propName, urgent } });
  } catch (_e) { /* a failed notification must never fail the request */ }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405);
  try {
    const b = await req.json();
    const action = String(b.action || "");

    // requests created inside the app (logged-in team member) -> same e-mail to the buyer
    if (action === "notify") {
      if (!(await callerAllowed(req))) return reply({ ok: false, error: "forbidden" }, 403);
      const ids = (Array.isArray(b.ids) ? b.ids : []).map((x: unknown) => String(x)).filter((x: string) => /^[A-Za-z0-9_-]{4,40}$/.test(x)).slice(0, 20);
      if (!ids.length) return reply({ ok: false, error: "empty" }, 400);
      const r = await rest(`supply_requests?id=in.(${ids.join(",")})&select=prop_name,name,qty,unit,note,requested_by,urgent,photo_url,source`);
      const rows: any[] = await r.json().catch(() => []);
      if (!Array.isArray(rows) || !rows.length) return reply({ ok: false, error: "not_found" }, 404);
      await notifyBuyer(rows[0].prop_name, rows[0].requested_by, rows, rows[0].note || "", rows.some((x) => x.urgent), rows[0].photo_url || "", rows[0].source || "app");
      return reply({ ok: true });
    }

    if (!(await tokenOk(b.t))) return reply({ ok: false, error: "bad_key" }, 403);

    if (action === "catalog") {
      const [cr, props] = await Promise.all([
        rest("supply_catalog?active=eq.true&order=sort.asc,name.asc&select=id,name,icon,unit"),
        properties(),
      ]);
      const tiles = await cr.json().catch(() => []);
      const out: Record<string, unknown> = { ok: true, tiles: Array.isArray(tiles) ? tiles : [], props, locations: LOCS.map((l) => ({ id: l.id, name: l.name })) };
      const pid = String(b.prop_id || "");
      if (pid) {
        const p = locTarget(pid) || props.find((x) => x.id === pid);
        if (!p) return reply({ ok: false, error: "bad_property" }, 400);
        out.prop = p;
        out.open = await openFor(pid);
      }
      return reply(out);
    }

    if (action === "submit") {
      const who = clean(b.who, 60);
      if (who.length < 2) return reply({ ok: false, error: "name_required" }, 400);
      const props = await properties();
      // target = a warehouse location (normal) or an apartment (only for something specific to it)
      const pidIn = String(b.prop_id || "");
      const prop = locTarget(pidIn) || props.find((x) => x.id === pidIn);
      if (!prop) return reply({ ok: false, error: "bad_property" }, 400);
      const items = Array.isArray(b.items) ? b.items.slice(0, 15) : [];
      if (!items.length) return reply({ ok: false, error: "empty" }, 400);

      // rate limit (per hour): protects against a leaked link being spammed
      const since = new Date(Date.now() - 3600_000).toISOString();
      const rr = await rest(`supply_requests?source=eq.public&requested_at=gte.${since}&select=prop_id&limit=${MAX_HOUR_ALL + 1}`);
      const recent = await rr.json().catch(() => []);
      if (Array.isArray(recent) && (recent.length >= MAX_HOUR_ALL || recent.filter((x: any) => x.prop_id === prop.id).length >= MAX_HOUR_PROP)) {
        return reply({ ok: false, error: "rate_limited" }, 429);
      }

      const cr = await rest("supply_catalog?active=eq.true&select=id,name,unit");
      const cat: any[] = await cr.json().catch(() => []);
      const open = await openFor(prop.id);
      const openKeys = new Set(open.map((o) => norm(o.name)));
      const note = clean(b.note, 300);
      const urgent = b.urgent === true;
      const now = new Date().toISOString();
      const stamp = "sr" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const seen = new Set<string>();
      const lines: { catalog_id: string; name: string; qty: number; unit: string }[] = [];
      for (const it of items) {
        const c = it.catalog_id ? cat.find((x) => x.id === String(it.catalog_id)) : null;
        const name = c ? String(c.name) : clean(it.name, 120);
        const qty = Math.min(20, Math.max(1, Math.round(Number(it.qty) || 1)));
        if (!name) continue;
        const k = norm(name);
        if (seen.has(k)) continue;
        seen.add(k);
        if (openKeys.has(k)) return reply({ ok: false, error: "duplicate", open }, 409);
        lines.push({ catalog_id: c ? c.id : "", name, qty, unit: c ? c.unit : "ks" });
      }
      if (!lines.length) return reply({ ok: false, error: "empty" }, 400);
      const photo = b.photo ? await storePhoto(b.photo, stamp) : "";
      const rows = lines.map((l, i) => ({
        id: stamp + i, prop_id: prop.id, prop_name: prop.name, catalog_id: l.catalog_id, name: l.name, qty: l.qty,
        unit: l.unit, note, status: "requested", requested_by: who, requested_at: now, source: "public", urgent, photo_url: photo,
      }));
      const ir = await rest("supply_requests", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(rows) });
      if (ir.status === 409) return reply({ ok: false, error: "duplicate", open: await openFor(prop.id) }, 409);
      if (!ir.ok) return reply({ ok: false, error: "save_failed" }, 500);
      await notifyBuyer(prop.name, who, rows, note, urgent, photo, "public");
      return reply({ ok: true, n: rows.length });
    }

    if (action === "more") {
      const id = String(b.id || "");
      if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) return reply({ ok: false, error: "bad_id" }, 400);
      const g = await rest(`supply_requests?id=eq.${encodeURIComponent(id)}&status=eq.requested&select=qty&limit=1`);
      const rows = await g.json().catch(() => []);
      if (!Array.isArray(rows) || !rows.length) return reply({ ok: false, error: "not_open" }, 404);
      const qty = Math.min(50, (Number(rows[0].qty) || 1) + 1);
      const pr = await rest(`supply_requests?id=eq.${encodeURIComponent(id)}&status=eq.requested`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ qty }) });
      return reply({ ok: pr.ok, qty });
    }

    return reply({ ok: false, error: "unknown_action" }, 400);
  } catch (e) {
    return reply({ ok: false, error: String((e as Error).message || e) }, 400);
  }
});
