// Tests for gemini-seat.mjs. Run from the repo root: node --test skills/ralph-qa/references/gemini-seat.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { POLICY, policyIntact, sessionFolders, staleSessionFolders, strayEnvFiles } from "./gemini-seat.mjs";

const SEAT = fileURLToPath(new URL("./gemini-seat.mjs", import.meta.url));

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "gemini-seat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// GEMINI_CLI_HOME at the filesystem root puts every folder inside "the home": the walk up for
// .env files then checks nothing, whatever this machine keeps above its temp folder.
const run = (script, args, env = {}) => spawnSync(process.execPath, [script, ...args],
  { encoding: "utf8", env: { ...process.env, GEMINI_CLI_HOME: parse(tmpdir()).root, ...env } });

test("the shipped policy denies every tool and nothing else", () => {
  assert.ok(policyIntact(readFileSync(POLICY, "utf8")));
  const extra = readFileSync(POLICY, "utf8") + '\n[[rule]]\ntoolName = "read_file"\ndecision = "allow"\npriority = 200\n';
  assert.equal(policyIntact(extra), false, "an allow rule opens a tool");
  assert.equal(policyIntact(readFileSync(POLICY, "utf8").replace('"deny"', '"allow"')), false);
  assert.equal(policyIntact(""), false);
  assert.equal(policyIntact(null), false);
  assert.ok(policyIntact("# comments change freely\n[[rule]]\n  toolName = \"*\"  # all\ndecision = \"deny\"\n\npriority = 100\n"));
});

test("check prints the policy path for a seat folder, and refuses a changed or missing policy", (t) => {
  const dir = scratch(t);
  const seat = join(dir, "gemini");
  mkdirSync(seat);
  const ok = run(SEAT, ["check", seat]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), POLICY);
  const copy = join(dir, "refs");
  mkdirSync(copy);
  copyFileSync(SEAT, join(copy, "gemini-seat.mjs"));
  const changed = run(join(copy, "gemini-seat.mjs"), ["check", seat]);
  assert.equal(changed.status, 1, "no policy next to the script");
  assert.match(changed.stderr, /missing or is not the shipped deny-all policy/);
  writeFileSync(join(copy, "gemini-read-only.toml"), '[[rule]]\ntoolName = "*"\ndecision = "allow"\npriority = 100\n');
  assert.equal(run(join(copy, "gemini-seat.mjs"), ["check", seat]).status, 1, "a policy that allows");
  assert.equal(changed.stdout, "", "no path to run with");
});

test("a .env above the seat folder stops the seat unless it sits in the home", (t) => {
  const dir = scratch(t);
  const home = join(dir, "home");
  const seat = join(dir, "base", "ralph-qa.x", "gemini");
  const inHome = join(home, ".cache", "ralph-qa.y", "gemini");
  for (const d of [seat, inHome, join(dir, "base", ".gemini")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dir, "base", ".env"), "GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:9\n");
  writeFileSync(join(dir, "base", ".gemini", ".env"), "GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:9\n");
  writeFileSync(join(home, ".env"), "MY_OWN=1\n");
  const env = { GEMINI_CLI_HOME: home };
  const above = strayEnvFiles(seat, { env });
  assert.ok(above.includes(join(dir, "base", ".env")) && above.includes(join(dir, "base", ".gemini", ".env")), above.join(", "));
  assert.ok(!strayEnvFiles(inHome, { env }).includes(join(home, ".env")), "the account's own .env is not a stray one");
  const refused = run(SEAT, ["check", seat], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /gemini would read .*\.env/);
  assert.equal(refused.stdout, "");
});

test("clean removes only the gemini session folders that name the seat folder", (t) => {
  const dir = scratch(t);
  const home = join(dir, "gh");
  const seat = join(dir, "d", "gemini");
  mkdirSync(seat, { recursive: true });
  const project = (base, name, owner) => {
    const p = join(home, ...base, name);
    mkdirSync(join(p, "chats"), { recursive: true });
    writeFileSync(join(p, ".project_root"), owner);
    writeFileSync(join(p, "chats", "session-1.jsonl"), '{"payload": "REVIEW-MARKER"}\n');
    return p;
  };
  const mine = [project([".gemini", "tmp"], "gemini", seat), project([".gemini", "history"], "gemini", seat + "\n"),
    project([".cache", ".gemini", "tmp"], "gemini-1", seat)];
  const other = project([".gemini", "tmp"], "work", join(dir, "work"));
  assert.deepEqual(sessionFolders(seat, { env: { GEMINI_CLI_HOME: home } }).sort(), [...mine].sort());
  if (process.platform !== "win32") {
    symlinkSync(other, join(home, ".gemini", "tmp", "link"));
  }
  const out = run(SEAT, ["clean", seat], { GEMINI_CLI_HOME: home });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).removed.sort(), [...mine].sort());
  assert.ok(mine.every((p) => !existsSync(p)));
  assert.ok(existsSync(join(other, "chats", "session-1.jsonl")), "another project's sessions stay");
  if (process.platform !== "win32") assert.ok(existsSync(join(home, ".gemini", "tmp", "link")), "a link is left alone");
  assert.deepEqual(JSON.parse(run(SEAT, ["clean", seat], { GEMINI_CLI_HOME: home }).stdout).removed, []);
});

test("a policy copy with a byte order mark or a no-break space is refused, as gemini drops such a file", () => {
  const shipped = readFileSync(POLICY, "utf8");
  assert.equal(policyIntact("\uFEFF" + shipped), false, "BOM");
  assert.equal(policyIntact(shipped.replace('toolName = "*"', 'toolName\u00A0= "*"')), false, "no-break space");
  assert.equal(policyIntact(shipped.replace("priority = 100", "priority = 100\u3000")), false, "ideographic space");
  assert.ok(policyIntact(shipped.replace(/\n/g, "\r\n")), "CRLF line ends stay fine");
  assert.ok(policyIntact(shipped.replace('decision = "deny"', '\tdecision = "deny"  ')), "tabs and spaces around a rule stay fine");
});

test("clean finds a seat folder's records after the folder is gone, and sweep finds those of every gone seat under a base", (t) => {
  const dir = scratch(t);
  const home = join(dir, "gh");
  const base = join(dir, "base");
  const gone = join(base, "ralph-qa.aaaaaa", "gemini");
  const gone2 = join(base, "ralph-qa.bbbbbb", "gemini");
  const live = join(base, "ralph-qa.cccccc", "gemini");
  mkdirSync(live, { recursive: true });
  const project = (name, owner) => {
    const p = join(home, ".gemini", "tmp", name);
    mkdirSync(join(p, "chats"), { recursive: true });
    writeFileSync(join(p, ".project_root"), owner);
    return p;
  };
  const env = { GEMINI_CLI_HOME: home };
  const a = project("gemini", gone);
  const b = project("gemini-1", gone2);
  const c = project("gemini-2", live);
  const own = project("work", join(base, "work"));
  const other = project("ralph-qa-lookalike", join(dir, "elsewhere", "ralph-qa.dddddd", "gemini"));
  const out = run(SEAT, ["clean", gone], env);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).removed, [a]);
  assert.ok(existsSync(b) && existsSync(c));
  const swept = run(SEAT, ["sweep", base], env);
  assert.equal(swept.status, 0, swept.stderr);
  assert.deepEqual(JSON.parse(swept.stdout).removed, [b], "only a gone seat folder's records under this base");
  assert.ok(existsSync(c), "a run still going keeps its records");
  assert.ok(existsSync(own) && existsSync(other));
  assert.deepEqual(staleSessionFolders(base, { env }), []);
  assert.deepEqual(JSON.parse(run(SEAT, ["sweep", join(dir, "no-base")], env).stdout).removed, []);
});

test("on Windows the seat folder and the homes are compared by their long names", () => {
  // TEMP may be spelt with a short 8.3 name (C:\Users\RUNNER~1) while the home is the long one:
  // native realpath spells both alike, so the account's own .env is not taken for a stray one.
  const long = "/users/runneradmin";
  const realpath = (p) => p.replace("/users/RUNNER~1", long);
  const seat = "/users/RUNNER~1/appdata/local/temp/ralph-qa.x/gemini";
  const exists = (f) => realpath(f) === `${long}/.env`; // one folder, two spellings
  const env = { GEMINI_CLI_HOME: long };
  assert.deepEqual(strayEnvFiles(seat, { env, platform: "win32", exists, realpath }), []);
  assert.deepEqual(strayEnvFiles(seat, { env, platform: "win32", exists, realpath: (p) => p }), ["/users/RUNNER~1/.env"],
    "without the long names the same file is outside the home");
});

test("the command line still prints the policy when node keeps the symlink it was started through", { skip: process.platform === "win32" && "symlinks need privileges" }, (t) => {
  const dir = scratch(t);
  symlinkSync(dirname(SEAT), join(dir, "refs"));
  mkdirSync(join(dir, "gemini"));
  const out = run(join(dir, "refs", "gemini-seat.mjs"), ["check", join(dir, "gemini")], { NODE_OPTIONS: "--preserve-symlinks-main" });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.trim().endsWith("gemini-read-only.toml"), "not an empty exit 0, which would open the tools");
});

test("usage errors, and a missing seat folder for check, exit 2", (t) => {
  const dir = scratch(t);
  assert.equal(run(SEAT, []).status, 2);
  assert.equal(run(SEAT, ["check"]).status, 2);
  assert.equal(run(SEAT, ["wipe", dir]).status, 2);
  assert.equal(run(SEAT, ["check", dir, dir]).status, 2);
  assert.equal(run(SEAT, ["check", join(dir, "missing")]).status, 2);
  assert.equal(run(SEAT, ["sweep"]).status, 2);
});
