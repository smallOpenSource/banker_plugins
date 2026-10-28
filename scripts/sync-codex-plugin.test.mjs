// Tests for sync-codex-plugin.js: the Codex plugin's hook commands run the node PATH names only from a safe place.
// Run from the repo root: node --test scripts/sync-codex-plugin.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const { hooksText, psCommand, shCommand, HOOKS_FILE } = require('./sync-codex-plugin.js');
const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

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

test('sh: no PLUGIN_ROOT or no node runs nothing and exits 0', posix, () => {
  const c = setup();
  const cmd = shCommand('probe.mjs', [], true);
  let r = spawnSync('/bin/sh', ['-c', cmd], { cwd: c.work, encoding: 'utf8', env: { PATH: `${nodeDir}${delimiter}/usr/bin${delimiter}/bin` } });
  assert.equal(r.status, 0);
  r = sh(c, cmd, join(c.d, 'empty'));
  assert.equal(r.status, 0);
  assert.ok(!existsSync(c.marker));
  r = spawnSync('/bin/sh', ['-c', cmd], { cwd: '/', encoding: 'utf8', env: { PATH: `${nodeDir}${delimiter}/usr/bin${delimiter}/bin`, PLUGIN_ROOT: c.plugin } });
  assert.equal(r.status, 0);
  assert.ok(!existsSync(c.marker), 'a session folder of / runs nothing');
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
  // A real node.exe copied under TEMP or into the session folder, and a .cmd shim, run nothing.
  for (const [dir, file] of [[join(c.d, 'bin'), 'node.exe'], [join(c.work, 'bin'), 'node.exe'], [join(c.d, 'cmd'), 'node.cmd']]) {
    mkdirSync(dir, { recursive: true });
    if (file === 'node.exe') copyFileSync(process.execPath, join(dir, file));
    else writeFileSync(join(dir, file), `@echo evil> "${c.marker}"\r\n`);
    r = ps(c, psCommand('probe.mjs', [], true), `${dir}${delimiter}${nodeDir}${delimiter}${sysPath()}`);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(c.marker), `${dir}\\${file}: nothing ran`);
  }
});

// A session opened in the home folder: a node kept under home (nvm) still runs the hook; a project under home is still
// a session folder. The base must sit outside the temp folders the commands refuse, so the home rule alone decides:
// /var/tmp on Linux, and on macOS the per-user TMPDIR while the command is told TMPDIR=/tmp.
const homeBase = process.platform === 'darwin' ? tmpdir() : '/var/tmp';
const homeCase = { skip: process.platform === 'win32' ? 'sh commands' : !existsSync(homeBase) && `no ${homeBase}` };
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
