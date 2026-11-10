// wp-model.mjs: reads a wide-pptx deck (JSON), checks it and returns one model that the PPTX and HTML writers both
// draw. Images are read here (local regular files only) so both outputs embed the same bytes. No network.
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, win32 } from "node:path";

export const TYPES = ["title", "section", "bullets", "two", "table", "chart", "image", "quote", "closing"];
export const CHARTS = ["bar", "line", "pie"];
const HEX = /^#?[0-9A-Fa-f]{6}$/;
export const THEME = { primary: "1F3864", accent: "2E86C1", dark: "1B2631", light: "F4F6F7", muted: "5D6D7E" };
export const PALETTE = ["2E86C1", "E67E22", "27AE60", "9B59B6", "E74C3C", "16A085", "F1C40F", "34495E"];
const MAX_IMAGE = 20 * 1024 * 1024;
// Soft limits: past these the fixed boxes overflow or crowd, so check warns (the deck is still built).
export const LIMITS = { tableRows: 12, tableCols: 7, chartPoints: 24, piePoints: 12 };

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
export const hex = (c) => String(c).replace(/^#/, "").toUpperCase();

// XML 1.0 has no place for most control characters. PowerPoint's soft line break comes out of copied text as
// U+000B, so that one becomes a line break; the rest, U+FFFE/U+FFFF and lone surrogates are dropped.
const LINE_TAB = /\u{B}/gu;
const NOT_XML = /[\u{0}-\u{8}\u{C}\u{E}-\u{1F}\u{FFFE}\u{FFFF}]/gu;
// In a /u pattern a well-formed pair is one code point, so this class matches lone surrogates only.
const LONE = /[\u{D800}-\u{DFFF}]/gu;
export const cleanText = (s) => s.replace(LINE_TAB, "\n").replace(NOT_XML, "").replace(LONE, "");

/** A text field: a string (cleaned) or a finite number; absent is empty; anything else is an error. */
function text(v, what, ctx) {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return cleanText(v);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  ctx.errors.push(`${what}: 글이어야 함`);
  return "";
}

/** A list field: absent is empty; present but not an array is an error. */
function list(v, what, ctx) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  ctx.errors.push(`${what}: 배열이어야 함`);
  return [];
}

// Width in em of a line: Hangul, CJK and full-width forms take a full em, other characters about half.
const WIDE = /[\u{1100}-\u{11FF}\u{2E80}-\u{9FFF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FF00}-\u{FFEF}]/u;
export const ems = (s) => Array.from(s).reduce((n, ch) => n + (WIDE.test(ch) ? 1 : 0.55), 0);
const linesOf = (s, pt, widthIn) => s.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil((ems(l) * pt) / 72 / widthIn)), 0);

/** Estimated height in inches of bullets set at 20 pt (level 2 at 17 pt) in a box widthIn wide. */
export function bulletsHeight(bullets, widthIn) {
  return bullets.reduce((h, b) => {
    const pt = b.level === 2 ? 17 : 20;
    return h + (linesOf(b.text, pt, widthIn - (b.level === 2 ? 0.6 : 0.35)) * pt * 1.2) / 72 + 8 / 72;
  }, 0);
}

function themeOf(deck, ctx) {
  const t = { ...THEME };
  for (const [k, v] of Object.entries(obj(deck.theme))) {
    if (!Object.prototype.hasOwnProperty.call(THEME, k)) ctx.errors.push(`theme.${k} 는 없는 칸(${Object.keys(THEME).join(", ")})`);
    else if (!HEX.test(String(v))) ctx.errors.push(`theme.${k} 색이 6자리 16진수가 아님: ${String(v)}`);
    else t[k] = hex(v);
  }
  return t;
}

/** Bullets: strings, or { text, level } with level 1 or 2. box: { w, h } in inches for the overflow estimate. */
function bulletsOf(raw, what, ctx, box) {
  const out = list(raw, what, ctx).map((b, i) => {
    if (b === null || b === undefined) ctx.errors.push(`${what}[${i}]: 글이어야 함`);
    if (b && typeof b === "object" && !Array.isArray(b)) return { text: text(b.text, `${what}[${i}].text`, ctx), level: Number(b.level) === 2 ? 2 : 1 };
    return { text: text(b, `${what}[${i}]`, ctx), level: 1 };
  });
  if (bulletsHeight(out, box.w) > box.h) ctx.warnings.push(`${what}: 글머리가 상자 높이를 넘을 수 있음(나누거나 줄이기를 권함)`);
  return out;
}

function tableOf(s, what, ctx) {
  const header = list(s.header, `${what}.header`, ctx).map((h, i) => text(h, `${what}.header[${i}]`, ctx));
  const rows = list(s.rows, `${what}.rows`, ctx).map((r, i) => list(r, `${what}.rows[${i}]`, ctx).map((c, j) => text(c, `${what}.rows[${i}][${j}]`, ctx)));
  const width = rows.reduce((m, r) => Math.max(m, r.length), header.length);
  if (!width) ctx.errors.push(`${what}: 표에 칸이 없음`);
  if (rows.length > LIMITS.tableRows) ctx.warnings.push(`${what}: 표 행이 ${LIMITS.tableRows}개를 넘음`);
  if (width > LIMITS.tableCols) ctx.warnings.push(`${what}: 표 열이 ${LIMITS.tableCols}개를 넘음`);
  const pad = (r) => [...r, ...Array(Math.max(0, width - r.length)).fill("")];
  return { header: header.length ? pad(header) : [], rows: rows.map(pad) };
}

function seriesOf(raw, what, ctx) {
  return list(raw, `${what}.series`, ctx).map(obj).map((x, k) => {
    const values = list(x.values, `${what}.series[${k}].values`, ctx);
    if (values.some((v) => typeof v !== "number" || !Number.isFinite(v))) ctx.errors.push(`${what}: 계열 값은 숫자만(null 이나 글자 안 됨)`);
    return { name: text(x.name, `${what}.series[${k}].name`, ctx), values: values.map((v) => (typeof v === "number" ? v : 0)) };
  });
}

function chartOf(s, what, ctx) {
  const c = obj(s.chart);
  const kind = text(c.kind || "bar", `${what}.chart.kind`, ctx);
  if (!CHARTS.includes(kind)) ctx.errors.push(`${what}: chart.kind 는 ${CHARTS.join(", ")} 중 하나`);
  const labels = list(c.labels, `${what}.chart.labels`, ctx).map((l, i) => text(l, `${what}.chart.labels[${i}]`, ctx));
  const series = seriesOf(c.series, `${what}.chart`, ctx);
  checkSeries(kind, labels, series, what, ctx);
  return { kind, labels, series, unit: text(c.unit, `${what}.chart.unit`, ctx) };
}

function checkSeries(kind, labels, series, what, ctx) {
  if (!labels.length || !series.length) ctx.errors.push(`${what}: chart.labels 와 chart.series 가 필요함`);
  if (series.some((x) => x.values.length !== labels.length)) ctx.errors.push(`${what}: 계열마다 값 수가 labels 수와 같아야 함`);
  const names = series.map((x) => x.name.trim());
  if (series.length > 1 && (names.some((n) => !n) || new Set(names).size !== names.length)) ctx.errors.push(`${what}: 계열이 둘 이상이면 이름이 비지 않고 서로 달라야 함`);
  if (kind === "pie") checkPie(series, labels, what, ctx);
  else if (labels.length > LIMITS.chartPoints) ctx.warnings.push(`${what}: 차트 항목이 ${LIMITS.chartPoints}개를 넘음`);
}

function checkPie(series, labels, what, ctx) {
  const v = series[0]?.values ?? [];
  if (series.length !== 1 || v.some((x) => x < 0)) ctx.errors.push(`${what}: pie 는 음수 없는 계열 하나`);
  else if (!v.some((x) => x > 0)) ctx.errors.push(`${what}: pie 값이 모두 0`);
  if (labels.length > LIMITS.piePoints) ctx.warnings.push(`${what}: pie 항목이 ${LIMITS.piePoints}개를 넘음(범례가 잘림)`);
}

const IMAGE_TYPES = [
  { mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
];

const isPath = (p) => isAbsolute(p) || win32.isAbsolute(p) || !/^[a-z][a-z0-9+.-]+:/i.test(p);

/** Reads a local PNG, JPEG or GIF once; the type comes from its first bytes, not its name. */
function imageOf(s, what, ctx) {
  const p = text(s.image, `${what}.image`, ctx);
  if (!p || !isPath(p)) {
    ctx.errors.push(`${what}: image 는 로컬 파일 경로여야 함(URL 은 받지 않음)`);
    return null;
  }
  const file = isAbsolute(p) || win32.isAbsolute(p) ? p : resolve(ctx.base, p);
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error("보통 파일이 아님");
    if (st.size > MAX_IMAGE) throw new Error("20MB 를 넘음");
    const data = readFileSync(file);
    const t = IMAGE_TYPES.find((x) => x.magic.every((b, i) => data[i] === b));
    if (!t) throw new Error("PNG, JPEG, GIF 가 아님");
    const size = imageSize(data, t.mime);
    if (!size) ctx.warnings.push(`${what}: 그림 크기를 읽지 못해 상자 비율로 맞춤`);
    return { file, mime: t.mime, size, data };
  } catch (e) {
    ctx.errors.push(`${what}: 이미지를 읽지 못함 (${file}: ${e.message})`);
    return null;
  }
}

/** Pixel size from the header (PNG IHDR, GIF screen, JPEG SOFn), or null. */
export function imageSize(b, mime) {
  if (mime === "image/png" && b.length > 24) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (mime === "image/gif" && b.length > 10) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  return mime === "image/jpeg" ? jpegSize(b) : null;
}

/** Walks the JPEG segments to the first start-of-frame marker (SOF0..SOF15 but DHT, JPG, DAC); fill bytes skipped. */
function jpegSize(b) {
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    if (b[i + 1] === 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

const BOX = { w: 11.73, h: 5.15 };
const HALF = { w: 5.66, h: 4.55 };

const FIELDS = {
  title: (s, w, ctx) => ({ subtitle: text(s.subtitle, `${w}.subtitle`, ctx), presenter: text(s.presenter, `${w}.presenter`, ctx), date: text(s.date, `${w}.date`, ctx) }),
  section: (s, w, ctx) => ({ subtitle: text(s.subtitle, `${w}.subtitle`, ctx) }),
  bullets: (s, w, ctx) => ({ bullets: bulletsOf(s.bullets, `${w}.bullets`, ctx, BOX) }),
  two: (s, w, ctx) => ({ left: columnOf(s.left, `${w}.left`, ctx), right: columnOf(s.right, `${w}.right`, ctx) }),
  table: (s, w, ctx) => ({ table: tableOf(s, w, ctx), caption: text(s.caption, `${w}.caption`, ctx) }),
  chart: (s, w, ctx) => ({ chart: chartOf(s, w, ctx), caption: text(s.caption, `${w}.caption`, ctx) }),
  image: (s, w, ctx) => ({ image: imageOf(s, w, ctx), caption: text(s.caption, `${w}.caption`, ctx) }),
  quote: (s, w, ctx) => ({ quote: text(s.quote, `${w}.quote`, ctx), by: text(s.by, `${w}.by`, ctx) }),
  closing: (s, w, ctx) => ({ subtitle: text(s.subtitle, `${w}.subtitle`, ctx) }),
};

function columnOf(raw, what, ctx) {
  const c = obj(raw);
  const heading = text(c.heading, `${what}.heading`, ctx);
  return { heading, bullets: bulletsOf(c.bullets, `${what}.bullets`, ctx, heading ? HALF : { ...HALF, h: HALF.h + 0.6 }) };
}

function slideOf(raw, i, ctx) {
  const s = obj(raw);
  const what = `slides[${i}]`;
  const type = typeof s.type === "string" ? s.type : "";
  if (!TYPES.includes(type)) {
    ctx.errors.push(`${what}: type 은 ${TYPES.join(", ")} 중 하나 (${String(s.type)})`);
    return null;
  }
  const title = text(s.title, `${what}.title`, ctx);
  if (type !== "quote" && !title.trim()) ctx.errors.push(`${what}: title 이 없음`);
  if ((ems(title) * 28) / 72 > 12.1 && !["title", "closing"].includes(type)) ctx.warnings.push(`${what}: 제목이 한 줄을 넘을 수 있음`);
  return { type, title, notes: text(s.notes, `${what}.notes`, ctx), ...FIELDS[type](s, what, ctx) };
}

/**
 * Checks a deck and returns { errors, warnings, model }; model is null when there are errors. base is the folder
 * relative image paths start from (the deck file's folder).
 */
export function readDeck(deck, base) {
  const errors = [];
  const warnings = [];
  if (!deck || typeof deck !== "object" || Array.isArray(deck)) return { errors: ["deck 은 JSON 객체여야 함"], warnings, model: null };
  const ctx = { errors, warnings, base: base || process.cwd() };
  const title = text(deck.title, "title", ctx);
  if (!title.trim()) errors.push("title 이 없음");
  if (!Array.isArray(deck.slides) || !deck.slides.length) errors.push("slides 가 비어 있음");
  const model = {
    title,
    author: text(deck.author, "author", ctx),
    footer: text(deck.footer, "footer", ctx),
    theme: themeOf(deck, ctx),
    slides: arr(deck.slides).map((s, i) => slideOf(s, i, ctx)).filter(Boolean),
  };
  return { errors, warnings, model: errors.length ? null : model };
}

export const deckBase = (file) => dirname(resolve(file));
