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
- 쓸 파일이 링크로 플러그인 폴더 밖을 가리키거나 백업 자리(`.omcbak`)가 링크면 도구는 쓰지 않고 실패로 센다. 문구는 적용 때 `쓰지 않음`, 되돌리기 때 `되돌리지 않음`, hooks.json 은 `hooks.json 을 건드리지 않음` 이다.
- 패치 규칙은 OMC 훅 코드의 모양에 맞춰져 있다. 처음 보는 OMC 버전이면 반드시 `check` 를 먼저 실행한다.
- `실패 N건` 이 1건 이상이면 멈추고 출력을 그대로 보고한다. 문법 오류가 난 파일은 도구가 원본으로 자동 롤백한다.
- 판정은 출력 문구로 한다. 종료 코드 0 만으로 완료라고 보고하지 않는다.
- 캐시에는 정션이나 심볼릭 링크로 이어진 버전 폴더가 있을 수 있다(예: 옛 버전 폴더가 새 버전을 가리킴). 이때 한 번의 변경이 두 버전 폴더에 함께 보인다. 정상이다.
- 도구는 `os.homedir()/.claude` 를 쓴다. `CLAUDE_CONFIG_DIR` 로 설정 폴더를 옮겼다면 이 도구는 그 폴더를 보지 않는다.
- 출력의 origin 에 `https://사용자:토큰@...` 처럼 자격증명이 들어 있으면, 보고할 때 `//***@` 로 가린다. 출력을 그대로 보고하라는 단계에서도 이 가림은 지킨다. 그 URL 은 `PINNED` 에도 평문으로 남으니 사용자에게 알린다.

## 절차

스크립트는 `<이 스킬 디렉터리 절대경로>/scripts/` 의 `omc-patch.mjs` 와 `probe-pm.mjs` 다. Node 18 이상과 `git` 이 필요하다.
활성 플러그인 폴더(아래 `R`, `$r`)는 명령마다 다시 구한다. 명령마다 새 셸일 수 있다.

bash:
```bash
R=$(node -e 'const j=require(require("path").join(require("os").homedir(),".claude/plugins/installed_plugins.json"));console.log(j.plugins["oh-my-claudecode@omc"][0].installPath)')
```

PowerShell:
```powershell
$r = (Get-Content "$env:USERPROFILE\.claude\plugins\installed_plugins.json" -Raw | ConvertFrom-Json).plugins.'oh-my-claudecode@omc'[0].installPath
```

### 1. 진단

```bash
node "<이 스킬 디렉터리 절대경로>/scripts/omc-patch.mjs" --check --no-update
```

- `활성 버전: X (installed_plugins.json)` 줄로 실제 활성 버전을 확인한다.
- 그 줄이 `(추정: ...)` 로 끝나면 도구가 `installed_plugins.json` 에서 활성 버전을 찾지 못한 것이다. 적용하지 않고 출력을 그대로 보고하고 끝낸다. 추정한 폴더를 패치하면 실제 활성 버전은 그대로 남는데 `check` 는 적용된 것으로 보일 수 있다.
- `패치 필요 N건` 은 설치된 모든 버전 폴더를 합친 수다. 판정은 맨 아래 `결과:` 줄로 한다.

| `결과:` 줄 | 다음 |
|---|---|
| `모두 적용된 상태입니다.` | 4단계 검증으로 건너뜀 |
| `헬퍼 자리 결함 N건이 있습니다.` | 2단계 확인 뒤 3단계에서 활성 폴더부터 되돌림 |
| `적용되지 않은 항목이 있습니다.` | 2단계 확인 뒤 3단계 적용 |

- `참고: 비활성 버전 ...` 은 지금 쓰지 않는 버전이라 판정에 들어가지 않는다.
- 인자가 `check` 이면 여기서 결과만 보고하고 끝낸다.

### 2. 확인 (적용 전 필수)

`--check` 결과를 보여 주고 사용자에게 적용해도 되는지 묻는다. 묻기 전에 아래를 알린다.
- 활성 OMC 버전의 `scripts/*.mjs` 와 `hooks/hooks.json` 을 고친다. 원본은 `.omcbak` 로 남는다.
- 헬퍼 자리 결함이 있으면 활성 폴더를 `.omcbak` 원본으로 먼저 되돌린 뒤 다시 패치한다.
- OMC 마켓플레이스 `origin` 을 `omc-pinned://` 로 바꾼다. OMC 가 더 이상 자동 업데이트되지 않는다. 되돌리기는 `revert`.
- 승인이 없으면 적용하지 않는다.

### 3. 적용

1. 1단계가 헬퍼 자리 결함을 냈으면 활성 폴더만 먼저 되돌린다. `--root` 는 그 폴더의 훅과 `hooks.json` 만 다룬다. 마켓플레이스 고정과 다른 버전 폴더는 건드리지 않는다.

   ```bash
   R=$(node -e 'const j=require(require("path").join(require("os").homedir(),".claude/plugins/installed_plugins.json"));console.log(j.plugins["oh-my-claudecode@omc"][0].installPath)')
   node "<이 스킬 디렉터리 절대경로>/scripts/omc-patch.mjs" --revert --root "$R"
   ```

   PowerShell:
   ```powershell
   $r = (Get-Content "$env:USERPROFILE\.claude\plugins\installed_plugins.json" -Raw | ConvertFrom-Json).plugins.'oh-my-claudecode@omc'[0].installPath
   node "<이 스킬 디렉터리 절대경로>\scripts\omc-patch.mjs" --revert --root $r
   ```

   - `되돌림  <훅 이름>` 줄과 `되돌리기 완료.` 를 확인한다. 끝의 `재시작해야 반영됩니다` 는 이 중간 단계에서는 무시한다. 2 에서 바로 다시 패치한다.
   - `되돌리기를 끝내지 못했습니다.` 가 나오면 멈추고 위의 `[!]` 줄을 그대로 보고한다. 종료 코드는 1 이다. 끝 줄의 `실패 N건` 은 쓰기를 거부한 파일, `되돌리지 못한 것 N건` 은 백업이 없거나 수동 백업 후보를 쓸 수 없어 남은 파일이다. 끝 줄은 링크로 같은 폴더를 가리키는 판이 여럿이어도 파일마다 한 번 센다.
   - `[!]` 줄에 `패치는 있는데 백업이 없어 되돌리지 못했습니다 — <이름>` 이 있으면 그 파일에 `.omcbak` 백업이 없는 것이다. 이 도구로는 되돌릴 원본이 없으니 멈추고 보고한다. 원본은 같은 버전의 OMC 저장소에서 다시 받아야 한다. 파이프 대신 파일을 거친다(Windows PowerShell 5.1 의 파이프는 바이너리를 텍스트로 바꿔 파일을 깨뜨린다): `git -C "<마켓플레이스 폴더>" archive -o "<임시 tar>" v<버전> scripts/<이름>.mjs` 뒤 `tar -xf "<임시 tar>" -C "<활성 폴더>"`. 이 명령은 사용자 승인 뒤에만 실행한다.

2. 적용한다.

   ```bash
   node "<이 스킬 디렉터리 절대경로>/scripts/omc-patch.mjs" --no-update
   ```

   - `패치 N건 / 실패 0건`, `[3/4]` 의 PostToolUse 제거, `[4/4]` 의 고정 결과를 확인한다.
   - 실패가 1건 이상이면 멈추고 출력 그대로 보고한다.
   - `[!] 헬퍼 자리 결함 N건은 고치지 않았습니다.` 가 나오면 1 을 건너뛰었거나 1 이 그 파일을 되돌리지 못한 것이다. 1 과 2 를 한 번만 다시 한다. 다시 해도 같으면 멈추고 보고한다.

### 4. 검증 (다섯 가지 모두)

1. 다시 진단한다. `결과: 모두 적용된 상태입니다.` 가 나와야 하고, 활성 버전에 `헬퍼 자리 결함` 줄이 없어야 한다.

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
   $r = (Get-Content "$env:USERPROFILE\.claude\plugins\installed_plugins.json" -Raw | ConvertFrom-Json).plugins.'oh-my-claudecode@omc'[0].installPath
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
   $r = (Get-Content "$env:USERPROFILE\.claude\plugins\installed_plugins.json" -Raw | ConvertFrom-Json).plugins.'oh-my-claudecode@omc'[0].installPath
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
   $r = (Get-Content "$env:USERPROFILE\.claude\plugins\installed_plugins.json" -Raw | ConvertFrom-Json).plugins.'oh-my-claudecode@omc'[0].installPath
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

5. 마켓플레이스 고정을 확인한다. `omc-pinned://` 로 시작하면 고정된 것이다.

   ```bash
   git -C "$HOME/.claude/plugins/marketplaces/omc" remote get-url origin
   ```

   PowerShell 에서는 `$HOME` 대신 `$env:USERPROFILE` 을 쓴다.

### 5. 보고

- 활성 버전, 패치 건수, 헬퍼 자리 결함 처리 여부, PostToolUse 제거 목록, 고정 상태, project-memory 확인 결과
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
- `이 도구가 만들지 않은 수정이 남아 있습니다` 가 나오면 백업이 없는 손 수정이다. 출력에 적힌 복구 명령을 그대로 보고하고, 사용자 승인 없이 실행하지 않는다.

## 함정

- 도구의 `TARGET_VERSION`(5.7.0)은 소스에 고정돼 있다. 인자 없는 apply 만 이 값을 쓰고, 이 스킬은 그 apply 를 쓰지 않는다.
- OMC 가 훅 코드 구조를 바꾸면 패치 대상이 0건으로 나오거나 변환이 실패할 수 있다. 이때 `실패 N건` 과 `변환 실패` 를 그대로 보고한다.
- 헬퍼 자리 결함이 남은 채 `revert` 없이 적용을 다시 돌려도 바뀌는 것이 없다. 이미 감싼 파일은 건너뛰기 때문이다.
- `--root` 와 `--revert --root` 는 그 폴더만 다룬다. 고정 해제까지 하려면 인자 없는 `--revert` 를 쓴다.
- 고정을 풀지 않고 OMC 를 올리려면 먼저 `revert` 한다. 그렇지 않으면 마켓플레이스 fetch 가 계속 실패한다.
- 고정 기록(`PINNED`)은 `~/.claude/omc-local-patches/PINNED` 에 생긴다. 기록일 뿐이라 지워도 고정은 풀리지 않고, 이미 고정된 상태에서는 다시 만들어지지 않는다. `revert` 는 origin 값에서만 원래 URL 을 되찾고, `PINNED` 의 값으로 origin 을 쓰지 않는다. 다른 기기의 기록이면 알리기만 한다.
- `--check` 와 `--revert` 를 함께 주면 도구는 아무것도 하지 않고 종료 코드 1 로 멈춘다. 진단만 하려면 `--check` 만 준다.
- 도구는 git 을 부를 때 저장소를 고르는 변수(`GIT_DIR`, `GIT_WORK_TREE` 등 `git rev-parse --local-env-vars` 목록)를 지운다. git 훅 안에서 불러도 마켓플레이스 저장소만 다룬다.
- 마켓플레이스의 `.git` 이 깨졌으면(중단된 clone 등) git 이 위쪽 저장소로 올라가지 못하게 막는다. 그때 `[4/4]` 는 `origin remote 없음` 으로 끝나고 고정하지 않는다.
- `--scan` 은 읽기만 한다. 플러그인 캐시도 `installed_plugins.json` 도 읽지 않고 준 파일만 본다.
- 도구의 주석과 출력 문구는 한글이다.
