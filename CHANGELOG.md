# Changelog

## [0.13.0] - 2026-08-12

### Changed
- **`ralph-qa` 의 검증자 구성을 "우선순위 사다리"에서 "백본 + 좌석"으로 뒤집었다.**\
  이전에는 Codex CLI → 다른 모델 `curl` → 다중 에이전트 순으로 **사용 가능한 첫 경로 하나**만 썼고, 다중 에이전트는 다른-LLM 경로가 전무할 때만 도는 최종 수단이었다. 이제 **다중 에이전트 백본(`model: opus`, `--agents` 기본 3)이 조건 없이 항상 돌고**, 설치돼 있으면서 실제 유효성이 관측된 외부 LLM(Codex CLI · Gemini CLI · GPT/Gemini API)만 **각 1좌석**으로 합류한다. 외부 좌석의 부재는 실패나 열화가 아니라 "모델 축이 이번 실행에서 안 덮였다"는 커버리지 사실이다.\
  유효성은 **0토큰 HTTP 프리플라이트**(`references/verifier-probe.mjs`, provider `GET /models`)로 판정한다 — 설치 여부(`command -v`)와 유효 여부는 다르고, `codex login status`·`~/.codex/auth.json` 은 **거짓 음성**이라 근거로 쓰지 않는다(둘 다 미로그인이라 답하면서 codex 가 정상 동작하는 경우가 있다). 검증 실호출을 프로브로 쓰면 왕복 1회에 2만 토큰이 넘게 든다.\
  정족수는 좌석 **생애주기 전체**에 단조성을 건다: `내부 좌석 ≥ 1 ∧ 내부 과반 ∧ 실증된 외부 비-APPROVE 0 ∧ 미해소 blocker 0 ∧ ERROR 0 ∧ 좌석 상실 0`. 좌석 식별자를 `(종류, 렌즈)` 로 정의하고 반복 간 `S_k ⊆ S_{k+1}` 을 요구해 **좌석을 새로 굴려 반대를 지우는 경로**를 닫았고, 종결에 `INCONCLUSIVE` 를 더해 좌석이 사라지는 모든 경우를 APPROVE 밖으로 배출한다. `INCONCLUSIVE` 는 통과가 아니며 원인별 다음 행동이 규정된다.
- **`--effort` 를 외부 좌석(api·codex) 전용으로 축소했다.** 이전 표기는 전 경로에 적용되는 것처럼 보였지만 실제로는 아무 데도 전달되지 않았다.\
  백본 쪽 사정은 이렇다: **호출 단위** 지정 경로는 없고(Agent 도구 스키마에 effort 파라미터가 없다), effort 는 **에이전트 정의의 프론트매터**(`effort:`)나 세션 설정에서 온다. banker 는 에이전트를 배포하지 않으므로(`.claude-plugin/plugin.json` 에 `agents` 키 없음) 백본이 띄우는 것은 남의 정의이고, 따라서 이 스킬이 백본 effort 를 정할 수 없다. 백본에 실제로 영향을 주는 손잡이는 호출 전 **세션 effort** 뿐이며 SKILL.md 가 그렇게 안내한다.\
  플래그 표에 `전송 경로`·`확인 수준` 두 열을 두어, 전송 경로 칸을 채울 수 없는 능력은 표에 적지 못하게 했다.
- **백본의 모델을 선호 순서로 고르고, 실제로 쓴 것을 보고하게 했다.** ① Opus 계열 최신 → ② 없으면 가용한 것 중 가장 적합한 추론 모델 → ③ 그마저 없으면 기본값.\
  **추론 강도는 이 사다리에 없다** — Agent 도구 스키마에 effort 파라미터가 없어 호출 단위로 지정할 수 없고, 강도는 세션 설정에서 물려받는다. 최대 강도가 필요하면 호출 전에 세션 강도를 올리는 것이 유일한 손잡이다.\
  보고에 `백본(선언): model=<실제 쓴 모델> — 모델 선호 <1|2|3>순위 · strength=세션 상속` 줄이 강제된다. 목표를 약속으로 적고 실제를 감추지 않기 위한 것이다.
- **외부 좌석끼리도 모델이 겹치지 않게 했다.** 저자의 codex 설정(`~/.codex/config.toml` 의 `model`)은 api 좌석의 선호 모델 출처이기도 해서, 그대로 두면 `external:api:<X>` 와 `external:codex`(같은 `<X>`)가 나란히 앉는다 — 좌석은 2인데 모델 축에서는 하나다. 승인 게이트가 넓어지지는 않지만(좌석이 늘면 APPROVE 는 더 어려워진다) 보고의 "외부 2" 가 두 개의 독립 검사로 읽히므로, 이 스킬이 defect 로 다루는 보고 정직성 문제다.\
  이제 codex 좌석이 서면 api 좌석은 **codex 가 돌릴 모델의 계열을 피해서** 고른다. 사다리는 `다른 계열 → 같은 계열의 다른 모델 → 같은 모델` 이고 내려간 단은 `modelPick` 으로 보고된다. codex 의 모델을 확인하지 못하면 fail-closed 로 codex 런타임 계열을 피한다.\
  대가는 명시한다 — 자동 선택은 카탈로그 순서를 따를 뿐 성능순이 아니라서 회피 결과가 더 작은 모델일 수 있다. 능력이 더 중요하면 `--model` 로 고정하며, 그 값이 회피보다 우선한다. 또한 `GET /models` 200 은 카탈로그 접근만 증명하므로, 고른 모델이 첫 호출에서 거절되면 **좌석 확정 전**이라 다음 후보로 갈아탄다(확정 후의 실패는 `ERROR` 이고 모델을 바꾸면 좌석 상실이다).
- **`--external=auto|off` 를 신설**하고 `--agents` 를 백본 상시 파라미터로 승격했다. 폐기한 플래그는 없다.

### Added
- **gemini 모델 크리덴셜 좌석(`external:gemini-api`)을 CLI 좌석과 분리했다.** 처음 구현은 gemini 좌석을 CLI 존재 여부로 먼저 걸러서, 유효한 키가 있어도 CLI 가 없으면 좌석이 0이 되고 사유가 `cli-absent` 로 나갔다 — 그리고 그 토큰은 "모델 축이 환경 탓에 안 덮였다"로 매핑된다. **환경이 유효한 크리덴셜을 제공했는데 환경 탓으로 보고**하는 것이라, 이 스킬이 막겠다고 선언한 허위 커버리지였다. 이제 두 경로는 별개 좌석이고, 크리덴셜이 있으면 `cli-absent` 를 쓰지 않는다(생존 판정 실패는 `probe-unseated status=<code>`, 전송 수단 부재는 `no-transport`).
- `skills/ralph-qa/references/verifier-probe.mjs` — 의존성 0 · `node:http` 기반 유효성 프로브. provider 해석(`~/.codex/config.toml`), 0토큰 생존 판정, 상수 계열 필터(미분류는 fail-closed 제외), 전송 수단 탐지(`curl` → `python3` urllib ≥3.6 → `none`), 관측값(`observed`)과 선언값(`declared`) 분리 출력.

## [0.12.0] - 2026-08-09

### Added
- **모션 그래픽 스킬 쌍(무료 · hyperframes)을 추가했다.**\
  `motion-graphic-setup` 은 Node≥22 와 ffmpeg 를 OS별로 확보한 뒤 `npx hyperframes` 로 도구를 준비한다.\
  `motion-graphic-make` 는 렌더 파이프라인을 소유하지 않는 얇은 래퍼로, 10초 내외 내레이션 없는 모션 그래픽 제작을 hyperframes 의 `/motion-graphics` 워크플로에 위임한다.
- **3D 인트로 스킬 쌍(유료 · Azure Sora-2 + gpt-image-2)을 추가했다.**\
  `3d-intro-setup` 은 Node/ffmpeg 확보와 Azure 크레덴셜 저장, 무과금 프리플라이트까지만 담당해 과금 없이 연결을 검증한다.\
  `3d-intro-build` 는 gpt-image-2 스틸과 Sora-2 forward-chaining 영상으로 스크롤-스크럽 3D 인트로 사이트를 제작한다.
- **scroll-world 스크럽 엔진(MIT)을 `3d-intro-build/references` 에 번들로 포함했다.**\
  스크롤에 맞춰 3D 씬을 재생하는 이 엔진(`scrub-engine.js`·`index-template.html`)은 [oso95/scroll-world](https://github.com/oso95/scroll-world) 에서 그대로 벤더링했고, 원본 MIT 고지(`LICENSE`·`NOTICE.md`)를 함께 넣었다.
- **ffmpeg · hyperframes · Azure 는 사용자가 직접 공급하는 런타임 의존성이며 banker 가 번들하지 않는다.**\
  hyperframes 는 `npx` 로 설치(Apache-2.0)하고, ffmpeg 는 OS 패키지로 확보하며, Azure(OpenAI · Sora-2 · gpt-image-2 · FLUX.2-pro)는 사용자 크레덴셜로 호출한다(과금은 사용자 부담).
- **A4 세로 PPTX 스킬 쌍 `vertical-pptx` · `vertical-pptx-setup` 을 추가했다.**\
  `vertical-pptx` 는 A4 세로(210×297mm) 규격 PPTX 를 생성·점검·수리하고, 16:9 덱을 A4 세로로 변환한다(인쇄용 세로형 슬라이드).\
  `vertical-pptx-setup` 은 빌더 의존성(pptxgenjs·python-pptx)과 시각 검증용 LibreOffice 를 OS·권한 감지 후 설치한다(root 없으면 홈 프리픽스로 추출).

### Changed
- **🔴 `lineage` 세션 export 스킬을 전면 개편했다(2.0.0 · BREAKING).**\
  실측(6세션·62MB·4,645레코드) 대조에서 산출물의 2/3가 대화가 아니었고 일부는 하네스 주입이 사용자 발언으로 오표시됐다 — 이를 바로잡되 진짜 사용자 발언은 한 건도 잃지 않도록 다시 만들었다.\
  래퍼 없는 하네스 주입(스킬 본문·compaction 요약·에이전트 보고·이미지 노트)을 **위치가 아니라 형태로** 걸러 내고(위치 기반이 지우던 사용자 정정·인용 질문은 보존), 서브에이전트·동료 보고는 별도 회색 버블로 분리한다(발신자명 표시·idle 알림 폐기).\
  Claude 본문을 **무의존 마크다운으로 렌더**한다(헤딩·리스트·표·코드펜스·인용·강조·링크; `html.escape` **후에만** 변환하고 코드/링크를 먼저 도려내 마크업/서식 주입을 차단, 링크는 `https?://` 만).\
  연속된 assistant 레코드를 `--hide-tool-only` 앞에서 병합해 그동안 한 번도 표시되지 않던 `🔧 도구 N건` 을 살리고, 요약을 head+tail 로 뽑아 "무엇을 시작했다"가 아니라 결론을 담게 했다(요약기 버전을 캐시 키에 넣어 알고리즘 변경 시 자동 무효화).\
  여러 세션을 레코드 단위 시간순 한 줄기로 합치는 `--all-sessions` 를 추가했다.\
  단축키를 한글 IME·`Ctrl`/`Cmd`/`Alt` 안전하게 고치고(`e.code` 우선이라 브라우저 기본 동작을 가로채지 않음), 날짜·세션전환·compaction 을 형태가 다른 알약으로 구분(대비 개선·헤더가 스크롤에 따라 갱신), 범례를 우하단 `?` 오버레이로 옮겼다(배경 클릭으로만 닫힘·`aria-modal`).\
  `self_verify` 가 렌더러 출력의 모든 태그를 HTMLParser 스택으로 검사(void 요소 14종 인지)해 개수는 맞지만 어긋난 마크업까지 배포 전에 잡는다.\
  경로 인코딩을 바로잡았다: cwd 의 모든 비영숫자를 `-` 로 매핑(`_` 포함·Windows 경로 포함) — 이전엔 `/` 만 치환해 밑줄이 든 경로에서 자동탐색이 실패했다. 비-UTF8 세션 파일 하나가 전체 export 를 실패시키던 문제도 그 파일만 건너뛰게 고쳤다.\
  **BREAKING — 기본값 반전 3건**: 첫 로드 **접힘**(펼치려면 `--open`), 마크다운 렌더 **기본 ON**(끄려면 `--no-markdown`), 하네스 노이즈 필터 **기본 ON**(남기려면 `--keep-trivia`). 400자 초과 사용자 메시지도 접힌다. 1.x 동작을 원하면 `--open --no-markdown --keep-trivia`.\
  표준 라이브러리만 쓰는 `test_lineage.py`(회귀 143 단언·외부 의존 0)를 추가해 `scripts/smoke-test.js` 가 인터프리터 ≥3.7 을 자동 탐지해 CI 에서 돌리고(EL8 기본 python3=3.6 은 skip), npm 패키지에서는 제외한다.

## [0.11.0] - 2026-08-08

### Changed
- **`ralph-qa` 교차검증 경로를 3단 우선순위로 재설계.** 방금 만든 결과를 다른 모델로 독립 검증할 때(자기승인 방지), 이제 ① 다른-LLM CLI(**Codex CLI 우선**; 저자가 Codex면 Claude/Gemini) → ② 다른 모델 직접 `curl`(크리덴셜이 있고 저자와 다른 계열일 때, 엔드포인트·키·모델을 env 로 파라미터화) → ③ 자체 다중 에이전트 합의(기본 3개·렌즈 분담·정족수, 최후 수단) 순으로 사용 가능한 첫 경로를 택한다. 이전엔 다른-LLM 경로 실패 시 같은-런타임 critic 하나로 곧장 후퇴했으나, 그 앞에 진짜 다른 모델(`curl`) 경로를 끼워 독립성을 실질적으로 강화했다. `--agents=N` 플래그를 추가했다.
- **README 빠른 시작의 Claude Code 설치를 인앱 `/plugin` 우선으로.** 실행 중인 세션에서 `/plugin marketplace add …` + `/plugin install …@…` 로 설치하는 흐름을 앞세우고(설치 후 필요 시 `/reload-plugins` 안내), 터미널 셸 `claude plugin …` 은 대안으로 병기했다.

### Added
- README 에 **설정 변경 지점(Claude Code · Codex)** 섹션을 추가했다. 설치·제거 CLI, 플러그인 자체 훅(`hooks.json`), setup 스킬별 설정 패치(`config.toml`·`settings.json`) 지점을 표로 정리했다.

## [0.10.0] - 2026-07-18

### Changed
- **GitHub 별 프롬프트가 Y 입력 시 실제로 별을 단다**(oh-my-codex 방식과 동일). 이전에는 URL 안내만 했으나, 이제 `gh` CLI 인증으로 `gh api -X PUT /user/starred/smallOpenSource/banker_plugins` 를 호출해 자동으로 별을 누른다. `gh` 미설치·미인증·API 실패 시에는 이유를 알리고 URL 안내로 폴백한다(setup 을 절대 막지 않음·자체 timeout·오류삼킴). `starRepo` 를 `require.main` 가드 뒤로 export 해 주입 spawn 으로 단위테스트(gh 없음·성공·실패)를 커버했다. 실환경 검증: 실제 exported `starRepo()` 호출로 저장소가 404→204(별 눌림) 전이 확인.

## [0.9.0] - 2026-07-18

### Added
- **개인화 업데이트 알림**: 새 버전이 나왔을 때, 그 버전에서 바뀐 스킬 중 이 설치에서 실제로 써 본 스킬이 있으면 알림에 그 스킬 이름을 넣어 보여준다("자주 쓰는 스킬이 이번 업데이트에서 바뀌었습니다: ..."). 교집합이 없으면 기존 일반 알림으로 폴백한다.
  - **로컬 "써 본 스킬" 집합**: 카운팅 훅(PostToolUse Skill / UserPromptExpansion)이 스킬 이름을 config 폴더의 `used-skills.json` 에 union 으로 모은다. 이 집합은 절대 전송하지 않는다 — 체크인 페이로드는 여전히 `{version, os, counts}` 뿐이다. 상한(300)·중복 무기록·원자적 기록.
  - **바뀐 스킬 목록(공개 GitHub raw)**: 버전별 바뀐 스킬을 담은 `skill-changes.json` 을 저장소에서 GET 으로 조회한다(카운팅 활성 경로의 update-checkin 이 best-effort; 개인화 표시가 카운팅에 게이트되므로 카운팅 opt-out 경로의 update-fetch 는 조회하지 않는다). 무페이로드 GET 이라 식별자 전송이 없고, 실패하면 일반 알림으로 폴백한다. 릴리스마다 `scripts/gen-skill-changes.js`(git diff 기반·배포 제외)로 채운다.
  - 두 opt-out(`BANKER_NO_UPDATE_CHECK`·`BANKER_NO_TELEMETRY`) 중 어느 쪽을 켜도 개인화는 동작하지 않는다. Codex CLI는 네트워크 차단으로 배제된다.
  - `PRIVACY.md` 에 개인화 항목을 추가했다(로컬 집합 미전송·매니페스트 GET 수신자=GitHub).

### Fixed
- `PRIVACY.md`·CHANGELOG 의 "0.8.0 아직 게시 안 됨" 상태 문구를 실제(게시됨)에 맞게 정정했다. EU ePrivacy opt-in 전환 여부는 열린 검토 항목으로 표기를 유지한다.

## [0.8.0] - 2026-07-17

### Added
- README 에 npm 월간 다운로드 배지와 GitHub stars 배지를 추가했다.
- `banker setup` 최초 실행 시 GitHub 저장소 별(star)을 요청하는 프롬프트를 추가했다(양 런타임 공통·홍보 목적·카운팅 opt-out 여부와 무관).
- **업데이트-체크 서비스**: 이전 초안(opt-in 익명 텔레메트리 클라이언트, 기본값 미수집)은 동의자가 거의 없어 사용량 가시성이라는 목표를 달성하지 못한다고 판단해 두 기능으로 재구성(피벗)했다.
  - **업데이트 알림**: 공개 npm 레지스트리(`registry.npmjs.org/@kaydash9999/banker-plugins/latest`)를 조회해 세션 시작 시 새 버전이 있으면 알린다. 조회 요청의 수신자는 npm(GitHub/Microsoft)이고, banker 유지보수자는 이 조회를 받지 않는다. 기본값 켜짐, `BANKER_NO_UPDATE_CHECK` 환경변수 또는 `config.updateCheck=false` 로 끌 수 있다.
  - **사용량 카운팅(count-default-on)**: 하루 1회 스킬/커맨드별 호출 수를 시간대(hour-of-day)별로 버킷화해 플러그인 버전·OS 종류와 함께 유지보수자가 운영하는 외부 엔드포인트로 익명 체크인한다. 집계는 사용자가 직접 입력한 `/banker:*` 커맨드와 모델이 자동 호출한 스킬 양쪽을 서로 다른 두 훅으로 겹침 없이 포착한다. 기본값 켜짐, `BANKER_NO_TELEMETRY` 환경변수·`config.telemetry=false`·`banker telemetry off` 로 끌 수 있다.
  - **기본 카운팅 엔드포인트 내장**: 배포에 기본 엔드포인트(`banker.banker-plugins.workers.dev`, 유지보수자의 Cloudflare Worker)를 박아 `endpoint()` 가 env·config 미설정이어도 이를 반환한다. 그 결과 `countingActive()` 가 실제로 default-on 이 되어 opt-out 하지 않은 모든 설치에서 카운팅이 활성이다(이전엔 엔드포인트 미설정이라 사실상 유지보수자 셸만 잡혔다). 자가호스팅/override 는 `BANKER_TELEMETRY_ENDPOINT` 환경변수로 한다.
  - 두 기능 모두 Claude Code 전용이다. Codex CLI는 샌드박스가 네트워크 접근을 차단하므로 알림·카운팅 둘 다 배제된다.
  - `PRIVACY.md` 를 이 설계에 맞게 재작성했다: 알림/카운팅을 분리 기술하고 각각의 수신자를 이름으로 명시했다(알림=npm, 카운팅=유지보수자). 익명성이 페이로드의 속성이지 시스템 전체의 속성은 아니라는 점(카운팅 서버는 소스 IP를 수신하되 기록하지 않도록 설계)을 정직하게 밝혔다. EU ePrivacy Art.5(3)·Planet49 판례는 표준 관행 근거와 반대 근거를 양면으로 제시했고, 미국 CCPA·한국 PIPA는 이 익명 체크인에 재적용하지 않는다는 점(실무 판단 기준인 IP 지속 보유·프로파일링·판매에 해당하지 않음)을 명기했다.

### Notes
- **정직 명시**: 이 릴리스는 npm·GitHub·마켓플레이스에 게시되었다. 초안 당시 계획했던 "EU ePrivacy opt-in 전환 검토 통과 후 게시" 게이트는 게시 결정으로 우회되었고, EU ePrivacy opt-in 전환 여부는 `PRIVACY.md` 의 열린 검토 항목으로 남아 있다.

## [0.7.1] - 2026-07-16

### Changed
- README 정비(문서 전용 — 코드·스킬·배포 표면 무변경). 최상단에 총 구성요소 수(스킬 48 + 커맨드 2)를 명시하고, `라이선스 / 서드파티`의 의존 라이브러리·연동 참조 나열을 표(분류·항목·라이선스·사용 스킬)로 재구성했다. 사실은 코드와 대조해 확인했다 — banker 자체는 MIT, 코드로 재배포하는 서드파티는 `humanizer`(MIT © 2025 Siqi Chen) 단독이며 나머지는 런타임 의존·연동일 뿐이다. 도구별 사용 스킬 매핑은 `/banker:setup` 표와 교차검증했고, 원본에 라이선스가 없던 항목은 지어내지 않고 `각 프로젝트`로 표기했다.
- README 산문 가독성. 여러 문장이 한 줄에 붙던 문단을 Markdown hard break 로 문장마다 개행(뷰어에서 실제 줄바꿈)하고, Codex 설치 안내 문장을 분리했다.

## [0.7.0] - 2026-07-16

### Added
- **신규 스킬 6종** (전부 `target: both`). 배포용이므로 "이 저장소에서 재보니 무동작"류 판정은 설계 근거로 쓰지 않았다. 각 스킬의 사실 주장은 게시 전 적대적 검증에 걸었고, 거기서 반증된 것(검증되지 않은 표준 번호·법령 API 엔드포인트·트래커 이슈 인용·출처 없는 수치)은 그럴듯해도 넣지 않았다. 검증이 실제로 적출한 것들: `update-banker` 가 sweep 대상을 절반만 적은 것(스킬만 적고 command 프롬프트를 빠뜨림), `refresh-readme` 의 드리프트 예시가 디렉터리 카운트(49)를 스킬 수(48)로 오기한 것, `codex/transform-matrix.md` 가 DISPUTED 항목을 확정으로 서술한 것. 셋 다 게시 전에 고쳤다.
  - `ultra-interview`: 리서치를 선행해 공개 정보(공식 문서·규정·법령·시행세칙·기록)가 답할 수 있는 것은 사람에게 묻지 않고, 모호성 3% 이하까지 인터뷰한다. **모호도를 이산 체크리스트(미해결/전체)로 계측**하는 것이 설계 요점이다. 스칼라 자기채점 위에서는 3%가 표현되지 않는다(자기신뢰도 응답이 라운드넘버 소수에 뭉치고, 가중치 합이 1인 공식에서는 전 축 0.95여도 모호도가 정확히 0.05라 통과하려면 어딘가에 완벽을 선언해야 한다). 이산 계측은 셈이라 부풀릴 수 없다. Evidence/Inference/Preference 3분류로 Preference 만 질문한다. OMC/OMX 네이티브 `deep-interview` 를 번들하거나 대체하지 않으며, **자체 루브릭을 소유**한다(OMC 3차원 대 OMX 5차원이라 네이티브 채점을 물려받으면 같은 임계값이 런타임마다 다른 뜻이 된다).
  - `interval-report`: 장기 수행의 중간 보고를 `docs/intermission.md` 로 갱신한다. 측정 범위는 **마지막 사용자 지시로 시작된 현재 수행분**이고 시작 시각은 그 시점이다. **시작 시각을 파일에 영속하고 절대 재스탬프하지 않는다**. compaction/resume 후 now 로 다시 찍으면 elapsed 가 0으로 붕괴해 리포트가 가장 필요한 순간에 가장 낙관 편향된다. 시각은 `date` 로 실측한다(두 런타임 모두 컨텍스트에 시:분이 없다). ultragoal 이 있으면 읽고 없어도 동작하며 상태를 복제하지 않는다. compaction 트리거는 `smart-compact` 소관으로 남긴다.
  - `summary-wiki`: 위키를 `docs/` 하위 단일 파일로 개조식 요약해 **사용자가 아는 지식과 위키에 쌓인 내용의 차이를 식별**하게 한다(sync 검토). **`wiki_list` 를 쓰지 않고 파일을 직접 열거**하는 것이 핵심이다. `wiki_list` 는 구조적으로 stale 한 인덱스를 읽어 페이지를 조용히 누락하며(실측: 직접 열거 17 대 `wiki_list` 16), 그 누락은 성공을 보고하면서 이 스킬의 목적을 정확히 배반한다. 위키에는 쓰지 않는다(`compact-wiki` 는 제자리 파괴적 변형이라 별개). `개조식` 은 어문규범에 명명된 문체가 아니므로 "관행 준수"로 서술한다.
  - `update-banker`: 설치된 banker 를 최신 배포본으로 갱신한다. **축은 OS 가 아니라 채널**이다(banker 는 dependencies 0 에 복사 설치라 OS 분기가 거의 없고, Claude 플러그인·npm 전역 CLI·Codex 스킬 3채널이 서로 다른 메커니즘으로 독립 드리프트한다). **npm 을 먼저 올리고 검증한 뒤에만 `banker setup --codex`** 를 돌린다. setup 은 복사 전에 모든 `banker-*` 를 쓸어내므로 구버전 CLI 로 실행하면 그 구버전 매니페스트 수만큼만 복원된다. 판정은 exit code 가 아니라 채널별 프로브 재실행으로 한다.
  - `refresh-readme`: 코드가 바뀌어 README 가 작성 시점에 머무는 것을 조치한다. README 산문 주장을 매니페스트·`skills/`·`package.json` 과 대조하는 삼각검증이 신규 능력이다. 펜스·인라인 코드·URL·`--flag` 를 인지한다(POSIX end-of-options ` -- ` 는 산문 이중하이픈과 문자적으로 동일해 일괄 치환은 그 자체로 결함이며, 실제로 문서화된 MCP 설치 명령을 깨뜨린다). AI 문체 마커는 `humanizer` 에 위임하고 재서술하지 않는다.
  - `cleansing-memory`: 메모리 파일을 문서화된 threshold 내로 정리한다(중복 최신본화, 무손실 압축, append 대 replace 판별). **문서화된 하드 게이트는 `MEMORY.md` 의 200줄 OR 25KB 하나뿐이고 `CLAUDE.md` 에는 문서화된 크기 한도가 없다**. 바이트 캡을 제시하는 것은 날조다. Codex 의 `project_doc_max_bytes`(32768) 는 프로젝트 스코프 `AGENTS.md` 에만 걸리고 전역 파일에는 적용되지 않으며, raw 바이트를 자른 뒤 lossy UTF-8 디코드를 하므로 정확히 N바이트로 자르면 한글 경계 문자가 손상된다. auto-memory topic 파일이 시작 시 로드되지 않는다는 문서화된 성질이 append→replace 최적화의 근거다. 코드베이스 유도분 트림은 Claude 의 `/doctor` 에 위임한다.

### Changed
- Codex 설치 스킬 수 **42 → 48**(+커맨드 2 유지, claude-only=0). `codex/manifest.json`·`README.md`·`codex/transform-matrix.md`·`scripts/smoke-test.js`·`.github/workflows/harness-setup-ci.yml` 을 동기화했다.
- **`scripts/smoke-test.js` 에 집합 동등성 단언을 추가**했다(실설치 실행 **앞**). `codex/manifest.json` 의 skill 이름 집합과 `skills/` 디스크 집합이 같은지 검사하고 불일치를 `manifest-only` / `disk-only` 로 **이름을 찍어** 보고한다. 기수 단언만으로는 이 결함을 잡을 수 없다. dry-run 카운터는 파일시스템이 아니라 매니페스트를 순회하므로, 디렉터리가 없어도 매니페스트 줄 수만 맞으면 통과하고 실설치는 복사 중 ENOENT 로 죽어 `HARNESS ERROR` 라는 환경 문제처럼 보이는 메시지만 남긴다. 이 단언은 지금까지 아무 장치도 없던 반대 방향(디스크에 있으나 매니페스트에 없어 Claude 에만 실리고 Codex 로는 영영 가지 않는 조용한 claude-only 스킬)도 함께 닫는다. 릴리스마다 하드코딩 이름 배열을 덧붙이던 방식을 이 단언 하나로 대체한다.

## [0.6.0] - 2026-07-15

### Added
- **신규 스킬 `obsidizer`** (`target: both`): AI가 생성한 마크다운 위키를 의미 보존한 채 Obsidian 지식그래프로 정규화·상호링크·백링크한다. in-place 정규화(별도 export 트리 없음)·절대 rename 금지·LLM 의미론적 편집 + 제로-입력 결정적 캐노니컬라이저(`obsidize.mjs`) 2계층 엔진·OMC 트리에서는 bare-form(`[[slug]]`)만 허용하는 위키링크(`extractWikiLinks`가 피이프/헤딩 형태를 통째로 슬러그화해 `links[]`를 깨뜨림)·generic vault 한정 `aliases`(OMC 트리는 READ 시점 silent strip + 유일한 소비처인 피이프 링크가 금지라 destructive 실패 모드로 거부). `--enable`/`--disable`은 banker 최초의 **플러그인 선언 hook**(`hooks/hooks.json`)으로 Claude에서만 구조적으로 동작(위키 쓰기 후 원자적 쓰기 + read-back CAS로 동시쓰기를 skip)하고 Codex(MCP tool hook 없음)에서는 정직한 no-op이다. **hook은 banker가 활성화되어 있으면 항상 등록**되어 위키 쓰기(`wiki_ingest`/`wiki_add`)마다 실행되므로, `--enable`을 켜지 않은 사용자도 쓰기당 약 30ms의 node 프로세스 기동 비용을 치른다(플래그 확인 자체가 그 프로세스 내부에서 일어나기 때문); `--enable` 이전에는 아무 파일도 쓰지 않는 순수 no-op이다.
- **Deferred to 0.7.0 (품질 이유, 효율 이유 아님):** Canvas-MOC sidecar 생성 · inline Dataview `::` 생성 · MOC 허브 페이지 생성. 셋 다 in-place durable 은 이미 코드로 검증됐지만(좌표 결정성·필드 날조 방지·링크 인플레 방지 기준이 아직 없어) **생성만** 보류한다 — 호환성은 v1에서 이미 무료로 확보돼 있다.

### Changed
- Codex 설치 스킬 수 **41 → 42**(+커맨드 2 유지, claude-only=0). `codex/manifest.json`·`README.md`·`codex/transform-matrix.md`·`scripts/smoke-test.js`·`.github/workflows/harness-setup-ci.yml`을 동기화했다.
- `package.json` `files[]`에 `hooks`를 추가해 `hooks/hooks.json`·`hooks/obsidize-hook.mjs`·`hooks/run.cjs`가 npm 패키지에 포함되도록 했다(`npm pack --dry-run`으로 확인).

## [0.5.0] - 2026-07-15

### Added
- **신규 스킬 9종** (전부 `target: both`, 런타임 인식 — Claude=OMC / Codex=OMX): 개발환경 "harness" 구성요소를 OS별·런타임별로 개별 설치/구성하는 스킬 계층. USER_RESOURCES의 과거버전 가이드(5-OS Claude Code + 6-OS Codex/Azure)에서 공통 유용요소를 추출하고 2026 현행 방식으로 현행화했다.
  - `setup-node`: nvm + Node 22 (winget/nvm-windows) per-OS. npx 기반 MCP·CLI의 전제.
  - `setup-python`: Python 3.11 + pipx + uv per-OS (dnf module/deadsnakes/winget/brew, PEP668). `docs-setup`가 이 런타임을 소비.
  - `setup-java`: JDK 21 + JAVA_HOME per-OS (Debian은 Adoptium Temurin 전용). `setup-lsp`의 jdtls가 요구.
  - `setup-lsp`: 언어별 LSP(vtsls·basedpyright·bash·jdtls·spring) + lsp-mcp 브리지. Claude=LSP MCP 도구, Codex=`config.toml [mcp_servers.lsp_bridge]`. `--lang` 선택.
  - `setup-tmux`: tmux per-OS (Rocky8 `3.6a` 소스빌드·apt/brew·Windows psmux). OMC team·worktree / OMX `$team`·HUD 전제.
  - `setup-pwsh`: Windows PowerShell 7 환경(`$PROFILE` UTF-8·Terminal·Git). Claude=`CLAUDE_CODE_GIT_BASH_PATH`, Codex=네이티브 셸. 비-Windows는 no-op 안내.
  - `setup-mcp`: 공통 MCP 서버(context7·sequential-thinking·filesystem·git·fetch). Claude=`claude mcp add`, Codex=`config.toml [mcp_servers.*]` (timeout 300).
  - `setup-sandbox`: OS별 샌드박스(bubblewrap+userns / AppContainer / Seatbelt) + rust/cargo + git `safe.directory`. Codex=`sandbox_mode`.
  - `harness-factory`: revfactory/harness(팀 아키텍처 팩토리) 플러그인 설치+구성+사용안내. Claude=`harness@harness-marketplace`(+`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 를 settings.json에 영속), Codex=`SaehwanPark/meta-harness`. 설치를 넘어 모드/6패턴 선택·비용가드(~7× 토큰)·experimental 리스크 고지까지 담되, harness references는 이식하지 않고 설치된 플러그인 참조(Apache-2.0 연동/참조, banker 재배포 아님).

### Changed
- Codex 설치 스킬 수 **32 → 41**(+커맨드 2 유지, claude-only=0). **2계층 아키텍처**: 얇은 setup-* 실행 유닛 + `banker:setup`/`harness-factory` 오케스트레이터가 조합·의존성 관리(setup-lsp→node/python/java, setup-mcp→node/python, docs-setup→python).
- `commands/setup.md` 오케스트레이터에 신규 9 스킬(계층·의존성)을 추가하고, `README.md`·`codex/transform-matrix.md`를 동기화했다. `scripts/smoke-test.js`에 `copies===41` + 신규 9 존재 회귀 단언을 추가했다.
- **서드파티 명시(연동/참조, 재배포 아님)**: revfactory/harness·SaehwanPark/meta-harness(Apache-2.0), jdtls(EPL), tmux(ISC), psmux, basedpyright·vtsls·bash-language-server·lsp-mcp 등 각 프로젝트 라이선스 소유.
- **per-OS CI**: `.github/workflows/`에 GitHub-hosted 러너(ubuntu/windows/macos + Rocky8 컨테이너) 기반 설치·동작 검증 워크플로를 추가했다(설치가 실제 실행되는 도구를 만드는지 "존재 vs 동작" 검증).

## [0.4.0] - 2026-07-15

### Added
- **신규 스킬 6종** (전부 `target: both`, 런타임 인식 본문 — Claude=OMC / Codex=OMX):
  - `curation`: 의사결정을 {선택지·권고안·권고 근거·확신수준(0.00~1.00)·확신수준 근거} 형식으로 큐레이션. `--perf` 는 결과물 품질·완성도를 노력/토큰/시간 효율보다 우선하는 채택 기준을 추가. 외부 의존 0(양 런타임 동일 동작).
  - `deep-init`: 코드베이스 전체에 계층형 `AGENTS.md` 문서 생성/갱신(부모 역참조·`<!-- MANUAL -->` 보존·계층 검증). OMC `deepinit` 이식으로 banker `ultra-init`(자율 풀사이클 빌드)과는 별개. 서브에이전트 Claude=OMC explore/architect/writer, Codex=OMX worker/explore, 부재 시 직접 수행.
  - `visual-ralph`: 레퍼런스(생성/정적/라이브 URL) 기준 프론트 UI를 Visual Verdict(≥90)+픽셀 diff로 측정 빌드하고 재사용 디자인 시스템을 남긴다. OMX `visual-ralph` 이식. Claude=`ralph`+`visual-verdict`+Stitch(`setup-stitch-proxy`)/ccg imagegen, Codex=`$ralph`+`$imagegen`.
  - `deep-research`: 다중 소스 팬아웃 → 적대적 다표결 검증(2/3 반증 시 폐기) → 확신순 인용 합성. 번들 워크플로를 prose 로 재저작(구조적 병렬 fan-out 충실도 하락을 명시). Claude=번들 워크플로/`WebSearch`, Codex=OMX `autoresearch`.
  - `ralph-qa`: 작업 결과를 **다른 LLM·별도 세션**으로 `ralplan --deliberate`+`ralph --critic=critic` 로직으로 독립 검증/개선 반복(anti-self-approval). Claude=`omc ask codex`/`ccg`, Codex=OMX `$ask`(Claude/Gemini). 검증 모델은 파라미터화(`--model`·`--effort`; 예시 `gpt-5.6-sol` 은 하드코딩하지 않음).
  - `smart-compact`: 컨텍스트 사용률이 임계(기본 50%)를 넘으면 `append-wiki`→`ready-compact`→`compact-copy` 를 자동 실행하고 `/copy`·`/compact`·paste 를 유저에게 핸드오프하는 게이트. Claude statusLine `context_window.used_percentage` 로 감지(hook은 context% 미노출·슬래시명령 호출 불가 → TUI 3단은 유저 실행), 기존 statusLine 을 감싸는 compose-safe 설치. `--cancel` 해제.

### Changed
- **Codex 이식 확대(claude-only → both)**: 이전 OMC/Claude 결합 표면(스킬 `all-in-one`·`ultra-init`·`omc-reference`·`compact-copy`·`setup-omc-hud`·`setup-stitch-proxy` + 커맨드 `front-qa`·`setup`)을 **런타임 인식 본문**으로 재작성해 `target: both` 로 승격했다(`setup-omc` 는 기존부터 dual). Codex에선 OMC 대신 oh-my-codex(OMX)의 동명 스킬(ralplan/ralph/ultraqa/hud 등)·`codex mcp`·내장 `/copy` 를 사용한다. `codex/manifest.json` 의 claude-only=0.
- **`omc-reference` dualize**: 본문에 실측 OMX(oh-my-codex 0.18.16) 카탈로그(Agent Prompts·Skills Registry·Interfaces + OMC↔OMX 대응)를 병기해 Codex에서도 정확한 레퍼런스가 되도록 격상(기존 disclaimer-only → dual).
- Codex 설치 스킬 수 **25 → 32**(+커맨드 2 유지). `README.md`·`codex/transform-matrix.md` 를 동기화하고, `scripts/smoke-test.js` 에 `copies===32` + 신규 6스킬 존재 + `deep-interview` 부재(이미 OMC·OMX 네이티브라 미번들) 회귀 단언을 추가했다.
- **스킬 설명(description) 정규화**: 전 스킬 + 2 커맨드의 `description` 을 `(banker)` 접두로 통일하고 em/en dash 등 AI slop 표현을 제거·간결화했다(트리거 키워드는 보존). Codex `codex debug prompt-input` 로 banker-* 가 "Available skills" 에 노출됨을 실측 확인.
- **setup 스킬 정비**: `setup-stitch-proxy` → `setup-stitch` 개명(RockyLinux8 `~/bin/stitch-proxy.sh` proxy-script 절차 그대로) + **`docs-setup` 신규**(arch-diagram·pdf-vision-extract 의존성 python-pptx·pymupdf·plantuml 설치, python-env 감지/선택·venv 우선). Codex 스킬 **31→32**, `/banker:setup` 오케스트레이터·`smoke-test` rename-guard 에 반영.

## [0.3.0] - 2026-07-02

### Changed
- **`game-qa` → `play-qa` 개명**: 웹 게임 전용 표기에서 Godot HTML5까지 포함한 웹 환경 직접 플레이 QA로 범위를 넓히고 스킬명을 `play-qa` 로 바꿨다. 스킬 디렉터리·프론트매터 `name:`·트리거·`codex/manifest.json`·README·문서 참조를 일괄 갱신했다. Codex에는 `banker-play-qa` 로 설치되며, 업데이트 시 옛 `banker-game-qa` 는 `banker setup --codex` 의 `banker-*` sweep 으로 자동 제거된다(`scripts/smoke-test.js` 에 회귀 단언 추가). `/banker:game-qa` 는 더 이상 해석되지 않으므로 minor 버전을 올린다.

## [0.2.0] - 2026-07-01

### Fixed
- **Codex 스킬 미표시(#5)**: `banker setup --codex` 가 스킬을 `~/.codex/skills/banker-<name>/` 로 복사할 때 SKILL.md 프론트매터 `name:` 을 `banker-<name>` 로 재작성한다. Codex는 스킬 디렉터리명과 `name:` 일치를 요구하는데, 기존에는 `name: <name>` 그대로라 Codex가 스킬을 인식하지 못했다. `banker doctor` 에 dir==name 검증·경고와 "codex 있는데 banker 스킬 0개" 경고 추가.

### Changed
- **업데이트 시 중복 제거(#6)**: `banker setup --codex` 가 설치 전 기존 `banker-*` 스킬·프롬프트를 먼저 정리(sweep)한 뒤 클린 재설치한다. 매니페스트에서 제거·개명된 스킬의 옛 버전이 잔존하지 않는다.
- **의존성 사전 안내(#2·#4)**: `all-in-one`·`ultra-init`·`front-qa` 에 OMC(Claude)/OMX(Codex) 전제조건 프리플라이트, 브라우저 스킬(`audit-web-page`·`game-qa`·`ultra-ui-qa`)에 playwright 전제조건 프리플라이트를 추가했다. 의존성이 없으면 "설치부터" 안내한 뒤 진행한다.
- **README 재작성(#1)**: 과장·AI 흔적 표현을 덜어내고(과장 태그라인·불필요한 em dash 정리) 간결하고 정중한 문체로 정리했다. 빠른 시작에 Claude Code·Codex 양쪽 설치 경로를 명시하고, 라이선스/서드파티 섹션을 번들 코드(humanizer)·의존 라이브러리·연동 대상 3범주로 확장했다.
- `sync-version` 이 `.claude-plugin/marketplace.json` 의 `metadata.version` 까지 동기화한다(과거 수동 갱신 제거).

### Added
- **`setup-omc` 스킬**: `all-in-one`·`ultra-init`·`front-qa` 가 의존하는 oh-my-claudecode(OMC)를 설치·갱신한다(Codex는 OMX `omx setup`). `/banker:setup` 멀티셀렉트에 옵션으로 추가.
- **`setup-insane-search` Codex 지원(#7)**: `target: both` 로 승격했다. Claude는 `insane-search@gptaku-plugins`, Codex는 `codex plugin add insane-research-codex@gptaku-codex` 경로를 도구 자동 감지로 안내한다.
- `scripts/smoke-test.js` 에 실제 설치 기반 회귀 단언 추가: 스킬 18개, `banker-*` dir==frontmatter `name`, 재설치 시 stale sweep.

## [0.1.3] - 2026-06-29

### Security
- `lineage` 스킬 문서의 `LINEAGE_REDACT_EXTRA` / `--redact-extra` 예시에서 실제 프로젝트 비밀 키워드 예시를 중립 플레이스홀더(`acme-corp,db-pass`)로 교체 — npm tarball·GitHub 노출 제거. 기능·내장 정규식 패턴은 불변.

## [0.1.2] - 2026-06-28

### Added
- `compact-copy` 스킬(개인 `~/.claude/skills/` + banker): `/ready-compact` resume 프롬프트에서 코드펜스 본문만 추출해 `/tmp/claude-<uid>/response.md` + (이어지는 `/copy`) 클립보드에 "프롬프트-only" 로 담는다. `/copy`·response.md 내장 의존이라 Claude Code 전용.

### Changed
- `all-in-one` 스킬을 playwright 3단계 → **ralplan→ralph→ultraqa** 3단계(독립 테스트 게이트)로 재작성(`--short`/`--checkpoint`/`--critic`/`--qa`/`--no-deslop` 플래그 추가). `codex/manifest.json` 의 reason 문자열도 ultraqa로 동기화.

## [0.1.1] - 2026-06-26

### Changed — README + license
- README 전면 재구성: hero(태그라인 + npm·MIT 배지 + 내비) · 빠른 시작(2스텝) · "왜 banker인가" · 요구사항 섹션 추가(스킬 표 보존).
- 루트 `LICENSE`(MIT) 파일 추가 + `package.json` `files[]`에 포함(MIT 배지가 실제 라이선스를 가리키도록).

## [0.1.0] - 2026-06-25

### Added — npm distribution + Codex CLI support
- npm global install: `npm i -g @kaydash9999/banker-plugins` ships a `banker` CLI (`bin/banker.js`, no runtime deps).
- `banker setup [--claude] [--codex] [--scope user|project] [--dry-run]`, `banker doctor`, `banker uninstall`.
- **Codex CLI support**: `banker setup --codex` installs the 17 tool-agnostic skills into `~/.codex/skills/banker-<name>/` (subtree copy) and commands into `~/.codex/prompts/banker-<name>.md` (`/banker-<name>`), per `codex/manifest.json`. It never writes the omx-generated `~/.codex/AGENTS.md` (relies on `~/.codex/skills/` auto-discovery).
- `codex/manifest.json` (per-surface `claude-only | both` target + supporting files) and `codex/transform-matrix.md`.
- Version-sync guard: `.claude-plugin/plugin.json` is the single source of truth; `npm run sync-version` syncs `package.json`, and `prepublishOnly` fails publish on mismatch.

### Unchanged
- The Claude Code marketplace install (`claude plugin install banker@banker-plugins`, skills as `/banker:*`) is byte-for-byte unchanged.

### Notes
- No `postinstall`; `banker setup` is explicit and refuses to run as root (avoids root-owned files in user homes).
- OMC/`claude`-coupled skills (all-in-one, ultra-init, omc-reference, setup-omc-hud, setup-insane-search, setup-stitch-proxy) and the `front-qa`/`setup` commands are Claude-Code-only.
