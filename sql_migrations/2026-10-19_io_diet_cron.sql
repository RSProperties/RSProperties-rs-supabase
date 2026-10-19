-- Disk IO diet (2026-10-19), part 2: pg_cron housekeeping. Touches only cron bookkeeping, no app data.
-- 1) cron.job_run_details had ~17 000 rows (keepwarm */5 x2 + hostbuddy */30) — purge > 3 days, and keep doing it daily.
-- 2) edge-fn keepwarm pings every 10 min instead of every 5 (halves its cron/net.http writes).
delete from cron.job_run_details where end_time < now() - interval '3 days';

select cron.unschedule(jobid) from cron.job where jobname = 'cron-log-cleanup';
select cron.schedule('cron-log-cleanup', '15 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '3 days'$$);

select cron.alter_job((select jobid from cron.job where jobname = 'edge-fn-keepwarm-team-auth'),  schedule => '*/10 * * * *');
select cron.alter_job((select jobid from cron.job where jobname = 'edge-fn-keepwarm-owner-auth'), schedule => '*/10 * * * *');
