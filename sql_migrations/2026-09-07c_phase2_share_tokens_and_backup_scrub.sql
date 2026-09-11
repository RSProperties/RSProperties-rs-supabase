-- ============================================================
-- Phase 2 (2026-09-07): close property_share_tokens the same way
-- owner_reset_tokens was closed in phase 1, and scrub the legacy
-- portalPassHash/portalPassPlain fields that were being duplicated
-- into the wide-open `workspace` backup blobs every single day.
-- ============================================================

-- ---------- property_share_tokens: full lockdown ----------
-- Same reasoning as owner_reset_tokens: a matching token IS valid
-- access (to a property's door codes / wifi / access info via
-- access.html), so anon must never be able to list them, and
-- creation must move server-side too (see get-property-access
-- edge function, action=create) instead of a raw anon INSERT that
-- let anyone mint a token for ANY property.
drop policy if exists "anon_all" on property_share_tokens;
drop policy if exists "anon insert share token" on property_share_tokens;
drop policy if exists "anon select share token" on property_share_tokens;
alter table property_share_tokens enable row level security;
revoke all on property_share_tokens from anon, authenticated;

-- ---------- scrub secrets already leaked into workspace backups ----------
-- 27 daily backup_* rows and the live "owners" row were each carrying
-- every owner's legacy portalPassHash (and, in some rows, the plaintext
-- portalPassPlain) inside an openly-readable table. The table itself
-- stays open for now (Phase 3), but these specific credential fields
-- must not be sitting in it regardless.
update workspace
set value = jsonb_set(
  value,
  '{owners}',
  coalesce((
    select jsonb_agg(elem - 'portalPassHash' - 'portalPassPlain' - 'password' - 'password_hash')
    from jsonb_array_elements(value->'owners') as elem
  ), '[]'::jsonb)
)
where key like 'backup_%' and jsonb_typeof(value->'owners') = 'array';

update workspace
set value = coalesce((
  select jsonb_agg(elem - 'portalPassHash' - 'portalPassPlain' - 'password' - 'password_hash')
  from jsonb_array_elements(value) as elem
), '[]'::jsonb)
where key = 'owners' and jsonb_typeof(value) = 'array';
