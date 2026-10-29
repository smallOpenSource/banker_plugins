---
name: graceful-pause
description: "Codex 에서 작업 중에 보내면 지금 하던 단계만 끝내고 멈춘 뒤 보고하고 지시를 기다림. 작업이 도는 동안 입력창에 `$banker-graceful-pause`(플러그인 설치면 `$banker:graceful-pause`)를 쓰고 Enter 하면, 실행 중인 도구 호출이 끝난 뒤 그 턴에 전달됨. 'graceful-pause'/'멈춰'/'지금 단계만 끝내고 멈춤' 시 사용."
---

# graceful-pause (Codex)

Claude Code 의 `/graceful-pause` 에 해당하는 Codex 스킬이다. 답변은 한글.

Codex 는 작업 중에 Enter 로 보낸 글을 "Messages to be submitted after next tool call" 로 보관했다가, 실행 중인 도구 호출이 끝나면 같은 턴에 넣는다.
이 스킬을 그렇게 보내면 지금 단계가 끝난 자리에서 멈춘다(Codex 0.144.5 실측: `sleep 40` 이 끝난 뒤 남은 명령을 실행하지 않고 멈춤).

## 이 스킬을 받으면

1. 방금 끝난 도구 호출의 결과를 확인한다. 그 호출은 이미 끝난 상태로 전달된다.
2. 남은 단계를 시작하지 않는다. 새 도구 호출, 파일 수정, 명령 실행, 하위 에이전트를 시작하지 않는다.
3. 아래를 짧게 보고하고 사용자 지시를 기다린다.
   - 지금까지 한 일
   - 멈춘 지점(마지막으로 끝난 단계)
   - 남은 단계
4. 멈춘 자리가 일관되지 않으면(파일을 반쯤 고친 상태, 시작만 한 백그라운드 작업) 그 사실을 보고에 적는다. 되돌리거나 마저 하지 않는다.
5. 스킬 뒤에 새 지시가 붙어 있으면 멈춘 다음 그 지시를 따른다.

## 사용자가 쓰는 법

- 작업이 도는 동안 입력창에 `$banker-graceful-pause` 를 쓰고 Enter 한다. Codex 플러그인으로 설치했으면 `$banker:graceful-pause` 다. 새 지시를 뒤에 붙여도 된다.
- 지금 도구 호출까지 바로 끊으려면 Esc 를 누른다. 그때는 이 스킬이 필요 없다.
- 작업이 없을 때 쓰면 멈출 작업이 없다고 답한다.
- 스킬 이름을 치면 자동 완성 창이 뜬다. 첫 Enter 는 그 선택이고, 둘째 Enter 가 보낸다. 보낸 글은 입력창 위에
  "Messages to be submitted after next tool call" 아래로 옮겨진다. 입력창에 글이 남아 있으면 Enter 를 한 번 더 누른다.
