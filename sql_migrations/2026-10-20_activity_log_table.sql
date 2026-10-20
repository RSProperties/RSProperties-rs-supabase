-- Storage migration pilot (2026-10-20, roadmap item 6): Activity Log as a real table instead of one 142 kB JSON array
-- in workspace('rs_activity_log') that every client re-read and rewrote on every action (lossy under concurrency).
-- STEP A (this file): table + backfill. The app dual-writes (legacy array + new row) and still READS the legacy array.
-- STEP B (later, after parity is verified): app reads the table and stops writing the legacy key (kept frozen as backup).
create table if not exists public.activity_log (
  id         text primary key,
  ts         timestamptz not null,
  user_id    text,
  user_name  text,
  user_role  text,
  action     text not null,
  target     text,
  detail     text,
  created_at timestamptz not null default now()
);
create index if not exists activity_log_ts_idx on public.activity_log (ts desc);

alter table public.activity_log enable row level security;
drop policy if exists activity_log_insert on public.activity_log;
create policy activity_log_insert on public.activity_log for insert
  with check (public.team_is_active() and length(action) <= 60 and length(coalesce(target,'')) <= 500 and length(coalesce(detail,'')) <= 2000);
drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log for select
  using (public.team_has_permission('team', 'edit'));
drop policy if exists activity_log_delete on public.activity_log;
create policy activity_log_delete on public.activity_log for delete
  using (public.team_has_permission('team', 'edit'));
revoke all on public.activity_log from anon, public;
grant insert, select, delete on public.activity_log to authenticated;

-- backfill from the legacy array (idempotent; legacy stays the source of truth during step A)
insert into public.activity_log (id, ts, user_id, user_name, user_role, action, target, detail)
select e->>'id',
       coalesce(nullif(e->>'ts','')::timestamptz, now()),
       e->>'userId', e->>'userName', e->>'userRole',
       coalesce(nullif(e->>'action',''), '?'), e->>'target', e->>'detail'
from public.workspace w, jsonb_array_elements(w.value) e
where w.key = 'rs_activity_log' and jsonb_typeof(w.value) = 'array' and e->>'id' is not null
on conflict (id) do nothing;

-- retention: 180 days
select cron.unschedule(jobid) from cron.job where jobname = 'activity-log-cleanup';
select cron.schedule('activity-log-cleanup', '35 3 * * *', $$delete from public.activity_log where ts < now() - interval '180 days'$$);
