-- Ledger: which property-months the owner may see in the Owner Portal (2026-10-20).
-- Owners have no Supabase Auth session, so they never read this table directly: owner-auth's
-- get_ledger action (service role, gated by a signed login token) returns only rows listed here.
create table if not exists public.ledger_publications (
  property_id  text not null,
  month        text not null,                -- YYYY-MM
  published_at timestamptz not null default now(),
  published_by text,
  primary key (property_id, month)
);
alter table public.ledger_publications enable row level security;
drop policy if exists ledger_publications_select on public.ledger_publications;
create policy ledger_publications_select on public.ledger_publications for select using (public.team_has_permission('finance','view'));
drop policy if exists ledger_publications_insert on public.ledger_publications;
create policy ledger_publications_insert on public.ledger_publications for insert with check (public.team_has_permission('finance','edit'));
drop policy if exists ledger_publications_update on public.ledger_publications;
create policy ledger_publications_update on public.ledger_publications for update using (public.team_has_permission('finance','edit')) with check (public.team_has_permission('finance','edit'));
drop policy if exists ledger_publications_delete on public.ledger_publications;
create policy ledger_publications_delete on public.ledger_publications for delete using (public.team_has_permission('finance','edit'));
revoke all on public.ledger_publications from anon, public;
revoke truncate, references, trigger on public.ledger_publications from authenticated;
grant select, insert, update, delete on public.ledger_publications to authenticated;
