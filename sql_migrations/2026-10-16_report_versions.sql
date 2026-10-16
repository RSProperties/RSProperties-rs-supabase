-- Report version history ("Undo layer 1", 2026-10-16).
-- Every change to a row in `reports` (UPDATE) and every delete first copies the OLD row into
-- report_versions, from a database trigger — so ALL writers are covered (the browser, edge
-- functions, bulk sync) with no client change. The app reads the list and can restore any version;
-- a restore is itself an UPDATE, so it snapshots the state it replaces (restore is undoable too).
--
-- Rules: identical writes are ignored; at most one snapshot per report per 20 s (autosave bursts);
-- newest 50 'update' versions per report kept; 'delete' snapshots (the report "trash") kept 180 days;
-- r_live_* rows (daily-overwritten live drafts) are skipped.
create table if not exists public.report_versions (
  id         bigint generated always as identity primary key,
  report_id  text        not null,
  created_at timestamptz not null default now(),
  saved_by   text,
  reason     text        not null default 'update',   -- 'update' | 'delete'
  month      text,
  prop_name  text,
  summary    jsonb,
  data       jsonb       not null
);
create index if not exists report_versions_report_idx on public.report_versions (report_id, created_at desc);
create index if not exists report_versions_deleted_idx on public.report_versions (created_at desc) where reason = 'delete';

alter table public.report_versions enable row level security;
drop policy if exists report_versions_select on public.report_versions;
create policy report_versions_select on public.report_versions for select
  using (public.team_has_permission('reports', 'view'));
revoke all on public.report_versions from anon, public;
grant select on public.report_versions to authenticated;
-- no insert/update/delete policies on purpose: only the SECURITY DEFINER trigger below writes here.

create or replace function public.report_versions_capture() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  who text; last_ts timestamptz; d jsonb; smry jsonb;
  win int := coalesce(nullif(current_setting('app.report_versions_window_s', true), '')::int, 20);
begin
  if old.id like 'r\_live\_%' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'UPDATE' and old.data is not distinct from new.data then return new; end if;

  if tg_op = 'UPDATE' then
    select max(created_at) into last_ts from report_versions where report_id = old.id and reason = 'update';
    if last_ts is not null and last_ts > now() - make_interval(secs => win) then return new; end if;
  end if;

  select name into who from team_users where auth_user_id = auth.uid() limit 1;
  d := old.data;
  smry := jsonb_build_object(
    'reservations', case when jsonb_typeof(d->'reservations') = 'array' then jsonb_array_length(d->'reservations') else 0 end,
    'expenses',     case when jsonb_typeof(d->'otherExpenses') = 'array' then jsonb_array_length(d->'otherExpenses') else 0 end,
    'netProfit',    coalesce(d->'_calc'->'grandNP', d->'netProfit'),
    'cur',          d->'cur',
    'paid',         d->'paid',
    'status',       d->'status');

  insert into report_versions (report_id, reason, saved_by, month, prop_name, summary, data)
  values (old.id, case when tg_op = 'DELETE' then 'delete' else 'update' end, who, old.month, old.prop_name, smry, old.data);

  delete from report_versions
   where report_id = old.id and reason = 'update'
     and id not in (select id from report_versions where report_id = old.id and reason = 'update' order by created_at desc, id desc limit 50);
  if tg_op = 'DELETE' then
    delete from report_versions where reason = 'delete' and created_at < now() - interval '180 days';
    return old;
  end if;
  return new;
end $$;

drop trigger if exists report_versions_upd on public.reports;
create trigger report_versions_upd before update on public.reports
  for each row execute function public.report_versions_capture();
drop trigger if exists report_versions_del on public.reports;
create trigger report_versions_del before delete on public.reports
  for each row execute function public.report_versions_capture();
