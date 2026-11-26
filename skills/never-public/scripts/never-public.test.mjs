// Tests for never-public.mjs and settings-json.mjs. Run: node --test skills/never-public/scripts/never-public.test.mjs
// Every case works in its own temp folders (Claude Code, Codex and banker config): the real ~/.claude, ~/.codex and
// ~/.config/banker are never read or written.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

import { symlinkSkip } from '../../../scripts/test-fixtures/can-symlink.mjs';
import { BANKER_WANT, CLAUDE_WANT, CODEX_WANT, defaults, main, parseArgs, REMAINING, RESYNC, syncedNames } from './never-public.mjs';
import { deletePath, readJson, serialize } from './settings-json.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'never-public.mjs');
const ROOT = join(HERE, '..', '..', '..');
const root = mkdtempSync(join(tmpdir(), 'never-public-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

// A fresh set of the three places. claude and codex folders exist unless told otherwise.
function place({ claude = true, codex = true } = {}) {
  const d = join(root, `p${n++}`);
  const o = { claudeDir: join(d, 'claude'), codexFile: join(d, 'codex', 'config.toml'), bankerDir: join(d, 'cfg', 'banker') };
  if (claude) mkdirSync(o.claudeDir, { recursive: true });
  if (codex) mkdirSync(dirname(o.codexFile), { recursive: true });
  return { d, o, settings: join(o.claudeDir, 'settings.json'), config: join(o.bankerDir, 'config.json') };
}
const read = (f) => readFileSync(f, 'utf8');
const json = (f) => JSON.parse(read(f));
const SETTINGS = serialize({ model: 'opus', attribution: { commit: 'Made by me' }, hooks: { Stop: [] } });
const TOML = '# my codex\nmodel = "gpt-x" # inline note\n\n[tui]\nstatus_line = [\n  "a",\n]\n\n[analytics]\n# keep this comment\nenabled = true\n';

test('on puts every value in place, off restores the files byte for byte and removes the records', () => {
  const { o, settings } = place();
  writeFileSync(settings, SETTINGS);
  writeFileSync(o.codexFile, TOML);
  const on = main(['on'], o);
  assert.equal(on.code, 0, on.message);
  const s = json(settings);
  for (const [keys, value] of CLAUDE_WANT) assert.deepEqual(keys.reduce((v, k) => v[k], s), value, keys.join('.'));
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.hooks, { Stop: [] });
  const t = read(o.codexFile);
  for (const line of ['check_for_update_on_startup = false', 'exporter = "none"', 'trace_exporter = "none"', 'metrics_exporter = "none"', '# keep this comment\nenabled = false']) assert.ok(t.includes(line), line);
  assert.ok(t.startsWith('# my codex\nmodel = "gpt-x" # inline note\n'), 'comments and other keys stay');
  const cfg = json(join(o.bankerDir, 'config.json'));
  for (const [[k], v] of BANKER_WANT) assert.equal(cfg[k], v);
  assert.equal(read(`${settings}.never-public.bak`), SETTINGS, 'the backup holds the bytes before on');
  assert.equal(read(`${o.codexFile}.never-public.bak`), TOML);
  assert.match(on.message, /attribution\.commit: "Made by me" -> ""/);
  assert.match(on.message, /재시작|다시 시작/);
  const off = main(['off'], o);
  assert.equal(off.code, 0, off.message);
  assert.equal(read(settings), SETTINGS);
  assert.equal(read(o.codexFile), TOML);
  assert.ok(!existsSync(join(o.bankerDir, 'config.json')), 'a config.json that on created is gone again');
  for (const f of [settings, o.codexFile, join(o.bankerDir, 'config.json')]) {
    assert.ok(!existsSync(`${f}.never-public.json`), f);
    assert.ok(!existsSync(`${f}.never-public.bak`), `${f}: off removes the backup too`);
  }
});

test('keys that were not there before are removed by off, with the parent object on created', () => {
  const { o, settings } = place({ codex: false });
  writeFileSync(settings, serialize({ theme: 'dark' }));
  assert.equal(main(['on'], o).code, 0);
  assert.deepEqual(json(settings).attribution, { commit: '', pr: '', sessionUrl: false });
  assert.equal(main(['off'], o).code, 0);
  assert.deepEqual(json(settings), { theme: 'dark' });
});

test('a key the user changed after on stays as it is, and off says so', () => {
  const { o, settings } = place({ codex: false });
  writeFileSync(settings, serialize({ feedbackSurveyRate: 0.5 }));
  main(['on'], o);
  writeFileSync(settings, serialize({ ...json(settings), feedbackSurveyRate: 0.2, enableArtifact: true }));
  const off = main(['off'], o);
  assert.equal(off.code, 0);
  assert.match(off.message, /feedbackSurveyRate: on 뒤에 0\.2 로 바뀌어 그대로 둠/);
  assert.match(off.message, /enableArtifact: on 뒤에 true 로 바뀌어 그대로 둠/);
  const s = json(settings);
  assert.equal(s.feedbackSurveyRate, 0.2);
  assert.equal(s.enableArtifact, true);
  assert.equal(s.disableRemoteControl, undefined);
});

test('on again keeps the first record, so off still goes back to the values before the first on', () => {
  const { o, settings } = place({ codex: false });
  writeFileSync(settings, serialize({ feedbackDrafts: 'quiet' }));
  main(['on'], o);
  assert.match(main(['on'], o).message, /이미 켜짐/);
  writeFileSync(settings, serialize({ ...json(settings), feedbackDrafts: 'notify' }));
  assert.match(main(['on'], o).message, /feedbackDrafts: "notify" -> "off"/);
  main(['off'], o);
  assert.equal(json(settings).feedbackDrafts, 'quiet');
});

test('a value that was already what on wants is left alone by off', () => {
  const { o, settings } = place({ codex: false });
  writeFileSync(settings, serialize({ enableArtifact: false }));
  main(['on'], o);
  main(['off'], o);
  assert.deepEqual(json(settings), { enableArtifact: false });
});

test('a broken settings.json stops everything: no target is changed', () => {
  const { o, settings } = place();
  writeFileSync(settings, '{ "model": "opus", ');
  writeFileSync(o.codexFile, TOML);
  const r = main(['on'], o);
  assert.equal(r.code, 1);
  assert.match(r.message, /올바른 JSON 이 아님.*아무것도 바꾸지 않음/s);
  assert.equal(read(settings), '{ "model": "opus", ');
  assert.equal(read(o.codexFile), TOML);
  assert.ok(!existsSync(o.bankerDir), 'banker config untouched');
});

test('other refusals: a JSON array, a non-object parent, a folder at the settings name, a non-UTF-8 file', () => {
  for (const [body, why] of [['[1]', /최상위가 JSON 객체가 아님/], ['{"attribution": true}', /attribution 가 객체가 아니라/], [Buffer.from([0xff, 0xfe, 0x7b, 0x7d]), /UTF-8 이 아님/]]) {
    const { o, settings } = place({ codex: false });
    writeFileSync(settings, body);
    const r = main(['on'], o);
    assert.equal(r.code, 1, String(body));
    assert.match(r.message, why);
  }
  const { o, settings } = place({ codex: false });
  mkdirSync(settings);
  assert.match(main(['on'], o).message, /일반 파일이 아님/);
});

test('an empty settings.json reads as {} and keeps working', () => {
  const { o, settings } = place({ codex: false });
  writeFileSync(settings, '  \n');
  assert.equal(main(['on'], o).code, 0);
  assert.equal(json(settings).disableRemoteControl, true);
  main(['off'], o);
  assert.deepEqual(json(settings), {});
});

test('a BOM before the JSON stays through on and off', () => {
  const { o, settings } = place({ codex: false });
  writeFileSync(settings, `\uFEFF${SETTINGS}`);
  main(['on'], o);
  assert.ok(read(settings).startsWith('\uFEFF{'));
  assert.equal(readJson(settings).data.disableRemoteControl, true);
  main(['off'], o);
  assert.equal(read(settings), `\uFEFF${SETTINGS}`);
});

test('the file mode is kept, and the backup and record are readable by this account alone', { skip: process.platform === 'win32' && 'Windows has no POSIX file modes' }, () => {
  const { o, settings } = place({ codex: false });
  writeFileSync(settings, SETTINGS);
  chmodSync(settings, 0o640);
  main(['on'], o);
  assert.equal(statSync(settings).mode & 0o777, 0o640);
  assert.equal(statSync(`${settings}.never-public.bak`).mode & 0o777, 0o600);
  assert.equal(statSync(`${settings}.never-public.json`).mode & 0o777, 0o600);
  main(['off'], o);
  assert.equal(statSync(settings).mode & 0o777, 0o640);
});

test('a linked settings.json is changed behind the link, and the link stays', { skip: symlinkSkip }, () => {
  const { d, o, settings } = place({ codex: false });
  const real = join(d, 'dotfiles-settings.json');
  writeFileSync(real, SETTINGS);
  symlinkSync(real, settings);
  main(['on'], o);
  assert.equal(json(real).disableRemoteControl, true);
  main(['off'], o);
  assert.equal(read(real), SETTINGS);
  assert.equal(readJson(settings).data.model, 'opus');
});

test('TOML: CRLF, top-level dotted keys and tables on created are put back exactly', () => {
  const { o } = place({ claude: false });
  const crlf = '# c\r\nmodel = "m"\r\nanalytics.enabled = true\r\n\r\n[tui]\r\nx = 1\r\n';
  writeFileSync(o.codexFile, crlf);
  assert.equal(main(['on', '--only', 'codex'], o).code, 0);
  const t = read(o.codexFile);
  assert.ok(t.includes('analytics.enabled = false\r\n'), 'the dotted key is edited where it is');
  assert.ok(!t.includes('[analytics]'), 'no [analytics] table beside the dotted key');
  assert.ok(t.includes('[otel]\r\n') && !/[^\r]\n/.test(t), 'new tables use CRLF too');
  main(['off', '--only', 'codex'], o);
  assert.equal(read(o.codexFile), crlf);
});

test('TOML: an inline table or a sub-table at a key on writes is refused, file untouched', () => {
  for (const text of ['otel = { exporter = "otlp-http" }\n', '[otel.exporter.otlp-http]\nendpoint = "http://x"\n', '[otel]\nexporter.otlp-grpc.endpoint = "e"\n']) {
    const { o } = place({ claude: false });
    writeFileSync(o.codexFile, text);
    const r = main(['on', '--only', 'codex'], o);
    assert.equal(r.code, 1, text);
    assert.equal(read(o.codexFile), text);
  }
});

test('a Codex config.toml that is a link is refused', { skip: symlinkSkip }, () => {
  const { d, o } = place({ claude: false });
  writeFileSync(join(d, 'real.toml'), TOML);
  symlinkSync(join(d, 'real.toml'), o.codexFile);
  assert.equal(main(['on', '--only', 'codex'], o).code, 1);
  assert.equal(read(join(d, 'real.toml')), TOML);
});

test('targets: absent config folders are skipped, but --only names them as missing', () => {
  const { o } = place({ claude: false, codex: false });
  const r = main(['on'], o);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.message, /^- (Claude Code|Codex)[ :(]/m);
  assert.ok(existsSync(join(o.bankerDir, 'config.json')));
  const only = main(['on', '--only', 'claude'], o);
  assert.equal(only.code, 1);
  assert.match(only.message, /Claude Code 설정 폴더가 없음/);
});

test('status names each key and its value; usage errors exit 1', () => {
  const { o, settings } = place();
  writeFileSync(settings, SETTINGS);
  assert.match(main(['status'], o).message, /Claude Code: 꺼짐[\s\S]*\[ \] attribution\.commit = "Made by me"/);
  main(['on', '--only', 'claude'], o);
  const s = main([], o).message;
  assert.match(s, /Claude Code: 켜짐/);
  assert.match(s, /Codex: 꺼짐[\s\S]*\[ \] analytics\.enabled = \(없음\)/);
  for (const argv of [['bogus'], ['on', 'off'], ['on', '--only', 'x'], ['on', '--only', '']]) assert.equal(main(argv, o).code, 1, argv.join(' '));
  assert.deepEqual(parseArgs(['OFF', '--only=codex,banker']), { command: 'off', only: ['codex', 'banker'], yes: false });
});

test('banker config folder follows telemetry-config: XDG_CONFIG_HOME, then %APPDATA% on Windows, then ~/.config', () => {
  assert.equal(defaults({ XDG_CONFIG_HOME: join(root, 'x') }).bankerDir, join(root, 'x', 'banker'));
  assert.equal(defaults({ APPDATA: join(root, 'ad') }, 'win32').bankerDir, join(root, 'ad', 'banker'));
  assert.match(defaults({}, 'linux').bankerDir, /\.config[\\/]banker$/);
  assert.equal(defaults({ CODEX_HOME: 'rel' }).codexFile, join(process.cwd(), 'rel', 'config.toml'));
});

test('after on, banker itself counts nothing and checks no update (telemetry-config reads the same file)', () => {
  const { d, o } = place({ claude: false, codex: false });
  const probe = (xdg) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `const t = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'bin', 'lib', 'telemetry-config.mjs')).href)});`
    + 'console.log(JSON.stringify({ counting: t.countingActive(), noUpdate: t.noUpdateCheck(), star: t.readConfig().promptedStarV1 === true }))'],
  { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: xdg, BANKER_NO_TELEMETRY: '', BANKER_NO_UPDATE_CHECK: '' } });
  const xdg = join(d, 'cfg');
  assert.deepEqual(JSON.parse(probe(xdg).stdout), { counting: true, noUpdate: false, star: false }, 'the default is on');
  main(['on'], { ...o, bankerDir: join(xdg, 'banker') });
  assert.deepEqual(JSON.parse(probe(xdg).stdout), { counting: false, noUpdate: true, star: true });
  main(['off'], { ...o, bankerDir: join(xdg, 'banker') });
  assert.deepEqual(JSON.parse(probe(xdg).stdout), { counting: true, noUpdate: false, star: false });
});

// Runs banker's three hooks that can reach the network, with every connection refused and written down
// (test-fixtures/no-network.mjs, through NODE_OPTIONS so the fetcher update-notify starts gets it too).
// Returns the attempts seen within `waitMs`.
function hookAttempts(xdg, mark, waitMs) {
  const preload = pathToFileURL(join(ROOT, 'scripts', 'test-fixtures', 'no-network.mjs')).href;
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, NO_NETWORK_MARK: mark, NODE_OPTIONS: `--import=${preload}` };
  for (const k of ['BANKER_NO_TELEMETRY', 'BANKER_NO_UPDATE_CHECK', 'BANKER_TELEMETRY_ENDPOINT', 'CODEX_THREAD_ID', 'CLAUDE_PLUGIN_ROOT']) delete env[k];
  for (const hook of ['update-notify.mjs', 'update-fetch.mjs', 'update-checkin.mjs']) {
    spawnSync(process.execPath, [join(ROOT, 'hooks', hook)], { input: '{}', encoding: 'utf8', env, timeout: 30000 });
  }
  const end = Date.now() + waitMs;
  while (Date.now() < end && !existsSync(mark)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  return existsSync(mark) ? read(mark).trim().split('\n') : [];
}

test('after on, banker hooks try no connection at all; without it the same probe sees them try', () => {
  const { d, o } = place({ claude: false, codex: false });
  const xdg = join(d, 'cfg');
  main(['on'], { ...o, bankerDir: join(xdg, 'banker') });
  assert.deepEqual(hookAttempts(xdg, join(d, 'on.mark'), 1500), [], 'never-public on: no request, lookup or socket');
  main(['off'], { ...o, bankerDir: join(xdg, 'banker') });
  assert.ok(hookAttempts(join(d, 'cfg2'), join(d, 'off.mark'), 5000).length > 0, 'the probe does see the default update check');
});

test('the command line runs on the env folders and exits 3 when it may not write', () => {
  const { d } = place({ claude: false, codex: false });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(d, 'claude'), CODEX_HOME: join(d, 'codex'), XDG_CONFIG_HOME: join(d, 'cfg'), APPDATA: join(d, 'cfg') };
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', env });
  const on = run('on');
  assert.equal(on.status, 0, on.stdout + on.stderr);
  assert.equal(json(join(env.CLAUDE_CONFIG_DIR, 'settings.json')).feedbackDrafts, 'off');
  assert.equal(run('bogus').status, 1);
  assert.equal(run('off').status, 0);
  if (process.platform === 'win32' || process.getuid?.() === 0) return; // Windows ignores folder modes; root writes anyway
  chmodSync(env.CLAUDE_CONFIG_DIR, 0o555);
  try {
    const denied = run('on', '--only', 'claude');
    assert.equal(denied.status, 3, denied.stdout);
    assert.match(denied.stdout, /쓸 권한이 없음/);
  } finally {
    chmodSync(env.CLAUDE_CONFIG_DIR, 0o755);
  }
});

test('deletePath removes only the parents it was told to prune, and only when they are empty', () => {
  const o = { a: { b: 1, c: 2 }, x: { y: 1 } };
  deletePath(o, ['a', 'b'], ['a']);
  assert.deepEqual(o.a, { c: 2 });
  deletePath(o, ['x', 'y'], []);
  assert.deepEqual(o.x, {});
  deletePath(o, ['a', 'c'], ['a']);
  assert.equal(o.a, undefined);
  assert.equal(CODEX_WANT.length, 6);
});

test('telemetry and error reporting go in env beside the user env keys, and off puts env back as it was', () => {
  const { o, settings } = place({ codex: false });
  writeFileSync(settings, serialize({ env: { MY_VAR: 'x', DISABLE_TELEMETRY: '0' } }));
  main(['on'], o);
  const s = json(settings);
  assert.deepEqual(s.env, { MY_VAR: 'x', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' });
  assert.equal(s.syncClaudeAiPlugins, false);
  assert.equal(s.syncClaudeAiSkills, false);
  main(['off'], o);
  assert.deepEqual(json(settings), { env: { MY_VAR: 'x', DISABLE_TELEMETRY: '0' } });
  const fresh = place({ codex: false });
  writeFileSync(fresh.settings, serialize({ model: 'x' }));
  main(['on'], fresh.o);
  main(['off'], fresh.o);
  assert.deepEqual(json(fresh.settings), { model: 'x' }, 'an env object on made is removed again');
});

test('on always ends with the traffic it leaves on', () => {
  const { o } = place({ codex: false });
  for (let i = 0; i < 2; i++) {
    const r = main(['on'], o);
    assert.equal(r.message.split('\n').pop(), REMAINING);
  }
  for (const word of ['모델 API', '자동 업데이트', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'update-banker', 'deep-research', 'wbs-gen', '3d-intro']) assert.ok(REMAINING.includes(word), word);
  assert.ok(!main(['off'], o).message.includes(REMAINING));
});

test('attribution false already means no attribution: on leaves it and the other keys still go on', () => {
  const { o, settings } = place({ codex: false });
  writeFileSync(settings, serialize({ attribution: false }));
  const r = main(['on'], o);
  assert.equal(r.code, 0, r.message);
  const s = json(settings);
  assert.equal(s.attribution, false);
  assert.equal(s.disableRemoteControl, true);
  assert.match(main(['status'], o).message, /Claude Code: 켜짐/);
  main(['off'], o);
  assert.deepEqual(json(settings), { attribution: false });
});

test('a second on with changed values keeps the first backup', () => {
  const { o, settings } = place({ codex: false });
  writeFileSync(settings, SETTINGS);
  main(['on'], o);
  writeFileSync(settings, serialize({ ...json(settings), enableArtifact: true }));
  main(['on'], o);
  assert.equal(read(`${settings}.never-public.bak`), SETTINGS);
  const toml = place({ claude: false });
  writeFileSync(toml.o.codexFile, TOML);
  main(['on', '--only', 'codex'], toml.o);
  writeFileSync(toml.o.codexFile, read(toml.o.codexFile).replace('enabled = false', 'enabled = true'));
  main(['on', '--only', 'codex'], toml.o);
  assert.equal(read(`${toml.o.codexFile}.never-public.bak`), TOML);
});

test('the JSON layout stays: CRLF, four-space or tab indents, one-line files, no final newline', () => {
  const bodies = [
    '{\r\n    "model": "opus",\r\n    "env": {\r\n        "A": "1"\r\n    }\r\n}\r\n',
    '{\n\t"model": "opus"\n}',
    '{"model":"opus"}\n',
  ];
  for (const body of bodies) {
    const { o, settings } = place({ codex: false });
    writeFileSync(settings, body);
    main(['on'], o);
    const on = read(settings);
    assert.equal(on.includes('\r\n'), body.includes('\r\n'), JSON.stringify(body));
    main(['off'], o);
    assert.equal(read(settings), body, JSON.stringify(body));
  }
});

test('a refused Codex file names the --only that turns on the rest', () => {
  const { o, settings } = place();
  writeFileSync(settings, SETTINGS);
  writeFileSync(o.codexFile, '[otel.exporter.otlp-http]\nendpoint = "http://x"\n');
  const r = main(['on'], o);
  assert.equal(r.code, 1);
  assert.match(r.message, /Codex 를 빼고 나머지만 하려면 --only claude,banker/);
  assert.equal(main(['on', '--only', 'claude,banker'], o).code, 0);
});

test('a TOML value left open to the end of the file is refused', () => {
  for (const text of ['model = "m"\ninstructions = """\nnever closed\n', 'list = [\n  "a",\n']) {
    const { o } = place({ claude: false });
    writeFileSync(o.codexFile, text);
    const r = main(['on', '--only', 'codex'], o);
    assert.equal(r.code, 1, text);
    assert.match(r.message, /닫히지 않음/);
    assert.equal(read(o.codexFile), text);
  }
});

test('a relative CLAUDE_CONFIG_DIR is resolved like CODEX_HOME', () => {
  assert.equal(defaults({ CLAUDE_CONFIG_DIR: 'rel-claude' }).claudeDir, join(process.cwd(), 'rel-claude'));
});

// A synced bucket as Claude Code 2.1.332 keeps it: <config>/<skills|plugins>/synced/<org uuid>_<account uuid>/<name>/.
const BUCKET = 'a721cd85-c2a5-4821-9b39-66f2edd79961_9f0e0dcf-e01a-4b3e-a4d4-a6eaf0702b93';
function synced(claudeDir, dir, names) {
  for (const n of names) mkdirSync(join(claudeDir, dir, 'synced', BUCKET, n), { recursive: true });
  mkdirSync(join(claudeDir, dir, 'synced', BUCKET, '.staging'), { recursive: true });
  writeFileSync(join(claudeDir, dir, 'synced', BUCKET, 'manifest.json'), '{}');
}

test('claude.ai sync: with synced skills, on names them and leaves that key until --yes; the rest still goes on', () => {
  const { o, settings } = place({ codex: false });
  writeFileSync(settings, SETTINGS);
  synced(o.claudeDir, 'skills', ['pdf', 'docx']);
  const r = main(['on'], o);
  assert.equal(r.code, 0, r.message);
  assert.match(r.message, /확인 필요: claude\.ai 동기화를 끄면/);
  assert.ok(r.message.includes(`스킬(${join(o.claudeDir, 'skills', '.trash')} 로): docx, pdf`), r.message);
  assert.match(r.message, /cleanupPeriodDays 뒤 지워짐/);
  assert.match(r.message, /네트워크가 필요함/);
  assert.match(r.message, /남은 일: 목록을 확인한 뒤 never-public on --yes 로 syncClaudeAiSkills 도 끔/);
  assert.doesNotMatch(r.message, /플러그인\(/, 'no synced plugins: no plugin line, and that key goes on');
  let s = json(settings);
  assert.equal(s.syncClaudeAiSkills, undefined);
  assert.equal(s.syncClaudeAiPlugins, false);
  assert.equal(s.disableRemoteControl, true);
  const yes = main(['on', '--yes'], o);
  assert.match(yes.message, /적용함: claude\.ai 동기화를 끄면/);
  assert.doesNotMatch(yes.message, /남은 일/);
  s = json(settings);
  assert.equal(s.syncClaudeAiSkills, false);
  assert.ok(existsSync(join(o.claudeDir, 'skills', 'synced', BUCKET, 'pdf')), 'never-public moves nothing itself');
  const off = main(['off'], o);
  assert.ok(off.message.includes(RESYNC.trim()), off.message);
  assert.equal(read(settings), SETTINGS);
});

test('claude.ai sync: nothing synced or the key already false means no question', () => {
  const { o, settings } = place({ codex: false });
  writeFileSync(settings, serialize({ syncClaudeAiSkills: false }));
  synced(o.claudeDir, 'skills', ['pdf']);
  synced(o.claudeDir, 'plugins', []);
  const r = main(['on'], o);
  assert.doesNotMatch(r.message, /확인 필요/);
  assert.equal(json(settings).syncClaudeAiPlugins, false);
  assert.deepEqual(syncedNames(o.claudeDir, 'plugins'), []);
  assert.deepEqual(syncedNames(o.claudeDir, 'skills'), ['pdf']);
  assert.ok(parseArgs(['off', '--yes']).error, '--yes is for on only');
  assert.deepEqual(parseArgs(['on', '--yes']), { command: 'on', only: null, yes: true });
});

test('a second on after a first on that made the file writes no backup of the on bytes', () => {
  const { o, settings } = place({ codex: false });
  main(['on'], o);
  writeFileSync(settings, serialize({ ...json(settings), enableArtifact: true }));
  main(['on'], o);
  assert.ok(!existsSync(`${settings}.never-public.bak`));
  main(['off'], o);
  assert.ok(!existsSync(settings), 'the file on made is gone again');
});
