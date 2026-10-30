# flow.json

workflow 탭의 실행 흐름. 흐름(lane)마다 SVG 그림 하나. 좌표 키는 없다. 배치는 항상 자동이다.

## 스키마

```json
{
  "note": "코드를 읽고 모은 두 흐름(읽은 파일은 inventory.json). 근거 줄 번호는 저장소 루트 기준.",
  "lanes": [
    {
      "id": "build",
      "title": "빌드: npm run build 에서 dist 까지",
      "color": "#6a1b9a",
      "note": "npm run build 로 시작(package.json:7). 실패하면 그 단계에서 멈추고 종료 1. 근거는 scripts/build.mjs 와 CI 설정.",
      "steps": [
        { "id": "b1", "label": "설정 읽기", "detail": "build.config.json 을 읽고 대상 목록과 출력 폴더를 정함", "actor": "scripts/build.mjs", "refs": ["scripts/build.mjs:10-24"] },
        { "id": "b2", "label": "번들", "detail": "esbuild 로 진입점마다 번들을 만들고 소스맵을 씀", "actor": "esbuild", "refs": ["scripts/build.mjs:30-58"] }
      ],
      "branches": [
        { "from": "b1", "to": "", "when": "설정 없음: 멈춤", "note": "build.config.json 이 없으면 종료 1 (scripts/build.mjs:12)" }
      ],
      "externals": [
        { "id": "x1", "label": "npm 레지스트리", "linkTo": "b2", "note": "의존성 설치 때만 (package-lock.json)" }
      ]
    }
  ],
  "scenes": [
    { "n": 1, "sec": 1.5, "lane": "build", "focus": ["b1", "b2"], "caption": "설정을 읽고 번들을 만듦" }
  ]
}
```

| 키 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `note` | 문자열 | 아니오 | 탭 머리 설명 |
| `lanes[].id` | 문자열 | 예 | 흐름 id(겹침 FAIL) |
| `lanes[].title` | 문자열 | 예 | 흐름 제목 |
| `lanes[].color` | `#rrggbb` | 아니오 | 흐름 색. 그 밖은 FAIL, 화면은 기본 색 |
| `lanes[].note` | 문자열 | 밀도 | 흐름 설명 3문장(시작 명령, 실패 처리, 근거). 문장 끝 온점에서 줄바꿈 |
| `steps[].id` | 문자열 | 예 | 흐름 안 단계 id(겹침 FAIL) |
| `steps[].label` | 문자열 | 예 | 단계 이름. 상자에 안 들어가면 두 줄 |
| `steps[].detail` | 문자열 | 예 | 설명. 상자 안 최대 3줄 |
| `steps[].actor` | 문자열 | 예 | 행위자(파일, 도구, 사람) |
| `steps[].refs` | 문자열 배열 | 밀도 | 근거 `파일:줄`. 마우스를 올리면 보임 |
| `steps[].planned` | 참, 거짓 | 아니오 | 예정(점선 상자, "예정" 표기) |
| `steps[].alone` | 참, 거짓 | 아니오 | 앞 단계와 잇지 않음(다른 진입점) |
| `branches[]` | `{from, to, when, note?}` | 밀도 | 실패, 예외 분기. 상자 아래 빨간 표. `to` 가 빈 문자열이면 흐름 끝 |
| `externals[]` | `{id, label, linkTo, note?, planned?}` | 밀도 | 외부 구성요소. 상자 위 회색 표, `planned` 면 주황 |
| `scenes[]` | `{n, sec, lane, focus, caption}` | 아니오 | 장면 대본. `lane` 이 빈 문자열이면 전체, `focus` 는 그 흐름의 단계 id |

- 상자 id 는 `<흐름 id>-<단계 id>`. 장면과 상자를 잇는 열쇠다

## 배치

- 한 줄에 상자 5개, 줄마다 방향을 바꾸는 지그재그. 상자 176 x 92 px
- 분기 표가 아래 줄 상자나 외부 표와 겹치면 그 줄 간격만 늘린다
- 단계 이름은 14px 굵은 글꼴 폭 추정(한글 14, 공백 5, 영문은 글자별 6~14 px)으로 상자 안에 정말 안 들어갈 때만 두 줄로 바꾼다
  - 한 줄 한도: 이름 시작(상자 왼쪽 + 32)부터 상자 테두리 안쪽(176 - 2)까지. 예정 단계는 "예정" 표기 앞 4 px 까지
  - 두 줄이면 설명을 한 줄(15 px) 내린다. 설명은 3줄까지 그대로 두고, 내린 설명이 3줄이면 그 상자를 15 px 늘린다(다음 줄도 그만큼 내려감)

## check 항목

| 검사 | 결과 |
|---|---|
| 형식, 필수 키, id 겹침, 분기 `from`/`to` 와 외부 `linkTo` 의 단계, 장면 `lane`/`focus`, 색 | FAIL |
| 분기 표가 아래 줄 상자와 겹침, 외부 표와 분기 표 겹침, 이름 둘째 줄과 설명 첫 줄 겹침 | FAIL |
| 분기 표가 이웃 칸의 분기 표나 분기 세로선과 겹침, 외부 표가 이웃 칸 외부 표와 겹침 | FAIL(글을 줄임) |
| 분기 표 폭이 194 px 를 넘고 같은 줄 오른쪽 이웃 칸에 상자가 있음 | WARN |
| 한 상자 외부 표 합계 폭이 176 px 를 넘음 | WARN |
| 단계 이름이 두 줄로도 넘침 | WARN |
| 흐름 6개, 흐름당 단계 15개 초과 | WARN(크기 지침) |

- 겹침은 가로와 세로 모두 1 px 이상일 때만. 변이 닿기만 하면 겹침 아님
- 분기 표 글(`when`)과 외부 표 글(`label`)은 짧게. 길면 겹침 FAIL 이 난다. 자세한 근거는 `note`
