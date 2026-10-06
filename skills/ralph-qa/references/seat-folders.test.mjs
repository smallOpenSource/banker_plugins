// Tests for steps 1 and 6 of SKILL.md's "외부 좌석 전송": the folders step 1 makes and the day rule
// of step 6 that removes the folders a cut-short run left, taken from the skill as written.
// Run from the repo root: node --test skills/ralph-qa/references/seat-folders.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SKILL = readFileSync(fileURLToPath(new URL("../SKILL.md", import.meta.url)), "utf8");
const BLOCK = ((SKILL.split("## 외부 좌석 전송")[1] || "").match(/```bash\n([\s\S]*?)```/) || [])[1] || "";
const STEP1 = (BLOCK.match(/^case "\$\(uname -s\)"[\s\S]*?echo "d=\$d o=\$o"$/m) || [])[0] || "";
const DAY_RULE = (BLOCK.match(/^find "\$\(dirname "\$d"\)" .*$/m) || [])[0] || "";
const PS_RULE = (SKILL.match(/하루 규칙 `(Get-ChildItem [^`]+)`/) || [])[1] || "";

const works = (cmd, arg = "--version") => spawnSync(cmd, [arg], { encoding: "utf8" }).status === 0;
const SKIP = process.platform === "win32" ? "Git Bash path handling is not checked on Windows" : !works("bash") ? "no bash" : false;
const PS_SKIP = process.platform === "win32" ? "checked where bash is" : !works("pwsh", "-Version") ? "no pwsh" : false;

const DAYS_2 = (Date.now() - 2 * 86400 * 1000) / 1000;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "rq-folders-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A base folder as a cut-short run and the user leave it: two marked copies past a day, two
// unmarked folders of the user's under the same names, a marked copy of today, and a link to a
// marked copy elsewhere.
function base(dir) {
  const b = join(dir, "run");
  const folder = (name, { marked = true, old = true } = {}, at = b) => {
    const p = join(at, name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "prompt.md"), "payload\n");
    if (marked) writeFileSync(join(p, ".ralph-qa"), "");
    if (old) utimesSync(p, DAYS_2, DAYS_2);
    return p;
  };
  folder("ralph-qa.abc123");
  folder("ralph-qa-out.def456");
  folder("ralph-qa.backup", { marked: false });
  folder("ralph-qa-out.zzzzzz", { marked: false });
  folder("ralph-qa.new123", { old: false });
  const target = folder("ralph-qa.tgt123", {}, join(dir, "elsewhere"));
  symlinkSync(target, join(b, "ralph-qa.lnk123"));
  return { b, target };
}

function left(b, target) {
  const has = (name) => {
    try {
      lstatSync(join(b, name));
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(has("ralph-qa.abc123"), false, "a marked copy past a day is removed");
  assert.equal(has("ralph-qa-out.def456"), false, "a marked answer folder past a day is removed");
  assert.equal(has("ralph-qa.backup"), true, "a user's folder without the marker stays");
  assert.equal(has("ralph-qa-out.zzzzzz"), true, "a user's folder without the marker stays");
  assert.equal(has("ralph-qa.new123"), true, "a copy of today stays");
  assert.equal(has("ralph-qa.lnk123"), true, "a link is no folder of the run");
  assert.ok(existsSync(join(target, "prompt.md")), "the folder a link points to stays");
}

test("the skill still holds step 1 and both day rules these tests run", () => {
  assert.ok(STEP1, "no step 1 in the bash block");
  assert.ok(DAY_RULE, "no day rule in the bash block");
  assert.ok(PS_RULE, "no PowerShell day rule");
});

test("step 1 marks both folders it makes, so the day rule can tell them from a user's", { skip: SKIP }, (t) => {
  const dir = scratch(t);
  const run = join(dir, "run");
  mkdirSync(run);
  const env = { PATH: process.env.PATH, HOME: join(dir, "home"), XDG_RUNTIME_DIR: run, TMPDIR: run };
  const r = spawnSync("bash", ["-c", STEP1], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const m = r.stdout.match(/^d=(\S+) o=(\S+)$/m);
  assert.ok(m, r.stdout);
  for (const p of [m[1], m[2]]) assert.ok(existsSync(join(p, ".ralph-qa")), `no marker in ${p}`);
});

test("the day rule removes only marked folders past a day, never a user's folder or a link", { skip: SKIP }, (t) => {
  const dir = scratch(t);
  const { b, target } = base(dir);
  const r = spawnSync("bash", ["-c", `d='${join(b, "ralph-qa.cur999")}'\n${DAY_RULE}`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  left(b, target);
});

test("the PowerShell day rule removes only marked folders past a day, never a user's folder or a link", { skip: PS_SKIP }, (t) => {
  const dir = scratch(t);
  const { b, target } = base(dir);
  const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `$d = '${join(b, "ralph-qa.cur999")}'; ${PS_RULE}`],
    { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  left(b, target);
});
