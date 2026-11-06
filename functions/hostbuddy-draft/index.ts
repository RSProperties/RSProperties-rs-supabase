// RS Properties / Keystone — Operácie: "Navrhnúť odpoveď".
// Asks HostBuddy for an AI-suggested reply to the latest guest message of ONE conversation and
// returns it together with the last few messages for context. It NEVER sends anything to the guest:
// only GET /conversations/{id} and POST /conversations/{id}/draft are called (the send endpoint
// is not used anywhere in this function).
// Auth: service role or an ACTIVE team member (shared gate).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callerAllowed } from "../_shared/caller_auth.ts";

const KEY = Deno.env.get("HOSTBUDDY_API_KEY") ?? "";
const BASE = "https://api.hostbuddy.ai/api/v1";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const J = { ...CORS, "Content-Type": "application/json" };
const out = (o: unknown, status = 200) => new Response(JSON.stringify(o), { headers: J, status });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(await callerAllowed(req))) return out({ error: "forbidden" }, 403);
  if (!KEY) return out({ error: "hostbuddy_api_key_not_configured" }, 501);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const id = String(body?.conversation_id || "");
  if (!/^[\w.:-]{3,120}$/.test(id)) return out({ error: "bad_conversation_id" }, 400);
  const H = { "X-API-Key": KEY, "Content-Type": "application/json" };
  const [cr, dr] = await Promise.all([
    fetch(`${BASE}/conversations/${encodeURIComponent(id)}`, { headers: H }),
    fetch(`${BASE}/conversations/${encodeURIComponent(id)}/draft`, { method: "POST", headers: H, body: "{}" }),
  ]);
  const conv = cr.ok ? await cr.json().catch(() => null) : null;
  const draftRaw = await dr.json().catch(() => null);
  if (!dr.ok) return out({ error: "draft_failed", status: dr.status, detail: JSON.stringify(draftRaw).slice(0, 300) }, 502);
  const msgs = Array.isArray(conv?.messages) ? conv.messages.slice(-6).map((m: any) => ({ sender: m.sender, text: String(m.text || "").slice(0, 1200), time: m.time_utc })) : [];
  return out({ ok: true, draft: draftRaw, messages: msgs, guest: conv?.guest_name || "", channel: conv?.channel || "" });
});
