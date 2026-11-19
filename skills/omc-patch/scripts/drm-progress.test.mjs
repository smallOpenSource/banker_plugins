// Tests for drm-progress.mjs. Run from the repo root: node --test skills/omc-patch/scripts/drm-progress.test.mjs
// No real home: every run that reads the plugin cache uses a fake HOME in a temp dir.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { symlinkSkip } from "../../../scripts/test-fixtures/can-symlink.mjs";
import { stateOf, transform } from "./drm-progress.mjs";

const TOOL = fileURLToPath(new URL("./drm-progress.mjs", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "drm-progress-test-"));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;

// The three files as OMC 5.8.4 ships them, cut down to the lines the patch reads, plus a working progress module.
const PROGRESS_JS = `import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
export const PROGRESS_FILENAME = 'progress.txt';
/** Find progress.txt in a directory */
export function initProgress(d) {
  mkdirSync(join(d, '.omc'), { recursive: true });
  const p = join(d, '.omc', PROGRESS_FILENAME);
  if (!existsSync(p)) writeFileSync(p, '# Ralph Progress Log\\n');
  return p;
}
`;
const CLI_CJS = `"use strict";
var PROGRESS_FILENAME;
var init_progress = () => {
    PROGRESS_FILENAME = "progress.txt";
};
init_progress();
module.exports = { PROGRESS_FILENAME };
`;
const SKILL_MD = "Track progress in `progress.txt`.\nb. Record progress in `progress.txt`: what was done\n- [ ] progress.txt records learnings\n";
const FILES = { "dist/hooks/ralph/progress.js": PROGRESS_JS, "bridge/cli.cjs": CLI_CJS, "skills/ralph/SKILL.md": SKILL_MD };

function plugin(dir, { files = FILES, name = "oh-my-claude-sisyphus" } = {}) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, type: "module" }));
  return dir;
}

const fresh = (opts) => plugin(join(base, `p${n++}`), opts);
const run = (args, env = {}) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const snapshot = (root) => Object.fromEntries(Object.keys(FILES).map((rel) => [rel, existsSync(join(root, rel)) ? read(root, rel) : null]));
const backups = (root) => Object.keys(FILES).filter((rel) => existsSync(join(root, `${rel}.omcbak`)));

test("transform changes the one constant and every name in the instructions", () => {
  assert.equal(transform("x PROGRESS_FILENAME = 'progress.txt';", true), "x PROGRESS_FILENAME = 'progress.md';");
  assert.equal(transform('PROGRESS_FILENAME = "progress.txt";', true), 'PROGRESS_FILENAME = "progress.md";');
  assert.equal(transform("// progress.txt only in a comment", true), null);
  assert.equal(transform("PROGRESS_FILENAME = 'progress.txt'; PROGRESS_FILENAME = 'progress.txt';", true), null);
  assert.equal(transform("PROGRESS_FILENAME = 'progress.txt\";", true), null);
  assert.equal(transform(SKILL_MD, false), SKILL_MD.replaceAll("progress.txt", "progress.md"));
  assert.equal(transform("my-progress.txt and progress.txtx", false), null);
});

test("stateOf tells the original, the patched file and a shape it does not know", () => {
  assert.equal(stateOf(PROGRESS_JS, true), "original");
  assert.equal(stateOf(transform(PROGRESS_JS, true), true), "patched");
  assert.equal(stateOf("export const X = 1;", true), "unknown");
  assert.equal(stateOf(transform(SKILL_MD, false), false), "patched");
  assert.equal(stateOf("nothing here", false), "unknown");
});

test("apply patches all three files, keeps the originals, and the module then writes progress.md", async () => {
  const root = fresh();
  const r = run(["--root", root]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /완료\. 실패 0건\./);
  assert.match(read(root, "dist/hooks/ralph/progress.js"), /PROGRESS_FILENAME = 'progress\.md'/);
  assert.match(read(root, "bridge/cli.cjs"), /PROGRESS_FILENAME = "progress\.md"/);
  assert.doesNotMatch(read(root, "skills/ralph/SKILL.md"), /progress\.txt/);
  assert.deepEqual(backups(root), Object.keys(FILES));
  for (const [rel, text] of Object.entries(FILES)) assert.equal(read(root, `${rel}.omcbak`), text);
  const project = join(base, `proj${n++}`);
  const m = await import(pathToFileURL(join(root, "dist/hooks/ralph/progress.js")).href);
  assert.equal(m.initProgress(project), join(project, ".omc", "progress.md"));
  assert.deepEqual(readdirSync(join(project, ".omc")), ["progress.md"]);
  const check = run(["--root", root, "--check"]);
  assert.match(check.stdout, /결과: 적용된 상태입니다\./);
});

test("a second apply changes nothing", () => {
  const root = fresh();
  run(["--root", root]);
  const before = snapshot(root);
  const r = run(["--root", root]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /이미 적용됨/);
  assert.deepEqual(snapshot(root), before);
});

test("check reads only and says the patch is missing", () => {
  const root = fresh();
  const r = run(["--root", root, "--check"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /결과: 적용되지 않았습니다\./);
  assert.deepEqual(snapshot(root), FILES);
  assert.deepEqual(backups(root), []);
});

test("revert restores the exact originals and removes the backups", () => {
  const root = fresh();
  run(["--root", root]);
  const r = run(["--root", root, "--revert"]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /되돌리기 완료\./);
  assert.deepEqual(snapshot(root), FILES);
  assert.deepEqual(backups(root), []);
});

test("a missing file stops the patch: hooks and CLI would use different names", () => {
  const files = { ...FILES };
  delete files["bridge/cli.cjs"];
  const root = fresh({ files });
  const r = run(["--root", root]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /일부가 없어 고치지 않음/);
  assert.equal(read(root, "dist/hooks/ralph/progress.js"), PROGRESS_JS);
  assert.deepEqual(backups(root), []);
  assert.match(run(["--root", root, "--check"]).stdout, /결과: 세 파일 중 일부가 없어/);
});

test("a version without the ralph progress code has nothing to do", () => {
  const root = fresh({ files: {} });
  const r = run(["--root", root]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /할 일 없음/);
  assert.match(run(["--root", root, "--check"]).stdout, /결과: 이 판에는 ralph 진행 기록 코드가 없어/);
});

test("a shape it does not know changes no file", () => {
  const root = fresh({ files: { ...FILES, "bridge/cli.cjs": `${CLI_CJS}\nPROGRESS_FILENAME = "progress.txt";\n` } });
  const before = snapshot(root);
  const r = run(["--root", root]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /bridge\/cli\.cjs: 처음 보는 모양/);
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(backups(root), []);
});

test("a syntax error after the patch rolls every file back", () => {
  const root = fresh({ files: { ...FILES, "bridge/cli.cjs": 'PROGRESS_FILENAME = "progress.txt";\nfunction (' } });
  const before = snapshot(root);
  const r = run(["--root", root]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /문법 오류/);
  assert.deepEqual(snapshot(root), before);
});

test("a link to a file outside the plugin folder is not written", { skip: symlinkSkip }, () => {
  const root = fresh();
  const outside = join(base, `outside${n++}.md`);
  writeFileSync(outside, SKILL_MD);
  rmSync(join(root, "skills/ralph/SKILL.md"));
  symlinkSync(outside, join(root, "skills/ralph/SKILL.md"), "file");
  const r = run(["--root", root]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /링크가 플러그인 폴더 밖을 가리킴/);
  assert.equal(readFileSync(outside, "utf8"), SKILL_MD);
  assert.equal(read(root, "dist/hooks/ralph/progress.js"), PROGRESS_JS);
});

test("an old backup that differs from the current original is replaced by the current original", () => {
  const root = fresh();
  writeFileSync(join(root, "bridge/cli.cjs.omcbak"), "old original\n");
  const r = run(["--root", root]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /옛 백업을 지금 원본으로 바꿈: bridge\/cli\.cjs/);
  assert.equal(read(root, "bridge/cli.cjs.omcbak"), CLI_CJS);
});

test("revert reverts none of the three when the user changed one after the patch", () => {
  const root = fresh();
  run(["--root", root]);
  const edited = `${read(root, "skills/ralph/SKILL.md")}\nmy note\n`;
  writeFileSync(join(root, "skills/ralph/SKILL.md"), edited);
  const before = snapshot(root);
  const r = run(["--root", root, "--revert"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /되돌리지 않음: skills\/ralph\/SKILL\.md/);
  assert.match(r.stdout, /되돌리기를 끝내지 못했습니다\./);
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(backups(root), Object.keys(FILES));
});

test("revert reverts none when a patched file has no backup: the names would split", () => {
  const root = fresh();
  run(["--root", root]);
  rmSync(join(root, "bridge/cli.cjs.omcbak"));
  const before = snapshot(root);
  const r = run(["--root", root, "--revert"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /되돌리지 않음: bridge\/cli\.cjs \(백업이 없어/);
  assert.deepEqual(snapshot(root), before);
});

const canChmod = process.platform !== "win32" && !(typeof process.getuid === "function" && process.getuid() === 0);
test("a write error during revert puts back what it reverted and ends with the failure line", { skip: !canChmod && "needs POSIX modes and a non-root account" }, () => {
  const root = fresh();
  run(["--root", root]);
  const before = snapshot(root);
  chmodSync(join(root, "bridge"), 0o555);
  try {
    const r = run(["--root", root, "--revert"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /되돌리지 못함: bridge\/cli\.cjs/);
    assert.match(r.stdout, /되돌리기를 끝내지 못했습니다\./);
    assert.equal(r.stderr, "");
    assert.deepEqual(snapshot(root), before);
  } finally { chmodSync(join(root, "bridge"), 0o755); }
});

test("revert of a version where a new original replaced the patched file leaves the old backup without failing", () => {
  const root = fresh();
  run(["--root", root]);
  const newer = CLI_CJS.replace("init_progress();", "init_progress(); // newer");
  for (const [rel, text] of [["bridge/cli.cjs", newer], ["dist/hooks/ralph/progress.js", PROGRESS_JS], ["skills/ralph/SKILL.md", SKILL_MD]]) writeFileSync(join(root, rel), text);
  const r = run(["--root", root, "--revert"]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /bridge\/cli\.cjs: 이미 원본\. 옛 백업이 남음/);
  assert.equal(read(root, "bridge/cli.cjs"), newer);
});

test("a link at a backup spot is refused, and a dangling one does not crash the check", { skip: symlinkSkip }, () => {
  const root = fresh();
  symlinkSync(join(root, "dist/hooks/ralph/progress.js"), join(root, "bridge/cli.cjs.omcbak"), "file");
  const r = run(["--root", root]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /bridge\/cli\.cjs: 쓰지 않음 \(백업 자리\(\.omcbak\)가 링크임\)/);
  assert.deepEqual(snapshot(root), FILES);
  const root2 = fresh();
  symlinkSync(join(root2, "nowhere"), join(root2, "skills/ralph/SKILL.md.omcbak"), "file");
  const c = run(["--root", root2, "--check"]);
  assert.equal(c.status, 1);
  assert.equal(c.stderr, "");
  assert.match(c.stdout, /결과: 고칠 수 없는 파일이 있습니다/);
});

test("a folder of another plugin is refused", () => {
  const root = fresh({ name: "something-else" });
  const r = run(["--root", root]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /OMC 플러그인 폴더가 아님 \(something-else\)/);
  assert.deepEqual(snapshot(root), FILES);
});

test("unknown arguments and --check with --revert do nothing", () => {
  const root = fresh();
  for (const args of [["--bogus"], ["--check", "--revert", "--root", root], ["--root"]]) {
    const r = run(args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stdout, /사용법:/);
  }
  assert.deepEqual(snapshot(root), FILES);
});

test("without --root it patches the active version and revert walks every version folder once", { skip: symlinkSkip }, () => {
  const home = join(base, `home${n++}`);
  const cache = join(home, ".claude", "plugins", "cache", "omc", "oh-my-claudecode");
  const active = plugin(join(cache, "5.8.4"));
  const other = plugin(join(cache, "5.7.0"));
  symlinkSync(active, join(cache, "5.6.0"), "dir");
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ plugins: { "oh-my-claudecode@omc": [{ installPath: active, version: "5.8.4" }] } }));
  const env = { HOME: home, USERPROFILE: home };
  assert.match(run(["--check"], env).stdout, /결과: 적용되지 않았습니다\./);
  const r = run([], env);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(backups(active), Object.keys(FILES));
  assert.deepEqual(snapshot(other), FILES);
  const back = run(["--revert"], env);
  assert.equal(back.status, 0, back.stdout);
  assert.equal((back.stdout.match(/되돌림: dist/g) || []).length, 1);
  assert.deepEqual(snapshot(active), FILES);
});

test("without an installed OMC entry it stops before writing", () => {
  const home = join(base, `home${n++}`);
  mkdirSync(home, { recursive: true });
  const r = run([], { HOME: home, USERPROFILE: home });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /활성 OMC 판을 installed_plugins\.json 에서 찾지 못함/);
});

test("check tells whether the anti-drm settings deny .txt", () => {
  const root = fresh();
  const cfg = join(base, `anti-drm${n++}.json`);
  assert.match(run(["--root", root, "--check"], { BANKER_ANTI_DRM_CONFIG: cfg }).stdout, /anti-drm: 설정 없음/);
  writeFileSync(cfg, JSON.stringify({ version: 1, deny: [".TXT", ".pdf"], alt: [".md"] }));
  assert.match(run(["--root", root, "--check"], { BANKER_ANTI_DRM_CONFIG: cfg }).stdout, /anti-drm: \.txt 금지함 \(/);
  writeFileSync(cfg, `\uFEFF${JSON.stringify({ version: 1, deny: ["txt"], alt: [".md"] })}`);
  assert.match(run(["--root", root, "--check"], { BANKER_ANTI_DRM_CONFIG: cfg }).stdout, /anti-drm: \.txt 금지함 \(/);
  writeFileSync(cfg, JSON.stringify({ version: 1, deny: [".pdf"], alt: [".md"] }));
  assert.match(run(["--root", root, "--check"], { BANKER_ANTI_DRM_CONFIG: cfg }).stdout, /anti-drm: \.txt 허용/);
  writeFileSync(cfg, "{");
  assert.match(run(["--root", root, "--check"], { BANKER_ANTI_DRM_CONFIG: cfg }).stdout, /anti-drm: 설정을 읽지 못함/);
});

test("a folder this account cannot enter is a refusal with a result line, not a crash", { skip: !canChmod && "needs POSIX modes and a non-root account" }, () => {
  const root = fresh();
  run(["--root", root]);
  const before = snapshot(root);
  chmodSync(join(root, "dist/hooks/ralph"), 0o000);
  try {
    const c = run(["--root", root, "--check"]);
    assert.equal(c.status, 1);
    assert.equal(c.stderr, "");
    assert.match(c.stdout, /dist\/hooks\/ralph\/progress\.js: 쓰지 않음 \(읽지 못함 \(EACCES\)\)/);
    assert.match(c.stdout, /결과: 고칠 수 없는 파일이 있습니다/);
    for (const args of [["--root", root, "--revert"], ["--root", root]]) {
      const r = run(args);
      assert.equal(r.status, 1, args.join(" "));
      assert.equal(r.stderr, "");
      assert.match(r.stdout, /되돌리기를 끝내지 못했습니다|완료\. 실패 1건\./);
    }
  } finally { chmodSync(join(root, "dist/hooks/ralph"), 0o755); }
  assert.deepEqual(snapshot(root), before);
});

// remains 0.29.0 #2: node runs a script reached through a link by its real path, so the old resolve() check never matched
// a linked argv[1] and the command exited 0 printing nothing. A junction on Windows needs no admin right.
test("run through a linked folder it still does its work, and importing it with a non-file argv[1] does not throw", () => {
  const link = join(base, `link${n++}`);
  symlinkSync(dirname(TOOL), link, "junction");
  const r = spawnSync(process.execPath, [join(link, "drm-progress.mjs"), "--check", "--root", join(base, "no-such-folder")], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /폴더가 아님/);
  const imp = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(TOOL).href)})`, "no-such-file"], { encoding: "utf8" });
  assert.equal(imp.status, 0, imp.stderr);
  assert.equal(imp.stdout + imp.stderr, "");
});
