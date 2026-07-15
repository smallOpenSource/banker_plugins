---
name: harness-factory
description: "(banker) revfactory/harness(팀 아키텍처 팩토리) 플러그인 설치·구성·사용안내. Claude=harness@harness-marketplace, Codex=meta-harness. 'harness-factory'/'하네스 팩토리'/'에이전트팀 생성' 또는 /banker:setup 시 사용."
---

# harness-factory: revfactory/harness 팀 아키텍처 팩토리 설치·구성

`harness`는 도메인을 한 줄로 받아 `.claude/agents/`+`.claude/skills/`(전문 에이전트팀 + 그 에이전트가 쓸
스킬)를 생성하는 **메타 스킬**이다. 이 플러그인의 본체는 설치물이 아니라 **방법론**이다. 따라서 이
스킬은 설치에서 그치지 않고 구성(experimental flag 영속화)과 사용 안내(모드·패턴·비용 가드)까지
책임진다. 이미 설치돼 있으면 갱신·재확인만 한다(멱등). 답변은 한글.

## 런타임 배선
- **Claude Code** = `revfactory/harness` 플러그인(마켓플레이스 설치, 네이티브 팀 프리미티브 사용).
- **Codex** = `SaehwanPark/meta-harness`(별개 레포·Python 인스톨러·파일 handoff). Codex엔 네이티브 팀
  프리미티브가 없어 파일 기반 순차 handoff로 우회한다(banker의 OMX 패턴과 동일 원리).

## 0. 감지 (먼저, 추정 금지)
```bash
command -v claude >/dev/null && claude --version || echo "claude: 미설치"
ls -la .claude/agents .claude/skills 2>/dev/null   # 기존 harness 산출물 흔적 감사
```
- **v2.1.178 경계 주의**: 그 이후 버전은 `TeamCreate`/`TeamDelete` 도구가 제거되고 팀이 세션 시작 시
  자동 구성된다. harness SKILL.md·OMC 문서의 `TeamCreate` 호출 예시가 현행 CLI와 어긋날 수 있다.
  버전을 확인하고 **불일치 가능성을 사용자에게 정직히 고지**한다(가짜 확신 금지).
- 기존 `.claude/agents/`·`.claude/skills/`·`CLAUDE.md`에 harness 흔적이 있으면 신규 생성이 아니라
  확장·유지보수로 다룬다(harness 자신의 Phase 0 감사 원칙).

## 1. 설치
### Claude Code
세션 안(슬래시 커맨드):
```
/plugin marketplace add revfactory/harness
/plugin install harness@harness-marketplace
/reload-plugins
```
- **정답 슬러그는 `harness@harness-marketplace` 하나뿐이다.** 하드코딩한다. 저장소 문서가 3-way로
  어긋나 있으니(KO/JA README=`harness-marketplace`[`harness@` 접두 누락], quickstart=`harness@harness`
  [마켓플레이스 접미 오류]) 그대로 복붙하지 말 것.
- 설치 전 `claude plugin marketplace list`로 등록명을 재확인한다.
- 대안(마켓플레이스 없이 글로벌 스킬 직접 설치): `cp -r skills/harness ~/.claude/skills/harness`.

### Codex CLI
마켓플레이스 개념이 없고 Python 인스톨러를 쓴다:
```bash
git clone https://github.com/SaehwanPark/meta-harness
cd meta-harness
python3 scripts/install_harness.py --scope user --layout codex
# 프로젝트 범위: python3 scripts/install_harness.py --scope project --target <repo> --layout codex
```

## 2. 구성 (핵심)
팀 프리미티브는 **experimental flag로 게이트**된다. 셸 세션이 아니라 `settings.json`에 영속화한다:
```json
{ "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }
```
- 셸 `export`는 **그 셸에서 띄운 claude에만** 적용되어 재시작 후 유실된다. 반드시 `settings.json`
  `env`에 기록해야 영속한다.
- 미설정 시 **에러 없이 조용히 단일 에이전트로 폴백**되어 Pipeline/Fan-out-in/Supervisor/Hierarchical
  패턴이 소리 없이 깨진다(harness 관리자가 `docs/experimental-dependency.md`에 공식 인정). Claude Code
  v2.x+ 필요.

## 3. 사용 안내 (요약; 심층은 설치된 플러그인 references/ 위임)
> harness 자신이 6종 references/(패턴 카탈로그·오케스트레이터 템플릿·팀 예시·skill writing/testing·QA)로
> Progressive Disclosure한다. 여기서는 요약만 담고, 깊이는 설치된 플러그인의 references/를 읽게 위임한다
> (상류 문서를 verbatim 복사하지 않는다).

**(a) 모드 결정트리** (team / subagent / hybrid):
- 2+ 에이전트 + 실시간 상호통신(교차검증·발견 공유)이 가치를 더하면 → **team**.
- 단일 작업·독립 병렬·결과만 반환이면 → **subagent**(경량·토큰효율).
- 공식 비용지침: **순차·동일 파일 편집·의존성 많은 작업은 subagent/단일세션이 유리**하다. harness의
  "2+면 팀 기본"과 어긋날 수 있으니, 팀이 정말 필요한지 재확인하는 게이트를 둔다.

**(b) 6개 아키텍처 패턴**(1줄):
- **Pipeline** (순차 의존): n 출력이 n+1 입력.
- **Fan-out/Fan-in** (병렬+집계): 팀모드가 가장 자연스럽다.
- **Expert Pool** (라우팅 택1): 라우터가 입력 분류 후 전문가 하나 호출, subagent 적합.
- **Producer-Reviewer** (생성·검증): 재시도 캡 2-3(무한루프 방지).
- **Supervisor** (동적 분배): 중앙이 런타임 조건으로 워커 배정.
- **Hierarchical** (재귀 위임): 깊이 ≤ 2(3+는 지연·컨텍스트 손실).

**(c) 비용 가드**: 팀 실행은 단일세션 대비 **약 7× 토큰**(공식). 그러므로:
- 팀 규모 **3-5명**(집중된 3명 > 분산된 5명).
- 워커 모델은 **Sonnet** 기본.
- 작업 완료 즉시 종료. spawn 프롬프트는 간결하게.

## 4. 리스크 고지
harness는 실험적 팀 API에 의존한다. `docs/experimental-dependency.md`가 3시나리오를 자체 정의한다:
- **A** 플래그 제거(GA 승격) / **B** Managed Agents 서버사이드 실행으로 대체 / **C** 하위호환 없는
  시그니처 변경.
- **C는 v2.1.178에서 사실상 현실화된 정황이다**(`TeamCreate`/`TeamDelete` 제거). 설치 시 "실험적 기능
  의존"이라는 사실을 반드시 드러낸다.
- **부작용(read-only 아님)**: 실행 시 사용자 프로젝트에 파일을 직접 생성한다(`.claude/agents/`·
  `.claude/skills/`·중간산출물 `_workspace/`). 기존 파일 충돌 처리·CLAUDE.md 포인터 등록을 안내한다.

## 검증 (보고 의무)
1. **산출물**: `ls -la .claude/agents .claude/skills` 로 에이전트/스킬 파일이 실제 생성됐는지.
2. **flag 영속**: `settings.json`에 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`이 기록됐는지.
3. **팀 스폰**: 간단한 샘플 태스크로 **팀이 실제로 스폰되는지**(무증상 단일 에이전트 폴백이 아닌지).
4. **Codex**: meta-harness 산출물(스킬·`_workspace/` handoff)이 생성됐는지.

보고는 4필드로 한다: **감지(버전·기존흔적) · 설치(플러그인 or meta-harness) · 구성(flag 영속) ·
검증(산출물·팀스폰)**. 실패·불명확은 정직 보고(가짜 성공 금지).

## 함정
- **3-way 설치명령 버그**: 유일 정답은 `harness@harness-marketplace`. KO/JA README·quickstart는 틀림.
- **무증상 폴백**: flag 없으면 팀 패턴이 조용히 단일 에이전트로 저하(에러 안 남).
- **비용 7×**: 팀은 고토큰. 규모·모델·종료 가드 없이 돌리지 말 것.
- **버전 drift**: v2.1.178에서 `TeamCreate`/`TeamDelete` 제거. 상류 문서의 팀 호출 예시가 현행과 어긋남.
- **릴리스/태그 0건**: GitHub Releases·Tags 모두 없음. 버전 근거는 오직 `plugin.json`의 `1.2.0`.
- **라이선스 Apache-2.0**: 연동·참조이지 banker 재배포가 아니다. 상류 references/를 verbatim 복사하지
  않고 설치된 플러그인 자체를 가리킨다.

ARGUMENTS: `[--scope user|project]` (Codex meta-harness 설치 범위; 기본 user)
