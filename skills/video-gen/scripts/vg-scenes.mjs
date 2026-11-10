// vg-scenes.mjs: one draw function per scene type. Each draws the scene at local time t (0 .. duration) on a
// Painter, from the scene and the theme only, so any frame can be drawn on its own.
import { clamp, counter, ease, grouped, lerp, smooth, stagger } from "./vg-fx.mjs";
import { PALETTE } from "./vg-model.mjs";

const enter = (t, at = 0, dur = 0.6) => ease.outCubic(clamp((t - at) / dur));
const margin = (P) => Math.round(P.W * 0.08);

function heading(P, th, title, t) {
  const m = margin(P);
  const a = enter(t, 0.1);
  P.text(title, m, m * 0.8 + (1 - a) * 20 * P.u, { size: 44 * P.u, bold: true, color: th.fg, width: P.W - 2 * m }, { alpha: a });
  P.rect(m, m * 0.8 + 70 * P.u, 110 * P.u * enter(t, 0.3), 6 * P.u, th.accent);
  return m * 0.8 + 110 * P.u;
}

function title(P, s, th, t) {
  P.clear(th.bg);
  const m = margin(P);
  const cy = P.H * 0.46;
  P.rect(m, cy - 18 * P.u, P.W * 0.18 * enter(t, 0.2, 0.8), 8 * P.u, th.accent);
  const a = stagger(t, 0, { start: 0.35, dur: 0.7, curve: ease.outBack });
  const h = P.text(s.title, m, cy + (1 - clamp(a)) * 40 * P.u, { size: 64 * P.u, bold: true, color: th.fg, width: P.W - 2 * m }, { alpha: clamp(a) }).h;
  if (s.subtitle) P.text(s.subtitle, m, cy + h + 18 * P.u, { size: 30 * P.u, color: th.muted, width: P.W - 2 * m }, { alpha: enter(t, 0.9) });
}

/** Lines whose characters enter one by one (stagger with an outBack overshoot), centred. */
function kinetic(P, s, th, t) {
  P.clear(th.bg);
  const size = (s.lines.length > 3 ? 56 : 76) * P.u;
  const lh = size * 1.35;
  let y = P.H / 2 - (s.lines.length * lh) / 2;
  let i = 0;
  for (const line of s.lines) {
    const chars = Array.from(line);
    const widths = chars.map((ch) => P.measure(ch, { size, bold: true }).w);
    let x = (P.W - widths.reduce((a, b) => a + b, 0)) / 2;
    chars.forEach((ch, k) => {
      const p = stagger(t, i++, { start: 0.2, gap: 0.06, dur: 0.5, curve: ease.outBack });
      const color = k === chars.length - 1 && line === s.lines[s.lines.length - 1] ? th.accent : th.fg;
      if (ch.trim()) P.text(ch, x, y + (1 - p) * 0.4 * size, { size, bold: true, color }, { alpha: clamp(p * 1.4), scale: lerp(0.6, 1, clamp(p)) });
      x += widths[k];
    });
    y += lh;
  }
}

function bullets(P, s, th, t) {
  P.clear(th.bg);
  const m = margin(P);
  let y = heading(P, th, s.title, t) + 20 * P.u;
  const size = 32 * P.u;
  s.bullets.forEach((b, i) => {
    const p = stagger(t, i, { start: 0.6, gap: 0.35, dur: 0.6 });
    P.circle(m + 10 * P.u, y + size * 0.62, 7 * P.u * p, th.accent);
    const h = P.text(b, m + 34 * P.u + (1 - p) * 40 * P.u, y, { size, color: th.fg, width: P.W - 2 * m - 34 * P.u }, { alpha: p }).h;
    y += h + 16 * P.u;
  });
}

function chart(P, s, th, t) {
  P.clear(th.bg);
  const m = margin(P);
  const top = heading(P, th, s.title, t) + 30 * P.u;
  const box = { x: m + 60 * P.u, y: top, w: P.W - 2 * m - 60 * P.u, h: P.H - top - m - 40 * P.u };
  const all = s.chart.series.flatMap((x) => x.values);
  const hi = Math.max(1e-9, all.reduce((a, b) => Math.max(a, b), 0));
  const lo = all.reduce((a, b) => Math.min(a, b), 0);
  const y = (v) => box.y + box.h - ((v - lo) / (hi - lo || 1)) * box.h;
  P.line([[box.x, y(0)], [box.x + box.w, y(0)]], th.muted, 2 * P.u, 0.6);
  const slot = box.w / s.chart.labels.length;
  s.chart.labels.forEach((l, i) => P.text(l, box.x + slot * i, box.y + box.h + 10 * P.u, { size: 18 * P.u, color: th.muted, width: slot, align: "center" }));
  if (s.chart.kind === "line") lineSeries(P, s, t, { box, y, slot });
  else barSeries(P, s, th, t, { box, y, slot });
  legend(P, s, th, box);
}

function barSeries(P, s, th, t, { y, box, slot }) {
  const n = s.chart.series.length;
  const bw = (slot * 0.7) / n;
  s.chart.series.forEach((ser, k) => ser.values.forEach((v, i) => {
    const p = stagger(t, i, { start: 0.6 + k * 0.15, gap: 0.08, dur: 0.8 });
    const top = lerp(y(0), y(v), p);
    const x = box.x + slot * i + slot * 0.15 + bw * k;
    P.rect(x, Math.min(top, y(0)), bw * 0.92, Math.abs(y(0) - top), PALETTE[k % PALETTE.length]);
    if (p > 0.05 && v !== 0) P.text(grouped(v * p), x - 20 * P.u, Math.min(top, y(0)) - 26 * P.u, { size: 16 * P.u, color: th.fg, width: bw + 40 * P.u, align: "center" }, { alpha: p });
  }));
}

function lineSeries(P, s, t, { y, box, slot }) {
  const p = enter(t, 0.6, 1.6);
  s.chart.series.forEach((ser, k) => {
    const pts = ser.values.map((v, i) => [box.x + slot * (i + 0.5), y(v)]);
    const color = PALETTE[k % PALETTE.length];
    P.clip(box.x - 10, box.y - 20 * P.u, (box.w + 20) * p, box.h + 40 * P.u, () => P.line(pts, color, 5 * P.u));
    pts.forEach((q, i) => P.circle(q[0], q[1], 8 * P.u * stagger(t, i, { start: 0.6, gap: 1.6 / pts.length, dur: 0.3, curve: ease.outBack }), color));
  });
}

function legend(P, s, th, box) {
  if (s.chart.series.length < 2 && !s.chart.unit) return;
  let x = box.x;
  const yy = box.y - 34 * P.u;
  if (s.chart.unit) x += P.text(`(${s.chart.unit})`, x, yy, { size: 16 * P.u, color: th.muted }).w + 24 * P.u;
  if (s.chart.series.length < 2) return;
  s.chart.series.forEach((ser, k) => {
    P.rect(x, yy + 4 * P.u, 16 * P.u, 16 * P.u, PALETTE[k % PALETTE.length]);
    x += 24 * P.u + P.text(ser.name, x + 24 * P.u, yy, { size: 16 * P.u, color: th.fg }).w + 24 * P.u;
  });
}

/** A big number that rolls from `from` to `to`, its label above and unit after. */
function count(P, s, th, t) {
  P.clear(th.bg);
  const v = counter(t, s.from, s.to, 0.4, Math.max(0.8, s.duration - 1.2));
  const num = `${grouped(v)}${s.unit ? ` ${s.unit}` : ""}`;
  const size = 120 * P.u;
  const m = P.measure(num, { size, bold: true });
  if (s.label) P.text(s.label, 0, P.H / 2 - size * 0.9, { size: 30 * P.u, color: th.muted, width: P.W, align: "center" }, { alpha: enter(t, 0.1) });
  P.text(num, (P.W - m.w) / 2, P.H / 2 - size * 0.45, { size, bold: true, color: th.fg }, { alpha: enter(t, 0.2) });
  P.rect((P.W - m.w) / 2, P.H / 2 + size * 0.85, m.w * enter(t, 0.4, 1), 6 * P.u, th.accent);
}

/** A name strap: the accent plate leads, the dark bar follows, the name rises inside it, then all rewind out. */
function lowerthird(P, s, th, t) {
  if (s.image) P.image(s.image, { x: 0, y: 0, w: P.W, h: P.H }, { zoom: lerp(1, 1.06, t / s.duration) });
  else P.clear(th.bg);
  const out = smooth((t - (s.duration - 0.7)) / 0.6);
  const m = margin(P);
  const nameSize = 34 * P.u;
  const name = P.measure(s.name, { size: nameSize, bold: true });
  const role = s.role ? P.measure(s.role, { size: 20 * P.u }) : { w: 0, h: 0 };
  const w = Math.max(name.w, role.w) + 60 * P.u;
  const h = name.h + role.h + 40 * P.u;
  const y = P.H - m - h;
  const plate = enter(t, 0.2, 0.5) * (1 - out);
  const bar = enter(t, 0.35, 0.55) * (1 - out);
  P.rect(m - 12 * P.u, y, 12 * P.u + w * plate, h, th.accent);
  P.rect(m, y, w * bar, h, th.ink, 0.92);
  P.clip(m, y, w * bar, h, () => {
    const rise = enter(t, 0.6, 0.5) * (1 - out);
    P.text(s.name, m + 30 * P.u, y + 18 * P.u + (1 - rise) * h, { size: nameSize, bold: true, color: "FFFFFF" });
    if (s.role) P.text(s.role, m + 30 * P.u, y + 22 * P.u + name.h + (1 - enter(t, 0.8, 0.5) * (1 - out)) * h, { size: 20 * P.u, color: th.muted });
  });
  P.rect(m + 30 * P.u, y + h - 12 * P.u, name.w * enter(t, 1.0, 0.5) * (1 - out), 4 * P.u, th.accent);
}

function quote(P, s, th, t) {
  P.clear(th.bg);
  const m = margin(P);
  const pop = stagger(t, 0, { start: 0.1, dur: 0.6, curve: ease.outBack });
  P.text("“", m, P.H * 0.18, { size: 160 * P.u, bold: true, color: th.accent }, { alpha: clamp(pop), scale: lerp(0.4, 1, clamp(pop)) });
  const a = enter(t, 0.5, 0.8);
  const h = P.text(s.quote, m + 20 * P.u, P.H * 0.36 + (1 - a) * 30 * P.u, { size: 44 * P.u, bold: true, color: th.fg, width: P.W - 2 * m - 40 * P.u }, { alpha: a }).h;
  if (s.by) P.text(`- ${s.by}`, m, P.H * 0.36 + h + 30 * P.u, { size: 26 * P.u, color: th.muted, width: P.W - 2 * m, align: "right" }, { alpha: enter(t, 1.2) });
}

function image(P, s, th, t) {
  P.clear("000000");
  const k = t / s.duration;
  const opts = s.motion === "pan" ? { zoom: 1.12, pan: lerp(-1, 1, k) } : { zoom: lerp(1, 1.1, k) };
  P.image(s.image, { x: 0, y: 0, w: P.W, h: P.H }, opts);
  if (!s.caption) return;
  const m = margin(P);
  const a = enter(t, 0.4);
  const size = 26 * P.u;
  const c = P.measure(s.caption, { size, width: P.W - 2 * m - 40 * P.u });
  P.rect(m, P.H - m - c.h - 30 * P.u, Math.min(P.W - 2 * m, c.w + 40 * P.u), c.h + 30 * P.u, th.ink, 0.8 * a);
  P.text(s.caption, m + 20 * P.u, P.H - m - c.h - 15 * P.u, { size, color: "FFFFFF", width: P.W - 2 * m - 40 * P.u }, { alpha: a });
}

/** Credits rolling up from below the frame to above it over the scene. */
function credits(P, s, th, t) {
  P.clear(th.bg);
  const size = 30 * P.u;
  const gap = size * 0.7;
  const items = [...(s.title ? [{ text: s.title, bold: true, size: size * 1.4 }] : []), ...s.lines.map((l) => ({ text: l, bold: false, size }))];
  const heights = items.map((it) => P.measure(it.text, { size: it.size, bold: it.bold, width: P.W * 0.8, align: "center" }).h);
  const total = heights.reduce((a, b) => a + b + gap, 0);
  let y = lerp(P.H, -total, clamp(t / s.duration));
  items.forEach((it, i) => {
    P.text(it.text, P.W * 0.1, y, { size: it.size, bold: it.bold, color: it.bold ? th.accent : th.fg, width: P.W * 0.8, align: "center" });
    y += heights[i] + gap;
  });
}

export const DRAW = { title, kinetic, bullets, chart, counter: count, lowerthird, quote, image, credits };
