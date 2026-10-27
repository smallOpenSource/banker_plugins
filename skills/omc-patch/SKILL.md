---
name: omc-patch
description: "OMC 플러그인이 자동 업데이트된 뒤 사라진 훅 패치를 활성 버전에 다시 적용하고 OMC 마켓플레이스 자동 업데이트를 막음. 옛 킷이 남긴 헬퍼 자리 결함(project-memory 꺼짐)도 찾아 고침. 진단, 적용, 검증, 되돌리기. 'omc-patch'/'OMC 패치'/'OMC 업데이트 뒤 패치'/'훅 timed out'/'훅 프로세스 누적'/'PC 느려짐'/'project-memory 안 됨' 시 사용."
argument-hint: "[check | revert]"
---

# omc-patch — OMC 훅 패치 재적용과 자동 업데이트 고정

OMC(oh-my-claudecode)가 새 버전으로 자동 업데이트되면 로컬 훅 패치가 사라진다. 그러면 도구 호출마다 훅 프로세스가 많이 생기고, Windows 에서는 커널 풀(paged pool)이 계속 늘어 PC 가 느려진다.
이 스킬은 같은 폴더의 `scripts/omc-patch.mjs` 로 패치를 다시 적용하고, `scripts/probe-pm.mjs` 로 훅이 실제로 일하는지 확인한다. 답변은 한글.

패치 내용은 두 가지다.
- 훅 스크립트 최상위의 `await import(...)` 에 10초 시간 제한을 건다. 로드가 멈춰도 훅이 끝까지 가고 프로세스가 남지 않는다.
  - 시간 제한에 걸리면 훅의 stderr 에 `[OMC local patch] import 가 10초 안에 끝나지 않아 빈 모듈로 진행합니다` 한 줄을 남긴다. 종료 코드는 그대로다. stderr 를 읽는 쪽이 닫혀 그 줄을 쓰지 못해도 같다.
  - 이 줄이 없는 옛 헬퍼로 패치한 훅도 `적용됨` 으로 보이고 되돌리기도 그대로 된다. 새 헬퍼는 되돌린 뒤 다시 적용하거나 새 OMC 판에 적용할 때 들어간다.
- `hooks.json` 의 `PostToolUse` 훅을 제거한다.

추가로 OMC 마켓플레이스 저장소의 `origin` 을 `omc-pinned://<원래 URL>` 로 바꿔 자동 업데이트를 막는다.

## 헬퍼 자리 결함

- 패치는 시간 제한 헬퍼(`__omcRaceImport`)를 훅 파일에 넣는다. 이 도구는 헬퍼를 모듈 맨 앞에 넣는다.
- 이 스킬 밖에서 쓰던 이전 판의 패치 도구(아래 옛 킷)는 헬퍼를 첫 사용 지점 앞에 넣었다. 그 자리가 최상위 `try { }` 안이면 헬퍼도 그 블록에 갇힌다.
- 그러면 다른 블록의 import 가 ReferenceError 로 실패하고, 훅의 `catch` 가 그 오류를 삼킨다. 예: `project-memory-session` 은 종료 코드 0 으로 끝나지만 project-memory 를 만들지 않는다.
- banker 0.16.x 의 도구는 새로 패치할 때 맨 앞에 넣었지만, 옛 킷이 남긴 이 결함은 진단하지 못하고 `결과: 모두 적용된 상태입니다.` 를 냈다.
- 지금 도구의 `--check` 는 이 결함을 `헬퍼 자리 결함` 으로 알린다. 이미 감싼 파일이라 다시 적용만으로는 고쳐지지 않는다. 활성 폴더를 되돌린 뒤 다시 적용한다.
- 헬퍼 선언을 찾지 못하거나 선언이 첫 사용보다 뒤에 있는 파일도 같은 결함으로 센다. 뒤에 있으면 첫 사용이 먼저 돌아 ReferenceError 가 난다.

## 인자

| 인자 | 동작 |
|---|---|
| 없음 | 진단, 사용자 확인, 적용, 검증 |
| `check` | 진단만. 아무것도 바꾸지 않음 |
| `revert` | 패치와 고정을 되돌림. 사용자가 명시했을 때만 |

## 규칙

- 이 작업은 사용자 설정 폴더(`~/.claude`)의 플러그인 캐시를 고치는 설정 변경이다. 서브에이전트에 맡기지 않고 메인 세션에서 직접 실행하고 직접 검증한다.
- 적용은 `--no-update` 로만 실행한다. 인자 없는 apply 는 쓰지 않는다. 활성 OMC 를 도구의 `TARGET_VERSION`(5.7.0)으로 바꾸고, `revert` 로도 버전이 돌아오지 않는다.
- 진단도 늘 `--no-update` 와 함께 한다. 그것 없이 진단하면 도구가 `인자 없이 다시 실행하십시오.` 라고 안내하는데, 인자 없는 apply 를 뜻하므로 따르지 않는다.
- 인자 없는 `--revert` 는 설치된 모든 버전을 되돌리고 고정까지 푼다. 헬퍼 자리 결함에는 도구가 안내하는 대로 활성 폴더만 `--revert --root` 로 되돌린다(3단계 1).
- `--root` 는 폴더의 이름표가 OMC 가 아니면 `OMC 플러그인 폴더가 아님` 으로 멈춘다. `.claude-plugin/plugin.json` 의 name 이 있으면 그것으로, 없으면 `package.json` 의 name 으로 정한다. 다른 폴더를 잘못 준 실수를 막는 확인이고, 이름표가 없는 폴더는 통과한다.
- 쓸 파일이 링크로 플러그인 폴더 밖을 가리키거나 백업 자리(`.omcbak`)가 링크, 또는 일반 파일이 아닌 것(FIFO, 폴더)이면 도구는 쓰지 않고 실패로 센다. 문구는 적용 때 `쓰지 않음`, 되돌리기 때 `되돌리지 않음`, hooks.json 은 `hooks.json 을 건드리지 않음` 이다. 인자 없는 apply 의 판 바꾸기도 `installed_plugins.json.omcbak` 자리가 그렇다면 판을 바꾸지 않고 `installed_plugins.json 을 바꾸지 않음` 으로 멈춘다(종료 1).
- 같은 판 폴더에 새 원본이 깔렸는데 옛 `.omcbak` 이 남은 경우
  - 되돌리기는 지금 파일에 패치가 없고 백업과 글이 다르면 덮지 않는다. `되돌리지 않음: <이름> (지금 파일에 패치가 없고 백업과 글이 다름. 백업이 옛 원본일 수 있음)` 으로 알리고 실패로 센다. hooks.json 은 `hooks.json 을 되돌리지 않음 (...)` 이다.
  - 그 훅은 이미 원본이다. 남은 백업은 옛 원본이다. 지울지 사용자에게 묻고, 고른 경우에만 그 백업을 지운다.
  - 적용은 백업이 지금 원본과 다르면 백업을 지금 원본으로 바꾸고 `ok  옛 백업을 지금 원본으로 바꿈: <이름>` 으로 알린다.
- 패치 규칙은 OMC 훅 코드의 모양에 맞춰져 있다. 처음 보는 OMC 버전이면 반드시 `check` 를 먼저 실행한다.
- `실패 N건` 이 1건 이상이면 멈추고 출력을 그대로 보고한다. 예외는 2단계에서 남기기로 한 `PINNED` 줄 하나뿐이다(3단계 2). 문법 오류가 난 파일은 도구가 원본으로 자동 롤백한다. 고친 hooks.json 이 다시 읽어 JSON 이 아니어도 원본으로 되돌리고(`hooks.json 손상으로 롤백`) 실패로 센다.
- 판정은 출력 문구로 한다. 종료 코드 0 만으로 완료라고 보고하지 않는다.
- 캐시에는 정션이나 심볼릭 링크로 이어진 버전 폴더가 있을 수 있다(예: 옛 버전 폴더가 새 버전을 가리킴). 이때 한 번의 변경이 두 버전 폴더에 함께 보인다. 정상이다.
- 도구는 `os.homedir()/.claude` 를 쓴다. `CLAUDE_CONFIG_DIR` 로 설정 폴더를 옮겼다면 이 도구는 그 폴더를 보지 않는다.
- Codex 에서 실행하면 `workspace-write` 샌드박스가 `~/.claude` 쓰기를 막는다.
  - 진단(`--check --no-update`)과 `probe-pm.mjs` 는 승인 없이 된다(probe 는 임시 폴더에만 쓴다). 진단의 `쓸 수 없음 (쓸 권한이 없음)` 은 샌드박스 때문이며, 패치가 필요한지의 판정은 그대로 맞다.
  - 적용과 되돌리기는 그 명령을 샌드박스 밖 실행으로 승인을 요청해 돌린다. 승인 없이 돌리면 `실패 N건` 으로 끝나고 아무것도 바뀌지 않는다.
  - 승인한 실행은 Codex 0.144.5 에서 적용, 고정, `PROBE GREEN` 까지 확인했다.
  - 승인을 요청할 수 없거나(승인 정책 `never`) 거부되면, 같은 명령을 Codex 입력창에서 `!` 를 붙여 사용자가 직접 실행하게 안내한다(예: `!node "<경로>" --no-update`). 사용자가 친 `!` 명령은 샌드박스 밖에서 돈다(Codex 0.144.5, `-a never` 에서 실측). `codex exec` 처럼 사람이 없는 실행이면 그 명령을 보고하고 멈춘다.
  - `--add-dir ~/.claude` 처럼 설정 폴더를 통째로 여는 방법은 쓰지 않는다. 그 세션이 훅과 설정을 고칠 수 있게 되어 샌드박스가 무력해진다.
- 명령의 자리 표시(`<...>`)에 도구 출력이나 `find` 가 낸 값(경로, 판, 이름)을 넣을 때는 bash, PowerShell 모두 작은따옴표로 감싼다. 값에 작은따옴표(PowerShell 은 `‘` `’` `‚` `‛` 도 작은따옴표로 읽는다)나 줄바꿈이 있으면 명령을 만들지 않고 그 값을 사용자에게 보인다.
- 출력의 origin 에 `https://사용자:토큰@...` 처럼 자격증명이 들어 있으면, 보고할 때 `//` 뒤부터 마지막 `@` 까지를 `***` 로 가린다(도구와 같은 범위). 출력을 그대로 보고하라는 단계에서도 이 가림은 지킨다.
- 옛 판의 도구가 만든 `PINNED` 에는 그 URL 이 남아 있을 수 있다.
  - `--check` 는 그 칸을 `[!] 고정 기록(PINNED)에 옛 URL 칸이 남아 있음 (적용하면 지움)` 으로 알리고 모두 적용된 상태로 보지 않는다.
  - 적용(`--check` 가 아닌 실행)은 그 칸을 지우고 권한을 0600 으로 맞춘다(POSIX. Windows 는 chmod 가 쓰기 비트만 다뤄 폴더의 상속 권한을 따른다).
  - 이 도구가 다 지울 수 없으면(칸이 든 기록이 링크, JSON 이 아님, 폴더에 쓰지 못함, 읽지 못함, 같은 파일의 다른 이름이 있음) `[!] 고정 기록(PINNED)의 옛 URL 칸을 ...` 줄로 알리고 적용은 실패로 센다(종료 1).
  - 다른 이름이 있으면 적용은 이 이름에서만 지우고 다른 이름에는 남긴다. 링크는 따라가 쓰지 않으며, 링크 너머에 그 칸이 없으면 알리지 않는다.
  - 되돌리기는 `PINNED` 를 지운다. 링크 너머에 그 칸이 있거나 링크 너머를 읽지 못하거나, 지우지 못하거나, 같은 파일의 다른 이름이 있을 때만 실패로 센다.
  - 링크가 아닌 기록은 JSON 이 아니거나 읽지 못해도 그냥 지운다. `PINNED` 는 기록일 뿐이라 지워도 고정과 되돌리기에 영향이 없다.
  - 알린 줄은 아래 `PINNED` 줄 다루기대로 묻는다. 기록 파일의 내용은 읽어 보이지 않는다(인증 정보가 들 수 있음).
- `PINNED` 줄 다루기. `[!] 고정 기록(PINNED)의 옛 URL 칸을 ...` 줄이 나오면 그 줄의 경로를 사용자에게 보이고 그 기록을 지울지 남길지 묻는다. `--check` 에서 나온 줄은 2단계 승인 질문에서 함께 묻는다. 적용이나 되돌리기에서 처음 나온 줄은 멈추고 보고한 뒤 묻는다. 이때도 기록의 내용은 읽지 않고 경로만 보인다.
  - 폴더 권한이 원인(`쓰지 못함`)이면 권한을 고칠지도 묻는다.
  - 링크면 URL 칸은 링크가 가리키는 파일에 있다. 그 파일의 경로도 보인다. 경로는 `node -e "console.log(require('fs').realpathSync(process.argv[1]))" '<링크 경로>'` 로 구한다(bash, PowerShell 같음). 그 파일이 `PINNED` 기록이 맞는지는 사용자가 직접 열어 확인한 뒤 답하게 한다(링크는 글자만 보고 막으므로 무관한 파일일 수 있다).
  - 같은 파일의 다른 이름이 있다는 줄이면 그 아래 `다른 이름은 ... 로 찾습니다.` 줄의 번호로 다른 이름을 찾아 경로를 보인다. 찾은 이름 중 `PINNED` 가 아닌 것이 다른 이름이다.
    - POSIX 는 먼저 홈 폴더에서 찾는다: `find "$HOME"/ -xdev -inum <번호> 2>/dev/null`(끝의 `/` 는 홈 폴더가 링크여도 그 안을 찾게 한다).
    - 못 찾으면 번호를 사용자에게 알리고, `PINNED` 가 든 파일 시스템 전체에서 찾을지 묻는다. 오래 걸릴 수 있다.
    - 그 파일 시스템의 맨 위 폴더는 Linux 는 `stat -c %m '<PINNED 가 든 폴더>'` 이다. macOS 는 `df -P '<PINNED 가 든 폴더>' | awk 'NR==2{for(i=6;i<=NF;i++) printf "%s%s",$i,(i<NF?" ":"\n")}'` 이다(공백 든 마운트 지점도 읽음). 그 폴더에서 같은 `find` 를 돌린다.
    - 찾은 경로가 같은 파일인지 확인한다. 적용 전이면 `[ '<찾은 경로>' -ef '<PINNED>' ]` 가 참이어야 한다. 적용 뒤에는 `PINNED` 가 새 파일이다. 그래서 찾은 경로의 장치 번호가 `PINNED` 가 든 폴더의 것과 같아야 한다(Linux `stat -c %d`, macOS `stat -f %d`).
    - Windows 는 적용 전이면 `fsutil hardlink list '<PINNED 경로>'` 가 모든 이름을 보인다. 볼륨 루트 기준 경로라 앞에 드라이브를 붙인다. 적용 뒤에는 `fsutil file queryFileNameById <드라이브>\ <번호>` 이다. 둘 다 관리자 셸에서만 확인했다.
    - 찾은 경로마다 번호를 붙여 보이고, 지울 것을 사용자가 고르게 한다.
    - 찾은 경로가 git 작업 트리 안이면(`git -C '<그 폴더>' rev-parse --is-inside-work-tree` 가 `true`) 지워도 git 이력에는 남는다고 알린다.
    - 찾지 못하면(권한으로 못 본 폴더 등) 번호를 그대로 사용자에게 알린다.
  - 사용자가 지우기를 고르면 그것이 승인이다. 고른 경로만 지운다. 링크면 링크와 그것이 가리키는 파일을, 다른 이름이 있으면 `PINNED` 와 고른 다른 이름을 지운다. 하나라도 남기면 그 안에 URL 이 남는다. 링크가 가리키는 파일이 `PINNED` 기록이 아니라고 사용자가 답하면 그 파일은 지우지 않고 링크만 지울지 묻는다.
  - 남기기로 하면 그 줄은 예상된 실패다. 적용에서는 3단계 2 의 예외, 검증에서는 4단계 1 의 예외를 따른다. 다른 이름이 있는 기록을 남기고 적용하면 적용은 `PINNED` 의 칸만 지운다. 그 뒤 `--check` 는 다른 이름을 보지 못하니 5단계 보고에 그 경로를 적는다.

## 절차

스크립트는 `<이 스킬 디렉터리 절대경로>/scripts/` 의 `omc-patch.mjs` 와 `probe-pm.mjs` 다. Node 18 이상과 `git` 이 필요하다.
활성 플러그인 폴더(아래 `R`, `$r`)는 명령마다 다시 구한다. 명령마다 새 셸일 수 있다.

bash:
```bash
R=$(node -e 'const j=require(require("path").join(require("os").homedir(),".claude/plugins/installed_plugins.json"));console.log(j.plugins["oh-my-claudecode@omc"][0].installPath)')
```

PowerShell(Windows PowerShell 5.1 과 PowerShell 7 에서 같다):
- `installed_plugins.json` 은 `-Encoding UTF8` 로 읽는다. 5.1 은 BOM 없는 파일을 시스템 코드 페이지(예: 949)로 읽어, 경로에 한글이 있으면 `$r` 이 빈 값이 된다.
- 도구 출력을 변수나 파이프로 받아 판정할 때는 먼저 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` 을 실행한다. 5.1 은 node 의 UTF-8 출력을 콘솔 코드 페이지로 읽어 한글 문구가 깨진다. 출력을 그대로 흘려 보는 것은 괜찮다.
- Git Bash 가 있으면 bash 블록을 먼저 쓴다.

```powershell
$r = (Get-Content "$env:USERPROFILE\.claude\plugins\installed_plugins.json" -Raw -Encoding UTF8 | ConvertFrom-Json).plugins.'oh-my-claudecode@omc'[0].installPath
```

### 1. 진단

```bash
node "<이 스킬 디렉터리 절대경로>/scripts/omc-patch.mjs" --check --no-update
```

- `활성 버전: X (installed_plugins.json)` 줄로 실제 활성 버전을 확인한다.
- 그 줄이 `(추정: ...)` 로 끝나면 도구가 `installed_plugins.json` 에서 활성 버전을 찾지 못한 것이다. 결과 줄은 `활성 버전을 확인하지 못했습니다.` 이고, 도구의 적용도 쓰기 전에 멈춘다. 적용하지 않고 출력을 그대로 보고하고 끝낸다.
- `패치 필요 N건` 은 설치된 모든 버전 폴더를 합친 수다. 판정은 `결과:` 줄로 한다. 그 아래 `참고:` 줄은 아래 항목대로 다룬다.

| `결과:` 줄 | 다음 |
|---|---|
| `활성 버전을 확인하지 못했습니다.` | 적용하지 않고 위의 `활성 버전:` 줄을 그대로 보고(`installed_plugins.json` 에서 활성 버전을 찾지 못함). 사용자에게 Claude Code 의 `/plugin` 에서 OMC 플러그인(`oh-my-claudecode@omc`)이 설치되어 켜져 있는지 먼저 확인하라고 알림 |
| `hooks.json 을 확인하지 못했습니다.` | 적용하지 않고 위의 `[!]` 줄을 그대로 보고 |
| `훅 스크립트를 확인하지 못했습니다.` | 적용하지 않고 위의 `[!] 읽지 못함` 줄을 그대로 보고(적용도 같은 훅을 읽지 못해 실패한다) |
| `마켓플레이스 origin 을 확인하지 못했습니다.` | 적용하지 않고 위의 `[!]` 줄을 그대로 보고(git 이 없거나 마켓플레이스 저장소를 읽지 못함) |
| `헬퍼 자리 결함 N건이 있습니다.` | 2단계 확인 뒤 3단계에서 활성 폴더부터 되돌림 |
| `고정 기록(PINNED)의 옛 URL 칸이 이 도구로 지울 수 없는 곳에 있습니다.` | 적용할 항목은 없다. 2단계에서 그 기록을 지울지 남길지만 묻는다(`규칙` 절의 `PINNED` 줄 다루기). 어느 쪽이든 그 뒤 4단계 검증으로 건너뜀 |
| `고정 기록(PINNED)을 확인하지 못했습니다.` | 기록을 읽지 못했거나 JSON 이 아니어서 옛 URL 칸이 남았는지 모른다. 바로 위 행과 같이 다룬다 |
| `적용되지 않은 항목이 있습니다.` | 2단계 확인 뒤 3단계 적용 |
| `모두 적용된 상태입니다.` | 4단계 검증으로 건너뜀 |

- 표는 도구가 고르는 순서다. 위에서부터 처음 맞는 줄 하나가 나온다.
- `참고: 비활성 버전 ...` 은 지금 쓰지 않는 버전이라 판정에 들어가지 않는다.
- `결과:` 줄 아래의 `참고: 고정 기록(PINNED)의 옛 URL 칸이 이 도구로 지울 수 없는 곳에 있습니다.` 는 적용할 항목도 있다는 뜻이다. 적용해도 그곳의 칸은 남고 적용은 `실패 1건` 으로 끝난다. 2단계에서 함께 묻는다. 위 표의 같은 문구 결과 줄은 적용할 항목 없이 이것만 남았을 때 나온다. `참고: 고정 기록(PINNED)을 확인하지 못했습니다.` 도 같다. 다만 칸이 있는지 모르는 것이라, 칸이 남아 있으면 적용도 지우지 못한다는 뜻이다.
- 인자가 `check` 이면 여기서 결과만 보고하고 끝낸다.

### 2. 확인 (적용 전 필수)

`--check` 결과를 보여 주고 사용자에게 적용해도 되는지 묻는다. 묻기 전에 아래를 알린다. 1단계 결과가 위 표의 `PINNED` 줄이면 적용할 항목이 없다. 적용은 묻지 않고 아래 `PINNED` 항목만 한다.
- 활성 OMC 버전의 `scripts/*.mjs` 와 `hooks/hooks.json` 을 고친다. 원본은 `.omcbak` 로 남는다.
- 헬퍼 자리 결함이 있으면 활성 폴더를 `.omcbak` 원본으로 먼저 되돌린 뒤 다시 패치한다.
- OMC 마켓플레이스 `origin` 을 `omc-pinned://` 로 바꾼다(`이미 고정됨` 이면 그대로 둔다). OMC 가 더 이상 자동 업데이트되지 않는다. 되돌리기는 `revert`.
- 1단계에 `[!] 고정 기록(PINNED)의 옛 URL 칸을 ...` 줄이 있었으면 그 기록을 어떻게 할지 함께 묻는다(`규칙` 절의 `PINNED` 줄 다루기).
  - 적용할 항목도 있으면 답은 셋이다. 지우고 적용(승인한 파일을 지운 뒤 3단계로, 적용은 실패 0건), 남기고 적용(3단계로, 그 줄 하나가 실패로 남아 `실패 1건`), 적용하지 않음(여기서 끝냄).
  - 1단계 결과가 위 표의 `PINNED` 줄이면 적용할 항목이 없다. 적용은 묻지 않고 지울지 남길지만 묻는다. 어느 쪽이든 그 뒤 4단계로 건너뛴다.
- 승인이 없으면 적용하지 않는다.

### 3. 적용

1. 1단계가 헬퍼 자리 결함을 냈으면 활성 폴더만 먼저 되돌린다. `--root` 는 그 폴더의 훅과 `hooks.json` 만 다룬다. 마켓플레이스 고정과 다른 버전 폴더는 건드리지 않는다.

   ```bash
   R=$(node -e 'const j=require(require("path").join(require("os").homedir(),".claude/plugins/installed_plugins.json"));console.log(j.plugins["oh-my-claudecode@omc"][0].installPath)')
   node "<이 스킬 디렉터리 절대경로>/scripts/omc-patch.mjs" --revert --root "$R"
   ```

   PowerShell:
   ```powershell
   $r = (Get-Content "$env:USERPROFILE\.claude\plugins\installed_plugins.json" -Raw -Encoding UTF8 | ConvertFrom-Json).plugins.'oh-my-claudecode@omc'[0].installPath
   node "<이 스킬 디렉터리 절대경로>\scripts\omc-patch.mjs" --revert --root $r
   ```

   - `되돌림  <훅 이름>` 줄과 `되돌리기 완료.` 를 확인한다. 끝의 `재시작해야 반영됩니다` 는 이 중간 단계에서는 무시한다. 2 에서 바로 다시 패치한다.
   - `되돌리기를 끝내지 못했습니다.` 가 나오면 멈추고 위의 `[!]` 줄을 그대로 보고한다. 종료 코드는 1 이다. 끝 줄의 `실패 N건` 은 쓰기를 거부한 파일, `되돌리지 못한 것 N건` 은 백업이 없거나 수동 백업 후보를 쓸 수 없어 남은 파일이다. 끝 줄은 링크로 같은 폴더를 가리키는 판이 여럿이어도 파일마다 한 번 센다.
   - `[!]` 줄에 `패치는 있는데 백업이 없어 되돌리지 못했습니다 — <이름>` 이 있으면 그 파일에 `.omcbak` 백업이 없는 것이다. 이 도구로는 되돌릴 원본이 없으니 멈추고 보고한다.
     - 원본은 같은 버전의 OMC 저장소에서 다시 받아야 한다. 이 명령은 사용자 승인 뒤에만 실행한다.
     - 파이프 대신 새 임시 폴더의 파일을 거친다. Windows PowerShell 5.1 의 파이프는 바이너리를 텍스트로 바꿔 파일을 깨뜨린다.
     - bash: `T=$(mktemp -d) && git -C '<마켓플레이스 폴더>' archive -o "$T/src.tar" 'v<버전>' 'scripts/<이름>.mjs' && tar -xf "$T/src.tar" -C '<활성 폴더>'; [ -n "$T" ] && rm -rf "$T"` 를 한 줄로 실행한다.
     - PowerShell: `$T = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName()); if (New-Item -ItemType Directory $T -ErrorAction SilentlyContinue) { git -C '<마켓플레이스 폴더>' archive -o "$T\src.tar" 'v<버전>' 'scripts/<이름>.mjs'; if ($LASTEXITCODE -eq 0) { tar -xf "$T\src.tar" -C '<활성 폴더>' }; Remove-Item -Recurse -Force $T }` 를 한 줄로 실행한다.
     - 둘 다 임시 폴더를 만들지 못하면 git 도 tar 도 돌리지 않는다. 다 쓴 임시 폴더는 지운다.

2. 적용한다.

   ```bash
   node "<이 스킬 디렉터리 절대경로>/scripts/omc-patch.mjs" --no-update
   ```

   - `패치 N건 / 실패 0건`, `[3/4]` 의 PostToolUse 제거, `[4/4]` 의 고정 결과를 확인한다.
   - 끝 줄 `완료. 실패 N건.` 의 N 이 1 이상이면 멈추고 출력 그대로 보고한다. 예외는 하나다. `완료. 실패 1건.` 이고 그 1건이 2단계에서 남기기로 한 `PINNED` 의 `[!]` 줄이면 멈추지 않고 4단계로 간다. 끝의 `[!] PostToolUse 훅 제거는 ...` 줄은 재시작 안내라 실패가 아니다.
   - `완료. 실패 1건.` 이고 그 1건이 1단계에 없던 `[!] 고정 기록(PINNED)` 줄이면 멈추고 보고한 뒤 `PINNED` 줄 다루기대로 묻는다. 훅 패치는 이미 적용돼 있다. 지우기로 하면 지운 뒤, 남기기로 하면 그대로 4단계로 간다.
   - `[!] 헬퍼 자리 결함 N건은 고치지 않았습니다.` 가 나오면 1 을 건너뛰었거나 1 이 그 파일을 되돌리지 못한 것이다. 1 과 2 를 한 번만 다시 한다. 다시 해도 같으면 멈추고 보고한다.

### 4. 검증 (다섯 가지 모두)

1. 다시 진단한다. `결과: 모두 적용된 상태입니다.` 가 나와야 하고, 활성 버전에 `헬퍼 자리 결함` 줄이 없어야 한다. 사용자가 `PINNED` 를 남기기로 했으면 `결과: 고정 기록(PINNED)의 옛 URL 칸이 이 도구로 지울 수 없는 곳에 있습니다.` 나 `결과: 고정 기록(PINNED)을 확인하지 못했습니다.` 와 그 `[!]` 줄이 나오는 것은 정상이다. 나머지 검증을 계속한다.

   ```bash
   node "<이 스킬 디렉터리 절대경로>/scripts/omc-patch.mjs" --check --no-update
   ```

2. 패치된 훅의 문법과 헬퍼 자리를 확인한다. `*.omcbak` 와 짝인 파일마다 `node --check` 의 종료 코드가 0 이고, `--scan` 이 낸 헬퍼 깊이가 모두 0 이면 정상이다.

   bash:
   ```bash
   R=$(node -e 'const j=require(require("path").join(require("os").homedir(),".claude/plugins/installed_plugins.json"));console.log(j.plugins["oh-my-claudecode@omc"][0].installPath)')
   set --; for b in "$R"/scripts/*.omcbak; do [ -e "$b" ] || continue; f="${b%.omcbak}"; node --check "$f"; rc=$?; echo "$(basename "$f") syntax=$rc"; set -- "$@" "$f"; done
   node "<이 스킬 디렉터리 절대경로>/scripts/omc-patch.mjs" --scan "$@" | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{for(const x of JSON.parse(s))console.log(require("path").basename(x.file),"depth="+x.helperDecls.map((d)=>d.depth).join(","))})'
   ```

   PowerShell:
   ```powershell
   $r = (Get-Content "$env:USERPROFILE\.claude\plugins\installed_plugins.json" -Raw -Encoding UTF8 | ConvertFrom-Json).plugins.'oh-my-claudecode@omc'[0].installPath
   [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
   $f = @(Get-ChildItem "$r\scripts\*.omcbak" | % { $_.FullName -replace '\.omcbak$','' })
   $f | % { node --check $_; "{0} syntax={1}" -f (Split-Path $_ -Leaf), $LASTEXITCODE }
   (node "<이 스킬 디렉터리 절대경로>\scripts\omc-patch.mjs" --scan @f | ConvertFrom-Json) | % { "{0} depth={1}" -f (Split-Path $_.file -Leaf), (@($_.helperDecls | % depth) -join ',') }
   ```

3. 패치된 훅 하나를 플러그인의 `scripts/run.cjs` 로 실제 실행한다.
   `OMC_NOTIFY=0` 은 이 시험 실행이 사용자의 알림 채널로 `session-idle` 알림을 보내지 않게 한다.

   bash:
   ```bash
   R=$(node -e 'const j=require(require("path").join(require("os").homedir(),".claude/plugins/installed_plugins.json"));console.log(j.plugins["oh-my-claudecode@omc"][0].installPath)')
   echo '{"session_id":"smoke-test","cwd":"/nonexistent","hook_event_name":"Stop"}' | CLAUDE_PLUGIN_ROOT="$R" OMC_NOTIFY=0 node "$R/scripts/run.cjs" "$R/scripts/persistent-mode.mjs"; echo "exit=$?"
   ```

   PowerShell:
   ```powershell
   $r = (Get-Content "$env:USERPROFILE\.claude\plugins\installed_plugins.json" -Raw -Encoding UTF8 | ConvertFrom-Json).plugins.'oh-my-claudecode@omc'[0].installPath
   $env:CLAUDE_PLUGIN_ROOT = $r; $env:OMC_NOTIFY = '0'
   '{"session_id":"smoke-test","cwd":"C:\\nonexistent","hook_event_name":"Stop"}' | node "$r\scripts\run.cjs" "$r\scripts\persistent-mode.mjs"; "exit=$LASTEXITCODE"
   Remove-Item Env:CLAUDE_PLUGIN_ROOT, Env:OMC_NOTIFY
   ```

   `{"continue":true,...}` 형태의 출력과 종료 코드 0 이면 정상. 훅 이름이 없으면 `*.omcbak` 와 짝인 다른 훅으로 바꾼다.

4. project-memory 훅이 실제로 일하는지 확인한다. 이 확인은 임시 폴더의 스크래치 프로젝트에서 훅을 돌린다. 홈, 설정 폴더, 상태 폴더도 그 안을 가리키게 하고 끝나면 지운다. 사용자의 `~/.claude` 와 작업 폴더의 `.omc` 는 건드리지 않는다.

   ```bash
   R=$(node -e 'const j=require(require("path").join(require("os").homedir(),".claude/plugins/installed_plugins.json"));console.log(j.plugins["oh-my-claudecode@omc"][0].installPath)')
   node "<이 스킬 디렉터리 절대경로>/scripts/probe-pm.mjs" --plugin "$R"
   ```

   PowerShell:
   ```powershell
   $r = (Get-Content "$env:USERPROFILE\.claude\plugins\installed_plugins.json" -Raw -Encoding UTF8 | ConvertFrom-Json).plugins.'oh-my-claudecode@omc'[0].installPath
   node "<이 스킬 디렉터리 절대경로>\scripts\probe-pm.mjs" --plugin $r
   ```

   | 결과 | 뜻과 다음 |
   |---|---|
   | `PROBE GREEN` | 정상 |
   | `PROBE RED: no project-memory.json` | 훅이 돌았지만 아무 일도 안 했다. 1단계나 4.1, 4.2 가 헬퍼 자리 결함을 보였고 2단계 승인이 있으면 3단계를 한 번만 다시 한다. 결함이 보이지 않거나 다시 해도 RED 면 출력을 그대로 보고하고 멈춘다. 느린 PC 에서 import 가 10초 제한에 걸린 경우처럼 원인이 다를 수 있다 |
   | 그 밖의 `PROBE RED` | 출력을 그대로 보고하고 멈춘다 |
   | 종료 코드 2 와 `훅 스크립트가 없습니다` 줄 | 그 버전에 project-memory 훅이 없다. 해당 없음으로 적는다 |
   | 그 밖의 `probe-pm:` 줄(종료 코드 2) | 명령 오류다. 경로를 다시 구해 한 번만 다시 실행한다. 같으면 출력을 보고하고 멈춘다 |
   | 판정 줄 뒤의 `probe-pm: 임시 폴더를 지우지 못함` | 판정은 그대로 쓴다. 남은 임시 폴더 경로를 보고에 적어 사용자가 지우게 한다 |

5. 마켓플레이스 고정을 확인한다. 명령은 origin 이 `omc-pinned://` 로 시작하는지만 보고 `pinned` 나 `not-pinned` 한 단어를 낸다. origin 의 자격 증명과 쿼리 값은 출력에 나오지 않는다. `pinned` 면 고정된 것이다.

   ```bash
   case "$(git -C "$HOME/.claude/plugins/marketplaces/omc" config --get remote.origin.url)" in omc-pinned://*) echo pinned;; *) echo not-pinned;; esac
   ```

   PowerShell:

   ```powershell
   if ((git -C "$env:USERPROFILE/.claude/plugins/marketplaces/omc" config --get remote.origin.url) -like 'omc-pinned://*') { 'pinned' } else { 'not-pinned' }
   ```

### 5. 보고

- 활성 버전, 패치 건수, 헬퍼 자리 결함 처리 여부, PostToolUse 제거 목록, 고정 상태, project-memory 확인 결과
- `PINNED` 줄이 있었으면 어떻게 했는지(지운 경로, 또는 남긴 기록과 그 경로. 다른 이름이 있던 기록은 다른 이름의 경로)
- 훅 스크립트 패치는 바로 적용된다. 훅이 호출될 때마다 파일을 새로 읽기 때문이다.
- PostToolUse 제거는 `hooks.json` 변경이라 각 세션을 다시 시작해야 적용된다.
- Windows 에서 이미 쌓인 커널 풀은 재부팅으로만 회수된다. 재부팅은 사용자가 직접 한다.
- Windows 에서 효과를 재려면 부하가 비슷한 24시간끼리 커널 풀 증가량을 비교한다. 유휴 시간에 늘지 않은 것은 증거가 아니다.

## 되돌리기 (인자 `revert`)

```bash
node "<이 스킬 디렉터리 절대경로>/scripts/omc-patch.mjs" --revert
```

- `.omcbak` 백업으로 설치된 모든 버전의 훅 스크립트와 `hooks.json` 을 되돌리고 마켓플레이스 `origin` 을 원래 URL 로 복구한다.
- 되돌린 뒤 Claude Code 를 다시 시작해야 반영된다.
- `되돌리기를 끝내지 못했습니다.` 가 나오면 위의 `[!]` 줄을 그대로 보고한다. 종료 코드는 1 이다. 백업이 없어 남은 파일과 hooks.json 도 이 끝 줄로 끝난다.
- 고정 기록(`PINNED`)을 지우지 못하면(읽기 전용 폴더, 폴더인 `PINNED`) `[!] 고정 기록(PINNED)을 지우지 못함` 으로 알리고 실패로 센다. 링크인 `PINNED` 너머에 옛 URL 칸이 있으면 링크를 두고 `[!]` 로 알린다. 옛 URL 칸이 든 기록에 같은 파일의 다른 이름이 있으면 이 이름만 지우고 `[!]` 로 알린다. 셋 다 origin 은 그대로 되돌린다. 위 `규칙` 절의 `PINNED` 줄 다루기대로 사용자에게 묻는다.
- `이 도구가 만들지 않은 수정이 남아 있습니다` 가 나오면 백업이 없는 손 수정이다. 출력에 적힌 복구 명령을 그대로 보고하고, 사용자 승인 없이 실행하지 않는다.

## 함정

- 도구의 `TARGET_VERSION`(5.7.0)은 소스에 고정돼 있다. 인자 없는 apply 만 이 값을 쓰고, 이 스킬은 그 apply 를 쓰지 않는다.
- OMC 가 훅 코드 구조를 바꾸면 패치 대상이 0건으로 나오거나 변환이 실패할 수 있다. 이때 `실패 N건` 과 `변환 실패` 를 그대로 보고한다.
- 헬퍼 자리 결함이 남은 채 `revert` 없이 적용을 다시 돌려도 바뀌는 것이 없다. 이미 감싼 파일은 건너뛰기 때문이다.
- `--root` 와 `--revert --root` 는 그 폴더만 다룬다. 고정 해제까지 하려면 인자 없는 `--revert` 를 쓴다.
- 고정을 풀지 않고 OMC 를 올리려면 먼저 `revert` 한다. 그렇지 않으면 마켓플레이스 fetch 가 계속 실패한다.
- 고정 기록(`PINNED`)은 `~/.claude/omc-local-patches/PINNED` 에 생긴다.
  - 고정한 시각, 패치한 판, 기기 이름만 담고 URL 은 담지 않는다.
  - 옛 판의 기록에 URL 칸이 있으면 `--check` 가 알리고 다음 적용 때 지운다. 지우지 못하면 `[!]` 로 알리고 실패로 센다(링크는 따라가 쓰지 않음).
  - 하드 링크로 이어진 다른 이름에는 그 칸이 남는다. 기록을 읽지 못했거나 JSON 이 아니면 남았을 수 있다고 알린다. 도구는 그 이름을 찾을 번호를 알린다.
  - POSIX 에서는 이 계정만 읽을 수 있다(0600). 기록 폴더는 처음 만들 때 이 계정만 쓰게(0700) 만든다. Windows 에서는 폴더의 상속 권한을 따른다.
  - 기록일 뿐이라 지워도 고정은 풀리지 않고, 이미 고정된 상태에서는 다시 만들어지지 않는다.
  - `revert` 는 origin 값에서만 원래 URL 을 되찾는다. 다른 기기의 기록이면 알리기만 한다.
- `--check` 와 `--revert` 를 함께 주면 도구는 아무것도 하지 않고 종료 코드 1 로 멈춘다. 진단만 하려면 `--check` 만 준다.
- 도구는 git 을 부를 때 저장소를 고르는 변수(`GIT_DIR`, `GIT_WORK_TREE` 등 `git rev-parse --local-env-vars` 목록)를 지운다. git 훅 안에서 불러도 마켓플레이스 저장소만 다룬다.
- 마켓플레이스의 `.git` 이 깨졌으면(중단된 clone 등) git 이 위쪽 저장소로 올라가지 못하게 막는다. 그때 `[4/4]` 는 `origin remote 없음` 으로 끝나고 고정하지 않는다.
- `--scan` 은 읽기만 한다. 플러그인 캐시도 `installed_plugins.json` 도 읽지 않고 준 파일만 본다.
- 도구는 모르는 인자를 받지 않는다. `--check`, `--revert`, `--no-update`, `--root <폴더>`, `--scan <파일>...`, `--help` 밖의 인자나 `--root=<폴더>` 꼴을 주면 아무것도 하지 않고 사용법과 함께 종료 1 로 멈춘다.
- 도구는 출력의 URL 을 `//` 뒤부터 마지막 `@` 까지 `***` 로 가린다. 비밀번호에 `/` `?` `#` 가 들어도 새지 않고, 경로에 `@` 가 든 URL 은 호스트까지 가려진다. 도구는 origin 을 설정 값 그대로 읽어 고정하고 되돌린다(전역 `insteadOf` 를 펼치지 않음).
- 인자 없는 apply 의 태그 받기는 시간 제한(120초)이 다 되거나 Ctrl+C 를 받으면 git 이 띄운 보조 프로세스까지 함께 끝낸다.
- 인자 없는 apply 가 태그를 받지 못하면 그 까닭을 한 줄로 알린다. 그 줄과 `--check` 의 origin 줄, `고정 실패`, `고정 해제 실패`, `origin 을 읽지 못함` 줄의 주소는 기본 상류(`https://github.com/Yeachan-Heo/oh-my-claudecode.git`)면 가린 꼴 그대로(쿼리는 이름 없는 토큰까지 통째로 `?***`), 그 밖이면 scheme 과 host 까지만 싣는다. 미러의 경로, 조각, `;` 매개변수에는 토큰이 들 수 있기 때문이다. 기본 상류인지는 호스트 앞의 사용자 정보만 빼고 본다. 경로의 `@` 뒤에 기본 상류를 적은 다른 호스트의 주소와 scheme 이 없는 주소(git 은 `user:<토큰>@github.com/...` 을 host `user` 의 scp 꼴로 읽는다)는 기본 상류가 아니다. git 의 줄에 든 주소는 git 이 찍은 그대로 읽어 꼴을 정하고, 줄의 나머지는 사용자 정보와 쿼리 값을 가린다. 다음 중 하나면 git 의 문구는 싣지 않고 종료 코드만 알린다. 그런 주소에서는 curl 이나 git 의 문구에 사용자 이름과 비밀번호 조각이 따옴표 밖에도 실릴 수 있기 때문이다.
  - origin 에 사용자 정보가 있음
  - git 의 오류 줄에 사용자 정보가 든 주소가 남음(전역 `insteadOf` 가 더한 것. 바른 꼴이면 git 이 줄에서 떼므로 그 줄은 그대로 싣는다)
  - 프록시 주소(`http_proxy` 같은 환경 변수, `http.proxy` 설정)의 사용자 정보에 날 `/` `?` `#` `\` 가 있음
- origin 을 바꾸지 못하면(`.git` 쓰기 권한 등) `[!] 고정 실패` 나 `[!] 고정 해제 실패` 와 종료 1 로 끝난다. 그 줄을 그대로 보고한다. 고정 해제에 실패하면 도구가 원래 URL 을 호스트까지만 보인다. 원문은 origin 의 `omc-pinned://` 뒤에 그대로 남는다.
- `--check` 는 쓸 수 없는 파일을 `패치 필요, 쓸 수 없음` 으로 미리 알린다. 폴더 밖 링크 때문에 되돌리지 못한 파일은 손 복구 방법을 함께 낸다. 링크 대상 파일이 지금 이 도구가 만드는 패치본과 같지 않거나(옛 헬퍼로 패치한 파일도) 읽어 확인할 수 없으면 덮어쓰라고 하지 않고, 링크가 가리키는 곳이 맞는지 먼저 확인하라고 한다. 사용자 승인 없이 그 방법을 실행하지 않는다.
- 파일은 새 임시 파일을 디스크까지 내린 뒤 rename 으로 바꾼다. 디스크로 내리기를 받지 않는 파일 시스템(fsync 가 `EINVAL`, `ENOTSUP`)에서는 내리지 않고 바꾼다. 하드 링크로 이어진 폴더 밖 파일은 바뀌지 않는다. 쓰지 못한 파일은 `쓰지 못함` 으로 이름을 대고 실패로 센다.
- 읽을 수 없는 훅과 쓸 수 없는 훅
  - 읽을 수 없는 훅(권한, 폴더, FIFO)은 `읽지 못함: <이름> (<코드>)` 으로 알리고 실패로 센다.
  - 이미 있는 백업(`.omcbak`)을 읽지 못하면 적용은 그 훅을 패치하지 않고 `읽지 못함: <이름> 의 백업 (<코드>)` 으로 알리고 실패로 센다. hooks.json 은 `hooks.json 의 백업을 읽지 못함 (<코드>)` 이다.
  - 쓸 권한이 없거나 일반 파일이 아닌 훅은 `쓰지 않음: <이름> (쓸 권한이 없음 또는 일반 파일이 아님)` 으로 알리고 실패로 센다.
  - `--check` 는 활성 버전의 훅을 읽지 못하면 `결과: 훅 스크립트를 확인하지 못했습니다.` 와 종료 1 로 끝난다. 다시 실행하라고 하지 않는다.
  - 비활성 버전의 훅이나 `hooks.json` 을 읽지 못하면 결과 줄은 바꾸지 않고 `참고:` 줄로 알린다. 종료 코드는 그래도 1 이다.
- 설정 파일도 일반 파일만 읽는다.
  - `installed_plugins.json` 이 FIFO 처럼 일반 파일이 아니면 활성 버전이 `(추정: ...)` 으로 나온다.
  - `settings.json` 이 그렇다면 `DISABLE_AUTOUPDATER` 줄을 생략한다.
- 도구가 처리하지 못한 오류는 경로를 정화한 한 줄과 종료 1 로 끝난다.
- 도구의 주석과 출력 문구는 한글이다.
