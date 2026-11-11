// Validation + normalisation of the public owner-onboarding form. Plain JS (no Deno APIs) so Node tests can import it.
// The form sends language-neutral codes; this maps them to the Slovak labels Keystone stores (see owner_onboarding_apply).
// NOTE: keep this file plain ASCII (escape sequences for non-ASCII).

export function clip(v, n) {
  return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
}
export function clipMulti(v, n) {   // keeps line breaks
  return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, n);
}
export function validEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(e || "")) && String(e).length <= 200; }
export function phoneDigits(p) { return String(p || "").replace(/\D/g, ""); }
export function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return "";
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return "";
  const y = +s.slice(0, 4); return y >= 2024 && y <= 2035 ? s : "";
}
const yn = (v) => { const s = String(v || "").toLowerCase(); return s === "yes" || s === "ano" || s === "true" ? "\u00c1no" : s === "no" || s === "nie" || s === "false" ? "Nie" : ""; };
const PTYPE = { studio: "\u0160t\u00fadio", "1": "1-izbov\u00fd", "2": "2-izbov\u00fd", "3": "3-izbov\u00fd a viac", house: "Dom / chata" };
const PARKING = { private: "S\u00fakromn\u00e9 parkovacie miesto", free: "Verejn\u00e9 parkovanie v okol\u00ed - zadarmo", paid: "Verejn\u00e9 parkovanie v okol\u00ed - platen\u00e9", none: "Nie je k dispoz\u00edcii" };
const AMEN = { ac: "Klimatiz\u00e1cia", balcony: "Balk\u00f3n / terasa", washer: "Pr\u00e1\u010dka", dishwasher: "Um\u00fdva\u010dka riadu", coffee: "K\u00e1vovar", tv: "TV", wifi: "Wi-Fi", smoke: "Detektor dymu", crib: "Detsk\u00e1 postie\u013eka", highchair: "Detsk\u00e1 stoli\u010dka" };
const PLAT = { airbnb: "Airbnb", booking: "Booking.com", other: "In\u00e1 platforma" };
export const SERVICES = ["photo", "smartlock", "furnishing", "staging"];

const pick = (map, codes, max) => (Array.isArray(codes) ? codes : []).slice(0, max).map((c) => map[String(c)]).filter((x, i, a) => x && a.indexOf(x) === i);

// body = raw JSON from the browser. Returns {ok, error?, form}
export function cleanForm(body) {
  const b = body && typeof body === "object" ? body : {};
  const f = {
    lang: b.lang === "en" ? "en" : "sk",
    name: clip(b.name, 120), email: clip(b.email, 200).toLowerCase(), phone: clip(b.phone, 40), address: clip(b.address, 200),
    ptype: PTYPE[String(b.ptype)] || "", floor: clip(b.floor, 120), guests: "", area: "",
    parking: PARKING[String(b.parking)] ? String(b.parking) : "", parkingLabel: PARKING[String(b.parking)] || "",
    ready: yn(b.ready), shootDate: validDate(b.shootDate), hasPhotos: yn(b.hasPhotos), furnished: yn(b.furnished),
    amenities: pick(AMEN, b.amenities, 12), pets: yn(b.pets), keys: "", activeBookings: clip(b.activeBookings, 300),
    smartLock: yn(b.smartLock), platforms: pick(PLAT, b.platforms, 3), takeoverDate: validDate(b.takeoverDate),
    partyName: clip(b.partyName, 160), ico: clip(b.ico, 20).replace(/[^0-9 ]/g, "").trim(), partyAddress: clip(b.partyAddress, 220),
    note: clipMulti(b.note, 2000),
    services: (Array.isArray(b.services) ? b.services : []).map(String).filter((s, i, a) => SERVICES.includes(s) && a.indexOf(s) === i),
    consent: b.consent === true,
    listed: yn(b.listed),
    pid: /^[A-Za-z0-9_-]{1,40}$/.test(String(b.pid || "")) ? String(b.pid) : "",
    ptk: /^[a-f0-9]{16,64}$/.test(String(b.ptk || "")) ? String(b.ptk) : "",
  };
  const g = parseInt(String(b.guests || "").replace(/\D/g, ""), 10); if (g > 0 && g <= 60) f.guests = String(g);
  const a = parseFloat(String(b.area || "").replace(",", ".")); if (a > 0 && a <= 5000) f.area = String(Math.round(a * 10) / 10).replace(/\.0$/, "");
  const k = parseInt(String(b.keys || "").replace(/\D/g, ""), 10); if (k >= 0 && k <= 50 && String(b.keys || "").trim() !== "") f.keys = String(k);
  if (f.email && !validEmail(f.email)) return { ok: false, error: "bad_email" };
  if (!f.name || f.name.length < 3) return { ok: false, error: "no_name" };
  if (!f.email && phoneDigits(f.phone).length < 7) return { ok: false, error: "no_contact" };
  if (!f.email) return { ok: false, error: "no_email" };
  if (phoneDigits(f.phone).length < 7) return { ok: false, error: "no_phone" };
  if (!f.address || f.address.length < 5) return { ok: false, error: "no_address" };
  if (!f.consent) return { ok: false, error: "consent_required" };
  return { ok: true, form: f };
}

// cheap anti-spam on top of the honeypot: links in free text, gibberish names
export function looksLikeSpam(f) {
  const text = [f.note, f.activeBookings, f.name, f.partyName].join(" ");
  const links = (text.match(/https?:\/\/|www\./gi) || []).length;
  if (links >= 2) return true;
  if (/(viagra|casino|crypto|bitcoin|seo service|backlink)/i.test(text)) return true;
  if (/^[^aeiouy\u00e1\u00e4\u00e9\u00ed\u00f3\u00f4\u00fa\u00fd\s]{9,}$/i.test(f.name.replace(/\s/g, ""))) return true;
  return false;
}
