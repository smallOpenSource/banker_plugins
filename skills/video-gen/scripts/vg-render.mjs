// vg-render.mjs: draws the timeline frame by frame with the bundled CanvasKit and writes the MP4 with the bundled
// H.264 encoder. A frame is a pure function of its time, so a still at any time matches the video.
import { loadEngine, mp4Writer } from "./vg-engine.mjs";
import { Painter } from "./vg-draw.mjs";
import { clamp, ease, smooth, stripes } from "./vg-fx.mjs";
import { DRAW } from "./vg-scenes.mjs";

const TRANSITION = 0.6;

/** The scene showing at global time T and its local time. */
export function sceneAt(model, T) {
  const i = model.scenes.findIndex((s) => T < s.start + s.duration);
  const k = i < 0 ? model.scenes.length - 1 : i;
  const s = model.scenes[k];
  return { k, s, t: Math.min(s.duration, Math.max(0, T - s.start)) };
}

function transitionOf(model, k, t) {
  const s = model.scenes[k];
  const prev = model.scenes[k - 1];
  if (!prev || s.transition === "cut") return null;
  const dur = Math.min(TRANSITION, prev.duration / 2, s.duration / 2);
  return t < dur ? { prev, p: t / dur, dur } : null;
}

function drawTransition(P, model, tr, s, t) {
  const th = model.theme;
  const drawPrev = () => DRAW[tr.prev.type](P, tr.prev, th, tr.prev.duration);
  const drawCur = () => DRAW[s.type](P, s, th, t);
  const p = ease.inOutCubic(tr.p);
  if (s.transition === "fade") {
    drawPrev();
    P.layer(p, drawCur);
  } else if (s.transition === "wipe") {
    drawPrev();
    P.clip(0, 0, P.W * p, P.H, drawCur);
    P.rect(P.W * p - 6 * P.u, 0, 6 * P.u, P.H, th.accent, 1 - Math.abs(2 * p - 1));
  } else {
    if (tr.p < 0.5) drawPrev();
    else drawCur();
    const band = P.H / 6;
    stripes(tr.p * tr.dur, tr.dur, 6).forEach(([a, b], i) => {
      if (b > a) P.rect(P.W * a, band * i, P.W * (b - a), band + 1, i % 2 ? th.ink : th.accent);
    });
  }
}

/** Draws the frame at global time T. */
export function drawFrame(P, model, T) {
  // A clean frame every time: nothing of the frame before may show through (a still and a video frame match).
  P.clear(model.theme.bg);
  const { k, s, t } = sceneAt(model, T);
  const tr = transitionOf(model, k, t);
  if (tr) drawTransition(P, model, tr, s, t);
  else DRAW[s.type](P, s, model.theme, t);
  const fade = smooth((T - (model.duration - 0.5)) / 0.5);
  if (fade > 0) P.rect(0, 0, P.W, P.H, model.theme.bg, clamp(fade));
}

async function withPainter(model, use) {
  const { CK, fonts } = await loadEngine();
  const surface = CK.MakeSurface(model.width, model.height);
  if (!surface) throw new Error("그림판(surface)을 만들지 못함");
  const P = new Painter(CK, fonts, surface.getCanvas(), model.width, model.height);
  try {
    return await use({ CK, surface, P });
  } finally {
    P.free();
    surface.delete();
  }
}

function pixels(CK, surface, w, h) {
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: w, height: h, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB });
  img.delete();
  return px;
}

/** Renders the whole timeline; returns { bytes, frames }. onFrame(i, n) is called after each frame. */
export function renderMp4(model, { quality = 20, speed = 5, onFrame } = {}) {
  return withPainter(model, async ({ CK, surface, P }) => {
    const out = await mp4Writer({ width: model.width, height: model.height, fps: model.fps, quality, speed });
    try {
      for (let i = 0; i < model.frames; i++) {
        drawFrame(P, model, i / model.fps);
        surface.flush();
        out.add(pixels(CK, surface, model.width, model.height));
        if (onFrame) onFrame(i + 1, model.frames);
      }
    } catch (e) {
      try {
        out.abort();
      } catch {
        // keep the error that stopped the render
      }
      throw e;
    }
    return out.finish();
  });
}

/**
 * Decodes every image of the timeline once with the engine, so a file that only looks like an image fails at
 * check time rather than minutes into a render. Returns error lines (empty when all decode).
 */
export async function probeImages(model) {
  const { CK } = await loadEngine();
  const errors = [];
  model.scenes.forEach((s, i) => {
    if (!s.image) return;
    const im = CK.MakeImageFromEncoded(s.image.data);
    if (!im || !(im.width() > 0)) errors.push(`scenes[${i}]: 그림을 풀지 못함 (${s.image.file})`);
    if (im) im.delete();
  });
  return errors;
}

/** Text that will not fit its place, measured with the bundled fonts. Returns warning lines. */
export function layoutWarnings(model) {
  return withPainter(model, ({ P }) => {
    const out = [];
    const m = Math.round(P.W * 0.08);
    model.scenes.forEach((s, i) => {
      const w = `scenes[${i}]`;
      if (s.type === "kinetic") {
        const size = (s.lines.length > 3 ? 56 : 76) * P.u;
        if (s.lines.some((l) => P.measure(l, { size, bold: true, width: 1e6 }).w > P.W * 0.92)) out.push(`${w}: 줄이 화면 너비를 넘음(줄을 나누십시오)`);
      }
      const head = s.title ? P.measure(s.title, { size: 44 * P.u, bold: true, width: P.W - 2 * m }).h : 0;
      if (["bullets", "chart"].includes(s.type) && head > 44 * P.u * 1.25 * 1.5) out.push(`${w}: 제목이 두 줄 이상이라 본문이 좁아짐`);
      if (s.type === "bullets") {
        const body = s.bullets.reduce((h, b) => h + P.measure(b, { size: 32 * P.u, width: P.W - 2 * m - 34 * P.u }).h + 16 * P.u, 0);
        if (m * 0.8 + head + 40 * P.u + body > P.H - m * 0.5) out.push(`${w}: 글머리가 화면 아래로 넘침`);
      }
    });
    return out;
  });
}

/** One frame at time T as PNG bytes. */
export function renderStill(model, T) {
  return withPainter(model, ({ surface, P }) => {
    drawFrame(P, model, Math.max(0, Math.min(model.duration, T)));
    surface.flush();
    const img = surface.makeImageSnapshot();
    const png = img.encodeToBytes();
    img.delete();
    return Buffer.from(png);
  });
}
