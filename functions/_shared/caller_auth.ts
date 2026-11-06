// Shared caller gate for Edge Functions that send email / push on behalf of the app.
// Allows ONLY: the service role (server-to-server, e.g. owner-auth -> send-welcome-email)
// or an ACTIVE team member's Supabase Auth token (what the admin app sends as
// window._authToken). The public anon key - which ships in the page source - is NOT enough.
// Same allow-rule as send-push / send-ledger-published.
// NOTE: keep this file plain ASCII.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function jwtRole(tok: string): string {
  try {
    const p = JSON.parse(atob(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return p.role || "";
  } catch {
    return "";
  }
}

export async function callerAllowed(req: Request): Promise<boolean> {
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
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" } },
    );
    const rows = await tr.json().catch(() => []);
    return Array.isArray(rows) && rows[0]?.active === true;
  } catch {
    return false;
  }
}
