# progress-mon

프로젝트 진척도를 4탭 웹 화면(진척도, 구현요건, workflow, 구성도)으로 보이는 스킬. 사용 절차는 `SKILL.md`.
이 폴더 하나를 banker 의 `skills/progress-mon/` 으로 그대로 옮긴다.

## 구조

| 경로 | 역할 |
|---|---|
| `SKILL.md` | frontmatter `name`, `description` 만. 인자 없는 호출 절차, 하위 명령, init 절차, 런타임 표 |
| `README.md` | 이 문서. 구조, 시험, banker 통합 메모, 넘김 요청문 |
| `scripts/progress-mon.mjs` | CLI 진입. 인자 해석, 런타임 판별, 하위 명령 분기, `--help`, 종료 코드. 자료 폴더가 있으면 `state.json` 의 `skillDir` 갱신 |
| `scripts/pm-config.mjs` | 프로젝트 루트와 자료 폴더 결정, `config.json` 읽기, 기본값, 형식 검사, 원자적 쓰기(임시 파일과 rename, Windows 재시도) |
| `scripts/pm-sources.mjs` | events.jsonl, git log, 워크플로 journal, `items.json` 읽기. 스토리와 라벨 판정 함수, 시각 해석, 읽기 캐시 |
| `scripts/pm-html.mjs` | escape, 색 검사, 유한 수 검사, 글 폭 추정, 줄바꿈, 공통 CSS, 탭 머리 |
| `scripts/pm-render.mjs` | 4탭, 단일 HTML 스냅숏(`export`), workflow 배치, 구성도 자동 배치 |
| `scripts/pm-server.mjs` | `serve`, `start`, `stop`, `status`. 바인드, Host 검사, 신원 경로, 상태 파일, 포트 선택, 로그 |
| `scripts/pm-data.mjs` | `init`, `item`, `note`, `stage`, `story`(`items.json` 잠금과 낡은 잠금 정리) |
| `scripts/pm-memory.mjs` | 메모리 규칙 등록, 규칙 로드 한도 측정 |
| `scripts/pm-check.mjs` | 자료 형식, 상호 참조, 구성도와 workflow 기하, 밀도 검사 |
| `scripts/index.js` | `node --test <폴더>/` 진입 로더. 모든 `*.test.mjs` 적재, 마지막 시험 `all <n> test files loaded` |
| `scripts/*.test.mjs` | 모듈별 시험. 시험마다 `timeout: 60000` |
| `references/` | `config.md`, `items.md`, `req-spec.md`, `reqs.md`, `flow.md`, `arch.md`(스키마와 판정 규칙), `authoring.md`(init 작성 지침, 밀도 기준), `inventory.md` |
| `assets/fixture/` | 형식 시험용 최소 자료와 변형(`variants/`). 화면 수준의 견본이 아님 |

- 의존성: Node 18 이상 내장 모듈만. npm 의존 0
- 인코딩: UTF-8, BOM 없음, LF. 숨은 문자는 escape(`\u{...}`)로만
- 파일 이름 접두 `pm-`: banker 의 `hooks/progress*.mjs` 와 겹치지 않게

## 시험

| 셸 | 명령 |
|---|---|
| cmd | `set CI=true&& node --test --test-reporter=tap skills/progress-mon/scripts/` |
| POSIX | `CI=true node --test --test-reporter=tap skills/progress-mon/scripts/` |

- 경로는 banker 저장소 기준. 원본 폴더(`skills-dev/`)에서는 그 경로로 바꾼다
- 폴더 인자: Node 24 는 폴더를 모듈로 풀어 `scripts/index.js` 를 적재한다. 판정은 `# fail 0` 과 `all <n> test files loaded` 시험 ok
- Node 18 은 폴더를 모듈로 풀지 않고 시험 파일을 직접 찾는다. 시험은 모두 돌고 `all <n> test files loaded` 시험 하나만 없다
- 시험은 임시 HOME, 임시 프로젝트, OS 가 고른 빈 포트에서 돈다. 포트 30000, 3456, 3458 은 쓰지 않는다
- 시험은 PATH 의 `git` 으로 임시 저장소를 만든다. git 이 없는 PC 에서는 그 시험 10개가 실패한다(2026-10-30, PATH 에 node 와 mkfifo 만 두고 실측). 스킬 자체는 git 이 없으면 커밋 기록 없이 동작
- FIFO 와 `/dev/zero` 시험은 POSIX 만. Windows 에서는 이유를 밝히고 건너뛴다

## 개발

- 내부용 `serve`: `start` 와 같은 인자로 서버를 앞에서 실행(시험, 디버그, Codex 사용자 터미널 안내). `--help` 에는 나오지 않는다
- 시험 전용 환경 변수 `PROGRESS_MON_NOW`(ISO 시각): `serve` 가 요청마다 렌더에 넘기는 시각을 고정
- `PM_TEST_PRIVATE_IP=<이 PC 사설 IPv4>`: 있으면 사설 주소 바인드 시험을 실제로 돌린다. 없으면 그 시험은 TAP 진단 줄만 남기고 사설 바인드는 미검증
  - cmd 예: `set PM_TEST_PRIVATE_IP=10.0.0.5&& set CI=true&& node --test --test-reporter=tap skills-dev/progress-mon/scripts/`

## 대상 OS

2026-10-30 banker 테스트박스 실측(시험 188개).

| 대상 | 상태 |
|---|---|
| Windows 10 x64 | 확인. 187 통과, 1 건너뜀(FIFO 와 `/dev/zero` 는 POSIX 만) |
| macOS | 확인. 188/188 |
| Linux(Rocky8, Node 22) | 확인. 188/188 |
| Node 18(v18.20.8, Rocky8) | 확인. 187/187. 폴더 진입 로더 확인 시험 1개는 Node 18 에 해당 없음 |
| 사설 IP 바인드(`PM_TEST_PRIVATE_IP`) | Linux PC 에서만 확인. 박스 주소가 사설 대역이 아니라 박스에서는 미검증 |

## 보안 요약

- 기본 바인드 127.0.0.1. `--host` 는 사설 IPv4 만, 경고 한 줄. `0.0.0.0`, `::`, 공인, 링크 로컬, 100.64/10, 이름 거부
- Host 헤더 정확 일치 허용 목록, 그 밖 403. `GET`, `HEAD` 만(그 밖 405). `/`, `/index.html`, 신원 경로만(그 밖 404)
- 자료 폴더 파일(`server.json` 포함)은 서빙하지 않는다. 오류 응답은 일반 문구만, 스택은 `server.log` 에만
- 응답 머리: `cache-control: no-store`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:`
- `stop` 은 상태 파일 PID 와 신원 응답 PID 가 같을 때만
- 자료 폴더나 그 위 `.omc`, `.omx` 가 링크면 모든 명령을 거부한다(저장소가 심은 링크로 밖에 쓰거나 지우지 않게)
- `server.log` 가 링크, 특수 파일, 하드링크면 쓰지도 비우지도 않고, 기록이 멈춘 것을 status 경고로 한 번 알린다. 자료 파일(`config.json` 등)은 링크를 따라 읽되 일반 파일만 읽는다. 메모리 대상은 프로젝트(또는 `--memory-dir`) 밖을 가리키는 링크와 하드링크를 거부한다

## Codex override 가려짐 해소

`AGENTS.override.md` 에 공백 아닌 글이 있으면 Codex 는 그 파일을 읽고 `AGENTS.md` 를 읽지 않는다. `init --memory agents-md` 는 규칙이 실제로 읽히도록 그 override 에 쓴다.
override 에 banker 블록이나 이 스킬 블록만 있으면 `init`, `status`, `check` 가 "AGENTS.override.md 에 블록만 있어 AGENTS.md 가 가려짐" 경고를 낸다. 해소 방법은 둘 중 하나.

- `AGENTS.md` 의 지시를 `AGENTS.override.md` 로 옮긴다(override 를 계속 씀)
- `AGENTS.override.md` 에서 블록을 지우고 파일이 비면 지운 뒤 `init --runtime codex --memory agents-md` 를 다시 실행한다(`AGENTS.md` 에 등록)

## banker 통합 메모

아래는 banker 에 넣기 전에 쓴 초안이다. 통합은 끝났다(banker 의 `codex/manifest.json`, `scripts/smoke-test.js`, `hooks/progress.test.mjs`, README 스킬 표).
통합 뒤 이 폴더에서 고친 것(링크와 특수 파일 거부, 정규식 시간 상한, 실행 중 config 반영, start 잠금 등)은 banker 계획 문서 31절에 있다.

### `/banker:progress` 와 차이

| 항목 | `/banker:progress` | `/banker:progress-mon` |
|---|---|---|
| 종류 | 명령(`commands/progress.md`)과 훅 | 스킬 |
| 보이는 곳 | Claude Mods 패널(세션 작업 목록) | 브라우저(로컬 포트 서버, 4탭) |
| 런타임 | mod 를 지원하는 Claude Code 만 | Claude Code 와 Codex |
| 서버 | 없음 | 있음(127.0.0.1 기본) |

- `hooks/hooks.json` 의 `UserPromptExpansion` matcher `^banker:progress$` 는 끝이 고정이라 `banker:progress-mon` 을 가로채지 않는다

### manifest

`codex/manifest.json` 의 `surfaces` 에 넣을 항목 초안:

```json
{ "name": "progress-mon", "type": "skill", "target": "both",
  "reason": "project progress web screen with four tabs (progress, requirements, workflow, architecture) on a local server; init reads the code and writes the tab data, registers a one-line update rule in project memory; item, note, stage, story keep it current; pure Node, no deps",
  "supportingFiles": ["README.md", "references/arch.md", "references/authoring.md", "references/config.md", "references/flow.md", "references/inventory.md", "references/items.md", "references/req-spec.md", "references/reqs.md", "scripts/index.js", "scripts/pm-check.mjs", "scripts/pm-config.mjs", "scripts/pm-data.mjs", "scripts/pm-html.mjs", "scripts/pm-memory.mjs", "scripts/pm-render.mjs", "scripts/pm-server.mjs", "scripts/pm-sources.mjs", "scripts/progress-mon.mjs", "assets/fixture/README.md", "assets/fixture/config.json", "assets/fixture/events.jsonl", "assets/fixture/items.json", "assets/fixture/commits.json", "assets/fixture/req-spec.json", "assets/fixture/reqs.json", "assets/fixture/flow.json", "assets/fixture/arch.json", "assets/fixture/workflows/wf_ex1/journal.jsonl", "assets/fixture/workflows/wf_ex1/agent-a01.jsonl", "assets/fixture/workflows/wf_ex1/agent-a02.jsonl", "assets/fixture/workflows/wf_ex1/agent-a03.jsonl", "assets/fixture/workflows/wf_ex1/agent-a04.jsonl", "assets/fixture/variants/arch-auto/arch.json", "assets/fixture/variants/check-auto/arch.json", "assets/fixture/variants/check-overlap/arch.json", "assets/fixture/variants/history-manual/config.json", "assets/fixture/variants/history-manual/items.json", "assets/fixture/variants/workflow-wide/flow.json"],
  "caveat": "needs Node 18 or later (above the package engines floor); binds 127.0.0.1 only by default, --host takes a private IPv4 with a warning; data lives in .omc/progress-mon/ (Codex .omx/progress-mon/); on Codex start, stop, status and init each ask for sandbox_permissions require_escalated, and a long-lived screen runs from the user's terminal (serve) since closing the session may stop the server" }
```

### Codex 변환

- 설치 위치 `~/.codex/skills/banker-progress-mon/`, frontmatter `name: banker-progress-mon`
- SKILL.md 런타임 표의 Codex 열이 이 경로를 쓴다

### package

- `package.json` `files` 의 `skills` 에 포함된다. `!**/*.test.mjs` 로 시험 파일은 빠지고 `scripts/index.js` 는 실린다
- `engines`(`>=16.7.0`)보다 높은 Node 18 요구는 manifest `caveat` 에 적었다

### 전역 시험

- banker `scripts/hidden-chars.test.mjs`(숨은 문자 0)와 `scripts/powershell-syntax.test.mjs`(PowerShell 블록 5.1 구문)를 통과하도록 썼다. 이 폴더의 문서에는 PowerShell 코드 블록이 없다

### SKILL.md 표식 줄

- 본문의 평문 한 줄 `progress-mon skill body marker v1` 은 지우지 않는다
- 이유: 실제 스킬 호출 시운전이 이 줄로 본문 전개를 확인했다. 넘긴 파일과 그 증거가 같아야 한다

### 이름 충돌 기록

banker 0.20.5 설치본(파일 239개)과 비교한 결과.

| 비교 | 결과 |
|---|---|
| 파일 이름이 `pm-` 또는 `progress-mon` 으로 시작하는 banker 파일 | 0 |
| 이 폴더의 파일 이름과 같은 banker 파일 이름(`pm-*`, `progress-mon*`) | 0 |
| banker 스킬 63개 이름과 `progress-mon` | 겹침 0 |
| banker 명령 3개(`front-qa`, `progress`, `setup`)와 `progress-mon` | 겹침 0 |
| banker 의 `progress` 로 시작하는 파일 | `commands/progress.md`, `hooks/progress.mjs`, `hooks/progress-plan.mjs`, `hooks/progress-fallback.mjs`, 그 시험 3개. 모두 `progress-mon` 과 이름이 다름 |

### argument-hint

- 넣지 않았다. frontmatter 는 `name`, `description` 만이 이 스킬의 수용 기준이다
- banker SKILL.md 63개 가운데 13개만 `argument-hint` 를 쓴다. banker 쪽 판단으로 추가할 수 있다

## 넘김 요청문

banker 플러그인 개발 세션에 붙여 넣는 글.

```
banker 플러그인에 새 스킬 progress-mon 을 넣어 주세요.

- 원본: 함께 준 폴더 progress-mon/ 하나. skills/progress-mon/ 으로 그대로 복사
- 스크립트와 시험은 고치지 않음. 시험이 banker 환경에서 실패할 때만 고치고, 고친 내용을 알려 주세요
- 할 일
  - codex/manifest.json surfaces 에 README.md 의 항목 초안 추가
  - LIST.md, README.md, CHANGELOG.md, skill-changes.json 을 banker 관례대로 갱신
  - 버전 올림은 RELEASING.md 절차
- 확인
  - node --test skills/progress-mon/scripts/ 통과
  - scripts/hidden-chars.test.mjs, scripts/powershell-syntax.test.mjs 통과
  - banker setup --codex 뒤 ~/.codex/skills/banker-progress-mon/SKILL.md 의 name 이 banker-progress-mon
  - /banker:progress 와 /banker:progress-mon 이 서로 가로채지 않음
  - 기존 파일 이름과 겹침 없음(README.md 기록 참고)
- 대상 OS: Windows 10 x64 확인, macOS 와 Linux 는 미검증
```
