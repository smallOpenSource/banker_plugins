---
name: git-init
description: "저장소가 아닌 현재 폴더에 첫 커밋을 만들어 worktree 같은 병렬 작업을 준비. 민감 정보를 빼는 .gitignore 를 쓰고, 추적될 파일을 비밀값 스캔한 뒤 git init, git add ., git commit -m \"init\" 을 실행. 걸림이 있으면 .git 을 만들지 않음. 'git-init'/'git 초기화'/'첫 커밋'/'저장소 만들기'/'worktree 준비' 시 사용."
argument-hint: "[check|run] [--branch <이름>] [--local-identity \"<이름> <<메일>>\"] [--nested] [--accept <파일:줄:종류>]... [--follow-symlink]"
---

# git-init: 첫 커밋 준비

저장소가 아닌 폴더를 git 저장소로 만들고 커밋 `init` 하나를 남긴다.
그 커밋이 있어야 `git worktree add` 로 병렬 작업을 시작할 수 있다.
답변은 한글.

순서: `.gitignore` 작성, 추적될 파일의 이름과 내용 스캔, `git init`, `git add .`, `git commit -m "init"`.
스캔에 걸리면 `git init` 하지 않는다.

## 언제 쓰나

- 새 프로젝트 폴더에서 첫 커밋을 만들 때
- 에이전트 여럿이 worktree 로 나눠 일하기 전에 기준 커밋이 필요할 때

## 쓰지 않을 때

| 상황 | 대신 |
|---|---|
| 이미 저장소인 폴더의 `.gitignore` 잡음 정리 | banker `refresh-git-ignore` |
| 이미 커밋된 비밀값 찾기, 의존성 취약점 | banker `audit-security` |
| 관리 폴더(logs, scripts, work 등) 만들기 | banker `init-dir` |

- refresh-git-ignore 와의 역할 나눔: git-init 은 저장소가 생기기 전 한 번 실행한다. refresh-git-ignore 는 이미 있는 저장소의 런타임 잡음을 정리한다(모델 절차, 스크립트 없음). 둘은 코드를 나누지 않는다

## 자리 표시

| 자리 | 뜻 |
|---|---|
| `<S>` | 이 스킬 디렉터리 절대경로(아래 런타임 표의 "스킬 디렉터리") |
| `<root>` | 대상 폴더. 기본은 작업 폴더. 다르면 `--root <dir>` |

- 셸 변수는 도구 호출 사이에 남지 않는다. 명령마다 실제 경로를 적는다

## 런타임 표

| 항목 | Claude Code | Codex |
|---|---|---|
| 스킬 디렉터리 | 스킬 맨 위 "Base directory for this skill:" 경로 | Codex 스킬 목록이 보이는 이 SKILL.md 경로(file)의 폴더. npm 설치는 `~/.codex/skills/banker-git-init/`(프로젝트 범위 설치면 `./.codex/skills/banker-git-init/`), 플러그인 설치(`codex plugin add`)는 `~/.codex/plugins/cache/<마켓플레이스>/banker/<판>/skills/git-init/`. 절대경로로 씀 |
| 확인 질문 도구 | `AskUserQuestion` | `request_user_input`. 없으면 번호 붙인 평문 선택지 |
| `check` | 바로 실행 | 바로 실행(임시 폴더만 씀) |
| `run` | 바로 실행 | `.git` 쓰기는 기본 샌드박스가 막을 수 있음. 명령에 `sandbox_permissions: "require_escalated"` 로 승인 요청. `--add-dir` 로 설정 폴더를 넓히지 않음 |

## 인자

| 인자 | 뜻 | 기본 |
|---|---|---|
| `check`, `run` | `check` 는 아무것도 쓰지 않고 계획(새 `.gitignore` 블록, 추적 후보 수, 스캔 결과)만 보임 | `check` |
| `--root <dir>` | 대상 폴더 | 작업 폴더 |
| `--branch <이름>` | 첫 브랜치 | `init.defaultBranch` 설정, 없으면 `main`. 이 저장소에만 적용, 전역 설정은 바꾸지 않음 |
| `--local-identity "<이름> <<메일>>"` | 커밋 신원이 없을 때 이 저장소의 `.git/config` 에만 설정 | 없음 |
| `--nested` | 상위 폴더가 저장소여도 진행 | 꺼짐(멈춤) |
| `--accept <파일:줄:종류>` | 내용 걸림 중 사용자가 오탐으로 확인한 것. 여러 번 줄 수 있음 | 없음 |
| `--follow-symlink` | `.gitignore` 가 링크일 때 가리키는 파일에 씀 | 꺼짐(링크면 거부) |
| `--json` | JSON 한 줄 출력 | 꺼짐 |

## 실행

1. 계획 확인

   ```bash
   node "<S>/scripts/git-init.mjs" check [--root "<root>"] [--branch <이름>] [--local-identity "<이름> <<메일>>"]
   ```

   - 출력(브랜치, `.gitignore` 계획, 추적 후보 수, 걸림)을 사용자에게 보인다
   - 내용 걸림은 `파일:줄:종류` 만 보인다. 파일을 열어 값을 답변에 옮기지 않는다
2. 사용자 확인(런타임 표의 확인 질문 도구)
   - 걸림이 없으면 "run 으로 진행" 여부만 묻는다
   - 내용 걸림이 있으면 항목마다 "진짜 비밀값(파일을 고치거나 `.gitignore` 에 넣음)" 과 "오탐(넘김)" 중에서 고르게 한다. 오탐으로 고른 항목만 `--accept` 로 넘긴다. 사용자 확인 없이 `--accept` 를 붙이지 않는다
   - 이름 걸림은 넘길 수 없다. 그 파일을 `.gitignore` 에 넣거나 저장소 밖으로 옮길지 묻는다
3. 실행

   ```bash
   node "<S>/scripts/git-init.mjs" run [--root "<root>"] [같은 인자] [--accept "<파일:줄:종류>"]...
   ```

4. 결과 처리
   - 커밋 해시, 브랜치, 추적 파일 수, "확인으로 넘긴 항목" 을 보고한다
   - `경고:` 줄(100MB 초과 파일)과 "내용 미스캔(2MB 초과)" 목록은 그대로 전한다. 큰 파일은 원격 저장소가 거부할 수 있다
   - 출력이 비어 있으면 실행 실패. 성공으로 보고하지 않는다
5. 종료 코드

   | 코드 | 뜻 | 처리 |
   |---|---|---|
   | 0 | 커밋 완료. `check` 는 걸림 없음 | 결과 보고 |
   | 1 | 스캔 걸림, `.gitignore` 쓰기 거부, git 단계 실패 | 아래 "문제 해결" |
   | 2 | 사용 오류(모르는 인자, `--accept` 나 `--local-identity` 꼴, 쓸 수 없는 브랜치 이름, 루트 폴더 없음) | 인자를 고쳐 다시 실행 |
   | 3 | 선행 조건 실패. 아무것도 바꾸지 않음 | 메시지를 전하고 아래 "문제 해결" |

## run 이 하는 일

1. 선행 조건(실패하면 종료 3, 아무것도 안 바꿈)
   - `git` 이 없음, 루트가 HOME 이나 파일 시스템 루트, 환경 변수 `GIT_DIR` 이나 `GIT_WORK_TREE`
   - 루트나 상위가 이미 작업 트리. 상위만 저장소면 `--nested` 일 때만 진행
   - 하위 폴더에 `.git` 이 있음(넣으면 gitlink 가 됨). 그 경로를 보임
   - 커밋 신원: `user.name` 과 `user.email` 설정이 둘 다 없고 `--local-identity` 도 없음. `git var` 는 호스트 이름으로 추정한 신원으로 성공할 수 있어 쓰지 않음
2. `.gitignore`: 없으면 새로 쓴다. 있으면 기존 줄은 두고 빠진 패턴만 `# banker:git-init:start` .. `# banker:git-init:end` 블록으로 끝에 넣는다
   - 패턴: `.env`, `.env.*`, `!.env.example`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa*`, `id_ecdsa*`, `id_ed25519*`, `credentials.json`, `*.tfstate`, `*.tfstate.*`, `.aws/`, `.ssh/`, `.omc/`, `.omx/`, `node_modules/`, `.DS_Store`, `Thumbs.db`, `.gitignore.git-init.bak`(이 스킬이 남기는 백업)
   - 블록 밖 바이트, CRLF, BOM, 권한 비트는 그대로. 바이트가 바뀔 때만 첫 원본을 `.gitignore.git-init.bak` 에 둔다(이미 있으면 덮지 않음)
3. 추적 후보: 임시 폴더의 빈 저장소로 `git ls-files -o --exclude-standard` 를 구한다. 루트에는 아직 `.git` 이 없다
4. 스캔
   - 이름: 키, 인증서, `.env` 류, `.npmrc`, `.netrc`, `.pgpass`, `.aws/`, `.ssh/` 아래 파일이 목록에 남았는지(사용자 `.gitignore` 의 `!` 예외 등). `--accept` 로 넘길 수 없음
   - 내용: 2MB 이하 텍스트 파일(앞 8KB 에 NUL 바이트가 없으면 텍스트)을 `scripts/payload-scan.mjs` 로. 값은 출력하지 않고 `파일:줄:종류` 만
   - `--accept` 와 정확히 같은 `파일:줄:종류` 만 걸림에서 뺀다. 줄이나 종류가 다르면 넘기지 못한다
   - 남은 걸림이 있으면 `git init` 하지 않고 종료 1. `.gitignore` 변경은 남기고 그 사실을 보고
5. `git init`(브랜치는 인자 표대로. git 2.28 미만은 `git symbolic-ref`), `--local-identity` 면 저장소 범위 신원
6. `git add .` 뒤 스테이지된 이름이 스캔한 목록과 같은지 확인. 다르면 커밋하지 않고 종료 1
7. `git commit -m "init"`. 커밋 훅을 건너뛰지 않는다. 120초 안에 끝나지 않으면 멈추고 종료 1
   - 추적 후보가 0개여도 `.gitignore` 가 추적되므로 커밋은 1개 생긴다

## 오프라인

- 네트워크를 쓰지 않는다. 원격 저장소 연결과 push 는 하지 않는다

## 함정

- `check` 의 추적 후보는 새 패턴을 임시 저장소의 `info/exclude` 로 흉내 낸 값이다. 사용자 `.gitignore` 가 새 패턴과 부딪치면 `run` 의 수와 다를 수 있다. `run` 은 실제 `.gitignore` 를 쓴 뒤 다시 구하고 다시 스캔한다
- `includeIf "gitdir:..."` 로만 정한 신원은 저장소가 생기기 전이라 보이지 않는다. 이때는 `--local-identity` 를 쓴다
- 기존 `.gitignore` 를 바꾸면 `.gitignore.git-init.bak` 이 루트에 생긴다. 이 이름은 블록 패턴에 들어 있어 첫 커밋에 들어가지 않는다. 필요 없으면 사용자 확인을 받아 지운다
- 걸림으로 멈춘 뒤 다시 실행하면 블록을 같은 내용으로 다시 쓴다(바이트가 같으면 쓰지 않음)
- 스캔은 흔한 키 형식을 잡을 뿐 깨끗함을 증명하지 않는다. 미스캔 목록(2MB 초과, 바이너리)은 사용자가 따로 확인한다

## 문제 해결

| 메시지 | 조치 |
|---|---|
| 커밋 신원 없음 | `--local-identity "<이름> <<메일>>"` 로 이 저장소에만 둘지, 사용자가 `git config --global` 을 직접 실행할지 묻는다. 전역 설정은 대신 바꾸지 않는다 |
| 상위 폴더가 저장소 | 그 저장소 경로를 보이고, 안에 따로 저장소를 만들지 묻는다. 동의하면 `--nested` |
| 이미 저장소 | git-init 대상이 아님. 잡음 정리는 refresh-git-ignore |
| 하위 폴더에 .git 이 있음 | 경로를 보이고, 그 폴더를 `.gitignore` 에 넣을지, 서브모듈로 할지, 옮길지 묻는다. `.git` 을 지우지 않는다 |
| 이름 걸림 | 그 파일을 `.gitignore` 에 넣거나 옮길지 묻는다. 사용자 `.gitignore` 의 `!` 예외가 원인이면 그 줄을 보인다 |
| 내용 걸림 | `파일:줄:종류` 만 보이고 오탐 여부를 묻는다. 오탐만 `--accept` |
| 심볼릭 링크라 그대로 둠 | `.gitignore` 가 링크. 링크와 대상 경로를 보이고, 대상에 쓸지 물은 뒤 `--follow-symlink` |
| 하드 링크, 다른 사용자 소유, 표지 손상, UTF-8 아님 | init-dir SKILL.md 의 같은 메시지 조치와 같음. 파일을 보이고 어떻게 할지 묻는다 |
| 스테이지된 파일이 스캔한 목록과 다름 | 스캔 뒤 파일이 바뀌었거나 템플릿의 `info/exclude` 가 다름. `.git` 이 남아 있으므로 보이고, 지우고 다시 실행할지 묻는다 |
| git commit 이 120초 안에 끝나지 않음 | 커밋 훅(`core.hooksPath`, 템플릿 훅)을 확인하도록 안내 |
| 임시 폴더가 루트 안에 있음 | `TMPDIR`(Windows 는 `TEMP`)을 루트 밖으로 바꿔 다시 실행 |

## 출처(조사한 것)

| 주제 | 확인한 사실 | 출처 |
|---|---|---|
| 첫 브랜치 | `git init -b` 와 `init.defaultBranch` 는 git 2.28 부터 | https://git-scm.com/docs/git-init |
| 무시 규칙 우선순위 | 같은 파일 안에서는 뒤 줄이 이김, `!` 로 다시 넣음 | https://git-scm.com/docs/gitignore |
| 신원 추정 막기 | `user.useConfigOnly` 면 설정 없이 신원을 추정하지 않음 | https://git-scm.com/docs/git-config |
| 추적 후보 | `ls-files -o --exclude-standard` 는 무시되지 않은 미추적 파일, 하위 저장소는 `경로/` 한 줄 | https://git-scm.com/docs/git-ls-files, 실측(git 2.43) |
