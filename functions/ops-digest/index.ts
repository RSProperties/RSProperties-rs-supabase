// RS Properties / Keystone — Supabase Edge Function
// Daily "is everything OK" ops digest, emailed to admins so nobody has to
// remember to open Team Health / Data Integrity Scan / Email Log by hand.
//
// Ports (a deliberately simplified, server-side version of) three checks
// that already exist client-side:
//   - Team Health (index.html `_tmRenderHealth`) — active members who
//     haven't logged in since the 2026-09-07 Phase 3 cutover, so they
//     carry no Auth JWT and silently can't load reports/sklad/tasks.
//   - Data Integrity Scan (index.html `_integrityScan`) — duplicate ids,
//     orphaned property references, tombstoned-but-resurrected records.
//   - A backup-freshness check (new here) — the daily `backup_YYYY-MM-DD`
//     workspace snapshot is what forensic recovery has relied on all
//     session (see CLAUDE.md's data-loss writeups); if it silently stops
//     being written, nobody would notice until they needed it.
// Also surfaces failed-email counts from `email_log` (Round 2 item H) —
// another thing nobody currently checks unless something is reported
// missing by a human first.
//
// This is advisory only, same spirit as the client-side scans it mirrors:
// it never writes anything back, only reads + emails a summary.
//
// Auth: service role (pg_cron) OR any active team member's Supabase Auth
// token (manual "Send digest now" button) — same pattern as
// hostex-daily-sync. Recipients are always admins regardless of caller.
//
// Deploy: supabase functions deploy ops-digest
// Secrets used: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY,
// EMAIL_FROM (optional, falls back like every other send-* function).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { logResend } from "../_shared/email_log.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PHASE3_CUTOVER = "2026-09-07T00:00:00Z";

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

// Same allow-rule as hostex-daily-sync: the cron's service-role bearer, or
// any currently-active team member (covers the manual "send now" button).
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

async function getWorkspace(keys: string[]): Promise<Record<string, any>> {
  const r = await fetch(
    `${SB_URL}/rest/v1/workspace?select=key,value&key=in.(${keys.map(encodeURIComponent).join(",")})`,
    { headers: sbHeaders() },
  );
  const rows = await r.json().catch(() => []);
  const out: Record<string, any> = {};
  (Array.isArray(rows) ? rows : []).forEach((row: any) => { out[row.key] = row.value; });
  return out;
}

function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().trim();
}

function findDupIds(arr: any[] | undefined, label: string): string | null {
  const seen: Record<string, number> = {};
  (arr || []).forEach((r) => { const id = r?.id; if (id == null) return; seen[id] = (seen[id] || 0) + 1; });
  const dupCount = Object.values(seen).filter((n) => n > 1).length;
  return dupCount ? `${label}: ${dupCount} duplicate id(s)` : null;
}

function findOrphans(arr: any[] | undefined, label: string, propIds: Set<string>, propNames: Set<string>): string | null {
  const bad = (arr || []).filter((r) => {
    if (!r || (!r.propId && !r.propName)) return false;
    if (r.propId && propIds.has(r.propId)) return false;
    if (r.propName && propNames.has(norm(r.propName))) return false;
    return true;
  });
  return bad.length ? `${label}: ${bad.length} record(s) point at a property that no longer exists` : null;
}

function findResurrected(arr: any[] | undefined, deletedIds: any[] | undefined, label: string): string | null {
  const ids = new Set((deletedIds || []).map(String));
  if (!ids.size) return null;
  const back = (arr || []).filter((r) => r?.id != null && ids.has(String(r.id)));
  return back.length ? `${label}: ${back.length} deleted record(s) came back (tombstone/merge regression)` : null;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(await callerAllowed(req))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { headers: JSON_HEADERS, status: 403 });
  }

  try {
    // ── 1. Team Health — locked-out active members ──
    const tuRes = await fetch(
      `${SB_URL}/rest/v1/team_users?select=id,name,email,role,active,last_login`,
      { headers: sbHeaders() },
    );
    const teamUsers = await tuRes.json().catch(() => []);
    const activeMembers = (Array.isArray(teamUsers) ? teamUsers : []).filter((u: any) => u.active === true);
    const lockedOut = activeMembers.filter((u: any) => !u.last_login || new Date(u.last_login) < new Date(PHASE3_CUTOVER));
    const admins = activeMembers.filter((u: any) => u.role === "admin" && u.email);

    // ── 2. Data Integrity — a simplified, server-side mirror of _integrityScan() ──
    const ws = await getWorkspace([
      "properties", "owners", "tasks", "settlements", "quickLog", "maintenanceLog",
      "tasks_deleted", "settlements_deleted", "quickLog_deleted", "maintenanceLog_deleted",
    ]);
    const properties = Array.isArray(ws.properties) ? ws.properties : [];
    const propIds = new Set(properties.map((p: any) => p.id).filter(Boolean));
    const propNames = new Set(properties.map((p: any) => norm(p.name)).filter(Boolean));

    const integrityIssues = [
      findDupIds(ws.tasks, "Tasks"), findDupIds(ws.settlements, "Settlements"),
      findDupIds(ws.quickLog, "Quick Log"), findDupIds(ws.maintenanceLog, "Maintenance Log"),
      findDupIds(properties, "Properties"), findDupIds(ws.owners, "Owners"),
      findOrphans(ws.tasks, "Tasks", propIds, propNames),
      findOrphans(ws.quickLog, "Quick Log", propIds, propNames),
      findOrphans(ws.maintenanceLog, "Maintenance Log", propIds, propNames),
      findResurrected(ws.tasks, ws.tasks_deleted, "Tasks"),
      findResurrected(ws.settlements, ws.settlements_deleted, "Settlements"),
      findResurrected(ws.quickLog, ws.quickLog_deleted, "Quick Log"),
      findResurrected(ws.maintenanceLog, ws.maintenanceLog_deleted, "Maintenance Log"),
    ].filter((x): x is string => !!x);

    // ── 3. Backup freshness — today's or yesterday's daily snapshot must exist ──
    const today = new Date();
    const yest = new Date(today.getTime() - 86400000);
    const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
    const backupKeys = [`backup_${fmtDate(today)}`, `backup_${fmtDate(yest)}`];
    const backupRow = await fetch(
      `${SB_URL}/rest/v1/workspace?select=key&key=in.(${backupKeys.map(encodeURIComponent).join(",")})`,
      { headers: sbHeaders() },
    );
    const backupRows = await backupRow.json().catch(() => []);
    const backupOk = Array.isArray(backupRows) && backupRows.length > 0;

    // ── 4. Failed transactional emails in the last 24h ──
    const since = new Date(Date.now() - 86400000).toISOString();
    const failedRes = await fetch(
      `${SB_URL}/rest/v1/email_log?select=id&status=eq.failed&created_at=gte.${encodeURIComponent(since)}`,
      { headers: sbHeaders() },
    );
    const failedRows = await failedRes.json().catch(() => []);
    const failedEmailCount = Array.isArray(failedRows) ? failedRows.length : 0;

    // ── 5. App errors reported by browsers in the last 24h (client_errors, 2026-10-20) ──
    let appErrorRows: string[] = [];
    try {
      const errRes = await fetch(
        `${SB_URL}/rest/v1/client_errors?select=kind,message,user_name&created_at=gte.${encodeURIComponent(since)}&limit=500`,
        { headers: sbHeaders() },
      );
      const errRows = await errRes.json().catch(() => []);
      if (Array.isArray(errRows) && errRows.length) {
        const groups: Record<string, { n: number; users: Set<string>; kind: string; msg: string }> = {};
        for (const e of errRows) {
          const k = `${e.kind}|${e.message}`;
          (groups[k] ||= { n: 0, users: new Set(), kind: e.kind, msg: e.message }).n++;
          groups[k].users.add(e.user_name || "?");
        }
        const top = Object.values(groups).sort((a, b) => b.n - a.n);
        appErrorRows = [`${errRows.length} error(s) in ${top.length} kind(s) — details: Keystone → Team Members → Chyby z aplikácie`]
          .concat(top.slice(0, 3).map((g) => `${g.n}× ${g.kind === "save_failed" ? "save failed" : "JS error"} — ${g.msg.slice(0, 140)} (${[...g.users].slice(0, 3).join(", ")})`));
      }
    } catch (_e) { /* table missing / unreadable: digest still goes out */ }

    const allClear = lockedOut.length === 0 && integrityIssues.length === 0 && backupOk && failedEmailCount === 0 && appErrorRows.length === 0;

    // ── Build + send the digest ──
    const dateLabel = today.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

    const section = (title: string, rows: string[], okLabel: string) => `
      <div class="sec">
        <div class="sec-hdr">${title}</div>
        ${rows.length ? rows.map((r) => `<div class="row bad">${r}</div>`).join("") : `<div class="row ok">✓ ${okLabel}</div>`}
      </div>`;

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light only"/><meta name="supported-color-schemes" content="light"/>
<style>
  body{font-family:'DM Sans',Arial,sans-serif;background:#f5f1eb;margin:0;padding:32px 16px;color:#1a2e44}
  .wrap{max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  .hdr{background:#1a2e44;padding:24px 32px}
  .hdr-brand{font-family:Georgia,serif;font-size:20px;color:#c9a96e;margin-bottom:4px}
  .hdr-sub{color:rgba(255,255,255,.6);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
  .body{padding:24px 32px}
  .sec{margin-bottom:18px}
  .sec-hdr{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#888;margin-bottom:8px}
  .row{font-size:13.5px;padding:9px 14px;border-radius:8px;margin-bottom:6px;line-height:1.5}
  .row.ok{background:#f0fdf6;color:#1a6b4a}
  .row.bad{background:#fff5f5;color:#b83232}
  .allclear{text-align:center;padding:20px;font-size:16px;font-weight:700;color:#1a6b4a}
  .footer{background:#f7f9fc;padding:16px 32px;border-top:1px solid #eee;font-size:11.5px;color:#aaa}
</style></head>
<body><div class="wrap">
  <div class="hdr"><div class="hdr-brand">Keystone</div><div class="hdr-sub">Daily Ops Digest · ${esc(dateLabel)}</div></div>
  <div class="body">
    ${allClear ? `<div class="allclear">✓ All clear — nothing needs your attention today.</div>` : ""}
    ${section(
      `🩺 Team Health (${lockedOut.length} locked out)`,
      lockedOut.map((u: any) => `${esc(u.name || u.email)} — hasn't logged in since the security update, can't see new reports/sklad/tasks`),
      "Everyone active has logged in since the security update",
    )}
    ${section(`🔍 Data Integrity (${integrityIssues.length})`, integrityIssues.map(esc), "No integrity issues found")}
    ${section(`💾 Backup`, backupOk ? [] : [`No daily backup snapshot found for today or yesterday — check the app is being opened daily`], `Daily snapshot present (checked ${backupKeys.join(", ")})`)}
    ${section(`📧 Email delivery (last 24h)`, failedEmailCount ? [`${failedEmailCount} transactional email(s) failed to send — check Email Log`] : [], "No failed sends in the last 24 hours")}
    ${section(`🐞 App errors (last 24h)`, appErrorRows.map(esc), "No errors reported by the app in the last 24 hours")}
  </div>
  <div class="footer">Automated daily digest from Keystone. Change or disable this in Supabase → pg_cron.</div>
</div></body></html>`;

    const fromAddr = Deno.env.get("EMAIL_FROM") || "Keystone <noreply@rsproperties.sk>";
    const toList = admins.map((a: any) => a.email).filter(Boolean);
    const subject = allClear ? "✓ Keystone daily digest — all clear" : "⚠ Keystone daily digest — needs attention";

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
        template: "ops-digest",
        meta: { from: fromAddr, lockedOutCount: lockedOut.length, integrityIssueCount: integrityIssues.length, backupOk, failedEmailCount },
      });
    }

    return new Response(JSON.stringify({
      ok: true, sentTo: toList, allClear,
      lockedOut: lockedOut.map((u: any) => ({ name: u.name, email: u.email })),
      integrityIssues, backupOk, failedEmailCount,
    }), { headers: JSON_HEADERS, status: 200 });
  } catch (err) {
    console.error("ops-digest error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { headers: JSON_HEADERS, status: 500 });
  }
});
