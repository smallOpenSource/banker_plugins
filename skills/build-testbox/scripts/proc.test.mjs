// build-testbox child processes: a time limit ends what the child started too, and the run returns even when a
// grandchild holds the pipes; the command line runs when reached through a linked folder.
// Run: node --test skills/build-testbox/scripts/proc.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runProc } from "./proc.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const base = mkdtempSync(join(tmpdir(), "testbox-proc-"));
after(() => rmSync(base, { recursive: true, force: true }));

// A child that starts a grandchild holding the same pipes and living 30 seconds, then waits itself.
const PARENT = [
  "const { spawn } = require('child_process');",
  "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });",
  "console.log('grandchild ' + g.pid);",
  "setTimeout(() => {}, 30000);",
].join("\n");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

test("a time-out ends the child and its grandchild, and the run returns without waiting for the pipes", async () => {
  const t0 = Date.now();
  const r = await runProc(process.execPath, ["-e", PARENT], { timeoutMs: 1500 });
  const took = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.ok(took < 10000, `returned after ${took} ms`);
  const pid = Number(/grandchild (\d+)/.exec(r.stdout)?.[1]);
  assert.ok(pid > 0, r.stdout);
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((res) => setTimeout(res, 100));
  assert.equal(alive(pid), false, "the grandchild is gone too");
});

test("testbox.mjs runs when reached through a linked folder (both sides of the main check are real paths)", (t) => {
  const link = join(base, "linked");
  try {
    symlinkSync(HERE, link, "junction");
  } catch {
    return t.skip("this account cannot make a link here");
  }
  const r = spawnSync(process.execPath, [join(link, "testbox.mjs"), "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^build-testbox/);
});
