// wp-model.mjs: reads a wide-pptx deck (JSON), checks it and returns one model that the PPTX and HTML writers both
// draw. Images are read here (local files only) so both outputs embed the same bytes. No network.
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const TYPES = ["title", "section", "bullets", "two", "table", "chart", "image", "quote", "closing"];
export const CHARTS = ["bar", "line", "pie"];
const HEX = /^#?[0-9A-Fa-f]{6}$/;
export const THEME = { primary: "1F3864", accent: "2E86C1", dark: "1B2631", light: "F4F6F7", muted: "5D6D7E" };
export const PALETTE = ["2E86C1", "E67E22", "27AE60", "9B59B6", "E74C3C", "16A085", "F1C40F", "34495E"];
const MAX_IMAGE = 20 * 1024 * 1024;
// Soft limits: past these the fixed boxes overflow, so check warns (the deck is still built).
export const LIMITS = { bullets: 7, bulletChars: 80, titleChars: 40, tableRows: 12, tableCols: 7, chartPoints: 24 };

const str = (v) => (v === undefined || v === null ? "" : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
export const hex = (c) => String(c).replace(/^#/, "").toUpperCase();

function themeOf(deck, errors) {
  const t = { ...THEME };
  for (const [k, v] of Object.entries(obj(deck.theme))) {
    if (!Object.prototype.hasOwnProperty.call(THEME, k)) errors.push(`theme.${k} 는 없는 칸(${Object.keys(THEME).join(", ")})`);
    else if (!HEX.test(str(v))) errors.push(`theme.${k} 색이 6자리 16진수가 아님: ${str(v)}`);
    else t[k] = hex(v);
  }
  return t;
}

/** Bullets: strings, or { text, level } with level 1 or 2. */
function bulletsOf(list, what, ctx) {
  const out = arr(list).map((b) => {
    const o = typeof b === "string" ? { text: b, level: 1 } : { text: str(obj(b).text), level: obj(b).level === 2 ? 2 : 1 };
    if (o.text.length > LIMITS.bulletChars) ctx.warnings.push(`${what}: 글머리 한 줄이 ${LIMITS.bulletChars}자를 넘음(줄바꿈으로 넘칠 수 있음)`);
    return o;
  });
  if (out.length > LIMITS.bullets) ctx.warnings.push(`${what}: 글머리가 ${LIMITS.bullets}개를 넘음(나누어 쓰기를 권함)`);
  return out;
}

function tableOf(s, what, ctx) {
  const header = arr(s.header).map(str);
  const rows = arr(s.rows).map((r) => arr(r).map(str));
  const width = Math.max(header.length, ...rows.map((r) => r.length), 0);
  if (!width) ctx.errors.push(`${what}: 표에 칸이 없음`);
  if (rows.length > LIMITS.tableRows) ctx.warnings.push(`${what}: 표 행이 ${LIMITS.tableRows}개를 넘음`);
  if (width > LIMITS.tableCols) ctx.warnings.push(`${what}: 표 열이 ${LIMITS.tableCols}개를 넘음`);
  const pad = (r) => [...r, ...Array(Math.max(0, width - r.length)).fill("")];
  return { header: header.length ? pad(header) : [], rows: rows.map(pad) };
}

function chartOf(s, what, ctx) {
  const c = obj(s.chart);
  const kind = str(c.kind || "bar");
  if (!CHARTS.includes(kind)) ctx.errors.push(`${what}: chart.kind 는 ${CHARTS.join(", ")} 중 하나`);
  const labels = arr(c.labels).map(str);
  const series = arr(c.series).map(obj).map((x) => ({ name: str(x.name), values: arr(x.values).map(Number) }));
  checkSeries(kind, labels, series, what, ctx);
  return { kind, labels, series, unit: str(c.unit) };
}

function checkSeries(kind, labels, series, what, ctx) {
  if (!labels.length || !series.length) ctx.errors.push(`${what}: chart.labels 와 chart.series 가 필요함`);
  if (series.some((x) => x.values.length !== labels.length || x.values.some((v) => !Number.isFinite(v)))) {
    ctx.errors.push(`${what}: 계열마다 값 수가 labels 수와 같은 숫자여야 함`);
  }
  if (kind === "pie" && (series.length !== 1 || series[0]?.values.some((v) => v < 0))) ctx.errors.push(`${what}: pie 는 음수 없는 계열 하나`);
  if (labels.length > LIMITS.chartPoints) ctx.warnings.push(`${what}: 차트 항목이 ${LIMITS.chartPoints}개를 넘음`);
}

const IMAGE_TYPES = [
  { mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
];

/** Reads a local PNG, JPEG or GIF once; the type comes from its first bytes, not its name. */
function imageOf(s, what, ctx) {
  const p = str(s.image);
  if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p)) {
    ctx.errors.push(`${what}: image 는 로컬 파일 경로여야 함(URL 은 받지 않음)`);
    return null;
  }
  const file = isAbsolute(p) ? p : resolve(ctx.base, p);
  try {
    if (statSync(file).size > MAX_IMAGE) throw new Error("20MB 를 넘음");
    const data = readFileSync(file);
    const t = IMAGE_TYPES.find((x) => x.magic.every((b, i) => data[i] === b));
    if (!t) throw new Error("PNG, JPEG, GIF 가 아님");
    return { file, mime: t.mime, size: imageSize(data, t.mime), data };
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

/** Walks the JPEG segments to the first start-of-frame marker (SOF0..SOF15 but DHT, JPG, DAC). */
function jpegSize(b) {
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

const FIELDS = {
  title: (s) => ({ subtitle: str(s.subtitle), presenter: str(s.presenter), date: str(s.date) }),
  section: (s) => ({ subtitle: str(s.subtitle) }),
  bullets: (s, w, ctx) => ({ bullets: bulletsOf(s.bullets, w, ctx) }),
  two: (s, w, ctx) => ({
    left: { heading: str(obj(s.left).heading), bullets: bulletsOf(obj(s.left).bullets, `${w} left`, ctx) },
    right: { heading: str(obj(s.right).heading), bullets: bulletsOf(obj(s.right).bullets, `${w} right`, ctx) },
  }),
  table: (s, w, ctx) => ({ table: tableOf(s, w, ctx), caption: str(s.caption) }),
  chart: (s, w, ctx) => ({ chart: chartOf(s, w, ctx), caption: str(s.caption) }),
  image: (s, w, ctx) => ({ image: imageOf(s, w, ctx), caption: str(s.caption) }),
  quote: (s) => ({ quote: str(s.quote), by: str(s.by) }),
  closing: (s) => ({ subtitle: str(s.subtitle) }),
};

function slideOf(raw, i, ctx) {
  const s = obj(raw);
  const type = str(s.type);
  const what = `slides[${i}]`;
  if (!TYPES.includes(type)) {
    ctx.errors.push(`${what}: type 은 ${TYPES.join(", ")} 중 하나 (${type})`);
    return null;
  }
  const title = str(s.title);
  if (title.length > LIMITS.titleChars) ctx.warnings.push(`${what}: 제목이 ${LIMITS.titleChars}자를 넘음`);
  if (type !== "quote" && !title.trim()) ctx.errors.push(`${what}: title 이 없음`);
  return { type, title, notes: str(s.notes), ...FIELDS[type](s, what, ctx) };
}

/**
 * Checks a deck and returns { errors, warnings, model }; model is null when there are errors. base is the folder
 * relative image paths start from (the deck file's folder).
 */
export function readDeck(deck, base) {
  const errors = [];
  const warnings = [];
  if (!deck || typeof deck !== "object" || Array.isArray(deck)) return { errors: ["deck 은 JSON 객체여야 함"], warnings, model: null };
  if (!str(deck.title).trim()) errors.push("title 이 없음");
  if (!Array.isArray(deck.slides) || !deck.slides.length) errors.push("slides 가 비어 있음");
  const ctx = { errors, warnings, base: base || process.cwd() };
  const model = {
    title: str(deck.title),
    author: str(deck.author),
    footer: str(deck.footer),
    theme: themeOf(deck, errors),
    slides: arr(deck.slides).map((s, i) => slideOf(s, i, ctx)).filter(Boolean),
  };
  return { errors, warnings, model: errors.length ? null : model };
}

export const deckBase = (file) => dirname(resolve(file));
