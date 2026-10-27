#!/usr/bin/env node
/*
 * setup-omc-hud 의 Codex 대상. Codex TUI 의 상태표시줄은 `$CODEX_HOME/config.toml` 의 `[tui] status_line` 이다.
 * OMX 는 `omx setup` 에서 이 줄을 `# omx:managed-status-line` 표시와 함께 관리한다.
 *
 * - on: status_line 이 없을 때만 OMX 의 프리셋 항목으로 넣고 `# banker:status-line` 표시를 붙인다. OMX 나 사용자가
 *   이미 둔 줄은 건드리지 않는다(누가 둔 것인지 알린다).
 * - off: banker 표시가 붙은 줄만 뺀다.
 * - status: 지금 줄과 그 주인.
 * 쓰기 전 원본을 config.toml.banker-hud.bak 에 둔다. 공통 모듈 codex-config.mjs 는 setup-bypass-permissions 의 같은 사본.
 *
 * 사용: node codex-status-line.mjs <on [--preset focused|minimal]|off|status>
 * 종료: 0 완료 또는 이미 그 상태, 1 거부(파일은 그대로), 2 예기치 못한 오류, 3 이 계정이 쓸 수 없음(샌드박스 등)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codexConfigFile, definedInline, denied, findKey, readToml, Refused, removeKey, setKey, writeToml } from './codex-config.mjs';

export const MARK = '# banker:status-line';
const OMX_MARK = '# omx:managed-status-line';
// oh-my-codex 의 상태표시줄 프리셋(config/generator.js 의 STATUS_LINE_PRESETS)과 같은 항목.
export const PRESETS = {
  focused: ['model-with-reasoning', 'git-branch', 'context-remaining', 'total-input-tokens', 'total-output-tokens', 'five-hour-limit', 'weekly-limit'],
  minimal: ['model-with-reasoning', 'git-branch'],
};

// 지금 status_line 과 그 주인: 'banker', 'omx', 'user', 없으면 null.
export function owner(text) {
  const hit = findKey(text, 'tui', 'status_line');
  if (!hit) return { owner: null, raw: '' };
  const above = text.split(/\r?\n/)[hit.at - 1];
  return { owner: above === MARK ? 'banker' : above === OMX_MARK ? 'omx' : 'user', raw: hit.raw };
}

const presetValue = (fields) => `[${fields.map((f) => `"${f}"`).join(', ')}]`;
const sameValue = (a, b) => a.replace(/\s+/g, '').replace(/,\]$/, ']') === b.replace(/\s+/g, '');

export function turnOn({ file = codexConfigFile(), preset = 'focused' } = {}) {
  if (!Object.prototype.hasOwnProperty.call(PRESETS, preset)) return { code: 1, msg: `프리셋은 ${Object.keys(PRESETS).join(', ')} 중 하나` };
  const { text, mode, exists } = readToml(file);
  // 최상위의 `tui.x = ` 나 `tui = { }` 가 있는 파일에 [tui] 를 더하면 키가 겹쳐 Codex 가 시작하지 못한다.
  if (definedInline(text, 'tui')) return { code: 1, msg: '거부: 최상위에서 tui 를 점 키나 인라인 표로 정한 설정이라 [tui] 를 더하지 않음. status_line 을 직접 넣으십시오' };
  const now = owner(text);
  if (now.owner === 'omx') return { code: 0, msg: '이미 있음: OMX 가 관리하는 상태표시줄(바꾸려면 omx setup)' };
  if (now.owner === 'user') return { code: 0, msg: '이미 있음: 사용자가 둔 상태표시줄이라 그대로 둠' };
  if (!fs.existsSync(path.dirname(file))) return { code: 1, msg: `Codex 설정 폴더가 없음: ${path.dirname(file)}` };
  const next = setKey(text, 'tui', 'status_line', presetValue(PRESETS[preset]), MARK);
  if (next === text) return { code: 0, msg: '이미 켜져 있음' };
  writeToml(file, next, { mode, backup: exists ? `${file}.banker-hud.bak` : null });
  return { code: 0, msg: `켬: [tui] status_line(${preset}). Codex 를 다시 열면 보임` };
}

export function turnOff({ file = codexConfigFile() } = {}) {
  const { text, mode } = readToml(file);
  const now = owner(text);
  if (now.owner !== 'banker') return { code: 0, msg: now.owner ? `banker 가 둔 줄이 아님(${now.owner}): 그대로 둠` : '이미 꺼져 있음' };
  // 표시는 남았지만 값을 사용자가 고쳤으면 사용자의 줄로 본다.
  if (!Object.values(PRESETS).some((f) => sameValue(now.raw, presetValue(f)))) return { code: 0, msg: '사용자가 값을 고친 줄이라 그대로 둠(banker 표시만 남음)' };
  writeToml(file, removeKey(text, 'tui', 'status_line', MARK), { mode });
  return { code: 0, msg: '끔: banker 가 둔 status_line 을 뺌' };
}

export function status({ file = codexConfigFile() } = {}) {
  const now = owner(readToml(file).text);
  return { code: 0, msg: now.owner ? `status_line(${now.owner}): ${now.raw.replace(/\s+/g, ' ')}` : 'status_line 없음' };
}

function run(argv) {
  const [cmd] = argv;
  const at = argv.indexOf('--preset');
  if (cmd === 'on') return turnOn({ preset: at >= 0 ? argv[at + 1] : 'focused' });
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
