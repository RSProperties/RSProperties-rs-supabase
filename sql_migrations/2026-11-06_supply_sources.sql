-- Supply sources + price tracking (2026-11-06).
-- One supply item (supply_catalog) can be bought in several shops (taken from the Dodavatelia section). Every source
-- carries its pack size and price; the app compares the price of ONE piece (roll, capsule, tablet, litre...), not the pack.
-- Prices are read automatically from the product page where the shop allows it (Edge Function supply-price, daily cron);
-- otherwise they are typed in by hand (auto_price=false) and the app warns when such a price gets old.
alter table public.supply_catalog add column if not exists base_unit text not null default 'ks';

create table if not exists public.supply_sources (
  id               text primary key,
  catalog_id       text not null,
  supplier_id      text not null default '',     -- id from the Dodavatelia section (workspace hrSuppliers); '' = shop not in that list
  shop             text not null default '',     -- shop name (copy of the supplier name, so it survives renaming/deleting the supplier)
  url              text not null default '',
  title            text not null default '',     -- product title found on the page
  pack_qty         numeric not null default 1 check (pack_qty > 0 and pack_qty <= 100000),  -- pieces (base_unit) in ONE package
  pack_note        text not null default '',
  price            numeric check (price is null or (price >= 0 and price <= 100000)),       -- price of ONE package incl. VAT
  price_checked_at timestamptz,
  price_origin     text not null default '',     -- auto | manual | ''
  auto_price       boolean not null default true,
  last_error       text not null default '',
  active           boolean not null default true,
  created_by       text not null default '',
  created_at       timestamptz not null default now()
);
create index if not exists supply_sources_catalog_idx on public.supply_sources (catalog_id);

create table if not exists public.supply_price_log (
  id          bigint generated always as identity primary key,
  source_id   text not null,
  price       numeric not null,
  checked_at  timestamptz not null default now()
);
create index if not exists supply_price_log_source_idx on public.supply_price_log (source_id, checked_at desc);

alter table public.supply_sources enable row level security;
alter table public.supply_price_log enable row level security;
drop policy if exists supply_sources_select on public.supply_sources;
create policy supply_sources_select on public.supply_sources for select using (public.team_is_active());
drop policy if exists supply_sources_write on public.supply_sources;
create policy supply_sources_write on public.supply_sources for all
  using (public.team_has_permission('team', 'edit')) with check (public.team_has_permission('team', 'edit'));
drop policy if exists supply_price_log_select on public.supply_price_log;
create policy supply_price_log_select on public.supply_price_log for select using (public.team_is_active());
drop policy if exists supply_price_log_insert on public.supply_price_log;
create policy supply_price_log_insert on public.supply_price_log for insert with check (public.team_has_permission('team', 'edit'));

revoke all on public.supply_sources, public.supply_price_log from anon, public;
revoke truncate, references, trigger on public.supply_sources, public.supply_price_log from authenticated;
grant select, insert, update, delete on public.supply_sources to authenticated;
grant select, insert on public.supply_price_log to authenticated;
-- the sequence behind supply_price_log.id
grant usage on sequence public.supply_price_log_id_seq to authenticated;

-- base unit for the starter tiles: what ONE piece means when comparing prices
update public.supply_catalog set base_unit = case id
  when 'sc_toilet' then 'kotúč' when 'sc_towels' then 'rolka' when 'sc_dishtab' then 'tableta'
  when 'sc_laundry' then 'pranie' when 'sc_bags' then 'vrecko' when 'sc_sponge' then 'ks'
  else base_unit end
where base_unit = 'ks';
