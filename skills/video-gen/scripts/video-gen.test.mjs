// Run: node --test skills/video-gen/scripts/video-gen.test.mjs
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CATALOG } from "./vg-catalog.mjs";
import { deckToScenes } from "./vg-deck.mjs";
import { Painter } from "./vg-draw.mjs";
import { loadEngine } from "./vg-engine.mjs";
import { counter, decimals, ease, fitGap, grouped, rand, stagger, stripes, track } from "./vg-fx.mjs";
import { cleanText, imageInfo, readScenes } from "./vg-model.mjs";
import { drawFrame, probeImages, renderMp4, renderStill, sceneAt } from "./vg-render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, "..", "vendor");
const CLI = join(HERE, "video-gen.mjs");
const example = () => JSON.parse(readFileSync(join(HERE, "..", "assets", "example.json"), "utf8"));
const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 120000 });
/** A w x h RGBA PNG: fully transparent, with an opaque yellow square in the middle. */
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 4 + 1) + 1 + x * 4;
    if (Math.abs(x - w / 2) < w / 6 && Math.abs(y - h / 2) < h / 6) raw.set([255, 220, 0, 255], o);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

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
  assert.equal(grouped(2.75, 2), "2.75");
  assert.equal(grouped(1234.5, 1), "1,234.5");
  assert.equal(decimals([1.5, 2.75, 0.4]), 2);
  assert.equal(counter(9, 0, 3.5, 0, 1, 1), 3.5, "the last value is exactly `to`");
  assert.equal(fitGap(10, 0.35, 0.6, 0.6, 2), (2 - 0.6 - 0.6) / 9, "gaps shrink so the last item finishes in time");
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

test("images are checked by their bytes: kind, size, a cut-off end", () => {
  const ok = png(40, 20);
  assert.deepEqual(imageInfo(ok), { w: 40, h: 20, whole: true });
  assert.equal(imageInfo(Buffer.from("RIFF\0\0\0\0WAVEfmt ".padEnd(40, " "))), null, "RIFF that is not WebP");
  assert.equal(imageInfo(ok.subarray(0, 60)).whole, false, "a PNG cut short");
  const big = Buffer.from(ok);
  big.writeUInt32BE(24000, 16);
  big.writeUInt32BE(24000, 20);
  const dir = mkdtempSync(join(tmpdir(), "video-gen-"));
  try {
    writeFileSync(join(dir, "cut.png"), ok.subarray(0, 60));
    writeFileSync(join(dir, "big.png"), big);
    const errs = (f) => readScenes({ scenes: [{ type: "image", image: f }] }, dir).errors.join();
    assert.match(errs("cut.png"), /잘림/);
    assert.match(errs("big.png"), /너무 큼/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a JPEG is whole when its end marker follows the scan, whatever is appended (a motion photo)", async () => {
  const { CK } = await loadEngine();
  const surface = CK.MakeSurface(64, 48);
  surface.getCanvas().clear(CK.Color(30, 160, 90, 1));
  const snap = surface.makeImageSnapshot();
  const jpeg = Buffer.from(snap.encodeToBytes(CK.ImageFormat.JPEG, 90));
  snap.delete();
  surface.delete();
  const motion = Buffer.concat([jpeg, Buffer.from("\0\0\0\x18ftypmp42"), Buffer.alloc(10240, 7)]);
  assert.deepEqual(imageInfo(jpeg), { w: 64, h: 48, whole: true });
  assert.deepEqual(imageInfo(motion), { w: 64, h: 48, whole: true }, "data after the end marker");
  assert.equal(imageInfo(jpeg.subarray(0, jpeg.length - 2)).whole, false, "the end marker cut off");
  assert.equal(imageInfo(jpeg.subarray(0, 200)).whole, false, "cut inside the headers or the scan");
  const dir = mkdtempSync(join(tmpdir(), "video-gen-"));
  try {
    writeFileSync(join(dir, "motion.jpg"), motion);
    const { model, errors } = readScenes({ scenes: [{ type: "image", image: "motion.jpg" }] }, dir);
    assert.deepEqual(errors, []);
    assert.deepEqual(await probeImages(model), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blank text is not content; NFD Hangul is put in NFC", () => {
  const errs = readScenes({ scenes: [{ type: "kinetic", lines: ["", " "] }, { type: "quote", quote: " " }, { type: "image", image: "a.png", motion: "Pan" }] }, HERE).errors.join("\n");
  for (const want of ["lines 가 필요함", "quote 가 필요함", "zoom, pan"]) assert.ok(errs.includes(want), `missing: ${want}\n${errs}`);
  assert.equal(cleanText("\u{1112}\u{1161}\u{11AB}"), "한");
});

test("a wide-pptx deck becomes scenes, nothing invented", () => {
  const deck = JSON.parse(readFileSync(join(HERE, "..", "..", "wide-pptx", "assets", "example.json"), "utf8"));
  const { scenes, skipped } = deckToScenes(deck, HERE);
  assert.deepEqual(skipped, []);
  assert.deepEqual(scenes.scenes.map((s) => s.type), ["title", "title", "bullets", "bullets", "bullets", "chart", "quote", "title"]);
  assert.equal(scenes.theme.bg, "1F3864");
  const { errors } = readScenes(scenes, HERE);
  assert.deepEqual(errors, [], "the converted file checks clean");
  const edge = { title: "t", slides: [{ type: "bullets", title: "빈" }, { type: "two", title: "빈 2단" }, { type: "table", title: "머리만", header: ["a", "b"], rows: [["", ""]] }, { type: "quote", quote: "" }, { type: "title", title: "남음" }] };
  const r = deckToScenes(edge, HERE);
  assert.equal(r.scenes.scenes.length, 1);
  assert.equal(r.skipped.length, 4);
  assert.deepEqual(readScenes(r.scenes, HERE).errors, []);
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

test("every frame starts clean: a frame drawn after another equals the same frame drawn fresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "video-gen-"));
  try {
    writeFileSync(join(dir, "alpha.png"), png(64, 36));
    const doc = { fps: 12, scenes: [{ type: "title", duration: 1, title: "PREVIOUS", transition: "cut" }, { type: "lowerthird", duration: 2, name: "홍길동", role: "팀장", image: "alpha.png", transition: "cut" }] };
    const { model } = readScenes(doc, dir);
    const { CK, fonts } = await loadEngine();
    const grab = (T, before) => {
      const s = CK.MakeSurface(model.width, model.height);
      const P = new Painter(CK, fonts, s.getCanvas(), model.width, model.height);
      if (before !== undefined) drawFrame(P, model, before);
      drawFrame(P, model, T);
      const img = s.makeImageSnapshot();
      const px = Buffer.from(img.readPixels(0, 0, { width: model.width, height: model.height, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }));
      img.delete();
      P.free();
      s.delete();
      return px;
    };
    assert.ok(grab(1.5, 0.9).equals(grab(1.5)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decimals are kept in the numbers a chart or counter shows", () => {
  assert.equal(grouped(1.5, decimals([1.5, 2.75])), "1.50");
  assert.equal(grouped(1234567.5, decimals([1234567.5])), "1,234,567.5");
  assert.equal(counter(10, 0, 3.5, 0, 1, decimals([0, 3.5])), 3.5);
});

test("a scene of the shortest length ends on the same frame as a long one: everything shown, at rest", async () => {
  const chart = (kind) => ({ kind, labels: ["A", "B", "C"], series: [{ name: "s", values: [100, 50, 12.5] }, { name: "t", values: [20, 80, 40] }] });
  const kinds = [
    { type: "title", title: "제목 Title", subtitle: "부제" },
    { type: "kinetic", lines: ["짧은 장면도", "끝까지 Shown"] },
    { type: "bullets", title: "짧은 글머리", bullets: ["하나", "둘", "셋", "넷", "다섯"] },
    { type: "chart", title: "막대", chart: chart("bar") },
    { type: "chart", title: "꺾은선", chart: chart("line") },
    { type: "counter", label: "평균", from: 0, to: 3.5, unit: "점" },
    { type: "quote", quote: "짧아도 다 보임", by: "video-gen" },
  ];
  const last = async (scene, duration) => {
    const { model, errors } = readScenes({ fps: 12, scenes: [{ ...scene, duration, transition: "cut" }, { type: "title", duration: 2, title: "끝", transition: "cut" }] }, HERE);
    assert.deepEqual(errors, []);
    return renderStill(model, duration - 1 / 24);
  };
  for (const scene of kinds) {
    const name = `${scene.type} ${scene.chart ? scene.chart.kind : ""}`;
    assert.ok((await last(scene, 0.5)).equals(await last(scene, 6)), `${name}: the last frame of a 0.5 s scene matches a 6 s one`);
  }
});

test("a render that fails reports its own error, not the encoder's", async () => {
  const { model } = readScenes({ fps: 12, scenes: [{ type: "title", duration: 0.5, title: "t" }] }, HERE);
  const broken = { ...model, scenes: [{ ...model.scenes[0], type: "nope" }] };
  await assert.rejects(renderMp4(broken), (e) => !/abort\(/.test(e.message));
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
    const st = run(["still", "--scene", "s.json", "--at", "0.2", "--out", "f.png"], dir);
    assert.match(st.stdout, /^FRAME 2 /m);
    assert.equal(run(["still", "--scene", "s.json", "--at", "9", "--out", "g.png"], dir).status, 2, "past the end");
    if (process.platform !== "win32") {
      symlinkSync(join(HERE, ".."), join(dir, "link"));
      const viaLink = spawnSync(process.execPath, [join(dir, "link", "scripts", "video-gen.mjs"), "list"], { encoding: "utf8" });
      assert.match(viaLink.stdout, /motion-graphic-make/, "a linked path runs the CLI");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
