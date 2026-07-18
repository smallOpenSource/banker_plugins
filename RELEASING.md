# RELEASING — banker 릴리스 절차 (유지보수자 전용)

banker 는 3채널(npm · GitHub · Claude 마켓플레이스)로 배포된다.
버전의 단일 출처(single source of truth)는 `.claude-plugin/plugin.json` 의 `version` 이다.

이 문서는 릴리스마다 밟는 순서다.
특히 **4번(`gen-skill-changes.js`)은 잊기 쉽다.** 빠뜨리면 그 릴리스의 개인화 업데이트 알림에 넣을 "바뀐 스킬" 데이터가 비어, 자주 쓰는 스킬이 바뀐 사용자에게도 일반 알림으로만 나간다(고장은 아니지만 기능이 조용히 덜 동작한다).

## 순서

1. **변경사항 반영** — 기능/수정 작업을 끝낸다.

2. **버전 올리기** — `.claude-plugin/plugin.json` 의 `version` 을 새 semver 로 바꾼다(단일 출처).

3. **버전 동기화** — `npm run sync-version` 으로 `package.json` 을 `plugin.json` 에 맞춘다.

4. **바뀐 스킬 매니페스트 갱신 (← 잊기 쉬운 단계).** `node scripts/gen-skill-changes.js` 를 **버전 bump 후·릴리스 커밋 전**에 실행한다.
   - 이 타이밍이 핵심이다. 이때 `from` = 직전 릴리스 커밋(plugin.json 을 마지막으로 바꾼 커밋), `to` = 작업트리(방금 올린 새 버전)로 잡혀 diff 가 정확하다. 커밋 뒤에 실행하면 `from` 이 방금 만든 릴리스 커밋이 되어 diff 가 비어버린다.
   - `skills/` 에 바뀐 게 있으면 `skill-changes.json` 에 `{"<새 버전>": ["banker:<스킬>", …]}` 가 추가된다.
   - 바뀐 스킬이 0건이면 항목을 추가하지 않는다(정상 — 빈 항목은 개인화에 무의미). 예: 0.10.0 은 `bin/` 과 README 만 바꿔 skills/ 변경이 0건이었고, 그래서 `skill-changes.json` 에 항목이 없는 게 맞다.
   - 확인만 하려면: `node scripts/gen-skill-changes.js --print` (파일 미변경).

5. **마켓플레이스 버전 올리기** — `.claude-plugin/marketplace.json` 의 `metadata.version` 을 새 버전으로 바꾼다.

6. **CHANGELOG 갱신** — `CHANGELOG.md` 최상단에 새 버전 섹션을 추가한다.

7. **검증** — 유닛·스모크가 초록인지 확인한다.
   ```bash
   node --test hooks/*.test.mjs bin/lib/*.test.mjs bin/*.test.mjs
   node scripts/smoke-test.js
   ```

8. **커밋** — 위 변경(`plugin.json` · `package.json` · `skill-changes.json` · `marketplace.json` · `CHANGELOG.md` · 코드)을 **한 릴리스 커밋**으로 묶는다.

9. **push** — `git push` 로 main 에 올린다. GitHub 채널이 전진하고, `skill-changes.json` 의 GitHub raw 도 이때 반영된다(개인화 알림이 읽는 소스).

10. **npm 게시** — `./scripts/publish_npm.sh` 를 **대화형 터미널**에서 실행한다(웹 패스키 인증. 백그라운드/비대화 실행은 EOTP 로 실패한다). npm 은 같은 버전 재게시가 불가하니 앞 단계를 먼저 끝낸다.

11. **3채널 검증**
    ```bash
    npm view @kaydash9999/banker-plugins version dist-tags   # npm = 새 버전 / latest
    git log --oneline -1 origin/main                         # GitHub = 릴리스 커밋
    ```
    설치된 클라이언트의 Claude 마켓플레이스 채널은 `claude plugin update` 로 각자 끌어올린다(→ `skills/update-banker/SKILL.md`).

## 개인화 알림 부트스트랩 각주

`skill-changes.json` 의 `"<X>"` 항목은 설치 버전이 `X` 미만인 클라이언트만 읽는다(알림은 `installed < v <= latest` 구간만 계산한다).
그래서 과거(설치 버전 이하) 항목 백필은 불필요하고, `gen-skill-changes.js` 는 매 릴리스에 새 버전 항목을 "앞으로" 채우는 용도다.
계약 상세는 `bin/lib/telemetry-config.mjs` 의 `SKILL_CHANGES_URL` 주석과 `scripts/gen-skill-changes.js` 헤더를 참조한다.

개인화는 첫 지원 버전(0.9.0) 이후 릴리스부터 실제로 발화한다.
0.9.0 클라이언트가 이후 릴리스로 올라올 때, 그 릴리스에서 바뀐 스킬 중 사용자가 써 본 것이 있으면 알림에 표시된다 — 단 그 릴리스에서 4번을 밟아 항목을 채워 두었을 때만.
