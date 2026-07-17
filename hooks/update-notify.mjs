#!/usr/bin/env node
/*
 * banker 업데이트-체크 알림 훅 (SessionStart) - 캐시된 최신 버전을 확인해 사용자에게
 * 한 번 고지하고, throttle 경과 시 백그라운드 fetcher 를 detached 로 기동한다.
 *
 * 알림 소스는 형제 fetcher(update-fetch/update-checkin)가 채운 로컬 캐시뿐이다. 이 훅 자신은
 * 네트워크를 건드리지 않는다: 포그라운드는 캐시 읽기만 하고, 갱신은 detached 자식에게 위임한다.
 *
 * fail-closed 규약(update-notify.test.mjs 가 검증):
 *  - noUpdateCheck() opt-out(env BANKER_NO_UPDATE_CHECK 또는 config.updateCheck===false)이면 무동작.
 *  - 캐시 없음·구버전·미확정(malformed) 버전 → 무고지.
 *  - 알림 채널 = stdout JSON {systemMessage} (SessionStart 공통 필드·상호작용 세션 사용자 가시·실측 확정).
 *  - 동일 latest 재고지 방지: 고지 직후 writeUpdateCache({notified: latest}) 로 기록.
 *  - 어떤 오류도 삼키고 항상 exit 0. 세션을 절대 막지 않는다. 비TTY 안전.
 */
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  UPDATE_CHECK_PATH, UPDATE_THROTTLE_MS,
  noUpdateCheck, countingActive, endpoint,
  installedVersion, compareVersions, writeUpdateCache, readUsedSkills,
} from '../bin/lib/telemetry-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 업데이트 안내에 쓰는 npm 패키지 이름(고지 문구·이모지/em-dash 없음).
const NPM_PKG = '@kaydash9999/banker-plugins';

function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('error', rejectPromise);
  });
}

// 캐시({latest,checkedAt,notified})를 객체로 반환. 없음·malformed·배열 → null(무고지·throttle 경과 취급).
function readCache() {
  try {
    const obj = JSON.parse(readFileSync(UPDATE_CHECK_PATH, 'utf8'));
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
  } catch {
    return null;
  }
}

// 캐시의 changedSkills(새 버전에서 바뀐 스킬)와 로컬 "써 본 스킬"의 교집합을 반환한다(순서=changedSkills 기준).
// changedSkills 없음/비배열·써 본 스킬 없음이면 [](일반 알림으로 폴백). 로컬 파일만 읽고 네트워크는 없다.
// 개인화는 사용량 카운팅에 기반하므로 countingActive() 가 아니면(BANKER_NO_TELEMETRY 등) 이미 쌓인 로컬
// 집합이 있어도 표시하지 않는다 — 기록과 표시가 같은 텔레메트리 게이트를 따른다(PRIVACY.md 정합).
function personalizedSkills(cached) {
  if (!countingActive()) return []; // 텔레메트리 opt-out - 개인화 표시 안 함(일반 알림으로 폴백).
  const changed = Array.isArray(cached?.changedSkills) ? cached.changedSkills : [];
  if (!changed.length) return [];
  const used = new Set(readUsedSkills());
  return changed.filter((s) => typeof s === 'string' && used.has(s));
}

// 고지 문구를 만든다. 개인화 교집합이 있으면 바뀐 스킬 이름을 넣고(최대 5개 + "외 N개"), 없으면 일반 문구
// (기존 동작). banker: 접두는 떼서 짧게. 이모지/em-dash 없음(사용자 가시 채널).
function buildMessage(latest, installed, cached) {
  const head = `banker ${latest} 사용 가능 (현재 ${installed}).`;
  const tail = `업데이트: /banker:update-banker 또는 npm i -g ${NPM_PKG}`;
  const hits = personalizedSkills(cached);
  if (hits.length) {
    const names = hits.slice(0, 5).map((s) => s.replace(/^banker:/, '')).join(', ');
    const more = hits.length > 5 ? ` 외 ${hits.length - 5}개` : '';
    return `${head} 자주 쓰는 스킬이 이번 업데이트에서 바뀌었습니다: ${names}${more}. ${tail}`;
  }
  return `${head} ${tail}`;
}

// 캐시 latest 가 설치 버전보다 엄격히 크고 그 버전을 아직 고지하지 않았으면 systemMessage 로 1회 고지.
// compareVersions null(미확정·malformed)·구버전·동일 → 무고지. 고지 후 notified 를 기록해 재고지를 막는다.
// 고지 문구는 buildMessage 가 만든다(로컬 changedSkills∩써본스킬이 있으면 개인화, 없으면 일반).
function maybeNotify(cached) {
  if (!cached) return;
  const installed = installedVersion();
  const cmp = compareVersions(cached.latest, installed);
  if (cmp === null || cmp <= 0) return;          // 미확정/구/동일 → 무고지
  if (cached.notified === cached.latest) return;  // 이미 고지한 버전 → dedupe
  const msg = buildMessage(cached.latest, installed, cached);
  process.stdout.write(JSON.stringify({ systemMessage: msg }));
  writeUpdateCache({ notified: cached.latest }); // 형제 필드(latest/checkedAt/changedSkills) 보존하며 notified 만 병합.
}

// checkedAt 기준 throttle 경과 여부. 캐시 없음·checkedAt 미기록/비수치 → 경과로 본다(첫 조회 유도).
function throttleElapsed(cached) {
  const checkedAt = cached?.checkedAt;
  if (typeof checkedAt !== 'number') return true;
  return (Date.now() - checkedAt) >= UPDATE_THROTTLE_MS;
}

// 갱신 fetcher 절대경로 결정: count-default-on 활성(countingActive) + 엔드포인트 설정 시
// update-checkin.mjs(체크인이 알림 조회를 겸함), 그 외에는 update-fetch.mjs(공개 npm GET 폴백).
// 경로는 이 파일 기준으로 resolve 한다. (형제 스토리가 생성 중 - 런타임에 존재하면 된다.)
export function chooseFetcher() {
  const useCheckin = countingActive() && !!endpoint();
  return join(HERE, useCheckin ? 'update-checkin.mjs' : 'update-fetch.mjs');
}

// 갱신 fetcher 를 detached 로 기동(포그라운드 비차단). 부재/실패는 자식에서 무해히 종료된다.
function spawnFetcher() {
  try {
    spawn(process.execPath, [chooseFetcher()], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // best-effort: 기동 실패는 삼킨다(다음 세션이 재시도).
  }
}

async function main() {
  // SessionStart payload 를 드레인(파이프 위생). 내용을 쓰지 않으므로 파싱 실패해도 무해.
  try { await readStdin(); } catch { /* stdin 없음/오류 무해 */ }

  if (noUpdateCheck()) return; // opt-out - 무동작.

  const cached = readCache(); // 포그라운드는 캐시 읽기만(네트워크 없음).
  maybeNotify(cached);
  if (throttleElapsed(cached)) spawnFetcher(); // 갱신은 백그라운드로 위임.
}

// 직접 실행(훅)일 때만 main() 을 돌린다. import(테스트)시엔 chooseFetcher 만 노출하고 main 은 미실행.
// run.cjs 가 realpath 로 resolve 한 뒤 argv[1] 로 넘겨도(심링크 배포) 양쪽을 realpath 비교해 일치시킨다.
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main()
    .catch(() => {}) // 어떤 예외도 세션을 막지 않는다.
    .finally(() => process.exit(0));
}
