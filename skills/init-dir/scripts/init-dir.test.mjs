// init-dir command line (plan 4.2, US-2 acceptance 2 to 9). Temp project folders and a temp HOME only.
// Run: node --test skills/init-dir/scripts/init-dir.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FOLDERS, templateFiles } from "./templates.mjs";

// Preload that makes fs.openSync throw for one file name (scripts/test-fixtures, not shipped).
const FAIL_OPEN = new URL("../../../scripts/test-fixtures/fail-open.mjs", import.meta.url).href;
// Preload that gives every Number stat one ino, as an NTFS file id past 2^53 can (scripts/test-fixtures, not shipped).
const SAME_INO = new URL("../../../scripts/test-fixtures/same-ino.mjs", import.meta.url).href;

const WIN = process.platform === "win32";
const CLI = fileURLToPath(new URL("./init-dir.mjs", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "init-dir-cli-"));
const home = join(base, "home");
mkdirSync(home);
after(() => rmSync(base, { recursive: true, force: true }));
const START = "<!-- banker:init-dir:start -->";
const POLICY_OPEN = "<!-- USER:OMX:POLICY:START -->";
const POLICY_CLOSE = "<!-- USER:OMX:POLICY:END -->";

let n = 0;
const project = () => {
  const d = join(base, `p${n++}`);
  mkdirSync(d);
  return d;
};
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: base, env: { ...process.env, HOME: home, USERPROFILE: home } });
const apply = (root, ...extra) => cli(["apply", "--root", root, ...extra]);
const read = (p) => readFileSync(p, "utf8");
const count = (text, needle) => text.split(needle).length - 1;

// Every entry under dir: kind, bytes or link target, mode.
function snapshot(dir, rel = "", out = {}) {
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(dir, r));
    if (st.isSymbolicLink()) out[r] = `link:${readlinkSync(join(dir, r))}`;
    else if (st.isDirectory()) snapshot(dir, r, Object.assign(out, { [r]: `dir:${st.mode}` }));
    else out[r] = `file:${st.mode}:${readFileSync(join(dir, r)).toString("base64")}`;
  }
  return out;
}

// Whether the file system under dir tells names apart by case.
function caseSensitive(dir) {
  const probe = join(dir, "CaseProbe");
  writeFileSync(probe, "");
  const sensitive = !existsSync(join(dir, "caseprobe"));
  rmSync(probe);
  return sensitive;
}
const SENSITIVE = caseSensitive(base);

function trySymlink(target, path) {
  try {
    symlinkSync(target, path);
    return true;
  } catch (e) {
    if (WIN && e.code === "EPERM") return false;
    throw e;
  }
}

test("--help: first line names the skill, exit 0", () => {
  const r = cli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout.split("\n")[0], /^init-dir: /);
});

test("usage errors exit 2: no --runtime, unknown argument, missing root", () => {
  const root = project();
  assert.equal(apply(root).status, 2);
  assert.equal(apply(root, "--runtime", "vim").status, 2);
  assert.equal(apply(root, "--runtime", "claude", "--bogus").status, 2);
  assert.equal(apply(join(root, "missing"), "--runtime", "claude").status, 2);
  assert.deepEqual(readdirSync(root), []);
});

test("root is HOME or a file system root: exit 3", () => {
  assert.equal(apply(home, "--runtime", "claude").status, 3);
  assert.deepEqual(readdirSync(home), []);
  const fsRoot = WIN ? `${process.cwd().slice(0, 3)}` : "/";
  assert.equal(cli(["status", "--root", fsRoot]).status, 3);
});

test("root is HOME spelled in another case where case is ignored: exit 3, nothing made", (t) => {
  const other = join(base, "HOME");
  if (!existsSync(other)) return t.skip("대소문자를 가리는 파일 시스템: 다른 철자는 다른 폴더");
  assert.equal(apply(other, "--runtime", "claude").status, 3);
  assert.deepEqual(readdirSync(home), []);
});

test("AC2: empty folder, --runtime claude makes 7 folders, every template and CLAUDE.md with one block; rerun is byte-identical", () => {
  const root = project();
  const r = apply(root, "--runtime", "claude");
  assert.equal(r.status, 0, r.stderr);
  for (const f of FOLDERS) {
    assert.ok(lstatSync(join(root, f)).isDirectory(), f);
    for (const t of templateFiles(f)) assert.ok(readFileSync(join(root, ...t.rel.split("/"))).equals(t.data), t.rel);
  }
  assert.equal(count(read(join(root, "CLAUDE.md")), START), 1);
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
  const before = snapshot(root);
  const again = apply(root, "--runtime", "claude");
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(snapshot(root), before);
  assert.match(again.stdout, /\| `CLAUDE\.md` \| 변경 없음 \|/);
});

test("AC3: both files get the block; AGENTS.md in its own policy pair, the old policy block byte for byte", () => {
  const root = project();
  const agents = `# agents\n${POLICY_OPEN}\nkeep me\n${POLICY_CLOSE}\n`;
  writeFileSync(join(root, "AGENTS.md"), agents);
  writeFileSync(join(root, "CLAUDE.md"), "# claude\n");
  assert.equal(apply(root, "--runtime", "claude").status, 0);
  const a = read(join(root, "AGENTS.md"));
  assert.ok(a.startsWith(agents));
  const tail = a.slice(agents.length);
  assert.ok(tail.startsWith(`\n${POLICY_OPEN}\n${START}\n`), tail.slice(0, 80));
  assert.ok(tail.endsWith(`<!-- banker:init-dir:end -->\n${POLICY_CLOSE}\n`));
  const c = read(join(root, "CLAUDE.md"));
  assert.equal(count(c, START), 1);
  assert.equal(c.includes(POLICY_OPEN), false);
});

test("AC3: two files whose Number ino is the same (NTFS ids past 2^53) both get the block", () => {
  const root = project();
  writeFileSync(join(root, "AGENTS.md"), "# agents\n");
  writeFileSync(join(root, "CLAUDE.md"), "# claude\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const r = spawnSync(process.execPath, ["--import", SAME_INO, CLI, "apply", "--root", root, "--runtime", "claude"], { encoding: "utf8", cwd: base, env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(read(join(root, "AGENTS.md")), START), 1);
  assert.equal(count(read(join(root, "CLAUDE.md")), START), 1, r.stdout);
});

test("AC3: neither file and --runtime codex makes AGENTS.md only", () => {
  const root = project();
  assert.equal(apply(root, "--runtime", "codex").status, 0);
  assert.equal(existsSync(join(root, "CLAUDE.md")), false);
  const a = read(join(root, "AGENTS.md"));
  assert.ok(a.startsWith(`${POLICY_OPEN}\n${START}\n`));
});

test("AC4: CLAUDE.md links to AGENTS.md: exit 1 and nothing changes; --follow-symlink writes one block into AGENTS.md", (t) => {
  const root = project();
  writeFileSync(join(root, "AGENTS.md"), "# agents\n");
  if (!trySymlink("AGENTS.md", join(root, "CLAUDE.md"))) return t.skip("Windows: 심볼릭 링크를 만들 권한 없음(개발자 모드 꺼짐)");
  const before = snapshot(root);
  const r = apply(root, "--runtime", "claude");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /심볼릭 링크/);
  assert.deepEqual(snapshot(root), before);
  const f = apply(root, "--runtime", "claude", "--follow-symlink");
  assert.equal(f.status, 0, f.stderr);
  const a = read(join(root, "AGENTS.md"));
  assert.equal(count(a, START), 1);
  assert.equal(count(a, POLICY_OPEN), 1);
  assert.equal(lstatSync(join(root, "CLAUDE.md")).isSymbolicLink(), true);
  assert.match(f.stdout, /\| `CLAUDE\.md` \| 같은 파일이라 한 번만 씀 \|/);
});

test("AC5: an existing logs/ gets no template, only its purpose", () => {
  const root = project();
  mkdirSync(join(root, "logs"));
  writeFileSync(join(root, "logs", "old.log"), "old\n");
  writeFileSync(join(root, "logs", "notes.txt"), "n\n");
  const r = apply(root, "--runtime", "claude");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(join(root, "logs")).sort(), ["notes.txt", "old.log"]);
  assert.match(r.stdout, /\| `logs\/` \| 있음\(목적만 전달\) \|/);
  assert.match(read(join(root, "CLAUDE.md")), /- `logs\/`: /);
});

test("a template write failing midway leaves neither the folder nor the temp folder; the rerun makes the whole folder", () => {
  const root = project();
  const env = { ...process.env, HOME: home, USERPROFILE: home, FAIL_OPEN_AT: "stop.sh" };
  const r = spawnSync(process.execPath, ["--import", FAIL_OPEN, CLI, "apply", "--root", root, "--runtime", "claude", "--only=logs,scripts"], { encoding: "utf8", cwd: base, env });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /^init-dir: 쓰기 실패: 주입한 실패: .*\.scripts\.init-dir-[0-9a-f]{12}[\\/]stop\.sh/);
  assert.deepEqual(readdirSync(root).sort(), ["logs"], "scripts/ 도 .scripts.init-dir-* 도 없음. 앞서 끝난 logs/ 는 완전함");
  assert.deepEqual(readdirSync(join(root, "logs")).sort(), [".gitignore", "README.md"]);
  const again = apply(root, "--runtime", "claude", "--only=logs,scripts");
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /\| `scripts\/` \| 만듦 \|/);
  const want = templateFiles("scripts").map((f) => f.rel);
  for (const rel of want) assert.ok(existsSync(join(root, ...rel.split("/"))), rel);
  assert.equal(readdirSync(root).filter((x) => x.includes(".init-dir-")).length, 0);
});

test("a temp folder left by a killed run: status and apply report it as removable and leave it in place", () => {
  const root = project();
  const left = join(root, ".scripts.init-dir-0123456789ab");
  mkdirSync(left);
  writeFileSync(join(left, "start.sh"), "#!/bin/sh\n");
  mkdirSync(join(root, ".notes.init-dir-0123456789ab"));
  writeFileSync(join(root, ".logs.init-dir-abcdef"), "a file, not a folder\n");
  const line = `남은 임시 폴더: ${left} (지워도 됨)`;
  const st = cli(["status", "--root", root]);
  assert.equal(st.status, 0, st.stderr);
  assert.deepEqual(st.stdout.split("\n").filter((l) => l.startsWith("남은 임시 폴더")), [line]);
  assert.deepEqual(JSON.parse(cli(["status", "--root", root, "--json"]).stdout).warnings, [line]);
  const r = apply(root, "--runtime", "claude", "--only=scripts");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").filter((l) => l.startsWith("남은 임시 폴더")), [line]);
  assert.ok(existsSync(join(left, "start.sh")), "not removed");
  assert.ok(existsSync(join(root, "scripts", "lib", "service.mjs")));
  assert.doesNotMatch(cli(["status", "--root", project()]).stdout, /남은 임시 폴더/);
});

test("AC6: --only=logs,KB makes two folders; the block lists every managed folder on disk", () => {
  const root = project();
  mkdirSync(join(root, "docs"));
  const r = apply(root, "--runtime", "claude", "--only=logs,KB");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(root).sort(), ["CLAUDE.md", "KB", "docs", "logs"].sort());
  const block = read(join(root, "CLAUDE.md"));
  for (const f of ["logs", "docs", "KB"]) assert.match(block, new RegExp(`- \`${f}/\`: `));
  assert.equal(block.includes("- `scripts/`"), false);
});

test("AC6: --only=kb is KB; an unknown name exits 2 and makes nothing", () => {
  const root = project();
  assert.equal(apply(root, "--runtime", "claude", "--only=kb").status, 0);
  assert.ok(readdirSync(root).includes("KB"));
  const other = project();
  const r = apply(other, "--runtime", "claude", "--only=logs,bogus");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bogus/);
  assert.deepEqual(readdirSync(other), []);
});

test("AC7: case-sensitive file system, only Agents.md: exit 3, a warning, nothing made", { skip: !SENSITIVE && "대소문자 구분 파일 시스템 전용" }, () => {
  const root = project();
  writeFileSync(join(root, "Agents.md"), "mixed case\n");
  const r = apply(root, "--runtime", "codex");
  assert.equal(r.status, 3);
  assert.match(r.stderr, /경고: 대소문자가 다른 지시 파일만 있음: Agents\.md/);
  assert.deepEqual(readdirSync(root), ["Agents.md"]);
  assert.equal(read(join(root, "Agents.md")), "mixed case\n");
});

test("AC7: case-insensitive file system, only Agents.md: the block goes into the file under its own name", { skip: SENSITIVE && "대소문자 무시 파일 시스템 전용(macOS, Windows)" }, () => {
  const root = project();
  writeFileSync(join(root, "Agents.md"), "mixed case\n");
  const r = apply(root, "--runtime", "codex");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readdirSync(root).includes("Agents.md"));
  assert.equal(readdirSync(root).includes("AGENTS.md"), false);
  assert.equal(count(read(join(root, "Agents.md")), START), 1);
});

test("AC8: AGENTS.override.md with text of its own: a warning line, the override untouched", () => {
  const root = project();
  writeFileSync(join(root, "AGENTS.override.md"), "override rules\n");
  const r = apply(root, "--runtime", "codex");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^경고: AGENTS\.override\.md 에 내용이 있음/m);
  assert.equal(read(join(root, "AGENTS.override.md")), "override rules\n");
  const quiet = project();
  writeFileSync(join(quiet, "AGENTS.override.md"), "  \n");
  assert.equal(apply(quiet, "--runtime", "codex").stdout.includes("경고:"), false);
});

test("AC9: the output ends with the purpose summary; --json is one JSON line; --dry-run changes nothing", () => {
  const root = project();
  const dry = apply(root, "--runtime", "claude", "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(readdirSync(root), []);
  assert.match(dry.stdout, /dry-run/);
  const text = apply(root, "--runtime", "claude").stdout.trimEnd().split("\n");
  const at = text.indexOf("폴더 목적 요약");
  assert.ok(at > 0);
  assert.equal(text.length - at - 1, FOLDERS.length);
  assert.ok(text.slice(at + 1).every((l) => l.startsWith("- `")));
  const j = apply(root, "--runtime", "claude", "--json");
  assert.equal(j.stdout.trimEnd().split("\n").length, 1);
  const rep = JSON.parse(j.stdout);
  assert.equal(rep.ok, true);
  assert.deepEqual(rep.summary.map((s) => s.folder), FOLDERS);
  assert.ok(rep.folders.every((f) => f.status === "exists"));
  const jdry = JSON.parse(apply(project(), "--runtime", "codex", "--json", "--dry-run").stdout);
  assert.equal(jdry.dryRun, true);
  assert.ok(jdry.folders.every((f) => f.status === "planned"));
  assert.deepEqual(jdry.instructions, [{ file: "AGENTS.md", status: "created" }]);
});

test("refusals change nothing: broken markers in CLAUDE.md, a file where a folder goes", () => {
  const root = project();
  writeFileSync(join(root, "CLAUDE.md"), "<!-- banker:init-dir:end -->\n");
  const before = snapshot(root);
  const r = apply(root, "--runtime", "claude");
  assert.equal(r.status, 1);
  assert.deepEqual(snapshot(root), before);
  const other = project();
  writeFileSync(join(other, "logs"), "a file\n");
  const before2 = snapshot(other);
  const j = apply(other, "--runtime", "claude", "--json");
  assert.equal(j.status, 1);
  assert.equal(JSON.parse(j.stdout).ok, false);
  assert.deepEqual(snapshot(other), before2);
});

test("status reports folders and block state without writing", () => {
  const root = project();
  const before = cli(["status", "--root", root, "--json"]);
  assert.equal(before.status, 0);
  assert.deepEqual(readdirSync(root), []);
  apply(root, "--runtime", "claude", "--only=docs");
  const rep = JSON.parse(cli(["status", "--root", root, "--json"]).stdout);
  assert.deepEqual(rep.instructions, [{ file: "CLAUDE.md", status: "current" }]);
  assert.equal(rep.folders.find((f) => f.name === "docs").status, "exists");
  mkdirSync(join(root, "work"));
  const stale = JSON.parse(cli(["status", "--root", root, "--json"]).stdout);
  assert.deepEqual(stale.instructions, [{ file: "CLAUDE.md", status: "stale" }]);
});

// US-9: the docs purpose and docs/evidence/, docs/adr/.
const OLD_DOCS = "- `docs/`: 문서를 관리하는 영역";
const NEW_DOCS = "- `docs/`: 문서를 관리하는 영역. evidence와 ADR도 포함하여 보관한다.";
// The block commit 558ce77 wrote for a project with docs/ only (byte for byte).
const OLD_BLOCK = [
  START,
  "## 프로젝트 폴더 (banker init-dir)",
  "",
  "이 프로젝트의 관리 폴더와 목적. 해당하는 파일은 그 폴더에 둔다. 이 블록은 init-dir 이 다시 쓴다(직접 고치지 않음).",
  "",
  OLD_DOCS,
  "<!-- banker:init-dir:end -->",
  "",
].join("\n");
const OLD_DOCS_README = "# docs\n\n프로젝트 문서를 관리하는 폴더. banker init-dir 이 만든 틀이다.\n\n- 설계, 사용법, 운영 절차, 결정 기록을 둔다\n- 문서 하나에 주제 하나. 파일 이름은 주제를 드러내게 짓는다\n";

test("US-9 AC2: empty folder, --only=docs makes docs/README.md, empty evidence/.gitkeep and adr/.gitkeep; the block has the new docs line", () => {
  const root = project();
  const r = apply(root, "--runtime", "claude", "--only=docs");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(read(join(root, "docs", "README.md")).includes("`docs/adr/`"));
  for (const keep of [["evidence", ".gitkeep"], ["adr", ".gitkeep"]]) assert.equal(readFileSync(join(root, "docs", ...keep)).length, 0, keep.join("/"));
  assert.match(r.stdout, /\| `docs\/evidence\/\.gitkeep` \| 만듦 \|/);
  const claude = read(join(root, "CLAUDE.md"));
  assert.equal(count(claude, NEW_DOCS), 1);
  assert.equal(claude.split("\n").includes(OLD_DOCS), false);
});

test("US-9 AC3: an existing docs/ with a file gets no evidence/ or adr/, only its purpose", () => {
  const root = project();
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "design.md"), "# design\n");
  const r = apply(root, "--runtime", "claude");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(join(root, "docs")), ["design.md"]);
  assert.match(r.stdout, /\| `docs\/` \| 있음\(목적만 전달\) \|/);
  assert.match(read(join(root, "CLAUDE.md")), new RegExp(`^${NEW_DOCS.replace(/[.()`]/g, "\\$&")}$`, "m"));
});

test("US-9 AC4: an old 558ce77 block in CLAUDE.md and AGENTS.md: --only=docs changes only the docs line; the second run changes no byte", () => {
  const root = project();
  const oldClaude = `# claude\n\n${OLD_BLOCK}`;
  const oldAgents = `# mine\n${POLICY_OPEN}\nkeep me\n${POLICY_CLOSE}\n\n${POLICY_OPEN}\n${OLD_BLOCK}${POLICY_CLOSE}\n`;
  writeFileSync(join(root, "CLAUDE.md"), oldClaude);
  writeFileSync(join(root, "AGENTS.md"), oldAgents);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "README.md"), OLD_DOCS_README);
  const r = apply(root, "--runtime", "claude", "--only=docs");
  assert.equal(r.status, 0, r.stderr);
  const swap = (text) => text.replace(`\n${OLD_DOCS}\n`, `\n${NEW_DOCS}\n`);
  assert.equal(read(join(root, "CLAUDE.md")), swap(oldClaude));
  assert.equal(read(join(root, "AGENTS.md")), swap(oldAgents));
  assert.equal(count(read(join(root, "AGENTS.md")), POLICY_OPEN), 2);
  assert.equal(read(join(root, "docs", "README.md")), OLD_DOCS_README);
  assert.deepEqual(readdirSync(join(root, "docs")), ["README.md"]);
  const before = snapshot(root);
  const again = apply(root, "--runtime", "claude", "--only=docs");
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(snapshot(root), before);
  assert.match(again.stdout, /\| `AGENTS\.md` \| 변경 없음 \|/);
  assert.match(again.stdout, /\| `CLAUDE\.md` \| 변경 없음 \|/);
  assert.equal(again.stdout.includes("만듦"), false);
});

test("US-9 AC5: the purpose summary and --json carry the new docs purpose", () => {
  const root = project();
  const text = apply(root, "--runtime", "claude", "--only=docs").stdout.trimEnd().split("\n");
  assert.deepEqual(text.slice(text.indexOf("폴더 목적 요약") + 1), [NEW_DOCS]);
  const rep = JSON.parse(apply(root, "--runtime", "claude", "--json").stdout);
  assert.equal(rep.summary.find((s) => s.folder === "docs").purpose, "문서를 관리하는 영역. evidence와 ADR도 포함하여 보관한다.");
});
