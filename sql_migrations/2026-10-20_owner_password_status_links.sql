-- Owner password follow-up (2026-10-20): extend owner_password_status with when the last setup link was
-- issued and how many were issued, so the admin app can show "link sent N days ago — still no password".
-- Same security model as before (view readable by anon/authenticated; no token values exposed, only timestamps/counts).
create or replace view public.owner_password_status as
  select u.id,
         case
           when u.password_hash is null or u.password_hash = '' then 'none'
           when u.password_hash like 'pbkdf2$%' then 'set'
           when u.password_hash ~ '^[a-f0-9]{64}$' then 'set'
           else 'legacy'
         end as status,
         (select max(t.created_at) from public.owner_reset_tokens t where t.owner_id = u.id) as last_link_at,
         (select count(*) from public.owner_reset_tokens t where t.owner_id = u.id) as links_sent
  from public.owner_users u;
grant select on public.owner_password_status to anon, authenticated;
