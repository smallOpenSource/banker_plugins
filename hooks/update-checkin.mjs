#!/usr/bin/env node
/*
 * banker 카운팅 체크인 훅 - usage-log 를 스킬별 x 시간대(hour 0-23)별 count 로 집계해 엔드포인트로
 * 한 번 POST 하고, 응답의 latest 로 update-check 캐시를 겸해 갱신한다. 전송 시도 후(성공/실패 무관)
 * 로그를 truncate 해 24h 윈도우로 상한한다. telemetry-flush 를 대체(evolve)한다.
 *
 * fail-closed 규약(각 항목은 update-checkin.test.mjs 가 검증한다):
 *  - 미활성(countingActive) 또는 엔드포인트 없음이면 무동작(로그도 건드리지 않는다).
 *  - PII/IP/지속ID 절대 미포함. 페이로드는 {version, os, counts} 세 키뿐(os=플랫폼 계열,
 *    counts=스킬별 x 시간대별 호출수).
 *  - 자체 네트워크 timeout 으로 hang 방지. 어떤 오류도 삼키고 항상 exit 0. 어떤 경로도 reject 안 함.
 *  - 비-loopback 평문 http 는 전송하지 않는다(https-only). loopback http 만 로컬 테스트 mock 에 허용.
 *
 * count-default-on: 이 훅은 hooks.json 에 배선되지 않는다(스탠드얼론 .mjs). update-notify 가
 * countingActive + 엔드포인트 설정 시 fetcher 로 detached spawn 한다(응답 latest 가 알림 캐시를 겸함).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

import {
  countingActive,
  endpoint,
  USAGE_LOG_PATH,
  LAST_FLUSH_PATH,
  SKILL_CHANGES_URL,
  installedVersion,
  writeUpdateCache,
  changedSkillsBetween,
} from '../bin/lib/telemetry-config.mjs';

const NET_TIMEOUT_MS = 10_000;

// usage-log 각 줄 `<name>\t<hour 0-23>` 를 스킬별 x 시간대별 count 로 집계한다.
// 빈 줄·TAB 없는 줄·이름 없는 줄·hour 가 0-23 정수가 아닌 줄은 무시한다.
// 반환 예: { 'banker:compact-copy': { '9': 3, '14': 1 }, 'banker:setup': { '9': 1 } }.
function aggregate(raw) {
  const counts = {};
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;              // 빈 줄 무시.
    const tab = line.indexOf('\t');
    if (tab < 0) continue;                    // TAB 없는 malformed 줄 무시.
    const name = line.slice(0, tab).trim();
    const hourStr = line.slice(tab + 1).trim();
    if (!name) continue;                      // 이름 없는 줄 무시.
    if (!/^\d+$/.test(hourStr)) continue;     // 정수 아닌 hour 무시(음수·소수·비수치 배제).
    const hour = Number(hourStr);
    if (hour > 23) continue;                  // 0-23 범위 밖 무시(하한은 \d+ 가 보장).
    const key = String(hour);                 // '09' -> '9' 정규화.
    if (!counts[name]) counts[name] = {};
    counts[name][key] = (counts[name][key] || 0) + 1;
  }
  return counts;
}

// loopback 호스트만 평문 http 를 허용한다(로컬 테스트 mock 전용). update-fetch.mjs 와 동일 판별:
// URL.hostname 은 IPv6 를 대괄호로 감싸므로([::1]) 벗겨서 비교한다.
function isLoopback(hostname) {
  const h = (hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

// 엔드포인트로 JSON POST. 어떤 경로에서도 reject 하지 않고, 전송 시도가 끝나면 응답 본문(문자열)
// 또는 null 로 resolve 한다. 자체 timeout(NET_TIMEOUT_MS)으로 무응답 엔드포인트에도 hang 하지 않는다.
function post(url, body) {
  return new Promise((resolvePromise) => {
    let done = false;
    const finish = (responseBody = null) => { if (!done) { done = true; resolvePromise(responseBody); } };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return finish(); // 잘못된 엔드포인트 - 전송 스킵.
    }
    // PRIVACY.md 정합: 비-loopback 엔드포인트에는 https 만 허용한다. 평문 http 는
    // loopback(localhost/127.0.0.1/::1) 로컬 테스트 mock 에만, http/https 외 스킴은
    // 전송하지 않고 no-op(fail-closed). 평문 비-loopback 유출을 원천 차단한다.
    if (parsed.protocol === 'http:') {
      if (!isLoopback(parsed.hostname)) return finish();
    } else if (parsed.protocol !== 'https:') {
      return finish();
    }
    const transport = parsed.protocol === 'http:' ? http : https;
    try {
      const req = transport.request(parsed, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => finish(data));
        res.on('error', () => finish());
      });
      req.on('error', () => finish()); // 연결 거부/리셋 등은 즉시 여기로.
      req.setTimeout(NET_TIMEOUT_MS, () => req.destroy());
      req.write(body);
      req.end();
    } catch {
      finish();
    }
  });
}

// 응답 본문에서 latest 버전 문자열만 방어 추출. null·비문자열·빈·malformed·비문자열 latest 값 → null.
function extractLatest(responseBody) {
  if (typeof responseBody !== 'string' || !responseBody) return null;
  try {
    const obj = JSON.parse(responseBody);
    const v = (obj && typeof obj === 'object') ? obj.latest : undefined;
    return (typeof v === 'string' && v) ? v : null;
  } catch {
    return null;
  }
}

// 변경-스킬 매니페스트(공개 GitHub raw JSON: {"x.y.z": ["banker:skill", ...]})를 GET 해 객체로 반환한다.
// update-fetch 의 동일 함수와 self-contained 로 나란히 둔다(훅별 자기완결 관례·isLoopback 도 이미 각자 보유).
// post() 와 동일한 안전 가드: 비-https 는 loopback 만 허용·3xx no-op·자체 timeout·malformed→null. 어떤
// 실패에도 reject 하지 않고 null 로 resolve 한다(개인화는 best-effort). 비배열 객체만 반환.
function fetchSkillChangesMap(url) {
  return new Promise((resolvePromise) => {
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolvePromise(result); } };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return finish(null);
    }
    if (parsed.protocol === 'http:') {
      if (!isLoopback(parsed.hostname)) return finish(null);
    } else if (parsed.protocol !== 'https:') {
      return finish(null);
    }
    const transport = parsed.protocol === 'http:' ? http : https;
    try {
      const req = transport.request(parsed, { method: 'GET' }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) { res.resume(); return finish(null); } // 리다이렉트 미추적.
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const obj = JSON.parse(data);
            finish((obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null);
          } catch {
            finish(null);
          }
        });
        res.on('error', () => finish(null));
      });
      req.on('error', () => finish(null));
      req.setTimeout(NET_TIMEOUT_MS, () => req.destroy());
      req.end(); // GET - 요청 본문 없음.
    } catch {
      finish(null);
    }
  });
}

async function main() {
  if (!countingActive()) return; // 미활성 - 무동작(로그 미변경).
  const url = endpoint();
  if (!url) return;              // 엔드포인트 없음 - 무동작(로그 미변경).

  // 로그 없음도 유효한 체크인(설치 펄스 + 알림 fetch 겸함): 빈 counts 로 진행한다.
  let raw = '';
  try { raw = readFileSync(USAGE_LOG_PATH, 'utf8'); } catch { raw = ''; }

  // PII/IP/지속ID 없음: version + os(플랫폼 계열) + counts(스킬별 x 시간대)뿐.
  const payload = JSON.stringify({
    version: installedVersion() || 'unknown',
    os: process.platform,
    counts: aggregate(raw),
  });
  const responseBody = await post(url, payload);

  // 응답의 latest 로 공유 update-check 캐시를 갱신(알림 겸함). 없으면 캐시 미변경.
  // update-fetch 처럼 notified:null 재무장을 하지 않아도 등가다: dedupe 판정이 notified===latest
  // (update-notify)라 전진 버전에서 구 notified 는 항상 신 latest 와 달라 재고지가 정상 발화하고,
  // count-default-on 은 이 훅만·npm 배포는 update-fetch 만 써 같은 캐시를 겹쳐 쓰지 않는다.
  const latest = extractLatest(responseBody);
  if (latest) {
    // 개인화용: 변경-스킬 매니페스트를 best-effort GET(실패 시 changedSkills 생략, 기존 값 보존).
    const changesUrl = process.env.BANKER_SKILL_CHANGES_URL || SKILL_CHANGES_URL; // 테스트 주입용 override.
    const map = await fetchSkillChangesMap(changesUrl);
    const patch = { latest, checkedAt: Date.now() };
    if (map) patch.changedSkills = changedSkillsBetween(map, installedVersion(), latest);
    try { writeUpdateCache(patch); } catch { /* best-effort */ }
  }

  // 전송 시도 후(성공/실패 무관) 로그를 비워 24h 윈도우로 상한(배치 유실 허용).
  try { writeFileSync(USAGE_LOG_PATH, ''); } catch { /* best-effort */ }
  try { writeFileSync(LAST_FLUSH_PATH, new Date().toISOString()); } catch { /* best-effort */ }
}

main()
  .catch(() => {}) // 어떤 예외도 삼킨다.
  .finally(() => process.exit(0));
