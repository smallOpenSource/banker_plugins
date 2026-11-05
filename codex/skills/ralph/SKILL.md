---
name: ralph
description: "Codex 전용. Claude Code 의 ralph 처럼 작업이 실제로 끝날 때까지 구현, 슬롭 점검, 게이트 실행, 새 맥락 검토를 반복하고, 끝나기 전에는 턴이 끝나지 않게 이어 감. 끝남은 실행기가 돌린 게이트 기록, 검토자 APPROVE, 슬롭 점검이 모두 지금 작업 트리와 맞을 때만. OMX 0.21 에서 없어진 `$ralph` 를 대신하고 OMX 없이 동작. 'ralph'/'banker-ralph'/'끝날 때까지 해'/'멈추지 말고 끝내' 시 사용."
argument-hint: "<작업 또는 계획 파일 경로> [--gates=<id,...>] [--max=<n>] [--no-deslop] [--resume]"
---

# ralph: Codex 의 검증 반복 구현

인자: `$ARGUMENTS` (Codex 는 사용자 메시지에서 읽음)

- oh-my-codex 0.20.2 `skills/ralph`(MIT) 의 반복 구조를 본뜬 banker 스킬
- OMX 0.21 은 `$ralph` 를 없애고 `$ultragoal` 로 대신함. banker 의 다른 스킬이 OMX 판에 기대지 않도록 이 스킬을 씀
- Claude Code 에는 없음. Claude Code 는 OMC `ralph` 를 씀

## 부르는 이름과 폴더

| 설치 길 | 이름 | 이 스킬 폴더 `<S>` |
|---|---|---|
| npm (`banker setup --codex`) | `$banker-ralph` | `~/.codex/skills/banker-ralph/` |
| Codex 플러그인 | `$banker:ralph` | `<CODEX_HOME>/plugins/cache/<마켓플레이스>/banker/<판>/codex/skills/ralph/` |

- `<T>` 는 `<S>/scripts` 다
- `gate-evidence.mjs`, `run-folder.mjs` 는 ralph-qa 의 바이트 동일 사본. `ralph-state.mjs` 는 이 스킬의 실행 기록과 완료 검사

## 끝까지 이어 가기 (Stop 훅)

Claude Code 의 OMC ralph 처럼 실행이 끝나기 전에는 턴이 끝나지 않는다.
- banker 의 Codex Stop 훅(`hooks/ralph-continue-codex.mjs`)이 턴 끝마다 이 저장소의 실행을 본다
- 그 실행을 시작한 세션(`start` 때의 `CODEX_THREAD_ID`)이고 상태가 `active` 면 계속하라는 이유를 넣는다. 받은 이유대로 `check` 를 보고 절차를 잇는다
- 끝나는 길은 `done`(완료)과 `stop`(멈춤) 둘뿐이다
- 기록이나 게이트 증거가 바뀌지 않은 채 다섯 번 멈추려 하면 훅이 놓아준다. 그때는 `stop` 으로 까닭을 남긴다
- 훅은 `banker setup --codex` 나 Codex 플러그인 설치가 넣는다. Codex 가 처음 한 번 신뢰를 묻는다(`/hooks`). 신뢰하지 않으면 턴이 끝날 때 멈추고, 사용자가 "계속" 이라고 하면 `find` 로 이어 간다
- 사용자가 멈추라고 하면 `stop --reason '사용자 요청'` 을 부르고 멈춘다. 훅을 끄려면 `BANKER_NO_RALPH_CONTINUE=1`
- 검토자 같은 하위 에이전트 세션은 막지 않는다(세션 id 가 다름)

## 언제 쓰나

- 끝까지 해야 하는 구현. 부분 완료를 끝으로 치면 안 될 때
- all-in-one, ultra-init, ultra-chain, visual-ralph, front-qa 의 구현 단계(Codex)
- 사용자가 "ralph", "끝날 때까지", "멈추지 말고 끝내" 라고 할 때

## 쓰지 않을 때

- 한 줄 수정. 바로 고치고 시험만 돌림
- 계획부터 필요할 때. `$ralplan` 이나 `$banker-all-in-one`(플러그인 길 `$banker:all-in-one`)을 씀
- 독립 검증만 필요할 때. `$banker-ralph-qa`(플러그인 길 `$banker:ralph-qa`)를 씀

## 인자

| 인자 | 뜻 | 기본 |
|---|---|---|
| 작업 | 문장, 또는 계획 파일 경로(`.omx/plans/prd-*.md` 등). 계획이면 그 이야기와 수용 기준을 따름 | 없음(필수) |
| `--gates=<id,...>` | 완료를 판정할 게이트 id. 명령은 id 마다 한 줄(`tests: npm test`)로 함께 받음. 게이트 하나에 명령 하나 | 저장소 신호에서 고름 |
| `--max=<n>` | 반복 한도(1~100) | 10 |
| `--no-deslop` | 슬롭 점검을 건너뜀 | 점검함 |
| `--resume` | 이 저장소의 열린 실행을 이어 감 | 새 실행 |

- `--max`, `--no-deslop` 은 1단계의 `start` 에 그대로 넘긴다(`--max <n>`, `--no-deslop`). 넘기지 않으면 기록에 남지 않는다
- 게이트를 받지 못하면 저장소에서 고른다(`package.json` 의 `test`, `lint`, `typecheck`, `build`, `pytest`, `go test ./...`, `cargo test` 등). 고른 명령은 시작 보고에 적는다
- 게이트로 쓸 명령이 하나도 없으면 `--no-gates '<까닭>'` 으로 시작한다. 까닭은 보고에 남는다

## Codex 런타임 규칙

| 항목 | 규칙 |
|---|---|
| OMX | 쓰지 않음. `omx state`, OMX Stop 훅, `$ultragoal`, `$ultrawork` 를 부르지 않음. tmux 도 필요 없음 |
| 기록 위치 | 게이트 폴더 `<g>`(저장소 밖 비공개 기준 폴더). 저장소 안에 기록 파일을 쓰지 않음 |
| 샌드박스 | `<g>` 가 쓰기 범위 밖이면 `gate-evidence.mjs`, `ralph-state.mjs` 호출과 `<g>` 아래 파일 쓰기마다 `sandbox_permissions: "require_escalated"` 로 승인받음. 승인을 못 받으면 멈추고 보고 |
| 검토자 | `spawn_agent` 를 `agent_type`, `model` 없이 띄움. 저자 대화를 넘기지 않음(fork 금지). 읽기 전용은 지시로 |
| 일꾼 | 독립 작업은 `spawn_agent` 로 나눌 수 있음. 같은 파일을 두 일꾼에게 주지 않음 |
| Codex goal | goal 도구가 있으면 `get_goal` 로 목표를 확인. `done` 이 `RALPH COMPLETE` 를 낸 뒤에만 `update_goal({status: "complete"})`. 호출자가 goal 을 바꾸지 말라고 하면 바꾸지 않음. 이어 가기는 goal 이 아니라 Stop 훅이 맡음 |
| OMX 0.20.x 의 `$ralph` | 같은 작업에 함께 켜지 않음. 이미 켜져 있으면 그 모드를 끝낸 뒤 시작 |

- 저장소 안에 기록을 쓰지 않는 까닭: 추적하지 않는 파일이 생기면 작업 트리 지문이 바뀌어 게이트 기록과 판정이 모두 `stale` 이 된다. `.omx/context/`, `.omx/state/` 도 같다
- 맥락 요약과 하네스(임시 시험, 자료)는 `<g>` 안에 둔다

## 절차

### 0. 준비

1. 저장소 루트 확인: `git rev-parse --show-toplevel`
   - git 저장소가 아니면 멈춘다. 완료를 기계로 검사할 수 없기 때문이다
   - 스스로 `git init` 하지 않는다. 사용자에게 `git init` 과 첫 커밋을 하면 쓸 수 있다고 알린다
2. 계속 생기는 파일 확인: 작업 중 저장소 안에 추적하지 않는 파일이 계속 생기면(OMX 훅의 `.omx/`, 커버리지 결과 등) 지문이 계속 바뀐다
   - `git check-ignore -q .omx` 처럼 확인한다. 무시되지 않으면 사용자에게 알리고 `.git/info/exclude` 에 넣을지 묻는다(쓰기에 승인이 필요할 수 있음)
3. 이어 하기: `--resume` 이거나 작업이 이전 실행을 가리키면 `find` 로 찾는다

   ```bash
   node '<T>/ralph-state.mjs' find --cwd '<저장소>'
   node '<T>/ralph-state.mjs' status --dir '<g>' --cwd '<저장소>'
   ```

   - `status` 가 `active` 인 가장 새 실행을 이어 간다. 다른 세션이 시작한 실행이면 `adopt --dir '<g>'` 로 먼저 옮긴다. `check.missing` 을 보고 2절(반복)의 빠진 단계부터 한다. 구현이 덜 됐으면 2절의 2(구현)부터
   - 열린 실행이 없으면 새로 시작한다

### 1. 시작

```bash
node '<T>/gate-evidence.mjs' init --cwd '<저장소>'
node '<T>/ralph-state.mjs' start --dir '<g>' --cwd '<저장소>' --task '<한 줄 요약>' --gates tests,lint [--plan '<계획 파일>'] [--max <n>] [--no-deslop]
```

- `init` 출력의 `dir` 이 `<g>` 다
- `--plan` 은 계획 파일이 있을 때만 준다
- `--gates` 에는 게이트 id 만 쉼표로 적는다. 명령은 `run --cmd` 로 준다
- `start` 출력의 `head` 가 시작 HEAD 다. 슬롭 점검과 검토가 이 값을 쓴다
- 맥락 요약을 `<g>/context.md` 에 쓴다: 작업, 바라는 결과, 아는 사실, 제약, 모르는 것, 건드릴 곳
  - 모호한 점은 저장소를 읽어 먼저 줄인다. 그래도 사용자 결정이 필요하면 한 번만 묻는다. 호출자가 질문 금지라고 했으면 가정을 적고 진행한다
- `start` 출력의 `baseline` 을 따른다

| `baseline` | 할 일 |
|---|---|
| `run` | 고치기 전, 시작 트리 그대로에서 게이트마다 `run --iter 0` 을 한 번 돌림 |
| `none-dirty` | 반복 0 을 돌리지 않음. 시작 때 이미 바뀐 트리라 기준선이 바뀐 결과를 숨길 수 있음. 모든 실패를 이 변경의 것으로 봄 |

```bash
node '<T>/gate-evidence.mjs' run --dir '<g>' --id tests --cmd 'npm test' --timeout 600 --iter 0 --cwd '<저장소>'
```

- 반복 0 은 시작 트리에서 돈 것만 기준선이 된다. 파일을 고친 뒤 돌린 반복 0 은 버려진다

### 2. 반복

반복마다 아래 순서를 지킨다. 순서가 바뀌면 판정이 `stale` 이 된다.

1. 다음 반복 번호를 받는다

   ```bash
   node '<T>/ralph-state.mjs' next --dir '<g>'
   ```

   - 출력의 `iter` 가 이번 반복 `<k>` 다
   - `repeatedFailures` 가 비어 있지 않으면 같은 실패가 3회 반복된 것이다. 근본 문제로 보고 4절(멈춤)로 간다
   - `max-spent` 로 멈추면 4절로 간다
2. 구현: 남은 이야기와 수용 기준을 하나씩 끝낸다
   - 금지: 시험 지우기, 시험 건너뛰기 추가, 범위 줄이기, 수용 기준 바꾸기
   - 계획 밖 변경이 필요하면 까닭을 `<g>/context.md` 에 적는다
   - 커밋과 `git add` 도 지문을 바꾼다. 커밋은 슬롭 점검 기록 전이나 `done` 뒤에 한다
3. 슬롭 점검(`--no-deslop` 이면 건너뜀): 시작 HEAD 뒤에 바뀐 파일만 본다
   - 대상: `git diff --name-only <시작 HEAD>` 와 추적하지 않는 새 파일
   - 볼 것: 죽은 코드, 쓰지 않는 import, 디버그 출력, 코드를 되풀이하는 주석, 복사한 중복, 쓸모없는 방어 코드, 한 번만 쓰는 추상화
   - 고친 뒤 기록한다. 기록 뒤에 파일을 고치면 점검을 다시 기록한다

   ```bash
   node '<T>/ralph-state.mjs' deslop --dir '<g>' --cwd '<저장소>' --note '<본 파일 수, 고친 것>'
   ```

4. 게이트: 게이트마다 `run --iter <k>` 를 돌린다
   - 명령 하나에 게이트 하나. `&&` 나 `;` 로 묶지 않음. `--timeout` 필수
   - `run` 은 명령이 실패해도 종료 0 이다. 출력 JSON 의 `verdict` 가 `pass` 가 아니면 실패다
   - 실패하면 고친다. 고쳤으면 3(슬롭 점검 기록)부터 다시 한다
   - 한 번이라도 실패한 게이트(반복 0 의 실패 포함)는 같은 트리에서 3회 통과해야 통과로 센다(흔들림 규칙)
   - 시작 전부터 같은 실패(`baseline`)는 그대로 두면 끝나지 않는다
     - 이 작업이 고칠 실패면 고친다
     - 이 작업과 상관없는 실패일 때만 받아들이고 까닭을 적는다. 그 뒤에 받은 검토자 APPROVE 만 센다

     ```bash
     node '<T>/ralph-state.mjs' accept-baseline --dir '<g>' --cwd '<저장소>' --id tests --reason '<상관없는 까닭>'
     ```

5. 검토 준비: `check` 를 돌려 `fingerprint` 와 `warnings` 를 얻고, `evidence` 로 게이트 기록을 뽑는다

   ```bash
   node '<T>/ralph-state.mjs' check --dir '<g>' --cwd '<저장소>'
   node '<T>/ralph-state.mjs' evidence --dir '<g>'
   ```

6. 검토: 새 맥락 검토자를 띄운다
   - 기본 1명. 바뀐 파일이 20개를 넘거나 보안, 권한, 구조 변경이면 2명
   - 검토 중에는 작업 트리를 바꾸지 않는다
   - 검토자에게 주는 것: 작업, 계획과 수용 기준, 시작 HEAD, `git diff <시작 HEAD>` 를 보는 방법, `evidence` 출력(이번 반복 게이트 기록, 출력 파일 경로, 받아들인 기준선), `check` 의 `warnings`, 5의 `fingerprint`
   - 검토자 지시: 파일을 고치지 않음. 첫 줄은 `VERDICT: APPROVE` 나 `VERDICT: REJECT`. blocker 마다 `파일:줄`, 무엇이 틀렸나, 왜. 수용 기준마다 충족 여부. 받아들인 기준선이 이 작업의 실패면 blocker
   - 판정마다 5의 `fingerprint` 로 기록한다. blocker 가 하나라도 있으면 `REJECT` 다. 기록 때 트리가 바뀌었으면 `stale-review` 로 멈추니 다시 검토받는다

   ```bash
   node '<T>/ralph-state.mjs' verdict --dir '<g>' --cwd '<저장소>' --by reviewer-1 --verdict REJECT --blockers 2 --fingerprint '<fp>' --note '<blocker 요약>'
   ```

7. 판정

   ```bash
   node '<T>/ralph-state.mjs' check --dir '<g>' --cwd '<저장소>'
   ```

   - 종료 0: 3절(끝)로 간다
   - 종료 1: `missing` 을 본다. REJECT 의 blocker 를 고치고 1(다음 반복)로 간다. 같은 트리에 받은 REJECT 는 다음 반복에서도 남는다. 고쳐야 풀린다
   - `warnings` 의 `misleading`(종료 0 인데 출력에 실패나 건너뜀): 검토자가 판단한다. 저자가 무시하지 않는다

### 3. 끝

```bash
node '<T>/ralph-state.mjs' done --dir '<g>' --cwd '<저장소>'
```

- 출력의 `line`(`RALPH COMPLETE iter=<k> gates=<...> approvals=<n> deslop=<done|skipped> baseline=<n> misleading=<n>`)을 보고 첫 줄에 쓴다
- `done` 이 종료 1 이면 끝나지 않은 것이다. `missing` 을 보고 2절로 돌아간다
- Codex goal 이 있으면 이제 `update_goal({status: "complete"})`(호출자가 막지 않았을 때만)
- 게이트 폴더: 호출자가 남기라고 하지 않았으면 보고 뒤에 지운다

  ```bash
  node '<T>/gate-evidence.mjs' cleanup --dir '<g>'
  ```

### 4. 멈춤

다음이면 멈추고 사용자에게 보고한다.
- 같은 실패 3회(`repeatedFailures`)
- 반복 한도(`max-spent`)
- 사용자만 정할 수 있는 blocker(요구 충돌, 자격 증명, 운영 환경)
- 샌드박스 승인을 받지 못함
- 사용자가 멈추라고 함

```bash
node '<T>/ralph-state.mjs' stop --dir '<g>' --reason '<까닭>'
```

- 보고 첫 줄은 `RALPH STOPPED (<까닭>)`
- 멈춘 실행은 이어 갈 수 없다. 사용자가 다시 지시하면 새 실행을 시작한다
- 게이트 폴더는 지우지 않는다. 보고에 `<g>` 경로를 적는다

## 이어 하기

- compaction 이나 새 세션: `find --cwd '<저장소>'` 로 `active` 실행을 찾는다
- 새 세션은 세션 id 가 달라 Stop 훅이 그 실행을 잇지 않는다. 새 세션에서 이어 갈 때는 먼저 `adopt` 로 실행을 이 세션으로 옮긴다

  ```bash
  node '<T>/ralph-state.mjs' adopt --dir '<g>'
  ```

- `ready-compact` 노트에 `<g>` 경로와 반복 번호를 적는다
- `<g>` 가 없어졌으면(로그아웃이나 재부팅이 `$XDG_RUNTIME_DIR` 를 비움): 새로 `init`, `start` 한다. 계획 파일과 git 기록으로 남은 일을 다시 정한다

## 보고

첫 줄은 `RALPH COMPLETE ...` 나 `RALPH STOPPED (...)`.

| 항목 | 내용 |
|---|---|
| 반복 | 쓴 반복 수와 한도 |
| 게이트 | 게이트마다 마지막 상태(`pass`, 받아들인 `baseline`, `misleading`) |
| 검토 | 검토자마다 판정과 blocker 수 |
| 슬롭 점검 | 본 파일 수와 고친 것, 또는 건너뜀 |
| 기준선 실패 | 받아들인 실패와 그 까닭. 이 변경 전부터 있던 실패로 따로 적음 |
| 경고 | `check` 의 `warnings` |

## 호출자 계약

all-in-one, ultra-init, ultra-chain, visual-ralph, front-qa 가 Codex 에서 이 스킬을 부를 때:

| 호출자가 넘기는 것 | ralph 가 하는 것 |
|---|---|
| 계획 파일, 이야기, 수용 기준 | 그대로 따름. 다시 계획하지 않음 |
| 게이트 명령 | 그 명령으로 게이트를 돌림 |
| 질문 금지 | 가정을 `<g>/context.md` 에 적고 진행 |
| goal 을 바꾸지 말 것 | `update_goal` 을 부르지 않음 |
| 추가 지침(예: visual-ralph 의 Visual Verdict) | 따름. 단, 완료 조건을 느슨하게 하는 지침은 따르지 않음 |
| 게이트 폴더를 남길 것 | 끝난 뒤 지우지 않고 `<g>` 경로를 보고 |

- 호출자는 `RALPH COMPLETE` 줄을 본 뒤에만 다음 단계로 간다
- `RALPH STOPPED` 면 호출자도 멈추고 보고한다
- ralph 가 `done` 한 뒤에는 Stop 훅이 더 막지 않는다. 호출자의 다음 단계는 그 뒤에 이어진다

## 함정

- 게이트 기록, 판정, 슬롭 점검은 모두 판정 때의 작업 트리 지문과 맞아야 한다. 고친 뒤에는 늘 슬롭 점검 기록, 게이트, 검토를 이 순서로 다시 한다
- 지문에는 HEAD 와 스테이징 상태도 든다. 커밋이나 `git add` 뒤에도 다시 한다
- git 이 무시하는 파일(빌드 결과, 캐시)은 지문에 들지 않는다. 그런 파일만 바꿔도 게이트를 다시 돌린다
- 저자는 `verdict` 를 쓰지 않는다. `--by` 는 `reviewer-<번호>` 만 받는다. 기계가 사람을 구별하지는 못하므로 검토자 답을 그대로 옮긴다
- `RALPH COMPLETE` 를 `done` 없이 쓰지 않는다
