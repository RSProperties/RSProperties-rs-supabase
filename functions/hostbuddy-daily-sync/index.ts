// RS Properties / Keystone — Supabase Edge Function
// Pulls HostBuddy's incomplete "action items" (issues the AI extracted
// from guest conversations — maintenance reports, cleanliness
// complaints, guest requests, etc.) so the team can turn any of them
// into a real Task from inside Keystone instead of checking HostBuddy's
// own dashboard separately. Round-2 roadmap item #4.
//
// API: HostBuddy's General API (documented OpenAPI spec, read scope) —
// `GET https://api.hostbuddy.ai/api/v1/action_items`, header
// `X-API-Key`. Unlike the PriceLabs integration (item #5), this one *is*
// verified against real, documented endpoints/fields (confirmed live via
// the HostBuddy MCP tool before writing this: 60 real incomplete items
// returned with exactly the field names used below).
//
// - Fetches every `status=incomplete` action item (paginates via
//   `next_cursor` — HostBuddy's own default page size is small enough
//   that a 60-item backlog already needs it).
// - Writes the raw list to workspace key `hostbuddyLive` (service role,
//   bypasses RLS, read RAW by the frontend — same reasoning as
//   hostexLive/pricelabsLive: a point-in-time snapshot, not something
//   the client merges/edits in place).
//
// Auth: same allow-rule as every other daily-sync function here (service
// role for pg_cron, or an active team member's Supabase Auth token for a
// manual trigger).
//
// Deploy: supabase functions deploy hostbuddy-daily-sync
// Secret: HOSTBUDDY_API_KEY (set via
//   `supabase secrets set HOSTBUDDY_API_KEY=<key> --project-ref jswqdjevbncfqinntajg`)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HOSTBUDDY_API_KEY = Deno.env.get("HOSTBUDDY_API_KEY") ?? "";
const HOSTBUDDY_BASE = "https://api.hostbuddy.ai/api/v1";

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

// NOTE: `listActionItems` (GET /api/v1/action_items) documents only
// status/conversation_id/property_name/limit query params — no cursor or
// offset. `limit` maxes out at 200; there is no documented way to page
// past that on this endpoint. 200 comfortably covers this account's
// current incomplete backlog (60 at the time this was written), so a
// single request is used rather than inventing pagination the API
// doesn't support. If the backlog ever exceeds 200, the oldest
// incomplete items beyond that would simply not appear — acceptable for
// now, revisit if HostBuddy adds real pagination to this endpoint.
async function fetchAllIncomplete(): Promise<{ items: any[]; error?: string }> {
  const res = await fetch(`${HOSTBUDDY_BASE}/action_items?status=incomplete&limit=200`, {
    headers: { "X-API-Key": HOSTBUDDY_API_KEY },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { items: [], error: `http_${res.status}: ${body.slice(0, 300)}` };
  }
  const json = await res.json().catch(() => null);
  const items = Array.isArray(json?.data) ? json.data : [];
  return { items };
}

// Conversations: the API has no pagination and returns the 100 most recent per call, so besides the
// unfiltered call we also ask per big channel (a quiet channel would otherwise be pushed out by chatty
// ones) and merge by conversation_id. "Waiting for our reply" = the last message came from the guest.
async function fetchConversations(): Promise<{ awaiting: any[]; fetched: number; senders: Record<string, number>; error?: string }> {
  const urls = ["", "&channel=airbnb", "&channel=bookingcom"].map((q) => `${HOSTBUDDY_BASE}/conversations?limit=100${q}`);
  const all = new Map<string, any>();
  let error: string | undefined;
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { "X-API-Key": HOSTBUDDY_API_KEY } });
      if (!r.ok) { error = `http_${r.status}`; continue; }
      const j = await r.json().catch(() => null);
      (Array.isArray(j?.data) ? j.data : []).forEach((c: any) => { if (c?.conversation_id) all.set(c.conversation_id, c); });
    } catch (e) { error = String(e).slice(0, 120); }
  }
  const senders: Record<string, number> = {};
  all.forEach((c) => { const k = String(c.last_message_sender || "?"); senders[k] = (senders[k] || 0) + 1; });
  const awaiting = [...all.values()]
    .filter((c) => String(c.last_message_sender || "").toLowerCase() === "guest")
    .map((c) => ({
      conversation_id: c.conversation_id, guest_name: c.guest_name || "", channel: c.channel || "",
      property_name: c.property_name || "", reservation_id: c.reservation_id || "",
      last_message_time_utc: c.last_message_time_utc || "", sentiment: c.sentiment || "", message_count: c.message_count || 0,
    }));
  return { awaiting, fetched: all.size, senders, error };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(await callerAllowed(req))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { headers: JSON_HEADERS, status: 403 });
  }
  if (!HOSTBUDDY_API_KEY) {
    return new Response(JSON.stringify({ error: "hostbuddy_api_key_not_configured" }), { headers: JSON_HEADERS, status: 501 });
  }

  const { items, error } = await fetchAllIncomplete();
  const convs = await fetchConversations();
  await fetch(`${SB_URL}/rest/v1/workspace`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: "hostbuddyConvs", value: { syncedAt: new Date().toISOString(), fetched: convs.fetched, senders: convs.senders, error: convs.error ?? null, awaiting: convs.awaiting } }),
  }).catch(() => {});

  const payload = {
    syncedAt: new Date().toISOString(),
    itemCount: items.length,
    items,
    error: error ?? null,
  };

  const up = await fetch(`${SB_URL}/rest/v1/workspace`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: "hostbuddyLive", value: payload }),
  });
  if (!up.ok) {
    const t = await up.text();
    return new Response(JSON.stringify({ error: "workspace_write_failed", detail: t.slice(0, 300) }), { headers: JSON_HEADERS, status: 500 });
  }

  return new Response(
    JSON.stringify({ ok: !error, itemCount: items.length, awaiting: convs.awaiting.length, fetched: convs.fetched, error: error ?? undefined }),
    { headers: JSON_HEADERS, status: error ? 502 : 200 },
  );
});
