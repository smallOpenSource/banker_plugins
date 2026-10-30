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
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  UPDATE_CHECK_PATH, updateCheckDue,
  noUpdateCheck, countingActive, endpoint,
  installedVersion, compareVersions, writeUpdateCache, readUsedSkills, readRegular,
  CODEX_SHAPE_MISS_PATH, writeByRename, configDir, randomHex,
} from '../bin/lib/telemetry-config.mjs';
import { CODEX_NAMES } from '../bin/lib/codex-names.mjs';
import { codexCliVersion, codexHomeOf, DEFAULT_MARKETPLACE, dualInstallNote, homeInSession, hookPlaces, pluginRootInfo, pluginVersionNote, writableRootsNote } from '../bin/lib/codex-routes.mjs';
import { codexVersionOf } from './telemetry-count-codex.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 업데이트 안내에 쓰는 npm 패키지 이름(고지 문구·이모지/em-dash 없음).
const NPM_PKG = '@kaydash9999/banker-plugins';
// Codex 의 훅은 --codex 를 받는다. 그중 Codex 플러그인(codex/hooks.json)의 훅은 --plugin 도 받는다. npm 길의 훅은
// banker setup --codex 가 <CODEX_HOME>/hooks.json 에 넣는다.
const CODEX = process.argv.includes('--codex');
const PLUGIN = CODEX && process.argv.includes('--plugin');
// Codex 에서 banker 스킬을 부르는 이름: npm 길은 $banker-<이름>, 플러그인은 $banker:<이름>.
const skillCall = (name) => (PLUGIN ? `$banker:${name}` : `$banker-${name}`);
// 알림에 보이는 스킬 이름. 바뀐 스킬 목록은 Claude 이름이라 Codex 에서는 Codex 이름으로(setup-omc 는 setup-omx).
export const shownName = (name, codex = CODEX) => (codex && Object.hasOwn(CODEX_NAMES, name) ? CODEX_NAMES[name] : name);

function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('error', rejectPromise);
  });
}

// 캐시({latest,checkedAt,notified})를 객체로 반환. 없음·malformed·배열·일반 파일 아님(FIFO 를 기다리지 않음) → null
// (무고지·throttle 경과 취급).
function readCache() {
  try {
    const obj = JSON.parse(readRegular(UPDATE_CHECK_PATH));
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
  // Codex 에는 /banker: 명령이 없어 스킬 이름과 그 설치 길의 갱신 명령을 안내한다. 플러그인은 마켓플레이스를 올리면
  // 설치된 플러그인도 새 판으로 바뀌고, Codex 는 세션을 시작할 때 git 마켓플레이스를 스스로 올린다(0.144.5 실측).
  const mkt = pluginRootInfo(process.env.PLUGIN_ROOT)?.marketplace ?? DEFAULT_MARKETPLACE;
  const tail = PLUGIN
    ? `업데이트: Codex 가 세션을 시작할 때 마켓플레이스와 함께 올립니다. 바로 올리려면 codex plugin marketplace upgrade ${mkt} 뒤 Codex 를 다시 여십시오`
    : CODEX
      ? `업데이트: ${skillCall('update-banker')} 또는 npm i -g ${NPM_PKG} 뒤 banker setup --codex`
      : `업데이트: /banker:update-banker 또는 npm i -g ${NPM_PKG}`;
  const hits = personalizedSkills(cached);
  if (hits.length) {
    const names = hits.slice(0, 5).map((s) => shownName(s.replace(/^banker:/, ''))).join(', ');
    const more = hits.length > 5 ? ` 외 ${hits.length - 5}개` : '';
    return `${head} 자주 쓰는 스킬이 이번 업데이트에서 바뀌었습니다: ${names}${more}. ${tail}`;
  }
  return `${head} ${tail}`;
}

// 캐시 latest 가 설치 버전보다 엄격히 크고 그 버전을 아직 고지하지 않았으면 systemMessage 로 1회 고지.
// compareVersions null(미확정·malformed)·구버전·동일 → 무고지. 고지 후 notified 를 기록해 재고지를 막는다.
// 고지 문구는 buildMessage 가 만든다(로컬 changedSkills∩써본스킬이 있으면 개인화, 없으면 일반).
function maybeNotify(cached) {
  if (!cached) return '';
  const installed = installedVersion();
  const cmp = compareVersions(cached.latest, installed);
  if (cmp === null || cmp <= 0) return '';          // 미확정/구/동일 → 무고지
  if (cached.notified === cached.latest) return '';  // 이미 고지한 버전 → dedupe
  writeUpdateCache({ notified: cached.latest }); // 형제 필드(latest/checkedAt/changedSkills) 보존하며 notified 만 병합.
  return buildMessage(cached.latest, installed, cached);
}

// Codex: 사용량 카운팅 훅이 이 Codex 판의 기록 형식을 읽지 못했으면(codex-shape-miss.json) 한 번 알린다.
// 카운트가 조용히 0 으로 남지 않게 하려는 것이다. 업데이트 확인을 끈 사용자에게도 알린다.
export function shapeMissNotice() {
  try {
    const miss = JSON.parse(readRegular(CODEX_SHAPE_MISS_PATH));
    if (!miss || typeof miss.version !== 'string' || miss.notified) return '';
    writeByRename(CODEX_SHAPE_MISS_PATH, JSON.stringify({ version: miss.version, notified: true }));
    return `banker 사용량 카운팅이 Codex ${miss.version.slice(0, 40)} 의 기록 형식을 읽지 못함. ${skillCall('update-banker')} 로 banker 를 업데이트하고, 그래도 같으면 알려 주십시오`;
  } catch {
    return '';
  }
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

// Codex: npm 길과 플러그인 길이 함께 있으면 알린다. 세션마다 한 번만 알리는 일은 claimSession 이 맡는다.
export function dualNotice(payload, env = process.env) {
  try {
    const cwd = typeof payload?.cwd === 'string' ? payload.cwd : '';
    return dualInstallNote(codexHomeOf(payload?.transcript_path, env), cwd);
  } catch {
    return '';
  }
}

// Codex 플러그인 길: Codex 판이 플러그인 스킬 목록을 읽는다고 확인한 판(0.160.1)보다 낮으면 알린다. 판은 기록 첫 줄의
// cli_version 에서, 없으면 codex --version 에서 읽는다. 판을 모르면 알리지 않는다.
export function pluginVersionNotice(payload, plugin = PLUGIN, spawnFn = spawnSync) {
  if (!plugin) return '';
  try {
    const file = typeof payload?.transcript_path === 'string' ? payload.transcript_path : '';
    return pluginVersionNote((file && codexVersionOf(file)) || codexCliVersion(spawnFn));
  } catch {
    return '';
  }
}

// Codex: Codex 홈이 이 세션 폴더 안(맨 위 .codex 말고)이면 알린다. 샌드박스 안의 세션이 설정과 훅을 고칠 수 있는 곳이다.
// SessionStart 는 모델이 움직이기 전에 돈다.
export function sessionHomeNotice(payload, env = process.env) {
  try {
    const cwd = typeof payload?.cwd === 'string' ? payload.cwd : '';
    const home = codexHomeOf(payload?.transcript_path, env);
    if (!homeInSession(home, cwd)) return '';
    return `banker: Codex 홈(${home})이 이 세션 폴더 안에 있어 샌드박스가 그 설정과 훅을 고칠 수 있습니다. 세션 폴더 밖의 Codex 홈(CODEX_HOME)을 쓰십시오`;
  } catch {
    return '';
  }
}

// Codex: 두 길의 SessionStart 훅이 모두 신뢰돼 같은 세션에서 함께 돌면 같은 알림이 두 번 나간다. 세션 id 이름의
// 폴더를 configDir 의 codex-sessions 에 만든 훅만 알린다. mkdir 은 이미 있으면 실패하고 링크를 따라가지 않아 둘이
// 동시에 와도 하나만 만든다. 함께 도는 훅은 훅 시간 제한(5초) 안에 오므로, 30초 넘게 지난 폴더는 이어 연 세션(resume)
// 의 것이다: 고유 이름으로 옮겨(rename 은 하나만 성공) 다시 만든 훅이 알린다. 옮긴 것이 새것이면(그사이 짝 훅이
// 넘겨받아 만든 것) 알리지 않는다. 세션 id 가 없거나 폴더를 만들 수 없으면
// 전처럼 알린다. 이틀 지난 폴더와 예전 판의 codex-dual-notified 는 지운다.
// 시작마다 다른 값으로 표지를 나누지 않는 까닭: Codex 0.165.0 의 SessionStart 입력(훅 스키마
// session-start.command.input)은 cwd, hook_event_name, model, permission_mode, session_id, source(startup, resume,
// clear, compact, fork), transcript_path 뿐이라 두 길의 훅이 함께 받고 시작마다 달라지는 값이 없다(source 는 resume 을
// 두 번 해도 같음). 그래서 30초 넘게 늦은 짝 훅은 알림을 한 번 더 낼 수 있다(알림만). 두 훅의 모든 끼어들기 순서에서
// 알림이 한 번 이하임은 update-notify.test.mjs 가 claimSteps 로 돌려 본다.
const SESSION_RE = /^[A-Za-z0-9._-]{1,80}$/;
const CLAIM_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
const CLAIM_TWIN_MS = 30 * 1000;
export function claimSession(payload, now = Date.now()) {
  const sid = typeof payload?.session_id === 'string' && SESSION_RE.test(payload.session_id) && !/^\.+$/.test(payload.session_id) ? payload.session_id : '';
  if (!sid) return true;
  const dir = join(configDir(), 'codex-sessions');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return true; // 폴더 자리에 다른 것이 있음: 중복을 막지 못해도 알림은 낸다
  }
  const steps = claimSteps(join(dir, sid), now);
  let step = steps.next();
  while (!step.done) step = steps.next();
  if (step.value) dropOldClaims(dir, sid, now);
  return step.value;
}

// 세션 폴더를 이 훅이 잡았는지(true 면 알림). 파일 시스템 동작 하나 앞마다 yield 해, 시험이 짝 훅과의 끼어들기를 정한다.
export function* claimSteps(mine, now) {
  yield;
  try {
    mkdirSync(mine);
    return true;
  } catch (e) {
    if (e?.code !== 'EEXIST') return true;
  }
  try {
    yield;
    if (now - statSync(mine).mtimeMs < CLAIM_TWIN_MS) return false; // 같은 세션의 다른 길 훅이 방금 알렸다
    const old = `${mine}.old-${process.pid}-${randomHex()}`;
    yield;
    renameSync(mine, old);
    yield;
    // 본 것과 옮긴 것 사이에 짝 훅이 넘겨받아 새로 만든 폴더였다: 그 훅이 알리므로 알리지 않는다. 돌려놓지 않고
    // (그사이 다른 훅이 만든 폴더를 덮을 수 있다) 옮긴 폴더는 이틀 뒤 정리에서 지운다.
    if (now - statSync(old).mtimeMs < CLAIM_TWIN_MS) return false;
    yield;
    rmdirSync(old);
    yield;
    mkdirSync(mine);
    return true;
  } catch {
    return false; // 함께 온 다른 훅이 먼저 옮기거나 만들었다
  }
}

function dropOldClaims(dir, sid, now) {
  try {
    rmSync(join(configDir(), 'codex-dual-notified'), { force: true });
    for (const d of readdirSync(dir)) {
      try {
        if (d !== sid && now - statSync(join(dir, d)).mtimeMs > CLAIM_KEEP_MS) rmdirSync(join(dir, d));
      } catch { /* 다른 훅이 먼저 지움 */ }
    }
  } catch { /* 정리는 다음 세션에 */ }
}

// Codex: 이 훅이 도는 곳(훅 스크립트, 플러그인 폴더나 사본 폴더, node)이 config.toml 의 writable_roots 아래면 그 알림,
// 아니면 ''. 읽지 못하면 ''(전처럼 돎).
export function writableNotice(payload, env = process.env, places = hookPlaces(import.meta.url)) {
  try {
    return writableRootsNote(codexHomeOf(payload?.transcript_path, env), places);
  } catch {
    return '';
  }
}

async function main() {
  // SessionStart payload. Codex 는 두 길 알림에 transcript_path, session_id 를 쓴다. 파싱 실패해도 무해.
  let payload = null;
  try { payload = JSON.parse(await readStdin()); } catch { /* stdin 없음/오류 무해 */ }

  const unsafe = CODEX ? writableNotice(payload) : '';
  if (unsafe) { process.stdout.write(JSON.stringify({ systemMessage: unsafe })); return; } // 그 밖의 일은 하지 않는다
  if (CODEX && !claimSession(payload)) return; // 같은 세션의 다른 길 훅이 이미 알렸다
  const notes = CODEX ? [shapeMissNotice(), dualNotice(payload), sessionHomeNotice(payload), pluginVersionNotice(payload)] : [];
  if (!noUpdateCheck()) { // opt-out 이면 업데이트 확인만 무동작.
    const cached = readCache(); // 포그라운드는 캐시 읽기만(네트워크 없음).
    notes.unshift(maybeNotify(cached));
    if (updateCheckDue(cached)) spawnFetcher(); // 갱신은 백그라운드로 위임. 실패한 시도(triedAt)에서도 하루를 쉰다.
  }
  const msg = notes.filter(Boolean).join('\n');
  if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg }));
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
