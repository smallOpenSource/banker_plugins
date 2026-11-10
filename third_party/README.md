# third_party

npm 패키지에 넣지 않는 원본 소스 묶음이다. 배포하는 실행 파일의 라이선스가 소스를 구할 수 있게 하라고 요구할 때 여기에 둔다.

| 파일 | 무엇 | 라이선스 | 쓰는 곳 |
|---|---|---|---|
| `libmp4v2-d49b4466.tar.gz` | github.com/TrevorSundberg/libmp4v2 커밋 `d49b4466ed76fc23b59e31a5f7f10f34b30ad7c4` 의 소스 | MPL 1.1 | `skills/video-gen/vendor/h264-mp4-encoder/h264-mp4-encoder.node.js` 안에 WASM 으로 들어 있음 |
