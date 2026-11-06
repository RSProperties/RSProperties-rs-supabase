-- supply-price cron (2026-11-06): refreshes the prices of all supply sources once a day (04:40 UTC).
-- Service role key comes from Supabase Vault ('edge_service_role_key'), same as the other daily syncs.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('supply-price-daily')
where exists (select 1 from cron.job where jobname = 'supply-price-daily');
select cron.schedule(
  'supply-price-daily',
  '40 4 * * *',
  $$
  select net.http_post(
    url     := 'https://jswqdjevbncfqinntajg.supabase.co/functions/v1/supply-price',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_service_role_key')
    ),
    body    := '{"action":"refresh"}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
