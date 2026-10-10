/*
 * Scene-by-scene navigation for the scroll-world intro (opt-in: intro.json "stepNav").
 *
 * The vendored engine maps the window's scroll position to clip time and stays as shipped; this
 * script only moves the scroll position. One wheel gesture, arrow key, PageDown/PageUp, Space or a
 * swipe of more than 30 px moves exactly one scene; a route dot goes to its scene. Inputs during a
 * move keep the latest one, run when the move ends. Stops: the first scene at 0, middle scenes in
 * the middle of their hold, the last scene at the end of its clip, then the top of the page body
 * (`end`, when the intro sits on top of a site). Below the body top the browser scrolls as usual;
 * one up input at the body top returns to the last scene.
 *
 * Options (intro.json "stepNav", all optional; values are the defaults below):
 *   end            selector of the body start; omit on a standalone intro page
 *   gestureGapMs   a wheel pause longer than this, or a turn of direction, starts a new gesture
 *   minWheel       smaller |deltaY| is ignored (so are ctrl+wheel zoom and sideways wheels)
 *   swipePx        a touch swipe longer than this is one step
 *   durBaseMs, durPerVhMs, durMaxMs   a move takes min(durMax, durBase + distance in screen heights
 *                  x durPerVh) ms with a cosine ease; 0 under prefers-reduced-motion
 *   lastGuardMs    PROVISIONAL (still being verified where it came from): a down input queued on the
 *                  way into the last scene is dropped, and down is ignored this long after arriving
 *   prefetch       download every clip at load so the first move already plays video
 *   hintLabel, skipLabel, mainLabel   texts of the mouse hint, the skip link and the main button
 * The main button shows once the last clip has played to its end (arrival at the last stop; at
 * once under reduced motion, where the engine loads no clips) and only when `end` exists.
 *
 * Plain script (no module): sets window.IntroStepNav (and IntroStepNav.current, the navigation of
 * this page, after attach); under Node it exports the same functions so the logic is tested without
 * a browser (step-nav.test.mjs).
 */
'use strict';
// A block, not a function: its declarations stay out of the global scope (strict mode).
{

  const DEFAULTS = Object.freeze({
    end: null, gestureGapMs: 220, minWheel: 2, swipePx: 30,
    durBaseMs: 2600, durPerVhMs: 760, durMaxMs: 5600, lastGuardMs: 250, prefetch: true,
    hintLabel: 'Scroll or press the down key', skipLabel: 'Skip intro', mainLabel: 'Go to main content',
  });

  // ---- logic (tested under Node) ----------------------------------------------

  /** Stop positions in px, following the engine's segment layout (dive, then a connector if any). */
  function stopPositions(config, vh, endTop) {
    const sections = config.sections || [];
    const connectors = config.connectors || [];
    const dive = config.diveScroll || 1.3;
    const conn = config.connScroll || 0.9;
    let off = 0;
    const spans = sections.map(function (s, i) {
      const start = off;
      off += s.scroll || dive;
      const span = [start * vh, off * vh];
      if (i < sections.length - 1 && connectors[i]) off += conn;
      return span;
    });
    const stops = spans.map(function (span, i) {
      if (i === 0) return 0;
      return Math.round(i === spans.length - 1 ? span[1] : (span[0] + span[1]) / 2);
    });
    return endTop == null ? stops : stops.concat([endTop]);
  }

  function moveDuration(distance, vh, o, reduce) {
    if (reduce) return 0;
    return Math.min(o.durMaxMs, o.durBaseMs + (Math.abs(distance) / vh) * o.durPerVhMs);
  }

  /** Splits a wheel stream into gestures: feed(event, ms) is 'new', 'same' or 'ignore'. */
  function createWheelGesture(o) {
    let st = null;
    function reset(dir, mag, t) {
      st = { dir: dir, last: t, peak: mag, min: mag, falling: false };
      return 'new';
    }
    function falling(mag, t) {
      if (mag > Math.max(st.min * 2, st.min + 8)) return reset(st.dir, mag, t);
      st.min = Math.min(st.min, mag);
      return 'same';
    }
    function rising(mag) {
      if (mag < st.peak / 2) {
        st.falling = true;
        st.min = mag;
      } else st.peak = Math.max(st.peak, mag);
      return 'same';
    }
    return {
      feed: function (e, t) {
        const mag = Math.abs(e.deltaY || 0);
        if (e.ctrlKey || mag < o.minWheel || Math.abs(e.deltaX || 0) > mag) return 'ignore';
        const dir = Math.sign(e.deltaY);
        if (!st || dir !== st.dir || t - st.last > o.gestureGapMs) return reset(dir, mag, t);
        st.last = t;
        return st.falling ? falling(mag, t) : rising(mag);
      },
    };
  }

  const nearest = function (list, y) {
    let best = 0;
    list.forEach(function (v, i) { if (Math.abs(v - y) < Math.abs(list[best] - y)) best = i; });
    return best;
  };

  /**
   * Moves between stops. input('down' | 'up' | { to }) while idle starts a move; during a move it
   * replaces the queued input. move(fromY, toY, done) animates; onArrive(index) runs after each.
   */
  function createNavigator(opt) {
    let index = 0;
    let target = -1;
    let queued = null;
    let guardUntil = -Infinity;
    const list = function () { return opt.stops(); };
    function resolve(input) {
      const max = list().length - 1;
      const to = typeof input === 'object' ? input.to : index + (input === 'down' ? 1 : -1);
      return Math.max(0, Math.min(max, to));
    }
    function arrive(from, to) {
      index = to;
      target = -1;
      if (to === opt.lastScene && from < to) guardUntil = opt.now() + opt.guardMs;
      if (opt.onArrive) opt.onArrive(to);
      const next = queued;
      queued = null;
      if (next) go(next);
    }
    function go(input) {
      const to = resolve(input);
      if (to === index) return;
      if (input === 'down' && index === opt.lastScene && opt.now() < guardUntil) return;
      const from = index;
      target = to;
      opt.move(list()[from], list()[to], function () { arrive(from, to); });
    }
    return {
      input: function (input) {
        if (target === -1) return go(input);
        if (input === 'down' && target === opt.lastScene && target > index) return;
        queued = input;
      },
      sync: function (y) { if (target === -1) index = nearest(list(), y); },
      state: function () {
        const n = list().length;
        return { index: index, moving: target !== -1, queued: queued, atBody: n - 1 > opt.lastScene && index === n - 1 };
      },
    };
  }

  // ---- browser wiring -----------------------------------------------------------

  const ease = function (p) { return 0.5 - 0.5 * Math.cos(Math.PI * p); };

  function animate(from, to, duration, done) {
    const jump = function (y) { window.scrollTo({ top: y, behavior: 'instant' }); };
    if (duration <= 0) {
      jump(to);
      return done();
    }
    const t0 = performance.now();
    (function frame(t) {
      const p = Math.min(1, (t - t0) / duration);
      jump(from + (to - from) * ease(p));
      if (p < 1) requestAnimationFrame(frame);
      else done();
    })(t0);
  }

  const isMobile = function () {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches || window.matchMedia('(max-width: 860px)').matches;
  };

  /** The clip URLs the engine will fetch on this device, absolute. */
  function clipUrls(config) {
    const m = isMobile();
    const sections = config.sections || [];
    const conns = config.connectors || [];
    const connsM = config.connectorsMobile || [];
    const urls = sections.map(function (s) { return (m && s.clipMobile) || s.clip; })
      .concat(conns.map(function (c, i) { return (m && connsM[i]) || c; }));
    return urls.filter(Boolean).map(function (u) { return new URL(u, location.href).href; });
  }

  /**
   * Starts every clip download now and serves the engine's later fetch of the same URL from it, so
   * one URL is fetched once. Does nothing under reduced motion (the engine loads no clips then).
   */
  function prefetch(config, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    if (!o.prefetch || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const urls = new Set(clipUrls(config));
    const cache = new Map();
    const original = window.fetch.bind(window);
    const blobOf = function (url) {
      if (!cache.has(url)) {
        cache.set(url, original(url).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.blob();
        }).catch(function (e) { cache.delete(url); throw e; }));
      }
      return cache.get(url);
    };
    window.fetch = function (input, init) {
      const raw = typeof input === 'string' ? input : input && input.url;
      const url = raw ? new URL(raw, location.href).href : '';
      if (!urls.has(url) || (init && init.method && init.method !== 'GET')) return original(input, init);
      return blobOf(url).then(function (b) { return new Response(b, { status: 200, headers: { 'Content-Type': b.type } }); });
    };
    urls.forEach(function (u) { blobOf(u).catch(function () {}); });
  }

  function element(tag, cls, text) {
    const e = document.createElement(tag);
    e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function buildUi(o, hasEnd) {
    const hint = element('div', 'isn-hint');
    hint.setAttribute('aria-hidden', 'true');
    hint.appendChild(element('i', 'isn-hint__wheel'));
    hint.appendChild(element('i', 'isn-hint__key'));
    hint.appendChild(element('span', '', o.hintLabel));
    const skip = element('a', 'isn-skip', o.skipLabel);
    skip.href = o.end || '#';
    const main = element('button', 'isn-main', o.mainLabel);
    main.type = 'button';
    document.body.insertBefore(skip, document.body.firstChild);
    document.body.appendChild(hint);
    if (hasEnd) document.body.appendChild(main);
    return { hint: hint, skip: skip, main: main };
  }

  const editable = function (t) {
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  };
  const KEYS = { ArrowDown: 'down', PageDown: 'down', ArrowUp: 'up', PageUp: 'up' };
  function keyInput(e) {
    if (e.altKey || e.ctrlKey || e.metaKey || editable(e.target)) return null;
    if (e.key === ' ') return e.shiftKey ? 'up' : 'down';
    return KEYS[e.key] || null;
  }

  /** Wires the navigation to the page. Returns { goTo(i), state() } for scripts and checks. */
  function attach(world, config, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const ctx = makeContext(config, o);
    ctx.world = world;
    ctx.ui = buildUi(o, Boolean(ctx.endEl));
    listenWheel(ctx);
    listenKeys(ctx);
    listenTouch(ctx);
    listenClicks(ctx);
    listenScroll(ctx);
    ctx.nav.sync(window.scrollY);
    ctx.mark(ctx.nav.state().index);
    const handle = { goTo: function (i) { ctx.nav.input({ to: i }); }, state: function () { return ctx.nav.state(); },
      stops: ctx.stops, lastScene: ctx.lastScene, end: o.end };
    // The navigation on this page, for scripts and for verify-intro.mjs.
    window.IntroStepNav.current = handle;
    return handle;
  }

  function makeContext(config, o) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const endEl = o.end ? document.querySelector(o.end) : null;
    const lastScene = (config.sections || []).length - 1;
    const endTop = function () { return endEl ? Math.round(endEl.getBoundingClientRect().top + window.scrollY) : null; };
    const ctx = { o: o, endEl: endEl, lastScene: lastScene, focusEnd: false };
    ctx.stops = function () { return stopPositions(config, window.innerHeight, endTop()); };
    ctx.inIntro = function (y) { return !endEl || y < endTop() - 1; };
    ctx.atBodyTop = function (y) { return Boolean(endEl) && Math.abs(y - endTop()) <= 1; };
    ctx.mark = function (i) { mark(ctx, i); };
    ctx.nav = createNavigator({ stops: ctx.stops, lastScene: lastScene, guardMs: o.lastGuardMs,
      now: function () { return performance.now(); }, onArrive: ctx.mark,
      move: function (from, to, done) { animate(from, to, moveDuration(to - from, window.innerHeight, o, reduce), done); } });
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    document.documentElement.classList.add('isn-on', fine ? 'isn-mouse' : 'isn-touch');
    return ctx;
  }

  // Classes the CSS reads: isn-last at the last scene; isn-ready once its clip has played to the end
  // (the scroll stands at the last stop; under reduced motion that stop is reached at once and the
  // engine plays no clip); isn-body at or below the body top. Moves focus to the body after the skip
  // link or the main button.
  function mark(ctx, i) {
    const c = document.documentElement.classList;
    const atEnd = Math.abs(window.scrollY - ctx.stops()[ctx.lastScene]) <= 1;
    c.toggle('isn-last', i === ctx.lastScene);
    c.toggle('isn-ready', Boolean(ctx.endEl) && i === ctx.lastScene && atEnd);
    c.toggle('isn-body', i > ctx.lastScene);
    if (ctx.focusEnd && i > ctx.lastScene) {
      ctx.focusEnd = false;
      if (!ctx.endEl.hasAttribute('tabindex')) ctx.endEl.setAttribute('tabindex', '-1');
      ctx.endEl.focus({ preventScroll: true });
    }
  }

  // Whether an input in direction `dir` at scroll `y` belongs to the intro (else the browser scrolls).
  const ours = function (ctx, y, dir) { return ctx.inIntro(y) || (ctx.atBodyTop(y) && dir === 'up'); };

  function step(ctx, dir) {
    ctx.nav.sync(window.scrollY);
    ctx.nav.input(dir);
  }

  function listenWheel(ctx) {
    const gesture = createWheelGesture(ctx.o);
    window.addEventListener('wheel', function (e) {
      const dir = e.deltaY > 0 ? 'down' : 'up';
      if (!ours(ctx, window.scrollY, dir)) return;
      e.preventDefault();
      if (gesture.feed(e, e.timeStamp) === 'new') step(ctx, dir);
    }, { passive: false });
  }

  function listenKeys(ctx) {
    window.addEventListener('keydown', function (e) {
      const dir = keyInput(e);
      if (!dir || !ours(ctx, window.scrollY, dir)) return;
      e.preventDefault();
      if (!e.repeat) step(ctx, dir);
    });
  }

  function listenTouch(ctx) {
    let y0 = null;
    window.addEventListener('touchstart', function (e) { y0 = e.touches.length === 1 ? e.touches[0].clientY : null; }, { passive: true });
    window.addEventListener('touchmove', function (e) {
      if (y0 === null) return;
      const dir = y0 - e.touches[0].clientY > 0 ? 'down' : 'up';
      if (ours(ctx, window.scrollY, dir)) e.preventDefault();
    }, { passive: false });
    window.addEventListener('touchend', function (e) {
      if (y0 === null) return;
      const dy = y0 - e.changedTouches[0].clientY;
      const dir = dy > 0 ? 'down' : 'up';
      y0 = null;
      if (Math.abs(dy) > ctx.o.swipePx && ours(ctx, window.scrollY, dir)) step(ctx, dir);
    }, { passive: true });
  }

  // Route dots and nav items go through the navigator, not the engine's own smooth scroll.
  function listenClicks(ctx) {
    document.addEventListener('click', function (e) {
      const hit = e.target.closest && e.target.closest('.sw-route__dot, .sw-nav__item');
      const dot = hit && ctx.world.contains(hit) ? hit : null;
      const toBody = e.target.closest && e.target.closest('.isn-skip, .isn-main');
      if (!dot && !toBody) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (dot) return step(ctx, { to: Array.prototype.indexOf.call(dot.parentNode.children, dot) });
      ctx.focusEnd = Boolean(ctx.endEl);
      step(ctx, { to: ctx.endEl ? ctx.stops().length - 1 : ctx.lastScene });
    }, true);
  }

  // Scrolling by other means (scrollbar, find in page, links) moves the navigator's place too.
  function listenScroll(ctx) {
    let queued = false;
    window.addEventListener('scroll', function () {
      if (queued || ctx.nav.state().moving) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        if (ctx.nav.state().moving) return;
        ctx.nav.sync(window.scrollY);
        ctx.mark(ctx.nav.state().index);
      });
    }, { passive: true });
  }

  const api = {
    DEFAULTS: DEFAULTS, stopPositions: stopPositions, moveDuration: moveDuration, createWheelGesture: createWheelGesture,
    createNavigator: createNavigator, prefetch: prefetch, attach: attach,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.IntroStepNav = api;
}
