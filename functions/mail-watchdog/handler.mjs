// RS Properties / Keystone - mail-watchdog: request handler (I/O injected, testable in Node).
// Called by pg_cron every 15 min (service role bearer). Reads the poller heartbeat + the number of unclassified incoming mails,
// and e-mails info@ when the mail sync stands still / keeps failing / Claude does not classify (see core.mjs for the rules).
// Body {dry:true} -> computes and returns the plan, sends nothing and writes nothing.
// NOTE: keep this file plain ASCII.

import { assess, plan, alertMail, CLASSIFY_MIN } from "./core.mjs";

const JH = { "Content-Type": "application/json" };
const TEAM = "info@rsproperties.sk";

function jwtRole(tok) {
  try { return JSON.parse(atob(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role || ""; } catch { return ""; }
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function createWatchdogHandler({ env, fetchFn = fetch, now = () => new Date() }) {
  const SB_URL = env.SUPABASE_URL || "", SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || "";
  const sb = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...JH });
  const out = (o, status = 200) => new Response(JSON.stringify(o), { headers: JH, status });
  const FROM = env.MAIL_ALERT_FROM || `RS Properties <${TEAM}>`;

  async function send(kind, status, a) {
    const m = alertMail(kind, status, a);
    const rr = await fetchFn("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY || ""}`, ...JH },
      body: JSON.stringify({ from: FROM, to: [TEAM], subject: m.subject, text: m.text }),
    });
    const rj = await rr.json().catch(() => null);
    const ok = rr.ok && !!rj?.id;
    await fetchFn(`${SB_URL}/rest/v1/email_log`, { method: "POST", headers: { ...sb(), Prefer: "return=minimal" },
      body: JSON.stringify({ to_addr: TEAM, subject: m.subject, template: "mail_watchdog", resend_id: ok ? rj.id : null, status: ok ? "accepted" : "failed",
        error: ok ? null : JSON.stringify(rj?.error ?? rj ?? `HTTP ${rr.status}`).slice(0, 400), meta: { kind } }) }).catch(() => {});
    return ok;
  }

  return async function handle(req) {
    if (req.method !== "POST" && req.method !== "GET") return out({ error: "method_not_allowed" }, 405);
    const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!tok || !(safeEqual(tok, SERVICE_KEY) || jwtRole(tok) === "service_role")) return out({ error: "forbidden" }, 403);
    let b = {}; if (req.method === "POST") { try { b = await req.json(); } catch { b = {}; } }
    const dry = b?.dry === true;
    const t = now();

    const sr = await fetchFn(`${SB_URL}/rest/v1/mail_poller_status?id=eq.1&select=*`, { headers: sb() });
    const sj = await sr.json().catch(() => []);
    if (!sr.ok || !Array.isArray(sj)) return out({ error: "status_read_failed" }, 502);
    const status = sj[0] || null;
    if (!status) return out({ error: "no_status_row" }, 500);

    const cutoff = new Date(t.getTime() - CLASSIFY_MIN * 60000).toISOString();
    const ur = await fetchFn(`${SB_URL}/rest/v1/mail_messages?select=id&direction=eq.in&classified=eq.false&status=eq.new&created_at=lt.${encodeURIComponent(cutoff)}&limit=100`, { headers: sb() });
    const uj = await ur.json().catch(() => []);
    const unclassified = ur.ok && Array.isArray(uj) ? uj.length : 0;

    const a = assess(status, unclassified, t);
    const acts = plan(status, a, t);
    if (dry) return out({ ok: true, dry: true, assess: a, actions: acts });

    const patch = {};
    const sent = [];
    for (const kind of acts) {
      const ok = await send(kind, status, a);
      sent.push({ kind, ok });
      if (!ok) continue;                                     // not marked -> retried at the next run
      if (kind === "sync_alert") patch.stale_alerted_at = t.toISOString();
      if (kind === "sync_recovered") patch.stale_alerted_at = null;
      if (kind === "classify_alert") patch.classify_alerted_at = t.toISOString();
      if (kind === "classify_recovered") patch.classify_alerted_at = null;
    }
    if (Object.keys(patch).length) {
      await fetchFn(`${SB_URL}/rest/v1/mail_poller_status?id=eq.1`, { method: "PATCH", headers: { ...sb(), Prefer: "return=minimal" }, body: JSON.stringify(patch) }).catch(() => {});
    }
    return out({ ok: true, assess: a, actions: acts, sent });
  };
}
