-- Supply requests (2026-11-04): cleaners tap what is missing in an apartment, the buyer sees one consolidated shopping list.
-- Row per request (not a workspace JSON array) so many people can write at once without overwriting each other.
-- Nothing here touches owner reports or Quick Log: a purchase is recorded on the request itself (batch_id / batch_total).
create table if not exists public.supply_catalog (
  id            text primary key,
  name          text not null,
  icon          text not null default '📦',
  unit          text not null default 'ks',
  alza_url      text not null default '',   -- empty = the app builds an Alza search link from the name
  sort          integer not null default 100,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists public.supply_requests (
  id            text primary key,
  prop_id       text not null default '',
  prop_name     text not null default '',
  catalog_id    text not null default '',
  name          text not null,
  qty           numeric not null default 1,
  unit          text not null default 'ks',
  note          text not null default '',
  status        text not null default 'requested',   -- requested | bought | cancelled
  requested_by  text not null default '',
  requested_at  timestamptz not null default now(),
  bought_by     text not null default '',
  bought_at     timestamptz,
  store         text not null default '',
  batch_id      text not null default '',
  batch_total   numeric,
  source        text not null default 'app'          -- app (logged-in) | public (shared link, no account)
);

-- Secret keys carried by the public form link (/doplnit/?z=KEY). The public page has NO database access of its own:
-- it only talks to the Edge Function supply-public, which checks this key. Rotating = deactivate the row, create a new one.
create table if not exists public.supply_public_tokens (
  token       text primary key,
  label       text not null default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table public.supply_public_tokens enable row level security;
drop policy if exists supply_tokens_all on public.supply_public_tokens;
create policy supply_tokens_all on public.supply_public_tokens for all
  using (public.team_has_permission('team', 'edit')) with check (public.team_has_permission('team', 'edit'));
revoke all on public.supply_public_tokens from anon, public;
revoke truncate, references, trigger on public.supply_public_tokens from authenticated;
grant select, insert, update, delete on public.supply_public_tokens to authenticated;
create index if not exists supply_requests_status_idx on public.supply_requests (status, requested_at desc);
create index if not exists supply_requests_batch_idx on public.supply_requests (batch_id);
-- No duplicates: at most ONE open request per apartment and item, even if two people tap at the same moment.
create unique index if not exists supply_requests_one_open_idx
  on public.supply_requests (prop_id, lower(name)) where status = 'requested';

alter table public.supply_catalog enable row level security;
alter table public.supply_requests enable row level security;

drop policy if exists supply_catalog_select on public.supply_catalog;
create policy supply_catalog_select on public.supply_catalog for select using (public.team_is_active());
drop policy if exists supply_catalog_write on public.supply_catalog;
create policy supply_catalog_write on public.supply_catalog for all
  using (public.team_has_permission('team', 'edit')) with check (public.team_has_permission('team', 'edit'));

drop policy if exists supply_requests_select on public.supply_requests;
create policy supply_requests_select on public.supply_requests for select using (public.team_is_active());
drop policy if exists supply_requests_insert on public.supply_requests;
create policy supply_requests_insert on public.supply_requests for insert
  with check (public.team_is_active() and length(name) <= 200 and length(note) <= 1000 and qty > 0 and qty <= 1000);
drop policy if exists supply_requests_update on public.supply_requests;
create policy supply_requests_update on public.supply_requests for update
  using (public.team_is_active()) with check (public.team_is_active());

revoke all on public.supply_catalog, public.supply_requests from anon, public;
revoke truncate, references, trigger on public.supply_catalog, public.supply_requests from authenticated;
grant select, insert, update, delete on public.supply_catalog to authenticated;
grant select, insert, update on public.supply_requests to authenticated;

-- starter tiles (editable in the app)
insert into public.supply_catalog (id, name, icon, unit, sort) values
  ('sc_toilet',   'Toaletný papier',            '🧻', 'balenie', 10),
  ('sc_towels',   'Kuchynské utierky',          '🧽', 'balenie', 20),
  ('sc_bath',     'Čistič na kúpeľňu',          '🧴', 'ks', 30),
  ('sc_floor',    'Čistič na podlahu',          '🪣', 'ks', 40),
  ('sc_glass',    'Čistič na sklo a zrkadlá',   '🪟', 'ks', 50),
  ('sc_dish',     'Prostriedok na riad',        '🍽️', 'ks', 60),
  ('sc_dishtab',  'Tablety do umývačky',        '🫧', 'balenie', 70),
  ('sc_soap',     'Mydlo na ruky',              '🧼', 'ks', 80),
  ('sc_shower',   'Sprchový gél / šampón',      '🚿', 'ks', 90),
  ('sc_laundry',  'Prací prostriedok',          '🧺', 'balenie', 100),
  ('sc_bags',     'Vrecká na odpad',            '🗑️', 'balenie', 110),
  ('sc_sponge',   'Špongie a handry',           '🧽', 'balenie', 120)
on conflict (id) do nothing;
