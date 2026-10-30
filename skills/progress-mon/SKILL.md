---
name: progress-mon
description: "프로젝트 진척도를 4탭 웹 화면(진척도, 구현요건, workflow, 구성도)으로 로컬 서버(기본 127.0.0.1:30000)에 띄움. 인자 없이 부르면 자료 폴더가 없을 때 init(코드를 읽어 4탭 자료를 쓰고 갱신 규칙 등록), 서버가 꺼져 있으면 start, 켜져 있으면 URL 보고. 하위 명령 init, start, stop, status, export, item, note, stage, story, check. 'progress-mon'/'진척도 화면'/'진척도 서버'/'진행 현황 웹 화면' 시 사용. 세션 작업 목록 패널은 이 스킬 대신 progress(Claude Code `/banker:progress`, Codex `$banker-progress`)."
---

# progress-mon: 프로젝트 진척도 웹 화면

프로젝트의 진척도를 4탭 웹 화면으로 보인다. 서버는 Node 내장 모듈만 쓰고 기본으로 127.0.0.1 에만 바인드한다.
답변은 한글.

progress-mon skill body marker v1

| 탭 | 보이는 것 | 자료 |
|---|---|---|
| 진척도 | 단계, 스토리, 진행 중 에이전트, 기타 항목. 완료, 진행 중, 예정 순 | ultra-chain 실행 기록(`events.jsonl`), git log, 워크플로 journal, `items.json` |
| 구현요건 | 요구 원문, 기능 명세, 근거 AC, 담당 스토리, 구현 여부 | `req-spec.json`, `reqs.json` |
| workflow | 실행 흐름 그림, 분기, 외부 구성요소, 장면 대본 | `flow.json` |
| 구성도 | 영역, 구성요소, 연결, 범례, 장면 대본 | `arch.json` |

- 없는 출처는 건너뛴다. 자료가 없는 탭은 "자료 없음" 과 스키마 문서 경로를 보인다
- 진척도, 구현요건 탭은 30초마다 자동 갱신(meta refresh). 다른 갱신 연결은 없다

## 언제 쓰나

- 다른 프로젝트에서도 같은 4탭 진척도 화면을 띄우고 싶을 때
- 단계, 스토리, 그 밖 작업의 진행을 에이전트가 세션마다 기록하게 하고 싶을 때
- 화면을 서버 없이 한 파일로 넘겨야 할 때(`export`)

## 쓰지 않을 때

- 지금 세션의 작업 목록만 보고 싶을 때. progress 를 쓴다(Claude Code `/banker:progress` 의 Claude Mods 패널, Codex `$banker-progress`)
- 공인 주소나 `0.0.0.0` 으로 화면을 열어야 할 때. 이 스킬은 거부한다

## 자리 표시

| 자리 | 뜻 |
|---|---|
| `<S>` | 이 스킬 디렉터리 절대경로(아래 런타임 표의 "스킬 디렉터리") |
| `<rt>` | `claude` 또는 `codex`(런타임 표의 `--runtime`) |
| `<data>` | 자료 폴더. Claude Code `.omc/progress-mon/`, Codex `.omx/progress-mon/` |

- 명령은 `node "<S>/scripts/progress-mon.mjs" <명령> --runtime <rt> [인자]` 꼴로 실행한다
- 프로젝트 루트는 작업 폴더의 `git rev-parse --show-toplevel`, 저장소가 아니면 작업 폴더. 다르면 `--project <dir>` 를 붙인다
- 셸 변수는 도구 호출 사이에 남지 않는다. 명령마다 실제 경로를 적는다
- `<S>` 는 프로젝트 스킬(`.claude/skills/progress-mon/`)이든 플러그인 안(`skills/progress-mon/`)이든 스킬을 불러온 위치다. 스크립트가 호출마다 자기 위치를 `<data>/state.json` 의 `skillDir` 에 맞춰 둔다

## 런타임 표

| 항목 | Claude Code | Codex |
|---|---|---|
| 스킬 디렉터리 | 스킬 맨 위 "Base directory for this skill:" 경로 | Codex 스킬 목록이 보이는 이 SKILL.md 경로(file)의 폴더. npm 설치는 `~/.codex/skills/banker-progress-mon/`(프로젝트 범위 설치면 `./.codex/skills/banker-progress-mon/`), 플러그인 설치(`codex plugin add`)는 `~/.codex/plugins/cache/<마켓플레이스>/banker/<판>/skills/progress-mon/`. 절대경로로 씀 |
| `--runtime` | `claude` | `codex` |
| 자료 폴더 | `.omc/progress-mon/` | `.omx/progress-mon/` |
| `--memory` | 자동 메모리 폴더를 알면 `auto-memory`, 아니면 `claude-md` | `agents-md` |
| `start`, `stop`, `status` | 바로 실행 | 명령 하나씩 `sandbox_permissions: "require_escalated"` 로 승인 요청 |
| `init` | 바로 실행 | git 제외 목록 쓰기 때문에 승인 요청 |
| 서버 수명 | 세션과 무관하게 분리 실행 | 세션을 닫으면 서버가 꺼질 수 있음. 사용자 터미널 명령 안내(banker `ultra-chain` SKILL.md 의 "런타임 대응" 절 방식) |

- 사용자 터미널 안내 견본: `node "<스킬 디렉터리>/scripts/progress-mon.mjs" serve --runtime codex --project "<프로젝트>"`
- Codex 는 승인을 명령 하나씩 요청한다. `&&` 로 묶지 않는다
- Claude Code 의 자동 메모리 폴더: 세션 맥락에 자동 메모리 `MEMORY.md` 경로가 보이면 그 폴더. 보이지 않으면 모르는 것으로 보고 `claude-md` 를 쓴다

## 인자 없는 호출

1. `status` 를 실행한다
2. 종료 코드와 첫 줄로 나눈다

   | 결과 | 할 일 |
   |---|---|
   | 종료 3, `꺼짐(자료 폴더 없음: ...)` | 아래 "init 절차" 를 끝까지. 마지막 단계가 `start` 와 URL 보고 |
   | 종료 3, `꺼짐(자료 폴더: ...)` | `start` 를 실행하고 출력의 URL 을 보고 |
   | 종료 0, `실행 중: <URL> (PID n)` | URL 과 `탭 자료:` 줄을 보고 |
   | 종료 1 또는 2 | 오류 줄을 그대로 보고하고 멈춤 |

3. `status` 의 표준 오류에 경고 줄(규칙 로드 한도, override 가려짐, `workflowDirs`)이 있으면 그대로 전한다
   - `WARN workflowDirs auto: 찾은 폴더 0` 은 이 프로젝트에서 Claude Code 워크플로를 돌린 적이 없으면 정상이다. 끄려면 `config.json` 의 `sources.workflowDirs` 를 `[]`(`references/config.md`)

- `start` 출력: `시작함: <URL>`, 이미 떠 있으면 `이미 실행 중(재사용): <URL>`. 포트가 차 있으면 다음 빈 포트를 쓰고 알림 줄을 낸다
- `--port 0`(OS 선택)은 받지 않는다. 특정 포트를 피해야 하면 OS 가 고른 빈 포트를 먼저 얻어 `--port` 로 넘긴다(`references/config.md` 의 "포트와 주소")
- 인자가 있는 호출(`/progress-mon status` 등)은 그 하위 명령을 `--runtime <rt>` 와 함께 그대로 실행하고 출력을 보고한다. `init` 만은 아래 절차를 따른다

## 하위 명령

| 명령 | 인자 | 동작 |
|---|---|---|
| `init` | `--memory claude-md\|agents-md\|auto-memory\|none` `[--memory-dir <dir>] [--title <t>]` | 자료 폴더, `config.json`(있으면 그대로), 빈 `items.json`, `state.json` 생성. git 제외 목록에 자료 폴더 한 줄. 메모리 규칙 등록. `auto-memory` 는 `--memory-dir` 필수 |
| `start` | `[--port <n>] [--port-strict] [--host <사설 IPv4>]` | 서버를 분리 실행하고 URL 출력. 같은 프로젝트 서버가 떠 있으면 재사용. 동시에 부른 start 는 차례로 돌아 서버 하나를 같이 씀. `<n>` 은 1024~65535 |
| `stop` | 없음 | 상태 파일 PID 가 이 서버일 때만 끔 |
| `status` | 없음 | 실행 여부, URL, PID, 자료 폴더, 탭별 자료 유무(깨진 JSON 은 깨짐), 시작 시각, 요청 수, 마지막 오류 시각. 서버를 띄운 뒤 `config.json` 의 `port`, `portStrict`, `hosts` 가 바뀌었으면 경고(그 셋만 `stop` 뒤 `start` 해야 적용, 나머지는 다음 응답에 반영) |
| `export` | `<file> [--now <ISO>]` | 4탭을 한 HTML 파일로. 외부 자원 없음, `file://` 에서 탭 전환. 사용자가 지시할 때만 만든다 |
| `item` | `--key <k> --status todo\|doing\|done --text <t> [--note <t>] [--issue <t>] [--at <ISO>] [--commit <hash>]` | 기타 항목. 같은 key 는 대체하고 시작 시각 유지(시작 시각은 `doing` 으로 기록할 때만). `--at` 은 지금 대신 그 시각으로 기록(시간대 필수). `--commit` 은 4~40자 16진 해시(commit Hash 칸에 앞 7자리). 빼면 있던 해시 유지 |
| `note` | `--key <k> [--note <t>] [--issue <t>]` | 단계(`stage:<id>`)나 스토리 행의 비고, 문제점. 빈 값은 그 칸을 지움 |
| `stage` | `--id <id> --status started\|done\|skipped\|failed\|stopped [--label <t>]` | 단계 상태 기록. 설정에 없는 id 는 새 단계 행 |
| `story` | `--id <id> (--status todo\|doing\|done \| --commit <hash>) [--name <t>]` | 스토리 상태나 완료 커밋 기록. 설정에 없는 id 는 새 스토리 행 |
| `check` | 없음 | 자료 파일 검사. `FAIL <파일> <json 경로> <이유>`, `WARN ...` 한 줄씩, 끝에 `check: FAIL n, WARN m` 과 밀도 요약 `density <탭> ok\|low`. 밀도 미달 줄 `WARN density <탭> <항목> <값>/<하한>[: <못 채운 대상>]` |

- 공통 인자: `--runtime claude|codex`, `--project <dir>`, `--data <dir>`(자료 폴더 직접 지정)
- 종료 코드: 0 성공(이미 그 상태 포함), 1 거부나 사용법 오류나 `check` FAIL, 2 예기치 못한 오류, 3 `status` 꺼짐
- 자료 폴더가 없으면 `start`, `item`, `note`, `stage`, `story` 는 종료 1("init 먼저"). `status`, `check`, `export` 는 폴더를 만들지 않는다
- 내부용 `serve`: `start` 와 같은 인자로 서버를 앞에서 실행. Codex 사용자 터미널 안내와 디버그에만 쓴다
- 스키마와 규칙: `references/config.md`, `references/items.md`

## init 절차

1. `--memory` 를 런타임 표대로 고른다
2. 실행: `node "<S>/scripts/progress-mon.mjs" init --runtime <rt> --memory <종류> [--memory-dir <자동 메모리 폴더>] [--title "<제목>"]`
3. 출력을 사용자에게 알린다
   - 쓴 파일과 줄 수: 자동 메모리는 파일 2개(`progress-mon.md`, `MEMORY.md` 색인 1줄), `CLAUDE.md` 는 1줄, Codex 는 3줄 블록
   - `--memory claude-md` 는 프로젝트 루트 `CLAUDE.md` 를 만들거나 고친다. 새로 만들었으면 `git status` 에 추적하지 않는 파일로 보인다. 커밋할지는 사용자가 정한다고 알린다
   - 출력에 `경고:` 줄(규칙 로드 한도, override 가려짐)이 있으면 그대로 전한다. Claude 면 `--memory claude-md` 로 다시 등록할지 묻고, Codex 면 프로젝트 지시 파일 정리(banker `cleansing-memory`)나 `config.toml` 의 `project_doc_max_bytes` 확인을 제안한다
   - 출력 끝 `다음 할 일` 3줄은 요약이다. 그 목록이 아니라 이 절차 4~13 을 모두 따른다(`inventory.json`, `config.json` 의 `title`, `shortName`, `stories`, 진척도 기록은 요약에 없어도 한다)
4. `<S>/references/authoring.md` 를 읽는다. 밀도 기준 표, 읽기 예산, 좋은 예가 거기 있다
5. 읽기 예산 안에서 코드를 읽고 `<data>/inventory.json` 을 쓴다(`references/inventory.md`)
6. `<data>/config.json` 의 `title`, `shortName`, `stories` 를 채운다. `shortName` 은 브라우저 탭 제목과 구성도 그림 이름에 쓰는 짧은 이름(기본은 폴더 이름). 스토리가 없으면 빈 목록(`references/config.md`)
7. `<data>/req-spec.json`, `reqs.json`, `flow.json`, `arch.json` 을 쓴다. 구조만 쓰고 좌표는 쓰지 않는다(자동 배치). 스토리가 없으면 명세마다 `state` 와 `note`(`references/req-spec.md`, `reqs.md`, `flow.md`, `arch.md`)
8. `check` 를 실행한다. FAIL 이 있으면 고쳐 7 과 8 을 다시. 8 의 `check` 는 FAIL 0 이 될 때까지 최대 3회
9. FAIL 0 이 된 뒤 `WARN density ...` 가 남으면 읽기 예산 안에서 한 번 보충하고 `check` 를 한 번 더 실행한다
   - 이 보충과 `check` 는 8 의 3회에 세지 않는다. 보충은 한 번만
   - 보충 뒤 새 FAIL 이 나오면 그 보충 부분을 고치거나 되돌려 FAIL 0 으로 둔다
   - 그래도 남은 `WARN density` 줄은 그대로 사용자에게 보고한다(실패 아님). 줄 끝의 대상 이름이 고칠 곳이다(`references/authoring.md`)
   - 자동 배치 WARN(`이름표 덮음`, `이름표가 그림 밖`)은 배치 조언이다. 자동 배치 선은 상자와 영역 제목을 돌아가므로 `선이 상자 지남` 은 보통 없다. 연결을 하한 아래로 지우지 않는다(`references/arch.md` 의 "자동 배치 WARN 줄이기")
   - `자기 연결` WARN 은 그 연결의 `from` 이나 `to` 를 실제 상대로 고친다
10. 8 의 3회 뒤에도 FAIL 이 남으면 그 탭의 파일만 지워 "자료 없음" 으로 두고 남은 FAIL 을 보고한다
11. 진척도 탭: 아는 단계와 작업을 적는다. 명령마다 `--note`(근거 커밋, 결과)를 쓴다. 문제점이 있으면 `--issue` 도 쓰고, 없으면 `--issue` 를 빼서 칸을 빈칸으로 둔다

    | 프로젝트 | 쓸 명령 |
    |---|---|
    | `config.json` 에 `stories` 가 있음 | `story`(스토리 상태, 완료 커밋), 비고는 `note --key <스토리 id>` |
    | 이름 붙은 단계(`stages` 목록이나 ultra-chain 실행 기록)가 있음 | `stage`, 비고는 `note --key stage:<id>` |
    | 스토리와 단계가 없음 | `item` 만. 아는 작업(최근 커밋 묶음, 진행 중 작업, 남은 일)을 하나씩 |

    - 스토리가 없는 프로젝트에서 `story` 를 쓰지 않는다. 설정에 없는 id 는 새 스토리 행이 되어 진척률이 켜진다. 단계도 같다(`stage` 는 새 단계 행)
    - 지난 커밋은 커밋 시각과 해시로 기록한다. `git log -n <수> --format="%h %cI %s"` 의 `%cI` 를 `--at`, `%h` 를 `--commit` 에 넘긴다(예 `item --key c-1a2b3c4 --status done --text "<제목>" --at 2026-10-20T12:34:56+09:00 --commit 1a2b3c4`). `--at` 이 없으면 모든 항목이 기록한 지금 시각으로 보인다. `--commit` 이 없으면 commit Hash 칸이 빈다
12. `check` 를 다시 실행한다. 11 의 기록으로 `history 비고` 같은 밀도 줄이 바뀐다. 새 FAIL 이 있으면 고친다. 남은 `WARN` 은 보고한다
13. `start` 를 실행하고 URL 을 보고한다

- 자료가 없는 탭을 만들 수 없을 때(문서와 코드에 근거 없음)는 그 파일을 쓰지 않는다. 화면은 "자료 없음" 과 만드는 법을 보인다
- 사용자 문서는 덧붙이기만 한다. 표식 `<!-- progress-mon:rule -->` 이 이미 있으면 다시 쓰지 않는다

## 갱신 규칙(init 뒤 세션)

`init` 이 메모리 파일에 규칙 한 줄을 남긴다. 다음 세션의 에이전트는 그 줄을 따라 갱신한다.

- 세션 시작 때 `status`. 꺼져 있으면 `start`(Codex 는 승인 요청)
- 스크립트 위치: `<data>/state.json` 의 `skillDir` 아래 `scripts/progress-mon.mjs`. 실행이 실패하면 이 스킬을 불러 `<S>` 를 다시 얻는다
- 기록

  | 일 | 명령 |
  |---|---|
  | 단계 시작, 끝 | `stage --id <id> --status started` 뒤 `--status done` |
  | 스토리 진행, 완료 | `story --id <id> --status doing`, 완료 커밋은 `story --id <id> --commit <hash>` |
  | 그 밖 작업 | `item --key <k> --status doing\|done --text "<내용>" --note "<근거>" [--issue "<문제점>"]` |
  | 단계, 스토리 행의 비고 | `note --key stage:<id> --note "<근거>"`, `note --key <스토리 id> --issue "<문제점>"` |

- Codex 는 모든 명령에 `--runtime codex` 를 붙인다. 세션을 닫아도 화면을 두려면 사용자 터미널의 `serve` 를 안내한다
- 스토리 상태 우선순위: 커밋(제목 판정 또는 `story --commit`) 있으면 완료, 없으면 `story --status`, 없으면 진행 중 에이전트가 있으면 진행 중, 그 밖 예정

## 보안

- 바인드는 127.0.0.1 만. `--host` 는 사설 IPv4(10/8, 172.16/12, 192.168/16)만 받고 경고 한 줄을 낸다. `0.0.0.0`, `::`, 공인 IP, 링크 로컬, 100.64/10, 호스트 이름은 거부
- Host 헤더는 `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`, 바인드한 `<ip>:<port>` 만 받는다. 그 밖은 403
- `GET`, `HEAD` 의 `/`, `/index.html` 만 화면을 준다. 자료 폴더 파일(`config.json`, `server.json` 등)은 어떤 경로로도 내보내지 않는다
- 오류 응답은 일반 문구만. 스택과 경로는 `<data>/server.log` 에만
- `stop` 은 상태 파일 PID 와 서버 신원 응답 PID 가 같을 때만 끈다
- 자료와 화면에 비밀값(키, 토큰, 비밀번호)을 적지 않는다. 모든 글은 escape 하고 색은 `#rrggbb` 만 받는다
