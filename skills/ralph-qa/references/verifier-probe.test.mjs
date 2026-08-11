/*
 * verifier-probe 유닛 테스트 (node:test + node:assert, 의존성 0). 파일명이 .test.mjs 라 배포에서 제외된다.
 *
 * 네트워크에 나가지 않는다 — 모든 HTTP 는 이 프로세스가 띄운 node:http 스텁 서버가 받는다.
 * 실제 호스트명·API 키 리터럴은 이 파일에 없다. 루프백 주소만 있고(스텁 서버를 자기 머신에 묶는
 * 용도), 키 자리에는 테스트용 sentinel 문자열이 들어간다.
 *
 * HOME 을 mkdtemp 로 격리해 ~/.codex/config.toml 을 픽스처로 갈아끼우고, PATH 를 스텁 디렉터리로
 * 바꿔 CLI 존재 여부를 결정론적으로 만든다. 상속된 실환경 env(프로바이더 키·런타임 신호)는 전부
 * 지운다 — 안 지우면 이 머신에서만 통과하는 테스트가 된다.
 *
 * 프로브는 자식 프로세스로 async spawn 한다. spawnSync 는 이벤트 루프를 막아 in-process 스텁 서버와
 * 데드락한다(hooks/update-checkin.test.mjs 가 같은 이유로 async spawn 을 쓴다).
 *
 * 케이스는 계획 §5 의 U1-a ~ U1-k 11개 + gemini 크리덴셜 좌석(U1-l)·base URL 해석 순서(U1-m) 2개
 * + 송신 게이트 3개다: --external=off 요청 0건(U1-n)·기본 엔드포인트 옵트아웃(U1-o)·401 재시도 게이트(U1-p).
 * 여기에 외부 좌석끼리의 모델 중복 회피 5개(U1-q ~ U1-u)가 붙는다 — 파일 끝의 블록 주석 참조.
 *
 * 송신 게이트 셋은 응답 모양이 아니라 **스텁이 요청을 받았는가**로 판정한다. 요청을 내 놓고 결과만
 * 버리는 구현은 출력이 똑같아서, 출력만 보는 단언으로는 잡히지 않는다.
 *
 * 해석 단계(resolveApi·resolveGeminiApi)는 자식 프로세스가 아니라 in-process 로 부른다. 상수 기본
 * base URL 로 내려가는 경로는 정의상 실 엔드포인트를 향하므로 스텁으로 가리킬 수 없고, 그 경로를
 * 자식 프로세스로 돌리면 유닛 테스트가 네트워크에 나간다. 해석은 여기서, 좌석 게이트는 스텁 e2e 로
 * 나눠 잠근다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveApi, resolveGeminiApi, probeModels, isExplicitSource,
  DEFAULT_OPENAI_BASE_URL, DEFAULT_GEMINI_BASE_URL, GEMINI_BASE_URL_ENV, NO_DEFAULT_ENDPOINT_ENV,
} from './verifier-probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, 'verifier-probe.mjs');
const PROBE_SRC = readFileSync(PROBE, 'utf8');

// 스텁 서버를 루프백에 묶는다. 외부 호스트가 아니라 이 프로세스 자신의 주소다.
const LOOPBACK = '127.0.0.1';
const IS_WIN = process.platform === 'win32';

// 프로브가 절대 출력하면 안 되는 키 값(U1-e). 다른 케이스에서도 같은 값을 키 자리에 쓴다.
const SENTINEL = 'SENTINEL_DO_NOT_LEAK_9f3a';
const KEY_ENV_NAME = 'RALPH_QA_TEST_KEY';

const servers = [];
const sockets = [];
const tmps = [];

after(() => {
  for (const socket of sockets) { try { socket.destroy(); } catch { /* 이미 닫힘 */ } }
  for (const server of servers) { try { server.close(); } catch { /* 이미 닫힘 */ } }
  for (const dir of tmps) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

function mkTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(dir);
  return dir;
}

// ── 스텁 서버 ────────────────────────────────────────────────────────────────────────────────

function startServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      // 인증 헤더까지 기록한다 — "키가 몇 번, 어떤 헤더로 나갔는가"가 재시도 게이트의 판정 대상이다.
      requests.push({
        method: req.method,
        url: req.url,
        auth: { authorization: req.headers.authorization || null, apiKey: req.headers['api-key'] || null },
      });
      handler(req, res);
    });
    server.on('connection', (socket) => sockets.push(socket));
    servers.push(server);
    server.listen(0, LOOPBACK, () => {
      const root = 'http://' + LOOPBACK + ':' + server.address().port;
      // base = OpenAI 호환 좌석용(경로에 /v1 이 붙는다) · root = gemini 크리덴셜 좌석용(경로를
      // 프로브가 /v1beta/models 로 조립하므로 base 에 경로를 미리 붙이지 않는다).
      resolve({ server, requests, root, base: root + '/v1' });
    });
  });
}

const catalogHandler = (ids) => (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: ids.map((id) => ({ id, object: 'model' })) }));
};

const statusHandler = (code) => (_req, res) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end('{}');
};

// 응답을 주지 않는 스텁. 타이머는 unref 해서 테스트 프로세스를 붙잡지 않는다.
const hangHandler = () => (_req, res) => {
  const timer = setTimeout(() => { try { res.end('{}'); } catch { /* 이미 끊김 */ } }, 5000);
  if (typeof timer.unref === 'function') timer.unref();
};

// 확실히 닫힌 포트를 얻는다(연결 거부 경로 검증용).
async function closedPortBase() {
  const { server, base } = await startServer(statusHandler(200));
  await new Promise((resolve) => server.close(resolve));
  return base;
}

// ── 픽스처 ───────────────────────────────────────────────────────────────────────────────────

function writeCodexConfig(home, { provider, baseUrl, envKey, model } = {}) {
  mkdirSync(join(home, '.codex'), { recursive: true });
  const lines = [];
  if (provider) lines.push('model_provider = "' + provider + '"');
  if (model) lines.push('model = "' + model + '"');
  lines.push('');
  if (provider) {
    lines.push('[model_providers.' + provider + ']');
    lines.push('name = "Test Provider"');
    if (baseUrl) lines.push('base_url = "' + baseUrl + '"');
    if (envKey) lines.push('env_key = "' + envKey + '"');
  }
  writeFileSync(join(home, '.codex', 'config.toml'), lines.join('\n') + '\n');
}

// 셸을 띄우지 않는 PATH 스텁. POSIX 는 실행 비트를, Windows 는 PATHEXT 확장자를 맞춘다.
function writeStub(dir, name, { marker } = {}) {
  mkdirSync(dir, { recursive: true });
  if (IS_WIN) {
    const body = marker
      ? '@echo off\r\ntype nul > "' + marker + '"\r\nexit /b 0\r\n'
      : '@echo off\r\nexit /b 0\r\n';
    writeFileSync(join(dir, name + '.CMD'), body);
    return;
  }
  const body = marker
    ? '#!/bin/sh\ntouch "' + marker + '"\nexit 0\n'
    : '#!/bin/sh\nexit 0\n';
  const target = join(dir, name);
  writeFileSync(target, body);
  chmodSync(target, 0o755);
}

// 버전 프로브에서 떨어지는 python3 스텁(3.6 미만 취급).
function writeFailingStub(dir, name) {
  mkdirSync(dir, { recursive: true });
  if (IS_WIN) {
    writeFileSync(join(dir, name + '.CMD'), '@echo off\r\nexit /b 1\r\n');
    return;
  }
  const target = join(dir, name);
  writeFileSync(target, '#!/bin/sh\nexit 1\n');
  chmodSync(target, 0o755);
}

// curl 만 있는 기본 PATH — 대부분의 케이스는 transport 를 변수로 두지 않는다.
let defaultPathDir = null;
function curlOnlyPath() {
  if (!defaultPathDir) {
    defaultPathDir = join(mkTmp('probe-path-'), 'bin');
    writeStub(defaultPathDir, 'curl');
  }
  return defaultPathDir;
}

// 상속된 실환경 신호를 끊은 결정론 env. runtime 은 기본적으로 Claude Code 로 고정한다.
const STRIPPED = [
  'RALPH_QA_BASE_URL', 'OPENAI_BASE_URL', 'RALPH_QA_API_KEY', 'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY', 'RALPH_QA_PROBE_TIMEOUT_MS', 'RALPH_QA_FAMILY_MAP',
  'CODEX_HOME', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_MANAGED_BY_NPM',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PLUGIN_ROOT',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GOOGLE_CLOUD_API_KEY',
  // 안 지우면 상속된 값 때문에 프로브가 실 엔드포인트로 나간다(= 유닛 테스트가 네트워크를 탄다).
  GEMINI_BASE_URL_ENV,
  // 이게 상속돼 있으면 기본 엔드포인트 폴백이 꺼진 채로 도는 테스트가 되어, 옵트아웃 케이스가
  // 실제로 무엇을 바꾸는지 아무것도 증명하지 못한다.
  NO_DEFAULT_ENDPOINT_ENV,
  KEY_ENV_NAME,
];

function probeEnv(home, extra = {}) {
  const env = { ...process.env };
  for (const name of STRIPPED) delete env[name];
  env.HOME = home;
  env.USERPROFILE = home;
  env.PATH = curlOnlyPath();
  if (IS_WIN) env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  env.CLAUDECODE = '1'; // 저자 계열 런타임 도출을 고정한다(U1-i 는 이걸 지우고 본다).
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

function runProbe(env, args = ['--json']) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROBE, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* 파싱 실패는 단언에서 드러난다 */ }
      resolve({ code, stdout, stderr, json });
    });
  });
}

// 살아있는 프로바이더 한 벌: 스텁 서버 + config + 키 env.
async function liveSetup(ids, extraEnv = {}) {
  const stub = await startServer(catalogHandler(ids));
  const home = mkTmp('probe-home-');
  writeCodexConfig(home, { provider: 'testprov', baseUrl: stub.base, envKey: KEY_ENV_NAME });
  const env = probeEnv(home, { [KEY_ENV_NAME]: SENTINEL, ...extraEnv });
  return { stub, home, env };
}

// ── U1-a: T2 생존 판정 사다리 ────────────────────────────────────────────────────────────────

test('U1-a: T2 상태코드가 live 와 사유로 정확히 갈린다 (200/401/404/refused)', async () => {
  const ok = await liveSetup(['gpt-test-a', 'claude-test-a']);
  const okRun = await runProbe(ok.env);
  assert.equal(okRun.code, 0);
  assert.equal(okRun.json.observed.api.status, 200);
  assert.equal(okRun.json.observed.api.live, true);
  assert.equal(okRun.json.observed.api.reason, null);
  // 프로브는 GET 만 낸다 — 모델 호출(POST)이 0회임을 스텁이 받은 요청으로 확인한다.
  assert.ok(ok.stub.requests.length > 0, '스텁이 요청을 받아야 한다');
  for (const req of ok.stub.requests) {
    assert.equal(req.method, 'GET');
    assert.ok(req.url.endsWith('/models'), '요청 경로는 /models 여야 한다: ' + req.url);
  }

  for (const [code, reason] of [[401, 'dead-credential'], [404, 'route-missing']]) {
    const stub = await startServer(statusHandler(code));
    const home = mkTmp('probe-home-');
    writeCodexConfig(home, { provider: 'testprov', baseUrl: stub.base, envKey: KEY_ENV_NAME });
    const run = await runProbe(probeEnv(home, { [KEY_ENV_NAME]: SENTINEL }));
    assert.equal(run.json.observed.api.status, code, 'status ' + code);
    assert.equal(run.json.observed.api.live, false);
    assert.equal(run.json.observed.api.reason, reason);
  }

  const deadBase = await closedPortBase();
  const deadHome = mkTmp('probe-home-');
  writeCodexConfig(deadHome, { provider: 'testprov', baseUrl: deadBase, envKey: KEY_ENV_NAME });
  const refused = await runProbe(probeEnv(deadHome, { [KEY_ENV_NAME]: SENTINEL }));
  assert.equal(refused.json.observed.api.live, false);
  assert.equal(refused.json.observed.api.reason, 'unreachable');
  assert.equal(refused.json.observed.api.status, 0);
});

// ── U1-b: 하드 타임아웃 ──────────────────────────────────────────────────────────────────────

test('U1-b: 응답 없는 엔드포인트에서 timeout 으로 끊고 hang 하지 않는다', async () => {
  const stub = await startServer(hangHandler());
  const home = mkTmp('probe-home-');
  writeCodexConfig(home, { provider: 'testprov', baseUrl: stub.base, envKey: KEY_ENV_NAME });
  const startedAt = Date.now();
  const run = await runProbe(probeEnv(home, { [KEY_ENV_NAME]: SENTINEL, RALPH_QA_PROBE_TIMEOUT_MS: 200 }));
  const elapsed = Date.now() - startedAt;
  assert.equal(run.code, 0);
  assert.equal(run.json.observed.api.reason, 'timeout');
  assert.equal(run.json.observed.api.live, false);
  assert.ok(elapsed < 5000, '타임아웃 후 즉시 종료해야 한다 (elapsed=' + elapsed + 'ms)');
});

// ── U1-c: T3 계열 필터 ───────────────────────────────────────────────────────────────────────

test('U1-c: 저자 계열은 후보에서 제외된다 (계열 필터 로직의 회귀 잠금)', async () => {
  const { env } = await liveSetup(['claude-test-a', 'claude-test-b', 'gpt-test-a', 'gpt-test-b']);
  const run = await runProbe(env, ['--json', '--author-family', 'claude']);
  const candidates = run.json.observed.candidates;
  assert.equal(candidates.filter((row) => row.family === 'claude').length, 0, 'claude 후보 0건');
  assert.ok(candidates.some((row) => row.family === 'gpt'), 'gpt 후보는 남아야 한다');
  assert.equal(run.json.observed.candidateCount, 2);
  assert.equal(run.json.observed.api.live, true);
});

// ── U1-d: 후보 고갈 ──────────────────────────────────────────────────────────────────────────

test('U1-d: 카탈로그가 저자 계열뿐이면 API 좌석이 no-independent-model 로 무효다', async () => {
  const { env } = await liveSetup(['claude-test-a', 'claude-test-b']);
  const run = await runProbe(env, ['--json', '--author-family', 'claude']);
  assert.equal(run.json.observed.api.live, false);
  assert.equal(run.json.observed.api.reason, 'no-independent-model');
  assert.equal(run.json.observed.external.api.valid, false);
  assert.equal(run.json.observed.external.api.reason, 'no-independent-model');
  assert.equal(run.json.declared.seats.external.length, 0);
  assert.equal(run.json.declared.externalAbsentReason, 'no-independent-model');
});

// ── U1-e: 시크릿 미출력 ──────────────────────────────────────────────────────────────────────

test('U1-e: 키 값이 stdout/stderr 어디에도 나오지 않는다 (키 이름만 출력)', async () => {
  const live = await liveSetup(['gpt-test-a']);
  const okRun = await runProbe(live.env);
  assert.equal(okRun.stdout.includes(SENTINEL), false, 'stdout 에 키 값 노출');
  assert.equal(okRun.stderr.includes(SENTINEL), false, 'stderr 에 키 값 노출');
  assert.equal((okRun.stdout + okRun.stderr).includes(SENTINEL), false);
  assert.equal(okRun.json.observed.api.keyEnv, KEY_ENV_NAME, '키 이름은 출력한다');

  // 실패 경로도 본다 — 오류 메시지에 요청 정보를 실어 새는 경우가 흔하다.
  const stub = await startServer(statusHandler(401));
  const home = mkTmp('probe-home-');
  writeCodexConfig(home, { provider: 'testprov', baseUrl: stub.base, envKey: KEY_ENV_NAME });
  const failRun = await runProbe(probeEnv(home, { [KEY_ENV_NAME]: SENTINEL }));
  assert.equal((failRun.stdout + failRun.stderr).includes(SENTINEL), false, '실패 경로에서 키 값 노출');
});

// ── U1-f: T1 provider 해석 ───────────────────────────────────────────────────────────────────

test('U1-f: config.toml 에서 base_url·env_key 를 뽑고, model_provider 가 없으면 source:none 이다', async () => {
  const stub = await startServer(catalogHandler(['gpt-test-a']));
  const home = mkTmp('probe-home-');
  writeCodexConfig(home, { provider: 'testprov', baseUrl: stub.base, envKey: KEY_ENV_NAME });
  const run = await runProbe(probeEnv(home, { [KEY_ENV_NAME]: SENTINEL }));
  assert.equal(run.json.observed.api.source, 'codex:testprov');
  assert.equal(run.json.observed.api.baseUrl, stub.base);
  assert.equal(run.json.observed.api.keyEnv, KEY_ENV_NAME);
  assert.equal(run.json.observed.api.configured, true);

  // model_provider 가 없는 config + base_url env 폴백도 없음 → 미구성.
  const bare = mkTmp('probe-home-');
  writeCodexConfig(bare, {});
  const bareRun = await runProbe(probeEnv(bare));
  assert.equal(bareRun.json.observed.api.source, 'none');
  assert.equal(bareRun.json.observed.api.configured, false);
  assert.equal(bareRun.json.observed.api.baseUrl, null);
  assert.equal(bareRun.json.observed.external.api.valid, false);
});

// ── U1-g: 미지 계열 fail-closed ──────────────────────────────────────────────────────────────

test('U1-g: 미분류 id 는 후보에서 제외되고 unclassified 로 계수된다', async () => {
  const mixed = await liveSetup(['gpt-test-a', 'zeta-one', 'vector-store-77', 'my-thing-x', 'claude-test-a']);
  const run = await runProbe(mixed.env, ['--json', '--author-family', 'claude']);
  assert.equal(run.json.observed.unclassified, 3);
  const ids = run.json.observed.candidates.map((row) => row.id);
  assert.deepEqual(ids, ['gpt-test-a'], '미분류 id 는 후보에 없어야 한다');
  assert.ok(Object.prototype.hasOwnProperty.call(run.json.observed, 'unclassified'));

  // 전부 미분류인 카탈로그 → unclassifiable-catalog.
  const opaque = await liveSetup(['zeta-one', 'vector-store-77', 'my-thing-x']);
  const opaqueRun = await runProbe(opaque.env, ['--json', '--author-family', 'claude']);
  assert.equal(opaqueRun.json.observed.api.live, false);
  assert.equal(opaqueRun.json.observed.external.api.valid, false);
  assert.equal(opaqueRun.json.observed.external.api.reason, 'unclassifiable-catalog');
  assert.equal(opaqueRun.json.declared.externalAbsentReason, 'unclassifiable-catalog');
  assert.equal(opaqueRun.json.observed.unclassified, 3);

  // unclassified 는 0 이어도 키가 살아 있어야 한다 — 없으면 보고에서 침묵으로 읽힌다.
  const clean = await liveSetup(['gpt-test-a', 'claude-test-a']);
  const cleanRun = await runProbe(clean.env, ['--json', '--author-family', 'claude']);
  assert.equal(cleanRun.json.observed.unclassified, 0);
  assert.ok(Object.prototype.hasOwnProperty.call(cleanRun.json.observed, 'unclassified'));
});

// ── U1-h: 계열 맵 상수성 + 소스 수준 단언 ────────────────────────────────────────────────────

test('U1-h: env 로 계열 분류를 바꿀 수 없고, 호출 기본값이 하드코딩돼 있지 않다', async () => {
  const baseline = await liveSetup(['claude-test-a', 'gpt-test-a']);
  const before = await runProbe(baseline.env, ['--json', '--author-family', 'claude']);

  // 무력화 스위치를 되살리려는 시도: 분류 결과가 조금도 달라지면 안 된다.
  const attacked = await liveSetup(['claude-test-a', 'gpt-test-a'], { RALPH_QA_FAMILY_MAP: 'claude=gpt' });
  const after = await runProbe(attacked.env, ['--json', '--author-family', 'claude']);
  assert.deepEqual(after.json.observed.candidates, before.json.observed.candidates);
  assert.equal(after.json.observed.candidates.filter((row) => row.family === 'claude').length, 0);

  // env override 경로가 코드에 존재하지 않는다(AC-P1.6, 판정은 JS 정규식으로).
  assert.equal(/RALPH_QA_FAMILY_MAP/.test(PROBE_SRC), false, '계열 맵 env override 경로가 되살아났다');

  // 호출에 쓰이는 엔드포인트·키·기본 모델 ID 리터럴 0건(AC-P1.5).
  for (const literal of ['127.0.0.1', 'azure', 'gpt-5', 'sk-']) {
    assert.equal(PROBE_SRC.includes(literal), false, '하드코딩 리터럴 발견: ' + literal);
  }

  // 프로브가 내는 HTTP 메서드는 GET 뿐이다 — 모델 호출 경로가 없다.
  const methods = [...PROBE_SRC.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(methods)], ['GET'], 'GET 외 메서드 리터럴 발견: ' + methods.join(','));
});

// ── U1-i: 저자 계열 런타임 도출 ──────────────────────────────────────────────────────────────

test('U1-i: --author-family 없이도 동작하고, 명시 지정은 시끄럽게 표시된다', async () => {
  const live = await liveSetup(['claude-test-a', 'gpt-test-a']);
  const derived = await runProbe(live.env); // 플래그 없음 — 이게 기본 경로다.
  assert.equal(derived.code, 0);
  assert.equal(derived.json.declared.authorFamilySource, 'runtime');
  assert.equal(derived.json.declared.authorFamily, 'claude');
  assert.equal(derived.json.declared.authorFamilyOverridden, false);
  assert.equal(derived.json.observed.candidates.filter((row) => row.family === 'claude').length, 0);

  const overridden = await runProbe(live.env, ['--json', '--author-family', 'gpt']);
  assert.equal(overridden.json.declared.authorFamilySource, 'flag');
  assert.equal(overridden.json.declared.authorFamily, 'gpt');
  assert.equal(overridden.json.declared.authorFamilyOverridden, true);
  assert.equal(overridden.json.observed.candidates.filter((row) => row.family === 'gpt').length, 0);

  // 런타임 신호가 아예 없으면 저자일 수 있는 계열을 모두 배제한다(fail-closed).
  const blind = await liveSetup(['claude-test-a', 'gpt-test-a', 'llama-test-a'], { CLAUDECODE: undefined });
  const blindRun = await runProbe(blind.env);
  assert.equal(blindRun.json.declared.authorFamily, 'unknown');
  assert.equal(blindRun.json.declared.authorFamilySource, 'runtime');
  assert.deepEqual(blindRun.json.observed.candidates.map((row) => row.family), ['llama']);

  // 저자 런타임이 Codex CLI 면 codex 좌석은 자기 자신이라 외부 좌석으로 부적격이다.
  const selfDir = join(mkTmp('probe-path-'), 'bin');
  writeStub(selfDir, 'curl');
  writeStub(selfDir, 'codex');
  const selfRun = await runProbe(probeEnv(live.home, {
    [KEY_ENV_NAME]: SENTINEL,
    PATH: selfDir,
    CLAUDECODE: undefined,
    CODEX_HOME: join(live.home, '.codex'),
  }));
  assert.equal(selfRun.json.declared.authorFamily, 'gpt');
  assert.equal(selfRun.json.observed.cli.codex.present, true);
  assert.equal(selfRun.json.observed.external.codex.valid, false);
  assert.equal(selfRun.json.observed.external.codex.reason, 'author-runtime');

  // authorFamily* 가 declared 아래에만 사는지까지 여기서 본다 (CR8·AC-P1.10).
  assert.deepEqual(Object.keys(derived.json).sort(), ['declared', 'notes', 'observed']);
  for (const key of ['probeMs', 'transport', 'candidates', 'unclassified', 'api', 'geminiApi', 'external']) {
    assert.ok(Object.prototype.hasOwnProperty.call(derived.json.observed, key), 'observed.' + key + ' 누락');
    assert.equal(Object.prototype.hasOwnProperty.call(derived.json.declared, key), false, 'declared 에 ' + key + ' 교차 배치');
  }
  for (const key of ['seats', 'authorFamily', 'authorFamilySource', 'authorFamilyOverridden']) {
    assert.ok(Object.prototype.hasOwnProperty.call(derived.json.declared, key), 'declared.' + key + ' 누락');
    assert.equal(Object.prototype.hasOwnProperty.call(derived.json.observed, key), false, 'observed 에 ' + key + ' 교차 배치');
  }
  assert.ok(Object.prototype.hasOwnProperty.call(derived.json.observed.api, 'status'));
  assert.equal(JSON.stringify(derived.json.declared).includes('"status"'), false, 'declared 에 status 교차 배치');
  assert.ok(Array.isArray(derived.json.notes));
});

// ── U1-j: 전송 수단 탐지 ─────────────────────────────────────────────────────────────────────

test('U1-j: transport 가 curl / python3 / none 세 값으로 갈리고, none 이면 API 좌석이 무효다', async () => {
  const stub = await startServer(catalogHandler(['gpt-test-a']));
  const makeEnv = (pathDir) => {
    const home = mkTmp('probe-home-');
    writeCodexConfig(home, { provider: 'testprov', baseUrl: stub.base, envKey: KEY_ENV_NAME });
    return probeEnv(home, { [KEY_ENV_NAME]: SENTINEL, PATH: pathDir });
  };

  // (1) curl 만 존재.
  const curlDir = join(mkTmp('probe-path-'), 'bin');
  writeStub(curlDir, 'curl');
  const curlRun = await runProbe(makeEnv(curlDir));
  assert.equal(curlRun.json.observed.transport, 'curl');
  assert.equal(curlRun.json.observed.external.api.valid, true);

  // (2) curl 없고 python3(>=3.6) 존재.
  const pyDir = join(mkTmp('probe-path-'), 'bin');
  writeStub(pyDir, 'python3');
  const pyRun = await runProbe(makeEnv(pyDir));
  assert.equal(pyRun.json.observed.transport, 'python3');
  assert.equal(pyRun.json.observed.external.api.valid, true);

  // (2-b) python3 은 있으나 버전 프로브에서 떨어지면 전송 수단이 아니다.
  const oldPyDir = join(mkTmp('probe-path-'), 'bin');
  writeFailingStub(oldPyDir, 'python3');
  const oldPyRun = await runProbe(makeEnv(oldPyDir));
  assert.equal(oldPyRun.json.observed.transport, 'none');

  // (3) 둘 다 없음 → none + 외부 API 좌석 무효.
  const emptyDir = join(mkTmp('probe-path-'), 'bin');
  mkdirSync(emptyDir, { recursive: true });
  const noneRun = await runProbe(makeEnv(emptyDir));
  assert.equal(noneRun.json.observed.transport, 'none');
  assert.equal(noneRun.json.observed.external.api.valid, false);
  assert.equal(noneRun.json.observed.external.api.reason, 'no-transport');
  assert.equal(noneRun.json.declared.externalAbsentReason, 'no-transport');
  // transport 는 어떤 경우에도 세 값 중 하나로 항상 나온다.
  for (const run of [curlRun, pyRun, oldPyRun, noneRun]) {
    assert.ok(['curl', 'python3', 'none'].includes(run.json.observed.transport));
  }
});

// ── U1-k: gemini 사다리 G0·G1 (G2 는 수행하지 않는다) ────────────────────────────────────────

test('U1-k: gemini 는 존재·인증까지만 판정하고 liveChecked 는 항상 false 다', async () => {
  const stub = await startServer(catalogHandler(['gpt-test-a']));
  const marker = join(mkTmp('probe-marker-'), 'gemini-was-called');
  const geminiDir = join(mkTmp('probe-path-'), 'bin');
  writeStub(geminiDir, 'curl');
  writeStub(geminiDir, 'gemini', { marker }); // 실행되면 마커 파일을 남기는 스텁.
  const makeEnv = (pathDir, extra) => {
    const home = mkTmp('probe-home-');
    writeCodexConfig(home, { provider: 'testprov', baseUrl: stub.base, envKey: KEY_ENV_NAME });
    return probeEnv(home, { [KEY_ENV_NAME]: SENTINEL, PATH: pathDir, ...extra });
  };

  // G0 통과 + G1 실패(인증 env 부재).
  const noAuth = await runProbe(makeEnv(geminiDir));
  assert.equal(noAuth.json.observed.cli.gemini.present, true);
  assert.equal(noAuth.json.observed.cli.gemini.authEnvPresent, false);
  assert.equal(noAuth.json.observed.cli.gemini.liveChecked, false);
  assert.equal(noAuth.json.observed.external.gemini.valid, false);
  assert.equal(noAuth.json.observed.external.gemini.reason, 'gemini-no-auth');

  // G1 통과 — 그래도 CLI 좌석의 G2 는 수행하지 않으므로 liveChecked 는 여전히 false 다.
  // 인증 env 가 있으면 크리덴셜 좌석(GA2)이 별도로 나가므로 그 엔드포인트를 스텁으로 묶어 둔다.
  const geminiStub = await startServer(statusHandler(200));
  const withAuth = await runProbe(makeEnv(geminiDir, {
    GEMINI_API_KEY: SENTINEL,
    [GEMINI_BASE_URL_ENV]: geminiStub.root,
  }));
  assert.equal(withAuth.json.observed.cli.gemini.present, true);
  assert.equal(withAuth.json.observed.cli.gemini.authEnvPresent, true);
  assert.equal(withAuth.json.observed.cli.gemini.liveChecked, false, 'GA2 는 CLI 가 아니라 API 를 잰 것이라 이 값을 올리지 않는다');
  assert.equal(withAuth.json.observed.external.gemini.valid, true);
  assert.equal((withAuth.stdout + withAuth.stderr).includes(SENTINEL), false, 'gemini 키 값 노출');

  // gemini 부재 경로에서도 세 키가 모두 있고 liveChecked 는 false 다.
  const absentDir = join(mkTmp('probe-path-'), 'bin');
  writeStub(absentDir, 'curl');
  const absent = await runProbe(makeEnv(absentDir));
  assert.deepEqual(Object.keys(absent.json.observed.cli.gemini).sort(), ['authEnvPresent', 'liveChecked', 'present']);
  assert.equal(absent.json.observed.cli.gemini.present, false);
  assert.equal(absent.json.observed.cli.gemini.liveChecked, false);
  assert.equal(absent.json.observed.external.gemini.reason, 'cli-absent');

  // G2·G3 을 하지 않는다는 것의 실증: gemini 바이너리가 한 번도 실행되지 않았다.
  assert.equal(existsSync(marker), false, '프로브가 gemini 를 실행했다 — G2 는 수행하지 않아야 한다');
});

// ── U1-l: gemini 크리덴셜 좌석 GA1·GA2 — CLI 좌석과 독립이다 ────────────────────────────────
//
// 이 케이스가 닫는 공백: U1-k 는 (CLI 있음 + 인증 있음)과 (CLI 없음 + 인증 없음)만 봤다. 실제로
// 깨진 조합은 그 사이의 (CLI 없음 + 인증 있음)이었고, 거기서 프로브는 authEnvPresent:true 를
// 관측해 놓고 버린 뒤 "환경이 경로를 안 줬다"(cli-absent)고 보고했다.

test('U1-l: CLI 가 없어도 크리덴셜 좌석이 서고, 크리덴셜이 있으면 cli-absent 를 쓰지 않는다', async () => {
  const curlDir = curlOnlyPath(); // codex·gemini 없음, curl 만 — CLI 축이 전부 비어 있는 PATH 다.

  // (1) CLI 없음 + 인증 있음 + 200 → 크리덴셜 좌석이 CLI 와 무관하게 선다.
  const okStub = await startServer(statusHandler(200));
  const ok = await runProbe(probeEnv(mkTmp('probe-home-'), { // codex config 없음 → api 좌석 미구성.
    GEMINI_API_KEY: SENTINEL,
    [GEMINI_BASE_URL_ENV]: okStub.root,
    PATH: curlDir,
  }));
  assert.equal(ok.json.observed.cli.gemini.present, false, 'CLI 는 부재인 케이스다');
  assert.equal(ok.json.observed.cli.gemini.authEnvPresent, true);
  assert.equal(ok.json.observed.cli.gemini.liveChecked, false, 'CLI 좌석의 liveChecked 는 계속 false');
  assert.equal(ok.json.observed.geminiApi.configured, true);
  assert.equal(ok.json.observed.geminiApi.keyEnv, 'GEMINI_API_KEY');
  assert.equal(ok.json.observed.geminiApi.status, 200);
  assert.equal(ok.json.observed.geminiApi.live, true);
  assert.equal(ok.json.observed.geminiApi.reason, null);
  assert.equal(ok.json.observed.external.geminiApi.valid, true);
  assert.equal(ok.json.observed.external.gemini.reason, 'cli-absent', 'CLI 좌석 사유는 그대로 cli-absent');
  assert.notEqual(ok.json.declared.externalAbsentReason, 'cli-absent');
  assert.equal(ok.json.declared.externalAbsentReason, null, '좌석이 섰으므로 부재 사유가 없다');
  assert.deepEqual(ok.json.declared.seats.external, [{ kind: 'gemini-api' }]);

  // GA2 는 0토큰이다: 모델 목록 GET 한 번뿐이고 인증은 쿼리스트링에 실린다.
  assert.equal(okStub.requests.length, 1);
  assert.equal(okStub.requests[0].method, 'GET');
  assert.ok(okStub.requests[0].url.startsWith('/v1beta/models?'), '모델 목록 경로로 나가야 한다');
  assert.ok(okStub.requests[0].url.includes('key='), '인증이 쿼리스트링에 실려야 한다');
  // 그 쿼리스트링이 출력으로 새지 않는다 — 값도, 쿼리 자체도.
  assert.equal((ok.stdout + ok.stderr).includes(SENTINEL), false, '크리덴셜 좌석 경로에서 키 값 노출');
  assert.equal(ok.json.observed.geminiApi.baseUrl.includes('?'), false, '출력 baseUrl 에 쿼리스트링 잔존');
  assert.equal(ok.stdout.includes('key='), false, '출력에 쿼리스트링이 실렸다');

  // (2) 인증 있음 + 401 → cli-absent 가 아니라 실패 지점을 적고, notes 가 침묵하지 않는다.
  const deadStub = await startServer(statusHandler(401));
  const dead = await runProbe(probeEnv(mkTmp('probe-home-'), {
    GEMINI_API_KEY: SENTINEL,
    [GEMINI_BASE_URL_ENV]: deadStub.root,
    PATH: curlDir,
  }));
  assert.equal(dead.json.observed.geminiApi.status, 401);
  assert.equal(dead.json.observed.geminiApi.live, false);
  assert.equal(dead.json.observed.geminiApi.reason, 'dead-credential');
  assert.equal(dead.json.observed.external.geminiApi.valid, false);
  assert.equal(dead.json.declared.seats.external.length, 0);
  assert.equal(dead.json.declared.externalAbsentReason, 'probe-unseated status=401');
  assert.ok(dead.json.notes.length > 0, '크리덴셜이 있는데 좌석이 안 서면 notes 가 비면 안 된다');
  assert.ok(dead.json.notes.some((n) => n.includes('GEMINI_API_KEY')), 'note 는 키 이름을 적는다');
  assert.equal((dead.stdout + dead.stderr).includes(SENTINEL), false, '401 경로에서 키 값 노출');

  // (3) CLI 없음 + 인증 없음 → cli-absent 가 유지된다(사유 토큰의 정당한 용법).
  const bare = await runProbe(probeEnv(mkTmp('probe-home-'), { PATH: curlDir }));
  assert.equal(bare.json.observed.geminiApi.configured, false);
  assert.equal(bare.json.observed.geminiApi.keyEnv, null);
  // status 의 두 값은 다른 사실을 말한다: null = 시도하지 않음, 0 = 시도했으나 도달 실패
  // (timeout·unreachable·bad-url). 크리덴셜이 없으면 애초에 시도할 대상이 없으므로 null 이다.
  // 둘을 같은 값으로 뭉개면 "안 했다"가 "했는데 실패했다"로 읽혀 보고가 거짓이 된다.
  assert.equal(bare.json.observed.geminiApi.status, null, '시도하지 않았으면 null (0 은 도달 실패)');
  assert.equal(bare.json.observed.geminiApi.probed, false, '요청을 냈는지 여부는 별도 필드로 명시한다');
  assert.equal(bare.json.observed.geminiApi.live, null, 'live:false 는 "재 봤더니 죽었다"의 자리다');
  assert.equal(bare.json.observed.httpRequests, 0, '이 실행은 어떤 요청도 내지 않았다');
  assert.equal(bare.json.observed.probeMs, null, '잰 것이 없으면 소요 시간도 없다');
  assert.equal(bare.json.observed.external.geminiApi.reason, 'no-credential');
  assert.equal(bare.json.declared.externalAbsentReason, 'cli-absent');

  // (4) 인증 있음 + 전송 수단 없음 → no-transport. 여기서도 cli-absent 는 답이 아니다.
  const emptyDir = join(mkTmp('probe-path-'), 'bin');
  mkdirSync(emptyDir, { recursive: true });
  const ntStub = await startServer(statusHandler(200));
  const noTransport = await runProbe(probeEnv(mkTmp('probe-home-'), {
    GEMINI_API_KEY: SENTINEL,
    [GEMINI_BASE_URL_ENV]: ntStub.root,
    PATH: emptyDir,
  }));
  assert.equal(noTransport.json.observed.transport, 'none');
  assert.equal(noTransport.json.observed.geminiApi.live, true, '생존 판정 자체는 관측된다');
  assert.equal(noTransport.json.observed.external.geminiApi.valid, false);
  assert.equal(noTransport.json.observed.external.geminiApi.reason, 'no-transport');
  assert.equal(noTransport.json.declared.externalAbsentReason, 'no-transport');
  assert.ok(noTransport.json.notes.some((n) => n.includes('no-transport')), '좌석이 안 선 이유가 notes 에 남는다');

  // 네 케이스 모두 사유 토큰은 닫힌 정의역 안이고, 최상위 키는 셋 그대로다.
  for (const run of [ok, dead, bare, noTransport]) {
    assert.deepEqual(Object.keys(run.json).sort(), ['declared', 'notes', 'observed']);
    const token = run.json.declared.externalAbsentReason;
    if (token !== null) {
      assert.ok(['no-transport', 'cli-absent'].includes(token) || /^probe-unseated status=\S+$/.test(token),
        '사유 토큰이 닫힌 정의역 밖이다: ' + token);
    }
  }
});

// ── U1-m: base URL 해석 순서 — 상수 기본값은 언제나 최후 순위다 ──────────────────────────────

test('U1-m: base_url 을 못 찾아도 키 env 가 유효하면 표준 기본값으로 구성이 선다', async () => {
  const emptyHome = mkTmp('probe-home-'); // .codex 없음.
  const baseEnv = { HOME: emptyHome, USERPROFILE: emptyHome };
  const stub = await startServer(catalogHandler(['gpt-test-a']));

  // (1) 키 env 만 유효하고 base_url env 가 없다 → 미구성이 아니라 표준 기본값으로 내려간다.
  const notes = [];
  const fallback = resolveApi({ ...baseEnv, OPENAI_API_KEY: SENTINEL }, notes);
  assert.equal(fallback.configured, true, '키가 유효한데 미구성으로 끊으면 안 된다');
  assert.equal(fallback.source, 'default:openai');
  assert.equal(fallback.baseUrl, DEFAULT_OPENAI_BASE_URL);
  assert.equal(fallback.keyEnv, 'OPENAI_API_KEY');
  assert.ok(DEFAULT_OPENAI_BASE_URL.startsWith('https://'), '기본값이 평문 HTTP 면 안 된다');
  assert.ok(notes.length > 0, '상수 기본값으로 내려간 사실은 보고에 남긴다');
  assert.equal(notes.join('').includes(SENTINEL), false, 'note 에 키 값 노출');

  // (2) base_url env 가 있으면 그쪽이 이긴다 — 기본값은 최후 순위다.
  for (const [name, expected] of [['OPENAI_BASE_URL', 'env:OPENAI_BASE_URL'], ['RALPH_QA_BASE_URL', 'env:RALPH_QA_BASE_URL']]) {
    const viaEnv = resolveApi({ ...baseEnv, OPENAI_API_KEY: SENTINEL, [name]: stub.base }, []);
    assert.equal(viaEnv.source, expected);
    assert.equal(viaEnv.baseUrl, stub.base);
  }

  // (3) codex config 가 있으면 그게 가장 세다 — 기존 우선순위를 기본값이 밀어내지 않는다.
  const cfgHome = mkTmp('probe-home-');
  writeCodexConfig(cfgHome, { provider: 'testprov', baseUrl: stub.base, envKey: KEY_ENV_NAME });
  const viaCfg = resolveApi({
    HOME: cfgHome, USERPROFILE: cfgHome, OPENAI_API_KEY: SENTINEL, OPENAI_BASE_URL: stub.root, [KEY_ENV_NAME]: SENTINEL,
  }, []);
  assert.equal(viaCfg.source, 'codex:testprov');
  assert.equal(viaCfg.baseUrl, stub.base);

  // (4) 키도 base_url 도 없으면 미구성이다 — 기본값이 빈 손을 구성으로 바꾸지 않는다.
  const none = resolveApi({ ...baseEnv }, []);
  assert.equal(none.configured, false);
  assert.equal(none.source, 'none');
  assert.equal(none.baseUrl, null);

  // (5) 해석된 구성은 좌석 게이트로 그대로 이어진다(codex config 없이 키 env 만으로 착석).
  // 상수 기본값 자체로 좌석을 세우려면 실 엔드포인트가 필요해 유닛에서 못 한다 — 해석은 (1)이,
  // 게이트는 여기가 잠근다.
  const seatRun = await runProbe(probeEnv(mkTmp('probe-home-'), { OPENAI_API_KEY: SENTINEL, OPENAI_BASE_URL: stub.base }));
  assert.equal(seatRun.json.observed.api.configured, true);
  assert.equal(seatRun.json.observed.api.source, 'env:OPENAI_BASE_URL');
  assert.equal(seatRun.json.observed.api.keyEnv, 'OPENAI_API_KEY');
  assert.equal(seatRun.json.observed.external.api.valid, true, '키 env 만으로도 api 좌석이 선다');
  assert.equal((seatRun.stdout + seatRun.stderr).includes(SENTINEL), false);

  // (6) gemini 쪽도 같은 규율이다: 상수 기본값 + env override 한 쌍.
  const gDefault = resolveGeminiApi({ GEMINI_API_KEY: SENTINEL });
  assert.equal(gDefault.configured, true);
  assert.equal(gDefault.source, 'default:gemini');
  assert.equal(gDefault.baseUrl, DEFAULT_GEMINI_BASE_URL);
  assert.ok(DEFAULT_GEMINI_BASE_URL.startsWith('https://'), '기본값이 평문 HTTP 면 안 된다');
  const gOverride = resolveGeminiApi({ GEMINI_API_KEY: SENTINEL, [GEMINI_BASE_URL_ENV]: stub.root });
  assert.equal(gOverride.source, 'env:' + GEMINI_BASE_URL_ENV);
  assert.equal(gOverride.baseUrl, stub.root);
  assert.equal(resolveGeminiApi({}).configured, false);
  assert.equal(resolveGeminiApi({}).keyEnv, null);
});

// ── U1-n: --external=off 는 송신 게이트다 ────────────────────────────────────────────────────
//
// 이 케이스가 닫는 공백: off 가 좌석 계산에서만 소비되면 프로브는 그대로 키를 벤더 호스트로 보낸
// 뒤 "미실행"이라고 보고한다(실측으로 api 401·geminiApi 400 이 나왔다). 그래서 판정 기준을 응답
// 모양이 아니라 **스텁이 요청을 받았는가**로 둔다 — 보내 놓고 무시하는 구현은 여기서 죽는다.

test('U1-n: --external=off 면 스텁 서버가 요청을 한 건도 받지 않는다', async () => {
  const apiStub = await startServer(catalogHandler(['gpt-test-a']));
  const geminiStub = await startServer(statusHandler(200));
  const home = mkTmp('probe-home-');
  writeCodexConfig(home, { provider: 'testprov', baseUrl: apiStub.base, envKey: KEY_ENV_NAME });
  const env = probeEnv(home, {
    [KEY_ENV_NAME]: SENTINEL,
    GEMINI_API_KEY: SENTINEL,
    [GEMINI_BASE_URL_ENV]: geminiStub.root,
  });

  // (1) 대조군. off 가 아니면 두 스텁 모두 실제로 요청을 받는다 — 이걸 먼저 보여야 아래의 0건이
  //     "원래 아무 데도 안 물어보는 구성이라서"가 아님이 증명된다.
  const on = await runProbe(env);
  assert.equal(apiStub.requests.length, 1, '대조군: api 스텁이 요청을 받는다');
  assert.equal(geminiStub.requests.length, 1, '대조군: gemini 스텁이 요청을 받는다');
  assert.equal(on.json.observed.httpRequests, 2, '보고된 요청 수가 실제와 일치한다');
  assert.equal(on.json.observed.api.probed, true);
  assert.equal(on.json.observed.api.status, 200);
  assert.ok(on.json.observed.probeMs >= 0, '실제로 쟀으면 소요 시간이 숫자다');

  // (2) 같은 env·같은 목적지에 off 만 걸었다. 요청 카운터가 움직이면 안 된다.
  const before = { api: apiStub.requests.length, gemini: geminiStub.requests.length };
  const off = await runProbe(env, ['--json', '--external=off']); // 인라인 표기(SKILL.md 가 쓰는 형태).
  assert.equal(apiStub.requests.length, before.api, 'off 인데 api 스텁이 요청을 받았다');
  assert.equal(geminiStub.requests.length, before.gemini, 'off 인데 gemini 스텁이 요청을 받았다');
  assert.equal(off.json.observed.httpRequests, 0, 'off 실행의 요청 수는 0 이다');
  assert.equal(off.json.observed.probeMs, null, '안 쟀으면 소요 시간도 없다 (숫자면 "쟀는데 빨랐다"로 읽힌다)');

  // 분리 표기: "안 했다"가 "했는데 실패했다"처럼 읽히면 안 된다.
  for (const field of ['api', 'geminiApi']) {
    assert.equal(off.json.observed[field].probed, false, field + '.probed');
    assert.equal(off.json.observed[field].status, null, field + '.status 는 실패코드 자리가 아니다');
    assert.equal(off.json.observed[field].live, null, field + '.live 는 판정 자리다 — 판정한 적이 없다');
    assert.equal(off.json.observed[field].reason, 'external-off', field + '.reason');
  }
  assert.ok(off.json.notes.some((n) => n.includes('--external=off')), '미실행 사실을 notes 에도 남긴다');

  // 정적 탐지는 그대로 돈다 — off 는 "아무것도 안 본다"가 아니라 "아무것도 안 보낸다"이다.
  assert.equal(off.json.observed.api.configured, true, 'config 파싱은 계속한다');
  assert.equal(off.json.observed.api.source, 'codex:testprov');
  assert.equal(off.json.observed.api.keyEnv, KEY_ENV_NAME, 'env 이름 확인도 계속한다');
  assert.equal(off.json.observed.transport, 'curl', 'PATH 스캔도 계속한다');
  assert.equal(off.json.observed.cli.gemini.authEnvPresent, true);

  // 좌석과 사유는 저자 요청으로 닫힌다(관측의 external-off 와 선언의 author-off 는 다른 층이다).
  assert.equal(off.json.declared.seats.external.length, 0);
  assert.equal(off.json.declared.externalAbsentReason, 'author-off');
  for (const seat of ['api', 'codex', 'gemini', 'geminiApi']) {
    assert.equal(off.json.observed.external[seat].reason, 'author-off', 'external.' + seat);
  }
  assert.deepEqual(Object.keys(off.json).sort(), ['declared', 'notes', 'observed']);
  assert.ok(Object.prototype.hasOwnProperty.call(off.json.observed, 'unclassified'), '0 이어도 키를 생략하지 않는다');
  assert.equal((off.stdout + off.stderr).includes(SENTINEL), false, 'off 경로에서 키 값 노출');

  // --external=auto(기본)는 종전대로 나간다 — off 게이트가 기본 경로를 막아 버리면 안 된다.
  const auto = await runProbe(env, ['--json', '--external', 'auto']);
  assert.equal(auto.json.observed.httpRequests, 2);
  assert.equal(apiStub.requests.length, before.api + 1);
});

// ── U1-o: 기본 엔드포인트 폴백 옵트아웃 ──────────────────────────────────────────────────────
//
// 이 케이스가 닫는 공백: OPENAI_API_KEY 는 OpenAI 가 아닌 프로바이더(게이트웨이·프록시·사설 서버)의
// 키를 담는 구성이 흔하고, 그런 환경의 base URL 은 앱 설정에 있지 env 에 없다. 폴백이 무고지·무옵션
// 이면 남의 프로바이더 키가 이름만 같은 벤더로 나간다.

test('U1-o: RALPH_QA_NO_DEFAULT_ENDPOINT 면 기본 벤더 엔드포인트로 내려가지 않는다', async () => {
  const home = mkTmp('probe-home-'); // .codex 없음 — base_url 을 해석할 데가 없다.
  const baseEnv = { HOME: home, USERPROFILE: home };

  // (1) 옵트아웃 없음 = 종전 동작(표준 벤더 호스트로 내려가고 notes 에 남는다).
  const descendedNotes = [];
  const descended = resolveApi({ ...baseEnv, OPENAI_API_KEY: SENTINEL }, descendedNotes);
  assert.equal(descended.source, 'default:openai');
  assert.ok(descendedNotes.some((n) => n.includes(NO_DEFAULT_ENDPOINT_ENV)), '폴백 고지에 끄는 방법이 적혀 있다');

  // (2) 옵트아웃 = 목적지 자체가 없다. 보낼 URL 이 없으므로 보낼 수도 없다.
  const blockedNotes = [];
  const blocked = resolveApi({ ...baseEnv, OPENAI_API_KEY: SENTINEL, [NO_DEFAULT_ENDPOINT_ENV]: '1' }, blockedNotes);
  assert.equal(blocked.configured, false, '옛 동작(미구성)으로 되돌아간다');
  assert.equal(blocked.source, 'none');
  assert.equal(blocked.baseUrl, null);
  assert.ok(blockedNotes.some((n) => n.includes(NO_DEFAULT_ENDPOINT_ENV)), '미착석 사유를 notes 에 남긴다');
  assert.ok(blockedNotes.some((n) => n.includes('OPENAI_API_KEY')), '키 env 이름은 남긴다(값이 아니라)');
  assert.equal(blockedNotes.join('').includes(SENTINEL), false, 'note 에 키 값 노출');

  // (3) e2e. 요청 0건 + not-configured 미착석.
  const apiRun = await runProbe(probeEnv(mkTmp('probe-home-'), {
    OPENAI_API_KEY: SENTINEL, [NO_DEFAULT_ENDPOINT_ENV]: '1',
  }));
  assert.equal(apiRun.json.observed.httpRequests, 0, '보낼 목적지가 없으므로 요청도 0건이다');
  assert.equal(apiRun.json.observed.api.probed, false);
  assert.equal(apiRun.json.observed.api.configured, false);
  assert.equal(apiRun.json.observed.api.baseUrl, null);
  assert.equal(apiRun.json.observed.api.reason, 'not-configured');
  assert.equal(apiRun.json.observed.external.api.reason, 'not-configured');
  assert.ok(apiRun.json.notes.some((n) => n.includes(NO_DEFAULT_ENDPOINT_ENV)));
  assert.equal((apiRun.stdout + apiRun.stderr).includes(SENTINEL), false);

  // (4) gemini 쪽도 같은 규율이다. 크리덴셜은 있었으므로 no-credential 과 뭉개지 않는다.
  const gRun = await runProbe(probeEnv(mkTmp('probe-home-'), {
    GEMINI_API_KEY: SENTINEL, [NO_DEFAULT_ENDPOINT_ENV]: '1',
  }));
  assert.equal(gRun.json.observed.httpRequests, 0);
  assert.equal(gRun.json.observed.geminiApi.probed, false);
  assert.equal(gRun.json.observed.geminiApi.configured, false);
  assert.equal(gRun.json.observed.geminiApi.baseUrl, null, '목적지를 출력에도 적지 않는다');
  assert.equal(gRun.json.observed.geminiApi.reason, 'not-configured');
  assert.equal(gRun.json.observed.external.geminiApi.reason, 'not-configured');
  assert.ok(gRun.json.notes.some((n) => n.includes('GEMINI_API_KEY')), '어느 키 env 였는지 남긴다');
  // 반복 1에서 닫은 것을 되돌리지 않는다: CLI 좌석은 크리덴셜 좌석과 독립이고(인증 env 는 그대로
  // 관측된다), 크리덴셜이 있는 실행은 cli-absent 로 보고하지 않는다.
  assert.equal(gRun.json.observed.cli.gemini.authEnvPresent, true, '기본 엔드포인트를 껐다고 CLI 인증이 사라지지 않는다');
  assert.notEqual(gRun.json.declared.externalAbsentReason, 'cli-absent');
  // 이 자리에 한때 'probe-unseated status=not-configured' 가 들어갔는데 그건 두 번 거짓이었다:
  // HTTP 를 한 건도 안 냈으므로 "probe-unseated" 가 아니고(probed:false), <code> 자리에 상태코드가
  // 아닌 문자열이 들어가며, 그 토큰은 환경 계열이라 저자 설정이 원인인 것을 환경 탓으로 보고했다.
  // 원인이 저자의 옵트아웃이면 저자 계열 토큰을 낸다.
  assert.equal(gRun.json.declared.externalAbsentReason, 'default-endpoint-off');

  // (5) 옵트아웃은 좁다 — 명시 base URL 이 있으면 아무것도 바뀌지 않는다(폴백만 끈다).
  const stub = await startServer(catalogHandler(['gpt-test-a']));
  const explicit = await runProbe(probeEnv(mkTmp('probe-home-'), {
    OPENAI_API_KEY: SENTINEL, OPENAI_BASE_URL: stub.base, [NO_DEFAULT_ENDPOINT_ENV]: '1',
  }));
  assert.equal(stub.requests.length, 1, '명시 설정은 옵트아웃과 무관하게 그대로 나간다');
  assert.equal(explicit.json.observed.api.source, 'env:OPENAI_BASE_URL');
  assert.equal(explicit.json.observed.api.probed, true);
  assert.equal(explicit.json.observed.external.api.valid, true);
});

// ── U1-p: 401·403 대체 헤더 재시도는 명시 설정일 때만 ────────────────────────────────────────
//
// 이 케이스가 닫는 공백: 기본 엔드포인트로 내려간 상태에서 401 을 받으면 종전 구현은 api-key 헤더로
// 한 번 더 보냈다. 오배송이 1건에서 2건이 된다. 기본 엔드포인트 경로는 정의상 실 벤더 호스트를
// 향하므로 자식 프로세스로 재현할 수 없어, 게이트 자체(probeModels)를 in-process 로 스텁에 물린다.

test('U1-p: 기본 엔드포인트면 키를 한 번만 보내고, 명시 설정이면 재시도한다', async () => {
  const noRetry = await startServer(statusHandler(401));
  const once = await probeModels(noRetry.base, SENTINEL, 2000, false);
  assert.equal(noRetry.requests.length, 1, '재시도 금지인데 두 번 보냈다');
  assert.equal(once.requests, 1, '보고된 요청 수가 실제와 일치한다');
  assert.equal(once.status, 401);
  assert.equal(noRetry.requests[0].auth.apiKey, null, '대체 헤더로 키를 다시 보내지 않는다');

  const withRetry = await startServer(statusHandler(401));
  const twice = await probeModels(withRetry.base, SENTINEL, 2000, true);
  assert.equal(withRetry.requests.length, 2, '명시 설정이면 대체 헤더로 한 번 더 시도한다');
  assert.equal(twice.requests, 2);
  assert.equal(withRetry.requests[1].auth.apiKey, SENTINEL, '두 번째 시도는 대체 헤더를 쓴다');

  // 게이트에 들어가는 판정: default:* 만 재시도 금지다.
  for (const source of ['codex:testprov', 'env:OPENAI_BASE_URL', 'env:' + GEMINI_BASE_URL_ENV]) {
    assert.equal(isExplicitSource(source), true, source);
  }
  for (const source of ['default:openai', 'default:gemini', 'none']) {
    assert.equal(isExplicitSource(source), false, source);
  }

  // 해석 → 게이트 연결. 키 env 만 있는 구성은 default:openai 로 해석되고 그 source 는 재시도 불가다.
  const home = mkTmp('probe-home-');
  const descended = resolveApi({ HOME: home, USERPROFILE: home, OPENAI_API_KEY: SENTINEL }, []);
  assert.equal(descended.source, 'default:openai');
  assert.equal(isExplicitSource(descended.source), false, '기본 엔드포인트로 내려간 구성은 키를 한 번만 보낸다');

  // e2e 반대편: codex config(명시)에서 401 이면 자식 프로세스도 두 번 보낸다.
  const cfgStub = await startServer(statusHandler(401));
  const cfgHome = mkTmp('probe-home-');
  writeCodexConfig(cfgHome, { provider: 'testprov', baseUrl: cfgStub.base, envKey: KEY_ENV_NAME });
  const run = await runProbe(probeEnv(cfgHome, { [KEY_ENV_NAME]: SENTINEL }));
  assert.equal(cfgStub.requests.length, 2, '명시 설정 e2e 는 재시도가 살아 있다');
  assert.equal(run.json.observed.httpRequests, 2);
  assert.equal(run.json.observed.api.probed, true);
  assert.equal(run.json.observed.api.status, 401);
  assert.equal(run.json.observed.api.reason, 'dead-credential');
  assert.equal((run.stdout + run.stderr).includes(SENTINEL), false, '재시도 경로에서 키 값 노출');
});

// ── U1-q ~ U1-u: 외부 좌석끼리의 모델 중복 회피 ──────────────────────────────────────────────
//
// 이 다섯이 닫는 공백: 위 케이스는 전부 PATH 에 curl 만 둬서 codex 좌석이 한 번도 서지 않았고,
// codex config 에 model 키도 없었다. 그래서 "api 좌석이 codex 와 같은 모델을 고른다"는 경로가
// 유닛에서 한 번도 실행되지 않았다. 실환경에서는 그 model 키가 api 좌석의 선호 모델 출처이기도
// 해서 둘이 나란히 같은 모델로 앉는다 — 좌석 2, 모델 축 1.

let codexPathDir = null;
function codexPath() {
  if (!codexPathDir) {
    codexPathDir = join(mkTmp('probe-path-codex-'), 'bin');
    writeStub(codexPathDir, 'curl');
    writeStub(codexPathDir, 'codex');
  }
  return codexPathDir;
}

// codex 좌석이 서는 한 벌: 스텁 서버 + config(model 포함) + codex 가 있는 PATH.
async function codexSeatedSetup(ids, model) {
  const stub = await startServer(catalogHandler(ids));
  const home = mkTmp('probe-home-');
  writeCodexConfig(home, { provider: 'testprov', baseUrl: stub.base, envKey: KEY_ENV_NAME, model });
  return { stub, home, env: probeEnv(home, { [KEY_ENV_NAME]: SENTINEL, PATH: codexPath() }) };
}

function apiSeatOf(run) {
  return run.json.declared.seats.external.find((seat) => seat.kind === 'api');
}

test('U1-q: codex 좌석이 서면 api 좌석은 codex 모델의 계열을 피한다', async () => {
  const { env } = await codexSeatedSetup(['gpt-test-a', 'gpt-test-b', 'llama-test-a'], 'gpt-test-a');
  const run = await runProbe(env);
  const seats = run.json.declared.seats.external;
  assert.ok(seats.some((seat) => seat.kind === 'codex'), 'codex 좌석이 서야 이 케이스가 의미를 갖는다');

  const api = apiSeatOf(run);
  assert.equal(api.modelPick, 'independent-family');
  assert.equal(api.model, 'llama-test-a');
  // 회피 기준이 모델이 아니라 계열임을 고정한다. 같은 계열의 다른 모델(gpt-test-b)을 골라도
  // "codex 와 다른 모델"은 만족하지만 모델 축에서는 여전히 하나다.
  assert.notEqual(run.json.observed.candidates.find((row) => row.id === api.model).family, 'gpt');
});

test('U1-r: 다른 계열 후보가 없으면 모델만 가르고 겹침을 note 로 드러낸다', async () => {
  const { env } = await codexSeatedSetup(['gpt-test-a', 'gpt-test-b'], 'gpt-test-a');
  const run = await runProbe(env);
  const api = apiSeatOf(run);
  assert.equal(api.modelPick, 'same-family-different-model');
  assert.equal(api.model, 'gpt-test-b');
  assert.ok(run.json.notes.some((note) => note.includes('같은 계열')), '겹침 사실이 notes 에 있어야 한다');
});

test('U1-s: 후보가 codex 모델 하나뿐이면 같은 모델로 앉되 겹침을 숨기지 않는다', async () => {
  const { env } = await codexSeatedSetup(['gpt-test-a'], 'gpt-test-a');
  const run = await runProbe(env);
  const api = apiSeatOf(run);
  assert.equal(api.modelPick, 'same-model');
  assert.equal(api.model, 'gpt-test-a');
  assert.ok(run.json.notes.some((note) => note.includes('같은 모델')), '겹침 사실이 notes 에 있어야 한다');
});

test('U1-t: codex 좌석이 없으면 회피가 적용되지 않고 저자 선호 모델이 그대로 선다', async () => {
  const stub = await startServer(catalogHandler(['gpt-test-a', 'llama-test-a']));
  const home = mkTmp('probe-home-');
  writeCodexConfig(home, { provider: 'testprov', baseUrl: stub.base, envKey: KEY_ENV_NAME, model: 'llama-test-a' });
  const run = await runProbe(probeEnv(home, { [KEY_ENV_NAME]: SENTINEL })); // PATH=curl 만 → codex 미착석.

  assert.equal(run.json.observed.external.codex.valid, false);
  const api = apiSeatOf(run);
  assert.equal(api.modelPick, 'unconstrained');
  // 후보 첫 항목은 gpt-test-a 다. 선호가 그걸 이겼다는 것이 "회피가 과잉 적용되지 않았다"의 증거다
  // — 구현이 무조건 candidates[0] 을 쓰는 것으로 퇴화하면 여기서 깨진다.
  assert.equal(run.json.observed.candidates[0].id, 'gpt-test-a');
  assert.equal(api.model, 'llama-test-a');
});

test('U1-u: codex 모델을 확인하지 못하면 fail-closed 로 codex 런타임 계열을 피한다', async () => {
  // config 에 model 키가 없는 구성 — codex 기본 모델을 쓰는 흔한 설정이다. 이때 프로브는 codex 가
  // 무엇을 돌릴지 모르므로 "모르니 안 피한다"가 아니라 "모르니 넓게 피한다"로 가야 한다.
  const stub = await startServer(catalogHandler(['gpt-test-a', 'llama-test-a']));
  const home = mkTmp('probe-home-');
  writeCodexConfig(home, { provider: 'testprov', baseUrl: stub.base, envKey: KEY_ENV_NAME });
  const run = await runProbe(probeEnv(home, { [KEY_ENV_NAME]: SENTINEL, PATH: codexPath() }));

  const api = apiSeatOf(run);
  assert.equal(api.modelPick, 'independent-family');
  assert.equal(api.model, 'llama-test-a');
  assert.ok(run.json.notes.some((note) => note.includes('fail-closed')), '추정으로 피했다는 사실을 드러내야 한다');
});
