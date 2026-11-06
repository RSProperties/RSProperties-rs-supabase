-- Supplies v2 (2026-11-05): urgent flag + photo on a request, and per-item consumption norms by apartment size.
-- norms = approximate monthly consumption of ONE apartment, in the item's own unit, by size:
--   s = studio (2 people), 1 = 1-room (3), 2 = 2-room (4), 3 = 3+ rooms (6). Starter values are estimates the team edits in the app.
alter table public.supply_requests add column if not exists urgent    boolean not null default false;
alter table public.supply_requests add column if not exists photo_url text    not null default '';
alter table public.supply_catalog  add column if not exists norms     jsonb   not null default '{}'::jsonb;

update public.supply_catalog set norms = case id
  when 'sc_toilet'  then '{"s":1,"1":1,"2":2,"3":3}'::jsonb
  when 'sc_towels'  then '{"s":0.5,"1":0.5,"2":1,"3":1}'::jsonb
  when 'sc_bath'    then '{"s":0.5,"1":0.5,"2":1,"3":1}'::jsonb
  when 'sc_floor'   then '{"s":0.5,"1":0.5,"2":1,"3":1}'::jsonb
  when 'sc_glass'   then '{"s":0.25,"1":0.25,"2":0.5,"3":0.5}'::jsonb
  when 'sc_dish'    then '{"s":0.5,"1":0.5,"2":1,"3":1}'::jsonb
  when 'sc_dishtab' then '{"s":0.5,"1":0.5,"2":1,"3":1}'::jsonb
  when 'sc_soap'    then '{"s":1,"1":1,"2":2,"3":2}'::jsonb
  when 'sc_shower'  then '{"s":1,"1":2,"2":2,"3":3}'::jsonb
  when 'sc_laundry' then '{"s":0.5,"1":0.5,"2":1,"3":1}'::jsonb
  when 'sc_bags'    then '{"s":1,"1":1,"2":2,"3":2}'::jsonb
  when 'sc_sponge'  then '{"s":0.5,"1":0.5,"2":1,"3":1}'::jsonb
  else norms end
where norms = '{}'::jsonb;
