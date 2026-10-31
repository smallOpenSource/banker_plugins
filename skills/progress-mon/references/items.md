# items.json 과 진척도 탭

진척도 탭의 수동 기록. `item`, `note`, `stage`, `story` 명령만 쓴다. 손으로 고치지 않는다.

## 스키마

```json
{
  "notes": { "stage:build": { "note": "근거 커밋 1a2b3c4", "issue": "" }, "A1": { "note": "시험 12건 통과" } },
  "items": [
    { "key": "docs-1", "t": "2026-10-29T03:00:00Z", "s": "2026-10-29T01:00:00Z", "status": "done", "text": "설치 문서 갱신", "note": "README.md 3절", "issue": "", "hash": "5d6e7f8" }
  ],
  "storyCommits": { "A2": { "hash": "9f8e7d6", "t": "2026-10-29T02:00:00Z", "name": "설정 읽기" } },
  "storyStates": { "A3": { "status": "doing", "t": "2026-10-29T02:30:00Z" } },
  "stageEvents": [ { "t": "2026-10-29T00:00:00Z", "stage": "build", "status": "started" } ]
}
```

| 키 | 형식 | 쓰는 명령 |
|---|---|---|
| `notes` | `{<key>: {note?, issue?}}`. key 는 `stage:<단계 id>` 또는 스토리 id | `note` |
| `items` | `[{key, t, s?, status, text, note?, issue?, hash?}]`. `status` 는 `todo`, `doing`, `done`. `s` 는 시작 시각(doing 으로 기록한 시각), `hash` 는 커밋 해시 | `item` |
| `storyCommits` | `{<스토리 id>: {hash, t, name?}}`. 문자열 해시만 있어도 읽음. 진척도 표 commit Hash 칸의 유일한 수동 출처 | `story --commit` |
| `storyStates` | `{<스토리 id>: {status, t, name?}}`. `status` 는 `todo`, `doing`, `done` | `story --status` |
| `stageEvents` | `[{t, stage, status, label?}]`. `status` 는 `started`, `done`, `skipped`, `failed`, `stopped` | `stage` |

- 모르는 키는 그대로 둔다

## 명령

| 명령 | 동작 |
|---|---|
| `item --key <k> --status <s> --text <t> [--note <t>] [--issue <t>] [--at <ISO>] [--commit <hash>]` | 같은 key 는 대체하고 시작 시각 `s` 는 유지. 새 key 는 끝에 추가. `s` 는 `doing` 으로 기록할 때만 정함(처음부터 `done`, `todo` 면 없음). `--at` 이 있으면 지금 대신 그 시각을 `t` 로(`doing` 이면 `s` 도). `--commit` 은 4~40자 16진 해시를 `hash` 에. `--commit` 이 없으면 있던 `hash` 를 유지 |
| `note --key <k> [--note <t>] [--issue <t>]` | 그 key 의 칸만 대체. 빈 값(`--issue ""`)은 그 칸을 지움 |
| `stage --id <id> --status <s> [--label <t>]` | `stageEvents` 에 한 줄 추가. 설정에 없는 id 는 새 단계 행(이름은 `--label` 또는 id) |
| `story --id <id> --status <s> [--name <t>]` | `storyStates` 의 그 id 를 대체 |
| `story --id <id> --commit <hash> [--name <t>]` | `storyCommits` 의 그 id 를 대체. 해시는 4~40자 16진. 제목에 id 가 없는 커밋을 스토리 완료로 셈 |

- 쓰기는 잠금(`items.json.lock`) 안에서 다시 읽고 바꾼 칸만 고친 뒤 임시 파일에 써서 rename 한다. 성공한 쓰기는 모두 남는다. 경쟁이 매우 심하면 일부 쓰기가 최대 5초 기다린 뒤 잠금 메시지와 함께 종료 1 할 수 있다(다시 실행)
- 잠금이 5초 안에 풀리지 않으면 종료 1. 출력에 잠금 경로, pid, createdAt 이 나온다. 그 프로세스가 끝났는데 남아 있으면 잠금 파일을 지운 뒤 다시 실행
- 기록된 pid 가 죽었고 createdAt 이 5초보다 오래된 잠금은 스스로 정리한다. 정리는 정리 잠금(`items.json.lock.break`)을 쥔 프로세스 하나만 하고, 처음 본 잠금과 pid, 무작위 값, createdAt 이 같을 때만 지운다

## 시각

- 새로 쓰는 시각(`t`, `s`)은 Z 붙은 UTC ISO 8601 `YYYY-MM-DDTHH:MM:SSZ`
- `s` 는 항목이 `doing` 이 된 시각. 이미 있으면 바꾸지 않는다. `s` 가 없는 항목(처음부터 `done` 이나 `todo`)은 소요시간이 "-"
- 옛 판이 쓴 자료에는 `s` 와 `t` 가 같은 `done` 항목이 있다(처음부터 `done` 으로 기록한 항목). 이 줄은 소요시간이 "0:00" 으로 보인다. "-" 로 보이게 하려면 그 항목의 `s` 를 지운다
- `item --at <ISO>`: 날짜, 시각, 시간대(`Z` 또는 `+09:00`)가 모두 있어야 한다(예 `2026-10-20T12:34:56+09:00`, 초는 선택). 그 밖은 종료 1. 지난 커밋은 `git log --format=%cI` 의 커밋 시각을 그대로 넘긴다. 저장은 위 UTC Z 형식
- `item --commit <hash>`: 4~40자 16진 해시. 그 밖은 종료 1. 손으로 쓴 `hash` 가 이 꼴이 아니면 `check` 가 FAIL. 지난 커밋은 `git log --format=%h` 의 해시를 함께 넘긴다(`--at <%cI> --commit <%h>`)
- Z 없는 19자 옛 형식(`YYYY-MM-DDTHH:MM:SS`)은 서버를 실행한 환경의 현지 시각으로 읽는다(옛 진척도 서버와 같음). 옛 자료에는 UTC 값을 Z 없이 쓴 줄도 섞여 있다. 그 줄도 현지로 읽어 옛 화면과 같은 시각을 낸다(시차만큼 이르게 보임)
- Z 나 시차(`+09:00`)가 붙은 시각은 그 값 그대로 읽는다
- 손으로 적을 때는 Z 를 붙여 UTC 로 적거나 시차를 붙인다. Z 없는 19자는 서버 시간대가 바뀌면 다른 시각이 된다
- 화면 표시는 서버를 실행한 환경의 시간대

## 진척도 탭 판정

| 행 | 상태 |
|---|---|
| 단계 | events 출처와 `stageEvents` 를 시각 순으로 합침. 단계마다 마지막 기록이 상태(완료 뒤 다시 `started` 면 진행 중). `started` 진행 중, `done`, `skipped` 완료, `failed`, `stopped` 진행 중(비고 "멈춤"), 기록 없음 예정 |
| 스토리 | 커밋(제목 판정 또는 `storyCommits`) 있으면 완료, 없으면 `storyStates`, 없으면 진행 중 에이전트가 있으면 진행 중, 그 밖 예정 |
| 에이전트 | 워크플로 journal 에서 끝나지 않은 에이전트. 스토리로 잡힌 라벨은 숨김(`references/config.md`) |
| 기타 | `items` 그대로. 소요시간은 `s` 가 있을 때만(`doing` 은 지금까지, `done` 은 `t` 까지) |

- 진척률: 완료 스토리 수 / 스토리 수(`스토리 n/m 완료 (p%)` 와 막대). `storyStates` 의 `done` 도 완료
- 스토리가 없으면 단계 행과 기타 행으로 센다(`항목 n/m 완료 (p%)` 와 막대). 에이전트 행은 세지 않는다
- 표에 그릴 행(단계, 스토리, 기타 항목)이 하나도 없을 때만 "단계와 스토리 기록 없음" 안내 한 줄. 기록이 없는 까닭(events.jsonl 없음, stories 비어 있음)과 기록 명령(`stage`, `story`, `item`)을 적는다
- 소요시간이 모두 "-" 이면 그 열 머리글을 꺾지 않는다(좁은 칸에서 한 글자씩 꺾이지 않게)
- 스토리와 단계가 모두 없으면 표 전체에서 한글 낱말 가운데를 꺾지 않는다(공백에서만 줄 바꿈). 내용 칸이 좁아져도 "작성" 이 "작/성" 으로 나뉘지 않게
- 표 열: 순번, 시각, 소요시간, 상태, 내용, commit Hash, 문제점, 비고. 문제점은 `issue`, 비고는 `note`
- commit Hash 칸: 스토리 행은 완료 커밋(커밋 제목 판정 또는 `storyCommits`), 기타 행은 `hash`(`item --commit`)의 앞 7자리. 단계, 에이전트 행은 늘 빈칸. `notes` 에는 해시 칸이 없다

## events.jsonl(ultra-chain 실행 기록)

한 줄에 하나: `{"t":"2026-10-28T00:00:00Z","stage":"research","status":"started"}`. `status` 는 `stage` 명령과 같은 값. 깨진 줄은 건너뛴다.
