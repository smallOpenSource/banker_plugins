// build.test.mjs: script parsing, time budget, repeat warning, scene lint, output names, no-overwrite rule (build,
// and the refusals of check, verify --frames, com and make that come before any work), vendor sha check (each
// vendored file alone), font subsetting and its fallback, SKIP in the reports, and file hygiene. No browser needed.
// Run: node --test scripts/build.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { after, test } from 'node:test';
import { SAMPLE, SKILL, deckData, lintScene, parseArgs, parseScript, readText, repeatWarnings, syllables, timeBudget } from './build.mjs';
import { check } from './check.mjs';
import { codepointsOf, embedFonts } from './fonts.mjs';
import { doneReport } from './make.mjs';
import { comCheck, summaryLine, verify } from './pptx.mjs';
import { ORIGINALS, PACKED, VendorError, VENDOR, vendorBytes, verifyVendor } from './vendor.mjs';
import { pwshEnv } from '../../../scripts/test-fixtures/pwsh-env.mjs';

const BUILD = join(SKILL, 'scripts', 'build.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'pgg-build-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const run = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', ...opts });

const MINI = `# 시험 대본

## 1. 하나 (목표 0:10)

### 1-1
화면: 첫 화면
[연출 메모]
말:
첫 단계에서 하는 말입니다. [잠깐 멈춤] 끝.

### 1-2
화면: 둘째
- 둘째 줄
말: 짧은 말.

## 메모
- 이 아래는 대본이 아님
### 9-9
`;

test('parseScript reads sections, steps, 화면 lines, 말 and keeps stage directions apart', () => {
  const p = parseScript(MINI);
  assert.deepEqual(p.errors, []);
  assert.equal(p.title, '시험 대본');
  assert.equal(p.sections.length, 1);
  const [a, b] = p.sections[0].steps;
  assert.equal(p.sections[0].target, 10);
  assert.deepEqual(a.screen, ['첫 화면']);
  assert.deepEqual(a.directions, ['연출 메모', '잠깐 멈춤']);
  assert.equal(a.speech, '첫 단계에서 하는 말입니다. 끝.');
  assert.deepEqual(b.screen, ['둘째', '둘째 줄']);
  assert.equal(b.speech, '짧은 말.');
  assert.equal(b.id, 's1-2');
});

// A script with one line in cp949 (가나 is b0 a1 b3 aa there): what Windows PowerShell 5.1's Set-Content writes on Korean
// Windows. Before remains 0.29.0 #5 it built with U+FFFD in the review HTML and exit 0.
const CP949_LINE = Buffer.from([0xb0, 0xa1, 0xb3, 0xaa]);
const cp949Script = () => { const [head, tail] = MINI.split('짧은 말.'); return Buffer.concat([Buffer.from(head), CP949_LINE, Buffer.from(tail)]); };

test('readText: UTF-8 (BOM dropped) and UTF-16 with a BOM are read; anything else is exit 2 naming the file', () => {
  const dir = join(TMP, 'enc');
  mkdirSync(dir, { recursive: true });
  const put = (name, bytes) => { writeFileSync(join(dir, name), bytes); return join(dir, name); };
  assert.equal(readText(put('plain.md', Buffer.from('# 가\n'))), '# 가\n');
  assert.equal(readText(put('bom.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 가\n')]))), '# 가\n');
  assert.equal(readText(put('le.md', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# 가\n', 'utf16le')]))), '# 가\n');
  const bad = put('cp949.md', cp949Script());
  assert.throws(() => readText(bad), (e) => e.exit === 2 && e.message === `${bad} is not UTF-8 (or UTF-16 with a BOM); save it as UTF-8`);
  assert.equal(parseScript(readText(put('bom-script.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(MINI)])))).errors.length, 0, 'a BOM script still parses');
});

test('not UTF-8: build, make, pptx-video, pptx-edit and verify stop with one line and exit 2, writing nothing', () => {
  const dir = join(TMP, 'cp949');
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'deck.md');
  writeFileSync(script, cp949Script());
  const one = (r, what) => {
    assert.equal(r.status, 2, `${what}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`^[a-z-]+: ${script.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} is not UTF-8 \\(or UTF-16 with a BOM\\); save it as UTF-8\\n$`), what);
  };
  one(run([BUILD, script, '--dir', join(dir, 'out'), '--stamp', '261118+1500']), 'build');
  assert.ok(!existsSync(join(dir, 'out')), 'build wrote nothing');
  // CHROME names no file, so there is no browser here: make reports the script before the browser search, on every PC
  one(run([join(SKILL, 'scripts', 'make.mjs'), script, '--dir', join(dir, 'make-out'), '--stamp', '261118+1500'], { env: { ...process.env, CHROME: join(dir, 'no-browser') } }), 'make');
  // a script that does not exist is a usage error (exit 2) too, with or without a browser
  const gone = run([join(SKILL, 'scripts', 'make.mjs'), join(dir, 'gone.md'), '--dir', join(dir, 'make-out'), '--stamp', '261118+1500'], { env: { ...process.env, CHROME: join(dir, 'no-browser') } });
  assert.equal(gone.status, 2, gone.stdout + gone.stderr);
  assert.match(gone.stderr, /^make: script not found: .*gone\.md\n$/);
  one(run([join(SKILL, 'scripts', 'pptx-video.mjs'), script, '--media', join(dir, 'media'), '--out', join(dir, 'v.pptx')]), 'pptx-video');
  // CHROME names a file that exists, so pptx-edit gets past its browser check to the script (nothing is launched)
  one(run([join(SKILL, 'scripts', 'pptx-edit.mjs'), join(dir, 'p.html'), script, '--out', join(dir, 'e.pptx')], { env: { ...process.env, CHROME: process.execPath } }), 'pptx-edit');
  one(run([join(SKILL, 'scripts', 'pptx.mjs'), 'verify', join(dir, 'none.pptx'), '--script', script]), 'verify');
  for (const f of ['v.pptx', 'e.pptx']) assert.ok(!existsSync(join(dir, f)), f);
  // a scene file in cp949 is the same file error, not a scene error (exit 1)
  const ok = join(dir, 'ok.md');
  writeFileSync(ok, MINI);
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  writeFileSync(join(dir, 'scenes', '01.js'), Buffer.concat([Buffer.from("Deck.scene({ section: 1, steps: {} }); // "), CP949_LINE]));
  const sc = run([BUILD, ok, '--dir', join(dir, 'out2'), '--stamp', '261118+1500']);
  assert.equal(sc.status, 2, sc.stdout + sc.stderr);
  assert.match(sc.stderr, /scenes[\\/]01\.js is not UTF-8/);
  assert.ok(!existsSync(join(dir, 'out2')));
});

test('parseScript reports malformed scripts', () => {
  const p = parseScript('# t\n\n## 2. 순서 틀림\n\n### 2-2\n말: x\n');
  assert.ok(p.errors.some((e) => /out of order/.test(e)), p.errors.join('|'));
  assert.ok(p.errors.some((e) => /no 화면/.test(e)), p.errors.join('|'));
  assert.ok(parseScript('no title').errors.some((e) => /title/.test(e)));
});

test('time budget: about 290 syllables per minute, per section, with the target', () => {
  assert.equal(syllables('가나다 abc 1.'), 7);
  const b = timeBudget(parseScript(MINI));
  const syl = syllables('첫 단계에서 하는 말입니다. 끝.') + syllables('짧은 말.');
  assert.equal(b.rows[0].syllables, syl);
  assert.ok(Math.abs(b.rows[0].sec - (syl / 290) * 60) < 1e-9);
  assert.equal(b.rows[0].target, 10);
  assert.equal(b.total.syllables, syl);
});

test('repeat warning fires when the screen repeats the spoken note, and not otherwise', () => {
  const rep = parseScript('# t\n## 1. a\n### 1-1\n화면: 집에서 맛있는 커피를 내리는 방법\n말: 오늘은 집에서 맛있는 커피를 내리는 방법을 말합니다.\n');
  const w = repeatWarnings(rep);
  assert.equal(w.length, 1);
  assert.match(w[0].text, /겹칩니다/);
  const ok = parseScript('# t\n## 1. a\n### 1-1\n화면: 비율 1 : 15 기억하기\n말: 콩 무게의 열다섯 배가 물의 양입니다.\n');
  assert.deepEqual(repeatWarnings(ok), []);
  assert.deepEqual(repeatWarnings(parseScript(readFileSync(SAMPLE, 'utf8'))), [], 'the sample deck has no repeat warning');
});

test('scene lint rejects clocks, random numbers, own animation loops and callbacks (trap 3 and 4)', () => {
  const bad = {
    'Math.random()': /Math\.random/, 'Date.now()': /clock/, 'new Date()': /clock/, 'performance.now()': /clock/,
    'requestAnimationFrame(f)': /requestAnimationFrame/, 'setTimeout(f, 1)': /timers/, 'el.animate([], 1)': /own Web Animations/,
    'a.onfinish = f': /callbacks/, 'a.finished.then(f)': /callbacks/, 'x.addEventListener("finish", f)': /callbacks/, 'gsap.to(x, {})': /GSAP/,
  };
  for (const [code, re] of Object.entries(bad)) {
    const hits = lintScene(`Deck.scene({ steps: { a() { ${code}; } } });`);
    assert.ok(hits.some((h) => re.test(h)), `${code}: ${hits}`);
  }
  assert.deepEqual(lintScene('// Math.random is not used here\nDeck.scene({ html: (d) => d.rand(3)() });'), [], 'comments and the seeded helper pass');
  for (const f of readdirSync(join(SKILL, 'assets', 'sample', 'scenes'))) {
    assert.deepEqual(lintScene(readFileSync(join(SKILL, 'assets', 'sample', 'scenes', f), 'utf8')), [], f);
  }
});

test('the engine changes screen state only through keyframes (trap 3) and uses no third-party animation library', () => {
  const src = readFileSync(join(SKILL, 'scripts', 'runtime', 'engine.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(src, /\bonfinish\b|\.finished\b|\.ready\s*\.then|addEventListener\(\s*['"](finish|cancel)/);
  assert.doesNotMatch(src, /\bgsap\b/i);
  assert.doesNotMatch(src, /\.play\(\)/, 'no Animation is ever played: time is applied by seeking');
  assert.match(src, /new Animation\(new KeyframeEffect/);
});

test('build: a scene using Math.random fails the build (exit 1) with the reason', () => {
  const dir = join(TMP, 'lint');
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  writeFileSync(join(dir, 'deck.md'), MINI);
  writeFileSync(join(dir, 'scenes', '01.js'), "Deck.scene({ section: 1, html: '<p data-r=\"a\">x</p>', steps: { 's1-1'(s) { s.fadeIn('a', { at: Math.random() }); }, 's1-2'(s) { s.hold(1); } } });");
  const r = run([BUILD, join(dir, 'deck.md'), '--dir', join(dir, 'out')]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Math\.random/);
});

test('build: writes the review / present pair, never overwrites, --force replaces', () => {
  const out = join(TMP, 'pair');
  const args = [BUILD, '--sample', '--dir', out, '--stamp', '261118+1200'];
  const r1 = run(args);
  assert.equal(r1.status, 0, r1.stderr);
  const review = join(out, 'coffee-review-261118+1200.html'), present = join(out, 'coffee-present-261118+1200.html');
  assert.ok(existsSync(review) && existsSync(present));
  assert.match(r1.stdout, /시간 예산 \(분당 290음절\)/);
  assert.match(r1.stdout, /합계 +\d+음절/);
  const html = readFileSync(present, 'utf8');
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/, 'present page names no network URL');
  assert.doesNotMatch(html, /오늘은 카페에 가지 않고도/, 'present carries no spoken note');
  assert.match(readFileSync(review, 'utf8'), /오늘은 카페에 가지 않고도/, 'review carries the spoken notes');
  writeFileSync(present, 'marker');
  const r2 = run(args);
  assert.equal(r2.status, 2, 'second build with the same stamp must fail');
  assert.match(r2.stderr, /exists; not overwriting/);
  assert.equal(readFileSync(present, 'utf8'), 'marker', 'the existing file is untouched');
  const r3 = run(args.concat('--force'));
  assert.equal(r3.status, 0, r3.stderr);
  assert.notEqual(readFileSync(present, 'utf8'), 'marker');
  assert.deepEqual(readdirSync(out).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left behind');
});

test('build: default output folder is ./presentation-out/<name>/', () => {
  const a = parseArgs(['deck/talk.md'], TMP);
  assert.equal(a.dir, join(TMP, 'presentation-out', 'talk'));
  assert.equal(a.scenes, join(TMP, 'deck', 'scenes'));
  assert.throws(() => parseArgs(['x.md', '--stamp', '2611181200']), /yymmdd\+HHMM/);
});

test('vendor: every file matches its recorded sha256; every file over 100 KB is packed', () => {
  assert.deepEqual(verifyVendor(), []);
  for (const rel of Object.keys(ORIGINALS)) {
    const packed = PACKED.includes(rel);
    const f = join(VENDOR, packed ? `${rel}.br` : rel);
    assert.ok(existsSync(f), f);
    assert.ok(packed || statSync(f).size <= 100 * 1024, `${rel} is over 100 KB and must be packed`);
    if (packed) assert.ok(!existsSync(join(VENDOR, rel)), `${rel}: only the .br is kept`);
  }
  const readme = readFileSync(join(VENDOR, 'README.md'), 'utf8');
  for (const [rel, sha] of Object.entries(ORIGINALS)) {
    assert.ok(readme.includes(sha), `vendor/README.md lists the sha256 of ${rel}`);
  }
});

test('vendor: a tampered .br is refused (it no longer unpacks, or unpacks to other bytes), and the build stops with exit 3', () => {
  const copy = join(TMP, 'skill');
  cpSync(join(SKILL, 'scripts'), join(copy, 'scripts'), { recursive: true });
  cpSync(VENDOR, join(copy, 'vendor'), { recursive: true });
  cpSync(join(SKILL, 'assets'), join(copy, 'assets'), { recursive: true });
  const flip = (f, at) => { const b = readFileSync(f); b[at] ^= 0xff; writeFileSync(f, b); };
  // a damaged .br: either it no longer unpacks or it unpacks to bytes with another sha256; both are refused
  const br = join(copy, 'vendor', 'fonts', 'NotoSansKRStatic-Bold.ttf.br');
  flip(br, 40000);
  assert.throws(() => vendorBytes('fonts/NotoSansKRStatic-Bold.ttf', join(copy, 'vendor')), VendorError);
  flip(join(copy, 'vendor', 'harfbuzz', 'harfbuzz-subset.wasm.br'), 5000);
  assert.throws(() => vendorBytes('harfbuzz/harfbuzz-subset.wasm', join(copy, 'vendor')), /harfbuzz-subset\.wasm\.br: (sha256 differs|cannot read)/);
  assert.equal(verifyVendor(join(copy, 'vendor')).length, 2);
  const r = run([join(copy, 'scripts', 'build.mjs'), '--sample', '--dir', join(TMP, 'tampered-out')]);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /refusing to run|cannot read/);
  assert.ok(!existsSync(join(TMP, 'tampered-out')), 'nothing is written');
  // the untouched originals still pass
  assert.doesNotThrow(() => vendorBytes('fonts/NotoSansKRStatic-Bold.ttf'));
});

test('fonts: subset to the used characters (much smaller), and keep every glyph the text needs', async () => {
  const text = '집에서 내리는 커피 한 잔 1 : 15';
  const warns = [];
  const fonts = await embedFonts(text, { onWarn: (w) => warns.push(w) });
  assert.deepEqual(warns, []);
  assert.equal(fonts.length, 4);
  for (const f of fonts) {
    assert.ok(f.subset, f.rel);
    assert.ok(f.bytes.length < vendorBytes(f.rel).length / 5, `${f.rel} ${f.bytes.length}`);
    assert.equal(f.bytes.readUInt32BE(0), 0x00010000);
  }
  // the KR subset maps every Hangul syllable of the text (cmap lookup by a tiny parser)
  const kr = fonts.find((f) => f.rel.includes('KRStatic-Regular')).bytes;
  for (const ch of '집에서내리는커피한잔') assert.ok(hasGlyph(kr, ch.codePointAt(0)), ch);
  assert.ok(!hasGlyph(kr, '뷁'.codePointAt(0)), 'an unused syllable is dropped');
  assert.ok(codepointsOf('가').includes(0x41), 'printable ASCII is always kept');
});

test('fonts: when subsetting fails the full font is embedded and a warning is reported', async () => {
  const warns = [];
  const fonts = await embedFonts('가나다', { wasm: Buffer.from('not wasm'), onWarn: (w) => warns.push(w) });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /embedding the full fonts/);
  for (const f of fonts) {
    assert.equal(f.subset, false);
    assert.ok(f.bytes.equals(vendorBytes(f.rel)), `${f.rel} is the full original`);
  }
});

// a copy of the skill with one byte of one packed vendor file changed (a byte appended would not do: brotli ignores
// what follows the end of its stream, so the unpacked bytes would still be the original)
function tampered(name, rel) {
  const copy = join(TMP, name);
  for (const d of ['scripts', 'vendor', 'assets']) cpSync(join(SKILL, d), join(copy, d), { recursive: true });
  const f = join(copy, 'vendor', `${rel}.br`);
  const b = readFileSync(f);
  b[b.length >> 1] ^= 0xff;
  writeFileSync(f, b);
  return copy;
}
// the message of a packed file that no longer unpacks, or unpacks to other bytes
const refused = (rel) => new RegExp(`${rel.split('/')[1].replace(/\./g, '\\.')}\\.br: (sha256 differs|cannot read)`);

test('vendor: the HarfBuzz wasm alone changed stops the build with exit 3 (no full-font fallback)', () => {
  const copy = tampered('t-wasm', 'harfbuzz/harfbuzz-subset.wasm');
  const out = join(TMP, 't-wasm-out');
  const r = run([join(copy, 'scripts', 'build.mjs'), '--sample', '--dir', out]);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, refused('harfbuzz/harfbuzz-subset.wasm'));
  assert.doesNotMatch(r.stdout + r.stderr, /embedding the full fonts/);
  assert.ok(!existsSync(out), 'nothing is written');
});

test('vendor: any one packed file changed (fonts, wasm, H.264 encoder, PptxGenJS) stops make.mjs with exit 3 before any work', () => {
  for (const [i, rel] of PACKED.entries()) {
    const name = rel.startsWith('pptxgenjs/') ? 't-pptx' : `t-make-${i}`;
    const copy = tampered(name, rel);
    const out = join(TMP, `${name}-out`);
    const t0 = Date.now();
    const r = run([join(copy, 'scripts', 'make.mjs'), '--sample', '--format', 'pptx', '--dir', out]);
    assert.equal(r.status, 3, `${name}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, refused(rel));
    assert.doesNotMatch(r.stdout, /== build/, 'stopped before the build');
    assert.ok(!existsSync(out), 'nothing is written');
    assert.ok(Date.now() - t0 < 20000, `${name}: ${Date.now() - t0} ms`);
  }
  // the other helpers that read PptxGenJS stop with 3 too
  const copy = join(TMP, 't-pptx');
  const v = run([join(copy, 'scripts', 'pptx.mjs'), 'verify', join(TMP, 'none.pptx'), '--script', SAMPLE]);
  assert.equal(v.status, 3, v.stdout + v.stderr);
  const media = join(TMP, 't-pptx-media');
  mkdirSync(media, { recursive: true });
  writeFileSync(join(media, 'manifest.json'), JSON.stringify({ fps: 30, steps: deckData(parseScript(readFileSync(SAMPLE, 'utf8'))).steps.map((s) => ({ id: s.id })) }));
  const pv = run([join(copy, 'scripts', 'pptx-video.mjs'), SAMPLE, '--media', media, '--out', join(TMP, 't-pptx.pptx')]);
  assert.equal(pv.status, 3, pv.stdout + pv.stderr);
  assert.ok(!existsSync(join(TMP, 't-pptx.pptx')));
});

test('names: the default name is the script file name, Hangul and spaces included (spaces become "-")', () => {
  assert.equal(parseArgs(['발표.md'], TMP).name, '발표');
  assert.equal(parseArgs(['발표.md'], TMP).dir, join(TMP, 'presentation-out', '발표'));
  assert.equal(parseArgs(['my talk.md'], TMP).name, 'my-talk');
  assert.equal(parseArgs(['\u1107\u1161\u11af\u1111\u116d.md'.normalize('NFD')], TMP).name, '발표'.normalize('NFC'), 'a decomposed (macOS) name reads as composed');
  assert.equal(parseArgs(['x.md', '--name', '2026 상반기 v1.2'], TMP).name, '2026 상반기 v1.2', 'a given name keeps its spaces');
  for (const bad of ['../up', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'a\u0001b', '..', 'x.', ' x', 'x ']) {
    assert.throws(() => parseArgs(['x.md', '--name', bad], TMP), (e) => e.exit === 2 && /--name may hold/.test(e.message), JSON.stringify(bad));
  }
  assert.throws(() => parseArgs(['..md'], TMP), (e) => e.exit === 2 && /the output name \(the script file name; give --name\)/.test(e.message));
});

test('names: a default name turns characters outside the rule into "-"; a given --name is refused instead (remains 0.29.0 #7)', () => {
  for (const [file, name] of [['발표(최종).md', '발표-최종'], ['Q&A 자료.md', 'Q-A-자료'], ['회의 #3, [초안]·메모.md', '회의-3-초안-메모'], ['a*b.md', 'a-b'], ['my  talk.md', 'my-talk']]) {
    assert.equal(parseArgs([file], TMP).name, name, file);
  }
  for (const bad of ['발표(최종)', 'Q&A', 'a#b', 'a,b', 'a[b]', 'a·b']) {
    assert.throws(() => parseArgs(['x.md', '--name', bad], TMP), (e) => e.exit === 2 && /--name may hold/.test(e.message), JSON.stringify(bad));
  }
  assert.throws(() => parseArgs(['(#).md'], TMP), (e) => e.exit === 2 && /give --name/.test(e.message), 'nothing left of the file name');
});

test('names: Windows device names are refused, given or by default, with or without an extension (N4)', () => {
  for (const bad of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'nul.html', 'COM1', 'com9.md', 'LPT1', 'lpt9.x.y', 'COM\u00b9', 'NUL .md']) {
    assert.throws(() => parseArgs(['x.md', '--name', bad], TMP), (e) => e.exit === 2 && /Windows device name/.test(e.message), JSON.stringify(bad));
  }
  assert.throws(() => parseArgs(['nul.md'], TMP), (e) => e.exit === 2 && /give --name/.test(e.message));
  for (const ok of ['CONSOLE', 'nullable', 'COM10', 'LPT', 'my-con', 'AUX1']) assert.equal(parseArgs(['x.md', '--name', ok], TMP).name, ok, ok);
});

test('build: script files named 발표.md and "my talk.md" build without --name', () => {
  for (const [file, name] of [['발표.md', '발표'], ['my talk.md', 'my-talk']]) {
    const dir = join(TMP, `named-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), MINI);
    const r = run([BUILD, join(dir, file), '--dir', join(dir, 'out'), '--stamp', '261118+1300']);
    assert.equal(r.status, 0, r.stderr);
    for (const k of ['review', 'present']) assert.ok(existsSync(join(dir, 'out', `${name}-${k}-261118+1300.html`)), `${name} ${k}`);
  }
});

test('no overwrite: check, verify --frames, com and make refuse a folder that is not empty (exit 2) before any work', async () => {
  const full = join(TMP, 'full');
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, 'keep.txt'), 'mine');
  // check: refused before the browser starts (a browser that does not exist would fail differently)
  await assert.rejects(check(join(TMP, 'deck.html'), { out: full, browser: join(TMP, 'no-browser'), log: () => {} }), (e) => e.exit === 2 && /not empty; not overwriting/.test(e.message));
  await assert.rejects(verify(join(TMP, 'none.pptx'), { script: SAMPLE, frames: full, log: () => {} }), (e) => e.exit === 2 && /not empty; not overwriting/.test(e.message));
  assert.equal(comCheck(join(TMP, 'none.pptx'), full).state, 'exists');
  const com = run([join(SKILL, 'scripts', 'pptx.mjs'), 'com', join(TMP, 'none.pptx'), full]);
  assert.equal(com.status, 2, com.stdout + com.stderr);
  assert.match(com.stderr, /not overwriting/);
  if (process.platform === 'win32') {
    // the PowerShell script itself keeps the rule when called directly (exit 4)
    writeFileSync(join(TMP, 'none.pptx'), 'x');
    const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // a temp home and the opt-outs, so PowerShell's caches stay out of the real home (scripts/test-fixtures/pwsh-env.mjs)
    const pse = pwshEnv();
    let p;
    try {
      p = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(SKILL, 'scripts', 'pptx-com.ps1'), '-Src', join(TMP, 'none.pptx'), '-PngDir', full], { encoding: 'utf8', windowsHide: true, env: pse.env });
    } finally {
      rmSync(pse.home, { recursive: true, force: true });
    }
    assert.ok(p.status === 4 || /already running/.test(p.stdout), p.stdout + p.stderr);
  }
  assert.equal(readFileSync(join(full, 'keep.txt'), 'utf8'), 'mine', 'the folder is untouched');
  // a file where the PNG or frames folder goes: one line and exit 2, no stack trace (remains 0.29.0 #8)
  const notDir = join(full, 'keep.txt');
  assert.throws(() => comCheck(join(TMP, 'none.pptx'), notDir), (e) => e.exit === 2 && /is not a folder that can be read/.test(e.message));
  const comFile = run([join(SKILL, 'scripts', 'pptx.mjs'), 'com', join(TMP, 'none.pptx'), notDir]);
  assert.equal(comFile.status, 2, comFile.stdout + comFile.stderr);
  assert.match(comFile.stderr, /^pptx: .*keep\.txt is not a folder that can be read \(E[A-Z]+\)\n$/);
  const vFile = run([join(SKILL, 'scripts', 'pptx.mjs'), 'verify', join(TMP, 'none.pptx'), '--script', SAMPLE, '--frames', notDir]);
  assert.equal(vFile.status, 2, vFile.stdout + vFile.stderr);
  assert.match(vFile.stderr, /^pptx: .*keep\.txt is not a folder that can be read \(E[A-Z]+\)\n$/);
  // make: the check folder (html) and the recording folder (pptx) of the same name and stamp are checked first
  const out = join(TMP, 'make-out'), st = '261118+1400';
  for (const [sub, format] of [[`check-coffee-present-${st}`, 'html'], [`coffee-recording-${st}`, 'pptx']]) {
    mkdirSync(join(out, sub), { recursive: true });
    writeFileSync(join(out, sub, 'old.png'), 'x');
    const r = run([join(SKILL, 'scripts', 'make.mjs'), '--sample', '--format', format, '--dir', out, '--stamp', st]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`${sub.replace(/[+]/g, '\\+')} is not empty; not overwriting`));
    assert.doesNotMatch(r.stdout, /== build/, 'refused before the build');
    rmSync(join(out, sub), { recursive: true });
    // a file where that folder goes: one line and exit 2 (a usage error), not ENOTDIR and exit 1
    writeFileSync(join(out, sub), 'x');
    const f = run([join(SKILL, 'scripts', 'make.mjs'), '--sample', '--format', format, '--dir', out, '--stamp', st]);
    assert.equal(f.status, 2, f.stdout + f.stderr);
    assert.match(f.stderr, new RegExp(`^make: .*${sub.replace(/[+]/g, '\\+')} is not a folder that can be read \\(E[A-Z]+\\)\n$`));
    assert.doesNotMatch(f.stdout, /== build/, 'refused before the build');
    rmSync(join(out, sub));
  }
});

test('reports: a SKIP is never ALL PASS (verify summary and the make done block)', () => {
  const res = (skip) => ({ ok: true, results: [{ gate: 'zip', ok: true, skipped: false }, { gate: 'continuity', ok: true, skipped: skip }] });
  assert.equal(summaryLine(res(false), 'a.pptx'), 'ALL PASS (2 pass, 0 skip, 0 fail) a.pptx');
  assert.equal(summaryLine(res(true), 'a.pptx'), 'PASS with SKIP (continuity) (1 pass, 1 skip, 0 fail) a.pptx');
  assert.match(summaryLine({ ok: false, results: [{ gate: 'zip', ok: false }] }, 'a.pptx'), /^FAILED/);
  const done = doneReport({ review: '/r.html', video: '/v.pptx', fallbacks: [], skipped: 'continuity (video deck)' });
  assert.match(done, /^== done: PASS with SKIP\n/);
  assert.match(done, /^skipped {6}continuity \(video deck\)$/m);
  assert.equal(doneReport({ review: '/r.html', skipped: '' }), '== done\nreview       /r.html\n');
});

// format 4 / 12 cmap lookup
function hasGlyph(font, cp) {
  const n = font.readUInt16BE(4);
  let cmap = 0;
  for (let i = 0; i < n; i++) if (font.toString('latin1', 12 + i * 16, 16 + i * 16) === 'cmap') cmap = font.readUInt32BE(12 + i * 16 + 8);
  const subs = font.readUInt16BE(cmap + 2);
  for (let i = 0; i < subs; i++) {
    const off = cmap + font.readUInt32BE(cmap + 4 + i * 8 + 4), fmt = font.readUInt16BE(off);
    if (fmt === 12) {
      const groups = font.readUInt32BE(off + 12);
      for (let g = 0; g < groups; g++) {
        const p = off + 16 + g * 12, s = font.readUInt32BE(p), e = font.readUInt32BE(p + 4), gid = font.readUInt32BE(p + 8);
        if (cp >= s && cp <= e) return gid + (cp - s) !== 0;
      }
      return false;
    }
    if (fmt === 4 && cp <= 0xffff) {
      const seg = font.readUInt16BE(off + 6) / 2, ends = off + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ranges = deltas + seg * 2;
      for (let s = 0; s < seg; s++) {
        const end = font.readUInt16BE(ends + s * 2), start = font.readUInt16BE(starts + s * 2);
        if (cp > end) continue;
        if (cp < start) return false;
        const delta = font.readInt16BE(deltas + s * 2), ro = font.readUInt16BE(ranges + s * 2);
        if (!ro) return ((cp + delta) & 0xffff) !== 0;
        const gi = font.readUInt16BE(ranges + s * 2 + ro + (cp - start) * 2);
        return gi !== 0 && ((gi + delta) & 0xffff) !== 0;
      }
    }
  }
  return false;
}

test('hygiene: no hidden characters, emoji, secret-shaped strings, guessable temp names or GSAP in the skill files', () => {
  const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\u{00A0}\u{2800}\u{3000}\u{3164}]/u;
  const EMOJI = /(?![\u{00A9}\u{00AE}\u{2122}])\p{Extended_Pictographic}/u; // copyright signs in license texts are text
  const SECRET = [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]{0,20}PRIVATE KEY/, /\bgh[pousr]_[A-Za-z0-9]{36}\b/, /\bxox[abprs]-[0-9]{6,}-/,
    /\bAIza[0-9A-Za-z_-]{35}\b/, /\bnpm_[A-Za-z0-9]{36}\b/, /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/];
  const GUESSABLE = /\$\{\s*(process\.pid|Date\.now\(\))|[`'"]\s*\+\s*(process\.pid|Date\.now\(\))/;
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(SKILL);
  const found = [];
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  for (const f of files) {
    if (['.wasm', '.br', '.ttf', '.png'].includes(extname(f))) continue;
    const text = utf8.decode(readFileSync(f));
    const rel = relative(SKILL, f);
    text.split('\n').forEach((line, i) => {
      for (const c of line) if (HIDDEN.test(c) && !/[\t\r]/.test(c)) found.push(`${rel}:${i + 1} hidden U+${c.codePointAt(0).toString(16)}`);
      if (EMOJI.test(line)) found.push(`${rel}:${i + 1} emoji`);
      for (const re of SECRET) if (re.test(line)) found.push(`${rel}:${i + 1} secret-shaped`);
      if (/\.mjs$|\.js$/.test(f) && GUESSABLE.test(line) && /tmp|temp|lock/i.test(line)) found.push(`${rel}:${i + 1} guessable temp name`);
      // code only: the documents say why GSAP is not used
      if (/\.(m?js|css)$/.test(f) && !/\.test\.mjs$/.test(f) && /\bgsap\b/i.test(line) && !/GSAP \(not used/.test(line)) found.push(`${rel}:${i + 1} gsap`);
    });
  }
  assert.deepEqual(found, []);
});
