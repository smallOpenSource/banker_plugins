// pm-html.mjs 시험. escape, 색, 유한 수, 글 폭, 줄 나눔, 공통 CSS, 탭 머리, favicon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, attr, color, finite, textW, wrap, CSS, TABS, tabsHtml, FAVICON } from './pm-html.mjs';

const T = { timeout: 60000 };

// 위험 문자열 픽스처
const EVIL = `<script>alert("x")</script>&'onload='`;

test('esc 는 & < > " \' 다섯 문자를 바꿈', T, () => {
  assert.equal(esc('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  const out = esc(EVIL);
  assert.ok(!/[<>"']/.test(out));
  assert.equal(esc(null), '');
  assert.equal(esc(12), '12');
});

test('attr 는 esc 에 더해 줄바꿈과 탭을 문자 참조로', T, () => {
  assert.equal(attr('a"b\nc\td\r'), 'a&quot;b&#10;c&#9;d&#13;');
  assert.ok(!/[<>"'\n\t]/.test(attr(EVIL + '\n')));
});

test('색은 #rrggbb 만 통과, 그 밖은 기본 색', T, () => {
  assert.equal(color('#a1b2c3', '#000000'), '#a1b2c3');
  assert.equal(color('#A1B2C3', '#000000'), '#A1B2C3');
  for (const bad of ['red', '#fff', '#fff" x', 'url(x)', '#a1b2c3 ', '#a1b2c3;x', 12, null, undefined]) assert.equal(color(bad, '#123456'), '#123456', String(bad));
});

test('유한 수만 참', T, () => {
  assert.equal(finite(0), true);
  assert.equal(finite(-3.5), true);
  for (const bad of [NaN, Infinity, -Infinity, '3', null, undefined, {}]) assert.equal(finite(bad), false, String(bad));
});

test('textW 는 한글 10.5, 그 밖 6', T, () => {
  assert.equal(textW('ab'), 12);
  assert.equal(textW('가나'), 21);
  assert.equal(textW('a가'), 16.5);
  assert.equal(textW(''), 0);
  assert.equal(textW(undefined), 0);
});

test('wrap 은 띄어쓰기에서 폭에 맞춰 나눔', T, () => {
  assert.deepEqual(wrap('aa bb cc', 1000), ['aa bb cc']);
  // 'aa bb' 폭 30 * 1.1 = 33 > 30 이라 나뉨
  assert.deepEqual(wrap('aa bb cc', 30), ['aa', 'bb', 'cc']);
  assert.deepEqual(wrap('', 50), []);
  assert.deepEqual(wrap('긴낱말하나', 10), ['긴낱말하나']);
});

test('공통 CSS 는 옛 화면의 주요 선택자를 담음', T, () => {
  for (const s of ['body{font:14px/1.5 "Malgun Gothic"', '.tabs a.on{background:#fff;font-weight:bold}', 'svg.flow .fl{', 'svg.arch .api{', '@media (prefers-reduced-motion: reduce)']) assert.ok(CSS.includes(s), s);
  assert.ok(!CSS.includes('</style>'));
  assert.equal(CSS.split('\n').length, 30);
});

test('탭 머리는 네 탭과 켜진 탭 하나', T, () => {
  assert.deepEqual(TABS.map((t) => t[0]), ['history', 'req', 'workflow', 'arch']);
  const h = tabsHtml('req');
  assert.equal(h, '<div class="tabs"><a href="/?tab=history">진척도</a><a href="/?tab=req" class="on">구현요건</a><a href="/?tab=workflow">workflow</a><a href="/?tab=arch">구성도</a></div>');
  assert.equal((tabsHtml('arch').match(/class="on"/g) || []).length, 1);
});

test('favicon 은 외부 자원 없는 data URI', T, () => {
  assert.ok(FAVICON.startsWith('data:image/svg+xml,'));
  assert.ok(decodeURIComponent(FAVICON.slice(19)).startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'));
  assert.ok(!/[<>"\s]/.test(FAVICON.slice(19)));
});
