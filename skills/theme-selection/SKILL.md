---
name: theme-selection
description: "프로젝트에 테마 74종을 라이트와 다크 한 쌍씩(148 조합) CSS 사용자 지정 속성으로 입힘. 대비 보정을 거친 값을 내고, 테마 고르개(HTML과 스크립트)와 대비 감사(check)도 냄. 프로젝트의 DESIGN.md 도 읽어 테마로 더함. Node 만 쓰고 인터넷을 쓰지 않음. 'theme-selection'/'테마 선택'/'테마 추가'/'테마 입히기'/'다크모드 추가' 시 사용. 일반 UI 작업에서는 자동 실행 금지."
argument-hint: "list | css | json | widget | check [--design-md PATH] [--only SLUGS] [--default SLUG] [--prefix STR] [--dark-via attr|media|class] [--out FILE] [--json]"
---

# theme-selection - 테마 74종, 라이트와 다크, 대비 보정

테마 74종, 라이트와 다크 148 조합, 대비 보정 포함, 인터넷 없음. 엔진은 Node 하나(`scripts/themes.mjs`)이고 의존성이 없다.
붙이는 방법은 `references/integrate.md`, 보정이 이 모양인 이유는 `references/contrast.md` 에 있다.
번들 팔레트의 출처와 라이선스는 `assets/NOTICE.md` 에 있다.

인자: `$ARGUMENTS`
- 명령과 옵션이 있으면 그것으로 아래 절차를 따른다. 비어 있으면 절차대로 묻는다.
- Codex: 사용자 메시지에서 읽는다.
- 사용자 입력을 셸 명령에 그대로 붙이지 않는다. 명령과 옵션은 아래 표에 있는 것만 쓴다.
- 🔴 경로는 작은따옴표로 감싼다(bash, zsh, PowerShell 모두). 큰따옴표 안의 `$(...)` 와 백틱은 셸이 엔진보다 먼저 실행한다.
- 경로에 작은따옴표(`'`, 그리고 PowerShell 이 같게 읽는 `‘` `’` `‚` `‛`), `$`, 백틱, 줄바꿈이 있으면 실행하지 않고 사용자에게 알린다.

## 절차

1. 스킬 디렉터리의 절대경로를 정한다. 경로를 추측하지 않는다. 아래 `<스킬>` 은 그 경로다.

   | 런타임 | 스킬 디렉터리 |
   |---|---|
   | Claude Code | 이 파일 맨 위에 넣어 준 "Base directory for this skill:" 줄의 경로 |
   | Codex | `~/.codex/skills/banker-theme-selection/` 의 절대경로. 프로젝트 범위 설치면 `./.codex/skills/banker-theme-selection/` |

   - `~` 는 따옴표 안에서 펼쳐지지 않으니 절대경로를 쓴다.
2. 프로젝트에 `DESIGN.md` 가 있으면 `--design-md` 로 함께 먹인다. 없으면 번들 74종만 쓴다.
   - 파일, `DESIGN.md` 를 담은 폴더, `<이름>/DESIGN.md` 를 담은 폴더를 모두 받는다.
   - `<이름>/DESIGN.md` 가 여럿이면 그 부모 폴더 하나를 넘긴다. 하위 경로를 하나씩 셸에 적지 않는다. 폴더 이름은 엔진이 검사한다.
   - 여러 번 줄 수 있고 뒤가 이긴다. 슬러그가 같으면 번들을 덮는다.
   - 슬러그(폴더 이름이나 확장자를 뗀 파일 이름)는 글자(한글 포함), 숫자, `.`, `-`, `_` 만 받는다. 빈칸, 다른 기호, 보이지 않는 글자가 있으면 종료 코드 2 로 멈춘다. 이름을 바꾸자고 사용자에게 알린다.
   - 한글 이름은 NFC 로 맞춰 읽는다. macOS 의 분해형 폴더 이름도 `--only 쇼핑몰` 과 맞는다.
3. 쓸 테마를 정한다. 사용자가 고르면 `--only` 로 줄인다.
   - 74종 전부를 내면 테마 규칙만 148 개다. 쓸 것만 `--only` 로 고르는 쪽을 먼저 권한다.
   - 모르면 `node <스킬>/scripts/themes.mjs list` 로 목록을 보고 사용자에게 묻는다. 2단계에서 `--design-md` 를 정했으면 `list` 에도 준다.
4. CSS 를 낸다.
   - `node <스킬>/scripts/themes.mjs css --only a,b,c --out <프로젝트 CSS 경로>`
   - `--out` 은 이미 있는 파일을 묻지 않고 덮어쓴다. 그 경로에 파일이 있으면 먼저 사용자에게 묻는다.
   - 프로젝트가 다크를 `class` 나 `@media` 로 다루면 `--dark-via class` 나 `--dark-via media` 를 준다.
5. 테마를 고르는 사람이 있는 화면이면 고르개를 붙인다.
   - `node <스킬>/scripts/themes.mjs widget --only a,b,c` 가 세 덩이를 낸다. CSS 를 낼 때와 같은 `--only`, `--default`, `--dark-via` 를 준다. `--default` 가 다르면 첫 방문의 고르개 테마와 `:root` 테마가 갈린다.
   - 모드 버튼은 `data-mode` 속성과 `.dark` 클래스를 함께 바꾼다. 그래서 `attr`, `class` 둘 다 맞는다. `media` 면 모드 버튼 없이 낸다(다크는 OS 설정을 따름).
   - 어디에 두는지는 `references/integrate.md` 의 고르개 절을 따른다.
   - 모드만 쓰는 화면은 고르개 없이 `--dark-via media` 로 끝낸다. `:root` 가 기본 테마의 다크도 들고 있어 `<html>` 에 속성이 없어도 OS 가 다크면 다크가 된다.
6. 프로젝트 CSS 가 변수를 읽게 한다. 순서는 `references/integrate.md` 에 있다.
7. `check` 로 확인한다. CSS 를 낼 때 준 `--only`, `--design-md`, `--target`, `--label-target` 을 같게 준다.
   - 🔴 `--out` 은 주지 않는다. 주면 그 파일이 감사 결과로 덮인다.
   - 종료 코드 0 이 되고, 실제 화면까지 본 뒤에 끝났다고 말한다. 확인 절을 따른다.

## 경고

- 🔴 배선 스크립트를 `ready` 래퍼 없이 넣으면 고르개가 영원히 안 움직인다.
  - 이 스크립트는 자기가 배선할 마크업보다 먼저 돌 수 있다. `getElementById` 가 빈손이 된다.
  - `widget` 이 낸 배선 스크립트는 `readyState` 를 보고 즉시 또는 `DOMContentLoaded` 에서 부르는 래퍼로 감싸져 있다. 래퍼를 떼지 않는다.
  - head 스크립트는 DOM 을 안 보므로 `<head>` 에서 즉시 돈다. 배선 스크립트와 합치지 않는다.
- 🔴 `-on-surface` 가 붙은 변수는 `--bg` 위 규칙에 쓰지 않는다. 본문이 흐려진다.
- 🔴 `--target` 을 4.5 로 올리지 않는다. 74 테마의 색이 전부 평평해져 테마가 테마가 아니게 된다.
- 🔴 `--rule` 은 대비가 보장되지 않는다. 경계선만으로 정보를 전달하지 않는다.
  - 148 조합 중 122 조합이 `--bg` 대비 3.0 아래이고, 35 조합은 1.5 아래다.
  - `lamborghini/light` 은 `--rule` 과 `--bg` 가 같은 색이라 대비가 1.00 이다. 경계선이 안 보인다.
  - 누를 수 있는 것, 고른 것, 틀린 칸은 경계선 말고 글자색이나 배경색으로도 표시한다.
- `--no-correct` 는 대조군 전용이다. 프로젝트에 나가는 CSS 에 쓰지 않는다.

## 명령

실행 형식: `node <스킬>/scripts/themes.mjs <명령> [옵션]`

| 명령 | 내는 것 |
|---|---|
| `list` | `슬러그<탭>표시명` 한 줄에 하나 |
| `css` | CSS 사용자 지정 속성. 라이트와 다크 |
| `json` | 보정된 팔레트를 JSON 으로 |
| `widget` | 테마 고르개 HTML 과 스크립트 둘 |
| `check` | 대비 감사. 하나라도 어긋나면 종료 코드 1 |

| 옵션 | 뜻 |
|---|---|
| `--design-md PATH` | DESIGN.md 를 읽어 테마를 더하거나 덮는다. 여러 번 줄 수 있고 뒤가 이김 |
| `--only SLUGS` | 쉼표로 가른 허용 목록. 기본은 전부 |
| `--default SLUG` | `:root` 가 들 테마. 기본 `superhuman`. 걸러져 없으면 첫 슬러그 |
| `--prefix STR` | 변수 13개와 `--shadow` 앞에 붙는 문자열. 영문, 숫자, `-`, `_` 만. 기본은 빈 문자열 |
| `--dark-via MODE` | `attr`(기본), `media`, `class`. `css` 와 `widget` 에 같은 값을 준다 |
| `--target N` | `-on-surface` 와 `accent` 의 목표 대비. 기본 3.0 |
| `--label-target N` | 버튼 글자 목표 대비. 기본 4.5. 4.58 을 넘기면 답 없는 조합이 생기고 `check` 가 그 자리를 보고함 |
| `--no-correct` | 보정 없이 원본 값을 냄. 대조군 전용 |
| `--out FILE` | 표준출력 대신 파일로. 있는 파일은 덮어씀. 그 파일 자체가 심볼릭 링크면 쓰지 않음(종료 2). 상위 폴더의 링크는 따라감 |
| `--json` | `check` 에서만. 기계가 읽는 감사 결과 |

| 종료 코드 | 뜻 |
|---|---|
| 0 | 정상 |
| 1 | `check` 가 어긋난 자리를 찾음 |
| 2 | 인자가 틀림(허용 밖 슬러그와 접두사 포함). 파일을 읽거나 쓰지 못함(`--out` 이 심볼릭 링크 포함) |

`check --json` 은 아래 필드를 낸다. 사람이 읽는 출력 대신 쓸 수 있다.

| 필드 | 뜻 |
|---|---|
| `themes` | 잰 테마 수 |
| `combos` | 잰 조합 수. 테마당 둘 |
| `checks` | 단언 수 |
| `corrected` | 보정을 켰는지 |
| `violations` | 어긋난 자리 수 |
| `bad` | 어긋난 자리 목록 |
| `detail` | 조합마다 `slug`, `mode`, `body`(본문 대비), `violations` |

선택자는 `--dark-via` 에 따라 갈린다. `:root` 는 언제나 먼저 나오고 기본 테마의 라이트와 다크를 든다.
JS 가 꺼졌거나, 저장된 이름이 목록 밖이거나, `<html>` 에 `data-theme` 이 없어도 화면이 읽히는 이유다.
테마 규칙은 같은 모드의 `:root` 규칙보다 특정성이 높아 이긴다.

| `--dark-via` | 라이트 | 다크 | `:root` 의 다크 |
|---|---|---|---|
| `attr` | `html[data-theme="<슬러그>"]` | `html[data-theme="<슬러그>"][data-mode="dark"]` | `:root[data-mode="dark"]` |
| `class` | `html[data-theme="<슬러그>"]` | `html[data-theme="<슬러그>"].dark` | `:root.dark` |
| `media` | `html[data-theme="<슬러그>"]` | `@media (prefers-color-scheme: dark){html[data-theme="<슬러그>"]{...}}` | `@media (prefers-color-scheme: dark){:root{...}}` |

## 변수

조합 하나가 13개를 낸다. 순서도 이대로다.

🔴 `-on-surface` 가 붙은 넷은 배경이 `--surface` 인 규칙에서만 쓴다. `--bg` 위 규칙이 이것을 쓰면 본문이 흐려진다.

| 변수 | 쓰는 자리 |
|---|---|
| `--bg` | 페이지 배경 |
| `--surface` | 카드, 상자, 패널 배경 |
| `--ink` | `--bg` 위 본문 글자 |
| `--dim` | `--bg` 위 보조 글자 |
| `--rule` | 구분선, 경계선 |
| `--accent` | `--bg` 위 링크, 강조, 버튼 경계 |
| `--warn` | `--bg` 위 경고, 위험 표시 |
| `--ink-on-surface` | `--surface` 위 본문 글자 |
| `--dim-on-surface` | `--surface` 위 보조 글자 |
| `--accent-on-surface` | `--surface` 위 강조, 버튼 배경 |
| `--warn-on-surface` | `--surface` 위 경고, 위험 버튼 |
| `--label-on-accent` | `--accent-on-surface` 를 배경으로 한 버튼 글자 |
| `--label-on-page-accent` | `--accent` 를 배경으로 한 버튼 글자 |

`--shadow` 는 테마가 아니라 모드의 성질이라 테마마다 넣지 않고 한 번만 낸다.

    html{--shadow:rgba(0,0,0,.08)}
    html[data-mode="dark"]{--shadow:rgba(0,0,0,.45)}

148 조합 중 `ink` 와 `dim` 값이 `-on-surface` 쪽과 실제로 갈라지는 것은 3 조합(값 넷)뿐이다. 나머지 145 조합은 두 변수가 같은 값이라 화면이 안 바뀐다.

## 확인

끝났다고 말하기 전에 둘 다 한다.

1. `check` 종료 코드.
   - `node <스킬>/scripts/themes.mjs check` 에 CSS 를 낼 때 준 `--only`, `--design-md`, `--target`, `--label-target` 을 같게 준다. `--out` 은 주지 않는다.
   - 0 이면 통과다. 1 이면 출력의 어긋난 자리를 사용자에게 보여 준다.
   - 2 이면 인자를 고쳐 다시 돌린다.
2. 실제 화면.
   - 브라우저로 페이지를 열고 테마를 바꿔 본다. 라이트와 다크를 둘 다 본다.
   - 🔴 마크업에 속성이 있다는 것과 그 속성을 읽는 코드가 돌았다는 것은 다른 사실이다. JS 가 하는 일은 JS 를 돌려서 잰다.
   - 고르개로 테마를 고른 뒤 `document.documentElement.dataset.theme` 이 바뀌었는지 읽는다.
   - 다크는 고르개의 모드 버튼으로 본다. 고르개가 없으면 OS 다크 설정이나 브라우저 개발 도구의 색 구성 흉내로 본다.
   - 새로고침한 뒤 같은 테마가 첫 그림부터 나오는지 본다.
   - 브라우저를 쓸 수 없으면 확인하지 못했다고 적는다. 통과로 적지 않는다.

`check` 는 본문 대비(`--ink` 대 `--bg`)를 보고만 하고 판정하지 않는다.
