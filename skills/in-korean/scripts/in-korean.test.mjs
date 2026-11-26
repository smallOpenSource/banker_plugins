// Tests for in-korean.mjs. Run: node --test skills/in-korean/scripts/in-korean.test.mjs
// Every case works in its own temp Claude Code and Codex folders: the real ~/.claude and ~/.codex are never touched.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { symlinkSkip } from '../../../scripts/test-fixtures/can-symlink.mjs';
import { pwshEnv } from '../../../scripts/test-fixtures/pwsh-env.mjs';
import { defaults, EVENTS, hookEntry, hookJson, hookState, main, MARK, parseArgs, shellCommand, TEXT, withHooks } from './in-korean.mjs';
import { serialize } from './settings-json.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'in-korean.mjs');
const root = mkdtempSync(join(tmpdir(), 'in-korean-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function place({ claude = true, codex = true, platform = process.platform } = {}) {
  const d = join(root, `p${n++}`);
  const o = { claudeDir: join(d, 'claude'), codexDir: join(d, 'codex'), platform };
  if (claude) mkdirSync(o.claudeDir, { recursive: true });
  if (codex) mkdirSync(o.codexDir, { recursive: true });
  return { d, o, settings: join(o.claudeDir, 'settings.json'), hooks: join(o.codexDir, 'hooks.json') };
}
const read = (f) => readFileSync(f, 'utf8');
const json = (f) => JSON.parse(read(f));
const ours = (doc, ev) => doc.hooks[ev].flatMap((g) => g.hooks).filter((h) => h.command.includes(MARK));
const OTHER = { type: 'command', command: 'node /opt/tool/other-hook.js' };

test('the hook output is one ASCII JSON line that gives the model the Korean instruction', () => {
  assert.ok(!TEXT.includes("'"), 'no single quote: the commands keep the JSON inside single quotes');
  assert.ok(TEXT.length < 200, `short, as it goes into every prompt (${TEXT.length} chars)`);
  assert.match(TEXT, /한국어/);
  assert.match(TEXT, /서브에이전트/);
  for (const ev of EVENTS) {
    const line = hookJson(ev);
    assert.ok(/^[\x20-\x7e]+$/.test(line), 'ASCII only');
    assert.deepEqual(JSON.parse(line), { hookSpecificOutput: { hookEventName: ev, additionalContext: TEXT } });
  }
});

// Runs a hook command in a shell and parses what it prints. A missing shell fails the test (spawn error).
function runIn(shell, args, command, env = process.env) {
  const r = spawnSync(shell, [...args, command], { encoding: 'utf8', timeout: 30000, windowsHide: true, env });
  assert.equal(r.error, undefined, `${shell}: ${r.error?.message}`);
  assert.equal(r.status, 0, `${shell}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}
const want = (ev) => ({ hookSpecificOutput: { hookEventName: ev, additionalContext: TEXT } });
const isWin = process.platform === 'win32';
const PSE = isWin ? pwshEnv() : null; // a temp home and the telemetry opt-outs for every PowerShell started here
after(() => PSE && rmSync(PSE.home, { recursive: true, force: true }));
// Git for Windows' bash, which Claude Code uses on Windows (not System32\bash.exe, the WSL launcher).
const GIT_BASH = isWin ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map((d) => join(d, 'Git', 'bin', 'bash.exe')).find(existsSync) : null;

test('the POSIX command prints the JSON in sh and bash', { skip: isWin && 'Windows has no POSIX sh by default' }, () => {
  for (const ev of EVENTS) {
    assert.deepEqual(runIn('sh', ['-c'], shellCommand(ev, 'posix')), want(ev));
    assert.deepEqual(runIn('bash', ['-c'], shellCommand(ev, 'both')), want(ev), 'the Windows Claude Code command under bash');
  }
});

test('the PowerShell command prints the JSON (Codex on Windows, Claude Code on Windows without Git Bash)', { skip: !isWin && 'Windows PowerShell is a Windows program' }, () => {
  for (const ev of EVENTS) {
    for (const shell of ['powershell', 'both']) {
      assert.deepEqual(runIn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command'], shellCommand(ev, shell), PSE.env), want(ev), shell);
    }
  }
});

test('the Windows Claude Code command prints the JSON in Git Bash', { skip: (!isWin && 'Git Bash is the Windows shell of Claude Code') || (!GIT_BASH && 'Git for Windows is not installed') }, () => {
  for (const ev of EVENTS) assert.deepEqual(runIn(GIT_BASH, ['-c'], shellCommand(ev, 'both')), want(ev));
});

test('hook entries: Claude Code picks the command by OS, Codex carries both command and commandWindows', () => {
  assert.match(hookEntry('SessionStart', 'claude', 'linux').command, /^printf '%s\\n' '\{/);
  assert.match(hookEntry('SessionStart', 'claude', 'win32').command, /^echo '\{/);
  const cx = hookEntry('UserPromptSubmit', 'codex', 'linux');
  assert.deepEqual(cx, hookEntry('UserPromptSubmit', 'codex', 'win32'), 'the same file on every OS');
  assert.match(cx.commandWindows, /^Write-Output '\{/);
  assert.equal(cx.timeout, 10);
  for (const e of [hookEntry('SessionStart', 'claude', 'linux'), cx]) assert.ok(e.command.endsWith(`# ${MARK}`));
});

test('Claude Code: on adds both hooks at the end and language, off takes back exactly what on added', () => {
  const { o, settings } = place({ codex: false, platform: 'linux' });
  const before = serialize({ model: 'opus', hooks: { UserPromptSubmit: [{ hooks: [OTHER] }], Stop: [{ hooks: [OTHER] }] } });
  writeFileSync(settings, before);
  const on = main(['on', '--runtime', 'claude'], o);
  assert.equal(on.code, 0, on.message);
  assert.match(on.message, /language 가 없어 "korean" 을 넣음/);
  const s = json(settings);
  assert.deepEqual(s.hooks.UserPromptSubmit[0], { hooks: [OTHER] }, 'the other hook keeps its place');
  assert.deepEqual(s.hooks.UserPromptSubmit[1], { hooks: [hookEntry('UserPromptSubmit', 'claude', 'linux')] });
  assert.equal(s.hooks.SessionStart[0].matcher, undefined, 'no matcher: startup, resume, clear and compact all get it');
  assert.equal(s.language, 'korean');
  assert.equal(read(`${settings}.in-korean.bak`), before);
  assert.equal(hookState(s, 'claude', 'linux'), 'on');
  assert.match(main(['on', '--runtime', 'claude'], o).message, /이미 켜져 있음/);
  const off = main(['off', '--runtime', 'claude'], o);
  assert.equal(off.code, 0);
  assert.match(off.message, /language 도 뺌/);
  assert.equal(read(settings), before);
  assert.ok(!existsSync(`${settings}.in-korean.json`));
  assert.match(main(['off', '--runtime', 'claude'], o).message, /이미 꺼져 있음/);
});

test('Claude Code: a language already set stays, a non-Korean one is reported, and a missing file comes and goes', () => {
  const { o, settings } = place({ codex: false });
  writeFileSync(settings, serialize({ language: 'english' }));
  const on = main(['on', '--runtime', 'claude'], o);
  assert.match(on.message, /language 가 "english" 임. 바꾸지 않았고/);
  main(['off', '--runtime', 'claude'], o);
  assert.deepEqual(json(settings), { language: 'english' });
  const fresh = place({ codex: false });
  main(['on', '--runtime', 'claude'], fresh.o);
  assert.equal(json(fresh.settings).language, 'korean');
  main(['off', '--runtime', 'claude'], fresh.o);
  assert.ok(!existsSync(fresh.settings), 'the settings.json on created is gone again');
});

test('a stale hook (older text or timeout) is fixed in place, and duplicates are dropped', () => {
  const { o, settings } = place({ codex: false, platform: 'linux' });
  const old = { type: 'command', command: `printf '%s\\n' '{}' # ${MARK}`, timeout: 3 };
  writeFileSync(settings, serialize({ hooks: { SessionStart: [{ hooks: [old] }, { hooks: [OTHER] }, { hooks: [old] }] } }));
  assert.equal(hookState(json(settings), 'claude', 'linux'), 'stale');
  assert.match(main(['status'], o).message, /이 판과 다름/);
  main(['on', '--runtime', 'claude'], o);
  const s = json(settings);
  assert.equal(s.hooks.SessionStart.length, 2);
  assert.deepEqual(s.hooks.SessionStart[0].hooks[0], hookEntry('SessionStart', 'claude', 'linux'));
  assert.deepEqual(s.hooks.SessionStart[1], { hooks: [OTHER] });
});

test('refusals leave the file as it was: broken JSON, hooks not an object, an event not an array', () => {
  for (const body of ['{"hooks": ', '{"hooks": []}', '{"hooks": {"SessionStart": {}}}', '[]']) {
    const { o, settings } = place({ codex: false });
    writeFileSync(settings, body);
    const r = main(['on', '--runtime', 'claude'], o);
    assert.equal(r.code, 1, body);
    assert.match(r.message, /거부: .*아무것도 바꾸지 않음/);
    assert.equal(read(settings), body);
  }
  const { o } = place({ claude: false, codex: false });
  assert.match(main(['on', '--runtime', 'claude'], o).message, /Claude Code 설정 폴더가 없음/);
});

test('Codex: hooks go at the end of each event so earlier groups keep their trust, off removes them and the file it made', () => {
  const { o, hooks } = place({ claude: false });
  assert.equal(main(['on', '--runtime', 'codex'], o).code, 0);
  assert.deepEqual(Object.keys(json(hooks).hooks).sort(), [...EVENTS].sort());
  main(['off', '--runtime', 'codex'], o);
  assert.ok(!existsSync(hooks), 'the hooks.json on created is gone again');
  const before = serialize({ hooks: { SessionStart: [{ matcher: 'startup|resume|clear', hooks: [OTHER] }] } });
  writeFileSync(hooks, before);
  const on = main(['on', '--runtime', 'codex'], o);
  assert.match(on.message, /\/hooks 에서 banker in-korean 훅 2개를 신뢰/);
  const doc = json(hooks);
  assert.deepEqual(doc.hooks.SessionStart[0], { matcher: 'startup|resume|clear', hooks: [OTHER] });
  assert.deepEqual(ours(doc, 'SessionStart'), [hookEntry('SessionStart', 'codex')]);
  assert.equal(doc.language, undefined, 'Codex has no language key');
  assert.equal(hookState(doc, 'codex', process.platform), 'on');
  main(['off', '--runtime', 'codex'], o);
  assert.equal(read(hooks), before);
});

test('Codex: a linked hooks.json is refused', { skip: symlinkSkip }, () => {
  const { d, o, hooks } = place({ claude: false });
  writeFileSync(join(d, 'real.json'), '{}');
  symlinkSync(join(d, 'real.json'), hooks);
  assert.match(main(['on', '--runtime', 'codex'], o).message, /링크임/);
  assert.equal(read(join(d, 'real.json')), '{}');
});

test('Codex: a stale lock is cleared, a live one makes on give up without changes', () => {
  const { o, hooks } = place({ claude: false });
  mkdirSync(`${hooks}.lock`);
  const old = new Date(Date.now() - 60000);
  utimesSync(`${hooks}.lock`, old, old);
  assert.equal(main(['on', '--runtime', 'codex'], o).code, 0);
  assert.ok(!existsSync(`${hooks}.lock`));
  const before = read(hooks);
  mkdirSync(`${hooks}.lock`);
  const busy = main(['off', '--runtime', 'codex'], o);
  assert.equal(busy.code, 1);
  assert.match(busy.message, /잠금/);
  assert.equal(read(hooks), before);
  rmSync(`${hooks}.lock`, { recursive: true });
});

test('withHooks removes the hooks object it made but keeps one that was there', () => {
  const on = withHooks({}, 'claude', 'linux', false);
  assert.deepEqual(withHooks(on, 'claude', 'linux', true, false), {});
  assert.deepEqual(withHooks(on, 'claude', 'linux', true, true), { hooks: {} });
});

test('command line: on is the default, a runtime is needed outside Claude Code, status needs none', () => {
  assert.deepEqual(parseArgs([], { CLAUDECODE: '1' }), { command: 'on', runtime: 'claude' });
  assert.match(parseArgs(['on'], {}).error, /런타임을 정할 수 없음/);
  assert.deepEqual(parseArgs(['STATUS'], {}), { command: 'status', runtime: null });
  assert.deepEqual(parseArgs(['off', '--runtime=codex'], {}), { command: 'off', runtime: 'codex' });
  for (const a of [['bogus'], ['on', 'x'], ['on', '--runtime', 'gemini']]) assert.ok(parseArgs(a, {}).error, a.join(' '));
  const { d } = place({ claude: true, codex: true });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(d, 'claude'), CODEX_HOME: join(d, 'codex') };
  delete env.CLAUDECODE;
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', env });
  assert.equal(run('on').status, 1);
  const on = run('on', '--runtime', 'codex');
  assert.equal(on.status, 0, on.stdout + on.stderr);
  assert.match(run('status').stdout, /Claude Code: 꺼짐[\s\S]*Codex: 켜짐/);
  assert.equal(run('off', '--runtime', 'codex').status, 0);
});

test('SKILL.md quotes the instruction the hooks add, word for word', () => {
  const doc = readFileSync(join(dirname(SCRIPT), '..', 'SKILL.md'), 'utf8');
  assert.ok(doc.includes(`> ${TEXT}\n`), 'the quoted instruction in SKILL.md matches TEXT');
});

test('the first backup survives a second on, and off removes the backup and the record', () => {
  const { o, settings } = place({ codex: false, platform: 'linux' });
  const before = serialize({ model: 'opus' });
  writeFileSync(settings, before);
  main(['on', '--runtime', 'claude'], o);
  writeFileSync(settings, serialize({ ...json(settings), hooks: { ...json(settings).hooks, SessionStart: [] } }));
  main(['on', '--runtime', 'claude'], o);
  assert.equal(read(`${settings}.in-korean.bak`), before);
  main(['off', '--runtime', 'claude'], o);
  assert.ok(!existsSync(`${settings}.in-korean.bak`));
  assert.ok(!existsSync(`${settings}.in-korean.json`));
});

test('CRLF and four-space settings come back byte for byte', () => {
  const { o, settings } = place({ codex: false, platform: 'linux' });
  const before = '{\r\n    "model": "opus",\r\n    "language": "korean"\r\n}\r\n';
  writeFileSync(settings, before);
  main(['on', '--runtime', 'claude'], o);
  assert.ok(read(settings).includes('\r\n    "hooks": {'));
  main(['off', '--runtime', 'claude'], o);
  assert.equal(read(settings), before);
});

test('Codex off warns about re-trusting only when other groups came after ours', () => {
  const { o, hooks } = place({ claude: false });
  writeFileSync(hooks, serialize({ hooks: { Stop: [{ hooks: [OTHER] }] } }));
  main(['on', '--runtime', 'codex'], o);
  assert.doesNotMatch(main(['off', '--runtime', 'codex'], o).message, /다시 신뢰/);
  main(['on', '--runtime', 'codex'], o);
  const doc = json(hooks);
  doc.hooks.UserPromptSubmit.push({ hooks: [OTHER] });
  writeFileSync(hooks, serialize(doc));
  assert.match(main(['off', '--runtime', 'codex'], o).message, /다시 신뢰/);
});

test('a failed off write keeps the record, so the next off still takes out the language on added', { skip: (process.platform === 'win32' && 'Windows ignores folder modes') || (process.getuid?.() === 0 && 'root writes anyway') }, () => {
  const { o, settings } = place({ codex: false, platform: 'linux' });
  main(['on', '--runtime', 'claude'], o);
  chmodSync(o.claudeDir, 0o555);
  try {
    assert.equal(main(['off', '--runtime', 'claude'], o).code, 3);
  } finally {
    chmodSync(o.claudeDir, 0o755);
  }
  assert.ok(existsSync(`${settings}.in-korean.json`));
  assert.match(main(['off', '--runtime', 'claude'], o).message, /language 도 뺌/);
});

test('a relative CLAUDE_CONFIG_DIR is resolved like CODEX_HOME', () => {
  assert.equal(defaults({ CLAUDE_CONFIG_DIR: 'rel-claude' }).claudeDir, join(process.cwd(), 'rel-claude'));
});
