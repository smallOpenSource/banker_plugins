---
name: setup-stitch-proxy
description: >
  Stitch(Google 디자인 생성)용 MCP 프록시를 Claude Code 에 등록한다. API key 발급 →
  실행 스크립트 작성 → claude mcp add 로 연결. ★/banker:setup 가 호출하거나 사용자가
  "stitch 설치"/"setup-stitch-proxy" 를 명시할 때만 사용. API key 필요(시크릿 미커밋).
---

# setup-stitch-proxy — Stitch MCP 프록시 등록

Stitch(withgoogle) 디자인 생성 MCP 를 프록시로 Claude Code 에 붙인다. Node(npx) 필요.
**★시크릿(API key)은 사용자만 입력·환경변수로 — 채팅/로그/커밋에 절대 노출 금지.** 답변은 한글.

## 0. 사전
- Node/npx 설치 확인(`node -v`).
- API key 발급: https://stitch.withgoogle.com/settings (사용자가 직접).

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
