/*
 * Scene-by-scene navigation for the scroll-world intro (on by default; intro.json "stepNav": false
 * turns it off).
 *
 * The vendored engine maps the window's scroll position to clip time and stays as shipped; this
 * script only moves the scroll position. Stops: each scene's start (its dive's first frame; an exit
 * clip is the way to the next scene), the end of the last scene, then the top of the page body
 * (`end`, when the intro sits on top of a site). Between two stops lies a half point.
 *   wheel          one notch moves half way to the next stop, two notches a whole scene. Pixel, line
 *                  and page deltas, and a touchpad's small ones, add up to notches (notchPx, linePx);
 *                  one gesture moves at most maxNotches
 *   arrow keys     up/down and left/right as the wheel (up and left go back)
 *   PageUp/PageDown, Space (shift goes back), a swipe over swipePx   one scene
 *   Home, End      the first scene's start, the last scene's end, at once (no animation)
 *   a route dot    its scene's start, at once (a click, or Enter or Space on the focused dot)
 * Fields and editable places keep their keys. An input during a move retargets it from where that
 * move was going. When the page comes to rest anywhere else above the body (a scrollbar, a touchpad,
 * an anchor), it settles on the nearest stop after snapMs. Below the body top the browser scrolls as
 * usual. At a stop or a half point, the copy of the scene in view is shown (class isn-copy, faded by
 * step-nav.css; the engine's own fade takes over again when a move starts).
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
 *   notchPx, linePx, maxNotches   wheel pixels to a notch, pixels in a line delta, notches per gesture
 *   snapMs         how long the page must rest off the stops before it settles on the nearest one
 *   decodeCapMs, instantDecodeCapMs   the longest wait for the posters to decode before a move, and before
 *                  an instant one (nothing hides an undecoded poster there, so it waits longer)
 *   loadingDelayMs, loadingLabel   a wait for the posters (either kind of move) longer than loadingDelayMs
 *                  shows a small loading mark mid-screen with this text (a status region, read by a screen
 *                  reader; it takes no focus and no input, and a new input drops it with the old move). It
 *                  goes as the move starts. Under reduced motion the mark does not spin
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
    durBaseMs: 2600, durPerVhMs: 760, durMaxMs: 5600, decodeCapMs: 300, prefetch: true,
    notchPx: 100, linePx: 40, maxNotches: 2, snapMs: 400, instantDecodeCapMs: 1500, loadingDelayMs: 150, loadingLabel: 'Loading',
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

  /** Stop positions in px: each scene's start, the last scene's end, then the body. */
  function stopPositions(config, vh, endTop) {
    const spans = spansOf(config).spans;
    // one pixel into the scene: the engine's current segment is the last whose start is at or above the
    // page, and its starts carry float error (2.2 x 800 = 1760.0000000000002), so a stop at the rounded
    // start would leave the segment before on top; an exit ending on a background plate showed the plate
    const stops = spans.map(function (span, i) { return i ? Math.floor(span[0] * vh) + 1 : 0; });
    if (spans.length) stops.push(Math.round(spans[spans.length - 1][1] * vh));
    return endTop == null ? stops : stops.concat([endTop]);
  }

  /** The stops with the half point between each two: where a wheel notch or an arrow key can land. */
  function gridOf(stops) {
    const g = [];
    stops.forEach(function (v, i) { if (i) g.push(Math.round((stops[i - 1] + v) / 2)); g.push(v); });
    return g;
  }

  /**
   * Where n points of `list` (signed: + goes down) take the page from `base`; from a place between
   * points the first one is the next point that way. null when there is none that way.
   */
  function stepFrom(list, base, n) {
    if (!n) return null;
    let i;
    if (n > 0) i = list.findIndex(function (v) { return v > base + 1; });
    else for (i = list.length - 1; i >= 0 && !(list[i] < base - 1); i--);
    if (i < 0) return null;
    return list[Math.max(0, Math.min(list.length - 1, i + (n > 0 ? n - 1 : n + 1)))];
  }

  /** The scene whose copy is in view at y: the dive holding it, or across an exit the nearer scene. */
  function sceneAt(config, vh, y) {
    const spans = spansOf(config).spans;
    for (let i = spans.length - 1; i >= 0; i--) {
      if (y >= spans[i][0] * vh - 1) {
        const end = spans[i][1] * vh;
        const next = spans[i + 1];
        return y <= end + 1 || !next ? i : (y - end > (next[0] * vh - end) / 2 ? i + 1 : i);
      }
    }
    return 0;
  }

  /** The stop a page resting at y settles on (the nearest up to the last scene's end); -1 at a stop or a half point. */
  function settleTarget(stops, lastStop, y) {
    if (gridOf(stops).some(function (v) { return Math.abs(v - y) <= 1; })) return -1;
    return nearest(stops.slice(0, lastStop + 1), y);
  }

  /** Wheel notches in one event: pixel, line and page deltas in pixels, added to the gesture's remainder. */
  function wheelNotches(e, carry, o) {
    const unit = e.deltaMode === 1 ? o.linePx : e.deltaMode === 2 ? 2 * o.notchPx : 1;
    const total = carry + (e.deltaY || 0) * unit;
    const n = Math.trunc(total / o.notchPx);
    return { n: n, carry: total - n * o.notchPx };
  }

  function moveDuration(distance, vh, o, reduce) {
    if (reduce) return 0;
    return Math.min(o.durMaxMs, o.durBaseMs + (Math.abs(distance) / vh) * o.durPerVhMs);
  }

  /**
   * Zoom (ctrl+wheel, pinch) and sideways wheels stay with the browser. A tiny wheel is held by the
   * intro but starts no gesture (an inertia tail would otherwise nudge the page off its stop).
   */
  function wheelIgnored(e) {
    return Boolean(e.ctrlKey) || Math.abs(e.deltaX || 0) > Math.abs(e.deltaY || 0);
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
        if (wheelIgnored(e) || mag < o.minWheel) return 'ignore';
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

  // Where an input asks to go from `base`: { to: i } a stop, { steps: n } n grid points, { scenes: n } the
  // next stop that way (n is +1 or -1). null when there is nothing that way.
  function targetOf(stops, base, input) {
    if (input.to != null) return stops[Math.max(0, Math.min(stops.length - 1, input.to))];
    if (input.steps) return stepFrom(gridOf(stops), base, input.steps);
    return stepFrom(stops, base, input.scenes);
  }

  /**
   * Moves between stops and half points. input(spec) starts a move from where the page stands (sync(y)),
   * or during a move retargets it from where it was going. move(fromY, toY, done) animates from the
   * page's place (where()); onArrive(y) runs when a move ends; onLeave() when one starts.
   */
  function createNavigator(opt) {
    let pos = 0;
    let target = null;
    let generation = 0;
    let arrivals = 0;
    const list = function () { return opt.stops(); };
    function go(y, instant) {
      if (y == null || Math.abs(y - (target == null ? pos : target)) <= 1) return;
      const gen = ++generation;
      if (target == null && opt.onLeave) opt.onLeave(instant);
      target = y;
      opt.move(opt.where ? opt.where() : pos, y, function () {
        if (gen !== generation) return;
        pos = y;
        target = null;
        arrivals++;
        if (opt.onArrive) opt.onArrive(y);
      }, Boolean(instant));
    }
    return {
      input: function (spec) { go(targetOf(list(), target == null ? pos : target, spec), spec.instant); },
      sync: function (y) { if (target == null) pos = y; },
      // Drops the move in flight; its end, when it comes, does nothing.
      cancel: function () { generation++; target = null; },
      state: function () {
        const stops = list();
        const at = target == null ? pos : target;
        const index = nearest(stops, at);
        return { index: index, y: at, moving: target != null, arrivals: arrivals, onStop: Math.abs(stops[index] - at) <= 1,
          atBody: stops.length - 1 > opt.lastStop && index === stops.length - 1 && Math.abs(stops[index] - at) <= 1 };
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
  // The intro's own controls (the route dots and the nav items) keep moving the scene on Left/Right after a click
  // focuses them; another focused button or link (in scene content) leaves Left/Right to itself.
  const ownControl = function (t) { return Boolean(t && t.closest && t.closest('.sw-nav, .sw-route')); };
  const KEYS = { ArrowDown: { steps: 1 }, ArrowRight: { steps: 1 }, ArrowUp: { steps: -1 }, ArrowLeft: { steps: -1 },
    PageDown: { scenes: 1 }, PageUp: { scenes: -1 }, Home: { to: 0, instant: true }, End: { to: 'last', instant: true } };

  /** What a key asks for ({ steps }, { scenes }, { to }; End's to is 'last'), or null when the key is not the intro's. */
  function keyInput(e) {
    if (e.altKey || e.ctrlKey || e.metaKey || editable(e.target)) return null;
    if (e.key === ' ') return pressable(e.target) ? null : { scenes: e.shiftKey ? -1 : 1 };
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && pressable(e.target) && !ownControl(e.target)) return null;
    return KEYS[e.key] || null;
  }

  /** The direction of an input from `base`: 'down', 'up', or null when it asks for no move. */
  function dirOf(stops, base, input) {
    const y = targetOf(stops, base, input);
    return y == null || Math.abs(y - base) <= 1 ? null : (y > base ? 'down' : 'up');
  }

  // ---- browser wiring -----------------------------------------------------------

  const ease = function (p) { return 0.5 - 0.5 * Math.cos(Math.PI * p); };

  // Sets the scroll position at once ('instant' beats a site's scroll-behavior: smooth; an older
  // browser that does not know it takes the two-number form).
  function jump(y) {
    try { window.scrollTo({ top: y, behavior: 'instant' }); } catch (e) { window.scrollTo(0, y); }
  }

  // A scene a move shows paints nothing until its poster is decoded (the engine's posters decode async):
  // a jump showed an empty background for 0.1-0.35 s. Decode every poster first, waiting at most capMs.
  function postersReady(world, capMs, then) {
    let fired = false;
    const go = function () { if (!fired) { fired = true; then(); } };
    const stills = Array.prototype.slice.call(world.querySelectorAll('.sw-scene__still'));
    Promise.all(stills.map(function (i) { return i.decode ? i.decode().catch(function () {}) : null; })).then(go);
    setTimeout(go, capMs);
  }

  /**
   * The loading mark of the poster waits: begin(token) shows it after delayMs unless end(token) came first;
   * a newer begin() or cancel() drops the older wait and its mark. show() and hide() draw it; timers injectable.
   */
  function createLoader(delayMs, show, hide, timers) {
    // wrapped: a browser refuses setTimeout called as a method of another object (Illegal invocation)
    const t = timers || { set: function (f, ms) { return setTimeout(f, ms); }, clear: function (id) { clearTimeout(id); } };
    let current = null;
    let timer = null;
    let shown = false;
    function drop() {
      if (timer !== null) t.clear(timer);
      timer = null;
      if (shown) { shown = false; hide(); }
    }
    return {
      begin: function (token) {
        drop();
        current = token;
        timer = t.set(function () { timer = null; if (current === token) { shown = true; show(); } }, delayMs);
      },
      end: function (token) { if (token === current) { drop(); current = null; } },
      cancel: function () { drop(); current = null; },
    };
  }

  // The running animation; a newer one, or stopAnimation(), ends it between frames.
  let animation = 0;
  let pending = 0;   // a move waiting for its posters; a newer move or stopAnimation() drops it
  function stopAnimation() { animation++; pending++; }

  function animate(from, to, duration, done) {
    const mine = ++animation;
    if (duration <= 0) {
      jump(to);
      return done();
    }
    const t0 = performance.now();
    (function frame(t) {
      if (mine !== animation) return;
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
    // a status region: its text is set while a poster wait shows, so a screen reader hears it; no focus taken
    const loading = element('div', 'isn-loading');
    loading.setAttribute('role', 'status');
    loading.setAttribute('aria-live', 'polite');
    const spin = element('i', 'isn-loading__spin');
    spin.setAttribute('aria-hidden', 'true');
    loading.appendChild(spin);
    loading.appendChild(element('span', 'isn-loading__label'));
    document.body.appendChild(loading);
    return { hint: hint, skip: skip, main: main, loading: loading };
  }

  /**
   * Wires the navigation to the page. Returns { goTo(i), hold(on), state(), stops(), lastScene, lastStop, end };
   * hold(true) stops the settling on a stop (a measuring script that parks the page between stops).
   */
  function attach(world, config, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const ctx = makeContext(world, config, o);
    ctx.ui = buildUi(o);
    const label = ctx.ui.loading.querySelector('.isn-loading__label');
    ctx.loader = createLoader(o.loadingDelayMs,
      function () { label.textContent = o.loadingLabel; ctx.ui.loading.classList.add('is-on'); },
      function () { ctx.ui.loading.classList.remove('is-on'); label.textContent = ''; });
    listenWheel(ctx);
    listenKeys(ctx);
    listenTouch(ctx);
    listenClicks(ctx);
    listenScroll(ctx);
    ctx.nav.sync(window.scrollY);
    ctx.mark();
    const handle = { goTo: function (i) { step(ctx, { to: i }); }, hold: function (on) { ctx.held = Boolean(on); },
      state: function () { return ctx.nav.state(); }, stops: ctx.stops, lastScene: ctx.lastScene, lastStop: ctx.lastStop, end: o.end };
    // The navigation on this page, for scripts and for verify-intro.mjs.
    window.IntroStepNav.current = handle;
    return handle;
  }

  function makeContext(world, config, o) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const lastScene = (config.sections || []).length - 1;
    const ctx = { o: o, world: world, config: config, lastScene: lastScene, lastStop: lastScene + 1, focusEnd: false, warned: false };
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
    ctx.ours = function (y, dir) { return belongsToIntro(y, dir, ctx.stops()[ctx.lastStop], ctx.endTop()); };
    ctx.mark = function () { mark(ctx); };
    ctx.nav = createNavigator({ stops: ctx.stops, lastStop: ctx.lastStop, where: function () { return window.scrollY; },
      onLeave: function (instant) { instantCopy(instant); showCopy(ctx, -1); },
      onArrive: function () { ctx.mark(); requestAnimationFrame(function () { requestAnimationFrame(function () { instantCopy(false); }); }); },
      move: function (from, to, done, instant) {
        const mine = ++pending;
        // an instant move swaps the copy at once even when it retargets a move already under way (no onLeave then)
        instantCopy(instant);
        ctx.loader.begin(mine);
        // from where the page is once the posters are ready: an earlier move may have run on while waiting
        postersReady(world, instant ? o.instantDecodeCapMs : o.decodeCapMs, function () {
          if (mine !== pending) return;
          ctx.loader.end(mine);
          const at = window.scrollY;
          animate(at, to, instant ? 0 : moveDuration(to - at, ctx.vh(), o, reduce), done);
        });
      } });
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    document.documentElement.classList.add('isn-on', fine ? 'isn-mouse' : 'isn-touch');
    return ctx;
  }

  // The body element, looked up each time; a configured one that is missing is logged once.
  function endElement(ctx) {
    if (!ctx.o.end) return null;
    const e = document.querySelector(ctx.o.end);
    // A body drawn after this script is a supported layout: warn only once the page has loaded.
    if (!e && !ctx.warned && document.readyState === 'complete') {
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

  // An instant move (Home, End, a dot) swaps the copy without the fade (class isn-instant, step-nav.css).
  function instantCopy(on) { document.documentElement.classList.toggle('isn-instant', Boolean(on)); }

  // The copy of scene k shows over the engine's own fade (class isn-copy, see step-nav.css); -1 shows none.
  // The same element: nothing is copied, so a screen reader and the focus meet each text once.
  function showCopy(ctx, k) {
    ctx.world.querySelectorAll('.sw-copy').forEach(function (c, i) { c.classList.toggle('isn-copy', i === k); });
  }

  // Classes the CSS reads: isn-last at the last scene's end; isn-ready there once its clip has played
  // to the end (under reduced motion that stop is reached at once and the engine plays no clip);
  // isn-body at or below the body top. At a stop or a half point the copy in view shows. Moves the
  // focus to the body after the main button.
  function mark(ctx) {
    const c = document.documentElement.classList;
    const y = window.scrollY;
    const stops = ctx.stops();
    const atLast = Math.abs(y - stops[ctx.lastStop]) <= 1;
    const body = stops.length - 1 > ctx.lastStop && y >= stops[stops.length - 1] - 1;
    c.toggle('isn-last', atLast);
    c.toggle('isn-ready', Boolean(ctx.endEl()) && atLast);
    c.toggle('isn-body', body);
    const onGrid = gridOf(stops).some(function (v) { return Math.abs(v - y) <= 1; });
    showCopy(ctx, onGrid && !body ? sceneAt(ctx.config, ctx.vh(), y) : -1);
    if (ctx.focusEnd && body) focusBody(ctx);
  }

  // An input ({ steps }, { scenes }, { to }, End's { to: 'last' }; instant: no animation) from where the page stands.
  function step(ctx, input) {
    ctx.nav.sync(window.scrollY);
    ctx.nav.input(input.to === 'last' ? { to: ctx.lastStop, instant: input.instant } : input);
  }

  // The direction an input takes from where the page (or the move in flight) is going.
  const dirFrom = function (ctx, input) {
    const st = ctx.nav.state();
    return dirOf(ctx.stops(), st.moving ? st.y : window.scrollY, input.to === 'last' ? { to: ctx.lastStop, instant: input.instant } : input);
  };

  function listenWheel(ctx) {
    const gesture = createWheelGesture(ctx.o);
    let carry = 0;
    let used = 0;
    window.addEventListener('wheel', function (e) {
      if (wheelIgnored(e)) return;
      if (!ctx.ours(window.scrollY, e.deltaY > 0 ? 'down' : 'up')) return;
      e.preventDefault();
      const kind = gesture.feed(e, e.timeStamp);
      if (kind === 'ignore') return;
      if (kind === 'new') { carry = 0; used = 0; }
      const w = wheelNotches(e, carry, ctx.o);
      carry = w.carry;
      const n = Math.sign(w.n) * Math.min(Math.abs(w.n), ctx.o.maxNotches - used);
      if (!n) return;
      used += Math.abs(n);
      step(ctx, { steps: n });
    }, { passive: false });
  }

  function listenKeys(ctx) {
    window.addEventListener('keydown', function (e) {
      const input = keyInput(e);
      if (!input) return;
      const dir = dirFrom(ctx, input);
      if (!dir || !ctx.ours(window.scrollY, dir)) return;
      e.preventDefault();
      if (!e.repeat) step(ctx, input);
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
      if (Math.abs(dy) > ctx.o.swipePx && ctx.ours(window.scrollY, dir)) step(ctx, { scenes: dir === 'down' ? 1 : -1 });
    }, { passive: true });
  }

  // The skip link jumps at once (no animation to wait through) and hands the focus to the body; on a
  // standalone page it goes to the last scene.
  function skip(ctx) {
    ctx.nav.cancel();
    stopAnimation();
    ctx.loader.cancel();
    const top = ctx.endTop();
    jump(top == null ? ctx.stops()[ctx.lastStop] : top);
    ctx.nav.sync(window.scrollY);
    ctx.mark();
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
      if (dot) return step(ctx, { to: Array.prototype.indexOf.call(dot.parentNode.children, dot), instant: true });
      return control.classList.contains('isn-skip') ? skip(ctx) : toBody(ctx);
    }, true);
  }

  // Scrolling by other means (scrollbar, a touchpad, find in page, an anchor) moves the navigator's place
  // too; a page that comes to rest off the stops and half points, above the body, settles on the nearest stop.
  function listenScroll(ctx) {
    let queued = false;
    let rest = 0;
    const later = function () { clearTimeout(rest); rest = setTimeout(function () { settle(ctx); }, ctx.o.snapMs); };
    // while a pointer holds the page or its scrollbar, nothing settles; snapMs after it lets go, it may
    window.addEventListener('pointerdown', function () { ctx.pressed = true; clearTimeout(rest); }, true);
    // a press can end without a pointerup: a context menu, a release outside the window, a lost capture, the tab hidden
    const release = function () { if (!ctx.pressed) return; ctx.pressed = false; later(); };
    ['pointerup', 'pointercancel', 'lostpointercapture', 'contextmenu'].forEach(function (k) { window.addEventListener(k, release, true); });
    // Capture catches the window losing focus; a focused element inside the page losing focus (its own blur, which
    // capture also sees) must not end a press, or a click that moves focus would clear `pressed` mid-press.
    window.addEventListener('blur', function (e) { if (e.target === window) release(); }, true);
    document.addEventListener('visibilitychange', function () { if (document.hidden) release(); });
    window.addEventListener('scroll', function () {
      if (ctx.nav.state().moving) return;
      later();
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        if (ctx.nav.state().moving) return;
        ctx.nav.sync(window.scrollY);
        ctx.mark();
      });
    }, { passive: true });
  }

  function settle(ctx) {
    const y = window.scrollY;
    if (ctx.held || ctx.pressed || ctx.nav.state().moving || !ctx.ours(y, 'down')) return;
    const to = settleTarget(ctx.stops(), ctx.lastStop, y);
    if (to >= 0) step(ctx, { to: to });
  }

  const api = {
    DEFAULTS: DEFAULTS, stopPositions: stopPositions, totalWeight: totalWeight, moveDuration: moveDuration,
    wheelIgnored: wheelIgnored, createWheelGesture: createWheelGesture, belongsToIntro: belongsToIntro,
    createNavigator: createNavigator, keyInput: keyInput, prefetch: prefetch, attach: attach, postersReady: postersReady,
    gridOf: gridOf, stepFrom: stepFrom, createLoader: createLoader, sceneAt: sceneAt, wheelNotches: wheelNotches, dirOf: dirOf, settleTarget: settleTarget,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.IntroStepNav = api;
}
