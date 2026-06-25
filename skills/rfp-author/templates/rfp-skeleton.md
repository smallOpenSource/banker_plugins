# 제안요청서(RFP) 스켈레톤 — 소프트웨어 외주

> 채우는 곳은 〔…〕 / `<placeholder>`. 구조·배점은 [korean-rfp-framework.md](../references/korean-rfp-framework.md) 검증본. SER/AI는 [compliance-and-ai-llm.md](../references/compliance-and-ai-llm.md). 기술요구 실체는 [this-project-scope.md](../references/this-project-scope.md)에 채운 내용.
> 최종 산출물(.docx/.xlsx/.pptx)은 번들 `scripts/md2docx.py` 또는 python-openpyxl/python-pptx로 변환(SKILL.md §산출물).

---

## 1. 사업 개요
- 사업명: 〔`<프로젝트명>`〕
- 목적/배경: 〔…〕
- 사업 범위 요약: 〔`<예: FE + BE + AI 에이전트 + 데이터/마이그레이션 + 외부연계 N종>`〕
- 사업 기간: 〔YYYY-MM ~ YYYY-MM 또는 "제안"〕 · 예산: 〔₩… 또는 "제안"〕 · 계약방식: 〔협상에 의한 계약 등〕

## 2. 현황 및 문제점 (As-Is)
〔현 시스템 개요 — this-project-scope §2 인용, 기밀값 제외. **요건 발의형이면 이 절은 비노출/삭제**〕

## 3. 과업 내용 (To-Be) — 요구사항정의서
### 3.1 과업 범위
〔과업 범위: this-project-scope §1·§3·§9〕

### 3.2 요구사항 목록 (15유형 · 각 7항목 작성표)
유형별로 아래 표를 반복. (분류 체계: korean-rfp-framework §1)

| ①분류 | ②고유번호 | ③명칭 | ④상세설명(testable) | ⑤산출정보 | ⑥관련 | ⑦출처 |
|---|---|---|---|---|---|---|
| SFR | SFR-001 | 〔`<핵심 기능 1>`〕 | 〔`<testable 정의>`〕 | 〔BE API, FE 화면〕 | DAR-001 | `<spec file:LINE>` |
| SFR | SFR-002 | 〔`<핵심 기능 2>`〕 | 〔`<판정/규칙 정의>`〕 | 〔`<컴포넌트>`〕 | SFR-001 | `<DesignRef(page-section)>` |
| PER | PER-001 | 〔캐시·동시성〕 | 〔`<TTL/동시성 상한/latency 목표>`〕 | 〔성능시험 결과〕 | ECR-001 | `<spec §…>` |
| ECR | ECR-001 | 〔시스템 구성〕 | 〔`<N-tier 구성 + DB + 캐시>`〕 | 〔구성도〕 | — | this-project §2 |
| INR | INR-001 | 〔외부연계 N종〕 | 〔`<외부 시스템 계약·인증·타임아웃·TLS>`〕 | 〔연계명세〕 | SER-002 | `<spec §…>` |
| DAR | DAR-001 | 〔데이터 모델〕 | 〔`<스키마, 마스터 규모, 리시드 파이프라인>`〕 | 〔ERD/DDL〕 | SFR-001 | this-project §5 |
| TER | TER-001 | 〔검증 기준〕 | 〔골든 verify(빌드/유닛/통합) + 시각회귀 + e2e〕 | 〔테스트 리포트〕 | QUR-001 | 〔golden 정의〕 |
| SER | SER-001 | 〔보안 일반〕 | 〔CVE/SBOM, 시크릿 비노출, 망분리·PIPA 〈OPEN: 조문 확정 필요〉〕 | 〔보안점검 결과〕 | — | compliance §1 |
| SER | SER-002 | 〔(LLM) 보안〕 | 〔prompt injection direct+indirect 방어, 입력 fail-closed/출력 fail-open〕 | 〔red-team 결과〕 | INR-001 | NIST AI 600-1 §2.9 |
| QUR | QUR-001 | 〔품질/정합〕 | 〔SoT 1:1, (LLM) 사실정확도/grounding 임계 〈OPEN: binary 기준〉〕 | 〔정합 리포트〕 | TER-001 | NIST §2.2 |
| COR | COR-001 | 〔기술스택 고정/호환〕 | 〔`<BE/FE/AI 스택, 금지사항(ORM·migration·SSR 등), 버전 핀>`〕 | — | ECR-001 | `<spec file:LINE>` |
| PMR | PMR-001 | 〔과업관리〕 | 〔단계·과업심의·진척보고〕 | 〔관리계획〕 | — | korean §4 |
| PSR | PSR-001 | 〔지원/형상〕 | 〔인력·형상관리·산출물관리〕 | — | — | — |
| MPR/MHR | MPR-001 | 〔유지관리〕 | 〔하자보수 기간·운영이관·유지인력 등급〕 | — | — | korean §5 |

### 3.3 SoT(원본자료) 제공 범위
〔spec / 디자인 PDF(`<DesignRef(page-section)>`) / 인벤토리 / 카탈로그 제공 — **기밀값(시크릿·실데이터·외부토큰) 제외**. 〈OPEN: 전달방식 확정 — research-provenance §4〉〕

## 4. 제안서 작성 요령
- 제안서 목차/규격/분량: 〔…〕 · 제출 서식: 별첨 〔…〕

## 5. 제안서 평가 (korean-rfp-framework §3)
| 구분 | 배점 | 비고 |
|---|---|---|
| 기술능력평가 | **80** | 정성평가 + 정량평가(정량 **≤20**) |
| 입찰가격평가 | **20** | |
| 합계 | 100 | |
- 정성평가 세부(SW/시스템 개발 = 별표3의2 차용): 〔사업이해도/구현방법론/기술스택 적합성/AI·보안 역량/일정·관리/유지보수 …배점〕
- 정량평가(별표8-14): 〔경영상태/수행실적/책임성·성실성/상생협력/하도급 적정성/SW기술자료임치/정량필수제안〕
- 직발주 벤더 RFP면 간이배점(기술40/보안30/일정·관리20/가격10 등, vendor-rfp-structure §2) 사용 가능.
- ★ "분야별 ±10점 가감" 같은 rule **금지**(반증 R1).

## 6. 입찰 유의사항 / 계약 조건 (compliance §3)
- IP: 저작권·상표 포함 **전부 발주자 귀속** — 계약에 *"and hereby assigns"* 명시(★default는 개발사 보유, 명시 필수).
- 검수: deliverable별 명시·testable 기준 + 단계 UAT(단일 30일 deemed-acceptance 의존 금지).
- 비밀유지·손해배상·준거법(한국법)·변경(서면). 〈Korean law 법무 검토〉

## 7. 산출물 및 추진일정 (마일스톤)
| 단계 | 산출물 | 지급 | 비고 |
|---|---|---|---|
| M1 데이터/BE 계약 | 〔DDL/스키마, API/OpenAPI, 외부화 SQL〕 | 〔%〕 | 빌드 순서 |
| M2 FE 렌더 | 〔`<화면 dist, 시각회귀 통과>`〕 | 〔%〕 | |
| M3 AI/보안 오케스트레이션 | 〔LLM 파이프라인, 외부연계, red-team〕 | 〔%〕 | |
| M4 통합검수/이관 | 〔골든 통과, 운영문서, 하자보수 착수〕 | 〔%〕 | |

## 8. 하자보수 / 유지관리
〔하자보수 기간·범위(MPR), 유지보수 인력등급(MHR)〕

## 9. 보안 및 규제 준수 (SER — compliance §1·§2)
- 금융 위탁(해당 시): 「금융회사 정보처리 업무 위탁 규정」(고시 2021-9호) 준수.
- 클라우드 사용 시: 전자금융감독규정 제14조의2 + **FSI CSP 안전성 평가 통과 CSP만** + 정보보호위 심의·금감원 사전보고.
- AI/LLM: NIST AI 600-1 매핑(환각률·prompt injection direct+indirect·value-chain/SBOM traceability).
- 〈OPEN: 망분리·PIPA·보안성심의·secure-coding 조문 확정 필요 — provenance §4〉

## 10. 별첨
요구사항 작성표 전체 · SoT 인덱스 · 제출서식 · 평가표 양식(.xlsx).
