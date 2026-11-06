// RS Properties / Keystone — Supabase Edge Function
// Generates a real .docx "Preberací protokol" (property handover protocol)
// from structured data the team fills in once inside Keystone (Properties
// → Protokol tab), instead of retyping the same equipment/keys/wifi
// list into a Google Doc by hand every time. The output visually matches
// the team's real existing template (RS_ Preberací Protokol -
// Radlinského 22.docx) — same logo, fonts (DM Sans / Baloo Tamma 2, both
// real Google Fonts so Google Docs resolves them correctly once uploaded
// to Drive even without the fonts installed locally), accent color
// (#d5a173), and card-style tables — not just the same data, section for
// section, so the workflow after this stays exactly the same as before:
// download the .docx, upload it to Google Drive, run Drive's own
// "Request e-signature" on it (that feature only works on an actual
// Google Doc from inside Docs — no API — so this function's whole job is
// producing a real .docx, never a PDF).
//
// Auth: same "real active team member token, not the bare anon key" rule
// send-push was tightened to on 2026-09-22 — this generates a document
// containing an owner's contact details and full apartment inventory, so
// it's gated the same way.
//
// Deploy: via the Supabase MCP deploy_edge_function (this project has no
// local Supabase CLI set up — see CLAUDE.md).
// Styling reference: extracted directly from the real template's XML
// (colors/fonts/borders/shading) on 2026-09-27 — see CLAUDE.md for the
// full writeup of what was found and matched.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, HeadingLevel, AlignmentType, BorderStyle, ImageRun,
  Footer, ShadingType, VerticalAlign,
} from "npm:docx@9.0.2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

function sbHeaders() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
}

// Same allow-rule as bizdev-digest/ops-digest/send-push: service role
// (not actually used here — this is only ever called on-demand by a
// human clicking the download button, never by cron) OR any active team
// member's own Supabase Auth token.
async function callerAllowed(req: Request): Promise<boolean> {
  const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!auth) return false;
  try {
    const ur = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${auth}` } });
    if (!ur.ok) return false;
    const uid = (await ur.json())?.id;
    if (!uid) return false;
    const tr = await fetch(
      `${SB_URL}/rest/v1/team_users?select=active&auth_user_id=eq.${encodeURIComponent(uid)}&limit=1`,
      { headers: sbHeaders() },
    );
    const rows = await tr.json().catch(() => []);
    return Array.isArray(rows) && rows[0]?.active === true;
  } catch {
    return false;
  }
}

interface EquipItem { name: string; count?: string; status?: string; note?: string; }
interface ChkItem { text: string; ok?: boolean; note?: string; }
interface BuildItem { name: string; value?: string; note?: string; }
interface TodoItem { task?: string; owner?: string; note?: string; }
interface Payload {
  name?: string; address?: string; date?: string;
  ownerName?: string; contactMajitel?: string; rsRep?: string;
  keysNote?: string; wifiNetwork?: string; wifiPassword?: string; parking?: string;
  emergencyContact?: string;
  meterElectricity?: string; meterGas?: string; meterWater?: string;
  insurance?: string; registrationNote?: string;
  quickCheck?: ChkItem[]; strMin?: ChkItem[];
  kitchen?: EquipItem[]; living?: EquipItem[]; bathroom?: EquipItem[];
  building?: BuildItem[];
  todos?: TodoItem[]; notes?: string;
}

// ---- Brand style, extracted from the real template's XML ----
const INK = "1e1e1e";
const MUTED = "6d655e";
const WHITE = "ffffff";
const ACCENT = "d5a173";
const LABEL_BG = "f7efe8";
const ALT_BG = "fcfaf8";
const BORDER = "e6ddd5";
const HEAD_BORDER = "ead7c4";
const FONT_BODY = "DM Sans";
const FONT_HEAD = "Baloo Tamma 2";

const TABLE_WIDTH = 10312; // matches the real template's table width (dxa)
const THIN = { style: BorderStyle.SINGLE, size: 6, color: BORDER };
const THIN_BORDERS = { top: THIN, bottom: THIN, left: THIN, right: THIN };
function accentBorders(size = 8) {
  const b = { style: BorderStyle.SINGLE, size, color: ACCENT };
  return { top: b, bottom: b, left: b, right: b };
}

const LOGO_B64 = "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";

function logoImage() {
  const bin = atob(LOGO_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 },
    children: [new ImageRun({ data: bytes, transformation: { width: 90, height: 90 }, type: "png" })],
  });
}

function heading(text: string) {
  return new Paragraph({
    spacing: { before: 200, after: 100 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: HEAD_BORDER, space: 1 } },
    children: [new TextRun({ text, bold: true, size: 23, color: ACCENT, font: FONT_HEAD })],
  });
}

function labelCell(text: string, width: number) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA }, borders: THIN_BORDERS,
    shading: { type: ShadingType.CLEAR, fill: LABEL_BG },
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, size: 20, color: INK, font: FONT_BODY })] })],
  });
}
function valueCell(text: string, width: number) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA }, borders: THIN_BORDERS,
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ children: [new TextRun({ text: text || "-", size: 20, color: INK, font: FONT_BODY })] })],
  });
}
// A borderless "Label: value" info table — matches the real template's
// basic-info section (two columns, light shaded label column).
function infoTable(rows: [string, string][]) {
  const widths: [number, number] = [3500, TABLE_WIDTH - 3500];
  return new Table({
    width: { size: TABLE_WIDTH, type: WidthType.DXA }, columnWidths: widths, alignment: AlignmentType.CENTER,
    rows: rows.map(([label, value]) => new TableRow({ children: [labelCell(label, widths[0]), valueCell(value, widths[1])] })),
  });
}

function headerCell(text: string, width: number) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA }, borders: accentBorders(),
    shading: { type: ShadingType.CLEAR, fill: ACCENT },
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, bold: true, size: 20, color: WHITE, font: FONT_BODY })] })],
  });
}
function bodyCell(text: string, width: number, bold: boolean, altRow: boolean) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA }, borders: THIN_BORDERS,
    shading: altRow ? { type: ShadingType.CLEAR, fill: ALT_BG } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ children: [new TextRun({ text: text || "", size: 18, color: INK, bold, font: FONT_BODY })] })],
  });
}
function equipTable(items: EquipItem[]) {
  const widths = [4200, 900, 1400, 3812];
  const rows = [
    new TableRow({ children: [headerCell("Položka", widths[0]), headerCell("Počet", widths[1]), headerCell("Stav", widths[2]), headerCell("Poznámka", widths[3])] }),
    ...items.map((it, i) => new TableRow({ children: [
      bodyCell(it.name, widths[0], true, i % 2 === 1), bodyCell(it.count || "", widths[1], false, i % 2 === 1),
      bodyCell(it.status || "", widths[2], false, i % 2 === 1), bodyCell(it.note || "", widths[3], false, i % 2 === 1),
    ] })),
  ];
  return new Table({ width: { size: TABLE_WIDTH, type: WidthType.DXA }, columnWidths: widths, alignment: AlignmentType.CENTER, rows });
}
// Yes/No rows (building features and house rules): value "ano" / "nie" / "" (not answered yet).
function yesNoTable(items: BuildItem[]) {
  const widths = [4200, 2200, 3912];
  const mark = (v?: string) => (v === "ano" ? "\u2611 \u00c1no   \u2610 Nie" : v === "nie" ? "\u2610 \u00c1no   \u2611 Nie" : "\u2610 \u00c1no   \u2610 Nie");
  const rows = [
    new TableRow({ children: [headerCell("Polo\u017eka", widths[0]), headerCell("\u00c1no / Nie", widths[1]), headerCell("Pozn\u00e1mka", widths[2])] }),
    ...items.map((it, i) => new TableRow({ children: [
      bodyCell(it.name, widths[0], true, i % 2 === 1), bodyCell(mark(it.value), widths[1], false, i % 2 === 1), bodyCell(it.note || "", widths[2], false, i % 2 === 1),
    ] })),
  ];
  return new Table({ width: { size: TABLE_WIDTH, type: WidthType.DXA }, columnWidths: widths, alignment: AlignmentType.CENTER, rows });
}
function chkTable(items: ChkItem[]) {
  const widths = [5000, 1800, 3512];
  const rows = [
    new TableRow({ children: [headerCell("Položka", widths[0]), headerCell("Stav", widths[1]), headerCell("Poznámka", widths[2])] }),
    ...items.map((it, i) => new TableRow({ children: [
      bodyCell(it.text, widths[0], true, i % 2 === 1),
      bodyCell(it.ok ? "☑ OK   ☐ Doplniť" : "☐ OK   ☑ Doplniť", widths[1], false, i % 2 === 1),
      bodyCell(it.note || "", widths[2], false, i % 2 === 1),
    ] })),
  ];
  return new Table({ width: { size: TABLE_WIDTH, type: WidthType.DXA }, columnWidths: widths, alignment: AlignmentType.CENTER, rows });
}
function todoTable(items: TodoItem[]) {
  const widths = [3600, 3000, 3712];
  const rows = [
    new TableRow({ children: [headerCell("Úloha / nedostatok", widths[0]), headerCell("Zodpovedná osoba a termín", widths[1]), headerCell("Poznámka", widths[2])] }),
    ...items.map((it, i) => new TableRow({ children: [
      bodyCell(it.task || "", widths[0], true, i % 2 === 1), bodyCell(it.owner || "", widths[1], false, i % 2 === 1), bodyCell(it.note || "", widths[2], false, i % 2 === 1),
    ] })),
  ];
  return new Table({ width: { size: TABLE_WIDTH, type: WidthType.DXA }, columnWidths: widths, alignment: AlignmentType.CENTER, rows });
}
function notesBox(text: string) {
  return new Table({
    width: { size: TABLE_WIDTH, type: WidthType.DXA }, columnWidths: [TABLE_WIDTH], alignment: AlignmentType.CENTER,
    rows: [new TableRow({ children: [new TableCell({
      width: { size: TABLE_WIDTH, type: WidthType.DXA }, borders: THIN_BORDERS,
      shading: { type: ShadingType.CLEAR, fill: LABEL_BG },
      children: [new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: "Doplňujúce informácie", bold: true, size: 20, color: INK, font: FONT_BODY })] })],
    })] }),
    new TableRow({ children: [new TableCell({
      width: { size: TABLE_WIDTH, type: WidthType.DXA }, borders: THIN_BORDERS,
      children: [new Paragraph({ children: [new TextRun({ text: text || "-", size: 20, color: INK, font: FONT_BODY })] })],
    })] })],
  });
}
function signatureBlock() {
  const half = Math.floor(TABLE_WIDTH / 2);
  const headCell = (title: string) => new TableCell({
    width: { size: half, type: WidthType.DXA }, borders: THIN_BORDERS,
    shading: { type: ShadingType.CLEAR, fill: LABEL_BG },
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: title, bold: true, size: 20, color: ACCENT, font: FONT_BODY })] })],
  });
  const bodyCellSig = () => new TableCell({
    width: { size: half, type: WidthType.DXA }, borders: THIN_BORDERS,
    children: [
      new Paragraph({ spacing: { before: 120, after: 160 }, children: [new TextRun({ text: "Meno: ____________________", size: 18, color: INK, font: FONT_BODY })] }),
      new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: "Podpis: ____________________", size: 18, color: INK, font: FONT_BODY })] }),
      new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: "Dátum: ____________________", size: 18, color: INK, font: FONT_BODY })] }),
    ],
  });
  return [
    new Table({ width: { size: TABLE_WIDTH, type: WidthType.DXA }, columnWidths: [half, half], alignment: AlignmentType.CENTER, rows: [new TableRow({ children: [headCell("Za RS Properties"), headCell("Majiteľ nehnuteľnosti")] })] }),
    new Table({ width: { size: TABLE_WIDTH, type: WidthType.DXA }, columnWidths: [half, half], alignment: AlignmentType.CENTER, rows: [new TableRow({ children: [bodyCellSig(), bodyCellSig()] })] }),
  ];
}
function formatDateSk(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso || "";
  return `${parseInt(m[3], 10)}.${parseInt(m[2], 10)}.${m[1]}`;
}
function footerText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  const mmYYYY = m ? `${m[2]}/${m[1]}` : new Date().toISOString().slice(0, 7).split("-").reverse().join("/");
  return `RS Properties | preberací protokol | ${mmYYYY}`;
}

function buildDoc(p: Payload) {
  const children: any[] = [
    logoImage(),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [new TextRun({ text: "PREBERACÍ PROTOKOL", bold: true, size: 34, color: INK, font: FONT_HEAD })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [new TextRun({ text: "medzi majiteľom nehnuteľnosti a RS Properties", size: 21, color: ACCENT, font: FONT_BODY })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: "Formulár na prevzatie apartmánu do správy a prípravy na krátkodobý prenájom.", italics: true, size: 19, color: MUTED, font: FONT_BODY })] }),

    heading("Základné údaje"),
    infoTable([
      ["Názov bytu / projektu", p.name || ""],
      ["Adresa", p.address || ""],
      ["Dátum prevzatia", formatDateSk(p.date || "")],
      ["Kontakt na majiteľa", p.contactMajitel || ""],
      ["Zástupca RS Properties", p.rsRep || ""],
    ]),
    new Paragraph({ text: "" }),

    heading("Prístupy a kontakty"),
    infoTable([
      ["Kľúče / čipy / ovládače", p.keysNote || ""],
      ["Wi-Fi názov a heslo", [p.wifiNetwork, p.wifiPassword ? `heslo: ${p.wifiPassword}` : ""].filter(Boolean).join(", ")],
      ["Parkovanie / vstup do garáže", p.parking || ""],
      ["Kontakt pri poruche / havárii", p.emergencyContact || ""],
    ]),
    new Paragraph({ text: "" }),

    heading("Stavy meračov, poistenie, registrácia"),
    infoTable([
      ["Elektromer — stav pri prevzatí", p.meterElectricity || ""],
      ["Plynomer — stav pri prevzatí", p.meterGas || ""],
      ["Vodomer — stav pri prevzatí", p.meterWater || ""],
      ["Poistenie nehnuteľnosti", p.insurance || ""],
      ["Registrácia ubytovania", p.registrationNote || ""],
    ]),
    new Paragraph({ text: "" }),

    heading("Rýchla kontrola pri prevzatí"),
    chkTable(p.quickCheck || []),
    new Paragraph({ text: "" }),

    heading("STR minimum pred spustením"),
    chkTable(p.strMin || []),
    new Paragraph({ text: "" }),

    heading("Vybavenie apartmánu - kuchyňa"),
    equipTable(p.kitchen || []),
    new Paragraph({ text: "" }),

    heading("Vybavenie apartmánu - obytná časť a spálňa"),
    equipTable(p.living || []),
    new Paragraph({ text: "" }),

    heading("Vybavenie apartmánu - kúpeľňa a údržba"),
    equipTable(p.bathroom || []),
    new Paragraph({ text: "" }),

    ...(p.building && p.building.length
      ? [heading("Budova, parkovanie a pravidlá"), yesNoTable(p.building), new Paragraph({ text: "" })]
      : []),

    heading("Čo treba doplniť pred štartom"),
  ];
  if (p.todos && p.todos.length) {
    children.push(todoTable(p.todos));
  } else {
    children.push(new Paragraph({ children: [new TextRun({ text: "Žiadne otvorené položky.", italics: true, size: 18, color: MUTED, font: FONT_BODY })] }));
  }
  children.push(
    new Paragraph({ text: "" }),
    heading("Poznámka"),
    notesBox(p.notes || ""),
    new Paragraph({ text: "" }),
    heading("Potvrdenie a podpisy"),
    ...signatureBlock(),
  );

  return new Document({
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
      footers: {
        default: new Footer({
          children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: footerText(p.date || ""), size: 16, color: MUTED, font: FONT_BODY })] })],
        }),
      },
      children,
    }],
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(await callerAllowed(req))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { headers: JSON_HEADERS, status: 403 });
  }
  try {
    const payload: Payload = await req.json();
    if (!payload || typeof payload !== "object") {
      return new Response(JSON.stringify({ ok: false, error: "invalid payload" }), { headers: JSON_HEADERS, status: 400 });
    }
    const doc = buildDoc(payload);
    const buf = await Packer.toBuffer(doc);
    let bin = "";
    const bytes = new Uint8Array(buf);
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const b64 = btoa(bin);
    return new Response(JSON.stringify({ ok: true, b64 }), { headers: JSON_HEADERS });
  } catch (err) {
    console.error("generate-handover-protocol error:", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { headers: JSON_HEADERS, status: 500 });
  }
});
