// RS Properties — Supabase Edge Function
// Server-side team (admin app) password verification + account
// provisioning. Replaces direct anon-key writes/reads of
// team_users.password and team_users.invite_token-based activation,
// which used to be fully world-readable/writable (open RLS policies).
// The client never sees or sets a raw password hash after this change.
// Deploy: supabase functions deploy team-auth

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// totp_enabled added 2026-09-24 — a boolean, safe to expose (never
// totp_secret itself), needed client-side so submitLogin() knows whether
// to route a login through the 2FA-aware path before any auth call is
// made, and so the Team Members admin list can show 2FA status.
const SAFE_COLS =
  "id,name,email,role,permissions,active,created_at,last_login,invite_token,name_locked,totp_enabled";

function sbHeaders(extra?: Record<string, string>) {
  return Object.assign(
    { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    extra || {}
  );
}
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { headers: { ...CORS, "Content-Type": "application/json" }, status });
}

async function pbkdf2Hash(password: string, saltHex?: string, iterations = 100000): Promise<string> {
  const enc = new TextEncoder();
  const salt = saltHex
    ? new Uint8Array((saltHex.match(/.{1,2}/g) || []).map((b) => parseInt(b, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, keyMaterial, 256);
  const hashHex = Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const saltOut = Array.from(salt).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2$${iterations}$${saltOut}$${hashHex}`;
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function pbkdf2Verify(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const computed = await pbkdf2Hash(password, parts[2], parseInt(parts[1], 10));
  return timingSafeEqual(computed, stored);
}
async function sha256hex(str: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------- 2FA / TOTP (2026-09-24, opt-in, admin-only) ----------------
// RFC 6238 (TOTP) over RFC 4226 (HOTP), HMAC-SHA1, 6 digits, 30s step -
// the same algorithm every authenticator app (Google Authenticator, Authy,
// 1Password, etc.) implements, so no companion app or QR library is
// needed here - a manually-typed base32 secret is universally supported.
// Implemented inline with crypto.subtle (same primitive pbkdf2Hash above
// already uses) rather than pulling in a dependency for something this
// short and this well-specified.
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(bytes: Uint8Array): string {
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  const rem = bits.length % 5;
  if (rem > 0) out += BASE32_ALPHABET[parseInt(bits.slice(bits.length - rem).padEnd(5, "0"), 2)];
  return out;
}
function base32Decode(b32: string): Uint8Array {
  const clean = b32.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of clean) {
    const val = BASE32_ALPHABET.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(bytes);
}
function randomBase32Secret(byteLen = 20): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(byteLen)));
}
async function totpCodeAt(secretB32: string, stepOffset: number): Promise<string> {
  const key = base32Decode(secretB32);
  const counter = Math.floor(Date.now() / 1000 / 30) + stepOffset;
  const counterBytes = new ArrayBuffer(8);
  new DataView(counterBytes).setBigUint64(0, BigInt(counter));
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, counterBytes));
  const offset = hmac[hmac.length - 1] & 0xf;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binCode % 1000000).padStart(6, "0");
}
// Accepts the current 30s step and one step on either side, so a code
// typed right at a step boundary (or a slightly-off device clock) isn't
// rejected - the same tolerance window most TOTP implementations use.
async function totpVerify(secretB32: string, code: string): Promise<boolean> {
  const clean = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  for (const offset of [0, -1, 1]) {
    if ((await totpCodeAt(secretB32, offset)) === clean) return true;
  }
  return false;
}

// ---------------- Phase 3 (2026-09-07): real Supabase Auth accounts ----------------
// reports/workspace/warehouse RLS now key off auth.uid(), so every
// team_users row needs a matching auth.users account. These two helpers
// create/sync that account and mint a real session, called from every
// action here that knows a member's plaintext password - login (this is
// the main migration path, invisible to the person logging in), account
// creation, an admin-set password, and invite activation.
async function ensureAuthUser(email: string, password: string, existingAuthUserId?: string | null): Promise<string | null> {
  try {
    if (existingAuthUserId) {
      const r = await fetch(`${SB_URL}/auth/v1/admin/users/${existingAuthUserId}`, {
        method: "PUT",
        headers: sbHeaders(),
        body: JSON.stringify({ password }),
      });
      if (r.ok) return existingAuthUserId;
      // linked id is stale/invalid (e.g. manually deleted in the dashboard) - fall through and recreate.
    }
    const cr = await fetch(`${SB_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: sbHeaders(),
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const cj = await cr.json().catch(() => ({}));
    if (cr.ok && cj.id) return cj.id;
    return null; // non-fatal: legacy password verification still succeeded, this just means the
                 // auth.uid()-based tables won't be reachable yet - will retry on next login.
  } catch {
    return null;
  }
}
async function passwordGrant(email: string, password: string): Promise<{ access_token: string; refresh_token: string; expires_in: number } | null> {
  try {
    const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.access_token) return { access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in };
  } catch { /* non-fatal */ }
  return null;
}

const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

async function checkRateLimit(key: string): Promise<{ ok: boolean; retryAfterSec?: number }> {
  const r = await fetch(`${SB_URL}/rest/v1/auth_rate_limits?key=eq.${encodeURIComponent(key)}`, { headers: sbHeaders() });
  const rows = await r.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (row && row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    return { ok: false, retryAfterSec: Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 1000) };
  }
  return { ok: true };
}
async function recordAttempt(key: string): Promise<void> {
  const r = await fetch(`${SB_URL}/rest/v1/auth_rate_limits?key=eq.${encodeURIComponent(key)}`, { headers: sbHeaders() });
  const rows = await r.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  const now = Date.now();
  if (!row || now - new Date(row.window_start).getTime() > WINDOW_MS) {
    await fetch(`${SB_URL}/rest/v1/auth_rate_limits`, {
      method: "POST",
      headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ key, attempts: 1, window_start: new Date().toISOString(), locked_until: null }),
    }).catch(() => {});
    return;
  }
  const attempts = (row.attempts || 0) + 1;
  const patch: Record<string, unknown> = { attempts };
  if (attempts >= MAX_ATTEMPTS) patch.locked_until = new Date(now + LOCK_MS).toISOString();
  await fetch(`${SB_URL}/rest/v1/auth_rate_limits?key=eq.${encodeURIComponent(key)}`, {
    method: "PATCH",
    headers: sbHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(patch),
  }).catch(() => {});
}
async function clearRateLimit(key: string): Promise<void> {
  await fetch(`${SB_URL}/rest/v1/auth_rate_limits?key=eq.${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: sbHeaders(),
  }).catch(() => {});
}

// ---------------- admin-caller verification (2026-09-10) ----------------
// team_users is no longer world-writable (see
// sql_migrations/2026-09-10_team_users_lockdown.sql). The admin actions
// below therefore have to prove the caller is a real active team admin
// themselves - they run with the service role, which bypasses RLS.
// callerToken is the caller's own Supabase Auth access token
// (window._authToken on the client).
// Resolves a bearer token (the caller's OWN Supabase Auth session) to
// their team_users row - used both by isCallerTeamAdmin below and by the
// TOTP setup/disable actions, which must only ever act on the caller's
// own account (never a client-supplied teamUserId) so one admin can
// never set up or tamper with another admin's second factor.
async function resolveCallerTeamUser(
  callerToken: string,
): Promise<{ id: string; email: string; role: string; active: boolean; permissions: unknown; password: string; totp_enabled: boolean } | null> {
  if (!callerToken) return null;
  try {
    const ur = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${callerToken}` },
    });
    if (!ur.ok) return null;
    const uj = await ur.json();
    const uid = uj && uj.id;
    if (!uid) return null;
    const tr = await fetch(
      `${SB_URL}/rest/v1/team_users?select=id,email,role,active,permissions,password,totp_enabled&auth_user_id=eq.${encodeURIComponent(uid)}&limit=1`,
      { headers: sbHeaders() },
    );
    const trows = await tr.json();
    const tu = Array.isArray(trows) ? trows[0] : null;
    return tu && tu.active === true ? tu : null;
  } catch {
    return null;
  }
}
async function isCallerTeamAdmin(callerToken: string): Promise<boolean> {
  const tu = await resolveCallerTeamUser(callerToken);
  if (!tu) return false;
  return tu.role === "admin" || (tu.permissions && (tu.permissions as Record<string, unknown>).team === "edit");
}
// Whether ANY active admin exists yet - the one case admin_create_member
// is allowed with no caller (first-run setup).
async function anyActiveAdminExists(): Promise<boolean> {
  const r = await fetch(
    `${SB_URL}/rest/v1/team_users?select=id&role=eq.admin&active=eq.true&limit=1`,
    { headers: sbHeaders() },
  );
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();

    // ---------------- VERIFY PASSWORD (legacy fallback login path) ----------------
    // Only reached when the account has no working Supabase Auth session yet
    // (the admin app tries real Supabase Auth first). Client already fetched
    // the profile separately via the password-free column list.
    if (action === "verify_password") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const totpCode = body.totpCode != null ? String(body.totpCode) : "";
      if (!email || !password) return json({ error: "missing_fields" }, 400);

      const rlKey = `team_login:${email}:${ip}`;
      const rl = await checkRateLimit(rlKey);
      if (!rl.ok) return json({ error: "rate_limited", retryAfterSec: rl.retryAfterSec }, 429);

      const r = await fetch(`${SB_URL}/rest/v1/team_users?select=id,password,auth_user_id,totp_secret,totp_enabled&email=eq.${encodeURIComponent(email)}&limit=1`, {
        headers: sbHeaders(),
      });
      const rows = await r.json();
      const u = Array.isArray(rows) ? rows[0] : null;
      if (!u || !u.password) {
        await recordAttempt(rlKey);
        return json({ error: "wrong_password" }, 401);
      }

      let ok = false;
      let isPlaintextMatch = false;
      if (u.password.startsWith("pbkdf2$")) {
        ok = await pbkdf2Verify(password, u.password);
      } else if (/^[a-f0-9]{64}$/i.test(u.password)) {
        ok = (await sha256hex(password)) === u.password;
      } else if (u.password === password) {
        // oldest legacy accounts: password column literally held plaintext
        ok = true;
        isPlaintextMatch = true;
      }

      if (!ok) {
        await recordAttempt(rlKey);
        return json({ error: "wrong_password" }, 401);
      }

      // 2FA (opt-in, admin-only - see the 2026-09-24 CLAUDE.md entry): a
      // correct password alone doesn't finish a 2FA-enabled login, so the
      // rate-limit counter stays live and Auth/session issuance is held
      // until the code also checks out. Never reveal which factor was
      // wrong - same generic "wrong_password" error either way, so a
      // brute-force attempt can't distinguish "bad password" from "bad
      // code" and narrow its search.
      if (u.totp_enabled && u.totp_secret) {
        if (!totpCode) return json({ ok: true, needsTotp: true });
        if (!(await totpVerify(u.totp_secret, totpCode))) {
          await recordAttempt(rlKey);
          return json({ error: "wrong_password" }, 401);
        }
      }

      if (!u.password.startsWith("pbkdf2$")) {
        const upgraded = await pbkdf2Hash(password);
        fetch(`${SB_URL}/rest/v1/team_users?id=eq.${encodeURIComponent(u.id)}`, {
          method: "PATCH",
          headers: sbHeaders({ Prefer: "return=minimal" }),
          body: JSON.stringify({ password: upgraded }),
        }).catch(() => {});
      }
      await clearRateLimit(rlKey);

      // Phase 3: this is the path a legacy account takes on every login
      // until it has a real Supabase Auth account - so this is where the
      // one-time (then never again, since the primary Supabase Auth login
      // succeeds from here on) migration happens, invisibly to the user.
      let session: { access_token: string; refresh_token: string; expires_in: number } | null = null;
      const authUserId = await ensureAuthUser(email, password, u.auth_user_id || null);
      if (authUserId && authUserId !== u.auth_user_id) {
        fetch(`${SB_URL}/rest/v1/team_users?id=eq.${encodeURIComponent(u.id)}`, {
          method: "PATCH",
          headers: sbHeaders({ Prefer: "return=minimal" }),
          body: JSON.stringify({ auth_user_id: authUserId }),
        }).catch(() => {});
      }
      if (authUserId) session = await passwordGrant(email, password);

      return json({ ok: true, wasPlaintext: isPlaintextMatch, ...(session || {}) });
    }

    // ---------------- LOOKUP INVITE (unauthenticated, by token) ----------------
    // The invite-registration page resolves a ?invite=<token> into the
    // pending member's name/email/role. Used to be a direct anon read of
    // team_users filtered by invite_token; that column is no longer
    // client-readable (2026-09-10). Returns only the display fields, and
    // only for a row that is genuinely still pending (active = false).
    if (action === "lookup_invite") {
      const inviteToken = String(body.inviteToken || body.token || "");
      if (!inviteToken) return json({ error: "missing_token" }, 400);
      const r = await fetch(
        `${SB_URL}/rest/v1/team_users?select=name,email,role,active&invite_token=eq.${encodeURIComponent(inviteToken)}&limit=1`,
        { headers: sbHeaders() },
      );
      const rows = await r.json();
      const pending = Array.isArray(rows) ? rows[0] : null;
      // An already-active member can get a fresh link (forgotten password) - activate_invite handles that case,
      // so an active row must not be rejected here (it sent them back to the login screen, 2026-11-02).
      // A consumed invite has its token cleared, so "token exists" is the validity check.
      if (!pending) return json({ error: "invalid_token" }, 404);
      return json({ ok: true, name: pending.name || "", email: pending.email || "", role: pending.role || "member" });
    }

    // ---------------- LOGIN LOOKUP (unauthenticated, by email) ----------------
    // 2026-09-11: team_users SELECT used to be USING(true) for {public} -
    // anyone with the anon key could dump the entire roster (name/email/
    // role/permissions for every member). Closing that (see
    // sql_migrations/2026-09-11_team_users_select_lockdown.sql) means the
    // pre-login screen (submitLogin's _tuByEmail, before any auth token
    // exists) can no longer read team_users directly - it needs this
    // instead. Returns the exact same non-secret column set the client
    // used to read directly (TU_SAFE_COLS in index.html), for ONE email
    // the caller already typed in - never the roster. Lightly rate-limited
    // (same mechanism as verify_password) so it can't be used to bulk-
    // enumerate valid emails.
    if (action === "login_lookup") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!email) return json({ error: "missing_email" }, 400);

      const rlKey = `team_lookup:${email}:${ip}`;
      const rl = await checkRateLimit(rlKey);
      if (!rl.ok) return json({ error: "rate_limited", retryAfterSec: rl.retryAfterSec }, 429);
      await recordAttempt(rlKey);

      const r = await fetch(
        `${SB_URL}/rest/v1/team_users?select=${SAFE_COLS.replace(",invite_token", "")}&email=eq.${encodeURIComponent(email)}&limit=1`,
        { headers: sbHeaders() },
      );
      const rows = await r.json().catch(() => []);
      const u = Array.isArray(rows) ? rows[0] : null;
      if (!u) return json({ ok: true, found: false });
      return json({ ok: true, found: true, user: u });
    }

    // ---------------- ACTIVATE INVITE ----------------
    if (action === "activate_invite") {
      const inviteToken = String(body.inviteToken || "");
      const name = String(body.name || "").trim();
      const password = String(body.password || "");
      if (!inviteToken || password.length < 6) return json({ error: "invalid_input" }, 400);

      const r = await fetch(`${SB_URL}/rest/v1/team_users?select=id,email,auth_user_id&invite_token=eq.${encodeURIComponent(inviteToken)}&limit=1`, {
        headers: sbHeaders(),
      });
      const rows = await r.json();
      const pending = Array.isArray(rows) ? rows[0] : null;
      if (!pending) return json({ error: "invalid_token" }, 400);

      const hash = await pbkdf2Hash(password);
      // An already-active member who gets a fresh invite link (forgotten password) HAS an Auth account:
      // pass its id so the Auth password is updated too and a real session comes back. With null this
      // tried to create a duplicate user, failed, and left the Auth password + session missing.
      const authUserId = await ensureAuthUser(pending.email, password, pending.auth_user_id || null);
      const patch: Record<string, unknown> = { name: name || undefined, password: hash, active: true, invite_token: null, last_login: new Date().toISOString() };
      if (authUserId) patch.auth_user_id = authUserId;
      const pr = await fetch(`${SB_URL}/rest/v1/team_users?id=eq.${encodeURIComponent(pending.id)}&select=${SAFE_COLS}`, {
        method: "PATCH",
        headers: sbHeaders({ Prefer: "return=representation" }),
        body: JSON.stringify(patch),
      });
      if (!pr.ok) return json({ error: "save_failed" }, 500);
      const updated = await pr.json();
      const session = authUserId ? await passwordGrant(pending.email, password) : null;
      return json({ ok: true, user: Array.isArray(updated) ? updated[0] : updated, ...(session || {}) });
    }

    // ---------------- ADMIN: CREATE MEMBER (also used for first-run setup) ----------------
    if (action === "admin_create_member") {
      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      const role = String(body.role || "member");
      const permissions = body.permissions || {};
      const useInvite = !!body.useInvite;
      const password = String(body.password || "");
      if (!email || !email.includes("@")) return json({ error: "invalid_email" }, 400);
      if (!useInvite && password.length < 6) return json({ error: "invalid_password" }, 400);
      // First admin (setup) is allowed with no caller; everything after
      // that requires a real team admin.
      if (await anyActiveAdminExists()) {
        if (!(await isCallerTeamAdmin(String(body.callerToken || "")))) {
          return json({ error: "forbidden" }, 403);
        }
      }

      const dupR = await fetch(`${SB_URL}/rest/v1/team_users?select=id&email=eq.${encodeURIComponent(email)}&limit=1`, {
        headers: sbHeaders(),
      });
      const dupRows = await dupR.json();
      if (Array.isArray(dupRows) && dupRows.length) return json({ error: "email_exists" }, 409);

      let inviteToken: string | null = null;
      let passwordVal: string;
      let authUserId: string | null = null;
      if (useInvite) {
        const tb = crypto.getRandomValues(new Uint8Array(24));
        inviteToken = Array.from(tb).map((b) => b.toString(16).padStart(2, "0")).join("");
        passwordVal = `__invite__${Date.now()}`;
        // No password yet (set at invite acceptance) - the Auth account gets
        // created there instead, in the activate_invite branch above.
      } else {
        passwordVal = await pbkdf2Hash(password);
        // We already know the real password here, so create the matching
        // Supabase Auth account immediately rather than waiting for their
        // first login to migrate it.
        authUserId = await ensureAuthUser(email, password, null);
      }

      const newUser: Record<string, unknown> = {
        id: "tu_" + Date.now(),
        name,
        email,
        password: passwordVal,
        role,
        permissions,
        active: !useInvite,
        created_at: new Date().toISOString(),
        last_login: useInvite ? null : new Date().toISOString(),
      };
      if (inviteToken) newUser.invite_token = inviteToken;
      if (authUserId) newUser.auth_user_id = authUserId;

      const cr = await fetch(`${SB_URL}/rest/v1/team_users?select=${SAFE_COLS}`, {
        method: "POST",
        headers: sbHeaders({ Prefer: "return=representation" }),
        body: JSON.stringify(newUser),
      });
      if (!cr.ok) {
        const t = await cr.text().catch(() => "");
        return json({ error: "save_failed", detail: t.slice(0, 300) }, 500);
      }
      const created = await cr.json();
      const row = Array.isArray(created) ? created[0] : created;
      const session = authUserId ? await passwordGrant(email, password) : null;
      return json({ ok: true, user: row, inviteToken, ...(session || {}) });
    }

    // ---------------- ADMIN: SET / RESET A MEMBER'S PASSWORD ----------------
    if (action === "admin_set_password") {
      const teamUserId = String(body.teamUserId || "");
      const password = String(body.password || "");
      if (!teamUserId || password.length < 6) return json({ error: "invalid_input" }, 400);
      if (!(await isCallerTeamAdmin(String(body.callerToken || "")))) return json({ error: "forbidden" }, 403);
      const hash = await pbkdf2Hash(password);

      // Keep the Supabase Auth mirror in sync too, so the member's next
      // login goes straight through the primary (real Auth) path instead
      // of falling back to legacy verification with their old password.
      const er = await fetch(`${SB_URL}/rest/v1/team_users?select=email,auth_user_id&id=eq.${encodeURIComponent(teamUserId)}&limit=1`, {
        headers: sbHeaders(),
      });
      const erows = await er.json().catch(() => []);
      const existing = Array.isArray(erows) ? erows[0] : null;
      const patch: Record<string, unknown> = { password: hash };
      if (existing && existing.email) {
        const authUserId = await ensureAuthUser(existing.email, password, existing.auth_user_id || null);
        if (authUserId && authUserId !== existing.auth_user_id) patch.auth_user_id = authUserId;
      }

      const pr = await fetch(`${SB_URL}/rest/v1/team_users?id=eq.${encodeURIComponent(teamUserId)}`, {
        method: "PATCH",
        headers: sbHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify(patch),
      });
      if (!pr.ok) return json({ error: "save_failed" }, 500);
      return json({ ok: true });
    }

    // ---------------- ADMIN: (RE)GENERATE A MEMBER'S INVITE LINK ----------------
    // Replaces the client's direct `PATCH {invite_token: ...}` - invite_token
    // is no longer a client-writable/readable column. Regenerating on every
    // "copy link" click is fine (and slightly better: the previous link dies).
    if (action === "admin_regenerate_invite") {
      const teamUserId = String(body.teamUserId || "");
      if (!teamUserId) return json({ error: "invalid_input" }, 400);
      if (!(await isCallerTeamAdmin(String(body.callerToken || "")))) return json({ error: "forbidden" }, 403);

      const tb = crypto.getRandomValues(new Uint8Array(24));
      const token = Array.from(tb).map((b) => b.toString(16).padStart(2, "0")).join("");
      const pr = await fetch(`${SB_URL}/rest/v1/team_users?id=eq.${encodeURIComponent(teamUserId)}`, {
        method: "PATCH",
        headers: sbHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify({ invite_token: token }),
      });
      if (!pr.ok) return json({ error: "save_failed" }, 500);
      return json({ ok: true, inviteToken: token });
    }

    // ---------------- 2FA: BEGIN SETUP (self-service, admin-only) ----------------
    // Resolves the caller's own row from their session token - never a
    // client-supplied id - so this can only ever act on the account making
    // the request. Generates a fresh secret and stores it with
    // totp_enabled still false; totp_setup_confirm below is what actually
    // turns it on, once the caller proves they can generate a real code
    // from it.
    if (action === "totp_setup_init") {
      const caller = await resolveCallerTeamUser(String(body.callerToken || ""));
      if (!caller) return json({ error: "forbidden" }, 403);
      if (caller.role !== "admin") return json({ error: "forbidden" }, 403);

      const secret = randomBase32Secret();
      const pr = await fetch(`${SB_URL}/rest/v1/team_users?id=eq.${encodeURIComponent(caller.id)}`, {
        method: "PATCH",
        headers: sbHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify({ totp_secret: secret, totp_enabled: false }),
      });
      if (!pr.ok) return json({ error: "save_failed" }, 500);

      const label = encodeURIComponent(`Keystone:${caller.email}`);
      const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=Keystone&algorithm=SHA1&digits=6&period=30`;
      return json({ ok: true, secret, otpauthUrl });
    }

    // ---------------- 2FA: CONFIRM SETUP ----------------
    if (action === "totp_setup_confirm") {
      const caller = await resolveCallerTeamUser(String(body.callerToken || ""));
      if (!caller) return json({ error: "forbidden" }, 403);
      if (caller.role !== "admin") return json({ error: "forbidden" }, 403);

      const rlKey = `team_totp:${caller.email}:${ip}`;
      const rl = await checkRateLimit(rlKey);
      if (!rl.ok) return json({ error: "rate_limited", retryAfterSec: rl.retryAfterSec }, 429);

      const sr = await fetch(`${SB_URL}/rest/v1/team_users?select=totp_secret&id=eq.${encodeURIComponent(caller.id)}&limit=1`, {
        headers: sbHeaders(),
      });
      const srows = await sr.json().catch(() => []);
      const secret = Array.isArray(srows) && srows[0] ? srows[0].totp_secret : null;
      if (!secret) return json({ error: "no_pending_setup" }, 400);

      if (!(await totpVerify(secret, String(body.code || "")))) {
        await recordAttempt(rlKey);
        return json({ error: "wrong_code" }, 401);
      }
      await clearRateLimit(rlKey);

      const pr = await fetch(`${SB_URL}/rest/v1/team_users?id=eq.${encodeURIComponent(caller.id)}`, {
        method: "PATCH",
        headers: sbHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify({ totp_enabled: true }),
      });
      if (!pr.ok) return json({ error: "save_failed" }, 500);
      return json({ ok: true });
    }

    // ---------------- 2FA: DISABLE (self-service, requires current password) ----------------
    if (action === "totp_disable") {
      const caller = await resolveCallerTeamUser(String(body.callerToken || ""));
      if (!caller) return json({ error: "forbidden" }, 403);

      const password = String(body.password || "");
      if (!password) return json({ error: "missing_fields" }, 400);
      let ok = false;
      if (caller.password && caller.password.startsWith("pbkdf2$")) ok = await pbkdf2Verify(password, caller.password);
      else if (caller.password && /^[a-f0-9]{64}$/i.test(caller.password)) ok = (await sha256hex(password)) === caller.password;
      else if (caller.password && caller.password === password) ok = true;
      if (!ok) return json({ error: "wrong_password" }, 401);

      const pr = await fetch(`${SB_URL}/rest/v1/team_users?id=eq.${encodeURIComponent(caller.id)}`, {
        method: "PATCH",
        headers: sbHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify({ totp_secret: null, totp_enabled: false }),
      });
      if (!pr.ok) return json({ error: "save_failed" }, 500);
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    console.error("team-auth error:", err);
    return json({ error: "server_error" }, 500);
  }
});
