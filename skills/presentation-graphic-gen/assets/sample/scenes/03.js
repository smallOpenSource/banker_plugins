// 3. Steps. 3-1: five flow boxes in two rows joined by connectors (the fourth wraps down to the second row).
// 3-2: the focus outline appears on the third box; a connector leads right to "30초". 3-3: the outline moves to the
// fourth box; a vertical connector leads down to a line of text, s.underline draws its underline (sized to the
// text), and three short vertical pour marks draw one after another to its right.
Deck.scene({
  section: 3,
  css: `
.s03 .frow { position: absolute; display: flex; gap: 120px; }
.s03 .frow1 { left: 160px; top: 290px; }
.s03 .frow2 { left: 280px; top: 560px; }
.s03 .wait { position: absolute; left: 1180px; top: 290px; height: 120px; display: flex; align-items: center; white-space: nowrap; }
.s03 .pour { position: absolute; left: 280px; top: 770px; white-space: nowrap; }
.s03 .marks { position: absolute; left: 700px; top: 772px; display: flex; gap: 22px; }
.s03 .mark { display: block; width: 12px; height: 64px; border-radius: 6px; background: var(--accent-solid); }
`,
  html: (d) => {
    const [kick, ...steps] = d.lines('s3-1');
    const box = (t, i) => `<div class="fbox" data-r="fb${i}">${d.esc(t)}</div>`;
    return `
<h2 class="kicker" data-r="kick">${d.esc(kick)}</h2>
<div class="frow frow1">${steps.slice(0, 3).map(box).join('')}</div>
<div class="frow frow2">${steps.slice(3).map((t, i) => box(t, i + 3)).join('')}</div>
<div class="wait t-h1" data-r="wait">${d.esc(d.lines('s3-2')[0])}</div>
<p class="pour t-body" data-r="pour">${d.esc(d.lines('s3-3')[0])}</p>
<i class="ul" data-r="ul3"></i>
<div class="marks">${[0, 1, 2].map(() => `<i class="mark" data-r="pourmark"></i>`).join('')}</div>`;
  },
  steps: {
    's3-1'(s) {
      let t = 0.1;
      s.kicker('kick', { at: t });
      s.fadeUp('fb0', { at: t, y: 14 });
      for (let i = 1; i < 5; i++) {
        t += 0.4;
        const end = s.connector(`fb${i - 1}`, `fb${i}`, i === 3 ? { at: t, route: 'wrap', x: 220 } : { at: t });
        s.fadeUp(`fb${i}`, { at: end - 0.1, y: 14 });
        t = end;
      }
    },
    's3-2'(s) {
      const t = s.focus('ring', 'fb2', { at: 0.1 });
      const t2 = s.connector('fb2', 'wait', { at: t });
      s.fadeUp('wait', { at: t2, y: 12 });
    },
    's3-3'(s) {
      const t = s.focus('ring', 'fb3', { at: 0.1, dur: 0.5 });
      const t2 = s.connector('fb3', 'pour', { at: t, route: 'v' });
      const t3 = s.fadeUp('pour', { at: t2, y: 10 });
      const t4 = s.underline('ul3', 'pour', { at: t3 });
      s.draw('pourmark', { at: t4, stagger: 0.25, dur: 0.3, axis: 'y' });
    },
  },
});
