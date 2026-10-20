// Tests for omc-patch.mjs. Run from the repo root: node --test skills/omc-patch/scripts/omc-patch.test.mjs
// No network and no real home: every run uses a fake HOME in a temp dir.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

const TOOL = fileURLToPath(new URL("./omc-patch.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "omc-patch-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const HAS_GIT = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
const ORIGIN = "https://example.invalid/omc.git";

// Git run by these tests, and the tool they start, reads neither the developer's global or system config nor a
// repository the calling shell chose: GIT_DIR and the rest of `git rev-parse --local-env-vars`. A run started
// from a git hook would otherwise act on the developer's repository.
const GIT_REPO_VARS = new Set(["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR"]);
// HOME and XDG_CONFIG_HOME cover git older than 2.32, which ignores GIT_CONFIG_GLOBAL. An empty template folder
// keeps the developer's template hooks out of the fixture repositories. The developer's ceiling is dropped too, so a
// fixture that relies on git walking up still does.
const NO_GITCONFIG = join(root, "empty.gitconfig");
const NO_TEMPLATES = join(root, "empty-templates");
writeFileSync(NO_GITCONFIG, "");
mkdirSync(NO_TEMPLATES);
function cleanEnv(extra = {}) {
  const drop = (k) => GIT_REPO_VARS.has(k.toUpperCase()) || k.toUpperCase() === "GIT_CEILING_DIRECTORIES";
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop(k)));
  return { ...env, GIT_CONFIG_GLOBAL: NO_GITCONFIG, GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: NO_TEMPLATES,
    HOME: root, XDG_CONFIG_HOME: root, ...extra };
}
const runGit = (args, cwd, extra) => spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv(extra) });

const HOOKS_JSON = JSON.stringify({
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/stopper.mjs"' }] }],
    PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/foo.mjs"' }] }],
  },
}, null, 2) + "\n";
const SCRIPT = (name) => `import { pathToFileURL } from "node:url";\nconst { x } = await import("./lib.mjs");\nconsole.log("${name}:" + typeof x);\n`;
const LIB = "export const x = () => 1;\n";

let seq = 0;
// versions: [{ v, active }]. Builds ~/.claude/plugins with installed_plugins.json, cache folders and a git marketplace.
function fakeHome(versions, { git = true } = {}) {
  const home = join(root, `home${seq++}`);
  const plugins = join(home, ".claude", "plugins");
  const cache = join(plugins, "cache", "omc", "oh-my-claudecode");
  for (const { v } of versions) {
    const r = join(cache, v);
    mkdirSync(join(r, "hooks"), { recursive: true });
    mkdirSync(join(r, "scripts"), { recursive: true });
    writeFileSync(join(r, "hooks", "hooks.json"), HOOKS_JSON);
    for (const n of ["foo", "stopper"]) writeFileSync(join(r, "scripts", `${n}.mjs`), SCRIPT(n));
    writeFileSync(join(r, "scripts", "lib.mjs"), LIB);
  }
  const active = versions.find((e) => e.active).v;
  writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: { "oh-my-claudecode@omc": [{ scope: "user", installPath: join(cache, active), version: active }] },
  }, null, 2) + "\n");
  if (git) {
    const m = join(plugins, "marketplaces", "omc");
    mkdirSync(m, { recursive: true });
    for (const a of [["init", "-q"], ["remote", "add", "origin", ORIGIN]]) {
      const r = runGit(a, m);
      assert.equal(r.status, 0, r.stderr);
    }
  }
  return { home, plugins, cache, market: join(plugins, "marketplaces", "omc") };
}

// extra: variables to set for this run only, after the clean-up above (a test may set GIT_DIR on purpose).
function run(home, args, extra = {}) {
  const env = cleanEnv({ HOME: home, USERPROFILE: home, ...extra });
  // a shell may set this to point the tool at another installed_plugins.json; no test may write there
  delete env.OMC_PATCH_INSTALLED;
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
const origin = (repo) => runGit(["remote", "get-url", "origin"], repo).stdout.trim();
const read = (p) => readFileSync(p, "utf8");
const omcbaks = (dir) => readdirSync(dir).filter((f) => f.endsWith(".omcbak"));
// A home with nothing in it, and a plugin folder outside any home, as --root takes them.
function bareHome() {
  const home = join(root, `bare${seq++}`);
  mkdirSync(home, { recursive: true });
  return home;
}
function bundle() {
  const plug = join(root, `bundle${seq++}`);
  mkdirSync(join(plug, "hooks"), { recursive: true });
  mkdirSync(join(plug, "scripts"), { recursive: true });
  writeFileSync(join(plug, "hooks", "hooks.json"), HOOKS_JSON);
  for (const n of ["foo", "stopper"]) writeFileSync(join(plug, "scripts", `${n}.mjs`), SCRIPT(n));
  writeFileSync(join(plug, "scripts", "lib.mjs"), LIB);
  return plug;
}

test("check reports the active version from installed_plugins.json, not the TARGET folder", () => {
  const f = fakeHome([{ v: "5.3.0" }, { v: "5.6.1", active: true }], { git: false });
  const r = run(f.home, ["--check", "--no-update"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /활성 버전: 5\.6\.1 \(installed_plugins\.json\)/);
  assert.doesNotMatch(r.out, /활성 버전: 5\.3\.0/);
  assert.match(r.out, /적용되지 않은 항목/);
  // it names the arguments it was given, not the bare apply that would switch the version
  assert.match(r.out, /--check 없이 --no-update 로 다시 실행하십시오/);
  // check scans every installed version, so the count includes the idle folder: 2 files x 2 versions
  assert.match(r.out, /패치 필요 4건/);
  assert.match(r.out, /PostToolUse 남아있음: foo/);
  // check never writes
  assert.deepEqual(omcbaks(join(f.cache, "5.6.1", "scripts")), []);
});

test("--no-update apply patches only the active version, removes PostToolUse, pins origin; check then passes", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.3.0" }, { v: "5.6.1", active: true }]);
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /패치 2건 \/ 실패 0건/);
  assert.match(r.out, /제거: foo/);

  const act = join(f.cache, "5.6.1");
  for (const n of ["foo", "stopper"]) {
    const p = join(act, "scripts", `${n}.mjs`);
    assert.match(read(p), /__omcRaceImport\(import\(/);
    assert.equal(read(`${p}.omcbak`), SCRIPT(n));
    const c = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
    assert.equal(c.status, 0, c.stderr);
    const e = spawnSync(process.execPath, [p], { encoding: "utf8" });
    assert.equal(e.status, 0, e.stderr);
    assert.equal(e.stdout.trim(), `${n}:function`);
  }
  assert.equal(JSON.parse(read(join(act, "hooks", "hooks.json"))).hooks.PostToolUse, undefined);
  assert.ok(JSON.parse(read(join(act, "hooks", "hooks.json"))).hooks.Stop);
  assert.equal(origin(f.market), `omc-pinned://${ORIGIN}`);

  const chk = run(f.home, ["--check", "--no-update"]);
  // the active version block lists nothing to patch; the idle 5.3.0 block still does
  const activeBlock = chk.out.split("— 5.6.1")[1].split("— 5.3.0")[0];
  assert.doesNotMatch(activeBlock, /패치 필요/);
  assert.match(chk.out, /결과: 모두 적용된 상태입니다\./);
});

test("--revert restores files, hooks.json and origin", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const r = run(f.home, ["--revert"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /되돌리기 완료/);
  const act = join(f.cache, "5.6.1");
  for (const n of ["foo", "stopper"]) assert.equal(read(join(act, "scripts", `${n}.mjs`)), SCRIPT(n));
  assert.equal(read(join(act, "hooks", "hooks.json")), HOOKS_JSON);
  assert.deepEqual(omcbaks(join(act, "scripts")), []);
  assert.equal(origin(f.market), ORIGIN);
  assert.equal(existsSync(join(f.home, ".claude", "omc-local-patches", "PINNED")), false);
});

test("negative control: a version folder that is not active stays untouched by apply", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.3.0" }, { v: "5.6.1", active: true }]);
  const idle = join(f.cache, "5.3.0");
  const before = { hooks: read(join(idle, "hooks", "hooks.json")), foo: read(join(idle, "scripts", "foo.mjs")), stopper: read(join(idle, "scripts", "stopper.mjs")) };
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(join(idle, "hooks", "hooks.json")), before.hooks);
  assert.equal(read(join(idle, "scripts", "foo.mjs")), before.foo);
  assert.equal(read(join(idle, "scripts", "stopper.mjs")), before.stopper);
  assert.deepEqual(omcbaks(join(idle, "scripts")), []);
  assert.equal(existsSync(join(idle, "hooks", "hooks.json.omcbak")), false);
  // the verdict ignores the idle folder but names it as information
  const chk = run(f.home, ["--check", "--no-update"]);
  assert.match(chk.out, /결과: 모두 적용된 상태입니다\./);
  assert.match(chk.out, /참고: 비활성 버전 5\.3\.0/);
});

test("hooks with more than one top-level block keep every import working after apply", { skip: !HAS_GIT && "git not found" }, () => {
  // OMC 5.6.x project-memory-session.mjs has this shape: each top-level `await import(...)` sits in its own `try { }`.
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const p = join(f.cache, "5.6.1", "scripts", "stopper.mjs");
  writeFileSync(p, [
    "let a;",
    "try {",
    "  const m = await import(\"./lib.mjs\");",
    "  a = m.x;",
    "} catch (e) { console.log(\"first failed: \" + e.message); }",
    "let b;",
    "try {",
    "  const m = await import(\"node:path\");",
    "  b = m.join;",
    "} catch (e) { console.log(\"second failed: \" + e.message); }",
    "console.log(\"stopper:\" + typeof a + \",\" + typeof b);",
    "",
  ].join("\n"));
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 0, r.out);
  assert.match(read(p), /__omcRaceImport\(import\("node:path"\)\)/, "both sites are wrapped");
  const e = spawnSync(process.execPath, [p], { encoding: "utf8" });
  assert.equal(e.status, 0, e.stderr);
  assert.equal(e.stdout.trim(), "stopper:function,function");
});

// OMC 5.6.x project-memory-session.mjs shape: each top-level `await import(...)` sits in its own `try { }`.
const TWO_BLOCKS = [
  "let a;",
  "try {",
  "  const m = await import(\"./lib.mjs\");",
  "  a = m.x;",
  "} catch (e) { console.log(\"first failed: \" + e.message); }",
  "let b;",
  "try {",
  "  const m = await import(\"node:path\");",
  "  b = m.join;",
  "} catch (e) { console.log(\"second failed: \" + e.message); }",
  "console.log(\"stopper:\" + typeof a + \",\" + typeof b);",
  "",
].join("\n");
// What an old kit left: the helper declared at the line of the first wrapped site, inside the first block.
const MISPLACED = TWO_BLOCKS
  .replace("  const m = await import(\"./lib.mjs\");", "const __omcRaceImport = (p) => p;\n  const m = await __omcRaceImport(import(\"./lib.mjs\"));")
  .replace("await import(\"node:path\")", "await __omcRaceImport(import(\"node:path\"))");

test("an old kit's helper stuck in a block: check names it, apply leaves it, --revert --root then apply fixes it", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.7.0", active: true }]);
  const act = join(f.cache, "5.7.0");
  const p = join(act, "scripts", "stopper.mjs");
  writeFileSync(`${p}.omcbak`, TWO_BLOCKS);
  writeFileSync(p, MISPLACED);
  assert.match(spawnSync(process.execPath, [p], { encoding: "utf8" }).stdout, /second failed: __omcRaceImport is not defined/);
  const chk = run(f.home, ["--check", "--no-update"]);
  assert.match(chk.out, /헬퍼 자리 결함: stopper \(헬퍼 선언 :3 이 블록 안, 깊이 1\)/);
  // the hint reverts the active folder only: a bare --revert would undo every version and the pin
  assert.match(chk.out, /결과: 헬퍼 자리 결함 1건이 있습니다\. --revert --root "[^"]*5\.7\.0" 로 활성 폴더만 되돌린 뒤 다시 적용하십시오\./);
  const apply = run(f.home, ["--no-update"]);
  assert.match(apply.out, /\[!\] 헬퍼 자리 결함 1건은 고치지 않았습니다\./);
  assert.equal(read(p), MISPLACED, "apply cannot fix an already wrapped file");
  const pinned = origin(f.market);
  const rev = run(f.home, ["--revert", "--root", act]);
  assert.equal(rev.code, 0, rev.out);
  assert.equal(read(p), TWO_BLOCKS);
  assert.equal(read(join(act, "hooks", "hooks.json")), HOOKS_JSON);
  assert.equal(origin(f.market), pinned, "--root leaves the marketplace pin alone");
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  assert.equal(spawnSync(process.execPath, [p], { encoding: "utf8" }).stdout.trim(), "stopper:function,function");
  assert.match(run(f.home, ["--check", "--no-update"]).out, /결과: 모두 적용된 상태입니다\./);
});

test("--scan reports each helper's block depth and the wrapped sites as JSON without writing", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.7.0", active: true }]);
  const p = join(f.cache, "5.7.0", "scripts", "stopper.mjs");
  writeFileSync(p, MISPLACED);
  const bad = JSON.parse(run(f.home, ["--scan", p]).out);
  assert.equal(bad[0].helperDecls[0].depth, 1);
  assert.equal(bad[0].wrapped.length, 2);
  assert.equal(read(p), MISPLACED);
  writeFileSync(p, TWO_BLOCKS);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const good = JSON.parse(run(f.home, ["--scan", p]).out);
  assert.deepEqual(good[0].helperDecls.map((d) => d.depth), [0]);
  assert.deepEqual(good[0].unwrapped, []);
  const missing = run(f.home, ["--scan", join(f.cache, "nope.mjs")]);
  assert.equal(missing.code, 1);
  assert.ok(JSON.parse(missing.out)[0].error);
  assert.equal(run(f.home, ["--scan"]).code, 1);
});

test("--root patches a plugin folder with no installed_plugins.json, and skips the version and the pin", () => {
  const home = join(root, `bare${seq++}`);
  mkdirSync(home, { recursive: true });
  const plug = join(root, `bundle${seq++}`);
  mkdirSync(join(plug, "hooks"), { recursive: true });
  mkdirSync(join(plug, "scripts"), { recursive: true });
  writeFileSync(join(plug, "hooks", "hooks.json"), HOOKS_JSON);
  for (const n of ["foo", "stopper"]) writeFileSync(join(plug, "scripts", `${n}.mjs`), SCRIPT(n));
  writeFileSync(join(plug, "scripts", "lib.mjs"), LIB);
  const chk = run(home, ["--root", plug, "--check"]);
  assert.equal(chk.code, 0, chk.out);
  assert.match(chk.out, /건너뜀 \(--root 는 판을 바꾸지 않음\)/);
  assert.match(chk.out, /패치 필요 2건/);
  const r = run(home, ["--root", plug]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /패치 2건 \/ 실패 0건/);
  assert.match(r.out, /건너뜀 \(--root 는 마켓플레이스와 settings\.json 을 건드리지 않음\)/);
  assert.equal(existsSync(join(home, ".claude")), false, "nothing is written under the home");
  assert.match(run(home, ["--root", plug, "--check"]).out, /결과: 모두 적용된 상태입니다\./);
  assert.match(run(home, ["--root"]).out, /--root 뒤에 플러그인 폴더 경로가 필요합니다/);
  const notPlugin = run(home, ["--root", home]);
  assert.equal(notPlugin.code, 1);
  assert.match(notPlugin.out, /플러그인 폴더가 아님/);
});

test("a marketplace folder without its own .git is not pinned, and an enclosing repo keeps its origin", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }], { git: false });
  mkdirSync(f.market, { recursive: true });
  const claude = join(f.home, ".claude");
  const dotfiles = "https://example.invalid/dotfiles.git";
  for (const a of [["init", "-q"], ["remote", "add", "origin", dotfiles]]) {
    const g = runGit(a, claude);
    assert.equal(g.status, 0, g.stderr);
  }
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(origin(claude), dotfiles, "the ~/.claude repo origin is untouched");
  assert.equal(existsSync(join(claude, "omc-local-patches", "PINNED")), false);
  assert.match(r.out, /git 저장소가 아님/);
});

test("--revert --root leaves the other version folders and the pin alone; a defect without a backup stays and is named", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1" }, { v: "5.7.0", active: true }]);
  const idle = join(f.cache, "5.6.1");
  const act = join(f.cache, "5.7.0");
  assert.equal(run(f.home, ["--root", idle]).code, 0);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const pinned = origin(f.market);
  // stopper: an old kit's helper two blocks deep, and its backup gone (a hand-restored or copied folder)
  const nested = TWO_BLOCKS.replace("  const m = await import(\"./lib.mjs\");", "  if (a === undefined) {\nconst __omcRaceImport = (p) => p;\n    const m = await __omcRaceImport(import(\"./lib.mjs\"));\n  }")
    .replace("await import(\"node:path\")", "await __omcRaceImport(import(\"node:path\"))");
  const stopper = join(act, "scripts", "stopper.mjs");
  rmSync(`${stopper}.omcbak`);
  writeFileSync(stopper, nested);
  const rev = run(f.home, ["--revert", "--root", act]);
  assert.equal(rev.code, 1, rev.out);
  assert.equal(read(join(act, "scripts", "foo.mjs")), SCRIPT("foo"));
  for (const n of ["foo", "stopper"]) assert.match(read(join(idle, "scripts", `${n}.mjs`)), /__omcRaceImport/, "the idle version stays patched");
  assert.equal(origin(f.market), pinned);
  assert.doesNotMatch(rev.out, /되돌림 +stopper/, "no backup, so nothing to restore");
  assert.match(rev.out, /패치는 있는데 백업이 없어 되돌리지 못했습니다 — stopper/, "the revert names what it could not restore");
  // and it does not end as if it were done
  assert.match(rev.out, /되돌리기를 끝내지 못했습니다\. 되돌리지 못한 것 1건\./);
  assert.doesNotMatch(rev.out, /되돌리기 완료/);
  assert.equal(read(stopper), nested);
  assert.match(run(f.home, ["--check", "--no-update"]).out, /헬퍼 자리 결함: stopper \(헬퍼 선언 :\d+ 이 블록 안, 깊이 2\)/);
  assert.deepEqual(JSON.parse(run(f.home, ["--scan", stopper]).out)[0].helperDecls.map((d) => d.depth), [2]);
});

// The helper is in the file but cannot work: its declaration is missing, or it comes after the first
// top-level use, which then runs first and dies in the TDZ. Neither may pass as patched.
test("a helper with no declaration, or declared after its first top-level use, is a defect", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.7.0", active: true }]);
  const p = join(f.cache, "5.7.0", "scripts", "stopper.mjs");
  const late = [
    "const { x } = await __omcRaceImport(import(\"./lib.mjs\"));",
    "const __omcRaceImport = (q) => q;",
    "console.log(\"stopper:\" + typeof x);",
    "",
  ].join("\n");
  writeFileSync(p, late);
  assert.match(spawnSync(process.execPath, [p], { encoding: "utf8" }).stderr, /ReferenceError/, "the fixture really dies in the TDZ");
  assert.match(run(f.home, ["--check", "--no-update"]).out, /헬퍼 자리 결함: stopper \(헬퍼 선언 :2 이 첫 사용 :1 보다 뒤\)/);
  writeFileSync(p, late.replace("const __omcRaceImport = (q) => q;\n", ""));
  assert.match(run(f.home, ["--check", "--no-update"]).out, /헬퍼 자리 결함: stopper \(헬퍼 선언을 찾지 못함\)/);
  // the order is by position, so a declaration later on the same line is caught too
  writeFileSync(p, late.replace(";\nconst __omcRaceImport", "; const __omcRaceImport"));
  assert.match(run(f.home, ["--check", "--no-update"]).out, /헬퍼 자리 결함: stopper \(헬퍼 선언 :1 이 첫 사용 :1 보다 뒤\)/);
  // a function declaration is hoisted: used before it, it still works, so it is no defect
  writeFileSync(p, late.replace("const __omcRaceImport = (q) => q;", "function __omcRaceImport(q) { return q; }"));
  assert.equal(spawnSync(process.execPath, [p], { encoding: "utf8" }).stdout.trim(), "stopper:function");
  assert.doesNotMatch(run(f.home, ["--check", "--no-update"]).out, /헬퍼 자리 결함: stopper/);
});

test("--root stops at a folder whose name tag is not OMC; plugin.json decides when it has a name", () => {
  const home = bareHome();
  const plug = bundle();
  writeFileSync(join(plug, "package.json"), JSON.stringify({ name: "some-other-plugin" }));
  const other = run(home, ["--root", plug]);
  assert.equal(other.code, 1, other.out);
  assert.match(other.out, /OMC 플러그인 폴더가 아님 \(package\.json 의 name 이 "some-other-plugin"\)/);
  assert.deepEqual(omcbaks(join(plug, "scripts")), [], "nothing was written");
  writeFileSync(join(plug, "package.json"), JSON.stringify({ name: "x".repeat(1000) }));
  assert.ok(run(home, ["--root", plug]).out.split("\n").every((l) => l.length < 400), "a long name is cut");
  // an OMC plugin.json settles it, whatever package.json says (the npm name may change one day)
  mkdirSync(join(plug, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plug, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "oh-my-claudecode" }));
  const r = run(home, ["--root", plug]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /패치 2건 \/ 실패 0건/);
});

// A link inside the plugin folder must not carry a write outside it: a hook file that is a link to a
// file elsewhere, or a backup slot that is a link (a dangling one would make copyFileSync create its target).
test("apply does not write through a link that leaves the plugin folder", (t) => {
  const home = bareHome();
  const plug = bundle();
  const outside = join(root, `outside${seq++}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "foo.mjs"), SCRIPT("foo"));
  rmSync(join(plug, "scripts", "foo.mjs"));
  try {
    symlinkSync(join(outside, "foo.mjs"), join(plug, "scripts", "foo.mjs"));
    symlinkSync(join(outside, "planted.mjs"), join(plug, "scripts", "stopper.mjs.omcbak"));
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  const r = run(home, ["--root", plug]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /쓰지 않음: foo \(파일이 플러그인 폴더 밖에 있음\)/);
  assert.match(r.out, /쓰지 않음: stopper \(백업 자리가 링크\)/);
  assert.equal(read(join(outside, "foo.mjs")), SCRIPT("foo"), "the file outside is untouched");
  assert.equal(existsSync(join(outside, "planted.mjs")), false, "the dangling link did not create its target");
  assert.equal(read(join(plug, "scripts", "stopper.mjs")), SCRIPT("stopper"));
});

test("a hook with CRLF line ends is patched, runs, and reverts to the same bytes", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.7.0", active: true }]);
  const p = join(f.cache, "5.7.0", "scripts", "stopper.mjs");
  const crlf = TWO_BLOCKS.replace(/\n/g, "\r\n");
  writeFileSync(p, crlf);
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 0, r.out);
  const e = spawnSync(process.execPath, [p], { encoding: "utf8" });
  assert.equal(e.status, 0, e.stderr);
  assert.equal(e.stdout.trim(), "stopper:function,function");
  assert.deepEqual(JSON.parse(run(f.home, ["--scan", p]).out)[0].helperDecls.map((d) => d.depth), [0]);
  assert.match(run(f.home, ["--check", "--no-update"]).out, /결과: 모두 적용된 상태입니다\./);
  assert.equal(run(f.home, ["--revert"]).code, 0);
  assert.equal(read(p), crlf, "byte for byte");
});

// A version folder can be a link to another (a cache clean-up leaves old ones pointing at the newest; a
// junction on Windows). Here the active version is the link.
test("a version folder that links to another is patched through the link and reverts", { skip: !HAS_GIT && "git not found" }, (t) => {
  const f = fakeHome([{ v: "5.7.0" }, { v: "5.7.1", active: true }]);
  const real = join(f.cache, "5.7.0");
  const linked = join(f.cache, "5.7.1");
  rmSync(linked, { recursive: true, force: true });
  try {
    symlinkSync(real, linked, "junction");
  } catch {
    t.skip("links cannot be made here");
    return;
  }
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /패치 2건 \/ 실패 0건/);
  assert.match(read(join(real, "scripts", "foo.mjs")), /__omcRaceImport\(import\(/, "written in the folder the link points to");
  assert.match(run(f.home, ["--check", "--no-update"]).out, /결과: 모두 적용된 상태입니다\./);
  assert.equal(run(f.home, ["--revert"]).code, 0);
  for (const n of ["foo", "stopper"]) assert.equal(read(join(real, "scripts", `${n}.mjs`)), SCRIPT(n));
});

// A guard against a false refusal: an odd-case --root is the same folder on Windows. realpathSync keeps the
// case it is given; the test below proves the lower-casing in insideRoot with a junction.
test("on Windows a --root given in other letter case is the same folder", { skip: process.platform !== "win32" && "Windows only" }, () => {
  const home = bareHome();
  const plug = bundle();
  const other = plug === plug.toUpperCase() ? plug.toLowerCase() : plug.toUpperCase();
  const r = run(home, ["--root", other]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /패치 2건 \/ 실패 0건/);
});

// A junction keeps its target as written. When that differs in letter case from the folder the tool was given,
// only insideRoot's lower-casing keeps the file inside the plugin folder.
test("on Windows a scripts junction whose target is written in other letter case is still inside the plugin folder", { skip: process.platform !== "win32" && "Windows only" }, () => {
  const home = bareHome();
  const plug = bundle();
  const real = join(plug, "real-scripts");
  renameSync(join(plug, "scripts"), real);
  const odd = real === real.toUpperCase() ? real.toLowerCase() : real.toUpperCase();
  symlinkSync(odd, join(plug, "scripts"), "junction");
  const check = run(home, ["--root", plug, "--check"]);
  assert.doesNotMatch(check.out, /쓸 수 없음/, check.out);
  const r = run(home, ["--root", plug]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /패치 2건 \/ 실패 0건/);
});

const ID = ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];
// Commits everything in repo and tags it.
function tagged(repo, tag) {
  for (const a of [["add", "-A"], [...ID, "commit", "-qm", "v"], [...ID, "tag", tag]]) {
    const g = runGit(a, repo);
    assert.equal(g.status, 0, g.stderr);
  }
}

// A home whose marketplace holds a tagged copy of the plugin, for the bare apply: { f, target, nowhere }. The origin
// is a local path that does not exist, so the tool's fetch fails at once without the network.
function bareApplyFixture() {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const nowhere = join(root, `no-remote${seq++}.git`);
  assert.equal(runGit(["remote", "set-url", "origin", nowhere], f.market).status, 0);
  const target = /const TARGET_VERSION = "([\d.]+)"/.exec(read(TOOL))[1];
  mkdirSync(join(f.market, "hooks"), { recursive: true });
  mkdirSync(join(f.market, "scripts"), { recursive: true });
  writeFileSync(join(f.market, "hooks", "hooks.json"), HOOKS_JSON);
  for (const n of ["foo", "stopper"]) writeFileSync(join(f.market, "scripts", `${n}.mjs`), SCRIPT(n));
  writeFileSync(join(f.market, "scripts", "lib.mjs"), LIB);
  mkdirSync(join(f.cache, "5.6.1", "node_modules"), { recursive: true });
  tagged(f.market, `v${target}`);
  return { f, target, nowhere };
}

// The bare apply (no --no-update) path: the tool unpacks its TARGET_VERSION from the marketplace tag,
// links node_modules to the previous version, switches installed_plugins.json and patches the new folder.
test("a bare apply installs TARGET_VERSION from the marketplace tag, switches to it and patches it", { skip: !HAS_GIT && "git not found" }, () => {
  const { f, target, nowhere } = bareApplyFixture();
  const r = run(f.home, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`5\\.6\\.1 → ${target.replace(/\./g, "\\.")} \\(sha [0-9a-f]{12}\\)`));
  const entry = JSON.parse(read(join(f.plugins, "installed_plugins.json"))).plugins["oh-my-claudecode@omc"][0];
  assert.equal(entry.version, target);
  assert.ok(entry.installPath.endsWith(target), entry.installPath);
  assert.ok(existsSync(join(f.plugins, "installed_plugins.json.omcbak")), "the previous installed_plugins.json is kept");
  assert.ok(existsSync(join(f.cache, target, "node_modules")), "node_modules points at the previous version");
  assert.match(read(join(f.cache, target, "scripts", "foo.mjs")), /__omcRaceImport\(import\(/, "the new active version is patched");
  assert.equal(origin(f.market), `omc-pinned://${nowhere}`);
});

test("a bare apply that cannot write installed_plugins.json stops with its name, and no stack trace", { skip: (!HAS_GIT && "git not found") || (process.platform === "win32" && "POSIX modes") || (asRoot && "root ignores modes") }, () => {
  const { f } = bareApplyFixture();
  const installed = join(f.plugins, "installed_plugins.json");
  const before = read(installed);
  chmodSync(f.plugins, 0o555);
  let r;
  try {
    r = run(f.home, []);
  } finally {
    chmodSync(f.plugins, 0o755);
  }
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[!\] 쓰지 못함: installed_plugins\.json \(EACCES\)/);
  assert.match(r.out, /버전 확보 실패 — 중단/);
  assert.doesNotMatch(r.out, /\n\s+at |Error:/, "no stack trace");
  assert.equal(read(installed), before);
});

test("a pin whose PINNED cannot be written is named and counted; origin stays pinned and no stack trace", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  writeFileSync(join(f.home, ".claude", "omc-local-patches"), "a file where the record's folder goes\n");
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[!\] 고정 기록\(PINNED\)을 쓰지 못함 \(\w+\)\. origin 은 고정됨/);
  assert.match(r.out, /완료\. 실패 1건\./);
  assert.doesNotMatch(r.out, /\n\s+at |Error:/, "no stack trace");
  assert.equal(origin(f.market), `omc-pinned://${ORIGIN}`);
});

test("origin's user part is masked whatever it holds: a space, a tab, an @ in the password; so is a token in the query", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const pw = "S3" + "CRETPW";
  for (const url of [`https://user name:${pw}@example.invalid/omc.git`, `https://user:pass ${pw}@example.invalid/omc.git`,
    `https://user:p@${pw}@example.invalid/omc.git`, `https://us\ter:${pw}@example.invalid/omc.git`,
    `https://example.invalid/omc.git?access_token=${pw}`]) {
    assert.equal(runGit(["remote", "set-url", "origin", url], f.market).status, 0);
    const out = run(f.home, ["--check", "--no-update"]).out;
    assert.ok(!out.includes(pw), `${JSON.stringify(url)}: ${out}`);
    assert.match(out, /origin=https:\/\/(\*\*\*@)?example\.invalid\/omc\.git/, JSON.stringify(url));
  }
});

test("an apply over an origin an older tool pinned drops the URL from that PINNED and leaves it to this account; --check writes nothing", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const withPassword = `https://u:${"s3" + "cret"}@example.invalid/omc.git`;
  assert.equal(runGit(["remote", "set-url", "origin", `omc-pinned://${withPassword}`], f.market).status, 0);
  const dir = join(f.home, ".claude", "omc-local-patches");
  mkdirSync(dir, { recursive: true });
  const pinfile = join(dir, "PINNED");
  writeFileSync(pinfile, `${JSON.stringify({ pinnedAt: "2026-10-01T00:00:00.000Z", version: "5.6.1", host: hostname(), originUrl: withPassword })}\n`);
  chmodSync(pinfile, 0o644);
  assert.equal(run(f.home, ["--check", "--no-update"]).code, 0);
  assert.ok(read(pinfile).includes("originUrl"), "--check leaves the record as it is");
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /이미 고정됨/);
  const saved = JSON.parse(read(pinfile));
  assert.equal(saved.originUrl, undefined);
  assert.equal(saved.host, hostname());
  if (process.platform !== "win32") assert.equal(statSync(pinfile).mode & 0o777, 0o600);
});

// An origin an older tool pinned, with the password in it, and the record that tool would have left (not written yet).
function olderPin() {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const secret = "s3" + "cret";
  const withPassword = `https://u:${secret}@example.invalid/omc.git`;
  assert.equal(runGit(["remote", "set-url", "origin", `omc-pinned://${withPassword}`], f.market).status, 0);
  const dir = join(f.home, ".claude", "omc-local-patches");
  mkdirSync(dir, { recursive: true });
  const record = `${JSON.stringify({ pinnedAt: "2026-10-01T00:00:00.000Z", version: "5.6.1", host: hostname(), originUrl: withPassword })}\n`;
  return { f, secret, withPassword, record, pinfile: join(dir, "PINNED") };
}

// Runs the tool with a module loaded first, which changes what node:fs does for this run only.
function runImport(pre, home, args) {
  const env = cleanEnv({ HOME: home, USERPROFILE: home });
  delete env.OMC_PATCH_INSTALLED;
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(pre).href, TOOL, ...args], { encoding: "utf8", env });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

// Makes renameSync fail with EROFS for a file named PINNED, as a read-only file system does.
const PIN_RENAME_FAILS = [
  'import fs from "node:fs";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const real = fs.renameSync;",
  'fs.renameSync = (from, to) => { if (String(to).endsWith("PINNED")) throw Object.assign(new Error("EROFS: read-only file system, rename"), { code: "EROFS" }); return real(from, to); };',
  "syncBuiltinESMExports();",
].join("\n");
test("an older PINNED whose URL cannot be written away is named and counted, and stays as it was", { skip: !HAS_GIT && "git not found" }, () => {
  const { f, secret, record, pinfile } = olderPin();
  writeFileSync(pinfile, record);
  const pre = join(root, `pin-rename-fails${seq++}.mjs`);
  writeFileSync(pre, `${PIN_RENAME_FAILS}\n`);
  const r = runImport(pre, f.home, ["--no-update"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[!\] 고정 기록\(PINNED\)의 옛 URL 칸을 지우지 못함 \(쓰지 못함: EROFS\)\./);
  assert.match(r.out, /인증 정보가 든 URL 이 남았을 수 있습니다: /);
  assert.match(r.out, /이미 고정됨/);
  assert.match(r.out, /완료\. 실패 1건\./);
  assert.equal(read(pinfile), record, "the record is as it was");
  assert.ok(!r.out.includes(secret), "the password is not printed");
});

test("an older PINNED that is a link is not written through: named and counted, the file it leads to left as it was", { skip: !HAS_GIT && "git not found" }, (t) => {
  const { f, secret, record, pinfile } = olderPin();
  const dotfiles = join(root, `dotfiles${seq++}`);
  mkdirSync(dotfiles, { recursive: true });
  writeFileSync(join(dotfiles, "PINNED"), record);
  try {
    symlinkSync(join(dotfiles, "PINNED"), pinfile);
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /옛 URL 칸을 지울 수 없음 \(링크라 따라가 쓰지 않음\)/);
  assert.match(r.out, /완료\. 실패 1건\./);
  assert.equal(read(join(dotfiles, "PINNED")), record);
  assert.ok(lstatSync(pinfile).isSymbolicLink(), "the link stays a link");
  assert.ok(!r.out.includes(secret), "the password is not printed");
});

test("an older PINNED that is no JSON but holds the URL key is named and counted; one with no such key is left quietly", { skip: !HAS_GIT && "git not found" }, () => {
  const { f, secret, withPassword, pinfile } = olderPin();
  const cut = `{"pinnedAt":"2026-10-01T00:00:00.000Z","originUrl":"${withPassword}"`;
  writeFileSync(pinfile, cut);
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /옛 URL 칸을 지울 수 없음 \(JSON 이 아님\)/);
  assert.equal(read(pinfile), cut);
  assert.ok(!r.out.includes(secret), "the password is not printed");
  writeFileSync(pinfile, "{ not json");
  const quiet = run(f.home, ["--no-update"]);
  assert.equal(quiet.code, 0, quiet.out);
  assert.doesNotMatch(quiet.out, /PINNED/);
});

test("an older PINNED this account cannot read is named and counted: the URL in it cannot be checked", { skip: (!HAS_GIT && "git not found") || (process.platform === "win32" && "POSIX permission bits") || (asRoot && "root reads any file") }, () => {
  const { f, record, pinfile } = olderPin();
  writeFileSync(pinfile, record);
  chmodSync(pinfile, 0o000);
  try {
    const r = run(f.home, ["--no-update"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /고정 기록\(PINNED\)의 옛 URL 칸을 확인하지 못함 \(읽지 못함: EACCES\)/);
    assert.match(r.out, /완료\. 실패 1건\./);
  } finally {
    chmodSync(pinfile, 0o600);
  }
});

// The SKILL skips the apply when --check says all is applied. An older PINNED's URL must keep --check from saying so,
// or a machine already patched by an older tool never gets the apply that drops it.
test("--check names an older PINNED's URL as not applied yet, without its text; the apply drops it and --check then passes", { skip: !HAS_GIT && "git not found" }, () => {
  const { f, secret, record, pinfile } = olderPin();
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  writeFileSync(pinfile, record);
  const c = run(f.home, ["--check", "--no-update"]);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /\[!\] 고정 기록\(PINNED\)에 옛 URL 칸이 남아 있음 \(적용하면 지움\): .*PINNED/);
  assert.match(c.out, /이미 고정됨/);
  assert.match(c.out, /결과: 적용되지 않은 항목이 있습니다\./);
  assert.ok(!c.out.includes(secret), "the password is not printed");
  assert.equal(read(pinfile), record, "--check writes nothing");
  const a = run(f.home, ["--no-update"]);
  assert.equal(a.code, 0, a.out);
  assert.equal(JSON.parse(read(pinfile)).originUrl, undefined);
  assert.match(run(f.home, ["--check", "--no-update"]).out, /결과: 모두 적용된 상태입니다\./);
});

test("--check names an older PINNED the apply cannot clean (no JSON, unreadable, a link) and says this tool cannot", { skip: !HAS_GIT && "git not found" }, (t) => {
  const { f, secret, withPassword, record, pinfile } = olderPin();
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const blocked = (why) => {
    const c = run(f.home, ["--check", "--no-update"]);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, why);
    assert.match(c.out, /결과: 고정 기록\(PINNED\)의 옛 URL 칸이 이 도구로 지울 수 없는 곳에 있습니다\. 위의 \[!\] 줄을 확인하십시오\./);
    assert.ok(!c.out.includes(secret), "the password is not printed");
  };
  writeFileSync(pinfile, `{"originUrl":"${withPassword}"`);
  blocked(/\[!\] 고정 기록\(PINNED\)의 옛 URL 칸을 지울 수 없음 \(JSON 이 아님\)/);
  if (process.platform !== "win32" && !asRoot) {
    writeFileSync(pinfile, record);
    chmodSync(pinfile, 0o000);
    try {
      blocked(/옛 URL 칸을 확인하지 못함 \(읽지 못함: EACCES\)/);
    } finally {
      chmodSync(pinfile, 0o600);
    }
  }
  rmSync(pinfile);
  const dotfiles = join(root, `dotfiles${seq++}`);
  mkdirSync(dotfiles, { recursive: true });
  writeFileSync(join(dotfiles, "PINNED"), record);
  try {
    symlinkSync(join(dotfiles, "PINNED"), pinfile);
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  blocked(/옛 URL 칸을 지울 수 없음 \(링크라 따라가 쓰지 않음\)/);
  assert.equal(read(join(dotfiles, "PINNED")), record);
});

test("a PINNED that names originUrl only inside a value has no URL field: --check passes and the apply keeps its bytes", { skip: !HAS_GIT && "git not found" }, () => {
  const { f, pinfile } = olderPin();
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const note = `${JSON.stringify({ pinnedAt: "2026-10-01T00:00:00.000Z", host: hostname(), note: "originUrl" })}\n`;
  writeFileSync(pinfile, note);
  assert.match(run(f.home, ["--check", "--no-update"]).out, /결과: 모두 적용된 상태입니다\./);
  const a = run(f.home, ["--no-update"]);
  assert.equal(a.code, 0, a.out);
  assert.doesNotMatch(a.out, /PINNED/);
  assert.equal(read(pinfile), note, "the record keeps its bytes");
});

test("--revert keeps a linked PINNED that leads to an older URL: named and counted, the origin restored all the same", { skip: !HAS_GIT && "git not found" }, (t) => {
  const { f, secret, withPassword, record, pinfile } = olderPin();
  const dotfiles = join(root, `dotfiles${seq++}`);
  mkdirSync(dotfiles, { recursive: true });
  writeFileSync(join(dotfiles, "PINNED"), record);
  try {
    symlinkSync(join(dotfiles, "PINNED"), pinfile);
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  const r = run(f.home, ["--revert"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[!\] 고정 기록\(PINNED\)의 옛 URL 칸을 지울 수 없음 \(링크라 따라가 쓰지 않음\)/);
  assert.match(r.out, /고정 해제 \(origin 복구\)/);
  assert.match(r.out, /되돌리기를 끝내지 못했습니다\. 실패 1건\./);
  assert.equal(origin(f.market), withPassword, "the origin comes back from the pinned URL");
  assert.ok(lstatSync(pinfile).isSymbolicLink(), "the link stays");
  assert.equal(read(join(dotfiles, "PINNED")), record, "the file it leads to is left as it was");
  assert.ok(!r.out.includes(secret), "the password is not printed");
});

test("--revert removes a linked PINNED with no URL field, and one that leads nowhere; the file it led to is left", { skip: !HAS_GIT && "git not found" }, (t) => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const pinfile = join(f.home, ".claude", "omc-local-patches", "PINNED");
  const dotfiles = join(root, `dotfiles${seq++}`);
  mkdirSync(dotfiles, { recursive: true });
  renameSync(pinfile, join(dotfiles, "PINNED"));
  const kept = read(join(dotfiles, "PINNED"));
  try {
    symlinkSync(join(dotfiles, "PINNED"), pinfile);
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  const r = run(f.home, ["--revert"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /되돌리기 완료/);
  assert.throws(() => lstatSync(pinfile), { code: "ENOENT" });
  assert.equal(read(join(dotfiles, "PINNED")), kept);
  assert.equal(origin(f.market), ORIGIN);
  symlinkSync(join(dotfiles, "gone"), pinfile);
  const again = run(f.home, ["--revert"]);
  assert.equal(again.code, 0, again.out);
  assert.throws(() => lstatSync(pinfile), { code: "ENOENT" }, "a link that leads nowhere goes too");
});

test("--revert names a PINNED it cannot remove (a folder) and counts it, with no stack trace; the origin is still restored", { skip: !HAS_GIT && "git not found" }, () => {
  const { f, withPassword, pinfile } = olderPin();
  mkdirSync(pinfile);
  writeFileSync(join(pinfile, "keep"), "x\n");
  const r = run(f.home, ["--revert"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[!\] 고정 기록\(PINNED\)을 지우지 못함 \(\w+\): .*PINNED/);
  assert.match(r.out, /되돌리기를 끝내지 못했습니다\. 실패 1건\./);
  assert.doesNotMatch(r.out, /\n\s+at |Error:/, "no stack trace");
  assert.equal(origin(f.market), withPassword);
  assert.equal(read(join(pinfile, "keep")), "x\n", "the folder is left as it was");
});

test("a record folder this account cannot write or open: --revert names the PINNED it cannot remove, the apply and --check the URL they cannot check", { skip: (!HAS_GIT && "git not found") || (process.platform === "win32" && "POSIX permission bits") || (asRoot && "root ignores modes") }, () => {
  const { f, withPassword, record, pinfile } = olderPin();
  writeFileSync(pinfile, record);
  const dir = dirname(pinfile);
  try {
    chmodSync(dir, 0o000);
    const a = run(f.home, ["--no-update"]);
    assert.equal(a.code, 1, a.out);
    assert.match(a.out, /고정 기록\(PINNED\)의 옛 URL 칸을 확인하지 못함 \(읽지 못함: EACCES\)/);
    assert.match(a.out, /완료\. 실패 1건\./);
    const c = run(f.home, ["--check", "--no-update"]);
    assert.match(c.out, /옛 URL 칸을 확인하지 못함 \(읽지 못함: EACCES\)/);
    assert.match(c.out, /결과: 고정 기록\(PINNED\)의 옛 URL 칸이 이 도구로 지울 수 없는 곳에 있습니다\./);
    const unopened = run(f.home, ["--revert"]);
    assert.equal(unopened.code, 1, unopened.out);
    assert.match(unopened.out, /\[!\] 고정 기록\(PINNED\)을 지우지 못함 \(EACCES\)/);
    chmodSync(dir, 0o555);
    assert.equal(runGit(["remote", "set-url", "origin", `omc-pinned://${withPassword}`], f.market).status, 0);
    const r = run(f.home, ["--revert"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[!\] 고정 기록\(PINNED\)을 지우지 못함 \(EACCES\)/);
    assert.match(r.out, /되돌리기를 끝내지 못했습니다\. 실패 1건\./);
    assert.doesNotMatch(r.out, /\n\s+at |Error:/, "no stack trace");
    assert.equal(origin(f.market), withPassword);
    assert.equal(read(pinfile), record);
  } finally {
    chmodSync(dir, 0o755);
  }
});

// The SKILL reports [!] lines word for word: every line that names PINNED cleans its path.
test("every line that names PINNED prints its path on one line under a home with an odd name", { skip: (!HAS_GIT && "git not found") || (process.platform === "win32" && "kept to POSIX file names") }, () => {
  const { f, record, withPassword } = olderPin();
  const odd = join(root, `home${seq++}${String.fromCodePoint(0x202e)}x\n[!] FORGED`);
  renameSync(f.home, odd);
  const installed = join(odd, ".claude", "plugins", "installed_plugins.json");
  const list = JSON.parse(read(installed));
  const entry = list.plugins["oh-my-claudecode@omc"][0];
  entry.installPath = entry.installPath.split(f.home).join(odd);
  writeFileSync(installed, `${JSON.stringify(list, null, 2)}\n`);
  const pinfile = join(odd, ".claude", "omc-local-patches", "PINNED");
  const oneLine = (out, what) => {
    assert.match(out, what);
    assert.ok(!out.includes(String.fromCodePoint(0x202e)), out);
    assert.ok(!/^\s*\[!\] FORGED/m.test(out), out);
  };
  const named = String.raw`: .*home\d+\?x\?\[!\] FORGED`;
  writeFileSync(pinfile, record);
  oneLine(run(odd, ["--check", "--no-update"]).out, new RegExp(String.raw`남아 있음 \(적용하면 지움\)${named}`));
  writeFileSync(pinfile, `{"originUrl":"${withPassword}"`);
  oneLine(run(odd, ["--no-update"]).out, new RegExp(String.raw`남았을 수 있습니다${named}`));
  rmSync(pinfile);
  mkdirSync(pinfile);
  oneLine(run(odd, ["--revert"]).out, new RegExp(String.raw`\(PINNED\)을 지우지 못함 \(\w+\)${named}`));
  rmSync(dirname(pinfile), { recursive: true });
  writeFileSync(dirname(pinfile), "a file where the record's folder goes\n");
  oneLine(run(odd, ["--no-update"]).out, new RegExp(String.raw`\(PINNED\)을 쓰지 못함 \(\w+\)\. origin 은 고정됨${named}`));
});

test("--check over a hooks.json that is no JSON says it cannot read it, without its text, and does not call it all applied", () => {
  const home = bareHome();
  const plug = bundle();
  assert.equal(run(home, ["--root", plug]).code, 0);
  writeFileSync(join(plug, "hooks", "hooks.json"), '{ "hooks": { "secret-ish": ');
  const r = run(home, ["--root", plug, "--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /hooks\.json 을 읽지 못함 \(JSON 이 아님\)/);
  assert.ok(!r.out.includes("secret-ish"), r.out);
  assert.doesNotMatch(r.out, /결과: 모두 적용된 상태입니다\./);
});

test("a set-url git refuses (an origin with two URLs) shows git's fatal line, the password masked", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  // put together at run time, so a secret scanner reading this file finds no credential in it
  const twoUrl = `https://u:${"s3" + "cret"}@example.invalid/two.git`;
  assert.equal(runGit(["remote", "set-url", "--add", "origin", twoUrl], f.market).status, 0);
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /고정 실패: origin 을 바꾸지 못했습니다 \(fatal: .*omc-pinned:\/\/https:\/\/\*\*\*@example\.invalid\/two\.git/);
  assert.ok(!r.out.includes("s3cret"), r.out);
});

test("a bare apply under a home with an odd name cleans the marketplace path it names", { skip: process.platform === "win32" && "kept to POSIX file names" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }], { git: false });
  const odd = join(root, `home${seq++}${String.fromCodePoint(0x202e)}x\n[!] FORGED`);
  renameSync(f.home, odd);
  const installed = join(odd, ".claude", "plugins", "installed_plugins.json");
  writeFileSync(installed, read(installed).split(f.home).join(odd));
  const r = run(odd, []);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /마켓플레이스 없음: .*home\d+\?x\?\[!\] FORGED/);
  assert.ok(!r.out.includes(String.fromCodePoint(0x202e)), r.out);
  assert.ok(!/^\[!\] FORGED/m.test(r.out), r.out);
});

test("--revert takes the origin from the pinned URL and names a PINNED written on another machine", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const pinfile = join(f.home, ".claude", "omc-local-patches", "PINNED");
  const saved = JSON.parse(read(pinfile));
  writeFileSync(pinfile, JSON.stringify({ ...saved, host: "another-machine", originUrl: "https://example.invalid/other.git" }));
  const r = run(f.home, ["--revert"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PINNED 는 다른 기기\(another-machine\)의 기록입니다/);
  assert.equal(origin(f.market), ORIGIN, "the pinned origin wins over the other machine's record");
  assert.equal(existsSync(pinfile), false);
});

// The revert side of the link guard: a backup slot that is a link and a hooks.json that is a link out of the
// plugin folder are left alone, and the run does not end with "되돌리기 완료".
test("--revert does not write through a link that leaves the plugin folder, and says it did not finish", (t) => {
  const home = bareHome();
  const plug = bundle();
  assert.equal(run(home, ["--root", plug]).code, 0);
  const outside = join(root, `outside${seq++}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "planted.mjs"), "planted\n");
  writeFileSync(join(outside, "hooks.json"), HOOKS_JSON);
  const bak = join(plug, "scripts", "foo.mjs.omcbak");
  const hj = join(plug, "hooks", "hooks.json");
  rmSync(bak);
  rmSync(hj);
  try {
    symlinkSync(join(outside, "planted.mjs"), bak);
    symlinkSync(join(outside, "hooks.json"), hj);
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  const r = run(home, ["--revert", "--root", plug]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /되돌리지 않음: foo \(백업 자리가 링크\)/);
  assert.match(r.out, /hooks\.json 을 건드리지 않음 \(파일이 플러그인 폴더 밖에 있음\)/);
  assert.match(r.out, /되돌리기를 끝내지 못했습니다\. 실패 2건/);
  assert.doesNotMatch(r.out, /되돌리기 완료/);
  assert.equal(read(join(outside, "planted.mjs")), "planted\n");
  assert.equal(read(join(outside, "hooks.json")), HOOKS_JSON);
  assert.match(read(join(plug, "scripts", "foo.mjs")), /__omcRaceImport/, "foo stays patched");
  assert.equal(read(join(plug, "scripts", "stopper.mjs")), SCRIPT("stopper"), "the other hook is restored");
});

// A hand-made hooks.json backup can stand in when the tool's own is gone, but not one planted as a link:
// a file outside the folder with a PostToolUse key (a settings.json) would become hooks.json. The revert names
// the candidate it left, and hooks.json still lacks PostToolUse, so the revert is not done.
test("--revert does not take a manual hooks.json backup that is a link, names it and does not finish", (t) => {
  const home = bareHome();
  const plug = bundle();
  assert.equal(run(home, ["--root", plug]).code, 0);
  rmSync(join(plug, "hooks", "hooks.json.omcbak"));
  const outside = join(root, `outside${seq++}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "settings.json"), JSON.stringify({ hooks: { PostToolUse: [] }, planted: true }));
  try {
    symlinkSync(join(outside, "settings.json"), join(plug, "hooks", "hooks.json.stolen"));
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  const before = read(join(plug, "hooks", "hooks.json"));
  const r = run(home, ["--revert", "--root", plug]);
  assert.equal(r.code, 1, r.out);
  assert.equal(read(join(plug, "hooks", "hooks.json")), before, "the linked candidate was not used");
  assert.match(r.out, /\[!\] hooks\.json 수동 백업 후보가 링크이거나 플러그인 폴더 밖이라 쓰지 않음: hooks\.json\.stolen/);
  assert.doesNotMatch(r.out, /되돌릴 백업 없음/);
  assert.match(r.out, /되돌리기를 끝내지 못했습니다\. 되돌리지 못한 것 1건\./);
  for (const n of ["foo", "stopper"]) assert.equal(read(join(plug, "scripts", `${n}.mjs`)), SCRIPT(n), "the scripts are restored all the same");
});

// --check is the read-only mode. Given with --revert, the old parse let the revert win and write.
test("--check with --revert is refused before anything is written", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const act = join(f.cache, "5.6.1");
  const patched = { foo: read(join(act, "scripts", "foo.mjs")), hooks: read(join(act, "hooks", "hooks.json")) };
  for (const args of [["--check", "--revert"], ["--revert", "--check", "--no-update"], ["--root", act, "--revert", "--check"]]) {
    const r = run(f.home, args);
    assert.equal(r.code, 1, `${args.join(" ")}\n${r.out}`);
    assert.match(r.out, /--check 와 --revert 는 함께 쓸 수 없습니다/);
    assert.equal(read(join(act, "scripts", "foo.mjs")), patched.foo, "the hook stays patched");
    assert.equal(read(join(act, "hooks", "hooks.json")), patched.hooks);
    assert.equal(origin(f.market), `omc-pinned://${ORIGIN}`, "the pin stays");
  }
});

// GIT_DIR, GIT_WORK_TREE and the rest of `git rev-parse --local-env-vars` pick the repository git works on,
// whatever the current folder. Inherited from the calling shell (a git hook sets them), they made the pin land
// on that repository instead of the marketplace.
test("the tool's git ignores GIT_DIR and GIT_WORK_TREE from the calling shell", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const decoy = join(root, `decoy${seq++}`);
  mkdirSync(decoy, { recursive: true });
  const DECOY = "https://example.invalid/decoy.git";
  for (const a of [["init", "-q"], ["remote", "add", "origin", DECOY]]) assert.equal(runGit(a, decoy).status, 0);
  const shell = { GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy };
  // the fixture bites: git started in the marketplace under these variables reads the decoy
  assert.equal(runGit(["remote", "get-url", "origin"], f.market, shell).stdout.trim(), DECOY);
  assert.equal(run(f.home, ["--no-update"], shell).code, 0);
  assert.equal(origin(decoy), DECOY, "the decoy keeps its origin");
  assert.equal(origin(f.market), `omc-pinned://${ORIGIN}`);
  assert.equal(run(f.home, ["--revert"], shell).code, 0);
  assert.equal(origin(decoy), DECOY);
  assert.equal(origin(f.market), ORIGIN);
});

// PINNED is the tool's own record, but a hand edit or a broken copy can leave `null` in it.
test("--revert reads a PINNED that holds null as no record", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const pinfile = join(f.home, ".claude", "omc-local-patches", "PINNED");
  writeFileSync(pinfile, "null\n");
  const r = run(f.home, ["--revert"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /되돌리기 완료/);
  assert.equal(origin(f.market), ORIGIN, "the origin comes back from the pinned URL");
  assert.equal(existsSync(pinfile), false);
});

// The warning says another machine's value is not used. It is not, even when the origin is not pinned.
test("--revert does not use another machine's PINNED when the origin is not pinned", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const pinfile = join(f.home, ".claude", "omc-local-patches", "PINNED");
  mkdirSync(dirname(pinfile), { recursive: true });
  writeFileSync(pinfile, JSON.stringify({ originUrl: "https://example.invalid/other.git", host: "another-machine" }));
  const r = run(f.home, ["--revert"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PINNED 는 다른 기기\(another-machine\)의 기록입니다/);
  assert.equal(origin(f.market), ORIGIN, "the origin is left as it was");
  assert.equal(existsSync(pinfile), false);
});

// Two hand-made hooks.json backups and no PostToolUse left: the tool cannot tell which one to take.
test("--revert with two manual hooks.json backups names them and does not finish", () => {
  const home = bareHome();
  const plug = bundle();
  assert.equal(run(home, ["--root", plug]).code, 0);
  rmSync(join(plug, "hooks", "hooks.json.omcbak"));
  for (const n of ["bak-1", "bak-2"]) writeFileSync(join(plug, "hooks", `hooks.json.${n}`), HOOKS_JSON);
  const before = read(join(plug, "hooks", "hooks.json"));
  const r = run(home, ["--revert", "--root", plug]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /hooks\.json 수동 백업이 여러 개라 자동 복구하지 않음: .*hooks\.json\.bak-1/);
  assert.match(r.out, /hooks\.json 수동 백업이 여러 개라 자동 복구하지 않음: .*hooks\.json\.bak-2/);
  assert.match(r.out, /되돌리기를 끝내지 못했습니다\. 되돌리지 못한 것 1건\./);
  assert.doesNotMatch(r.out, /되돌리기 완료/);
  assert.equal(read(join(plug, "hooks", "hooks.json")), before);
  for (const n of ["foo", "stopper"]) assert.equal(read(join(plug, "scripts", `${n}.mjs`)), SCRIPT(n));
});

// With PostToolUse still in hooks.json there is nothing to bring back: a manual backup beside it must not
// overwrite it, and two of them are no reason for a warning.
test("--revert leaves an intact hooks.json alone, whatever manual backups lie beside it", () => {
  const home = bareHome();
  const plug = bundle();
  const hj = join(plug, "hooks", "hooks.json");
  const older = HOOKS_JSON.replace("foo.mjs", "older.mjs");
  writeFileSync(`${hj}.bak-1`, older);
  let r = run(home, ["--revert", "--root", plug]);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(hj), HOOKS_JSON, "one backup does not overwrite an intact hooks.json");
  writeFileSync(`${hj}.bak-2`, older);
  r = run(home, ["--revert", "--root", plug]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /수동 백업/);
  assert.match(r.out, /되돌리기 완료/);
  assert.equal(read(hj), HOOKS_JSON);
});

// What a revert cannot restore is counted once per real file: version folders that link to the same folder
// name the same file. A hand patch with no backup is left as it is.
test("--revert counts what it could not restore once per real file and does not finish", { skip: !HAS_GIT && "git not found" }, (t) => {
  const f = fakeHome([{ v: "5.7.0" }, { v: "5.7.1", active: true }]);
  const real = join(f.cache, "5.7.0");
  const linked = join(f.cache, "5.7.1");
  rmSync(linked, { recursive: true, force: true });
  try {
    symlinkSync(real, linked, "junction");
  } catch {
    t.skip("links cannot be made here");
    return;
  }
  const hand = "const { x } = await Promise.race([import(\"./lib.mjs\"), new Promise((r) => setTimeout(() => r({}), 5000))]);\nconsole.log(\"stopper:\" + typeof x);\n";
  writeFileSync(join(real, "scripts", "stopper.mjs"), hand);
  const r = run(f.home, ["--revert"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /5\.7\.1: 이 도구가 만들지 않은 수정이 남아 있습니다 — stopper/);
  assert.match(r.out, /5\.7\.0: 이 도구가 만들지 않은 수정이 남아 있습니다 — stopper/);
  assert.match(r.out, /되돌리기를 끝내지 못했습니다\. 되돌리지 못한 것 1건\./);
  assert.equal(read(join(real, "scripts", "stopper.mjs")), hand, "a hand patch is not the tool's to undo");
});

// A marketplace .git that is there but broken (an interrupted clone) is no repository to git, so git walks up and
// takes the next one, such as a ~/.claude kept in a dotfiles repository. The pin must not land there.
test("a broken marketplace .git does not let git walk up to an enclosing repository", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }], { git: false });
  mkdirSync(join(f.market, ".git"), { recursive: true });
  const claude = join(f.home, ".claude");
  const dotfiles = "https://example.invalid/dotfiles.git";
  for (const a of [["init", "-q"], ["remote", "add", "origin", dotfiles]]) assert.equal(runGit(a, claude).status, 0);
  // the fixture bites: plain git started in the marketplace reaches the dotfiles repository
  assert.equal(runGit(["remote", "get-url", "origin"], f.market).stdout.trim(), dotfiles);
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(origin(claude), dotfiles, "the ~/.claude repo origin is untouched");
  assert.equal(existsSync(join(claude, "omc-local-patches", "PINNED")), false);
  assert.equal(run(f.home, ["--revert"]).code, 0);
  assert.equal(origin(claude), dotfiles);
});

// PINNED is a record only: the original URL lives in the pinned origin. Revert never writes the origin from
// PINNED, so a record with no host, an empty one, or this machine's own stale one cannot change an unpinned origin.
test("--revert never takes the origin from PINNED, whatever its host says", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const pinfile = join(f.home, ".claude", "omc-local-patches", "PINNED");
  mkdirSync(dirname(pinfile), { recursive: true });
  for (const rec of [{}, { host: "" }, { host: 0 }, { host: null }, { host: hostname() }]) {
    writeFileSync(pinfile, JSON.stringify({ ...rec, originUrl: "https://evil.example/omc.git" }));
    const r = run(f.home, ["--revert"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(origin(f.market), ORIGIN, JSON.stringify(rec));
    assert.equal(existsSync(pinfile), false);
  }
});

// The SKILL reports [!] lines word for word, so a value read from a file must not start a line of its own.
test("a PINNED host with line breaks or control characters prints on one line", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const pinfile = join(f.home, ".claude", "omc-local-patches", "PINNED");
  // a line feed, an escape, a line separator and a right-to-left override
  writeFileSync(pinfile, JSON.stringify({ originUrl: ORIGIN, host: "elsewhere\n  [!] injected line\u001b[2J\u2028x\u202ey" }));
  const r = run(f.home, ["--revert"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PINNED 는 다른 기기\(elsewhere/);
  assert.ok(!r.out.split("\n").some((l) => l.startsWith("  [!] injected")), r.out);
  assert.doesNotMatch(r.out, /[\u001b\u2028\u202e]/);
  assert.equal(origin(f.market), ORIGIN);
});

test("a manual hooks.json backup name with a line break prints on one line", { skip: process.platform === "win32" && "Windows file names cannot hold line breaks" }, () => {
  const home = bareHome();
  const plug = bundle();
  assert.equal(run(home, ["--root", plug]).code, 0);
  rmSync(join(plug, "hooks", "hooks.json.omcbak"));
  for (const n of ["a\n  [!] injected", "b"]) writeFileSync(join(plug, "hooks", `hooks.json.${n}`), HOOKS_JSON);
  const r = run(home, ["--revert", "--root", plug]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /hooks\.json 수동 백업이 여러 개라 자동 복구하지 않음/);
  assert.ok(!r.out.split("\n").some((l) => l.startsWith("  [!] injected")), r.out);
});

// The end line counts each real file once. A version folder that links to another names the same files, and a write
// refused there is the same failure, not a second one.
test("--revert counts a failure once per real file, through linked version folders", { skip: !HAS_GIT && "git not found" }, (t) => {
  const f = fakeHome([{ v: "5.7.0" }, { v: "5.7.1", active: true }]);
  const real = join(f.cache, "5.7.0");
  const linked = join(f.cache, "5.7.1");
  rmSync(linked, { recursive: true, force: true });
  try {
    symlinkSync(real, linked, "junction");
  } catch {
    t.skip("links cannot be made here");
    return;
  }
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const outside = join(root, `outside${seq++}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "planted.mjs"), "planted\n");
  const bak = join(real, "scripts", "foo.mjs.omcbak");
  rmSync(bak);
  try {
    symlinkSync(join(outside, "planted.mjs"), bak);
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  const r = run(f.home, ["--revert"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /되돌리기를 끝내지 못했습니다\. 실패 1건\./);
  assert.equal(read(join(outside, "planted.mjs")), "planted\n");
});

// Same through the links for hooks.json: two hand-made backups, so it stays unrestored, and that is one file.
test("--revert counts an unrestorable hooks.json once through linked version folders", { skip: !HAS_GIT && "git not found" }, (t) => {
  const f = fakeHome([{ v: "5.7.0" }, { v: "5.7.1", active: true }]);
  const real = join(f.cache, "5.7.0");
  const linked = join(f.cache, "5.7.1");
  rmSync(linked, { recursive: true, force: true });
  try {
    symlinkSync(real, linked, "junction");
  } catch {
    t.skip("links cannot be made here");
    return;
  }
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  rmSync(join(real, "hooks", "hooks.json.omcbak"));
  for (const n of ["bak-1", "bak-2"]) writeFileSync(join(real, "hooks", `hooks.json.${n}`), HOOKS_JSON);
  const r = run(f.home, ["--revert"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /되돌리기를 끝내지 못했습니다\. 되돌리지 못한 것 1건\./);
});

// Windows paths ignore letter case, and a junction may name its target in other letters than the cache path.
test("on Windows a junction whose target differs in letter case still counts a file once", { skip: process.platform !== "win32" && "Windows only" }, () => {
  const f = fakeHome([{ v: "5.7.0" }, { v: "5.7.1", active: true }], { git: false });
  const real = join(f.cache, "5.7.0");
  const linked = join(f.cache, "5.7.1");
  rmSync(linked, { recursive: true, force: true });
  symlinkSync(real.toUpperCase(), linked, "junction");
  writeFileSync(join(real, "scripts", "stopper.mjs"), "const __omcRaceImport = (p) => p;\nconsole.log(1);\n");
  const r = run(f.home, ["--revert"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /되돌리지 못한 것 1건/);
});

// Windows reads environment variable names in any letter case, so git takes Git_Dir as GIT_DIR.
test("on Windows the tool's git also ignores repository variables written in other letter case", { skip: (process.platform !== "win32" && "Windows only") || (!HAS_GIT && "git not found") }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const decoy = join(root, `decoy${seq++}`);
  mkdirSync(decoy, { recursive: true });
  const DECOY = "https://example.invalid/decoy.git";
  for (const a of [["init", "-q"], ["remote", "add", "origin", DECOY]]) assert.equal(runGit(a, decoy).status, 0);
  const shell = { Git_Dir: join(decoy, ".git"), Git_Work_Tree: decoy };
  // the fixture bites: git takes the mixed-case names
  assert.equal(runGit(["remote", "get-url", "origin"], f.market, shell).stdout.trim(), DECOY);
  assert.equal(run(f.home, ["--no-update"], shell).code, 0);
  assert.equal(origin(decoy), DECOY, "the decoy keeps its origin");
  assert.equal(origin(f.market), `omc-pinned://${ORIGIN}`);
});

// One usable hand-made backup restores hooks.json even with a linked candidate beside it: the revert names the
// linked one and still finishes.
test("--revert takes the one usable manual backup, names a linked one beside it, and finishes", (t) => {
  const home = bareHome();
  const plug = bundle();
  assert.equal(run(home, ["--root", plug]).code, 0);
  rmSync(join(plug, "hooks", "hooks.json.omcbak"));
  writeFileSync(join(plug, "hooks", "hooks.json.bak-1"), HOOKS_JSON);
  const outside = join(root, `outside${seq++}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "settings.json"), JSON.stringify({ hooks: { PostToolUse: [] }, planted: true }));
  try {
    symlinkSync(join(outside, "settings.json"), join(plug, "hooks", "hooks.json.stolen"));
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  const r = run(home, ["--revert", "--root", plug]);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(join(plug, "hooks", "hooks.json")), HOOKS_JSON, "restored from the usable backup");
  assert.match(r.out, /수동 백업 사용: hooks\.json\.bak-1/);
  assert.match(r.out, /수동 백업 후보가 링크이거나 플러그인 폴더 밖이라 쓰지 않음: hooks\.json\.stolen/);
  assert.match(r.out, /되돌리기 완료/);
});

test("script names with line breaks print on one line", { skip: process.platform === "win32" && "Windows file names cannot hold line breaks" }, () => {
  const home = bareHome();
  const plug = bundle();
  assert.equal(run(home, ["--root", plug]).code, 0);
  // one restored from its backup, one patched with no backup left
  const restored = join(plug, "scripts", "y\n  [!] forged restored.mjs");
  writeFileSync(restored, "patched\n");
  writeFileSync(`${restored}.omcbak`, "original\n");
  writeFileSync(join(plug, "scripts", "x\n  [!] forged orphan.mjs"), "const __omcRaceImport = (p) => p;\n");
  const r = run(home, ["--revert", "--root", plug]);
  assert.equal(r.code, 1, r.out);
  assert.equal(read(restored), "original\n");
  assert.match(r.out, /패치는 있는데 백업이 없어 되돌리지 못했습니다/);
  assert.ok(!r.out.split("\n").some((l) => l.startsWith("  [!] forged")), r.out);
});

// A marketplace that is a link resolves to its real folder, and git walks up from there. The ceiling must cover the
// real folder's parent too, or a broken .git lets the pin land on a repository around the real folder.
test("a linked marketplace with a broken .git does not pin the repository around its real folder", { skip: !HAS_GIT && "git not found" }, (t) => {
  const f = fakeHome([{ v: "5.6.1", active: true }], { git: false });
  const outer = join(root, `outer${seq++}`);
  const realMarket = join(outer, "omc");
  mkdirSync(join(realMarket, ".git"), { recursive: true });
  const OUTER = "https://example.invalid/outer.git";
  for (const a of [["init", "-q"], ["remote", "add", "origin", OUTER]]) assert.equal(runGit(a, outer).status, 0);
  mkdirSync(dirname(f.market), { recursive: true });
  try {
    symlinkSync(realMarket, f.market, "junction");
  } catch {
    t.skip("links cannot be made here");
    return;
  }
  // the fixture bites: git started in the linked marketplace reaches the outer repository
  assert.equal(runGit(["remote", "get-url", "origin"], f.market).stdout.trim(), OUTER);
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(origin(outer), OUTER, "the outer repository keeps its origin");
  assert.equal(existsSync(join(f.home, ".claude", "omc-local-patches", "PINNED")), false);
});

// --check prints the origin it found. A line break stored in the URL must not start a line of its own.
test("an origin URL with a line break prints on one line in --check", { skip: !HAS_GIT && "git not found" }, (t) => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  if (runGit(["config", "remote.origin.url", "https://example.invalid/omc.git\n  [!] injected"], f.market).status !== 0) {
    t.skip("this git does not store a line break in a URL");
    return;
  }
  const r = run(f.home, ["--check", "--no-update"]);
  assert.match(r.out, /마켓플레이스 미고정 \(origin=https:\/\/example\.invalid\/omc\.git\?  \[!\] injected\)/);
  assert.ok(!r.out.split("\n").some((l) => l.startsWith("  [!] injected")), r.out);
});

// Unknown arguments used to be ignored: --dry-run applied for real, and --root=<folder> was dropped so that
// --revert undid every version and the pin.
test("arguments the tool does not know stop it before anything is read or written", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const act = join(f.cache, "5.6.1");
  const before = { foo: read(join(act, "scripts", "foo.mjs")), hooks: read(join(act, "hooks", "hooks.json")) };
  const cases = [
    [["--dry-run"], /\[!\] 알 수 없는 인자: --dry-run/],
    [["--no-update", "--dry-run"], /\[!\] 알 수 없는 인자: --dry-run/],
    [["extra"], /\[!\] 알 수 없는 인자: extra/],
    [[`--root=${act}`, "--revert"], /\[!\] --root 와 폴더는 띄어 쓰십시오: --root <폴더>/],
    [["--check", "--scan", join(act, "scripts", "foo.mjs")], /\[!\] --scan 은 첫 인자로만 쓸 수 있습니다/],
    [["--root", act, "--root", act, "--check"], /\[!\] --root 는 한 번만 쓸 수 있습니다/],
  ];
  for (const [args, want] of cases) {
    const r = run(f.home, args);
    assert.equal(r.code, 1, `${args.join(" ")}\n${r.out}`);
    assert.match(r.out, want, args.join(" "));
    assert.match(r.out, /사용법:/, args.join(" "));
    assert.doesNotMatch(r.out, /^OMC 패치 /m, "stopped before the first line");
    assert.deepEqual(omcbaks(join(act, "scripts")), []);
    assert.equal(read(join(act, "scripts", "foo.mjs")), before.foo);
    assert.equal(read(join(act, "hooks", "hooks.json")), before.hooks);
    assert.equal(origin(f.market), ORIGIN, "not pinned");
  }
});

test("--help and -h print the usage, exit 0 and change nothing", () => {
  const home = bareHome();
  for (const a of ["--help", "-h"]) {
    const r = run(home, [a]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^사용법:/);
    assert.match(r.out, /--root <플러그인 폴더>/);
    assert.match(r.out, /--scan <파일>\.\.\./);
    assert.equal(existsSync(join(home, ".claude")), false);
  }
});

test("a --root value that starts with one dash, or --root at the end, keeps today's messages", () => {
  const home = bareHome();
  const last = run(home, ["--check", "--root"]);
  assert.equal(last.code, 1, last.out);
  assert.match(last.out, /--root 뒤에 플러그인 폴더 경로가 필요합니다/);
  const dash = run(home, ["--root", "-x", "--check"]);
  assert.equal(dash.code, 1, dash.out);
  assert.match(dash.out, /플러그인 폴더가 아님/);
  assert.equal(existsSync(join(home, ".claude")), false);
});

test("output turns joiners, tag characters and blank-looking letters into ?, and keeps Korean, NFD and spaces", () => {
  const home = bareHome();
  const plug = bundle();
  const odd = [0x2060, 0xe0041, 0x061c, 0x180e, 0x00ad, 0x2028, 0x202e, 0x0085, 0x3164, 0x2800, 0x3000].map((c) => String.fromCodePoint(c));
  const nfd = "가が".normalize("NFD");
  writeFileSync(join(plug, "package.json"), JSON.stringify({ name: `x${odd.join("")}y 한글 ${nfd}` }));
  const r = run(home, ["--root", plug]);
  assert.equal(r.code, 1, r.out);
  const line = r.out.split("\n").find((l) => l.includes("OMC 플러그인 폴더가 아님"));
  assert.ok(line, r.out);
  assert.ok(line.includes(`"x${"?".repeat(odd.length)}y 한글 ${nfd}"`), line);
  assert.ok(![...line].some((ch) => odd.includes(ch)), line);
});

test("a script name with a tag character or a word joiner prints them as ?", { skip: process.platform === "win32" && "kept to POSIX file names" }, () => {
  const home = bareHome();
  const plug = bundle();
  assert.equal(run(home, ["--root", plug]).code, 0);
  const name = `t${String.fromCodePoint(0xe0041)}${String.fromCodePoint(0x2060)}.mjs`;
  writeFileSync(join(plug, "scripts", name), "const __omcRaceImport = (p) => p;\n");
  const r = run(home, ["--revert", "--root", plug]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /백업이 없어 되돌리지 못했습니다 \S t\?\?$/m);
  assert.ok(![0xe0041, 0x2060].some((c) => r.out.includes(String.fromCodePoint(c))), r.out);
});

// Writing in place used to change every name of a hard-linked hook, the one outside the plugin folder too.
test("apply writes through a temp file and a rename: a hook hard-linked to a file outside leaves that file as it was", (t) => {
  const home = bareHome();
  const plug = bundle();
  const outside = join(root, `outside${seq++}`);
  mkdirSync(outside, { recursive: true });
  const outer = join(outside, "foo.mjs");
  writeFileSync(outer, SCRIPT("foo"));
  rmSync(join(plug, "scripts", "foo.mjs"));
  try {
    linkSync(outer, join(plug, "scripts", "foo.mjs"));
  } catch (e) {
    t.skip(`no hard links here: ${e.code}`);
    return;
  }
  const r = run(home, ["--root", plug]);
  assert.equal(r.code, 0, r.out);
  assert.match(read(join(plug, "scripts", "foo.mjs")), /__omcRaceImport\(import\(/);
  assert.equal(read(outer), SCRIPT("foo"), "the file outside the plugin folder is untouched");
  assert.deepEqual(readdirSync(join(plug, "scripts")).filter((x) => x.includes(".omc-tmp-")), [], "no temp file is left");
});

test("an apply keeps a backup that is already there: the first backup stays the original", () => {
  const plug = bundle();
  const foo = join(plug, "scripts", "foo.mjs");
  writeFileSync(`${foo}.omcbak`, "// the original an earlier run kept\n");
  const r = run(bareHome(), ["--root", plug]);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(`${foo}.omcbak`), "// the original an earlier run kept\n");
  assert.match(read(foo), /__omcRaceImport\(import\(/);
});

// Makes renameSync fail with EPERM the first FAIL_RENAMES times, as Windows does for a file another process holds.
const RENAME_FAILS = [
  'import fs from "node:fs";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const real = fs.renameSync;",
  "let left = Number(process.env.FAIL_RENAMES);",
  'fs.renameSync = (...a) => { if (left-- > 0) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }); return real(...a); };',
  "syncBuiltinESMExports();",
].join("\n");
test("a rename refused a few times is tried again; one refused every time is named and counted, the file left as it was", () => {
  const pre = join(root, `rename-fails${seq++}.mjs`);
  writeFileSync(pre, `${RENAME_FAILS}\n`);
  const runFailing = (plug, n) => {
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(pre).href, TOOL, "--root", plug],
      { encoding: "utf8", env: cleanEnv({ HOME: bareHome(), FAIL_RENAMES: String(n) }) });
    return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  };
  const few = bundle();
  const once = runFailing(few, 3);
  assert.equal(once.code, 0, once.out);
  assert.match(once.out, /패치 2건 \/ 실패 0건/);
  // five retries: a rename refused five times still goes through, one refused six times does not
  const five = runFailing(bundle(), 5);
  assert.match(five.out, /패치 2건 \/ 실패 0건/, five.out);
  const six = runFailing(bundle(), 6);
  assert.match(six.out, /패치 1건 \/ 실패 1건/, six.out);
  assert.equal(six.out.match(/쓰지 못함: \w+ \(EPERM\)/g)?.length, 1, six.out);
  const always = bundle();
  const never = runFailing(always, 999);
  assert.equal(never.code, 1, never.out);
  assert.match(never.out, /쓰지 못함: foo \(EPERM\)/);
  assert.equal(read(join(always, "scripts", "foo.mjs")), SCRIPT("foo"));
  assert.deepEqual(readdirSync(join(always, "scripts")).filter((x) => x.includes(".omc-tmp-")), [], "no temp file is left");
});

// Breaks the first hooks.json renamed into place, as a full disk or another writer might: what reads back is no JSON.
const HOOKS_JSON_BREAKS = [
  'import fs from "node:fs";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const real = fs.renameSync;",
  "let left = 1;",
  'fs.renameSync = (from, to) => { if (String(to).endsWith("hooks.json") && left-- > 0) fs.writeFileSync(from, "{ broken"); return real(from, to); };',
  "syncBuiltinESMExports();",
].join("\n");
test("a hooks.json that reads back broken is rolled back, and the rollback is named and counted as a failure", () => {
  const plug = bundle();
  const pre = join(root, `hooks-json-breaks${seq++}.mjs`);
  writeFileSync(pre, `${HOOKS_JSON_BREAKS}\n`);
  const r = runImport(pre, bareHome(), ["--root", plug]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /hooks\.json 손상으로 롤백/);
  assert.match(r.out, /완료\. 실패 1건\./);
  assert.equal(read(join(plug, "hooks", "hooks.json")), HOOKS_JSON, "hooks.json is as it was");
});

test("hooks.json and the revert write through no hard link: a name outside the folder keeps its bytes", (t) => {
  const plug = bundle();
  const home = bareHome();
  const outside = join(root, `outside${seq++}`);
  mkdirSync(outside, { recursive: true });
  const hj = join(plug, "hooks", "hooks.json");
  const foo = join(plug, "scripts", "foo.mjs");
  try {
    linkSync(hj, join(outside, "hooks.json"));
  } catch (e) {
    t.skip(`no hard links here: ${e.code}`);
    return;
  }
  assert.equal(run(home, ["--root", plug]).code, 0);
  assert.equal(read(join(outside, "hooks.json")), HOOKS_JSON, "apply: the outside name keeps the old hooks.json");
  assert.doesNotMatch(read(hj), /PostToolUse/);
  const patched = { hj: read(hj), foo: read(foo) };
  rmSync(join(outside, "hooks.json"));
  linkSync(hj, join(outside, "hooks.json"));
  linkSync(foo, join(outside, "foo.mjs"));
  assert.equal(run(home, ["--revert", "--root", plug]).code, 0);
  assert.equal(read(hj), HOOKS_JSON);
  assert.equal(read(foo), SCRIPT("foo"));
  assert.equal(read(join(outside, "hooks.json")), patched.hj, "revert: the outside name keeps the patched hooks.json");
  assert.equal(read(join(outside, "foo.mjs")), patched.foo, "revert: the outside name keeps the patched hook");
});

test("a hook the patch would leave broken is put back from its backup, and the error line is cleaned", () => {
  const plug = bundle();
  const foo = join(plug, "scripts", "foo.mjs");
  // a name with U+3164, a letter that shows as nothing: node's SyntaxError line repeats it
  const name = `a${String.fromCodePoint(0x3164)}`;
  const broken = `${SCRIPT("foo")}let ${name} = 1;\nlet ${name} = 2;\n`;
  writeFileSync(foo, broken);
  const r = run(bareHome(), ["--root", plug]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /문법오류로 롤백: foo\n {6}SyntaxError: Identifier 'a\?' has already been declared/);
  assert.equal(read(foo), broken);
});

test("a patched hook keeps its file mode", { skip: process.platform === "win32" && "POSIX modes" }, () => {
  const home = bareHome();
  const plug = bundle();
  const foo = join(plug, "scripts", "foo.mjs");
  chmodSync(foo, 0o640);
  assert.equal(run(home, ["--root", plug]).code, 0);
  assert.equal(statSync(foo).mode & 0o777, 0o640);
});

// A folder the tool cannot write used to stop it with an exception and a stack trace.
test("a hook the tool cannot write is named and counted; the file stays as it was and no temp file is left", { skip: process.platform === "win32" ? "POSIX modes" : asRoot && "root ignores modes" }, () => {
  const home = bareHome();
  const plug = bundle();
  const scripts = join(plug, "scripts");
  chmodSync(scripts, 0o555);
  try {
    const r = run(home, ["--root", plug]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /쓰지 못함: foo \(EACCES\)/);
    assert.equal(read(join(scripts, "foo.mjs")), SCRIPT("foo"));
    assert.deepEqual(readdirSync(scripts).filter((x) => x.includes(".omc-tmp-") || x.endsWith(".omcbak")), []);
  } finally {
    chmodSync(scripts, 0o755);
  }
});

test("paths in the output lose line breaks and direction marks: the --root folder in every line that names it", { skip: process.platform === "win32" && "kept to POSIX file names" }, () => {
  const home = bareHome();
  const odd = join(root, `odd${seq++}${String.fromCodePoint(0x202e)}x\ny`);
  mkdirSync(odd, { recursive: true });
  const notPlugin = run(home, ["--root", odd]);
  assert.equal(notPlugin.code, 1, notPlugin.out);
  assert.match(notPlugin.out, /플러그인 폴더가 아님 \(hooks\/hooks\.json 과 scripts\/ 가 있어야 함\): .*odd\d+\?x\?y$/m);
  mkdirSync(join(odd, "hooks"));
  mkdirSync(join(odd, "scripts"));
  writeFileSync(join(odd, "hooks", "hooks.json"), HOOKS_JSON);
  writeFileSync(join(odd, "package.json"), JSON.stringify({ name: "other" }));
  const other = run(home, ["--root", odd, "--check"]);
  assert.match(other.out, /^OMC 패치 {2}\(대상 폴더 .*odd\d+\?x\?y\) {2}모드: check$/m);
  assert.match(other.out, /OMC 플러그인 폴더가 아님 \(package\.json 의 name 이 "other"\): .*odd\d+\?x\?y$/m);
  for (const r of [notPlugin, other]) {
    assert.ok(!r.out.includes(String.fromCodePoint(0x202e)), r.out);
    assert.ok(!/odd\d+.x\ny/u.test(r.out), r.out);
  }
});

test("paths in the output lose line breaks and direction marks: a --root run that reaches the hooks, and its no-backup lines", { skip: process.platform === "win32" && "kept to POSIX file names" }, () => {
  const home = bareHome();
  const odd = join(root, `odd${seq++}${String.fromCodePoint(0x202e)}x\n[!] FORGED`);
  mkdirSync(join(odd, "hooks"), { recursive: true });
  mkdirSync(join(odd, "scripts"));
  writeFileSync(join(odd, "hooks", "hooks.json"), HOOKS_JSON);
  for (const n of ["foo", "stopper"]) writeFileSync(join(odd, "scripts", `${n}.mjs`), SCRIPT(n));
  writeFileSync(join(odd, "scripts", "lib.mjs"), LIB);
  const check = run(home, ["--root", odd, "--check"]);
  assert.equal(check.code, 0, check.out);
  const apply = run(home, ["--root", odd]);
  assert.equal(apply.code, 0, apply.out);
  rmSync(join(odd, "scripts", "foo.mjs.omcbak"));
  const revert = run(home, ["--revert", "--root", odd]);
  assert.equal(revert.code, 1, revert.out);
  assert.match(revert.out, /패치는 있는데 백업이 없어 되돌리지 못했습니다 — foo/);
  for (const r of [check, apply, revert]) {
    assert.ok(!r.out.includes(String.fromCodePoint(0x202e)), r.out);
    assert.ok(!/^\[!\] FORGED/m.test(r.out), r.out);
  }
});

test("an origin with a user and password shows only ***, and PINNED keeps no URL and is readable by this account alone", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  // put together at run time, so a secret scanner reading this file finds no credential in it
  const withPassword = `https://u:${"s3" + "cret"}@example.invalid/omc.git`;
  assert.equal(runGit(["remote", "set-url", "origin", withPassword], f.market).status, 0);
  const check = run(f.home, ["--check", "--no-update"]);
  assert.match(check.out, /origin=https:\/\/\*\*\*@example\.invalid\/omc\.git\)/);
  assert.ok(!check.out.includes("s3cret"), check.out);
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 0, r.out);
  const pinfile = join(f.home, ".claude", "omc-local-patches", "PINNED");
  const text = read(pinfile);
  assert.ok(!text.includes("s3cret") && !text.includes("originUrl"), text);
  if (process.platform !== "win32") assert.equal(statSync(pinfile).mode & 0o777, 0o600);
  assert.equal(run(f.home, ["--revert"]).code, 0);
  assert.equal(origin(f.market), withPassword, "the revert still restores the whole URL from origin");
  for (const plain of ["git@example.invalid:o/omc.git", "https://example.invalid/a@b/omc.git"]) {
    assert.equal(runGit(["remote", "set-url", "origin", plain], f.market).status, 0);
    const out = run(f.home, ["--check", "--no-update"]).out;
    assert.ok(out.includes(`origin=${plain})`), `a URL with no password is left as it is: ${out}`);
  }
});

test("the pin keeps the origin as written, not as a global insteadOf expands it, and the revert gives it back", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const gitconfig = join(root, `insteadof${seq++}.gitconfig`);
  writeFileSync(gitconfig, '[url "https://example.invalid/"]\n\tinsteadOf = ex:\n');
  assert.equal(runGit(["remote", "set-url", "origin", "ex:omc.git"], f.market).status, 0);
  const env = { GIT_CONFIG_GLOBAL: gitconfig };
  // the fixture bites: get-url expands the short form
  assert.equal(runGit(["remote", "get-url", "origin"], f.market, env).stdout.trim(), "https://example.invalid/omc.git");
  assert.equal(run(f.home, ["--no-update"], env).code, 0);
  const raw = () => runGit(["config", "--get", "remote.origin.url"], f.market).stdout.trim();
  assert.equal(raw(), "omc-pinned://ex:omc.git");
  assert.equal(run(f.home, ["--revert"], env).code, 0);
  assert.equal(raw(), "ex:omc.git");
});

test("an origin that starts with a dash is written back as a value, never read as an option", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  assert.equal(runGit(["config", "remote.origin.url", "-x/omc.git"], f.market).status, 0);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const raw = () => runGit(["config", "--get", "remote.origin.url"], f.market).stdout.trim();
  assert.equal(raw(), "omc-pinned://-x/omc.git");
  const back = run(f.home, ["--revert"]);
  assert.equal(back.code, 0, back.out);
  assert.equal(raw(), "-x/omc.git");
});

test("a set-url that fails is reported and counted: the pin writes no PINNED, the revert says where the URL is", { skip: (!HAS_GIT && "git not found") || (process.platform === "win32" && "POSIX modes") || (asRoot && "root ignores modes") }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const gitDir = join(f.market, ".git");
  const pinfile = join(f.home, ".claude", "omc-local-patches", "PINNED");
  chmodSync(gitDir, 0o555);
  try {
    const r = run(f.home, ["--no-update"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[!\] 고정 실패: origin 을 바꾸지 못했습니다 \(/);
    assert.equal(existsSync(pinfile), false, "no record of a pin that did not happen");
  } finally {
    chmodSync(gitDir, 0o755);
  }
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  chmodSync(gitDir, 0o555);
  try {
    const back = run(f.home, ["--revert"]);
    assert.equal(back.code, 1, back.out);
    assert.match(back.out, /\[!\] 고정 해제 실패: origin 을 되돌리지 못했습니다 \(/);
    assert.match(back.out, /원래 URL\(호스트까지만\): https:\/\/example\.invalid\. 원문은 origin 의 omc-pinned:\/\/ 뒤에 그대로 있습니다\./);
    assert.match(back.out, /되돌리기를 끝내지 못했습니다/);
  } finally {
    chmodSync(gitDir, 0o755);
  }
  assert.equal(origin(f.market), `omc-pinned://${ORIGIN}`, "still pinned, so a later revert finds the URL");
});

test("--check names a hook it would need to patch but could not write", (t) => {
  const home = bareHome();
  const plug = bundle();
  const outside = join(root, `outside${seq++}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "foo.mjs"), SCRIPT("foo"));
  rmSync(join(plug, "scripts", "foo.mjs"));
  try {
    symlinkSync(join(outside, "foo.mjs"), join(plug, "scripts", "foo.mjs"));
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  const r = run(home, ["--root", plug, "--check"]);
  assert.match(r.out, /패치 필요, 쓸 수 없음: foo \(파일이 플러그인 폴더 밖에 있음\)/);
  assert.match(r.out, /패치 필요: stopper$/m);
});

test("--check also names a hooks.json it would need to change but could not write", (t) => {
  const home = bareHome();
  const plug = bundle();
  try {
    symlinkSync(join(root, `nowhere${seq++}.json`), join(plug, "hooks", "hooks.json.omcbak"));
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  const r = run(home, ["--root", plug, "--check"]);
  assert.match(r.out, /hooks\.json PostToolUse 남아있음, 쓸 수 없음 \(백업 자리가 링크\): foo/);
});

test("a revert that may not write outside the plugin folder says how to restore by hand", (t) => {
  const home = bareHome();
  const plug = bundle();
  const outside = join(root, `outside${seq++}`);
  mkdirSync(outside, { recursive: true });
  // an old tool patched these while they sat outside, behind a linked scripts/ folder
  for (const n of ["foo", "stopper"]) {
    writeFileSync(join(outside, `${n}.mjs`), "const __omcRaceImport = (p) => p;\n");
    writeFileSync(join(outside, `${n}.mjs.omcbak`), SCRIPT(n));
  }
  writeFileSync(join(outside, "lib.mjs"), LIB);
  rmSync(join(plug, "scripts"), { recursive: true });
  try {
    symlinkSync(outside, join(plug, "scripts"), "junction");
  } catch {
    t.skip("links cannot be made here");
    return;
  }
  const r = run(home, ["--revert", "--root", plug]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /되돌리지 않음: foo \(파일이 플러그인 폴더 밖에 있음\)/);
  assert.match(r.out, /손으로 되돌리려면 .*foo\.mjs\.omcbak 의 내용을 확인한 뒤 .*foo\.mjs 에 덮어쓰고 백업을 지우십시오\./);
  assert.equal(read(join(outside, "foo.mjs.omcbak")), SCRIPT("foo"), "the backup outside is left for the person");
});

test("only the hand patch's own shape at the top level counts as a hand edit", () => {
  const home = bareHome();
  const cases = [
    ["top level", 'const m = await Promise.race([import("./lib.mjs"), new Promise((r) => setTimeout(r, 9))]);\n', true],
    ["in a function", 'async function f() { return await Promise.race([import("./lib.mjs"), 1]); }\nexport { f };\n', false],
    ["in a comment", '// await Promise.race([import("./lib.mjs")])\nexport const y = 1;\n', false],
    ["in a string", 'export const s = "await Promise.race([import(\\"x\\")])";\n', false],
    ["import not first", 'const m = await Promise.race([Promise.resolve(1), import("./lib.mjs")]);\n', false],
  ];
  for (const [what, src, hand] of cases) {
    const plug = bundle();
    writeFileSync(join(plug, "scripts", "stopper.mjs"), src);
    const r = run(home, ["--revert", "--root", plug]);
    assert.equal(/이 도구가 만들지 않은 수정이 남아 있습니다/.test(r.out), hand, `${what}\n${r.out}`);
    assert.equal(r.code, hand ? 1 : 0, `${what}\n${r.out}`);
  }
});

// A git that writes down each call's arguments and the GIT_ and FAKE_ names in its environment, then runs the real
// git. To `rev-parse --local-env-vars` it adds one name more, as a newer git would.
function loggingGit(t) {
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  if (!realGit) {
    t.skip("git not found on PATH");
    return null;
  }
  const dir = join(root, `gitwrap${seq++}`);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "git"), [
    "#!/bin/sh",
    `printf '%s|' "$*" >> '${log}'`,
    `env | sed 's/=.*//' | grep -E '^(GIT_|FAKE_)' | sort | tr '\\n' ' ' >> '${log}'`,
    `env | grep -E '^GIT_CONFIG_KEY_[0-9]+=' | sort | tr '\\n' ' ' >> '${log}'`,
    `echo >> '${log}'`,
    'if [ "$1" = rev-parse ] && [ "$2" = --local-env-vars ]; then',
    `  '${realGit}' "$@"; echo GIT_FAKE_NEW_REPO_VAR; exit 0`,
    "fi",
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  return { PATH: `${dir}${delimiter}${process.env.PATH}`, log };
}

const posixGit = { skip: (!HAS_GIT && "git not found") || (process.platform === "win32" && "a POSIX shell wrapper") };

test("a repository variable only this git's --local-env-vars names is dropped too", posixGit, (t) => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const w = loggingGit(t);
  if (!w) return;
  const r = run(f.home, ["--no-update"], { PATH: w.PATH, GIT_FAKE_NEW_REPO_VAR: "decoy" });
  assert.equal(r.code, 0, r.out);
  const calls = read(w.log).trim().split("\n");
  const later = calls.filter((c) => !c.startsWith("rev-parse --local-env-vars|"));
  assert.ok(later.length > 0, calls.join("\n"));
  for (const c of later) assert.ok(!c.includes("GIT_FAKE_NEW_REPO_VAR"), c);
});

test("the update's fetch keeps only proxy and TLS settings given in the environment; url rewrites, hook paths and the calls on origin drop them", posixGit, (t) => {
  const { f } = bareApplyFixture();
  const w = loggingGit(t);
  if (!w) return;
  const env = {
    PATH: w.PATH, GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: `url.${join(root, "elsewhere")}.insteadOf`, GIT_CONFIG_VALUE_0: join(root, "nowhere.git"),
    GIT_CONFIG_KEY_1: "http.proxy", GIT_CONFIG_VALUE_1: "http://127.0.0.1:9",
    GIT_CONFIG_KEY_2: "core.hooksPath", GIT_CONFIG_VALUE_2: join(root, "hooks"),
    GIT_CONFIG_PARAMETERS: `'core.hookspath'='${join(root, "hooks")}'`,
  };
  const r = run(f.home, [], env);
  assert.equal(r.code, 0, r.out);
  const calls = read(w.log).trim().split("\n");
  const fetch = calls.find((c) => c.startsWith("fetch "));
  assert.ok(fetch, calls.join("\n"));
  assert.match(fetch, /GIT_CONFIG_COUNT /);
  assert.match(fetch, /GIT_CONFIG_KEY_0=http\.proxy /);
  assert.doesNotMatch(fetch, /insteadOf|hooksPath|GIT_CONFIG_KEY_1|GIT_CONFIG_PARAMETERS/i);
  const origins = calls.filter((c) => /^(config --get remote\.origin\.url|remote set-url)/.test(c));
  assert.ok(origins.length > 0, calls.join("\n"));
  for (const c of origins) assert.ok(!c.includes("GIT_CONFIG_COUNT"), c);
});

test("every git or tar the tool starts by name runs in the home folder: on Windows a project folder's git.exe is not found first", () => {
  const src = read(TOOL);
  const calls = [...src.matchAll(/execFileSync\((?!process\.execPath)([^,]+),[^\n]*/g)].map((m) => m[0]);
  assert.ok(calls.length >= 4, calls.join("\n"));
  for (const c of calls) assert.match(c, /\bcwd\b/, c);
});

test("a huge GIT_CONFIG_COUNT is not walked to its end", posixGit, (t) => {
  const { f } = bareApplyFixture();
  const w = loggingGit(t);
  if (!w) return;
  const env = cleanEnv({ HOME: f.home, USERPROFILE: f.home, PATH: w.PATH, GIT_CONFIG_COUNT: "2000000000", GIT_CONFIG_KEY_0: "http.proxy", GIT_CONFIG_VALUE_0: "http://127.0.0.1:9" });
  delete env.OMC_PATCH_INSTALLED;
  const r = spawnSync(process.execPath, [TOOL], { encoding: "utf8", env, timeout: 30000 });
  assert.equal(r.error?.code, undefined, "the run ended before its deadline");
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(read(w.log).split("\n").find((c) => c.startsWith("fetch ")) ?? "", /GIT_CONFIG_KEY_0=http\.proxy /);
});

test("--scan gives only helperDecls, wrapped and unwrapped, each entry with its own fields", () => {
  const home = bareHome();
  const plug = bundle();
  assert.equal(run(home, ["--root", plug]).code, 0);
  const out = JSON.parse(run(home, ["--scan", join(plug, "scripts", "foo.mjs")]).out);
  assert.deepEqual(Object.keys(out[0]).sort(), ["file", "helperDecls", "unwrapped", "wrapped"]);
  assert.deepEqual(Object.keys(out[0].helperDecls[0]).sort(), ["depth", "line"]);
  assert.deepEqual(Object.keys(out[0].wrapped[0]).sort(), ["inFunction", "line"]);
});

test("--root reads package.json's name when plugin.json has none", () => {
  const home = bareHome();
  const plug = bundle();
  mkdirSync(join(plug, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plug, ".claude-plugin", "plugin.json"), JSON.stringify({ description: "no name" }));
  writeFileSync(join(plug, "package.json"), JSON.stringify({ name: "other-plugin" }));
  const r = run(home, ["--root", plug, "--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /OMC 플러그인 폴더가 아님 \(package\.json 의 name 이 "other-plugin"\)/);
  writeFileSync(join(plug, "package.json"), JSON.stringify({ name: "oh-my-claude-sisyphus" }));
  assert.doesNotMatch(run(home, ["--root", plug, "--check"]).out, /OMC 플러그인 폴더가 아님/);
});

test("a hooks.json the tool may not write counts as a failure at the end of a revert", (t) => {
  const home = bareHome();
  const plug = bundle();
  assert.equal(run(home, ["--root", plug]).code, 0);
  const hj = join(plug, "hooks", "hooks.json");
  rmSync(`${hj}.omcbak`);
  try {
    symlinkSync(join(root, `nowhere${seq++}.json`), `${hj}.omcbak`);
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  const r = run(home, ["--revert", "--root", plug]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /hooks\.json 을 건드리지 않음 \(백업 자리가 링크\)/);
  assert.match(r.out, /되돌리기를 끝내지 못했습니다\. 실패 1건/);
});

test("a refused revert names the hook with odd characters as ?", { skip: process.platform === "win32" && "kept to POSIX file names" }, (t) => {
  const home = bareHome();
  const plug = bundle();
  const name = `t${String.fromCodePoint(0x2060)}x`;
  const outside = join(root, `outside${seq++}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, `${name}.mjs`), "const __omcRaceImport = (p) => p;\n");
  try {
    symlinkSync(join(outside, `${name}.mjs`), join(plug, "scripts", `${name}.mjs`));
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  writeFileSync(join(plug, "scripts", `${name}.mjs.omcbak`), "// original\n");
  const r = run(home, ["--revert", "--root", plug]);
  assert.match(r.out, /되돌리지 않음: t\?x \(파일이 플러그인 폴더 밖에 있음\)/);
  assert.ok(!r.out.includes(String.fromCodePoint(0x2060)), r.out);
});

test("a bare apply under GIT_DIR of a decoy with the same tag still unpacks the marketplace's copy", { skip: !HAS_GIT && "git not found" }, () => {
  const { f, target } = bareApplyFixture();
  const decoy = join(root, `decoy${seq++}`);
  mkdirSync(join(decoy, "scripts"), { recursive: true });
  mkdirSync(join(decoy, "hooks"), { recursive: true });
  writeFileSync(join(decoy, "hooks", "hooks.json"), HOOKS_JSON);
  for (const n of ["foo", "stopper"]) writeFileSync(join(decoy, "scripts", `${n}.mjs`), "export const decoy = 1;\n");
  assert.equal(runGit(["init", "-q"], decoy).status, 0);
  tagged(decoy, `v${target}`);
  const r = run(f.home, [], { GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy });
  assert.equal(r.code, 0, r.out);
  const foo = read(join(f.cache, target, "scripts", "foo.mjs"));
  assert.match(foo, /__omcRaceImport\(import\(/, "the marketplace's hook, patched");
  assert.doesNotMatch(foo, /decoy/);
});

// ── a rollback that fails, hooks it cannot read or write, two runs at once, writes down to the disk, masked URLs ──

// Makes the second rename into foo.mjs fail, as a full disk or a virus scanner holding the file might: the patch
// was written, the file fails the syntax check, and the way back is refused.
const ROLLBACK_FAILS = [
  'import fs from "node:fs";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const real = fs.renameSync; let n = 0;",
  'fs.renameSync = (from, to) => { if (String(to).endsWith("foo.mjs") && n++ >= 1) throw Object.assign(new Error("ENOSPC: no space left on device, rename"), { code: "ENOSPC" }); return real(from, to); };',
  "syncBuiltinESMExports();",
].join("\n");
test("a hook whose rollback cannot be written is named with where its backup is, and counted; no stack trace", () => {
  const plug = bundle();
  const foo = join(plug, "scripts", "foo.mjs");
  const broken = `${SCRIPT("foo")}let a = 1;\nlet a = 2;\n`;
  writeFileSync(foo, broken);
  const pre = join(root, `rollback-fails${seq++}.mjs`);
  writeFileSync(pre, `${ROLLBACK_FAILS}\n`);
  const r = runImport(pre, bareHome(), ["--root", plug]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[!\] 롤백도 실패: foo \(ENOSPC\)\. .*foo\.mjs\.omcbak 으로 손수 되돌리십시오/);
  assert.match(r.out, /패치 1건 \/ 실패 1건/);
  assert.match(r.out, /완료\. 실패 1건\./);
  assert.doesNotMatch(r.out, /\n\s+at /, "no stack trace");
  assert.equal(read(`${foo}.omcbak`), broken, "the backup is the way back");
  assert.match(read(join(plug, "scripts", "stopper.mjs")), /__omcRaceImport\(import\(/, "the other hook is still patched");
});

test("a hook that links to another file inside the folder keeps its link, the target is patched and reverts", (t) => {
  const plug = bundle();
  const sc = join(plug, "scripts");
  renameSync(join(sc, "foo.mjs"), join(sc, "foo-real.mjs"));
  try {
    symlinkSync("foo-real.mjs", join(sc, "foo.mjs"));
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  assert.equal(run(bareHome(), ["--root", plug]).code, 0);
  assert.ok(lstatSync(join(sc, "foo.mjs")).isSymbolicLink(), "the link is still a link");
  assert.match(read(join(sc, "foo-real.mjs")), /__omcRaceImport\(import\(/, "the file it leads to is patched");
  assert.equal(run(bareHome(), ["--revert", "--root", plug]).code, 0);
  assert.ok(lstatSync(join(sc, "foo.mjs")).isSymbolicLink());
  assert.equal(read(join(sc, "foo-real.mjs")), SCRIPT("foo"));
});

test("a bare apply that cannot read installed_plugins.json says it could not read it, and prints none of its text", { skip: (!HAS_GIT && "git not found") || (process.platform === "win32" && "POSIX modes") || (asRoot && "root ignores modes") }, () => {
  const broken = bareApplyFixture().f;
  writeFileSync(join(broken.plugins, "installed_plugins.json"), '{ "plugins": { "oh-my-claudecode@omc": [ { "scope": "user", s3cr3t-ish } ] } }\n');
  const syntax = run(broken.home, []);
  assert.equal(syntax.code, 1, syntax.out);
  assert.match(syntax.out, /\[!\] 읽지 못함: installed_plugins\.json \(JSON 이 아님\)/);
  assert.ok(!syntax.out.includes("s3cr3t-ish"), syntax.out);
  const denied = bareApplyFixture().f;
  const installed = join(denied.plugins, "installed_plugins.json");
  chmodSync(installed, 0o000);
  let r;
  try {
    r = run(denied.home, []);
  } finally {
    chmodSync(installed, 0o644);
  }
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[!\] 읽지 못함: installed_plugins\.json \(EACCES\)/);
});

test("a revert that may not write outside the plugin folder does not tell to overwrite a file the old tool never patched", (t) => {
  const home = bareHome();
  const plug = bundle();
  const outside = join(root, `outside${seq++}`);
  mkdirSync(outside, { recursive: true });
  // someone's own file the link leads to, with an old backup beside the link
  writeFileSync(join(outside, "foo.mjs"), "// my own work, never patched by this tool\n");
  writeFileSync(join(plug, "scripts", "foo.mjs.omcbak"), SCRIPT("foo"));
  rmSync(join(plug, "scripts", "foo.mjs"));
  try {
    symlinkSync(join(outside, "foo.mjs"), join(plug, "scripts", "foo.mjs"));
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  const r = run(home, ["--revert", "--root", plug]);
  assert.match(r.out, /되돌리지 않음: foo \(파일이 플러그인 폴더 밖에 있음\)/);
  assert.match(r.out, /패치가 보이지 않습니다\. 덮어쓰지 말고 링크가 가리키는 곳이 맞는지 먼저 확인하십시오\./);
  assert.doesNotMatch(r.out, /덮어쓰고/);
  assert.equal(read(join(outside, "foo.mjs")), "// my own work, never patched by this tool\n", "the file it leads to is untouched");
});

test("an error the tool did not expect prints on one line with the folder name cleaned, and ends with 1", { skip: (process.platform === "win32" && "kept to POSIX file names") || (asRoot && "root reads any file") }, () => {
  const odd = join(root, `odd${seq++}\n[!] FORGED${String.fromCodePoint(0x202e)}x`);
  mkdirSync(join(odd, "hooks"), { recursive: true });
  mkdirSync(join(odd, "scripts"), { recursive: true });
  writeFileSync(join(odd, "hooks", "hooks.json"), HOOKS_JSON);
  for (const n of ["foo", "stopper"]) writeFileSync(join(odd, "scripts", `${n}.mjs`), SCRIPT(n));
  writeFileSync(join(odd, "scripts", "lib.mjs"), LIB);
  // A system error the tool has no guard for, naming the folder: the check for hooks.json fails as an EACCES would.
  const pre = join(root, `unexpected${seq++}.mjs`);
  writeFileSync(pre, [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const real = fs.existsSync;",
    "fs.existsSync = (p) => {",
    "  if (String(p).endsWith(\"hooks.json\")) throw Object.assign(new Error(`EACCES: permission denied, access '${p}'`), { code: \"EACCES\" });",
    "  return real(p);",
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"));
  const r = runImport(pre, bareHome(), ["--root", odd, "--revert"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[!\] 처리하지 못한 오류: EACCES/);
  assert.doesNotMatch(r.out, /^\s*\[!\] FORGED/m, "the folder name makes no line of its own");
  assert.doesNotMatch(r.out, new RegExp(String.fromCodePoint(0x202e)), "no direction mark");
  assert.doesNotMatch(r.out, /\n\s+at /, "no stack trace");
});

// Makes the check for hooks.json throw a TypeError, as a defect of the tool's own would.
const TOOL_DEFECT = [
  'import fs from "node:fs";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const real = fs.existsSync;",
  'fs.existsSync = (p) => { if (String(p).endsWith("hooks.json")) throw new TypeError("boom\\n[!] FORGED"); return real(p); };',
  "syncBuiltinESMExports();",
].join("\n");
test("a defect of the tool's own prints one cleaned line and where it happened, not a raw stack trace", () => {
  const pre = join(root, `tool-defect${seq++}.mjs`);
  writeFileSync(pre, `${TOOL_DEFECT}\n`);
  const r = runImport(pre, bareHome(), ["--root", bundle(), "--check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[!\] 처리하지 못한 오류: boom\?\[!\] FORGED\n\s+at /);
  assert.doesNotMatch(r.out, /^\s*\[!\] FORGED/m);
  assert.doesNotMatch(r.out, /TypeError:/, "not Node's own report");
});

const posixFifo = { skip: process.platform === "win32" && "no FIFOs here" };
test("a hook that leads to a FIFO or sits as a folder is not read: --check and apply name it and end", posixFifo, (t) => {
  const outside = join(root, `fifo${seq++}`);
  mkdirSync(outside, { recursive: true });
  if (spawnSync("mkfifo", [join(outside, "pipe")]).status !== 0) {
    t.skip("no mkfifo here");
    return;
  }
  const plug = bundle();
  rmSync(join(plug, "scripts", "foo.mjs"));
  symlinkSync(join(outside, "pipe"), join(plug, "scripts", "foo.mjs"));
  rmSync(join(plug, "scripts", "stopper.mjs"));
  mkdirSync(join(plug, "scripts", "stopper.mjs"));
  const env = cleanEnv({ HOME: bareHome(), USERPROFILE: bareHome() });
  for (const args of [["--root", plug, "--check"], ["--root", plug]]) {
    const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env, timeout: 20000 });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    assert.equal(r.error?.code, undefined, `the run ended before its deadline: ${args.join(" ")}`);
    assert.match(out, /\[!\] 읽지 못함: foo \(ENOTFILE\)/);
    assert.match(out, /\[!\] 읽지 못함: stopper \(ENOTFILE\)/);
    assert.doesNotMatch(out, /결과: 모두 적용된 상태입니다\./);
    assert.doesNotMatch(out, /\n\s+at |Error:/, "no stack trace");
  }
  assert.ok(lstatSync(join(outside, "pipe")).isFIFO(), "the FIFO is still a FIFO");
});

// Writes down the order of fsync and rename for every file the tool replaces.
const ORDER_LOG = [
  'import fs from "node:fs";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const { fsyncSync, renameSync } = fs;",
  'const log = (s) => fs.appendFileSync(process.env.ORDER_LOG, `${s}\\n`);',
  'fs.fsyncSync = (fd) => { log("fsync"); return fsyncSync(fd); };',
  'fs.renameSync = (a, b) => { log(`rename ${String(b).split(/[\\\\/]/).pop()}`); return renameSync(a, b); };',
  "syncBuiltinESMExports();",
].join("\n");
test("every file the tool replaces is flushed to disk before the rename", () => {
  const plug = bundle();
  const pre = join(root, `order-log${seq++}.mjs`);
  const log = join(root, `order${seq++}.log`);
  writeFileSync(pre, `${ORDER_LOG}\n`);
  writeFileSync(log, "");
  const env = cleanEnv({ HOME: bareHome(), USERPROFILE: bareHome(), ORDER_LOG: log });
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(pre).href, TOOL, "--root", plug], { encoding: "utf8", env });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const lines = read(log).trim().split("\n");
  const renames = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith("rename "));
  assert.deepEqual(renames.map(([l]) => l).sort(), ["rename foo.mjs", "rename hooks.json", "rename stopper.mjs"]);
  for (const [l, i] of renames) assert.equal(lines[i - 1], "fsync", `${l} follows an fsync`);
});

// A git and a tar that write down the folder each call runs in, then run the real one.
function pwdWrappers(t) {
  const real = Object.fromEntries(["git", "tar"].map((c) => [c, spawnSync("sh", ["-c", `command -v ${c}`], { encoding: "utf8" }).stdout.trim()]));
  if (!real.git || !real.tar) {
    t.skip("git or tar not found on PATH");
    return null;
  }
  const dir = join(root, `pwdwrap${seq++}`);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "calls.log");
  for (const c of ["git", "tar"]) {
    writeFileSync(join(dir, c), ["#!/bin/sh", `printf '%s|%s|%s\\n' '${c}' "$*" "$(pwd -P)" >> '${log}'`, `exec '${real[c]}' "$@"`, ""].join("\n"), { mode: 0o755 });
  }
  return { PATH: `${dir}${delimiter}${process.env.PATH}`, log };
}
test("the git and tar the tool starts by name run in the home folder, and the repository's git in the marketplace", posixGit, (t) => {
  const { f } = bareApplyFixture();
  const w = pwdWrappers(t);
  if (!w) return;
  const r = run(f.home, [], { PATH: w.PATH });
  assert.equal(r.code, 0, r.out);
  const calls = read(w.log).trim().split("\n").map((l) => { const [cmd, args, pwd] = l.split("|"); return { cmd, args, pwd }; });
  const byName = (c) => c.cmd === "tar" || /^--version/.test(c.args) || /^rev-parse --local-env-vars/.test(c.args);
  assert.ok(calls.filter(byName).length >= 4, JSON.stringify(calls));
  for (const c of calls) assert.equal(c.pwd, realpathSync(byName(c) ? f.home : f.market), `${c.cmd} ${c.args}`);
});

// Hands back text that already holds the helper on the second read of foo.mjs, as a run that came first would leave it.
// Counts the reads too: a hook is read once.
const READ_COUNT = [
  'import fs from "node:fs";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const { readFileSync, openSync } = fs;",
  'const log = (s) => fs.appendFileSync(process.env.READ_LOG, `${s}\\n`);',
  'fs.readFileSync = (p, ...a) => { if (typeof p === "string" && p.endsWith("foo.mjs")) log("read"); return readFileSync(p, ...a); };',
  'fs.openSync = (p, ...a) => { if (typeof p === "string" && p.endsWith("foo.mjs")) log("read"); return openSync(p, ...a); };',
  "syncBuiltinESMExports();",
].join("\n");
test("a hook is read once per run: a second read could see what another run wrote in between", () => {
  const plug = bundle();
  const pre = join(root, `read-count${seq++}.mjs`);
  const log = join(root, `reads${seq++}.log`);
  writeFileSync(pre, `${READ_COUNT}\n`);
  writeFileSync(log, "");
  const env = cleanEnv({ HOME: bareHome(), USERPROFILE: bareHome(), READ_LOG: log });
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(pre).href, TOOL, "--root", plug], { encoding: "utf8", env });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(read(log).trim().split("\n").length, 1, "foo.mjs is read exactly once");
});

test("a set-url that fails shows the original URL up to its host, and no command that would print the rest", { skip: (!HAS_GIT && "git not found") || (process.platform === "win32" && "POSIX modes") || (asRoot && "root ignores modes") }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const withPassword = `https://u:${"s3" + "cret"}@example.invalid/omc.git?api_key=${"k3" + "y"}`;
  assert.equal(runGit(["remote", "set-url", "origin", `omc-pinned://${withPassword}`], f.market).status, 0);
  const gitDir = join(f.market, ".git");
  chmodSync(gitDir, 0o555);
  let back;
  try {
    back = run(f.home, ["--revert"]);
  } finally {
    chmodSync(gitDir, 0o755);
  }
  assert.equal(back.code, 1, back.out);
  assert.match(back.out, /원래 URL\(호스트까지만\): https:\/\/example\.invalid\. 원문은 origin 의 omc-pinned:\/\/ 뒤에 그대로 있습니다\./);
  assert.ok(!back.out.includes("s3cret") && !back.out.includes("k3y"), back.out);
  assert.doesNotMatch(back.out, /config --get/);
});

// A secret may sit in the path, a fragment or a ";" parameter as well as in the user part and the query, so the line
// names the URL up to its host. The whole URL is still in origin, after omc-pinned://.
test("a set-url that fails names the original URL up to its host, whatever part holds a secret", { skip: (!HAS_GIT && "git not found") || (process.platform === "win32" && "POSIX modes") || (asRoot && "root ignores modes") }, () => {
  const secret = "S3" + "CRETPW";
  for (const [url, shownAs] of [
    [`https://example.invalid/${secret}/omc.git`, "https://example.invalid"],
    [`https://example.invalid/omc.git#access_token=${secret}`, "https://example.invalid"],
    [`https://example.invalid/omc.git;auth=${secret}`, "https://example.invalid"],
    [`https://u:${secret}@example.invalid:8443/omc.git?token=${secret}`, "https://example.invalid:8443"],
    [`git@example.invalid:org/omc-${secret}.git`, "example.invalid"],
    [`https://[::1]:8443/${secret}/omc.git`, "https://[::1]:8443"],
    // what a parser reads as the host but is not shaped like one is not shown either
    [`ssh://example.invalid;k=${secret}/omc.git`, "(호스트를 알아볼 수 없음)"],
    [`a@${secret}@example.invalid:org/omc.git`, "(호스트를 알아볼 수 없음)"],
  ]) {
    const f = fakeHome([{ v: "5.6.1", active: true }]);
    assert.equal(runGit(["remote", "set-url", "origin", `omc-pinned://${url}`], f.market).status, 0);
    const gitDir = join(f.market, ".git");
    chmodSync(gitDir, 0o555);
    let back;
    try {
      back = run(f.home, ["--revert"]);
    } finally {
      chmodSync(gitDir, 0o755);
    }
    assert.equal(back.code, 1, back.out);
    assert.ok(back.out.includes(`원래 URL(호스트까지만): ${shownAs}. 원문은 origin 의 omc-pinned:// 뒤에 그대로 있습니다.`), back.out);
    assert.ok(!back.out.includes(secret), `${url}: ${back.out}`);
  }
});

// A git that ends with no error text leaves only Node's own message, which holds the command line and so the whole
// URL: the line says how git ended instead, and the URL stays out beyond its host.
test("a set-url that ends with no error text does not print the command line, for the pin and the revert", posixGit, (t) => {
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  if (!realGit) {
    t.skip("git not found on PATH");
    return;
  }
  const dir = join(root, `quietgit${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "git"), ["#!/bin/sh", 'if [ "$1" = remote ] && [ "$2" = set-url ]; then exit 1; fi', `exec '${realGit}' "$@"`, ""].join("\n"), { mode: 0o755 });
  const PATH = `${dir}${delimiter}${process.env.PATH}`;
  const mark = "PATH" + "MARK7";
  const url = `https://u:${"s3" + "cret"}@example.invalid/${mark}/omc.git;p=${mark}?token=x#${mark}`;
  for (const [args, pinned, line] of [[["--revert"], true, "고정 해제 실패"], [["--no-update"], false, "고정 실패"]]) {
    const f = fakeHome([{ v: "5.6.1", active: true }]);
    assert.equal(runGit(["remote", "set-url", "origin", pinned ? `omc-pinned://${url}` : url], f.market).status, 0);
    const r = run(f.home, args, { PATH });
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes(`${line}: origin 을 `) && r.out.includes("(git 이 오류 문구 없이 끝남 (1))"), r.out);
    assert.ok(!r.out.includes(mark) && !r.out.includes("s3cret"), `${args}: ${r.out}`);
  }
});

// The SKILL takes its next step from the result line, so every result line the tool can print has a row in its table.
test("every result line the tool can print has its row in the SKILL's table of result lines", () => {
  const results = new Set([...read(TOOL).matchAll(/결과: (.*?다\.)/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, "N")));
  assert.ok(results.size >= 6, [...results].join(" | "));
  const table = read(join(dirname(TOOL), "..", "SKILL.md")).split("| `결과:` 줄 | 다음 |")[1].split("\n\n")[0];
  for (const r of results) assert.ok(table.includes(`| \`${r}\` |`), `no row for: ${r}`);
});

// A git that cannot read the marketplace's config (it refuses another account's repository, or is not there at all)
// says nothing about the origin: the run names it and counts it, and --check does not call it all applied.
test("an origin git cannot read is named and counted: the revert does not say it is done, --check does not say all is applied", posixGit, (t) => {
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  if (!realGit) {
    t.skip("git not found on PATH");
    return;
  }
  const dir = join(root, `refusinggit${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "git"), ["#!/bin/sh",
    'if [ "$1" = config ] && [ "$2" = --get ]; then echo "fatal: detected dubious ownership in repository at \'/x\'" >&2; exit 128; fi',
    `exec '${realGit}' "$@"`, ""].join("\n"), { mode: 0o755 });
  const noGit = join(root, `nogit${seq++}`);
  mkdirSync(noGit, { recursive: true });
  for (const [PATH, why] of [[`${dir}${delimiter}${process.env.PATH}`, /origin 을 읽지 못함 \(fatal: detected dubious ownership/], [noGit, /origin 을 읽지 못함 \(git 을 실행하지 못함 \(ENOENT\)\)/]]) {
    const f = fakeHome([{ v: "5.6.1", active: true }]);
    assert.equal(runGit(["remote", "set-url", "origin", `omc-pinned://${ORIGIN}`], f.market).status, 0);
    const back = run(f.home, ["--revert"], { PATH });
    assert.equal(back.code, 1, back.out);
    assert.match(back.out, why);
    assert.doesNotMatch(back.out, /origin remote 없음|되돌리기 완료/);
    assert.match(back.out, /되돌리기를 끝내지 못했습니다/);
    assert.equal(origin(f.market), `omc-pinned://${ORIGIN}`, "the origin is still pinned");
    const check = run(f.home, ["--check", "--no-update"], { PATH });
    assert.equal(check.code, 1, check.out);
    assert.match(check.out, /결과: 마켓플레이스 origin 을 확인하지 못했습니다\./);
    const apply = run(f.home, ["--no-update"], { PATH });
    assert.equal(apply.code, 1, apply.out);
    assert.match(apply.out, /완료\. 실패 1건\./);
  }
});

test("a query value is masked whatever its name", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const pw = "S3" + "CRETPW";
  for (const name of ["token", "auth_token", "api_key", "apikey", "key", "password", "secret", "sig", "X-Amz-Signature", "Token"]) {
    const url = `https://example.invalid/omc.git?a=1&${name}=${pw}`;
    assert.equal(runGit(["remote", "set-url", "origin", url], f.market).status, 0);
    const out = run(f.home, ["--check", "--no-update"]).out;
    assert.ok(!out.includes(pw), `${name}: ${out}`);
    assert.match(out, /origin=https:\/\/example\.invalid\/omc\.git\?a=\*\*\*&/, name);
  }
});

// The query mask reads each name once: an origin of many "?" and no "=" is masked in time that grows with its length,
// not with its square (with "?" allowed in the name, 100,000 of them took 16 seconds).
test("an origin of many question marks is masked without stalling --check", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  // written to the config file, not given to git: a command line this long is more than Windows takes
  const config = join(f.market, ".git", "config");
  writeFileSync(config, read(config).replace(ORIGIN, `${ORIGIN}?${"?".repeat(300000)}`));
  const r = runBy(f.home, ["--check", "--no-update"]);
  assert.equal(r.error, undefined, "the run ended before its deadline");
  assert.match(r.out, /마켓플레이스 미고정 \(origin=https:\/\/example\.invalid\/omc\.git\?\?\?/);
});

test("--check names the version whose hooks.json it cannot read; the verdict leaves an idle version out and says so", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.3.0" }, { v: "5.6.1", active: true }]);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  writeFileSync(join(f.cache, "5.3.0", "hooks", "hooks.json"), "{ broken");
  const r = run(f.home, ["--check", "--no-update"]);
  assert.match(r.out, /\[!\] 5\.3\.0: hooks\.json 을 읽지 못함 \(JSON 이 아님\)/, "the line names its version, as the ok lines do");
  assert.match(r.out, /ok  5\.6\.1: 이미 제거됨/);
  assert.match(r.out, /결과: 모두 적용된 상태입니다\./);
  assert.match(r.out, /참고: 비활성 버전 5\.3\.0 의 hooks\.json 을 확인하지 못했습니다\./);
  assert.equal(r.code, 1, "a file it could not read still ends the run with 1");
});

test("the hint for a patch with no backup goes through a temp tar file, never a pipe", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  rmSync(join(f.cache, "5.6.1", "scripts", "foo.mjs.omcbak"));
  const r = run(f.home, ["--revert"]);
  assert.match(r.out, /git -C ".*" archive -o "<임시 tar>" v5\.6\.1 scripts\/<이름>\.mjs\n\s+tar -xf "<임시 tar>" -C ".*5\.6\.1"/);
  assert.doesNotMatch(r.out, /archive v5\.6\.1 .*\|/);
});

// Removes the backup for real first, then lets the tool try: another run got there first.
const BACKUP_GONE_FIRST = [
  'import fs from "node:fs";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const real = fs.unlinkSync;",
  'fs.unlinkSync = (p) => { if (String(p).endsWith(".omcbak")) { try { real(p); } catch { /* already gone */ } } return real(p); };',
  "syncBuiltinESMExports();",
].join("\n");
// Refuses to remove a backup, as a file another process holds open does on Windows.
const BACKUP_HELD = [
  'import fs from "node:fs";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const real = fs.unlinkSync;",
  'fs.unlinkSync = (p) => { if (String(p).endsWith(".omcbak")) throw Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" }); return real(p); };',
  "syncBuiltinESMExports();",
].join("\n");
test("a revert whose backup another run removed first has still restored the hook; one that cannot remove it says so and counts it", () => {
  const plug = bundle();
  const home = bareHome();
  assert.equal(run(home, ["--root", plug]).code, 0);
  const gone = join(root, `backup-gone${seq++}.mjs`);
  writeFileSync(gone, `${BACKUP_GONE_FIRST}\n`);
  const first = runImport(gone, home, ["--revert", "--root", plug]);
  assert.equal(first.code, 0, first.out);
  assert.doesNotMatch(first.out, /\[!\]/);
  assert.equal(read(join(plug, "scripts", "foo.mjs")), SCRIPT("foo"));
  assert.equal(run(home, ["--root", plug]).code, 0);
  const held = join(root, `backup-held${seq++}.mjs`);
  writeFileSync(held, `${BACKUP_HELD}\n`);
  const second = runImport(held, home, ["--revert", "--root", plug]);
  assert.equal(second.code, 1, second.out);
  assert.match(second.out, /\[!\] 되돌렸으나 백업을 지우지 못함: foo \(EPERM\)/);
  assert.match(second.out, /\[!\] 되돌렸으나 hooks\.json 의 백업을 지우지 못함 \(EPERM\)/);
  assert.doesNotMatch(second.out, /되돌리지 않음/);
  assert.equal(read(join(plug, "scripts", "foo.mjs")), SCRIPT("foo"), "the hook is restored all the same");
  assert.ok(existsSync(join(plug, "scripts", "foo.mjs.omcbak")), "the backup is left for a later revert");
});

// Plays the run that came first: before the tool opens foo.mjs.omcbak, puts the original back and removes the backup.
const OTHER_RUN_FIRST = [
  'import fs from "node:fs";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const { openSync, readFileSync, copyFileSync, unlinkSync } = fs; let done = false;",
  'const play = (p) => { if (!done && typeof p === "string" && p.endsWith("foo.mjs.omcbak")) { done = true; copyFileSync(p, p.slice(0, -7)); unlinkSync(p); } };',
  "fs.openSync = (p, ...a) => { play(p); return openSync(p, ...a); };",
  "fs.readFileSync = (p, ...a) => { play(p); return readFileSync(p, ...a); };",
  "syncBuiltinESMExports();",
].join("\n");
test("a revert whose backup is taken by a run that came first does not call that a failure", () => {
  const plug = bundle();
  const home = bareHome();
  assert.equal(run(home, ["--root", plug]).code, 0);
  const pre = join(root, `other-run-first${seq++}.mjs`);
  writeFileSync(pre, `${OTHER_RUN_FIRST}\n`);
  const r = runImport(pre, home, ["--root", plug, "--revert"]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /\[!\]/);
  assert.equal(read(join(plug, "scripts", "foo.mjs")), SCRIPT("foo"), "the other run's restore stands");
  assert.equal(read(join(plug, "scripts", "stopper.mjs")), SCRIPT("stopper"), "and this run restores the rest");
});

test("a hook this account may not write is not replaced: --check says so beforehand, apply names it and counts it", { skip: (process.platform === "win32" && "POSIX modes") || (asRoot && "root ignores modes") }, () => {
  const plug = bundle();
  const foo = join(plug, "scripts", "foo.mjs");
  chmodSync(foo, 0o444);
  const check = run(bareHome(), ["--root", plug, "--check"]);
  assert.match(check.out, /패치 필요, 쓸 수 없음: foo \(쓸 권한이 없음\)/);
  const r = run(bareHome(), ["--root", plug]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[!\] 쓰지 않음: foo \(쓸 권한이 없음\)/);
  assert.equal(read(foo), SCRIPT("foo"));
  assert.equal(statSync(foo).mode & 0o777, 0o444);
});

test("a revert does not turn a FIFO that a hook leads to into a file", posixFifo, (t) => {
  const plug = bundle();
  const sc = join(plug, "scripts");
  assert.equal(run(bareHome(), ["--root", plug]).code, 0);
  rmSync(join(sc, "foo.mjs"));
  if (spawnSync("mkfifo", [join(sc, "pipe")]).status !== 0) {
    t.skip("no mkfifo here");
    return;
  }
  symlinkSync("pipe", join(sc, "foo.mjs"));
  const r = run(bareHome(), ["--revert", "--root", plug]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[!\] 되돌리지 않음: foo \(일반 파일이 아님\)/);
  assert.ok(lstatSync(join(sc, "pipe")).isFIFO(), "the FIFO is still a FIFO");
});

test("a bare apply that finds the target version in the cache but not active switches to it, and stops when it cannot", { skip: (!HAS_GIT && "git not found") || (process.platform === "win32" && "POSIX modes") || (asRoot && "root ignores modes") }, () => {
  const { f, target } = bareApplyFixture();
  const installed = join(f.plugins, "installed_plugins.json");
  chmodSync(f.plugins, 0o555);
  try {
    assert.equal(run(f.home, []).code, 1);
  } finally {
    chmodSync(f.plugins, 0o755);
  }
  const entry = () => JSON.parse(read(installed)).plugins["oh-my-claudecode@omc"][0];
  assert.equal(entry().version, "5.6.1", "the failed switch changed nothing");
  assert.ok(existsSync(join(f.cache, target)), "the target version is in the cache now");
  // with the tag gone the switch cannot name its commit: stop, change nothing
  const tag = runGit(["tag", "-l", `v${target}`], f.market).stdout.trim();
  assert.equal(runGit(["tag", "-d", tag], f.market).status, 0);
  const lost = run(f.home, []);
  assert.equal(lost.code, 1, lost.out);
  assert.match(lost.out, /태그 v.* 를 마켓플레이스에서 찾을 수 없음/);
  assert.equal(entry().version, "5.6.1");
  assert.doesNotMatch(lost.out, /완료\./);
  // with the tag back, the second run does what the first was asked to
  assert.equal(runGit(["tag", tag], f.market).status, 0);
  const r = run(f.home, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`${target.replace(/\./g, "\\.")} 은 캐시에 있으나 활성 판은 5\\.6\\.1 입니다`));
  assert.equal(entry().version, target);
  assert.match(read(join(f.cache, target, "scripts", "foo.mjs")), /__omcRaceImport\(import\(/, "the target version is the one patched");
});

// ---- PINNED writes never follow a link: the first pin, a re-pin after a kept link, and a link swapped in during the write.
const BACKSLASH = String.fromCharCode(92);
const pinPath = (f) => join(f.home, ".claude", "omc-local-patches", "PINNED");
// Puts `content` in a file elsewhere ("dotfiles") and makes PINNED a link to it. Returns the file, or null when links need privileges.
function linkPinTo(t, f, content) {
  const dot = join(root, `dotfiles${seq++}`);
  mkdirSync(dot, { recursive: true });
  mkdirSync(dirname(pinPath(f)), { recursive: true });
  const target = join(dot, "PINNED");
  writeFileSync(target, content);
  rmSync(pinPath(f), { force: true });
  try {
    symlinkSync(target, pinPath(f));
  } catch {
    t.skip("file symlinks need privileges here");
    return null;
  }
  return target;
}

test("a first pin whose PINNED is a link is refused and counted: the file it leads to and the link are left, the origin stays pinned", { skip: !HAS_GIT && "git not found" }, (t) => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const target = linkPinTo(t, f, "notes the user keeps here\n");
  if (!target) return;
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[!\] 고정 기록\(PINNED\)을 쓰지 못함 \(링크라 따라가 쓰지 않음\)\. origin 은 고정됨/);
  assert.match(r.out, /완료\. 실패 1건\./);
  assert.equal(read(target), "notes the user keeps here\n");
  assert.ok(lstatSync(pinPath(f)).isSymbolicLink(), "the link stays a link");
  assert.equal(origin(f.market), `omc-pinned://${ORIGIN}`);
  assert.equal(run(f.home, ["--no-update"]).code, 0, "a later apply, with no URL field in the target, is quiet");
});

test("a first pin whose PINNED is a dangling link is refused too: no file appears where it leads", { skip: !HAS_GIT && "git not found" }, (t) => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  mkdirSync(dirname(pinPath(f)), { recursive: true });
  const gone = join(root, `gone${seq++}`, "PINNED");
  try {
    symlinkSync(gone, pinPath(f));
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 1, r.out);
  assert.ok(lstatSync(pinPath(f)).isSymbolicLink(), "the link stays a link");
  assert.throws(() => lstatSync(gone), { code: "ENOENT" });
});

test("an apply after a revert that kept a linked PINNED does not write through the link", { skip: !HAS_GIT && "git not found" }, (t) => {
  const { f, record } = olderPin();
  const target = linkPinTo(t, f, record);
  if (!target) return;
  assert.equal(run(f.home, ["--revert"]).code, 1, "the revert keeps the link and counts it");
  const again = run(f.home, ["--no-update"]);
  assert.equal(read(target), record, "the file the link leads to is as it was");
  assert.equal(again.code, 1, again.out);
});

test("a PINNED swapped for a link between the check and the write is replaced, never written through", { skip: (!HAS_GIT && "git not found") || (process.platform === "win32" && "file symlinks need privileges") }, () => {
  const { f, record, pinfile } = olderPin();
  writeFileSync(pinfile, record);
  const victim = join(root, `victim${seq++}.txt`);
  writeFileSync(victim, "IMPORTANT USER DATA\n");
  const pre = join(root, `swap-to-link${seq++}.mjs`);
  writeFileSync(pre, [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const real = fs.lstatSync; let done = false;",
    `fs.lstatSync = (p, ...a) => { const r = real(p, ...a); if (!done && String(p).endsWith("PINNED")) { done = true; fs.unlinkSync(p); fs.symlinkSync(${JSON.stringify(victim)}, p); } return r; };`,
    "syncBuiltinESMExports();",
  ].join("\n"));
  runImport(pre, f.home, ["--no-update"]);
  assert.equal(read(victim), "IMPORTANT USER DATA\n");
});

test("a link planted at PINNED after the check of a first pin is replaced, never written through", { skip: (!HAS_GIT && "git not found") || (process.platform === "win32" && "file symlinks need privileges") }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const victim = join(root, `victim${seq++}.txt`);
  writeFileSync(victim, "IMPORTANT USER DATA\n");
  const pre = join(root, `plant-link${seq++}.mjs`);
  writeFileSync(pre, [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const real = fs.lstatSync; let done = false;",
    `fs.lstatSync = (p, ...a) => { try { return real(p, ...a); } catch (e) { if (!done && String(p).endsWith("PINNED")) { done = true; fs.symlinkSync(${JSON.stringify(victim)}, p); } throw e; } };`,
    "syncBuiltinESMExports();",
  ].join("\n"));
  runImport(pre, f.home, ["--no-update"]);
  assert.equal(read(victim), "IMPORTANT USER DATA\n");
});

test("a record folder that is itself a link keeps working: only a PINNED that is a link is refused", { skip: !HAS_GIT && "git not found" }, (t) => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const kept = join(root, `kept${seq++}`);
  mkdirSync(kept, { recursive: true });
  try {
    symlinkSync(kept, join(f.home, ".claude", "omc-local-patches"));
  } catch {
    t.skip("symlinks need privileges here");
    return;
  }
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 0, r.out);
  assert.ok(statSync(join(kept, "PINNED")).isFile(), "the record is written into the folder the link leads to");
  assert.equal(run(f.home, ["--revert"]).code, 0);
  assert.ok(lstatSync(join(f.home, ".claude", "omc-local-patches")).isSymbolicLink(), "the folder link stays");
});

// ---- hard links: the other names of an old record keep the URL, so the run says so.
test("an apply and a revert over an old record with another hard-linked name say the URL stays in the other name", { skip: !HAS_GIT && "git not found" }, (t) => {
  for (const mode of ["--no-update", "--revert"]) {
    const { f, secret, record, pinfile } = olderPin();
    writeFileSync(pinfile, record);
    const other = join(root, `other-name${seq++}`);
    try {
      linkSync(pinfile, other);
    } catch {
      t.skip("hard links are not available here");
      return;
    }
    const ino = lstatSync(pinfile, { bigint: true }).ino;
    const r = run(f.home, [mode]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /옛 URL 칸을 이 이름에서만 지움 \(같은 파일의 다른 이름이 있어 그쪽에는 남음\)/);
    assert.ok(r.out.includes(`다른 이름은 같은 파일 시스템에서 inode(Windows 는 파일 ID) ${ino} 로 찾습니다.`), r.out);
    assert.ok(!r.out.includes(secret), "the password is not printed");
  }
});

// The first pin writes a new record over the old one: the other name of an old record keeps the URL all the same.
test("a first pin over an old record that has another hard-linked name says the URL stays there, and counts it", { skip: !HAS_GIT && "git not found" }, (t) => {
  const { f, secret, record, pinfile } = olderPin();
  assert.equal(runGit(["remote", "set-url", "origin", ORIGIN], f.market).status, 0, "the origin is not pinned yet");
  writeFileSync(pinfile, record);
  const other = join(root, `other-name${seq++}`);
  try {
    linkSync(pinfile, other);
  } catch {
    t.skip("hard links are not available here");
    return;
  }
  const ino = lstatSync(pinfile, { bigint: true }).ino;
  const r = run(f.home, ["--no-update"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /옛 URL 칸을 이 이름에서만 지움 \(같은 파일의 다른 이름이 있어 그쪽에는 남음\)/);
  assert.ok(r.out.includes(`다른 이름은 같은 파일 시스템에서 inode(Windows 는 파일 ID) ${ino} 로 찾습니다.`), r.out);
  assert.equal(origin(f.market), `omc-pinned://${ORIGIN}`, "the origin is pinned all the same");
  assert.equal(JSON.parse(read(pinfile)).originUrl, undefined, "this name holds the new record");
  assert.ok(read(other).includes(secret), "the other name is left as it was");
  assert.ok(!r.out.includes(secret), "the password is not printed");
});

test("a hard-linked record with no URL field is not named", { skip: !HAS_GIT && "git not found" }, (t) => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  try {
    linkSync(pinPath(f), join(root, `other-name${seq++}`));
  } catch {
    t.skip("hard links are not available here");
    return;
  }
  assert.doesNotMatch(run(f.home, ["--no-update"]).out, /PINNED/);
  const rev = run(f.home, ["--revert"]);
  assert.equal(rev.code, 0, rev.out);
});

// ---- the result of --check when the record cannot be cleaned: it is the result only when nothing else is left to apply.
test("--check with patches left and a record this tool cannot clean says patches are left, with a note; the apply patches and counts the record", { skip: !HAS_GIT && "git not found" }, (t) => {
  const { f, record } = olderPin();
  if (!linkPinTo(t, f, record)) return;
  const c = run(f.home, ["--check", "--no-update"]);
  assert.match(c.out, /결과: 적용되지 않은 항목이 있습니다\./);
  assert.match(c.out, /참고: 고정 기록\(PINNED\)의 옛 URL 칸이 이 도구로 지울 수 없는 곳에 있습니다\./);
  assert.match(c.out, /적용해도 그곳의 칸은 남고, 적용은 이 항목을 실패로 세어 종료 1 로 끝납니다\./);
  const a = run(f.home, ["--no-update"]);
  assert.equal(a.code, 1, a.out);
  assert.match(a.out, /패치 2건 \/ 실패 0건/);
  assert.match(a.out, /완료\. 실패 1건\./);
  const again = run(f.home, ["--check", "--no-update"]);
  assert.match(again.out, /결과: 고정 기록\(PINNED\)의 옛 URL 칸이 이 도구로 지울 수 없는 곳에 있습니다\./);
  assert.doesNotMatch(again.out, /참고: 고정 기록/);
});

test("--check over an unwritable record folder says it cannot drop the URL, and does not promise to", { skip: (!HAS_GIT && "git not found") || (process.platform === "win32" && "POSIX permission bits") || (asRoot && "root ignores modes") }, () => {
  const { f, record, pinfile } = olderPin();
  writeFileSync(pinfile, record);
  chmodSync(dirname(pinfile), 0o555);
  try {
    const c = run(f.home, ["--check", "--no-update"]);
    assert.match(c.out, /옛 URL 칸을 지울 수 없음 \(쓰지 못함: EACCES\)/);
    assert.doesNotMatch(c.out, /적용하면 지움/);
    assert.match(c.out, /결과: 적용되지 않은 항목이 있습니다\./);
  } finally {
    chmodSync(dirname(pinfile), 0o755);
  }
});

// ---- a revert always drops the record, whatever state the marketplace is in.
for (const state of ["no marketplace folder", "no .git", "no origin"]) {
  test(`--revert with ${state} still removes a leftover PINNED`, { skip: !HAS_GIT && "git not found" }, () => {
    const f = fakeHome([{ v: "5.6.1", active: true }]);
    assert.equal(run(f.home, ["--no-update"]).code, 0);
    if (state === "no marketplace folder") rmSync(f.market, { recursive: true });
    if (state === "no .git") rmSync(join(f.market, ".git"), { recursive: true });
    if (state === "no origin") assert.equal(runGit(["remote", "remove", "origin"], f.market).status, 0);
    const r = run(f.home, ["--revert"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(existsSync(pinPath(f)), false);
  });
}

test("a revert whose set-url fails still removes PINNED; the origin stays pinned and the failure is counted once", { skip: (!HAS_GIT && "git not found") || (process.platform === "win32" && "POSIX modes") || (asRoot && "root ignores modes") }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const gitDir = join(f.market, ".git");
  chmodSync(gitDir, 0o555);
  try {
    const back = run(f.home, ["--revert"]);
    assert.equal(back.code, 1, back.out);
    assert.match(back.out, /되돌리기를 끝내지 못했습니다\. 실패 1건\./);
  } finally {
    chmodSync(gitDir, 0o755);
  }
  assert.equal(existsSync(pinPath(f)), false, "the record goes even when the origin could not be restored");
  assert.equal(origin(f.market), `omc-pinned://${ORIGIN}`);
});

// ---- an old record is looked at when the marketplace cannot be pinned too (none, no .git, no origin).
for (const state of ["no marketplace folder", "no .git", "no origin"]) {
  test(`--check names an old PINNED's URL with ${state}, and the apply drops it`, { skip: !HAS_GIT && "git not found" }, () => {
    const { f, record, pinfile } = olderPin();
    assert.equal(run(f.home, ["--no-update"]).code, 0, "patches and pins first");
    writeFileSync(pinfile, record);
    if (state === "no marketplace folder") rmSync(f.market, { recursive: true });
    if (state === "no .git") rmSync(join(f.market, ".git"), { recursive: true });
    if (state === "no origin") assert.equal(runGit(["remote", "remove", "origin"], f.market).status, 0);
    const c = run(f.home, ["--check", "--no-update"]);
    assert.match(c.out, /옛 URL 칸이 남아 있음 \(적용하면 지움\)/);
    assert.doesNotMatch(c.out, /결과: 모두 적용된 상태입니다/);
    const a = run(f.home, ["--no-update"]);
    assert.equal(a.code, 0, a.out);
    assert.equal(JSON.parse(read(pinfile)).originUrl, undefined);
  });
}

test("with no marketplace and no PINNED at all, --check and the apply are as quiet as before", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  rmSync(f.market, { recursive: true });
  rmSync(pinPath(f));
  assert.match(run(f.home, ["--check", "--no-update"]).out, /결과: 모두 적용된 상태입니다\./);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
});

// ---- the record is judged by its parsed top-level key; the text decides only what is not JSON.
test("a key written with an escape sequence is still the URL field: --check names it and the apply drops it", { skip: !HAS_GIT && "git not found" }, () => {
  const { f, secret, withPassword, pinfile } = olderPin();
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  writeFileSync(pinfile, `{"origin${BACKSLASH}u0055rl": "${withPassword}", "host": "x"}\n`);
  assert.match(run(f.home, ["--check", "--no-update"]).out, /옛 URL 칸이 남아 있음 \(적용하면 지움\)/);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  assert.ok(!read(pinfile).includes(secret), "the secret is gone from the file");
});

test("a link to a JSON file that names originUrl only inside a value is not blocked; one to a text file that holds the word still is", { skip: !HAS_GIT && "git not found" }, (t) => {
  const { f } = olderPin();
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  if (!linkPinTo(t, f, `${JSON.stringify({ pinnedAt: "t", note: "the old tool wrote originUrl here" })}\n`)) return;
  assert.match(run(f.home, ["--check", "--no-update"]).out, /결과: 모두 적용된 상태입니다\./);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  linkPinTo(t, f, "# notes\nthe old tool wrote an originUrl field\n");
  assert.match(run(f.home, ["--check", "--no-update"]).out, /결과: 고정 기록\(PINNED\)의 옛 URL 칸이 이 도구로 지울 수 없는 곳에 있습니다\./);
});

test("a JSON value that is no object, holding the word, is left alone", { skip: !HAS_GIT && "git not found" }, () => {
  const { f, pinfile } = olderPin();
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  writeFileSync(pinfile, '"originUrl"\n');
  assert.match(run(f.home, ["--check", "--no-update"]).out, /결과: 모두 적용된 상태입니다\./);
});

// ---- reads: every file the tool reads is opened without blocking and checked as a regular file before its read.
const posixFifoGit = { skip: (process.platform === "win32" && "no FIFOs here") || (!HAS_GIT && "git not found") };
const mkfifoAt = (p) => {
  rmSync(p, { force: true });
  return spawnSync("mkfifo", [p]).status === 0;
};
// Runs the tool with a deadline, with a module loaded first if pre is given. error is ETIMEDOUT when the run was killed.
function runBy(home, args, pre) {
  const env = cleanEnv({ HOME: home, USERPROFILE: home });
  delete env.OMC_PATCH_INSTALLED;
  const first = pre ? ["--import", pathToFileURL(pre).href] : [];
  const r = spawnSync(process.execPath, [...first, TOOL, ...args], { encoding: "utf8", env, timeout: 20000 });
  return { code: r.status, error: r.error?.code, out: `${r.stdout || ""}${r.stderr || ""}` };
}

test("a FIFO in place of installed_plugins.json is not read: --check guesses the version, the bare apply names the file", posixFifoGit, (t) => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  if (!mkfifoAt(join(f.plugins, "installed_plugins.json"))) {
    t.skip("no mkfifo here");
    return;
  }
  const check = runBy(f.home, ["--check", "--no-update"]);
  assert.equal(check.error, undefined, "--check ended before its deadline");
  assert.match(check.out, /활성 버전: 5\.6\.1 \(추정: installed_plugins\.json 에서 확인 못 함\)/);
  const { f: bare } = bareApplyFixture();
  mkfifoAt(join(bare.plugins, "installed_plugins.json"));
  const r = runBy(bare.home, []);
  assert.equal(r.error, undefined, "the bare apply ended before its deadline");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[!\] 읽지 못함: installed_plugins\.json \(ENOTFILE\)/);
  assert.doesNotMatch(r.out, /\n\s+at |Error:/, "no stack trace");
});

test("a FIFO in place of settings.json is not read: --check and the apply leave out its line and end", posixFifoGit, (t) => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  const settings = join(f.home, ".claude", "settings.json");
  if (!mkfifoAt(settings)) {
    t.skip("no mkfifo here");
    return;
  }
  for (const args of [["--check", "--no-update"], ["--no-update"]]) {
    const r = runBy(f.home, args);
    assert.equal(r.error, undefined, `the run ended before its deadline: ${args.join(" ")}`);
    assert.doesNotMatch(r.out, /DISABLE_AUTOUPDATER:/, "the settings line is left out");
    assert.doesNotMatch(r.out, /\n\s+at |Error:/, "no stack trace");
  }
  assert.ok(lstatSync(settings).isFIFO(), "the FIFO is still a FIFO");
});

test("FIFOs in place of the name labels of a --root folder are not read: the folder counts as one with no label", posixFifo, (t) => {
  const plug = bundle();
  if (!mkfifoAt(join(plug, "package.json"))) {
    t.skip("no mkfifo here");
    return;
  }
  mkdirSync(join(plug, ".claude-plugin"));
  mkfifoAt(join(plug, ".claude-plugin", "plugin.json"));
  const r = runBy(bareHome(), ["--root", plug, "--check"]);
  assert.equal(r.error, undefined, "the run ended before its deadline");
  assert.doesNotMatch(r.out, /OMC 플러그인 폴더가 아님/);
  assert.match(r.out, /결과: 적용되지 않은 항목이 있습니다\./);
});

test("--scan names a FIFO it was given and ends", posixFifo, (t) => {
  const dir = join(root, `scan${seq++}`);
  mkdirSync(dir, { recursive: true });
  if (!mkfifoAt(join(dir, "pipe.mjs"))) {
    t.skip("no mkfifo here");
    return;
  }
  const r = runBy(bareHome(), ["--scan", join(dir, "pipe.mjs")]);
  assert.equal(r.error, undefined, "the run ended before its deadline");
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(JSON.parse(r.out).map((x) => x.error), ["ENOTFILE"]);
});

// A module that swaps the file a named function is about to read for a FIFO, after that function's stat and before its read.
const swapToFifoIn = (fn, tail) => [
  'import fs from "node:fs";',
  'import { execFileSync } from "node:child_process";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const real = fs.statSync;",
  "let done = false;",
  `fs.statSync = (p, ...a) => { const r = real(p, ...a); if (!done && r && r.isFile() && String(p).endsWith(${JSON.stringify(tail)}) && new Error().stack.includes(${JSON.stringify(fn)})) { done = true; fs.unlinkSync(p); execFileSync("mkfifo", [String(p)]); } return r; };`,
  "syncBuiltinESMExports();",
].join("\n");

test("a PINNED swapped for a FIFO between its stat and its read does not stall --check", posixFifoGit, (t) => {
  if (!mkfifoAt(join(root, `probe${seq++}`))) {
    t.skip("no mkfifo here");
    return;
  }
  const { f, record, pinfile } = olderPin();
  writeFileSync(pinfile, record);
  const pre = join(root, `pin-swap${seq++}.mjs`);
  writeFileSync(pre, `${swapToFifoIn("pinRecordText", "PINNED")}\n`);
  const r = runBy(f.home, ["--check", "--no-update"], pre);
  assert.equal(r.error, undefined, "the run ended before its deadline");
  assert.ok(lstatSync(pinfile).isFIFO(), "the record was swapped for a FIFO in the run");
  assert.doesNotMatch(r.out, /읽지 못함|확인하지 못함/);
});

test("a PINNED that is a socket is passed over as a FIFO is: no read error", posixFifoGit, async (t) => {
  const { f, pinfile } = olderPin();
  const srv = createServer();
  try {
    await new Promise((res, rej) => { srv.once("error", rej); srv.listen(pinfile, res); });
  } catch (e) {
    t.skip(`no socket at this path here: ${e.code}`);
    return;
  }
  try {
    const r = runBy(f.home, ["--check", "--no-update"]);
    assert.equal(r.error, undefined, "the run ended before its deadline");
    assert.doesNotMatch(r.out, /읽지 못함|확인하지 못함/);
  } finally {
    await new Promise((res) => srv.close(res));
  }
});

test("a PINNED that is a FIFO is not read: --check, the apply and the revert end, and the revert removes it", posixFifoGit, (t) => {
  const { f, pinfile } = olderPin();
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  if (!mkfifoAt(pinfile)) {
    t.skip("no mkfifo here");
    return;
  }
  for (const args of [["--check", "--no-update"], ["--no-update"]]) {
    const r = runBy(f.home, args);
    assert.equal(r.error, undefined, `the run ended before its deadline: ${args.join(" ")}`);
    assert.doesNotMatch(r.out, /읽지 못함|확인하지 못함/);
  }
  const back = runBy(f.home, ["--revert"]);
  assert.equal(back.error, undefined, "the revert ended before its deadline");
  assert.equal(back.code, 0, back.out);
  assert.equal(existsSync(pinfile), false, "the revert removed the FIFO");
});

// A link to itself (a link loop) and a record folder that is a file stop the stat of PINNED (ELOOP, ENOTDIR) as a
// missing record does: neither can hold a URL.
test("a PINNED that is a link to itself, and a record folder that is a file, hold no record: --check and the revert pass over them", { skip: !HAS_GIT && "git not found" }, (t) => {
  const { f, pinfile } = olderPin();
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  rmSync(pinfile, { force: true });
  try {
    symlinkSync(pinfile, pinfile);
  } catch {
    t.skip("file symlinks need privileges here");
    return;
  }
  assert.match(run(f.home, ["--check", "--no-update"]).out, /결과: 모두 적용된 상태입니다\./, "a link loop");
  rmSync(pinfile, { force: true });
  rmSync(dirname(pinfile), { recursive: true });
  writeFileSync(dirname(pinfile), "a file where the record folder would be\n");
  assert.match(run(f.home, ["--check", "--no-update"]).out, /결과: 모두 적용된 상태입니다\./, "a record folder that is a file");
  const back = run(f.home, ["--revert"]);
  assert.equal(back.code, 0, back.out);
});

// hooks.json is read first for the hook names. One that is not a regular file is named where hooks.json is checked,
// not lost in a line about an error the tool did not handle.
test("a hooks.json that is a FIFO or a folder is named: --check could not read it, the apply leaves it, both count it", posixFifo, (t) => {
  const folder = (p) => { rmSync(p); mkdirSync(p); return true; };
  for (const make of [mkfifoAt, folder]) {
    for (const [args, line, verdict] of [
      [["--check"], /\[!\] hooks\.json 을 읽지 못함 \(ENOTFILE\)/, /결과: hooks\.json 을 확인하지 못했습니다\./],
      [[], /\[!\] hooks\.json 을 건드리지 않음 \(일반 파일이 아님\)/, /완료\. 실패 1건\./],
    ]) {
      const plug = bundle();
      if (!make(join(plug, "hooks", "hooks.json"))) {
        t.skip("no mkfifo here");
        return;
      }
      const r = runBy(bareHome(), ["--root", plug, ...args]);
      assert.equal(r.error, undefined, `the run ended before its deadline: ${args.join(" ")}`);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, line);
      assert.match(r.out, verdict);
      assert.doesNotMatch(r.out, /처리하지 못한 오류/);
    }
  }
});

test("a file a hook link leads to, swapped for a FIFO before the revert peeks into it, does not stall the revert", posixFifo, (t) => {
  if (!mkfifoAt(join(root, `probe${seq++}`))) {
    t.skip("no mkfifo here");
    return;
  }
  const home = bareHome();
  const plug = bundle();
  const outside = join(root, `outside${seq++}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "foo.mjs"), "// my own work, never patched by this tool\n");
  writeFileSync(join(plug, "scripts", "foo.mjs.omcbak"), SCRIPT("foo"));
  rmSync(join(plug, "scripts", "foo.mjs"));
  symlinkSync(join(outside, "foo.mjs"), join(plug, "scripts", "foo.mjs"));
  const pre = join(root, `peek-swap${seq++}.mjs`);
  writeFileSync(pre, `${swapToFifoIn("patchedByOldTool", "foo.mjs")}\n`);
  const r = runBy(home, ["--revert", "--root", plug], pre);
  assert.equal(r.error, undefined, "the revert ended before its deadline");
  assert.ok(lstatSync(join(outside, "foo.mjs")).isFIFO(), "the file was swapped for a FIFO in the run");
  assert.match(r.out, /패치가 보이지 않습니다\. 덮어쓰지 말고 링크가 가리키는 곳이 맞는지 먼저 확인하십시오\./);
});

// ---- hard links: --check says the apply can clean only this name, and every run gives the number to find the other names by.
test("--check over an old record with another hard-linked name says the apply cleans only this name, with the inode to find the other by", { skip: !HAS_GIT && "git not found" }, (t) => {
  const { f, secret, record, pinfile } = olderPin();
  writeFileSync(pinfile, record);
  try {
    linkSync(pinfile, join(root, `other-name${seq++}`));
  } catch {
    t.skip("hard links are not available here");
    return;
  }
  const ino = lstatSync(pinfile, { bigint: true }).ino;
  const r = run(f.home, ["--check", "--no-update"]);
  assert.match(r.out, /옛 URL 칸을 이 이름에서만 지울 수 있음 \(같은 파일의 다른 이름이 있어 그쪽에는 남음\)/);
  assert.ok(r.out.includes(`다른 이름은 같은 파일 시스템에서 inode(Windows 는 파일 ID) ${ino} 로 찾습니다.`), r.out);
  assert.doesNotMatch(r.out, /적용하면 지움/);
  assert.match(r.out, /참고: 고정 기록\(PINNED\)의 옛 URL 칸이 이 도구로 지울 수 없는 곳에 있습니다\./);
  assert.ok(!r.out.includes(secret), "the password is not printed");
});

// 0.20.4 B2 Task 1: reverts that stop or say done when they did not finish (B2-01, B2-10, B2-13)
test("a revert over a version folder with no scripts folder goes on: the other versions, hooks.json and the pin are reverted", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.3.0" }, { v: "5.6.1", active: true }]);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const half = join(f.cache, "5.5.0");
  mkdirSync(join(half, "hooks"), { recursive: true });
  writeFileSync(join(half, "hooks", "hooks.json"), HOOKS_JSON);
  const r = run(f.home, ["--revert"]);
  assert.doesNotMatch(r.out, /처리하지 못한 오류/, r.out);
  assert.equal(origin(f.market), ORIGIN, "the pin is undone");
  assert.match(read(join(f.cache, "5.6.1", "hooks", "hooks.json")), /PostToolUse/, "the active hooks.json is reverted");
  assert.equal(r.code, 0, r.out);
});

test("a revert over a version folder whose scripts is a file names it and counts it, and still undoes the pin", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  const odd = join(f.cache, "5.5.0");
  mkdirSync(join(odd, "hooks"), { recursive: true });
  writeFileSync(join(odd, "scripts"), "not a folder\n");
  const r = run(f.home, ["--revert"]);
  assert.doesNotMatch(r.out, /처리하지 못한 오류/, r.out);
  assert.match(r.out, /scripts/);
  assert.equal(r.code, 1, r.out);
  assert.equal(origin(f.market), ORIGIN, "the pin is undone");
});

test("--revert over a PINNED whose host is an object ends with its last line and no crash", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  assert.equal(run(f.home, ["--no-update"]).code, 0);
  writeFileSync(pinPath(f), JSON.stringify({ pinnedAt: "x", version: "5.7.0", host: { toString: 1, valueOf: 1 } }) + "\n");
  const r = run(f.home, ["--revert"]);
  assert.doesNotMatch(r.out, /처리하지 못한 오류/, r.out);
  assert.match(r.out, /되돌리기 완료\./);
  assert.equal(r.code, 0, r.out);
});

test("an apply over a write-only hooks.json says it could not read it; a revert does not call it done", { skip: (process.platform === "win32" && "POSIX modes") || (asRoot && "root ignores modes") }, () => {
  const plug = bundle();
  const hj = join(plug, "hooks", "hooks.json");
  chmodSync(hj, 0o200);
  let a, r;
  try {
    a = run(bareHome(), ["--root", plug]);
    r = run(bareHome(), ["--root", plug, "--revert"]);
  } finally { chmodSync(hj, 0o644); }
  assert.match(a.out, /hooks\.json 을 읽지 못함 \(EACCES\)/, a.out);
  assert.doesNotMatch(r.out, /되돌리기 완료\./, r.out);
  assert.equal(r.code, 1, r.out);
});

// 0.20.4 B2 Task 2: a bare apply's switch line, a missing marketplace or git, and an installed_plugins.json of 0, false, "" or null (B2-14, B2-15, B2-16)
test("a bare apply that switches from an older active version names that version in its switch line", { skip: !HAS_GIT && "git not found" }, () => {
  const { f, target } = bareApplyFixture();
  assert.equal(run(f.home, []).code, 0);
  const installed = join(f.plugins, "installed_plugins.json");
  const j = JSON.parse(read(installed));
  Object.assign(j.plugins["oh-my-claudecode@omc"][0], { version: "5.6.1", installPath: join(f.cache, "5.6.1") });
  writeFileSync(installed, JSON.stringify(j, null, 2) + "\n");
  const r = run(f.home, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`ok  5\\.6\\.1 → ${target.replace(/\./g, "\\.")} \\(sha`), r.out);
});

test("a bare apply that would switch with no marketplace folder says the folder is missing, not the tag", { skip: !HAS_GIT && "git not found" }, () => {
  const { f } = bareApplyFixture();
  assert.equal(run(f.home, []).code, 0);
  const installed = join(f.plugins, "installed_plugins.json");
  const j = JSON.parse(read(installed));
  Object.assign(j.plugins["oh-my-claudecode@omc"][0], { version: "5.6.1", installPath: join(f.cache, "5.6.1") });
  writeFileSync(installed, JSON.stringify(j, null, 2) + "\n");
  renameSync(f.market, `${f.market}.gone`);
  const r = run(f.home, []);
  renameSync(`${f.market}.gone`, f.market);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /마켓플레이스 없음/, r.out);
  assert.doesNotMatch(r.out, /태그 v.* 를 마켓플레이스에서 찾을 수 없음/);
});

for (const value of ["0", "false", '""', "null"]) {
  test(`a bare apply over an installed_plugins.json that holds ${value} says why it stops`, { skip: !HAS_GIT && "git not found" }, () => {
    const { f } = bareApplyFixture();
    writeFileSync(join(f.plugins, "installed_plugins.json"), `${value}\n`);
    const r = run(f.home, []);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /installed_plugins\.json 에 oh-my-claudecode@omc 항목이 없음/, r.out);
  });
}
