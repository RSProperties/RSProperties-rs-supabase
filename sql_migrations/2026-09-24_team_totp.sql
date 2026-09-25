-- ============================================================
-- team_users 2FA (TOTP) columns — 2026-09-24
--
-- Opt-in, admin-only second factor (see the "2FA for admin accounts"
-- plan and its CLAUDE.md writeup). totp_secret is a base32 TOTP secret,
-- generated and verified entirely server-side in team-auth's
-- totp_setup_init/totp_setup_confirm/totp_disable actions — it is never
-- added to any client-readable column list (SAFE_COLS, login_lookup's
-- select, etc.), the same way team_users.password already isn't.
--
-- No RLS change needed: team_users already denies direct client reads
-- of sensitive columns via the existing lockdown policy — this just adds
-- two more columns that policy already covers.
--
-- Recovery if an admin loses their authenticator device (no backup
-- codes in this version, by design — see the plan):
--   update team_users set totp_enabled = false, totp_secret = null
--   where email = '<their email>';
-- ============================================================

alter table team_users add column if not exists totp_secret text;
alter table team_users add column if not exists totp_enabled boolean not null default false;
