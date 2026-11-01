# scripts

서비스 관리 스크립트. banker init-dir 이 만든 틀이다.

| 명령 | Windows | 하는 일 |
|---|---|---|
| `./scripts/start.sh` | `scripts\start.cmd` | `service.conf` 의 `command` 를 감독 프로세스로 시작 |
| `./scripts/stop.sh` | `scripts\stop.cmd` | 서비스와 감독 프로세스를 멈춤 |
| `./scripts/status.sh` | `scripts\status.cmd` | 감독과 자식의 실행 여부, 로그 크기를 따로 보고 |
| `./scripts/restart.sh` | `scripts\restart.cmd` | stop 뒤 start |

- 설정: `service.conf` 의 `name=`(기본 `app`), `command=`(한 줄)
- 로그: `logs/<name>.out.log`(표준 출력), `logs/<name>.err.log`(표준 오류). 100MB 마다 로테이션, 스트림마다 현재 파일 포함 최대 7개
- PID 파일: `logs/<name>.pid`(감독 PID, 자식 PID, 시작 시각)
- 필요: Node 18 이상. 없으면 종료 3. 다른 Node 를 쓰려면 환경 변수 `NODE` 에 경로
- 종료 코드: 0 성공, 1 실패(시작 2초 안에 멈춤, 멈추지 못함, status 에서 실행 중이 아님), 2 설정 없음, 3 Node 없음

## 동작

- `start` 는 분리된 감독 프로세스를 띄운다. 감독이 `command` 를 자식으로 실행하고 출력을 로그 파일에 쓴다
- `stop` 은 감독에 SIGTERM 을 보낸다. 감독이 자식의 프로세스 그룹에 넘기고, 10초 뒤에도 살아 있으면 강제로 끝낸다. Windows 는 `taskkill /T`, 10초 뒤 `/F`
- 감독이 죽으면 자식은 다음 출력 때 SIGPIPE 로 죽을 수 있다. `status` 는 감독과 자식을 따로 보고한다. 감독 없이 자식만 남았으면 `stop` 이 자식을 끝낸다

## 조정용 환경 변수

| 변수 | 기본 | 뜻 |
|---|---|---|
| `SERVICE_LOG_ROTATE_BYTES` | 104857600 | 로테이션 기준 바이트 |
| `SERVICE_STOP_GRACE_MS` | 10000 | 강제 종료 전 기다리는 시간 |
| `SERVICE_START_CHECK_MS` | 2000 | 시작 뒤 살아 있는지 확인하기까지 기다리는 시간 |
