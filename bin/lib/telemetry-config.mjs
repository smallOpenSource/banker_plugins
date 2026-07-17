/*
 * telemetry-config - banker 텔레메트리 config/consent 공용 모듈 (bin·hook 공유).
 * 의존성 0 (Node 내장 모듈만: node:fs, node:path, node:os). ESM(.mjs).
 * import 시 부작용 없음: 경로는 resolver 로 호출 시 계산하고, 파일시스템 접근·mkdir 은
 * 각 함수 호출 시에만 일어난다. readConfig/isEnabled/endpoint 는 어떤 예외도 밖으로 던지지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// 단일 config-path resolver. 호출 시점의 env 를 읽어 계산한다 (테스트는 XDG_CONFIG_HOME 으로 격리).
export function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'banker');
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'banker');
  }
  return path.join(os.homedir(), '.config', 'banker');
}

// 공유 경로 상수: import 시점의 resolver 결과를 캡처한다 (bin·hook 은 단명 프로세스라 env 안정적).
// 순수 경로 계산이라 파일시스템을 건드리지 않는다. 내부 함수는 configDir() 를 매 호출 재계산하므로
// 테스트가 XDG_CONFIG_HOME 을 바꿔도 올바르게 격리된다.
export const USAGE_LOG_PATH = path.join(configDir(), 'usage-log');   // 사용량 로그 절대경로
export const LAST_FLUSH_PATH = path.join(configDir(), 'last-flush');
// USAGE_LOG 계약: 한 줄 = `<skill-name>\t<hour 0-23>` (스킬 이름 + TAB + 기록 시각의 로컬 hour).
// flush 는 이 줄들을 스킬별 x 시간대별로 집계한다. LOG_MAX_LINES 는 (필드 아닌) 줄 수 상한이며,
// 초과 시 오래된 줄부터 잘라내 24h 윈도우를 근사한다.
export const LOG_MAX_LINES = 5000;

// update-check 캐시 파일({latest,checkedAt,notified})의 절대경로. USAGE_LOG_PATH 와 동일하게
// import 시점 resolver 결과를 캡처한다(단명 hook 프로세스용). writeUpdateCache 는 테스트 격리를 위해
// configDir() 를 매 호출 재계산하므로 이 상수에 의존하지 않는다.
export const UPDATE_CHECK_PATH = path.join(configDir(), 'update-check.json');
// 업데이트 체크/체크인 스로틀 창(24h). 이 간격 미경과면 재조회하지 않는다.
export const UPDATE_THROTTLE_MS = 24 * 60 * 60 * 1000;
// 최신 버전 조회용 공개 npm 레지스트리 URL. 본문 .version 을 직접 반환한다(실측 확정).
export const NPM_LATEST_URL = 'https://registry.npmjs.org/@kaydash9999/banker-plugins/latest';

// config.json 을 읽어 객체로 반환. 파일 없음·malformed JSON·권한 오류 등 어떤 예외에도 던지지 않고 {} 반환.
export function readConfig() {
  try {
    const raw = fs.readFileSync(path.join(configDir(), 'config.json'), 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch {
    return {};
  }
}

// configDir 을 mkdir -p 후 config.json 에 기록. 오류는 삼켜 false, 성공 true.
export function writeConfig(obj) {
  try {
    const target = configDir();
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify(obj, null, 2));
    return true;
  } catch {
    return false;
  }
}

// 배포에 내장하는 기본 카운팅 엔드포인트(유지보수자가 운영하는 Cloudflare Worker). 이 상수를 내장해서
// count-default-on 이 모든 설치에서 활성이다: endpoint() 가 (거의) 항상 값을 반환하므로 countingActive()
// 가 기본 켜짐이 되고, opt-out(BANKER_NO_TELEMETRY / banker telemetry off / config.telemetry=false)으로만
// 끈다. 자가호스팅/override 는 BANKER_TELEMETRY_ENDPOINT env 로 한다.
export const DEFAULT_ENDPOINT = 'https://banker.banker-plugins.workers.dev/';

// 카운팅 엔드포인트 문자열. 우선순위: env(BANKER_TELEMETRY_ENDPOINT) > config.endpoint > DEFAULT_ENDPOINT.
// 기본 엔드포인트를 내장하므로 env·config 미설정이어도 DEFAULT_ENDPOINT 를 반환한다(= count-default-on 이
// 모든 설치에서 활성, opt-out 으로만 끔). env 빈문자열('')은 falsy 라 여전히 config/DEFAULT 로 흐른다.
// 예외가 난 경우에만 null 을 반환한다(에러 시 보수적으로 전송 안 함).
export function endpoint() {
  try {
    const env = process.env.BANKER_TELEMETRY_ENDPOINT;
    if (env) return env;
    const ep = readConfig().endpoint;
    return (typeof ep === 'string' && ep) ? ep : DEFAULT_ENDPOINT;
  } catch {
    return null;
  }
}

// env 값이 opt-out 을 의미하는지. unset·''·'0'·'false' 는 opt-out 이 아니고, 그 외 모든 값이 opt-out.
// BANKER_NO_TELEMETRY 와 BANKER_NO_UPDATE_CHECK 가 동일 규칙을 공유한다.
function isOptOut(v) {
  return !(v === undefined || v === '' || v === '0' || v === 'false');
}

// BANKER_NO_TELEMETRY 가 opt-out 을 의미하는지.
function noTelemetry() {
  return isOptOut(process.env.BANKER_NO_TELEMETRY);
}

// [예약] opt-in 게이트. 현재 카운팅은 countingActive(default-on)를 쓰므로 프로덕션 호출자는 없다.
// 향후 EU 등에서 opt-in 전환이 필요할 때(PRIVACY.md 법적 상태 참조) 재도입할 수 있게 보존한다.
// 다음이 전부 참일 때만 true: (1) readConfig().telemetry===true, (2) 엔드포인트 설정됨,
// (3) BANKER_NO_TELEMETRY 가 opt-out 아님. 전체를 try/catch 로 감싸 어떤 예외에도 false.
export function isEnabled() {
  try {
    if (readConfig().telemetry !== true) return false;
    if (!endpoint()) return false;
    if (noTelemetry()) return false;
    return true;
  } catch {
    return false;
  }
}

// 업데이트 체크를 opt-out 했는지. env BANKER_NO_UPDATE_CHECK 가 opt-out 이거나
// readConfig().updateCheck===false 이면 true. 전체를 try/catch 로 감싸 어떤 예외에도 false.
export function noUpdateCheck() {
  try {
    if (isOptOut(process.env.BANKER_NO_UPDATE_CHECK)) return true;
    if (readConfig().updateCheck === false) return true;
    return false;
  } catch {
    return false;
  }
}

// 익명 사용량 카운팅이 활성인지 (default-on). isEnabled 의 opt-in(telemetry===true) 과 달리
// telemetry 미설정도 활성으로 본다: (1) 엔드포인트 설정됨, (2) BANKER_NO_TELEMETRY 가 opt-out 아님,
// (3) readConfig().telemetry!==false. 셋 다 참이면 true. 전체를 try/catch 로 감싸 어떤 예외에도 false.
export function countingActive() {
  try {
    if (!endpoint()) return false;
    if (noTelemetry()) return false;
    if (readConfig().telemetry === false) return false;
    return true;
  } catch {
    return false;
  }
}

// 이 모듈 파일 기준 플러그인 루트의 plugin.json 절대경로 (bin/lib -> 루트 = 두 단계 위).
// fileURLToPath·path 는 순수 계산이라 import 부작용이 없다(파일 읽기는 installedVersion 호출 시에만).
const PLUGIN_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude-plugin', 'plugin.json');

// 설치된 플러그인 버전 문자열. 기본 경로는 플러그인 루트의 .claude-plugin/plugin.json 이며,
// 테스트가 임의 경로를 주입할 수 있게 파라미터로도 받는다. 파일없음·malformed·비문자열·빈문자열 → null.
export function installedVersion(pluginJsonPath = PLUGIN_JSON_PATH) {
  try {
    const v = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8')).version;
    return (typeof v === 'string' && v) ? v : null;
  } catch {
    return null;
  }
}

// 'x.y.z' 두 버전을 major.minor.patch 정수 3튜플로 비교한다. a>b 면 양수, a<b 면 음수, 같으면 0.
// prerelease 접미사('1.2.3-rc1')·토큰 누락('1.2')·비수치('a.b.c')가 있으면 null(미확정) 반환.
// 순수 함수이며 어떤 입력에도 throw 하지 않는다.
export function compareVersions(a, b) {
  const parse = (s) => {
    if (typeof s !== 'string') return null;
    const parts = s.split('.');
    if (parts.length !== 3) return null;
    const nums = [];
    for (const part of parts) {
      if (!/^\d+$/.test(part)) return null; // 빈·비수치·prerelease('3-rc1') 토큰 배제
      nums.push(Number(part));
    }
    return nums;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// update-check 캐시를 read-modify-write 로 병합 기록한다: 기존 JSON 을 읽어({} on 실패) patch 의
// 필드만 덮고 나머지 형제 필드는 보존한 뒤, configDir() mkdir -p → temp 파일 쓰기 → rename(원자적)
// 으로 기록한다. 테스트 격리를 위해 경로는 configDir() 로 매 호출 재계산한다(UPDATE_CHECK_PATH 상수
// 비의존). 모든 오류를 삼켜 best-effort: 성공 true, 실패 false.
export function writeUpdateCache(patch) {
  try {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true });
    const cachePath = path.join(dir, 'update-check.json');
    let existing = {};
    try {
      const obj = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) existing = obj;
    } catch { /* 없음·malformed → {} */ }
    const merged = { ...existing, ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}) };
    const tmp = path.join(dir, `update-check.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, cachePath);
    return true;
  } catch {
    return false;
  }
}
