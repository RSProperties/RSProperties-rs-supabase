// RS Properties / Keystone - ticket-notify: pure logic (who gets which e-mail, texts, daily follow-up digest). No I/O, testable in Node.
// NOTE: keep this file plain ASCII (Slovak text uses \u escapes).

const TZ = "Europe/Bratislava";
export const APP_URL = "https://app.rsproperties.sk/";
export const CLOSED = ["resolved", "closed", "cancelled"];

export const STATUS = {
  new: ["Nov\u00fd", "New"], contacted: ["Hos\u0165 kontaktovan\u00fd", "Guest contacted"], waiting_guest: ["\u010cak\u00e1 na hos\u0165a", "Waiting for guest"],
  negotiating: ["Rokuje sa", "In discussion"], refund_offered: ["Refund pon\u00faknut\u00fd", "Refund offered"], refund_paid: ["Refund vyplaten\u00fd - \u010dak\u00e1 na uzavretie", "Refund paid - to be closed"], escalated: ["Eskalovan\u00e9 (podpora platformy)", "Escalated (platform support)"],
  resolved: ["Vyrie\u0161en\u00e9", "Resolved"], closed: ["Uzavret\u00e9 bez dohody", "Closed - no agreement"], cancelled: ["Zru\u0161en\u00e9", "Cancelled"],
};
export const TYPE = {
  review: ["Zl\u00e1 recenzia", "Bad review"], complaint: ["S\u0165a\u017enos\u0165 hos\u0165a", "Guest complaint"], refund: ["Refund / kompenz\u00e1cia", "Refund / compensation"],
  damage: ["\u0160koda", "Damage"], other: ["In\u00e9", "Other"],
};
export const OUTCOME = {
  review_removed: ["Recenzia odstr\u00e1nen\u00e1", "Review removed"], review_kept: ["Recenzia ostala", "Review stays"], review_updated: ["Recenzia upraven\u00e1 hos\u0165om", "Review updated by guest"],
  solved: ["Probl\u00e9m vyrie\u0161en\u00fd", "Problem solved"], no_agreement: ["Bez dohody", "No agreement"], duplicate: ["Zru\u0161en\u00e9 / duplicitn\u00e9", "Cancelled / duplicate"],
};
const EN = (lang) => lang === "en";
export const lbl = (map, key, lang) => { const v = map[key]; return v ? (EN(lang) ? v[1] : v[0]) : String(key || ""); };

export const normEmail = (s) => String(s ?? "").trim().toLowerCase();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clip = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "\u2026" : s; };

export function todayLocal(d) { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
export function daysBetween(fromIso, toIso) { return Math.round((Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / 86400000); }
const fmtDate = (iso, lang) => { if (!iso) return ""; const [y, m, d] = String(iso).slice(0, 10).split("-"); return EN(lang) ? `${y}-${m}-${d}` : `${Number(d)}. ${Number(m)}. ${y}`; };

// people = active team members [{id,name,email,role,lang}]
const person = (people, email) => people.find((p) => normEmail(p.email) === normEmail(email));
const admins = (people) => people.filter((p) => p.role === "admin");

// who gets an e-mail for an event (actor never; only active team members; each at most once; ADMINS NEVER - they see everything in the app: bell + badge + "needs attention" filter)
export function recipientsFor(kind, ticket, event, people) {
  const actor = normEmail(event && event.by_email);
  const add = [];
  const assignee = ticket.assignee_email, creator = ticket.created_by_email;
  if (kind === "created") add.push(assignee, ...admins(people).map((a) => a.email));
  else if (kind === "assigned") add.push(event && event.data && event.data.to_email);
  else if (kind === "guest_replied" || kind === "reopen") add.push(assignee, creator, ...admins(people).map((a) => a.email));
  else if (kind === "refund_offered" || kind === "refund_paid" || kind === "escalated") add.push(assignee, creator, ...admins(people).map((a) => a.email));
  else if (kind === "close") add.push(creator, assignee, ...admins(people).map((a) => a.email));
  const seen = new Set(), out = [];
  for (const e of add) {
    const n = normEmail(e); if (!n || n === actor || seen.has(n)) continue;
    const p = person(people, n); if (!p || p.role === "admin") continue;
    seen.add(n); out.push(p);
  }
  return out;
}

const KIND_SUBJECT = {
  created: ["Nov\u00fd ticket", "New ticket"], assigned: ["Pridelen\u00fd ticket", "Ticket assigned to you"], guest_replied: ["Hos\u0165 odpovedal", "Guest replied"],
  refund_offered: ["Pon\u00faknut\u00fd refund", "Refund offered"], refund_paid: ["Refund vyplaten\u00fd", "Refund paid"], escalated: ["Eskalovan\u00e9", "Escalated"],
  close: ["Uzavret\u00fd ticket", "Ticket closed"], reopen: ["Znovu otvoren\u00fd ticket", "Ticket reopened"],
};

export function eventLine(kind, ticket, event, lang) {
  const d = (event && event.data) || {};
  const who = event && event.by_name ? event.by_name : "";
  const en = EN(lang);
  if (kind === "created") return en ? `${who} created the ticket.` : `${who} vytvoril/a ticket.`;
  if (kind === "assigned") return en ? `${who} assigned the ticket to ${d.to || "?"}.` : `${who} pridelil/a ticket: ${d.to || "?"}.`;
  if (kind === "guest_replied") return en ? `${who}: the guest replied.` : `${who}: hos\u0165 odpovedal.`;
  if (kind === "refund_offered") return en ? `${who} offered a refund of ${d.amount} EUR.` : `${who} pon\u00fakol/a refund ${d.amount} EUR.`;
  if (kind === "refund_paid") return en ? `${who} marked the refund (${d.amount} EUR) as paid.` : `${who} ozna\u010dil/a refund (${d.amount} EUR) ako vyplaten\u00fd.`;
  if (kind === "escalated") return en ? `${who} escalated the case to the platform support.` : `${who} eskaloval/a pr\u00edpad na podporu platformy.`;
  if (kind === "close") return en ? `${who} closed the ticket${d.outcome ? ": " + lbl(OUTCOME, d.outcome, lang) : ""}.` : `${who} uzavrel/a ticket${d.outcome ? ": " + lbl(OUTCOME, d.outcome, lang) : ""}.`;
  if (kind === "reopen") return en ? `${who} reopened the ticket.` : `${who} znovu otvoril/a ticket.`;
  return "";
}

function ticketBlock(t, lang) {
  const en = EN(lang), rows = [];
  rows.push([en ? "Property" : "Nehnute\u013enos\u0165", t.property_name]);
  if (t.guest_name) rows.push([en ? "Guest" : "Hos\u0165", t.guest_name + (t.platform ? " (" + t.platform + ")" : "")]);
  if (t.check_in || t.check_out) rows.push([en ? "Stay" : "Pobyt", `${fmtDate(t.check_in, lang)} - ${fmtDate(t.check_out, lang)}`]);
  rows.push([en ? "Status" : "Stav", lbl(STATUS, t.status, lang)]);
  if (t.refund_amount) rows.push(["Refund", `${t.refund_amount} EUR (${t.refund_status})`]);
  if (t.next_follow_up) rows.push(["Follow-up", fmtDate(t.next_follow_up, lang)]);
  if (t.assignee_name) rows.push([en ? "Assigned to" : "Pridelen\u00e9", t.assignee_name]);
  return rows;
}

export function buildEventEmail(kind, ticket, event, lang, appUrl = APP_URL) {
  const en = EN(lang), t = ticket, link = `${appUrl}?ticket=${t.id}`;
  const subject = `${(KIND_SUBJECT[kind] || ["Ticket", "Ticket"])[en ? 1 : 0]} ${t.ticket_no} \u00b7 ${t.property_name}${t.guest_name ? " \u00b7 " + t.guest_name : ""}`;
  const line = eventLine(kind, t, event, lang);
  const note = event && event.text ? clip(event.text, 600) : "";
  const rows = ticketBlock(t, lang);
  const text = `${line}\n\n${t.ticket_no} - ${lbl(TYPE, t.type, lang)}: ${t.title}\n` + rows.map((r) => `${r[0]}: ${r[1]}`).join("\n") +
    (note ? `\n\n${en ? "Note" : "Pozn\u00e1mka"}: ${note}` : "") + `\n\n${en ? "Open the ticket" : "Otvori\u0165 ticket"}: ${link}\n`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1a2e44;max-width:560px">` +
    `<p style="margin:0 0 12px">${esc(line)}</p>` +
    `<div style="border:1px solid #d9dee5;border-radius:10px;padding:12px 14px;background:#f8f9fb"><div style="font-weight:700;margin-bottom:6px">${esc(t.ticket_no)} &middot; ${esc(lbl(TYPE, t.type, lang))}: ${esc(t.title)}</div>` +
    rows.map((r) => `<div style="margin:2px 0"><span style="color:#6b7886">${esc(r[0])}:</span> ${esc(r[1])}</div>`).join("") + `</div>` +
    (note ? `<p style="margin:12px 0 0;white-space:pre-wrap"><span style="color:#6b7886">${en ? "Note" : "Pozn\u00e1mka"}:</span> ${esc(note)}</p>` : "") +
    `<p style="margin:16px 0 0"><a href="${esc(link)}" style="background:#1a2e44;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">${en ? "Open the ticket" : "Otvori\u0165 ticket"}</a></p></div>`;
  return { subject, text, html };
}

// ---- daily follow-up digest ----
// tickets = open tickets [{...}], today = 'YYYY-MM-DD' (Bratislava). Returns [{person, mine:[...], overview:[...]}] - nothing for people with nothing to do.
export function buildDigests(tickets, people, today) {
  const open = tickets.filter((t) => !CLOSED.includes(t.status));
  const owner = (t) => normEmail(t.assignee_email) || normEmail(t.created_by_email);
  const due = open.filter((t) => t.next_follow_up && t.next_follow_up <= today);
  const byPerson = new Map();
  for (const t of due) { const e = owner(t); if (e) { if (!byPerson.has(e)) byPerson.set(e, []); byPerson.get(e).push(t); } }
  // admins get NO e-mail: their overview of what slips (overdue 2+ days, unassigned, silent 7+ days) lives in the app (filter + bell + badge)
  const out = [];
  for (const [e, list] of byPerson) {
    const p = person(people, e); if (!p || p.role === "admin") continue;
    const mine = list.sort((a, b) => String(a.next_follow_up).localeCompare(String(b.next_follow_up)));
    out.push({ person: p, mine, overview: [] });
  }
  return out;
}

export function buildDigestEmail(d, today, appUrl = APP_URL) {
  const lang = d.person.lang === "en" ? "en" : "sk", en = lang === "en";
  const line = (t) => {
    const late = t.next_follow_up ? daysBetween(t.next_follow_up, today) : 0;
    const when = !t.next_follow_up ? (en ? "no follow-up date" : "bez follow-upu") : late > 0 ? (en ? `${late} d overdue` : `${late} d po term\u00edne`) : (en ? "today" : "dnes");
    return `${t.ticket_no} \u00b7 ${t.property_name}${t.guest_name ? " \u00b7 " + t.guest_name : ""} \u00b7 ${lbl(STATUS, t.status, lang)} \u00b7 ${when}`;
  };
  const n = d.mine.length;
  const subject = n ? (en ? `Tickets: ${n} follow-up${n === 1 ? "" : "s"} due` : `Tickety: ${n} follow-up${n === 1 ? "" : "y"} na vybavenie`)
                    : (en ? "Tickets: overview of cases that need attention" : "Tickety: preh\u013ead pr\u00edpadov, ktor\u00e9 treba pohn\u00fa\u0165");
  const link = (t) => `${appUrl}?ticket=${t.id}`;
  const text = (n ? `${en ? "Follow-ups due today or overdue" : "Follow-upy na dnes alebo po term\u00edne"}:\n` + d.mine.map((t) => `- ${line(t)}\n  ${link(t)}`).join("\n") + "\n\n" : "") +
    (d.overview.length ? `${en ? "Team overview (overdue 2+ days, unassigned or silent for a week)" : "Preh\u013ead t\u00edmu (po term\u00edne 2+ dni, nepridelen\u00e9 alebo bez aktivity t\u00fd\u017ede\u0148)"}:\n` + d.overview.map((t) => `- ${line(t)}${t.assignee_name ? " \u00b7 " + t.assignee_name : " \u00b7 " + (en ? "unassigned" : "nepridelen\u00e9")}\n  ${link(t)}`).join("\n") + "\n\n" : "") +
    `${en ? "All tickets" : "V\u0161etky tickety"}: ${appUrl}\n`;
  const li = (t, extra) => `<li style="margin:5px 0"><a href="${esc(link(t))}" style="color:#1a2e44;font-weight:700">${esc(t.ticket_no)}</a> &middot; ${esc(t.property_name)}${t.guest_name ? " &middot; " + esc(t.guest_name) : ""} &middot; ${esc(lbl(STATUS, t.status, lang))} &middot; <b>${esc(line(t).split(" \u00b7 ").pop())}</b>${extra || ""}</li>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1a2e44;max-width:600px">` +
    (n ? `<p style="margin:0 0 6px;font-weight:700">${en ? "Follow-ups due today or overdue" : "Follow-upy na dnes alebo po term\u00edne"}</p><ul style="padding-left:18px;margin:0 0 16px">${d.mine.map((t) => li(t)).join("")}</ul>` : "") +
    (d.overview.length ? `<p style="margin:0 0 6px;font-weight:700">${en ? "Team overview" : "Preh\u013ead t\u00edmu"}</p><ul style="padding-left:18px;margin:0 0 16px">${d.overview.map((t) => li(t, " &middot; " + esc(t.assignee_name || (en ? "unassigned" : "nepridelen\u00e9")))).join("")}</ul>` : "") +
    `<p style="margin:12px 0 0"><a href="${esc(appUrl)}" style="background:#1a2e44;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">${en ? "Open Keystone" : "Otvori\u0165 Keystone"}</a></p></div>`;
  return { subject, text, html };
}
