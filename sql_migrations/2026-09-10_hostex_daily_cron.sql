-- ============================================================
-- hostex-daily-sync cron — 2026-09-10
--
-- Runs the hostex-daily-sync Edge Function once a day so the team can see
-- live month-to-date numbers for the current, still-running month
-- (Keystone "Aktuálny mesiac" view). The function pulls the current
-- month's reservations for every property with a hostexPropertyId and
-- caches them in workspace key `hostexLive`.
--
-- The service_role key it needs is NOT in this file — it lives in
-- Supabase Vault under name 'edge_service_role_key' (created ad-hoc, so
-- this migration is safe to commit). Recreate it with:
--   select vault.create_secret('<service_role_key>', 'edge_service_role_key');
--
-- Schedule: 05:07 UTC daily (~06:07–07:07 local, before the workday).
-- Manual runs still work via the "Sync teraz" button in the app.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- idempotent: drop any earlier version of this job before recreating
select cron.unschedule('hostex-daily-sync')
where exists (select 1 from cron.job where jobname = 'hostex-daily-sync');

select cron.schedule(
  'hostex-daily-sync',
  '7 5 * * *',
  $$
  select net.http_post(
    url     := 'https://jswqdjevbncfqinntajg.supabase.co/functions/v1/hostex-daily-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_service_role_key')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
