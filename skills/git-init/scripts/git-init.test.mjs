// git-init command line (plan 4.3, US-3 acceptance 1 to 13). Temp project folders, a temp HOME and a temp
// global git config only: the user's real git settings are never read or changed.
// Run: node --test skills/git-init/scripts/git-init.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PATTERNS, missingPatterns, nameHit } from "./git-init.mjs";

const WIN = process.platform === "win32";
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "git-init.mjs");
const SKILLS = join(HERE, "..", "..");
const base = realpathSync(mkdtempSync(join(tmpdir(), "git-init-cli-")));
const home = join(base, "home");
mkdirSync(home);
after(() => rmSync(base, { recursive: true, force: true }));
const ID = "T <t@example.invalid>";
const START = "# banker:git-init:start";
// A token that looks like a GitHub one to payload-scan, put together from pieces so no secret scanner flags this
// file; low entropy so only the github-token kind hits.
const FAKE_TOKEN = ["gh", "p_", "a1".repeat(18)].join("");

let n = 0;
const fresh = (prefix) => {
  const d = join(base, `${prefix}${n++}`);
  mkdirSync(d);
  return d;
};
const project = () => fresh("p");

// Acceptance 1: a temp HOME, a temp global config with user.useConfigOnly=true, no system config. The ceiling
// keeps git from looking above the temp base for a repository.
function gitEnv(globalExtra = "") {
  const cfg = join(fresh("cfg"), "gitconfig");
  writeFileSync(cfg, `[user]\n\tuseConfigOnly = true\n${globalExtra}`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: dirname(base) };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete env[k];
  return { env, cfg };
}
const DEFAULT = gitEnv();
const cli = (args, env = DEFAULT.env) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: base, env });
const gitIn = (root, args, env = DEFAULT.env) => spawnSync("git", args, { cwd: root, encoding: "utf8", env }).stdout.trim();
const files = (root, map) => {
  for (const [rel, text] of Object.entries(map)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
};
const output = (r) => r.stdout + r.stderr;

// Every entry under dir: kind, bytes or link target.
function snapshot(dir, rel = "", out = {}) {
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(dir, r));
    if (st.isSymbolicLink()) out[r] = `link:${readlinkSync(join(dir, r))}`;
    else if (st.isDirectory()) snapshot(dir, r, Object.assign(out, { [r]: "dir" }));
    else out[r] = `file:${readFileSync(join(dir, r)).toString("base64")}`;
  }
  return out;
}

function trySymlink(target, path) {
  try {
    symlinkSync(target, path);
    return true;
  } catch (e) {
    if (WIN && e.code === "EPERM") return false;
    throw e;
  }
}

test("--help 첫 줄과 사용 오류는 종료 2", () => {
  const help = cli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout.split("\n")[0], /^git-init: /);
  assert.equal(cli(["--bogus"]).status, 2);
  assert.equal(cli(["run", "--accept", "a.txt:x:github-token"]).status, 2);
  assert.equal(cli(["run", "--local-identity", "no mail"]).status, 2);
});

test("수용 2: 일반 파일 몇 개를 run 하면 .gitignore, git init, 커밋 init 하나, 종료 0", () => {
  const root = project();
  files(root, { "README.md": "# hi\n", "src/a.js": "export const a = 1;\n" });
  const r = cli(["run", "--root", root, "--local-identity", ID]);
  assert.equal(r.status, 0, output(r));
  assert.ok(existsSync(join(root, ".gitignore")));
  assert.equal(gitIn(root, ["log", "--format=%s"]), "init");
  assert.equal(gitIn(root, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(gitIn(root, ["log", "-1", "--format=%B"]), "init");
  assert.match(r.stdout, /git worktree add/);
  assert.match(r.stdout, /refresh-git-ignore/);
});

test("수용 3: .env 와 키 파일은 .gitignore 로 빠져 커밋에 없음, .env.example 은 들어감", () => {
  const root = project();
  files(root, { "app.js": "1\n", ".env": "X=1\n", ".env.local": "Y=2\n", ".env.example": "X=\n", "server.key": "k\n", "id_rsa": "k\n", ".omc/state.json": "{}\n" });
  const r = cli(["run", "--root", root, "--local-identity", ID]);
  assert.equal(r.status, 0, output(r));
  const tracked = gitIn(root, ["ls-files"]).split("\n");
  assert.deepEqual(tracked.sort(), [".env.example", ".gitignore", "app.js"]);
});

test("이름으로 막는 .npmrc, .netrc, _netrc, .pgpass 는 PATTERNS 로 자동 제외되어 커밋되고 git ls-files 에 없음", () => {
  for (const name of [".npmrc", ".netrc", "_netrc", ".pgpass"]) assert.ok(nameHit(name) && PATTERNS.includes(name), name);
  const root = project();
  files(root, { "app.js": "1\n", ".npmrc": "registry=https://registry.example.invalid/\n", ".netrc": "machine example.invalid\n", "_netrc": "machine example.invalid\n", ".pgpass": "# none\n", "sub/.npmrc": "x=1\n" });
  const r = cli(["run", "--root", root, "--local-identity", ID]);
  assert.equal(r.status, 0, output(r));
  assert.deepEqual(gitIn(root, ["ls-files"]).split("\n").sort(), [".gitignore", "app.js"]);
});

test("init-dir 강제 종료가 남긴 임시 폴더 .<이름>.init-dir-<난수>/ 는 PATTERNS 로 빠져 git ls-files 에 없음", () => {
  assert.ok(PATTERNS.includes(".*.init-dir-*/"));
  const root = project();
  files(root, { "app.js": "1\n", ".scripts.init-dir-0123456789ab/start.sh": "#!/bin/sh\n", ".KB.init-dir-abcdef/README.md": "# KB\n", "scripts/start.sh": "#!/bin/sh\n" });
  const r = cli(["run", "--root", root, "--local-identity", ID]);
  assert.equal(r.status, 0, output(r));
  assert.deepEqual(gitIn(root, ["ls-files"]).split("\n").sort(), [".gitignore", "app.js", "scripts/start.sh"]);
});

test("수용 4: 추적될 파일 안의 가짜 토큰은 종료 1, .git 없음, 파일:줄:종류 만 출력", () => {
  const root = project();
  files(root, { "config.txt": `name = demo\nTOKEN_VALUE ${FAKE_TOKEN}\n` });
  for (const cmd of ["check", "run"]) {
    const r = cli([cmd, "--root", root, "--local-identity", ID]);
    assert.equal(r.status, 1, output(r));
    assert.ok(!existsSync(join(root, ".git")));
    assert.match(r.stdout, /config\.txt:2:github-token/);
    assert.ok(!output(r).includes(FAKE_TOKEN));
    assert.ok(!output(r).includes("a1a1a1"));
  }
  const json = JSON.parse(cli(["check", "--root", root, "--local-identity", ID, "--json"]).stdout);
  assert.deepEqual(json.hits, ["config.txt:2:github-token"]);
  assert.ok(!JSON.stringify(json).includes(FAKE_TOKEN));
});

test("수용 5: 같은 걸림을 --accept 로 넘기면 커밋되고, 줄이나 종류가 다르면 넘기지 못함", () => {
  const root = project();
  files(root, { "config.txt": `name = demo\nTOKEN_VALUE ${FAKE_TOKEN}\n` });
  for (const wrong of ["config.txt:3:github-token", "config.txt:2:openai-key", "other.txt:2:github-token"]) {
    const r = cli(["run", "--root", root, "--local-identity", ID, "--accept", wrong]);
    assert.equal(r.status, 1, `${wrong}: ${output(r)}`);
    assert.ok(!existsSync(join(root, ".git")));
  }
  const r = cli(["run", "--root", root, "--local-identity", ID, "--accept", "config.txt:2:github-token"]);
  assert.equal(r.status, 0, output(r));
  assert.match(r.stdout, /확인으로 넘긴 항목: config\.txt:2:github-token/);
  assert.ok(!output(r).includes(FAKE_TOKEN));
  assert.ok(gitIn(root, ["ls-files"]).split("\n").includes("config.txt"));
});

test("수용 6: 사용자 .gitignore 의 !secret.pem 예외는 이름 스캔이 잡고 --accept 로도 못 넘김", () => {
  const root = project();
  files(root, { ".gitignore": "*.pem\n!secret.pem\n", "secret.pem": "x\n", "a.md": "a\n" });
  for (const extra of [[], ["--accept", "secret.pem:1:private-key"], ["--accept", "secret.pem:1:name"]]) {
    const r = cli(["run", "--root", root, "--local-identity", ID, ...extra]);
    assert.equal(r.status, 1, output(r));
    assert.match(r.stdout, /이름 걸림.*secret\.pem/);
    assert.ok(!existsSync(join(root, ".git")));
  }
});

test("수용 7: 루트나 상위가 저장소면 종료 3, 상위만이면 --nested 로 진행, 하위 .git 은 종료 3 과 경로", () => {
  const repo = project();
  spawnSync("git", ["init", "-q", repo], { env: DEFAULT.env });
  assert.equal(cli(["run", "--root", repo, "--local-identity", ID]).status, 3);
  const child = join(repo, "child");
  files(child, { "a.md": "a\n" });
  const r = cli(["run", "--root", child, "--local-identity", ID]);
  assert.equal(r.status, 3, output(r));
  assert.match(r.stderr, /상위 폴더가 저장소/);
  assert.ok(!existsSync(join(child, ".git")));
  const nested = cli(["run", "--root", child, "--local-identity", ID, "--nested"]);
  assert.equal(nested.status, 0, output(nested));
  assert.equal(gitIn(child, ["rev-parse", "--show-toplevel"]), child.replace(/\\/g, "/"));
  const outer = project();
  files(outer, { "a.md": "a\n" });
  spawnSync("git", ["init", "-q", join(outer, "vendor", "lib")], { env: DEFAULT.env });
  const sub = cli(["run", "--root", outer, "--local-identity", ID]);
  assert.equal(sub.status, 3, output(sub));
  assert.match(sub.stderr, /vendor\/lib\//);
  assert.ok(!existsSync(join(outer, ".git")) && !existsSync(join(outer, ".gitignore")));
});

test("수용 8: 신원이 없으면 종료 3 과 전역 설정 불변, --local-identity 는 .git/config 에만", () => {
  const { env, cfg } = gitEnv();
  const before = readFileSync(cfg);
  const root = project();
  files(root, { "a.md": "a\n" });
  const r = cli(["run", "--root", root], env);
  assert.equal(r.status, 3, output(r));
  assert.match(r.stderr, /--local-identity/);
  assert.match(r.stderr, /git config --global user\.name/);
  assert.ok(!existsSync(join(root, ".git")) && !existsSync(join(root, ".gitignore")));
  const ok = cli(["run", "--root", root, "--local-identity", ID], env);
  assert.equal(ok.status, 0, output(ok));
  assert.deepEqual(readFileSync(cfg), before);
  const local = readFileSync(join(root, ".git", "config"), "utf8");
  assert.match(local, /name = T/);
  assert.match(local, /email = t@example\.invalid/);
});

test("수용 9: --branch dev, 전역 init.defaultBranch, 없으면 main", () => {
  const head = (root) => readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
  const a = project();
  assert.equal(cli(["run", "--root", a, "--local-identity", ID, "--branch", "dev"]).status, 0);
  assert.equal(head(a), "ref: refs/heads/dev");
  const trunk = gitEnv("[init]\n\tdefaultBranch = trunk\n");
  const b = project();
  assert.equal(cli(["run", "--root", b, "--local-identity", ID], trunk.env).status, 0);
  assert.equal(head(b), "ref: refs/heads/trunk");
  const c = project();
  assert.equal(cli(["run", "--root", c, "--local-identity", ID]).status, 0);
  assert.equal(head(c), "ref: refs/heads/main");
  assert.equal(cli(["check", "--root", project(), "--local-identity", ID, "--branch", "bad..name"]).status, 2);
});

test("수용 10: 기존 .gitignore 는 앞 바이트 그대로이고 끝에 표지 블록 하나, 빠진 패턴만", () => {
  const root = project();
  const original = "\u{FEFF}node_modules/\r\n# mine\r\n.env\r\n";
  files(root, { ".gitignore": original, "a.md": "a\n" });
  const r = cli(["run", "--root", root, "--local-identity", ID]);
  assert.equal(r.status, 0, output(r));
  const text = readFileSync(join(root, ".gitignore"), "utf8");
  assert.ok(text.startsWith(original));
  assert.equal(text.split(START).length - 1, 1);
  const block = text.slice(original.length);
  assert.ok(!block.split("\r\n").includes("node_modules/") && !block.split("\r\n").includes(".env"));
  assert.ok(block.includes("*.pem\r\n"));
  assert.equal(readFileSync(join(root, ".gitignore.git-init.bak"), "utf8"), original);
});

test("기존 .gitignore 가 있으면 백업이 생기지만 git ls-files 에 없음", () => {
  const root = project();
  files(root, { ".gitignore": "dist/\n", "a.md": "a\n" });
  const r = cli(["run", "--root", root, "--local-identity", ID]);
  assert.equal(r.status, 0, output(r));
  assert.equal(readFileSync(join(root, ".gitignore.git-init.bak"), "utf8"), "dist/\n");
  assert.deepEqual(gitIn(root, ["ls-files"]).split("\n").sort(), [".gitignore", "a.md"]);
});

test("수용 10: .gitignore 가 링크면 기본 종료 1, --follow-symlink 면 가리키는 파일에 씀", (t) => {
  const root = project();
  const shared = join(fresh("shared"), "ignore-src");
  writeFileSync(shared, "dist/\n");
  if (!trySymlink(shared, join(root, ".gitignore"))) return t.skip("이 Windows 계정은 심볼릭 링크를 만들 수 없음");
  files(root, { "a.md": "a\n" });
  const r = cli(["run", "--root", root, "--local-identity", ID]);
  assert.equal(r.status, 1, output(r));
  assert.match(r.stderr, /심볼릭 링크/);
  assert.ok(!existsSync(join(root, ".git")));
  assert.equal(readFileSync(shared, "utf8"), "dist/\n");
  const f = cli(["check", "--root", root, "--local-identity", ID, "--follow-symlink"]);
  assert.equal(f.status, 0, output(f));
  assert.ok(lstatSync(join(root, ".gitignore")).isSymbolicLink());
});

test("수용 11: check 는 어떤 파일도 바꾸지 않음", () => {
  const root = project();
  files(root, { ".gitignore": "dist/\n", "a.md": "a\n", ".env": "X=1\n" });
  const before = snapshot(root);
  const r = cli(["check", "--root", root, "--local-identity", ID]);
  assert.equal(r.status, 0, output(r));
  assert.match(r.stdout, /계획만/);
  assert.match(r.stdout, /추적 후보: 2개/);
  assert.deepEqual(snapshot(root), before);
  const empty = project();
  assert.equal(cli(["--root", empty, "--local-identity", ID]).status, 0);
  assert.deepEqual(readdirSync(empty), []);
});

test("수용 12: 빈 폴더는 커밋 1개, 추적 파일은 .gitignore 하나", () => {
  const root = project();
  const r = cli(["run", "--root", root, "--local-identity", ID]);
  assert.equal(r.status, 0, output(r));
  assert.equal(gitIn(root, ["ls-files"]), ".gitignore");
  assert.equal(gitIn(root, ["rev-list", "--count", "HEAD"]), "1");
  assert.match(r.stdout, /추적 파일: 1개/);
});

test("수용 13: payload-scan.mjs, marker-block.mjs 사본이 정본과 바이트 동일", () => {
  const pairs = [
    ["git-init/scripts/payload-scan.mjs", "ralph-qa/references/payload-scan.mjs"],
    ["git-init/scripts/marker-block.mjs", "init-dir/scripts/marker-block.mjs"],
  ];
  for (const [copy, canonical] of pairs) assert.ok(readFileSync(join(SKILLS, copy)).equals(readFileSync(join(SKILLS, canonical))), copy);
});

test("선행 조건: GIT_DIR 환경 변수와 HOME 루트는 종료 3, 아무것도 안 바꿈", () => {
  const root = project();
  const r = cli(["run", "--root", root, "--local-identity", ID], { ...DEFAULT.env, GIT_DIR: join(root, "x") });
  assert.equal(r.status, 3, output(r));
  assert.deepEqual(readdirSync(root), []);
  assert.equal(cli(["run", "--root", home, "--local-identity", ID]).status, 3);
  assert.equal(cli(["run", "--root", join(base, "missing")]).status, 2);
});

test("선행 조건: 다른 대소문자로 적은 HOME 루트도 종료 3(대소문자를 무시하는 파일 시스템)", (t) => {
  const other = join(dirname(home), "HOME");
  if (!existsSync(other)) return t.skip("대소문자를 가리는 파일 시스템: 다른 철자는 다른 폴더");
  assert.equal(cli(["run", "--root", other, "--local-identity", ID]).status, 3);
  assert.equal(existsSync(join(home, ".git")), false);
});

test("2MB 넘는 파일과 바이너리는 내용 미스캔 목록(check 출력에 둘 다), 걸림으로 막지 않음", () => {
  const root = project();
  files(root, { "big.log": "x".repeat(2 * 1024 * 1024 + 1), "bin.dat": Buffer.from([0, 1, 2, 3]) });
  const r = JSON.parse(cli(["check", "--root", root, "--local-identity", ID, "--json"]).stdout);
  assert.equal(r.exit, 0);
  assert.deepEqual(r.unscanned, ["big.log"]);
  assert.equal(r.binary, 1);
  assert.deepEqual(r.binaries, ["bin.dat"]);
  const text = cli(["check", "--root", root, "--local-identity", ID]).stdout;
  assert.match(text, /^- 내용 미스캔\(2MB 초과\): big\.log$/m);
  assert.match(text, /^- 내용 미스캔\(바이너리\): bin\.dat$/m);
});

test("missingPatterns 는 자기 블록 밖의 줄만 셈, nameHit 는 키 이름과 .aws, .ssh 폴더", () => {
  assert.deepEqual(missingPatterns(PATTERNS.join("\n")), []);
  const own = `${START}\n.env\n# banker:git-init:end\n`;
  assert.ok(missingPatterns(own).includes(".env"));
  assert.ok(nameHit("a/.env") && nameHit("x.PEM") && nameHit(".aws/config") && nameHit("id_ed25519") && nameHit(".npmrc"));
  assert.ok(!nameHit(".env.example") && !nameHit("id_rsa.pub") && !nameHit("src/key.js"));
});

test("Windows: a git.exe inside the folder being initialized is not run (git starts from the home folder with -C)", { skip: process.platform !== "win32" && "Windows 만 일하는 폴더에서 프로그램을 먼저 찾음" }, () => {
  const root = project();
  files(root, { "a.txt": "a\n", ".gitignore": "git.exe\n" }); // the planted program stays out of the first commit
  copyFileSync(process.execPath, join(root, "git.exe")); // a node.exe named git.exe: it would fail on git's arguments
  const r = cli(["run", "--root", root, "--local-identity", ID]);
  assert.equal(r.status, 0, output(r));
  assert.ok(existsSync(join(root, ".git")));
});

