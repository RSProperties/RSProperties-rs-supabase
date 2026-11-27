// RS Properties / Keystone - mail-watchdog: pure logic (is the mail sync healthy, when to alert, alert texts). No I/O, testable in Node.
// NOTE: keep this file plain ASCII (Slovak text uses \u escapes).

export const STALE_MIN = 45;       // poller beats every 5 min -> 45 min = 9 missed runs
export const FAILING_RUNS = 3;     // poller runs but fails this many times in a row
export const CLASSIFY_MIN = 20;    // incoming mail stays unclassified longer than this = Claude is not working
export const REALERT_H = 12;       // same ongoing problem: remind at most every 12 h
const TZ = "Europe/Bratislava";

export function bratislavaHour(d) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(d));
}
// no NEW alert at night (Mac asleep is normal); the Keystone banner is shown regardless
export function isQuietHours(d) { const h = bratislavaHour(d); return h >= 22 || h < 7; }

export function fmtLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return new Intl.DateTimeFormat("sk-SK", { timeZone: TZ, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

// status = row of mail_poller_status, unclassifiedOld = number of incoming mails unclassified for > CLASSIFY_MIN minutes
export function assess(status, unclassifiedOld, now) {
  const s = status || {};
  const beat = s.last_beat_at ? Date.parse(s.last_beat_at) : NaN;
  const ageMin = Number.isFinite(beat) ? Math.floor((now.getTime() - beat) / 60000) : null;
  let syncWhy = null;
  if (ageMin === null || ageMin > STALE_MIN) syncWhy = "stale";
  else if ((s.consecutive_fails || 0) >= FAILING_RUNS) syncWhy = "failing";
  return { syncBad: !!syncWhy, syncWhy, ageMin, classifyBad: unclassifiedOld > 0, unclassified: unclassifiedOld };
}

const ago = (m) => (m == null ? "nikdy" : m < 90 ? `${m} min` : m < 36 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} dn\u00ed`);

// what to send now (at most one mail per kind). Alerting state lives in status.stale_alerted_at / classify_alerted_at.
export function plan(status, a, now) {
  const s = status || {};
  const quiet = isQuietHours(now);
  const due = (ts) => !ts || now.getTime() - Date.parse(ts) > REALERT_H * 3600000;
  const acts = [];
  if (a.syncBad) { if (!quiet && due(s.stale_alerted_at)) acts.push("sync_alert"); }
  else if (s.stale_alerted_at && !quiet) acts.push("sync_recovered");
  if (a.classifyBad) { if (!quiet && due(s.classify_alerted_at)) acts.push("classify_alert"); }
  else if (s.classify_alerted_at && !quiet) acts.push("classify_recovered");
  return acts;
}

export function alertMail(kind, status, a) {
  const s = status || {};
  if (kind === "sync_alert") {
    const why = a.syncWhy === "failing"
      ? `Poller be\u017e\u00ed, ale ${s.consecutive_fails}\u00d7 po sebe zlyhal: ${s.last_error || "(bez popisu)"}.`
      : `Poller sa ozval naposledy ${s.last_beat_at ? fmtLocal(s.last_beat_at) + " (pred " + ago(a.ageMin) + ")" : "nikdy"}.`;
    return {
      subject: "\u26a0\ufe0f Po\u0161ta info@: synchroniz\u00e1cia do Keystone stoj\u00ed",
      text: `Nov\u00e9 e-maily od klientov sa moment\u00e1lne nena\u010d\u00edtavaj\u00fa do Keystone.\n\n${why}\n\n` +
        "Ni\u010d sa nestratilo - po\u0161ta zost\u00e1va v schr\u00e1nke info@ a po obnoven\u00ed sa dotiahne sama. Dovtedy kontroluj schr\u00e1nku info@ aj ru\u010dne.\n\n" +
        "\u010co skontrolova\u0165: Mac s pollerom mus\u00ed by\u0165 zapnut\u00fd a pripojen\u00fd na internet. Ak je zapnut\u00fd, v Termin\u00e1li spusti:\n" +
        "launchctl kickstart -k gui/$(id -u)/sk.rsproperties.mail-poller\n" +
        "a pozri ~/agents/mail/mail_poller.log.\n\nDal\u0161ie upozornenie pr\u00edde najsk\u00f4r o 12 hod\u00edn, ak probl\u00e9m potrv\u00e1. Ke\u010f sa to obnov\u00ed, pr\u00edde kr\u00e1tka spr\u00e1va.",
    };
  }
  if (kind === "sync_recovered") {
    return { subject: "\u2705 Po\u0161ta info@: synchroniz\u00e1cia znova be\u017e\u00ed", text: "Poller sa znova hl\u00e1si a po\u0161ta sa na\u010d\u00edtava do Keystone. Zame\u0161kan\u00e9 e-maily sa dotiahli." };
  }
  if (kind === "classify_alert") {
    const err = s.classify_error || "";
    const credit = /credit|billing|balance/i.test(err);
    return {
      subject: "\u26a0\ufe0f Po\u0161ta info@: Claude nevyhodnocuje prich\u00e1dzaj\u00face spr\u00e1vy",
      text: `${a.unclassified} spr\u00e1v od klientov \u010dak\u00e1 na vyhodnotenie dlh\u0161ie ako ${CLASSIFY_MIN} min\u00fat. Spr\u00e1vy s\u00fa ulo\u017een\u00e9 a vidno ich v Keystone, ale bez zhrnutia a z\u00e1meru.\n\n` +
        `Posledn\u00e1 chyba: ${err || "(nezn\u00e1ma)"}\n\n` +
        (credit ? "Vyzer\u00e1 to na vy\u010derpan\u00fd kredit Anthropic API - dopl\u0148 ho na console.anthropic.com (Plans & Billing). Pozor: kredit v predplatnom claude.ai je in\u00fd ako kredit API.\n\n" : "") +
        "Po oprave sa spr\u00e1vy vyhodnotia samy pri \u010fal\u0161om behu pollera (do 5 min\u00fat).",
    };
  }
  return { subject: "\u2705 Po\u0161ta info@: vyhodnocovanie spr\u00e1v znova funguje", text: "Claude znova vyhodnocuje prich\u00e1dzaj\u00face spr\u00e1vy, nevyhodnoten\u00e9 spr\u00e1vy sa doplnili." };
}
