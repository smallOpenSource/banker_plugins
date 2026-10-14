// Tests for omc-patch.mjs. Run from the repo root: node --test skills/omc-patch/scripts/omc-patch.test.mjs
// No network and no real home: every run uses a fake HOME in a temp dir.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
// case it is given, so this does not prove the lower-casing in insideRoot by itself.
test("on Windows a --root given in other letter case is the same folder", { skip: process.platform !== "win32" && "Windows only" }, () => {
  const home = bareHome();
  const plug = bundle();
  const other = plug === plug.toUpperCase() ? plug.toLowerCase() : plug.toUpperCase();
  const r = run(home, ["--root", other]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /패치 2건 \/ 실패 0건/);
});

// The bare apply (no --no-update) path: the tool unpacks its TARGET_VERSION from the marketplace tag,
// links node_modules to the previous version, switches installed_plugins.json and patches the new folder.
test("a bare apply installs TARGET_VERSION from the marketplace tag, switches to it and patches it", { skip: !HAS_GIT && "git not found" }, () => {
  const f = fakeHome([{ v: "5.6.1", active: true }]);
  // a local path that does not exist, so the tool's git fetch fails at once without the network
  const nowhere = join(root, `no-remote${seq++}.git`);
  assert.equal(runGit(["remote", "set-url", "origin", nowhere], f.market).status, 0);
  const target = /const TARGET_VERSION = "([\d.]+)"/.exec(read(TOOL))[1];
  mkdirSync(join(f.market, "hooks"), { recursive: true });
  mkdirSync(join(f.market, "scripts"), { recursive: true });
  writeFileSync(join(f.market, "hooks", "hooks.json"), HOOKS_JSON);
  for (const n of ["foo", "stopper"]) writeFileSync(join(f.market, "scripts", `${n}.mjs`), SCRIPT(n));
  writeFileSync(join(f.market, "scripts", "lib.mjs"), LIB);
  mkdirSync(join(f.cache, "5.6.1", "node_modules"), { recursive: true });
  const id = ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];
  for (const a of [["add", "-A"], [...id, "commit", "-qm", "v"], [...id, "tag", `v${target}`]]) {
    const g = runGit(a, f.market);
    assert.equal(g.status, 0, g.stderr);
  }
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

// The tool keeps its own copy of git's list. A newer git that adds a variable must make this fail.
test("the tool's list of repository variables covers this git's --local-env-vars", { skip: !HAS_GIT && "git not found" }, () => {
  const listed = /const GIT_REPO_VARS = new Set\(\[([\s\S]*?)\]\)/.exec(read(TOOL))[1];
  const names = new Set([...listed.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]));
  const local = runGit(["rev-parse", "--local-env-vars"], root).stdout.split(/\s+/).filter(Boolean);
  assert.ok(local.includes("GIT_DIR"), local.join(" "));
  assert.deepEqual(local.filter((v) => !names.has(v)), []);
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
