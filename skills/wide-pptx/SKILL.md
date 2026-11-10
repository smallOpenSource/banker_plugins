---
name: wide-pptx
description: "발표용 16:9 슬라이드를 PPTX 와 단일 HTML 덱으로 만듦. 한 JSON 덱에서 두 형식을 같은 배치로 냄: 표지, 구간, 글머리, 2단, 표, 차트(막대, 꺾은선, 원), 이미지, 인용, 마무리와 발표자 노트. 글꼴은 한글 Noto Sans KR, 그 밖 Noto Sans. PptxGenJS 를 스킬 안에 넣어 설치와 내려받기 없이 오프라인에서 동작. A4 세로 인쇄 문서는 vertical-pptx. 'wide-pptx'/'발표 자료 만들어'/'프레젠테이션'/'슬라이드 만들어'/'html 발표 자료' 시 사용."
argument-hint: "[--pptx] [--html] [--dir <폴더>] [--deck <deck.json>] [--minutes <발표 분>]"
---

# wide-pptx: 발표용 16:9 슬라이드(PPTX, HTML)

발표 내용을 받아 16:9 슬라이드를 PPTX 와 HTML 덱으로 만든다. 답변은 한글.
두 형식은 한 JSON 덱에서 같은 배치(13.333 x 7.5 in, HTML 은 1280 x 720 px)로 나온다.

## 원칙

- **설치와 내려받기가 없다.** PPTX 는 스킬 안의 `vendor/pptxgen.bundle.js`(PptxGenJS 4.0.1, MIT)로, HTML 은 도우미가 직접 쓴다. 인터넷을 쓰지 않는다.
- **글꼴은 한글 Noto Sans KR, 그 밖(영문, 숫자, 기호) Noto Sans 다.** PPTX 는 테마의 라틴 글꼴과 한글 글꼴로 나누어 적고, 글 상자는 테마 글꼴을 따른다. HTML 은 `"Noto Sans","Noto Sans KR"` 순서다. 글꼴 파일은 넣지 않으므로 보는 PC 에 두 글꼴이 있어야 그대로 보인다.
- **슬라이드는 종류별 고정 배치다.** 글이 상자보다 길면 넘친다. 도우미가 넘칠 만한 곳을 경고하면 슬라이드를 나눈다. 글자를 줄여 맞추지 않는다.
- **이미지는 로컬 파일만 쓴다.** PNG, JPEG, GIF. 두 형식에 같은 바이트가 들어간다. URL 은 받지 않는다.
- 있는 파일을 덮어쓰지 않는다. 같은 이름이 있으면 묻고, 허락을 받은 뒤에만 `--force` 를 준다.
- 사용자가 주지 않은 수치, 인용, 출처를 지어내지 않는다. 비어 있는 곳은 `[확인 필요]` 로 두고 보고에 적는다.

## 런타임

| 항목 | Claude Code | Codex |
|---|---|---|
| 스킬 디렉터리 `<S>` | 스킬 맨 위 "Base directory for this skill:" 경로 | 이 SKILL.md 의 폴더. npm 설치는 `~/.codex/skills/banker-wide-pptx/`, 플러그인 설치는 `~/.codex/plugins/cache/<마켓플레이스>/banker/<판>/skills/wide-pptx/`. 절대경로로 씀 |
| 부르기 | `/banker:wide-pptx` | `$banker-wide-pptx`, 플러그인 `$banker:wide-pptx` |
| 확인 질문 | `AskUserQuestion` | `request_user_input`. 없으면 번호 붙인 평문 선택지 |
| 샌드박스 | 없음 | 도우미는 작업 폴더 안에서만 읽고 써서 승인이 필요 없음. 작업 폴더 밖 이미지는 `sandbox_permissions: "require_escalated"` 로 승인을 청하거나 작업 폴더로 복사해 씀 |
| 셸 | bash | Windows 는 PowerShell. 도우미는 Node 라 두 셸에서 같다 |

물을 수 없는 실행(`codex exec`, 다른 스킬의 연쇄)에서는 인터뷰를 건너뛰고 받은 자료만으로 만든다. 모자란 곳은 `[확인 필요]` 로 둔다.

## 인자

| 인자 | 뜻 |
|---|---|
| `--pptx`, `--html` | 낼 형식. 둘 다 없으면 둘 다 냄 |
| `--dir <폴더>` | 출력 폴더. 없으면 지금 작업 폴더. 도우미의 `--out <파일>` 과 다름 |
| `--deck <deck.json>` | 이미 있는 덱 파일을 씀. 없으면 대화와 자료로 새로 씀 |
| `--minutes <분>` | 발표 시간. 슬라이드 수를 정할 때 씀(1~2분에 한 장) |

## 도우미

`P="<S>/scripts/wide-pptx.mjs"`. 머리 주석이 전체 사용법이다.

| 명령 | 하는 일 | 종료 코드 |
|---|---|---|
| `node "$P" example` | 예시 덱(JSON)을 냄. 덱 파일의 틀로 씀 | 0 |
| `node "$P" check --deck <deck.json>` | 덱을 검사하고 `OK 슬라이드 N, 표 T, 차트 C, 이미지 I, 노트 K` 한 줄을 냄. 넘칠 만한 곳은 `경고:` 줄 | 0, 덱 오류 1 |
| `node "$P" build --deck <deck.json> --out <파일.pptx> --out <파일.html>` | 파일을 만듦. 쓰기 전에 모든 `--out` 을 검사하고, 하나라도 이미 있으면 `--force` 없이는 아무것도 쓰지 않고 2 로 끝남 | 0, 덱 오류 1, 사용법과 파일 오류 2 |

## 덱 파일(deck.json)

`node "$P" example` 이 낸 틀을 고쳐 쓴다. 이미지 경로는 덱 파일이 있는 폴더 기준이다.
모든 글 칸은 글(또는 숫자)만 받는다. PowerPoint 에서 복사한 줄 바꿈(U+000B)은 줄 바꿈으로, XML 에 넣을 수 없는 제어 문자는 지운다. 제목은 한 줄을 넘을 것 같으면 경고한다.

| 칸 | 뜻 |
|---|---|
| `title`, `author` | 파일 속성의 제목과 작성자 |
| `footer` | 표지와 마무리를 뺀 슬라이드 아래 왼쪽 글. 오른쪽에는 쪽 번호 |
| `theme` | `primary`(표지, 표 머리), `accent`(강조 막대, 소제목), `dark`(본문 글), `light`(구간, 인용 바탕), `muted`(보조 글). 6자리 16진수 |
| `slides` | 슬라이드 목록. 아래 표. 모두 `notes`(발표자 노트)를 받음 |

| type | 칸 | 넘침 경고와 한도 |
|---|---|---|
| `title` | `title`, `subtitle`, `presenter`, `date` | |
| `section` | `title`, `subtitle` | |
| `bullets` | `title`, `bullets`(글, 또는 `{ "text", "level": 2 }`) | 글머리의 줄 수를 글자 폭(한글 1, 그 밖 약 0.55)으로 어림해 상자 높이를 넘으면 경고 |
| `two` | `title`, `left`, `right`(각 `{ "heading", "bullets" }`) | 칸마다 같은 어림 |
| `table` | `title`, `header`, `rows`, `caption` | 12행, 7열 |
| `chart` | `title`, `chart`(`kind`: bar, line, pie / `labels` / `series`: `[{ "name", "values" }]` / `unit`), `caption` | 항목 24개(pie 12개) 경고. 값은 숫자만(null 은 오류), 계열이 둘 이상이면 이름이 서로 달라야 함, pie 는 음수 없는 계열 하나이고 합이 0 이면 오류 |
| `image` | `title`, `image`(로컬 보통 파일 경로, Windows 드라이브 경로 포함), `caption` | 20MB 넘으면 오류. 캡션이 PPTX 그림의 대체 텍스트가 됨 |
| `quote` | `quote`, `by`, `title`(선택) | |
| `closing` | `title`, `subtitle` | |

## 절차

### 1. 자료 모으기
- 사용자가 준 원고, 문서, 표, 수치, 그림을 읽는다.
- 아래가 없으면 한 번에 묻는다(확인 질문 하나에 최대 4문항): 발표 목적과 청중, 발표 시간, 꼭 전할 메시지 한 줄, 넣을 자료(표, 수치, 그림 경로). 색과 배치는 묻지 않고 기본값을 쓴다.

### 2. 개요 확인
- 슬라이드 제목 목록(번호, 종류, 제목)을 먼저 보여 주고 확인을 받는다. 장수는 발표 시간 1~2분에 한 장을 기준으로 한다.
- 한 슬라이드에 메시지 하나. 표지, 구간, 마무리로 흐름을 나눈다.

### 3. 덱 파일 쓰기
- 출력 폴더에 `<이름>-deck.json` 으로 쓴다. 같은 이름이 있으면 묻는다.
- 발표에서 할 말은 화면 글이 아니라 `notes` 에 적는다. 화면 글머리는 짧게(한 줄 40자 안팎).
- `node "$P" check --deck <파일>` 이 0 이 될 때까지 고친다. `경고:` 가 나오면 그 슬라이드를 나누거나 줄인다. 그대로 두면 보고에 적는다.

### 4. 만들기
- `node "$P" build --deck <파일> --out <이름>.pptx --out <이름>.html` 을 돈다. 형식 인자를 받았으면 그 형식만 준다.
- 종료 코드 2 에 `--force` 안내가 나오면 덮어쓸지 묻고, 허락을 받은 뒤에만 `--force` 를 더해 다시 돈다.

### 5. 확인
- `build` 출력의 슬라이드, 표, 차트, 이미지, 노트 수를 덱과 대조한다.
- 브라우저를 쓸 수 있으면 HTML 을 열어 몇 장을 본다(`<파일>.html#3` 처럼 쪽을 고름).
- LibreOffice 가 있으면 PPTX 를 PDF 로 바꿔 본다. `soffice --convert-to pdf` 는 같은 이름 PDF 를 묻지 않고 덮어쓰므로 `--outdir` 을 새 임시 폴더로 준다.
- 쓸 수 없으면 보았다고 적지 않는다.

## HTML 덱 쓰는 법

- 오른쪽 화살표, 스페이스, PageDown 은 다음, 왼쪽 화살표, PageUp 은 이전, Home 과 End 는 처음과 끝이다. 화면 왼쪽 1/3 을 누르면 이전, 나머지는 다음이다.
- N 은 발표자 노트를 화면 아래에 보이거나 숨긴다.
- 브라우저 인쇄(PDF 저장)는 한 장에 슬라이드 하나, 13.333 x 7.5 in 이다. 배경 그래픽 인쇄를 켠다.

## 보고

- 만든 파일의 절대경로
- 슬라이드 수와 종류별 수, 노트가 있는 장 수
- 남은 경고와 `[확인 필요]` 자리
- 확인하지 못한 것(브라우저나 LibreOffice 로 보지 않음 등)
- 다음 행동이 있으면 마지막 줄에. 예: "고칠 곳은 `<이름>-deck.json` 을 고치고 다시 부르십시오."

## 함정

- 보는 PC 에 Noto Sans KR, Noto Sans 가 없으면 다른 글꼴로 보이고 줄바꿈이 달라진다. 발표 PC 에 두 글꼴이 있는지 먼저 본다.
- LibreOffice 는 한글과 영문 사이에 간격을 넣어 보일 수 있다(PowerPoint 와 다름).
- 휴대폰 사진(JPEG)의 회전 정보(EXIF)는 읽지 않는다. 옆으로 누워 보이면 돌려 저장한 그림을 쓴다.
- PPTX 의 차트는 PowerPoint 차트 개체라 PowerPoint 에서 값을 고칠 수 있다. HTML 차트는 그림(SVG)이라 덱 파일에서 고친다.
- 덱 파일을 고치면 두 형식을 함께 다시 만든다. 한쪽만 고치면 둘이 달라진다.
