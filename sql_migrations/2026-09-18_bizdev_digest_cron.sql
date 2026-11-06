-- ============================================================
-- bizdev-digest cron — 2026-09-18
--
-- Runs the bizdev-digest Edge Function once a week so whoever owns the
-- Business Development pipeline (admins + anyone granted the 'bizdev'
-- TM_GROUPS permission) gets a summary — active leads, won/lost this
-- month, conversion rate, overdue follow-ups, stalled leads — without
-- having to remember to open the Obchodný pipeline tab.
--
-- Reuses the same Vault secret as hostex-daily-sync/ops-digest
-- ('edge_service_role_key', already created 2026-09-10) — not recreated
-- here.
--
-- Schedule: Monday 06:30 UTC — after the daily hostex-daily-sync
-- (05:07 UTC) and ops-digest (06:00 UTC) jobs so none overlap.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- idempotent: drop any earlier version of this job before recreating
select cron.unschedule('bizdev-digest')
where exists (select 1 from cron.job where jobname = 'bizdev-digest');

select cron.schedule(
  'bizdev-digest',
  '30 6 * * 1',
  $$
  select net.http_post(
    url     := 'https://jswqdjevbncfqinntajg.supabase.co/functions/v1/bizdev-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_service_role_key')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
