# logs

서비스 로그 폴더. banker init-dir 이 만든 틀이다.

- 서비스마다 표준 출력과 표준 오류를 나눠 저장
  - `<이름>.out.log`: 표준 출력
  - `<이름>.err.log`: 표준 오류
- 로테이션: 쓰기 전에 "현재 크기 + 쓸 양" 이 100MB 를 넘으면 돌림
  - `<이름>.out.log` 가 `<이름>.out.1.log` 로, `.1` 이 `.2` 로 밀림
  - 현재 파일 포함 스트림마다 최대 7개. 가장 오래된 `.6` 은 지움
  - 스트림당 최대 700MB
- `<이름>.pid`: 실행 중인 감독과 자식의 PID
- 로그를 쓰는 도구: `./scripts/start.sh`(Windows `scripts\start.cmd`)
- 이 폴더의 로그는 git 에 올리지 않음(`.gitignore`)
