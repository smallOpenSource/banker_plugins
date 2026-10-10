/*
 * Scene-by-scene navigation for the scroll-world intro (opt-in: intro.json "stepNav").
 *
 * The vendored engine maps the window's scroll position to clip time and stays as shipped; this
 * script only moves the scroll position. One wheel gesture, arrow key, PageDown/PageUp, Space or a
 * swipe of more than 30 px moves exactly one scene; a route dot goes to its scene. Inputs during a
 * move keep the latest one, run when the move ends. Stops: the first scene at 0, middle scenes in
 * the middle of their hold, the last scene at the end of its clip, then the top of the page body
 * (`end`, when the intro sits on top of a site). Below the body top the browser scrolls as usual;
 * one up input at the body top returns to the last scene. A move starts from where the page stands.
 *
 * Options (intro.json "stepNav", all optional; values are the defaults below):
 *   end            selector of the body start; omit on a standalone intro page. It is looked up at
 *                  each input, so a body drawn after this script still counts; while it is missing
 *                  the page scrolls on past the last scene as usual (a warning is logged once)
 *   gestureGapMs   a wheel pause longer than this, or a turn of direction, starts a new gesture
 *   minWheel       smaller |deltaY| is left to the browser (so are ctrl+wheel zoom and sideways wheels)
 *   swipePx        a touch swipe longer than this is one step
 *   durBaseMs, durPerVhMs, durMaxMs   a move takes min(durMax, durBase + distance in screen heights
 *                  x durPerVh) ms with a cosine ease; 0 under prefers-reduced-motion
 *   lastGuardMs    PROVISIONAL (still being verified where it came from): a down input queued on the
 *                  way into the last scene is dropped, and down is ignored this long after arriving
 *   prefetch       download the clips at load so the first move already plays video; on a phone or
 *                  with Save-Data only the first three in playback order
 *   hintLabel, skipLabel, mainLabel   texts of the mouse hint, the skip link and the main button
 * The main button shows once the last clip has played to its end (the page stands at the last
 * stop; at once under reduced motion, where the engine loads no clips) and only with a body. The
 * skip link jumps without animation and moves the focus to the body.
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

  // The engine's segments in screen heights: a dive per section, then a connector where one exists.
  function spansOf(config) {
    const sections = config.sections || [];
    const connectors = config.connectors || [];
    const dive = config.diveScroll || 1.3;
    const conn = config.connScroll || 0.9;
    let off = 0;
    const spans = sections.map(function (s, i) {
      const start = off;
      off += s.scroll || dive;
      const span = [start, off];
      if (i < sections.length - 1 && connectors[i]) off += conn;
      return span;
    });
    return { spans: spans, total: off };
  }

  /** The scroll length of the segments in screen heights (the engine's track adds one screen). */
  function totalWeight(config) { return spansOf(config).total; }

  /** Stop positions in px: the first scene at 0, middle scenes mid-dive, the last at its end, then the body. */
  function stopPositions(config, vh, endTop) {
    const spans = spansOf(config).spans;
    const stops = spans.map(function (span, i) {
      if (i === 0) return 0;
      return Math.round((i === spans.length - 1 ? span[1] : (span[0] + span[1]) / 2) * vh);
    });
    return endTop == null ? stops : stops.concat([endTop]);
  }

  function moveDuration(distance, vh, o, reduce) {
    if (reduce) return 0;
    return Math.min(o.durMaxMs, o.durBaseMs + (Math.abs(distance) / vh) * o.durPerVhMs);
  }

  /** Zoom (ctrl+wheel, pinch), sideways and tiny wheels stay with the browser. */
  function wheelIgnored(e, o) {
    const mag = Math.abs(e.deltaY || 0);
    return Boolean(e.ctrlKey) || mag < o.minWheel || Math.abs(e.deltaX || 0) > mag;
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
        if (wheelIgnored(e, o)) return 'ignore';
        const mag = Math.abs(e.deltaY);
        const dir = Math.sign(e.deltaY);
        if (!st || dir !== st.dir || t - st.last > o.gestureGapMs) return reset(dir, mag, t);
        st.last = t;
        return st.falling ? falling(mag, t) : rising(mag);
      },
    };
  }

  /**
   * Whether an input belongs to the intro (else the browser scrolls): above the body top, or an up
   * input at it. Without a body element (none, or not drawn yet) the page scrolls on past the last
   * scene, so nothing below the intro is ever trapped.
   */
  function belongsToIntro(y, dir, lastStop, endTop) {
    const edge = endTop == null ? lastStop : endTop;
    return y < edge - 1 || (Math.abs(y - edge) <= 1 && dir === 'up');
  }

  const nearest = function (list, y) {
    let best = 0;
    list.forEach(function (v, i) { if (Math.abs(v - y) < Math.abs(list[best] - y)) best = i; });
    return best;
  };

  /**
   * Moves between stops. input('down' | 'up' | { to }) while idle starts a move from where the page
   * stands (sync(y)); during a move it replaces the queued input. move(fromY, toY, done) animates;
   * onArrive(index) runs after each move.
   */
  function createNavigator(opt) {
    let index = 0;
    let pos = 0;
    let target = -1;
    let queued = null;
    let guardUntil = -Infinity;
    const list = function () { return opt.stops(); };
    function resolve(input) {
      const stops = list();
      if (typeof input === 'object') return Math.max(0, Math.min(stops.length - 1, input.to));
      if (input === 'down') return stops.findIndex(function (v) { return v > pos + 1; });
      for (let i = stops.length - 1; i >= 0; i--) if (stops[i] < pos - 1) return i;
      return -1;
    }
    function arrive(from, to) {
      index = to;
      pos = list()[to];
      target = -1;
      if (to === opt.lastScene && from < to) guardUntil = opt.now() + opt.guardMs;
      if (opt.onArrive) opt.onArrive(to);
      const next = queued;
      queued = null;
      if (next) go(next);
    }
    function go(input) {
      const to = resolve(input);
      if (to < 0 || Math.abs(list()[to] - pos) <= 1) return;
      if (input === 'down' && index === opt.lastScene && opt.now() < guardUntil) return;
      const from = index;
      target = to;
      opt.move(pos, list()[to], function () { arrive(from, to); });
    }
    return {
      input: function (input) {
        if (target === -1) return go(input);
        if (input === 'down' && target === opt.lastScene && target > index) return;
        queued = input;
      },
      sync: function (y) {
        if (target !== -1) return;
        pos = y;
        index = nearest(list(), y);
      },
      state: function () {
        const n = list().length;
        return { index: index, moving: target !== -1, queued: queued, atBody: n - 1 > opt.lastScene && index === n - 1 };
      },
    };
  }

  // Fields and composite widgets keep every key; a focused button or link keeps Space (it presses).
  const role = function (t) { return (t && t.getAttribute && t.getAttribute('role')) || ''; };
  const editable = function (t) {
    return Boolean(t) && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')
      || /^(menu|menubar|listbox|slider|spinbutton|tablist|grid|tree|treegrid|combobox|textbox|radiogroup)$/.test(role(t)));
  };
  const pressable = function (t) {
    return Boolean(t) && (/^(BUTTON|A|SUMMARY)$/.test(t.tagName || '') || /^(button|link|checkbox|switch|menuitem|tab|option)$/.test(role(t)));
  };
  const KEYS = { ArrowDown: 'down', PageDown: 'down', ArrowUp: 'up', PageUp: 'up' };

  /** The step a key asks for, or null when the key is not the intro's. */
  function keyInput(e) {
    if (e.altKey || e.ctrlKey || e.metaKey || editable(e.target)) return null;
    if (e.key === ' ') return pressable(e.target) ? null : (e.shiftKey ? 'up' : 'down');
    return KEYS[e.key] || null;
  }

  // ---- browser wiring -----------------------------------------------------------

  const ease = function (p) { return 0.5 - 0.5 * Math.cos(Math.PI * p); };

  // Sets the scroll position at once ('instant' beats a site's scroll-behavior: smooth; an older
  // browser that does not know it takes the two-number form).
  function jump(y) {
    try { window.scrollTo({ top: y, behavior: 'instant' }); } catch (e) { window.scrollTo(0, y); }
  }

  function animate(from, to, duration, done) {
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

  /** The clip URLs the engine will fetch on this device, absolute, in playback order. */
  function clipUrls(config) {
    const m = isMobile();
    const sections = config.sections || [];
    const conns = config.connectors || [];
    const connsM = config.connectorsMobile || [];
    const urls = [];
    sections.forEach(function (s, i) {
      urls.push((m && s.clipMobile) || s.clip);
      if (i < sections.length - 1) urls.push((m && connsM[i]) || conns[i]);
    });
    return urls.filter(Boolean).map(function (u) { return new URL(u, location.href).href; });
  }

  const absolute = function (input) {
    try {
      const raw = typeof input === 'string' ? input : input && input.url;
      return raw ? new URL(raw, location.href).href : '';
    } catch (e) { return ''; }
  };

  /**
   * Starts the clip downloads now and serves the engine's later fetch of the same URL from them, so
   * one URL is fetched once. On a phone or with Save-Data only the first three clips start early.
   * Does nothing under reduced motion (the engine loads no clips then).
   */
  function prefetch(config, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    if (!o.prefetch || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const all = clipUrls(config);
    const urls = new Set(all);
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
      const url = absolute(input);
      if (!urls.has(url) || (init && init.method && init.method !== 'GET')) return original(input, init);
      return blobOf(url).then(function (b) { return new Response(b, { status: 200, headers: { 'Content-Type': b.type } }); });
    };
    const lean = isMobile() || Boolean(navigator.connection && navigator.connection.saveData);
    (lean ? all.slice(0, 3) : all).forEach(function (u) { blobOf(u).catch(function () {}); });
  }

  function element(tag, cls, text) {
    const e = document.createElement(tag);
    e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function buildUi(o) {
    const hint = element('div', 'isn-hint');
    hint.setAttribute('aria-hidden', 'true');
    hint.appendChild(element('i', 'isn-hint__wheel'));
    hint.appendChild(element('i', 'isn-hint__key'));
    hint.appendChild(element('span', '', o.hintLabel));
    const skip = element('a', 'isn-skip', o.skipLabel);
    skip.href = /^#[A-Za-z][\w-]*$/.test(o.end || '') ? o.end : '#';
    const main = element('button', 'isn-main', o.mainLabel);
    main.type = 'button';
    document.body.insertBefore(skip, document.body.firstChild);
    document.body.appendChild(hint);
    if (o.end) document.body.appendChild(main);
    return { hint: hint, skip: skip, main: main };
  }

  /** Wires the navigation to the page. Returns { goTo(i), state(), stops(), lastScene, end }. */
  function attach(world, config, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const ctx = makeContext(world, config, o);
    ctx.ui = buildUi(o);
    listenWheel(ctx);
    listenKeys(ctx);
    listenTouch(ctx);
    listenClicks(ctx);
    listenScroll(ctx);
    ctx.nav.sync(window.scrollY);
    ctx.mark(ctx.nav.state().index);
    const handle = { goTo: function (i) { ctx.nav.sync(window.scrollY); ctx.nav.input({ to: i }); },
      state: function () { return ctx.nav.state(); }, stops: ctx.stops, lastScene: ctx.lastScene, end: o.end };
    // The navigation on this page, for scripts and for verify-intro.mjs.
    window.IntroStepNav.current = handle;
    return handle;
  }

  function makeContext(world, config, o) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const lastScene = (config.sections || []).length - 1;
    const ctx = { o: o, world: world, lastScene: lastScene, focusEnd: false, warned: false };
    ctx.endEl = function () { return endElement(ctx); };
    ctx.endTop = function () { const e = ctx.endEl(); return e ? Math.round(e.getBoundingClientRect().top + window.scrollY) : null; };
    // The engine sizes its track (segments + one screen) from the height it last laid out at, so the
    // stops follow that height, not a URL-bar resize the engine ignored.
    ctx.vh = function () {
      const track = world.querySelector('.sw-track');
      const h = track ? track.getBoundingClientRect().height : 0;
      return h > 0 ? h / (totalWeight(config) + 1) : window.innerHeight;
    };
    ctx.stops = function () { return stopPositions(config, ctx.vh(), ctx.endTop()); };
    ctx.ours = function (y, dir) { return belongsToIntro(y, dir, ctx.stops()[lastScene], ctx.endTop()); };
    ctx.mark = function (i) { mark(ctx, i); };
    ctx.nav = createNavigator({ stops: ctx.stops, lastScene: lastScene, guardMs: o.lastGuardMs,
      now: function () { return performance.now(); }, onArrive: ctx.mark,
      move: function (from, to, done) { animate(from, to, moveDuration(to - from, ctx.vh(), o, reduce), done); } });
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    document.documentElement.classList.add('isn-on', fine ? 'isn-mouse' : 'isn-touch');
    return ctx;
  }

  // The body element, looked up each time; a configured one that is missing is logged once.
  function endElement(ctx) {
    if (!ctx.o.end) return null;
    const e = document.querySelector(ctx.o.end);
    if (!e && !ctx.warned) {
      ctx.warned = true;
      console.warn('IntroStepNav: no element matches ' + ctx.o.end + '; the page scrolls on past the last scene until it exists');
    }
    return e;
  }

  function focusBody(ctx) {
    const e = ctx.endEl();
    ctx.focusEnd = false;
    if (!e) return;
    if (!e.hasAttribute('tabindex')) e.setAttribute('tabindex', '-1');
    e.focus({ preventScroll: true });
  }

  // Classes the CSS reads: isn-last at the last scene; isn-ready once its clip has played to the end
  // (the page stands at the last stop; under reduced motion that stop is reached at once and the
  // engine plays no clip); isn-body at or below the body top. Moves the focus to the body after the
  // main button.
  function mark(ctx, i) {
    const c = document.documentElement.classList;
    const atEnd = Math.abs(window.scrollY - ctx.stops()[ctx.lastScene]) <= 1;
    c.toggle('isn-last', i === ctx.lastScene);
    c.toggle('isn-ready', Boolean(ctx.endEl()) && i === ctx.lastScene && atEnd);
    c.toggle('isn-body', i > ctx.lastScene);
    if (ctx.focusEnd && i > ctx.lastScene) focusBody(ctx);
  }

  function step(ctx, dir) {
    ctx.nav.sync(window.scrollY);
    ctx.nav.input(dir);
  }

  function listenWheel(ctx) {
    const gesture = createWheelGesture(ctx.o);
    window.addEventListener('wheel', function (e) {
      if (wheelIgnored(e, ctx.o)) return;
      const dir = e.deltaY > 0 ? 'down' : 'up';
      if (!ctx.ours(window.scrollY, dir)) return;
      e.preventDefault();
      if (gesture.feed(e, e.timeStamp) === 'new') step(ctx, dir);
    }, { passive: false });
  }

  function listenKeys(ctx) {
    window.addEventListener('keydown', function (e) {
      const dir = keyInput(e);
      if (!dir || !ctx.ours(window.scrollY, dir)) return;
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
      if (ctx.ours(window.scrollY, dir)) e.preventDefault();
    }, { passive: false });
    window.addEventListener('touchend', function (e) {
      if (y0 === null) return;
      const dy = y0 - e.changedTouches[0].clientY;
      const dir = dy > 0 ? 'down' : 'up';
      y0 = null;
      if (Math.abs(dy) > ctx.o.swipePx && ctx.ours(window.scrollY, dir)) step(ctx, dir);
    }, { passive: true });
  }

  // The skip link jumps at once (no animation to wait through) and hands the focus to the body; on a
  // standalone page it goes to the last scene.
  function skip(ctx) {
    const top = ctx.endTop();
    jump(top == null ? ctx.stops()[ctx.lastScene] : top);
    ctx.nav.sync(window.scrollY);
    ctx.mark(ctx.nav.state().index);
    focusBody(ctx);
  }

  // The main button moves to the body (focus follows on arrival), or focuses it when already there.
  function toBody(ctx) {
    ctx.nav.sync(window.scrollY);
    const st = ctx.nav.state();
    if (st.atBody) return focusBody(ctx);
    ctx.focusEnd = Boolean(ctx.endEl());
    ctx.nav.input({ to: ctx.stops().length - 1 });
  }

  // Route dots and nav items go through the navigator, not the engine's own smooth scroll.
  function listenClicks(ctx) {
    document.addEventListener('click', function (e) {
      const at = function (sel) { return e.target.closest ? e.target.closest(sel) : null; };
      const hit = at('.sw-route__dot, .sw-nav__item');
      const dot = hit && ctx.world.contains(hit) ? hit : null;
      const control = at('.isn-skip, .isn-main');
      if (!dot && !control) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (dot) return step(ctx, { to: Array.prototype.indexOf.call(dot.parentNode.children, dot) });
      return control.classList.contains('isn-skip') ? skip(ctx) : toBody(ctx);
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
    DEFAULTS: DEFAULTS, stopPositions: stopPositions, totalWeight: totalWeight, moveDuration: moveDuration,
    wheelIgnored: wheelIgnored, createWheelGesture: createWheelGesture, belongsToIntro: belongsToIntro,
    createNavigator: createNavigator, keyInput: keyInput, prefetch: prefetch, attach: attach,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.IntroStepNav = api;
}
