-- ============================================================
-- Tickety: denny follow-up prehlad (pg_cron) - 2026-11-26
-- Kazde rano zavola Edge Function ticket-notify {"digest":true}: kazdy dostane svoje follow-upy na dnes / po termine,
-- admini navyse prehlad prípadov, ktore sa tocia dlho (po termine 2+ dni, nepridelene, bez aktivity tyzden).
-- 06:30 UTC = 07:30 zimny / 08:30 letny cas na Slovensku. Rovnaky Vault secret ako ops-digest.
-- ============================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('ticket-digest')
where exists (select 1 from cron.job where jobname = 'ticket-digest');

select cron.schedule(
  'ticket-digest',
  '30 6 * * *',
  $$
  select net.http_post(
    url     := 'https://jswqdjevbncfqinntajg.supabase.co/functions/v1/ticket-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_service_role_key')
    ),
    body    := '{"digest":true}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
