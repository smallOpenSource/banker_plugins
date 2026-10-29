/*
 * banker.js CLI 유닛테스트 (node:test): telemetry 서브커맨드(US-08, count-default-on) + 비TTY setup 가드(US-6).
 * 카운팅은 opt-in 이 아니라 기본-on(default-on): off 는 opt-out 저장, on 은 opt-out 해제(기본값 복귀).
 * status 는 카운팅(countingActive)·업데이트-체크(noUpdateCheck) 양쪽 상태를 정직하게 표시한다.
 * 블랙박스로 실제 CLI 를 자식프로세스로 실행한다. stdin 은 파이프('' 입력)라 항상 비TTY 이며,
 * 프롬프트/고지 경로는 절대 진입하지 않는다(hang 불가) — 인터랙티브 TTY 경로(별 프롬프트·텔레메트리
 * 투명 고지)는 이 하네스로 재현 불가하므로 비TTY 가드만 검증한다.
 * XDG_CONFIG_HOME 임시 디렉터리로 실제 config 격리.
 * 파일명이 .test.mjs 라 package.json files[] 의 test 제외 글롭으로 배포에서 빠진다.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// banker.js 는 require.main 가드가 있어 import 해도 main 이 안 돌고 starRepo 만 노출한다(주입 spawn 으로 단위테스트).
const { starRepo } = createRequire(import.meta.url)('./banker.js');

const BANKER = fileURLToPath(new URL('./banker.js', import.meta.url));

function withXdg(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banker-cli-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function run(args, dir, extraEnv = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: dir };
  // The developer's own opt-outs would turn the default-state tests red; each test passes the ones it wants.
  for (const k of ['BANKER_NO_TELEMETRY', 'BANKER_NO_UPDATE_CHECK', 'BANKER_TELEMETRY_ENDPOINT']) delete env[k];
  Object.assign(env, extraEnv);
  // input:'' -> stdin is a closed pipe (never a TTY); timeout guards against any accidental hang.
  const r = spawnSync(process.execPath, [BANKER, ...args], { encoding: 'utf8', input: '', env, timeout: 20000 });
  return { out: `${r.stdout || ''}${r.stderr || ''}`, code: r.status, r };
}
const cfgPath = (dir) => path.join(dir, 'banker', 'config.json');
const readCfg = (dir) => JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8'));
const updateCachePath = (dir) => path.join(dir, 'banker', 'update-check.json');
const writeUpdateCacheFixture = (dir, obj) => {
  fs.mkdirSync(path.join(dir, 'banker'), { recursive: true });
  fs.writeFileSync(updateCachePath(dir), JSON.stringify(obj));
};

test('telemetry status 기본값: 카운팅 enabled(내장 기본 엔드포인트) · opt-out 미적용 · 업데이트체크 캐시 없음', () => withXdg((dir) => {
  const { out, code } = run(['telemetry', 'status'], dir);
  assert.strictEqual(code, 0);
  assert.match(out, /엔드포인트 설정: 설정됨/);
  assert.match(out, /opt-out\(BANKER_NO_TELEMETRY\): 미적용/);
  assert.match(out, /opt-out\(config\.telemetry=false\): 미적용/);
  assert.match(out, /실효 상태\(effective\): enabled/);
  assert.match(out, /opt-out\(BANKER_NO_UPDATE_CHECK\/config\.updateCheck=false\): 미적용/);
  assert.match(out, /마지막 체크: 없음/);
  assert.match(out, /캐시된 최신 버전: 없음/);
  assert.ok(!fs.existsSync(cfgPath(dir)), 'status 는 read-only: config 를 만들지 않는다');
}));

test('status: config.telemetry=false 가 카운팅 opt-out 을 정직히 반영', () => withXdg((dir) => {
  run(['telemetry', 'off'], dir);
  const { out } = run(['telemetry', 'status'], dir, { BANKER_TELEMETRY_ENDPOINT: 'https://env.test/c' });
  assert.match(out, /opt-out\(config\.telemetry=false\): 적용됨/);
  assert.match(out, /실효 상태\(effective\): disabled/);
}));

test('status: BANKER_NO_UPDATE_CHECK opt-out 을 정직히 반영', () => withXdg((dir) => {
  const { out } = run(['telemetry', 'status'], dir, { BANKER_NO_UPDATE_CHECK: '1' });
  assert.match(out, /opt-out\(BANKER_NO_UPDATE_CHECK\/config\.updateCheck=false\): 적용됨/);
}));

test('status: 업데이트-체크 캐시 반영 (마지막 체크 시각 · 캐시 latest vs 설치버전 · 업데이트 있음)', () => withXdg((dir) => {
  const checkedAt = 1700000000000;
  writeUpdateCacheFixture(dir, { latest: '999.0.0', checkedAt });
  const { out } = run(['telemetry', 'status'], dir);
  assert.ok(out.includes(new Date(checkedAt).toISOString()), '마지막 체크 시각이 ISO 로 출력되어야 한다');
  assert.match(out, /캐시된 최신 버전: 999\.0\.0/);
  assert.match(out, /업데이트 있음/);
}));

test('status: 지금보다 뒤의 시도 시각은 하루를 쉰다고 하지 않고 다음 세션에 다시 시도한다고 한다', () => withXdg((dir) => {
  const triedAt = Date.now() + 10 * 24 * 3600000;                           // 시계를 되돌린 PC
  writeUpdateCacheFixture(dir, { triedAt });
  const { out, code } = run(['telemetry', 'status'], dir);
  assert.equal(code, 0);
  assert.match(out, /마지막 시도: [^\n]*\(실패\. 시각이 지금보다 뒤라 다음 세션 시작에 다시 시도합니다\)/, out);
  assert.doesNotMatch(out, /그 뒤 24시간은 다시 시도하지 않습니다/, out);
}));

test('status: 마지막으로 실패한 시도는 마지막 체크와 따로 보인다', () => withXdg((dir) => {
  const checkedAt = 1700000000000;
  const triedAt = checkedAt + 3600000;
  writeUpdateCacheFixture(dir, { latest: '999.0.0', checkedAt, triedAt });
  const { out, code } = run(['telemetry', 'status'], dir);
  assert.equal(code, 0);
  assert.ok(out.includes(`마지막 시도: ${new Date(triedAt).toISOString()}`), out);
  assert.match(out, /마지막 시도: [^\n]*실패/);
  writeUpdateCacheFixture(dir, { latest: '999.0.0', checkedAt: triedAt + 1, triedAt });
  assert.doesNotMatch(run(['telemetry', 'status'], dir).out, /마지막 시도:/, '그 뒤에 성공했으면 보이지 않는다');
  writeUpdateCacheFixture(dir, { checkedAt: 1e20, triedAt: 8.64e15 + 1 });     // 날짜로 바꿀 수 없는 값
  assert.equal(run(['telemetry', 'status'], dir).code, 0, '깨진 시각에도 멈추지 않는다');
  writeUpdateCacheFixture(dir, { triedAt });                                // 확인에 성공한 적이 없는 캐시
  const tried = run(['telemetry', 'status'], dir).out;
  assert.match(tried, /비교 불가 \(확인에 성공한 적이 없어 최신 버전 정보 없음\)/, tried);
  assert.doesNotMatch(tried, /캐시 없음 또는 malformed/, '캐시는 있고 깨지지 않았다');
  writeUpdateCacheFixture(dir, null);                                       // 객체가 아닌 JSON
  assert.equal(run(['telemetry', 'status'], dir).code, 0, 'null 캐시에도 멈추지 않는다');
}));

test('status: 업데이트-체크 캐시 자리가 FIFO 여도 기다리지 않는다', { skip: process.platform === 'win32' && 'Windows 에는 FIFO 가 없다' }, () => withXdg((dir) => {
  fs.mkdirSync(path.join(dir, 'banker'), { recursive: true });
  assert.strictEqual(spawnSync('mkfifo', [updateCachePath(dir)]).status, 0, 'mkfifo');
  const { out, code, r } = run(['telemetry', 'status'], dir);
  assert.strictEqual(r.signal, null, '명령이 스스로 끝났다');
  assert.strictEqual(code, 0);
  assert.match(out, /비교 불가/, '캐시를 읽지 못하면 비교하지 않는다');
}));

test('telemetry on (기본 상태) -> opt-out 해제 확인 (내장 기본 엔드포인트라 미설정 안내 없음)', () => withXdg((dir) => {
  const { out, code } = run(['telemetry', 'on'], dir);
  assert.strictEqual(code, 0);
  assert.strictEqual(readCfg(dir).telemetry, undefined);
  assert.match(out, /해제했습니다 \(on\)/);
  assert.ok(!/엔드포인트가 설정되어 있지 않아/.test(out), '내장 기본 엔드포인트가 있으므로 미설정 안내는 출력하지 않는다');
}));

test('telemetry off -> config telemetry:false (opt-out)', () => withXdg((dir) => {
  run(['telemetry', 'on'], dir);
  const { out } = run(['telemetry', 'off'], dir);
  assert.strictEqual(readCfg(dir).telemetry, false);
  assert.match(out, /껐습니다 \(off\)/);
}));

test('telemetry on 은 기존 config 키를 보존하며 opt-out 을 해제한다 (spread merge)', () => withXdg((dir) => {
  fs.mkdirSync(path.join(dir, 'banker'), { recursive: true });
  fs.writeFileSync(cfgPath(dir), JSON.stringify({ endpoint: 'https://keep.test/c', foo: 1, telemetry: false }));
  run(['telemetry', 'on'], dir);
  assert.deepStrictEqual(readCfg(dir), { endpoint: 'https://keep.test/c', foo: 1 });
}));

test('status: opt-out 해제 + 엔드포인트(env) 설정 시 effective enabled', () => withXdg((dir) => {
  run(['telemetry', 'on'], dir);
  const { out } = run(['telemetry', 'status'], dir, { BANKER_TELEMETRY_ENDPOINT: 'https://env.test/c' });
  assert.match(out, /엔드포인트 설정: 설정됨/);
  assert.match(out, /실효 상태\(effective\): enabled/);
}));

test('status: BANKER_NO_TELEMETRY opt-out 이 실효를 disabled 로 강제', () => withXdg((dir) => {
  run(['telemetry', 'on'], dir);
  const { out } = run(['telemetry', 'status'], dir, {
    BANKER_TELEMETRY_ENDPOINT: 'https://env.test/c', BANKER_NO_TELEMETRY: '1',
  });
  assert.match(out, /opt-out\(BANKER_NO_TELEMETRY\): 적용됨/);
  assert.match(out, /실효 상태\(effective\): disabled/);
}));

test('알 수 없는/누락 하위명령 -> 사용법 출력', () => withXdg((dir) => {
  assert.match(run(['telemetry', 'bogus'], dir).out, /Usage: banker telemetry <on\|off\|status>/);
  assert.match(run(['telemetry'], dir).out, /Usage: banker telemetry <on\|off\|status>/);
}));

test('비TTY setup --claude --dry-run: hang·프롬프트·고지·persist 없이 done', () => withXdg((dir) => {
  const { out, code } = run(['setup', '--claude', '--dry-run'], dir);
  assert.strictEqual(code, 0);
  assert.match(out, /done\./);
  assert.ok(!/GitHub 별/.test(out) && !/익명 사용량 카운트/.test(out), '비TTY 는 프롬프트·고지 금지');
  assert.ok(!fs.existsSync(cfgPath(dir)), '비TTY/dry-run 은 config 를 쓰지 않는다');
}));

test('비TTY setup --codex --scope project --dry-run: config 미기록', () => withXdg((dir) => {
  const { out, code } = run(['setup', '--codex', '--scope', 'project', '--dry-run'], dir);
  assert.strictEqual(code, 0);
  assert.match(out, /done\./);
  assert.ok(!fs.existsSync(cfgPath(dir)), '비TTY/dry-run 은 config 를 쓰지 않는다');
}));

test('help 에 telemetry 서브커맨드가 문서화됨', () => withXdg((dir) => {
  assert.match(run(['help'], dir).out, /banker telemetry <on\|off\|status>/);
}));

// ---- starRepo (Y = 실제 GitHub star; gh CLI 인증 사용) ----

test('starRepo: gh 미설치면 {ok:false} + PUT 시도 안 함', () => {
  const seen = [];
  const spawn = (_cmd, args) => { seen.push(args.join(' ')); return { error: new Error('ENOENT'), status: null }; };
  const r = starRepo(spawn);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /gh CLI 없음/);
  assert.strictEqual(seen.length, 1, 'gh --version 만 시도(star PUT 없음)');
  assert.match(seen[0], /--version/);
});

test('starRepo: gh 있고 PUT 성공이면 {ok:true} + 올바른 star 엔드포인트', () => {
  const seen = [];
  const spawn = (_cmd, args) => { seen.push(args); return { status: 0 }; };
  const r = starRepo(spawn);
  assert.strictEqual(r.ok, true);
  const put = seen.find((a) => a.includes('PUT'));
  assert.ok(put, 'PUT 요청이 있었다');
  assert.ok(put.join(' ').includes('/user/starred/smallOpenSource/banker_plugins'), 'star API 경로 정확');
});

test('starRepo: PUT 실패(status!=0)면 {ok:false, reason=stderr 첫 줄}', () => {
  const spawn = (_cmd, args) => (args.includes('--version') ? { status: 0 } : { status: 1, stderr: 'gh: HTTP 401: Bad credentials\n(더 있음)' });
  const r = starRepo(spawn);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /401|Bad credentials/);
  assert.ok(!/\n/.test(r.reason), 'reason 은 첫 줄만');
});

test('starRepo: PUT 단계 error(타임아웃 등)면 {ok:false, reason=error.message}', () => {
  const spawn = (_cmd, args) => (args.includes('--version') ? { status: 0 } : { error: new Error('ETIMEDOUT') });
  const r = starRepo(spawn);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /ETIMEDOUT/);
});

test('starRepo: PUT non-zero 인데 stderr 없으면 reason=`gh exited N`', () => {
  const spawn = (_cmd, args) => (args.includes('--version') ? { status: 0 } : { status: 7, stderr: '', stdout: '' });
  const r = starRepo(spawn);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /gh exited 7/);
});

// 0.20.5 (final batch deferred row 13): a try time ahead of now does not count as rest, but a last check less than a day
// old still makes the hook rest (updateCheckDue). status says when the next try comes by that same rule.
test('status: 시도 시각이 지금보다 뒤여도 하루가 안 된 마지막 체크가 쉬게 하면 다음 세션에 다시 시도한다고 하지 않는다', async () => {
  const { updateCheckDue } = await import('./lib/telemetry-config.mjs');
  const hour = 3600000;
  for (const checkedAt of [undefined, Date.now() - hour, Date.now() - 25 * hour]) {
    withXdg((dir) => {
      const cache = { latest: '999.0.0', checkedAt, triedAt: Date.now() + 10 * 24 * hour };
      writeUpdateCacheFixture(dir, cache);
      const { out, code } = run(['telemetry', 'status'], dir);
      assert.equal(code, 0);
      assert.equal(/다음 세션 시작에 다시 시도합니다/.test(out), updateCheckDue(cache), `${checkedAt}: ${out}`);
      if (!updateCheckDue(cache)) {
        assert.match(out, /마지막 시도: [^\n]*\(실패\. 시각이 지금보다 뒤라 쉼으로 세지 않지만, 마지막 체크에서 24시간이 지나야 다시 시도합니다\)/, out);
      }
    });
  }
});

test('doctor: the newest Codex record is checked for what banker reads, and a shape it cannot read is flagged', () => withXdg((dir) => {
  const day = path.join(dir, 'codex', 'sessions', '2026', '10', '28');
  fs.mkdirSync(day, { recursive: true });
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'x', cli_version: '9.9.9' } });
  fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), `${meta}\n{"type":"event_msg","payload":{"type":"task_started","turn_id":"t"}}\n{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}\n`);
  let { out } = run(['doctor'], dir, { CODEX_HOME: path.join(dir, 'codex') });
  assert.match(out, /Codex record shape \(Codex 9\.9\.9, rollout-a\.jsonl\): turn start ok, user text ok, tool calls MISSING/);
  assert.doesNotMatch(out, /may not read/);
  fs.writeFileSync(path.join(day, 'rollout-b.jsonl'), `${meta}\n{"type":"event_msg","payload":{"type":"turn_begun_v2"}}\n{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}\n`);
  ({ out } = run(['doctor'], dir, { CODEX_HOME: path.join(dir, 'codex') }));
  assert.match(out, /rollout-b\.jsonl\): turn start MISSING, user text ok/);
  assert.match(out, /banker may not read this Codex version's records/, 'user text with no turn start');
  fs.writeFileSync(path.join(day, 'rollout-b2.jsonl'), `${meta}\n{"type":"event_msg","payload":{"type":"turn_begun_v2"}}\n{"type":"response_item","payload":{"type":"function_call","name":"x"}}\n`);
  ({ out } = run(['doctor'], dir, { CODEX_HOME: path.join(dir, 'codex') }));
  assert.match(out, /rollout-b2\.jsonl\): turn start MISSING, user text MISSING, tool calls ok/);
  assert.match(out, /banker may not read this Codex version's records/, 'tool calls with no turn start');
  fs.writeFileSync(path.join(day, 'rollout-b3.jsonl'), `${meta}\n{"type":"event_msg","payload":{"type":"thread_settings_applied"}}\n{"type":"world_state"}\n`);
  ({ out } = run(['doctor'], dir, { CODEX_HOME: path.join(dir, 'codex') }));
  assert.match(out, /rollout-b3\.jsonl holds no turn yet/);
  assert.doesNotMatch(out, /may not read/, 'several lines but no turn, no text and no tool call yet: no warning');
  fs.writeFileSync(path.join(day, 'rollout-c.jsonl'), `${meta}\n`);
  ({ out } = run(['doctor'], dir, { CODEX_HOME: path.join(dir, 'codex') }));
  assert.match(out, /rollout-c\.jsonl holds no turn yet/);
  assert.doesNotMatch(out, /may not read/, 'a session just opened is no shape change');
  fs.writeFileSync(path.join(day, 'rollout-d.jsonl'), 'x'.repeat((8 << 20) + 10));
  ({ out } = run(['doctor'], dir, { CODEX_HOME: path.join(dir, 'codex') }));
  assert.match(out, /rollout-d\.jsonl opens with a line over 8 MB, not checked/);
  fs.writeFileSync(path.join(day, 'rollout-e.jsonl'), '가'.repeat(2 << 20));
  ({ out } = run(['doctor'], dir, { CODEX_HOME: path.join(dir, 'codex') }));
  assert.doesNotMatch(out, /rollout-e\.jsonl opens with a line over 8 MB/, '6 MB of bytes in 2 M characters is under 8 MB');
}));

test('doctor: a Codex home inside this folder, other than its top .codex, is flagged', () => withXdg((dir) => {
  const work = path.join(dir, 'work');
  fs.mkdirSync(path.join(work, 'deep', '.codex'), { recursive: true });
  const doctorIn = (home) => {
    const env = { ...process.env, XDG_CONFIG_HOME: dir, CODEX_HOME: home, BANKER_NO_UPDATE_CHECK: '1', BANKER_NO_TELEMETRY: '1' };
    const r = spawnSync(process.execPath, [BANKER, 'doctor'], { cwd: work, encoding: 'utf8', input: '', env, timeout: 20000 });
    return `${r.stdout || ''}${r.stderr || ''}`;
  };
  assert.match(doctorIn(path.join(work, 'deep', '.codex')), /⚠ the Codex home .*deep.* is inside this folder \(not its top \.codex\)/);
  assert.doesNotMatch(doctorIn(path.join(work, '.codex')), /is inside this folder/);
  assert.doesNotMatch(doctorIn(path.join(dir, 'other')), /is inside this folder/);
}));
