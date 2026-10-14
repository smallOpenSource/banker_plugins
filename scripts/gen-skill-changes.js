#!/usr/bin/env node
'use strict';
/*
 * skill-changes 매니페스트 생성기 (유지보수자 전용 · scripts/ 라 npm 배포에서 제외됨).
 *
 * 무엇: 릴리스마다 "이 버전에서 바뀐 스킬 목록"을 저장소 루트 skill-changes.json 에 한 항목 추가한다.
 *   이 파일은 공개 GitHub raw 로 서빙되고(SKILL_CHANGES_URL), 설치된 클라이언트의 update-fetch/
 *   update-checkin 이 best-effort GET 해 changedSkills 캐시를 채우면, update-notify 가 로컬 "써 본 스킬"과
 *   교차해 "당신이 자주 쓰는 스킬이 이번 업데이트에서 바뀌었습니다: ..." 처럼 개인화 알림을 만든다.
 *   계약 상세는 bin/lib/telemetry-config.mjs 의 SKILL_CHANGES_URL 주석 참조.
 *
 * 형식: { "<x.y.z>": ["banker:<skill>", ...], ... }  (버전 -> 그 릴리스에서 바뀐 스킬 ID 배열)
 *
 * 사용:
 *   node scripts/gen-skill-changes.js               # version=plugin.json, from=직전 릴리스 커밋, to=작업트리
 *   node scripts/gen-skill-changes.js --from <ref> --to <ref> --version <v>
 *   node scripts/gen-skill-changes.js --print       # 계산만 출력(파일 미변경)
 *
 * 규약:
 *   - 변경이 0건이면 그 버전 키를 추가하지 않는다(빈 배열 항목은 알림에 무의미).
 *   - skills/ 에 아직 존재하는(SKILL.md 있는) 디렉터리만 센다(삭제된 스킬은 개인화 대상이 아니라 제외).
 *   - npm 묶음에 들어가지 않는 파일(package.json files 의 ! 항목: 시험 파일, __pycache__, .omc)만 바뀐 스킬은
 *     세지 않는다. 사용자에게는 바뀐 것이 없다(0.16.3 에서 obsidizer 시험만 바뀌어 손으로 뺐다).
 *   - 과거(설치 버전 이하) 항목은 어떤 클라이언트도 읽지 않으므로(알림은 installed<v<=latest 만 계산) 백필은
 *     불필요하다. 이 도구는 매 릴리스에 새 버전 항목을 "앞으로" 채우는 용도다.
 *   - git 이 없으면 안내만 출력하고 비정상 종료한다(추정 금지).
 *
 * 배선(권장): 버전 bump 커밋 직전 또는 직후 실행. from 을 생략하면 plugin.json 을 마지막으로 바꾼 커밋을
 *   기준으로 삼는다(= 직전 릴리스). 새 bump 를 아직 커밋하지 않았다면 그 커밋이 곧 직전 릴리스이므로 맞다.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const manifestPath = path.join(ROOT, 'skill-changes.json');
const pluginPath = path.join(ROOT, '.claude-plugin', 'plugin.json');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const printOnly = process.argv.includes('--print');

function git(args, cwd = ROOT) {
  return cp.execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// package.json files 의 제외 항목(! 뒤) 하나를 정규식으로. "**/" 는 앞 폴더 0개 이상, "*" 는 "/" 를 뺀 글자
// 0개 이상, 끝의 "/**" 는 그 아래 전부다. 나머지 글자는 글자 그대로 맞춘다.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) { re += '(?:.*/)?'; i += 2; }
    else if (glob.startsWith('/**', i) && i + 3 === glob.length) { re += '/.*'; i += 2; }
    else if (glob[i] === '*') re += '[^/]*';
    else re += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// npm 묶음에서 빠지는 경로의 정규식들: package.json files 의 ! 항목(시험 파일, __pycache__, .omc 등).
function excludedPatterns(root = ROOT) {
  const files = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).files || [];
  return files.filter((f) => typeof f === 'string' && f.startsWith('!')).map((f) => globToRegExp(f.slice(1)));
}

// 저장소 기준 경로(/ 구분)가 npm 묶음에 들어가는지.
const isShipped = (rel, patterns) => !patterns.some((re) => re.test(rel));

// plugin.json 을 마지막으로 바꾼 커밋(=직전 릴리스). 없으면 null(전체 이력과 비교).
function prevReleaseRef() {
  try {
    const out = git(['log', '-n', '1', '--format=%H', '--', '.claude-plugin/plugin.json']).trim();
    return out || null;
  } catch {
    return null;
  }
}

// from..to 사이에 묶음에 들어가는 파일이 바뀐 skills/<name> 를 banker:<name> ID 배열로. to 미지정이면
// 작업트리(uncommitted 포함). 파일 이름은 -z 로 받아 git 의 따옴표 처리 없이 그대로 본다.
// --no-renames: 이름 바꾸기를 지운 것과 새로 만든 것으로 받아, 옛 이름이 있던 스킬도 센다.
// --end-of-options: "-" 로 시작하는 ref 를 git 옵션으로 읽지 않는다(git 2.24 이상).
function changedSkills(from, to, root = ROOT) {
  const range = to ? `${from}..${to}` : from; // to 없으면 from..작업트리.
  const raw = git(['diff', '--name-only', '-z', '--no-renames', '--end-of-options', range, '--', 'skills/'], root);
  const patterns = excludedPatterns(root);
  const names = new Set();
  for (const rel of raw.split('\0')) {
    const m = rel.match(/^skills\/([^/]+)\//);
    if (!m || !isShipped(rel, patterns)) continue;
    // 아직 존재하는 스킬만(삭제된 것 제외).
    if (fs.existsSync(path.join(root, 'skills', m[1], 'SKILL.md'))) names.add(`banker:${m[1]}`);
  }
  return [...names].sort();
}

function main() {
  let version = arg('--version');
  if (!version) {
    try { version = JSON.parse(fs.readFileSync(pluginPath, 'utf8')).version; } catch { version = null; }
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('버전을 확정할 수 없습니다(plugin.json 또는 --version <x.y.z>).');
    process.exit(1);
  }

  const from = arg('--from') || prevReleaseRef();
  if (!from) {
    console.error('비교 기준(from)을 찾지 못했습니다. --from <ref> 로 직전 릴리스 커밋을 지정하세요.');
    process.exit(1);
  }
  const to = arg('--to'); // null 이면 작업트리와 비교.

  let skills;
  try {
    skills = changedSkills(from, to);
  } catch (e) {
    console.error('git diff 실패(레포/ref 확인 필요):', e.message);
    process.exit(1);
  }

  console.log(`version=${version} from=${from.slice(0, 12)} to=${to || '작업트리'} 바뀐 스킬(${skills.length}): ${skills.join(', ') || '없음'}`);

  if (printOnly) return;
  if (!skills.length) {
    console.log('바뀐 스킬이 없어 항목을 추가하지 않습니다(빈 배열은 개인화에 무의미).');
    return;
  }

  let manifest = {};
  try {
    const obj = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) manifest = obj;
  } catch { /* 없음·malformed → 새로 만든다 */ }

  manifest[version] = skills;
  // 버전 키를 semver 순으로 정렬해 안정적 diff.
  const sorted = {};
  for (const k of Object.keys(manifest).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) sorted[k] = manifest[k];
  fs.writeFileSync(manifestPath, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`skill-changes.json 갱신: [${version}] = ${skills.join(', ')}`);
}

if (require.main === module) main();

module.exports = { changedSkills, excludedPatterns, globToRegExp, isShipped };
