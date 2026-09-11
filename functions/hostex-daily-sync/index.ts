// RS Properties / Keystone — Supabase Edge Function
// Daily pull of the CURRENT month's Hostex reservations for every property
// that has a hostexPropertyId, so the team can see live month-to-date
// numbers for the still-running month without building a report.
//
// - Reads the property list from workspace key `properties` (service role).
// - For each property, calls the existing `hostex-sync` function for the
//   requested month (default: current calendar month). That function
//   already handles pagination, cross-month proration and the stable
//   reservation_code identity — this one just fans it out and caches the
//   result.
// - Writes the assembled result to workspace key `hostexLive` (service
//   role, bypasses RLS). The frontend reads that key RAW (never through
//   _mergeArr) so cancellations/price drops show correctly.
//
// Business rule (memory rs-builder-no-hostex-fees): cleaning fee + city
// tax are NOT taken from Hostex. `hostex-sync` already returns cleaning:0;
// the frontend applies both from each property's own config.
//
// Auth: allowed if the caller presents the service role key (pg_cron) OR a
// valid, active team member's Supabase Auth token (the "Sync teraz" button).
//
// Deploy: supabase functions deploy hostex-daily-sync
// Schedule (pg_cron): see sql_migrations/2026-09-10_hostex_daily_cron.sql

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { syncPropertyMonth } from "../_shared/hostex_core.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HOSTEX_API_KEY = Deno.env.get("HOSTEX_API_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

function sbHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
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
    const ur = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${auth}` },
    });
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

// Run `jobs` with at most `n` in flight at once.
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

  // Which months to sync. Default: previous + current calendar month
  // (previous covers "last month's report isn't done yet"). A body
  // {month:"YYYY-MM"} overrides with just that one.
  const cur = currentMonth();
  const [cy, cmo] = cur.split("-").map(Number);
  const prev = cmo === 1 ? `${cy - 1}-12` : `${cy}-${String(cmo - 1).padStart(2, "0")}`;
  let months = [prev, cur];
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month)) months = [body.month];
  } catch { /* no body — use default */ }

  // 1. property list
  const pr = await fetch(`${SB_URL}/rest/v1/workspace?select=value&key=eq.properties`, { headers: sbHeaders() });
  const prows = await pr.json().catch(() => []);
  const props: any[] = Array.isArray(prows) && prows[0]?.value ? prows[0].value : [];
  const targets = props.filter((p) => p && p.hostexPropertyId && String(p.hostexPropertyId).trim() !== "");

  // 2. pull each property × month directly from the Hostex API (batches of
  //    4 — one function invocation, so no Supabase function-rate-limit; the
  //    Hostex API's own limit is the constraint and 4-wide clears it).
  const jobs: { propId: string; hostexId: any; month: string }[] = [];
  for (const m of months) for (const p of targets) jobs.push({ propId: p.id, hostexId: p.hostexPropertyId, month: m });

  const results = await pool(jobs, 4, async (j) => {
    try {
      const reservations = await syncPropertyMonth(j.hostexId, j.month, HOSTEX_API_KEY);
      return { ...j, reservations };
    } catch (e) {
      return { ...j, error: String(e), reservations: [] as any[] };
    }
  });

  const byMonth: Record<string, { byProp: Record<string, any[]>; reservationCount: number }> = {};
  const errors: Record<string, string> = {};
  let total = 0;
  for (const m of months) byMonth[m] = { byProp: {}, reservationCount: 0 };
  for (const res of results) {
    byMonth[res.month].byProp[res.propId] = res.reservations;
    byMonth[res.month].reservationCount += res.reservations.length;
    total += res.reservations.length;
    if (res.error) errors[`${res.month}/${res.propId}`] = res.error;
  }

  // Merge into whatever months are already cached, so a single-month
  // "Sync teraz" doesn't wipe the other month.
  const prevRow = await fetch(`${SB_URL}/rest/v1/workspace?select=value&key=eq.hostexLive`, { headers: sbHeaders() })
    .then((r) => r.json()).catch(() => []);
  const prevVal = Array.isArray(prevRow) && prevRow[0]?.value ? prevRow[0].value : {};
  const mergedByMonth = { ...(prevVal.byMonth || {}) };
  for (const m of months) mergedByMonth[m] = byMonth[m];
  // keep only the last 3 distinct months so the blob can't grow unbounded
  const keepMonths = Object.keys(mergedByMonth).sort().slice(-3);
  const trimmedByMonth: Record<string, unknown> = {};
  for (const m of keepMonths) trimmedByMonth[m] = mergedByMonth[m];

  const payload = {
    months: keepMonths,
    currentMonth: cur,
    syncedAt: new Date().toISOString(),
    propertyCount: targets.length,
    reservationCount: total,
    byMonth: trimmedByMonth,
    errors,
  };

  // 3. upsert workspace key `hostexLive` (key is the PK — same POST the
  //    frontend's dbSaveKey uses, PostgREST infers the conflict target)
  const up = await fetch(`${SB_URL}/rest/v1/workspace`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: "hostexLive", value: payload }),
  });
  if (!up.ok) {
    const t = await up.text();
    return new Response(JSON.stringify({ error: "workspace_write_failed", detail: t.slice(0, 300) }), {
      headers: JSON_HEADERS,
      status: 500,
    });
  }

  return new Response(
    JSON.stringify({ ok: true, months, propertyCount: targets.length, reservationCount: total, errorCount: Object.keys(errors).length }),
    { headers: JSON_HEADERS, status: 200 },
  );
});
