#!/usr/bin/env node
/**
 * video-gen.mjs: the helper the video-gen skill runs. It turns a scene file (JSON) into an H.264 MP4 with the
 * bundled engine (Skia CanvasKit and an H.264 encoder, both WASM, plus Noto fonts): no Chrome, no ffmpeg, no
 * install, no network.
 *
 *   node video-gen.mjs list                                     what can be made (built in, or which skill)
 *   node video-gen.mjs example                                  print a sample scene file (JSON)
 *   node video-gen.mjs from-deck --deck <deck.json>             a wide-pptx deck as a scene file (JSON on stdout)
 *   node video-gen.mjs check --scene <scene.json>
 *   node video-gen.mjs still --scene <scene.json> --at <seconds> --out <file.png> [--force]
 *   node video-gen.mjs render --scene <scene.json> --out <file.mp4> [--quality <10-51>] [--force]
 *
 * - Image paths in the scene file are local files, relative to its folder.
 * - render prints progress on stderr about once a second, then `WROTE <path>` and `OK ...` on stdout.
 * - Outputs are written through a random temporary name; a hard link (or an exclusive copy) puts it in place, so
 *   an existing file is never replaced without --force.
 *
 * Exit status: 0 done, 1 the scene file has errors, 2 usage error or a file that could not be read or written.
 */
import { randomBytes } from "node:crypto";
import { constants, copyFileSync, existsSync, linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogText } from "./vg-catalog.mjs";
import { deckToScenes } from "./vg-deck.mjs";
import { readScenes, sceneBase } from "./vg-model.mjs";
import { renderMp4, renderStill } from "./vg-render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(HERE, "..", "assets", "example.json");

class Usage extends Error {}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function parseArgs(argv, bools = ["force"]) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const name = a.slice(2);
    if (bools.includes(name)) {
      out[name] = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new Usage(`--${name} 에 값이 없음`);
    out[name] = v;
  }
  return out;
}

function readJson(file, what) {
  if (!file) throw new Usage(`--${what} <파일.json> 이 필요함`);
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Usage(`${what} 을 읽지 못함: ${e.message}`);
  }
}

function loadScenes(args) {
  const res = readScenes(readJson(args.scene, "scene"), sceneBase(args.scene));
  for (const w of res.warnings) process.stderr.write(`경고: ${w}\n`);
  for (const e of res.errors) process.stderr.write(`오류: ${e}\n`);
  return res.model;
}

const summary = (m) => `장면 ${m.scenes.length}, ${m.duration.toFixed(1)}초, ${m.width}x${m.height}, ${m.fps}fps, 프레임 ${m.frames}`;

/** Checks the output path before any work: extension, folder, and (without --force) an existing file. */
function target(args, ext) {
  if (!args.out) throw new Usage(`--out <파일${ext}> 이 필요함`);
  const p = resolve(args.out);
  if (extname(p).toLowerCase() !== ext) throw new Usage(`--out 은 ${ext} 이어야 함`);
  if (!isDir(dirname(p))) throw new Usage(`출력 폴더가 없음: ${dirname(p)}`);
  if (existsSync(p) && !args.force) throw new Usage(`이미 있음(덮어쓰려면 --force): ${p}`);
  return p;
}

function copyExclusive(tmp, dest) {
  try {
    copyFileSync(tmp, dest, constants.COPYFILE_EXCL);
  } catch (e) {
    if (e.code !== "EEXIST") rmSync(dest, { force: true });
    throw e;
  }
}

function writeOut(dest, data, force) {
  const tmp = join(dirname(dest), `.${randomBytes(6).toString("hex")}.video-gen.tmp`);
  try {
    writeFileSync(tmp, data, { flag: "wx" });
    if (force) renameSync(tmp, dest);
    else {
      try {
        linkSync(tmp, dest);
      } catch (e) {
        if (e.code === "EEXIST") throw e;
        copyExclusive(tmp, dest);
      }
      rmSync(tmp, { force: true });
    }
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Usage(`쓰지 못함 ${dest}: ${e.code === "EEXIST" ? "이미 있음(덮어쓰려면 --force)" : e.message}`);
  }
  return dest;
}

async function cmdRender(args) {
  const dest = target(args, ".mp4");
  const quality = args.quality === undefined ? 20 : Number(args.quality);
  if (!Number.isInteger(quality) || quality < 10 || quality > 51) throw new Usage("--quality 는 10~51 정수(작을수록 고화질)");
  const model = loadScenes(args);
  if (!model) return 1;
  let last = 0;
  const onFrame = (i, n) => {
    if (Date.now() - last < 1000 && i < n) return;
    last = Date.now();
    process.stderr.write(`프레임 ${i}/${n}\n`);
  };
  const { bytes, frames } = await renderMp4(model, { quality, onFrame });
  process.stdout.write(`WROTE ${writeOut(dest, bytes, args.force)}\nOK ${summary(model)}, 기록 ${frames}, ${(bytes.length / 1048576).toFixed(1)}MB\n`);
  return 0;
}

async function cmdStill(args) {
  const dest = target(args, ".png");
  const at = Number(args.at);
  if (!Number.isFinite(at) || at < 0) throw new Usage("--at <초> 는 0 이상 숫자");
  const model = loadScenes(args);
  if (!model) return 1;
  process.stdout.write(`WROTE ${writeOut(dest, await renderStill(model, at), args.force)}\n`);
  return 0;
}

function cmdCheck(args) {
  const model = loadScenes(args);
  if (!model) return 1;
  process.stdout.write(`OK ${summary(model)}\n`);
  return 0;
}

function cmdFromDeck(args) {
  const { scenes, skipped } = deckToScenes(readJson(args.deck, "deck"), dirname(resolve(args.deck)));
  for (const s of skipped) process.stderr.write(`경고: ${s}\n`);
  process.stdout.write(`${JSON.stringify(scenes, null, 2)}\n`);
  return 0;
}

const COMMANDS = {
  list: () => (process.stdout.write(catalogText()), 0),
  example: () => (process.stdout.write(readFileSync(EXAMPLE, "utf8")), 0),
  "from-deck": cmdFromDeck,
  check: cmdCheck,
  still: cmdStill,
  render: cmdRender,
};

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const run = Object.prototype.hasOwnProperty.call(COMMANDS, cmd) ? COMMANDS[cmd] : null;
  if (!run) throw new Usage(`명령: ${Object.keys(COMMANDS).join(" | ")}`);
  return run(parseArgs(rest));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`${e instanceof Usage ? "" : "내부 오류: "}${e.message}\n`);
      process.exitCode = 2;
    },
  );
}
