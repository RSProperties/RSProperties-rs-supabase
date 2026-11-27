-- ============================================================
-- Ticketing system (VA / EvoAssist + team) - 2026-11-26
--
-- Kazdy pripad (zla recenzia, staznost hosta, refund, skoda ...) = jeden ticket s cislom T-0001, T-0002 ... a casovou osou
-- zaznamov (sprava hostovi, host odpovedal / neodpovedal, refund ponuknuty / vyplateny, eskalacia, uzavretie). Nic sa nemaze
-- ani neprepisuje: kazda zmena je novy zaznam (ticket_events), takze cely proces ostane zachovany.
--
-- PRISTUP (len cez RPC, tabulky nemaju ziadny grant pre anon/authenticated):
--   admin                     = vsetko (vratane zmazania)
--   role 'va' (EvoAssist)     = cita a upravuje IBA tickety nehnutelnosti priradenych v permissions.ownerProperties
--   clen timu                 = podla permissions.tickets (view/edit); ak nie je nastavene, plati permissions.team
--   technician/cleaner/owner  = ziadny pristup
-- Upozornenia: trigger na ticket_events vola Edge Function ticket-notify (e-mail), cron posiela denny follow-up prehlad.
-- ============================================================

create sequence if not exists public.ticket_no_seq start 1;

create table if not exists public.tickets (
  id               bigint generated always as identity primary key,
  ticket_no        text not null unique default ('T-' || lpad(nextval('public.ticket_no_seq')::text, 4, '0')),
  type             text not null default 'other',        -- review | complaint | refund | damage | other
  title            text not null default '',
  property_id      text,
  property_name    text not null default '',
  reservation_code text,
  platform         text not null default '',
  guest_name       text not null default '',
  check_in         date,
  check_out        date,
  incident_date    date,
  description      text not null default '',
  status           text not null default 'new',          -- new | contacted | waiting_guest | negotiating | refund_offered | refund_paid | escalated | resolved | closed | cancelled
  priority         text not null default 'normal',       -- low | normal | high
  assignee_id      text,
  assignee_name    text,
  assignee_email   text,
  created_by_name  text,
  created_by_email text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  next_follow_up   date,
  refund_amount    numeric,
  refund_status    text not null default 'none',         -- none | offered | paid
  outcome          text,
  closed_at        timestamptz,
  closed_by        text,
  attachments      jsonb not null default '[]'::jsonb
);
create index if not exists tickets_status   on public.tickets (status, next_follow_up);
create index if not exists tickets_property on public.tickets (property_name);
alter table public.tickets enable row level security;
revoke all on public.tickets from anon, authenticated, public;

create table if not exists public.ticket_events (
  id          bigint generated always as identity primary key,
  ticket_id   bigint not null references public.tickets(id) on delete cascade,
  at          timestamptz not null default now(),
  by_name     text,
  by_email    text,
  kind        text not null,         -- created | note | message_sent | guest_replied | no_reply | refund_offered | refund_paid | escalated | close | reopen | followup | assigned | edited
  text        text not null default '',
  data        jsonb not null default '{}'::jsonb,
  attachments jsonb not null default '[]'::jsonb
);
create index if not exists ticket_events_ticket on public.ticket_events (ticket_id, at desc);
alter table public.ticket_events enable row level security;
revoke all on public.ticket_events from anon, authenticated, public;

-- dnesny datum na Slovensku (databaza ide v UTC, medzi 00:00 a 01:00 by sa predvolene follow-upy posunuli o den)
create or replace function public.ticket_today()
  returns date
  language sql
  stable
as $$ select (now() at time zone 'Europe/Bratislava')::date $$;

-- ---------- kto som a co smiem ----------
create or replace function public.tickets_me()
  returns table(uid uuid, tid text, name text, email text, role text, lvl text, props text[], lang text)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select t.auth_user_id,
         t.id::text,
         coalesce(nullif(t.name,''), t.email),
         t.email,
         t.role,
         case
           when t.role = 'admin' then 'edit'
           when t.role in ('technician','cleaner','owner') then null
           when t.role = 'va' then 'edit'
           -- clen timu: vlastne pravo 'tickets' (aj 'hidden' = bez pristupu); ak nie je nastavene, plati pravo 'team'
           when t.permissions ? 'tickets' then (case when t.permissions->>'tickets' in ('view','edit') then t.permissions->>'tickets' end)
           else (case when t.permissions->>'team' in ('view','edit') then t.permissions->>'team' end)
         end,
         case when t.role = 'va'
              then coalesce((select array_agg(p) from jsonb_array_elements_text(coalesce(t.permissions->'ownerProperties', '[]'::jsonb)) p), '{}'::text[])
              else null end,
         case when t.permissions->>'lang' = 'en' then 'en' else 'sk' end
  from public.team_users t
  where t.auth_user_id = auth.uid() and t.active is true
  limit 1;
$$;
revoke all on function public.tickets_me() from public, anon;
grant execute on function public.tickets_me() to authenticated;

-- ---------- zoznam (podla pristupu) ----------
create or replace function public.tickets_list(p_include_closed boolean default true, lim int default 500)
  returns setof public.tickets
  language sql
  stable
  security definer
  set search_path = public
as $$
  select t.* from public.tickets t, public.tickets_me() me
  where me.lvl is not null
    and (me.props is null or t.property_name = any(me.props))
    and (p_include_closed or t.status not in ('resolved','closed','cancelled'))
  order by (t.status in ('resolved','closed','cancelled')), t.last_activity_at desc
  limit greatest(1, least(coalesce(lim, 500), 1000));
$$;
revoke all on function public.tickets_list(boolean, int) from public, anon;
grant execute on function public.tickets_list(boolean, int) to authenticated;

-- ---------- detail s casovou osou ----------
create or replace function public.ticket_get(p_id bigint)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public
as $$
  select jsonb_build_object('ticket', to_jsonb(t),
           'events', coalesce((select jsonb_agg(to_jsonb(e) order by e.at desc, e.id desc) from public.ticket_events e where e.ticket_id = t.id), '[]'::jsonb))
  from public.tickets t, public.tickets_me() me
  where t.id = p_id and me.lvl is not null and (me.props is null or t.property_name = any(me.props));
$$;
revoke all on function public.ticket_get(bigint) from public, anon;
grant execute on function public.ticket_get(bigint) to authenticated;

-- ---------- komu sa da ticket priradit ----------
create or replace function public.tickets_assignees()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public
as $$
  select case when exists (select 1 from public.tickets_me() m where m.lvl is not null) then
    coalesce((select jsonb_agg(jsonb_build_object('id', t.id::text, 'name', coalesce(nullif(t.name,''), t.email), 'email', t.email, 'role', t.role,
                                                  'lang', case when t.permissions->>'lang' = 'en' then 'en' else 'sk' end)
                               order by (t.role = 'va'), coalesce(nullif(t.name,''), t.email))
              from public.team_users t
              where t.active is true
                and (t.role in ('admin','va')
                     or (t.role not in ('technician','cleaner','owner')
                         and (t.permissions->>'tickets' in ('view','edit') or (t.permissions->>'tickets' is null and t.permissions->>'team' in ('view','edit'))))))
             , '[]'::jsonb)
  else null end;
$$;
revoke all on function public.tickets_assignees() from public, anon;
grant execute on function public.tickets_assignees() to authenticated;

-- pomocna: priloha musi byt pole {name,url}, max 8, len https odkazy
create or replace function public.ticket_clean_files(p jsonb)
  returns jsonb
  language sql
  immutable
as $$
  select coalesce((select jsonb_agg(jsonb_build_object('name', left(coalesce(x->>'name','file'), 120), 'url', x->>'url', 'type', left(coalesce(x->>'type',''), 60)))
                   from (select x from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) x
                         where (x->>'url') like 'https://%' limit 8) s), '[]'::jsonb);
$$;

-- ---------- vytvorenie ----------
create or replace function public.ticket_create(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  me record; v_type text := coalesce(nullif(p->>'type',''), 'other'); v_prop text := left(trim(coalesce(p->>'property_name','')), 200);
  v_prio text := coalesce(nullif(p->>'priority',''), 'normal'); v_fu date; v_id bigint; v_no text; v_title text; v_files jsonb;
  v_ass record;
begin
  select * into me from public.tickets_me();
  if me.lvl is distinct from 'edit' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if v_prop = '' then return jsonb_build_object('ok', false, 'error', 'no_property'); end if;
  if me.props is not null and not (v_prop = any(me.props)) then return jsonb_build_object('ok', false, 'error', 'forbidden_property'); end if;
  if v_type not in ('review','complaint','refund','damage','other') then v_type := 'other'; end if;
  if v_prio not in ('low','normal','high') then v_prio := 'normal'; end if;
  if length(trim(coalesce(p->>'description',''))) < 3 then return jsonb_build_object('ok', false, 'error', 'no_description'); end if;
  -- ten isty ticket od toho isteho cloveka do 2 minut (dvojklik, opakovane odoslanie) sa nezaklada znova
  select t.id, t.ticket_no into v_id, v_no from public.tickets t
   where t.created_by_email = me.email and t.property_name = v_prop and t.description = left(trim(p->>'description'), 4000) and t.created_at > now() - interval '2 minutes'
   order by t.id desc limit 1;
  if found then return jsonb_build_object('ok', true, 'id', v_id, 'ticket_no', v_no, 'duplicate', true); end if;
  v_fu := coalesce(nullif(p->>'next_follow_up','')::date, public.ticket_today() + 2);
  v_title := left(trim(coalesce(nullif(p->>'title',''), '')), 200);
  if v_title = '' then
    v_title := case v_type when 'review' then 'Zlá recenzia' when 'complaint' then 'Sťažnosť hosťa' when 'refund' then 'Refund / kompenzácia' when 'damage' then 'Škoda' else 'Prípad' end
               || case when coalesce(p->>'guest_name','') <> '' then ' - ' || left(p->>'guest_name', 80) else '' end;
  end if;
  v_files := public.ticket_clean_files(p->'attachments');
  -- priradeny clen: musi existovat medzi povolenymi (inak sa ignoruje); predvolene tvorca
  select t.id::text as id, coalesce(nullif(t.name,''), t.email) as name, t.email into v_ass
    from public.team_users t
   where t.active is true and lower(t.email) = lower(coalesce(nullif(p->>'assignee_email',''), me.email))
     and t.role not in ('technician','cleaner','owner') limit 1;
  insert into public.tickets (type, title, property_id, property_name, reservation_code, platform, guest_name, check_in, check_out, incident_date,
                              description, status, priority, assignee_id, assignee_name, assignee_email, created_by_name, created_by_email,
                              next_follow_up, attachments)
  values (v_type, v_title, nullif(left(coalesce(p->>'property_id',''), 100), ''), v_prop, nullif(left(coalesce(p->>'reservation_code',''), 100), ''),
          left(coalesce(p->>'platform',''), 60), left(coalesce(p->>'guest_name',''), 200),
          nullif(p->>'check_in','')::date, nullif(p->>'check_out','')::date, coalesce(nullif(p->>'incident_date','')::date, public.ticket_today()),
          left(trim(p->>'description'), 4000), 'new', v_prio, v_ass.id, v_ass.name, v_ass.email, me.name, me.email, v_fu, v_files)
  returning id, ticket_no into v_id, v_no;
  insert into public.ticket_events (ticket_id, by_name, by_email, kind, text, data, attachments)
  values (v_id, me.name, me.email, 'created', left(trim(p->>'description'), 4000),
          jsonb_build_object('assignee', v_ass.name, 'next_follow_up', v_fu), v_files);
  return jsonb_build_object('ok', true, 'id', v_id, 'ticket_no', v_no);
end;
$$;
revoke all on function public.ticket_create(jsonb) from public, anon;
grant execute on function public.ticket_create(jsonb) to authenticated;

-- ---------- zaznam do casovej osi (+ vedlajsie ucinky: stav, follow-up, refund, uzavretie) ----------
create or replace function public.ticket_log(p_id bigint, p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  me record; t public.tickets%rowtype;
  v_kind text := coalesce(p->>'kind', 'note'); v_text text := left(trim(coalesce(p->>'text', '')), 4000);
  v_status text; v_fu date; v_fu_apply boolean := false; v_amount numeric; v_data jsonb := '{}'::jsonb; v_files jsonb;
  v_closed boolean; v_outcome text := nullif(left(coalesce(p->>'outcome',''), 60), ''); v_attempt int;
  v_ev bigint; v_rstatus text;
begin
  select * into me from public.tickets_me();
  if me.lvl is distinct from 'edit' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into t from public.tickets where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if me.props is not null and not (t.property_name = any(me.props)) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if v_kind not in ('note','message_sent','guest_replied','no_reply','refund_offered','refund_paid','escalated','close','reopen','followup') then
    return jsonb_build_object('ok', false, 'error', 'bad_kind');
  end if;
  v_closed := t.status in ('resolved','closed','cancelled');
  v_status := t.status; v_rstatus := t.refund_status; v_amount := t.refund_amount;
  v_files := public.ticket_clean_files(p->'attachments');

  if v_closed and v_kind not in ('reopen','note') then return jsonb_build_object('ok', false, 'error', 'ticket_closed'); end if;

  if v_kind = 'message_sent' then
    if v_status in ('new','contacted','negotiating','waiting_guest') then v_status := 'waiting_guest'; end if;
    v_fu := public.ticket_today() + 2; v_fu_apply := true;
  elsif v_kind = 'guest_replied' then
    v_status := 'negotiating'; v_fu := public.ticket_today() + 1; v_fu_apply := true;
  elsif v_kind = 'no_reply' then
    select count(*) + 1 into v_attempt from public.ticket_events where ticket_id = t.id and kind = 'no_reply';
    v_data := v_data || jsonb_build_object('attempt', v_attempt);
    if v_status in ('new','contacted') then v_status := 'waiting_guest'; end if;
    v_fu := public.ticket_today() + 2; v_fu_apply := true;
  elsif v_kind = 'refund_offered' then
    v_amount := nullif(p->>'amount','')::numeric;
    if v_amount is null or v_amount <= 0 then return jsonb_build_object('ok', false, 'error', 'bad_amount'); end if;
    v_rstatus := 'offered'; v_status := 'refund_offered'; v_fu := public.ticket_today() + 3; v_fu_apply := true;
    v_data := v_data || jsonb_build_object('amount', v_amount);
  elsif v_kind = 'refund_paid' then
    if nullif(p->>'amount','') is not null then v_amount := (p->>'amount')::numeric; end if;
    if v_amount is null or v_amount <= 0 then return jsonb_build_object('ok', false, 'error', 'bad_amount'); end if;
    v_rstatus := 'paid'; v_status := 'refund_paid'; v_fu := public.ticket_today() + 2; v_fu_apply := true;   -- vyplatene, ale ticket este treba overit a uzavriet
    v_data := v_data || jsonb_build_object('amount', v_amount);
  elsif v_kind = 'escalated' then
    v_status := 'escalated'; v_fu := public.ticket_today() + 3; v_fu_apply := true;
  elsif v_kind = 'close' then
    v_status := coalesce(nullif(p->>'status',''), 'resolved');
    if v_status not in ('resolved','closed','cancelled') then return jsonb_build_object('ok', false, 'error', 'bad_status'); end if;
    v_fu := null; v_fu_apply := true;
  elsif v_kind = 'reopen' then
    if not v_closed then return jsonb_build_object('ok', false, 'error', 'not_closed'); end if;
    v_status := 'negotiating'; v_fu := public.ticket_today() + 1; v_fu_apply := true;
  end if;

  -- explicitne zadany follow-up prebije predvoleny (prazdny retazec = bez follow-upu)
  if p ? 'next_follow_up' and v_kind <> 'close' then
    v_fu := nullif(p->>'next_follow_up', '')::date; v_fu_apply := true;
  end if;
  if v_kind = 'followup' and not (p ? 'next_follow_up') then return jsonb_build_object('ok', false, 'error', 'no_date'); end if;
  if v_kind = 'note' and v_text = '' and v_files = '[]'::jsonb then return jsonb_build_object('ok', false, 'error', 'empty'); end if;

  if v_status is distinct from t.status then v_data := v_data || jsonb_build_object('from_status', t.status, 'to_status', v_status); end if;
  if v_fu_apply then v_data := v_data || jsonb_build_object('next_follow_up', v_fu); end if;
  if v_outcome is not null and v_kind = 'close' then v_data := v_data || jsonb_build_object('outcome', v_outcome); end if;

  update public.tickets set
    status = v_status, refund_status = v_rstatus, refund_amount = v_amount,
    next_follow_up = case when v_fu_apply then v_fu else next_follow_up end,
    outcome = case when v_kind = 'close' then v_outcome when v_kind = 'reopen' then null else outcome end,
    closed_at = case when v_kind = 'close' then now() when v_kind = 'reopen' then null else closed_at end,
    closed_by = case when v_kind = 'close' then me.name when v_kind = 'reopen' then null else closed_by end,
    updated_at = now(), last_activity_at = now()
  where id = t.id;
  insert into public.ticket_events (ticket_id, by_name, by_email, kind, text, data, attachments)
  values (t.id, me.name, me.email, v_kind, v_text, v_data, v_files) returning id into v_ev;
  return jsonb_build_object('ok', true, 'event_id', v_ev, 'status', v_status);
end;
$$;
revoke all on function public.ticket_log(bigint, jsonb) from public, anon;
grant execute on function public.ticket_log(bigint, jsonb) to authenticated;

-- ---------- uprava poli (zmena prideleneho sa zapise ako zaznam 'assigned') ----------
create or replace function public.ticket_update(p_id bigint, p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  me record; t public.tickets%rowtype; v_changed text[] := '{}'; v_ass record; v_prop text; v_type text; v_prio text;
begin
  select * into me from public.tickets_me();
  if me.lvl is distinct from 'edit' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into t from public.tickets where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if me.props is not null and not (t.property_name = any(me.props)) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  v_prop := case when p ? 'property_name' then left(trim(coalesce(p->>'property_name','')), 200) else t.property_name end;
  if v_prop = '' then return jsonb_build_object('ok', false, 'error', 'no_property'); end if;
  if me.props is not null and not (v_prop = any(me.props)) then return jsonb_build_object('ok', false, 'error', 'forbidden_property'); end if;
  v_type := case when p ? 'type' and (p->>'type') in ('review','complaint','refund','damage','other') then p->>'type' else t.type end;
  v_prio := case when p ? 'priority' and (p->>'priority') in ('low','normal','high') then p->>'priority' else t.priority end;
  if p ? 'description' and length(trim(coalesce(p->>'description',''))) < 3 then return jsonb_build_object('ok', false, 'error', 'no_description'); end if;

  if v_prop is distinct from t.property_name then v_changed := array_append(v_changed, 'property'); end if;
  if v_type is distinct from t.type then v_changed := array_append(v_changed, 'type'); end if;
  if v_prio is distinct from t.priority then v_changed := array_append(v_changed, 'priority'); end if;
  if p ? 'guest_name' and left(coalesce(p->>'guest_name',''), 200) is distinct from t.guest_name then v_changed := array_append(v_changed, 'guest'); end if;
  if p ? 'description' and left(trim(p->>'description'), 4000) is distinct from t.description then v_changed := array_append(v_changed, 'description'); end if;
  if p ? 'title' and left(trim(coalesce(p->>'title','')), 200) is distinct from t.title and trim(coalesce(p->>'title','')) <> '' then v_changed := array_append(v_changed, 'title'); end if;
  if p ? 'platform' and left(coalesce(p->>'platform',''), 60) is distinct from t.platform then v_changed := array_append(v_changed, 'platform'); end if;
  if p ? 'check_in' and nullif(p->>'check_in','')::date is distinct from t.check_in then v_changed := array_append(v_changed, 'check_in'); end if;
  if p ? 'check_out' and nullif(p->>'check_out','')::date is distinct from t.check_out then v_changed := array_append(v_changed, 'check_out'); end if;
  if p ? 'incident_date' and nullif(p->>'incident_date','')::date is distinct from t.incident_date then v_changed := array_append(v_changed, 'incident_date'); end if;

  update public.tickets set
    type = v_type, priority = v_prio, property_name = v_prop,
    property_id = case when p ? 'property_id' then nullif(left(coalesce(p->>'property_id',''), 100), '') else property_id end,
    title = case when p ? 'title' and trim(coalesce(p->>'title','')) <> '' then left(trim(p->>'title'), 200) else title end,
    guest_name = case when p ? 'guest_name' then left(coalesce(p->>'guest_name',''), 200) else guest_name end,
    platform = case when p ? 'platform' then left(coalesce(p->>'platform',''), 60) else platform end,
    reservation_code = case when p ? 'reservation_code' then nullif(left(coalesce(p->>'reservation_code',''), 100), '') else reservation_code end,
    check_in = case when p ? 'check_in' then nullif(p->>'check_in','')::date else check_in end,
    check_out = case when p ? 'check_out' then nullif(p->>'check_out','')::date else check_out end,
    incident_date = case when p ? 'incident_date' then nullif(p->>'incident_date','')::date else incident_date end,
    description = case when p ? 'description' then left(trim(p->>'description'), 4000) else description end,
    updated_at = now()
  where id = t.id;

  if array_length(v_changed, 1) > 0 then
    insert into public.ticket_events (ticket_id, by_name, by_email, kind, text, data)
    values (t.id, me.name, me.email, 'edited', '', jsonb_build_object('fields', to_jsonb(v_changed)));
    update public.tickets set last_activity_at = now() where id = t.id;
  end if;

  -- zmena prideleneho
  if p ? 'assignee_email' and lower(coalesce(p->>'assignee_email','')) is distinct from lower(coalesce(t.assignee_email,'')) then
    select t2.id::text as id, coalesce(nullif(t2.name,''), t2.email) as name, t2.email into v_ass
      from public.team_users t2
     where t2.active is true and lower(t2.email) = lower(coalesce(p->>'assignee_email','')) and t2.role not in ('technician','cleaner','owner') limit 1;
    update public.tickets set assignee_id = v_ass.id, assignee_name = v_ass.name, assignee_email = v_ass.email, updated_at = now(), last_activity_at = now() where id = t.id;
    insert into public.ticket_events (ticket_id, by_name, by_email, kind, text, data)
    values (t.id, me.name, me.email, 'assigned', '', jsonb_build_object('from', t.assignee_name, 'to', v_ass.name, 'to_email', v_ass.email));
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.ticket_update(bigint, jsonb) from public, anon;
grant execute on function public.ticket_update(bigint, jsonb) to authenticated;

-- ---------- zmazanie (len admin; bezne sa ticket uzatvara alebo zrusi) ----------
create or replace function public.ticket_delete(p_id bigint)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare me record;
begin
  select * into me from public.tickets_me();
  if me.role is distinct from 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  delete from public.tickets where id = p_id;
  return jsonb_build_object('ok', found);
end;
$$;
revoke all on function public.ticket_delete(bigint) from public, anon;
grant execute on function public.ticket_delete(bigint) to authenticated;

-- ---------- upozornenia: kazdy dolezity zaznam zavola Edge Function ticket-notify (e-mail) ----------
create extension if not exists pg_net;

create or replace function public.ticket_events_notify()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, extensions
as $$
begin
  begin
    perform net.http_post(
      url     := 'https://jswqdjevbncfqinntajg.supabase.co/functions/v1/ticket-notify',
      headers := jsonb_build_object('Content-Type', 'application/json',
                   'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_service_role_key')),
      body    := jsonb_build_object('event_id', new.id),
      timeout_milliseconds := 20000);
  exception when others then
    null;   -- upozornenie nikdy nesmie zablokovat zapis zaznamu
  end;
  return new;
end;
$$;
revoke all on function public.ticket_events_notify() from public, anon, authenticated;

drop trigger if exists ticket_events_notify on public.ticket_events;
create trigger ticket_events_notify
  after insert on public.ticket_events
  for each row
  when (new.kind in ('created','assigned','guest_replied','refund_offered','refund_paid','escalated','close','reopen'))
  execute function public.ticket_events_notify();
