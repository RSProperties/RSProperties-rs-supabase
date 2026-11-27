-- ============================================================
-- Mail inbox - balik A: spolahlivost (2026-11-25)
--
--  1. mail_poller_status   - "tep" pollera na Macu: kedy naposledy bezal, ci uspesne, posledna chyba. Keystone z toho ukaze
--                            "posledna synchronizacia pred X min" a cerveny pruh, ked poller stoji; Edge Function mail-watchdog
--                            (pg_cron kazdych 15 min) posle e-mail na info@, ak stoji alebo Claude nevyhodnocuje spravy.
--  2. mail_unknown         - odosielatelia, ktorych nepozname (nie su kontaktom ziadneho leadu ani majitela). Uklada sa IBA
--                            adresa, meno, predmet posledneho mailu a pocet - NIKDY text mailu. Tim ich jednym klikom priradi
--                            k leadu / majitelovi, alebo ignoruje. Predtym sa taka sprava zahodila bez stopy.
--  3. mail_aliases         - dalsie adresy priradene k leadu / majitelovi (klient pise z inej adresy, nez mame v leade).
--                            Rozsiruju zhodu odosielatelov v mail-ingest; nemenia sa tym ziadne data v leadoch ani majitel och.
--  4. mail_messages.attachments - NAZVY priloh (nie obsah) - Keystone ukaze, ze mail ma prilohy.
--
-- PRIVACY: ziadna z novych tabuliek nema grant ani policy pre anon/authenticated; cita sa iba cez RPC nizsie, ktore vyzaduju
-- aktivneho clena timu (admin alebo bizdev view/edit, rovnako ako mail_inbox_list). Zapisuje service role (Edge Functions).
-- ============================================================

-- ---------- 4. nazvy priloh ----------
alter table public.mail_messages add column if not exists attachments jsonb not null default '[]'::jsonb;

-- ---------- 1. tep pollera ----------
create table if not exists public.mail_poller_status (
  id                  int primary key default 1 check (id = 1),
  last_beat_at        timestamptz,
  last_ok_at          timestamptz,
  last_error          text,
  consecutive_fails   int not null default 0,
  last_counts         jsonb not null default '{}'::jsonb,
  classify_error      text,
  stale_alerted_at    timestamptz,
  classify_alerted_at timestamptz
);
alter table public.mail_poller_status enable row level security;
revoke all on public.mail_poller_status from anon, authenticated, public;
insert into public.mail_poller_status (id) values (1) on conflict (id) do nothing;

-- ---------- 2. neznami odosielatelia ----------
create table if not exists public.mail_unknown (
  from_email       text primary key,                 -- male pismena
  from_name        text not null default '',
  last_subject     text not null default '',
  last_received_at timestamptz not null,
  first_seen_at    timestamptz not null default now(),
  msg_count        int not null default 1,
  status           text not null default 'new' check (status in ('new','ignored','assigned')),
  handled_by       text,
  handled_at       timestamptz,
  refetch          boolean not null default false     -- po priradeni: poller dotiahne ich maily od first_seen_at
);
alter table public.mail_unknown enable row level security;
revoke all on public.mail_unknown from anon, authenticated, public;
create index if not exists mail_unknown_status on public.mail_unknown (status, last_received_at desc);

-- ---------- 3. dalsie adresy kontaktov ----------
create table if not exists public.mail_aliases (
  email      text primary key,                       -- male pismena
  kind       text not null check (kind in ('lead','owner')),
  ref_id     text not null,                          -- bizLeads[].id alebo owners[].id
  name       text not null default '',
  created_by text,
  created_at timestamptz not null default now()
);
alter table public.mail_aliases enable row level security;
revoke all on public.mail_aliases from anon, authenticated, public;

-- ============================================================
-- zapis tepu (len service role = mail-ingest, action heartbeat)
-- ============================================================
create or replace function public.mail_poller_beat(p jsonb)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_ok boolean := coalesce((p->>'ok')::boolean, false);
begin
  update public.mail_poller_status set
    last_beat_at      = now(),
    last_ok_at        = case when v_ok then now() else last_ok_at end,
    consecutive_fails = case when v_ok then 0 else consecutive_fails + 1 end,
    last_error        = case when v_ok then null else left(coalesce(p->>'error',''), 300) end,
    last_counts       = case when jsonb_typeof(p->'counts') = 'object' then p->'counts' else last_counts end,
    classify_error    = case when v_ok then nullif(left(coalesce(p->>'classify_error',''), 300), '') else classify_error end
  where id = 1;
end;
$$;
revoke all on function public.mail_poller_beat(jsonb) from public, anon, authenticated;
grant execute on function public.mail_poller_beat(jsonb) to service_role;

-- stav synchronizacie pre Keystone (serverovy cas = bez zavislosti od hodin prehliadaca)
create or replace function public.mail_sync_status()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public
as $$
  select case when public.mail_inbox_can_read() then (
    select jsonb_build_object(
      'now', now(),
      'last_beat_at', s.last_beat_at,
      'last_ok_at', s.last_ok_at,
      'last_error', s.last_error,
      'consecutive_fails', s.consecutive_fails,
      'classify_error', s.classify_error,
      'unclassified', (select count(*) from public.mail_messages m
                        where m.direction = 'in' and m.classified = false and m.status = 'new'
                          and m.created_at < now() - interval '20 minutes'),
      'unknown_new', (select count(*) from public.mail_unknown u where u.status = 'new'))
    from public.mail_poller_status s where s.id = 1)
  else null end;
$$;
revoke all on function public.mail_sync_status() from public, anon;
grant execute on function public.mail_sync_status() to authenticated;

-- ============================================================
-- neznami odosielatelia
-- ============================================================
create or replace function public.mail_unknown_put(p jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_email text := left(lower(coalesce(p->>'from_email','')), 200);
begin
  if v_email = '' or position('@' in v_email) = 0 or left(v_email, 1) = '@' then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;
  insert into public.mail_unknown as u (from_email, from_name, last_subject, last_received_at, status)
  values (v_email, left(coalesce(p->>'from_name',''), 200), left(coalesce(p->>'subject',''), 300),
          coalesce((p->>'received_at')::timestamptz, now()),
          -- cela domena ignorovana (riadok '@domena' so stavom ignored) -> novy odosielatel z nej rovno ako ignorovany
          case when exists (select 1 from public.mail_unknown d where d.from_email = '@' || split_part(v_email, '@', 2) and d.status = 'ignored')
               then 'ignored' else 'new' end)
  on conflict (from_email) do update set
    -- pocet a "posledny" sa menia len pri NOVSEJ sprave (opakovane poslanie tej istej spravy pocet nenafukne)
    msg_count        = case when excluded.last_received_at > u.last_received_at then u.msg_count + 1 else u.msg_count end,
    last_subject     = case when excluded.last_received_at > u.last_received_at then excluded.last_subject else u.last_subject end,
    from_name        = case when excluded.last_received_at > u.last_received_at and excluded.from_name <> '' then excluded.from_name else u.from_name end,
    last_received_at = greatest(u.last_received_at, excluded.last_received_at),
    -- adresa, ktora bola priradena a znova je neznama (priradenie sa zrusilo), sa vracia medzi nove; ignorovana ostava ignorovana
    status           = case when u.status = 'assigned' then 'new' else u.status end;
  delete from public.mail_unknown where last_received_at < now() - interval '6 months' and left(from_email, 1) <> '@';
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.mail_unknown_put(jsonb) from public, anon, authenticated;
grant execute on function public.mail_unknown_put(jsonb) to service_role;

create or replace function public.mail_unknown_list()
  returns setof public.mail_unknown
  language sql
  stable
  security definer
  set search_path = public
as $$
  select u.* from public.mail_unknown u
  where public.mail_inbox_can_read() and u.status in ('new','ignored')
  order by (u.status = 'new') desc, u.last_received_at desc
  limit 300;
$$;
revoke all on function public.mail_unknown_list() from public, anon;
grant execute on function public.mail_unknown_list() to authenticated;

create or replace function public.mail_unknown_set(p_email text, p_status text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_name text;
begin
  if not public.mail_inbox_can_edit() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_status not in ('new','ignored') then return jsonb_build_object('ok', false, 'error', 'bad_status'); end if;
  select coalesce(nullif(t.name,''), t.email) into v_name from public.team_users t where t.auth_user_id = auth.uid() limit 1;
  update public.mail_unknown
     set status = p_status,
         handled_by = case when p_status = 'new' then null else v_name end,
         handled_at = case when p_status = 'new' then null else now() end
   where from_email = lower(p_email) and left(from_email, 1) <> '@' and status in ('new','ignored');
  return jsonb_build_object('ok', found);
end;
$$;
revoke all on function public.mail_unknown_set(text, text) from public, anon;
grant execute on function public.mail_unknown_set(text, text) to authenticated;

-- ignorovat / vratit CELU domenu (typicky obchody, platformy, newslettery: alza.sk, flatio.com ...); riadok '@domena' je pamat
create or replace function public.mail_unknown_domain(p_domain text, p_ignore boolean)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_name text; v_dom text := lower(trim(coalesce(p_domain,''))); n int := 0;
begin
  if not public.mail_inbox_can_edit() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if v_dom !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then return jsonb_build_object('ok', false, 'error', 'bad_domain'); end if;
  -- verejne schranky (gmail ...) sa ako cela domena ignorovat nedaju: pisu z nich aj skutocni klienti
  if v_dom = any (array['gmail.com','googlemail.com','yahoo.com','yahoo.sk','yahoo.cz','outlook.com','outlook.sk','hotmail.com','live.com','msn.com',
                        'icloud.com','me.com','seznam.cz','email.cz','post.cz','centrum.sk','centrum.cz','azet.sk','zoznam.sk','post.sk','atlas.cz',
                        'proton.me','protonmail.com','gmx.com','gmx.net','gmx.at','aol.com','mail.com','t-email.sk','stonline.sk']) then
    return jsonb_build_object('ok', false, 'error', 'free_mail_domain');
  end if;
  select coalesce(nullif(t.name,''), t.email) into v_name from public.team_users t where t.auth_user_id = auth.uid() limit 1;
  if p_ignore then
    insert into public.mail_unknown (from_email, last_subject, last_received_at, status, handled_by, handled_at)
    values ('@' || v_dom, '', now(), 'ignored', v_name, now())
    on conflict (from_email) do update set status = 'ignored', handled_by = excluded.handled_by, handled_at = now();
    update public.mail_unknown set status = 'ignored', handled_by = v_name, handled_at = now()
     where status = 'new' and left(from_email, 1) <> '@' and split_part(from_email, '@', 2) = v_dom;
    get diagnostics n = row_count;
  else
    delete from public.mail_unknown where from_email = '@' || v_dom;
    update public.mail_unknown set status = 'new', handled_by = null, handled_at = null
     where status = 'ignored' and split_part(from_email, '@', 2) = v_dom;
    get diagnostics n = row_count;
  end if;
  return jsonb_build_object('ok', true, 'changed', n);
end;
$$;
revoke all on function public.mail_unknown_domain(text, boolean) from public, anon;
grant execute on function public.mail_unknown_domain(text, boolean) to authenticated;

-- ============================================================
-- aliasy (dalsie adresy leadu / majitela)
-- ============================================================
create or replace function public.mail_alias_add(p_email text, p_kind text, p_ref_id text, p_name text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_email text := lower(trim(coalesce(p_email,''))); v_name text;
begin
  if not public.mail_inbox_can_edit() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if v_email !~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' then return jsonb_build_object('ok', false, 'error', 'bad_email'); end if;
  if p_kind not in ('lead','owner') or coalesce(p_ref_id,'') = '' then return jsonb_build_object('ok', false, 'error', 'bad_target'); end if;
  select coalesce(nullif(t.name,''), t.email) into v_name from public.team_users t where t.auth_user_id = auth.uid() limit 1;
  insert into public.mail_aliases (email, kind, ref_id, name, created_by)
  values (v_email, p_kind, left(p_ref_id, 100), left(coalesce(p_name,''), 200), v_name)
  on conflict (email) do update set kind = excluded.kind, ref_id = excluded.ref_id, name = excluded.name, created_by = excluded.created_by;
  -- poller dotiahne maily tejto adresy od chvile, ked sme ju prvy raz videli
  update public.mail_unknown set status = 'assigned', refetch = true, handled_by = v_name, handled_at = now() where from_email = v_email;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.mail_alias_add(text, text, text, text) from public, anon;
grant execute on function public.mail_alias_add(text, text, text, text) to authenticated;

create or replace function public.mail_alias_list()
  returns setof public.mail_aliases
  language sql
  stable
  security definer
  set search_path = public
as $$
  select a.* from public.mail_aliases a where public.mail_inbox_can_read() order by a.created_at desc limit 300;
$$;
revoke all on function public.mail_alias_list() from public, anon;
grant execute on function public.mail_alias_list() to authenticated;

create or replace function public.mail_alias_remove(p_email text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if not public.mail_inbox_can_edit() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  delete from public.mail_aliases where email = lower(p_email);
  update public.mail_unknown set status = 'new', refetch = false, handled_by = null, handled_at = null where from_email = lower(p_email);
  return jsonb_build_object('ok', found);
end;
$$;
revoke all on function public.mail_alias_remove(text) from public, anon;
grant execute on function public.mail_alias_remove(text) to authenticated;

-- poller (cez mail-ingest, service role): ktore adresy treba dotiahnut a odkedy
create or replace function public.mail_unknown_refetch_list()
  returns table(email text, since timestamptz)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select u.from_email, u.first_seen_at from public.mail_unknown u where u.refetch = true order by u.first_seen_at limit 20;
$$;
revoke all on function public.mail_unknown_refetch_list() from public, anon, authenticated;
grant execute on function public.mail_unknown_refetch_list() to service_role;

create or replace function public.mail_unknown_refetch_done(p_email text)
  returns void
  language sql
  security definer
  set search_path = public
as $$
  update public.mail_unknown set refetch = false where from_email = lower(p_email);
$$;
revoke all on function public.mail_unknown_refetch_done(text) from public, anon, authenticated;
grant execute on function public.mail_unknown_refetch_done(text) to service_role;

-- ============================================================
-- mail_put: rozsirene o nazvy priloh (inak nezmenene oproti 2026-11-23_mail_inbox.sql)
-- ============================================================
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
     status, handled_by, handled_at, attachments)
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
    case when p->>'status' in ('handled','ignored') then now() end,
    case when jsonb_typeof(p->'attachments') = 'array' then p->'attachments' else '[]'::jsonb end
  )
  on conflict (message_id) do update
    set classified = excluded.classified, intent = excluded.intent, confidence = excluded.confidence,
        summary = excluded.summary, needs_reply = excluded.needs_reply, urgency = excluded.urgency, suggested = excluded.suggested,
        attachments = excluded.attachments
    where m.classified = false and excluded.classified = true
  returning id, (xmax = 0) into v_id, v_new;
  -- uchovavame 12 mesiacov
  delete from public.mail_messages where received_at < now() - interval '12 months';
  return jsonb_build_object('ok', true, 'id', v_id, 'inserted', coalesce(v_new, false));
end;
$$;
revoke all on function public.mail_put(jsonb) from public, anon, authenticated;
grant execute on function public.mail_put(jsonb) to service_role;
