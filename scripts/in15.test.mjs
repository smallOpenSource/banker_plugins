// The 15-second watch (`in15`) the install skills put around a network check: the line as each document writes it,
// run with sh. It returns the command's exit code, stops a command past 15 s with 143 and a line that says so, and
// gives the caller's output pipe back as soon as the command ends (a watch that kept the pipe open made a caller that
// reads to its end wait 15 s more, 0.20.5 review).
// Run from the repo root: node --test scripts/in15.test.mjs
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS = ["commands/setup.md", ...readdirSync(join(ROOT, "skills")).map((s) => `skills/${s}/SKILL.md`)]
  .filter((f) => { try { return readFileSync(join(ROOT, f), "utf8").includes("in15() {"); } catch { return false; } });
const defOf = (f) => readFileSync(join(ROOT, f), "utf8").split("\n").map((l) => l.trim()).find((l) => l.startsWith("in15() {"));
const SKIP = process.platform === "win32" ? "a POSIX shell function" : spawnSync("sh", ["-c", "exit 0"]).status !== 0 && "no sh";

// Runs `in15 <cmd>` in sh with its output on a pipe: the exit code, the output, and when the pipe closed.
function watch(cmd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn("sh", ["-c", `${defOf(DOCS[0])}\nin15 ${cmd}`], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (b) => { out += b; });
    c.stderr.on("data", (b) => { out += b; });
    let code;
    c.on("exit", (status) => { code = status; });
    c.on("close", () => resolve({ code, out, closeMs: Date.now() - t0 }));
  });
}

test("every document that defines in15 writes the same line", { skip: SKIP }, () => {
  assert.ok(DOCS.length >= 10, DOCS.join(", "));
  const defs = new Set(DOCS.map(defOf));
  assert.equal(defs.size, 1, [...defs].join("\n"));
});

test("in15 gives back the command's exit code and the caller's pipe as soon as the command ends", { skip: SKIP }, async () => {
  for (const [cmd, code] of [["true", 0], ["sh -c 'exit 7'", 7]]) {
    const r = await watch(cmd);
    assert.equal(r.code, code, `${cmd}: ${r.out}`);
    assert.ok(r.closeMs < 5000, `${cmd}: the output pipe closed after ${r.closeMs} ms`);
    assert.equal(r.out, "", cmd);
  }
});

test("in15 stops a command past 15 s with 143 and says so", { skip: SKIP, timeout: 60000 }, async () => {
  const r = await watch("sleep 40");
  assert.equal(r.code, 143, r.out);
  assert.match(r.out, /15초 안에 끝나지 않아 멈춤/);
  assert.ok(r.closeMs >= 14000 && r.closeMs < 25000, `closed after ${r.closeMs} ms`);
});
