// pptx-common.mjs: what the two PowerPoint writers (pptx-video.mjs, pptx-edit.mjs) and the checker (pptx.mjs) share:
// notes text, slide titles, theme fonts, XML patches, the no-overwrite write and a small MP4 box reader.
import { randomBytes } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';

export const LATIN = 'Noto Sans';
export const KR = 'Noto Sans KR';
export const SLIDE_W = 13.333, SLIDE_H = 7.5; // inches, 16:9 (LAYOUT_WIDE)
export const PX = SLIDE_W / 1920; // inches per stage px
export const MASTER = 'PGG';

/** Speaker notes: the spoken lines, then (apart, after a blank line) each stage direction in brackets. */
export function notesText(step) {
  const speech = String(step.speech || '').trim();
  const dirs = (step.directions || []).map((d) => `[${d}]`);
  return [speech, dirs.join('\n')].filter(Boolean).join('\n\n');
}

/** A unique slide title: the step key and its first 화면 line. */
export const slideTitle = (step) => `${step.key} ${step.lines[0] || ''}`.trim();

/** Slide master with a title placeholder (the title is hidden on every slide, but screen readers and the outline get it). */
export function defineMaster(p, bg = '000000') {
  p.defineSlideMaster({
    title: MASTER,
    background: { color: bg },
    objects: [{ placeholder: { options: { name: 'title', type: 'title', x: 0.4, y: 0.2, w: SLIDE_W - 0.8, h: 0.8, fontSize: 24 }, text: '' } }],
  });
}

/** Theme fonts: Latin Noto Sans, East Asian and Hangul Noto Sans KR. */
export function patchTheme(xml) {
  return xml
    .replace(/<a:latin typeface="[^"]*"/g, `<a:latin typeface="${LATIN}"`)
    .replace(/<a:ea typeface="[^"]*"/g, `<a:ea typeface="${KR}"`)
    .replace(/<a:font script="Hang" typeface="[^"]*"/g, `<a:font script="Hang" typeface="${KR}"`);
}

/**
 * Slide XML fixes: shape ids renumbered 1..n in document order (PptxGenJS can give a media picture an id that clashes),
 * the title placeholder hidden, Korean as the language of new text. Returns { xml, ids: [{ id, name }] }.
 */
export function patchSlide(xml) {
  let n = 0;
  const ids = [];
  xml = xml.replace(/<p:cNvPr id="\d+" name="([^"]*)"/g, (m, name) => { ids.push({ id: ++n, name }); return `<p:cNvPr id="${n}" name="${name}"`; });
  // hide the title placeholder shape
  xml = xml.replace(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:ph[^>]*\btype="title"[\s\S]*?<\/p:sp>/, (m) => m.replace(/<p:cNvPr id="(\d+)" name="([^"]*)"/, '<p:cNvPr id="$1" name="$2" hidden="1"'));
  xml = xml.replace(/<a:(endParaRPr|rPr) lang="en-US"/g, '<a:$1 lang="ko-KR"');
  return { xml, ids };
}

/**
 * Notes XML: PptxGenJS writes the notes as one run with raw line breaks inside <a:t>; PowerPoint wants one
 * paragraph per line. The body placeholder's text is rebuilt as Korean paragraphs (an empty line stays empty).
 */
export function patchNotes(xml) {
  return xml.replace(/(<p:ph type="body"[^>]*\/>[\s\S]*?<p:txBody><a:bodyPr\/><a:lstStyle\/>)([\s\S]*?)(<\/p:txBody>)/, (m, head, body, tail) => {
    const text = [...body.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((x) => x[1]).join('');
    const paras = text.split(/\r?\n/).map((l) => (l ? `<a:p><a:r><a:rPr lang="ko-KR" dirty="0"/><a:t>${l}</a:t></a:r></a:p>` : '<a:p><a:endParaRPr lang="ko-KR" dirty="0"/></a:p>'));
    return head + paras.join('') + tail;
  });
}

/** Writes bytes to path: exclusive create, or (force) a random temporary name renamed over the target. */
export function writeNew(path, bytes, force) {
  if (!force) {
    try { writeFileSync(path, bytes, { flag: 'wx' }); } catch (e) {
      if (e.code === 'EEXIST') throw Object.assign(new Error(`${path} exists; not overwriting (use --force)`), { exit: 2 });
      throw e;
    }
    return;
  }
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, bytes, { flag: 'wx' });
  renameSync(tmp, path);
}

export const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The text of each <a:p> of an XML fragment, one string per paragraph. */
export function paragraphs(xml) {
  return [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => xmlText([...m[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join('')));
}

// ---------- MP4 boxes ----------
function* boxes(buf, start, end) {
  for (let o = start; o + 8 <= end;) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    let head = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); head = 16; } else if (size === 0) size = end - o;
    if (size < head || o + size > end) return;
    yield { type, start: o, body: o + head, end: o + size };
    o += size;
  }
}
const find = (buf, path, start = 0, end = buf.length) => {
  let cur = { body: start, end };
  for (const t of path) {
    const next = [...boxes(buf, cur.body, cur.end)].find((b) => b.type === t);
    if (!next) return null;
    cur = next;
  }
  return cur;
};

/** { codec ('avc1' for H.264), width, height, samples, fps, sec } of the first video track; null when not an MP4. */
export function mp4Info(buf) {
  if (buf.length < 16 || !['ftyp', 'moov', 'mdat', 'free'].includes(buf.toString('latin1', 4, 8))) return null;
  const moov = find(buf, ['moov']);
  if (!moov) return null;
  for (const trak of boxes(buf, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const hdlr = find(buf, ['mdia', 'hdlr'], trak.body, trak.end);
    if (!hdlr || buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) !== 'vide') continue;
    const mdhd = find(buf, ['mdia', 'mdhd'], trak.body, trak.end);
    const v = buf[mdhd.body];
    const timescale = buf.readUInt32BE(mdhd.body + (v === 1 ? 20 : 12));
    const stbl = find(buf, ['mdia', 'minf', 'stbl'], trak.body, trak.end);
    const stsd = find(buf, ['stsd'], stbl.body, stbl.end);
    const entry = stsd.body + 8;
    const codec = buf.toString('latin1', entry + 4, entry + 8);
    const width = buf.readUInt16BE(entry + 32), height = buf.readUInt16BE(entry + 34);
    const avcC = codec === 'avc1' ? [...boxes(buf, entry + 86, entry + buf.readUInt32BE(entry))].some((b) => b.type === 'avcC') : false;
    const stts = find(buf, ['stts'], stbl.body, stbl.end);
    let samples = 0, ticks = 0, delta = 0;
    const n = buf.readUInt32BE(stts.body + 4);
    for (let i = 0; i < n; i++) { const c = buf.readUInt32BE(stts.body + 8 + i * 8), d = buf.readUInt32BE(stts.body + 12 + i * 8); samples += c; ticks += c * d; delta = delta || d; }
    return { codec, avcC, width, height, samples, fps: delta ? timescale / delta : 0, sec: ticks / timescale };
  }
  return null;
}
