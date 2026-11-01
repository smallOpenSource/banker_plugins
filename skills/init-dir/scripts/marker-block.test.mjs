// marker-block policy table (plan 4.0), one or more tests per row. Temp folders only.
// Run: node --test skills/init-dir/scripts/marker-block.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HASH, HTML, applyBlock, applyBlocks, findBlock, markers } from "./marker-block.mjs";

const WIN = process.platform === "win32";
const BOM = "\u{FEFF}";
const POLICY = { open: "<!-- USER:OMX:POLICY:START -->", close: "<!-- USER:OMX:POLICY:END -->" };
const base = mkdtempSync(join(tmpdir(), "marker-block-"));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(base, String(n++));
  mkdirSync(d);
  return d;
};
const opts = (extra = {}) => ({ comment: HTML, id: "banker:test", body: "line one\nline two", skill: "test", ...extra });
const put = (dir, name, data) => {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
};
const read = (p) => readFileSync(p, "utf8");
const BLOCK = "<!-- banker:test:start -->\nline one\nline two\n<!-- banker:test:end -->\n";

// Symlinks on Windows need Developer Mode or admin rights: the link tests run where links can be made.
function trySymlink(target, path) {
  try {
    symlinkSync(target, path);
    return true;
  } catch (e) {
    if (WIN && e.code === "EPERM") return false;
    throw e;
  }
}

test("markers: whole-line markers for both comment syntaxes", () => {
  assert.deepEqual(markers(HTML, "banker:x"), { start: "<!-- banker:x:start -->", end: "<!-- banker:x:end -->" });
  assert.deepEqual(markers(HASH, "banker:x"), { start: "# banker:x:start", end: "# banker:x:end" });
});

test("append then remove gives the bytes back (with and without a final line break, empty file)", () => {
  const d = fresh();
  for (const original of ["a\nb\n", "a\nb", ""]) {
    const p = put(d, "f.md", original);
    assert.equal(applyBlock(p, opts()).changed, true);
    assert.ok(read(p).startsWith(original) && read(p).endsWith(BLOCK));
    assert.equal(applyBlock(p, opts({ body: null })).changed, true);
    assert.equal(read(p), original);
  }
});

test("replace keeps every byte before and after the block", () => {
  const d = fresh();
  const pre = "# title\n\ntext before\n";
  const post = "\ntext after\n";
  const p = put(d, "f.md", `${pre}<!-- banker:test:start -->\nold\n<!-- banker:test:end -->\n${post}`);
  assert.equal(applyBlock(p, opts()).changed, true);
  assert.equal(read(p), pre + BLOCK + post);
  assert.equal(applyBlock(p, opts()).changed, false, "same body twice: no change");
  applyBlock(p, opts({ body: null }));
  assert.equal(read(p), pre + post);
});

test("CRLF file gets a CRLF block and loses it byte for byte", () => {
  const d = fresh();
  const original = "x\r\ny\r\n";
  const p = put(d, "f.md", original);
  applyBlock(p, opts());
  const text = read(p);
  assert.equal(text.replace(/\r\n/g, "").includes("\n"), false, "no lone LF");
  assert.ok(text.endsWith(BLOCK.replace(/\n/g, "\r\n")));
  applyBlock(p, opts({ body: null }));
  assert.equal(read(p), original);
});

test("byte order mark stays in front, also with the block on the first line", () => {
  const d = fresh();
  const p = put(d, "f.md", `${BOM}x\n`);
  applyBlock(p, opts());
  assert.ok(read(p).startsWith(`${BOM}x\n`));
  applyBlock(p, opts({ body: null }));
  assert.equal(read(p), `${BOM}x\n`);
  const q = put(d, "g.md", `${BOM}${BLOCK}tail\n`);
  assert.equal(applyBlock(q, opts({ body: "new" })).ok, true);
  assert.equal(read(q), `${BOM}<!-- banker:test:start -->\nnew\n<!-- banker:test:end -->\ntail\n`);
});

test("hash comments for config files", () => {
  const d = fresh();
  const p = put(d, ".tmux.conf", "set -g mouse on\n");
  applyBlock(p, opts({ comment: HASH }));
  assert.equal(read(p), "set -g mouse on\n\n# banker:test:start\nline one\nline two\n# banker:test:end\n");
});

test("wrap: own USER:OMX:POLICY pair at the end; other policy blocks byte for byte; no double wrap", () => {
  const d = fresh();
  const other = `${POLICY.open}\nuser policy\n${POLICY.close}\n`;
  const p = put(d, "AGENTS.md", `# agents\n${other}`);
  applyBlock(p, opts({ wrap: POLICY }));
  const once = read(p);
  assert.equal(once, `# agents\n${other}\n${POLICY.open}\n${BLOCK}${POLICY.close}\n`);
  applyBlock(p, opts({ wrap: POLICY, body: "changed" }));
  assert.equal(read(p).split(POLICY.open).length - 1, 2, "still two policy pairs");
  assert.ok(read(p).startsWith(`# agents\n${other}`));
  applyBlock(p, opts({ wrap: POLICY, body: null }));
  assert.equal(read(p), `# agents\n${other}`);
  const q = put(d, "B.md", `${POLICY.open}\nmine\n${BLOCK}${POLICY.close}\n`);
  applyBlock(q, opts({ wrap: POLICY, body: "inside" }));
  assert.equal(read(q), `${POLICY.open}\nmine\n<!-- banker:test:start -->\ninside\n<!-- banker:test:end -->\n${POLICY.close}\n`);
});

const BROKEN = {
  "marker inside a sentence": "see <!-- banker:test:start --> here\n",
  "unpaired start": "a\n<!-- banker:test:start -->\nb\n",
  "end alone": "a\n<!-- banker:test:end -->\n",
  "end before start": "<!-- banker:test:end -->\n<!-- banker:test:start -->\n",
  "two blocks": BLOCK + BLOCK,
  "indented marker": "  <!-- banker:test:start -->\nx\n<!-- banker:test:end -->\n",
};

for (const [name, text] of Object.entries(BROKEN)) {
  test(`refuses broken markers (${name}) and leaves the file`, () => {
    const p = put(fresh(), "f.md", text);
    const r = applyBlock(p, opts());
    assert.equal(r.ok, false);
    assert.equal(r.refused, "markers");
    assert.equal(read(p), text);
    assert.equal(applyBlock(p, opts({ body: null })).refused, "markers", "remove refuses too");
  });
}

test("findBlock reports a span or nothing", () => {
  const lines = "a\n<!-- x:start -->\nb\n<!-- x:end -->\n".split(/(?<=\n)/);
  assert.deepEqual(findBlock(lines, markers(HTML, "x")), { first: 1, last: 3 });
  assert.equal(findBlock(["a\n"], markers(HTML, "x")), null);
});

test("refuses a file that is not UTF-8 and leaves it", () => {
  const d = fresh();
  const bytes = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x0a]);
  const p = put(d, "cp949.md", bytes);
  assert.equal(applyBlock(p, opts()).refused, "encoding");
  assert.ok(readFileSync(p).equals(bytes));
});

test("refuses a folder at the name", () => {
  const d = fresh();
  mkdirSync(join(d, "CLAUDE.md"));
  assert.equal(applyBlock(join(d, "CLAUDE.md"), opts()).refused, "special");
  assert.equal(statSync(join(d, "CLAUDE.md")).isDirectory(), true);
});

test("refuses a FIFO without reading it", { skip: WIN && "FIFO 는 POSIX 전용" }, () => {
  const d = fresh();
  const p = join(d, "fifo.md");
  assert.equal(spawnSync("mkfifo", [p]).status, 0, "mkfifo");
  assert.equal(applyBlock(p, opts()).refused, "special");
  assert.equal(lstatSync(p).isFIFO(), true);
});

test("symlink: refused by default, link and target unchanged", (t) => {
  const d = fresh();
  const target = put(d, "AGENTS.md", "agents\n");
  if (!trySymlink("AGENTS.md", join(d, "CLAUDE.md"))) return t.skip("Windows: 심볼릭 링크를 만들 권한 없음(개발자 모드 꺼짐)");
  const r = applyBlock(join(d, "CLAUDE.md"), opts());
  assert.equal(r.refused, "symlink");
  assert.match(r.message, /CLAUDE\.md -> AGENTS\.md/);
  assert.equal(read(target), "agents\n");
  assert.equal(lstatSync(join(d, "CLAUDE.md")).isSymbolicLink(), true);
});

test("symlink with followSymlink: only the target changes, the link stays a link", (t) => {
  const d = fresh();
  const target = put(d, "AGENTS.md", "agents\n");
  if (!trySymlink("AGENTS.md", join(d, "CLAUDE.md"))) return t.skip("Windows: 심볼릭 링크를 만들 권한 없음(개발자 모드 꺼짐)");
  const r = applyBlock(join(d, "CLAUDE.md"), opts({ followSymlink: true }));
  assert.equal(r.ok, true);
  assert.equal(read(target), `agents\n\n${BLOCK}`);
  assert.equal(lstatSync(join(d, "CLAUDE.md")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(d, "CLAUDE.md")), "AGENTS.md");
});

test("dangling symlink: refused with and without followSymlink, nothing made", (t) => {
  const d = fresh();
  if (!trySymlink("missing.md", join(d, "CLAUDE.md"))) return t.skip("Windows: 심볼릭 링크를 만들 권한 없음(개발자 모드 꺼짐)");
  assert.equal(applyBlock(join(d, "CLAUDE.md"), opts()).refused, "symlink");
  assert.equal(applyBlock(join(d, "CLAUDE.md"), opts({ followSymlink: true })).refused, "dangling");
  assert.deepEqual(readdirSync(d), ["CLAUDE.md"]);
});

test("hard link (link count 2): refused, both names unchanged", () => {
  const d = fresh();
  const p = put(d, "a.md", "x\n");
  linkSync(p, join(d, "b.md"));
  assert.equal(applyBlock(p, opts()).refused, "hardlink");
  assert.equal(read(p), "x\n");
  assert.equal(statSync(p).nlink, 2);
});

test("one file under two names is written once", (t) => {
  const d = fresh();
  const p = put(d, "AGENTS.md", "x\n");
  const r = applyBlocks([{ path: p, ...opts() }, { path: p, ...opts() }]);
  assert.equal(r.ok, true);
  assert.equal(r.results[1].sameAs, p);
  assert.equal(read(p).split("banker:test:start").length - 1, 1);
  if (!trySymlink("AGENTS.md", join(d, "CLAUDE.md"))) return t.skip("Windows: 심볼릭 링크를 만들 권한 없음(개발자 모드 꺼짐)");
  const s = applyBlocks([{ path: p, ...opts({ body: "both" }) }, { path: join(d, "CLAUDE.md"), ...opts({ body: "both", followSymlink: true }) }]);
  assert.equal(s.ok, true);
  assert.equal(read(p).split("banker:test:start").length - 1, 1);
});

test("one refusal among several files: none is written", () => {
  const d = fresh();
  const good = put(d, "good.md", "g\n");
  const bad = put(d, "bad.md", "<!-- banker:test:end -->\n");
  const r = applyBlocks([{ path: good, ...opts() }, { path: bad, ...opts() }]);
  assert.equal(r.ok, false);
  assert.equal(r.refused.length, 1);
  assert.equal(read(good), "g\n");
});

test("permission bits carry over (0600 stays 0600)", { skip: WIN && "권한 비트는 POSIX 전용" }, () => {
  const d = fresh();
  const p = put(d, "secret.md", "s\n");
  chmodSync(p, 0o600);
  applyBlock(p, opts());
  assert.equal(statSync(p).mode & 0o777, 0o600);
  applyBlock(p, opts({ body: null }));
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(read(p), "s\n");
});

test("another owner is refused (owner injected)", { skip: WIN && "소유자 검사는 POSIX 전용" }, () => {
  const d = fresh();
  const p = put(d, "f.md", "x\n");
  const r = applyBlock(p, opts({ uid: process.getuid() + 1 }));
  assert.equal(r.refused, "owner");
  assert.equal(read(p), "x\n");
});

test(".bak: made at the first change, never overwritten; no write when the bytes are the same", () => {
  const d = fresh();
  const p = put(d, "f.md", "first\n");
  applyBlock(p, opts());
  assert.equal(read(`${p}.test.bak`), "first\n");
  applyBlock(p, opts({ body: "second" }));
  assert.equal(read(`${p}.test.bak`), "first\n");
  const q = put(d, "same.md", BLOCK);
  const ino = statSync(q).ino;
  assert.equal(applyBlock(q, opts()).changed, false);
  assert.equal(statSync(q).ino, ino, "not rewritten");
  assert.equal(readdirSync(d).includes("same.md.test.bak"), false);
});

test("missing file: made with the block; dryRun writes nothing", () => {
  const d = fresh();
  const p = join(d, "new.md");
  assert.equal(applyBlock(p, opts({ dryRun: true })).changed, true);
  assert.deepEqual(readdirSync(d), []);
  assert.equal(applyBlock(p, opts()).created, true);
  assert.equal(read(p), BLOCK);
  assert.equal(applyBlock(join(d, "none.md"), opts({ body: null })).changed, false);
});

test("writes leave no temp file, also when the folder refuses the write", { skip: WIN && "폴더 쓰기 권한은 POSIX 전용" }, () => {
  const d = fresh();
  const p = put(d, "f.md", "x\n");
  applyBlock(p, opts());
  assert.deepEqual(readdirSync(d).filter((f) => f.endsWith(".tmp")), []);
  chmodSync(d, 0o500);
  try {
    let threw = false;
    try {
      applyBlock(p, opts({ body: "other" }));
    } catch {
      threw = true;
    }
    assert.deepEqual(readdirSync(d).filter((f) => f.endsWith(".tmp")), []);
    if (threw) assert.equal(read(p), `x\n\n${BLOCK}`);
  } finally {
    chmodSync(d, 0o700);
  }
});

test("a body holding a marker line is a programming error", () => {
  assert.throws(() => applyBlock(join(fresh(), "f.md"), opts({ body: "<!-- banker:test:end -->" })), /marker/);
});
