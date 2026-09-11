-- 2026-09-09: file attachments on Owner Comments (both owner + admin side)
alter table owner_comments        add column if not exists attachments jsonb default '[]'::jsonb;
alter table owner_comment_replies add column if not exists attachments jsonb default '[]'::jsonb;
-- No RLS change - both tables are already open (`using (true)`) to anon,
-- same trust model the comment text itself already has.
