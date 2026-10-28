// Tests for codex-routes.mjs. Run from the repo root: node --test bin/lib/codex-routes.test.mjs
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

import { codexHomeOf, dualInstallNote, npmRoute, pluginRootInfo, pluginRoutes } from './codex-routes.mjs';

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
});
