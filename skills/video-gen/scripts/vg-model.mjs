// vg-model.mjs: reads a video-gen scene file (JSON), checks it and returns one timeline the renderer draws.
// Images are read here (local regular files only). No network.
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, win32 } from "node:path";

export const TYPES = ["title", "kinetic", "bullets", "chart", "counter", "lowerthird", "quote", "image", "credits"];
export const TRANSITIONS = ["cut", "fade", "wipe", "stripes"];
export const SIZES = { "1280x720": [1280, 720], "1920x1080": [1920, 1080], "1080x1920": [1080, 1920], "1080x1080": [1080, 1080] };
export const THEME = { bg: "1F3864", fg: "FFFFFF", accent: "2E86C1", muted: "D6EAF8", panel: "F4F6F7", ink: "1B2631" };
export const PALETTE = ["2E86C1", "E67E22", "27AE60", "9B59B6", "E74C3C", "16A085", "F1C40F", "34495E"];
export const LIMITS = { duration: 600, scene: 60, sceneMin: 0.5, bullets: 7, lines: 6, credits: 60, points: 24, value: 1e15, side: 16384, pixels: 50e6 };
const HEX = /^#?[0-9A-Fa-f]{6}$/;
const MAX_IMAGE = 20 * 1024 * 1024;

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
export const hex = (c) => String(c).replace(/^#/, "").toUpperCase();

// Drawn text has no use for control characters; a copied soft line break (U+000B) becomes a line break.
// Text is put in NFC, so Hangul copied from macOS (jamo apart) draws as syllables.
export const cleanText = (s) => s.normalize("NFC").replace(/\u{B}/gu, "\n").replace(/[\u{0}-\u{8}\u{C}\u{E}-\u{1F}\u{FFFE}\u{FFFF}]/gu, "").replace(/[\u{D800}-\u{DFFF}]/gu, "");

function text(v, what, ctx) {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return cleanText(v);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  ctx.errors.push(`${what}: 글이어야 함`);
  return "";
}

function list(v, what, ctx) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  ctx.errors.push(`${what}: 배열이어야 함`);
  return [];
}

function texts(v, what, ctx, max) {
  const all = list(v, what, ctx).map((x, i) => text(x, `${what}[${i}]`, ctx));
  const out = all.filter((x) => x.trim());
  if (out.length < all.length) ctx.warnings.push(`${what}: 빈 항목은 뺌`);
  if (out.length > max) ctx.warnings.push(`${what}: ${max}개를 넘음(화면에 다 들어가지 않을 수 있음)`);
  return out;
}

const inRange = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

function num(v, what, ctx, { min = -Infinity, max = Infinity, def } = {}) {
  if (v === undefined && def !== undefined) return def;
  if (!inRange(v, min, max)) {
    ctx.errors.push(`${what}: ${min} 이상 ${max} 이하 숫자여야 함`);
    return def ?? min;
  }
  return v;
}

function themeOf(doc, ctx) {
  const t = { ...THEME };
  for (const [k, v] of Object.entries(obj(doc.theme))) {
    if (!Object.prototype.hasOwnProperty.call(THEME, k)) ctx.errors.push(`theme.${k} 는 없는 칸(${Object.keys(THEME).join(", ")})`);
    else if (!HEX.test(String(v))) ctx.errors.push(`theme.${k} 색이 6자리 16진수가 아님`);
    else t[k] = hex(v);
  }
  return t;
}

function chartOf(raw, what, ctx) {
  const c = obj(raw);
  const kind = c.kind === undefined ? "bar" : text(c.kind, `${what}.kind`, ctx);
  if (!["bar", "line"].includes(kind)) ctx.errors.push(`${what}.kind 는 bar, line 중 하나`);
  const labels = texts(c.labels, `${what}.labels`, ctx, LIMITS.points);
  const series = list(c.series, `${what}.series`, ctx).map(obj).map((s, k) => {
    const values = list(s.values, `${what}.series[${k}].values`, ctx);
    if (values.some((v) => typeof v !== "number" || !Number.isFinite(v))) ctx.errors.push(`${what}: 계열 값은 숫자만(null 이나 글자 안 됨)`);
    else if (values.some((v) => Math.abs(v) > LIMITS.value)) ctx.errors.push(`${what}: 계열 값은 절댓값 ${LIMITS.value} 이하`);
    if (values.length !== labels.length) ctx.errors.push(`${what}: 계열마다 값 수가 labels 수와 같아야 함`);
    return { name: text(s.name, `${what}.series[${k}].name`, ctx), values: values.map((v) => (typeof v === "number" ? v : 0)) };
  });
  if (!labels.length || !series.length) ctx.errors.push(`${what}: labels 와 series 가 필요함`);
  return { kind, labels, series, unit: text(c.unit, `${what}.unit`, ctx) };
}

/** Pixel size and whether the file ends as its format ends, from the bytes; null when it is no PNG/JPEG/GIF/WebP. */
export function imageInfo(b) {
  const at = (sig, off = 0) => sig.every((x, i) => b[off + i] === x);
  if (at([0x89, 0x50, 0x4e, 0x47]) && b.length > 24) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), whole: b.includes("IEND", Math.max(0, b.length - 16)) };
  if (at([0x47, 0x49, 0x46, 0x38]) && b.length > 10) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8), whole: b.lastIndexOf(0x3b) >= b.length - 16 };
  if (at([0xff, 0xd8, 0xff])) return jpegInfo(b);
  if (at([0x52, 0x49, 0x46, 0x46]) && b.length > 30 && b.toString("latin1", 8, 12) === "WEBP") return { ...webpSize(b), whole: b.readUInt32LE(4) + 8 <= b.length };
  return null;
}

// Walks the JPEG segments to the size (SOF) and the first scan (SOS). The file is whole when an end marker (FF D9)
// follows that scan: inside scan data FF is only followed by 00 or a restart marker, so the first FF D9 after it is
// the end, whatever is appended behind it (a phone's motion photo puts a whole MP4 there).
function jpegInfo(b) {
  let size = { w: 0, h: 0 };
  for (let i = 2; i + 3 < b.length;) {
    if (b[i] !== 0xff) break;
    if (b[i + 1] === 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xda) return { ...size, whole: b.indexOf(Buffer.from([0xff, 0xd9]), i + 2) >= 0 };
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && i + 9 < b.length) size = { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    const len = b.readUInt16BE(i + 2);
    if (len < 2) break;
    i += 2 + len;
  }
  return { ...size, whole: false };
}

function webpSize(b) {
  const kind = b.toString("latin1", 12, 16);
  if (kind === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  if (kind === "VP8L") {
    const v = b.readUInt32LE(21);
    return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) };
  }
  return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
}

function checkImage(data) {
  const info = imageInfo(data);
  if (!info) throw new Error("PNG, JPEG, GIF, WebP 가 아님");
  if (!(info.w > 0 && info.h > 0)) throw new Error("그림 크기를 읽지 못함");
  if (info.w > LIMITS.side || info.h > LIMITS.side || info.w * info.h > LIMITS.pixels) throw new Error(`너무 큼(${info.w}x${info.h}, 한 변 ${LIMITS.side}, ${LIMITS.pixels / 1e6}MP 까지)`);
  if (!info.whole) throw new Error("파일이 잘림(끝 표지가 없음)");
}

function imageOf(raw, what, ctx) {
  const p = text(raw, what, ctx);
  const abs = isAbsolute(p) || win32.isAbsolute(p);
  if (!p || (!abs && /^[a-z][a-z0-9+.-]+:/i.test(p))) {
    ctx.errors.push(`${what}: 로컬 파일 경로여야 함(URL 은 받지 않음)`);
    return null;
  }
  const file = abs ? p : resolve(ctx.base, p);
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error("보통 파일이 아님");
    if (st.size > MAX_IMAGE) throw new Error("20MB 를 넘음");
    const data = readFileSync(file);
    checkImage(data);
    return { file, data };
  } catch (e) {
    ctx.errors.push(`${what}: 이미지를 읽지 못함 (${file}: ${e.message})`);
    return null;
  }
}

function motionOf(v, what, ctx) {
  if (v === undefined) return "zoom";
  if (v === "zoom" || v === "pan") return v;
  ctx.errors.push(`${what}: zoom, pan 중 하나`);
  return "zoom";
}

const FIELDS = {
  title: (s, w, c) => ({ title: text(s.title, `${w}.title`, c), subtitle: text(s.subtitle, `${w}.subtitle`, c) }),
  kinetic: (s, w, c) => ({ lines: texts(s.lines, `${w}.lines`, c, LIMITS.lines) }),
  bullets: (s, w, c) => ({ title: text(s.title, `${w}.title`, c), bullets: texts(s.bullets, `${w}.bullets`, c, LIMITS.bullets) }),
  chart: (s, w, c) => ({ title: text(s.title, `${w}.title`, c), chart: chartOf(s.chart, `${w}.chart`, c) }),
  counter: (s, w, c) => ({
    label: text(s.label, `${w}.label`, c), unit: text(s.unit, `${w}.unit`, c),
    from: num(s.from, `${w}.from`, c, { def: 0, min: -1e12, max: 1e12 }), to: num(s.to, `${w}.to`, c, { min: -1e12, max: 1e12 }),
  }),
  lowerthird: (s, w, c) => ({ name: text(s.name, `${w}.name`, c), role: text(s.role, `${w}.role`, c), image: s.image === undefined ? null : imageOf(s.image, `${w}.image`, c) }),
  quote: (s, w, c) => ({ quote: text(s.quote, `${w}.quote`, c), by: text(s.by, `${w}.by`, c) }),
  image: (s, w, c) => ({ image: imageOf(s.image, `${w}.image`, c), caption: text(s.caption, `${w}.caption`, c), motion: motionOf(s.motion, `${w}.motion`, c) }),
  credits: (s, w, c) => ({ title: text(s.title, `${w}.title`, c), lines: texts(s.lines, `${w}.lines`, c, LIMITS.credits) }),
};

const NEEDS = { title: "title", kinetic: "lines", bullets: "bullets", chart: "chart", lowerthird: "name", quote: "quote", image: "image", credits: "lines" };

function sceneOf(raw, i, ctx) {
  const s = obj(raw);
  const what = `scenes[${i}]`;
  const type = typeof s.type === "string" ? s.type : "";
  if (!TYPES.includes(type)) {
    ctx.errors.push(`${what}: type 은 ${TYPES.join(", ")} 중 하나 (${String(s.type)})`);
    return null;
  }
  const duration = num(s.duration, `${what}.duration`, ctx, { def: 4, min: LIMITS.sceneMin, max: LIMITS.scene });
  const transition = s.transition === undefined ? "fade" : String(s.transition);
  if (!TRANSITIONS.includes(transition)) ctx.errors.push(`${what}.transition 은 ${TRANSITIONS.join(", ")} 중 하나`);
  const scene = { type, duration, transition, ...FIELDS[type](s, what, ctx) };
  const need = NEEDS[type];
  if (need && isEmpty(scene[need])) ctx.errors.push(`${what}: ${need} 가 필요함(빈 글 안 됨)`);
  return scene;
}

/** Empty: missing, blank text, or a list with no non-blank text (a chart or image object is never empty here). */
function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return !v.trim();
  if (Array.isArray(v)) return !v.some((x) => typeof x === "string" && x.trim());
  return false;
}

/** Start times: each scene starts where the one before ends. */
function timeline(scenes) {
  let at = 0;
  return scenes.map((s) => {
    const out = { ...s, start: at };
    at += s.duration;
    return out;
  });
}

/** Frame size and rate: size is one of SIZES, fps a whole number 12..60. */
function frameOf(doc, ctx) {
  const size = doc.size === undefined ? "1280x720" : String(doc.size);
  if (!Object.prototype.hasOwnProperty.call(SIZES, size)) ctx.errors.push(`size 는 ${Object.keys(SIZES).join(", ")} 중 하나`);
  const fps = num(doc.fps, "fps", ctx, { def: 30, min: 12, max: 60 });
  if (!Number.isInteger(fps)) ctx.errors.push("fps 는 정수여야 함");
  const [width, height] = Object.prototype.hasOwnProperty.call(SIZES, size) ? SIZES[size] : SIZES["1280x720"];
  return { width, height, fps };
}

/** Checks a scene file and returns { errors, warnings, model }; model is null when there are errors. */
export function readScenes(doc, base) {
  const errors = [];
  const warnings = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { errors: ["scene 파일은 JSON 객체여야 함"], warnings, model: null };
  const ctx = { errors, warnings, base: base || process.cwd() };
  const { width, height, fps } = frameOf(doc, ctx);
  if (!Array.isArray(doc.scenes) || !doc.scenes.length) errors.push("scenes 가 비어 있음");
  const scenes = timeline((Array.isArray(doc.scenes) ? doc.scenes : []).map((s, i) => sceneOf(s, i, ctx)).filter(Boolean));
  const duration = scenes.reduce((n, s) => n + s.duration, 0);
  if (duration > LIMITS.duration) errors.push(`전체 길이가 ${LIMITS.duration}초를 넘음`);
  const model = { title: text(doc.title, "title", ctx), width, height, fps, theme: themeOf(doc, ctx), scenes, duration, frames: Math.round(duration * fps) };
  return { errors, warnings, model: errors.length ? null : model };
}

export const sceneBase = (file) => dirname(resolve(file));
