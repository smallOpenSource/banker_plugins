---
name: setup-omc
description: "`all-in-one`, `ultra-init`, `front-qa` 가 의존하는 oh-my-claudecode(OMC)를 설치하거나 갱신. Codex 에서는 oh-my-codex(OMX)가 대상. 'setup-omc'/'OMC 설치'/'oh-my-claudecode 설치' 또는 `/banker:setup` 시 사용."
---

# setup-omc: oh-my-claudecode(OMC) 설치/갱신

banker의 오케스트레이터(`all-in-one`·`ultra-init`)와 `/banker:front-qa` 커맨드는 OMC의
`ralplan`·`ralph`·`verify` 와 `omc` CLI(`omc ralph verify`)에 의존한다. OMC 5부터 `ralph` 가 첫 반복에 `omc ralph verify` 를 직접 부르므로, 플러그인만 새것이고 전역 `omc` CLI 가 낡으면(4.x) `ralph` 가 시작하자마자 멈춘다. 이 스킬은 OMC를 설치하거나 최신화한다(이미 있으면 갱신만; 멱등). 답변은 한글.

## 0. 감지 (먼저, 추정 금지)
```bash
command -v omc >/dev/null && omc --version || echo "omc: 미설치"
omc ralph verify --help 2>&1 | grep -q 'Usage: omc ralph verify' && echo "omc CLI: ralph verify 있음" || echo "omc CLI: ralph verify 없음 (미설치 또는 4.x)"
command -v claude >/dev/null || echo "claude: 미설치"
```
- `ralph verify` 는 종료 코드가 아니라 **출력 문구로 판정**한다. 4.x CLI 는 모르는 명령에 `--help` 를 붙이면 전체 도움말을 찍고 0 으로 끝난다. `--help` 없이 부르면 Claude 실행으로 넘어가므로 점검에는 반드시 붙인다.

### 네트워크 확인 (내려받기 전)

이 스킬이 내려받는 원천에 닿는지 먼저 본다(curl 은 10초, npm 은 15초 안). 닿지 않으면 그 원천에서 받는 단계는 하지 않고, 이미 설치된 것의 확인만 한 뒤 "오프라인이라 설치하지 않음(필요한 것: <못 깐 것>)" 으로 보고한다.

```bash
[ "${CODEX_SANDBOX_NETWORK_DISABLED:-}" = 1 ] && echo "Codex sandbox 가 네트워크를 막음(아래 실패는 오프라인이 아님)"
in15() { "$@" & p=$!; ( sleep 15 && kill "$p" ) > /dev/null 2>&1 & k=$!; wait "$p" 2>/dev/null; r=$?; kill "$k" 2>/dev/null; wait "$k" 2>/dev/null; [ "$r" = 143 ] && echo "15초 안에 끝나지 않아 멈춤(패킷을 버리는 망일 수 있음)"; return "$r"; }
in15 sh -c 'cd ~ && exec npm ping --fetch-retries=0 --fetch-timeout=10000 --no-update-notifier'                    # omc update, npm 전역 설치
curl --ssl-no-revoke -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://github.com   # OMC 마켓플레이스
```

- `npm ping` 은 홈 폴더에서 부른다. 지금 폴더에 있는 프로젝트의 `.npmrc` 가 정한 레지스트리와 토큰을 따르지 않게 하려는 것이다.
- `npm ping` 은 15초 감시(`in15`) 안에서 부른다. 패킷을 버리는 망에서 npm 은 연결에 시간 제한을 두지 않아(`--fetch-timeout` 은 받는 중의 쉼만 잰다) OS 의 연결 재시도가 끝날 때까지 기다린다(Rocky 8.10 실측 130초). 15초 안에 끝나지 않으면 `15초 안에 끝나지 않아 멈춤(패킷을 버리는 망일 수 있음)` 과 종료 143 이다. `--no-update-notifier` 는 npm 이 제 판을 묻는 요청을 하나 더 내지 않게 한다.
- `npm ping` 이 실패하면 ping 에 답하지 않는 사내 미러일 수 있다. `(cd ~ && T=$(mktemp -d) && { npm view oh-my-claude-sisyphus version --fetch-retries=0 --fetch-timeout=10000 --cache "$T" --no-update-notifier; r=$?; rm -rf "$T"; exit $r; })` 도 실패해야 오프라인으로 본다. 이 스킬이 설치할 패키지(`oh-my-claude-sisyphus`)를 빈 캐시로 물으므로 옛 값이 나올 수 없다. ping 이 15초 감시에 걸려 멈췄으면(종료 143) 이 확인은 하지 않는다. 같은 레지스트리라 같은 시간을 또 기다린다.
- `npm` 이 없으면(명령 없음) 오프라인이 아니라 확인하지 못한 것이다. Node 를 먼저 갖춘다(`setup-node`).
- `npm ping` 은 npm 의 프록시 설정(`proxy`, `https-proxy`)을 따른다. 사내 미러만 열린 망이면 그 미러가 쓰이는지 npm 설정을 본다.
- `curl -sSI` 는 머리만 받는다(본문을 받지 않음). 닿지 못하면 종료 코드가 0 이 아니다(HTTP 상태와 관계없음). `curl` 은 `HTTPS_PROXY` 를 따른다. 확인 줄은 `--ssl-no-revoke` 를 준다. Windows 의 Git Bash curl 도 Schannel 이라, 폐지 목록 서버에 닿지 못하는 망에서 폐지 확인이 실패하면 종료 60 이다(Windows 박스 실측). 다른 curl 은 이 깃발을 받고 무시한다(macOS curl 8.7.1, Rocky 8.10 curl 7.61.1 실측).
- Windows PowerShell 에서는 같은 주소를 `curl.exe --ssl-no-revoke -sSI -o NUL --connect-timeout 5 --max-time 10 <주소>` 로 보고 `$LASTEXITCODE` 가 0 인지 본다(PowerShell 5.1 의 `curl` 은 `Invoke-WebRequest` 별칭이다). `curl.exe` 는 Windows 시스템 프록시를 따르지 않고 `HTTPS_PROXY` 만 따른다. `--ssl-no-revoke` 는 폐지 목록 서버에 닿지 못하는 망에서 Schannel 의 폐지 확인 실패를 오프라인으로 읽지 않게 한다. 닿는지만 보고 받은 내용은 쓰지 않으므로 이 확인에만 준다. `curl.exe` 가 없으면 `$LASTEXITCODE` 에 앞 명령의 값이 남으므로 `Get-Command curl.exe -ErrorAction SilentlyContinue` 로 먼저 보고, 없으면 확인하지 못한 것으로 적는다. `npm ping` 은 `Push-Location ~; npm ping --fetch-retries=0 --fetch-timeout=10000 --no-update-notifier; Pop-Location` 처럼 홈에서 부르고 돌아온다(돌아오지 않으면 뒤 단계가 프로젝트가 아니라 홈에서 돈다). PowerShell 에는 15초 감시를 두지 않는다(Windows 의 연결 시간 제한은 약 21초로 알려져 있다. 미실측).
- 사내 미러만 열린 망이면 확인 주소를 그 미러로 바꿔 본다.
- Codex sandbox 가 네트워크를 막는 모드(기본 `workspace-write`, `read-only`)에서는 `CODEX_SANDBOX_NETWORK_DISABLED=1` 이 서고 확인이 모두 실패한다(curl 종료 7, npm `EPERM`). 블록의 첫 줄이 그렇다고 알린다. 그때는 '오프라인' 이 아니라 'sandbox 가 네트워크를 막음' 으로 보고하고, 승인을 받아 sandbox 밖에서 확인부터 다시 한다. Claude Code sandbox 안(`SANDBOX_RUNTIME=1`)에서는 허용 목록 밖 주소를 sandbox 프록시가 막는다. Windows PowerShell 에서는 `$env:CODEX_SANDBOX_NETWORK_DISABLED -eq '1'` 로 본다.
- 확인이 실패하면 보고에 그 명령, 종료 코드, stderr 첫 줄을 붙인다(예: `npm error code ETIMEDOUT`, `curl: (28) ...`). 원인을 '오프라인' 하나로 짐작하지 않는다.
- curl 의 종료 60(인증서 검증 실패)도 오프라인이 아니다. 망은 열려 있고, TLS 를 가로채는 사내 프록시의 인증서를 OS 가 믿지 않는 것이다. '인증서 문제로 설치하지 않음' 으로 보고한다.
- curl 은 닿는데 npm 만 인증서 오류(`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`)로 실패하면 망은 열려 있고 npm 이 사내 인증서를 믿지 않는 것이다(npm 은 OS 인증서 저장소를 쓰지 않는다). '인증서 문제로 설치하지 않음' 으로 보고하고 `NODE_EXTRA_CA_CERTS=<사내 CA 파일>` 을 안내한다. Node 24 는 `NODE_OPTIONS=--use-system-ca` 도 된다.

## Claude Code · OMC
- **이미 설치(`omc` 존재)** 면 최신화만 한다:
  ```bash
  omc update      # 플러그인·npm 패키지·CLAUDE.md 동기화
  ```
- `omc update` 가 중간에 실패하거나 끝난 뒤에도 `ralph verify` 가 없으면, CLI 만 직접 올린다:
  ```bash
  npm install -g oh-my-claude-sisyphus@latest
  ```
  - 네이티브 모듈(`better-sqlite3`) 빌드가 낡은 기본 컴파일러 때문에 실패하는 배포판(예: RHEL·Rocky 8)은 새 gcc 를 켠 셸에서 같은 명령을 실행한다(예: `source /opt/rh/gcc-toolset-14/enable`).
- **미설치** 면 공식 배포처 절차를 따른다(일반적으로 npm 전역 설치 후 `omc setup`). 정확한 설치 명령이 불명확하면 추정하지 말고 사용자에게 확인한다.
- 확인: `omc --version`, 위 `ralph verify` 점검 통과, Claude 재시작·`/reload-plugins` 후 `/oh-my-claudecode:*` 노출.

## Codex CLI · OMX (oh-my-codex)
Codex에서의 대응 프레임워크는 OMX다.
```bash
command -v omx >/dev/null && omx setup      # 유저/프로젝트 레벨 OMX 구성(멱등)
```
- 미설치면 OMX 배포처 안내대로 설치 후 `omx setup`.

## 검증·보고
- OMC: `omc --version` + `ralph verify` 점검 / OMX: `omx --version`. 반영엔 재시작·`/reload-plugins`(Claude)가 필요할 수 있다.
- 실패·불명확은 정직 보고(가짜 성공 금지).

## 함정
- OMC/OMX는 banker와 별개 프로젝트다. banker가 대신 버전을 고정하지 않고 공식 경로만 쓴다.
- 설치 직후 미반영은 정상(재시작·reload 후 반영).
