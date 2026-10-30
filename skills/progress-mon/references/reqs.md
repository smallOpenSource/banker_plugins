# reqs.json

구현요건 탭의 AC 목록과 AC 별 담당 스토리. `req-spec.json`(`references/req-spec.md`)의 `specs[].acs` 가 이 id 를 가리킨다.

## 스키마

```json
{
  "acs": [
    { "id": "AC-3", "title": "config.json 의 port 로 바인드", "stories": ["A2"], "tests": "test/config.test.js port" },
    { "id": "AC-4", "title": "형식 오류는 기본값과 경고", "stories": ["A2", "A3"] }
  ]
}
```

| 키 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `acs` | 배열 | 예 | AC 목록 |
| `acs[].id` | 문자열 | 예 | AC id. 겹치면 FAIL |
| `acs[].stories` | 문자열 배열 | 아니오 | 담당 스토리 id. 비거나 없으면 그 AC 의 명세는 미검증 |
| `acs[].title`, `acs[].tests` | 문자열 | 아니오 | 사람이 읽는 설명. 화면에는 id 만 |

- 모르는 키(`generated`, `gaps`, `auditSummary` 등)는 허용하고 무시한다
- `stories` 의 id 는 `config.json` 의 `stories`, `story` 명령으로 더한 id, `req-spec.json` 의 `stories` 키 가운데 하나여야 한다. 없으면 `FAIL reqs.json acs[i].stories 스토리 없음: <id>`

## 작성 지침

- AC 는 확인할 수 있는 문장으로 쓴다(입력, 기대 결과). 시험이 있으면 `tests` 에 이름
- 스토리가 있는 프로젝트: AC 마다 담당 스토리를 1개 이상. 커밋 제목이 스토리 id 로 시작하면 완료 판정이 자동이다
- 스토리가 없는 프로젝트: `stories` 를 비우고 `req-spec.json` 의 명세마다 `state` 와 `note` 로 판정한다
