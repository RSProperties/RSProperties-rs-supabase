-- ============================================================
-- Onboarding formulár majiteľa — 2026-11-12
--
-- Verejný formulár (app.rsproperties.sk/onboarding) -> Edge Function `owner-onboarding` -> owner_onboarding_apply().
-- Všetko sa zapíše ATOMICKY (jedna transakcia, select ... for update) do workspace kľúčov:
--   owners      majiteľ (existujúci sa nájde podľa e-mailu / telefónu a len sa doplní, inak vznikne nový)
--   properties  nehnuteľnosť v stave „Onboarding“ (odpovede z formulára + vybavenie), duplicita adresy u toho istého majiteľa sa nezdvojí
--   bizLeads    akvizičný lead (stupeň „Kvalifikácia“, zdroj „Onboarding formulár“); existujúci lead rovnakého e-mailu sa len doplní
--               + firemný záznam majiteľa so zákazkami „žiadosť o cenovú ponuku“ za každú vyžiadanú službu (fotenie, smart zámok…)
--   tasks       „Onboarding majiteľa“ pre zodpovedného (striedanie podľa leadIntakeCfg) + „Pripraviť cenovú ponuku“ pri službách
--   clRuns      onboarding checklist (ak existuje šablóna), položky ktoré formulár už splnil sú odškrtnuté
--   notifs      zvonček
--   onboardingLog  záznam o odoslaní (posledných 150)
-- Nastavenia: workspace.leadIntakeCfg = {assignees:[{id,name}], rr, notify:[ids], onboardingEnabled}  (zdieľané s príjmom dopytov z webu)
-- Faktúra sa nevystavuje automaticky — vystavuje sa ručne po schválenej cenovej ponuke.
-- ============================================================

-- normalizovaný kľúč adresy: bez diakritiky, bez PSČ, bez interpunkcie a medzier (na zistenie duplicity nehnuteľnosti)
create or replace function public.onb_addr_key(a text)
returns text
language sql
immutable
as $f$
  select lower(regexp_replace(regexp_replace(translate(coalesce(a,''),
    'áäčďéíĺľňóôŕšťúýžÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽ', 'aacdeillnoorstuyzaacdeillnoorstuyz'),
    '\m\d{3} ?\d{2}\M', '', 'g'), '[^A-Za-z0-9]', '', 'g'));
$f$;

create or replace function public.owner_onboarding_apply(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  today      date    := (now() at time zone 'Europe/Bratislava')::date;
  now_ms     bigint  := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_name     text    := btrim(coalesce(p->>'name',''));
  v_email    text    := lower(btrim(coalesce(p->>'email','')));
  v_phone    text    := btrim(coalesce(p->>'phone',''));
  v_phone_d  text    := regexp_replace(coalesce(p->>'phone',''), '\D', '', 'g');
  v_addr     text    := btrim(coalesce(p->>'address',''));
  v_dry      boolean := coalesce((p->>'dry')::boolean, false);
  v_city     text;
  v_addr_key text;
  cfg        jsonb;
  assignees  jsonb;
  n          int;
  asg        jsonb;
  asg_id     text;
  asg_name   text;
  asg_email  text;
  owners     jsonb;
  props      jsonb;
  leads      jsonb;
  tasks      jsonb;
  notifs     jsonb;
  runs       jsonb;
  tpls       jsonb;
  olog       jsonb;
  i          int;
  o          jsonb;
  o_phone    text;
  owner_i    int := -1;
  owner_id   text;
  owner_new  boolean := false;
  prop_i     int := -1;
  prop_id    text;
  prop_new   boolean := false;
  pr         jsonb;
  lead_i     int := -1;
  lead_id    text;
  lead_new   boolean := false;
  l          jsonb;
  co_i       int := -1;
  co_id      text;
  co_new     boolean := false;
  tpl        jsonb;
  run_items  jsonb;
  it         jsonb;
  main_task  text;
  quote_task text := null;
  summary    text;
  vyb        jsonb := '[]'::jsonb;
  a          text;
  svc        text;
  svc_labels text[] := '{}';
  svc_label  text;
  v_pid      text    := btrim(coalesce(p->>'pid',''));
  v_ptk      text    := btrim(coalesce(p->>'ptk',''));
  linked     boolean := false;
  deals      jsonb;
  deal_first text := '';
  deal_id    text;
  notify_ids text[];
  uid        text;
  ntf_title  text;
  ntf_body   text;
  legal      text;
  note_txt   text;
begin
  if v_name = '' then return jsonb_build_object('ok', false, 'error', 'no_name'); end if;
  if v_email = '' and length(v_phone_d) < 7 then return jsonb_build_object('ok', false, 'error', 'no_contact'); end if;
  if v_addr = '' then return jsonb_build_object('ok', false, 'error', 'no_address'); end if;

  select value into cfg from workspace where key = 'leadIntakeCfg';
  cfg := coalesce(cfg, '{}'::jsonb);
  if coalesce((cfg->>'onboardingEnabled')::boolean, true) = false then
    return jsonb_build_object('ok', false, 'error', 'disabled');
  end if;

  assignees := coalesce(cfg->'assignees', '[]'::jsonb);
  n := jsonb_array_length(assignees);
  if n > 0 then
    asg := assignees->(coalesce((cfg->>'rr')::int, 0) % n);
    asg_id := asg->>'id'; asg_name := asg->>'name';
  end if;

  -- mesto = posledná časť adresy za čiarkou bez PSČ
  v_city := btrim(regexp_replace(coalesce(substring(v_addr from ',\s*([^,]+)$'), ''), '^[0-9 ]+', ''));
  v_addr_key := onb_addr_key(v_addr);

  -- vybavenie z formulára -> zoznam vybavenia nehnuteľnosti (APT_AMENITIES)
  for a in select jsonb_array_elements_text(coalesce(p->'amenities', '[]'::jsonb)) loop
    a := case lower(btrim(a))
      when 'klimatizácia' then 'Klimatizácia'
      when 'balkón / terasa' then 'Balkón/Terasa'
      when 'práčka' then 'Práčka'
      when 'umývačka riadu' then 'Umývačka riadu'
      when 'kávovar' then 'Kávovar'
      when 'tv' then 'TV'
      when 'wi-fi' then 'WiFi'
      when 'detektor dymu' then 'Detektor dymu'
      when 'detská postieľka' then 'Detská postieľka'
      else null end;
    if a is not null and not vyb ? a then vyb := vyb || to_jsonb(a); end if;
  end loop;
  if lower(coalesce(p->>'pets','')) in ('yes','áno','ano') and not vyb ? 'Domáce zvieratá povolené' then vyb := vyb || to_jsonb('Domáce zvieratá povolené'::text); end if;
  if lower(coalesce(p->>'parking','')) like 'private%' and not vyb ? 'Súkromné parkovanie' then vyb := vyb || to_jsonb('Súkromné parkovanie'::text); end if;

  -- vyžiadané služby
  for svc in select jsonb_array_elements_text(coalesce(p->'services', '[]'::jsonb)) loop
    svc_label := case svc
      when 'photo' then 'Profesionálne fotenie'
      when 'smartlock' then 'Smart zámok (TTLock)'
      when 'furnishing' then 'Zariadenie / dokúpenie vybavenia'
      when 'staging' then 'Home staging'
      else null end;
    if svc_label is not null and not svc_label = any(svc_labels) then svc_labels := svc_labels || svc_label; end if;
  end loop;

  summary := array_to_string(array_remove(array[
      case when coalesce(p->>'ptype','') <> '' then 'Typ: ' || (p->>'ptype') end,
      case when coalesce(p->>'guests','') <> '' then 'Max. hostí: ' || (p->>'guests') end,
      case when coalesce(p->>'floor','') <> '' then 'Poschodie / výťah: ' || (p->>'floor') end,
      case when coalesce(p->>'area','') <> '' then 'Plocha: ' || (p->>'area') || ' m²' end,
      case when coalesce(nullif(p->>'parkingLabel',''), nullif(p->>'parking','')) is not null then 'Parkovanie: ' || coalesce(nullif(p->>'parkingLabel',''), p->>'parking') end,
      case when coalesce(p->>'ready','') <> '' then 'Pripravená na obhliadku a fotenie: ' || (p->>'ready') end,
      case when coalesce(p->>'shootDate','') <> '' then 'Preferovaný termín obhliadky/fotenia: ' || (p->>'shootDate') end,
      case when coalesce(p->>'hasPhotos','') <> '' then 'Profesionálne fotografie: ' || (p->>'hasPhotos') end,
      case when coalesce(p->>'furnished','') <> '' then 'Zariadená a pripravená na pobyt: ' || (p->>'furnished') end,
      case when jsonb_array_length(coalesce(p->'amenities','[]'::jsonb)) > 0 then 'Vybavenie: ' || array_to_string(array(select jsonb_array_elements_text(p->'amenities')), ', ') end,
      case when coalesce(p->>'pets','') <> '' then 'Domáce zvieratá za príplatok: ' || (p->>'pets') end,
      case when coalesce(p->>'keys','') <> '' then 'Súpravy kľúčov: ' || (p->>'keys') end,
      case when coalesce(p->>'smartLock','') <> '' then 'Smart lock na dverách: ' || (p->>'smartLock') end,
      case when coalesce(p->>'listed','') <> '' or coalesce(p->>'activeBookings','') <> '' then 'Už inzerované / aktívne rezervácie: ' || coalesce(nullif(p->>'listed',''),'—') || case when coalesce(p->>'activeBookings','') <> '' then ' — ' || (p->>'activeBookings') else '' end end,
      case when jsonb_array_length(coalesce(p->'platforms','[]'::jsonb)) > 0 then 'Inzerované na: ' || array_to_string(array(select jsonb_array_elements_text(p->'platforms')), ', ') end,
      case when coalesce(p->>'takeoverDate','') <> '' then 'Prevzatie správy od: ' || (p->>'takeoverDate') end,
      case when array_length(svc_labels,1) > 0 then 'Záujem o služby: ' || array_to_string(svc_labels, ', ') end,
      case when coalesce(p->>'note','') <> '' then 'Poznámka majiteľa: ' || (p->>'note') end
    ], null), E'\n');
  summary := coalesce(nullif(summary,''), '—');

  legal := case when coalesce(p->>'partyName','') <> '' or coalesce(p->>'ico','') <> '' or coalesce(p->>'partyAddress','') <> ''
    then 'Zmluvná strana: ' || coalesce(nullif(p->>'partyName',''),'—') || ' · IČO: ' || coalesce(nullif(p->>'ico',''),'—') || ' · Adresa/sídlo: ' || coalesce(nullif(p->>'partyAddress',''),'—')
    else '' end;

  note_txt := 'Onboarding formulár majiteľa:' || E'\nMeno: ' || v_name || E'\nE-mail: ' || coalesce(nullif(v_email,''),'—')
    || E'\nTelefón: ' || coalesce(nullif(v_phone,''),'—') || E'\nAdresa: ' || v_addr || E'\n' || summary
    || case when legal <> '' then E'\n' || legal else '' end;

  -- zámky (pevné poradie)
  select value into owners from workspace where key = 'owners'     for update;
  select value into props  from workspace where key = 'properties' for update;
  select value into leads  from workspace where key = 'bizLeads'   for update;
  select value into tasks  from workspace where key = 'tasks'      for update;
  select value into notifs from workspace where key = 'notifs'     for update;
  select value into runs   from workspace where key = 'clRuns'     for update;
  select value into tpls   from workspace where key = 'clTemplates';
  select value into olog   from workspace where key = 'onboardingLog' for update;
  if owners is null or props is null or leads is null or tasks is null then
    return jsonb_build_object('ok', false, 'error', 'workspace_rows_missing');
  end if;
  notifs := coalesce(notifs, '[]'::jsonb); runs := coalesce(runs, '[]'::jsonb); olog := coalesce(olog, '[]'::jsonb);

  -- osobný odkaz z Keystone (Properties -> Formulár pre majiteľa): platný token = údaje sa uložia k TEJ nehnuteľnosti
  if v_pid <> '' and v_ptk <> '' then
    for i in 0 .. jsonb_array_length(props) - 1 loop
      pr := props->i;
      if pr->>'id' = v_pid and coalesce(pr->>'onbToken','') = v_ptk
         and coalesce((pr->>'onbTokenAt')::bigint, now_ms) > now_ms - 60::bigint*86400000 then
        prop_i := i; linked := true; exit;
      end if;
    end loop;
  end if;

  -- majiteľ: pri odkaze z Keystone majiteľ nehnuteľnosti, inak e-mail alebo telefón
  if linked and coalesce((props->prop_i)->>'ownerId','') <> '' then
    for i in 0 .. jsonb_array_length(owners) - 1 loop
      if (owners->i)->>'id' = (props->prop_i)->>'ownerId' then owner_i := i; exit; end if;
    end loop;
  end if;
  if owner_i < 0 then
  for i in 0 .. jsonb_array_length(owners) - 1 loop
    o := owners->i;
    o_phone := regexp_replace(coalesce(o->>'phone',''), '\D', '', 'g');
    if (v_email <> '' and lower(btrim(coalesce(o->>'email',''))) = v_email)
       or (length(v_phone_d) >= 7 and length(o_phone) >= 7 and right(o_phone, 9) = right(v_phone_d, 9)) then
      owner_i := i; exit;
    end if;
  end loop;
  end if;

  -- nehnuteľnosť: rovnaká adresa (normalizovaná) pri tom istom majiteľovi (alebo pri neznámom majiteľovi)
  for i in 0 .. jsonb_array_length(props) - 1 loop
    exit when linked;
    pr := props->i;
    continue when v_addr_key = '' or length(v_addr_key) < 6;
    if onb_addr_key(pr->>'address') = v_addr_key then
      prop_i := i; exit;
    end if;
  end loop;

  -- akvizičný lead rovnakého e-mailu / telefónu (nie stratený)
  for i in 0 .. jsonb_array_length(leads) - 1 loop
    l := leads->i;
    continue when coalesce(l->>'lost','false') = 'true';
    continue when coalesce(l->>'type','acquisition') = 'company';
    o_phone := regexp_replace(coalesce(l->>'contactPhone',''), '\D', '', 'g');
    if (v_email <> '' and lower(btrim(coalesce(l->>'contactEmail',''))) = v_email)
       or (length(v_phone_d) >= 7 and length(o_phone) >= 7 and right(o_phone, 9) = right(v_phone_d, 9)) then
      lead_i := i; exit;
    end if;
  end loop;

  -- firemný záznam majiteľa (zákazky o služby)
  if array_length(svc_labels, 1) > 0 then
    for i in 0 .. jsonb_array_length(leads) - 1 loop
      l := leads->i;
      continue when coalesce(l->>'type','acquisition') <> 'company';
      if v_email <> '' and lower(btrim(coalesce(l->>'contactEmail',''))) = v_email then co_i := i; exit; end if;
    end loop;
  end if;

  if v_dry then
    return jsonb_build_object('ok', true, 'dry', true, 'ownerExists', owner_i >= 0, 'propertyExists', prop_i >= 0,
      'leadExists', lead_i >= 0, 'services', to_jsonb(svc_labels),
      'assignee', case when asg is null then null else jsonb_build_object('id', asg_id, 'name', asg_name) end, 'note', note_txt);
  end if;

  if asg_id is not null then
    begin select email into asg_email from team_users where id::text = asg_id;
    exception when others then asg_email := null; end;
  end if;

  -- ---------- majiteľ
  if owner_i >= 0 then
    o := owners->owner_i; owner_id := o->>'id';
    if coalesce(o->>'phone','') = '' and v_phone <> '' then o := jsonb_set(o, '{phone}', to_jsonb(v_phone)); end if;
    if coalesce(o->>'email','') = '' and v_email <> '' then o := jsonb_set(o, '{email}', to_jsonb(v_email)); end if;
  else
    owner_new := true;
    owner_id := 'oo' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);
    o := jsonb_build_object('id', owner_id, 'name', v_name, 'email', v_email, 'phone', v_phone, 'notes', '',
      'portalUser', case when v_email <> '' then lower(regexp_replace(split_part(v_email, '@', 1), '[^a-zA-Z0-9]', '', 'g')) else '' end,
      'portalPassPlain', '', 'portalPassHash', '', 'source', 'onboarding');
  end if;
  if coalesce(p->>'partyName','') <> '' and coalesce(o->>'legalName','') = '' then o := jsonb_set(o, '{legalName}', to_jsonb(btrim(p->>'partyName')), true); end if;
  if coalesce(p->>'ico','') <> '' and coalesce(o->>'ico','') = '' then o := jsonb_set(o, '{ico}', to_jsonb(btrim(p->>'ico')), true); end if;
  if coalesce(p->>'partyAddress','') <> '' and coalesce(o->>'legalAddress','') = '' then o := jsonb_set(o, '{legalAddress}', to_jsonb(btrim(p->>'partyAddress')), true); end if;
  o := jsonb_set(o, '{notes}', to_jsonb(
        case when coalesce(o->>'notes','') <> '' then (o->>'notes') || E'\n' else '' end
        || to_char(today, 'DD.MM.YYYY') || ': vyplnený onboarding formulár (' || v_addr || ')' || case when legal <> '' then E'\n' || legal else '' end), true);
  o := jsonb_set(o, '{_uAt}', to_jsonb(now_ms), true);
  if owner_i >= 0 then owners := jsonb_set(owners, array[owner_i::text], o); else owners := owners || jsonb_build_array(o); end if;

  -- ---------- nehnuteľnosť
  if prop_i >= 0 then
    pr := props->prop_i; prop_id := pr->>'id';
    if coalesce(pr->>'ownerId','') = '' then
      pr := jsonb_set(jsonb_set(pr, '{ownerId}', to_jsonb(owner_id)), '{owner}', to_jsonb(v_name));
    end if;
    pr := jsonb_set(pr, '{onboarding}', jsonb_build_object('submittedAt', now_ms, 'answers', p - 'dry' - 'hp' - 'ptk', 'repeat', not linked, 'linked', linked), true);
    if linked then
      pr := jsonb_set(pr, '{desc}', to_jsonb(
            case when coalesce(pr->>'desc','') <> '' then (pr->>'desc') || E'\n\n' else '' end
            || '— Formulár majiteľa (' || to_char(today, 'DD.MM.YYYY') || ') —' || E'\n' || summary), true);
      if coalesce(pr->>'address','') = '' then pr := jsonb_set(pr, '{address}', to_jsonb(v_addr), true); end if;
      if coalesce(pr->>'city','') = '' and v_city <> '' then pr := jsonb_set(pr, '{city}', to_jsonb(v_city), true); end if;
      if coalesce(pr->>'park','') = '' and coalesce(nullif(p->>'parkingLabel',''), nullif(p->>'parking','')) is not null then pr := jsonb_set(pr, '{park}', to_jsonb(coalesce(nullif(p->>'parkingLabel',''), p->>'parking')), true); end if;
      if coalesce(pr->>'keysNote','') = '' and coalesce(p->>'keys','') <> '' then pr := jsonb_set(pr, '{keysNote}', to_jsonb('Počet súprav kľúčov: ' || (p->>'keys')), true); end if;
      if jsonb_array_length(vyb) > 0 then
        pr := jsonb_set(pr, '{vybavenie}', (select coalesce(jsonb_agg(distinct e), '[]'::jsonb) from jsonb_array_elements(coalesce(pr->'vybavenie','[]'::jsonb) || vyb) e), true);
      end if;
      pr := (pr - 'onbToken' - 'onbTokenAt');
      pr := jsonb_set(pr, '{onbFormAt}', to_jsonb(now_ms), true);
    end if;
    pr := jsonb_set(pr, '{_uAt}', to_jsonb(now_ms), true);
    props := jsonb_set(props, array[prop_i::text], pr);
  else
    prop_new := true;
    prop_id := 'p' || now_ms::text;
    pr := jsonb_build_object('id', prop_id, 'name', left(v_addr, 120), 'address', v_addr, 'city', v_city, 'owner', v_name, 'ownerId', owner_id, 'group', '',
      'fee', 20, 'taxPerGuestNight', 0, 'defaultCleaning', 0, 'contractType', 'standard', 'fixAmount', 0, 'stav', 'Onboarding',
      'company', case when coalesce(p->>'ico','') <> '' then coalesce(nullif(btrim(p->>'partyName'),''), '') else '' end,
      'email', v_email, 'phone', v_phone, 'desc', summary,
      'park', coalesce(nullif(p->>'parkingLabel',''), nullif(p->>'parking',''), ''),
      'keysNote', case when coalesce(p->>'keys','') <> '' then 'Počet súprav kľúčov: ' || (p->>'keys') else '' end,
      'vybavenie', vyb,
      'onboarding', jsonb_build_object('submittedAt', now_ms, 'answers', p - 'dry' - 'hp' - 'ptk'),
      'portalShowChannel', true, 'portalShowGuest', true, 'portalShowCheckin', true, 'portalShowCheckout', true,
      'portalShowNights', true, 'portalShowBooked', true, 'portalShowGuests', true, 'portalShowRoomRate', true,
      'portalShowIncome', true, 'portalShowMgmt', true, 'portalShowCleaning', true, 'portalShowCityTax', true,
      'portalShowExtraExp', true, 'portalShowExtraInc', true, 'portalShowNP', true, '_uAt', now_ms);
    props := props || jsonb_build_array(pr);
  end if;

  -- ---------- akvizičný lead
  if lead_i >= 0 then
    l := leads->lead_i; lead_id := l->>'id';
    if coalesce(l->>'stage','new') = 'new' then
      l := jsonb_set(l, '{stage}', to_jsonb('qualifying'::text));
      l := jsonb_set(l, '{history}', coalesce(l->'history','[]'::jsonb) || jsonb_build_array(jsonb_build_object('stage','qualifying','ts',now_ms,'by','Onboarding formulár')), true);
    end if;
    l := jsonb_set(l, '{notes}', jsonb_build_array(jsonb_build_object('id','bn'||substr(md5(random()::text),1,8),'text',note_txt,'author','Onboarding formulár','ts',now_ms)) || coalesce(l->'notes','[]'::jsonb), true);
    l := jsonb_set(l, '{ownerId}', to_jsonb(owner_id), true);
    l := jsonb_set(l, '{propId}', to_jsonb(prop_id), true);
    l := jsonb_set(l, '{updatedAt}', to_jsonb(now_ms), true);
    l := jsonb_set(l, '{nextFollowUp}', to_jsonb(today::text), true);
    leads := jsonb_set(leads, array[lead_i::text], l);
  elsif not linked then
    lead_new := true;
    lead_id := 'bo' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);
    l := jsonb_build_object('id', lead_id, 'type', 'acquisition', 'name', v_name || ' — ' || left(v_addr, 80),
      'contactName', v_name, 'contactEmail', v_email, 'contactPhone', v_phone, 'location', coalesce(nullif(v_city,''), v_addr),
      'source', 'Onboarding formulár', 'onboardingForm', true,
      'ownerId', owner_id, 'propId', prop_id,
      'assignedTo', coalesce(asg_name,''), 'assignedToId', coalesce(asg_id,''),
      'stage', 'qualifying', 'estUnits', 1, 'estValue', null, 'lost', false,
      'nextFollowUp', today::text, 'createdAt', now_ms, 'updatedAt', now_ms,
      'history', jsonb_build_array(jsonb_build_object('stage','qualifying','ts',now_ms,'by','Onboarding formulár')),
      'notes', jsonb_build_array(jsonb_build_object('id','bn'||substr(md5(random()::text),1,8),'text',note_txt,'author','Onboarding formulár','ts',now_ms)),
      'files', '[]'::jsonb);
    leads := jsonb_build_array(l) || leads;
  end if;

  -- ---------- zákazky o služby (firemný záznam majiteľa)
  if array_length(svc_labels, 1) > 0 then
    deals := '[]'::jsonb;
    foreach svc_label in array svc_labels loop
      deal_id := 'bd' || substr(md5(random()::text || svc_label), 1, 9);
      if deal_first = '' then deal_first := deal_id; end if;
      deals := deals || jsonb_build_array(jsonb_build_object('id', deal_id, 'title', svc_label || ' — ' || left(v_addr, 80),
        'direction', 'client', 'desc', 'Žiadosť o cenovú ponuku z onboarding formulára. Nehnuteľnosť: ' || v_addr || '. Majiteľ: ' || v_name || '.',
        'amount', null, 'stage', 'new', 'lost', false, 'lostReason', '', 'nextFollowUp', (today + 1)::text, 'createdAt', now_ms, 'updatedAt', now_ms));
    end loop;
    if co_i >= 0 then
      l := leads->co_i; co_id := l->>'id';
      l := jsonb_set(l, '{deals}', coalesce(l->'deals','[]'::jsonb) || deals, true);
      l := jsonb_set(l, '{updatedAt}', to_jsonb(now_ms), true);
      leads := jsonb_set(leads, array[co_i::text], l);
    else
      co_new := true;
      co_id := 'bc' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);
      l := jsonb_build_object('id', co_id, 'type', 'company', 'name', v_name, 'companyWhat', 'Majiteľ nehnuteľnosti (onboarding)',
        'contactName', v_name, 'contactEmail', v_email, 'contactPhone', v_phone, 'location', coalesce(nullif(v_city,''), ''),
        'source', 'Onboarding formulár', 'ownerId', owner_id,
        'assignedTo', coalesce(asg_name,''), 'assignedToId', coalesce(asg_id,''),
        'deals', deals, 'createdAt', now_ms, 'updatedAt', now_ms,
        'notes', jsonb_build_array(jsonb_build_object('id','bn'||substr(md5(random()::text),1,8),'text','Žiadosť o služby z onboarding formulára: ' || array_to_string(svc_labels, ', '),'author','Onboarding formulár','ts',now_ms)),
        'files', '[]'::jsonb);
      leads := jsonb_build_array(l) || leads;
    end if;
  end if;

  -- ---------- úlohy
  main_task := 'wo' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);
  tasks := jsonb_build_array(jsonb_build_object(
    'id', main_task,
    'title', case when linked then '📝 Majiteľ vyplnil onboarding formulár: ' else '🏠 Onboarding majiteľa: ' end || v_name || ' — ' || left(v_addr, 70),
    'desc', note_txt || case when linked
            then E'\n\nÚdaje sú uložené v nehnuteľnosti (Info → Interný popis). Skontroluj ich a doplň onboarding checklist.'
            else E'\n\nČo robiť: ozvať sa majiteľovi, dohodnúť obhliadku' || case when coalesce(p->>'shootDate','') <> '' then ' (preferuje ' || (p->>'shootDate') || ')' else '' end
              || E'. Nehnuteľnosť je v Keystone v stave „Onboarding“; v Properties ju dokonči tlačidlom „Dokončiť onboarding“ (zmluva, poplatky, aktivácia).' end,
    'status', 'todo', 'priority', case when linked then 'M' else 'H' end,
    'assigneeIds', case when asg_id is not null then jsonb_build_array(asg_id) else '[]'::jsonb end,
    'assignees',   case when asg_name is not null then jsonb_build_array(asg_name) else '[]'::jsonb end,
    'assigneeId', coalesce(asg_id,''), 'assignee', coalesce(asg_name,''),
    'project', '', 'category', 'admin', 'propId', prop_id, 'propName', left(v_addr, 120),
    'dueDate', today::text, 'recurring', '', 'parentId', '',
    'createdAt', now_ms, 'updatedAt', now_ms, 'completedAt', null,
    'createdById', '', 'createdByName', 'Onboarding formulár',
    'comments', '[]'::jsonb, 'files', '[]'::jsonb, 'source', 'onboarding_form', 'leadId', coalesce(lead_id, ''), 'dealId', '')) || tasks;

  if array_length(svc_labels, 1) > 0 then
    quote_task := 'wq' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);
    tasks := jsonb_build_array(jsonb_build_object(
      'id', quote_task, 'title', '💶 Pripraviť cenovú ponuku: ' || array_to_string(svc_labels, ', ') || ' — ' || left(v_addr, 60),
      'desc', 'Majiteľ ' || v_name || ' požiadal v onboarding formulári o: ' || array_to_string(svc_labels, ', ')
              || E'.\nZákazky sú v Obchod a marketing → Firmy a dodávatelia (záznam „' || v_name || '“). Cenovú ponuku vytvor v Protokole nehnuteľnosti (ponuka vybavenia) alebo cez ponuku firmy. Faktúru vystav ručne po schválení ponuky.',
      'status', 'todo', 'priority', 'M',
      'assigneeIds', case when asg_id is not null then jsonb_build_array(asg_id) else '[]'::jsonb end,
      'assignees',   case when asg_name is not null then jsonb_build_array(asg_name) else '[]'::jsonb end,
      'assigneeId', coalesce(asg_id,''), 'assignee', coalesce(asg_name,''),
      'project', '', 'category', 'admin', 'propId', prop_id, 'propName', left(v_addr, 120),
      'dueDate', (today + 1)::text, 'recurring', '', 'parentId', '',
      'createdAt', now_ms, 'updatedAt', now_ms, 'completedAt', null,
      'createdById', '', 'createdByName', 'Onboarding formulár',
      'comments', '[]'::jsonb, 'files', '[]'::jsonb, 'source', 'onboarding_quote', 'leadId', co_id, 'dealId', deal_first)) || tasks;
  end if;

  -- ---------- checklist (iba ak existuje onboarding šablóna a nehnuteľnosť je nová)
  if prop_new and tpls is not null then
    select t into tpl from jsonb_array_elements(tpls) t where coalesce(t->>'onboardingDefault','false') = 'true' limit 1;
    if tpl is not null then
      run_items := '[]'::jsonb;
      for it in select e from jsonb_array_elements(coalesce(tpl->'items','[]'::jsonb)) e loop
        run_items := run_items || jsonb_build_array(jsonb_build_object(
          'id', it->>'id', 'text', it->>'text', 'critical', coalesce((it->>'critical')::boolean, false), 'action', coalesce(it->>'action',''),
          'done', coalesce(it->>'autoKey','') in ('prop_created','owner_linked')));
      end loop;
      runs := jsonb_build_array(jsonb_build_object(
        'id', 'or' || substr(md5(random()::text || clock_timestamp()::text), 1, 10), 'templateId', tpl->>'id',
        'title', tpl->>'title', 'category', tpl->>'category', 'property', left(v_addr, 120), 'assignee', coalesce(asg_name,''),
        'date', today::text, 'propId', prop_id, 'items', run_items, 'status', 'active', 'createdAt', now_ms, 'completedAt', null)) || runs;
    end if;
  end if;

  -- ---------- zvonček: zodpovedný + členovia z cfg.notify
  notify_ids := array(select distinct x from (
      select asg_id as x
      union all select jsonb_array_elements_text(coalesce(cfg->'notify','[]'::jsonb))
    ) q where x is not null and x <> '');
  ntf_title := case when linked then '📝 Majiteľ vyplnil onboarding formulár: ' else '🏠 Nový onboarding majiteľa: ' end || v_name;
  ntf_body  := left(v_addr, 100) || case when array_length(svc_labels,1) > 0 then ' · žiada: ' || array_to_string(svc_labels, ', ') else '' end;
  foreach uid in array notify_ids loop
    notifs := jsonb_build_array(jsonb_build_object('id','ntf_'||substr(md5(random()::text||uid),1,10),'forUserId',uid,'type','task_assign',
              'title',ntf_title,'body',ntf_body,'taskId',main_task,'link',null,'read',false,'ts',now_ms)) || notifs;
  end loop;
  if jsonb_array_length(notifs) > 500 then notifs := (select jsonb_agg(e) from (select e from jsonb_array_elements(notifs) with ordinality t(e, o) order by o limit 500) s); end if;

  -- záznam o odoslaní
  olog := jsonb_build_array(jsonb_build_object('id', 'ol' || substr(md5(random()::text), 1, 8), 'ts', now_ms, 'name', v_name, 'email', v_email,
            'address', v_addr, 'ownerId', owner_id, 'propId', prop_id, 'leadId', coalesce(lead_id, ''), 'ownerNew', owner_new, 'propNew', prop_new, 'linked', linked,
            'services', to_jsonb(svc_labels), 'lang', coalesce(p->>'lang','sk'))) || olog;
  if jsonb_array_length(olog) > 150 then olog := (select jsonb_agg(e) from (select e from jsonb_array_elements(olog) with ordinality t(e, o) order by o limit 150) s); end if;

  update workspace set value = owners where key = 'owners';
  update workspace set value = props  where key = 'properties';
  update workspace set value = leads  where key = 'bizLeads';
  update workspace set value = tasks  where key = 'tasks';
  update workspace set value = notifs where key = 'notifs';
  if exists (select 1 from workspace where key = 'clRuns') then update workspace set value = runs where key = 'clRuns';
  elsif jsonb_array_length(runs) > 0 then insert into workspace(key, value) values ('clRuns', runs); end if;
  if exists (select 1 from workspace where key = 'onboardingLog') then update workspace set value = olog where key = 'onboardingLog';
  else insert into workspace(key, value) values ('onboardingLog', olog); end if;
  if n > 0 then
    update workspace set value = jsonb_set(cfg, '{rr}', to_jsonb(coalesce((cfg->>'rr')::int, 0) + 1)) where key = 'leadIntakeCfg';
  end if;

  return jsonb_build_object('ok', true, 'ownerId', owner_id, 'propId', prop_id, 'leadId', lead_id, 'companyLeadId', co_id,
    'taskId', main_task, 'quoteTaskId', quote_task, 'ownerNew', owner_new, 'propNew', prop_new, 'leadNew', lead_new, 'linked', linked,
    'services', to_jsonb(svc_labels),
    'assignee', case when asg_id is null then null else jsonb_build_object('id', asg_id, 'name', asg_name, 'email', asg_email) end);
end;
$$;

revoke all on function public.owner_onboarding_apply(jsonb) from public, anon, authenticated;
revoke all on function public.onb_addr_key(text) from public, anon, authenticated;
grant execute on function public.owner_onboarding_apply(jsonb) to service_role;
grant execute on function public.onb_addr_key(text) to service_role;
