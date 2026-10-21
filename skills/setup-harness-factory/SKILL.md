---
name: setup-harness-factory
description: "도메인 한 줄로 전문 에이전트 팀을 만들어 주는 `revfactory/harness` 플러그인을 설치하고 구성한 뒤 사용법을 안내. Claude Code 는 `harness@harness-marketplace`, Codex 는 `meta-harness`. 'setup-harness-factory'/'harness-factory'/'하네스 팩토리'/'에이전트팀 생성' 또는 `/banker:setup` 시 사용."
---

# setup-harness-factory: revfactory/harness 팀 아키텍처 팩토리 설치·구성

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

### 네트워크 확인 (내려받기 전)

이 스킬이 내려받는 원천에 10초 안에 닿는지 먼저 본다. 닿지 않으면 그 원천에서 받는 단계는 하지 않고, 이미 설치된 것의 확인만 한 뒤 "오프라인이라 설치하지 않음(필요한 것: <못 깐 것>)" 으로 보고한다.

```bash
[ "${CODEX_SANDBOX_NETWORK_DISABLED:-}" = 1 ] && echo "Codex sandbox 가 네트워크를 막음(아래 실패는 오프라인이 아님)"
curl --ssl-no-revoke -sSI -o /dev/null --connect-timeout 5 --max-time 10 https://github.com   # 마켓플레이스, git clone
```

- `curl -sSI` 는 머리만 받는다(본문을 받지 않음). 닿지 못하면 종료 코드가 0 이 아니다(HTTP 상태와 관계없음). `curl` 은 `HTTPS_PROXY` 를 따른다. 확인 줄은 `--ssl-no-revoke` 를 준다. Windows 의 Git Bash curl 도 Schannel 이라, 폐지 목록 서버에 닿지 못하는 망에서 폐지 확인이 실패하면 종료 60 이다(Windows 박스 실측). 다른 curl 은 이 깃발을 받고 무시한다(macOS curl 8.7.1, Rocky 8.10 curl 7.61.1 실측).
- Windows PowerShell 에서는 같은 주소를 `curl.exe --ssl-no-revoke -sSI -o NUL --connect-timeout 5 --max-time 10 <주소>` 로 보고 `$LASTEXITCODE` 가 0 인지 본다(PowerShell 5.1 의 `curl` 은 `Invoke-WebRequest` 별칭이다). `curl.exe` 는 Windows 시스템 프록시를 따르지 않고 `HTTPS_PROXY` 만 따른다. `--ssl-no-revoke` 는 폐지 목록 서버에 닿지 못하는 망에서 Schannel 의 폐지 확인 실패를 오프라인으로 읽지 않게 한다. 닿는지만 보고 받은 내용은 쓰지 않으므로 이 확인에만 준다. `curl.exe` 가 없으면 `$LASTEXITCODE` 에 앞 명령의 값이 남으므로 `Get-Command curl.exe -ErrorAction SilentlyContinue` 로 먼저 보고, 없으면 확인하지 못한 것으로 적는다.
- 사내 미러만 열린 망이면 확인 주소를 그 미러로 바꿔 본다.
- Codex sandbox 가 네트워크를 막는 모드(기본 `workspace-write`, `read-only`)에서는 `CODEX_SANDBOX_NETWORK_DISABLED=1` 이 서고 확인이 모두 실패한다(curl 종료 7, npm `EPERM`). 블록의 첫 줄이 그렇다고 알린다. 그때는 '오프라인' 이 아니라 'sandbox 가 네트워크를 막음' 으로 보고하고, 승인을 받아 sandbox 밖에서 확인부터 다시 한다. Claude Code sandbox 안(`SANDBOX_RUNTIME=1`)에서는 허용 목록 밖 주소를 sandbox 프록시가 막는다. Windows PowerShell 에서는 `$env:CODEX_SANDBOX_NETWORK_DISABLED -eq '1'` 로 본다.
- 확인이 실패하면 보고에 그 명령, 종료 코드, stderr 첫 줄을 붙인다(예: `npm error code ETIMEDOUT`, `curl: (28) ...`). 원인을 '오프라인' 하나로 짐작하지 않는다.
- curl 의 종료 60(인증서 검증 실패)도 오프라인이 아니다. 망은 열려 있고, TLS 를 가로채는 사내 프록시의 인증서를 OS 가 믿지 않는 것이다. '인증서 문제로 설치하지 않음' 으로 보고한다.

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
git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 clone https://github.com/SaehwanPark/meta-harness
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
