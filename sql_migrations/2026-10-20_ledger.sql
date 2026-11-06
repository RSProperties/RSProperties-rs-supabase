-- ============================================================
-- Účtovná kniha (Ledger) — 2026-10-20
-- Per-property accounting ledger modelled on the "Les Houches - Bates" Google Sheet:
-- reservations (date + payout), credits (money received) and expenses, with a running
-- "To Pay" balance carried month to month. Row-level tables (NOT a workspace JSON array)
-- so concurrent edits can't clobber each other and deletes can't be resurrected by a merge.
-- Balance is always DERIVED in the client from these rows (opening_balance + months), never stored.
-- RLS keys off the existing 'finance' permission group (view to read, edit to write).
-- ============================================================

create table if not exists public.ledger_settings (
  property_id       text primary key,
  property_name     text not null,
  hostex_property_id text,
  currency          text not null default '€',
  provision_pct     numeric not null default 15,   -- % of each Booking.com payout kept as provision (an expense)
  start_month       text not null,                 -- first month of the book, YYYY-MM
  opening_balance   numeric not null default 0,    -- "To Pay" carried INTO start_month (positive = owner owes us)
  templates         jsonb not null default '[]'::jsonb,  -- recurring-item suggestions per month
  updated_at        timestamptz not null default now()
);

create table if not exists public.ledger_reservations (
  id           text primary key,
  property_id  text not null,
  month        text not null,                      -- YYYY-MM, by check-in (same as the sheet)
  checkin      date not null,
  checkout     date not null,
  channel      text,
  payout       numeric,                            -- null = not entered yet (Hostex has no payout for this property)
  guests       int,
  hostex_code  text,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists ledger_reservations_prop_month on public.ledger_reservations (property_id, month);

create table if not exists public.ledger_entries (
  id          text primary key,
  property_id text not null,
  month       text not null,                       -- YYYY-MM the item belongs to (can differ from entry_date)
  entry_date  date,
  kind        text not null check (kind in ('expense','credit')),
  category    text,
  amount      numeric not null,
  note        text,
  channel     text,                                -- credits: 'booking' (carries provision) | 'owner' | null
  source      text not null default 'manual',      -- 'manual' | 'auto_provision' | 'import'
  ref_id      text,                                -- provision rows point at their credit
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists ledger_entries_prop_month on public.ledger_entries (property_id, month);
create index if not exists ledger_entries_ref on public.ledger_entries (ref_id);

alter table public.ledger_settings     enable row level security;
alter table public.ledger_reservations enable row level security;
alter table public.ledger_entries      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['ledger_settings','ledger_reservations','ledger_entries'] loop
    execute format('drop policy if exists %I on public.%I', t||'_select', t);
    execute format('create policy %I on public.%I for select using (public.team_has_permission(''finance'', ''view''))', t||'_select', t);
    execute format('drop policy if exists %I on public.%I', t||'_insert', t);
    execute format('create policy %I on public.%I for insert with check (public.team_has_permission(''finance'', ''edit''))', t||'_insert', t);
    execute format('drop policy if exists %I on public.%I', t||'_update', t);
    execute format('create policy %I on public.%I for update using (public.team_has_permission(''finance'', ''edit'')) with check (public.team_has_permission(''finance'', ''edit''))', t||'_update', t);
    execute format('drop policy if exists %I on public.%I', t||'_delete', t);
    execute format('create policy %I on public.%I for delete using (public.team_has_permission(''finance'', ''edit''))', t||'_delete', t);
    execute format('revoke all on public.%I from anon, public', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- hygiene: Supabase default privileges also hand authenticated TRUNCATE/REFERENCES/TRIGGER, which RLS does not gate
revoke truncate, references, trigger on public.ledger_settings, public.ledger_reservations, public.ledger_entries from authenticated;
