// pptx.test.mjs: the PowerPoint pipeline. Pieces without a browser always run; the end-to-end pipeline
// (make.mjs --format both on a small deck, verify both directions) skips with the reason when no browser is found.
// Run: node --test scripts/pptx.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { SKILL, parseScript } from './build.mjs';
import { findBrowser, launch, scratchDir } from './cdp.mjs';
import { mp4Info, notesText, patchNotes, patchSlide, writeNew } from './pptx-common.mjs';
import { FRAME_PAGE, VIDEO_MEAN_TOL, VIDEO_SHARE_TOL, compareMs, verify } from './pptx.mjs';
import { buildVideoPptx } from './pptx-video.mjs';
import { mp4Writer } from './record.mjs';
import { VENDOR, VendorError, pptxgen } from './vendor.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'pgg-pptx-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const MAKE = join(SKILL, 'scripts', 'make.mjs');

test('the WASM encoder writes an H.264 MP4 that mp4Info reads back (codec, size, frames, fps)', async () => {
  const w = await mp4Writer({ width: 64, height: 48, fps: 30 });
  const px = new Uint8Array(64 * 48 * 4);
  for (let f = 0; f < 6; f++) { px.fill(40 * f); w.add(px); }
  const { bytes, frames } = w.finish();
  assert.equal(frames, 6);
  const info = mp4Info(bytes);
  assert.deepEqual({ codec: info.codec, avcC: info.avcC, w: info.width, h: info.height, n: info.samples, fps: info.fps }, { codec: 'avc1', avcC: true, w: 64, h: 48, n: 6, fps: 30 });
  assert.equal(mp4Info(Buffer.from('not an mp4 at all, just text')), null);
});

test('notes: spoken lines first, stage directions apart in brackets; one paragraph per line in the notes XML', () => {
  const st = { speech: '첫 문장.\n둘째 문장.', directions: ['연출 하나', '연출 둘'] };
  assert.equal(notesText(st), '첫 문장.\n둘째 문장.\n\n[연출 하나]\n[연출 둘]');
  assert.equal(notesText({ speech: '', directions: ['연출'] }), '[연출]');
  const xml = '<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>가\n\n[나]</a:t></a:r><a:endParaRPr lang="en-US" dirty="0"/></a:p></p:txBody></p:sp>';
  const out = patchNotes(xml);
  assert.equal((out.match(/<a:p>/g) || []).length, 3);
  assert.match(out, /<a:t>가<\/a:t>.*<a:endParaRPr lang="ko-KR".*<a:t>\[나\]<\/a:t>/);
});

test('slide XML: shape ids renumbered, the title placeholder hidden, Korean as the text language', () => {
  const xml = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/></p:nvGrpSpPr><p:sp><p:nvSpPr><p:cNvPr id="9" name="Text 0"></p:cNvPr><p:nvPr><p:ph\n idx="100"\n type="title"/></p:nvPr></p:nvSpPr><a:r><a:rPr lang="en-US"/></a:r></p:sp><p:pic><p:cNvPr id="9" name="video s1-1"/></p:pic></p:spTree>';
  const r = patchSlide(xml);
  assert.deepEqual(r.ids.map((x) => x.id), [1, 2, 3]);
  assert.match(r.xml, /<p:cNvPr id="2" name="Text 0" hidden="1">/);
  assert.match(r.xml, /<p:cNvPr id="3" name="video s1-1"\/>/);
  assert.match(r.xml, /lang="ko-KR"/);
});

test('writeNew never overwrites (exit 2) unless forced', () => {
  const f = join(TMP, 'x.pptx');
  writeNew(f, Buffer.from('a'));
  assert.throws(() => writeNew(f, Buffer.from('b')), (e) => e.exit === 2 && /not overwriting/.test(e.message));
  assert.equal(readFileSync(f, 'utf8'), 'a');
  writeNew(f, Buffer.from('c'), true);
  assert.equal(readFileSync(f, 'utf8'), 'c');
  assert.deepEqual(readdirSync(TMP).filter((n) => n.endsWith('.tmp')), []);
});

test('vendored PptxGenJS loads from its checked bytes; a tampered copy is refused', () => {
  const { PptxGenJS, JSZip } = pptxgen();
  assert.equal(typeof PptxGenJS, 'function');
  assert.equal(typeof JSZip, 'function');
  const copy = join(TMP, 'vendor');
  cpSync(VENDOR, copy, { recursive: true });
  // a .br that unpacks cleanly to other bytes
  const f = join(copy, 'pptxgenjs', 'pptxgen.bundle.js.br');
  writeFileSync(f, brotliCompressSync(Buffer.from(brotliDecompressSync(readFileSync(f)).toString('utf8').replace('PptxGenJS', 'PptxGenJZ'))));
  assert.throws(() => pptxgen(copy), VendorError);
});

test('a vendored .br that unpacks to far more than any original is refused as damaged, not unpacked into memory', () => {
  const copy = join(TMP, 'vendor-big');
  cpSync(VENDOR, copy, { recursive: true });
  // 64 MiB of zeros packs to a few KB; the largest original is about 6.2 MB
  writeFileSync(join(copy, 'pptxgenjs', 'pptxgen.bundle.js.br'), brotliCompressSync(Buffer.alloc(64 * 1024 * 1024)));
  assert.throws(() => pptxgen(copy), (e) => e instanceof VendorError && /cannot read/.test(e.message));
});

test('make.mjs rejects an unknown --format (exit 2)', () => {
  const r = spawnSync(process.execPath, [MAKE, '--sample', '--format', 'pdf'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--format needs html, pptx or both/);
});

test('compareMs: the reply time of one compare covers 5 plays of slide n\'s video, its seeks and slide n+1, and is always finite', () => {
  // FRAME_PAGE: each play waits up to 5 s for the seek and up to the length + 6 s for the end
  assert.ok(compareMs(6.5, 2) >= (5 * (5 + 6.5 + 6) + 2) * 1000, String(compareMs(6.5, 2)));
  assert.ok(compareMs(0.4, 0.4) > 30000, 'longer than one protocol command even for a short step');
  assert.ok(compareMs(30, 1) > compareMs(3, 1) && compareMs(3, 30) > compareMs(3, 1));
  for (const x of [NaN, undefined, -1, Infinity]) assert.ok(Number.isFinite(compareMs(x, x)) && compareMs(x, x) > 30000, String(x));
  assert.equal(compareMs(1e9, 0), 2 ** 31 - 1, 'within what setTimeout accepts');
});

const BROWSER = findBrowser();
const SKIP = BROWSER ? false : 'no Chrome, Edge or Chromium found (set CHROME to the browser executable); PowerPoint pipeline tests not run';
if (SKIP) process.stdout.write(`# SKIP pptx pipeline tests: ${SKIP}\n`);

describe('PowerPoint pipeline in a browser', { skip: SKIP }, () => {
  let dir, script, out, made;
  const STAMP = '261118+0930';
  before(() => {
    dir = join(TMP, 'mini');
    mkdirSync(join(dir, 'scenes'), { recursive: true });
    script = join(dir, 'mini.md');
    writeFileSync(script, '# 작은 덱\n\n## 1. 하나\n\n### 1-1\n화면: 첫 장면 제목\n[제목이 떠오름]\n말:\n첫 말입니다.\n\n### 1-2\n화면: 밑줄\n말: 둘째 말.\n\n## 2. 둘\n\n### 2-1\n화면: 둘째 장면\n- 칩 하나\n[장면이 바뀜]\n말: 셋째 말.\n');
    writeFileSync(join(dir, 'scenes', '01.js'), `Deck.scene({ section: 1, css: '.s01 .t { position: absolute; left: 200px; top: 300px; } .s01 .p { position: absolute; left: 200px; top: 480px; }',
      html: (d) => '<h1 class="t t-display" data-r="t">' + d.esc(d.lines('s1-1')[0]) + '</h1><p class="p t-h2" data-r="p">' + d.esc(d.lines('s1-2')[0]) + ' 문장</p><i class="ul" data-r="ul"></i>',
      steps: { 's1-1'(s) { s.fadeUp('t', { at: 0.1 }); }, 's1-2'(s) { const t = s.fadeUp('p'); s.underline('ul', 'p', { at: t }); } } });`);
    writeFileSync(join(dir, 'scenes', '02.js'), `Deck.scene({ section: 2, css: '.s02 .t { position: absolute; left: 200px; top: 300px; } .s02 .c { position: absolute; left: 200px; top: 500px; }',
      html: (d) => '<h2 class="t t-h1" data-r="t">' + d.esc(d.lines('s2-1')[0]) + '</h2><span class="chip c" data-r="c">' + d.esc(d.lines('s2-1')[1]) + '</span>',
      steps: { 's2-1'(s) { s.fadeUp('t', { at: 0.1 }); s.chips('c', { at: 0.3, ring: 'f' }); } } });`);
    out = join(dir, 'out');
    made = spawnSync(process.execPath, [MAKE, script, '--format', 'both', '--dir', out, '--stamp', STAMP], { encoding: 'utf8', timeout: 400000 });
  });

  test('make.mjs --format both: HTML pair, check, recording, video and editable decks, both verified', () => {
    assert.equal(made.status, 0, made.stdout + made.stderr);
    for (const f of [`mini-review-${STAMP}.html`, `mini-present-${STAMP}.html`, `mini-video-${STAMP}.pptx`, `mini-edit-${STAMP}.pptx`]) assert.ok(existsSync(join(out, f)), f);
    const rec = JSON.parse(readFileSync(join(out, `mini-recording-${STAMP}`, 'manifest.json'), 'utf8'));
    assert.equal(rec.steps.length, 3);
    for (const s of rec.steps) assert.equal(s.holdFrames, 15, 'the last frame is held 0.5 s');
    assert.match(made.stdout, /PASS continuity: decoded MP4: last frame of slide n vs first frame of slide n\+1, 2\/2 pairs/);
    assert.match(made.stdout, /PASS continuity-raw: recorded frames: .* worst channel difference 0/);
    assert.match(made.stdout, /PASS h264: 3 MP4 files are H\.264/);
    assert.match(made.stdout, /PASS edit-slides: 3\/3 slides have native text boxes; theme fonts Noto Sans \/ Noto Sans KR/);
    assert.equal((made.stdout.match(/^FAIL /gm) || []).length, 0);
  });

  test('editable deck: the focus outline is a native rounded rectangle outline (no fill, one shape)', async () => {
    const { JSZip } = pptxgen();
    const zip = await JSZip.loadAsync(readFileSync(join(out, `mini-edit-${STAMP}.pptx`)));
    const xml = await zip.file('ppt/slides/slide3.xml').async('string');
    const shapes = [...xml.matchAll(/<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="shape i\.fx-focus"[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
    assert.equal(shapes.length, 1, 'one outline shape for the one marked chip');
    assert.match(shapes[0], /<a:prstGeom prst="roundRect">/);
    assert.match(shapes[0], /<a:noFill\/>/);
    assert.match(shapes[0], /<a:ln w="\d+"><a:solidFill><a:srgbClr val="E0263F"\/>/);
    assert.doesNotMatch(xml, /ring-e/, 'no edge pieces');
  });

  test('verify with no browser (CHROME names no file): continuity SKIP, the summary says PASS with SKIP, never ALL PASS, exit 0', () => {
    const r = spawnSync(process.execPath, [join(SKILL, 'scripts', 'pptx.mjs'), 'verify', join(out, `mini-video-${STAMP}.pptx`), '--script', script],
      { encoding: 'utf8', timeout: 60000, env: { ...process.env, CHROME: join(TMP, 'nonexistent', 'chrome') } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^SKIP continuity: no browser to decode the videos/m);
    assert.match(r.stdout, /^PASS with SKIP \(continuity\) \(\d+ pass, 1 skip, 0 fail\) /m);
    assert.doesNotMatch(r.stdout, /ALL PASS/);
  });

  test('verify --frames writes the decoded frames once; the same folder again is refused (exit 2) unless --force', () => {
    const frames = join(dir, 'frames');
    const args = [join(SKILL, 'scripts', 'pptx.mjs'), 'verify', join(out, `mini-video-${STAMP}.pptx`), '--script', script, '--frames', frames];
    const r1 = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000 });
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    assert.deepEqual(readdirSync(frames).sort(), ['01-last.png', '02-first.png', '02-last.png', '03-first.png']);
    const r2 = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000 });
    assert.equal(r2.status, 2, r2.stdout + r2.stderr);
    assert.match(r2.stderr, /not empty; not overwriting/);
    const r3 = spawnSync(process.execPath, args.concat('--force'), { encoding: 'utf8', timeout: 120000 });
    assert.equal(r3.status, 0, r3.stdout + r3.stderr);
  });

  test('check.mjs on the same deck again is refused (exit 2) unless --force: the earlier snapshots and report stay', () => {
    const present = join(out, `mini-present-${STAMP}.html`), report = join(out, `check-mini-present-${STAMP}`, 'report.json');
    const before = readFileSync(report, 'utf8');
    const r = spawnSync(process.execPath, [join(SKILL, 'scripts', 'check.mjs'), present], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /not empty; not overwriting \(use --force/);
    assert.equal(readFileSync(report, 'utf8'), before);
  });

  test('make.mjs never overwrites an earlier run (exit 2) unless --force', () => {
    const r = spawnSync(process.execPath, [MAKE, script, '--format', 'pptx', '--dir', out, '--stamp', STAMP], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /exists; not overwriting/);
  });

  test('verify fails when the videos are out of order (decoded continuity) and when notes are wrong', async () => {
    const rec = join(out, `mini-recording-${STAMP}`), bad = join(dir, 'swapped');
    cpSync(rec, bad, { recursive: true });
    const m = JSON.parse(readFileSync(join(bad, 'manifest.json'), 'utf8'));
    const [a, b] = [m.steps[1].mp4, m.steps[2].mp4];
    renameSync(join(bad, a), join(bad, 'x.mp4')); renameSync(join(bad, b), join(bad, a)); renameSync(join(bad, 'x.mp4'), join(bad, b));
    const parsed = parseScript(readFileSync(script, 'utf8'));
    const vfile = join(dir, 'swapped.pptx');
    await buildVideoPptx({ parsed, media: bad, out: vfile });
    const r = await verify(vfile, { script, media: bad, log: () => {} });
    const g = Object.fromEntries(r.results.map((x) => [x.gate, x.ok]));
    assert.equal(g.continuity, false, 'swapped videos must break the decoded continuity');
    assert.equal(g['continuity-raw'], true, 'the recorded frames themselves are still continuous');
    assert.equal(g['video-slides'], true);
    // notes edited by hand no longer match the script
    const { JSZip } = pptxgen();
    const zip = await JSZip.loadAsync(readFileSync(join(out, `mini-edit-${STAMP}.pptx`)));
    const n = Object.keys(zip.files).find((x) => /notesSlide\d+\.xml$/.test(x));
    zip.file(n, (await zip.file(n).async('string')).replace(/<a:t>[^<]+<\/a:t>/, '<a:t>다른 말</a:t>'));
    const efile = join(dir, 'notes-bad.pptx');
    writeFileSync(efile, await zip.generateAsync({ type: 'nodebuffer' }));
    const r2 = await verify(efile, { script, log: () => {} });
    assert.equal(r2.results.find((x) => x.gate === 'notes').ok, false);
    assert.equal(r2.results.find((x) => x.gate === 'edit-slides').ok, true);
  });

  // as seen on Windows Chrome: 'ended' comes before the held end is presented, in the first `hide` plays of a video
  const HIDE_STUB = `<script>window.hide = 0;
      document.addEventListener('play', (e) => { e.target.plays = (e.target.plays || 0) + 1; }, true);
      const rvfc = HTMLVideoElement.prototype.requestVideoFrameCallback;
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb) {
        return rvfc.call(this, (now, meta) => { if ((this.plays || 0) <= window.hide && meta.mediaTime >= this.duration - 0.3) return; cb(now, meta); });
      };</script>`;
  // FRAME_PAGE with HIDE_STUB in folder page, opened in browser b
  async function framePage(b, page) {
    writeFileSync(join(page, 'frames.html'), FRAME_PAGE.replace('<body>', '<body>' + HIDE_STUB));
    const p = await b.open(null);
    await b.send('Page.navigate', { url: pathToFileURL(join(page, 'frames.html')).href }, p.sessionId);
    for (let k = 0; k < 50 && !(await p.eval('typeof window.compare === "function"').catch(() => false)); k++) await new Promise((r) => setTimeout(r, 100));
    return p;
  }

  test('the end frame is drawn only when requestVideoFrameCallback reports it: a play without it is played again, none in 5 plays is an error (never the frame shown at ended)', async () => {
    const rec = join(out, `mini-recording-${STAMP}`), m = JSON.parse(readFileSync(join(rec, 'manifest.json'), 'utf8'));
    const page = scratchDir(BROWSER, 'pgg-frame-page-');
    const b = await launch({ browser: BROWSER });
    try {
      cpSync(join(rec, m.steps[0].mp4), join(page, 'a.mp4'));
      cpSync(join(rec, m.steps[1].mp4), join(page, 'b.mp4'));
      const p = await framePage(b, page);
      const r = await p.eval(`(window.hide = 1, compare('a.mp4', 'b.mp4', ${m.fps}, false))`);
      // 2, or later when the browser itself also skips the end of the second play (Windows Chrome)
      assert.ok(r.plays >= 2 && r.plays <= 5, JSON.stringify(r));
      assert.ok(r.size && r.mean <= VIDEO_MEAN_TOL && r.share <= VIDEO_SHARE_TOL, JSON.stringify(r));
      await assert.rejects(p.eval(`(window.hide = 9, compare('a.mp4', 'b.mp4', ${m.fps}, false))`), /no end frame of a\.mp4 in 5 plays/);
    } finally {
      b.close();
      rmSync(page, { recursive: true, force: true });
    }
  });

  test('a step video longer than one protocol command (6.5 s) with no reported end frame ends with "no end frame ... in 5 plays", not a reply timeout', async () => {
    const fps = 30, w = await mp4Writer({ width: 64, height: 48, fps }), px = new Uint8Array(64 * 48 * 4);
    for (let f = 0; f < 6.5 * fps; f++) { px.fill(60 + (f % 100)); w.add(px); }
    const { bytes } = w.finish(), sec = mp4Info(bytes).sec;
    assert.ok(sec >= 6.4, String(sec));
    const page = scratchDir(BROWSER, 'pgg-frame-page-');
    const b = await launch({ browser: BROWSER });
    try {
      writeFileSync(join(page, 'long.mp4'), bytes);
      const p = await framePage(b, page);
      const t0 = Date.now();
      const e = await p.eval(`(window.hide = 9, compare('long.mp4', 'long.mp4', ${fps}, false))`, compareMs(sec, sec)).then(() => null, (x) => x);
      assert.ok(e, 'compare must fail when no play reports the end frame');
      assert.match(e.message, /no end frame of long\.mp4 in 5 plays/);
      assert.doesNotMatch(e.message, /no reply/);
      // the 5 plays took longer than the 30 s a protocol command waits by default
      assert.ok(Date.now() - t0 > 30000, String(Date.now() - t0));
    } finally {
      b.close();
      rmSync(page, { recursive: true, force: true });
    }
  });
});
