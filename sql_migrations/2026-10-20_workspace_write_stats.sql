-- TEMPORARY instrumentation (2026-10-20, roadmap item 6 / phase 0): count writes to `workspace` per key so the
-- migration to per-record tables starts with the datasets that actually cost the most IO.
-- Removal when done:  drop trigger workspace_write_stats_trg on public.workspace;
--                     drop function public.workspace_write_stats_fn(); drop table public.workspace_write_stats;
create table if not exists public.workspace_write_stats (
  key      text primary key,
  writes   bigint not null default 0,
  bytes    bigint not null default 0,      -- total size of values written (approx. IO cost)
  first_at timestamptz not null default now(),
  last_at  timestamptz not null default now()
);
alter table public.workspace_write_stats enable row level security;
revoke all on public.workspace_write_stats from anon, authenticated, public;   -- service role / SQL only

create or replace function public.workspace_write_stats_fn() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into workspace_write_stats as s (key, writes, bytes, last_at)
  values (new.key, 1, octet_length(new.value::text), now())
  on conflict (key) do update
    set writes = s.writes + 1, bytes = s.bytes + octet_length(new.value::text), last_at = now();
  return new;
end $$;

drop trigger if exists workspace_write_stats_trg on public.workspace;
create trigger workspace_write_stats_trg after insert or update on public.workspace
  for each row execute function public.workspace_write_stats_fn();
