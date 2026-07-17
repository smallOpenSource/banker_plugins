/*
 * telemetry-config - banker 텔레메트리 config/consent 공용 모듈 (bin·hook 공유).
 * 의존성 0 (Node 내장 모듈만: node:fs, node:path, node:os). ESM(.mjs).
 * import 시 부작용 없음: 경로는 resolver 로 호출 시 계산하고, 파일시스템 접근·mkdir 은
 * 각 함수 호출 시에만 일어난다. readConfig/isEnabled/endpoint 는 어떤 예외도 밖으로 던지지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
// 로그 한 줄 = 커맨드/스킬 이름 문자열 하나 (개행 구분). 이 줄 수를 넘으면 오래된 항목을 잘라낸다.
export const LOG_MAX_LINES = 5000;

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

// 설정된 엔드포인트 문자열 또는 null. env(BANKER_TELEMETRY_ENDPOINT) 가 config.endpoint 보다 우선.
export function endpoint() {
  try {
    const env = process.env.BANKER_TELEMETRY_ENDPOINT;
    if (env) return env;
    const ep = readConfig().endpoint;
    return (typeof ep === 'string' && ep) ? ep : null;
  } catch {
    return null;
  }
}

// BANKER_NO_TELEMETRY 가 opt-out 을 의미하는지. unset·''·'0'·'false' 는 opt-out 이 아니다.
function noTelemetry() {
  const v = process.env.BANKER_NO_TELEMETRY;
  return !(v === undefined || v === '' || v === '0' || v === 'false');
}

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
