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

이 스킬이 내려받는 원천에 10초 안에 닿는지 먼저 본다. 닿지 않으면 그 원천에서 받는 단계는 하지 않고, 이미 설치된 것의 확인만 한 뒤 "오프라인이라 설치하지 않음(필요한 것: <못 깐 것>)" 으로 보고한다.

```bash
(cd ~ && npm ping --fetch-retries=0 --fetch-timeout=10000)                    # omc update, npm 전역 설치
curl -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://github.com   # OMC 마켓플레이스
```

- `npm ping` 은 홈 폴더에서 부른다. 지금 폴더에 있는 프로젝트의 `.npmrc` 가 정한 레지스트리와 토큰을 따르지 않게 하려는 것이다.
- `npm ping` 이 실패하면 ping 에 답하지 않는 사내 미러일 수 있다. `(cd ~ && T=$(mktemp -d) && { npm view oh-my-claude-sisyphus version --fetch-retries=0 --fetch-timeout=10000 --cache "$T"; r=$?; rm -rf "$T"; exit $r; })` 도 실패해야 오프라인으로 본다. 이 스킬이 설치할 패키지(`oh-my-claude-sisyphus`)를 빈 캐시로 물으므로 옛 값이 나올 수 없다.
- `npm` 이 없으면(명령 없음) 오프라인이 아니라 확인하지 못한 것이다. Node 를 먼저 갖춘다(`setup-node`).
- `npm ping` 은 npm 의 프록시 설정(`proxy`, `https-proxy`)을 따른다. 사내 미러만 열린 망이면 그 미러가 쓰이는지 npm 설정을 본다.
- `curl -sSI` 는 머리만 받는다(본문을 받지 않음). 닿지 못하면 종료 코드가 0 이 아니다(HTTP 상태와 관계없음). `curl` 은 `HTTPS_PROXY` 를 따른다.
- Windows PowerShell 에서는 같은 주소를 `curl.exe -sSI -o NUL --connect-timeout 5 --max-time 10 <주소>` 로 보고 `$LASTEXITCODE` 가 0 인지 본다(PowerShell 5.1 의 `curl` 은 `Invoke-WebRequest` 별칭이다). `curl.exe` 는 Windows 시스템 프록시를 따르지 않고 `HTTPS_PROXY` 만 따른다. `npm ping` 은 `Push-Location ~; npm ping --fetch-retries=0 --fetch-timeout=10000; Pop-Location` 처럼 홈에서 부르고 돌아온다(돌아오지 않으면 뒤 단계가 프로젝트가 아니라 홈에서 돈다).
- 사내 미러만 열린 망이면 확인 주소를 그 미러로 바꿔 본다.

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
