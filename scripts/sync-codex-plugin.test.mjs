// Tests for sync-codex-plugin.js: the Codex plugin's hook commands run the node PATH names only from a safe place.
// Run from the repo root: node --test scripts/sync-codex-plugin.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { hookFiles, hooksRev, hooksText, psCommand, shCommand, HOOKS_FILE } = require('./sync-codex-plugin.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'codex-plugin-hooks-')));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
// A plugin folder whose hooks/probe.mjs writes `ran <args>` to the marker file, and an empty session folder.
function setup() {
  const d = join(base, `c${n++}`);
  const plugin = join(d, 'plugin');
  const work = join(d, 'work');
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  mkdirSync(work);
  const marker = join(d, 'marker');
  writeFileSync(join(plugin, 'hooks', 'probe.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran ' + process.argv.slice(2).join(' '));\nwriteFileSync(${JSON.stringify(marker + '.cwd')}, process.cwd());\n`);
  writeFileSync(join(plugin, 'hooks', 'run.cjs'), readFileSync(join(ROOT, 'hooks', 'run.cjs')));
  return { d, plugin, work, marker };
}
const nodeDir = dirname(realpathSync(process.execPath));
const posix = { skip: process.platform === 'win32' && 'sh commands' };
const windows = { skip: process.platform !== 'win32' && 'PowerShell commands' };
// A base outside the temp folders the sh commands refuse, for tests where another rule must decide: /var/tmp on Linux,
// and on macOS the per-user TMPDIR while the command is told another TMPDIR.
const homeBase = process.platform === 'darwin' ? tmpdir() : '/var/tmp';
const homeCase = { skip: process.platform === 'win32' ? 'sh commands' : !existsSync(homeBase) && `no ${homeBase}` };

function sh(c, cmd, path) {
  return spawnSync('/bin/sh', ['-c', cmd], { cwd: c.work, encoding: 'utf8', env: { PATH: path, PLUGIN_ROOT: c.plugin, TMPDIR: tmpdir(), HOME: c.d } });
}
// A fake node in dir that writes `evil` to the marker.
function fakeNode(c, dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'node'), `#!/bin/sh\necho evil > "${c.marker}"\n`);
  chmodSync(join(dir, 'node'), 0o755);
}

test('the hooks file is what the script writes', () => {
  assert.equal(readFileSync(join(ROOT, ...HOOKS_FILE.split('/')), 'utf8'), hooksText());
});

// Codex keeps a hook's trust by its command's hash, so the command carries a hash of the code it runs: new hook code is
// a new command, which Codex asks to trust again (measured on 0.160.1: a changed command goes back to review).
test('the commands carry a hash of every file the hooks run, so changed hook code asks for trust again', () => {
  const files = hookFiles();
  for (const f of ['hooks/run.cjs', 'hooks/update-notify.mjs', 'hooks/telemetry-count-codex.mjs', 'hooks/update-fetch.mjs', 'hooks/update-checkin.mjs', 'bin/lib/telemetry-config.mjs', 'bin/lib/codex-routes.mjs']) {
    assert.ok(files.includes(f), `${f} is a hook file`);
  }
  const real = (rel) => readFileSync(join(ROOT, ...rel.split('/')), 'utf8');
  // Any script a hook file's code names, in any form (a path in pieces, a template, no quotes), is in the hash too.
  for (const f of files) {
    const code = real(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
    for (const [name] of code.matchAll(/[A-Za-z0-9_-]+\.(?:mjs|cjs)/g)) {
      for (const dir of [f.slice(0, f.lastIndexOf('/')), 'hooks', 'bin/lib']) {
        if (existsSync(join(ROOT, dir, name))) assert.ok(files.includes(`${dir}/${name}`), `${f} names ${dir}/${name}, which the hash leaves out`);
      }
    }
  }
  const rev = hooksRev();
  assert.match(rev, /^[0-9a-f]{12}$/);
  for (const f of files) assert.notEqual(hooksRev((rel) => (rel === f ? `${real(rel)}\n// changed` : real(rel))), rev, `a change to ${f} changes the hash`);
  assert.equal(hooksRev((rel) => real(rel).replace(/\r?\n/g, '\r\n')), rev, 'a CRLF checkout gives the same hash');
  const doc = JSON.parse(readFileSync(join(ROOT, ...HOOKS_FILE.split('/')), 'utf8'));
  for (const h of Object.values(doc.hooks).flat().flatMap((g) => g.hooks)) {
    assert.ok(h.command.startsWith(`: banker-hooks-rev ${rev}; `), h.command.slice(0, 60));
    assert.ok(h.commandWindows.startsWith(`$null = 'banker-hooks-rev ${rev}'; `), h.commandWindows.slice(0, 60));
  }
});

test('sh: the node PATH names runs the hook, with and without run.cjs', posix, () => {
  const c = setup();
  const r = sh(c, shCommand('probe.mjs', ['--codex', '--plugin'], true), `${nodeDir}${delimiter}/usr/bin${delimiter}/bin`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran --codex --plugin');
  assert.equal(readFileSync(`${c.marker}.cwd`, 'utf8'), c.plugin, 'runs from the plugin folder, so a shim reads no version file of the session folder');
  rmSync(c.marker);
  sh(c, shCommand('probe.mjs', [], false), `${nodeDir}${delimiter}/usr/bin${delimiter}/bin`);
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran ');
});

test('sh: a node in the temp folder, the session folder, or a relative PATH entry runs nothing', posix, () => {
  for (const where of ['tmp', 'work', 'relative']) {
    const c = setup();
    const dir = where === 'tmp' ? join(c.d, 'bin') : join(c.work, 'bin');
    fakeNode(c, dir);
    const path = where === 'relative' ? `bin${delimiter}/usr/bin${delimiter}/bin` : `${dir}${delimiter}${nodeDir}${delimiter}/usr/bin${delimiter}/bin`;
    const r = sh(c, shCommand('probe.mjs', [], true), path);
    assert.equal(r.status, 0, `${where}: ${r.stderr}`);
    assert.ok(!existsSync(c.marker), `${where}: nothing ran`);
  }
});

test('sh: a refusal says why: on stderr, and at session start as a systemMessage', posix, () => {
  const c = setup();
  let r = sh(c, shCommand('probe.mjs', [], true, false, '', [join(c.d, 'none')]), join(c.d, 'empty'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^banker hooks skipped: node is not on PATH/);
  const dir = join(c.d, 'bin');
  fakeNode(c, dir);
  r = sh(c, shCommand('probe.mjs', [], true, true), `${dir}${delimiter}/usr/bin${delimiter}/bin`);
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout.trim()).systemMessage, /^banker hooks skipped: node is in a temp folder/);
  assert.ok(!existsSync(c.marker));
});

test('sh: no PLUGIN_ROOT or no node runs nothing and exits 0', posix, () => {
  const c = setup();
  const cmd = shCommand('probe.mjs', [], true, false, '', [join(c.d, 'none')]); // no node in the known install folders either
  let r = spawnSync('/bin/sh', ['-c', cmd], { cwd: c.work, encoding: 'utf8', env: { PATH: `${nodeDir}${delimiter}/usr/bin${delimiter}/bin` } });
  assert.equal(r.status, 0);
  r = sh(c, cmd, join(c.d, 'empty'));
  assert.equal(r.status, 0);
  assert.ok(!existsSync(c.marker));
  r = spawnSync('/bin/sh', ['-c', cmd], { cwd: '/', encoding: 'utf8', env: { PATH: `${nodeDir}${delimiter}/usr/bin${delimiter}/bin`, PLUGIN_ROOT: c.plugin } });
  assert.equal(r.status, 0);
  assert.ok(!existsSync(c.marker), 'a session folder of / runs nothing');
  // At session start a missing PLUGIN_ROOT says so, as every other refusal does.
  r = spawnSync('/bin/sh', ['-c', shCommand('probe.mjs', [], true, true)], { cwd: c.work, encoding: 'utf8', env: { PATH: `${nodeDir}${delimiter}/usr/bin${delimiter}/bin` } });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout.trim()).systemMessage, 'banker hooks skipped: PLUGIN_ROOT is not set');
});

// A folder outside every temp folder the commands refuse (see homeBase below), holding a `node` that runs the real one.
// A link straight to process.execPath would not do: on some systems (Rocky's /usr/bin/node-22) the real file is not
// named node, and the command rightly takes it for a multicall shim.
function outside(t) {
  const d = realpathSync(mkdtempSync(join(homeBase, 'codex-plugin-out-')));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const real = join(d, 'real');
  mkdirSync(real);
  writeFileSync(join(real, 'node'), `#!/bin/sh\nexec "${realpathSync(process.execPath)}" "$@"\n`);
  chmodSync(join(real, 'node'), 0o755);
  return { d, node: join(real, 'node') };
}

// A Codex started from the macOS desktop has launchd's PATH, without Homebrew's folder: the command looks in the folders
// Homebrew and the nodejs.org installer use, and judges what it finds there as it judges PATH's node.
test('sh: with no node on PATH, a node in the known install folders runs the hook; none there says so', homeCase, (t) => {
  const c = setup();
  const o = outside(t);
  const env = { PATH: `/usr/bin${delimiter}/bin`, PLUGIN_ROOT: c.plugin, TMPDIR: '/nonexistent', HOME: c.d };
  let r = spawnSync('/bin/sh', ['-c', shCommand('probe.mjs', [], true, false, '', [join(c.d, 'none'), dirname(o.node)])], { cwd: c.work, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran ');
  rmSync(c.marker);
  // A node in a known folder that is the temp folder is refused like one on PATH.
  const tmpKnown = join(c.d, 'tmpknown');
  fakeNode(c, tmpKnown);
  r = spawnSync('/bin/sh', ['-c', shCommand('probe.mjs', [], true, false, '', [tmpKnown])], { cwd: c.work, encoding: 'utf8', env: { ...env, TMPDIR: tmpdir() } });
  assert.match(r.stderr, /^banker hooks skipped: node is in a temp folder/);
  assert.ok(!existsSync(c.marker));
  r = spawnSync('/bin/sh', ['-c', shCommand('probe.mjs', [], true, true, '', [join(c.d, 'none')])], { cwd: c.work, encoding: 'utf8', env });
  assert.equal(JSON.parse(r.stdout.trim()).systemMessage, "banker hooks skipped: node is not on PATH (a Codex started from the desktop may not have the shell's PATH)");
});

// macOS before 12.3 has neither realpath nor readlink -f. The command then follows the links itself, a relative one
// from the folder of the link, and judges where they end. The stand-ins sit outside the temp folders, or the command
// would drop their folder from PATH and use the system's.
test('sh: with no realpath and no readlink -f, the links are followed one readlink at a time', homeCase, (t) => {
  const c = setup();
  const o = outside(t);
  const readlink = spawnSync('/bin/sh', ['-c', 'command -v readlink'], { encoding: 'utf8' }).stdout.trim();
  const stubs = join(o.d, 'stubs');
  mkdirSync(stubs);
  writeFileSync(join(stubs, 'realpath'), `#!/bin/sh\necho realpath >> "${o.d}/asked"\nexit 1\n`);
  writeFileSync(join(stubs, 'readlink'), `#!/bin/sh\necho "readlink $1" >> "${o.d}/asked"\n[ "$1" = -f ] && exit 1\nexec "${readlink}" "$@"\n`);
  for (const f of ['realpath', 'readlink']) chmodSync(join(stubs, f), 0o755);
  // node -> ../mid/node (relative) -> <outside>/real/node (absolute)
  const bin = join(c.d, 'bin');
  const mid = join(c.d, 'mid');
  mkdirSync(bin);
  mkdirSync(mid);
  symlinkSync(o.node, join(mid, 'node'));
  symlinkSync(join('..', 'mid', 'node'), join(bin, 'node'));
  const env = { PATH: `${bin}${delimiter}${stubs}${delimiter}/usr/bin${delimiter}/bin`, PLUGIN_ROOT: c.plugin, TMPDIR: '/nonexistent', HOME: c.d };
  let r = spawnSync('/bin/sh', ['-c', shCommand('probe.mjs', [], true)], { cwd: c.work, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran ');
  assert.match(readFileSync(join(o.d, 'asked'), 'utf8'), /realpath\nreadlink -f\nreadlink /, 'both were missing, so plain readlink followed the links');
  rmSync(c.marker);
  // A chain that ends in the temp folder is refused.
  const tmpNode = join(c.d, 'tmpnode');
  fakeNode(c, tmpNode);
  rmSync(join(mid, 'node'));
  symlinkSync(join(tmpNode, 'node'), join(mid, 'node'));
  r = spawnSync('/bin/sh', ['-c', shCommand('probe.mjs', [], true)], { cwd: c.work, encoding: 'utf8', env: { ...env, TMPDIR: tmpdir() } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^banker hooks skipped: node is in a temp folder/);
  assert.ok(!existsSync(c.marker), 'nothing ran');
});

// Nothing but node is looked up in the session folder: a project's .venv/bin or node_modules/.bin on PATH, which the
// sandbox can write, lends no realpath, readlink or tr. The hook still runs with the node PATH names elsewhere.
test('sh: a realpath, readlink or tr planted on a PATH entry in the session folder never runs', homeCase, (t) => {
  const c = setup();
  const o = outside(t);
  const venv = join(c.work, '.venv', 'bin');
  mkdirSync(venv, { recursive: true });
  for (const f of ['realpath', 'readlink', 'tr', 'mise']) {
    writeFileSync(join(venv, f), `#!/bin/sh\necho ${f} >> "${c.d}/planted"\nexit 1\n`);
    chmodSync(join(venv, f), 0o755);
  }
  const env = { PATH: `${venv}${delimiter}${dirname(o.node)}${delimiter}/usr/bin${delimiter}/bin`, PLUGIN_ROOT: c.plugin, TMPDIR: '/nonexistent', HOME: c.d };
  let r = spawnSync('/bin/sh', ['-c', shCommand('probe.mjs', [], true)], { cwd: c.work, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran ');
  // A refusal notice goes through tr: the planted one is not it.
  r = spawnSync('/bin/sh', ['-c', shCommand('probe.mjs', [], true, true, '', [join(c.d, 'none')])], { cwd: c.work, encoding: 'utf8', env: { ...env, PATH: `${venv}${delimiter}/usr/bin${delimiter}/bin` } });
  assert.match(JSON.parse(r.stdout.trim()).systemMessage, /^banker hooks skipped: node is not on PATH/);
  // A multicall shim's own children get the cleaned PATH too.
  const shims = join(o.d, 'shims');
  mkdirSync(shims);
  writeFileSync(join(o.d, 'multicall'), `#!/bin/sh\nmise >/dev/null 2>&1\ncase "$(basename "$0")" in node) exec "${realpathSync(process.execPath)}" "$@";; esac\nexit 2\n`);
  chmodSync(join(o.d, 'multicall'), 0o755);
  symlinkSync(join(o.d, 'multicall'), join(shims, 'node'));
  rmSync(c.marker);
  r = spawnSync('/bin/sh', ['-c', shCommand('probe.mjs', [], true)], { cwd: c.work, encoding: 'utf8', env: { ...env, PATH: `${venv}${delimiter}${shims}${delimiter}/usr/bin${delimiter}/bin` } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran ');
  assert.ok(!existsSync(join(c.d, 'planted')), `planted helpers ran: ${existsSync(join(c.d, 'planted')) ? readFileSync(join(c.d, 'planted'), 'utf8') : ''}`);
  // A PATH of nothing but the session folder cleans to nothing; bash would read that as the current folder.
  rmSync(c.marker);
  for (const sh of ['/bin/sh', '/bin/bash'].filter((f) => existsSync(f))) {
    r = spawnSync(sh, ['-c', shCommand('probe.mjs', [], true, false, '', [dirname(o.node)])], { cwd: c.work, encoding: 'utf8', env: { ...env, PATH: venv } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(c.marker, 'utf8'), 'ran ', sh);
    rmSync(c.marker);
  }
  for (const f of ['realpath', 'readlink']) writeFileSync(join(c.work, f), `#!/bin/sh\necho ${f} >> "${c.d}/planted"\nexit 1\n`, { mode: 0o755 });
  r = spawnSync('/bin/sh', ['-c', shCommand('probe.mjs', [], true, false, '', [dirname(o.node)])], { cwd: c.work, encoding: 'utf8', env: { ...env, PATH: c.work } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(c.d, 'planted')), 'an empty cleaned PATH does not become the session folder');
});

function ps(c, cmd, path) {
  const env = { ...process.env, PATH: path, PLUGIN_ROOT: c.plugin };
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { cwd: c.work, encoding: 'utf8', env });
}
const sysPath = () => [join(process.env.SystemRoot || 'C:\\Windows', 'System32'), join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')].join(delimiter);

test('PowerShell: the node PATH names runs the hook; one under TEMP or the session folder runs nothing', windows, () => {
  const c = setup();
  let r = ps(c, psCommand('probe.mjs', ['--codex'], true), `${nodeDir}${delimiter}${sysPath()}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran --codex');
  assert.equal(readFileSync(`${c.marker}.cwd`, 'utf8').toLowerCase(), c.plugin.toLowerCase());
  rmSync(c.marker);
  // A real node.exe copied under TEMP or into the session folder runs nothing and says why on stderr.
  for (const dir of [join(c.d, 'bin'), join(c.work, 'bin')]) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(process.execPath, join(dir, 'node.exe'));
    r = ps(c, psCommand('probe.mjs', [], true), `${dir}${delimiter}${nodeDir}${delimiter}${sysPath()}`);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(c.marker), `${dir}: nothing ran`);
    assert.match(r.stderr, /banker hooks skipped: node is in a temp folder or the session folder/);
  }
  // A node.cmd shim under TEMP is refused before it runs; the node.exe after it on PATH does not stand in for it.
  const cmd = join(c.d, 'cmd');
  mkdirSync(cmd);
  writeFileSync(join(cmd, 'node.cmd'), `@echo evil> "${c.marker}"\r\n`);
  r = ps(c, psCommand('probe.mjs', [], true), `${cmd}${delimiter}${nodeDir}${delimiter}${sysPath()}`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(c.marker), 'neither the shim nor the node.exe after it ran');
  assert.match(r.stderr, /banker hooks skipped: node is in a temp folder or the session folder/);
  // At session start a refusal is a systemMessage the TUI shows.
  r = ps(c, psCommand('probe.mjs', [], true, true), sysPath());
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout.trim()).systemMessage, /^banker hooks skipped: node is not on PATH/);
  const env = { ...process.env, PATH: `${nodeDir}${delimiter}${sysPath()}` };
  delete env.PLUGIN_ROOT;
  r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand('probe.mjs', [], true, true)], { cwd: c.work, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim()).systemMessage, 'banker hooks skipped: PLUGIN_ROOT is not set');
});

// The temp folders a Windows test may use are moved aside, so a folder under the real TEMP stands for a safe place.
const asideEnv = (c, extra) => ({ ...process.env, PLUGIN_ROOT: c.plugin, TEMP: join(c.d, 't1'), TMP: join(c.d, 't2'), LOCALAPPDATA: join(c.d, 'la'), ...extra });
const psRun = (c, cmd, env) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { cwd: c.work, encoding: 'utf8', env });

// mise's file mode puts node.cmd first on PATH. The command asks it, from the plugin folder, for the node.exe it runs
// and runs that, so the hook gets the node the user picked rather than the first node.exe after the shim.
test('PowerShell: a node.cmd shim runs the node.exe it names; one that names none, or one in the session folder, runs nothing', windows, () => {
  const c = setup();
  const shim = join(c.d, 'shim');
  mkdirSync(shim);
  writeFileSync(join(shim, 'node.cmd'), `@"${realpathSync(process.execPath)}" %*\r\n`);
  let r = psRun(c, psCommand('probe.mjs', ['--codex'], true), asideEnv(c, { PATH: `${shim}${delimiter}${sysPath()}` }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran --codex');
  assert.equal(readFileSync(`${c.marker}.cwd`, 'utf8').toLowerCase(), c.plugin.toLowerCase(), 'asked and run from the plugin folder');
  rmSync(c.marker);
  writeFileSync(join(shim, 'node.cmd'), '@echo off\r\n');
  r = psRun(c, psCommand('probe.mjs', [], true), asideEnv(c, { PATH: `${shim}${delimiter}${nodeDir}${delimiter}${sysPath()}` }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /banker hooks skipped: the node shim .*node\.cmd did not name its node/);
  assert.ok(!existsSync(c.marker));
  const inWork = join(c.work, 'bin');
  mkdirSync(inWork);
  writeFileSync(join(inWork, 'node.cmd'), `@echo evil> "${c.marker}"\r\n`);
  r = psRun(c, psCommand('probe.mjs', [], true), asideEnv(c, { PATH: `${inWork}${delimiter}${nodeDir}${delimiter}${sysPath()}` }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /banker hooks skipped: node is in a temp folder or the session folder/);
  assert.ok(!existsSync(c.marker), 'the shim in the session folder never ran');
});

// cmd.exe looks up what a .cmd shim names (mise) on PATH: a helper planted on a PATH entry in the session folder is
// passed over for the one outside it.
test('PowerShell: what a node.cmd shim starts by name is not taken from a PATH entry in the session folder', windows, () => {
  const c = setup();
  const safe = join(c.d, 'safe');
  mkdirSync(safe);
  writeFileSync(join(safe, 'helper.cmd'), `@"${realpathSync(process.execPath)}" %*\r\n`);
  writeFileSync(join(safe, 'node.cmd'), '@call helper.cmd %*\r\n');
  const planted = join(c.work, 'bin');
  mkdirSync(planted);
  writeFileSync(join(planted, 'helper.cmd'), `@echo planted>> "${join(c.d, 'planted')}"\r\n`);
  const r = psRun(c, psCommand('probe.mjs', [], true), asideEnv(c, { PATH: `${planted}${delimiter}${safe}${delimiter}${sysPath()}` }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran ');
  assert.ok(!existsSync(join(c.d, 'planted')), 'the planted helper never ran');
});

// A session opened through a junction is the folder the junction leads to: a node.exe PATH names by that real path is
// still in the session folder.
test('PowerShell: a session folder opened through a junction still refuses a node.exe inside it', windows, () => {
  const c = setup();
  const real = join(c.d, 'real');
  const proj = join(real, 'proj');
  mkdirSync(join(proj, 'bin'), { recursive: true });
  copyFileSync(process.execPath, join(proj, 'bin', 'node.exe'));
  symlinkSync(real, join(c.d, 'jn'), 'junction');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand('probe.mjs', [], true)], {
    cwd: join(c.d, 'jn', 'proj'), encoding: 'utf8', env: asideEnv(c, { PATH: `${join(proj, 'bin')}${delimiter}${sysPath()}` }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /banker hooks skipped: node is in a temp folder or the session folder/);
  assert.ok(!existsSync(c.marker));
});

// A TEMP in 8.3 form (C:\Users\LONGNA~1\...) names the same folder as the long path a node.exe is found under.
test('PowerShell: a TEMP written as an 8.3 short name still refuses a node.exe under it', windows, (t) => {
  const c = setup();
  const long = join(c.d, 'a long temp folder name');
  mkdirSync(long);
  const short = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${long.replace(/'/g, "''")}').ShortPath`], { encoding: 'utf8' }).stdout.trim();
  if (!short || short.toLowerCase() === long.toLowerCase()) {
    t.skip('this volume makes no 8.3 names');
    return;
  }
  const bin = join(long, 'bin');
  mkdirSync(bin);
  copyFileSync(process.execPath, join(bin, 'node.exe'));
  const r = psRun(c, psCommand('probe.mjs', [], true), asideEnv(c, { TEMP: short, PATH: `${bin}${delimiter}${sysPath()}` }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /banker hooks skipped: node is in a temp folder or the session folder/);
  assert.ok(!existsSync(c.marker));
});

// A session opened in the home folder: a node kept under home (nvm) still runs the hook; a project under home is still
// a session folder.
test('sh: a session in the home folder runs a node kept under home; a project session under home refuses a node inside it', homeCase, () => {
  const d = realpathSync(mkdtempSync(join(homeBase, 'codex-plugin-home-')));
  try {
    const c = setup();
    const home = join(d, 'home');
    const bin = join(home, '.nvm', 'bin');
    mkdirSync(bin, { recursive: true });
    const projBin = join(home, 'proj', 'bin');
    mkdirSync(projBin, { recursive: true });
    for (const b of [bin, projBin]) {
      writeFileSync(join(b, 'node'), `#!/bin/sh\nexec "${realpathSync(process.execPath)}" "$@"\n`);
      chmodSync(join(b, 'node'), 0o755);
    }
    const run = (cwd, b = bin) => spawnSync('/bin/sh', ['-c', shCommand('probe.mjs', [], true)], { cwd, encoding: 'utf8', env: { PATH: `${b}${delimiter}/usr/bin${delimiter}/bin`, PLUGIN_ROOT: c.plugin, TMPDIR: '/tmp', HOME: home } });
    let r = run(home);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(c.marker, 'utf8'), 'ran ');
    rmSync(c.marker);
    r = run(join(home, 'proj'), projBin);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(c.marker), 'a project under home is a session folder');
    // A HOME that is not an absolute path names no home folder: the session folder rule holds.
    r = spawnSync('/bin/sh', ['-c', shCommand('probe.mjs', [], true)], { cwd: home, encoding: 'utf8', env: { PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`, PLUGIN_ROOT: c.plugin, TMPDIR: '/tmp', HOME: '.' } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(c.marker), 'HOME=. is no home folder');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('PowerShell: a session in USERPROFILE runs a node.exe kept under it; a project session under it refuses a node.exe inside it', windows, () => {
  const c = setup();
  const home = join(c.d, 'home');
  const bin = join(home, 'nvm');
  mkdirSync(bin, { recursive: true });
  const projBin = join(home, 'proj', 'bin');
  mkdirSync(projBin, { recursive: true });
  copyFileSync(process.execPath, join(bin, 'node.exe'));
  copyFileSync(process.execPath, join(projBin, 'node.exe'));
  // The base is under the real TEMP: the command is told other temp folders so the home rule alone decides.
  const run = (cwd, b = bin) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand('probe.mjs', [], true)], {
    cwd, encoding: 'utf8',
    env: { ...process.env, PATH: `${b}${delimiter}${sysPath()}`, PLUGIN_ROOT: c.plugin, TEMP: join(c.d, 't1'), TMP: join(c.d, 't2'), LOCALAPPDATA: join(c.d, 'la'), USERPROFILE: home },
  });
  let r = run(home);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran ');
  rmSync(c.marker);
  r = run(join(home, 'proj'), projBin);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(c.marker), 'a project under USERPROFILE is a session folder');
});

// A multicall shim (Volta, mise, snap): PATH's node is a link to a program that reads its argv0. Run by its real path it
// fails; the command asks it, as node, for the node binary and runs that.
test('sh: a multicall shim on PATH runs the node binary it names', homeCase, () => {
  const d = realpathSync(mkdtempSync(join(homeBase, 'codex-plugin-shim-')));
  try {
    const c = setup();
    const shims = join(d, 'shims');
    const real = join(d, 'real');
    mkdirSync(shims);
    mkdirSync(real);
    writeFileSync(join(real, 'multicall'), `#!/bin/sh\ncase "$(basename "$0")" in node) exec "${realpathSync(process.execPath)}" "$@";; *) echo "multicall: should not be called directly" >&2; exit 2;; esac\n`);
    chmodSync(join(real, 'multicall'), 0o755);
    symlinkSync(join(real, 'multicall'), join(shims, 'node'));
    const r = spawnSync('/bin/sh', ['-c', shCommand('probe.mjs', ['--codex'], true)], { cwd: c.work, encoding: 'utf8', env: { PATH: `${shims}${delimiter}/usr/bin${delimiter}/bin`, PLUGIN_ROOT: c.plugin, TMPDIR: '/tmp', HOME: d } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(readFileSync(c.marker, 'utf8'), 'ran --codex');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
