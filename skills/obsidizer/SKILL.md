---
name: obsidizer
description: "(banker) AI 생성 마크다운 위키를 의미 보존한 채 Obsidian 지식그래프로 정규화·상호링크·백링크. '--enable'/'--disable' 로 이후 위키 생성 자동 정규화 켜기/끄기(Claude 한정). 'obsidizer'/'옵시디언화'/'obsidian 최적화'/'위키 그래프 정리' 시 사용."
---

# obsidizer — AI 위키를 Obsidian 지식그래프로 정규화

AI가 생성한 마크다운 위키를 **의미 보존**한 채 그래프 관점(`tags`·`[[slug]]` 링크·`links[]`
백링크·Related 푸터)에서 정규화한다 — "vault over file", 노트 하나가 아니라 그래프 속 자리를
최적화한다. 의미 판단(어떤 언급이 진짜 링크인지, 어떤 섹션이 진짜 중복인지)은 LLM이 파일을 직접
편집해 내리고, **결정적 캐노니컬라이저**(`obsidize.mjs`)가 마지막 기계적 패스로 바이트 단위 결과를
고정한다. `wiki_*` 쓰기 의존 없음(검증에만 `wiki_lint` 읽기 전용 사용).

## ⚠️ 정직한 실현 한계

`--enable`은 "이후 모든 위키 생성이 obsidizer 양식을 따른다"를 뜻하지 않는다. 실제 경계는 세 갈래다:

- **깊이 — 기계적 정규화만, 의미 보강은 절대 자동화하지 않는다.** `--enable`은 프론트매터
  envelope·`tags`·줄바꿈/헤딩·`links[]` 정렬·Related 푸터 같은 **기계적 규칙**만 자동 적용한다.
  어떤 언급을 링크할지, 어떤 백링크가 진짜인지는 자동화 대상이 아니다.
  ⚠️ hook은 실제로 `hookSpecificOutput.additionalContext`로 LLM에 지시를 주입**할 수 있다**(OMC
  자체 hook 10개가 이미 이 필드를 쓴다 — "hook은 LLM을 못 돌린다"는 말은 틀렸다). obsidizer는 이
  경로를 **품질 근거로 거부한다**(불가능이 아니라 선택): (1) soft·assistant-honored일 뿐 강제가
  아님, (2) 미리보기 없는 자동 변형 → dry-run-기본 원칙과 정면 충돌, (3) 자동 경로에 LLM 판단이
  들어가 결정성 축이 깨짐, (4) 세션을 가로챔(저장만 요청했는데 그래프 큐레이션이 끼어듦).
- **런타임 — Claude 전용.** Codex CLI엔 MCP 도구 hook 자체가 없다(PostToolUse=Bash·apply_patch
  만). `--enable`/`--disable`은 Codex에서 **정직한 no-op**: 명확한 메시지만 내고, 아무도 읽지
  않을 플래그를 쓰지 않으며, 성공을 보고하지도 않는다.
- **🔴 커버리지 — session-log 페이지는 절대 걸리지 않는다.** `session-hooks.ts:133`이 MCP 도구
  없이 `writePageUnsafe`를 직접 호출 → `PostToolUse` 이벤트 자체가 없다 → hook이 **영원히 안
  켜진다**. session-log는 이 vault에서 **가장 흔한 페이지 유형**(오늘 12개 중 3개, 세션마다 +1).
  `--enable`의 약속은 **`wiki_ingest`/`wiki_add`로 쓰인 페이지에 한정**된다. session-log는 bare
  `obsidizer` 실행으로만 정규화된다.

| | `--enable`로 자동 | bare `obsidizer` 필요 |
|---|---|---|
| 기계적 규칙 (`wiki_ingest`/`wiki_add` 경로) | ✅ | — |
| 기계적 규칙 (`session-log-*` 페이지) | ❌ 절대 안 걸림 | ✅ |
| 의미 보강 (링크·백링크·중복 판단) | ❌ (거부, 한계 아님) | ✅ |

## 런타임 배선
- **엔진은 동일**: Claude·Codex 모두 LLM이 파일을 직접 편집(Read/Glob/Edit/Write)하고, 마지막에
  `obsidize.mjs`(zero-dep 순수 Node 스크립트)가 기계적 패스로 마무리한다. `wiki_*` 쓰기 의존이
  없어 두 런타임에 동형으로 동작한다 — `target:both`가 정직한 이유.
- **기본 타깃이 다르다**: Claude → 감지된 `.omc/wiki/`. Codex/OMX → 사용자가 지정한 vault 경로
  (자동 감지 대상이 없음).
- **제약 프로파일이 조직 축이다.** 타깃을 감지 즉시 **OMC-managed 위키**(`index.md`+`log.md`+
  9-필드 프론트매터 시그니처)와 **일반 Obsidian vault**로 분류하고, 이 분류가 이후 전부를
  게이팅한다: 프론트매터 envelope(9-key 한정 vs 자유) · 위키링크 형식(bare-only vs piped 허용) ·
  reserved files · no-rename · `aliases`(OMC=거부, 일반=작성).
- **검증은 읽기 전용**: OMC-managed일 때만 `wiki_lint`를 ToolSearch로 로드해 before/after 베이스라인
  대조에 쓴다. **쓰기 의존은 없다** — `wiki_ingest`/`wiki_add`를 호출하지 않고 파일을 직접
  정규화한다.

## 모드

**1) bare `obsidizer [path]` — 리뷰 & 수정 (기본 = dry-run)**
1. **Phase 0 — 타깃 감지**: 경로 인자 우선, 없으면 `.omc/wiki/` 감지, 둘 다 없으면 중단. 프로파일
   분류(위 참조). OMC-managed면 `wiki_lint` 베이스라인 기록 + `<wikiDir>/.obsidizer-hook.log` 존재
   시 읽음.
2. **Phase 1 — 전체 vault 스캔(읽기 전용)**: 모든 `.md` glob(reserved 파일은 개념맵용으로만 읽고
   변경 대상에서 제외). 프론트매터/제목/H1/헤딩/본문 링크/`tags`/`links[]`/Related 푸터 파싱 →
   슬러그 인덱스·H1 인덱스·링크 그래프·태그 어휘·orphan 집합으로 vault 모델 구축.
3. **Phase 2 — 의미 분석(LLM, dry-run에선 쓰기 없음)**: 페이지별로 어떤 언급을 기존 슬러그에
   링크할지, 어떤 역방향 백링크가 진짜인지, 어떤 섹션이 진짜 중복인지 판단. Canvas-MOC·inline-`::`·
   MOC-hub **생성**은 0.7.0 보류 — 이번 판에서 적용하지 않음.
4. **Phase 3 — 미리보기(기본)**: 페이지별 변경 요약 + vault 카운트 제시. `--apply` 없이는 그대로
   종료.
5. **Phase 4 — 안전 뮤테이션(`--apply` 시)**: 스냅샷(`cp -r`) → LLM이 의미 편집 적용 → **그 다음
   `obsidize.mjs`가 최종 캐노니컬라이즈 1회** 실행. reserved 파일은 손대지 않음. rename 없음.
6. **Phase 5 — 검증**: `wiki_lint` 재실행(신규 broken-ref 0, orphan ≤ 베이스라인), 슬러그 집합
   불변 확인, OMC 프로파일이면 bare-form 전용 grep + PM-1 프론트매터 grep, 캐노니컬라이저 멱등
   자가검사.

**2) `obsidizer --enable` / `--disable` — 지속 정규화 (Claude 전용, structural)**
banker의 **첫 플러그인 선언 hook**(`hooks/hooks.json`)이 OMC 위키 쓰기 도구(`wiki_ingest`/
`wiki_add`)에 `PostToolUse`로 걸려 항상 등록되어 있다. **`<wikiDir>/.obsidizer` 플래그 파일이
스위치**다 — `--enable`은 이 파일을 쓰고 `--disable`은 지운다, 그게 전부다(`settings.json` 변경
없음). 플래그가 없으면 hook은 즉시 exit 0. 방금 banker를 설치/갱신한 세션이면 완료 보고에
**`/reload-plugins`** 실행을 안내한다(hot-reload 경로). Codex에서는 위 한계 섹션대로 정직한 no-op.

## 변환 규칙

| # | 변환 | v1 동작 | Durable | 레이어 |
|---|---|---|---|---|
| T1 | H1==title 단일화, 헤딩레벨 스킵 금지, 빈줄 정규화 | 적용 | 대체로(멱등) | canonicalizer |
| T2 | `tags` 정규화(선행 `#` 제거·dedup·결정적 순서, Unicode 과잉 제거 금지) | 적용 | YES | canonicalizer |
| T3 | 본문 `[[slug]]` 보강 — 기존 슬러그만, ghost node 금지. **OMC 프로파일: bare form만** | 적용 | YES | LLM(의미) |
| T4 | `links[]` 상호성 — 누락된 진짜 역방향 백링크 추가 → de-orphan. 본문의 해소 가능한 링크는 canonicalizer가 기계적으로 흡수(monotonic — 늘기만 하고 삭제 없음) | 적용 | YES | LLM 결정·canonicalizer 기록 |
| T5 | 페이지 내 섹션 dedup — 바이트 동일 중복 블록만 축약, 고유 사실 전량 보존 | 적용 | YES(재-ingest 전까지) | LLM(의미) |
| T6 | Related 푸터(OMC 프로파일 한정) — 본문의 해소 가능한 링크를 `links[]`에 흡수(T4)한 **뒤**, 그 해소 가능한 부분집합을 정렬·dedup·bare form으로 렌더. cap은 **추가분만** 제한(기존 푸터 링크는 캡 초과여도 유지 — 아래 안전 울타리) | 적용 | YES | canonicalizer |
| T7 | rename | **안 함** | n/a | — |
| T8 | `aliases` | 일반 vault만 적용(아래 별칭 정책) · OMC 트리 거부 | 일반 YES · OMC NO(destructive) | canonicalizer |
| T9 | inline `Key:: Value` 생성 | 0.7.0 보류(생성만); v1은 보존만 | YES(이미 durable) | — |
| T10 | Canvas-MOC 사이드카 생성 | 0.7.0 보류(생성만); v1은 보존만 | YES(이미 durable) | — |
| T11 | Excalidraw | **매 버전 보존만**, 절대 생성 안 함 | n/a(스키마 OPEN) | — |
| T12 | MOC 허브 페이지 생성 | 0.7.0 보류 | (ingest되면 durable) | — |

**T3 프로필 주석 (가독성 비용, 정직히 명시).** OMC 트리에선 mid-prose 슬러그 삽입보다 **Related
푸터(T6)를 우선한다** — piped link가 금지라 문장 중간에 `claude-code-plugin-skill-...` 같은 원시
슬러그가 끼면 가독성이 떨어진다. 그래프 엣지는 어디 있든 동일한 값이므로 푸터가 무비용으로 같은
엣지를 전달한다. **일반 vault**에선 piped link가 허용되므로 mid-prose 링크가 가독성 있고 오히려
선호된다.

## 별칭(aliases) 정책

**일반 vault → v1 적용.** 캐노니컬라이저가 쓴다(기계적 ⇒ 결정적 ⇒ 바이트 테스트 가능). 유일한
출처는 노트 자신의 **H1** — 절대 날조하지 않는다. 아래 6조건을 **모두** 만족해야
`aliases: ["<H1 텍스트>"]`를 쓴다:

| # | 조건 | 이유 |
|---|---|---|
| 1 | 프로파일 == 일반 vault | OMC 트리에선 항상 거부 |
| 2 | 프론트매터 블록 존재 + H1 정확히 1개 | 없는 블록을 새로 만들지 않음 |
| 3 | `norm(H1) !== norm(basename)` (의미 있게 다름) | 대소문자/구두점 차이는 무가치 |
| 4 | `norm(H1)`이 다른 노트의 basename과 겹치지 않음 | 별칭이 실제 파일을 가리는 것 방지 |
| 5 | H1 텍스트가 vault 전체에서 유일함 | N-way 충돌 방지 |
| 6 | 기존 `aliases` 키 없음 | 사용자 콘텐츠 보존 + 고정점 유지 |

`norm(x)` = 소문자화 → `[^a-z0-9]+`를 `-`로 축약 → 앞뒤 `-` 제거(64자 cap **없음** — OMC
`titleToSlug`의 cap을 흉내내면 긴 제목의 유효한 별칭을 부당하게 억제한다). 항상 **큰따옴표로
quote**(YAML 이스케이핑, `[[…]]` 오파싱 방지) + **FLOW 형식**(`aliases: ["X"]`) + 기존 키·순서를
그대로 둔 채 **맨 끝에 추가**.

**OMC-managed 트리 → 쓰지 않음. 거부이지 보류가 아니다.** 이 키는 `parseFrontmatter`가 9-key를
재구성하는 **READ 시점**에 조용히 사라지는 **silent loss**이고, 유일한 소비처(piped link)가
`links[]`를 오염시키는 **silent corruption**이다 — 파괴적 실패 모드는 어떤 노력으로도 정당화되지
않는다. (측정상 OMC 트리에도 유용하고 충돌 없는 별칭 후보가 실제 존재한다 — 64자 cap에 잘린 H1
1건이 오늘 살아있고, CJK 제목의 해시 폴백은 구조적으로 발생 가능. 그럼에도 거부하는 이유는 정확히
이것 — 유용성이 있어도 실패가 파괴적이면 쓰지 않는다.)

**`cssclasses` → 어느 프로파일에서도 쓰지 않음.** OMC 트리에선 같은 destructive strip. 일반
vault에서도 문서 안에 출처가 없는 값이라 쓰면 **날조**가 된다 — 어떤 버전에서도 정당화되지 않는다.

## 결정성·멱등

- **고정 변환 순서**: LLM 의미 편집(T3/T4-결정/T5)이 먼저 전부 끝나고, 그 다음 캐노니컬라이저가
  T1→T2→T4-기록→T6→T8-일반 순으로 적용.
- **프론트매터 순서**: OMC 프로파일은 9-필드 고정 순서 보존(`serializePage`와 다투지 않음). 일반
  프로파일은 기존 키·순서를 그대로 두고 `aliases`만 맨 끝에 조건부 추가.
- **타임스탬프 무잡음**: `created`는 절대 안 건드림. `updated`는 직렬화된 내용이 실제로 바뀔 때만
  (바이트 diff 게이트) 갱신 — no-op 페이지는 `updated`도 그대로.
- **하위 정렬도 결정적**: Related 슬러그·`tags`·`links[]` 모두 안정적 키로 정렬·dedup.
- **멱등 = 구조로 보장**: 캐노니컬라이저는 고정점(정규화된 입력 → 동일 바이트)이라 2회차 실행은
  마커 없이도 diff 0. `.obsidizer-state.json`(슬러그→정규화해시)은 속도 최적화일 뿐 정확성에
  의존하지 않는 선택적 캐시.
- **보존 전용 표면**: `## Update (<ts>)` 섹션·body-inline `Key:: Value`·sibling `.canvas`·
  `.excalidraw.md`는 절대 재포맷/재작성하지 않는다.
- **bare-form-only(OMC 프로파일)**: 캐노니컬라이저와 LLM 모두 `[[slug]]`만 쓴다.
- **결정성 주장의 범위**: 바이트 멱등은 **캐노니컬라이저에만** 귀속(armed hook도 동일 코드라 포함).
  **의미** 판단(링크·dedup 선택)은 설계상 실행마다 달라질 수 있어 **Unknown**으로 보고하며, 절대
  바이트로 단언하지 않는다.

## 안전 울타리

- **기본 = dry-run.** `--apply` 전까지 아무것도 쓰지 않는다. 미리보기 없는 자동 변형은 금지(위
  한계 섹션에서 hook 경로를 거부하는 이유이기도 하다).
- **`--apply` 전 필수 스냅샷**: `cp -r <vault> <vault>.bak-<ts>` (compact-wiki와 동일 선례).
- **모든 쓰기는 원자적**: 유니크 temp(`randomUUID`) + `wx`(배타 생성) + `fsync` + `rename`. 절대
  in-place bare write가 아니다 — OMC 자신의 `atomicWriteFileSync`와 같은 형태를, 빌려 쓰지 않고
  독립 구현한다. **read-back CAS는 hook이 아니라 캐노니컬라이저에 있고, 두 진입점(bare 실행·armed
  hook)이 함께 상속**한다: temp를 먼저 다 쓰고 → 재읽어 바뀌었으면 skip → `rename`.
  **`rename`은 torn read를 확실히 없앤다. CAS는 lost update의 창을 `rename` 한 번으로 줄일 뿐
  없애지 못한다** — 그 창에 낀 writer는 여전히 덮인다. 이 잔여 race는 **해결이 아니라 수용**이다:
  닫으려면 상대가 지켜주는 lock이 필요한데 OMC의 내부 `.wiki-lock`에 기대는 건 거부한다(남의
  플러그인 내부 파일은 이름이 바뀌는 날 조용히 깨진다). 없앴다고 읽지 말 것.
- **해소 가능한 bare-form 링크는 삭제하지 않는다**(두 예외가 아래 (1)·(2)이고, 제목이 그 둘을 이미
  배제하도록 좁혀 쓴 것이다): 푸터를 다시 그리기 **전에** 본문의 해소 가능한(on-disk)
  위키링크를 `links[]`에 **합집합으로 흡수**한다(`[[a|A]]`·`[[a#S]]`도 대상 `a`로 흡수. 코드펜스
  안은 제외 — Obsidian이 엣지로 치지 않으므로 흡수하면 없는 엣지를 만드는 셈이다). 푸터는 `links[]`
  만 보고 렌더링되므로, 이 흡수가 없으면 `links[]`에 없던 **수기 푸터 링크**가 조용히 사라진다
  (OMC가 쓴 푸터는 `links[]` ⊇ 푸터가 항상 성립해 안 걸리고, 사람이 더한 링크만 걸린다).
  `links[]` 항목은 어느 경로에서도 지우지 않으며(정렬·dedup만), 본문 중간 링크도 손대지 않는다.
  다시 그리는 건 푸터 줄 하나뿐이고(OMC 프로파일 한정 — 일반 vault에선 푸터를 렌더링조차 하지
  않으므로 있는 그대로 둔다), 거기서 링크가 빠지는 경우는 둘 — (1) 대상 파일이 없는 **broken-ref**,
  (2) OMC 프로파일에서 **bare slug가 아닌 형태**(D8: `[[Weird Name]]`은 OMC `extractWikiLinks`가
  `weird-name.md`로 슬러그화해 phantom을 만든다).
  (1)은 "해소 가능한 링크 삭제"에 해당하지 않는다 — 가리키는 파일이 없으니 없앨 엣지 자체가 없고,
  broken-ref 0은 검증 목표다. `links[]`에 같은 대상의 올바른 슬러그가 있으면 그게 대신 렌더돼
  결과적으로 **수리**가 된다(측정 확인: 깨진 `[[…-automation-ceiling]]` → 실재하는
  `[[…-automation-ceil]]`). 없으면 그냥 빠진다. 캐노니컬라이저가 하는 일이라 **OMC 트리에서도**
  일어나며, bare 실행은 `--apply` 게이트 뒤에 있지만 **무장된 hook 경로엔 미리보기가 없다**.
  (2)에서 살아남는 건 **OMC 그래프 하나뿐이다** — `links: ["Weird Name.md"]`는 따옴표 친 YAML
  문자열일 뿐 Obsidian이 엣지로 읽는 `[[…]]`가 아니다. 즉 **OMC 엣지(`links[]`)는 남고 Obsidian
  엣지는 사라진다**(본문 중간에 같은 링크가 또 있으면 거긴 손대지 않으므로 그쪽 Obsidian 엣지는
  유지된다). OMC가 만드는 파일명은 전부 bare slug라 (2)의 대상은 사람이 non-slug 파일명을 직접 넣은
  경우뿐이다.
  **`FOOTER_CAP`(12)은 세 번째 경우가 아니다** — 캡은 obsidizer가 푸터에 **새로 더하는 양**만
  제한하고, 이미 푸터에 있는 해소 가능한 링크는 캡을 넘겨도 전부 유지한다(수기 푸터 15개 → 15개
  그대로). 그래서 `links[]`는 20인데 푸터엔 12만 보이는 상태가 정상이다: `links[]`는 OMC 그래프의
  durable 전량이고 푸터는 그 위에 얹은 **표현**이며, 캡은 표현 예산이지 엣지 예산이 아니다.
- **본문은 재작성하지 않는다**: 추가·포맷만 하고 산문을 고쳐쓰지 않는다.
- **rename 없음**: 절대적. 예쁜 표시 이름이 필요해도 하지 않는다.
- **reserved 파일은 in-place 편집하지 않는다**: `index.md`/`log.md`/`environment.md`.
- **OMC 프로파일은 9-key envelope에 갇힌다**: 그 외 프론트매터 키는 절대 추가하지 않는다(body
  `::`와 `.canvas`는 이 울타리 밖 — durable하므로 허용).
- **일반 프로파일은 사용자 콘텐츠를 덮지 않는다**: 기존 `aliases` 보존, 프론트매터 키 순서 보존,
  없는 프론트매터 블록을 새로 만들지 않음.
- **`%%obsidizer:ignore%%` 옵트아웃**: 파일 어디든 이 마커가 있으면 **프로파일 무관** 그 페이지를
  통째로 건너뛴다 — 읽기-수정-쓰기를 아예 하지 않고 리포트에 `ignored`로 집계한다. 건너뛴 페이지도
  vault 모델에는 그대로 남는다(슬러그가 링크를 해소하고, H1이 다른 노트의 별칭 조건을 계속
  게이팅한다) — "고치지 마라"는 "없는 셈 쳐라"가 아니다. Obsidian은 `%%…%%`를 주석으로 렌더링하므로
  마커는 화면에 보이지 않는다.
- **사실을 날조하지 않는다**: 존재하지 않는 슬러그로 링크하지 않고, 별칭은 H1에서만 파생하며,
  `cssclasses`·Excalidraw·Canvas·MOC를 절대 지어내지 않는다 — OPEN 항목은 보존-전용/미적용 +
  Unknown 보고로 degrade.

## 검증 (보고 의무)

4-field 보고:
- **변경**: 적용된 변환 요약(어떤 페이지에 어떤 T#).
- **Evidence**: 카운트(스캔한 페이지 수·추가된 링크 수·해소된 orphan 수·병합된 중복 수·추가된
  alias 수·불변 파일 수) + `wiki_lint` before→after.
- **검증**: 신규 broken-ref 0, rename 0, OMC 프로파일이면 bare-form grep 0 + PM-1 프론트매터
  grep 0, 캐노니컬라이저 멱등 자가검사(2회 실행 diff 0).
- **Unknown**: 0.7.0 보류 기능·진짜 관계가 없어 남겨둔 orphan·OPEN 한계에 걸린 항목·바이트로
  단언하지 않는 의미 판단 편차.

**hook 건강 상태 보고(무장 시).** Phase 0에서 `<wikiDir>/.obsidizer-hook.log`를 읽는다: 로그
없음/비어있음 + 플래그 존재 → Evidence("hook 무장, 에러 없음"). 로그에 항목 있음 →
Unknown("hook이 N회 에러 — 이 페이지들은 이번 bare 실행이 대신 정규화함, `--enable` 신뢰 전 조사
필요"). 플래그 없음 → Evidence("hook 비무장"). hook은 모든 에러에서 exit 0이라 이 로그가 **유일한**
발견 경로다.

## 함정

- **비-bare 위키링크가 OMC 트리에서 `links[]`를 오염시킨다** — `[[slug|display]]`,
  `[[slug#heading]]`은 Obsidian에선 완전히 정상이지만, OMC `extractWikiLinks`는 inner text
  **전체**를 슬러그화한다(`titleToSlug("slug|display")` → `slug-display.md`). obsidizer 자신의
  검증은 통과하고(Edit/Write로 쓰고 OMC 파서를 재실행하지 않으므로) **나중에
  `append_wiki`/`wiki_ingest`가 같은 페이지를 건드릴 때** broken-ref로 터진다. 규칙은 "inner text가
  정확히 bare slug인 형태만"이라는 whitelist다. **`![[slug]]`는 이 함정에 안 걸린다** — `!`가
  정규식 매치 밖이라 `titleToSlug("slug")` = 올바른 `slug.md`로 해석된다(측정 확인). OMC 트리에서
  `![[…]]`를 피하는 이유는 오염이 아니라 **transclusion 렌더링**(대상 페이지 전문이 인라인됨)
  때문이다.
- **프론트매터 whitelist는 거짓 내구성을 준다** — `aliases`/`cssclasses`는 OMC
  `parseFrontmatter`가 9-key를 재구성하는 **READ 시점**에 조용히 사라진다. 쓴 직후엔 보이지만
  다음 `wiki_*` 쓰기에서 증발한다. OMC 트리에는 절대 쓰지 않는다.
- **rename 절대 금지, 예쁜 표시 이름은 OMC 트리에서 어떤 수단으로도 불가능** — `wiki_rename`이
  없어 파일명을 바꾸면 모든 참조자의 `links[]`가 broken-ref가 된다. 예쁜 표시 이름은 rename도,
  alias도, piped link도 전부 막혀 있어 OMC 트리에서 **어떤 방법으로도 전달 불가능**하다 — 이건
  실제 한계이지 숨길 일이 아니다.
- **MOC/de-orphan 링크 인플레 금지** — v1은 MOC 허브를 생성하지 않는다. 태그가 같다고 일괄 링크
  하지 않는다. 진짜 관계가 없는 orphan은 **orphan인 채로 두고 보고한다** — 억지로 연결하지 않는다.
- **Excalidraw는 절대 날조하지 않는다** — `.excalidraw.md` 스키마가 미검증(OPEN)이므로 모든
  버전에서 **보존만** 한다. 존재하는 파일을 그대로 두는 것 외엔 손대지 않는다.
- **body-`::`와 sibling `.canvas`는 durable — 지우지 마라** — `listPages`는 `.md`만 열거하므로
  `.canvas`는 OMC에 안 보이고, `mergePage`/`serializePage`는 본문을 그대로 보존하므로 body-inline
  `Key:: Value`도 안전하다. v1이 이들을 **생성**하지는 않지만(0.7.0 보류), 이미 있는 것은 절대
  재작성·삭제하지 않는다.
- **결정성은 캐노니컬라이저 한정이다** — 바이트 멱등을 주장할 수 있는 건 `obsidize.mjs` 뿐이다.
  LLM이 내린 의미 판단(어떤 링크가 진짜인지 등)은 실행마다 달라질 수 있어 **Unknown**으로
  보고하며, 절대 바이트로 단언하지 않는다.

ARGUMENTS: [path] [--apply] | --enable | --disable
