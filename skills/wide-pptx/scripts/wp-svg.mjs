// wp-svg.mjs: bar, line and pie charts as inline SVG for the HTML deck (no library). Values come from wp-model.mjs
// as finite numbers; text is escaped; colours are 6-digit hex.
import { PALETTE } from "./wp-model.mjs";

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = (n) => Math.round(n * 10) / 10;

/** A "nice" axis: [min, max, step] covering the values with about 5 steps. */
export function niceAxis(values) {
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  return [lo, hi, step];
}

const fmt = (v) => (Math.abs(v) >= 1000 ? v.toLocaleString("en-US") : String(f(v)));

function legend(names, w, y) {
  if (names.length < 2) return "";
  const item = 150;
  const x0 = (w - item * names.length) / 2;
  return names.map((n, i) => `<rect x="${f(x0 + i * item)}" y="${y - 10}" width="14" height="14" fill="#${PALETTE[i % PALETTE.length]}"/>`
    + `<text x="${f(x0 + i * item + 20)}" y="${y + 2}" font-size="16">${esc(n)}</text>`).join("");
}

function axes(c, box) {
  const [lo, hi, step] = niceAxis(c.series.flatMap((s) => s.values));
  const y = (v) => box.y + box.h - ((v - lo) / (hi - lo)) * box.h;
  let grid = "";
  for (let v = lo; v <= hi + step / 2; v += step) {
    grid += `<line x1="${box.x}" x2="${box.x + box.w}" y1="${f(y(v))}" y2="${f(y(v))}" stroke="#D5D8DC"/>`
      + `<text x="${box.x - 10}" y="${f(y(v)) + 5}" font-size="14" text-anchor="end">${esc(fmt(v))}</text>`;
  }
  const unit = c.unit ? `<text x="${box.x}" y="${box.y - 14}" font-size="14">${esc(c.unit)}</text>` : "";
  return { y, svg: grid + unit };
}

function labelsAt(c, box, slot) {
  return c.labels.map((l, i) => `<text x="${f(box.x + slot * (i + 0.5))}" y="${box.y + box.h + 24}" font-size="14" text-anchor="middle">${esc(l)}</text>`).join("");
}

function bar(c, w, h) {
  const box = { x: 80, y: 30, w: w - 110, h: h - 100 };
  const { y, svg } = axes(c, box);
  const slot = box.w / c.labels.length;
  const bw = (slot * 0.7) / c.series.length;
  const bars = c.series.map((s, k) => s.values.map((v, i) => {
    const x = box.x + slot * i + slot * 0.15 + bw * k;
    const top = Math.min(y(v), y(0));
    return `<rect x="${f(x)}" y="${f(top)}" width="${f(bw)}" height="${f(Math.abs(y(v) - y(0)))}" fill="#${PALETTE[k % PALETTE.length]}"/>`;
  }).join("")).join("");
  return svg + bars + labelsAt(c, box, slot) + legend(c.series.map((s) => s.name), w, h - 16);
}

function line(c, w, h) {
  const box = { x: 80, y: 30, w: w - 110, h: h - 100 };
  const { y, svg } = axes(c, box);
  const slot = box.w / c.labels.length;
  const lines = c.series.map((s, k) => {
    const color = PALETTE[k % PALETTE.length];
    const pts = s.values.map((v, i) => [f(box.x + slot * (i + 0.5)), f(y(v))]);
    return `<polyline fill="none" stroke="#${color}" stroke-width="3" points="${pts.map((p) => p.join(",")).join(" ")}"/>`
      + pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="5" fill="#${color}"/>`).join("");
  }).join("");
  return svg + lines + labelsAt(c, box, slot) + legend(c.series.map((s) => s.name), w, h - 16);
}

function pie(c, w, h) {
  const values = c.series[0].values;
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const r = Math.min(w * 0.3, (h - 70) / 2);
  const cx = w * 0.38;
  const cy = (h - 40) / 2;
  let a = -Math.PI / 2;
  const parts = values.map((v, i) => {
    const b = a + (v / total) * 2 * Math.PI;
    const large = b - a > Math.PI ? 1 : 0;
    const p = (t) => `${f(cx + r * Math.cos(t))} ${f(cy + r * Math.sin(t))}`;
    const d = v >= total ? `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0` : `M ${cx} ${cy} L ${p(a)} A ${r} ${r} 0 ${large} 1 ${p(b)} Z`;
    a = b;
    return `<path d="${d}" fill="#${PALETTE[i % PALETTE.length]}" stroke="#FFFFFF" stroke-width="2"/>`;
  }).join("");
  const keys = c.labels.map((l, i) => {
    const ky = 40 + i * 30;
    const pct = f((values[i] / total) * 100);
    return `<rect x="${f(w * 0.7)}" y="${ky - 12}" width="16" height="16" fill="#${PALETTE[i % PALETTE.length]}"/>`
      + `<text x="${f(w * 0.7 + 24)}" y="${ky + 2}" font-size="16">${esc(l)} ${pct}%</text>`;
  }).join("");
  return parts + keys;
}

const KINDS = { bar, line, pie };

/** An SVG element w x h px for a model chart. */
export function chartSvg(c, w, h) {
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="#1B2631" font-family="inherit">${KINDS[c.kind](c, w, h)}</svg>`;
}
