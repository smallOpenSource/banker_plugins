# Changelog

## [Unreleased]

### Added
- **`3d-intro-build` 의 영상을 WAN 키 풀로 만들고, 풀이 소진되면 Sora-2 로 폴백한다.** 새 공유 모듈 `references/video-pool.mjs` 의 `generateClip` 이 모든 leg 의 진입점이다.\
  WAN(Alibaba Cloud Model Studio, 기본 `wan3.0-video-prime`)은 `WAN_<n>_ENDPOINT`·`WAN_<n>_API_KEY` 를 개수 제한 없이 받아, 가장 오래전에 쓴 키부터 고른다. 할당량 소진(`AllocationQuota.*`·`Arrearage` 등)과 모델 권한 없음은 그 키를 24시간 쉬게 한다. 요청 속도 429 는 `Retry-After` 만큼 쉬게 할 뿐 퇴출하지 않고, `Throttling.AllocationQuota` 만 연속 3회면 1시간 쉬게 한다. `InvalidApiKey` 키는 제외한다. 상태는 `~/.config/banker/3d-intro/video-pool-state.json` 에 지문(엔드포인트, 키, 모델)으로만 남는다.\
  같은 leg 는 두 번 과금하지 않는다. 다른 키로 다시 내는 것은 첫 제출이 task 를 만들지 않은 게 확실할 때뿐이다(서버의 거절, 요청을 보내기 전 연결 실패, 키 할당량이나 알려진 일시 오류로 FAILED 나 CANCELED 된 task). 처음 보는 코드나 코드 없이 끝난 task 는 입력 탓이거나 과금됐을 수 있어 다시 내지 않고 `taskId` 를 담아 멈춘다. 폴링 시간 초과와 다운로드 실패도 `taskId` 를 담아 멈추고, 제출 중 연결이 끊기면 task 가 생겼는지 콘솔에서 확인하라며 멈춘다. 끝나지 않은 task 는 `resumeClip` 으로 새 제출 없이 마저 받는다. Sora job 이 사라졌으면(4xx) `resumeClip` 은 첫 폴링에서 멈추고, Sora 크레덴셜이 없거나 endpoint 가 URL 이 아니면 보내기 전에 멈춘다.\
  검열(`DataInspectionFailed`)과 `ModelNotFound` 같은 설정 오류는 다른 키나 Sora 로 넘기지 않는다. endpoint 나 모델이 형식에 맞지 않는 WAN 항목(URL 이 아닌 endpoint, 공백이 든 모델, 모델 칸에 붙인 키 등)은 건너뛰고, 모든 항목이 그렇다면 Sora 로 넘기지 않고 멈춘다. `poolSummary` 는 그 항목을 `malformed` 로 보고해, 유료 스틸을 만들기 전의 무료 점검에서 잡힌다. 형식이 잘못된 값과 네트워크 오류 문구는 출력과 오류 메시지에 싣지 않는다(키가 들어 있을 수 있음).\
  2026-10-09 실측: `wan3.0-video-prime` 480P 2초 클립 1개를 첫 프레임 data URI 로 만들어 97초에 받았고, 클립 첫 프레임과 입력 프레임의 SSIM 은 0.92 였다. WAN 은 첫+끝 프레임(`first_frame`·`last_frame`)도 받아 two-image 커넥터를 만들 수 있다(끝 프레임 경로는 UNVALIDATED).
- **`3d-intro-setup` 이 WAN 풀을 저장하고 무과금으로 검증한다.** 키마다 존재하지 않는 task 를 GET 해 200(유효)과 `401 InvalidApiKey`(무효)를 가른다. 남은 할당량은 조회 API 가 없어 확인하지 못한다. 형식이 잘못된 항목은 원래 값 대신 `BadEndpoint`, `BadModel` 로 보고한다.
- **`omc-patch` 스킬을 추가했다.** OMC 가 자동 업데이트되면 사라지는 로컬 훅 패치(훅 스크립트 최상위 `await import(...)` 의 10초 제한, `hooks.json` 의 `PostToolUse` 훅 제거)를 활성 버전에 다시 적용하고, OMC 마켓플레이스 `origin` 을 `omc-pinned://<원래 URL>` 로 바꿔 자동 업데이트를 막는다.\
  진단(`check`), 사용자 확인, `--no-update` 적용, 검증, 되돌리기(`revert`) 순서로 진행한다. 도구 `scripts/omc-patch.mjs` 는 정본에 두 가지 수정(헬퍼를 모듈 맨 앞에 둠, 마켓플레이스 폴더에 제 `.git` 이 있을 때만 고정)을 더한 사본이고, Node 18 이상과 `git` 이 필요하다. 첫 수정 전에는 최상위 `try { }` 블록이 둘 이상인 훅(OMC 5.6.x `project-memory-session.mjs`)에서 두 번째 import 가 조용히 실패했다. Codex 에서 실행해도 Claude Code 의 OMC 캐시만 다룬다.
- **`remains` 스킬을 추가했다.** 남은 버그, 하자, 미검증 항목을 찾아 표 하나로 보여 준다. 이번 대화에서 미검증이나 보류로 남긴 것, 인계 문서, 코드의 `TODO`, 건너뛴 시험, git 상태를 모으고 프로젝트의 시험을 돌린다. 읽기와 시험 실행만 하고 고치거나 커밋하거나 push 하지 않는다.\
  테스트박스를 `~/.config/banker/test-boxes.json` 에 등록하면(SSH 키 접속만, 비밀번호 칸은 거부) `scripts/boxes.mjs` 가 접속을 확인하고(`probe`) 같은 시험을 모든 박스에서 동시에 돌린다(`run`). 보내는 것은 추적 파일의 커밋된 내용뿐이고(줄 끝 변환 없음), `--ref worktree` 면 커밋하지 않은 변경도 보낸다. Linux, macOS 박스는 `mktemp -d` 로 만든 개인 폴더에서, Windows 박스는 명령을 `.cmd` 파일로 돌리고, root 로 접속하는 Linux 박스는 `runAs` 계정으로 돌린다. 박스에 둔 것은 끝나면 지우고, 시간 초과, 연결 끊김, 중단(SIGINT, SIGTERM) 때는 박스에서 시작한 프로세스를 먼저 끝낸다. 지우지 못하면 결과에 `cleaned: false` 로 알린다.
- **`trouble-shooting` 스킬을 추가했다.** 문제를 조사해 현상, 문제점, 원인, 해결방법, 조치계획을 세우고 표 하나로 간결히 보고한다(문제마다 한 행). `--no-plan` 이면 조치계획 없이 해결방법까지만 한다. 원인은 근거로 확인하고 확인하지 못한 원인은 추정과 확신 수준을 표시하며, 고치지 않고 보고만 한다.
- **`/progress` 명령을 추가했다(Claude Code 의 mod).** 진행 상황 패널을 켜고 끈다. `/progress` 와 `/progress show` 는 켜고 끄기를 번갈아 하고, `on` 과 `off` 는 그대로 켜거나 끈다. 다른 인자에는 사용법을 보여 준다. 작업 중에 입력해도 바로 실행된다.\
  단계는 Claude 가 쓰는 작업 목록(TaskCreate, TaskUpdate 나 TodoWrite)이다. 작업 목록이 없으면 이 세션의 요청 하나하나가 단계이고, 실행 중인 요청이 진행 중인 단계다. 아직 요청이 없으면 "진행 중인 작업 없음" 단계 하나를 보인다.\
  단계를 누르면 목록 아래에 간결한 설명(요청이나 작업 내용, 상태, 걸린 시간, 도구 호출 수)이 나온다. 화살표를 누르면 그 단계가 진행 중일 때 한 도구 호출(하위 에이전트 것 포함)이 한 단계 깊이로 펼쳐지거나 접히고, 최근 30개까지 보인다. 하위 항목을 눌러도 설명이 나온다.\
  mod 가 없는 Claude Code(2.1.250 에서 확인)에서는 `/progress` 가 `commands/progress.md` 로 가고, UserPromptExpansion 훅(`hooks/progress-fallback.mjs`)이 모델을 부르지 않고 "mod 를 지원하지않는 claude code 버전입니다" 만 보인다. 2.1.286 과 2.1.296 에서 패널, 토글, 마우스 누름을 확인했다. Codex 에는 이 명령이 없다.

### Fixed
- `/graceful-pause` 의 로그 줄이 플러그인 이름을 두 번 붙이지 않는다. 엔진이 플러그인 이름을 붙이는데 문구에도 `banker: ` 가 있어 `banker: banker: ...` 로 보였다.
- **`ralph-qa` 시험이 Windows, macOS 에서도 통과한다(시험만 바꿈).** 전에는 Windows 에서 40건, macOS 에서 2건이 실패했다. Windows 에서는 `verifier-probe` 시험의 가짜 세계가 파일과 폴더를 `\` 와 `/` 어느 쪽으로 찾아도 같게 본다(probe 는 실행 OS 의 규칙으로 경로를 붙인다). `gemini-seat` 시험은 임시 폴더의 실제 경로를 쓰고(macOS 의 `/var` 는 `/private/var` 링크), `.env` 시험 동안 계정 홈을 따로 만든 폴더로 두고(Windows 의 임시 폴더는 계정 홈 안) 두 홈(GEMINI_CLI_HOME, 계정 홈)의 `.env` 를 각각 확인한다. 긴 이름 시험의 가짜 경로는 임시 폴더가 있는 드라이브의 뿌리에서 시작한다.

### Changed
- **mod 모듈 `hooks/register.mjs` 가 기능들이 함께 쓰는 이벤트를 한 번씩만 건다.** 엔진은 matcher 없는 이벤트를 모듈 전체에서 한 번만 받는다. 그래서 `session.start`, `session.end`, `turn.start`, `turn.complete` 는 `register.mjs` 가 걸고 `/graceful-pause` 와 `/progress` 의 함수를 부르며, 두 명령의 등록도 `register.mjs` 가 한다. `/graceful-pause` 의 동작은 바뀌지 않았다.
- **`generateImage` 가 HTTP 429 에 `Retry-After` 만큼 기다렸다가 같은 경로로 다시 시도한다(기본 3회).** 전에는 429 에도 classic 경로로 넘어가 같은 한도에 다시 걸렸다. `azFetch` 결과에 `retryAfterMs` 를 더했다.
- **`parseEnvFile` 이 따옴표 없는 값에서 공백 뒤의 `#` 부터를 주석으로 지운다(`=` 바로 뒤도 같음).** 전에는 주석이 값에 붙어 endpoint, 키, 모델, `VIDEO_PROVIDER_ORDER` 가 깨졌다. 공백 없이 붙은 `#` 와 따옴표 안은 그대로 두고, `persistCreds` 는 그렇게 바뀔 값(공백 뒤 `#`, 앞뒤 공백이나 따옴표)을 따옴표로 감싸 써서 그대로 돌아오게 한다.
- **`pollVideo` 가 408, 429 를 뺀 4xx 에서 바로 멈춘다(오류에 `status`, `code`).** 전에는 사라진 job 도 `maxTicks` 까지 폴링했다. 폴링 사이에 주입한 `sleep` 을 쓰고, 오류 응답의 본문은 상태로 쓰지 않는다.
- `scripts/sync-adapter.js` 가 `azure-adapter.mjs` 와 `video-pool.mjs` 두 파일을 setup 스킬로 미러링하고 검사한다.

## [0.15.2] - 2026-10-07

### Fixed
- **lineage 3.0.2: 모든 페이지가 검토자 패턴으로 비밀을 가린다.** 0.15.1 까지 HTML 페이지(기본 흐름과 `--rulebase`)는 페이지 패턴만 써서, 파트 파일에서 가린 `curl -u 사용자:비밀번호`, `암호: 값`, Anthropic, OpenAI, Google 키 같은 값이 페이지에 그대로 남았다.\
  이제 페이지의 본문, 요약, 접힌 요약, 에이전트 이름, 세션 이름과 `--rulebase` 게이트 샘플, 기본 흐름 묶음이 검토자 패턴을 먼저 지난다. 검토자 패턴이 찾은 값은 `--redact-mode mask` 여도 전부 가린다. 규칙 요약은 가린 본문에서 잘라, 자른 자리에 비밀 조각이 남지 않는다. 페이지의 도구 이름에서도 `--redact-extra` 키워드를 가리고, 세션 제목에 키 모양(Anthropic, OpenAI 키 같은 것)이 있으면 출력 파일 이름을 세션 id 로 짓는다.\
  렌더 뒤 페이지를 다시 훑어 남은 것이 있으면 `the page still holds secret-like text` WARN 을 내고, 스킬은 이 WARN 을 사용자에게 알린다(마크다운으로 꾸민 `**Password**: 값` 처럼 패턴이 놓친 값). 그 값을 `LINEAGE_REDACT_EXTRA` 에 넣어 다시 만들면 가려진다(`--rulebase` 는 `--rebuild-summaries` 도 준다).\
  `--rulebase` 출력은 검토자 패턴에 걸리지 않는 턴에서 2.x 와 같다. 요약기 버전을 올려 0.15.1 까지 만든 요약 캐시는 쓰지 않는다. 묶음 형식이 바뀌어 0.15.1 이 만든 묶음은 `--emit-review` 부터 다시 한다. 검토자 결정 캐시는 그대로 쓴다.
- **lineage 검토자 패턴이 흔한 글을 덜 가린다.** `$PWD:/workspace`, `OLDPWD=/home/...`, `password=$DB_PASSWORD` 처럼 값이 경로나 변수인 꼴, 값 뒤의 마크다운 `**`, 표의 `|`, 닫는 백틱과 괄호, 공백 없는 JSON 인자 목록(`["docker","run","-u","1000:1000"]`), 인자 목록 안의 `host:/path` 를 가리지 않는다. 이미 가린 표식(`-u [REDACTED:JWT]`, `https://[REDACTED:GitHubPAT]@github.com`)과 값 전체가 마스크 꼴(`abcd****wxyz`)인 password 값도 다시 가리지 않는다.\
  `PGPASSWORD=`, `MYSQL_PWD=` 같은 환경 변수의 비밀번호는 그대로 가린다. 0.15.1 이 놓치던 두 겹 JSON 안의 `--user` 인자 목록도 가린다. `--redact-extra` 키워드가 가림 표식 이름을 깨지 않는다.
- **lineage 가 stdin 기록의 턴 id 로 비밀번호를 맞혀 볼 길을 두지 않는다.** `--from-transcript -` 로 넣은 기록의 턴 id 는 원문의 솔트 없는 해시라, 파트 파일을 읽는 모델이 id 로 약한 비밀번호를 맞혀 볼 수 있었다(3.0.0 부터).\
  이제 캐시 폴더의 무작위 키(`stdin-id.key`, 0600)로 HMAC 한다. stdin 으로 넣은 기록의 캐시는 한 번 다시 만들어진다.

## [0.15.1] - 2026-10-06

### Fixed
- **ralph-qa 외부 좌석에는 저자가 목록으로 고른 새 파일만 보낸다.** 0.15.0 은 추적하지 않는 새 파일을 모두 실어(`add -N .`) 작업과 무관한 파일까지 외부 프로바이더로 보냈다.\
  저자가 `$d/new-files.txt` 에 한 줄에 하나씩 적은 파일만 올리고, 보내지 않은 새 파일은 `unsent.txt` 에 남겨 보고한다. 올라갈 파일을 목록과 하나씩 비교해, 목록에 없는 파일(폴더 줄, `.`)이 있으면 그 경로를 찍고 멈춘다. diff 는 textconv, 외부 diff 드라이버, 색, 하위 저장소 내용 없이 원문으로 싣는다(git-crypt 같은 필터가 푼 평문, `color.ui=always` 의 색 코드, `diff.submodule=diff` 의 하위 저장소 내용이 실리지 않는다).\
  Claude Code 의 grep 함수 대신 시스템 grep 으로 세어, UTF-8 이 아닌 파일이 있어도 사슬이 사유 없이 멈추지 않는다. 사슬이 멈추면 사유를 찍고, 사유마다 다음 행동을 적었다. 512 KiB 를 넘는 페이로드는 묻고 보낸다. 관련 코드는 `sed -n` 범위로 붙인다. 인덱스 사본은 `cp -p` 로 만들어, 인덱스와 같은 초에 크기가 같게 바뀐 파일도 diff 에 담는다.
- **ralph-qa 좌석에 600초 상한을 둔다.** 좌석 명령은 `timeout -k 10 600`(macOS 는 프로세스 그룹을 끝내는 `perl` 명령)으로, 진입점이 띄운 작업 프로세스까지 스스로 끝난다. 그래도 끝나지 않으면 TaskStop 으로 멈춘 뒤 정리한다. 하위 에이전트로 돌면 정리를 마친 뒤 답한다.\
  첫 판정 뒤의 반복에서 페이로드를 만들지 못하면 그 좌석은 `ERROR` 다. 512 KiB 전송을 사용자가 거절하면 `model-declined` 다.
- **ralph-qa 정리가 늦게 쓴 기록과 끊긴 실행의 사본을 찾는다.** gemini 가 정리 뒤 다시 쓴 기록은 `projects.json` 으로 찾아 지운다. opencode 좌석 세션도 지운다. 끊긴 실행이 남긴 하루 지난 폴더는 1단계의 표지 파일(`.ralph-qa`)이 있을 때만 지워, 이름 꼴이 같은 사용자 폴더와 링크는 남는다.\
  0.15.0 이 끊긴 실행에서 남긴 사본에는 표지가 없어 이 규칙이 지우지 않는다. 기준 폴더(`$XDG_RUNTIME_DIR` 또는 `~/.cache`, macOS 는 `$TMPDIR`, PowerShell 은 `TEMP`)의 `ralph-qa.*`, `ralph-qa-out.*` 폴더를 확인해 손으로 지운다.
- **ralph-qa 비밀 검사기가 긴 줄에서 죽지 않고, 흔한 오탐과 미탐을 고쳤다.** 모든 반복에 상한을 둬 수백만 자 한 줄(data URI, 개인 키 머리 뒤의 긴 낱말 줄)도 끝까지 읽는다. 검사 중 예외는 exit 2 로 끝나 보내지 않는다.\
  `date -u +%H:%M`, `$(id -u):$(id -g)`, 값 전체가 uid:gid 인 `-u "1000:1000"`, Docker 비밀 파일 경로(`*_FILE`), go.sum 과 Terraform 의 `h1:` 해시는 비밀로 보지 않는다. `-u "4242:2024!Winter"` 처럼 숫자로 시작하는 비밀번호는 잡는다.
- **ralph-qa 프로브가 codex 설정을 끝까지 바르게 읽는다.** 주석의 U+2028, U+2029 뒤 줄을 놓치지 않는다. 읽지 못한 줄이 있거나 관리 설정 파일을 끝까지 읽지 못하면 좌석을 세우지 않는다. 프로브는 opencode 를 띄우지 않는다(1.3.10 은 시작할 때 캐시를 비울 수 있다).
- **lineage 3.0.1: 검토자에게 가는 비밀을 더 가리고, 품질 게이트 재실행을 바로잡았다.**\
  검토자와 critic 이 읽는 파트 파일과 샘플에서 Basic 인증의 여러 꼴(첨자 대입, `=>`, 헤더 설정 호출, HAR, nginx)과 curl `-u` 의 여러 꼴(`-su`, `-4u` 묶음, 따로 감싼 `"user":"pw"`, 따옴표 친 명령 속의 이스케이프한 따옴표, `${API_USER}:pw`, 인라인 코드와 괄호 안, 인자 목록, 빈 사용자나 빈 비밀번호)을 가린다. `date -u`, `$(id -u):$(id -g)`, uid:gid, 양쪽이 변수인 꼴은 그대로 둔다(공백 없는 인자 목록 안에서는 가린다).\
  게이트를 두 번 돌려도 페이지는 하나다. 판정 경로 없이 다시 돌려 FAIL 을 지나치지 않는다. 기본 흐름은 `--reviewer-timeout` 을 주지 않으면 판정을 기다리지 않는다. 판정 경로의 사용자 파일은 덮지 않고 다시 쓰라고 안내하지도 않는다. `idx` 항목이 없는 판정 배열은 critic 에게 다시 판정시키라고 안내한다.\
  결정 파일은 1,000,000 바이트, 배열 시작 후보 200곳까지만 읽는다. 검토자가 사용자가 입력한 턴을 빼면 WARN 으로 알린다.\
  기본 흐름의 HTML 페이지는 아직 검토자 패턴을 쓰지 않아, 페이지 쪽 가림이 놓친 `curl -u 사용자:비밀번호` 같은 값이 페이지에 남을 수 있다(3.0.0 부터). 다음 릴리스에서 고친다. 공유 전에 페이지를 확인한다.

## [0.15.0] - 2026-10-06

### Added
- **`/graceful-pause` 명령을 추가했다.** Claude Code 2.1.289 이상에서 function hooks(`hooks/register.mjs`)로 등록하는 즉시 명령이라, 작업 중에 입력해도 턴이 끝나기를 기다리지 않고 바로 실행된다. 그보다 오래된 엔진에서는 등록하지 않고 한 줄로 알린다.\
  실행되면 사용자에게 보이지 않는 사용자 메시지 1개를 대화에 추가하고(`$.session.append`), 진행 중인 작업은 실행 중인 도구 호출이 끝난 뒤 다음 모델 요청에서 그 메시지를 읽는다. 메시지에는 정지 절차가 들어 있다: 지금 단계만 마무리, 다음 단계 시작 금지, 정지 보고, `AskUserQuestion` 으로 지시 대기.\
  마지막 답변 도중에 입력해 메모가 읽히지 않은 채 턴이 끝나면 무효 메모를 덧붙여 다음 지시를 가로채지 않게 한다. 쉬는 중이면 진행 중인 작업이 없다고 답한다. 백그라운드 작업이나 예약 실행(`/loop`, ScheduleWakeup)이 남아 있으면, 그 결과가 다음 단계를 시작하지 않도록 메모를 사용자 메시지로 따로 보내 정지 보고를 받는다. 같은 턴에 다시 입력해도 메모는 한 번만 들어간다. `/clear` 하면 진행 중이던 턴의 기록을 비운다.\
  실행 중인 도구 호출을 끊지는 않으며, 바로 끊으려면 지금처럼 Esc 를 쓴다.

- **`setup-bypass-permissions` 스킬을 추가했다.** Claude Code 전역 `settings.json` 의 `permissions.defaultMode` 를 `bypassPermissions` 로 바꿔, 모든 세션에서 도구 실행 확인을 끈다.\
  모델은 이 스킬을 부를 수 없다(Claude Code 는 `disable-model-invocation`, Codex 는 `agents/openai.yaml` 의 `allow_implicit_invocation: false`). 사용자가 직접 입력해야 실행되고, 켜기 전에 위험 경고를 보여 준 뒤 명시적인 확인을 받는다. 무응답, 시간 초과, 다른 에이전트나 도구가 전한 동의는 확인으로 보지 않는다.\
  `off` 는 켜기 전 값으로 되돌리고, 켜기 전에 없던 `skipDangerousModePermissionPrompt` 도 지운다. `status` 는 현재 값과 켜기를 막는 요인을 보여 준다.\
  적용은 노드 스크립트(`scripts/bypass-permissions.mjs`)가 한다. 다른 키와 BOM, 파일 모드, 링크를 그대로 둔 채 파일을 통째로 교체하고, 켜기 전 내용을 이 계정만 읽는 `.bypass-permissions.bak` 에 남긴다. `node` 를 쓸 수 없으면 OS 별 폴백(`scripts/fallback/` 의 python3, PowerShell 스크립트)을 쓴다. 이 계정이 파일에 쓸 수 없거나 도구 실행이 막히면, 사용자가 Claude Code 밖에서 실행할 명령을 준다. 도구 실행이 막혔을 때는 다른 도구나 경로로 다시 시도하지 않는다.\
  관리 정책(`managed-settings.json` 과 `managed-settings.d`)이 막거나 이 계정이 그 정책을 읽을 수 없을 때, 설정 파일 자체의 `disableBypassPermissionsMode`, root 계정(`IS_SANDBOX=1` 도, 참 값의 `CLAUDE_CODE_BUBBLEWRAP` 도 없을 때. Claude Code 2.1.289 와 같은 조건), Claude Code 설정 폴더가 없는 머신에서는 켜지 않는다.\
  `/banker:setup` 목록에서는 따로 묻는 주의 항목이고 기본으로 선택되지 않는다. 고르면 사용자에게 명령을 직접 입력하라고 안내한다. 폴백 스크립트는 테스트가 직접 실행한다(python 3.6, pwsh 7. Windows PowerShell 5.1 은 CI 의 windows 잡에서만 확인).

### Removed
- **`graceful_pause` 스킬을 뺐다.** 스킬과 플러그인 명령은 작업 중에 입력하면 턴이 끝날 때까지 대기열에 머물러, 정작 필요한 순간에 동작하지 않았다. 같은 이름의 스킬이 있으면 엔진이 즉시 명령 등록을 거부하므로 새 명령 이름은 `/graceful-pause`(하이픈)다.\
  플러그인을 업데이트하면 옛 스킬이 사라지고, Codex 는 `banker setup --codex` 때 `banker-graceful_pause` 가 정리된다. Codex 에는 즉시 명령 장치가 없어 대응 기능이 없다.
- **`ralph-qa` 의 GPT, Gemini API 크리덴셜 좌석과 `--external`, `--model` 을 뺐다.** 외부 모델은 좌석 플래그 값(`--codex=<model>` 등)으로 준다.

### Fixed
- **스킬과 명령 설명 앞의 `(banker)` 를 뺐다.** Claude Code 자동완성은 플러그인 스킬 설명 앞에 플러그인 이름을 스스로 붙여서, `/banker:curation  (banker) (banker) 의사결정을...` 처럼 두 번 보였다. Codex 사본은 이름이 `banker-<이름>` 이라 표시가 따로 필요 없다. smoke 가 설명이 `(banker)` 로 시작하지 않는지 확인한다.

### Changed
- **스킬과 명령 설명을 tone-compact 문체 규칙에 맞췄다.** 설명 60개(스킬 57, 명령 2, `/graceful-pause`) 가운데 규칙을 어긴 설명만 고쳤다.\
  가운뎃점, 화살표, em dash 같은 장식 기호는 쉼표나 조사로 바꾸고, 명사 4개 이상 연속과 `A=B`, `+` 같은 약식 표기를 풀어 썼다. 영어 일반 단어는 한글로, 파일 이름과 플래그와 명령은 코드 표기로 바꿨다.\
  트리거 문구, 조건과 한정어, 같은 파일 본문의 용어(드리프트, 노이즈, resume 프롬프트 등)는 그대로 두었고, 가운뎃점으로 묶인 트리거는 빠짐없이 나눴다. 이미 규칙을 지키던 설명과 줄 끝 문자는 바꾸지 않았다.\
  smoke 가 설명마다 장식 기호와 유사 기호, 그림 문자, 느낌표, 번역투(활용형 포함), 25단어 넘는 문장, 여러 줄 YAML 을 검사한다. 코드 구간은 원문이라 기호와 번역투 검사에서 뺀다(25단어 검사는 코드 구간의 단어도 센다).
- **`ralph-qa` 검증자 구성을 바꿨다.** 세션 모델로 띄운 독립 검토 에이전트 3개 이상이 조건 없이 합의 루프를 돈다(`--agents=N`, 3 미만은 3으로 올림). Claude Code 는 `Plan` 을 `model` 없이 띄우고, Codex 는 `spawn_agent` 를 역할 없이, 저자 대화를 넘기지 않고 띄운다. `Explore` 는 정의가 코드 리뷰 용도를 금하고 세션 모델이 Opus 보다 위면 Opus 로 돌아 쓰지 않는다. 검토자는 파일을 고치지 않고, 게이트(테스트, smoke)는 저자가 돌려 원문 출력을 넘긴다.\
  외부 좌석은 `--codex`, `--gemini`, `--opencode` 를 줄 때만 앉고, 그 CLI 에서 쓸 수 있는 가장 뛰어난 모델을 쓴다(codex 는 내장 카탈로그 1위, gemini 는 `pro` 별칭). 모델은 로컬 설정과 CLI 내장 목록으로 정하며, 프로브는 HTTP 요청과 프롬프트를 보내지 않는다. 무엇이 가장 뛰어난지 알 수 없거나 후보가 여럿이면 선택지로 묻고(opencode 는 순위가 없어, 설정 모델 말고는 돌릴 모델이 없을 때만 채택한다), 물을 수 없는 실행이면 CLI 설정의 기본 모델로 앉힌 뒤 그 사실과 다른 후보를 보고한다.\
  저자 계열 모델은 이름 어디에 계열 표시가 있든 외부 좌석에 앉지 않는다(Codex 런타임의 `--codex` 는 자기 자신). 런타임을 모르면 claude 와 gpt 를 모두 빼고, 이름으로 계열을 읽지 못한 모델은 스스로 고르지 않는다.\
  외부 좌석에는 페이로드를 명령줄 대신 파일로 넘기고(원문 부분은 재지정으로 붙인다. diff 는 임시 인덱스로 만들어 추적하지 않는 새 파일도 담는다), 보내기 전에 `references/payload-scan.mjs` 로 비밀처럼 보이는 문자열을 찾아 가린다. 좌석마다 이 계정만 쓰는 폴더 아래 페이로드 사본 하나만 든 폴더에서 띄우고, 답은 다른 폴더로 받는다.\
  codex 는 읽기 전용 샌드박스에 더해 셸 도구(샌드박스는 셸의 읽기를 막지 않는다)와 그 밖에서 도는 사용자 실행 정책 규칙, MCP 서버, 하위 에이전트, 훅, 알림 프로그램(`notify`), 웹 검색, 사용량 지표 전송, OpenTelemetry 내보내기를 끄고 띄운다. 끌 수 없는 MCP 서버가 있거나, 관리 설정(`/etc/codex/managed_config.toml`)이 그 키를 정하거나, 요구 파일(`/etc/codex/requirements.toml`)이 좌석 값을 허용하지 않으면 좌석을 세우지 않는다.\
  gemini 는 모든 도구를 막는 관리자 정책(`references/gemini-read-only.toml`)으로, MCP 서버와 확장, 텔레메트리의 프롬프트 기록 없이 띄운다. 자체 샌드박스(`tools.sandbox`)는 `GEMINI_SANDBOX=false` 로 끈다. 켜 두면 자체 샌드박스 안에서 다시 뜨고(docker, podman 컨테이너. macOS 는 `sandbox-exec`), 컨테이너 안에는 정책 파일이 없어 도구가 열린다. 새 `references/gemini-seat.mjs` 가 보내기 전에 정책 파일과 홈 밖 상위 폴더의 `.env` 를 확인하고, 끝나면 gemini 가 홈 폴더에 남긴 좌석 기록(페이로드 전문)을 지운다. 앞서 끊긴 실행의 기록도 지운다. API 오류 보고(요청 전문)는 `TMPDIR` 을 답 폴더로 두어 그 폴더에 남긴다. 작업 공간을 넓히는 gemini 설정(`context.includeDirectories`, IDE 모드)이 있으면 좌석을 세우지 않는다. opencode 는 실행마다 이름이 다른 전용 검토 에이전트로 모든 도구를 막고 자동 압축을 끈 채, 페이로드를 표준 입력으로 받는다(첨부는 50 KB 에서 잘린다). 셸 문법이 될 수 있는 문자가 든 모델 이름은 버린다.
- **`lineage` 의 기본 흐름을 세션 모델 검토로 바꿨다(스킬 3.0.0).** 규칙 요약은 긴 답변의 앞뒤 문장을 이어 붙여, 결론 대신 도입이나 맺음말을 고르곤 했다.\
  이제 스크립트가 규칙으로 1차 정리한 턴을 검토 묶음으로 내보내고(`--emit-review`), 40턴 이하로 고르게 나눈 파트마다 세션이 검토 에이전트를 띄워 턴마다 남길지와 1줄 요약을 정한다. `--apply-review` 가 그 결정으로 HTML 을 만든다.\
  검토자는 세션 모델로 돈다. Claude Code 는 `Plan` 을 `model` 없이 띄우고(`Explore` 는 검토 용도가 금지되고 세션 모델보다 낮게 돌 수 있어 쓰지 않는다), Codex 는 `spawn_agent` 를 역할 없이 띄운다. 파트가 6개를 넘으면 진행 전에 묻는다. 파트 하나에 검토 에이전트 1개가 돈다(이 저장소 실측: 40턴 파트에 약 11만 토큰, 7분). Codex 검토자에게는 파일 읽기 도구가 없어, 파트 파일을 읽는 셸 명령만 쓰게 한다.\
  규칙이 확실한 노이즈는 묶음 전에 빠지고, 규칙이 판단한 것(에코 교환, 도구만 쓴 턴)은 표시만 해 검토자가 확정하거나 되살린다. 범위 인자(`--last`, `--turns`)는 규칙이 남기는 턴으로 세어 `--rulebase` 와 같은 턴을 고른다.\
  묶음과 파트 파일에는 redact 된 본문만 들어가고 0600 으로 쓴다. 검토자가 읽는 파트 파일은 `--redact-mode mask` 여도 값의 일부를 남기지 않고, 페이지에는 없는 키 패턴(URL 자격 증명, Bearer 토큰, 따옴표 친 꼴을 포함한 Basic 인증 헤더, 붙여 쓴 꼴을 포함한 curl `-u`)도 키를 통째로 가린다. 파트의 규칙 요약은 가린 본문에서 만든다. `--redact-extra` 키워드 목록은 파일에 쓰지 않고, 파트 파일에서는 도구 이름의 키워드까지 가린다. 검토자 요약은 캐시를 거쳐 다음 검토자에게 다시 가므로, `--redact-mode` 와 관계없이 키를 통째로 가린 뒤 120자로 자른다. 렌더가 성공하면 묶음, 파트, 결정 파일을 지운다.\
  품질 게이트 인자(`--skip-reviewer`, `--reviewer-output`, `--reviewer-timeout`)는 `--emit-review` 에 준 값이 `--apply-review` 까지 간다. 기본 흐름의 게이트는 `--reviewer-output` 을 줄 때만 돌고, `--apply-review` 를 전경으로 두 번 실행한다(첫 실행이 샘플을 쓰고 멈추면 critic 판정을 쓴 뒤 다시 실행). 샘플은 같은 턴이면 같은 턴을 뽑고 파트 파일 기준으로 가리며(요약도 가린 본문에서 만든다), 샘플마다 턴 id 와 내용 지문(`key`)이 붙는다. 판정은 샘플마다 하나씩, 그 샘플의 id 와 key 를 담아야 통과한다. 그래서 결정을 고치기 전 샘플에 대한 늦은 판정은 통과하지 못한다. 읽은 판정 파일은 `.used` 로 옮겨 다시 실행할 때 새 판정을 기다리고, 샘플이 바뀌면 그 전에 있던 판정 파일은 읽지 않는다. 판정 경로에 판정 목록이 아닌 것(사용자 파일, 폴더)이 있으면 샘플을 쓰기 전에 멈추고 그 파일을 건드리지 않는다. critic 은 검토자와 같은 세션 모델 하위 에이전트이고, 샘플을 프롬프트 본문으로 받아 도구를 쓰지 않는다. 띄울 수 없으면 세션이 스스로 판정하지 않는다. FAIL 과 판정 범위 오류가 합쳐 두 번 이어지면 세션이 멈추고 사용자에게 묻는다. `--keep-trivia`, `--keep-tool-only` 는 검토자의 `keep: false` 보다 앞선다. 검토자 결정은 캐시되어, 다음 실행에서는 본문, 규칙 결정, keep 플래그가 바뀐 턴만 다시 검토한다(캐시 폴더에 쓸 수 없으면 WARN).\
  2.x 의 한 번 실행(규칙만, 모델 호출 없음)은 `/lineage --rulebase` 다. 스크립트를 리뷰 인자 없이 부르면 출력(HTML, stdout, stderr)이 예전과 같고, 2.0.0 출력과 바이트 단위로 같은지 테스트가 고정한다. 출력 밖의 차이는 셋이다: 게이트 샘플 파일을 0600 으로 쓰고, 캐시 폴더에 쓸 수 없으면 traceback 대신 WARN 을 내고 계속한다. 기록의 턴 id 와 세션 이름으로 캐시 파일 이름을 만들 때 영숫자, `_`, `.`, `-` 밖의 글자는 `_` 로 바꾼다. 조작한 id 로 캐시 밖에 파일을 쓰지 못하고, 그런 이름의 기록은 캐시를 한 번 다시 만든다.
- **`harness-factory` 스킬 이름을 `setup-harness-factory` 로 바꿨다.** 다른 설치 스킬(`setup-*`)과 이름을 맞췄다. 호출은 `/banker:setup-harness-factory`, Codex 는 `banker-setup-harness-factory` 다.\
  플러그인을 업데이트하면 옛 이름은 사라진다. Codex 는 `banker setup --codex` 때 `banker-harness-factory` 를 정리하고 새 이름으로 설치한다. `/banker:setup` 목록의 항목 이름도 바뀌었다.
- **`setup-omc-hud` 가 Claude Code 갱신 안내를 상태표시줄 맨 끝으로 옮긴다.** 새 Claude Code 가 나오면 OMC 5.6.1 HUD 는 `[Claude#2.1.288] -> 2.1.289 claude update` 를 띄우는데, omc_hud 래퍼는 이 안내를 구판에서는 버리고 최신판에서는 경로 앞 줄 중간에 흐리게 둔다.\
  적용 단계 끝에 `scripts/claude-update-last.mjs on` 을 실행해, 래퍼가 세그먼트를 합치기 직전 줄(`let result = colored.join(SEP);`) 앞에 블록 1개를 넣는다. 블록은 안내를 원래 자리에서 빼 OMC 표시 뒤 맨 끝에 흐리게 붙이고, 안내가 없으면 아무것도 하지 않는다. OMC 가 2번째 줄에 따로 띄우는 `[!] claude <버전> - paste: ! claude update` 는 그대로 남는다. OMC `safeMode` 를 꺼 공백이 U+00A0 으로 바뀐 안내도 찾는다.\
  payload-mon 과 같은 규칙을 따른다. 바꾸기 전 내용은 `.claude-update-last.bak` 에 남기고, `node --check` 를 통과하지 못하는 결과는 쓰지 않으며, 개수나 순서가 맞지 않는 표시와 낯선 래퍼는 거부하고, `off` 는 블록만 빼서 바이트 그대로 되돌린다. payload-mon 블록과는 서로 건드리지 않는다.

## [0.14.0] - 2026-10-04

### Added
- **`tone-compact` 스킬을 추가했다.** 답변과 새 문서를 ASD-STE100 기반의 간결한 한글 개조식으로 쓰게 하는 문체 규칙을 켜고 끈다(인자가 없으면 `on`).\
  규칙은 단어 중심 개조식, 줄글 대신 표, 문장 속 나열 대신 세로 목록, em dash 대신 하이픈, 직접 만든 약어·이모지·장식 기호·감탄사 금지, 어색한 번역어 대신 원어의 한글 발음 표기다. 줄여 쓰더라도 부정어는 지우지 않고, 보안 경고·되돌리기 어려운 동작의 확인·순서가 중요한 절차는 완전한 문장으로 쓴다.\
  켜짐 상태는 `off` 할 때까지 모든 세션에 남는다. Claude Code 는 `<설정 폴더>/rules/banker-tone-compact.md`(세션 시작과 compaction 뒤 자동 로드), Codex 는 전역 지침 파일(`AGENTS.override.md` 에 블록 말고도 내용이 있으면 그쪽, 없으면 `AGENTS.md`) 끝의 블록 1개다. 이 블록은 `USER:OMX:POLICY` 표시로 감싸 `omx setup --merge-agents` 와 기본 `omx setup` 이 파일을 다시 써도 남는다(`--force`, 덮어쓰기 확인, team 모드를 끈 `omx setup` 은 파일을 새로 만들므로 그 뒤 `on` 을 다시 실행). `off` 는 켜기 전 바이트 그대로 되돌린다.\
  표시는 한 줄 전체로 시작과 끝이 차례로 와야만 블록으로 인정한다. 문장 속에 인용된 표시가 있으면 `on`·`off` 모두 거부해, 사용자의 다른 지침을 잘라 내지 않는다. UTF-8 이 아닌 지침 파일(CP949, UTF-16)도 손대지 않고 거부한다. 글자로 읽어 다시 쓰면 원래 바이트를 잃기 때문이다.
- **`graceful_pause` 스킬을 추가했다.** 진행 중인 작업을 지금 단계까지만 마무리하고 멈춘 뒤, 상태를 보고하고 중간 지시를 기다린다.\
  `cancel` 과 달리 켜져 있는 모드(ralph·autopilot·ultragoal·team)와 계획을 그대로 두어, 지시를 받은 뒤 같은 흐름으로 이어 간다. 작업 중에 대기 입력으로 넣어 두면 그 입력이 읽히는 시점에 동작하며, 즉시 끊지는 않는다.\
  Claude Code 는 `AskUserQuestion` 으로 묻고, 질문이 열려 있는 동안은 지속 모드가 끼어들지 않는다. Codex 에서 질문 도구 없이 지속 모드가 켜져 있으면 OMX Stop 훅 때문에 응답을 끝내도 멈출 수 없으므로, 그 사실을 알리고 계속할지 `cancel` 할지 묻는다.
- **`payload-mon` 스킬을 추가했다.** OMC HUD 상태표시줄의 ctx 옆에 현재 세션의 API 요청 payload 추정치(32MB 한도 대비, 8MB부터)를 켜고 끈다.\
  블록은 래퍼의 ctx 줄 뒤 하나라 구판과 최신 omc_hud 래퍼 모두에 들어가고, 추정 모듈은 래퍼 옆 사본을 불러와 플러그인 업데이트로 옛 버전 경로가 정리돼도 표시가 유지된다. 추정치 캐시는 계정별 폴더에 소유를 확인한 뒤에만 쓴다. `setup-omc-hud` 는 HUD 를 다시 깔 때 켜져 있던 payload-mon 을 다시 켠다.
- **`curation --deep` 을 추가했다.** `--perf` 처럼 품질을 우선하되, 확신 0.80 이하인 결정은 조사(코드·문서·웹·안전한 실측)와 검토(가장 강한 반대안, 가능하면 독립 검토자)를 더 해 0.80 초과로 올린 뒤 제시한다.\
  결정마다 최대 3회차이고 새 증거가 없으면 멈춘다. 그래도 미달이면 확신을 부풀리지 않고, 판단을 막는 변수를 사용자 질문으로 바꿔 내놓는다. 결과에는 결정별 조사 이력이 붙는다.

### Fixed
- **OMC 5 에서 `all-in-one` 이 멈추던 문제를 고쳤다.** 원인은 두 가지였다.\
  첫째, 3단계가 부르던 `ultraqa` 가 OMC 5.0.0 에서 대체 이름 없이 삭제됐다. 공식 대체인 `verify` 는 증거만 모으고 고치지는 않으므로, 3단계를 독립 verifier → architect 진단 → executor 수정의 순환(최대 5회, 같은 실패 3회면 중단)으로 직접 돌린다. 변경 전부터 있던 실패(`ralph` 가 기록한 기준선)는 보고만 하고 게이트에서 막지 않는다. Codex 는 OMX 가 아직 제공하는 `ultraqa` 를 그대로 쓴다.\
  둘째, OMC 5 의 `ralph` 는 첫 반복에 `omc ralph verify` 를 실행하고 없으면 멈추는데, 플러그인보다 낡은 전역 `omc` CLI(4.x)에는 이 명령이 없다. 4.x 는 모르는 명령에도 도움말을 찍고 종료 코드 0 을 내므로, 사전 점검을 종료 코드가 아니라 출력 문구로 판정하게 바꿨다.
- **`ralph` 인계에 OMC 5.6.1 의 함정 두 가지를 반영했다(`all-in-one`·`ultra-init`).**\
  `omc ralph verify` 는 피드백 명령 출력의 모든 줄을 서명으로 남기고 `<숫자><단위>` 꼴 시간만 지운다. 그래서 node:test 기본 출력의 `ℹ duration_ms 151.4` 와 `ℹ tests 8` 줄 때문에 코드를 바꾸지 않아도 매번 새 실패가 된다. 기준선을 기록하기 전에 실패만 출력하는 명령(node:test 는 `FORCE_COLOR=0 NODE_NO_WARNINGS=1` 과 `--test-reporter=dot`, 점 줄 필터)을 PRD `feedbackCommands` 로 정하게 했다. 색상이 켜진 환경에서는 점 줄에 색상 코드가 섞여 필터를 지나가므로 두 변수가 필요하다. 또 `ralph` 가 작업 설명에 `repoQualityClass` 가 없으면 사용자에게 묻기 때문에, 저장소 신호로 추론해 넘기게 했다.\
  QA 게이트에 들어가기 전에 QA 명령을 변경 전 트리에서 한 번 실행해 사전 실패를 기록한다(Codex 의 OMX `ralph` 에는 기준선이 없어 이것이 유일한 기준선이다). 사전 실패는 이 기록이나 `ralph` 기준선(같은 세션의 `omc ralph verify --json`, `baselinePresent: true` 확인)에 있는 것뿐이고, 나머지는 모두 새 실패다. 변경 전 상태를 만들려고 `git stash`·`git reset` 을 쓰지 않는다.
- **`ultra-init` 에서 ultragoal 원장 단계를 뺐다.** OMC 5.6.1 의 `omc ultragoal checkpoint` 는 `complete-goals` 로 시작한 목표에만, 그 목표가 켜는 Claude Code `/goal` 의 스냅샷과 함께 기록된다. `/goal` 을 켜면 ralph 옆에 Stop 훅 루프가 하나 더 생기므로, 마지막 기록 단계가 반드시 실패하던 구성을 계획 파일과 ralph PRD 로 이어 가는 구성으로 바꿨다. `--plan-id` 는 함께 없어졌다.
- **같은 원인이 있던 곳도 고쳤다.** `ultra-init`(`ultraqa`·`ultrawork` 참조와 CLI 점검), `/banker:front-qa`(CLI 점검), `setup-omc`(의존 설명과 CLI 만 따로 올리는 방법), `omc-reference`(OMC 5.6.1 기준 스킬·에이전트·키워드·삭제 목록, plan/review 의 플러그인 이름, Team 도구 변화, OMX 0.20.2 목록), `rfp-author`(삭제된 `deep-dive` → `research`). CLI 점검은 Claude Code 에만 걸고, Codex 는 `omx --version` 으로 확인한다.

### Changed
- **`ready-compact` 가 resume 프롬프트만 출력한다.** 최종 메시지가 펜스도 앞뒤 설명도 없는 프롬프트 본문뿐이라, `/copy` 한 번이면 프롬프트만 복사된다(이전에는 설명이 섞여 `compact-copy` 를 거쳐야 했다). 메시지에 코드 블록이 있으면 `/copy` 가 선택 창을 띄우므로 프롬프트 안에도 펜스를 쓰지 않는다. 저장에 실패하면 별도 보고 대신 프롬프트 둘째 줄에 경고가 붙는다.\
  지속 모드(ralph 등)의 Stop 훅이 프롬프트 뒤에 계속하라는 메시지를 넣으면, 작업을 다시 시작하지 않고 같은 프롬프트를 다시 낸다. 그래야 마지막 메시지가 프롬프트로 남는다.
- **`ready-compact --hand-off` 를 추가했다.** 같은 세션의 `/compact` 가 아니라 새 세션에서 처음부터 이어 가도록 준비한다.\
  새 세션에는 이번 대화가 없으므로, 노트에 작업 위치(절대경로·브랜치·마지막 커밋), 대화에서 정한 결정과 이유, 켜져 있는 모드와 상태 파일, 그 모드를 새 세션에서 다시 켜는 방법, 실행 중인 백그라운드 작업까지 옮기고, `[HANDOFF]` 프롬프트가 그 노트를 먼저 읽게 한다. 지속 모드가 켜져 있으면 유지할지 cancel 할지 먼저 묻는다. 노트는 Claude Code 에선 자동 메모리 폴더(꺼져 있으면 `.omc/handoffs/`), Codex 에선 작업 폴더의 `.omx/handoffs/` 에 둔다. 같은 머신의 새 세션이 대상이며, 다른 머신으로 넘길 때는 결정과 이유를 프롬프트에 직접 넣는다.
- `compact-copy` 는 이제 설명과 코드펜스가 섞인 이전 형식의 출력에서 프롬프트를 뽑을 때만 필요하다. `[HANDOFF]` 프롬프트도 인식한다.
- `graceful_pause` 는 세션을 끝내려는 사용자에게 `ready-compact --hand-off` 를 안내한다.
- `smart-compact` 는 `compact-copy` 를 더 거치지 않는다. TUI 3단(`/copy` → `/compact` → 붙여넣기) 안내를 `ready-compact` 앞에 한 줄로 하고, 마지막 메시지를 프롬프트로 끝낸다.
- `refresh-readme` 의 개수 점검 예시를 특정 숫자에 묶지 않게 바꿨다.

## [0.13.0] - 2026-08-12

### Changed
- **`ralph-qa` 의 검증자 구성을 "우선순위 사다리"에서 "백본 + 좌석"으로 뒤집었다.**\
  이전에는 Codex CLI → 다른 모델 `curl` → 다중 에이전트 순으로 **사용 가능한 첫 경로 하나**만 썼고, 다중 에이전트는 다른-LLM 경로가 전무할 때만 도는 최종 수단이었다. 이제 **다중 에이전트 백본(`model: opus`, `--agents` 기본 3)이 조건 없이 항상 돌고**, 설치돼 있으면서 실제 유효성이 관측된 외부 LLM(Codex CLI · Gemini CLI · GPT/Gemini API)만 **각 1좌석**으로 합류한다. 외부 좌석의 부재는 실패나 열화가 아니라 "모델 축이 이번 실행에서 안 덮였다"는 커버리지 사실이다.\
  유효성은 **0토큰 HTTP 프리플라이트**(`references/verifier-probe.mjs`, provider `GET /models`)로 판정한다 — 설치 여부(`command -v`)와 유효 여부는 다르고, `codex login status`·`~/.codex/auth.json` 은 **거짓 음성**이라 근거로 쓰지 않는다(둘 다 미로그인이라 답하면서 codex 가 정상 동작하는 경우가 있다). 검증 실호출을 프로브로 쓰면 왕복 1회에 2만 토큰이 넘게 든다.\
  정족수는 좌석 **생애주기 전체**에 단조성을 건다: `내부 좌석 ≥ 1 ∧ 내부 과반 ∧ 실증된 외부 비-APPROVE 0 ∧ 미해소 blocker 0 ∧ ERROR 0 ∧ 좌석 상실 0`. 좌석 식별자를 `(종류, 렌즈)` 로 정의하고 반복 간 `S_k ⊆ S_{k+1}` 을 요구해 **좌석을 새로 굴려 반대를 지우는 경로**를 닫았고, 종결에 `INCONCLUSIVE` 를 더해 좌석이 사라지는 모든 경우를 APPROVE 밖으로 배출한다. `INCONCLUSIVE` 는 통과가 아니며 원인별 다음 행동이 규정된다.
- **`--effort` 를 외부 좌석(api·codex) 전용으로 축소했다.** 이전 표기는 전 경로에 적용되는 것처럼 보였지만 실제로는 아무 데도 전달되지 않았다.\
  백본 쪽 사정은 이렇다: **호출 단위** 지정 경로는 없고(Agent 도구 스키마에 effort 파라미터가 없다), effort 는 **에이전트 정의의 프론트매터**(`effort:`)나 세션 설정에서 온다. banker 는 에이전트를 배포하지 않으므로(`.claude-plugin/plugin.json` 에 `agents` 키 없음) 백본이 띄우는 것은 남의 정의이고, 따라서 이 스킬이 백본 effort 를 정할 수 없다. 백본에 실제로 영향을 주는 손잡이는 호출 전 **세션 effort** 뿐이며 SKILL.md 가 그렇게 안내한다.\
  플래그 표에 `전송 경로`·`확인 수준` 두 열을 두어, 전송 경로 칸을 채울 수 없는 능력은 표에 적지 못하게 했다.
- **백본의 모델을 선호 순서로 고르고, 실제로 쓴 것을 보고하게 했다.** ① Opus 계열 최신 → ② 없으면 가용한 것 중 가장 적합한 추론 모델 → ③ 그마저 없으면 기본값.\
  **추론 강도는 이 사다리에 없다** — Agent 도구 스키마에 effort 파라미터가 없어 호출 단위로 지정할 수 없고, 강도는 세션 설정에서 물려받는다. 최대 강도가 필요하면 호출 전에 세션 강도를 올리는 것이 유일한 손잡이다.\
  보고에 `백본(선언): model=<실제 쓴 모델> — 모델 선호 <1|2|3>순위 · strength=세션 상속` 줄이 강제된다. 목표를 약속으로 적고 실제를 감추지 않기 위한 것이다.
- **외부 좌석끼리도 모델이 겹치지 않게 했다.** 저자의 codex 설정(`~/.codex/config.toml` 의 `model`)은 api 좌석의 선호 모델 출처이기도 해서, 그대로 두면 `external:api:<X>` 와 `external:codex`(같은 `<X>`)가 나란히 앉는다 — 좌석은 2인데 모델 축에서는 하나다. 승인 게이트가 넓어지지는 않지만(좌석이 늘면 APPROVE 는 더 어려워진다) 보고의 "외부 2" 가 두 개의 독립 검사로 읽히므로, 이 스킬이 defect 로 다루는 보고 정직성 문제다.\
  이제 codex 좌석이 서면 api 좌석은 **codex 가 돌릴 모델의 계열을 피해서** 고른다. 사다리는 `다른 계열 → 같은 계열의 다른 모델 → 같은 모델` 이고 내려간 단은 `modelPick` 으로 보고된다. codex 의 모델을 확인하지 못하면 fail-closed 로 codex 런타임 계열을 피한다.\
  대가는 명시한다 — 자동 선택은 카탈로그 순서를 따를 뿐 성능순이 아니라서 회피 결과가 더 작은 모델일 수 있다. 능력이 더 중요하면 `--model` 로 고정하며, 그 값이 회피보다 우선한다. 또한 `GET /models` 200 은 카탈로그 접근만 증명하므로, 고른 모델이 첫 호출에서 거절되면 **좌석 확정 전**이라 다음 후보로 갈아탄다(확정 후의 실패는 `ERROR` 이고 모델을 바꾸면 좌석 상실이다).
- **`--external=auto|off` 를 신설**하고 `--agents` 를 백본 상시 파라미터로 승격했다. 폐기한 플래그는 없다.

### Added
- **gemini 모델 크리덴셜 좌석(`external:gemini-api`)을 CLI 좌석과 분리했다.** 처음 구현은 gemini 좌석을 CLI 존재 여부로 먼저 걸러서, 유효한 키가 있어도 CLI 가 없으면 좌석이 0이 되고 사유가 `cli-absent` 로 나갔다 — 그리고 그 토큰은 "모델 축이 환경 탓에 안 덮였다"로 매핑된다. **환경이 유효한 크리덴셜을 제공했는데 환경 탓으로 보고**하는 것이라, 이 스킬이 막겠다고 선언한 허위 커버리지였다. 이제 두 경로는 별개 좌석이고, 크리덴셜이 있으면 `cli-absent` 를 쓰지 않는다(생존 판정 실패는 `probe-unseated status=<code>`, 전송 수단 부재는 `no-transport`).
- `skills/ralph-qa/references/verifier-probe.mjs` — 의존성 0 · `node:http` 기반 유효성 프로브. provider 해석(`~/.codex/config.toml`), 0토큰 생존 판정, 상수 계열 필터(미분류는 fail-closed 제외), 전송 수단 탐지(`curl` → `python3` urllib ≥3.6 → `none`), 관측값(`observed`)과 선언값(`declared`) 분리 출력.

## [0.12.0] - 2026-08-09

### Added
- **모션 그래픽 스킬 쌍(무료 · hyperframes)을 추가했다.**\
  `motion-graphic-setup` 은 Node≥22 와 ffmpeg 를 OS별로 확보한 뒤 `npx hyperframes` 로 도구를 준비한다.\
  `motion-graphic-make` 는 렌더 파이프라인을 소유하지 않는 얇은 래퍼로, 10초 내외 내레이션 없는 모션 그래픽 제작을 hyperframes 의 `/motion-graphics` 워크플로에 위임한다.
- **3D 인트로 스킬 쌍(유료 · Azure Sora-2 + gpt-image-2)을 추가했다.**\
  `3d-intro-setup` 은 Node/ffmpeg 확보와 Azure 크레덴셜 저장, 무과금 프리플라이트까지만 담당해 과금 없이 연결을 검증한다.\
  `3d-intro-build` 는 gpt-image-2 스틸과 Sora-2 forward-chaining 영상으로 스크롤-스크럽 3D 인트로 사이트를 제작한다.
- **scroll-world 스크럽 엔진(MIT)을 `3d-intro-build/references` 에 번들로 포함했다.**\
  스크롤에 맞춰 3D 씬을 재생하는 이 엔진(`scrub-engine.js`·`index-template.html`)은 [oso95/scroll-world](https://github.com/oso95/scroll-world) 에서 그대로 벤더링했고, 원본 MIT 고지(`LICENSE`·`NOTICE.md`)를 함께 넣었다.
- **ffmpeg · hyperframes · Azure 는 사용자가 직접 공급하는 런타임 의존성이며 banker 가 번들하지 않는다.**\
  hyperframes 는 `npx` 로 설치(Apache-2.0)하고, ffmpeg 는 OS 패키지로 확보하며, Azure(OpenAI · Sora-2 · gpt-image-2 · FLUX.2-pro)는 사용자 크레덴셜로 호출한다(과금은 사용자 부담).
- **A4 세로 PPTX 스킬 쌍 `vertical-pptx` · `vertical-pptx-setup` 을 추가했다.**\
  `vertical-pptx` 는 A4 세로(210×297mm) 규격 PPTX 를 생성·점검·수리하고, 16:9 덱을 A4 세로로 변환한다(인쇄용 세로형 슬라이드).\
  `vertical-pptx-setup` 은 빌더 의존성(pptxgenjs·python-pptx)과 시각 검증용 LibreOffice 를 OS·권한 감지 후 설치한다(root 없으면 홈 프리픽스로 추출).

### Changed
- **🔴 `lineage` 세션 export 스킬을 전면 개편했다(2.0.0 · BREAKING).**\
  실측(6세션·62MB·4,645레코드) 대조에서 산출물의 2/3가 대화가 아니었고 일부는 하네스 주입이 사용자 발언으로 오표시됐다 — 이를 바로잡되 진짜 사용자 발언은 한 건도 잃지 않도록 다시 만들었다.\
  래퍼 없는 하네스 주입(스킬 본문·compaction 요약·에이전트 보고·이미지 노트)을 **위치가 아니라 형태로** 걸러 내고(위치 기반이 지우던 사용자 정정·인용 질문은 보존), 서브에이전트·동료 보고는 별도 회색 버블로 분리한다(발신자명 표시·idle 알림 폐기).\
  Claude 본문을 **무의존 마크다운으로 렌더**한다(헤딩·리스트·표·코드펜스·인용·강조·링크; `html.escape` **후에만** 변환하고 코드/링크를 먼저 도려내 마크업/서식 주입을 차단, 링크는 `https?://` 만).\
  연속된 assistant 레코드를 `--hide-tool-only` 앞에서 병합해 그동안 한 번도 표시되지 않던 `🔧 도구 N건` 을 살리고, 요약을 head+tail 로 뽑아 "무엇을 시작했다"가 아니라 결론을 담게 했다(요약기 버전을 캐시 키에 넣어 알고리즘 변경 시 자동 무효화).\
  여러 세션을 레코드 단위 시간순 한 줄기로 합치는 `--all-sessions` 를 추가했다.\
  단축키를 한글 IME·`Ctrl`/`Cmd`/`Alt` 안전하게 고치고(`e.code` 우선이라 브라우저 기본 동작을 가로채지 않음), 날짜·세션전환·compaction 을 형태가 다른 알약으로 구분(대비 개선·헤더가 스크롤에 따라 갱신), 범례를 우하단 `?` 오버레이로 옮겼다(배경 클릭으로만 닫힘·`aria-modal`).\
  `self_verify` 가 렌더러 출력의 모든 태그를 HTMLParser 스택으로 검사(void 요소 14종 인지)해 개수는 맞지만 어긋난 마크업까지 배포 전에 잡는다.\
  경로 인코딩을 바로잡았다: cwd 의 모든 비영숫자를 `-` 로 매핑(`_` 포함·Windows 경로 포함) — 이전엔 `/` 만 치환해 밑줄이 든 경로에서 자동탐색이 실패했다. 비-UTF8 세션 파일 하나가 전체 export 를 실패시키던 문제도 그 파일만 건너뛰게 고쳤다.\
  **BREAKING — 기본값 반전 3건**: 첫 로드 **접힘**(펼치려면 `--open`), 마크다운 렌더 **기본 ON**(끄려면 `--no-markdown`), 하네스 노이즈 필터 **기본 ON**(남기려면 `--keep-trivia`). 400자 초과 사용자 메시지도 접힌다. 1.x 동작을 원하면 `--open --no-markdown --keep-trivia`.\
  표준 라이브러리만 쓰는 `test_lineage.py`(회귀 143 단언·외부 의존 0)를 추가해 `scripts/smoke-test.js` 가 인터프리터 ≥3.7 을 자동 탐지해 CI 에서 돌리고(EL8 기본 python3=3.6 은 skip), npm 패키지에서는 제외한다.

## [0.11.0] - 2026-08-08

### Changed
- **`ralph-qa` 교차검증 경로를 3단 우선순위로 재설계.** 방금 만든 결과를 다른 모델로 독립 검증할 때(자기승인 방지), 이제 ① 다른-LLM CLI(**Codex CLI 우선**; 저자가 Codex면 Claude/Gemini) → ② 다른 모델 직접 `curl`(크리덴셜이 있고 저자와 다른 계열일 때, 엔드포인트·키·모델을 env 로 파라미터화) → ③ 자체 다중 에이전트 합의(기본 3개·렌즈 분담·정족수, 최후 수단) 순으로 사용 가능한 첫 경로를 택한다. 이전엔 다른-LLM 경로 실패 시 같은-런타임 critic 하나로 곧장 후퇴했으나, 그 앞에 진짜 다른 모델(`curl`) 경로를 끼워 독립성을 실질적으로 강화했다. `--agents=N` 플래그를 추가했다.
- **README 빠른 시작의 Claude Code 설치를 인앱 `/plugin` 우선으로.** 실행 중인 세션에서 `/plugin marketplace add …` + `/plugin install …@…` 로 설치하는 흐름을 앞세우고(설치 후 필요 시 `/reload-plugins` 안내), 터미널 셸 `claude plugin …` 은 대안으로 병기했다.

### Added
- README 에 **설정 변경 지점(Claude Code · Codex)** 섹션을 추가했다. 설치·제거 CLI, 플러그인 자체 훅(`hooks.json`), setup 스킬별 설정 패치(`config.toml`·`settings.json`) 지점을 표로 정리했다.

## [0.10.0] - 2026-07-18

### Changed
- **GitHub 별 프롬프트가 Y 입력 시 실제로 별을 단다**(oh-my-codex 방식과 동일). 이전에는 URL 안내만 했으나, 이제 `gh` CLI 인증으로 `gh api -X PUT /user/starred/smallOpenSource/banker_plugins` 를 호출해 자동으로 별을 누른다. `gh` 미설치·미인증·API 실패 시에는 이유를 알리고 URL 안내로 폴백한다(setup 을 절대 막지 않음·자체 timeout·오류삼킴). `starRepo` 를 `require.main` 가드 뒤로 export 해 주입 spawn 으로 단위테스트(gh 없음·성공·실패)를 커버했다. 실환경 검증: 실제 exported `starRepo()` 호출로 저장소가 404→204(별 눌림) 전이 확인.

## [0.9.0] - 2026-07-18

### Added
- **개인화 업데이트 알림**: 새 버전이 나왔을 때, 그 버전에서 바뀐 스킬 중 이 설치에서 실제로 써 본 스킬이 있으면 알림에 그 스킬 이름을 넣어 보여준다("자주 쓰는 스킬이 이번 업데이트에서 바뀌었습니다: ..."). 교집합이 없으면 기존 일반 알림으로 폴백한다.
  - **로컬 "써 본 스킬" 집합**: 카운팅 훅(PostToolUse Skill / UserPromptExpansion)이 스킬 이름을 config 폴더의 `used-skills.json` 에 union 으로 모은다. 이 집합은 절대 전송하지 않는다 — 체크인 페이로드는 여전히 `{version, os, counts}` 뿐이다. 상한(300)·중복 무기록·원자적 기록.
  - **바뀐 스킬 목록(공개 GitHub raw)**: 버전별 바뀐 스킬을 담은 `skill-changes.json` 을 저장소에서 GET 으로 조회한다(카운팅 활성 경로의 update-checkin 이 best-effort; 개인화 표시가 카운팅에 게이트되므로 카운팅 opt-out 경로의 update-fetch 는 조회하지 않는다). 무페이로드 GET 이라 식별자 전송이 없고, 실패하면 일반 알림으로 폴백한다. 릴리스마다 `scripts/gen-skill-changes.js`(git diff 기반·배포 제외)로 채운다.
  - 두 opt-out(`BANKER_NO_UPDATE_CHECK`·`BANKER_NO_TELEMETRY`) 중 어느 쪽을 켜도 개인화는 동작하지 않는다. Codex CLI는 네트워크 차단으로 배제된다.
  - `PRIVACY.md` 에 개인화 항목을 추가했다(로컬 집합 미전송·매니페스트 GET 수신자=GitHub).

### Fixed
- `PRIVACY.md`·CHANGELOG 의 "0.8.0 아직 게시 안 됨" 상태 문구를 실제(게시됨)에 맞게 정정했다. EU ePrivacy opt-in 전환 여부는 열린 검토 항목으로 표기를 유지한다.

## [0.8.0] - 2026-07-17

### Added
- README 에 npm 월간 다운로드 배지와 GitHub stars 배지를 추가했다.
- `banker setup` 최초 실행 시 GitHub 저장소 별(star)을 요청하는 프롬프트를 추가했다(양 런타임 공통·홍보 목적·카운팅 opt-out 여부와 무관).
- **업데이트-체크 서비스**: 이전 초안(opt-in 익명 텔레메트리 클라이언트, 기본값 미수집)은 동의자가 거의 없어 사용량 가시성이라는 목표를 달성하지 못한다고 판단해 두 기능으로 재구성(피벗)했다.
  - **업데이트 알림**: 공개 npm 레지스트리(`registry.npmjs.org/@kaydash9999/banker-plugins/latest`)를 조회해 세션 시작 시 새 버전이 있으면 알린다. 조회 요청의 수신자는 npm(GitHub/Microsoft)이고, banker 유지보수자는 이 조회를 받지 않는다. 기본값 켜짐, `BANKER_NO_UPDATE_CHECK` 환경변수 또는 `config.updateCheck=false` 로 끌 수 있다.
  - **사용량 카운팅(count-default-on)**: 하루 1회 스킬/커맨드별 호출 수를 시간대(hour-of-day)별로 버킷화해 플러그인 버전·OS 종류와 함께 유지보수자가 운영하는 외부 엔드포인트로 익명 체크인한다. 집계는 사용자가 직접 입력한 `/banker:*` 커맨드와 모델이 자동 호출한 스킬 양쪽을 서로 다른 두 훅으로 겹침 없이 포착한다. 기본값 켜짐, `BANKER_NO_TELEMETRY` 환경변수·`config.telemetry=false`·`banker telemetry off` 로 끌 수 있다.
  - **기본 카운팅 엔드포인트 내장**: 배포에 기본 엔드포인트(`banker.banker-plugins.workers.dev`, 유지보수자의 Cloudflare Worker)를 박아 `endpoint()` 가 env·config 미설정이어도 이를 반환한다. 그 결과 `countingActive()` 가 실제로 default-on 이 되어 opt-out 하지 않은 모든 설치에서 카운팅이 활성이다(이전엔 엔드포인트 미설정이라 사실상 유지보수자 셸만 잡혔다). 자가호스팅/override 는 `BANKER_TELEMETRY_ENDPOINT` 환경변수로 한다.
  - 두 기능 모두 Claude Code 전용이다. Codex CLI는 샌드박스가 네트워크 접근을 차단하므로 알림·카운팅 둘 다 배제된다.
  - `PRIVACY.md` 를 이 설계에 맞게 재작성했다: 알림/카운팅을 분리 기술하고 각각의 수신자를 이름으로 명시했다(알림=npm, 카운팅=유지보수자). 익명성이 페이로드의 속성이지 시스템 전체의 속성은 아니라는 점(카운팅 서버는 소스 IP를 수신하되 기록하지 않도록 설계)을 정직하게 밝혔다. EU ePrivacy Art.5(3)·Planet49 판례는 표준 관행 근거와 반대 근거를 양면으로 제시했고, 미국 CCPA·한국 PIPA는 이 익명 체크인에 재적용하지 않는다는 점(실무 판단 기준인 IP 지속 보유·프로파일링·판매에 해당하지 않음)을 명기했다.

### Notes
- **정직 명시**: 이 릴리스는 npm·GitHub·마켓플레이스에 게시되었다. 초안 당시 계획했던 "EU ePrivacy opt-in 전환 검토 통과 후 게시" 게이트는 게시 결정으로 우회되었고, EU ePrivacy opt-in 전환 여부는 `PRIVACY.md` 의 열린 검토 항목으로 남아 있다.

## [0.7.1] - 2026-07-16

### Changed
- README 정비(문서 전용 — 코드·스킬·배포 표면 무변경). 최상단에 총 구성요소 수(스킬 48 + 커맨드 2)를 명시하고, `라이선스 / 서드파티`의 의존 라이브러리·연동 참조 나열을 표(분류·항목·라이선스·사용 스킬)로 재구성했다. 사실은 코드와 대조해 확인했다 — banker 자체는 MIT, 코드로 재배포하는 서드파티는 `humanizer`(MIT © 2025 Siqi Chen) 단독이며 나머지는 런타임 의존·연동일 뿐이다. 도구별 사용 스킬 매핑은 `/banker:setup` 표와 교차검증했고, 원본에 라이선스가 없던 항목은 지어내지 않고 `각 프로젝트`로 표기했다.
- README 산문 가독성. 여러 문장이 한 줄에 붙던 문단을 Markdown hard break 로 문장마다 개행(뷰어에서 실제 줄바꿈)하고, Codex 설치 안내 문장을 분리했다.

## [0.7.0] - 2026-07-16

### Added
- **신규 스킬 6종** (전부 `target: both`). 배포용이므로 "이 저장소에서 재보니 무동작"류 판정은 설계 근거로 쓰지 않았다. 각 스킬의 사실 주장은 게시 전 적대적 검증에 걸었고, 거기서 반증된 것(검증되지 않은 표준 번호·법령 API 엔드포인트·트래커 이슈 인용·출처 없는 수치)은 그럴듯해도 넣지 않았다. 검증이 실제로 적출한 것들: `update-banker` 가 sweep 대상을 절반만 적은 것(스킬만 적고 command 프롬프트를 빠뜨림), `refresh-readme` 의 드리프트 예시가 디렉터리 카운트(49)를 스킬 수(48)로 오기한 것, `codex/transform-matrix.md` 가 DISPUTED 항목을 확정으로 서술한 것. 셋 다 게시 전에 고쳤다.
  - `ultra-interview`: 리서치를 선행해 공개 정보(공식 문서·규정·법령·시행세칙·기록)가 답할 수 있는 것은 사람에게 묻지 않고, 모호성 3% 이하까지 인터뷰한다. **모호도를 이산 체크리스트(미해결/전체)로 계측**하는 것이 설계 요점이다. 스칼라 자기채점 위에서는 3%가 표현되지 않는다(자기신뢰도 응답이 라운드넘버 소수에 뭉치고, 가중치 합이 1인 공식에서는 전 축 0.95여도 모호도가 정확히 0.05라 통과하려면 어딘가에 완벽을 선언해야 한다). 이산 계측은 셈이라 부풀릴 수 없다. Evidence/Inference/Preference 3분류로 Preference 만 질문한다. OMC/OMX 네이티브 `deep-interview` 를 번들하거나 대체하지 않으며, **자체 루브릭을 소유**한다(OMC 3차원 대 OMX 5차원이라 네이티브 채점을 물려받으면 같은 임계값이 런타임마다 다른 뜻이 된다).
  - `interval-report`: 장기 수행의 중간 보고를 `docs/intermission.md` 로 갱신한다. 측정 범위는 **마지막 사용자 지시로 시작된 현재 수행분**이고 시작 시각은 그 시점이다. **시작 시각을 파일에 영속하고 절대 재스탬프하지 않는다**. compaction/resume 후 now 로 다시 찍으면 elapsed 가 0으로 붕괴해 리포트가 가장 필요한 순간에 가장 낙관 편향된다. 시각은 `date` 로 실측한다(두 런타임 모두 컨텍스트에 시:분이 없다). ultragoal 이 있으면 읽고 없어도 동작하며 상태를 복제하지 않는다. compaction 트리거는 `smart-compact` 소관으로 남긴다.
  - `summary-wiki`: 위키를 `docs/` 하위 단일 파일로 개조식 요약해 **사용자가 아는 지식과 위키에 쌓인 내용의 차이를 식별**하게 한다(sync 검토). **`wiki_list` 를 쓰지 않고 파일을 직접 열거**하는 것이 핵심이다. `wiki_list` 는 구조적으로 stale 한 인덱스를 읽어 페이지를 조용히 누락하며(실측: 직접 열거 17 대 `wiki_list` 16), 그 누락은 성공을 보고하면서 이 스킬의 목적을 정확히 배반한다. 위키에는 쓰지 않는다(`compact-wiki` 는 제자리 파괴적 변형이라 별개). `개조식` 은 어문규범에 명명된 문체가 아니므로 "관행 준수"로 서술한다.
  - `update-banker`: 설치된 banker 를 최신 배포본으로 갱신한다. **축은 OS 가 아니라 채널**이다(banker 는 dependencies 0 에 복사 설치라 OS 분기가 거의 없고, Claude 플러그인·npm 전역 CLI·Codex 스킬 3채널이 서로 다른 메커니즘으로 독립 드리프트한다). **npm 을 먼저 올리고 검증한 뒤에만 `banker setup --codex`** 를 돌린다. setup 은 복사 전에 모든 `banker-*` 를 쓸어내므로 구버전 CLI 로 실행하면 그 구버전 매니페스트 수만큼만 복원된다. 판정은 exit code 가 아니라 채널별 프로브 재실행으로 한다.
  - `refresh-readme`: 코드가 바뀌어 README 가 작성 시점에 머무는 것을 조치한다. README 산문 주장을 매니페스트·`skills/`·`package.json` 과 대조하는 삼각검증이 신규 능력이다. 펜스·인라인 코드·URL·`--flag` 를 인지한다(POSIX end-of-options ` -- ` 는 산문 이중하이픈과 문자적으로 동일해 일괄 치환은 그 자체로 결함이며, 실제로 문서화된 MCP 설치 명령을 깨뜨린다). AI 문체 마커는 `humanizer` 에 위임하고 재서술하지 않는다.
  - `cleansing-memory`: 메모리 파일을 문서화된 threshold 내로 정리한다(중복 최신본화, 무손실 압축, append 대 replace 판별). **문서화된 하드 게이트는 `MEMORY.md` 의 200줄 OR 25KB 하나뿐이고 `CLAUDE.md` 에는 문서화된 크기 한도가 없다**. 바이트 캡을 제시하는 것은 날조다. Codex 의 `project_doc_max_bytes`(32768) 는 프로젝트 스코프 `AGENTS.md` 에만 걸리고 전역 파일에는 적용되지 않으며, raw 바이트를 자른 뒤 lossy UTF-8 디코드를 하므로 정확히 N바이트로 자르면 한글 경계 문자가 손상된다. auto-memory topic 파일이 시작 시 로드되지 않는다는 문서화된 성질이 append→replace 최적화의 근거다. 코드베이스 유도분 트림은 Claude 의 `/doctor` 에 위임한다.

### Changed
- Codex 설치 스킬 수 **42 → 48**(+커맨드 2 유지, claude-only=0). `codex/manifest.json`·`README.md`·`codex/transform-matrix.md`·`scripts/smoke-test.js`·`.github/workflows/harness-setup-ci.yml` 을 동기화했다.
- **`scripts/smoke-test.js` 에 집합 동등성 단언을 추가**했다(실설치 실행 **앞**). `codex/manifest.json` 의 skill 이름 집합과 `skills/` 디스크 집합이 같은지 검사하고 불일치를 `manifest-only` / `disk-only` 로 **이름을 찍어** 보고한다. 기수 단언만으로는 이 결함을 잡을 수 없다. dry-run 카운터는 파일시스템이 아니라 매니페스트를 순회하므로, 디렉터리가 없어도 매니페스트 줄 수만 맞으면 통과하고 실설치는 복사 중 ENOENT 로 죽어 `HARNESS ERROR` 라는 환경 문제처럼 보이는 메시지만 남긴다. 이 단언은 지금까지 아무 장치도 없던 반대 방향(디스크에 있으나 매니페스트에 없어 Claude 에만 실리고 Codex 로는 영영 가지 않는 조용한 claude-only 스킬)도 함께 닫는다. 릴리스마다 하드코딩 이름 배열을 덧붙이던 방식을 이 단언 하나로 대체한다.

## [0.6.0] - 2026-07-15

### Added
- **신규 스킬 `obsidizer`** (`target: both`): AI가 생성한 마크다운 위키를 의미 보존한 채 Obsidian 지식그래프로 정규화·상호링크·백링크한다. in-place 정규화(별도 export 트리 없음)·절대 rename 금지·LLM 의미론적 편집 + 제로-입력 결정적 캐노니컬라이저(`obsidize.mjs`) 2계층 엔진·OMC 트리에서는 bare-form(`[[slug]]`)만 허용하는 위키링크(`extractWikiLinks`가 피이프/헤딩 형태를 통째로 슬러그화해 `links[]`를 깨뜨림)·generic vault 한정 `aliases`(OMC 트리는 READ 시점 silent strip + 유일한 소비처인 피이프 링크가 금지라 destructive 실패 모드로 거부). `--enable`/`--disable`은 banker 최초의 **플러그인 선언 hook**(`hooks/hooks.json`)으로 Claude에서만 구조적으로 동작(위키 쓰기 후 원자적 쓰기 + read-back CAS로 동시쓰기를 skip)하고 Codex(MCP tool hook 없음)에서는 정직한 no-op이다. **hook은 banker가 활성화되어 있으면 항상 등록**되어 위키 쓰기(`wiki_ingest`/`wiki_add`)마다 실행되므로, `--enable`을 켜지 않은 사용자도 쓰기당 약 30ms의 node 프로세스 기동 비용을 치른다(플래그 확인 자체가 그 프로세스 내부에서 일어나기 때문); `--enable` 이전에는 아무 파일도 쓰지 않는 순수 no-op이다.
- **Deferred to 0.7.0 (품질 이유, 효율 이유 아님):** Canvas-MOC sidecar 생성 · inline Dataview `::` 생성 · MOC 허브 페이지 생성. 셋 다 in-place durable 은 이미 코드로 검증됐지만(좌표 결정성·필드 날조 방지·링크 인플레 방지 기준이 아직 없어) **생성만** 보류한다 — 호환성은 v1에서 이미 무료로 확보돼 있다.

### Changed
- Codex 설치 스킬 수 **41 → 42**(+커맨드 2 유지, claude-only=0). `codex/manifest.json`·`README.md`·`codex/transform-matrix.md`·`scripts/smoke-test.js`·`.github/workflows/harness-setup-ci.yml`을 동기화했다.
- `package.json` `files[]`에 `hooks`를 추가해 `hooks/hooks.json`·`hooks/obsidize-hook.mjs`·`hooks/run.cjs`가 npm 패키지에 포함되도록 했다(`npm pack --dry-run`으로 확인).

## [0.5.0] - 2026-07-15

### Added
- **신규 스킬 9종** (전부 `target: both`, 런타임 인식 — Claude=OMC / Codex=OMX): 개발환경 "harness" 구성요소를 OS별·런타임별로 개별 설치/구성하는 스킬 계층. USER_RESOURCES의 과거버전 가이드(5-OS Claude Code + 6-OS Codex/Azure)에서 공통 유용요소를 추출하고 2026 현행 방식으로 현행화했다.
  - `setup-node`: nvm + Node 22 (winget/nvm-windows) per-OS. npx 기반 MCP·CLI의 전제.
  - `setup-python`: Python 3.11 + pipx + uv per-OS (dnf module/deadsnakes/winget/brew, PEP668). `docs-setup`가 이 런타임을 소비.
  - `setup-java`: JDK 21 + JAVA_HOME per-OS (Debian은 Adoptium Temurin 전용). `setup-lsp`의 jdtls가 요구.
  - `setup-lsp`: 언어별 LSP(vtsls·basedpyright·bash·jdtls·spring) + lsp-mcp 브리지. Claude=LSP MCP 도구, Codex=`config.toml [mcp_servers.lsp_bridge]`. `--lang` 선택.
  - `setup-tmux`: tmux per-OS (Rocky8 `3.6a` 소스빌드·apt/brew·Windows psmux). OMC team·worktree / OMX `$team`·HUD 전제.
  - `setup-pwsh`: Windows PowerShell 7 환경(`$PROFILE` UTF-8·Terminal·Git). Claude=`CLAUDE_CODE_GIT_BASH_PATH`, Codex=네이티브 셸. 비-Windows는 no-op 안내.
  - `setup-mcp`: 공통 MCP 서버(context7·sequential-thinking·filesystem·git·fetch). Claude=`claude mcp add`, Codex=`config.toml [mcp_servers.*]` (timeout 300).
  - `setup-sandbox`: OS별 샌드박스(bubblewrap+userns / AppContainer / Seatbelt) + rust/cargo + git `safe.directory`. Codex=`sandbox_mode`.
  - `harness-factory`: revfactory/harness(팀 아키텍처 팩토리) 플러그인 설치+구성+사용안내. Claude=`harness@harness-marketplace`(+`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 를 settings.json에 영속), Codex=`SaehwanPark/meta-harness`. 설치를 넘어 모드/6패턴 선택·비용가드(~7× 토큰)·experimental 리스크 고지까지 담되, harness references는 이식하지 않고 설치된 플러그인 참조(Apache-2.0 연동/참조, banker 재배포 아님).

### Changed
- Codex 설치 스킬 수 **32 → 41**(+커맨드 2 유지, claude-only=0). **2계층 아키텍처**: 얇은 setup-* 실행 유닛 + `banker:setup`/`harness-factory` 오케스트레이터가 조합·의존성 관리(setup-lsp→node/python/java, setup-mcp→node/python, docs-setup→python).
- `commands/setup.md` 오케스트레이터에 신규 9 스킬(계층·의존성)을 추가하고, `README.md`·`codex/transform-matrix.md`를 동기화했다. `scripts/smoke-test.js`에 `copies===41` + 신규 9 존재 회귀 단언을 추가했다.
- **서드파티 명시(연동/참조, 재배포 아님)**: revfactory/harness·SaehwanPark/meta-harness(Apache-2.0), jdtls(EPL), tmux(ISC), psmux, basedpyright·vtsls·bash-language-server·lsp-mcp 등 각 프로젝트 라이선스 소유.
- **per-OS CI**: `.github/workflows/`에 GitHub-hosted 러너(ubuntu/windows/macos + Rocky8 컨테이너) 기반 설치·동작 검증 워크플로를 추가했다(설치가 실제 실행되는 도구를 만드는지 "존재 vs 동작" 검증).

## [0.4.0] - 2026-07-15

### Added
- **신규 스킬 6종** (전부 `target: both`, 런타임 인식 본문 — Claude=OMC / Codex=OMX):
  - `curation`: 의사결정을 {선택지·권고안·권고 근거·확신수준(0.00~1.00)·확신수준 근거} 형식으로 큐레이션. `--perf` 는 결과물 품질·완성도를 노력/토큰/시간 효율보다 우선하는 채택 기준을 추가. 외부 의존 0(양 런타임 동일 동작).
  - `deep-init`: 코드베이스 전체에 계층형 `AGENTS.md` 문서 생성/갱신(부모 역참조·`<!-- MANUAL -->` 보존·계층 검증). OMC `deepinit` 이식으로 banker `ultra-init`(자율 풀사이클 빌드)과는 별개. 서브에이전트 Claude=OMC explore/architect/writer, Codex=OMX worker/explore, 부재 시 직접 수행.
  - `visual-ralph`: 레퍼런스(생성/정적/라이브 URL) 기준 프론트 UI를 Visual Verdict(≥90)+픽셀 diff로 측정 빌드하고 재사용 디자인 시스템을 남긴다. OMX `visual-ralph` 이식. Claude=`ralph`+`visual-verdict`+Stitch(`setup-stitch-proxy`)/ccg imagegen, Codex=`$ralph`+`$imagegen`.
  - `deep-research`: 다중 소스 팬아웃 → 적대적 다표결 검증(2/3 반증 시 폐기) → 확신순 인용 합성. 번들 워크플로를 prose 로 재저작(구조적 병렬 fan-out 충실도 하락을 명시). Claude=번들 워크플로/`WebSearch`, Codex=OMX `autoresearch`.
  - `ralph-qa`: 작업 결과를 **다른 LLM·별도 세션**으로 `ralplan --deliberate`+`ralph --critic=critic` 로직으로 독립 검증/개선 반복(anti-self-approval). Claude=`omc ask codex`/`ccg`, Codex=OMX `$ask`(Claude/Gemini). 검증 모델은 파라미터화(`--model`·`--effort`; 예시 `gpt-5.6-sol` 은 하드코딩하지 않음).
  - `smart-compact`: 컨텍스트 사용률이 임계(기본 50%)를 넘으면 `append-wiki`→`ready-compact`→`compact-copy` 를 자동 실행하고 `/copy`·`/compact`·paste 를 유저에게 핸드오프하는 게이트. Claude statusLine `context_window.used_percentage` 로 감지(hook은 context% 미노출·슬래시명령 호출 불가 → TUI 3단은 유저 실행), 기존 statusLine 을 감싸는 compose-safe 설치. `--cancel` 해제.

### Changed
- **Codex 이식 확대(claude-only → both)**: 이전 OMC/Claude 결합 표면(스킬 `all-in-one`·`ultra-init`·`omc-reference`·`compact-copy`·`setup-omc-hud`·`setup-stitch-proxy` + 커맨드 `front-qa`·`setup`)을 **런타임 인식 본문**으로 재작성해 `target: both` 로 승격했다(`setup-omc` 는 기존부터 dual). Codex에선 OMC 대신 oh-my-codex(OMX)의 동명 스킬(ralplan/ralph/ultraqa/hud 등)·`codex mcp`·내장 `/copy` 를 사용한다. `codex/manifest.json` 의 claude-only=0.
- **`omc-reference` dualize**: 본문에 실측 OMX(oh-my-codex 0.18.16) 카탈로그(Agent Prompts·Skills Registry·Interfaces + OMC↔OMX 대응)를 병기해 Codex에서도 정확한 레퍼런스가 되도록 격상(기존 disclaimer-only → dual).
- Codex 설치 스킬 수 **25 → 32**(+커맨드 2 유지). `README.md`·`codex/transform-matrix.md` 를 동기화하고, `scripts/smoke-test.js` 에 `copies===32` + 신규 6스킬 존재 + `deep-interview` 부재(이미 OMC·OMX 네이티브라 미번들) 회귀 단언을 추가했다.
- **스킬 설명(description) 정규화**: 전 스킬 + 2 커맨드의 `description` 을 `(banker)` 접두로 통일하고 em/en dash 등 AI slop 표현을 제거·간결화했다(트리거 키워드는 보존). Codex `codex debug prompt-input` 로 banker-* 가 "Available skills" 에 노출됨을 실측 확인.
- **setup 스킬 정비**: `setup-stitch-proxy` → `setup-stitch` 개명(RockyLinux8 `~/bin/stitch-proxy.sh` proxy-script 절차 그대로) + **`docs-setup` 신규**(arch-diagram·pdf-vision-extract 의존성 python-pptx·pymupdf·plantuml 설치, python-env 감지/선택·venv 우선). Codex 스킬 **31→32**, `/banker:setup` 오케스트레이터·`smoke-test` rename-guard 에 반영.

## [0.3.0] - 2026-07-02

### Changed
- **`game-qa` → `play-qa` 개명**: 웹 게임 전용 표기에서 Godot HTML5까지 포함한 웹 환경 직접 플레이 QA로 범위를 넓히고 스킬명을 `play-qa` 로 바꿨다. 스킬 디렉터리·프론트매터 `name:`·트리거·`codex/manifest.json`·README·문서 참조를 일괄 갱신했다. Codex에는 `banker-play-qa` 로 설치되며, 업데이트 시 옛 `banker-game-qa` 는 `banker setup --codex` 의 `banker-*` sweep 으로 자동 제거된다(`scripts/smoke-test.js` 에 회귀 단언 추가). `/banker:game-qa` 는 더 이상 해석되지 않으므로 minor 버전을 올린다.

## [0.2.0] - 2026-07-01

### Fixed
- **Codex 스킬 미표시(#5)**: `banker setup --codex` 가 스킬을 `~/.codex/skills/banker-<name>/` 로 복사할 때 SKILL.md 프론트매터 `name:` 을 `banker-<name>` 로 재작성한다. Codex는 스킬 디렉터리명과 `name:` 일치를 요구하는데, 기존에는 `name: <name>` 그대로라 Codex가 스킬을 인식하지 못했다. `banker doctor` 에 dir==name 검증·경고와 "codex 있는데 banker 스킬 0개" 경고 추가.

### Changed
- **업데이트 시 중복 제거(#6)**: `banker setup --codex` 가 설치 전 기존 `banker-*` 스킬·프롬프트를 먼저 정리(sweep)한 뒤 클린 재설치한다. 매니페스트에서 제거·개명된 스킬의 옛 버전이 잔존하지 않는다.
- **의존성 사전 안내(#2·#4)**: `all-in-one`·`ultra-init`·`front-qa` 에 OMC(Claude)/OMX(Codex) 전제조건 프리플라이트, 브라우저 스킬(`audit-web-page`·`game-qa`·`ultra-ui-qa`)에 playwright 전제조건 프리플라이트를 추가했다. 의존성이 없으면 "설치부터" 안내한 뒤 진행한다.
- **README 재작성(#1)**: 과장·AI 흔적 표현을 덜어내고(과장 태그라인·불필요한 em dash 정리) 간결하고 정중한 문체로 정리했다. 빠른 시작에 Claude Code·Codex 양쪽 설치 경로를 명시하고, 라이선스/서드파티 섹션을 번들 코드(humanizer)·의존 라이브러리·연동 대상 3범주로 확장했다.
- `sync-version` 이 `.claude-plugin/marketplace.json` 의 `metadata.version` 까지 동기화한다(과거 수동 갱신 제거).

### Added
- **`setup-omc` 스킬**: `all-in-one`·`ultra-init`·`front-qa` 가 의존하는 oh-my-claudecode(OMC)를 설치·갱신한다(Codex는 OMX `omx setup`). `/banker:setup` 멀티셀렉트에 옵션으로 추가.
- **`setup-insane-search` Codex 지원(#7)**: `target: both` 로 승격했다. Claude는 `insane-search@gptaku-plugins`, Codex는 `codex plugin add insane-research-codex@gptaku-codex` 경로를 도구 자동 감지로 안내한다.
- `scripts/smoke-test.js` 에 실제 설치 기반 회귀 단언 추가: 스킬 18개, `banker-*` dir==frontmatter `name`, 재설치 시 stale sweep.

## [0.1.3] - 2026-06-29

### Security
- `lineage` 스킬 문서의 `LINEAGE_REDACT_EXTRA` / `--redact-extra` 예시에서 실제 프로젝트 비밀 키워드 예시를 중립 플레이스홀더(`acme-corp,db-pass`)로 교체 — npm tarball·GitHub 노출 제거. 기능·내장 정규식 패턴은 불변.

## [0.1.2] - 2026-06-28

### Added
- `compact-copy` 스킬(개인 `~/.claude/skills/` + banker): `/ready-compact` resume 프롬프트에서 코드펜스 본문만 추출해 `/tmp/claude-<uid>/response.md` + (이어지는 `/copy`) 클립보드에 "프롬프트-only" 로 담는다. `/copy`·response.md 내장 의존이라 Claude Code 전용.

### Changed
- `all-in-one` 스킬을 playwright 3단계 → **ralplan→ralph→ultraqa** 3단계(독립 테스트 게이트)로 재작성(`--short`/`--checkpoint`/`--critic`/`--qa`/`--no-deslop` 플래그 추가). `codex/manifest.json` 의 reason 문자열도 ultraqa로 동기화.

## [0.1.1] - 2026-06-26

### Changed — README + license
- README 전면 재구성: hero(태그라인 + npm·MIT 배지 + 내비) · 빠른 시작(2스텝) · "왜 banker인가" · 요구사항 섹션 추가(스킬 표 보존).
- 루트 `LICENSE`(MIT) 파일 추가 + `package.json` `files[]`에 포함(MIT 배지가 실제 라이선스를 가리키도록).

## [0.1.0] - 2026-06-25

### Added — npm distribution + Codex CLI support
- npm global install: `npm i -g @kaydash9999/banker-plugins` ships a `banker` CLI (`bin/banker.js`, no runtime deps).
- `banker setup [--claude] [--codex] [--scope user|project] [--dry-run]`, `banker doctor`, `banker uninstall`.
- **Codex CLI support**: `banker setup --codex` installs the 17 tool-agnostic skills into `~/.codex/skills/banker-<name>/` (subtree copy) and commands into `~/.codex/prompts/banker-<name>.md` (`/banker-<name>`), per `codex/manifest.json`. It never writes the omx-generated `~/.codex/AGENTS.md` (relies on `~/.codex/skills/` auto-discovery).
- `codex/manifest.json` (per-surface `claude-only | both` target + supporting files) and `codex/transform-matrix.md`.
- Version-sync guard: `.claude-plugin/plugin.json` is the single source of truth; `npm run sync-version` syncs `package.json`, and `prepublishOnly` fails publish on mismatch.

### Unchanged
- The Claude Code marketplace install (`claude plugin install banker@banker-plugins`, skills as `/banker:*`) is byte-for-byte unchanged.

### Notes
- No `postinstall`; `banker setup` is explicit and refuses to run as root (avoids root-owned files in user homes).
- OMC/`claude`-coupled skills (all-in-one, ultra-init, omc-reference, setup-omc-hud, setup-insane-search, setup-stitch-proxy) and the `front-qa`/`setup` commands are Claude-Code-only.
