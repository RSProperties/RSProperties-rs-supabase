-- ============================================================
-- Phase 3 (2026-09-07): real per-admin RLS on reports / workspace /
-- warehouse_items / warehouse_log, replacing the `using (true)` policies
-- that let anyone with the public anon key read/write all business data.
--
-- This only works once every team_users row is linked to a real Supabase
-- Auth account (auth.uid()) - see team-auth Edge Function for the
-- login-time auto-migration that populates auth_user_id going forward.
-- ============================================================

-- 1. Link team_users rows to their Supabase Auth account.
alter table team_users add column if not exists auth_user_id uuid unique;

-- 2. Helper functions used inside RLS policies. SECURITY DEFINER is
--    required: team_users itself denies all access to `authenticated` at
--    the table level (Phase 1), so a plain function running as the caller
--    would see nothing. These run as the function owner instead, bypassing
--    that for the single, narrow purpose of "what can the calling user do".
create or replace function team_is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from team_users tu
    where tu.auth_user_id = auth.uid() and tu.active = true
  );
$$;

create or replace function team_has_permission(perm_key text, min_level text default 'view')
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from team_users tu
    where tu.auth_user_id = auth.uid()
      and tu.active = true
      and (
        (tu.permissions ->> perm_key) = 'edit'
        or ((tu.permissions ->> perm_key) = 'view' and min_level = 'view')
      )
  );
$$;

revoke all on function team_is_active() from public;
revoke all on function team_has_permission(text, text) from public;
grant execute on function team_is_active() to authenticated;
grant execute on function team_has_permission(text, text) to authenticated;

