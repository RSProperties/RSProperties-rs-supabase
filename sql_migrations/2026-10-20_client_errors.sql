-- Client error log (2026-10-20, roadmap item 4): failed saves (workspace/reports) and uncaught JS errors from the
-- Keystone app land here instead of vanishing as a red toast. Written by logged-in team members (their JWT),
-- read only by people with Team=edit (admins). Shown in Team Members and summarised in the daily ops digest.
create table if not exists public.client_errors (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  user_name   text,
  app_version text,
  kind        text not null,            -- 'save_failed' | 'js_error' | ...
  message     text not null,
  context     jsonb
);
create index if not exists client_errors_created_idx on public.client_errors (created_at desc);

alter table public.client_errors enable row level security;
drop policy if exists client_errors_insert on public.client_errors;
create policy client_errors_insert on public.client_errors for insert
  with check (public.team_is_active() and length(message) <= 500 and length(kind) <= 40);
drop policy if exists client_errors_select on public.client_errors;
create policy client_errors_select on public.client_errors for select
  using (public.team_has_permission('team', 'edit'));
revoke all on public.client_errors from anon, public;
grant insert, select on public.client_errors to authenticated;

-- keep it small: 30 days
select cron.unschedule(jobid) from cron.job where jobname = 'client-errors-cleanup';
select cron.schedule('client-errors-cleanup', '25 3 * * *', $$delete from public.client_errors where created_at < now() - interval '30 days'$$);
