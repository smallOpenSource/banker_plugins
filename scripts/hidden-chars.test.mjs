// The repository's text files hold no raw hidden character: a test or a doc that needs one writes it as an escape
// (\u{...}; a tool's JSON input turns the four-digit form into the raw character). The release kit's hidden-check only
// stops a file from holding more than its base did; this holds every file to none.
// Run from the repo root: node --test scripts/hidden-chars.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set([".git", "node_modules", ".omc"]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });
// Control characters but tab, line feed and carriage return; format characters (the zero-width ones, the byte order
// mark, direction marks, overrides and isolates); line and paragraph separators; private-use; and blanks that print as
// nothing or as a space a reader takes for another (the kit's set: U+00A0, U+2800, U+3000, U+3164).
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\u{00A0}\u{2800}\u{3000}\u{3164}]/u;
const ALLOWED = /[\t\n\r]/;

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

// The files git tracks here, or every file when this is no checkout (the boxes get an archive copy of the tracked
// files). git runs without the caller's GIT_* variables, so it reads this checkout and no other.
function repoFiles() {
  if (existsSync(join(ROOT, ".git"))) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
    const r = spawnSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) return r.stdout.split("\0").filter(Boolean).map((f) => join(ROOT, f));
  }
  return [...walk(ROOT)];
}

test("no text file in the repository holds a raw hidden character", () => {
  const found = [];
  for (const file of repoFiles()) {
    let text;
    try {
      text = UTF8.decode(readFileSync(file));
    } catch {
      continue; // not UTF-8 (a binary fixture), or tracked but gone from the working tree
    }
    text.split("\n").forEach((line, i) => {
      for (const c of line) if (HIDDEN.test(c) && !ALLOWED.test(c)) found.push(`${relative(ROOT, file)}:${i + 1} U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
    });
  }
  assert.deepEqual(found, []);
});
