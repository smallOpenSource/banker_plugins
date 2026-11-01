# docs

프로젝트 문서를 관리하는 폴더. evidence 와 ADR 도 여기에 보관한다. banker init-dir 이 만든 틀이다.

| 폴더 | 둘 것 |
|---|---|
| `docs/` | 설계, 사용법, 운영 절차 문서 |
| `docs/evidence/` | evidence. 구현한 기능이 동작함을 다른 사람이 확인할 수 있는 근거(시험 출력, 실행 기록, 화면 캡처, 측정 결과) |
| `docs/adr/` | ADR(Architecture Decision Record). 결정 하나에 파일 하나. 맥락, 선택지, 결론과 그 이유 |

- 문서 하나에 주제 하나. 파일 이름은 주제를 드러내게 짓는다
- evidence 는 무엇을 언제 어떻게 확인했는지 남긴다(예: `2026-11-01-login-e2e.md`). 지어낸 결과를 쓰지 않는다
- ADR 파일 이름은 번호와 주제(예: `0001-db-choice.md`). 결정을 뒤집으면 새 ADR 을 쓰고, 옛 ADR 에 대체한 ADR 번호를 적는다
- banker progress-mon 의 ADR 탭은 이 폴더의 ADR 과 evidence 를 결정과 증거의 근거 출처로 참조한다
