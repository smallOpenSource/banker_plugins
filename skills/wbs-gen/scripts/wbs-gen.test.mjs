// Run: node --test skills/wbs-gen/scripts/wbs-gen.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { businessDays, parseHolidays, resolveDate, weeks } from "./wg-dates.mjs";
import { parseIcs, publicHolidays } from "./wg-holidays.mjs";
import { toHtml } from "./wg-html.mjs";
import { layout } from "./wg-plan.mjs";
import { colName, sheetName, toXlsx } from "./wg-xlsx.mjs";
import { crc32 } from "./wg-zip.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "wbs-gen.mjs");
const example = () => JSON.parse(readFileSync(join(HERE, "..", "assets", "example.json"), "utf8"));
const RANGE = { start: "2026-07-22", end: "2026-08-28" };

function run(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 30000 });
}

/** Reads a ZIP made by wg-zip.mjs: { name: Buffer } from the central directory, checking each CRC. */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const crc = buf.readUInt32LE(p + 16);
    const comp = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = inflateRawSync(buf.subarray(dataAt, dataAt + comp));
    assert.equal(crc32(data), crc, `crc of ${name}`);
    out[name] = data.toString("utf8");
    p += 46 + nameLen;
  }
  return out;
}

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("month/day dates take the year that puts them in the project, also across a new year", () => {
  assert.deepEqual(resolveDate("8/3", RANGE), { key: "2026-08-03", inRange: true });
  assert.deepEqual(resolveDate("2026-09-01", RANGE), { key: "2026-09-01", inRange: false });
  const winter = { start: "2026-12-20", end: "2027-01-15" };
  assert.deepEqual(resolveDate("1/5", winter), { key: "2027-01-05", inRange: true });
  assert.deepEqual(resolveDate("12/31", winter), { key: "2026-12-31", inRange: true });
  assert.equal(resolveDate("2/30", RANGE), null);
  assert.equal(resolveDate("다음 주", RANGE), null);
});

test("a holiday list reads commas, spaces and new lines, and 없음", () => {
  const h = parseHolidays("8/17, 08/15\n10/3 2/30 없음", RANGE);
  assert.deepEqual([...h.keys].sort(), ["2026-08-15", "2026-08-17"]);
  assert.deepEqual(h.outside, ["10/3"]);
  assert.deepEqual(h.bad, ["2/30"]);
  assert.equal(parseHolidays("없음", RANGE).keys.size, 0);
});

test("working days skip weekends and holidays, and weeks start on Monday", () => {
  const days = businessDays(RANGE.start, RANGE.end, new Set(["2026-08-17"]));
  assert.equal(days.length, 27);
  assert.ok(!days.includes("2026-08-17") && !days.includes("2026-07-25"));
  const w = weeks(days);
  assert.deepEqual(w.map((x) => x.count), [3, 5, 5, 5, 4, 5]);
  assert.deepEqual(w.map((x) => x.label), ["W1", "W2", "W3", "W4", "W5", "W6"]);
});

test("the example plan lays out like the reference sheet", () => {
  const { errors, model } = layout(example());
  assert.deepEqual(errors, []);
  assert.equal(model.days.length, 27);
  assert.equal(model.gates[0].col, model.days.findIndex((d) => d.key === "2026-08-03"));
  const t = model.rows.find((r) => r.cells[0] === "1.1");
  assert.equal(t.cells[7], 6);
  assert.equal(t.bar, "5DADE2");
  assert.equal(model.rows.find((r) => r.cells[0] === "2.2").bar, "FAD7A0", "선택 takes the bars colour");
  assert.ok(model.rows.find((r) => r.cells[0] === "C-1").dotted);
  assert.ok(!model.legend.some((l) => l.label === "공통"), "a part with legend false is left out");
  assert.match(model.title, /27 영업일/);
});

test("plan errors are reported, not drawn", () => {
  const bad = example();
  bad.rows.push({ kind: "milestone", wbs: "X1", date: "08/17" });
  bad.rows.push({ kind: "task", wbs: "X2", start: "08/20", end: "08/10" });
  bad.rows.push({ kind: "task", wbs: "X3", start: "09/01", end: "09/02" });
  bad.rows.push({ kind: "task", wbs: "X4", start: "08/04", end: "08/05", part: "nope" });
  bad.rows.push({ kind: "bar", wbs: "X5" });
  bad.parts.plan.dark = "red;background:url(x)";
  const { errors, model } = layout(bad);
  assert.equal(model, null);
  const all = errors.join("\n");
  for (const want of ["주말이나 공휴일", "종료가 시작보다 앞섬", "기간 밖", "parts 에 없는 part", "kind 는", "16진수"]) {
    assert.ok(all.includes(want), `missing: ${want}\n${all}`);
  }
  assert.deepEqual(layout({ start: "x" }).model, null);
  assert.deepEqual(layout([]).errors, ["plan 은 JSON 객체여야 함"]);
});

test("the XLSX holds the reference layout: frozen 8x3, A3 landscape one page wide, print titles, merges", () => {
  const plan = example();
  plan.rows[1].task = "A <b> & \"C\" \u0001 끝";
  const files = unzip(toXlsx(layout(plan).model));
  const sheet = files["xl/worksheets/sheet1.xml"];
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/sharedStrings.xml"]) {
    assert.ok(files[name], name);
  }
  assert.match(sheet, /<pane xSplit="8" ySplit="3" topLeftCell="I4" activePane="bottomRight" state="frozen"\/>/);
  assert.match(sheet, /<pageSetup paperSize="8" orientation="landscape" fitToWidth="1" fitToHeight="0"\/>/);
  assert.match(sheet, /<pageSetUpPr fitToPage="1"\/>/);
  assert.match(sheet, /<mergeCells count="15">/);
  assert.match(files["xl/workbook.xml"], /_xlnm\.Print_Titles" localSheetId="0">'WBS 간트'!\$1:\$3</);
  assert.ok(files["xl/sharedStrings.xml"].includes("A &lt;b&gt; &amp; &quot;C&quot;  끝"), "escaped, control character dropped");
  assert.match(files["xl/styles.xml"], /<fills count="\d+"><fill><patternFill patternType="none"\/><\/fill><fill><patternFill patternType="gray125"\/>/);
  assert.match(files["xl/styles.xml"], /<left style="medium"><color rgb="FFC0392B"\/>/);
  assert.ok(!/conditionalFormatting/.test(sheet), "bars are cell fills");
  const rows = [...sheet.matchAll(/<row r="(\d+)"/g)].map((m) => +m[1]);
  assert.deepEqual(rows, [...rows].sort((a, b) => a - b), "rows in order");
});

test("sheet names and column letters follow Excel's rules", () => {
  assert.equal(sheetName("a[b]:c*?/\\d"), "a b  c    d");
  assert.equal(sheetName("x".repeat(40)).length, 31);
  assert.equal(sheetName(" "), "WBS");
  assert.deepEqual([0, 25, 26, 34, 701, 702].map(colName), ["A", "Z", "AA", "AI", "ZZ", "AAA"]);
});

test("the HTML is one offline file: no script, no link out, text escaped, A3 landscape", () => {
  const plan = example();
  plan.rows[1].task = "<img src=x onerror=alert(1)>";
  const html = toHtml(layout(plan).model);
  assert.ok(!/<script|<link|https?:\/\/|@import|url\(/i.test(html));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.match(html, /@page\{size:A3 landscape/);
  assert.equal((html.match(/<td class="gate/g) || []).length, layout(plan).model.rows.length);
  assert.equal((html.match(/◆<\/td>/g) || []).length, 7, "7 marks in the rows");
});

const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260815", "DTEND;VALUE=DATE:20260816", "SUMMARY:광복절", "DESCRIPTION:공휴일", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260817", "DTEND;VALUE=DATE:20260818", "SUMMARY:쉬는 날 ", " 광복절", "DESCRIPTION:공휴일", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260508", "DTEND;VALUE=DATE:20260509", "SUMMARY:어버이날", "DESCRIPTION:기념일\\n숨기려면", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260924", "DTEND;VALUE=DATE:20260927", "SUMMARY:추석 연휴", "DESCRIPTION:공휴일", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20250505", "DTEND;VALUE=DATE:20250506", "SUMMARY:어린이날", "DESCRIPTION:공휴일", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20250505", "DTEND;VALUE=DATE:20250506", "SUMMARY:부처님오신날", "DESCRIPTION:공휴일", "END:VEVENT",
  "END:VCALENDAR", "",
].join("\r\n");

test("the calendar keeps 공휴일 only, unfolds lines, spreads multi-day events and joins same-day names", () => {
  const items = parseIcs(ICS);
  assert.equal(items.find((h) => h.key === "2026-08-17").name, "쉬는 날 광복절");
  const y2026 = publicHolidays(items, "2026-01-01", "2026-12-31").map((h) => h.key);
  assert.deepEqual(y2026, ["2026-08-15", "2026-08-17", "2026-09-24", "2026-09-25", "2026-09-26"]);
  assert.deepEqual(publicHolidays(items, "2025-05-05", "2025-05-05"), [{ key: "2025-05-05", name: "어린이날 / 부처님오신날" }]);
});

test("the CLI builds both files, keeps an existing file without --force and leaves no temporary file", () => {
  const dir = mkdtempSync(join(tmpdir(), "wbs-gen-"));
  try {
    writeFileSync(join(dir, "plan.json"), run(["example"], dir).stdout);
    const ok = run(["build", "--plan", "plan.json", "--out", "g.xlsx", "--out", "g.html"], dir);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /OK 영업일 27/);
    const again = run(["build", "--plan", "plan.json", "--out", "g.xlsx"], dir);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /--force/);
    const more = run(["build", "--plan", "plan.json", "--out", "g.xlsx", "--holidays", "8/17, 8/19", "--force"], dir);
    assert.equal(more.status, 0, more.stderr);
    assert.match(more.stdout, /영업일 26/);
    assert.deepEqual(readdirSync(dir).sort(), ["g.html", "g.xlsx", "plan.json"]);
    const bad = run(["build", "--plan", "plan.json", "--out", "g.pdf"], dir);
    assert.equal(bad.status, 2);
    const broken = run(["check", "--plan", "plan.json", "--holidays", "8/3"], dir);
    assert.equal(broken.status, 1, "the gate and milestones on 08/03 now fall on a holiday");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("holidays: a saved calendar is read; an unreachable one ends with 3 and asks for M/D input", () => {
  const dir = mkdtempSync(join(tmpdir(), "wbs-gen-"));
  try {
    writeFileSync(join(dir, "kr.ics"), ICS);
    const r = run(["holidays", "--from", "2026-07-22", "--to", "2026-08-28", "--ics", "kr.ics"], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^08\/17 쉬는 날 광복절$/m);
    assert.match(r.stdout, /^HOLIDAYS 08\/15, 08\/17$/m);
    const none = run(["holidays", "--from", "2026-03-02", "--to", "2026-03-06", "--ics", "kr.ics"], dir);
    assert.match(none.stdout, /^HOLIDAYS 없음$/m);
    const off = run(["holidays", "--from", "2026-07-22", "--to", "2026-08-28", "--url", "https://127.0.0.1:9/x.ics", "--timeout", "3"], dir);
    assert.equal(off.status, 3);
    assert.match(off.stderr, /M\/D, M\/D/);
    assert.equal(run(["holidays", "--from", "2026-07-22", "--to", "2026-08-28", "--url", "http://x"], dir).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
