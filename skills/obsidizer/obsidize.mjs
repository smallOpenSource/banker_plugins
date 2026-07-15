#!/usr/bin/env node
/*
 * obsidizer canonicalizer: markdown -> canonical markdown, zero per-page input.
 *
 * Byte-deterministic and idempotent by construction: a 2nd run is a no-op.
 * Pure filesystem, zero deps, node >=16.7. The LLM makes the semantic edits
 * (which mentions to link, which backlinks are genuine) BEFORE this runs; this
 * file only makes the result canonical. It never calls a wiki_* tool.
 *
 * Write discipline (PM-7), inherited by both entry points (bare run and the
 * --enable hook): an unchanged page is never written at all; a changed one is
 * re-read immediately before writing and SKIPPED if it moved under us (CAS),
 * then written temp-file + rename. A torn read makes a page vanish from OMC's
 * index.md; a lost update silently eats a concurrent wiki_ingest merge.
 *
 * Usage: node obsidize.mjs <path> [--profile=auto|omc|generic] [--dry-run] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESERVED_FILES = new Set(['index.md', 'log.md', 'environment.md']);
const FM_KEYS = ['title', 'tags', 'created', 'updated', 'sources', 'links', 'category', 'confidence', 'schemaVersion'];
const SCHEMA_VERSION = 1;
const FOOTER_CAP = 12;
const FOOTER_PREFIX = '관련: ';
const FOOTER_SEP = ' · ';
// mergePage appends `\n\n---\n\n## Update (<ts>)\n\n...`; everything from here on is preserve-only.
const UPDATE_BOUNDARY = /\n\n---\n\n## Update \(/;
const TMP_SUFFIX = '.obsidizer.tmp';

/**
 * Slug-ish normalizer for the alias divergence test. Deliberately WITHOUT
 * titleToSlug's 64-char cap: the cap is an OMC filename artifact, and mirroring
 * it here would suppress the alias that restores a cap-truncated title.
 */
export function norm(x) {
  return String(x).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Escape a string for use inside YAML double quotes (mirrors OMC escapeYaml). */
function escapeYaml(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function unescapeYaml(s) {
  return s.replace(/\\(\\|"|n|r)/g, (_, ch) => (ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch));
}

/** Line-based `key: value` parse, mirroring OMC parseSimpleYaml (a line with no `:` is skipped). */
function parseSimpleYaml(yaml) {
  const map = {};
  const order = [];
  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    if (!key) continue;
    let value = line.slice(colonIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = unescapeYaml(value.slice(1, -1));
    }
    if (!(key in map)) order.push(key);
    map[key] = value;
  }
  return { map, order };
}

/** Parse a FLOW YAML array `[a, b]` (mirrors OMC parseYamlArray — flow form only). */
function parseYamlArray(value) {
  if (!value) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',')
      .map((s) => unescapeYaml(s.trim().replace(/^["']|["']$/g, '')))
      .filter(Boolean);
  }
  return trimmed ? [trimmed] : [];
}

/**
 * Split a `---\n...\n---\n` frontmatter block off the body.
 * Returns null when the note has no frontmatter block (we never create one).
 */
export function parseFrontmatter(raw) {
  const normalized = String(raw).replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  const { map, order } = parseSimpleYaml(match[1]);
  return { yaml: match[1], lines: match[1].split('\n'), map, order, body: match[2] };
}

/** The 9 OMC keys, parsed. Returns null unless every key is present — we never fabricate one. */
export function parseOmcFrontmatter(map) {
  if (!FM_KEYS.every((k) => k in map)) return null;
  return {
    title: String(map.title || ''),
    tags: parseYamlArray(map.tags),
    created: String(map.created || ''),
    updated: String(map.updated || ''),
    sources: parseYamlArray(map.sources),
    links: parseYamlArray(map.links),
    category: String(map.category || 'reference'),
    confidence: String(map.confidence || 'medium'),
    schemaVersion: Number(map.schemaVersion) || SCHEMA_VERSION,
  };
}

/** Emit EXACTLY the 9 keys in OMC's order (mirrors serializePage). Never add, drop, or reorder. */
export function serializeFrontmatter(fm) {
  return [
    `title: "${escapeYaml(fm.title)}"`,
    `tags: [${fm.tags.map((t) => `"${escapeYaml(t)}"`).join(', ')}]`,
    `created: ${fm.created}`,
    `updated: ${fm.updated}`,
    `sources: [${fm.sources.map((s) => `"${escapeYaml(s)}"`).join(', ')}]`,
    `links: [${fm.links.map((l) => `"${escapeYaml(l)}"`).join(', ')}]`,
    `category: ${fm.category}`,
    `confidence: ${fm.confidence}`,
    `schemaVersion: ${fm.schemaVersion}`,
  ].join('\n');
}

/** Walk lines tracking fenced-code state, so ``` blocks are never mistaken for prose. */
function walkOutsideFences(text, visit) {
  let fence = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (m) {
      const ch = m[1][0];
      if (!fence) fence = ch;
      else if (fence === ch) fence = null;
      visit(line, true);
      continue;
    }
    visit(line, fence !== null);
  }
}

/** H1 texts, ignoring `#` lines inside code fences. */
export function findH1s(body) {
  const out = [];
  walkOutsideFences(body, (line, inFence) => {
    if (inFence) return;
    const m = line.match(/^# (.+)$/);
    if (m) out.push(m[1].trim());
  });
  return out;
}

/** Collapse runs of 3+ blank lines to 2, outside fences only. */
function collapseBlankLines(text) {
  const out = [];
  let blanks = 0;
  walkOutsideFences(text, (line, inFence) => {
    if (!inFence && line.trim() === '') {
      blanks += 1;
      if (blanks > 2) return;
    } else {
      blanks = 0;
    }
    out.push(line);
  });
  return out.join('\n');
}

/** A trailing `관련: [[a]] · [[b]]` line — the vault's existing footer convention. */
function isFooterLine(line) {
  return /^관련:\s*\[\[/.test(line);
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Render the Related footer from the resolvable subset of links[] — bare [[slug]]
 * form only (D8: OMC's extractWikiLinks slugifies any inner text, so a piped or
 * heading form mints a phantom slug into links[]).
 */
function renderFooter(links, basenames) {
  const slugs = [...new Set(links.filter((l) => basenames.has(l)).map((l) => l.replace(/\.md$/, '')))]
    .sort(byCodeUnit)
    .slice(0, FOOTER_CAP);
  return slugs.length ? FOOTER_PREFIX + slugs.map((s) => `[[${s}]]`).join(FOOTER_SEP) : null;
}

/** Replace/append the footer at the end of the head region (never inside a `## Update` section). */
function applyFooter(head, footer) {
  const lines = head.split('\n');
  const dropTrailingBlanks = () => { while (lines.length && lines[lines.length - 1].trim() === '') lines.pop(); };
  dropTrailingBlanks();
  if (lines.length && isFooterLine(lines[lines.length - 1])) {
    lines.pop();
    dropTrailingBlanks();
  }
  if (footer) lines.push('', footer);
  return lines.join('\n');
}

/** tags: strip a leading `#`, dedupe, keep authorial order (plan §3.6: "tags deduped + stable"). */
function normalizeTags(tags) {
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    const tag = String(t).replace(/^#/, '').trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * A dir is OMC-managed when it has index.md AND log.md AND at least one
 * non-reserved page carrying the full 9-key frontmatter signature.
 */
export function detectProfile(target) {
  const dir = fs.statSync(target).isDirectory() ? target : path.dirname(target);
  if (!fs.existsSync(path.join(dir, 'index.md')) || !fs.existsSync(path.join(dir, 'log.md'))) return 'generic';
  for (const f of listMarkdown(dir)) {
    if (RESERVED_FILES.has(f)) continue;
    const fm = parseFrontmatter(read(path.join(dir, f)));
    if (fm && FM_KEYS.every((k) => k in fm.map)) return 'omc';
  }
  return 'generic';
}

const read = (p) => fs.readFileSync(p, 'utf8');

/** Sorted explicitly — readdir order is not deterministic across filesystems. */
function listMarkdown(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.endsWith('.excalidraw.md'))
    .sort(byCodeUnit);
}

/** Slug index + H1 index for the whole vault: alias uniqueness and footer resolvability need both. */
export function buildVaultModel(dir) {
  const files = listMarkdown(dir);
  const basenames = new Set(files);
  const pages = new Map();
  const h1Counts = new Map();
  for (const file of files) {
    const raw = read(path.join(dir, file));
    const fm = parseFrontmatter(raw);
    const h1s = findH1s(fm ? fm.body : raw);
    pages.set(file, { file, base: file.replace(/\.md$/, ''), raw, fm, h1s });
    for (const h1 of h1s) h1Counts.set(h1, (h1Counts.get(h1) || 0) + 1);
  }
  return { dir, files, basenames, pages, h1Counts };
}

/**
 * Which notes get `aliases: ["<H1>"]` — generic profile only, all six conditions.
 * The value is the note's own H1, byte for byte; it is never invented.
 */
export function computeAliases(model, profile) {
  const out = new Map();
  if (profile !== 'generic') return out; // (a)
  for (const page of model.pages.values()) {
    if (!page.fm || page.h1s.length !== 1) continue; // (b)
    const h1 = page.h1s[0];
    if (norm(h1) === norm(page.base)) continue; // (c)
    const others = [...model.pages.values()].filter((p) => p.file !== page.file);
    if (others.some((p) => p.base === norm(h1))) continue; // (d)
    if ((model.h1Counts.get(h1) || 0) > 1) continue; // (e)
    if (page.fm.order.some((k) => k.toLowerCase() === 'aliases')) continue; // (f)
    out.set(page.file, h1);
  }
  return out;
}

/**
 * markdown -> canonical markdown. Pure: no clock unless `now` is passed, and
 * `now` is only consumed when the content actually changed (§3.6).
 */
export function canonicalizeText(raw, { profile, model, alias = null, now = null } = {}) {
  const source = String(raw).replace(/\r\n/g, '\n');
  const fm = parseFrontmatter(source);
  if (!fm) return { text: source, changed: source !== String(raw), skipped: 'no-frontmatter' };

  const basenames = model && model.basenames ? model.basenames : new Set();
  let out;

  if (profile === 'omc') {
    const omc = parseOmcFrontmatter(fm.map);
    if (!omc) return { text: source, changed: source !== String(raw), skipped: 'not-9-key' };
    omc.tags = normalizeTags(omc.tags);
    omc.links = [...new Set(omc.links)].sort(byCodeUnit);
    const body = canonicalizeBody(fm.body, renderFooter(omc.links, basenames));
    out = `---\n${serializeFrontmatter(omc)}\n---\n${body}`;
    if (now && out !== source) {
      omc.updated = now;
      out = `---\n${serializeFrontmatter(omc)}\n---\n${body}`;
    }
  } else {
    // Generic: existing keys and their order are preserved verbatim; `aliases` is
    // the only permitted addition, appended last, always double-quoted, FLOW form.
    const lines = fm.lines.slice();
    if (alias) lines.push(`aliases: ["${escapeYaml(alias)}"]`);
    const body = canonicalizeBody(fm.body, null);
    out = `---\n${lines.join('\n')}\n---\n${body}`;
  }

  return { text: out, changed: out !== String(raw), skipped: null };
}

/** Head region is canonicalized; a `## Update (<ts>)` section is copied through byte for byte. */
function canonicalizeBody(body, footer) {
  const m = body.match(UPDATE_BOUNDARY);
  const head = m ? body.slice(0, m.index) : body;
  const tail = m ? body.slice(m.index) : '';
  let out = collapseBlankLines(head);
  if (footer !== null) out = applyFooter(out, footer);
  return `${out}${tail}`.replace(/\s+$/, '') + '\n';
}

/** temp file + rename — never a partial in-place write (PM-7). */
function writeAtomic(file, text) {
  const tmp = file + TMP_SUFFIX;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

/**
 * Read-back CAS, then atomic write (PM-7). `baseline` is the exact bytes the
 * canonical text was computed from; if the file no longer matches, another writer
 * (a concurrent wiki_ingest merging a `## Update` section) touched it since we
 * read it, so writing would silently clobber that merge. Skip instead — the next
 * run converges the page to identical bytes (one canonicalizer, one fixed point).
 *
 * Deliberately no dependency on OMC's .wiki-lock: borrowing another plugin's
 * internal lock breaks the day it is renamed (§6.2 / ADR-c). CAS + atomic write
 * is the zero-coupling equivalent.
 *
 * Returns false when the write was skipped.
 */
function writeIfUnchanged(file, baseline, text) {
  let current;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    return false; // deleted mid-run; nothing of ours to preserve
  }
  if (current !== baseline) return false;
  writeAtomic(file, text);
  return true;
}

export function run(target, { profile = 'auto', dryRun = false, now = null } = {}) {
  if (!fs.existsSync(target)) throw new Error(`path not found: ${target}`);
  const isFile = fs.statSync(target).isFile();
  const dir = isFile ? path.dirname(target) : target;
  const resolved = profile === 'auto' ? detectProfile(target) : profile;
  const model = buildVaultModel(dir);
  const aliases = computeAliases(model, resolved);
  const stamp = now || new Date().toISOString();

  const targets = isFile ? [path.basename(target)] : model.files;
  const report = { profile: resolved, root: dir, dryRun, scanned: 0, changed: [], unchanged: 0, skipped: [], aliasesAdded: 0 };

  for (const file of targets) {
    const page = model.pages.get(file);
    if (!page) throw new Error(`not a markdown file in ${dir}: ${file}`);
    if (resolved === 'omc' && RESERVED_FILES.has(file)) {
      report.skipped.push({ file, reason: 'reserved' });
      continue;
    }
    report.scanned += 1;
    const alias = aliases.get(file) || null;
    const res = canonicalizeText(page.raw, { profile: resolved, model, alias, now: stamp });
    if (res.skipped) {
      report.skipped.push({ file, reason: res.skipped });
      continue;
    }
    if (!res.changed) {
      report.unchanged += 1;
      continue;
    }
    if (!dryRun && !writeIfUnchanged(path.join(dir, file), page.raw, res.text)) {
      report.skipped.push({ file, reason: 'changed concurrently' });
      continue;
    }
    report.changed.push(file);
    if (alias) report.aliasesAdded += 1;
  }
  return report;
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flag = (name) => argv.includes(`--${name}`);
  const opt = (name, def) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
  };
  if (args.length !== 1) {
    console.error('usage: obsidize.mjs <path> [--profile=auto|omc|generic] [--dry-run] [--json]');
    return 2;
  }
  const profile = opt('profile', 'auto');
  if (!['auto', 'omc', 'generic'].includes(profile)) {
    console.error(`unknown profile: ${profile}`);
    return 2;
  }
  const report = run(path.resolve(args[0]), { profile, dryRun: flag('dry-run') });
  if (flag('json')) {
    console.log(JSON.stringify(report));
  } else {
    const tag = report.dryRun ? ' (dry-run)' : '';
    console.log(`profile: ${report.profile}${tag}`);
    console.log(`scanned: ${report.scanned} · changed: ${report.changed.length} · unchanged: ${report.unchanged} · aliases: ${report.aliasesAdded} · skipped: ${report.skipped.length}`);
    for (const f of report.changed) console.log(`  changed  ${f}`);
    for (const s of report.skipped) console.log(`  skipped  ${s.file} (${s.reason})`);
  }
  return 0;
}

// fileURLToPath, not URL.pathname: the latter yields "/C:/..." on Windows and never matches argv[1].
const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`obsidize: ${err.message}`);
    process.exit(1);
  }
}
