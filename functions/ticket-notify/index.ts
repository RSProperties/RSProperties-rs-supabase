// RS Properties / Keystone - Supabase Edge Function: upozornenia k ticketom (VA / EvoAssist + tim).
// Vola ju len service role: trigger na ticket_events (e-mail pri novom tickete, pridelenom, odpovedi hosta, refunde, eskalacii, uzavreti)
// a pg_cron (denny follow-up prehlad). Logika: core.mjs / handler.mjs. Deploy: verify_jwt ZAPNUTE.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY (uz existuju), MAIL_ALERT_FROM (volitelny)
// NOTE: keep this file plain ASCII.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createNotifyHandler } from "./handler.mjs";

const handle = createNotifyHandler({
  env: {
    SUPABASE_URL: Deno.env.get("SUPABASE_URL") || "",
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    RESEND_API_KEY: Deno.env.get("RESEND_API_KEY") || "",
    MAIL_ALERT_FROM: Deno.env.get("MAIL_ALERT_FROM") || "",
  },
});
serve((req) => handle(req));
