-- Operácie (2026-11-06): one row per case that the team annotates or creates by hand.
-- Derived cases (HostBuddy messages, tasks, owner comments...) get a row ONLY when someone
-- adds a status / next step / note / checklist / flag; their content is always read live from the source.
-- Manual cases (src='manual') hold their own title/type/apartment/priority/due/detail.
create table if not exists public.ops_cases (
  case_key     text primary key,                 -- 'hbm:<conversation>' | 'task:<id>' | 'own:<id>' | 'm:<id>' ...
  src          text not null default 'derived',  -- derived | manual
  title        text not null default '',
  type         text not null default '',
  prop_id      text not null default '',
  prop_name    text not null default '',
  priority     text not null default '',         -- urgent | high | normal | low ('' = from the source)
  due          date,
  detail       text not null default '',
  status       text not null default '',         -- '' (open) | waiting | done
  next_step    text not null default '',
  decision     boolean not null default false,   -- čaká na rozhodnutie
  unverified   boolean not null default false,   -- na potvrdenie (neoverená informácia)
  notes        jsonb not null default '[]'::jsonb,      -- [{id,text,by,at}]
  checklist    jsonb not null default '[]'::jsonb,      -- [{id,text,done}]
  created_at   timestamptz not null default now(),
  created_by   text not null default '',
  updated_at   timestamptz not null default now(),
  updated_by   text not null default ''
);
create index if not exists ops_cases_status_idx on public.ops_cases (status, updated_at desc);
alter table public.ops_cases enable row level security;
drop policy if exists ops_cases_select on public.ops_cases;
create policy ops_cases_select on public.ops_cases for select using (public.team_is_active());
drop policy if exists ops_cases_insert on public.ops_cases;
create policy ops_cases_insert on public.ops_cases for insert
  with check (public.team_is_active() and length(title) <= 300 and length(detail) <= 4000 and length(next_step) <= 500);
drop policy if exists ops_cases_update on public.ops_cases;
create policy ops_cases_update on public.ops_cases for update
  using (public.team_is_active()) with check (public.team_is_active());
drop policy if exists ops_cases_delete on public.ops_cases;
create policy ops_cases_delete on public.ops_cases for delete using (public.team_has_permission('team', 'edit'));
revoke all on public.ops_cases from anon, public;
revoke truncate, references, trigger on public.ops_cases from authenticated;
grant select, insert, update, delete on public.ops_cases to authenticated;
