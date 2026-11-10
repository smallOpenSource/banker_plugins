# vendor

| 파일 | 원본 | 판 | 라이선스 |
|---|---|---|---|
| `pptxgen.bundle.js` | PptxGenJS `dist/pptxgen.bundle.js` (npm `pptxgenjs`) | 4.0.1 | MIT, `LICENSE-pptxgenjs.md` |
| (위 파일 안) | JSZip | 3.10.1 | MIT 또는 GPLv3 중 MIT 를 고름, `LICENSE-jszip.md` |
| (위 파일 안) | pako (JSZip 이 묶음) | 1.0 | MIT, `LICENSE-pako.md` |
| (위 파일 안) | lie, immediate, setimmediate (JSZip 의존), core-js 2.6.11, regenerator-runtime, @babel/polyfill | | MIT, `THIRD-PARTY-NOTICES.md` |

- 고치지 않은 원본 그대로다. sha256 `4fb9eac5cfefb213e2d8743c2b7151025f31bfb3f834c73c12062916daa0f3f8`.
- `scripts/wp-pptx.mjs` 가 이 파일을 Node `vm` 의 별도 컨텍스트에서 불러 쓴다(보안 격리는 아님, sha256 으로 고정한 신뢰 코드). 이 번들은 브라우저용 UMD 라 `require` 로는 JSZip 만 돌려주기 때문이다.
- 판을 올릴 때는 새 번들로 바꾸고 sha256 과 이 표를 고친 뒤 `wide-pptx.test.mjs` 를 돌린다.
