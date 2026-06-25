# 금융 규제 준수(SER) · AI/LLM 외주 특수요건 · 국제 계약 layer

> deep-research 검증 결과. 한국 골격([korean-rfp-framework.md](korean-rfp-framework.md))에 **금융규제 + AI/LLM 위험 + 국제 계약절**을 보강.
> ★ source-strength 차이: 한국 규제·NIST는 **primary(고신뢰)**, 국제 계약절은 **template-vendor 근거(jurisdiction-stable이나 Korean law 검토 필요)**. [research-provenance.md](research-provenance.md) 참조.

## §1. 금융 IT 외주/위탁 규제 (직접 인용 SoT — SER 요구의 근거)

- **「금융회사의 정보처리 업무 위탁에 관한 규정」** — 금융위원회고시 **제2021-9호**(시행 2021-03-25, 현행). 금융사 IT/정보처리 업무를 외부에 위탁할 때의 **1차 규제 SoT**. (구명 "정보처리 및 전산설비의 위탁에 관한 규정"에서 '전산설비' 삭제된 현행명.)
- **전자금융감독규정 제14조의2**(클라우드컴퓨팅서비스 이용절차 등) — **시행 2025-02-05**(금융위 고시 제2025-4호). 의무 절차: **CSP 안전성 평가 → 정보보호위원회 심의·의결 → 클라우드 이용계약 체결 → 금융감독원 사전보고**. (원문: *"…CSP 안전성 평가 등을 수행한 후 정보보호위원회의 심의·의결을 거쳐 클라우드 이용계약을 체결하고 금융감독원에 사전보고하여야 한다."*)
- **FSI(금융보안원) 클라우드 이용 가이드(2025년 개정, 2025-05-22)** + **CSP 안전성 평가 통합지원시스템**(csp.fsec.or.kr). ★핵심: **금융사 자체 CSP 평가 불가** — FSI가 수행·공유. 통과 CSP 예: Databricks, Kakao Enterprise, NHN Cloud, Naver Cloud.
  - → **RFP 요건화**: 외주사가 사용하는 클라우드/CSP는 **FSI 안전성 평가 통과본**일 것을 SER 요구로 명시 가능.

> ★ **보강 완료(2026-06-03 2차 deep-research)**: 망분리·PIPA·보안성심의·secure-coding은 **§4**에서 1차 출처로 보강(전자금융감독규정 제14조의2·금융위 망분리 로드맵·PIPA 제26조·구축운영지침 제52조). 잔여(규정 현행 호수·신용정보법 본문)는 [research-provenance.md](research-provenance.md) OPEN-r1/r2.

## §2. AI/LLM 외주 특수요건 — NIST AI 600-1 매핑 (SER/QUR)

**NIST AI 600-1**(Generative AI Profile, AI RMF 1.0 동반, 2024-07) — **12 GenAI 위험범주**(primary PDF verbatim 검증):
CBRN · **Confabulation** · Dangerous/Violent/Hateful Content · Data Privacy · Environmental Impacts · Harmful Bias/Homogenization · Human-AI Configuration · Information Integrity · **Information Security** · Intellectual Property · Obscene/Degrading/Abusive Content · **Value Chain and Component Integration**.

LLM 에이전트 + retrieval 구조에 직결되는 3범주를 RFP 요구로 구체화:

1. **Confabulation(=환각/hallucination)** — NIST §2.2: GenAI가 *오류·허위를 자신있게 제시*(입력과 괴리 또는 이전 진술과 모순), next-token 통계근사의 자연결과.
   → **QUR/검수 요구**: 환각을 "옵션"이 아닌 **측정 acceptance metric**으로. 예: 사실정확도/grounding 임계, 응답-출처 정합. (단일 JSON 응답 + grounding 구조에 맞춰 binary-testable화 — open question.)
2. **Prompt Injection (DIRECT vs INDIRECT)** — NIST §2.9: **direct**(공격자가 악성 프롬프트 직접 입력) vs **indirect**(검색될 데이터에 원격 주입). OWASP LLM Top 10 **#1**.
   → **SER 요구**: 검색엔진 + 도메인 에이전트 + 보안필터의 retrieval 구조이면 **둘 다 방어** mandate(일반 입력검증만으론 부족). 입출력검증·fail정책을 요구로 박제.
3. **Value Chain & Component Integration** — NIST §2.12: 데이터셋·사전학습 모델·SW 라이브러리 등 3rd-party 구성요소의 미검증/불투명 위험(GenAI는 학습데이터 규모·foundation model 재사용으로 가중).
   → **SER/DAR 요구**: **데이터셋 출처, base model(on-prem/airgap vs 외부 API) 버전 핀, OSS 의존성(SBOM) traceability** 외주사 공시 의무화. (CVE/의존성 스캔 posture와 정합.)

> 모델/프로바이더 조달 계약문구(데이터 residency, no-training, 모델버전 핀, 스트리밍/비스트리밍 SLA)는 **§4에서 차용 모델(美 WA GenAI 조달조항·EU MCC-AI)로 보강**.

## §3. 국제 SW 개발 계약 layer (산출물·검수·IP·하자·마일스톤)

표준 SW 개발 계약 절(국제 모범사례, template-vendor + 법무 secondary 근거):

- **계약 구성**: Developer's Duties · Delivery · Compensation · **IP Rights** · Change in Specifications · Confidentiality · **Warranties** · Indemnification · amendment-in-writing · Applicable Law + **Exhibit A(Specifications)** + **Exhibit B(Milestone schedule)**.
- **IP 귀속**: 발주자가 인도물 권리를 보유하려면 **저작권·상표 포함 전부 발주자 귀속**을 계약에 명시. ★주의: 법적 **default는 반대**(개발사가 저작권 보유) → **계약에 명시 필수**, 현재형 양도문 **"and hereby (does) assign"** 권장(미래형 "will hold"보다 강함).
- **검수(Acceptance)**: 표준은 **인도 후 30일 내 서면 부적합 통지**(미통지 시 deemed-acceptance). ★복잡 시스템은 **단계별 UAT + deliverable별 명시·testable 기준** 권장(단일 30일 deemed-acceptance에 의존 금지).
- **하자보수/Warranty**: 인도물의 규격 정합 보증 + 하자보수 기간(한국 골격 MPR/MHR과 연계).
- **마일스톤 지급**: Exhibit B에 단계별 산출물↔지급 연동. → 프로젝트의 **layer-by-layer 빌드순서**(예: 데이터/BE 계약 → FE 렌더 → AI 에이전트/보안 오케스트레이션)에 마일스톤 정렬 권장(open question).

> ★ **CAVEAT**: 국제 계약절은 PandaDoc 등 reputable template + 법무 secondary 근거 — **Korean-financial-law 특화 계약 아님**. IP 양도·검수기간 등은 **한국법 하 법무 검토** 후 확정. 절 구조·IP-assignment 원칙은 jurisdiction-stable.

## Sources (primary/secondary)
- 금융회사 정보처리 업무 위탁 규정(고시 2021-9호) / 전자금융감독규정 14의2: https://www.law.go.kr
- FSI 클라우드 가이드: https://www.fsec.or.kr/bbs/detail?menuNo=222&bbsNo=11691 · CSP 평가: https://csp.fsec.or.kr · FSC: https://www.fsc.go.kr
- NIST AI 600-1: https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf (§2.2/§2.9/§2.12) · OWASP LLM Top 10
- 국제 계약: https://www.pandadoc.com/software-development-agreement-template/ (+ 법무 secondary)
- 상세 인용·confidence·caveat: [research-provenance.md](research-provenance.md)

## §4. 보강 — 금융 보안규제 · LLM 조달/평가 (2026-06-03 2차 deep-research, 한국 1차 출처)

### 망분리 (network separation)
- 근거 = 전자금융감독규정(행정규칙, law.go.kr). 클라우드로 개인신용정보 처리 시 **정보처리시스템 국내 설치 = 제14조의2 제8항**.
- **2024-08-13 금융위 「금융분야 망분리 개선 로드맵」**(fsc.go.kr/no010101/82885): 연구·개발망 물리적→**논리적 망분리** 허용(1단계 가명정보), 소스코드 망간 이동 편의 확대; 생성형 AI는 **규제샌드박스** 인터넷 활용 특례(보안대책 조건); **스테이징부터 내부망 수행**(상세지침 *예시*). 필요조치=전자금융감독규정+시행세칙 개정.
- ★현행 발효 고시 호수·개정일 미확정(refute) → 호수 인용 금지(OPEN-r1).

### 개인정보(PIPA)
- 외주 = **처리위탁 제26조**(수탁자 교육·감독, 범위초과/제3자 금지, 재위탁 동의, 위탁내용 공개). 현행 [시행 2025-10-02][법률 제20897호].
- 가명정보 = **제2조제1호 다목**(정의)·**제28조의2**(처리)·**제28조의3**(결합 제한). 가명처리=제2조제1호의2.
- 신용정보법 제3조의2·제32조는 1차 본문 미확보(casenote 2차)→법무 재확인(OPEN-r2). PIPA 「안전성 확보조치 기준」 고시 현행 호수 미확정(OPEN-r1).

### secure-coding (SW 개발보안)
- 발행기관=**행정안전부**(KISA 기술집필): 「SW 개발보안 가이드」·「SW 보안약점 진단가이드」.
- 법적 앵커 = 「행정기관 및 공공기관 정보시스템 구축·운영 지침」 **제52조 + [별표 3] 소프트웨어 보안약점 기준**(입력검증·보안기능·에러처리·코드오류·캡슐화·API오용 등). ★민간기업엔 **직접 강제 아님 = de-facto baseline**. 항목 수(47/49) 출처별 상이→수치 인용 금지.

### LLM 조달 계약문구 (차용 모델)
- **美 워싱턴주 GenAI 조달조항(des.wa.gov, 2025-04-01)**: residency('not store/use/transmit agency Data outside of the United States') + no-training('shall not use [Agency] data to train…GenAI except with express written authorization'). CA 사법부 near-identical. ★draft·covenant·관할 美 → '대한민국' 치환·한국법 검토.
- **EU AI Model Contractual Clauses(MCC-AI, EC DG GROW, 2023-09/2025-03)**: high-risk full/light, 자발적·non-binding 모델.
- 한국 근거: 금융위 망분리 로드맵 「계약시 반영 필수사항(예시)」=데이터 처리·저장 위치+변경 사전통지 / 목적 외 활용 금지 / 당국·금융회사 접근·검사·감사권+중요문서 현장반출권.

### LLM 품질·보안 검수 (방법론)
- **OWASP Top 10 for LLM Applications 2025**: LLM01 Prompt Injection·LLM02 Sensitive Info Disclosure·LLM03 Supply Chain·LLM04 Data/Model Poisoning·LLM05 Improper Output Handling·LLM06 Excessive Agency·LLM07 System Prompt Leakage·LLM08 Vector/Embedding·LLM09 Misinformation·LLM10 Unbounded Consumption. (구판과 상이 — 2025판 명시.)
- prompt-injection red-team = **OWASP LLM01:2025 Prevention #7**(adversarial testing). 임계는 RFP가 부여 → ASR(Attack Success Rate) 게이트 예시(예: 500케이스 ASR<5%·데이터추출 0). ★임계 수치 1차 미확정(OPEN-r3) — NCSC/OWASP: prompt injection 완전해결 불가, zero-tolerance 비현실적.
- RAGAS faithfulness/groundedness = 환각 측정 지표군(합격선 수치 미확정=OPEN-r3).

### SoT 기밀 전달 모델
- 보안 격리망(VDI/secure enclave) 열람 + 마스킹/가명화(PIPA 제28조의2) + NDA·반출통제 + 위 「계약시 반영 필수사항」. 금융보안원 「연구·개발 목적의 망분리 예외 보안 해설서」(2025-04-30) 후보(미정밀조사).

### Sources (보강, primary)
law.go.kr(전자금융감독규정 admRulSeq=2100000247014 / PIPA lsId=011357 / 구축운영지침 admRulSeq=2100000197311) · fsc.go.kr/no010101/82885(망분리 로드맵 PDF) · pipc.go.kr · mois.go.kr(SW 개발보안·진단가이드) · data.go.kr(15049185) · owasp.org(LLM Top10 2025·LLM01) · des.wa.gov(WA GenAI 조항) · public-buyers-community.ec.europa.eu(MCC-AI).
