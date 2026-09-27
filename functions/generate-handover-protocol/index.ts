// RS Properties / Keystone — Supabase Edge Function
// Generates a real .docx "Preberací protokol" (property handover protocol)
// from structured data the team fills in once inside Keystone (Properties
// → 📄 Protokol tab), instead of retyping the same equipment/keys/wifi
// list into a Google Doc by hand every time. The output intentionally
// mirrors the team's real existing template (RS_ Preberací Protokol -
// Radlinského 22.docx) section-for-section, so the workflow after this
// stays exactly the same as before: download the .docx, upload it to
// Google Drive, run Drive's own "Request e-signature" on it (that feature
// only works on an actual Google Doc from inside Docs — no API — so this
// function's whole job is producing a real .docx, never a PDF).
//
// Auth: same "real active team member token, not the bare anon key" rule
// send-push was tightened to on 2026-09-22 — this generates a document
// containing an owner's contact details and full apartment inventory, so
// it's gated the same way.
//
// Deploy: via the Supabase MCP deploy_edge_function (this project has no
// local Supabase CLI set up — see CLAUDE.md).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, HeadingLevel, AlignmentType, BorderStyle,
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
  todos?: TodoItem[]; notes?: string;
}

const TABLE_WIDTH = 9746; // A4, 0.75in margins each side
const NO_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" };
const CELL_BORDERS = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };

function heading(text: string) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 120 }, children: [new TextRun({ text, bold: true, size: 24 })] });
}
function labelValue(label: string, value: string) {
  return new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: label + ": ", bold: true, size: 20 }), new TextRun({ text: value || "-", size: 20 })] });
}
function headerCell(text: string, width: number) {
  return new TableCell({ width: { size: width, type: WidthType.DXA }, borders: CELL_BORDERS, shading: { fill: "F2EFE9" }, children: [new Paragraph({ children: [new TextRun({ text, bold: true, size: 18 })] })] });
}
function bodyCell(text: string, width: number) {
  return new TableCell({ width: { size: width, type: WidthType.DXA }, borders: CELL_BORDERS, children: [new Paragraph({ children: [new TextRun({ text: text || "", size: 18 })] })] });
}
function equipTable(items: EquipItem[]) {
  const widths = [4200, 900, 1400, 3246];
  const rows = [
    new TableRow({ children: [headerCell("Položka", widths[0]), headerCell("Počet", widths[1]), headerCell("Stav", widths[2]), headerCell("Poznámka", widths[3])] }),
    ...items.map((it) => new TableRow({ children: [
      bodyCell(it.name, widths[0]), bodyCell(it.count || "", widths[1]), bodyCell(it.status || "", widths[2]), bodyCell(it.note || "", widths[3]),
    ] })),
  ];
  return new Table({ width: { size: TABLE_WIDTH, type: WidthType.DXA }, columnWidths: widths, rows });
}
function chkTable(items: ChkItem[]) {
  const widths = [4800, 1800, 3146];
  const rows = [
    new TableRow({ children: [headerCell("Položka", widths[0]), headerCell("Stav", widths[1]), headerCell("Poznámka", widths[2])] }),
    ...items.map((it) => new TableRow({ children: [
      bodyCell(it.text, widths[0]), bodyCell(it.ok ? "☒ OK   ☐ Doplniť" : "☐ OK   ☒ Doplniť", widths[1]), bodyCell(it.note || "", widths[2]),
    ] })),
  ];
  return new Table({ width: { size: TABLE_WIDTH, type: WidthType.DXA }, columnWidths: widths, rows });
}
function todoTable(items: TodoItem[]) {
  const widths = [3600, 3000, 3146];
  const rows = [
    new TableRow({ children: [headerCell("Úloha / nedostatok", widths[0]), headerCell("Zodpovedná osoba a termín", widths[1]), headerCell("Poznámka", widths[2])] }),
    ...items.map((it) => new TableRow({ children: [
      bodyCell(it.task || "", widths[0]), bodyCell(it.owner || "", widths[1]), bodyCell(it.note || "", widths[2]),
    ] })),
  ];
  return new Table({ width: { size: TABLE_WIDTH, type: WidthType.DXA }, columnWidths: widths, rows });
}
function signatureBlock() {
  const cell = (title: string) => new TableCell({
    width: { size: TABLE_WIDTH / 2, type: WidthType.DXA }, borders: CELL_BORDERS,
    children: [
      new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: title, bold: true, size: 20 })] }),
      new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: "Meno: ____________________", size: 18 })] }),
      new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: "Podpis: ____________________", size: 18 })] }),
      new Paragraph({ children: [new TextRun({ text: "Dátum: ____________________", size: 18 })] }),
    ],
  });
  return new Table({ width: { size: TABLE_WIDTH, type: WidthType.DXA }, columnWidths: [TABLE_WIDTH / 2, TABLE_WIDTH / 2], rows: [new TableRow({ children: [cell("Za RS Properties"), cell("Majiteľ nehnuteľnosti")] })] });
}

function buildDoc(p: Payload) {
  const children: any[] = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [new TextRun({ text: "PREBERACÍ PROTOKOL", bold: true, size: 32 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [new TextRun({ text: "medzi majiteľom nehnuteľnosti a RS Properties", italics: true, size: 20 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: "Formulár na prevzatie apartmánu do správy a prípravy na krátkodobý prenájom.", size: 18 })] }),

    heading("Základné údaje"),
    labelValue("Názov bytu / projektu", p.name || ""),
    labelValue("Adresa", p.address || ""),
    labelValue("Dátum prevzatia", p.date || ""),
    labelValue("Kontakt na majiteľa", p.contactMajitel || ""),
    labelValue("Zástupca RS Properties", p.rsRep || ""),

    heading("Prístupy a kontakty"),
    labelValue("Kľúče / čipy / ovládače", p.keysNote || ""),
    labelValue("Wi-Fi názov a heslo", [p.wifiNetwork, p.wifiPassword ? `heslo: ${p.wifiPassword}` : ""].filter(Boolean).join(", ")),
    labelValue("Parkovanie / vstup do garáže", p.parking || ""),
    labelValue("Kontakt pri poruche / havárii", p.emergencyContact || ""),

    heading("Stavy meračov, poistenie, registrácia"),
    labelValue("Elektromer — stav pri prevzatí", p.meterElectricity || ""),
    labelValue("Plynomer — stav pri prevzatí", p.meterGas || ""),
    labelValue("Vodomer — stav pri prevzatí", p.meterWater || ""),
    labelValue("Poistenie nehnuteľnosti", p.insurance || ""),
    labelValue("Registrácia ubytovania", p.registrationNote || ""),

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

    heading("Čo treba doplniť pred štartom"),
  ];
  if (p.todos && p.todos.length) {
    children.push(todoTable(p.todos));
  } else {
    children.push(new Paragraph({ children: [new TextRun({ text: "Žiadne otvorené položky.", italics: true, size: 18 })] }));
  }
  children.push(
    new Paragraph({ text: "" }),
    heading("Doplňujúce informácie"),
    new Paragraph({ children: [new TextRun({ text: p.notes || "-", size: 20 })] }),
    new Paragraph({ text: "" }),
    heading("Potvrdenie a podpisy"),
    signatureBlock(),
  );

  return new Document({
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
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
