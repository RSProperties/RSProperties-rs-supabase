// RS Properties — task e-mail renderer (pure, no I/O, testable with node).
// One template for every task e-mail: assignment, new comment, @mention, other change.
// The caller (admin app) says WHAT happened through `label`, `intro`, `subject`, `detail`,
// `actionLabel`; `appUrl` is a deep link to the task (?task=<id>&c=<commentId>).

export function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// subject goes into a header: no line breaks, bounded length
export function cleanSubject(s, max = 180) {
  return String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

// only our own app links (https) may become the button target
export function safeUrl(u, fallback) {
  try {
    const x = new URL(String(u || ""));
    if (x.protocol !== "https:" && x.protocol !== "http:") return fallback;
    return x.toString();
  } catch (_e) { return fallback; }
}

const PRIO = {
  U: { label: "🔴 Urgent", color: "#b83232" },
  H: { label: "🟠 High", color: "#e67e22" },
  M: { label: "🟡 Medium", color: "#9a6f1a" },
  L: { label: "⚪ Low", color: "#95a5a6" },
};

// Strings that are not supplied by the caller. `lang` is the RECIPIENT's language ("sk" | "en").
const TX = {
  sk: {
    hello: (n) => `Ahoj, ${n}!`, label: "Nová úloha", action: "Otvoriť RS Builder", due: "Termín",
    actor: "tvoj tím", intro: (a) => `${a} ti pridelil/a novú úlohu v RS Builder. Tu sú detaily:`,
    footerNote: "Tento e-mail bol odoslaný automaticky zo systému RS Builder.", locale: "sk-SK",
    subject: (t, c) => `Nová úloha: "${t}" — ${c}`, titleFallback: "Úloha",
  },
  en: {
    hello: (n) => `Hi ${n},`, label: "New task", action: "Open RS Builder", due: "Due",
    actor: "your team", intro: (a) => `${a} assigned you a new task in RS Builder. Here are the details:`,
    footerNote: "This e-mail was sent automatically by the RS Builder system.", locale: "en-GB",
    subject: (t, c) => `New task: "${t}" — ${c}`, titleFallback: "Task",
  },
};

export function renderTaskEmail(p) {
  const lang = p.lang === "en" ? "en" : "sk";
  const T = TX[lang];
  const company = esc(p.company || "RS Properties");
  const name = esc(p.assigneeName || p.to || "");
  const actor = p.assignerName || T.actor;
  const prio = PRIO[p.priority || "M"] || PRIO.M;
  const url = safeUrl(p.appUrl, "https://rsproperties.sk");
  const label = esc(p.label || T.label);
  // default wording = the original "assigned" e-mail, so older callers keep working
  const intro = esc(p.intro || T.intro(actor));
  const action = esc(p.actionLabel || T.action);
  const dueLine = p.dueDate
    ? new Date(p.dueDate + "T00:00:00").toLocaleDateString(T.locale, { day: "2-digit", month: "long", year: "numeric" })
    : null;
  // `detail` = quoted text (the comment itself); `taskDesc` = the task description (assignment mail)
  const detail = p.detail ? String(p.detail) : "";
  const desc = !detail && p.taskDesc ? String(p.taskDesc) : "";
  const footerNote = esc(p.footerNote || T.footerNote);

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(cleanSubject(p.subject) || T.titleFallback + " — " + (p.company || "RS Properties"))}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#e8e4dc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;padding:32px 16px}
.wrap{max-width:520px;margin:0 auto;background:#0f1e2e;border-radius:16px;overflow:hidden}
.top-bar{padding:20px 26px;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,.07)}
.logo-sq{width:32px;height:32px;background:#c9a96e;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#0f1e2e;flex-shrink:0}
.logo-name{font-size:11px;font-weight:700;color:#fff;letter-spacing:.12em;text-transform:uppercase;line-height:1.4}
.body{padding:32px 26px}
.label{font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#c9a96e;margin-bottom:12px}
.heading{font-size:22px;font-weight:800;color:#fff;line-height:1.25;margin-bottom:8px}
.sub{font-size:13px;color:rgba(255,255,255,.5);line-height:1.6;margin-bottom:24px}
.task-card{background:#1a2e44;border-radius:10px;padding:18px 20px;margin-bottom:20px}
.task-title{font-size:15px;font-weight:700;color:#fff;margin-bottom:8px;line-height:1.4}
.task-desc{font-size:13px;color:rgba(255,255,255,.55);line-height:1.6;margin-bottom:12px;white-space:pre-wrap}
.quote{border-left:3px solid #c9a96e;background:rgba(255,255,255,.05);border-radius:0 8px 8px 0;padding:10px 14px;margin:6px 0 12px;font-size:13.5px;color:#fff;line-height:1.6;white-space:pre-wrap}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.pill{display:inline-block;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:600}
.btn{display:block;padding:14px 22px;background:#c9a96e;color:#0f1e2e;text-align:center;text-decoration:none;border-radius:9px;font-size:14px;font-weight:800;margin-bottom:18px}
.footer{border-top:1px solid rgba(255,255,255,.07);padding:14px 26px;font-size:11px;color:rgba(255,255,255,.3);line-height:1.6}
</style>
</head>
<body>
<div class="wrap">
  <div class="top-bar">
    <div class="logo-sq">RS</div>
    <div class="logo-name">RS<br>Builder</div>
  </div>
  <div class="body">
    <div class="label">${label}</div>
    <h1 class="heading">${T.hello(name)}</h1>
    <p class="sub">${intro}</p>

    <div class="task-card">
      <div class="task-title">${esc(p.taskTitle)}</div>
      ${detail ? `<div class="quote">${esc(detail)}</div>` : ""}
      ${desc ? `<div class="task-desc">${esc(desc)}</div>` : ""}
      <div class="meta">
        <span class="pill" style="background:${prio.color}22;color:${prio.color}">${prio.label}</span>
        ${dueLine ? `<span class="pill" style="background:rgba(255,255,255,.08);color:rgba(255,255,255,.7)">📅 ${T.due}: ${esc(dueLine)}</span>` : ""}
        ${p.projectName ? `<span class="pill" style="background:rgba(201,169,110,.15);color:#c9a96e">📁 ${esc(p.projectName)}</span>` : ""}
      </div>
    </div>

    <a href="${esc(url)}" class="btn">${action} →</a>
    <p style="font-size:12px;color:rgba(255,255,255,.3);line-height:1.5">${footerNote}</p>
  </div>
  <div class="footer">
    ${company} · RS Builder — Team Task Management
  </div>
</div>
</body>
</html>`;

  const subject = cleanSubject(p.subject) || T.subject(cleanSubject(p.taskTitle, 120), cleanSubject(p.company || "RS Properties", 60));
  return { html, subject };
}
