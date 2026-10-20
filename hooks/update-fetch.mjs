#!/usr/bin/env node
/*
 * banker 업데이트 알림 fetcher 훅 - npm 레지스트리에서 최신 버전을 조회해 update-check 캐시를 갱신한다.
 * SessionStart 알림 훅(update-notify)이 이 fetcher 를 detached 로 기동해 캐시를 채우고, 알림 렌더링
 * 자체는 캐시만 읽는 별도 훅이 담당한다(이 파일은 네트워크 조회만 - 화면 출력 없음).
 *
 * fail-closed 규약(각 항목은 update-fetch.test.mjs 가 검증한다):
 *  - 마지막 성공(checkedAt)이나 마지막 실패한 시도(triedAt)에서 하루가 지나지 않았으면 무동작(updateCheckDue).
 *  - 비-https 는 loopback(localhost/127.0.0.1/::1) 에서만 http 허용, 그 외 비-https 는 거부.
 *  - 3xx 리다이렉트는 따라가지 않고 no-op.
 *  - 무활동 10초 timeout 과 요청마다 30초 교환 전체 마감으로 hang 하지 않는다.
 *  - 응답 본문은 256KiB 까지만 모은다. 넘으면 연결을 끊고 그 응답을 쓰지 않는다.
 *  - 응답 JSON 에서 version 문자열만 방어 추출. 버전을 얻지 못하면(조회 실패, 거부, 없거나 비문자열) 시도 시각
 *    (triedAt)만 써서 하루를 쉰다. latest 와 checkedAt 은 쓰지 않는다.
 *  - 캐시는 writeUpdateCache 로 병합 기록: fetch 된 latest 가 기존 캐시와 다르면 notified 를 초기화
 *    (재무장)하고, 같으면 형제 필드(notified 등)를 patch 에서 생략해 그대로 보존한다.
 *  - 어떤 오류도 삼키고 항상 exit 0. GET 뿐이라 페이로드/식별자 전송이 없다.
 *
 * 이 훅은 hooks.json 에 배선되지 않는다(스탠드얼론 .mjs). update-notify 가 detached spawn 한다.
 */
import http from 'node:http';
import https from 'node:https';

import {
  UPDATE_CHECK_PATH, NPM_LATEST_URL, writeUpdateCache, collectBody, netDeadlineMs, readRegular, updateCheckDue,
} from '../bin/lib/telemetry-config.mjs';

const NET_TIMEOUT_MS = 10_000;
const NET_DEADLINE_MS = netDeadlineMs(); // 교환 전체 마감(위 값은 무활동 기준).
const MAX_BODY_BYTES = 256 * 1024; // npm /latest 응답은 수 KB 다.

// loopback 호스트만 평문 http 를 허용한다(로컬 테스트 mock 전용). update-checkin.mjs 와 동일 판별:
// URL.hostname 은 IPv6 를 대괄호로 감싸므로([::1]) 벗겨서 비교한다.
function isLoopback(hostname) {
  const h = (hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

// update-check 캐시를 읽어 객체로 반환. 없음·malformed·권한 오류·일반 파일 아님(FIFO 를 기다리지 않음) 등 어떤
// 예외에도 던지지 않고 {} 반환.
function readCache() {
  try {
    const obj = JSON.parse(readRegular(UPDATE_CHECK_PATH));
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch {
    return {};
  }
}

// url 에 GET 요청해 응답 JSON 의 version 문자열만 추출한다. 실패·거부·리다이렉트·malformed 는 전부
// null. reject 하지 않고 항상 resolve 한다(무활동 timeout 과 교환 전체 마감, 본문 256KiB 상한). GET 뿐이라
// 페이로드·식별자 헤더가 없다.
function fetchLatestVersion(url) {
  return new Promise((resolvePromise) => {
    let done = false;
    let deadline = null;
    const finish = (result) => { if (!done) { done = true; clearTimeout(deadline); resolvePromise(result); } };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return finish(null); // 잘못된 URL - 조회 스킵.
    }
    // 비-https 는 loopback 로컬 테스트 mock 에만 허용, 그 외 스킴/호스트는 no-op(fail-closed).
    if (parsed.protocol === 'http:') {
      if (!isLoopback(parsed.hostname)) return finish(null);
    } else if (parsed.protocol !== 'https:') {
      return finish(null);
    }
    const transport = parsed.protocol === 'http:' ? http : https;
    try {
      const req = transport.request(parsed, { method: 'GET' }, (res) => {
        const status = res.statusCode || 0;
        // 3xx 리다이렉트는 따라가지 않는다: 응답을 흘려보내고 no-op 으로 종료.
        if (status >= 300 && status < 400) {
          res.resume();
          return finish(null);
        }
        collectBody(res, MAX_BODY_BYTES, (data) => {
          try {
            const obj = JSON.parse(data); // data null(한도 초과, 스트림 오류)은 null 로 읽혀 version 이 없다.
            const v = obj && typeof obj === 'object' ? obj.version : undefined;
            finish((typeof v === 'string' && v) ? v : null);
          } catch {
            finish(null); // 빈/malformed 본문.
          }
        });
      });
      req.on('error', () => finish(null)); // 연결 거부/리셋 등은 즉시 여기로.
      req.setTimeout(NET_TIMEOUT_MS, () => req.destroy());
      deadline = setTimeout(() => { req.destroy(); finish(null); }, NET_DEADLINE_MS);
      req.end(); // GET - 요청 본문 없음.
    } catch {
      finish(null);
    }
  });
}

async function main() {
  const cache = readCache();
  if (!updateCheckDue(cache)) return; // 성공이나 실패한 시도에서 하루가 지나지 않음 - no-op.

  const url = process.env.BANKER_NPM_URL || NPM_LATEST_URL; // 테스트 주입용 override.
  const latest = await fetchLatestVersion(url);
  if (!latest) { // 조회 실패·거부·malformed - 버전은 쓰지 않고 시도 시각만 남겨 하루를 쉰다.
    writeUpdateCache({ triedAt: Date.now() });
    return;
  }

  // 개인화 매니페스트는 여기서 조회하지 않는다: update-fetch 는 카운팅 opt-out(countingActive false) 경로의
  // fetcher 이고, 개인화 표시도 countingActive() 로 게이트되므로 이 경로에선 표시될 일이 없다. 매니페스트
  // 조회는 카운팅 활성 경로의 update-checkin 만 수행한다(중복·죽은 조회 제거).
  const cachedLatest = typeof cache.latest === 'string' ? cache.latest : null;
  if (cachedLatest !== latest) {
    writeUpdateCache({ latest, checkedAt: Date.now(), notified: null }); // 신버전 - notified 재무장.
  } else {
    writeUpdateCache({ latest, checkedAt: Date.now() }); // 동일 버전 - notified 등 형제 필드는 병합 보존.
  }
}

main()
  .catch(() => {}) // 어떤 예외도 삼킨다.
  .finally(() => process.exit(0));
