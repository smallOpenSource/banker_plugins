#!/usr/bin/env node
// pptx.mjs: checks a PowerPoint file written by pptx-video.mjs or pptx-edit.mjs. One PASS / FAIL / SKIP line per
// gate; exit 1 when a gate fails, 2 on a usage error or an output folder that is not empty, 3 on a vendor check.
// The summary is ALL PASS only when no gate was skipped: "PASS with SKIP (<gates>)" otherwise (still exit 0).
//
//   node scripts/pptx.mjs verify <file.pptx> --script <script.md> [--media <record dir>] [--frames <dir>] [--force]
//   node scripts/pptx.mjs com <file.pptx> <png dir> [--force]   optional: PowerPoint (Windows) opens it, exports slide PNGs
// --frames writes the decoded frames the continuity gate compared (NN-last.png, NN-first.png). A non-empty --frames
// or PNG folder is refused (exit 2) unless --force.
//
// Both kinds: the zip opens, the slide size is 16:9, slide count = steps, every slide has notes equal to the step's
// spoken lines with its [stage directions] apart, and a unique hidden title.
// Video decks (slides with an embedded video): every slide has its MP4 part, the video shape, the autoplay timing
// (playFrom(0.0) at slide start, targeting that shape, no repeat), a poster picture and alt text; every MP4 is
// H.264 (avc1 + avcC); continuity: for every adjacent pair, the last frame of slide n's video and the first frame
// of slide n+1's video are compared after decoding in the browser (and, with --media, the recorded frames too).
// Editable decks: every slide has native text boxes with the theme fonts (Latin Noto Sans, East Asian Noto Sans KR).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deckData, parseScript, readText } from './build.mjs';
import { findBrowser, launch, scratchDir } from './cdp.mjs';
import { animGates } from './pptx-anim-gates.mjs';
import { KR, LATIN, mp4Info, notesText, paragraphs, sectionNotes, sectionTitle, slideTitle, xmlText } from './pptx-common.mjs';
import { decodePng } from './png.mjs';
import { exitOf, pptxgen } from './vendor.mjs';

// decoded-video continuity: mean channel difference and share of pixels off by more than 32 levels
export const VIDEO_MEAN_TOL = 0.5, VIDEO_SHARE_TOL = 0.001;

// the reply time of one compare() of FRAME_PAGE, longer than the 30 s of a protocol command: slide n's video played up
// to 5 times (each a seek of up to 5 s, then up to its length + 6 s), plus slide n+1's length and 30 s for loading both
// videos, the first frame and the comparison. Always finite, so a browser that stops answering still ends the gate.
export function compareMs(secA, secB) {
  const s = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
  return Math.min(2 ** 31 - 1, Math.ceil((5 * (5 + s(secA) + 6) + s(secB) + 30) * 1000));
}

// evaluated in a page next to the extracted MP4 files: RGBA of a video's first or last frame. First: the frame the
// element shows once loaded and painted. Last: a paused seek in a headless browser does not present the new frame,
// so the video plays from 0.3 s before its end, and the frame is drawn only inside a requestVideoFrameCallback that
// reports one of its last two frames (both inside the held end of a recorded step). 'ended' is not such a frame:
// after a seek into the last keyframe group, play() starts again from 0 or ends at once, and Windows Chrome can fire
// 'ended' before the end of the playback is presented, with the element still showing a frame from the middle of the
// animation. A play with no reported end frame is played again from 0 (plays > 1 in the result); none in 5 plays is
// an error.
export const FRAME_PAGE = `<!doctype html><meta charset="utf-8"><body><script>
const raf = () => new Promise((ok) => requestAnimationFrame(() => ok()));
async function frame(src, last, fps) {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = src;
  document.body.appendChild(v);
  await new Promise((ok, bad) => { v.onloadeddata = ok; v.onerror = () => bad(new Error('cannot decode ' + src)); });
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  let plays = 0;
  if (last) {
    let got = false;
    while (!got && plays < 5) {
      plays++;
      await new Promise((ok) => { v.onseeked = ok; v.currentTime = plays === 1 ? Math.max(0, v.duration - 0.3) : 0; setTimeout(ok, 5000); });
      got = await new Promise((ok) => {
        let fin = false;
        const end = (drawn) => { if (fin) return; fin = true; v.pause(); ok(drawn); };
        const tick = (now, meta) => {
          if (fin) return;
          if (meta.mediaTime >= v.duration - 2.5 / fps) { g.drawImage(v, 0, 0); end(true); } else v.requestVideoFrameCallback(tick);
        };
        v.requestVideoFrameCallback(tick);
        // a frame can still be presented just after 'ended'
        v.onended = () => setTimeout(() => end(false), 1500);
        v.play().catch(() => {});
        // the play can start from 0, so the whole video is allowed
        setTimeout(() => end(false), (v.duration + 6) * 1000);
      });
    }
    if (!got) throw new Error('no end frame of ' + src + ' in ' + plays + ' plays');
  } else { await raf(); await raf(); g.drawImage(v, 0, 0); }
  const px = g.getImageData(0, 0, c.width, c.height).data;
  v.remove();
  // a frame that drew nothing is a decode failure, not a match
  if (!px.some((x, i) => i % 4 === 3 && x > 0)) throw new Error('no decoded ' + (last ? 'last' : 'first') + ' frame of ' + src);
  return { px, c, plays };
}
window.compare = async (a, b, fps, save) => {
  const FA = await frame(a, true, fps), FB = await frame(b, false, fps);
  const A = FA.px, B = FB.px;
  const urls = Object.assign({ plays: FA.plays }, save ? { lastUrl: FA.c.toDataURL('image/png'), firstUrl: FB.c.toDataURL('image/png') } : {});
  if (A.length !== B.length) return Object.assign({ size: false }, urls);
  let sum = 0, max = 0, over = 0;
  for (let i = 0; i < A.length; i += 4) {
    const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
    sum += Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
    if (d > max) max = d;
    if (d > 32) over++;
  }
  const n = A.length / 4;
  return Object.assign({ size: true, mean: sum / (3 * n), max, share: over / n }, urls);
};
</script>`;

export async function verify(file, { script, media = null, frames = null, html = null, force = false, log = (l) => process.stdout.write(l + '\n'), browser = findBrowser() } = {}) {
  if (frames && !force && notEmpty(frames)) throw Object.assign(new Error(`${frames} is not empty; not overwriting (use --force or another --frames)`), { exit: 2 });
  const results = [];
  const gate = (name, state, detail, lines = []) => {
    results.push({ gate: name, ok: state !== false, skipped: state === null, detail, lines });
    log(`${state === null ? 'SKIP' : state ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
    for (const l of lines.slice(0, 12)) log(`  ${l}`);
    if (lines.length > 12) log(`  ... ${lines.length - 12} more`);
  };
  const parsed = parseScript(readText(script));
  if (parsed.errors.length) throw Object.assign(new Error(`script errors: ${parsed.errors.join('; ')}`), { exit: 2 });
  const data = deckData(parsed, 'review');
  const { JSZip } = pptxgen();
  let zip;
  try { zip = await JSZip.loadAsync(readFileSync(file)); } catch (e) {
    gate('zip', false, `${file} is not a zip: ${e.message}`);
    return { ok: false, results };
  }
  const names = Object.keys(zip.files);
  const read = (n) => (zip.file(n) ? zip.file(n).async('string') : Promise.resolve(null));
  const need = ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'docProps/core.xml'];
  const missing = need.filter((n) => !zip.file(n));
  const pres = (await read('ppt/presentation.xml')) || '';
  const sz = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(pres);
  const ratio = sz ? +sz[1] / +sz[2] : 0;
  gate('zip', !missing.length && Math.abs(ratio - 16 / 9) < 0.001, missing.length ? `missing ${missing.join(', ')}` : `parts present, slide size ${sz[1]}x${sz[2]} (16:9)`);
  const slideNames = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  const ct = (await read('[Content_Types].xml')) || '';
  const slides = [];
  for (let k = 0; k < slideNames.length; k++) {
    const xml = await read(slideNames[k]);
    const rels = (await read(slideNames[k].replace('slides/', 'slides/_rels/') + '.rels')) || '';
    const target = (type) => { const m = new RegExp(`Type="[^"]*/${type}" Target="\\.\\./([^"]+)"`).exec(rels) || new RegExp(`Target="\\.\\./([^"]+)"[^>]*Type="[^"]*/${type}"`).exec(rels); return m ? 'ppt/' + m[1] : null; };
    const rid = (id) => { const m = new RegExp(`Id="${id}"[^>]*Target="\\.\\./([^"]+)"`).exec(rels); return m ? 'ppt/' + m[1] : null; };
    const notesPart = target('notesSlide');
    const nx = notesPart ? (await read(notesPart)) || '' : '';
    const body = [...nx.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).find((s) => /type="body"/.test(s)) || '';
    slides.push({ k, xml, rels, notes: paragraphs(body).join('\n'), target, rid });
  }
  const kind = slides.some((s) => /<p14:media /.test(s.xml)) ? 'video' : 'edit';
  log(`  kind: ${kind === 'video' ? 'video deck (one video per slide)' : 'editable deck (one slide per section, animated)'}`);
  // a video deck has one slide per step, an editable deck one per section (its steps are clicks)
  const units = kind === 'video' ? data.steps.map((st) => ({ notes: notesText(st), title: slideTitle(st) }))
    : data.sections.map((sec) => ({ notes: sectionNotes(data.steps.filter((st) => st.section === sec.n)), title: sectionTitle(sec) }));
  gate('slide-count', slideNames.length === units.length, kind === 'video' ? `${slideNames.length} slides, ${data.steps.length} steps in the script` : `${slideNames.length} slides, ${data.sections.length} sections in the script`);

  // notes and titles
  const badNotes = [], badTitle = [], titles = new Set();
  slides.forEach((s, k) => {
    const u = units[k];
    if (!u) return;
    if (s.notes !== u.notes) badNotes.push(`slide ${k + 1}: notes ${JSON.stringify(s.notes.slice(0, 40))}`);
    const ph = /<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:cNvPr id="\d+" name="[^"]*"( hidden="1")?[^>]*>(?:(?!<\/p:sp>)[\s\S])*?<p:ph[^>]*\btype="title"[\s\S]*?<\/p:sp>/.exec(s.xml);
    const text = ph ? paragraphs(ph[0]).join(' ') : '';
    if (!ph || !ph[1] || text !== u.title || titles.has(text)) badTitle.push(`slide ${k + 1}: title ${JSON.stringify(text)}${ph && !ph[1] ? ' (not hidden)' : ''}`);
    titles.add(text);
  });
  gate('notes', !badNotes.length && slides.length > 0, `${slides.length - badNotes.length}/${slides.length} slides: ${kind === 'video' ? 'spoken lines, then stage directions apart' : 'each step as [key], its spoken lines and stage directions'}`, badNotes);
  gate('titles', !badTitle.length && slides.length > 0, `${slides.length - badTitle.length}/${slides.length} slides have a unique hidden title`, badTitle);

  if (kind === 'video') {
    const bad = [], infos = [];
    for (const s of slides) {
      const n = s.k + 1;
      const pic = /<p:pic>[\s\S]*?<\/p:pic>/.exec(s.xml);
      const picId = pic && (/<p:cNvPr id="(\d+)"/.exec(pic[0]) || [])[1];
      const alt = pic && (/<p:cNvPr [^>]*descr="([^"]+)"/.exec(pic[0]) || [])[1];
      const mediaRid = pic && (/<p14:media [^>]*r:embed="(rId\d+)"/.exec(pic[0]) || [])[1];
      const linkRid = pic && (/<a:videoFile r:link="(rId\d+)"/.exec(pic[0]) || [])[1];
      const posterRid = pic && (/<a:blip r:embed="(rId\d+)"/.exec(pic[0]) || [])[1];
      const mp4 = mediaRid && s.rid(mediaRid);
      const poster = posterRid && s.rid(posterRid);
      const timing = /<p:timing>[\s\S]*<\/p:timing>/.exec(s.xml);
      const tOk = timing && /cmd="playFrom\(0\.0\)"/.test(timing[0]) && /<p:video>/.test(timing[0]) && /evt="onBegin"/.test(timing[0])
        && [...timing[0].matchAll(/<p:spTgt spid="(\d+)"\/>/g)].every((m) => m[1] === picId) && !/repeatCount|autoRev/.test(timing[0]);
      if (!pic || !picId) bad.push(`slide ${n}: no video shape`);
      if (!mp4 || !zip.file(mp4) || !/\.mp4$/i.test(mp4) || !linkRid || s.rid(linkRid) !== mp4) bad.push(`slide ${n}: no MP4 part`);
      if (!tOk) bad.push(`slide ${n}: no autoplay timing for the video shape`);
      if (!poster || !zip.file(poster) || !/\.png$/i.test(poster)) bad.push(`slide ${n}: no poster`);
      if (!alt || !xmlText(alt).trim()) bad.push(`slide ${n}: no alt text`);
      if (!/\.mp4"/.test(ct) && !/Extension="mp4"/.test(ct)) bad.push('content types: mp4 not declared');
      const bytes = mp4 && zip.file(mp4) ? Buffer.from(await zip.file(mp4).async('uint8array')) : null;
      const info = bytes ? mp4Info(bytes) : null;
      infos.push({ n, mp4, bytes, info, poster: poster && zip.file(poster) ? Buffer.from(await zip.file(poster).async('uint8array')) : null });
    }
    gate('video-slides', !bad.length, `${slides.length - new Set(bad.map((b) => b.split(':')[0])).size}/${slides.length} slides: MP4 part, video shape, autoplay timing, poster, alt text`, [...new Set(bad)]);
    const notH264 = infos.filter((x) => !x.info || x.info.codec !== 'avc1' || !x.info.avcC);
    gate('h264', !notH264.length && infos.length > 0, notH264.length ? `${notH264.length} video(s) are not H.264` : `${infos.length} MP4 files are H.264 (avc1 + avcC), ${infos[0] ? `${infos[0].info.width}x${infos[0].info.height} at ${infos[0].info.fps} fps` : ''}`,
      notH264.map((x) => `slide ${x.n}: ${x.info ? x.info.codec : 'not an MP4'}`));

    // continuity of the decoded videos (browser) and of the recorded frames (--media)
    if (!browser) gate('continuity', null, 'no browser to decode the videos (set CHROME)');
    else {
      const dir = scratchDir(browser, 'pgg-verify-'); // where the browser can read it (a snap browser cannot read /tmp)
      const b = await launch({ browser });
      try {
        infos.forEach((x) => { if (x.bytes) writeFileSync(join(dir, `v${x.n}.mp4`), x.bytes); });
        writeFileSync(join(dir, 'frames.html'), FRAME_PAGE);
        const page = await b.open(null);
        await b.send('Page.navigate', { url: pathToFileURL(join(dir, 'frames.html')).href }, page.sessionId);
        for (let k = 0; k < 50 && !(await page.eval('typeof window.compare === "function"').catch(() => false)); k++) await new Promise((r) => setTimeout(r, 100));
        const can = await page.eval(`document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"')`);
        if (!can) gate('continuity', null, `this browser cannot decode H.264 (${browser}); decoded-video continuity not checked`);
        else {
          const rows = [];
          for (let k = 0; k + 1 < infos.length; k++) {
            const A = infos[k], B = infos[k + 1];
            const r = await page.eval(`compare('v${A.n}.mp4', 'v${B.n}.mp4', ${A.info.fps}, ${frames ? 'true' : 'false'})`, compareMs(A.info.sec, B.info.sec));
            if (frames) {
              mkdirSync(frames, { recursive: true });
              const pad = (n) => String(n).padStart(2, '0');
              // slide n's first frame is written once, as pair n's -first; with force earlier files are replaced
              for (const [u, name] of [[r.lastUrl, `${pad(A.n)}-last.png`], [r.firstUrl, `${pad(B.n)}-first.png`]]) if (u) writeFileSync(join(frames, name), Buffer.from(u.split(',')[1], 'base64'), { flag: force ? 'w' : 'wx' });
              delete r.lastUrl; delete r.firstUrl;
            }
            rows.push({ pair: `${A.n}->${B.n}`, ...r });
          }
          const badC = rows.filter((r) => !r.size || r.mean > VIDEO_MEAN_TOL || r.share > VIDEO_SHARE_TOL);
          const mx = (k) => Math.max(0, ...rows.map((r) => r[k] || 0));
          // a video played again because no end frame was reported is said on the gate line
          const again = rows.filter((r) => r.plays > 1).length;
          gate('continuity', !badC.length && rows.length === infos.length - 1,
            `decoded MP4: last frame of slide n vs first frame of slide n+1, ${rows.length - badC.length}/${rows.length} pairs within mean ${VIDEO_MEAN_TOL} and share ${VIDEO_SHARE_TOL} (worst mean ${mx('mean').toFixed(3)}, max ${mx('max')}, share over 32 ${mx('share').toFixed(5)})${again ? `; ${again} end frame(s) taken on a later play` : ''}`,
            rows.map((r) => `${r.pair}: mean ${r.mean != null ? r.mean.toFixed(3) : '-'}, max ${r.max}, share over 32 ${r.share != null ? r.share.toFixed(5) : '-'}${r.plays > 1 ? `, end frame on play ${r.plays}` : ''}`));
        }
      } finally {
        b.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
    if (media) {
      const man = JSON.parse(readFileSync(join(media, 'manifest.json'), 'utf8'));
      const rows = [];
      for (let k = 0; k + 1 < man.steps.length; k++) {
        const a = decodePng(readFileSync(join(media, man.steps[k].last))), c = decodePng(readFileSync(join(media, man.steps[k + 1].first)));
        let max = 0;
        for (let i = 0; i < a.data.length; i += 4) for (let j = 0; j < 3; j++) max = Math.max(max, Math.abs(a.data[i + j] - c.data[i + j]));
        rows.push({ pair: `${k + 1}->${k + 2}`, max });
      }
      const worst = Math.max(0, ...rows.map((r) => r.max));
      gate('continuity-raw', worst <= 16, `recorded frames: last of step n vs first of step n+1, ${rows.length} pairs, worst channel difference ${worst}`, rows.filter((r) => r.max > 0).map((r) => `${r.pair}: max ${r.max}`));
    }
  } else {
    const bad = [];
    for (const s of slides) {
      const texts = [...s.xml.matchAll(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:txBody>[\s\S]*?<\/p:sp>/g)].filter((m) => !/<p:ph[^>]*type="title"/.test(m[0]) && /<a:t>[^<]+<\/a:t>/.test(m[0]));
      const sec = data.sections[s.k];
      if (!texts.length && sec && data.steps.some((st) => st.section === sec.n && st.lines.length)) bad.push(`slide ${s.k + 1}: no native text box`);
    }
    const theme = (await read('ppt/theme/theme1.xml')) || '';
    const fontsOk = theme.includes(`<a:latin typeface="${LATIN}"`) && theme.includes(`<a:ea typeface="${KR}"`);
    gate('edit-slides', !bad.length && fontsOk, `${slides.length - bad.length}/${slides.length} slides have native text boxes; theme fonts ${fontsOk ? `${LATIN} / ${KR}` : 'NOT set'}`, bad);
    await animGates(await withMedia(zip, slides), data, { gate, html, browser, log });
  }
  const ok = results.every((r) => r.ok);
  return { ok, kind, results };
}

// each slide's pictures as data URLs by relationship id (anim-render draws them)
async function withMedia(zip, slides) {
  const out = [];
  for (const s of slides) {
    const urls = {};
    for (const m of s.xml.matchAll(/r:embed="(rId\d+)"/g)) {
      const part = s.rid(m[1]);
      if (part && zip.file(part) && /\.png$/i.test(part)) urls[m[1]] = `data:image/png;base64,${Buffer.from(await zip.file(part).async('uint8array')).toString('base64')}`;
    }
    out.push({ k: s.k, xml: s.xml, media: (rid) => urls[rid] || null });
  }
  return out;
}

// A path that is there but is not a folder that can be read (a file given as the PNG or frames folder) is a usage
// error with one line and exit 2, not a stack trace.
const notEmpty = (d) => {
  if (!existsSync(d)) return false;
  try {
    return readdirSync(d).length > 0;
  } catch (e) {
    throw Object.assign(new Error(`${resolve(d)} is not a folder that can be read (${e.code || e.message})`), { exit: 2 });
  }
};

/** The summary line of a verify result: ALL PASS only with no SKIP (a SKIP is not a pass). */
export function summaryLine(r, file) {
  const pass = r.results.filter((x) => x.ok && !x.skipped).length, fail = r.results.filter((x) => !x.ok).length;
  const skipped = r.results.filter((x) => x.skipped).map((x) => x.gate);
  const head = !r.ok ? 'FAILED' : skipped.length ? `PASS with SKIP (${skipped.join(', ')})` : 'ALL PASS';
  return `${head} (${pass} pass, ${skipped.length} skip, ${fail} fail) ${file}`;
}

/**
 * Optional PowerPoint check (Windows with PowerPoint only): opens the file through COM and exports every slide to
 * <pngDir>/NN.png. Returns { state: 'pass' | 'fail' | 'skip' | 'exists', out }. A non-empty PNG folder is
 * refused before anything runs ('exists', exit 2) unless force. Never touches a PowerPoint that is already running
 * (skip). Not part of verify.
 */
export function comCheck(file, pngDir, { force = false } = {}) {
  if (!force && notEmpty(pngDir)) return { state: 'exists', out: `${resolve(pngDir)} is not empty; not overwriting (use --force or another folder)` };
  if (process.platform !== 'win32') return { state: 'skip', out: 'not Windows' };
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = join(dirname(fileURLToPath(import.meta.url)), 'pptx-com.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Src', resolve(file), '-PngDir', resolve(pngDir)].concat(force ? ['-Force'] : []);
  const r = spawnSync(ps, args, { encoding: 'utf8', windowsHide: true, timeout: 900000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status === 4) return { state: 'exists', out };
  if (r.status === 2 || /Cannot create|80040154|class not registered/i.test(out)) return { state: 'skip', out };
  return { state: r.status === 0 ? 'pass' : 'fail', out };
}

// `com --anim <file.pptx> <dir> [--script <script.md>] [--video] [--force]`: PowerPoint reports the editable deck's
// animation (pptx-anim-com.mjs). With --script the expected clicks per slide are the section's steps - 1.
async function comAnimMain(args) {
  let script = null, video = false, force = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--script') script = resolve(args[++i] || '');
    else if (args[i] === '--video') video = true;
    else if (args[i] === '--force') force = true;
    else if (!args[i].startsWith('--')) pos.push(args[i]);
    else { process.stderr.write(`pptx: unknown argument ${args[i]}\n`); process.exit(2); }
  }
  if (pos.length !== 2) { process.stderr.write('usage: node scripts/pptx.mjs com --anim <file.pptx> <dir> [--script <script.md>] [--video] [--force]\n'); process.exit(2); }
  try {
    const { animCom } = await import('./pptx-anim-com.mjs');
    let clicks = null;
    if (script) {
      const parsed = parseScript(readText(script));
      if (parsed.errors.length) throw Object.assign(new Error(`script errors: ${parsed.errors.join('; ')}`), { exit: 2 });
      clicks = parsed.sections.map((s) => s.steps.length - 1);
    }
    if (!force) notEmpty(pos[1]);
    const r = await animCom(pos[0], pos[1], { force, video, clicks });
    if (r.state === 'exists') { process.stderr.write(`pptx: ${r.out}\n`); process.exit(2); }
    process.stdout.write(`${r.out ? r.out + '\n' : ''}${r.lines.join('\n')}\n${r.state.toUpperCase()} pptx-com --anim: ${r.state === 'skip' ? 'PowerPoint check skipped' : r.state === 'fail' ? 'PowerPoint and the file disagree' : `PowerPoint plays the timing as written; captures and report in ${resolve(pos[1])}`}\n`);
    process.exit(r.state === 'fail' ? 1 : 0);
  } catch (e) {
    process.stderr.write(`pptx: ${e.message}\n`);
    process.exit(exitOf(e, 2));
  }
}

// real paths on both sides: node runs a script reached through a link (macOS /var is /private/var) by its real path.
// A name realpath cannot read (argv[1] of `node -e`, for one) is compared as given, so importing this file never throws.
const ranAs = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && ranAs(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'com' && argv.includes('--anim')) await comAnimMain(argv.slice(1).filter((x) => x !== '--anim'));
  if (argv[0] === 'com') {
    const pos = argv.slice(1).filter((x) => x !== '--force'), force = argv.includes('--force');
    if (pos.length !== 2) { process.stderr.write('usage: node scripts/pptx.mjs com <file.pptx> <png dir> [--force]\n'); process.exit(2); }
    let r;
    try {
      r = comCheck(pos[0], pos[1], { force });
    } catch (e) {
      process.stderr.write(`pptx: ${e.message}\n`);
      process.exit(exitOf(e, 2));
    }
    if (r.state === 'exists') { process.stderr.write(`pptx: ${r.out}\n`); process.exit(2); }
    const fail = r.state === 'fail';
    process.stdout.write(`${r.out}\n${r.state.toUpperCase()} pptx-com: ${r.state === 'skip' ? 'PowerPoint check skipped' : fail ? 'PowerPoint did not open the file or export the slides' : `PowerPoint opened the file and exported slides to ${resolve(pos[1])}`}\n`);
    process.exit(fail ? 1 : 0);
  }
  if (argv[0] !== 'verify') { process.stderr.write('usage: node scripts/pptx.mjs verify <file.pptx> --script <script.md> [--media <record dir>] [--frames <dir>] [--force]\n       node scripts/pptx.mjs com <file.pptx> <png dir> [--force]   (optional, Windows + PowerPoint)\n'); process.exit(2); }
  let file = null, script = null, media = null, frames = null, html = null, force = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--script') script = resolve(argv[++i] || '');
    else if (argv[i] === '--media') media = resolve(argv[++i] || '');
    else if (argv[i] === '--frames') frames = resolve(argv[++i] || '');
    else if (argv[i] === '--html') html = resolve(argv[++i] || '');
    else if (argv[i] === '--force') force = true;
    else if (!argv[i].startsWith('--') && !file) file = resolve(argv[i]);
    else { process.stderr.write(`pptx: unknown argument ${argv[i]}\n`); process.exit(2); }
  }
  if (!file || !script) { process.stderr.write('usage: node scripts/pptx.mjs verify <file.pptx> --script <script.md> [--media <record dir>]\n'); process.exit(2); }
  try {
    const r = await verify(file, { script, media, frames, html, force });
    process.stdout.write(summaryLine(r, file) + '\n');
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    process.stderr.write(`pptx: ${e.exit ? e.message : e.stack || e.message}\n`);
    process.exit(exitOf(e, 2));
  }
}
