---
name: append_wiki
description: "새로 배운 비자명 지식(아키텍처·결정·디버깅·패턴·환경)을 .omc/wiki에 구조화 적재·병합 — 'append_wiki'/'위키 기록'/'wiki에 정리'/'알게 된 내용 기록' 시 사용."
---

# append_wiki — 작업 지식을 wiki에 적재

이번 작업에서 **새로 배운 비자명한 지식**을 `.omc/wiki/`에 구조화해 남기는 워크플로우.
OMC `wiki` 스킬의 MCP 도구를 사용하며, 답변·설명은 한글로 작성한다(도구명·경로·식별자 등
기술 토큰은 영문 유지).

## 언제 쓰나
- 기능 구현/디버깅/리팩터링 등 한 덩어리 작업이 끝났을 때.
- 사용자가 "append_wiki", "위키 기록", "wiki에 정리해", "알게 된 내용 기록해" 등으로 요청할 때.
- 다음 세션/다른 사람이 알면 시간을 아낄 비자명한 결정·함정·근본원인이 생겼을 때.

## 쓰지 않을 때
- 코드/테스트/깃 히스토리/CLAUDE.md가 그대로 담는 사실(중복).
- 이번 대화에서만 의미 있는 일회성 잡담.
- 광범위한 문서 재작성(이건 기록이 아니라 별도 작업).

## 워크플로우

### 0) wiki 도구 로드 (deferred — 반드시 먼저)
`wiki_*` 는 deferred MCP 도구다. 호출 전에 ToolSearch로 스키마를 로드한다:
```
ToolSearch(query="select:mcp__plugin_oh-my-claudecode_t__wiki_ingest,mcp__plugin_oh-my-claudecode_t__wiki_query,mcp__plugin_oh-my-claudecode_t__wiki_list,mcp__plugin_oh-my-claudecode_t__wiki_lint")
```

### 1) 무엇을 남길지 식별
이번 작업의 산출에서 다음을 추린다:
- **아키텍처/설계 결정**과 그 이유(대안 포함) → `architecture` / `decision`.
- **디버깅 근본원인 + 증상 + 재현 + 수정 + 교훈** → `debugging`.
- **재사용 가능한 패턴/불변식** → `pattern`.
- **환경·운영 함정**(빌드/재기동/인증/포트/로그 등) → `environment`.
- **명명·구조 규칙** → `convention`. 외부 링크/티켓 → `reference`.
- **범위 외 finding**(이번엔 안 고쳤지만 알아야 할 것)도 명시적으로.
"왜/어떻게 적용"이 핵심 — 코드만 봐선 모르는 맥락을 남긴다.

### 2) 기존 페이지 확인 (중복 방지)
`wiki_list()` 로 목차를 보고, 주제 키워드로 `wiki_query({query, tags})` 한다.
관련 페이지가 있으면 **같은 title로 ingest** 해 병합(`wiki_ingest`는 append 전략 — 같은
title이면 교체가 아니라 추가).

### 3) 페이지 단위로 응축
- **한 페이지 = 한 주제.** 크면 여러 페이지로 쪼개고 `[[slug]]` 로 상호 링크.
- **title은 영문**으로(슬러그가 title에서 생성되므로 한글 title은 슬러그가 불안정 →
  cross-link 깨짐 위험). 본문은 한글로 충실히.
- 슬러그 규칙: 소문자 + 하이픈(예: title "ThreadPool Deadlock Acquire-Before-Pool"
  → slug `threadpool-deadlock-acquire-before-pool`). 콜론/특수문자는 제거됨.
- 표·코드블록·파일경로(`path:line`)로 증거 밀도 높게. 추측 금지, 검증된 사실만.

### 4) 적재
```
wiki_ingest({
  title: "<영문 제목>",
  content: "<한글 본문 (max 50KB)>",
  tags: ["<검색 태그>", ...],      // 최대 20개
  category: "architecture|decision|pattern|debugging|environment|convention|reference",
  sources: ["path/to/file.py", ".omc/plans/...", "URL"],   // 출처
  confidence: "high|medium|low"
})
```
관련 페이지는 본문에 `[[related-slug]]` 로 연결한다. 페이지가 여러 개면 순차 ingest 하되,
앞 페이지의 cross-link 슬러그가 뒤 페이지 슬러그와 일치하도록 영문 title을 먼저 확정한다.

### 5) 검증
`wiki_lint()` 로 broken cross-reference / orphan / stale / oversized 를 점검하고,
깨진 링크가 있으면 슬러그를 맞춰 다시 ingest 한다.

**environment.md 위생 (이식 가능 셀프힐 — 모든 시스템 공통).**
`.omc/wiki/environment.md` 는 append_wiki 가 아니라 OMC **SessionStart hook**
(`hooks/wiki/session-hooks`)이 `project-memory.json` 에서 자동생성한다. 이 hook 에는 **알려진 버그**가
있어 `techStack.frameworks`(객체 `{name,version}` 배열) 와 객체형 `build` 값(예: `scripts`)을 그대로
문자열화해 `[object Object]` 로 남긴다(`languages` 는 `.map(name)` 으로 정상 처리됨). append_wiki 실행 시
이 파일에 `[object Object]` 가 보이면 정화한다:
- `**Frameworks:**` 줄 → `project-memory.json` 의 `techStack.frameworks[].name` 들을 `, ` 로 조인한 값으로 교체.
- `## Build Commands` 의 객체형 값 줄(예: `- **scripts:** ` 뒤 `[object Object]`) → 삭제(문자열 command 만 남긴다).
project-memory 가 안 바뀌면 hook 은 재생성을 건너뛰므로(`existing.updated >= pm.lastScanned`) 정화가 유지된다.

- **근본 해결(선택·권장 — 그 시스템에서 1회 영구).**
  `find ~/.claude/plugins -path '*hooks/wiki/session-hooks*'` 로 소스(`.ts`)와 **dist 실행본(`.js`)** 을 찾아,
  `ts.frameworks.join(` 을 `languages` 와 같은
  `.map(f => typeof f === 'string' ? f : f?.name).filter(Boolean).join(', ')` 패턴으로 바꾸고,
  build 루프의 `if (val)` 가드를 `if (typeof val === 'string' && val)` 로 바꾼다.
  🔴 **dist(.js)까지 고쳐야 실제 반영**(hook 은 dist 를 실행). 패턴이 없으면(이미 수정/버전 변경) 건너뛴다.
  단 플러그인 업데이트 시 덮어써지므로, 영구·전파를 원하면 upstream(oh-my-claudecode)에 동일 패치를 리포트한다.

### 6) 보고 (한글)
- 생성/갱신된 페이지와 슬러그 목록.
- lint 결과.
- environment.md 위생: `[object Object]` 정화 여부(및 hook 소스 근본패치 시 그 사실).
- 저장 위치는 `.omc/wiki/*.md`(프로젝트 로컬, git-ignored), 목차 `index.md`, 이력 `log.md`.

## 작성 원칙
- **삭제보다 보존, 중복보다 병합.** 같은 주제는 새 페이지 대신 기존 페이지에 append.
- **비자명성 우선.** "왜 이렇게 했나 / 어떤 함정이 있었나 / 어떻게 재현·검증했나".
- **증거 기반.** 파일:라인, 명령, 측정값, 테스트명으로 뒷받침.
- **상호 링크 적극.** 아키텍처 ↔ 디버깅 ↔ 환경 페이지를 `[[slug]]`로 엮는다.
- wiki는 키워드+태그 검색(벡터 임베딩 없음)이므로 **검색 가능한 tags**를 충분히 단다.
