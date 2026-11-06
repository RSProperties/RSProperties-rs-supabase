// RS Properties / Keystone - Supabase Edge Function: price tracking for supply items.
// Actions (POST json):
//   probe   {url, baseUnit?}  -> reads one product page, returns {title, price, packGuess, image}. Used when adding a source.
//   refresh {ids?, force?}    -> re-reads the price of sources (all auto-price ones when no ids) and writes it to supply_sources
//                                (+ a row in supply_price_log when the price changed). Called daily by pg_cron.
// Auth: service role (cron) or an ACTIVE team member's token (same rule as the other functions here).
// Safety: only https URLs on public hosts are fetched (no IP literals, localhost, private ranges), max 3 redirects,
//         10 s timeout, 1.5 MB read limit. A shop that blocks robots (Alza, B2B shops behind a login) just returns an error
//         and the price stays manual.
// Deploy: supabase functions deploy supply-price --no-verify-jwt
// NOTE: keep this file plain ASCII.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callerAllowed } from "../_shared/caller_auth.ts";
import { extractProduct, guessPackQty } from "./parse.mjs";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const JH = { ...CORS, "Content-Type": "application/json" };
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_BYTES = 1_500_000;

function sb() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
}
const out = (o: unknown, status = 200) => new Response(JSON.stringify(o), { headers: JH, status });

function privateIp(ip: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:");
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("bad_url"); }
  if (u.protocol !== "https:") throw new Error("only_https");
  if (u.username || u.password) throw new Error("bad_url");
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) throw new Error("blocked_host");
  if (/^[\d.]+$/.test(h) || h.includes(":")) throw new Error("blocked_host");
  try {
    const ips = [...(await Deno.resolveDns(h, "A").catch(() => [])), ...(await Deno.resolveDns(h, "AAAA").catch(() => []))];
    if (ips.some((ip) => privateIp(String(ip)))) throw new Error("blocked_host");
  } catch (e) {
    if (String(e).includes("blocked_host")) throw e;
  }
  return u;
}

async function fetchPage(raw: string): Promise<string> {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(url);
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(u.toString(), { redirect: "manual", signal: ctl.signal, headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "sk,cs;q=0.9,en;q=0.8" } });
    } catch (e) {
      throw new Error(String(e).includes("abort") ? "timeout" : "fetch_failed");
    } finally { clearTimeout(to); }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, u).toString();
      continue;
    }
    if (res.status === 401 || res.status === 403 || res.status === 429) throw new Error("blocked_by_shop");
    if (!res.ok) throw new Error("http_" + res.status);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("empty");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    const buf = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
  throw new Error("too_many_redirects");
}

async function readPrice(url: string, baseUnit: string) {
  const html = await fetchPage(url);
  const p = extractProduct(html, url);
  if (p.price === null) throw new Error("price_not_found");
  if (p.currency && p.currency !== "EUR") throw new Error("currency_" + p.currency);
  return { ...p, packGuess: guessPackQty(p.title, baseUnit) };
}

async function refreshOne(row: any) {
  try {
    const r = await readPrice(row.url, "");
    const changed = row.price === null || Math.abs(Number(row.price) - r.price) > 0.0049;
    await fetch(`${SB_URL}/rest/v1/supply_sources?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH", headers: { ...sb(), Prefer: "return=minimal" },
      body: JSON.stringify({ price: r.price, price_checked_at: new Date().toISOString(), price_origin: "auto", last_error: "", title: row.title || r.title }),
    });
    if (changed) {
      await fetch(`${SB_URL}/rest/v1/supply_price_log`, { method: "POST", headers: { ...sb(), Prefer: "return=minimal" }, body: JSON.stringify({ source_id: row.id, price: r.price }) });
    }
    return { id: row.id, ok: true, price: r.price, changed };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 120);
    await fetch(`${SB_URL}/rest/v1/supply_sources?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH", headers: { ...sb(), Prefer: "return=minimal" },
      body: JSON.stringify({ last_error: msg, price_checked_at: new Date().toISOString() }),
    }).catch(() => {});
    return { id: row.id, ok: false, error: msg };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(await callerAllowed(req))) return out({ error: "forbidden" }, 403);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body = refresh */ }
  const action = body.action || "refresh";

  if (action === "probe") {
    try {
      const r = await readPrice(String(body.url || ""), String(body.baseUnit || ""));
      return out({ ok: true, title: r.title, price: r.price, currency: r.currency || "EUR", image: r.image, packGuess: r.packGuess });
    } catch (e) {
      return out({ ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 120) });
    }
  }

  if (action === "refresh") {
    const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 100) : [];
    let q = `${SB_URL}/rest/v1/supply_sources?select=id,url,price,title,auto_price,price_checked_at&active=eq.true&url=neq.&order=price_checked_at.asc.nullsfirst&limit=60`;
    if (ids.length) q += `&id=in.(${ids.map((i) => `"${i.replace(/"/g, "")}"`).join(",")})`;
    else q += "&auto_price=eq.true";
    const rows: any[] = await fetch(q, { headers: sb() }).then((r) => r.json()).catch(() => []);
    if (!Array.isArray(rows)) return out({ ok: false, error: "db" }, 500);
    const cutoff = Date.now() - 20 * 3600 * 1000;
    const todo = rows.filter((r) => body.force || ids.length || !r.price_checked_at || new Date(r.price_checked_at).getTime() < cutoff);
    const results: any[] = [];
    let i = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < todo.length) { const row = todo[i++]; results.push(await refreshOne(row)); }
    }));
    return out({ ok: true, checked: results.length, updated: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
  }
  return out({ error: "unknown_action" }, 400);
});
