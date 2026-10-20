---
name: audit-security
description: "의존성 CVE(SCA), 코드 정적 분석(SAST), 시크릿 노출을 여러 도구로 교차 검증해 보안을 진단. 코드는 읽기만 함. 'audit-security'/'보안 진단'/'CVE 스캔'/'SCA 스캔'/'SAST 스캔'/'secret 스캔' 시 사용."
---

# audit-security — CVE / SAST / Secrets read-only 보안 진단 (no-root)

프로젝트 전체(서브앱: backend/frontend/service 등)의 **보안 취약점**을 **코드·빌드 무변경(읽기 전용)**·**no-root(sudo 없음, root 아님)** user-space 도구로 진단.
3축 — **SCA**(의존성 CVE 매칭) + **SAST**(소스 정적 분석) + **Secrets**(자격증명 노출). 멀티툴 **교차검증**으로
consensus는 고신뢰, 단일툴은 needs-review. 산출물은 방안·권고 리포트 + 실 findings 리포트 + 멱등 러너.
`audit-mock`(하드코딩/stub 정적감사)의 **자매 스킬** — audit-mock이 명시 제외한 **자격증명·CVE 영역**을 담당.

## When to use
- "audit-security", "보안 진단", "CVE/취약점 스캔", "SCA·SAST·secret 스캔", "dependency CVE 찾기", "노출된 비밀키 찾기"
- 서브앱들의 의존성·소스·시크릿을 **전수 점검**하고 리포트로 박제할 때
- 의존성 bump 후 **CVE 해소 수를 재스캔으로 확정**할 때
- 이전 세션/에이전트의 "취약점 없음" 주장을 **직접 재검증**할 때

## 불변 원칙
1. **read-only**: 소스·`pom.xml`/`package.json`/`requirements.txt`/CI **일절 무변경**. 도구·러너·결과는 작업용 디렉터리(예: gitignored `.audit/` 또는 `$RESEARCH_DIR`)에 격리. 도구는 advisory DB만 조회(소스 미수정).
2. **시크릿 값 비노출**: 리포트·로그에 **secret value 절대 미기입**. `RuleID + file:LINE`만. 값 확인이 필요하면 사용자에게 "해당 file:LINE 직접 확인" 안내(cat/grep로 값 출력 금지).
3. **local-first + 온라인 교차검증**: advisory DB는 로컬/공개(OSV·deps.dev·trivy-db)를 1차로, 온라인은 recall 보강용 교차검증만. **active-verify 금지** — 시크릿을 **실 엔드포인트에 인증 시도**하는 egress는 금지(특히 규제·민감 환경에선 절대 불가).
4. **verify-before-claim**: 모든 finding은 `CVE-ID`/`RuleID` + `file:LINE` 동반. "0건 = 안전 보증" **금지**(semgrep CE는 intraprocedural — 함수 경계 taint 미추적; parse 실패 파일 = 미커버). 완료 전 4-field(① 변경 ② Evidence ③ 검증 ④ Unknown), ⏳=0일 때만 "완료".
5. **remediation은 사용자 게이트**: 의존성 version bump(`pom.xml`/`package.json`/`requirements.txt` 편집)·secret rotate는 **기능 리스크 있는 실변경 → 자율 X, 사용자 confirm**. 스캔·재빌드-검증은 자율 OK이나 **버전 편집 자체는 게이트**.

## 1단계 — preflight (설치여부 검사 → 누락분만 설치, 멱등)
**스킬 진입 시 항상 먼저 실행. 무조건 재설치 절대 금지 — 있으면 skip, 없는 것만 설치:**
- 각 도구 `command -v` 검사(semgrep은 venv path `-x`) → **누락분만** 설치: Go 도구는 GitHub release asset 다운로드(`~/.local/bin`), pip 도구는 `pip install --user`, semgrep은 격리 venv.
- 멱등 setup 러너로 감싸면 재진입이 빠름(전부 있으면 network 0). exit 0=준비됨, exit 1=누락 잔존.

### 도구 (예시 조합 — 검증된 stack, 대상 박스에 맞게)
| 도구 | 위치 | 설치 방식 |
|---|---|---|
| **osv-scanner** | `~/.local/bin` | release `…_linux_amd64`(Go static) |
| **trivy** | `~/.local/bin` | release `…tar.gz`(Go static) |
| **grype** | `~/.local/bin` | release `…tar.gz`(Go static) |
| **gitleaks** | `~/.local/bin` | release `…tar.gz`(Go static) |
| **pip-audit** | pip --user | `pip install --user`(→ `~/.local/bin`) |
| **detect-secrets** | pip --user | `pip install --user` |
| **semgrep** | 격리 venv(`$(command -v semgrep)`) | 버전 핀 venv |

- ⚠️ **오래된 glibc 환경**(예: RHEL8 glibc 2.28): Go 정적 바이너리(osv/trivy/grype/gitleaks)는 glibc 무관해 `~/.local/bin`에 두면 그대로 동작. Python wheel·ast-grep CLI는 glibc 2.29+ 요구로 실패할 수 있음 → semgrep은 **glibc 핀 venv**로 격리.
- ⚠️ **`set -u` 주의**: 일부 쉘 init이 `$ZSH_VERSION` 등 unbound 변수를 참조해 `set -u`가 command-substitution 서브셸을 깨뜨릴 수 있음(다운로드 URL이 빈 문자열이 됨). 러너는 `set -o pipefail`만 권장.
- ⚠️ **exit code 1 = 정상**(스캔 한정): osv/grype/gitleaks/npm audit는 "findings present"를 rc=1로 반환 — 에러 아님. (단 setup 러너의 exit 1은 "도구 미설치 잔존"으로 다름.) 그래도 결과로 읽기 전에 아래 "결과로 읽는 조건" 을 먼저 본다. 네트워크가 없으면 npm audit 도 rc 1 이지만 본문은 오류뿐이다.

## 2단계 — 스캔 (멱등, 전 서브앱)
도구는 소스/`pom.xml`/`package.json`/CI 무변경. 3 카테고리:

### SCA (의존성 CVE) — 도구 역할 분담
| 도구 | 명령(예) | 커버 | 비고 |
|---|---|---|---|
| **osv-scanner** | `scan source -r $ROOT --format json` | 전 서브앱(.gitignore 존중) | **주력** — deps.dev 전이의존성, max recall |
| **trivy** | `fs --scanners vuln --skip-dirs node_modules,target,.git` | lockfile/manifest | osv와 **교차합의** |
| **grype** | `dir:$ROOT --exclude …` | (설치패키지/컨테이너용) | ⚠️ **소스 dir scan은 0건 가능** — lockfile 부적합. osv+trivy로 대체 |
| **npm audit** | `(cd <frontend> && npm audit --json)` | `package-lock.json` | npm registry advisory |
| **pip-audit** | `-r <requirements>.txt` | (PyPI+OSV) | ⚠️ 일부 env에서 실패 가능 → Python은 osv로 커버 |

#### 결과로 읽는 조건 (네트워크 없음과 0건을 가른다)
SCA 도구는 advisory DB 나 레지스트리를 네트워크에서 받는다. 네트워크가 없으면 결과 JSON 을 그대로 셀 때 0건이 된다.
실측(osv-scanner 2.4.0, npm 11, 네트워크 없음):
- 오프라인 `npm audit --json` 은 rc 1 이고, 본문은 `message` 와 `error` 뿐이다.
- `osv-scanner scan source` 는 20초 뒤 rc 127 이고, stdout 이 빈다.
- `--offline-vulnerabilities` 에 로컬 DB 가 없으면 rc 127 과 `{"results": []}` 이다.
- 로컬 DB 가 비어 있으면 rc 0 과 `{"results": []}` 다. 문제없음과 모양이 같다.
- 패키지 소스가 없으면 rc 128 이다. 네트워크가 아니라 대상이 없는 것이다.

도구마다 stdout 은 `$OUT/<도구>.json`, stderr 는 `$OUT/<도구>.err` 로 따로 남기고 종료 코드를 적는다. 아래 조건은 이 셋으로 본다. 조건을 모두 채워야 결과로 읽는다.

| 도구 | 결과로 읽는 조건 | 실측 |
|---|---|---|
| npm audit | 종료 코드 0 이나 1. 본문이 JSON 이고 `error` 키가 없음. `metadata.dependencies.total` 이 0 보다 큼 | 실측 |
| osv-scanner | 종료 코드 0 이나 1. 본문이 JSON. stderr 의 `Scanned <파일> file and found <N> package` 의 N 합이 0 보다 큼 | 실측 |
| osv-scanner 오프라인 DB | 위 조건에 더해, stderr 의 `Loaded <생태계> local db from <경로>` 가 가리키는 파일이 항목을 1개 이상 가짐 | 실측 |
| trivy | 종료 코드 0. 본문이 JSON 이고 `Results` 가 1개 이상 | 미실측 |
| grype | 종료 코드 0 이나 1. 본문이 JSON 이고 `matches` 키가 있음. stderr 에 DB 오류가 없음 | 미실측 |
| semgrep | 종료 코드 0 이나 1. 본문이 JSON 이고 `paths.scanned` 가 1개 이상. `errors` 에 규칙 내려받기 실패가 없음 | 미실측 |
| pip-audit | 종료 코드 0 이나 1. 본문이 JSON 이고 `dependencies` 가 1개 이상 | 미실측 |

- 조건을 하나라도 못 채운 도구는 0건으로 세지 않는다. 리포트 Unknown 에 "미커버(네트워크 없음 또는 대상 없음): <도구>, 종료 <코드>, <stderr 첫 줄>" 로 적는다.
- 이유를 짐작해 하나로 정하지 않는다. osv-scanner 의 128 은 패키지 소스 없음이고, npm audit 의 `ENOLOCK` 은 잠금 파일 없음이다.
- 미실측 행은 이 머신에 도구가 없어 출력 모양을 재지 못한 조건이다. 실제 출력이 조건과 달라 판단이 서지 않으면 미커버로 적는다.
- 오프라인 DB 로 돌렸으면 DB 의 기준일(파일 수정 시각)을 Evidence 에 적는다. 그 뒤에 나온 advisory 는 Unknown 에 미커버로 적는다.
- 한 축의 도구가 모두 미커버면 그 축 전체를 미커버로 적는다.
- Secrets 축(gitleaks, detect-secrets)은 로컬이라 네트워크와 관계없다.
- 오프라인에서 돌리는 길: osv-scanner `--offline-vulnerabilities`(미리 받은 DB), trivy `--skip-db-update --offline-scan`(DB 사본), grype `GRYPE_DB_AUTO_UPDATE=false`(가져온 DB), semgrep 은 로컬 규칙 파일(`--config <파일>`). 판마다 이름이 다를 수 있어 `--help` 로 확인한다.

### SAST (소스 정적) — semgrep CE
```
semgrep scan --config p/security-audit --config p/owasp-top-ten \
  --config p/java --config p/python --config p/typescript --config p/javascript \
  --metrics off --json  <소스 경로들>
```
⚠️ CE = **intraprocedural**(함수 간 taint 미추적), parse 실패 파일은 미커버 → "1건만 나옴 = 안전" 결론 금지.

### Secrets — 완전 로컬, egress 0
- `gitleaks git $ROOT` (full history + tracked) + `gitleaks dir <소스 경로들>` (working tree) — regex + Shannon 엔트로피
- `(cd $ROOT && detect-secrets scan)` (git-tracked, 플러그인 기반) — 교차검증용

## 교차검증 매트릭스 (consensus logic)
- **2+ 도구 합의** → 고신뢰(confirmed).
- **단일 도구** → `needs-review` 플래그(예: pip-audit 실패 시 Python은 osv 단독 → needs-review 명시).
- 집계는 transcript trust 금지 — 결과 `*.json`을 **jq로 직접** 카운트(CVE-ID·패키지·심각도). semgrep `lines`가 "requires login"으로 가려지면 file 직접 read 보강.

## Secret triage — **git-tracked vs gitignored가 심각도를 가른다** (핵심)
gitleaks/detect-secrets raw finding은 **노출 여부 미판정**. 각 경로에 대해:
```bash
git ls-files --error-unmatch <path>   # exit 0 = 커밋됨(repo 노출, 高)
git check-ignore <path>               # exit 0 = gitignored(로컬 전용, repo 노출 아님)
```
- **커밋됨(tracked)** = repo 히스토리 노출 → 실 키면 rotate 대상(高).
- **gitignored 로컬** = privkey.pem/.env 등 dev box 파일 — **repo 노출 아님**, 파일권한 이슈만(低). "secret 누출"로 과대경보 금지.

## 제약 보존 — 재경보 / 과대경보 금지
- **알려진·의도적 설정**(예: 의도적 CORS `*` / allow-hosts `0.0.0.0`)은 프로젝트의 수용 결정 — 결함으로 flag 금지.
- **기인지·수용된 노출**(예: 개인+비공개 repo의 인지된 PAT) = finding 목록엔 두되 "신규 위협"으로 재경보 X.
- **테스트 픽스처 secret**(JWT 샘플 등) = 실 키 여부 사용자 판단. placeholder(`default="dummy"` 등)는 低위험.

## 산출물 / 리포트 컨벤션
- **방안·권고** 리포트: no-root 스택, 현 갭, 설치/실행 플랜, local-first 정책.
- **실 findings** 리포트(point-in-time): TL;DR 심각도표 → 🔴 CRITICAL/HIGH(CVE-ID+pkg+버전) → 🟡 needs-review → 🟢 정상/수용 → 🔑 secret 트리아지(커밋/로컬/FP) → 교차검증 매트릭스 → remediation 우선순위 → 한계/Unknown.

## 함정 (학습됨 — 반드시 확인)
- **pip-audit ephemeral venv 실패**: 특정 패키지 "from versions: none"(env 한정) → Python SCA는 **osv-scanner가 requirements.txt 직접 파싱**으로 커버. pip-audit 결과 없음 ≠ Python 무취약.
- **grype 0건**: node_modules/target 제외하면 카탈로그 0(grype는 설치패키지/컨테이너용, 소스 lockfile 부적합). osv+trivy로 충분 — grype 0을 "취약점 없음"으로 오독 금지.
- **mvn `-q` 출력 억제**: `dependency:tree -q`는 lines=0. `-q` 빼야 트리 보임(osv가 전이의존성 이미 해소).
- **semgrep CE 한계**: intraprocedural + parse 실패 파일 미커버. "1 finding = 안전" 아님.
- **Go vs Python 바이너리**: Go 정적(osv/trivy/grype/gitleaks)은 오래된 glibc OK. ast-grep CLI는 `GLIBC_2.29 not found`로 불가할 수 있음 → 그 경우 ast-grep MCP만.
- **exit 1 ≠ error**, **`set -u` 깨짐**(위 preflight ⚠️).

## 원칙
verify-before-claim · Unknown 정직 표기 · remediation은 사용자 게이트.
