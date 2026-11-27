// RS Properties / Keystone - mail-ingest: request handler (I/O injected, so it is testable in Node without Deno).
// Phase 1 is READ-ONLY towards clients: nothing is ever sent, no lead is changed. It only stores a classified copy of mails
// that came from KNOWN contacts (lead contact e-mail / owner e-mail).
// Actions (POST, header x-agent-key = secret AGENT_INGEST_KEY):
//   {action:"match",  emails:[...]}            -> {known:[...]}            which senders are known contacts (poller sends bodies only for those)
//   {action:"ingest", mails:[...], dry?:true}  -> {ok, stored, ...}        classify + store (dry = classify only, nothing stored)
// NOTE: keep this file plain ASCII.

import {
  normEmail, isAutomatedAddress, isOwnAddress, buildContactIndex, pickMatch, stripQuoted, cleanAttachments,
  classifySystem, classifyUser, parseClassification,
} from "./core.mjs";

const JH = { "Content-Type": "application/json" };
const trunc = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, n);

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function createHandler({ env, fetchFn = fetch, now = () => new Date() }) {
  const SB_URL = env.SUPABASE_URL || "";
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || "";
  const INGEST_KEY = env.AGENT_INGEST_KEY || "";
  const MODEL = env.MAIL_CLASSIFY_MODEL || env.AGENT_BRIEFING_MODEL || "claude-haiku-4-5-20251001";
  const sb = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...JH });
  const out = (o, status = 200) => new Response(JSON.stringify(o), { headers: JH, status });

  async function loadContacts() {
    const r = await fetchFn(`${SB_URL}/rest/v1/workspace?select=key,value&key=in.(bizLeads,owners)`, { headers: sb() });
    const rows = await r.json().catch(() => []);
    const get = (k) => { const row = Array.isArray(rows) ? rows.find((x) => x.key === k) : null; return Array.isArray(row && row.value) ? row.value : []; };
    const leads = get("bizLeads"), owners = get("owners");
    // addresses the team assigned to a lead / owner in Keystone ("Neznami odosielatelia"); a failure here must not stop the mail flow
    let aliases = [];
    try {
      const ar = await fetchFn(`${SB_URL}/rest/v1/mail_aliases?select=email,kind,ref_id&limit=1000`, { headers: sb() });
      const aj = await ar.json().catch(() => []);
      if (ar.ok && Array.isArray(aj)) aliases = aj;
    } catch { /* ignore */ }
    return { leads, owners, idx: buildContactIndex(leads, owners, aliases) };
  }
  const rpc = async (name, args) => {
    const r = await fetchFn(`${SB_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: sb(), body: JSON.stringify(args ?? {}) });
    const j = await r.json().catch(() => null);
    return { ok: r.ok, j };
  };

  async function classify(match, lead, mail, today) {
    const isCompany = !!lead && lead.type === "company";
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    let res;
    try {
      res = await fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: ctl.signal,
        headers: { "x-api-key": env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01", ...JH },
        body: JSON.stringify({ model: MODEL, max_tokens: 700, system: classifySystem(isCompany), messages: [{ role: "user", content: classifyUser(match, lead, mail, today) }] }),
      });
    } finally { clearTimeout(timer); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) throw new Error("anthropic_" + res.status + ":" + String(data?.error?.type || "").slice(0, 40) + ":" + String(data?.error?.message || "").slice(0, 110));
    const parsed = parseClassification(String(data?.content?.[0]?.text || ""), isCompany);
    if (!parsed) throw new Error("bad_model_output");
    return parsed;
  }

  return async function handle(req) {
    if (req.method !== "POST") return out({ error: "method_not_allowed" }, 405);
    if (!INGEST_KEY || INGEST_KEY.length < 24) return out({ error: "not_configured" }, 503);
    if (!safeEqual(req.headers.get("x-agent-key") || "", INGEST_KEY)) return out({ error: "forbidden" }, 403);

    const raw = await req.text();
    if (raw.length > 600_000) return out({ error: "too_large" }, 413);
    let b;
    try { b = JSON.parse(raw); } catch { return out({ error: "bad_json" }, 400); }

    // heartbeat of the poller (before contacts are loaded: it must work even if the workspace read fails)
    if (b?.action === "heartbeat") {
      const hb = await rpc("mail_poller_beat", { p: {
        ok: b.ok === true, error: trunc(b.error, 300), classify_error: trunc(b.classify_error, 300),
        counts: b.counts && typeof b.counts === "object" && !Array.isArray(b.counts)
          ? Object.fromEntries(Object.entries(b.counts).slice(0, 20).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [trunc(k, 30), Number(v)]))
          : {},
      } });
      return hb.ok ? out({ ok: true }) : out({ error: "heartbeat_failed" }, 502);
    }
    if (b?.action === "refetch_list") {
      const rl = await rpc("mail_unknown_refetch_list", {});
      const rows = Array.isArray(rl.j) ? rl.j : [];
      return out({ ok: true, senders: rows.slice(0, 20).map((r) => ({ email: normEmail(r.email), since: trunc(r.since, 40) })) });
    }
    if (b?.action === "refetch_done") {
      const em = normEmail(trunc(b.email, 200));
      if (!em) return out({ error: "bad_email" }, 400);
      const rd = await rpc("mail_unknown_refetch_done", { p_email: em });
      return rd.ok ? out({ ok: true }) : out({ error: "refetch_done_failed" }, 502);
    }

    let contacts;
    try { contacts = await loadContacts(); } catch { return out({ error: "contacts_failed" }, 502); }
    const eligible = (addr) => { const a = normEmail(addr); return !!a && !isAutomatedAddress(a) && !isOwnAddress(a) && !!pickMatch(contacts.idx, a); };

    if (b?.action === "match") {
      const emails = (Array.isArray(b.emails) ? b.emails : []).slice(0, 500).map(normEmail).filter(Boolean);
      return out({ ok: true, known: [...new Set(emails.filter(eligible))] });
    }
    // senders we do NOT know: only address / name / subject / date are stored (never the text), so nothing disappears silently
    if (b?.action === "unknown") {
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 60);
      let stored = 0, skipped = 0;
      for (const it of items) {
        const em = normEmail(trunc(it?.from_email, 200));
        // re-checked here: known contacts, own addresses and automated senders are never stored as "unknown"
        if (!em || !em.includes("@") || isAutomatedAddress(em) || isOwnAddress(em) || pickMatch(contacts.idx, em)) { skipped++; continue; }
        const r = await rpc("mail_unknown_put", { p: { from_email: em, from_name: trunc(it?.from_name, 200), subject: trunc(it?.subject, 300), received_at: trunc(it?.received_at, 40) || now().toISOString() } });
        if (r.ok && r.j?.ok) stored++; else skipped++;
      }
      return out({ ok: true, stored, skipped });
    }
    if (b?.action !== "ingest") return out({ error: "bad_action" }, 400);

    const dry = b.dry === true;
    const today = now().toISOString().slice(0, 10);
    const mails = (Array.isArray(b.mails) ? b.mails : []).slice(0, 25).map((m) => ({
      message_id: trunc(m?.message_id, 500).trim(), in_reply_to: trunc(m?.in_reply_to, 500).trim(),
      from_email: normEmail(trunc(m?.from_email, 200)), from_name: trunc(m?.from_name, 200),
      to_email: trunc(m?.to_email, 200), subject: trunc(m?.subject, 300),
      received_at: trunc(m?.received_at, 40), body: stripQuoted(trunc(m?.text, 20000)), backfill: m?.backfill === true,
      direction: m?.direction === "out" ? "out" : "in",
      attachments: cleanAttachments(m?.attachments),
      to_list: (Array.isArray(m?.to_list) ? m.to_list : []).slice(0, 30).map((x) => normEmail(trunc(x, 200))).filter(Boolean),
    }));

    // which of these we already have (classified ones are skipped so Claude is not paid twice)
    let known = new Map();
    if (!dry && mails.length) {
      const kr = await fetchFn(`${SB_URL}/rest/v1/rpc/mail_known_ids`, { method: "POST", headers: sb(), body: JSON.stringify({ p_ids: mails.map((m) => m.message_id) }) });
      const rows = await kr.json().catch(() => []);
      if (Array.isArray(rows)) known = new Map(rows.map((r) => [r.message_id, r.classified === true]));
    }

    const stat = { ok: true, dry, received: mails.length, unmatched: 0, already: 0, stored: 0, classified: 0, classify_failed: 0 };
    const results = [];
    for (const m of mails) {
      if (m.direction === "out") {
        // sent mail: matched by its RECIPIENTS (a known lead/owner), stored as already handled, never sent to Claude
        const rcpt = m.to_list.find((a) => eligible(a));
        if (!m.message_id || !rcpt) { stat.unmatched++; continue; }
        const best = pickMatch(contacts.idx, rcpt).best;
        const orec = {
          message_id: m.message_id, in_reply_to: m.in_reply_to, direction: "out", from_email: m.from_email || "info@rsproperties.sk", from_name: m.from_name,
          to_email: rcpt, subject: m.subject, received_at: m.received_at || now().toISOString(), body: m.body,
          match_kind: best.kind, lead_id: best.leadId || null, match_name: best.name,
          classified: true, intent: "sent", confidence: null, summary: "", needs_reply: false, urgency: "low", suggested: {},
          status: "handled", handled_by: "odoslana sprava", attachments: m.attachments,
        };
        if (dry) { stat.out_dry = (stat.out_dry || 0) + 1; continue; }
        const por = await fetchFn(`${SB_URL}/rest/v1/rpc/mail_put`, { method: "POST", headers: sb(), body: JSON.stringify({ p: orec }) });
        const poj = await por.json().catch(() => null);
        if (!por.ok || !poj?.ok) { stat.store_failed = (stat.store_failed || 0) + 1; continue; }
        stat.stored_out = (stat.stored_out || 0) + 1;
        continue;
      }
      if (!m.message_id || !m.from_email || !eligible(m.from_email)) { stat.unmatched++; continue; }
      if (known.get(m.message_id) === true) { stat.already++; continue; }
      const mt = pickMatch(contacts.idx, m.from_email);
      const best = mt.best;
      const lead = best.leadId ? contacts.leads.find((l) => String(l.id) === best.leadId) : null;
      let rec = {
        message_id: m.message_id, in_reply_to: m.in_reply_to, direction: "in", from_email: m.from_email, from_name: m.from_name,
        to_email: m.to_email, subject: m.subject, received_at: m.received_at || now().toISOString(), body: m.body,
        match_kind: best.kind, lead_id: best.leadId || null, match_name: best.name,
        classified: false, intent: "unclassified", confidence: null, summary: "", needs_reply: true, urgency: "normal", suggested: {},
        attachments: m.attachments,
      };
      // first poller run only: mails older than 3 days are history, not "new" - store them already handled so "Dnes" is not flooded
      const age = now().getTime() - Date.parse(rec.received_at);
      if (m.backfill && age > 3 * 86400000) { rec.status = "handled"; rec.handled_by = "automaticky (starsia posta pri zapnuti)"; }
      try {
        const c = await classify(best, lead, m, today);
        rec = { ...rec, classified: true, ...c };
        stat.classified++;
      } catch (e) {
        stat.classify_failed++;
        stat.classify_error = String(e && e.message || e).slice(0, 220);
      }
      if (dry) { results.push({ message_id: m.message_id, lead: best.name, kind: best.kind, intent: rec.intent, summary: rec.summary, needs_reply: rec.needs_reply, urgency: rec.urgency, suggested: rec.suggested }); continue; }
      const pr = await fetchFn(`${SB_URL}/rest/v1/rpc/mail_put`, { method: "POST", headers: sb(), body: JSON.stringify({ p: rec }) });
      const pj = await pr.json().catch(() => null);
      if (!pr.ok || !pj?.ok) { stat.store_failed = (stat.store_failed || 0) + 1; continue; }
      stat.stored++;
    }
    if (dry) stat.results = results;
    else {
      // an incoming mail is "answered" when a newer sent mail in the same thread exists (idempotent)
      try {
        const rr = await fetchFn(`${SB_URL}/rest/v1/rpc/mail_reconcile`, { method: "POST", headers: sb(), body: "{}" });
        const rj = await rr.json().catch(() => null);
        if (rr.ok && typeof rj === "number") stat.answered = rj;
      } catch { /* never block ingest on this */ }
    }
    return out(stat);
  };
}
