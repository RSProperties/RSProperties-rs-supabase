-- ============================================================
-- email_log — 2026-09-10 (Round 2 item H)
--
-- Every transactional email the Edge Functions send via Resend writes a
-- row here right after the Resend POST, so the team can answer "did we
-- actually send X the email, and did Resend accept it?" (the Nate task
-- incident, 2026-09-10). Later a resend-webhook can upsert
-- delivered/bounced/opened onto the same row by resend_id.
--
-- Service-role only — written by Edge Functions, read by the admin app
-- through a SECURITY DEFINER function (email_log_recent) gated on
-- team_is_active() so only real active team members see it (admins
-- included — team_has_permission would miss admins whose permissions map
-- has no explicit 'team' entry).
-- ============================================================

create table if not exists email_log (
  id           bigint generated always as identity primary key,
  to_addr      text not null,
  subject      text,
  template     text,                       -- which function / kind
  resend_id    text,
  status       text not null default 'accepted',  -- accepted | failed | delivered | bounced | complained
  error        text,
  meta         jsonb default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists email_log_created_idx on email_log (created_at desc);
create index if not exists email_log_resend_idx  on email_log (resend_id);

alter table email_log enable row level security;
-- no policies → anon/authenticated get nothing directly; all access via
-- the function below or the service role.

create or replace function public.email_log_recent(lim int default 100)
  returns setof email_log
  language sql
  security definer
  set search_path = public
as $$
  select * from email_log
  where public.team_is_active()
  order by created_at desc
  limit greatest(1, least(coalesce(lim, 100), 500));
$$;
revoke all on function public.email_log_recent(int) from public;
grant execute on function public.email_log_recent(int) to authenticated;
