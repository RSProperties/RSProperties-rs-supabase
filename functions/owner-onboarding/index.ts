// RS Properties / Keystone - Supabase Edge Function: public owner-onboarding form (app.rsproperties.sk/onboarding).
// The owner fills the form; this function validates it, then (atomically, in Postgres: owner_onboarding_apply) creates/updates the
// owner, the property (status "Onboarding"), an acquisition lead, a company record with "request for a price offer" deals for requested
// services (photos, smart lock...), tasks, a checklist run and bell notifications. It then e-mails a confirmation to the owner
// and a notification to the assigned team member (fallback: info@rsproperties.sk).
// Public endpoint (no JWT) - protected by: honeypot, minimum fill time, per-IP and per-e-mail rate limit, strict validation,
// consent required. A team member can call it with {dry:true} (Authorization: Bearer <token>) to test without writing anything.
// Deploy: supabase functions deploy owner-onboarding --no-verify-jwt
// Secrets used: RESEND_API_KEY, EMAIL_FROM (optional).
// NOTE: keep this file plain ASCII.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callerAllowed } from "../_shared/caller_auth.ts";
import { logResend } from "../_shared/email_log.ts";
import { cleanForm, looksLikeSpam } from "./parse.mjs";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const JH = { ...CORS, "Content-Type": "application/json" };
const out = (o: unknown, status = 200) => new Response(JSON.stringify(o), { headers: JH, status });
const sb = (extra: Record<string, string> = {}) => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...extra });
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const HOUR = 3600_000, DAY = 24 * HOUR;
// counts a hit for `key`; false = over the limit (table auth_rate_limits is service-role only)
async function hit(key: string, max: number, windowMs: number): Promise<boolean> {
  try {
    const rows: any[] = await fetch(`${SB_URL}/rest/v1/auth_rate_limits?key=eq.${encodeURIComponent(key)}`, { headers: sb() }).then((r) => r.json()).catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    const now = Date.now();
    if (!row || now - new Date(row.window_start).getTime() > windowMs) {
      await fetch(`${SB_URL}/rest/v1/auth_rate_limits`, { method: "POST", headers: sb({ Prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify({ key, attempts: 1, window_start: new Date().toISOString(), locked_until: null }) }).catch(() => {});
      return true;
    }
    if ((row.attempts || 0) >= max) return false;
    await fetch(`${SB_URL}/rest/v1/auth_rate_limits?key=eq.${encodeURIComponent(key)}`, { method: "PATCH", headers: sb({ Prefer: "return=minimal" }),
      body: JSON.stringify({ attempts: (row.attempts || 0) + 1 }) }).catch(() => {});
    return true;
  } catch { return true; }   // never block a real owner because the limiter itself failed
}

async function sendMail(to: string, subject: string, html: string, text: string, template: string) {
  try {
    const from = Deno.env.get("EMAIL_FROM") || "RS Properties <noreply@rsproperties.sk>";
    const rr = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
    const rj = await rr.json().catch(() => ({}));
    await logResend(rr, rj, { to, subject, template, meta: { from } });
  } catch (e) { console.error("mail failed", template, e); }
}

const NAVY = "#1a2e44", GOLD = "#c9a96e";
const shell = (title: string, inner: string, lang = "sk") => `<!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="font-family:Arial,sans-serif;background:#f5f1eb;margin:0;padding:24px 12px;color:${NAVY}">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
<div style="background:${NAVY};padding:18px 26px;border-bottom:4px solid ${GOLD};color:#fff;font-size:17px;font-weight:700">${esc(title)}</div>
<div style="padding:24px 26px;font-size:14px;line-height:1.55">${inner}</div></div></body></html>`;
const row = (k: string, v: string) => v ? `<tr><td style="padding:5px 0;color:#7a8694;font-size:13px;width:120px;vertical-align:top">${esc(k)}</td><td style="padding:5px 0;font-size:14px;font-weight:600;color:${NAVY}">${esc(v)}</td></tr>` : "";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return out({ error: "method_not_allowed" }, 405);
  const raw = await req.text();
  if (raw.length > 40_000) return out({ error: "too_large" }, 413);
  let body: any = {};
  try { body = JSON.parse(raw); } catch { return out({ error: "bad_json" }, 400); }

  const dry = body && body.dry === true;
  if (dry && !(await callerAllowed(req))) return out({ error: "forbidden" }, 403);

  if (!dry) {
    // silent drops: the bot must not learn what we filter
    if (typeof body.hp === "string" && body.hp.trim() !== "") return out({ ok: true, ignored: true });
    const t0 = Number(body.t0);
    if (t0 && (Date.now() - t0 < 6000 || Date.now() - t0 > 7 * DAY)) return out({ ok: true, ignored: true });
    const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
    if (!(await hit("onb:ip:" + ip, 8, HOUR))) return out({ error: "rate_limited" }, 429);
  }

  const c = cleanForm(body);
  if (!c.ok) return out({ error: c.error }, 400);
  const form: any = c.form;
  if (!dry) {
    if (looksLikeSpam(form)) return out({ ok: true, ignored: true });
    if (!(await hit("onb:mail:" + form.email, 4, DAY))) return out({ error: "rate_limited" }, 429);
  }

  const res = await fetch(`${SB_URL}/rest/v1/rpc/owner_onboarding_apply`, { method: "POST", headers: sb(), body: JSON.stringify({ p: { ...form, dry } }) });
  const r: any = await res.json().catch(() => null);
  if (!res.ok || !r) { console.error("owner_onboarding_apply failed", res.status, r); return out({ error: "onboarding_failed" }, 500); }
  if (!r.ok) return out(r, r.error === "disabled" ? 200 : 400);
  if (dry) return out({ ok: true, dry: true, ownerExists: r.ownerExists, propertyExists: r.propertyExists, leadExists: r.leadExists, services: r.services, assignee: r.assignee ? { name: r.assignee.name } : null, parsed: form });

  const en = form.lang === "en";
  const svcs: string[] = r.services || [];
  const ref = String(r.taskId || "").slice(-6).toUpperCase();

  // 1) confirmation to the owner
  const subj = en ? "Thank you - we received your property details" : "Dakujeme - prijali sme udaje o vasej nehnutelnosti";
  const inner = en
    ? `<p style="margin:0 0 14px">Hello ${esc(form.name)},</p><p style="margin:0 0 14px">thank you for your trust. We received the details of your property and the RS Properties team will contact you shortly to arrange the viewing and the next steps.</p>
<table role="presentation" style="width:100%;border-collapse:collapse">${row("Property", form.address)}${row("Reference", ref)}${row("Requested services", svcs.join(", "))}</table>
<p style="margin:16px 0 0;color:#7a8694;font-size:12.5px">If anything changes, just reply to this e-mail. Sensitive data (bank details, ID) are never requested by e-mail or this form.</p>`
    : `<p style="margin:0 0 14px">Dobry den ${esc(form.name)},</p><p style="margin:0 0 14px">dakujeme za doveru. Udaje o vasej nehnutelnosti sme prijali a tim RS Properties sa vam coskoro ozve s dohodnutim obhliadky a dalsim postupom.</p>
<table role="presentation" style="width:100%;border-collapse:collapse">${row("Nehnutelnost", form.address)}${row("Cislo ziadosti", ref)}${row("Zaujem o sluzby", svcs.join(", "))}</table>
<p style="margin:16px 0 0;color:#7a8694;font-size:12.5px">Ak sa nieco zmeni, staci odpovedat na tento e-mail. Citlive udaje (bankove udaje, doklady) si nikdy nevyziadame e-mailom ani cez tento formular.</p>`;
  await sendMail(form.email, subj, shell(en ? "RS Properties - thank you" : "RS Properties - dakujeme", inner, form.lang),
    `${en ? "Thank you" : "Dakujeme"} - ${form.address} (${ref})`, "owner-onboarding-confirm");

  // 2) notification to the team (assignee, else info@)
  const asg = r.assignee;
  const to = (asg && asg.email) || "info@rsproperties.sk";
  const tsub = (r.linked ? "Majitel vyplnil onboarding formular: " : "Novy onboarding majitela: ") + form.name + (svcs.length ? " (ziada: " + svcs.join(", ") + ")" : "");
  const tin = `<p style="margin:0 0 14px">${asg ? "Dobry den " + esc(asg.name || "") + ", " : ""}majitel vyplnil onboarding formular. ${r.linked ? "Udaje su ulozene v nehnutelnosti v Keystone (Info - Interny popis) a je pripravena uloha na kontrolu" : "V Keystone je pripraveny majitel, nehnutelnost (stav Onboarding), lead v pipeline a uloha <b>Onboarding majitela</b>"}${svcs.length ? " a ziadost o cenovu ponuku (" + esc(svcs.join(", ")) + ")" : ""}.</p>
<table role="presentation" style="width:100%;border-collapse:collapse">${row("Majitel", form.name)}${row("E-mail", form.email)}${row("Telefon", form.phone)}${row("Adresa", form.address)}${row("Typ", form.ptype)}${row("Obhliadka", form.shootDate)}${row("Prevzatie od", form.takeoverDate)}${row("Sluzby", svcs.join(", "))}${row("Poznamka", form.note)}</table>
<div style="text-align:center;margin:22px 0 4px"><a href="https://app.rsproperties.sk/" style="display:inline-block;background:${NAVY};color:#fff;text-decoration:none;font-weight:700;font-size:14px;border-radius:99px;padding:12px 28px;border:2px solid ${GOLD}">Otvorit v Keystone</a></div>`;
  await sendMail(to, tsub, shell(r.linked ? "Majitel vyplnil onboarding formular" : "Novy onboarding majitela", tin), `${tsub}\n\n${form.name}\n${form.email}\n${form.phone}\n${form.address}`, "owner-onboarding-team");

  return out({ ok: true, ref });
});
