// RS Properties / Keystone - Supabase Edge Function
// Generates the municipal accommodation-tax / waste-fee notifications as real Word documents and optionally e-mails them.
//   Bratislava            ba_month    monthly "Mesacne vyuctovanie dane za ubytovanie"
//   Liptovsky Mikulas     lm_tax_q    quarterly "Hlasenie k miestnej dani za ubytovanie"
//   Liptovsky Mikulas     lm_waste_q  quarterly "Hlasenie k poplatku za komunalne odpady"
// The templates are the team's own Word documents (layout, fonts and city logos untouched) with {{PLACEHOLDERS}};
// all arithmetic is in citytax_lib.mjs (shared with the local tests).
//
// POST { action: "generate" | "send", docs:[{ type, input:{...} }] (1-12), stampB64?, to?:[], subject?, bodyText? }
//   generate -> { ok, files:[{ type, filename, b64, summary }] }
//   send     -> { ok, files:[{ type, filename, summary }], results:[{to, ok}] }   (all .docx files are attached to ONE message per recipient)
// stampB64 = optional PNG (base64) of the taxpayer's stamp/signature, embedded in the Liptovsky Mikulas documents.
// Auth: service role or an ACTIVE team member's token (same rule as the other send/generate functions).
// Deploy: npx supabase functions deploy citytax-document --project-ref jswqdjevbncfqinntajg --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import JSZip from "npm:jszip@3.10.1";
import { callerAllowed } from "../_shared/caller_auth.ts";
import { logResend } from "../_shared/email_log.ts";
import { buildDocument, calc, TYPES } from "./citytax_lib.mjs";
import { TEMPLATES } from "./templates_b64.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const J = { ...CORS, "Content-Type": "application/json" };
const reply = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: J });

// File names follow the team's existing convention: "<label> MM_YYYY" (month/year; a slash is not allowed in file names).
// Bratislava: "city tax BA 04_2026"; Liptovsky Mikulas quarters: "Dan_z_ubytovania 01_2026", "komunalne_odpady 01_2026".
const FILE_PREFIX: Record<string, string> = { ba_month: "city tax BA", lm_tax_q: "Dan_z_ubytovania", lm_waste_q: "komunalne_odpady" };
function fileNameFor(type: string, period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period), q = /^(\d{4})-Q([1-4])$/.exec(period);
  const mmyyyy = m ? `${m[2]}_${m[1]}` : q ? `0${q[2]}_${q[1]}` : period;
  return `${FILE_PREFIX[type]} ${mmyyyy}.docx`;
}
const esc = (x: string) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Stamp / signature image supplied by the client as base64 PNG (kept small by the client; validated here).
function loadStamp(b64: unknown): Uint8Array | null {
  const t = String(b64 || "").replace(/^data:image\/png;base64,/, "");
  if (!t || t.length > 900_000) return null;
  try {
    const b = b64ToBytes(t);
    return b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? b : null;
  } catch {
    return null;
  }
}

function cleanInput(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v.slice(0, 300);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  if (!(await callerAllowed(req))) return reply({ error: "forbidden" }, 403);
  try {
    const b = await req.json();
    const docsIn: { type?: string; input?: unknown }[] = Array.isArray(b.docs) ? b.docs.slice(0, 12) : [];
    if (!docsIn.length) return reply({ error: "docs[] required" }, 400);
    const stamp = loadStamp(b.stampB64);
    const files: { type: string; filename: string; b64: string; summary: unknown }[] = [];
    for (const d of docsIn) {
      const type = String(d.type || "");
      if (!TYPES.includes(type)) return reply({ error: "unknown_type" }, 400);
      const input = cleanInput(d.input);
      const { summary } = calc(type, input);
      const docx: Uint8Array = await buildDocument(JSZip, b64ToBytes(TEMPLATES[type]), type, input, type === "ba_month" ? null : stamp);
      const period = String(input.period || "").replace(/[^0-9A-Za-z-]/g, "");
      const filename = fileNameFor(type, period);
      files.push({ type, filename, b64: bytesToB64(docx), summary });
    }

    if (b.action === "generate") return reply({ ok: true, files });

    if (b.action === "send") {
      const to: string[] = (Array.isArray(b.to) ? b.to : []).map((x: unknown) => String(x).trim())
        .filter((x: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 5);
      const subject = String(b.subject || "").slice(0, 200), bodyText = String(b.bodyText || "").slice(0, 4000);
      if (!to.length || !subject || !bodyText) return reply({ error: "to[], subject, bodyText required" }, 400);
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#1a2e44;white-space:pre-wrap">${esc(bodyText)}</body></html>`;
      const from = Deno.env.get("EMAIL_FROM") || "RS Properties <info@rsproperties.sk>";
      const attachments = files.map((f) => ({ filename: f.filename, content: f.b64 }));
      const results: { to: string; ok: boolean }[] = [];
      for (const addr of to) {
        const rr = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [addr], reply_to: "info@rsproperties.sk", subject, html, attachments }),
        });
        const parsed = await rr.json().catch(() => ({}));
        await logResend(rr, parsed, { to: addr, subject, template: "citytax-document", meta: { from, files: files.map((f) => f.filename) } });
        results.push({ to: addr, ok: rr.ok && !!(parsed as { id?: string }).id });
      }
      return reply({ ok: results.some((x) => x.ok), files: files.map((f) => ({ type: f.type, filename: f.filename, summary: f.summary })), results });
    }
    return reply({ error: "unknown_action" }, 400);
  } catch (e) {
    return reply({ ok: false, error: String((e as Error).message || e) }, 400);
  }
});
