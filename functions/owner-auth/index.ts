// RS Properties — Supabase Edge Function
// Server-side owner login + password-reset flow. Replaces direct anon-key
// access to owner_users.password_hash and owner_reset_tokens, which used to
// be fully world-readable/writable (open RLS policies) — anyone with the
// public anon key could dump every owner's password hash and every valid
// reset token, or overwrite a password directly. All of that now happens
// here with the service_role key, which the client never sees.
// Deploy: supabase functions deploy owner-auth

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function sbHeaders(extra?: Record<string, string>) {
  return Object.assign(
    {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    extra || {}
  );
}
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    headers: { ...CORS, "Content-Type": "application/json" },
    status,
  });
}

// ---------------- password hashing (PBKDF2, Web Crypto, no deps) ----------------
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

// ---------------- rate limiting (persisted, survives cold starts) ----------------
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

// ---------------- owner session token (HMAC-signed, no new secret needed) ----------------
// Owners have no Supabase Auth session, and get_reports is gated only by the
// username/email (an accepted trade-off for reports). The accounting ledger is
// more sensitive (itemised payments + balances), so it requires this short-lived
// token, issued only by a successful password login. The key is derived from the
// service-role key, which never leaves this function.
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
async function tokenKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("owner-session-v1:" + SERVICE_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}
function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): string {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}
async function hmacHex(data: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await tokenKey(), new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function issueOwnerToken(ownerId: string): Promise<string> {
  const p = b64url(JSON.stringify({ o: ownerId, e: Date.now() + TOKEN_TTL_MS }));
  return p + "." + (await hmacHex(p));
}
async function verifyOwnerToken(tok: string): Promise<string | null> {
  const parts = String(tok || "").split(".");
  if (parts.length !== 2) return null;
  if (!timingSafeEqual(await hmacHex(parts[0]), parts[1])) return null;
  try {
    const p = JSON.parse(unb64url(parts[0]));
    if (!p || !p.o || !p.e || p.e < Date.now()) return null;
    return String(p.o);
  } catch (_e) {
    return null;
  }
}
function ledgerMonthAdd(m: string, d: number): string {
  const [y, mo] = m.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1 + d, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();

    // ---------------- LOGIN ----------------
    if (action === "login") {
      const identifier = String(body.identifier || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!identifier || !password) return json({ error: "missing_fields" }, 400);

      const rlKey = `owner_login:${identifier}:${ip}`;
      const rl = await checkRateLimit(rlKey);
      if (!rl.ok) return json({ error: "rate_limited", retryAfterSec: rl.retryAfterSec }, 429);

      const r = await fetch(
        `${SB_URL}/rest/v1/owner_users?select=*&or=(username.ilike.${encodeURIComponent(identifier)},email.ilike.${encodeURIComponent(identifier)})`,
        { headers: sbHeaders() }
      );
      const rows = await r.json();
      const o = Array.isArray(rows) ? rows[0] : null;
      if (!o) {
        await recordAttempt(rlKey);
        return json({ error: "not_found" }, 401);
      }
      if (!o.password_hash) {
        await recordAttempt(rlKey);
        return json({ error: "no_password" }, 401);
      }

      let ok = false;
      if (o.password_hash.startsWith("pbkdf2$")) {
        ok = await pbkdf2Verify(password, o.password_hash);
      } else if (/^[a-f0-9]{64}$/i.test(o.password_hash)) {
        ok = (await sha256hex(password)) === o.password_hash;
      } // any other (legacy reversible-base64) format: reject, owner must reset

      if (!ok) {
        await recordAttempt(rlKey);
        return json({ error: "wrong_password" }, 401);
      }

      // Auto-upgrade to PBKDF2 on successful legacy login (self-healing,
      // same pattern already used elsewhere in this codebase).
      if (!o.password_hash.startsWith("pbkdf2$")) {
        const upgraded = await pbkdf2Hash(password);
        fetch(`${SB_URL}/rest/v1/owner_users?id=eq.${encodeURIComponent(o.id)}`, {
          method: "PATCH",
          headers: sbHeaders({ Prefer: "return=minimal" }),
          body: JSON.stringify({ password_hash: upgraded }),
        }).catch(() => {});
      }
      await clearRateLimit(rlKey);
      delete o.password_hash;
      return json({ ok: true, owner: o, token: await issueOwnerToken(String(o.id)) });
    }

    // ---------------- GET OWNER'S REPORTS ----------------
    // Added 2026-09-09: the owner portal used to read `/rest/v1/reports`
    // straight with the anon key. Phase 3 (2026-09-07) locked that table's
    // RLS to auth.uid()-based team permissions, which the anon key never
    // has - every owner has been getting an empty "No reports yet" screen
    // since, not just the one who happened to report it. Owners have no
    // Supabase Auth session at all (separate owner_users/PBKDF2 system), so
    // this reads reports here with the service role instead, gated by
    // `identifier` the same way request_reset already is (username/email,
    // no password re-check) - a known, accepted trade-off in this file
    // rather than a new session-token system for a same-day fix.
    if (action === "get_reports") {
      const identifier = String(body.identifier || "").trim().toLowerCase();
      if (!identifier) return json({ error: "missing_fields" }, 400);

      const or = await fetch(
        `${SB_URL}/rest/v1/owner_users?select=id,property_ids&or=(username.ilike.${encodeURIComponent(identifier)},email.ilike.${encodeURIComponent(identifier)})`,
        { headers: sbHeaders() }
      );
      const orows = await or.json();
      const o = Array.isArray(orows) ? orows[0] : null;
      const propIds: string[] = o && Array.isArray(o.property_ids) ? o.property_ids : [];
      // No account, or an account with no properties assigned yet -> empty,
      // never fall back to showing the full portfolio.
      if (!o || !propIds.length) return json({ ok: true, reports: [] });

      const rr = await fetch(`${SB_URL}/rest/v1/reports?select=data&order=saved_at.desc`, {
        headers: sbHeaders(),
      });
      if (!rr.ok) return json({ error: "load_failed" }, 500);
      const rrows = await rr.json();
      const reports = (Array.isArray(rrows) ? rrows : [])
        .map((row: any) => row.data)
        .filter(
          (rep: any) =>
            rep &&
            rep.published &&
            (propIds.indexOf(rep.propId) >= 0 || propIds.indexOf(rep.propName) >= 0)
        );
      // Internal-only fields on expense/income lines (what we paid + our margin, copied there from Quick Log
      // by older versions of the admin app) must never reach an owner's browser.
      const INTERNAL = ["realAmount", "marginPct"];
      for (const rep of reports as any[]) {
        for (const k of ["otherExpenses", "otherIncome"]) {
          if (!Array.isArray(rep[k])) continue;
          rep[k] = rep[k].map((it: any) => {
            if (!it || typeof it !== "object") return it;
            const c = { ...it };
            for (const f of INTERNAL) delete c[f];
            // Files the team marked "internal only" (e.g. a supplier invoice that shows our purchase price) are removed here, not just hidden in the page.
            if (Array.isArray(c.files)) c.files = c.files.filter((f: any) => !(f && f.internal));
            return c;
          });
        }
      }
      return json({ ok: true, reports });
    }

    // ---------------- GET OWNER'S ACCOUNTING LEDGER (published months only) ----------------
    // Requires the signed token from a real password login (see issueOwnerToken).
    // Returns, per property assigned to this owner, ONLY the months an admin
    // explicitly published (ledger_publications) - with the carried balance
    // computed here from every earlier month, so the owner sees a number that
    // matches the admin's book without ever receiving the unpublished rows.
    if (action === "get_ledger") {
      const oid = await verifyOwnerToken(String(body.token || ""));
      if (!oid) return json({ error: "bad_token" }, 401);
      const gj = async (path: string) => {
        const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders() });
        if (!r.ok) throw new Error(`${path} ${r.status}`);
        return r.json();
      };
      try {
        const orows = await gj(`owner_users?select=id,name,property_ids&id=eq.${encodeURIComponent(oid)}`);
        const o = Array.isArray(orows) ? orows[0] : null;
        const mineIds: string[] = o && Array.isArray(o.property_ids) ? o.property_ids.map((x: unknown) => String(x).trim()) : [];
        if (!o || !mineIds.length) return json({ ok: true, ownerName: o ? o.name : "", properties: [] });

        const settings = await gj("ledger_settings?select=*");
        const mine = (Array.isArray(settings) ? settings : []).filter(
          (s: any) => mineIds.indexOf(String(s.property_id).trim()) >= 0 || mineIds.indexOf(String(s.property_name || "").trim()) >= 0
        );
        const properties: any[] = [];
        for (const s of mine) {
          const pid = encodeURIComponent(s.property_id);
          const pubs = await gj(`ledger_publications?select=month&property_id=eq.${pid}`);
          const pubMonths: string[] = (Array.isArray(pubs) ? pubs : []).map((p: any) => p.month).sort();
          if (!pubMonths.length) continue;
          const res = await gj(`ledger_reservations?select=*&property_id=eq.${pid}&order=checkin`);
          const ent = await gj(`ledger_entries?select=*&property_id=eq.${pid}&order=created_at`);
          const sum = (m: string) => {
            let revenue = 0, expenses = 0, credit = 0, missing = 0;
            for (const r of res) if (r.month === m) { if (r.payout == null) missing++; else revenue += Number(r.payout); }
            for (const e of ent) if (e.month === m) { if (e.kind === "credit") credit += Number(e.amount); else expenses += Number(e.amount); }
            return { revenue, expenses, credit, missing };
          };
          const months = pubMonths.map((m) => {
            let prev = 0;
            if (m >= s.start_month) {
              prev = Number(s.opening_balance) || 0;
              let cur = s.start_month, guard = 0;
              while (cur < m && guard++ < 240) { const t = sum(cur); prev += t.expenses - t.credit; cur = ledgerMonthAdd(cur, 1); }
            }
            const t = sum(m);
            const item = (e: any) => ({ date: e.entry_date, category: e.category, note: e.note, amount: Number(e.amount), auto: e.source === "auto_provision" });
            return {
              month: m,
              prevBalance: prev,
              revenue: t.revenue,
              expenses: t.expenses,
              credit: t.credit,
              result: t.revenue - t.expenses,
              toPay: prev + t.expenses - t.credit,
              missingPayouts: t.missing,
              reservations: res.filter((r: any) => r.month === m).map((r: any) => ({ checkin: r.checkin, checkout: r.checkout, channel: r.channel, payout: r.payout == null ? null : Number(r.payout) })),
              credits: ent.filter((e: any) => e.month === m && e.kind === "credit").map(item),
              expenseItems: ent.filter((e: any) => e.month === m && e.kind === "expense").map(item),
            };
          }).sort((a: any, b: any) => b.month.localeCompare(a.month));
          properties.push({ property_id: s.property_id, name: String(s.property_name || "").trim(), currency: s.currency || "€", months });
        }
        return json({ ok: true, ownerName: o.name || "", properties });
      } catch (e) {
        console.error("get_ledger error:", e);
        return json({ error: "load_failed" }, 500);
      }
    }

    // ---------------- REQUEST PASSWORD RESET ----------------
    // Used both by the owner portal's own "Forgot password?" link and by
    // the admin app's "send setup link" button (identifier = the owner's
    // known username in that case). Always responds { ok:true } regardless
    // of whether an account was found, to avoid leaking which usernames/
    // emails exist.
    if (action === "request_reset") {
      const identifier = String(body.identifier || "").trim().toLowerCase();
      const sendEmail = body.sendEmail !== false;
      const returnLink = !!body.returnLink;
      if (!identifier) return json({ error: "missing_fields" }, 400);

      const rlKey = `owner_reset_req:${identifier}:${ip}`;
      const rl = await checkRateLimit(rlKey);
      let link: string | null = null;

      if (rl.ok) {
        const r = await fetch(
          `${SB_URL}/rest/v1/owner_users?select=id,name,email,username&or=(username.ilike.${encodeURIComponent(identifier)},email.ilike.${encodeURIComponent(identifier)})`,
          { headers: sbHeaders() }
        );
        const rows = await r.json();
        const o = Array.isArray(rows) ? rows[0] : null;
        if (o) {
          const tokenBytes = crypto.getRandomValues(new Uint8Array(24));
          const token = Array.from(tokenBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
          const expiresAt = new Date(Date.now() + 48 * 3600000).toISOString();
          const tokIns = await fetch(`${SB_URL}/rest/v1/owner_reset_tokens`, {
            method: "POST",
            headers: sbHeaders({ Prefer: "return=minimal" }),
            body: JSON.stringify({ token, owner_id: o.id, username: o.username, expires_at: expiresAt, used: false }),
          });
          if (!tokIns.ok) {
            const errBody = await tokIns.text().catch(() => "");
            console.error(
              "owner-auth: token insert failed",
              tokIns.status,
              errBody,
              "SERVICE_KEY present:", !!SERVICE_KEY, "len:", SERVICE_KEY ? SERVICE_KEY.length : 0
            );
            return json({ error: "token_save_failed", detail: errBody.slice(0, 300) }, 500);
          }
          await recordAttempt(rlKey);
          const portalUrl = String(body.portalUrl || "");
          link = `${portalUrl}${portalUrl.includes("?") ? "&" : "?"}setup_token=${token}`;
          if (sendEmail && o.email) {
            fetch(`${SB_URL}/functions/v1/send-welcome-email`, {
              method: "POST",
              headers: sbHeaders(),
              body: JSON.stringify({
                to: o.email,
                ownerName: o.name || "",
                company: String(body.company || "RS Properties"),
                portalUrl,
                username: o.username,
                setupLink: link,
                expiresHours: 48,
                compEmail: String(body.compEmail || "info@rsproperties.sk"),
                compWeb: String(body.compWeb || ""),
              }),
            }).catch(() => {});
          }
        } else {
          await recordAttempt(rlKey);
        }
      }
      return json({ ok: true, link: returnLink ? link : undefined });
    }

    // ---------------- VERIFY RESET TOKEN ----------------
    if (action === "verify_reset_token") {
      const token = String(body.token || "");
      if (!token) return json({ valid: false, reason: "missing" });
      const r = await fetch(`${SB_URL}/rest/v1/owner_reset_tokens?select=*&token=eq.${encodeURIComponent(token)}`, {
        headers: sbHeaders(),
      });
      const rows = await r.json();
      const tok = Array.isArray(rows) ? rows[0] : null;
      if (!tok) return json({ valid: false, reason: "invalid" });
      if (tok.used) return json({ valid: false, reason: "used" });
      if (new Date(tok.expires_at) < new Date()) return json({ valid: false, reason: "expired" });

      const or2 = await fetch(`${SB_URL}/rest/v1/owner_users?select=name,username&id=eq.${encodeURIComponent(tok.owner_id)}`, {
        headers: sbHeaders(),
      });
      const orows = await or2.json();
      const owner = Array.isArray(orows) ? orows[0] : null;
      return json({ valid: true, ownerName: (owner && owner.name) || tok.username });
    }

    // ---------------- SET NEW PASSWORD (consumes the token) ----------------
    if (action === "set_password") {
      const token = String(body.token || "");
      const newPassword = String(body.newPassword || "");
      if (!token || newPassword.length < 6) return json({ error: "invalid_input" }, 400);

      const r = await fetch(`${SB_URL}/rest/v1/owner_reset_tokens?select=*&token=eq.${encodeURIComponent(token)}`, {
        headers: sbHeaders(),
      });
      const rows = await r.json();
      const tok = Array.isArray(rows) ? rows[0] : null;
      if (!tok) return json({ error: "invalid" }, 400);
      if (tok.used) return json({ error: "used" }, 400);
      if (new Date(tok.expires_at) < new Date()) return json({ error: "expired" }, 400);

      const hash = await pbkdf2Hash(newPassword);
      const pr = await fetch(`${SB_URL}/rest/v1/owner_users?id=eq.${encodeURIComponent(tok.owner_id)}`, {
        method: "PATCH",
        headers: sbHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify({ password_hash: hash }),
      });
      if (!pr.ok) return json({ error: "save_failed" }, 500);

      await fetch(`${SB_URL}/rest/v1/owner_reset_tokens?token=eq.${encodeURIComponent(token)}`, {
        method: "PATCH",
        headers: sbHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify({ used: true }),
      });
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    console.error("owner-auth error:", err);
    return json({ error: "server_error" }, 500);
  }
});
