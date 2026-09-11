-- ============================================================
-- Security fix: close open RLS policies that let the public
-- anon key read/write password hashes and reset tokens directly.
-- Applied 2026-09-07. See owner-auth / team-auth edge functions
-- for the replacement server-side auth flows.
-- ============================================================

-- ---------- new: persistent login rate limiting ----------
create table if not exists auth_rate_limits (
  key text primary key,
  attempts int not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz
);
alter table auth_rate_limits enable row level security;
-- Intentionally zero policies: RLS + no policy = fully denied to
-- anon/authenticated. Only the service_role (edge functions) can
-- touch this table, which is exactly what we want.

-- ---------- owner_reset_tokens: full lockdown ----------
-- These rows ARE valid credentials (a matching token = password reset).
-- No legitimate client-side use case remains once owner-auth handles
-- the whole flow server-side, so we remove every anon policy and add
-- none back.
drop policy if exists "anon insert token" on owner_reset_tokens;
drop policy if exists "anon select own token by exact match" on owner_reset_tokens;
drop policy if exists "anon update token to mark used" on owner_reset_tokens;

-- ---------- owner_users: keep row-level access, lock the password_hash column ----------
drop policy if exists "anon full access owner_users" on owner_users;
drop policy if exists "team_owner_users" on owner_users;
create policy "owner_users select" on owner_users for select to public using (true);
create policy "owner_users insert" on owner_users for insert to public with check (true);
create policy "owner_users update" on owner_users for update to public using (true) with check (true);
revoke select (password_hash), insert (password_hash), update (password_hash)
  on owner_users from public, anon, authenticated;

-- Safe status view so the admin UI can still show "password set /
-- legacy / none" per owner without ever exposing the hash itself.
create or replace view owner_password_status as
  select id,
    case
      when password_hash is null or password_hash = '' then 'none'
      when password_hash like 'pbkdf2$%' then 'set'
      when password_hash ~ '^[a-f0-9]{64}$' then 'set'
      else 'legacy'
    end as status
  from owner_users;
grant select on owner_password_status to anon, authenticated;

-- ---------- team_users: keep row-level access, lock the password column ----------
drop policy if exists "anon_all" on team_users;
drop policy if exists "anon_delete_team_users" on team_users;
drop policy if exists "anon_read_team_users" on team_users;
drop policy if exists "anon_update_team_users" on team_users;
create policy "team_users select" on team_users for select to public using (true);
create policy "team_users insert" on team_users for insert to public with check (true);
create policy "team_users update" on team_users for update to public using (true) with check (true);
create policy "team_users delete" on team_users for delete to public using (true);
revoke select (password), insert (password), update (password)
  on team_users from public, anon, authenticated;
