#!/usr/bin/env node
/**
 * payload-scan: secret-like strings in a file that is about to go to an external CLI seat.
 *
 *   node payload-scan.mjs <file>
 *
 * Prints {"file", "count", "hits": [{"line", "kind"}]} and exits 0 when nothing was found,
 * 1 when something was, 2 when the file cannot be read or scanned or the arguments are not one
 * file. A private key hit also carries `end`, the line of its END marker (null when there is
 * none): the whole block is the secret, not just the BEGIN line. The matched text itself is never
 * printed, so the report cannot become the leak. The patterns cover common key and token
 * formats, private key blocks (PGP too), secret assignments (quoted, or unquoted with letters
 * and digits), passwords (quoted, with a symbol, alone on a config or env-file line, or after a
 * Dockerfile `ENV KEY value`), secrets given as command-line flags, curl's user and password flag,
 * hex keys, Basic and Bearer credentials, credentials in URLs and
 * long high-entropy strings (a lockfile's sha512- integrity hash and a Go or Terraform h1: hash
 * aside); they do not prove a payload clean. A Docker secret file's path after a *_FILE key is
 * not read as the password it points to. Every repeat and lookahead is bounded (a run longer than
 * 65536 characters is read in pieces) or anchored, so a long line takes linear time and cannot
 * overflow the regex stack.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SECRET_KEY = String.raw`(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|credential|비밀번호|패스워드)[\w-]{0,64}["']?\s*[:=]\s*`;
// `pass` and `passphrase` count only as a word of their own (DB_PASS, "pass"), not inside bypass.
const PASS_WORD = String.raw`(?:passw(?:or)?d|pwd|passcode|(?<![a-z])pass(?:phrase)?(?![a-z]))`;
const PASSWORD_KEY = String.raw`(?:${PASS_WORD}|비밀번호|패스워드)[\w-]{0,64}["']?\s*[:=]\s*`;
// An unquoted value that is not code: none of the characters an expression or a reference
// holds, and at least one symbol (an identifier has none).
const BARE = String.raw`[^\s;,"'().\[\]{}$<>]`;
const PRIVATE_KEY = String.raw`(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----`;

export const PATTERNS = [
  ["aws-access-key", /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/],
  ["github-token", /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,65536}|github_pat_[A-Za-z0-9_]{22,65536})/],
  ["gitlab-token", /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,65536}/],
  ["anthropic-key", /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,65536}/],
  ["openai-key", /(?<![A-Za-z0-9-])sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,65536}/],
  ["stripe-key", /(?<![A-Za-z0-9])[rs]k_(?:live|test)_[A-Za-z0-9]{16,65536}/],
  ["npm-token", /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/],
  ["huggingface-token", /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,65536}/],
  ["google-api-key", /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/],
  ["slack-token", /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,65536}/],
  ["slack-webhook", /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/],
  ["private-key", new RegExp(`-----BEGIN ${PRIVATE_KEY}`)],
  ["jwt", /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,65536}\.eyJ[A-Za-z0-9_-]{10,65536}\.[A-Za-z0-9_-]{10,65536}/],
  ["bearer-token", /\bbearer\s+[A-Za-z0-9._~+/-]{20,65536}/i],
  ["basic-auth", /\bauthorization["']?\s*[:=]\s*["']?basic\s+[A-Za-z0-9+/=]{8,65536}/i],
  ["url-credentials", /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{0,256}:[^\s@/]{3,256}@/i],
  // quoted: 12 characters or more, or 8 to 11 holding a digit (a word like "development" is not one)
  ["assigned-secret", new RegExp(SECRET_KEY + String.raw`["'](?:[^"'\s]{12,256}|(?=[^"'\s]{0,10}\d)[^"'\s]{8,11})["']`, "i")],
  ["assigned-secret-bare", new RegExp(SECRET_KEY + String.raw`(?=[^\s"']{0,256}\d)(?=[^\s"']{0,256}[A-Za-z])[^\s"'(\[{]{12,256}`, "i")],
  ["assigned-password", new RegExp(PASSWORD_KEY + String.raw`(?:["'][^"'\s]{6,256}["']|(?=${BARE}{0,256}[^\w\s;,"'().\[\]{}$<>])${BARE}{6,256})`, "i")],
  ["env-password", /^[+\- ]?\s*(?:export\s+)?[A-Za-z0-9_]{0,64}(?:passw(?:or)?d|pwd|passcode)[A-Za-z0-9_]{0,64}=[^\s$"'][^\s"']{5,256}/i],
  // a password alone on a config line: YAML, compose lists, .properties, Dockerfile ENV, diff marks
  ["config-password", new RegExp(String.raw`^[+\- ]?\s*(?:-\s+|export\s+|ENV\s+)?[\w.-]{0,64}${PASS_WORD}[\w.-]{0,64}["']?\s*[:=]\s*["']?(?![-$<{%])[^\s"',;()\[\]{}]{6,256}["']?\s*(?:#.*)?$`, "i")],
  // a Dockerfile's legacy `ENV KEY value` form, the value alone after the space
  ["dockerfile-env-password", new RegExp(String.raw`^[+\- ]?\s*ENV\s+[\w.-]{0,64}${PASS_WORD}[\w.-]{0,64}\s+["']?(?![-$<{%])[^\s"',;()\[\]{}=]{6,256}["']?\s*(?:#.*)?$`, "i")],
  ["flag-secret", /--(?:password|passwd|pass|token|api-key|apikey|secret|client-secret)(?:=|\s+)(?![-$])[^\s"']{6,256}/i],
  // curl's -u flag with a user and password pair, glued to it or not; a uid:gid (docker), a
  // host:/path (rsync), a date format (date -u +%H:%M) or an id substitution ($(id -u):$(id -g))
  // is no credential. A user:group of names is not told apart: that would let admin:admin through.
  ["curl-user", /(?<!\S)(?:-u\s*|--user(?:\s+|=))(?!\d{1,10}:\d{1,10}\b(?![:@]))(?!["']?\+%|\))[^\s:=]{1,256}:(?!\/)\S{3,256}/],
  ["assigned-hex", /(?:key|auth|token|secret)[\w-]{0,64}["']?\s*[:=]\s*["']?[0-9a-f]{32,65536}(?![0-9a-z])/i],
];

// Long runs of base64-like characters whose Shannon entropy is that of random data, as
// lineage's redaction measures them (32 characters or more, 4.5 bits per character or more).
const LONG_RUN = /[A-Za-z0-9+/=]{32,65536}/g;
const ENTROPY_FLOOR = 4.5;

export function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

// A subresource-integrity hash (`sha512-<base64>`, as lockfiles hold) and a Go module or
// Terraform lock hash (`h1:` and 43 base64 characters and `=`, as go.sum and .terraform.lock.hcl
// hold) are public checksums.
const SRI_PREFIX = /sha(?:256|384|512)-$/;
const H1_PREFIX = /(?:^|[^A-Za-z0-9+/=])h1:$/;
const publicHash = (line, m) => SRI_PREFIX.test(line.slice(Math.max(0, m.index - 7), m.index))
  || (/^[A-Za-z0-9+/]{43}=$/.test(m[0]) && H1_PREFIX.test(line.slice(Math.max(0, m.index - 4), m.index)));
const highEntropy = (line) => [...line.matchAll(LONG_RUN)].some((m) => !publicHash(line, m) && entropy(m[0]) >= ENTROPY_FLOOR);

// A *_FILE key's absolute path, the Docker secret file official images take a password from, is
// not that password: the kinds that read a value after a key name see a `-` there instead. The
// other kinds still read the line as it is, so a key's own format shows wherever it sits.
const SECRET_FILE_PATH = /(?<![\w.-])([\w.-]{0,128}_FILE["']?(?:[ \t]*[:=][ \t]*|[ \t]+)["']?)\/[\w.@-]{1,128}(?:\/[\w.@-]{1,128}){0,32}(?=["']?(?:[\s,;#]|$))/gi;
const KEYED = new Set(["assigned-secret", "assigned-secret-bare", "assigned-password", "env-password", "config-password",
  "dockerfile-env-password"]);

const KEY_END = new RegExp(`-----END ${PRIVATE_KEY}`);

// Each line's secret-like kinds, once per kind and line. A private key closes at the first END
// marker at or after its line: the END lines are found once and walked with the lines, so many
// BEGIN lines without an END still take linear time.
export function scan(text) {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  const ends = lines.flatMap((l, i) => (KEY_END.test(l) ? [i + 1] : []));
  let next = 0;
  lines.forEach((line, i) => {
    while (next < ends.length && ends[next] < i + 1) next += 1;
    const keyed = line.replace(SECRET_FILE_PATH, "$1-");
    for (const [kind, re] of PATTERNS) {
      if (!re.test(KEYED.has(kind) ? keyed : line)) continue;
      hits.push(kind === "private-key" ? { line: i + 1, kind, end: ends[next] ?? null } : { line: i + 1, kind });
    }
    if (highEntropy(line)) hits.push({ line: i + 1, kind: "high-entropy" });
  });
  return { count: hits.length, hits };
}

function main(argv) {
  if (argv.length !== 1) {
    process.stderr.write("usage: node payload-scan.mjs <file>  (exactly one file)\n");
    return 2;
  }
  const file = argv[0];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    process.stderr.write(`payload-scan: cannot read ${file}: ${e.code ?? e.message}\n`);
    return 2;
  }
  let result;
  try {
    result = scan(text);
  } catch (e) {
    process.stderr.write(`payload-scan: cannot scan ${file}: ${e.message}\n`);
    return 2;
  }
  process.stdout.write(JSON.stringify({ file, ...result }, null, 2) + "\n");
  return result.count === 0 ? 0 : 1;
}

const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
