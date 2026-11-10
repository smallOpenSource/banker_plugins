---
name: video-gen
description: "만들 수 있는 영상 목록을 보여 주고 고르게 한 뒤, 내용을 받지 않았으면 인터뷰해서 영상을 만듦. 내장 종류는 타이틀, 키네틱 타이포, 슬라이드 영상, 차트, 카운터, 이름 자막, 인용, 사진, 크레딧. 스킬 안의 WASM 엔진과 Noto 글꼴로 설치와 내려받기 없이 MP4 를 만듦. HTML 모션 그래픽, AI 3D 인트로, 모션 웹사이트는 해당 banker 스킬로 넘김. 'video-gen'/'영상 만들어'/'동영상 생성'/'소개 영상'/'모션 영상' 시 사용."
argument-hint: "[<종류>] [--dir <폴더>] [--scene <scene.json>] [--deck <deck.json>] [--size 1280x720|1920x1080|1080x1920|1080x1080]"
---

# video-gen: 영상 목록, 인터뷰, MP4 생성

만들 수 있는 영상을 보여 주고, 고른 종류에 맞는 내용을 받아 MP4 를 만든다. 답변은 한글.

## 원칙

- **내장 종류는 설치와 내려받기 없이 모든 OS 에서 만든다.** 렌더 엔진(Skia CanvasKit WASM), H.264 MP4 인코더(WASM), 글꼴(Noto Sans, Noto Sans KR)이 모두 `vendor/` 에 있다. Chrome, ffmpeg, 네이티브 모듈, 인터넷을 쓰지 않는다.
- **글꼴은 한글 Noto Sans KR, 그 밖(영문, 숫자, 기호) Noto Sans 다.** 엔진이 글자마다 고른다. 글꼴이 파일 안에 있어 어느 PC 에서나 같게 나온다.
- **프레임은 시간만의 함수다.** 같은 장면 파일은 같은 영상이 되고, 정지 화면(`still`)은 `--at` 에 가장 가까운 영상 프레임과 같다(출력의 `FRAME` 줄이 그 번호).
- 사용자가 주지 않은 수치, 이름, 인용을 지어내지 않는다. 모자라면 묻는다. 물을 수 없으면 `[확인 필요]` 로 두고 보고한다.
- 있는 파일을 덮어쓰지 않는다. 같은 이름이 있으면 묻고, 허락을 받은 뒤에만 `--force` 를 준다.

## 런타임

| 항목 | Claude Code | Codex |
|---|---|---|
| 스킬 디렉터리 `<S>` | 스킬 맨 위 "Base directory for this skill:" 경로 | 이 SKILL.md 의 폴더. npm 설치는 `~/.codex/skills/banker-video-gen/`, 플러그인 설치는 `~/.codex/plugins/cache/<마켓플레이스>/banker/<판>/skills/video-gen/`. 절대경로로 씀 |
| 부르기 | `/banker:video-gen` | `$banker-video-gen`, 플러그인 `$banker:video-gen` |
| 확인 질문 | `AskUserQuestion` | `request_user_input`. 없으면 번호 붙인 평문 선택지 |
| 샌드박스 | 없음 | 도우미는 작업 폴더 안에서만 읽고 써서 승인이 필요 없음. 작업 폴더 밖 사진은 `sandbox_permissions: "require_escalated"` 로 승인을 청하거나 작업 폴더로 복사해 씀 |
| 긴 렌더 | Bash 도구 `timeout` 을 넉넉히(최대 600000), 더 길면 `run_in_background` | `timeout_ms` 를 같은 값으로 |

물을 수 없는 실행(`codex exec`, 다른 스킬의 연쇄)에서는 목록과 인터뷰를 건너뛰고, 받은 자료로 고를 수 있는 종류 하나를 정해 만든다.

## 인자

| 인자 | 뜻 |
|---|---|
| `<종류>` | 목록의 종류 id(예: `kinetic`, `slides`). 없으면 목록을 보여 주고 고르게 함 |
| `--dir <폴더>` | 출력 폴더. 없으면 지금 작업 폴더. 도우미의 `--out <파일>` 과 다름 |
| `--scene <scene.json>` | 이미 있는 장면 파일을 씀 |
| `--deck <deck.json>` | wide-pptx 덱을 슬라이드 영상으로 바꿈 |
| `--size` | 화면 크기. 기본 `1280x720`. 세로 영상은 `1080x1920` |

## 도우미

`G="<S>/scripts/video-gen.mjs"`. 머리 주석이 전체 사용법이다.

| 명령 | 하는 일 | 종료 코드 |
|---|---|---|
| `node "$G" list` | 영상 목록(종류, 만드는 곳, 설명, 필요한 것) | 0 |
| `node "$G" example` | 예시 장면 파일(JSON). 틀로 씀 | 0 |
| `node "$G" from-deck --deck <deck.json>` | wide-pptx 덱을 장면 파일로 바꿔 stdout 에 냄. 원 차트는 막대로 바꾸고 경고 | 0, 파일 오류 2 |
| `node "$G" check --scene <scene.json>` | 검사하고 `OK 장면 N, 길이, 크기, fps, 프레임` 을 냄. 그림은 엔진으로 실제로 풀어 보고, 글은 내장 글꼴로 재서 화면을 넘을 곳을 `경고:` 로 냄 | 0, 장면 오류 1 |
| `node "$G" still --scene <scene.json> --at <초> --out <파일.png>` | 그 시각에 가장 가까운 영상 프레임 한 장. `--at` 이 영상 길이 이상이면 오류 | 0, 1, 2 |
| `node "$G" render --scene <scene.json> --out <파일.mp4>` | MP4 를 만듦. 진행은 stderr 에 1초마다. `--quality <10-51>`(기본 20, 작을수록 고화질) | 0, 1, 2 |

- 렌더는 CPU 로 한다. 1920x1080 은 1280x720 보다 두 배 넘게 걸린다. 처음 몇 초의 진행 줄로 남은 시간을 어림해 사용자에게 알린다.

## 영상 목록

`node "$G" list` 가 같은 표를 낸다.

| 종류 | 만드는 곳 | 필요한 것 |
|---|---|---|
| `title` 모션 타이틀 | 내장 | 제목, 부제 |
| `kinetic` 키네틱 타이포 | 내장 | 문장 1~6줄 |
| `slides` 슬라이드 영상 | 내장(`from-deck` 또는 장면별 글머리) | 덱 파일 또는 제목과 글머리 |
| `chart` 데이터 차트 | 내장 | 항목, 계열 값, 단위 |
| `counter` 숫자 카운터 | 내장 | 시작 값, 끝 값, 단위, 설명 |
| `lowerthird` 이름 자막 | 내장 | 이름, 직함, 배경 사진(선택) |
| `quote` 인용 | 내장 | 인용문, 출처 |
| `image` 사진 장면 | 내장 | 로컬 사진(PNG, JPEG, GIF, WebP), 캡션 |
| `credits` 엔딩 크레딧 | 내장 | 제목, 줄 목록 |
| `motion-graphic` HTML 모션 그래픽 | `motion-graphic-make` 스킬 | HyperFrames, Chrome, ffmpeg 가 있는 PC |
| `3d-intro` AI 3D 인트로 | `3d-intro-build` 스킬 | Azure 키(유료), 인터넷 |
| `motion-site` 모션 웹사이트 | `motion-sites` 스킬 | 주제와 내용 |

한 영상에 여러 종류를 장면으로 이어 붙일 수 있다(예: 타이틀, 차트, 크레딧).

## 장면 파일(scene.json)

| 칸 | 뜻 |
|---|---|
| `title` | 영상 제목(보고용) |
| `size` | `1280x720`(기본), `1920x1080`, `1080x1920`, `1080x1080` |
| `fps` | 12~60 정수, 기본 30 |
| `theme` | `bg`(바탕), `fg`(글), `accent`(강조), `muted`(보조 글), `panel`, `ink`(자막 띠). 6자리 16진수 |
| `scenes` | 장면 목록. 모두 `duration`(0.5~60초, 기본 4)과 `transition`(`cut`, `fade`(기본), `wipe`, `stripes`)을 받음. 전체 600초까지 |

| type | 칸 |
|---|---|
| `title` | `title`, `subtitle` |
| `kinetic` | `lines`(1~6줄) |
| `bullets` | `title`, `bullets`(7개까지 권장) |
| `chart` | `title`, `chart`(`kind`: bar, line / `labels` / `series`: `[{ "name", "values" }]` / `unit`). 값은 숫자만 |
| `counter` | `label`, `from`(기본 0), `to`, `unit` |
| `lowerthird` | `name`, `role`, `image`(배경, 선택) |
| `quote` | `quote`, `by` |
| `image` | `image`, `caption`, `motion`(`zoom` 기본, `pan`) |
| `credits` | `title`, `lines` |

사진 경로는 장면 파일 폴더 기준이다. URL 은 받지 않는다. 그림은 한 변 16384, 50MP 까지이고, 잘린 파일은 오류다.
들어오는 효과의 간격은 장면 길이에 맞춰 줄어, 장면이 끝나기 0.3초 전에는 모두 보인다. 빈 글 항목은 빼고 경고한다.

## 절차

### 1. 종류 고르기
- 인자에 종류가 없으면 `node "$G" list` 를 돌려 표를 보여 주고 확인 질문으로 고르게 한다. 질문 하나에 선택지는 4개까지라, 사용자의 말에 맞는 종류 3개와 "다른 종류" 를 낸다. 여러 종류를 이은 영상도 고를 수 있다고 알린다.
- 고른 것이 다른 스킬 종류(`motion-graphic`, `3d-intro`, `motion-site`)면 그 스킬로 넘기고 이 스킬은 끝낸다. `motion-graphic` 은 렌더 엔진이 없으면 내장 종류로 비슷하게 만들 수 있다고 함께 알린다.

### 2. 인터뷰
- 고른 종류의 "필요한 것" 가운데 받지 않은 것만 한 번에 묻는다(확인 질문 하나에 최대 4문항). 목적, 길이(초), 화면 크기(가로, 세로)도 정해지지 않았으면 함께 묻는다.
- 색과 장면 전환은 묻지 않고 기본값을 쓴다. 사용자가 색을 말하면 `theme` 에 넣는다.
- `slides` 에 덱 파일이 있으면 `from-deck` 로 바꾸고, 바뀐 장면 목록을 보여 준다.

### 3. 장면 파일 쓰기
- 출력 폴더에 `<이름>-scene.json` 으로 쓴다. 같은 이름이 있으면 묻는다.
- 장면 길이는 글을 읽을 시간을 준다(글머리 하나에 1.2초 안팎, 제목 3~4초).
- `node "$G" check --scene <파일>` 이 0 이 될 때까지 고친다. `경고:` 는 나누거나 줄여서 없앤다.

### 4. 미리 보기
- 장면마다 가운데 시각과 끝나기 0.1초 전 시각을 골라 `still` 로 PNG 를 만들고 본다(그림을 볼 수 있으면). 글이 넘치거나 겹치면 장면 파일을 고친다.
- 미리 보기 PNG 는 출력 폴더 안 `<이름>-preview/` 에 두고, 보고에 경로를 적는다.

### 5. 렌더
- `node "$G" render --scene <파일> --out <이름>.mp4` 를 돈다. 오래 걸리면 백그라운드로 돌리고 진행 줄을 본다.
- 종료 코드 2 에 `--force` 안내가 나오면 덮어쓸지 묻고, 허락을 받은 뒤에만 `--force` 를 더한다.
- 출력의 `OK ...` 줄에서 프레임 수가 장면 길이 x fps 와 같은지 본다.

## 보고

- 만든 MP4 와 미리 보기 PNG 의 절대경로, 길이, 크기, fps, 파일 크기
- 장면 목록(종류와 길이)
- 확인하지 못한 것(재생기로 직접 보지 않음 등), `[확인 필요]` 자리
- 다음 행동이 있으면 마지막 줄에. 예: "고칠 곳은 `<이름>-scene.json` 을 고치고 다시 부르십시오."

## 함정

- 소리는 넣지 않는다. 배경 음악은 영상 편집기에서 더한다.
- 사진은 20MB 까지, PNG, JPEG, GIF(첫 프레임), WebP 만. 휴대폰 사진의 회전 정보(EXIF)는 엔진이 적용한다.
- 엔딩 크레딧은 장면 끝에서 화면 위로 다 빠져나간다. 마지막 장면이면 영상 끝은 바탕색이다.
- 내장 글꼴에 없는 글자(일부 이모지, 드문 한자)는 빈 네모로 나온다.
- `vendor/` 의 파일은 고치지 않는다. 시험이 sha256 을 대조한다.
- 키네틱 기법 일부는 aimotion(kstost/cokacmotion, MIT)의 도우미 코드를 옮겨 썼다. 고지는 `vendor/aimotion/LICENSE.md`, 출처는 `scripts/vg-fx.mjs` 머리에 있다.
