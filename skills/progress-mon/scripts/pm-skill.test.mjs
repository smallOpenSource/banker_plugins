// SKILL.md 시험(계획 9.1 SKILL.md 행, AC-2, AC-3, AC-17, AC-18). 문서가 스크립트의 실제 동작과 맞는지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP } from './progress-mon.mjs';

const T = { timeout: 60000 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(HERE);
const SKILL = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
const MARKER = 'progress-mon skill body marker v1';
const REFS = ['config.md', 'items.md', 'req-spec.md', 'reqs.md', 'flow.md', 'arch.md', 'authoring.md', 'inventory.md'];

// frontmatter: 첫 줄 --- 부터 다음 --- 까지. 돌려줌: { keys: {이름: 값}, body }
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'frontmatter 없음');
  const keys = {};
  for (const line of m[1].split('\n')) {
    const k = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (k) keys[k[1]] = k[2].replace(/^"(.*)"$/, '$1');
  }
  return { keys, body: text.slice(m[0].length) };
}

// 절 하나의 본문(## 머리부터 다음 ## 전까지).
function section(title) {
  const start = SKILL.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `절 없음: ${title}`);
  const next = SKILL.indexOf('\n## ', start + 4);
  return SKILL.slice(start, next < 0 ? undefined : next);
}

test('SKILL.md: 인코딩 UTF-8, BOM 없음, LF', T, () => {
  const buf = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'));
  assert.notEqual(buf[0], 0xef, 'BOM');
  assert.ok(!buf.includes(0x0d), 'CR');
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(buf));
});

test('SKILL.md: frontmatter 키는 name, description 둘. name 은 폴더 이름이고 표준 규칙', T, () => {
  const { keys } = frontmatter(SKILL);
  assert.deepEqual(Object.keys(keys).sort(), ['description', 'name']);
  assert.equal(keys.name, 'progress-mon');
  assert.equal(keys.name, path.basename(SKILL_DIR));
  assert.match(keys.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(keys.name.length <= 64);
  assert.ok(keys.description.length > 0 && keys.description.length <= 1024, `description ${keys.description.length}자`);
});

test('SKILL.md: 본문 표식 평문 한 줄, 한 번만, HTML 주석과 코드 블록 밖', T, () => {
  const { body } = frontmatter(SKILL);
  const lines = body.split('\n');
  assert.equal(lines.filter((l) => l.includes(MARKER)).length, 1);
  assert.equal(lines.filter((l) => l.trim() === MARKER).length, 1, '줄 전체가 표식');
  assert.equal(body.replace(/<!--[\s\S]*?-->/g, '').split('\n').filter((l) => l.trim() === MARKER).length, 1, 'HTML 주석 안');
  let fence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) fence = !fence;
    if (l.trim() === MARKER) assert.equal(fence, false, '코드 블록 안');
  }
});

test('SKILL.md: --help 의 하위 명령 10개가 모두 하위 명령 표에 있음, serve 는 내부용으로만', T, () => {
  const cmds = [...HELP.matchAll(/^ {2}([a-z]+) /gm)].map((m) => m[1]);
  assert.deepEqual(cmds, ['init', 'start', 'stop', 'status', 'export', 'item', 'note', 'stage', 'story', 'check']);
  const table = section('하위 명령');
  for (const c of cmds) assert.match(table, new RegExp(`^\\| \`${c}\` \\|`, 'm'), c);
  assert.match(table, /내부용 `serve`/);
});

test('SKILL.md: 인자 없는 호출 3단계(자료 폴더 없으면 init, 서버 없으면 start, URL 보고)', T, () => {
  const s = section('인자 없는 호출');
  assert.match(s, /`status` 를 실행/);
  assert.match(s, /자료 폴더 없음[\s\S]*init 절차/);
  assert.match(s, /`start` 를 실행하고 출력의 URL/);
  assert.match(s, /실행 중: <URL>[\s\S]*URL/);
  // 문서가 인용한 출력 문구는 스크립트가 실제로 내는 문구
  const server = fs.readFileSync(path.join(HERE, 'pm-server.mjs'), 'utf8');
  for (const w of ['꺼짐(자료 폴더 없음: ', '꺼짐(자료 폴더: ', '실행 중: ', '시작함: ', '이미 실행 중(재사용): ']) {
    assert.ok(SKILL.includes(w.trim()), `SKILL.md: ${w}`);
    assert.ok(server.includes(w), `pm-server.mjs: ${w}`);
  }
});

test('SKILL.md: 런타임 표(Claude Code, Codex)와 스킬 디렉터리 표기, Codex 승인 문구', T, () => {
  const s = section('런타임 표');
  assert.match(s, /^\| 항목 \| Claude Code \| Codex \|$/m);
  for (const w of ['Base directory for this skill:', '~/.codex/skills/banker-progress-mon/', './.codex/skills/banker-progress-mon/', '`.omc/progress-mon/`', '`.omx/progress-mon/`', 'sandbox_permissions: "require_escalated"', 'serve --runtime codex']) {
    assert.ok(s.includes(w), w);
  }
  for (const k of ['auto-memory', 'claude-md', 'agents-md']) assert.ok(s.includes(`\`${k}\``), k);
  // 스크립트 호출은 <S> 표기만, 절대 경로 없음(AC-3)
  assert.match(SKILL, /node "<S>\/scripts\/progress-mon\.mjs"/);
  assert.doesNotMatch(SKILL, /(?<![A-Za-z])[A-Za-z]:[\\/]/);
  assert.match(SKILL, /`skillDir`/);
});

test('SKILL.md: 규칙 줄 안내(stage, story, item, Codex --runtime codex)와 로드 한도 경고 전달 단계', T, () => {
  const rule = section('갱신 규칙(init 뒤 세션)');
  for (const w of ['`stage --id', '`story --id', '`item --key', '`note --key', '`--runtime codex`', 'state.json']) assert.ok(rule.includes(w), w);
  const init = section('init 절차');
  assert.match(init, /`경고:` 줄[\s\S]*그대로 전한다/);
  assert.match(init, /`--memory claude-md` 로 다시 등록/);
  assert.match(init, /cleansing-memory/);
  assert.match(init, /`check`[\s\S]*최대 3회/);
  assert.match(init, /자료 없음/);
  assert.match(init, /`--note`[\s\S]*`--issue`/);
});

test('SKILL.md, README.md 가 가리키는 파일이 모두 있음. references 8개', T, () => {
  assert.deepEqual(fs.readdirSync(path.join(SKILL_DIR, 'references')).sort(), [...REFS].sort());
  for (const r of REFS) assert.ok(SKILL.includes(r), `SKILL.md 가 ${r} 를 안내하지 않음`);
  const readme = fs.readFileSync(path.join(SKILL_DIR, 'README.md'), 'utf8');
  for (const [name, text] of [['SKILL.md', SKILL], ['README.md', readme]]) {
    for (const m of text.matchAll(/\b(references\/[\w.-]+\.md|scripts\/(?:pm-|progress-mon|index)[\w.-]*\.m?js|assets\/[\w./-]+\.(?:json|jsonl|md))\b/g)) {
      assert.ok(fs.existsSync(path.join(SKILL_DIR, m[1])), `${name}: ${m[1]}`);
    }
  }
});
