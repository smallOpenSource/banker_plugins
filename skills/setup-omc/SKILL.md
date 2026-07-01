---
name: setup-omc
description: "all-in-one·ultra-init·front-qa 가 의존하는 oh-my-claudecode(OMC)를 설치/갱신. Codex는 oh-my-codex(OMX). 'setup-omc'/'OMC 설치'/'oh-my-claudecode 설치' 또는 /banker:setup 시 사용."
---

# setup-omc: oh-my-claudecode(OMC) 설치/갱신

banker의 오케스트레이터(`all-in-one`·`ultra-init`)와 `/banker:front-qa` 커맨드는 OMC의
`ralplan`·`ralph`·`ultraqa` 등에 의존한다. 이 스킬은 OMC를 설치하거나 최신화한다(이미 있으면 갱신만; 멱등). 답변은 한글.

## 0. 감지 (먼저, 추정 금지)
```bash
command -v omc >/dev/null && omc --version || echo "omc: 미설치"
command -v claude >/dev/null || echo "claude: 미설치"
```

## Claude Code · OMC
- **이미 설치(`omc` 존재)** 면 최신화만 한다:
  ```bash
  omc update      # 플러그인·npm 패키지·CLAUDE.md 동기화
  ```
- **미설치** 면 공식 배포처 절차를 따른다(일반적으로 npm 전역 설치 후 `omc setup`). 정확한 설치 명령이 불명확하면 추정하지 말고 사용자에게 확인한다.
- 확인: `omc --version` + Claude 재시작·`/reload-plugins` 후 `/oh-my-claudecode:*` 노출.

## Codex CLI · OMX (oh-my-codex)
Codex에서의 대응 프레임워크는 OMX다.
```bash
command -v omx >/dev/null && omx setup      # 유저/프로젝트 레벨 OMX 구성(멱등)
```
- 미설치면 OMX 배포처 안내대로 설치 후 `omx setup`.

## 검증·보고
- OMC: `omc --version` / OMX: `omx --version`. 반영엔 재시작·`/reload-plugins`(Claude)가 필요할 수 있다.
- 실패·불명확은 정직 보고(가짜 성공 금지).

## 함정
- OMC/OMX는 banker와 별개 프로젝트다. banker가 대신 버전을 고정하지 않고 공식 경로만 쓴다.
- 설치 직후 미반영은 정상(재시작·reload 후 반영).
