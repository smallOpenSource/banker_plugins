// wg-html.mjs: draws the wbs-gen model as one self-contained HTML file (a table and CSS, no script, no library, no
// network). The grid matches the XLSX: 8 fixed columns, week (or day) and day (or hour) headers, cell-fill bars, ◆,
// the red gate line. Colours reach the page only as 6-digit hex checked by wg-plan.mjs. Fonts: Noto Sans first and
// Noto Sans KR next; Noto Sans has no Hangul, so Hangul is drawn in Noto Sans KR and everything else in Noto Sans.
// Nothing is embedded: a viewer without the fonts uses its own sans-serif.
// toFragment and SCOPED_CSS let another page (progress-mon's WBS tab) embed the grid: every rule is under the wrapper
// class .wbsg, so the grid sets no body, table, th or td rule of that page, and it sets again what such page rules
// would otherwise change inside the grid (shadow, line height, the last cell's border). toHtml wraps them in a page.

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const br = (s) => esc(s).replace(/\n/g, "<br>");
const WIDTHS = [48, 260, 84, 70, 210, 56, 56, 60];
const DAY = 36;
const ALIGN = ["c", "l", "c", "c", "l", "c", "c", "c"];

/** The grid's CSS, every selector under .wbsg (the wrapper toFragment draws). */
export const SCOPED_CSS = `
.wbsg{font-family:"Noto Sans","Noto Sans KR",sans-serif;color:#2C3E50;font-size:12px;line-height:normal}
.wbsg *{box-sizing:border-box}
.wbsg .wrap{overflow:auto;max-height:calc(100vh - 32px);border:1px solid #D5D8DC}
.wbsg table{border-collapse:separate;border-spacing:0;table-layout:fixed;background:#fff;box-shadow:none}
.wbsg th,.wbsg td{border-right:1px solid #D5D8DC;border-bottom:1px solid #D5D8DC;padding:2px 4px;overflow:hidden;vertical-align:middle;height:22px}
.wbsg th:last-child,.wbsg td:last-child{border-right:1px solid #D5D8DC}
.wbsg .l{text-align:left;white-space:normal;word-break:keep-all}.wbsg .c,.wbsg th{text-align:center}
.wbsg .title th{background:#1F3864;color:#fff;font-size:15px;text-align:left;height:34px;padding:0 10px}
.wbsg .h th{background:#34495E;color:#fff;font-size:12px}
.wbsg .h th.w{background:#5D6D7E}
.wbsg .d th{background:#EBEDEF;color:#2C3E50;font-size:10px;line-height:1.2;height:36px;padding:0;letter-spacing:-.3px}
.wbsg thead tr th{position:sticky;z-index:2}
.wbsg .title th{top:0}.wbsg .h th{top:34px}.wbsg .d th{top:56px}
.wbsg .fix{position:sticky;z-index:1;background:#fff}
.wbsg thead .fix{z-index:3}
.wbsg tr.group td{font-weight:700;color:#1B2631}
.wbsg .dia{color:#C0392B;font-weight:700;text-align:center;padding:0}
.wbsg .cdot{outline:1px dotted #7F8C8D;outline-offset:-2px}
.wbsg .gate{box-shadow:inset 2px 0 0 #C0392B}
.wbsg .notes{margin-top:18px;font-size:12px}
.wbsg .notes h3{font-size:13px;margin:14px 0 6px;color:#1B2631}
.wbsg .notes ul{margin:0;padding:0;list-style:none}
.wbsg .notes li{margin:3px 0;display:flex;align-items:center;gap:8px}
.wbsg .sw{display:inline-block;width:28px;height:14px;border:1px solid #D5D8DC}
.wbsg .sw.dotted{border:1px dotted #7F8C8D}
.wbsg .sw.gateline{border:0;border-left:2px solid #C0392B;border-right:2px solid #C0392B;width:10px}
.wbsg .sw.diamond{border:0;color:#C0392B;font-weight:700;text-align:center;line-height:14px}
@media print{.wbsg .wrap{overflow:visible;max-height:none;border:0}.wbsg thead tr th,.wbsg .fix{position:static}
.wbsg *{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;

// The page around the grid in a file of its own.
const PAGE_CSS = `body{margin:16px}
@page{size:A3 landscape;margin:10mm}
@media print{body{margin:0}}`;

function colgroup(n) {
  return `<colgroup>${WIDTHS.map((w) => `<col style="width:${w}px">`).join("")}${`<col style="width:${DAY}px">`.repeat(n)}</colgroup>`;
}

// Left offsets of the 8 sticky columns.
const LEFT = WIDTHS.map((_, i) => WIDTHS.slice(0, i).reduce((a, b) => a + b, 0));
const fixStyle = (c, bg) => ` class="fix" style="left:${LEFT[c]}px${bg ? `;background:#${bg}` : ""}"`;

function head(m, gate) {
  const total = 8 + m.days.length;
  const title = `<tr class="title"><th colspan="${total}">${esc(m.title)}</th></tr>`;
  const fixed = m.head.map((h, c) => `<th rowspan="2" class="fix" style="left:${LEFT[c]}px;background:#34495E">${br(h)}</th>`).join("");
  const wk = m.weeks.map((w) => `<th class="w${gate.has(w.first) ? " gate" : ""}" colspan="${w.count}">${esc(w.label)}</th>`).join("");
  // The hour unit has no weekday under each hour.
  const days = m.days.map((d, i) => `<th${gate.has(i) ? ' class="gate"' : ""}>${esc(d.label)}${d.dow ? `<br>${esc(d.dow)}` : ""}</th>`).join("");
  return `<thead>${title}<tr class="h">${fixed}${wk}</tr><tr class="d">${days}</tr></thead>`;
}

function dayTd(row, i, gate) {
  const cls = [gate.has(i) ? "gate" : ""];
  if (row.diamonds.includes(i)) {
    cls.push("dia", row.dotted ? "cdot" : "");
    const bg = row.fill ? ` style="background:#${row.fill}"` : "";
    return `<td class="${cls.filter(Boolean).join(" ")}"${bg}>◆</td>`;
  }
  const fill = i >= row.from && i <= row.to ? row.bar : row.fill;
  const c = cls.filter(Boolean).join(" ");
  return `<td${c ? ` class="${c}"` : ""}${fill ? ` style="background:#${fill}"` : ""}></td>`;
}

function body(m, gate) {
  const rows = m.rows.map((row) => {
    const fixed = row.cells.map((v, c) => `<td${fixStyle(c, row.fill)}><div class="${ALIGN[c]}">${br(v)}</div></td>`)
      .join("");
    const days = m.days.map((_, i) => dayTd(row, i, gate)).join("");
    return `<tr class="${row.kind}">${fixed}${days}</tr>`;
  });
  return `<tbody>${rows.join("")}</tbody>`;
}

function swatch(item) {
  if (item.type === "diamond") return `<span class="sw diamond">◆</span>`;
  if (item.type === "gate") return `<span class="sw gateline"></span>`;
  const cls = item.type === "dotted" ? "sw dotted" : "sw";
  return `<span class="${cls}" style="background:#${item.color}"></span>`;
}

function notes(m) {
  const legend = m.legend.length
    ? `<h3>[범례]</h3><ul>${m.legend.map((l) => `<li>${swatch(l)}<span>${esc(l.label)}</span></li>`).join("")}</ul>`
    : "";
  const blocks = m.notes.map((n) => `${n.heading ? `<h3>${esc(n.heading)}</h3>` : ""}<ul>${n.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`);
  return `<section class="notes">${legend}${blocks.join("")}</section>`;
}

/** The grid, legend and notes in one <div class="wbsg">, for a page that also holds SCOPED_CSS. */
export function toFragment(m) {
  const gate = new Set(m.gates.map((g) => g.col));
  // A fixed width keeps every column at its colgroup width, so the sticky offsets match in a narrow window too.
  const width = WIDTHS.reduce((x, y) => x + y, 0) + DAY * m.days.length;
  const table = `<table style="width:${width}px">${colgroup(m.days.length)}${head(m, gate)}${body(m, gate)}</table>`;
  return `<div class="wbsg"><div class="wrap">${table}</div>${notes(m)}</div>`;
}

/** Returns the HTML text for a layout model. */
export function toHtml(m) {
  return `<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(m.title.split("    |    ")[0])}</title><style>${PAGE_CSS}${SCOPED_CSS}</style></head>`
    + `<body>${toFragment(m)}</body></html>\n`;
}
