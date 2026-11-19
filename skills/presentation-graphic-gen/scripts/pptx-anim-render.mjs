// pptx-anim-render.mjs: the anim-render gate. At every step's end the slide's shapes are drawn by the browser from the
// slide XML alone (rectangles, rounded rectangles, outlines, glows, text runs, pictures from the deck's media) at the
// state the simulator gives, over the present page, and compared pixel by pixel with the page at that time. This
// catches a rebuilt layout that is off (text place, paint order, colors), not only the timing. The page's own
// fonts are used, so the comparison is fair; PowerPoint's text renderer is not (that is anim-powerpoint).
import { decodePng } from './png.mjs';
import { stepWindows } from './pptx-anim-extract.mjs';
import { stateAt } from './pptx-anim-sim.mjs';
import { kid, parseXml, walk } from './pptx-xmlcheck.mjs';

// a channel off by more than LEVEL counts as a different pixel; a step passes with at most SHARE of them
export const RENDER_TOL = { level: 48, share: 0.005 };
const EMU_PX = 6350;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function color(fill) {
  const c = fill && walk(fill).find((x) => x.name === 'a:srgbClr');
  if (!c) return null;
  const al = kid(c, 'a:alpha'), a = al ? +al.attrs.val / 100000 : 1, v = c.attrs.val;
  return `rgba(${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)}, ${a})`;
}
// the outline: { w (px), c } centered on the shape edge, or null
function outline(pr) {
  const ln = kid(pr, 'a:ln'), c = ln && color(kid(ln, 'a:solidFill'));
  return c && ln.attrs.w ? { w: +ln.attrs.w / EMU_PX, c } : null;
}
function radius(pr, w, h) {
  const geom = kid(pr, 'a:prstGeom'), adj = geom && geom.attrs.prst === 'roundRect' ? walk(geom).find((x) => x.name === 'a:gd') : null;
  return adj ? (+/val (\d+)/.exec(adj.attrs.fmla)[1] / 100000) * Math.min(w, h) : 0;
}
function boxCss(sp, w, h) {
  const pr = kid(sp, 'p:spPr'), fill = kid(pr, 'a:solidFill'), ln = outline(pr), r = radius(pr, w, h), glow = walk(pr).find((x) => x.name === 'a:glow');
  const css = fill ? [`background:${color(fill)}`] : [];
  if (ln) css.push(`border:${ln.w}px solid ${ln.c}`, `margin:${-ln.w / 2}px`);
  if (r) css.push(`border-radius:${r + (ln ? ln.w / 2 : 0)}px`);
  if (glow) css.push(`box-shadow:0 0 ${(2 * +glow.attrs.rad) / EMU_PX}px ${color(glow)}`);
  return css;
}
function runsHtml(sp) {
  const body = kid(sp, 'p:txBody');
  if (!body) return '';
  const p = kid(body, 'a:p'), algn = p && walk(p).find((x) => x.name === 'a:pPr');
  const just = { ctr: 'center', r: 'flex-end' }[algn && algn.attrs.algn] || 'flex-start';
  const runs = p ? p.kids.filter((x) => x.name === 'a:r').map((r) => {
    const pr = kid(r, 'a:rPr'), t = kid(r, 'a:t');
    const css = [`font-size:${(+pr.attrs.sz / 100) * 2}px`, `font-weight:${pr.attrs.b === '1' ? 700 : 400}`, `color:${color(kid(pr, 'a:solidFill')) || '#000'}`, `letter-spacing:${(+(pr.attrs.spc || 0) / 100) * 2}px`];
    return `<span style="${css.join(';')}">${esc(xmlText(t ? t.text : ''))}</span>`;
  }) : [];
  return `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:${just};white-space:pre">${runs.join('')}</div>`;
}
function picHtml(pic, media) {
  const blip = walk(pic).find((x) => x.name === 'a:blip'), am = blip && kid(blip, 'a:alphaModFix');
  const src = blip && media(blip.attrs['r:embed']);
  return src ? `<img src="${src}" style="position:absolute;inset:0;width:100%;height:100%;${am ? `opacity:${+am.attrs.amt / 100000}` : ''}">` : '';
}
function clipCss(clip) {
  if (!clip) return '';
  const q = `${(1 - (clip.out ? 1 - clip.p : clip.p)) * 100}%`;
  const at = { left: `0 ${q} 0 0`, right: `0 0 0 ${q}`, up: `0 0 ${q} 0`, down: `${q} 0 0 0` }[clip.dir];
  return at ? `clip-path:inset(${at});` : '';
}

/** HTML of a slide's shapes at the simulated states (Map spid -> state), in paint order, over its background. */
export function slideHtml(xml, states, media) {
  const root = parseXml(xml), tree = walk(root).find((n) => n.name === 'p:spTree'), bg = walk(root).find((n) => n.name === 'p:bg');
  const out = [];
  for (const n of tree.kids) {
    if (n.name !== 'p:sp' && n.name !== 'p:pic') continue;
    const id = walk(n).find((x) => x.name === 'p:cNvPr').attrs.id, st = states.get(id);
    if (!st || !st.vis || st.op <= 0) continue;
    const sh = st.shape, sx = st.w / sh.w, sy = st.h / sh.h;
    const inner = n.name === 'p:pic' ? picHtml(n, media) : runsHtml(n);
    const box = n.name === 'p:sp' ? boxCss(n, sh.w, sh.h) : [];
    const pos = `position:absolute;left:${st.cx - sh.w / 2}px;top:${st.cy - sh.h / 2}px;width:${sh.w}px;height:${sh.h}px;opacity:${st.op};transform:rotate(${st.rot}deg) scale(${sx}, ${sy});${clipCss(st.clip)}`;
    out.push(`<div style="${pos}"><div style="position:absolute;inset:0;box-sizing:border-box;${box.join(';')}"></div>${inner}</div>`);
  }
  return `<div id="pgg-render" style="position:absolute;left:0;top:0;width:1920px;height:1080px;overflow:hidden;z-index:1000;font-family:'Deck Sans','Deck Sans KR',sans-serif;background:${color(bg) || '#000'}">${out.join('')}</div>`;
}

function pixelDiff(a, b) {
  const A = decodePng(a), B = decodePng(b);
  if (A.width !== B.width || A.height !== B.height) return { share: 1, mean: 255 };
  let over = 0, sum = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
    sum += d;
    if (d > RENDER_TOL.level) over++;
  }
  const n = A.data.length / 4;
  return { share: over / n, mean: sum / n };
}

const SHOW = (html) => `(() => { const old = document.getElementById('pgg-render'); if (old) old.remove(); document.getElementById('stage').insertAdjacentHTML('beforeend', ${JSON.stringify(html)}); return true; })()`;
const HIDE = "(() => { const e = document.getElementById('pgg-render'); if (e) e.remove(); return true; })()";
const CLIP = { x: 0, y: 0, width: 1920, height: 1080 };

/** anim-render: { ok, detail, bad }; slides: [{ k, xml, media(rid) }], read: the simulator's slides. */
export async function renderCompare(deck, slides, read, log = () => {}) {
  const rows = [];
  for (let k = 0; k < Math.min(read.length, deck.sections.length); k++) {
    const W = stepWindows(deck.sections[k], deck.steps, k === 0);
    for (const w of W) {
      await deck.page.eval(`(__deck.seek(${w.end}), document.fonts.ready.then(() => true))`);
      const page = await deck.page.shot(null, CLIP);
      await deck.page.eval(SHOW(slideHtml(slides[k].xml, stateAt(read[k], w.k, Infinity), slides[k].media)));
      await deck.page.eval('document.fonts.ready.then(() => Promise.all([...document.querySelectorAll("#pgg-render img")].map((i) => i.decode().catch(() => null)))).then(() => true)');
      const drawn = await deck.page.shot(null, CLIP);
      await deck.page.eval(HIDE);
      rows.push({ id: w.id, ...pixelDiff(page, drawn) });
    }
  }
  log(`  anim-render per step: ${rows.map((r) => `${r.id} ${(r.share * 100).toFixed(2)}%`).join(', ')}`);
  const bad = rows.filter((r) => r.share > RENDER_TOL.share).map((r) => `${r.id} end: ${(r.share * 100).toFixed(2)}% of pixels differ by more than ${RENDER_TOL.level} (mean ${r.mean.toFixed(2)})`);
  const worst = rows.reduce((a, r) => (r.share > a.share ? r : a), { share: 0, id: '-' });
  return { ok: !bad.length && rows.length > 0, bad, detail: `${rows.length - bad.length}/${rows.length} step ends: the slide drawn from its XML at the simulated state against the page, at most ${RENDER_TOL.share * 100}% of pixels off by more than ${RENDER_TOL.level} (worst ${worst.id} ${(worst.share * 100).toFixed(2)}%)` };
}
