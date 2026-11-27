// RS Properties / Keystone - mail-reply: request handler (I/O injected).
// Actions (POST, Authorization: Bearer <team member token>, requires 'bizdev' edit or admin):
//   {action:"draft", mail_id}                        -> {ok, to, subject, body, placeholders}   Claude writes a draft (nothing is stored or sent)
//   {action:"send",  mail_id, subject, body}         -> {ok}                                    sends via Resend from info@ to the ORIGINAL SENDER only
// The recipient is never taken from the request: it is always the sender of the stored incoming mail. A copy (bcc) goes to info@.
// NOTE: keep this file plain ASCII.

import { draftSystem, draftUser, parseDraft, validateSend, composeText, threadHeaders } from "./core.mjs";

const JH = { "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const TEAM = "info@rsproperties.sk";

export function createReplyHandler({ env, fetchFn = fetch, now = () => new Date(), uuid = () => crypto.randomUUID() }) {
  const SB_URL = env.SUPABASE_URL || "", SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || "";
  const sb = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...JH });
  const out = (o, status = 200) => new Response(JSON.stringify(o), { headers: { ...JH, ...CORS }, status });
  const FROM = env.MAIL_REPLY_FROM || `RS Properties <${TEAM}>`;

  async function caller(req) {
    const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!tok || tok === SERVICE_KEY) return null;
    const ur = await fetchFn(`${SB_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${tok}` } });
    if (!ur.ok) return null;
    const uid = (await ur.json())?.id; if (!uid) return null;
    // permission is decided by the database function (admin or bizdev=edit), evaluated as this user
    const pr = await fetchFn(`${SB_URL}/rest/v1/rpc/mail_inbox_can_edit`, { method: "POST", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${tok}`, ...JH }, body: "{}" });
    if (!pr.ok || (await pr.json().catch(() => false)) !== true) return null;
    const tr = await fetchFn(`${SB_URL}/rest/v1/team_users?select=name,email&auth_user_id=eq.${encodeURIComponent(uid)}&limit=1`, { headers: sb() });
    const t = (await tr.json().catch(() => []))?.[0] || {};
    return { uid, name: String(t.name || t.email || "").slice(0, 100) };
  }

  const getRows = async (path) => { const r = await fetchFn(`${SB_URL}/rest/v1/${path}`, { headers: sb() }); const j = await r.json().catch(() => []); return Array.isArray(j) ? j : []; };

  async function claude(system, user, model) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 90000);
    try {
      const res = await fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: ctl.signal,
        headers: { "x-api-key": env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01", ...JH },
        body: JSON.stringify({ model, max_tokens: 1200, system, messages: [{ role: "user", content: user }] }),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok && !data?.error, status: res.status, type: String(data?.error?.type || ""), text: String(data?.content?.[0]?.text || "") };
    } finally { clearTimeout(timer); }
  }

  return async function handle(req) {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return out({ error: "method_not_allowed" }, 405);
    let b; try { b = await req.json(); } catch { return out({ error: "bad_json" }, 400); }
    const who = await caller(req);
    if (!who) return out({ error: "forbidden" }, 403);

    const id = Number(b?.mail_id);
    if (!Number.isInteger(id) || id <= 0) return out({ error: "bad_mail_id" }, 400);
    const row = (await getRows(`mail_messages?select=*&id=eq.${id}&limit=1`))[0];
    if (!row || row.direction !== "in") return out({ error: "mail_not_found" }, 404);

    if (b.action === "draft") {
      const orFilter = [row.lead_id ? `lead_id.eq.${row.lead_id}` : "", `from_email.eq.${row.from_email}`, `to_email.eq.${row.from_email}`].filter(Boolean).join(",");
      const thread = await getRows(`mail_messages?select=direction,received_at,subject,body&or=(${encodeURIComponent(orFilter)})&order=received_at.desc&limit=8`);
      const style = await getRows(`mail_messages?select=body&direction=eq.out&intent=eq.sent&order=received_at.desc&limit=3`);
      const wr = await getRows(`workspace?select=value&key=eq.bizLeads&limit=1`);
      const lead = row.lead_id && Array.isArray(wr?.[0]?.value) ? wr[0].value.find((l) => String(l.id) === row.lead_id) : null;
      const system = draftSystem(), user = draftUser(row, lead, thread, style);
      let r = await claude(system, user, env.MAIL_DRAFT_MODEL || "claude-sonnet-5-5");
      if (!r.ok && (r.type === "not_found_error" || r.status === 404)) r = await claude(system, user, env.AGENT_BRIEFING_MODEL || "claude-haiku-4-5-20251001");
      if (!r.ok) return out({ error: "draft_failed", detail: `anthropic_${r.status}:${r.type}` }, 502);
      const d = parseDraft(r.text, row);
      if (!d) return out({ error: "bad_model_output" }, 502);
      return out({ ok: true, to: row.from_email, subject: d.subject, body: d.body, placeholders: /\[\s*DOPLNI/i.test(d.body) });
    }

    if (b.action === "send") {
      const bad = validateSend({ subject: b.subject, body: b.body });
      if (bad) return out({ error: bad }, 400);
      // no double send (double click / two people): same incoming mail answered from the app in the last 5 minutes
      const since = new Date(now().getTime() - 5 * 60000).toISOString();
      const dup = await getRows(`mail_messages?select=id&direction=eq.out&intent=eq.sent_ui&in_reply_to=eq.${encodeURIComponent(row.message_id)}&created_at=gte.${encodeURIComponent(since)}&limit=1`);
      if (dup.length) return out({ error: "already_sent" }, 409);
      const hourAgo = new Date(now().getTime() - 3600000).toISOString();
      const recent = await getRows(`mail_messages?select=id&direction=eq.out&intent=eq.sent_ui&created_at=gte.${encodeURIComponent(hourAgo)}&limit=21`);
      if (recent.length >= 20) return out({ error: "rate_limited" }, 429);

      const subject = String(b.subject).trim(), body = String(b.body).replace(/\r/g, "").trim();
      const rr = await fetchFn("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY || ""}`, ...JH },
        body: JSON.stringify({ from: FROM, to: [row.from_email], bcc: [TEAM], reply_to: TEAM, subject, text: composeText(body, row), headers: threadHeaders(row) }),
      });
      const rj = await rr.json().catch(() => null);
      // best-effort Email Log entry (same table as the other transactional mails)
      await fetchFn(`${SB_URL}/rest/v1/email_log`, { method: "POST", headers: { ...sb(), Prefer: "return=minimal" },
        body: JSON.stringify({ to_addr: row.from_email, subject, template: "mail_reply", resend_id: rr.ok && rj?.id ? rj.id : null, status: rr.ok && rj?.id ? "accepted" : "failed",
          error: rr.ok && rj?.id ? null : JSON.stringify(rj?.error ?? rj ?? `HTTP ${rr.status}`).slice(0, 400), meta: { mail_id: id, by: who.name } }) }).catch(() => {});
      if (!rr.ok || !rj?.id) return out({ error: "send_failed", detail: String(rj?.message || rj?.error?.message || `HTTP ${rr.status}`).slice(0, 120) }, 502);

      const orec = { message_id: `<ui-${uuid()}@rsproperties.sk>`, in_reply_to: row.message_id, direction: "out", from_email: TEAM, from_name: "RS Properties", to_email: row.from_email,
        subject, received_at: now().toISOString(), body, match_kind: row.match_kind, lead_id: row.lead_id, match_name: row.match_name,
        classified: true, intent: "sent_ui", needs_reply: false, urgency: "low", suggested: {}, status: "handled", handled_by: who.name };
      await fetchFn(`${SB_URL}/rest/v1/rpc/mail_put`, { method: "POST", headers: sb(), body: JSON.stringify({ p: orec }) }).catch(() => {});
      await fetchFn(`${SB_URL}/rest/v1/mail_messages?id=eq.${id}`, { method: "PATCH", headers: { ...sb(), Prefer: "return=minimal" },
        body: JSON.stringify({ status: "handled", handled_by: `${who.name} (odpoved odoslana)`, handled_at: now().toISOString() }) }).catch(() => {});
      return out({ ok: true, id: rj.id });
    }
    return out({ error: "bad_action" }, 400);
  };
}
