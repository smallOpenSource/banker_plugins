# 게이트

게이트마다 한 줄: `PASS <이름>: <설명>`, `FAIL <이름>: <설명>`, 또는 `SKIP <이름>: <까닭>`. 아래에 들여쓴 줄은 근거다(12줄까지, 나머지는 `... N more`). SKIP 은 통과가 아니다. 보고에 그대로 적는다.

요약 줄도 SKIP 을 숨기지 않는다. `ALL PASS` 는 SKIP 이 0 일 때만 쓴다.

| 결과 | `pptx.mjs verify` 의 요약 줄 | `make.mjs` 의 끝 블록 | 종료 코드 |
|---|---|---|---|
| 모두 PASS | `ALL PASS (8 pass, 0 skip, 0 fail) <파일>` | `== done` | 0 |
| PASS 와 SKIP | `PASS with SKIP (continuity) (7 pass, 1 skip, 0 fail) <파일>` | `== done: PASS with SKIP` 다음에 `skipped      continuity (video deck)` | 0 |
| FAIL 이 있음 | `FAILED (...) <파일>` | `make: pptx verify failed` | 1 |

## HTML: `check.mjs`

`node "<S>/scripts/check.mjs" <present.html> --script <대본>`. 브라우저는 헤드리스로 1920 x 1080.
출력 폴더(기본 `<html 폴더>/check-<html 이름>/`, 다른 곳은 `--out <폴더>`): `snaps/`, `stills/`, `played/`, `contact-sheet.png`, `contact-sheet.html`, `report.json`.
출력 폴더가 비어 있지 않으면(지난 회차, 또는 `--out` 이 가리킨 다른 폴더) 브라우저를 띄우기 전에 `not overwriting` 과 종료 코드 2 로 끝난다. 다시 쓰려면 허락을 받고 `--force` 를 준다. `make.mjs --force` 는 이 `--force` 를 넘긴다.

| 게이트 | 증명하는 것 | 기준 |
|---|---|---|
| `step-count` | 페이지의 단계 수가 대본과 같음 | 같고 0 보다 큼 |
| `layout` | 모든 단계 끝 상태에서 글이 자기 상자 안에 있고, 칠한 요소 가운데 보이는 것이 무대 밖으로 나가지 않음 | 글 줄의 가로가 블록 상자 안(1px), 세로 가운데가 상자 안 |
| `safe-area` | 보이는 글과 칠한 요소가 안전 영역 안 | x 160~1760, y 120~960(0.5px) |
| `decorations` | 밑줄, 형광, 취소선, 강조 테두리, 글 바로 아래의 얇은 막대가 대상에 맞고, 늘린 조각이 없음 | 아래 표 |
| `decorations-played` | 둘째 화면(1227x785, 기기 픽셀 비율 1.5)에서 단계마다 앞 단계 끝에서 다음 키로 재생함. 가운데에서는 모양 규칙(강조 테두리가 닫힌 도형 하나, 늘린 조각 없음)을, 끝에서 `decorations` 의 모든 규칙을 봄. 그 가운데와 끝 화면을 `played/NN-<id>-mid.png`, `-end.png` 로 남김 | 0건 |
| `text-size` | 작은 글 | 28px 미만이면 FAIL, 40px 미만은 `report:` 줄로만(0.5px 허용) |
| `continuity` | 단계 i 로 바로 건너뛴 상태와, i-1 에서 다음 키로 재생해 끝난 상태가 같음 | 채널 차이 16 초과 픽셀이 전체의 0.02% 이하, 재생 끝 시각이 단계 끝과 같음 |
| `snapshots` | 단계마다 15%, 50%, 끝 스냅숏 3장, 끝 상태 정지 화면 1장, 컨택트 시트 | 정지 화면 수 = 단계 수, 스냅숏 = 3 x 단계 수 |
| `network` | 그 파일 외의 요청이 없음(data URL 제외) | 0 |
| `console-errors` | 콘솔 오류, 잡히지 않은 예외, 장면 빌드 오류가 없음 | 0 |

`decorations` 의 기준(허용 오차 2px):

| 장식 | 기준 |
|---|---|
| 밑줄(`[data-ul]`) | 글 잉크를 덮고, 양쪽으로 16px 넘게 나가지 않으며, 위끝이 글 아래끝에서 24px 안 |
| 형광(`.mk-box`) | 글을 덮고, 16px 넘게 나가지 않으며, 글 높이의 절반 이상 겹침 |
| 취소선(`.strike-line`) | 글을 덮고, 16px 넘게 나가지 않으며, 가운데가 글 높이 안 |
| 강조 테두리(`.fx-focus`) | 요소 하나이고 네 변 모두 테두리가 있음(닫힌 도형). 바깥 상자가 대상 상자에 `pad` 를 더한 것과 2px 안에서 같음. 모서리 반지름이 대상 반지름에 `pad` 를 더한 것과 1px 안에서 같음. 조각 여러 개로 그린 강조(옛 `.ring`)는 FAIL |
| 늘린 조각 | 칠한 요소 가운데 한 방향 크기가 2px 보다 작은데 변형으로 그 4배 넘게 늘어난 것이 없음 |
| 그 밖의 얇은 막대 | 높이 20px 이하, 폭 24px 이상이고 높이의 3배 이상인 칠한 요소가 글 줄 아래 60px 안에 있으면 그 줄의 밑줄로 보고 밑줄 기준을 적용 |

FAIL 예와 읽는 법:

```text
FAIL decorations: 1 decoration(s) off their text
  s3-3: bar under "세 번에 나눠 붓기" does not match its text: bar x 280-920, text x 280-598
```

- 출력은 단계 id, 장식, 대상 글, 막대와 글의 x 범위를 차례로 보인다. 이 예는 고정 폭 막대다. `s.underline` 으로 바꾼다.
- `... is a 1x4px box stretched to 158x4` 는 1px 조각을 늘려 만든 장식이다. GPU 로 그리는 브라우저에서 픽셀 비율이 1 이 아니면 길이가 틀어진다. 요소 하나의 CSS 테두리로 바꾼다(`s.focus`).
- `layout` 의 `text "..." outside its box` 는 글이 상자보다 넓다는 뜻이다. 상자를 넓히거나 줄을 나눈다.
- `continuity` 가 FAIL 이면 그 단계에 시간 밖 상태(콜백, 시계)가 있거나 같은 채널이 겹친다. 장면을 고친다.

## 직접 볼 것

- 컨택트 시트: 한 행에 한 단계, 처음(15%), 가운데, 끝. 글이 상자 안에 있는지, 장식이 글에 붙어 있는지, 앞 단계에 없던 것이 처음 칸에 미리 보이지 않는지(깜빡임) 본다.
- `stills/NN-<id>.png` 는 단계의 끝 상태다. 스토리보드 승인에도 쓴다.
- `played/NN-<id>-mid.png`, `-end.png` 는 둘째 화면에서 키로 재생한 가운데와 끝이다. 강조 테두리와 밑줄이 움직이는 동안에도 한 도형으로 붙어 있는지 본다.

## PPTX: `pptx.mjs verify`

`node "<S>/scripts/pptx.mjs" verify <파일.pptx> --script <대본> [--media <녹화 폴더>] [--frames <폴더>] [--force]`. 종류(영상, 편집)는 파일에서 알아낸다.

| 게이트 | 증명하는 것 | 기준 |
|---|---|---|
| `zip` | 필수 부분이 있고 슬라이드가 16:9 | `[Content_Types].xml`, `ppt/presentation.xml` 등 |
| `slide-count` | 슬라이드 수 = 단계 수 | 같음 |
| `notes` | 노트 = 말, 빈 줄, `[연출]` 줄 | 문단 단위로 같음 |
| `titles` | 슬라이드마다 숨긴 제목 자리표시자, 내용은 `<키> <첫 화면 줄>`, 서로 다름 | 모두 |
| `video-slides` | 영상 덱: MP4 부분, 영상 도형, 자동 재생 타이밍(`playFrom(0.0)`, 그 도형 대상, 반복 없음), 포스터 PNG, 대체 텍스트 | 모든 슬라이드 |
| `h264` | MP4 가 H.264(`avc1` + `avcC`) | 모두 |
| `continuity` | 브라우저로 푼 슬라이드 n 영상의 끝 프레임과 n+1 영상의 첫 프레임이 같음 | 채널 평균 차이 0.5 이하, 32 초과 픽셀 0.1% 이하. 브라우저가 H.264 를 풀지 못하면 SKIP |
| `continuity-raw` | (`--media`) 녹화한 원본 프레임의 같은 비교 | 최대 채널 차이 16 이하 |
| `edit-slides` | 편집 덱: 화면 줄이 있는 슬라이드마다 텍스트 상자, 테마 글꼴 Noto Sans / Noto Sans KR | 모두 |

- `--frames <폴더>` 는 연속성 비교에 쓴 디코딩 프레임(`NN-last.png`, `NN-first.png`)을 저장한다. 몇 장을 직접 본다. 폴더가 비어 있지 않으면 작업 전에 종료 코드 2(`--force` 로만 다시 씀).
- 끝 프레임은 브라우저가 `requestVideoFrameCallback` 으로 마지막 두 프레임 중 하나라고 알린 때만 잡는다. `ended` 때 요소가 보이는 프레임은 쓰지 않는다(Windows Chrome 은 끝을 보이기 전에 `ended` 를 낼 수 있다). 알림이 없으면 처음부터 다시 재생하고, 게이트 줄에 `; N end frame(s) taken on a later play`, 쌍 줄에 `end frame on play N` 을 적는다. 5번 재생해도 없으면 오류.
- 예시 덱의 실측(이 스킬의 시험 PC): 디코딩 연속성 15쌍 최악 평균 0.015, 원본 연속성 차이 0.

## 선택: PowerPoint 확인

- `node "<S>/scripts/pptx.mjs" com <파일.pptx> <PNG 폴더> [--force]` 는 Windows 에서 PowerPoint 로 파일을 열고 슬라이드, 노트, 미디어 수를 낸 뒤 슬라이드마다 `NN.png` 를 쓴다. PNG 폴더가 비어 있지 않으면 아무것도 하지 않고 종료 코드 2(`--force` 로만 다시 씀).
- PowerPoint 가 이미 실행 중이면 아무것도 하지 않고 SKIP. Windows 가 아니거나 PowerPoint 가 없어도 SKIP.
- 슬라이드 쇼의 자동 재생 자체는 이 확인으로 알 수 없다(PNG 는 포스터). 발표 PC 에서 한 번 넘겨 본다.
