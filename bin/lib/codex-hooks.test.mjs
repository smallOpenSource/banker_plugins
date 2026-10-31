// Tests for codex-hooks.mjs. Run from the repo root: node --test bin/lib/codex-hooks.test.mjs
import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, posix as P } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { codexPaths, disableHooks, enableHooks, formatCommand, homeInWorkspace, hookGuard, HOOKS, hookStatus, PAYLOAD, removeAll, repoAbove, safeNode } from './codex-hooks.mjs';
import { homeInSession } from './codex-routes.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = mkdtempSync(join(tmpdir(), 'codex-hooks-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
// enableHooks 의 cwd 기본값은 process.cwd() 다. 러너가 임시 폴더(예: /tmp)에서 실행되면, 그 아래에 만든 시험 Codex 홈이
// 작업 폴더 안으로 보여 "샌드박스가 고칠 수 있는 곳" 검사에 걸린다. 작업 폴더로는 root 의 형제 폴더를 넘긴다.
// 형제 폴더는 시험 홈을 품지 않으므로, 러너의 cwd 나 TMPDIR 이 어디든(저장소 안이어도) 이 검사에 걸리지 않는다.
const WORK = mkdtempSync(join(tmpdir(), 'codex-hooks-cwd-'));
after(() => rmSync(WORK, { recursive: true, force: true }));
let n = 0;
const home = () => {
  const d = join(root, `h${n++}`);
  mkdirSync(d);
  return codexPaths({ CODEX_HOME: d });
};
const omx = { type: 'command', command: 'omx-hook' };
const seed = (p, extra = {}) => writeFileSync(p.hooks, JSON.stringify({ hooks: { SessionStart: [{ hooks: [omx] }], ...extra } }));
const read = (p) => JSON.parse(readFileSync(p.hooks, 'utf8')).hooks;
const posix = { skip: process.platform === 'win32' && 'POSIX modes' };

test('enable copies the payload and appends after the existing groups; a second run changes nothing', () => {
  const p = home();
  seed(p);
  const r = enableHooks(p, ['update', 'count'], PKG, process.execPath, WORK);
  assert.deepEqual([r.code, r.changed], [0, ['update', 'count']]);
  const h = read(p);
  assert.deepEqual(h.SessionStart[0].hooks[0], omx, 'OMX keeps index 0');
  assert.equal(h.SessionStart[1].hooks[0].command, formatCommand(process.execPath, join(p.dir, 'hooks', 'update-notify.mjs'), ['--codex'], process.platform === 'win32', hookGuard(true)));
  assert.equal(h.Stop[0].hooks[0].command, formatCommand(process.execPath, join(p.dir, 'hooks', 'telemetry-count-codex.mjs'), [], process.platform === 'win32', hookGuard(false)));
  assert.equal(h.Stop.length, 1);
  assert.ok(existsSync(join(p.dir, 'bin', 'lib', 'telemetry-config.mjs')) && existsSync(join(p.dir, '.claude-plugin', 'plugin.json')));
  assert.deepEqual(enableHooks(p, ['update', 'count'], PKG, process.execPath, WORK).changed, []);
  assert.deepEqual(hookStatus(p, ['update', 'count', 'obsidize'], PKG).status, { update: 'on', count: 'on', obsidize: 'off' });
});

test('a stale command is fixed in place and status says stale until then', () => {
  const p = home();
  enableHooks(p, ['update'], PKG, process.execPath, WORK);
  const doc = JSON.parse(readFileSync(p.hooks, 'utf8'));
  doc.hooks.SessionStart[0].hooks[0].command = `"/old/node" "${join(p.dir, 'hooks', 'update-notify.mjs')}" --codex`;
  writeFileSync(p.hooks, JSON.stringify(doc));
  assert.equal(hookStatus(p, ['update'], PKG).status.update, 'stale');
  assert.deepEqual(enableHooks(p, ['update'], PKG, process.execPath, WORK).changed, ['update']);
  assert.equal(read(p).SessionStart.length, 1);
  assert.equal(hookStatus(p, ['update'], PKG).status.update, 'on');
});

test('disable removes only our handler, keeps a shared group, backs up, and reports shifted events', () => {
  const p = home();
  seed(p);
  enableHooks(p, ['update'], PKG, process.execPath, WORK);
  const doc = JSON.parse(readFileSync(p.hooks, 'utf8'));
  doc.hooks.SessionStart[1].hooks.push({ type: 'command', command: 'other' });
  doc.hooks.Stop = [{ hooks: [{ type: 'command', command: `x /hooks-custom/banker/hooks/telemetry-count-codex.mjs` }] }, { hooks: [{ type: 'command', command: 'later' }] }];
  writeFileSync(p.hooks, JSON.stringify(doc));
  const before = readFileSync(p.hooks, 'utf8');
  const r = disableHooks(p, ['update', 'count']);
  assert.deepEqual([r.changed, r.shifted], [['update', 'count'], ['Stop']]);
  const h = read(p);
  assert.deepEqual(h.SessionStart, [{ hooks: [omx] }, { hooks: [{ type: 'command', command: 'other' }] }]);
  assert.deepEqual(h.Stop, [{ hooks: [{ type: 'command', command: 'later' }] }]);
  assert.equal(readFileSync(p.backup, 'utf8'), before);
});

test('removeAll takes every banker hook and the copy folder away', () => {
  const p = home();
  seed(p);
  enableHooks(p, ['update', 'count'], PKG, process.execPath, WORK);
  assert.equal(removeAll(p).code, 0);
  assert.deepEqual(read(p), { SessionStart: [{ hooks: [omx] }] });
  assert.ok(!existsSync(p.dir));
});

test('hooks files of the wrong shape, links, and unreadable ones change nothing', (t) => {
  const p = home();
  for (const body of ['[]', '{"hooks":[]}', '{"hooks":{"Stop":{}}}']) {
    writeFileSync(p.hooks, body);
    assert.equal(enableHooks(p, ['count'], PKG, process.execPath, WORK).code, 1, body);
    assert.equal(readFileSync(p.hooks, 'utf8'), body);
  }
  const q = home();
  const real = join(root, `real${n++}`);
  writeFileSync(real, '{"hooks":{}}');
  try {
    symlinkSync(real, q.hooks);
  } catch {
    return t.skip('no file links');
  }
  assert.equal(enableHooks(q, ['count'], PKG, process.execPath, WORK).code, 1);
  assert.equal(readFileSync(real, 'utf8'), '{"hooks":{}}');
});

test('rewriting keeps the mode, and an unreadable hooks.json is not taken for a missing one', posix, (t) => {
  const p = home();
  seed(p);
  chmodSync(p.hooks, 0o600);
  enableHooks(p, ['update'], PKG, process.execPath, WORK);
  assert.equal(statSync(p.hooks).mode & 0o777, 0o600);
  if (process.getuid && process.getuid() === 0) return t.skip('root reads past mode bits');
  chmodSync(p.home, 0o000);
  try {
    assert.match(enableHooks(p, ['count'], PKG, process.execPath, WORK).msg, /확인하지 못함\(EACCES\)/);
  } finally {
    chmodSync(p.home, 0o755);
  }
});

test('command text per platform and node location rules', () => {
  assert.equal(formatCommand('/n/node', '/h/x.mjs', ['--codex'], false), '"/n/node" "/h/x.mjs" --codex');
  assert.equal(formatCommand('/n/node', '/h/$x.mjs', [], false), null);
  assert.equal(formatCommand('C:\\n\\node.exe', "C:\\o'k\\x.mjs", ['--codex'], true), "& 'C:\\n\\node.exe' 'C:\\o''k\\x.mjs' --codex");
  assert.equal(safeNode(join(tmpdir(), 'node'), { win: process.platform === 'win32', cwd: '/w', codex: false }), false);
  assert.equal(safeNode('/home/u/.nvm/node', { win: false, cwd: '/home/u', codex: true }), false);
  assert.equal(safeNode('/home/u/.nvm/node', { win: false, cwd: '/home/u', codex: false }), true);
  // A Codex session opened in the home folder itself: nvm's node under ~/.nvm stays usable; a project under home does not.
  // A home outside the temp folder (a test account's real home may sit under it).
  const w = process.platform === 'win32';
  const h = w ? 'C:\\Users\\u' : '/home/u';
  const J = w ? P.win32.join : P.join;
  assert.equal(safeNode(J(h, '.nvm', 'node'), { win: w, cwd: h, codex: true, home: h }), true);
  assert.equal(safeNode(J(h, 'proj', 'node'), { win: w, cwd: J(h, 'proj'), codex: true, home: h }), false);
  assert.equal(safeNode('/w/.nvm/node', { win: false, cwd: '/w', codex: true, home: '.' }), false, 'a relative home names no home folder');
  assert.equal(safeNode('C:\\Users\\U\\nvm\\node.exe', { win: true, cwd: 'C:\\Users\\U', codex: true, home: 'c:\\users\\u' }), true, 'Windows compares without case');
});

test('obsidize goes after shell calls only and brings its canonicalizer along', () => {
  const p = home();
  assert.deepEqual(enableHooks(p, ['obsidize'], PKG, process.execPath, WORK).changed, ['obsidize']);
  const g = read(p).PostToolUse;
  assert.deepEqual([g.length, g[0].matcher], [1, 'Bash']);
  assert.match(g[0].hooks[0].command, /obsidize-hook\.mjs["'] --codex$/);
  assert.ok(existsSync(join(p.dir, 'skills', 'obsidizer', 'obsidize.mjs')));
  assert.deepEqual(disableHooks(p, ['obsidize']).changed, ['obsidize']);
  assert.equal(read(p).PostToolUse, undefined);
});

test('every hook copy loads from the copy folder alone (no import left behind in the package)', () => {
  const p = home();
  enableHooks(p, ['update', 'count', 'obsidize'], PKG, process.execPath, WORK);
  const cfg = join(root, `cfg${n++}`);
  for (const id of ['update', 'count', 'obsidize']) {
    const script = join(p.dir, ...HOOKS[id].script.split('/'));
    const env = { ...process.env, XDG_CONFIG_HOME: cfg, APPDATA: cfg, BANKER_NO_UPDATE_CHECK: '1', BANKER_NO_TELEMETRY: '1', CODEX_HOME: p.home };
    const r = spawnSync(process.execPath, [script, ...HOOKS[id].args], { input: '{}', encoding: 'utf8', env, cwd: root, timeout: 15000 });
    assert.equal(r.status, 0, `${id}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND|Cannot find/, id);
  }
});

test('a Codex home inside the working folder gets no hooks; one in a repository gets them and a note; the home folder itself is no workspace', () => {
  const repo = join(root, `repo${n++}`);
  mkdirSync(join(repo, 'sub'), { recursive: true });
  mkdirSync(join(repo, '.git'));
  const p = codexPaths({ CODEX_HOME: join(repo, '.codex') });
  mkdirSync(p.home);
  let r = enableHooks(p, ['count'], PKG, process.execPath, repo);
  assert.equal(r.code, 1);
  assert.match(r.msg, /작업 폴더 안/);
  assert.ok(!existsSync(p.hooks) && !existsSync(p.dir), 'nothing written');
  r = enableHooks(p, ['count'], PKG, process.execPath, join(repo, 'sub'));
  assert.deepEqual([r.code, r.changed], [0, ['count']], 'a repository above the Codex home is no reason to refuse');
  assert.match(r.note, /git 저장소\(.*repo\d+\) 안에 있음/);
  assert.equal(homeInWorkspace(join(repo, '.codex'), repo), true);
  assert.equal(homeInWorkspace(join(homedir(), '.codex'), homedir()), false);
  assert.equal(homeInWorkspace(join(root, 'elsewhere'), join(repo, 'sub')), false);
  assert.equal(codexPaths({ CODEX_HOME: 'rel' }).home, join(process.cwd(), 'rel'), 'a relative CODEX_HOME is read from here, as Codex reads it');
});

test('the repository above a Codex home is found by walking up for .git, without git, and not at the home folder itself', () => {
  const top = join(root, `walk${n++}`);
  const home = join(top, 'a', 'b', '.codex');
  mkdirSync(home, { recursive: true });
  // 임시 폴더가 저장소 안이면(TMPDIR 을 저장소 안에 둔 러너) 그 저장소가 답이다. 시험 홈 위로 걸어 올라가며 직접 찾는다.
  let outer = '';
  for (let d = realpathSync(top); !outer && dirname(d) !== d; d = dirname(d)) if (existsSync(join(dirname(d), '.git'))) outer = dirname(d);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { repoAbove } from ${JSON.stringify(pathToFileURL(join(PKG, 'bin', 'lib', 'codex-hooks.mjs')).href)}; process.stdout.write(repoAbove(process.argv[1], process.argv[2]))`, home, join(top, 'a')], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(r.stdout, outer, `no .git between the home and ${outer || 'the root'}: ${r.stderr}`);
  writeFileSync(join(top, '.git'), 'gitdir: elsewhere\n'); // a worktree's .git is a file
  const realTop = realpathSync(top); // repoAbove 는 실제 경로를 돌려준다(macOS 의 임시 폴더는 /private/var 아래)
  assert.equal(repoAbove(home), realTop);
  mkdirSync(join(top, 'a', '.git'));
  assert.equal(repoAbove(home), join(realTop, 'a'));
  assert.equal(repoAbove(home, join(top, 'a')), realTop, 'the user home folder\'s own .git (dotfiles) is not counted');
});

test('a Codex home in the session folder, other than its top .codex, is one the sandbox can change', () => {
  const w = join(root, `sess${n++}`);
  mkdirSync(join(w, 'deep', '.codex'), { recursive: true });
  assert.equal(homeInSession(join(w, '.codex'), w), false, 'the top .codex is read-only to the sandbox');
  assert.equal(homeInSession(join(w, 'deep', '.codex'), w), true);
  assert.equal(homeInSession(join(w, 'codexhome'), w), true);
  assert.equal(homeInSession(w, w), true);
  assert.equal(homeInSession(join(root, 'other'), w), false);
  assert.equal(homeInSession(join(w, 'deep', '.codex'), ''), false, 'no session folder, nothing to say');
});

test('a Codex home that does not exist yet under a linked session folder is judged by the real path (macOS /var is a link)', () => {
  const w = join(root, `sessreal${n++}`);
  const link = join(root, `sesslink${n++}`);
  mkdirSync(w);
  symlinkSync(w, link, 'junction'); // 폴더 연결은 Windows 에서도 권한 없이 만들어진다
  assert.equal(homeInSession(join(link, 'codexhome'), link), true, 'a missing home under the link is still in the session folder');
  assert.equal(homeInSession(join(link, 'a', 'b', '.codex'), w), true);
  assert.equal(homeInSession(join(link, '.codex'), w), false);
  assert.equal(homeInWorkspace(join(link, 'not', 'yet', '.codex'), link), true, 'a missing home under a linked work folder is inside it');
  assert.equal(homeInWorkspace(join(root, 'elsewhere-missing', '.codex'), link), false);
});

// The npm hook commands check where the hook script really is before they run it, as the Codex plugin's commands do:
// a copy in the temp folder or the session folder (a Codex home deep in it) runs nothing and says why.
// 임시 폴더 밖의 시험 자리. Windows 는 저장소의 git 무시 폴더 work/(새 체크아웃에는 없으니 만든다)
const outsideBase = process.platform === 'win32' ? join(PKG, 'work') : '/var/tmp';
if (process.platform === 'win32') mkdirSync(outsideBase, { recursive: true });
const runCmd = (cmd, cwd, env) => (process.platform === 'win32'
  ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { cwd, encoding: 'utf8', env })
  : spawnSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', env }));
test('the npm hook command runs its script only from outside the temp folder and the session folder', { skip: !existsSync(outsideBase) && `no ${outsideBase}` }, (t) => {
  const d = realpathSync(mkdtempSync(join(outsideBase, 'codex-hooks-guard-')));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const marker = join(d, 'marker');
  const probe = (dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'probe.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran ' + process.argv.slice(2).join(' '));\n`);
    return join(dir, 'probe.mjs');
  };
  const work = join(d, 'work');
  const env = { ...process.env, HOME: join(d, 'home'), USERPROFILE: join(d, 'home') };
  mkdirSync(env.HOME, { recursive: true });
  const cmd = (script, notice = false) => formatCommand(process.execPath, script, ['--codex'], process.platform === 'win32', hookGuard(notice));
  let r = runCmd(cmd(probe(join(d, 'safe'))), probe(work) && work, env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(marker, 'utf8'), 'ran --codex');
  rmSync(marker);
  for (const script of [probe(join(work, 'deep', 'codexhome', 'hooks-custom')), probe(mkdtempSync(join(tmpdir(), 'codex-hooks-guard-')))]) {
    r = runCmd(cmd(script), work, env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^banker hooks skipped: the hook script is in a temp folder or the session folder \(/, script);
    assert.ok(!existsSync(marker), `${script}: nothing ran`);
    if (script.startsWith(tmpdir())) rmSync(dirname(script), { recursive: true, force: true });
  }
  r = runCmd(cmd(join(work, 'deep', 'codexhome', 'hooks-custom', 'probe.mjs'), true), work, env);
  assert.match(JSON.parse(r.stdout.trim()).systemMessage, /^banker hooks skipped: the hook script is in a temp folder or the session folder/);
  r = runCmd(cmd(join(work, 'probe.mjs')), work, { ...env, HOME: work, USERPROFILE: work });
  assert.equal(readFileSync(marker, 'utf8'), 'ran --codex', `a session in the home folder itself is no workspace here: ${r.stderr}`);
});

// The copies of what the hooks start (update-fetch, update-checkin) and load (obsidize) are not run by any test above:
// each is imported from the copy folder with every network call refused, in a temporary home with the opt-outs set.
const canImport = Number(process.versions.node.split('.')[0]) > 20 || (Number(process.versions.node.split('.')[0]) === 20 && Number(process.versions.node.split('.')[1]) >= 6);
test('the copies of update-fetch, update-checkin and obsidize load from the copy folder and touch no network', { skip: !canImport && 'node --import needs Node 20.6 or later' }, () => {
  const p = home();
  enableHooks(p, ['update', 'count', 'obsidize'], PKG, process.execPath, WORK);
  const tmpHome = join(root, `home${n++}`);
  mkdirSync(tmpHome);
  const mark = join(tmpHome, 'network-tries');
  const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, CODEX_HOME: p.home, XDG_CONFIG_HOME: join(tmpHome, 'cfg'), APPDATA: join(tmpHome, 'cfg'), BANKER_NO_UPDATE_CHECK: '1', BANKER_NO_TELEMETRY: '1', NO_NETWORK_MARK: mark };
  const pre = pathToFileURL(join(PKG, 'scripts', 'test-fixtures', 'no-network.mjs')).href;
  for (const rel of ['hooks/update-fetch.mjs', 'hooks/update-checkin.mjs', 'skills/obsidizer/obsidize.mjs']) {
    const copy = join(p.dir, ...rel.split('/'));
    const r = spawnSync(process.execPath, ['--import', pre, '--input-type=module', '-e', 'await import(process.argv[1])', pathToFileURL(copy).href], { input: '', encoding: 'utf8', env, cwd: tmpHome, timeout: 15000 });
    assert.equal(r.status, 0, `${rel}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND|Cannot find/, rel);
  }
  assert.equal(existsSync(mark) ? readFileSync(mark, 'utf8') : '', '', 'no network call was tried');
});

test('the copy carries everything the hooks import or start: relative imports and the scripts they name resolve inside it', () => {
  const inCopy = new Set(PAYLOAD);
  const names = new Set(PAYLOAD.map((f) => basename(f)));
  for (const rel of PAYLOAD.filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(join(PKG, ...rel.split('/')), 'utf8');
    for (const m of src.matchAll(/(?:from\s+|import\(\s*)'(\.{1,2}\/[^']+)'/g)) {
      const target = P.normalize(P.join(P.dirname(rel), m[1]));
      assert.ok(inCopy.has(target), `${rel} imports ${target}, which the copy lacks`);
    }
    for (const m of src.matchAll(/'([\w.-]+\.mjs)'/g)) assert.ok(names.has(m[1]), `${rel} names ${m[1]}, which the copy lacks`);
  }
});

// Plan S11 B1: a stale hooks.json.lock that cannot be removed (a file, a folder with something in it) ends the wait with
// its reason inside the 5 seconds instead of spinning forever. Run in a child so a regression times out, not the runner.
test('a stale lock that cannot be removed ends with a named failure, not an endless loop', () => {
  for (const kind of ['file', 'folder with a file']) {
    const p = home();
    const lock = `${p.hooks}.lock`;
    if (kind === 'file') writeFileSync(lock, 'x');
    else { mkdirSync(lock); writeFileSync(join(lock, 'f'), 'x'); }
    const old = new Date(Date.now() - 60000);
    utimesSync(lock, old, old);
    const src = `import { enableHooks } from ${JSON.stringify(pathToFileURL(join(PKG, 'bin', 'lib', 'codex-hooks.mjs')).href)};`
      + `const r = enableHooks(${JSON.stringify(p)}, ['update'], ${JSON.stringify(PKG)}, process.execPath, ${JSON.stringify(WORK)}); process.stdout.write(JSON.stringify(r));`;
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.signal, null, `${kind}: the lock wait did not end (${r.stderr})`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.code, 1, kind);
    assert.match(out.msg, /의 낡은 잠금 .*hooks\.json\.lock 을 지우지 못함\([A-Z]+\)\. 다른 banker 나 teamwork 가 돌고 있지 않으면 직접 지우십시오/, kind);
    assert.ok(Date.now() - t0 < 15000, `${kind}: ended within the wait`);
    assert.ok(!existsSync(p.hooks), `${kind}: hooks.json not written`);
  }
});

test('a stale empty lock folder is cleared and the change goes through', () => {
  const p = home();
  const lock = `${p.hooks}.lock`;
  mkdirSync(lock);
  const old = new Date(Date.now() - 60000);
  utimesSync(lock, old, old);
  assert.equal(enableHooks(p, ['update'], PKG, process.execPath, WORK).code, 0);
  assert.ok(!existsSync(lock));
});

// Plan S11 Q2: Windows' JS realpath keeps an 8.3 short name (TEMP=C:\Users\LONGNA~1\...) as it is; the guard resolves
// with realpathSync.native, so a hook copy under the long name of a short-named TEMP is still refused.
test('the npm hook command refuses a script under a TEMP written as an 8.3 short name', { skip: process.platform !== 'win32' && '8.3 short names are Windows only' }, (t) => {
  const long = realpathSync(mkdtempSync(join(outsideBase, 'codex-hooks a long temp folder ')));
  t.after(() => rmSync(long, { recursive: true, force: true }));
  const short = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${long.replace(/'/g, "''")}').ShortPath`], { encoding: 'utf8' }).stdout.trim();
  if (!short || short.toLowerCase() === long.toLowerCase()) {
    t.skip('this volume makes no 8.3 names');
    return;
  }
  const marker = join(long, 'marker');
  mkdirSync(join(long, 'copy'));
  const script = join(long, 'copy', 'probe.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  const work = join(outsideBase, 'codex-hooks-short-work');
  mkdirSync(work, { recursive: true });
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const r = runCmd(formatCommand(process.execPath, script, ['--codex'], true, hookGuard(false)), work, { ...process.env, TEMP: short, TMP: short });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^banker hooks skipped: the hook script is in a temp folder or the session folder/);
  assert.ok(!existsSync(marker), 'nothing ran');
});
