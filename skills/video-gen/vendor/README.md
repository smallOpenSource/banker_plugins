# vendor

video-gen 이 설치와 내려받기 없이 영상을 만들려고 넣은 파일이다. 모두 고치지 않은 원본이다.

| 파일 | 원본 | 판 | 라이선스 | sha256 |
|---|---|---|---|---|
| `canvaskit/canvaskit.js`, `canvaskit/canvaskit.wasm` | npm `canvaskit-wasm` 의 `bin/full/` (Skia) | 0.42.0 | BSD-3-Clause, `canvaskit/LICENSE.md`. 안에 든 ICU, FreeType, HarfBuzz, libjpeg-turbo, libpng, libwebp, zlib, Wuffs 의 고지는 `canvaskit/THIRD-PARTY-NOTICES.md` | js `894815b2d39b24de2eacdb01453778d83e0b6c418b034e3b728e80956ac2a9d5`, wasm `aca7fa6019f95d3de98d4a49ae60a3d66a09e9d5ca74091fbc369b9be959f959` |
| `h264-mp4-encoder/h264-mp4-encoder.node.js` | npm `h264-mp4-encoder` 의 `embuild/dist/` | 1.0.12 | MIT, `h264-mp4-encoder/LICENSE.md`. 안의 구성요소는 아래 | `f8df9c1791b249f75e5cef77f8e32a135b4cdb2c918a0c4593669e8571085c0c` |
| `fonts/NotoSans-Regular.ttf`, `fonts/NotoSans-Bold.ttf` | notofonts.github.io `fonts/NotoSans/hinted/ttf/` | | SIL OFL 1.1, `fonts/OFL-noto-sans.md` | Regular `478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823`, Bold `1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913` |
| `fonts/NotoSansKR-Regular.otf`, `fonts/NotoSansKR-Bold.otf` | noto-cjk `Sans/SubsetOTF/KR/` | | SIL OFL 1.1, `fonts/OFL-noto-sans-kr.md` | Regular `69975a0ac8472717870aefeab0a4d52739308d90856b9955313b2ad5e0148d68`, Bold `5a6ceb287ed2fc6cfc6213144ebea68cbd94b20fc9eb873d8486493bf02d9bda` |
| `aimotion/LICENSE.md` | github.com/kstost/cokacmotion `LICENSE` | c417b16 | MIT. `scripts/vg-fx.mjs` 가 옮겨 쓴 코드의 고지 | |

## h264-mp4-encoder 안의 구성요소

| 구성요소 | 라이선스 | 원본 소스 |
|---|---|---|
| minih264 (H.264 인코더) | public domain(CC0) | https://github.com/TrevorSundberg/minih264 커밋 `25f441086ac8f2eef1c883476c095f9397843ac8` (원본 https://github.com/lieff/minih264) |
| libmp4v2 (MP4 쓰기) | Mozilla Public License 1.1, 전문 `h264-mp4-encoder/MPL-1.1.md` | https://github.com/TrevorSundberg/libmp4v2 커밋 `d49b4466ed76fc23b59e31a5f7f10f34b30ad7c4` (원본 https://github.com/sergiomb2/libmp4v2) |

- 커밋 번호는 h264-mp4-encoder 의 `v1.0.12` 태그가 가리키는 하위 모듈이다.
- libmp4v2 는 MPL 1.1 이다. 실행 형태(WASM)로 함께 배포하므로 그 소스를 MPL 1.1 로 구할 수 있게 한다:
  - 위 커밋의 소스 묶음을 이 저장소의 `third_party/libmp4v2-d49b4466.tar.gz` 에 둔다(npm 패키지에는 넣지 않음). sha256 `c63b3dcb1e7f77e8134b9ccd2500cb144b51b90ba5bce0625313f8d23a9f2e1c`.
  - banker 는 이 구성요소를 고치지 않았다.
- 이 인코더의 Emscripten 글루는 불러올 때 프로세스의 처리되지 않은 예외와 거부 처리기를 등록한다. `video-gen.mjs` 는 자기 거부를 모두 처리한다.
- 판을 올릴 때는 파일을 바꾸고 이 표의 sha256 을 고친 뒤 `scripts/video-gen.test.mjs` 를 돌린다(시험이 sha256 을 대조함).
