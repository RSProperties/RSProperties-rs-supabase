-- ============================================================
-- team_users SELECT lockdown — 2026-09-11 (Round 2 "K", Phase 2)
--
-- The 2026-09-10 lockdown closed team_users writes and invite_token, but
-- deliberately left SELECT at `USING (true)` for {public} — noted then as
-- "info disclosure, not escalation" and deferred because the pre-login
-- screen read team_users directly with no auth token yet.
--
-- That gap is closed now: anyone holding the public anon key (visible in
-- page source) could run
--   GET /rest/v1/team_users?select=name,email,role,permissions
-- and dump the ENTIRE roster - every team member's name, email, role and
-- exact permission matrix. Not a privilege escalation (writes were
-- already locked down), but a real information leak.
--
-- Fix: SELECT now requires an active team member's own session
-- (team_is_active(), same helper Phase 3 uses - checks
-- team_users.auth_user_id = auth.uid() AND active = true). The one caller
-- that needed to read team_users BEFORE a session exists - submitLogin's
-- pre-login "does this account exist / is it active" check - was moved
-- to a new team-auth action, `login_lookup` (service role, one email at a
-- time, same non-secret column set, lightly rate-limited so it can't be
-- used to enumerate the roster the way the open SELECT could). See
-- index.html's _tuLoginLookup(). Every other team_users read in the
-- client (_tuFetch/_tuByEmail/_tuUpsert, the Team Members admin screen,
-- the post-login "role changed" refresh) only ever runs once a session
-- already exists, so team_is_active() covers them with no client change.
-- ============================================================

drop policy if exists "team_users select" on team_users;

create policy "team_users select" on team_users for select
  to authenticated
  using (public.team_is_active());

-- Belt-and-braces, matching how invite_token/password were closed on
-- 2026-09-07/10: this project grants team_users read access COLUMN by
-- column (not a blanket table-level SELECT) - verified live, anon holds
-- SELECT on exactly TU_SAFE_COLS (id,name,email,role,permissions,active,
-- created_at,last_login,name_locked). The RLS policy above already
-- blocks anon (no policy applies to it -> zero rows, same as reports/
-- workspace), but strip the underlying column grants too so there's
-- nothing left for anon to read even if RLS were ever misconfigured.
-- login goes through team-auth's login_lookup, invite activation through
-- lookup_invite - both service-role, neither needs the anon key to touch
-- this table at all any more.
revoke select (id,name,email,role,permissions,active,created_at,last_login,name_locked)
  on team_users from anon;
