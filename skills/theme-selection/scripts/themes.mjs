#!/usr/bin/env node
// 테마 엔진과 CLI. Node ESM, 의존성 0건.
//
// 🔴 네트워크를 쓰지 않습니다. `fetch` · `node:http(s)` · `node:child_process`
// 가 이 파일에 없는 것이 사양입니다. 폐쇄망에서 도는 스킬이고, 인터넷이 필요한
// 줄 하나가 들어오면 그 자리에서 스킬 전체가 쓸 수 없는 것이 됩니다.
//
// 🔴 이 파일은 CLI 로도 돌고 import 로도 돕니다. 최상위에서 바로 실행하지
// 않고 맨 아래에서 실제 경로를 비교해 직접 실행인지 보고 `main()` 을 부릅니다.
// 자기 시험이 엔진 함수를 직접 불러야 하기 때문입니다.
//
// 🔴 색 계산은 파이썬 원본(대비 보정, DESIGN.md 읽기)의 포팅입니다. 값이 한
// 자리라도 갈리면 안 되므로 파이썬의 `round`(짝수 쪽 반올림)와
// `colorsys`(HLS, 인자 순서가 `h, l, s`)를 손으로 옮겼습니다. 원본과 값을
// 대조하는 도구는 이 패키지에 들어 있지 않습니다.

import {
  readFileSync, writeFileSync, readdirSync, statSync, lstatSync, realpathSync,
} from "node:fs";
import { dirname, join, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const WHITE = "#ffffff";
export const BLACK = "#000000";

// 대비 보정의 목표. 🔴 3.0 이고 4.5 가 아닙니다. 여기서 고치는 것은 본문이
// 아니라 안 보이면 기능이 사라지는 셋입니다. 팔레트 74개를 전부 4.5 로
// 끌어올리면 테마가 테마가 아닙니다.
export const TARGET = 3.0;

// 버튼 글자의 목표. 버튼 배경은 3.0 으로 맞춘 색이고, 그 위 글자는 본문
// 글자라 4.5 입니다. 같은 쌍을 쓰면 배경까지 4.5 로 밀려 딸려 가는 자리가
// 생기므로 글자는 새 이름으로 따로 고릅니다.
export const LABEL_TARGET = 4.5;

// 제자리에서 옮기는 색. [고칠 색, 3.0 을 만족해야 하는 배경, 나빠지면 안 되는 배경].
export const CONTRAST_JOBS = [["accent", "bg", "surface"]];

// 배경별로 쪼개는 색. 결과는 `--<색>-on-surface` 라는 새 이름입니다.
// 🔴 `ink` · `dim` 을 제자리에서 옮기면 본문 전체가 딸려 갑니다
// (`lamborghini/light` 에서 12.79 -> 4.20, 크로미움 실측 2026-09-08).
export const SURFACE_JOBS = [["ink", "surface", "bg"],
                             ["dim", "surface", "bg"],
                             ["accent", "surface", "bg"],
                             ["warn", "surface", "bg"]];

// [글자 변수, 그 글자가 올라가는 배경 변수]. 🔴 배경마다 하나씩입니다.
// 같은 이름 하나로 두 배경을 맞추면 한쪽이 4.5 아래로 떨어집니다.
export const LABEL_JOBS = [["label-on-accent", "accent-on-surface"],
                           ["label-on-page-accent", "accent"]];

// 팔레트 값의 순서. 🔴 `assets/palettes.json` 의 `fields` 와 같아야 합니다.
export const FIELDS = ["bg", "surface", "ink", "dim", "rule", "accent", "warn"];

// 조합 하나가 CSS 로 내는 열세 이름. 순서도 이대로입니다.
export const OUT_NAMES = [
  ...FIELDS,
  ...SURFACE_JOBS.map(([field]) => `${field}-on-surface`),
  ...LABEL_JOBS.map(([name]) => name),
];

// `--shadow` 는 테마의 성질이 아니라 모드의 성질입니다. 테마마다 넣으면 같은
// 두 값이 148번 반복됩니다.
const SHADOW_LIGHT = "rgba(0,0,0,.08)";
const SHADOW_DARK = "rgba(0,0,0,.45)";

/* ------------------------------------------------------------------ 수치 */

// 파이썬의 `x % 1.0`. 🔴 JS 의 `%` 는 피제수의 부호를 따라가므로 음수 색조에서
// 파이썬과 갈립니다. CPython 과 같은 순서로 보정합니다.
export function pymod1(x) {
  let mod = x % 1.0;
  if (mod !== 0) {
    if (mod < 0) mod += 1.0;
  } else {
    mod = 0;
  }
  return mod;
}

// C 의 `round()`. 반올림이고 0.5 는 0 에서 멀어지는 쪽입니다.
function cround(x) {
  const abs = Math.abs(x);
  const floor = Math.floor(abs);
  const rounded = abs - floor >= 0.5 ? floor + 1 : floor;
  return x < 0 ? -rounded : rounded;
}

// 파이썬의 `round(x)`. 🔴 0.5 를 **짝수** 쪽으로 보냅니다. JS 의 `Math.round`
// 는 위로 보내므로, 이 한 글자 차이가 채널 값을 1 씩 어긋내고 대비 판정
// 경계에서 다른 색을 고르게 만듭니다. CPython `float.__round__` 와 같은 순서.
export function pyround(x) {
  let rounded = cround(x);
  if (Math.abs(x - rounded) === 0.5) rounded = 2 * cround(x / 2);
  return rounded;
}

function hex2(value) {
  const text = value.toString(16);
  return text.length < 2 ? `0${text}` : text;
}

function channels(value) {
  return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
}

// WCAG 상대 휘도. 값은 `#rrggbb` 입니다.
export function luminance(value) {
  const chans = channels(value).map(
    (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * chans[0] + 0.7152 * chans[1] + 0.0722 * chans[2];
}

// 두 색의 대비비. 1.0(같은 색, 안 보임) ~ 21.0(검정과 흰색).
export function contrast(one, other) {
  const a = luminance(one);
  const b = luminance(other);
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  return (high + 0.05) / (low + 0.05);
}

// `colorsys.rgb_to_hls` 의 포팅. 🔴 돌려주는 순서는 `[h, l, s]` 입니다 - HSL 과
// 가운데 둘이 바뀌어 있어, 순서를 바꿔 받으면 1,924 값이 전부 조금씩 틀립니다.
export function rgbToHls(red, green, blue) {
  const maxc = Math.max(red, green, blue);
  const minc = Math.min(red, green, blue);
  const sumc = maxc + minc;
  const rangec = maxc - minc;
  const light = sumc / 2.0;
  if (minc === maxc) return [0.0, light, 0.0];
  const sat = light <= 0.5 ? rangec / sumc : rangec / (2.0 - maxc - minc);
  const rc = (maxc - red) / rangec;
  const gc = (maxc - green) / rangec;
  const bc = (maxc - blue) / rangec;
  let hue;
  if (red === maxc) hue = bc - gc;
  else if (green === maxc) hue = 2.0 + rc - bc;
  else hue = 4.0 + gc - rc;
  return [pymod1(hue / 6.0), light, sat];
}

const ONE_THIRD = 1.0 / 3.0;
const ONE_SIXTH = 1.0 / 6.0;
const TWO_THIRD = 2.0 / 3.0;

function hlsValue(m1, m2, hue) {
  const spot = pymod1(hue);
  if (spot < ONE_SIXTH) return m1 + (m2 - m1) * spot * 6.0;
  if (spot < 0.5) return m2;
  if (spot < TWO_THIRD) return m1 + (m2 - m1) * (TWO_THIRD - spot) * 6.0;
  return m1;
}

// `colorsys.hls_to_rgb` 의 포팅. 인자 순서는 `(h, l, s)` 입니다.
export function hlsToRgb(hue, light, sat) {
  if (sat === 0.0) return [light, light, light];
  const m2 = light <= 0.5 ? light * (1.0 + sat) : light + sat - light * sat;
  const m1 = 2.0 * light - m2;
  return [hlsValue(m1, m2, hue + ONE_THIRD),
          hlsValue(m1, m2, hue),
          hlsValue(m1, m2, hue - ONE_THIRD)];
}

// 색조와 채도는 그대로 두고 명도만 옮깁니다. 테마를 고른 사람이 고른 것은
// 색이지 밝기가 아니라서, HLS 로 옮기면 라즈베리는 여전히 라즈베리입니다.
export function withLightness(value, light) {
  const [red, green, blue] = channels(value);
  const [hue, , sat] = rgbToHls(red, green, blue);
  const out = hlsToRgb(hue, Math.min(Math.max(light, 0.0), 1.0), sat);
  return `#${out.map((c) => hex2(pyround(c * 255))).join("")}`;
}

// 두 색을 `t` 만큼 섞습니다. 🔴 여기의 반올림도 파이썬 규칙입니다.
export function mix(one, other, t) {
  let out = "#";
  for (const i of [1, 3, 5]) {
    const av = parseInt(one.slice(i, i + 2), 16);
    const bv = parseInt(other.slice(i, i + 2), 16);
    out += hex2(pyround(av + (bv - av) * t));
  }
  return out;
}

/* ------------------------------------------------------------------ 보정 */

// `needBg` 위에서 목표를 만들되 `keepBg` 위에서 나빠지지 않게.
//
// 🔴 `keepBg` 의 하한은 `min(원래 대비, 목표)` 입니다. 원래 2.7 이었으면 2.7 만
// 지키면 됩니다 - 더 좋아지라고 요구하지 않습니다. 양쪽에 목표를 걸면 낮은
// 쪽을 끌어올리려다 높은 쪽을 떨어뜨려 답이 없어지는 조합이 생깁니다.
//
// 🔴 방향을 미리 정하지 않고 0.000~1.000 을 **1001 단계** 전부 훑어 원래
// 명도에서 가장 가까운 후보를 고릅니다. 밝은 `bg` 와 검은 `surface` 사이에 낀
// 색은 위도 아래도 아닌 가운데로 가야 하고, "어두우면 밝힌다" 같은 규칙은
// 바로 그 자리에서 틀립니다. 같은 입력에는 같은 출력입니다.
//
// 답이 없으면 원래 값을 그대로 돌려줍니다. 조용히 포기하는 것이 아니라,
// `check` 가 나가는 값을 재고 있어서 그 자리는 빨강으로 보입니다.
export function corrected(value, needBg, keepBg, target = TARGET) {
  const floor = Math.min(contrast(value, keepBg), target);
  if (contrast(value, needBg) >= target) return value;
  const [, origin] = rgbToHls(...channels(value));
  let best = value;
  let nearest = null;
  for (let step = 0; step < 1001; step += 1) {
    const light = step / 1000.0;
    const candidate = withLightness(value, light);
    // 🔴 `floor - 1e-9` 의 여유를 빼지 마십시오. 부동소수 비교라 없으면
    // 원래 값이 그대로 답인 경계 조합이 답 없음으로 갈립니다.
    if (contrast(candidate, needBg) >= target
        && contrast(candidate, keepBg) >= floor - 1e-9) {
      const gap = Math.abs(light - origin);
      if (nearest === null || gap < nearest) {
        best = candidate;
        nearest = gap;
      }
    }
  }
  return best;
}

// 버튼(배경 `button`) 위 글자색. 목표를 넘는 **첫 후보**입니다.
//
// 🔴 첫 후보는 원래 글자색인 `surface` 입니다. 이미 목표를 넘는 조합에서는
// 화면이 한 픽셀도 안 바뀝니다. 다음은 그 테마의 `bg` · `ink` 이고 마지막이
// 흰색과 검정입니다. 어떤 색이든 둘 중 하나와는 4.58 이상이라 기본 목표
// 4.5 에서는 답 없는 조합이 없습니다. 명도를 훑지 않는 까닭은 이 글자가 버튼
// 위 짧은 한 줄이라, 테마 색 셋으로 안 되면 흑백이 가장 읽히기 때문입니다.
//
// 🔴 `--label-target` 을 4.58 보다 높게 주면 답 없는 조합이 생깁니다. 그때는
// 던지지 않고 대비가 가장 높은 후보를 돌려줍니다. `corrected` 와 같이 `check`
// 가 나가는 값을 재므로 그 자리는 빨강으로 보입니다. 던지면 CLI 가 스택 추적과
// 종료 코드 1(`check` 의 "어긋남" 과 같은 값)로 끝나 원인이 가려집니다.
//
// 🔴 후보는 `seen`(원본 팔레트)에서 가져옵니다. 보정된 값에서 가져오면 글자색이
// 목록 순서에 딸려 갑니다.
export function labelOnAccent(seen, button, target = LABEL_TARGET) {
  const candidates = [seen.surface, seen.bg, seen.ink, WHITE, BLACK];
  let best = candidates[0];
  for (const candidate of candidates) {
    if (contrast(candidate, button) >= target) return candidate;
    if (contrast(candidate, button) > contrast(best, button)) best = candidate;
  }
  return best;
}

// 한 조합이 CSS 로 나갈 열세 쌍.
//
// 🔴 배경(`bg` · `surface`)과 `rule` 은 건드리지 않습니다. 배경을 옮기면 그
// 배경을 쓰는 다른 모든 색의 대비가 같이 움직여서 방금 맞춘 자리가 다시
// 어긋납니다.
//
// 🔴 판정의 입력은 **언제나 원본 팔레트**(`seen`)입니다. 고친 값을 다음 계산에
// 먹이면 결과가 목록의 순서에 딸려 갑니다. `seen` 과 `fixed` 를 따로 두는
// 까닭이 그것입니다.
export function correctedPalette(values, opts = {}) {
  const target = opts.target === undefined ? TARGET : opts.target;
  const labelTarget =
    opts.labelTarget === undefined ? LABEL_TARGET : opts.labelTarget;
  const seen = {};
  FIELDS.forEach((field, i) => { seen[field] = values[i]; });
  const fixed = { ...seen };
  for (const [field, need, keep] of CONTRAST_JOBS) {
    fixed[field] = corrected(seen[field], seen[need], seen[keep], target);
  }
  const baked = FIELDS.map((field) => [field, fixed[field]]);
  for (const [field, need, keep] of SURFACE_JOBS) {
    baked.push([`${field}-on-surface`,
                corrected(seen[field], seen[need], seen[keep], target)]);
  }
  const done = Object.fromEntries(baked);
  for (const [name, back] of LABEL_JOBS) {
    baked.push([name, labelOnAccent(seen, done[back], labelTarget)]);
  }
  return baked;
}

// 보정을 끈 열세 쌍. 🔴 대조군 전용입니다. `-on-surface` 는 원본과 같고 버튼
// 글자는 원래 글자색인 `surface` 입니다. 이것으로 `check` 를 돌려 어긋난 자리가
// 0보다 커야 보정이 일을 하고 있다는 뜻이 됩니다.
export function rawPalette(values) {
  const seen = {};
  FIELDS.forEach((field, i) => { seen[field] = values[i]; });
  const baked = FIELDS.map((field) => [field, seen[field]]);
  for (const [field] of SURFACE_JOBS) {
    baked.push([`${field}-on-surface`, seen[field]]);
  }
  for (const [name] of LABEL_JOBS) baked.push([name, seen.surface]);
  return baked;
}

export function palettePairs(values, opts = {}) {
  return opts.correct === false
    ? rawPalette(values)
    : correctedPalette(values, opts);
}

/* --------------------------------------------------- DESIGN.md 파싱 */

// 🔴 `\b` 를 유니코드로 씁니다. 파이썬의 `\b` 는 한글·악센트 글자도 낱말
// 글자로 보는데 JS 의 기본 `\b` 는 ASCII 만 봐서, 같은 문서에서 파이썬은 안
// 잡고 JS 는 잡는 줄이 생깁니다.
const HEX = /#[0-9a-fA-F]{6}(?![\p{L}\p{N}_])/gu;

// 파이썬 `str.splitlines()`. 🔴 `split("\n")` 이 아닙니다. 파이썬은 `\v` · `\f` ·
// `\x85` · `U+2028` 에서도 줄을 끊고, DESIGN.md 74건에 그런 글자가 하나라도
// 있으면 그 줄부터 결과가 갈립니다.
function pySplitlines(text) {
  if (text === "") return [];
  const out = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u{2028}\u{2029}]/u);
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

// 파이썬 `Path.read_text()` 의 universal newlines 를 흉내 냅니다. 이것을 빼면
// CRLF 문서에서 줄 끝에 `\r` 가 남아 `line.strip()` 과 정규식이 갈립니다.
function readDesign(path) {
  return readFileSync(path, "utf8").replace(/\r\n|\r/g, "\n");
}

// `colors:` YAML 블록. 🔴 들여쓰기가 없는 줄을 만나면 멈추지만 **빈 줄은
// 멈추지 않습니다** - 빈 줄에서 멈추면 블록 가운데가 통째로 날아갑니다.
export function parseYamlColors(text) {
  const head = /^colors:\s*$/m.exec(text);
  if (head === null) return new Map();
  const out = new Map();
  const body = text.slice(head.index + head[0].length);
  for (const line of pySplitlines(body)) {
    if (line.trim() && !(line.startsWith(" ") || line.startsWith("\t"))) break;
    const hit = /^\s+([a-z0-9-]+):\s*"?(#[0-9a-fA-F]{6})"?/.exec(line);
    // 🔴 YAML 쪽은 뒤에 온 값이 앞을 **덮습니다**. 산문 쪽과 반대입니다.
    if (hit) out.set(hit[1], hit[2].toLowerCase());
  }
  return out;
}

// 산문에서 역할을 추측합니다. 이름은 브랜드마다 달라도 설명에 쓰는 낱말
// (primary, background, text, border)은 겹칩니다. 74종 중 10종이 이쪽입니다.
//
// 🔴 `take()` 는 먼저 잡은 것을 **안 덮습니다**. 줄 순서가 결과를 정하므로
// 아래 호출 순서와 낱말 순서를 바꾸면 다른 팔레트가 나옵니다.
export function parseProseColors(text) {
  const out = new Map();
  for (const line of pySplitlines(text)) {
    const hexes = line.match(HEX);
    if (!hexes) continue;
    const low = line.toLowerCase();
    const value = hexes[0].toLowerCase();
    const take = (key, ...words) => {
      if (!out.has(key) && words.some((word) => low.includes(word))) {
        out.set(key, value);
      }
    };
    take("primary", "primary cta", "primary button", "brand accent",
         "primary brand", "brand color", "primary:");
    take("canvas", "background", "canvas", "page bg");
    take("ink", "text", "near-black", "headline", "foreground");
    take("hairline", "border", "divider", "hairline", "rule");
    take("muted", "muted", "secondary text", "subtle text", "gray");
    take("surface-card", "card", "surface", "panel");
    take("warning", "warning", "error", "danger");
  }
  return out;
}

// 역할 이름 -> 일곱 변수 둘(라이트, 다크).
//
// 🔴 문장의 **순서**가 결과를 정합니다. `dim` · `rule` 의 기본값은 `bg` 휘도
// 0.4 검사보다 **앞에서** 굽히므로 되돌리기 전의 `ink` · `bg` 를 씁니다. 반대로
// `d_*` 는 그 검사 **뒤라서** 되돌린 값을 씁니다. 줄을 옮기면 조용히 다른 색이
// 나옵니다.
//
// 🔴 대비는 fail-closed 입니다. 산문 파싱이 배경색을 글자색으로 집는 일이
// 있었습니다(`lovable`: 대비 1.00, 안 보이는 화면).
export function buildFromColors(colors) {
  const pick = (names, fallback) => {
    for (const name of names) if (colors.has(name)) return colors.get(name);
    return fallback;
  };
  const accent = pick(["primary", "accent", "brand"], "#0b6e99");
  let ink = pick(["ink", "body-strong", "charcoal", "text"], "#14232e");
  let bg = pick(["canvas", "canvas-soft", "surface-soft", "background"],
                "#eaeef2");
  let surface = pick(["surface-card", "surface-soft", "surface", "card"], WHITE);
  let dim = pick(["muted", "mute", "muted-soft", "body", "stone"],
                 mix(ink, bg, 0.45));
  const rule = pick(["hairline", "hairline-soft", "hairline-strong", "border"],
                    mix(ink, bg, 0.8));
  const warn = pick(["warning", "error", "danger"], "#9c4a12");

  // 🔴 `canvas` 가 이미 어두운 테마가 있습니다(다크 정체성 브랜드). 그대로
  // 두면 라이트 쪽이 다크가 되어 토글이 뒤집혀 보입니다.
  if (luminance(bg) < 0.4) {
    const nextBg = mix(bg, WHITE, 0.93);
    const nextInk = mix(ink, BLACK, 0.85);
    bg = nextBg;
    ink = nextInk;
    surface = WHITE;
  }

  const dBg = pick(["surface-dark", "surface-dark-soft"], mix(ink, BLACK, 0.55));
  const dSurface = pick(["surface-dark-elevated"], mix(dBg, WHITE, 0.07));
  let dInk = pick(["on-dark"], mix(bg, WHITE, 0.55));
  let dDim = pick(["on-dark-soft"], mix(dInk, dBg, 0.45));
  const dRule = mix(dInk, dBg, 0.78);
  // 어두운 배경에서 짙은 강조색은 가라앉습니다.
  const dAccent = luminance(accent) > 0.18 ? accent : mix(accent, WHITE, 0.35);
  const dWarn = pick(["warning", "error"], "#e0a04a");

  const readable = (fg, back) => (contrast(fg, back) >= 4.5
    ? fg
    : (luminance(back) > 0.5 ? BLACK : WHITE));
  ink = readable(ink, bg);
  dInk = readable(dInk, dBg);
  if (contrast(dim, bg) < 3.0) dim = mix(ink, bg, 0.35);
  if (contrast(dDim, dBg) < 3.0) dDim = mix(dInk, dBg, 0.35);

  return [[bg, surface, ink, dim, rule, accent, warn],
          [dBg, dSurface, dInk, dDim, dRule, dAccent, dWarn]];
}

// `ide-vscode` -> `Ide Vscode`. 두 글자 이하 낱말은 대문자입니다.
export function labelOf(slug) {
  const words = [];
  for (const word of slug.replace(/_/g, "-").split("-")) {
    if (!word) continue;
    words.push(word.length <= 2
      ? word.toUpperCase()
      : word.slice(0, 1).toUpperCase() + word.slice(1));
  }
  return words.join(" ");
}

// DESIGN.md 한 건을 테마로. 🔴 YAML 을 먼저 보고 없으면 산문입니다. 한쪽만
// 읽으면 열 개가 조용히 기본값으로 남습니다.
export function themeFromDesign(text) {
  let colors = parseYamlColors(text);
  let prose = false;
  if (colors.size === 0) {
    colors = parseProseColors(text);
    prose = true;
  }
  if (colors.size === 0) return null;
  const [light, dark] = buildFromColors(colors);
  return { light, dark, prose };
}

// 슬러그는 폴더 이름입니다. 파일을 직접 주면 확장자를 뗀 파일 이름이고,
// `DESIGN.md` 를 직접 주면 그 부모 폴더 이름입니다.
function slugForFile(path) {
  const name = basename(path);
  if (name.toLowerCase() === "design.md") return basename(dirname(path));
  return basename(name, extname(name));
}

// 테마 이름(슬러그)에 쓰는 글자. 🔴 이름은 CSS 선택자의 따옴표 안, 고르개의
// HTML 속성, `<script>` 안의 JSON 에 그대로 들어갑니다. `"` 나 `<` 가 든 폴더
// 이름 하나가 산출물을 깨거나 스크립트를 끼워 넣습니다. 글자와 숫자는 유니코드
// 전체(한글 폴더 이름 포함)를 받고, 기호는 `.` `-` `_` 만 받습니다. 빈칸, 제어
// 문자, 서식 문자(방향 바꿈 등), 줄 구분자는 글자가 아니라서 걸립니다. 번들
// 74종 중 다섯은 이름에 점이 있습니다(`x.ai` 등).
export const SLUG = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._-]*$/u;

// 🔴 보이지 않는 글자(Default_Ignorable. 예: U+3164 한글 채움 문자, U+FE0F 변형
// 선택자)는 글자로 분류돼도 받지 않습니다. 고르개에 빈칸처럼 보이거나 다른
// 이름과 똑같아 보이는 항목이 생깁니다.
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;

const SLUG_RULE = `may use only letters, digits, ".", "-" and "_" (no invisible characters)`;

export function validSlug(slug) {
  return SLUG.test(slug) && !INVISIBLE.test(slug);
}

// 🔴 산출물에 들어가는 이름은 모두 `resolveThemes` 의 목록에서 나옵니다.
// 출처(번들, DESIGN.md)와 상관없이 거기서 한 번 더 봅니다.
export function assertSlugs(names) {
  for (const slug of names) {
    if (!validSlug(slug)) {
      throw new Error(`theme name ${JSON.stringify(slug)} ${SLUG_RULE}`);
    }
  }
}

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

// `--design-md` 가 받는 세 모양: 파일 / `DESIGN.md` 를 담은 폴더 /
// `<이름>/DESIGN.md` 를 담은 폴더. [슬러그, 파일] 목록을 냅니다.
function designFiles(full) {
  if (statSync(full).isFile()) return [[slugForFile(full), full]];
  const own = join(full, "DESIGN.md");
  if (isFile(own)) return [[basename(full), own]];
  return readdirSync(full).sort()
    .map((entry) => [entry, join(full, entry, "DESIGN.md")])
    .filter(([, design]) => isFile(design));
}

export function loadDesignMd(path) {
  const out = [];
  for (const [raw, file] of designFiles(resolve(path))) {
    // 🔴 이름을 NFC 로 맞춥니다. macOS 는 한글 폴더 이름을 흔히 분해형(NFD)으로
    // 두어, 그대로 쓰면 사용자가 친 `--only 쇼핑몰`(NFC)과 맞지 않습니다.
    const slug = raw.normalize("NFC");
    // 🔴 걸러 버리지 않고 멈춥니다. 조용히 빠진 테마는 고르개에서 사라진 뒤에야
    // 들킵니다.
    if (!validSlug(slug)) {
      throw new Error(`--design-md ${JSON.stringify(file)}: theme name `
        + `${JSON.stringify(slug)} ${SLUG_RULE}`);
    }
    const theme = themeFromDesign(readDesign(file));
    if (theme === null) continue;
    out.push([slug, { label: labelOf(slug), light: theme.light,
                      dark: theme.dark, source: file }]);
  }
  return out;
}

/* ------------------------------------------------------------ 테마 모음 */

export function loadBundled(file = join(HERE, "..", "assets", "palettes.json")) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  // 🔴 `fields` 를 믿고 그대로 쓰지 않고 엔진의 순서와 맞는지 봅니다. 둘이
  // 어긋난 팔레트는 오류가 아니라 그냥 다른 테마라서 눈으로만 잡힙니다.
  if (data.fields.join(",") !== FIELDS.join(",")) {
    throw new Error(`palettes.json fields mismatch: ${data.fields.join(",")}`);
  }
  const themes = new Map();
  for (const slug of Object.keys(data.themes)) {
    const body = data.themes[slug];
    themes.set(slug, { label: body.label, light: body.light, dark: body.dark,
                       source: "bundled" });
  }
  return { themes, default: data.default, source: data.source };
}

// 번들 위에 `--design-md` 를 얹습니다. 🔴 뒤가 이기고, 같은 슬러그는 번들을
// 덮습니다. 그 덮기가 없으면 소비자가 자기 DESIGN.md 로 번들 테마를 고칠 수
// 없습니다. `bundled` 는 시험이 다른 번들을 넣을 때만 줍니다.
export function resolveThemes(opts, bundled = loadBundled()) {
  const themes = new Map(bundled.themes);
  for (const path of opts.designMd) {
    for (const [slug, theme] of loadDesignMd(path)) themes.set(slug, theme);
  }
  assertSlugs(themes.keys());
  let slugs = [...themes.keys()];
  if (opts.only !== null) {
    const allow = new Set(opts.only);
    slugs = slugs.filter((slug) => allow.has(slug));
  }
  slugs.sort();
  const picked = new Map(slugs.map((slug) => [slug, themes.get(slug)]));
  // 🔴 기본 테마가 걸러져 없으면 첫 슬러그입니다. 없는 이름을 `:root` 에
  // 박으면 화면이 색을 통째로 잃습니다.
  let fallback = opts.default === null ? bundled.default : opts.default;
  if (!picked.has(fallback)) fallback = slugs.length ? slugs[0] : null;
  return { themes: picked, default: fallback, source: bundled.source };
}

// 표시명 순서. 고르개가 보여 주는 순서와 `list` 를 같게 둡니다.
export function byLabel(themes) {
  return [...themes.entries()].sort((one, other) => {
    const a = one[1].label.toLowerCase();
    const b = other[1].label.toLowerCase();
    if (a < b) return -1;
    if (a > b) return 1;
    return one[0] < other[0] ? -1 : (one[0] > other[0] ? 1 : 0);
  });
}

// 🔴 저장된 이름을 닫힌 집합에 대어 봅니다. 없으면 기본으로 되돌립니다.
// 이것이 없으면 테마 하나를 지운 다음 배포에서, 그 테마를 고른 사람의 화면이
// 변수를 잃고 색 없이 뜹니다.
export function pickTheme(saved, allowed, fallback) {
  const list = Array.isArray(allowed) ? allowed : [...allowed];
  return list.includes(saved) ? saved : fallback;
}

/* ----------------------------------------------------- 무리와 설명 */

// 인자 없이 부른 스킬이 사용자에게 테마를 고르게 할 때 쓰는 글. 🔴 전부 색
// 값에서 계산합니다. 손으로 쓴 설명도, DESIGN.md 의 글도 없습니다. 그래서 번들
// 74종과 `--design-md` 로 더한 테마가 같은 규칙을 따르고, 같은 입력이면 같은
// 글이 나옵니다.

// 첫 질문의 무리 넷. 🔴 기준은 번들 74종의 실제 분포를 보고 정했습니다
// (순서대로 18, 14, 19, 23). 강조색이 무채색인 테마가 32종이라 그것을 바탕
// 밝기로 둘로 가릅니다. 회색 바탕은 대개 어두운 바탕이 정체성인 브랜드를
// 라이트로 되돌린 것입니다. 색이 있는 강조색은 색조 75도 아래와 330도 이상이
// 따뜻한 쪽입니다.
export const GROUPS = [
  { id: "minimal", label: "밝은 미니멀", summary: "흰 바탕에 무채색 강조색" },
  { id: "mono", label: "회색 모노톤", summary: "회색이나 미색 바탕에 무채색 강조색" },
  { id: "warm", label: "따뜻한 강조색", summary: "빨강, 주황, 노랑 계열 강조색" },
  { id: "cool", label: "차가운 강조색", summary: "초록, 파랑, 보라 계열 강조색" },
];

// [이 각도 아래, 이름]. 색조는 0~360 도입니다. 🔴 경계는 `<` 입니다. 순수
// 파랑(`#0000ff`)이 정확히 240도라서 "파랑" 칸은 245 까지입니다.
const HUE_NAMES = [
  [8, "빨강"], [20, "주황빛 빨강"], [42, "주황"], [47, "노란빛 주황"],
  [70, "노랑"], [100, "연두"], [165, "초록"], [190, "청록"],
  [205, "청록빛 파랑"], [245, "파랑"], [258, "보랏빛 파랑"], [285, "보라"],
  [320, "자주"], [340, "분홍"], [352, "분홍빛 빨강"], [360, "빨강"],
];

// 색조만으로는 틀리는 이름. [맞는지, 이름]이고 앞에서부터 봅니다. 어두운 주황은
// 갈색(`#8b4513`), 채도가 낮은 어두운 빨강은 적갈색(`#a52a2a`), 어두운 노랑과
// 연두는 올리브색, 어두운 파랑은 남색, 밝은 빨강은 분홍, 밝은 청록빛 파랑은
// 하늘색입니다. `h` 는 색조(도), `l` 은 HLS 명도, `s` 는 HLS 채도입니다.
const SHADE_NAMES = [
  [(h, l) => l < 0.45 && h >= 10 && h < 45, "갈색"],
  [(h, l, s) => l < 0.45 && s < 0.7 && (h < 10 || h >= 345), "적갈색"],
  [(h, l) => l < 0.35 && h >= 45 && h < 90, "올리브색"],
  [(h, l) => l < 0.3 && h >= 205 && h < 250, "남색"],
  [(h, l) => l > 0.7 && (h < 10 || h >= 330), "분홍"],
  [(h, l) => l > 0.7 && h >= 185 && h < 215, "하늘색"],
];

// 바탕에 살짝 도는 기운. 채도가 낮은 바탕에만 씁니다.
const TINTS = [[30, "붉은"], [75, "누런"], [165, "초록"], [280, "푸른"],
               [330, "보라"], [360, "붉은"]];

// 흰 바탕으로 보는 휘도. `#faf9f5`(0.947) 는 흰 바탕이고 `#f5f5f5`(0.91) 는
// 밝은 회색입니다. 무리(`minimal`)와 설명("흰 바탕")이 같은 값을 씁니다.
const WHITE_BG = 0.93;

// [이 휘도 이상, 바탕 밝기]. 무채색 바탕에만 씁니다.
const BG_LEVELS = [[WHITE_BG, "흰"], [0.75, "밝은 회색"], [0.4, "중간 회색"],
                   [0.03, "어두운 회색"], [0, "검정에 가까운"]];

// [이 HLS 명도 이상, 이름]. 무채색 강조색에만 씁니다.
const GREY_NAMES = [[0.95, "흰색"], [0.7, "밝은 회색"], [0.4, "회색"],
                    [0.15, "짙은 회색"], [0, "검정"]];

// 🔴 무채색은 HLS 의 s 가 아니라 채널 최댓값과 최솟값의 차이로 봅니다. HLS 의
// s 는 거의 검정인 색(`#181d26`, s 0.23)도 높게 잡아 검정을 색으로 부릅니다.
// 🔴 이 한 값을 무리("무채색 강조색")와 색 이름이 함께 씁니다. 둘이 다르면
// 무채색 무리의 설명이 색 이름을 말합니다.
const MUTED_CHROMA = 0.15;
// 바탕의 기운은 채널 차이 4/255 부터 봅니다. `#faf9f5`(5/255)는 누런 기가 돌고
// `#f7f7f4`(3/255)는 돌지 않습니다.
const TINT_CHROMA = 0.015;

function colorShape(value) {
  const chans = channels(value.toLowerCase());
  const [hue, light, sat] = rgbToHls(...chans);
  return { hue: hue * 360, light, sat,
           chroma: Math.max(...chans) - Math.min(...chans) };
}

function firstBelow(table, degree) {
  return table.find(([upper]) => degree < upper)[1];
}

function firstAtLeast(table, value) {
  return table.find(([floor]) => value >= floor)[1];
}

function warmHue(degree) {
  return degree < 75 || degree >= 330;
}

// `#ff385c` -> `분홍빛 빨강`. 무채색이면 회색 이름을 씁니다.
export function colorName(value) {
  const { hue, light, sat, chroma } = colorShape(value);
  if (chroma < MUTED_CHROMA) return firstAtLeast(GREY_NAMES, light);
  const shade = SHADE_NAMES.find(([fits]) => fits(hue, light, sat));
  if (shade) return shade[1];
  const name = firstBelow(HUE_NAMES, hue);
  if (light < 0.3) return `짙은 ${name}`;
  return light > 0.7 ? `연한 ${name}` : name;
}

function bgPhrase(value) {
  const { hue, chroma } = colorShape(value);
  if (chroma >= MUTED_CHROMA) return `${colorName(value)} 바탕`;
  const level = firstAtLeast(BG_LEVELS, luminance(value.toLowerCase()));
  if (chroma < TINT_CHROMA) return `${level} 바탕`;
  return `${firstBelow(TINTS, hue)} 기가 도는 ${level} 바탕`;
}

// 🔴 무리는 기본 보정을 거친 라이트 강조색으로 정합니다. CSS 로 나가는 색이
// 그것이라서입니다. `resend` 의 원래 강조색 `#fcfdff` 은 거의 흰색이지만 보정이
// 명도만 내려 파랑이 됩니다. `--target`, `--no-correct` 는 보지 않습니다. 옵션
// 하나에 테마의 무리가 바뀌면 안 됩니다.
export function groupOf(light) {
  const accent = colorShape(Object.fromEntries(correctedPalette(light)).accent);
  if (accent.chroma < MUTED_CHROMA) {
    return luminance(light[0].toLowerCase()) >= WHITE_BG ? "minimal" : "mono";
  }
  return warmHue(accent.hue) ? "warm" : "cool";
}

function bodyContrast(out) {
  const ratio = contrast(out.ink, out.bg);
  const word = ratio >= 7 ? "높음" : (ratio >= 4.5 ? "보통" : "낮음");
  return `본문 대비 ${ratio.toFixed(1)}:1(${word})`;
}

function modeText(values, opts) {
  const out = Object.fromEntries(palettePairs(values, opts));
  return `${bgPhrase(out.bg)}, ${colorName(out.accent)} 강조색, ${bodyContrast(out)}`;
}

// 🔴 설명은 CSS 로 나가는 값(보정 뒤)을 말합니다. 원본 값을 말하면 보정이
// 옮긴 강조색(`bmw-m` 의 흰색)을 사용자가 고른 뒤에야 다른 색으로 봅니다.
export function describeTheme(theme, opts = {}) {
  return `${modeText(theme.light, opts)}. 다크는 ${modeText(theme.dark, opts)}`;
}

// 선택지 옆에 보일 고정폭 블록. 🔴 코드 펜스로 감쌉니다. 질문 도구의 미리보기는
// 마크다운이라 펜스 밖에서는 줄과 칸 맞춤이 무너집니다.
export function previewOf(theme, opts = {}) {
  const row = (name, values) => {
    const out = Object.fromEntries(palettePairs(values, opts));
    return `${name.padEnd(7)}${["bg", "surface", "ink", "accent"]
      .map((field) => out[field]).join("  ")}`;
  };
  return ["```", "       bg       surface  ink      accent",
          row("light", theme.light), row("dark", theme.dark), "```"].join("\n");
}

// 겹치지 않는 표시명. 🔴 질문 도구는 고른 선택지의 이름을 돌려주므로 이름이
// 겹치면 어느 테마인지 정할 수 없습니다. `labelOf` 는 `-` 와 `_` 를 같게 보고
// (`ide-vscode`, `ide_vscode`), 맞춰 보기는 대소문자를 보지 않으므로(`Airbnb`
// 폴더와 번들 `airbnb`) NFC 로 맞춘 소문자가 같으면 겹침입니다. 겹치는 것마다
// ` (슬러그)` 를 붙입니다. 슬러그에는 빈칸과 괄호가 없어 붙인 이름끼리, 또는 붙인
// 이름과 다른 표시명이 다시 겹치지 않습니다. `--json` 없는 `list` 는 그대로입니다.
function uniqueLabels(entries) {
  const key = (label) => label.normalize("NFC").toLowerCase();
  const seen = new Map();
  for (const [, theme] of entries) {
    seen.set(key(theme.label), (seen.get(key(theme.label)) || 0) + 1);
  }
  return new Map(entries.map(([slug, theme]) => [slug,
    seen.get(key(theme.label)) > 1 ? `${theme.label} (${slug})` : theme.label]));
}

// `list --json`. 테마 순서는 `list` 와 같고, 무리 안 순서도 그것을 따릅니다.
// 빈 무리는 내지 않습니다. 질문 도구는 선택지가 둘 이상이어야 합니다.
export function renderListJson(resolved, opts = {}) {
  const entries = byLabel(resolved.themes);
  const labels = uniqueLabels(entries);
  const themes = entries.map(([slug, theme]) => ({
    slug, label: labels.get(slug), group: groupOf(theme.light),
    description: describeTheme(theme, opts), preview: previewOf(theme, opts),
  }));
  const groups = GROUPS.map((group) => {
    const slugs = themes.filter((theme) => theme.group === group.id)
      .map((theme) => theme.slug);
    return { ...group, count: slugs.length, slugs };
  }).filter((group) => group.count > 0);
  return JSON.stringify({ groups, themes }, null, 2);
}

/* ------------------------------------------------------------- 산출물 */

function declarations(pairs, prefix) {
  return pairs.map(([name, value]) => `--${prefix}${name}:${value}`).join(";");
}

// `--dark-via` 가 고른 자리에 다크 규칙을 겁니다. `base` 는 라이트 규칙의
// 선택자입니다.
function darkRule(base, body, darkVia) {
  if (darkVia === "media") return `@media (prefers-color-scheme: dark){${base}{${body}}}`;
  if (darkVia === "class") return `${base}.dark{${body}}`;
  return `${base}[data-mode="dark"]{${body}}`;
}

export function renderCss(resolved, opts) {
  const { prefix, darkVia } = opts;
  const out = [];
  // 🔴 `:root` 가 언제나 먼저이고 기본 테마의 라이트와 다크를 둘 다 듭니다.
  // 테마 규칙은 `html[data-theme=...]` 이 붙어 같은 모드의 `:root` 규칙보다
  // 특정성이 높아 이깁니다. `:root` 를 두는 까닭은 JS 가 꺼졌거나 저장된 이름이
  // 목록 밖일 때도 화면이 읽히게 하는 것입니다. 다크가 빠지면 고르개 없이
  // 모드만 쓰는 화면(`<html>` 에 `data-theme` 이 없음)에서 다크가 켜지지 않습니다.
  if (resolved.default !== null) {
    const base = resolved.themes.get(resolved.default);
    out.push(`:root{${declarations(palettePairs(base.light, opts), prefix)}}`);
    out.push(darkRule(":root", declarations(palettePairs(base.dark, opts), prefix),
                      darkVia));
  }
  for (const [slug, theme] of [...resolved.themes.entries()].sort()) {
    const selector = `html[data-theme="${slug}"]`;
    out.push(`${selector}{${declarations(palettePairs(theme.light, opts), prefix)}}`);
    out.push(darkRule(selector,
                      declarations(palettePairs(theme.dark, opts), prefix), darkVia));
  }
  out.push("/* 그림자는 모드의 성질입니다. 테마마다 두면 같은 값이 반복됩니다. */");
  out.push(`html{--${prefix}shadow:${SHADOW_LIGHT}}`);
  out.push(darkRule("html", `--${prefix}shadow:${SHADOW_DARK}`, darkVia));
  return out.join("\n");
}

export function renderJson(resolved, opts) {
  const themes = {};
  for (const [slug, theme] of [...resolved.themes.entries()].sort()) {
    const asObject = (values) => Object.fromEntries(
      palettePairs(values, opts).map(([name, value]) =>
        [`${opts.prefix}${name}`, value]));
    themes[slug] = { label: theme.label, light: asObject(theme.light),
                     dark: asObject(theme.dark) };
  }
  return JSON.stringify({
    names: OUT_NAMES.map((name) => `${opts.prefix}${name}`),
    default: resolved.default,
    corrected: opts.correct !== false,
    target: opts.target,
    labelTarget: opts.labelTarget,
    source: resolved.source,
    themes,
  }, null, 2);
}

function esc(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 고르개 마크업. 테마 목록이 닫힌 집합으로 박혀 있습니다.
//
// 🔴 `--dark-via media` 면 모드 버튼을 내지 않습니다. 그 CSS 의 다크는 OS 설정만
// 따르고, 버튼은 그것을 바꿀 수 없어서 눌러도 아무 일이 없는 버튼이 됩니다.
function widgetMarkup(entries, darkVia) {
  const options = entries
    .map(([slug, theme]) =>
      `    <option value="${esc(slug)}">${esc(theme.label)}</option>`)
    .join("\n");
  const button = darkVia === "media" ? "" : `
  <button id="theme-mode" type="button" aria-pressed="false"
          aria-label="Dark mode">Dark</button>`;
  return `<!-- 1. 고르개 마크업. 테마 목록이 닫힌 집합으로 박혀 있습니다. -->
<div class="theme-pick-wrap">
  <select id="theme-pick" aria-label="Theme">
${options}
  </select>${button}
</div>`;
}

// head 스크립트. 닫힌 집합과 기본 테마를 박아 넣습니다.
function widgetHead(slugs, fallback) {
  return `<!-- 2. head 스크립트. 🔴 <head> 안에 두십시오. DOM 을 보지 않으므로 즉시 돌고,
     그것이 첫 그림의 깜빡임을 막는 유일한 방법입니다. 본문 뒤로 옮기면 기본
     테마가 한 프레임 보인 다음 바뀝니다. -->
<script>
(function () {
  // 🔴 닫힌 집합입니다. 저장된 이름을 여기에 대어 보고 없으면 기본으로
  // 되돌립니다. 대어 보지 않으면 지워진 테마를 고른 사람의 화면이 색을
  // 통째로 잃습니다.
  var THEMES = ${JSON.stringify(slugs)};
  var FALLBACK = ${JSON.stringify(fallback)};
  function pickTheme(saved, allowed, fallback) {
    return allowed.indexOf(saved) >= 0 ? saved : fallback;
  }
  var root = document.documentElement;
  var saved = null, mode = null;
  try {
    saved = localStorage.getItem("theme");
    mode = localStorage.getItem("mode");
  } catch (err) { /* 저장소가 막힌 브라우저. 기본값으로 갑니다. */ }
  root.setAttribute("data-theme", pickTheme(saved, THEMES, FALLBACK));
  root.setAttribute("data-mode", mode === "dark" ? "dark" : "light");
  // 🔴 .dark 클래스도 같이 겁니다. --dark-via class 로 낸 CSS 는 이것만 봅니다.
  root.classList.toggle("dark", mode === "dark");
  window.__themePick = pickTheme;
  window.__themeList = THEMES;
  window.__themeFallback = FALLBACK;
})();
</script>`;
}

// 배선 스크립트. 박아 넣을 값이 없어 상수입니다.
const WIDGET_WIRE = `<!-- 3. 배선 스크립트.
     🔴 경고: 이 스크립트는 자기가 배선할 마크업보다 **먼저 돌 수 있습니다.**
     그러면 getElementById 가 빈손이고 고르개가 영원히 안 움직입니다
     (실제 배포에서 두 번 났습니다). readyState 를 보고 즉시 또는
     DOMContentLoaded 에서 부르는 래퍼로 감쌉니다. -->
<script>
(function () {
  function wire() {
    var root = document.documentElement;
    var pick = document.getElementById("theme-pick");
    var mode = document.getElementById("theme-mode");
    function save(key, value) {
      try { localStorage.setItem(key, value); } catch (err) { /* 막힌 저장소 */ }
    }
    if (pick) {
      pick.value = root.getAttribute("data-theme");
      pick.addEventListener("change", function () {
        var next = (window.__themePick || function (s) { return s; })(
          pick.value, window.__themeList || [], window.__themeFallback);
        root.setAttribute("data-theme", next);
        save("theme", next);
      });
    }
    if (mode) {
      var paint = function () {
        // 🔴 저장하는 값은 "light" 와 "dark" 둘뿐입니다.
        var dark = root.getAttribute("data-mode") === "dark";
        mode.setAttribute("aria-pressed", dark ? "true" : "false");
        mode.textContent = dark ? "Light" : "Dark";
      };
      paint();
      mode.addEventListener("click", function () {
        var next = root.getAttribute("data-mode") === "dark" ? "light" : "dark";
        root.setAttribute("data-mode", next);
        root.classList.toggle("dark", next === "dark");
        save("mode", next);
        paint();
      });
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
</script>`;

// 🔴 세 덩이는 빈 줄 하나로 가릅니다. 두는 곳이 서로 달라서(마크업 자리,
// <head>, 마크업 뒤) 한 덩이로 합치지 않습니다. 모드 버튼은 `data-mode` 와
// `.dark` 를 함께 바꾸므로 `--dark-via attr` 와 `class` CSS 에 모두 맞습니다.
//
// 🔴 `<script>` 안의 JSON 에는 이름만 들어갑니다. 이름은 `resolveThemes` 가
// SLUG 로 검사해 `<`, `/`, 줄 구분자가 없으므로 따로 이스케이프하지 않습니다.
export function renderWidget(resolved, opts = {}) {
  const entries = byLabel(resolved.themes);
  const slugs = entries.map(([slug]) => slug);
  return [widgetMarkup(entries, opts.darkVia), widgetHead(slugs, resolved.default),
          WIDGET_WIRE].join("\n\n");
}

/* ---------------------------------------------------------------- check */

// 조합마다 재는 자리. 🔴 본문 대비(`ink` 대 `bg`)는 **보고만** 하고 판정하지
// 않습니다. 팔레트 74개를 전부 4.5 로 끌어올리면 테마가 테마가 아닙니다.
export function auditCombo(values, pairs, opts) {
  const target = opts.target;
  const labelTarget = opts.labelTarget;
  const seen = {};
  FIELDS.forEach((field, i) => { seen[field] = values[i]; });
  const out = Object.fromEntries(pairs);
  const rows = [];
  const add = (spot, fg, bg, need) => {
    rows.push({ spot, fg, bg, got: contrast(fg, bg), need });
  };
  add("accent vs bg", out.accent, seen.bg, target);
  // 🔴 하한은 `min(원래 대비, 목표)` 입니다. 더 좋아지라고 요구하지 않습니다.
  add("accent vs surface(keep)", out.accent, seen.surface,
      Math.min(contrast(seen.accent, seen.surface), target));
  for (const [field] of SURFACE_JOBS) {
    const value = out[`${field}-on-surface`];
    add(`${field}-on-surface vs surface`, value, seen.surface, target);
    add(`${field}-on-surface vs bg(keep)`, value, seen.bg,
        Math.min(contrast(seen[field], seen.bg), target));
  }
  for (const [name, back] of LABEL_JOBS) {
    add(`${name} vs ${back}`, out[name], out[back], labelTarget);
  }
  return {
    rows,
    body: contrast(out.ink, seen.bg),
    bad: rows.filter((row) => row.got < row.need - 1e-9),
  };
}

export function audit(resolved, opts) {
  const combos = [];
  let checks = 0;
  const bad = [];
  for (const [slug, theme] of [...resolved.themes.entries()].sort()) {
    for (const [mode, values] of [["light", theme.light], ["dark", theme.dark]]) {
      const pairs = palettePairs(values, opts);
      const seen = auditCombo(values, pairs, opts);
      checks += seen.rows.length;
      combos.push({ slug, mode, body: seen.body, bad: seen.bad });
      for (const row of seen.bad) bad.push({ slug, mode, ...row });
    }
  }
  return { themes: resolved.themes.size, combos: combos.length, checks, bad,
           corrected: opts.correct !== false, detail: combos };
}

/* ------------------------------------------------------------------ CLI */

const COMMANDS = new Set(["list", "css", "json", "widget", "check"]);
const DARK_VIA = new Set(["attr", "media", "class"]);
const JSON_COMMANDS = new Set(["check", "list"]);

// `--prefix` 에 쓰는 글자. 🔴 접두사는 `--<접두사><이름>` 에 그대로 들어갑니다.
// `;` 나 `}` 가 들면 그 뒤 선언이 통째로 깨집니다. 기본은 빈 문자열입니다.
const PREFIX = /^[A-Za-z0-9_-]*$/;

const USAGE = `node scripts/themes.mjs <list|css|json|widget|check> [options]

  --design-md PATH    DESIGN.md 를 읽어 테마를 더하거나 덮는다 (여러 번 가능)
  --only SLUGS        쉼표로 가른 허용 목록
  --default SLUG      :root 가 들 테마 (기본 superhuman)
  --prefix STR        변수 이름 앞에 붙는다 (영문, 숫자, -, _)
  --dark-via MODE     attr | media | class
  --target N          -on-surface 와 accent 의 목표 (기본 3.0)
  --label-target N    버튼 글자 목표 (기본 4.5)
  --no-correct        원본 값을 그대로 낸다 (대조군 전용)
  --out FILE          표준출력 대신 파일로
  --json              check 와 list 에서만. 기계가 읽는 감사 결과, 무리와 설명`;

class ArgError extends Error {}

function takeValue(flag, rest) {
  if (!rest.length) throw new ArgError(`${flag} needs a value`);
  return rest.shift();
}

function positive(flag, text) {
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ArgError(`${flag} needs a positive number, got ${text}`);
  }
  return value;
}

function darkVia(text) {
  if (!DARK_VIA.has(text)) {
    throw new ArgError(`--dark-via must be attr|media|class`);
  }
  return text;
}

function prefixOf(text) {
  if (!PREFIX.test(text)) {
    throw new ArgError(`--prefix may use only letters, digits, "-" and "_",`
                       + ` got ${JSON.stringify(text)}`);
  }
  return text;
}

// 값을 받는 옵션. 🔴 다음 인자는 `-` 로 시작해도 값입니다(`--prefix -x`).
const VALUE_OPTIONS = new Map([
  ["--design-md", (opts, value) => { opts.designMd.push(value); }],
  // 🔴 이름은 NFC 로 맞춥니다. 슬러그도 NFC 라 분해형으로 친 한글 이름이
  // 말없이 걸러지지 않습니다.
  ["--only", (opts, value) => {
    opts.only = value.split(",").map((s) => s.trim().normalize("NFC")).filter(Boolean);
  }],
  ["--default", (opts, value) => { opts.default = value.normalize("NFC"); }],
  ["--prefix", (opts, value) => { opts.prefix = prefixOf(value); }],
  ["--dark-via", (opts, value) => { opts.darkVia = darkVia(value); }],
  ["--target", (opts, value) => { opts.target = positive("--target", value); }],
  ["--label-target", (opts, value) => {
    opts.labelTarget = positive("--label-target", value);
  }],
  ["--out", (opts, value) => { opts.out = value; }],
]);

const FLAG_OPTIONS = new Map([
  ["--no-correct", (opts) => { opts.correct = false; }],
  ["--json", (opts) => { opts.json = true; }],
  ["-h", (opts) => { opts.command = "help"; }],
  ["--help", (opts) => { opts.command = "help"; }],
]);

function applyArg(opts, arg, rest) {
  if (VALUE_OPTIONS.has(arg)) VALUE_OPTIONS.get(arg)(opts, takeValue(arg, rest));
  else if (FLAG_OPTIONS.has(arg)) FLAG_OPTIONS.get(arg)(opts);
  else if (arg.startsWith("-")) throw new ArgError(`unknown option ${arg}`);
  else if (opts.command === null) opts.command = arg;
  else throw new ArgError(`unexpected argument ${arg}`);
}

function checkCommand(opts) {
  if (opts.command === "help") return;
  if (opts.command === null) throw new ArgError("no command");
  if (!COMMANDS.has(opts.command)) {
    throw new ArgError(`unknown command ${opts.command}`);
  }
  if (opts.json && !JSON_COMMANDS.has(opts.command)) {
    throw new ArgError("--json is for check and list only");
  }
}

export function parseArgs(argv) {
  const opts = { command: null, designMd: [], only: null, default: null,
                 prefix: "", darkVia: "attr", target: TARGET,
                 labelTarget: LABEL_TARGET, correct: true, out: null,
                 json: false };
  const rest = [...argv];
  while (rest.length) applyArg(opts, rest.shift(), rest);
  checkCommand(opts);
  return opts;
}

// 🔴 `--out` 이 심볼릭 링크면 쓰지 않습니다. 링크를 따라가면 프로젝트 밖의
// 파일을 덮거나, 끊긴 링크가 가리키는 자리에 새 파일을 만듭니다.
function refuseLink(path) {
  let link = false;
  try {
    link = lstatSync(path).isSymbolicLink();
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (link) {
    throw new Error(`--out ${JSON.stringify(path)} is a symbolic link; not writing through it`);
  }
}

function emit(text, out) {
  if (out === null) {
    process.stdout.write(`${text}\n`);
    return;
  }
  // 🔴 `--out` 은 css 뿐 아니라 json · widget · list 에서도 돕니다. 산출물을
  // 파일로 받는 쪽이 명령마다 다르면 쓰는 사람이 외울 것이 늘어납니다.
  const path = resolve(out);
  refuseLink(path);
  writeFileSync(path, `${text}\n`);
}

const RENDER = new Map([
  // 🔴 `--json` 이 없는 `list` 는 `슬러그<탭>표시명` 그대로입니다. 그 두 칸을
  // 읽는 쪽이 있습니다. 무리와 설명은 `--json` 에만 더합니다.
  ["list", (resolved, opts) => (opts.json ? renderListJson(resolved, opts)
    : byLabel(resolved.themes)
      .map(([slug, theme]) => `${slug}\t${theme.label}`).join("\n"))],
  ["css", renderCss],
  ["json", renderJson],
  ["widget", renderWidget],
]);

function checkText(report) {
  const lines = report.bad.map((row) =>
    `FAIL ${row.slug}/${row.mode} ${row.spot} ${row.fg} on ${row.bg}`
    + ` ${row.got.toFixed(2)} < ${row.need.toFixed(2)}`);
  lines.push(`check: themes ${report.themes} combos ${report.combos}`
             + ` checks ${report.checks}`
             + ` corrected ${report.corrected ? "on" : "off"}`
             + ` violations ${report.bad.length}`);
  return lines.join("\n");
}

function checkJson(report) {
  return JSON.stringify({
    themes: report.themes, combos: report.combos, checks: report.checks,
    corrected: report.corrected, violations: report.bad.length,
    bad: report.bad, detail: report.detail.map((row) => ({
      slug: row.slug, mode: row.mode, body: row.body,
      violations: row.bad.length })),
  }, null, 2);
}

// [내보낼 글, 종료 코드]. 🔴 1 을 낼 수 있는 것은 `check` 뿐입니다.
function output(resolved, opts) {
  if (opts.command !== "check") {
    return [RENDER.get(opts.command)(resolved, opts), 0];
  }
  const report = audit(resolved, opts);
  return [opts.json ? checkJson(report) : checkText(report),
          report.bad.length ? 1 : 0];
}

function parseOrNull(argv) {
  try {
    return parseArgs(argv);
  } catch (err) {
    if (!(err instanceof ArgError)) throw err;
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    return null;
  }
}

function resolveOrNull(opts) {
  let resolved;
  try {
    resolved = resolveThemes(opts);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return null;
  }
  if (resolved.default === null) {
    process.stderr.write("no themes left after --only\n");
    return null;
  }
  return resolved;
}

export function main(argv) {
  const opts = parseOrNull(argv);
  if (opts === null) return 2;
  if (opts.command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const resolved = resolveOrNull(opts);
  if (resolved === null) return 2;
  const [text, code] = output(resolved, opts);
  // 🔴 `--out` 을 못 쓰면 2 입니다. 던지게 두면 종료 코드가 1 이 되어 `check`
  // 의 "어긋남" 과 구별되지 않습니다.
  try {
    emit(text, opts.out);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  return code;
}

// 🔴 직접 실행일 때만 돕니다. import 쪽에서 최상위 실행이 일어나면 자기 시험이
// 엔진을 부를 때마다 CLI 가 딸려 돌고 종료 코드까지 섞입니다.
//
// 🔴 두 경로를 모두 `realpathSync` 로 비교합니다. Node 는 `import.meta.url` 에
// 링크를 푼 실제 경로를 주고, `process.argv[1]` 은 부른 경로 그대로 둡니다.
// 플러그인 캐시, macOS 의 `/tmp`, Windows junction 처럼 링크가 낀 경로로 부르면
// 한쪽만 푼 비교는 거짓이 되어 CLI 가 아무것도 내지 않고 종료 코드 0 으로
// 끝납니다.
function invokedDirectly() {
  // realpath 가 읽지 못하는 경로는 resolve 로 비교합니다. false 로 답하면 CLI 가 아무것도 내지 않고 종료 코드 0 으로 끝납니다.
  const ranAs = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return Boolean(process.argv[1]) && ranAs(process.argv[1]) === ranAs(fileURLToPath(import.meta.url));
}

// 🔴 읽는 쪽이 먼저 닫히면(`json | head`) 남은 쓰기가 EPIPE 로 끝납니다. 받지
// 않으면 스택 추적과 함께 종료 코드 1(`check` 의 "어긋남" 과 같은 값)이 됩니다.
// EPIPE 만 받아 이미 정한 종료 코드로 끝내고, 다른 오류는 그대로 던집니다.
export function onStdoutError(err, exit = (code) => process.exit(code)) {
  if (err && err.code === "EPIPE") {
    exit(process.exitCode ?? 0);
    return;
  }
  throw err;
}

// 🔴 `process.exit()` 가 아니라 `process.exitCode` 입니다. `process.exit()` 는
// 표준출력에 남은 쓰기를 기다리지 않습니다. 표준출력이 파이프이면 64KiB 를
// 넘는 출력이 잘립니다. 번들 전체의 `json`(약 70KB)이 65,536 바이트에서 잘려
// 깨진 JSON 이 되는 것을 Linux 와 macOS 의 Node 22, 24 에서 확인했습니다.
// 에이전트는 출력을 파이프로 받습니다.
if (invokedDirectly()) {
  process.stdout.on("error", onStdoutError);
  process.exitCode = main(process.argv.slice(2));
}
