// wp-pptx.mjs: draws the wide-pptx model as a 16:9 PPTX (13.333 x 7.5 in) with the bundled PptxGenJS. Text sets no
// font of its own; the theme carries the fonts: Latin Noto Sans, Hangul (and other East Asian text) Noto Sans KR.
// PptxGenJS writes the theme's Hangul font as 맑은 고딕 and chart text as Arial, so those parts are patched after
// writing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { PALETTE } from "./wp-model.mjs";

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "pptxgen.bundle.js");
export const LATIN = "Noto Sans";
export const KR = "Noto Sans KR";
const W = 13.333;
const M = 0.6;
const BODY = { x: 0.8, y: 1.55, w: W - 1.6, h: 5.15 };

let loaded = null;

/**
 * Loads the browser bundle (UMD) in a context of its own: required as CommonJS it would export JSZip alone and fail
 * on the JSZip global it expects. The context keeps its own built-ins (the bundle's core-js polyfills patch those,
 * not this process's Uint8Array or Promise); it gets timers, text codecs and Buffer (for nodebuffer output), and no
 * require. This is a loading context, not a security boundary: the bundle is trusted code pinned by its sha256.
 * The bundle keeps counters across builds (chart and embedding numbers keep rising in one process); each file is
 * still self-consistent.
 */
export function pptxgen() {
  if (loaded) return loaded;
  const sandbox = {
    console, setTimeout, clearTimeout, setImmediate, clearImmediate, queueMicrotask, Buffer,
    TextEncoder, TextDecoder, process: { versions: {}, release: {} },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(BUNDLE, "utf8"), sandbox, { filename: "pptxgen.bundle.js" });
  if (typeof sandbox.PptxGenJS !== "function" || typeof sandbox.JSZip !== "function") throw new Error("pptxgen.bundle.js 를 불러오지 못함");
  loaded = { PptxGenJS: sandbox.PptxGenJS, JSZip: sandbox.JSZip };
  return loaded;
}

// Every text run says Korean, so spelling and the language bar match the text (fonts still follow the theme).
const LANG = "ko-KR";

function chrome(s, slide, model, n) {
  const t = model.theme;
  s.addText(slide.title, { x: M, y: 0.35, w: W - 2 * M, h: 0.85, fontSize: 28, bold: true, color: t.dark, valign: "middle", margin: 0, lang: LANG });
  s.addShape("rect", { x: M, y: 1.22, w: 1.1, h: 0.06, fill: { color: t.accent }, line: { color: t.accent, width: 0 } });
  footer(s, model, n);
}

function footer(s, model, n, color) {
  const c = color ?? model.theme.muted;
  if (model.footer) s.addText(model.footer, { x: M, y: 7.0, w: 9, h: 0.3, fontSize: 10, color: c, margin: 0, lang: LANG });
  s.addText(String(n), { x: W - M - 1, y: 7.0, w: 1, h: 0.3, fontSize: 10, color: c, align: "right", margin: 0, lang: LANG });
}

/** Bullet paragraphs; a line break inside one bullet stays inside it (a soft break), as in the HTML deck. */
function runs(bullets, color) {
  return bullets.flatMap((b) => {
    const size = { fontSize: b.level === 2 ? 17 : 20, color, lang: LANG };
    const para = { ...size, bullet: b.level === 2 ? { code: "25AA", indent: 18 } : true, indentLevel: b.level - 1, paraSpaceAfter: 8 };
    const lines = b.text.split("\n");
    return lines.map((line, j) => ({
      text: line,
      options: { ...(j ? { ...size, softBreakBefore: true } : para), breakLine: j === lines.length - 1 },
    }));
  });
}

const DRAW = {
  title(s, slide, model) {
    const t = model.theme;
    s.background = { color: t.primary };
    s.addShape("rect", { x: 0.8, y: 2.25, w: 1.2, h: 0.08, fill: { color: t.accent }, line: { color: t.accent, width: 0 } });
    s.addText(slide.title, { x: 0.8, y: 2.45, w: W - 1.6, h: 1.4, fontSize: 40, bold: true, color: "FFFFFF", valign: "top", margin: 0, lang: LANG });
    if (slide.subtitle) s.addText(slide.subtitle, { x: 0.8, y: 3.95, w: W - 1.6, h: 0.8, fontSize: 22, color: "D6EAF8", margin: 0, lang: LANG });
    const by = [slide.presenter, slide.date].filter(Boolean).join("  |  ");
    if (by) s.addText(by, { x: 0.8, y: 5.7, w: W - 1.6, h: 0.5, fontSize: 16, color: "FFFFFF", margin: 0, lang: LANG });
  },
  section(s, slide, model, n) {
    const t = model.theme;
    s.background = { color: t.light };
    s.addShape("rect", { x: 0, y: 0, w: 0.35, h: 7.5, fill: { color: t.accent }, line: { color: t.accent, width: 0 } });
    s.addText(slide.title, { x: 1.0, y: 2.7, w: W - 2, h: 1.2, fontSize: 36, bold: true, color: t.dark, margin: 0, lang: LANG });
    if (slide.subtitle) s.addText(slide.subtitle, { x: 1.0, y: 3.9, w: W - 2, h: 0.7, fontSize: 20, color: t.muted, margin: 0, lang: LANG });
    footer(s, model, n);
  },
  bullets(s, slide, model, n) {
    chrome(s, slide, model, n);
    if (slide.bullets.length) s.addText(runs(slide.bullets, model.theme.dark), { ...BODY, valign: "top", margin: 4 });
  },
  two(s, slide, model, n) {
    chrome(s, slide, model, n);
    const half = (BODY.w - 0.4) / 2;
    [slide.left, slide.right].forEach((col, i) => {
      const x = BODY.x + i * (half + 0.4);
      if (col.heading) s.addText(col.heading, { x, y: BODY.y, w: half, h: 0.5, fontSize: 20, bold: true, color: model.theme.accent, margin: 0, lang: LANG });
      const top = col.heading ? 0.6 : 0;
      if (col.bullets.length) s.addText(runs(col.bullets, model.theme.dark), { x, y: BODY.y + top, w: half, h: BODY.h - top, valign: "top", margin: 4 });
    });
  },
  table(s, slide, model, n) {
    chrome(s, slide, model, n);
    const t = model.theme;
    const head = slide.table.header.map((h) => ({ text: h, options: { bold: true, color: "FFFFFF", fill: { color: t.primary }, lang: LANG } }));
    const rows = slide.table.rows.map((r, i) => r.map((c) => ({ text: c, options: { color: t.dark, fill: { color: i % 2 ? "FFFFFF" : t.light }, lang: LANG } })));
    const all = head.length ? [head, ...rows] : rows;
    s.addTable(all, { x: BODY.x, y: BODY.y, w: BODY.w, fontSize: 14, border: { type: "solid", pt: 0.75, color: "D5D8DC" }, valign: "middle", autoPage: false });
    caption(s, slide, model);
  },
  chart(s, slide, model, n, p) {
    chrome(s, slide, model, n);
    const c = slide.chart;
    const data = c.series.map((x) => ({ name: x.name, labels: c.labels, values: x.values }));
    // A colour for every point or series: past the list PptxGenJS picks one at random.
    const colors = Array.from({ length: Math.max(c.labels.length, c.series.length, 1) }, (_, i) => PALETTE[i % PALETTE.length]);
    const opts = {
      x: BODY.x, y: BODY.y, w: BODY.w, h: BODY.h - 0.5, chartColors: colors, showLegend: c.series.length > 1 || c.kind === "pie",
      legendPos: "b", legendFontSize: 12, catAxisLabelFontSize: 12, valAxisLabelFontSize: 12, barDir: "col", barGapWidthPct: 60,
      valAxisTitle: c.unit || undefined, showValAxisTitle: !!c.unit, lineSize: 2, lineDataSymbolSize: 7,
      showPercent: c.kind === "pie", showValue: false, dataLabelColor: "FFFFFF", dataLabelFontSize: 12,
    };
    s.addChart(p.ChartType[c.kind], data, opts);
    caption(s, slide, model);
  },
  image(s, slide, model, n) {
    chrome(s, slide, model, n);
    const img = slide.image;
    const box = { ...BODY, h: BODY.h - 0.5 };
    const r = img.size && img.size.w && img.size.h ? img.size.w / img.size.h : box.w / box.h;
    const w = Math.min(box.w, box.h * r);
    const h = w / r;
    const altText = slide.caption || slide.title;
    s.addImage({ data: `${img.mime};base64,${img.data.toString("base64")}`, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h, altText });
    caption(s, slide, model);
  },
  quote(s, slide, model, n) {
    const t = model.theme;
    s.background = { color: t.light };
    s.addText(`“${slide.quote}”`, { x: 1.2, y: 2.0, w: W - 2.4, h: 2.8, fontSize: 30, italic: true, color: t.dark, align: "center", valign: "middle", margin: 0, lang: LANG });
    if (slide.by) s.addText(`- ${slide.by}`, { x: 1.2, y: 4.9, w: W - 2.4, h: 0.6, fontSize: 18, color: t.muted, align: "right", margin: 0, lang: LANG });
    if (slide.title) s.addText(slide.title, { x: M, y: 0.35, w: W - 2 * M, h: 0.7, fontSize: 18, bold: true, color: t.accent, margin: 0, lang: LANG });
    footer(s, model, n);
  },
  closing(s, slide, model) {
    const t = model.theme;
    s.background = { color: t.primary };
    s.addText(slide.title, { x: 0.8, y: 2.7, w: W - 1.6, h: 1.3, fontSize: 40, bold: true, color: "FFFFFF", align: "center", valign: "middle", margin: 0, lang: LANG });
    if (slide.subtitle) s.addText(slide.subtitle, { x: 0.8, y: 4.1, w: W - 1.6, h: 0.7, fontSize: 20, color: "D6EAF8", align: "center", margin: 0, lang: LANG });
  },
};

function caption(s, slide, model) {
  if (slide.caption) s.addText(slide.caption, { x: BODY.x, y: BODY.y + BODY.h - 0.4, w: BODY.w, h: 0.4, fontSize: 12, color: model.theme.muted, margin: 0, lang: LANG });
}

/** The theme fonts: Latin Noto Sans, East Asian and Hangul Noto Sans KR (major and minor font sets). */
export function patchTheme(xml) {
  return xml
    .replace(/<a:latin typeface="[^"]*"/g, `<a:latin typeface="${LATIN}"`)
    .replace(/<a:ea typeface="[^"]*"/g, `<a:ea typeface="${KR}"`)
    .replace(/<a:font script="Hang" typeface="[^"]*"/g, `<a:font script="Hang" typeface="${KR}"`);
}

/** Chart text: PptxGenJS writes <a:latin typeface="Arial"/> alone; make it Noto Sans and add the Hangul font. */
export function patchChart(xml) {
  return xml.replace(/<a:latin typeface="[^"]*"\/>(?!<a:ea )/g, `<a:latin typeface="${LATIN}"/><a:ea typeface="${KR}"/>`);
}

/** PptxGenJS 4.0.1 writes the chart data table as ref="A1:C6'" (a stray quote); Excel wants a plain range. */
export const patchTable = (xml) => xml.replace(/ ref="([A-Z]+\d+:[A-Z]+\d+)'"/g, ' ref="$1"');

async function patchEmbedded(JSZip, bytes) {
  const inner = await JSZip.loadAsync(bytes);
  for (const f of Object.keys(inner.files).filter((x) => /^xl\/tables\/table\d+\.xml$/.test(x))) {
    inner.file(f, patchTable(await inner.file(f).async("string")));
  }
  return inner.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** PptxGenJS ends every paragraph with <a:endParaRPr lang="en-US">; text typed there later should be Korean too. */
export const patchSlide = (xml) => xml.replace(/<a:endParaRPr lang="en-US"/g, '<a:endParaRPr lang="ko-KR"');

const PATCHES = [
  [/^ppt\/theme\/theme\d+\.xml$/, "string", patchTheme],
  [/^ppt\/slides\/slide\d+\.xml$/, "string", patchSlide],
  [/^ppt\/charts\/chart\d+\.xml$/, "string", patchChart],
  [/^ppt\/embeddings\/[^/]+\.xlsx$/, "uint8array", null],
];

/** Returns the PPTX bytes for a model. */
export async function toPptx(model) {
  const { PptxGenJS, JSZip } = pptxgen();
  const p = new PptxGenJS();
  p.layout = "LAYOUT_WIDE";
  p.title = model.title;
  p.author = model.author || "wide-pptx";
  p.company = "";
  p.subject = model.title;
  p.theme = { headFontFace: LATIN, bodyFontFace: LATIN };
  model.slides.forEach((slide, i) => {
    const s = p.addSlide();
    DRAW[slide.type](s, slide, model, i + 1, p);
    if (slide.notes) s.addNotes(slide.notes);
  });
  const raw = await p.write({ outputType: "nodebuffer", compression: true });
  const zip = await JSZip.loadAsync(raw);
  for (const f of Object.keys(zip.files)) {
    const fix = PATCHES.find(([re]) => re.test(f));
    if (!fix) continue;
    const body = await zip.file(f).async(fix[1]);
    zip.file(f, fix[2] ? fix[2](body) : await patchEmbedded(JSZip, body));
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}
