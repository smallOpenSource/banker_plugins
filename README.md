# banker-plugins

Claude Code 플러그인 — QA·감사·문서·아키텍처·위키 스킬 + OS 의존성 설치기(`/banker:setup`)를
한 번에 제공합니다. 설치하면 모든 스킬/커맨드가 **`/banker:<이름>`** 네임스페이스로 노출됩니다.

이 repo는 그 자체로 **Claude Code 마켓플레이스**(`.claude-plugin/marketplace.json`)이자
**플러그인**(`.claude-plugin/plugin.json`, name `banker`)입니다.

## 설치

```bash
# 마켓플레이스 추가 + 플러그인 설치 (CLI)
claude plugin marketplace add smallOpenSource/banker_plugins
claude plugin install banker@banker-plugins
```

또는 Claude Code 세션 안에서:

```text
/plugin marketplace add smallOpenSource/banker_plugins
/plugin install banker@banker-plugins
```

설치 후 스킬·커맨드는 **`/banker:refresh-git-ignore`**, **`/banker:rfp-author`** 처럼 `/banker:` 로 호출됩니다.
스코프는 `-s user|project|local`(기본 `user`) — 현재 프로젝트에만: `claude plugin install banker@banker-plugins -s project`.

### 의존성·구성요소 설치 (선택)

playwright(브라우저 QA)·omc_hud·insane-search·stitch MCP 등은 OS 의존성이 있어 **별도 설치**가 필요합니다:

```text
/banker:setup
```

`multi-select` 로 필요한 항목을 골라 설치합니다(각 항목이 OS를 감지해 알맞은 절차·폴백 적용). 개별 실행도 가능:
`/banker:setup-playwright` · `/banker:setup-omc-hud` · `/banker:setup-insane-search` · `/banker:setup-stitch-proxy`.

## 업데이트 / 제거

```bash
claude plugin update banker                       # 플러그인 최신화 (재시작 후 적용)
claude plugin marketplace update banker-plugins   # 마켓플레이스 메타 갱신
claude plugin uninstall banker                    # 제거
```

## 구성

### 커맨드
| 커맨드 | 설명 |
|---|---|
| `/banker:front-qa` | 스펙(note) 기반 프론트엔드 구현 + 엄격 parity QA |
| `/banker:setup` | 구성요소·OS 의존성 multi-select 설치 오케스트레이터 |

### 스킬 — QA · 감사
| 스킬 | 설명 |
|---|---|
| `audit-security` | 보안 취약점(CVE·SAST·시크릿) 진단 (read-only) |
| `audit-mock` | 하드코딩·mock/stub·열거형 정적 검출 (read-only) |
| `audit-web-page` | 라이브 웹 페이지 점검 (playwright·WebGL 캔버스) |
| `game-qa` | 웹 게임(Godot HTML5) 직접 플레이 QA |
| `ultra-ui-qa` | UI를 기준(디자인 PDF/스펙)과 1:1 대조 QA |

### 스킬 — 문서 · 디자인 · 위키
| 스킬 | 설명 |
|---|---|
| `arch-diagram` | 시스템 아키텍처 구성도 (PlantUML + 편집가능 PPTX) |
| `make-notion-guide` | API 호출 가이드를 노션 양식 문서로 작성 |
| `pdf-vision-extract` | 비주얼 PDF를 고해상도 PNG로 변환(비전 입력) |
| `nothing-design` | Nothing 스타일 UI 디자인 적용 |
| `rfp-author` | 외주 제안요청서(RFP) 저작 (범용 프레임워크) |
| `humanizer` | AI 글 흔적 제거(자연스러운 문체로 윤문) |
| `lineage` | 세션 대화를 카카오톡 스타일 단일 HTML로 export |
| `append_wiki` | 프로젝트 위키 문서 추가/보강 |
| `compact-wiki` | 위키 중복 제거·supersede·병합 (무손실) |

### 스킬 — 워크플로 · 유틸
| 스킬 | 설명 |
|---|---|
| `all-in-one` | 계획→구현→검증 end-to-end 오케스트레이터 |
| `ultra-init` | 아이디어→빌드→테스트 원샷 자동 실행 |
| `ready-compact` | 컨텍스트 compaction 직전 상태 저장/이어가기 |
| `refresh-git-ignore` | `.gitignore` 비파괴·반복가능 갱신 |
| `omc-reference` | OMC 에이전트/툴/스킬 레퍼런스 |

### 스킬 — 설치 (`/banker:setup` 가 호출)
| 스킬 | 설명 |
|---|---|
| `setup-playwright` | Playwright + headless 브라우저 (RHEL8/Rocky8·non-root·no-conda 폴백) |
| `setup-omc-hud` | omc_hud 상태표시줄 (OS별) |
| `setup-insane-search` | insane-search 플러그인 설치 |
| `setup-stitch-proxy` | Stitch 디자인 MCP 프록시 등록 |

## 라이선스 / 소유

- Owner: [smallOpenSource](https://github.com/smallOpenSource)
- Version: 0.1.0

### 서드파티 (Third-party)

- `skills/humanizer` — [blader/humanizer](https://github.com/blader/humanizer) 기반, **MIT License** (© 2025 Siqi Chen). 원본 라이선스 고지는 `skills/humanizer/LICENSE`에 포함되어 있습니다.
