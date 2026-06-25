# banker-plugins

Claude Code 플러그인 번들 — QA, 감사(security/mock), 문서화, 아키텍처 다이어그램 등
**18개 스킬 + 슬래시 커맨드**를 한 번에 설치합니다.

이 repo는 그 자체로 **Claude Code 마켓플레이스**(`.claude-plugin/marketplace.json`)이자
**플러그인**(`.claude-plugin/plugin.json`)입니다.

## 설치

```bash
# CLI (비대화형)
claude plugin marketplace add smallOpenSource/banker_plugins
claude plugin install banker-plugins@banker
```

또는 Claude Code 세션 안에서:

```text
/plugin marketplace add smallOpenSource/banker_plugins
/plugin install banker-plugins@banker
```

설치 스코프는 `-s user|project|local` (기본 `user`).
현재 프로젝트에만 설치하려면:

```bash
claude plugin install banker-plugins@banker -s project
```

## 업데이트 / 제거

```bash
claude plugin update banker-plugins        # 플러그인 최신화 (재시작 후 적용)
claude plugin marketplace update banker    # 마켓플레이스 메타 갱신
claude plugin uninstall banker-plugins     # 제거
```

## 구성

### 커맨드

| 커맨드 | 설명 |
|---|---|
| `/front-qa` | 스펙(note) 기반 프론트엔드 구현 + 엄격 parity QA |

### 스킬

| 스킬 | 설명 |
|---|---|
| `all-in-one` | 통합 워크플로 |
| `append_wiki` | 프로젝트 위키 문서 추가/보강 |
| `arch-diagram` | 시스템 아키텍처/계층 구성도 (PlantUML + 편집가능 PPTX) |
| `audit-mock` | 하드코딩·mock/stub·열거형 정적 검출 (read-only) |
| `audit-security` | 보안 취약점(CVE·SAST·시크릿) 진단 (read-only) |
| `audit-web-page` | 웹 페이지 감사 |
| `game-qa` | 웹 게임(Godot HTML5) 직접 플레이 QA |
| `humanizer` | AI 글 흔적 제거(자연스러운 문체로 윤문) |
| `lineage` | 세션 대화를 카카오톡 스타일 단일 HTML로 export |
| `make-notion-guide` | API 호출 가이드를 노션 양식 문서로 작성 |
| `nothing-design` | Nothing 스타일 UI 디자인 적용 |
| `omc-reference` | OMC 에이전트/툴/스킬 레퍼런스 |
| `pdf-vision-extract` | 비주얼 PDF를 고해상도 PNG로 변환(비전 입력) |
| `ready-compact` | 컨텍스트 compaction 직전 상태 저장/이어가기 |
| `refresh-git-ignore` | `.gitignore` 비파괴·반복가능 갱신 |
| `rfp-author` | 외주 제안요청서(RFP) 저작 |
| `ultra-init` | 아이디어→빌드→테스트 원샷 자동 실행 |
| `ultra-ui-qa` | playwright로 UI를 기준(디자인 PDF/스펙)과 1:1 대조 QA |

## 라이선스 / 소유

- Owner: [smallOpenSource](https://github.com/smallOpenSource)
- Version: 0.1.0

### 서드파티 (Third-party)

- `skills/humanizer` — [blader/humanizer](https://github.com/blader/humanizer) 기반, **MIT License** (© 2025 Siqi Chen). 원본 라이선스 고지는 `skills/humanizer/LICENSE`에 포함되어 있습니다.
