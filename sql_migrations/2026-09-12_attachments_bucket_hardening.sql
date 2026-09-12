-- ============================================================
-- attachments bucket hardening — 2026-09-12
--
-- The `attachments` bucket (task/project/manual/quicklog/owner-comment/
-- property photos — everything except door-code/wifi Access-tab photos,
-- which already moved to the private `property-access` bucket on
-- 2026-09-10) has been open since it was created:
--   - public=true, so /object/public/attachments/<path> serves to
--     literally anyone with zero auth — this is INHERENT to how a public
--     bucket works and is NOT changed here. Every <img src> across the
--     app (and the owner portal) depends on exactly this for images that
--     are meant to be viewable by whoever holds the link — flipping
--     public=false would break every one of those instantly and is a
--     separate, much bigger project (proxied/signed serving), not
--     attempted here.
--   - allow_anon_select let the anon key LIST the whole bucket
--     (POST /storage/v1/object/list/attachments) — i.e. discover every
--     path in the bucket without already knowing it, not just fetch a
--     link someone was given. This is the part actually fixed here: the
--     public-serving behavior above only ever reveals a file to someone
--     who already has its (effectively unguessable, timestamp+random)
--     path — dropping this policy removes the "browse everything" path
--     on top of that. Verified: does NOT affect /object/public/... reads,
--     which bypass RLS entirely for a public bucket regardless of policy.
--   - allow_anon_insert had no size or type limit — anyone with the
--     public anon key (visible in page source) could upload an
--     arbitrarily large file of any type. Left OPEN here (closing it
--     properly needs an upload proxy — team members' uploads never send
--     their auth token to this bucket, and owners have no Supabase Auth
--     JWT at all to gate on, so `to authenticated` would break real
--     uploads for both) but now bounded: 20MB max (largest real file
--     today is a 9.66MB PDF) and restricted to the mime types actually in
--     use (images, PDF, docx, plain text, mp4/quicktime) instead of
--     anything at all.
-- ============================================================

update storage.buckets
set file_size_limit = 20971520, -- 20MB
    allowed_mime_types = array[
      'image/jpeg','image/png','image/webp','image/gif',
      'application/pdf','text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'video/mp4','video/quicktime'
    ]
where id = 'attachments';

drop policy if exists "allow_anon_select" on storage.objects;
