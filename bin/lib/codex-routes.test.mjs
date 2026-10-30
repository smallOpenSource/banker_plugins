// Tests for codex-routes.mjs. Run from the repo root: node --test bin/lib/codex-routes.test.mjs
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

import { codexCliVersion, codexHomeOf, dualInstallNote, hookPlaces, npmRoute, pluginRootInfo, pluginRoutes, projectNpmRoot, realPath, writableRoots, writableRootsNote } from './codex-routes.mjs';

const root = mkdtempSync(join(tmpdir(), 'codex-routes-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const home = () => {
  const d = join(root, `h${n++}`);
  mkdirSync(d);
  return d;
};
const npmSkill = (h, name) => {
  mkdirSync(join(h, 'skills', `banker-${name}`), { recursive: true });
  writeFileSync(join(h, 'skills', `banker-${name}`, 'SKILL.md'), '');
};
const config = (h, text) => writeFileSync(join(h, 'config.toml'), text);

test('the plugin folder Codex gives hooks names its home and marketplace', () => {
  const h = home();
  const ver = join(h, 'plugins', 'cache', 'banker-plugins', 'banker', '0.22.0');
  assert.deepEqual(pluginRootInfo(ver), { home: h, marketplace: 'banker-plugins' });
  assert.deepEqual(pluginRootInfo(`${ver}/`), { home: h, marketplace: 'banker-plugins' });
  for (const bad of ['', undefined, 'rel/plugins/cache/m/banker/1', join(h, 'plugins', 'cache', 'm', 'other', '1'), join(h, 'plugins', 'x', 'm', 'banker', '1'), join(h, 'stuff', 'cache', 'm', 'banker', '1')]) {
    assert.equal(pluginRootInfo(bad), null, String(bad));
  }
});

test('the Codex home comes from the rollout first, then the plugin folder, then CODEX_HOME', () => {
  const h = home();
  const f = join(h, 'sessions', '2026', '10', '28', 'rollout-x.jsonl');
  const plugin = join(h, 'plugins', 'cache', 'banker-plugins', 'banker', '0.22.0');
  assert.equal(codexHomeOf(f, { PLUGIN_ROOT: '/elsewhere', CODEX_HOME: '/c' }), h);
  assert.equal(codexHomeOf('', { PLUGIN_ROOT: plugin, CODEX_HOME: '/c' }), h);
  assert.equal(codexHomeOf(undefined, { CODEX_HOME: '/c' }), '/c');
});

test('the npm route is a banker-* skill with a SKILL.md, nothing else', () => {
  const h = home();
  assert.equal(npmRoute(h), false, 'no skills folder');
  mkdirSync(join(h, 'skills', 'banker-empty'), { recursive: true });
  mkdirSync(join(h, 'skills', 'hud'), { recursive: true });
  writeFileSync(join(h, 'skills', 'hud', 'SKILL.md'), '');
  assert.equal(npmRoute(h), false, 'a banker-* folder without SKILL.md, and an OMX skill');
  npmSkill(h, 'lineage');
  assert.equal(npmRoute(h), true);
});

test('plugin routes are the banker@<marketplace> tables of config.toml that are not turned off', () => {
  const h = home();
  assert.deepEqual(pluginRoutes(h), [], 'no config.toml');
  config(h, [
    'model = "x"',
    '[plugins."banker@banker-plugins"]',
    'enabled = true',
    '',
    "[plugins.'banker@mirror'] # a mirror",
    'enabled = false',
    '[plugins."bankers@x"]',
    '[plugins."superpowers@openai-curated"]',
    'enabled = true',
    '[ plugins . "banker@local" ]',
    '',
  ].join('\r\n'));
  assert.deepEqual(pluginRoutes(h), ['banker@banker-plugins', 'banker@local']);
});

test('a config.toml that is a pipe is not waited on', { skip: process.platform === 'win32' && 'POSIX pipes' }, () => {
  const h = home();
  spawnSync('mkfifo', [join(h, 'config.toml')]);
  assert.deepEqual(pluginRoutes(h), []);
});

test('the dual install note names both ways out only when both routes are there', () => {
  const h = home();
  npmSkill(h, 'lineage');
  assert.equal(dualInstallNote(h), '', 'npm only');
  config(h, '[plugins."banker@banker-plugins"]\nenabled = true\n');
  const note = dualInstallNote(h);
  assert.match(note, /banker uninstall --codex/);
  assert.match(note, /codex plugin remove banker@banker-plugins/);
  const p = home();
  config(p, '[plugins."banker@banker-plugins"]\nenabled = true\n');
  assert.equal(dualInstallNote(p), '', 'plugin only');
  const work = home();
  npmSkill(join(work, '.codex'), 'lineage');
  assert.match(dualInstallNote(p, work), /두 번 설치됨/, 'a project-scope npm install in the session folder');
  assert.equal(dualInstallNote(p, 'rel'), '', 'a relative cwd is not looked at');
  // From a subfolder of a repository whose top holds the project-scope install.
  const repo = home();
  mkdirSync(join(repo, '.git'));
  npmSkill(join(repo, '.codex'), 'lineage');
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
  assert.equal(projectNpmRoot(join(repo, 'src', 'deep')), repo);
  assert.match(dualInstallNote(p, join(repo, 'src', 'deep')), /두 번 설치됨/);
  // Outside a repository only the folder itself counts: a parent's install is not looked at.
  const loose = home();
  npmSkill(join(loose, '.codex'), 'lineage');
  mkdirSync(join(loose, 'sub'));
  assert.equal(projectNpmRoot(join(loose, 'sub')), '');
});

// codex --version is started by bare name (codex.cmd through cmd on Windows): from the home folder, with the search of
// the current folder off, so a codex.cmd planted in the session folder (a hook's current folder) never runs.
test('codex --version runs from the home folder with NoDefaultCurrentDirectoryInExePath set', () => {
  let seen = null;
  assert.equal(codexCliVersion((_c, _a, o) => { seen = o; return { stdout: 'codex-cli 0.165.0\n' }; }), '0.165.0');
  assert.equal(seen.cwd, homedir());
  assert.equal(seen.env.NoDefaultCurrentDirectoryInExePath, '1');
});

test('a codex.cmd in the current folder or the home folder is not what codex --version runs', { skip: process.platform !== 'win32' && 'cmd.exe and .cmd files' }, (t) => {
  const d = home();
  const fake = join(d, 'fakehome');
  mkdirSync(fake);
  const plant = (dir) => writeFileSync(join(dir, 'codex.cmd'), '@echo codex-cli 9.9.9\r\n');
  plant(d);
  plant(fake);
  const saved = { cwd: process.cwd(), USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH };
  t.after(() => { process.chdir(saved.cwd); process.env.USERPROFILE = saved.USERPROFILE; process.env.PATH = saved.PATH; });
  process.chdir(d);
  process.env.USERPROFILE = fake;
  process.env.PATH = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  assert.equal(homedir(), fake);
  assert.equal(codexCliVersion(spawnSync), '', 'neither planted codex.cmd ran');
});

// Plan B9 (S11): the hooks check config.toml's writable_roots as the teamwork engine reads them.
test('writable_roots are read from the table and the dotted key, relative to the Codex home, ~ as the home folder', () => {
  const h = home();
  assert.deepEqual(writableRoots(h), [], 'no config.toml');
  mkdirSync(join(h, 'w1'));
  writeFileSync(join(h, 'config.toml'), '[sandbox_workspace_write]\nwritable_roots = [\n  "w1",\n  \'~\',\n]\n[other]\nwritable_roots = ["no"]\n');
  assert.deepEqual(writableRoots(h), [realPath(join(h, 'w1')), realPath(homedir())]);
  writeFileSync(join(h, 'config.toml'), 'sandbox_workspace_write.writable_roots = ["w1"]\n');
  assert.deepEqual(writableRoots(h), [realPath(join(h, 'w1'))]);
});

test('a hook place under a writable root is named, but not under that root\'s top .codex, and nothing without the setting', () => {
  const h = home();
  const root = join(h, 'shared');
  const plugin = join(root, 'deep', 'codexhome', 'plugins', 'cache', 'banker-plugins', 'banker', '0.23.0');
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  const script = join(plugin, 'hooks', 'update-notify.mjs');
  writeFileSync(script, '');
  const places = hookPlaces(pathToFileURL(script).href);
  assert.deepEqual(places.slice(0, 2), [script, plugin]);
  assert.equal(writableRootsNote(h, places), '', 'no config.toml: the hook runs as before');
  writeFileSync(join(h, 'config.toml'), `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(root)}]\n`);
  assert.match(writableRootsNote(h, places), /^banker hooks skipped: .*update-notify\.mjs is under the sandbox writable root .*shared \(config\.toml \[sandbox_workspace_write\] writable_roots\)/);
  const top = join(root, '.codex', 'plugins', 'x', 'hooks', 'a.mjs');
  mkdirSync(dirname(top), { recursive: true });
  writeFileSync(top, '');
  assert.equal(writableRootsNote(h, [top]), '', 'the top .codex of a writable root stays read-only in the sandbox');
  assert.equal(writableRootsNote(h, [join(h, 'elsewhere')]), '');
});

test('a hook place reached through a link is judged where it leads', { skip: process.platform === 'win32' && 'symbolic links need privileges' }, () => {
  const h = home();
  const root = join(h, 'shared');
  mkdirSync(join(root, 'plugin'), { recursive: true });
  symlinkSync(join(root, 'plugin'), join(h, 'link'));
  writeFileSync(join(h, 'config.toml'), `sandbox_workspace_write.writable_roots = [${JSON.stringify(root)}]\n`);
  assert.match(writableRootsNote(h, [join(h, 'link')]), new RegExp(`${realpathSync(join(root, 'plugin')).replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')} is under`));
});
