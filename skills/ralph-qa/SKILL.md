---
name: ralph-qa
description: "(banker) 작업 결과를 자기채점하지 않게 독립 검증/개선 반복: 다중 에이전트 백본이 가장 강한 가용 모델로 항상 돌고, 실제로 유효한 외부 LLM(Codex CLI·Gemini CLI·GPT/Gemini API)만 추가 좌석으로 합류한다. 'ralph-qa'/'교차검증'/'다른 LLM으로 검증'/'독립 QA' 시 사용."
---

# ralph-qa — 독립 검증 루프 (백본 + 좌석)

방금 만든 결과를 **같은 세션이 자기채점**하는 대신, 독립 좌석들에 넘겨
`ralplan --deliberate`(설계 최적성)와 `ralph --critic=critic`(수용 기준) 로직을 적용하고,
지적을 반영해 **APPROVE까지 반복**한다.

**구성.** 다중 에이전트 **백본이 조건 없이 항상 돈다**. 여기에 실제 유효성이 관측된 외부 LLM 이 **각 1좌석**으로 합류한다.
용어: 외부 좌석의 부재는 실패도 열화도 아니다 — 그 축이 이번 실행에서 안 덮였다는 커버리지 사실일 뿐이다.

## 언제 쓰나
- 방금 완성한 구현/설계/문서를 **배포·확정 전** 독립 검증하고 싶을 때.
- ralph/all-in-one이 끝난 뒤 **다른 시각**으로 한 번 더 거르고 싶을 때.
- 되돌리기 어렵거나 파급 큰 산출물(마이그레이션·공개 API·배포물).

## 쓰지 않을 때
- 사소한 변경(왕복 비용이 이득을 초과).
- 수용 기준을 세울 수 없는 대상("잘 됐나?"는 검증 대상이 아니다).

## 독립성 3축

| 축 | 무엇을 제거하나 | 백본 일반 좌석 | 출처-독립 좌석 | 외부 좌석 |
|---|---|---|---|---|
| **컨텍스트-독립** | 저자 세션의 앵커링·매몰비용 | ◐ 계약상 성립(관측 불가) | ◐ | ◐ |
| **프레이밍-독립** | 저자가 고른 기준·증거·프롬프트 | ❌ 미확보 | ✅ 확보 | ❌ 미확보 |
| **모델-독립** | 베이스 모델 고유의 체계적 맹점 | ❌ 미확보 | ❌ 미확보 | ✅ 확보 |

`◐` = 계약상 성립하되 **관측 불가**. 서브에이전트가 저자 컨텍스트를 실제로 안 보는지는 하네스 내부 동작이라 이 스킬이 관측할 수 없다.
외부 좌석도 페이로드를 **저자가 구성**하므로 컨텍스트 배제는 저자 준수에 의존한다.

## 검증자 구성

- **백본**: 서브에이전트 `N`개(`--agents`, 기본 3). 렌즈를 나눠 배정한다 — ① 설계 최적성 ② 수용 기준 ③ 적대적 반증.
  - **모델은 선호 순서로 내려간다.** ① Opus 계열 최신 → ② 그게 없으면 **가용한 것 중 가장 적합한 추론 모델** → ③ 그마저 없으면 기본값. 이건 실제로 고를 수 있다(Agent 도구 `model`).
  - **추론 강도는 고르는 것이 아니라 물려받는 것이다.** 세션 설정이 지배하고 이 스킬에는 손잡이가 없다. 최대 강도로 검증받고 싶으면 **호출 전에 세션 강도를 올려라.**
  - 어느 단계로 갔든 **실제로 쓴 모델과 물려받은 강도를 보고의 선언 블록에 적는다.** 목표를 적고 실제를 감추는 것이 이 스킬에서 가장 나쁜 실패다.
- **출처-독립 좌석**: 백본 중 **최소 1개**. `N ≥ 1` 이면 항상 1개 이상 존재한다.
- **외부 좌석**: `external:api:<model>` · `external:codex` · `external:gemini`(CLI) · `external:gemini-api`(크리덴셜). **유효성이 관측된 것만** 착석한다.
  - **CLI 경로와 크리덴셜 경로는 별개 좌석이다.** CLI 부재가 크리덴셜 경로를 가리면 안 된다 — 유효한 키가 있는데 "CLI 가 없어서 못 썼다"고 보고하는 것은 허위 커버리지다.
  - **외부 좌석끼리도 같은 모델이면 안 된다.** codex 좌석이 함께 서면 api 좌석은 **codex 가 돌릴 모델의 계열을 피해서** 고른다. 저자의 codex 설정이 api 좌석의 선호 모델 출처이기도 해서, 그대로 두면 좌석은 2인데 모델 축에서는 하나가 된다 — 승인 게이트가 넓어지지는 않지만 보고의 "외부 2" 가 실제보다 독립적으로 읽힌다.
    회피 사다리는 **다른 계열 → 같은 계열의 다른 모델 → 같은 모델** 이고, 프로브가 내려간 단계를 `modelPick` 으로 돌려준다. codex 의 모델을 확인하지 못하면 fail-closed 로 codex 런타임 계열을 피한다.

## 유효성 판정

유효성 판정은 `references/verifier-probe.mjs` 가 한다(0토큰 HTTP 프리플라이트). 판정 근거는 그 출력이다.

**무엇이 어디로 나가는지 먼저 밝힌다.** 프로브는 프로바이더의 **모델 목록 GET** 만 낸다 — 작업 내용·프롬프트·코드는 나가지 않고, 나가는 것은 인증 헤더뿐이다.
목적지는 설정에서 해석한 base URL 이고, base URL 을 못 찾으면 **키 env 이름이 지목하는 표준 벤더 엔드포인트로 내려간다.** 이 경우 `source` 가 `default:*` 로 표시되고 `notes` 에 사유가 남는다.
- 이 내려감이 싫으면 `RALPH_QA_NO_DEFAULT_ENDPOINT` 를 설정한다. 그러면 목적지가 없어 좌석이 서지 않고, 보고 사유는 `default-endpoint-off` 다(원인이 저자 설정이므로 환경 계열로 분류하지 않는다).
- `--external=off` 는 **HTTP 를 한 건도 내지 않는다.** 정적 탐지까지만 하고 멈춘다.

| 프로브 출력 필드 | 뜻 | 좌석에 미치는 영향 |
|---|---|---|
| `observed.api.status` | provider `GET /models` 응답 코드 | 2xx 만 착석 |
| `observed.api.live` + `reason` | 생존 판정 | `dead-credential`(401/403)·`unreachable`·`timeout` 이면 미착석 |
| `observed.transport` | 외부 호출이 나갈 경로 `curl`\|`python3`\|`none` | `none` 이면 api 좌석 무효(`no-transport`) |
| `observed.candidates` / `unclassified` | 저자 계열을 뺀 후보 / fail-closed 로 제외된 미분류 수 | 후보 0 이면 `no-independent-model` |
| `declared.seats.external[].modelPick` | api 좌석이 codex 회피 사다리의 어느 단으로 앉았는지 — `unconstrained`(codex 좌석 없음) \| `independent-family` \| `same-family-different-model` \| `same-model` | 좌석 수는 안 바뀌고 **보고 문구가 바뀐다** |
| `observed.cli.gemini.liveChecked` | **항상 `false`** | gemini 는 첫 호출이 곧 프로브 |

gemini **CLI** 좌석은 프로브가 `G0 → G1 → (G2 없음) → G3` 사다리의 G0·G1 까지만 판정하고 `liveChecked:false` 다. 첫 검증 호출이 곧 프로브이며 실패는 미착석이다(미검증 경로).
이 사다리는 `T0~T4` 와 **비대칭**이다 — (i) 인증 출처가 다르고(프로바이더 env → 자체 인증), (ii) OpenAI 호환 `/models` 가 없어 계열 필터를 못 돌리며, (iii) 그래서 "저자 계열 배제"를 카탈로그로 강제하지 못하고 CLI 자체가 다른 벤더라는 사실에 의존한다.

gemini **크리덴셜** 좌석은 이와 별개로 판정한다. CLI 가 없어도 인증 env 가 있으면 자체 모델 목록 GET 으로 0토큰 생존 판정을 하고 착석한다.
**크리덴셜이 있으면 사유 토큰 `cli-absent` 를 쓰지 않는다** — 생존 판정 실패는 `probe-unseated status=<code>`, 전송 수단 부재는 `no-transport` 다. `cli-absent` 는 CLI 도 크리덴셜도 없을 때만 쓴다.

`transport` 가 `python3` 이면 외부 호출은 3.6 호환 부분집합으로 낸다(`urllib.request`·`json`·f-string 까지만):

```python
import json, urllib.request
req = urllib.request.Request(
    endpoint, method="POST",
    headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    data=json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}]}).encode())
with urllib.request.urlopen(req, timeout=120) as r:
    print(json.load(r)["choices"][0]["message"]["content"])
```

위 형태는 **OpenAI 호환 좌석(`external:api`)** 용이다. `external:gemini-api` 는 요청·응답 스키마가 다르므로 같은 본문을 재사용하지 마라 — 엔드포인트·인증 위치·응답 경로를 그 벤더 규격대로 맞춘다.

## 정족수

```
좌석 판정 정의역: {APPROVE, ITERATE, REJECT, ERROR}
  · 외부 좌석은 단독 줄 `VERDICT: <값>` 필수. 부재·중복·절단·파싱실패·거부 = ERROR
  · ERROR = 좌석 유지 + APPROVE 차단 (드롭 금지)

좌석 식별자: (종류, 렌즈)
  · 종류 ∈ {backbone#i, backbone-si#i, external:api:<model>, external:codex,
             external:gemini, external:gemini-api}
  · 반복 k 의 식별자 집합 S_k 에 대해 S_k ⊆ S_{k+1} 이어야 한다
  · S_k \ S_{k+1} ≠ ∅  =  좌석 상실 (원인 불문 — T4 강등은 원인의 한 예시)
  · 같은 식별자로 다시 선 좌석 = 동일 계열 대체 좌석
    (끈끈한 반대의 유일한 해제 주체 → 좌석을 새로 굴려 반대를 지울 수 없다)
  · 백본 좌석의 blocker 도 좌석 재생성으로 소멸하지 않는다
  · 렌즈 재배정도 좌석 상실이다 — 렌즈를 바꾸려면 기존 좌석을 유지한 채 추가하라

APPROVE ⟺ (내부 좌석 ≥ 1)
        ∧ (내부 좌석의 과반이 APPROVE)
        ∧ (실증된 외부 비-APPROVE 0건)
        ∧ (미해소 blocker 0건 — 외부는 실증 필터를 통과한 것,
           백본은 전부. 좌석이 죽어도 유지되는 끈끈한 반대 포함)
        ∧ (이번 반복에 ERROR 좌석 0건)
        ∧ (이번 실행에 좌석 상실 0건 — 원인 불문)

  종결어:  APPROVE(3축)                       — 외부 좌석이 착석해 완주
           APPROVE(모델축 미커버 — 환경)       — 외부 0, 사유가 환경
           APPROVE(모델축 미커버 — 저자 요청)  — 외부 0, 사유가 저자 설정
                                                (--external=off · RALPH_QA_NO_DEFAULT_ENDPOINT)
           ※ 외부 0 이면 사유 토큰을 보고에 반드시 적는다
           ※ 종결어 분화를 소비하는 주체는 하류다 — 내부 게이트는 셋을 동일
             취급한다(셋 다 APPROVE). 목적은 게이트를 좁히는 것이 아니라 한 줄
             요약으로 인용될 때 무엇이 안 덮였는지가 살아남게 하는 것이다

INCONCLUSIVE ⟸ 좌석 상실 (원인 불문)
             ∨ 동일 좌석 ERROR 2연속
             ∨ 좌석 총합 0
             ∨ --max 소진 + 미해소 blocker 잔존

--max 소진은 항상 종결이다 (어느 갈래도 통과가 아니다)
  · 미해소 blocker 잔존          → INCONCLUSIVE
  · 그 외 미해결(내부 과반 미달)  → ITERATE(한도 소진) — 루프 재개 없음

조기 종결 (--max 소진 전)
  · 같은 이슈가 3회+ 재발        → INCONCLUSIVE + 사람 에스컬레이션

INCONCLUSIVE 소비 규칙 — 통과가 아니다
  · 배포·머지·릴리스 게이트를 통과시키지 않는다. APPROVE 취급 금지
  · 좌석 상실·ERROR 2연속 → 환경 복구 후 재실행
    (--external=off 로 우회하면 그 사실을 보고에 남긴다)
  · 좌석 총합 0          → --agents 확인 후 재실행
  · --max 소진           → 잔존 blocker 를 사람에게 에스컬레이션
  · 재실행해도 같은 INCONCLUSIVE → 사람의 명시적 판단을 요구하고 멈춘다

그 외 → ITERATE
```

## 런타임 대칭

무엇이 "다른 모델"인지는 저자 런타임마다 뒤집힌다.

| 저자 런타임 | 백본 | **자기 자신 — 외부 좌석 부적격** | 외부 좌석 후보 |
|---|---|---|---|
| **Claude Code (OMC)** | Agent/Task 서브에이전트 (모델은 선호 순서로 선택) | Claude 계열 전부 — `curl` 로 `claude-*` 호출 금지 | `external:codex` · `external:api`(비-Claude 계열) · `external:gemini`(CLI) · `external:gemini-api` |
| **Codex CLI (OMX)** | OMX 서브에이전트 (동일) | **GPT 계열 전부 — `codex exec` 는 자기 자신이라 외부 좌석 부적격** | `omx $ask claude` · `external:api`(비-GPT 계열) · `external:gemini`(CLI) · `external:gemini-api` |

## 플래그

| 플래그 | 적용 좌석 | 효과 | 기본 | 전송 경로 | 확인 수준 |
|---|---|---|---|---|---|
| `--agents=N` | 백본 | 내부 좌석 수 (N≥1). 그중 최소 1개가 출처-독립 좌석. 좌석 식별자는 반복 간 유지 — 하향은 좌석 상실 | 3 | Agent 도구 `model` (선호 순서로 선택) | 모델 전달 확인 / **강도는 선택만, 지정 아님** |
| `--external=auto\|off` | 외부 | auto=유효하면 합류 / off=강제 미사용(HTTP 0건). 0이면 사유 토큰을 보고에 강제 | auto | api·codex·gemini-api = 프로브 결과 게이트 · gemini(CLI) = G1 까지만 게이트, 첫 호출이 곧 프로브 | api·codex 전달 확인 · gemini-api 인증만 확인 / gemini(CLI) 미검증 |
| `--model <id>` | 외부 | 외부 모델 고정(미지정 시 계열 필터 + codex 회피가 자동 선택). **고정 값이 회피보다 우선** | 자동 | `curl`(없으면 `python3` urllib) body `model` · `codex exec -m` · `gemini -p`(모델 선택 문법 미검증) | api·codex 전달 확인 / gemini 미검증 |
| `--effort <v>` | **외부 전용 (api·codex)** | 추론 강도. 백본에는 전송 경로가 없다. gemini 좌석에도 전달하지 않는다 | 미지정 | curl `reasoning_effort` · `codex exec -c model_reasoning_effort=` · gemini = 전송 경로 없음 | **전송 확인 / 적용 미확인** |
| `--lens=critic\|plan\|both` | 전 좌석 | 적용 렌즈. 렌즈는 좌석 식별자의 구성요소다 | both | 프롬프트 | 전달 확인 |
| `--max=N` | 루프 | 최대 반복. 소진은 항상 종결이며 갈래가 둘이다 | 5 | — | — |

**외부 좌석 종류별:**

| 좌석 종류 | 유효성 사다리 | 전송 경로 | 확인 수준 |
|---|---|---|---|
| `external:api:<model>` | T0-b → T1 → T2 → T3 → T4 | `curl`(없으면 `python3` urllib, ≥3.6) | 실측 확인 |
| `external:codex` | T0 → T1 → T2 → T4 | `codex exec -m … -c model_reasoning_effort=…` | 실측 확인 |
| `external:gemini` | `G0 → G1 → (G2 없음) → G3` | `gemini -p "<프롬프트>"` | **미검증 — 실행 환경에 `gemini` 부재** |
| `external:gemini-api` | G1 → 모델목록 GET → T4 | `curl`(없으면 `python3` urllib) — **요청 형태가 OpenAI 호환이 아니다** | 인증 생존은 0토큰 판정 / 전송 형태는 미검증 |

## 워크플로

### 1. 입력 확보
검증 대상 = {작업 결과 + **수용 기준** + 변경 파일 목록 + 관련 코드}. 기준이 없으면 원 작업에서 도출한다.

**출처-독립 좌석은 저자가 쓴 요약을 받지 않는다.**
입력 = `git diff` 원문 + 사용자 원 요청 문장 **그대로** + 저장소의 기준 파일(SKILL.md·README·매니페스트).
지시 = "스스로 수용 기준을 도출하고, **저자가 주장한 기준과의 차이를 보고**하라." `--agents=1` 이면 그 단일 좌석이 출처-독립 좌석이다.
**이 좌석이 보고한 차이는 blocker 로 취급한다** — 저자가 기준에서 빠뜨린 요구가 곧 검증 공백이므로, 조언으로 흘리면 이 좌석을 두는 이유가 사라진다.

### 2. 좌석 착석
프로브를 **호출당 1회** 돌린다(루프 반복에서 재프로브 금지). 결과대로 외부 좌석을 착석시킨다.

**모델 부적격은 착석 전에만 갈아탈 수 있다.** 프로브의 `GET /models` 200 은 카탈로그 접근을 증명할 뿐 **그 모델의 호출 권한을 증명하지 않는다** — 계열 회피로 고른 모델이 첫 호출에서 권한·미존재로 거절될 수 있다(`404` · `400 model_not_found` · 배포 미존재).
그 경우 그 모델을 후보에서 빼고 **같은 사다리로 다음 후보에 좌석을 세운다.** 좌석 식별자가 아직 확정되지 않았으므로 좌석 상실이 아니다.
**확정 시점은 그 좌석이 첫 `VERDICT` 를 낸 때다.** 그 뒤의 실패는 갈아타기가 아니라 `ERROR` 이며, 모델을 바꾸면 식별자가 바뀌어 좌석 상실이 된다.
후보가 고갈되면 api 좌석은 미착석이고 사유는 `no-independent-model` 이다. 갈아탄 사실과 최종 모델은 보고에 적는다.
`--model` 로 고정하면 그 값이 계열 회피보다 우선한다 — codex 좌석과 겹치면 겹친다는 사실을 보고에 적는다.

### 3. 판정 수신
각 좌석에서 4값 중 하나를 받는다. 외부 좌석은 **단독 줄 `VERDICT: <값>`** 이 필수이며, 부재·중복·절단·파싱실패·거부는 `ERROR` 다.

**실증 필터(외부 좌석 전용).** 외부 비-APPROVE 가 거부권을 가지려면 구조화된 `blockers[]` 에 **실재하는 파일 경로 또는 제시된 수용 기준 ID** 를 인용한 항목이 최소 1개 있어야 한다. 확인은 기계적이며 사안의 옳고 그름이 아니라 **주장의 구체성**만 본다.
실증되지 않은 외부 반대는 `dissent-unsubstantiated` 로 원문 그대로 기록하되 교착시키지 않는다.

**적용 범위.** 거부권의 *제한*(실증 요구)은 **외부 좌석 전용**이고, blocker 의 *지속성*(끈끈한 반대)은 **전 좌석**에 적용된다.

### 4. 반영과 종료
`APPROVE` 가 아니면 이슈를 수정하고 **같은 좌석 구성으로** 재검증한다(2단계 반복, `S_k ⊆ S_{k+1}` 유지).
끈끈한 반대의 해제는 **그 blocker 를 낸 좌석(또는 동일 식별자의 대체 좌석)의 APPROVE 재투표**로만 된다 — 저자의 "고쳤다" 선언으로는 해제되지 않는다.
종결은 정족수 절의 3값(`APPROVE` · `ITERATE` · `INCONCLUSIVE`)과 그 소비 규칙을 따른다.

## 보고 계약

관측값과 선언값을 라벨로 나누고, 관측 블록은 **축약하지 않는다.**

**정상 — 외부 착석:**

```
프로브(관측): status=200 probeMs=1180 source=codex:azure transport=curl unclassified=3
후보(관측): <model-a>(gpt), <model-b>(llama) — claude 계열 0건 제외, unclassified 3건 제외
좌석(선언): 내부 3 (출처-독립 1 포함) / 외부 2 = api:<model-b>(modelPick=independent-family) · codex
            — authorFamily=claude(runtime)
백본(선언): model=<실제 쓴 모델> — 모델 선호 <1|2|3>순위 · strength=세션 상속(값을 알 수 없으면 "미상")
독립성 축: 컨텍스트 ◐ / 프레이밍 ✅ / 모델 ✅
판정: APPROVE(3축) — 내부 3/3, 외부 2/2, 미해소 blocker 0, ERROR 0, 좌석 상실 0
```

api 좌석과 codex 좌석이 함께 서면 좌석 줄에 **`modelPick=<값>` 을 적는다.** 값이 `independent-family` 가 아니면 두 좌석이 모델 축에서 겹친다는 사실을 한 줄 더 적는다 — 그 문장은 프로브의 `notes` 가 준다.
`<model-b>` 가 gpt 가 아닌 계열인 것은 예시가 아니라 규칙이다. codex 가 gpt 를 돌리므로 api 좌석은 그 계열을 피한 결과다.

**좌석 상실:**

```
좌석(선언): 반복 1 = {backbone#1(critic), backbone#2(plan), backbone-si#3(critic),
                      external:api:<model-a>}
            반복 2 = {backbone#1(critic), backbone#2(plan)}
                     ← backbone-si#3 미재생성 · external 429 로 소멸
판정: INCONCLUSIVE — 좌석 상실(backbone-si#3 원인 불문 / external:api:<model-a> rate-limit)
      반복 1 의 미해소 blocker 2건 유지
      다음 행동: 환경 복구 + 좌석 식별자 재생성 후 재실행.
                --external=off 로 우회하면 그 사실을 보고에 남긴다
```

**외부 0 의 두 변형**은 정상 템플릿에서 좌석 줄·판정 줄만 바뀐다:

| 외부 0 사유 | 좌석 줄 | 판정 줄 |
|---|---|---|
| 저자 설정 2종 — `author-off` · `default-endpoint-off` | `외부 0 (사유: <토큰>)` | `APPROVE(모델축 미커버 — 저자 요청)` |
| 환경 7종 — `probe-unseated status=<code>` 외 6종 | `외부 0 (사유: <토큰>)` | `APPROVE(모델축 미커버 — 환경)` |

**사유 토큰 9종.** `author-off` · `default-endpoint-off`(앞 2종 → 저자 요청) · `probe-unseated status=<code>` · `no-credential` · `no-independent-model` · `unclassifiable-catalog` · `no-transport` · `cli-absent` · `gemini-call-failed`(뒤 7종 → 환경).
`probe-unseated status=<code>` 는 **프로브를 실제로 낸 뒤** 착석에 실패한 경우만이다. 목적지는 있는데 키 env 가 비어 프로브를 아예 못 낸 경우는 `no-credential` 이다 — HTTP 를 한 건도 안 내고 "프로브가 착석시키지 못했다"고 말하지 않는다.
`default-endpoint-off` 는 키가 있는데 저자가 `RALPH_QA_NO_DEFAULT_ENDPOINT` 로 목적지를 없애 좌석이 못 선 경우다 — 원인이 환경이 아니라 저자 설정이므로 `cli-absent` 로 흘리지 않는다.
직전 실행이 `INCONCLUSIVE` 인데 `--external=off` 로 우회했다면 그 사실을 보고에 남긴다.
`⬜` 는 실패 표시가 아니라 커버리지 표시다. `--external=off` 여도 `프로브(관측): 미실행 (--external=off)` 로 미실행 사실 자체를 적는다 — 줄 생략은 축약이다.
선언 블록은 프로브가 되받아 적는 값이므로 **"증거"라고 부르지 않는다**.

## 한계

- **백본의 reasoning effort 는 이 스킬이 호출 단위로 지정하지 못한다.** Agent 도구 스키마에 effort 파라미터가 없다. effort 는 **에이전트 정의의 프론트매터**(`effort:`)나 세션 설정에서 오고, banker 는 에이전트를 배포하지 않으므로(`.claude-plugin/plugin.json` 에 `agents` 없음) 백본이 띄우는 것은 남의 정의다.
  그래서 백본은 모델만 선호 순서로 고르고 **실제로 쓴 것을 보고한다** — 목표를 약속으로 적지 않는다. 세션 강도를 올리는 것이 백본에 영향을 주는 유일한 손잡이이며, 최대 강도가 필요하면 **호출 전에 그것을 올려라.**
  **에이전트 정의를 배포해 강도를 박는 길은 의도적으로 닫혀 있다.** `effort:` 프론트매터는 Claude 전용이라, 그 길을 열면 백본 강도가 런타임별로 갈려 이 스킬이 기대고 선 런타임 대칭이 깨지고 매니페스트의 "모든 표면이 양 런타임 대상" 성질도 무너진다. 사고가 아니라 결정이다.
- `--effort` 는 전송 경로가 실재하는 외부 좌석(api·codex)에만 적용된다. 백본 강도를 이 플래그로 바꿀 수는 없다.
- `--effort` 는 **전송 확인 / 적용 미확인**이다 — 값을 보냈다는 사실만 확인 가능하고 모델이 그것을 적용했는지는 응답에서 관측할 수 없다.
- 백본은 같은 베이스 모델이라 **모델-독립이 아니다**. 3축 표가 이를 숨기지 않을 뿐 해결하지는 않는다.
- **계열 회피는 독립성을 얻는 대신 모델 능력을 보장하지 않는다.** 자동 선택은 통과 후보의 카탈로그 순서를 따를 뿐 성능순이 아니라서, codex 를 피한 결과가 훨씬 작은 모델일 수 있다.
  그럼에도 회피가 기본인 이유는 실증 필터가 비대칭이기 때문이다 — 약한 좌석의 근거 없는 반대는 `dissent-unsubstantiated` 로 걸러지고 파일·기준을 짚은 지적만 살아남으므로, 능력을 잃는 비용보다 맹점을 갈라 얻는 이득이 크다.
  능력이 더 중요한 상황이면 `--model` 로 고정하라. 그 값은 회피보다 우선한다.
- 규칙의 상태(좌석 집합·끈끈한 반대·ERROR 카운트)는 **실행 단위**다. 새 실행은 상태를 리셋하며 이를 막을 수단이 없다.

## 함정

- **`codex login status` 와 `~/.codex/auth.json` 을 유효성 근거로 쓰지 마라.** 둘 다 거짓 음성이다 — `Not logged in` 을 exit 0 으로 답하면서 codex 가 정상 동작하는 경우가 있다(인증이 ChatGPT 로그인이 아니라 프로바이더 env 키에서 올 때). 유효성은 프로브의 HTTP 판정으로만 정한다.
- **`codex exec` 왕복을 프로브로 쓰지 마라.** 실측 25,478 토큰이다. 프로브가 검증보다 비싸면 도구가 아니다.
- **같은 계열 금지.** 저자와 같은 모델 계열을 외부 좌석에 앉히면 독립성이 없다. 계열 필터는 프로브의 상수 표가 강제하며 env 로 끌 수 없다. 미분류 계열은 fail-closed 로 제외된다.
- **외부 좌석 둘이 같은 모델이 되는 경로를 조심하라.** 저자의 codex 설정은 api 좌석의 선호 모델 출처이기도 해서, 회피가 없으면 `api:<X>` 와 `codex(<X>)` 가 나란히 앉는다. 좌석 수는 2인데 모델 축은 1이고, 게이트는 그대로인데 보고만 독립적으로 읽힌다.
- **`GET /models` 200 을 호출 권한으로 읽지 마라.** 카탈로그가 보인다는 것과 그 모델을 부를 수 있다는 것은 다르다. 계열 회피로 고른 모델이 첫 호출에서 거절되면 착석 전이므로 다음 후보로 갈아탄다(워크플로 2단계).
- **`ERROR` 를 드롭하지 마라.** 좌석을 지우면 정족수의 해당 연언항이 공허하게 참이 되어 게이트가 넓어진다.
- **`OPENAI_API_KEY` 가 OpenAI 키가 아닐 수 있다.** LiteLLM·OpenRouter·사내 게이트웨이 구성에서는 이 이름에 **다른 프로바이더의 키**가 들어 있고, base URL 은 보통 앱 설정에 있지 env 에 없다. 그 상태로 기본 엔드포인트로 내려가면 남의 키가 엉뚱한 벤더로 나간다. 그런 환경이면 base URL 을 env 로 명시하거나 `RALPH_QA_NO_DEFAULT_ENDPOINT` 로 끈다. `GOOGLE_API_KEY` 계열도 Maps·Translate 등 범용 키 이름이라 같은 성질이 있다.
- **수용 기준 없이 검증하지 마라.** 검증 가능한 기준 대비 판정이어야 한다.

ARGUMENTS: [--agents=N] [--external=auto|off] [--model <id>] [--effort <v>] [--lens=critic|plan|both] [--max=N] [검증 대상/기준]
