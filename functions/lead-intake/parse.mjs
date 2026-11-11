// Maps the fields of a website contact form (WPForms) to a lead. Plain JS (no Deno APIs) so Node tests can import it.
// NOTE: keep this file plain ASCII.

function norm(s) {
  return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
export function clip(v, n) {
  return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);
}
const LIMITS = { name: 120, email: 200, phone: 40, location: 200, type: 120, message: 3000, page: 300 };

// label -> field. Order matters (e-mail before name, because "e-mail" contains "mail" and some forms say "Meno a e-mail").
export function fieldKey(label) {
  const l = norm(label);
  if (/e-?mail|email/.test(l)) return "email";
  if (/mobile|phone|telef|mobil|tel\.|tel$|cislo/.test(l)) return "phone";
  if (/location|lokalit|adres|city|mesto|obec|address/.test(l)) return "location";
  if (/type|size|typ |typ$|velkost|izb|nehnutel|property/.test(l)) return "type";
  if (/message|sprav|poznam|note|comment|dotaz|text/.test(l)) return "message";
  if (/name|meno|priezvisko/.test(l)) return "name";
  return "";
}

// body: { fields:[{label,value}], name, email, phone, location, type, message, page }  (direct properties win)
export function mapLead(body) {
  const out = { name: "", email: "", phone: "", location: "", type: "", message: "", page: "" };
  const extra = [];
  const fields = Array.isArray(body && body.fields) ? body.fields : [];
  for (const f of fields.slice(0, 40)) {
    if (!f) continue;
    const label = f.label != null ? f.label : f.name;
    let value = f.value;
    if (Array.isArray(value)) value = value.join(", ");
    if (value && typeof value === "object") value = Object.values(value).join(" ");
    const k = fieldKey(label);
    const v = clip(value, k ? LIMITS[k] : 300);
    if (!v) continue;
    if (k && !out[k]) out[k] = v;
    else if (k && out[k] && k !== "message") extra.push(clip(label, 60) + ": " + v);
    else if (!k) extra.push(clip(label, 60) + ": " + v);
  }
  for (const k of Object.keys(out)) {
    if (body && body[k] != null && String(body[k]).trim() !== "") out[k] = clip(body[k], LIMITS[k]);
  }
  out.email = out.email.toLowerCase();
  if (extra.length) out.message = (out.message ? out.message + "\n\n" : "") + extra.join("\n");
  out.message = out.message.slice(0, 3000);
  return out;
}
export function validEmail(e) { return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(e || ""); }
export function phoneDigits(p) { return String(p || "").replace(/\D/g, ""); }
// links in the message: classic spam signal
export function looksLikeSpam(lead) {
  const urls = (lead.message.match(/https?:\/\//gi) || []).length + (lead.name.match(/https?:\/\//gi) || []).length;
  return urls >= 3;
}
