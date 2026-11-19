---
name: presentation-graphic-gen
description: "사용자의 화면/말 대본 초안으로 키를 한 번 누를 때마다 한 단계씩 움직이는 모션 그래픽 발표 자료를 만듦. 단일 HTML(검토용, 발표용)과 PPTX(단계마다 자동 재생 영상, 편집 가능한 도형)를 냄. 엔진, 글꼴, 영상 인코더가 스킬 안에 있어 설치와 내려받기 없이 오프라인에서 동작. 정적 16:9 슬라이드는 wide-pptx, MP4 영상만은 video-gen, 10초 안팎 클립은 motion-graphic-make 로 넘김. 'presentation-graphic-gen'/'모션 그래픽 발표 자료'/'키 진행 발표'/'움직이는 발표 자료'/'발표 애니메이션 만들어' 시 사용."
argument-hint: "[<대본.md>] [--format html|pptx|both] [--dir <폴더>] [--scenes <폴더>] [--stamp <yymmdd+HHMM>] [--force]"
---

# presentation-graphic-gen: 키 진행 모션 그래픽 발표 자료(HTML, PPTX)

사용자의 대본 초안을 받아, 키 한 번에 한 단계가 움직이는 발표 자료를 만든다. 답변은 한글.
결과는 단일 HTML 두 벌(검토용, 발표용)과, 고르면 PPTX 두 벌(영상 슬라이드, 편집용 도형 슬라이드)이다.

## 원칙

- **실행할 때 인터넷을 쓰지 않는다.** 글꼴(Noto Sans, Noto Sans KR), 글꼴 서브셋(HarfBuzz WASM), H.264 인코더(WASM), PptxGenJS 가 모두 `vendor/` 에 있다. 실행 전에 원본 sha256 과 대조하고, 다르면 멈춘다(종료 코드 3). 필요한 것은 Node 22 이상과 Chromium 계열 브라우저뿐이다.
- **내용은 사용자의 대본 초안이다.** 화면 글과 말은 초안에서 가져온다. 수치, 사례, 인용, 출처를 지어내지 않는다. 비어 있거나 의심스러운 곳은 `[확인 필요]` 로 두고 보고에 적는다.
- **이미 있는 파일을 덮어쓰지 않는다.** 같은 이름의 파일이나, 비어 있지 않은 출력 폴더(게이트 결과, 녹화, `--frames`, PowerPoint PNG)가 있으면 도우미가 작업 전에 종료 코드 2 로 끝난다. 덮어쓸지 묻고, 허락을 받은 뒤에만 `--force` 를 준다. 다른 회차로 남기려면 `--stamp` 를 바꾼다.
- **애니메이션 엔진은 브라우저 내장 Web Animations API(WAAPI)다.** GSAP 표준 라이선스는 사용자가 코드 없이 애니메이션을 만드는 도구에서 서면 동의 없이 쓰는 것을 금하므로 쓰지 않는다.
- **글꼴은 한글에 Noto Sans KR, 그 밖(영문, 숫자, 기호)에 Noto Sans 를 쓴다.** HTML 에는 덱이 쓰는 글자만 남긴 글꼴을 넣는다. PPTX 는 테마 글꼴로 지정만 하고 파일은 넣지 않는다.
- 화면은 1920 x 1080 무대, 안전 영역은 x 160~1760, y 120~960 이다. 화면 글은 28px 이상, 가능하면 40px 이상으로 한다.

## 런타임

| 항목 | Claude Code | Codex |
|---|---|---|
| 스킬 디렉터리 `<S>` | 스킬 맨 위 "Base directory for this skill:" 경로 | 이 SKILL.md 의 폴더. npm 설치는 `~/.codex/skills/banker-presentation-graphic-gen/`, 플러그인 설치는 `~/.codex/plugins/cache/<마켓플레이스>/banker/<판>/skills/presentation-graphic-gen/`. 절대경로로 씀 |
| 부르기 | `/banker:presentation-graphic-gen` | `$banker-presentation-graphic-gen`, 플러그인 `$banker:presentation-graphic-gen` |
| 확인 질문 | `AskUserQuestion` | `request_user_input`. 없으면 번호 붙인 평문 선택지 |
| 샌드박스 | 없음 | 도우미는 작업 폴더 안에서 읽고 쓴다. 브라우저 실행이 막히면 `sandbox_permissions: "require_escalated"` 로 승인을 청한다 |
| 긴 실행 | Bash 도구 `timeout` 을 넉넉히(최대 600000), 녹화처럼 더 길면 `run_in_background` | `timeout_ms` 를 같은 값으로 |
| 다듬기 좌석 | `Agent` 도구, `model` 에 `sonnet` 또는 `haiku`, 노력 medium | 하위 에이전트(`model`, `model_reasoning_effort: medium`) 또는 좌석마다 `codex exec -m <id> -c model_reasoning_effort=medium` |

물을 수 없는 실행(`codex exec`, 다른 스킬의 연쇄)에서는 기본값을 쓴다: 형식 `pptx`(HTML 포함), 다듬기 모델은 권장 모델. 모자란 내용은 `[확인 필요]` 로 둔다.

## 인자

`M="<S>/scripts/make.mjs"`. 아래는 `make.mjs` 가 받는 인자 그대로다.

| 인자 | 뜻 |
|---|---|
| `<대본.md>` | 화면/말 형식의 대본 파일. 첫 인자. 대신 `--sample` 을 주면 예시 덱(`<S>/assets/sample/coffee.md`) |
| `--format html\|pptx\|both` | 낼 형식. 기본 `html`. `pptx` 와 `both` 는 같음(PPTX 는 늘 HTML 을 먼저 만듦) |
| `--scenes <폴더>` | 장면 파일 폴더. 기본 대본 옆 `scenes/` |
| `--media <폴더>` | 장면이 `d.asset()` 으로 쓰는 그림 폴더. 기본 대본 옆 `media/` |
| `--name <이름>` | 출력 파일 이름의 앞부분. 쓸 수 있는 글자: 한글을 포함한 모든 언어의 글자, 숫자, 띄어쓰기, `.`, `_`, `-`. 그 밖의 글자는 쓸 수 없음(`( ) & # , [ ] ·`, 경로 구분자, 제어 문자, `<>:"/\?*` 와 세로 막대 등). `..`, 앞뒤 띄어쓰기, 끝의 `.`, Windows 장치 이름(`CON`, `PRN`, `AUX`, `NUL`, `COM1`~`COM9`, `LPT1`~`LPT9`, 확장자가 붙은 `nul.md` 도)도 안 됨. 준 `--name` 은 바꾸지 않고, 규칙에 맞지 않으면 종료 2. 주지 않으면 대본 파일 이름을 씀. 이때는 쓸 수 없는 글자와 띄어쓰기가 이어진 곳마다 `-` 하나로 바꾸고 양 끝의 `-` 는 뺌(`발표(최종).md` 는 `발표-최종`). 그래도 규칙에 맞지 않으면 종료 2 이고 `--name` 으로 줌 |
| `--dir <폴더>` | 출력 폴더. 기본 `./presentation-out/<이름>/` |
| `--stamp <yymmdd+HHMM>` | 파일 이름의 시각. 기본 지금 시각 |
| `--force` | 있는 파일을 덮어씀. 사용자 허락 뒤에만 |

## 도우미

| 명령 | 하는 일 | 종료 코드 |
|---|---|---|
| `node "<S>/scripts/cdp.mjs"` | 게이트가 쓸 브라우저 경로를 냄 | 0, 없음 2 |
| `node "$M" <대본> --format html` | 만들기와 게이트(`build.mjs`, `check.mjs`) | 0, 게이트 1, 사용법과 파일 2, vendor 3 |
| `node "$M" <대본> --format both` | 위에 더해 녹화, 영상 PPTX, 편집 PPTX, 검증 | 같음 |
| `node "<S>/scripts/build.mjs" <대본> [인자]` | HTML 두 벌만. 시간 예산과 반복 경고를 냄 | 0, 1, 2, 3 |
| `node "<S>/scripts/check.mjs" <present.html> --script <대본> [--out <폴더>] [--force]` | 게이트 10개, 스냅숏, 정지 화면, 키로 재생한 화면, 컨택트 시트. 출력 폴더가 비어 있지 않으면 2 | 0, 1, 2 |
| `node "<S>/scripts/pptx.mjs" verify <파일.pptx> --script <대본> [--media <녹화 폴더>] [--frames <폴더>] [--force]` | PPTX 게이트. `--frames` 폴더가 비어 있지 않으면 2 | 0, 1, 2, 3 |
| `node "<S>/scripts/pptx.mjs" com <파일.pptx> <PNG 폴더> [--force]` | 선택. Windows 의 PowerPoint 로 열고 슬라이드 PNG 를 냄. 그 밖에서는 SKIP. PNG 폴더가 비어 있지 않으면 2 | 0, 1, 2 |
| `node "<S>/scripts/apply-fix.mjs" <accepted.json> [--root <폴더>] [--dry-run]` | 다듬기 회차의 채택 항목을 적용 | 0, 2 |

출력 이름: `<이름>-review-<stamp>.html`, `<이름>-present-<stamp>.html`, `check-<이름>-present-<stamp>/`, `<이름>-recording-<stamp>/`, `<이름>-video-<stamp>.pptx`, `<이름>-edit-<stamp>.pptx`.

## 절차

### 1. 준비 확인
- `node --version` 이 22 이상인지 본다.
- 브라우저가 있는지 본다: `node "<S>/scripts/cdp.mjs"` 가 `browser <경로>` 를 내면 있다. 없으면 `no Chrome, Edge or Chromium found` 를 내고 종료 코드 2 로 끝난다. 찾는 순서는 환경 변수 `CHROME`, Chrome, Edge, Chromium, Playwright 의 chromium 이다.
- 없으면 `<S>/references/offline-install.md` 의 순서를 사용자에게 안내하고 멈춘다. 이 스킬은 아무것도 내려받지 않는다.
- Linux 의 snap Chromium 은 `/tmp` 와 숨김 폴더를 읽지 못한다. 덱을 홈 폴더 아래에 두거나 `CHROME` 으로 다른 브라우저를 지정한다(`offline-install.md`).

### 2. 대본 받기
- 사용자의 대본 초안을 받는다. 형식은 `<S>/references/script-format.md`. 형식이 다르면 내용을 바꾸지 않고 형식만 맞춰 보여 주고 확인을 받는다.
- `node "<S>/scripts/build.mjs" <대본> --dir <임시 폴더>` 로 형식을 검사하고 시간 예산(분당 약 290음절)을 확인한다. 섹션별 예상 시간과 목표, 초과 섹션, 화면 글이 말을 되풀이한다는 경고를 사용자에게 보여 준다.

### 3. 형식 묻기
- 확인 질문으로 묻는다: `html`(HTML 두 벌만), `pptx`(HTML 두 벌과 PPTX 두 벌). `--format both` 는 `pptx` 와 같다. PPTX 를 고르면 녹화에 몇 분 걸린다고 알린다.

### 4. 다듬기 모델 묻기
- 낮은 등급 모델을 고르게 한다. 노력은 medium.
  - Claude Code: `sonnet`(권장) 또는 `haiku`.
  - Codex: luna(권장). `codex debug models` 를 실행해 실제로 있는 luna id 를 쓴다. 문서 이름은 `gpt-6-luna` 이고, 어떤 CLI 판은 `gpt-5.6-luna` 로 낸다. 둘 다 없으면 목록에서 가장 가벼운 모델을 고르게 한다.

### 5. 스토리보드
- 단계마다 끝 상태 한 장을 먼저 정한다. 한 단계에 생각 하나, 3초 안에 읽히는 화면.
- 움직임 없이 끝 상태만 있는 장면 파일(각 단계는 `s.fadeIn` 정도)로 HTML 을 만들고 `check.mjs` 의 `stills/` 를 보여 준다. 사용자가 끝 상태를 승인한 뒤에 움직임을 넣는다.

### 6. 장면 쓰기
- 섹션마다 `scenes/NN.js` 하나. 장면 API 는 `<S>/references/scene-api.md`. 예시는 `<S>/assets/sample/scenes/`.
- 한 번에 한 가지씩 바꾸고 다시 만든다. 화면 글은 `d.lines(id)` 로 대본에서 가져오고 새로 쓰지 않는다.
- 밑줄, 형광, 취소선은 `s.underline`, `s.mark`, `s.strike` 로만 그린다. 폭을 손으로 정한 막대는 게이트가 떨어뜨린다.
- 강조는 `s.focus`(또는 `s.chips` 의 `ring`)로만 한다. 대상 안에 붙은 테두리 하나가 대상의 둥근 모양을 따라 켜지고 꺼진다. 조각을 이어 붙인 사각형 테두리를 직접 만들지 않는다.

### 7. 만들기와 게이트
- `node "$M" <대본> --format html --dir <폴더>` 를 실행한다. 게이트 줄이 모두 `PASS` 여야 한다. 읽는 법은 `<S>/references/gates.md`.
- 컨택트 시트(`check-.../contact-sheet.png`), 단계별 정지 화면, 키로 재생한 화면(`played/`) 몇 장을 직접 열어 본다. 글이 상자 밖에 있거나, 장식이 글에서 벗어나거나, 깜빡이는 곳이 있으면 장면을 고친다.

### 8. 한국어 다듬기 합의 루프
- 화면 글(장면 파일)과 말(대본)을 4단계에서 고른 모델로 다듬는다. 순서와 기록 형식은 `<S>/references/polish-loop.md`.
- 제안 좌석 3개, 투표 좌석 3개, 3표 중 2표 이상이면 채택. `apply-fix.mjs` 로 적용한다.
- 끝: 대상 전체를 본 마지막 회차의 새 합의가 0건. 회차 상한 6. 끝나면 다시 만들고 게이트를 다시 돌린다.

### 9. PPTX
- `pptx` 나 `both` 면 `node "$M" <대본> --format both --dir <폴더>` 를 실행한다. 오래 걸리므로 백그라운드로 돌린다.
- 녹화, 영상 PPTX, 편집 PPTX, 두 덱의 `verify` 가 이어서 돈다. 자세한 것은 `<S>/references/pptx.md`.
- Windows 에 PowerPoint 가 있으면 `pptx.mjs com` 으로 열어 보고 PNG 몇 장을 본다. PowerPoint 가 이미 실행 중이면 건드리지 않고 SKIP 이다. 선택 단계다.
- 종료 코드 2 에 `not overwriting` 이 나오면 덮어쓸지 묻는다.

### 10. 보고
- 만든 파일의 절대경로와 크기
- 게이트 줄(`PASS`, `FAIL`, `SKIP`) 그대로. SKIP 이 하나라도 있으면 `ALL PASS` 라고 쓰지 않는다. `PASS with SKIP (continuity)` 처럼 건너뛴 게이트 이름을 함께 쓴다. `pptx.mjs verify` 의 요약 줄과 `make.mjs` 의 `== done: PASS with SKIP`, `skipped` 줄이 같은 형식이다
- 시간 예산(섹션별, 합계, 초과 섹션)
- 다듬기: 모델 id, 회차 수, 회차별 제안, 채택, 기각 수, 마지막 0건 회차의 기록 파일
- 편집 PPTX 의 그림 대체 목록
- `[확인 필요]` 자리와 확인하지 못한 것(PowerPoint 로 열어 보지 않음, H.264 를 풀지 못해 SKIP 등)
- 다음 행동이 있으면 마지막 줄에. 예: "고칠 곳은 `scenes/NN.js` 이니 고친 뒤 다시 부르십시오."

## 함정

자세한 이유와 대처는 `<S>/references/traps.md`.

- 움직일 수 있는 것은 `opacity`, `x`, `y`, `scale`, `scaleX`, `scaleY`, `rotate` 숫자뿐이다. 그 밖은 빌드 오류다.
- 같은 요소, 같은 채널의 애니메이션은 시간이 겹치면 오류다. 함께 움직일 것은 부모 층 하나만 움직인다.
- 장면 코드에서 `Math.random`, 시계, 타이머, `requestAnimationFrame`, 콜백을 쓰면 빌드가 거절한다. 무작위는 `s.rand(seed)`, `d.rand(seed)`.
- 밑줄, 형광은 `s.underline`, `s.mark` 로만. 손으로 폭을 정한 막대는 `decorations` 게이트가 떨어뜨린다.
- 한 도형을 따로 움직이는 조각으로 만들지 않는다. 1px 조각을 늘린 테두리는 GPU 로 그리는 브라우저에서 픽셀 비율이 1 이 아니면 모서리가 벌어진다. 헤드리스 시험 화면에서는 보이지 않으므로 `decorations-played` 게이트가 구조로 잡는다.
- Chromium(Playwright 판 포함)은 H.264 를 풀지 못해 PPTX 영상 연속성 게이트가 SKIP 이 된다. Chrome 이나 Edge 로 다시 돌린다.
- 편집 PPTX 는 그림, SVG, 회전한 요소, 그라데이션은 잘라 낸 그림으로 바꿔 넣는다. 글꼴은 넣지 않으므로 보는 PC 에 Noto Sans, Noto Sans KR 이 있어야 한다.
- `vendor/` 의 파일은 고치지 않는다. sha256 이 다르면 실행을 멈춘다.
