// Template files and folder purposes (plan 4.2 folder table). Temp folders only.
// Run: node --test skills/init-dir/scripts/templates.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FOLDERS, PURPOSES, blockBody, summaryLines, templateFiles, writeTemplates } from "./templates.mjs";

const WIN = process.platform === "win32";
const base = mkdtempSync(join(tmpdir(), "init-dir-templates-"));
after(() => rmSync(base, { recursive: true, force: true }));

const EXPECTED = {
  logs: ["logs/README.md", "logs/.gitignore"],
  scripts: [
    "scripts/start.sh",
    "scripts/stop.sh",
    "scripts/status.sh",
    "scripts/restart.sh",
    "scripts/start.cmd",
    "scripts/stop.cmd",
    "scripts/status.cmd",
    "scripts/restart.cmd",
    "scripts/service.conf",
    "scripts/lib/service.mjs",
    "scripts/README.md",
  ],
  work: ["work/README.md"],
  mockup: ["mockup/README.md"],
  tests: ["tests/run.sh", "tests/run.cmd", "tests/run.mjs", "tests/tests.conf", "tests/README.md", "tests/unit/.gitkeep", "tests/integration/.gitkeep"],
  docs: ["docs/README.md", "docs/evidence/.gitkeep", "docs/adr/.gitkeep"],
  KB: ["KB/README.md"],
};

test("seven managed folders, each with a purpose and its template files", () => {
  assert.deepEqual(FOLDERS, ["logs", "scripts", "work", "mockup", "tests", "docs", "KB"]);
  for (const f of FOLDERS) {
    assert.ok(PURPOSES[f].length > 0, f);
    assert.deepEqual(templateFiles(f).map((t) => t.rel), EXPECTED[f], f);
  }
  assert.throws(() => templateFiles("nope"), /unknown folder/);
});

test(".cmd files are CRLF, .sh files are LF with a POSIX sh shebang and mode 0755", () => {
  const all = FOLDERS.flatMap((f) => templateFiles(f));
  for (const t of all.filter((x) => x.rel.endsWith(".cmd"))) {
    const text = t.data.toString("utf8");
    assert.equal(/(?<!\r)\n/.test(text), false, `${t.rel}: lone LF`);
    assert.ok(text.endsWith("\r\n"), t.rel);
    assert.ok(text.startsWith("@echo off\r\n"), t.rel);
    assert.equal(t.mode, 0o644);
  }
  for (const t of all.filter((x) => x.rel.endsWith(".sh"))) {
    const text = t.data.toString("utf8");
    assert.equal(text.includes("\r"), false, `${t.rel}: CR`);
    assert.ok(text.startsWith("#!/bin/sh\n"), t.rel);
    assert.equal(t.mode, 0o755);
  }
});

test(".sh templates parse as sh", { skip: WIN && "sh 는 POSIX 전용" }, () => {
  const d = join(base, "syntax");
  mkdirSync(d);
  for (const t of FOLDERS.flatMap((f) => templateFiles(f)).filter((x) => x.rel.endsWith(".sh"))) {
    const p = join(d, t.rel.replace(/\//g, "_"));
    writeFileSync(p, t.data);
    const r = spawnSync("sh", ["-n", p], { encoding: "utf8" });
    assert.equal(r.status, 0, `${t.rel}: ${r.stderr}`);
  }
});

test("logs/.gitignore keeps logs out of git but keeps itself and the README", () => {
  const gi = templateFiles("logs").find((t) => t.rel === "logs/.gitignore");
  assert.equal(gi.data.toString("utf8"), "*\n!.gitignore\n!README.md\n");
  const readme = templateFiles("logs").find((t) => t.rel === "logs/README.md").data.toString("utf8");
  for (const rule of ["<이름>.out.log", "<이름>.err.log", "100MB", "최대 7개", "700MB"]) assert.ok(readme.includes(rule), rule);
});

test("service.conf fills name=app and leaves command= empty", () => {
  const conf = templateFiles("scripts").find((t) => t.rel === "scripts/service.conf").data.toString("utf8");
  const lines = conf.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(lines, ["name=app", "command="]);
});

test("work README warns about secrets and names the scans", () => {
  const text = templateFiles("work")[0].data.toString("utf8");
  assert.match(text, /비밀값\(키, 토큰, 비밀번호\)을 두지 말 것/);
  assert.match(text, /git-init/);
  assert.match(text, /audit-security/);
});

test("writeTemplates writes every file and never overwrites one", () => {
  const root = join(base, "write");
  mkdirSync(join(root, "scripts"), { recursive: true });
  const written = writeTemplates(root, "scripts");
  assert.deepEqual(written, EXPECTED.scripts);
  if (!WIN) assert.equal(statSync(join(root, "scripts", "start.sh")).mode & 0o777, 0o755);
  const tmplRoot = join(base, "existing");
  mkdirSync(join(tmplRoot, "docs"), { recursive: true });
  writeFileSync(join(tmplRoot, "docs", "README.md"), "mine\n");
  assert.throws(() => writeTemplates(tmplRoot, "docs"), { code: "EEXIST" });
  assert.equal(readFileSync(join(tmplRoot, "docs", "README.md"), "utf8"), "mine\n");
});

test("writeTemplates with dest writes the folder's files there and returns rel paths under the folder name", () => {
  const root = join(base, "dest");
  const dest = join(root, ".KB.init-dir-test");
  mkdirSync(dest, { recursive: true });
  assert.deepEqual(writeTemplates(root, "KB", dest), ["KB/README.md"]);
  assert.deepEqual(readdirSync(dest), ["README.md"]);
  assert.equal(existsSync(join(root, "KB")), false);
});

test("writeTemplates with opts.failAt throws right after that file; the files before it and it are written, none after", () => {
  const dest = join(base, "fail-at");
  mkdirSync(dest);
  assert.throws(() => writeTemplates(base, "scripts", dest, { failAt: "scripts/stop.sh" }), /^Error: 주입한 실패: scripts\/stop\.sh$/);
  assert.deepEqual(readdirSync(dest).sort(), ["start.sh", "stop.sh"]);
});

test("block body: same folders give the same bytes, listed in folder order, no marker inside", () => {
  assert.equal(blockBody(["KB", "logs"]), blockBody(["logs", "KB"]));
  const lines = summaryLines(["KB", "logs"]);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("- `logs/`:"));
  assert.ok(lines[1].startsWith("- `KB/`:"));
  assert.equal(/<!--|USER:OMX:POLICY/.test(blockBody(FOLDERS)), false);
});

test("US-9 AC1: docs purpose is the user text byte for byte; docs gets README.md and empty evidence/, adr/ keep files", () => {
  assert.ok(Buffer.from(PURPOSES.docs, "utf8").equals(Buffer.from("문서를 관리하는 영역. evidence와 ADR도 포함하여 보관한다.", "utf8")));
  assert.equal(summaryLines(["docs"])[0], "- `docs/`: 문서를 관리하는 영역. evidence와 ADR도 포함하여 보관한다.");
  const files = templateFiles("docs");
  for (const keep of ["docs/evidence/.gitkeep", "docs/adr/.gitkeep"]) assert.equal(files.find((t) => t.rel === keep).data.length, 0, keep);
  const readme = files.find((t) => t.rel === "docs/README.md").data.toString("utf8");
  for (const rule of ["`docs/evidence/`", "`docs/adr/`", "evidence 와 ADR 도 여기에 보관", "progress-mon 의 ADR 탭"]) assert.ok(readme.includes(rule), rule);
});
