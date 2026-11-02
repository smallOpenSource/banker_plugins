// Guards against defect classes coming back anywhere in the shipped code (not only where they were fixed):
// a temporary or lock file named from the pid or the clock alone can be guessed, so a link can be planted at that
// name first, and Windows opens "wx" (O_EXCL) through a link to nothing and makes the file it leads to. Such names
// take random bytes (crypto.randomBytes, randomUUID, mkstemp) or are checked before and after the open.
// Run: node --test scripts/class-guards.test.mjs
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const shipped = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((f) => /\.(mjs|js|cjs|py)$/.test(f) && !/\.test\.|(^|\/)test_|^scripts\/|\/test-fixtures\//.test(f));

// Names guarded another way, with the reason.
const ALLOWED = new Map([
  ["skills/tone-compact/scripts/instruction-toggle.mjs", "writeFresh removes the name first and openNew compares the opened file with the name"],
  ["skills/anti-drm/scripts/instruction-toggle.mjs", "byte-identical copy of tone-compact's"],
]);

// A line that builds a file name from the pid or the clock with nothing random beside it.
const GUESSABLE = /(\$\{process\.pid\}|\$\{Date\.now\(\)[^}]*\}|os\.getpid\(\))/;
const RANDOM = /random(Bytes|UUID|Hex)|mkstemp|mkdtemp|Math\.random|rand\(\)/;
const NAMING = /(tmp|temp|lock|\.bak|\.part|\.new|key\.)/i;

test("no shipped file names a temporary or lock file from the pid or the clock alone", () => {
  assert.ok(shipped.length > 100, `found ${shipped.length} shipped files`);
  const hits = [];
  for (const f of shipped) {
    if (ALLOWED.has(f)) continue;
    readFileSync(join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|#)/.test(line)) return;
      if (GUESSABLE.test(line) && NAMING.test(line) && !RANDOM.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});
