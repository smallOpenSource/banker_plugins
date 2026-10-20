// Tests for payload-scan.mjs. Run from the repo root: node --test skills/ralph-qa/references/payload-scan.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { PATTERNS, entropy, scan } from "./payload-scan.mjs";

const SCAN = fileURLToPath(new URL("./payload-scan.mjs", import.meta.url));

// Fake secrets are assembled at run time, so this file does not trip a secret scanner itself
// (payload-scan included: a test below scans this file).
const x = (n, c = "a") => c.repeat(n);
// Letters and digits with the spread of a random key, from a seeded generator (mulberry32).
function randomish(seed, n = 41) {
  const abc = [[65, 26], [97, 26], [48, 10]].flatMap(([from, n]) => Array.from({ length: n }, (_, i) => String.fromCharCode(from + i))).join("");
  let t = seed >>> 0;
  let out = "";
  for (let i = 0; i < n; i += 1) {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    out += abc[((r ^ (r >>> 14)) >>> 0) % abc.length];
  }
  return out;
}
const RANDOMISH = randomish(7);
const FAKES = {
  "aws-access-key": "AKIA" + "IOSFODNN7EXAMPLE",
  "github-token": "gh" + "p_" + x(36, "Z"),
  "gitlab-token": "gl" + "pat-" + x(20, "k"),
  "anthropic-key": "sk-" + "ant-api03-" + x(24, "b"),
  "openai-key": "sk-" + "proj-" + x(24, "c"),
  "stripe-key": "sk" + "_live_" + x(24, "m"),
  "npm-token": "np" + "m_" + x(36, "n"),
  "huggingface-token": "h" + "f_" + x(32, "p"),
  "google-api-key": "AI" + "za" + x(35, "d"),
  "slack-token": "xo" + "xb-" + x(12, "1"),
  "slack-webhook": "https://hooks.slack" + ".com/services/T0001/B0002/" + x(24, "s"),
  "private-key": "-----BEGIN " + "RSA PRIVATE KEY-----",
  "basic-auth": "Authorization: Bas" + "ic " + x(16, "Q"),
  // a kind named like a key would be caught on this very line: such names are assembled too
  ["assigned-pass" + "word"]: "pass" + 'word: "s3cr3tpw"',
  ["env-pass" + "word"]: "DB_PASS" + "WORD=correcthorsebatterystaple",
  "flag-secret": "--pass" + "word Tr0ub4dor3xyz",
  "assigned-hex": "ke" + "y: " + "0123456789abcdef".repeat(2),
  jwt: "ey" + "J" + x(12, "e") + ".ey" + "J" + x(12, "f") + "." + x(12, "g"),
  "bearer-token": "Authorization: Bear" + "er " + x(40, "t"),
  ["url-cred" + "entials"]: "postgres://admin:" + "S3cret" + "Pass@db.internal:5432/app",
  ["assigned-sec" + "ret"]: "pass" + 'word: "' + x(14, "h") + '"',
  ["assigned-sec" + "ret-bare"]: "DB_PASS" + "WORD=" + "hunter2hunter2hunter2",
  ["config-pass" + "word"]: "  POSTGRES_PASS" + "WORD: example123",
  ["dockerfile-env-pass" + "word"]: "ENV DB_PASS" + "WORD hunter22xyz",
  "curl-user": "curl -u admin:" + "Hunter22pw https://x",
};

test("every pattern has a sample it catches, by its own name", () => {
  assert.deepEqual(Object.keys(FAKES).sort(), PATTERNS.map(([k]) => k).sort());
  for (const [kind, sample] of Object.entries(FAKES)) {
    const kinds = scan(`line one\nconst v = ${sample};\n${sample}\n`).hits.map((h) => h.kind);
    assert.ok(kinds.includes(kind), `${kind} not caught in: ${kinds}`);
  }
});

test("secret assignments are caught with suffixed key names, unquoted values and YAML", () => {
  for (const line of [
    "SECRET_KEY = '" + RANDOMISH.slice(0, 20) + "'",
    '"aws_secret_access_key": "' + RANDOMISH.slice(0, 40) + '"',
    "OPENROUTER_API_" + "KEY=or1" + x(20, "v"),
    "db_pass" + "word: hunter2hunter2hunter2",
    "client_sec" + "ret: abc123def456ghi789",
    "비밀번호: " + "한글비번" + "1234" + "abcd" + "5678",
  ]) {
    assert.ok(scan(line).count > 0, `not caught: ${line}`);
  }
});

test("passwords in config shapes are caught, and words that only hold pass are not", () => {
  const v = "example" + "123";
  for (const line of [
    "POSTGRES_PASS" + "WORD: " + v,
    "+      - POSTGRES_PASS" + "WORD=" + v,
    "- MYSQL_ROOT_PASS" + "WORD=" + v,
    "spring.datasource.pass" + "word=" + v,
    "  pass" + "word: " + v,
    "ENV DB_PASS" + "WORD=" + v,
    "DB_PA" + "SS=Tr0ub4dor" + "3xyz",
    '"pa' + 'ss": "Tr0ub4dor&' + '3xyz!"',
    "pass" + 'phrase: "Tr0ub4dor&' + '3xyz"',
    '"client_sec' + 'ret": "Tr0ub4dor' + '3x"',
  ]) {
    assert.ok(scan(line).count > 0, `not caught: ${line}`);
  }
  for (const line of ["bypass: enabled1", "passenger: someone1", "password: ${DB_PASSWORD}", "password: <your-password>",
    "secret: \"development\"", "  password: {{ .Values.pw }}"]) {
    assert.equal(scan(line).count, 0, `caught: ${line}`);
  }
});

test("curl credentials and a Dockerfile ENV with a space are caught, look-alike flags are not", () => {
  for (const line of ["curl -uadmin:" + "Hunter22pw https://x", "curl --user=admin:" + "pw123456 x", "curl --user admin:" + "pw123456 x",
    "ENV MYSQL_ROOT_PASS" + "WORD Tr0ub4dor3xyz", "+ENV DB_PASS" + "WORD 'Tr0ub4dor3xyz'", "curl -u 1000:" + "1000abc x"]) {
    assert.ok(scan(line).count > 0, `not caught: ${line}`);
  }
  for (const line of ["sort -u a.txt", "git log -u", "docker run -u 1000:1000 app", "rsync -u host:/srv/app .", "mysql -uroot", "`docker run -u 1000:1000`",
    "sort -uk1:2 f", "ENV PASS" + "WORD must be set before start", "ENV DB_PASS" + "WORD=${DB_PASSWORD}"]) {
    assert.equal(scan(line).count, 0, `caught: ${line}`);
  }
});

test("curl's user flag is caught in a continued line and with an odd user, a date format, an id substitution and a whole uid:gid are not", () => {
  // root:root (docker) stays caught: telling a user:group from a user:password would let admin:admin through.
  const cu = "cu" + "rl -u ";
  for (const line of ["curl -u +admin:" + "Hunter22pw x", "curl -u $(whoami):" + "Hunter22pw x", "  -u admin:" + "Hunter22pw \\",
    "curl -u admin:" + "admin x", cu + '"1000:' + '1000pw" x', cu + '"1000' + ':1000:pw1" x',
    // digits before a password are no uid:gid unless the digits are the whole value
    cu + '"4242:' + '2024!Winter" x', cu + '"1000:' + '1000-s3cretpw" x', "cu" + 'rl --user="12:' + '345$tok3nvalue" x',
    "cu" + 'rl -u"55:' + '66#abcdef" x', cu + "1000:" + "1000-s3cretpw x"]) {
    assert.ok(scan(line).count > 0, `not caught: ${line}`);
  }
  for (const line of ["docker run -u $(id -u):$(id -g) img", 'docker run -u "$(id -u):$(id -g)" img', "date -u +%H:%M:%S",
    "date -u '+%H:%M:%S'", 'docker run -u "1000:1000" img', "user: -u '0:0'", "(docker run -u 1000:1000)",
    "docker run -u '1000:1000'; echo", "docker run -u 1000:1000|tee x"]) {
    assert.equal(scan(line).count, 0, `caught: ${line}`);
  }
});

test("a Docker secret file path and a module hash are public values, the same keys and shapes otherwise are not", () => {
  const key = "PASS" + "WORD_FILE";
  for (const line of ["ENV DB_" + key + " /run/secrets/db_password", "POSTGRES_" + key + "=/run/secrets/postgres_password",
    "  - MYSQL_ROOT_" + key + "=/run/secrets/mysql_root", "DB_" + key + ": /run/secrets/db", '"POSTGRES_' + key + '": "/run/secrets/pg"']) {
    assert.equal(scan(line).count, 0, `caught: ${line}`);
  }
  const hash = createHash("sha256").update("module").digest("base64"); // 43 characters and one =
  for (const line of [`github.com/x/y v1.2.3 h1:${hash}`, `github.com/x/y v1.2.3/go.mod h1:${hash}`, `    "h1:${hash}",`]) {
    assert.equal(scan(line).count, 0, `caught: ${line}`);
  }
  const other = createHash("sha512").update("module").digest("base64").slice(0, 50);
  for (const line of ["ENV DB_PASS" + "WORD /S3cr3t!x9", "DB_" + key + "=hunter22xyz", `h1:${other}`, `h1:${hash.slice(0, 43)}`,
    `xh1:${hash}`, "tok" + `en: "h1:${hash}"`]) {
    assert.ok(scan(line).count > 0, `not caught: ${line}`);
  }
  // Only the kinds that read a value after a key name skip the path: a key's own format still shows in it.
  assert.deepEqual(scan("API_" + key + "=/run/secrets/" + FAKES["aws-access-key"]).hits.map((h) => h.kind), ["aws-access-key"]);
});

test("a line of millions of base64 characters is scanned, not crashed: every repeat is bounded", () => {
  assert.deepEqual(readFileSync(SCAN, "utf8").match(/\{\d+,\}/g) ?? [], [], "an open repeat overflows V8's regex stack on a line of some 6 million characters");
  const dir = mkdtempSync(join(tmpdir(), "payload-scan-big-"));
  try {
    const big = join(dir, "big.md");
    writeFileSync(big, "data:image/png;base64," + "iVBORw0KGgo".repeat(640000) + "\n");
    const r = spawnSync(process.execPath, [SCAN, big], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // a nested repeat overflows too: a key marker before 3.5 million words (some 7 million characters)
  for (const head of ["-----BEGIN ", "-----END "]) {
    const line = head + "A ".repeat(3_500_000);
    assert.doesNotThrow(() => scan(line), head);
  }
});

test("a lockfile's integrity hash is a public checksum, not a secret", () => {
  for (const sri of ['"integrity": "sha512-' + RANDOMISH + RANDOMISH.slice(0, 40) + '=="', "integrity sha384-" + RANDOMISH, "sha256-" + RANDOMISH]) {
    assert.equal(scan(sri).count, 0, sri);
  }
  assert.deepEqual(scan("sha1-" + RANDOMISH).hits.map((h) => h.kind), ["high-entropy"], "only the SRI hash names are left out");
  assert.deepEqual(scan('"integrity": "sha512-x", "value": "' + RANDOMISH + '"').hits.map((h) => h.kind), ["high-entropy"],
    "a random value elsewhere on the line is still caught");
});

test("a long random-looking run is caught by its entropy, a long regular one is not", () => {
  assert.ok(entropy(RANDOMISH) >= 4.5);
  assert.deepEqual(scan(`value ${RANDOMISH}`).hits.map((h) => h.kind), ["high-entropy"]);
  assert.equal(scan("hash " + "0123456789abcdef".repeat(4)).count, 0, "hex digests stay under the floor");
  assert.equal(scan(x(48, "Q")).count, 0);
});

test("a private key is reported with the line of its END marker, or null when it never ends", () => {
  const block = ["intro", FAKES["private-key"], RANDOMISH, RANDOMISH, "-----END " + "RSA PRIVATE KEY-----", "after"].join("\n");
  const key = scan(block).hits.find((h) => h.kind === "private-key");
  assert.deepEqual(key, { line: 2, kind: "private-key", end: 5 });
  const open = scan(["intro", FAKES["private-key"], "MIIEow"].join("\n")).hits.find((h) => h.kind === "private-key");
  assert.equal(open.end, null);
  const pgp = ["-----BEGIN " + "PGP PRIVATE KEY BLOCK-----", "", RANDOMISH, "abc12", "=ab12", "-----END " + "PGP PRIVATE KEY BLOCK-----"];
  assert.deepEqual(scan(pgp.join("\n")).hits.find((h) => h.kind === "private-key"), { line: 1, kind: "private-key", end: 6 },
    "a PGP block is masked whole: its short last lines and checksum are no pattern of their own");
  const oneLine = ["intro", FAKES["private-key"] + " " + RANDOMISH + " -----END " + "RSA PRIVATE KEY-----"].join("\n");
  assert.deepEqual(scan(oneLine).hits.find((h) => h.kind === "private-key"), { line: 2, kind: "private-key", end: 2 },
    "a key that opens and closes on one line ends on that line");
});

test("each private key closes at the first END marker after it, in time linear in the lines", () => {
  const begin = FAKES["private-key"];
  const end = "-----END " + "RSA PRIVATE KEY-----";
  assert.deepEqual(scan([begin, "data", begin, end, begin].join("\n")).hits.filter((h) => h.kind === "private-key"),
    [{ line: 1, kind: "private-key", end: 4 }, { line: 3, kind: "private-key", end: 4 }, { line: 5, kind: "private-key", end: null }]);
  const many = Array.from({ length: 20000 }, () => begin).join("\n");
  const start = Date.now();
  const r = scan(many);
  assert.ok(Date.now() - start < 3000, `took ${Date.now() - start} ms`);
  assert.equal(r.count, 20000);
  assert.ok(r.hits.every((h) => h.end === null));
});

test("long lines take linear time, so a big generated file cannot stall the check", () => {
  // Each shape on its own: one long line against the same text cut into 16 lines. A linear pattern takes the same
  // time either way (about 1x); a quadratic one about 16 times as long on the one line, so a shape over 3x fails.
  // Both sides do the same work, timed in turn, best of five. The clock is CPU time on Linux and macOS, where load on
  // the machine does not count; on Windows a process's CPU time moves in clock ticks, so there it is wall time. A
  // shape between 3x and 6x is timed again, twice at most.
  const SHAPES = [["", "secret", 4000], ["postgres://", "a", 24000], ["", "password", 3000], ["", "pwd", 8000], ["", "a.", 12000],
    ["", "token=a|", 20000], ["", "pwd:", 10000], ["", "token=", 10000], ["", "--token=", 15000], ["", "credential=", 8000],
    ["", "secret_key:abc_def_ghi|", 2500], ["", "token:", 8000], ["", "DB_PASS=", 10000],
    [" -u", "=", 30000], [" --user", "=", 30000], [" -u ", "a:", 15000], ["ENV ", "PASS", 7500, " x"]];
  const clock = process.platform === "win32" ? () => Number(process.hrtime.bigint()) / 1e6
    : () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
  const ms = (t) => {
    const start = clock();
    scan(t);
    return clock() - start;
  };
  const ratio = (one, cut) => {
    ms(cut); // warm up
    ms(one);
    const a = [];
    const b = [];
    for (let i = 0; i < 5; i += 1) {
      b.push(ms(cut));
      a.push(ms(one));
    }
    return Math.min(...a) / Math.max(Math.min(...b), 0.001);
  };
  const slow = [];
  for (const [pre, unit, n, post = ""] of SHAPES) {
    const k = Math.round(n / 16);
    const one = pre + unit.repeat(16 * k) + post;
    const cut = Array.from({ length: 16 }, () => pre + unit.repeat(k) + post).join("\n");
    let r = ratio(one, cut);
    for (let again = 0; again < 2 && r >= 3 && r < 6; again += 1) r = Math.min(r, ratio(one, cut));
    if (r >= 3) slow.push(`${JSON.stringify(pre + unit)} ${r.toFixed(1)}x`);
  }
  assert.deepEqual(slow, [], "one line took over 3 times as long as the same text cut into 16 lines");
});

test("this test file is clean to the scanner itself: its fakes are assembled at run time", () => {
  const self = fileURLToPath(import.meta.url);
  assert.deepEqual(spawnSync(process.execPath, [SCAN, self], { encoding: "utf8" }).status, 0);
});

test("hits carry the line and the kind, never the matched text", () => {
  const r = scan(`ok\nkey ${FAKES["github-token"]}\n`);
  assert.deepEqual(r, { count: 1, hits: [{ line: 2, kind: "github-token" }] });
});

test("ordinary code and prose are clean", () => {
  const text = [
    "const risk-assessment-framework-version = 1;",
    "token: string;",
    'password = os.environ["APP_PASSWORD"]',
    "the AKIA prefix marks an AWS key",
    "ask-the-reviewer-to-confirm-everything",
    "OPENAI_API_KEY is read from the environment",
    "secret_key = os.getenv('SECRET_KEY')",
    "Authorization: Bearer <token>",
    "see https://example.com/docs/settings-reference",
    "/home/user/.claude/projects/-app-poc-build-plugin-banker-plugins/76f490b5-8ce6-450d-b136",
  ].join("\n");
  assert.deepEqual(scan(text), { count: 0, hits: [] });
});

test("an Anthropic key is reported once, not also as an OpenAI key", () => {
  const kinds = scan(FAKES["anthropic-key"]).hits.map((h) => h.kind);
  assert.deepEqual(kinds, ["anthropic-key"]);
});

test("the command line still reports when node keeps the symlink it was started through", { skip: process.platform === "win32" && "symlinks need privileges" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "payload-scan-link-"));
  try {
    symlinkSync(dirname(SCAN), join(dir, "refs"));
    const dirty = join(dir, "dirty.md");
    writeFileSync(dirty, `config ${FAKES["aws-access-key"]}\n`);
    const r = spawnSync(process.execPath, [join(dir, "refs", "payload-scan.mjs"), dirty], { encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "--preserve-symlinks-main" } });
    assert.equal(r.status, 1, "a key is not passed as clean by an empty exit 0");
    assert.equal(JSON.parse(r.stdout).count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the command line exits 0 when clean, 1 with hits and 2 when it cannot read one file", () => {
  const dir = mkdtempSync(join(tmpdir(), "payload-scan-"));
  try {
    const clean = join(dir, "clean.md");
    const dirty = join(dir, "dirty.md");
    writeFileSync(clean, "nothing here\n");
    writeFileSync(dirty, `config ${FAKES["aws-access-key"]}\n`);
    const run = (...args) => spawnSync(process.execPath, [SCAN, ...args], { encoding: "utf8" });
    assert.equal(run(clean).status, 0);
    const hit = run(dirty);
    assert.equal(hit.status, 1);
    assert.equal(JSON.parse(hit.stdout).count, 1);
    assert.ok(!hit.stdout.includes(FAKES["aws-access-key"]), "the report does not repeat the secret");
    assert.equal(run(join(dir, "missing.md")).status, 2);
    assert.equal(run().status, 2);
    const two = run(clean, dirty);
    assert.equal(two.status, 2, "a second file is not silently skipped");
    assert.equal(two.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 0.20.4 B3: a password key word after a space or a quote, the [REDACTED] mask, and a scan that throws
test("a password key after a space or a quote is caught, as when a *_FILE key comes first on its line", () => {
  const P = "PASS" + "WORD";
  const pw = "hunter" + "22xyz"; // letters and digits, 11 characters: only env-password reads it
  for (const line of [`POSTGRES_${P}_FILE=/run/secrets/pw POSTGRES_${P}=${pw}`, `docker run -e POSTGRES_${P}=${pw} postgres`,
    `env MYSQL_PWD=${pw} mysql`, `docker run -e "POSTGRES_${P}=${pw}" img`]) {
    assert.ok(scan(line).count > 0, `not caught: ${line}`);
  }
  for (const line of [`f(user=u, pass${"word"}=secret_value)`, `PG${P}=$PGPASS psql`, `POSTGRES_${P}_FILE=/run/secrets/pw`,
    `DB_${P}=<your-pass${"word"}>`]) {
    assert.equal(scan(line).count, 0, `caught: ${line}`);
  }
});

test("a value masked as SKILL.md says, [REDACTED], is clean to the scanner, so the mask-and-rescan loop ends", () => {
  const M = "[REDACTED]";
  for (const line of [`DB_PASS${"WORD"}=${M}`, `docker run -e POSTGRES_PASS${"WORD"}=${M} img`, `--pass${"word"} ${M}`,
    "curl -u admin" + ":" + M + " https://x", "postgres://admin" + ":" + M + "@db.internal:5432/app"]) {
    assert.equal(scan(line).count, 0, `caught: ${line}`);
  }
});

test("the command line exits 2 and prints no report when the scan itself throws", () => {
  // A regex that runs out of stack throws a RangeError inside scan; a preload makes one do so on this file's line.
  const dir = mkdtempSync(join(tmpdir(), "payload-scan-throw-"));
  try {
    const file = join(dir, "payload.md");
    writeFileSync(file, "a line the scan cannot finish\n");
    const pre = join(dir, "throw.mjs");
    writeFileSync(pre, ["const real = RegExp.prototype.test;",
      "RegExp.prototype.test = function (s) {",
      '  if (String(s).includes("the scan cannot finish")) throw new RangeError("Maximum call stack size exceeded");',
      "  return real.call(this, s);",
      "};", ""].join("\n"));
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(pre).href, SCAN, file], { encoding: "utf8" });
    assert.equal(r.status, 2, `an exception is no "hits found" (1): ${r.stderr}`);
    assert.equal(r.stdout, "", "no report that could be read as a result");
    assert.match(r.stderr, /^payload-scan: cannot scan .*payload\.md: Maximum call stack size exceeded$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
