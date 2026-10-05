// RS Properties / Keystone — Supabase Edge Function
// Thin proxy to the Faktury Online API (https://www.faktury-online.com/api/).
// The API key travels in the URL there and CORS is undocumented, so the
// browser never sees it: it lives in the secrets FAKTURY_ONLINE_KEY and
// FAKTURY_ONLINE_EMAIL and every call goes through here.
//
// Auth: an ACTIVE team member with role admin (Supabase Auth token) or the
// service role key. Issuing invoices is a money action, so not every
// team role may do it.
//
// Actions (POST JSON {action, ...}):
//   ping                         init session + list last 7 days (read-only)
//   create  {apitest?, supplierId?, customer, doc, items}   -> /nf
//   status  {codes:[...]}        -> /status per code, trimmed to what Keystone needs
//   pdf     {code}               -> /zf, returns {number, base64}
//   mark_paid {code, date?}      -> /uf
//   list    {from, to, kind?}    -> /list/<created|issued|delivered|paid>, trimmed rows
//   details {codes:[...]}        -> /status per code, customer address block + totals
//   send    {code, to[], subject, bodyText} -> PDF from /zf, emailed via Resend (max 5 recipients)
//
// Numbering: NEVER pass f_number - Faktury Online numbers per supplier from
// its own series (RS Properties 2026NNN, RS Prime Group 2026-00NN). A test
// invoice (apitest) holds a number for 5-10 minutes, so a REAL create is
// refused while any leftover test invoice exists (customer "ZZTEST ..."/"TEST ...").
//
// Deploy: supabase functions deploy faktury-online --no-verify-jwt
// Secrets: FAKTURY_ONLINE_KEY, FAKTURY_ONLINE_EMAIL

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { logResend } from "../_shared/email_log.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FO_KEY = Deno.env.get("FAKTURY_ONLINE_KEY") || "";
const FO_EMAIL = Deno.env.get("FAKTURY_ONLINE_EMAIL") || "";
const FO_BASE = "https://www.faktury-online.com/api/";
// "RS Properties s. r. o." in the account's My companies list.
const DEFAULT_SUPPLIER_ID = 48103;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

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
  if (!auth) return false;
  if (auth === SERVICE_KEY || jwtRole(auth) === "service_role") return true;
  try {
    const ur = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${auth}` },
    });
    if (!ur.ok) return false;
    const uid = (await ur.json())?.id;
    if (!uid) return false;
    const tr = await fetch(
      `${SB_URL}/rest/v1/team_users?select=active,role&auth_user_id=eq.${encodeURIComponent(uid)}&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    const rows = await tr.json().catch(() => []);
    return Array.isArray(rows) && rows[0]?.active === true && rows[0]?.role === "admin";
  } catch {
    return false;
  }
}

// One Faktury Online "session" = the cookie that /init hands back; /zf, /uf,
// /status and /list/* need it, /nf does not.
class FoSession {
  cookie = "";
  async call(endpoint: string, data: Record<string, unknown>, withSession = true): Promise<any> {
    const payload = { ...data, key: FO_KEY, email: FO_EMAIL };
    const url = `${FO_BASE}${endpoint}?data=${encodeURIComponent(JSON.stringify(payload))}`;
    const headers: Record<string, string> = {};
    if (withSession && this.cookie) headers["Cookie"] = this.cookie;
    const res = await fetch(url, { headers });
    if (endpoint === "init") {
      const sc = (res.headers as any).getSetCookie?.() ||
        (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
      this.cookie = sc.map((c: string) => c.split(";")[0]).join("; ");
    }
    const txt = await res.text();
    try {
      return JSON.parse(txt);
    } catch {
      return { status: -1, error: "non-json response", http: res.status };
    }
  }
  async init(): Promise<boolean> {
    const r = await this.call("init", {}, false);
    return r?.status === 1;
  }
}

const str = (v: unknown, max = 300) => (v == null ? "" : String(v).slice(0, max));
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const TEST_NAME = /^(ZZTEST|TEST)( |$)/i;

async function leftoverTestInvoices(s: FoSession): Promise<string[]> {
  const day = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
  const r = await s.call("list/created", { from: day(-2), to: day(1) });
  if (r?.status !== 1) throw new Error(`cannot verify leftover test invoices (status ${r?.status})`);
  return (r.invoices || []).filter((i: any) => TEST_NAME.test(String(i.customer || ""))).map((i: any) => String(i.invoice_number));
}

function buildCreatePayload(b: any) {
  const c = b.customer || {};
  const d = b.doc || {};
  if (!str(c.name)) throw new Error("customer.name required");
  if (b.apitest && !TEST_NAME.test(String(c.name))) c.name = "ZZTEST " + c.name;
  const items = (Array.isArray(b.items) ? b.items : []).filter((i: any) => i && str(i.text));
  if (!items.length) throw new Error("items required");
  const f: Record<string, unknown> = {
    f_language: ["SK", "EN", "CS", "DE", "FR"].includes(String(d.language).toUpperCase())
      ? String(d.language).toUpperCase() : "SK",
    f_currency: str(d.currency || "EUR", 3),
    f_payment: "prevod",
  };
  // Type: 1 invoice, 2 proforma, 3 credit note, 4 debit note, 5 tax doc for a received payment.
  // Type 1 is ALWAYS numbered by Faktury Online (never pass f_number); the other types use
  // the user's manual series (ZA..., DD..., "DOBROPIS <invoice>") supplied by the caller.
  const type = [1, 2, 3, 4, 5].includes(Number(d.type)) ? Number(d.type) : 1;
  f.f_type = type;
  if (type !== 1 && d.number) f.f_number = str(d.number, 40);
  if ((type === 3 || type === 4) && d.originalNum) f.f_original_num = str(d.originalNum, 40);
  if (type === 5 && d.paymentDate) f.f_date_payment = str(d.paymentDate, 10);
  if (d.vs) f.f_vs = str(d.vs, 20);
  if (d.issue) f.f_date_issue = str(d.issue, 10);
  if (d.delivery) f.f_date_delivery = str(d.delivery, 10);
  if (d.due) f.f_date_due = str(d.due, 10);
  if (d.noteAbove) f.f_note_above = str(d.noteAbove, 1000);
  if (d.note) f.f_note = str(d.note, 1000);
  if (d.internalNote) f.f_internal_note = str(d.internalNote, 1000);
  if (d.order) f.f_order = str(d.order, 50);
  if (d.custom) f.f_custom = str(d.custom, 50);
  if (Array.isArray(d.tags) && d.tags.length) f.f_tags = d.tags.map((t: unknown) => str(t, 50));
  return {
    d: { d_id: Number(b.supplierId) || DEFAULT_SUPPLIER_ID },
    o: {
      o_name: str(c.name), o_street: str(c.street), o_city: str(c.city), o_zip: str(c.zip),
      o_state: str(c.state), o_ico: str(c.ico), o_dic: str(c.dic), o_icdph: str(c.icdph),
      o_email: str(c.email),
    },
    f,
    p: items.map((i: any) => {
      const row: Record<string, unknown> = {
        p_text: str(i.text, 500), p_quantity: num(i.quantity) || 1, p_unit: str(i.unit || "ks", 10),
      };
      if (i.priceVat != null && i.price == null) row.p_pricevat = num(i.priceVat);
      else row.p_price = num(i.price);
      if (i.vat != null) row.p_vat = num(i.vat);
      if (i.regime != null && Number(i.regime) > 0) row.p_regime = Math.min(6, Math.floor(Number(i.regime)));
      return row;
    }),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);
  if (!FO_KEY || !FO_EMAIL) return reply({ error: "Faktury Online secrets not configured" }, 500);
  if (!(await callerAllowed(req))) return reply({ error: "forbidden" }, 403);

  let b: any;
  try {
    b = await req.json();
  } catch {
    return reply({ error: "invalid json" }, 400);
  }

  try {
    const s = new FoSession();
    switch (b.action) {
      case "ping": {
        if (!(await s.init())) return reply({ ok: false, error: "init failed" }, 502);
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
        const r = await s.call("list/issued", { from, to });
        return reply({ ok: r?.status === 1, status: r?.status, issuedLast7d: (r?.invoices || []).length });
      }
      case "create": {
        const payload: Record<string, unknown> = buildCreatePayload(b);
        const wantNum = (payload.f as any)?.f_number;
        if (wantNum) {
          if (!(await s.init())) return reply({ ok: false, error: "init failed" }, 502);
          const from = new Date(Date.now() - 900 * 864e5).toISOString().slice(0, 10);
          const to = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
          const ex = await s.call("list/created", { from, to });
          if (ex?.status !== 1) throw new Error(`cannot verify number uniqueness (status ${ex?.status})`);
          const dup = (ex.invoices || []).find((i: any) => String(i.invoice_number).trim().toLowerCase() === String(wantNum).trim().toLowerCase());
          if (dup) return reply({ ok: false, error: "duplicate_number", message: `Číslo ${wantNum} už vo Faktúry Online existuje (${dup.customer}). Zvoľ iné.` }, 409);
        }
        if (b.apitest) payload.apitest = 1;
        else {
          if (!(await s.init())) return reply({ ok: false, error: "init failed" }, 502);
          const left = await leftoverTestInvoices(s);
          if (left.length) {
            return reply({ ok: false, error: "test_invoice_pending", message: `Vo Faktúry Online ešte existuje testovacia faktúra (${left.join(", ")}). Počkaj, kým sa sama zmaže (do ~10 min), inak by skutočná faktúra dostala vyššie číslo a v číslovaní vznikne diera.`, leftover: left }, 409);
          }
        }
        const r = await s.call("nf", payload, false);
        if (r?.status !== 1) return reply({ ok: false, status: r?.status, error: `Faktury Online error ${r?.status}` }, 422);
        return reply({ ok: true, code: r.code, number: r.number, created: r.created, apitest: !!b.apitest });
      }
      case "status": {
        const codes: string[] = (Array.isArray(b.codes) ? b.codes : []).filter((c: unknown) => typeof c === "string").slice(0, 60);
        if (!(await s.init())) return reply({ ok: false, error: "init failed" }, 502);
        const out: Record<string, unknown> = {};
        for (const code of codes) {
          const r = await s.call("status", { code });
          out[code] = r?.status === 1
            ? {
              ok: true, number: r.invoice_number, paid: r.invoice_paid, // ano | nie | ciastocne
              paidAmount: num(r.invoice_paid_amount), paidDate: r.invoice_date_payment || null,
              amount: num(r.invoice_amount), amountVat: num(r.invoice_amount_vat ?? r.invoice_amount),
              toPay: num(r.invoice_to_pay), due: r.invoice_date_due || null,
              customer: r.customer || "", currency: r.invoice_currency || "EUR",
            }
            : { ok: false, status: r?.status };
        }
        return reply({ ok: true, invoices: out });
      }
      case "pdf": {
        if (!b.code) return reply({ error: "code required" }, 400);
        if (!(await s.init())) return reply({ ok: false, error: "init failed" }, 502);
        const r = await s.call("zf", { code: String(b.code) });
        if (r?.status !== 1) return reply({ ok: false, status: r?.status }, 422);
        const pr = await fetch(r.url, { headers: s.cookie ? { Cookie: s.cookie } : {}, redirect: "follow" });
        const buf = new Uint8Array(await pr.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return reply({ ok: true, number: r.number, base64: btoa(bin), bytes: buf.length });
      }
      case "mark_paid": {
        if (!b.code) return reply({ error: "code required" }, 400);
        if (!(await s.init())) return reply({ ok: false, error: "init failed" }, 502);
        const data: Record<string, unknown> = { code: String(b.code) };
        if (b.date) data.date = str(b.date, 10);
        const r = await s.call("uf", data);
        return reply({ ok: r?.status === 1, status: r?.status });
      }
      case "list": {
        const kind = ["created", "issued", "delivered", "paid"].includes(b.kind) ? b.kind : "issued";
        if (!(await s.init())) return reply({ ok: false, error: "init failed" }, 502);
        const data: Record<string, unknown> = {};
        if (b.from) data.from = str(b.from, 10);
        if (b.to) data.to = str(b.to, 10);
        const r = await s.call(`list/${kind}`, data);
        if (r?.status !== 1) return reply({ ok: false, status: r?.status }, 422);
        const rows = (r.invoices || []).map((i: any) => ({
          code: i.code, supplier: i.supplier, supplierIco: i.supplier_ico,
          customer: i.customer, customerIco: i.customer_ico,
          type: i.invoice_type, number: i.invoice_number,
          amount: num(i.invoice_amount), amountVat: num(i.invoice_amount_vat ?? i.invoice_amount),
          currency: i.invoice_currency || "EUR",
          issue: i.invoice_date_issue || null, delivery: i.invoice_date_delivery || null, due: i.invoice_date_due || null,
          paid: i.invoice_paid, paidAmount: num(i.invoice_paid_amount), paidDate: i.invoice_date_payment || null,
          tags: i.tags || "",
        }));
        return reply({ ok: true, count: rows.length, invoices: rows });
      }
      case "details": {
        const codes: string[] = (Array.isArray(b.codes) ? b.codes : []).filter((c: unknown) => typeof c === "string").slice(0, 40);
        if (!(await s.init())) return reply({ ok: false, error: "init failed" }, 502);
        const out: Record<string, unknown> = {};
        for (const code of codes) {
          const r = await s.call("status", { code });
          out[code] = r?.status === 1
            ? {
              ok: true, number: r.invoice_number, vs: r.invoice_vs, currency: r.invoice_currency,
              customer: {
                name: r.customer, street: r.customer_street, city: r.customer_city, zip: r.customer_zip,
                state: r.customer_state, ico: r.customer_ico, dic: r.customer_dic, icdph: r.customer_icdph,
                email: r.customer_email,
              },
              supplier: r.supplier, language: r.invoice_language, items: r.items || [],
            }
            : { ok: false, status: r?.status };
        }
        return reply({ ok: true, invoices: out });
      }
      case "send": {
        const to: string[] = (Array.isArray(b.to) ? b.to : []).map((x: unknown) => String(x).trim())
          .filter((x: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 5);
        if (!b.code || !to.length || !b.subject || !b.bodyText) return reply({ error: "code, to[], subject, bodyText required" }, 400);
        if (!(await s.init())) return reply({ ok: false, error: "init failed" }, 502);
        const r = await s.call("zf", { code: String(b.code) });
        if (r?.status !== 1) return reply({ ok: false, status: r?.status, error: "pdf failed" }, 422);
        const pr = await fetch(r.url, { headers: s.cookie ? { Cookie: s.cookie } : {}, redirect: "follow" });
        const buf = new Uint8Array(await pr.arrayBuffer());
        if (buf.length < 1000 || String.fromCharCode(...buf.subarray(0, 4)) !== "%PDF") return reply({ ok: false, error: "pdf download invalid" }, 502);
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        const esc = (x: string) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#1a2e44;white-space:pre-wrap">${esc(String(b.bodyText))}</body></html>`;
        const from = Deno.env.get("FAKTURY_EMAIL_FROM") || "RS Properties <faktury@rsproperties.sk>";
        const results: unknown[] = [];
        for (const addr of to) {
          const rr = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from, to: [addr], reply_to: "faktury@rsproperties.sk", subject: String(b.subject).slice(0, 200), html,
              attachments: [{ filename: `${String(r.number).replace(/[^\w.-]/g, "_")}.pdf`, content: btoa(bin) }],
            }),
          });
          const parsed = await rr.json().catch(() => ({}));
          await logResend(rr, parsed, { to: addr, subject: String(b.subject), template: "faktury-online-invoice", meta: { from, invoice: r.number } });
          results.push({ to: addr, ok: rr.ok && !!parsed.id });
        }
        return reply({ ok: results.some((x: any) => x.ok), number: r.number, results });
      }
      default:
        return reply({ error: "unknown action" }, 400);
    }
  } catch (e) {
    return reply({ ok: false, error: String((e as Error).message || e) }, 400);
  }
});
