// Guards against defect classes coming back anywhere in the shipped code (not only where they were fixed):
// a temporary or lock file named from the pid or the clock alone can be guessed, so a link can be planted at that
// name first, and Windows opens "wx" (O_EXCL) through a link to nothing and makes the file it leads to. Such names
// take random bytes (crypto.randomBytes, randomUUID, mkstemp) or are checked before and after the open.
// Run: node --test scripts/class-guards.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The files git tracks here, or every file when this is no checkout: the boxes get an archive copy of the tracked
// files only (as hidden-chars.test.mjs does). work/ is skipped there too: tests write their fixtures into it while
// this runs. git runs without the caller's GIT_* variables, so it reads this checkout and no other.
const SKIP = new Set([".git", "node_modules", ".omc", "work"]);
function* walk(dir, rel = "") {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(join(dir, e.name), r);
    else if (e.isFile()) yield r;
  }
}
function repoFiles() {
  if (existsSync(join(ROOT, ".git"))) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
    const r = spawnSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) return r.stdout.split("\0").filter(Boolean);
  }
  return [...walk(ROOT)];
}
const shipped = repoFiles()
  .filter((f) => /\.(mjs|js|cjs|py)$/.test(f) && !/\.test\.|(^|\/)test_|^scripts\/|\/test-fixtures\//.test(f));

// Names guarded another way, with the reason.
const ALLOWED = new Map([
  ["skills/tone-compact/scripts/instruction-toggle.mjs", "writeFresh removes the name first and openNew compares the opened file with the name"],
  ["skills/anti-drm/scripts/instruction-toggle.mjs", "byte-identical copy of tone-compact's"],
  ["skills/ralph-qa/references/seat-payload.mjs", "writes only inside its run folder, made by mkdtemp under this account's base folder; the runner may not load node:crypto (smoke S25-b)"],
]);

// A line that builds a file name from the pid or the clock (in a template or joined with +) with no random call
// beside it, or that writes a fixed-suffix temporary name without "wx".
const GUESSABLE = /\$\{\s*(process\.pid|Date\.now\(\))|[`'"]\s*\+\s*(process\.pid|Date\.now\(\))|(process\.pid|Date\.now\(\)[\w.()]*)\s*\+\s*[`'"]|os\.getpid\(\)/;
const RANDOM = /random(Bytes|UUID|Hex)\(|mkstemp\(|mkdtemp(Sync)?\(|Math\.random\(\)|\brand\(\)/;
const NAMING = /(tmp|temp|lock|\.bak|\.part|\.new|key\.)/i;
// where a name is made: assigned to a name-like variable, or passed to join() or with_name()
const NAME_BUILT = /(^|\b(const|let|var)\s+)\s*\w*(tmp|temp|lock|bak|part|key|name|path|file)\w*\s*=(?!=)|\bjoin\(|with_name\(/i;
const FIXED_TEMP_WRITE = /writeFileSync\([^,]*[`'"][^`'"]*\.(tmp|part|new)[`'"]/;

test("no shipped file names a temporary or lock file from the pid or the clock alone", () => {
  assert.ok(shipped.length > 100, `found ${shipped.length} shipped files`);
  const hits = [];
  for (const f of shipped) {
    if (ALLOWED.has(f)) continue;
    readFileSync(join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|#)/.test(line)) return;
      const guessed = GUESSABLE.test(line) && NAMING.test(line) && NAME_BUILT.test(line) && !RANDOM.test(line);
      const fixed = FIXED_TEMP_WRITE.test(line) && !/flag:\s*['"]wx/.test(line);
      if (guessed || fixed) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("the guard's patterns catch the shapes they are for (template, joined, Python, fixed suffix)", () => {
  const caught = (line) => {
    const guessed = GUESSABLE.test(line) && NAMING.test(line) && NAME_BUILT.test(line) && !RANDOM.test(line);
    return guessed || (FIXED_TEMP_WRITE.test(line) && !/flag:\s*['"]wx/.test(line));
  };
  assert.ok(caught("const tmp = `${file}.${process.pid}.tmp`;"));
  assert.ok(caught('const tmp = file + "." + process.pid + ".tmp";'));
  assert.ok(caught('tmp = path.with_name("%s.%d" % (path.name, os.getpid()))  # key.tmp'));
  assert.ok(caught("fs.writeFileSync(`${target}.a4p-tmp`, out);") === false, "a name built in a variable is seen where the variable is made");
  assert.ok(caught("fs.writeFileSync('out.tmp', data);"));
  assert.equal(caught("const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;"), false);
  assert.equal(caught("writeFileSync(lock, `${process.pid} ${iso(Date.now())}\\n`, { flag: 'wx' });"), false, "a lock's contents, not its name");
});

