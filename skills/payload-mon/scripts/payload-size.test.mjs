// Tests for payload-size.mjs. Run from the repo root: node --test skills/payload-mon/scripts/*.test.mjs
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  CACHE_DIR,
  CHUNK_BYTES as CHUNK,
  clearCache,
  estimatePayloadBytes,
  lastBoundaryEnd,
  payloadSegment,
  REQUEST_LIMIT_BYTES,
  SHOW_FROM_BYTES,
} from "./payload-size.mjs";

// The cache's account checks rest on uids and mode bits, which Windows does not have.
const posixOnly = { skip: process.platform === "win32" && "Windows has no uid or POSIX mode bits" };

const MiB = 1024 * 1024;
const root = mkdtempSync(join(tmpdir(), "payload-size-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

// Each case gets its own folder, so no two cases share a cache.
let seq = 0;
const freshDir = () => {
  const dir = join(root, `case-${++seq}`);
  mkdirSync(dir);
  return dir;
};

const user = (content, extra = {}) => ({ type: "user", isSidechain: false, message: { role: "user", content }, ...extra });
const assistant = (content, extra = {}) => ({
  type: "assistant",
  isSidechain: false,
  message: { role: "assistant", content },
  ...extra,
});
const boundary = () => ({
  parentUuid: null,
  isSidechain: false,
  type: "system",
  subtype: "compact_boundary",
  content: "Conversation compacted",
});
// A tool call whose input spells the marker unescaped, as a Grep for it would.
const mention = () =>
  assistant([{ type: "tool_use", id: "t1", name: "Grep", input: { type: "system", subtype: "compact_boundary" } }]);

const jsonl = (entries) => entries.map((e) => JSON.stringify(e) + "\n").join("");
const size = (value) => Buffer.byteLength(JSON.stringify(value));
const sum = (...messages) => messages.reduce((n, e) => n + size(e.message.content), 0);

function transcript(entries) {
  const dir = freshDir();
  const path = join(dir, "session.jsonl");
  writeFileSync(path, jsonl(entries));
  return { path, cache: join(dir, "cache") };
}

const readCache = (cacheDir) => {
  const files = readdirSync(cacheDir);
  assert.equal(files.length, 1);
  return { file: join(cacheDir, files[0]), state: JSON.parse(readFileSync(join(cacheDir, files[0]), "utf8")) };
};

test("payloadSegment: hidden below 8MB, percent of the 32MB limit from 8MB on", () => {
  assert.equal(REQUEST_LIMIT_BYTES, 32 * MiB);
  assert.equal(SHOW_FROM_BYTES, 8 * MiB);
  assert.equal(payloadSegment(0), "");
  assert.equal(payloadSegment(undefined), "");
  assert.equal(payloadSegment(SHOW_FROM_BYTES - 1), "");
  assert.equal(payloadSegment(SHOW_FROM_BYTES), "payload:25%/8.0MB");
  assert.equal(payloadSegment(30 * MiB), "payload:93%/30.0MB");
  assert.equal(payloadSegment(REQUEST_LIMIT_BYTES - 1), "payload:99%/32.0MB");
  assert.equal(payloadSegment(REQUEST_LIMIT_BYTES), "payload:100%/32.0MB");
});

test("counts what Claude Code sends: messages, tool results, images, compact summary, command output, attachments", () => {
  const a = user("hello");
  const b = assistant([
    { type: "text", text: "hi" },
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
  ]);
  const c = user([
    {
      type: "tool_result",
      tool_use_id: "t1",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }],
    },
  ]);
  // The compact summary carries a UI-only flag but is the first message sent after compaction.
  const summary = user("This session is being continued...", { isVisibleInTranscriptOnly: true, isCompactSummary: true });
  const command = { type: "system", subtype: "local_command", content: "<command-name>/effort</command-name>" };
  const reminder = {
    type: "attachment",
    attachment: { type: "hook_additional_context", content: ["ctx"] },
    rendered: [{ content: "<system-reminder>\nctx\n</system-reminder>" }],
    renderedRole: "system",
  };
  // An image @-mention is stored without `rendered`; Claude Code sends its image every request.
  const imageMention = {
    type: "attachment",
    attachment: {
      type: "file",
      filename: "/w/shot.png",
      content: { type: "image", file: { base64: "iVBORw0KGgo".repeat(50), type: "image/png", originalSize: 4000 } },
    },
  };
  const t = transcript([a, b, c, summary, command, reminder, imageMention]);
  const expected =
    sum(a, b, c, summary) + size(command.content) + size(reminder.rendered) + size(imageMention.attachment.content.file.base64);
  assert.equal(estimatePayloadBytes(t.path, t.cache), expected);
});

test("leaves out what Claude Code drops: sidechains, virtual rows, API errors, unrendered attachments, metadata", () => {
  const kept = user("kept");
  const t = transcript([
    kept,
    user("subagent", { isSidechain: true }),
    user("virtual", { isVirtual: true }),
    {
      type: "assistant",
      isApiErrorMessage: true,
      message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "API Error: 500" }] },
    },
    { type: "attachment", attachment: { type: "hook_success", stdout: "x".repeat(1000) } },
    { type: "attachment", attachment: { type: "prompt_snapshot", text: "y".repeat(1000) } },
    // A PDF mention sends a short note, never its base64.
    {
      type: "attachment",
      attachment: { type: "file", filename: "/w/a.pdf", content: { type: "pdf", file: { base64: "JVBERi0".repeat(200) } } },
    },
    { type: "system", subtype: "stop_hook_summary", content: "z".repeat(1000) },
    { type: "progress", data: { text: "p".repeat(1000) } },
    { type: "custom-title", customTitle: "title" },
  ]);
  assert.equal(estimatePayloadBytes(t.path, t.cache), sum(kept));
});

test("starts over at the last compact boundary", () => {
  const last = assistant("after");
  const t = transcript([user("x".repeat(5000)), boundary(), user("summary"), boundary(), last]);
  assert.equal(estimatePayloadBytes(t.path, t.cache), sum(last));
});

test("a message that spells the boundary marker is counted, not taken for a boundary", () => {
  const kept = user("kept");
  const m1 = mention();
  const t = transcript([user("x".repeat(3000)), boundary(), kept, m1]);
  assert.equal(estimatePayloadBytes(t.path, t.cache), sum(kept, m1)); // first render (skim)

  const m2 = mention();
  appendFileSync(t.path, jsonl([m2]));
  assert.equal(estimatePayloadBytes(t.path, t.cache), sum(kept, m1, m2)); // incremental render
});

test("a mention alone (no real boundary) keeps the whole conversation", () => {
  const first = user("first");
  const m = mention();
  const t = transcript([first, m]);
  assert.equal(estimatePayloadBytes(t.path, t.cache), sum(first, m));
});

test("caches the scanned offset and total per transcript", () => {
  const a = user("a");
  const t = transcript([a]);
  estimatePayloadBytes(t.path, t.cache);
  const { state } = readCache(t.cache);
  assert.equal(state.offset, statSync(t.path).size);
  assert.equal(state.bytes, sum(a));
});

test("a cache written under other counting rules is not resumed", () => {
  const a = user("a");
  const t = transcript([a]);
  estimatePayloadBytes(t.path, t.cache);
  const { file, state } = readCache(t.cache);
  const unversioned = { ...state, bytes: 999 }; // as written before the rules carried a version
  delete unversioned.v;
  writeFileSync(file, JSON.stringify(unversioned));
  assert.equal(estimatePayloadBytes(t.path, t.cache), sum(a));
});

test("incremental: appended lines are added on the next render, same as a full rescan", () => {
  const t = transcript([user("one")]);
  assert.equal(estimatePayloadBytes(t.path, t.cache), sum(user("one")));

  const three = user("three");
  appendFileSync(t.path, jsonl([assistant("two"), boundary(), three]));
  const incremental = estimatePayloadBytes(t.path, t.cache);
  const rescan = estimatePayloadBytes(t.path, join(freshDir(), "cache"));
  assert.equal(incremental, sum(three));
  assert.equal(incremental, rescan);
});

test("a line still being written is counted once it is complete", () => {
  const done = user("done");
  const t = transcript([done]);
  const streaming = assistant("streaming");
  const line = JSON.stringify(streaming);
  appendFileSync(t.path, line.slice(0, 10)); // no newline yet
  assert.equal(estimatePayloadBytes(t.path, t.cache), sum(done));
  appendFileSync(t.path, line.slice(10) + "\n");
  assert.equal(estimatePayloadBytes(t.path, t.cache), sum(done, streaming));
});

test("a transcript rewritten shorter is rescanned, not read from a stale offset", () => {
  const t = transcript([user("x".repeat(4000))]);
  estimatePayloadBytes(t.path, t.cache);
  const fresh = user("new");
  writeFileSync(t.path, jsonl([fresh]));
  assert.equal(estimatePayloadBytes(t.path, t.cache), sum(fresh));
});

test("a transcript replaced by another file (new inode) is rescanned", () => {
  const t = transcript([user("old")]);
  estimatePayloadBytes(t.path, t.cache);
  const y = user("y".repeat(100));
  const z = user("z".repeat(100));
  writeFileSync(t.path + ".new", jsonl([y, z]));
  renameSync(t.path + ".new", t.path);
  assert.equal(estimatePayloadBytes(t.path, t.cache), sum(y, z));
});

test("many-chunk transcript: boundary past the first chunk, lines torn at chunk edges, partial tail", () => {
  // Lengths vary so chunk edges land inside lines. ~10MB before the boundary
  // puts it in the second chunk of the skim; ~18MB after it makes the count read
  // three chunks, so a carried-over line must survive into a third.
  const before = Array.from({ length: 1000 }, (_, i) => user("b".repeat(10_000 + (i % 7))));
  const m = mention();
  const kept = Array.from({ length: 1800 }, (_, i) => assistant("a".repeat(10_000 + (i % 5))));
  const t = transcript([...before, boundary(), m, ...kept]);
  const countFrom = Buffer.byteLength(jsonl([...before, boundary()]));
  assert.ok(countFrom > CHUNK, "the boundary must sit past the first chunk");
  const file = readFileSync(t.path);
  for (const edge of [CHUNK, 2 * CHUNK, countFrom + CHUNK, countFrom + 2 * CHUNK]) {
    assert.ok(edge < file.length && file[edge - 1] !== 0x0a, `a line must straddle the chunk edge at ${edge}`);
  }
  // The skim must hand the count exactly the bytes after the boundary, or the
  // first render parses the whole history again.
  const fd = openSync(t.path, "r");
  try {
    assert.equal(lastBoundaryEnd(fd, file.length), countFrom);
  } finally {
    closeSync(fd);
  }

  const tail = JSON.stringify(user("tail"));
  appendFileSync(t.path, tail.slice(0, 7)); // still being written
  const expected = sum(m, ...kept);
  assert.equal(estimatePayloadBytes(t.path, t.cache), expected);
  assert.equal(readCache(t.cache).state.offset, statSync(t.path).size - 7);

  appendFileSync(t.path, tail.slice(7) + "\n");
  const incremental = estimatePayloadBytes(t.path, t.cache);
  assert.equal(incremental, expected + sum(user("tail")));
  assert.equal(incremental, estimatePayloadBytes(t.path, join(freshDir(), "cache")));
});

test("a 9MB conversation (one line longer than a read chunk) shows payload:28%/9.0MB", () => {
  const big = user("x".repeat(9 * MiB));
  const t = transcript([big]);
  const bytes = estimatePayloadBytes(t.path, t.cache);
  assert.equal(bytes, sum(big));
  assert.equal(payloadSegment(bytes), "payload:28%/9.0MB");
});

test("a missing transcript throws (the statusline wrapper swallows it)", () => {
  const dir = freshDir();
  assert.throws(() => estimatePayloadBytes(join(dir, "missing.jsonl"), join(dir, "cache")), { code: "ENOENT" });
});

// The cache file estimatePayloadBytes keeps for a transcript, by the same naming rule.
const cachePath = (cacheDir, transcriptPath) =>
  join(cacheDir, createHash("sha1").update(transcriptPath).digest("hex").slice(0, 16) + ".json");

test("the cache folder is per account: its name carries this account's uid", () => {
  const expected = typeof process.getuid === "function" ? `omc-hud-payload-${process.getuid()}` : "omc-hud-payload";
  assert.equal(basename(CACHE_DIR), expected);
});

test("a cache folder other accounts can write to is neither read nor written", posixOnly, () => {
  const a = user("a".repeat(500));
  const t = transcript([a]);
  estimatePayloadBytes(t.path, t.cache);
  // That same cache with a wrong total, planted where any account could have put it.
  const shared = join(dirname(t.cache), "shared");
  mkdirSync(shared);
  chmodSync(shared, 0o777);
  const planted = { ...readCache(t.cache).state, bytes: 999 };
  writeFileSync(cachePath(shared, t.path), JSON.stringify(planted));
  assert.equal(estimatePayloadBytes(t.path, shared), sum(a));
  assert.deepEqual(readdirSync(shared), [basename(cachePath(shared, t.path))]);
  assert.deepEqual(JSON.parse(readFileSync(cachePath(shared, t.path), "utf8")), planted);
});

test("a cache folder that is a symbolic link is not used", posixOnly, () => {
  const a = user("a");
  const t = transcript([a]);
  const real = join(dirname(t.cache), "real");
  mkdirSync(real, { mode: 0o700 });
  const link = join(dirname(t.cache), "link");
  symlinkSync(real, link);
  assert.equal(estimatePayloadBytes(t.path, link), sum(a));
  assert.deepEqual(readdirSync(real), []);
});

test("the cache's temp file is created fresh, never written through a link planted at its name", posixOnly, () => {
  const a = user("a");
  const t = transcript([a]);
  mkdirSync(t.cache, { mode: 0o700 });
  const victim = join(dirname(t.cache), "victim.txt");
  writeFileSync(victim, "keep me");
  symlinkSync(victim, `${cachePath(t.cache, t.path)}.${process.pid}.tmp`);
  assert.equal(estimatePayloadBytes(t.path, t.cache), sum(a));
  assert.equal(readFileSync(victim, "utf8"), "keep me");
  assert.ok(lstatSync(cachePath(t.cache, t.path)).isFile(), "the cache itself is a regular file");
  assert.equal(readCache(t.cache).state.bytes, sum(a));
});

test("clearCache deletes a cache folder this account controls and leaves any other alone", posixOnly, () => {
  const a = user("a");
  const t = transcript([a]);
  estimatePayloadBytes(t.path, t.cache);
  clearCache(t.cache);
  assert.equal(existsSync(t.cache), false);

  const shared = join(dirname(t.cache), "shared");
  mkdirSync(shared);
  chmodSync(shared, 0o777);
  writeFileSync(join(shared, "theirs.json"), "{}");
  clearCache(shared);
  assert.ok(existsSync(join(shared, "theirs.json")));
});
