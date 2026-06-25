---
name: compact-wiki
description: >
  append-wiki 로 쌓인 프로젝트 wiki(.omc/wiki)를 정리·압축한다. 중복 페이지를
  병합하고, 과거·최신 자료가 공존하면 최신으로 supersede 하며, 관련 페이지를
  통합한다. "compact-wiki" / "위키 정리/압축" / "wiki 중복 제거" / "위키 병합" /
  "오래된 위키 갱신" 요청 시 사용. ★최우선 불변식 = 지식 무손실: 스냅샷→병합→
  검증→삭제 순서로, 어떤 고유 사실도 잃지 않는다. append-wiki 의 자매 스킬.
---

# compact-wiki — wiki 정리·압축 (무손실)

`append-wiki` 가 `.omc/wiki/` 에 누적한 지식을 **중복 제거·supersede·병합**으로 압축한다.
append-wiki 가 "쌓기"라면 이 스킬은 "정리"다. 두 스킬 모두 OMC `wiki_*` MCP 도구를 쓰고,
답변·설명은 한글(도구명·슬러그·경로 등 기술 토큰은 영문).

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

### 0) wiki 도구 로드 (deferred — 먼저)
`wiki_*` 는 deferred MCP 도구다. 호출 전 ToolSearch로 스키마 로드:
```
ToolSearch(query="select:mcp__plugin_oh-my-claudecode_t__wiki_list,mcp__plugin_oh-my-claudecode_t__wiki_query,mcp__plugin_oh-my-claudecode_t__wiki_read,mcp__plugin_oh-my-claudecode_t__wiki_ingest,mcp__plugin_oh-my-claudecode_t__wiki_delete,mcp__plugin_oh-my-claudecode_t__wiki_lint")
```

### 1) 스냅샷 (★안전망 — 가장 먼저)
삭제·치환 전에 wiki 디렉터리를 통째로 백업해 복구 가능 상태를 만든다:
```bash
ts=$(date +%Y%m%d-%H%M%S); cp -r .omc/wiki ".omc/wiki.bak-$ts" && echo "backup: .omc/wiki.bak-$ts"
```
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
- **백업 위치**(`.omc/wiki.bak-*`)와 "이상 없으면 삭제해도 됨" 안내.

## 작성 원칙 (append-wiki 와 정합)
- **보존 > 압축.** 압축은 중복·잡음 제거지 지식 삭제가 아니다. 고유 사실은 1건도 잃지 않는다.
- **삭제는 마지막.** 스냅샷 → 병합본 → 검증 → 삭제. 역순 금지.
- **충돌은 최신 우선, 옛 고유맥락 보존.** 단순 중복만 축약.
- **증거·링크 보존.** `path:line`·sources·`[[slug]]` cross-link 를 병합본에 모은다.
- **애매하면 멈춤.** 폐기 판단이 서지 않으면 보존하고 사용자에게 surface.
