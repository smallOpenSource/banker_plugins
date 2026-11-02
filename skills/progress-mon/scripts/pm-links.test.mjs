// 고정 이름 자리의 끊어진 링크(Windows 의 wx 는 따라가 그 너머에 파일을 만든다)와, 철자만 다른 같은 폴더(링크인 부모
// 폴더, 대소문자)의 판정. 임시 폴더만 쓴다.
// Run: node --test skills/progress-mon/scripts/pm-links.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock } from './pm-data.mjs';
import { takeStartLock } from './pm-server.mjs';
import { applyMemory, measureCodex, planMemory, ruleLine } from './pm-memory.mjs';
import { resolveContext, writeNew } from './pm-config.mjs';
// 이 계정이 심볼릭 링크를 만들 수 있는지(Windows 는 관리자나 개발자 모드). 못 만들면 링크 시험은 그 까닭으로 건너뜀.
// scripts/test-fixtures/can-symlink.mjs 와 같은 일을 여기서 한다: progress-mon 의 파일은 node: 와 ./ 만 가져온다(progress-mon.test.mjs AC-4).
const symlinkSkip = (() => {
  if (process.platform !== 'win32') return false;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'can-symlink-'));
  try {
    fs.writeFileSync(path.join(d, 't'), '');
    fs.symlinkSync(path.join(d, 't'), path.join(d, 'l'), 'file');
    return false;
  } catch {
    return 'this Windows account cannot make symbolic links (needs an elevated administrator or Developer Mode)';
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();


const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'progress-mon.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-links-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
// git 은 이 계정의 설정을 읽지 않게(이 파일의 git 호출과 자식 프로세스 모두)
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(ROOT, 'gitconfig-empty');
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
const ENV = { ...process.env, HOME: ROOT, USERPROFILE: ROOT };

let n = 0;
const dir = () => {
  const d = path.join(ROOT, `d${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
// 가리키는 것이 없는 링크. 대상은 폴더 밖 이름이라 생기면 밖에 파일이 생긴 것이다.
const dangling = (at, d) => {
  const target = path.join(d, `outside-${path.basename(at)}`);
  fs.symlinkSync(target, at, 'file');
  return target;
};
const S = { skip: symlinkSkip };

test('writeNew: 그 이름에 무엇이든(끊어진 링크 포함) 있으면 EEXIST, 링크 너머에 파일을 만들지 않음', S, () => {
  const d = dir();
  const at = path.join(d, 'x.lock');
  const target = dangling(at, d);
  assert.throws(() => writeNew(at, 'a'), { code: 'EEXIST' });
  assert.equal(fs.existsSync(target), false);
  const plain = path.join(d, 'y');
  writeNew(plain, 'b');
  assert.equal(fs.readFileSync(plain, 'utf8'), 'b');
  assert.throws(() => writeNew(plain, 'c'), { code: 'EEXIST' });
});

test('writeNew: 본 뒤 열기 전에 심은 링크로 만든 파일은 지우고 EEXIST', S, () => {
  const d = dir();
  const at = path.join(d, 'race.lock');
  const target = path.join(d, 'outside-race');
  // 열기(wx)가 링크를 따라간 것을 흉내: 열기 직전에 이름을 링크로 바꾸고, 열기는 대상에 만든다
  const fsx = {
    ...fs,
    openSync: (f, flags, ...a) => {
      if (f !== at || flags !== 'wx') return fs.openSync(f, flags, ...a);
      fs.symlinkSync(target, f, 'file');
      return fs.openSync(target, 'wx', ...a);
    },
  };
  assert.throws(() => writeNew(at, 'mine', {}, fsx), { code: 'EEXIST' });
  assert.equal(fs.existsSync(target), false, '따라가 만든 파일을 지움');
});

test('items.json 잠금: 끊어진 링크면 기다리지 않고 거부, 링크 너머에 파일 없음', S, async () => {
  const d = dir();
  const target = dangling(path.join(d, 'items.json.lock'), d);
  const t0 = Date.now();
  await assert.rejects(acquireLock(d, { waitMs: 3000 }), /잠금 자리에 일반 파일이 아닌 것\(링크나 폴더\)이 있어 거부/);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.equal(fs.existsSync(target), false);
});

test('items.json 정리 잠금: 끊어진 링크면 정리하지 않고, 링크 너머에 파일 없음', S, async () => {
  const d = dir();
  const lock = path.join(d, 'items.json.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483646, createdAt: '2000-01-01T00:00:00Z', token: 'x' }) + '\n');
  const target = dangling(`${lock}.break`, d);
  await assert.rejects(acquireLock(d, { waitMs: 400 }), /다른 쓰기가 끝나지 않음/);
  assert.equal(fs.existsSync(target), false);
  assert.ok(fs.existsSync(lock), '낡은 잠금은 정리 잠금을 못 잡아 그대로');
});

test('start 잠금: 끊어진 링크는 낡은 잠금으로 넘겨받아 일반 파일로 만듦, 링크 너머에 파일 없음', S, async () => {
  const d = dir();
  const lock = path.join(d, 'server.json.lock');
  const target = dangling(lock, d);
  const got = await takeStartLock(d, 3000);
  assert.equal(got, lock);
  assert.equal(fs.lstatSync(lock).isFile(), true);
  assert.equal(fs.existsSync(target), false);
  fs.rmSync(lock);
});

test('init: config.json 자리의 끊어진 링크는 거부(종료 1), 링크 너머에 파일 없음', S, () => {
  const p = dir();
  execFileSync('git', ['init', '-q'], { cwd: p, env: ENV, windowsHide: true });
  const data = path.join(p, '.omc', 'progress-mon');
  fs.mkdirSync(data, { recursive: true });
  const target = dangling(path.join(data, 'config.json'), p);
  const r = spawnSync(process.execPath, [CLI, 'init', '--memory', 'none'], { cwd: p, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /config\.json 자리에 가리키는 것이 없는 링크가 있어 거부/);
  assert.equal(fs.existsSync(target), false);
});

test('규칙 줄 백업: .progress-mon.bak 자리의 끊어진 링크는 거부하고 지시 파일을 바꾸지 않음', S, () => {
  const p = dir();
  const f = path.join(p, 'CLAUDE.md');
  const old = ruleLine('claude').replace(/adr\.json/g, 'old.json');
  fs.writeFileSync(f, `${old}\n`);
  const target = dangling(`${f}.progress-mon.bak`, p);
  const o = { kind: 'claude-md', project: p, runtime: 'claude' };
  let lines;
  try {
    lines = applyMemory(planMemory(o), p, ENV);
  } catch (e) {
    lines = [e.message];
  }
  assert.equal(fs.existsSync(target), false);
  if (fs.readFileSync(f, 'utf8') !== `${old}\n`) assert.fail(`지시 파일이 바뀜: ${lines.join(' | ')}`);
});

test('자료 폴더 링크 검사: --data 를 링크인 부모 폴더 철자로 줘도 프로젝트 안으로 보고 .omc 링크를 거부', S, () => {
  const real = dir();
  execFileSync('git', ['init', '-q'], { cwd: real, env: ENV, windowsHide: true });
  const elsewhere = dir();
  fs.symlinkSync(elsewhere, path.join(real, '.omc'), 'dir');
  const alias = path.join(ROOT, `alias${++n}`);
  fs.symlinkSync(real, alias, 'dir');
  assert.throws(() => resolveContext({ cwd: alias, data: path.join(alias, '.omc', 'progress-mon') }), /링크/);
});

test('Codex 지시 합계: 링크인 폴더 철자로 준 --project 도 저장소 루트부터 셈', S, () => {
  const real = dir();
  execFileSync('git', ['init', '-q'], { cwd: real, env: ENV, windowsHide: true });
  fs.mkdirSync(path.join(real, 'sub'));
  fs.writeFileSync(path.join(real, 'AGENTS.md'), 'a'.repeat(100));
  fs.writeFileSync(path.join(real, 'sub', 'AGENTS.md'), 'b'.repeat(10));
  const alias = path.join(ROOT, `alias${++n}`);
  fs.symlinkSync(real, alias, 'dir');
  assert.equal(measureCodex(path.join(alias, 'sub'), {}).total, 110);
});

test('자료 폴더 링크 검사: 프로젝트 루트 자체를 가리키는 안쪽 링크(.omc -> .)도 거부', S, () => {
  const real = dir();
  execFileSync('git', ['init', '-q'], { cwd: real, env: ENV, windowsHide: true });
  fs.symlinkSync(real, path.join(real, '.omc'), 'dir');
  assert.throws(() => resolveContext({ cwd: real }), /링크/);
});

test('writeNew: 연 뒤 이름이 사라졌으면 쓰지 않고 EEXIST, 쓰기가 실패하면 빈 파일을 지움', () => {
  const d = dir();
  const at = path.join(d, 'gone.lock');
  const gone = { ...fs, openSync: (f, flags, ...a) => { const fd = fs.openSync(f, flags, ...a); if (f === at) fs.rmSync(at); return fd; } };
  assert.throws(() => writeNew(at, 'x', {}, gone), { code: 'EEXIST' });
  const full = path.join(d, 'full.lock');
  const nospc = { ...fs, writeFileSync: (f, ...rest) => { if (typeof f === 'number') throw Object.assign(new Error('nospc'), { code: 'ENOSPC' }); return fs.writeFileSync(f, ...rest); } };
  assert.throws(() => writeNew(full, 'x', {}, nospc), { code: 'ENOSPC' });
  assert.equal(fs.existsSync(full), false, '빈 잠금이 남지 않음');
});

