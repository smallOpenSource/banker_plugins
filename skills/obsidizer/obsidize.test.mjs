#!/usr/bin/env node
/*
 * Unit tests for the obsidize canonicalizer. Run: `node --test skills/obsidizer/`
 * Zero deps: node:test + node:assert only.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  norm, detectProfile, parseFrontmatter, serializeFrontmatter, parseOmcFrontmatter,
  canonicalizeText, buildVaultModel, computeAliases, findH1s, run,
} from './obsidize.mjs';

const FM_KEYS = ['title', 'tags', 'created', 'updated', 'sources', 'links', 'category', 'confidence', 'schemaVersion'];
const TS = '2026-01-01T00:00:00.000Z';
const NOW = '2026-07-15T12:00:00.000Z';

const omcPage = (o = {}) => [
  '---',
  `title: "${o.title || 'My Note'}"`,
  `tags: [${(o.tags || []).map((t) => `"${t}"`).join(', ')}]`,
  `created: ${TS}`,
  `updated: ${TS}`,
  'sources: []',
  `links: [${(o.links || []).map((l) => `"${l}"`).join(', ')}]`,
  'category: reference',
  'confidence: medium',
  'schemaVersion: 1',
  '---',
  '',
  `# ${o.title || 'My Note'}`,
  '',
  o.body || 'Body text.',
  '',
].join('\n');

/** Frontmatter key order as it appears in the emitted text. */
const keyOrder = (text) => parseFrontmatter(text).order;

const vaults = [];
after(() => { for (const dir of vaults) fs.rmSync(dir, { recursive: true, force: true }); });

function makeVault(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obz-'));
  vaults.push(dir);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const emptyModel = { basenames: new Set() };

test('norm has no 64-char cap (unlike titleToSlug)', () => {
  const h1 = 'Claude Code Context Usage Signals And Compaction Automation Ceiling';
  assert.equal(norm(h1), 'claude-code-context-usage-signals-and-compaction-automation-ceiling');
  assert.equal(norm(h1).length, 67);
  assert.equal(norm('# My Note!'), 'my-note');
});

test('OMC profile: 9-key round-trip adds/drops/reorders nothing', () => {
  const raw = omcPage({ tags: ['a'] });
  const { text } = canonicalizeText(raw, { profile: 'omc', model: emptyModel });
  assert.deepEqual(keyOrder(text), FM_KEYS);
  assert.equal(text, raw, 'an already-canonical page is byte-unchanged');
});

test('OMC profile: scrambled key order is restored to OMC order, aliases never written', () => {
  const raw = [
    '---', 'schemaVersion: 1', 'confidence: medium', 'category: reference',
    'links: []', 'sources: []', `updated: ${TS}`, `created: ${TS}`,
    'tags: ["x"]', 'title: "My Note"', 'aliases: ["Nope"]', 'cssclasses: ["wide"]',
    '---', '', '# My Note', '', 'Body.', '',
  ].join('\n');
  const { text } = canonicalizeText(raw, { profile: 'omc', model: emptyModel });
  assert.deepEqual(keyOrder(text), FM_KEYS);
  assert.ok(!/^aliases:/m.test(text), 'aliases is never written in the OMC profile (PM-1)');
  assert.ok(!/^cssclasses:/m.test(text), 'cssclasses is never written');
});

test('OMC profile: a page missing a 9-key is skipped, not fabricated', () => {
  const raw = ['---', 'title: "X"', 'tags: []', '---', '', '# X', ''].join('\n');
  const res = canonicalizeText(raw, { profile: 'omc', model: emptyModel });
  assert.equal(res.skipped, 'not-9-key');
  assert.equal(res.changed, false);
});

test('tags: strip leading #, dedupe, keep authorial order, do not over-strip Unicode', () => {
  const raw = omcPage({ tags: ['#project', 'project', 'zebra', '감사🔥', 'a/b', 'under_score'] });
  const { text } = canonicalizeText(raw, { profile: 'omc', model: emptyModel });
  const tags = parseOmcFrontmatter(parseFrontmatter(text).map).tags;
  assert.deepEqual(tags, ['project', 'zebra', '감사🔥', 'a/b', 'under_score']);
});

test('links[]: sorted + deduped', () => {
  const raw = omcPage({ links: ['b.md', 'a.md', 'b.md', 'C.md'] });
  const { text } = canonicalizeText(raw, { profile: 'omc', model: emptyModel });
  const links = parseOmcFrontmatter(parseFrontmatter(text).map).links;
  assert.deepEqual(links, ['C.md', 'a.md', 'b.md']);
});

test('Related footer: rendered from the resolvable subset of links[], bare form, sorted', () => {
  const model = { basenames: new Set(['a.md', 'b.md']) };
  const raw = omcPage({ links: ['b.md', 'a.md', 'ghost.md'] });
  const { text } = canonicalizeText(raw, { profile: 'omc', model });
  assert.ok(text.endsWith('관련: [[a]] · [[b]]\n'), `footer: ${JSON.stringify(text.slice(-40))}`);
  assert.ok(!text.includes('[[ghost]]'), 'unresolvable links are not rendered');
  assert.ok(!/\[\[[^\]]*[|#]/.test(text), 'bare form only — no piped or heading wikilinks (D8)');
});

test('Related footer: an existing footer is normalized in place, not duplicated', () => {
  const model = { basenames: new Set(['a.md', 'b.md']) };
  const raw = omcPage({ links: ['a.md', 'b.md'], body: 'Body text.\n\n관련: [[b]] · [[a]].' });
  const { text } = canonicalizeText(raw, { profile: 'omc', model });
  assert.equal(text.match(/^관련:/gm).length, 1);
  assert.ok(text.endsWith('관련: [[a]] · [[b]]\n'));
});

// The five tests above all feed `footer ⊆ links[]`, which is the only shape OMC itself can
// produce (it derives links[] via extractWikiLinks(content)). Every test below starts from
// the shape OMC cannot produce and a human can: a footer link that never entered links[].

test('Related footer: a footer link absent from links[] survives, and is absorbed into links[]', () => {
  const model = { basenames: new Set(['a.md', 'b.md', 'c.md']) };
  const raw = omcPage({ links: ['b.md'], body: 'Body text.\n\n관련: [[b]] · [[c]]' });
  const { text } = canonicalizeText(raw, { profile: 'omc', model });

  assert.ok(text.endsWith('관련: [[b]] · [[c]]\n'),
    `c.md is on disk, so [[c]] is not broken and must not be deleted: ${JSON.stringify(text.slice(-40))}`);
  assert.deepEqual(parseOmcFrontmatter(parseFrontmatter(text).map).links, ['b.md', 'c.md'],
    'the edge is absorbed into links[] — the durable half of the graph');

  const second = canonicalizeText(text, { profile: 'omc', model });
  assert.equal(second.text, text, 'run 2 finds the absorbed link already present — still a fixed point');
  assert.equal(second.changed, false);
});

test('Related footer: an unresolvable footer link is dropped, never absorbed as a phantom', () => {
  const model = { basenames: new Set(['a.md']) };
  const raw = omcPage({ links: ['a.md'], body: 'Body text.\n\n관련: [[a]] · [[ghost]]' });
  const { text } = canonicalizeText(raw, { profile: 'omc', model });

  assert.ok(text.endsWith('관련: [[a]]\n'));
  assert.deepEqual(parseOmcFrontmatter(parseFrontmatter(text).map).links, ['a.md'],
    'ghost.md is not on disk — absorbing it would mint the broken ref PM-4 is about');
});

// --- FOOTER_CAP: a growth bound, never a deletion ----------------------------

/** n on-disk pages named so that code-unit order is readable: p-01 … p-20. */
const capVault = (n) => {
  const slugs = Array.from({ length: n }, (_, i) => `p-${String(i + 1).padStart(2, '0')}`);
  return { slugs, model: { basenames: new Set(slugs.map((s) => `${s}.md`)) } };
};
const footerOf = (text) => text.match(/^관련: .*$/m)[0];
const footerSlugsOf = (text) => [...footerOf(text).matchAll(/\[\[([^\]]+)\]\]/g)].map(([, s]) => s);

test('FOOTER_CAP: a hand-written footer over the cap keeps every link — the cap never deletes', () => {
  const { slugs, model } = capVault(15);
  const raw = omcPage({ links: [], body: `Body text.\n\n관련: ${slugs.map((s) => `[[${s}]]`).join(' · ')}` });
  const { text } = canonicalizeText(raw, { profile: 'omc', model });

  assert.deepEqual(footerSlugsOf(text), slugs,
    'all 15 are on-disk bare slugs, so not one is broken or phantom-minting — the cap is no licence to drop them');
  assert.deepEqual(parseOmcFrontmatter(parseFrontmatter(text).map).links, slugs.map((s) => `${s}.md`).sort(),
    'and the union still absorbs every one of them into links[]');

  const second = canonicalizeText(text, { profile: 'omc', model });
  assert.equal(second.text, text, 'run 2 reads the 15 as already present, adds nothing, re-renders the same bytes');
  assert.equal(second.changed, false);
});

test('FOOTER_CAP: the cap still bounds what obsidizer adds to a footer on its own', () => {
  const { slugs, model } = capVault(20);
  const raw = omcPage({ links: slugs.map((s) => `${s}.md`), body: 'Body text.' });
  const { text } = canonicalizeText(raw, { profile: 'omc', model });

  assert.deepEqual(footerSlugsOf(text), slugs.slice(0, 12),
    'nothing was in the footer to keep, so the cap bounds the render at 12 — deterministically, in code-unit order');
  assert.equal(parseOmcFrontmatter(parseFrontmatter(text).map).links.length, 20,
    'links[] still carries all 20 — the cap is a budget for the rendered footer, not for the graph');
  assert.equal(canonicalizeText(text, { profile: 'omc', model }).text, text, 'still a fixed point');
});

test('FOOTER_CAP: a footer under the cap is topped up only to the cap, and keeps what it had', () => {
  const { slugs, model } = capVault(20);
  const had = ['p-19', 'p-20']; // last in code-unit order: a truncating cap would never have picked them
  const raw = omcPage({ links: slugs.map((s) => `${s}.md`), body: `Body text.\n\n관련: ${had.map((s) => `[[${s}]]`).join(' · ')}` });
  const { text } = canonicalizeText(raw, { profile: 'omc', model });

  const rendered = footerSlugsOf(text);
  assert.equal(rendered.length, 12, 'kept 2 + added 10 = the cap');
  assert.ok(had.every((s) => rendered.includes(s)), `the two it already had survive: ${rendered.join(',')}`);
  assert.deepEqual(rendered, [...slugs.slice(0, 10), ...had], 'sorted as one set, so the output is order-independent');
  assert.equal(canonicalizeText(text, { profile: 'omc', model }).text, text, 'still a fixed point');
});

test('FOOTER_CAP: keeping an over-cap footer never resurrects a broken or non-bare link', () => {
  // The cap stops being a deletion path; the other two must NOT stop being ones.
  const { slugs, model } = capVault(15);
  model.basenames.add('Weird Name.md');
  const body = `Body text.\n\n관련: ${slugs.map((s) => `[[${s}]]`).join(' · ')} · [[ghost]] · [[Weird Name]]`;
  const { text } = canonicalizeText(omcPage({ links: [], body }), { profile: 'omc', model });

  assert.deepEqual(footerSlugsOf(text), slugs, 'the 15 resolvable bare slugs, and only those');
  assert.ok(!text.includes('[[ghost]]'), 'a broken ref is still dropped, over the cap or not');
  assert.ok(!text.includes('[[Weird Name]]'), 'a non-bare slug is still not emitted (D8)');
});

test('links[]: resolvable body links are absorbed; fenced ones are not', () => {
  const model = { basenames: new Set(['a.md', 'b.md']) };
  const raw = omcPage({ links: [], body: 'Prose mentioning [[a]].\n\n```md\n[[b]]\n```' });
  const { text } = canonicalizeText(raw, { profile: 'omc', model });

  assert.deepEqual(parseOmcFrontmatter(parseFrontmatter(text).map).links, ['a.md'],
    'Obsidian renders a fenced [[b]] literally and puts no edge in the graph');
});

test('links[]: a piped or heading body link is absorbed by its target, and re-emitted bare', () => {
  const model = { basenames: new Set(['a.md', 'b.md']) };
  const raw = omcPage({ links: [], body: 'See [[a|Alpha]] and [[b#Section]].' });
  const { text } = canonicalizeText(raw, { profile: 'omc', model });

  assert.deepEqual(parseOmcFrontmatter(parseFrontmatter(text).map).links, ['a.md', 'b.md'],
    'both point at a real page — the edge is real even though the form is one we never emit');
  assert.ok(text.endsWith('관련: [[a]] · [[b]]\n'), 'read liberally, write strictly (D8)');
});

test('D8 whitelist: a links[] slug that is not bare form is never emitted as [[…]]', () => {
  // Unreachable through OMC — titleToSlug cannot emit any of these — which is the whole
  // point of a positive whitelist: it is closed against forms nobody has enumerated.
  const model = { basenames: new Set(['a.md', 'Weird Name.md', 'b|piped.md', '-lead.md']) };
  const raw = omcPage({ links: ['a.md', 'Weird Name.md', 'b|piped.md', '-lead.md'] });
  const { text } = canonicalizeText(raw, { profile: 'omc', model });

  assert.ok(text.endsWith('관련: [[a]]\n'), `only the bare slug is emitted: ${JSON.stringify(text.slice(-40))}`);
  assert.ok(!/\[\[[^\]]*[|#\s]/.test(text), 'no emitted wikilink can be slugified into a phantom');
  assert.deepEqual(parseOmcFrontmatter(parseFrontmatter(text).map).links,
    ['-lead.md', 'Weird Name.md', 'a.md', 'b|piped.md'],
    'the whitelist gates emission, not the graph — their edges stay in links[]');
});

test('generic profile: existing keys and order preserved verbatim', () => {
  const raw = ['---', 'zeta: 1', "title: 'single quoted'", 'alpha: [x, y]', '---', '', '# H', '', 'Body.', ''].join('\n');
  const { text } = canonicalizeText(raw, { profile: 'generic', model: emptyModel });
  assert.deepEqual(keyOrder(text), ['zeta', 'title', 'alpha']);
  assert.ok(text.includes("title: 'single quoted'"), 'generic frontmatter is passed through byte for byte');
});

test('generic profile: the footer is left exactly as written — it is never re-rendered', () => {
  // links[] is an OMC key, so there is nothing to render a footer FROM here. Leaving the
  // line alone is what makes "broken-ref removal" an OMC-profile event only.
  const raw = ['---', 'title: t', '---', '', '# H', '', 'Body.', '', '관련: [[zzz]] · [[aaa]] · [[ghost]]', ''].join('\n');
  const { text, changed } = canonicalizeText(raw, { profile: 'generic', model: { basenames: new Set(['aaa.md', 'zzz.md']) } });
  assert.equal(changed, false);
  assert.ok(text.endsWith('관련: [[zzz]] · [[aaa]] · [[ghost]]\n'), 'not sorted, not de-ghosted, not touched');
});

test('generic profile: no frontmatter block is created where none existed', () => {
  const raw = '# Just A Heading\n\nBody.\n';
  const res = canonicalizeText(raw, { profile: 'generic', model: emptyModel });
  assert.equal(res.skipped, 'no-frontmatter');
  assert.ok(!res.text.startsWith('---'));
  assert.equal(res.text, raw);
});

// --- alias 6-condition table -------------------------------------------------

const aliasVault = (files) => {
  const dir = makeVault(files);
  const model = buildVaultModel(dir);
  return { dir, aliases: computeAliases(model, 'generic') };
};

const genericNote = (h1, extraKeys = '') =>
  ['---', 'title: t', ...(extraKeys ? [extraKeys] : []), '---', '', `# ${h1}`, '', 'Body.', ''].join('\n');

test('alias (c): the live 64-cap case gets an alias — norm() has no cap so H1 !== basename', () => {
  const base = 'claude-code-context-usage-signals-and-compaction-automation-ceil';
  assert.equal(base.length, 64, 'the live basename is exactly the 64-char cap');
  const h1 = 'Claude Code Context Usage Signals And Compaction Automation Ceiling';
  const { aliases } = aliasVault({ [`${base}.md`]: genericNote(h1) });
  assert.equal(aliases.get(`${base}.md`), h1, 'the alias restores the cap-truncated title');
});

test('alias (c): no alias when norm(H1) equals norm(basename)', () => {
  const { aliases } = aliasVault({ 'my-note.md': genericNote('My Note') });
  assert.equal(aliases.size, 0);
});

test('alias (b): no frontmatter block, or not exactly one H1 => no alias', () => {
  const noFm = aliasVault({ 'a-note.md': '# Totally Different\n\nBody.\n' });
  assert.equal(noFm.aliases.size, 0, 'no frontmatter block');
  const twoH1 = aliasVault({ 'b-note.md': ['---', 'title: t', '---', '', '# First Title', '', '# Second Title', ''].join('\n') });
  assert.equal(twoH1.aliases.size, 0, 'two H1s');
});

test('alias (d): suppressed when norm(H1) is another note\'s basename', () => {
  const { aliases } = aliasVault({
    'note-one.md': genericNote('Other Note'),
    'other-note.md': genericNote('Something Else Entirely'),
  });
  assert.equal(aliases.has('note-one.md'), false, 'an alias must not shadow a real file');
  assert.equal(aliases.get('other-note.md'), 'Something Else Entirely');
});

test('alias (e): suppressed when the H1 text collides with another note\'s H1', () => {
  const { aliases } = aliasVault({
    'session-log-2026-07-15-aaaaaaaa.md': genericNote('Session Log 2026-07-15'),
    'session-log-2026-07-15-bbbbbbbb.md': genericNote('Session Log 2026-07-15'),
  });
  assert.equal(aliases.size, 0, 'an N-way alias collision is suppressed');
});

test('alias (f): a pre-existing aliases key is left untouched', () => {
  const files = { 'some-note.md': genericNote('A Totally Different Title', 'aliases: ["User Chosen"]') };
  const { dir, aliases } = aliasVault(files);
  assert.equal(aliases.size, 0);
  const before = fs.readFileSync(path.join(dir, 'some-note.md'), 'utf8');
  run(dir, { profile: 'generic', now: NOW });
  assert.equal(fs.readFileSync(path.join(dir, 'some-note.md'), 'utf8'), before, 'user content is never clobbered');
});

test('alias: written FLOW + double-quoted with YAML escaping, appended last, byte-equal to H1', () => {
  const h1 = 'A "Quoted" \\ Title';
  const { text } = canonicalizeText(genericNote(h1), { profile: 'generic', model: emptyModel, alias: h1 });
  assert.ok(text.includes('aliases: ["A \\"Quoted\\" \\\\ Title"]'), `got: ${text.split('\n')[2]}`);
  assert.deepEqual(keyOrder(text), ['title', 'aliases'], 'appended last');
  const roundTripped = parseFrontmatter(text).map.aliases;
  assert.equal(roundTripped, `["${h1.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`, 'value is derived from the H1, never invented');
});

test('alias: not written in the OMC profile (PM-1 envelope)', () => {
  const dir = makeVault({
    'index.md': '# Wiki Index\n',
    'log.md': '# Log\n',
    'a-really-different-slug.md': omcPage({ title: 'Some Completely Other Title' }),
  });
  assert.equal(detectProfile(dir), 'omc');
  assert.equal(computeAliases(buildVaultModel(dir), 'omc').size, 0);
  run(dir, { now: NOW });
  assert.ok(!/^aliases:/m.test(fs.readFileSync(path.join(dir, 'a-really-different-slug.md'), 'utf8')));
});

// --- profile detection -------------------------------------------------------

test('detectProfile: index.md + log.md + 9-key signature => omc; single file uses its parent dir', () => {
  const omc = makeVault({ 'index.md': '# I\n', 'log.md': '# L\n', 'p-one.md': omcPage() });
  assert.equal(detectProfile(omc), 'omc');
  assert.equal(detectProfile(path.join(omc, 'p-one.md')), 'omc', 'a single file detects from its parent');

  assert.equal(detectProfile(makeVault({ 'index.md': '# I\n', 'log.md': '# L\n', 'p.md': genericNote('P') })), 'generic',
    'index+log without the 9-key signature is not an OMC tree');
  assert.equal(detectProfile(makeVault({ 'a.md': omcPage() })), 'generic', 'no index/log => generic');
});

// --- preserve-only -----------------------------------------------------------

test('preserve-only: ## Update sections, body ::, fenced code, .canvas and .excalidraw.md', () => {
  const body = [
    'Body text.',
    '',
    'Status:: In Progress',
    '',
    '```bash',
    '# not an H1',
    '',
    '',
    '',
    'echo hi',
    '```',
    '',
    '관련: [[a]]',
    '',
    '---',
    '',
    `## Update (${TS})`,
    '',
    'Merged content.',
    '',
    '',
    '',
    'After four blank lines.',
  ].join('\n');
  const dir = makeVault({
    'index.md': '# I\n',
    'log.md': '# L\n',
    'a.md': omcPage({ title: 'A' }),
    'p-one.md': omcPage({ title: 'P One', links: ['a.md'], body }),
    'diagram.canvas': '{"nodes":[],"edges":[]}',
    'sketch.excalidraw.md': '# Sketch\n\nnot canonicalized\n',
  });
  const canvasBefore = fs.readFileSync(path.join(dir, 'diagram.canvas'), 'utf8');
  const excaliBefore = fs.readFileSync(path.join(dir, 'sketch.excalidraw.md'), 'utf8');

  run(dir, { now: NOW });
  const out = fs.readFileSync(path.join(dir, 'p-one.md'), 'utf8');

  assert.ok(out.includes(`## Update (${TS})`), 'the Update heading is not reformatted');
  assert.ok(out.includes('Merged content.\n\n\n\nAfter four blank lines.'), 'blank runs inside a ## Update section survive verbatim');
  assert.ok(out.includes('Status:: In Progress'), 'body-inline Key:: Value is never mangled');
  assert.ok(out.includes('```bash\n# not an H1\n\n\n\necho hi\n```'), 'fenced code is never touched');
  assert.equal(fs.readFileSync(path.join(dir, 'diagram.canvas'), 'utf8'), canvasBefore, '.canvas is never rewritten');
  assert.equal(fs.readFileSync(path.join(dir, 'sketch.excalidraw.md'), 'utf8'), excaliBefore, '.excalidraw.md is never touched');

  const headFooter = out.slice(0, out.indexOf('\n\n---\n\n## Update ('));
  assert.ok(headFooter.endsWith('관련: [[a]]'), 'the footer stays in the head region, above the Update section');
  assert.equal(out.match(/^관련:/gm).length, 1, 'no duplicate footer appended after the Update section');
});

test('reserved files are never edited in the OMC profile', () => {
  const dir = makeVault({ 'index.md': '# I\n\n\n\n\nx\n', 'log.md': '# L\n\n\n\n\ny\n', 'environment.md': '# E\n\n\n\n\nz\n', 'p-one.md': omcPage() });
  const before = ['index.md', 'log.md', 'environment.md'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  const report = run(dir, { now: NOW });
  const after = ['index.md', 'log.md', 'environment.md'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  assert.deepEqual(after, before, 'reserved files keep even their 4-blank-line runs');
  assert.equal(report.skipped.filter((s) => s.reason === 'reserved').length, 3);
});

// --- opt-out -----------------------------------------------------------------

test('%%obsidizer:ignore%%: a marked page is skipped entirely, siblings still canonicalized', () => {
  const dir = makeVault({
    'index.md': '# I\n',
    'log.md': '# L\n',
    'p-one.md': omcPage({ tags: ['#x'], body: 'Body.\n\n%%obsidizer:ignore%%' }),
    'q-two.md': omcPage({ title: 'Q Two', tags: ['#y'] }),
  });
  const before = fs.readFileSync(path.join(dir, 'p-one.md'), 'utf8');

  const report = run(dir, { now: NOW });

  assert.equal(fs.readFileSync(path.join(dir, 'p-one.md'), 'utf8'), before,
    'not one byte written — even the #-prefixed tag it would normally normalize is left alone');
  assert.deepEqual(report.skipped.filter((s) => s.reason === 'ignored').map((s) => s.file), ['p-one.md']);
  assert.deepEqual(report.changed, ['q-two.md'], 'the opt-out is per page, not per vault');
});

test('%%obsidizer:ignore%%: honored in the generic profile too — where aliases get written', () => {
  const dir = makeVault({
    'a-really-different-slug.md': `${genericNote('Some Completely Other Title')}\n%%obsidizer:ignore%%\n`,
  });
  const file = path.join(dir, 'a-really-different-slug.md');
  const before = fs.readFileSync(file, 'utf8');

  const report = run(dir, { now: NOW });

  assert.equal(report.profile, 'generic');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'no alias is written into a page that opted out');
  assert.deepEqual(report.skipped.map((s) => s.reason), ['ignored']);
});

// --- timestamps / determinism ------------------------------------------------

test('created is never modified; updated is bumped only when content actually changed', () => {
  const dir = makeVault({ 'index.md': '# I\n', 'log.md': '# L\n', 'p-one.md': omcPage({ tags: ['#dup', 'dup'] }), 'q-two.md': omcPage({ title: 'Q Two' }) });
  run(dir, { now: NOW });
  const changed = parseOmcFrontmatter(parseFrontmatter(fs.readFileSync(path.join(dir, 'p-one.md'), 'utf8')).map);
  const noop = parseOmcFrontmatter(parseFrontmatter(fs.readFileSync(path.join(dir, 'q-two.md'), 'utf8')).map);
  assert.equal(changed.created, TS, 'created is never modified');
  assert.equal(changed.updated, NOW, 'a changed page bumps updated');
  assert.equal(noop.updated, TS, 'a no-op page keeps its updated');
});

test('canonicalizeText is pure without `now` — no wall-clock leaks into content', () => {
  const raw = omcPage({ tags: ['#x'] });
  const a = canonicalizeText(raw, { profile: 'omc', model: emptyModel });
  const b = canonicalizeText(raw, { profile: 'omc', model: emptyModel });
  assert.equal(a.text, b.text);
  assert.ok(a.text.includes(`updated: ${TS}`), 'updated is untouched when no `now` is supplied');
});

test('idempotency: two consecutive runs produce zero byte diff', () => {
  const dir = makeVault({
    'index.md': '# I\n',
    'log.md': '# L\n',
    'a.md': omcPage({ title: 'A', links: ['b.md'] }),
    'b.md': omcPage({ title: 'B', tags: ['#t', 't', '태그🔥'], links: ['a.md', 'a.md'], body: 'x\n\n\n\n\ny' }),
  });
  run(dir, { now: NOW });
  const snap1 = Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  const report2 = run(dir, { now: '2099-12-31T23:59:59.999Z' });
  const snap2 = Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  assert.deepEqual(snap2, snap1, 'run 2 is a byte-for-byte no-op');
  assert.equal(report2.changed.length, 0);
  assert.ok(report2.unchanged > 0);
});

test('dry-run writes nothing', () => {
  const dir = makeVault({ 'index.md': '# I\n', 'log.md': '# L\n', 'p-one.md': omcPage({ tags: ['#x'] }) });
  const before = fs.readFileSync(path.join(dir, 'p-one.md'), 'utf8');
  const report = run(dir, { dryRun: true, now: NOW });
  assert.equal(report.changed.length, 1, 'dry-run still reports the change');
  assert.equal(fs.readFileSync(path.join(dir, 'p-one.md'), 'utf8'), before);
});

// --- atomicity (PM-7) --------------------------------------------------------

test('CAS: a page that changed since it was read is skipped, and the competing merge survives', (t) => {
  const dir = makeVault({ 'index.md': '# I\n', 'log.md': '# L\n', 'p-one.md': omcPage({ tags: ['#x'] }) });
  const file = path.join(dir, 'p-one.md');
  const competing = omcPage({ tags: ['#x'], body: `Body text.\n\n---\n\n## Update (${TS})\n\nA competing wiki_ingest merge.` });

  // Fire once, right after run() reads its CAS baseline: a concurrent writer lands a merge.
  // profile:'omc' skips detectProfile, so the first read of this page IS the baseline read.
  const realRead = fs.readFileSync;
  let armed = true;
  t.mock.method(fs, 'readFileSync', (p, ...rest) => {
    const out = realRead.call(fs, p, ...rest);
    if (armed && String(p) === file) {
      armed = false;
      fs.writeFileSync(file, competing);
    }
    return out;
  });

  const report = run(dir, { profile: 'omc', now: NOW });

  assert.deepEqual(report.changed, [], 'nothing was written');
  assert.deepEqual(report.skipped.filter((s) => s.reason === 'changed concurrently').map((s) => s.file), ['p-one.md']);
  assert.equal(fs.readFileSync(file, 'utf8'), competing, 'the competing ## Update merge survives — our write did not clobber it');
});

test('no-op: an already-canonical page is never written and keeps its updated', (t) => {
  const dir = makeVault({ 'index.md': '# I\n', 'log.md': '# L\n', 'p-one.md': omcPage() });
  const file = path.join(dir, 'p-one.md');
  const before = fs.statSync(file);
  const writeSpy = t.mock.method(fs, 'writeFileSync');
  const renameSpy = t.mock.method(fs, 'renameSync');

  const report = run(dir, { profile: 'omc', now: NOW });

  assert.equal(report.unchanged, 1);
  assert.deepEqual(report.changed, []);
  assert.equal(writeSpy.mock.calls.length, 0, 'no temp file written');
  assert.equal(renameSpy.mock.calls.length, 0, 'no rename');
  const after = fs.statSync(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs, 'mtime untouched — the file was not opened for writing');
  assert.equal(parseOmcFrontmatter(parseFrontmatter(fs.readFileSync(file, 'utf8')).map).updated, TS, 'updated is not bumped');
});

test('atomicity: the write path is temp+rename (new inode) and leaves no .tmp behind', () => {
  const dir = makeVault({ 'index.md': '# I\n', 'log.md': '# L\n', 'p-one.md': omcPage({ tags: ['#x'] }) });
  const file = path.join(dir, 'p-one.md');
  const inoBefore = fs.statSync(file).ino;
  run(dir, { now: NOW });
  assert.notEqual(fs.statSync(file).ino, inoBefore, 'rename swaps the inode — an in-place write would keep it');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.obsidizer.tmp')), [], 'no .tmp survives a successful run');
});

test('write path: a unique wx temp per WRITE, fsynced, staged before the CAS re-read', (t) => {
  const dir = makeVault({ 'index.md': '# I\n', 'log.md': '# L\n', 'p-one.md': omcPage({ tags: ['#x'] }) });
  const file = path.join(dir, 'p-one.md');
  const trace = [];
  const real = { open: fs.openSync, read: fs.readFileSync, fsync: fs.fsyncSync, rename: fs.renameSync };
  t.mock.method(fs, 'openSync', (p, flags, ...rest) => {
    if (String(p).includes('.obsidizer.tmp')) trace.push(['open', String(p), flags]);
    return real.open.call(fs, p, flags, ...rest);
  });
  t.mock.method(fs, 'fsyncSync', (fd) => { trace.push(['fsync', '']); return real.fsync.call(fs, fd); });
  t.mock.method(fs, 'renameSync', (from, to) => { trace.push(['rename', String(from)]); return real.rename.call(fs, from, to); });
  t.mock.method(fs, 'readFileSync', (p, ...rest) => {
    if (String(p) === file) trace.push(['read', String(p)]);
    return real.read.call(fs, p, ...rest);
  });

  // Two writes to ONE page — the collision the fixed shared temp name actually caused.
  // Two different pages would never collide, so staging them proves nothing.
  run(dir, { profile: 'omc', now: NOW });
  fs.writeFileSync(file, omcPage({ tags: ['#x'] })); // re-dirty the same page
  run(dir, { profile: 'omc', now: NOW });

  const temps = trace.filter(([op]) => op === 'open');
  assert.equal(temps.length, 2, 'the same page was staged twice');
  assert.ok(temps.every(([, , flags]) => flags === 'wx'),
    `exclusive create only — a plain open truncates a temp somebody else made (got ${JSON.stringify(temps.map((e) => e[2]))})`);
  assert.equal(new Set(temps.map(([, p]) => p)).size, 2,
    'two writes to ONE page must not share a temp path — a fixed name is exactly what two concurrent obsidizer processes collide on');

  // The whole discipline for one write, in order: read the CAS baseline, stage the temp,
  // fsync it, re-read to check nobody moved under us, publish by rename.
  assert.deepEqual(trace.map(([op]) => op).slice(0, 5), ['read', 'open', 'fsync', 'read', 'rename'],
    'the temp is fully staged and fsynced before the CAS re-read, leaving only the rename inside the race window');
});

test('single-file target canonicalizes only that page', () => {
  const dir = makeVault({ 'index.md': '# I\n', 'log.md': '# L\n', 'p-one.md': omcPage({ tags: ['#x'] }), 'q-two.md': omcPage({ title: 'Q Two', tags: ['#y'] }) });
  const qBefore = fs.readFileSync(path.join(dir, 'q-two.md'), 'utf8');
  const report = run(path.join(dir, 'p-one.md'), { now: NOW });
  assert.equal(report.profile, 'omc');
  assert.deepEqual(report.changed, ['p-one.md']);
  assert.equal(fs.readFileSync(path.join(dir, 'q-two.md'), 'utf8'), qBefore, 'the hook passes one page; siblings are untouched');
});

test('findH1s ignores # lines inside fences', () => {
  assert.deepEqual(findH1s('# Real\n\n```sh\n# fake\n```\n'), ['Real']);
});

test('serializeFrontmatter emits exactly the 9 keys in OMC order', () => {
  const fm = parseOmcFrontmatter(parseFrontmatter(omcPage({ tags: ['a', 'b'] })).map);
  const yaml = serializeFrontmatter(fm);
  assert.deepEqual(yaml.split('\n').map((l) => l.slice(0, l.indexOf(':'))), FM_KEYS);
  assert.ok(yaml.includes('tags: ["a", "b"]'), 'FLOW arrays, double-quoted — OMC parseYamlArray reads flow form only');
});
