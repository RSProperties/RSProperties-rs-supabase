// Reads title / price / pack size out of a product page. Plain JS (no Deno APIs) so Node tests can import it too.
// NOTE: keep this file plain ASCII.

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

export function toNum(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).replace(/\s| /g, "").replace(/[^\d.,-]/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function metaContent(html, key) {
  const re = new RegExp("<meta[^>]+(?:property|name|itemprop)=[\"']" + key + "[\"'][^>]*>", "i");
  const m = html.match(re);
  if (!m) return "";
  const c = m[0].match(/content=["']([^"']*)["']/i);
  return c ? decodeEntities(c[1]) : "";
}

function ldObjects(html) {
  const out = [];
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const j = JSON.parse(m[1].trim());
      const walk = (o) => {
        if (!o) return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (typeof o !== "object") return;
        out.push(o);
        if (o["@graph"]) walk(o["@graph"]);
      };
      walk(j);
    } catch { /* ignore broken JSON-LD */ }
  }
  return out;
}

function typeIs(o, t) {
  const ty = o["@type"];
  return Array.isArray(ty) ? ty.includes(t) : ty === t;
}

function offerPrice(offers, pageUrl) {
  let list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  // shops with variants (Tchibo: 10 / 30 / 80 capsules) list one offer per variant; the URL's article_id says which one is meant
  const aid = String(pageUrl || "").match(/[?&]article_id=([^&#]+)/);
  if (aid && list.length > 1) {
    const hit = list.filter((o) => o && typeof o.url === "string" && o.url.includes("article_id=" + aid[1]));
    if (hit.length) list = hit;
  }
  for (const of of list) {
    if (!of || typeof of !== "object") continue;
    const cur = String(of.priceCurrency || "").toUpperCase();
    let p = toNum(of.price);
    if (p === null && of.priceSpecification) {
      const ps = Array.isArray(of.priceSpecification) ? of.priceSpecification[0] : of.priceSpecification;
      p = toNum(ps && ps.price);
    }
    if (p === null) p = toNum(of.lowPrice);
    if (p !== null) return { price: p, currency: cur };
  }
  return null;
}

export function extractProduct(html, pageUrl) {
  const res = { title: "", price: null, currency: "", image: "", how: "" };
  const lds = ldObjects(html);
  const prod = lds.find((o) => typeIs(o, "Product")) || null;
  if (prod) {
    res.title = decodeEntities(prod.name || "");
    const img = Array.isArray(prod.image) ? prod.image[0] : prod.image;
    res.image = typeof img === "string" ? img : (img && img.url) || "";
    const op = offerPrice(prod.offers, pageUrl);
    if (op) { res.price = op.price; res.currency = op.currency; res.how = "json-ld"; }
  }
  if (res.price === null) {
    const p = metaContent(html, "product:price:amount") || metaContent(html, "og:price:amount") || metaContent(html, "price");
    const n = toNum(p);
    if (n !== null) {
      res.price = n;
      res.currency = (metaContent(html, "product:price:currency") || metaContent(html, "og:price:currency") || metaContent(html, "priceCurrency")).toUpperCase();
      res.how = "meta";
    }
  }
  if (res.price === null) {
    const m = html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i) || html.match(/content=["']([^"']+)["'][^>]*itemprop=["']price["']/i);
    const n = m ? toNum(m[1]) : null;
    if (n !== null) { res.price = n; res.how = "itemprop"; }
  }
  // Shoptet B2B shops (e.g. Humed) put the price WITHOUT VAT into JSON-LD/meta but print the price with VAT ("price-final")
  // next to "... bez DPH". The comparison is done on prices WITH VAT (what is actually paid), so prefer the printed final price.
  if (/class="price-additional"[^>]*>[^<]*bez\s+DPH/i.test(html)) {
    const f = html.match(/class="price-final-holder"[^>]*>\s*(?:<[^>]+>\s*)*([^<]+)</i);
    const n = f ? toNum(f[1]) : null;
    if (n !== null && n > 0) { res.price = n; res.currency = res.currency || "EUR"; res.how = "price-final"; }
  }
  if (!res.title) {
    res.title = metaContent(html, "og:title");
    if (!res.title) { const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); res.title = t ? decodeEntities(t[1].replace(/\s+/g, " ").trim()) : ""; }
  }
  if (!res.image) res.image = metaContent(html, "og:image");
  res.title = res.title.replace(/\s+/g, " ").trim().slice(0, 200);
  if (res.price !== null && !(res.price > 0 && res.price < 100000)) { res.price = null; res.how = ""; }
  return res;
}

const COUNT_WORDS = "ks|kus|kusy|kusov|pcs|pc|rol|rola|role|roly|roliek|rolky|roli|rolí|kotuc|kotuce|kotucov|kotúč|kotúče|kotúčov|kapsul|kapsule|kapsúl|kapsula|tablet|tablety|tabliet|tabletiek|tabs|tab|vreck|vrecka|vreciek|vreckiek|vrecko|sacok|sacky|sáčkov|sáčky|utierok|utierky|spongii|špongií|špongie|par|pary|párov|prani|pranie|praní|davok|dávok|davky|dávky|kapsuly";

// Guess how many pieces (baseUnit) one package holds from its title. Returns null when the title says nothing clear.
export function guessPackQty(title, baseUnit) {
  const t = String(title || "").toLowerCase().replace(/,/g, ".");
  const bu = String(baseUnit || "").toLowerCase();
  const liquid = /^(l|liter|litre|litrov|ml)$/.test(bu);
  if (liquid) {
    const mul = t.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(l|ml)\b/);
    const one = t.match(/(\d+(?:\.\d+)?)\s*(l|litr\w*|ml)\b/);
    let v = null, u = "";
    if (mul) { v = +mul[1] * +mul[2]; u = mul[3]; }
    else if (one) { v = +one[1]; u = one[2]; }
    if (v === null) return null;
    const inMl = u === "ml";
    if (bu === "ml") return inMl ? v : v * 1000;
    return inMl ? v / 1000 : v;
  }
  const wordRe = new RegExp("(\\d+)\\s*(?:" + COUNT_WORDS + ")(?![a-z])", "i");
  const mul = t.match(/(\d+)\s*x\s*(\d+)\s*(ks|rol|kotu|kaps|tabl|vreck)/i);
  if (mul) return +mul[1] * +mul[2];
  const one = t.match(wordRe);
  if (one && +one[1] > 0) return +one[1];
  return null;
}
