# PPTX 두 벌

`make.mjs --format pptx`(또는 `both`)가 HTML 을 먼저 만들고 게이트를 통과한 뒤 아래를 차례로 실행한다. 각 도우미를 따로 돌릴 수도 있다.

| 순서 | 명령 | 결과 |
|---|---|---|
| 1 | `node "<S>/scripts/record.mjs" <present.html> --out <녹화 폴더>` | 단계마다 `NN-<id>.mp4`, `-first.png`, `-last.png`, `manifest.json` |
| 2 | `node "<S>/scripts/pptx-video.mjs" <대본> --media <녹화 폴더> --out <이름>-video-<stamp>.pptx` | 영상 덱 |
| 3 | `node "<S>/scripts/pptx-edit.mjs" <present.html> <대본> --out <이름>-edit-<stamp>.pptx` | 편집 덱(애니메이션 포함), 그림 대체와 근사 목록 |
| 4 | `node "<S>/scripts/pptx.mjs" verify <파일> --script <대본> [--media <녹화 폴더>] [--html <present.html>]` | 게이트(`gates.md`). 편집 덱은 `--html` 이 있어야 `anim-match`, `anim-render` 를 돌림 |

- 모든 도우미는 이미 있는 파일과 비어 있지 않은 녹화 폴더, `--frames` 폴더, PowerPoint PNG 폴더를 덮어쓰지 않는다(종료 코드 2). `make.mjs` 는 PPTX 두 파일과 녹화 폴더를 HTML 빌드 전에 미리 검사한다. `--force` 는 허락 뒤에만.

## 녹화(`record.mjs`)

- 실시간 녹화가 아니다. 단계 i 는 i-1 의 끝으로 건너뛴 뒤, 프레임 k 마다 `__deck.seek(start + k / fps)` 로 시각을 맞추고 무대를 캡처한다. 마지막 움직이는 프레임은 정확히 단계 끝 시각이다.
- 마지막 프레임을 `--hold` 초(기본 0.5) 더 둔다. 그래서 단계 n 의 끝 프레임과 n+1 의 첫 프레임이 같은 시각의 같은 화면이다.
- 인코더는 `vendor/h264-mp4-encoder`(WASM, ffmpeg 없음). 기본 30fps, `--quality 20`(10 고화질 ~ 51 작음), `--speed 5`(0 느림 ~ 10 빠름).
- 발표용 HTML 을 1920 x 1080 으로 연다. 검토용 HTML 은 입력으로 받지 않는다.
- 예시 덱(16단계, 약 31초)은 이 스킬의 시험 PC 에서 약 2분 걸렸다. MP4 는 단계마다 80~340KB.

## 영상 덱(`pptx-video.mjs`)

| 항목 | 내용 |
|---|---|
| 슬라이드 | 단계 하나에 하나. 16:9(13.333 x 7.5 in). 바탕 검정 |
| 영상 | 슬라이드 전체를 덮는 MP4 하나. 슬라이드에 들어가면 저절로 재생(`playFrom(0.0)`), 반복 없음, 되감지 않아 끝 프레임이 남음. 다음 클릭이나 키는 다음 슬라이드 |
| 포스터 | 영상의 첫 프레임(PNG). 재생 전과 편집 화면에 보임 |
| 노트 | 말, 빈 줄, `[연출]` 줄. 문단 하나에 한 줄 |
| 제목 | 숨긴 제목 자리표시자 `<키> <첫 화면 줄>`. 개요 보기와 화면 낭독기가 읽음 |
| 대체 텍스트 | 영상에 `<키> 단계 화면 영상: <화면 줄>` |
| 전환 | 없음. 단계 사이 화면이 끊김 없이 이어짐 |
| 테마 글꼴 | Latin Noto Sans, East Asian 과 Hangul Noto Sans KR |

- PptxGenJS 4.0.1 로 쓰고, 그 뒤 XML 을 고친다: 도형 id 정리, 제목 숨김, 대체 텍스트, 자동 재생 타이밍, 노트 문단, 한국어 언어 표시, 테마 글꼴.

## 편집 덱(`pptx-edit.mjs`)

- 섹션 하나에 슬라이드 하나. 단계 하나가 클릭 묶음 하나다. 섹션의 첫 단계는 슬라이드 전환(Fade 0.25초) 뒤 저절로 재생된다. 그래서 키 한 번이 HTML 과 같은 단계 하나다.
- 도형은 그 섹션에서 한 번이라도 보이는 것 전부다. 쉬는 자리(변형 없는 배치)에 PowerPoint 고유 도형으로 놓는다.
- 움직임은 PowerPoint 고유 애니메이션이다. 값은 쉬는 자리 기준(`#ppt_x+dx`)이라 도형을 손으로 옮기면 움직임도 따라간다.

| 페이지의 것 | PPTX |
|---|---|
| 글 | 그려진 한 줄에 텍스트 상자 하나. 줄 안의 크기, 굵기, 색, 자간이 다른 조각은 실행(run)으로 나눔. 줄 안에 빈칸(0.4em 넘는 틈, `s.fill` 의 빈칸 등)이 있으면 조각마다 상자를 나눠 페이지 자리에 둠. 자동 줄바꿈 없음, 여백 0 |
| 배경색, 테두리, 둥근 모서리가 있는 요소 | 사각형이나 둥근 사각형. CSS 테두리는 상자 안쪽에 그려지고 PowerPoint 외곽선은 도형 가장자리 가운데에 그려지므로, 외곽선 굵기의 절반만큼 안으로 줄여 놓음 |
| 강조 테두리(`s.focus`) | 채우기 없는 둥근 사각형 외곽선 하나. 빛번짐(`box-shadow`)은 `a:glow`(반지름 = 흐림의 절반, 근사) |
| 변마다 다른 테두리 | 변마다 얇은 사각형 |
| 그림, SVG, 회전, 그라데이션, 빗금 | 그 요소만 투명 바탕에 잘라 낸 그림. `fallback <단계>: <요소> (<까닭>)` 줄로 목록을 냄 |
| 장면 바탕 | 슬라이드 바탕색 |

| 움직임 | PowerPoint | 판정 |
|---|---|---|
| 나타남, 사라짐 | Fade 진입, 끝내기(프리셋 10). 투명도 곡선은 `style.opacity` 표본 키프레임(0.004 로 줄임) | 정확 |
| 한 순간의 나타남, 사라짐, 그리기 시작 | Appear, Disappear | 정확 |
| 부분 투명도(`s.dim`, `s.strike` 의 흐림) | 같은 도형의 `style.opacity` 표본 키프레임(사용자 지정 효과) | 정확 |
| 이동, 크기, 회전(부모 층 포함) | 그 단계 효과 안의 표본 키프레임(`ppt_x`, `ppt_y`, `ppt_w`, `ppt_h`, `r`), 0.3px 로 줄임 | 정확 |
| 한쪽 끝에서 드러남(`s.reveal`) | Wipe 진입(그 쪽부터) | 근사 |
| 그 밖의 잘라 내기 변화 | 없음. 잘리지 않은 채 보임 | 불가 |
| 섹션 첫 단계 | 전환이 끝난 뒤 시작. HTML 보다 0.10초(첫 섹션은 0.25초) 늦음 | 근사 |

- 출력의 `motion: <N> exact, <N> approx, <N> not possible` 줄과 `approx <단계>: ...`, `not possible <단계>: ...` 줄이 위 판정의 목록이다.
- 투명도 키프레임 값은 그 요소의 가장 높은 투명도 기준이다. 도형은 그 투명도로 그리고, 1 이 아니면 이름에 `@40` 처럼 적는다.
- 쓰지 않는 것(PowerPoint 2019 실측): 글 도형의 `p:bldP`(첫 효과만 남기고 나머지를 버림), Fade 와 Wipe 필터의 `fill="hold"`(같은 도형의 뒤 Fade 끝내기가 재생되지 않음), `style.opacity` 를 정한 뒤 Fade 진입(끝이 불투명 1), Transparency 강조(계단), presetID 없는 효과(클릭 트리거를 잃음). `anim-xml` 이 이것을 FAIL 로 잡는다.
- 노트는 단계마다 `[1-1]` 머리줄, 말, `[연출]` 줄이다. 클릭과 말을 맞출 때 본다.
- 숨긴 제목은 `<n>. <섹션 이름>`.
- 바뀌는 글(`s.swap`)과 사라지는 글이 같은 자리에 겹쳐 보인다. HTML 과 같은 구조라 피할 수 없다. 도형 이름(`text <요소> #n`)으로 구분한다.
- 글꼴 파일은 넣지 않는다. 보는 PC 에 Noto Sans 와 Noto Sans KR 이 있어야 줄바꿈이 HTML 과 같다.
- 여러 줄 글은 줄마다 다른 상자다. 고친 뒤 줄 길이가 바뀌면 상자를 손으로 맞춘다.
- 보장하는 판: PowerPoint 2016 이상과 Microsoft 365(Windows, Mac). 웹, 모바일, Keynote 는 다르게 재생할 수 있다.
- 단계마다 끝 상태를 정지 화면으로 넘기려면 `check-.../stills/` 를 쓴다.

## 선택: PowerPoint 확인(Windows)

- `node "<S>/scripts/pptx.mjs" com <파일.pptx> <PNG 폴더>`. `gates.md` 참고.
- `node "<S>/scripts/pptx.mjs" com --anim <편집.pptx> <폴더> --script <대본> [--video]`: 편집 덱의 애니메이션을 PowerPoint 가 파일대로 읽는지 본다. `gates.md` 참고.
- `scripts/pptx-com.ps1` 이 하위 프로세스에서 PowerPoint 를 열고, 끝나면 자기가 연 PowerPoint 만 닫는다. 시간 제한(기본 600초, `--anim` 은 900초)을 넘으면 그 PowerPoint 만 끝낸다.

## PowerPoint 실측 결과(2026-11-19)

- 판: Office ProPlus 2019 Volume, PowerPoint 16.0 build 10353(POWERPNT.EXE 16.0.10353.20037), Windows. Microsoft 365 는 재보지 않음
- 방법: 대화형 예약 작업의 COM. 재생은 `CreateVideo` 영상을 프레임으로 풀어 잼(슬라이드 쇼는 화면이 연결되지 않은 세션에서 `E_FAIL`)

| 확인 | 결과 |
|---|---|
| 열기(검사 파일 14개, 예시 편집 덱) | 고치기 창 없음 |
| `style.opacity` 키프레임과 from/to | 부드럽게 재생, 끝 값 유지 |
| Transparency 강조 | 한 번에 바뀜 |
| Fade 의 `accel`, `decel` | SMIL 식보다 더 치우침(u=0.5 에서 0.08 차이). 그래서 투명도에 쓰지 않음 |
| Fade 진입 안의 `ppt_x` 키프레임, `ppt_w`/`ppt_h`(글자도 함께, 가운데 기준), `r`(도, 시계 방향) | 기록대로 |
| Wipe `wipe(left)`, `wipe(right)`, `wipe(up)`, `wipe(down)` | 왼쪽, 오른쪽, 위, 아래부터 드러남 |
| 전환 `p14:dur` 250 과 첫 묶음 | 전환 뒤 클릭 없이 시작 |
| presetID 0 의 emph | 사용자 지정 효과로 재생, 클릭 유지 |
| 글 도형의 `p:bldP`(효과 둘 이상) | 첫 효과만 남음(예시 덱 151개 중 9개 버림) |
| Fade 필터의 `fill="hold"` | 같은 도형의 뒤 Fade 끝내기가 재생되지 않음 |

- 아직 못 본 것(화면이 연결된 세션이 필요): 재생 중 클릭이 끝 상태로 마치는지(`nextAc="seek"`), `GetClickCount`, `FirstAnimationIsAutomatic`, `GotoClick` 캡처. 슬라이드 쇼가 `CreateVideo` 와 같게 재생하는지

## 개발용: PowerPoint 실측(단계 0)

- `node "<S>/scripts/pptx-anim-probe.mjs" <폴더>` 는 후보 인코딩 13가지를 한 파일에 하나씩(P01..P13, P12 는 두 벌) 쓰고, 볼 것을 `probe.json` 에 적는다.
- PowerPoint 가 있는 Windows 에서 `node "<S>/scripts/pptx-anim-probe.mjs" --com <폴더>` 가 파일마다 `com --anim` 을 돌린다. 캡처와 영상은 `<폴더>/com/<P..>/` 에 남는다.
- 결과로 정할 것: 부분 투명도 방식(`PARTIAL`), 움직임만 있는 효과의 프리셋(`MOTION`), Wipe 방향 문자열(`pptx-anim-xml.mjs` 의 `WIPE`), `r` 의 단위, 크기 애니메이션에서 글자도 커지는지.

