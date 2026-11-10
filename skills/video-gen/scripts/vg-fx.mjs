// vg-fx.mjs: motion helpers for video-gen. Every value is a pure function of time t (seconds), so any frame can be
// drawn on its own and the same scene gives the same video.
//
// rand, clamp, lerp, smooth, ramp, ease and track are taken from aimotion (github.com/kstost/cokacmotion,
// skills/aimotion/demos/_lib/stage.js, commit c417b16), MIT License, Copyright (c) 2026 kstost; see
// vendor/aimotion/LICENSE.md. The rest is written here after techniques its demos describe (staggered entrances
// with an outBack overshoot, a stinger of staggered stripes, a counter whose digits roll).

/** mulberry32: same seed, same sequence, every run */
export function rand(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, k) => a + (b - a) * k;
export const smooth = (v) => {
  const c = clamp(v);
  return c * c * (3 - 2 * c);
};
/** 0 to 1 over [a, b] with smoothstep */
export const ramp = (t, a, b) => smooth((t - a) / (b - a));
export const ease = {
  inOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  outCubic: (p) => 1 - Math.pow(1 - p, 3),
  inCubic: (p) => p * p * p,
  outExpo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  outBack: (p, c = 1.7) => 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2),
};

/**
 * Keyframed values as a pure function of t: track([[t0, v0, ease?], [t1, v1, ease?], ...])(t). Each segment uses
 * the ease of its end key (default inOutCubic). Values may be numbers or number arrays.
 */
export function track(keys) {
  return (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [t1, v1, e] = keys[i];
      if (t <= t1) {
        const [t0, v0] = keys[i - 1];
        const p = (e || ease.inOutCubic)(clamp((t - t0) / Math.max(1e-9, t1 - t0)));
        return Array.isArray(v0) ? v0.map((a, j) => lerp(a, v1[j], p)) : lerp(v0, v1, p);
      }
    }
    return keys[keys.length - 1][1];
  };
}

/** Progress 0..1 of item i in a staggered entrance: starts at start + i * gap, lasts dur, eased. */
export function stagger(t, i, { start = 0, gap = 0.08, dur = 0.5, curve = ease.outCubic } = {}) {
  return curve(clamp((t - start - i * gap) / dur));
}

/** Enter at the start and leave before the end of a scene of length d: 0..1..0 with the given in/out times. */
export function life(t, d, fadeIn = 0.5, fadeOut = 0.4) {
  return Math.min(smooth(t / fadeIn), smooth((d - t) / fadeOut));
}

/**
 * A stinger: n stripes sweep across in a stair, cover the frame around the middle of dur, then leave the other way.
 * Returns each stripe's covered span [from, to] as fractions of the width (to > from while it shows).
 */
export function stripes(t, dur, n = 6) {
  const gap = dur * 0.06;
  const half = (dur - gap * (n - 1)) / 2;
  return Array.from({ length: n }, (_, i) => {
    const local = t - i * gap;
    const inP = ease.inOutCubic(clamp(local / half));
    const outP = ease.inOutCubic(clamp((local - half) / half));
    return [outP, inP];
  });
}

/** The value a counter shows at t: from -> to over [start, start + dur], whole numbers, eased out. */
export function counter(t, from, to, start, dur) {
  return Math.round(lerp(from, to, ease.outExpo(clamp((t - start) / dur))));
}

/** "1234567" -> "1,234,567" (negative numbers keep their sign). */
export const grouped = (n) => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
