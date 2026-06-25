---
name: rfp-author
description: "특정 소프트웨어 프로젝트를 외부 IT 기업에 외주(요건 발의형 기본 — 동일재구현이 아니라 요건만 발의)하기 위한 제안요청서(RFP)를 하이브리드 골격(한국 공공/금융 제안요청서 + 국제 SW외주 + AI/LLM 특수요건)으로 저작. 검증된 reference(요구사항 15유형·7항목 작성표·평가 80/20, 금융규제 전자금융감독규정14의2/FSI CSP/위탁규정 2021-9, NIST AI 600-1 12위험, 국제 계약 IP/검수/마일스톤)와 채울 수 있는 rfp-skeleton 템플릿을 bundle. 도구 오케스트레이션(deep-dive→과업추출 / ralplan→구조합의 / team·writer→섹션작성 / verify→검수 / scripts/md2docx.py→산출물)으로 진행. 반증된 주장(±10점 분야별 가감·구법 제20조③·인터페이스 prefix 오기) 금지, currency(2020 소프트웨어 진흥법) 준수, 기밀값 누출 금지, IP default 주의, 미검증 항목 〈OPEN〉 정직 표기. verify-before-claim. 'rfp' / '제안요청서' / 'RFP 작성' / '외주 RFP' / '제안서' 시 사용."
---

# rfp-author — 외주 제안요청서(RFP) 저작 (요건 발의형 기본)

특정 소프트웨어 프로젝트를 외부 IT 기업에 외주하는 RFP를, 검증한 **하이브리드 골격**(한국 공공/금융 제안요청서 + 국제 SW외주 모범사례 + AI/LLM 특수요건)으로 저작한다.
이 skill은 **self-contained 번들**(`SKILL.md` + `references/` + `templates/` + `scripts/`) — 검증 지식·템플릿·변환 스크립트를 함께 들고 다닌다.

> ★**기본 모드 = 요건 발의형**: PoC/기획 단계에서는 "동일재구현"이 아니라 기능·기술·보안·비기능 **요건만 발의**한다(제안사가 충족 방안을 제안). 벤더 발송본엔 현황(As-Is)·내부 SoT file:LINE·호스트/포트·내부식별자 비노출, 기획(planned)은 요건으로 공개. 실제 산출 구조 = [references/vendor-rfp-structure.md](references/vendor-rfp-structure.md). 동일재구현(스택을 제약으로 고정)이 명확한 경우에만 그 프레이밍을 선택.

## When to use
- "rfp", "제안요청서", "RFP 작성", "외주 RFP", "제안서", "외주 발주 문서"를 작성/검토할 때
- 어떤 소프트웨어 프로젝트(특히 풀스택+AI 시스템)를 **외주(요건 발의형)**하는 요구기능·기술/보안/비기능 요건·평가배점·계약조건을 만들 때
- 기존 RFP 초안의 **인용·반증경계·규제 currency**를 검증할 때

## 핵심 원칙 (불변)
1. **반증된 주장 금지** ([research-provenance.md](references/research-provenance.md) §2): ① 조달청 "±10점 분야별 가감" rule(0-3, 그런 rule 없음) ② 요구상세화가 구 「소프트웨어산업 진흥법」 제20조③ 법적의무(0-3, 구법 폐지) ③ 인터페이스 prefix `SIR`(실제 `INR`).
2. **currency**: 법적근거는 **2020 「소프트웨어 진흥법」**(제44조/제50조) 인용. 구법 인용 금지.
3. **기밀 누출 금지**: SoT 전달·과업내용에 **시크릿·실데이터·외부 토큰 값** 절대 미기입(구조/요건만). `.env.*`·키·실패스워드·실제 호스트/포트 비노출.
4. **IP default 주의**: 저작권 default는 **개발사 보유** → 발주자 귀속은 **계약 명시 필수**("hereby assigns" 현재형 양도). 빈말("IP는 우리 것") 금지.
5. **OPEN 정직 표기**: 미검증 항목(예: 망분리/PIPA 조문 현행 호수·LLM 계약문구·LLM eval binary 임계·SoT 전달방식)은 RFP에 **〈OPEN〉**으로 명시하고 추가 리서치/법무 검토 표시. "정합 OK"/"아마도" 금지.
6. **verify-before-claim**: 모든 수치·조문·배점은 `references/`로 추적(인용 동반). 완료 전 4-field(① 변경 ② Evidence ③ 검증 ④ Unknown), ⏳=0일 때만 "완료". 커밋/푸시는 사용자 명시 시만.
7. **쪽번호·인용 의무**: 디자인/문서 SoT(예: 디자인 데크 PDF의 N쪽, 인용키 `<DesignRef(page-section)>`) 인용 시 **page-NNN/쪽번호 직접 기록**. file:LINE/page 없는 "정합 OK" 금지.
8. **벤더 노출 게이트**: 발송본엔 현황(As-Is)·내부 SoT file:LINE·실제 호스트/포트·내부식별자(보안필터 제품명/내부 테이블 prefix/모델ID)·"deep-research"/추적박스·em-dash(`—`→`-`) 비포함. 내부 추적은 `references/`에만.

## 번들 구성
| 파일 | 내용 | 신뢰도 |
|---|---|---|
| [references/korean-rfp-framework.md](references/korean-rfp-framework.md) | 요구사항 15유형 + 7항목 작성표 + 평가 80/20 + 목차 + 법적근거 | primary 검증 |
| [references/compliance-and-ai-llm.md](references/compliance-and-ai-llm.md) | 금융규제(전금감14의2/FSI CSP/위탁규정) + NIST AI 600-1 12위험 + 국제 계약절 | 한국·NIST primary / 국제계약 template+법무 |
| [references/this-project-scope.md](references/this-project-scope.md) | 프로젝트별 과업내용/산출물/기술요구(SFR/PER/ECR/INR/DAR/SER/COR…) 채우는 **빈 템플릿** | 프로젝트 SoT로 채움 |
| [references/research-provenance.md](references/research-provenance.md) | 출처·confidence·**반증 항목**·caveat·**OPEN 항목** | 추적성 백본 |
| [references/vendor-rfp-structure.md](references/vendor-rfp-structure.md) | ★**요건 발의형 벤더 RFP 10절 구조** + 간이배점 + 물량 명시 + 노출 게이트 | 실증 레시피 |
| [templates/rfp-skeleton.md](templates/rfp-skeleton.md) | 채울 수 있는 10절 제안요청서 + 7항목표 + 평가표 + 마일스톤 | 템플릿 |
| [scripts/md2docx.py](scripts/md2docx.py) | md→docx 변환(한국어 폰트·고정폭 표·페이지번호). pandoc/soffice 부재 환경용 → python-docx | 도구 |

## 워크플로우 (도구 오케스트레이션)
RFP 저작은 **저작 lane과 검수 lane을 분리**(자기승인 금지). 권장 순서:

1. **과업내용 추출** — 현 코드/spec → 요구사항. `deep-dive`(또는 agent `feature-dev:code-explorer`)로 화면·API·데이터·외부연계를 SFR/INR/DAR로 도출 → `references/this-project-scope.md` 채움(file:LINE 동반). 디자인은 PDF/이미지 추출 도구로 `<DesignRef(page-section)>` 형태 인용키 추출.
2. **구조·범위·배점 합의** — `ralplan --deliberate`로 RFP 구조·15유형 범위·평가 정성/정량 배점을 Planner→Architect→Critic 합의(Planner는 SoT word-for-word 인용 의무). broad/risky 결정만.
3. **섹션 병렬 작성** — 5+ 섹션이면 `team`(워커별 절 담당), 소규모는 agent `oh-my-claudecode:writer`. 각 절은 `templates/rfp-skeleton.md`를 채우고 `references/`를 인용.
4. **미검증 보강** — OPEN 항목(특히 망분리/PIPA/보안성심의/secure-coding)은 `autoresearch`/`deep-research` 또는 agent `document-specialist`로 **추가 리서치 후** SER에 반영. 미보강 시 〈OPEN〉 유지.
5. **검수(별도 lane)** — agent `oh-my-claudecode:critic` 또는 `verify`로 ① 반증 항목 미혼입 ② currency(2020 진흥법) ③ 인용 추적성 ④ 기밀 누출 0 ⑤ 배점 합(80+20 또는 채택 배점) 검증.
6. **산출물 변환** — 아래 §산출물.

| 작업 | 권장 도구 |
|---|---|
| 과업내용 추출(코드→요구) | `deep-dive` / `feature-dev:code-explorer` / PDF·이미지 추출 도구 |
| 구조·배점 합의 | `ralplan --deliberate` |
| 섹션 병렬 저작 | `team` / `oh-my-claudecode:writer` |
| OPEN 추가 리서치 | `autoresearch` / `deep-research` / `document-specialist` |
| 검수(반증·인용·기밀) | `oh-my-claudecode:critic` / `verify` / `pr-review-toolkit:comment-analyzer` |
| 산출물(.docx) | 번들 `scripts/md2docx.py` · (.xlsx/.pptx는 python-openpyxl/python-pptx) |

## 산출물 변환 (md → docx)
**pandoc/soffice 부재 환경 + Anthropic docx/pptx Agent Skill 미동작**(claude.ai/API/AWS/Foundry 런타임 전용)일 때 → 번들 **`scripts/md2docx.py`**(python-docx) 사용:
- 실행: `python scripts/md2docx.py <in.md> <out.docx> [폰트]`. 처리: 한국어 폰트(`w:rFonts` ascii/hAnsi/**eastAsia**/cs — eastAsia 누락 시 한글 깨짐)·헤딩·타이틀 20pt·blockquote 8pt italic·불릿·**굵게**·**고정폭 표**·footer **페이지번호**(PAGE 필드).
- ★**표 컬럼폭 함정**: 고정 레이아웃(`w:tblLayout type=fixed`)에서 Word는 `cell.width`가 아니라 **`w:tblGrid/w:gridCol@w:w`(twips=inch×1440)**로 렌더 → gridCol에 직접 set해야 비균등폭(미설정 시 균등폭으로 보임). 맨왼쪽 컬럼은 셀 텍스트 길이로 fit-content(CJK ~0.14"/ascii ~0.08"), 나머지 균등(합 6.5").
- xlsx 평가배점표·pptx 요약은 python-openpyxl/python-pptx 직접. Anthropic docx/xlsx/pptx/pdf Agent Skill은 API/claude.ai 런타임에서만 동작.

## 함정 (반드시 확인)
- **반증 혼입**: ±10점 가감·구법 제20조③·`SIR` — 그럴듯해서 새어들기 쉬움. 검수 lane에서 grep.
- **stale citation**: "spec 정합"식 빈말 금지 — file:LINE/`<DesignRef(page-section)>`/조문번호 직접 인용.
- **source-strength 혼동**: 한국 규제·NIST=primary, 국제 계약절=template+법무 secondary(한국법 검토 전 mandate처럼 단정 금지). IP-assignment default는 반대.
- **OPEN을 채운 척**: 미검증 항목을 합성으로 메우지 말 것. 〈OPEN〉 + 추가 리서치 경로 표기.
- **배포 환경 혼동**: 운영 타깃 구성(웹서버/WAS/HTTP 버전 등)을 ECR로, dev simple-run divergence는 참고로만(this-project §운영/dev 구분).
- **벤더 문서 내부누출**: 요건 발의형 벤더 RFP에 내부 SoT `file:LINE`·실제 호스트/포트·내부식별자(보안필터 제품명·내부 테이블 prefix·모델ID)·"deep-research"/추적박스 **절대 비포함**. 내부 추적은 `references/`에만(검수 lane grep).
- **md→docx 표 균등폭**: §산출물 gridCol 함정 — `cell.width`만 set 시 표가 균등폭으로 렌더. `w:gridCol@w:w` 직접 set.

References: `references/*` (5종 — vendor-rfp-structure 포함) · `templates/rfp-skeleton.md` · `scripts/md2docx.py`.
