# config.json

자료 폴더(`.omc/progress-mon/`, Codex `.omx/progress-mon/`)의 설정 파일. `init` 이 기본값으로 만들고, 있으면 그대로 둔다.
형식이 틀린 칸은 기본값으로 읽고 `check` 가 `FAIL config.json <경로> <이유>` 로 알린다. `start`, `export` 는 형식 오류가 있으면 종료 1.

실행 중 서버는 요청마다 `config.json` 을 보고, 바뀌었으면 다시 읽는다. 그래서 `stories`, `commitRegex`, `title` 같은 값은 다음 응답에 반영된다. 형식 오류가 생기면 화면은 오류 목록을 보이고, 고치면 돌아온다.
`port`, `portStrict`, `hosts` 만은 서버를 다시 띄워야 적용된다(`stop` 뒤 `start`). 바뀐 채로 서버가 떠 있으면 `status` 가 경고 줄을 낸다.

## 키

| 키 | 형식 | 기본 | 뜻 |
|---|---|---|---|
| `schema` | 1 | 1 | 형식 판 |
| `title` | 빈 문자열이 아닌 문자열 | `<폴더 이름> 진척도` | 화면 제목(h1) |
| `shortName` | 빈 문자열이 아닌 문자열 | 폴더 이름 | 탭 제목, 구성도 그림 이름. init 절차에서 `title` 과 함께 정한다(폴더 이름이 프로젝트 이름과 다를 때가 많음) |
| `port` | 1024~65535 정수 | 30000 | `start` 의 첫 포트. 차 있으면 다음 빈 포트(최대 +99). 0(OS 선택)은 받지 않음(아래 "포트와 주소") |
| `portStrict` | 참, 거짓 | 거짓 | 참이면 `--port-strict` 와 같음. 포트가 차 있으면 다른 포트로 비켜 가지 않고 종료 1 |
| `hosts` | 사설 IPv4 목록 | `[]` | 127.0.0.1 에 더해 바인드할 주소. `start --host <ip>` 가 저장 |
| `refreshSec` | 5~3600 정수 | 30 | 진척도, 구현요건 탭 자동 갱신 간격(초) |
| `stages` | `"auto"` 또는 `[{id, label}]` | `"auto"` | 단계 목록. `"auto"` 는 events 출처가 있으면 ultra-chain 10단계, 없으면 빈 목록 |
| `stories` | `[{id, name}]` | `[]` | 스토리 목록(순서대로 표시). 비면 스토리 판정, 스토리 표, 진척률을 생략 |
| `commitRegex` | 정규식 문자열, 이름 그룹 `id` | 없음 | 커밋 제목의 스토리 판정을 바꿈 |
| `agentLabelPattern` | 정규식 문자열, 캡처 그룹 없음 | 없음 | 진행 중 에이전트 라벨의 스토리 판정을 바꿈 |
| `sources.events` | `"auto"`, 경로, `null` | `"auto"` | ultra-chain 실행 기록. `"auto"` 는 `<project>/.omc/ultra-chain/*/events.jsonl`(Codex `.omx`) 가운데 수정 시각 최신. 상대 경로는 프로젝트 루트 기준. `null` 은 읽지 않음 |
| `sources.git` | 참, 거짓 | 참 | git log 읽기 |
| `sources.gitMax` | 양의 정수 | 5000 | 읽는 커밋 수 상한 |
| `sources.workflowDirs` | `"auto"` 또는 경로 목록 | Claude Code `"auto"`, Codex `[]` | Claude Code 워크플로 journal 루트 목록 |
| `sources.agentStaleMin` | 양의 정수 | 15 | 이 분 넘게 멈춘 에이전트 파일은 진행 중에서 뺌 |
| `sources.journalMaxAgeH` | 양의 정수 | 24 | 이 시간 넘게 멈춘 journal 은 진행 중 스캔에서 뺌 |
| `sources.journalMaxSessions` | 0 이상 정수 | 20 | 진행 중 스캔에 쓰는 최근 루트 수. 0 은 상한 없음 |
| `text.reqRule` | 문자열 | 일반 판정 설명 | 구현요건 탭 머리의 판정 규칙 문구. 기본 문구 그대로이고 담당 스토리 칸이 없으면(스토리가 없고 AC 에 담당 스토리도 없음) 명세의 `state` 로 판정한다는 문구가 대신 보임 |
| `text.plannedPrefix` | 문자열 | `예정` | 구성도 칩에서 예정(아직 구현 안 됨)을 뜻하는 접두 |

- 모르는 키는 무시한다
- `stages`, `stories` 의 id 는 겹치면 안 된다
- 단계 행과 스토리 행은 `stage`, `story` 명령으로도 늘어난다(설정에 없는 id 는 처음 나온 순서로 뒤에 붙음)

## workflowDirs

- 경로 하나는 workflows 루트. 그 아래 실행 폴더마다 `journal.jsonl`, `agent-<id>.jsonl` 이 있다
- `"auto"` 는 `CLAUDE_CONFIG_DIR` 또는 `~/.claude` 의 `projects/<slug>/<세션>/subagents/workflows` 를 읽기만 한다
  - slug: 프로젝트 절대 경로에서 영문자와 숫자 밖의 글자를 `-` 로 바꾼 것. 대소문자 무시로 비교
  - 찾은 루트가 0개면 `status`, `check` 가 `WARN workflowDirs auto: 찾은 폴더 0`
- `WARN workflowDirs auto: 찾은 폴더 0` 은 Claude Code 워크플로를 이 프로젝트에서 아직 돌리지 않았으면 정상이다. 실패가 아니고 종료 코드에 영향이 없다
  - 이 WARN 을 끄려면 `"sources": { "workflowDirs": [] }`. 빈 목록은 journal 을 읽지 않는다. 진행 중 에이전트 행과 에이전트 라벨의 스토리 시작 시각도 사라진다
  - 나중에 워크플로를 쓰면 `"auto"` 로 되돌린다
- 스토리 시작 시각은 상한 없이 모든 루트에서, 진행 중 에이전트는 `journalMaxSessions`, `journalMaxAgeH`, `agentStaleMin` 안에서 찾는다

## 스토리 판정

| 쓰는 곳 | 규칙(기본) | 설정으로 바꿈 |
|---|---|---|
| 커밋 제목 | 설정 id 를 긴 것부터 보아, 제목이 id 로 시작하고 뒤가 `:`, `(`, 공백이거나 소문자 한 자 뒤 `:`, `(`, 공백 | `commitRegex` 의 그룹 `id` 값이 설정 id 와 같을 때 |
| 스토리 시작 시각(에이전트 라벨) | 라벨을 `-` 로 나눈 토큰을 왼쪽부터 보아 id 와 정확히 같은 첫 토큰 | 없음 |
| 진행 중 스토리(에이전트 라벨) | 토큰을 왼쪽부터 보아 처음 맞는 토큰에서 멈춤. 토큰이 id 로 시작하고 바로 뒤가 끝이거나 숫자가 아니면 맞음. 같은 토큰에 맞는 id 가 둘 이상이면 긴 id | `agentLabelPattern` 의 첫 일치 값이 설정 id 와 같을 때 |
| 에이전트 행 숨김 | 진행 중 스토리로 잡힌 라벨만 숨김 | `agentLabelPattern` 이 있으면 일치가 있는 라벨은 스토리가 아니어도 숨김 |

- 예: 스토리 `A1`, `A2` 의 커밋 제목 `A1: 화면`, `A2(1/2): 설정`, `A2b: 보충` 은 각각 A1, A2, A2
- `stories` 가 비고 `story` 로 더한 것도 없으면 판정을 끈다
- id 는 정규식으로 만들 때 escape 한다(`A.1` 같은 id 도 안전)
- 제약
  - id 에 `-` 가 들어 있으면 토큰 판정이 안 된다. `check` 가 WARN. id 를 바꾸거나 `agentLabelPattern` 을 쓴다
  - 글자로 끝나는 id 는 넓게 잡힌다. id `auth` 는 토큰 `author` 에 맞는다(뒤 글자가 숫자가 아님). 이런 id 를 쓰면 `agentLabelPattern` 을 권한다
- `commitRegex`, `agentLabelPattern` 은 컴파일 검사를 거친다. 실패, `commitRegex` 의 `(?<id>` 없음, `agentLabelPattern` 의 캡처 그룹 있음은 FAIL

`commitRegex` 예(제목 `feat(A3): ...`):

```json
{ "commitRegex": "^\\w+\\((?<id>A\\d+)\\):" }
```

`agentLabelPattern` 예(라벨 `impl-A12-r1` 의 `A12`):

```json
{ "agentLabelPattern": "A\\d+" }
```

## 예

```json
{
  "schema": 1,
  "title": "예시 앱 진척도",
  "shortName": "example-app",
  "port": 30000,
  "refreshSec": 30,
  "stages": "auto",
  "stories": [
    { "id": "A1", "name": "기본 화면" },
    { "id": "A2", "name": "설정 읽기" }
  ],
  "sources": { "events": "auto", "git": true, "workflowDirs": "auto" },
  "text": { "plannedPrefix": "예정" }
}
```

## 포트와 주소

- 바인드: 127.0.0.1 을 포트 P 에. `EADDRINUSE` 면 P+1(최대 +99, strict 면 종료 1). 추가 주소(`hosts`, `--host`)는 같은 포트에
- 포트 0(OS 선택)은 `--port`, `port` 모두 받지 않는다(1024~65535). 포트를 고르는 법

  | 경우 | 할 일 |
  |---|---|
  | 보통 | `--port` 를 빼고 `start`. `port`(기본 30000)부터 빈 포트를 찾아 쓰고 출력 URL 에 실제 포트가 나온다 |
  | 정해진 포트 범위를 피해야 함(시험, 다른 서버) | OS 가 고른 빈 포트를 먼저 얻어 `--port` 로 넘긴다(아래 명령) |
  | 늘 같은 포트여야 함(방화벽 규칙) | `port` 를 정하고 `portStrict: true` |

  ```
  node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
  ```

  - 출력이 1024 미만이면 다시 실행한다
  - 얻은 포트를 그 사이 다른 프로세스가 잡으면 `start` 는 다음 빈 포트로 비켜 가고 알림 줄을 낸다. URL 은 `start` 출력의 것을 쓴다
- 추가 주소가 인터페이스에 없을 때: 이번 `--host` 면 종료 1, `hosts` 에서 온 주소면 그 주소만 경고하고 127.0.0.1 로 계속
- 재사용: 상태 파일 PID 와 신원 응답 PID 가 같으면 이 프로젝트 서버. `--host` 가 실행 중 주소와 다르거나, strict 인데 실행 중 포트가 요청 포트와 다르면 종료 1("stop 먼저")
