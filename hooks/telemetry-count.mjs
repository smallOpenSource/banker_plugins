#!/usr/bin/env node
/*
 * banker 텔레메트리 count 훅 (UserPromptExpansion) - 사용자가 직접 호출한 /banker:<name>
 * 커맨드를 로컬 usage-log 에 `<name>\t<hour>` 한 줄로 기록한다.
 *
 * fail-closed 규약(각 항목은 telemetry-count.test.mjs 가 검증한다):
 *  - countingActive() 가 아니면 로컬 쓰기조차 하지 않는다. 파일도 만들지 않는다.
 *  - 기록 자리가 FIFO 면 기다리지 않고, 링크나 하드 링크면 그 너머에 쓰지 않는다(Windows 는 열기 전에 본다).
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
import { appendUsageLog, countingActive, recordUsedSkill, SKILL_NAME_RE } from '../bin/lib/telemetry-config.mjs';

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
// 이름은 telemetry-config 의 SKILL_NAME_RE 전체 일치로 검증한다(TAB, 개행 같은 글자가 usage-log 의
// `name\thour` 형식을 깨지 않게).
// command_source 가 'plugin' 이고 command_name 이 banker:<name> 형식일 때만 반환, 그 외 null.
function extractName(payload) {
  if (payload?.command_source !== 'plugin') return null;
  const name = payload?.command_name;
  return (typeof name === 'string' && SKILL_NAME_RE.test(name)) ? name : null;
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
  appendUsageLog(name);    // 서버 카운팅용 usage-log 한 줄 (스킬별 x 시간대 버킷). 상한이면 건너뛴다.
  recordUsedSkill(name);   // 개인화 알림용 로컬 집합 union (전송 안 함; update-notify 만 로컬에서 읽는다).
}

main()
  .catch(() => {}) // 어떤 예외도 세션을 막지 않는다.
  .finally(() => process.exit(0));
