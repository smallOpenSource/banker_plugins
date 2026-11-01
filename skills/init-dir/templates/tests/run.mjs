#!/usr/bin/env node
/**
 * tests/run.mjs: runs the test suites in tests/tests.conf and prints one short line per suite (made by banker
 * init-dir).
 *
 *   ./tests/run.sh [suite ...]        (Windows: tests\run.cmd)
 *
 * tests.conf lines are `<suite>=<command>`; the command runs through the shell in the project folder. A suite
 * with no command is SKIP. Each run prints `PASS <suite> (1.2s)` or `FAIL <suite> (0.3s, 종료 1)` with the last
 * lines of its output, then one summary line.
 *
 * Exit status: 0 every suite run passed, 1 a suite failed, 2 no settings (no tests.conf, no command to run, an
 * unknown suite name), 3 environment (the wrappers did not find Node 18 or later).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(TESTS);
const CONF = join(TESTS, "tests.conf");
const TAIL_LINES = 20;

function readSuites() {
  const suites = [];
  for (const raw of readFileSync(CONF, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (line.startsWith("#") || eq <= 0) continue;
    suites.push({ name: line.slice(0, eq).trim(), command: line.slice(eq + 1).trim() });
  }
  return suites;
}

function runSuite(suite) {
  const began = Date.now();
  const r = spawnSync(suite.command, { shell: true, cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const seconds = ((Date.now() - began) / 1000).toFixed(1);
  if (r.status === 0) return { pass: true, line: `PASS ${suite.name} (${seconds}s)` };
  const why = r.error ? r.error.message : r.status === null ? `신호 ${r.signal}` : `종료 ${r.status}`;
  const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split(/\r?\n/).filter((l) => l.trim() !== "");
  return { pass: false, line: `FAIL ${suite.name} (${seconds}s, ${why})`, tail: output.slice(-TAIL_LINES) };
}

function choose(suites, names) {
  if (names.length === 0) return { chosen: suites };
  const unknown = names.filter((n) => !suites.some((s) => s.name === n));
  if (unknown.length > 0) return { error: `tests.conf 에 없는 스위트: ${unknown.join(", ")}` };
  return { chosen: suites.filter((s) => names.includes(s.name)) };
}

function runAll(chosen) {
  const count = { pass: 0, fail: 0, skip: 0 };
  for (const suite of chosen) {
    if (suite.command === "") {
      count.skip++;
      console.log(`SKIP ${suite.name} (명령 없음)`);
      continue;
    }
    const r = runSuite(suite);
    count[r.pass ? "pass" : "fail"]++;
    console.log(r.line);
    for (const line of r.tail ?? []) console.log(`  ${line}`);
  }
  console.log(`결과: 통과 ${count.pass}, 실패 ${count.fail}, 건너뜀 ${count.skip}`);
  return count.fail > 0 ? 1 : 0;
}

function usageError(text) {
  console.error(text);
  return 2;
}

function main(names) {
  if (!existsSync(CONF)) return usageError(`설정 파일 없음: ${CONF}`);
  const { chosen, error } = choose(readSuites(), names);
  if (error) return usageError(error);
  if (!chosen.some((s) => s.command !== "")) return usageError(`실행할 명령 없음: ${CONF} 의 unit=, integration= 을 채우세요`);
  return runAll(chosen);
}

process.exitCode = main(process.argv.slice(2));
