// Tests that every PowerShell block in the skills and commands parses in Windows PowerShell 5.1.
// Run from anywhere: node --test <repo>/scripts/powershell-syntax.test.mjs
//
// The maintainer writes these blocks on Linux with pwsh 7, which takes syntax 5.1 refuses (&&, ||, the ternary,
// ?.), and setup-pwsh's blocks run in 5.1 by design. pwsh 7 takes more than 5.1, so only Windows PowerShell 5.1
// can judge them: elsewhere that test is skipped, and the box suite runs it on the Windows box.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FENCE = /^(\s*)```(powershell|pwsh|ps1)\s*$/;
const CLOSE = /^\s*```\s*$/;
const BOM = String.fromCharCode(0xfeff);

// The PowerShell blocks of a markdown text: { line, code }, with the fence's indent taken off each line.
function psBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i]);
    if (!m) continue;
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !CLOSE.test(lines[j]); j++) {
      const lead = lines[j].length - lines[j].trimStart().length;
      body.push(lines[j].slice(Math.min(m[1].length, lead)));
    }
    blocks.push({ line: i + 1, code: body.join("\n") });
    i = j;
  }
  return blocks;
}

// A placeholder a person fills in (<설치된 버전>, <경로>) becomes a word, so only real syntax is judged. PowerShell
// has no < operator, so <...> on one line is a placeholder or text inside a string.
const withoutPlaceholders = (code) => code.replace(/<[^<>\n]+>/g, "PLACEHOLDER");

// The markdown files under skills/ and commands/.
function docs() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && e.name !== "node_modules") walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  };
  for (const top of ["skills", "commands"]) walk(join(ROOT, top));
  return out.sort();
}

const works = (bin, args) => spawnSync(bin, args, { encoding: "utf8" }).status === 0;
const powershell51 = process.platform === "win32" &&
  works("powershell.exe", ["-NoProfile", "-Command", "if ($PSVersionTable.PSVersion.Major -ne 5) { exit 1 }"]);

// ASCII only: Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page. The results go to a UTF-8
// file, since 5.1 writes the console code page (949 on Korean Windows) into a pipe.
const PARSE = [
  "param([string]$Dir)",
  "$out = New-Object 'System.Collections.Generic.List[string]'",
  "Get-ChildItem -LiteralPath $Dir -Filter 'b*.ps1' | Sort-Object Name | ForEach-Object {",
  "  $name = $_.BaseName; $tokens = $null; $errs = $null",
  "  [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errs)",
  "  foreach ($e in $errs) { $out.Add($name + \"`t\" + $e.Extent.StartLineNumber + \"`t\" + ($e.Message -replace '\\s+', ' ')) }",
  "}",
  "[System.IO.File]::WriteAllLines((Join-Path $Dir 'result.tsv'), [string[]]$out, (New-Object System.Text.UTF8Encoding $false))",
].join("\r\n");

// The parse errors Windows PowerShell 5.1 finds in each code: [{ index, line, message }].
function parse51(codes) {
  const dir = mkdtempSync(join(tmpdir(), "ps51-syntax-"));
  try {
    codes.forEach((c, i) => writeFileSync(join(dir, `b${String(i).padStart(4, "0")}.ps1`), `${BOM}${c.replace(/\n/g, "\r\n")}\r\n`));
    writeFileSync(join(dir, "parse.ps1"), PARSE);
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      join(dir, "parse.ps1"), dir], { encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    return readFileSync(join(dir, "result.tsv"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => {
      const [name, line, message] = l.split("\t");
      return { index: Number(name.slice(1)), line: Number(line), message };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("PowerShell blocks are found in fences, indented ones too, with their line numbers", () => {
  const text = ["# t", "```powershell", "Get-Item .", "```", "- step", "   ```powershell", "   $a = 1", "   ```", ""].join("\n");
  assert.deepEqual(psBlocks(text), [{ line: 2, code: "Get-Item ." }, { line: 6, code: "$a = 1" }]);
});

test("placeholders become a word, and operators and redirections stay", () => {
  assert.equal(withoutPlaceholders("nvm use <설치된 버전>"), "nvm use PLACEHOLDER");
  const plain = "git status 2>&1 > out.txt; if ($a -lt 3) { 'x' }";
  assert.equal(withoutPlaceholders(plain), plain);
});

test("the skills and commands hold PowerShell blocks to check", () => {
  const n = docs().reduce((sum, f) => sum + psBlocks(readFileSync(f, "utf8")).length, 0);
  assert.ok(n >= 20, `${n} blocks`);
});

test("every PowerShell block parses in Windows PowerShell 5.1", { skip: !powershell51 && "Windows PowerShell 5.1 is not here (only it can judge 5.1 syntax)" }, () => {
  const blocks = docs().flatMap((f) => psBlocks(readFileSync(f, "utf8")).map((b) => ({ ...b, file: relative(ROOT, f) })));
  const errors = parse51([...blocks.map((b) => withoutPlaceholders(b.code)), "Write-Output 1 && Write-Output 2"]);
  assert.ok(errors.some((e) => e.index === blocks.length), "a known 5.1 syntax error is found, so a pass means something");
  const found = errors.filter((e) => e.index < blocks.length).map((e) => `${blocks[e.index].file}:${blocks[e.index].line + e.line}: ${e.message}`);
  assert.deepEqual(found, []);
});
