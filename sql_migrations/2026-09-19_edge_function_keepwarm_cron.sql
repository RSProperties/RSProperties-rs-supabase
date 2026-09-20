-- ============================================================
-- Edge Function keep-warm ping — 2026-09-19
--
-- team-auth and owner-auth are pre-login, rarely-invoked auth endpoints
-- (regular logins go through Supabase Auth directly; these two are only
-- hit for the legacy password fallback, invite-token lookups, and the
-- owner-portal login/reset flow). Two separate real incidents this month
-- traced back to exactly this kind of cold path: a stalled first hit on
-- `workspace` reads (2026-09-15, different root cause — payload size,
-- already fixed) and an outright 502 on team-auth's `lookup_invite`
-- (2026-09-18, papered over with client-side retries — see CLAUDE.md
-- "Root-cause..." entries). Retries fix the symptom; this removes the
-- cause for these two functions by never letting them go fully cold.
--
-- Ping mechanics: a bare POST with an empty body hits every dispatch
-- `if (action === ...)` check in both functions, matches none of them,
-- and returns `{error:"unknown_action"}` (400) — exercises the full
-- cold-start path (isolate boot, JSON parse) with zero side effects: no
-- DB writes, no emails, no real auth attempt. Confirmed by reading both
-- functions' source before scheduling this — the final
-- `return json({error:"unknown_action"},400)` fallthrough in each.
--
-- Uses the same vault secret as hostex-daily-sync
-- ('edge_service_role_key') — already exists, nothing new to create.
--
-- Schedule: every 5 minutes, two separate jobs (one per function) so
-- either can be unscheduled/debugged independently. Cheap — a ~50ms
-- invocation each, no DB query beyond isolate boot — and keeps both
-- warm across the whole working day and the overnight gap alike.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('edge-fn-keepwarm-team-auth')
where exists (select 1 from cron.job where jobname = 'edge-fn-keepwarm-team-auth');

select cron.schedule(
  'edge-fn-keepwarm-team-auth',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://jswqdjevbncfqinntajg.supabase.co/functions/v1/team-auth',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_service_role_key')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 15000
  );
  $$
);

select cron.unschedule('edge-fn-keepwarm-owner-auth')
where exists (select 1 from cron.job where jobname = 'edge-fn-keepwarm-owner-auth');

select cron.schedule(
  'edge-fn-keepwarm-owner-auth',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://jswqdjevbncfqinntajg.supabase.co/functions/v1/owner-auth',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_service_role_key')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 15000
  );
  $$
);
