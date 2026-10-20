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

이 스킬이 내려받는 원천에 10초 안에 닿는지 먼저 본다. 닿지 않으면 그 원천에서 받는 단계는 하지 않고, 이미 설치된 것의 확인만 한 뒤 "오프라인이라 설치하지 않음(필요한 것: <못 깐 것>)" 으로 보고한다.

```bash
npm ping --fetch-retries=0 --fetch-timeout=10000   # npx 프록시
```

- Windows PowerShell 에서는 같은 주소를 `curl.exe -sS -o NUL --connect-timeout 5 --max-time 10 <주소>` 로 보고 `$LASTEXITCODE` 가 0 인지 본다(PowerShell 5.1 의 `curl` 은 `Invoke-WebRequest` 별칭이다). `npm ping` 은 그대로 쓴다.
- `npm ping` 과 `curl` 은 각자의 프록시 설정(npm 설정, `HTTPS_PROXY`)을 따른다. 사내 미러만 열린 망이면 그 미러 주소로 본다.
- Stitch 는 원격 서비스라 네트워크가 없으면 쓸 수 없다. 확인이 실패하면 등록하지 않고 "오프라인이라 설치하지 않음(필요한 것: 네트워크, Stitch 서비스)" 으로 보고한다.

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
