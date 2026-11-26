// transfer-string: does a file go to one line and back byte for byte, is a damaged string refused with nothing
// written, is no file overwritten, are the result files Notepad-safe, does the launcher find a Python 3.7+ (and
// fail with exit 9 when there is none), and do the compress-string / decompress-string commands run the same script?
// The clipboard is redirected to files (TRANSFER_STRING_CLIPBOARD_IN / _OUT) everywhere but the last test, which
// tries the real one and accepts "failed" where there is none (an SSH session).
// Needs a Python 3.7 or later: on PATH, in the usual install folders, or named by TRANSFER_STRING_PYTHON.
// Run: node --test skills/transfer-string/scripts/transfer-string.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { fileKind, findPython, isPyManager, noPythonText, probe, pyManagerRuntimes, pythons, quietEnv, runnable, which, EXIT_INTERNAL, EXIT_NO_PYTHON } from "./transfer-string.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const LAUNCHER = join(HERE, "transfer-string.mjs");
const BIN = { compress: join(ROOT, "bin", "compress-string.js"), decompress: join(ROOT, "bin", "decompress-string.js") };
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "tstr-"))); // macOS: /var is a link to /private/var, and getcwd gives the real one
const CLIP_OUT = join(TMP, "clip-out.md");
const DRM = [".pdf", ".hwp", ".hwpx", ".doc", ".docx", ".ppt", ".pptx", ".txt"];
const PY = findPython();
const outputs = [];
let dirN = 0;
after(() => rmSync(TMP, { recursive: true, force: true }));

const fresh = () => {
  const d = join(TMP, `d${++dirN}`);
  mkdirSync(d);
  return d;
};
const needPython = () => assert.ok(PY, "no Python 3.7 or later found: install one or set TRANSFER_STRING_PYTHON to its absolute path");

function parse(r) {
  const out = r.stdout ?? "";
  const res = {};
  let file = "";
  const m = out.match(/^TSTR_RESULT (.*?) file=(.*?)\r?$/m);
  if (m) {
    for (const kv of m[1].split(" ")) {
      const i = kv.indexOf("=");
      if (i > 0) res[kv.slice(0, i)] = kv.slice(i + 1);
    }
    file = m[2];
    outputs.push(file);
  }
  const c = (r.stderr ?? "").match(/TSTR_ERROR code=(\w+)/);
  return { exit: r.status, out, err: r.stderr ?? "", res, file, code: c ? c[1] : "" };
}

/** Runs the launcher (or a bin command) in cwd; the clipboard always goes to files. */
function ts(args, cwd, envAdd = {}, entry = LAUNCHER) {
  const env = { ...process.env, TRANSFER_STRING_CLIPBOARD_OUT: CLIP_OUT, ...envAdd };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return parse(spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: "utf8", timeout: 600000 }));
}

/** The count the script should print: code points of strict UTF-8 (a BOM is one), else bytes. */
function count(buf) {
  try {
    return { unit: "char", n: [...new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf)].length };
  } catch {
    return { unit: "byte", n: buf.length };
  }
}

/** The Notepad rule for one result file; returns the string inside. */
function notepad(file, alphabet) {
  const b = readFileSync(file);
  if (alphabet === "base64") {
    assert.ok(b.every((x) => x >= 0x21 && x <= 0x7e), `${basename(file)}: bytes 0x21-0x7E only`);
    const s = b.toString("ascii");
    assert.ok(s.startsWith("TSTR"), `${basename(file)} starts with TSTR`);
    assert.match(s, /^[A-Za-z0-9+/]+={0,2}$/, `${basename(file)} is one line of standard Base64`);
    assert.deepEqual([...Buffer.from(s, "base64").subarray(0, 3)], [0x4d, 0x24, 0xd1]);
    return s;
  }
  assert.deepEqual([...b.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${basename(file)} opens with a UTF-8 BOM`);
  const s = new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(3));
  assert.ok([...s].every((ch) => ch.codePointAt(0) >= 0xac00 && ch.codePointAt(0) <= 0xcbff), `${basename(file)}: syllables U+AC00..U+CBFF only`);
  return s;
}

/** Decompresses a string file copied into a new folder; returns the restored bytes and the result. */
function restoreFrom(file, name = basename(file), data = readFileSync(file)) {
  const d = fresh();
  writeFileSync(join(d, name), data);
  const r = ts(["decompress", join(d, name)], d);
  return { r, bytes: r.exit === 0 ? readFileSync(r.file) : null };
}

const CASES = [
  ["ascii.md", Buffer.from("The quick brown fox jumps over the lazy dog.\n".repeat(40))],
  ["korean.md", Buffer.from("긴 글을 짧은 한 줄 문자열로 압축합니다. 원래 글로 복원합니다.\n".repeat(60))],
  ["emoji.md", Buffer.from("\u{1F600}\u{1F389} 한글 mix \u{1F680}\n".repeat(30))],
  ["newlines.md", Buffer.from("line one\r\nline two\nline three\rend\r\n")],
  ["empty.md", Buffer.alloc(0)],
  ["bom.md", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("BOM 으로 시작하는 글\n")])],
  ["보고 서 v1.md", Buffer.from("이름에 한글과 공백이 있는 파일\n")],
  ["repo.md", Buffer.concat(["README.md", "CHANGELOG.md", "LIST.md"].map((f) => readFileSync(join(ROOT, f))))],
  ["bytes.bin", Buffer.concat([randomBytes(4096), Buffer.from([0xff, 0xfe, 0xc3])])],
];

for (const alphabet of ["base64", "hangul13"]) {
  for (const [name, data] of CASES) {
    test(`round trip ${alphabet}: ${name} (${data.length} bytes)`, () => {
      needPython();
      const d = fresh();
      writeFileSync(join(d, name), data);
      const r = ts(["compress", join(d, name), ...(alphabet === "hangul13" ? ["--hangul"] : [])], d);
      assert.equal(r.exit, 0, r.err);
      assert.equal(r.file, join(d, name + (alphabet === "base64" ? ".b64" : ".hangul")));
      assert.equal(r.res.alphabet, alphabet);
      const s = notepad(r.file, alphabet);
      const want = count(data);
      assert.equal(r.res.unit, want.unit);
      assert.equal(Number(r.res.in), want.n);
      assert.equal(Number(r.res.out), [...s].length);
      assert.equal(r.res.clipboard, "copied");
      assert.equal(readFileSync(CLIP_OUT, "utf8"), s, "the clipboard gets the same string");
      const back = restoreFrom(r.file);
      assert.equal(back.r.exit, 0, back.r.err);
      assert.equal(basename(back.r.file), name);
      assert.ok(back.bytes.equals(data), "decompress gives the same bytes");
    });
  }
}

test("a long Markdown text comes out shorter, and Hangul at most 0.47 times Base64", () => {
  needPython();
  const d = fresh();
  writeFileSync(join(d, "long.md"), CASES[7][1]);
  const b = ts(["compress", join(d, "long.md"), "--no-clipboard"], d);
  const h = ts(["compress", join(d, "long.md"), "--hangul", "--no-clipboard"], d);
  assert.equal(b.exit, 0, b.err);
  assert.ok(Number(b.res.out) < Number(b.res.in), `Base64 ${b.res.out} of ${b.res.in}`);
  assert.ok(Number(h.res.out) <= Number(b.res.out) * 0.47, `Hangul ${h.res.out} against Base64 ${b.res.out}`);
});

function compressed(text = "감싼 문자열도 풀립니다.\n".repeat(20), hangul = false) {
  const d = fresh();
  const data = Buffer.from(text);
  writeFileSync(join(d, "w.md"), data);
  const r = ts(["compress", join(d, "w.md"), "--no-clipboard", ...(hangul ? ["--hangul"] : [])], d);
  assert.equal(r.exit, 0, r.err);
  return { data, s: notepad(r.file, hangul ? "hangul13" : "base64") };
}

test("wrapped strings decompress: line breaks, spaces, text around, glued letters, BOM, UTF-16LE, cp949 re-save", () => {
  needPython();
  const { data, s } = compressed();
  const wraps = {
    "breaks.b64": s.match(/.{1,76}/g).join("\r\n"),
    "spaces.b64": s.match(/.{1,10}/g).join(" "),
    "around.md": `받은 글입니다:\n\n${s}\n\n끝.`,
    "glued.md": `${s}xyz`,
    "bom.b64": `\uFEFF${s}`,
  };
  for (const [name, text] of Object.entries(wraps)) {
    const b = restoreFrom(null, name, Buffer.from(text, "utf8"));
    assert.equal(b.r.exit, 0, `${name}: ${b.r.err}`);
    assert.ok(b.bytes.equals(data), name);
  }
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`앞 ${s} 뒤`, "utf16le")]);
  const b = restoreFrom(null, "unicode.b64", u16);
  assert.equal(b.r.exit, 0, b.r.err);
  assert.ok(b.bytes.equals(data), "UTF-16LE re-save");
  const ansi = restoreFrom(null, "ansi.b64", Buffer.concat([Buffer.from([0xbe, 0xd5, 0x20]), Buffer.from(s, "ascii")]));
  assert.equal(ansi.r.exit, 0, ansi.r.err);
  assert.ok(ansi.bytes.equals(data), "cp949 (ANSI) re-save with a Korean word in front");
});

test("a wrapped Hangul string decompresses, also from a UTF-16LE re-save", () => {
  needPython();
  const { data, s } = compressed(undefined, true);
  const broken = [...s].reduce((a, ch, i) => a + (i && i % 30 === 0 ? "\n" : "") + ch, "");
  for (const [name, buf] of [["h.hangul", Buffer.from(`\uFEFF${broken}`)], ["h16.hangul", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(broken, "utf16le")])]]) {
    const b = restoreFrom(null, name, buf);
    assert.equal(b.r.exit, 0, `${name}: ${b.r.err}`);
    assert.ok(b.bytes.equals(data), name);
  }
});

/** Decompresses text in a new folder and checks that it failed with exit 1 and code, writing nothing. */
function refused(text, code, why) {
  const d = fresh();
  writeFileSync(join(d, "in.b64"), text);
  const r = ts(["decompress", join(d, "in.b64")], d);
  assert.equal(r.exit, 1, `${why}: exit ${r.exit} ${r.err}`);
  assert.equal(r.code, code, `${why}: ${r.err}`);
  assert.deepEqual(readdirSync(d), ["in.b64"], `${why}: nothing written`);
}

test("damage is refused with nothing written: a changed character, a cut string, no string, a stray TSTR", () => {
  needPython();
  const { s } = compressed();
  const i = Math.floor(s.length / 2);
  const changed = s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
  refused(changed, "E_DAMAGED", "one changed character");
  refused(s.slice(0, s.length - 12), "E_CUT", "a cut string");
  refused("이 글에는 문자열이 없습니다.", "E_NOTFOUND", "no string");
  refused(`TSTR 앞의 낱말 ${changed}`, "E_DAMAGED", "a stray TSTR before a damaged string");
});

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const leb = (n) => {
  const out = [];
  do {
    let x = n % 128;
    n = Math.floor(n / 128);
    if (n) x |= 128;
    out.push(x);
  } while (n);
  return Buffer.from(out);
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

/** A blob with a valid crc32, built field by field as transfer_string.py lays it out. */
function blob({ method = 1, flags = 1, param = Buffer.alloc(0), orig, name = "x.md", sha8, data, version = 1 }) {
  const nb = Buffer.from(name);
  const body = Buffer.concat([Buffer.from([(method << 4) | flags]), param, leb(orig), Buffer.from([nb.length]), nb, sha8, data]);
  const head = Buffer.concat([Buffer.from([0x4d, 0x24, 0xd1, version]), u32(8 + body.length + 4), body]);
  return Buffer.concat([head, u32(crc32(head))]);
}
const sha8 = (b) => createHash("sha256").update(b).digest().subarray(0, 8);

test("crafted blobs with a valid crc32 are refused: a bomb, a length over 64 MiB, an unknown method, a big dictionary, a wrong sha256, version 2", () => {
  needPython();
  const hello = Buffer.from("hello hello hello");
  const good = blob({ orig: hello.length, sha8: sha8(hello), data: deflateRawSync(hello) });
  const back = restoreFrom(null, "good.b64", Buffer.from(good.toString("base64")));
  assert.equal(back.r.exit, 0, `the test's own blob decodes: ${back.r.err}`);
  assert.ok(back.bytes.equals(hello));
  const zeros = Buffer.alloc(8 * 1024 * 1024);
  const crafted = {
    "an inflation bomb": blob({ orig: 100, sha8: sha8(zeros.subarray(0, 100)), data: deflateRawSync(zeros) }),
    "a declared length over 64 MiB": blob({ orig: 64 * 1024 * 1024 + 1, sha8: sha8(hello), data: deflateRawSync(hello) }),
    "an unknown method": blob({ method: 7, orig: hello.length, sha8: sha8(hello), data: hello }),
    "an LZMA2 dictionary over 64 MiB": blob({ method: 3, param: Buffer.from([27]), orig: hello.length, sha8: sha8(hello), data: hello }),
    "a wrong sha256": blob({ orig: hello.length, sha8: Buffer.alloc(8), data: deflateRawSync(hello) }),
    "version 2": blob({ version: 2, orig: hello.length, sha8: sha8(hello), data: deflateRawSync(hello) }),
  };
  for (const [why, b] of Object.entries(crafted)) refused(b.toString("base64"), "E_DAMAGED", why);
  const renamed = Buffer.from(good);
  renamed[8 + 1 + 1 + 1] ^= 1; // the first byte of the name, under the old crc32
  refused(renamed.toString("base64"), "E_DAMAGED", "a changed name byte");
});

test("nothing is overwritten: report.md-1.b64, report-1.md, the first files unchanged; no DRM extension", () => {
  needPython();
  const d = fresh();
  const data = Buffer.from("덮어쓰지 않습니다.\n");
  writeFileSync(join(d, "report.md"), data);
  const a = ts(["compress", join(d, "report.md"), "--no-clipboard"], d);
  const first = readFileSync(a.file);
  const b = ts(["compress", join(d, "report.md"), "--no-clipboard"], d);
  assert.equal(basename(a.file), "report.md.b64");
  assert.equal(basename(b.file), "report.md-1.b64");
  assert.ok(readFileSync(a.file).equals(first));
  const c = ts(["decompress", a.file], d);
  assert.equal(c.exit, 0, c.err);
  assert.equal(basename(c.file), "report-1.md");
  assert.ok(readFileSync(join(d, "report.md")).equals(data), "the original stays");
  assert.ok(readFileSync(c.file).equals(data));
  const drm = outputs.filter((f) => DRM.some((x) => f.toLowerCase().endsWith(x)));
  assert.deepEqual(drm, [], "no output name ends with a DRM extension");
});

test("clipboard through the injected reader and writer: compress, decompress, empty, --no-clipboard", () => {
  needPython();
  const d = fresh();
  const clipIn = join(TMP, "clip-in.md");
  const text = "클립보드의 긴 글입니다.\n".repeat(25);
  writeFileSync(clipIn, text);
  const c = ts(["compress", "--clipboard"], d, { TRANSFER_STRING_CLIPBOARD_IN: clipIn });
  assert.equal(c.exit, 0, c.err);
  assert.equal(c.file, join(d, "clipboard.b64"));
  assert.equal(readFileSync(CLIP_OUT, "utf8"), readFileSync(c.file, "ascii"));
  writeFileSync(clipIn, `메신저로 받은 글 ${readFileSync(c.file, "ascii")}`);
  const d2 = fresh();
  const r = ts(["decompress", "--clipboard"], d2, { TRANSFER_STRING_CLIPBOARD_IN: clipIn });
  assert.equal(r.exit, 0, r.err);
  assert.equal(r.file, join(d2, "clipboard.md"));
  assert.equal(readFileSync(r.file, "utf8"), text);
  for (const [op, empty] of [["compress", ""], ["compress", "\uFEFF"], ["decompress", " \r\n"]]) {
    writeFileSync(clipIn, empty);
    const e = ts([op, "--clipboard"], fresh(), { TRANSFER_STRING_CLIPBOARD_IN: clipIn });
    assert.equal(e.exit, 2, `${op} of an empty clipboard: ${e.err}`);
    assert.equal(e.code, "E_CLIPBOARD");
  }
  rmSync(CLIP_OUT, { force: true });
  writeFileSync(join(d, "n.md"), "x");
  const n = ts(["compress", join(d, "n.md"), "--no-clipboard"], d);
  assert.equal(n.res.clipboard, "off");
  assert.ok(!existsSync(CLIP_OUT), "--no-clipboard leaves the clipboard alone");
});

test("usage errors exit 2 and name the commands", () => {
  needPython();
  const d = fresh();
  writeFileSync(join(d, "a.md"), "a");
  writeFileSync(join(d, "b.md"), "b");
  const cases = [
    [[], "E_USAGE"],
    [["pack", "a.md"], "E_USAGE"],
    [["compress"], "E_USAGE"],
    [["compress", "a.md", "--bogus"], "E_USAGE"],
    [["compress", "a.md", "b.md"], "E_USAGE"],
    [["compress", "a.md", "--clipboard"], "E_USAGE"],
    [["decompress", "a.md.b64", "--hangul"], "E_USAGE"],
    [["compress", "missing.md"], "E_INPUT"],
    [["compress", d], "E_INPUT"],
  ];
  for (const [args, code] of cases) {
    const r = ts(args, d);
    assert.equal(r.exit, 2, `${args.join(" ")}: ${r.err}`);
    assert.equal(r.code, code, args.join(" "));
  }
  const u = ts([], d);
  assert.match(u.err, /compress-string <파일>/);
  assert.match(u.err, /decompress-string <파일>/);
});

test("launcher: TRANSFER_STRING_PYTHON is the only one tried; a missing or non-Python one exits 9", () => {
  assert.deepEqual(pythons({ TRANSFER_STRING_PYTHON: join(TMP, "py") }), [[join(TMP, "py")]]);
  assert.deepEqual(pythons({ TRANSFER_STRING_PYTHON: "python3" }), [], "a bare name is not tried");
  for (const bad of [join(TMP, "no-such-python"), process.execPath]) {
    const r = ts(["compress", "--clipboard"], fresh(), { TRANSFER_STRING_PYTHON: bad });
    assert.equal(r.exit, EXIT_NO_PYTHON, `${bad}: ${r.err}`);
    assert.equal(r.code, "E_PYTHON");
    assert.match(r.err, /TRANSFER_STRING_PYTHON/);
  }
});

test("launcher: the Python found is absolute and 3.7 or later", () => {
  needPython();
  const v = spawnSync(PY.exe, ["-I", "-c", "import sys;print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8", cwd: TMP });
  const [maj, min] = v.stdout.trim().split(".").map(Number);
  assert.ok(maj === 3 && min >= 7, `${PY.exe} is ${v.stdout.trim()}`);
  const d = fresh();
  writeFileSync(join(d, "named.md"), "named");
  const named = ts(["compress", join(d, "named.md"), "--no-clipboard"], d, { TRANSFER_STRING_PYTHON: PY.exe });
  assert.equal(named.exit, 0, `a TRANSFER_STRING_PYTHON that works is used: ${named.err}`);
});

test("compress-string and decompress-string run the same script", () => {
  needPython();
  const d = fresh();
  const data = Buffer.from("터미널 명령으로 압축합니다.\n".repeat(10));
  writeFileSync(join(d, "cli.md"), data);
  const c = ts([join(d, "cli.md"), "--no-clipboard"], d, {}, BIN.compress);
  assert.equal(c.exit, 0, c.err);
  assert.equal(c.res.op, "compress");
  const d2 = fresh();
  writeFileSync(join(d2, "cli.md.b64"), readFileSync(c.file));
  const r = ts([join(d2, "cli.md.b64")], d2, {}, BIN.decompress);
  assert.equal(r.exit, 0, r.err);
  assert.ok(readFileSync(r.file).equals(data));
  for (const entry of Object.values(BIN)) {
    const u = ts([], d, {}, entry);
    assert.equal(u.exit, 2, u.err);
    assert.match(u.err, /compress-string/);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.bin["compress-string"], "bin/compress-string.js");
  assert.equal(pkg.bin["decompress-string"], "bin/decompress-string.js");
  assert.ok(!("compress" in pkg.bin) && !("decompress" in pkg.bin), "no bare compress or decompress command");
});

test("Linux clipboard: xclip from PATH by its absolute path; a copier that stays behind holding pipes does not hang", { skip: process.platform !== "linux" && "Linux only (macOS uses /usr/bin/pbcopy, Windows PowerShell)" }, () => {
  needPython();
  const fake = fresh();
  const store = join(TMP, "fake-clip.md");
  writeFileSync(join(fake, "xclip"), `#!/bin/sh\nif [ "$3" = "-i" ]; then cat > "${store}"; (sleep 30 &); else cat "${store}"; fi\n`);
  chmodSync(join(fake, "xclip"), 0o755);
  const env = { TRANSFER_STRING_PYTHON: PY.exe, TRANSFER_STRING_CLIPBOARD_OUT: undefined, DISPLAY: ":99", WAYLAND_DISPLAY: undefined, PATH: `${fake}:/usr/bin:/bin` };
  const d = fresh();
  const data = Buffer.from("가짜 xclip 으로 복사합니다.\n".repeat(10));
  writeFileSync(join(d, "x.md"), data);
  const t0 = Date.now();
  const c = ts(["compress", join(d, "x.md")], d, env);
  assert.equal(c.exit, 0, c.err);
  assert.equal(c.res.clipboard, "copied", c.out);
  assert.ok(Date.now() - t0 < 15000, "the copy returns while xclip's child still runs");
  assert.equal(readFileSync(store, "ascii"), readFileSync(c.file, "ascii"));
  const d2 = fresh();
  const r = ts(["decompress", "--clipboard"], d2, env);
  assert.equal(r.exit, 0, r.err);
  assert.ok(readFileSync(r.file).equals(data));
  const none = ts(["compress", join(d, "x.md")], fresh(), { ...env, DISPLAY: undefined });
  assert.equal(none.exit, 0, none.err);
  assert.equal(none.res.clipboard, "failed");
  assert.match(none.out, /화면 세션이 없습니다/);
});

const WIN = process.platform === "win32";
const POSIX_ONLY = WIN && "POSIX only: a planted program here is a shell script";

/** A shell script at dir/name that leaves a mark file when it runs, then runs the real Python. */
function planted(dir, name) {
  const mark = join(dir, `${name}.ran`);
  writeFileSync(join(dir, name), `#!/bin/sh\ntouch "${mark}"\nexec "${PY ? PY.exe : "/nonexistent"}" "$@"\n`);
  chmodSync(join(dir, name), 0o755);
  return mark;
}

test("launcher: a relative TRANSFER_STRING_PYTHON is refused (exit 9) and the working folder's python is not run", () => {
  needPython();
  const d = fresh();
  writeFileSync(join(d, "a.md"), "a");
  const mark = WIN ? null : planted(d, "python3");
  if (WIN) copyFileSync(process.execPath, join(d, "python3.exe"));
  for (const named of ["python3", `.${WIN ? "\\" : "/"}python3`]) {
    const r = ts(["compress", "a.md", "--no-clipboard"], d, { TRANSFER_STRING_PYTHON: named });
    assert.equal(r.exit, EXIT_NO_PYTHON, `${named}: ${r.err}`);
    assert.equal(r.code, "E_PYTHON");
    assert.match(r.err, /절대경로가 아닙니다/);
  }
  if (mark) assert.ok(!existsSync(mark), "the planted python3 never ran");
});

test("launcher: PATH's relative and empty entries are skipped, so a planted python3 there is not run", { skip: POSIX_ONLY }, () => {
  needPython();
  const d = fresh();
  writeFileSync(join(d, "a.md"), "a");
  const mark = planted(d, "python3");
  const path = [".", "", dirname(PY.exe), "/usr/bin", "/bin"].join(delimiter);
  assert.equal(which("python3", { PATH: path }) === join(d, "python3"), false);
  const r = ts(["compress", "a.md", "--no-clipboard"], d, { TRANSFER_STRING_PYTHON: undefined, PATH: path });
  assert.ok([0, EXIT_NO_PYTHON].includes(r.exit), r.err);
  assert.ok(!existsSync(mark), "the planted python3 never ran");
});

test("launcher: Python killed by a signal is exit 4 E_SIGNAL, not 1 (which reads as a damaged string)", { skip: POSIX_ONLY }, () => {
  needPython();
  const d = fresh();
  writeFileSync(join(d, "a.md"), "a");
  const fake = join(d, "py-killed");
  // the probe gets this script's own path as sys.executable, so the real run starts it again and it dies
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "-X" ]; then echo "${fake}"; exit 0; fi\nkill -9 $$\n`);
  chmodSync(fake, 0o755);
  const r = ts(["compress", "a.md", "--no-clipboard"], d, { TRANSFER_STRING_PYTHON: fake });
  assert.equal(r.exit, EXIT_INTERNAL, r.err);
  assert.equal(r.code, "E_SIGNAL");
});

const NO_INSTALL = join(HERE, "pymanager-no-install.json");
const QUIET = { PYTHON_MANAGER_AUTOMATIC_INSTALL: "false", PYTHON_MANAGER_CONFIG: NO_INSTALL };

test("quietEnv: PyManager's automatic install is off (the variable, and the settings file that beats the user's), any other spelling of the keys is dropped, the rest kept, the input untouched", () => {
  const env = { PATH: "/x", python_manager_automatic_install: "true", Python_Manager_Automatic_Install: "1", python_manager_config: "C:\\mine.json", OTHER: "y" };
  const q = quietEnv(env);
  assert.deepEqual(q, { PATH: "/x", OTHER: "y", ...QUIET });
  assert.equal(env.python_manager_automatic_install, "true");
  assert.deepEqual(quietEnv({ PYTHON_MANAGER_AUTOMATIC_INSTALL: "true", PYTHON_MANAGER_CONFIG: "/mine.json" }), QUIET);
  const file = JSON.parse(readFileSync(NO_INSTALL, "utf8"));
  assert.equal(file.automatic_install, false, "the file turns automatic install off");
  assert.deepEqual(Object.keys(file).filter((k) => !k.startsWith("#")), ["automatic_install"], "and sets nothing else");
});

test("launcher: the Python that runs the script gets PyManager's automatic install off too, not only the probe", { skip: POSIX_ONLY }, () => {
  needPython();
  const d = fresh();
  writeFileSync(join(d, "a.md"), "a");
  const fake = join(d, "py-env");
  const seen = join(d, "seen.txt");
  // the probe gets this script's own path as sys.executable (and leaves its arguments); the real run writes the value
  // it was given and exits 0
  const probed = join(d, "probe-args.txt");
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "-X" ]; then printf '%s ' "$1" "$2" "$3" "$4" > "${probed}"; echo "${fake}"; exit 0; fi\nprintf '%s %s' "$PYTHON_MANAGER_AUTOMATIC_INSTALL" "$PYTHON_MANAGER_CONFIG" > "${seen}"\n`);
  chmodSync(fake, 0o755);
  const r = ts(["compress", "a.md", "--no-clipboard"], d, { TRANSFER_STRING_PYTHON: fake, PYTHON_MANAGER_AUTOMATIC_INSTALL: "true", PYTHON_MANAGER_CONFIG: "/mine.json" });
  assert.equal(r.exit, 0, r.err);
  assert.equal(readFileSync(seen, "utf8"), `false ${NO_INSTALL}`);
  assert.equal(readFileSync(probed, "utf8"), "-X utf8 -I -c ", "the probe prints sys.executable in UTF-8 (-X utf8)");
});

/** The bin commands in a new folder laid out like the package, with launcher (module text, or none) under skills/. */
function binLayout(launcher) {
  const d = fresh();
  mkdirSync(join(d, "bin"));
  for (const f of Object.values(BIN)) copyFileSync(f, join(d, "bin", basename(f)));
  if (launcher !== null) {
    mkdirSync(join(d, "skills", "transfer-string", "scripts"), { recursive: true });
    writeFileSync(join(d, "skills", "transfer-string", "scripts", "transfer-string.mjs"), launcher);
  }
  return d;
}

test("bin: only a launcher that cannot be loaded (or has no run) is exit 9 E_INSTALL; an exception in run is 4 E_INTERNAL; run's code passes through", () => {
  const cases = [
    [null, EXIT_NO_PYTHON, "E_INSTALL", "the launcher missing"],
    ["export const x = 1;\n", EXIT_NO_PYTHON, "E_INSTALL", "no run"],
    ["export function run() { throw new TypeError('boom'); }\n", EXIT_INTERNAL, "E_INTERNAL", "run throws"],
    ["export function run(op) { process.stdout.write(`ran ${op}\\n`); return 7; }\n", 7, "", "run returns 7"],
  ];
  for (const [launcher, exit, code, why] of cases) {
    const d = binLayout(launcher);
    for (const name of ["compress-string.js", "decompress-string.js"]) {
      const r = ts(["x.md"], d, {}, join(d, "bin", name));
      assert.equal(r.exit, exit, `${why}, ${name}: ${r.err}`);
      assert.equal(r.code, code, `${why}, ${name}: ${r.err}`);
      if (code === "E_INSTALL") assert.match(r.err, /불러오지 못했습니다/);
      if (code === "E_INTERNAL") assert.match(r.err, /^\[transfer-string\] 오류: 내부 오류 \(TypeError: boom\)/m);
      if (exit === 7) assert.equal(r.out, `ran ${name.split("-")[0]}\n`);
    }
  }
});

test("a text of 400,000 decoy TSTR marks is refused within seconds", () => {
  needPython();
  const t0 = Date.now();
  refused("TSTR".repeat(400000), "E_DAMAGED", "decoy marks");
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
});

/** Hangul encoding as transfer_string.py writes it: 13 bits per syllable from U+AC00, 13 bytes to 8 syllables. */
function encodeHangul(buf) {
  let out = "";
  for (let i = 0; i < buf.length; i += 13) {
    const chunk = Buffer.alloc(13);
    buf.copy(chunk, 0, i, Math.min(i + 13, buf.length));
    const v = BigInt(`0x${chunk.toString("hex")}`);
    const k = Math.floor((8 * Math.min(13, buf.length - i) + 12) / 13);
    for (let j = 0; j < k; j++) out += String.fromCharCode(0xac00 + Number((v >> BigInt(91 - 13 * j)) & 0x1fffn));
  }
  return out;
}

test("256 decoy heads that each claim one long body are refused within seconds (each character decoded once)", () => {
  needPython();
  const n = 1024 * 1024;
  for (const hangul of [true, false]) {
    const head = Buffer.concat([Buffer.from([0x4d, 0x24, 0xd1, 1]), u32(n), Buffer.alloc(5)]);
    const mark = hangul ? encodeHangul(head).slice(0, 5) : head.subarray(0, 9).toString("base64");
    const need = hangul ? Math.floor((8 * n + 12) / 13) : Math.floor((4 * n + 2) / 3);
    const body = hangul ? "\uac00".repeat(need) : "A".repeat(need);
    const t0 = Date.now();
    refused(mark.repeat(256) + body, "E_DAMAGED", `${hangul ? "Hangul" : "Base64"} decoy heads`);
    assert.ok(Date.now() - t0 < 15000, `${hangul ? "Hangul" : "Base64"}: took ${Date.now() - t0} ms`);
  }
});

/** A good blob of data under the given name, as a Base64 string. */
const named = (name, data = Buffer.from("x\n")) =>
  blob({ orig: data.length, sha8: sha8(data), data: deflateRawSync(data), name }).toString("base64");

test("restored names: device names get _, control, bidi and zero-width characters become _, no folder part", () => {
  needPython();
  const cases = [
    ["nul .md", "_nul .md"],
    ["CON", "_CON"],
    ["conin$", "_conin$"],
    ["COM\u00b9.md", "_COM\u00b9.md"],
    ["report\u202egpj.md", "report_gpj.md"],
    ["a\u200bb\u009bc.md", "a_b_c.md"],
    ["../../up.md", ".._.._up.md.restored", "1"],
    ["ok.md", "ok.md"],
  ];
  for (const [inName, want, risky = "0"] of cases) {
    const d = fresh();
    writeFileSync(join(d, "in.b64"), named(inName));
    const r = ts(["decompress", join(d, "in.b64")], d);
    assert.equal(r.exit, 0, `${inName}: ${r.err}`);
    assert.equal(r.file, join(d, want), JSON.stringify(inName));
    assert.equal(r.res.risky, risky, `${want} is a dot file`);
    assert.equal(r.res.renamed, risky, `${want}: renamed only when risky`);
  }
});

/** Decompresses a string of data under name in folder d (a new one by default); returns the result. */
function restoreNamed(name, args = [], d = fresh(), data = Buffer.from("x\n")) {
  const src = join(d, `in-${randomBytes(4).toString("hex")}.b64`);
  writeFileSync(src, named(name, data));
  return ts(["decompress", src, ...args], d);
}

test("a name that runs or is read on its own is written with .restored after it; the summary names the original and how to rename", () => {
  needPython();
  const names = [
    [".npmrc", "dot file"], ["setup.exe", "program"], ["invoice.docm", "macro file"], ["run.sh", "script"],
    ["Setup.EXE", "program, any case"], ["conftest.py", "RISKY_NAME"], ["Makefile", "RISKY_NAME, any case"],
    ["package.json", "RISKY_NAME"], ["desktop.ini", "RISKY_NAME"],
    ["CLAUDE.md", "an agent reads it from the folder"], ["AGENTS.md", "an agent reads it"], ["gemini.md", "an agent reads it, any case"],
    ["CLAUDE.local.md", "Claude Code reads it"], ["AGENTS.override.md", "Codex reads it"],
    ["Autorun.inf", "RISKY_NAME, any case"], ["tool.psm1", "PowerShell module"], ["hook.mjs", "Node module"],
    ["app.msix", "installer package"], ["fix.msp", "installer patch"], ["addin.xlam", "Excel add-in"],
    ["letter.dotm", "Word macro template"], ["run.desktop", "Linux launcher"], ["x.SettingContent-ms", "settings shortcut"],
  ];
  for (const [name, why] of names) {
    const r = restoreNamed(name);
    assert.equal(r.exit, 0, `${name}: ${r.err}`);
    assert.equal(basename(r.file), `${name}.restored`, why);
    assert.equal(r.res.risky, "1", name);
    assert.equal(r.res.renamed, "1", name);
    assert.ok(r.out.split(/\r?\n/).includes(`원래 이름: ${name}`), `${name}: ${r.out}`); // Windows ends lines with \r\n
    assert.ok(r.out.includes(`뒤에 .restored 를 붙여 썼습니다`) && r.out.includes(`원래 이름(${name})으로 바꾸십시오`), r.out);
    assert.match(r.out, /--keep-name/);
    assert.ok(readFileSync(r.file).equals(Buffer.from("x\n")));
  }
  for (const name of ["notes.md", "data.json", "photo.png", "readme"]) {
    const r = restoreNamed(name);
    assert.equal(basename(r.file), name, `${name} is not risky`);
    assert.equal(r.res.renamed, "0");
    assert.doesNotMatch(r.out, /주의:/);
  }
});

test("--keep-name writes a risky name as it is, with the warning only; it is a decompress option only", () => {
  needPython();
  for (const name of [".npmrc", "setup.exe", "conftest.py"]) {
    const r = restoreNamed(name, ["--keep-name"]);
    assert.equal(r.exit, 0, `${name}: ${r.err}`);
    assert.equal(basename(r.file), name);
    assert.equal(r.res.risky, "1");
    assert.equal(r.res.renamed, "0");
    assert.match(r.out, /주의: 실행되거나 자동으로 읽힐 수 있는 이름입니다\. 보낸 사람과 내용을 확인한 뒤 여십시오\./);
    assert.doesNotMatch(r.out, /원래 이름:/);
  }
  const d = fresh();
  writeFileSync(join(d, "a.md"), "a");
  const c = ts(["compress", join(d, "a.md"), "--keep-name"], d);
  assert.equal(c.exit, 2, c.err);
  assert.equal(c.code, "E_USAGE");
  const u = ts([], d);
  assert.match(u.err, /--keep-name/);
});

test("a .restored name that is taken gets a number as any other (nothing overwritten), and so does a kept name", () => {
  needPython();
  const d = fresh();
  writeFileSync(join(d, "setup.exe.restored"), "first");
  const a = restoreNamed("setup.exe", [], d, Buffer.from("second"));
  assert.equal(basename(a.file), "setup.exe-1.restored");
  const b = restoreNamed("setup.exe", [], d, Buffer.from("third"));
  assert.equal(basename(b.file), "setup.exe-2.restored");
  assert.equal(readFileSync(join(d, "setup.exe.restored"), "utf8"), "first", "the first file stays");
  assert.equal(readFileSync(a.file, "utf8"), "second");
  const dot = restoreNamed(".npmrc", [], d);
  const dot2 = restoreNamed(".npmrc", [], d);
  assert.deepEqual([basename(dot.file), basename(dot2.file)], [".npmrc.restored", ".npmrc-1.restored"]);
  writeFileSync(join(d, "run.sh"), "mine");
  const kept = restoreNamed("run.sh", ["--keep-name"], d);
  assert.equal(basename(kept.file), "run-1.sh");
  assert.equal(readFileSync(join(d, "run.sh"), "utf8"), "mine");
});

test("the restored file carries the download mark: Zone.Identifier on Windows, com.apple.quarantine on macOS", () => {
  needPython();
  const d = fresh();
  writeFileSync(join(d, "in.b64"), named("marked.md"));
  const r = ts(["decompress", join(d, "in.b64")], d);
  assert.equal(r.exit, 0, r.err);
  if (WIN) {
    assert.equal(r.res.mark, "zone");
    assert.match(readFileSync(`${r.file}:Zone.Identifier`, "latin1"), /ZoneId=3/);
    writeFileSync(`${join(d, "in.b64")}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:internet\r\n");
    const c = ts(["decompress", join(d, "in.b64")], d);
    assert.match(readFileSync(`${c.file}:Zone.Identifier`, "latin1"), /HostUrl=about:internet/, "the input's mark is copied");
  } else if (process.platform === "darwin") {
    assert.equal(r.res.mark, "quarantine");
    const x = spawnSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", r.file], { encoding: "utf8" });
    assert.equal(x.status, 0, x.stderr);
    assert.match(x.stdout, /transfer-string/);
  } else {
    assert.equal(r.res.mark, "none");
    assert.match(r.out, /다운로드 표시: 이 OS 에는 없음/);
  }
});

/** Fake clipboard programs in a new folder: name -> shell body. */
function fakeTools(tools) {
  const dir = fresh();
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

test("Wayland: wl-paste is asked for text (an image is an error, not a damaged text); a dead wl-copy falls through to xclip", { skip: process.platform !== "linux" && "Linux only" }, () => {
  needPython();
  const store = join(TMP, "wl-clip.md");
  const xstore = join(TMP, "x-clip.md");
  const wl = fakeTools({
    "wl-copy": `cat > "${store}"; (sleep 30 &)`,
    "wl-paste": `case "$*" in *"--type text"*) cat "${store}" ;; *) printf '\\211PNG' ;; esac`,
  });
  const env = { TRANSFER_STRING_PYTHON: PY.exe, TRANSFER_STRING_CLIPBOARD_OUT: undefined, WAYLAND_DISPLAY: "wayland-9", DISPLAY: undefined, PATH: `${wl}:/usr/bin:/bin` };
  const d = fresh();
  const data = Buffer.from("Wayland 클립보드\n".repeat(5));
  writeFileSync(join(d, "w.md"), data);
  const c = ts(["compress", join(d, "w.md")], d, env);
  assert.equal(c.res.clipboard, "copied", c.out);
  assert.equal(readFileSync(store, "ascii"), readFileSync(c.file, "ascii"));
  const r = ts(["decompress", "--clipboard"], fresh(), env);
  assert.equal(r.exit, 0, r.err);
  assert.ok(readFileSync(r.file).equals(data));
  const img = fakeTools({ "wl-copy": "exit 0", "wl-paste": `case "$*" in *"--type text"*) exit 1 ;; *) printf '\\211PNG' ;; esac` });
  const e = ts(["compress", "--clipboard"], fresh(), { ...env, PATH: `${img}:/usr/bin:/bin` });
  assert.equal(e.exit, 2, `an image on the clipboard: ${e.out}${e.err}`);
  assert.equal(e.code, "E_CLIPBOARD");
  const both = fakeTools({
    "wl-copy": "exit 1",
    "wl-paste": "exit 1",
    xclip: `if [ "$3" = "-i" ]; then cat > "${xstore}"; else cat "${xstore}"; fi`,
  });
  const f = ts(["compress", join(d, "w.md")], d, { ...env, DISPLAY: ":99", PATH: `${both}:/usr/bin:/bin` });
  assert.equal(f.res.clipboard, "copied", f.out);
  assert.equal(readFileSync(xstore, "ascii"), readFileSync(f.file, "ascii"));
});

/** A stat or lstat stand-in: returns a stat-like object of kind, or throws an error with code. */
const KINDS = { file: [1, 0, 0], dir: [0, 1, 0], link: [0, 0, 1], other: [0, 0, 0] }; // isFile, isDirectory, isSymbolicLink
const fakeStat = (kind) => () => {
  const k = KINDS[kind];
  if (k) return { isFile: () => !!k[0], isDirectory: () => !!k[1], isSymbolicLink: () => !!k[2] };
  throw Object.assign(new Error(kind), { code: kind });
};

test("runnable: a regular file; on Windows also an App Execution Alias (stat EACCES, EPERM or UNKNOWN, lstat works); never a broken link or a folder", () => {
  const cases = [
    // [stat, lstat, win, want, why]
    ["file", "file", false, true, "a regular file"],
    ["file", "file", true, true, "a regular file on Windows"],
    ["dir", "dir", true, false, "a folder"],
    ["EACCES", "link", true, true, "the Store alias: stat EACCES, lstat a link"],
    ["EPERM", "link", true, true, "an alias with EPERM"],
    ["UNKNOWN", "link", true, true, "an alias with UNKNOWN"],
    ["EACCES", "link", false, false, "not Windows: an unreadable file is not taken"],
    ["ENOENT", "link", true, false, "a broken link (stat ENOENT, lstat works)"],
    ["ENOENT", "ENOENT", true, false, "nothing there"],
    ["EACCES", "EACCES", true, false, "lstat fails too"],
    ["EACCES", "dir", true, false, "an unreadable folder"],
    ["ELOOP", "link", true, false, "a link loop"],
    ["EACCES", "file", true, true, "an alias that lstat shows as a file"],
    ["EACCES", "other", true, false, "lstat neither a file nor a link (a device, a pipe)"],
    ["dir", "link", true, false, "a junction or folder link to a folder (stat shows the folder)"],
  ];
  for (const [stat, lstat, win, want, why] of cases) {
    const opts = { stat: fakeStat(stat), lstat: fakeStat(lstat), win };
    assert.equal(runnable("C:\\x\\python3.exe", opts), want, why);
    assert.equal(fileKind("C:\\x\\python3.exe", opts), want ? (stat === "file" ? "file" : "alias") : null, why);
  }
  assert.equal(runnable(join(TMP, "no-such-file")), false, "the real fs: nothing there");
  assert.equal(runnable(TMP), false, "the real fs: a folder");
  assert.equal(runnable(process.execPath), true, "the real fs: node itself");
});

// Opt-in, on a Windows box: TRANSFER_STRING_STORE_PYTHON=1 where the Microsoft Store Python is installed (only its
// aliases in WindowsApps are left on PATH, the home folder is an empty one so no install folder is found), =stub
// where it is not (WindowsApps holds only the App Installer stubs, which must fail the probe at once and open nothing).
const STORE = process.env.TRANSFER_STRING_STORE_PYTHON;
const storeEnv = () => {
  const home = fresh();
  const apps = join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps");
  const set = { TRANSFER_STRING_PYTHON: undefined, USERPROFILE: home, HOME: home, LOCALAPPDATA: home, PATH: [apps, dirname(process.execPath)].join(delimiter) };
  // Windows names are case-blind: drop process.env's own spellings (Path) so the child gets only these
  const env = { ...Object.fromEntries(Object.keys(process.env).filter((k) => k.toUpperCase() in set && !(k in set)).map((k) => [k, undefined])), ...set };
  const full = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined));
  return { apps, env, full };
};

test("Windows Store Python (TRANSFER_STRING_STORE_PYTHON=1): its WindowsApps alias is found, probed and runs a round trip", { skip: !(WIN && STORE === "1") && "set TRANSFER_STRING_STORE_PYTHON=1 on Windows with the Microsoft Store Python installed" }, () => {
  const { apps, env, full } = storeEnv();
  const alias = join(apps, "python3.exe");
  assert.throws(() => statSync(alias), /EACCES|EPERM|UNKNOWN/, "stat cannot open the alias");
  assert.ok(runnable(alias), "the alias is taken");
  const all = pythons(full);
  const at = all.findIndex((c) => c[0].toLowerCase() === alias.toLowerCase());
  assert.ok(at >= 0, JSON.stringify(all));
  // in this process the install folders come from the real home (os.homedir) and come before every alias, so the
  // probe is asked directly; the commands below run with the empty home, where the alias is the only Python
  const py = probe(all[at], full);
  assert.ok(py && py.exe.toLowerCase().includes("\\windowsapps\\"), `the alias is a Python 3.7+: ${JSON.stringify(py)}`);
  const d = fresh();
  const data = Buffer.from("Store 판 Python 으로 압축합니다.\n".repeat(20));
  writeFileSync(join(d, "store.md"), data);
  const c = ts(["compress", join(d, "store.md"), "--no-clipboard"], d, env);
  assert.equal(c.exit, 0, c.err);
  const d2 = fresh();
  writeFileSync(join(d2, "store.md.b64"), readFileSync(c.file));
  const r = ts(["decompress", join(d2, "store.md.b64")], d2, env);
  assert.equal(r.exit, 0, r.err);
  assert.ok(readFileSync(r.file).equals(data), "round trip on the Store Python");
});

test("Windows without the Store Python (TRANSFER_STRING_STORE_PYTHON=stub): the App Installer stubs fail the probe at once, exit 9", { skip: !(WIN && STORE === "stub") && "set TRANSFER_STRING_STORE_PYTHON=stub on Windows with the Microsoft Store Python removed" }, () => {
  const { apps, env, full } = storeEnv();
  const stubs = ["python3", "python"].map((n) => which(n, full)).filter(Boolean);
  assert.ok(stubs.length, `an App Installer stub is in ${apps}`);
  const t0 = Date.now();
  for (const s of stubs) assert.equal(probe([s], full), null, `${s} is no Python`);
  const r = ts(["compress", "--clipboard"], fresh(), env); // the empty home: no install folder either
  assert.equal(r.exit, EXIT_NO_PYTHON, r.err);
  assert.equal(r.code, "E_PYTHON");
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
});

// PyManager keeps its runtimes under the real LOCALAPPDATA: the tests give it that one, so an automatic install shows
const pmRuntimes = () => {
  try {
    return readdirSync(join(process.env.LOCALAPPDATA, "Python")).filter((d) => /^pythoncore-/i.test(d));
  } catch {
    return [];
  }
};
const pmEnv = () => {
  const { apps, env, full } = storeEnv();
  const local = process.env.LOCALAPPDATA;
  return { apps, e: { ...env, LOCALAPPDATA: local }, f: { ...full, LOCALAPPDATA: local } };
};
const inApps = (all, apps) => all.filter((c) => c[0].toLowerCase().startsWith(apps.toLowerCase()));

test("Windows Python install manager with no runtime (TRANSFER_STRING_STORE_PYTHON=pymanager): its launchers are never run, nothing is downloaded, exit 9, also with its policy key or user file turning automatic install on", { skip: !(WIN && STORE === "pymanager") && "set TRANSFER_STRING_STORE_PYTHON=pymanager on Windows with PyManager installed and no runtime" }, (t) => {
  const { apps, e, f } = pmEnv();
  assert.deepEqual(pmRuntimes(), [], "no PyManager runtime before the test");
  const aliases = ["py", "python3", "python"].map((n) => which(n, f)).filter(Boolean);
  assert.ok(aliases.length && aliases.every((a) => isPyManager(a, "alias")), `PyManager's aliases are in ${apps}: ${aliases}`);
  const t0 = Date.now();
  const all = pythons(f);
  assert.deepEqual(inApps(all, apps), [], `no launcher is a candidate: ${JSON.stringify(all)}`);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  const r = ts(["compress", "--clipboard"], fresh(), e);
  assert.equal(r.exit, EXIT_NO_PYTHON, r.err);
  assert.match(r.err, /PyManager\)는 있지만 설치된 런타임이 없습니다/, "the error line says why");
  assert.deepEqual(pmRuntimes(), [], "nothing was installed");
  const policy = spawnSync("reg", ["query", "HKLM\\Software\\Policies\\Python\\PyManager"], { encoding: "utf8" });
  t.diagnostic(`policy key: ${policy.status === 0 ? policy.stdout.replace(/\s+/g, " ").trim() : "none"}`);
  t.diagnostic(`user file: ${existsSync(join(process.env.APPDATA || "", "Python", "PyManager.json")) ? "present" : "none"}`);
});

test("Windows Python install manager with a runtime (TRANSFER_STRING_STORE_PYTHON=pymanager-runtime): the runtime's python.exe takes the launchers' place and runs a round trip", { skip: !(WIN && STORE === "pymanager-runtime") && "set TRANSFER_STRING_STORE_PYTHON=pymanager-runtime on Windows with PyManager and a runtime it installed" }, () => {
  const { apps, e, f } = pmEnv();
  assert.ok(pmRuntimes().length, "a PyManager runtime is installed");
  const all = pythons(f);
  assert.deepEqual(inApps(all, apps), [], `no launcher is a candidate: ${JSON.stringify(all)}`);
  assert.ok(all.some((c) => /\\Python\\pythoncore-[^\\]+\\python\.exe$/i.test(c[0])), `the runtime is: ${JSON.stringify(all)}`);
  const d = fresh();
  const data = Buffer.from("PyManager 런타임으로 압축합니다.\n".repeat(20));
  writeFileSync(join(d, "pm.md"), data);
  const c = ts(["compress", join(d, "pm.md"), "--no-clipboard"], d, e);
  assert.equal(c.exit, 0, c.err);
  const d2 = fresh();
  writeFileSync(join(d2, "pm.md.b64"), readFileSync(c.file));
  const r = ts(["decompress", join(d2, "pm.md.b64")], d2, e);
  assert.equal(r.exit, 0, r.err);
  assert.ok(readFileSync(r.file).equals(data), "round trip on the PyManager runtime");
});

// A Windows PATH as an App Installer stub early in it and a real Python later in it, with fake stats (win: true on
// any OS): the stub is an alias in apps/, the real one a regular file in real/.
function aliasFirstPath() {
  const apps = join(TMP, "sim-apps");
  const real = fresh();
  const stat = (p) => {
    if (p.startsWith(apps)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return statSync(p);
  };
  const lstat = (p) => (p.startsWith(apps) ? fakeStat("link")() : statSync(p));
  return { apps, real, opts: { win: true, darwin: false, stat, lstat }, env: { PATH: [apps, real].join(delimiter) } };
}

test("launcher: an App Installer stub early in PATH does not hide a real Python later in it; regular files come before every alias", () => {
  const { apps, real, opts, env } = aliasFirstPath();
  for (const n of ["python3.exe", "python.exe"]) writeFileSync(join(real, n), "");
  const all = pythons(env, opts).map((c) => c[0]);
  const first = all.indexOf(join(real, "python3.exe"));
  const alias = all.indexOf(join(apps, "python3.exe"));
  assert.ok(first === 0 && all[1] === join(real, "python.exe"), `PATH's regular files first: ${JSON.stringify(all)}`);
  assert.deepEqual(all.slice(-2), [join(apps, "python3.exe"), join(apps, "python.exe")], "the aliases last, after the install folders");
  assert.ok(alias > first);
  assert.equal(which("python3", env, opts), join(real, "python3.exe"), "which prefers the regular file");
  const only = pythons({ PATH: apps }, opts).map((c) => c[0]);
  assert.deepEqual(only.slice(-2), [join(apps, "python3.exe"), join(apps, "python.exe")], "with aliases only, they are still tried");
});

test("launcher: findPython picks the real Python behind an App Installer stub in PATH", { skip: POSIX_ONLY }, () => {
  needPython();
  const { real, opts, env } = aliasFirstPath();
  const mark = planted(real, "python3.exe");
  // /usr/bin and /bin after them so the planted script finds touch (no python3.exe there); without
  // TRANSFER_STRING_PYTHON, which a box run sets and which would make that one Python the only candidate
  const { TRANSFER_STRING_PYTHON: _named, ...rest } = process.env;
  const py = findPython({ ...rest, PATH: [env.PATH, "/usr/bin", "/bin"].join(delimiter) }, opts);
  assert.ok(py && py.exe === PY.exe, `the real one: ${JSON.stringify(py)}`);
  assert.ok(existsSync(mark), "the real python3 behind the stub was probed");
});

// A Windows PATH folder of App Execution Aliases with fake stats (win: true on any OS): targets maps each alias name
// to the path it points to. spawn stands in for PyManager's list: it prints listed and records its calls.
const PM_PKG = "C:\\Program Files\\WindowsApps\\PythonSoftwareFoundation.PythonManager_26.4.240.0_x64__qbz5n2kfra8p0";
const STORE_PKG = "C:\\Program Files\\WindowsApps\\PythonSoftwareFoundation.Python.3.12_3.12.2800.0_x64__qbz5n2kfra8p0";
const STUB_PKG = "C:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.27.460.0_x64__8wekyb3d8bbwe";
const pmTargets = (pkg) => Object.fromEntries(["py", "python3", "python", "pymanager"].map((n) => [`${n}.exe`, `${pkg}\\${n}.exe`]));
function pmSim(targets, listed = [], status = 0) {
  const apps = join(TMP, `pm-apps-${++dirN}`);
  const calls = [];
  const gone = (code) => Object.assign(new Error(code), { code });
  const mine = (p) => dirname(p) === apps;
  const stat = (p) => {
    if (!mine(p)) return statSync(p);
    throw gone(basename(p) in targets ? "EACCES" : "ENOENT");
  };
  const lstat = (p) => (!mine(p) ? statSync(p) : basename(p) in targets ? fakeStat("link")() : stat(p));
  const readlink = (p) => {
    if (mine(p) && targets[basename(p)]) return targets[basename(p)];
    throw gone("EINVAL");
  };
  const spawn = (cmd, args, o) => {
    calls.push({ cmd, args, env: o.env });
    return { status, stdout: listed.join("\r\n") };
  };
  return { apps, calls, opts: { win: true, darwin: false, stat, lstat, readlink, spawn }, env: { PATH: apps } };
}

test("isPyManager: an alias into PyManager's package, or a regular file with a regular pymanager.exe beside it; not the Store Python, the App Installer stub or a plain Python", () => {
  const { apps, opts } = pmSim({ ...pmTargets(PM_PKG), "python3.12.exe": `${STORE_PKG}\\python3.12.exe`, "stub.exe": `${STUB_PKG}\\AppInstallerPythonRedirector.exe`, "sub.exe": `${PM_PKG}\\launchers\\python.exe`, "fwd.exe": `${PM_PKG.replace(/\\/g, "/")}/python.exe` });
  assert.equal(isPyManager(join(apps, "python.exe"), "alias", opts), true, "PyManager's python.exe alias");
  assert.equal(isPyManager(join(apps, "py.exe"), "alias", opts), true, "PyManager's py.exe alias");
  assert.equal(isPyManager(join(apps, "sub.exe"), "alias", opts), true, "a launcher in a subfolder of PyManager's package");
  assert.equal(isPyManager(join(apps, "fwd.exe"), "alias", opts), true, "a target written with /");
  assert.equal(isPyManager(join(apps, "python3.12.exe"), "alias", opts), false, "the Store Python's alias");
  assert.equal(isPyManager(join(apps, "stub.exe"), "alias", opts), false, "the App Installer stub");
  assert.equal(isPyManager(join(apps, "none.exe"), "alias", opts), false, "readlink fails");
  const msi = fresh();
  for (const n of ["py.exe", "python.exe", "pymanager.exe"]) writeFileSync(join(msi, n), "");
  assert.equal(isPyManager(join(msi, "python.exe"), "file", opts), true, "an MSI install: pymanager.exe beside");
  const plain = fresh();
  writeFileSync(join(plain, "python.exe"), "");
  assert.equal(isPyManager(join(plain, "python.exe"), "file", opts), false, "a plain Python folder");
  mkdirSync(join(plain, "pymanager.exe"));
  assert.equal(isPyManager(join(plain, "python.exe"), "file", opts), false, "a folder named pymanager.exe is not one");
});

test("launcher: PyManager's launchers are replaced by the runtimes its local list names (asked once, quietly, never with Python's arguments); with none they are left out", () => {
  const rt = fresh();
  const [a, b] = ["pythoncore-3.15-64", "pythoncore-3.13-64"].map((n) => {
    mkdirSync(join(rt, n));
    writeFileSync(join(rt, n, "python.exe"), "");
    return join(rt, n, "python.exe");
  });
  const noise = ["Python install manager was successfully updated to 26.4.", "", "relative\\python.exe", join(rt, "gone", "python.exe"), join(rt, "pythoncore-3.15-64")];
  const sim = pmSim(pmTargets(PM_PKG), [noise[0], a, ...noise.slice(1), b]);
  const all = pythons(sim.env, sim.opts);
  assert.deepEqual(all.filter((c) => c[0].startsWith(sim.apps)), [], `no launcher: ${JSON.stringify(all)}`);
  assert.deepEqual(all.filter((c) => c[0].startsWith(rt)), [[a], [b]], "the listed regular files only, in the list's order");
  assert.equal(sim.calls.length, 1, "one list for py, python3 and python");
  assert.equal(sim.calls[0].cmd, join(sim.apps, "pymanager.exe"));
  assert.deepEqual(sim.calls[0].args, ["list", "-f=exe", "-q"]);
  assert.equal(sim.calls[0].env.PYTHON_MANAGER_AUTOMATIC_INSTALL, "false");
  assert.equal(sim.calls[0].env.PYTHON_MANAGER_CONFIG, NO_INSTALL);
  for (const [listed, status, why] of [[[], 0, "no runtime"], [[a], 1, "the list fails"]]) {
    const s = pmSim(pmTargets(PM_PKG), listed, status);
    assert.deepEqual(pythons(s.env, s.opts).filter((c) => c[0].startsWith(s.apps) || c[0].startsWith(rt)), [], why);
  }
  const named = pmSim(pmTargets(PM_PKG), [a]);
  assert.deepEqual(pythons({ TRANSFER_STRING_PYTHON: join(named.apps, "python.exe") }, named.opts), [[a]], "TRANSFER_STRING_PYTHON is replaced too");
  const none = pmSim(pmTargets(PM_PKG), []);
  assert.deepEqual(pythons({ TRANSFER_STRING_PYTHON: join(none.apps, "python.exe") }, none.opts), [], "and left out with no runtime");
  // the user's own PYTHON_MANAGER_CONFIG (it may move install_dir) stays for the list; probe and run still get ours
  const own = pmSim(pmTargets(PM_PKG), [a]);
  pythons({ ...own.env, python_manager_config: "C:\\mine.json" }, own.opts);
  assert.equal(own.calls[0].env.PYTHON_MANAGER_CONFIG, "C:\\mine.json");
  assert.equal(own.calls[0].env.PYTHON_MANAGER_AUTOMATIC_INSTALL, "false");
  assert.ok(!("python_manager_config" in own.calls[0].env), "one spelling of the key only");
  assert.equal(quietEnv({ python_manager_config: "C:\\mine.json" }).PYTHON_MANAGER_CONFIG, NO_INSTALL);
});

test("E_PYTHON: a PyManager with no runtime is noted and named in the error line; otherwise the line is as before", () => {
  const notes = new Set();
  const s = pmSim(pmTargets(PM_PKG), []);
  assert.deepEqual(findPython(s.env, { ...s.opts, notes }), null);
  assert.deepEqual([...notes], ["pymanager-empty"]);
  const text = noPythonText({}, notes);
  assert.match(text, /PyManager 가 설치한 런타임/);
  assert.match(text, /Python install manager\(PyManager\)는 있지만 설치된 런타임이 없습니다/);
  assert.match(text, /TSTR_ERROR code=E_PYTHON\n$/);
  const plain = noPythonText({});
  assert.doesNotMatch(plain, /있지만 설치된 런타임이 없습니다/);
  const withRuntime = new Set();
  const rt = join(fresh(), "python.exe");
  writeFileSync(rt, "");
  pythons(pmSim(pmTargets(PM_PKG), [rt]).env, { ...pmSim(pmTargets(PM_PKG), [rt]).opts, notes: withRuntime });
  assert.equal(withRuntime.size, 0, "a PyManager with a runtime is not noted");
  // no list to read (pymanager.exe's alias turned off, or the list fails): said so, not "no runtime installed"
  const { "pymanager.exe": _off, ...noMgr } = pmTargets(PM_PKG);
  for (const [sim, why] of [[pmSim(noMgr, []), "pymanager.exe's alias is off"], [pmSim(pmTargets(PM_PKG), [], 1), "the list fails"]]) {
    const n = new Set();
    assert.equal(findPython(sim.env, { ...sim.opts, notes: n }), null);
    assert.deepEqual([...n], ["pymanager-unlisted"], why);
    const t = noPythonText({}, n);
    assert.match(t, /그 목록\(pymanager\.exe list\)을 읽지 못해 설치된 런타임을 확인하지 못했습니다/, why);
    assert.doesNotMatch(t, /있지만 설치된 런타임이 없습니다/, why);
    assert.match(t, /TSTR_ERROR code=E_PYTHON\n$/);
  }
});

test("launcher: PyManager's default runtime folder (%LOCALAPPDATA%\\Python\\pythoncore-*) is a candidate without running PyManager, the newest first; a free-threaded one by its own python3.<n>t.exe first", () => {
  const local = fresh();
  for (const n of ["pythoncore-3.13-64", "pythoncore-3.15-64", "pythoncore-3.14t-64", "pythoncore-3.12", "_cache", "bin"]) mkdirSync(join(local, "Python", n), { recursive: true });
  const sim = pmSim({});
  const got = pythons({ PATH: "", LOCALAPPDATA: local }, sim.opts).map((c) => c[0]).filter((p) => p.startsWith(local));
  const at = (n, exe = "python.exe") => join(local, "Python", n, exe);
  assert.deepEqual(got, [at("pythoncore-3.15-64"), at("pythoncore-3.14t-64", "python3.14t.exe"), at("pythoncore-3.14t-64"), at("pythoncore-3.13-64")]);
  assert.equal(sim.calls.length, 0, "PyManager is not run");
});

test("long_path (ntpath on any OS): absolute, relative, .., UNC, // and the extended forms", () => {
  needPython();
  const cases = [
    ["C:\\a\\b.md", "\\\\?\\C:\\a\\b.md"],
    ["sub\\x.md", "\\\\?\\C:\\work\\cur\\sub\\x.md"],
    ["..\\up\\x.md", "\\\\?\\C:\\work\\up\\x.md"],
    ["C:\\a\\..\\b\\.\\x.md", "\\\\?\\C:\\b\\x.md"],
    ["C:/a/b.md", "\\\\?\\C:\\a\\b.md"],
    ["\\\\srv\\share\\d\\x.md", "\\\\?\\UNC\\srv\\share\\d\\x.md"],
    ["//srv/share/d/x.md", "\\\\?\\UNC\\srv\\share\\d\\x.md"],
    ["\\\\?\\C:\\x\\y.md", "\\\\?\\C:\\x\\y.md"],
    ["//?/C:/x/y.md", "\\\\?\\C:\\x\\y.md"],
    ["\\\\?\\UNC\\srv\\share\\x.md", "\\\\?\\UNC\\srv\\share\\x.md"],
    ["\\\\.\\pipe\\x", "\\\\.\\pipe\\x"],
  ];
  // abspath as on Windows with C:\work\cur as the working folder
  const code = [
    "import json, ntpath, sys, types",
    "sys.path.insert(0, sys.argv[1])",
    "import transfer_string as t",
    "p = types.SimpleNamespace(abspath=lambda q: ntpath.normpath(ntpath.join('C:\\\\work\\\\cur', q)))",
    "cases = json.loads(sys.argv[2])",
    "print(json.dumps([t.long_path(c, True, p) for c in cases] + [t.long_path(cases[0], False, p)]))",
  ].join("\n");
  const r = spawnSync(PY.exe, ["-I", "-c", code, HERE, JSON.stringify(cases.map((c) => c[0]))], { encoding: "utf8", cwd: TMP });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  cases.forEach(([inp, want], i) => assert.equal(got[i], want, inp));
  assert.equal(got.at(-1), cases[0][0], "not Windows: as it is");
});

test("launcher: the Store Python's alias and the App Installer stub stay candidates and PyManager's list is not asked; a pymanager.exe that is not PyManager's is not run", () => {
  const sim = pmSim({ "python3.exe": `${STORE_PKG}\\python3.12.exe`, "python.exe": `${STUB_PKG}\\AppInstallerPythonRedirector.exe` });
  const all = pythons(sim.env, sim.opts).map((c) => c[0]);
  assert.deepEqual(all.slice(-2), [join(sim.apps, "python3.exe"), join(sim.apps, "python.exe")]);
  assert.equal(sim.calls.length, 0);
  const odd = pmSim({ ...pmTargets(PM_PKG), "pymanager.exe": `${STUB_PKG}\\pymanager.exe` }, ["C:\\x\\python.exe"]);
  assert.deepEqual(pyManagerRuntimes(join(odd.apps, "python.exe"), odd.env, odd.opts), []);
  assert.equal(odd.calls.length, 0, "not run");
  const msi = fresh();
  for (const n of ["py.exe", "python3.exe", "python.exe", "pymanager.exe"]) writeFileSync(join(msi, n), "");
  const rt = join(fresh(), "python.exe");
  writeFileSync(rt, "");
  const m = pmSim({}, [rt]);
  const got = pythons({ PATH: msi }, m.opts);
  assert.deepEqual(got.filter((c) => c[0].startsWith(msi) || c[0] === rt), [[rt]], "an MSI install's launchers become its runtime");
  assert.equal(m.calls[0].cmd, join(msi, "pymanager.exe"));
});

/** A new folder whose full path is about len characters long. */
function deepDir(len) {
  let d = fresh();
  while (d.length < len - 21) d = join(d, "d".repeat(20));
  d = join(d, "e".repeat(Math.max(1, len - d.length - 1)));
  mkdirSync(d, { recursive: true });
  return d;
}

test("a deep folder (a 250-character path): .restored, the number, --keep-name, a plain name and compress all write past Windows' 260, with the download mark", () => {
  needPython();
  const d = deepDir(250);
  const put = (name, args = [], data = Buffer.from("deep\n")) => {
    const src = join(d, `in-${randomBytes(4).toString("hex")}.b64`);
    writeFileSync(src, named(name, data));
    return ts(["decompress", src, ...args], fresh()); // a short working folder: only the files are deep
  };
  const a = put("setup.exe");
  assert.equal(a.exit, 0, a.err);
  assert.equal(a.file, join(d, "setup.exe.restored"));
  assert.ok(a.file.length > 260, `${a.file.length} characters`);
  assert.equal(readFileSync(a.file, "utf8"), "deep\n");
  const b = put("setup.exe", [], Buffer.from("second"));
  assert.equal(b.file, join(d, "setup.exe-1.restored"), "the number");
  assert.equal(readFileSync(a.file, "utf8"), "deep\n", "the first file stays");
  const k = put("run-the-script.sh", ["--keep-name"]);
  assert.equal(k.exit, 0, k.err);
  assert.equal(k.file, join(d, "run-the-script.sh"), "--keep-name");
  const p = put("notes-of-the-week.md");
  assert.equal(p.file, join(d, "notes-of-the-week.md"), "a name that is not risky");
  // a relative input with .. in it, from a working folder beside the deep one
  const side = join(dirname(d), "side");
  mkdirSync(side);
  const src = join(d, "rel.b64");
  writeFileSync(src, named("relative-input.md", Buffer.from("rel\n")));
  const rel = ts(["decompress", relative(side, src)], side);
  assert.ok(relative(side, src).startsWith(".."), relative(side, src));
  assert.equal(rel.exit, 0, rel.err);
  assert.equal(rel.file, join(d, "relative-input.md"), "the relative path, .. and all, comes out next to the input");
  assert.equal(readFileSync(rel.file, "utf8"), "rel\n");
  for (const r of [a, b, k, p, rel]) {
    assert.ok(r.file.length > 260);
    if (WIN) assert.match(readFileSync(`${r.file}:Zone.Identifier`, "latin1"), /ZoneId=3/, `${basename(r.file)} is marked`);
  }
  writeFileSync(join(d, "report-of-the.md"), "보고서\n".repeat(30));
  const c = ts(["compress", join(d, "report-of-the.md"), "--no-clipboard"], fresh());
  assert.equal(c.exit, 0, c.err);
  assert.equal(c.file, join(d, "report-of-the.md.b64"));
});

// Windows: a symbolic link needs an administrator or Developer Mode; elsewhere it always works
const CAN_LINK = (() => {
  const l = join(TMP, "can-link");
  try {
    symlinkSync(join(TMP, "nowhere"), l);
    rmSync(l);
    return true;
  } catch {
    return false;
  }
})();

test("a link at the restored name is not followed, a broken one included: the next number, the link and its target untouched (short and deep folder)", { skip: !CAN_LINK && "Windows: making a symbolic link needs an administrator or Developer Mode" }, () => {
  needPython();
  for (const d of [fresh(), deepDir(250)]) {
    const target = join(d, "elsewhere.txt");
    symlinkSync(target, join(d, "setup.exe.restored"));
    writeFileSync(join(d, "mine.txt"), "mine");
    symlinkSync(join(d, "mine.txt"), join(d, "notes.md"));
    const src = join(d, "in.b64");
    writeFileSync(src, named("setup.exe", Buffer.from("payload")));
    const r = ts(["decompress", src], fresh());
    assert.equal(r.exit, 0, r.err);
    assert.equal(r.file, join(d, "setup.exe-1.restored"), "the broken link's name is taken");
    assert.ok(!existsSync(target), "the broken link's target is not made");
    assert.ok(lstatSync(join(d, "setup.exe.restored")).isSymbolicLink(), "the link stays");
    writeFileSync(src, named("notes.md", Buffer.from("payload")));
    const n = ts(["decompress", src], fresh());
    assert.equal(n.file, join(d, "notes-1.md"));
    assert.equal(readFileSync(join(d, "mine.txt"), "utf8"), "mine", "the linked file is unchanged");
  }
});

const UNC = WIN && existsSync("\\\\localhost\\C$\\Windows");
test("Windows: a deep folder through a UNC path (\\\\localhost\\C$) writes past 260 too (the \\\\?\\UNC\\ form)", { skip: !UNC && "Windows with the C$ administrative share" }, () => {
  needPython();
  const d = deepDir(240);
  const u = `\\\\localhost\\${d[0]}$${d.slice(2)}`;
  writeFileSync(join(d, "in.b64"), named("setup.exe", Buffer.from("unc")));
  const r = ts(["decompress", join(u, "in.b64")], fresh());
  assert.equal(r.exit, 0, r.err);
  assert.equal(r.file, join(u, "setup.exe.restored"));
  assert.ok(r.file.length > 260, `${r.file.length} characters`);
  assert.equal(readFileSync(join(d, "setup.exe.restored"), "utf8"), "unc");
  assert.equal(r.res.mark, "zone");
});

const REAL = process.env.TRANSFER_STRING_REAL_CLIPBOARD === "1";
test("the real clipboard (TRANSFER_STRING_REAL_CLIPBOARD=1, where a desktop session has one): copied and read back", { skip: !REAL && "set TRANSFER_STRING_REAL_CLIPBOARD=1 where there is a clipboard; it overwrites the clipboard" }, () => {
  needPython();
  const d = fresh();
  const data = Buffer.from(`실제 클립보드 ${randomBytes(8).toString("hex")}\n`);
  writeFileSync(join(d, "real.md"), data);
  const c = ts(["compress", join(d, "real.md")], d, { TRANSFER_STRING_CLIPBOARD_OUT: undefined });
  assert.equal(c.exit, 0, c.err);
  assert.equal(c.res.clipboard, "copied", c.out);
  const r = ts(["decompress", "--clipboard"], fresh(), { TRANSFER_STRING_CLIPBOARD_OUT: undefined });
  assert.equal(r.exit, 0, r.err);
  assert.ok(readFileSync(r.file).equals(data), "the clipboard held the string");
});
