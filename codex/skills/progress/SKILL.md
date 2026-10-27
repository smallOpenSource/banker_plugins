---
name: progress
description: "Codex 에서 지금 세션의 진행 상황을 텍스트 트리로 보임. 맨 위는 이 세션이 쓰거나 읽은 마지막 계획 파일의 트리, 그 아래는 update_plan 단계(없으면 요청)와 진행 중인 단계의 최근 도구 호출. tmux 안이면 `--pane` 으로 오른쪽 칸에 2초마다 갱신. 'progress'/'진행 상황'/'어디까지 했어' 시 사용."
---

# progress (Codex)

Claude Code 의 `/progress` 패널에 해당하는 Codex 스킬이다. 답변은 한글.

Codex 에는 Claude Code 의 mod 같은 상시 패널이 없다.
그래서 이 스킬은 부를 때마다 지금 세션의 기록(rollout)을 읽어 한 번 보여 준다.
tmux 안이면 오른쪽 칸을 열어 계속 갱신할 수 있다.

## 보이는 것

- 계획: 이 세션이 도구 호출로 쓰거나 읽은 마지막 계획 파일의 트리. 제목 아래 체크 수(`1/2`)와 체크박스(`[x]`, `[ ]`)를 보인다.
  - 계획 파일: `.omx/plans/*.md`, `.omc/plans/*.md`, `docs/superpowers/plans/*.md`, `~/.claude/plans/*.md`, ralph `prd.json`, ultragoal `goals.json`
  - 리뷰 기록(`*-critic-r2.md` 등)은 다른 계획이 없을 때만 쓴다.
- 단계: 마지막 `update_plan` 의 계획. `[>]` 가 진행 중인 단계다. `update_plan` 이 없으면 이 세션에서 사용자가 입력한 요청(최근 10개)이 단계다.
- 하위 목록: 진행 중인 단계(없으면 마지막 요청) 뒤의 최근 도구 호출 5개.

## 실행

스크립트는 이 스킬 폴더의 `scripts/progress.mjs` 다. Codex 가 셸에 주는 `CODEX_THREAD_ID` 로 지금 세션의 기록을 찾는다.

| 사용자 인자 | 명령 |
|---|---|
| 없음, `show` | `node "<스킬 폴더>/scripts/progress.mjs"` |
| `--depth N` | `node "<스킬 폴더>/scripts/progress.mjs" --depth N` (계획 트리를 N 단계까지 펼침, 기본 2) |
| `--pane`, `on` | `node "<스킬 폴더>/scripts/progress.mjs" --pane on` |
| `off` | `node "<스킬 폴더>/scripts/progress.mjs" --pane off` |

1. 위 표의 명령 하나를 실행한다. 파일은 읽기만 한다.
2. 출력은 고치지 않고 코드 블록 하나에 그대로 보인다. 그 아래에 한 줄로 지금 위치(진행 중인 단계)를 말한다.
3. `--pane` 결과가 `tmux 에 닿지 못함` 이면 샌드박스가 tmux 연결을 막은 것이다. 그 명령만 샌드박스 밖 실행 승인을 요청한다. 승인을 요청할 수 없으면 사용자가 입력창에 `! node "<스킬 폴더>/scripts/progress.mjs" --pane on` 으로 직접 실행하도록 안내한다.
4. `Codex 세션 기록을 찾지 못함` 이면 Codex 밖에서 실행한 것이다. 사용자에게 기록 파일 경로를 받아 `--rollout <파일>` 로 실행한다.

## 한계

- 상시 패널이 아니다. 칸 없이 쓰면 부른 때의 상태만 보인다.
- 칸은 tmux 안에서만 열린다. 칸은 `--pane off` 나 tmux 로 닫을 때까지 남는다.
- 기록은 끝에서부터 32 MB 까지만 읽는다. 아주 긴 세션의 앞쪽 계획과 요청은 보이지 않을 수 있다.
