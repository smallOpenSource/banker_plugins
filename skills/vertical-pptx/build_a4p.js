#!/usr/bin/env node
'use strict';
/*
 * vertical-pptx — A4 세로(210 x 297mm) PPTX node 빌더.
 *
 * 이 파일이 하는 일은 두 가지뿐이다: deck JSON 을 좌표로 바꾸고(layout), 그 좌표대로 도형을 찍는다(build).
 * 마크다운 → deck JSON 변환기도 여기 한 벌만 있다(python 빌더는 deck JSON 만 먹는다).
 *
 * ★ INV-G (기하 불변식) — 이 파일의 존재 이유이자 절대 깨면 안 되는 규칙.
 *   모든 도형의 x·y·cx·cy 는 다음 값들만의 순수 함수다:
 *     meta.marginMm · 페이지 인덱스 · 블록 순서 · 블록 type · bullets.items 배열 길이 ·
 *     명시된 rows · 컬럼 스팬.
 *   텍스트의 내용·길이·폰트·pt 는 어떤 좌표에도 들어가지 않는다.
 *   이 불변식이 두 빌더(node·python)를 교체 가능하게 만들고, 폭 측정을 검증기 단독 소유로 만든다.
 *
 * ★ 측정은 여기서 하지 않는다.
 *   폰트 바이너리 파싱·폭 합산·오버플로 판정은 verify_a4p.mjs 단독 소유다.
 *   이 파일은 폰트 "이름" 을 고르고 그 파일이 존재하는지만 확인해서 경로를 보고한다.
 *
 * 기하 (단위 EMU, 1mm = 36000, m = meta.marginMm):
 *   슬라이드 7560000 x 10692000 (고정)
 *   여백 36000m · 본문 (7560000 - 72000m) x (10692000 - 72000m) · 거터 144000 (4mm 고정)
 *   8열: 컬럼 폭 (182 - 2m) * 4500 · 20행: 행 높이 (221 - 2m) * 1800
 *   컬럼 c 에서 k 열: x = 36000m + (컬럼폭 + 144000) * c · cx = 컬럼폭 * k + 144000 * (k - 1)
 *   행 r 에서 n 행:   y = 36000m + (행높이 + 144000) * r · cy = 행높이 * n + 144000 * (n - 1)
 *   m=10 검산: 컬럼 폭 729000 · 행 높이 361800 · 피치 873000 / 505800
 *
 * 행 수 함수 (측정 없음):
 *   rows(block) = min(18, block.rows ?? default(type))
 *   default: head=1 · body=2 · bullets=max(1, items.length) · 페이지 제목 = 2행 고정(모든 슬라이드 상단 예약)
 *   ★ 클램프 발동 조건은 block.rows 가 아니라 block.rows ?? default(type) 다.
 *     항목 19개짜리 불릿에 rows 를 안 적어도 클램프가 걸리고, 그때 경고가 없으면
 *     항목 17·18 이 조용히 겹친 채 출하된다.
 *
 * 페이지 채우기(세는 규칙만): avail = 20 - 2 = 18. used + rows(block) > 18 이면 새 슬라이드.
 *   블록은 쪼개지 않는다(쪼개려면 측정이 필요하다).
 *
 * ── python 빌더와 맞춰야 하는 항목 (E1 교차 동등성) ─────────────────────────────
 *   a:bodyPr   wrap="square" lIns=tIns=rIns=bIns="0" rtlCol="0" anchor="t" · autofit 요소 없음
 *   3슬롯      a:latin / a:ea / a:cs 에 같은 typeface (pptxgenjs 는 fontFace 하나로 셋 다 emit)
 *   줄간       1.2 배수 (오버플로 견적이 이 값을 가정한다)
 *   불릿 글리프 항목 텍스트 앞에 '• ' 를 직접 붙인다 (buChar 를 쓰지 않는다 — 이식이 쉬운 쪽)
 *   pt         제목 = bodyPt + 6 · head = bodyPt + 2 · body/bullets = bodyPt
 *   색         제목/head 1A1A1A · body/bullets 222222
 *   warnings   {code, page, block, detail} · detail 은 숫자만 담는 ASCII (로케일 문자열 금지)
 *
 * 종료 코드: 0 통과 · 1 검증 실패 · 2 환경 미비 · 3 사용법 오류.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// ── 상수 ────────────────────────────────────────────────────────────────────
const EMU_PER_MM = 36000;
const SLIDE_W = 210 * EMU_PER_MM; // 7560000
const SLIDE_H = 297 * EMU_PER_MM; // 10692000
const GUTTER = 4 * EMU_PER_MM; //  144000
const COLS = 8;
const ROWS = 20;
const TITLE_ROWS = 2;
const MAX_BLOCK_ROWS = ROWS - TITLE_ROWS; // 18
const MARGIN_MM_MIN = 10; // 동결 스펙의 "여백 10mm 이상"
const MARGIN_MM_MAX = 40;
const DEFAULT_MARGIN_MM = 10;
const DEFAULT_BODY_PT = 10.5; // 동결 범위 10~11pt
const LINE_SPACING = 1.2;
const LAYOUT_NAME = 'A4P';
const BULLET_PREFIX = '\u2022 ';
const COLOR_HEAD = '1A1A1A';
const COLOR_BODY = '222222';
const BLOCK_TYPES = ['head', 'body', 'bullets'];
const ORIENTATIONS = ['portrait', 'landscape'];
const EXIT = { OK: 0, VERIFY: 1, ENV: 2, USAGE: 3 };

// 폰트 체인. --font → BANKER_PPTX_FONT → meta.font → 아래 목록 → 시스템 한국어 sans.
// "Noto Sans KR" 은 "Noto Sans CJK KR" 의 별칭이 아니라 **다른 패밀리**다. 그래서 별도 항목이다.
// Windows 실측(2026-08-09): C:\Windows\Fonts\NotoSansKR-VF.ttf 의 name 테이블 nameID 1·4 가
// "Noto Sans KR" 이다. 이걸 CJK 항목의 힌트로 묶어 두면 파일은 찾되 pptx 에는 요청한 이름
// "Noto Sans CJK KR" 을 적게 되고, 그 이름은 그 머신에 없어서 뷰어가 대체 폰트로 치환한다.
// 그러면 구속 결정 3(체인의 존재 이유 = 실제로 있는 이름을 써서 줄바꿈을 고정한다)이 무너진다.
// AppleGothic 도 Apple SD Gothic Neo 의 줄임말이 아니라 **다른 폰트**다. macOS 실측(2026-08-09):
// /System/Library/Fonts/AppleSDGothicNeo.ttc 와 /System/Library/Fonts/Supplemental/AppleGothic.ttf
// 가 함께 설치돼 있다. 구형을 신형 이름으로 부르면 위와 같은 오명명이 난다.
const FONT_CHAIN = ['Noto Sans CJK KR', 'Noto Sans KR', 'Malgun Gothic', 'Apple SD Gothic Neo', 'AppleGothic', 'NanumGothic'];
// fc-match 가 없는 환경에서 파일명으로 찾기 위한 힌트(정규화된 소문자 조각).
// ★ 힌트는 그 항목의 패밀리보다 느슨하면 안 된다. 느슨한 힌트는 다른 패밀리의 파일을 잡고,
//   glob 경로에는 fc-match 같은 패밀리 대조가 없어서 그 불일치가 그대로 pptx 에 적힌다.
const FONT_FILE_HINTS = {
  'noto sans cjk kr': ['notosanscjkkr', 'notosanscjk'],
  'noto sans kr': ['notosanskr'],
  'malgun gothic': ['malgun'],
  'apple sd gothic neo': ['applesdgothicneo'],
  applegothic: ['applegothic'],
  nanumgothic: ['nanumgothic'],
};
const FONT_EXT = new Set(['.ttf', '.ttc', '.otf', '.otc']);

// ── 오류 타입 ───────────────────────────────────────────────────────────────
class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; this.exitCode = EXIT.USAGE; }
}
class EnvError extends Error {
  constructor(message) { super(message); this.name = 'EnvError'; this.exitCode = EXIT.ENV; }
}
class VerifyError extends Error {
  constructor(message) { super(message); this.name = 'VerifyError'; this.exitCode = EXIT.VERIFY; }
}

// ── 그리드 ──────────────────────────────────────────────────────────────────
function gridFor(marginMm) {
  const m = marginMm;
  const colW = (182 - 2 * m) * 4500;
  const rowH = (221 - 2 * m) * 1800;
  return {
    marginMm: m,
    margin: EMU_PER_MM * m,
    slideW: SLIDE_W,
    slideH: SLIDE_H,
    contentW: SLIDE_W - 2 * EMU_PER_MM * m,
    contentH: SLIDE_H - 2 * EMU_PER_MM * m,
    gutter: GUTTER,
    cols: COLS,
    rows: ROWS,
    colW,
    rowH,
    colPitch: colW + GUTTER,
    rowPitch: rowH + GUTTER,
  };
}

const colX = (g, c) => g.margin + g.colPitch * c;
const colCx = (g, k) => g.colW * k + GUTTER * (k - 1);
const rowY = (g, r) => g.margin + g.rowPitch * r;
const rowCy = (g, n) => g.rowH * n + GUTTER * (n - 1);

function defaultRows(block) {
  if (block.type === 'head') return 1;
  if (block.type === 'body') return 2;
  return Math.max(1, block.items.length); // bullets
}

/** 클램프 이전의 요청 행 수. 클램프 발동 판정은 반드시 이 값으로 한다. */
const requestedRows = (block) => (block.rows === undefined ? defaultRows(block) : block.rows);
const rowsOf = (block) => Math.min(MAX_BLOCK_ROWS, requestedRows(block));

/**
 * 불릿 항목별 행 배분.
 * 항목 i 는 min(i, n-1) 행에서 시작하고, 남는 행은 전부 마지막 항목이 가져간다.
 * n < items.length 면 n-1 행부터 겹쳐 쌓인다 — 그 겹침을 보고하는 것은 검증기 몫이다.
 */
function bulletSpans(n, count) {
  const spans = [];
  for (let i = 0; i < count; i += 1) {
    const start = Math.min(i, n - 1);
    const end = i === count - 1 ? n - 1 : Math.min(i + 1, n - 1) - 1;
    spans.push({ start, rows: Math.max(1, end - start + 1) });
  }
  return spans;
}

// ── deck 검증 (전부 exit 3) ─────────────────────────────────────────────────
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function orientationOf(deck, page) {
  const meta = deck.meta || {};
  return page.orientation || meta.orientation || 'portrait';
}

function validateDeck(deck) {
  if (!isPlainObject(deck)) throw new UsageError('deck JSON 최상위는 객체여야 한다.');
  const meta = deck.meta === undefined ? {} : deck.meta;
  if (!isPlainObject(meta)) throw new UsageError('meta 는 객체여야 한다.');

  if (meta.marginMm !== undefined) {
    const m = meta.marginMm;
    if (!Number.isInteger(m) || m < MARGIN_MM_MIN || m > MARGIN_MM_MAX) {
      throw new UsageError(
        `meta.marginMm 은 ${MARGIN_MM_MIN} 이상 ${MARGIN_MM_MAX} 이하의 정수여야 한다 (받은 값: ${JSON.stringify(m)}).`
      );
    }
  }
  if (meta.bodyPt !== undefined) {
    const pt = meta.bodyPt;
    if (typeof pt !== 'number' || !Number.isFinite(pt) || pt <= 0 || pt > 400) {
      throw new UsageError(`meta.bodyPt 는 0 초과 400 이하의 수여야 한다 (받은 값: ${JSON.stringify(pt)}).`);
    }
  }
  if (meta.title !== undefined && typeof meta.title !== 'string') throw new UsageError('meta.title 은 문자열이어야 한다.');
  // 길이 상한은 여기서 거부하지 않는다. clampCoreTitle 이 두 빌더에서 똑같이 잘라내고 경고한다.
  if (meta.font !== undefined && typeof meta.font !== 'string') throw new UsageError('meta.font 는 문자열이어야 한다.');
  if (meta.orientation !== undefined && !ORIENTATIONS.includes(meta.orientation)) {
    throw new UsageError(`meta.orientation 은 ${ORIENTATIONS.join(' 또는 ')} 여야 한다.`);
  }

  if (!Array.isArray(deck.pages) || deck.pages.length === 0) throw new UsageError('pages 는 비어 있지 않은 배열이어야 한다.');

  deck.pages.forEach((page, pi) => {
    const at = `pages[${pi}]`;
    if (!isPlainObject(page)) throw new UsageError(`${at} 는 객체여야 한다.`);
    if (page.title !== undefined && typeof page.title !== 'string') throw new UsageError(`${at}.title 은 문자열이어야 한다.`);
    if (page.orientation !== undefined && !ORIENTATIONS.includes(page.orientation)) {
      throw new UsageError(`${at}.orientation 은 ${ORIENTATIONS.join(' 또는 ')} 여야 한다.`);
    }
    const blocks = page.blocks === undefined ? [] : page.blocks;
    if (!Array.isArray(blocks)) throw new UsageError(`${at}.blocks 는 배열이어야 한다.`);
    blocks.forEach((block, bi) => {
      const bat = `${at}.blocks[${bi}]`;
      if (!isPlainObject(block)) throw new UsageError(`${bat} 는 객체여야 한다.`);
      if (!BLOCK_TYPES.includes(block.type)) {
        throw new UsageError(`${bat}.type 은 ${BLOCK_TYPES.join(' / ')} 중 하나여야 한다 (받은 값: ${JSON.stringify(block.type)}).`);
      }
      if (block.type === 'bullets') {
        if (!Array.isArray(block.items) || block.items.length === 0) throw new UsageError(`${bat}.items 는 비어 있지 않은 배열이어야 한다.`);
        block.items.forEach((it, ii) => {
          if (typeof it !== 'string') throw new UsageError(`${bat}.items[${ii}] 는 문자열이어야 한다.`);
        });
      } else if (typeof block.text !== 'string') {
        throw new UsageError(`${bat}.text 는 문자열이어야 한다.`);
      }
      if (block.rows !== undefined && (!Number.isInteger(block.rows) || block.rows < 1)) {
        throw new UsageError(`${bat}.rows 는 1 이상의 정수여야 한다 (받은 값: ${JSON.stringify(block.rows)}).`);
      }
    });
  });

  // 방향 혼합은 파일 형식이 허용하지 않는다 — 하나의 pptx 는 하나의 sldSz 만 갖는다.
  const seen = new Set(deck.pages.map((p) => orientationOf(deck, p)));
  if (seen.size > 1) {
    throw new UsageError(
      '한 pptx 는 세로와 가로를 함께 담을 수 없다(슬라이드 크기가 파일당 하나다). ' +
        '방향별로 파일을 나누어 각각 빌드해라 — split the deck into separate files, one per orientation.'
    );
  }
  if (seen.has('landscape')) {
    throw new UsageError('이 스킬은 A4 세로(210x297mm) 전용이다. 가로 덱은 대상이 아니다.');
  }
  return true;
}

// ── layout: deck JSON → 좌표 (INV-G 의 구현체) ──────────────────────────────
/**
 * @param {object} deck deck JSON
 * @returns {{grid:object, bodyPt:number, slides:Array, warnings:Array}}
 *   slides[i].shapes[j] 는 {role, pageIndex, blockIndex, itemIndex, rows, x, y, cx, cy, text, pt, bold, color}.
 *   pageIndex·blockIndex 가 있어야 검증기가 (슬라이드, 도형) 을 (페이지, 블록) 으로 되돌릴 수 있다.
 */
function layout(deck) {
  validateDeck(deck);
  const meta = deck.meta || {};
  const grid = gridFor(meta.marginMm === undefined ? DEFAULT_MARGIN_MM : meta.marginMm);
  const bodyPt = meta.bodyPt === undefined ? DEFAULT_BODY_PT : meta.bodyPt;
  const pt = { title: bodyPt + 6, head: bodyPt + 2, body: bodyPt, bullets: bodyPt };
  const fullCx = colCx(grid, COLS);
  const slides = [];
  const warnings = [];

  deck.pages.forEach((page, pageIndex) => {
    const title = page.title === undefined ? '' : page.title;
    let slide = null;
    let used = 0;
    let part = 0;

    const openSlide = () => {
      slide = { index: slides.length, pageIndex, part, title, shapes: [] };
      part += 1;
      used = 0;
      slide.shapes.push({
        role: 'title',
        pageIndex,
        blockIndex: null,
        itemIndex: null,
        rows: TITLE_ROWS,
        x: colX(grid, 0),
        y: rowY(grid, 0),
        cx: fullCx,
        cy: rowCy(grid, TITLE_ROWS),
        text: title,
        pt: pt.title,
        bold: true,
        color: COLOR_HEAD,
      });
      slides.push(slide);
    };

    openSlide();

    const blocks = page.blocks === undefined ? [] : page.blocks;
    blocks.forEach((block, blockIndex) => {
      const want = requestedRows(block);
      const n = rowsOf(block);
      if (want > MAX_BLOCK_ROWS) {
        warnings.push({
          code: 'BLOCK_TOO_TALL',
          page: pageIndex,
          block: blockIndex,
          detail: `rows ${want} -> ${n}`,
        });
      }
      // 세는 규칙만: 넘치면 새 슬라이드로 넘긴다. 블록은 절대 쪼개지 않는다.
      if (used > 0 && used + n > MAX_BLOCK_ROWS) openSlide();
      const base = TITLE_ROWS + used;

      if (block.type === 'bullets') {
        bulletSpans(n, block.items.length).forEach((span, itemIndex) => {
          slide.shapes.push({
            role: 'bullet',
            pageIndex,
            blockIndex,
            itemIndex,
            rows: span.rows,
            x: colX(grid, 0),
            y: rowY(grid, base + span.start),
            cx: fullCx,
            cy: rowCy(grid, span.rows),
            text: BULLET_PREFIX + block.items[itemIndex],
            pt: pt.bullets,
            bold: false,
            color: COLOR_BODY,
          });
        });
      } else {
        slide.shapes.push({
          role: block.type,
          pageIndex,
          blockIndex,
          itemIndex: null,
          rows: n,
          x: colX(grid, 0),
          y: rowY(grid, base),
          cx: fullCx,
          cy: rowCy(grid, n),
          text: block.text,
          pt: block.type === 'head' ? pt.head : pt.body,
          bold: block.type === 'head',
          color: block.type === 'head' ? COLOR_HEAD : COLOR_BODY,
        });
      }
      used += n;
    });
  });

  return { grid, bodyPt, slides, warnings };
}

/** 기하가 실제로 여백 안에 있는지 자기 점검. 클램프가 살아 있으면 절대 발동하지 않는다. */
function assertInsideSlide(laid) {
  const g = laid.grid;
  const bad = [];
  laid.slides.forEach((s) => {
    s.shapes.forEach((sh, j) => {
      if (sh.x < g.margin || sh.y < g.margin || sh.x + sh.cx > SLIDE_W - g.margin || sh.y + sh.cy > SLIDE_H - g.margin) {
        bad.push(`slide ${s.index} shape ${j} (${sh.role}): x=${sh.x} y=${sh.y} cx=${sh.cx} cy=${sh.cy}`);
      }
    });
  });
  if (bad.length) throw new VerifyError(`도형이 여백 밖으로 나갔다 — 기하 버그다:\n  ${bad.join('\n  ')}`);
}

// ── 마크다운 → deck JSON (이 프로젝트의 유일한 마크다운 파서) ────────────────
const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_BULLET = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const RE_HRULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const RE_FENCE = /^\s*(```|~~~)/;

/** 인라인 마크업 정리. 기하에는 영향이 없고 화면에 남는 별표만 없앤다. */
function inlineText(s) {
  return String(s)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .trim();
}

/**
 * @param {string} md 마크다운 원문
 * @returns {{deck:object, warnings:Array}}
 *   h1 → 새 페이지 · h2 → head · 불릿 → bullets · 문단 → body · h3 이하 → body 강등 + 경고 1건.
 *   ★ 변환기는 rows 를 계산하지 않는다. 글자 수는 폰트와 폭을 모르는 조잡한 측정이고,
 *     정확해 보이는 오답을 만든다. 넘치면 verify_a4p.mjs --suggest-deck 이 재고 나서 고친다.
 */
function mdToDeck(md) {
  const raw = String(md).replace(/\r\n?/g, '\n').split('\n');
  const warnings = [];
  const pages = [];
  let title = '';
  let page = null;
  let para = [];
  let items = [];
  let fence = null;
  let code = [];
  let curLine = 0;

  const ensurePage = () => {
    if (page) return;
    page = { title: '', blocks: [] };
    pages.push(page);
    warnings.push({ code: 'IMPLICIT_PAGE', line: curLine, detail: 'h1 이전 본문' });
  };
  const flushPara = () => {
    if (!para.length) return;
    ensurePage();
    page.blocks.push({ type: 'body', text: para.join(' ') });
    para = [];
  };
  const flushItems = () => {
    if (!items.length) return;
    ensurePage();
    page.blocks.push({ type: 'bullets', items: items.slice() });
    items = [];
  };
  const flushAll = () => { flushPara(); flushItems(); };

  // YAML frontmatter 는 문서가 아니라 메타다 — 건너뛴다.
  let i = 0;
  if (raw[0] !== undefined && raw[0].trim() === '---') {
    let end = -1;
    for (let k = 1; k < raw.length; k += 1) { if (raw[k].trim() === '---') { end = k; break; } }
    if (end > 0) i = end + 1;
  }

  for (; i < raw.length; i += 1) {
    const line = raw[i];
    const lineNo = i + 1;
    curLine = lineNo;

    const fenceHit = RE_FENCE.exec(line);
    if (fence) {
      if (fenceHit && fenceHit[1] === fence) {
        ensurePage();
        page.blocks.push({ type: 'body', text: code.join('\n') });
        fence = null;
        code = [];
      } else {
        code.push(line);
      }
      continue;
    }
    if (fenceHit) { flushAll(); fence = fenceHit[1]; code = []; continue; }

    if (line.trim() === '') { flushAll(); continue; }
    if (RE_HRULE.test(line)) { flushAll(); continue; }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      const text = inlineText(heading[2]);
      if (level === 1) {
        page = { title: text, blocks: [] };
        pages.push(page);
        if (!title) title = text;
      } else if (level === 2) {
        ensurePage();
        page.blocks.push({ type: 'head', text });
      } else {
        ensurePage();
        page.blocks.push({ type: 'body', text });
        warnings.push({ code: 'HEADING_DEMOTED', line: lineNo, detail: `h${level} -> body` });
      }
      continue;
    }

    const bullet = RE_BULLET.exec(line);
    if (bullet) { flushPara(); items.push(inlineText(bullet[2])); continue; }

    flushItems();
    para.push(inlineText(line.replace(/^\s*>\s?/, '')));
  }
  if (fence) { ensurePage(); page.blocks.push({ type: 'body', text: code.join('\n') }); }
  flushAll();

  if (!pages.length) pages.push({ title: '', blocks: [] });

  const deck = {
    meta: { title, font: 'auto', bodyPt: DEFAULT_BODY_PT, marginMm: DEFAULT_MARGIN_MM },
    pages,
  };
  return { deck, warnings };
}

// ── 폰트: 이름을 고르고 파일이 있는지만 확인한다 (바이너리 파싱 0줄) ─────────
const normName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const escFc = (s) => String(s).replace(/([-:,\\])/g, '\\$1');
// pptxgenjs 는 fontFace 를 XML 속성에 그대로 박는다(이스케이프 없음). 속성을 깨는 문자는 여기서 없앤다.
const sanitizeFontName = (s) => (typeof s === 'string' ? s.replace(/["'<>&]/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim() : '');

let fcMatchAvailable = null;
function fcMatch(pattern) {
  if (fcMatchAvailable === false) return null;
  let res;
  try {
    res = cp.spawnSync('fc-match', ['--format=%{file}|%{family}', pattern], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
  } catch (e) {
    fcMatchAvailable = false;
    return null;
  }
  if (res.error || res.status !== 0 || !res.stdout) {
    if (res.error && res.error.code === 'ENOENT') fcMatchAvailable = false;
    return null;
  }
  fcMatchAvailable = true;
  const cut = res.stdout.indexOf('|');
  if (cut < 0) return null;
  const file = res.stdout.slice(0, cut).trim();
  const families = res.stdout.slice(cut + 1).split(',').map((s) => s.trim()).filter(Boolean);
  if (!file) return null;
  return { file, families };
}

function fontSearchDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library', 'Fonts')];
  }
  if (process.platform === 'win32') {
    const dirs = [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')];
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
    return dirs;
  }
  return [
    '/usr/share/fonts', '/usr/local/share/fonts',
    path.join(home, '.local', 'share', 'fonts'), path.join(home, '.fonts'),
  ];
}

/**
 * fc-match 가 없는 환경용 파일명 탐색. 깊이·개수 예산을 둬서 병적인 트리에서도 끝난다.
 * ★ 첫 히트를 그냥 쓰면 안 된다 — 같은 패밀리의 Black·Bold 가 먼저 걸리면 검증기가
 *   본문과 다른 굵기의 메트릭으로 폭을 재게 된다. Regular 를 우선하고 순위는 완전 결정론적이다.
 */
function fontWeightRank(flat) {
  if (flat.includes('regular') || flat.includes('normal')) return 0;
  if (/bold|black|light|thin|medium|semi|extra|heavy|demi|italic|oblique/.test(flat)) return 2;
  return 1;
}

function globFontFile(name) {
  const hints = FONT_FILE_HINTS[String(name).toLowerCase()] || [normName(name)];
  let budget = 20000;
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6 || budget <= 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    const subdirs = [];
    for (const ent of entries) {
      budget -= 1;
      if (budget <= 0) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { subdirs.push(full); continue; }
      if (!FONT_EXT.has(path.extname(ent.name).toLowerCase())) continue;
      const flat = normName(path.basename(ent.name, path.extname(ent.name)));
      if (hints.some((h) => flat.includes(h))) found.push({ full, rank: fontWeightRank(flat) });
    }
    for (const sub of subdirs) walk(sub, depth + 1);
  };
  for (const dir of fontSearchDirs()) {
    if (!fs.existsSync(dir)) continue;
    walk(dir, 0);
    if (found.length) break; // 검색 경로는 우선순위 순서다 — 앞선 경로에서 찾으면 거기서 고른다
  }
  if (!found.length) return null;
  found.sort((a, b) => a.rank - b.rank
    || path.basename(a.full).length - path.basename(b.full).length
    || (a.full < b.full ? -1 : a.full > b.full ? 1 : 0));
  return found[0].full;
}

/**
 * 이름 하나를 실제 파일로 해석한다.
 * fc-match 는 없는 폰트에도 대체 폰트를 돌려주므로(예: Malgun Gothic → DejaVu Sans)
 * 돌려받은 family 가 요청한 이름과 실제로 맞는지 대조해야 한다. 안 그러면 이름이 거짓말이 된다.
 */
function findFontFile(name) {
  const want = normName(name);
  // 한 방향(family 가 요청 이름을 품는가)만 본다. 반대 방향까지 허용하면
  // "Noto Sans CJK KR" 을 요청했는데 "Noto Sans" 가 통과해 한글 없는 폰트에 그 이름이 붙는다.
  const hit = fcMatch(escFc(name));
  if (hit && hit.families.some((f) => { const n = normName(f); return n === want || n.includes(want); })) {
    if (fs.existsSync(hit.file)) return hit.file;
  }
  const globbed = globFontFile(name);
  if (globbed && fs.existsSync(globbed)) return globbed;
  return null;
}

/**
 * 체인을 돌며 "존재하는 파일을 가진 이름" 을 고른다.
 * 명시된 이름(--font·env·meta.font)이 해석되지 않으면 경고를 남기고 다음으로 내려간다 — 조용히 바꾸지 않는다.
 */
function resolveFont(opts) {
  const warnings = [];
  const explicit = [
    { name: sanitizeFontName(opts.fontArg), from: '--font' },
    { name: sanitizeFontName(process.env.BANKER_PPTX_FONT), from: 'BANKER_PPTX_FONT' },
    { name: opts.metaFont === 'auto' ? '' : sanitizeFontName(opts.metaFont), from: 'meta.font' },
  ].filter((c) => c.name !== '');

  for (const c of explicit) {
    const file = findFontFile(c.name);
    if (file) return { name: c.name, file, from: c.from, warnings };
    warnings.push({ code: 'FONT_NOT_FOUND', from: c.from, detail: c.name });
  }
  for (const name of FONT_CHAIN) {
    const file = findFontFile(name);
    if (file) return { name, file, from: 'chain', warnings };
  }
  const sys = fcMatch('sans-serif:lang=ko');
  if (sys && sys.families.length && fs.existsSync(sys.file)) {
    return { name: sys.families[0], file: sys.file, from: 'system', warnings };
  }
  const fallback = explicit.length ? explicit[0].name : FONT_CHAIN[0];
  warnings.push({ code: 'FONT_FILE_UNRESOLVED', from: 'chain', detail: fallback });
  return { name: fallback, file: null, from: 'unresolved', warnings };
}

// ── pptxgenjs 해석 (설치는 하지 않는다) ─────────────────────────────────────
/** 스킬 디렉터리 상위에는 node_modules 가 없다. 사용자 환경에서 직접 찾는다. */
function moduleSearchPaths() {
  const dirs = [process.cwd()];
  const nodeDir = path.dirname(process.execPath);
  if (process.platform === 'win32') {
    dirs.push(path.join(nodeDir, 'node_modules'));
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  } else {
    dirs.push(path.join(nodeDir, '..', 'lib', 'node_modules'));
    dirs.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
  }
  if (process.env.npm_config_prefix) {
    dirs.push(process.platform === 'win32'
      ? path.join(process.env.npm_config_prefix, 'node_modules')
      : path.join(process.env.npm_config_prefix, 'lib', 'node_modules'));
  }
  // require.resolve 에 paths 를 주면 NODE_PATH 기본 경로가 대체되므로 직접 넣는다.
  if (process.env.NODE_PATH) {
    for (const p of process.env.NODE_PATH.split(path.delimiter)) if (p) dirs.push(p);
  }
  const seen = new Set();
  return dirs.filter((d) => { const r = path.resolve(d); if (seen.has(r)) return false; seen.add(r); return fs.existsSync(r); });
}

/** 자동 설치는 하지 않는다. 사람이 읽고 스스로 고칠 수 있는 안내만 낸다. */
function pptxgenMissingMessage() {
  return [
    'pptxgenjs 를 찾지 못했다. 이 스킬은 의존성을 자동 설치하지 않는다.',
    '',
    '  설치:  npm i pptxgenjs   (프로젝트) 또는  npm i -g pptxgenjs   (전역)',
    '  안내:  docs-setup 스킬이 이 스킬의 런타임 준비 절차를 담고 있다 (/banker:docs-setup).',
    '  대안:  pptxgenjs 를 설치할 수 없는 환경이면 build_a4p.py (python-pptx) 를 쓴다.',
    '',
    `  찾아본 곳: ${moduleSearchPaths().join(', ') || '(없음)'}`,
  ].join('\n');
}

function loadPptxgen() {
  try {
    return require(require.resolve('pptxgenjs'));
  } catch (e) { /* 기본 경로 실패 — 아래에서 사용자 환경을 뒤진다 */ }
  try {
    return require(require.resolve('pptxgenjs', { paths: moduleSearchPaths() }));
  } catch (e) {
    throw new EnvError(pptxgenMissingMessage());
  }
}

// ── 빌드 ────────────────────────────────────────────────────────────────────
// OPC core property `title` 의 길이 상한. OOXML 규격이 아니라 python-pptx 가 스스로 거는 제한인데,
// 두 빌더가 같은 deck 에서 갈리면 원칙 5(교체 가능)가 깨지므로 node 도 똑같이 자른다.
// meta.title 은 문서 메타데이터일 뿐이고 페이지 제목은 별도 도형이라, 잘려도 보이는 내용은 잃지 않는다.
const CORE_TITLE_MAX = 255;

// ★ 코드 포인트로 센다. String.length 는 UTF-16 유닛이라 python 의 len() 과 다르다.
// 이모지 200개는 코드 포인트 200 이지만 UTF-16 유닛 400 이라, 유닛으로 재면 node 만 자른다.
// 게다가 유닛 경계에서 자르면 서로게이트 페어가 쪼개져 마지막 글자가 U+FFFD 로 깨진다.
function clampCoreTitle(title) {
  if (typeof title !== 'string') return { value: title, truncated: false, length: 0 };
  const cps = Array.from(title);
  if (cps.length <= CORE_TITLE_MAX) return { value: title, truncated: false, length: cps.length };
  return { value: cps.slice(0, CORE_TITLE_MAX).join(''), truncated: true, length: cps.length };
}

function build(laid, outPath, font, deck, mod, warnings) {
  const Ctor = mod && mod.default ? mod.default : mod;
  const pptx = new Ctor();
  // ★ 레이아웃은 슬라이드 추가 전에 확정한다. 폭·높이는 전정밀도 mm/25.4 를 쓴다 —
  //   반올림한 인치 리터럴은 sldSz 를 A4 에서 수천 EMU 어긋나게 만든다.
  pptx.defineLayout({ name: LAYOUT_NAME, width: 210 / 25.4, height: 297 / 25.4 });
  pptx.layout = LAYOUT_NAME;
  const meta = deck.meta || {};
  if (meta.title) {
    const t = clampCoreTitle(meta.title);
    pptx.title = t.value;
    if (t.truncated && warnings) {
      // t.length 는 코드 포인트 수다. meta.title.length(UTF-16 유닛)를 쓰면 detail 이 python 과 갈린다.
      warnings.push({ code: 'TITLE_TRUNCATED', from: 'meta.title', detail: `${t.length} -> ${CORE_TITLE_MAX}` });
    }
  }

  laid.slides.forEach((s) => {
    const slide = pptx.addSlide();
    s.shapes.forEach((sh) => {
      slide.addText(sh.text, {
        x: sh.x, y: sh.y, w: sh.cx, h: sh.cy, // >= 100 인 수는 pptxgenjs 가 EMU 로 그대로 쓴다
        fontFace: font.name, // 한 속성이 a:latin·a:ea·a:cs 3슬롯을 모두 emit 한다
        fontSize: sh.pt,
        bold: sh.bold,
        color: sh.color,
        align: 'left',
        valign: 'top',
        lineSpacingMultiple: LINE_SPACING,
        // ★ a:bodyPr 를 명시적으로 고정한다(F13). 기본값에 맡기면 autofit 요소가 붙어
        //   뷰어가 열 때 도형 크기를 바꾸고, 파일 안 좌표는 맞는데 화면에서 INV-G 가 깨진다.
        wrap: true,
        fit: 'none',
        margin: 0,
      });
    });
  });

  return pptx.writeFile({ fileName: outPath }).then(() => outPath);
}

// ── 출력 ────────────────────────────────────────────────────────────────────
function humanReport(laid, font, outPath, warnings) {
  const g = laid.grid;
  const shapes = laid.slides.reduce((a, s) => a + s.shapes.length, 0);
  const lines = [
    'vertical-pptx (node 빌더)',
    `  용지      A4 세로 210x297mm · sldSz ${SLIDE_W} x ${SLIDE_H} EMU`,
    `  여백      ${g.marginMm}mm · 그리드 ${COLS}열 x ${ROWS}행 · 거터 4mm`,
    `  칸        컬럼 ${g.colW} · 행 ${g.rowH} · 피치 ${g.colPitch} / ${g.rowPitch} EMU`,
  ];
  if (font) {
    lines.push(`  폰트      ${font.name}${font.file ? '' : '  (파일 미해석 — 검증기 폭 판정은 estimate 로 내려간다)'}`);
    lines.push(`            ${font.file || '(경로 없음)'}`);
  }
  lines.push(
    `  본문      ${laid.bodyPt}pt · 줄간 ${LINE_SPACING}`,
    `  슬라이드  ${laid.slides.length} (deck 페이지 ${new Set(laid.slides.map((s) => s.pageIndex)).size}개)`,
    `  도형      ${shapes}`,
    `  경고      ${warnings.length}`
  );
  warnings.forEach((w) => {
    let where = '';
    if (w.page !== undefined) where = `page ${w.page} block ${w.block}`;
    else if (w.line !== undefined) where = `line ${w.line}`;
    else if (w.from !== undefined) where = w.from;
    lines.push(`    ${w.code}  ${where}  ${w.detail || ''}`.replace(/\s+$/, ''));
  });
  if (outPath) lines.push(`  출력      ${outPath}`);
  return lines.join('\n');
}

const statusJson = (font, slides, warnings) => JSON.stringify({
  skill: 'vertical-pptx',
  builder: 'node',
  font: font ? font.name : null,
  fontFile: font ? font.file : null,
  slides,
  warnings,
});

// ── CLI ─────────────────────────────────────────────────────────────────────
const USAGE = [
  'vertical-pptx / build_a4p.js — A4 세로(210x297mm) PPTX node 빌더',
  '',
  '사용법:',
  '  node build_a4p.js --in deck.json --out out.pptx [--font <이름>]',
  '  node build_a4p.js --md doc.md --emit-json > deck.json',
  '  node build_a4p.js --md doc.md --emit-json --out deck.json',
  '  node build_a4p.js --md doc.md --out out.pptx [--font <이름>]',
  '',
  '옵션:',
  '  --in <deck.json>   deck JSON 입력 (두 빌더의 유일한 계약)',
  '  --md <doc.md>      마크다운 입력 (h1=페이지 · h2=head · 불릿=bullets · 문단=body)',
  '  --emit-json        빌드하지 않고 deck JSON 만 낸다. --out 이 없으면 stdout 이 deck JSON 전용이 되고',
  '                     사람이 읽는 표와 상태 JSON 은 stderr 로 간다(리다이렉트 안전).',
  '  --out <경로>       .pptx 출력 경로 (--emit-json 과 함께 쓰면 deck JSON 출력 경로)',
  '  --font <이름>      폰트 이름을 직접 지정. 체인: --font → BANKER_PPTX_FONT → meta.font',
  '                     → Noto Sans CJK KR → Malgun Gothic → Apple SD Gothic Neo → NanumGothic → 시스템 한국어 sans',
  '  -h, --help         이 도움말',
  '',
  '종료 코드: 0 통과 · 1 검증 실패 · 2 환경 미비(pptxgenjs 없음) · 3 사용법 오류',
].join('\n');

function parseArgs(argv) {
  const opts = { in: '', md: '', out: '', fontArg: '', emitJson: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const need = (name) => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} 에 값이 필요하다.`);
      i += 1;
      return v;
    };
    if (a === '--in') opts.in = need('--in');
    else if (a === '--md') opts.md = need('--md');
    else if (a === '--out') opts.out = need('--out');
    else if (a === '--font') opts.fontArg = need('--font');
    else if (a === '--emit-json') opts.emitJson = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new UsageError(`알 수 없는 인자: ${a}\n\n${USAGE}`);
  }
  return opts;
}

function readDeckFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new UsageError(`deck JSON 을 읽지 못했다: ${e.message}`); }
  try { return JSON.parse(text); } catch (e) { throw new UsageError(`deck JSON 파싱 실패 (${file}): ${e.message}`); }
}

/** 언제나 Promise 를 돌려준다 — 동기 throw 와 비동기 reject 를 호출자가 구분하지 않아도 되게. */
function main(argv) {
  try { return runMain(argv); } catch (err) { return Promise.reject(err); }
}

function runMain(argv) {
  const opts = parseArgs(argv);
  if (opts.help || (!opts.in && !opts.md)) {
    process.stdout.write(`${USAGE}\n`);
    return Promise.resolve(opts.help ? EXIT.OK : EXIT.USAGE);
  }
  if (opts.in && opts.md) throw new UsageError('--in 과 --md 는 함께 쓸 수 없다.');

  let deck;
  let warnings = [];
  if (opts.md) {
    let text;
    try { text = fs.readFileSync(opts.md, 'utf8'); } catch (e) { throw new UsageError(`마크다운을 읽지 못했다: ${e.message}`); }
    const converted = mdToDeck(text);
    deck = converted.deck;
    warnings = converted.warnings;
  } else {
    deck = readDeckFile(opts.in);
  }

  const laid = layout(deck); // validateDeck 포함 — 스키마 위반은 여기서 exit 3
  warnings = warnings.concat(laid.warnings);

  if (opts.emitJson) {
    const json = `${JSON.stringify(deck, null, 2)}\n`;
    // 리다이렉트(`> deck.json`) 안전: --out 이 없으면 stdout 은 deck JSON 전용이고
    // 사람이 읽는 표와 상태 JSON 은 stderr 로 간다.
    const side = opts.out ? process.stdout : process.stderr;
    if (opts.out) fs.writeFileSync(opts.out, json); else process.stdout.write(json);
    side.write(`${humanReport(laid, null, opts.out || '', warnings)}\n`);
    side.write(`${statusJson(null, laid.slides.length, warnings)}\n`);
    return Promise.resolve(EXIT.OK);
  }

  if (!opts.out) throw new UsageError('--out <경로> 가 필요하다.');
  assertInsideSlide(laid);

  // ★ pptxgenjs 해석을 폰트 해석보다 먼저 한다.
  //   환경이 미비하면 자식 프로세스(fc-match)를 하나도 띄우지 않고 exit 2 로 나간다.
  const mod = loadPptxgen();
  const font = resolveFont({ fontArg: opts.fontArg, metaFont: deck.meta && deck.meta.font });
  warnings = warnings.concat(font.warnings);

  return build(laid, path.resolve(opts.out), font, deck, mod, warnings).then((outPath) => {
    process.stdout.write(`${humanReport(laid, font, outPath, warnings)}\n`);
    process.stdout.write(`${statusJson(font, laid.slides.length, warnings)}\n`);
    return EXIT.OK;
  });
}

if (require.main === module) {
  // 환경 미비(exit 2)는 사용자가 그대로 따라 할 수 있는 안내라서 stdout 으로 낸다.
  // 나머지 오류는 stderr.
  const fail = (err) => {
    const code = err && err.exitCode ? err.exitCode : EXIT.USAGE;
    const text = `${err && err.message ? err.message : String(err)}\n`;
    if (code === EXIT.ENV) process.stdout.write(text); else process.stderr.write(text);
    process.exitCode = code;
  };
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, fail);
}

module.exports = {
  layout,
  mdToDeck,
  validateDeck,
  clampCoreTitle,
  CORE_TITLE_MAX,
  gridFor,
  rowsOf,
  requestedRows,
  defaultRows,
  bulletSpans,
  resolveFont,
  findFontFile,
  moduleSearchPaths,
  inlineText,
  main,
  UsageError,
  EnvError,
  VerifyError,
  EXIT,
  SLIDE_W,
  SLIDE_H,
  GUTTER,
  COLS,
  ROWS,
  TITLE_ROWS,
  MAX_BLOCK_ROWS,
  MARGIN_MM_MIN,
  MARGIN_MM_MAX,
  DEFAULT_MARGIN_MM,
  DEFAULT_BODY_PT,
  LINE_SPACING,
  BULLET_PREFIX,
  FONT_CHAIN,
  FONT_FILE_HINTS,
};
