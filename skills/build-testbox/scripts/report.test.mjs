// Unit tests: reasons and hints, exit codes, summary line, screen table equals summary.md, results.json schema.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../../../scripts/test-fixtures/testbox-fakes.mjs";
import {
  FAIL_REASON, STATUSES, UNSUPPORTED_REASONS, UNVERIFIED_REASONS, buildResults, cellOf, exitCodeOf, hintOf, renderSummary,
  summaryLine, tableLines, writeResults,
} from "./report.mjs";

const cell = (status, reason = "", extra = {}) => cellOf({ id: `x:${status}:${reason}`, group: "os", target: "rocky8" }, status, reason, extra);

test("every unverified and unsupported reason has a hint", () => {
  for (const r of UNVERIFIED_REASONS) assert.ok(hintOf(cell("unverified", r)).length > 0, r);
  for (const r of UNSUPPORTED_REASONS) assert.ok(hintOf(cell("unsupported", r)).length > 0, r);
  assert.match(hintOf(cell("unverified", "sandbox")), /승인/);
  assert.match(hintOf(cell("unverified", "needs-image")), /setup --images rocky8/);
  assert.match(hintOf({ group: "browser", status: "unverified", reason: "needs-image" }), /--playwright-image/);
  assert.match(hintOf({ group: "browser", status: "unverified", reason: "needs-browser", browser: "webkit" }), /setup --browsers webkit/);
  assert.match(hintOf(cell("unsupported", "apple-sla")), /Apple/);
  assert.match(hintOf(cell("unsupported", "tart-needs-apple-silicon")), /Apple Silicon/);
});

test("fail reasons have the documented shapes", () => {
  for (const r of ["exit-3", "exit-1", "http-404", "http-500", "page-error"]) assert.match(r, FAIL_REASON);
  for (const r of ["exit-", "http-x", "timeout"]) assert.doesNotMatch(r, FAIL_REASON);
});

test("exit codes: all pass 0, a fail 1, unverified 4, unsupported only 4", () => {
  assert.equal(exitCodeOf([cell("pass"), cell("pass")]), 0);
  assert.equal(exitCodeOf([cell("pass"), cell("fail", "exit-3"), cell("unverified", "timeout")]), 1);
  assert.equal(exitCodeOf([cell("pass"), cell("unverified", "needs-image")]), 4);
  assert.equal(exitCodeOf([cell("pass"), cell("unsupported", "apple-sla")]), 4);
  assert.equal(exitCodeOf([cell("unsupported", "apple-sla")]), 4);
});

test("summary first line holds the four counts", () => {
  const r = buildResults({ cells: [cell("pass"), cell("fail", "exit-1"), cell("unverified", "needs-tool"), cell("unverified", "timeout"), cell("unsupported", "apple-sla")], notes: [], host: {}, startedAt: new Date().toISOString(), out: "/x" });
  assert.equal(renderSummary(r).split("\n")[0], "pass 1, fail 1, unverified 2, unsupported 1");
  assert.equal(summaryLine({ pass: 0, fail: 0, unverified: 0, unsupported: 0 }), "pass 0, fail 0, unverified 0, unsupported 0");
  assert.equal(r.exitCode, 1);
});

test("summary.md and the screen text are the same rows; results.json follows the schema", () => {
  const out = tempDir();
  const r = buildResults({ cells: [cell("pass"), cell("unverified", "needs-image", { detail: "a | b" })], notes: ["브라우저 묶음 요청 안 됨(--url 없음)"], host: { platform: "linux" }, startedAt: new Date().toISOString(), out });
  writeResults(out, r);
  const md = readFileSync(join(out, "summary.md"), "utf8");
  assert.equal(md, renderSummary(r));
  for (const line of tableLines(r.cells)) assert.ok(md.includes(line));
  assert.match(md, /브라우저 묶음 요청 안 됨/);
  const json = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
  assert.equal(json.tool, "build-testbox");
  assert.equal(json.schema, 1);
  assert.deepEqual(Object.keys(json.counts), STATUSES);
  for (const c of json.cells) {
    for (const k of ["id", "group", "target", "status", "reason", "startedAt", "endedAt", "hint"]) assert.ok(k in c, k);
    assert.ok(STATUSES.includes(c.status));
    assert.ok(Date.parse(c.endedAt) >= Date.parse(c.startedAt));
  }
});

test("a pipe in a cell does not break the table", () => {
  const lines = tableLines([cellOf({ id: "a|b", group: "os", target: "t" }, "fail", "exit-1", { hint: "x|y" })]);
  assert.equal(lines[2].split(/(?<!\\)\|/).length, 7);
});

test("SKILL.md lists every reason, the exit codes and the --help first line", () => {
  const md = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  for (const r of [...UNVERIFIED_REASONS, ...UNSUPPORTED_REASONS, "exit-<n>", "http-<n>", "page-error"]) assert.ok(md.includes(`\`${r}\``), r);
  assert.match(md, /^---\nname: build-testbox\ndescription: "/);
  assert.match(md, /pass <n>, fail <n>, unverified <n>, unsupported <n>/);
});
