---
name: setup-stitch
description: "Google 의 디자인 생성 서비스인 Stitch 의 MCP 프록시를 `claude mcp add`(Codex 는 `codex mcp add`)로 등록. 시크릿은 커밋하지 않음. 'setup-stitch'/'stitch 설치'/'stitch mcp' 또는 `/banker:setup` 시 사용."
---

# setup-stitch — Stitch MCP 프록시 등록

Stitch(withgoogle) 디자인 생성 MCP 를 프록시로 Claude Code 에 붙인다. Node(npx) 필요.
**★시크릿(API key)은 사용자만 입력·환경변수로 — 채팅/로그/커밋에 절대 노출 금지.** 답변은 한글.

## 0. 사전
- Node/npx 설치 확인(`node -v`).
- API key 발급: https://stitch.withgoogle.com/settings (사용자가 직접).

### 네트워크 확인 (내려받기 전)

이 스킬이 내려받는 원천에 닿는지 먼저 본다(curl 은 10초, npm 은 15초 안). 닿지 않으면 그 원천에서 받는 단계는 하지 않고, 이미 설치된 것의 확인만 한 뒤 "오프라인이라 설치하지 않음(필요한 것: <못 깐 것>)" 으로 보고한다.

```bash
[ "${CODEX_SANDBOX_NETWORK_DISABLED:-}" = 1 ] && echo "Codex sandbox 가 네트워크를 막음(아래 실패는 오프라인이 아님)"
in15() { "$@" & p=$!; ( sleep 15 && kill "$p" ) 2>/dev/null & k=$!; wait "$p" 2>/dev/null; r=$?; kill "$k" 2>/dev/null; wait "$k" 2>/dev/null; [ "$r" = 143 ] && echo "15초 안에 끝나지 않아 멈춤(패킷을 버리는 망일 수 있음)"; return "$r"; }
in15 sh -c 'cd ~ && exec npm ping --fetch-retries=0 --fetch-timeout=10000 --no-update-notifier'   # npx 프록시
```

- `npm ping` 은 홈 폴더에서 부른다. 지금 폴더에 있는 프로젝트의 `.npmrc` 가 정한 레지스트리와 토큰을 따르지 않게 하려는 것이다.
- `npm ping` 은 15초 감시(`in15`) 안에서 부른다. 패킷을 버리는 망에서 npm 은 연결에 시간 제한을 두지 않아(`--fetch-timeout` 은 받는 중의 쉼만 잰다) OS 의 연결 재시도가 끝날 때까지 기다린다(Rocky 8.10 실측 130초). 15초 안에 끝나지 않으면 `15초 안에 끝나지 않아 멈춤(패킷을 버리는 망일 수 있음)` 과 종료 143 이다. `--no-update-notifier` 는 npm 이 제 판을 묻는 요청을 하나 더 내지 않게 한다.
- `npm ping` 이 실패하면 ping 에 답하지 않는 사내 미러일 수 있다. `(cd ~ && T=$(mktemp -d) && { npm view @_davideast/stitch-mcp version --fetch-retries=0 --fetch-timeout=10000 --cache "$T" --no-update-notifier; r=$?; rm -rf "$T"; exit $r; })` 도 실패해야 오프라인으로 본다. 이 스킬이 설치할 패키지(`@_davideast/stitch-mcp`)를 빈 캐시로 물으므로 옛 값이 나올 수 없다. ping 이 15초 감시에 걸려 멈췄으면(종료 143) 이 확인은 하지 않는다. 같은 레지스트리라 같은 시간을 또 기다린다.
- `npm` 이 없으면(명령 없음) 오프라인이 아니라 확인하지 못한 것이다. Node 를 먼저 갖춘다(`setup-node`).
- `npm ping` 은 npm 의 프록시 설정(`proxy`, `https-proxy`)을 따른다. 사내 미러만 열린 망이면 그 미러가 쓰이는지 npm 설정을 본다.
- Windows PowerShell 에서는 `npm ping` 은 `Push-Location ~; npm ping --fetch-retries=0 --fetch-timeout=10000 --no-update-notifier; Pop-Location` 처럼 홈에서 부르고 돌아온다(돌아오지 않으면 뒤 단계가 프로젝트가 아니라 홈에서 돈다). PowerShell 에는 15초 감시를 두지 않는다(Windows 의 연결 시간 제한은 약 21초로 알려져 있다. 미실측).
- 사내 미러만 열린 망이면 확인 주소를 그 미러로 바꿔 본다.
- Stitch 는 원격 서비스라 네트워크가 없으면 쓸 수 없다. 확인이 실패하면 등록하지 않고 "오프라인이라 설치하지 않음(필요한 것: 네트워크, Stitch 서비스)" 으로 보고한다.
- Codex sandbox 가 네트워크를 막는 모드(기본 `workspace-write`, `read-only`)에서는 `CODEX_SANDBOX_NETWORK_DISABLED=1` 이 서고 확인이 모두 실패한다(curl 종료 7, npm `EPERM`). 블록의 첫 줄이 그렇다고 알린다. 그때는 '오프라인' 이 아니라 'sandbox 가 네트워크를 막음' 으로 보고하고, 승인을 받아 sandbox 밖에서 확인부터 다시 한다. Claude Code sandbox 안(`SANDBOX_RUNTIME=1`)에서는 허용 목록 밖 주소를 sandbox 프록시가 막는다. Windows PowerShell 에서는 `$env:CODEX_SANDBOX_NETWORK_DISABLED -eq '1'` 로 본다.
- 확인이 실패하면 보고에 그 명령, 종료 코드, stderr 첫 줄을 붙인다(예: `npm error code ETIMEDOUT`, `curl: (28) ...`). 원인을 '오프라인' 하나로 짐작하지 않는다.
- curl 은 닿는데 npm 만 인증서 오류(`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`)로 실패하면 망은 열려 있고 npm 이 사내 인증서를 믿지 않는 것이다(npm 은 OS 인증서 저장소를 쓰지 않는다). '인증서 문제로 설치하지 않음' 으로 보고하고 `NODE_EXTRA_CA_CERTS=<사내 CA 파일>` 을 안내한다. Node 24 는 `NODE_OPTIONS=--use-system-ca` 도 된다.

## 1. mac / linux — 프록시 스크립트 + MCP 등록
> key 는 채팅/기록에 남기지 말고, 사용자가 **자기 터미널**에서 `YOUR_STITCH_API_KEY` 를 실제 키로 교체.
```bash
mkdir -p ~/bin
cat > ~/bin/stitch-proxy.sh <<'EOF'
#!/bin/bash
export STITCH_API_KEY="YOUR_STITCH_API_KEY"   # ← 발급 키로 교체 (이 파일 커밋 금지)
exec npx -y @_davideast/stitch-mcp proxy
EOF
chmod +x ~/bin/stitch-proxy.sh

claude mcp remove stitch 2>/dev/null            # 기존 있으면 제거
claude mcp add stitch -- ~/bin/stitch-proxy.sh
claude mcp list                                  # stitch: … - ✔ Connected 기대
```
키를 평문 파일에 두기 싫으면 `STITCH_API_KEY` 를 `~/.bashrc`(비커밋) 등에 export 하고 스크립트는 참조만.

**Codex CLI:** 같은 프록시 스크립트를 Codex에도 붙인다 — `claude mcp` 대신 `codex mcp` 를 쓴다.
```bash
codex mcp remove stitch 2>/dev/null
codex mcp add stitch -- ~/bin/stitch-proxy.sh
codex mcp list                                   # stitch 연결 확인
```

## 2. windows
`~/bin` 셸 스크립트 대신 **WSL2** 권장(위 절차 그대로). native 면 `.cmd` 래퍼에 `set STITCH_API_KEY=…` 후
`npx -y @_davideast/stitch-mcp proxy` 실행, `claude mcp add stitch -- cmd /c <래퍼>.cmd`.

## 3. 검증·보고
- `claude mcp list` 에서 `stitch` 가 **✔ Connected**.
- 미연결: key 오타 / npx 네트워크 / Node 부재 점검. MCP 반영엔 세션 갱신 필요할 수 있음.

## 함정
- **시크릿**: API key 를 리포트·로그·커밋에 노출 금지. 스크립트는 `~/bin`(repo 밖).
- npx 첫 실행은 패키지 다운로드로 지연 가능.
- `YOUR_STITCH_API_KEY` 미교체면 연결 실패 → 교체 확인.
