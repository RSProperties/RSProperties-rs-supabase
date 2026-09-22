// RS Properties / Keystone — Supabase Edge Function
// Weekly Business Development pipeline digest — the "weekly digest email"
// piece of the bizLeads CRM module (index.html, 2026-09-18). Recipients are
// admins + any active team member granted the 'bizdev' TM_GROUPS permission
// (view or edit) — i.e. whoever is actually responsible for the pipeline,
// not the whole team. Mirrors ops-digest's shape (same auth pattern, same
// email-log wiring) but reads `workspace.bizLeads` instead of ops data.
//
// Two sections, one per register (2026-09-22 — was one combined section
// until the CRM itself split into "Akvizícia nehnuteľností" vs "Firmy &
// Dodávatelia" on 2026-09-19/20): each gets its own KPI row, overdue
// follow-ups, and stalled items (no stage change in 14+ days) — the same
// things the in-app KPI bar + overdue badges surface, just pushed to
// inboxes weekly so nothing sits unnoticed just because nobody opened the
// tab. Acquisition leads carry their own stage/lost/nextFollowUp; company
// records don't any more (see bizEnsureDeals in index.html) — a company's
// stage/lost/nextFollowUp now lives per-deal in `lead.deals[]`, so the
// company section's stats are computed per-deal, not per-lead. A legacy
// company record saved before that migration ran (no `deals[]` yet) gets
// the exact same one-time synthetic-deal fallback the client uses, so the
// two never disagree.
//
// Auth: service role (pg_cron) OR any active team member's Supabase Auth
// token (manual "send now"), same allow-rule as ops-digest/hostex-daily-sync.
//
// Deploy: supabase functions deploy bizdev-digest
// Secrets used: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY,
// EMAIL_FROM (optional, same fallback as every other send-* function).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { logResend } from "../_shared/email_log.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STALL_DAYS = 14;

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

// Covers both BIZ_STAGES (acquisition, 10 stages) and BIZ_DEAL_STAGES
// (company deals, 4 stages) — the company set deliberately shares key
// names with a subset of the acquisition set (see index.html), so one
// map serves both.
const BIZ_STAGE_LABELS: Record<string, string> = {
  new: "Nový kontakt", qualifying: "Kvalifikácia", viewing_scheduled: "Obhliadka dohodnutá",
  viewed: "Obhliadka hotová", proposal_sent: "Ponuka odoslaná", negotiation: "Rokovanie",
  contract_drafted: "Zmluva pripravená", contract_signed: "Zmluva podpísaná",
  onboarding: "Onboarding", won: "Aktívne (Won)",
};

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function fmtDate(iso: string): string {
  try { return new Date(iso + "T00:00:00").toLocaleDateString("sk-SK"); } catch { return iso; }
}

// ── Shared stage/overdue/stalled math — works on a flat list of
// normalized items, so the same logic serves acquisition leads (one item
// per lead) and company deals (one item per deal, several per lead)
// without duplicating the KPI/overdue/stalled rules in two places.
interface StatItem {
  displayName: string;
  stage: string;
  lost: boolean;
  updatedAt: number;   // ms epoch — for "won"/"lost" items, the moment they closed
  createdAt: number;   // ms epoch
  nextFollowUp: string; // YYYY-MM-DD or ''
  assignedTo: string;
}
function computeStats(items: StatItem[], now: number, todayMonth: string, today: string) {
  let active = 0, wonMonth = 0, lostMonth = 0, wonTotal = 0, lostTotal = 0, daysSum = 0, daysCnt = 0;
  const overdue: StatItem[] = [];
  const stalled: StatItem[] = [];
  items.forEach((it) => {
    if (it.lost) {
      lostTotal++;
      if (it.updatedAt && new Date(it.updatedAt).toISOString().slice(0, 7) === todayMonth) lostMonth++;
      return;
    }
    if (it.stage === "won") {
      wonTotal++;
      if (it.updatedAt) {
        if (new Date(it.updatedAt).toISOString().slice(0, 7) === todayMonth) wonMonth++;
        if (it.createdAt) { daysSum += (it.updatedAt - it.createdAt) / 86400000; daysCnt++; }
      }
      return;
    }
    active++;
    if (it.nextFollowUp && it.nextFollowUp < today) overdue.push(it);
    const lastTouch = it.updatedAt || it.createdAt || 0;
    if (lastTouch && (now - lastTouch) / 86400000 >= STALL_DAYS) stalled.push(it);
  });
  const closedTotal = wonTotal + lostTotal;
  const conv = closedTotal ? Math.round((wonTotal / closedTotal) * 100) : null;
  const avgDays = daysCnt ? Math.round(daysSum / daysCnt) : null;
  overdue.sort((a, b) => (a.nextFollowUp < b.nextFollowUp ? -1 : 1));
  stalled.sort((a, b) => (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0));
  return { active, wonMonth, lostMonth, conv, avgDays, overdue, stalled };
}

// Acquisition lead → StatItem. Uses the actual "won" history-entry
// timestamp (not just `updatedAt`, which could've been bumped by an
// unrelated later edit) for the won-this-month/avg-days math — matches
// the original single-section digest's precision exactly.
function normalizeAcqItem(l: any): StatItem {
  let updatedAt = l.updatedAt || 0;
  if (l.stage === "won") {
    const wonEntry = (l.history || []).slice().reverse().find((h: any) => h.stage === "won");
    if (wonEntry) updatedAt = wonEntry.ts;
  }
  return {
    displayName: l.name, stage: l.stage, lost: !!l.lost,
    updatedAt, createdAt: l.createdAt || 0,
    nextFollowUp: l.nextFollowUp || "", assignedTo: l.assignedTo || "",
  };
}

// Company lead → one StatItem per deal. `bizEnsureDeals` (index.html)
// self-heals a legacy company record (saved before deals[] existed) into
// one synthetic deal built from its old top-level stage/desc/estValue/
// lost/nextFollowUp fields the first time it renders client-side — mirror
// that exact fallback here so a company that nobody has opened in the
// admin app since the 2026-09-20 migration still reports correctly.
function normalizeCompanyItems(l: any): StatItem[] {
  const rawDeals = (l.deals && l.deals.length)
    ? l.deals
    : (l.desc || l.estValue != null || l.stage || l.lost)
      ? [{
          title: l.desc || l.companyWhat || "Obchod",
          stage: l.stage || "new", lost: !!l.lost,
          updatedAt: l.updatedAt || l.createdAt || 0, createdAt: l.createdAt || 0,
          nextFollowUp: l.nextFollowUp || "",
        }]
      : [];
  return rawDeals.map((d: any) => ({
    displayName: d.title ? `${l.name} — ${d.title}` : l.name,
    stage: d.stage || "new", lost: !!d.lost,
    updatedAt: d.updatedAt || d.createdAt || 0, createdAt: d.createdAt || 0,
    nextFollowUp: d.nextFollowUp || "", assignedTo: l.assignedTo || "",
  }));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(await callerAllowed(req))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { headers: JSON_HEADERS, status: 403 });
  }

  try {
    // ── Recipients: admins + anyone granted the 'bizdev' permission ──
    const tuRes = await fetch(
      `${SB_URL}/rest/v1/team_users?select=id,name,email,role,active,permissions`,
      { headers: sbHeaders() },
    );
    const teamUsers = await tuRes.json().catch(() => []);
    const recipients = (Array.isArray(teamUsers) ? teamUsers : []).filter((u: any) => {
      if (!u.active || !u.email) return false;
      if (u.role === "admin") return true;
      const perms = typeof u.permissions === "string" ? JSON.parse(u.permissions || "{}") : (u.permissions || {});
      return perms.bizdev === "view" || perms.bizdev === "edit";
    });

    // ── Pipeline data ──
    const wsRes = await fetch(`${SB_URL}/rest/v1/workspace?select=value&key=eq.bizLeads`, { headers: sbHeaders() });
    const wsRows = await wsRes.json().catch(() => []);
    const leads: any[] = Array.isArray(wsRows) && Array.isArray(wsRows[0]?.value) ? wsRows[0].value : [];

    const now = Date.now();
    const todayMonth = new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);

    const acqLeads = leads.filter((l) => (l.type || "acquisition") !== "company");
    const coLeads = leads.filter((l) => l.type === "company");

    const acq = computeStats(acqLeads.map(normalizeAcqItem), now, todayMonth, today);
    const co = computeStats(coLeads.flatMap(normalizeCompanyItems), now, todayMonth, today);

    const dateLabel = new Date().toLocaleDateString("sk-SK", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

    const section = (title: string, rows: string[], emptyLabel: string) => `
      <div class="sec">
        <div class="sec-hdr">${title}</div>
        ${rows.length ? rows.map((r) => `<div class="row bad">${r}</div>`).join("") : `<div class="row ok">✓ ${emptyLabel}</div>`}
      </div>`;

    const overdueRow = (it: StatItem) =>
      `<strong>${esc(it.displayName)}</strong> — follow-up bol ${esc(fmtDate(it.nextFollowUp))}${it.assignedTo ? ` · ${esc(it.assignedTo)}` : ""} · stupeň: ${esc(BIZ_STAGE_LABELS[it.stage] || it.stage)}`;
    const stalledRow = (it: StatItem) => {
      const days = Math.round((now - (it.updatedAt || it.createdAt || now)) / 86400000);
      return `<strong>${esc(it.displayName)}</strong> — ${days} dní bez zmeny${it.assignedTo ? ` · ${esc(it.assignedTo)}` : ""} · stupeň: ${esc(BIZ_STAGE_LABELS[it.stage] || it.stage)}`;
    };

    const kpiRow = (stats: ReturnType<typeof computeStats>, activeLabel: string) => `
      <div class="kpis">
        <div class="kpi"><div class="kpi-val">${stats.active}</div><div class="kpi-lbl">${activeLabel}</div></div>
        <div class="kpi"><div class="kpi-val">${stats.wonMonth}</div><div class="kpi-lbl">Won / mesiac</div></div>
        <div class="kpi"><div class="kpi-val">${stats.lostMonth}</div><div class="kpi-lbl">Prehraté / mesiac</div></div>
        ${stats.conv != null ? `<div class="kpi"><div class="kpi-val">${stats.conv}%</div><div class="kpi-lbl">Konverzia</div></div>` : ""}
        ${stats.avgDays != null ? `<div class="kpi"><div class="kpi-val">${stats.avgDays}</div><div class="kpi-lbl">Ø dní do won</div></div>` : ""}
      </div>`;

    const registerSection = (icon: string, title: string, stats: ReturnType<typeof computeStats>, activeLabel: string) => `
      <div class="reg">
        <div class="reg-hdr">${icon} ${title}</div>
        ${kpiRow(stats, activeLabel)}
        ${section(`⚠ Follow-up po termíne (${stats.overdue.length})`, stats.overdue.map(overdueRow), "Žiadne omeškané follow-upy")}
        ${section(`🐌 Bez pohybu ${STALL_DAYS}+ dní (${stats.stalled.length})`, stats.stalled.map(stalledRow), "Žiadne stagnujúce")}
      </div>`;

    const html = `<!DOCTYPE html>
<html lang="sk"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light only"/><meta name="supported-color-schemes" content="light"/>
<style>
  body{font-family:'DM Sans',Arial,sans-serif;background:#f5f1eb;margin:0;padding:32px 16px;color:#1a2e44}
  .wrap{max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  .hdr{background:#1a2e44;padding:24px 32px}
  .hdr-brand{font-family:Georgia,serif;font-size:20px;color:#c9a96e;margin-bottom:4px}
  .hdr-sub{color:rgba(255,255,255,.6);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
  .body{padding:24px 32px}
  .reg{margin-bottom:8px}
  .reg+.reg{padding-top:20px;border-top:1.5px solid #eee}
  .reg-hdr{font-family:Georgia,serif;font-size:15px;color:#1a2e44;margin-bottom:12px}
  .kpis{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
  .kpi{flex:1;min-width:90px;background:#f7f4ee;border-radius:10px;padding:10px 12px}
  .kpi-val{font-size:18px;font-weight:800;color:#1a2e44}
  .kpi-lbl{font-size:9.5px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
  .sec{margin-bottom:14px}
  .sec-hdr{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#888;margin-bottom:8px}
  .row{font-size:13px;padding:9px 14px;border-radius:8px;margin-bottom:6px;line-height:1.5}
  .row.ok{background:#f0fdf6;color:#1a6b4a}
  .row.bad{background:#fff9ee;color:#8a6416}
  .footer{background:#f7f9fc;padding:16px 32px;border-top:1px solid #eee;font-size:11.5px;color:#aaa}
</style></head>
<body><div class="wrap">
  <div class="hdr"><div class="hdr-brand">Keystone</div><div class="hdr-sub">Obchodný pipeline · týždenný súhrn · ${esc(dateLabel)}</div></div>
  <div class="body">
    ${registerSection("🏠", "Akvizícia nehnuteľností", acq, "Aktívne leady")}
    ${registerSection("🏢", "Firmy & Dodávatelia", co, "Aktívne obchody")}
  </div>
  <div class="footer">Automatický týždenný súhrn z Keystone. Zmeniť/vypnúť v Supabase → pg_cron.</div>
</div></body></html>`;

    const fromAddr = Deno.env.get("EMAIL_FROM") || "Keystone <noreply@rsproperties.sk>";
    const toList = recipients.map((a: any) => a.email).filter(Boolean);
    const totalOverdue = acq.overdue.length + co.overdue.length;
    const totalStalled = acq.stalled.length + co.stalled.length;
    const subject = (totalOverdue || totalStalled)
      ? `⚠ Obchodný pipeline — ${totalOverdue} po termíne, ${totalStalled} bez pohybu`
      : "✓ Obchodný pipeline — týždenný súhrn";

    let resendResult: any = null;
    if (toList.length) {
      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromAddr, to: toList, subject, html }),
      });
      resendResult = await resendRes.json().catch(() => ({}));
      await logResend(resendRes, resendResult, {
        to: toList.join(", "),
        subject,
        template: "bizdev-digest",
        meta: {
          from: fromAddr,
          acqActive: acq.active, acqWonMonth: acq.wonMonth, acqLostMonth: acq.lostMonth,
          coActive: co.active, coWonMonth: co.wonMonth, coLostMonth: co.lostMonth,
          overdueCount: totalOverdue, stalledCount: totalStalled,
        },
      });
    }

    return new Response(JSON.stringify({
      ok: true, sentTo: toList,
      acquisition: { active: acq.active, wonMonth: acq.wonMonth, lostMonth: acq.lostMonth, conv: acq.conv, avgDays: acq.avgDays, overdueCount: acq.overdue.length, stalledCount: acq.stalled.length },
      company: { active: co.active, wonMonth: co.wonMonth, lostMonth: co.lostMonth, conv: co.conv, avgDays: co.avgDays, overdueCount: co.overdue.length, stalledCount: co.stalled.length, companyCount: coLeads.length },
      overdueCount: totalOverdue, stalledCount: totalStalled,
    }), { headers: JSON_HEADERS, status: 200 });
  } catch (err) {
    console.error("bizdev-digest error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { headers: JSON_HEADERS, status: 500 });
  }
});
