-- Trash for deletions that had no way back (roadmap item 13b, 2026-10-20): tasks, Quick Log entries, local invoices.
-- The app copies the record here before deleting it; "restore" re-creates it as a NEW record with a new id (so no
-- tombstone has to be undone on other clients). Kept 30 days. Reports have their own history (report_versions).
create table if not exists public.trash_items (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind in ('task', 'quicklog', 'invoice')),
  item_id    text,
  label      text,
  data       jsonb not null,
  deleted_by text,
  deleted_at timestamptz not null default now()
);
create index if not exists trash_items_kind_idx on public.trash_items (kind, deleted_at desc);
alter table public.trash_items enable row level security;
drop policy if exists trash_insert on public.trash_items;
create policy trash_insert on public.trash_items for insert
  with check (public.team_is_active() and length(coalesce(label,'')) <= 300);
drop policy if exists trash_select on public.trash_items;
create policy trash_select on public.trash_items for select
  using (public.team_is_active() and (kind <> 'invoice' or public.team_has_permission('team', 'edit')));
drop policy if exists trash_delete on public.trash_items;
create policy trash_delete on public.trash_items for delete
  using (public.team_is_active() and (kind <> 'invoice' or public.team_has_permission('team', 'edit')));
revoke all on public.trash_items from anon, public;
grant insert, select, delete on public.trash_items to authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'trash-cleanup';
select cron.schedule('trash-cleanup', '45 3 * * *', $$delete from public.trash_items where deleted_at < now() - interval '30 days'$$);
