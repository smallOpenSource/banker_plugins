// Tests that no tracked file holds a whole secret-shaped value. The tests that need fake secrets (lineage's redaction
// corpus, ralph-qa's payload scan) build them from pieces ("AKIA" + "IOSF..."), so a secret scanner (GitHub secret
// scanning, gitleaks) sees no key in the repository or its history. A formatter can join adjacent string pieces again
// (ruff format joined "AKIA" "IOSF..." into one literal, 2026-10-29); this test catches that before a commit is pushed.
// Write the pieces with an explicit + inside parentheses, which formatters leave alone.
// Run from anywhere: node --test <repo>/scripts/fake-secrets.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The shapes secret scanners report. Each is written so this file does not match itself.
const SHAPES = [
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["private key block", /-----BEGIN [A-Z ]{0,20}PRIVATE KEY(?: BLOCK)?-----/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/],
  ["Slack token", /\bxox[abprs]-[0-9]{6,}-/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
];

// The files git tracks; outside a git checkout, every file under the repository but dependencies and ignored work.
function files() {
  const git = spawnSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8" });
  if (git.status === 0) return git.stdout.split("\0").filter(Boolean);
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git" || name === "__pycache__") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(ROOT, p));
    }
  };
  walk(ROOT);
  return out;
}

test("no tracked file holds a whole secret-shaped value (fake secrets are built from pieces)", () => {
  const found = [];
  for (const f of files()) {
    let buf;
    try {
      buf = readFileSync(join(ROOT, f));
    } catch {
      continue;
    }
    if (buf.length > 8 << 20 || buf.includes(0)) continue;
    const lines = buf.toString("utf8").split("\n");
    lines.forEach((line, i) => {
      for (const [what, re] of SHAPES) if (re.test(line)) found.push(`${f}:${i + 1}: ${what}`);
    });
  }
  assert.deepEqual(found, [], `split these into pieces joined by an explicit + inside parentheses:\n${found.join("\n")}`);
});

test("the shapes catch what they are for", () => {
  const sample = (...parts) => parts.join("");
  const hit = (s) => SHAPES.filter(([, re]) => re.test(s)).map(([w]) => w);
  assert.deepEqual(hit(sample("AKIA", "IOSFODNN7EXAMPLE")), ["AWS access key id"]);
  assert.deepEqual(hit(sample("-----BEGIN RSA ", "PRIVATE KEY-----")), ["private key block"]);
  assert.deepEqual(hit(sample("gh", "p_", "a".repeat(36))), ["GitHub token"]);
  assert.deepEqual(hit(sample("xox", "b-", "1234567890-abc")), ["Slack token"]);
  assert.deepEqual(hit('"AKIA" + "IOSFODNN7EXAMPLE"'), [], "pieces joined by + are not a key");
});
