---
name: setup-insane-search
description: >
  insane-search(차단/봇방어 사이트 우회 검색·페치 플러그인)를 별도 마켓플레이스
  (github.com/fivetaku/gptaku_plugins)에서 설치한다. ★/banker:setup 가 호출하거나
  사용자가 "insane-search 설치"/"setup-insane-search" 를 명시할 때만 사용. OS 무관.
---

# setup-insane-search — insane-search 플러그인 설치

차단 사이트 우회(WAF/봇방어, X·Reddit·YouTube·GitHub 등) 검색·페치를 제공하는 `insane-search` 를
`fivetaku/gptaku_plugins` 마켓플레이스에서 설치한다. OS 무관(Claude Code 플러그인). 답변은 한글.

## 설치 — Claude Code 세션 안 (슬래시 커맨드)
```
/plugin marketplace add https://github.com/fivetaku/gptaku_plugins.git
/plugin install insane-search@gptaku-plugins
/reload-plugins
```

## 또는 CLI (비대화형)
```bash
claude plugin marketplace add https://github.com/fivetaku/gptaku_plugins.git
claude plugin install insane-search@gptaku-plugins
# 적용엔 /reload-plugins 또는 재시작 필요
```

## 검증·보고
- `claude plugin list` 에 `insane-search` 가 보이는지.
- **반영엔 `/reload-plugins` 또는 재시작 필요**(설치 직후 미반영은 정상).
- 이미 설치돼 있으면 skip.

## 함정
- 마켓플레이스명은 추가 후 `claude plugin marketplace list` 로 확인(`gptaku-plugins`). 설치는 `<plugin>@<marketplace>` 형식.
- 깃/네트워크 접근 필요(사설망이면 프록시 확인).
