---
name: update-banker
description: "(banker) 설치된 banker 를 최신 배포본으로 갱신. Claude 플러그인·npm 전역 CLI·Codex 3채널이 독립 드리프트하므로 npm 우선 게이트 후 채널별 갱신·3-프로브 검증. 'update-banker'/'banker 업데이트'/'banker 최신화'/'banker 드리프트' 시 사용."
---

# update-banker: 설치된 banker 3채널 갱신 (Claude 플러그인·npm 전역 CLI·Codex)

banker 는 서로 다른 메커니즘의 채널 3개로 설치되고, 그 채널들은 **독립적으로 드리프트한다.**
이 스킬은 각 채널을 그 채널의 공식 경로로 끌어올리고, 갱신 여부를 exit code 가 아니라 **관측**으로 판정한다.
여기서 오작동의 대가는 나쁜 조언이 아니라 **설치본 손실**이다(Codex 경로가 sweep-then-copy 다).
그래서 아래의 순서 게이트와 금지 목록은 편의보다 우선한다. 답변은 한글(기술 토큰·경로·명령은 영문).

**런타임:** 축은 OS 가 아니라 **채널**이다. banker 는 dependencies 0 이고 설치가 파일 복사라 OS 분기가 사실상 없다.

- **Claude Code**: 플러그인 채널이 있다. 갱신 동사는 `claude plugin update`, 관측 지점은 `~/.claude/plugins/installed_plugins.json`.
- **Codex CLI**: `codex plugin` 에 update 동사가 **없다.** 유일한 경로는 npm 갱신 후 `banker setup --codex` 이고, 이건 파괴적이다.
- **양쪽 공통**: npm 전역 CLI 채널. 이게 Codex 채널의 **상류**라 언제나 먼저다.
- 이 스킬은 `target: both` 다. Codex 런타임에 `claude` 가 없거나 Claude 런타임에 `codex` 가 없는 것은 **정상 경로**다. 채널 부재는 스킵이지 에러가 아니다.
- **"채널 부재" 는 두 가지다.** (a) 런타임이 없다(`command -v claude` 실패), (b) 런타임은 있는데 **banker 플러그인이 설치돼 있지 않다.** `command -v` 는 (a) 만 잡는다. Codex 주력 + Claude Code 설치됨 + banker 플러그인 미설치인 머신이 실재하고, 거기서 (b) 를 스킵으로 처리하지 않으면 프로브가 예외로 죽는다. 둘 다 스킵이다.

## When to use
- 새 배포본이 나와 설치본을 끌어올릴 때.
- 최신 배포본에 있어야 할 banker 스킬이 런타임에 안 보일 때(드리프트 의심).
- 채널 간 상태가 갈렸는지 확인하고 정렬할 때.
- 사용자가 `update-banker`/`banker 업데이트`/`banker 최신화`/`banker 드리프트` 라고 할 때.

## When NOT to use
- **최초 설치**. 그건 `banker setup` 또는 `/banker:setup` 소관이다.
- **OMC/OMX 갱신**. `setup-omc` 소관이다. banker 는 그 버전을 대신 고정하지 않는다.
- **깨진 설치 되살리기**. 갱신이 아니다. 아래 "복구" 절을 보고, 확인을 받고 진행한다.
- 스킬 하나만 고치고 싶을 때. 갱신 단위는 채널 전체다.
- 3채널이 아닌 경로(로컬 clone 을 직접 가리키는 개발 설치 등). 그건 이 스킬의 모델 밖이다.

## 채널 3개 (진짜 축)

| 채널 | 메커니즘 | 갱신 경로 | 관측 지점 |
|---|---|---|---|
| Claude 플러그인 | 마켓플레이스 등록 후 플러그인 설치 | `claude plugin update banker@banker-plugins` | `~/.claude/plugins/installed_plugins.json` |
| npm 전역 CLI | npm 레지스트리에서 전역 prefix 로 설치 | `npm i -g @kaydash9999/banker-plugins@latest` | `banker --version` |
| Codex | npm 패키지에서 `~/.codex/skills` **와 `~/.codex/prompts`** 로 복사 | `banker setup --codex` | `ls ~/.codex/skills` **와** `ls ~/.codex/prompts` |

세 채널은 다른 갱신 동사를 쓰고 각자의 값을 가진다. 한 채널을 갱신해도 나머지는 그대로다. 실제로 세 값이 모두 다른 상태가 관측된다.

**결합 각주:** 저장소까지 항상 독립인 것은 아니다. `banker setup --claude` 는 `claude plugin marketplace add <PKG_ROOT>` 로 **npm 패키지 디렉터리 자신**(전역 설치면 `$(npm root -g)/@kaydash9999/banker-plugins`)을 마켓플레이스로 등록한다(bin/banker.js). 그 경로로 설치한 사용자에게 Claude 채널의 상류는 npm 전역 디렉터리이고, 두 채널은 결합된다. 위험은 아니다. npm 을 먼저 올리면 마켓플레이스 소스도 함께 전진하므로 순서 게이트가 오히려 강화된다. 다만 "완전 독립" 을 전제로 추론하지는 마라.

**OS 각주:** OS 가 실제로 걸리는 지점은 npm 전역 prefix 하나다. `npm i -g` 가 EACCES 로 실패하면 `sudo` 로 넘기지 말고 사용자 소유 prefix 로 옮긴 뒤(`npm config set prefix ~/.local`) `PATH` 에 `<prefix>/bin` 이 있는지 확인한다. 나머지는 OS 무관이다.

## 절대 금지

**1. `claude plugin install` 로 갱신하지 마라.**
- 이미 설치된 플러그인을 업그레이드하지 못한다. `--force`/`--upgrade` 같은 옵션은 없다.
- 정확히 말하면 "설치돼 있으면 항상 no-op" 이 아니라 **"의존성이 온전하면 no-op"** 이다. 의존성이 미충족이면 early return 을 건너뛰고 실제 설치로 진행한다. 즉 동작이 상태에 따라 갈려서, 갱신 수단으로는 신뢰할 수 없다.
- 실질 위험은 사람이 출력을 오독하는 게 아니라 **exit 0 으로 인한 자동화의 silent pass** 다. 성공 표시와 함께 exit 0 을 주므로 CI·스크립트는 갱신이 일어난 것으로 통과시킨다. 통제 실험에서 동일한 stale 상태에 대해 install 은 버전을 그대로 뒀고 update 만 전진했다.

**2. `claude plugin marketplace remove banker-plugins` 를 쓰지 마라.**
- 그 마켓플레이스에서 설치한 플러그인을 **전부 언인스톨한다.** 갱신 수단이 아니라 파괴 수단이다.
- 주의: banker 자신의 `banker uninstall --claude` 가 `plugin uninstall` 에 이어 이 `marketplace remove` 를 **포함한다**(bin/banker.js). 갱신 맥락에서 `banker uninstall` 을 부르지 마라.

**3. 맨 `npm update -g` 를 쓰지 마라. 패키지 스코프로만 간다.**
- 전역에 설치된 무관한 패키지까지 전부 끌어올린다. 그중 네이티브 모듈을 가진 것이 재빌드에 실패하면 banker 와 아무 상관 없는 이유로 전역 설치 상태가 망가진다.
- 반대 방향의 거짓말도 하지 마라: banker 자체는 dependencies 0 이라 컴파일이 없다. **빌드 도구·툴체인 준비를 요구하는 절차를 넣으면 그건 거짓이다.**

**4. `~/.claude/plugins/cache/` 를 `rm -rf` 하지 마라.**
- 캐시에 구버전이 공존하는 것은 **관측 대상이지 조치 대상이 아니다.** 갱신 의미론 밖이고, 자동 정리 주기에 관한 증거는 서로 어긋난다.
- 발견하면 보고만 한다. 손대지 않는다.

## 워크플로

### 0. 관측 (추정 금지)
여기서 찍은 값이 4단계 검증의 before 다. 먼저 어떤 채널이 이 머신에 실재하는지 판정한다.

```bash
command -v claude >/dev/null && echo "claude: present" || echo "claude: absent (Claude 채널 스킵)"
command -v codex  >/dev/null && echo "codex: present"  || echo "codex: absent (Codex 채널 스킵)"
command -v banker >/dev/null && banker --version || echo "banker: absent"
npm view @kaydash9999/banker-plugins version
```

부재한 채널은 그 자리에서 "스킵" 으로 확정한다. 없는 채널을 되살리려 들지 마라(그건 설치지 갱신이 아니다).

### 1. npm 먼저 (순서 게이트)
이 스킬의 핵심 안전장치다. **순서를 바꾸지 마라.**

```bash
npm i -g @kaydash9999/banker-plugins@latest
banker --version
npm view @kaydash9999/banker-plugins version
```

두 값이 **일치할 때만** 다음 단계로 간다. 불일치면 **즉시 중단**하고 보고한다. 우회하지 마라.

**이유:** `banker setup --codex` 는 copy 전에 `sweepCodexArtifacts()` 로 `~/.codex/skills` **와 `~/.codex/prompts`** 의 모든 `banker-*` 를 **먼저 지운다**(bin/banker.js 의 sweep 루프는 `skills` 와 `prompts` 두 디렉터리를 돈다). 구버전 bin 으로 실행하면 sweep 은 현재 설치분 전부를 지우고, 복원은 **그 구버전 매니페스트에 있는 개수만큼만** 한다. 차액은 조용히 사라지고 종료 코드는 성공이다.

**폭발 반경은 두 축 모두다.** 스킬만 세면 프롬프트 소실이 구조적으로 안 보인다. 프롬프트는 매니페스트의 `type: command` 중 **`target: both` 인 것만** 복원된다. 그러니 세야 할 것은 raw command 엔트리 수가 아니라 **복원 대상 수**다. 구버전 매니페스트의 복원 대상 command 가 0 이면 게이트를 우회한 순간 **프롬프트 손실률은 100%** 다(엔트리가 있어도 `target` 이 `both` 가 아니면 복원되지 않는다).

PATH 의 `banker` 가 구버전인데 레지스트리 latest 가 앞서 있는 상태는 가설이 아니다. 실측 사례:

```
설치분 (~/.codex)          : skills 41, prompts 2
PATH 의 banker             : 0.2.0   (구버전)
레지스트리 latest          : 0.6.0
0.2.0 매니페스트의 복원량  : skills 18, commands 0
```

게이트 없이 그 구버전 bin 으로 `setup --codex` 를 돌리면 sweep 43개(skills 41 + prompts 2) 뒤 복원은 18개뿐이다. **스킬 23개 소실 + 프롬프트 2개 전량 소실**, 종료 코드는 0. 스킬 축만 보는 프로브는 앞의 23 만 보고 프롬프트 100% 소실을 놓친다. 그래서 프로브 3 은 축이 둘이다.

불일치의 흔한 원인은 설치 실패가 아니라 배선이다. 단정하기 전에 확인하라.
- PATH 에 다른 prefix 의 `banker` 가 앞서 있다: `command -v banker`, `npm root -g`.
- 셸이 옛 경로를 캐시했다: `hash -r`.
- `npm i -g` 가 권한 문제로 조용히 실패했다: 위 OS 각주.

### 2. Claude 플러그인 채널
`claude` 가 없으면 스킵이다. 에러가 아니다.

```bash
claude plugin update banker@banker-plugins
```

- 옵션은 `-s/--scope`(`user`|`project`|`local`|`managed`, 기본 `user`)와 `-h/--help` 뿐이다. help 문구는 "Update a plugin to the latest version (restart required to apply)".
- **옵션은 문서가 아니라 live `--help` 가 정본이다.** 공식문서의 옵션표는 실제 CLI 보다 뒤처져 있다(`plugin install` 의 `--config` 누락 확인). 옵션을 쓰기 전에 `claude plugin update --help` 로 확인하라.
- `<plugin>` 은 bare name(`banker`) 또는 `plugin@marketplace`(`banker@banker-plugins`) 둘 다 받는다. 마켓플레이스가 여럿이면 후자로 특정한다.
- **반영에는 재시작이 필요하다**(help 가 명시). 재시작 전 관측이 옛 값인 것은 실패가 아니다.
- **DISPUTED:** `claude plugin marketplace update banker-plugins` 를 먼저 돌려야 하는지는 **미결이다.** 확정된 것은 "마켓플레이스 갱신 단독으로는 설치본이 교체되지 않는다"(카탈로그·리스팅만 갱신)까지다. "항상 2단계"는 확정이 아니다. git-source 통제 실험에서 `claude plugin update <p>@<mkt>` 단독으로 마켓플레이스 clone 의 git HEAD 가 전진한 사례가 있다. 2단계를 기정사실로 쓰지 말고, 4단계 프로브가 전진을 보이지 않을 때에 한해 `marketplace update` 를 추가로 돌린 뒤 그 사실을 보고하라.

### 3. Codex 채널
`codex` 가 없으면 스킵이다. 에러가 아니다. **1단계 게이트를 통과하지 않았다면 이 단계에 진입하지 마라.**

`banker setup --codex` 는 sweep-then-copy 라 파괴적이다. 반드시 2단으로 간다.

```bash
banker setup --codex --dry-run   # 계획만 출력. 사용자에게 보여주고 확인받는다.
banker setup --codex             # 확인 후에만
```

- **dry-run 은 `swept N ...` 요약줄을 출력하지 않는다.** 그 줄은 실제 삭제를 세는 카운터에 걸려 있어 dry-run 경로에서는 발화하지 않는다. 개별 `[dry-run] sweep <경로>` 줄만 나온다. `grep -c 'swept'` 로 세려 하지 마라. 0 이 나온다.
- **축을 섞지 마라.** raw sweep 줄은 skills 와 prompts 가 **혼합**이고 copy 요약줄은 `→ N skills ..., M prompts` 로 **분리** 출력이라, 그대로 비교하면 사과 대 오렌지다. 축을 맞춰 센다:

```bash
banker setup --codex --dry-run | grep '\[dry-run\] sweep' | grep -c '/skills/'    # sweep 대상 skills
banker setup --codex --dry-run | grep '\[dry-run\] sweep' | grep -c '/prompts/'   # sweep 대상 prompts
banker setup --codex --dry-run | grep -E '→ [0-9]+ skills'                        # copy 대상 skills·prompts
```

- **축별로** copy 수가 sweep 수보다 작으면 그 차액은 이번 갱신으로 사라진다. 1단계 게이트를 통과하지 않은 상태라면 그건 소실이다. 실행하지 말고 1단계로 돌아가라.
- 게이트를 통과한 상태의 차액이라도 **"배포본에서 빠진 것" 으로 단정하지 마라.** sweep 은 `banker-` 접두사만 보므로 **사용자가 손수 만든 `banker-*`** 도 함께 지운다. 차액에 해당하는 이름을 사용자에게 그대로 제시하고, 배포본 것인지 사용자 것인지의 판정은 사용자에게 맡긴다. 사용자 소유가 섞여 있으면 실행 전에 백업을 제안한다.
- `--scope project` 는 `./.codex` 를 대상으로 한다. 기본은 `user`(`~/.codex`).
- 스킬은 `~/.codex/skills/banker-<name>/` 으로, 커맨드는 `~/.codex/prompts/banker-<name>.md` 로 설치된다. 스킬은 프론트매터 name 이 디렉터리명과 일치하도록 재작성된다. `~/.codex/AGENTS.md` 는 건드리지 않는다.

### 4. 검증 (보고 의무)
**exit code 로 판정하지 마라.** `claude plugin install` 이 아무것도 안 하고 exit 0 을 주는 것이 정확히 그 이유다.
판정은 0단계와 **동일한 3-프로브를 재실행**해 before/after 를 비교하는 것으로만 한다.

**"단일 banker 버전" 이라는 개념을 쓰지 마라.** 채널 3개는 각자의 값을 가지며, 정상적으로 서로 다를 수 있다. 보고는 채널별로 한다.

프로브 1, Claude(`jq` 에 의존하지 않는다. 없을 수 있다. Node 는 banker 가 이미 요구한다).
**부재 내성이 필수다.** `command -v claude` 는 런타임만 보므로, 런타임이 있어도 플러그인 키가 없을 수 있다. 아래는 파일 부재·키 부재를 모두 스킵으로 보고하고 정상 종료한다:
```bash
node -e "const f=require('os').homedir()+'/.claude/plugins/installed_plugins.json';
let j;try{j=require(f)}catch{console.log('absent');process.exit(0)}
const e=j.plugins&&j.plugins['banker@banker-plugins'];
console.log(e&&e[0]?e[0].version:'absent (Claude 채널 미설치 -> 스킵)')"
```
`absent` 이 나오면 Claude 채널은 스킵이다. 실패가 아니다.

프로브 2, npm(두 값이 같아야 한다):
```bash
banker --version
npm view @kaydash9999/banker-plugins version
```

프로브 3, Codex. **축이 둘이다**(skills, prompts). 각각 설치분과 매니페스트를 대조한다. 스킬만 세면 프롬프트 소실을 못 본다:
```bash
ls ~/.codex/skills  2>/dev/null | grep -c '^banker-'    # 설치된 skills
ls ~/.codex/prompts 2>/dev/null | grep -c '^banker-'    # 설치된 prompts
M="$(npm root -g)/@kaydash9999/banker-plugins/codex/manifest.json"
node -e "const s=require(process.argv[1]).surfaces,n=t=>s.filter(x=>x.type===t&&x.target==='both').length;
console.log('manifest skills:',n('skill'));console.log('manifest commands:',n('command'))" "$M"
```

보조로 `banker doctor` 가 디스크 카운트와 매니페스트 카운트를 나란히 찍어준다. **다만 프롬프트 카운트가 없어 프로브 3 을 대체하지 못한다.** 스킬 축의 교차 확인용으로만 쓴다.

보조 프로브(디스크 상태가 아니라 런타임이 실제로 발견한 표면을 본다. 인증 불필요):
```bash
codex debug prompt-input </dev/null | grep -oE 'banker-[a-z0-9_-]+' | sort -u | wc -l
```

보고 형식(채널별 before 에서 after 로. 아래는 예시):
```
Claude 플러그인 : 0.6.0 -> 0.7.0             전진
npm 전역 CLI    : 0.2.0 -> 0.7.0             전진
Codex skills    : 41 -> 48 (매니페스트 48)   전진
Codex prompts   : 2 -> 2   (매니페스트 2)    유지
```

- **Codex 는 skills 와 prompts 를 반드시 두 줄로 적는다.** 한 줄로 뭉개면 프롬프트 소실이 보고에서 사라진다.
- 스킵한 채널은 "스킵(런타임 없음)" 또는 "스킵(플러그인 미설치)" 으로 적는다. 성공으로도 실패로도 적지 마라.
- 전진하지 않은 채널이 있으면 그대로 적는다. 가짜 성공 금지.
- Claude 채널이 재시작 전이면 "재시작 대기" 로 적는다.
- 캐시에서 구버전을 봤으면 관측 사실로만 적는다(조치하지 않는다).

## 복구 (갱신이 아니다)
여기는 **깨진 설치를 되살리는** 영역이다. 갱신이 목적이면 오지 마라. 갱신 절차가 복구 절차로 미끄러지는 것이 이 스킬의 대표적 사고 경로다.

- 3채널이 모두 전진했는데도 런타임이 옛 표면을 보이면: **먼저 재시작한다**(help 가 명시한 조건). 그것으로 대부분 끝난다.
- 재시작 후에도 남으면 그건 갱신 실패가 아니라 설치 손상이다. 이 스킬의 범위 밖이다. 채널별 공식 설치 경로(`banker setup` / `/banker:setup`)로 **재설치**를 제안하되, 재설치는 갱신이 아니므로 **실행 전에 확인을 받는다.**
- 복구라 해도 위 "절대 금지" 는 그대로 적용된다. 특히 `marketplace remove` 와 캐시 삭제는 복구 수단으로도 제안하지 마라.

## 함정
- **3채널을 하나로 뭉개는 것.** "banker 버전" 이라는 단일 값은 없다.
- **exit 0 을 성공으로 읽는 것.** 이 도메인에서 종료 코드는 신호가 아니다. 관측만이 신호다.
- **순서를 바꾸는 것.** Codex 를 npm 보다 먼저 돌리면 sweep 이 현재 설치분을 지우고 구버전 개수만 복원한다. `~/.codex/skills` 와 `~/.codex/prompts` **둘 다** 다. 이것이 이 스킬에서 데이터가 사라지는 유일하고 실재하는 경로다.
- **스킬만 세는 것.** 프롬프트 축을 빼면 구버전 매니페스트의 **복원 대상 command 가 0** 일 때 생기는 **프롬프트 100% 소실**을 구조적으로 볼 수 없다. `banker doctor` 도 프롬프트를 세지 않으므로 대체가 안 된다.
- **sweep 차액을 "배포본에서 빠진 것" 으로 단정하는 것.** sweep 은 `banker-` 접두사만 본다. 사용자가 손수 만든 것도 지운다. 오귀속하지 말고 이름을 제시하라.
- **dry-run 에서 `swept` 요약줄을 찾는 것.** 그 줄은 dry-run 에 없다. 개별 `[dry-run] sweep` 줄을 축별로 세라.
- **채널 부재를 실패로 처리하는 것.** `target: both` 라 한쪽 런타임에 다른 쪽 CLI 가 없는 게 정상이다. 런타임은 있는데 플러그인만 미설치인 경우도 부재다.
- **`banker --version` 이 옛 값인 것을 곧장 설치 실패로 단정하는 것.** PATH·셸 해시 캐시를 먼저 본다.
- **툴체인 준비를 요구하는 것.** banker 는 dependencies 0 이라 컴파일이 없다.
- **재시작 전 관측으로 실패를 선언하는 것.**
- **마켓플레이스 갱신을 설치본 갱신으로 착각하는 것.** `marketplace update` 는 카탈로그·리스팅만 건드린다.
- **DISPUTED 를 확정으로 승격하는 것.** 미결은 미결로 적는다.

## 원칙
- 순서 게이트가 최우선이다. npm 먼저, 일치 확인, 그다음 나머지. 불일치면 중단.
- 파괴적 단계는 dry-run 먼저, 확인 후 실행.
- 판정은 관측으로 한다. exit code 금지.
- 보고는 채널별로 한다. 하나의 값으로 뭉개지 않는다.
- 부재는 스킵이다. 에러가 아니다.
- 옵션의 정본은 live `--help` 다. 문서는 뒤처질 수 있다.
- 모르는 것은 DISPUTED 로 표기하고 관측 결과를 함께 보고한다. 확정처럼 쓰지 않는다.
- 갱신 의미론 밖(캐시 삭제·마켓플레이스 제거·재설치)은 하지 않는다. 필요하면 "복구" 로 분리해 확인을 받는다.

ARGUMENTS: [--check] [--claude|--npm|--codex] (없으면 3채널 전부: 관측 → npm 게이트 → 나머지 채널 → 3-프로브 검증)
- `--check`: 아무것도 변경하지 않는다. 0단계 관측 + 4단계 프로브만 돌려 채널별 드리프트를 보고한다.
- `--claude` / `--npm` / `--codex`: 해당 채널만 갱신한다.
- 단 `--codex` 단독이어도 1단계 게이트(`banker --version` == `npm view ...`)는 **반드시** 확인한다. 불일치면 npm 갱신을 먼저 제안하고 확인받는다. 게이트 없는 `--codex` 는 없다.
