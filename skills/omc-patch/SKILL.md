---
name: omc-patch
description: "OMC 플러그인이 자동 업데이트된 뒤 사라진 훅 패치를 활성 버전에 다시 적용하고 OMC 마켓플레이스 자동 업데이트를 막음. 진단, 적용, 검증, 되돌리기. 'omc-patch'/'OMC 패치'/'OMC 업데이트 뒤 패치'/'훅 timed out'/'훅 프로세스 누적'/'PC 느려짐' 시 사용."
argument-hint: "[check | revert]"
---

# omc-patch — OMC 훅 패치 재적용과 자동 업데이트 고정

OMC(oh-my-claudecode)가 새 버전으로 자동 업데이트되면 로컬 훅 패치가 사라진다. 그러면 도구 호출마다 훅 프로세스가 많이 생기고, Windows 에서는 커널 풀(paged pool)이 계속 늘어 PC 가 느려진다.
이 스킬은 같은 폴더의 `scripts/omc-patch.mjs` 로 패치를 다시 적용하고 결과를 검증한다. 답변은 한글.

패치 내용은 두 가지다.
- 훅 스크립트 최상위의 `await import(...)` 에 10초 시간 제한을 건다. 로드가 멈춰도 훅이 끝까지 가고 프로세스가 남지 않는다.
- `hooks.json` 의 `PostToolUse` 훅을 제거한다.

추가로 OMC 마켓플레이스 저장소의 `origin` 을 `omc-pinned://<원래 URL>` 로 바꿔 자동 업데이트를 막는다.

## 인자

| 인자 | 동작 |
|---|---|
| 없음 | 진단, 사용자 확인, 적용, 검증 |
| `check` | 진단만. 아무것도 바꾸지 않음 |
| `revert` | 패치와 고정을 되돌림. 사용자가 명시했을 때만 |

## 규칙

- 이 작업은 사용자 설정 폴더(`~/.claude`)의 플러그인 캐시를 고치는 설정 변경이다. 서브에이전트에 맡기지 않고 메인 세션에서 직접 실행하고 직접 검증한다.
- 적용은 `--no-update` 로만 실행한다. 인자 없는 apply 는 쓰지 않는다. 활성 OMC 를 도구의 `TARGET_VERSION`(5.3.0)으로 내리고, `revert` 로도 버전이 돌아오지 않는다.
- 도구가 출력하는 `인자 없이 다시 실행하십시오.` 문구는 따르지 않는다. 이 스킬에서는 항상 `--no-update` 를 붙인다.
- 패치 규칙은 OMC 훅 코드의 모양에 맞춰져 있다. 처음 보는 OMC 버전이면 반드시 `check` 를 먼저 실행한다.
- `실패 N건` 이 1건 이상이면 멈추고 출력을 그대로 보고한다. 문법 오류가 난 파일은 도구가 원본으로 자동 롤백한다.
- 판정은 출력 문구로 한다. 종료 코드 0 만으로 완료라고 보고하지 않는다.
- 캐시에는 정션이나 심볼릭 링크로 이어진 버전 폴더가 있을 수 있다(예: 옛 버전 폴더가 새 버전을 가리킴). 이때 한 번의 변경이 두 버전 폴더에 함께 보인다. 정상이다.
- 도구는 `os.homedir()/.claude` 를 쓴다. `CLAUDE_CONFIG_DIR` 로 설정 폴더를 옮겼다면 이 도구는 그 폴더를 보지 않는다.
- 출력의 origin 에 `https://사용자:토큰@...` 처럼 자격증명이 들어 있으면, 보고할 때 `//***@` 로 가린다. 출력을 그대로 보고하라는 단계에서도 이 가림은 지킨다. 그 URL 은 `PINNED` 에도 평문으로 남으니 사용자에게 알린다.

## 절차

스크립트 경로는 `<이 스킬 디렉터리 절대경로>/scripts/omc-patch.mjs` 이다. Node 18 이상과 `git` 이 필요하다. 모든 명령은 OS 구분 없이 같다.

### 1. 진단

```bash
node "<이 스킬 디렉터리 절대경로>/scripts/omc-patch.mjs" --check --no-update
```

- `활성 버전: X (installed_plugins.json)` 줄로 실제 활성 버전을 확인한다.
- 그 줄이 `(추정: ...)` 로 끝나면 도구가 `installed_plugins.json` 에서 활성 버전을 찾지 못한 것이다. 적용하지 않고 출력을 그대로 보고하고 끝낸다. 추정한 폴더를 패치하면 실제 활성 버전은 그대로 남는데 `check` 는 적용된 것으로 보일 수 있다.
- `패치 필요 N건` 은 설치된 모든 버전 폴더를 합친 수다. 판정은 맨 아래 `결과:` 줄로 한다.
- `결과: 모두 적용된 상태입니다.` 이면 4단계 검증으로 건너뛴다.
- `참고: 비활성 버전 ...` 은 지금 쓰지 않는 버전이라 판정에 들어가지 않는다.
- 인자가 `check` 이면 여기서 결과만 보고하고 끝낸다.

### 2. 확인 (적용 전 필수)

`--check` 결과를 보여 주고 사용자에게 적용해도 되는지 묻는다. 묻기 전에 아래를 알린다.
- 활성 OMC 버전의 `scripts/*.mjs` 와 `hooks/hooks.json` 을 고친다. 원본은 `.omcbak` 로 남는다.
- OMC 마켓플레이스 `origin` 을 `omc-pinned://` 로 바꾼다. OMC 가 더 이상 자동 업데이트되지 않는다. 되돌리기는 `revert`.
- 승인이 없으면 적용하지 않는다.

### 3. 적용

```bash
node "<이 스킬 디렉터리 절대경로>/scripts/omc-patch.mjs" --no-update
```

- `패치 N건 / 실패 0건`, `[3/4]` 의 PostToolUse 제거, `[4/4]` 의 고정 결과를 확인한다.
- 실패가 1건 이상이면 멈추고 출력 그대로 보고한다.

### 4. 검증 (세 가지 모두)

1. 다시 진단한다. `결과: 모두 적용된 상태입니다.` 가 나와야 한다.

   ```bash
   node "<이 스킬 디렉터리 절대경로>/scripts/omc-patch.mjs" --check --no-update
   ```

2. 패치된 훅의 문법을 확인한다. `*.omcbak` 와 짝인 파일마다 `node --check` 를 실행하고 종료 코드 0 을 확인한다.

   bash:
   ```bash
   R=$(node -e 'const j=require(require("path").join(require("os").homedir(),".claude/plugins/installed_plugins.json"));console.log(j.plugins["oh-my-claudecode@omc"][0].installPath)')
   for b in "$R"/scripts/*.omcbak; do [ -e "$b" ] || continue; f="${b%.omcbak}"; node --check "$f"; rc=$?; echo "$(basename "$f") syntax=$rc"; done
   ```

   PowerShell:
   ```powershell
   $r = (Get-Content "$env:USERPROFILE\.claude\plugins\installed_plugins.json" -Raw | ConvertFrom-Json).plugins.'oh-my-claudecode@omc'[0].installPath
   Get-ChildItem "$r\scripts\*.omcbak" | % { $f = $_.FullName -replace '\.omcbak$',''; node --check $f; "{0} syntax={1}" -f (Split-Path $f -Leaf), $LASTEXITCODE }
   ```

3. 패치된 훅 하나를 플러그인의 `scripts/run.cjs` 로 실제 실행한다. 명령마다 새 셸일 수 있으니 경로를 다시 구한다.
   `OMC_NOTIFY=0` 은 이 시험 실행이 사용자의 알림 채널로 `session-idle` 알림을 보내지 않게 한다.

   bash:
   ```bash
   R=$(node -e 'const j=require(require("path").join(require("os").homedir(),".claude/plugins/installed_plugins.json"));console.log(j.plugins["oh-my-claudecode@omc"][0].installPath)')
   echo '{"session_id":"smoke-test","cwd":"/nonexistent","hook_event_name":"Stop"}' | CLAUDE_PLUGIN_ROOT="$R" OMC_NOTIFY=0 node "$R/scripts/run.cjs" "$R/scripts/persistent-mode.mjs"; echo "exit=$?"
   ```

   PowerShell:
   ```powershell
   $r = (Get-Content "$env:USERPROFILE\.claude\plugins\installed_plugins.json" -Raw | ConvertFrom-Json).plugins.'oh-my-claudecode@omc'[0].installPath
   $env:CLAUDE_PLUGIN_ROOT = $r; $env:OMC_NOTIFY = '0'
   '{"session_id":"smoke-test","cwd":"C:\\nonexistent","hook_event_name":"Stop"}' | node "$r\scripts\run.cjs" "$r\scripts\persistent-mode.mjs"; "exit=$LASTEXITCODE"
   Remove-Item Env:CLAUDE_PLUGIN_ROOT, Env:OMC_NOTIFY
   ```

   `{"continue":true,...}` 형태의 출력과 종료 코드 0 이면 정상. 훅 이름이 없으면 `*.omcbak` 와 짝인 다른 훅으로 바꾼다.

4. 마켓플레이스 고정을 확인한다. `omc-pinned://` 로 시작하면 고정된 것이다.

   ```bash
   git -C "$HOME/.claude/plugins/marketplaces/omc" remote get-url origin
   ```

   PowerShell 에서는 `$HOME` 대신 `$env:USERPROFILE` 을 쓴다.

### 5. 보고

- 활성 버전, 패치 건수, PostToolUse 제거 목록, 고정 상태
- 훅 스크립트 패치는 바로 적용된다. 훅이 호출될 때마다 파일을 새로 읽기 때문이다.
- PostToolUse 제거는 `hooks.json` 변경이라 각 세션을 다시 시작해야 적용된다.
- Windows 에서 이미 쌓인 커널 풀은 재부팅으로만 회수된다. 재부팅은 사용자가 직접 한다.

## 되돌리기 (인자 `revert`)

```bash
node "<이 스킬 디렉터리 절대경로>/scripts/omc-patch.mjs" --revert
```

- `.omcbak` 백업으로 훅 스크립트와 `hooks.json` 을 되돌리고 마켓플레이스 `origin` 을 원래 URL 로 복구한다.
- 되돌린 뒤 Claude Code 를 다시 시작해야 반영된다.
- `이 도구가 만들지 않은 수정이 남아 있습니다` 가 나오면 백업이 없는 손 수정이다. 출력에 적힌 복구 명령을 그대로 보고하고, 사용자 승인 없이 실행하지 않는다.

## 함정

- 도구의 `TARGET_VERSION`(5.3.0)은 소스에 고정돼 있다. 인자 없는 apply 만 이 값을 쓰고, 이 스킬은 그 apply 를 쓰지 않는다.
- OMC 가 훅 코드 구조를 바꾸면 패치 대상이 0건으로 나오거나 변환이 실패할 수 있다. 이때 `실패 N건` 과 `변환 실패` 를 그대로 보고한다.
- 고정을 풀지 않고 OMC 를 올리려면 먼저 `revert` 한다. 그렇지 않으면 마켓플레이스 fetch 가 계속 실패한다.
- 고정 기록(`PINNED`)은 `~/.claude/omc-local-patches/PINNED` 에 생긴다. 기록일 뿐이라 지워도 고정은 풀리지 않고, 이미 고정된 상태에서는 다시 만들어지지 않는다. `revert` 는 origin 값에서 원래 URL 을 되찾는다.
- 도구의 주석과 출력 문구는 한글이다.
