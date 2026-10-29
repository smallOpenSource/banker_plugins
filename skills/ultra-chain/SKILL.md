---
name: ultra-chain
description: "조사부터 결과 공유까지 한 명령으로 잇는 개발 연쇄. 9단계를 차례로 진행: 자료 조사, 모호성 제거, 검토자 3명 이상의 합의 계획, 목업 승인, 비판 검증 구현. 이어서 실제 OS 테스트박스 시험과 합의 검증, 시각 검토, 과정 시각화, 결과 공유. 사람이 볼 곳은 인터뷰의 취향 질문과 목업 승인으로 줄임. 'ultra-chain'/'울트라 체인'/'조사부터 공유까지'/'전 과정 연쇄' 시 사용. 작은 수정은 이 스킬 대신 `ralph`."
argument-hint: "[--agents=N] [--codex[=<model>]] [--gemini[=<model>]] [--opencode[=<provider/model>]] [--boxes=all|none|<이름,...>] [--skip=<단계,...>] [--run=<실행 폴더> --from=<단계>] [--auto] [--max=N] <작업 설명>"
---

# ultra-chain: 조사부터 결과 공유까지 9단계 연쇄

한 작업을 아홉 단계로 끝까지 데려간다. 각 단계의 반복과 검증은 그 단계 스킬이 맡는다.
ultra-chain 이 직접 하는 일은 여섯 가지다.
- 단계 순서와 게이트
- 실행 기록
- 목업
- OS 박스 시험 연결
- 시각 검토
- 과정 시각화와 공유

답변은 한글.

## 언제 쓰나

- 되돌리기 비싼 기능 추가나 변경. 구현 전에 결과를 미리 보고 싶을 때.
- Windows, Linux, macOS 에서 모두 돌아야 하는 변경.
- 조사, 계획, 구현, 검증을 사람이 단계마다 붙잡지 않고 한 번에 돌리고 싶을 때.

## 쓰지 않을 때

- 한 줄 수정이나 작은 버그. `ralph` 나 직접 수정이 낫다.
- 아이디어만 있는 단계. `ultra-interview` 로 요구부터 정한다.
- 계획만, 검증만 필요할 때. `ralplan`, `ralph-qa` 를 따로 쓴다.
- 규모 주의: 조사, 합의, 검증마다 에이전트를 여럿 띄워 전체로 수십 개, 몇 시간이 든다.

## 원칙

- 단계는 순서대로 한다. 앞 단계의 게이트를 넘어야 다음 단계로 간다. 두 단계의 루프를 동시에 돌리지 않는다.
- 자기 채점하지 않는다. 계획과 결과는 독립 검토자가 판정하고, 시각 판정도 만든 맥락이 아닌 에이전트가 한다.
- 돌려 보지 않은 것은 통과로 적지 않는다. 미검증으로 적는다.
- OS 시험은 등록된 테스트박스에서만 한다. 박스가 없거나 접속되지 않으면 그 OS 는 미검증이다. GitHub 러너나 CI 를 돌리려는 push 로 대신하지 않는다.
- 커밋, push, PR 생성, 외부 게시, 릴리스는 사용자가 명시적으로 요청할 때만 한다.
- 미리보기는 로컬 파일과 로컬 서버로만 보인다. 외부 호스팅(claude.ai 아티팩트 등)에 올리지 않는다.
- 비밀값(키, 토큰, 비밀번호)을 실행 기록, 보고서, 공유물에 싣지 않는다. 요청 원문에 있으면 `[REDACTED]` 로 가려 적는다.
- 사용자의 실제 데이터와 설정에 쓰는 명령을 시험 삼아 돌리지 않는다. 시험은 임시 폴더나 임시 HOME 에서 한다.

## 인자

- 플래그는 작업 설명 앞에만 온다. 값은 `=` 로만 받는다(`--max=3`, `--gemini=<모델>`).
- 플래그가 아닌 첫 낱말부터 끝까지가 작업 설명이다. 작업 설명 안의 `--json` 같은 낱말은 플래그가 아니다.
- 맨 아래 `ARGUMENTS:` 줄은 형식 안내다. 사용자 입력이 아니다.
- `--from` 의 값은 단계 이름(`research`, `interview`, `plan`, `mock`, `build`, `qa`, `visual`, `trace`, `share`)이다.

## 런타임 대응

| 항목 | Claude Code (OMC) | Codex (OMX) |
|---|---|---|
| 1 자료 조사 | `Skill("banker:deep-research")` | `$banker-deep-research` |
| 1 전문가 작업 방식 | `Skill("banker:lfm")` | `$banker-lfm` |
| 2 모호성 제거 | `Skill("banker:ultra-interview")` | `$banker-ultra-interview` |
| 3 합의 계획 | `Skill("oh-my-claudecode:ralplan")` `--deliberate`, 이어서 `Skill("banker:ralph-qa")` | `$ralplan --deliberate`, 이어서 `$banker-ralph-qa`(플러그인 길 `$banker:ralph-qa`) |
| 5 구현 | `Skill("oh-my-claudecode:ralph")` `--critic=critic` | `$ralph` 뒤 이 스킬의 critic 루프(OMX `ralph` 에는 `--critic` 이 없다) |
| 6 합의 검증 | `Skill("banker:ralph-qa")` | `$banker-ralph-qa`(플러그인 길 `$banker:ralph-qa`) |
| 7 시각 판정 에이전트 | `Plan` 유형, `model` 없이 | `spawn_agent`, 역할과 `model` 없이 |
| 질문 | `AskUserQuestion` | `request_user_input`. 없으면 번호 붙인 평문 선택지 |
| 오래 도는 명령 | Bash `run_in_background`, 멈출 때 `TaskStop` | `exec_command` 를 `tty: true` 로 띄우고 `write_stdin` 으로 출력을 받음. 멈출 때 그 세션에 `write_stdin` 으로 Ctrl-C(`\u0003`). `tty` 없이 띄운 작업은 PID 로 멈춤 |
| 켜진 모드 확인과 끄기 | `state_list_active`, `/oh-my-claudecode:cancel` | `omx state list-active --json`, `$cancel` |
| 이어 하기 메모 | OMC 작업 노트에 덧붙이기(`notepad_write_working`). 우선 노트는 통째로 바뀌므로 쓰지 않음 | `.omx/notepad.md` 에 한 줄 덧붙이기 |
| 실행 기록 기본 폴더 | `.omc/ultra-chain/` | `.omx/ultra-chain/` |

- Codex 에는 Skill 도구가 없다. 위 표의 `$이름` 은 그 스킬의 `SKILL.md` 를 읽고 그대로 따른다는 뜻이다. banker 스킬은 npm 설치면 `<S>/../banker-<이름>/SKILL.md`, Codex 플러그인 설치(`<S>` 가 `plugins/cache/` 아래, 스킬 이름 `banker:<이름>`)면 `<S>/../<이름>/SKILL.md` 다. 표의 `$banker-<이름>` 은 플러그인 설치에서 `$banker:<이름>` 이다. OMX 스킬은 `~/.codex/skills/<이름>/SKILL.md` 다. 그 스킬이 상태 기록을 요구하면 그 지시대로 직접 기록한다. 큰 `SKILL.md`(ralph-qa 는 약 71KB)는 셸 출력 한도에서 잘리니 나눠 읽는다.
- Codex 의 하위 에이전트(critic, 시각 판정)는 저자 대화를 넘기지 않는다. multi-agent v2 는 `fork_turns="none"` 을 주고, v1 은 `fork_context` 를 주지 않는다. 판정을 받으면 `close_agent` 로 닫는다.
- Codex 환경 지시가 역할(`agent_type`)을 요구하면, 고정 모델이 세션 모델과 같은 역할을 쓰고 지시 앞머리에 파일 쓰기 금지를 적는다. 그런 역할이 없으면 역할 없이 띄운다. 쓴 역할과 모델, 강도를 판정 기록의 `note` 에 적는다.
- Codex 의 오래 도는 명령은 기다리는 시간을 박스 `--timeout` 보다 길게 둔다. 기다리다 끊기면 박스 정리와 결과 JSON 이 남지 않는다.
- Codex 세션을 닫으면 그 세션에서 띄운 서버도 끝날 수 있다. 오래 볼 미리보기는 사용자 터미널에서 띄우게 안내한다(9단계).

### Codex 샌드박스 (`workspace-write`)

다음은 승인이 필요할 수 있다. 승인은 `sandbox_permissions: "require_escalated"` 로 요청한다.

| 동작 | 이유 |
|---|---|
| `init --exclude`, `git add`, `git worktree`, 브랜치 만들기 | `.git` 쓰기 |
| 박스 시험(`boxes.mjs run`) | ssh, scp 네트워크와 `git stash create` 의 `.git` 쓰기 |
| `npm ci` 같은 의존성 설치, 웹 조사, 외부 좌석 | 네트워크 |
| 미리보기 서버, Chromium | 포트와 브라우저 실행 |
| ralph-qa 좌석 폴더, 게이트 기록 폴더 `<g>`(`seat-run.mjs init`, `gate-evidence.mjs run`) | 작업 폴더 밖 쓰기 |

- 모든 박스가 같은 권한 오류로 실패하면 접속 실패로 판정하지 않는다. 승인을 받아 다시 돌린 뒤 판정한다.
- 스테이징을 못 하면 새 시험 파일은 박스로 가지 않는다. 그 시험은 박스에서 미검증으로 적는다.
- 승인은 명령 하나씩 요청한다. 넓은 접두 규칙(`node`, `git`, `npm` 전체)은 요청하지 않는다. `&&` 로 묶은 명령도 나눠 요청하되, 하위 스킬이 실패하면 멈추는 장치로 쓰는 사슬은 나누지 않고 그대로 요청한다. ralph-qa 의 외부 좌석 전송은 실행기 명령 하나씩(`seat-run.mjs` 의 init, prepare, send 등)이라 사슬이 없다. 나눠 돌린 명령은 단계마다 종료 코드를 보고, 실패하면 멈춘다.

## 자리 표시

셸 변수는 도구 호출 사이에 남지 않는다. 명령마다 실제 값을 적는다.

| 자리 | 뜻 |
|---|---|
| `<S>` | 이 스킬 디렉터리 절대경로 |
| `<boxes>` | Claude Code `<S>/../remains/scripts/boxes.mjs`, Codex `<S>/../banker-remains/scripts/boxes.mjs` |
| `<scan>` | Claude Code `<S>/../ralph-qa/references/payload-scan.mjs`, Codex `<S>/../banker-ralph-qa/references/payload-scan.mjs` |
| `<rq>` | ralph-qa 의 `references` 폴더. Claude Code `<S>/../ralph-qa/references`, Codex npm 설치 `<S>/../banker-ralph-qa/references`, Codex 플러그인 설치 `<S>/../ralph-qa/references`. 게이트 실행기 `gate-evidence.mjs` 와 실행 폴더 도구 `seat-run.mjs` 가 여기 있다 |
| `<g>` | 게이트 기록 폴더. 5단계 1에서 `node "<rq>/seat-run.mjs" init` 이 낸 `dir` 다. 경로는 `05-baseline.md` 첫 줄에 있다 |
| `<run>` | 0단계에서 만든 실행 폴더 절대경로 |
| `<base>` | 0단계에서 기록한 기준 커밋. 깨끗한 트리면 `HEAD`, 기존 변경을 두고 진행하면 `git stash create` 가 낸 커밋. ralph-qa 와 critic 이 만드는 diff 의 기준이다 |
| `<agents>`, `<max>` | `--agents`, `--max` 값(기본 3, 5) |
| `<k>` | 6단계 회차. 회차를 시작할 때(6단계 1) 한 번 정하고, 그 회차의 시험, 박스, 판정 기록에 모두 같은 값을 쓴다. 값은 그때 `show` 의 `qa.maxRound` 다음 번호다. 실행 전체에서 이어 센다 |
| `<view>` | 목업 보기 이름. 영문 소문자, 숫자, `-` 만 쓴다(캡처 파일 이름이 된다) |

## 사람이 보는 곳

| 때 | 무엇 | `--auto` 일 때 |
|---|---|---|
| 0단계 | `omc` 점검 실패. `setup-omc` 로 맞출지 | 멈춰 보고 |
| 0단계 | 커밋 안 한 변경이 있음 | 묻지 않고 멈춰 보고 |
| 0단계 | 기본 브랜치에서 시작함 | 그 브랜치에서 진행하고 `checklist` 에 적음(커밋하지 않음) |
| 0단계 | 프로젝트 의존성이 설치돼 있지 않음. 설치 명령을 보이고 묻고, 승인하면 그 명령을 돌림 | 멈춰 보고 |
| 0단계 | 요청이 작은 수정으로 보임 | 진행하고 `checklist` 에 적음 |
| 2단계 | 취향 질문(P 항목)과 가정 훑기 | 보수적 가정으로 두고 `checklist` 에 넣음. 보수적인 쪽이 없는 핵심 P 가 남으면 멈춤 |
| 3단계 | 외부 좌석 모델 고르기(ralph-qa 가 물을 때, 한 번만) | ralph-qa 의 fallback 으로 앉음 |
| 3단계, 6단계 | 외부 좌석에 보낼 페이로드가 512 KiB 를 넘을 때 ralph-qa 가 묻는 확인 | 보내지 않음(ralph-qa 규칙) |
| 3단계 | 검토가 드러낸 명세 공백(명세에 없어 새로 정해야 하는 동작) | 보수적 가정으로 정하고 `checklist` 에 넣음 |
| 3단계 | 합의 실패 뒤 어떻게 할지 | 멈춰 보고 |
| 4단계 끝 | 목업과 수용 기준 승인. 연쇄 중간의 유일한 승인 지점 | 묻지 않음. 자동 승인으로 기록하고 `checklist` 에 넣음 |
| 9단계 | 외부 공유. 최종 보고 마지막 줄의 선택지에서 사용자가 고를 때만 | 로컬만 |

- 보수적 가정: 기존 기본값을 바꾸지 않고, 범위가 가장 좁고, 되돌리기 쉬운 쪽이다.
- 구현 실행의 승인은 4단계 승인이다. `--auto` 나 `--skip=mock` 이면 그 플래그가 승인이다. 사용자 규칙이 구현 전 승인을 요구하면 4단계 승인이 그 승인이다. 근거를 4단계 끝 기록의 `summary` 에 적는다.

## 실행 기록

모든 단계는 실행 폴더 하나에 산출물과 기록을 남긴다. 시각은 스크립트가 찍고, 모델이 적지 않는다.

```bash
node "<S>/references/chain-ledger.mjs" init --base .omc/ultra-chain --runtime claude --exclude
```

- Codex 는 `--base .omx/ultra-chain --runtime codex` 다.
- 출력 JSON 의 `dir` 가 `<run>` 이다. `mock/expected`, `actual`, `visual`, `qa`, `boxes` 폴더가 함께 생긴다.
- `ignored` 가 false 면 `--exclude` 가 기준 폴더(`/.omc/ultra-chain/`)를 저장소의 로컬 제외 파일(`.git/info/exclude`)에 넣는다. 추적되는 파일은 바꾸지 않는다. `excludeError` 가 있으면 넣지 못한 것이니 사용자에게 알린다.
- `<run>/task.md` 를 파일 도구로 쓴다. 첫 줄은 받은 인자 줄 그대로, 다음 줄부터 작업 설명이다. 쓴 뒤 `node "<scan>" "<run>/task.md"` 로 비밀처럼 보이는 문자열을 찾는다. 걸린 값은 `[REDACTED]` 로 가리고 0건이 될 때까지 다시 검사한다. `02-spec.md` 의 사용자 답변 원문도 같다.
- 단계를 시작할 때와 끝낼 때 기록한다. 끝 기록의 내용은 파일 도구로 `<run>/.event.json` 에 쓰고 `--file` 로 넘긴다. 명령줄에 긴 글을 넣지 않는다.

```bash
node "<S>/references/chain-ledger.mjs" event "<run>" --stage research --status started
node "<S>/references/chain-ledger.mjs" event "<run>" --stage research --status done --file "<run>/.event.json"
```

| 칸 | 규칙 |
|---|---|
| `--stage` | 단계 이름(인자 절) 또는 `preflight` |
| `--status` | `started`, `done`, `failed`, `skipped`, `stopped`, `note`(회차와 중간 기록). `failed`, `skipped`, `stopped` 는 `reason` 이 있어야 한다 |
| `artifacts` | `{label, path}`. `path` 는 실행 폴더 안 실제 파일의 상대 경로. 폴더는 넣지 않는다 |
| `verdict` | `by`, `result` 는 필수. `result` 는 `APPROVE`, `ITERATE`, `REJECT`, `INCONCLUSIVE`, `PASS`, `FAIL`, `STOPPED` 중 하나 |
| `verdict.seats` | `{id, lens, model, verdict}`. 좌석 `verdict` 는 `APPROVE`, `ITERATE`, `REJECT`, `ERROR` |
| `verdict.blockers` | `<좌석 id>: <내용>` 꼴의 글. 이어 하기에서 누가 낸 반대인지 되찾기 위해서다 |
| `round` | 회차 기록과 그 회차의 판정 기록은 같은 번호를 쓴다(6단계는 `<k>`). ralph-qa 와 critic 의 회차에만 쓴다 |
| `tests` | `{where, os, status, tests, pass, fail, skipped, note, log}`. `status` 는 `pass`, `fail`, `unverified` |
| `visual` | `{name, mock, actual, score, verdict, intended, note}`. `verdict` 는 `pass`, `revise`, `fail`, `unverified`. `mock`, `actual` 은 `visual/` 아래 PNG 경로 |
| `checklist` | `{item, why, ref}`. 사람이 볼 것. `ref` 는 실행 폴더 안 실제 파일의 상대 경로만 쓴다. 절이나 줄 같은 설명은 `why` 에 쓴다 |

- 판정 낱말 옮기기
  - ralph-qa 의 `APPROVE(3축)`, `ITERATE(한도 소진)` 같은 종결어는 괄호 앞 낱말만 `result` 에 쓰고, 종결어 전체와 판정 줄은 `verdict.note` 에 쓴다.
  - OMX critic 의 `OKAY` 는 `APPROVE`, `REJECT` 는 `ITERATE` 로 적는다.
  - 앉지 못한 외부 좌석은 `seats` 에서 빼고 사유를 `note` 에 쓴다.
  - 판정 에이전트의 `differences` 는 500자 안으로 줄여 `note` 에 쓴다.
- 모르는 칸이나 틀린 값은 거부되고 종료 코드가 2 다. 메시지대로 고쳐 다시 기록한다.
- 기록과 별도로, ralph-qa 의 보고 전문은 파일로 남긴다(3단계 `03-ralph-qa.md`, 6단계 `qa/ralph-qa-r<k>.md`). 압축 뒤에도 선언 블록을 옮길 수 있게 하기 위해서다.
- 보고서는 없는 파일과 폴더를 링크하지 않고 글로 보인다. 그래도 링크가 되도록 실제 파일만 적는다.
- 기록 명령(`event`, `boxes`)은 출력 JSON 의 `progress` 에 진행 줄을 준다(예: `[ultra-chain] 3/9 합의 계획: ralph-qa ITERATE 2회차`). 기록할 때마다 그 줄을 그대로 대화에 한 줄로 내고, 이어 하기 메모에도 덧붙인다. 진행 줄과 메모를 따로 지어 쓰지 않는다.

## 0. 사전 점검

1. 세션 위치: `git rev-parse --is-inside-work-tree` 가 `true` 이고 `git rev-parse --show-prefix` 가 빈 줄이어야 한다(세션 폴더가 저장소 루트). 아니면 멈추고, 대상 저장소 폴더에서 새 세션을 열어 달라고 요청한다. OMC 와 OMX 의 상태 폴더, `omc ralph verify` 가 세션 폴더를 기준으로 돈다.
2. 켜진 모드: OMC 키워드 훅이 요청 속 단어(ralplan 등)로 모드를 먼저 켰을 수 있다. 런타임 대응 표의 방법으로 확인하고, 켜져 있으면 끈 뒤 이 연쇄의 순서대로 진행한다.
3. 작업 트리: `git status --short --branch`. `.omc/`, `.omx/` 아래의 추적하지 않는 파일은 변경으로 세지 않는다.
   - `.omc/` 나 `.omx/` 가 git 에 무시되지 않으면 사용자에게 알린다. 나중에 커밋할 때 상태 파일이 섞일 수 있다. 로컬 제외 파일에 넣을지는 사용자가 정한다.
   - 커밋하지 않은 변경이 있으면 진행할지 묻는다(`--auto` 는 멈춤). 진행하면 지금 트리를 기준선으로 쓴다. `git stash create` 로 지금 트리의 커밋을 만들어 `<base>` 로 기록한다(작업 트리와 stash 목록은 바뀌지 않는다). 깨끗한 트리이거나 출력이 비면(기존 변경이 추적하지 않는 새 파일뿐) `<base>` 는 `HEAD` 의 커밋이다. 이렇게 해야 검토 diff 에 사용자의 기존 변경이 실리지 않는다.
   - 기본 브랜치면 작업 브랜치를 만들지 묻는다(`--auto` 는 그대로 진행).
4. `<boxes>`, `<scan>`, `<rq>/gate-evidence.mjs` 가 있는지 본다. banker 스킬은 함께 설치되므로 없으면 banker 설치가 깨진 것이니 멈추고 알린다. 이어서 실행 폴더를 만들고(`init`) `task.md` 를 쓴 뒤 바로 `preflight` 시작을 기록한다. 이어서 실행 폴더 경로, 해석한 플래그, 지금 단계를 이어 하기 메모(런타임 대응 표)에 덧붙인다. 사용자의 다른 메모는 고치지 않는다. 브랜치를 정한 뒤라 `run.json` 의 브랜치가 맞다. 아래 점검이 사전 점검의 걸린 시간에 들어가고, 점검 중에 멈춰도 기록이 남는다.
5. 의존성
   - Claude Code: `omc ralph verify --help 2>&1 | grep -q 'Usage: omc ralph verify' && echo "omc ok"`. 판정은 출력 문구로 한다. 실패하면 멈추고 알린다. `setup-omc` 로 맞출지 묻고, 승인할 때만 그 스킬을 따른다. 묻지 않고 설치나 갱신(`omc update`, `npm install -g`)을 하지 않는다(`--auto` 는 멈춤).
   - Claude Code: 판 두 개를 기록한다. 플러그인 판은 `~/.claude/plugins/installed_plugins.json`(`CLAUDE_CONFIG_DIR` 가 있으면 그 폴더의 `plugins/installed_plugins.json`)에서 `oh-my-claudecode@` 로 시작하는 항목의 `version` 이다. CLI 판은 `omc --version` 이다. 주 판(첫 숫자)이 다르면 `checklist` 에 넣고, 그 밖의 차이는 `summary` 에만 적는다. 하위 스킬이 기대한 대로 돌지 않아도 OMC 의 내부 모듈(`dist/` 아래)을 직접 불러 쓰지 않는다. 판이 다른 내부 API 를 부르게 된다.
   - Codex: `omx --version`.
   - 프로젝트 의존성: 시험에 필요한 의존성이 이 머신에 설치돼 있는지 본다(예: `package.json` 의 의존성이 있는데 `node_modules` 가 없음). 없으면 설치 명령을 보이고 사용자에게 묻는다. 승인하면 그 명령을 돌리고, 묻지 않고 설치하지는 않는다(`--auto` 는 멈춤).
6. 테스트박스(`--boxes=none` 이면 건너뛰고 기록)
   - `node "<boxes>" list` 로 등록을 본다. 등록 파일은 `~/.config/banker/test-boxes.json` 이다(형식은 `remains` 스킬). 없으면 알리고, 사용자가 등록을 원하면 그 형식으로 내용을 보여 확인받은 뒤 사용자가 만든다.
   - `node "<boxes>" probe` 로 접속과 `node`, `git`, `tar` 를 본다. 6단계에 쓸 박스는 접속된 박스다. `--boxes=<이름,...>` 이면 그중 그 이름만 쓴다.
   - 접속되지 않는 박스의 OS 는 미검증으로 예약한다.
   - 접속된 박스가 0대면 6단계의 박스 시험을 하지 않는다. `--box` 없이 돌리면 등록된 모든 박스로 가기 때문이다. 이 머신 밖의 대상 OS 는 모두 미검증으로 예약한다.
7. 브라우저: `node "<S>/references/capture.mjs" --check`. 종료 코드 0 이면 있다. 3 이면 stderr 의 문구로 원인(패키지 없음, Chromium 실행 실패)을 나눠 사용자에게 알린다. 묻지는 않는다. 설치는 사용자가 고른다: `npm i -g playwright && npx playwright install chromium`. `setup-playwright` 만으로는 브라우저만 받고 Node 용 패키지가 전역에 없을 수 있다. 없으면 7단계는 기계 대조만 하고 시각 판정을 미검증으로 남긴다.
8. 요청이 한 줄 수정처럼 작으면 그렇게 말하고 계속할지 묻는다(`--auto` 는 진행).
9. `preflight` 끝을 기록한다. `summary` 에는 해석한 플래그 전부, 런타임, OMC 판(플러그인과 CLI) 또는 OMX 판, `<base>`, 박스별 접속 결과, Playwright 유무, 제외 파일 결과를 적는다. `preflight` 시작을 기록한 뒤(4 이후)에 멈추면 `stopped` 와 `reason` 을 기록한다.

4 전에 멈추면 기록할 곳이 없으니 대화로만 보고한다.

## 1. 자료 조사

- deep-research 를 부른다. 넘기는 질문은 미리 좁히고, 인자에 "추가 질문 금지" 와 "전문가 작업 방식은 lfm 이 맡음" 을 적는다. 범위 질문은 2단계가 맡는다. 질문은 공개 웹 검색어가 되므로 저장소 코드, 내부 이름, 비밀값을 넣지 않는다.
- 저장소 사실(구조, 시험 명령과 시험 도구, 빌드 방법, 관련 코드 위치, CI)은 읽기 전용 탐색으로 모은다.
- 둘을 `<run>/01-research.md` 하나로 저장한다. 조사 보고, 그다음 `## 저장소 사실` 절이다. 조사 스킬은 보고를 대화에만 내므로 연쇄가 파일로 남긴다. 수동 경로였다면 충실도 한계를 그대로 옮긴다.
- 같은 단계에서 `lfm` 을 요청의 분야로 부른다. 인자는 `--no-questions --out <run>/01-masters.md` 다. 그 분야 최고 전문가 그룹이 이 일을 어떻게 하는지와 계획 적용 항목(`M-1` …)이 남는다. 검색어 규칙은 deep-research 와 같다(저장소 코드, 내부 이름, 비밀값을 넣지 않는다).
- `lfm` 이 "웹 조사 불가" 로 끝나면 `01-masters.md` 에 그 사실만 적고 진행한다. 3단계는 "전문가 작업 방식 없음" 으로 계획한다.
- 게이트: 살아남은 주장마다 출처가 있고, 폐기된 주장과 한계가 적혀 있다. 주장이 0개면 게이트를 지나지 않은 것이다.
- deep-research 가 "웹 조사 불가" 로 끝나면(네트워크 없음) 이 단계를 `skipped` 와 이유 "네트워크 없음" 으로 기록하고, 저장소 사실만 `01-research.md` 에 남긴 채 2단계로 간다. 사용자에게는 웹 조사를 하지 못했다고 알린다.
- `--skip=research` 면 이 단계를 `skipped` 로 기록한다. 2단계의 ultra-interview 가 자기 조사를 한다.

## 2. 모호성 제거

- ultra-interview 를 부른다. `01-research.md` 와 `01-masters.md` 를 근거로 넘기고, 거기서 답하지 못한 항목만 더 조사하게 한다. `01-masters.md` 가 있으면 `lfm` 을 다시 부르지 말라고 적는다.
- `--auto` 면 인자에 "사람에게 묻지 않는다. P 항목은 보수적 가정으로 답하고 가정임을 표시한다" 를 넣는다. 이 지시는 ultra-interview 의 "가정을 사람이 훑기 전에는 판정하지 않는다" 규칙보다 앞선다. 사용자가 `--auto` 로 묻지 말라고 명시했기 때문이다. 그래서 이 결과는 통과가 아니라 "사람 확인 없음" 으로 기록한다. 보수적인 쪽이 없는 핵심 P(기능의 뜻 자체를 정하는 항목)가 남으면 멈추고 보고한다.
- 결과를 `<run>/02-spec.md` 로 저장한다.
  - 번호 붙은 항목과 E, I, P 분류, 근거(URL, 파일 경로), 답, 가정
  - 사용자가 직접 답한 문장 원문(6단계 출처-독립 검토자가 쓴다)
  - 수용 기준 목록(`AC-1`, `AC-2` 처럼 번호). 연쇄가 항목에서 이끌어 낸다. 이후 모든 단계가 이 번호로 판정한다. 사람은 4단계에서 목업과 함께 확인한다
  - 모호도 셈 줄(전체 항목 수와 미해결 수)
- 게이트: ultra-interview 의 셈이 임계값 이하이고, 사용자가 가정을 한 번 훑었다(`--auto` 는 위 규칙). 진전 없이 2회 돌면 멈추고 남은 항목을 보고한다.

## 3. 합의 계획 (검토자 3명 이상)

ralplan 은 계획 작성자 외에 Architect 와 Critic 두 검토자로 합의하고, 검토자를 늘리는 옵션이 없다. 그래서 ralplan 합의 뒤 ralph-qa 의 독립 검토자 3명 이상이 같은 계획을 다시 판정한다. Architect 와 Critic 은 이 3명에 세지 않는다.

1. ralplan 을 `--deliberate` 로 부른다. `--interactive` 는 주지 않는다. 인자에 아래를 함께 넘긴다.
   - 요청 원문, `02-spec.md` 경로와 수용 기준, `01-research.md` 와 `01-masters.md` 경로
   - 계획에 `## 전문가 작업 방식 적용` 절을 두라는 지시. `01-masters.md` 의 `M-n` 마다 판정(적용, 조정, 제외)과 계획의 어느 단계에 넣었는지, 조정과 제외는 그 이유를 적는다. 판정을 바꾸면(예: `lfm` 이 적용인데 계획은 제외) 이유를 적는다
   - 계획 저장 경로: Claude Code 는 `.omc/plans/ultra-chain-<run id>.md`. Codex 는 OMX 규칙대로 `.omx/plans/` 에 쓴다
   - Codex: 인터뷰가 끝났으니 `$deep-interview` 를 돌리지 말라는 말
   - 계획에 넣을 것
     - 대상 OS 와 OS 별 시험 명령. 비대화형으로 돌게 한다(`CI=true`, 감시 모드 끔. Windows 는 `cmd` 기준으로 `set CI=true&&`)
     - 시험 출력 꼴. node:test 면 TAP(`--test-reporter=tap`)로 내게 한다. 박스 결과가 시험 수를 셀 수 있다
     - 이 머신의 로컬 게이트: `tests`, `build`, `lint`, `typecheck` 가운데 이 작업에 맞는 것, 게이트마다 명령 하나(`&&` 나 `;` 로 묶지 않음)와 시간 제한(초). 5단계 기준선과 6단계 ralph-qa `--gates` 가 이 목록을 쓴다
     - 4단계 목업의 보기 목록과 형태, 수용 기준과 단계의 대응
     - 7단계 기계 대조를 위해 실제 출력을 `<run>/actual/` 에 쓰는 방법(임시 데이터 폴더나 임시 HOME 에서)
   - 뒤 단계의 계약. Planner 와 검토자가 파일 시스템을 뒤져 찾지 않게 요약을 함께 넘긴다
     - 4단계 파일 규칙: 보기 하나에 `<run>/mock/<view>.html` 하나(외부 자원 없음), 보기와 수용 기준을 잇는 `mock/index.html`, 기대 출력은 `mock/expected/`(CLI 는 케이스마다 `<케이스>.stdout`, `.stderr`, `.code`. 웹은 상태별 DOM 사실 JSON)
     - 7단계: 실제 출력은 `<run>/actual/` 에 기대 출력과 같은 이름으로 만들어 바이트로 대조한다. CLI 와 라이브러리는 실제 출력을 목업과 같은 HTML 틀에 담아 찍는다
     - 6단계 박스 실행기(`<boxes>`): git 이 추적하는 파일만 보낸다(새 파일은 6단계에서 스테이징). `--node-test` 는 그 커밋의 `*.test.mjs` 전부를 `node --test --test-reporter=tap` 으로 돌리고, 그 밖은 `--cmd "<명령>"` 이다. 박스는 의존성을 설치하지 않는다. Windows 박스의 명령은 `.cmd` 안에서 돈다. 결과는 박스마다 접속 여부, 종료 코드, TAP 수, 로그 경로다
     - 더 볼 것이 있으면 이 `SKILL.md` 의 해당 절과 `<boxes>` 파일만 읽게 경로를 준다
2. ralplan 은 계획을 승인 대기로 두고 멈춘다. 이것은 계획 단계의 끝이지 연쇄의 끝이 아니다. 사용자가 이 스킬을 부른 것이 실행까지 가겠다는 명시적 선택이다.
   - Codex 의 OMX `ralplan` 은 합의 기록(`ralplan_consensus_gate`)이 완료인지 확인한다. OMX 가 권하는 후속 스킬 대신 이 연쇄를 잇는다.
   - 합의 결과는 `round` 없이 `note` 하나로 기록한다. `verdict.by` 는 `ralplan`, `verdict.result` 는 합의했으면 `APPROVE`, `verdict.note` 에 합의까지 걸린 회차와 Architect, Critic 의 판정을 적는다. `round` 는 4의 ralph-qa 회차가 쓴다.
3. 합의된 계획을 `<run>/03-plan.md` 로 복사한다.
   - Claude Code: 1 에서 지정한 경로, 또는 ralplan 이 보고한 계획 경로다. 둘 다 없으면 이 단계가 시작된 뒤 `.omc/plans/` 에 쓰였고 `pending approval` 표지가 있는 파일을 고른다. 검토 문서(이름이 `-critic.md`, `-architect.md`, `-review.md` 로 끝남)와 `open-questions.md` 는 고르지 않는다. 원본 경로는 `summary` 에 적는다.
   - Codex: 이번에 쓰인 `.omx/plans/prd-*.md` 와 `test-spec-*.md` 를 차례로 붙이고, 원본 경로를 맨 위에 적는다.
4. ralph-qa 를 `--lens=plan --agents=<agents> --max=<max>` 로 부른다. 외부 좌석 플래그(`--codex`, `--gemini`, `--opencode`)는 사용자가 준 것만 넘긴다.
   - `--gates` 는 주지 않는다. 구현 전이라 돌릴 대상이 없는 계획 검토이고, 까닭은 `계획 검토` 로 넘긴다. ralph-qa 보고의 `게이트: 선언 없음(계획 검토)` 줄은 `03-ralph-qa.md` 에 그대로 두고, 판정 기록의 `verdict.note` 에도 판정 줄과 함께 적는다. 보고에 그 줄이 없으면 기록하기 전에 ralph-qa 에 그 줄을 다시 받는다.
   - 검증 대상: `03-plan.md`(구현 전이라 `<base>` 대비 diff 가 없으니 원문으로 붙인다). 수용 기준: `02-spec.md` 의 AC 와 deliberate 필수 항목(사전 부검, 확장 시험 계획), 그리고 `01-masters.md` 의 `M-n` 이 모두 `## 전문가 작업 방식 적용` 절에 판정과 함께 있는지(조정과 제외에 이유가 있는지).
   - 모든 좌석의 지시에 "저자의 주장이 틀렸다는 증거를 먼저 찾는 적대적 검토자로 판정한다" 를 넣는다. 렌즈 배정은 ralph-qa 그대로다. ralph-qa 의 기본 배정에서는 적대적 반증 렌즈가 한 좌석뿐이라, 이 문장이 있어야 검토자 모두가 적대적이다.
   - 출처-독립 검토자에게 줄 "사용자 원 요청" 은 `task.md` 와 `02-spec.md` 의 사용자 답변 원문이다.
   - ralph-qa 가 외부 모델을 물으면 여기서 한 번만 고르게 하고, 고른 모델을 기록한다. 6단계에는 `--gemini=<그 모델>` 처럼 값을 박아 넘긴다.
   - 회차마다 `note` 로 기록한다: `round`, `verdict.by`(`ralph-qa`), `verdict.result`, `verdict.seats`, `verdict.blockers`, `verdict.note`(종결어와 판정 줄).
   - `ITERATE` 면 지적대로 `03-plan.md` 를 고치고 같은 실행에서 다시 판정받는다. 고친 계획이 ralplan 의 합의와 크게 달라졌으면 그 사실을 기록한다.
   - 검토가 명세 공백을 드러내면(명세에 없어 새로 정해야 하는 동작) 사용자에게 묻는다(`--auto` 는 보수적 가정으로 정하고 `checklist` 에 넣는다). 답을 `02-spec.md` 에 새 항목과 새 수용 기준 번호로 덧붙이고, `interview` 에 `note` 로 기록한다. `summary` 는 그 단계의 요약으로 보이므로 "명세 개정: 항목 <번호>, <AC 번호>. 처음 요약: <끝 기록의 summary>" 처럼 처음 요약을 이어 적는다. 이후 단계는 개정된 명세로 판정한다.
   - 끝나면 보고 전문을 `<run>/03-ralph-qa.md` 로 저장하고 `artifacts` 에 넣는다.
5. 게이트: ralph-qa 판정이 `APPROVE`. ralplan 이 5회 안에 합의하지 못하거나 ralph-qa 가 `INCONCLUSIVE` 나 한도 소진으로 끝나면 멈춘다. 가장 나은 안과 남은 지적을 보이고 어떻게 할지 묻는다(`--auto` 는 `stopped` 로 기록하고 보고).

- Codex 의 OMX `ralplan` 은 Critic 이 Architect 의 검토를 받는다. Architect 역할의 모델이 세션 모델과 다를 수 있다. 그 사실을 `note` 에 적는다.

## 4. 목업 (사람 승인)

구현 전에 기대 결과물을 보여 주고 승인받는다. 승인된 목업은 5단계의 수용 기준이고 7단계의 비교 기준이다.

| 결과물 | 목업 | 기대 출력(`mock/expected/`) |
|---|---|---|
| 웹 화면 | 화면 상태마다 실제 앱과 같은 크기의 정적 HTML | 상태별 DOM 사실 JSON(보이는 글, 속성, 개수) |
| CLI | 명령과 출력을 담은 터미널 모양 HTML | 명령별 표준 출력, 표준 오류, 종료 코드 |
| 라이브러리, API | 호출 예, 시그니처, 오류 사례 | 호출별 기대 반환값 JSON |
| 문서 | 목차와 한 절의 견본 | 없음(시각 판정만) |
| 구조, 흐름 | 인라인 SVG 그림 | 없음(시각 판정만) |

- 파일 규칙
  - `<run>/mock/<view>.html`: 보기 하나에 파일 하나. 외부 자원(CDN, 웹 글꼴, 원격 이미지) 없이 자체 완결
  - `<run>/mock/index.html`: 보기 목록, 각 보기가 다루는 계획 단계와 수용 기준 번호
  - 웹 화면의 상태(펼침, 오류, 토글 켬)는 실제 앱에서 URL(쿼리, 해시)이나 시험용 경로로 바로 열 수 있게 계획한다. 캡처 도구는 클릭하지 못한다. 열 수 없는 상태는 7단계에서 `checklist` 에 넣는다
  - 기대 출력에서 실행마다 바뀌는 값(id, 시각, 임시 경로)은 빼거나 `<이름>.ignore.json` 에 칸 이름을 적어 대조에서 제외한다
- 미리보기 서버: 실행 폴더 전체를 서빙한다. 오래 도는 명령으로 띄운다(런타임 대응 표). `--auto` 면 9단계에서 처음 띄운다.

  ```bash
  node "<S>/references/serve.mjs" "<run>"
  ```

  - 출력의 `PREVIEW http://localhost:<port>/` 뒤에 `mock/index.html` 을 붙여 안내한다. 폴더 주소(`mock/`)는 404 다.
  - 사용자의 브라우저가 다른 머신이면(`SSH_CONNECTION` 이 있으면 그렇다고 본다) ssh 포트 포워딩(`ssh -L <port>:localhost:<port> <서버>`)을 먼저 안내한다.
  - 사용자가 같은 망에서 바로 열기를 고르면, 목업 폴더만 4단계 답을 받을 때까지만 연다. 실행 폴더 서버는 계속 loopback 으로만 둔다.
    - `mock/` 아래 텍스트 파일을 하나씩 `<scan>` 으로 검사한다. 모두 종료 코드 0, `count` 0 일 때만 연다. 아니면 열지 않고 걸린 파일과 줄을 보인다.
    - `0.0.0.0` 대신 사설 주소 하나에 바인드한다: `PREVIEW_HOST=<사설 IP> node "<S>/references/serve.mjs" "<run>/mock"`. 서버의 경고를 사용자에게 옮긴다. 주소는 출력된 `http://<사설 IP>:<port>/` 다(서버는 도메인 이름으로 온 요청을 거절한다).
    - 답을 받으면 바로 `node "<S>/references/serve.mjs" --stop "<run>/mock"` 으로 닫는다.
  - 실행 폴더 서버는 늘 `PREVIEW_HOST` 없이(loopback) 부른다. 다시 부를 때도 오래 도는 명령으로 부른다. 설정이 다르면 서버가 종료 코드 1 로 거절한다.
  - 서버가 `PREVIEW` 줄을 내지 않고 끝나면 `<S>` 를 실제 경로(`realpath`)로 바꿔 다시 부른다. 링크를 거친 경로로 부르면 아무것도 하지 않고 끝난다.
  - 명령 출력을 목업이나 실제 HTML 에 넣을 때는 `&`, `<`, `>` 를 escape 한다.
- 질문: 목업 URL, 계획 요약(단계), 수용 기준 목록, 목업이 다루지 못한 것을 보이고 `승인`, `고쳐 줘`, `멈춤` 중 하나를 받는다.
  - `고쳐 줘` 면 목업이나 수용 기준을 고치고 다시 묻는다. 계획이 바뀌는 수정이면 `03-plan.md` 를 고치고, 새 ralph-qa 실행(`--lens=plan`)으로 바뀐 부분을 판정받는다. 3단계 판정 기록을 입력에 넣고, 새 실행이라는 사실을 기록한다.
  - 세 번 고쳐도 승인되지 않으면 계속할지 묻는다.
- 게이트: 사용자의 승인. `summary` 에 승인 근거를 적는다. `--auto` 면 `summary` 에 "자동 승인(--auto)" 을, `checklist` 에 "목업과 수용 기준을 사람이 승인하지 않음" 을 남긴다.

## 5. 구현

1. 기준선: 바꾸기 전에 계획의 로컬 게이트마다 명령을 실행기로 한 번 돌린다. 0단계에서 기존 변경을 두고 진행했으면 지금 트리를 기준선으로 쓴다.
   - `node "<rq>/seat-run.mjs" init` 으로 게이트 기록 폴더를 만든다. 출력의 `dir` 가 `<g>` 다. 이어 하기 메모에 `<g>` 를 덧붙인다.
   - 게이트마다 `node "<rq>/gate-evidence.mjs" run --dir "<g>" --id <게이트> --cmd "<명령>" --timeout <초> --iter 0 --cwd "<저장소>"` 를 돌린다. 반복 0 이 기준선이다. 6단계 ralph-qa 는 같은 명령, 같은 실패 서명의 실패를 이번 변경의 실패가 아닌 것으로 가른다.
   - `<run>/05-baseline.md` 첫 줄에 `<g>` 경로를 쓴다. 그 아래에 게이트마다 출력 JSON 의 `verdict`, `signature`, `output` 과 이미 실패하는 항목을 옮긴다.
   - 깨끗한 사본이 필요하면 저장소 밖 임시 폴더에 `git worktree add --detach <임시> HEAD` 로 만들고 `--cwd` 를 그 폴더로 준다. 의존성을 링크하거나 설치한 뒤 돌리고, 명령이 실제로 돌았는지 확인한다. "명령 없음" 오류뿐인 기록은 기준선이 아니다. 끝나면 `git worktree remove --force <임시>` 로 지운다.
   - `git stash`, `git reset` 은 쓰지 않는다.
2. Claude Code: ralph 를 `--critic=critic` 으로 부른다. 인자에 아래를 넘긴다.
   - `03-plan.md` 경로. 계획은 합의가 끝났으니 다시 계획하지 말고 PRD 이야기로 나눠 구현하라는 말
   - 승인된 목업 경로와 `mock/expected/`. 기대 출력은 수용 시험의 기준이다
   - `02-spec.md` 의 수용 기준
   - PRD 의 `repoQualityClass`(`prototype`, `production`, `library`)를 저장소 신호(CI, 시험 깊이, 배포 메타데이터)로 정해 넘긴다. ralph 가 사용자에게 묻지 않게 한다
   - 피드백 명령은 기준선을 기록하기 전에 정하고, 성공 때 출력이 일정하며 실패만 이름을 대는 꼴로 쓰게 한다. ralph 의 확인은 출력의 모든 줄을 지문으로 쓰기 때문이다
     - node:test: `FORCE_COLOR=0 NODE_NO_WARNINGS=1 node --test --test-reporter=dot 2>&1 | grep -Ev '^[.X]+$'`. 이 꼴은 출력으로만 판정한다(성공하면 grep 의 종료 코드가 1 이다). 6단계 시험과 박스 명령에는 쓰지 않는다
     - 시각이나 소요 시간을 찍는 러너는 그 줄을 뺀다. 예: vitest 는 `Start at`, `Duration` 줄을 `grep -Ev` 로 거른다
     - 빌드와 린트도 성공 때 조용한 꼴을 쓴다. 예: `vite build --logLevel error`(파일 크기 줄이 나오지 않는다)
     - 이 머신이 Windows 면 POSIX 꼴(`grep`)이 돌지 않는다. PowerShell 의 `Select-String -NotMatch` 같은 같은 뜻의 꼴을 쓴다
   - ralph 를 부른 직후 `state_read` 로 ralph 상태를 읽고, 이 세션의 `prd.json`(`.omc/state/sessions/<id>/prd.json`, `OMC_STATE_DIR` 이 있으면 그 아래)이 있는지 본다. OMC 5.7.1 에서 ralph 상태를 만드는 것은 프롬프트의 `ralph` 키워드 훅뿐이고, 그 훅은 상태만 만든다. `prd.json` 을 만드는 배포된 훅은 없으니 `prd.json` 은 늘 이 연쇄가 쓴다. Skill 로만 불렀으면 상태도 없을 수 있다. `--critic=critic` 은 훅에는 읽히지 않는다(ralph 스킬 본문은 읽는다).
     - 지금 세션 id 는 `.omc/state/sessions/*/session-started.json` 가운데 `cwd` 가 이 저장소이고 `started_at` 이 가장 늦은 파일의 `session_id` 다. 같은 저장소에 세션이 둘 이상 떠 있어 가리기 어려우면 사용자에게 묻는다.
     - `state_write` 는 상태 파일을 통째로 바꾼다. 고칠 때는 읽은 상태의 칸을 모두 두고 한 칸만 바꿔 통째로 쓴다. `session_id` 는 도구 인자와 `state` 안에 둘 다 넣는다. 본문의 `session_id` 가 다르면 Stop 훅이 루프를 잇지 않는다.
     - 상태가 있는데 `critic_mode` 가 `critic` 이 아니면 그 칸만 `critic` 으로 바꿔 쓴다. 5.7.1 의 Stop 훅은 이 칸을 읽지 않으니 기록용이다. 실제 검토자는 아래 3 에서 ralph 보고로 확인한다.
     - 상태가 없으면 OMC 의 `RalphLoopState` 칸으로 쓴다: `active: true`, `iteration: 1`, `max_iterations: 10`, `started_at`(지금 ISO 시각), `prompt`(ralph 에 넘긴 인자를 500자 안으로), `session_id`, `project_path`(저장소 루트), `prd_mode: true`, `critic_mode: "critic"`. OMC 판이 바뀌었으면 그 판의 `src/hooks/ralph/loop.ts` 를 따른다.
     - `prd.json` 이 없으면 OMC 의 `PRD` 꼴(`src/hooks/ralph/prd.ts`)로 쓴다. 최상위 `project`(저장소 이름), `branchName`(지금 브랜치), `description`(작업 요약), `userStories` 는 빠지면 OMC 가 PRD 전체를 무효로 읽는다. 이야기마다 `id`, `title`, `description`, `acceptanceCriteria`(배열), `priority`(수), `passes: false` 를 넣는다. 위에서 정한 피드백 명령은 `feedbackCommands`, 품질 등급은 `repoQualityClass` 로 같은 파일에 넣는다. 빠지면 `omc ralph verify` 가 package.json 의 스크립트로 대신 돈다.
     - OMC 의 내부 모듈(`dist/` 아래)을 불러 PRD 나 상태를 만들지 않는다. 판이 다른 내부 API 를 부르게 된다. 이 확인과 고친 것을 `build` 의 `note` 에 적는다.
3. ralph 가 끝까지 가게 둔다(검토자 승인, deslop, 회귀 확인, `/oh-my-claudecode:cancel`). ralph 의 cancel 은 구현 단계의 끝이지 연쇄의 끝이 아니다. ralph 가 아직 도는 동안 6단계를 시작하지 않는다. 끝나면 `.omc/state/sessions/<id>/prd.json`(`OMC_STATE_DIR` 이 있으면 그 아래)을 `<run>/05-prd.json` 으로 복사한다. ralph 의 반복 한도는 ralph 자신의 것이다. ralph 보고에서 실제로 승인한 검토자가 critic 인지 확인해 기록한다. Skill 경로로 켠 ralph 는 검토자 설정이 architect 로 남을 수 있다.
4. Codex: `$ralph` 를 따른다. 2의 입력을 같이 넘기고, 인터뷰가 끝났으니 `$deep-interview` 를 돌리지 말라고 적는다. 연쇄 전체의 목표(goal)를 완료로 바꾸지 말라고도 적는다. 이어서 critic 루프를 돈다.
   - 런타임 대응 절의 방법으로 critic 을 띄운다. 역할 `critic` 의 고정 모델이 세션 모델과 같으면 그 역할을 쓰고, 아니면 런타임 대응 절의 역할 규칙을 따른다. 지시 앞머리에 파일 쓰기 금지를 적는다.
   - 입력: 새 파일을 포함한 diff, `03-plan.md`, 수용 기준, 시험 출력 원문. diff 는 ralph-qa 의 외부 좌석 전송 2단계(임시 인덱스 사본)로, `<base>` 를 기준으로 만든다.
   - 출력 꼴을 고정한다: 단독 줄 `VERDICT: APPROVE` 나 `VERDICT: ITERATE`, 그 아래 번호 붙은 고칠 목록.
   - 2회차부터는 앞 회차 목록을 주고 항목마다 해소 여부를 판정하게 한다. 회차마다 `build` 에 `note`(`verdict.by: "critic"`)를 남긴다.
   - `<max>` 회 안에 `APPROVE` 가 아니면 멈추고 보고한다.
5. 게이트
   - Claude Code: 모든 PRD 이야기 통과, critic `APPROVE`.
   - Codex: 계획의 모든 단계와 수용 기준이 시험 출력으로 확인되고 critic `APPROVE`.
   - 같은 문제가 3회 되풀이되거나 자격 증명, 외부 의존이 막으면 멈추고 보고한다. 부서진 구현으로 6단계를 돌리지 않는다.

## 6. OS 시험과 합의 검증

ralph-qa 의 검토자는 시험을 직접 돌리지 않는다. 이 머신의 게이트는 실행기(`gate-evidence.mjs run`)가 돌려 `observed` 기록으로 남기고, 박스 시험은 박스 실행기가 돌린다. 검토자는 그 기록과 출력을 대조한다. 회차 `<k>` 는 1을 시작할 때 `show` 의 `qa.maxRound` 다음 번호로 한 번 정하고, 그 회차가 끝날 때까지 바꾸지 않는다.

1. 이번 변경의 새 파일을 스테이징한다(`git add -- <파일>...`, 커밋은 하지 않음). 박스로 보내는 트리는 추적 파일만 담는다. 스테이징할 목록을 먼저 보인다.
   - `.omc/`, `.omx/` 아래, `.env` 류, 키와 자격 증명 파일은 넣지 않는다.
   - 넣을 텍스트 파일은 `<scan>` 으로 검사한다. 걸린 파일은 넣지 않고 사용자에게 알린다. 그 파일이 필요한 시험은 박스에서 미검증이다.
2. 이 머신의 로컬 게이트를 실행기로 돌린다. 게이트마다 `node "<rq>/gate-evidence.mjs" run --dir "<g>" --id <게이트> --cmd "<명령>" --timeout <초> --iter <k> --cwd "<저장소>"` 를 하나씩 돌린다(게이트 하나에 명령 하나). 반복 번호는 회차 `<k>` 다.
   - 이어서 `node "<S>/references/chain-ledger.mjs" gates "<run>" --file "<g>/evidence.md" --round <k>` 로 기록한다. 반복 `<k>` 의 `observed` 기록만 `tests`(`where: "local:<게이트>"`)로 옮기고, 보기 `<run>/qa/local-r<k>.md` 를 만든다.
   - `status` 는 기록의 판정에서 온다. `pass` 는 통과, `fail` 과 `timeout` 은 실패, `misleading` 과 출력 파일 sha256 불일치는 미검증이다. 기준선과 같은 실패는 실패로 두고 `note` 에 적힌다.
   - `reported`(모델이 적은 결과)는 받지 않는다. 시험 결과를 손으로 `tests` 에 적지 않는다.
   - `<g>` 가 없으면(하루 넘게 지나 정리됨) 새로 `init` 하고 반복 0 없이 돈다. 그러면 기존 실패도 이번 변경의 실패로 셈해진다. 그 사실을 `checklist` 에 넣고 `05-baseline.md` 를 검토 입력에 넣는다.
3. 박스에서 같은 시험을 돌린다. 고른 박스마다 `--box <이름>` 을 붙인다. 오래 도는 명령으로 돌리고, 끝난 뒤에 기록한다.

   ```bash
   node "<boxes>" run --ref worktree --out "<run>/boxes/r<k>" --box <이름> --box <이름> --node-test > "<run>/boxes/r<k>.json"
   node "<S>/references/chain-ledger.mjs" boxes "<run>" --file "<run>/boxes/r<k>.json" --round <k>
   ```

   - `--node-test` 는 시험 파일이 모두 `*.test.mjs` 인 node:test 프로젝트에만 쓴다. 그 밖은 `--cmd "<시험 명령>"` 이고, node:test 면 `--test-reporter=tap` 을 붙인다. TAP 이 아니면 시험 수와 "시험 0건" 이 남지 않는다. 그때는 기록하기 전에 로그(`<run>/boxes/r<k>/<이름>.log`)로 시험이 실제로 돌았는지 확인한다. 확인하지 못한 박스는 기록 명령에 `--unverified <이름,...> --why "<이유>"` 를 붙여 처음부터 미검증으로 기록한다.
   - OS 마다 명령이 다르면 `--box` 로 나눠 돌리고 `r<k>-<이름>.json` 으로 받는다. 파일마다 `boxes` 기록을 남긴다. Windows 박스는 `.cmd` 안에서 돈다.
   - 박스 실행의 종료 코드가 0, 1, 130, 143 이면 기록한다. 2 면 stdout 이 비어 있으니 stderr 를 보고 명령을 고쳐 다시 돌린다.
   - 결과의 `untracked` 가 0 이 아니고 그 파일이 시험에 필요하면 1부터 다시 한다.
   - 기록 스크립트가 박스 결과를 통과, 실패, 미검증으로 바꾼다. 명령 없음(127, 9009), 트리 진입 실패(97), 시험 0건, 접속 실패, 중단은 미검증이다.
   - 박스는 의존성을 설치하지 않는다. 필요하면 계획이 정한 설치 명령을 `--cmd` 앞에 넣는다(`npm ci && ...`). 그래도 못 돌면 미검증이다.
   - `--cmd` 에 비밀값을 넣지 않는다. 명령은 결과 JSON 과 검토 입력에 그대로 남는다.
   - 0단계에서 접속된 박스가 0대였으면 이 3을 하지 않는다.
   - 한 OS 에서만 실패하면 원인을 나눈다. 제품 결함은 고치고, 시험이 실행 환경을 잘못 가정한 것도 고친다.
   - `--boxes=none` 이면 이 3을 건너뛴다.
4. ralph-qa 를 `--lens=both --gates=<계획의 로컬 게이트> --agents=<agents> --max=<max>` 로 부른다. 외부 좌석은 3단계에서 고른 모델을 값으로 넘긴다.
   - 입력: 요청 원문, `02-spec.md` 의 수용 기준과 사용자 답변 원문, `03-plan.md`, 승인된 목업과 기대 출력, 3의 박스 JSON 과 실패한 박스의 로그 발췌, `05-baseline.md`. diff 의 기준은 `<base>` 다
   - 게이트 증거: 게이트 기록 폴더 `<g>`(반복 0 기준선과 반복 `<k>` 의 `observed` 기록), 게이트마다 명령과 시간 제한, 반복 번호는 회차 `<k>` 라는 말. `<g>` 는 게이트 기록 전용이라 ralph-qa 가 지우지 않는다(9단계에서 지움). 외부 좌석 페이로드는 ralph-qa 가 따로 만든 폴더로 보낸다
   - 박스 JSON 은 기존대로 입력이다(박스 실행기가 만든 기록). 게이트 연언항에는 넣지 않는다
   - 3단계와 같이 모든 좌석의 지시에 적대적 검토 문장을 넣는다
   - 회차마다 `note` 로 기록하고, 끝나면 보고 전문을 `<run>/qa/ralph-qa-r<k>.md` 로 저장한다. `verdict.note` 에는 종결어 전체와 판정 줄, 게이트 블록의 `연언항` 줄을 쓴다. 종결어가 `ITERATE(한도 소진, 원인 gate)` 면 `result` 는 `ITERATE` 이고 `원인 gate` 는 `note` 에 남는다.
   - `ITERATE` 면 고친 뒤 1부터 3까지 다시 하고(새 `<k>`), 같은 실행에서 다시 판정받는다. 끈끈한 반대는 그 검토자의 재판정으로만 풀린다.
5. 게이트: ralph-qa 판정이 `APPROVE`. `INCONCLUSIVE` 나 한도 소진이면 멈추고 보고한다. 계획의 대상 OS 가운데 확인하지 못한 OS 는 `checklist` 에 하나씩 넣는다.

## 7. 시각 검토

사람이 볼 곳을 줄이는 단계다. 기계로 판정할 수 있는 것을 먼저 판정하고, 그다음 독립 에이전트가 화면을 판정한다. 둘 다 못 한 것만 사람에게 남긴다.

1. 기계 대조: 계획이 정한 방법으로 실제 출력을 `<run>/actual/<이름>.<확장자>` 에 만든다.
   - 임시 데이터 폴더나 임시 HOME 에서 만든다. 사용자의 실제 데이터에 쓰지 않는다.
   - 색을 끈다(`NO_COLOR=1`). 종료 코드도 대조 대상이다.
   - `mock/expected/` 와 대조한다. JSON 은 파싱해 깊게 비교하고, 텍스트는 바이트로 비교한다(줄 끝 포함). `.ignore.json` 에 적힌 칸은 뺀다.
   - 결과를 보기마다 `tests` 하나로 `where: "compare:<보기>"` 에 기록한다. `tests` 는 그 보기에서 대조한 파일 수, `pass` 는 같은 파일 수, `fail` 은 다른 파일 수다. `log` 는 파일마다 `same <이름>` 이나 `DIFF <이름>` 한 줄을 남긴 대조 출력(`visual/compare-r<k>.md`, `<k>` 는 마지막 `qa` 회차)이다. 로그만 보고도 수를 다시 셀 수 있어야 한다.
2. 캡처: 목업 보기와 실제 결과를 같은 크기로 찍는다. CLI 와 라이브러리는 실제 출력을 escape 해 목업과 같은 HTML 틀에 담아 `<run>/actual/<view>.html` 로 만든 뒤 찍는다. 앱 서버가 필요하면 시험 데이터와 임시 HOME 으로(실제 `.env`, 실제 DB 없이) 오래 도는 명령으로 띄우고, 캡처가 끝나면 그 작업을 멈춘다.

   ```bash
   node "<S>/references/capture.mjs" --out "<run>/visual" --viewport 1280x800 --full mock-<view>="<run>/mock/<view>.html" actual-<view>="<실제 URL 또는 파일>"
   ```

   - `--full` 은 창 높이가 아니라 페이지 전체를 찍는다. CLI 출력, 문서, 창보다 긴 보기는 늘 `--full` 로 찍는다. 화면 크기가 판정 대상인 웹 보기만 `--full` 없이 찍는다. 목업과 실제는 같은 옵션으로 찍는다. 옵션은 `capture.mjs --help` 로 본다.

   - 종료 코드 3 은 Playwright 나 브라우저가 없다는 뜻이다. 기계 대조만 남기고, 보기마다 `visual` 에 `verdict: "unverified"` 와 사유를 적는다.
   - 프로젝트 자신의 Playwright 를 쓰려면 `--playwright-from-project` 를 준다. 그 프로젝트의 코드를 실행하므로 사용자 저장소일 때만 쓴다.
   - URL 은 loopback(`localhost`, `127.0.0.1`, `[::1]`)만 찍는다. 다른 주소는 사용자가 그 주소를 지정했을 때만 `--allow-remote` 로 찍는다.
   - `--skip=mock` 이면 비교할 목업이 없다. 실제 화면만 찍어 보고서에 싣고, 보기마다 `visual` 에 `verdict: "unverified"` 와 "목업 없음" 을 적어 `checklist` 에 넣는다.
3. 시각 판정: 구현에 관여하지 않은 새 에이전트에게 맡긴다(런타임 대응 표). 지시 앞머리에 파일 쓰기 금지를 적는다. Codex 는 PNG 를 `view_image` 로 연다.
   - 입력: 보기마다 목업 PNG 와 실제 PNG, 그 보기의 수용 기준
   - 출력: 보기마다 JSON 한 줄. `{"name", "score": 0~100, "verdict": "pass|revise|fail", "differences": [...]}`
   - 판정은 점수로 한다. 90점 이상이 통과다. `verdict` 와 점수가 어긋나면 점수를 따른다. 다만 아래의 잘림 때문에 낸 `revise` 는 점수와 관계없이 `revise` 다.
   - 판정자 지시에 "잘려서 보이지 않는 수용 기준이 있으면 점수와 관계없이 `revise` 로 하고 `differences` 에 무엇이 잘렸는지 적는다" 를 넣는다. 그런 보기는 `--full` 로 한 번 다시 찍어 다시 판정받는다. 이미 `--full` 로 찍었으면 다시 찍지 않고 바로 아래처럼 미검증으로 적는다. 다시 찍어도 잘리면 `visual` 에 `verdict: "unverified"` 로 적고 `checklist` 에 넣는다. 보이지 않는 것을 통과로 적지 않는다. 잘림만으로 낸 `revise` 는 아래 4의 결함 순환에 넣지 않고, 보이는 부분에 결함이 따로 있으면 그 몫은 4로 보낸다.
   - `visual` 에 기록한다: `mock` 은 `visual/mock-<view>.png`, `actual` 은 `visual/actual-<view>.png`.
4. 90점 미만이면(잘림만으로 낸 경우는 빼고) 연쇄가 차이를 나눈다.
   - 결함: 고친 뒤 `qa` 에 `started` 를 다시 기록하고 6단계의 1부터 4를 바뀐 부분에 대해 다시 한다(새 `<k>`). 6단계의 ralph-qa 실행은 끝났으니 새 실행을 열고, 앞 판정 기록과 바뀐 부분을 입력에 넣는다. `APPROVE` 면 `qa` 에 `done` 을 기록하고 7단계로 돌아와 다시 찍고 다시 판정한다. 압축되더라도 `show` 의 `current` 가 `qa` 라 끝나지 않은 재검증이 보인다. 이 순환은 3회까지다.
   - 의도한 차이(목업 뒤에 합의한 변경): `intended: true` 로 적고 `checklist` 에 "의도한 차이 확인" 을 넣는다. `intended` 는 연쇄가 정한다.
   - 3회 뒤에도 남으면 `checklist` 에 넣고 다음 단계로 간다. 통과로 적지 않는다.
5. 찍지 못한 화면 상태는 `checklist` 에 넣는다.
6. 게이트: 기계 대조와 시각 판정이 모두 끝났다. 사람이 볼 것은 취향, 의도한 차이, 미검증뿐이다.

## 8. 과정 시각화

```bash
node "<S>/references/chain-report.mjs" "<run>"
```

- `<run>/index.html` 을 만든다. 외부 자원 없는 단일 파일이고, 모든 글을 escape 하며 실행 폴더 밖으로 링크하지 않는다.
- 내용: 사람이 볼 것(맨 위), 단계별 상태와 걸린 시간, 검토 판정과 검토자별 판정, 이 머신과 박스의 시험 표, 목업과 실제를 나란히 놓은 시각 검토, 산출물, 전체 기록.
- 단계 하나가 끝날 때마다 다시 만들어도 된다. 9단계 전에는 반드시 다시 만든다.

## 9. 결과 공유

1. 미리보기 서버를 4단계와 같은 방법으로 loopback 으로 띄운다(이미 떠 있으면 주소만 나온다). 안내할 주소는 `PREVIEW` 주소 그대로다. 루트가 보고서(`index.html`)다. 같은 망 공개를 다시 원하면 3의 검사(텍스트 0건, PNG 사용자 확인)를 거친 뒤 4단계 규칙대로 연다(사설 IP 하나, 다 보면 `--stop`).
2. 아래 최종 보고를 대화에 낸다. 마지막 줄에 공유 선택지를 둔다. 기본은 로컬만이고, 사용자가 고를 때만 실행한다.
   - 대화 기록 HTML: Claude Code 에서만 `banker:lineage`(Codex 기록은 읽지 못함). 비용이 크다
   - 커밋 메시지와 PR 본문 초안 파일을 실행 폴더에 만들기
   - 커밋, push, PR 생성, 외부 게시: 사용자가 명시적으로 요청할 때만
3. 밖으로 나가는 파일은 보내기 전에 하나씩 `node "<scan>" "<파일>"` 로 비밀처럼 보이는 문자열을 찾는다. 출력 JSON 의 `count` 가 0 이고 종료 코드가 0 일 때만 내보낸다. 이미지(캡처 PNG)는 이 검사로 볼 수 없으니, 화면에 비밀이 찍히지 않았는지 사용자에게 확인받는다.
4. 서버는 사용자가 볼 수 있게 남겨 두고 끄는 명령을 알린다: `node "<S>/references/serve.mjs" --stop "<run>"`. Codex 는 세션을 닫으면 서버가 끝날 수 있으니, 사용자 터미널에서 다시 띄우는 명령(`node "<S>/references/serve.mjs" "<run>"`)도 알린다. 앱 서버처럼 연쇄가 띄운 다른 작업은 모두 멈춘다. 게이트 기록 폴더는 `node "<rq>/seat-run.mjs" cleanup --dir "<g>"` 로 지운다. 기록의 보기는 `qa/local-r<k>.md` 에 남아 있다.
5. `share` 의 끝을 기록하고 보고서를 마지막으로 다시 만든다.

## 최종 보고

1. 첫 줄: 결론(완료 또는 어느 단계에서 멈춤)과 사람이 볼 것의 수.
2. 단계 표: 단계, 결과, 핵심 근거(판정, 시험 수, 점수) 한 줄씩.
3. 검증 선언
   - 3단계와 6단계의 ralph-qa 판정 줄과 선언 블록(좌석, 모델, 물려받은 강도)을 `03-ralph-qa.md`, `qa/ralph-qa-r<k>.md` 에서 줄이지 않고 옮긴다
   - OS 표: 이 머신과 박스마다 통과, 실패, 미검증
4. 사람이 볼 것: 번호 목록. 왜 사람이 봐야 하는지 한 줄씩.
5. 미검증과 남은 일: 확인하지 못한 OS, 돌리지 못한 시험, 기록만 한 비차단 지적.
6. 바꾼 것: 스테이징한 파일 목록(커밋하지 않았음), 로컬 제외 파일에 넣은 줄, 만든 브랜치.
7. 보고서 URL 과 실행 폴더 경로.
8. 마지막 줄: 사용자가 고를 다음 행동과 공유 선택지.

## 이어 하기

압축(compaction)이나 중단 뒤에는 다음 순서로 잇는다.

1. 이 스킬을 다시 부른다: `--run=<실행 폴더> --from=<단계>`(Claude Code `Skill("banker:ultra-chain")`, Codex `$banker-ultra-chain`, 플러그인 설치면 `$banker:ultra-chain`). 지시와 `<S>` 를 되찾기 위해서다. 실행 폴더는 이어 하기 메모나 압축 요약에서 찾는다.
2. `node "<S>/references/chain-ledger.mjs" show "<run>"` 로 `current`(다시 시작할 단계), 단계별 `lastVerdict`(마지막 판정과 blocker), `maxRound` 를 본다. 멈추거나 실패한 실행은 그 단계가 `current` 다. 원래 플래그는 `task.md` 첫 줄과 `preflight` 기록에 있다.
3. 끊길 때 돌던 작업(박스 시험, 검토 좌석, 서버)이 끝났는지 확인한다. 끝나지 않았으면 알림을 기다리거나 멈춘다. 끊기기 전 실행의 늦은 판정은 쓰지 않는다.
4. 돌던 ralph-qa 실행은 되살리지 않는다. 좌석과 끈끈한 반대는 한 실행 안에서만 유지되기 때문이다.
   - 끊긴 실행을 `note` 로 `INCONCLUSIVE`(압축으로 좌석 상실)로 기록한다. 이 기록의 `verdict.blockers` 에 앞 판정의 blocker 를 좌석 id 와 함께 그대로 옮겨 적는다. 그래야 다시 압축돼도 `show` 의 `lastVerdict` 에서 되찾는다.
   - 새 실행을 한 번만 연다. 앞 실행의 `blockers` 는 낸 좌석과 함께 `AC-carry-1`, `AC-carry-2` 처럼 수용 기준에 넣는다. 저자의 "고쳤다" 는 그 수용 기준을 풀지 못한다. 새 실행의 판정으로만 풀린다.
   - 새 실행도 `INCONCLUSIVE` 면 멈추고 사람의 판단을 받는다.
5. 회차는 `maxRound` 다음 번호로 이어 센다. 앞 회차 파일을 덮어쓰지 않는다. `--max` 는 남은 횟수만 쓴다.
6. 판정이 없는 회차(그 번호의 시험이나 박스 기록은 있는데 같은 번호의 판정 기록이 없음)는 새 번호로, 지금 트리로 시험부터 다시 한다.
7. 5단계에서 이을 때
   - `05-baseline.md` 는 다시 쓰지 않는다. 이미 바뀐 트리로 쓰면 이번 변경이 만든 실패가 기존 실패로 바뀐다. 반복 0 게이트 기록도 다시 돌리지 않는다. `<g>` 는 `05-baseline.md` 첫 줄에서 되찾는다.
   - 이 판보다 먼저 시작한 실행 폴더에는 기준선이 `05-baseline.txt` 로 있다. `05-baseline.md` 가 없으면 그 파일을 기준선으로 쓴다.
   - 같은 세션에서 ralph 가 아직 켜져 있으면 다시 부르지 않고 끝나기를 기다린다.
   - 새 세션에서 ralph 를 다시 부르면 ralph 는 지금 트리로 기준선을 다시 기록한다. 이 사실을 `build` 의 `note` 에 적고, 새 실패의 판정은 `05-baseline.md` 기준으로 한다.

## 플래그

| 플래그 | 효과 | 기본 |
|---|---|---|
| `--agents=N` | 3단계와 6단계 ralph-qa 의 내부 검토자 수(3 이상) | 3 |
| `--codex`, `--gemini`, `--opencode` | ralph-qa 의 외부 좌석. 값이 있으면 그 모델 | 없음 |
| `--boxes=all\|none\|<이름,...>` | 6단계에 쓸 박스. 이름은 쉼표로 잇고, 명령에는 `--box <이름>` 으로 하나씩 붙인다 | all(등록되고 접속되는 것) |
| `--skip=<단계,...>` | `research`, `mock`, `visual` 만 건너뛸 수 있다. `skipped` 와 이유를 기록한다. `mock` 을 건너뛰면 사람 승인 없이 구현하고 `checklist` 에 남긴다. `visual` 을 건너뛰면 기계 대조도 하지 않고 `checklist` 에 남긴다 | 없음 |
| `--run=<폴더> --from=<단계>` | 그 실행 폴더에서 그 단계부터 이어 함 | 새 실행 |
| `--auto` | 사람에게 묻지 않는다. 사람이 보는 곳 표의 `--auto` 열대로 하고, 묻지 않고 지나간 것은 모두 `checklist` 에 남긴다 | 꺼짐 |
| `--max=N` | 3단계와 6단계 ralph-qa, Codex critic 루프의 최대 회차 | 5 |

## 멈추는 조건

- 0단계: 세션 폴더가 저장소 루트가 아님, OMC 또는 OMX 점검 실패, 사용자가 진행을 거부, `--auto` 에서 커밋 안 한 변경이나 의존성 없음.
- 2단계: 진전 없이 2회, `--auto` 에서 보수적인 쪽이 없는 핵심 P.
- 3단계: ralplan 5회 무합의, ralph-qa `INCONCLUSIVE` 나 한도 소진.
- 4단계: 사용자가 `멈춤` 을 고름.
- 5단계: ralph 근본 차단, Codex critic 이 `<max>` 회 안에 승인하지 않음.
- 6단계: ralph-qa `INCONCLUSIVE` 나 한도 소진.
- 사용자가 멈추라고 하면 켜진 모드를 끄고(런타임 대응 표) `stopped` 와 이유를 기록한다.

멈출 때는 `stopped` 나 `failed` 와 `reason` 을 기록하고, 8단계 보고서를 만들고 최종 보고를 낸다. 이때 `trace` 는 기록하지 않고 보고서만 만든다. 기록하면 멈춘 실행이 다시 진행 중으로 보인다. `--auto` 면 묻는 대신 이렇게 멈춘다. 끝내지 못한 단계는 통과로 적지 않는다.

STOPPED 뒤에는 한 줄 수정을 포함해 어떤 파일도 고치지 않는다. 사용자가 새로 지시할 때까지 보고만 한다. 이 스킬의 어떤 문구("한 줄 수정은 `ralph`" 안내 포함)도 멈춘 뒤의 수정을 허락하지 않는다. 8단계 보고서와 실행 기록 쓰기는 예외다.

## 함정

- ralplan 의 Architect 와 Critic 은 둘이다. 이 둘을 "검토자 3명" 으로 세지 않는다. 3명 이상은 3단계 4의 ralph-qa 가 채운다.
- ralph-qa 의 검토자는 시험을 돌리지 않는다. 로컬 게이트는 실행기 기록, OS 는 박스 결과가 증거다. 박스 결과 없이 판정받으면 OS 검증이 빠진다.
- 반복 0 기준선을 구현 뒤 트리에서 돌리면 이번 변경이 만든 실패가 기준선 실패로 갈려 게이트가 통과한다. 반복 0 은 5단계 1에서만 돌린다.
- 추적하지 않는 새 파일은 박스로 가지 않는다. 6단계 1의 스테이징을 빼먹으면 새 시험이 박스에서 돌지 않는다.
- 박스 결과 JSON 은 실행이 끝날 때 한 번 써진다. 끝나기 전에 `chain-ledger.mjs boxes` 를 돌리면 빈 파일이라 실패한다.
- 피드백 명령의 `grep -Ev` 꼴을 시험 게이트에 쓰면 성공과 실패가 뒤집힌다. 그 꼴은 ralph 의 피드백 명령에만 쓴다.
- `audit-mock` 은 목업 도구가 아니다. 코드의 가짜 데이터와 하드코딩을 찾는 감사 도구다.
- Codex 의 OMX 에는 `visual-verdict` 가 없다(폐기). 7단계 3의 판정 에이전트를 쓴다.
- `lineage` 는 Claude Code 기록만 읽는다. Codex 세션의 과정은 실행 기록과 8단계 보고서가 전부다.
- 미리보기 서버를 `pkill` 같은 명령줄 패턴으로 끄지 않는다. `serve.mjs --stop` 은 상태 파일의 PID 가 그 서버일 때만 끈다.
- 실행 폴더가 git 에 무시되지 않으면 산출물이 커밋에 섞인다. `init` 결과의 `ignored`, `excluded`, `excludeError` 를 확인한다.
- Windows PowerShell 5.1 의 `>` 는 UTF-16 으로 쓴다. 기록 스크립트는 그 파일도 읽지만, 다른 도구로 읽을 파일은 `Out-File -Encoding utf8` 로 쓴다.
- 검토 diff 의 기준을 `HEAD` 로 두면, 기존 변경을 두고 진행한 실행에서 사용자의 무관한 변경이 검토(외부 좌석 포함)로 간다. 늘 `<base>` 를 쓴다.

ARGUMENTS: [--agents=N] [--codex[=<model>]] [--gemini[=<model>]] [--opencode[=<provider/model>]] [--boxes=all|none|<이름,...>] [--skip=<단계,...>] [--run=<실행 폴더> --from=<단계>] [--auto] [--max=N] <작업 설명>
