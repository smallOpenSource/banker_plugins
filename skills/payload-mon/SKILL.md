---
name: payload-mon
description: "OMC HUD 상태표시줄의 `ctx` 옆에, 현재 세션이 보내는 API 요청의 페이로드 추정치를 32MB 한도 대비로 표시하는 기능을 켜고 끔. 8MB 부터 표시. 'payload-mon'/'payload 모니터 켜/꺼'/'상태표시줄 payload 표시'/'요청 크기 경고'/'32MB 한도 경고'/'payload 표시가 안 보여' 시 사용."
argument-hint: "on | off | status"
---

# payload-mon — 상태표시줄 payload 모니터 켜기·끄기

인자: `$ARGUMENTS` (`on`·`off`·`status` 중 하나, 비어 있으면 `status`. Codex 는 사용자 메시지에서 읽는다). 답변은 한글로 짧게.

Claude Code 는 요청 본문이 32MB 를 넘으면 "Request too large (max 32MB)" 로 거절한다.
이 한도는 토큰이 아니라 바이트라서, ctx(컨텍스트 %)가 낮아도 이미지나 큰 도구 결과가 쌓이면 걸린다.
이 스킬은 그 바이트를 추정해 한도의 25%(8MB)부터 ctx 옆에 `payload:28%/9.0MB` 처럼 보여 준다.

## 실행

이 SKILL.md 가 있는 디렉터리의 절대경로로 스크립트를 실행하고, 출력 내용을 짧게 전한다.
Claude Code 는 그 경로를 스킬 맨 위 "Base directory for this skill:" 로 보여 주고, Codex 는 `~/.codex/skills/banker-payload-mon/` 이다(프로젝트 범위 설치면 `./.codex/skills/banker-payload-mon/`).
`~` 는 따옴표 안에서 펼쳐지지 않으니 절대경로를 쓴다.

```bash
node "<이 스킬 디렉터리 절대경로>/scripts/payload-mon.mjs" <on|off|status>
```

- 명령에 넣는 인자는 `on`·`off`·`status` 세 단어 중 정확히 하나뿐이다. 사용자 입력을 그대로 셸에 붙이지 않는다. 그 밖의 값이면 실행하지 말고 사용법을 알린다.
- `on`·`off` 는 사용자가 켜거나 끄라고 했을 때만 실행한다. 상태만 물으면 `status` 로 충분하다.
- HUD 래퍼를 손으로 고치지 않는다. 스크립트가 대상 확인(OMC 커스텀 HUD 인지), 삽입 위치 확인, 쓰기 권한 확인, `node --check` 검증, 수정 전 백업을 한다. 손으로 고치면 이 안전장치를 건너뛴다.
- 종료 코드 0 은 완료, 1 은 아무것도 바꾸지 않았다는 뜻이니 메시지를 그대로 전한다. 2 는 예기치 못한 오류로 중간에 멈춘 것이니 메시지를 전하고 `status` 로 상태를 확인한다.
- 출력이 비어 있으면 스크립트가 실행되지 않은 것이다. 성공으로 보고하지 말고 경로부터 확인한다.

## 런타임

- **Claude Code**: 다음 statusline 갱신부터 반영되며 재시작은 필요 없다.
- **Codex**: Codex 자신의 요청 크기는 재지 않는다. 32MB 한도와 세션 파일 형식은 Claude Code 의 것이기 때문이다.
  Codex 에서 실행해도 같은 머신의 Claude Code HUD 래퍼를 켜고 끄는 것만 하고, `status` 의 "현재 세션" 줄은 Claude Code 세션에서만 나온다.
  사용자가 Codex 쪽 표시를 기대하면 이 점을 먼저 알린다.

## 동작

- `on`: Claude Code 설정 폴더(`$CLAUDE_CONFIG_DIR`, 없으면 `~/.claude`)의 `hud/omc-hud-custom.mjs` 에서, ctx 를 넣는 줄 바로 뒤에 `// >>> payload-mon >>>` 블록 하나를 넣는다.
  블록이 불러오는 추정 모듈은 래퍼 옆 `hud/payload-mon/payload-size.mjs` 에 사본으로 둔다. 플러그인 설치 경로는 버전마다 바뀌어 업데이트 뒤에 사라지기 때문이다.
  이미 켜져 있으면 래퍼를 바꾸지 않고, 모듈 사본이 이 버전과 다를 때만 사본을 맞춘다. 예전 방식(블록 2개)으로 켜져 있었다면 새 방식으로 바꾼다.
  바꾸기 전 내용은 `omc-hud-custom.mjs.payload-mon.bak` 에 남는다.
- `off`: 그 블록만 빼서 래퍼를 켜기 전 상태로 되돌리고, 모듈 사본과 추정치 캐시를 지운다.
- `status`: 켜짐·꺼짐, 모듈 사본이 이 버전과 같은지, statusLine 이 이 래퍼를 쓰는지, 현재 세션의 추정치를 보여 준다.
- 같은 래퍼에 자기 표시 블록을 넣는 다른 도구가 있어도 서로의 블록을 건드리지 않는다.

## 무엇을 어떻게 보여 주는가

- `ctx:21%|payload:28%/9.0MB|se:…`: 32MB 대비 %(ctx 와 같은 색: 70% 미만 초록, 85% 미만 노랑, 그 이상 빨강)와 크기(MB, 청록). 8MB 미만이면 숨긴다.
- 값은 마지막 `/compact` 이후 Claude Code 가 실제로 보내는 메시지의 바이트다. Claude Code 가 32MB 한도를 판정하는 방식과 같고, 무엇을 넣고 뺄지는 Claude Code 2.1.288 의 요청 필터를 따른다.
- 세션 파일 크기가 아니다. 71MB 짜리 세션 파일도 실제 전송분은 0.1MB 일 수 있다. 알려진 오차는 `scripts/payload-size.mjs` 머리 주석에 있다.

## 거부되거나 안 보일 때

- "OMC 커스텀 HUD 래퍼가 아닙니다" 또는 "삽입 위치를 찾지 못했습니다": HUD 래퍼의 모양이 이 스크립트가 아는 것과 다르다. 파일은 그대로다.
  플러그인 파일을 손으로 고치지 말고, banker 를 최신으로 올린 뒤(`update-banker`) 다시 시도한다. 그래도 안 되면 banker 이슈로 알린다.
- "node --check 실패": 블록을 넣은 결과가 문법 검사를 통과하지 못했다(예: 래퍼가 ctx 를 넣는 줄을 비동기가 아닌 함수 안으로 옮김). 파일은 그대로다.
- "래퍼에 쓸 권한이 없습니다", 또는 `status` 의 "HUD 래퍼를 읽을 수 없음": 래퍼 파일의 권한을 확인한다. 파일은 그대로다.
- "모듈 사본을 쓰지 못했습니다": 래퍼 옆 `hud/payload-mon/` 에 쓸 수 없다(권한, 같은 이름의 파일, 디스크 공간). 래퍼는 그대로다.
- "표시(>>> / <<<)의 짝이 맞지 않습니다": 래퍼에 payload-mon 표시 줄이 한쪽만 남았다. `on`·`off` 모두 거부하므로, 손으로 고치지 말라는 원칙의 유일한 예외다.
  `setup-omc-hud` 로 HUD 를 재설치하거나, 래퍼에서 짝 없이 남은 `// >>> payload-mon >>>` 또는 `// <<< payload-mon <<<` 줄을 지운 뒤 다시 실행한다.
- HUD 를 재설치한 뒤 payload 가 안 보이면 `on` 을 다시 실행한다. `setup-omc-hud` 로 재설치했다면 그 스킬이 다시 켠다.
- banker 업데이트 알림에 payload-mon 이 바뀌었다고 나오거나 `status` 에 "모듈 사본이 이 버전과 다름" 이 나오면, `on` 을 한 번 실행해 사본을 맞춘다.
- `status` 에 "주의: statusLine 명령에 … 보이지 않습니다" 가 나오면 statusline 이 다른 명령이다. smart-compact 처럼 HUD 를 감싸 호출하는 래퍼라면 정상 표시된다. 이 스킬은 OMC 커스텀 HUD 래퍼에만 붙는다.
- 추정치가 실제 "Request too large" 시점과 크게 어긋나면 Claude Code 가 세션 파일 형식이나 요청 필터를 바꿨을 수 있다. banker 이슈로 알린다.
