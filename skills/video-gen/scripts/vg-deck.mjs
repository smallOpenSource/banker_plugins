// vg-deck.mjs: turns a wide-pptx deck (JSON) into a video-gen scene file, one scene per slide, so a presentation
// can also become a video. Slides that have no scene of their own become the closest one; nothing is invented.
import { isAbsolute, resolve, win32 } from "node:path";

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const bulletText = (b) => str(typeof b === "object" && b ? b.text : b);
const HEX = /^#?[0-9A-Fa-f]{6}$/;

function columns(s) {
  return [obj(s.left), obj(s.right)].flatMap((c) => {
    const items = (Array.isArray(c.bullets) ? c.bullets : []).map(bulletText).filter(Boolean);
    return c.heading ? items.map((x) => `${str(c.heading)}: ${x}`) : items;
  });
}

function tableRows(s) {
  const head = Array.isArray(s.header) ? s.header.map(str) : [];
  const rows = (Array.isArray(s.rows) ? s.rows : []).map((r) => (Array.isArray(r) ? r.map(str) : []));
  return rows.map((r) => (head.length ? r.map((c, i) => (c && head[i] ? `${head[i]} ${c}` : c)) : r).filter(Boolean).join(" | ")).filter(Boolean);
}

const bulletsScene = (title, items) => ({ type: "bullets", title, bullets: items, duration: Math.min(20, 2 + 1.2 * items.length) });

function chartScene(s, skipped, i) {
  const c = obj(s.chart);
  if (c.kind === "pie") skipped.push(`slides[${i}]: 원 차트는 막대 차트로 바꿈`);
  return { type: "chart", title: str(s.title), chart: { kind: c.kind === "line" ? "line" : "bar", labels: c.labels, series: c.series, unit: c.unit }, duration: 6 };
}

function imageScene(s, base) {
  const p = str(s.image);
  const abs = isAbsolute(p) || win32.isAbsolute(p) ? p : resolve(base, p);
  return { type: "image", image: abs, caption: str(s.caption) || str(s.title), duration: 5 };
}

const MAP = {
  title: (s) => ({ type: "title", title: str(s.title), subtitle: str(s.subtitle) || [str(s.presenter), str(s.date)].filter(Boolean).join("  |  "), duration: 4 }),
  section: (s) => ({ type: "title", title: str(s.title), subtitle: str(s.subtitle), duration: 3 }),
  bullets: (s) => bulletsScene(str(s.title), (Array.isArray(s.bullets) ? s.bullets : []).map(bulletText).filter(Boolean)),
  two: (s) => bulletsScene(str(s.title), columns(s)),
  table: (s) => bulletsScene(str(s.title), tableRows(s)),
  chart: chartScene,
  image: (s, ...rest) => imageScene(s, rest[2]),
  quote: (s) => ({ type: "quote", quote: str(s.quote), by: str(s.by), duration: 5 }),
  closing: (s) => ({ type: "title", title: str(s.title), subtitle: str(s.subtitle), duration: 4 }),
};

function themeOf(t) {
  const pick = (k, d) => (HEX.test(str(t[k])) ? str(t[k]).replace(/^#/, "").toUpperCase() : d);
  return { bg: pick("primary", "1F3864"), accent: pick("accent", "2E86C1"), ink: pick("dark", "1B2631"), panel: pick("light", "F4F6F7"), fg: "FFFFFF", muted: "D6EAF8" };
}

const blank = (x) => !String(x ?? "").trim();
const emptyScene = (s) => ({ bullets: () => !s.bullets.length, quote: () => blank(s.quote), title: () => blank(s.title) }[s.type]?.() ?? false);

/** Returns { scenes: <scene file object>, skipped: [notes] }. base is the deck's folder (image paths). */
export function deckToScenes(deck, base = process.cwd()) {
  const d = obj(deck);
  const skipped = [];
  const scenes = (Array.isArray(d.slides) ? d.slides : []).map((raw, i) => {
    const s = obj(raw);
    const f = Object.prototype.hasOwnProperty.call(MAP, s.type) ? MAP[s.type] : null;
    if (!f) {
      skipped.push(`slides[${i}]: 알 수 없는 type(${str(s.type)}) 은 뺌`);
      return null;
    }
    const scene = { ...f(s, skipped, i, base), transition: i ? "fade" : "cut" };
    return emptyScene(scene) ? (skipped.push(`slides[${i}]: 영상에 쓸 내용이 없어 뺌`), null) : scene;
  }).filter(Boolean);
  return { scenes: { title: str(d.title), size: "1280x720", fps: 30, theme: themeOf(obj(d.theme)), scenes }, skipped };
}
