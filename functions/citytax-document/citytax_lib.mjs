// City-tax / waste-fee notification documents (RS Properties / Keystone).
// Pure functions shared by the Edge Function (Deno) and the local tests (Node):
//   calc(type, input)              -> { values:{PLACEHOLDER:text}, summary:{...} }   (all the arithmetic lives here)
//   buildDocument(JSZip, tpl, type, input, stamp?) -> Uint8Array (.docx)
// The templates are the team's real Word documents with {{PLACEHOLDERS}} where the values go, so the output keeps the
// municipality's own layout, fonts and logos. Types: ba_month (Bratislava, monthly accommodation-tax statement),
// lm_tax_q (Liptovsky Mikulas, quarterly accommodation-tax notification), lm_waste_q (Liptovsky Mikulas, quarterly waste fee).

export const TYPES = ["ba_month", "lm_tax_q", "lm_waste_q"];

const num = (v) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const intStr = (v) => String(Math.max(0, Math.round(num(v))));

// Rounding of money to cents. The team's past notifications truncate (51 x 0,137 = 6,987 was filed as 6,98), so 'down' is
// the default; 'round' is ordinary half-up rounding.
export function roundMoney(x, mode = "down") {
  const c = x * 100;
  return (mode === "round" ? Math.round(c + 1e-9) : Math.floor(c + 1e-6)) / 100;
}
export function fmtMoney(x) {            // 35 -> "35", 6.98 -> "6,98", 6.5 -> "6,50"
  const r = Math.round(x * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(".", ",");
}
export function fmtRate(x, minDec = 2) { // 0.137 -> "0,137", 1.5 -> "1,50"
  let s = String(x); if (!s.includes(".")) s += ".";
  const dec = s.split(".")[1]; if (dec.length < minDec) s += "0".repeat(minDec - dec.length);
  return s.replace(/\.$/, "").replace(".", ",");
}
export function fmtDate(iso) {            // 2026-03-02 -> "02.03.2026"
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
}
function periodMonth(p) { const m = /^(\d{4})-(\d{2})$/.exec(String(p || "")); return m ? `${m[2]}/${m[1]}` : String(p || ""); }
function periodQuarter(p) { const m = /^(\d{4})-Q([1-4])$/.exec(String(p || "")); return m ? `0${m[2]}/${m[1]}` : String(p || ""); }

export function calc(type, d) {
  const mode = d.rounding === "round" ? "round" : "down";
  if (type === "ba_month") {
    const persons = num(d.persons), nights = num(d.nights), rate = num(d.rate) || 3.5;
    const exemptP = num(d.exemptPersons), exemptN = num(d.exemptNights), nonTax = num(d.nonTaxNights), platform = num(d.platformNights);
    const r07 = Math.max(0, persons - exemptP);
    const r08 = Math.max(0, nights - exemptN - nonTax - platform);
    const tax = roundMoney(r08 * rate, mode);
    const blank = (v) => (num(v) > 0 ? intStr(v) : "");
    return {
      summary: { persons, nights, taxableNights: r08, taxablePersons: r07, rate, tax },
      values: {
        PERIOD: periodMonth(d.period), FACILITY: d.facility, OPERATOR: d.operator, IBAN: d.iban, ICO: d.ico, RESP: d.resp, PHONE: d.phone,
        R01: intStr(persons), R01A: intStr(d.foreignPersons), R02: intStr(nights), R02A: intStr(d.foreignNights),
        R03: blank(exemptP), R04: blank(exemptN), R05: blank(nonTax), R06: blank(platform),
        R07: intStr(r07), R08: intStr(r08), TAXTXT: ` ${fmtMoney(tax)}  EUR`,
        VS: d.vs, KS: d.ks || "0558", SIGNER: "   " + (d.signer || ""), DATE: "  " + fmtDate(d.date),
      },
    };
  }
  if (type === "lm_tax_q") {
    const rate = num(d.rate) || 1.5, nights = num(d.nights);
    const tax = roundMoney(nights * rate, mode);
    return {
      summary: { persons: num(d.persons), nights, rate, tax },
      values: {
        PERIOD: periodQuarter(d.period), OPERATOR: d.operator, ADDRESS: d.address, ICO: d.ico, DATE: fmtDate(d.date),
        FACNAME: d.facName, FACADDR: d.facAddr, PERSONS: intStr(d.persons), NIGHTS: intStr(nights), EXEMPT: intStr(d.exemptNights),
        TAX: fmtMoney(tax), RATE: fmtRate(rate), PHONE: d.phone, PAYIBAN: d.payIban, KS: d.ks || "0558", VS: d.vs,
      },
    };
  }
  if (type === "lm_waste_q") {
    const rate = num(d.rate) || 0.137, d1 = num(d.daysPersons), d2 = num(d.daysChildren), dt = d1 + d2;
    const fee = roundMoney(dt * rate, mode);
    return {
      summary: { totalDays: dt, rate, fee },
      values: {
        PERIOD: periodQuarter(d.period), OPERATOR: d.operator, ADDRESS: d.address, FACADDR: d.facAddr, DATE: fmtDate(d.date),
        P1: intStr(d.persons), SP1: " ".repeat(Math.max(2, 40 - intStr(d.persons).length)), D1: intStr(d1),
        P2: intStr(d.children), SP2: " ".repeat(Math.max(2, 40 - intStr(d.children).length)), D2: intStr(d2), DT: intStr(dt), FEE: fmtMoney(fee),
        RATE: fmtRate(rate, 3), PAYIBAN: d.payIban,
      },
    };
  }
  throw new Error("unknown type " + type);
}

const xmlEsc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function pngSize(b) {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, h: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0 };
  return null;
}

export async function buildDocument(JSZip, tplBytes, type, input, stamp) {
  const { values } = calc(type, input);
  const zip = await JSZip.loadAsync(tplBytes);
  let xml = await zip.file("word/document.xml").async("string");
  xml = xml.replace(/\{\{(\w+)\}\}/g, (_m, k) => xmlEsc(values[k] ?? ""));
  if (type !== "ba_month") {
    const size = stamp && pngSize(stamp);
    if (size && size.w > 0 && size.h > 0) {
      let cx = 1425575, cy = Math.round(cx * size.h / size.w);
      if (cy > 900000) { cy = 900000; cx = Math.round(cy * size.w / size.h); }
      xml = xml.replace(/<wp:extent cx="\d+" cy="\d+"\/>/, `<wp:extent cx="${cx}" cy="${cy}"/>`)
               .replace(/<a:ext cx="\d+" cy="\d+"\/>/, `<a:ext cx="${cx}" cy="${cy}"/>`);
      zip.file("word/media/image1.png", stamp);
    } else {
      xml = xml.replace(/<w:drawing>.*?<\/w:drawing>/s, "");   // no stamp / signature image supplied
    }
  }
  zip.file("word/document.xml", xml);
  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
