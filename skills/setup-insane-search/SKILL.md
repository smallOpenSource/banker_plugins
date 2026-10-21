---
name: setup-insane-search
description: "차단이나 봇 방어가 있는 사이트도 우회해 검색하고 가져오는 플러그인을 설치. Claude Code 는 `gptaku-plugins` 의 `insane-search`, Codex 는 `gptaku-codex` 의 `insane-research-codex`. 'setup-insane-search'/'insane-search 설치' 또는 `/banker:setup` 시 사용."
---

# setup-insane-search: insane-search 플러그인 설치

차단 사이트 우회(WAF·봇방어; X·Reddit·YouTube·GitHub 등) 검색·페치를 제공하는 `insane-search` 플러그인을
설치한다. 현재 도구(Claude Code / Codex)를 감지해 알맞은 경로로 진행하고, 이미 설치돼 있으면 skip(멱등). 답변은 한글.

## 0. 네트워크 확인 (내려받기 전)

이 스킬이 내려받는 원천에 10초 안에 닿는지 먼저 본다. 닿지 않으면 그 원천에서 받는 단계는 하지 않고, 이미 설치된 것의 확인만 한 뒤 "오프라인이라 설치하지 않음(필요한 것: <못 깐 것>)" 으로 보고한다.

```bash
[ "${CODEX_SANDBOX_NETWORK_DISABLED:-}" = 1 ] && echo "Codex sandbox 가 네트워크를 막음(아래 실패는 오프라인이 아님)"
curl --ssl-no-revoke -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://github.com   # 마켓플레이스(GitHub)
```

- `curl -sSI` 는 머리만 받는다(본문을 받지 않음). 닿지 못하면 종료 코드가 0 이 아니다(HTTP 상태와 관계없음). `curl` 은 `HTTPS_PROXY` 를 따른다. 확인 줄은 `--ssl-no-revoke` 를 준다. Windows 의 Git Bash curl 도 Schannel 이라, 폐지 목록 서버에 닿지 못하는 망에서 폐지 확인이 실패하면 종료 60 이다(Windows 박스 실측). 다른 curl 은 이 깃발을 받고 무시한다(macOS curl 8.7.1, Rocky 8.10 curl 7.61.1 실측).
- Windows PowerShell 에서는 같은 주소를 `curl.exe --ssl-no-revoke -sSI -o NUL --connect-timeout 5 --max-time 10 <주소>` 로 보고 `$LASTEXITCODE` 가 0 인지 본다(PowerShell 5.1 의 `curl` 은 `Invoke-WebRequest` 별칭이다). `curl.exe` 는 Windows 시스템 프록시를 따르지 않고 `HTTPS_PROXY` 만 따른다. `--ssl-no-revoke` 는 폐지 목록 서버에 닿지 못하는 망에서 Schannel 의 폐지 확인 실패를 오프라인으로 읽지 않게 한다. 닿는지만 보고 받은 내용은 쓰지 않으므로 이 확인에만 준다. `curl.exe` 가 없으면 `$LASTEXITCODE` 에 앞 명령의 값이 남으므로 `Get-Command curl.exe -ErrorAction SilentlyContinue` 로 먼저 보고, 없으면 확인하지 못한 것으로 적는다.
- 사내 미러만 열린 망이면 확인 주소를 그 미러로 바꿔 본다.
- Codex sandbox 가 네트워크를 막는 모드(기본 `workspace-write`, `read-only`)에서는 `CODEX_SANDBOX_NETWORK_DISABLED=1` 이 서고 확인이 모두 실패한다(curl 종료 7, npm `EPERM`). 블록의 첫 줄이 그렇다고 알린다. 그때는 '오프라인' 이 아니라 'sandbox 가 네트워크를 막음' 으로 보고하고, 승인을 받아 sandbox 밖에서 확인부터 다시 한다. Claude Code sandbox 안(`SANDBOX_RUNTIME=1`)에서는 허용 목록 밖 주소를 sandbox 프록시가 막는다. Windows PowerShell 에서는 `$env:CODEX_SANDBOX_NETWORK_DISABLED -eq '1'` 로 본다.
- 확인이 실패하면 보고에 그 명령, 종료 코드, stderr 첫 줄을 붙인다(예: `npm error code ETIMEDOUT`, `curl: (28) ...`). 원인을 '오프라인' 하나로 짐작하지 않는다.
- curl 의 종료 60(인증서 검증 실패)도 오프라인이 아니다. 망은 열려 있고, TLS 를 가로채는 사내 프록시의 인증서를 OS 가 믿지 않는 것이다. '인증서 문제로 설치하지 않음' 으로 보고한다.

## Claude Code · 세션 안 (슬래시 커맨드)
```
/plugin marketplace add https://github.com/fivetaku/gptaku_plugins.git
/plugin install insane-search@gptaku-plugins
/reload-plugins
```
CLI(비대화형):
```bash
claude plugin marketplace add https://github.com/fivetaku/gptaku_plugins.git
claude plugin install insane-search@gptaku-plugins
# 반영엔 /reload-plugins 또는 재시작 필요
```

## Codex CLI
Codex는 마켓플레이스명(`gptaku-codex`)과 플러그인명(`insane-research-codex`)이 Claude와 다르다.
```bash
codex plugin marketplace list            # gptaku-codex 가 이미 있으면 다음 add 는 skip
codex plugin marketplace add https://github.com/fivetaku/insane-search.git
codex plugin add insane-research-codex@gptaku-codex
codex plugin list                        # STATUS=installed 확인
```
- `gptaku-codex` 마켓플레이스가 `marketplace list` 에 없을 때만 add 한다.
- add 후 등록된 마켓플레이스명을 `marketplace list` 로 확인한다. 이름이 `gptaku-codex` 가 아니면 `codex plugin add insane-research-codex@<실제이름>` 으로 맞춘다.

## 검증·보고
- Claude: `claude plugin list` 에 `insane-search` 표시(반영엔 `/reload-plugins`·재시작).
- Codex: `codex plugin list` 에서 `insane-research-codex` 가 `STATUS=installed`.
- 이미 설치면 skip. 실패는 정직 보고(가짜 성공 금지).

## 함정
- 도구별 이름이 다르다: Claude=`insane-search@gptaku-plugins`, Codex=`insane-research-codex@gptaku-codex`.
- 설치는 `<plugin>@<marketplace>` 형식. 마켓플레이스명은 add 후 `marketplace list` 로 확인.
- 깃·네트워크 접근 필요(사설망이면 프록시 확인).
