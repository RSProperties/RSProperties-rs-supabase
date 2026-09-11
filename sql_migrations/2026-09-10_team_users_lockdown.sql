-- ============================================================
-- team_users write lockdown (2026-09-10)
--
-- The 2026-09-07 "lockdown" only revoked the `password` COLUMN from
-- anon/authenticated. Everything else was left wide open: RLS policies
-- were still `USING (true)` for `{public}` on INSERT / UPDATE / DELETE,
-- and anon held column grants on id,name,email,role,permissions,active,
-- invite_token,last_login,created_at,name_locked. Verified live
-- 2026-09-10:
--   * GET  team_users?select=id,name,email,role,active,invite_token  -> 200
--     (only `select=*` 401s, because of the one revoked column - which is
--      exactly why preflight.sh's `select=*` probe gave a false pass)
--   * anon PATCH of role/permissions and anon INSERT are both permitted
--     by the grants + USING(true) policy => anyone with the public anon
--     key (it's in page source) could make themselves an admin, or read
--     every pending invite_token and self-activate as that member.
--
-- This closes the WRITE + invite_token paths. SELECT of the non-secret
-- columns stays open for now (roster info-disclosure, not escalation -
-- the pre-login "find my row by email" and setup-routing paths still
-- read it unauthenticated; moving those to team-auth is a separate,
-- login-touching change).
-- ============================================================

-- 1. Drop the world-writable policies.
drop policy if exists "team_users insert" on team_users;
drop policy if exists "team_users update" on team_users;
drop policy if exists "team_users delete" on team_users;

-- 2. anon gets no write privilege at all on this table.
revoke insert, update, delete on team_users from anon;

-- 3. authenticated may write ONLY as a real, active team admin. Every
--    other write path (member creation, password set/reset, invite
--    activation) already runs server-side in team-auth with the service
--    role, which bypasses RLS.
create policy "team_users admin insert" on team_users for insert to authenticated
  with check (public.team_has_permission('team','edit'));
create policy "team_users admin update" on team_users for update to authenticated
  using (public.team_has_permission('team','edit'))
  with check (public.team_has_permission('team','edit'));
create policy "team_users admin delete" on team_users for delete to authenticated
  using (public.team_has_permission('team','edit'));

-- 4. invite_token is a bearer credential - the client never needs its
--    value (team-auth mints/serves/consumes it). Pull it out of every
--    client-reachable grant.
revoke select (invite_token), insert (invite_token), update (invite_token)
  on team_users from anon, authenticated;

-- 5. A logged-in member still needs to stamp their own last_login on
--    login - it used to be a direct client PATCH, now blocked by (3).
--    SECURITY DEFINER so it runs regardless of the caller's own grants,
--    but it can only ever touch the caller's own row (auth.uid()).
create or replace function public.team_touch_last_login()
  returns void
  language sql
  security definer
  set search_path = public
as $$
  update team_users set last_login = now() where auth_user_id = auth.uid();
$$;
revoke all on function public.team_touch_last_login() from public;
grant execute on function public.team_touch_last_login() to authenticated;
