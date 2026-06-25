---
name: arch-diagram
description: "시스템 아키텍처/계층 구성도를 PlantUML(소스+PNG 렌더)과 python-pptx(편집가능 PPTX, 네이티브 도형)로 산출하는 워크플로우. 산출물은 output/architecture/(설정 가능). PlantUML jar(tools/plantuml-epl-*.jar)+graphviz로 렌더·문법검사하고, python-pptx로 네이티브 도형(rectangle/실린더/큐브/클라우드)+화살촉 커넥터+CJK 폰트 빌드. soffice 미설치 환경에선 pptx를 재오픈 구조검증(슬라이드/커넥터/화살촉/경계)으로 검증하고 픽셀렌더는 Unknown 명시. 토폴로지는 코드 실측(config·yml·라우팅 코드 file:LINE), 외부 인프라는 미검증 표기. 넘겨짚기 금지·verify-before-claim·커밋은 stage→git diff --cached 검토→commit. '아키텍처 다이어그램' / 'plantuml' / 'pptx 다이어그램' / '구성도' / '시스템 계층도' / '아키텍처 그림' 시 사용."
---

# arch-diagram — PlantUML + PPTX 아키텍처 다이어그램 산출

시스템 아키텍처/계층 구성도를 **코드 산출물**(PlantUML 소스 + PNG 렌더 + 편집가능 PowerPoint)로 만든다.
self-contained: 이 `SKILL.md` + `build_pptx_template.py`(데이터 주도 pptx 빌더 템플릿).

## When to use
- "아키텍처 다이어그램", "구성도", "시스템 계층도", "plantuml", "pptx 다이어그램", "아키텍처 그림"을 만들/고칠 때
- 계층/의존 트리(FE→BE→DB, 외부 서비스 연계 등)를 소스(puml)+렌더(png)+편집가능 덱(pptx)으로 동시 산출할 때

## 환경 / 사전요구 (예시 — 대상 박스에 맞게)
- PlantUML jar: `tools/plantuml-epl-*.jar` + `java`(예: 21) + **graphviz `dot`**(component/description 레이아웃 필수)
- **python-pptx** (`python3`)
- **CJK 폰트**(예: Noto Sans CJK) → PlantUML PNG 한글 정상
- ⚠️ **libreoffice/soffice 없으면** → pptx 픽셀 렌더 불가(구조검증만)

## 워크플로우
1. **토폴로지 확정 (코드 실측, 넘겨짚기 금지)**: 노드·엣지를 FE 설정(예: `config.json`의 apiBaseUrl/llmBaseUrl)·BE 설정(예: `application-*.yml`의 DB/캐시)·라우팅 코드(예: LLM→외부 호출) 등 file:LINE으로 확인. 코드에 없는 외부 인프라(GPU·생성형AI플랫폼 등)는 사용자 확인 + "미검증" 표기.
2. **PlantUML 작성** → `output/architecture/<name>.puml`. **인라인 색상**(`rectangle "Frontend\n:8080" as FE #E1F5FF`). 좌→우 트리는 `left to right direction`. shape 의미: `rectangle`(서비스)·`database`(DB 실린더)·`node`(HW/GPU 큐브)·`cloud`(외부 플랫폼).
3. **문법검사**: `java -jar tools/plantuml-epl-*.jar -checkonly <puml>` (exit 0). 실패 시 `cat <puml> | java -jar <jar> -syntax`로 **오류 라인 특정**.
4. **PNG 렌더 + 육안검사(필수)**: `java -jar <jar> -tpng <puml> -o output/architecture`. 출력명 = `@startuml <name>` → 원하는 파일명으로 `mv`. Read(이미지)로 **직접 육안확인**(한글 tofu·레이아웃·shape).
5. **편집가능 PPTX 빌드**: `build_pptx_template.py` 복사·수정(NODES/EDGES/OUT/TITLE) → `python3` 실행 → `output/architecture/<name>.pptx`. 네이티브 도형이라 PowerPoint에서 이동/편집 가능.
6. **PPTX 구조검증**(soffice 無): 재오픈해 슬라이드 수·커넥터(`p:cxnSp`)·화살촉(`a:tailEnd`)·경계이탈 0·노드 텍스트 확인. **픽셀 렌더는 "Unknown" 명시**(시각은 동일 토폴로지 PNG로 대체).
7. **배치 + 커밋**: 산출물(puml/png/pptx) → `output/architecture/`. 커밋은 **`git add <명시경로>` → `git diff --cached --stat` 검토 → commit**(인덱스 전체가 커밋되므로 pre-staged 혼입 방지). push는 사용자 "push" 시.

## 함정 (실측, 반드시 회피)
- **★PlantUML stereotype 중첩 skinparam 금지**: `skinparam rectangle { BackgroundColor<<x>> #.. }` 블록 → "Assumed diagram type: sequence" 문법오류(exit 200). → **인라인 색상** `as X #RRGGBB` 사용.
- **렌더 출력 파일명** = `@startuml` 뒤 name. 원하는 파일명과 다르면 `mv` 필요.
- **python-pptx 화살촉**: connector에 `conn._element.spPr.get_or_add_ln()` 얻어 `a:tailEnd`(type=triangle) append(line.color 설정 후). add_connector만으론 화살표 없음.
- **python-pptx 한글**: run의 `<a:latin>`+`<a:ea>`+`<a:cs>` typeface 모두 지정(ea 누락 시 일부 뷰어 tofu).
- **pptx 픽셀 렌더 불가**(soffice 無): 구조검증으로 대체, 시각은 PlantUML PNG로.

## verify-before-claim (DoD)
"완료" 전 4-field: ① 변경 파일(git diff --stat) ② Evidence(checkonly exit 0 / PNG 육안 / pptx 구조검증 커넥터·화살촉 수) ③ 검증 layer ④ Unknown(pptx 픽셀렌더·외부 인프라 미검증). ⏳ 0일 때만 "완료".

## 참고
- 빌더 템플릿: `build_pptx_template.py`(이 디렉터리) — 데이터 주도(NODES/EDGES), 화살표 자동 라우팅(parent right-center → child left-center)
- 산출 예시: `output/architecture/<name>.{puml,png,pptx}`
