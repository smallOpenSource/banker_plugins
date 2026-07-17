#!/usr/bin/env node
/*
 * banker 텔레메트리 flush 훅 - usage-log 를 커맨드별 count 로 집계해 엔드포인트로 한 번 POST 하고,
 * 전송 시도 후(성공/실패 무관) 로그를 truncate 해 24h 윈도우로 상한한다.
 *
 * fail-closed 규약(각 항목은 telemetry-flush.test.mjs 가 검증한다):
 *  - 미동의(isEnabled) 또는 엔드포인트 없음이면 무동작(로그도 건드리지 않는다).
 *  - PII/IP/식별자 절대 미포함. 페이로드는 {counts, version, os} 세 키뿐(os=플랫폼 계열).
 *  - 자체 네트워크 timeout 으로 hang 방지. 어떤 오류도 삼키고 항상 exit 0.
 *
 * 옵션 B: 이 훅은 hooks.json 에 배선되지 않는다(스탠드얼론 .mjs). count 훅이 detached spawn 한다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEnabled, endpoint, USAGE_LOG_PATH, LAST_FLUSH_PATH } from '../bin/lib/telemetry-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_JSON = resolve(HERE, '..', '.claude-plugin', 'plugin.json');
const NET_TIMEOUT_MS = 10_000;

// 플러그인 버전(.claude-plugin/plugin.json). 읽기 실패 시 'unknown'.
function pluginVersion() {
  try {
    const v = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8')).version;
    return typeof v === 'string' && v ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

// 로그 각 줄(커맨드 이름)을 이름별 count 로 집계. 빈 줄은 무시.
function aggregate(raw) {
  const counts = {};
  for (const line of raw.split('\n')) {
    const name = line.trim();
    if (!name) continue;
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

// loopback 호스트만 평문 http 를 허용한다(로컬 테스트 mock 전용). URL.hostname 은 IPv6 를
// 대괄호로 감싸므로([::1]) 벗겨서 비교한다.
function isLoopback(hostname) {
  const h = (hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

// 엔드포인트로 JSON POST. 어떤 경로에서도 reject 하지 않고, 전송 시도가 끝나면 resolve 한다.
// 자체 timeout(NET_TIMEOUT_MS)으로 accept-후-무응답 엔드포인트에도 hang 하지 않는다.
function post(url, body) {
  return new Promise((resolvePromise) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolvePromise(); } };
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
        res.on('data', () => {}); // 응답 본문을 흘려보내 'end' 가 발화하게 한다.
        res.on('end', finish);
        res.on('error', finish);
      });
      req.on('error', finish); // 연결 거부/리셋 등은 즉시 여기로.
      req.setTimeout(NET_TIMEOUT_MS, () => req.destroy());
      req.write(body);
      req.end();
    } catch {
      finish();
    }
  });
}

async function main() {
  if (!isEnabled()) return; // 미동의 - 무동작.
  const url = endpoint();
  if (!url) return; // 엔드포인트 없음 - 무동작.

  let raw;
  try {
    raw = readFileSync(USAGE_LOG_PATH, 'utf8');
  } catch {
    return; // 로그 없음 - 보낼 것 없음.
  }

  // PII/IP/식별자 없음: counts(이름 -> 횟수) + version + os(플랫폼 계열)뿐.
  const payload = JSON.stringify({ counts: aggregate(raw), version: pluginVersion(), os: process.platform });
  await post(url, payload);

  // 전송 시도 후(성공/실패 무관) 로그를 비워 24h 윈도우로 상한(배치 유실 허용).
  try { writeFileSync(USAGE_LOG_PATH, ''); } catch { /* best-effort */ }
  try { writeFileSync(LAST_FLUSH_PATH, new Date().toISOString()); } catch { /* best-effort */ }
}

main()
  .catch(() => {}) // 어떤 예외도 삼킨다.
  .finally(() => process.exit(0));
