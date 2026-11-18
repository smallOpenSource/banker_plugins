// cdp.test.mjs: the browser driver. Browser search (Playwright's folders on every OS), the snap Chromium rules
// (decided by pure functions: no snap is needed to test them), the NUL-framed pipe protocol, the System32 taskkill,
// and, when a browser is found, a real launch over the pipe that opens no debugging port.
// Run: node --test scripts/cdp.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { SKILL } from './build.mjs';
import { findBrowser, isSnap, launch, nulSplitter, playwrightCandidates, scratchBase, snapBrowser, snapCanRead, snapUnreadable } from './cdp.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'pgg-cdp-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const SRC = readFileSync(join(SKILL, 'scripts', 'cdp.mjs'), 'utf8');

test('Playwright chromium: the Intel Mac (chrome-mac-x64) and Apple silicon folders are both searched, newest first', () => {
  const root = join(TMP, 'pw');
  for (const d of ['chromium-1217', 'chromium-1248', 'chromium_headless_shell-1248', 'ffmpeg-1011']) mkdirSync(join(root, d), { recursive: true });
  const mac = playwrightCandidates('darwin', [root]);
  const app = ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'];
  assert.ok(mac.includes(join(root, 'chromium-1248', 'chrome-mac-x64', ...app)), 'x64');
  assert.ok(mac.includes(join(root, 'chromium-1248', 'chrome-mac-arm64', ...app)), 'arm64');
  assert.ok(mac.indexOf(join(root, 'chromium-1248', 'chrome-mac-x64', ...app)) < mac.indexOf(join(root, 'chromium-1217', 'chrome-mac-x64', ...app)), 'newest first');
  assert.ok(mac.every((p) => !p.includes('headless_shell') && !p.includes('ffmpeg')));
  assert.ok(playwrightCandidates('win32', [root]).includes(join(root, 'chromium-1248', 'chrome-win64', 'chrome.exe')));
  assert.ok(playwrightCandidates('linux', [root]).includes(join(root, 'chromium-1248', 'chrome-linux64', 'chrome')));
});

test('snap Chromium is recognized by its path, its real path, or a wrapper script that runs /snap/bin', () => {
  assert.equal(isSnap('/snap/bin/chromium', '/usr/bin/snap'), true, '/snap/bin/chromium is a link to /usr/bin/snap');
  assert.equal(isSnap('/usr/bin/chromium', '/snap/chromium/3000/usr/lib/chromium-browser/chrome'), true);
  assert.equal(isSnap('/usr/bin/chromium-browser', '/usr/bin/chromium-browser', '#! /bin/sh\nexec /snap/bin/chromium "$@"\n'), true, "Ubuntu's transitional wrapper");
  assert.equal(isSnap('/usr/bin/google-chrome', '/opt/google/chrome/google-chrome', '#!/bin/bash\nexec -a "$0" "$HERE/chrome" "$@"\n'), false);
  assert.equal(isSnap('/opt/pw/chromium-1217/chrome-linux64/chrome', '/opt/pw/chromium-1217/chrome-linux64/chrome', '\x7fELF'), false);
  assert.equal(snapBrowser('/snap/bin/chromium', 'darwin'), false, 'only Linux has snaps');
  assert.equal(snapBrowser(findBrowser() || process.execPath), false, 'the browser of this test run is not a snap');
});

test('snap Chromium: the profile always goes under ~/snap/chromium/common (a folder the snap can read), never the OS temp folder or a hidden folder', () => {
  const home = join(TMP, 'home');
  assert.equal(scratchBase(false, home), tmpdir());
  const base = scratchBase(true, home);
  assert.equal(base, join(home, 'snap', 'chromium', 'common'), 'also when the snap has never run and the folder does not exist yet');
  assert.equal(snapCanRead(join(base, 'pgg-chrome-x', 'Default'), home), true);
});

test('snap Chromium can read non-hidden folders under home only; anything else fails with a sentence that names CHROME', () => {
  const home = join(TMP, 'home');
  assert.equal(snapCanRead(join(home, 'talks', 'deck.html'), home), true);
  assert.equal(snapCanRead(join(home, 'snap', 'chromium', 'common', 'pgg-verify-x', 'frames.html'), home), true);
  assert.equal(snapCanRead(join(home, '.cache', 'deck.html'), home), false, 'hidden folder');
  assert.equal(snapCanRead(join(home, 'talks', '.out', 'deck.html'), home), false, 'hidden folder deeper down');
  assert.equal(snapCanRead(join(tmpdir(), 'deck.html'), home), false, 'the OS temp folder');
  assert.equal(snapCanRead(home, home), false);
  const e = snapUnreadable('/tmp/x/deck.html');
  assert.equal(e.exit, 2);
  assert.match(e.message, /snap Chromium cannot read \/tmp\/x\/deck\.html/);
  assert.match(e.message, /set CHROME to a browser not installed by snap/);
});

test('pipe protocol: NUL-terminated JSON messages, split across chunks or several in one chunk', () => {
  const got = [];
  const feed = nulSplitter((t) => got.push(JSON.parse(t)));
  const a = Buffer.from(JSON.stringify({ id: 1, result: { v: '가나' } }) + '\0' + JSON.stringify({ method: 'x' }) + '\0');
  feed(a.subarray(0, 7)); feed(a.subarray(7, 20)); feed(a.subarray(20));
  feed(Buffer.from(JSON.stringify({ id: 2 }).slice(0, 3))); feed(Buffer.from(JSON.stringify({ id: 2 }).slice(3) + '\0'));
  assert.deepEqual(got, [{ id: 1, result: { v: '가나' } }, { method: 'x' }, { id: 2 }]);
});

test('the driver opens no debugging port and takes taskkill from System32', () => {
  assert.match(SRC, /'--remote-debugging-pipe'/);
  assert.doesNotMatch(SRC, /remote-debugging-port|DevToolsActivePort|new WebSocket/);
  assert.match(SRC, /win32\.join\(process\.env\.SystemRoot \|\| 'C:\\\\Windows', 'System32', 'taskkill\.exe'\)/);
  assert.doesNotMatch(SRC, /execFileSync\(\s*['"]taskkill/);
  assert.match(SRC, /windowsHide: true/);
});

test('a helper reached through a linked folder still runs its command (it once exited 0 and did nothing)', () => {
  const link = join(TMP, 'skill-link');
  symlinkSync(SKILL, link, 'junction'); // a junction on Windows (no admin right needed), a symlink elsewhere
  for (const [file, re] of [['cdp.mjs', /^(browser |no Chrome)/], ['build.mjs', /usage: node scripts\/build\.mjs/]]) {
    const r = spawnSync(process.execPath, [join(link, 'scripts', file)], { encoding: 'utf8' });
    assert.match(r.stdout + r.stderr, re, file);
    assert.notEqual(r.stdout + r.stderr, '');
  }
});

const BROWSER = findBrowser();
const SKIP = BROWSER ? false : 'no Chrome, Edge or Chromium found (set CHROME to the browser executable); launch test not run';
if (SKIP) process.stdout.write(`# SKIP cdp launch test: ${SKIP}\n`);

describe('launch over the pipe', { skip: SKIP }, () => {
  test('a real browser answers over fd 3 / fd 4, two tabs work, close() ends the process and removes the profile', async () => {
    const events = [];
    const b = await launch({ browser: BROWSER, onEvent: (m, p, sid) => { if (m === 'Runtime.consoleAPICalled') events.push(sid); } });
    let closed = false;
    try {
      assert.match((await b.send('Browser.getVersion')).product, /Chrome|Edg|Chromium/i);
      const p1 = await b.open(null), p2 = await b.open(null);
      assert.notEqual(p1.sessionId, p2.sessionId);
      assert.equal(await p1.eval('1 + 2'), 3);
      await p2.eval('console.log("from tab 2")');
      for (let k = 0; k < 50 && !events.length; k++) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(events, [p2.sessionId], 'events carry the session of the tab that sent them');
      assert.ok(!existsSync(join(b.profile, 'DevToolsActivePort')), 'no port file: no debugging port is open');
      assert.ok(b.profile.startsWith(tmpdir()), 'not a snap: the profile is in the OS temp folder');
      b.close();
      closed = true;
      let alive = true;
      for (let k = 0; k < 50 && alive; k++) { try { process.kill(b.pid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { alive = false; } }
      assert.equal(alive, false, 'the browser process is gone after close()');
      assert.ok(!existsSync(b.profile), 'the profile folder is removed');
      await assert.rejects(b.send('Browser.getVersion'), /browser/);
    } finally {
      if (!closed) b.close();
    }
  });

  test('a program that is not a browser fails to start with the reason (no 20 s wait when it exits)', async () => {
    const t0 = Date.now();
    await assert.rejects(launch({ browser: process.execPath }), /browser did not start: \S.* \(Browser\.getVersion: the browser (exited|pipe broke)/i);
    assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
  });
});
