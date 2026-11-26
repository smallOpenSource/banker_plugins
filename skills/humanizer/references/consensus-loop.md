# 윤문 합의 루프

어색한 문장 때문에 생기는 AI 티를 고친다. 한 모델이 혼자 판단해 고치지 않는다. 서로의 결과를 보지 않는 좌석들의 다수결로 고친다.
같은 형식의 루프를 `presentation-graphic-gen` 의 한국어 다듬기(`references/polish-loop.md`)도 쓴다. 두 스킬의 `consensus.mjs`, `apply-fix.mjs` 는 같은 파일이다(정본은 humanizer).

## 좌석

- 한 회차에 제안 좌석 3개, 투표 좌석 3개. 투표 좌석은 제안 좌석과 다른 새 좌석이다. 늘릴 수 있다(각 3개 이상).
- 좌석은 서로의 결과와 이 대화를 보지 않는다. 지시와 파일 경로만 받는다.
- 좌석은 작은 모델이고 노력은 `medium`, `low`, `none` 가운데 하나다. `seats.json` 이 다른 값을 거부한다.

| 좌석 | Claude Code | Codex |
|---|---|---|
| p1, v1 | `sonnet`, `medium` | luna, `medium` |
| p2, v2 | `haiku`, `medium` | luna, `low` |
| p3, v3 | `sonnet`, `low` | luna, `low` |

- Claude Code 의 노력에는 `none` 이 없다(`low` 가 가장 낮다).
- Codex 의 luna 는 `codex debug models` 에 있는 id 를 쓴다. `gpt-5.6-luna` 를 먼저, 없으면 `gpt-6-luna`. 그 모델의 노력 목록에 `none` 이 있을 때만 `none` 을 쓸 수 있다.

### 띄우는 방법

| 런타임 | 좌석 하나 |
|---|---|
| Claude Code | `Agent` 도구. `subagent_type: "Plan"`(읽기 전용 도구), `model` 에 `sonnet` 이나 `haiku`, `effort` 에 `medium` 이나 `low`, `prompt` 에 아래 좌석 지시. 한 회차의 좌석 3개는 한 메시지에서 함께 띄운다 |
| Codex | `spawn_agent` 를 `agent_type` 없이, `model` 에 luna id, `reasoning_effort` 에 노력, `message` 에 좌석 지시. 이 대화는 넘기지 않는다: multi-agent v2 는 `fork_turns: "none"`(이 값이 있어야 `model` 과 `reasoning_effort` 를 받음), v1 은 `fork_context` 를 주지 않는다. `wait_agent` 로 답을 받고 `close_agent` 로 닫는다 |
| Codex, `spawn_agent` 가 없을 때 | 좌석마다 `codex exec -m <luna id> -c model_reasoning_effort=<노력> -s read-only --skip-git-repo-check - < <지시 파일>`. 표준 입력으로 지시를 넘긴다(PowerShell: `Get-Content -Raw <지시 파일> \| codex exec ... -`). 샌드박스 안이면 `sandbox_permissions: "require_escalated"` 로 승인을 청한다 |

- 좌석의 답은 그대로 `<회차 폴더>/<좌석>.md` 에 쓴다(Claude Code 는 `Write`, Codex 는 `apply_patch`). 고치거나 줄이지 않는다.
- 좌석이 파일을 고쳤으면(원문이 바뀜) 그 회차를 버리고 다시 한다.

## 작업 폴더

```text
<작업 폴더>/
  text.<확장자>    다듬는 글 <T>(원본의 사본. 일반 텍스트 파일과 붙여 넣은 글은 text.md)
  seats.json       좌석 표
  decided.json     지금까지의 채택과 기각(tally 가 씀)
  round-01/        p1.md p2.md p3.md candidates.json v1.md v2.md v3.md accepted.json round.json
  round-02/ ...
```

`seats.json`:

```json
{ "scope": "full",
  "proposers": [{ "seat": "p1", "model": "sonnet", "effort": "medium" }, { "seat": "p2", "model": "haiku", "effort": "medium" }, { "seat": "p3", "model": "sonnet", "effort": "low" }],
  "voters":    [{ "seat": "v1", "model": "sonnet", "effort": "medium" }, { "seat": "v2", "model": "haiku", "effort": "medium" }, { "seat": "v3", "model": "sonnet", "effort": "low" }] }
```

## 한 회차

`C="<S>/scripts/consensus.mjs"`, `W=<작업 폴더>`, `R=$W/round-NN`.

1. 제안: 제안 좌석 3개를 띄운다. 답을 `$R/p1.md` 등에 쓴다.
2. 모으기: `node "$C" merge "$R" --root "$W"`. 같은 `from` 은 한 후보로 합치고, `to` 가 여럿이면 모두 후보의 안으로 둔다. 아래는 까닭과 함께 버린다(`DROP` 줄).
   - `from` 이 글에 정확히 한 번 나오지 않음
   - 앞 회차에 결정됨, 또는 앞 회차의 채택을 되돌림
   - 보호 글을 건드림: 코드 펜스, 인라인 코드, URL, 경로, `--플래그`, 숫자, 인용(코드 파일 밖). 보호 글은 바꾸지 않고 그대로 옮겨야 한다
3. 투표: `candidates.json` 의 후보가 있으면 투표 좌석 3개를 띄운다. 답을 `$R/v1.md` 등에 쓴다. 후보가 0건이면 투표하지 않는다.
4. 결정과 적용: `node "$C" tally "$R" --root "$W" --apply --dry-run` 으로 본 뒤 `--dry-run` 없이 한 번 더.
   - 센 투표 좌석의 과반(3표 중 2표), 그리고 2표 이상이 `accept` 면 채택. 그 밖은 기각.
   - 채택한 글은 채택표의 `preferredTo` 가운데 가장 많은 안(같으면 먼저 나온 안).
   - 같은 자리에 겹치는 채택은 `accept` 가 많은 쪽(같으면 낮은 id)만 남고, 다른 쪽은 보류(`deferred`)다. 보류는 결정 목록에 넣지 않아 다음 회차에 다시 나올 수 있다.
   - 합의가 틀린 사실을 바탕으로 하면(원문에 없는 글을 있다고 봄, 문법 규칙을 잘못 앎) 적용 전에 멈추고 그 후보를 `accepted.json` 에서 빼고 `apply-fix.mjs` 로 따로 적용한다. 그 까닭을 보고에 적는다. 그 밖의 이유로 합의를 뒤집지 않는다.
5. 좌석을 세지 않는 경우: 답에 JSON 배열이 없음, `MODEL:` 줄이 `seats.json` 과 다른 모델 계열(예: `haiku` 좌석이 `sonnet` 이라 답함). 센 좌석이 3개보다 적으면 `merge`, `tally` 가 종료 1 과 다시 띄울 좌석 이름을 낸다. 그 좌석만 다시 띄워 답을 덮어쓴 뒤 같은 명령을 다시 돌린다.

## 끝

- 글 전체를 본 회차의 새 합의(`newConsensus`)가 0건이면 끝난다. 그 0건 회차의 `round.json` 도 남긴다(증거).
- 회차 상한은 5. 5회차에도 새 합의가 있으면 멈추고 그 사실을 보고한다.

## 좌석 지시(그대로 씀)

`<언어 이름>` 은 `lang.mjs` 의 `name`(`und` 이면 "이 글의 언어(스스로 판정)"), `<기준>` 은 그 언어의 기준 파일 절대 경로다(`criteria-ko.md`, `patterns-en.md`, `criteria-general.md`). 글이 두 언어로 섞였으면(`mixed`) 두 기준 파일을 모두 주고 "문장마다 그 문장의 언어 기준으로" 를 덧붙인다.

제안 좌석:

```text
너는 <언어 이름> 원어민 편집자다. 이 파일을 직접 읽어라: <T>. 기준: <기준>.
어색한 문장 때문에 AI 가 쓴 티가 나는 곳만 고쳐라. 자연스러운 문장은 그대로 둬라.
뜻, 사실, 수치를 바꾸지 마라. 내용을 더하거나 빼지 마라. 코드, 명령, 경로, 숫자, 인용은 원문 그대로 둬라.
<W>/decided.json 이 있으면 읽어라. 거기 있는 from 은 다시 내지 마라.
파일을 고치지 마라. 결과는 JSON 배열 하나만: [{"file":"<T 의 파일 이름>","from":"...","to":"...","kind":"...","reason":"한 줄"}].
from 은 원문에서 정확히 한 번 나오는 부분이다. 짧게 잡되 한 번만 나오게 앞뒤 글자를 붙여라. kind 는 기준 파일의 이름을 쓴다.
고칠 것이 없으면 []. 맨 끝 줄에 MODEL: <너의 모델 id> 를 써라.
```

투표 좌석:

```text
너는 <언어 이름> 원어민 교열 심사 위원이다. 원문 <T> 와 후보 <R>/candidates.json 을 직접 읽어라. 기준: <기준>.
candidates 의 후보마다 원문의 앞뒤를 보고 판단하라. to 는 고친 글의 안들이다.
뜻이 바뀌거나, 내용이 더해지거나 빠지거나, 원문보다 어색하면 reject. 더 자연스럽고 뜻이 같으면 accept.
accept 이고 안이 여럿이면 preferredTo 에 고른 안을 글자 그대로 옮겨라.
파일을 고치지 마라. 결과는 JSON 배열 하나만, 후보마다 한 줄: [{"id":1,"vote":"accept","preferredTo":"...","reason":"한 줄"}].
맨 끝 줄에 MODEL: <너의 모델 id> 를 써라.
```

## 기록과 보고

- `round.json`: 회차, 좌석마다 지정한 모델과 노력, 좌석이 밝힌 모델(`reported`), 센 좌석인지, 후보마다 표와 결정과 채택한 글, 버린 제안과 까닭, 적용 수와 SKIP, 새 합의 수.
- 보고: 언어와 기준, 좌석 표(모델, 노력, 밝힌 모델), 회차 수, 회차별 제안, 후보, 채택, 기각, 보류, SKIP 수, 사실 오류로 뺀 합의와 까닭, 마지막 0건 회차의 `round.json` 경로, 상한에 걸렸으면 그 사실.
