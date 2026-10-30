// pm-config.mjs 시험. 기본값, 형식 오류, 런타임별 자료 폴더, --data 우선, events 경로, 정규식 컴파일, stages auto.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveContext, projectRoot, loadConfig, validate, defaults, stagesFor, eventsPath, dataLabel, privateIPv4, readRegular, ULTRA_STAGES, UsageError } from './pm-config.mjs';

const T = { timeout: 60000 };
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progress-mon-test-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
function proj(...dataDirs) {
  const p = path.join(ROOT, `p${++n}`, 'my-app');
  fs.mkdirSync(p, { recursive: true });
  for (const d of dataDirs) fs.mkdirSync(path.join(p, d), { recursive: true });
  return p;
}

test('사설 IPv4 분류', T, () => {
  for (const ok of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.100.20']) assert.equal(privateIPv4(ok), true, ok);
  for (const bad of ['0.0.0.0', '::', '::1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '169.254.1.1', '100.64.0.1', '127.0.0.1', 'localhost', 'example.com', '10.0.0', '', undefined]) assert.equal(privateIPv4(bad), false, String(bad));
});

test('설정 파일 없으면 기본값. 제목과 짧은 이름은 폴더 이름', T, () => {
  const p = proj('.omc/progress-mon');
  const ctx = resolveContext({ cwd: p, project: p });
  const { config, errors, found } = loadConfig(ctx);
  assert.equal(found, false);
  assert.deepEqual(errors, []);
  assert.equal(config.title, 'my-app 진척도');
  assert.equal(config.shortName, 'my-app');
  assert.equal(config.port, 30000);
  assert.equal(config.portStrict, false);
  assert.deepEqual(config.hosts, []);
  assert.equal(config.refreshSec, 30);
  assert.equal(config.stages, 'auto');
  assert.deepEqual(config.stories, []);
  assert.equal(config.sources.workflowDirs, 'auto');
  assert.equal(config.sources.journalMaxSessions, 20);
  assert.equal(config.text.plannedPrefix, '예정');
  assert.equal(defaults(p, 'codex').sources.workflowDirs.length, 0);
});

test('형식 오류는 칸 경로와 이유, 틀린 칸은 기본값', T, () => {
  const { config, errors } = validate(
    { schema: 2, port: 80, portStrict: 'yes', hosts: ['8.8.8.8'], refreshSec: 1, stages: [{ id: 'a' }, { id: 'a' }], stories: 'x', sources: { workflowDirs: 5, journalMaxSessions: -1, events: 3 }, text: { plannedPrefix: 1 } },
    '/x/app',
  );
  const paths = errors.map((e) => e.path);
  for (const p of ['$.schema', '$.port', '$.portStrict', '$.hosts', '$.refreshSec', '$.stages', '$.stories', '$.sources.workflowDirs', '$.sources.journalMaxSessions', '$.sources.events', '$.text.plannedPrefix']) assert.ok(paths.includes(p), p);
  assert.equal(config.port, 30000);
  assert.deepEqual(config.hosts, []);
  assert.equal(validate([], '/x/app').errors[0].path, '$');
  assert.deepEqual(validate({ port: 30001, hosts: ['10.1.2.3'], unknownKey: 1 }, '/x/app').errors, []);
});

test('깨진 JSON 과 BOM', T, () => {
  const p = proj('.omc/progress-mon');
  const ctx = resolveContext({ cwd: p, project: p });
  const file = path.join(ctx.dataDir, 'config.json');
  fs.writeFileSync(file, '{ "port": ');
  assert.match(loadConfig(ctx).errors[0].msg, /JSON 아님/);
  fs.writeFileSync(file, String.fromCharCode(0xfeff) + JSON.stringify({ port: 31000 }));
  const r = loadConfig(ctx);
  assert.deepEqual(r.errors, []);
  assert.equal(r.config.port, 31000);
});

test('commitRegex 는 이름 그룹 id, agentLabelPattern 은 그룹 없음', T, () => {
  assert.deepEqual(validate({ commitRegex: '^(?<id>[A-Z]\\d+):' }, '/a').errors, []);
  assert.match(validate({ commitRegex: '^([A-Z]\\d+):' }, '/a').errors[0].msg, /id/);
  assert.match(validate({ commitRegex: '(' }, '/a').errors[0].msg, /컴파일/);
  assert.deepEqual(validate({ agentLabelPattern: 'S\\d+(?:b)?' }, '/a').errors, []);
  assert.match(validate({ agentLabelPattern: 'S(\\d+)' }, '/a').errors[0].msg, /그룹/);
  assert.match(validate({ agentLabelPattern: '[' }, '/a').errors[0].msg, /컴파일/);
  assert.equal(validate({ commitRegex: 5 }, '/a').errors[0].path, '$.commitRegex');
});

test('런타임 판별: .omx 만, .omc 만, 둘 다, 둘 다 없음', T, () => {
  const a = proj('.omx/progress-mon');
  const ra = resolveContext({ cwd: a, project: a });
  assert.equal(ra.runtime, 'codex');
  assert.equal(ra.dataDir, path.join(a, '.omx', 'progress-mon'));
  assert.equal(ra.exists, true);

  const b = proj('.omc/progress-mon');
  const rb = resolveContext({ cwd: b, project: b });
  assert.equal(rb.runtime, 'claude');
  assert.equal(rb.exists, true);
  assert.equal(rb.warn, null);

  const c = proj('.omc/progress-mon', '.omx/progress-mon');
  const rc = resolveContext({ cwd: c, project: c });
  assert.equal(rc.runtime, 'claude');
  assert.match(rc.warn, /모두 있음/);

  const d = proj();
  const rd = resolveContext({ cwd: d, project: d });
  assert.equal(rd.runtime, 'claude');
  assert.equal(rd.exists, false);
  assert.equal(fs.existsSync(path.join(d, '.omc')), false, '폴더를 만들지 않음');

  const e = proj('.omc/progress-mon');
  const re = resolveContext({ cwd: e, project: e, runtime: 'codex' });
  assert.equal(re.runtime, 'codex');
  assert.equal(re.exists, false);
  assert.throws(() => resolveContext({ cwd: e, project: e, runtime: 'vim' }), UsageError);
});

test('--data 를 주면 그 폴더 존재만 봄', T, () => {
  const p = proj('.omx/progress-mon');
  const data = path.join(ROOT, `data${++n}`);
  fs.mkdirSync(data);
  const r = resolveContext({ cwd: p, project: p, data });
  assert.equal(r.dataDir, data);
  assert.equal(r.runtime, 'claude');
  assert.equal(r.exists, true);
  const missing = resolveContext({ cwd: p, project: p, data: path.join(ROOT, 'nope') });
  assert.equal(missing.exists, false);
  assert.equal(resolveContext({ cwd: p, project: p, data, runtime: 'codex' }).runtime, 'codex');
});

test('프로젝트 루트: --project, git 최상위, 아니면 cwd', T, () => {
  const p = proj();
  const sub = path.join(p, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(projectRoot(sub), sub);
  execFileSync('git', ['init', '-q'], { cwd: p, windowsHide: true, env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(p) } });
  assert.equal(fs.realpathSync.native(projectRoot(sub)), p);
  assert.equal(projectRoot(sub, '..'), path.join(p, 'a'));
});

test('자료 폴더 표기는 프로젝트 기준 상대 경로', T, () => {
  const p = proj('.omc/progress-mon');
  assert.equal(dataLabel(resolveContext({ cwd: p, project: p })), '.omc/progress-mon/');
  assert.equal(dataLabel(resolveContext({ cwd: p, project: p, runtime: 'codex' })), '.omx/progress-mon/');
});

test('stages auto 는 events 가 있을 때만 10단계', T, () => {
  const cfg = defaults('/a');
  assert.equal(stagesFor(cfg, true).length, 10);
  assert.deepEqual(stagesFor(cfg, true)[0], ULTRA_STAGES[0]);
  assert.deepEqual(stagesFor(cfg, false), []);
  assert.deepEqual(stagesFor({ ...cfg, stages: [{ id: 'x' }, { id: 'y', label: '와이' }] }, true), [{ id: 'x', label: 'x' }, { id: 'y', label: '와이' }]);
});

test('events 경로: 상대 경로는 프로젝트 기준, auto 는 최신, null 은 없음', T, () => {
  const p = proj();
  const ctx = { project: p, runtime: 'claude' };
  const cfg = defaults(p);
  assert.equal(eventsPath({ ...cfg, sources: { ...cfg.sources, events: 'logs/ev.jsonl' } }, ctx), path.join(p, 'logs', 'ev.jsonl'));
  assert.equal(eventsPath({ ...cfg, sources: { ...cfg.sources, events: null } }, ctx), null);
  assert.equal(eventsPath(cfg, ctx), null);
  const old = path.join(p, '.omc', 'ultra-chain', 'r1', 'events.jsonl');
  const neu = path.join(p, '.omc', 'ultra-chain', 'r2', 'events.jsonl');
  for (const f of [old, neu]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
  }
  fs.utimesSync(old, new Date(2026, 0, 1), new Date(2026, 0, 1));
  fs.utimesSync(neu, new Date(2026, 0, 2), new Date(2026, 0, 2));
  assert.equal(eventsPath(cfg, ctx), neu);
  assert.equal(eventsPath(cfg, { project: p, runtime: 'codex' }), null);
});

// 링크를 만든다. 폴더는 Windows 에서 junction(권한 없이 됨). Windows 에서 파일 링크 권한(개발자 모드)이 없으면 거짓.
function link(target, p, type = 'file') {
  try {
    fs.symlinkSync(target, p, process.platform === 'win32' && type === 'dir' ? 'junction' : type);
    return true;
  } catch (e) {
    if (process.platform === 'win32' && e.code === 'EPERM') return false;
    throw e;
  }
}

test('resolveContext: 자료 폴더나 그 위 .omc, .omx 가 링크면 거부(링크를 따라 밖에 쓰지 않음)', T, () => {
  const out = path.join(ROOT, `out${++n}`);
  fs.mkdirSync(path.join(out, 'progress-mon'), { recursive: true });
  const a = proj();
  assert.ok(link(out, path.join(a, '.omc'), 'dir'));
  assert.throws(() => resolveContext({ cwd: a, project: a }), (e) => e instanceof UsageError && /\.omc 가 링크라 거부/.test(e.message));
  const b = proj('.omx');
  assert.ok(link(path.join(out, 'progress-mon'), path.join(b, '.omx', 'progress-mon'), 'dir'));
  assert.throws(() => resolveContext({ cwd: b, project: b, runtime: 'codex' }), /progress-mon 가 링크라 거부/);
  const c = proj();
  assert.ok(link(out, path.join(c, 'data'), 'dir'));
  assert.throws(() => resolveContext({ cwd: c, project: c, data: path.join(c, 'data') }), /링크라 거부/);
  assert.deepEqual(fs.readdirSync(out), ['progress-mon'], '밖 폴더는 그대로');
  const d = proj('.omc/progress-mon');
  assert.equal(resolveContext({ cwd: d, project: d }).exists, true, '링크가 없으면 그대로');
});

test('readRegular: 일반 파일만 읽고, 폴더와 특수 파일은 EINVAL, 상한을 넘으면 EFBIG', T, (t) => {
  const p = proj();
  const f = path.join(p, 'a.json');
  fs.writeFileSync(f, '{"a":1}');
  assert.equal(readRegular(f), '{"a":1}');
  assert.ok(Buffer.isBuffer(readRegular(f, null)));
  assert.throws(() => readRegular(p), { code: 'EINVAL' });
  assert.throws(() => readRegular(f, 'utf8', fs, 3), { code: 'EFBIG' });
  assert.throws(() => readRegular(path.join(p, 'none')), { code: 'ENOENT' });
  if (process.platform === 'win32') return t.diagnostic('FIFO 와 /dev/zero 는 POSIX 만');
  const fifo = path.join(p, 'events.jsonl');
  execFileSync('mkfifo', [fifo]);
  assert.throws(() => readRegular(fifo), { code: 'EINVAL' }, 'FIFO 는 열지 않음(열면 쓰는 쪽을 기다리며 멈춤)');
  assert.throws(() => readRegular('/dev/zero'), { code: 'EINVAL' }, '장치는 읽지 않음(끝없이 읽어 메모리를 다 씀)');
});

test('validate: commitRegex, agentLabelPattern 은 300자까지', T, () => {
  const long = `^(?<id>S\\d+)${'x'.repeat(300)}`;
  assert.match(validate({ commitRegex: long }, '/a').errors[0].msg, /300자를 넘음/);
  assert.match(validate({ agentLabelPattern: 'y'.repeat(301) }, '/a').errors[0].msg, /300자를 넘음/);
  assert.deepEqual(validate({ agentLabelPattern: 'y'.repeat(300) }, '/a').errors, []);
});
