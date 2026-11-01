# tests

단위 시험과 통합 시험 폴더. banker init-dir 이 만든 틀이다.

| 폴더 | 둘 것 |
|---|---|
| `tests/unit/` | 단위 시험. 외부 서비스 없이 빠르게 끝나는 것 |
| `tests/integration/` | 통합 시험. 실제 서비스, 파일, 네트워크를 쓰는 것 |

- 실행: `./tests/run.sh`(Windows `tests\run.cmd`). 스위트 이름을 주면 그것만(`./tests/run.sh unit`)
- 스위트 설정: `tests.conf` 에 `<스위트>=<명령>`. 프로젝트 폴더에서 셸로 실행
- 출력: 스위트마다 한 줄(`PASS unit (1.2s)`, `FAIL integration (0.3s, 종료 1)`). 실패하면 그 출력의 마지막 20줄, 끝에 요약 한 줄
- 시간 한도: 스위트마다 600초. `tests.conf` 의 `timeout=<초>` 나 환경 변수 `TESTS_TIMEOUT_SECONDS`(우선)로 바꿈. 넘으면 `FAIL <스위트> (600.0s, timeout 600초)` 와 그 스위트의 프로세스 트리 종료. 그래서 `timeout` 은 스위트 이름으로 못 씀
- 종료 코드: 0 모두 통과, 1 실패 있음, 2 설정 없음(실행할 명령 없음 포함), 3 Node 18 이상 없음
- 시험은 결과를 간결하게 출력하도록 쓴다. 통과는 조용히, 실패는 무엇이 왜 틀렸는지 한두 줄로
