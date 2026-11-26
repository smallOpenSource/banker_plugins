---
name: humanizer
description: "어색한 문장 때문에 생기는 AI 티를 없애 글을 자연스럽게 윤문. 작은 모델(sonnet, haiku, luna)과 낮은 노력의 독립 검토 좌석 3개 이상이 고칠 곳을 냄. 다른 좌석 3개 이상의 다수결로 합의한 수정만 적용하고, 새 합의가 0건인 회차까지 반복. 글의 언어를 판정해 그 언어 기준으로 검토(한국어는 번역투, 피동, 명사 나열 등, 영어는 영문 패턴 목록, 그 밖의 언어는 원어민 편집자 기준). 내용은 더하거나 빼지 않고 코드, 경로, 숫자, 인용은 그대로 둠. 'humanizer'/'윤문'/'AI 티 제거'/'AI 티 없애줘'/'자연스럽게 다듬어'/'사람이 쓴 것처럼'/'remove AI writing'/'sound more human' 시 사용."
argument-hint: "[<파일> | 붙여 넣은 글] [--seats <N>] [--max-rounds <N>]"
license: MIT
---

# humanizer: 독립 좌석 합의로 하는 윤문

어색한 문장은 AI 티를 만든다. 이 스킬은 그런 문장만 고친다. 답변은 한글(글 자체는 원래 언어 그대로).
한 모델이 혼자 판단해 고치지 않는다. 서로 보지 않는 좌석들이 고칠 곳을 내고, 다른 좌석들의 다수결로 합의한 수정만 적용한다.

## 원칙

- **뜻을 지킨다.** 내용을 더하거나 빼지 않는다. 사실, 수치, 사례, 인용을 지어내지 않는다. 개성이나 1인칭 의견을 넣지 않는다.
- **보호 글은 그대로다.** 코드 펜스, 인라인 코드, 명령, URL, 경로, `--플래그`, 숫자, 인용은 원문 그대로 둔다. `consensus.mjs merge` 가 이것을 건드리는 제안을 버린다.
- **합의한 것만 고친다.** 센 투표 좌석의 과반(3표 중 2표)이 `accept` 한 수정만 적용한다. 세션 모델은 좌석의 판단을 뒤집지 않는다. 틀린 사실을 바탕으로 한 합의만 빼고, 그 까닭을 보고한다.
- **글쓴이의 형식을 지킨다.** 존대 수준, 개조식, 표, 제목 구조, 줄바꿈은 그대로다.
- **원본은 확인 뒤에만 바꾼다.** 사본을 다듬고, 원본 파일에 쓸지는 끝에 묻는다.
- 네트워크를 따로 쓰지 않는다. 좌석은 이 런타임의 하위 에이전트다.

## 런타임

| 항목 | Claude Code | Codex |
|---|---|---|
| 스킬 디렉터리 `<S>` | 스킬 맨 위 "Base directory for this skill:" 경로 | 이 SKILL.md 의 폴더. npm 설치는 `~/.codex/skills/banker-humanizer/`, 플러그인 설치는 `~/.codex/plugins/cache/<마켓플레이스>/banker/<판>/skills/humanizer/`. 절대경로로 씀 |
| 부르기 | `/banker:humanizer`(줄여서 `/humanizer`) | `$banker-humanizer`, 플러그인 `$banker:humanizer` |
| 좌석 | `Agent` 도구. `subagent_type: "Plan"`, `model` 에 `sonnet` 이나 `haiku`, `effort` 에 `medium` 이나 `low` | `spawn_agent`. `model` 에 luna id, `reasoning_effort` 에 `medium`, `low`(목록에 있으면 `none`), v2 는 `fork_turns: "none"` |
| 좌석 답 저장 | `Write` | `apply_patch` |
| 확인 질문 | `AskUserQuestion` | `request_user_input`. 없으면 번호 붙인 평문 선택지 |
| 샌드박스 | 없음 | 작업 폴더는 시스템 임시 폴더나 세션 폴더 안. 다른 곳은 `--dir` 로 세션 폴더 안을 준다 |

- 좌석 표, 띄우는 방법, 좌석 지시, 기록 형식은 `<S>/references/consensus-loop.md`.
- Codex 의 luna id: `codex debug models` 에 있는 것. `gpt-5.6-luna` 가 있으면 그것, 없을 때만 `gpt-6-luna`. 목록에 luna 가 하나도 없을 때만 가장 작은 모델을 고르게 묻는다. 물을 수 없으면 세션 모델에 노력 `low` 로 하고 보고에 적는다.
- Codex 의 하위 에이전트는 부모 세션의 모델 이름을 밝힌다. 그래서 Codex 는 `seats.json` 에 `"modelCheck": "none"` 을 쓴다(`consensus-loop.md`). 좌석이 다른 모델을 밝혀도 모델을 바꾸지 않는다.
- 물을 수 없는 실행(`claude -p`, `codex exec`, 다른 스킬의 연쇄)에서는 묻지 않는다. 원본 파일은 바꾸지 않고 사본 경로를 보고한다.

## 도우미

| 명령 | 하는 일 | 종료 코드 |
|---|---|---|
| `node "<S>/scripts/lang.mjs" <파일>` | 글의 언어와 기준(`ko`, `en`, `general`), 섞임(`mixed`) | 0, 2 |
| `node "<S>/scripts/consensus.mjs" init [--from <파일>] [--dir <폴더>]` | 작업 폴더를 만들고 원본을 `text.<확장자>` 로 복사 | 0, 2 |
| `node "<S>/scripts/consensus.mjs" merge <회차 폴더> --root <작업 폴더>` | 제안 좌석 답을 후보로 모음(`candidates.json`) | 0, 센 좌석 부족 1, 2 |
| `node "<S>/scripts/consensus.mjs" tally <회차 폴더> --root <작업 폴더> --apply [--dry-run]` | 투표 집계, 채택 적용, 기록(`round.json`, `decided.json`) | 0, 1, 2 |
| `node "<S>/scripts/apply-fix.mjs" <accepted.json> --root <작업 폴더> [--dry-run]` | 채택 목록 적용(사실 오류로 뺀 합의가 있을 때) | 0, 2 |

## 절차

### 1. 글 받기
- 파일 경로를 받았으면 `node "<S>/scripts/consensus.mjs" init --from <파일>` 을 실행한다. `work <작업 폴더>` 와 `text <글 파일>` 이 나온다.
- 붙여 넣은 글이면 `init` 으로 작업 폴더만 만들고, 그 글을 손대지 않고 `<작업 폴더>/text.md` 에 쓴다.
- 글쓴이의 다른 글(문체 표본)을 받았으면 작업 폴더에 `sample.md` 로 두고 좌석 지시 끝에 "문체 참고: <경로>" 를 덧붙인다.

### 2. 언어 판정
- `node "<S>/scripts/lang.mjs" <글 파일>` 을 실행한다.

| `criteria` | 기준 파일 | 좌석 역할 |
|---|---|---|
| `ko` | `<S>/references/criteria-ko.md` | 한국어 원어민 편집자 |
| `en` | `<S>/references/patterns-en.md`(blader/humanizer 의 영문 패턴 33개와 오탐 기준) | English native editor |
| `general` | `<S>/references/criteria-general.md` | `name` 언어의 원어민 편집자 |

- `mixed` 가 `true` 면 두 언어의 기준 파일을 함께 주고, 문장마다 그 문장의 언어 기준으로 보게 한다.
- `patterns-en.md` 의 "PERSONALITY AND SOUL" 과 Full Example 은 의견과 세부를 더하는 예다. 이 스킬에서는 따르지 않는다(원칙의 뜻 지키기가 앞선다).

### 3. 좌석 정하기
- 기본은 제안 3, 투표 3. `--seats <N>` 이면 각 N 개(3 이상). 모델과 노력은 `consensus-loop.md` 의 표대로 `<작업 폴더>/seats.json` 에 쓴다.
- 노력은 `medium`, `low`, `none` 만 쓴다. 다른 값은 `consensus.mjs` 가 거부한다.

### 4. 회차 돌리기
- 회차마다 `<작업 폴더>/round-NN/` 을 만들고 `consensus-loop.md` 의 "한 회차" 를 따른다: 제안 좌석, `merge`, 투표 좌석(후보가 있을 때만), `tally --apply --dry-run`, `tally --apply`.
- 좌석은 한 회차 안에서 함께 띄우고, 이 대화의 맥락을 넘기지 않는다. 좌석의 답은 그대로 파일에 쓴다.
- `merge` 나 `tally` 가 종료 1 이면 그 줄이 이름을 댄 좌석만 다시 띄운다.

### 5. 끝
- 글 전체를 본 회차의 새 합의가 0건이면 끝난다. 회차 상한은 5(`--max-rounds <N>` 으로 바꿈). 상한에 걸리면 멈추고 그 사실을 보고한다.
- 다듬은 글을 보여 준다. 원본 파일이 있으면 바뀐 곳(채택 목록)을 보여 주고 원본에 쓸지 묻는다. 허락을 받으면 사본을 원본 자리에 복사한다.

## 보고

- 언어와 기준 파일, 좌석 표(좌석, 모델, 노력, 좌석이 밝힌 모델)
- 회차 수, 회차별 제안, 후보, 채택, 기각, 보류, SKIP 수
- 버린 제안의 까닭 가운데 보호 글 때문인 것의 수
- 사실 오류로 뺀 합의와 그 까닭
- 작업 폴더와 마지막 0건 회차의 `round.json` 경로, 상한에 걸렸으면 그 사실
- 다듬은 글(또는 원본에 썼다는 사실)

## 함정

- 세션 모델이 좌석 답을 요약해서 저장하는 것. 답은 그대로 쓴다. 요약하면 `from` 이 원문과 달라 모두 버려진다.
- 앞 회차 좌석을 다음 회차에 다시 쓰는 것. 회차마다 새 좌석이다.
- 합의가 마음에 들지 않는다고 세션 모델이 고쳐 쓰는 것. 고칠 수 있는 것은 틀린 사실을 바탕으로 한 합의뿐이다.
- 고칠 것이 많다고 한 번에 다시 쓰는 것. 이 스킬은 문장 단위 수정만 한다. 전면 재작성은 집필이다.

## 출처

- 영문 패턴 목록(`references/patterns-en.md`)은 [blader/humanizer](https://github.com/blader/humanizer) 2.8.0 의 SKILL.md 본문이다. MIT License, © 2025 Siqi Chen. 고지는 `LICENSE`, 원본 안내는 `README.md`, `AGENTS.md`.
