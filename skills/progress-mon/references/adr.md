# adr.json (ADR 탭)

ADR 탭의 자료. 의사 결정 과정과 결론에 더해, 타인이 결과를 의심할 때 확인할 근거를 함께 적는다.
init 절차의 ADR 단계와 갱신 규칙(SKILL.md)에서 에이전트가 쓰고, `check` 가 형식과 참조를 확인한다.
화면은 자동 갱신하지 않는다. 주소 `?tab=adr`, `export` 파일의 `#adr`.

## 두 층

| 층 | 칸 | 뜻 |
|---|---|---|
| 프로젝트(하나) | `project.verification` | 단위 기능(모듈)마다 검증 결과와 evidence |
| 프로젝트(하나) | `project.flow` | 입력, 처리 로직, 출력 |
| 프로젝트(하나) | `project.proof` | 구현된 기능과 증명 위치, 구현 못 한 기능과 사유 |
| 결정(여럿) | `decisions[]` | 맥락, 선택지, 결론과 이유, 최적화 로직, 확장 대응, 포기와 얻은 것, 근거 출처 |

```json
{
  "project": {
    "verification": [
      { "id": "M-1", "module": "<단위 기능>", "result": "<결과>", "evidence": ["<참조>"] },
      { "id": "M-2", "module": "<검증 못 한 단위 기능>", "status": "unverified", "why": "<미검증 사유>" }
    ],
    "flow": { "input": "<입력>", "logic": "<처리 로직>", "output": "<출력>", "refs": ["<참조>"] },
    "proof": {
      "implemented": [{ "feature": "<구현된 기능>", "modules": ["M-1"], "proofs": ["<참조>"] }],
      "notImplemented": [{ "feature": "<구현 못 한 기능>", "why": "<사유>" }]
    }
  },
  "decisions": [
    {
      "id": "ADR-1", "title": "<결정 제목>", "status": "accepted|proposed|superseded", "date": "<YYYY-MM-DD, 선택>",
      "context": "<맥락>",
      "options": [{ "name": "<선택지>", "pros": "<장점>", "cons": "<단점>" }],
      "decision": "<결론>", "why": "<과정과 선택 이유>",
      "optimization": { "process": "<최적 로직인지 검증한 과정>", "modules": ["M-1"], "refs": ["<참조>"] },
      "scaling": { "argument": "<확장 대응 논거>", "limits": "<한계, 선택>", "refs": ["<참조>"] },
      "tradeoffs": { "gaveUp": [{ "what": "<포기한 것>", "why": "<이유>" }], "gained": [{ "what": "<얻은 것>", "purpose": "<목적>" }] },
      "sources": ["<참조>"]
    }
  ]
}
```

- 모듈 id 는 `project.verification` 안에서 겹치지 않는다. 결정과 `proof.implemented` 의 `modules` 는 있는 id 만
- `options` 는 2개 이상. 하나뿐이면 `rejected`(다른 선택지를 버린 사유)를 쓴다
- `modules`, `refs`(flow), `limits`, `date`, `rejected`, `sources` 는 선택. 그 밖 칸은 필수
- 모듈 `status` 는 선택. 없거나 `"verified"` 면 검증한 모듈(`result`, `evidence` 필수), `"unverified"` 면 미검증 모듈(`why` 필수, `result`, `evidence` 선택)
- 모든 글은 화면에서 escape 한다. 비밀값(키, 토큰, 비밀번호)을 적지 않는다

## 사용자 항목과 칸

| 사용자 항목 | 층과 칸 | 화면 절 제목 |
|---|---|---|
| 1. 최적화 로직 | 결정의 `optimization` | 최적화 로직 |
| 2. 검증 | `project.verification` | 검증 |
| 3. 흐름 | `project.flow` | 흐름 |
| 4. 확장 대응 | 결정의 `scaling` | 확장 대응 |
| 5. 포기와 얻은 것 | 결정의 `tradeoffs` | 포기와 얻은 것 |
| 6. 증거 | `project.proof` | 증거 |

- 주장에는 증거(사용자 결정 D 안). 근거가 없으면 지어내지 않는다
  - 검증한 모듈의 `evidence`, 구현된 기능의 `proofs` 는 확인된 참조 1개 이상. 확인된 참조는 꼴이 맞고 `gap` 이 아니며 아래 참조 확인에서 FAIL 도 WARN 도 없는 것. 출력 파일 없는 `cmd`, 파일에 없는 이름의 `test`, git 이 꺼졌거나 저장소가 아닌 `commit` 은 세지 않는다. 없으면 FAIL. 벗어나는 길: 그 모듈은 `status: "unverified"` 와 `why`, 그 기능은 `notImplemented` 로 옮김
  - `project.verification`, `project.proof` 칸 전체를 `gap` 으로 두면 FAIL(모듈을 적고 미검증으로, 기능은 `notImplemented` 로)
  - 결정의 `optimization`, `scaling`, `tradeoffs` 와 `project.flow` 는 `{ "gap": "<사유>" }` 로 비울 수 있음(밀도 WARN)
  - 서술 칸(결정의 `optimization` 과 `scaling`)을 채웠는데 `refs` 에 확인된 참조가 0개면 FAIL 이 아니고 WARN(`adr 서술참조` 밀도). 다만 그 칸 수를 집계 배지와 `check` 마지막 줄에 `참조 없는 서술 n` 으로 늘 보인다
- 화면은 빈 칸을 `근거 없음: <사유>` 로 보이고, 결정 목록에 결정별 3항목 채움 수(`n/3`)와 빈 항목을 보인다
- 집계 배지 `근거 없음 n칸, 미검증 n, 구현 못 함 n, 참조 없는 서술 n`: adr.json 안의 `{ "gap" }` 수(여섯 항목 칸과 참조 자리), `status: "unverified"` 모듈 수, `notImplemented` 기능 수, `refs` 에 확인된 참조가 0개인 서술 칸 수. 화면 맨 위(프로젝트 요약 위)와 `check` 의 마지막 줄 `adr 근거 없음 n칸, 미검증 n, 구현 못 함 n, 참조 없는 서술 n` 에 늘 보임. 0 이면 0(adr.json 이 없으면 check 는 모두 0). 넷 가운데 하나라도 0 이 아니면 배지는 빨강(모든 모듈이 미검증이거나 서술 칸에 참조가 없는데 초록 0칸만 보이지 않게)
  - `check` 는 참조 확인을 마친 참조(FAIL, WARN 없음)만 센다. 화면은 파일을 읽지 않으므로 꼴이 맞고 `gap` 이 아닌 참조를 센다. 그래서 출력 파일 없는 `cmd` 하나만 적힌 칸은 화면에서 0, `check` 에서 1 로 셀 수 있다
  - check 대조: `check` 명령은 끝에 자료 폴더의 `adr-check.json` 에 그 집계 글, 그때 `adr.json` 글(BOM 을 뗀 뒤)의 sha256, 시각(UTC)을 쓴다. `adr.json` 이 없거나 JSON 이 아니면 쓰지 않는다. 쓰지 못하면 stderr 에 `경고: adr-check.json 쓰기 실패(...)` 만 내고 검사 결과와 종료 코드는 그대로다
  - 화면은 집계 배지 옆에 대조 배지를 보인다
    - 기록이 없거나 꼴이 틀림: `check 기록 없음. 참조 확인은 check`
    - sha256 이 다름: `check(<시각> UTC) 뒤 adr.json 이 바뀜. check 를 다시 실행하면 대조`
    - sha256 과 집계 글이 같음: 초록 `check(<시각> UTC) 와 같음`
    - 집계 글이 다름: 빨강 `check(<시각> UTC) 기준: <check 집계>. 화면은 적힌 참조로 세어 다름. 확인 못 한 참조는 check 의 참조 줄`
  - 대조는 check 를 실행한 때의 참조 파일 기준이다. 그 뒤 참조 파일만 바뀌면(adr.json 은 그대로) 배지는 그대로이므로 다시 확인하려면 check 를 실행한다

## 참조

`<참조>` 는 종류에 맞는 칸만 쓴다. 참조 자리에 `{ "gap": "<사유>" }` 도 받는다.

| `kind` | 칸 | 화면 글 |
|---|---|---|
| `file` | `path`, 선택 `line`(1 이상 정수) | `파일 <path>:<line>` |
| `test` | `path`, `name`(시험 이름) | `시험 <path> 의 <name>` |
| `commit` | `hash`(4~40자 16진) | `커밋 <앞 7자리>` |
| `cmd` | `cmd`, 선택 `output`(출력 파일) | `명령 <cmd>, 출력 <output>` |

- 모든 종류에 선택 `note`(짧은 설명)
- 경로는 프로젝트 루트 기준 상대 경로. 화면은 참조를 글로만 보이고 파일을 읽거나 링크하지 않는다
- 시험 결과는 실제로 돌린 명령의 출력만 참조한다. 출력 파일이 없으면 `output` 없이 두어 WARN 으로 드러낸다
- 권장: `cmd` 의 `output` 파일은 `docs/evidence/` 에 두고 머리 3줄에 명령, 종료 코드, 시각을 적는다

  ```
  명령: node --test test/
  종료 코드: 0
  시각: 2026-10-29T03:00:00Z
  ```

- init-dir 로 만든 프로젝트는 `docs/adr/`(사람이 쓴 ADR 문서), `docs/evidence/`(검증 출력)가 근거 출처다

## check 판정

항목 누락(결정 H)

| 경우 | check |
|---|---|
| 항목 칸이 없거나 꼴이 틀림 | `FAIL adr.json <json 경로> <이유>`(스키마 위반) |
| 결정의 3칸이나 `project.flow` 가 `{ "gap": "<사유>" }` | `WARN density adr 빈 항목 <값>/<하한>: <json 경로>` |
| 서술 칸(`optimization`, `scaling`)의 `refs` 에 확인된 참조가 0개 | `WARN density adr 서술참조 <값>/<하한>: <json 경로>`, 마지막 줄 `참조 없는 서술 n` |
| `gap` 에 사유가 없음 | `FAIL adr.json <json 경로>.gap gap 에 사유 없음` |
| 검증한 모듈의 `evidence`, 구현된 기능의 `proofs` 에 확인된 참조(FAIL, WARN 없음)가 0개 | `FAIL adr.json <json 경로> 증거 없음: ...`(벗어나는 길을 줄에 적음) |
| `project.verification`, `project.proof` 칸 전체가 `gap` | `FAIL adr.json <json 경로> 증거 없음: ...` |

참조 확인(결정 I)

| 참조 종류 | check |
|---|---|
| `file` | 절대 경로, `..` 이 든 경로, 루트 밖을 가리키는 링크는 `FAIL`. 없는 파일, 폴더나 특수 파일(FIFO 등), 줄 수를 넘는 `line` 은 `FAIL` |
| `test` | 파일 규칙은 `file` 과 같음. 파일 글에 `name` 이 없으면 `WARN` |
| `commit` | git 저장소에서 없는 커밋은 `FAIL`. `config.json` 의 `sources.git` 이 꺼졌거나 저장소가 아니면 `WARN`(확인 못 함) |
| `cmd` | 명령 자체는 확인 못 함. `output` 이 있으면 `file` 규칙, 없으면 `WARN` |

- 참조 결과 줄은 `FAIL adr.json <json 경로> 참조: <이유>`, `WARN adr.json <json 경로> 참조: <이유>`
- 참조 파일은 check 에서만 읽는다. 크기 상한(4 MB) 안의 일반 파일만 읽고, 넘으면 줄과 이름 확인을 못 해 `WARN`
- 처리가 다르다
  - 스키마 위반 FAIL: init 정리 단계에서 FAIL 이 남으면 `adr.json` 을 지우지 않고 같은 폴더의 `adr.json.rejected-<YYYYMMDD-HHMMSS>`(이름이 있으면 `-2` 부터 번호)로 옮겨 "자료 없음" 으로 둔다. 옮긴 파일을 고쳐 `adr.json` 으로 되돌릴 수 있다
  - 참조 FAIL: 파일을 지우지 않는다. init 정리 단계에서 그 참조를 `{ "gap": "참조 확인 실패: <이유>" }` 로 바꾸고 check 를 다시 돌린다. 갱신 때(init 밖)는 FAIL 줄을 보고하고 json 경로를 고친다
  - 증거 없음 FAIL: 정리 단계가 파일을 옮기지 않고 자동으로 고치지도 않는다. 참조를 `gap` 으로 바꾼 결과 증거가 모두 `gap` 이 된 주장은 `정리: 증거가 남지 않은 주장 n건` 줄로 알리고, 에이전트가 판단해 그 모듈을 미검증으로, 그 기능을 `notImplemented` 로 옮긴다
  - `check --adr-cleanup` 이 정리 단계를 적용한 뒤 검사한다(출력 첫 줄 `정리: ...`)

두 원본 갈라짐(결정 K)

| 경우 | check |
|---|---|
| `docs/adr/*.md` 가운데 어떤 결정의 `sources` 도 가리키지 않는 파일 | 파일마다 `WARN adr.json sources: docs/adr/<파일> 를 가리키는 결정 없음` |
| `docs/adr/` 가 없거나 `.md` 가 없음 | 줄 없음 |

- 연결 유무만 본다. 사람이 쓴 문서와 `adr.json` 의 내용 일치는 검사하지 않는다

밀도(adr.json 이 있으면 늘. 없으면 init 기록이 있을 때만)

| `check` 의 이름 | 하한 |
|---|---|
| `adr 빈 항목` | 프로젝트 3칸과 결정마다 3칸이 모두 `gap` 아님 |
| `adr 검증` | `verification` 1 이상 |
| `adr 흐름` | 입력, 처리, 출력 3칸이 빈 칸 아님 |
| `adr 증거` | `proof.implemented` 1 이상 |
| `adr 결정` | 결정 1 이상 |
| `adr 포기얻음` | 결정마다 `gaveUp`, `gained` 각 1 이상 |
| `adr 서술참조` | `gap` 이 아닌 서술 칸(`optimization`, `scaling`)마다 `refs` 에 확인된 참조 1 이상. 못 채운 칸은 json 경로로 |

- 끝의 밀도 요약에 `density adr ok|low`(init 기록이 있을 때), 마지막 줄은 늘 `adr 근거 없음 n칸, 미검증 n, 구현 못 함 n, 참조 없는 서술 n`

## 좋은 예

```json
{
  "project": {
    "verification": [
      { "id": "M-1", "module": "설정 읽기", "result": "시험 3개 통과", "evidence": [{ "kind": "test", "path": "test/config.test.mjs", "name": "설정 읽기" }, { "kind": "cmd", "cmd": "node --test test/", "output": "docs/evidence/test-run.md" }] },
      { "id": "M-2", "module": "화면 렌더", "result": "고정 자료로 HTML 확인", "evidence": [{ "kind": "file", "path": "src/render.mjs", "line": 40, "note": "render 함수" }] }
    ],
    "flow": { "input": "config.json 과 자료 파일", "logic": "설정을 읽어 검사한 뒤 탭마다 HTML 로 렌더", "output": "로컬 서버 화면과 단일 HTML", "refs": [{ "kind": "file", "path": "src/main.mjs", "line": 12 }] },
    "proof": {
      "implemented": [{ "feature": "설정 읽기와 화면", "modules": ["M-1", "M-2"], "proofs": [{ "kind": "test", "path": "test/config.test.mjs", "name": "설정 읽기" }, { "kind": "commit", "hash": "1a2b3c4" }] }],
      "notImplemented": [{ "feature": "알림", "why": "범위 밖으로 미룸(계획 9장)" }]
    }
  },
  "decisions": [
    {
      "id": "ADR-1", "title": "자료는 JSON 파일", "status": "accepted", "date": "2026-10-20",
      "context": "의존성 없이 자료를 저장해야 함",
      "options": [{ "name": "JSON 파일", "pros": "내장 모듈만", "cons": "동시 쓰기 잠금 필요" }, { "name": "SQLite", "pros": "질의", "cons": "의존성 추가" }],
      "decision": "JSON 파일", "why": "의존성 0 원칙과 자료 크기가 작음",
      "optimization": { "process": "자료 크기 1 MB 미만에서 읽기 시간을 재어 파일 하나 읽기가 충분함을 확인", "modules": ["M-1"], "refs": [{ "kind": "cmd", "cmd": "node bench.mjs", "output": "docs/evidence/bench.md" }] },
      "scaling": { "argument": "탭마다 파일을 나눠 한 파일이 커지지 않음. 바뀐 파일만 다시 읽음", "limits": "파일 하나가 32 MB 를 넘으면 읽지 않음", "refs": [{ "kind": "file", "path": "src/sources.mjs", "line": 30 }] },
      "tradeoffs": { "gaveUp": [{ "what": "질의 기능", "why": "의존성 0" }], "gained": [{ "what": "설치 없는 실행", "purpose": "어느 PC 에서나 바로 실행" }] },
      "sources": [{ "kind": "file", "path": "docs/adr/0001-data-file.md" }]
    }
  ]
}
```

- 나쁜 예: 실행하지 않은 시험을 "통과" 로 적음, 참조 없이 "검증함" 만 적음, 근거가 없는 확장 논거를 지어냄. 결정의 근거가 없으면 `gap` 과 사유, 증거 없는 모듈과 기능은 미검증과 `notImplemented`
