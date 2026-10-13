// The command line scripts here must run when reached through a linked folder. Node resolves links
// for import.meta.url but not for process.argv[1], so comparing the two as given made such a run exit
// 0 without doing anything. The link is a folder junction on Windows, where a file symlink needs
// admin rights; elsewhere 'junction' is ignored and it is a plain symlink. Run from the repo root:
//   node --test skills/3d-intro-build/references/direct-run.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-run-'));
const link = path.join(tmp, 'linked');
let linked = true;
try {
  fs.symlinkSync(HERE, link, 'junction');
} catch {
  linked = false;
}
// The link goes first, on its own: removing it never touches the folder it points to.
after(() => {
  if (linked) fs.unlinkSync(link);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const empty = () => fs.mkdtempSync(path.join(tmp, 'site-'));
const CASES = [
  { script: 'serve.mjs', args: () => [empty(), '--stop'], status: 0, stdout: /^STOP no-state$/m },
  { script: 'curate.mjs', args: () => [empty(), '--stop'], status: 0, stdout: /^STOP no-state$/m },
  { script: 'verify-intro.mjs', args: () => [], status: 2, stderr: /^usage: node verify-intro\.mjs /m },
  { script: 'assemble.mjs', args: () => [], status: 1, stderr: /^usage: node assemble\.mjs /m },
];

for (const c of CASES) {
  test(`${c.script} answers the same through a linked folder as through its own path`, (t) => {
    if (!linked) {
      t.skip('links cannot be made here');
      return;
    }
    for (const dir of [HERE, link]) {
      const r = spawnSync(process.execPath, [path.join(dir, c.script), ...c.args()], { encoding: 'utf8', timeout: 30000 });
      const seen = `${dir}: status ${r.status}, stdout ${JSON.stringify(r.stdout)}, stderr ${JSON.stringify(r.stderr)}`;
      assert.equal(r.status, c.status, seen);
      if (c.stdout) assert.match(r.stdout, c.stdout, seen);
      if (c.stderr) assert.match(r.stderr, c.stderr, seen);
    }
  });
}
