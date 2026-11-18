// 2. What you need. 2-1: small title, the tool box outline draws, four chips enter it. 2-2: a two-column table,
// header then rows top to bottom. 2-3: the temperature cell turns accent; a highlight sweeps behind one word.
Deck.scene({
  section: 2,
  css: `
.s02 .tools { position: absolute; left: 160px; top: 290px; width: 700px; height: 330px; }
.s02 .tools .grid { display: flex; flex-wrap: wrap; gap: 28px; }
.s02 .table { position: absolute; left: 960px; top: 270px; width: 800px; }
.s02 .row { display: grid; grid-template-columns: 1fr 260px; align-items: center; height: 104px; border-bottom: 2px solid var(--line); font-size: 44px; }
.s02 .row > span { padding-left: 8px; white-space: nowrap; justify-self: start; }
.s02 .row.head { height: 84px; border-bottom: 3px solid var(--fg); font-size: 40px; font-weight: 700; color: var(--muted); }
.s02 .note { position: absolute; left: 160px; top: 820px; white-space: nowrap; }
`,
  html: (d) => {
    const [kick, label, ...tools] = d.lines('s2-1');
    const [head, ...rows] = d.lines('s2-2').map((l) => l.split('|').map((c) => c.trim()));
    const note = d.lines('s2-3')[0];
    const [n0, n1] = note.split('맛');
    const cell = (c, i, r) => (r === 2 && i === 1 ? `<span class="acc" data-r="temp">${d.esc(c)}</span>` : `<span>${d.esc(c)}</span>`);
    return `
<h2 class="kicker" data-r="kick">${d.esc(kick)}</h2>
<div class="dbox tools" data-r="tools"><div class="dbox-label">${d.esc(label)}</div>
  <div class="grid">${tools.map((t) => `<span class="chip" data-r="tool">${d.esc(t)}</span>`).join('')}</div>
</div>
<div class="table">
  <div class="row head" data-r="head">${head.map((c) => `<span>${d.esc(c)}</span>`).join('')}</div>
  ${rows.map((r, k) => `<div class="row" data-r="row">${r.map((c, i) => cell(c, i, k)).join('')}</div>`).join('')}
</div>
<p class="note t-h2" data-r="note">${d.esc(n0)}<span data-r="taste">맛</span>${d.esc(n1)}</p>`;
  },
  steps: {
    's2-1'(s) {
      s.kicker('kick', { at: 0.1 });
      const t = s.box('tools', { at: 0.3 });
      s.chips('tool', { at: t, stagger: 0.25 });
    },
    's2-2'(s) {
      s.fadeUp('head', { at: 0.1, y: 10 });
      s.rows('row', { at: 0.5 });
    },
    's2-3'(s) {
      s.accent('temp', { at: 0.1 });
      s.fadeUp('note', { at: 0.4, y: 12 });
      s.mark('taste', { at: 1.0 });
    },
  },
});
