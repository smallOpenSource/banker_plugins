// 1. Cover. 1-1: the title layer rises in; the underline under the key word draws once the layer has settled (it
// lives in the same layer, so it can never drift off its word); the gray subtitle follows. 1-2: three chips one by
// one with the focus outline following the newest chip (the outline belongs to each chip and has its shape).
Deck.scene({
  section: 1,
  css: `
.s01 .cover { position: absolute; left: 160px; top: 300px; width: 1600px; height: 140px; }
.s01 .title { position: absolute; left: 0; top: 0; white-space: nowrap; }
.s01 .sub { position: absolute; left: 160px; top: 470px; white-space: nowrap; }
.s01 .chips { position: absolute; left: 172px; top: 640px; display: flex; gap: 28px; }
`,
  html: (d) => {
    const [title, sub] = d.lines('s1-1');
    const [before, after] = title.split('커피');
    return `
<div class="cover" data-r="cover">
  <h1 class="title t-display">${d.esc(before)}<span data-r="kw">커피</span>${d.esc(after)}</h1>
  <i class="ul" data-r="ul"></i>
</div>
<p class="sub t-h2 muted" data-r="sub">${d.esc(sub)}</p>
<div class="chips">${d.lines('s1-2').map((t) => `<span class="chip" data-r="chip">${d.esc(t)}</span>`).join('')}</div>`;
  },
  steps: {
    's1-1'(s) {
      s.fadeUp('cover', { at: 0.1, y: 28, dur: 0.5 });
      s.underline('ul', 'kw', { at: 0.6 });
      s.fadeUp('sub', { at: 0.9, y: 12 });
    },
    's1-2'(s) {
      s.chips('chip', { stagger: 0.35, ring: 'ring' });
    },
  },
});
