---
name: setup-pwsh
description: "Windows 에 PowerShell 7 과 Git 을 winget 으로 설치하고, `$PROFILE` 을 BOM 없는 UTF-8 로 설정한 뒤 검증. Windows 가 아니면 감지만 하고 아무것도 바꾸지 않음. 'setup-pwsh'/'PowerShell 설치'/'pwsh 환경 설정' 또는 `/banker:setup` 시 사용."
---

# setup-pwsh: Windows PowerShell 7 환경 설치

banker 의 Windows 워크플로 - Claude Code 의 Git Bash 배선, Codex/OMX 의 네이티브 셸 실행 - 이
전제하는 PowerShell 7 + Git + `$PROFILE` 환경을 구성한다. **Windows 전용 스킬**이다 - 다른 OS 에서는
먼저 감지해 "Windows 전용 - 해당 없음"으로 정직하게 no-op 보고한다(이것도 유효한 결과). 설치는
**멱등**. 답변은 한글(기술 토큰 영문).

## 런타임 배선
- **Claude Code**: Bash 도구가 Git Bash 를 쓰도록 `settings.json` 의 `env.CLAUDE_CODE_GIT_BASH_PATH`
  를 설정한다(예: `C:\Program Files\Git\bin\bash.exe`). 네이티브 Windows 는 1급 지원이며 **WSL 은
  필요 없다**(현재 공식 문서 기준 - WSL 은 샌드박싱·Linux 툴체인이 필요할 때만 선택 사항).
- **Codex**: 네이티브 PowerShell 셸에서 그대로 동작한다(별도 배선 불필요). AOAI 키 등 환경변수는
  **User-scope** 로 저장하고, Process/User/Machine **3-scope 동기화**에 유의한다 - 저장 직후 현재
  프로세스에는 반영되지 않을 수 있다.

## 0. 감지 (먼저 - 추정 금지)
```powershell
$PSVersionTable.PSVersion
$env:OS                       # Windows = 'Windows_NT' (PS 5.1·7 공통), 비-Windows 는 미설정
Get-Command git, pwsh -ErrorAction SilentlyContinue
```
- **Windows 판정 = `$env:OS -eq 'Windows_NT'`** (또는 `[System.Environment]::OSVersion.Platform -eq 'Win32NT'`).
  ⚠️ `$IsWindows` 자동 변수는 **PowerShell 7+ 에만** 있어, 이 스킬이 업그레이드하려는 **Windows PowerShell 5.1
  에서는 `$null`(미정의)** 이다 - `$IsWindows` 로만 판정하면 진짜 Windows 를 비-Windows 로 오판해 no-op 한다. 보조 신호로만 쓴다.
- 비-Windows(PowerShell 없이 `uname` 만)면 **"Windows 전용 - 해당 없음"** 을 보고하고 멈춘다(no-op 도 유효한 결과).

### 네트워크 확인 (내려받기 전)

winget 의 기본 원천에 10초 안에 닿는지 먼저 본다. 닿지 않으면 winget 을 부르지 않고, 이미 설치된 pwsh 의 확인만 한 뒤 "오프라인이라 설치하지 않음(필요한 것: PowerShell 7)" 으로 보고한다.

```powershell
if ($env:CODEX_SANDBOX_NETWORK_DISABLED -eq '1') { 'Codex sandbox 가 네트워크를 막음(아래 실패는 오프라인이 아님)' }
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
  curl.exe --ssl-no-revoke -sSI -o NUL --connect-timeout 5 --max-time 10 https://cdn.winget.microsoft.com/cache  # winget 의 기본 원천(머리만)
  "rc=$LASTEXITCODE"                                                                                             # 0 이면 닿음
} else { 'curl.exe 없음(확인하지 못함)' }
```

- PowerShell 5.1 의 `curl` 은 `Invoke-WebRequest` 별칭이라 `curl.exe` 로 부른다. `curl.exe` 는 Windows 시스템 프록시를 따르지 않고 `HTTPS_PROXY` 만 따른다. 시스템 프록시만 쓰는 망이면 `HTTPS_PROXY` 를 먼저 맞추고 본다.
- `--ssl-no-revoke` 는 폐지 목록 서버에 닿지 못하는 망에서 Schannel 의 폐지 확인 실패를 오프라인으로 읽지 않게 한다. 닿는지만 보고 받은 내용은 쓰지 않으므로 이 확인에만 준다. `curl.exe` 가 없으면 `$LASTEXITCODE` 에 앞 명령의 값이 남으므로 `Get-Command curl.exe -ErrorAction SilentlyContinue` 로 먼저 보고, 없으면 확인하지 못한 것으로 적는다(블록이 그렇게 한다).
- 사내 winget 원천을 쓰면(`winget source list`) 그 주소로 본다.
- Codex sandbox 가 네트워크를 막는 모드(기본 `workspace-write`, `read-only`)에서는 `CODEX_SANDBOX_NETWORK_DISABLED=1` 이 서고 확인이 모두 실패한다(curl 종료 7, npm `EPERM`). 블록의 첫 줄이 그렇다고 알린다. 그때는 '오프라인' 이 아니라 'sandbox 가 네트워크를 막음' 으로 보고하고, 승인을 받아 sandbox 밖에서 확인부터 다시 한다. Claude Code sandbox 안(`SANDBOX_RUNTIME=1`)에서는 허용 목록 밖 주소를 sandbox 프록시가 막는다. Windows PowerShell 에서는 `$env:CODEX_SANDBOX_NETWORK_DISABLED -eq '1'` 로 본다.
- 확인이 실패하면 보고에 그 명령, 종료 코드, stderr 첫 줄을 붙인다(예: `npm error code ETIMEDOUT`, `curl: (28) ...`). 원인을 '오프라인' 하나로 짐작하지 않는다.
- curl 의 종료 60(인증서 검증 실패)도 오프라인이 아니다. 망은 열려 있고, TLS 를 가로채는 사내 프록시의 인증서를 OS 가 믿지 않는 것이다. '인증서 문제로 설치하지 않음' 으로 보고한다.

## 1. winget 설치
```powershell
winget install --id Microsoft.PowerShell -e
winget install --id Microsoft.WindowsTerminal -e
winget install --id Git.Git -e
git config --global core.autocrlf input
```
winget 은 이미 설치된 패키지를 스스로 skip 한다(멱등) - 강제 재설치 불필요.

## 2. `$PROFILE` 작성 - UTF-8 무BOM 전용 경로
**`Add-Content`/`Out-File -Encoding UTF8` 금지** - 둘 다 CP949 재인코딩 또는 UTF-8 BOM 혼입으로
이후 한글 주석·파싱을 깨뜨린다. 반드시 아래 방식만 쓴다:
```powershell
$marker = "# BANKER_PWSH_BEGIN"
$existing = if (Test-Path $PROFILE) { [System.IO.File]::ReadAllText($PROFILE) } else { "" }
if ($existing -notmatch [regex]::Escape($marker)) {
  # <java21-bin>/<python-dir> 은 실제 설치 경로로 교체 - 추정 금지, §0/설치 로그에서 확인 후 채운다
  # (winget install Microsoft.OpenJDK.21 후 `Get-ChildItem "$env:ProgramFiles" -Filter "*jdk-21*"` 등으로 확인)
  $block = @"
$marker
# PATH 순서: Java21 우선(잔존 구버전 Java 덮기) -> python -> ~/.local/bin -> jdtls
`$env:PATH = "<java21-bin>;`$env:PATH"
`$env:PATH = "`$env:PATH;<python-dir>"
`$env:PATH = "`$env:PATH;`$HOME\.local\bin"
`$env:PATH = "`$env:PATH;`$HOME\.local\jdtls\bin"
# BANKER_PWSH_END
"@
  $content = $existing + "`n" + $block
  [System.IO.File]::WriteAllText($PROFILE, $content, (New-Object System.Text.UTF8Encoding($false)))
}
```
- PATH 순서 원칙: **Java21 을 맨 앞**에 둬 PATH 상에 남아있을 수 있는 구버전 Java 를 덮고, 그다음
  python, `~/.local/bin`, jdtls 순으로 이어붙인다.
- 마커 블록(`# BANKER_PWSH_BEGIN`/`END`)으로 재실행해도 중복 append 되지 않는다(사용자 기존 내용은
  보존).

## 3. 런타임 배선 적용
**Claude Code** - `settings.json` 에 기존 키를 보존하며 병합:
```json
{ "env": { "CLAUDE_CODE_GIT_BASH_PATH": "C:\\Program Files\\Git\\bin\\bash.exe" } }
```
**Codex/OMX 환경변수** - User-scope 로 저장(예: AOAI 키):
```powershell
[Environment]::SetEnvironmentVariable('AZURE_OPENAI_API_KEY', $env:AZURE_OPENAI_API_KEY, 'User')
```

## 검증 (보고 의무)
```powershell
pwsh -v
$PSVersionTable.PSVersion
git config --get core.autocrlf                                     # input 기대

$b = [System.IO.File]::ReadAllBytes($PROFILE)[0..2]
if (("{0:X2}{1:X2}{2:X2}" -f $b[0],$b[1],$b[2]) -eq "EFBBBF") { "BOM 있음 -- 재작성 필요" } else { "무BOM 확인" }

pwsh -Command "Write-Output 'profile-load-ok'"                     # $PROFILE 이 에러 없이 실제 로드되는지
```
4-field 보고: 변경(설치 패키지·`$PROFILE` 마커블록·settings.json 병합 여부) / Evidence(위 출력) /
검증(무BOM·`profile-load-ok`·autocrlf=input) / Unknown(관리자 권한이 필요한 항목 등).

## 함정
- **CP949/BOM 오염**: `$PROFILE` 은 오직 `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))`
  로만 쓴다 - `Add-Content`/`Out-File -Encoding UTF8` 은 절대 쓰지 않는다.
- **MS Store Python stub**: `python`/`python3` 를 MS Store 앱 실행 별칭(App execution aliases)이
  가로채 스토어를 여는 경우가 있다 → 설정 → 앱 → 고급 앱 설정 → 앱 실행 별칭에서 꺼야 실제 설치된
  Python 이 잡힌다.
- **심볼릭 링크 권한**: 심볼릭 링크 생성은 개발자 모드 또는 관리자 권한이 필요하다 - 둘 다 없으면
  조용히 실패하므로 **복사로 대체**하고 정직히 보고한다.
- **Process/User/Machine 3-scope 동기화**: `SetEnvironmentVariable(..., 'User')` 직후 현재
  프로세스(`Process` scope)에는 반영되지 않을 수 있다 - 새 pwsh 세션에서 재확인.
- **이미지 붙여넣기**: 터미널에 이미지 붙여넣기는 `Ctrl+V` 가 아니라 **`Alt+V`**.
- **비-Windows 오인 실행**: 이 스킬은 Windows 전용이다 - `$IsWindows` 감지 없이 무작정 진행하지
  않는다.

ARGUMENTS: 없음 (비-Windows 는 자동 감지 후 "Windows 전용 - 해당 없음" no-op 보고)
