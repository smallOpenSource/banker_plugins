// vg-catalog.mjs: what video-gen can make. Built-in kinds render here with the bundled WASM engine; the others
// hand over to another banker skill. `video-gen.mjs list` prints this table.

export const CATALOG = [
  { id: "title", name: "모션 타이틀", how: "내장", what: "제목과 부제가 강조 막대와 함께 들어오는 짧은 오프닝", needs: "제목, 부제(선택)" },
  { id: "kinetic", name: "키네틱 타이포", how: "내장", what: "글자가 한 자씩 튀어 오르며 문장이 완성되는 장면", needs: "문장 1~6줄" },
  { id: "slides", name: "슬라이드 영상", how: "내장", what: "wide-pptx 덱이나 글머리 목록을 장면으로 바꾼 설명 영상", needs: "덱 파일 또는 장면별 제목과 글머리" },
  { id: "chart", name: "데이터 차트", how: "내장", what: "막대가 자라거나 꺾은선이 그려지는 수치 영상", needs: "항목 이름, 계열 값, 단위" },
  { id: "counter", name: "숫자 카운터", how: "내장", what: "큰 숫자가 올라가며 강조되는 장면", needs: "시작 값, 끝 값, 단위, 설명" },
  { id: "lowerthird", name: "이름 자막", how: "내장", what: "인물 이름과 직함 띠가 들어왔다 나가는 장면(배경 그림 선택)", needs: "이름, 직함, 배경 그림(선택)" },
  { id: "quote", name: "인용", how: "내장", what: "따옴표와 인용문이 떠오르는 장면", needs: "인용문, 출처" },
  { id: "image", name: "사진 장면", how: "내장", what: "사진을 천천히 확대하거나 옆으로 흘리며 캡션을 붙인 장면", needs: "로컬 사진(PNG, JPEG, GIF, WebP), 캡션" },
  { id: "credits", name: "엔딩 크레딧", how: "내장", what: "제목과 이름이 아래에서 위로 흐르는 마무리", needs: "제목, 줄 목록" },
  { id: "motion-graphic", name: "HTML 모션 그래픽", how: "motion-graphic-make", what: "HyperFrames(HTML, CSS, GSAP) 블록으로 만드는 풍부한 모션 그래픽", needs: "HyperFrames 와 Chrome, ffmpeg 가 설치된 PC" },
  { id: "3d-intro", name: "AI 3D 인트로", how: "3d-intro-build", what: "Azure 영상 생성 모델로 만드는 3D 인트로", needs: "Azure 키(유료), 인터넷" },
  { id: "motion-site", name: "모션 웹사이트", how: "motion-sites", what: "영상이 아니라 스크롤로 움직이는 웹 페이지", needs: "주제와 내용" },
];

/** The catalog as a text table for the terminal. */
export function catalogText() {
  const rows = CATALOG.map((c) => `${c.id.padEnd(15)} ${c.how.padEnd(20)} ${c.name} - ${c.what} (필요: ${c.needs})`);
  return `${"종류".padEnd(15)} ${"만드는 곳".padEnd(20)} 설명\n${rows.join("\n")}\n`;
}
