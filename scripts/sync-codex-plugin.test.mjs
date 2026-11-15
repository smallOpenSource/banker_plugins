// Tests for sync-codex-plugin.js: the Codex plugin's hook commands run the node PATH names only from a safe place.
// Run from the repo root: node --test scripts/sync-codex-plugin.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { hookFiles, hooksRev, hooksText, psCommand, shCommand, HOOK_TIMEOUT, HOOKS_FILE } = require('./sync-codex-plugin.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'codex-plugin-hooks-')));
after(() => rmSync(base, { recursive: true, force: true }));
// The commands judge the plugin folder as they judge node, so the test plugin folders sit outside every temp folder and
// the session folder: /var/tmp on Linux and macOS, the repository's git-ignored work/ on Windows.
const plugBase = process.platform === 'win32' ? join(ROOT, 'work') : '/var/tmp';
mkdirSync(plugBase, { recursive: true });
const plugins = realpathSync(mkdtempSync(join(plugBase, 'codex-plugin-root-')));
after(() => rmSync(plugins, { recursive: true, force: true }));
let n = 0;
// A plugin folder (with run.cjs and codex-hook.cjs) whose hooks/probe.mjs writes `ran <args>` to the marker file (and PATH to marker.path), and an empty
// session folder.
function setup() {
  const d = join(base, `c${n}`);
  const plugin = join(plugins, `c${n++}`);
  const work = join(d, 'work');
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  mkdirSync(work, { recursive: true });
  const marker = join(d, 'marker');
  writeFileSync(join(plugin, 'hooks', 'probe.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran ' + process.argv.slice(2).join(' '));\nwriteFileSync(${JSON.stringify(marker + '.cwd')}, process.cwd());\nwriteFileSync(${JSON.stringify(marker + '.path')}, process.env.PATH);\n`);
  for (const f of ['run.cjs', 'codex-hook.cjs']) writeFileSync(join(plugin, 'hooks', f), readFileSync(join(ROOT, 'hooks', f)));
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

// Codex 0.169.0 hashes the whole plugin folder before each plugin hook, within that hook's limit: one Stop hook does both
// Stop jobs, and each limit is 10 s (a slow Windows PC went past 5 s, then past 10 s with two Stop hooks).
test('the hooks file has one SessionStart and one Stop hook, each with a 10 s limit; the Stop hook runs stop-codex.mjs', () => {
  const doc = JSON.parse(readFileSync(join(ROOT, ...HOOKS_FILE.split('/')), 'utf8'));
  assert.deepEqual(Object.keys(doc.hooks), ['SessionStart', 'Stop']);
  assert.equal(HOOK_TIMEOUT, 10);
  for (const g of Object.values(doc.hooks).flat()) {
    assert.equal(g.hooks.length, 1);
    assert.equal(g.hooks[0].timeout, HOOK_TIMEOUT);
  }
  assert.equal(doc.hooks.Stop.length, 1);
  for (const cmd of [doc.hooks.Stop[0].hooks[0].command, doc.hooks.Stop[0].hooks[0].commandWindows]) assert.match(cmd, /hooks[\\/]stop-codex\.mjs/);
  // The Windows command imports the hook in the node it judged: no second node through run.cjs.
  for (const g of Object.values(doc.hooks).flat()) assert.doesNotMatch(g.hooks[0].commandWindows, /run\.cjs/);
});

// The Windows command hands node hooks\codex-hook.cjs from the plugin folder, started through .NET: Windows PowerShell
// 5.1's & started a process about 0.25 s later once its command passed about 2,040 characters (Windows box).
test('the PowerShell command starts node through .NET with codex-hook.cjs, never through & or run.cjs', () => {
  for (const notice of [false, true]) {
    const cmd = psCommand('probe.mjs', ['--codex'], true, notice);
    // node starts in the plugin folder (a Volta or mise .exe shim reads no version file of the session folder) and is told
    // the session folder in BANKER_HOOK_SESSION
    assert.ok(cmd.endsWith(`$env:BANKER_HOOK_SESSION=$w0;$s=New-Object Diagnostics.ProcessStartInfo $r,('"'+$pr+'\\hooks\\codex-hook.cjs"${notice ? ' --notice' : ''} "'+$pr+'\\hooks\\probe.mjs" --codex');$s.WorkingDirectory=$pr;$s.UseShellExecute=0;try{$h=[Diagnostics.Process]::Start($s)}catch{x "cannot start node ($r)"};$h.WaitForExit();exit $h.ExitCode`), cmd.slice(-360));
    assert.doesNotMatch(cmd, /run\.cjs|&\$r "/);
  }
  assert.ok(hookFiles().includes('hooks/codex-hook.cjs'), 'its code is in the hooks hash');
});

// codex-hook.cjs, run with the node running this test (on every OS: its paths are compared as the OS compares them):
// node codex-hook.cjs <script> <args> runs the script from the plugin folder with its args and PATH without the entries
// under the session folder or a temp folder.
test('codex-hook.cjs runs the hook from the plugin folder with its args and PATH cleaned', () => {
  const c = setup();
  const inWork = join(c.work, 'bin');
  const inTemp = join(c.d, 'tbin');
  mkdirSync(inWork);
  mkdirSync(inTemp);
  const env = { ...process.env, PLUGIN_ROOT: c.plugin, TEMP: c.d, TMP: c.d, TMPDIR: c.d, PATH: [inWork, '', inTemp, nodeDir].join(delimiter) };
  const r = spawnSync(process.execPath, [join(c.plugin, 'hooks', 'codex-hook.cjs'), join(c.plugin, 'hooks', 'probe.mjs'), '--codex', '--plugin'], { cwd: c.work, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran --codex --plugin');
  assert.equal(readFileSync(`${c.marker}.cwd`, 'utf8').toLowerCase(), realpathSync.native(c.plugin).toLowerCase());
  assert.deepEqual(readFileSync(`${c.marker}.path`, 'utf8').split(delimiter), [nodeDir]);
  // A session in the home folder itself keeps the home's entries (nvm-windows and Volta keep node under it).
  const { cleanPath, unsafeDirs } = require('../hooks/codex-hook.cjs');
  const home = realpathSync.native(c.work);
  assert.deepEqual(cleanPath([inWork, nodeDir].join(delimiter), unsafeDirs({ TEMP: inTemp, TMP: inTemp, USERPROFILE: home }, c.work, inTemp)), [inWork, nodeDir].join(delimiter));
  assert.deepEqual(cleanPath([inWork, nodeDir].join(delimiter), unsafeDirs({ TEMP: inTemp, TMP: inTemp, USERPROFILE: c.d }, c.work, inTemp)), nodeDir);
});

// PowerShell starts node in the plugin folder and names the session folder in BANKER_HOOK_SESSION. codex-hook.cjs judges
// the hook script by its real path against it, and a hook that cannot load says why; both exit 0.
test('codex-hook.cjs takes the session folder from BANKER_HOOK_SESSION, refuses a script there, and a hook that cannot load says why', () => {
  const c = setup();
  const hook = join(c.plugin, 'hooks', 'codex-hook.cjs');
  const env = { ...process.env, BANKER_HOOK_SESSION: c.work, TEMP: join(c.d, 't1'), TMP: join(c.d, 't1'), TMPDIR: join(c.d, 't1'), USERPROFILE: join(c.d, 'home') };
  const run = (args) => spawnSync(process.execPath, [hook, ...args], { cwd: c.plugin, encoding: 'utf8', env });
  writeFileSync(join(c.plugin, 'hooks', 'env.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(c.marker)}, String(process.env.BANKER_HOOK_SESSION));\n`);
  let r = run([join(c.plugin, 'hooks', 'env.mjs')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(c.marker, 'utf8'), 'undefined', 'the hook does not see BANKER_HOOK_SESSION');
  rmSync(c.marker);
  writeFileSync(join(c.work, 'probe.mjs'), readFileSync(join(c.plugin, 'hooks', 'probe.mjs')));
  r = run(['--notice', join(c.work, 'probe.mjs')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).systemMessage, /^banker hooks skipped: the hook script is in a temp folder or the session folder/);
  assert.ok(!existsSync(c.marker));
  r = run([join(c.plugin, 'hooks', 'missing.mjs')]);
  assert.deepEqual([r.status, r.stdout], [0, '']);
  assert.match(r.stderr, /^banker hooks skipped: cannot run missing\.mjs \(ERR_MODULE_NOT_FOUND\)/);
});

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
    assert.ok(h.commandWindows.startsWith(`$null='banker-hooks-rev ${rev}';`), h.commandWindows.slice(0, 60));
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
  // A PATH with no node on it (Rocky has /usr/bin/node, so not /usr/bin); the command needs no other program to run.
  const env = { PATH: join(c.d, 'empty'), PLUGIN_ROOT: c.plugin, TMPDIR: '/nonexistent', HOME: c.d };
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
  r = spawnSync('/bin/sh', ['-c', shCommand('probe.mjs', [], true, true, '', [join(c.d, 'none')])], { cwd: c.work, encoding: 'utf8', env: { ...env, PATH: `${venv}${delimiter}${join(c.d, 'empty')}` } });
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

// The PowerShell the commands run in: Windows PowerShell 5.1, or another (pwsh 7) named by BANKER_TEST_PS. Codex runs
// a hook's commandWindows with the PowerShell it finds, so the box suite runs these once more under pwsh 7.
const PS = process.env.BANKER_TEST_PS || 'powershell.exe';
function ps(c, cmd, path) {
  const env = { ...process.env, PATH: path, PLUGIN_ROOT: c.plugin };
  return spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', cmd], { cwd: c.work, encoding: 'utf8', env });
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
  // A PATH entry an installer wrote in quotes, or with %VAR% in it, is read as the folder it names.
  r = ps(c, psCommand('probe.mjs', [], true), `"${nodeDir}"${delimiter}${sysPath()}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran ', 'a quoted entry');
  rmSync(c.marker);
  r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', psCommand('probe.mjs', [], true)], { cwd: c.work, encoding: 'utf8', env: { ...process.env, PLUGIN_ROOT: c.plugin, BANKER_NODE_DIR: nodeDir, PATH: `%BANKER_NODE_DIR%${delimiter}${sysPath()}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran ', 'an entry with %VAR%');
  rmSync(c.marker);
  // At session start a refusal is a systemMessage the TUI shows.
  r = ps(c, psCommand('probe.mjs', [], true, true), sysPath());
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout.trim()).systemMessage, /^banker hooks skipped: node is not on PATH/);
  const env = { ...process.env, PATH: `${nodeDir}${delimiter}${sysPath()}` };
  delete env.PLUGIN_ROOT;
  r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', psCommand('probe.mjs', [], true, true)], { cwd: c.work, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim()).systemMessage, 'banker hooks skipped: PLUGIN_ROOT is not set');
});

// The temp folders a Windows test may use are moved aside, so a folder under the real TEMP stands for a safe place.
const asideEnv = (c, extra) => ({ ...process.env, PLUGIN_ROOT: c.plugin, TEMP: join(c.d, 't1'), TMP: join(c.d, 't2'), LOCALAPPDATA: join(c.d, 'la'), ...extra });
const psRun = (c, cmd, env) => spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', cmd], { cwd: c.work, encoding: 'utf8', env });

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
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', psCommand('probe.mjs', [], true)], {
    cwd: join(c.d, 'jn', 'proj'), encoding: 'utf8', env: asideEnv(c, { PATH: `${join(proj, 'bin')}${delimiter}${sysPath()}` }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /banker hooks skipped: node is in a temp folder or the session folder/);
  assert.ok(!existsSync(c.marker));
});

// A session opened on a subst drive is the folder the drive stands for.
test('PowerShell: a session folder opened on a subst drive still refuses a node.exe inside it', windows, (t) => {
  const c = setup();
  const real = join(c.d, 'real');
  const proj = join(real, 'proj');
  mkdirSync(join(proj, 'bin'), { recursive: true });
  copyFileSync(process.execPath, join(proj, 'bin', 'node.exe'));
  const letter = 'ZYXWVUTSRQ'.split('').find((l) => !existsSync(`${l}:\\`));
  if (!letter) { t.skip('no free drive letter'); return; }
  const subst = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'subst.exe');
  assert.equal(spawnSync(subst, [`${letter}:`, real]).status, 0);
  try {
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', psCommand('probe.mjs', [], true)], {
      cwd: `${letter}:\\proj`, encoding: 'utf8', env: asideEnv(c, { PATH: `${join(proj, 'bin')}${delimiter}${sysPath()}` }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /banker hooks skipped: node is in a temp folder or the session folder/);
    assert.ok(!existsSync(c.marker));
  } finally {
    spawnSync(subst, [`${letter}:`, '/d']);
  }
});

// A TEMP in 8.3 form (C:\Users\LONGNA~1\...) names the same folder as the long path a node.exe is found under.
// A link or junction whose target is written with an 8.3 name: the target is judged in its long form too, so a node.exe
// in the session folder or under TEMP reached that way is still refused.
test('PowerShell: a PATH entry that is a junction to an 8.3 name in the session folder or TEMP still refuses the node.exe there', windows, (t) => {
  const c = setup();
  const session = join(c.d, 'a long session folder');
  const temp = join(c.d, 'a long temp folder');
  for (const dir of [session, temp]) mkdirSync(join(dir, 'evil'), { recursive: true });
  const shortOf = (p) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${p.replace(/'/g, "''")}').ShortPath`], { encoding: 'utf8' }).stdout.trim();
  const short = { session: shortOf(session), temp: shortOf(temp) };
  if (!short.session || short.session.toLowerCase() === session.toLowerCase()) {
    t.skip('this volume makes no 8.3 names');
    return;
  }
  for (const [dir, target] of [[session, short.session], [temp, short.temp]]) {
    copyFileSync(process.execPath, join(dir, 'evil', 'node.exe'));
    const link = join(c.d, `jn-${dir === session ? 's' : 't'}`);
    symlinkSync(join(target, 'evil'), link, 'junction');
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', psCommand('probe.mjs', [], true)], {
      cwd: session, encoding: 'utf8', env: asideEnv(c, { TEMP: temp, TMP: temp, PATH: `${link}${delimiter}${nodeDir}${delimiter}${sysPath()}` }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /banker hooks skipped: node is in a temp folder or the session folder/, `${dir}: ${r.stderr}`);
    assert.ok(!existsSync(c.marker), `${dir}: nothing ran`);
  }
});

// At session start a refusal of node is a systemMessage on stdout (k's refusal inside an assignment once lost it).
test('PowerShell: at session start a node under TEMP is refused with a systemMessage', windows, () => {
  const c = setup();
  const dir = join(c.d, 'bin');
  mkdirSync(dir);
  copyFileSync(process.execPath, join(dir, 'node.exe'));
  const r = ps(c, psCommand('probe.mjs', [], true, true), `${dir}${delimiter}${nodeDir}${delimiter}${sysPath()}`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout.trim()).systemMessage, /^banker hooks skipped: node is in a temp folder or the session folder/);
  assert.ok(!existsSync(c.marker));
});

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
  const run = (cwd, b = bin) => spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', psCommand('probe.mjs', [], true)], {
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

// A copy of a setup() plugin folder at dir (probe.mjs and run.cjs).
function pluginAt(c, dir) {
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  for (const f of ['probe.mjs', 'run.cjs', 'codex-hook.cjs']) copyFileSync(join(c.plugin, 'hooks', f), join(dir, 'hooks', f));
  return dir;
}
const shells = () => ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/dash'].filter((f) => existsSync(f));

// A PATH entry under a network mount outside the home folder may not answer: the command neither looks for node there
// nor keeps it. An entry under the home folder is checked as before, even on a network mount.
test('sh: PATH entries under a network mount outside the home folder are left out; under the home folder they are kept', homeCase, (t) => {
  const c = setup();
  const o = outside(t);
  const home = join(o.d, 'home');
  const net = join(o.d, 'net');
  const spaced = join(o.d, 'net 2');
  const homeNet = join(home, 'nfs');
  for (const dir of [join(net, 'bin'), join(spaced, 'bin')]) fakeNode(c, dir);
  mkdirSync(join(homeNet, 'bin'), { recursive: true });
  const table = join(c.d, 'mounts');
  writeFileSync(table, [
    `srv:/x ${net} nfs4 rw 0 0`,
    `//srv/y ${spaced.replace(/ /g, '\\040')} cifs rw 0 0`,
    `srv:/h ${homeNet} nfs rw 0 0`,
    `/dev/sda1 ${o.d} ext4 rw 0 0`,
  ].join('\n'));
  const path = [join(net, 'bin'), join(spaced, 'bin'), join(homeNet, 'bin'), dirname(o.node), '/usr/bin', '/bin'].join(delimiter);
  for (const sh of shells()) {
    const cmd = shCommand('probe.mjs', [], true, false, '', [join(c.d, 'none')], { table, command: '/nonexistent' });
    const r = spawnSync(sh, ['-c', cmd], { cwd: c.work, encoding: 'utf8', env: { PATH: path, PLUGIN_ROOT: c.plugin, TMPDIR: '/tmp', HOME: home } });
    assert.equal(r.status, 0, `${sh}: ${r.stderr}`);
    assert.equal(readFileSync(c.marker, 'utf8'), 'ran ', `${sh}: the node outside the network mounts ran`);
    const kept = readFileSync(`${c.marker}.path`, 'utf8').split(delimiter);
    assert.ok(!kept.includes(join(net, 'bin')) && !kept.includes(join(spaced, 'bin')), `${sh}: ${kept.join(delimiter)}`);
    assert.ok(kept.includes(join(homeNet, 'bin')), `${sh}: an entry under the home folder is kept after its check`);
    rmSync(c.marker);
  }
  // With node only on the network mount, the command says node is not on PATH rather than reading the mount.
  const r = sh(c, shCommand('probe.mjs', [], true, false, '', [join(c.d, 'none')], { table, command: '/nonexistent' }), join(net, 'bin'));
  assert.match(r.stderr, /^banker hooks skipped: node is not on PATH/);
  assert.ok(!existsSync(c.marker));
});

// macOS has no /proc: the command reads /sbin/mount's `<device> on <mount point> (<type>, ...)` lines.
test('sh: on a system without /proc/self/mounts, the mount command\'s lines name the network mounts', homeCase, (t) => {
  const c = setup();
  const o = outside(t);
  const net = join(o.d, 'Volumes', 'My share');
  fakeNode(c, join(net, 'bin'));
  const mount = join(o.d, 'mount');
  writeFileSync(mount, `#!/bin/sh\nprintf '%s\\n' '/dev/disk1s1 on / (apfs, local, journaled)' '//u@srv/share on ${net} (smbfs, nodev, nosuid, mounted by u)' 'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)'\n`);
  chmodSync(mount, 0o755);
  const cmd = shCommand('probe.mjs', [], true, false, '', [join(c.d, 'none')], { table: join(c.d, 'no-such-table'), command: mount });
  const r = spawnSync('/bin/sh', ['-c', cmd], { cwd: c.work, encoding: 'utf8', env: { PATH: [join(net, 'bin'), dirname(o.node), '/usr/bin', '/bin'].join(delimiter), PLUGIN_ROOT: c.plugin, TMPDIR: '/tmp', HOME: c.d } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran ');
  assert.ok(!readFileSync(`${c.marker}.path`, 'utf8').split(delimiter).includes(join(net, 'bin')));
});

// The hook scripts the command runs sit in the plugin folder. One the sandbox can write (a Codex home deep in the
// session folder, or the temp folder) runs nothing, as a node there would not; a session in the home folder itself is
// no workspace here either.
test('sh: a plugin folder in the session folder (however deep, or through a link) or a temp folder runs nothing', homeCase, (t) => {
  const c = setup();
  const o = outside(t);
  const work = join(o.d, 'work');
  const deep = pluginAt(c, join(work, 'deep', 'codexhome', 'plugins', 'cache', 'm', 'banker', '1.0'));
  const link = join(o.d, 'link');
  symlinkSync(deep, link);
  // 진짜 /tmp 아래(명령이 늘 검사하는 곳). macOS 의 os.tmpdir() 은 /var/folders 라 TMPDIR=/tmp 로 부르면 임시 폴더가 아니다
  const tmpRoot = mkdtempSync('/tmp/codex-plugin-tmp-');
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));
  const inTmp = pluginAt(c, join(tmpRoot, 'tmp-plugin'));
  const run = (cwd, root, home = o.d) => spawnSync('/bin/sh', ['-c', shCommand('probe.mjs', [], true, true)], { cwd, encoding: 'utf8', env: { PATH: `${dirname(o.node)}${delimiter}/usr/bin${delimiter}/bin`, PLUGIN_ROOT: root, TMPDIR: '/tmp', HOME: home } });
  for (const root of [deep, link, inTmp]) {
    const r = run(work, root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout.trim()).systemMessage, /^banker hooks skipped: the plugin folder is in a temp folder or the session folder \(/, root);
    assert.ok(!existsSync(c.marker), `${root}: nothing ran`);
  }
  let r = run(o.d, c.plugin);
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran ', `the setup plugin folder runs: ${r.stdout}${r.stderr}`);
  rmSync(c.marker);
  r = run(work, deep, work);
  assert.equal(readFileSync(c.marker, 'utf8'), 'ran ', `a session in the home folder itself: ${r.stdout}${r.stderr}`);
  assert.equal(readFileSync(`${c.marker}.cwd`, 'utf8'), realpathSync(deep), 'run from the real path of the plugin folder');
});

test('PowerShell: a plugin folder in the session folder or under TEMP runs nothing', windows, () => {
  const c = setup();
  const deep = pluginAt(c, join(c.work, 'deep', 'codexhome', 'plugins', 'cache', 'm', 'banker', '1.0'));
  let r = psRun(c, psCommand('probe.mjs', [], true, true), asideEnv(c, { PLUGIN_ROOT: deep, PATH: `${nodeDir}${delimiter}${sysPath()}` }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout.trim()).systemMessage, /^banker hooks skipped: the plugin folder is in a temp folder or the session folder/);
  assert.ok(!existsSync(c.marker));
  const inTemp = pluginAt(c, join(c.d, 'tmp-plugin'));
  r = ps({ ...c, plugin: inTemp }, psCommand('probe.mjs', [], true), `${nodeDir}${delimiter}${sysPath()}`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /banker hooks skipped: the plugin folder is in a temp folder or the session folder/);
  assert.ok(!existsSync(c.marker));
});

// The skills list (plan 22.3): Codex reads only the folders the list names, so the list is what Codex shows.
const { renamedCopies, skillList, staleOf, targets, BUNDLE_DIRS, RENAMED_DIR } = require('./sync-codex-plugin.js');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'codex', 'manifest.json'), 'utf8'));
const frontmatter = (text) => (/^---\r?\n([\s\S]*?)\r?\n---/.exec(text) || [, ''])[1];

test('the skills list names every shared skill once, a renamed copy for the six Codex names or describes apart, no claude-only skill', () => {
  const list = skillList();
  assert.deepEqual(JSON.parse(readFileSync(join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8')).skills, list);
  assert.deepEqual(list.slice(-2), BUNDLE_DIRS);
  const shared = MANIFEST.surfaces.filter((s) => s.type === 'skill' && s.target === 'both');
  assert.equal(list.length, shared.length + 2);
  for (const s of shared) {
    const want = s.codexName || s.codexDescription ? `./${RENAMED_DIR}/${s.codexName || s.name}/` : `./skills/${s.name}/`;
    assert.ok(list.includes(want), want);
  }
  assert.deepEqual(MANIFEST.surfaces.filter((s) => s.codexName || s.codexDescription).map((s) => s.name).sort(),
    ['append_wiki', 'compact-wiki', 'omc-reference', 'setup', 'setup-omc', 'setup-omc-hud', 'setup-tmux']);
  for (const s of MANIFEST.surfaces.filter((x) => x.target === 'claude-only')) assert.ok(!list.some((p) => p.includes(`/${s.name}/`)), s.name);
  assert.ok(!list.some((p) => p.includes('/ultraqa/')));
});

test('a renamed copy is its source with only the frontmatter name and description changed, and no tests', () => {
  const copies = renamedCopies();
  for (const s of MANIFEST.surfaces.filter((x) => x.type === 'skill' && (x.codexName || x.codexDescription))) {
    const dir = `${RENAMED_DIR}/${s.codexName || s.name}/`;
    const mine = copies.filter((c) => c.rel.startsWith(dir));
    assert.ok(mine.length, dir);
    for (const c of mine) {
      assert.doesNotMatch(c.rel, /\.test\.(?:mjs|ts)$|__pycache__|\/test_[^/]*\.py$/);
      const src = readFileSync(join(ROOT, 'skills', s.name, ...c.rel.slice(dir.length).split('/')));
      if (!c.rel.endsWith('/SKILL.md')) { assert.ok(src.equals(c.data), c.rel); continue; }
      const fm = frontmatter(c.data);
      assert.match(fm, new RegExp(`^name: ${s.codexName || s.name}$`, 'm'));
      const desc = /^description: (.*)$/m.exec(fm)[1];
      assert.equal(JSON.parse(desc), s.codexDescription, 'the description reads back as the double-quoted string it was written as');
      const strip = (t) => String(t).split('\n').filter((l) => !/^(?:name|description):/.test(l)).join('\n');
      assert.equal(strip(c.data), strip(src), `${c.rel}: nothing but the two lines changed`);
    }
  }
  assert.deepEqual(staleOf(targets()), [], 'nothing stale under codex/renamed-skills or codex/command-skills');
});

test('no test file sits in codex/renamed-skills, so a run of every *.test.mjs never runs a copy twice', () => {
  const found = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(ROOT, ...rel.split('/')), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else if (/\.test\.(?:mjs|ts)$/.test(e.name)) found.push(`${rel}/${e.name}`);
    }
  };
  walk(RENAMED_DIR);
  assert.deepEqual(found, []);
});

// Plan 22.7: what Codex shows from the plugin (each listed skill's frontmatter in full) says OMX, not OMC. omc-patch and
// payload-mon keep their names: their description opens with the line that they act on Claude Code's OMC.
test('the Codex plugin frontmatter has no OMC but the two kept skills, which say they handle Claude Code\'s OMC', () => {
  const files = [];
  for (const entry of skillList()) {
    const dir = join(ROOT, entry);
    if (existsSync(join(dir, 'SKILL.md'))) files.push(join(dir, 'SKILL.md'));
    else for (const d of readdirSync(dir)) if (existsSync(join(dir, d, 'SKILL.md'))) files.push(join(dir, d, 'SKILL.md'));
  }
  assert.equal(files.length, MANIFEST.surfaces.filter((s) => s.target !== 'claude-only').length);
  for (const f of files) {
    const fm = frontmatter(readFileSync(f, 'utf8'));
    const name = /^name: (.*)$/m.exec(fm)[1];
    if (name === 'omc-patch' || name === 'payload-mon') assert.match(fm, /^description: "Claude Code 의 OMC 를 다룸\(Codex 에서 실행해도 같음\)\. /m, f);
    else assert.doesNotMatch(fm, /omc/i, f);
  }
});

// Plan S11 B7: a sentence that says what a renamed skill installs is written for Codex as a whole. A name swap alone
// made the Codex front-qa and setup send the OMX install skill to install OMC.
test('the command skills say the Codex install skill installs OMX, and every Codex phrase still occurs in a command', () => {
  const { CODEX_PHRASES } = require('../bin/lib/command-skill.cjs');
  const commands = readdirSync(join(ROOT, 'commands')).map((f) => readFileSync(join(ROOT, 'commands', f), 'utf8')).join('\n');
  for (const [from] of CODEX_PHRASES) assert.ok(commands.includes(from), `no command says: ${from}`);
  for (const name of ['front-qa', 'setup']) {
    const text = readFileSync(join(ROOT, 'codex', 'command-skills', name, 'SKILL.md'), 'utf8');
    for (const line of text.split('\n').filter((l) => /setup-omx/.test(l))) {
      assert.doesNotMatch(line, /oh-my-claudecode|oh-my-claude-sisyphus|omc_hud 상태표시줄\(/, `${name}: ${line}`);
    }
    for (const [from] of CODEX_PHRASES) assert.ok(!text.includes(from), `${name} still says: ${from}`);
  }
});
