---
name: setup-omc-hud
description: "(banker) omc_hud(Claude Code 상태표시줄)를 OS별 apply 스크립트로 적용(Codex는 OMX hud). 'setup-omc-hud'/'omc_hud 설치' 또는 /banker:setup 시 사용."
---

# setup-omc-hud — omc_hud 상태표시줄 설치 (OS별)

`smallOpenSource/omc_hud` 의 apply 스크립트를 OS에 맞게 내려받아 적용한다. `wget` 없으면 `curl`로 폴백. 답변은 한글.

**런타임:** omc_hud 는 Claude Code 상태표시줄(`~/.claude/settings.json` statusLine) 대상이다. **Codex 런타임에선 oh-my-codex(OMX)가 자체 `hud` 스킬/구성을 제공**하므로, Codex에선 이 스킬 대신 OMX 의 `hud` 를 사용한다.

## 0. 감지
```bash
case "$(uname -s)" in Darwin) OS=mac;; Linux) OS=linux;; *) OS=windows;; esac; echo "OS=$OS"
command -v wget >/dev/null && echo "dl=wget" || { command -v curl >/dev/null && echo "dl=curl" || echo "dl=none(설치 필요)"; }
# 적용 스크립트가 래퍼를 덮어쓰면 payload-mon 표시 블록이 빠진다. 지금 켜져 있는지 기억해 둔다(3단계에서 사용).
HUD_FILE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hud/omc-hud-custom.mjs"
grep -qF '// >>> payload-mon >>>' "$HUD_FILE" 2>/dev/null && echo "payload-mon=on" || echo "payload-mon=off"
```
Windows(PowerShell)에서는 같은 확인을 이렇게 한다:
```powershell
$cfg = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { "$env:USERPROFILE\.claude" }
if (Select-String -Quiet -SimpleMatch -LiteralPath "$cfg\hud\omc-hud-custom.mjs" -Pattern '// >>> payload-mon >>>' -ErrorAction SilentlyContinue) { "payload-mon=on" } else { "payload-mon=off" }
```

## 1. mac / linux — apply 스크립트 적용
```bash
RAW=https://raw.githubusercontent.com/smallOpenSource/omc_hud/refs/heads/main
mkdir -p ~/dummy && cd ~/dummy
script=$([ "$OS" = mac ] && echo apply-hud-macos.sh || echo apply-hud-linux.sh)
for f in "$script" apply-hud.mjs hud-config.json omc-hud-custom.mjs; do
  if command -v wget >/dev/null; then wget -q "$RAW/$f"; else curl -fsSLO "$RAW/$f"; fi
done
chmod +x "$script" && "./$script"
rm -f "$script" apply-hud.mjs hud-config.json omc-hud-custom.mjs   # 정리
cd - >/dev/null
```

## 2. windows
`wget`이 없는 경우가 많아 **프로젝트 통째로 받아 적용**한다:
```powershell
# git 있으면
git clone https://github.com/smallOpenSource/omc_hud.git "$env:TEMP\omc_hud"; cd "$env:TEMP\omc_hud"
# 저장소의 windows 적용 스크립트(apply-hud-*.ps1/.cmd) 또는 `node apply-hud.mjs` 안내를 따른다.
```
git 없으면 GitHub "Download ZIP" → 해제 → 동봉 적용 스크립트 실행.

## 3. 검증·보고
- 적용 스크립트가 `~/.claude/settings.json` 의 statusLine 등을 갱신했는지(스크립트 출력 확인).
- HUD는 **다음 프롬프트/세션**부터 반영될 수 있음 → 안 보이면 재시작 안내.
- `~/dummy` 임시파일 정리 확인. 이미 적용돼 있으면 재적용 불필요.
- **payload-mon 복구**: 0단계에서 `payload-mon=on` 이었다면, 적용 스크립트가 래퍼를 덮어써 payload 표시 블록이 빠진 상태다.
  payload-mon 스킬(Claude Code `/banker:payload-mon`, Codex `banker-payload-mon`)을 `on` 으로 실행해 다시 켜고, 그 결과를 함께 보고한다.
  `payload-mon=off` 였다면 아무것도 하지 않는다(사용자가 켠 적 없는 기능을 켜지 않는다).

## 함정
- `curl` 다운로드는 **대문자 `-O`**(원격 파일명 유지). 소문자 `-o`는 출력명 지정이라 다름.
- raw URL 의 `refs/heads/main` 브랜치명이 바뀌면 404 → 저장소 확인.
- `.mjs` 적용은 Node 필요(`node -v`).
