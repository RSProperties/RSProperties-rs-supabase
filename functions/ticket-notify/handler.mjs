// RS Properties / Keystone - ticket-notify: request handler (I/O injected, testable in Node).
// Called with the SERVICE ROLE bearer only (DB trigger on ticket_events, pg_cron). Two jobs:
//   {event_id}                -> e-mail the people concerned by this ticket event (see core.recipientsFor)
//   {digest:true, dry?:true}  -> daily follow-up digest (assignees: their due tickets; admins: + what slips through)
// NOTE: keep this file plain ASCII.

import { recipientsFor, buildEventEmail, buildDigests, buildDigestEmail, todayLocal, CLOSED, normEmail } from "./core.mjs";

const JH = { "Content-Type": "application/json" };

function jwtRole(tok) {
  try { return JSON.parse(atob(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role || ""; } catch { return ""; }
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function createNotifyHandler({ env, fetchFn = fetch, now = () => new Date() }) {
  const SB_URL = env.SUPABASE_URL || "", SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || "";
  const sb = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...JH });
  const out = (o, status = 200) => new Response(JSON.stringify(o), { headers: JH, status });
  const FROM = env.MAIL_ALERT_FROM || "RS Properties <info@rsproperties.sk>";
  const APP = env.APP_URL || "https://app.rsproperties.sk/";
  const get = async (path) => { const r = await fetchFn(`${SB_URL}/rest/v1/${path}`, { headers: sb() }); const j = await r.json().catch(() => null); return r.ok && Array.isArray(j) ? j : null; };

  // current property names (tickets hold the property ID; a rename must show up in e-mails too)
  async function propNames() {
    const rows = await get("workspace?select=value&key=eq.properties");
    const arr = rows && rows[0] && Array.isArray(rows[0].value) ? rows[0].value : [];
    const m = new Map(); for (const p of arr) if (p && p.id) m.set(String(p.id), String(p.name || "")); return m;
  }
  const named = (t, names) => (t && t.property_id && names.get(String(t.property_id))) ? { ...t, property_name: names.get(String(t.property_id)) } : t;

  async function people() {
    const rows = await get("team_users?select=id,name,email,role,permissions,active&active=eq.true");
    if (!rows) return null;
    return rows.filter((t) => t.email && !["technician", "cleaner", "owner"].includes(t.role)).map((t) => {
      let perms = t.permissions; if (typeof perms === "string") { try { perms = JSON.parse(perms); } catch { perms = {}; } }
      return { id: String(t.id), name: t.name || t.email, email: t.email, role: t.role, lang: perms && perms.lang === "en" ? "en" : "sk" };
    });
  }

  async function send(to, mail, template, meta) {
    const rr = await fetchFn("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY || ""}`, ...JH },
      body: JSON.stringify({ from: FROM, to: [to], subject: mail.subject, text: mail.text, html: mail.html }),
    });
    const rj = await rr.json().catch(() => null);
    const ok = rr.ok && !!rj?.id;
    await fetchFn(`${SB_URL}/rest/v1/email_log`, { method: "POST", headers: { ...sb(), Prefer: "return=minimal" },
      body: JSON.stringify({ to_addr: to, subject: mail.subject, template, resend_id: ok ? rj.id : null, status: ok ? "accepted" : "failed",
        error: ok ? null : JSON.stringify(rj?.error ?? rj ?? `HTTP ${rr.status}`).slice(0, 400), meta }) }).catch(() => {});
    return ok;
  }

  return async function handle(req) {
    if (req.method !== "POST") return out({ error: "method_not_allowed" }, 405);
    const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!tok || !(safeEqual(tok, SERVICE_KEY) || jwtRole(tok) === "service_role")) return out({ error: "forbidden" }, 403);
    let b; try { b = await req.json(); } catch { return out({ error: "bad_json" }, 400); }
    const team = await people();
    if (!team) return out({ error: "people_failed" }, 502);

    if (b && b.digest === true) {
      const today = todayLocal(now()), dry = b.dry === true;
      const rows = await get("tickets?select=*&status=not.in.(" + CLOSED.join(",") + ")&limit=1000");
      if (!rows) return out({ error: "tickets_failed" }, 502);
      const names = await propNames();
      const digests = buildDigests(rows.map((t) => named(t, names)), team, today);
      if (dry) return out({ ok: true, dry: true, today, open: rows.length, digests: digests.map((d) => ({ to: d.person.email, mine: d.mine.map((t) => t.ticket_no), overview: d.overview.map((t) => t.ticket_no) })) });
      const sent = [];
      for (const d of digests) sent.push({ to: d.person.email, ok: await send(d.person.email, buildDigestEmail(d, today, APP), "ticket_digest", { mine: d.mine.length, overview: d.overview.length }) });
      return out({ ok: true, today, sent });
    }

    const id = Number(b && b.event_id);
    if (!Number.isInteger(id) || id <= 0) return out({ error: "bad_request" }, 400);
    const ev = (await get(`ticket_events?select=*&id=eq.${id}&limit=1`) || [])[0];
    if (!ev) return out({ error: "event_not_found" }, 404);
    const ticket = (await get(`tickets?select=*&id=eq.${ev.ticket_id}&limit=1`) || [])[0];
    if (!ticket) return out({ error: "ticket_not_found" }, 404);
    const to = recipientsFor(ev.kind, ticket, ev, team);
    const shown = named(ticket, await propNames());
    const sent = [];
    for (const p of to) sent.push({ to: normEmail(p.email), ok: await send(p.email, buildEventEmail(ev.kind, shown, ev, p.lang, APP), "ticket_event", { ticket: ticket.ticket_no, kind: ev.kind }) });
    return out({ ok: true, kind: ev.kind, ticket: ticket.ticket_no, sent });
  };
}
