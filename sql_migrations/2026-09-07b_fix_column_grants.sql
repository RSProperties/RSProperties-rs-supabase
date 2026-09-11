-- Correction: a column-level REVOKE cannot narrow an existing table-level
-- GRANT (Postgres unions table-level and column-level privileges — the
-- broader table-level grant still wins). The only way to actually hide
-- password_hash / password from anon & authenticated is to revoke the
-- table-level SELECT/INSERT/UPDATE entirely and re-grant it column-by-
-- column for every column except the secret one.

revoke select, insert, update on owner_users from anon, authenticated;
grant select (id,name,username,email,property_ids,property_names,created_at)
  on owner_users to anon, authenticated;
grant insert (id,name,username,email,property_ids,property_names,created_at)
  on owner_users to anon, authenticated;
grant update (id,name,username,email,property_ids,property_names,created_at)
  on owner_users to anon, authenticated;

revoke select, insert, update on team_users from anon, authenticated;
grant select (id,name,email,role,permissions,active,created_at,last_login,invite_token,name_locked)
  on team_users to anon, authenticated;
grant insert (id,name,email,role,permissions,active,created_at,last_login,invite_token,name_locked)
  on team_users to anon, authenticated;
grant update (id,name,email,role,permissions,active,created_at,last_login,invite_token,name_locked)
  on team_users to anon, authenticated;
