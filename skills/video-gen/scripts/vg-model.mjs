// vg-model.mjs: reads a video-gen scene file (JSON), checks it and returns one timeline the renderer draws.
// Images are read here (local regular files only). No network.
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, win32 } from "node:path";

export const TYPES = ["title", "kinetic", "bullets", "chart", "counter", "lowerthird", "quote", "image", "credits"];
export const TRANSITIONS = ["cut", "fade", "wipe", "stripes"];
export const SIZES = { "1280x720": [1280, 720], "1920x1080": [1920, 1080], "1080x1920": [1080, 1920], "1080x1080": [1080, 1080] };
export const THEME = { bg: "1F3864", fg: "FFFFFF", accent: "2E86C1", muted: "D6EAF8", panel: "F4F6F7", ink: "1B2631" };
export const PALETTE = ["2E86C1", "E67E22", "27AE60", "9B59B6", "E74C3C", "16A085", "F1C40F", "34495E"];
export const LIMITS = { duration: 600, scene: 60, sceneMin: 0.5, transition: 1.5, bullets: 7, lines: 6, credits: 60, points: 24 };
const HEX = /^#?[0-9A-Fa-f]{6}$/;
const MAX_IMAGE = 20 * 1024 * 1024;

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
export const hex = (c) => String(c).replace(/^#/, "").toUpperCase();

// Drawn text has no use for control characters; a copied soft line break (U+000B) becomes a line break.
export const cleanText = (s) => s.replace(/\u{B}/gu, "\n").replace(/[\u{0}-\u{8}\u{C}\u{E}-\u{1F}\u{FFFE}\u{FFFF}]/gu, "").replace(/[\u{D800}-\u{DFFF}]/gu, "");

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
  const out = list(v, what, ctx).map((x, i) => text(x, `${what}[${i}]`, ctx));
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
    if (values.length !== labels.length) ctx.errors.push(`${what}: 계열마다 값 수가 labels 수와 같아야 함`);
    return { name: text(s.name, `${what}.series[${k}].name`, ctx), values: values.map((v) => (typeof v === "number" ? v : 0)) };
  });
  if (!labels.length || !series.length) ctx.errors.push(`${what}: labels 와 series 가 필요함`);
  return { kind, labels, series, unit: text(c.unit, `${what}.unit`, ctx) };
}

const IMAGE_TYPES = [
  { mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/webp", magic: [0x52, 0x49, 0x46, 0x46] },
];

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
    if (!IMAGE_TYPES.some((x) => x.magic.every((b, i) => data[i] === b))) throw new Error("PNG, JPEG, GIF, WebP 가 아님");
    return { file, data };
  } catch (e) {
    ctx.errors.push(`${what}: 이미지를 읽지 못함 (${file}: ${e.message})`);
    return null;
  }
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
  image: (s, w, c) => ({ image: imageOf(s.image, `${w}.image`, c), caption: text(s.caption, `${w}.caption`, c), motion: s.motion === "pan" ? "pan" : "zoom" }),
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
  const v = need && scene[need];
  if (need && (!v || (Array.isArray(v) && !v.length))) ctx.errors.push(`${what}: ${need} 가 필요함`);
  return scene;
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
