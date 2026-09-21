-- ============================================================
-- hostbuddy-daily-sync cron — 2026-09-21
--
-- Runs the hostbuddy-daily-sync Edge Function every 30 minutes so
-- "📊 Aktuálny mesiac" can show HostBuddy's incomplete action items
-- (guest-reported maintenance/cleanliness/requests) with a one-click
-- "convert to Task" — Round-2 roadmap item #4. More frequent than the
-- once-daily Hostex/PriceLabs syncs on purpose: these are live guest
-- issues, not revenue numbers, and staying fresh within the working day
-- matters more here.
--
-- Uses the same vault secret pattern as every other cron job here
-- ('edge_service_role_key') — already exists, nothing new to create.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('hostbuddy-sync')
where exists (select 1 from cron.job where jobname = 'hostbuddy-sync');

select cron.schedule(
  'hostbuddy-sync',
  '*/30 * * * *',
  $$
  select net.http_post(
    url     := 'https://jswqdjevbncfqinntajg.supabase.co/functions/v1/hostbuddy-daily-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_service_role_key')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
