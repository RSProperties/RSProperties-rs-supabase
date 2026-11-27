-- ============================================================
-- Mail inbox (faza 1) - 2026-11-23
--
-- Lokalny poller na Macu (launchd) cita IBA NA CITANIE schranku info@rsproperties.sk, necha prejst len maily od
-- odosielatelov, ktorych pozname (kontakt leadu v Obchodnom pipeline / majitel), a posle ich Edge Function
-- mail-ingest. Ta ich zaradi k leadu, Claude urci zamer + suhrn + navrh dalsieho kroku a ulozi ich sem.
-- Keystone ich ukaze na karte leadu, v casovej osi a v paneli "Dnes treba vybavit".
-- FAZA 1 NIC NEODOSIELA: ziadne odpovede klientom, ziadna zmena stavu leadu (zamer/navrh je len informacia).
--
-- PRIVACY: tabulka nema ziadny grant ani policy pre anon/authenticated. Cita sa LEN cez mail_inbox_list(),
-- ktora vyzaduje aktivneho clena timu: admin ALEBO pravo 'bizdev' = view/edit (rovnako ako Obchodny pipeline).
-- Zmenu stavu spravy (vybavene) smie admin alebo 'bizdev' = edit. Zapisuje iba service role (Edge Function).
-- ============================================================

create table if not exists public.mail_messages (
  id           bigint generated always as identity primary key,
  message_id   text not null unique,              -- hlavicka Message-ID (deduplikacia)
  in_reply_to  text,
  direction    text not null default 'in' check (direction in ('in','out')),
  from_email   text not null,
  from_name    text not null default '',
  to_email     text not null default '',
  subject      text not null default '',
  received_at  timestamptz not null,
  body         text not null default '',          -- orezany text bez citovanej historie (max ~4000 znakov)
  match_kind   text not null default 'lead' check (match_kind in ('lead','owner')),
  lead_id      text,                              -- bizLeads[].id (ak je kontakt leadu)
  match_name   text not null default '',
  classified   boolean not null default false,    -- false = Claude nebol dostupny, zopakuje sa pri dalsom behu
  intent       text not null default 'unclassified',
  confidence   numeric,
  summary      text not null default '',
  needs_reply  boolean not null default true,
  urgency      text not null default 'normal' check (urgency in ('low','normal','high')),
  suggested    jsonb not null default '{}'::jsonb, -- {stage, reply_points[], task} - len navrh, nikdy sa nevykona sam
  status       text not null default 'new' check (status in ('new','handled','ignored')),
  handled_by   text,
  handled_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists mail_messages_lead   on public.mail_messages (lead_id, received_at desc);
create index if not exists mail_messages_status on public.mail_messages (status, received_at desc);
create index if not exists mail_messages_from   on public.mail_messages (lower(from_email));

alter table public.mail_messages enable row level security;
-- zamerne ziadne policies: anon/authenticated nemaju k tabulke priamy pristup
revoke all on public.mail_messages from anon, authenticated, public;

-- kto smie citat / menit (SECURITY DEFINER: cita team_users bez ohladu na grants volajuceho)
create or replace function public.mail_inbox_can_read()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1 from public.team_users t
    where t.auth_user_id = auth.uid()
      and t.active is true
      and (t.role = 'admin' or (t.permissions ->> 'bizdev') in ('view','edit'))
  );
$$;
revoke all on function public.mail_inbox_can_read() from public;
grant execute on function public.mail_inbox_can_read() to authenticated;

create or replace function public.mail_inbox_can_edit()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1 from public.team_users t
    where t.auth_user_id = auth.uid()
      and t.active is true
      and (t.role = 'admin' or (t.permissions ->> 'bizdev') = 'edit')
  );
$$;
revoke all on function public.mail_inbox_can_edit() from public;
grant execute on function public.mail_inbox_can_edit() to authenticated;

-- zoznam sprav (volitelne len jeden lead / len dany stav), najnovsie hore
create or replace function public.mail_inbox_list(p_lead_id text default null, p_status text default null, lim int default 200)
  returns setof public.mail_messages
  language sql
  stable
  security definer
  set search_path = public
as $$
  select m.* from public.mail_messages m
  where public.mail_inbox_can_read()
    and (p_lead_id is null or m.lead_id = p_lead_id)
    and (p_status is null or m.status = p_status)
  order by m.received_at desc
  limit greatest(1, least(coalesce(lim, 200), 500));
$$;
revoke all on function public.mail_inbox_list(text, text, int) from public;
grant execute on function public.mail_inbox_list(text, text, int) to authenticated;

-- oznacit spravu ako vybavenu / ignorovanu / znova novu
create or replace function public.mail_inbox_set_status(p_id bigint, p_status text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_name text;
begin
  if not public.mail_inbox_can_edit() then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_status not in ('new','handled','ignored') then
    return jsonb_build_object('ok', false, 'error', 'bad_status');
  end if;
  select coalesce(nullif(t.name,''), t.email) into v_name from public.team_users t where t.auth_user_id = auth.uid() limit 1;
  update public.mail_messages
     set status = p_status,
         handled_by = case when p_status = 'new' then null else v_name end,
         handled_at = case when p_status = 'new' then null else now() end
   where id = p_id;
  return jsonb_build_object('ok', found);
end;
$$;
revoke all on function public.mail_inbox_set_status(bigint, text) from public;
grant execute on function public.mail_inbox_set_status(bigint, text) to authenticated;

-- zapis (len service role = Edge Function mail-ingest). Novy riadok sa vlozi; ak uz existuje a este nebol klasifikovany,
-- doplni sa klasifikacia (opakovany beh po vypadku Claude). Klasifikovany / vybaveny riadok sa uz neprepisuje.
create or replace function public.mail_put(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_id bigint; v_new boolean;
begin
  if coalesce(p->>'message_id','') = '' or coalesce(p->>'from_email','') = '' then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;
  insert into public.mail_messages as m
    (message_id, in_reply_to, direction, from_email, from_name, to_email, subject, received_at, body,
     match_kind, lead_id, match_name, classified, intent, confidence, summary, needs_reply, urgency, suggested,
     status, handled_by, handled_at)
  values (
    left(p->>'message_id', 500), left(p->>'in_reply_to', 500), coalesce(nullif(p->>'direction',''),'in'),
    left(lower(p->>'from_email'), 200), left(coalesce(p->>'from_name',''), 200), left(coalesce(p->>'to_email',''), 200),
    left(coalesce(p->>'subject',''), 300), coalesce((p->>'received_at')::timestamptz, now()), left(coalesce(p->>'body',''), 6000),
    coalesce(nullif(p->>'match_kind',''),'lead'), nullif(p->>'lead_id',''), left(coalesce(p->>'match_name',''), 200),
    coalesce((p->>'classified')::boolean, false), coalesce(nullif(p->>'intent',''),'unclassified'),
    nullif(p->>'confidence','')::numeric, left(coalesce(p->>'summary',''), 800),
    coalesce((p->>'needs_reply')::boolean, true), coalesce(nullif(p->>'urgency',''),'normal'),
    coalesce(p->'suggested', '{}'::jsonb),
    case when p->>'status' in ('handled','ignored') then p->>'status' else 'new' end,
    case when p->>'status' in ('handled','ignored') then left(p->>'handled_by', 100) end,
    case when p->>'status' in ('handled','ignored') then now() end
  )
  on conflict (message_id) do update
    set classified = excluded.classified, intent = excluded.intent, confidence = excluded.confidence,
        summary = excluded.summary, needs_reply = excluded.needs_reply, urgency = excluded.urgency, suggested = excluded.suggested
    where m.classified = false and excluded.classified = true
  returning id, (xmax = 0) into v_id, v_new;
  -- uchovavame 12 mesiacov
  delete from public.mail_messages where received_at < now() - interval '12 months';
  return jsonb_build_object('ok', true, 'id', v_id, 'inserted', coalesce(v_new, false));
end;
$$;
revoke all on function public.mail_put(jsonb) from public, anon, authenticated;
grant execute on function public.mail_put(jsonb) to service_role;

-- ktore z danych Message-ID uz mame a su klasifikovane (aby sa za Claude neplatilo dvakrat)
create or replace function public.mail_known_ids(p_ids text[])
  returns table(message_id text, classified boolean)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select m.message_id, m.classified from public.mail_messages m where m.message_id = any(p_ids);
$$;
revoke all on function public.mail_known_ids(text[]) from public, anon, authenticated;
grant execute on function public.mail_known_ids(text[]) to service_role;

-- Supabase dava anon EXECUTE na nove funkcie automaticky; "revoke from public" to nezrusi (aplikovane v produkcii 2026-11-24)
revoke execute on function public.mail_inbox_list(text,text,int), public.mail_inbox_set_status(bigint,text),
  public.mail_inbox_can_read(), public.mail_inbox_can_edit() from anon;
