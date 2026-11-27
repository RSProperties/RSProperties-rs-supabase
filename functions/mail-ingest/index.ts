// RS Properties / Keystone - Supabase Edge Function: prichadzajuca posta od znamych kontaktov (FAZA 1, len citanie).
// Lokalny poller na Macu (~/agents/mail/mail_poller.py, IMAP len na citanie) posle maily od odosielatelov, ktorych pozname
// (kontakt leadu / majitel). Funkcia ich zaradi k leadu, Claude (bez nastrojov - text mailu je len udaj) urci zamer a suhrn,
// ulozi cez mail_put(). NIC sa neodosiela klientom a ziadny stav leadu sa nemeni.
// Verejny endpoint (bez JWT) - chraneny tajnym klucom v hlavicke x-agent-key (secret AGENT_INGEST_KEY, rovnaky ako agent-briefing-ingest).
// Logika je v handler.mjs / core.mjs (testovatelna v Node).
// Deploy: supabase functions deploy mail-ingest --no-verify-jwt
// Secrets: AGENT_INGEST_KEY, ANTHROPIC_API_KEY (uz existuju), MAIL_CLASSIFY_MODEL (volitelny)
// NOTE: keep this file plain ASCII.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createHandler } from "./handler.mjs";

const handle = createHandler({
  env: {
    SUPABASE_URL: Deno.env.get("SUPABASE_URL") || "",
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    AGENT_INGEST_KEY: Deno.env.get("AGENT_INGEST_KEY") || "",
    ANTHROPIC_API_KEY: Deno.env.get("ANTHROPIC_API_KEY") || "",
    MAIL_CLASSIFY_MODEL: Deno.env.get("MAIL_CLASSIFY_MODEL") || "",
    AGENT_BRIEFING_MODEL: Deno.env.get("AGENT_BRIEFING_MODEL") || "",
  },
});
serve((req) => handle(req));
