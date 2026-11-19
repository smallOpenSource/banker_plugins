// 테마 엔진의 자기 시험. `node:test` 와 Node 내장 모듈만 씁니다.
// 의존성 0건이고 파이썬을 부르지 않습니다 - 소비자 기계에는 node 밖에 없습니다.
// 저장소 루트에서:
//
//     node --test skills/theme-selection/scripts/themes.test.mjs
//
// 🔴 기대값은 구현 출력에서 베낀 것이 아니라 파이썬 원본(대비 보정, DESIGN.md
// 읽기)의 의미에서 끌어냈습니다. 경계 입력을 고른 근거는 각 시험 위 주석에
// 적습니다.
//
// 🔴 11 · 12 · 13 번은 **번들 148 조합으로 가려지지 않는** 세 자리입니다.
// 번들 전체를 파이썬과 대조해도 그 셋은 둘 다 같은 답을 내므로, 그 자리를
// 지키는 것은 이 세 시험뿐입니다. 느슨하게 고치면 검사가 사라집니다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, rmdirSync,
  symlinkSync, unlinkSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FIELDS, OUT_NAMES, SURFACE_JOBS, TARGET, LABEL_TARGET, WHITE, BLACK, SLUG, validSlug,
  contrast, luminance, withLightness, pyround, mix,
  corrected, correctedPalette, palettePairs, labelOnAccent,
  parseYamlColors, parseProseColors, themeFromDesign, labelOf, loadDesignMd,
  loadBundled, resolveThemes, pickTheme, byLabel, assertSlugs, onStdoutError,
  renderCss, renderJson, renderWidget, audit, parseArgs,
  GROUPS, groupOf, colorName, describeTheme, previewOf,
} from "./themes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "themes.mjs");

/* ------------------------------------------------------------------ 도구 */

// 조합 하나를 (원본 7값, 보정된 이름->값) 으로. 판정의 입력은 언제나 원본입니다.
function combo(values, opts = {}) {
  const seen = {};
  FIELDS.forEach((field, i) => { seen[field] = values[i]; });
  return { seen, out: Object.fromEntries(palettePairs(values, opts)) };
}

function allCombos() {
  const rows = [];
  for (const [slug, theme] of loadBundled().themes) {
    rows.push([slug, "light", theme.light], [slug, "dark", theme.dark]);
  }
  return rows;
}

/* ------------------------------------------------- 1. 번들 테마와 조합 수 */

test("번들은 테마 74종 · 조합 148 이고 조합마다 쌍 13개를 낸다", () => {
  const bundled = loadBundled();
  assert.equal(bundled.themes.size, 74);
  assert.equal(bundled.default, "superhuman");
  let combos = 0;
  for (const [slug, mode, values] of allCombos()) {
    assert.equal(values.length, FIELDS.length, `${slug}/${mode} 팔레트 7값`);
    const pairs = palettePairs(values);
    assert.equal(pairs.length, 13, `${slug}/${mode} 쌍 13개`);
    assert.deepEqual(pairs.map(([name]) => name), OUT_NAMES,
                     `${slug}/${mode} 이름과 순서`);
    combos += 1;
  }
  assert.equal(combos, 148);
  assert.equal(OUT_NAMES.length, 13);
});

/* ------------------------------------------------- 2. 보정을 켜면 0 건 */

test("보정을 켜면 어긋난 자리가 0건이다", () => {
  const opts = parseArgs(["check"]);
  const report = audit(resolveThemes(opts), opts);
  const shown = report.bad.slice(0, 5)
    .map((row) => `${row.slug}/${row.mode} ${row.spot} `
                  + `${row.got.toFixed(2)} < ${row.need.toFixed(2)}`)
    .join("\n");
  assert.equal(report.bad.length, 0, `어긋난 자리:\n${shown}`);
  assert.equal(report.themes, 74);
  assert.equal(report.combos, 148);
  assert.equal(report.corrected, true);
});

/* ---------------------------------------------- 3. 대조군 (--no-correct) */

// 🔴 이 단언이 없으면 2번은 검사가 아니라 장식입니다. 보정을 끈 같은 팔레트가
// 빨강을 내야 2번의 초록이 보정의 공이라고 말할 수 있습니다.
test("대조군: 보정을 끄면 어긋난 자리가 0보다 크다", () => {
  const opts = parseArgs(["check", "--no-correct"]);
  const report = audit(resolveThemes(opts), opts);
  assert.equal(report.corrected, false);
  assert.ok(report.bad.length > 0,
            "보정을 꺼도 0건이면 보정이 아무 일도 하지 않는 것이다");
  // 같은 조합 수를 재는데도 결과가 갈려야 합니다.
  assert.equal(report.combos, 148);
});

/* ------------------------------------------------------ 4. 결정성 */

test("correctedPalette 는 같은 입력에 같은 출력을 낸다", () => {
  for (const [slug, mode, values] of allCombos()) {
    assert.deepEqual(correctedPalette([...values]),
                     correctedPalette([...values]), `${slug}/${mode}`);
  }
});

test("corrected 는 같은 인자에 같은 색을 낸다", () => {
  const once = corrected("#ff4f00", "#ffffff", "#f7f7f5");
  const twice = corrected("#ff4f00", "#ffffff", "#f7f7f5");
  assert.equal(once, twice);
});

/* ------------------------------------------------- 5. keep_bg 보호 */

// 하한은 `min(원래 대비, TARGET)` 입니다. 원래 TARGET 아래였던 자리는 그
// 값보다 나빠지지 않기만 하면 됩니다 - 더 좋아지라고 요구하지 않습니다.
test("keep_bg 보호: 원래 대비가 TARGET 아래였어도 나빠지지 않는다", () => {
  let tight = 0;
  for (const [slug, mode, values] of allCombos()) {
    const { seen, out } = combo(values);
    for (const [field] of SURFACE_JOBS) {
      const was = contrast(seen[field], seen.bg);
      const floor = Math.min(was, TARGET);
      if (was < TARGET) tight += 1;
      assert.ok(contrast(out[`${field}-on-surface`], seen.bg) >= floor - 1e-9,
                `${slug}/${mode} ${field}-on-surface 가 bg 에서 ${was} 아래로`);
    }
    const wasAccent = contrast(seen.accent, seen.surface);
    assert.ok(contrast(out.accent, seen.surface)
              >= Math.min(wasAccent, TARGET) - 1e-9,
              `${slug}/${mode} accent 가 surface 에서 ${wasAccent} 아래로`);
  }
  // 🔴 양성 대조: 하한이 TARGET 아래인 자리가 실제로 있어야 위 단언이 일을
  // 합니다. 전부 TARGET 이상이면 `min` 의 왼쪽 가지는 한 번도 안 쓰입니다.
  assert.ok(tight > 0, "원래 대비가 TARGET 아래인 자리가 번들에 없다");
});

/* ------------------------------------------- 6. ink · dim 은 제자리 유지 */

test("ink 와 dim 은 제자리에서 안 움직이고 갈라진 값은 새 이름으로 나간다", () => {
  let split = 0;
  for (const [slug, mode, values] of allCombos()) {
    const { seen, out } = combo(values);
    assert.equal(out.ink, seen.ink, `${slug}/${mode} --ink 가 움직였다`);
    assert.equal(out.dim, seen.dim, `${slug}/${mode} --dim 이 움직였다`);
    assert.equal(out.bg, seen.bg, `${slug}/${mode} --bg 가 움직였다`);
    assert.equal(out.surface, seen.surface, `${slug}/${mode} --surface 가 움직였다`);
    assert.equal(out.rule, seen.rule, `${slug}/${mode} --rule 이 움직였다`);
    if (out["ink-on-surface"] !== seen.ink) split += 1;
    if (out["dim-on-surface"] !== seen.dim) split += 1;
  }
  // 🔴 양성 대조: 어딘가에서는 값이 실제로 갈라져야 `-on-surface` 라는 새
  // 이름이 존재할 까닭이 있습니다. 하나도 안 갈리면 위 단언은 공짜입니다.
  assert.ok(split > 0, "ink · dim 이 한 조합에서도 갈라지지 않았다");
});

/* ---------------------------------------------------- 7. DESIGN.md 파싱 */

const YAML_DESIGN = `# Fixture Yaml

Some prose above the block.

colors:
  primary: "#0052ff"
  canvas: "#ffffff"
  ink: "#101010"

  surface-card: "#fafafa"
  muted: "#666666"
  hairline: "#d0d0d0"
  warning: "#b00020"
  primary: "#1234ab"

Prose below the block mentions #999999 and must not be read.
`;

// YAML 쪽: 블록 안의 빈 줄에서 멈추지 않고, 같은 키는 **뒤가 이깁니다.**
test("DESIGN.md YAML 블록: 빈 줄을 넘기고 같은 키는 뒤가 이긴다", () => {
  const colors = parseYamlColors(YAML_DESIGN);
  assert.equal(colors.get("surface-card"), "#fafafa",
               "빈 줄 뒤의 값이 사라졌다");
  assert.equal(colors.get("primary"), "#1234ab", "YAML 은 뒤가 이긴다");
  assert.equal(colors.has("canvas"), true);
  // 들여쓰기가 없는 줄에서 멈추므로 블록 밖 색은 안 들어옵니다.
  assert.equal([...colors.values()].includes("#999999"), false);
});

test("DESIGN.md YAML 쪽은 일곱 변수를 역할 이름에서 그대로 집는다", () => {
  const theme = themeFromDesign(YAML_DESIGN);
  assert.notEqual(theme, null);
  assert.equal(theme.prose, false, "YAML 이 있으면 산문을 보지 않는다");
  // bg surface ink dim rule accent warn
  assert.deepEqual(theme.light,
    ["#ffffff", "#fafafa", "#101010", "#666666", "#d0d0d0", "#1234ab",
     "#b00020"]);
  // 다크 쪽 강조색: luminance("#1234ab") 는 0.18 아래라 흰색 35% 로 띄웁니다.
  assert.ok(luminance("#1234ab") < 0.18);
  assert.equal(theme.dark[5], mix("#1234ab", WHITE, 0.35));
});

const PROSE_DESIGN = `# Fixture Prose

- Primary CTA: #ff4f00 on hover.
- Page background is #fffdf9 everywhere.
- Body text uses #1a1a1a (near-black).
- Borders and dividers: #e6e0d6.
- Secondary text / gray: #6b6b6b.
- Cards sit on #ffffff surface.
- Warning and error states: #b3261e.
- A second background line says #123456 and must lose.
`;

// 산문 쪽: `take()` 는 먼저 잡은 것을 **안 덮습니다.** YAML 과 반대 방향이고,
// 이 비대칭이 깨지면 열 개 테마의 색이 조용히 바뀝니다.
test("DESIGN.md 산문: 역할을 낱말로 추측하고 먼저 잡은 것이 이긴다", () => {
  const colors = parseProseColors(PROSE_DESIGN);
  assert.equal(colors.get("primary"), "#ff4f00");
  assert.equal(colors.get("canvas"), "#fffdf9", "산문은 앞이 이긴다");
  assert.equal(colors.get("ink"), "#1a1a1a");
  assert.equal(colors.get("hairline"), "#e6e0d6");
  assert.equal(colors.get("muted"), "#6b6b6b");
  assert.equal(colors.get("surface-card"), "#ffffff");
  assert.equal(colors.get("warning"), "#b3261e");
});

test("DESIGN.md 산문 쪽도 일곱 변수를 낸다", () => {
  const theme = themeFromDesign(PROSE_DESIGN);
  assert.notEqual(theme, null);
  assert.equal(theme.prose, true, "colors: 블록이 없으면 산문을 읽는다");
  assert.deepEqual(theme.light,
    ["#fffdf9", "#ffffff", "#1a1a1a", "#6b6b6b", "#e6e0d6", "#ff4f00",
     "#b3261e"]);
});

// 🔴 `canvas` 가 이미 어두운 테마는 라이트 쪽을 되돌립니다. 안 그러면 토글이
// 뒤집혀 보입니다. 되돌린 뒤에도 fail-closed 검사가 서야 합니다.
test("DESIGN.md: 어두운 canvas 는 라이트 쪽을 밝게 되돌린다", () => {
  const theme = themeFromDesign(`colors:
  canvas: "#0b0b0b"
  ink: "#ffffff"
  primary: "#0052ff"
`);
  const [bg, surface, ink, dim] = theme.light;
  assert.ok(luminance("#0b0b0b") < 0.4, "입력 canvas 는 어둡다");
  assert.ok(luminance(bg) >= 0.4, "라이트 쪽 bg 가 어두운 채로 남았다");
  assert.equal(surface, WHITE);
  assert.ok(contrast(ink, bg) >= 4.5, "본문이 fail-closed 를 안 지난다");
  assert.ok(contrast(dim, bg) >= 3.0, "dim 이 3.0 아래로 남았다");
});

test("labelOf: 두 글자 이하 낱말은 대문자다", () => {
  assert.equal(labelOf("ide-vscode"), "Ide Vscode");
  assert.equal(labelOf("ai_studio"), "AI Studio");
  assert.equal(labelOf("airbnb"), "Airbnb");
});

/* --------------------------------- 8. 저장된 이름이 목록 밖일 때 되돌리기 */

test("pickTheme: 목록 밖 이름은 기본으로 되돌린다", () => {
  assert.equal(pickTheme("airbnb", ["airbnb", "stripe"], "stripe"), "airbnb");
  assert.equal(pickTheme("deleted", ["airbnb", "stripe"], "stripe"), "stripe");
  assert.equal(pickTheme(null, ["airbnb"], "airbnb"), "airbnb");
  assert.equal(pickTheme("airbnb", [], "stripe"), "stripe");
  // 위젯이 심는 JS 도 같은 닫힌 집합을 들고 같은 판정을 합니다.
  const opts = parseArgs(["widget", "--only", "airbnb,stripe"]);
  const html = renderWidget(resolveThemes(opts));
  assert.ok(html.includes(`var THEMES = ["airbnb","stripe"]`),
            "위젯에 닫힌 집합이 박혀 있지 않다");
  assert.ok(html.includes("function pickTheme(saved, allowed, fallback)"));
});

/* ----------------------------------------------------- 9. --prefix */

test("--prefix 는 13개 전부와 --shadow 에 붙는다", () => {
  const opts = parseArgs(["css", "--only", "airbnb", "--prefix", "t-"]);
  const css = renderCss(resolveThemes(opts), opts);
  const root = /^:root\{([^}]*)\}/m.exec(css);
  assert.notEqual(root, null, ":root 규칙이 먼저 나와야 한다");
  const names = root[1].split(";").map((one) => one.split(":")[0]);
  assert.deepEqual(names, OUT_NAMES.map((name) => `--t-${name}`));
  assert.equal(names.length, 13);
  assert.ok(css.includes("html{--t-shadow:"), "--shadow 에 안 붙었다");
  // 대조군: 접두사를 안 주면 접두사가 없습니다.
  const plain = parseArgs(["css", "--only", "airbnb"]);
  assert.ok(renderCss(resolveThemes(plain), plain).includes("{--bg:"));
});

test("--prefix 는 json 산출물의 이름에도 붙는다", () => {
  const opts = parseArgs(["json", "--only", "airbnb", "--prefix", "t-"]);
  const data = JSON.parse(renderJson(resolveThemes(opts), opts));
  assert.deepEqual(data.names, OUT_NAMES.map((name) => `t-${name}`));
  assert.equal(Object.keys(data.themes.airbnb.light).length, 13);
});

/* ---------------------------------------------------- 10. --dark-via */

test("--dark-via 세 값은 각각 다른 다크 선택자를 낸다", () => {
  const render = (mode) => {
    const opts = parseArgs(["css", "--only", "airbnb", "--dark-via", mode]);
    return renderCss(resolveThemes(opts), opts);
  };
  const attr = render("attr");
  const klass = render("class");
  const media = render("media");

  const attrSel = `html[data-theme="airbnb"][data-mode="dark"]{`;
  const classSel = `html[data-theme="airbnb"].dark{`;
  const mediaSel = `@media (prefers-color-scheme: dark){html[data-theme="airbnb"]{`;

  assert.ok(attr.includes(attrSel));
  assert.ok(!attr.includes(classSel) && !attr.includes(mediaSel));
  assert.ok(klass.includes(classSel));
  assert.ok(!klass.includes(attrSel) && !klass.includes(mediaSel));
  assert.ok(media.includes(mediaSel));
  assert.ok(!media.includes(attrSel) && !media.includes(classSel));

  // 라이트 선택자는 셋 다 같습니다.
  for (const css of [attr, klass, media]) {
    assert.ok(css.includes(`html[data-theme="airbnb"]{--bg:`));
  }
  // `--shadow` 도 같은 모드 축을 따릅니다.
  assert.ok(attr.includes(`html[data-mode="dark"]{--shadow:`));
  assert.ok(klass.includes(`html.dark{--shadow:`));
  assert.ok(media.includes(`@media (prefers-color-scheme: dark){html{--shadow:`));
});

// 🔴 고르개 없이 모드만 쓰는 화면은 `<html>` 에 `data-theme` 이 없어 `:root`
// 규칙만 맞습니다. `:root` 가 라이트만 들면 그 화면에서는 다크가 켜지지 않습니다.
test(":root 는 기본 테마의 라이트와 다크를 --dark-via 의 자리에 둘 다 든다", () => {
  const darkHead = {
    attr: ":root[data-mode=\"dark\"]{",
    class: ":root.dark{",
    media: "@media (prefers-color-scheme: dark){:root{",
  };
  for (const [mode, head] of Object.entries(darkHead)) {
    const opts = parseArgs(["css", "--only", "airbnb,stripe", "--default", "stripe",
                            "--dark-via", mode]);
    const resolved = resolveThemes(opts);
    const stripe = resolved.themes.get("stripe");
    const decl = (values) => palettePairs(values, opts)
      .map(([name, value]) => `--${name}:${value}`).join(";");
    const lines = renderCss(resolved, opts).split("\n");
    assert.equal(lines[0], `:root{${decl(stripe.light)}}`, `${mode} 라이트`);
    const tail = mode === "media" ? "}}" : "}";
    assert.equal(lines[1], `${head}${decl(stripe.dark)}${tail}`, `${mode} 다크`);
  }
});

/* ============================================================
   11 · 12 · 13 - 번들 148 조합으로 가려지지 않는 세 자리
   ============================================================ */

/* ----------------------------- 11. withLightness 의 파이썬식 반올림 */

// 파이썬 `round` 는 0.5 를 **짝수** 쪽으로, JS `Math.round` 는 **위로** 보냅니다.
// 그래서 채널 값이 정확히 `짝수 + 0.5` 로 떨어질 때만 두 규칙이 갈립니다.
//
// 경계 입력을 고른 근거:
//   `#0052ff` · light 0.350 -> 파랑 채널이 정확히 178.5 (178 은 짝수).
//        파이썬 round(178.5) = 178 = 0xb2,  Math.round = 179 = 0xb3.
//   `#000000` · light 0.300 -> 세 채널 모두 정확히 76.5 (76 은 짝수).
//        파이썬 round(76.5) = 76 = 0x4c,   Math.round = 77 = 0x4d.
//   `#001e2b` · light 0.215 -> 초록 채널이 정확히 76.5.
// 세 light 값 모두 0.000~1.000 의 1001 단계 위에 있어 실제 훑기에서 나옵니다.
test("withLightness 는 채널의 .5 를 짝수 쪽으로 보낸다 (파이썬 round)", () => {
  // 먼저 경계임을 보입니다. 이 값이 .5 가 아니면 아래 단언은 아무것도 안 잽니다.
  const blue = withLightnessChannel("#0052ff", 0.35, 2);
  assert.equal(blue, 178.5, "파랑 채널이 정확히 178.5 가 아니면 경계가 아니다");
  assert.equal(pyround(178.5), 178, "파이썬 round 는 짝수 쪽");
  assert.equal(Math.round(178.5), 179, "JS Math.round 는 위쪽");

  assert.equal(withLightness("#0052ff", 0.35), "#0039b2");
  assert.notEqual(withLightness("#0052ff", 0.35), "#0039b3");

  const gray = withLightnessChannel("#000000", 0.3, 0);
  assert.equal(gray, 76.5);
  assert.equal(pyround(76.5), 76);
  assert.equal(withLightness("#000000", 0.3), "#4c4c4c");
  assert.notEqual(withLightness("#000000", 0.3), "#4d4d4d");

  assert.equal(withLightness("#001e2b", 0.215), "#004c6e");
  assert.notEqual(withLightness("#001e2b", 0.215), "#004d6e");
});

// 바이트로 나가기 **전**의 채널 값. 반올림 규칙을 거치지 않은 실수를 봅니다.
function withLightnessChannel(value, light, index) {
  const hex = withLightness(value, light);
  const asByte = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  // 반올림 전 값은 구현을 안 거쳐야 하므로 HLS 로 직접 다시 셉니다.
  const raw = rawChannel(value, light, index);
  assert.ok(Math.abs(raw - asByte) <= 0.5 + 1e-12,
            "반올림 전 값과 나간 바이트가 1 이상 벌어졌다");
  return raw;
}

// `colorsys` 포팅을 거치지 않고 HLS 를 다시 세어 반올림 전 채널을 냅니다.
// (파이썬 `colorsys.hls_to_rgb` 와 같은 식입니다.)
function rawChannel(value, light, index) {
  const chans = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const maxc = Math.max(...chans);
  const minc = Math.min(...chans);
  const lightOld = (maxc + minc) / 2.0;
  let hue = 0.0;
  let sat = 0.0;
  if (minc !== maxc) {
    const rangec = maxc - minc;
    sat = lightOld <= 0.5 ? rangec / (maxc + minc)
                          : rangec / (2.0 - maxc - minc);
    const rc = (maxc - chans[0]) / rangec;
    const gc = (maxc - chans[1]) / rangec;
    const bc = (maxc - chans[2]) / rangec;
    if (chans[0] === maxc) hue = bc - gc;
    else if (chans[1] === maxc) hue = 2.0 + rc - bc;
    else hue = 4.0 + gc - rc;
    hue = ((hue / 6.0) % 1.0 + 1.0) % 1.0;
  }
  if (sat === 0.0) return light * 255;
  const m2 = light <= 0.5 ? light * (1.0 + sat) : light + sat - light * sat;
  const m1 = 2.0 * light - m2;
  const at = (spot) => {
    const s = ((spot % 1.0) + 1.0) % 1.0;
    if (s < 1.0 / 6.0) return m1 + (m2 - m1) * s * 6.0;
    if (s < 0.5) return m2;
    if (s < 2.0 / 3.0) return m1 + (m2 - m1) * (2.0 / 3.0 - s) * 6.0;
    return m1;
  };
  const offs = [1.0 / 3.0, 0.0, -1.0 / 3.0];
  return at(hue + offs[index]) * 255;
}

/* ------------------------------- 12. 명도 훑기 단계 수는 1001 (1000 아님) */

// `range(1001)` 은 `light = 1.000` 을 후보에 넣고 `range(1000)` 은 0.999 까지만
// 봅니다. 두 쪽을 가르려면 **흰색만 답인** 조합이 필요합니다.
//
// 경계 입력을 고른 근거 (`#ff0000`, 두 배경 모두 검정, 목표 20.9):
//   light 1.000 -> `#ffffff`, 검정 대비 21.00  (유일한 통과 후보)
//   light 0.999 -> `#fffefe`, 검정 대비 20.86  (0..999 단계의 **최댓값**)
//   원본 `#ff0000` 의 검정 대비는 5.25 라 조기 반환도 없습니다.
// 목표 20.9 는 두 값 사이에 있으므로, 1000 단계로 줄이면 통과 후보가 하나도
// 없어져 답이 원본 `#ff0000` 으로 떨어집니다.
test("명도 훑기는 light 1.000 을 포함한다 (1001 단계)", () => {
  const value = "#ff0000";
  const black = "#000000";
  const target = 20.9;

  // 경계임을 먼저 보입니다.
  assert.equal(withLightness(value, 1.0), "#ffffff");
  assert.ok(contrast("#ffffff", black) >= target);
  let hottest = 0;
  for (let step = 0; step < 1000; step += 1) {
    const got = contrast(withLightness(value, step / 1000.0), black);
    if (got > hottest) hottest = got;
  }
  assert.ok(hottest < target,
            `1000 단계 안에 목표를 넘는 후보가 있다 (${hottest})`);
  assert.ok(contrast(value, black) < target, "조기 반환이면 훑지 않는다");

  // 1001 단계라면 흰색이 답입니다. 1000 단계면 답이 없어 원본이 나옵니다.
  assert.equal(corrected(value, black, black, target), "#ffffff");
});

/* ------------------------------------- 13. `floor - 1e-9` 부동소수 여유 */

// `keep_bg` 하한을 **같은 값으로** 만족하는 후보는 부동소수 비교에서 떨어질 수
// 있습니다. 파이썬 원본도 `floor - 1e-9` 로 그 자리를 받습니다.
//
// 경계 입력을 고른 근거 (값 `#000000`, need `#0007cd`, keep `#888888`):
//   contrast(value, keep) = 5.92 >= target -> 하한(floor)이 **목표 그 자체**입니다.
//   contrast(value, need) = 1.91 <  target -> 훑기가 돕니다.
//   후보 `#ececec` 의 keep 대비는 목표보다 1.0e-12 **낮습니다**(아래에서 목표를
//   그렇게 잡습니다). 1e-9 여유가 있으면 받아들여지고, 없으면 떨어집니다.
//   `#ececec` 는 원래 명도(검정, 0.000)에서 가장 가까운 통과 후보이므로,
//   여유를 빼면 답이 한 단계 밝은 `#ededed` 로 바뀝니다.
test("keep_bg 하한은 1e-9 여유로 비교한다", () => {
  const value = "#000000";
  const need = "#0007cd";
  const keep = "#888888";
  const edge = "#ececec";
  // 목표는 그 후보의 keep 대비보다 1e-12 위입니다. 즉 후보는 "같은 값인데
  // 부동소수 오차로 모자란" 자리에 정확히 앉습니다.
  const target = contrast(edge, keep) + 1e-12;

  assert.ok(contrast(value, keep) >= target, "하한이 목표에서 오지 않는다");
  assert.ok(contrast(value, need) < target, "조기 반환이면 훑지 않는다");
  assert.ok(contrast(edge, need) >= target, "후보가 need 쪽에서 떨어진다");
  assert.ok(contrast(edge, keep) < target, "후보가 여유 없이도 통과한다");
  assert.ok(target - contrast(edge, keep) < 1e-9, "모자란 양이 여유보다 크다");
  // 여유를 빼면 이 후보가 떨어지고 한 단계 밝은 쪽이 답이 됩니다.
  assert.ok(contrast("#ededed", keep) >= target, "다음 후보는 여유 없이 통과한다");

  assert.equal(corrected(value, need, keep, target), edge);
});

/* ------------------------------------------------------------ 곁가지 */

test("labelOnAccent 는 목표를 넘는 첫 후보를 고르고 원래 글자색을 먼저 본다", () => {
  const seen = { surface: "#ffffff", bg: "#f7f7f5", ink: "#111111" };
  // surface 가 이미 4.5 를 넘으면 화면이 한 픽셀도 안 바뀝니다.
  assert.equal(labelOnAccent(seen, "#6b3fa0"), "#ffffff");
  // 밝은 버튼 배경에서는 흰색이 떨어지고 뒤 후보로 갑니다.
  assert.equal(labelOnAccent({ surface: "#ffffff", bg: "#fefefe",
                               ink: "#111111" }, "#ffe08a"), "#111111");
  assert.equal(LABEL_TARGET, 4.5);
  assert.equal(TARGET, 3.0);
});

test("byLabel 은 표시명 순서를 내고 list 와 고르개가 같은 순서를 쓴다", () => {
  const opts = parseArgs(["list", "--only", "zapier,airbnb,stripe"]);
  const labels = byLabel(resolveThemes(opts).themes).map(([slug]) => slug);
  assert.deepEqual(labels, ["airbnb", "stripe", "zapier"]);
});

test("parseArgs 는 틀린 인자를 거부한다", () => {
  assert.throws(() => parseArgs(["check", "--dark-via", "inline"]));
  assert.throws(() => parseArgs(["nope"]));
  assert.throws(() => parseArgs(["css", "--json"]));
  assert.throws(() => parseArgs(["check", "--target", "0"]));
  assert.throws(() => parseArgs(["check", "--prefix"]));
});

test("--only 로 기본 테마가 걸러지면 첫 슬러그가 기본이 된다", () => {
  const opts = parseArgs(["css", "--only", "zapier,airbnb"]);
  const resolved = resolveThemes(opts);
  assert.equal(resolved.default, "airbnb");
  assert.equal(resolved.themes.size, 2);
});

/* ============================================================
   CLI, 이름 검사, 링크 실행 - banker 스킬로 옮기며 더한 시험
   ============================================================ */

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args],
                   { encoding: "utf8", timeout: 60000 });
}

function scratch(name) {
  return mkdtempSync(join(tmpdir(), `theme-selection-${name}-`));
}

test("parseArgs 는 옵션을 모두 읽고, 값은 - 로 시작해도 값이다", () => {
  const opts = parseArgs([
    "css", "--design-md", "a", "--design-md", "b",
    "--only", " airbnb, stripe ,", "--default", "stripe", "--prefix", "t-",
    "--dark-via", "class", "--target", "2.5", "--label-target", "7",
    "--no-correct", "--out", "o.css",
  ]);
  assert.deepEqual(opts, {
    command: "css", designMd: ["a", "b"], only: ["airbnb", "stripe"],
    default: "stripe", prefix: "t-", darkVia: "class", target: 2.5,
    labelTarget: 7, correct: false, out: "o.css", json: false,
  });
  assert.equal(parseArgs(["check", "--json"]).json, true);
  for (const argv of [["-h"], ["css", "--help"], ["help"]]) {
    assert.equal(parseArgs(argv).command, "help", argv.join(" "));
  }
  assert.equal(parseArgs(["css", "--prefix", "-x"]).prefix, "-x");
});

// 🔴 접두사는 `--<접두사><이름>` 에 그대로 들어갑니다. `;` 하나가 그 뒤 선언을
// 통째로 깹니다.
test("--prefix 는 영문, 숫자, -, _ 밖의 글자를 거부한다", () => {
  for (const bad of ["a;b", "a b", "x}", "é"]) {
    assert.throws(() => parseArgs(["css", "--prefix", bad]),
                  /--prefix may use only/, JSON.stringify(bad));
  }
  assert.equal(parseArgs(["css", "--prefix", ""]).prefix, "");
});

test("--design-md 는 세 모양을 받고, 같은 슬러그는 번들을 덮는다", () => {
  const root = scratch("design");
  try {
    for (const dir of [["many", "airbnb"], ["many", "brand"], ["own"]]) {
      mkdirSync(join(root, ...dir), { recursive: true });
    }
    writeFileSync(join(root, "many", "airbnb", "DESIGN.md"), YAML_DESIGN);
    writeFileSync(join(root, "many", "brand", "DESIGN.md"), YAML_DESIGN);
    writeFileSync(join(root, "own", "DESIGN.md"), PROSE_DESIGN);
    writeFileSync(join(root, "custom.md"), YAML_DESIGN);
    const slugs = (path) => loadDesignMd(path).map(([slug]) => slug);
    assert.deepEqual(slugs(join(root, "many")), ["airbnb", "brand"]);
    assert.deepEqual(slugs(join(root, "own")), ["own"]);
    assert.deepEqual(slugs(join(root, "own", "DESIGN.md")), ["own"]);
    assert.deepEqual(slugs(join(root, "custom.md")), ["custom"]);
    const opts = parseArgs(["json", "--design-md", join(root, "many")]);
    const resolved = resolveThemes(opts);
    assert.equal(resolved.themes.size, 75, "번들 74 와 brand 하나");
    assert.equal(resolved.themes.get("airbnb").source,
                 join(root, "many", "airbnb", "DESIGN.md"), "번들을 덮지 않았다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 🔴 이름은 CSS 선택자, HTML 속성, `<script>` 안의 JSON 에 그대로 들어갑니다.
// Windows 에서도 만들 수 있는 이름(빈칸, `}`)으로 잽니다. 한글 폴더 이름은
// 흔하므로 받아야 합니다.
test("--design-md 의 테마 이름은 글자, 숫자, ., -, _ 만 받는다", () => {
  for (const slug of loadBundled().themes.keys()) {
    assert.ok(validSlug(slug), `번들 이름 ${slug} 이 규칙 밖이다`);
  }
  const root = scratch("slug");
  try {
    mkdirSync(join(root, "ok", "쇼핑몰"), { recursive: true });
    writeFileSync(join(root, "ok", "쇼핑몰", "DESIGN.md"), YAML_DESIGN);
    assert.deepEqual(loadDesignMd(join(root, "ok")).map(([slug]) => slug), ["쇼핑몰"]);
    for (const bad of ["bad name", "bad}x"]) {
      mkdirSync(join(root, bad));
      writeFileSync(join(root, bad, "DESIGN.md"), YAML_DESIGN);
      assert.throws(() => loadDesignMd(join(root, bad)), /may use only letters/,
                    bad);
    }
    const res = run(SCRIPT, ["css", "--design-md", root]);
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /may use only letters/);
    assert.doesNotMatch(res.stderr, /^\s+at /m, "스택 추적이 나왔다");
    assert.equal(res.stdout, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI 종료 코드: 0 정상, 1 check 어긋남, 2 인자 틀림", () => {
  const ok = run(SCRIPT, ["check", "--only", "airbnb"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /violations 0$/m);
  const raw = run(SCRIPT, ["check", "--no-correct"]);
  assert.equal(raw.status, 1, raw.stderr);
  assert.match(raw.stdout, /^FAIL /m);
  for (const argv of [[], ["nope"], ["css", "--json"], ["css", "--only", "x"]]) {
    const res = run(SCRIPT, argv);
    assert.equal(res.status, 2, `${argv.join(" ")}: ${res.stderr}`);
    assert.equal(res.stdout, "");
  }
});

test("--out 은 표준출력과 같은 내용을 쓰고, 못 쓰면 종료 코드 2 다", () => {
  const root = scratch("out");
  try {
    const file = join(root, "themes.json");
    const printed = run(SCRIPT, ["json"]);
    const written = run(SCRIPT, ["json", "--out", file]);
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(written.status, 0, written.stderr);
    assert.equal(written.stdout, "");
    assert.equal(printed.stdout, readFileSync(file, "utf8"));
    const missing = run(SCRIPT, ["css", "--out", join(root, "nope", "x.css")]);
    assert.equal(missing.status, 2, "쓰기 실패가 check 의 1 과 섞였다");
    assert.match(missing.stderr, /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 🔴 `process.exit()` 로 끝내면 셸 파이프(`|`)로 받은 출력이 64KiB(65,536
// 바이트)에서 잘립니다. 번들 전체의 json(약 70KB)은 그보다 큽니다. 위 시험의
// `spawnSync` 는 운영체제 파이프가 아니라 버퍼가 큰 소켓 쌍이라 이 잘림을 재지
// 못하므로, 셸로 실제 파이프를 만들고 읽는 쪽이 받은 바이트를 셉니다.
test("셸 파이프로 받아도 64KiB 를 넘는 출력이 잘리지 않는다", () => {
  const root = scratch("pipe");
  try {
    const reader = join(root, "count.cjs");
    writeFileSync(reader, "let n = 0; process.stdin.on(\"data\", (d) => { n += d.length; })"
                          + ".on(\"end\", () => { process.stdout.write(String(n)); });\n");
    const quote = (path) => `"${path}"`;
    const node = quote(process.execPath);
    const res = spawnSync(`${node} ${quote(SCRIPT)} json | ${node} ${quote(reader)}`,
                          { shell: true, encoding: "utf8", timeout: 60000 });
    const whole = Buffer.byteLength(run(SCRIPT, ["json"]).stdout);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(whole > 65536, `json 이 ${whole} 바이트라 64KiB 를 넘지 않는다`);
    assert.equal(Number(res.stdout), whole, "파이프 쪽 출력이 잘렸다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// `#777777` 은 흰색과 4.48, 검정과 4.69 라 목표 7 을 넘는 후보가 없습니다.
test("--label-target 이 4.58 을 넘어 답이 없으면 던지지 않고 check 가 보고한다", () => {
  const seen = { surface: WHITE, bg: "#f7f7f5", ink: "#111111" };
  assert.ok(contrast(WHITE, "#777777") < 7 && contrast(BLACK, "#777777") < 7);
  assert.equal(labelOnAccent(seen, "#777777", 7), BLACK, "대비가 가장 높은 것은 검정");
  const css = run(SCRIPT, ["css", "--only", "airbnb", "--label-target", "7"]);
  assert.equal(css.status, 0, css.stderr);
  assert.equal(css.stderr, "");
  const check = run(SCRIPT, ["check", "--only", "airbnb", "--label-target", "7"]);
  assert.equal(check.status, 1, check.stderr);
  assert.match(check.stdout, /^FAIL airbnb\/\w+ label-on-(page-)?accent vs /m);
});

// 🔴 Node 는 `import.meta.url` 의 링크를 풀고 `process.argv[1]` 은 풀지 않습니다.
// 한쪽만 푼 비교였다면 링크로 부른 쪽은 아무것도 내지 않고 0 으로 끝납니다.
// 링크는 전용 폴더에 두고, 링크를 먼저 지운 뒤 그 폴더를 재귀 없이 지웁니다.
test("링크 경로로 불러도 실제 경로와 같은 출력과 종료 코드를 낸다", (t) => {
  const linkRoot = scratch("link");
  const link = join(linkRoot, "skill");
  try {
    symlinkSync(dirname(HERE), link, "junction");
  } catch {
    rmdirSync(linkRoot);
    t.skip("이 기계에서는 링크를 만들 수 없다");
    return;
  }
  try {
    for (const argv of [["list", "--only", "airbnb,stripe"], ["nope"]]) {
      const real = run(SCRIPT, argv);
      const linked = run(join(link, "scripts", "themes.mjs"), argv);
      const label = `${argv.join(" ")}: status ${linked.status}`;
      assert.equal(linked.status, real.status, label);
      assert.equal(linked.stdout, real.stdout, label);
      assert.equal(linked.stderr, real.stderr, label);
    }
    assert.equal(run(SCRIPT, ["list", "--only", "airbnb"]).stdout,
                 "airbnb\tAirbnb\n", "실제 경로 실행이 비면 위 비교는 빈 시험이다");
  } finally {
    unlinkSync(link);
    rmdirSync(linkRoot);
  }
});

// 🔴 폐쇄망에서 도는 스킬입니다. 엔진이 들여오는 모듈을 허용 목록으로 못박습니다.
// 주석을 뗀 뒤 따옴표 종류와 상관없이 `from "..."` 과 `import "..."` 를 모두
// 모읍니다. 큰따옴표의 `from` 만 보면 `import 'node:child_process';` 가 빠집니다.
test("엔진은 node:fs, node:path, node:url 만 들여온다", () => {
  const code = readFileSync(SCRIPT, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  const specifiers = [
    ...code.matchAll(/\bfrom\s*["'`]([^"'`]+)["'`]/g),
    ...code.matchAll(/\bimport\s*["'`]([^"'`]+)["'`]/g),
  ].map((hit) => hit[1]);
  assert.deepEqual([...new Set(specifiers)].sort(), ["node:fs", "node:path", "node:url"]);
  assert.doesNotMatch(code, /\b(?:fetch|require)\s*\(|\bimport\s*\(/);
  assert.doesNotMatch(code,
    /["'`](?:node:)?(?:https?|http2|net|tls|dgram|child_process|worker_threads|cluster)["'`]/);
});

test("고르개는 세 덩이를 순서대로 내고, 배선 스크립트만 ready 래퍼로 감싼다", () => {
  const opts = parseArgs(["widget", "--only", "airbnb,stripe"]);
  const blocks = renderWidget(resolveThemes(opts)).split("\n\n");
  assert.equal(blocks.length, 3);
  blocks.forEach((block, i) => {
    assert.ok(block.startsWith(`<!-- ${i + 1}. `), `덩이 ${i + 1} 의 자리`);
  });
  assert.ok(!blocks[1].includes("getElementById"), "head 스크립트가 DOM 을 본다");
  assert.ok(blocks[2].includes('document.readyState === "loading"'));
  assert.ok(blocks[2].includes('addEventListener("DOMContentLoaded", wire)'));
});

// 🔴 `--dark-via class` 의 CSS 는 `.dark` 만 봅니다. 모드 버튼이 `data-mode` 만
// 바꾸면 Tailwind 의 class 모드에서 버튼이 색을 바꾸지 못합니다. media 는 OS
// 설정만 따르므로 버튼을 내지 않습니다.
test("고르개의 모드 버튼은 data-mode 와 .dark 를 함께 바꾸고, media 면 버튼이 없다", () => {
  const html = (mode) => {
    const opts = parseArgs(["widget", "--only", "airbnb", "--dark-via", mode]);
    return renderWidget(resolveThemes(opts), opts);
  };
  const attr = html("attr");
  assert.equal(html("class"), attr, "attr 와 class 의 고르개가 다르다");
  assert.ok(attr.includes('id="theme-mode"'), "모드 버튼이 없다");
  assert.ok(attr.includes('root.classList.toggle("dark", next === "dark")'));
  const [markup, head] = html("media").split("\n\n");
  assert.ok(!markup.includes('id="theme-mode"'), "media 인데 모드 버튼이 있다");
  assert.ok(head.includes('root.classList.toggle("dark", mode === "dark")'));
});

// 🔴 U+3164(한글 채움 문자)와 U+FE0F(변형 선택자)는 글자와 결합 표시로 분류돼
// SLUG 만으로는 통과합니다. 보이지 않는 글자 검사가 따로 걸러야 합니다.
test("assertSlugs 는 글자, 숫자, ., -, _ 밖의 이름과 보이지 않는 글자를 거부한다", () => {
  assert.doesNotThrow(() => assertSlugs(["x.ai", "bmw-m", "ai_studio", "쇼핑몰",
                                         "e\u{301}clair"]));
  for (const bad of ["a b", "a\u{202E}b", "a\u{2028}b", "a<b", "-lead", "",
                     "\u{3164}", "Airbnb\u{FE0F}"]) {
    assert.throws(() => assertSlugs([bad]), /may use only letters/, JSON.stringify(bad));
  }
  assert.ok(SLUG.test("\u{3164}") && SLUG.test("Airbnb\u{FE0F}"),
            "대조군: 이 둘은 SLUG 만으로는 통과해야 위 거부가 보이지 않는 글자 검사의 일이다");
});

// 🔴 이 호출이 빠지면 번들(palettes.json)에 든 나쁜 이름이 검사 없이 산출물로
// 나갑니다. 번들을 바꿔 넣어 그 자리를 잽니다.
test("resolveThemes 는 번들 이름도 출력 전에 검사한다", () => {
  const bundled = loadBundled();
  const themes = new Map(bundled.themes);
  themes.set("bad name", bundled.themes.get("airbnb"));
  assert.throws(() => resolveThemes(parseArgs(["list"]), { ...bundled, themes }),
                /may use only letters/);
  assert.equal(resolveThemes(parseArgs(["list"]), bundled).themes.size, 74, "대조군");
});

// 🔴 macOS 는 한글 폴더 이름을 흔히 분해형(NFD)으로 둡니다. 슬러그와 `--only`,
// `--default` 가 모두 NFC 로 맞춰져야 사용자가 친 이름과 맞습니다.
test("한글 슬러그는 NFC 로 맞추고 --only, --default 도 NFC 로 읽는다", () => {
  const nfc = "쇼핑몰";
  const nfd = nfc.normalize("NFD");
  assert.notEqual(nfd, nfc, "대조군: 분해형은 다른 문자열이어야 한다");
  const root = scratch("nfd");
  try {
    mkdirSync(join(root, nfd));
    writeFileSync(join(root, nfd, "DESIGN.md"), YAML_DESIGN);
    assert.deepEqual(loadDesignMd(root).map(([slug]) => slug), [nfc]);
    const opts = parseArgs(["list", "--design-md", root, "--only", nfd, "--default", nfd]);
    assert.deepEqual(opts.only, [nfc]);
    assert.equal(opts.default, nfc);
    const resolved = resolveThemes(opts);
    assert.deepEqual([...resolved.themes.keys()], [nfc]);
    assert.equal(resolved.default, nfc);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("onStdoutError 는 EPIPE 만 받아 정한 종료 코드로 끝내고, 다른 오류는 던진다", () => {
  const exits = [];
  const pipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  onStdoutError(pipe, (code) => exits.push(code));
  assert.deepEqual(exits, [process.exitCode ?? 0]);
  const other = Object.assign(new Error("write EIO"), { code: "EIO" });
  assert.throws(() => onStdoutError(other, (code) => exits.push(code)), /EIO/);
  assert.equal(exits.length, 1, "EPIPE 가 아닌데 끝냈다");
});

// 🔴 읽는 쪽(`node -e ""`)이 읽지 않고 바로 닫히면 남은 쓰기가 EPIPE 로 끝납니다.
// 쓰는 쪽의 종료 코드는 `( ... ; echo $? )` 로 받습니다. POSIX 셸 문법이라
// Windows 에서는 건너뜁니다.
test("읽는 쪽이 먼저 닫혀도 스택 추적 없이 종료 코드 0 이다",
     { skip: process.platform === "win32" && "POSIX 셸 문법" }, () => {
  const root = scratch("epipe");
  try {
    const err = join(root, "err.log");
    const code = join(root, "code.log");
    const quote = (path) => `"${path}"`;
    const node = quote(process.execPath);
    const res = spawnSync(
      `(${node} ${quote(SCRIPT)} json 2>${quote(err)}; echo $? >${quote(code)})`
      + ` | ${node} -e ""`, { shell: true, encoding: "utf8", timeout: 60000 });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(code, "utf8").trim(), "0", readFileSync(err, "utf8"));
    assert.equal(readFileSync(err, "utf8"), "", "쓰는 쪽이 오류를 냈다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 🔴 링크를 따라가면 프로젝트 밖의 파일을 덮거나, 끊긴 링크가 가리키는 자리에
// 새 파일을 만듭니다. Windows 는 권한이 없으면 파일 링크를 못 만들어 건너뜁니다.
test("--out 이 심볼릭 링크면 쓰지 않고 종료 코드 2 다", (t) => {
  const root = scratch("link-out");
  try {
    const victim = join(root, "victim.md");
    const made = join(root, "made-by-link.css");
    writeFileSync(victim, "keep\n");
    const link = join(root, "link.css");
    const dangling = join(root, "dangling.css");
    try {
      symlinkSync(victim, link);
      symlinkSync(made, dangling);
    } catch {
      t.skip("이 기계에서는 파일 링크를 만들 수 없다");
      return;
    }
    for (const target of [link, dangling]) {
      const res = run(SCRIPT, ["css", "--only", "airbnb", "--out", target]);
      assert.equal(res.status, 2, res.stderr);
      assert.match(res.stderr, /symbolic link/);
    }
    assert.equal(readFileSync(victim, "utf8"), "keep\n", "링크가 가리키는 파일이 덮였다");
    assert.equal(existsSync(made), false, "끊긴 링크가 가리키는 자리에 파일이 생겼다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ============================================================
   인자 없이 고르기 - 무리, 설명, 미리보기(list --json)
   ============================================================ */

// 🔴 무리와 설명은 색 값에서만 계산합니다. 같은 입력이면 같은 결과이고,
// DESIGN.md 의 글은 옮기지 않습니다.
function listJson(args = []) {
  const res = run(SCRIPT, ["list", "--json", ...args]);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test("colorName 은 색조, 명도, 채도에서 한글 색 이름을 낸다", () => {
  const cases = [
    ["#ff385c", "분홍빛 빨강"], ["#e60000", "빨강"], ["#f54e00", "주황빛 빨강"],
    ["#f7a501", "노란빛 주황"], ["#ffc000", "노란빛 주황"], ["#ffed00", "노랑"], ["#faff69", "연한 노랑"],
    ["#76b900", "연두"], ["#00ed64", "초록"], ["#0b6e99", "청록빛 파랑"],
    ["#0052ff", "파랑"], ["#533afd", "보랏빛 파랑"], ["#7132f5", "보라"],
    ["#4a154b", "짙은 자주"], ["#ffffff", "흰색"], ["#000000", "검정"],
    ["#808080", "회색"], ["#dddddd", "밝은 회색"], ["#1b1938", "푸른빛 짙은 회색"],
  ];
  for (const [value, name] of cases) assert.equal(colorName(value), name, value);
  assert.equal(colorName("#FF385C"), colorName("#ff385c"), "대문자 hex");
});

// 🔴 대표 색 표본. 색조 경계(정확히 240도인 순수 파랑)와 명도, 채도로 갈리는
// 이름(갈색, 남색, 올리브색, 분홍, 하늘색)을 봅니다. 기대값은 색의 통상 이름에서
// 끌어냈습니다.
test("colorName 은 원색, 갈색, 분홍, 남색, 올리브, 청록 표본에 맞는 이름을 낸다", () => {
  const cases = [
    ["#ff0000", "빨강"], ["#00ff00", "초록"], ["#0000ff", "파랑"],
    ["#ffff00", "노랑"], ["#00ffff", "청록"], ["#ff00ff", "자주"],
    ["#ffa500", "주황"], ["#ffd700", "노랑"], ["#8b0000", "짙은 빨강"],
    ["#8b4513", "갈색"], ["#a0522d", "갈색"], ["#a52a2a", "적갈색"],
    ["#000080", "남색"], ["#191970", "남색"], ["#4169e1", "파랑"],
    ["#808000", "올리브색"], ["#556b2f", "올리브색"], ["#008080", "짙은 청록"],
    ["#ffc0cb", "분홍"], ["#ff69b4", "분홍"], ["#ff1493", "분홍"],
    ["#87ceeb", "하늘색"], ["#800080", "짙은 자주"], ["#8a2be2", "보라"],
    ["#32cd32", "초록"], ["#708090", "푸른빛 회색"],
    ["#6b8e23", "올리브색"],
  ];
  for (const [value, name] of cases) assert.equal(colorName(value), name, value);
});

// 🔴 갈색과 올리브색은 "어두운 주황, 어두운 노랑" 입니다. 어두움을 HLS 명도로 보면
// 채도가 가득한 색은 가장 밝은 채널이 65% 여도 명도가 0.32 라 선명한 연두와 진한
// 노랑이 그 칸에 들어갑니다(`nvidia` 의 `#69a500` 이 올리브색이 됐던 퇴보). 가장
// 밝은 채널(HSV 의 V)로 봅니다.
test("colorName 은 선명한 연두, 노랑, 주황을 갈색이나 올리브색으로 부르지 않는다", () => {
  const cases = [
    ["#69a500", "연두"], ["#65a30d", "연두"], ["#ca8a04", "노란빛 주황"],
    ["#c2410c", "주황빛 빨강"], ["#808000", "올리브색"], ["#556b2f", "올리브색"],
    ["#8b4513", "갈색"], ["#a0522d", "갈색"], ["#a52a2a", "적갈색"],
  ];
  for (const [value, name] of cases) assert.equal(colorName(value), name, value);
  const nvidia = Object.fromEntries(palettePairs(loadBundled().themes.get("nvidia").light));
  assert.equal(colorName(nvidia.accent), "연두", nvidia.accent);
});

// 🔴 무채색 무리(채널 차이 0.15 아래)여도 색 기가 남은 것은 색조를 담아 부릅니다.
// 순수 무채색에 가까운 것(채널 차이 15/255 이하)만 회색, 검정, 흰색입니다.
test("colorName 은 은은한 색을 색조를 담은 회색이나 베이지로 부른다", () => {
  const cases = [
    ["#80808f", "회색"], ["#808090", "푸른빛 회색"], ["#89678a", "보랏빛 회색"],
    ["#f5f5dc", "베이지"], ["#1b1938", "푸른빛 짙은 회색"], ["#181d26", "검정"],
    ["#8f8080", "회색"], ["#908080", "붉은빛 회색"], ["#809080", "초록빛 회색"],
    ["#fff8e8", "누런빛 흰색"], ["#ffffff", "흰색"], ["#000000", "검정"],
  ];
  for (const [value, name] of cases) assert.equal(colorName(value), name, value);
});

// 🔴 무리 요약은 "무채색 강조색" 입니다. 설명의 색 이름도 같은 기준(채널 차이
// 0.15 아래는 무채색)을 써야 무리와 설명이 서로 다른 말을 하지 않습니다.
test("무채색 무리의 테마는 설명에서도 강조색을 회색 이름으로 부른다", () => {
  const greys = { has: (name) => /(?:흰색|회색|검정)$|^베이지$/.test(name) };
  for (const [slug, theme] of loadBundled().themes) {
    if (!["minimal", "mono"].includes(groupOf(theme.light))) continue;
    const accent = Object.fromEntries(palettePairs(theme.light)).accent;
    assert.ok(greys.has(colorName(accent)), `${slug}: ${colorName(accent)}`);
  }
});

test("groupOf 는 강조색의 채도와 색조, 바탕 밝기로 무리 넷 중 하나를 정한다", () => {
  assert.deepEqual(GROUPS.map((group) => group.id), ["minimal", "mono", "warm", "cool"]);
  const bundled = loadBundled().themes;
  const of = (slug) => groupOf(bundled.get(slug).light);
  assert.equal(of("vercel"), "minimal", "흰 바탕, 검정 강조색");
  assert.equal(of("x.ai"), "mono", "회색 바탕, 흰 강조색");
  assert.equal(of("airbnb"), "warm");
  assert.equal(of("clickhouse"), "warm", "색조 62도 노랑");
  assert.equal(of("nvidia"), "cool", "색조 82도 연두");
  assert.equal(of("slack"), "cool", "채도 0.21 자주는 무채색이 아니다");
  assert.equal(of("superhuman"), "minimal", "채도 0.12 남색은 무채색으로 본다");
  assert.equal(of("resend"), "cool", "보정 뒤 강조색(파랑)으로 나눈다. 원래 #fcfdff");
  assert.equal(groupOf(bundled.get("resend").light), of("resend"), "같은 입력, 같은 무리");
  // 🔴 한 무리가 너무 크거나 작으면 첫 질문이 쓸모없어집니다. 74종의 실제 분포.
  const counts = {};
  for (const [, theme] of bundled) {
    const id = groupOf(theme.light);
    counts[id] = (counts[id] || 0) + 1;
  }
  assert.deepEqual(counts, { minimal: 18, mono: 14, warm: 19, cool: 23 });
});

test("describeTheme 은 바탕 밝기, 강조색 이름, 본문 대비, 다크 모습을 적는다", () => {
  const bundled = loadBundled().themes;
  assert.equal(describeTheme(bundled.get("airbnb")),
    "흰 바탕, 분홍빛 빨강 강조색, 본문 대비 15.9:1(높음). "
    + "다크는 검정에 가까운 바탕, 분홍빛 빨강 강조색, 본문 대비 19.2:1(높음)");
  assert.match(describeTheme(bundled.get("claude")), /^누런 기가 도는 흰 바탕, /);
  assert.match(describeTheme(bundled.get("lamborghini")), /^노란빛 주황 바탕, /);
  // 🔴 설명은 CSS 로 나가는 값(보정 뒤)을 말합니다. bmw-m 의 원래 강조색은 흰색이고
  // 회색 바탕 위에서 안 보여 보정이 어둡게 옮깁니다.
  const bmw = describeTheme(bundled.get("bmw-m"));
  assert.doesNotMatch(bmw.split(". ")[0], /흰색 강조색/);
  assert.match(bmw, /회색 강조색/);
  assert.match(describeTheme(bundled.get("bmw-m"), { correct: false }), /^[^.]*흰색 강조색/,
               "대조군: 보정을 끄면 원래 흰색");
});

test("previewOf 는 라이트와 다크의 bg, surface, ink, accent 를 고정폭 블록으로 낸다", () => {
  const theme = loadBundled().themes.get("airbnb");
  const out = Object.fromEntries(palettePairs(theme.light));
  const dark = Object.fromEntries(palettePairs(theme.dark));
  assert.equal(previewOf(theme), [
    "```",
    "       bg       surface  ink      accent",
    `light  ${out.bg}  ${out.surface}  ${out.ink}  ${out.accent}`,
    `dark   ${dark.bg}  ${dark.surface}  ${dark.ink}  ${dark.accent}`,
    "```",
  ].join("\n"));
});

test("list --json 은 무리와 테마마다 설명, 미리보기를 내고 list 출력은 그대로다", () => {
  const data = listJson();
  assert.equal(data.themes.length, 74);
  assert.deepEqual(data.groups.map((group) => group.id), ["minimal", "mono", "warm", "cool"]);
  assert.equal(data.groups.reduce((sum, group) => sum + group.count, 0), 74);
  const plain = run(SCRIPT, ["list"]);
  assert.equal(plain.status, 0, plain.stderr);
  const lines = plain.stdout.trimEnd().split("\n");
  assert.deepEqual(data.themes.map((theme) => `${theme.slug}\t${theme.label}`), lines,
                   "list 와 같은 순서, 같은 이름");
  assert.ok(lines.every((line) => line.split("\t").length === 2), "list 는 두 칸 그대로");
  for (const group of data.groups) {
    assert.equal(group.slugs.length, group.count, group.id);
    assert.ok(group.label && group.summary, group.id);
    const members = data.themes.filter((theme) => theme.group === group.id);
    assert.deepEqual(group.slugs, members.map((theme) => theme.slug), `${group.id} 순서`);
  }
  const airbnb = data.themes.find((theme) => theme.slug === "airbnb");
  const bundled = loadBundled().themes.get("airbnb");
  assert.deepEqual(airbnb, { slug: "airbnb", label: "Airbnb", group: "warm",
                             description: describeTheme(bundled), preview: previewOf(bundled) });
  assert.deepEqual(listJson(), data, "같은 입력이면 같은 출력");
});

test("list --json 은 --only 로 줄고 빈 무리는 내지 않는다", () => {
  const data = listJson(["--only", "airbnb,vercel"]);
  assert.deepEqual(data.groups.map((group) => [group.id, group.slugs]),
                   [["minimal", ["vercel"]], ["warm", ["airbnb"]]]);
  assert.equal(data.themes.length, 2);
});

test("list --json 은 --design-md 테마도 같은 규칙으로 나누고 문서의 글을 옮기지 않는다", () => {
  const root = scratch("describe");
  try {
    mkdirSync(join(root, "brand"));
    writeFileSync(join(root, "brand", "DESIGN.md"), PROSE_DESIGN);
    const data = listJson(["--design-md", root, "--only", "brand"]);
    const [brand] = data.themes;
    const light = themeFromDesign(PROSE_DESIGN).light;
    assert.equal(brand.group, groupOf(light));
    assert.equal(brand.group, "warm", "#ff4f00 강조색");
    assert.match(brand.description, /^누런 기가 도는 흰 바탕, 주황빛 빨강 강조색, /);
    for (const word of ["Primary", "CTA", "hover", "near-black", "Cards"]) {
      assert.ok(!brand.description.includes(word) && !brand.preview.includes(word), word);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 🔴 질문 도구는 선택지 이름(표시명)을 돌려줍니다. 표시명이 겹치면 고른 것이
// 어느 테마인지 정할 수 없습니다. `labelOf` 는 `-` 와 `_` 를 같게 보고, 맞춰
// 보기는 대소문자를 보지 않으므로 그 둘을 모두 겹침으로 봅니다.
test("list --json 은 표시명이 겹치면 겹치는 것마다 슬러그를 붙인다", () => {
  const root = scratch("labels");
  try {
    for (const name of ["ide-vscode", "ide_vscode", "Airbnb"]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "DESIGN.md"), YAML_DESIGN);
    }
    const data = listJson(["--design-md", root,
                           "--only", "ide-vscode,ide_vscode,Airbnb,airbnb,stripe"]);
    const labels = Object.fromEntries(data.themes.map((theme) => [theme.slug, theme.label]));
    assert.deepEqual(labels, {
      Airbnb: "Airbnb (Airbnb)", airbnb: "Airbnb (airbnb)",
      "ide-vscode": "Ide Vscode (ide-vscode)", "ide_vscode": "Ide Vscode (ide_vscode)",
      stripe: "Stripe",
    });
    const lowered = Object.values(labels).map((label) => label.toLowerCase());
    assert.equal(new Set(Object.values(labels)).size, 5, "표시명이 겹친다");
    assert.equal(lowered.filter((label) => label === "stripe").length, 1, "겹치지 않으면 그대로");
    const plain = run(SCRIPT, ["list", "--design-md", root, "--only", "ide-vscode,ide_vscode"]);
    assert.equal(plain.stdout, "ide-vscode\tIde Vscode\nide_vscode\tIde Vscode\n",
                 "--json 없는 list 는 그대로");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 🔴 질문은 `$ARGUMENTS` 에 명령이 없을 때만 합니다(비었을 때, 자유 글이나 옵션만
// 있을 때). 명령을 준 호출(다른 스킬의 연쇄, 헤드리스 포함)은 예전처럼 진행하고,
// 질문 흐름에서도 전부를 고를 수 있어야 합니다.
test("SKILL.md: 선택지 질문은 명령이 없을 때만이고 전부를 고를 길이 있다", () => {
  const skill = readFileSync(join(HERE, "..", "SKILL.md"), "utf8");
  const step3 = skill.slice(skill.indexOf("3. 쓸 테마를 정한다."), skill.indexOf("4. CSS 를 낸다."));
  assert.match(step3, /`\$ARGUMENTS` 에 명령\(`list`, `css`, `json`, `widget`, `check`\)이 없을 때만/);
  assert.match(step3, /자유 글은 셸에 넣지 않는다/);
  assert.match(step3, /`--design-md` 가 있으면 그 테마를 포함해/);
  assert.match(step3, /모르면 `node <스킬>\/scripts\/themes\.mjs list` 로 목록을 보고 사용자에게 묻는다/);
  assert.doesNotMatch(step3, /인자가 없을 때를 포함해/);
  const pick = skill.slice(skill.indexOf("## 테마 고르기"), skill.indexOf("## 경고"));
  assert.match(pick, /- `전부`: /);
  assert.match(pick, /물을 수 없는 실행[^\n]*명령이 없으면/);
  assert.match(pick, /두 테마 이상과 맞으면/);
  assert.match(pick, /기타 낱말이 먼저/);
});

// 🔴 기타 낱말(전부, 더 보기, 다른 무리)과 이름이 같은 테마는 표시명 겹침과 같게
// ` (슬러그)` 를 붙입니다. 기타에 낱말을 적으면 낱말로 처리하고, 그 테마는 선택지나
// 붙인 표시명으로 고릅니다. 엔진이 그런 슬러그를 거절하면 그 DESIGN.md 를 쓰는
// css, check 까지 멈추므로 거절하지 않습니다.
test("list --json 은 기타 낱말과 같은 표시명에도 슬러그를 붙인다", () => {
  const root = scratch("words");
  try {
    for (const name of ["전부", "더-보기", "다른_무리", "더보기"]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "DESIGN.md"), YAML_DESIGN);
    }
    const data = listJson(["--design-md", root, "--only", "전부,더-보기,다른_무리,더보기"]);
    const labels = Object.fromEntries(data.themes.map((theme) => [theme.slug, theme.label]));
    assert.deepEqual(labels, { 전부: "전부 (전부)", "더-보기": "더 보기 (더-보기)",
                               다른_무리: "다른 무리 (다른_무리)", 더보기: "더보기" });
    const css = run(SCRIPT, ["css", "--design-md", root, "--only", "전부"]);
    assert.equal(css.status, 0, css.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--json 은 check 와 list 에서만 받는다", () => {
  assert.equal(parseArgs(["list", "--json"]).json, true);
  for (const command of ["css", "json", "widget"]) {
    assert.throws(() => parseArgs([command, "--json"]), /check and list only/, command);
  }
});
