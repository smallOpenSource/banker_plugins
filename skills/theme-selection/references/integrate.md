# 프로젝트에 테마 붙이기

대상 독자: 자기 프로젝트에 `theme-selection` 출력을 넣는 사람.
`<스킬>` 은 스킬 디렉터리 절대경로다. 명령과 옵션은 `SKILL.md` 의 표를 따른다.

## 공통 순서
1. `css` 로 CSS 파일을 낸다.
2. 프로젝트가 그 파일을 읽는다.
3. `<html>` 에 `data-theme` 과 `data-mode` 속성이 걸린다. 걸지 않아도 `:root` 가 기본 테마의 라이트와 다크를 들고 있어 화면이 읽힌다. 다크는 `--dark-via` 로 고른 자리(속성, 클래스, OS 설정)를 따른다.
4. 색을 쓰는 자리는 하드코딩 대신 `var(--ink)` 처럼 변수를 쓴다.

```
node <스킬>/scripts/themes.mjs css --only superhuman,airbnb,stripe --out public/themes.css
```

## 순수 CSS

`<link>` 하나와 `var(--ink)` 면 된다.

```html
<link rel="stylesheet" href="/themes.css">
```

```css
body { background: var(--bg); color: var(--ink); }
.card { background: var(--surface); color: var(--ink-on-surface); border: 1px solid var(--rule); }
.card .muted { color: var(--dim-on-surface); }
a { color: var(--accent); }
.card a { color: var(--accent-on-surface); }
.card .danger { color: var(--warn-on-surface); box-shadow: 0 1px 4px var(--shadow); }
.btn-primary { background: var(--accent-on-surface); color: var(--label-on-accent); }
.get:hover { background: var(--accent); color: var(--label-on-page-accent); }
```

배경이 `--surface` 인 규칙만 `-on-surface` 변수를 쓴다. `--bg` 위 규칙은 `--ink`, `--dim`, `--accent`, `--warn` 이다.

## Tailwind

CSS 변수를 `theme.extend.colors` 에 매핑한다. 변수는 `#rrggbb` 값이라 그대로 `var()` 로 연결한다.

```js
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        ink: "var(--ink)",
        dim: "var(--dim)",
        rule: "var(--rule)",
        accent: "var(--accent)",
        warn: "var(--warn)",
        "ink-on-surface": "var(--ink-on-surface)",
        "dim-on-surface": "var(--dim-on-surface)",
        "accent-on-surface": "var(--accent-on-surface)",
        "warn-on-surface": "var(--warn-on-surface)",
        "label-on-accent": "var(--label-on-accent)",
        "label-on-page-accent": "var(--label-on-page-accent)",
      },
    },
  },
};
```

이 방식은 `bg-surface text-ink-on-surface` 처럼 쓴다. Tailwind 의 `dark:` 변형을 쓰려면 `--dark-via class` 로 CSS 를 내고 `darkMode: "class"` 를 맞춘다.
고르개를 붙이면 `widget` 에도 `--dark-via class` 를 준다. 모드 버튼이 `data-mode` 와 `.dark` 를 함께 바꾸므로 이 설정과 맞는다.
`--prefix` 를 줬다면 `var(--<prefix>bg)` 처럼 이름을 맞춘다.

## React 와 Vue

속성은 `document.documentElement` 에 건다. 컴포넌트 안의 `div` 에 걸면 선택자 `html[data-theme=...]` 가 맞지 않는다.

```jsx
// React
import { useEffect, useState } from "react";
export function useTheme(allowed, fallback) {
  const [theme, setTheme] = useState(() => {
    let saved = null;
    // 서버 렌더에는 localStorage 가 없고, 저장소를 막은 브라우저는 예외를 던진다.
    try { saved = localStorage.getItem("theme"); } catch { saved = null; }
    return allowed.includes(saved) ? saved : fallback;
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("theme", theme); } catch { /* 막힌 저장소 */ }
  }, [theme]);
  return [theme, setTheme];
}
```

Vue 3 도 같다. `ref` 에 이름을 담고 `watchEffect` 안에서 `document.documentElement.setAttribute("data-theme", theme.value)` 를 부른다.

모드(`data-mode="dark"`)도 같은 자리에 같은 방식으로 건다. `--dark-via class` 로 냈으면 `classList.toggle("dark", 다크인지)` 로 `.dark` 를 건다. 저장된 값은 허용 목록에 대어 본 뒤에 쓴다.

첫 그림 전의 깜빡임은 아래 head 스크립트를 `index.html` 의 `<head>` 에 두어야 막는다.

## SCSS 와 styled-components

- SCSS: `color: var(--ink);` 처럼 변수를 그대로 쓴다. SCSS 변수에 값을 복사하지 않는다.
- styled-components: 템플릿 안에 `color: var(--ink);` 를 그대로 쓴다. `ThemeProvider` 로 값을 다시 들고 있지 않는다.

## 고르개 붙이기

`widget` 이 세 덩이를 주석으로 가른 하나의 출력으로 낸다.

```
node <스킬>/scripts/themes.mjs widget --only superhuman,airbnb,stripe --out widget.html
```

CSS 를 낼 때와 같은 `--dark-via` 를 준다. 모드 버튼은 `data-mode` 와 `.dark` 를 함께 바꾸고, `--dark-via media` 면 버튼이 없다(다크는 OS 설정을 따름).

| 덩이 | 두는 곳 | 하는 일 |
|---|---|---|
| 고르개 마크업 | 페이지의 헤더 등 보이는 자리 | `<select>` 와 모드 버튼 |
| head 스크립트 | `<head>` | 저장된 이름을 `document.documentElement` 에 바로 건다 |
| 배선 스크립트 | 마크업 뒤나 `<body>` 끝 | 고르개 요소를 찾아 묶는다 |

🔴 head 스크립트는 `<head>` 에, 배선 스크립트는 `ready` 래퍼와 함께 둔다. 둘을 합치지 않는다.

- head 스크립트는 DOM 을 보지 않는다. 그래서 `<head>` 에서 즉시 돌아도 된다. 즉시 도는 것이 첫 그림의 깜빡임을 막는다.
- 배선 스크립트는 마크업을 본다. 마크업이 아직 없을 때 돌면 `getElementById` 가 빈손이고 고르개가 영원히 안 움직인다.
- 배선 스크립트는 `readyState` 를 보고 즉시 또는 `DOMContentLoaded` 에서 부르는 래퍼로 감싸져 있다. 이 래퍼를 떼지 않는다.

저장된 이름은 닫힌 집합(박혀 있는 테마 목록)에 대어 본다. 목록 밖이면 기본 테마로 되돌린다.

CSP(Content-Security-Policy)를 쓰는 사이트는 인라인 스크립트 둘에 nonce 나 해시를 붙인다. `'unsafe-inline'` 으로 풀지 않는다.

## 모드만 쓰는 화면

테마를 고르는 사람이 없고 라이트와 다크만 OS 설정을 따르면 되면 고르개가 필요 없다.

```
node <스킬>/scripts/themes.mjs css --only superhuman --dark-via media --out public/themes.css
```

`@media (prefers-color-scheme: dark)` 안에 다크 값이 들어간다. `:root` 도 기본 테마의 다크를 그 안에 들고 있어, `<html>` 에 속성을 걸지 않아도 OS 가 다크면 다크가 된다. JS 가 없어도 된다.

## 서버 렌더

저장된 이름을 쿠키로 받아 `<html>` 속성에 미리 박는 쪽이 깜빡임이 없다.

```js
// 예: Express
const THEMES = new Set(["superhuman", "airbnb", "stripe"]);
app.get("/", (req, res) => {
  const t = THEMES.has(req.cookies.theme) ? req.cookies.theme : "superhuman";
  const m = req.cookies.mode === "dark" ? "dark" : "light";
  res.send(`<!doctype html><html data-theme="${t}" data-mode="${m}">...`);
});
```

- 쿠키 값은 허용 목록에 대어 본 값만 속성에 넣는다. 그대로 넣으면 속성 주입이 된다.

## CSS 크기

- 테마당 규칙이 둘이다. 라이트 하나, 다크 하나.
- 규칙마다 13 선언이다.
- 74종 전부면 148 규칙이다.
- 여기에 `:root` 의 기본 테마 라이트와 다크 둘, `--shadow` 둘이 더해진다.
- 쓸 테마만 `--only` 로 줄이는 쪽을 권한다.
