# NOTICE - 출처 (ultraqa)

이 스킬은 oh-my-codex 의 `ultraqa` 스킬을 본떴다.

| 항목 | 내용 |
|---|---|
| 원본 | oh-my-codex 0.20.2 의 `skills/ultraqa/SKILL.md` |
| 저장소 | https://github.com/Yeachan-Heo/oh-my-codex |
| 저작자 | Yeachan Heo |
| 라이선스 | MIT |
| 재사용 범위 | 구조(목표 6종, 9분류 시나리오 행렬, 순환 5회, 안전 경계, 종료 5종, 보고서 꼴)를 각색. 문장은 banker 문체로 새로 씀. 코드는 가져오지 않음 |
| 바꾼 것 | OMX 전용 수단(`/prompts:*`, `omx state`, `/cancel`)을 Claude Code 의 `Plan` 에이전트, 세션 자신, tmux 직접 구동, 실행 폴더로 바꿈. 종료 코드는 실행기(`references/gate-evidence.mjs`)가 관측한 것만 증거로 씀. COMPLETE 는 `references/uqa-run.mjs status` 가 허용할 때만 |

## MIT License

Copyright (c) Yeachan Heo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
