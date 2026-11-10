// wg-xlsx.mjs: draws the wbs-gen model as one XLSX sheet. Bars are plain cell fills (no conditional formatting), so
// the file looks the same in any viewer; the parts follow the layout Excel itself writes (shared strings, frozen
// panes, print titles, A3 landscape fit to one page wide).
import { zip } from "./wg-zip.mjs";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NSR = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
// Hangul is set in Noto Sans KR and everything else in Noto Sans. A cell that mixes the two holds rich-text runs,
// one font per run; spaces and punctuation stay in the run they follow. Noto Sans has no geometric shapes, so ◆
// goes with Noto Sans KR, which has them; so do Hanja, CJK punctuation and full-width forms (Noto Sans has none).
export const KR = "Noto Sans KR";
export const LATIN = "Noto Sans";
const HANGUL = /[\u1100-\u11FF\u2190-\u21FF\u2460-\u24FF\u25A0-\u27BF\u2E80-\u9FFF\uA960-\uA97F\uAC00-\uD7A3\uD7B0-\uD7FF\uF900-\uFAFF\uFF00-\uFFEF※]/;
const NEUTRAL = /[\s.,·:;()[\]{}\-/|'"!?~]/;
const GRID = "D5D8DC";
const GATE = "C0392B";
const FONTS = {
  base: { sz: 11, name: LATIN },
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
const clean = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
export const esc = (s) => clean(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function colName(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Splits text into runs of one font: [{ text, kr }]. Text with no letters is one Noto Sans run. */
export function scriptRuns(text) {
  const runs = [];
  let lead = "";
  for (const ch of String(text)) {
    const last = runs[runs.length - 1];
    if (NEUTRAL.test(ch)) {
      if (last) last.text += ch;
      else lead += ch;
      continue;
    }
    const kr = HANGUL.test(ch);
    if (last && last.kr === kr) last.text += ch;
    else runs.push({ text: (last ? "" : lead) + ch, kr });
  }
  return runs.length ? runs : [{ text: lead, kr: false }];
}

/** Sheet names may not hold []:*?/\, start or end with ', be History, or pass 31 characters. */
export function sheetName(s) {
  const trim = (x) => x.trim().replace(/^'+|'+$/g, "").trim();
  let t = trim(clean(s).replace(/[[\]:*?/\\]/g, " "));
  // 31 UTF-16 units, without cutting a surrogate pair; trim again in case the cut leaves a ' at the end.
  while (t.length > 31) t = Array.from(t).slice(0, -1).join("");
  t = trim(t);
  return !t || /^history$/i.test(t) ? "WBS" : t;
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
  /** spec: { font, fill, border: { l, r, t, b }, h, wrap }; kr picks Noto Sans KR for the cell font. */
  id(spec, kr) {
    const key = JSON.stringify([spec, kr]);
    if (this.seen.has(key)) return this.seen.get(key);
    const xf = {
      font: this.pick(this.fonts, fontOf(spec, kr)),
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

export const fontOf = (spec, kr) => ({ ...(FONTS[spec.font] ?? FONTS.base), name: kr ? KR : LATIN });

const BORDER = { thin: ["thin", GRID], gate: ["medium", GATE], dotted: ["dotted", "7F8C8D"] };

// The inside of <font> (cell fonts, name) and of <rPr> (rich-text runs, rFont): same children, other name tag.
function fontBody(f, nameTag) {
  const b = f.b ? "<b/>" : "";
  const color = `<color rgb="FF${f.color ?? "000000"}"/>`;
  const charset = f.name === KR ? `<charset val="129"/>` : "";
  return `${b}<sz val="${f.sz}"/>${color}<${nameTag} val="${f.name}"/><family val="2"/>${charset}`;
}

const fontXml = (f) => `<font>${fontBody(f, "name")}</font>`;

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
    this.refs = 0;
    this.stringIndex = new Map();
    this.styles = new Styles();
  }
  put(r, c, value, spec) {
    if (!this.rows.has(r)) this.rows.set(r, new Map());
    const runs = typeof value === "string" && value ? scriptRuns(clean(value)) : [{ text: "", kr: false }];
    const kr = runs.some((x) => x.kr);
    const mixed = runs.length > 1 ? runs.map((x) => ({ ...x, font: fontOf(spec, x.kr) })) : null;
    this.rows.get(r).set(c, { value, s: this.styles.id(spec, kr), runs: mixed });
  }
  merge(r1, c1, r2, c2) {
    this.merges.push(`${colName(c1)}${r1}:${colName(c2)}${r2}`);
  }
  /** A shared string; mixed runs carry their fonts, so the same text in another cell font is another entry. */
  sst(text, runs) {
    const t = clean(text);
    const key = runs ? `r:${JSON.stringify(runs)}` : `p:${t}`;
    this.refs++;
    if (!this.stringIndex.has(key)) this.stringIndex.set(key, this.strings.push({ text: t, runs }) - 1);
    return this.stringIndex.get(key);
  }
  cellXml(r, c, cell) {
    const ref = `${colName(c)}${r}`;
    if (typeof cell.value === "number") return `<c r="${ref}" s="${cell.s}"><v>${cell.value}</v></c>`;
    if (cell.value === "" || cell.value === null || cell.value === undefined) return `<c r="${ref}" s="${cell.s}"/>`;
    return `<c r="${ref}" s="${cell.s}" t="s"><v>${this.sst(cell.value, cell.runs)}</v></c>`;
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

function sstXml(strings, refs) {
  const run = (x) => `<r><rPr>${fontBody(x.font, "rFont")}</rPr><t xml:space="preserve">${esc(x.text)}</t></r>`;
  const si = strings.map((s) => (s.runs ? `<si>${s.runs.map(run).join("")}</si>` : `<si><t xml:space="preserve">${esc(s.text)}</t></si>`)).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${NS}" count="${refs}" uniqueCount="${strings.length}">${si}</sst>`;
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
    { name: "xl/sharedStrings.xml", data: sstXml(sh.strings, sh.refs) },
  ]);
}
