-- ============================================================
-- owner_comments.kind — 2026-09-10
--
-- Lets an owner flag a comment as a service request from the Owner
-- Portal ("Nahlásiť problém" button). The admin app shows those with a
-- badge + a one-click "Vytvoriť úlohu" that spawns a Task. Plain
-- comments leave `kind` NULL.
--
-- Same low-risk pattern as owner_comments.attachments (2026-09-09):
-- additive nullable column, no RLS change — the table stays `using(true)`
-- for anon, exactly the trust level the comment text already has.
-- ============================================================

alter table owner_comments add column if not exists kind text;
