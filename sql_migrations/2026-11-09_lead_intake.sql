-- ============================================================
-- Automatický príjem dopytov z webového formulára — 2026-11-09
--
-- Dopyt z WPForms (cez Edge Function `lead-intake`) sa zapíše ATOMICKY do workspace kľúčov:
--   bizLeads  (nový lead v Obchodnom pipeline / Akvizícia nehnuteľností, stupeň „new“, zdroj „Web formulár“)
--   tasks     (úloha „Kontaktovať záujemcu“ pre zodpovedného, ktorý sa určí STRIEDANÍM medzi vybranými členmi tímu)
--   notifs    (upozornenie do zvončeka)
-- a nastaví sa nasledujúci follow-up. Rovnaký e-mail / telefón do 45 dní = nový lead sa nevytvorí, pridá sa poznámka a úloha
-- „znova sa ozval“. Celé v jednej transakcii so zámkom riadkov (select ... for update), aby sa nepreplietli súbežné dopyty.
--
-- Nastavenia: workspace.leadIntakeCfg = {enabled, assignees:[{id,name}], rr, followDays:[1,3,7], notify:[ids], secretHash}
-- (tajný kľúč pre formulár sa ukladá len ako SHA-256 hash; edge function ho porovnáva).
--
-- lead_followups_run(): denne (pg_cron) — lead zo „Web formulára“, ktorý je stále „new“, nie je „contactedAt“ ani stratený,
-- dostane po 1 / 3 / 7 dňoch (podľa followDays) úlohu + upozornenie. Zastaví sa, keď sa lead posunie, označí ako
-- kontaktovaný alebo stratený.
-- ============================================================

create or replace function public.lead_intake_apply(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  today      date    := (now() at time zone 'Europe/Bratislava')::date;
  now_ms     bigint  := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_email    text    := lower(btrim(coalesce(p->>'email','')));
  v_phone    text    := regexp_replace(coalesce(p->>'phone',''), '\D', '', 'g');
  v_name     text    := btrim(coalesce(p->>'name',''));
  v_loc      text    := btrim(coalesce(p->>'location',''));
  v_type     text    := btrim(coalesce(p->>'type',''));
  v_msg      text    := btrim(coalesce(p->>'message',''));
  v_page     text    := btrim(coalesce(p->>'page',''));
  v_dry      boolean := coalesce((p->>'dry')::boolean, false);
  cfg        jsonb;
  leads      jsonb;
  tasks      jsonb;
  notifs     jsonb;
  assignees  jsonb;
  n          int;
  idx        int;
  asg        jsonb;
  asg_id     text;
  asg_name   text;
  asg_email  text;
  lead       jsonb;
  dup_i      int := -1;
  i          int;
  l          jsonb;
  l_phone    text;
  new_lead_id text;
  new_task_id text;
  title_txt  text;
  desc_txt   text;
  note_txt   text;
  fu_days    int[];
  first_fu   int;
  notify_ids text[];
  uid        text;
  ntf_title  text;
  ntf_body   text;
begin
  if v_email = '' and length(v_phone) < 7 then
    return jsonb_build_object('ok', false, 'error', 'no_contact');
  end if;

  select value into cfg from workspace where key = 'leadIntakeCfg';
  cfg := coalesce(cfg, '{}'::jsonb);
  if coalesce((cfg->>'enabled')::boolean, true) = false then
    return jsonb_build_object('ok', false, 'error', 'disabled');
  end if;

  assignees := coalesce(cfg->'assignees', '[]'::jsonb);
  n := jsonb_array_length(assignees);
  if n > 0 then
    idx := coalesce((cfg->>'rr')::int, 0) % n;
    asg := assignees->idx;
    asg_id := asg->>'id'; asg_name := asg->>'name';
  end if;

  fu_days := array(select (x)::int from jsonb_array_elements_text(coalesce(cfg->'followDays','[1,3,7]'::jsonb)) x order by 1);
  first_fu := coalesce(fu_days[1], 1);

  -- zámky (poradie je pevné)
  select value into leads  from workspace where key = 'bizLeads' for update;
  select value into tasks  from workspace where key = 'tasks'    for update;
  select value into notifs from workspace where key = 'notifs'   for update;
  if leads is null or tasks is null then
    return jsonb_build_object('ok', false, 'error', 'workspace_rows_missing');
  end if;
  notifs := coalesce(notifs, '[]'::jsonb);

  -- duplicita: rovnaký e-mail alebo telefón do 45 dní
  for i in 0 .. jsonb_array_length(leads) - 1 loop
    l := leads->i;
    continue when coalesce(l->>'lost','false') = 'true';
    continue when coalesce((l->>'createdAt')::bigint, 0) < now_ms - 45::bigint*86400000;
    l_phone := regexp_replace(coalesce(l->>'contactPhone',''), '\D', '', 'g');
    if (v_email <> '' and lower(btrim(coalesce(l->>'contactEmail',''))) = v_email)
       or (length(v_phone) >= 7 and length(l_phone) >= 7 and right(l_phone, 9) = right(v_phone, 9)) then
      dup_i := i; exit;
    end if;
  end loop;

  note_txt := 'Formulár na webe' || case when dup_i >= 0 then ' (znova)' else '' end || E':\n'
    || 'Meno: ' || coalesce(nullif(v_name,''),'—') || E'\n'
    || 'E-mail: ' || coalesce(nullif(v_email,''),'—') || E'\n'
    || 'Telefón: ' || coalesce(nullif(btrim(coalesce(p->>'phone','')),''),'—') || E'\n'
    || 'Lokalita: ' || coalesce(nullif(v_loc,''),'—') || E'\n'
    || 'Typ / veľkosť: ' || coalesce(nullif(v_type,''),'—') || E'\n'
    || 'Správa: ' || coalesce(nullif(v_msg,''),'—');

  if v_dry then
    return jsonb_build_object('ok', true, 'dry', true, 'dup', dup_i >= 0,
      'assignee', case when asg is null then null else jsonb_build_object('id', asg_id, 'name', asg_name) end,
      'followDays', to_jsonb(fu_days), 'note', note_txt);
  end if;

  if asg_id is not null then
    begin select email into asg_email from team_users where id::text = asg_id;
    exception when others then asg_email := null; end;
  end if;

  new_task_id := 'wt' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);

  if dup_i >= 0 then
    -- existujúci záujemca sa znova ozval: poznámka + úloha pre jeho zodpovedného (inak podľa striedania)
    l := leads->dup_i;
    if coalesce(l->>'assignedToId','') <> '' then asg_id := l->>'assignedToId'; asg_name := coalesce(l->>'assignedTo', asg_name); end if;
    l := jsonb_set(l, '{notes}', jsonb_build_array(jsonb_build_object('id','bn'||substr(md5(random()::text),1,8),'text',note_txt,'author','Web formulár','ts',now_ms)) || coalesce(l->'notes','[]'::jsonb));
    l := jsonb_set(l, '{updatedAt}', to_jsonb(now_ms));
    l := jsonb_set(l, '{nextFollowUp}', to_jsonb(today::text));
    leads := jsonb_set(leads, array[dup_i::text], l);
    title_txt := 'Záujemca sa znova ozval: ' || coalesce(nullif(v_name,''), l->>'name');
    new_lead_id := l->>'id';
  else
    new_lead_id := 'bw' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);
    title_txt := 'Kontaktovať záujemcu: ' || coalesce(nullif(v_name,''), coalesce(nullif(v_email,''), v_phone))
                 || case when v_loc <> '' then ' (' || v_loc || ')' else '' end;
    lead := jsonb_build_object(
      'id', new_lead_id, 'type', 'acquisition',
      'name', coalesce(nullif(v_name,''), coalesce(nullif(v_email,''), v_phone)) || case when v_loc <> '' then ' — ' || v_loc else '' end,
      'contactName', v_name, 'contactEmail', v_email, 'contactPhone', btrim(coalesce(p->>'phone','')),
      'location', v_loc, 'source', 'Web formulár', 'webForm', true,
      'webData', jsonb_build_object('type', v_type, 'message', v_msg, 'page', v_page),
      'assignedTo', coalesce(asg_name,''), 'assignedToId', coalesce(asg_id,''),
      'stage', 'new', 'estUnits', 1, 'estValue', null, 'lost', false,
      'nextFollowUp', (today + first_fu)::text,
      'createdAt', now_ms, 'updatedAt', now_ms,
      'history', jsonb_build_array(jsonb_build_object('stage','new','ts',now_ms,'by','Web formulár')),
      'notes', jsonb_build_array(jsonb_build_object('id','bn'||substr(md5(random()::text),1,8),'text',note_txt,'author','Web formulár','ts',now_ms)),
      'files', '[]'::jsonb
    );
    leads := jsonb_build_array(lead) || leads;
  end if;

  desc_txt := note_txt || E'\n\nZdroj: web formulár (automaticky z Keystone)' || case when v_page <> '' then E'\nStránka: ' || v_page else '' end;
  tasks := jsonb_build_array(jsonb_build_object(
    'id', new_task_id, 'title', title_txt, 'desc', desc_txt, 'status', 'todo', 'priority', 'H',
    'assigneeIds', case when asg_id is not null then jsonb_build_array(asg_id) else '[]'::jsonb end,
    'assignees',   case when asg_name is not null then jsonb_build_array(asg_name) else '[]'::jsonb end,
    'assigneeId', coalesce(asg_id,''), 'assignee', coalesce(asg_name,''),
    'project', '', 'category', 'admin', 'propId', '', 'propName', '',
    'dueDate', today::text, 'recurring', '', 'parentId', '',
    'createdAt', now_ms, 'updatedAt', now_ms, 'completedAt', null,
    'createdById', '', 'createdByName', 'Web formulár',
    'comments', '[]'::jsonb, 'files', '[]'::jsonb, 'source', 'web_form', 'leadId', new_lead_id, 'dealId', ''
  )) || tasks;

  -- upozornenia do zvončeka: zodpovedný + členovia z cfg.notify
  notify_ids := array(select distinct x from (
      select asg_id as x
      union all select jsonb_array_elements_text(coalesce(cfg->'notify','[]'::jsonb))
    ) q where x is not null and x <> '');
  ntf_title := case when dup_i >= 0 then '🌐 Záujemca sa znova ozval: ' else '🌐 Nový dopyt z webu: ' end || coalesce(nullif(v_name,''), v_email);
  ntf_body  := coalesce(nullif(v_loc,''),'') || case when v_type <> '' then ' · ' || v_type else '' end || case when v_msg <> '' then ' · ' || left(v_msg, 120) else '' end;
  foreach uid in array notify_ids loop
    notifs := jsonb_build_array(jsonb_build_object('id','ntf_'||substr(md5(random()::text||uid),1,10),'forUserId',uid,'type','task_assign',
              'title',ntf_title,'body',ntf_body,'taskId',new_task_id,'link',null,'read',false,'ts',now_ms)) || notifs;
  end loop;
  if jsonb_array_length(notifs) > 500 then notifs := (select jsonb_agg(e) from (select e from jsonb_array_elements(notifs) with ordinality t(e, o) order by o limit 500) s); end if;

  update workspace set value = leads  where key = 'bizLeads';
  update workspace set value = tasks  where key = 'tasks';
  update workspace set value = notifs where key = 'notifs';
  if n > 0 then
    update workspace set value = jsonb_set(cfg, '{rr}', to_jsonb(coalesce((cfg->>'rr')::int, 0) + 1)) where key = 'leadIntakeCfg';
  end if;

  return jsonb_build_object('ok', true, 'dup', dup_i >= 0, 'leadId', new_lead_id, 'taskId', new_task_id,
    'assignee', case when asg_id is null then null else jsonb_build_object('id', asg_id, 'name', asg_name, 'email', asg_email) end,
    'title', title_txt, 'note', note_txt);
end;
$$;

revoke all on function public.lead_intake_apply(jsonb) from public, anon, authenticated;
grant execute on function public.lead_intake_apply(jsonb) to service_role;

-- ------------------------------------------------------------
-- Follow-upy 1 / 3 / 7 dní (denne)
-- ------------------------------------------------------------
create or replace function public.lead_followups_run()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  today   date   := (now() at time zone 'Europe/Bratislava')::date;
  now_ms  bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  cfg     jsonb;
  leads   jsonb;
  tasks   jsonb;
  notifs  jsonb;
  days    int[];
  i       int;
  l       jsonb;
  created_date date;
  age     int;
  d       int;
  step    int;
  nxt     int;
  done    jsonb;
  made    int := 0;
  tid     text;
  title_txt text;
  asg_id  text;
  asg_name text;
  nm      text;
  ids     text[];
  uid     text;
begin
  select value into cfg from workspace where key = 'leadIntakeCfg';
  cfg := coalesce(cfg, '{}'::jsonb);
  if coalesce((cfg->>'enabled')::boolean, true) = false then return jsonb_build_object('ok', true, 'made', 0, 'disabled', true); end if;
  if coalesce((cfg->>'followups')::boolean, true) = false then return jsonb_build_object('ok', true, 'made', 0, 'followups_off', true); end if;
  days := array(select (x)::int from jsonb_array_elements_text(coalesce(cfg->'followDays','[1,3,7]'::jsonb)) x order by 1);
  if array_length(days, 1) is null then return jsonb_build_object('ok', true, 'made', 0); end if;

  select value into leads  from workspace where key = 'bizLeads' for update;
  select value into tasks  from workspace where key = 'tasks'    for update;
  select value into notifs from workspace where key = 'notifs'   for update;
  if leads is null or tasks is null then return jsonb_build_object('ok', false, 'error', 'workspace_rows_missing'); end if;
  notifs := coalesce(notifs, '[]'::jsonb);

  for i in 0 .. jsonb_array_length(leads) - 1 loop
    l := leads->i;
    continue when coalesce(l->>'webForm','false') <> 'true';
    continue when coalesce(l->>'stage','') <> 'new';
    continue when coalesce(l->>'lost','false') = 'true';
    continue when coalesce(l->>'contactedAt','') <> '';
    created_date := (to_timestamp(coalesce((l->>'createdAt')::bigint, now_ms) / 1000.0) at time zone 'Europe/Bratislava')::date;
    age := today - created_date;
    done := coalesce(l->'autoFu', '{}'::jsonb);

    -- najneskorší už nastalý krok, ktorý ešte nebol urobený
    step := null;
    foreach d in array days loop
      if age >= d and not (done ? d::text) then step := d; end if;
    end loop;
    continue when step is null;

    -- všetky kroky do `step` sa považujú za vybavené (ak cron nebežal, nevznikne 3 úloh naraz)
    foreach d in array days loop
      if d <= step then done := jsonb_set(done, array[d::text], to_jsonb(now_ms)); end if;
    end loop;
    nxt := null;
    foreach d in array days loop
      if d > step and nxt is null then nxt := d; end if;
    end loop;

    asg_id := nullif(l->>'assignedToId','');
    asg_name := nullif(l->>'assignedTo','');
    nm := coalesce(nullif(l->>'contactName',''), l->>'name');
    tid := 'wf' || substr(md5(random()::text || clock_timestamp()::text || i::text), 1, 10);
    title_txt := 'Follow-up (' || step || '. deň): zatiaľ nekontaktovaný záujemca ' || nm;
    tasks := jsonb_build_array(jsonb_build_object(
      'id', tid, 'title', title_txt,
      'desc', 'Dopyt z webu (' || created_date::text || ') je stále v stave „Nový“ — nikto sa záujemcovi neozval.' || E'\n\n'
              || 'Kontakt: ' || coalesce(nullif(l->>'contactPhone',''),'—') || ' · ' || coalesce(nullif(l->>'contactEmail',''),'—') || E'\n'
              || 'Lokalita: ' || coalesce(nullif(l->>'location',''),'—')
              || case when nxt is null then E'\n\nPosledný automatický follow-up. Ak sa nedá nadviazať kontakt, označ lead ako stratený.' else '' end,
      'status', 'todo', 'priority', case when step >= 7 then 'M' else 'H' end,
      'assigneeIds', case when asg_id is not null then jsonb_build_array(asg_id) else '[]'::jsonb end,
      'assignees',   case when asg_name is not null then jsonb_build_array(asg_name) else '[]'::jsonb end,
      'assigneeId', coalesce(asg_id,''), 'assignee', coalesce(asg_name,''),
      'project', '', 'category', 'admin', 'propId', '', 'propName', '',
      'dueDate', today::text, 'recurring', '', 'parentId', '',
      'createdAt', now_ms, 'updatedAt', now_ms, 'completedAt', null,
      'createdById', '', 'createdByName', 'Automatický follow-up',
      'comments', '[]'::jsonb, 'files', '[]'::jsonb, 'source', 'web_form_fu', 'leadId', l->>'id', 'dealId', ''
    )) || tasks;

    ids := array(select distinct x from (
        select asg_id as x
        union all select jsonb_array_elements_text(coalesce(cfg->'notify','[]'::jsonb))
      ) q where x is not null and x <> '');
    foreach uid in array ids loop
      notifs := jsonb_build_array(jsonb_build_object('id','ntf_'||substr(md5(random()::text||uid||i::text),1,10),'forUserId',uid,'type','task_due',
                'title','⏰ Follow-up '||step||'. deň: '||nm,'body','Záujemca z webu sa stále nedočkal kontaktu','taskId',tid,'link',null,'read',false,'ts',now_ms)) || notifs;
    end loop;

    l := jsonb_set(l, '{autoFu}', done);
    l := jsonb_set(l, '{nextFollowUp}', to_jsonb(case when nxt is null then today::text else (created_date + nxt)::text end));
    l := jsonb_set(l, '{updatedAt}', to_jsonb(now_ms));
    leads := jsonb_set(leads, array[i::text], l);
    made := made + 1;
  end loop;

  if made > 0 then
    if jsonb_array_length(notifs) > 500 then notifs := (select jsonb_agg(e) from (select e from jsonb_array_elements(notifs) with ordinality t(e, o) order by o limit 500) s); end if;
    update workspace set value = leads  where key = 'bizLeads';
    update workspace set value = tasks  where key = 'tasks';
    update workspace set value = notifs where key = 'notifs';
  end if;
  return jsonb_build_object('ok', true, 'made', made);
end;
$$;

revoke all on function public.lead_followups_run() from public, anon, authenticated;
grant execute on function public.lead_followups_run() to service_role;

-- denne 05:30 UTC (po hostex-daily-sync 05:07, pred ops-digest 06:00)
create extension if not exists pg_cron;
select cron.unschedule('lead-followups') where exists (select 1 from cron.job where jobname = 'lead-followups');
select cron.schedule('lead-followups', '30 5 * * *', $$ select public.lead_followups_run(); $$);
