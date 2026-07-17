#!/usr/bin/env node
/*
 * banker 업데이트 알림 fetcher 훅 - npm 레지스트리에서 최신 버전을 조회해 update-check 캐시를 갱신한다.
 * SessionStart 알림 훅(update-notify)이 이 fetcher 를 detached 로 기동해 캐시를 채우고, 알림 렌더링
 * 자체는 캐시만 읽는 별도 훅이 담당한다(이 파일은 네트워크 조회만 - 화면 출력 없음).
 *
 * fail-closed 규약(각 항목은 update-fetch.test.mjs 가 검증한다):
 *  - throttle(UPDATE_THROTTLE_MS) 미경과면 무동작(캐시가 없으면 진행).
 *  - 비-https 는 loopback(localhost/127.0.0.1/::1) 에서만 http 허용, 그 외 비-https 는 거부.
 *  - 3xx 리다이렉트는 따라가지 않고 no-op.
 *  - 응답 JSON 에서 version 문자열만 방어 추출 - 없거나 비문자열이면 무동작(캐시 미기록).
 *  - 캐시는 writeUpdateCache 로 병합 기록: fetch 된 latest 가 기존 캐시와 다르면 notified 를 초기화
 *    (재무장)하고, 같으면 형제 필드(notified 등)를 patch 에서 생략해 그대로 보존한다.
 *  - 어떤 오류도 삼키고 항상 exit 0. GET 뿐이라 페이로드/식별자 전송이 없다.
 *
 * 이 훅은 hooks.json 에 배선되지 않는다(스탠드얼론 .mjs). update-notify 가 detached spawn 한다.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

import { UPDATE_CHECK_PATH, UPDATE_THROTTLE_MS, NPM_LATEST_URL, writeUpdateCache } from '../bin/lib/telemetry-config.mjs';

const NET_TIMEOUT_MS = 10_000;

// loopback 호스트만 평문 http 를 허용한다(로컬 테스트 mock 전용). update-checkin.mjs 와 동일 판별:
// URL.hostname 은 IPv6 를 대괄호로 감싸므로([::1]) 벗겨서 비교한다.
function isLoopback(hostname) {
  const h = (hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

// update-check 캐시를 읽어 객체로 반환. 없음·malformed·권한 오류 등 어떤 예외에도 던지지 않고 {} 반환.
function readCache() {
  try {
    const obj = JSON.parse(readFileSync(UPDATE_CHECK_PATH, 'utf8'));
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch {
    return {};
  }
}

// url 에 GET 요청해 응답 JSON 의 version 문자열만 추출한다. 실패·거부·리다이렉트·malformed 는 전부
// null. reject 하지 않고 항상 resolve 한다(hang 방지). GET 뿐이라 페이로드·식별자 헤더가 없다.
function fetchLatestVersion(url) {
  return new Promise((resolvePromise) => {
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolvePromise(result); } };
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
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const obj = JSON.parse(data);
            const v = obj && typeof obj === 'object' ? obj.version : undefined;
            finish((typeof v === 'string' && v) ? v : null);
          } catch {
            finish(null); // 빈/malformed 본문.
          }
        });
        res.on('error', () => finish(null));
      });
      req.on('error', () => finish(null)); // 연결 거부/리셋 등은 즉시 여기로.
      req.setTimeout(NET_TIMEOUT_MS, () => req.destroy());
      req.end(); // GET - 요청 본문 없음.
    } catch {
      finish(null);
    }
  });
}

async function main() {
  const cache = readCache();
  const checkedAt = typeof cache.checkedAt === 'number' ? cache.checkedAt : null;
  if (checkedAt !== null && (Date.now() - checkedAt) < UPDATE_THROTTLE_MS) return; // throttle 미경과 - no-op.

  const url = process.env.BANKER_NPM_URL || NPM_LATEST_URL; // 테스트 주입용 override.
  const latest = await fetchLatestVersion(url);
  if (!latest) return; // 조회 실패·거부·malformed - 캐시 미기록.

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
