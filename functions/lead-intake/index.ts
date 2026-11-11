// RS Properties / Keystone - Supabase Edge Function: automatic intake of website contact-form enquiries.
// Called by the website (WPForms hook, see Keystone > Obchodny pipeline > "Prijem z webu") with header x-intake-secret.
// Creates (atomically, in Postgres: lead_intake_apply) a lead in "Akvizicia nehnutelnosti", a "contact the prospect" task for the
// next team member in the rotation, a bell notification, and emails the assignee. Duplicates (same e-mail / phone within 45 days)
// only add a note and a task. A team member may call it with {dry:true} (Authorization: Bearer <token>) to test the setup.
// Deploy: supabase functions deploy lead-intake --no-verify-jwt
// Secrets used: RESEND_API_KEY, EMAIL_FROM (optional). The shared secret is stored as a SHA-256 hash in workspace.leadIntakeCfg.
// NOTE: keep this file plain ASCII.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callerAllowed } from "../_shared/caller_auth.ts";
import { logResend } from "../_shared/email_log.ts";
import { mapLead, validEmail, phoneDigits, looksLikeSpam } from "./parse.mjs";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-intake-secret" };
const JH = { ...CORS, "Content-Type": "application/json" };
const out = (o: unknown, status = 200) => new Response(JSON.stringify(o), { headers: JH, status });
const sb = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return out({ error: "method_not_allowed" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { return out({ error: "bad_json" }, 400); }

  // ---- auth: shared secret (website) or an active team member (dry-run test from Keystone)
  const dry = body && body.dry === true;
  let authed = false;
  const secret = req.headers.get("x-intake-secret") || "";
  if (secret) {
    const cfgRows: any[] = await fetch(`${SB_URL}/rest/v1/workspace?select=value&key=eq.leadIntakeCfg`, { headers: sb() }).then((r) => r.json()).catch(() => []);
    const hash = cfgRows?.[0]?.value?.secretHash;
    if (typeof hash === "string" && hash.length === 64 && safeEqual(await sha256Hex(secret), hash.toLowerCase())) authed = true;
  }
  if (!authed && dry && (await callerAllowed(req))) authed = true;
  if (!authed) return out({ error: "forbidden" }, 403);

  // ---- parse + basic anti-spam (silent: the website must not learn what we filter)
  if (body && typeof body.hp === "string" && body.hp.trim() !== "") return out({ ok: true, ignored: true });
  const lead = mapLead(body);
  if (looksLikeSpam(lead)) return out({ ok: true, ignored: true });
  if (lead.email && !validEmail(lead.email)) lead.email = "";
  if (!lead.email && phoneDigits(lead.phone).length < 7) return out({ error: "no_contact" }, 400);

  const res = await fetch(`${SB_URL}/rest/v1/rpc/lead_intake_apply`, {
    method: "POST", headers: sb(), body: JSON.stringify({ p: { ...lead, dry } }),
  });
  const r: any = await res.json().catch(() => null);
  if (!res.ok || !r) { console.error("lead_intake_apply failed", res.status, r); return out({ error: "intake_failed" }, 500); }
  if (!r.ok) return out(r, r.error === "disabled" ? 200 : 400);
  if (dry) return out({ ok: true, dry: true, assignee: r.assignee ? { name: r.assignee.name } : null, dup: r.dup, followDays: r.followDays, parsed: lead });

  // ---- e-mail to the assignee
  const asg = r.assignee;
  if (asg && asg.email) {
    try {
      const navy = "#1a2e44", gold = "#c9a96e";
      const row = (k: string, v: string) => v ? `<tr><td style="padding:5px 0;color:#7a8694;font-size:13px;width:110px;vertical-align:top">${k}</td><td style="padding:5px 0;font-size:14px;font-weight:600;color:${navy}">${esc(v)}</td></tr>` : "";
      const subject = (r.dup ? "Zaujemca sa znova ozval: " : "Novy dopyt z webu: ") + (lead.name || lead.email || lead.phone);
      const html = `<!DOCTYPE html><html lang="sk"><head><meta charset="UTF-8"/></head><body style="font-family:Arial,sans-serif;background:#f5f1eb;margin:0;padding:24px 12px;color:${navy}">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
<div style="background:${navy};padding:18px 26px;border-bottom:4px solid ${gold};color:#fff;font-size:17px;font-weight:700">${r.dup ? "Zaujemca sa znova ozval" : "Novy dopyt z webu"}</div>
<div style="padding:24px 26px"><p style="margin:0 0 14px;font-size:14px">Dobry den ${esc(asg.name || "")}, cez formular na webe prisiel ${r.dup ? "opakovany " : "novy "}dopyt. V Keystone je pripraveny lead a uloha <b>Kontaktovat zaujemcu</b> (do konca dna).</p>
<table role="presentation" style="width:100%;border-collapse:collapse">${row("Meno", lead.name)}${row("E-mail", lead.email)}${row("Telefon", lead.phone)}${row("Lokalita", lead.location)}${row("Typ / velkost", lead.type)}${row("Sprava", lead.message)}</table>
<div style="text-align:center;margin:22px 0 4px"><a href="https://app.rsproperties.sk/" style="display:inline-block;background:${navy};color:#fff;text-decoration:none;font-weight:700;font-size:14px;border-radius:99px;padding:12px 28px;border:2px solid ${gold}">Otvorit v Keystone</a></div></div></div></body></html>`;
      const from = Deno.env.get("EMAIL_FROM") || "RS Properties <noreply@rsproperties.sk>";
      const rr = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [asg.email], subject, html, text: `${subject}\n\n${lead.name}\n${lead.email}\n${lead.phone}\n${lead.location}\n${lead.type}\n\n${lead.message}` }),
      });
      const rj = await rr.json().catch(() => ({}));
      await logResend(rr, rj, { to: asg.email, subject, template: "lead-intake", meta: { from } });
    } catch (e) { console.error("assignee mail failed", e); }
  }
  return out({ ok: true, dup: !!r.dup, leadId: r.leadId, taskId: r.taskId, assignee: asg ? { name: asg.name } : null });
});
