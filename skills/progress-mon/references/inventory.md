# inventory.json

init 때 에이전트가 읽기 예산 안에서 찾은 실제 구성요소, 흐름, 외부 시스템, 읽은 파일. 밀도 하한 계산과 작은 저장소 예외의 근거다(`references/authoring.md`). 화면에는 나오지 않는다.

## 스키마

```json
{
  "components": [
    { "name": "API 서버", "path": "server/app.js" },
    { "name": "웹 화면", "path": "web/src" },
    { "name": "PostgreSQL", "path": "server/db.js" }
  ],
  "flows": [
    { "name": "빌드: npm run build", "steps": 6, "evidence": "scripts/build.mjs" },
    { "name": "요청 처리: GET /api/orders", "steps": 8, "evidence": "server/routes/orders.js:10-80" }
  ],
  "externals": [
    { "name": "PostgreSQL", "evidence": "server/db.js:5" }
  ],
  "read": ["README.md", "package.json", "server/app.js", "web/src/App.tsx"]
}
```

| 키 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `components` | `[{name, path}]` | 예 | 구성요소(모듈, 실행 파일, 서비스, 설정, 외부 시스템). `path` 는 저장소 안 실제 경로(파일이나 폴더). 외부 시스템은 저장소 밖이라 그것을 부르거나 설정하는 저장소 안 파일을 `path` 에 적는다 |
| `flows` | `[{name, steps, evidence}]` | 예 | 실제 실행 흐름(명령, 빌드, 배포, 요청 처리). `steps` 는 0 이상 정수, `evidence` 는 근거 파일 |
| `externals` | `[{name, evidence}]` | 예 | 외부 시스템. `evidence` 는 그것을 부르는 파일 |
| `read` | 경로 배열 | 아니오 | 실제로 연 파일(전체와 일부). 검색 결과로만 본 파일은 적지 않는다(`references/authoring.md` 의 "읽기 예산") |

- 경로는 프로젝트 루트 기준 상대 경로. `파일:줄`, `파일:줄-줄` 이면 줄 번호를 떼고 존재를 본다
- 모르는 키는 무시한다

## check 항목

| 검사 | 결과 |
|---|---|
| JSON 형식, `components`, `flows`, `externals` 가 배열 | FAIL |
| `path`, `evidence` 가 저장소에 없음(외부 시스템 구성요소 포함) | FAIL `inventory.json <json 경로> 경로 없음: <값>` |
| `flows[].steps` 가 0 이상 정수가 아님 | FAIL |
| `read` 가 배열이 아님 | FAIL |

## 하한 계산

| 하한 | 식 |
|---|---|
| 구성도 영역 | min(5, `components` 수) |
| 구성도 상자 | min(20, `components` 수) |
| 구성도 연결 | min(15, `arch.json` 에 그린 상자(`nodes`) 수 - 1). `components` 수나 낮춘 상자 하한이 아님 |
| workflow 흐름 | min(2, `flows` 수) |
| workflow 흐름당 단계 | 단계가 많은 흐름부터 `steps` 가 많은 `flows` 와 짝지어 min(7, 그 `steps`) |

## 작성 지침

- 실제로 있는 것만 적는다. 하한을 낮추려고 빼지 않는다. 큰 저장소는 하한을 넘어야 하고, 넘지 못하면 이 파일이 그 이유(실제 구성요소 수)를 보여야 한다
- 폴더 하나를 대표 파일만 읽었으면 그 폴더를 구성요소 하나로 적는다
- 구성도 상자와 workflow 단계는 이 목록에서 나와야 한다. 목록에 없는 것을 그리지 않는다
