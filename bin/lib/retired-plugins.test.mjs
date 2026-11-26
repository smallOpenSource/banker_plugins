// Tests for retired-plugins.mjs. Run from the repo root: node --test bin/lib/retired-plugins.test.mjs
// The Claude config folder is a temp one (CLAUDE_CONFIG_DIR in the env given), never ~/.claude.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { claudeConfigDir, commandText, RETIRED, retiredInstalls, retiredNote, retiredNoticeOnce, uninstallStep } from './retired-plugins.mjs';

const root = mkdtempSync(join(tmpdir(), 'retired-plugins-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function claudeDir(plugins) {
  const d = join(root, `c${n++}`);
  mkdirSync(join(d, 'plugins'), { recursive: true });
  if (plugins !== undefined) writeFileSync(join(d, 'plugins', 'installed_plugins.json'), typeof plugins === 'string' ? plugins : JSON.stringify({ version: 2, plugins }));
  return d;
}
const ID = 'humanize-korean@im-not-ai';

test('the retired plugin is humanize-korean@im-not-ai with its three skills', () => {
  assert.deepEqual(RETIRED.map((r) => [r.id, r.skills]), [[ID, ['humanize', 'humanize-redo', 'humanize-scan']]]);
});

test('CLAUDE_CONFIG_DIR is the Claude config folder when set', () => {
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: join(root, 'x') }), join(root, 'x'));
  assert.match(claudeConfigDir({}), /\.claude$/);
});

test('installs of the retired plugin by scope; other plugins, no file, a broken file and a folder in its place are none', () => {
  const d = claudeDir({ [ID]: [{ scope: 'user', installPath: '/a' }, { scope: 'local', projectPath: '/p', installPath: '/b' }], 'banker@banker-plugins': [{ scope: 'user' }] });
  assert.deepEqual(retiredInstalls({ CLAUDE_CONFIG_DIR: d }), [{ id: ID, scope: 'user', projectPath: '' }, { id: ID, scope: 'local', projectPath: '/p' }]);
  assert.deepEqual(retiredInstalls({ CLAUDE_CONFIG_DIR: claudeDir() }), []);
  assert.deepEqual(retiredInstalls({ CLAUDE_CONFIG_DIR: claudeDir('{ not json') }), []);
  assert.deepEqual(retiredInstalls({ CLAUDE_CONFIG_DIR: claudeDir({ 'banker@banker-plugins': [{ scope: 'user' }] }) }), []);
  const dirInPlace = claudeDir();
  mkdirSync(join(dirInPlace, 'plugins', 'installed_plugins.json'));
  assert.deepEqual(retiredInstalls({ CLAUDE_CONFIG_DIR: dirInPlace }), []);
});

test('user and local (its folder there) are uninstalled; project and a missing local folder are left with their command', () => {
  const home = join(root, 'home');
  const proj = join(root, 'proj');
  mkdirSync(proj, { recursive: true });
  const user = uninstallStep({ id: ID, scope: 'user', projectPath: '' }, home);
  assert.deepEqual(user, { args: ['plugin', 'uninstall', ID, '--scope', 'user'], cwd: home, run: true, why: '' });
  assert.equal(commandText(user), `claude plugin uninstall ${ID} --scope user`);
  const local = uninstallStep({ id: ID, scope: 'local', projectPath: proj }, home);
  assert.deepEqual([local.run, local.cwd], [true, proj]);
  assert.equal(commandText(local), `${proj} 에서 claude plugin uninstall ${ID} --scope local`);
  const gone = uninstallStep({ id: ID, scope: 'local', projectPath: join(root, 'gone') }, home);
  assert.deepEqual([gone.run, gone.why], [false, 'its project folder is not there']);
  const shared = uninstallStep({ id: ID, scope: 'project', projectPath: proj }, home);
  assert.deepEqual([shared.run, shared.why], [false, 'the project shares it in .claude/settings.json']);
  assert.equal(uninstallStep({ id: ID, scope: 'managed', projectPath: '' }, home).run, false);
});

test('the notice names the plugin, its skills, the uninstall command and humanizer; nothing installed is no notice', () => {
  const note = retiredNote([{ id: ID, scope: 'user', projectPath: '' }]);
  assert.match(note, /^banker: 설치된 humanize-korean@im-not-ai 의 humanize, humanize-redo, humanize-scan 은 효과가 없어/);
  assert.match(note, /claude plugin uninstall humanize-korean@im-not-ai --scope user 를 실행하십시오/);
  assert.match(note, /마켓플레이스 등록은 그대로 둡니다\). 윤문은 \/banker:humanizer$/);
  assert.doesNotMatch(note, /[—–→!]/);
  assert.equal(retiredNote([]), '');
});

test('the hook notice comes once per plugin id, and again only for an id not told before', () => {
  const env = { CLAUDE_CONFIG_DIR: claudeDir({ [ID]: [{ scope: 'user' }] }) };
  const file = join(root, `told-${n++}`, 'retired-notified.json');
  assert.match(retiredNoticeOnce(env, file), /humanize-korean@im-not-ai/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [ID]);
  assert.equal(retiredNoticeOnce(env, file), '', 'told before');
  writeFileSync(file, '"not an array"');
  assert.match(retiredNoticeOnce(env, file), /humanize-korean/, 'a broken record tells again');
  assert.equal(retiredNoticeOnce({ CLAUDE_CONFIG_DIR: claudeDir() }, join(root, 'none.json')), '', 'not installed: nothing');
});

test('a record that cannot be written still gives the notice (told again next session rather than never)', () => {
  const env = { CLAUDE_CONFIG_DIR: claudeDir({ [ID]: [{ scope: 'user' }] }) };
  const blocker = join(root, `blocker-${n++}`);
  writeFileSync(blocker, '');
  assert.match(retiredNoticeOnce(env, join(blocker, 'retired-notified.json')), /humanize-korean/);
});
