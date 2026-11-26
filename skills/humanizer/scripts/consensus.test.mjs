// consensus.test.mjs: merge, tally and the protected-text guard of the consensus loop. Run: node --test scripts/consensus.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, findArray, modelMismatch, parseArgs, parseReply, protectedChange, readSeats, run } from './consensus.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'humanizer-consensus-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const CLI = fileURLToPath(new URL('./consensus.mjs', import.meta.url));

const TEXT = '이 기능은 사용자에 대해 많은 편의를 제공하는 것이 가능하다.\n설치는 `npm i -g banker` 로 하고, 버전은 2.8.0 이다.\n그는 "그대로 둔다" 라고 말했다.\n';
const SEATS = {
  proposers: [{ seat: 'p1', model: 'sonnet', effort: 'medium' }, { seat: 'p2', model: 'haiku', effort: 'medium' }, { seat: 'p3', model: 'sonnet', effort: 'low' }],
  voters: [{ seat: 'v1', model: 'sonnet', effort: 'medium' }, { seat: 'v2', model: 'haiku', effort: 'low' }, { seat: 'v3', model: 'sonnet', effort: 'low' }],
};

function work(name, seats = SEATS) {
  const dir = join(TMP, name);
  mkdirSync(join(dir, 'round-01'), { recursive: true });
  writeFileSync(join(dir, 'text.md'), TEXT);
  writeFileSync(join(dir, 'seats.json'), JSON.stringify(seats));
  return { dir, round: join(dir, 'round-01') };
}
const reply = (items, model) => `검토했습니다.\n\`\`\`json\n${JSON.stringify(items)}\n\`\`\`\nMODEL: ${model}\n`;
const put = (round, seat, text) => writeFileSync(join(round, `${seat}.md`), text);
const EDIT = { file: 'text.md', from: '사용자에 대해 많은 편의를 제공하는 것이 가능하다', to: '사용자에게 많은 편의를 준다', kind: '번역투', reason: '에 대해, 것이 가능하다' };
const EDIT2 = { ...EDIT, to: '사용자에게 편의를 많이 준다' };

test('a reply gives its array (fenced or bare) and its last MODEL line', () => {
  assert.deepEqual(parseReply(reply([{ a: 1 }], 'claude-haiku-5-5')), { items: [{ a: 1 }], model: 'claude-haiku-5-5' });
  assert.deepEqual(findArray('결과: [{"id": 1, "vote": "accept"}] 끝'), [{ id: 1, vote: 'accept' }]);
  assert.deepEqual(parseReply('[]\n**MODEL: gpt-5.6-luna**'), { items: [], model: 'gpt-5.6-luna' });
  assert.equal(parseReply('고칠 것이 없습니다').items, null);
});

test('a model family other than the seat\'s is a mismatch; unknown or missing is not', () => {
  assert.equal(modelMismatch('haiku', 'claude-haiku-5-5'), false);
  assert.equal(modelMismatch('sonnet', 'claude-haiku-5-5'), true);
  assert.equal(modelMismatch('gpt-5.6-luna', 'gpt-5.6-luna'), false);
  assert.equal(modelMismatch('gpt-5.6-luna', 'gpt-6.1-sol'), true);
  assert.equal(modelMismatch('sonnet', ''), false);
  assert.equal(modelMismatch('sonnet', 'I do not know'), false);
});

test('seats.json: three proposers and three voters or more, own names, effort none, low or medium', () => {
  const bad = (seats, re) => {
    const { dir, round } = work(`seats-${Math.random().toString(16).slice(2)}`, seats);
    assert.throws(() => readSeats(round), re);
    rmSync(dir, { recursive: true, force: true });
  };
  bad({ ...SEATS, proposers: SEATS.proposers.slice(0, 2) }, /proposers needs three seats/);
  bad({ ...SEATS, voters: [...SEATS.voters.slice(0, 2), { seat: 'v3', model: 'sonnet', effort: 'high' }] }, /effort must be one of none, low, medium/);
  bad({ ...SEATS, voters: [...SEATS.voters.slice(0, 2), { seat: 'p1', model: 'sonnet', effort: 'low' }] }, /a voter is never a proposer/);
  const { round } = work('seats-ok');
  assert.equal(readSeats(round).scope, 'full');
});

test('protected text: fences, inline code, numbers, paths and quotes come through unchanged', () => {
  const text = '앞 `npm i` 뒤 2.8.0 과 /usr/bin 과 "인용" 끝\n```\n코드 안\n```\n';
  const at = (s) => text.indexOf(s);
  assert.equal(protectedChange(text, at('앞'), '앞 `npm i` 뒤', '앞의 `npm i` 뒤'), '');
  assert.match(protectedChange(text, at('`npm'), '`npm', '`pnpm'), /cuts through protected text/);
  assert.match(protectedChange(text, at('2.8.0 과'), '2.8.0 과', '2.9.0 과'), /changes protected text/);
  assert.match(protectedChange(text, at('2.8'), '2.8', '2.9'), /cuts through/);
  assert.match(protectedChange(text, at('/usr/bin 과'), '/usr/bin 과', '/usr/local/bin 과'), /changes protected text/);
  assert.match(protectedChange(text, at('"인용" 끝'), '"인용" 끝', '"인용문" 끝'), /changes protected text/);
  assert.equal(protectedChange(text, at('"인용" 끝'), '"인용" 끝', '“인용” 끝'), '', 'curly and straight quotes hold the same quotation');
  assert.match(protectedChange(text, at('코드 안'), '코드 안', '코드'), /inside a code fence/);
  assert.equal(protectedChange("const t = \"커피\";", 11, '커피', '커피 한 잔', { code: true }), '', 'quotes are string marks in a code file');
});

test('merge groups the same from into one candidate, keeps every to, and drops what cannot be a candidate', () => {
  const { dir, round } = work('merge');
  put(round, 'p1', reply([EDIT, { file: 'text.md', from: '2.8.0', to: '2.9.0' }], 'claude-sonnet-5-5'));
  put(round, 'p2', reply([EDIT2, { file: 'text.md', from: '없는 글', to: 'x' }], 'claude-haiku-5-5'));
  put(round, 'p3', reply([EDIT, { file: '../out.md', from: 'a', to: 'b' }, { file: 'text.md', from: '"그대로 둔다"', to: '"바꾼다"' }], 'claude-sonnet-5-5'));
  const lines = run(['merge', round, '--root', dir]);
  const c = JSON.parse(readFileSync(join(round, 'candidates.json'), 'utf8'));
  assert.equal(c.round, 1);
  assert.equal(c.candidates.length, 1);
  assert.deepEqual(c.candidates[0].to, [EDIT.to, EDIT2.to]);
  assert.deepEqual(c.candidates[0].by, ['p1', 'p2', 'p3']);
  const PROT = 'changes protected text (code, URL, path, flag, number or quote)';
  assert.deepEqual(c.dropped.map((d) => d.reason), [PROT, 'from not found', 'file not found or outside the root', PROT]);
  assert.deepEqual(c.proposers.map((p) => [p.seat, p.model, p.effort, p.reported, p.items, p.counted]),
    [['p1', 'sonnet', 'medium', 'claude-sonnet-5-5', 2, true], ['p2', 'haiku', 'medium', 'claude-haiku-5-5', 2, true], ['p3', 'sonnet', 'low', 'claude-sonnet-5-5', 3, true]]);
  assert.equal(lines.at(-1), 'round 1: 1 candidates, 4 dropped');
});

test('merge stops with exit 1 and names the seats to run again when fewer than three proposers count', () => {
  const { dir, round } = work('few');
  put(round, 'p1', reply([EDIT], 'claude-sonnet-5-5'));
  put(round, 'p2', '고칠 것이 없습니다.\nMODEL: claude-haiku-5-5');
  put(round, 'p3', reply([EDIT], 'claude-opus-5-5'));
  const r = spawnSync(process.execPath, [CLI, 'merge', round, '--root', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /1 counted proposers, three needed; run these seats again:\n {2}p2: no JSON array in the reply\n {2}p3: reply names claude-opus-5-5, not sonnet/);
  assert.equal(existsSync(join(round, 'candidates.json')), false);
});

function candidates(list) {
  return list.map((c, i) => ({ id: i + 1, file: 'text.md', kind: [], reason: [], by: ['p1'], ...c }));
}
const voter = (seat, ballots) => ({ seat, counted: true, items: ballots });

test('decide: two of three accept; the preferred to with most accept votes wins, ties keep the first proposed', () => {
  const cs = candidates([{ from: '사용자에 대해', to: ['사용자에게', '사용자한테'] }, { from: '것이 가능하다', to: ['수 있다'] }]);
  const vs = [
    voter('v1', [{ id: 1, vote: 'accept', preferredTo: '사용자한테' }, { id: 2, vote: 'accept' }]),
    voter('v2', [{ id: 1, vote: 'accept', preferredTo: '사용자한테' }, { id: 2, vote: 'reject' }]),
    voter('v3', [{ id: 1, vote: 'reject' }]),
  ];
  const { decisions, need } = decide(cs, vs, join(TMP, 'nowhere'));
  assert.equal(need, 2);
  assert.deepEqual(decisions.map((d) => [d.decision, d.to_final, d.votes]), [
    ['accepted', '사용자한테', { accept: 2, reject: 1, abstain: 0 }],
    ['rejected', '', { accept: 1, reject: 1, abstain: 1 }],
  ]);
  const tie = decide(candidates([{ from: 'a', to: ['b', 'c'] }]), [voter('v1', [{ id: 1, vote: 'accept', preferredTo: 'c' }]), voter('v2', [{ id: 1, vote: 'accept', preferredTo: 'b' }]), voter('v3', [])], TMP);
  assert.equal(tie.decisions[0].to_final, 'b');
  const five = decide(candidates([{ from: 'a', to: ['b'] }]), ['1', '2', '3', '4', '5'].map((n, i) => voter(`v${n}`, [{ id: 1, vote: i < 2 ? 'accept' : 'reject' }])), TMP);
  assert.equal(five.need, 3);
  assert.equal(five.decisions[0].decision, 'rejected', 'two of five is no majority');
});

test('tally --apply writes the record, applies the accepted edit, and the next merge drops what was decided', () => {
  const { dir, round } = work('tally');
  for (const [s, m] of [['p1', 'claude-sonnet-5-5'], ['p2', 'claude-haiku-5-5'], ['p3', 'claude-sonnet-5-5']]) put(round, s, reply([EDIT], m));
  run(['merge', round, '--root', dir]);
  put(round, 'v1', reply([{ id: 1, vote: 'accept', preferredTo: EDIT.to, reason: '자연스러움' }], 'claude-sonnet-5-5'));
  put(round, 'v2', reply([{ id: 1, vote: 'accept' }], 'claude-haiku-5-5'));
  put(round, 'v3', reply([{ id: 1, vote: 'reject', reason: '뜻이 조금 바뀜' }], 'claude-sonnet-5-5'));
  const dry = run(['tally', round, '--root', dir, '--apply', '--dry-run']);
  assert.match(dry.join('\n'), /WOULD APPLY text\.md/);
  assert.equal(existsSync(join(round, 'round.json')), false, 'a dry run writes nothing');
  assert.equal(readFileSync(join(dir, 'text.md'), 'utf8'), TEXT);
  const lines = run(['tally', round, '--root', dir, '--apply']);
  assert.equal(lines.at(-1), 'round 1: 1 new consensus (need 2 of 3 votes)');
  assert.match(readFileSync(join(dir, 'text.md'), 'utf8'), /^이 기능은 사용자에게 많은 편의를 준다\.\n/);
  const rec = JSON.parse(readFileSync(join(round, 'round.json'), 'utf8'));
  assert.deepEqual([rec.round, rec.applied, rec.newConsensus, rec.candidates[0].decision], [1, 1, 1, 'accepted']);
  assert.deepEqual(rec.voters.map((v) => [v.seat, v.model, v.effort, v.reported, v.counted]), [['v1', 'sonnet', 'medium', 'claude-sonnet-5-5', true], ['v2', 'haiku', 'low', 'claude-haiku-5-5', true], ['v3', 'sonnet', 'low', 'claude-sonnet-5-5', true]]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'decided.json'), 'utf8')), [{ round: 1, file: 'text.md', from: EDIT.from, to: EDIT.to, decision: 'accepted' }]);
  assert.deepEqual(readdirSync(round).filter((f) => f.endsWith('.tmp')), []);
  // round 2: the undo of the accepted edit is dropped, and a round with no candidate is a zero round
  const r2 = join(dir, 'round-02');
  mkdirSync(r2);
  const undo = { file: 'text.md', from: EDIT.to, to: EDIT.from };
  for (const [s, m] of [['p1', 'claude-sonnet-5-5'], ['p2', 'claude-haiku-5-5'], ['p3', 'claude-sonnet-5-5']]) put(r2, s, reply(s === 'p1' ? [undo] : [], m));
  run(['merge', r2, '--root', dir]);
  assert.match(JSON.parse(readFileSync(join(r2, 'candidates.json'), 'utf8')).dropped[0].reason, /undoes an edit accepted in round 1/);
  assert.equal(JSON.parse(readFileSync(join(r2, 'candidates.json'), 'utf8')).candidates.length, 0);
  assert.equal(run(['tally', r2, '--root', dir, '--apply']).at(-1), 'round 2: 0 new consensus (no candidate, no vote)', 'no candidate: no voter is needed');
  assert.deepEqual(JSON.parse(readFileSync(join(r2, 'round.json'), 'utf8')).voters, []);
});

test('overlapping accepted edits: more accept votes stays, the other is deferred and not decided', () => {
  const { dir, round } = work('overlap');
  const a = { file: 'text.md', from: '많은 편의를 제공하는', to: '많은 편의를 주는' };
  const b = { file: 'text.md', from: '제공하는 것이 가능하다', to: '줄 수 있다' };
  for (const [s, m] of [['p1', 'claude-sonnet-5-5'], ['p2', 'claude-haiku-5-5'], ['p3', 'claude-sonnet-5-5']]) put(round, s, reply([a, b], m));
  run(['merge', round, '--root', dir]);
  put(round, 'v1', reply([{ id: 1, vote: 'accept' }, { id: 2, vote: 'accept' }], 'claude-sonnet-5-5'));
  put(round, 'v2', reply([{ id: 1, vote: 'accept' }, { id: 2, vote: 'accept' }], 'claude-haiku-5-5'));
  put(round, 'v3', reply([{ id: 1, vote: 'reject' }, { id: 2, vote: 'accept' }], 'claude-sonnet-5-5'));
  run(['tally', round, '--root', dir, '--apply']);
  const rec = JSON.parse(readFileSync(join(round, 'round.json'), 'utf8'));
  assert.deepEqual(rec.candidates.map((c) => c.decision), ['deferred', 'accepted']);
  assert.match(rec.candidates[0].note, /overlaps candidate 2/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'decided.json'), 'utf8')).map((d) => d.from), [b.from]);
  assert.match(readFileSync(join(dir, 'text.md'), 'utf8'), /많은 편의를 줄 수 있다/);
});

test('init makes a new work folder under the temp folder and copies --from; a full --dir is refused', () => {
  const html = join(TMP, 'page.html');
  writeFileSync(html, '<p>Hi</p>\n');
  const hl = run(['init', '--from', html]);
  assert.match(hl[1], /text\.html$/, 'another extension is kept');
  rmSync(hl[0].replace(/^work /, ''), { recursive: true, force: true });
  const src = join(TMP, 'in.txt');
  writeFileSync(src, 'Hello there.\n');
  const lines = run(['init', '--from', src]);
  const w = lines[0].replace(/^work /, '');
  try {
    assert.match(w, /humanizer-/);
    assert.equal(lines[1], `text ${join(w, 'text.md')}`, 'a plain-text name is copied as .md');
    assert.equal(readFileSync(join(w, 'text.md'), 'utf8'), 'Hello there.\n');
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
  const full = join(TMP, 'full');
  mkdirSync(full);
  writeFileSync(join(full, 'x'), '');
  assert.throws(() => run(['init', '--dir', full]), /is not empty/);
  assert.equal(run(['init', '--dir', join(TMP, 'fresh')])[0], `work ${join(TMP, 'fresh')}`);
});

test('CLI: usage errors exit 2', () => {
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [CLI, 'merge', TMP], { encoding: 'utf8' }).status, 2, 'merge needs --root');
  assert.equal(spawnSync(process.execPath, [CLI, 'tally', join(TMP, 'not-a-round'), '--root', TMP], { encoding: 'utf8' }).status, 2);
  assert.throws(() => parseArgs(['merge', 'x', '--root']), /--root needs a value/);
  assert.throws(() => parseArgs(['merge', 'x', '--nope']), /unknown argument --nope/);
  const { round } = work('cli');
  const r = spawnSync(process.execPath, [CLI, 'merge', round, '--root', TMP], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'no reply files: no counted proposers');
  assert.match(r.stderr, /p1: no p1\.md/);
});
