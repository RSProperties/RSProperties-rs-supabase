// RS Properties / Keystone - Supabase Edge Function: navrh odpovede (Claude) a odoslanie odpovede klientovi z info@ cez Resend.
// Vola ju Keystone (okno "Posta") s tokenom clena timu s pravom bizdev=edit (alebo admin). Prijemca je VZDY odosielatel ulozeneho mailu
// (nikdy z poziadavky), kopia (bcc) ide na info@. Nic sa neposiela bez kliknutia cloveka v Keystone.
// Secrets: RESEND_API_KEY, ANTHROPIC_API_KEY, MAIL_REPLY_FROM (volitelny), MAIL_DRAFT_MODEL (volitelny)
// Logika je v handler.mjs / core.mjs (testovatelna v Node).
// NOTE: keep this file plain ASCII.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createReplyHandler } from "./handler.mjs";

const handle = createReplyHandler({
  env: {
    SUPABASE_URL: Deno.env.get("SUPABASE_URL") || "",
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    RESEND_API_KEY: Deno.env.get("RESEND_API_KEY") || "",
    ANTHROPIC_API_KEY: Deno.env.get("ANTHROPIC_API_KEY") || "",
    MAIL_REPLY_FROM: Deno.env.get("MAIL_REPLY_FROM") || "",
    MAIL_DRAFT_MODEL: Deno.env.get("MAIL_DRAFT_MODEL") || "",
    AGENT_BRIEFING_MODEL: Deno.env.get("AGENT_BRIEFING_MODEL") || "",
  },
});
serve((req) => handle(req));
