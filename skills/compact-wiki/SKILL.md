---
name: compact-wiki
description: "`.omc/wiki`(Codex 는 `omx_wiki/`) 페이지를 무손실로 정리. 중복은 지우고, 낡은 내용은 새 내용으로 대체하고, 겹치는 페이지는 병합. 'compact-wiki'/'위키 정리'/'위키 압축'/'wiki 중복 제거'/'위키 병합' 시 사용."
---

# compact-wiki — wiki 정리·압축 (무손실)

`append-wiki` 가 `.omc/wiki/` 에 누적한 지식을 **중복 제거·supersede·병합**으로 압축한다.
append-wiki 가 "쌓기"라면 이 스킬은 "정리"다. 두 스킬 모두 Claude Code 는 OMC `wiki_*` MCP 도구로 `.omc/wiki/` 를,
Codex 는 OMX 의 `omx wiki` CLI 로 `omx_wiki/` 를 다룬다. 답변·설명은 한글(도구명·슬러그·경로 등 기술 토큰은 영문).
아래의 `.omc/wiki` 는 Codex 에서 `omx_wiki` 로 읽는다.

> ★**불변식 — 지식 무손실**: 이 스킬의 모든 destructive 동작(병합 후 삭제·supersede)은
> **스냅샷 → 병합본 작성 → 병합본이 원본의 모든 고유 사실을 담았는지 검증 → 그 다음에만 삭제**
> 순서를 따른다. 검증 전 삭제 금지. 애매하면 보존(삭제하지 않음).

## 언제 쓰나
- wiki 페이지가 늘어 **같은 주제가 여러 페이지로 흩어졌거나**, 과거 결정과 갱신된 결정이 **공존**해 혼란스러울 때.
- 사용자가 "compact-wiki", "위키 정리/압축", "wiki 중복 제거/병합", "오래된 위키 최신으로" 요청할 때.
- `wiki_lint` 가 stale/oversized/중복 신호를 낼 때.

## 쓰지 않을 때
- wiki 가 작고 중복이 없을 때(불필요).
- 새 지식 "기록"이 목적 → `append-wiki`.
- 단일 페이지 오타 수정 → `wiki_ingest` 직접.

## 워크플로우

### 0) wiki 도구 준비 (런타임마다 다름 — 먼저)
**Claude Code:** `wiki_*` 는 deferred MCP 도구다. 호출 전 ToolSearch로 스키마 로드:
```
ToolSearch(query="select:mcp__plugin_oh-my-claudecode_t__wiki_list,mcp__plugin_oh-my-claudecode_t__wiki_query,mcp__plugin_oh-my-claudecode_t__wiki_read,mcp__plugin_oh-my-claudecode_t__wiki_ingest,mcp__plugin_oh-my-claudecode_t__wiki_delete,mcp__plugin_oh-my-claudecode_t__wiki_lint")
```

**Codex:** `wiki_*` MCP 도 ToolSearch 도 없다. `omx wiki` CLI 가 같은 도구 이름과 입력을 받는다(`wiki_list`, `wiki_query`, `wiki_read`, `wiki_ingest`, `wiki_delete`, `wiki_lint`).
```bash
omx wiki wiki_list --json
omx wiki wiki_read --input '{"page":"<slug>"}' --json
omx wiki wiki_ingest --input "$(cat <JSON 파일>)" --json
omx wiki wiki_delete --input '{"page":"<slug>"}' --json
```
- 아래 단계의 `wiki_xxx({...})` 는 Codex 에서 `omx wiki wiki_xxx --input '<같은 JSON>' --json` 이다. `page` 는 슬러그나 파일 이름(`<slug>.md`)을 받는다.
- 병합본처럼 긴 본문은 JSON 을 파일로 쓰고 `--input "$(cat <파일>)"` 로 넘긴다. 셸 인용이 깨지지 않게 하기 위해서다(bash).
- Windows 에서 PowerShell 로 `omx` 를 부를 때: Windows PowerShell 5.1 은 `omx.cmd` 에 넘기는 인자에서 큰따옴표를 지우고,
  공백에서 인자를 나누고, 한글을 깨뜨린다(Windows 박스 실측). 그래서 JSON 을 아래 `Arg` 로 바꿔 넘긴다.
  본문 속 큰따옴표와 공백, ASCII 밖 글자, cmd 가 읽는 `% & | < > ^ !` 는 `\uXXXX` 로, JSON 구조의 큰따옴표는 `\"` 로 바꾼다.
  따옴표(홀수 개 포함), 역슬래시, `%TEMP%`, `&`, 한글, 줄바꿈이 든 본문도 그대로 왕복하고 명령으로 읽히지 않는다(박스 실측).
  ```powershell
  function Arg([string]$s) {
    $a = [regex]::Replace($s, '(?<!\\)((?:\\\\)*)\\"', '$1\u0022')
    $a = [regex]::Replace($a, '[^\x21-\x7E]|[%&|<>^!]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
    $a -replace '(\\*)"', '$1$1\"'
  }
  $j = @{ title = "<영문 제목>"; content = "<본문>"; tags = @("<태그>"); category = "pattern" } | ConvertTo-Json -Compress
  omx wiki wiki_ingest --input (Arg $j) --json
  omx wiki wiki_query --input (Arg '{"query":"<키워드>"}') --json
  ```
- 인자 하나는 Linux 에서 128KB 를 넘지 못한다. 본문이 그보다 크면 페이지를 나눈다.
- `omx` 가 없으면 멈추고 OMX 설치를 안내한다. 위키 파일을 손으로 지우거나 쓰지 않는다(목차와 이력이 어긋난다).
- `omx wiki` 와 스냅샷은 작업 폴더에만 쓰므로 샌드박스 승인이 필요 없다(Codex 0.144.5, OMX 0.20.2 에서 확인).

### 1) 스냅샷 (★안전망 — 가장 먼저)
삭제·치환 전에 wiki 디렉터리를 통째로 백업해 복구 가능 상태를 만든다:
```bash
ts=$(date +%Y%m%d-%H%M%S); cp -r .omc/wiki ".omc/wiki.bak-$ts" && echo "backup: .omc/wiki.bak-$ts"
```
Codex 는 `omx_wiki/` 를 `.omx/` 아래로 떠 둔다(`mkdir -p .omx && cp -r omx_wiki ".omx/wiki.bak-$ts"`).
프로젝트 루트에 두지 않는 것은 OMX 가 `omx_wiki/` 를 커밋 대상으로 보아 옆의 백업 폴더가 커밋에 섞일 수 있기 때문이다.
`omx_wiki/` 가 없으면 정리할 위키가 없으니 그 사실을 알리고 멈춘다.
작업 완료·사용자 확인 전까지 백업을 지우지 않는다(보고에 위치 명시).

### 2) 인벤토리 + 현재 상태 채증
- `wiki_list()` 로 전 페이지·슬러그·태그·크기 목록.
- `wiki_lint()` 로 broken link/orphan/stale/oversized 베이스라인 기록.
- 압축 후 대조용으로 **고유 사실/출처 개수**를 가볍게 집계(페이지별 핵심 bullet·sources 수).

### 3) 클러스터링 (무엇을 합칠지)
페이지를 다음 3종 후보로 분류한다(`wiki_query` 로 주제·태그 겹침 확인):
- **중복(duplicate)**: 같은 주제를 다룬 2+ 페이지 → 한 정본으로 병합.
- **supersede(과거↔최신)**: 같은 대상의 옛 정보와 갱신 정보 공존 → 최신을 정본, 옛것의 *여전히 참인 고유 맥락*만 흡수.
- **관련(related)**: 쪼개졌지만 한 주제로 묶는 게 나은 페이지들 → 통합(단 페이지가 50KB 넘게 비대해지면 쪼갠 채 `[[link]]`만 강화).

### 4) 병합 계획 제시
클러스터별로 **정본 title/slug + 흡수 대상 + supersede 판정**을 표로 사용자에게 보고(특히 supersede=옛 정보 폐기가 끼면 반드시 확인). broad/위험 결정은 사용자 승인.

### 5) 병합 실행 (★무손실 순서 — 클러스터마다)
1. **원본 전량 read**: 흡수 대상 모든 페이지를 `wiki_read` 로 끝까지 읽는다(요약본 신뢰 금지).
2. **병합본 작성(합집합)**: 모든 고유 사실·결정·함정·코드·`path:line`·출처·태그·`[[link]]`를 **빠짐없이** 한 정본에 모은다. 충돌(옛↔새)은 **최신을 본문, 옛 고유맥락은 "과거 경위" 노트로 보존**(무근거 폐기 금지). 단순 중복 문장만 1회로 축약.
3. **정본 ingest**: `wiki_ingest({title: <정본 영문 title>, …, sources: <원본들의 sources 합집합>, tags: <합집합>})`. (같은 title append 전략이므로, 정본 슬러그를 먼저 확정.)
4. **검증(삭제 전 필수)**: 병합본을 `wiki_read` 로 다시 읽어 **원본 각 페이지의 고유 항목이 전부 들어갔는지 체크리스트로 대조**. 하나라도 빠지면 보강 후 재검증. ✅ 전까지 **삭제 안 함**.
5. **cross-link 리포인트**: 삭제될 슬러그를 가리키는 `[[old-slug]]` 를 다른 페이지에서 찾아 정본 슬러그로 교체(`wiki_query`/grep `.omc/wiki`).
6. **그 다음에만 삭제**: 흡수된 잉여 페이지를 `wiki_delete`. (정본은 유지.)

### 6) supersede 처리
같은 페이지 내 과거/최신 공존이면: 최신을 본문 상단, 과거는 **"### 과거 경위(superseded)"** 로 압축 보존(여전히 참인 제약·함정은 남김). 완전 폐기는 사용자 확인 시에만.

### 7) 최종 검증 (보고 의무)
- `wiki_lint()` 재실행 → broken link 0(특히 삭제 슬러그 잔존 0), orphan/stale 감소 확인.
- **무손실 대조**: 2)에서 집계한 고유 사실/출처 수 ≥ 압축 후(줄지 않았는지). 줄었으면 백업에서 복원·재시도.
- 정본 슬러그로 모든 `[[link]]` 가 정상 해소되는지.

### 8) 보고 (한글)
- 병합/supersede 매핑(어느 페이지 → 어느 정본), 삭제된 슬러그, 리포인트한 링크.
- before→after: 페이지 수·총 크기·lint 결과.
- **백업 위치**(Claude Code `.omc/wiki.bak-*`, Codex `.omx/wiki.bak-*`, 실제로 만든 경로)와 "이상 없으면 삭제해도 됨" 안내.

## 작성 원칙 (append-wiki 와 정합)
- **보존 > 압축.** 압축은 중복·잡음 제거지 지식 삭제가 아니다. 고유 사실은 1건도 잃지 않는다.
- **삭제는 마지막.** 스냅샷 → 병합본 → 검증 → 삭제. 역순 금지.
- **충돌은 최신 우선, 옛 고유맥락 보존.** 단순 중복만 축약.
- **증거·링크 보존.** `path:line`·sources·`[[slug]]` cross-link 를 병합본에 모은다.
- **애매하면 멈춤.** 폐기 판단이 서지 않으면 보존하고 사용자에게 surface.
