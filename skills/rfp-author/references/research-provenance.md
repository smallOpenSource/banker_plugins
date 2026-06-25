# 리서치 출처·검증·반증·미검증 (RFP 주장 추적성)

> deep-research 워크플로우 **1차**(2026-06-03, 108 에이전트 · 26 소스 fetch · 99 claim 추출 · **25 검증 → 22 confirmed / 3 killed** · 합성 후 13). 5 각도. **OPEN 2차 보강은 §6**(107 agent · 20 confirmed / 5 killed).
> ★ 이 문서는 RFP의 **verify-before-claim 백본** — [korean-rfp-framework.md](korean-rfp-framework.md)·[compliance-and-ai-llm.md](compliance-and-ai-llm.md)의 모든 수치가 여기로 추적됨.

## §1. Confirmed (3-0, 신뢰) — 핵심 13
1. 한국 공공 SW RFP = NIPA/SWIT 요구사항정의 방법론, 현행 근거 「소프트웨어 진흥법」(2020) 제44조/제50조.
2. 요구사항 **15유형** + 3-letter ID(SFR/PER/ECR/INR/DAR/TER/SER/QUR/COR/PMR/PSR/MPR/MHR/CNR/ENR) + **7항목 작성표**.
3. 평가 **기술 80 + 가격 20**, 정량 cap ≤20, 정성 별표3의2, 정량 별표8-14, 배점한도 정보시스템 구축·운영 지침 제18조.
4. 전자금융감독규정 **제14조의2** 클라우드(시행 2025-02-05) + FSI CSP 안전성 평가(의무, 자체평가 불가).
5. 「금융회사 정보처리 업무 위탁 규정」 고시 **제2021-9호**(현행).
6. 국제 SW 계약 표준절(Duties/Delivery/Compensation/IP/Change/Confidentiality/Warranty/Indemnification/Law + Exhibit A·B).
7. 검수 = 인도 후 **30일 서면 부적합 통지**(deemed-acceptance); 복잡 시스템은 multi-stage UAT 권장.
8. IP 전부 발주자 귀속(★default 반대 — 계약 명시 + "hereby assigns" 권장).
9. NIST AI 600-1 **12 위험범주**(GenAI Profile, 2024-07).
10. Confabulation(환각) = 환각률 acceptance metric 근거(§2.2).
11. Prompt injection **direct vs indirect** 둘 다 방어(§2.9, OWASP LLM #1).
12. Value Chain & Component Integration = 데이터셋·base model·OSS traceability(§2.12).
13. Anthropic Agent Skills(docx/pdf/pptx/xlsx) + custom SKILL.md(frontmatter name/description + bundled resource/template).

## §2. ★반증 (REFUTED) — 절대 주장 금지
| # | 반증된 주장 | vote | 진실 |
|---|---|---|---|
| R1 | 조달청 "10점 범위에서 분야별 배점한도 가감" rule | **0-3** | 검증된 건 80/20 + 정량 cap ≤20뿐. 가감 rule 없음 |
| R2 | 요구상세화가 구 「소프트웨어산업 진흥법」 제20조③ 법적의무 | **0-3** | 구법 **폐지**. 현행 「소프트웨어 진흥법」(2020)으로 인용 |
| R3 | 인터페이스 prefix `SIR` | **1-2** | 실제 **`INR`**(1차 가이드 원문). SIR은 2차출처 오기 |

## §3. Caveats (드래프트 시 필수 준수)
- **CURRENCY**: 구 소프트웨어산업 진흥법 → **2020 「소프트웨어 진흥법」** 인용(R2). 요구상세화 form 근거도 「관리·감독 일반기준」 → 진흥법 제44조 + 계약·관리감독 지침 제11조로 갱신. (방법론 실체 15유형/7항목/80·20은 불변.)
- **SOURCE-STRENGTH**: 한국 규제·구조(law.go.kr/nipa/swit/fsec) + NIST = **primary 고신뢰**. 국제 계약절([compliance §3]) = **template-vendor(PandaDoc)+법무 secondary** — 계약 규범(협상 가능·jurisdiction-stable)이지 한국금융법 mandate 아님. **IP-assignment의 법적 default는 반대** → 명시 drafting 필수.
- **NORMATIVE vs EMPIRICAL**: 모든 *"RFP는 …해야/할 수 있다"* 는 검증사실 기반 **편집 권고**(소스의 실측 발견 아님).
- **LOCAL VERIFY(이번 세션)**: 조달청 세부기준 PDF verbatim(`/tmp/rfp_pdf.txt` lines 272/282/301), NIST AI 600-1(`/tmp/nist6001.txt` lines 212/272/309/505-509).

## §4. OPEN — 보강 결과 (2026-06-03 2차 deep-research로 ①②④ 해소, 잔여 r1~r3)
- **①망분리/PIPA/보안성심의/secure-coding → 해소**: [compliance §4] 전자금융감독규정 제14조의2·금융위 망분리 로드맵·PIPA 제26조/제28조의2·구축운영지침 제52조+별표3.
- **②LLM 조달 계약문구 → 해소**: 美 WA GenAI 조달조항·EU MCC-AI 차용모델 + 금융위 「계약시 반영 필수사항」.
- **④SoT 전달 → 해소**: 격리망(VDI)+마스킹/가명화+NDA+감사권·반출통제.
- **③LLM eval → 부분**: 방법론(OWASP LLM Top10:2025·LLM01#7 ASR·RAGAS) 확정, 임계 수치 미확정.

**잔여 OPEN(1차 재검증·발주자 확정 필요)**:
- **OPEN-r1**: 전자금융감독규정 현행 발효 고시 호수·개정일 + PIPA 「개인정보의 안전성 확보조치 기준」 고시 현행 호수·시행일 (law.go.kr/pipc 1차 본문). ★refute: 제2024-44호·PIPA 제2023-6호 등 특정 호수 주장 금지.
- **OPEN-r2**: 신용정보법 제3조의2·제32조 verbatim 본문 + PIPA 제26조 중첩/우선 (1차 본문 미확보, casenote 2차).
- **OPEN-r3**: LLM eval 정량 임계치(RAGAS 합격선·prompt-injection ASR cutoff%·red-team 케이스 수) — 방법론만 확정, 수치 발주자 확정.

## §5. Sources
**Primary**: nipa.kr/home/2-8/5437 · swit.or.kr(요구사항 상세화 가이드 2018 PDF) · law.go.kr(조달청 제안서평가 세부기준 / 위탁규정 / 정보시스템 구축·운영 지침 / 소프트웨어 진흥법) · moef.go.kr(계약예규) · fsec.or.kr(FSI 클라우드 가이드) · csp.fsec.or.kr · nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf · github.com/anthropics/skills · platform.claude.com/docs(agent-skills) · pandadoc.com(SW 개발계약 template).
**Secondary/blog(보강)**: itwiki.kr · itpe.jackerlab.com · arbisoft · netsolutions · stratagem-systems · saigontechnology · tractiontechnology · thehackernews(AI RFP template) · allganize(on-prem LLM) · foxrothschild(OMB LLM 공시 memo) · claudemarketplaces.com.
**Unreliable(claimCount 0, 미채택)**: mcpmarket(rfp-proposal-builder / proposal-writing-specialist) · github danielrosehill/documentation-plugin · intellisoft · law.go.kr 전자금융감독규정(fetch 실패 — 조문은 wikisource/FSC로 교차확인).

## §6. 2차 보강 리서치 (2026-06-03 · 107 agent · 25 소스 · 25 검증 → 20 confirmed / 5 killed)
**Confirmed(요지, 상세=[compliance-and-ai-llm.md](compliance-and-ai-llm.md) §4)**: 전자금융감독규정 제14조의2 제8항(클라우드 국내설치) · 금융위 망분리 로드맵(논리적 망분리/생성형AI 샌드박스/스테이징 내부망/계약필수사항) · PIPA 제26조·제2조1호다목·제28조의2·제28조의3 · 구축운영지침 제52조+별표3(私기업 de-facto) · WA GenAI 조달조항(residency/no-training)·EU MCC-AI · OWASP LLM Top10:2025·LLM01#7 적대적테스트.
**★REFUTED(주장 금지)**: 전자금융감독규정 "제2024-44호 2024-09-15 현행"(0-3) · 클라우드 이용절차 5단계+항목수 21→18/47→33(1-2) · PIPA 「안전성 확보조치 기준」 "고시 제2023-6호 2023-09-22"(0-3) · 구축운영지침 "제2021-3호 2021-01-19"(0-3, 현행 제2025-1호) · 진단가이드 보유근거=구축운영지침 표현(0-3) → 호수·시행일·단계수치·항목수는 1차 재검증 전 RFP 본문 박제 금지.
**Sources(보강 primary)**: law.go.kr(admRulSeq=2100000247014 전금감 / lsId=011357 PIPA / admRulSeq=2100000197311 구축운영지침) · fsc.go.kr/no010101/82885(망분리 로드맵) · pipc.go.kr · mois.go.kr · data.go.kr/15049185 · owasp.org(LLM Top10 2025) · des.wa.gov(WA GenAI) · ec.europa.eu(MCC-AI). caveat: 해외 템플릿 관할 상이·draft; 한국 1차 일부 호수·eval 임계 미확정(OPEN-r1~r3).
