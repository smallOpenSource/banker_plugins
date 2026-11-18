# 장면 API

섹션마다 `scenes/NN.js` 하나(NN = 섹션 번호 두 자리). 예시 6개가 `<S>/assets/sample/scenes/` 에 있다. 엔진은 `<S>/scripts/runtime/engine.js`.

## 장면 파일

```js
Deck.scene({
  section: 2,                       // 파일 이름의 NN 과 같아야 함
  css: `
.s02 .title { position: absolute; left: 160px; top: 300px; }
`,
  html: (d) => `<h1 class="title t-display" data-r="title">${d.esc(d.lines('s2-1')[0])}</h1>`,
  steps: {                          // 키 = 대본의 단계 id, 순서까지 같아야 함
    's2-1'(s) { s.fadeUp('title', { at: 0.1 }); },
    's2-2'(s) { s.dim('title'); },
  },
});
```

- 장면의 최상위 요소는 `<section class="scene sNN">` 이고 크기는 1920 x 1080 이다. CSS 는 `.sNN` 으로 시작하고 `position: absolute` 와 무대 px 로 놓는다.
- 요소 이름은 `data-r="이름"`. helper 는 이름, 장면 안 CSS 선택자, 요소, 그 배열을 받는다.
- 섹션 첫 단계는 앞 장면과 0.25초 교차 페이드로 시작한다. 장면 파일이 없는 섹션은 화면 줄을 보여 주는 임시 장면이 된다.
- 단계 길이는 그 단계 마지막 애니메이션의 끝(최소 0.3초)이다. 다음 키는 이전 단계 끝에서 이 단계 끝까지 재생한다.

## `html(d)` 의 `d`

| 이름 | 뜻 | 예 |
|---|---|---|
| `d.lines(id)` | 그 단계의 화면 줄 배열(대본 그대로) | `d.lines('s1-1')[0]` |
| `d.step(id)` | 단계 데이터(`key`, `lines`, `directions`) | `d.step('s1-1').key` |
| `d.esc(text)` | HTML 이스케이프 | `d.esc(t)` |
| `d.asset(name)` | `media/` 의 그림을 data URL 로. 이 호출로 이름을 적은 그림만 HTML 에 들어감. png, jpg, webp, svg | `<img src="${d.asset('cup.svg')}">` |
| `d.rand(seed)` | 같은 수열을 내는 무작위 함수 | `const r = d.rand(7); r()` |

## 움직일 수 있는 값(채널)

| 키 | 채널(CSS 속성) | 단위 |
|---|---|---|
| `x`, `y` | `translate` | px |
| `scale`(둘 다), `scaleX`, `scaleY` | `scale` | 배수 |
| `rotate` | `rotate` | 도 |
| `opacity` | `opacity` | 0~1 |

- 값은 숫자만. 그 밖의 키(`backgroundPosition`, `width`, 색, `filter` 등)는 `"<키>" cannot be animated` 빌드 오류다.
- `scale` 은 0 에서 1 사이(그리기)나 1 근처(작은 튀김)로만 쓴다. 1~2px 요소를 수십 배로 늘려 크기를 만들지 않는다. 처음부터 끝 크기로 두고 그린다. `decorations` 게이트가 늘린 조각을 FAIL 로 잡는다(`traps.md`).
- 한 요소의 한 채널은 키프레임 트랙 하나로 합쳐진다. 같은 요소, 같은 채널의 두 애니메이션이 시간이 겹치면 `two <채널> animations overlap` 오류다. 다른 채널(예: `y` 와 `opacity`)은 겹쳐도 된다.
- `from` 을 주면 그 애니메이션 전까지 그 값으로 숨어 있다(처음 상태). `null` 이면 그 시점의 값에서 시작한다.
- 이징: `out`(기본, 감속), `out3`, `soft`, `in`, `inOut`, `linear`, 또는 `cubic-bezier(a, b, c, d)`.

## 단계 함수의 `s`

모든 시간은 단계 시작에서 잰 초. helper 는 `{ at, dur }` 를 받고 끝 시각을 돌려준다. 이어 붙일 때 쓴다: `const t = s.fadeUp('a'); s.fadeUp('b', { at: t })`.

| helper | 하는 일(기본값) | 예 |
|---|---|---|
| `s.tween(q, from, to, { at, dur, ease, stagger })` | 일반형. 위 채널만 | `s.tween('pan', { opacity: 0, x: 240 }, { opacity: 1, x: 0 }, { dur: 1.2 })` |
| `s.move(q, to, o)` | 지금 값에서 `to` 로(0.6초) | `s.move('num', { y: -140, scale: 0.4 })` |
| `s.fadeUp(q, { y = 24 })` | 나타나며 조금 떠오름(0.4초) | `s.fadeUp('title', { at: 0.1 })` |
| `s.fadeIn(q)` | 투명도만(0.4초) | `s.fadeIn('bean', { stagger: 0.05 })` |
| `s.fadeOut(q)` | 사라짐(0.3초) | `s.fadeOut(['cup', 'pan'])` |
| `s.dim(q, { to = 0.35 })` | 흐리게 | `s.dim('num', { to: 0.35 })` |
| `s.chips(q, { stagger = 0.3, ring })` | 칩을 하나씩. `ring` 을 주면 그 이름의 강조 묶음이 새 칩으로 옮겨 감(`s.focus` 와 같음) | `s.chips('chip', { ring: 'pick' })` |
| `s.rows(q, { stagger = 0.4 })` | 표의 행을 위에서 아래로 | `s.rows('row', { at: 0.5 })` |
| `s.draw(q, { axis })` | 막대가 시작점에서 그려짐(scale). 축은 모양에서 | `s.draw('mark', { axis: 'y' })` |
| `s.connector(a, b, { route })` | 선과 화살촉. `route`: `'h'`(오른쪽에서 왼쪽, 기본), `'v'`(아래에서 위), `'wrap'`(아래로 내려가 왼쪽으로 돌아 둘째 줄로 감, 꺾는 위치는 옵션 `x`) | `s.connector('fb2', 'fb3', { route: 'wrap', x: 220 })` |
| `s.box(q)` | `.dbox` 테두리가 라벨 오른쪽부터 시계 방향으로 그려지고 `.dbox-label` 이 나옴(0.7초) | `s.box('tools', { at: 0.3 })` |
| `s.strike(q, { to = 0.4 })` | 취소선이 왼쪽부터, 이어서 흐려짐 | `s.strike('m0')` |
| `s.focus(group, target, { pad = 10, pop = 1.06 })` | 대상에 강조 테두리를 켬. 테두리는 대상 안에 붙은 요소 하나로, 대상의 둥근 모서리에 `pad` 를 더한 모양. 투명도가 0 에서 1 로, 크기가 `pop` 에서 1 로 바뀜. 같은 `group` 의 앞 대상 테두리는 사라짐. `target` 이 `null` 이면 끔 | `s.focus('pick', 'fb2')` |
| `s.bigNumber(num, sub, { subAt = 0.4 })` | 큰 숫자, 이어서 회색 부제 | `s.bigNumber('num', 'sub')` |
| `s.accent(q, { to = 1 })` | `.acc` 요소가 강조색으로(겹친 복사본의 투명도) | `s.accent('temp')` |
| `s.fill(blank, word)` | `.blank` 의 빗금이 사라지고 낱말이 떠오름 | `s.fill('blank', 'word')` |
| `s.underline(bar, text, { pad = 8, gap = 4 })` | 글자 폭에 맞춘 밑줄. 막대(`.ul`)의 위치와 폭을 글의 잉크 상자로 정하고 왼쪽부터 그림. 막대와 글은 같은 부모 층에 둠 | `s.underline('ul', 'kw', { at: 0.6 })` |
| `s.mark(q)` | 낱말 뒤 형광 상자가 왼쪽부터(이웃 글은 그대로) | `s.mark('taste', { at: 1.0 })` |
| `s.kicker(q)` | 작은 제목이 왼쪽 12px 에서 미끄러져 나타남 | `s.kicker('kick')` |
| `s.reveal(q, { from = 'left' })` | 닦아 내듯 열림. 요소는 창, 자식 하나가 내용. `left`, `right`, `top`, `bottom` | `s.reveal('cup', { dur: 0.8 })` |
| `s.swap(a, b)` | 같은 자리에서 a 가 줄며 사라지고 b 가 커지며 나타남 | `s.swap('q', 'pref')` |
| `s.hold(sec)` | 단계를 적어도 그만큼 유지 | `s.hold(1.2)` |
| `s.rand(seed)` | 같은 수열을 내는 무작위 함수 | `const r = s.rand(3)` |
| `s.$(q)`, `s.el(q)` | 요소 배열, 첫 요소 | `s.el('title')` |
| `s.geom(q)`, `s.ink(q)` | 장면 기준 상자 `{ x, y, w, h, cx, cy, r, b }`, 글 잉크 상자 | `s.ink('kw').r` |

## 공용 클래스(`engine.css`)

| 클래스 | 쓰임 |
|---|---|
| `.t-hero` 200, `.t-display` 104, `.t-h1` 72, `.t-h2` 56, `.t-body` 44, `.t-small` 40 | 글자 크기(px) |
| `.muted` | 회색 글 |
| `.kicker` | 작은 제목, 왼쪽 위(160, 128) |
| `.chip`, `.fbox` | 테두리 칩, 흐름 상자(`s.connector` 와 함께) |
| `.fx-focus` | 강조 테두리. `s.focus` 가 대상 안에 만듦. 장면 CSS 에서 테두리 굵기와 빛번짐만 바꿈. 대상이 `overflow: hidden` 이면 잘리므로 그런 대상에는 쓰지 않음 |
| `.dbox` + `.dbox-label` | 라벨이 테두리 위에 있는 묶음 상자. 엔진이 변을 만듦 |
| `.acc` | `s.accent` 대상. 엔진이 강조색 복사본을 겹침 |
| `.ul` | 밑줄 막대(`s.underline`) |
| `.blank` + `.blank-hatch` + `.blank-word` | 빈칸 채우기 |
| `.layer` | 함께 움직일 요소를 묶는 1920 x 1080 층 |

- 색은 테마 변수만 쓴다: `--bg`, `--fg`, `--muted`, `--line`, `--soft`, `--accent`(강조 글), `--accent-solid`(막대, 테두리), `--mark`(형광). 기본은 다크, `?theme=light` 로 라이트.

## 장면에서 쓰지 않는 것

빌드가 장면 소스(주석 제외)를 검사해 거절한다.

| 금지 | 까닭 | 대신 |
|---|---|---|
| `Math.random` | 열 때마다 화면이 달라짐 | `d.rand(seed)`, `s.rand(seed)` |
| `Date`, `performance.now` | 시계에 따라 달라짐 | 단계 시간(`at`) |
| `setTimeout`, `setInterval`, `requestAnimationFrame` | 엔진의 시계 하나만 화면을 움직임 | helper |
| `el.animate`, `new Animation`, `KeyframeEffect` | 타임라인 밖의 애니메이션은 이동(seek)에 따르지 않음 | `s.tween` |
| `onfinish`, `.finished`, `.ready.then`, `addEventListener` | 콜백으로 바꾼 상태는 바로 건너뛸 때 생기지 않음 | 키프레임만 |
| `gsap` | 쓰지 않는 엔진 | helper |

## 발표 조작

| 키 | 동작 |
|---|---|
| 클릭, Enter, Space, ArrowDown, ArrowRight, PageDown | 다음 단계 재생. 재생 중에 누르면 그 단계를 끝 상태로 마침(건너뛰지 않음) |
| PageUp, ArrowUp, ArrowLeft, Backspace | 이전 단계의 끝 상태로 |
| Alt+Enter, Shift+Enter | 전체 화면 |
| B | 화면 가리기 |
| 주소 `#<n>` | n 번째(0부터) 단계의 끝 상태로 엶 |

- 해시 없이 열면 첫 단계를 한 번 재생한다. `prefers-reduced-motion` 이면 재생 대신 끝 상태를 바로 보인다.
- 시험용 `window.__deck`: `ids`, `steps`(`{ id, start, end }`), `duration`, `time`, `animating`, `index`, `jump(i)`, `play(i)`, `seek(t)`, `next()`, `prev()`.
