#!/usr/bin/env node
/**
 * wide-pptx.mjs: the helper the wide-pptx skill runs. It turns a deck (JSON) into a 16:9 presentation as PPTX and/or
 * one self-contained HTML file. Pure Node plus the bundled PptxGenJS (vendor/); no install, no network.
 *
 *   node wide-pptx.mjs example                                 print a sample deck (JSON)
 *   node wide-pptx.mjs check --deck <deck.json>
 *   node wide-pptx.mjs build --deck <deck.json> --out <file.pptx|file.html>... [--force]
 *
 * - Image paths in the deck are local files, relative to the deck file's folder; both outputs embed them.
 * - check and build print warnings for text that may overflow its fixed box (the deck is still built).
 * - build checks every --out first (kind, duplicates, folder, existing files) and makes every output before it
 *   writes any, each through a random temporary
 *   name: a hard link (or an exclusive copy) puts it in place, so a file that appears meanwhile is never replaced;
 *   --force renames over an existing file instead.
 *
 * Exit status: 0 done, 1 the deck has errors, 2 usage error or a file that could not be read or written.
 */
import { randomBytes } from "node:crypto";
import { constants, copyFileSync, existsSync, linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toHtml } from "./wp-html.mjs";
import { deckBase, readDeck } from "./wp-model.mjs";
import { toPptx } from "./wp-pptx.mjs";

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

/** Reads --name value pairs; flags listed in bools take no value; --out may repeat. */
export function parseArgs(argv, bools = ["force"]) {
  const out = { _: [], out: [] };
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
    if (name === "out") out.out.push(v);
    else out[name] = v;
  }
  return out;
}

function readDeckFile(args) {
  if (!args.deck) throw new Usage("--deck <deck.json> 이 필요함");
  let deck;
  try {
    deck = JSON.parse(readFileSync(args.deck, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Usage(`deck 을 읽지 못함: ${e.message}`);
  }
  return readDeck(deck, deckBase(args.deck));
}

function report(res) {
  for (const w of res.warnings) process.stderr.write(`경고: ${w}\n`);
  for (const e of res.errors) process.stderr.write(`오류: ${e}\n`);
}

function summary(m) {
  const count = (t) => m.slides.filter((s) => s.type === t).length;
  const notes = m.slides.filter((s) => s.notes).length;
  return `슬라이드 ${m.slides.length}, 표 ${count("table")}, 차트 ${count("chart")}, 이미지 ${count("image")}, 노트 ${notes}`;
}

function cmdCheck(args) {
  const res = readDeckFile(args);
  report(res);
  if (!res.model) return 1;
  process.stdout.write(`OK ${summary(res.model)}\n`);
  return 0;
}

/** An exclusive copy; a copy that fails after making target (disk full) removes what it made. */
function copyExclusive(tmp, target) {
  try {
    copyFileSync(tmp, target, constants.COPYFILE_EXCL);
  } catch (e) {
    if (e.code !== "EEXIST") rmSync(target, { force: true });
    throw e;
  }
}

/** Puts tmp at target without replacing a file that appeared meanwhile (link, else an exclusive copy). */
function placeNew(tmp, target) {
  try {
    linkSync(tmp, target);
  } catch (e) {
    if (e.code === "EEXIST") throw e;
    copyExclusive(tmp, target);
  }
  rmSync(tmp, { force: true });
}

function writeOut(target, data, force) {
  const tmp = join(dirname(target), `.${randomBytes(6).toString("hex")}.wide-pptx.tmp`);
  try {
    writeFileSync(tmp, data, { flag: "wx" });
    if (force) renameSync(tmp, target);
    else placeNew(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    const why = e.code === "EEXIST" ? "이미 있음(덮어쓰려면 --force)" : e.message;
    throw new Usage(`쓰지 못함 ${target}: ${why}`);
  }
  return target;
}

/** Checks every output before any is written: kind, duplicates, and (without --force) files already there. */
function targetsOf(args) {
  if (!args.out.length) throw new Usage("--out <파일.pptx|파일.html> 이 필요함");
  const targets = args.out.map((f) => ({ path: resolve(f), kind: extname(f).toLowerCase() }));
  const bad = targets.filter((x) => ![".pptx", ".html", ".htm"].includes(x.kind));
  if (bad.length) throw new Usage(`--out 은 .pptx 나 .html 이어야 함: ${bad.map((x) => x.path).join(", ")}`);
  if (new Set(targets.map((x) => x.path)).size !== targets.length) throw new Usage("--out 에 같은 파일이 두 번 있음");
  const noDir = targets.filter((x) => !isDir(dirname(x.path)));
  if (noDir.length) throw new Usage(`출력 폴더가 없음: ${noDir.map((x) => dirname(x.path)).join(", ")}`);
  const there = targets.filter((x) => existsSync(x.path));
  if (there.length && !args.force) throw new Usage(`이미 있음(덮어쓰려면 --force): ${there.map((x) => x.path).join(", ")}`);
  return targets;
}

async function cmdBuild(args) {
  const targets = targetsOf(args);
  const res = readDeckFile(args);
  report(res);
  if (!res.model) return 1;
  // Every output is made before any is written, so a drawing error leaves no half set behind.
  const made = [];
  for (const x of targets) made.push({ ...x, data: x.kind === ".pptx" ? await toPptx(res.model) : toHtml(res.model) });
  for (const x of made) process.stdout.write(`WROTE ${writeOut(x.path, x.data, args.force)}\n`);
  process.stdout.write(`OK ${summary(res.model)}\n`);
  return 0;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  if (cmd === "example") {
    process.stdout.write(readFileSync(EXAMPLE, "utf8"));
    return 0;
  }
  if (cmd === "check") return cmdCheck(args);
  if (cmd === "build") return cmdBuild(args);
  throw new Usage("명령: example | check | build");
}

// Compared as real paths: Node resolves links in import.meta.url but not in argv[1], so a linked path would
// otherwise do nothing and exit 0.
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
if (process.argv[1] && real(process.argv[1]) !== null && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
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
