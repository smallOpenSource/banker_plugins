#!/usr/bin/env node
/*
 * vertical-pptx verifier: A4 portrait (210x297mm) PPTX conformance + text width prediction.
 *
 * Zero dependencies, node stdlib only, so every acceptance criterion that leans on it stays a
 * standing regression gate rather than something that needs a populated node_modules.
 *
 * Two responsibilities, both deliberately concentrated here:
 *
 *  1. Spec verdicts. Reads the deck's own bytes and answers a binary question about the frozen
 *     spec: is this really 7560000 x 10692000 EMU portrait, is the sldSz type attribute honest,
 *     does any shape cross the margin or leave the slide.
 *
 *  2. Measurement. The builders contain zero lines of font binary parsing (plan principle 5:
 *     "builders build, the verifier measures"). Every byte of TTF/TTC/OTF parsing in this skill
 *     lives below the FONT READER banner, and so does every width prediction.
 *
 * What this file deliberately does NOT own:
 *
 *  - The 8x20 grid. build_a4p.js owns it and build_a4p.py mirrors it; a third copy here would be
 *    the only one no test cross-checks (E1/E1b compare the two builders against each other).
 *    The verifier reads a:off/a:ext out of the artifact and checks bounds. It never predicts them.
 *  - Any write path. --repair / --convert-a4p / --suggest-deck land later; the reader below is
 *    already central-directory based so a writer can be layered on without reopening this layer.
 *
 * Honesty rules that shape the code more than anything else:
 *
 *  - The default width label is "estimate". "measured" is earned, never assumed: a real font file
 *    must be opened, its name table family compared against the run's a:latin typeface, and its
 *    tables parsed. A path that exists but holds a different font is the one silent-wrong-answer
 *    path in the design, so --font-file is verified rather than trusted, and so is whatever
 *    fc-match hands back (fc-match ALWAYS returns something, including for names it never found).
 *  - Predicted width is a LOWER BOUND. Kerning and line-breaking rules are not reproduced, so a
 *    prediction can under-report and never over-report. That is what makes a positive overflow
 *    finding sound: if even the lower bound does not fit, the real text certainly does not.
 *  - Parse failure of a valid path degrades to "estimate". It never throws. --font-file is
 *    arbitrary user input, so every table offset is bounds-checked.
 *
 * Exit codes: 0 pass, 1 verification failure, 2 environment missing, 3 usage error.
 *
 * Usage: node verify_a4p.mjs <file.pptx> [--json] [--strict] [--font-file <path>] [--deck <deck.json>]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, ENV: 2, USAGE: 3 });

export const EMU_PER_MM = 36000;
export const EMU_PER_PT = 12700;

/** The frozen spec. 210mm x 297mm, exact, no tolerance. */
export const A4P = Object.freeze({ cx: 7560000, cy: 10692000 });

/**
 * PowerPoint's "A4 Paper" preset is 10.833 x 7.5 inches: LANDSCAPE and not A4. Picking it from
 * the page-setup dialog is the single most likely way to end up with a file that is named after
 * A4 and is not A4, which is why it gets a verdict of its own instead of folding into NOT_A4_PORTRAIT.
 */
export const PRESET_TRAP = Object.freeze({ cx: 9906000, cy: 6858000 });

/** meta.marginMm contract (plan 3-a): integer, 10..40. 10 is the frozen-spec floor. */
export const MARGIN_MM = Object.freeze({ MIN: 10, MAX: 40, DEFAULT: 10 });

/** ECMA-376 a:bodyPr inset defaults, in EMU. Ignoring them overstates the text box by 5mm wide. */
const INSET_DEFAULT = Object.freeze({ l: 91440, t: 45720, r: 91440, b: 45720 });

/** Line height when nothing was measured. Every real font's hhea exceeds this, so it under-counts lines. */
const FALLBACK_LINE_EM = 1.2;

/** Run size fallback when a:rPr@sz is absent and the real value lives in an inherited list style. */
const FALLBACK_SZ_PT = 18;

/** Bounds on the font-directory walk, so a pathological tree cannot hang the verifier. */
const FONT_SCAN = Object.freeze({ MAX_DEPTH: 5, MAX_FILES: 4000, MAX_OPENS: 24 });

const FONT_EXT = /\.(ttf|ttc|otf|otc)$/i;

/** Namespace-prefix matcher. Prefixes are per-document, so nothing may hardcode "p:" or "a:". */
const NS = '(?:[A-Za-z_][\\w.\\-]*:)?';

class VerifyError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'VERIFY_ERROR';
  }
}

/** Thrown only inside the font reader, and always caught: a bad font degrades, it does not fail a run. */
class FontError extends Error {}

const check = (cond, message, code) => {
  if (!cond) throw new VerifyError(message, code);
};

export const mmOf = (emu) => emu / EMU_PER_MM;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * mm for humans, with enough digits to stay honest. A 1 EMU margin deviation is a real verdict
 * (there is no tolerance) and printing it as "0mm" would read as a tool malfunction.
 */
const mmStr = (emu) => {
  const v = mmOf(emu);
  return v !== 0 && Math.abs(v) < 0.01 ? v.toFixed(5) : String(round2(v));
};

// ---------------------------------------------------------------------------
// ZIP READER (central directory based)
// ---------------------------------------------------------------------------
//
// The central directory is the authority, never the local header. An entry written with general
// purpose bit 3 set carries zeros for crc/csize/usize in its local header and puts the real values
// in a trailing data descriptor, so a local-header reader silently reads empty parts. The input to
// --repair is by definition a deck someone else produced, so that case is real, not theoretical.
// The local header is still consulted for exactly one thing: its own name/extra lengths, which are
// what locate the start of the data (they legitimately differ from the central directory's).

const SIG = Object.freeze({ EOCD: 0x06054b50, EOCD64: 0x06064b50, EOCD64_LOC: 0x07064b50, CEN: 0x02014b50, LOC: 0x04034b50 });

/** General purpose bit flags we care about. */
const GPB = Object.freeze({ ENCRYPTED: 0x0001, DATA_DESCRIPTOR: 0x0008 });

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** CRC32 as zip defines it. Used to stamp rewritten entries and to re-check every entry on read-back. */
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function u16(buf, off) {
  check(off >= 0 && off + 2 <= buf.length, `zip: read past end at ${off}`, 'NOT_A_ZIP');
  return buf.readUInt16LE(off);
}

function u32(buf, off) {
  check(off >= 0 && off + 4 <= buf.length, `zip: read past end at ${off}`, 'NOT_A_ZIP');
  return buf.readUInt32LE(off);
}

function u64(buf, off) {
  check(off >= 0 && off + 8 <= buf.length, `zip: read past end at ${off}`, 'NOT_A_ZIP');
  return Number(buf.readBigUInt64LE(off));
}

/** Backwards scan for the end-of-central-directory record (the comment may be up to 64KB). */
function findEocd(buf) {
  const floor = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === SIG.EOCD) return i;
  }
  return -1;
}

/** Pull the zip64 overrides out of a central-directory extra field, in their fixed order. */
function zip64Extra(buf, start, len, need) {
  let p = start;
  const end = start + len;
  while (p + 4 <= end) {
    const id = u16(buf, p);
    const size = u16(buf, p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      const out = {};
      for (const field of need) {
        if (q + 8 > p + 4 + size) break;
        out[field] = u64(buf, q);
        q += 8;
      }
      return out;
    }
    p += 4 + size;
  }
  return {};
}

/**
 * Parse the central directory. Returns entry records only; payloads are inflated on demand so a
 * 40MB deck does not have to be decompressed to answer a question about ppt/presentation.xml.
 */
export function readZipDirectory(buf) {
  const eocd = findEocd(buf);
  check(eocd >= 0, 'zip: end-of-central-directory record not found (not a pptx?)', 'NOT_A_ZIP');

  let count = u16(buf, eocd + 10);
  let cdOffset = u32(buf, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && u32(buf, loc) === SIG.EOCD64_LOC) {
      const rec = u64(buf, loc + 8);
      if (rec >= 0 && rec + 56 <= buf.length && u32(buf, rec) === SIG.EOCD64) {
        count = u64(buf, rec + 32);
        cdOffset = u64(buf, rec + 48);
      }
    }
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    check(p + 46 <= buf.length && u32(buf, p) === SIG.CEN, `zip: malformed central directory at ${p}`, 'NOT_A_ZIP');
    const versionMadeBy = u16(buf, p + 4);
    const versionNeeded = u16(buf, p + 6);
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const modTime = u16(buf, p + 12);
    const modDate = u16(buf, p + 14);
    const crc = u32(buf, p + 16);
    let csize = u32(buf, p + 20);
    let usize = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const internalAttrs = u16(buf, p + 36);
    const externalAttrs = u32(buf, p + 38);
    let localOffset = u32(buf, p + 42);
    check(p + 46 + nameLen + extraLen + commentLen <= buf.length, `zip: truncated central directory entry ${i}`, 'NOT_A_ZIP');
    // Bit 11 declares UTF-8 names; everything a pptx contains is ASCII either way.
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) {
      const need = [];
      if (usize === 0xffffffff) need.push('usize');
      if (csize === 0xffffffff) need.push('csize');
      if (localOffset === 0xffffffff) need.push('localOffset');
      const over = zip64Extra(buf, p + 46 + nameLen, extraLen, need);
      if (over.usize !== undefined) usize = over.usize;
      if (over.csize !== undefined) csize = over.csize;
      if (over.localOffset !== undefined) localOffset = over.localOffset;
    }
    entries.push({
      name,
      method,
      crc,
      csize,
      usize,
      localOffset,
      flags,
      versionMadeBy,
      versionNeeded,
      modTime,
      modDate,
      internalAttrs,
      // External attributes carry the unix mode and the MS-DOS directory bit; dropping them turns
      // directory entries into 0-byte files on some extractors.
      externalAttrs,
      extra: Buffer.from(buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)),
      comment: Buffer.from(buf.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen)),
      isDir: name.endsWith('/'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Where one entry's payload sits. The SIZE comes from the central directory, never from the
 * local header, because an entry with general purpose bit 3 set carries zeros there and the
 * real values trail the data. Only the variable-length name and extra fields are read locally.
 */
function entryDataRange(buf, entry) {
  const lo = entry.localOffset;
  check(lo >= 0 && lo + 30 <= buf.length && u32(buf, lo) === SIG.LOC, `zip: local header missing for ${entry.name}`, 'NOT_A_ZIP');
  const start = lo + 30 + u16(buf, lo + 26) + u16(buf, lo + 28);
  const end = start + entry.csize;
  check(start >= 0 && end <= buf.length, `zip: entry data out of range for ${entry.name}`, 'NOT_A_ZIP');
  return { start, end };
}

/** Inflate one entry, taking its size from the central directory and its data offset from the local header. */
function readEntryData(buf, entry) {
  const { start, end } = entryDataRange(buf, entry);
  const raw = buf.subarray(start, end);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new VerifyError(`zip: unsupported compression method ${entry.method} for ${entry.name}`, 'ZIP_UNSUPPORTED');
}

/** The entry's stored bytes exactly as they sit in the file, still compressed. */
function rawEntryBytes(buf, entry) {
  const { start, end } = entryDataRange(buf, entry);
  return Buffer.from(buf.subarray(start, end));
}

/** Strip the zip64 extended-information field. We only ever write 32-bit records, so keeping a
 *  stale 0x0001 block would leave the central directory contradicting its own size fields. */
function stripZip64Extra(extra) {
  const out = [];
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (p + 4 + size > extra.length) break;
    if (id !== 0x0001) out.push(extra.subarray(p, p + 4 + size));
    p += 4 + size;
  }
  return Buffer.concat(out);
}

/**
 * Assemble a zip from entry records. Each record is either passed through with its ORIGINAL
 * compressed bytes (method, crc and both sizes reused verbatim) or carries `replacement`, a plain
 * Buffer that gets deflated here and stamped with a fresh CRC32.
 *
 * Re-deflating an untouched part would be pure added risk: it changes bytes this tool has no
 * reason to change, and every one of those changes is a chance to corrupt a part that was fine.
 */
export function writeZip(records) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const rec of records) {
    check(!(rec.flags & GPB.ENCRYPTED), `zip: ${rec.name} is encrypted; refusing to rewrite it`, 'ZIP_ENCRYPTED');
    const nameBuf = Buffer.from(rec.name, 'utf8');
    const replaced = rec.replacement !== undefined && rec.replacement !== null;
    const body = replaced ? zlib.deflateRawSync(rec.replacement) : rec.data;
    const method = replaced ? 8 : rec.method;
    const crc = replaced ? crc32(rec.replacement) : rec.crc;
    const usize = replaced ? rec.replacement.length : rec.usize;
    const csize = body.length;
    // Bit 3 moves the real sizes into a trailing data descriptor. We know them here, so we clear
    // the bit and write them inline: strictly more readable, and it drops the descriptor entirely.
    const flags = rec.flags & ~GPB.DATA_DESCRIPTOR;
    const extra = stripZip64Extra(rec.extra || Buffer.alloc(0));

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG.LOC, 0);
    local.writeUInt16LE(rec.versionNeeded ?? 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(rec.modTime ?? 0, 10);
    local.writeUInt16LE(rec.modDate ?? 0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(csize, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG.CEN, 0);
    cen.writeUInt16LE(rec.versionMadeBy ?? 20, 4);
    cen.writeUInt16LE(rec.versionNeeded ?? 20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(rec.modTime ?? 0, 12);
    cen.writeUInt16LE(rec.modDate ?? 0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(csize, 20);
    cen.writeUInt32LE(usize, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(extra.length, 30);
    cen.writeUInt16LE((rec.comment || Buffer.alloc(0)).length, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(rec.internalAttrs ?? 0, 36);
    cen.writeUInt32LE(rec.externalAttrs ?? 0, 38);
    check(offset <= 0xffffffff, 'zip: output would need zip64 offsets; refusing to write', 'ZIP_TOO_LARGE');
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf, extra, rec.comment || Buffer.alloc(0));

    offset += 30 + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG.EOCD, 0);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/**
 * U15, run against our own output every time we write one. Four checks, and the fourth is the
 * point: our reader and the python oracle are both central-directory based, so a local header
 * that disagrees with the central directory is invisible to both. Streaming unzippers read the
 * local header and nothing else, and that is exactly where they would break.
 */
export function verifyZipIntegrity(buf, opts = {}) {
  const problems = [];
  const entries = readZipDirectory(buf);

  if (!entries.length) problems.push('아카이브에 엔트리가 없다');
  else if (entries[0].name !== '[Content_Types].xml') {
    problems.push(`첫 엔트리가 [Content_Types].xml 이 아니라 ${entries[0].name} 다 (OPC 위반)`);
  }

  for (const e of entries) {
    if (e.isDir) continue;

    // Local header cross-check FIRST, and not gated behind a successful inflate: a bad local
    // header makes decompression fail too, and "could not decompress" would bury the actual
    // diagnosis under a symptom.
    const lo = e.localOffset;
    if (!(lo >= 0 && lo + 30 <= buf.length) || buf.readUInt32LE(lo) !== SIG.LOC) {
      problems.push(`${e.name}: 로컬 헤더 오프셋 ${lo} 에 시그니처 0x04034b50 이 없다`);
      continue;
    }
    const nameLen = buf.readUInt16LE(lo + 26);
    const localName = buf.toString('utf8', lo + 30, lo + 30 + nameLen);
    if (localName !== e.name) {
      problems.push(`${e.name}: 로컬 헤더 파일명이 "${localName}" 로 중앙 디렉터리와 다르다`);
    }

    let data;
    try {
      data = readEntryData(buf, e);
    } catch (err) {
      problems.push(`${e.name}: 압축 해제 실패 (${err.message})`);
      continue;
    }
    const actual = crc32(data);
    if (actual !== e.crc) {
      problems.push(`${e.name}: CRC32 재계산 ${hex32(actual)} != 중앙 디렉터리 ${hex32(e.crc)}`);
    }
    if (data.length !== e.usize) {
      problems.push(`${e.name}: 크기 ${data.length} != 중앙 디렉터리 ${e.usize}`);
    }
  }

  // Byte identity for everything we said we did not touch.
  if (opts.source && opts.untouched) {
    const src = openZip(opts.source);
    for (const name of opts.untouched) {
      const before = src.read(name);
      const after = entries.find((e) => e.name === name);
      if (!before || !after) {
        problems.push(`${name}: 원본/산출물 어느 한쪽에 없다`);
        continue;
      }
      if (!before.equals(readEntryData(buf, after))) problems.push(`${name}: 미치환 엔트리인데 내용이 바뀌었다`);
    }
  }

  return { ok: problems.length === 0, problems, entryCount: entries.length, firstEntry: entries[0]?.name ?? null };
}

const hex32 = (n) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;

/** Random-access view over a zip buffer, with a small decode cache. */
export function openZip(buf) {
  const entries = readZipDirectory(buf);
  const byName = new Map();
  for (const e of entries) if (!e.isDir) byName.set(e.name, e);
  const cache = new Map();
  const read = (name) => {
    if (cache.has(name)) return cache.get(name);
    const e = byName.get(name);
    if (!e) return null;
    const data = readEntryData(buf, e);
    cache.set(name, data);
    return data;
  };
  return {
    entries,
    names: () => [...byName.keys()],
    has: (name) => byName.has(name),
    read,
    /** Still-compressed bytes, for pass-through re-zipping. */
    raw: (entry) => rawEntryBytes(buf, entry),
    readText: (name) => {
      const d = read(name);
      return d === null ? null : stripBom(d.toString('utf8'));
    },
  };
}

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// ---------------------------------------------------------------------------
// XML EXTRACTION (element-scoped, never a whole-document parse-and-reserialize)
// ---------------------------------------------------------------------------
//
// Reserializing would risk rewriting parts of a deck this tool only means to inspect, and would
// need a full namespace-aware parser for no gain. Everything below is scoped to one element at a
// time: find the open tag, then pull attributes from within that matched span, so attribute order
// never matters and a "cx" somewhere else in the document can never be mistaken for sldSz's.

/** End of an open tag, respecting quotes, because `>` is legal inside an XML attribute value. */
function endOfTag(xml, start) {
  let quote = null;
  for (let i = start; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

export function xmlDecode(s) {
  return String(s).replace(/&(#x?[0-9A-Fa-f]+|amp|lt|gt|quot|apos);/g, (whole, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[body];
  });
}

/** Attributes of a single open tag, keyed by their literal names (prefix included). */
export function attrsOf(openTag) {
  const out = {};
  const re = /([A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(openTag)) !== null) out[m[1]] = xmlDecode(m[2] !== undefined ? m[2] : m[3]);
  return out;
}

/** Attribute lookup that tolerates any namespace prefix on the attribute name. */
export function attr(attrs, localName) {
  if (attrs[localName] !== undefined) return attrs[localName];
  const suffix = `:${localName}`;
  for (const k of Object.keys(attrs)) if (k.endsWith(suffix)) return attrs[k];
  return undefined;
}

const localName = (tag) => (tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag);

/** Locate the closing tag for `tag` starting at `from`, counting same-name nesting (p:grpSp inside p:grpSp). */
function findClose(xml, tag, from) {
  const re = new RegExp(`<(/?)${escapeRe(tag)}\\b`, 'g');
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const gt = endOfTag(xml, m.index);
    if (gt < 0) return -1;
    if (m[1] === '/') {
      if (--depth === 0) return { contentEnd: m.index, end: gt + 1 };
    } else if (xml[gt - 1] !== '/') {
      depth++;
    }
    re.lastIndex = gt + 1;
  }
  return -1;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * First element with local name `tag` at or after `from`.
 * Returns { tag, raw, attrs, inner, start, end } or null.
 */
export function readElement(xml, tag, from = 0) {
  const re = new RegExp(`<${NS}${escapeRe(tag)}(?=[\\s/>])`, 'g');
  re.lastIndex = from;
  const m = re.exec(xml);
  if (!m) return null;
  const start = m.index;
  const gt = endOfTag(xml, start);
  if (gt < 0) return null;
  const raw = xml.slice(start, gt + 1);
  const full = m[0].slice(1);
  if (raw[raw.length - 2] === '/') return { tag: full, raw, attrs: attrsOf(raw), inner: '', start, end: gt + 1 };
  const close = findClose(xml, full, gt + 1);
  if (close === -1) return { tag: full, raw, attrs: attrsOf(raw), inner: '', start, end: gt + 1 };
  return { tag: full, raw, attrs: attrsOf(raw), inner: xml.slice(gt + 1, close.contentEnd), start, end: close.end };
}

/** Every element with local name `tag`, skipping the interior of one match before looking for the next. */
export function readElements(xml, tag) {
  const out = [];
  let at = 0;
  for (;;) {
    const el = readElement(xml, tag, at);
    if (!el) return out;
    out.push(el);
    at = el.end;
  }
}

/** Direct children of an element's content, so a group's own xfrm is never mistaken for a shape's. */
export function childElements(inner) {
  const out = [];
  let i = 0;
  while (i < inner.length) {
    const lt = inner.indexOf('<', i);
    if (lt < 0) break;
    if (inner.startsWith('<!', lt) || inner.startsWith('<?', lt)) {
      const gt = inner.indexOf('>', lt);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    const gt = endOfTag(inner, lt);
    if (gt < 0) break;
    const nameMatch = /^<([A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?)/.exec(inner.slice(lt, gt + 1));
    if (!nameMatch) {
      i = gt + 1;
      continue;
    }
    const tag = nameMatch[1];
    const raw = inner.slice(lt, gt + 1);
    if (inner[gt - 1] === '/') {
      out.push({ tag, raw, attrs: attrsOf(raw), inner: '' });
      i = gt + 1;
      continue;
    }
    const close = findClose(inner, tag, gt + 1);
    if (close === -1) break;
    out.push({ tag, raw, attrs: attrsOf(raw), inner: inner.slice(gt + 1, close.contentEnd) });
    i = close.end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SPEC VERDICTS
// ---------------------------------------------------------------------------

const finding = (code, detail, opts = {}) => ({
  code,
  slide: opts.slide ?? null,
  shape: opts.shape ?? null,
  severity: opts.severity || 'error',
  status: opts.status || 'confirmed',
  detail,
});

/** cy > cx portrait, cx > cy landscape, equal is a failure (a square slide has no orientation). */
export function orientationOf(cx, cy) {
  if (cy > cx) return 'portrait';
  if (cx > cy) return 'landscape';
  return 'square';
}

/** p:sldSz, read out of ppt/presentation.xml. type is absent in a conforming custom-size deck. */
export function readSlideSize(presentationXml) {
  const el = readElement(presentationXml, 'sldSz');
  if (!el) return null;
  const cx = Number(attr(el.attrs, 'cx'));
  const cy = Number(attr(el.attrs, 'cy'));
  const type = attr(el.attrs, 'type');
  return {
    cx: Number.isFinite(cx) ? cx : null,
    cy: Number.isFinite(cy) ? cy : null,
    type: type === undefined ? null : type,
    raw: el.raw,
  };
}

/**
 * The three slide-size verdicts. No tolerance anywhere: the frozen spec's own numbers differ from
 * a rounded 8.27 x 11.69in by ~0.06mm, and a tolerance wide enough to hide that is a tolerance wide
 * enough to ship a deck a print shop rejects.
 */
export function checkSlideSize(size) {
  const out = [];
  if (!size || size.cx === null || size.cy === null) {
    out.push(finding('NO_SLIDE_SIZE', 'ppt/presentation.xml 에 p:sldSz 가 없거나 cx/cy 가 수치가 아니다.'));
    return out;
  }
  const { cx, cy, type } = size;

  if (cx === PRESET_TRAP.cx && cy === PRESET_TRAP.cy) {
    out.push(finding(
      'PRESET_TRAP',
      `PowerPoint 의 'A4 용지' 프리셋 치수다(${cx}x${cy} EMU = 10.833x7.5in 가로). 이름만 A4 이고 A4 가 아니다. `
      + `필요한 값은 ${A4P.cx}x${A4P.cy} 다.`,
    ));
  }

  // Absent type is a PASS: OOXML defaults p:sldSz@type to "custom", and pptxgenjs emits no type at all.
  if (type !== null && type !== 'custom') {
    out.push(finding(
      'PRESET_TYPE_ATTR',
      `p:sldSz@type="${type}" 다. 치수가 맞아도 선언이 프리셋이면 뷰어와 인쇄 경로가 프리셋을 따라갈 수 있다. `
      + `type 속성을 제거하거나 "custom" 으로 둔다.`,
    ));
  }

  if (cx !== A4P.cx || cy !== A4P.cy) {
    out.push(finding(
      'NOT_A4_PORTRAIT',
      `sldSz 가 ${cx}x${cy} EMU (${round2(mmOf(cx))}x${round2(mmOf(cy))}mm) 다. `
      + `A4 세로는 정확히 ${A4P.cx}x${A4P.cy} EMU (210x297mm) 이고 허용오차는 0 이다.`,
    ));
  }

  if (orientationOf(cx, cy) === 'square') {
    out.push(finding('MIXED_ORIENTATION', `cx 와 cy 가 같다(${cx}). 정사각형 슬라이드라 세로/가로 판정이 불가능하다.`));
  }

  return out;
}

/**
 * Bounds and margin, per edge. Outside the slide and outside the margin are the same defect at two
 * severities, so an edge that already left the slide is reported once as SHAPE_OUT_OF_BOUNDS and
 * not a second time as MARGIN_VIOLATION. Both are pure coordinate arithmetic, hence confirmed.
 */
export function checkShapeBounds(shape, ctx) {
  const out = [];
  const { slideCx, slideCy, marginEmu } = ctx;
  const { x, y, cx, cy } = shape;
  if ([x, y, cx, cy].some((v) => !Number.isFinite(v))) return out;

  const where = { slide: ctx.slide, shape: shape.label };
  const oob = [];
  const margin = [];
  const note = (list, edge, over) => list.push(`${edge} ${over} EMU (${mmStr(over)}mm)`);

  if (x < 0) note(oob, '왼쪽', -x);
  else if (x < marginEmu) note(margin, '왼쪽', marginEmu - x);
  if (y < 0) note(oob, '위', -y);
  else if (y < marginEmu) note(margin, '위', marginEmu - y);
  if (x + cx > slideCx) note(oob, '오른쪽', x + cx - slideCx);
  else if (x + cx > slideCx - marginEmu) note(margin, '오른쪽', x + cx - (slideCx - marginEmu));
  if (y + cy > slideCy) note(oob, '아래', y + cy - slideCy);
  else if (y + cy > slideCy - marginEmu) note(margin, '아래', y + cy - (slideCy - marginEmu));

  if (oob.length) {
    out.push(finding(
      'SHAPE_OUT_OF_BOUNDS',
      `도형이 슬라이드를 벗어난다: ${oob.join(', ')}. `
      + `상자 x=${x} y=${y} cx=${cx} cy=${cy}, 슬라이드 ${slideCx}x${slideCy}.`,
      where,
    ));
  }
  if (margin.length) {
    out.push(finding(
      'MARGIN_VIOLATION',
      `도형이 여백(${round2(mmOf(marginEmu))}mm)을 침범한다: ${margin.join(', ')}. `
      + `상자 x=${x} y=${y} cx=${cx} cy=${cy}.`,
      where,
    ));
  }
  return out;
}

/** The three Korean font slots. Absent slots may still inherit from the theme, so this reports rather than fails. */
function checkFontSlots(run, where) {
  const out = [];
  const slots = { 'a:latin': run.latin, 'a:ea': run.ea, 'a:cs': run.cs };
  const missing = Object.entries(slots).filter(([, v]) => !v).map(([k]) => k);
  const present = [...new Set(Object.values(slots).filter(Boolean))];

  if (missing.length && missing.length < 3) {
    out.push(finding(
      'FONT_SLOT_MISSING',
      `run 의 폰트 슬롯 ${missing.join('/')} 가 없다(선언된 것: ${present.join(', ') || '없음'}). `
      + `테마가 채워 주면 정상이지만, 한글은 a:ea 가 비면 뷰어 폴백으로 밀려 tofu 가 난다.`,
      { ...where, severity: 'warn', status: 'unconfirmed' },
    ));
  }
  if (present.length > 1) {
    out.push(finding(
      'FONT_SLOT_MISMATCH',
      `run 의 세 슬롯이 서로 다른 typeface 를 가리킨다: ${present.map((p) => `"${p}"`).join(' / ')}. `
      + `한글 3슬롯은 같은 이름이어야 라틴/한글 혼용 줄에서 글꼴이 갈리지 않는다.`,
      { ...where, severity: 'warn' },
    ));
  }
  return out;
}

// ---------------------------------------------------------------------------
// SLIDE PARSING
// ---------------------------------------------------------------------------

const SHAPE_TAGS = new Set(['sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp']);

/**
 * Slide parts in presentation order: p:sldIdLst gives the order, the rels part gives the paths.
 * Falls back to numeric filename order when either is missing, which is what a hand-built or
 * partially damaged deck looks like.
 */
export function slideParts(zip) {
  const pres = zip.readText('ppt/presentation.xml');
  const relsXml = zip.readText('ppt/_rels/presentation.xml.rels');
  const ordered = [];
  if (pres && relsXml) {
    const rels = new Map();
    for (const el of readElements(relsXml, 'Relationship')) {
      const id = attr(el.attrs, 'Id');
      const target = attr(el.attrs, 'Target');
      if (id && target) rels.set(id, target);
    }
    const lst = readElement(pres, 'sldIdLst');
    if (lst) {
      for (const el of readElements(lst.inner, 'sldId')) {
        // r:id, never the sibling plain `id` attribute, which is the slide's own numeric id.
        const rid = Object.entries(el.attrs).find(([k]) => k.endsWith(':id'))?.[1];
        const target = rid && rels.get(rid);
        if (!target) continue;
        const part = path.posix.normalize(path.posix.join('ppt', target)).replace(/^\/+/, '');
        if (zip.has(part)) ordered.push(part);
      }
    }
  }
  if (ordered.length) return ordered;
  return zip.names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
}

/** a:bodyPr: insets, wrap and autofit. Autofit means the viewer resizes, so overflow stops being assertable. */
function parseBodyPr(txBodyInner) {
  const el = readElement(txBodyInner, 'bodyPr');
  const a = el ? el.attrs : {};
  const num = (name, dflt) => {
    const v = Number(attr(a, name));
    return Number.isFinite(v) ? v : dflt;
  };
  const inner = el ? el.inner : '';
  return {
    wrap: attr(a, 'wrap') || 'square',
    lIns: num('lIns', INSET_DEFAULT.l),
    tIns: num('tIns', INSET_DEFAULT.t),
    rIns: num('rIns', INSET_DEFAULT.r),
    bIns: num('bIns', INSET_DEFAULT.b),
    autofit: /<[^>]*\b(?:normAutofit|spAutoFit)\b/.test(inner) ? (/spAutoFit/.test(inner) ? 'spAutoFit' : 'normAutofit') : 'none',
    present: Boolean(el),
  };
}

/** Runs of one paragraph, split into forced lines at a:br. */
function parseParagraph(pInner) {
  const brSplit = new RegExp(`<${NS}br\\b(?:\\s*/>|[^>]*>[\\s\\S]*?</${NS}br>)`, 'g');
  return pInner.split(brSplit).map((segment) => {
    const runs = [];
    for (const r of readElements(segment, 'r')) {
      const rPr = readElement(r.inner, 'rPr');
      const sz = rPr ? Number(attr(rPr.attrs, 'sz')) : NaN;
      const face = (tag) => {
        const el = rPr ? readElement(rPr.inner, tag) : null;
        const tf = el ? attr(el.attrs, 'typeface') : undefined;
        return tf || null;
      };
      const t = readElement(r.inner, 't');
      runs.push({
        text: t ? xmlDecode(t.inner) : '',
        szPt: Number.isFinite(sz) ? sz / 100 : null,
        latin: face('latin'),
        ea: face('ea'),
        cs: face('cs'),
      });
    }
    return runs;
  }).filter((runs) => runs.length > 0);
}

/** One shape's box plus its text. Grouped children stay inside their group's absolute box. */
function parseShape(child) {
  const nv = readElement(child.inner, 'cNvPr');
  const id = nv ? attr(nv.attrs, 'id') : null;
  const name = nv ? attr(nv.attrs, 'name') : null;
  const label = (name && name.trim()) || (id ? `#${id}` : `<${child.tag}>`);

  // grpSp keeps its own a:xfrm in p:grpSpPr; sp/pic in p:spPr; graphicFrame in p:xfrm. Reading the
  // first xfrm inside the shape covers all three, and never reaches a child shape's because those
  // sit deeper than the shape's own properties element.
  const xfrm = readElement(child.inner, 'xfrm');
  const off = xfrm ? readElement(xfrm.inner, 'off') : null;
  const ext = xfrm ? readElement(xfrm.inner, 'ext') : null;
  const num = (el, k) => {
    if (!el) return NaN;
    const v = Number(attr(el.attrs, k));
    return Number.isFinite(v) ? v : NaN;
  };

  const txBody = readElement(child.inner, 'txBody');
  const paragraphs = [];
  if (txBody) for (const p of readElements(txBody.inner, 'p')) paragraphs.push(parseParagraph(p.inner));

  // a:lnSpc scales the font's own line height. Findings ignore it on purpose (the font metric
  // alone is the sound floor); only --suggest-deck applies it, where under-provisioning is the
  // costly direction. build_a4p.js emits 120%, so ignoring it would propose too few rows.
  let lineSpacing = 1;
  if (txBody) {
    const ln = readElement(txBody.inner, 'lnSpc');
    const pct = ln ? readElement(ln.inner, 'spcPct') : null;
    const val = pct ? Number(attr(pct.attrs, 'val')) : NaN;
    if (Number.isFinite(val) && val > 0) lineSpacing = val / 100000;
  }

  return {
    tag: child.tag,
    label,
    x: num(off, 'x'),
    y: num(off, 'y'),
    cx: num(ext, 'cx'),
    cy: num(ext, 'cy'),
    hasXfrm: Boolean(xfrm && off && ext),
    body: txBody ? parseBodyPr(txBody.inner) : null,
    lineSpacing,
    paragraphs,
  };
}

/** Top-level shapes of one slide: direct children of p:spTree, minus the tree's own group properties. */
export function parseSlide(slideXml) {
  const tree = readElement(slideXml, 'spTree');
  if (!tree) return [];
  return childElements(tree.inner)
    .filter((c) => SHAPE_TAGS.has(localName(c.tag)))
    .map(parseShape);
}

// ---------------------------------------------------------------------------
// FONT READER (TTF / TTC / OTF)
// ---------------------------------------------------------------------------
//
// Every offset below is bounds-checked before it is dereferenced: --font-file is arbitrary user
// input, and a truncated or hostile file must degrade to "estimate", never crash the verifier.
//
// The two traps that make a naive reader silently wrong rather than loudly broken:
//   - hmtx is indexed by GLYPH ID, not by character code, so a cmap is mandatory. And CJK fonts
//     routinely ship format 12 as their real subtable, so a format-4-only reader hands back
//     .notdef widths for exactly the text this skill exists to lay out.
//   - past hhea.numberOfHMetrics, hmtx stops carrying advances and only leftSideBearings follow.
//     Noto Sans CJK KR has numGlyphs 65535 with numberOfHMetrics 65532, so the boundary is live
//     even in the default font.

const NAME_ID = Object.freeze({ FAMILY: 1, FULL: 4, POSTSCRIPT: 6, TYPO_FAMILY: 16 });

const fchk = (cond, message) => {
  if (!cond) throw new FontError(message);
};

function readTableDirectory(buf, base) {
  fchk(base + 12 <= buf.length, 'font: table directory out of range');
  const numTables = buf.readUInt16BE(base + 4);
  fchk(numTables > 0 && numTables < 512, `font: implausible numTables ${numTables}`);
  fchk(base + 12 + numTables * 16 <= buf.length, 'font: table records out of range');
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    const tag = buf.toString('latin1', rec, rec + 4);
    const offset = buf.readUInt32BE(rec + 8);
    const length = buf.readUInt32BE(rec + 12);
    if (offset >= 0 && offset + length <= buf.length) tables.set(tag, { offset, length });
  }
  return tables;
}

/** Face offsets: a bare font has one, a ttcf collection has numFonts. Never index a face by number. */
function faceOffsets(buf) {
  fchk(buf.length >= 12, 'font: file too small');
  if (buf.toString('latin1', 0, 4) === 'ttcf') {
    const numFonts = buf.readUInt32BE(8);
    fchk(numFonts > 0 && numFonts < 1024, `font: implausible ttcf numFonts ${numFonts}`);
    fchk(12 + numFonts * 4 <= buf.length, 'font: ttcf offset table out of range');
    const out = [];
    for (let i = 0; i < numFonts; i++) out.push(buf.readUInt32BE(12 + i * 4));
    return out;
  }
  return [0];
}

function decodeNameString(buf, start, length, platformID) {
  fchk(start >= 0 && start + length <= buf.length, 'font: name string out of range');
  const slice = buf.subarray(start, start + length);
  if (platformID === 3 || platformID === 0) {
    // UTF-16BE. swap16 needs an even length; an odd one is malformed, so drop the stray byte.
    const even = slice.length % 2 === 0 ? slice : slice.subarray(0, slice.length - 1);
    return Buffer.from(even).swap16().toString('utf16le');
  }
  return slice.toString('latin1');
}

/** nameID -> string, preferring the Windows/Unicode records that PowerPoint itself matches on. */
function readNames(buf, tables) {
  const t = tables.get('name');
  fchk(t, 'font: no name table');
  const base = t.offset;
  fchk(base + 6 <= buf.length, 'font: name header out of range');
  const count = buf.readUInt16BE(base + 2);
  const stringOffset = buf.readUInt16BE(base + 4);
  fchk(base + 6 + count * 12 <= buf.length, 'font: name records out of range');
  const best = new Map();
  for (let i = 0; i < count; i++) {
    const rec = base + 6 + i * 12;
    const platformID = buf.readUInt16BE(rec);
    const nameID = buf.readUInt16BE(rec + 6);
    const length = buf.readUInt16BE(rec + 8);
    const offset = buf.readUInt16BE(rec + 10);
    if (!Object.values(NAME_ID).includes(nameID)) continue;
    const rank = platformID === 3 ? 3 : platformID === 0 ? 2 : 1;
    const prev = best.get(nameID);
    if (prev && prev.rank >= rank) continue;
    let value;
    try {
      value = decodeNameString(buf, base + stringOffset + offset, length, platformID);
    } catch {
      continue;
    }
    if (value) best.set(nameID, { rank, value });
  }
  const out = {};
  for (const [id, v] of best) out[id] = v.value;
  return out;
}

/** Normalized comparison key: font names differ by case and spacing far more often than by content. */
export function normFontName(name) {
  return String(name || '').toLowerCase().replace(/[\s_-]+/g, '');
}

/** Does any of a face's names identify it as `wanted`? Exact first, then a guarded prefix match. */
export function faceMatches(names, wanted) {
  const want = normFontName(wanted);
  if (!want) return false;
  const candidates = Object.values(names).map(normFontName).filter(Boolean);
  if (candidates.includes(want)) return true;
  // "Noto Sans CJK KR" must not match "Noto Sans Mono CJK KR", so only accept a prefix when what
  // follows is a style suffix (Regular/Bold/...), never more family words.
  return candidates.some((c) => c.startsWith(want) && /^(regular|book|roman|bold|italic|oblique|medium|light|thin|black|semibold|demibold|extrabold|ultralight|demilight|)$/.test(c.slice(want.length)));
}

function parseCmapSubtable(buf, base, format) {
  if (format === 0) {
    fchk(base + 262 <= buf.length, 'font: cmap0 out of range');
    const table = buf.subarray(base + 6, base + 262);
    return (cp) => (cp < 256 ? table[cp] : 0);
  }
  if (format === 4) {
    fchk(base + 14 <= buf.length, 'font: cmap4 header out of range');
    const segX2 = buf.readUInt16BE(base + 6);
    const seg = segX2 >> 1;
    const endBase = base + 14;
    const startBase = endBase + segX2 + 2;
    const deltaBase = startBase + segX2;
    const rangeBase = deltaBase + segX2;
    fchk(rangeBase + segX2 <= buf.length, 'font: cmap4 arrays out of range');
    return (cp) => {
      if (cp > 0xffff) return 0;
      let lo = 0;
      let hi = seg - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (buf.readUInt16BE(endBase + mid * 2) < cp) lo = mid + 1;
        else hi = mid - 1;
      }
      if (lo >= seg) return 0;
      const start = buf.readUInt16BE(startBase + lo * 2);
      if (cp < start) return 0;
      const delta = buf.readInt16BE(deltaBase + lo * 2);
      const rangeOffset = buf.readUInt16BE(rangeBase + lo * 2);
      if (rangeOffset === 0) return (cp + delta) & 0xffff;
      const gAddr = rangeBase + lo * 2 + rangeOffset + (cp - start) * 2;
      if (gAddr + 2 > buf.length) return 0;
      const g = buf.readUInt16BE(gAddr);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    };
  }
  if (format === 6) {
    fchk(base + 10 <= buf.length, 'font: cmap6 header out of range');
    const first = buf.readUInt16BE(base + 6);
    const count = buf.readUInt16BE(base + 8);
    fchk(base + 10 + count * 2 <= buf.length, 'font: cmap6 array out of range');
    return (cp) => (cp >= first && cp < first + count ? buf.readUInt16BE(base + 10 + (cp - first) * 2) : 0);
  }
  if (format === 12) {
    fchk(base + 16 <= buf.length, 'font: cmap12 header out of range');
    const nGroups = buf.readUInt32BE(base + 12);
    fchk(nGroups < 1_000_000 && base + 16 + nGroups * 12 <= buf.length, 'font: cmap12 groups out of range');
    const groupsBase = base + 16;
    return (cp) => {
      let lo = 0;
      let hi = nGroups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = groupsBase + mid * 12;
        const startChar = buf.readUInt32BE(g);
        const endChar = buf.readUInt32BE(g + 4);
        if (cp < startChar) hi = mid - 1;
        else if (cp > endChar) lo = mid + 1;
        else return buf.readUInt32BE(g + 8) + (cp - startChar);
      }
      return 0;
    };
  }
  throw new FontError(`font: unsupported cmap format ${format}`);
}

/**
 * Best Unicode cmap. Preference (3,10) > (3,1) > (0,x), and format 14 (variation selectors) is
 * skipped outright: it is not a character-to-glyph map and reading it as one yields nonsense.
 */
function parseCmap(buf, tables) {
  const t = tables.get('cmap');
  fchk(t, 'font: no cmap table');
  const base = t.offset;
  fchk(base + 4 <= buf.length, 'font: cmap header out of range');
  const numTables = buf.readUInt16BE(base + 2);
  fchk(base + 4 + numTables * 8 <= buf.length, 'font: cmap records out of range');
  let best = null;
  for (let i = 0; i < numTables; i++) {
    const rec = base + 4 + i * 8;
    const platformID = buf.readUInt16BE(rec);
    const encodingID = buf.readUInt16BE(rec + 2);
    const subOffset = base + buf.readUInt32BE(rec + 4);
    if (subOffset + 2 > buf.length) continue;
    const format = buf.readUInt16BE(subOffset);
    if (![0, 4, 6, 12].includes(format)) continue;
    let score = 0;
    if (platformID === 3 && encodingID === 10) score = 100;
    else if (platformID === 0 && encodingID >= 4) score = 95;
    else if (platformID === 3 && encodingID === 1) score = 80;
    else if (platformID === 0) score = 70;
    else if (platformID === 1) score = 10;
    if (format === 12) score += 5;
    if (!best || score > best.score) best = { score, subOffset, format };
  }
  fchk(best, 'font: no usable cmap subtable');
  return parseCmapSubtable(buf, best.subOffset, best.format);
}

/**
 * Open one face and expose the three things width prediction needs: names, unitsPerEm, and an
 * advance lookup by code point. Throws FontError on anything malformed; callers degrade.
 */
export function loadFace(buf, faceOffset) {
  const tables = readTableDirectory(buf, faceOffset);
  const head = tables.get('head');
  fchk(head && head.offset + 54 <= buf.length, 'font: no head table');
  const unitsPerEm = buf.readUInt16BE(head.offset + 18);
  fchk(unitsPerEm > 0, 'font: unitsPerEm is 0');

  const hhea = tables.get('hhea');
  fchk(hhea && hhea.offset + 36 <= buf.length, 'font: no hhea table');
  const ascender = buf.readInt16BE(hhea.offset + 4);
  const descender = buf.readInt16BE(hhea.offset + 6);
  const lineGap = buf.readInt16BE(hhea.offset + 8);
  const numberOfHMetrics = buf.readUInt16BE(hhea.offset + 34);
  fchk(numberOfHMetrics > 0, 'font: numberOfHMetrics is 0');

  const maxp = tables.get('maxp');
  fchk(maxp && maxp.offset + 6 <= buf.length, 'font: no maxp table');
  const numGlyphs = buf.readUInt16BE(maxp.offset + 4);

  // Weight and slant, needed to tell one face of a family from another. Names cannot do it: the
  // Black cut of Noto Sans CJK carries nameID 16 "Noto Sans CJK KR", byte for byte the same
  // typographic family as the Regular cut. usWeightClass is the only field that separates them.
  const os2 = tables.get('OS/2');
  const weightClass = os2 && os2.offset + 6 <= buf.length ? buf.readUInt16BE(os2.offset + 4) : 400;
  const macStyle = buf.readUInt16BE(head.offset + 44);

  const hmtx = tables.get('hmtx');
  fchk(hmtx, 'font: no hmtx table');
  const lookup = parseCmap(buf, tables);
  const names = readNames(buf, tables);

  const lastMetric = Math.min(numberOfHMetrics, Math.floor(hmtx.length / 4)) - 1;
  fchk(lastMetric >= 0, 'font: hmtx too small for a single metric');

  const advanceOfGlyph = (gid) => {
    // Past numberOfHMetrics the table stops carrying advances; the last one applies to every glyph
    // after it. Monospaced CJK fonts lean on this hard, so getting it wrong is not a corner case.
    const idx = gid < numberOfHMetrics ? Math.min(gid, lastMetric) : lastMetric;
    const at = hmtx.offset + idx * 4;
    if (at + 2 > buf.length) throw new FontError('font: hmtx read out of range');
    return buf.readUInt16BE(at);
  };

  return {
    names,
    family: names[NAME_ID.TYPO_FAMILY] || names[NAME_ID.FAMILY] || names[NAME_ID.FULL] || names[NAME_ID.POSTSCRIPT] || '',
    unitsPerEm,
    numGlyphs,
    numberOfHMetrics,
    weightClass,
    bold: Boolean(macStyle & 0x01),
    italic: Boolean(macStyle & 0x02),
    // hhea-derived line height; PowerPoint's single-spaced line tracks these metrics closely.
    lineHeightEm: (ascender - descender + lineGap) / unitsPerEm,
    variable: tables.has('fvar'),
    hasHVAR: tables.has('HVAR'),
    glyphOf: lookup,
    advanceOfGlyph,
    /** Advance in em for one code point. gid 0 (.notdef) is reported so callers can drop confidence. */
    advanceEm(cp) {
      const gid = lookup(cp);
      if (!gid || gid >= Math.max(numGlyphs, 1)) return { em: advanceOfGlyph(0) / unitsPerEm, missing: true };
      return { em: advanceOfGlyph(gid) / unitsPerEm, missing: false };
    },
  };
}

/**
 * Open a font file and return the face whose name table says it is `family`.
 * Returns null when the file cannot be read, cannot be parsed, or holds no matching face. That
 * "no matching face" case is the whole point: it is what makes --font-file verified, not trusted.
 */
export function openFontFile(filePath, family) {
  let buf;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size < 12) return null;
    buf = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  let offsets;
  try {
    offsets = faceOffsets(buf);
  } catch {
    return null;
  }
  const faces = [];
  for (let i = 0; i < offsets.length; i++) {
    try {
      const face = loadFace(buf, offsets[i]);
      faces.push({ index: i, face });
    } catch {
      // A collection with one bad face is still usable through its good ones.
    }
  }
  if (!faces.length) return null;
  const matching = family ? faces.filter(({ face }) => faceMatches(face.names, family)) : [];
  if (!matching.length) return null;
  // Several faces of one collection can answer to the same family name, so pick the upright
  // regular cut rather than whichever happened to be stored first.
  const hit = matching.reduce((best, cur) => (faceDistance(cur.face) < faceDistance(best.face) ? cur : best));
  return { path: filePath, faceIndex: hit.index, faceCount: offsets.length, ...hit.face };
}

/**
 * How far a face is from "the plain upright text cut", which is what a bare typeface name means.
 * Zero is ideal. Weight matters because Latin advances move with it (Noto Sans CJK 'A' runs 574
 * units at Thin and 660 at Black); CJK advances do not move at all, being duospaced at 0.92em.
 */
export function faceDistance(face) {
  return Math.abs((face.weightClass || 400) - 400) + (face.italic ? 10000 : 0);
}

// ---------------------------------------------------------------------------
// FONT PATH RESOLUTION (names in, paths out)
// ---------------------------------------------------------------------------
//
// A pptx names a typeface; hmtx needs a file. Resolution failure is a normal path here, not an
// exception: on a machine without the deck's font the honest answer is "estimate".

/** fontconfig pattern escaping. An unescaped ':' or ',' turns a family name into a property list. */
const fcEscape = (name) => String(name).replace(/([\\:,\-])/g, '\\$1');

function fcMatch(name) {
  let r;
  try {
    r = spawnSync('fc-match', [`--format=%{file}`, fcEscape(name)], { encoding: 'utf8', timeout: 4000 });
  } catch {
    return null;
  }
  if (!r || r.error || r.status !== 0) return null;
  const file = (r.stdout || '').trim();
  return file && fs.existsSync(file) ? file : null;
}

export function fontDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library', 'Fonts')];
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    const win = process.env.SystemRoot || 'C:\\Windows';
    return [path.join(win, 'Fonts'), local ? path.join(local, 'Microsoft', 'Windows', 'Fonts') : null].filter(Boolean);
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.local', 'share', 'fonts'), path.join(home, '.fonts')];
}

function walkFonts(dirs) {
  const out = [];
  const seen = new Set();
  const visit = (dir, depth) => {
    if (depth > FONT_SCAN.MAX_DEPTH || out.length >= FONT_SCAN.MAX_FILES) return;
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (out.length >= FONT_SCAN.MAX_FILES) return;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (seen.has(full)) continue;
        seen.add(full);
        visit(full, depth + 1);
      } else if (FONT_EXT.test(it.name)) {
        out.push(full);
      }
    }
  };
  for (const d of dirs) visit(d, 0);
  return out;
}

/**
 * Name -> verified path. fc-match first, then an OS-specific glob ranked by filename similarity.
 * Every candidate, fc-match's included, is opened and checked against the name table before it is
 * accepted: fc-match always answers, so an unverified answer to "Malgun Gothic" on Linux would be
 * DejaVu Sans wearing the wrong label.
 */
export function resolveFont(family, extraPaths = []) {
  const tried = [];
  for (const p of extraPaths) {
    if (!p) continue;
    tried.push(p);
    const font = openFontFile(p, family);
    if (font) return { font, via: 'explicit' };
  }

  const fc = fcMatch(family);
  if (fc && !tried.includes(fc)) {
    tried.push(fc);
    const font = openFontFile(fc, family);
    if (font) return { font, via: 'fc-match' };
  }

  const want = normFontName(family);
  const files = walkFonts(fontDirs())
    .filter((f) => !tried.includes(f))
    .map((f) => ({ f, score: filenameScore(normFontName(path.basename(f).replace(FONT_EXT, '')), want) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, FONT_SCAN.MAX_OPENS);
  // Best, not first. One family is routinely spread across a file per weight, and taking the first
  // hit picks whichever the directory walk reached first: NotoSansCJK-Black.ttc sorts before
  // -Regular.ttc alphabetically and answers to the same family name.
  let best = null;
  for (const { f } of files) {
    const font = openFontFile(f, family);
    if (!font) continue;
    if (!best || faceDistance(font) < faceDistance(best)) best = font;
    if (faceDistance(font) === 0) break;
  }
  return best ? { font: best, via: 'glob' } : { font: null, via: 'none' };
}

const commonPrefixLen = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

/**
 * Rank a font FILENAME against a wanted family name. Only ever a ranking: the name table still has
 * the final say in openFontFile, so a generous score costs one file open and never a wrong answer.
 *
 * Generosity is required, not sloppiness. A filename is not a face name, and for the fonts this
 * skill cares about most it actively disagrees with one:
 *   NotoSansCJK-Regular.ttc holds "Noto Sans CJK KR" (a collection; no filename can name 10 faces)
 *   malgun.ttf             holds "Malgun Gothic"    (the shipped Windows Korean font)
 * A strict substring test rejects both, which on any machine without fontconfig would silently
 * demote every Korean deck to "estimate".
 */
function filenameScore(base, want) {
  if (!base || !want) return 0;
  if (base === want) return 1000;
  if (base.startsWith(want)) return 800;
  if (want.startsWith(base) && base.length >= 4) return 700;
  if (base.includes(want)) return 600;
  if (want.includes(base) && base.length >= 4) return 500;
  const shared = commonPrefixLen(base, want);
  return shared >= 5 ? shared : 0;
}

// ---------------------------------------------------------------------------
// WIDTH PREDICTION
// ---------------------------------------------------------------------------
//
// Always a LOWER BOUND. Kerning pairs shrink or grow a line and are not applied; line-breaking
// rules (Korean allows a break almost anywhere, Latin does not) are not reproduced. So a run's
// real advance is at least what is computed here, which is what makes a positive overflow finding
// sound and a negative one merely silent.

const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3fffd],
];

const isWide = (cp) => WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);

/**
 * The crude fallback used only when nothing was measured. Its error runs from +2.5% to +96% on
 * real corpora (plan F5), which is exactly why anything computed from it is labelled unconfirmed
 * and never phrased as an assertion.
 */
const estimateEm = (cp) => (cp === 0x20 ? 0.25 : isWide(cp) ? 1.0 : 0.5);

/** Width of one run in EMU, plus whether the font could actually render every character. */
export function runWidthEmu(text, szPt, font) {
  let em = 0;
  let missing = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0a || cp === 0x0d) continue;
    if (font) {
      const a = font.advanceEm(cp);
      em += a.em;
      if (a.missing) missing++;
    } else {
      em += estimateEm(cp);
    }
  }
  return { emu: em * szPt * EMU_PER_PT, em, missing };
}

/**
 * Text fit for one shape. Two distinct defects, because they have different proofs:
 *   wrap="none" -> a single line wider than the box runs out of the shape horizontally.
 *   wrapping    -> ceil(lowerBoundWidth / usableWidth) is a LOWER BOUND on line count (greedy
 *                  breaking can only ever need more lines), so a stack of lines taller than the
 *                  box proves vertical overflow.
 * Either way the finding is only "confirmed" when every ingredient was measured rather than guessed.
 */
function checkTextFit(shape, ctx) {
  const out = [];
  if (!shape.body || !shape.hasXfrm || !shape.paragraphs.length) return out;
  const usableW = shape.cx - shape.body.lIns - shape.body.rIns;
  const usableH = shape.cy - shape.body.tIns - shape.body.bIns;
  if (!(usableW > 0) || !(usableH > 0)) return out;

  const where = { slide: ctx.slide, shape: shape.label };
  let totalH = 0;
  let anyText = false;
  let allMeasured = true;
  let anyMissingGlyph = false;
  let anyInheritedSz = false;
  let widest = 0;

  for (const paragraph of shape.paragraphs) {
    for (const line of paragraph) {
      let lineW = 0;
      let lineH = 0;
      // Confidence is tracked per line as well as per shape: a horizontal finding on line 1 must
      // not borrow confidence from a font that only line 5 turned out to be missing.
      let lineMeasured = true;
      let lineMissingGlyph = false;
      let lineInheritedSz = false;
      for (const run of line) {
        if (!run.text) continue;
        anyText = true;
        const szPt = run.szPt ?? FALLBACK_SZ_PT;
        if (run.szPt === null) lineInheritedSz = true;
        const resolved = ctx.fontFor(run.latin);
        if (!resolved.font) lineMeasured = false;
        const w = runWidthEmu(run.text, szPt, resolved.font);
        if (w.missing) lineMissingGlyph = true;
        lineW += w.emu;
        const lh = (resolved.font ? resolved.font.lineHeightEm : FALLBACK_LINE_EM) * szPt * EMU_PER_PT;
        if (lh > lineH) lineH = lh;
      }
      allMeasured = allMeasured && lineMeasured;
      anyMissingGlyph = anyMissingGlyph || lineMissingGlyph;
      anyInheritedSz = anyInheritedSz || lineInheritedSz;
      if (!lineH) continue;
      widest = Math.max(widest, lineW);
      if (shape.body.wrap === 'none') {
        totalH += lineH;
        if (lineW > usableW) {
          out.push(fitFinding('TEXT_OVERFLOW_NOWRAP', where, lineMeasured, lineMissingGlyph, lineInheritedSz, shape.body.autofit,
            `wrap="none" 인데 한 줄 폭 ${Math.round(lineW)} EMU (${round2(mmOf(lineW))}mm) 가 상자 안쪽 폭 `
            + `${usableW} EMU (${round2(mmOf(usableW))}mm) 보다 크다`));
        }
      } else {
        totalH += Math.max(1, Math.ceil(lineW / usableW)) * lineH;
      }
    }
  }

  if (anyText && shape.body.wrap !== 'none' && totalH > usableH) {
    out.push(fitFinding('TEXT_OVERFLOW', where, allMeasured, anyMissingGlyph, anyInheritedSz, shape.body.autofit,
      `줄 높이 합계 하한 ${Math.round(totalH)} EMU (${round2(mmOf(totalH))}mm) 가 상자 안쪽 높이 `
      + `${usableH} EMU (${round2(mmOf(usableH))}mm) 를 넘는다 (가장 긴 줄 ${round2(mmOf(widest))}mm)`));
  }
  return out;
}

/**
 * Phrase an overflow finding at the confidence its inputs actually support. In estimate mode this
 * never says the text overflows; it says the tool cannot confirm it, and the finding is a warning.
 */
function fitFinding(code, where, measured, missingGlyph, inheritedSz, autofit, body) {
  const blockers = [];
  if (!measured) blockers.push('폰트 미측정(estimate)');
  if (missingGlyph) blockers.push('폰트에 없는 글자 포함');
  if (inheritedSz) blockers.push(`a:rPr@sz 부재(${FALLBACK_SZ_PT}pt 로 가정)`);
  if (autofit !== 'none') blockers.push(`a:bodyPr 에 ${autofit} (뷰어가 크기를 조정한다)`);
  if (!blockers.length) {
    return finding(code, `텍스트가 상자를 넘는다: ${body}. 폭은 커널링/줄바꿈 미반영 하한이므로 실제는 이보다 넓다.`, { ...where, severity: 'error' });
  }
  return finding(code, `확인 불가(estimate): ${body}. 단정할 수 없는 이유: ${blockers.join(', ')}.`, { ...where, severity: 'warn', status: 'unconfirmed' });
}

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------

/** meta.marginMm contract check. An out-of-contract deck is a usage error, not a deck defect. */
export function deckMarginMm(deck) {
  const m = deck?.meta?.marginMm;
  if (m === undefined || m === null) return MARGIN_MM.DEFAULT;
  if (typeof m !== 'number' || !Number.isInteger(m) || m < MARGIN_MM.MIN || m > MARGIN_MM.MAX) {
    throw new VerifyError(
      `deck meta.marginMm 은 ${MARGIN_MM.MIN}..${MARGIN_MM.MAX} 범위의 정수여야 한다 (받은 값: ${JSON.stringify(m)})`,
      'BAD_MARGIN',
    );
  }
  return m;
}

/**
 * Verify one deck buffer. Options:
 *   fontFile  candidate font path, applied only to runs whose a:latin family it actually matches
 *   deck      parsed deck JSON, whose marginMm replaces the spec floor for the margin check
 */
export function verifyBuffer(buf, opts = {}) {
  const report = {
    skill: 'vertical-pptx',
    file: opts.file || null,
    ok: false,
    slideSize: null,
    marginMm: MARGIN_MM.DEFAULT,
    marginSource: 'spec-floor',
    fontSource: 'estimate',
    widthBasis: 'lower-bound (커널링/줄바꿈 미반영)',
    fonts: [],
    counts: { slides: 0, shapes: 0, runs: 0, errors: 0, warnings: 0 },
    findings: [],
  };

  if (opts.deck !== undefined && opts.deck !== null) {
    report.marginMm = deckMarginMm(opts.deck);
    report.marginSource = 'deck';
  }

  const zip = openZip(buf);
  const presentation = zip.readText('ppt/presentation.xml');
  if (presentation === null) {
    report.findings.push(finding('MISSING_PRESENTATION_XML', 'ppt/presentation.xml 이 없다. pptx(OPC) 패키지가 아니거나 손상됐다.'));
    return finish(report);
  }

  const size = readSlideSize(presentation);
  report.slideSize = size && {
    cx: size.cx,
    cy: size.cy,
    type: size.type,
    orientation: size.cx !== null && size.cy !== null ? orientationOf(size.cx, size.cy) : null,
    widthMm: size.cx === null ? null : round2(mmOf(size.cx)),
    heightMm: size.cy === null ? null : round2(mmOf(size.cy)),
  };
  report.findings.push(...checkSlideSize(size));

  const slideCx = size?.cx ?? A4P.cx;
  const slideCy = size?.cy ?? A4P.cy;
  const marginEmu = report.marginMm * EMU_PER_MM;

  // One resolution attempt per distinct typeface, cached. --font-file is offered to every family
  // but accepted only by the one whose name table agrees, so a mixed-typeface deck (which is what
  // an externally produced deck is) never gets one path smeared across all of its runs.
  const fontFilePath = opts.fontFile ? path.resolve(opts.fontFile) : null;
  const fontCache = new Map();
  const fontFor = (typeface) => {
    // "+mn-lt"/"+mj-lt" are theme references, resolvable only through the theme part's font scheme.
    const name = typeface && !typeface.startsWith('+') ? typeface : null;
    if (!name) return { font: null, via: 'none' };
    if (fontCache.has(name)) return fontCache.get(name);
    const resolved = resolveFont(name, fontFilePath ? [fontFilePath] : []);
    fontCache.set(name, resolved);
    return resolved;
  };

  const parts = slideParts(zip);
  report.counts.slides = parts.length;
  for (let i = 0; i < parts.length; i++) {
    const slideNo = i + 1;
    const xml = zip.readText(parts[i]);
    if (xml === null) continue;
    const shapes = parseSlide(xml);
    report.counts.shapes += shapes.length;
    for (const shape of shapes) {
      if (shape.hasXfrm) {
        report.findings.push(...checkShapeBounds(shape, { slideCx, slideCy, marginEmu, slide: slideNo }));
      }
      for (const paragraph of shape.paragraphs) {
        for (const line of paragraph) {
          for (const run of line) {
            if (!run.text) continue;
            report.counts.runs++;
            fontFor(run.latin);
            report.findings.push(...checkFontSlots(run, { slide: slideNo, shape: shape.label }));
          }
        }
      }
      report.findings.push(...checkTextFit(shape, { slide: slideNo, fontFor }));
    }
  }

  // A typeface that never resolved keeps the whole report at "estimate": the label is fail-safe by
  // construction, so a partially measured deck does not get to advertise itself as measured.
  const used = [...fontCache.entries()].filter(([name]) => Boolean(name));
  report.fonts = used.map(([name, r]) => ({
    typeface: name,
    source: r.font ? 'measured' : 'estimate',
    via: r.via,
    path: r.font ? r.font.path : null,
    face: r.font ? `#${r.font.faceIndex} of ${r.font.faceCount}` : null,
    family: r.font ? r.font.family : null,
    unitsPerEm: r.font ? r.font.unitsPerEm : null,
    variable: r.font ? r.font.variable : null,
    label: r.font ? (r.font.variable ? '가변 폰트 기본 인스턴스 폭' : '정적 폭') : null,
  }));
  report.fontSource = used.length && used.every(([, r]) => r.font) ? 'measured' : 'estimate';

  if (fontFilePath) {
    const accepted = report.fonts.some((f) => f.path === fontFilePath);
    report.fontFile = { path: fontFilePath, accepted };
    // Nothing to reject when the deck names no typeface at all, so stay quiet in that case.
    if (!accepted && used.length) {
      report.findings.push(finding(
        'FONT_FILE_MISMATCH',
        `--font-file 로 받은 "${opts.fontFile}" 의 name 테이블 패밀리가 이 덱의 a:latin typeface 와 일치하지 않아 버렸다. `
        + `이름 재해석으로 내려갔고, 그것도 실패하면 estimate 다.`,
        { severity: 'warn' },
      ));
    }
  }

  return attachFontResolver(finish(report), fontFor);
}

/** Hand the resolved-font lookup to callers (--suggest-deck) without putting a function in the JSON. */
function attachFontResolver(report, fontFor) {
  Object.defineProperty(report, 'fontFor', { value: fontFor, enumerable: false });
  return report;
}

function finish(report) {
  report.counts.errors = report.findings.filter((f) => f.severity === 'error').length;
  report.counts.warnings = report.findings.filter((f) => f.severity !== 'error').length;
  report.ok = report.counts.errors === 0;
  return report;
}

export function verifyFile(file, opts = {}) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    throw new VerifyError(`입력 파일을 읽을 수 없다: ${file} (${err.code || err.message})`, 'BAD_INPUT');
  }
  return verifyBuffer(buf, { ...opts, file: path.resolve(file) });
}

// ---------------------------------------------------------------------------
// WRITE PATH (--repair / --convert-a4p / --suggest-deck)
// ---------------------------------------------------------------------------
//
// NOTHING here moves a shape. Ever. The whole point of this skill is that a print-spec document
// does not get silently reflowed; a deck whose content sticks out of A4 gets a report saying which
// shape sticks out and by how many mm, and a human decides. Automatic repositioning would trade
// the one defect this tool exists to catch for a defect nobody can see.

/**
 * Rewrite p:sldSz to the frozen spec in place, preserving whatever namespace prefix the document
 * uses and dropping the type attribute (absent means "custom", which is what an A4 deck is).
 * String surgery on the matched element only: no reserialization of parts we are not fixing.
 */
export function replaceSlideSize(presentationXml) {
  const el = readElement(presentationXml, 'sldSz');
  if (!el) return { xml: presentationXml, changed: false, before: null, after: null };
  const keep = Object.entries(el.attrs).filter(([k]) => !['cx', 'cy', 'type'].includes(k));
  const attrs = [`cx="${A4P.cx}"`, `cy="${A4P.cy}"`, ...keep.map(([k, v]) => `${k}="${escapeXmlAttr(v)}"`)];
  const rebuilt = `<${el.tag} ${attrs.join(' ')}/>`;
  if (rebuilt === el.raw) return { xml: presentationXml, changed: false, before: el.raw, after: rebuilt };
  return {
    xml: presentationXml.slice(0, el.start) + rebuilt + presentationXml.slice(el.end),
    changed: true,
    before: el.raw,
    after: rebuilt,
  };
}

const escapeXmlAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Produce a repaired archive. Only ppt/presentation.xml is rewritten; every other part is copied
 * through with its original compressed bytes. [Content_Types].xml is forced to the front because
 * OPC requires it there and leaving it to iteration order makes the output depend on the input's
 * entry ordering.
 */
export function repairBuffer(buf) {
  const zip = openZip(buf);
  const PRES = 'ppt/presentation.xml';
  const presXml = zip.readText(PRES);
  check(presXml !== null, `${PRES} 이 없다. pptx(OPC) 패키지가 아니다.`, 'MISSING_PRESENTATION_XML');
  const swap = replaceSlideSize(presXml);

  const CT = '[Content_Types].xml';
  const ordered = [...zip.entries].sort((a, b) => (a.name === CT ? -1 : b.name === CT ? 1 : 0));
  const untouched = [];
  const records = ordered.map((e) => {
    if (e.name === PRES && swap.changed) return { ...e, replacement: Buffer.from(swap.xml, 'utf8') };
    if (!e.isDir) untouched.push(e.name);
    return { ...e, data: zip.raw(e) };
  });

  return { out: writeZip(records), changed: swap.changed, before: swap.before, after: swap.after, untouched };
}

/**
 * Per-slide breakage: which shapes fall outside the A4 portrait box, and by how much. Reported in
 * the coordinate system the shapes already have, because conversion does not move them.
 */
export function breakageReport(buf, marginEmu) {
  const zip = openZip(buf);
  const out = [];
  const parts = slideParts(zip);
  for (let i = 0; i < parts.length; i++) {
    const xml = zip.readText(parts[i]);
    if (xml === null) continue;
    const shapes = parseSlide(xml).filter((s) => s.hasXfrm);
    const broken = [];
    for (const s of shapes) {
      const over = {
        right: s.x + s.cx - A4P.cx,
        bottom: s.y + s.cy - A4P.cy,
        left: -s.x,
        top: -s.y,
      };
      const outside = Object.entries(over).filter(([, v]) => v > 0);
      const marginOnly = !outside.length && (s.x < marginEmu || s.y < marginEmu
        || s.x + s.cx > A4P.cx - marginEmu || s.y + s.cy > A4P.cy - marginEmu);
      if (outside.length || marginOnly) {
        broken.push({
          shape: s.label,
          box: { x: s.x, y: s.y, cx: s.cx, cy: s.cy },
          kind: outside.length ? 'outside-slide' : 'inside-margin',
          overflowMm: Object.fromEntries(outside.map(([k, v]) => [k, round2(mmOf(v))])),
        });
      }
    }
    out.push({ slide: i + 1, part: parts[i], shapes: shapes.length, broken });
  }
  return out;
}

// ---------------------------------------------------------------------------
// --suggest-deck
// ---------------------------------------------------------------------------
//
// The pptx gives (slide, shape); the answer has to be (page, block) `rows`. That reverse mapping
// IS INV-G run backwards, which is why the original deck JSON is a required input and why the
// pagination comes from build_a4p.js rather than from a second implementation here. A third copy
// of the grid (node builder, python builder, verifier) would be the only one no test compares:
// E1/E1b only ever check the two builders against each other.

function loadBuilder() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const target = path.join(here, 'build_a4p.js');
  if (!fs.existsSync(target)) {
    throw new VerifyError(`--suggest-deck 은 ${target} 를 필요로 한다(페이지네이션을 재구현하지 않는다).`, 'NO_BUILDER');
  }
  try {
    // build_a4p.js is CommonJS (the repo has no "type": "module"), so it loads through createRequire.
    return createRequire(import.meta.url)(target);
  } catch (err) {
    throw new VerifyError(`build_a4p.js 를 불러올 수 없다: ${err.message}`, 'NO_BUILDER');
  }
}

/**
 * Height one shape's text really needs, in EMU. Deliberately the CONSERVATIVE direction, opposite
 * to the one findings use: a proposal that under-provisions rows produces a rebuild that still
 * overflows, which is worse than a proposal that is one row generous.
 */
function requiredHeight(shape, ctx) {
  if (!shape.body || !shape.paragraphs.length) return 0;
  const usableW = shape.cx - shape.body.lIns - shape.body.rIns;
  if (!(usableW > 0)) return 0;
  let total = 0;
  for (const paragraph of shape.paragraphs) {
    for (const line of paragraph) {
      let w = 0;
      let h = 0;
      for (const run of line) {
        if (!run.text) continue;
        const szPt = run.szPt ?? FALLBACK_SZ_PT;
        const font = ctx.fontFor(run.latin).font;
        w += runWidthEmu(run.text, szPt, font).emu;
        const em = (font ? font.lineHeightEm : FALLBACK_LINE_EM) * Math.max(1, shape.lineSpacing || 1);
        h = Math.max(h, em * szPt * EMU_PER_PT);
      }
      if (h) total += Math.max(1, Math.ceil(w / usableW)) * h;
    }
  }
  return total;
}

const insetH = (shape) => (shape.body ? shape.body.tIns + shape.body.bIns : 0);

/**
 * Propose `rows` values that would stop the overflow. Returns { deck, suggestions, tooTall }.
 * Candidate rows are tried by re-running the builder's own layout(), so the box heights come from
 * the builder and this file never computes a row pitch.
 */
export function suggestDeck(deck, pptxBuf, ctx) {
  const builder = loadBuilder();
  const laid = builder.layout(deck);
  const zip = openZip(pptxBuf);
  const parts = slideParts(zip);

  // Refuse to guess: if this deck did not produce this pptx, the (slide, shape) -> (page, block)
  // mapping below is fiction. Compare shape counts and every coordinate.
  check(laid.slides.length === parts.length,
    `--deck 이 이 pptx 를 만들지 않았다: deck 은 슬라이드 ${laid.slides.length}개, pptx 는 ${parts.length}개다.`, 'DECK_MISMATCH');
  const pptxShapes = parts.map((p) => parseSlide(zip.readText(p)).filter((s) => s.hasXfrm));
  for (let i = 0; i < laid.slides.length; i++) {
    const want = laid.slides[i].shapes;
    const got = pptxShapes[i];
    check(want.length === got.length,
      `--deck 이 이 pptx 를 만들지 않았다: 슬라이드 ${i + 1} 의 도형 수가 deck ${want.length} vs pptx ${got.length} 다.`, 'DECK_MISMATCH');
    for (let j = 0; j < want.length; j++) {
      check(want[j].x === got[j].x && want[j].y === got[j].y && want[j].cx === got[j].cx && want[j].cy === got[j].cy,
        `--deck 이 이 pptx 를 만들지 않았다: 슬라이드 ${i + 1} 도형 ${j + 1} 좌표 불일치.`, 'DECK_MISMATCH');
    }
  }

  // Measured need per (page, block, item), taken from the pptx's own runs.
  const need = new Map();
  for (let i = 0; i < laid.slides.length; i++) {
    laid.slides[i].shapes.forEach((planned, j) => {
      if (planned.blockIndex === null) return;
      const shape = pptxShapes[i][j];
      const key = `${planned.pageIndex}:${planned.blockIndex}`;
      const list = need.get(key) || [];
      list[planned.itemIndex ?? 0] = requiredHeight(shape, ctx) + insetH(shape);
      need.set(key, list);
    });
  }

  const fixed = JSON.parse(JSON.stringify(deck));
  const suggestions = [];
  const tooTall = [];

  deck.pages.forEach((page, pageIndex) => {
    (page.blocks || []).forEach((block, blockIndex) => {
      const key = `${pageIndex}:${blockIndex}`;
      const needs = need.get(key);
      if (!needs) return;
      const current = builder.rowsOf(block);
      const fits = (n) => {
        const probe = JSON.parse(JSON.stringify(deck));
        probe.pages[pageIndex].blocks[blockIndex].rows = n;
        const shapes = builder.layout(probe).slides
          .flatMap((s) => s.shapes)
          .filter((s) => s.pageIndex === pageIndex && s.blockIndex === blockIndex);
        if (shapes.length !== needs.length) return false;
        return shapes.every((s, i) => (needs[i] ?? 0) <= s.cy);
      };
      if (fits(current)) return;
      let chosen = null;
      for (let n = current + 1; n <= builder.MAX_BLOCK_ROWS; n++) {
        if (fits(n)) { chosen = n; break; }
      }
      if (chosen === null) {
        // 18 is the cap that keeps geometry inside the margins. Proposing rows: 19 would produce a
        // deck the builder clamps and the verifier then rejects, so we say "split it" instead.
        tooTall.push({ page: pageIndex, block: blockIndex, type: block.type, current });
        return;
      }
      fixed.pages[pageIndex].blocks[blockIndex].rows = chosen;
      suggestions.push({ page: pageIndex, block: blockIndex, type: block.type, from: current, to: chosen });
    });
  });

  return { deck: fixed, suggestions, tooTall };
}

/** Every path where the two JSON trees differ, so "differs in rows only" is checkable, not asserted. */
export function jsonDiffPaths(a, b, base = '') {
  const paths = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const av = a ? a[k] : undefined;
    const bv = b ? b[k] : undefined;
    const here = base ? `${base}.${k}` : k;
    if (av && bv && typeof av === 'object' && typeof bv === 'object') paths.push(...jsonDiffPaths(av, bv, here));
    else if (JSON.stringify(av) !== JSON.stringify(bv)) paths.push(here);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// OUTPUT
// ---------------------------------------------------------------------------

function renderTable(report, strict) {
  const lines = [];
  const s = report.slideSize;
  lines.push(`vertical-pptx verify: ${report.file || '(buffer)'}`);
  if (s) {
    lines.push(`slide size : cx=${s.cx} cy=${s.cy} (${s.widthMm}x${s.heightMm}mm) type=${s.type ?? '(없음)'} orientation=${s.orientation}`);
  } else {
    lines.push('slide size : (p:sldSz 없음)');
  }
  lines.push(`margin     : ${report.marginMm}mm (${report.marginSource === 'deck' ? 'deck meta.marginMm' : '동결 스펙 하한'})`);
  lines.push(`counts     : slides=${report.counts.slides} shapes=${report.counts.shapes} runs=${report.counts.runs}`);
  lines.push(`fontSource : ${report.fontSource}  (width = ${report.widthBasis})`);
  for (const f of report.fonts) {
    lines.push(`  font     : "${f.typeface}" -> ${f.source}${f.path ? ` ${f.path} face=${f.face} upm=${f.unitsPerEm} via=${f.via} (${f.label})` : ' (경로 해석 실패)'}`);
  }

  if (report.findings.length) {
    lines.push('');
    lines.push(`FINDINGS (${report.findings.length})`);
    const cell = (v, n) => String(v ?? '-').padEnd(n);
    const row = (a, b, c, d, e) => `  ${cell(a, 22)} ${cell(b, 5)} ${cell(c, 18)} ${cell(d, 17)} ${e}`;
    lines.push(row('CODE', 'SLIDE', 'SHAPE', 'STATUS', 'DETAIL'));
    for (const f of report.findings) {
      lines.push(row(f.code, f.slide, f.shape, `${f.severity}/${f.status}`, f.detail));
    }
  }

  if (report.write) {
    const w = report.write;
    lines.push('');
    lines.push(`WRITE (${w.mode})${w.inPlace ? ' --in-place' : ''}`);
    lines.push(`  out        : ${w.out}`);
    lines.push(`  sldSz      : ${w.sldSzChanged ? `${w.before} -> ${w.after}` : '변경 없음(이미 규격)'}`);
    lines.push(`  re-zip     : 엔트리 ${w.entries}개 · 첫 엔트리 ${w.firstEntry} · 미치환 ${w.untouchedVerified}개 바이트 동일 · CRC/로컬헤더 재검사 ${w.integrity}`);
    lines.push('  도형은 하나도 움직이지 않았다 (자동 재배치 없음).');
    // Writing successfully and producing a conforming deck are different claims. A landscape deck
    // repaired to A4 keeps every shape where it was, so it can still fail on shapes that stick out.
    lines.push('  쓰기는 성공했다. 아래 VERDICT 는 원본이 아니라 산출물을 다시 검증한 결과다.');
    if (w.breakage) {
      for (const s of w.breakage) {
        lines.push(`  슬라이드 ${s.slide}: 도형 ${s.shapes}개 중 파손 ${s.broken.length}개`);
        for (const b of s.broken) {
          const over = Object.entries(b.overflowMm).map(([k, v]) => `${k} ${v}mm`).join(', ');
          lines.push(`    - ${b.shape} [${b.kind}] ${over || '여백 침범'} (x=${b.box.x} y=${b.box.y} cx=${b.box.cx} cy=${b.box.cy})`);
        }
      }
    }
  }

  if (report.suggest) {
    const s = report.suggest;
    lines.push('');
    lines.push(`SUGGEST (기준 fontSource=${s.basis})`);
    lines.push(`  out        : ${s.out}`);
    for (const c of s.changed) lines.push(`  page ${c.page} block ${c.block} (${c.type}): rows ${c.from} -> ${c.to}`);
    for (const t of s.blockTooTall) {
      lines.push(`  page ${t.page} block ${t.block} (${t.type}): BLOCK_TOO_TALL. rows 18 로도 안 들어간다 - 블록을 나눠라.`);
    }
    if (!s.changed.length && !s.blockTooTall.length) lines.push('  제안 없음(오버플로 0).');
    lines.push(`  원본 대비 차이: ${s.diffPaths.length ? s.diffPaths.join(', ') : '없음'}`);
  }

  const failed = report.counts.errors > 0 || (strict && report.counts.warnings > 0);
  lines.push('');
  lines.push(`VERDICT: ${failed ? 'FAIL' : 'PASS'} (errors ${report.counts.errors}, warnings ${report.counts.warnings}${strict ? ', --strict' : ''})`);
  return lines.join('\n');
}

const USAGE = [
  'usage: verify_a4p.mjs <file.pptx> [options]',
  '  --json                  기계 판독용 JSON',
  '  --strict                경고도 실패로 취급',
  '  --font-file <path>      폰트 후보 경로 (패밀리 대조 후에만 채택)',
  '  --deck <deck.json>      원본 deck JSON (여백 기준 + --suggest-deck 입력)',
  '  --repair                sldSz 만 A4 세로로 교체해 다시 압축',
  '  --convert-a4p           --repair + 슬라이드별 파손 리포트 (도형은 움직이지 않는다)',
  '  --out <path>            산출 파일 (--repair/--convert-a4p 기본값)',
  '  --in-place              입력 파일을 덮어쓴다 (명시적 옵트인)',
  '  --suggest-deck <path>   오버플로를 없애는 rows 를 제안해 새 deck JSON 으로 저장',
].join('\n');

export function parseArgs(argv) {
  const opts = {
    json: false, strict: false, fontFile: null, deckPath: null, file: null,
    repair: false, convert: false, out: null, inPlace: false, suggestDeck: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const valued = (name) => {
      if (a === `--${name}`) {
        const v = argv[++i];
        if (v === undefined) throw new VerifyError(`--${name} 에 값이 없다`, 'USAGE');
        return v;
      }
      if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
      return null;
    };
    if (a === '--json') opts.json = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--repair') opts.repair = true;
    else if (a === '--convert-a4p') opts.convert = true;
    else if (a === '--in-place') opts.inPlace = true;
    else if (a === '--font-file' || a.startsWith('--font-file=')) opts.fontFile = valued('font-file');
    else if (a === '--deck' || a.startsWith('--deck=')) opts.deckPath = valued('deck');
    else if (a === '--out' || a.startsWith('--out=')) opts.out = valued('out');
    else if (a === '--suggest-deck' || a.startsWith('--suggest-deck=')) opts.suggestDeck = valued('suggest-deck');
    else if (a.startsWith('-')) throw new VerifyError(`알 수 없는 옵션: ${a}`, 'USAGE');
    else if (opts.file === null) opts.file = a;
    else throw new VerifyError(`입력 파일이 둘 이상이다: ${opts.file}, ${a}`, 'USAGE');
  }
  return opts;
}

export function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`verify_a4p: ${err.message}`);
    console.error(USAGE);
    return EXIT.USAGE;
  }
  if (opts.help || !opts.file) {
    console.error(USAGE);
    return opts.help ? EXIT.PASS : EXIT.USAGE;
  }
  if (!fs.existsSync(opts.file)) {
    console.error(`verify_a4p: 입력 파일이 없다: ${opts.file}`);
    return EXIT.USAGE;
  }

  let deck = null;
  if (opts.deckPath) {
    try {
      deck = JSON.parse(fs.readFileSync(opts.deckPath, 'utf8'));
    } catch (err) {
      console.error(`verify_a4p: --deck 을 읽을 수 없다: ${opts.deckPath} (${err.message})`);
      return EXIT.USAGE;
    }
  }

  let report;
  try {
    report = verifyFile(opts.file, { fontFile: opts.fontFile, deck });
  } catch (err) {
    if (err instanceof VerifyError && (err.code === 'BAD_MARGIN' || err.code === 'BAD_INPUT')) {
      console.error(`verify_a4p: ${err.message}`);
      return EXIT.USAGE;
    }
    // A file that cannot be opened as a zip is a verdict about the artifact, not a crash.
    const code = err instanceof VerifyError ? err.code : 'READ_ERROR';
    const failed = finish({
      skill: 'vertical-pptx',
      file: path.resolve(opts.file),
      ok: false,
      slideSize: null,
      marginMm: MARGIN_MM.DEFAULT,
      marginSource: 'spec-floor',
      fontSource: 'estimate',
      widthBasis: 'lower-bound (커널링/줄바꿈 미반영)',
      fonts: [],
      counts: { slides: 0, shapes: 0, runs: 0, errors: 0, warnings: 0 },
      findings: [finding(code, err.message)],
    });
    console.log(opts.json ? JSON.stringify(failed, null, 2) : renderTable(failed, opts.strict));
    return EXIT.FAIL;
  }

  // ---- write paths ----
  const wantsWrite = opts.repair || opts.convert;
  let outReport = report;
  try {
    if (wantsWrite) {
      if (!opts.out && !opts.inPlace) {
        console.error('verify_a4p: --repair/--convert-a4p 는 --out <경로> 또는 --in-place 가 필요하다.');
        console.error('  (기본은 새 파일이다. 원본 덮어쓰기는 --in-place 로 명시해야 한다.)');
        return EXIT.USAGE;
      }
      const src = fs.readFileSync(opts.file);
      const rep = repairBuffer(src);
      const target = opts.inPlace ? opts.file : opts.out;

      const integrity = verifyZipIntegrity(rep.out, { source: src, untouched: rep.untouched });
      if (!integrity.ok) {
        console.error(`verify_a4p: 재압축 산출물이 자기 무결성 검사를 통과하지 못해 쓰지 않았다:\n  ${integrity.problems.join('\n  ')}`);
        return EXIT.FAIL;
      }
      // Stage then rename, so an interrupted --in-place cannot leave a half-written deck.
      const tmp = `${target}.a4p-tmp`;
      fs.writeFileSync(tmp, rep.out);
      fs.renameSync(tmp, target);

      report.write = {
        mode: opts.convert ? 'convert-a4p' : 'repair',
        out: path.resolve(target),
        inPlace: opts.inPlace,
        sldSzChanged: rep.changed,
        before: rep.before,
        after: rep.after,
        entries: integrity.entryCount,
        firstEntry: integrity.firstEntry,
        untouchedVerified: rep.untouched.length,
        integrity: 'ok',
      };
      if (opts.convert) report.write.breakage = breakageReport(rep.out, report.marginMm * EMU_PER_MM);
      // The verdict that matters after a write is the OUTPUT's, not the input's.
      outReport = verifyFile(target, { fontFile: opts.fontFile, deck });
      outReport.write = report.write;
    }

    if (opts.suggestDeck) {
      if (!deck) {
        console.error('verify_a4p: --suggest-deck 은 --deck <deck.json> 를 함께 요구한다.');
        console.error('  (pptx 는 (슬라이드, 도형)만 알려 준다. 내놓아야 하는 것은 (페이지, 블록)의 rows 다.)');
        return EXIT.USAGE;
      }
      const src = fs.readFileSync(wantsWrite && opts.inPlace ? opts.file : (report.write ? report.write.out : opts.file));
      const s = suggestDeck(deck, src, { fontFor: report.fontFor });
      fs.writeFileSync(opts.suggestDeck, `${JSON.stringify(s.deck, null, 2)}\n`);
      outReport.suggest = {
        out: path.resolve(opts.suggestDeck),
        changed: s.suggestions,
        blockTooTall: s.tooTall,
        diffPaths: jsonDiffPaths(deck, s.deck),
        basis: report.fontSource,
      };
    }
  } catch (err) {
    if (err instanceof VerifyError && ['NO_BUILDER', 'DECK_MISMATCH'].includes(err.code)) {
      console.error(`verify_a4p: ${err.message}`);
      return err.code === 'NO_BUILDER' ? EXIT.ENV : EXIT.USAGE;
    }
    console.error(`verify_a4p: ${err.message}`);
    return EXIT.FAIL;
  }

  const failed = outReport.counts.errors > 0 || (opts.strict && outReport.counts.warnings > 0);
  outReport.exit = failed ? EXIT.FAIL : EXIT.PASS;
  console.log(opts.json ? JSON.stringify(outReport, null, 2) : renderTable(outReport, opts.strict));
  return outReport.exit;
}

// fileURLToPath, not URL.pathname: the latter yields "/C:/..." on Windows and never matches argv[1].
const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`verify_a4p: ${err && err.stack ? err.stack : err}`);
    process.exit(EXIT.ENV);
  }
}
