// 5. Common mistakes. 5-1: small title and three lines. 5-2 / 5-3: a strike-through dims a wrong line and its fix
// slides in on the right; in 5-3 the remaining line dims.
Deck.scene({
  section: 5,
  css: `
.s05 .item { position: absolute; left: 160px; white-space: nowrap; }
.s05 .fix { position: absolute; left: 1000px; white-space: nowrap; color: var(--accent); font-weight: 700; }
.s05 .r0 { top: 300px; } .s05 .r1 { top: 440px; } .s05 .r2 { top: 580px; }
`,
  html: (d) => {
    const [kick, ...items] = d.lines('s5-1');
    return `
<h2 class="kicker" data-r="kick">${d.esc(kick)}</h2>
${items.map((t, i) => `<p class="item t-body r${i}" data-r="m${i}">${d.esc(t)}</p>`).join('')}
<p class="fix t-body r0" data-r="f0">${d.esc(d.lines('s5-2')[0])}</p>
<p class="fix t-body r1" data-r="f1">${d.esc(d.lines('s5-3')[0])}</p>`;
  },
  steps: {
    's5-1'(s) {
      s.kicker('kick', { at: 0.1 });
      s.rows(['m0', 'm1', 'm2'], { at: 0.3, stagger: 0.35 });
    },
    's5-2'(s) {
      const t = s.strike('m0', { at: 0.1 });
      s.tween('f0', { opacity: 0, x: -16 }, { opacity: 1, x: 0 }, { at: t, dur: 0.4 });
    },
    's5-3'(s) {
      const t = s.strike('m1', { at: 0.1 });
      s.tween('f1', { opacity: 0, x: -16 }, { opacity: 1, x: 0 }, { at: t, dur: 0.4 });
      s.dim('m2', { at: t + 0.2, to: 0.4 });
    },
  },
});
