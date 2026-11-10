// wg-xlsx.mjs: draws the wbs-gen model as one XLSX sheet. Bars are plain cell fills (no conditional formatting), so
// the file looks the same in any viewer; the parts follow the layout Excel itself writes (shared strings, frozen
// panes, print titles, A3 landscape fit to one page wide).
import { zip } from "./wg-zip.mjs";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NSR = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const FONT = "맑은 고딕";
const GRID = "D5D8DC";
const GATE = "C0392B";
const FONTS = {
  base: { sz: 11 },
  title: { b: 1, sz: 13, color: "FFFFFF" },
  head: { b: 1, sz: 10, color: "FFFFFF" },
  day: { b: 1, sz: 8, color: "2C3E50" },
  body: { sz: 8, color: "2C3E50" },
  bodyB: { b: 1, sz: 8, color: "1B2631" },
  mile: { b: 1, sz: 9, color: GATE },
  note: { sz: 9, color: "2C3E50" },
  noteB: { b: 1, sz: 10, color: "1B2631" },
};
const WIDTHS = [6, 36, 10.5, 9, 28, 7.5, 7.5, 8.2];
const DAY_WIDTH = 4.8;
const ALIGN = ["center", "left", "center", "center", "left", "center", "center", "center"];

// Control characters other than tab and new line are not allowed in XML 1.0.
const clean = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");
export const esc = (s) => clean(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function colName(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Sheet names may not hold []:*?/\ and stop at 31 characters. */
export function sheetName(s) {
  const t = clean(s).replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31);
  return t || "WBS";
}

/** Collects the distinct fonts, fills, borders and cell formats a sheet uses. */
class Styles {
  constructor() {
    this.fonts = [FONTS.base];
    this.fills = ["none", "gray125"];
    this.borders = [{}];
    this.xfs = [{ font: 0, fill: 0, border: 0, h: "", wrap: false }];
    this.seen = new Map();
  }
  pick(list, item) {
    const k = JSON.stringify(item);
    let i = list.findIndex((x) => JSON.stringify(x) === k);
    if (i < 0) i = list.push(item) - 1;
    return i;
  }
  /** spec: { font, fill, border: { l, r, t, b }, h, wrap } */
  id(spec) {
    const key = JSON.stringify(spec);
    if (this.seen.has(key)) return this.seen.get(key);
    const xf = {
      font: this.pick(this.fonts, FONTS[spec.font] ?? FONTS.base),
      fill: spec.fill ? this.pick(this.fills, spec.fill) : 0,
      border: this.pick(this.borders, spec.border ?? {}),
      h: spec.h ?? "",
      wrap: !!spec.wrap,
    };
    const i = this.pick(this.xfs, xf);
    this.seen.set(key, i);
    return i;
  }
}

const BORDER = { thin: ["thin", GRID], gate: ["medium", GATE], dotted: ["dotted", "7F8C8D"] };

function fontXml(f) {
  const b = f.b ? "<b/>" : "";
  const color = f.color ? `<color rgb="FF${f.color}"/>` : `<color theme="1"/>`;
  return `<font>${b}<sz val="${f.sz}"/>${color}<name val="${FONT}"/><family val="3"/><charset val="129"/></font>`;
}

function fillXml(f) {
  if (f === "none" || f === "gray125") return `<fill><patternFill patternType="${f}"/></fill>`;
  return `<fill><patternFill patternType="solid"><fgColor rgb="FF${f}"/><bgColor indexed="64"/></patternFill></fill>`;
}

function borderXml(b) {
  const side = (n) => {
    const v = BORDER[b[n[0]]];
    return v ? `<${n} style="${v[0]}"><color rgb="FF${v[1]}"/></${n}>` : `<${n}/>`;
  };
  return `<border>${["left", "right", "top", "bottom"].map(side).join("")}<diagonal/></border>`;
}

function xfXml(x) {
  const flags = `${x.fill ? ' applyFill="1"' : ""}${x.border ? ' applyBorder="1"' : ""}`;
  const align = x.h || x.wrap
    ? `<alignment${x.h ? ` horizontal="${x.h}"` : ""} vertical="center"${x.wrap ? ' wrapText="1"' : ""}/>`
    : "";
  const open = `<xf numFmtId="0" fontId="${x.font}" fillId="${x.fill}" borderId="${x.border}" xfId="0" applyFont="1"${flags}`;
  return align ? `${open} applyAlignment="1">${align}</xf>` : `${open}/>`;
}

function stylesXml(st) {
  const list = (tag, items, fn) => `<${tag} count="${items.length}">${items.map(fn).join("")}</${tag}>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${NS}">`
    + list("fonts", st.fonts, fontXml) + list("fills", st.fills, fillXml) + list("borders", st.borders, borderXml)
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
    + list("cellXfs", st.xfs, xfXml)
    + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>`
    + `<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;
}

/** The sheet being drawn: cells by row, merged ranges, row heights, shared strings. */
class Sheet {
  constructor() {
    this.rows = new Map();
    this.merges = [];
    this.heights = new Map();
    this.strings = [];
    this.stringIndex = new Map();
    this.styles = new Styles();
  }
  put(r, c, value, spec) {
    if (!this.rows.has(r)) this.rows.set(r, new Map());
    this.rows.get(r).set(c, { value, s: this.styles.id(spec) });
  }
  merge(r1, c1, r2, c2) {
    this.merges.push(`${colName(c1)}${r1}:${colName(c2)}${r2}`);
  }
  sst(text) {
    const t = clean(text);
    if (!this.stringIndex.has(t)) this.stringIndex.set(t, this.strings.push(t) - 1);
    return this.stringIndex.get(t);
  }
  cellXml(r, c, cell) {
    const ref = `${colName(c)}${r}`;
    if (typeof cell.value === "number") return `<c r="${ref}" s="${cell.s}"><v>${cell.value}</v></c>`;
    if (cell.value === "" || cell.value === null || cell.value === undefined) return `<c r="${ref}" s="${cell.s}"/>`;
    return `<c r="${ref}" s="${cell.s}" t="s"><v>${this.sst(cell.value)}</v></c>`;
  }
  dataXml() {
    const out = [];
    for (const r of [...this.rows.keys()].sort((a, b) => a - b)) {
      const cells = this.rows.get(r);
      const ht = this.heights.get(r);
      const attr = ht ? ` ht="${ht}" customHeight="1"` : "";
      const xml = [...cells.keys()].sort((a, b) => a - b).map((c) => this.cellXml(r, c, cells.get(c))).join("");
      out.push(`<row r="${r}"${attr}>${xml}</row>`);
    }
    return out.join("");
  }
}

const grid = (gate) => ({ l: gate ? "gate" : "thin", r: "thin", t: "thin", b: "thin" });

function drawHead(sh, m, last) {
  sh.put(1, 0, m.title, { font: "title", fill: "1F3864", h: "left" });
  for (let c = 1; c <= last; c++) sh.put(1, c, "", { font: "title", fill: "1F3864" });
  sh.merge(1, 0, 1, last);
  sh.heights.set(1, 28).set(2, 16).set(3, 30);
  m.head.forEach((h, c) => {
    for (const r of [2, 3]) sh.put(r, c, r === 2 ? h : "", { font: "head", fill: "34495E", border: grid(false), h: "center", wrap: true });
    sh.merge(2, c, 3, c);
  });
  const gateCols = new Set(m.gates.map((g) => g.col));
  for (const w of m.weeks) {
    for (let i = w.first; i < w.first + w.count; i++) {
      sh.put(2, 8 + i, i === w.first ? w.label : "", { font: "head", fill: "5D6D7E", border: grid(gateCols.has(i)), h: "center" });
    }
    if (w.count > 1) sh.merge(2, 8 + w.first, 2, 8 + w.first + w.count - 1);
  }
  m.days.forEach((d, i) => {
    sh.put(3, 8 + i, `${d.label}\n${d.dow}`, { font: "day", fill: "EBEDEF", border: grid(gateCols.has(i)), h: "center", wrap: true });
  });
}

function dayCell(row, i, gate) {
  const border = grid(gate);
  if (row.diamonds.includes(i)) {
    const b = row.dotted ? { ...border, l: gate ? "gate" : "dotted", r: "dotted", b: "dotted" } : border;
    return ["◆", { font: "mile", fill: row.fill, border: b, h: "center" }];
  }
  const fill = i >= row.from && i <= row.to ? row.bar : row.fill;
  return ["", { font: "body", fill, border }];
}

function drawRows(sh, m) {
  const gateCols = new Set(m.gates.map((g) => g.col));
  m.rows.forEach((row, n) => {
    const r = 4 + n;
    const font = row.kind === "group" ? "bodyB" : "body";
    row.cells.forEach((v, c) => {
      sh.put(r, c, v, { font, fill: row.fill, border: grid(false), h: ALIGN[c], wrap: c === 1 || c === 4 });
    });
    m.days.forEach((_, i) => {
      const [v, spec] = dayCell(row, i, gateCols.has(i));
      sh.put(r, 8 + i, v, spec);
    });
  });
  return 4 + m.rows.length;
}

function legendCell(item) {
  if (item.type === "diamond") return ["◆", { font: "mile", h: "center" }];
  if (item.type === "gate") return ["", { font: "note", border: { l: "gate", r: "gate" } }];
  const b = item.type === "dotted" ? { l: "dotted", r: "dotted", t: "dotted", b: "dotted" } : grid(false);
  return ["", { font: "note", fill: item.color, border: b }];
}

function drawNotes(sh, m, start) {
  let r = start + 1;
  if (m.legend.length) {
    sh.put(r++, 0, "[범례]", { font: "noteB" });
    for (const item of m.legend) {
      const [v, spec] = legendCell(item);
      sh.put(r, 0, v, spec);
      sh.put(r++, 1, item.label, { font: "note" });
    }
  }
  for (const n of m.notes) {
    r++;
    if (n.heading) sh.put(r++, 0, n.heading, { font: "noteB" });
    for (const line of n.lines) sh.put(r++, 0, line, { font: "note" });
  }
  return r - 1;
}

function sheetXml(sh, last, lastRow) {
  const cols = WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")
    + `<col min="9" max="${last + 1}" width="${DAY_WIDTH}" customWidth="1"/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}" xmlns:r="${NSR}">`
    + `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${colName(last)}${lastRow}"/>`
    + `<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane xSplit="8" ySplit="3" topLeftCell="I4" activePane="bottomRight" state="frozen"/>`
    + `<selection pane="topRight"/><selection pane="bottomLeft"/><selection pane="bottomRight" activeCell="I4" sqref="I4"/></sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="16.5"/><cols>${cols}</cols><sheetData>${sh.dataXml()}</sheetData>`
    + `<mergeCells count="${sh.merges.length}">${sh.merges.map((x) => `<mergeCell ref="${x}"/>`).join("")}</mergeCells>`
    + `<printOptions horizontalCentered="1"/><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>`
    + `<pageSetup paperSize="8" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}

function sstXml(strings) {
  const si = strings.map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${NS}" count="${strings.length}" uniqueCount="${strings.length}">${si}</sst>`;
}

function packageParts(name) {
  const quoted = `'${name.replace(/'/g, "''")}'`;
  return {
    types: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
      + `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    rels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${NSR}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    workbook: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS}" xmlns:r="${NSR}">`
      + `<bookViews><workbookView/></bookViews><sheets><sheet name="${esc(name)}" sheetId="1" r:id="rId1"/></sheets>`
      + `<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">${esc(quoted)}!$1:$3</definedName></definedNames></workbook>`,
    wbRels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${NSR}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${NSR}/styles" Target="styles.xml"/>`
      + `<Relationship Id="rId3" Type="${NSR}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  };
}

/** Returns the XLSX bytes for a layout model. */
export function toXlsx(m) {
  const sh = new Sheet();
  const last = 7 + m.days.length;
  drawHead(sh, m, last);
  const lastRow = drawNotes(sh, m, drawRows(sh, m));
  const sheet = sheetXml(sh, last, lastRow);
  const name = sheetName(m.sheet);
  const p = packageParts(name);
  return zip([
    { name: "[Content_Types].xml", data: p.types },
    { name: "_rels/.rels", data: p.rels },
    { name: "xl/workbook.xml", data: p.workbook },
    { name: "xl/_rels/workbook.xml.rels", data: p.wbRels },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
    { name: "xl/styles.xml", data: stylesXml(sh.styles) },
    { name: "xl/sharedStrings.xml", data: sstXml(sh.strings) },
  ]);
}
