-- ============================================================
-- Fixes the "attachments bucket is fully public" hole flagged in
-- CLAUDE.md (found 2026-09-08, deferred by choice until now): the
-- `attachments` Storage bucket is a PUBLIC bucket (public=true), which
-- means /storage/v1/object/public/attachments/... serves ANY object with
-- zero auth, completely independent of the allow_anon_select/
-- allow_anon_insert RLS policies on storage.objects (those only govern
-- the list/authenticated-read endpoints, not the public-bucket read path).
-- So narrowing those RLS policies alone would NOT have closed this — the
-- only real fix is moving the sensitive content (door codes, keybox
-- codes, wifi photos under properties/*/access/*) to a genuinely private
-- bucket. Verified empirically before writing this: a direct curl with
-- NO apikey at all against /object/public/attachments/properties/.../access/...
-- returned 200 with the file — confirms bucket-level public=true is the
-- actual exposure, not just the RLS policies.
--
-- Scope check done first: get-property-access's action=get (used by the
-- external-technician access.html share-link flow) does NOT return any
-- photo URLs today — only text fields (keybox/door/wifi/location/parking/
-- instr). So these photos are ONLY ever read by the admin app's own
-- Property > Access tab, by logged-in team members. That's what the new
-- bucket's policies below are scoped for.
--
-- IMPORTANT finding while designing this: this Supabase project has
-- OPEN public signup (POST /auth/v1/signup with just the anon key
-- returns an immediately-usable authenticated JWT, no email verification
-- required). So a bucket policy gated on bare `to authenticated` would be
-- almost as open as anon - confirmed team_is_active()/team_has_permission()
-- (used by the Phase 3 reports/workspace/warehouse policies) are NOT
-- vulnerable to this, since they additionally require a matching, active
-- team_users row via auth.uid() - a self-signup account has none. The
-- same team_is_active() gate is reused below for the same reason.
-- ============================================================

-- New private bucket for property access-tab photos (door codes, keybox
-- codes, wifi note photos). public=false means /object/public/... simply
-- 404s for everyone - reads must go through the authenticated endpoint
-- (or a signed URL), which the RLS policies below then gate.
insert into storage.buckets (id, name, public, file_size_limit)
values ('property-access', 'property-access', false, 10485760) -- 10MB/file
on conflict (id) do nothing;

-- Any active team member (matches Phase 3's own gate for workspace) may
-- read/write/delete objects in this bucket - no anon policy at all.
create policy "team select property-access" on storage.objects
  for select to authenticated
  using (bucket_id = 'property-access' and public.team_is_active());

create policy "team insert property-access" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'property-access' and public.team_is_active());

create policy "team delete property-access" on storage.objects
  for delete to authenticated
  using (bucket_id = 'property-access' and public.team_is_active());
