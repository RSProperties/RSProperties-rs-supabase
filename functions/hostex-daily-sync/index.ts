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
// 2026-09-17 addition — daily live DRAFT REPORTS (not just the dashboard):
// after refreshing `hostexLive`, also builds one real report-shaped row
// per property for the CURRENT month and upserts it into the `reports`
// table (same table/shape real saved reports use — see dbSaveReport() in
// index.html), with id `r_live_<propId>_<month>` and `published:false`
// (owner-auth's get_reports already filters on that flag, so owners never
// see these) and `isLiveDraft:true`. Overwritten in place every run — no
// history kept, per the user's own answer when this was scoped. Follows
// the REAL report math (calcGrandNP/getCityTax/getExp in index.html —
// per-channel city-tax gating via cityTaxChannels, cleaning applied once
// per reservation same as a Bulk Sync import), NOT the simpler always-tax
// -every-guest-night math the "Aktuálny mesiac" dashboard itself uses —
// so the two views can legitimately disagree slightly; the live draft
// exists specifically to look like a real report, not to restate the
// dashboard. Quick Log entries for the property+month are folded in as a
// single otherIncome/otherExpense line each, mirroring calcGrandNP's
// mode:'owner'/'deduct' handling. Stale live-draft rows for months that
// are no longer current get deleted so the table doesn't accumulate them
// forever (the client separately excludes `r_live_` ids from
// dbLoadReports() entirely — kept off the Saved Reports list, out of
// report-count badges, and out of the duplicate-month-guard reports.find()
// checks, so closing the real report later never collides with this).
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

function isBDC(source: string): boolean {
  return (source || "").toLowerCase().indexOf("booking.com") >= 0;
}
function shouldAutoCityTax(source: string, cityTaxChannels: string[]): boolean {
  if (isBDC(source)) return true;
  return Array.isArray(cityTaxChannels) && cityTaxChannels.indexOf((source || "").trim()) >= 0;
}

// Builds one report-shaped object for `prop` + `month`, following the same
// math as saveReport()/calcGrandNP()/getCityTax()/getExp() in index.html —
// see the file-header comment for why that's a deliberate choice over the
// simpler "Aktuálny mesiac" dashboard math.
function buildLiveDraftReport(
  prop: any,
  reservations: any[],
  quickLogRows: any[],
  month: string,
  syncedAt: string,
): any {
  const cityTaxChannels: string[] = Array.isArray(prop.cityTaxChannels) ? prop.cityTaxChannels : [];
  const defaultCleaning = Number(prop.defaultCleaning) || 0;
  const feePct = Number(prop.fee) || 0;
  const taxPerGN = Number(prop.taxPerGuestNight) || 0;

  const reps = reservations.map((r) => {
    const nights = Number(r.nights) || 0;
    const guests = Number(r.guests) || 0;
    const income = Number(r.income) || 0;
    const cityTax = shouldAutoCityTax(r.source, cityTaxChannels) ? nights * guests * taxPerGN : 0;
    // Cleaning applies once per reservation/stay, same rule the property
    // popup and Bulk Sync already use — not gated by which month the
    // checkout falls in (that nuance is the dashboard's own, separate rule).
    const cleaning = r.cleaning ? Number(r.cleaning) : defaultCleaning;
    return { r, cleaning, cityTax, netIncome: income - cityTax };
  });

  const totalIncome = reps.reduce((s, x) => s + (Number(x.r.income) || 0), 0);
  const totalCityTax = reps.reduce((s, x) => s + x.cityTax, 0);
  const totalCleaning = reps.reduce((s, x) => s + x.cleaning, 0);
  const totalNights = reps.reduce((s, x) => s + (Number(x.r.nights) || 0), 0);

  // Quick Log for this property + month — folded in as a single
  // otherIncome/otherExpense line each, mirroring calcGrandNP's
  // mode:'owner'/'deduct' defaults for a manually-added row.
  const qlRows = quickLogRows.filter((q) => q && q.propId === prop.id && q.month === month);
  const qlIncome = qlRows.filter((q) => q.type === "income").reduce((s, q) => s + (Number(q.amount) || 0), 0);
  const qlExpense = qlRows.filter((q) => q.type !== "income").reduce((s, q) => s + (Number(q.amount) || 0), 0);
  const otherIncome = qlIncome > 0 ? [{ id: "ql_income", label: "Quick Log", amount: qlIncome, mode: "owner" }] : [];
  const otherExpenses = qlExpense > 0 ? [{ id: "ql_expense", label: "Quick Log", amount: qlExpense, mode: "deduct" }] : [];

  const feeBase = reps.reduce((s, x) => s + x.netIncome, 0) + qlIncome;
  const mgmt = feeBase * (feePct / 100);
  const allExp = totalCleaning + qlExpense;
  const totalNI = reps.reduce((s, x) => s + x.netIncome, 0) + qlIncome;
  const finalNP = totalNI - mgmt - allExp;

  const cleanReservations = reps.map((x) => ({ ...x.r, cleaning: x.cleaning }));
  const id = `r_live_${prop.id}_${month}`;

  return {
    id, month, propId: prop.id, propName: prop.name || "",
    published: false, isLiveDraft: true,
    reportColumns: [],
    owner: prop.owner || "", fee: String(feePct), cur: "€",
    taxRate: String(taxPerGN), cityTaxChannels,
    notes: "[]", otherExpenses, otherIncome, attachments: [],
    portalShowChannel: true, portalShowGuest: true, portalShowCheckin: true, portalShowCheckout: true,
    portalShowNights: true, portalShowBooked: true, portalShowGuests: true, portalShowRoomRate: true,
    portalShowIncome: true, portalShowMgmt: true, portalShowCleaning: true, portalShowCityTax: true,
    portalShowExtraExp: true, portalShowExtraInc: true, portalShowPayout: true, portalShowNP: true,
    income: totalIncome.toFixed(2), netProfit: finalNP.toFixed(2),
    _calc: {
      tInc: Math.round(totalIncome * 100) / 100,
      tCT: Math.round(totalCityTax * 100) / 100,
      payout: Math.round((totalIncome - totalCityTax) * 100) / 100,
      tMgmt: Math.round(mgmt * 100) / 100,
      tCleaning: Math.round(totalCleaning * 100) / 100,
      grandNP: Math.round(finalNP * 100) / 100,
      tNights: totalNights,
      tBooks: reps.length,
    },
    reservations: cleanReservations,
    columns: [],
    savedAt: syncedAt,
  };
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

  // 4. Live draft reports — current month only, one row per property with
  //    a hostexPropertyId. Best-effort: a failure here must never take
  //    down the hostexLive sync above, which already succeeded and
  //    returned 200 by this point from the caller's perspective.
  let liveDraftCount = 0;
  const liveDraftErrors: Record<string, string> = {};
  try {
    const [qlRow, qlDeletedRow] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/workspace?select=value&key=eq.quickLog`, { headers: sbHeaders() }).then((r) => r.json()).catch(() => []),
      fetch(`${SB_URL}/rest/v1/workspace?select=value&key=eq.quickLog_deleted`, { headers: sbHeaders() }).then((r) => r.json()).catch(() => []),
    ]);
    const qlAll: any[] = Array.isArray(qlRow) && Array.isArray(qlRow[0]?.value) ? qlRow[0].value : [];
    const qlDeleted: any[] = Array.isArray(qlDeletedRow) && Array.isArray(qlDeletedRow[0]?.value) ? qlDeletedRow[0].value : [];
    const quickLogRows = qlAll.filter((q) => q && qlDeleted.indexOf(q.id) < 0);

    const curByProp = byMonth[cur]?.byProp || {};
    const draftWrites: any[] = [];
    for (const p of targets) {
      try {
        const rep = buildLiveDraftReport(p, curByProp[p.id] || [], quickLogRows, cur, payload.syncedAt);
        draftWrites.push({ id: rep.id, month: rep.month, prop_id: rep.propId, prop_name: rep.propName, data: rep, saved_at: rep.savedAt });
        liveDraftCount++;
      } catch (e) {
        liveDraftErrors[p.id] = String(e);
      }
    }

    if (draftWrites.length) {
      const dw = await fetch(`${SB_URL}/rest/v1/reports`, {
        method: "POST",
        headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(draftWrites),
      });
      if (!dw.ok) liveDraftErrors["_write"] = (await dw.text()).slice(0, 300);
    }

    // Drop live-draft rows for months that are no longer current — "latest
    // version only, no history" per how this feature was scoped. PostgREST
    // `like` treats `*` as the SQL `%` wildcard (same convention already
    // used for the workspace backup_* exclusion in preflight.sh).
    await fetch(`${SB_URL}/rest/v1/reports?id=like.r_live_*&month=neq.${encodeURIComponent(cur)}`, {
      method: "DELETE",
      headers: sbHeaders(),
    }).catch(() => {});
  } catch (e) {
    liveDraftErrors["_fatal"] = String(e);
  }

  return new Response(
    JSON.stringify({
      ok: true, months, propertyCount: targets.length, reservationCount: total, errorCount: Object.keys(errors).length,
      liveDraftCount, liveDraftErrorCount: Object.keys(liveDraftErrors).length,
    }),
    { headers: JSON_HEADERS, status: 200 },
  );
});
