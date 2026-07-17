#!/usr/bin/env node
/*
 * banker 텔레메트리 count 훅 (UserPromptExpansion) - 사용자가 직접 호출한 /banker:<name>
 * 커맨드를 로컬 usage-log 에 `<name>\t<hour>` 한 줄로 기록한다.
 *
 * fail-closed 규약(각 항목은 telemetry-count.test.mjs 가 검증한다):
 *  - countingActive() 가 아니면 로컬 쓰기조차 하지 않는다. 파일도 만들지 않는다.
 *  - 어떤 오류도 삼키고 항상 exit 0. 세션/프롬프트를 절대 막지 않는다.
 *  - PII/식별자를 다루지 않는다. 로그 한 줄 = 이름 문자열 + TAB + hour(0-23) 뿐이다.
 *
 * payload 필드 확정(US-4 라이브 스모크테스트): UserPromptExpansion stdin payload 는
 * `command_name`(예: "banker:setup-lsp")과 `command_source`("plugin")를 담는다. 사용자가
 * /banker:* 를 직접 호출한 경우만 이 이벤트가 발화하고, 모델이 자동 호출하는 스킬은
 * PostToolUse(Skill) 쪽(telemetry-count-skill.mjs)이 담당한다 - 두 경로는 disjoint 로 실측
 * 확정되어 dedup 이 불요하다. 더 이상 방어적 다중필드 추출이 필요 없다.
 *
 * 체크인(usage-log 집계 후 서버 전송)은 이 훅의 책임이 아니다. 트리거는 SessionStart
 * update-notify 가 throttle 경과 시 별도로 연다 - 이 훅은 append 만 하고 flush/checkin 을
 * spawn 하지 않는다.
 *
 * 배선: hooks.json 의 UserPromptExpansion(matcher banker:.*)에 등록되어 사용자 직접 /banker:* 호출 시 발화한다.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';

import { configDir, countingActive, recordUsedSkill, USAGE_LOG_PATH, LOG_MAX_LINES } from '../bin/lib/telemetry-config.mjs';

// banker:<name> 전체 일치 - 이름 문자열 자체를 검증한다(TAB/개행 등 이질 문자가 섞여
// usage-log 의 `name\thour` 형식을 깨는 것을 막는다). i 플래그는 매칭만 관대하게(실제 이름은 소문자).
const NAME_RE = /^banker:[a-z0-9_-]+$/i;

function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('error', rejectPromise);
  });
}

// UserPromptExpansion payload 에서 사용자가 직접 호출한 banker:<name> 이름을 추출한다.
// command_source 가 'plugin' 이고 command_name 이 banker:<name> 형식일 때만 반환, 그 외 null.
function extractName(payload) {
  if (payload?.command_source !== 'plugin') return null;
  const name = payload?.command_name;
  return (typeof name === 'string' && NAME_RE.test(name)) ? name : null;
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

// usage-log 에 `<name>\t<hour>` 한 줄을 append 한다(hour = 로컬 시각 0-23). 상한 도달 시
// 스킵(best-effort; 체크인이 비우면 재개). flush/checkin 은 여기서 spawn 하지 않는다
// (트리거는 SessionStart update-notify 소관).
function record(name) {
  try { mkdirSync(configDir(), { recursive: true }); } catch { /* best-effort */ }
  try {
    if (lineCount(USAGE_LOG_PATH) < LOG_MAX_LINES) {
      const hour = new Date().getHours();
      appendFileSync(USAGE_LOG_PATH, `${name}\t${hour}\n`);
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
  if (!countingActive()) return; // 카운팅 비활성 - 로컬 쓰기조차 하지 않는다.
  const name = extractName(payload);
  if (!name) return; // banker:<name> 아님 - 무동작.
  record(name);            // 서버 카운팅용 usage-log append (스킬별 x 시간대 버킷).
  recordUsedSkill(name);   // 개인화 알림용 로컬 집합 union (전송 안 함; update-notify 만 로컬에서 읽는다).
}

main()
  .catch(() => {}) // 어떤 예외도 세션을 막지 않는다.
  .finally(() => process.exit(0));
