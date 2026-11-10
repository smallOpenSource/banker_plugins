// Run: node --test skills/wide-pptx/scripts/wide-pptx.test.mjs
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { toHtml } from "./wp-html.mjs";
import { imageSize, readDeck } from "./wp-model.mjs";
import { patchChart, patchTheme, pptxgen, toPptx } from "./wp-pptx.mjs";
import { niceAxis } from "./wp-svg.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "wide-pptx.mjs");
const example = () => JSON.parse(readFileSync(join(HERE, "..", "assets", "example.json"), "utf8"));
// 1x1 PNG (red) and 2x1 GIF.
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c63f8cfc0f01f0005000201" + "e5274dc40000000049454e44ae426082", "hex");
const GIF = Buffer.from("474946383961020001008000000000ffffff21f90401000000002c00000000020001000002024c01003b", "hex");

const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 60000 });

test("the vendored bundle is the recorded PptxGenJS 4.0.1 file and loads in its own context", () => {
  const sha = createHash("sha256").update(readFileSync(join(HERE, "..", "vendor", "pptxgen.bundle.js"))).digest("hex");
  assert.equal(sha, "4fb9eac5cfefb213e2d8743c2b7151025f31bfb3f834c73c12062916daa0f3f8");
  const { PptxGenJS, JSZip } = pptxgen();
  assert.equal(typeof PptxGenJS, "function");
  assert.equal(typeof JSZip, "function");
  assert.equal(typeof globalThis.PptxGenJS, "undefined", "nothing leaks into this process's globals");
});

test("the example deck checks clean", () => {
  const { errors, warnings, model } = readDeck(example(), HERE);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(model.slides.map((s) => s.type), ["title", "section", "bullets", "two", "table", "chart", "quote", "closing"]);
  assert.deepEqual(model.slides[2].bullets[1], { text: "계열사 지표는 따로 받아 엑셀로 합침", level: 2 });
});

test("deck errors and overflow warnings", () => {
  const bad = { title: "t", theme: { primary: "red", nope: "FFFFFF" }, slides: [
    { type: "poster", title: "x" },
    { type: "bullets" },
    { type: "chart", title: "c", chart: { kind: "pie", labels: ["a", "b"], series: [{ name: "s", values: [1, -2] }] } },
    { type: "chart", title: "c", chart: { kind: "bar", labels: ["a"], series: [{ name: "s", values: ["x"] }] } },
    { type: "image", title: "i", image: "https://example.com/a.png" },
    { type: "table", title: "t" },
  ] };
  const all = readDeck(bad, HERE).errors.join("\n");
  for (const want of ["theme.primary", "theme.nope", "type 은", "title 이 없음", "pie 는", "같은 숫자", "URL", "표에 칸이 없음"]) {
    assert.ok(all.includes(want), `missing: ${want}\n${all}`);
  }
  const long = { title: "t", slides: [{ type: "bullets", title: "가".repeat(41), bullets: Array(8).fill("짧음") }] };
  const r = readDeck(long, HERE);
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 2);
  assert.deepEqual(readDeck([], HERE).errors, ["deck 은 JSON 객체여야 함"]);
});

test("images: type from the first bytes, size from the header, relative to the deck folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "wide-pptx-"));
  try {
    writeFileSync(join(dir, "a.png"), PNG);
    writeFileSync(join(dir, "b.jpg"), GIF);
    writeFileSync(join(dir, "c.png"), "not an image");
    const deck = { title: "t", slides: [{ type: "image", title: "a", image: "a.png" }, { type: "image", title: "b", image: "b.jpg" }] };
    const { model } = readDeck(deck, dir);
    assert.equal(model.slides[0].image.mime, "image/png");
    assert.deepEqual(model.slides[0].image.size, { w: 1, h: 1 });
    assert.equal(model.slides[1].image.mime, "image/gif", "a GIF named .jpg is a GIF");
    assert.deepEqual(imageSize(GIF, "image/gif"), { w: 2, h: 1 });
    const bad = readDeck({ title: "t", slides: [{ type: "image", title: "c", image: "c.png" }] }, dir);
    assert.match(bad.errors.join(), /PNG, JPEG, GIF 가 아님/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("theme and chart fonts: Latin Noto Sans, Hangul Noto Sans KR", () => {
  const theme = '<a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hang" typeface="맑은 고딕"/>';
  assert.equal(patchTheme(theme), '<a:latin typeface="Noto Sans"/><a:ea typeface="Noto Sans KR"/><a:cs typeface=""/><a:font script="Hang" typeface="Noto Sans KR"/>');
  assert.equal(patchChart('<a:latin typeface="Arial"/>'), '<a:latin typeface="Noto Sans"/><a:ea typeface="Noto Sans KR"/>');
  assert.equal(patchChart('<a:latin typeface="Arial"/><a:ea typeface="X"/>'), '<a:latin typeface="Arial"/><a:ea typeface="X"/>', "an existing ea is kept");
});

test("the PPTX is 16:9 wide with one slide per deck slide, notes, a chart and patched fonts", async () => {
  const { JSZip } = pptxgen();
  const zip = await JSZip.loadAsync(await toPptx(readDeck(example(), HERE).model));
  const names = Object.keys(zip.files);
  assert.equal(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, 8);
  assert.equal(names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).length, 8);
  const pres = await zip.file("ppt/presentation.xml").async("string");
  assert.match(pres, /<p:sldSz cx="12192000" cy="6858000"/);
  const theme = await zip.file("ppt/theme/theme1.xml").async("string");
  assert.ok(theme.includes('<a:font script="Hang" typeface="Noto Sans KR"/>') && !theme.includes("맑은 고딕"));
  const chart = await zip.file("ppt/charts/chart1.xml").async("string");
  assert.ok(!chart.includes("Arial") && chart.includes('<a:ea typeface="Noto Sans KR"/>'));
  const notes = await zip.file("ppt/notesSlides/notesSlide1.xml").async("string");
  assert.ok(notes.includes("오늘 결정할 것은"));
  const slide3 = await zip.file("ppt/slides/slide3.xml").async("string");
  assert.ok(!/typeface=/.test(slide3), "slide text takes the theme fonts");
});

test("the HTML deck is one offline file with its own script, escaped text and 16:9 print pages", () => {
  const deck = example();
  deck.slides[2].bullets[0] = "<img src=x onerror=alert(1)>";
  deck.slides[2].notes = '"</section><script>';
  const html = toHtml(readDeck(deck, HERE).model);
  assert.ok(!/https?:\/\/|<link|@import|url\(|src="(?!data:)/i.test(html), "nothing is loaded from outside");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes('data-notes="&quot;&lt;/section&gt;&lt;script&gt;"'));
  assert.equal((html.match(/<script>/g) || []).length, 1, "only the deck's own script");
  assert.equal((html.match(/<section class="slide/g) || []).length, 8);
  assert.match(html, /@page\{size:13\.333in 7\.5in;margin:0\}/);
  assert.match(html, /font-family:"Noto Sans","Noto Sans KR",sans-serif/);
  assert.match(html, /<svg viewBox="0 0 1126 446"/);
});

test("chart axes are round numbers that cover the values", () => {
  assert.deepEqual(niceAxis([6, 4, 9]), [0, 10, 2]);
  assert.deepEqual(niceAxis([-3, 7]), [-4, 8, 2]);
  assert.deepEqual(niceAxis([0, 0]), [0, 1, 0.2]);
  assert.deepEqual(niceAxis([1234, 5678]), [0, 6000, 2000]);
});

test("the CLI builds both files, refuses an existing one without --force and leaves no temporary file", () => {
  const dir = mkdtempSync(join(tmpdir(), "wide-pptx-"));
  try {
    writeFileSync(join(dir, "deck.json"), run(["example"], dir).stdout);
    const ok = run(["build", "--deck", "deck.json", "--out", "d.pptx", "--out", "d.html"], dir);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /OK 슬라이드 8, 표 1, 차트 1, 이미지 0, 노트 2/);
    const again = run(["build", "--deck", "deck.json", "--out", "new.html", "--out", "d.pptx"], dir);
    assert.equal(again.status, 2);
    assert.ok(!readdirSync(dir).includes("new.html"), "nothing is written when one output is refused");
    assert.equal(run(["build", "--deck", "deck.json", "--out", "d.pptx", "--force"], dir).status, 0);
    assert.deepEqual(readdirSync(dir).sort(), ["d.html", "d.pptx", "deck.json"]);
    assert.equal(run(["build", "--deck", "deck.json", "--out", "d.pdf"], dir).status, 2);
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ title: "t", slides: [{ type: "bullets" }] }));
    assert.equal(run(["check", "--deck", "bad.json"], dir).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
