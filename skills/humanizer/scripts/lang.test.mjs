// lang.test.mjs: language detection for the humanizer seats' criteria. Run: node --test scripts/lang.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { detectLanguage, latinLang, prose, runs } from './lang.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'humanizer-lang-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const CLI = fileURLToPath(new URL('./lang.mjs', import.meta.url));
const pick = (t) => { const r = detectLanguage(t); return [r.lang, r.criteria, r.mixed]; };

test('Korean with English terms, code and URLs is Korean, judged by the Korean criteria', () => {
  const t = '이 기능은 API 와 CLI 를 통해 설치되어진다. `npm install -g some-package-name` 와 https://example.com/very/long/english/path 를 본다.\n```\nconst english = "code is left out";\n```\n';
  assert.deepEqual(pick(t), ['ko', 'ko', false]);
  assert.equal(detectLanguage(t).name, '한국어');
});

test('English, German, French, Spanish by their function words; other Latin text is und-Latn', () => {
  assert.deepEqual(pick('This tool serves as a testament to the evolving landscape of software, and it is fast.'), ['en', 'en', false]);
  assert.deepEqual(pick('Dieses Werkzeug ist nicht nur schnell, es ist auch ein Zeugnis für die Entwicklung der Software.'), ['de', 'general', false]);
  assert.deepEqual(pick("Cet outil est un témoignage de l'évolution du logiciel et il est rapide pour les utilisateurs."), ['fr', 'general', false]);
  assert.deepEqual(pick('Esta herramienta es un testimonio de la evolución del software y es rápida para los usuarios.'), ['es', 'general', false]);
  assert.equal(latinLang(['Xyzzy', 'plugh']), 'und-Latn');
});

test('scripts with one language each: Japanese (Kana with Kanji), Chinese, Russian, Ukrainian, Greek, Arabic, Persian', () => {
  assert.deepEqual(pick('今日はとても良い天気です。散歩に行きましょう。'), ['ja', 'general', false]);
  assert.deepEqual(pick('这个工具非常快，它改变了软件开发的方式。'), ['zh', 'general', false]);
  assert.equal(detectLanguage('Этот инструмент очень быстрый и полезный.').lang, 'ru');
  assert.equal(detectLanguage('Цей інструмент дуже швидкий і корисний.').lang, 'uk');
  assert.equal(detectLanguage('Αυτό το εργαλείο είναι πολύ γρήγορο.').lang, 'el');
  assert.equal(detectLanguage('هذه الأداة سريعة جدا ومفيدة.').lang, 'ar');
  assert.equal(detectLanguage('این ابزار بسیار سریع و مفید است و چند کار را انجام داد.').lang, 'fa');
});

test('Hanja in a Korean text stays Korean; half Korean and half English is mixed', () => {
  assert.deepEqual(pick('이 문서는 大韓民國 의 역사를 다룬다. 그리고 많은 사람이 읽는다.'), ['ko', 'ko', false]);
  const mixed = detectLanguage('이 문단은 한국어로 씁니다. 다음 문단도 한국어입니다.\nThis paragraph is in English and so is the rest of the text here.');
  assert.equal(mixed.mixed, true);
  assert.ok(mixed.shares.ko > 0 && mixed.shares.en > 0);
});

test('no letters: und with the general criteria; prose() drops fences, inline code and URLs', () => {
  assert.deepEqual(detectLanguage('123 456 !!!'), { lang: 'und', name: '', criteria: 'general', mixed: false, shares: {} });
  assert.equal(prose('a `b` https://c.d/e\n```\nf\n```\ng').replace(/\s+/g, ' ').trim(), 'a g');
  assert.deepEqual(runs('ab 가나').map((r) => r.script), ['Latin', 'Hangul']);
});

test('CLI prints one JSON line; usage and file errors exit 2', () => {
  const f = join(TMP, 'en.md');
  writeFileSync(f, 'This is the text of the file and it is in English.\n');
  const r = spawnSync(process.execPath, [CLI, f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).lang, 'en');
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status, 2);
  const bad = join(TMP, 'cp949.md');
  writeFileSync(bad, Buffer.from([0xb0, 0xa1, 0xb3, 0xaa]));
  const e = spawnSync(process.execPath, [CLI, bad], { encoding: 'utf8' });
  assert.equal(e.status, 2);
  assert.match(e.stderr, /is not UTF-8/);
});
