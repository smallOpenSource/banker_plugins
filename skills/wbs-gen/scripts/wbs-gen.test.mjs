// Run: node --test skills/wbs-gen/scripts/wbs-gen.test.mjs
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { businessDays, parseHolidays, resolveDate, splitTime, weeks, zoned } from "./wg-dates.mjs";
import { parseIcs, publicHolidays } from "./wg-holidays.mjs";
import { SCOPED_CSS, toFragment, toHtml } from "./wg-html.mjs";
import { layout } from "./wg-plan.mjs";
import { colName, scriptRuns, sheetName, toXlsx } from "./wg-xlsx.mjs";
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

test("a far or long range is refused at once, not looped over", () => {
  const far = { ...example(), start: "9999-12-01", end: "9999-12-31", rows: [{ kind: "task", start: "9999-12-01", end: "9999-12-03" }], gates: [] };
  const t0 = Date.now();
  assert.equal(layout(far).model?.days.length, 23);
  const long = { ...example(), start: "2020-01-01", end: "2026-01-01" };
  assert.match(layout(long).errors.join(), /5년을 넘음/);
  assert.ok(Date.now() - t0 < 2000);
});

test("a month/day that falls in two years of a long project is an error; full dates work", () => {
  const plan = { title: "t", start: "2026-01-05", end: "2027-06-30", rows: [{ kind: "task", start: "4/1", end: "2026-04-30" }] };
  assert.match(layout(plan).errors.join("\n"), /두 해에 걸림/);
  plan.rows[0].start = "2026-04-01";
  plan.holidays = "5/5";
  assert.match(layout(plan).errors.join("\n"), /두 해에 걸리는 M\/D: 5\/5/);
  plan.holidays = "2026-05-05, 2027-05-05, 2027-02-08";
  const { model } = layout(plan);
  assert.equal(model.days.length, 388 - 3);
  assert.equal(model.rows[0].cells[5], "26/04/01", "multi-year plans show the year in start and end");
});

test("plan names that match Object.prototype members are just unknown names", () => {
  const plan = example();
  plan.rows.push({ kind: "task", wbs: "Y1", priority: "constructor", start: "08/04", end: "08/05" });
  const { model } = layout(plan);
  assert.equal(model.rows[model.rows.length - 1].bar, "5D6D7E");
  plan.rows.push({ kind: "task", wbs: "Y2", part: "toString", start: "08/04", end: "08/05" });
  assert.match(layout(plan).errors.join(), /parts 에 없는 part \(toString\)/);
});

test("weeks keep calendar numbers across a week with no working day; notes lines may be one string", () => {
  const days = businessDays("2026-09-21", "2026-10-16", new Set(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]));
  assert.deepEqual(weeks(days).map((w) => w.label), ["W1", "W3", "W4"]);
  const plan = example();
  plan.notes = [{ heading: "[메모]", lines: "한 줄" }];
  assert.deepEqual(layout(plan).model.notes, [{ heading: "[메모]", lines: ["한 줄"] }]);
  plan.gates = { date: "08/03" };
  assert.match(layout(plan).errors.join(), /gates 는 배열이어야 함/);
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
  const sst = files["xl/sharedStrings.xml"];
  assert.ok(sst.includes('<rFont val="Noto Sans"/><family val="2"/></rPr><t xml:space="preserve">A &lt;b&gt; &amp; &quot;C&quot;  </t>'), "Latin run escaped, control character dropped");
  assert.ok(sst.includes('<rFont val="Noto Sans KR"/><family val="2"/><charset val="129"/></rPr><t xml:space="preserve">끝</t>'), "Hangul run in Noto Sans KR");
  assert.match(sst, /<sst [^>]*count="(\d+)" uniqueCount="(\d+)"/);
  assert.ok(+/count="(\d+)"/.exec(sst)[1] >= +/uniqueCount="(\d+)"/.exec(sst)[1], "count is the number of references");
  assert.match(files["xl/styles.xml"], /<name val="Noto Sans KR"\/>/);
  assert.match(files["xl/styles.xml"], /<name val="Noto Sans"\/>/);
  assert.ok(!/theme=/.test(files["xl/styles.xml"]), "no theme colours without a theme part");
  assert.match(files["xl/styles.xml"], /<fills count="\d+"><fill><patternFill patternType="none"\/><\/fill><fill><patternFill patternType="gray125"\/>/);
  assert.match(files["xl/styles.xml"], /<left style="medium"><color rgb="FFC0392B"\/>/);
  assert.ok(!/conditionalFormatting/.test(sheet), "bars are cell fills");
  const rows = [...sheet.matchAll(/<row r="(\d+)"/g)].map((m) => +m[1]);
  assert.deepEqual(rows, [...rows].sort((a, b) => a - b), "rows in order");
});

test("Hangul goes to Noto Sans KR runs, everything else to Noto Sans; spaces stay with the run before", () => {
  assert.deepEqual(scriptRuns("API 리팩터링 v2"), [{ text: "API ", kr: false }, { text: "리팩터링 ", kr: true }, { text: "v2", kr: false }]);
  assert.deepEqual(scriptRuns("(요건)"), [{ text: "(요건)", kr: true }]);
  assert.deepEqual(scriptRuns("07/22"), [{ text: "07/22", kr: false }]);
  assert.deepEqual(scriptRuns("◆"), [{ text: "◆", kr: true }], "Noto Sans has no ◆");
  assert.deepEqual(scriptRuns(" - "), [{ text: " - ", kr: false }]);
  assert.deepEqual(scriptRuns("※ 漢字 OK"), [{ text: "※ 漢字 ", kr: true }, { text: "OK", kr: false }], "symbols and Hanja Noto Sans lacks");
});

test("sheet names and column letters follow Excel's rules", () => {
  assert.equal(sheetName("a[b]:c*?/\\d"), "a b  c    d");
  assert.equal(sheetName("x".repeat(40)).length, 31);
  assert.equal(sheetName(" "), "WBS");
  assert.equal(sheetName("'계획'"), "계획");
  assert.equal(sheetName("History"), "WBS");
  assert.ok(!sheetName(`${"가".repeat(30)}'나`).endsWith("'"), "no ' left at the end after the cut");
  assert.equal(sheetName(`${"가".repeat(30)}😀끝`), "가".repeat(30), "31 UTF-16 units, and a surrogate pair is not cut");
  assert.equal(sheetName(`${"가".repeat(29)}😀끝`), `${"가".repeat(29)}😀`);
  assert.deepEqual([0, 25, 26, 34, 701, 702].map(colName), ["A", "Z", "AA", "AI", "ZZ", "AAA"]);
});

test("the HTML is one offline file: no script, no link out, text escaped, A3 landscape", () => {
  const plan = example();
  plan.rows[1].task = "<img src=x onerror=alert(1)>";
  const html = toHtml(layout(plan).model);
  assert.ok(!/<script|<link|https?:\/\/|@import|url\(/i.test(html));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.match(html, /@page\{size:A3 landscape/);
  assert.match(html, /font-family:"Noto Sans","Noto Sans KR",sans-serif/);
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
    const partly = run(["build", "--plan", "plan.json", "--out", "new.xlsx", "--out", "g.html"], dir);
    assert.equal(partly.status, 2, "g.html is there");
    assert.ok(!readdirSync(dir).includes("new.xlsx"), "nothing is written when one output is refused");
    assert.equal(run(["build", "--plan", "plan.json", "--out", "a.html", "--out", "./a.html"], dir).status, 2);
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
    const span = run(["holidays", "--from", "2026-07-01", "--to", "2027-01-31", "--ics", "kr.ics"], dir);
    assert.match(span.stdout, /^HOLIDAYS 2026-08-15, 2026-08-17, 2026-09-24, 2026-09-25, 2026-09-26$/m, "full dates across years");
    writeFileSync(join(dir, "obs.ics"), ICS.replace(/DESCRIPTION:공휴일/g, "DESCRIPTION:Public holiday"));
    const wording = run(["holidays", "--from", "2026-07-22", "--to", "2026-08-28", "--ics", "obs.ics"], dir);
    assert.equal(wording.status, 3, "a calendar with no 공휴일 at all is not 'no holidays'");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// cp949 (Korean Windows' code page) and a DRM-encrypted file are not UTF-8: read as UTF-8 they would put U+FFFD in
// the XLSX, the HTML and the holiday names. "한글" in cp949 is C7 D1 B1 DB; it takes the first Hangul syllable's place.
const CP949 = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);
const NOT_TEXT = Buffer.from([0x00, 0x9c, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0xa0]);
const withCp949 = (text) => {
  const chars = [...text];
  const i = chars.findIndex((c) => c >= "\uAC00" && c <= "\uD7A3");
  return Buffer.concat([Buffer.from(chars.slice(0, i).join("")), CP949, Buffer.from(chars.slice(i + 1).join(""))]);
};

test("a plan or calendar that is not UTF-8 stops with one line naming the file; a UTF-8 BOM is fine", () => {
  const dir = mkdtempSync(join(tmpdir(), "wbs-gen-"));
  try {
    const plan = run(["example"], dir).stdout;
    writeFileSync(join(dir, "cp949.json"), withCp949(plan));
    writeFileSync(join(dir, "drm.json"), NOT_TEXT);
    writeFileSync(join(dir, "bom.json"), `\uFEFF${plan}`);
    writeFileSync(join(dir, "cp949.ics"), withCp949(ICS));
    writeFileSync(join(dir, "bom.ics"), `\uFEFF${ICS}`);
    const refused = (r, file) => {
      assert.equal(r.status, 2, `${file}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
      assert.ok(r.stderr.includes(file) && r.stderr.includes("UTF-8"), r.stderr);
    };
    for (const file of ["cp949.json", "drm.json"]) {
      refused(run(["check", "--plan", file], dir), file);
      refused(run(["build", "--plan", file, "--out", "x.xlsx", "--out", "x.html"], dir), file);
    }
    assert.ok(!readdirSync(dir).some((f) => f.startsWith("x.")), "nothing is written for a plan that is not UTF-8");
    const holidays = ["holidays", "--from", "2026-07-22", "--to", "2026-08-28", "--ics"];
    refused(run([...holidays, "cp949.ics"], dir), "cp949.ics");
    const bomIcs = run([...holidays, "bom.ics"], dir);
    assert.equal(bomIcs.status, 0, bomIcs.stderr);
    assert.match(bomIcs.stdout, /^HOLIDAYS 08\/15, 08\/17$/m);
    const bom = run(["build", "--plan", "bom.json", "--out", "b.html"], dir);
    assert.equal(bom.status, 0, bom.stderr);
    assert.ok(!readFileSync(join(dir, "b.html"), "utf8").includes("\uFFFD"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- hour unit (a plan of at most two calendar days) ----------

const hourPlan = (rows, extra = {}) => ({ title: "배포 당일", start: "2026-11-25 09:00", end: "2026-11-26 18:00", rows, ...extra });

test("a time of day splits off 'YYYY-MM-DD HH:MM', 'YYYY-MM-DDTHH:MM' and 'M/D HH:MM'", () => {
  assert.deepEqual(splitTime("2026-11-25 11:30"), { date: "2026-11-25", min: 690, bad: false });
  assert.deepEqual(splitTime("2026-11-25T09:05"), { date: "2026-11-25", min: 545, bad: false });
  assert.deepEqual(splitTime("11/25 7:00"), { date: "11/25", min: 420, bad: false });
  assert.deepEqual(splitTime("11/25"), { date: "11/25", min: null });
  assert.deepEqual(splitTime("11/25 24:00"), { date: "11/25", min: 1440, bad: false }, "24:00 is the end of that day");
  assert.equal(splitTime("11/25 24:30").bad, true);
  assert.equal(splitTime("11/25 23:60").bad, true);
  for (const t of ["2026-11-25T01:00:00Z", "2026-11-25T10:00:00+09:00", "2026-11-25 10:00+0900", "11/25 10:00:00"]) assert.ok(zoned(t), t);
  for (const t of ["2026-11-25 10:00", "11/25", "2026-11-25T10:00"]) assert.ok(!zoned(t), t);
});

test("two calendar days at most is the hour unit: every hour from start to end, grouped by day", () => {
  const { errors, warnings, model } = layout(hourPlan([{ kind: "task", wbs: "1", start: "11/25 11:00", end: "11/25 13:00" }], { holidays: "11/25" }));
  assert.deepEqual(errors, []);
  assert.equal(model.unit, "hour");
  assert.equal(model.days.length, 33, "09:00 on the first day to 18:00 on the second, nights included");
  assert.deepEqual(model.days.slice(0, 3).map((d) => d.label), ["09:00", "10:00", "11:00"]);
  assert.deepEqual(model.days[0], { key: "2026-11-25T09:00", label: "09:00", dow: "" });
  assert.deepEqual(model.weeks, [{ n: 1, label: "11/25(수)", first: 0, count: 15 }, { n: 2, label: "11/26(목)", first: 15, count: 18 }]);
  assert.equal(model.head[7], "시간");
  assert.match(model.title, /2026-11-25\(수\) 09:00 ~ 11\/26\(목\) 18:00 {4}\| {4}33 시간/);
  assert.deepEqual(warnings, ["시간 단위(기간 2일 이내)는 모든 시간을 보여 공휴일을 쓰지 않음: 2026-11-25"], "holidays are not used, one warning");
  const t = model.rows[0];
  assert.deepEqual([t.from, t.to], [2, 3], "11:00-13:00 fills the 11:00 and 12:00 slots");
  assert.deepEqual(t.cells.slice(5), ["11/25 11:00", "11/25 13:00", 2]);
});

test("hour unit: a start floors to its hour, an end rises to the next; a date alone is the whole day inside the period", () => {
  const { errors, model } = layout(hourPlan([
    { kind: "task", wbs: "a", start: "11/25 11:30", end: "11/25 12:10" },
    { kind: "task", wbs: "b", start: "2026-11-26" },
    { kind: "task", wbs: "c", start: "11/25", end: "11/25" },
    { kind: "task", wbs: "d", start: "2026-11-26T10:00" },
  ]));
  assert.deepEqual(errors, []);
  const [a, b, c, d] = model.rows;
  assert.deepEqual([a.from, a.to], [2, 3], "11:30-12:10 takes 11:00 and 12:00");
  assert.deepEqual([b.from, b.to, b.cells[7]], [15, 32, 18], "a date-only day runs from 00:00 to the plan end");
  assert.deepEqual([c.from, c.to, c.cells[5], c.cells[6]], [0, 14, "11/25 09:00", "11/25 24:00"], "the first day from the plan start to 24:00");
  assert.deepEqual([d.from, d.to], [25, 25], "a start time and no end is that one hour");
});

test("hour unit: a milestone, a constraint and a gate with a time sit in that hour; end <= start is a row error", () => {
  const plan = hourPlan([
    { kind: "milestone", wbs: "M1", date: "11/26 10:30" },
    { kind: "milestone", wbs: "M2", date: "11/26" },
    { kind: "constraint", wbs: "C1", date: "11/25 15:00" },
  ], { gates: [{ date: "11/25 13:00", label: "승인" }] });
  const { errors, model } = layout(plan);
  assert.deepEqual(errors, []);
  assert.deepEqual(model.rows.map((r) => r.diamonds), [[25], [15], [6]]);
  assert.deepEqual(model.gates.map((g) => [g.col, g.key]), [[4, "2026-11-25T13:00"]]);
  assert.ok(model.legend.some((l) => l.label === "승인(빨간 수직선 = 11/25 13:00)"));
  const bad = layout(hourPlan([
    { kind: "task", wbs: "x", start: "11/25 13:00", end: "11/25 13:00" },
    { kind: "task", wbs: "y", start: "11/25 14:00", end: "11/25 10:00" },
    { kind: "task", wbs: "z", start: "11/25 07:00", end: "11/25 10:00" },
    { kind: "milestone", wbs: "w", date: "11/25 25:00" },
  ]));
  assert.equal(bad.model, null);
  assert.ok(bad.errors.includes("rows[0] x: 종료가 시작보다 앞서거나 같음"), bad.errors.join("\n"));
  assert.ok(bad.errors.includes("rows[1] y: 종료가 시작보다 앞서거나 같음"), bad.errors.join("\n"));
  assert.ok(bad.errors.includes("rows[2] z 시작: 기간 밖 (11/25 07:00)"), bad.errors.join("\n"));
  assert.ok(bad.errors.includes("rows[3] w: 날짜로 읽지 못함 (11/25 25:00)"), bad.errors.join("\n"));
  const backwards = { title: "t", start: "2026-11-25 13:00", end: "2026-11-25 12:00", rows: [{ start: "11/25" }] };
  assert.deepEqual(layout(backwards).errors, ["end 가 start 보다 앞서거나 같음"]);
});

test("exactly two calendar days is the hour unit; three days is the day unit, which drops time parts", () => {
  const two = layout({ title: "t", start: "2026-11-25", end: "2026-11-26", rows: [{ start: "11/25", end: "11/26" }] }).model;
  assert.equal(two.unit, "hour");
  assert.equal(two.days.length, 48, "two whole days, 48 slots at most");
  assert.equal(two.rows[0].cells[7], 48);
  const one = layout({ title: "t", start: "2026-11-28", end: "2026-11-28", rows: [{ start: "11/28 22:00", end: "11/28 23:59" }] }).model;
  assert.deepEqual([one.days.length, one.rows[0].from, one.rows[0].to], [24, 22, 23], "a Saturday is shown in the hour unit");
  const three = layout({ title: "t", start: "2026-11-25 09:00", end: "2026-11-27 18:00", rows: [{ start: "11/25 11:00", end: "11/27 13:00" }], gates: [{ date: "11/26 15:00" }] });
  assert.deepEqual(three.errors, []);
  assert.equal(three.model.unit, "day");
  assert.deepEqual(three.model.days.map((d) => d.label), ["11/25", "11/26", "11/27"]);
  assert.deepEqual(three.model.rows[0].cells.slice(5), ["11/25", "11/27", 3]);
  assert.equal(three.model.gates[0].col, 1);
  assert.match(three.model.title, /3 영업일/);
  assert.equal(three.model.head[7], "일수\n(영업일)");
  const timed = { ...example(), start: "2026-07-22 09:00", end: "2026-08-28T18:00" };
  assert.deepEqual(layout(timed).model, layout(example()).model, "times on a day plan change nothing");
});

test("hour unit HTML: hour labels without a weekday, day groups, and the grid scoped under .wbsg", () => {
  const m = layout(hourPlan([{ kind: "task", wbs: "1", start: "11/25 11:00", end: "11/25 13:00" }], { gates: [{ date: "11/25 13:00" }] })).model;
  const html = toHtml(m);
  assert.ok(html.includes('<th>09:00</th><th>10:00</th><th>11:00</th><th>12:00</th><th class="gate">13:00</th>'), "no weekday line under an hour");
  assert.ok(html.includes('<th class="w" colspan="4">11/25(수)</th>') === false);
  assert.ok(html.includes('<th class="w" colspan="15">11/25(수)</th><th class="w" colspan="18">11/26(목)</th>'));
  assert.ok(html.includes(">시간</th>"));
  const frag = toFragment(m);
  assert.ok(frag.startsWith('<div class="wbsg"><div class="wrap"><table') && frag.endsWith("</section></div>"));
  assert.ok(!/<style|<script|<html|<body/.test(frag));
  // Every rule of the embeddable CSS is under .wbsg: no rule for the host page's body, table, th or td.
  const selectors = SCOPED_CSS.replace(/@media print\{/, "").split("}").map((r) => r.split("{")[0].trim()).filter(Boolean);
  assert.ok(selectors.length > 20);
  for (const sel of selectors.flatMap((x) => x.split(","))) assert.match(sel.trim(), /^\.wbsg\b/, sel);
  assert.ok(!SCOPED_CSS.includes("@page"));
  assert.ok(html.includes(`<style>body{margin:16px}\n@page{size:A3 landscape;margin:10mm}\n@media print{body{margin:0}}${SCOPED_CSS}</style>`));
});

test("hour unit XLSX: row 2 groups hours by day, row 3 names each hour, the 시간 head, and it still unzips", () => {
  const m = layout(hourPlan([{ kind: "task", wbs: "1", start: "11/25 11:00", end: "11/25 13:00" }])).model;
  const files = unzip(toXlsx(m));
  const sheet = files["xl/worksheets/sheet1.xml"];
  const sst = files["xl/sharedStrings.xml"];
  const strings = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((x) => [...x[1].matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map((t) => t[1]).join(""));
  for (const want of ["09:00", "23:00", "00:00", "17:00", "11/25(수)", "11/26(목)", "시간"]) assert.ok(strings.includes(want), want);
  assert.ok(!strings.some((t) => /^\d{2}:00\n/.test(t)), "no weekday line under an hour");
  assert.match(sheet, /<mergeCell ref="I2:W2"\/><mergeCell ref="X2:AO2"\/>/, "15 hours on 11/25 and 18 on 11/26");
  assert.match(sheet, /<dimension ref="A1:AO\d+"\/>/, "8 fixed columns and 33 hours");
  assert.match(sheet, /<pane xSplit="8" ySplit="3" topLeftCell="I4" activePane="bottomRight" state="frozen"\/>/);
});

test("the CLI reports the hour unit: 시간 and 날 in the summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "wbs-gen-"));
  try {
    writeFileSync(join(dir, "plan.json"), JSON.stringify(hourPlan([{ kind: "task", wbs: "1", start: "11/25 11:00", end: "11/25 13:00" }])));
    const r = run(["build", "--plan", "plan.json", "--out", "h.xlsx", "--out", "h.html"], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^OK 시간 33 \(2026-11-25T09:00 ~ 2026-11-26T18:00\), 날 2, 행 1, 작업 1, ◆ 0, 게이트 0$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hour unit: a date-only constraint is a point in the day's first slot inside the period, like a milestone", () => {
  const plan = { title: "t", start: "2026-11-25 22:00", end: "2026-11-26 03:00", rows: [
    { kind: "constraint", wbs: "C", date: "11/26" },
    { kind: "milestone", wbs: "M", date: "11/26" },
    { kind: "constraint", wbs: "C2", date: "11/25" },
    { kind: "constraint", wbs: "C3", date: "11/26 01:30" },
  ], gates: [{ date: "11/26" }] };
  const { errors, model } = layout(plan);
  assert.deepEqual(errors, []);
  const [c, m, c2, c3] = model.rows;
  assert.deepEqual([c.diamonds, c.cells.slice(5)], [[2], ["11/26 00:00", "11/26 00:00", 1]]);
  assert.deepEqual(m.diamonds, [2]);
  assert.equal(model.gates[0].col, 2);
  assert.deepEqual([c2.diamonds, c2.cells.slice(5)], [[0], ["11/25 22:00", "11/25 22:00", 1]], "the first day starts at the period start");
  assert.deepEqual([c3.diamonds, c3.cells.slice(5)], [[3], ["11/26 01:30", "11/26 01:30", 1]]);
});

test("hour unit: a point at the period end, 24:00 as an input, end null, and cells that show the plan's times", () => {
  const { errors, model } = layout(hourPlan([
    { kind: "milestone", wbs: "M", date: "11/26 18:00" },
    { kind: "task", wbs: "a", start: "11/25 13:00", end: "11/25 15:30" },
    { kind: "task", wbs: "b", start: "11/25 20:00", end: "11/25 24:00" },
    { kind: "task", wbs: "c", start: "11/25 10:30", end: null },
  ], { gates: [{ date: "2026-11-26 18:00", label: "끝" }] }));
  assert.deepEqual(errors, []);
  const [m, a, b, c] = model.rows;
  assert.deepEqual(m.diamonds, [32], "the period end goes in the last slot");
  assert.equal(model.gates[0].col, 32);
  assert.ok(model.legend.some((l) => l.label === "끝(빨간 수직선 = 11/26 18:00)"));
  assert.deepEqual([a.from, a.to, a.cells.slice(5)], [4, 6, ["11/25 13:00", "11/25 15:30", 3]], "15:30 is shown, the bar fills 13, 14 and 15");
  assert.deepEqual([b.from, b.to, b.cells.slice(5)], [11, 14, ["11/25 20:00", "11/25 24:00", 4]]);
  assert.deepEqual([c.from, c.to, c.cells.slice(5)], [1, 1, ["11/25 10:30", "11/25 11:00", 1]], "end null is like no end");
});

test("a time copied with a zone or seconds is refused with a hint to write local time", () => {
  const bad = layout(hourPlan([{ kind: "task", wbs: "z", start: "2026-11-25T01:00:00Z", end: "2026-11-25T10:00:00+09:00" }]));
  const all = bad.errors.join("\n");
  assert.match(all, /rows\[0\] z 시작: 날짜로 읽지 못함 \(2026-11-25T01:00:00Z\)\. 시간대\(Z, \+09:00\)와 초는 쓰지 않음\. 프로젝트 현지 시각 YYYY-MM-DD HH:MM/);
  assert.match(all, /rows\[0\] z 종료: 날짜로 읽지 못함 \(2026-11-25T10:00:00\+09:00\)\. 시간대/);
  const range = layout({ title: "t", start: "2026-11-25T00:00:00Z", end: "2026-11-25", rows: [{ start: "11/25" }] });
  assert.match(range.errors[0], /^start, end 는 YYYY-MM-DD 나 YYYY-MM-DD HH:MM 이어야 함\. 시간대/);
  assert.equal(layout({ title: "t", start: "x", end: "y", rows: [{}] }).errors[0], "start, end 는 YYYY-MM-DD 나 YYYY-MM-DD HH:MM 이어야 함");
});
