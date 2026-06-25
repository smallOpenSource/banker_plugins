---
name: setup-omc-hud
description: >
  omc_hud(Claude Code 상태표시줄 커스터마이저, github.com/smallOpenSource/omc_hud)를
  설치한다. OS(mac/linux/windows)를 감지해 알맞은 apply 스크립트를 내려받아 적용하고
  임시 파일을 정리한다. ★/banker:setup 가 호출하거나 사용자가 "omc_hud 설치"/"setup-omc-hud"
  를 명시할 때만 사용(자동 트리거 아님).
---

# setup-omc-hud — omc_hud 상태표시줄 설치 (OS별)

`smallOpenSource/omc_hud` 의 apply 스크립트를 OS에 맞게 내려받아 적용한다. `wget` 없으면 `curl`로 폴백. 답변은 한글.

## 0. 감지
```bash
case "$(uname -s)" in Darwin) OS=mac;; Linux) OS=linux;; *) OS=windows;; esac; echo "OS=$OS"
command -v wget >/dev/null && echo "dl=wget" || { command -v curl >/dev/null && echo "dl=curl" || echo "dl=none(설치 필요)"; }
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

## 함정
- `curl` 다운로드는 **대문자 `-O`**(원격 파일명 유지). 소문자 `-o`는 출력명 지정이라 다름.
- raw URL 의 `refs/heads/main` 브랜치명이 바뀌면 404 → 저장소 확인.
- `.mjs` 적용은 Node 필요(`node -v`).
