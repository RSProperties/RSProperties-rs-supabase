-- ============================================================
-- mail-watchdog cron - 2026-11-25
--
-- Kazdych 15 minut zavola Edge Function mail-watchdog: ak poller na Macu dlhsie nebezi (alebo opakovane zlyhava), alebo Claude
-- nevyhodnocuje prichadzajucu postu, posle jeden e-mail na info@ (nie viac ako raz za 12 h pocas toho isteho problemu, v noci
-- 22:00-07:00 nic) a po obnoveni jeden e-mail "uz funguje". Nic nemeni v poste ani v leadoch.
-- Rovnaky Vault secret ako ops-digest / hostex-daily-sync ('edge_service_role_key').
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('mail-watchdog')
where exists (select 1 from cron.job where jobname = 'mail-watchdog');

select cron.schedule(
  'mail-watchdog',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://jswqdjevbncfqinntajg.supabase.co/functions/v1/mail-watchdog',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_service_role_key')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
