# Changelog

## [0.8.0] - 2026-07-17

### Added
- README 에 npm 월간 다운로드 배지와 GitHub stars 배지를 추가했다.
- `banker setup` 최초 실행 시 GitHub 저장소 별(star)을 요청하는 프롬프트를 추가했다(양 런타임 공통·홍보 목적·텔레메트리 동의 여부와 무관).
- **익명 사용량 텔레메트리 클라이언트 코드** + `banker telemetry on|off|status` 서브커맨드 + `PRIVACY.md`: opt-in(기본값 No)·Claude Code 전용·지속 식별자 없음(UUID 등 미생성)·수집 엔드포인트 설정형·기본 inert.

### Notes
- **정직 명시(중요)**: 텔레메트리는 코드로만 존재하며 `hooks.json` 에 배선되어 있지 않다(inert). 따라서 현재 릴리스는 아무 것도 수집·전송하지 않는다. 실제 수집·게시는 이벤트 payload 의 라이브 검증과 아직 완료되지 않은 법률 검토(미국 CCPA·한국 PIPA) 이후로 보류한다.

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
