// polish-loop.test.mjs: the seats.json the polishing loop's reference gives works with consensus.mjs on both runtimes.
// Codex sub-agents name the parent session's model (0.165.0: a gpt-6-luna seat answers MODEL: gpt-6.1-sol), so the
// Codex example must carry "modelCheck": "none", or merge counts no seat and ends with exit 1 every time.
// Run: node --test scripts/polish-loop.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const TMP = mkdtempSync(join(tmpdir(), 'pgg-polish-loop-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const CLI = fileURLToPath(new URL('./consensus.mjs', import.meta.url));
const DOC = readFileSync(fileURLToPath(new URL('../references/polish-loop.md', import.meta.url)), 'utf8');
const SKILL = readFileSync(fileURLToPath(new URL('../SKILL.md', import.meta.url)), 'utf8');

// The seats.json examples of the reference, in order: Claude Code, then Codex.
const examples = [...DOC.matchAll(/```json\n(\{ "scope"[\s\S]*?)```/g)].map((m) => m[1]);

function merge(name, seatsText, model, reported) {
  const deck = join(TMP, name);
  const round = join(deck, 'polish', 'round-01');
  mkdirSync(round, { recursive: true });
  writeFileSync(join(deck, 'coffee.md'), '말:\n오늘은 커피를 내리는 방법에 대해 말합니다.\n');
  writeFileSync(join(deck, 'polish', 'seats.json'), seatsText.replaceAll(model.placeholder, model.id));
  const edit = [{ file: 'coffee.md', from: '방법에 대해 말합니다', to: '방법을 말합니다', kind: '번역투', reason: '에 대해' }];
  for (const s of ['p1', 'p2', 'p3']) writeFileSync(join(round, `${s}.md`), `${JSON.stringify(edit)}\nMODEL: ${reported}\n`);
  return spawnSync(process.execPath, [CLI, 'merge', round, '--root', deck], { encoding: 'utf8' });
}

test('the reference gives a Claude Code and a Codex seats.json; only the Codex one turns the model check off', () => {
  assert.equal(examples.length, 2);
  assert.doesNotMatch(examples[0], /modelCheck/);
  assert.match(examples[1], /"modelCheck": "none"/);
  assert.match(DOC, /`spawn_agent` 를 `agent_type` 없이, `model` 에 luna id, `reasoning_effort: "medium"`/);
  assert.match(DOC, /`fork_turns: "none"`/);
  assert.match(SKILL, /### 4\. 다듬기 모델 묻기[\s\S]*?"modelCheck": "none"[\s\S]*?### 5\./);
  assert.match(SKILL, /\| 다듬기 좌석 \|[^\n]*`spawn_agent`[^\n]*"modelCheck": "none"/);
});

test('Codex: luna seats that name the parent model still count with the reference seats.json (merge exit 0)', () => {
  const r = merge('codex', examples[1], { placeholder: '<luna id>', id: 'gpt-6-luna' }, 'gpt-6.1-sol');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /round 1: 1 candidates, 0 dropped/);
});

test('without modelCheck none the same Codex answers stop merge with exit 1 (what the Codex example prevents)', () => {
  const r = merge('codex-no-check', examples[0], { placeholder: '<모델>', id: 'gpt-6-luna' }, 'gpt-6.1-sol');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /0 counted proposers, three needed/);
});

test('Claude Code: seats that name their own model count with the reference seats.json', () => {
  const r = merge('claude', examples[0], { placeholder: '<모델>', id: 'sonnet' }, 'claude-sonnet-5-5');
  assert.equal(r.status, 0, r.stderr);
});
