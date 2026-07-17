#!/usr/bin/env node
/*
 * banker 텔레메트리 count 훅 - UserPromptExpansion 이벤트마다 banker 커맨드/스킬 이름을
 * 로컬 usage-log 에 한 줄 기록하고, 24h 마다 flush 훅을 한 번 기동한다.
 *
 * fail-closed 규약(각 항목은 telemetry-count.test.mjs 가 검증한다):
 *  - 동의(isEnabled)가 아니면 로컬 쓰기조차 하지 않는다. 파일도 만들지 않는다.
 *  - 어떤 오류도 삼키고 항상 exit 0. 세션/프롬프트를 절대 막지 않는다.
 *  - PII/식별자를 다루지 않는다. 로그 한 줄 = banker:<name> 문자열 하나뿐.
 *
 * payload 필드 미검증 - 배선(US-3b) 전 라이브 스모크테스트로 확정 필요.
 *   UserPromptExpansion stdin payload 에서 커맨드 이름이 어느 키에 들어오는지는 공식 문서에
 *   미기재라 미검증이다. 그래서 이름 추출은 방어적으로: 이름을 담을 법한 필드들을 순서대로
 *   시도하고, 마지막엔 원시 stdin 문자열 전체를 스캔한다. 실제 필드가 확정되면 이 목록을 좁힌다.
 *
 * 옵션 B: 이 훅은 hooks.json 에 배선되지 않는다(스탠드얼론 .mjs). 테스트가 직접 spawn 한다.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configDir, isEnabled, USAGE_LOG_PATH, LAST_FLUSH_PATH, LOG_MAX_LINES } from '../bin/lib/telemetry-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLUSH = join(HERE, 'telemetry-flush.mjs');
const FLUSH_LOCK = LAST_FLUSH_PATH + '.lock';
const DAY_MS = 24 * 60 * 60 * 1000;
// banker:<name> - 슬래시 커맨드/스킬의 정규화된 이름. i 플래그는 매칭만 관대하게(실제 이름은 소문자).
const NAME_RE = /\bbanker:[a-z0-9_-]+/i;

function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('error', rejectPromise);
  });
}

// payload 필드 미검증(파일 상단 주석 참조): 이름을 담을 법한 필드를 순서대로 시도하고,
// 못 찾으면 원시 stdin 문자열 전체에서 banker:<name> 를 스캔한다. 아무데도 없으면 null.
function extractName(payload, raw) {
  const candidates = [
    payload?.command,
    payload?.prompt,
    payload?.user_prompt,
    payload?.tool_input?.command,
    payload?.tool_input?.prompt,
    raw,
  ];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const m = c.match(NAME_RE);
    if (m) return m[0];
  }
  return null;
}

// 파일의 개행 개수 = 줄 수(각 append 가 끝에 개행을 붙이므로). 없거나 읽기 실패면 0.
function lineCount(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    return (raw.match(/\n/g) || []).length;
  } catch {
    return 0;
  }
}

// LAST_FLUSH_PATH 가 없거나 24h 초과면 flush 가 필요. best-effort(읽기 실패는 "필요"로 처리).
function flushDue() {
  try {
    return (Date.now() - statSync(LAST_FLUSH_PATH).mtimeMs) >= DAY_MS;
  } catch {
    return true;
  }
}

// herd 방지(해석 B): 여러 count 훅이 동시에 flushDue 를 보고 몰려 spawn 하는 것을 막는다.
// mkdir 락으로 검사-후-기록을 직렬화하고, 락 안에서 flushDue 를 재확인(경합 중 이미 갱신됐으면
// false)한 뒤 LAST_FLUSH_PATH 에 현재 타임스탬프를 원자적으로 기록해 다음 24h 윈도우를 연다.
// 승자만 true 를 받아 flush 를 spawn 한다.
function claimFlush() {
  try {
    // 크래시로 남은 stale 락(정상 보유 시간은 microsecond)이 flush 를 영구 wedge 하지 않도록,
    // 24h 넘은 락은 stale 로 보고 회수한다.
    if ((Date.now() - statSync(FLUSH_LOCK).mtimeMs) >= DAY_MS) rmSync(FLUSH_LOCK, { recursive: true, force: true });
  } catch {
    // 락 없음/읽기 실패 - 아래 생성 시도로 진행.
  }
  try {
    mkdirSync(FLUSH_LOCK); // 원자적: 이미 존재하면 throw -> 다른 훅이 claim 중.
  } catch {
    return false;
  }
  try {
    if (!flushDue()) return false; // 락 안 재확인: 경합 사이 누군가 이미 flush 를 열었다.
    writeFileSync(LAST_FLUSH_PATH, new Date().toISOString());
    return true;
  } finally {
    try { rmSync(FLUSH_LOCK, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function record(name) {
  try { mkdirSync(configDir(), { recursive: true }); } catch { /* best-effort */ }
  // 상한 도달 시 append 스킵(best-effort; flush 가 비우면 재개). 로그를 24h 윈도우로 상한.
  try {
    if (lineCount(USAGE_LOG_PATH) < LOG_MAX_LINES) appendFileSync(USAGE_LOG_PATH, name + '\n');
  } catch { /* best-effort */ }
  // flush 기동: 24h 초과 시 herd 방지 claim 을 이긴 훅만 detached spawn.
  try {
    if (flushDue() && claimFlush()) {
      spawn(process.execPath, [FLUSH], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* best-effort */ }
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch {
    return; // stdin 읽기 실패 - 무동작.
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // malformed stdin - 무동작.
  }
  if (!isEnabled()) return; // 미동의 - 로컬 쓰기조차 하지 않는다.
  const name = extractName(payload, raw);
  if (!name) return; // banker:<name> 없음 - 무동작.
  record(name);
}

main()
  .catch(() => {}) // 어떤 예외도 세션을 막지 않는다.
  .finally(() => process.exit(0));
