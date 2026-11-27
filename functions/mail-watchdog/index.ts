// RS Properties / Keystone - Supabase Edge Function: strazca synchronizacie postu (info@ -> Keystone).
// pg_cron ho vola kazdych 15 min (service role). Ak poller na Macu dlhsie nebezi / zlyhava, alebo Claude nevyhodnocuje prichadzajuce
// spravy, posle e-mail na info@ (a po obnoveni jeden "uz funguje"). Nic nemeni v poste ani v leadoch. Logika: core.mjs / handler.mjs.
// Deploy: verify_jwt ZAPNUTE (predvolene) - volat ho moze len service role.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY (uz existuju), MAIL_ALERT_FROM (volitelny)
// NOTE: keep this file plain ASCII.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createWatchdogHandler } from "./handler.mjs";

const handle = createWatchdogHandler({
  env: {
    SUPABASE_URL: Deno.env.get("SUPABASE_URL") || "",
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    RESEND_API_KEY: Deno.env.get("RESEND_API_KEY") || "",
    MAIL_ALERT_FROM: Deno.env.get("MAIL_ALERT_FROM") || "",
  },
});
serve((req) => handle(req));
