// presentation-graphic-gen engine: scenes, one master timeline on the browser's Web Animations API (WAAPI), and the
// key / click controller. One key press = one step. No third-party animation library.
//
//   Deck.scene(def)   registers a scene (one file per section, see the scene API below)
//   Deck.boot()       waits for the fonts, builds every scene and the timeline, then starts (the build calls it last)
//   Deck.rand(seed)   seeded random numbers in [0, 1) (scenes must not use Math.random)
//
// Timeline model (why it is safe to seek anywhere):
//   - Helpers declare segments { element, channel, from, to, t0, t1, easing } in master-timeline seconds.
//     Channels are opacity and the individual transform properties translate (x, y), scale (x, y) and rotate.
//     These four CSS properties compose independently, so a fade and a move on one element never fight.
//   - All segments of one element and one channel are merged into ONE keyframe track spanning the whole timeline
//     (hold keyframes between segments, the segment's easing on its start keyframe). This avoids the WAAPI trap
//     where a later animation of the same property with fill 'backwards' / 'both' overrides an earlier one before
//     it starts. Segments of one element and channel may not overlap in time (build error).
//   - Each track becomes one Animation that is never played: master time t is applied by setting currentTime on
//     every Animation (seek). Playing a step is one requestAnimationFrame clock that seeks forward; the step's end
//     is reached by an exact seek to its end time, so "jump to step i" and "play step i" end in the same state.
//   - Screen state comes only from keyframes: no finish / ready callbacks change anything.
// window.__CFG = { mode: 'review' | 'present' }. Data: #deck-data (script), #asset-data (images as data URLs).
(() => {
  'use strict';
  const defs = {};
  const Deck = (window.Deck = { scene, boot, rand: seeded });
  function scene(def) { defs[def.section] = def; }

  // mulberry32: small seeded generator, the same sequence on every load
  function seeded(seed) {
    let a = (Number(seed) >>> 0) || 1;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const $ = (s, r = document) => r.querySelector(s);
  const pad2 = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  // ---------- motion vocabulary ----------
  // Deceleration easing, no bounce. Short moves 0.3-0.4 s, slow ones 0.6-1 s.
  const EASES = {
    linear: 'linear',
    out: 'cubic-bezier(0.33, 1, 0.68, 1)',
    out3: 'cubic-bezier(0.22, 1, 0.36, 1)',
    soft: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
    in: 'cubic-bezier(0.32, 0, 0.67, 0)',
    inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
  };
  const D = 0.4, XF = 0.25, MIN_STEP = 0.3, EPS = 1e-6;
  const SAFE = { l: 160, r: 1760, t: 120, b: 960 };
  function easing(name, where) {
    if (name == null) return EASES.out;
    if (Object.hasOwn(EASES, name)) return EASES[name];
    if (/^cubic-bezier\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\)$/.test(name)) return name;
    throw new Error(`${where}: unknown easing "${name}" (use ${Object.keys(EASES).join(', ')} or cubic-bezier(...))`);
  }

  // ---------- timeline: segments per element and channel ----------
  // property -> [channel, component index]; 'scale' sets both scale components
  const PROPS = { x: ['translate', 0], y: ['translate', 1], scaleX: ['scale', 0], scaleY: ['scale', 1], rotate: ['rotate', 0], opacity: ['opacity', 0] };
  const SIZE = { opacity: 1, translate: 2, scale: 2, rotate: 1 };
  const CSSV = {
    opacity: (v) => ({ opacity: String(v[0]) }),
    translate: (v) => ({ translate: `${v[0]}px ${v[1]}px` }),
    scale: (v) => ({ scale: `${v[0]} ${v[1]}` }),
    rotate: (v) => ({ rotate: `${v[0]}deg` }),
  };
  let tracks = new Map(); // element -> { channel: [segment] }
  const focusLog = []; // { key, sec, target, fx, t, pad }: which target each focus group marks from time t (check.mjs reads it)
  let anims = [];
  let duration = 0, time = 0;

  function desc(e) {
    const sc = e.closest && e.closest('.scene');
    const name = e.dataset && e.dataset.r ? `"${e.dataset.r}"` : `<${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? ' .' + e.className.trim().split(/\s+/).join('.') : ''}>`;
    return `scene ${sc ? sc.dataset.section : '?'} ${name}`;
  }
  // {x: 1, opacity: 0} -> { translate: {0: 1}, opacity: {0: 0} }
  function byChannel(vals, e) {
    const out = {};
    if (!vals) return out;
    for (const k of Object.keys(vals)) {
      const v = vals[k];
      if (k === 'scale') {
        if (!Number.isFinite(v)) throw new Error(`${desc(e)}: scale must be a finite number, got ${JSON.stringify(v)}`);
        out.scale = Object.assign(out.scale || {}, { 0: v, 1: v });
        continue;
      }
      if (!Object.hasOwn(PROPS, k)) {
        throw new Error(`${desc(e)}: "${k}" cannot be animated; only x, y, scale, scaleX, scaleY, rotate and opacity (numbers) can`);
      }
      if (!Number.isFinite(v)) throw new Error(`${desc(e)}: ${k} must be a finite number, got ${JSON.stringify(v)}`);
      const [ch, i] = PROPS[k];
      (out[ch] = out[ch] || {})[i] = v;
    }
    return out;
  }
  function addSeg(e, from, to, t, dur, ease) {
    if (!(e instanceof Element)) throw new Error('animate: not an element');
    if (!(dur >= 0) || !Number.isFinite(t)) throw new Error(`${desc(e)}: bad time ${t} / duration ${dur}`);
    const f = byChannel(from, e), z = byChannel(to, e);
    const ez = easing(ease, desc(e));
    const tr = tracks.get(e) || {};
    tracks.set(e, tr);
    for (const ch of Object.keys(z)) {
      (tr[ch] = tr[ch] || []).push({ t0: t, t1: t + dur, from: f[ch] || null, to: z[ch], ease: ez, n: tr[ch].length });
    }
    return t + dur;
  }
  function baseValue(e, ch) {
    if (ch === 'opacity') return [parseFloat(getComputedStyle(e).opacity)];
    return ch === 'scale' ? [1, 1] : ch === 'translate' ? [0, 0] : [0];
  }
  // segments of a channel in time order with full from / to vectors; overlap is an error
  function resolve(e, ch) {
    const segs = ((tracks.get(e) || {})[ch] || []).slice().sort((a, b) => a.t0 - b.t0 || a.n - b.n);
    let state = baseValue(e, ch), prev = null;
    const out = [];
    for (const s of segs) {
      if (prev && s.t0 < prev.t1 - EPS) {
        throw new Error(`${desc(e)}: two ${ch} animations overlap (${prev.t0.toFixed(2)}-${prev.t1.toFixed(2)} s and ${s.t0.toFixed(2)}-${s.t1.toFixed(2)} s); move one to a parent layer or change its time`);
      }
      const from = state.slice();
      if (s.from) for (const i in s.from) from[i] = s.from[i];
      const to = from.slice();
      for (const i in s.to) to[i] = s.to[i];
      out.push({ t0: s.t0, t1: s.t1, from, to, ease: s.ease });
      state = to;
      prev = s;
    }
    return { segs: out, base: baseValue(e, ch) };
  }
  function makeAnimations(total) {
    const list = [];
    for (const [e, tr] of tracks) {
      for (const ch of Object.keys(tr)) {
        const { segs } = resolve(e, ch);
        if (!segs.length) continue;
        const kf = [];
        let last = segs[0].from, off = 0;
        const push = (t, v, ez) => {
          off = Math.min(1, Math.max(off, t / total));
          kf.push(Object.assign({ offset: off, easing: ez }, CSSV[ch](v)));
        };
        push(0, last, 'linear');
        for (const s of segs) {
          push(s.t0, last, 'linear'); // hold the previous value up to this segment
          push(s.t0, s.from, s.ease);
          push(s.t1, s.to, 'linear');
          last = s.to;
        }
        push(total, last, 'linear');
        kf[kf.length - 1].offset = 1;
        const a = new Animation(new KeyframeEffect(e, kf, { duration: total * 1000, fill: 'both', easing: 'linear' }), document.timeline);
        a.currentTime = 0;
        list.push(a);
      }
    }
    return list;
  }
  function seekRaw(t) {
    time = Math.max(0, Math.min(duration, t));
    const ms = time * 1000;
    for (const a of anims) a.currentTime = ms;
  }

  // theme: dark unless ?theme=light (colors are CSS variables, so nothing is rebuilt); set before anything paints
  document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';

  // ---------- data ----------
  const DATA = JSON.parse($('#deck-data').textContent);
  const ASSETS = JSON.parse(($('#asset-data') || { textContent: '{}' }).textContent);
  const STEPS = DATA.steps;
  const N = STEPS.length;
  const byId = Object.fromEntries(STEPS.map((s) => [s.id, s]));
  const stage = $('#stage');
  const stageScale = () => stage.getBoundingClientRect().width / 1920 || 1;

  // geometry relative to the scene root, ignoring transforms (stage px)
  const box4 = (x, y, w, h) => ({ x, y, w, h, cx: x + w / 2, cy: y + h / 2, r: x + w, b: y + h });
  function geom(e, root) {
    let x = 0, y = 0, n = e;
    while (n && n !== root) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    return box4(x, y, e.offsetWidth, e.offsetHeight);
  }
  // box of a client rect in stage px relative to the scene root (measured before any animation exists)
  function rectIn(r, root) {
    const R = root.getBoundingClientRect(), k = stageScale();
    return box4((r.left - R.left) / k, (r.top - R.top) / k, r.width / k, r.height / k);
  }
  // ink box of an element's text: union of the line boxes of its text nodes (not its block width)
  function inkGeom(e, root) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    const rg = document.createRange();
    for (let n; (n = walker.nextNode());) {
      if (!n.textContent.trim() || (n.parentElement && n.parentElement.closest('.acc-ink'))) continue;
      rg.selectNodeContents(n);
      for (const c of rg.getClientRects()) {
        if (c.width < 0.5 || c.height < 0.5) continue;
        l = Math.min(l, c.left); t = Math.min(t, c.top); r = Math.max(r, c.right); b = Math.max(b, c.bottom);
      }
    }
    if (l === Infinity) return geom(e, root);
    return rectIn({ left: l, top: t, width: r - l, height: b - t }, root);
  }

  function htmlData(sec) {
    return {
      esc,
      rand: seeded,
      asset: (name) => { if (!Object.hasOwn(ASSETS, name)) throw new Error(`asset ${name} not built`); return ASSETS[name]; },
      lines: (id) => (byId[id] ? byId[id].lines.slice() : []),
      step: (id) => byId[id],
      section: sec,
    };
  }

  // ---------- mounted parts (DOM built once, before any animation) ----------
  function mount(root) {
    // .dbox: four edges (plus a gap for the label) that draw by scale
    for (const b of root.querySelectorAll('.dbox')) {
      const w = b.offsetWidth, h = b.offsetHeight, th = 2;
      const lb = b.querySelector(':scope > .dbox-label');
      const l0 = lb ? lb.offsetLeft - 6 : 0, l1 = lb ? lb.offsetLeft + lb.offsetWidth + 6 : 0;
      const edge = (k, x, y, ew, eh, origin) => {
        const e = el('i', `dbox-e dbox-${k}`);
        Object.assign(e.style, { left: x + 'px', top: y + 'px', width: ew + 'px', height: eh + 'px', transformOrigin: origin });
        b.insertBefore(e, b.firstChild);
        return e;
      };
      // drawing order: from the label's right end clockwise back to its left end
      b._edges = [
        { e: edge('t1', l1, 0, w - l1, th, '0 50%'), axis: 'x', len: w - l1 },
        { e: edge('r', w - th, 0, th, h, '50% 0'), axis: 'y', len: h },
        { e: edge('b', 0, h - th, w, th, '100% 50%'), axis: 'x', len: w },
        { e: edge('l', 0, 0, th, h, '50% 100%'), axis: 'y', len: h },
      ];
      if (lb && l0 > 0) b._edges.push({ e: edge('t0', 0, 0, l0, th, '0 50%'), axis: 'x', len: l0 });
    }
    // .acc: an overlay copy of the text in the accent color (s.accent fades it)
    for (const a of root.querySelectorAll('.acc')) {
      if (a.querySelector(':scope > .acc-ink')) continue;
      const ink = el('span', 'acc-ink');
      ink.setAttribute('aria-hidden', 'true');
      ink.textContent = a.textContent;
      a.appendChild(ink);
    }
  }

  // The focus outline of a target: one absolutely positioned child covering the target's border box plus `pad`,
  // with the target's corner radius plus `pad`, so it keeps the target's shape. Made once per target (the first
  // pad wins). Only CSS values are read (position, radius, border width); no screen geometry.
  function focusFx(target, pad) {
    let fx = target.querySelector(':scope > .fx-focus');
    if (fx) return fx;
    const cs = getComputedStyle(target);
    if (cs.position === 'static') target.style.position = 'relative';
    const bw = parseFloat(cs.borderTopWidth) || 0, r = parseFloat(cs.borderTopLeftRadius) || 0;
    fx = el('i', 'fx-focus', target);
    fx.setAttribute('aria-hidden', 'true');
    Object.assign(fx.style, { inset: `${-(pad + bw)}px`, borderRadius: `${r + pad}px` });
    fx._pad = pad;
    return fx;
  }

  function placeholderDef(sec) {
    const steps = sec.ids.map((id) => byId[id]);
    return {
      section: sec.n, placeholder: true,
      html: () => `<div class="ph"><h2 class="ph-title">${esc(sec.n + '. ' + sec.name)}</h2>${
        steps.map((st) => `<div class="ph-step" data-r="${st.id}">${st.lines.map((b) => `<p>${esc(b)}</p>`).join('')}</div>`).join('')}</div>`,
      steps: Object.fromEntries(steps.map((st, k) => [st.id, (s) => {
        if (k) s.fadeOut(steps[k - 1].id, { dur: 0.2 });
        s.fadeUp(st.id, { at: k ? 0.15 : 0.1, y: 12 });
      }])),
    };
  }

  // ---------- step context: the scene API ----------
  function makeCtx(root, t0, links) {
    let end = t0;
    const at = (o) => t0 + ((o && o.at) || 0);
    const done = (t) => { end = Math.max(end, t); return t - t0; };
    const Q = (q) => {
      if (q == null) return [];
      if (Array.isArray(q)) return q.flatMap(Q);
      if (q instanceof Element) return [q];
      if (typeof q !== 'string') return [];
      const list = /^[\w-]+$/.test(q) ? root.querySelectorAll(`[data-r="${q}"]`) : root.querySelectorAll(q);
      if (!list.length) throw new Error(`scene ${root.dataset.section}: nothing matches "${q}"`);
      return [...list];
    };
    // runs fn(element, absoluteTime, index) for each match, staggered; returns the end (seconds from step start)
    const each = (q, o, fn) => {
      const els = Q(q);
      if (o && o.reverse) els.reverse();
      const gap = (o && o.stagger) || 0;
      let t = at(o);
      els.forEach((e, i) => { t = Math.max(t, fn(e, at(o) + i * gap, i)); });
      return done(t);
    };
    const tw = (e, from, to, t, dur, ease) => addSeg(e, from, to, t, dur, ease);
    const seg = (x1, y1, x2, y2, cls) => {
      // a straight connector piece, 3px thick, that draws from (x1, y1) toward (x2, y2)
      const e = el('i', 'link-seg' + (cls ? ' ' + cls : ''), links);
      const th = 3, h = y1 === y2;
      const x = Math.min(x1, x2) - (h ? 0 : th / 2), y = Math.min(y1, y2) - (h ? th / 2 : 0);
      Object.assign(e.style, {
        left: x + 'px', top: y + 'px',
        width: (h ? Math.abs(x2 - x1) + th / 2 : th) + 'px', height: (h ? th : Math.abs(y2 - y1) + th / 2) + 'px',
        transformOrigin: h ? (x2 >= x1 ? '0 50%' : '100% 50%') : (y2 >= y1 ? '50% 0' : '50% 100%'),
      });
      return { e, axis: h ? 'x' : 'y', len: Math.abs(x2 - x1) + Math.abs(y2 - y1) };
    };
    // draw pieces one after another, time split by length; returns the absolute end time
    const drawPieces = (pieces, t, dur, ease) => {
      const total = pieces.reduce((a, p) => a + p.len, 0) || 1;
      for (const p of pieces) {
        const d = (dur * p.len) / total, k = p.axis === 'x' ? 'scaleX' : 'scaleY';
        tw(p.e, { [k]: 0 }, { [k]: 1 }, t, d, ease || 'linear');
        t += d;
      }
      return t;
    };
    const api = {
      root,
      $: Q,
      el: (q) => Q(q)[0],
      geom: (q) => geom(Q(q)[0], root),
      ink: (q) => inkGeom(Q(q)[0], root),
      rand: seeded,
      // generic: from (null = current state) to `to`; keys x, y, scale, scaleX, scaleY, rotate, opacity (numbers)
      tween: (q, from, to, o = {}) => each(q, o, (e, t) => tw(e, from, to, t, o.dur != null ? o.dur : D, o.ease)),
      move: (q, to, o = {}) => each(q, o, (e, t) => tw(e, null, to, t, o.dur != null ? o.dur : 0.6, o.ease)),
      fadeUp: (q, o = {}) => each(q, o, (e, t) => tw(e, { opacity: 0, y: o.y != null ? o.y : 24 }, { opacity: 1, y: 0 }, t, o.dur || D, o.ease)),
      fadeIn: (q, o = {}) => each(q, o, (e, t) => tw(e, { opacity: 0 }, { opacity: 1 }, t, o.dur || D, o.ease)),
      fadeOut: (q, o = {}) => each(q, o, (e, t) => tw(e, null, { opacity: 0 }, t, o.dur || 0.3, o.ease || 'soft')),
      dim: (q, o = {}) => each(q, o, (e, t) => tw(e, null, { opacity: o.to != null ? o.to : 0.35 }, t, o.dur || 0.3, o.ease || 'soft')),
      // chips one by one; ring: a focus group name whose outline moves to the newest chip
      chips: (q, o = {}) => {
        const gap = o.stagger || 0.3;
        return each(q, Object.assign({}, o, { stagger: gap }), (e, t) => {
          const t1 = tw(e, { opacity: 0, y: o.y != null ? o.y : 14 }, { opacity: 1, y: 0 }, t, o.dur || 0.35, o.ease);
          if (o.ring) api.focus(o.ring, e, { at: t - t0, pad: o.pad, dur: Math.min(0.3, gap) });
          return t1;
        });
      },
      // table rows top to bottom; rows already shown do not move
      rows: (q, o = {}) => each(q, Object.assign({ stagger: 0.4 }, o), (e, t) => tw(e, { opacity: 0, y: o.y != null ? o.y : 12 }, { opacity: 1, y: 0 }, t, o.dur || 0.35, o.ease)),
      // an HTML bar draws itself by scale from its start (left or top; axis from its shape or o.axis)
      draw: (q, o = {}) => each(q, o, (e, t) => {
        const axis = o.axis || (e.offsetHeight > e.offsetWidth ? 'y' : 'x');
        e.style.transformOrigin = axis === 'y' ? '50% 0' : '0 50%';
        const k = axis === 'y' ? 'scaleY' : 'scaleX';
        return tw(e, { [k]: 0 }, { [k]: 1 }, t, o.dur || 0.5, o.ease || 'inOut');
      }),
      // connector from a to b. route 'h': right side of a to left side of b; 'v': bottom of a to top of b;
      // 'wrap': down from a, back left (to o.x), down and into b's left side (second row of a flow)
      connector: (a, b, o = {}) => {
        const A = geom(Q(a)[0], root), B = geom(Q(b)[0], root), g = o.gap != null ? o.gap : 16;
        let pieces, tip;
        if (o.route === 'v') {
          pieces = [seg(A.cx, A.b + g, A.cx, B.y - g)];
          tip = { x: A.cx, y: B.y - g, down: true };
        } else if (o.route === 'wrap') {
          const mid = o.mid != null ? o.mid : (A.b + B.y) / 2, x0 = o.x != null ? o.x : B.x - 56;
          pieces = [seg(A.cx, A.b + g, A.cx, mid), seg(A.cx, mid, x0, mid), seg(x0, mid, x0, B.cy), seg(x0, B.cy, B.x - g, B.cy)];
          tip = { x: B.x - g, y: B.cy };
        } else {
          pieces = [seg(A.r + g, A.cy, B.x - g, A.cy)];
          tip = { x: B.x - g, y: A.cy };
        }
        const t1 = drawPieces(pieces, at(o), o.dur || (o.route === 'wrap' ? 0.8 : 0.35), o.ease);
        if (o.arrow !== false) {
          const e = el('i', 'link-tip', links);
          e.innerHTML = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M5,3 L14,10 L5,17"/></svg>';
          Object.assign(e.style, { left: tip.x - 14 + 'px', top: tip.y - 10 + 'px', transformOrigin: '14px 10px', transform: tip.down ? 'rotate(90deg)' : 'none' });
          tw(e, { opacity: 0 }, { opacity: 1 }, t1 - 0.05, 0.15, 'linear');
        }
        return done(t1 + 0.1);
      },
      // a .dbox outline draws itself clockwise from its label, then the label rises in
      box: (q, o = {}) => each(q, o, (e, t) => {
        if (!e._edges) throw new Error(`${desc(e)}: s.box needs a .dbox element`);
        let t1 = drawPieces(e._edges, t, o.dur || 0.7, 'linear');
        const lb = e.querySelector(':scope > .dbox-label');
        if (lb) t1 = Math.max(t1, tw(lb, { opacity: 0, y: 8 }, { opacity: 1, y: 0 }, t + 0.2, 0.35));
        return t1;
      }),
      // strike-through left to right, then the element dims
      strike: (q, o = {}) => each(q, o, (e, t) => {
        e.classList.add('strike');
        const line = e.querySelector(':scope > .strike-line') || el('i', 'strike-line', e);
        const t1 = tw(line, { scaleX: 0 }, { scaleX: 1 }, t, 0.35, 'inOut');
        return tw(e, null, { opacity: o.to != null ? o.to : 0.4 }, t1 + 0.05, 0.3, 'soft');
      }),
      // focus: an accent outline that belongs to the target (one element, the target's own corner radius plus
      // the pad, sized by CSS, never measured or stretched) fades in with a small scale pop; the previous
      // target's outline of the same group fades out. `group` is a name (an old .ring element works too);
      // target null hides the group's outline.
      focus: (group, target, o = {}) => {
        const key = typeof group === 'string' ? group : group instanceof Element ? group.dataset.r || 'focus' : 'focus';
        const t = at(o), dur = o.dur || 0.3;
        let prev = null;
        for (const f of focusLog) if (f.key === key && f.sec === root && f.t <= t + EPS) prev = f;
        const out = (fx) => tw(fx, null, { opacity: 0 }, t, Math.min(0.2, dur), 'soft');
        if (!target) {
          focusLog.push({ key, sec: root, target: null, fx: null, t, pad: 0 });
          return done(prev && prev.fx ? out(prev.fx) : t);
        }
        const tg = Q(target)[0], pad = o.pad != null ? o.pad : 10;
        const fx = focusFx(tg, pad);
        focusLog.push({ key, sec: root, target: tg, fx, t, pad: fx._pad });
        if (prev && prev.fx === fx) return done(t); // already on this target
        if (prev && prev.fx) out(prev.fx);
        tw(fx, { opacity: 0 }, { opacity: 1 }, t, dur, 'out');
        return done(tw(fx, { scale: o.pop != null ? o.pop : 1.06 }, { scale: 1 }, t, dur, 'out3'));
      },
      // big number, then its gray subline
      bigNumber: (num, sub, o = {}) => {
        const t1 = api.fadeUp(num, { at: o.at || 0, y: o.y || 16, dur: o.dur || 0.5 });
        const t2 = sub ? api.fadeUp(sub, { at: (o.at || 0) + (o.subAt != null ? o.subAt : 0.4), y: 8 }) : 0;
        return Math.max(t1, t2);
      },
      // accent: the .acc overlay (accent-colored copy) fades in (to 1) or out (to 0)
      accent: (q, o = {}) => each(q, o, (e, t) => {
        const ink = e.querySelector(':scope > .acc-ink');
        if (!ink) throw new Error(`${desc(e)}: s.accent needs class "acc" on the element`);
        return tw(ink, null, { opacity: o.to != null ? o.to : 1 }, t, o.dur || 0.3, 'soft');
      }),
      // fill in the blank: the hatch fades, the word rises into the slot
      fill: (blank, word, o = {}) => {
        const b = Q(blank)[0];
        const hatch = b.querySelector(':scope > .blank-hatch') || b;
        const t1 = tw(hatch, null, { opacity: 0 }, at(o), 0.3, 'soft');
        return done(Math.max(t1, tw(Q(word)[0], { opacity: 0, y: 16 }, { opacity: 1, y: 0 }, at(o) + 0.15, D)));
      },
      // accent underline sized to its text: the bar (class "ul", in the same parent layer as the text) is placed
      // under the text's ink box, overhanging it by `pad` each side (clamped to the safe area, never narrower than
      // the ink), then drawn from the left. One call per bar.
      underline: (bar, text, o = {}) => {
        const b = Q(bar)[0], tx = Q(text)[0];
        const pad = o.pad != null ? o.pad : 8;
        const g = inkGeom(tx, root);
        const op = b.offsetParent && root.contains(b.offsetParent) ? rectIn(b.offsetParent.getBoundingClientRect(), root) : { x: 0, y: 0 };
        const x0 = Math.min(g.x, Math.max(SAFE.l, g.x - pad)), x1 = Math.max(g.r, Math.min(SAFE.r, g.r + pad));
        b.style.left = (x0 - op.x).toFixed(2) + 'px';
        b.style.width = (x1 - x0).toFixed(2) + 'px';
        b.style.top = (g.b + (o.gap != null ? o.gap : 4) - op.y).toFixed(2) + 'px';
        b.style.right = 'auto';
        b.dataset.ul = b.dataset.ul || `ul${root.querySelectorAll('[data-ul]').length + 1}`;
        tx.dataset.ulText = b.dataset.ul;
        return done(tw(b, { scaleX: 0 }, { scaleX: 1 }, at(o), o.dur || 0.4, o.ease || 'out'));
      },
      // small title: slides in from 12px left with a fade
      kicker: (q, o = {}) => each(q, o, (e, t) => tw(e, { opacity: 0, x: -12 }, { opacity: 1, x: 0 }, t, o.dur || 0.3, o.ease || 'out3')),
      // wipe reveal from a side ('left' default, 'right', 'top', 'bottom'): the element is the window and its
      // single child the content; they move in opposite directions by the same eased amount, so the content
      // stays put while the window opens
      reveal: (q, o = {}) => each(q, o, (e, t) => {
        const inner = e.firstElementChild;
        if (!inner || e.children.length !== 1) throw new Error(`${desc(e)}: s.reveal needs exactly one child element`);
        e.classList.add('wipe');
        const w = e.offsetWidth, h = e.offsetHeight;
        const v = { left: ['x', -w], right: ['x', w], top: ['y', -h], bottom: ['y', h] }[o.from || 'left'];
        if (!v) throw new Error(`${desc(e)}: reveal from "${o.from}"`);
        const [k, d] = v, dur = o.dur || 0.6, ez = o.ease || 'out';
        tw(e, { opacity: 0 }, { opacity: 1 }, t, 0);
        tw(e, { [k]: d }, { [k]: 0 }, t, dur, ez);
        return tw(inner, { [k]: -d }, { [k]: 0 }, t, dur, ez);
      }),
      // in-place swap of one short line: a shrinks and fades out, b grows in at the same spot
      swap: (a, b, o = {}) => {
        const t = at(o);
        let t1 = t;
        for (const e of Q(a)) { tw(e, null, { opacity: 0 }, t, 0.14, 'in'); t1 = Math.max(t1, tw(e, null, { scale: 0.96 }, t, 0.14, 'in')); }
        for (const e of Q(b)) { tw(e, { opacity: 0 }, { opacity: 1 }, t + 0.08, 0.28, 'out3'); t1 = Math.max(t1, tw(e, { scale: 0.94 }, { scale: 1 }, t + 0.08, 0.28, 'out3')); }
        return done(t1);
      },
      // highlight box sweeps in behind a key word; the text and its neighbors do not move
      mark: (q, o = {}) => each(q, o, (e, t) => {
        e.classList.add('mk');
        let box = e.querySelector(':scope > .mk-box');
        if (!box) { box = el('i', 'mk-box'); e.insertBefore(box, e.firstChild); }
        return tw(box, { scaleX: 0 }, { scaleX: 1 }, t, o.dur || 0.4, o.ease || 'out');
      }),
      // keep the step at least this long (seconds from the step start)
      hold: (sec) => done(t0 + sec),
      get end() { return end - t0; },
    };
    return api;
  }

  // ---------- build: scenes, segments, animations ----------
  const steps = []; // { id, start, end }
  let error = null;

  function buildAll() {
    tracks = new Map();
    const style = el('style', '', document.head);
    const scenes = DATA.sections.map((sec) => {
      const def = defs[sec.n] || placeholderDef(sec);
      const keys = Object.keys(def.steps || {});
      if (keys.join(',') !== sec.ids.join(',')) throw new Error(`section ${sec.n}: step labels [${keys}] do not match the script [${sec.ids}]`);
      const root = el('section', `scene s${pad2(sec.n)}${def.placeholder ? ' is-placeholder' : ''}`, stage);
      root.dataset.section = String(sec.n);
      root.setAttribute('aria-label', `${sec.n}. ${sec.name}`);
      if (def.css) style.textContent += def.css + '\n';
      root.innerHTML = typeof def.html === 'function' ? def.html(htmlData(sec)) : def.html || '';
      return { sec, def, root };
    });
    // layout is final only now (all CSS in, fonts loaded)
    for (const sc of scenes) {
      mount(sc.root);
      sc.links = el('div', 'links', sc.root);
    }
    let prev = null, t = 0;
    for (const sc of scenes) {
      sc.sec.ids.forEach((id, k) => {
        const base = t;
        let t0 = base;
        if (k === 0) {
          if (prev) addSeg(prev.root, null, { opacity: 0 }, base, XF, 'linear');
          addSeg(sc.root, { opacity: 0 }, { opacity: 1 }, base, XF, 'linear');
          t0 = base + (prev ? 0.15 : 0);
        }
        const ctx = makeCtx(sc.root, t0, sc.links);
        sc.def.steps[id](ctx);
        t = Math.max(base + MIN_STEP, t0 + ctx.end, k === 0 ? base + XF : 0);
        steps.push({ id, start: base, end: t });
      });
      prev = sc;
    }
    duration = t;
    anims = makeAnimations(duration);
    seekRaw(0);
  }

  // ---------- controller ----------
  const REVIEW = window.__CFG && window.__CFG.mode === 'review';
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let idx = 0, playing = null, raf = 0;

  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; playing = null; }
  function frame(now) {
    raf = 0;
    if (!playing) return;
    if (playing.start == null) playing.start = now;
    const t = playing.from + (now - playing.start) / 1000;
    if (t >= playing.to - EPS) { const end = playing.to; playing = null; seekRaw(end); return; }
    seekRaw(t);
    raf = requestAnimationFrame(frame);
  }
  // how: 'play' (from the step's start to its end) or 'jump' (its end state at once)
  function enter(i, how, keepUrl) {
    i = Math.max(0, Math.min(N - 1, i | 0));
    stop();
    const near = Math.abs(idx - i) <= 1;
    idx = i;
    const s = steps[i];
    if (how === 'play' && !REDUCED) {
      seekRaw(s.start);
      playing = { from: s.start, to: s.end, start: null };
      raf = requestAnimationFrame(frame);
    } else seekRaw(s.end);
    paint(near, keepUrl);
  }
  function next() {
    if (playing) { const end = playing.to; stop(); seekRaw(end); return; } // finish the step, do not skip
    if (idx < N - 1) enter(idx + 1, 'play');
  }
  function prev() { if (playing || idx > 0) enter(idx - 1, 'jump'); }

  // ---------- review panel and timer ----------
  const items = [];
  function buildPanel() {
    const list = $('#p-list');
    if (!list) return;
    let lastSec = 0;
    STEPS.forEach((s, i) => {
      if (s.section !== lastSec) {
        lastSec = s.section;
        el('div', 'p-secname', list).textContent = `${s.section}. ${s.title}`;
      }
      const it = el('div', 'p-item', list);
      it.dataset.i = String(i);
      el('div', 'p-key', it).textContent = s.key;
      if (s.lines.length) el('div', 'p-screen', it).textContent = '화면: ' + s.lines.join(' / ');
      for (const d of s.directions || []) el('div', 'p-dir', it).textContent = `[${d}]`;
      el('div', 'p-speech', it).textContent = s.speech || '';
      it.addEventListener('click', (e) => { e.stopPropagation(); enter(i, 'jump'); });
      items.push(it);
    });
  }
  // every load starts at 00:00; nothing is stored
  const timer = (() => {
    let total = 0, last = performance.now(), sec = 0;
    const per = {};
    const fmt = (ms) => { const s = Math.floor(ms / 1000); return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60); };
    const tick = () => { const now = performance.now(), dt = now - last; last = now; total += dt; if (sec) per[sec] = (per[sec] || 0) + dt; };
    const paintT = () => {
      const tt = $('#tm-total'), ts = $('#tm-sec');
      if (tt) tt.textContent = `전체 ${fmt(total)}`;
      if (ts) {
        const s = DATA.sections.find((x) => x.n === sec);
        ts.textContent = s ? `${s.name} ${fmt(per[sec] || 0)}${s.target ? ' / ' + Math.floor(s.target / 60) + ':' + pad2(s.target % 60) : ''}` : '';
      }
    };
    return {
      run() { if (REVIEW) setInterval(() => { tick(); paintT(); }, 250); paintT(); },
      section(n) { tick(); sec = n; paintT(); },
      state() { tick(); return { total, per: Object.assign({}, per), sec }; },
    };
  })();

  function paint(near, keepUrl) {
    document.body.dataset.step = String(idx);
    timer.section(STEPS[idx].section);
    const ps = $('#p-sec'), pc = $('#p-count');
    if (ps) ps.textContent = `${STEPS[idx].section}. ${STEPS[idx].title}`;
    if (pc) pc.textContent = `${idx + 1} / ${N}`;
    items.forEach((it, i) => it.classList.toggle('cur', i === idx));
    const list = $('#p-list'), it = items[idx];
    if (list && it) list.scrollTo({ top: Math.max(0, it.offsetTop - list.clientHeight / 3), behavior: near ? 'smooth' : 'instant' });
    if (!keepUrl) { try { history.replaceState(null, '', '#' + idx); } catch (e) { /* some file URLs refuse */ } }
  }
  function parseHash() {
    const m = /^#(\d+)$/.exec(location.hash);
    return m ? Math.max(0, Math.min(N - 1, +m[1])) : null;
  }
  function fit() {
    const vp = $('#viewport');
    const w = vp.clientWidth, h = vp.clientHeight;
    const s = Math.min(w / 1920, h / 1080);
    stage.style.transform = `translate(${(w - 1920 * s) / 2}px, ${(h - 1080 * s) / 2}px) scale(${s})`;
  }
  function toggleFullscreen() {
    const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    if (p && p.catch) p.catch(() => { /* refused by the browser: nothing changes */ });
  }

  const NEXT = ['ArrowRight', 'ArrowDown', 'Enter', ' ', 'Spacebar', 'PageDown'];
  const PREV = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'];
  const isFsKey = (e) => e.key === 'Enter' && (e.altKey || e.shiftKey) && !e.ctrlKey && !e.metaKey;
  function bind() {
    window.addEventListener('resize', fit);
    window.addEventListener('hashchange', () => { const h = parseHash(); if (h != null && h !== idx) enter(h, 'jump'); });
    document.addEventListener('keydown', (e) => {
      if (isFsKey(e)) { e.preventDefault(); if (!e.repeat) toggleFullscreen(); return; } // before Enter = next
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (NEXT.includes(e.key)) { e.preventDefault(); if (!e.repeat) next(); }
      else if (PREV.includes(e.key)) { e.preventDefault(); prev(); }
      else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); document.body.classList.toggle('blanked'); }
    });
    document.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      if (REVIEW && !e.target.closest('#viewport')) return; // panel clicks only jump (item handler)
      next();
    });
  }

  function showError(msg) {
    error = msg;
    el('div', 'deck-error', stage).textContent = msg;
    console.error(msg);
  }

  // test / debug surface
  window.__deck = {
    N, ids: STEPS.map((s) => s.id), steps,
    get duration() { return duration; },
    get time() { return time; },
    get index() { return idx; },
    get animating() { return !!playing; },
    get error() { return error; },
    get reduced() { return !!REDUCED; },
    get blanked() { return document.body.classList.contains('blanked'); },
    get timer() { return timer.state(); },
    jump: (i) => enter(i, 'jump'),
    play: (i) => enter(i, 'play'),
    seek: (t) => { stop(); seekRaw(t); },
    next, prev,
    animationCount: () => anims.length,
    // the target each focus group marks at the current time (focus calls that started before now), with its
    // outline element (check.mjs reads it)
    focusTargets: () => {
      const now = new Map();
      for (const f of focusLog) if (f.t < time - EPS) now.set(f.sec.dataset.section + '/' + f.key, f);
      return [...now.values()].filter((f) => f.target).map((f) => ({ key: f.key, target: f.target, fx: f.fx, pad: f.pad }));
    },
  };

  function start() {
    fit();
    buildPanel();
    timer.run();
    try { buildAll(); } catch (e) { showError('scene build failed: ' + e.message); }
    bind();
    if (!error) {
      const h = parseHash();
      if (h != null) enter(h, 'jump'); else enter(0, 'play', true); // no hash: play step 1 once
    }
    document.documentElement.dataset.ready = '1';
  }
  // fonts first: layout measurements (underline width) need the final glyphs
  function boot() {
    const faces = ['400 40px "Deck Sans"', '700 40px "Deck Sans"', '400 40px "Deck Sans KR"', '700 40px "Deck Sans KR"'];
    const loads = Promise.all(faces.map((f) => document.fonts.load(f, '가A1'))).then(() => document.fonts.ready);
    let started = false;
    const go = () => { if (!started) { started = true; start(); } };
    loads.then(go, go);
    setTimeout(() => { if (!started) console.warn('fonts did not load in 8 s; starting anyway'); go(); }, 8000);
  }
})();
