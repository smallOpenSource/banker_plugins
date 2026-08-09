#!/usr/bin/env node
/*
 * vertical-pptx tests. Run: `node --test skills/vertical-pptx/a4p.test.mjs`
 *
 * TWO TIERS, and the difference is deliberate.
 *
 *   Tier 1 (standing).  U1..U16. node:test + node:assert + node stdlib, nothing else. CI installs
 *     neither pptxgenjs nor python-pptx, so anything that needs a builder cannot be a regression
 *     gate. Everything here calls layout()/mdToDeck() out of build_a4p.js and the verifier's
 *     exported functions directly, against fixtures this file builds byte by byte.
 *
 *   Tier 2 (skippable).  E1, E1b, I1..I4. Needs a real pptxgenjs and/or a python with python-pptx.
 *     When a builder is missing these SKIP and print why. When A4P_REQUIRE_BUILDERS=1 they FAIL
 *     instead, because "nobody ran it" and "it passed" must not look alike — that confusion is the
 *     entire premise of plan pre-mortem scenario 2. RELEASING.md sets that variable.
 *
 *     Builder discovery: pptxgenjs through build_a4p.js's own moduleSearchPaths() (so NODE_PATH
 *     works), python through $A4P_PYTHON, then $PYTHON, then python3 / python / python3.12, taking
 *     the first interpreter that can `import pptx` (PYTHONPATH is inherited).
 *
 * THE FIXTURE WRITER IS INDEPENDENT ON PURPOSE.
 *   verify_a4p.mjs exports writeZip() and crc32(). Neither is used to build a fixture here. If the
 *   production writer built the inputs that the production reader then read back, the zip layer
 *   would be proving itself and a shared bug would be invisible. So this file carries its own
 *   CRC32 table, its own local-header/central-directory/EOCD layout, and its own reader for the
 *   U15 cross-check. Same for the fonts: U6 runs against synthetic TTF/TTC bytes assembled here,
 *   with an advance table chosen so every expected width is exact rather than approximately right.
 *
 * No file is ever written inside the repo: everything transient lands in one mkdtemp under
 * os.tmpdir() and is removed in after().
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import * as V from './verify_a4p.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const B = require('./build_a4p.js');

const BUILD_JS = path.join(HERE, 'build_a4p.js');
const BUILD_PY = path.join(HERE, 'build_a4p.py');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-test-'));
const tmp = (name) => path.join(TMP, name);

// A python run can leave a __pycache__ beside the script it imported from. build_a4p.py imports
// nothing local so this should stay empty, but the repo has to come out of a test run unchanged.
// Only a directory this run created is removed; one that was already there is left alone.
const PYCACHE = path.join(HERE, '__pycache__');
const PYCACHE_PREEXISTING = fs.existsSync(PYCACHE);

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  if (!PYCACHE_PREEXISTING) fs.rmSync(PYCACHE, { recursive: true, force: true });
});

// ===========================================================================
// INDEPENDENT ZIP WRITER  (never verify_a4p.mjs's writeZip)
// ===========================================================================

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32/ISO-HDLC, written out here so the fixtures never borrow the implementation under test. */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

const LOC_SIG = 0x04034b50;
const CEN_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/**
 * Assemble a zip. Entries default to method 8 (deflateRawSync) because that is the path a real
 * pptx takes; `store: true` opts one entry into method 0 so the reader's stored branch and the
 * repair path's pass-through both get exercised by something real.
 */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.store ? 0 : 8;
    const body = method === 0 ? data : zlib.deflateRawSync(data);
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOC_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); // no data descriptor: sizes are known here
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN_SIG, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x0021, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);

    offset += 30 + name.length + body.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

/**
 * Independent reader, used only by U15. Walks the central directory, then walks each LOCAL header
 * separately, so a disagreement between the two is visible. Both verify_a4p.mjs and the python
 * zipfile oracle are central-directory based, which makes the local header the one structural
 * blind spot they share — and the one streaming unzippers read first.
 */
function readZipRaw(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'EOCD record not found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), CEN_SIG, `central directory signature at entry ${i}`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    const localSig = buf.readUInt32LE(localOffset);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localName = buf.toString('utf8', localOffset + 30, localOffset + 30 + localNameLen);
    const dataAt = localOffset + 30 + localNameLen + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(dataAt, dataAt + csize);
    const isDir = name.endsWith('/');
    const data = isDir ? Buffer.alloc(0) : (method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));

    out.push({ name, method, crc, csize, usize, localOffset, localSig, localName, data, isDir });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ===========================================================================
// PPTX FIXTURES
// ===========================================================================

const NSDECL = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
  + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  + ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
  + '</Types>';

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
  + '</Relationships>';

const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** ppt/presentation.xml with a parameterized p:sldSz. `type: null` omits the attribute entirely. */
function presentationXml({ cx = V.A4P.cx, cy = V.A4P.cy, type = null } = {}) {
  const t = type === null ? '' : ` type="${type}"`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<p:presentation ${NSDECL}>`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + `<p:sldSz cx="${cx}" cy="${cy}"${t}/>`
    // notesSz sits right next to sldSz in every real deck and carries the same attribute names.
    // Leaving it here keeps the element-scoped reader honest about which cx it picked up.
    + `<p:notesSz cx="6858000" cy="9144000"/>`
    + '</p:presentation>';
}

function slotXml({ latin, ea, cs }) {
  return [
    latin === null ? '' : `<a:latin typeface="${escXml(latin)}"/>`,
    ea === null ? '' : `<a:ea typeface="${escXml(ea)}"/>`,
    cs === null ? '' : `<a:cs typeface="${escXml(cs)}"/>`,
  ].join('');
}

/**
 * One slide. The p:grpSpPr below carries a 0,0,0,0 xfrm that is NOT a shape; it is here so every
 * fixture exercises the "direct children of spTree only" rule instead of assuming it.
 */
function slideXml(shapes) {
  const sp = shapes.map((s, i) => {
    const face = s.font === undefined ? 'Noto Sans CJK KR' : s.font;
    const slots = slotXml({
      latin: s.latin !== undefined ? s.latin : face,
      ea: s.ea !== undefined ? s.ea : face,
      cs: s.cs !== undefined ? s.cs : face,
    });
    const run = s.text === undefined ? '' : `<a:r><a:rPr lang="ko-KR" sz="${Math.round((s.pt ?? 10.5) * 100)}" dirty="0">${slots}</a:rPr><a:t>${escXml(s.text)}</a:t></a:r>`;
    return `<p:sp><p:nvSpPr><p:cNvPr id="${i + 2}" name="${escXml(s.name || `Text ${i}`)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
      + `<p:spPr><a:xfrm><a:off x="${s.x}" y="${s.y}"/><a:ext cx="${s.cx}" cy="${s.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
      + `<p:txBody><a:bodyPr wrap="${s.wrap || 'square'}" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="t"/><a:lstStyle/>`
      + `<a:p><a:pPr algn="l" marL="0" indent="0"/>${run}</a:p></p:txBody></p:sp>`;
  }).join('');

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<p:sld ${NSDECL}><p:cSld><p:spTree>`
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    + sp
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

/** A whole package. `order` lets a fixture put [Content_Types].xml in the wrong place on purpose. */
function makePptx({ size = {}, slides = [], order = null } = {}) {
  const entries = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS, store: true },
    { name: 'ppt/presentation.xml', data: presentationXml(size) },
    ...slides.map((shapes, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, data: slideXml(shapes) })),
  ];
  if (!order) return makeZip(entries);
  return makeZip(order.map((name) => entries.find((e) => e.name === name)));
}

const FIT_SHAPE = { x: 360000, y: 360000, cx: 6840000, cy: 361800, text: '한 줄', name: 'Text 0' };

const FIXTURES = {
  good: makePptx({ slides: [[FIT_SHAPE]] }),
  goodCustom: makePptx({ size: { type: 'custom' }, slides: [[FIT_SHAPE]] }),
  presetTrap: makePptx({ size: { cx: V.PRESET_TRAP.cx, cy: V.PRESET_TRAP.cy } }),
  screen4x3: makePptx({ size: { type: 'screen4x3' } }),
  typeA4: makePptx({ size: { type: 'A4' } }),
  screen16x9: makePptx({ size: { cx: 12192000, cy: 6858000, type: 'screen16x9' } }),
  square: makePptx({ size: { cx: 7560000, cy: 7560000 } }),
  noPresentation: makeZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES }, { name: '_rels/.rels', data: ROOT_RELS }]),
};

const fixtureFile = (name, buf) => {
  const p = tmp(`${name}.pptx`);
  fs.writeFileSync(p, buf);
  return p;
};

const codesOf = (findings) => findings.map((f) => f.code);
const errorCodes = (report) => report.findings.filter((f) => f.severity === 'error').map((f) => f.code);

/** V.main() talks through console; keep the runner's output readable and return what it returned. */
function quiet(fn) {
  const log = console.log;
  const err = console.error;
  const out = [];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    return { value: fn(), out: out.join('\n') };
  } finally {
    console.log = log;
    console.error = err;
  }
}

// ===========================================================================
// SYNTHETIC FONTS  (TTF / TTC assembled here, so every advance is a known number)
// ===========================================================================

function nameTable(records) {
  const strings = records.map((r) => Buffer.from(r.value, 'utf16le').swap16());
  const head = Buffer.alloc(6 + records.length * 12);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(records.length, 2);
  head.writeUInt16BE(6 + records.length * 12, 4);
  let at = 0;
  records.forEach((r, i) => {
    const rec = 6 + i * 12;
    head.writeUInt16BE(3, rec); // Windows
    head.writeUInt16BE(1, rec + 2); // Unicode BMP
    head.writeUInt16BE(0x0409, rec + 4);
    head.writeUInt16BE(r.nameID, rec + 6);
    head.writeUInt16BE(strings[i].length, rec + 8);
    head.writeUInt16BE(at, rec + 10);
    at += strings[i].length;
  });
  return Buffer.concat([head, ...strings]);
}

/** cmap format 4. The 0xFFFF terminator segment is mandatory and every real reader relies on it. */
function cmapFormat4(segments) {
  const segs = [...segments, { start: 0xffff, end: 0xffff, delta: 1 }];
  const n = segs.length;
  const segX2 = n * 2;
  const len = 16 + segX2 * 4;
  const b = Buffer.alloc(len);
  const es = Math.floor(Math.log2(n));
  b.writeUInt16BE(4, 0);
  b.writeUInt16BE(len, 2);
  b.writeUInt16BE(0, 4);
  b.writeUInt16BE(segX2, 6);
  b.writeUInt16BE(2 * 2 ** es, 8);
  b.writeUInt16BE(es, 10);
  b.writeUInt16BE(segX2 - 2 * 2 ** es, 12);
  segs.forEach((s, i) => {
    b.writeUInt16BE(s.end, 14 + i * 2);
    b.writeUInt16BE(s.start, 16 + segX2 + i * 2);
    // idDelta is applied mod 65536, so it is stored as the low 16 bits however large it really is.
    b.writeUInt16BE(s.delta & 0xffff, 16 + segX2 * 2 + i * 2);
    b.writeUInt16BE(0, 16 + segX2 * 3 + i * 2);
  });
  return b;
}

/** cmap format 12, the UCS-4 subtable CJK fonts actually ship. */
function cmapFormat12(groups) {
  const b = Buffer.alloc(16 + groups.length * 12);
  b.writeUInt16BE(12, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt32BE(b.length, 4);
  b.writeUInt32BE(0, 8);
  b.writeUInt32BE(groups.length, 12);
  groups.forEach((g, i) => {
    const at = 16 + i * 12;
    b.writeUInt32BE(g.start, at);
    b.writeUInt32BE(g.end, at + 4);
    b.writeUInt32BE(g.startGid, at + 8);
  });
  return b;
}

function cmapTable(subs) {
  const head = Buffer.alloc(4 + subs.length * 8);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(subs.length, 2);
  let at = 4 + subs.length * 8;
  subs.forEach((s, i) => {
    const rec = 4 + i * 8;
    head.writeUInt16BE(s.platformID, rec);
    head.writeUInt16BE(s.encodingID, rec + 2);
    head.writeUInt32BE(at, rec + 4);
    at += s.data.length;
  });
  return Buffer.concat([head, ...subs.map((s) => s.data)]);
}

/**
 * One sfnt face. `baseOffset` is where this face's table directory will sit in the final file,
 * which is what makes a ttcf possible: table offsets are absolute, never face-relative.
 */
function buildSfnt(spec, baseOffset = 0) {
  const { unitsPerEm, numGlyphs, advances, subs, family, fullName } = spec;

  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt32BE(0x5f0f3cf5, 12); // magic
  head.writeUInt16BE(3, 16);
  head.writeUInt16BE(unitsPerEm, 18);
  head.writeUInt16BE(spec.macStyle || 0, 44);
  head.writeUInt16BE(8, 46);
  head.writeInt16BE(2, 48);

  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(spec.ascender, 4);
  hhea.writeInt16BE(spec.descender, 6);
  hhea.writeInt16BE(spec.lineGap || 0, 8);
  hhea.writeUInt16BE(advances.length, 34); // numberOfHMetrics

  const maxp = Buffer.alloc(6);
  maxp.writeUInt32BE(0x00005000, 0);
  maxp.writeUInt16BE(numGlyphs, 4);

  const hmtx = Buffer.alloc(advances.length * 4 + Math.max(0, numGlyphs - advances.length) * 2);
  advances.forEach((a, i) => {
    hmtx.writeUInt16BE(a, i * 4);
    hmtx.writeInt16BE(0, i * 4 + 2);
  });

  const tables = new Map([
    ['cmap', cmapTable(subs)],
    ['head', head],
    ['hhea', hhea],
    ['hmtx', hmtx],
    ['maxp', maxp],
    ['name', nameTable([{ nameID: 1, value: family }, { nameID: 4, value: fullName || family }])],
  ]);

  const tags = [...tables.keys()].sort();
  const dir = Buffer.alloc(12 + tags.length * 16);
  const es = Math.floor(Math.log2(tags.length));
  dir.writeUInt32BE(0x00010000, 0);
  dir.writeUInt16BE(tags.length, 4);
  dir.writeUInt16BE(16 * 2 ** es, 6);
  dir.writeUInt16BE(es, 8);
  dir.writeUInt16BE(tags.length * 16 - 16 * 2 ** es, 10);

  const bodies = [];
  let at = baseOffset + dir.length;
  tags.forEach((tag, i) => {
    const data = tables.get(tag);
    const rec = 12 + i * 16;
    dir.write(tag.padEnd(4), rec, 4, 'latin1');
    dir.writeUInt32BE(0, rec + 4); // checksum: never dereferenced by the reader
    dir.writeUInt32BE(at, rec + 8);
    dir.writeUInt32BE(data.length, rec + 12);
    bodies.push(data);
    at += data.length;
    const pad = (4 - (data.length % 4)) % 4;
    if (pad) {
      bodies.push(Buffer.alloc(pad));
      at += pad;
    }
  });
  return Buffer.concat([dir, ...bodies]);
}

function buildTtc(specs) {
  const headerLen = 12 + specs.length * 4;
  const lengths = specs.map((s) => buildSfnt(s, 0).length); // length does not depend on baseOffset
  const offsets = [];
  let at = headerLen;
  for (const len of lengths) {
    offsets.push(at);
    at += len;
  }
  const head = Buffer.alloc(headerLen);
  head.write('ttcf', 0, 4, 'latin1');
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt32BE(specs.length, 8);
  offsets.forEach((o, i) => head.writeUInt32BE(o, 12 + i * 4));
  return Buffer.concat([head, ...specs.map((s, i) => buildSfnt(s, offsets[i]))]);
}

/*
 * The reference face. unitsPerEm 2048 (the Latin norm) with numberOfHMetrics 3 < numGlyphs 5, so
 * the last advance has to be reused for gid 3 and 4 — the boundary that silently mis-measures
 * every CJK deck when a reader gets it wrong. cmap maps A B C D to gid 1 2 3 4.
 *
 *   A -> gid 1 -> 1024/2048 = 0.5  em
 *   B -> gid 2 -> 2048/2048 = 1.0  em
 *   C -> gid 3 -> past numberOfHMetrics, reuses gid 2's 2048 -> 1.0 em
 *   D -> gid 4 -> same                                       -> 1.0 em
 *   Z -> unmapped -> gid 0 (.notdef) -> 512/2048 = 0.25 em, missing
 */
const FACE_2048 = {
  family: 'ZzQuux Test Face',
  fullName: 'ZzQuux Test Face Regular',
  unitsPerEm: 2048,
  numGlyphs: 5,
  advances: [512, 1024, 2048],
  ascender: 1638,
  descender: -410,
  lineGap: 0, // (1638 + 410 + 0) / 2048 = 1.0 em exactly
  subs: [{ platformID: 3, encodingID: 1, data: cmapFormat4([{ start: 0x41, end: 0x44, delta: 1 - 0x41 }]) }],
};

/* unitsPerEm 1000 with the Hangul advance the plan measured on Noto Sans CJK KR: 920/1000 = 0.92 em. */
const FACE_1000 = {
  family: 'ZzQuux Hangul Face',
  unitsPerEm: 1000,
  numGlyphs: 3,
  advances: [250, 920],
  ascender: 880,
  descender: -120,
  lineGap: 0,
  subs: [{ platformID: 3, encodingID: 1, data: cmapFormat4([{ start: 0xac00, end: 0xac00, delta: 1 - 0xac00 }]) }],
};

/*
 * Both cmap subtables present and DISAGREEING on 'A': format 4 says gid 1 (0.5 em), format 12 says
 * gid 2 (1.0 em). A reader that stops at format 4 hands back .notdef-grade widths for exactly the
 * text this skill exists to lay out, so the preference order (3,10) > (3,1) has to be observable.
 */
const FACE_BOTH_CMAPS = {
  ...FACE_2048,
  family: 'ZzQuux Dual Cmap',
  fullName: 'ZzQuux Dual Cmap Regular',
  subs: [
    { platformID: 3, encodingID: 1, data: cmapFormat4([{ start: 0x41, end: 0x41, delta: 1 - 0x41 }]) },
    { platformID: 3, encodingID: 10, data: cmapFormat12([{ start: 0x41, end: 0x41, startGid: 2 }]) },
  ],
};

const TTF_PATH = tmp('ZzQuuxTestFace-Regular.ttf');
const TTF_1000_PATH = tmp('ZzQuuxHangulFace-Regular.ttf');
const TTF_DUAL_PATH = tmp('ZzQuuxDualCmap-Regular.ttf');
const TTC_PATH = tmp('ZzQuuxCollection.ttc');
fs.writeFileSync(TTF_PATH, buildSfnt(FACE_2048));
fs.writeFileSync(TTF_1000_PATH, buildSfnt(FACE_1000));
fs.writeFileSync(TTF_DUAL_PATH, buildSfnt(FACE_BOTH_CMAPS));
fs.writeFileSync(TTC_PATH, buildTtc([FACE_2048, { ...FACE_1000, family: 'ZzQuux Second Face' }]));

// ===========================================================================
// U1 — mm -> EMU and the grid, parameterized on meta.marginMm
// ===========================================================================

test('U1 grid constants are a function of meta.marginMm, and 8 cols x 20 rows reconstruct the content box', () => {
  assert.equal(B.SLIDE_W, 210 * 36000);
  assert.equal(B.SLIDE_H, 297 * 36000);
  assert.equal(B.SLIDE_W, 7560000);
  assert.equal(B.SLIDE_H, 10692000);
  assert.equal(B.GUTTER, 144000);
  assert.equal(B.COLS, 8);
  assert.equal(B.ROWS, 20);

  const g10 = B.gridFor(10);
  assert.deepEqual(
    { colW: g10.colW, rowH: g10.rowH, colPitch: g10.colPitch, rowPitch: g10.rowPitch },
    { colW: 729000, rowH: 361800, colPitch: 873000, rowPitch: 505800 },
  );
  assert.equal(g10.margin, 360000);
  assert.equal(g10.contentW, 6840000);
  assert.equal(g10.contentH, 9972000);

  const g15 = B.gridFor(15);
  assert.equal(g15.colW, (182 - 30) * 4500);
  assert.equal(g15.colW, 684000);
  assert.equal(g15.rowH, (221 - 30) * 1800);
  assert.equal(g15.rowH, 343800);

  // k = 8 and n = 20 have to land exactly on the content box, or the grid is not a partition of it.
  for (const g of [g10, g15, B.gridFor(40)]) {
    assert.equal(g.colW * g.cols + g.gutter * (g.cols - 1), g.contentW, `k=8 check at m=${g.marginMm}`);
    assert.equal(g.rowH * g.rows + g.gutter * (g.rows - 1), g.contentH, `n=20 check at m=${g.marginMm}`);
    assert.equal(g.margin * 2 + g.contentW, B.SLIDE_W);
    assert.equal(g.margin * 2 + g.contentH, B.SLIDE_H);
    assert.ok(Number.isInteger(g.colW) && Number.isInteger(g.rowH), 'EMU must stay integral');
  }
});

// ===========================================================================
// U2 — the preset trap constant
// ===========================================================================

test('U2 the 10.833x7.5in "A4 paper" preset gets its own verdict, PRESET_TRAP', () => {
  assert.deepEqual({ ...V.PRESET_TRAP }, { cx: 9906000, cy: 6858000 });
  assert.deepEqual({ ...V.A4P }, { cx: 7560000, cy: 10692000 });

  const codes = codesOf(V.checkSlideSize({ cx: 9906000, cy: 6858000, type: null }));
  assert.ok(codes.includes('PRESET_TRAP'), `expected PRESET_TRAP, got ${codes.join(',')}`);
  // Named after A4 and not A4: it must also fail the plain dimension check.
  assert.ok(codes.includes('NOT_A4_PORTRAIT'));

  // One EMU off the preset is no longer the preset, and the trap verdict must not fire loosely.
  assert.ok(!codesOf(V.checkSlideSize({ cx: 9906001, cy: 6858000, type: null })).includes('PRESET_TRAP'));
  assert.ok(!codesOf(V.checkSlideSize({ cx: V.A4P.cx, cy: V.A4P.cy, type: null })).includes('PRESET_TRAP'));
});

// ===========================================================================
// U3 — p:sldSz@type truth table
// ===========================================================================

test('U3 sldSz type truth table: absent PASS, custom PASS, screen4x3 / A4 / screen16x9 FAIL', () => {
  const verdict = (type) => codesOf(V.checkSlideSize({ cx: V.A4P.cx, cy: V.A4P.cy, type })).includes('PRESET_TYPE_ATTR');

  assert.equal(verdict(null), false, 'absent type is PASS (OOXML defaults it to custom; pptxgenjs emits none)');
  assert.equal(verdict('custom'), false);
  assert.equal(verdict('screen4x3'), true);
  assert.equal(verdict('A4'), true);
  assert.equal(verdict('screen16x9'), true);

  // And through the whole pipeline, on real package bytes rather than a hand-made object.
  assert.deepEqual(errorCodes(V.verifyBuffer(FIXTURES.good)), []);
  assert.deepEqual(errorCodes(V.verifyBuffer(FIXTURES.goodCustom)), []);
  assert.deepEqual(errorCodes(V.verifyBuffer(FIXTURES.screen4x3)), ['PRESET_TYPE_ATTR']);
  assert.deepEqual(errorCodes(V.verifyBuffer(FIXTURES.typeA4)), ['PRESET_TYPE_ATTR']);

  // The dimensions are right in the screen4x3 fixture; only the declaration lies.
  const r = V.verifyBuffer(FIXTURES.screen4x3);
  assert.equal(r.slideSize.cx, V.A4P.cx);
  assert.equal(r.slideSize.cy, V.A4P.cy);
  assert.equal(r.slideSize.type, 'screen4x3');
  assert.equal(V.verifyBuffer(FIXTURES.good).slideSize.type, null);
});

// ===========================================================================
// U4 — orientation
// ===========================================================================

test('U4 orientation: cy>cx portrait, cx>cy landscape, equal is a failure', () => {
  assert.equal(V.orientationOf(7560000, 10692000), 'portrait');
  assert.equal(V.orientationOf(12192000, 6858000), 'landscape');
  assert.equal(V.orientationOf(V.PRESET_TRAP.cx, V.PRESET_TRAP.cy), 'landscape');
  assert.equal(V.orientationOf(7560000, 7560000), 'square');

  assert.ok(codesOf(V.checkSlideSize({ cx: 7560000, cy: 7560000, type: null })).includes('MIXED_ORIENTATION'));
  assert.ok(!codesOf(V.checkSlideSize({ cx: V.A4P.cx, cy: V.A4P.cy, type: null })).includes('MIXED_ORIENTATION'));

  assert.equal(V.verifyBuffer(FIXTURES.good).slideSize.orientation, 'portrait');
  assert.equal(V.verifyBuffer(FIXTURES.screen16x9).slideSize.orientation, 'landscape');
  assert.ok(errorCodes(V.verifyBuffer(FIXTURES.square)).includes('MIXED_ORIENTATION'));
});

// ===========================================================================
// U5 — font chain selection and the three Korean slots
// ===========================================================================

/** Where a per-user font drop would live on this platform, so the chain can be given a real file. */
function userFontDir(home) {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Fonts');
  if (process.platform === 'win32') return path.join(home, 'Microsoft', 'Windows', 'Fonts');
  return path.join(home, '.fonts');
}

test('U5 the font chain reports a name it actually resolved, with an absolute path', () => {
  const home = tmp('fonthome');
  const dir = userFontDir(home);
  fs.mkdirSync(dir, { recursive: true });
  // Basename normalizes to "zzquuxtestfaceregular", which contains the requested name's key, and
  // "regular" wins the weight ranking. Nothing on any real system answers to this family.
  fs.copyFileSync(TTF_PATH, path.join(dir, 'ZzQuuxTestFace-Regular.ttf'));

  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, BANKER_PPTX_FONT: process.env.BANKER_PPTX_FONT };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LOCALAPPDATA = home;
  delete process.env.BANKER_PPTX_FONT;
  try {
    const hit = B.resolveFont({ fontArg: 'ZzQuux Test Face', metaFont: 'auto' });
    assert.equal(hit.name, 'ZzQuux Test Face');
    assert.equal(hit.from, '--font');
    assert.ok(path.isAbsolute(hit.file), `fontFile must be absolute, got ${hit.file}`);
    assert.equal(fs.realpathSync(hit.file), fs.realpathSync(path.join(dir, 'ZzQuuxTestFace-Regular.ttf')));
    assert.deepEqual(hit.warnings, []);

    // Explicit sources are consulted in order, and an unresolvable one warns instead of being
    // swapped silently. Silent substitution is what puts a name in the file that no machine has.
    process.env.BANKER_PPTX_FONT = 'ZzQuux Test Face';
    const chained = B.resolveFont({ fontArg: 'ZzQuux Absent Family', metaFont: 'auto' });
    assert.equal(chained.name, 'ZzQuux Test Face');
    assert.equal(chained.from, 'BANKER_PPTX_FONT');
    assert.deepEqual(chained.warnings.map((w) => [w.code, w.from]), [['FONT_NOT_FOUND', '--font']]);

    // meta.font === 'auto' means "no opinion" and must not be looked up as a family name.
    delete process.env.BANKER_PPTX_FONT;
    const auto = B.resolveFont({ fontArg: '', metaFont: 'auto' });
    assert.ok(!auto.warnings.some((w) => w.from === 'meta.font'));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('U5 the three Korean slots must carry one typeface, and a split is reported', () => {
  const one = V.verifyBuffer(makePptx({ slides: [[{ ...FIT_SHAPE, font: 'Noto Sans CJK KR' }]] }));
  assert.deepEqual(codesOf(one.findings).filter((c) => c.startsWith('FONT_SLOT')), []);

  const split = V.verifyBuffer(makePptx({ slides: [[{ ...FIT_SHAPE, latin: 'Arial', ea: 'Noto Sans CJK KR', cs: 'Arial' }]] }));
  assert.ok(codesOf(split.findings).includes('FONT_SLOT_MISMATCH'));

  // a:ea missing is the tofu case the repo already recorded for arch-diagram.
  const missing = V.verifyBuffer(makePptx({ slides: [[{ ...FIT_SHAPE, ea: null }]] }));
  assert.ok(codesOf(missing.findings).includes('FONT_SLOT_MISSING'));

  // Reported, not failed: a theme may still fill the slot in. Errors stay at zero.
  assert.deepEqual(errorCodes(split), []);
  assert.deepEqual(errorCodes(missing), []);
});

// ===========================================================================
// U6 — width prediction against a known advance table
// ===========================================================================

test('U6 the font reader returns the advances it was given, across the numberOfHMetrics boundary', () => {
  const face = V.loadFace(fs.readFileSync(TTF_PATH), 0);
  assert.equal(face.unitsPerEm, 2048);
  assert.equal(face.numGlyphs, 5);
  assert.equal(face.numberOfHMetrics, 3);
  assert.equal(face.family, 'ZzQuux Test Face');
  assert.equal(face.lineHeightEm, 1);

  const em = (ch) => face.advanceEm(ch.codePointAt(0));
  assert.deepEqual(em('A'), { em: 0.5, missing: false }, 'gid 1, upm 2048 scaling');
  assert.deepEqual(em('B'), { em: 1, missing: false }, 'gid 2, the last real metric');
  assert.deepEqual(em('C'), { em: 1, missing: false }, 'gid 3 is past numberOfHMetrics and reuses it');
  assert.deepEqual(em('D'), { em: 1, missing: false }, 'gid 4, same reuse');
  assert.deepEqual(em('Z'), { em: 0.25, missing: true }, 'unmapped -> .notdef, and it says so');

  // A different unitsPerEm scales, it does not shift: 920/1000 is the Hangul advance the plan measured.
  const hangul = V.loadFace(fs.readFileSync(TTF_1000_PATH), 0);
  assert.equal(hangul.unitsPerEm, 1000);
  assert.deepEqual(hangul.advanceEm(0xac00), { em: 0.92, missing: false });

  // (3,10)/format 12 must beat (3,1)/format 4 when a font ships both and they disagree.
  const dual = V.loadFace(fs.readFileSync(TTF_DUAL_PATH), 0);
  assert.deepEqual(dual.advanceEm(0x41), { em: 1, missing: false }, 'format 12 subtable wins');
});

test('U6 runWidthEmu sums the advance table, and falls back to estimate only without a font', () => {
  const face = V.loadFace(fs.readFileSync(TTF_PATH), 0);

  // 'A' 0.5 + 'B' 1.0 + 'C' 1.0 = 2.5 em at 10pt = 2.5 * 10 * 12700 EMU.
  assert.deepEqual(V.runWidthEmu('ABC', 10, face), { emu: 2.5 * 10 * V.EMU_PER_PT, em: 2.5, missing: 0 });
  assert.equal(V.runWidthEmu('ABC', 10, face).emu, 317500);
  assert.equal(V.runWidthEmu('ABC', 20, face).emu, 635000, 'width is linear in pt');
  assert.equal(V.runWidthEmu('', 10, face).emu, 0);

  // Line breaks are not advances.
  assert.deepEqual(V.runWidthEmu('A\nB\r', 10, face).em, 1.5);

  // Missing glyphs are counted, which is what lets a finding drop its confidence.
  assert.equal(V.runWidthEmu('ZZ', 10, face).missing, 2);

  // No font at all: the crude class fallback. Its error runs +2.5%..+96% on real corpora, which is
  // exactly why anything computed from it is labelled unconfirmed downstream.
  assert.equal(V.runWidthEmu('AB', 10, null).em, 1.0, 'two narrow chars at 0.5 em');
  assert.equal(V.runWidthEmu('가나', 10, null).em, 2.0, 'wide chars at 1.0 em');
  assert.equal(V.runWidthEmu(' ', 10, null).em, 0.25);
});

test('U6 a font file is verified against the run typeface, never trusted', () => {
  assert.ok(V.openFontFile(TTF_PATH, 'ZzQuux Test Face'), 'the family that is really in the file');
  assert.equal(V.openFontFile(TTF_PATH, 'Malgun Gothic'), null, 'a path that exists but holds another font');
  assert.equal(V.openFontFile(tmp('does-not-exist.ttf'), 'ZzQuux Test Face'), null);

  // Truncation degrades; it never throws. --font-file is arbitrary user input.
  const truncated = tmp('truncated.ttf');
  fs.writeFileSync(truncated, fs.readFileSync(TTF_PATH).subarray(0, 40));
  assert.equal(V.openFontFile(truncated, 'ZzQuux Test Face'), null);
  const garbage = tmp('garbage.ttf');
  fs.writeFileSync(garbage, Buffer.alloc(4096, 0x7f));
  assert.equal(V.openFontFile(garbage, 'ZzQuux Test Face'), null);

  // A collection is indexed by NAME, never by a hardcoded face number.
  const first = V.openFontFile(TTC_PATH, 'ZzQuux Test Face');
  const second = V.openFontFile(TTC_PATH, 'ZzQuux Second Face');
  assert.equal(first.faceCount, 2);
  assert.equal(first.faceIndex, 0);
  assert.equal(second.faceIndex, 1);
  assert.equal(second.unitsPerEm, 1000);
  assert.equal(V.openFontFile(TTC_PATH, 'ZzQuux Absent Face'), null);

  assert.ok(V.faceMatches({ 1: 'ZzQuux Test Face' }, 'zzquux test face'), 'case and spacing are noise');
  assert.ok(V.faceMatches({ 1: 'Noto Sans CJK KR Regular' }, 'Noto Sans CJK KR'), 'a style suffix is still the family');
  assert.ok(!V.faceMatches({ 1: 'Noto Sans Mono CJK KR' }, 'Noto Sans CJK KR'), 'more family words are a different family');
});

test('U6 the default width label is estimate, and only a resolved font can lift it', () => {
  // Nothing on any machine answers to this typeface, so nothing can be measured.
  const r = V.verifyBuffer(makePptx({ slides: [[{ ...FIT_SHAPE, font: 'ZzQuux Nonexistent Family' }]] }));
  assert.equal(r.fontSource, 'estimate');
  assert.deepEqual(r.fonts.map((f) => f.source), ['estimate']);

  // An overflow that rests on an estimate is a warning that says so, never an assertion.
  const over = V.verifyBuffer(makePptx({
    slides: [[{ ...FIT_SHAPE, cy: 36000, text: '가'.repeat(4000), font: 'ZzQuux Nonexistent Family' }]],
  }));
  const fit = over.findings.filter((f) => f.code.startsWith('TEXT_OVERFLOW'));
  assert.ok(fit.length, 'a 4000-character line in a 1mm box has to be reported');
  for (const f of fit) {
    assert.equal(f.status, 'unconfirmed');
    assert.equal(f.severity, 'warn');
    assert.match(f.detail, /확인 불가\(estimate\)/);
  }
  assert.deepEqual(errorCodes(over), [], 'an unmeasured overflow must not fail the deck');
});

// ===========================================================================
// U7 — markdown mapping
// ===========================================================================

test('U7 markdown maps h1 to a page, h2 to head, bullets to bullets, a paragraph to body', () => {
  const { deck, warnings } = B.mdToDeck([
    '# 첫 장',
    '',
    '## 소제목',
    '',
    '본문 한 문단이다.',
    '이어지는 줄은 같은 문단이다.',
    '',
    '- 항목 하나',
    '- 항목 둘',
    '',
    '# 둘째 장',
    '',
    '문단만 있는 장.',
  ].join('\n'));

  assert.equal(deck.pages.length, 2);
  assert.equal(deck.pages[0].title, '첫 장');
  assert.equal(deck.pages[1].title, '둘째 장');
  assert.deepEqual(deck.pages[0].blocks.map((b) => b.type), ['head', 'body', 'bullets']);
  assert.equal(deck.pages[0].blocks[0].text, '소제목');
  assert.equal(deck.pages[0].blocks[1].text, '본문 한 문단이다. 이어지는 줄은 같은 문단이다.');
  assert.deepEqual(deck.pages[0].blocks[2].items, ['항목 하나', '항목 둘']);
  assert.deepEqual(deck.pages[1].blocks.map((b) => b.type), ['body']);
  assert.deepEqual(warnings, []);

  // The converter never computes rows. Character counts are a crude measurement made without a
  // font or a width, which is how you get a wrong answer that looks precise.
  for (const page of deck.pages) {
    for (const block of page.blocks) {
      assert.equal(Object.prototype.hasOwnProperty.call(block, 'rows'), false, `${block.type} carries rows`);
    }
  }
  assert.equal(deck.meta.marginMm, B.DEFAULT_MARGIN_MM);
  B.layout(deck); // the emitted deck must satisfy the schema it claims to target
});

test('U7 h3 and deeper are demoted to body with exactly one warning each', () => {
  const one = B.mdToDeck('# 장\n\n### 셋째 단계\n\n본문.\n');
  assert.deepEqual(one.deck.pages[0].blocks.map((b) => b.type), ['body', 'body']);
  assert.equal(one.deck.pages[0].blocks[0].text, '셋째 단계');
  assert.equal(one.warnings.length, 1, 'exactly one warning');
  assert.equal(one.warnings[0].code, 'HEADING_DEMOTED');
  assert.equal(one.warnings[0].detail, 'h3 -> body');
  assert.equal(one.warnings[0].line, 3);

  const many = B.mdToDeck('# 장\n\n### 셋\n\n#### 넷\n\n##### 다섯\n');
  assert.deepEqual(many.warnings.map((w) => w.detail), ['h3 -> body', 'h4 -> body', 'h5 -> body']);

  // h2 is not a demotion and must not warn.
  assert.deepEqual(B.mdToDeck('# 장\n\n## 둘\n').warnings, []);
});

// ===========================================================================
// U8 — the margin check
// ===========================================================================

test('U8 margin: 9.9mm FAILs, 10.0mm PASSes, 10.1mm PASSes', () => {
  const ctx = { slideCx: V.A4P.cx, slideCy: V.A4P.cy, marginEmu: 10 * V.EMU_PER_MM, slide: 1 };
  const at = (mm) => {
    const x = Math.round(mm * V.EMU_PER_MM);
    return codesOf(V.checkShapeBounds({ x, y: x, cx: 1000000, cy: 1000000, label: 'S' }, ctx));
  };

  assert.deepEqual(at(9.9), ['MARGIN_VIOLATION'], '9.9mm is inside the 10mm floor');
  assert.deepEqual(at(10.0), [], '10.0mm sits exactly on the floor and passes');
  assert.deepEqual(at(10.1), [], '10.1mm is wider than the floor and passes');

  // The overshoot is reported, not just the fact of it: 10mm - 9.9mm = 0.1mm = 3600 EMU.
  const detail = V.checkShapeBounds({ x: Math.round(9.9 * V.EMU_PER_MM), y: 360000, cx: 1000000, cy: 1000000, label: 'S' }, ctx)[0].detail;
  assert.match(detail, /3600 EMU \(0\.1mm\)/);
});

test('U8 a standalone verify can only check the frozen-spec floor; --deck supplies the real m', () => {
  // With no deck the verifier does not know the author's margin, so the only sound check is the
  // frozen spec's ">= 10mm". It says which basis it used rather than implying it knew.
  const noDeck = V.verifyBuffer(FIXTURES.good);
  assert.equal(noDeck.marginMm, V.MARGIN_MM.DEFAULT);
  assert.equal(noDeck.marginSource, 'spec-floor');
  assert.deepEqual(errorCodes(noDeck), []);

  // A shape 12mm in is legal against the floor and illegal against a deck that asked for 15mm.
  const pptx = makePptx({ slides: [[{ ...FIT_SHAPE, x: 12 * V.EMU_PER_MM, y: 12 * V.EMU_PER_MM, cx: 1000000, cy: 361800 }]] });
  assert.deepEqual(errorCodes(V.verifyBuffer(pptx)), []);

  const withDeck = V.verifyBuffer(pptx, { deck: { meta: { marginMm: 15 }, pages: [{ title: 'x', blocks: [] }] } });
  assert.equal(withDeck.marginMm, 15);
  assert.equal(withDeck.marginSource, 'deck');
  assert.deepEqual(errorCodes(withDeck), ['MARGIN_VIOLATION']);
});

// ===========================================================================
// U9 — shape bounds, reported with the overshoot in mm
// ===========================================================================

test('U9 a shape past the slide edge is reported with how far past, in EMU and mm', () => {
  const ctx = { slideCx: V.A4P.cx, slideCy: V.A4P.cy, marginEmu: 360000, slide: 3 };
  const out = V.checkShapeBounds({ x: 360000, y: 360000, cx: 7300000, cy: 361800, label: 'Text 4' }, ctx);

  assert.deepEqual(codesOf(out), ['SHAPE_OUT_OF_BOUNDS']);
  assert.equal(out[0].slide, 3);
  assert.equal(out[0].shape, 'Text 4');
  assert.equal(out[0].severity, 'error');
  assert.equal(out[0].status, 'confirmed');
  // 360000 + 7300000 - 7560000 = 100000 EMU = 2.7777..mm
  assert.match(out[0].detail, /오른쪽 100000 EMU \(2\.78mm\)/);

  // Leaving the slide is reported once, not also as a margin violation on the same edge.
  assert.equal(out.length, 1);

  // Each of the four edges, and negative coordinates too.
  assert.match(V.checkShapeBounds({ x: -36000, y: 360000, cx: 100000, cy: 100000, label: 'S' }, ctx)[0].detail, /왼쪽 36000 EMU \(1mm\)/);
  assert.match(V.checkShapeBounds({ x: 360000, y: -72000, cx: 100000, cy: 100000, label: 'S' }, ctx)[0].detail, /위 72000 EMU \(2mm\)/);
  assert.match(V.checkShapeBounds({ x: 360000, y: 360000, cx: 100000, cy: 10500000, label: 'S' }, ctx)[0].detail, /아래 168000 EMU \(4\.67mm\)/);

  // End to end, and the p:grpSpPr 0,0,0,0 xfrm in every fixture must not be read as a shape.
  const report = V.verifyBuffer(makePptx({ slides: [[{ ...FIT_SHAPE, cx: 7300000 }]] }));
  assert.deepEqual(errorCodes(report), ['SHAPE_OUT_OF_BOUNDS']);
  assert.equal(report.counts.shapes, 1, 'p:grpSpPr is not a shape');
  assert.match(report.findings[0].detail, /100000 EMU/);
});

// ===========================================================================
// U10 — a mixed-orientation deck is refused
// ===========================================================================

test('U10 a deck that mixes portrait and landscape is refused, with the file-splitting fix', () => {
  const mixed = {
    meta: { title: 't' },
    pages: [
      { title: '세로', orientation: 'portrait', blocks: [] },
      { title: '가로', orientation: 'landscape', blocks: [] },
    ],
  };
  assert.throws(() => B.layout(mixed), (err) => {
    assert.ok(err instanceof B.UsageError);
    assert.equal(err.exitCode, 3);
    // One pptx has exactly one p:sldSz, so the only real fix is more files.
    assert.match(err.message, /파일을 나누/);
    assert.match(err.message, /split the deck into separate files/);
    return true;
  });

  // A uniformly landscape deck is a different refusal: out of scope, not impossible.
  assert.throws(
    () => B.layout({ pages: [{ title: 'x', orientation: 'landscape', blocks: [] }] }),
    (err) => err.exitCode === 3 && /A4 세로/.test(err.message) && !/파일을 나누/.test(err.message),
  );

  // meta-level orientation counts as the page default, so meta landscape + page portrait mixes too.
  assert.throws(
    () => B.layout({ meta: { orientation: 'landscape' }, pages: [{ title: 'a', blocks: [] }, { title: 'b', orientation: 'portrait', blocks: [] }] }),
    (err) => /파일을 나누/.test(err.message),
  );

  assert.equal(B.layout({ pages: [{ title: 'ok', blocks: [] }] }).slides.length, 1);
});

// ===========================================================================
// U11 — source hygiene
// ===========================================================================

test('U11 build_a4p.js contains neither 8.27 nor 11.69', () => {
  // defineLayout({width: 8.27, height: 11.69}) yields cx=7562088 cy=10689336: A4 to two decimals
  // and not A4 at all. The frozen spec prints both the inch pair and the EMU pair, so the rounded
  // literals are the single likeliest way this skill ships a deck a print shop rejects.
  const src = fs.readFileSync(BUILD_JS, 'utf8');
  assert.equal(src.includes('8.27'), false, 'a rounded inch literal is a wrong A4');
  assert.equal(src.includes('11.69'), false);
  assert.ok(src.includes('210 / 25.4'), 'full precision mm/25.4 is what produces the exact EMU pair');
  assert.ok(src.includes('297 / 25.4'));

  // Same rule for the python builder: both builders emit geometry, so neither may carry the
  // rounded pair at all. verify_a4p.mjs is deliberately NOT in this list — it names 8.27 x 11.69
  // in prose to explain why its comparison has no tolerance, and that sentence is the reason the
  // trap stays visible to the next reader. What matters there is the tolerance, which U2/U3 pin.
  const py = fs.readFileSync(BUILD_PY, 'utf8');
  assert.equal(py.includes('8.27'), false, 'build_a4p.py carries a rounded inch literal');
  assert.equal(py.includes('11.69'), false, 'build_a4p.py carries a rounded inch literal');

  // Measurement lives in the verifier alone: the builder parses no font binary (plan principle 5).
  assert.equal(/\bhmtx\b/.test(src), false, 'the builder must not parse font tables');
  assert.equal(/\bcmap\b/.test(src), false);
});

// ===========================================================================
// U18 — a font hint may never be looser than the family it stands for
// ===========================================================================
//
// findFontFile has two routes. The fc-match route checks the returned family against the
// requested name; the filename-glob route does not, because a filename carries no family.
// So a hint that matches a DIFFERENT family silently wins on any box without fc-match, and
// the requested name gets written into the pptx even though that name is not installed.
//
// Measured on Windows 10 (2026-08-09): the hint 'notosanskr' under the 'noto sans cjk kr'
// key matched C:\Windows\Fonts\NotoSansKR-VF.ttf, whose name table says "Noto Sans KR".
// The deck therefore claimed "Noto Sans CJK KR", a family that box does not have, so a
// viewer substitutes and the verifier could not measure it (fontSource fell to estimate).
// That defeats the whole reason the platform chain exists: write a name that is really
// there, so line breaks stay put. "Noto Sans KR" is its own chain entry now.
//
// The invariant is cheap to state: a hint must be a substring of its own key. It cannot then
// reach past the family it belongs to.

test('U18 every font-file hint is a substring of the family it belongs to', () => {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [family, hints] of Object.entries(B.FONT_FILE_HINTS)) {
    const key = norm(family);
    for (const h of hints) {
      assert.ok(key.includes(h),
        `hint ${JSON.stringify(h)} is not part of ${JSON.stringify(family)}, so it can match a different family and mis-name the deck`);
    }
  }

  // Every chain entry needs hints, or it is unreachable on a box without fc-match.
  for (const name of B.FONT_CHAIN) {
    assert.ok(B.FONT_FILE_HINTS[name.toLowerCase()],
      `${name} is in the chain but has no filename hints, so it can never resolve without fc-match`);
  }

  // The specific regression: these are two different families and must not share a key.
  assert.ok(!B.FONT_FILE_HINTS['noto sans cjk kr'].includes('notosanskr'),
    'Noto Sans KR is a different family from Noto Sans CJK KR and has its own entry');
  assert.ok(B.FONT_CHAIN.includes('Noto Sans KR'));
});

// ===========================================================================
// U17 — meta.title length: the two builders must agree
// ===========================================================================
//
// python-pptx refuses a core property over 255 chars. That limit is the library's,
// not OOXML's, so node happily writes 300 and the strict OPC reader opens the result.
// Left alone, one legal deck gives exit 0 + a file on node and a raw ValueError
// traceback + exit 1 on python, which breaks principle 5 (the builders are swappable)
// and the exit-code contract at once. Both now clamp and warn identically.
//
// This lives in the standing tier on purpose: E1/E1b compare the builders but are
// tier 2, so they never run in CI, and this axis would otherwise have no gate at all.

test('U17 meta.title clamps at the core-property limit, identically in both builders', () => {
  assert.equal(B.CORE_TITLE_MAX, 255, 'the cap is the python-pptx core property limit');

  const under = 'ㄱ'.repeat(255);
  const kept = B.clampCoreTitle(under);
  assert.equal(kept.truncated, false, '255 is exactly at the limit and must survive');
  assert.equal(kept.value, under);

  const over = 'ㄱ'.repeat(256);
  const cut = B.clampCoreTitle(over);
  assert.equal(cut.truncated, true, '256 must be flagged, not silently written');
  assert.equal(cut.value.length, 255);
  assert.equal(cut.value, over.slice(0, 255), 'the clamp keeps the head, not the tail');

  // A non-string never reaches the writer, so the clamp passes it through untouched
  // and leaves the type complaint to validateDeck.
  assert.deepEqual(B.clampCoreTitle(undefined), { value: undefined, truncated: false, length: 0 });

  // Outside the BMP the two languages count differently: JS String.length is UTF-16 code
  // units, Python len() is code points. 200 emoji are 200 code points but 400 units, so a
  // unit-based cap would clamp on node and not on python, and slicing at a unit boundary
  // splits a surrogate pair and turns the last character into U+FFFD.
  const astral = String.fromCodePoint(0x1f642).repeat(200);
  assert.equal(astral.length, 400, 'the fixture really is astral, not a BMP lookalike');
  const keptAstral = B.clampCoreTitle(astral);
  assert.equal(keptAstral.truncated, false, '200 code points is under the cap, so python would not clamp either');
  assert.equal(keptAstral.value, astral);

  const astralOver = String.fromCodePoint(0x1f642).repeat(256);
  const cutAstral = B.clampCoreTitle(astralOver);
  assert.equal(cutAstral.truncated, true);
  assert.equal(Array.from(cutAstral.value).length, 255, 'the cut is measured in code points');
  assert.equal(cutAstral.length, 256, 'the reported length is code points, so detail matches python');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cutAstral.value),
    'a lone high surrogate means the cut split a pair and broke the last character');


  // The python side must carry the same constant and the same warning code. Reading the
  // source keeps this in the dependency-free tier: no interpreter required.
  const py = fs.readFileSync(path.join(HERE, 'build_a4p.py'), 'utf8');
  assert.match(py, /CORE_TITLE_MAX\s*=\s*255/, 'python must clamp at the same length');
  assert.match(py, /'code':\s*'TITLE_TRUNCATED'/, 'python must emit the same warning code');
  assert.match(py, /except ValueError as err:\s*\n\s*raise UsageError/,
    'a library refusal must become UsageError (exit 3), never a raw traceback');

  const js = fs.readFileSync(BUILD_JS, 'utf8');
  assert.match(js, /code: 'TITLE_TRUNCATED'/, 'node must emit the same warning code');
  // The detail string must quote the number python would print, which is the code-point count.
  // Using meta.title.length here would put UTF-16 units in the message and split the two apart.
  assert.match(js, /detail: `\$\{t\.length\}/,
    'the warning detail must use the code-point length, not meta.title.length');
  assert.match(js, /Array\.from\(title\)/, 'the clamp must measure in code points');
});

// ===========================================================================
// U12 — exit codes
// ===========================================================================

test('U12 exit codes: 0 pass, 1 verification failure, 2 environment missing, 3 usage error', () => {
  assert.deepEqual({ ...V.EXIT }, { PASS: 0, FAIL: 1, ENV: 2, USAGE: 3 });
  assert.deepEqual({ ...B.EXIT }, { OK: 0, VERIFY: 1, ENV: 2, USAGE: 3 });

  const good = fixtureFile('exit-good', FIXTURES.good);
  const bad = fixtureFile('exit-preset', FIXTURES.presetTrap);

  assert.equal(quiet(() => V.main([good])).value, 0, 'a conforming deck exits 0');
  assert.equal(quiet(() => V.main([good, '--json'])).value, 0);
  assert.equal(quiet(() => V.main([bad])).value, 1, 'a failing verdict exits 1');
  assert.equal(quiet(() => V.main([fixtureFile('exit-notzip', Buffer.from('not a zip at all'))])).value, 1,
    'an unreadable artifact is a verdict about the artifact, not a crash');

  assert.equal(quiet(() => V.main([])).value, 3, 'no input file');
  assert.equal(quiet(() => V.main(['--nope', good])).value, 3, 'unknown option');
  assert.equal(quiet(() => V.main([good, good])).value, 3, 'two input files');
  assert.equal(quiet(() => V.main([tmp('absent.pptx')])).value, 3, 'missing input file');
  assert.equal(quiet(() => V.main([good, '--font-file'])).value, 3, 'option without its value');
  assert.equal(quiet(() => V.main([good, '--repair'])).value, 3, '--repair with neither --out nor --in-place');
  assert.equal(quiet(() => V.main(['--help'])).value, 0, '--help is not an error');

  // Warnings only fail under --strict, which is what makes the plain verdict usable.
  const slotSplit = fixtureFile('exit-slots', makePptx({ slides: [[{ ...FIT_SHAPE, ea: null }]] }));
  assert.equal(quiet(() => V.main([slotSplit])).value, 0);
  assert.equal(quiet(() => V.main([slotSplit, '--strict'])).value, 1);
});

test('U12 the builder maps a schema violation to 3 and a missing pptxgenjs to 2', async () => {
  const deckPath = tmp('u12-deck.json');
  fs.writeFileSync(deckPath, JSON.stringify({ meta: {}, pages: [{ title: 't', blocks: [{ type: 'nope', text: 'x' }] }] }));
  await assert.rejects(
    B.main(['--in', deckPath, '--out', tmp('u12.pptx')]),
    (err) => err instanceof B.UsageError && err.exitCode === 3,
  );

  fs.writeFileSync(deckPath, JSON.stringify({ meta: {}, pages: [{ title: 't', blocks: [{ type: 'body', text: 'x' }] }] }));

  // Environment check, in a child with the module search deliberately emptied: NODE_PATH cleared
  // and HOME pointed at an empty directory, so nothing but a machine-global install could resolve.
  // The message has to be something a person can act on, and no child process may be spawned to
  // find a font before the environment verdict is reached.
  //
  // The builder is COPIED somewhere isolated first, and that is the whole point of this setup.
  // loadPptxgen() tries a plain `require.resolve('pptxgenjs')` before the paths-based one, and a
  // plain resolve walks up from the FILE's own directory, not from cwd. Running the builder in
  // place therefore finds any pptxgenjs installed in an ancestor of skills/, which is a perfectly
  // normal layout: `npm i pptxgenjs` in the directory holding the skill. Measured on an aarch64
  // box laid out that way, this test saw exit 0 while the same code exited 2 here. The product
  // behaviour is right (a builder SHOULD use a pptxgenjs installed next to it); the simulation was
  // the thing making an assumption, so the copy removes the assumption instead of the behaviour.
  const empty = tmp('empty-cwd');
  fs.mkdirSync(empty, { recursive: true });
  const isolatedBuilder = path.join(empty, 'build_a4p.js');
  fs.copyFileSync(BUILD_JS, isolatedBuilder);   // build_a4p.js has no local requires, so a copy runs standalone
  const r = spawnSync(process.execPath, [isolatedBuilder, '--in', deckPath, '--out', tmp('u12-env.pptx')], {
    cwd: empty,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '', HOME: empty, USERPROFILE: empty, npm_config_prefix: empty },
  });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.match(r.stdout, /docs-setup/, 'exit 2 goes to stdout because it is instructions, not a stack trace');
  assert.match(r.stdout, /npm i pptxgenjs/);
  assert.equal(fs.existsSync(tmp('u12-env.pptx')), false, 'a failed environment check writes nothing');
});

// ===========================================================================
// U13 — INV-G, the invariant the whole design rests on
// ===========================================================================

/** Every coordinate the layout produced, in order. Text is deliberately absent from this. */
const coordsOf = (laid) => laid.slides.map((s) => s.shapes.map((sh) => [sh.x, sh.y, sh.cx, sh.cy]));

const INV_G_DECK = {
  meta: { title: '제목', bodyPt: 10.5, marginMm: 10 },
  pages: [
    {
      title: '페이지 하나',
      blocks: [
        { type: 'head', text: '소제목' },
        { type: 'body', text: '문단' },
        { type: 'bullets', items: ['하나', '둘', '셋'] },
        { type: 'body', text: '지정된 행', rows: 5 },
      ],
    },
    { title: '페이지 둘', blocks: [{ type: 'bullets', items: ['가', '나'], rows: 4 }] },
  ],
};

/** Same shape, every string replaced by something of a wildly different length. */
function substituteText(deck, filler) {
  const out = JSON.parse(JSON.stringify(deck));
  out.meta.title = filler('title');
  for (const page of out.pages) {
    page.title = filler('page');
    for (const block of page.blocks) {
      if (block.type === 'bullets') block.items = block.items.map((_, i) => filler(`item${i}`));
      else block.text = filler('text');
    }
  }
  return out;
}

test('U13 INV-G: replacing every string leaves the coordinate set byte-for-byte identical', () => {
  const base = coordsOf(B.layout(INV_G_DECK));

  const substitutions = [
    () => '',
    () => 'a',
    () => 'W'.repeat(5000),
    () => '가'.repeat(400),
    (k) => `${k} — mixed 한영 ${'iiiii lllll'.repeat(30)}`,
    () => '\n\n\n',
    () => '🙂🙂🙂 astral plane',
  ];
  for (const filler of substitutions) {
    const laid = B.layout(substituteText(INV_G_DECK, filler));
    assert.deepEqual(coordsOf(laid), base, `text substitution changed geometry: ${filler.name || 'anonymous'}`);
    assert.deepEqual(laid.warnings, [], 'text length must not manufacture warnings either');
  }

  // Font and point size are not geometry inputs either.
  assert.deepEqual(coordsOf(B.layout({ ...INV_G_DECK, meta: { ...INV_G_DECK.meta, font: 'Arial', bodyPt: 24 } })), base);

  // ...but the declared inputs ARE inputs. If marginMm did not move the grid, the assertion above
  // would be satisfied by a layout() that ignores its arguments.
  assert.notDeepEqual(coordsOf(B.layout({ ...INV_G_DECK, meta: { ...INV_G_DECK.meta, marginMm: 15 } })), base);
});

test('U13 rows(block) = min(18, block.rows ?? default(type)), with head 1, body 2, bullets items.length', () => {
  assert.equal(B.MAX_BLOCK_ROWS, 18);
  assert.equal(B.TITLE_ROWS, 2);
  assert.equal(B.ROWS - B.TITLE_ROWS, B.MAX_BLOCK_ROWS);

  assert.equal(B.defaultRows({ type: 'head', text: 'x' }), 1);
  assert.equal(B.defaultRows({ type: 'body', text: 'x' }), 2);
  assert.equal(B.defaultRows({ type: 'bullets', items: ['a', 'b', 'c'] }), 3);

  assert.equal(B.rowsOf({ type: 'head', text: 'x' }), 1);
  assert.equal(B.rowsOf({ type: 'head', text: 'x', rows: 7 }), 7, 'an explicit rows wins over the default');
  assert.equal(B.rowsOf({ type: 'body', text: 'x', rows: 19 }), 18, 'clamped at 18');
  assert.equal(B.rowsOf({ type: 'bullets', items: Array(19).fill('x') }), 18, 'the default clamps too');

  // The clamp decision is made on the REQUESTED count, not the clamped one; otherwise a 19-item
  // bullet block with no explicit rows ships with items 17 and 18 quietly stacked on each other.
  assert.equal(B.requestedRows({ type: 'bullets', items: Array(19).fill('x') }), 19);
  assert.equal(B.requestedRows({ type: 'body', text: 'x' }), 2);
});

test('U13 a 19-row block clamps to 18 and bottoms out exactly on the bottom margin', () => {
  const laid = B.layout({ meta: {}, pages: [{ title: 'p', blocks: [{ type: 'bullets', items: Array(19).fill('항목') }] }] });

  assert.deepEqual(laid.warnings, [{ code: 'BLOCK_TOO_TALL', page: 0, block: 0, detail: 'rows 19 -> 18' }]);

  const shapes = laid.slides[0].shapes;
  assert.equal(shapes.length, 20, 'one title plus nineteen items');
  const last = shapes[shapes.length - 1];
  assert.equal(last.y + last.cy, 10332000);
  assert.equal(last.y + last.cy, B.SLIDE_H - 10 * 36000, 'the bottom margin, to the EMU');

  // n < items means the tail overlaps on the last row, and that overlap is real, not hidden.
  assert.equal(shapes[shapes.length - 2].y, last.y);

  // Every shape is still inside the slide, which is what the clamp exists to guarantee.
  for (const sh of shapes) {
    assert.ok(sh.x >= 360000 && sh.y >= 360000);
    assert.ok(sh.x + sh.cx <= B.SLIDE_W - 360000);
    assert.ok(sh.y + sh.cy <= B.SLIDE_H - 360000);
  }
});

test('U13 bullets spread across their rows, and a block that does not fit opens a new slide', () => {
  // n > items: the leftover rows go to the last item rather than to a gap.
  assert.deepEqual(B.bulletSpans(5, 2), [{ start: 0, rows: 1 }, { start: 1, rows: 4 }]);
  assert.deepEqual(B.bulletSpans(3, 3), [{ start: 0, rows: 1 }, { start: 1, rows: 1 }, { start: 2, rows: 1 }]);
  // n < items: everything past row n-1 stacks there.
  assert.deepEqual(B.bulletSpans(2, 4), [{ start: 0, rows: 1 }, { start: 1, rows: 1 }, { start: 1, rows: 1 }, { start: 1, rows: 1 }]);

  const laid = B.layout({
    meta: {},
    pages: [{ title: '한 장', blocks: [{ type: 'body', text: 'a', rows: 10 }, { type: 'body', text: 'b', rows: 10 }] }],
  });
  assert.equal(laid.slides.length, 2, '10 + 10 > 18, so the second block gets its own slide');
  assert.deepEqual(laid.slides.map((s) => s.pageIndex), [0, 0]);
  assert.deepEqual(laid.slides.map((s) => s.part), [0, 1]);
  assert.deepEqual(laid.slides.map((s) => s.title), ['한 장', '한 장'], 'the page title repeats on the continuation');
  // Blocks are never split: splitting would need a measurement the builder deliberately does not make.
  assert.equal(laid.slides[0].shapes.length, 2);
  assert.equal(laid.slides[1].shapes.length, 2);
});

// ===========================================================================
// U14 — verdict codes on the fixtures
// ===========================================================================

test('U14 each fixture produces exactly the verdict it was built to produce', () => {
  const cases = [
    ['good', FIXTURES.good, []],
    ['goodCustom', FIXTURES.goodCustom, []],
    ['presetTrap', FIXTURES.presetTrap, ['PRESET_TRAP', 'NOT_A4_PORTRAIT']],
    ['screen4x3', FIXTURES.screen4x3, ['PRESET_TYPE_ATTR']],
    ['typeA4', FIXTURES.typeA4, ['PRESET_TYPE_ATTR']],
    ['screen16x9', FIXTURES.screen16x9, ['PRESET_TYPE_ATTR', 'NOT_A4_PORTRAIT']],
    ['square', FIXTURES.square, ['NOT_A4_PORTRAIT', 'MIXED_ORIENTATION']],
    ['noPresentation', FIXTURES.noPresentation, ['MISSING_PRESENTATION_XML']],
  ];
  for (const [name, buf, expected] of cases) {
    const report = V.verifyBuffer(buf);
    assert.deepEqual(errorCodes(report), expected, `fixture ${name}`);
    assert.equal(report.ok, expected.length === 0, `fixture ${name} ok flag`);
  }

  // Not a zip at all: a verdict, delivered through main(), not an exception out of verifyBuffer.
  assert.throws(() => V.verifyBuffer(Buffer.from('PK not really')), (err) => err.code === 'NOT_A_ZIP');
  const notZip = quiet(() => V.main([fixtureFile('u14-notzip', Buffer.from('PK not really'))]));
  assert.equal(notZip.value, 1);
  assert.match(notZip.out, /NOT_A_ZIP/);

  // The good fixture is a complete round trip: written by this file's writer, read by the verifier.
  const good = V.verifyBuffer(FIXTURES.good);
  assert.equal(good.counts.slides, 1);
  assert.equal(good.counts.shapes, 1);
  assert.equal(good.counts.runs, 1);
});

test('U14 the reader handles stored and deflated entries, and the central directory is the authority', () => {
  const zip = V.openZip(FIXTURES.good);
  assert.deepEqual(zip.names(), ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/slides/slide1.xml']);

  const entries = V.readZipDirectory(FIXTURES.good);
  assert.deepEqual(entries.map((e) => e.method), [8, 0, 8, 8], '_rels/.rels was stored on purpose');
  assert.equal(zip.readText('_rels/.rels'), ROOT_RELS, 'method 0 round trips');
  assert.equal(zip.readText('ppt/presentation.xml'), presentationXml(), 'method 8 round trips');
  assert.equal(zip.read('nope/missing.xml'), null);

  // The reader must not confuse p:notesSz for p:sldSz: both carry cx and cy.
  const size = V.readSlideSize(zip.readText('ppt/presentation.xml'));
  assert.deepEqual({ cx: size.cx, cy: size.cy, type: size.type }, { cx: 7560000, cy: 10692000, type: null });
});

// ===========================================================================
// U15 — re-zip integrity
// ===========================================================================

/**
 * The U15 assertion set, run against every archive this suite produces or repairs. Everything here
 * is computed by this file: its own CRC32, its own central-directory walk, its own local-header
 * walk. verifyZipIntegrity() is checked separately, against these results, so the production
 * self-check cannot pass by agreeing with itself.
 */
function assertZipIntegrity(buf, what) {
  const entries = readZipRaw(buf);
  assert.ok(entries.length > 0, `${what}: no entries`);
  // The first PART, not the first record: pptxgenjs writes 19 directory records ahead of any file,
  // and a directory record is not a part. OPC constrains parts.
  const parts = entries.filter((e) => !e.isDir);
  assert.equal(parts[0].name, '[Content_Types].xml', `${what}: OPC requires [Content_Types].xml to be the first part`);

  const seen = new Set();
  for (const e of entries) {
    assert.equal(e.localSig, LOC_SIG, `${what}: ${e.name} has no 0x04034b50 at its central-directory offset`);
    assert.equal(e.localName, e.name, `${what}: ${e.name} local header names "${e.localName}"`);
    assert.equal(seen.has(e.name), false, `${what}: duplicate entry ${e.name}`);
    seen.add(e.name);
    if (e.isDir) continue;
    assert.equal(crc32(e.data), e.crc, `${what}: ${e.name} CRC32 disagrees with the central directory`);
    assert.equal(e.data.length, e.usize, `${what}: ${e.name} size disagrees with the central directory`);
  }
  return entries;
}

test('U15 --repair rewrites only p:sldSz, and the archive it produces stays structurally sound', () => {
  // [Content_Types].xml is written LAST on purpose, and one entry is stored rather than deflated.
  const broken = makePptx({
    size: { cx: V.PRESET_TRAP.cx, cy: V.PRESET_TRAP.cy, type: 'A4' },
    slides: [[FIT_SHAPE]],
    order: ['ppt/presentation.xml', '_rels/.rels', 'ppt/slides/slide1.xml', '[Content_Types].xml'],
  });
  assert.equal(readZipRaw(broken)[0].name, 'ppt/presentation.xml', 'the input really is in the wrong order');

  const rep = V.repairBuffer(broken);
  assert.equal(rep.changed, true);
  const after = assertZipIntegrity(rep.out, 'repaired');

  assert.deepEqual(after.map((e) => e.name).slice(0, 1), ['[Content_Types].xml'], 'moved to the front');
  assert.deepEqual([...after.map((e) => e.name)].sort(), [...readZipRaw(broken).map((e) => e.name)].sort(), 'no entry gained or lost');

  const before = new Map(readZipRaw(broken).map((e) => [e.name, e]));
  for (const e of after) {
    if (e.name === 'ppt/presentation.xml') continue;
    assert.ok(e.data.equals(before.get(e.name).data), `${e.name} is untouched and must be byte-identical`);
    assert.equal(e.method, before.get(e.name).method, `${e.name} keeps its original compression method`);
    assert.equal(e.crc, before.get(e.name).crc, `${e.name} keeps its original CRC`);
  }

  const fixed = after.find((e) => e.name === 'ppt/presentation.xml').data.toString('utf8');
  assert.ok(fixed.includes('cx="7560000" cy="10692000"'), 'the exact frozen-spec pair, no tolerance');
  assert.equal(/<p:sldSz[^>]*type=/.test(fixed), false, 'the preset type declaration is gone');
  assert.ok(fixed.includes('<p:notesSz cx="6858000" cy="9144000"/>'), 'nothing else in the part was rewritten');

  // The output passes the verifier it was repaired for.
  assert.deepEqual(errorCodes(V.verifyBuffer(rep.out)), []);

  // And the production self-check has to agree with the independent one above.
  const selfCheck = V.verifyZipIntegrity(rep.out, { source: broken, untouched: rep.untouched });
  assert.deepEqual(selfCheck.problems, []);
  assert.equal(selfCheck.ok, true);
  assert.equal(selfCheck.firstEntry, '[Content_Types].xml');
  assert.equal(selfCheck.entryCount, after.length);
});

test('U15 the integrity check actually catches a corrupted archive', () => {
  // A self-check that passes on everything proves nothing, so break one on purpose. Flipping a
  // byte of compressed data changes what inflates without touching the stored CRC.
  const buf = Buffer.from(FIXTURES.good);
  const entries = V.readZipDirectory(buf);
  const target = entries.find((e) => e.name === 'ppt/slides/slide1.xml');
  const dataAt = target.localOffset + 30 + buf.readUInt16LE(target.localOffset + 26) + buf.readUInt16LE(target.localOffset + 28);
  buf[dataAt + 12] ^= 0xff;

  const result = V.verifyZipIntegrity(buf);
  assert.equal(result.ok, false);
  assert.ok(result.problems.length > 0);
  assert.match(result.problems.join('\n'), /slide1\.xml/);

  // A wrong first entry is a distinct problem, and it is detected without any data corruption.
  const misordered = makePptx({ order: ['_rels/.rels', '[Content_Types].xml', 'ppt/presentation.xml'] });
  const order = V.verifyZipIntegrity(misordered);
  assert.equal(order.ok, false);
  assert.match(order.problems.join('\n'), /\[Content_Types\]\.xml/);
});

test('U15 every fixture this suite writes satisfies the same integrity contract', () => {
  // Including the ones that are deliberately wrong ABOUT A4: a bad verdict is not a bad archive,
  // and the two must not be able to mask each other.
  for (const [name, buf] of Object.entries(FIXTURES)) {
    assertZipIntegrity(buf, `fixture ${name}`);
    assert.deepEqual(V.verifyZipIntegrity(buf).problems, [], `fixture ${name} through the production check`);
  }
});

// ===========================================================================
// U16 — the meta.marginMm contract
// ===========================================================================

test('U16 meta.marginMm accepts integers 10..40 and rejects everything else with exit 3', () => {
  assert.equal(B.MARGIN_MM_MIN, 10);
  assert.equal(B.MARGIN_MM_MAX, 40);
  assert.equal(B.DEFAULT_MARGIN_MM, 10);
  assert.deepEqual({ ...V.MARGIN_MM }, { MIN: 10, MAX: 40, DEFAULT: 10 });

  const deck = (marginMm) => ({ meta: { marginMm }, pages: [{ title: 't', blocks: [{ type: 'body', text: 'x' }] }] });

  for (const m of [10, 11, 25, 40]) {
    assert.equal(B.layout(deck(m)).grid.marginMm, m, `marginMm ${m} is inside the contract`);
    assert.equal(V.deckMarginMm(deck(m)), m);
  }
  for (const m of [9, 41, 0, -10, 10.5, 39.9, '10', null, NaN, Infinity]) {
    assert.throws(
      () => B.layout(deck(m)),
      (err) => err instanceof B.UsageError && err.exitCode === 3,
      `marginMm ${JSON.stringify(m)} must be a usage error`,
    );
  }
  // null is "absent" to the verifier and the default applies; every other bad value is rejected.
  assert.equal(V.deckMarginMm(deck(null)), 10);
  assert.equal(V.deckMarginMm({ meta: {} }), 10);
  assert.equal(V.deckMarginMm({}), 10);
  for (const m of [9, 41, 10.5, '10', NaN]) {
    assert.throws(() => V.deckMarginMm(deck(m)), (err) => err.code === 'BAD_MARGIN', `verifier must reject ${JSON.stringify(m)}`);
  }

  // Through the CLI, an out-of-contract deck is a usage error (3), not a deck defect (1).
  const badDeck = tmp('u16-bad-deck.json');
  fs.writeFileSync(badDeck, JSON.stringify(deck(9)));
  assert.equal(quiet(() => V.main([fixtureFile('u16', FIXTURES.good), '--deck', badDeck])).value, 3);
});

test('U16 marginMm derives the grid, so it moves coordinates and text still does not', () => {
  const at = (m) => B.layout({ meta: { marginMm: m }, pages: [{ title: 't', blocks: [{ type: 'body', text: 'x' }] }] });

  const ten = at(10);
  const fifteen = at(15);
  assert.equal(ten.slides[0].shapes[0].x, 360000);
  assert.equal(fifteen.slides[0].shapes[0].x, 540000, 'x = 36000 * m');
  assert.notDeepEqual(coordsOf(fifteen), coordsOf(ten));

  // The derived grid, not a second table of constants.
  assert.equal(fifteen.grid.colW, (182 - 30) * 4500);
  assert.equal(fifteen.grid.rowH, (221 - 30) * 1800);
  assert.equal(fifteen.slides[0].shapes[0].cx, fifteen.grid.contentW, 'a full-width block spans all 8 columns');

  // Absent marginMm falls back to the default rather than to undefined arithmetic.
  const bare = B.layout({ pages: [{ title: 't', blocks: [{ type: 'body', text: 'x' }] }] });
  assert.equal(bare.grid.marginMm, 10);
  assert.deepEqual(coordsOf(bare), coordsOf(ten));

  // Same margin, different text: identical. Different margin, same text: different. That pair is
  // what "marginMm is an INV-G input and text is not" means operationally.
  const otherText = B.layout({ meta: { marginMm: 15 }, pages: [{ title: '완전히 다른 제목'.repeat(50), blocks: [{ type: 'body', text: '' }] }] });
  assert.deepEqual(coordsOf(otherText), coordsOf(fifteen));
});

// ===========================================================================
// TIER 2 — cross-builder equivalence. Needs real builders; skips loudly without them.
// ===========================================================================

const nodeBuilder = (() => {
  for (const paths of [B.moduleSearchPaths(), null]) {
    try {
      return { ok: true, path: paths ? require.resolve('pptxgenjs', { paths }) : require.resolve('pptxgenjs') };
    } catch { /* try the next resolution strategy */ }
  }
  return { ok: false, reason: 'pptxgenjs is not installed. `npm i pptxgenjs`, or set NODE_PATH to a node_modules that has it.' };
})();

const pythonBuilder = (() => {
  const candidates = [process.env.A4P_PYTHON, process.env.PYTHON, 'python3', 'python', 'python3.12', 'python3.11', 'python3.10'].filter(Boolean);
  for (const bin of candidates) {
    const r = spawnSync(bin, ['-c', 'import pptx; print(pptx.__version__)'], { encoding: 'utf8' });
    if (r.status === 0) return { ok: true, bin, version: (r.stdout || '').trim() };
  }
  return {
    ok: false,
    reason: `no interpreter among [${candidates.join(', ')}] can import python-pptx. `
      + 'Set A4P_PYTHON to one that can, or PYTHONPATH to a directory holding python-pptx.',
  };
})();

/**
 * The skip gate. Absent builders skip and say so; A4P_REQUIRE_BUILDERS=1 turns that into a failure,
 * because a release must not be able to mistake "never ran" for "green".
 */
function needBuilders(t, ...probes) {
  const missing = probes.filter((p) => !p.ok).map((p) => p.reason);
  if (!missing.length) return true;
  const reason = `tier 2 needs a real builder: ${missing.join(' | ')}`;
  if (process.env.A4P_REQUIRE_BUILDERS === '1') {
    assert.fail(`${reason}\n  (A4P_REQUIRE_BUILDERS=1 is set, so this is a failure rather than a skip.)`);
  }
  console.log(`# SKIP ${t.name}: ${reason}`);
  t.skip(reason);
  return false;
}

const E1_DECK = {
  meta: { title: '교차 검증 덱', font: 'auto', bodyPt: 10.5, marginMm: 10 },
  pages: [
    {
      title: '첫 페이지',
      blocks: [
        { type: 'head', text: '소제목 하나' },
        { type: 'body', text: '본문 한 줄.' },
        { type: 'bullets', items: ['항목 하나', '항목 둘', '항목 셋'] },
      ],
    },
    {
      title: '둘째 페이지',
      blocks: [
        { type: 'body', text: '첫 줄\n둘째 줄' },
        { type: 'bullets', items: Array.from({ length: 19 }, (_, i) => `항목 ${i + 1}`) },
      ],
    },
  ],
};

/*
 * Page 1 is head(1) + body(2) + bullets of 3(3) = 6 rows, one slide. Page 2 is body(2) + a 19-item
 * bullet block that clamps to 18, and 2 + 18 > 18, so the block moves to a continuation slide.
 * 1 + 2 = 3. Asserted against layout() as well as against the literal, so the literal cannot rot
 * quietly and layout() cannot satisfy the test by agreeing with itself.
 */
const E1_SLIDES = 3;

const writeJson = (name, value) => {
  const p = tmp(name);
  fs.writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`);
  return p;
};

const lastJsonLine = (text) => {
  const lines = String(text).trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
};

function runNode(deckPath, outPath) {
  const r = spawnSync(process.execPath, [BUILD_JS, '--in', deckPath, '--out', outPath], { encoding: 'utf8' });
  assert.equal(r.status, 0, `node builder exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return lastJsonLine(r.stdout);
}

function runPython(deckPath, outPath) {
  const r = spawnSync(pythonBuilder.bin, [BUILD_PY, '--in', deckPath, '--out', outPath], { encoding: 'utf8', cwd: TMP });
  assert.equal(r.status, 0, `python builder exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return lastJsonLine(r.stdout);
}

const localTag = (tag) => (tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag);

/**
 * Everything E1 compares, and nothing it does not. Shapes come out of parseSlide(), which walks the
 * direct children of p:spTree and keeps only shape elements. A document-wide <a:off>/<a:ext> regex
 * would also pick up p:spTree's own grpSpPr 0,0,0,0 pair, and pairing those across the document
 * manufactures a mismatch that is not in either file.
 *
 * Shape NAMES are excluded on purpose: pptxgenjs writes "Text 0..5" and python-pptx "TextBox 1..6".
 * Neither is visible in the rendered deck and neither is part of the contract.
 */
function normalizePptx(file) {
  const zip = V.openZip(fs.readFileSync(file));
  const size = V.readSlideSize(zip.readText('ppt/presentation.xml'));
  const parts = V.slideParts(zip);
  const slides = parts.map((part) => V.parseSlide(zip.readText(part))
    .filter((s) => localTag(s.tag) === 'sp')
    .map((s) => ({
      box: { x: s.x, y: s.y, cx: s.cx, cy: s.cy },
      text: s.paragraphs.map((lines) => lines.map((runs) => runs.map((r) => r.text).join('')).join(' ')).join('\n'),
      slots: s.paragraphs.flatMap((lines) => lines.flatMap((runs) => runs.map((r) => [r.latin, r.ea, r.cs]))),
      body: s.body === null ? null : { wrap: s.body.wrap, autofit: s.body.autofit },
    })));
  return {
    sldSz: { cx: size.cx, cy: size.cy, type: size.type },
    slideCount: parts.length,
    slides,
  };
}

test('I1 the node builder writes the exact frozen-spec sldSz', (t) => {
  if (!needBuilders(t, nodeBuilder)) return;

  const deckPath = writeJson('i1-deck.json', E1_DECK);
  const out = tmp('i1-node.pptx');
  const status = runNode(deckPath, out);

  const xml = V.openZip(fs.readFileSync(out)).readText('ppt/presentation.xml');
  const hits = xml.match(/cx="7560000" cy="10692000"/g) || [];
  assert.equal(hits.length, 1, 'exactly one exact-string sldSz, zero tolerance');
  assert.equal(/<p:sldSz[^>]*type=/.test(xml), false, 'pptxgenjs emits no type, which OOXML reads as custom');
  assert.equal(xml.includes('7562088'), false, 'the rounded 8.27in width must not appear');

  assert.equal(status.skill, 'vertical-pptx');
  assert.equal(status.builder, 'node');
  assert.ok('font' in status && 'fontFile' in status, 'the status line must carry font and fontFile');
  assert.equal(status.slides, E1_SLIDES);
  assert.equal(status.slides, B.layout(E1_DECK).slides.length);

  assertZipIntegrity(fs.readFileSync(out), 'node builder output');
});

test('I2 the python builder writes the same sldSz and drops the leftover screen4x3 declaration', (t) => {
  if (!needBuilders(t, pythonBuilder)) return;

  const deckPath = writeJson('i2-deck.json', E1_DECK);
  const out = tmp('i2-python.pptx');
  const status = runPython(deckPath, out);

  const zip = V.openZip(fs.readFileSync(out));
  const xml = zip.readText('ppt/presentation.xml');
  assert.equal((xml.match(/cx="7560000" cy="10692000"/g) || []).length, 1);
  assert.equal(/<p:sldSz[^>]*type=/.test(xml), false, 'python-pptx carries type="screen4x3" out of its template unless it is removed');

  // Nowhere in the package, not just in presentation.xml.
  for (const name of zip.names()) {
    const text = zip.readText(name);
    if (text !== null) assert.equal(text.includes('screen4x3'), false, `screen4x3 survives in ${name}`);
  }

  assert.equal(status.builder, 'python');
  assert.equal(status.slides, E1_SLIDES);
  assertZipIntegrity(fs.readFileSync(out), 'python builder output');
});

test('I3 both builders produce a deck the verifier passes', (t) => {
  if (!needBuilders(t, nodeBuilder, pythonBuilder)) return;

  const deckPath = writeJson('i3-deck.json', E1_DECK);
  const nodeOut = tmp('i3-node.pptx');
  const pyOut = tmp('i3-python.pptx');
  runNode(deckPath, nodeOut);
  runPython(deckPath, pyOut);

  for (const [label, file] of [['node', nodeOut], ['python', pyOut]]) {
    const report = V.verifyFile(file, { deck: E1_DECK });
    assert.deepEqual(report.findings.filter((f) => f.severity === 'error'), [], `${label} produced error findings`);
    assert.equal(report.ok, true, `${label} verdict`);
    assert.equal(quiet(() => V.main([file, '--deck', deckPath])).value, 0, `${label} exit code`);
  }
});

test('I4 every python run carries all three Korean font slots with one typeface', (t) => {
  if (!needBuilders(t, pythonBuilder)) return;

  const out = tmp('i4-python.pptx');
  const status = runPython(writeJson('i4-deck.json', E1_DECK), out);
  const zip = V.openZip(fs.readFileSync(out));

  let runs = 0;
  for (const part of V.slideParts(zip)) {
    for (const shape of V.parseSlide(zip.readText(part))) {
      for (const paragraph of shape.paragraphs) {
        for (const line of paragraph) {
          for (const run of line) {
            if (!run.text) continue;
            runs++;
            assert.ok(run.latin, 'a:latin');
            assert.ok(run.ea, 'a:ea is what keeps Hangul off the viewer fallback');
            assert.ok(run.cs, 'a:cs');
            assert.equal(run.ea, run.latin);
            assert.equal(run.cs, run.latin);
            if (status.font) assert.equal(run.latin, status.font, 'the slots must name the font the builder reported');
          }
        }
      }
    }
  }
  assert.ok(runs > 0, 'the fixture deck has text in it');
  assert.deepEqual(V.verifyFile(out).findings.filter((f) => f.code.startsWith('FONT_SLOT')), []);
});

test('E1 the two builders agree on everything that is visible in the output', (t) => {
  if (!needBuilders(t, nodeBuilder, pythonBuilder)) return;

  const deckPath = writeJson('e1-deck.json', E1_DECK);
  const nodeOut = tmp('e1-node.pptx');
  const pyOut = tmp('e1-python.pptx');
  const nodeStatus = runNode(deckPath, nodeOut);
  const pyStatus = runPython(deckPath, pyOut);

  const a = normalizePptx(nodeOut);
  const b = normalizePptx(pyOut);

  assert.deepEqual(a.sldSz, b.sldSz);
  assert.deepEqual(a.sldSz, { cx: 7560000, cy: 10692000, type: null });
  assert.equal(a.slideCount, b.slideCount);
  assert.equal(a.slideCount, E1_SLIDES);
  assert.equal(a.slideCount, B.layout(E1_DECK).slides.length, 'both builders must agree with layout()');

  // A per-slide loop over zero shapes would pass vacuously, so pin the total against layout().
  const laid = B.layout(E1_DECK);
  const expectedShapes = laid.slides.reduce((n, s) => n + s.shapes.length, 0);
  assert.equal(a.slides.reduce((n, s) => n + s.length, 0), expectedShapes, 'node shape total');
  assert.equal(b.slides.reduce((n, s) => n + s.length, 0), expectedShapes, 'python shape total');
  assert.ok(expectedShapes >= 20, `the fixture deck must actually exercise the comparison (${expectedShapes} shapes)`);

  for (let i = 0; i < a.slideCount; i++) {
    assert.equal(a.slides[i].length, b.slides[i].length, `slide ${i + 1}: shape count`);
    // Both builders must also agree with layout(), which is where INV-G is actually implemented.
    assert.deepEqual(a.slides[i].map((s) => [s.box.x, s.box.y, s.box.cx, s.box.cy]),
      laid.slides[i].shapes.map((sh) => [sh.x, sh.y, sh.cx, sh.cy]), `slide ${i + 1}: node vs layout()`);
    for (let j = 0; j < a.slides[i].length; j++) {
      const shapeA = a.slides[i][j];
      const shapeB = b.slides[i][j];
      // Zero tolerance. A tolerance wide enough to absorb a rounding difference is wide enough to
      // absorb a real drift between the two grids.
      assert.deepEqual(shapeB.box, shapeA.box, `slide ${i + 1} shape ${j}: coordinates`);
      assert.deepEqual(shapeB.text, shapeA.text, `slide ${i + 1} shape ${j}: text`);
      assert.deepEqual(shapeB.slots, shapeA.slots, `slide ${i + 1} shape ${j}: font slots`);
      assert.deepEqual(shapeB.body, shapeA.body, `slide ${i + 1} shape ${j}: a:bodyPr`);
      // The value both builders were fixed to, spelled out so a shared regression is still visible.
      assert.deepEqual(shapeA.body, { wrap: 'square', autofit: 'none' });
    }
  }

  assert.deepEqual(pyStatus.warnings, nodeStatus.warnings, 'the two builders must warn identically');
  assert.ok(nodeStatus.warnings.some((w) => w.code === 'BLOCK_TOO_TALL'), 'the fixture deck contains a 19-item block');
  assert.equal(pyStatus.slides, nodeStatus.slides);
});

test('E1b the same substitution that leaves layout() fixed leaves both builders fixed', (t) => {
  if (!needBuilders(t, nodeBuilder, pythonBuilder)) return;

  const baseDeck = writeJson('e1b-base.json', E1_DECK);
  const baseNode = tmp('e1b-base-node.pptx');
  runNode(baseDeck, baseNode);
  const baseline = normalizePptx(baseNode).slides.map((slide) => slide.map((s) => s.box));

  const substituted = substituteText(E1_DECK, (k) => (k === 'item0' ? '' : `${k} ${'W'.repeat(300)} ${'가'.repeat(120)}`));
  // meta.title is an OPC core property, not a text run, and OPC caps it at 255 characters. It is
  // therefore substituted but not lengthened: everything INV-G actually governs — page titles,
  // block text, bullet items, all of which become shapes — still gets the 400+ character treatment
  // above. Lengthening this one field tests the packaging format, not the geometry.
  substituted.meta.title = '치환된 제목';
  const subDeck = writeJson('e1b-sub.json', substituted);
  const subNode = tmp('e1b-sub-node.pptx');
  const subPy = tmp('e1b-sub-python.pptx');
  runNode(subDeck, subNode);
  runPython(subDeck, subPy);

  const a = normalizePptx(subNode);
  const b = normalizePptx(subPy);

  assert.deepEqual(a.slides.map((slide) => slide.map((s) => s.box)), baseline, 'node moved when the text changed');
  assert.deepEqual(b.slides.map((slide) => slide.map((s) => s.box)), baseline, 'python moved when the text changed');
  assert.deepEqual(b.slides.map((slide) => slide.map((s) => s.text)), a.slides.map((slide) => slide.map((s) => s.text)));
  assert.deepEqual(b.slides.map((slide) => slide.map((s) => s.body)), a.slides.map((slide) => slide.map((s) => s.body)));

  // And the builders still agree with layout(), which is the tier-1 statement of the same rule.
  assert.deepEqual(a.slides.map((slide) => slide.map((s) => [s.box.x, s.box.y, s.box.cx, s.box.cy])), coordsOf(B.layout(substituted)));
});
