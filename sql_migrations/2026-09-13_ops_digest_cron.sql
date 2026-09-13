-- ============================================================
-- ops-digest cron — 2026-09-13
--
-- Runs the ops-digest Edge Function once a day so admins get a short
-- "is everything OK" email (Team Health / Data Integrity / backup
-- freshness / failed-email count) without having to remember to open
-- any of those screens by hand.
--
-- Reuses the same Vault secret as hostex-daily-sync
-- ('edge_service_role_key', already created 2026-09-10) — not recreated
-- here. Manual runs still work via the "📧 Send digest now" button in
-- Team Members (admin only).
--
-- Schedule: 06:00 UTC daily — after hostex-daily-sync (05:07 UTC) so the
-- two cron jobs don't overlap, before most of the team's workday starts.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- idempotent: drop any earlier version of this job before recreating
select cron.unschedule('ops-digest')
where exists (select 1 from cron.job where jobname = 'ops-digest');

select cron.schedule(
  'ops-digest',
  '0 6 * * *',
  $$
  select net.http_post(
    url     := 'https://jswqdjevbncfqinntajg.supabase.co/functions/v1/ops-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_service_role_key')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
