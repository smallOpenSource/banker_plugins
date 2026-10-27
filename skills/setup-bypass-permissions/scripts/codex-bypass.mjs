#!/usr/bin/env node
/*
 * setup-bypass-permissions 의 Codex 대상. Claude Code 의 bypassPermissions 에 해당하는 Codex 설정을 켜고 끈다:
 * `$CODEX_HOME/config.toml` 최상위의 approval_policy = "never", sandbox_mode = "danger-full-access"
 * (Codex 의 --dangerously-bypass-approvals-and-sandbox 와 같은 조합).
 *
 * - 켜기 전 두 키의 값(없으면 없음)을 config.toml.bypass-permissions.json 에 기록하고, 원본 바이트를
 *   config.toml.bypass-permissions.bak 에 둔다. off 는 기록대로 되돌린다. 기록이 없으면 이 스크립트가 쓰는 값과
 *   같은 키만 뺀다.
 * - 조직 정책(/etc/codex/requirements.toml 의 allowed_approval_policies, allowed_sandbox_modes)이 이 값을 허용하지
 *   않으면 켜지 않는다.
 *
 * 사용: node codex-bypass.mjs <on --yes|off|status>
 * 종료: 0 완료 또는 이미 그 상태, 1 거부(파일은 그대로), 2 예기치 못한 오류, 3 이 계정이 쓸 수 없음(샌드박스 등)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codexConfigFile, denied, findKey, readToml, Refused, removeKey, setKey, tablesSetting, writeToml } from './codex-config.mjs';

const WANT = { approval_policy: '"never"', sandbox_mode: '"danger-full-access"' };
const KEYS = Object.keys(WANT);
const POLICY_FILES = ['/etc/codex/requirements.toml', '/etc/codex/managed_config.toml'];

const recordOf = (file) => `${file}.bypass-permissions.json`;
const backupOf = (file) => `${file}.bypass-permissions.bak`;
const valueOf = (text, key) => findKey(text, '', key)?.raw ?? null;
const isOn = (text) => KEYS.every((k) => valueOf(text, k) === WANT[k]);

// 조직 정책이 이 값을 막거나 정책 파일을 읽을 수 없으면 그 이유, 아니면 ''.
export function policyBlock(files = POLICY_FILES) {
  for (const f of files) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      return `조직 정책 파일을 읽을 수 없음(${e.code}): ${f}`;
    }
    for (const [key, want] of [['allowed_approval_policies', 'never'], ['allowed_sandbox_modes', 'danger-full-access']]) {
      const hit = findKey(text, '', key);
      if (hit && !hit.raw.includes(`"${want}"`)) return `${f} 의 ${key} 가 ${want} 를 허용하지 않음`;
    }
  }
  return '';
}

// 최상위 profile 이 고른 기본 프로필이 두 키를 따로 정하면 그 값이 이긴다. 그 프로필 이름, 없으면 ''.
export function overridingProfile(text) {
  const raw = findKey(text, '', 'profile')?.raw ?? '';
  const name = /^"([^"]+)"$|^'([^']+)'$/.exec(raw);
  const prof = name && `profiles.${name[1] ?? name[2]}`;
  return prof && KEYS.some((k) => findKey(text, prof, k)) ? prof : '';
}

export function turnOn({ file = codexConfigFile(), policies = POLICY_FILES } = {}) {
  const why = policyBlock(policies);
  if (why) return { code: 1, msg: `켜지 않음: ${why}` };
  const { text, mode, exists } = readToml(file);
  const prof = overridingProfile(text);
  if (prof) return { code: 1, msg: `켜지 않음: 기본 프로필 ${prof} 가 approval_policy 나 sandbox_mode 를 정해 최상위 값이 적용되지 않음. 그 프로필의 값을 직접 바꾸십시오` };
  if (isOn(text)) return { code: 0, msg: '이미 켜져 있음' };
  const before = Object.fromEntries(KEYS.map((k) => [k, valueOf(text, k)]));
  let next = text;
  for (const k of KEYS) next = setKey(next, '', k, WANT[k]);
  if (!fs.existsSync(path.dirname(file))) return { code: 1, msg: `Codex 설정 폴더가 없음: ${path.dirname(file)}` };
  if (!fs.existsSync(recordOf(file))) writeToml(recordOf(file), `${JSON.stringify({ before, existed: exists })}\n`);
  writeToml(file, next.endsWith('\n') || !next ? next : `${next}\n`, { mode, backup: exists ? backupOf(file) : null });
  return { code: 0, msg: '켬: approval_policy = "never", sandbox_mode = "danger-full-access"' };
}

export function turnOff({ file = codexConfigFile() } = {}) {
  const { text, mode, exists } = readToml(file);
  let record = null;
  try { record = JSON.parse(fs.readFileSync(recordOf(file), 'utf8')); } catch { /* 기록 없음 */ }
  let next = text;
  for (const k of KEYS) {
    const was = record?.before?.[k];
    if (typeof was === 'string') next = setKey(next, '', k, was);
    else if (record || valueOf(next, k) === WANT[k]) next = removeKey(next, '', k);
  }
  if (next !== text && exists) writeToml(file, next, { mode });
  fs.rmSync(recordOf(file), { force: true });
  return { code: 0, msg: next === text ? '이미 꺼져 있음' : record ? '끔: 켜기 전 값으로 되돌림' : '끔: 이 스크립트가 쓰는 값의 키를 뺌' };
}

export function status({ file = codexConfigFile(), policies = POLICY_FILES } = {}) {
  const { text } = readToml(file);
  const out = [`${isOn(text) ? '켜짐' : '꺼짐'}: approval_policy = ${valueOf(text, 'approval_policy') ?? '(없음)'}, sandbox_mode = ${valueOf(text, 'sandbox_mode') ?? '(없음)'}`];
  const prof = overridingProfile(text);
  if (prof) out.push(`기본 프로필 ${prof} 가 값을 정해 최상위 값이 적용되지 않음`);
  const profiles = [...new Set(KEYS.flatMap((k) => tablesSetting(text, 'profiles.', k)))];
  if (profiles.length) out.push(`프로필이 따로 정함(그 프로필로 시작하면 그 값): ${profiles.join(', ')}`);
  const why = policyBlock(policies);
  if (why) out.push(`조직 정책: ${why}`);
  if (fs.existsSync(recordOf(file))) out.push(`되돌리기 기록: ${recordOf(file)}`);
  return { code: 0, msg: out.join('\n') };
}

function run(argv) {
  const [cmd] = argv;
  if (cmd === 'on' && !argv.includes('--yes')) return { code: 1, msg: '켜기는 확인을 받은 뒤 --yes 와 함께 실행' };
  if (cmd === 'on') return turnOn();
  if (cmd === 'off') return turnOff();
  return status();
}

function main(argv) {
  let r;
  try {
    r = run(argv);
  } catch (e) {
    r = e instanceof Refused ? { code: 1, msg: `거부: ${e.message}` } : denied(e) ? { code: 3, msg: `쓸 수 없음(${e.code}): ${e.path ?? ''}` } : { code: 2, msg: `오류: ${e.message}` };
  }
  console.log(`${r.msg}\n설정 파일: ${codexConfigFile()}`);
  return r.code;
}

const same = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; } };
if (process.argv[1] && same(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) process.exitCode = main(process.argv.slice(2));
