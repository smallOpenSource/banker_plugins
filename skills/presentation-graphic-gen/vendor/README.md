# vendor

presentation-graphic-gen 이 설치와 내려받기 없이(오프라인) 덱을 만들려고 넣은 파일이다. 모두 원본 그대로다.

- 아래 표의 파일 일곱 개는 모두 원본을 brotli 로 묶은 `<파일>.br` 로 둔다. 라이선스 문서만 묶지 않았다.
  - 까닭: Codex 는 플러그인 훅마다 훅의 시간 제한 안에서 플러그인 폴더 전체의 해시를 먼저 구한다. 폴더가 작을수록 훅이 빨리 시작한다.
  - 묶기: banker 저장소의 `node scripts/pack-video-vendor.mjs <원본 파일>`(node `zlib.brotliCompressSync`, quality 11, lgwin 24). 풀면 원본과 바이트가 같다.
  - `scripts/vendor.mjs` 가 실행할 때 메모리에서 풀고, 아래 표의 원본 sha256 과 맞는지 본다. 푼 파일을 디스크에 쓰지 않는다. 다르거나 풀리지 않으면 빌드하지 않는다(종료 코드 3).
- 표의 sha256 은 원본(푼 뒤)의 값이다. `scripts/vendor.mjs` 의 `ORIGINALS` 와 같아야 한다(`scripts/build.test.mjs` 가 대조함).

| 파일 | 원본 | 판 | 라이선스 | sha256 |
|---|---|---|---|---|
| `fonts/NotoSans-Regular.ttf.br` | notofonts `NotoSans/hinted/ttf/` (Noto Sans, latin-greek-cyrillic) | 2.015 | SIL OFL 1.1, `fonts/OFL-NotoSans.md` | `f5f552c8c5edb61fe6efb824baf4d4de47b1a8689ab4925ff43f7bd6a4ebece5` |
| `fonts/NotoSans-Bold.ttf.br` | 같음 | 2.015 | SIL OFL 1.1, `fonts/OFL-NotoSans.md` | `3a08a47daa00cade516425c15c57615aef2fd418ec9811a7b9f465088f92cc05` |
| `fonts/NotoSansKRStatic-Regular.ttf.br` | Google Fonts Noto Sans KR 의 정적(static) 인스턴스, 글꼴 이름 "Noto Sans KR Static" | 2.04 | SIL OFL 1.1, `fonts/OFL-NotoSansKR.md` | `b0b19d3bed7b0868c3ecd310d7c5f39b79b5d2204f095288a28f6f502a3e4782` |
| `fonts/NotoSansKRStatic-Bold.ttf.br` | 같음 | 2.04 | SIL OFL 1.1, `fonts/OFL-NotoSansKR.md` | `7d83d47d1a26d91431963003ae048db2ee7cb38ceb8ad1237054bdc11acb3287` |
| `harfbuzz/harfbuzz-subset.wasm.br` | npm `harfbuzzjs` 1.6.4 의 `dist/harfbuzz-subset.wasm` (HarfBuzz 15.0.0, 커밋 `35f656a1a2bab548ea7f54a6dd3fba2b09680d14`) | 1.6.4 | harfbuzzjs: MIT, `harfbuzz/LICENSE-harfbuzzjs.md`. HarfBuzz: "Old MIT", `harfbuzz/COPYING-harfbuzz.md` | `62415fe6bad92ef16f3e5d2dbed6c66a4adec7f5a59c6d27084811c92cce1ba5` |
| `h264-mp4-encoder/h264-mp4-encoder.node.js.br` | npm `h264-mp4-encoder` 의 `embuild/dist/` (banker video-gen 의 vendor 와 같은 파일) | 1.0.12 | MIT, `h264-mp4-encoder/LICENSE.md`. 안의 구성요소는 아래 | `f8df9c1791b249f75e5cef77f8e32a135b4cdb2c918a0c4593669e8571085c0c` |
| `pptxgenjs/pptxgen.bundle.js.br` | PptxGenJS `dist/pptxgen.bundle.js` (npm `pptxgenjs`, banker wide-pptx 의 vendor 와 같은 파일) | 4.0.1 | MIT, `pptxgenjs/LICENSE-pptxgenjs.md`. 안에 든 JSZip 3.10.1(MIT 또는 GPLv3 중 MIT), pako 1.0(MIT), lie, immediate, setimmediate, core-js 2.6.11, regenerator-runtime, @babel/polyfill(MIT)의 고지는 `pptxgenjs/LICENSE-jszip.md`, `pptxgenjs/LICENSE-pako.md`, `pptxgenjs/THIRD-PARTY-NOTICES.md` | `4fb9eac5cfefb213e2d8743c2b7151025f31bfb3f834c73c12062916daa0f3f8` |

## h264-mp4-encoder 안의 구성요소

| 구성요소 | 라이선스 | 원본 소스 |
|---|---|---|
| minih264 (H.264 인코더) | public domain(CC0) | https://github.com/TrevorSundberg/minih264 커밋 `25f441086ac8f2eef1c883476c095f9397843ac8` (원본 https://github.com/lieff/minih264) |
| libmp4v2 (MP4 쓰기) | Mozilla Public License 1.1, 전문 `h264-mp4-encoder/MPL-1.1.md` | https://github.com/TrevorSundberg/libmp4v2 커밋 `d49b4466ed76fc23b59e31a5f7f10f34b30ad7c4` (원본 https://github.com/sergiomb2/libmp4v2) |

- 커밋 번호는 h264-mp4-encoder 의 `v1.0.12` 태그가 가리키는 하위 모듈의 커밋이다.
- libmp4v2 는 MPL 1.1 이다. 실행 형태(WASM)로 함께 배포하므로 그 소스를 MPL 1.1 로 구할 수 있게 한다:
  - banker 저장소는 위 커밋의 소스 묶음을 `third_party/libmp4v2-d49b4466.tar.gz` 에 둔다(sha256 `c63b3dcb1e7f77e8134b9ccd2500cb144b51b90ba5bce0625313f8d23a9f2e1c`). video-gen 의 인코더와 같은 파일이라 이 묶음을 함께 쓴다. 이 스킬 폴더에는 넣지 않았다.
  - 이 구성요소를 고치지 않았다.
- 이 인코더의 Emscripten 글루는 불러올 때 프로세스에 처리되지 않은 예외 처리기와 처리되지 않은 거부 처리기를 등록한다. `scripts/record.mjs` 는 자기가 만든 Promise 의 거부를 모두 처리한다.
- `scripts/vendor.mjs` 는 풀어서 sha256 확인을 마친 바이트를 CommonJS 모듈로 컴파일한다. 인코더를 `require` 로 읽지 않으며, 위쪽 `package.json` 의 `"type": "module"` 도 영향을 주지 않는다. PptxGenJS 번들도 확인한 바이트를 Node `vm` 의 별도 컨텍스트에서 실행한다(보안 격리는 아님).

- 라이선스 파일(banker 관례대로 확장자는 `.md`, 본문은 원문 그대로)
  - `fonts/OFL-*.md`: OFL 1.1 전문 앞에 각 글꼴의 name 표(ID 0)에 든 저작권 줄을 붙였다.
  - `harfbuzz/COPYING-harfbuzz.md`: 위 커밋의 `COPYING` 그대로. `harfbuzz/LICENSE-harfbuzzjs.md`: npm 패키지의 `LICENSE` 그대로.
- 글꼴 서브셋
  - 빌드는 덱이 쓰는 글자만 남긴 TrueType 을 HTML 에 base64 로 넣는다. 글꼴 이름은 바꾸지 않는다.
  - Noto Sans KR 의 예약 글꼴 이름(RFN)은 "Source" 다. 서브셋 결과도 이 이름을 쓰지 않는다.
  - 서브셋이 실패하면 원본 글꼴 전체를 넣고 경고 한 줄을 낸다.
- harfbuzzjs 의 JavaScript 글루(`dist/index.mjs`)는 넣지 않았다. `harfbuzz-subset.wasm` 은 import 가 없어서 `scripts/fonts.mjs` 의 짧은 글루로 직접 부른다.
- 판을 올릴 때
  - 새 원본을 위 명령으로 묶고 원본은 지운다.
  - 이 표와 `scripts/vendor.mjs` 의 sha256 을 고친다.
  - `node --test "scripts/*.test.mjs"` 를 돌린다.
