---
name: init-dir
description: "프로젝트에 관리 폴더 7개(logs, scripts, work, mockup, tests, docs, KB)를 만들고, 폴더별 목적을 지금 세션에 전달하며, AGENTS.md 와 CLAUDE.md 중 있는 것에 표지 블록으로 기록. 새로 만든 폴더에만 틀 파일(서비스 시작, 정지 스크립트와 로그 로테이션, 시험 실행기, README)을 넣고, 이미 있는 폴더는 만들지 않고 목적만 전달. 'init-dir'/'폴더 초기화'/'프로젝트 폴더 만들기'/'폴더 구조 잡기' 시 사용."
argument-hint: "[apply|status] [--only=<폴더,...>] [--follow-symlink] [--dry-run]"
---

# init-dir: 프로젝트 관리 폴더 초기화

프로젝트 루트에 관리 폴더를 만들고 폴더마다 목적을 정한다.
목적은 두 곳에 남는다: 지금 세션(스크립트 출력의 "폴더 목적 요약")과 지시 파일(`AGENTS.md`, `CLAUDE.md`)의 표지 블록.
답변은 한글.

| 폴더 | 목적 |
|---|---|
| `logs/` | 서비스 로그. 표준 출력과 표준 오류를 나눠 저장, 100MB 로테이션, 스트림마다 최대 7개 |
| `scripts/` | `./scripts/start.sh`, `stop.sh`, `status.sh`, `restart.sh`. Windows 는 같은 이름의 `.cmd` |
| `work/` | 사용자와 상호작용하는 작업공간. 사용자가 에이전트에게 줄 파일을 둠 |
| `mockup/` | 목업 파일 관리 |
| `tests/` | 단위, 통합 시험 스크립트와 결과를 간결하게 출력하는 실행기 |
| `docs/` | 문서를 관리하는 영역. evidence와 ADR도 포함하여 보관한다. |
| `KB/` | knowledge base. OMC, OMX 위키 밖에서 사용자가 알아야 할 내용을 두는 2차 위키 |

## 언제 쓰나

- 새 프로젝트의 폴더 구조를 잡을 때
- 이미 있는 프로젝트에서 폴더 목적을 에이전트에게 알리고 지시 파일에 남길 때(있는 폴더는 건드리지 않음)

## 쓰지 않을 때

- git 저장소 초기화와 `.gitignore`: banker `git-init`
- 코드베이스 전체의 계층형 `AGENTS.md` 문서: banker `deep-init`

## 자리 표시

| 자리 | 뜻 |
|---|---|
| `<S>` | 이 스킬 디렉터리 절대경로(아래 런타임 표의 "스킬 디렉터리") |
| `<rt>` | `claude` 또는 `codex`(런타임 표의 `--runtime`) |
| `<root>` | 대상 폴더. 기본은 작업 폴더. 다르면 `--root <dir>` |

- 셸 변수는 도구 호출 사이에 남지 않는다. 명령마다 실제 경로를 적는다

## 런타임 표

| 항목 | Claude Code | Codex |
|---|---|---|
| 스킬 디렉터리 | 스킬 맨 위 "Base directory for this skill:" 경로 | Codex 스킬 목록이 보이는 이 SKILL.md 경로(file)의 폴더. npm 설치는 `~/.codex/skills/banker-init-dir/`(프로젝트 범위 설치면 `./.codex/skills/banker-init-dir/`), 플러그인 설치(`codex plugin add`)는 `~/.codex/plugins/cache/<마켓플레이스>/banker/<판>/skills/init-dir/`. 절대경로로 씀 |
| `--runtime` | `claude` | `codex` |
| 지시 파일이 둘 다 없을 때 만드는 파일 | `CLAUDE.md` | `AGENTS.md` |
| 작업 폴더 안 실행 | 바로 실행 | 바로 실행(기본 샌드박스의 작업 폴더 쓰기 범위) |
| 작업 폴더 밖 `--root` | 바로 실행 | 명령에 `sandbox_permissions: "require_escalated"` 로 승인 요청. `--add-dir` 로 설정 폴더를 넓히지 않음 |
| 생성된 `./scripts/start.sh` 실행 | 바로 실행 | 서비스가 세션 뒤에도 남아야 하면 승인 요청. 세션을 닫으면 꺼질 수 있으므로 사용자 터미널 명령을 안내 |

## 실행

1. 인자 확인
   - 하위 명령은 `apply`(기본)나 `status`. 그 밖은 실행하지 않고 사용법 안내
   - `--only` 값은 `logs, scripts, work, mockup, tests, docs, KB` 의 이름만 쉼표로. 대소문자는 무시하고 `KB` 로 맞춤
   - 사용자 표기 `Agents.md`, `Claude.md` 는 `AGENTS.md`, `CLAUDE.md` 로 해석
   - 사용자 입력을 셸 명령에 그대로 붙이지 않음
2. 스크립트 실행

   ```bash
   node "<S>/scripts/init-dir.mjs" apply --runtime <rt> [--root "<root>"] [--only=<폴더,...>]
   ```

   - 계획만 보려면 `--dry-run`. 기계가 읽을 출력은 `--json`(JSON 한 줄)
   - 상태만 보려면 `node "<S>/scripts/init-dir.mjs" status [--root "<root>"]`
3. 결과 처리
   - 출력 표(폴더마다 `만듦` 또는 `있음(목적만 전달)`, 틀 파일마다 `만듦`, 지시 파일 결과)를 사용자에게 보고
   - `경고:` 줄은 그대로 전함
   - 출력 끝의 "폴더 목적 요약" 을 이 세션의 작업 규칙으로 바로 적용. 예: 새 로그는 `logs/`, 시험 스크립트는 `tests/`, 사용자가 준 파일은 `work/` 에서 찾음. 다음 세션은 지시 파일의 블록이 같은 내용을 전함
4. 종료 코드

   | 코드 | 뜻 | 처리 |
   |---|---|---|
   | 0 | 완료. 바뀐 것 없음 포함 | 결과 보고와 목적 요약 적용 |
   | 1 | 거부 또는 쓰기 실패. 거부는 아무것도 바꾸지 않음 | 메시지 그대로 전하고 아래 "문제 해결" |
   | 2 | 사용 오류(`--runtime` 없음, 모르는 인자, 모르는 폴더 이름, 루트 폴더 없음) | 인자를 고쳐 다시 실행 |
   | 3 | 환경(대소문자만 다른 지시 파일, 루트가 HOME 이나 파일 시스템 루트) | 메시지 전달. 이름을 바꿀지, 어느 폴더에서 실행할지 사용자에게 물음 |

   - 출력이 비어 있으면 실행 실패. 성공으로 보고하지 않음

## 폴더와 틀

- 틀은 이번 실행에서 새로 만든 폴더에만 쓴다. 이미 있던 폴더에는 틀을 하나도 넣지 않고 목적만 전달한다(일부만 생겨 서로 안 맞는 상태 방지)
- 새 폴더는 틀을 다 갖추거나 아예 생기지 않는다. 같은 부모 아래 임시 폴더 `.<이름>.init-dir-<난수>` 에 틀을 다 쓴 뒤 이름을 바꿔 옮긴다. 쓰기나 이름 바꾸기가 실패하면 임시 폴더를 지우고 종료 1(`쓰기 실패:`). 대상 폴더가 없으니 다시 실행하면 완전한 폴더가 생긴다
  - 강제 종료로 끊기면 임시 폴더가 남을 수 있다. `status` 와 `apply` 가 `남은 임시 폴더: <경로> (지워도 됨)` 로 보고한다. 자동으로 지우지 않는다. 관리 폴더가 아니므로 사용자 확인을 받아 지운다. git-init 은 이 꼴(`.*.init-dir-*/`)을 첫 커밋에서 뺀다
- 틀 파일은 새로 만들기만 한다. 같은 이름의 파일을 덮어쓰지 않는다
- `.sh` 는 POSIX sh, 권한 0755. `.cmd` 는 CRLF

| 폴더 | 만드는 틀 |
|---|---|
| `logs/` | `README.md`(로그 규칙), `.gitignore`(`*`, `!.gitignore`, `!README.md`) |
| `scripts/` | `start.sh`, `stop.sh`, `status.sh`, `restart.sh` 와 같은 이름의 `.cmd`, `service.conf`(`name=app`, 빈 `command=`), `lib/service.mjs`, `README.md` |
| `work/` | `README.md`(비밀값을 두지 말 것. 커밋 전 git-init 이나 audit-security 스캔이 잡음) |
| `mockup/` | `README.md` |
| `tests/` | `run.sh`, `run.cmd`, `run.mjs`, `tests.conf`(`unit=`, `integration=`), `unit/`, `integration/`, `README.md` |
| `docs/` | `README.md`(evidence 와 ADR 보관 안내, 하위 폴더 뜻), `evidence/`, `adr/`(빈 `.gitkeep`) |
| `KB/` | `README.md`(2차 위키의 대상과 색인 규칙) |

- `work/`, `mockup/` 는 git 에서 빼지 않는다

### scripts 틀: `lib/service.mjs`

| 항목 | 내용 |
|---|---|
| 설정 | `scripts/service.conf` 의 `name=`(로그와 PID 파일 이름), `command=`(프로젝트 폴더에서 셸로 실행할 한 줄) |
| 구조 | `start` 가 분리된 감독 프로세스를 띄움. 감독이 `command` 를 자식으로 띄우고 표준 출력은 `logs/<이름>.out.log`, 표준 오류는 `logs/<이름>.err.log` 에 씀 |
| PID 파일 | `logs/<이름>.pid` 에 `{supervisor, child, startedAt}` |
| 로테이션 | 쓰기 전에 "현재 크기 + 쓸 양 > 100MB(104857600 바이트)" 면 돌림. `.log` 가 `.1.log` 로 밀리고 `.6.log` 는 지움. 현재 파일 포함 7개, 스트림당 최대 700MB |
| stop | 감독에 SIGTERM. 감독이 자식의 프로세스 그룹에 넘기고 10초 뒤 SIGKILL. 감독이 없으면 자식에 직접. Windows 는 `taskkill /T`, 10초 뒤 `/F` |
| status | 감독과 자식의 실행 여부를 따로, 로그 파일 수와 크기 |
| 시작 잠금 | `start` 는 `logs/<이름>.start.lock` 을 O_EXCL 로 만들어 잡고 끝나면 지움. 동시에 여러 번 실행해도 감독은 하나, 나중 실행은 기다린 뒤 `이미 실행 중`. 죽은 PID, 다른 프로그램, 30초 넘은 잠금은 넘겨받음. 링크나 폴더 자리는 거부 |
| 종료 코드 | 0 성공(status 는 둘 다 실행 중), 1 실패(시작 2초 안에 멈춤, 멈추지 못함, status 에서 실행 중 아님), 2 설정 없음(`command` 비어 있음), 3 Node 18 이상 없음(래퍼) |

- 대상 프로젝트에 Node 18 이상이 필요하다. 다른 Node 는 환경 변수 `NODE` 에 경로
- 조정용 환경 변수: `SERVICE_LOG_ROTATE_BYTES`, `SERVICE_STOP_GRACE_MS`, `SERVICE_START_CHECK_MS`

### tests 틀: `run.mjs`

- `tests.conf` 의 `<스위트>=<명령>` 을 차례로 실행하고 스위트마다 한 줄: `PASS unit (1.2s)`, `FAIL integration (0.3s, 종료 1)`
- 실패하면 그 출력의 마지막 20줄, 끝에 요약 한 줄
- 종료 코드: 0 모두 통과, 1 실패 있음, 2 설정 없음(실행할 명령 없음 포함), 3 Node 18 이상 없음

## 지시 파일 블록

- 대상: 정확한 이름의 `AGENTS.md`, `CLAUDE.md` 중 있는 것 전부. 둘 다 없으면 런타임 파일 하나를 만든다
- 표지: `<!-- banker:init-dir:start -->` 와 `<!-- banker:init-dir:end -->` 사이. 다시 실행하면 그 블록만 바꾼다
- `AGENTS.md` 에서는 자기 몫의 `<!-- USER:OMX:POLICY:START -->`, `<!-- USER:OMX:POLICY:END -->` 한 쌍으로 감싸 파일 끝에 둔다. 기존 정책 블록 안에 넣지 않는다. `omx setup --merge-agents` 가 이 블록을 지킨다
- 내용: 디스크에 있는 관리 폴더 전부의 한 줄 목적. 같은 디스크 상태면 같은 바이트(여러 번 실행해도 같음)
- 블록 밖 바이트, CRLF, BOM, 권한 비트는 그대로. 바이트가 바뀔 때만 첫 원본을 `<파일>.init-dir.bak` 에 둔다(이미 있으면 덮지 않음)
- `CLAUDE.md` 가 `AGENTS.md` 를 가리키는 링크면 기본은 거부(종료 1). `--follow-symlink` 면 같은 파일이므로 한 번만 쓰고, 블록은 `AGENTS.md` 꼴
- `AGENTS.override.md` 에 내용이 있으면 Codex 가 `AGENTS.md` 대신 그것을 읽는다고 경고한다. override 에는 쓰지 않는다
- 대소문자 구분 파일 시스템에서 대소문자만 다른 파일(`Agents.md`)만 있으면 경고하고 아무 파일도 만들지 않고 종료 3. 대소문자 무시 파일 시스템(macOS, Windows 기본)은 실제 이름 그대로 쓴다

## 오프라인

- 네트워크를 쓰지 않는다. 틀은 모두 스킬 안의 파일(`templates/`)에서 복사한다

## 함정

- 이미 있던 폴더에는 틀이 없다. 틀 파일이 필요하면 필요한 것만 사용자와 상의해 만든다. init-dir 은 기존 폴더를 지우거나 채우지 않는다
- 지시 파일의 블록을 손으로 고치면 다음 실행이 디스크 상태로 다시 쓴다. 손으로 쓸 내용은 블록 밖에 둔다
- 표지 줄 하나만 지우거나 문장 안에 표지를 옮기면 거부(종료 1)한다. 짝을 임의로 맞추지 않는다
- `scripts/` 의 감독이 죽으면 자식은 다음 출력 때 SIGPIPE 로 죽을 수 있다. `status` 가 감독과 자식을 따로 보이고, `stop` 이 남은 자식을 끝낸다
- 지금 세션은 지시 파일을 다시 읽지 않는다. 그래서 출력의 "폴더 목적 요약" 을 이 세션에 바로 적용한다

## 문제 해결

- 아래 표에서 파일을 보인다는 것은 `ls -l` 로 그 이름의 종류와 링크 대상 경로를 보이는 것이다. 링크가 아닌 일반 파일임을 본 뒤에만 내용을 연다

| 메시지 | 조치 |
|---|---|
| 심볼릭 링크라 그대로 둠 | 지시 파일이 링크. 링크와 대상 경로를 보이고, 대상에 쓸지 물은 뒤 `--follow-symlink` 로 다시 실행 |
| 끊어진 링크라 그대로 둠 | 링크가 가리키는 파일이 없음. 링크를 지우거나 바꾸지 않음. 어떻게 할지 물음 |
| 하드 링크가 n개라 그대로 둠 | 같은 파일에 이름이 여럿. 쓰면 링크가 갈라짐. 어느 이름을 쓸지 물음 |
| 다른 사용자 소유라 그대로 둠 | 파일 소유자가 실행 사용자와 다름. 소유자 확인을 안내 |
| 표지 손상이라 그대로 둠 | 표지 줄이 한쪽만 있거나, 문장 안에 있거나, 블록이 둘 이상. 남은 표지 줄을 보이고 지울지 물은 뒤 다시 실행 |
| UTF-8 이 아니라 그대로 둠 | 지시 파일이 CP949, UTF-16 등. 인코딩을 보이고 UTF-8 로 바꿀지 물음 |
| 일반 파일이 아니라 그대로 둠 | 지시 파일 자리에 폴더나 FIFO 같은 특수 파일. 지우지 않고 무엇인지 보임 |
| 폴더 자리에 폴더가 아닌 것이 있어 거부 | `logs` 같은 이름이 파일. 옮기거나 이름을 바꿀지 물은 뒤 다시 실행 |
| 대소문자가 다른 지시 파일만 있음 | `Agents.md` 처럼 이름이 다름. `AGENTS.md` 로 바꿀지 물은 뒤 다시 실행 |
| 루트가 HOME 이라 거부 | 프로젝트 폴더에서 실행하거나 `--root` 로 지정 |

## 출처(조사한 것)

| 주제 | 확인한 사실 | 출처 |
|---|---|---|
| Claude Code 지시 파일 | 프로젝트 `CLAUDE.md` 를 세션 시작 때 읽음 | https://code.claude.com/docs/en/memory |
| Codex 지시 파일 | 폴더마다 `AGENTS.override.md` 가 있으면 그것을, 없으면 `AGENTS.md` 를 읽음 | https://developers.openai.com/codex/guides/agents-md |
| OMX 정책 블록 | `omx setup --merge-agents` 는 생성된 `AGENTS.md` 에서 `USER:OMX:POLICY` 구간만 옮김 | banker `tone-compact` 의 `instruction-toggle.mjs` 머리 주석(실측) |
