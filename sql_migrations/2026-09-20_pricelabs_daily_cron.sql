-- ============================================================
-- pricelabs-daily-sync cron — 2026-09-20
--
-- Runs the pricelabs-daily-sync Edge Function once a day so "📊 Aktuálny
-- mesiac" can show each mapped property's PriceLabs pricing calendar for
-- the next two weeks (Round-2 roadmap item #5). Only properties with a
-- `pricelabsListingId` set (Properties → edit → Linky tab) are synced.
--
-- Inactive until PRICELABS_API_KEY is set as a function secret — until
-- then the function itself returns 501 (pricelabs_api_key_not_configured)
-- and does nothing else; this job existing early is harmless. Set the key
-- with:
--   supabase secrets set PRICELABS_API_KEY=<key> --project-ref jswqdjevbncfqinntajg
--
-- Uses the same vault secret pattern as hostex-daily-sync/bizdev-digest
-- ('edge_service_role_key') — already exists, nothing new to create.
--
-- Schedule: 05:20 UTC daily — after hostex-daily-sync (05:07) and before
-- ops-digest (06:00), so any future digest work can read a fresh
-- pricelabsLive snapshot.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('pricelabs-daily-sync')
where exists (select 1 from cron.job where jobname = 'pricelabs-daily-sync');

select cron.schedule(
  'pricelabs-daily-sync',
  '20 5 * * *',
  $$
  select net.http_post(
    url     := 'https://jswqdjevbncfqinntajg.supabase.co/functions/v1/pricelabs-daily-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_service_role_key')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
