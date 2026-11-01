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
- PID 파일: `logs/<name>.pid`(감독 PID, 자식 PID, 시작 시각, 자식 명령)
- 필요: Node 18 이상. 없으면 종료 3. 다른 Node 를 쓰려면 환경 변수 `NODE` 에 경로
- 종료 코드: 0 성공, 1 실패(시작 2초 안에 멈춤, 멈추지 못함, status 에서 실행 중이 아님), 2 설정 없음, 3 Node 없음

## 동작

- `start` 는 분리된 감독 프로세스를 띄운다. 감독이 `command` 를 자식으로 실행하고 출력을 로그 파일에 쓴다
- `stop` 은 감독에 SIGTERM 을 보낸다. 감독이 자식의 프로세스 그룹에 넘기고, 10초 뒤에도 살아 있으면 강제로 끝낸다. Windows 는 `taskkill /T`, 10초 뒤 `taskkill /T /F`
- 감독이 죽으면 자식은 다음 출력 때 SIGPIPE 로 죽을 수 있다. `status` 는 감독과 자식을 따로 보고한다. 감독 없이 자식만 남았으면 `stop` 이 자식을 끝낸다
- PID 파일의 PID 는 확인한 뒤에만 이 서비스로 본다. 시작 시각이 마지막 부팅보다 이르면 낡은 파일이다. 명령줄에 `service.mjs` 와 `__supervise`(감독) 또는 기록된 `command`(자식)가 없으면 다른 프로세스다. 명령줄은 POSIX 는 `ps`, Windows 는 PowerShell `Get-CimInstance` 로 읽는다. 확인하지 못한 PID 에는 신호를 보내지 않고 사유를 출력한다
- 로테이션이 실패하면(Windows 에서 다른 프로그램이 로그를 연 경우 등) 표준 오류 로그에 `service:` 경고 한 줄을 쓰고 현재 파일에 이어 쓴다

## 조정용 환경 변수

| 변수 | 기본 | 뜻 |
|---|---|---|
| `SERVICE_LOG_ROTATE_BYTES` | 104857600 | 로테이션 기준 바이트 |
| `SERVICE_STOP_GRACE_MS` | 10000 | 강제 종료 전 기다리는 시간 |
| `SERVICE_START_CHECK_MS` | 2000 | 시작 뒤 살아 있는지 확인하기까지 기다리는 시간 |
