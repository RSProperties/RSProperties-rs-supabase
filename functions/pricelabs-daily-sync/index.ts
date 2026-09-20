// RS Properties / Keystone — Supabase Edge Function
// Daily pull of each property's PriceLabs pricing calendar for the next
// two weeks, so "📊 Aktuálny mesiac" can show what PriceLabs currently has
// listed per night — Round-2 roadmap item #5 ("PriceLabs signal").
//
// SCOPE, DELIBERATELY NARROW: PriceLabs' own dashboard/MCP tooling exposes
// a rich "Actions"/Pulse diagnostic (blocked-date warnings, min-stay vs
// market, pending price "nudges" with an explicit recommended-vs-current
// price) — but that is a composed, higher-level feature with no publicly
// documented 1:1 REST endpoint this function could safely call. Rather
// than guess at undocumented endpoints for that, this function only calls
// the one PriceLabs endpoint that is simple, public, and well-known:
// `GET /v1/listing_prices` (a per-day pricing calendar for one listing).
// See "NOT YET VERIFIED" below before relying on this in an incident.
//
// - Reads the property list from workspace key `properties` (service
//   role). Only properties with a `pricelabsListingId` set (Properties →
//   edit → Linky tab → "💲 PriceLabs sync", mirroring how
//   `hostexPropertyId` already works) are synced — matching-by-name was
//   considered and rejected: PriceLabs' own listing_name strings don't
//   match our property names closely enough to auto-match safely (e.g.
//   PriceLabs "Sabol - Tomasikova 50C" vs our "Tomasikova 50C").
// - All these properties are on Hostex (pms=hostex) per this account's
//   PriceLabs listings — hardcoded rather than threaded through per
//   property, since every mapped property will be on the same PMS here.
// - Writes the assembled result to workspace key `pricelabsLive` (service
//   role, bypasses RLS, read RAW by the frontend — no _mergeArr, same
//   reasoning as hostexLive: this is a point-in-time snapshot, not an
//   editable dataset).
//
// NOT YET VERIFIED: this function was written without a real PriceLabs
// API key (none was available at the time) — the endpoint path, the
// `pms` vs `pms_name` query param name, and the exact response field
// names (`price` vs `recommended_price` vs something else) are this
// session's best understanding of PriceLabs' public API, not something
// actually exercised against production. The response parser below is
// deliberately defensive (tries several plausible shapes and records
// whatever it couldn't recognize in `parseWarning`) specifically so a
// shape mismatch is visible in the payload/logs instead of silently
// returning empty data forever. **First real run after the API key is
// added must be checked against `errors`/`parseWarning` in the response,
// or by querying workspace.pricelabsLive directly — don't assume it
// works just because the function returns 200.**
//
// Auth: same allow-rule as hostex-daily-sync (service role for pg_cron,
// or any active team member's Supabase Auth token for a manual trigger).
//
// Deploy: supabase functions deploy pricelabs-daily-sync
// Secret needed: PRICELABS_API_KEY (not set yet — set with
//   `supabase secrets set PRICELABS_API_KEY=<key>` when available).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PRICELABS_API_KEY = Deno.env.get("PRICELABS_API_KEY") ?? "";
const PRICELABS_BASE = "https://api.pricelabs.co/v1";
const DAYS_AHEAD = 14;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Defensive parse: PriceLabs' documented shape is `{ data: [{ date, price, ... }] }`
// or a bare array — try both, and try a few plausible field names for the
// price itself. Anything it can't recognize is surfaced in `warning`
// rather than silently dropped, per the file-header note above.
function parsePriceRows(json: any): { rows: { date: string; price: number | null }[]; warning: string | null } {
  const list: any[] = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  if (!list.length) return { rows: [], warning: "empty_or_unrecognized_response" };
  const rows = list.map((r: any) => {
    const date = r.date ?? r.day ?? r.check_in ?? null;
    const priceRaw = r.price ?? r.recommended_price ?? r.base_price ?? r.calculated_price ?? r.rate ?? null;
    const price = priceRaw != null ? Number(priceRaw) : null;
    return { date, price: Number.isFinite(price as number) ? price : null };
  }).filter((r) => r.date);
  const warning = rows.length !== list.length || rows.some((r) => r.price == null)
    ? "some_rows_missing_recognized_date_or_price_field"
    : null;
  return { rows, warning };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(await callerAllowed(req))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { headers: JSON_HEADERS, status: 403 });
  }
  if (!PRICELABS_API_KEY) {
    return new Response(JSON.stringify({ error: "pricelabs_api_key_not_configured" }), { headers: JSON_HEADERS, status: 501 });
  }

  const pr = await fetch(`${SB_URL}/rest/v1/workspace?select=value&key=eq.properties`, { headers: sbHeaders() });
  const prows = await pr.json().catch(() => []);
  const props: any[] = Array.isArray(prows) && prows[0]?.value ? prows[0].value : [];
  const targets = props.filter((p) => p && p.pricelabsListingId && String(p.pricelabsListingId).trim() !== "");

  const dateFrom = isoDate(new Date());
  const dateTo = isoDate(new Date(Date.now() + DAYS_AHEAD * 86_400_000));

  const results = await pool(targets, 4, async (p) => {
    const listingId = String(p.pricelabsListingId).trim();
    const url = `${PRICELABS_BASE}/listing_prices?listing_id=${encodeURIComponent(listingId)}`
      + `&pms=hostex&pms_name=hostex&date_from=${dateFrom}&date_to=${dateTo}`;
    try {
      const res = await fetch(url, { headers: { "X-API-Key": PRICELABS_API_KEY } });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { propId: p.id, error: `http_${res.status}`, detail: body.slice(0, 300) };
      }
      const json = await res.json().catch(() => null);
      const { rows, warning } = parsePriceRows(json);
      return { propId: p.id, rows, warning };
    } catch (e) {
      return { propId: p.id, error: String(e) };
    }
  });

  const byProp: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const warnings: Record<string, string> = {};
  for (const r of results) {
    if ((r as any).error) { errors[r.propId] = (r as any).error; continue; }
    byProp[r.propId] = { rows: (r as any).rows };
    if ((r as any).warning) warnings[r.propId] = (r as any).warning;
  }

  const payload = {
    syncedAt: new Date().toISOString(),
    dateFrom, dateTo,
    propertyCount: targets.length,
    byProp,
    errors,
    warnings,
  };

  const up = await fetch(`${SB_URL}/rest/v1/workspace`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: "pricelabsLive", value: payload }),
  });
  if (!up.ok) {
    const t = await up.text();
    return new Response(JSON.stringify({ error: "workspace_write_failed", detail: t.slice(0, 300) }), { headers: JSON_HEADERS, status: 500 });
  }

  return new Response(
    JSON.stringify({ ok: true, propertyCount: targets.length, errorCount: Object.keys(errors).length, warningCount: Object.keys(warnings).length }),
    { headers: JSON_HEADERS, status: 200 },
  );
});
