#!/usr/bin/env node
// pptx-video.mjs: a PowerPoint deck with one slide per step, each slide one full-slide 16:9 video of that step
// (recorded by record.mjs). In the slide show the video starts by itself when the slide is entered, holds its last
// frame (no loop, no rewind); the next click or key goes to the next slide. The poster is the video's first frame.
// Notes = the step's spoken lines, then its [stage directions] apart. Every slide has a unique hidden title and
// the video has alt text.
//
//   node scripts/pptx-video.mjs <script.md> --media <record dir> --out <file.pptx> [--force]
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deckData, parseScript } from './build.mjs';
import { MASTER, SLIDE_H, SLIDE_W, defineMaster, notesText, patchNotes, patchSlide, patchTheme, slideTitle, writeNew } from './pptx-common.mjs';
import { exitOf, pptxgen } from './vendor.mjs';

// PowerPoint "Start: Automatically" for a video: playFrom(0.0) when the slide starts, shown while stopped, no repeat,
// no rewind (the last frame stays).
export function videoTiming(spid, ms) {
  return '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>' +
    '<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>' +
    '<p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst><p:childTnLst>' +
    '<p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>' +
    '<p:par><p:cTn id="5" presetID="1" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="afterEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>' +
    `<p:cmd type="call" cmd="playFrom(0.0)"><p:cBhvr><p:cTn id="6" dur="${ms}" fill="hold"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:cmd>` +
    '</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>' +
    '</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>' +
    `<p:video><p:cMediaNode vol="80000"><p:cTn id="7" fill="hold" display="0"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cMediaNode></p:video>` +
    '</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>';
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Builds the video deck from a parsed script and a record.mjs folder. Returns { out, bytes, slides }. */
export async function buildVideoPptx({ parsed, media, out, force = false }) {
  const data = deckData(parsed, 'review');
  const manifest = JSON.parse(readFileSync(join(media, 'manifest.json'), 'utf8'));
  if (manifest.steps.length !== data.steps.length) throw new Error(`${manifest.steps.length} videos for ${data.steps.length} steps`);
  const { PptxGenJS, JSZip } = pptxgen();
  const p = new PptxGenJS();
  p.layout = 'LAYOUT_WIDE';
  p.title = data.title;
  p.author = 'presentation-graphic-gen';
  p.company = '';
  p.theme = { headFontFace: 'Noto Sans', bodyFontFace: 'Noto Sans' };
  defineMaster(p);
  const slides = [];
  data.steps.forEach((st, i) => {
    const m = manifest.steps[i];
    if (m.id !== st.id) throw new Error(`slide ${i + 1}: video ${m.id}, script step ${st.id}`);
    const s = p.addSlide({ masterName: MASTER });
    s.addText(slideTitle(st), { placeholder: 'title' });
    const objectName = `video ${st.id}`;
    s.addMedia({
      type: 'video', data: `video/mp4;base64,${readFileSync(join(media, m.mp4)).toString('base64')}`,
      cover: `data:image/png;base64,${readFileSync(join(media, m.first)).toString('base64')}`,
      x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, objectName,
    });
    s.addNotes(notesText(st));
    slides.push({ id: st.id, objectName, ms: Math.round((m.frames / manifest.fps) * 1000), alt: `${st.key} 단계 화면 영상: ${st.lines.join(' / ')}` });
  });
  const raw = await p.write({ outputType: 'nodebuffer', compression: false });
  const zip = await JSZip.loadAsync(raw);
  const outZip = new JSZip();
  for (const name of Object.keys(zip.files).filter((n) => !zip.files[n].dir)) {
    let body;
    const sm = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (sm) {
      const sl = slides[Number(sm[1]) - 1];
      const r = patchSlide(await zip.file(name).async('string'));
      let xml = r.xml;
      const vid = r.ids.find((x) => x.name === sl.objectName);
      if (!vid) throw new Error(`slide ${sm[1]}: video shape missing`);
      const tag = `<p:cNvPr id="${vid.id}" name="${sl.objectName}"`;
      xml = xml.replace(tag, () => `${tag} descr="${esc(sl.alt)}"`); // a function: "$'" or "$&" in the alt text stays as written
      xml = xml.replace(/<a:ext cx="\d+" cy="6858000"\/>/, '<a:ext cx="12192000" cy="6858000"/>'); // exactly the slide width
      if (!xml.includes('</p:clrMapOvr>')) throw new Error(`slide ${sm[1]}: no p:clrMapOvr to put the timing after`);
      body = xml.replace('</p:clrMapOvr>', () => '</p:clrMapOvr>' + videoTiming(vid.id, sl.ms));
    } else if (/^ppt\/theme\/theme\d+\.xml$/.test(name)) body = patchTheme(await zip.file(name).async('string'));
    else if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)) body = patchNotes(await zip.file(name).async('string'));
    else if (/\.(xml|rels)$/.test(name)) body = await zip.file(name).async('string');
    else body = await zip.file(name).async('uint8array');
    outZip.file(name, body, { createFolders: false, compression: /\.(mp4|png|jpe?g)$/i.test(name) ? 'STORE' : 'DEFLATE' });
  }
  const bytes = await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  writeNew(out, bytes, force);
  return { out, bytes: bytes.length, slides: slides.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  let script = null, media = null, out = null, force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--media') media = resolve(argv[++i] || '');
    else if (argv[i] === '--out') out = resolve(argv[++i] || '');
    else if (argv[i] === '--force') force = true;
    else if (!argv[i].startsWith('--') && !script) script = resolve(argv[i]);
    else { process.stderr.write(`pptx-video: unknown argument ${argv[i]}\n`); process.exit(2); }
  }
  if (!script || !media || !out) { process.stderr.write('usage: node scripts/pptx-video.mjs <script.md> --media <record dir> --out <file.pptx> [--force]\n'); process.exit(2); }
  try {
    const parsed = parseScript(readFileSync(script, 'utf8'));
    if (parsed.errors.length) throw Object.assign(new Error(parsed.errors.join('; ')), { exit: 1 });
    const r = await buildVideoPptx({ parsed, media, out, force });
    process.stdout.write(`pptx-video ${r.out} ${r.slides} slides ${(r.bytes / 1048576).toFixed(1)} MiB\n`);
  } catch (e) {
    process.stderr.write(`pptx-video: ${e.message}\n`);
    process.exit(exitOf(e, 1));
  }
}
