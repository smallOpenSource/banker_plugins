// apply-fix.test.mjs: the polishing loop's apply step. Run: node --test scripts/apply-fix.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyFixes } from './apply-fix.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'pgg-apply-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const CLI = fileURLToPath(new URL('./apply-fix.mjs', import.meta.url));

function fixture(name) {
  const root = join(TMP, name);
  mkdirSync(join(root, 'scenes'), { recursive: true });
  writeFileSync(join(root, 'deck.md'), '# 제목\r\n\r\n말:\r\n오늘은 커피를 내리는 방법을 말합니다.\r\n같은 말. 같은 말.\r\n');
  writeFileSync(join(root, 'scenes', '01.js'), "const t = '집에서 내리는 커피'; // keep\n");
  return root;
}

test('applies unique items, keeps CRLF and the rest of the file byte for byte', () => {
  const root = fixture('ok');
  const r = applyFixes([
    { file: 'deck.md', from: '내리는 방법을 말합니다', to: '내리는 방법을 이야기합니다', kind: 'wording', reason: '자연스러움' },
    { file: 'scenes/01.js', from: '집에서 내리는 커피', to: '집에서 내리는 커피 한 잔' },
  ], { root });
  assert.equal(r.applied.length, 2);
  assert.equal(r.skipped.length, 0);
  assert.equal(readFileSync(join(root, 'deck.md'), 'utf8'), '# 제목\r\n\r\n말:\r\n오늘은 커피를 내리는 방법을 이야기합니다.\r\n같은 말. 같은 말.\r\n');
  assert.equal(readFileSync(join(root, 'scenes', '01.js'), 'utf8'), "const t = '집에서 내리는 커피 한 잔'; // keep\n");
  assert.equal(r.lines.at(-1), 'applied 2, skipped 0');
  assert.deepEqual(readdirSync(root).filter((f) => f.endsWith('.tmp')), []);
});

test('skips with a reason: not found, more than once, same text, overlapping, outside the root, missing file, bad shape', () => {
  const root = fixture('skip');
  const before = readFileSync(join(root, 'deck.md'), 'utf8');
  const r = applyFixes([
    { file: 'deck.md', from: '없는 문장', to: 'x' },
    { file: 'deck.md', from: '같은 말.', to: '다른 말.' },
    { file: 'deck.md', from: '오늘은', to: '오늘은' },
    { file: 'deck.md', from: '커피를 내리는', to: '커피를 내려 마시는' },
    { file: 'deck.md', from: '내리는 방법', to: '내리는 법' },
    { file: '../outside.md', from: 'a', to: 'b' },
    { file: 'nope.md', from: 'a', to: 'b' },
    { file: 'deck.md', to: 'b' },
  ], { root });
  const reasons = r.skipped.map((s) => s.reason);
  assert.deepEqual(reasons, ['from and to are the same', 'file is outside the root', 'file not found', 'needs file, from and to as text',
    'from not found', 'from found 2 times', 'overlaps item 4 in the same file; merge them into one']);
  assert.equal(r.applied.length, 1, 'the first of the two overlapping items is applied');
  assert.match(readFileSync(join(root, 'deck.md'), 'utf8'), /커피를 내려 마시는 방법/);
  assert.notEqual(readFileSync(join(root, 'deck.md'), 'utf8'), before);
  assert.equal(r.lines.at(-1), 'applied 1, skipped 7');
});

test('--dry-run reports what it would apply and writes nothing (CLI)', () => {
  const root = fixture('dry');
  const before = readFileSync(join(root, 'deck.md'), 'utf8');
  const list = join(TMP, 'accepted.json');
  writeFileSync(list, JSON.stringify({ items: [{ file: 'deck.md', from: '커피를', to: '차를' }, { file: 'deck.md', from: '없음', to: 'x' }] }));
  const r = spawnSync(process.execPath, [CLI, list, '--root', root, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^WOULD APPLY deck\.md: "커피를" to "차를"$/m);
  assert.match(r.stdout, /^SKIP deck\.md: "없음" \(from not found\)$/m);
  assert.match(r.stdout, /would apply 1, skipped 1\s*$/);
  assert.equal(readFileSync(join(root, 'deck.md'), 'utf8'), before);
  const real = spawnSync(process.execPath, [CLI, list, '--root', root], { encoding: 'utf8' });
  assert.match(real.stdout, /applied 1, skipped 1\s*$/);
  assert.match(readFileSync(join(root, 'deck.md'), 'utf8'), /차를 내리는/);
});

test('CLI usage errors exit 2', () => {
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status, 2);
  const bad = join(TMP, 'bad.json');
  writeFileSync(bad, '{ "nope": 1 }');
  const r = spawnSync(process.execPath, [CLI, bad], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /expected an array/);
});
