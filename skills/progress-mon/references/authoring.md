# init 작성 지침

init 절차(SKILL.md)에서 에이전트가 4탭 자료를 쓸 때 따르는 기준. 목표 밀도는 이 문서 안에서 확인한다: 아래 "밀도 하한" 표의 수(구성도 영역 5, 상자 20, 연결 15, workflow 흐름 2, 흐름당 단계 7 등)와 "좋은 예" 의 꼴(상자 설명 2~3줄과 칩과 근거, 연결마다 `파일:줄`, 흐름마다 실패 분기와 3문장 설명).
숫자 하한은 보조 점검이다. 하한을 채워도 아래 좋은 예보다 얇으면(설명 한 줄, 근거 없음, 분기 없음) 보충한다.

## 순서

1. 읽기 예산 안에서 코드를 읽는다
2. `inventory.json` 에 실제 구성요소, 흐름, 외부, 읽은 파일을 적는다(`references/inventory.md`)
3. `config.json` 의 `title`, `shortName`, `stories` 를 채운다
4. `req-spec.json`, `reqs.json`, `flow.json`, `arch.json` 을 쓴다. 좌표는 쓰지 않는다
5. `check` 로 검사한다. FAIL 0 까지 최대 3회. `WARN density` 가 남으면 한 번 더 보충(SKILL.md init 절차 8, 9)

## 밀도 하한

| 탭 | 항목 | 하한 | `check` 의 이름 |
|---|---|---|---|
| 구성도 | 영역 | 5 | `arch 영역` |
| 구성도 | 상자 | 20 | `arch 상자` |
| 구성도 | 상자 설명 | 상자마다 2~3줄(아래 "설명 줄 수") | `arch 상자설명` |
| 구성도 | 연결 | 15 | `arch 연결` |
| 구성도 | 연결 근거 | 연결마다 `refs`(`파일:줄`) | `arch 연결근거` |
| 구성도 | 범례, 주 흐름, 장면 | `legend` 1 이상, `main` 1 이상, `scenes` 5 이상 | `arch 범례`, `주흐름`, `장면` |
| workflow | 흐름 | 2 | `workflow 흐름` |
| workflow | 흐름당 단계 | 7 | `workflow 단계:<흐름 id>` |
| workflow | 단계 설명 | 단계마다 2~3줄(아래 "설명 줄 수") | `workflow 단계설명` |
| workflow | 행위자, 근거 | 단계마다 `actor`, `refs` | `workflow 행위자`, `단계근거` |
| workflow | 실패 분기, 외부 | 흐름마다 `branches` 1 이상, `externals` 1 이상 | `workflow 실패분기`, `외부` |
| workflow | 흐름 설명 | 흐름마다 `note` 3문장(시작 명령, 실패 처리, 근거) | `workflow 흐름설명` |
| 구현요건 | 요구 | 요구마다 원문 `text` 와 근거 `source` | `req 요구` |
| 구현요건 | 교차 대응 | 명세마다 AC 1 이상. 스토리가 있으면 AC 를 거쳐 담당 스토리 1 이상 | `req 명세AC`, `명세스토리` |
| 구현요건 | 비고 | `state` 를 적은 명세는 `note`(판정 근거) | `req 비고` |
| 진척도 | 기타 항목 | 항목마다 `note`(근거 커밋, 결과). 문제점이 없으면 `--issue` 를 빼고 실행(칸은 빈칸) | `history 비고` |

- 미달은 `WARN density <탭> <항목> <값>/<하한>` 한 줄씩. 종료 코드에 영향 없음
- 대상마다 재는 항목은 줄 끝에 `: ` 와 못 채운 대상을 붙인다. 앞 10개, 넘으면 `외 n`

  | 항목 | 붙는 이름 | 예 |
  |---|---|---|
  | `arch 상자설명` | 상자 id(줄 수) | `n3(1줄), n7(4줄)` |
  | `arch 연결근거` | 연결 id(없으면 `<from>-<to>`) | `e-req` |
  | `workflow 단계설명` | `<흐름 id>/<단계 id>(줄 수)` | `build/b3(1줄)` |
  | `workflow 행위자`, `단계근거` | `<흐름 id>/<단계 id>` | `build/b3` |
  | `workflow 실패분기`, `외부` | 흐름 id | `deploy` |
  | `workflow 흐름설명` | 흐름 id(문장 수) | `deploy(2문장)` |
  | `req 요구` | json 경로 | `users[2]` |
  | `req 명세AC`, `명세스토리`, `비고` | json 경로 | `users[0].specs[3]` |
  | `history 비고` | 항목 key | `docs-1` |

- 수만 재는 항목(영역, 상자, 연결, 범례, 주흐름, 장면, 흐름, `단계:<흐름 id>`)은 이름을 붙이지 않는다. 수를 늘린다
- 하한을 채운 항목은 줄을 내지 않는다. 값을 보려면 자료에서 직접 센다
- 자동 배치의 `이름표 덮음`, `이름표가 그림 밖` WARN 은 배치 조언이고 실패가 아니다(자동 배치 선은 상자를 돌아감). 연결을 하한 아래로 줄여 없애지 않는다. 줄이는 법은 `references/arch.md` 의 "자동 배치 WARN 줄이기"
- `check` 끝에 `density <탭> ok|low` 4줄(history, req, workflow, arch)
- 밀도는 init 이 만든 자료 폴더(`state.json` 의 `memory`)나 `inventory.json` 이 있을 때만 잰다

## 설명 줄 수

- 줄 수는 화면과 같은 줄바꿈 결과다. 글자 수가 아니다. `check` 가 같은 계산으로 잰다
- 구성도 상자
  - 자동 배치의 상자 폭은 영역마다 같다. 그 영역에서 가장 넓게 필요한 상자(긴 이름, 긴 칩, 설명의 긴 낱말)에 맞춘다. 최소 160 px
  - 160 px 상자의 한 줄은 띄어쓰기 포함 약 14자. 2줄은 약 15~28자, 3줄은 약 29~42자
  - 화면은 기본 2줄만 그린다. 3줄 설명은 그 상자에 `"lines": 3` 을 쓴다. 안 쓰면 `WARN arch.json nodes[i] 설명 잘림`
  - 이름이나 칩 하나가 길면 그 영역의 모든 상자가 넓어져 설명이 1줄로 줄 수 있다. 이름과 칩을 짧게 쓴다
- workflow 단계: 상자 폭 176 px 고정. 한 줄 약 14자. 2~3줄은 약 15~42자
  - 화면은 3줄까지 그린다. 단계 이름이 상자에 안 들어가 두 줄이 되어도 설명은 3줄까지(상자가 15 px 늘어남). 이름 한 줄은 한글 약 9자와 띄어쓰기 3칸까지
- `check` 의 `(n줄)` 이 1이면 늘리고, 4 이상이면 줄인다

## 작은 저장소 예외

- 하한 = min(위 하한, 실제 수). 실제 수는 `inventory.json` 에서 센다
  - 영역 min(5, 구성요소 수), 상자 min(20, 구성요소 수)
  - 흐름 min(2, 흐름 수), 흐름당 단계 min(7, 그 흐름 `steps`)
  - 연결 min(15, `arch.json` 에 그린 상자 수 - 1). 구성요소 수가 아니라 실제로 그린 `nodes` 수다
- `inventory.json` 의 `path`, `evidence` 가 저장소에 없으면 FAIL. 수를 줄여 하한을 피하지 못한다
- `inventory.json` 이 없으면 위 하한을 그대로 쓴다
- 예외는 숫자 하한에만 쓴다. 상자 설명 줄 수, 근거, 분기, 비고 같은 꼴은 작아도 같다

## 읽기 예산

| 순서 | 읽을 것 | 상한 |
|---|---|---|
| 1 | README, 기여 안내, 패키지 매니페스트(`package.json`, `pyproject.toml` 등), CI 설정 | 전부 |
| 2 | 폴더 목록 깊이 2(`node_modules`, `.git`, 빌드 산출물 제외) | 전부 |
| 3 | 진입점과 최상위 모듈의 주 파일 | 20개 |
| 4 | 명령, 스크립트, 빌드와 배포 정의(`scripts`, `Makefile`, `*.cmd`, 워크플로 YAML) | 15개 |
| 5 | 연결 근거 `파일:줄` 을 얻기 위한 검색(import, 호출, 설정 키) | 검색 결과 줄만 |
| 6 | 시험 폴더 목록과 시험 이름 | 목록만 |
| 7 | `git log --oneline -200` | 1회 |

- 합계 상한: 파일 60개 또는 600 KB. 넘으면 최상위 폴더 단위로 대표 파일만 읽고 `inventory.json` 에 그 폴더를 구성요소 하나로 적는다
- 상한에 드는 것과 들지 않는 것

  | 읽은 꼴 | 파일 수 | 바이트 | `read` 에 적음 |
  |---|---|---|---|
  | 파일 전체를 엶 | 1 | 파일 크기 | 예 |
  | 파일 일부(줄 범위)를 엶 | 1 | 실제로 읽은 부분 | 예 |
  | 검색 결과 줄(순서 5) | 안 듦 | 안 듦 | 아니오 |
  | 폴더 목록, 시험 이름 목록, `git log`(순서 2, 6, 7) | 안 듦 | 안 듦 | 아니오 |

- 같은 파일을 여러 번 열어도 파일 수는 1. 바이트는 읽은 부분을 모두 더한다
- 읽은 파일(전체와 일부)은 모두 `inventory.json` 의 `read` 에 적는다
- 비밀값 파일(`.env`, 키 파일, 크레덴셜)은 읽지 않는다. 자료에 값을 옮기지 않는다

## 크기 상한

| 항목 | 상한 | 넘으면 |
|---|---|---|
| workflow 흐름 | 6 | `check` WARN |
| 흐름당 단계 | 15 | WARN |
| 구성도 상자 | 60 | WARN |
| 구성도 연결 | 60 | WARN |

- 넘을 것 같으면 흐름을 나누지 말고 묶는다(비슷한 단계 합치기, 보조 구성요소를 칩 `items` 로)

## 자료 없음 탈출구

- 3회 고친 뒤에도 FAIL 이 남는 탭은 그 탭 파일만 지운다. 화면은 "자료 없음" 과 스키마 문서 경로를 보인다
- 근거가 없어 쓸 수 없는 탭은 처음부터 쓰지 않는다. 지어내지 않는다
- 구현요건 탭의 요구 원문은 아래 순서로 찾는다. 앞 순서에 있으면 뒤 순서는 쓰지 않는다

  | 순서 | 원문 출처 | `source` 예 |
  |---|---|---|
  | 1 | 요구 문서, 명세, 이슈, 설계 문서 | `docs/spec.md:10-24` |
  | 2 | README 의 기능 목록, 사용법 절 | `README.md:31-38` |
  | 3 | 명령 도움말 문구, 패키지 매니페스트 `description`, 진입점 머리 주석 | `src/cli.js:5-20` |

  - 셋 모두 없으면 `req-spec.json`, `reqs.json` 을 쓰지 않는다(구현요건 탭 "자료 없음")
  - 코드와 시험은 요구 원문이 아니다. 명세의 판정 근거(`note`)로만 쓴다
- 사용자에게 남은 FAIL, 지운 탭, 밀도 미달 수치를 보고한다

## 좋은 예

아래는 실제 플러그인 코드베이스를 이 지침대로 쓴 자료에서 뽑은 것이다. 이 수준이 기준이다.

구성도 상자: 설명 2~3줄, 칩, 근거

```json
{ "id": "cc", "zone": "user", "label": "Claude Code", "kind": "런타임",
  "detail": "플러그인을 읽고 훅 이벤트를 보내며 Skill 도구로 SKILL.md 를 펼침",
  "items": ["훅 3종", "mods 2.1.289+"], "refs": ["hooks/hooks.json:3-60", "hooks/register.mjs:50-52"], "lines": 3 }
```

구성도 연결: 종류, 짧은 이름표, 설명, 근거

```json
{ "id": "e-setup", "from": "user", "to": "bankerjs", "kind": "control", "label": "banker setup",
  "detail": "npm 설치 뒤 setup 실행", "refs": ["README.md:198-199", "bin/banker.js:420-435"] }
```

구성도 범례: 주 흐름, 다른 길, 망에 닿는 곳, 문서와 다른 곳

```json
["요청 길(주황 굵은 선): 사용자, Claude Code, ultra-chain, ralph-qa, seat-run, 외부 LLM 차례. 이 차례로 상자가 빛남",
 "망에 닿는 것은 분리 실행한 업데이트 확인기, 외부 좌석, 유료 API 뿐",
 "문서와 다른 곳: README 훅 표에 progress-fallback 없음(README.md:236-240)"]
```

workflow 흐름: 제목에 시작과 끝, 설명 3문장

```json
{ "id": "skill", "title": "스킬 호출: /banker:ultra-chain 에서 최종 보고까지", "color": "#6a1b9a",
  "note": "/banker:ultra-chain <과제> 로 시작(skills/ultra-chain/SKILL.md:7). 단계마다 게이트를 지나야 다음 단계로 가고, 멈춤 조건이면 사유를 남기고 멈춤(SKILL.md:452-460). 실행 기록은 chain-ledger.mjs 가 events.jsonl 에 씀(SKILL.md:129-141)." }
```

workflow 단계, 분기, 외부

```json
{ "id": "c1", "label": "사전 점검", "detail": "저장소 루트, 작업 트리, OMC 판, 박스 접속, 브라우저를 확인해 기록",
  "actor": "ultra-chain SKILL.md", "refs": ["skills/ultra-chain/SKILL.md:166-189"] }
{ "from": "c1", "to": "", "when": "루트 아님: 멈춤", "note": "세션이 저장소 루트가 아니면 멈춤 (skills/ultra-chain/SKILL.md:168)" }
{ "id": "x2", "label": "test-boxes", "linkTo": "c1", "note": "remains 의 boxes.mjs probe (SKILL.md:96, 181-183)" }
```

구현요건: 요구 원문과 출처, 명세마다 AC 와 근거

```json
{ "text": "Claude Code 마켓플레이스 두 줄로 설치", "source": "README.md:31-38",
  "specs": [
    { "text": "/plugin marketplace add 와 /plugin install 로 설치", "acs": ["AC-1"], "note": "README.md:31-32, .claude-plugin/marketplace.json:9" },
    { "text": "plugin.json 판이 단일 원천. sync-version 이 전파하고 --check 가 어긋남을 막음", "acs": ["AC-4"], "note": "scripts/sync-version.js:24-45, package.json:10" } ] }
```

진척도 비고와 문제점(`note` 명령 또는 `item --note --issue`)

```json
{ "B6": { "note": "0.8.0 opt-in 초안을 업데이트 알림과 기본 켜짐 카운팅으로 재구성. 0.9.0 개인화 알림",
          "issue": "hooks.json:2 설명은 엔드포인트 없으면 무동작이라 하나 기본 엔드포인트가 있음(telemetry-config.mjs:214)" } }
```

## 나쁜 예

| 나쁜 예 | 고칠 점 |
|---|---|
| `"detail": "서버"` | 무엇을 받고 무엇을 내는지 2~3줄 |
| 연결에 `refs` 없음 | import 나 호출 위치 `파일:줄` |
| 흐름 `note` 한 문장 | 시작 명령, 실패 처리, 근거 3문장 |
| 분기 없는 흐름 | 실제 실패 경로(종료 코드, 재시도, 멈춤)를 찾아 적음 |
| 분기 `when` 이 긴 문장 | 표는 짧게(`설정 없음: 멈춤`), 근거는 `note` |
| 명세 `state: "done"` 에 `note` 없음 | 확인한 시험이나 코드 위치 |
