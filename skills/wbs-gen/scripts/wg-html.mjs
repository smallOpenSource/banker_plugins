// wg-html.mjs: draws the wbs-gen model as one self-contained HTML file (a table and CSS, no script, no library, no
// network). The grid matches the XLSX: 8 fixed columns, week and day headers, cell-fill bars, ◆, the red gate line.
// Colours reach the page only as 6-digit hex checked by wg-plan.mjs.

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const br = (s) => esc(s).replace(/\n/g, "<br>");
const WIDTHS = [48, 260, 84, 70, 210, 56, 56, 60];
const DAY = 36;
const ALIGN = ["c", "l", "c", "c", "l", "c", "c", "c"];

const CSS = `
*{box-sizing:border-box}
body{margin:16px;font-family:"맑은 고딕","Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif;color:#2C3E50;font-size:12px}
.wrap{overflow:auto;max-height:calc(100vh - 32px);border:1px solid #D5D8DC}
table{border-collapse:separate;border-spacing:0;table-layout:fixed}
th,td{border-right:1px solid #D5D8DC;border-bottom:1px solid #D5D8DC;padding:2px 4px;overflow:hidden;vertical-align:middle;height:22px}
.l{text-align:left;white-space:normal;word-break:keep-all}.c,th{text-align:center}
.title th{background:#1F3864;color:#fff;font-size:15px;text-align:left;height:34px;padding:0 10px}
.h th{background:#34495E;color:#fff;font-size:12px}
.h th.w{background:#5D6D7E}
.d th{background:#EBEDEF;color:#2C3E50;font-size:10px;line-height:1.2;height:36px;padding:0;letter-spacing:-.3px}
thead tr th{position:sticky;z-index:2}
.title th{top:0}.h th{top:34px}.d th{top:56px}
.fix{position:sticky;z-index:1;background:#fff}
thead .fix{z-index:3}
tr.group td{font-weight:700;color:#1B2631}
.dia{color:#C0392B;font-weight:700;text-align:center;padding:0}
.dot{outline:1px dotted #7F8C8D;outline-offset:-2px}
.gate{box-shadow:inset 2px 0 0 #C0392B}
.notes{margin-top:18px;font-size:12px}
.notes h3{font-size:13px;margin:14px 0 6px;color:#1B2631}
.notes ul{margin:0;padding:0;list-style:none}
.notes li{margin:3px 0;display:flex;align-items:center;gap:8px}
.sw{display:inline-block;width:28px;height:14px;border:1px solid #D5D8DC}
.sw.dotted{border:1px dotted #7F8C8D}
.sw.gateline{border:0;border-left:2px solid #C0392B;border-right:2px solid #C0392B;width:10px}
.sw.diamond{border:0;color:#C0392B;font-weight:700;text-align:center;line-height:14px}
@page{size:A3 landscape;margin:10mm}
@media print{body{margin:0}.wrap{overflow:visible;max-height:none;border:0}thead tr th,.fix{position:static}
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;

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
  const days = m.days.map((d, i) => `<th${gate.has(i) ? ' class="gate"' : ""}>${esc(d.label)}<br>${esc(d.dow)}</th>`).join("");
  return `<thead>${title}<tr class="h">${fixed}${wk}</tr><tr class="d">${days}</tr></thead>`;
}

function dayTd(row, i, gate) {
  const cls = [gate.has(i) ? "gate" : ""];
  if (row.diamonds.includes(i)) {
    cls.push("dia", row.dotted ? "dot" : "");
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

/** Returns the HTML text for a layout model. */
export function toHtml(m) {
  const gate = new Set(m.gates.map((g) => g.col));
  const table = `<table>${colgroup(m.days.length)}${head(m, gate)}${body(m, gate)}</table>`;
  return `<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(m.title.split("    |    ")[0])}</title><style>${CSS}</style></head>`
    + `<body><div class="wrap">${table}</div>${notes(m)}</body></html>\n`;
}
