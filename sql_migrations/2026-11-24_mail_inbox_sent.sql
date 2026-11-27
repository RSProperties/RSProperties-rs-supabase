-- ============================================================
-- Mail inbox faza 2A - 2026-11-24: odoslane spravy a automaticke "odpovedane"
--
-- Poller cita okrem INBOX aj INBOX.Sent (len citanie) a ukladaju sa aj odoslane maily ku znamym kontaktom
-- (mail_messages.direction = 'out', status 'handled'). mail_reconcile() oznaci prichadzajucu spravu ako
-- vybavenu, ak na nu uz odisla odpoved: rovnaky kontakt, odpoved je NOVSIA a patri do toho isteho vlakna
-- (In-Reply-To = Message-ID prichadzajucej, alebo rovnaky predmet po odrezani Re:/Fwd:).
-- Idempotentne, bezi na konci kazdeho ingestu. Vybavenu spravu mozno v Keystone vratit medzi nove.
-- ============================================================

create or replace function public.mail_subject_norm(p text)
  returns text language sql immutable
as $$
  select btrim(regexp_replace(lower(coalesce(p, '')), '^(\s*(re|fw|fwd|odp|aw|vs|sv)\s*:)+', '', 'g'));
$$;

create or replace function public.mail_reconcile()
  returns integer
  language plpgsql
  security definer
  set search_path = public
as $$
declare n integer;
begin
  with hit as (
    select distinct on (i.id) i.id as in_id, o.received_at as sent_at
    from public.mail_messages i
    join public.mail_messages o
      on o.direction = 'out'
     and o.received_at > i.received_at
     and lower(o.to_email) = lower(i.from_email)
     and ( (o.in_reply_to is not null and o.in_reply_to = i.message_id)
           or public.mail_subject_norm(o.subject) = public.mail_subject_norm(i.subject) )
    where i.direction = 'in' and i.status = 'new'
    order by i.id, o.received_at
  )
  update public.mail_messages m
     set status = 'handled',
         handled_by = 'automaticky (odpovedane ' || to_char(h.sent_at at time zone 'Europe/Bratislava', 'DD.MM. HH24:MI') || ')',
         handled_at = now()
    from hit h
   where m.id = h.in_id;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.mail_reconcile() from public, anon, authenticated;
grant execute on function public.mail_reconcile() to service_role;
