// 4. Ratio. The big number is animated in all three steps on the same channels (translate, scale, opacity):
// 4-1 rises in, 4-2 shrinks to the top left and dims, 4-3 moves right (above the new line) and becomes clear again. The engine merges
// these into one keyframe track per channel, so every time in between shows the right value.
// 4-2 also fills a blank; 4-3 swaps the blank sentence for the preference line in place.
Deck.scene({
  section: 4,
  css: `
.s04 .num { position: absolute; left: 160px; top: 280px; transform-origin: 0 0; white-space: nowrap; }
.s04 .sub { position: absolute; left: 160px; top: 520px; white-space: nowrap; }
.s04 .line { position: absolute; left: 160px; top: 420px; white-space: nowrap; transform-origin: 0 50%; }
.s04 .line .blank { min-width: 200px; margin: 0 16px; }
`,
  html: (d) => {
    const [num, sub] = d.lines('s4-1');
    const [pre, word, unit] = d.lines('s4-2');
    return `
<div class="num t-hero" data-r="num">${d.esc(num)}</div>
<p class="sub t-h2 muted" data-r="sub">${d.esc(sub)}</p>
<p class="line t-h1" data-r="q">${d.esc(pre)}<span class="blank" data-r="blank"><i class="blank-hatch"></i><span class="blank-word" data-r="word">${d.esc(word)}</span></span>${d.esc(unit)}</p>
<p class="line t-h1" data-r="pref">${d.esc(d.lines('s4-3')[0])}</p>`;
  },
  steps: {
    's4-1'(s) {
      s.bigNumber('num', 'sub', { at: 0.1 });
    },
    's4-2'(s) {
      s.fadeOut('sub', { at: 0.1 });
      s.move('num', { y: -140, scale: 0.4 }, { at: 0.1, dur: 0.7 });
      s.dim('num', { at: 0.5, to: 0.35 });
      const t = s.fadeUp('q', { at: 0.6, y: 12 });
      s.fill('blank', 'word', { at: t + 0.4 });
    },
    's4-3'(s) {
      s.swap('q', 'pref', { at: 0.1 });
      s.move('num', { x: 1000, y: -100, scale: 0.6 }, { at: 0.4, dur: 0.7 });
      s.tween('num', null, { opacity: 1 }, { at: 0.6, dur: 0.4 });
    },
  },
});
