#!/usr/bin/env node
// pptx-anim-probe.mjs (for development): the PowerPoint spike of the editable deck's animation. Writes one small
// .pptx per candidate encoding (P01..P13, so a file PowerPoint wants to repair cannot hide the others) and
// probe.json, which says per file what to look at and how many effects and clicks PowerPoint should report.
// The XML here is written by hand, on purpose apart from pptx-anim-xml.mjs: the spike tests the encodings themselves.
// On a Windows PC with PowerPoint, `pptx.mjs com --anim <file> <dir>` opens one file and reports its effects, the
// click count, a capture after every click and a video (pptx-com.ps1 -Anim); --com runs that for every file.
//
//   node scripts/pptx-anim-probe.mjs <out dir> [--force]
//   node scripts/pptx-anim-probe.mjs --com <out dir> [--force]     (Windows with PowerPoint: run every probe)
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { patchSlide, writeNew } from './pptx-common.mjs';
import { exitOf, pptxgen } from './vendor.mjs';

const W = 13.333, PXIN = W / 1920;
const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

// ---------- XML pieces (hand written, one per behavior) ----------
function counter() { let n = 2; return () => ++n; }
const tgt = (spid) => `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>`;
const cond = (ms) => `<p:stCondLst><p:cond delay="${ms}"/></p:stCondLst>`;
const ctn = (id, dur, ms = 0, extra = '') => `<p:cTn id="${id}" dur="${dur}"${extra} fill="hold">${cond(ms)}</p:cTn>`;
const setVis = (id, spid, vis, ms = 0) => `<p:set><p:cBhvr>${ctn(id(), 1, ms)}${tgt(spid)}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="${vis}"/></p:to></p:set>`;
const effectBhvr = (id, spid, dir, filter, dur, extra = '') => `<p:animEffect transition="${dir}" filter="${filter}"><p:cBhvr>${ctn(id(), dur, 0, extra)}${tgt(spid)}</p:cBhvr></p:animEffect>`;
const tav = (keys, kind = 'strVal') => `<p:tavLst>${keys.map(([tm, v]) => `<p:tav tm="${tm}"><p:val><p:${kind} val="${v}"/></p:val></p:tav>`).join('')}</p:tavLst>`;
const anim = (id, spid, attr, dur, keys, kind) => `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base">${ctn(id(), dur)}${tgt(spid)}<p:attrNameLst><p:attrName>${attr}</p:attrName></p:attrNameLst></p:cBhvr>${tav(keys, kind)}</p:anim>`;
// one effect: preset attributes (null: none written), node type, delay, behaviors
function effect(id, preset, node, ms, body) {
  const pa = preset ? ` presetID="${preset[1]}" presetClass="${preset[0]}" presetSubtype="${preset[2] || 0}"` : '';
  return `<p:par><p:cTn id="${id()}"${pa} fill="hold" grpId="0" nodeType="${node}">${cond(ms)}<p:childTnLst>${body}</p:childTnLst></p:cTn></p:par>`;
}
// a click group (or the automatic first group) of effects that all start with the first
function group(id, auto, effects) {
  const start = auto ? '<p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst>' : '<p:stCondLst><p:cond delay="indefinite"/></p:stCondLst>';
  const body = effects.map((f, i) => f(i === 0 ? (auto ? 'afterEffect' : 'clickEffect') : 'withEffect')).join('');
  return `<p:par><p:cTn id="${id()}" fill="hold">${start}<p:childTnLst><p:par><p:cTn id="${id()}" fill="hold">${cond(0)}<p:childTnLst>${body}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`;
}
function timing(groups, bld = '') {
  return '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'
    + `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${groups.join('')}</p:childTnLst></p:cTn>`
    + '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>'
    + `</p:childTnLst></p:cTn></p:par></p:tnLst>${bld ? `<p:bldLst>${bld}</p:bldLst>` : ''}</p:timing>`;
}
const transition = (ms) => `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:p14="${P14}" Requires="p14"><p:transition spd="fast" p14:dur="${ms}"><p:fade/></p:transition></mc:Choice><mc:Fallback><p:transition spd="fast"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>`;
const fadeIn = (id, s, dur, extra) => (node) => effect(id, ['entr', 10], node, 0, setVis(id, s, 'visible') + effectBhvr(id, s, 'in', 'fade', dur, extra));
const fadeOut = (id, s, dur, extra) => (node) => effect(id, ['exit', 10], node, 0, effectBhvr(id, s, 'out', 'fade', dur, extra) + setVis(id, s, 'hidden', dur - 1));
// an 'out' (decelerating) curve of 300 px to the right of the rest place, back to it, as 6 keyframes
const OUT_KEYS = [[0, '#ppt_x+0.15625'], [20000, '#ppt_x+0.07'], [40000, '#ppt_x+0.03'], [60000, '#ppt_x+0.01'], [80000, '#ppt_x+0.002'], [100000, '#ppt_x']];
const MOTION = ['emph', 0];

// ---------- the probes: what is on the slide, its timing, what to look at ----------
// shapes: [name, kind ('box' | 'text' | 'pic'), x, y, w, h (stage px), text]. timing(ids by name, id counter) -> XML.
const PROBES = [
  { id: 'P01', file: 'P01-fade-ease', check: 'Fade 진입과 끝내기의 accel, decel. A 는 고르게, B 는 천천히 시작, C 는 천천히 끝남(1초)', clicks: 1, effects: 6,
    shapes: [['A', 'box', 300, 400, 300, 200, 'A'], ['B', 'box', 810, 400, 300, 200, 'B accel'], ['C', 'box', 1320, 400, 300, 200, 'C decel']],
    timing: (s, id) => timing([group(id, true, [fadeIn(id, s.A, 1000), fadeIn(id, s.B, 1000, ' accel="100000"'), fadeIn(id, s.C, 1000, ' decel="100000"')]),
      group(id, false, [fadeOut(id, s.A, 1000), fadeOut(id, s.B, 1000, ' accel="50000"'), fadeOut(id, s.C, 1000, ' decel="50000"')])]) },
  { id: 'P02', file: 'P02-fade-with-move', check: 'Fade 진입 안의 ppt_x 표본 키프레임: A 가 300px 오른쪽에서 왼쪽으로 감속하며 나타남(1초). 끝에서 제자리', clicks: 0, effects: 1,
    shapes: [['A', 'box', 700, 400, 300, 200, 'A']],
    timing: (s, id) => timing([group(id, true, [(n) => effect(id, ['entr', 10], n, 0, setVis(id, s.A, 'visible') + effectBhvr(id, s.A, 'in', 'fade', 1000) + anim(id, s.A, 'ppt_x', 1000, OUT_KEYS))])]) },
  { id: 'P03', file: 'P03-size-text', check: 'ppt_w, ppt_h 를 0.4 배로(클릭 1): 글자도 함께 작아지는지, 가운데 기준인지', clicks: 1, effects: 1,
    shapes: [['T', 'text', 500, 400, 920, 200, '가나다 ABC 123']],
    timing: (s, id) => timing([group(id, false, [(n) => effect(id, MOTION, n, 0, anim(id, s.T, 'ppt_w', 1000, [[0, '#ppt_w'], [100000, '#ppt_w*0.4']]) + anim(id, s.T, 'ppt_h', 1000, [[0, '#ppt_h'], [100000, '#ppt_h*0.4']]))])]) },
  { id: 'P04', file: 'P04-animscale', check: 'p:animScale zoomContents="1" 로 40% 까지(클릭 1): 글자도 함께 작아지는지', clicks: 1, effects: 1,
    shapes: [['T', 'text', 500, 400, 920, 200, '가나다 ABC 123']],
    timing: (s, id) => timing([group(id, false, [(n) => effect(id, ['emph', 6], n, 0, `<p:animScale zoomContents="1"><p:cBhvr>${ctn(id(), 1000)}${tgt(s.T)}</p:cBhvr><p:by x="40000" y="40000"/></p:animScale>`)])]) },
  { id: 'P05', file: 'P05-opacity-fromto', check: 'style.opacity 의 p:anim from 1 to 0.35(클릭 1, 1초): 부드럽게 흐려지고 끝에서 35% 로 남는지', clicks: 1, effects: 1,
    shapes: [['A', 'box', 700, 400, 500, 250, 'A 1 to 0.35']],
    timing: (s, id) => timing([group(id, false, [(n) => effect(id, MOTION, n, 0, `<p:anim calcmode="lin" valueType="num" from="1" to="0.35"><p:cBhvr>${ctn(id(), 1000)}${tgt(s.A)}<p:attrNameLst><p:attrName>style.opacity</p:attrName></p:attrNameLst></p:cBhvr></p:anim>`)])]) },
  { id: 'P06', file: 'P06-opacity-tav', check: 'style.opacity 의 p:anim tavLst 1 에서 0.35(클릭 1, 1초): 부드럽게 흐려지는지', clicks: 1, effects: 1,
    shapes: [['A', 'box', 700, 400, 500, 250, 'A tav']],
    timing: (s, id) => timing([group(id, false, [(n) => effect(id, MOTION, n, 0, `<p:anim calcmode="lin" valueType="num"><p:cBhvr>${ctn(id(), 1000)}${tgt(s.A)}<p:attrNameLst><p:attrName>style.opacity</p:attrName></p:attrNameLst></p:cBhvr>${tav([[0, '1'], [100000, '0.35']], 'fltVal')}</p:anim>`)])]) },
  { id: 'P07', file: 'P07-transparency', check: 'Transparency 강조 presetID 9 로 0.35(클릭 1, 1초): 부드럽게 바뀌는지, 한 번에 바뀌는지', clicks: 1, effects: 1,
    shapes: [['A', 'box', 700, 400, 500, 250, 'A transparency']],
    timing: (s, id) => timing([group(id, false, [(n) => effect(id, ['emph', 9], n, 0, `<p:set><p:cBhvr>${ctn(id(), 1000)}${tgt(s.A)}<p:attrNameLst><p:attrName>style.opacity</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="0.35"/></p:to></p:set><p:animEffect filter="image" prLst="opacity: 0.35"><p:cBhvr rctx="IE">${ctn(id(), 1000)}${tgt(s.A)}</p:cBhvr></p:animEffect>`)])]) },
  { id: 'P08', file: 'P08-wipe', check: 'Wipe 방향 문자열: 상자 글자가 말하는 쪽부터 드러나는지(left 8, right 2, up 1, down 4)', clicks: 0, effects: 4,
    shapes: [['L', 'box', 200, 400, 300, 200, 'from left'], ['R', 'box', 600, 400, 300, 200, 'from right'], ['U', 'box', 1000, 400, 300, 200, 'from top'], ['D', 'box', 1400, 400, 300, 200, 'from bottom']],
    timing: (s, id) => timing([group(id, true, [['L', 8, 'left'], ['R', 2, 'right'], ['U', 1, 'up'], ['D', 4, 'down']].map(([k, sub, dir]) => (n) => effect(id, ['entr', 22, sub], n, 0, setVis(id, s[k], 'visible') + effectBhvr(id, s[k], 'in', `wipe(${dir})`, 1500))))]) },
  { id: 'P09', file: 'P09-rotate', check: 'p:anim attrName="r" fltVal 45 와 p:animRot by 2700000: 둘 다 시계 방향 45도로 끝나는지(클릭 1)', clicks: 1, effects: 2,
    shapes: [['R', 'box', 500, 400, 300, 200, 'r 45'], ['S', 'box', 1100, 400, 300, 200, 'animRot']],
    timing: (s, id) => timing([group(id, false, [(n) => effect(id, MOTION, n, 0, anim(id, s.R, 'r', 1000, [[0, '0'], [100000, '45']], 'fltVal')),
      (n) => effect(id, ['emph', 8], n, 0, `<p:animRot by="2700000"><p:cBhvr>${ctn(id(), 1000)}${tgt(s.S)}<p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst></p:cBhvr></p:animRot>`)])]) },
  { id: 'P10', file: 'P10-click-seek', check: '클릭 1 은 3초 이동. 이동 중에 다시 클릭하면 끝 상태로 마치고(다음 묶음으로 가지 않음), 그다음 클릭에 B 가 나타나는지', clicks: 2, effects: 2,
    shapes: [['A', 'box', 300, 300, 300, 200, 'A'], ['B', 'box', 300, 650, 300, 200, 'B']],
    timing: (s, id) => timing([group(id, false, [(n) => effect(id, MOTION, n, 0, anim(id, s.A, 'ppt_x', 3000, [[0, '#ppt_x'], [100000, '#ppt_x+0.5']]))]), group(id, false, [fadeIn(id, s.B, 500)])]) },
  { id: 'P11', file: 'P11-transition-auto', check: '전환 Fade 0.25초(p14:dur 250) 뒤 A 가 클릭 없이 나타나는지', clicks: 0, effects: 1, transition: 250,
    shapes: [['A', 'box', 700, 400, 500, 250, 'A auto']],
    timing: (s, id) => timing([group(id, true, [fadeIn(id, s.A, 500)])]) },
  { id: 'P12a', file: 'P12a-preset0', check: 'presetID 0 presetClass emph 효과(ppt_x 이동)로 고치기 창이 뜨지 않는지, 애니메이션 창 이름', clicks: 1, effects: 1,
    shapes: [['A', 'box', 300, 400, 300, 200, 'A']],
    timing: (s, id) => timing([group(id, false, [(n) => effect(id, MOTION, n, 0, anim(id, s.A, 'ppt_x', 1000, [[0, '#ppt_x'], [100000, '#ppt_x+0.4']]))])]) },
  { id: 'P12b', file: 'P12b-nopreset', check: 'presetID, presetClass 가 없는 효과로 고치기 창이 뜨지 않는지', clicks: 1, effects: 1,
    shapes: [['A', 'box', 300, 400, 300, 200, 'A']],
    timing: (s, id) => timing([group(id, false, [(n) => effect(id, null, n, 0, anim(id, s.A, 'ppt_x', 1000, [[0, '#ppt_x'], [100000, '#ppt_x+0.4']]))])]) },
  { id: 'P13', file: 'P13-bldp-pic', check: 'p:pic 에 p:bldP 를 쓰면 고치기 창이 뜨는지(뜨면 편집 덱이 그림에 bldP 를 쓰지 않는 근거)', clicks: 0, effects: 1, bldPic: true,
    shapes: [['P', 'pic', 700, 300, 400, 400, '']],
    timing: (s, id) => timing([group(id, true, [fadeIn(id, s.P, 800)])], `<p:bldP spid="${s.P}" grpId="0"/>`) },
];

// a 64x64 opaque PNG of one color
function png(rgb) {
  const chunk = (type, data) => { const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type, 'latin1'), data]); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 64 }, () => rgb).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(64).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

function addShapes(p, s, pr) {
  s.addText(`${pr.id}: ${pr.check}`, { x: 0.3, y: 0.2, w: W - 0.6, h: 1, fontSize: 16, color: 'FFFFFF', objectName: 'label' });
  for (const [name, kind, x, y, w, h, text] of pr.shapes) {
    const pos = { x: x * PXIN, y: y * PXIN, w: w * PXIN, h: h * PXIN, objectName: name };
    if (kind === 'pic') s.addImage({ data: `image/png;base64,${png([224, 38, 63]).toString('base64')}`, ...pos });
    else if (kind === 'text') s.addText(text, { ...pos, fontSize: 40, color: 'FFFFFF', margin: 0, align: 'center', valign: 'middle' });
    else s.addText(text, { ...pos, shape: p.ShapeType.rect, fill: { color: 'E0263F' }, fontSize: 24, color: 'FFFFFF', align: 'center', valign: 'middle' });
  }
}

/** Builds one probe file; returns its bytes. */
export async function probeBytes(pr) {
  const { PptxGenJS, JSZip } = pptxgen();
  const p = new PptxGenJS();
  p.layout = 'LAYOUT_WIDE';
  const s = p.addSlide();
  s.background = { color: '14151C' };
  addShapes(p, s, pr);
  const zip = await JSZip.loadAsync(await p.write({ outputType: 'nodebuffer', compression: false }));
  const r = patchSlide(await zip.file('ppt/slides/slide1.xml').async('string'));
  const ids = Object.fromEntries(r.ids.map((x) => [x.name, x.id]));
  const xml = pr.timing(ids, counter());
  zip.file('ppt/slides/slide1.xml', r.xml.replace('</p:clrMapOvr>', () => `</p:clrMapOvr>${pr.transition ? transition(pr.transition) : ''}${xml}`));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** Writes every probe file and probe.json into dir; returns the list of { id, file, check, clicks, effects }. */
export async function writeProbes(dir, { force = false } = {}) {
  if (!force && existsSync(dir) && readdirSync(dir).length) throw Object.assign(new Error(`${dir} is not empty; not overwriting (use --force)`), { exit: 2 });
  mkdirSync(dir, { recursive: true });
  const list = [];
  for (const pr of PROBES) {
    writeNew(join(dir, `${pr.file}.pptx`), await probeBytes(pr), force);
    list.push({ id: pr.id, file: `${pr.file}.pptx`, check: pr.check, clicks: pr.clicks, effects: pr.effects });
  }
  writeNew(join(dir, 'probe.json'), Buffer.from(JSON.stringify({ probes: list }, null, 2) + '\n'), force);
  return list;
}

export const PROBE_IDS = PROBES.map((p) => p.id);

// real paths on both sides: node runs a script reached through a link (macOS /var is /private/var) by its real path.
// A name realpath cannot read (argv[1] of `node -e`, for one) is compared as given, so importing this file never throws.
const ranAs = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && ranAs(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), force = argv.includes('--force'), com = argv.includes('--com');
  const pos = argv.filter((a) => !a.startsWith('--'));
  if (pos.length !== 1 || argv.some((a) => a.startsWith('--') && !['--force', '--com'].includes(a))) { process.stderr.write('usage: node scripts/pptx-anim-probe.mjs <out dir> [--force]\n       node scripts/pptx-anim-probe.mjs --com <out dir> [--force]\n'); process.exit(2); }
  try {
    const dir = resolve(pos[0]);
    if (com) {
      const { animComAll } = await import('./pptx-anim-com.mjs');
      const r = await animComAll(dir, JSON.parse(readFileSync(join(dir, 'probe.json'), 'utf8')).probes, { force });
      for (const l of r.lines) process.stdout.write(l + '\n');
      process.exit(r.ok ? 0 : 1);
    }
    const list = await writeProbes(dir, { force });
    for (const x of list) process.stdout.write(`${x.id} ${join(dir, x.file)}: ${x.check}\n`);
    process.stdout.write(`probe ${list.length} files and probe.json in ${dir}\n`);
  } catch (e) {
    process.stderr.write(`pptx-anim-probe: ${e.message}\n`);
    process.exit(exitOf(e, 1));
  }
}
