// 6. Closing. 6-1: the cup picture opens with a wipe from the left, beans fade in at seeded random spots, and the
// text layer (title, line, underline, highlight) slides in from the right as ONE layer: the underline is drawn
// while the layer is still moving and stays on its text because only the layer is translated.
// 6-2: everything fades out, one thank-you line stays.
Deck.scene({
  section: 6,
  css: `
.s06 .cup { position: absolute; left: 160px; top: 240px; width: 520px; height: 520px; }
.s06 .cup img { display: block; width: 520px; height: 520px; }
.s06 .bean { position: absolute; width: 26px; height: 16px; border-radius: 50%; background: var(--muted); }
.s06 .t1 { position: absolute; left: 800px; top: 360px; white-space: nowrap; }
.s06 .t2 { position: absolute; left: 800px; top: 520px; white-space: nowrap; }
.s06 .bye { position: absolute; left: 160px; width: 1600px; top: 470px; text-align: center; }
`,
  html: (d) => {
    const [t1, t2] = d.lines('s6-1');
    const cut = t2.indexOf(',');
    const rnd = d.rand(7);
    const beans = Array.from({ length: 12 }, () => {
      const x = 190 + Math.round(rnd() * 480), y = 790 + Math.round(rnd() * 130), r = Math.round(rnd() * 180);
      return `<i class="bean" data-r="bean" style="left:${x}px;top:${y}px;transform:rotate(${r}deg)"></i>`;
    }).join('');
    return `
<div class="cup" data-r="cup"><img alt="" src="${d.asset('cup.svg')}"></div>
${beans}
<div class="layer" data-r="pan">
  <h2 class="t1 t-display">${d.esc(t1)}</h2>
  <p class="t2 t-h2" data-r="line"><span data-r="slow">${d.esc(t2.slice(0, cut))}</span>${d.esc(t2.slice(cut))}</p>
  <i class="ul" data-r="ul2"></i>
</div>
<p class="bye t-display" data-r="bye">${d.esc(d.lines('s6-2')[0])}</p>`;
  },
  steps: {
    's6-1'(s) {
      s.reveal('cup', { at: 0.1, dur: 0.8 });
      s.fadeIn('bean', { at: 0.5, stagger: 0.05, dur: 0.3 });
      s.tween('pan', { opacity: 0, x: 240 }, { opacity: 1, x: 0 }, { at: 0.3, dur: 1.2, ease: 'out' });
      s.underline('ul2', 'line', { at: 0.6, dur: 0.5 });
      s.mark('slow', { at: 1.0 });
    },
    's6-2'(s) {
      s.fadeOut(['cup', 'bean', 'pan'], { at: 0.1 });
      s.fadeUp('bye', { at: 0.4, y: 16 });
      s.hold(1.2);
    },
  },
});
