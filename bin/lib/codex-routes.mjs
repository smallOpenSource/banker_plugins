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

const MAX_CONFIG = 4 << 20;
// 4 MB 까지의 일반 파일만 읽는다(FIFO 를 기다리지 않음, 훅의 5초 안에 끝남). 없거나 읽지 못하면 ''.
function readRegular(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    return st.isFile() && st.size <= MAX_CONFIG ? fs.readFileSync(fd, 'utf8') : '';
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

// Codex 홈의 실제 경로가 세션 폴더(cwd) 아래인데 그 맨 위의 .codex 가 아닌지. Codex 0.165.0 샌드박스는 세션 폴더 맨 위의
// .git, .codex, .agents 만 읽기 전용으로 두므로, 그 밖(CODEX_HOME=<세션>/deep/.codex, <세션>/codexhome)의 Codex 홈은
// 샌드박스 안의 세션이 고칠 수 있다(설정, 훅 사본, 플러그인). 세션 시작 알림과 banker doctor 가 쓴다.
export function homeInSession(home, cwd) {
  if (!home || !cwd || !path.isAbsolute(cwd)) return false;
  // 아직 없는 경로는 있는 조상까지만 풀고 나머지를 붙인다(macOS 의 /var 는 /private/var 로 가는 링크).
  const real = (f) => { try { return fs.realpathSync(f); } catch { const up = path.dirname(f); return up === f ? f : path.join(real(up), path.basename(f)); } };
  const rel = path.relative(real(cwd), real(home));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return rel !== '.codex';
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

// 프로젝트 범위 npm 설치(`banker setup --codex --scope project` 의 <폴더>/.codex/skills/banker-*)가 있는 폴더. cwd 에서
// 저장소 최상위(.git 이 있는 폴더)까지 올라가며 찾는다(저장소 밖이면 cwd 만). 없으면 ''.
export function projectNpmRoot(cwd) {
  if (!cwd || !path.isAbsolute(cwd)) return '';
  let dir = path.resolve(cwd);
  const top = (() => {
    for (let d = dir, i = 0; i < 64; i++) {
      if (fs.existsSync(path.join(d, '.git'))) return d;
      const up = path.dirname(d);
      if (up === d) return '';
      d = up;
    }
    return '';
  })();
  for (let i = 0; i < 64; i++) {
    if (npmRoute(path.join(dir, '.codex'))) return dir;
    if (!top || dir === top) return '';
    dir = path.dirname(dir);
  }
  return '';
}

// 두 길이 함께 있으면 알림 글, 아니면 ''. npm 길은 사용자 범위(<홈>/skills)와, cwd 가 있으면 프로젝트 범위도 본다.
export function dualInstallNote(home, cwd = '') {
  const plugins = pluginRoutes(home);
  if (!plugins.length || !(npmRoute(home) || projectNpmRoot(cwd))) return '';
  return `banker 가 Codex 에 두 번 설치됨: npm 의 banker setup --codex 와 Codex 플러그인 ${plugins.join(', ')}. `
    + '스킬이 $banker-<이름> 과 $banker:<이름> 으로 겹칩니다. 하나만 두십시오: '
    + `npm 쪽을 빼려면 banker uninstall --codex, 플러그인을 빼려면 codex plugin remove ${plugins[0]}`;
}

// 플러그인 길의 스킬 목록(.codex-plugin/plugin.json skills 의 스킬별 경로)을 읽는다고 확인한 가장 낮은 Codex 판.
// 0.160.1(Windows), 0.165.0(Linux) 에서 확인했고 0.144.5 는 재지 못했다. 그보다 낮은 판은 banker 스킬이 거의 다 안 보일 수 있다.
export const MIN_PLUGIN_CODEX = '0.160.1';

const triple = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')) || []).slice(1, 4).map(Number);

// 플러그인 길에서 Codex 판이 MIN_PLUGIN_CODEX 보다 낮으면 알림 한 줄, 아니면(판을 모를 때 포함) ''.
export function pluginVersionNote(version) {
  const v = triple(version);
  const min = triple(MIN_PLUGIN_CODEX);
  if (v.length !== 3) return '';
  const lower = v[0] !== min[0] ? v[0] < min[0] : v[1] !== min[1] ? v[1] < min[1] : v[2] < min[2];
  if (!lower) return '';
  return `banker: Codex ${v.join('.')} 은 ${MIN_PLUGIN_CODEX} 보다 낮아 banker 플러그인 스킬이 안 보일 수 있습니다(${MIN_PLUGIN_CODEX} 이상에서 확인). `
    + 'Codex 를 올리거나 npm 길(banker setup --codex)을 쓰십시오';
}

// `codex --version` 의 판(x.y.z). 없거나 2초 안에 답하지 않으면 ''. Windows 는 codex.cmd 를 cmd 로 부른다.
export function codexCliVersion(spawn) {
  const win = process.platform === 'win32';
  try {
    const r = spawn(win ? 'codex.cmd --version' : 'codex', win ? [] : ['--version'], { encoding: 'utf8', timeout: 2000, shell: win, input: '', windowsHide: true });
    return (/(\d+\.\d+\.\d+)/.exec(String(r.stdout || '')) || [])[1] || '';
  } catch {
    return '';
  }
}
