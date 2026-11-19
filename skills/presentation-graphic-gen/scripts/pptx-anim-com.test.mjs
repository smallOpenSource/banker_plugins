// pptx-anim-com.test.mjs: the PowerPoint spike (stage 0) without PowerPoint: the probe files, the comparison of a
// PowerPoint report with the file's timing, `pptx.mjs com --anim` off Windows, and the PowerShell script's syntax.
// Run: node --test scripts/pptx-anim-com.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, test } from 'node:test';
import { SKILL } from './build.mjs';
import { animCom, compareAnim, deckEffects, xmlEffects } from './pptx-anim-com.mjs';
import { PROBE_IDS, writeProbes } from './pptx-anim-probe.mjs';
import { checkSlide } from './pptx-xmlcheck.mjs';
import { pptxgen } from './vendor.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'pgg-anim-com-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const PPTX = join(SKILL, 'scripts', 'pptx.mjs');

test('probe: one file per candidate (13 checks, P12 in two files) with the effect and click counts probe.json says; only the probes meant to break the rules break them', async () => {
  const dir = join(TMP, 'probe');
  const list = await writeProbes(dir);
  assert.equal(list.length, 14);
  assert.deepEqual(PROBE_IDS, ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12a', 'P12b', 'P13']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'probe.json'), 'utf8')).probes, list);
  const { JSZip } = pptxgen();
  const flagged = {};
  for (const p of list) {
    const [d] = await deckEffects(join(dir, p.file));
    assert.equal(d.effects.length, p.effects, p.id);
    assert.equal(d.clicks, p.clicks, p.id);
    const xml = await (await JSZip.loadAsync(readFileSync(join(dir, p.file)))).file('ppt/slides/slide1.xml').async('string');
    const bad = checkSlide(xml);
    assert.ok(!bad.some((b) => /not well formed|out of order|not declared|used twice/.test(b)), `${p.id}: ${bad}`);
    if (bad.length) flagged[p.id] = bad.join('; ');
  }
  // custom presets the deck does not use (Grow/Shrink 6, Spin 8), the effect with no preset, the picture build
  assert.deepEqual(Object.keys(flagged), ['P04', 'P09', 'P12b', 'P13']);
  assert.match(flagged.P13, /bldP spid \d+ is not a shape with text/);
  assert.match(flagged.P12b, /an effect without presetClass and presetID/);
  await assert.rejects(writeProbes(dir), (e) => e.exit === 2 && /not empty; not overwriting/.test(e.message));
});

test('xmlEffects: target, trigger (click 1, with 2, after 3) and delay of every effect in order', () => {
  const eff = (node, ms, spid) => `<p:par><p:cTn id="9" presetID="10" presetClass="entr" fill="hold" grpId="0" nodeType="${node}"><p:stCondLst><p:cond delay="${ms}"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="10" dur="1"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:set></p:childTnLst></p:cTn></p:par>`;
  const xml = eff('afterEffect', 0, 4) + eff('withEffect', 250, 5) + eff('clickEffect', 100, 4);
  assert.deepEqual(xmlEffects(xml), [{ spid: 4, trigger: 3, delay: 0 }, { spid: 5, trigger: 2, delay: 250 }, { spid: 4, trigger: 1, delay: 100 }]);
});

const want = [{ effects: [{ shape: 'text a & b #1', trigger: 3, delay: 0 }, { shape: 'shape c #2', trigger: 1, delay: 150 }], clicks: 1, auto: true }];
const report = (over = {}) => ({ version: '16.0', slides: [{ slide: 1, effects: [{ shape: 'text a & b #1', trigger: 3, delay: 0 }, { shape: 'shape c #2', trigger: 1, delay: 0.15 }] }], show: null, showSkipped: 'no interactive desktop session', ...over });
const resaved = [{ effects: [{ shape: 'text a & b #1', trigger: 3, delay: 0 }, { shape: 'shape c #2', trigger: 1, delay: 150 }] }];

test('compareAnim: a report that matches passes; the slide show is SKIP without a desktop session', () => {
  const r = compareAnim(want, report(), resaved, [1]);
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.deepEqual(r.lines.map((l) => l.split(':')[0]), ['PASS com-open', 'PASS com-effects', 'PASS com-clicks', 'PASS com-resaved', 'SKIP com-show']);
  const shown = compareAnim(want, report({ show: [{ slide: 1, clicks: 1, firstAuto: true, captures: ['01-c0.png', '01-c1.png'] }] }), resaved, [1]);
  assert.match(shown.lines.join('\n'), /PASS com-show: .* captures 2 PNG/);
});

test('compareAnim: a slide show that did not run (a disconnected desktop) is SKIP with its reason; a video that was asked for and failed is FAIL', () => {
  const r = compareAnim(want, report({ build: '10353', showSkipped: 'the slide show did not run: E_FAIL', videoError: 'CreateVideo status 4' }), resaved, [1]);
  assert.equal(r.ok, false);
  assert.match(r.lines.join('\n'), /PASS com-open: PowerPoint 16\.0 build 10353 opened/);
  assert.match(r.lines.join('\n'), /SKIP com-show: the slide show did not run: E_FAIL/);
  assert.match(r.lines.join('\n'), /FAIL com-video: CreateVideo did not make the video: CreateVideo status 4/);
});

test('compareAnim fails a dropped effect, another trigger, another delay, a wrong click count and a show that disagrees', () => {
  const dropped = compareAnim(want, report({ slides: [{ slide: 1, effects: [report().slides[0].effects[0]] }] }), resaved, [1]);
  assert.equal(dropped.ok, false);
  assert.match(dropped.lines.join('\n'), /FAIL com-effects[\s\S]*2 effects in the file, PowerPoint reports 1/);
  const moved = report();
  moved.slides[0].effects[1] = { shape: 'shape c #2', trigger: 2, delay: 0.3 };
  const m = compareAnim(want, moved, resaved, [1]).lines.join('\n');
  assert.match(m, /trigger 1, PowerPoint 2/);
  assert.match(m, /delay 150 ms, PowerPoint 300 ms/);
  assert.match(compareAnim(want, report(), resaved, [2]).lines.join('\n'), /FAIL com-clicks[\s\S]*1 click effects, 2 expected/);
  assert.match(compareAnim(want, report(), null, [1]).lines.join('\n'), /FAIL com-resaved/);
  const show = compareAnim(want, report({ show: [{ slide: 1, clicks: 0, firstAuto: false, captures: [] }] }), resaved, [1]);
  assert.match(show.lines.join('\n'), /FAIL com-show[\s\S]*GetClickCount 0 \(expected 1\), FirstAnimationIsAutomatic false \(expected true\)/);
});

test('animCom: a folder that is not empty is refused first; off Windows it is SKIP; pptx.mjs com --anim says so with exit 0, and exit 2 on a usage error', async () => {
  const full = join(TMP, 'full');
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, 'keep.md'), 'mine');
  assert.equal((await animCom(join(TMP, 'none.pptx'), full)).state, 'exists');
  const usage = spawnSync(process.execPath, [PPTX, 'com', '--anim', join(TMP, 'none.pptx')], { encoding: 'utf8' });
  assert.equal(usage.status, 2, usage.stdout + usage.stderr);
  assert.match(usage.stderr, /usage: node scripts\/pptx\.mjs com --anim/);
  const refused = spawnSync(process.execPath, [PPTX, 'com', '--anim', join(TMP, 'none.pptx'), full], { encoding: 'utf8' });
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /not empty; not overwriting/);
  if (process.platform === 'win32') return; // the real run needs PowerPoint (pptx-com.ps1 -Anim)
  assert.equal((await animCom(join(TMP, 'none.pptx'), join(TMP, 'empty'))).state, 'skip');
  const r = spawnSync(process.execPath, [PPTX, 'com', '--anim', join(TMP, 'none.pptx'), join(TMP, 'empty2')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^SKIP com-open: not Windows/m);
  assert.match(r.stdout, /^SKIP pptx-com --anim: PowerPoint check skipped$/m);
  assert.equal(existsSync(join(TMP, 'empty2')), false, 'nothing written');
});

const pwsh = (process.env.PATH || '').split(delimiter).map((d) => join(d, process.platform === 'win32' ? 'pwsh.exe' : 'pwsh')).find((f) => existsSync(f));
test('pptx-com.ps1 parses (both modes, Windows PowerShell 5.1 syntax: no ?? or ?: operators)', { skip: pwsh ? false : 'pwsh not on PATH' }, async () => {
  const { pwshEnv } = await import('../../../scripts/test-fixtures/pwsh-env.mjs');
  const pse = pwshEnv();
  try {
    const f = join(SKILL, 'scripts', 'pptx-com.ps1');
    const cmd = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${f.replace(/'/g, "''")}', [ref]$null, [ref]$e); $e.Count; $e | ForEach-Object { $_.Message }`;
    const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', env: pse.env, timeout: 60000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim().split('\n')[0].trim(), '0', r.stdout);
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /\?\?|\s\?\s[^:]+\s:\s/);
    for (const k of ['GetClickCount', 'FirstAnimationIsAutomatic', 'GotoClick', 'CreateVideo', 'SaveCopyAs', 'DisplayAlerts']) assert.ok(src.includes(k), k);
    // the -Anim open has no document window (a disconnected desktop leaves PowerPoint busy with one), and anim.json is
    // written before the slide show and the video, which may fail
    const anim = src.slice(src.indexOf('function Invoke-Anim'), src.indexOf('if ($Worker)'));
    assert.match(anim, /Presentations\.Open\(\$Src, -1, 0, 0\)/);
    assert.ok(anim.indexOf('Save-AnimJson') < anim.indexOf('Invoke-Show'));
  } finally {
    rmSync(pse.home, { recursive: true, force: true });
  }
});
