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
 * Each suite has a time limit, 600 seconds unless `timeout=<seconds>` in tests.conf or the environment variable
 * TESTS_TIMEOUT_SECONDS (which wins) says otherwise. A suite past it is `FAIL <suite> (600.0s, timeout 600초)` and
 * its whole process tree is killed (its process group on POSIX, taskkill /T /F on Windows). `timeout` is therefore
 * not a suite name.
 *
 * Exit status: 0 every suite run passed, 1 a suite failed, 2 no settings (no tests.conf, no command to run, an
 * unknown suite name), 3 environment (the wrappers did not find Node 18 or later).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(TESTS);
const CONF = join(TESTS, "tests.conf");
const TAIL_LINES = 20;
const KEEP_BYTES = 1024 * 1024;
const WIN = process.platform === "win32";
const DEFAULT_TIMEOUT_S = 600;

// The suites and the time limit in seconds: { suites, timeout }. `timeout=` sets the limit, every other key is a suite.
function readConf() {
  const suites = [];
  let timeout = DEFAULT_TIMEOUT_S;
  for (const raw of readFileSync(CONF, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (line.startsWith("#") || eq <= 0) continue;
    const [key, value] = [line.slice(0, eq).trim(), line.slice(eq + 1).trim()];
    if (key === "timeout") timeout = seconds(value) ?? timeout;
    else suites.push({ name: key, command: value });
  }
  return { suites, timeout: seconds(process.env.TESTS_TIMEOUT_SECONDS) ?? timeout };
}

function seconds(text) {
  const n = Number(text);
  return text && Number.isFinite(n) && n > 0 ? n : null;
}

// The suite's whole tree: its process group on POSIX (it runs detached), taskkill /T /F on Windows.
function killTree(child) {
  // The shell may be gone while what it started still holds the output pipes, so the group is killed regardless.
  if (!child.pid) return;
  if (WIN) spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // the group is gone already
    }
  }
}

// Output kept for the failure tail: the last KEEP_BYTES of stdout and stderr together.
function collector() {
  let text = "";
  const add = (chunk) => {
    text = (text + chunk).slice(-KEEP_BYTES);
  };
  return { add, lines: () => text.split(/\r?\n/).filter((l) => l.trim() !== "") };
}

let current = null;

// Runs one suite: { code, signal, error, timedOut, output }.
function spawnSuite(suite, limitS) {
  return new Promise((done) => {
    const out = collector();
    const child = spawn(suite.command, { shell: true, cwd: ROOT, detached: !WIN, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    current = child;
    let timedOut = false;
    let error = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, limitS * 1000);
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", out.add);
    }
    child.on("error", (e) => {
      error = e;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      current = null;
      done({ code, signal, error, timedOut, output: out.lines() });
    });
  });
}

async function runSuite(suite, limitS) {
  const began = Date.now();
  const r = await spawnSuite(suite, limitS);
  const took = ((Date.now() - began) / 1000).toFixed(1);
  if (r.code === 0 && !r.timedOut) return { pass: true, line: `PASS ${suite.name} (${took}s)` };
  const why = r.timedOut ? `timeout ${limitS}초` : r.error ? r.error.message : r.code === null ? `신호 ${r.signal}` : `종료 ${r.code}`;
  return { pass: false, line: `FAIL ${suite.name} (${took}s, ${why})`, tail: r.output.slice(-TAIL_LINES) };
}

function choose(suites, names) {
  if (names.length === 0) return { chosen: suites };
  const unknown = names.filter((n) => !suites.some((s) => s.name === n));
  if (unknown.length > 0) return { error: `tests.conf 에 없는 스위트: ${unknown.join(", ")}` };
  return { chosen: suites.filter((s) => names.includes(s.name)) };
}

async function runAll(chosen, limitS) {
  const count = { pass: 0, fail: 0, skip: 0 };
  for (const suite of chosen) {
    if (suite.command === "") {
      count.skip++;
      console.log(`SKIP ${suite.name} (명령 없음)`);
      continue;
    }
    const r = await runSuite(suite, limitS);
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

async function main(names) {
  if (!existsSync(CONF)) return usageError(`설정 파일 없음: ${CONF}`);
  const conf = readConf();
  const { chosen, error } = choose(conf.suites, names);
  if (error) return usageError(error);
  if (!chosen.some((s) => s.command !== "")) return usageError(`실행할 명령 없음: ${CONF} 의 unit=, integration= 을 채우세요`);
  return runAll(chosen, conf.timeout);
}

// A suite runs in its own process group, so Ctrl+C or a stop of run.mjs does not reach it by itself: pass it on.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  process.on(signal, () => {
    if (current) killTree(current);
    process.exit(code);
  });
}

process.exitCode = await main(process.argv.slice(2));
