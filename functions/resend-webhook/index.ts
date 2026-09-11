// RS Properties / Keystone — Supabase Edge Function
// Receives Resend delivery-status webhooks (delivered / bounced /
// complained / opened) and upserts the status onto the matching
// email_log row by resend_id, so the Email Log admin view shows more
// than just "accepted by Resend".
//
// Setup (one-time, in the Resend dashboard):
//   1. https://resend.com/webhooks -> Add Webhook
//   2. Endpoint URL: https://jswqdjevbncfqinntajg.supabase.co/functions/v1/resend-webhook
//   3. Events: email.delivered, email.bounced, email.complained, email.opened
//      (email.sent / email.delivery_delayed / email.clicked are ignored -
//      "sent" duplicates what logResend already records as "accepted")
//   4. Resend shows a signing secret starting "whsec_" - copy it and set it
//      as a Supabase secret named RESEND_WEBHOOK_SECRET:
//        supabase secrets set RESEND_WEBHOOK_SECRET=whsec_xxxxx
//      (or via the Supabase dashboard -> Edge Functions -> Secrets)
//
// Deploy: supabase functions deploy resend-webhook --no-verify-jwt
//   (--no-verify-jwt is required - Resend can't send a Supabase auth
//   token, so the platform's own JWT gate has to be off for this one
//   function; the Svix signature check below is what actually verifies
//   the request came from Resend)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET") || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "svix-id, svix-timestamp, svix-signature, content-type",
};

// Resend webhooks are signed the Svix way: HMAC-SHA256 over
// "{svix-id}.{svix-timestamp}.{raw-body}" using the secret after its
// "whsec_" prefix is base64-decoded. svix-signature carries one or more
// "v1,<base64>" values (space-separated) - a match on any is valid.
async function verifySignature(rawBody: string, headers: Headers): Promise<boolean> {
  if (!WEBHOOK_SECRET) return false; // fail closed if not configured
  const id = headers.get("svix-id");
  const ts = headers.get("svix-timestamp");
  const sigHeader = headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;

  const secretB64 = WEBHOOK_SECRET.replace(/^whsec_/, "");
  const keyBytes = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signedContent = `${id}.${ts}.${rawBody}`;
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

  return sigHeader.split(" ").some((part) => {
    const [, b64] = part.split(",");
    return b64 === expected;
  });
}

function sbHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
}

const STATUS_MAP: Record<string, string> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.opened": "opened",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const rawBody = await req.text();

  if (!(await verifySignature(rawBody, req.headers))) {
    return new Response(JSON.stringify({ error: "invalid signature" }), {
      status: 401,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const status = STATUS_MAP[event?.type];
  const resendId = event?.data?.email_id;
  if (!status || !resendId) {
    // Not an event we track (e.g. email.sent, email.clicked) - ack anyway
    // so Resend doesn't retry it forever.
    return new Response(JSON.stringify({ ok: true, skipped: true }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // "opened" shouldn't downgrade a later "bounced"/"complained" - only
  // upgrade from accepted/delivered. Simplicity: opened only overwrites
  // 'accepted' or 'delivered'; bounced/complained always win.
  const patchBody: Record<string, unknown> = { status };
  const url = status === "opened"
    ? `${SB_URL}/rest/v1/email_log?resend_id=eq.${encodeURIComponent(resendId)}&status=in.(accepted,delivered)`
    : `${SB_URL}/rest/v1/email_log?resend_id=eq.${encodeURIComponent(resendId)}`;

  const patch = await fetch(url, {
    method: "PATCH",
    headers: { ...sbHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify(patchBody),
  });

  if (!patch.ok) {
    const t = await patch.text();
    console.error("resend-webhook: patch failed", t.slice(0, 300));
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
