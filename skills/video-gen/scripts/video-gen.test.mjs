// Run: node --test skills/video-gen/scripts/video-gen.test.mjs
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CATALOG } from "./vg-catalog.mjs";
import { deckToScenes } from "./vg-deck.mjs";
import { counter, ease, grouped, rand, stagger, stripes, track } from "./vg-fx.mjs";
import { cleanText, readScenes } from "./vg-model.mjs";
import { renderMp4, renderStill, sceneAt } from "./vg-render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, "..", "vendor");
const CLI = join(HERE, "video-gen.mjs");
const example = () => JSON.parse(readFileSync(join(HERE, "..", "assets", "example.json"), "utf8"));
const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 120000 });
const sha = (f) => createHash("sha256").update(readFileSync(join(VENDOR, f))).digest("hex");

test("the vendored engine and fonts are the recorded files", () => {
  const want = {
    "canvaskit/canvaskit.js": "894815b2d39b24de2eacdb01453778d83e0b6c418b034e3b728e80956ac2a9d5",
    "canvaskit/canvaskit.wasm": "aca7fa6019f95d3de98d4a49ae60a3d66a09e9d5ca74091fbc369b9be959f959",
    "h264-mp4-encoder/h264-mp4-encoder.node.js": "f8df9c1791b249f75e5cef77f8e32a135b4cdb2c918a0c4593669e8571085c0c",
    "fonts/NotoSans-Regular.ttf": "478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823",
    "fonts/NotoSans-Bold.ttf": "1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913",
    "fonts/NotoSansKR-Regular.otf": "69975a0ac8472717870aefeab0a4d52739308d90856b9955313b2ad5e0148d68",
    "fonts/NotoSansKR-Bold.otf": "5a6ceb287ed2fc6cfc6213144ebea68cbd94b20fc9eb873d8486493bf02d9bda",
  };
  for (const [f, h] of Object.entries(want)) assert.equal(sha(f), h, f);
  const readme = readFileSync(join(VENDOR, "README.md"), "utf8");
  for (const h of Object.values(want)) assert.ok(readme.includes(h), `README records ${h}`);
});

test("motion helpers are pure functions of time", () => {
  const r1 = rand(7);
  const r2 = rand(7);
  assert.deepEqual([r1(), r1()], [r2(), r2()]);
  assert.equal(ease.outBack(1), 1);
  assert.ok(ease.outBack(0.7) > 1, "outBack overshoots");
  assert.deepEqual(track([[0, 0], [1, 10]])(0.5), 5);
  assert.equal(stagger(0.1, 2, { start: 0, gap: 0.1, dur: 0.5 }), 0);
  assert.equal(counter(10, 1180, 1284, 0, 1), 1284);
  assert.equal(grouped(1234567), "1,234,567");
  assert.equal(grouped(-1234), "-1,234");
  const mid = stripes(0.5, 1, 6);
  assert.ok(mid.some(([a, b]) => b > a), "stripes cover the frame in the middle");
  assert.deepEqual(stripes(1, 1, 6).map(([a, b]) => b - a), [0, 0, 0, 0, 0, 0], "and are gone at the end");
});

test("the example checks clean and lays out a timeline", () => {
  const { errors, model } = readScenes(example(), HERE);
  assert.deepEqual(errors, []);
  assert.equal(model.scenes.length, 8);
  assert.equal(model.duration, 32.5);
  assert.equal(model.frames, 975);
  assert.equal(sceneAt(model, 3.6).s.type, "kinetic");
  assert.equal(sceneAt(model, 99).s.type, "credits");
});

test("scene errors", () => {
  const doc = { size: "800x600", fps: 29.5, theme: { bg: "navy" }, scenes: [
    { type: "poster" },
    { type: "title", duration: 0.1 },
    { type: "chart", title: "c", chart: { kind: "pie", labels: ["a"], series: [{ name: "s", values: [null] }] } },
    { type: "image", image: "https://example.com/a.png" },
    { type: "counter", from: 1, to: "x" },
    { type: "bullets", title: "t", bullets: "a", transition: "spin" },
  ] };
  const all = readScenes(doc, HERE).errors.join("\n");
  for (const want of ["size 는", "fps 는 정수", "theme.bg", "type 은", "duration", "title 가 필요함", "bar, line", "숫자만", "URL", "to:", "배열이어야", "transition"]) {
    assert.ok(all.includes(want), `missing: ${want}\n${all}`);
  }
  assert.equal(cleanText("a\u{B}b\u{1}"), "a\nb");
  assert.deepEqual(readScenes([], HERE).errors, ["scene 파일은 JSON 객체여야 함"]);
});

test("a wide-pptx deck becomes scenes, nothing invented", () => {
  const deck = JSON.parse(readFileSync(join(HERE, "..", "..", "wide-pptx", "assets", "example.json"), "utf8"));
  const { scenes, skipped } = deckToScenes(deck, HERE);
  assert.deepEqual(skipped, []);
  assert.deepEqual(scenes.scenes.map((s) => s.type), ["title", "title", "bullets", "bullets", "bullets", "chart", "quote", "title"]);
  assert.equal(scenes.theme.bg, "1F3864");
  const { errors } = readScenes(scenes, HERE);
  assert.deepEqual(errors, [], "the converted file checks clean");
});

test("the catalog names a built-in kind or a banker skill for every entry", () => {
  const skills = readdirSync(join(HERE, "..", ".."));
  for (const c of CATALOG) assert.ok(c.how === "내장" || skills.includes(c.how), `${c.id}: ${c.how}`);
});

test("stills are deterministic PNGs and a short render is a valid H.264 MP4", async () => {
  const doc = { size: "1280x720", fps: 12, scenes: [{ type: "title", duration: 1, title: "한글 Title 2026" }, { type: "kinetic", duration: 1, lines: ["가나 AB"], transition: "stripes" }] };
  const { model } = readScenes(doc, HERE);
  const a = await renderStill(model, 0.8);
  const b = await renderStill(model, 0.8);
  assert.equal(a.subarray(1, 4).toString(), "PNG");
  assert.ok(a.equals(b), "the same time gives the same frame");
  const { bytes, frames } = await renderMp4(model);
  assert.equal(frames, 24);
  assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
  assert.ok(bytes.includes(Buffer.from("avc1")), "H.264 track");
});

test("the CLI checks outputs before rendering and never replaces a file without --force", () => {
  const dir = mkdtempSync(join(tmpdir(), "video-gen-"));
  try {
    writeFileSync(join(dir, "s.json"), JSON.stringify({ fps: 12, scenes: [{ type: "title", duration: 0.5, title: "t" }] }));
    assert.match(run(["list"], dir).stdout, /motion-graphic-make/);
    assert.equal(run(["check", "--scene", "s.json"], dir).status, 0);
    const ok = run(["render", "--scene", "s.json", "--out", "v.mp4"], dir);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /OK 장면 1, 0\.5초/);
    assert.equal(run(["render", "--scene", "s.json", "--out", "v.mp4"], dir).status, 2);
    assert.equal(run(["still", "--scene", "s.json", "--at", "0.2", "--out", "missing/x.png"], dir).status, 2);
    assert.equal(run(["render", "--scene", "s.json", "--out", "v.mov"], dir).status, 2);
    assert.equal(run(["render", "--scene", "s.json", "--out", "w.mp4", "--quality", "5"], dir).status, 2);
    assert.deepEqual(readdirSync(dir).sort(), ["s.json", "v.mp4"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
