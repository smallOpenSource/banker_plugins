#!/usr/bin/env node
// lang.mjs: tells the language of a text, so the humanizer seats review it by that language's criteria.
//
//   node lang.mjs <file>
//
// Prints one JSON object: { lang, name, criteria, mixed, shares }. lang is a BCP 47 code (ko, en, ja, zh, ru, de, ...)
// or und-<script> when only the script is known; criteria is ko (references/criteria-ko.md), en
// (references/patterns-en.md) or general (references/criteria-general.md). Code fences, inline code and URLs are left
// out before counting, and so are paths, --flags and identifiers. Each run of letters of one script counts once (a
// word, or a stretch of Hangul or Han). Latin words whose language the function words do not tell are loanwords of
// the text's other language, so a Korean text full of English terms stays Korean; a short Latin text of ASCII words
// alone is English. mixed is true when a second language has 30% of the runs or more.
// Exit codes: 0 done, 2 usage or file error.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readText } from './apply-fix.mjs';

const SCRIPTS = [
  ['Hangul', /\p{Script=Hangul}/u], ['Kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u], ['Han', /\p{Script=Han}/u],
  ['Latin', /\p{Script=Latin}/u], ['Cyrillic', /\p{Script=Cyrillic}/u], ['Greek', /\p{Script=Greek}/u],
  ['Arabic', /\p{Script=Arabic}/u], ['Hebrew', /\p{Script=Hebrew}/u], ['Devanagari', /\p{Script=Devanagari}/u],
  ['Thai', /\p{Script=Thai}/u],
];
const SCRIPT_LANG = { Hangul: 'ko', Kana: 'ja', Han: 'zh', Greek: 'el', Hebrew: 'he', Devanagari: 'hi', Thai: 'th' };
const STOPWORDS = {
  en: 'the and of to is are was were that this with for not you it be have has on as at by from or',
  de: 'der die das und ist nicht ein eine zu mit den von sich auf für ich es dem des auch wird',
  fr: 'le la les et est des une un du que pas pour dans qui sur au avec ce il sont nous vous',
  es: 'el la los las y es de que en un una por con para no se del al lo como más pero',
  pt: 'o a os as e é de que em um uma do da para com não se por no na mais',
  it: 'il la le e è di che un una per con non del della sono si nel alla anche più',
  nl: 'de het een en is van dat niet op te zijn met voor ook als maar wordt bij',
};
const NAMES = {
  ko: '한국어', en: 'English', ja: '日本語', zh: '中文', ru: 'русский', uk: 'українська', el: 'Ελληνικά', ar: 'العربية',
  fa: 'فارسی', he: 'עברית', hi: 'हिन्दी', th: 'ไทย', de: 'Deutsch', fr: 'français', es: 'español', pt: 'português',
  it: 'italiano', nl: 'Nederlands',
};

/** The text without code fences, inline code, URLs, paths, --flags and identifiers (camelCase, dotted, snake_case,
 * letters with digits): those are code, not the language of the prose. */
export function prose(text) {
  return String(text)
    .replace(/^[ \t]{0,3}(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[^\n]*$|(?![\s\S]))/gm, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(/(?<![\w.~])(?:~|\.{1,2})?\/[\w.~-]+(?:\/[\w.~-]*)*|\b[A-Za-z]:\\\S+/g, ' ')
    .replace(/(?<![\w-])--?[A-Za-z][\w-]*/g, ' ')
    .replace(/\b[A-Za-z0-9]*(?:[a-z][A-Z]|[A-Za-z][._][A-Za-z0-9]|[A-Za-z][0-9]|[0-9][A-Za-z])[\w.]*/g, ' ');
}

const scriptOf = (ch) => (SCRIPTS.find(([, re]) => re.test(ch)) || [''])[0];

/** Runs of letters of one script: [{ script, text }]. */
export function runs(text) {
  const out = [];
  let cur = null;
  for (const ch of prose(text)) {
    const s = scriptOf(ch);
    if (s && cur && cur.script === s) { cur.text += ch; continue; }
    if (cur && cur.script === 'Han' && s === 'Kana') { cur.script = 'Kana'; cur.text += ch; continue; }
    cur = s ? { script: s, text: ch } : null;
    if (cur) out.push(cur);
  }
  return out;
}

/** The language of the Latin-script words by their function words: a code from STOPWORDS, or '' when fewer than two
 * words match (terms and short headlines). */
export function latinLang(words) {
  const lower = words.map((w) => w.toLowerCase());
  let best = '', hits = 1;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list.split(' '));
    const n = lower.filter((w) => set.has(w)).length;
    if (n > hits) { best = lang; hits = n; }
  }
  return best;
}

function langOfScript(script, texts) {
  if (script === 'Latin') return latinLang(texts) || UNSURE;
  const all = texts.join('');
  if (script === 'Cyrillic') return /[іїєґ]/i.test(all) ? 'uk' : 'ru';
  if (script === 'Arabic') return /[پچژگ]/.test(all) ? 'fa' : 'ar';
  return SCRIPT_LANG[script] || `und-${script}`;
}

const UNSURE = '?Latn';

// Latin words no language could be told from are loanwords of the other language of the text (React, hook, state in a
// Korean text); in a text of them alone they are English when every letter is ASCII, else und-Latn.
function placeUnsure(shares, latinWords) {
  const share = shares[UNSURE];
  if (share === undefined) return;
  delete shares[UNSURE];
  const host = Object.entries(shares).filter(([l]) => !l.startsWith('und')).sort((a, b) => b[1] - a[1])[0];
  const to = host ? host[0] : latinWords.every((w) => /^[A-Za-z]+$/.test(w)) ? 'en' : 'und-Latn';
  shares[to] = Math.round(((shares[to] || 0) + share) * 1000) / 1000;
}

/** { lang, name, criteria, mixed, shares } of a text. */
export function detectLanguage(text) {
  const rs = runs(text);
  if (!rs.length) return { lang: 'und', name: '', criteria: 'general', mixed: false, shares: {} };
  const by = new Map();
  for (const r of rs) by.set(r.script, [...(by.get(r.script) || []), r.text]);
  // Han runs in a text with Kana are Japanese; Han in a Korean text is Hanja, part of the Korean.
  for (const host of ['Kana', 'Hangul']) {
    if (!by.has(host) || !by.has('Han')) continue;
    by.set(host, [...by.get(host), ...by.get('Han')]);
    by.delete('Han');
  }
  const shares = {};
  for (const [script, texts] of by) {
    const lang = langOfScript(script, texts);
    shares[lang] = Math.round(((shares[lang] || 0) + texts.length / rs.length) * 1000) / 1000;
  }
  placeUnsure(shares, by.get('Latin') || []);
  const ranked = Object.entries(shares).sort((a, b) => b[1] - a[1]);
  const lang = ranked[0][0];
  const criteria = lang === 'ko' ? 'ko' : lang === 'en' ? 'en' : 'general';
  return { lang, name: NAMES[lang] || '', criteria, mixed: ranked.length > 1 && ranked[1][1] >= 0.3, shares };
}

// real paths on both sides: node runs a script reached through a link (macOS /var is /private/var) by its real path.
// A name realpath cannot read (argv[1] of `node -e`, for one) is compared as given, so importing this file never throws.
const ranAs = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && ranAs(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || argv[0].startsWith('--')) {
    process.stderr.write('usage: node lang.mjs <file>\n');
    process.exit(2);
  }
  try {
    process.stdout.write(JSON.stringify(detectLanguage(readText(resolve(argv[0])))) + '\n');
  } catch (e) {
    process.stderr.write(`lang: ${e.exit ? e.message : `${argv[0]}: ${e.message}`}\n`);
    process.exit(2);
  }
}
