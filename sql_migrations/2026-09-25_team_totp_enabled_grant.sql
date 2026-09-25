-- ============================================================
-- Grant SELECT on team_users.totp_enabled to authenticated — 2026-09-25
--
-- team_users SELECT access is column-allowlisted (not a blanket table
-- grant — see the 2026-09-11 team_users SELECT lockdown entry in
-- CLAUDE.md, the root cause of that whole incident was exactly this kind
-- of invisible-at-the-table-level column grant). New columns get NO
-- grant by default, which is exactly right for totp_secret (must stay
-- server-only, same as password) but totp_enabled is a boolean the
-- client legitimately needs to read directly via TU_SAFE_COLS (Team
-- Members list) — without this grant, that select would be rejected.
--
-- Verified before writing this: totp_secret correctly has NO select
-- grant to anon/authenticated (confirmed via information_schema.
-- column_privileges) — this migration deliberately does not touch it.
-- ============================================================

grant select (totp_enabled) on team_users to authenticated;
