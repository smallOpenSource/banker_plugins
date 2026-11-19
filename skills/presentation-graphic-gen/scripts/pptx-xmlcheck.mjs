// pptx-xmlcheck.mjs: a small XML reader and the structure checks of the editable deck's slide XML (the anim-xml gate).
// The reader gives a tree of { name, attrs, kids, text, parent }; it throws on XML that is not well formed (an end
// tag that does not match, an unclosed tag, a bad attribute, text after the root). The checks look for what makes
// PowerPoint offer to repair a file or silently drop its timing: element order, cTn ids, targets, the build list,
// keyframe times, preset pairs, delays and durations, namespaces.
const NAME = /[A-Za-z_][\w.:-]*/y;
const ATTR = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;

function xmlError(msg, at) { return Object.assign(new Error(`${msg} at offset ${at}`), { xml: true }); }

// one start or empty tag from offset i (just after '<'): { node, end, empty }
function readTag(xml, i, parent) {
  NAME.lastIndex = i;
  const m = NAME.exec(xml);
  if (!m) throw xmlError('bad tag name', i);
  const node = { name: m[0], attrs: {}, kids: [], text: '', parent };
  let j = NAME.lastIndex;
  for (;;) {
    ATTR.lastIndex = j;
    const a = ATTR.exec(xml);
    if (!a) break;
    if (Object.hasOwn(node.attrs, a[1])) throw xmlError(`attribute ${a[1]} twice`, j);
    node.attrs[a[1]] = a[2] != null ? a[2] : a[3];
    j = ATTR.lastIndex;
  }
  const close = /\s*(\/?)>/y;
  close.lastIndex = j;
  const c = close.exec(xml);
  if (!c) throw xmlError(`bad tag <${node.name}`, j);
  return { node, end: close.lastIndex, empty: c[1] === '/' };
}

function skipSpecial(xml, i) {
  for (const [open, shut] of [['<?', '?>'], ['<!--', '-->']]) {
    if (xml.startsWith(open, i)) {
      const k = xml.indexOf(shut, i);
      if (k < 0) throw xmlError(`unclosed ${open}`, i);
      return k + shut.length;
    }
  }
  return -1;
}

// one markup item at lt ('<'): a comment or declaration is skipped, an end tag closes cur, a start tag opens a child.
// Returns { cur, i }: the open element and the offset after the item.
function step(xml, lt, cur) {
  const sp = skipSpecial(xml, lt);
  if (sp >= 0) return { cur, i: sp };
  if (xml[lt + 1] === '/') {
    const gt = xml.indexOf('>', lt), name = gt < 0 ? '' : xml.slice(lt + 2, gt).trim();
    if (name !== cur.name) throw xmlError(`end tag </${name}> does not close <${cur.name}>`, lt);
    return { cur: cur.parent, i: gt + 1 };
  }
  const t = readTag(xml, lt + 1, cur);
  cur.kids.push(t.node);
  return { cur: t.empty ? cur : t.node, i: t.end };
}

/** Parses XML into a tree; returns the root element. Throws { xml: true } when it is not well formed. */
export function parseXml(xml) {
  const top = { name: '#doc', attrs: {}, kids: [], text: '', parent: null };
  let at = { cur: top, i: 0 };
  for (let lt = xml.indexOf('<'); lt >= 0; lt = xml.indexOf('<', at.i)) {
    at.cur.text += xml.slice(at.i, lt);
    at = step(xml, lt, at.cur);
  }
  at.cur.text += xml.slice(at.i);
  if (at.cur !== top) throw xmlError(`<${at.cur.name}> is not closed`, xml.length);
  if (top.kids.length !== 1 || top.text.trim()) throw xmlError('not exactly one root element', 0);
  return top.kids[0];
}

/** Every element below node (depth first, document order), node itself first. */
export function walk(node, out = []) {
  out.push(node);
  for (const k of node.kids) walk(k, out);
  return out;
}
export const kid = (node, name) => node.kids.find((k) => k.name === name) || null;
export const kidsNamed = (node, name) => node.kids.filter((k) => k.name === name);

// ---------- checks ----------
const ORDER = ['p:cSld', 'p:clrMapOvr', 'p:transition', 'p:timing', 'p:extLst'];
/** Effect presets this deck may use: presetClass -> presetIDs (Fade 10, Appear 1, Wipe 22, custom motion 0, Transparency 9). */
export const PRESETS = { entr: [1, 10, 22], exit: [1, 10, 22], emph: [0, 9] };

function orderProblems(root) {
  const seen = root.kids.map((k) => (k.name === 'mc:AlternateContent' ? 'p:transition' : k.name));
  const bad = seen.filter((n) => !ORDER.includes(n)).map((n) => `unexpected <${n}> in <p:sld>`);
  const idx = seen.filter((n) => ORDER.includes(n)).map((n) => ORDER.indexOf(n));
  if (idx.some((v, i) => i && v <= idx[i - 1])) bad.push(`slide parts out of order: ${seen.join(', ')} (want ${ORDER.join(', ')})`);
  return bad;
}

// shapes of the slide: id -> { tag, text (has <a:t>), name }
export function slideShapes(root) {
  const tree = walk(root).find((n) => n.name === 'p:spTree');
  const out = new Map();
  if (!tree) return out;
  for (const n of walk(tree)) {
    if (!['p:sp', 'p:pic', 'p:cxnSp', 'p:graphicFrame'].includes(n.name)) continue;
    const pr = walk(n).find((x) => x.name === 'p:cNvPr');
    if (pr) out.set(pr.attrs.id, { tag: n.name, name: pr.attrs.name || '', text: walk(n).some((x) => x.name === 'a:t' && x.text.trim()), node: n });
  }
  return out;
}

const isInt = (v, min = 0) => /^\d+$/.test(String(v)) && +v >= min;

const timeOk = (v, min) => v == null || v === 'indefinite' || isInt(v, min);
const pct = (v) => (v == null ? 0 : Number(v));
function presetProblem(a) {
  if (a.presetClass == null && a.presetID == null) return /Effect$/.test(a.nodeType || '') ? `cTn ${a.id}: an effect without presetClass and presetID` : null;
  const ok = Object.hasOwn(PRESETS, a.presetClass) && PRESETS[a.presetClass].includes(+a.presetID);
  return ok ? null : `cTn ${a.id}: presetClass "${a.presetClass}" presetID "${a.presetID}" is not an allowed pair`;
}
// one cTn's own attributes: dur, accel and decel (0..100000, together at most 100000), the preset pair
function ctnAttrProblems(a) {
  const bad = [];
  if (!timeOk(a.dur, 1)) bad.push(`cTn ${a.id}: dur "${a.dur}"`);
  const ac = pct(a.accel), dc = pct(a.decel);
  if (![ac, dc].every((v) => Number.isInteger(v) && v >= 0 && v <= 100000) || ac + dc > 100000) bad.push(`cTn ${a.id}: accel ${a.accel} decel ${a.decel}`);
  const p = presetProblem(a);
  return p ? bad.concat(p) : bad;
}
function ctnProblems(nodes) {
  const bad = [], ids = new Set();
  for (const n of nodes.filter((x) => x.name === 'p:cTn')) {
    const a = n.attrs;
    if (!isInt(a.id, 1)) bad.push(`cTn id "${a.id}" is not a positive integer`);
    else if (ids.has(a.id)) bad.push(`cTn id ${a.id} is used twice`);
    ids.add(a.id);
    bad.push(...ctnAttrProblems(a));
  }
  for (const c of nodes.filter((x) => x.name === 'p:cond' && !timeOk(x.attrs.delay, 0))) bad.push(`cond delay "${c.attrs.delay}" is not indefinite or a whole number of ms >= 0`);
  return bad;
}

function tavProblems(nodes) {
  const bad = [];
  for (const l of nodes.filter((x) => x.name === 'p:tavLst')) {
    const tms = kidsNamed(l, 'p:tav').map((t) => t.attrs.tm);
    if (!tms.every((t) => isInt(t) && +t <= 100000)) bad.push(`tav tm ${tms.join(',')} outside 0..100000`);
    else if (tms.some((t, i) => i && +t <= +tms[i - 1]) || +tms[0] !== 0) bad.push(`tav tm ${tms.join(',')} not ascending from 0`);
  }
  return bad;
}

// the effect cTn (one with a presetClass) above a behavior node
function effectOf(n) {
  for (let p = n.parent; p; p = p.parent) if (p.name === 'p:cTn' && p.attrs.presetClass) return p;
  return null;
}

// effects per spid and group: "spid/grpId" -> Set of effect cTn ids
function effectsByGroup(nodes) {
  const groups = new Map();
  for (const t of nodes.filter((x) => x.name === 'p:spTgt')) {
    const e = effectOf(t), key = e && `${t.attrs.spid}/${e.attrs.grpId}`;
    if (key) groups.set(key, (groups.get(key) || new Set()).add(e.attrs.id));
  }
  return groups;
}
function bldProblems(b, shapes, groups) {
  const sh = shapes.get(b.attrs.spid), fx = groups.get(`${b.attrs.spid}/${b.attrs.grpId}`);
  const bad = [];
  if (!sh || sh.tag !== 'p:sp' || !sh.text) bad.push(`bldP spid ${b.attrs.spid} is not a shape with text (p:sp)`);
  if (!fx) bad.push(`bldP spid ${b.attrs.spid} grpId ${b.attrs.grpId} has no effect of that group`);
  else if (fx.size > 1) bad.push(`bldP spid ${b.attrs.spid} grpId ${b.attrs.grpId} has ${fx.size} effects (PowerPoint keeps only the first)`);
  return bad;
}
function targetProblems(nodes, shapes) {
  const bad = nodes.filter((x) => x.name === 'p:spTgt' && !shapes.has(x.attrs.spid)).map((t) => `target spid ${t.attrs.spid} is not a shape on this slide`);
  const groups = effectsByGroup(nodes);
  for (const b of nodes.filter((x) => x.name === 'p:bldP')) bad.push(...bldProblems(b, shapes, groups));
  return bad;
}

// what PowerPoint 2019 was measured not to play as written: a Fade or Wipe filter with fill="hold" (a later Fade out
// of the shape does not play: X4), a style.opacity set followed by a Fade in in one effect (it ends at full opacity: X1)
function heldFilters(nodes) {
  return nodes.filter((x) => x.name === 'p:animEffect').map((a) => walk(a).find((x) => x.name === 'p:cTn'))
    .filter((c) => c && c.attrs.fill === 'hold').map((c) => `animEffect cTn ${c.attrs.id}: fill="hold" (a later Fade out of the shape does not play)`);
}
const isOpacitySet = (x) => x.name === 'p:set' && walk(x).some((y) => y.name === 'p:attrName' && y.text.trim() === 'style.opacity');
const isFadeIn = (x) => x.name === 'p:animEffect' && x.attrs.transition === 'in' && x.attrs.filter === 'fade';
function playProblems(nodes) {
  const bad = heldFilters(nodes);
  for (const e of nodes.filter((x) => x.name === 'p:cTn' && x.attrs.presetClass)) {
    const all = walk(e);
    if (all.some(isOpacitySet) && all.some(isFadeIn)) bad.push(`cTn ${e.attrs.id}: style.opacity set before a Fade in (the Fade ends at full opacity)`);
  }
  return bad;
}

// every prefix in use is declared; p14 outside mc:Choice needs mc:Ignorable on the root
// the prefixes of an element's name and attributes that are not declared in scope, or p14 where it may not be
function prefixProblems(n, scope, ignorable) {
  const out = [];
  for (const q of [n.name, ...Object.keys(n.attrs).filter((k) => !k.startsWith('xmlns'))]) {
    const pre = q.includes(':') ? q.split(':')[0] : null;
    if (pre && pre !== 'xml' && !scope.has(pre)) out.push(`prefix ${pre} of <${n.name}> is not declared`);
    if (pre === 'p14' && !ignorable && !insideChoice(n)) out.push('p14 used outside mc:Choice without mc:Ignorable="p14"');
  }
  return out;
}
function nsProblems(root) {
  const bad = new Set(), ignorable = (root.attrs['mc:Ignorable'] || '').split(/\s+/).includes('p14');
  const visit = (n, scope) => {
    const s = new Set([...scope, ...Object.keys(n.attrs).filter((k) => k.startsWith('xmlns:')).map((k) => k.slice(6))]);
    for (const p of prefixProblems(n, s, ignorable)) bad.add(p);
    for (const k of n.kids) visit(k, s);
  };
  visit(root, []);
  return [...bad];
}
function insideChoice(n) { for (let p = n; p; p = p.parent) if (p.name === 'mc:Choice') return true; return false; }

/** Structure problems of one slide's XML (empty: none). */
export function checkSlide(xml) {
  let root;
  try { root = parseXml(xml); } catch (e) { return [`not well formed: ${e.message}`]; }
  if (root.name !== 'p:sld') return [`root is <${root.name}>, not <p:sld>`];
  const timing = kid(root, 'p:timing');
  const nodes = timing ? walk(timing) : [];
  return [...orderProblems(root), ...nsProblems(root), ...ctnProblems(nodes), ...tavProblems(nodes), ...targetProblems(nodes, slideShapes(root)), ...playProblems(nodes)];
}
