/*
 * banker 가 Codex 에 들어가는 두 길.
 *  - npm: `banker setup --codex` 가 <CODEX_HOME>/skills/banker-<이름>/ 에 복사한다. 스킬은 $banker-<이름>.
 *  - 플러그인: `codex plugin add banker@<마켓플레이스>` 가 <CODEX_HOME>/plugins/cache/<마켓플레이스>/banker/<판>/ 에
 *    저장소를 두고 config.toml 에 [plugins."banker@<마켓플레이스>"] 를 적는다. 스킬은 $banker:<이름>.
 * 둘을 함께 두면 스킬과 훅이 두 벌이 된다. 지우지는 않고 알리기만 한다(update-notify, banker setup --codex, doctor).
 * 훅(update-notify, telemetry-count-codex)과 bin/banker.js 가 함께 쓰므로 npm 길의 훅 사본(codex-hooks.mjs 의
 * PAYLOAD)에도 들어간다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLUGIN = 'banker';
export const DEFAULT_MARKETPLACE = 'banker-plugins';
const NAME_RE = /^[A-Za-z0-9._-]{1,80}$/;

// 일반 파일만 읽는다(FIFO 를 기다리지 않음). 없거나 읽지 못하면 ''.
function readRegular(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd, 'utf8') : '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best-effort */ }
  }
}

// 플러그인 훅의 PLUGIN_ROOT(<홈>/plugins/cache/<마켓플레이스>/banker/<판>)에서 { home, marketplace }. 그 모양이 아니면 null.
export function pluginRootInfo(root) {
  if (!root || !path.isAbsolute(root)) return null;
  const ver = path.resolve(root);
  const plugin = path.dirname(ver);
  const mkt = path.dirname(plugin);
  const cache = path.dirname(mkt);
  const plugins = path.dirname(cache);
  if (path.basename(plugin) !== PLUGIN || path.basename(cache) !== 'cache' || path.basename(plugins) !== 'plugins') return null;
  const marketplace = path.basename(mkt);
  return NAME_RE.test(marketplace) && NAME_RE.test(path.basename(ver)) ? { home: path.dirname(plugins), marketplace } : null;
}

// 이 세션의 Codex 홈: rollout 이 <홈>/sessions/YYYY/MM/DD/ 에 있으면 그 홈(상대 경로 CODEX_HOME 도 Codex 가 푼 그대로),
// 아니면 플러그인 훅의 PLUGIN_ROOT 가 든 홈, 아니면 CODEX_HOME, 그것도 없으면 ~/.codex.
export function codexHomeOf(transcript, env = process.env) {
  const t = String(transcript ?? '');
  const sessions = path.dirname(path.dirname(path.dirname(path.dirname(t))));
  if (t && path.isAbsolute(t) && path.basename(sessions) === 'sessions') return path.dirname(sessions);
  const info = pluginRootInfo(env.PLUGIN_ROOT);
  if (info) return info.home;
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// npm 길로 설치된 banker 스킬이 있는지(<홈>/skills/banker-*/SKILL.md).
export function npmRoute(home) {
  try {
    return fs.readdirSync(path.join(home, 'skills')).some((d) => d.startsWith('banker-') && fs.existsSync(path.join(home, 'skills', d, 'SKILL.md')));
  } catch {
    return false;
  }
}

// 켜져 있는 banker 플러그인의 id(banker@<마켓플레이스>) 목록. config.toml 의 [plugins."banker@..."] 표 중
// enabled = false 가 아닌 것.
export function pluginRoutes(home) {
  const lines = readRegular(path.join(home, 'config.toml')).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\[\s*plugins\s*\.\s*["']banker@([A-Za-z0-9._-]{1,80})["']\s*\]\s*(?:#.*)?$/.exec(lines[i]);
    if (!m) continue;
    let enabled = true;
    for (let j = i + 1; j < lines.length && !/^\s*\[/.test(lines[j]); j++) {
      if (/^\s*enabled\s*=\s*false\s*(?:#.*)?$/.test(lines[j])) enabled = false;
    }
    if (enabled) out.push(`${PLUGIN}@${m[1]}`);
  }
  return out;
}

// 두 길이 함께 있으면 알림 글, 아니면 ''.
export function dualInstallNote(home) {
  const plugins = pluginRoutes(home);
  if (!plugins.length || !npmRoute(home)) return '';
  return `banker 가 Codex 에 두 번 설치됨: npm 의 banker setup --codex 와 Codex 플러그인 ${plugins.join(', ')}. `
    + '스킬이 $banker-<이름> 과 $banker:<이름> 으로 겹칩니다. 하나만 두십시오: '
    + `npm 쪽을 빼려면 banker uninstall --codex, 플러그인을 빼려면 codex plugin remove ${plugins[0]}`;
}
