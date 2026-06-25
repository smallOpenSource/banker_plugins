#!/usr/bin/env python
"""audit-web-page 재사용 하니스 (playwright sync·번들 chromium·swiftshader).

실행(예시 — 대상 환경에 맞게):
  timeout 200 \
    env DISPLAY=$DISPLAY PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH \
        AUDIT_URL=https://127.0.0.1:<port>/ AUDIT_OUT=/tmp/audit_shots \
    python harness.py   # playwright sync_api 설치된 python

설계:
  - headless + ANGLE/SwiftShader → WebGL(Phaser 등) 캔버스가 검정 안 되고 렌더된다
    (Xvfb mesa만으론 'Framebuffer Incomplete Attachment' → 검정).
  - ignore_https_errors=True → 자체서명/호스트불일치 cert·wss 허용.
  - 모든 wait timeout·모든 루프 deadline 바운드(hang 가드).
  - 이 파일은 ★템플릿: CHECKS 섹션을 대상 앱에 맞게 수정해 쓴다.
  - 캔버스 비주얼 정량분석은 PIL 필요 → PIL 설치된 별도 python으로 실행
    (ImageChops.difference로 변화 격리).
"""

import os
import time
from playwright.sync_api import sync_playwright

URL = os.environ.get("AUDIT_URL", "https://127.0.0.1:33006/")
OUT = os.environ.get("AUDIT_OUT", "/tmp/audit_shots")
os.makedirs(OUT, exist_ok=True)

LAUNCH_ARGS = [
    "--use-gl=angle",
    "--use-angle=swiftshader",  # ★WebGL 렌더 완성(검정 방지).
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
]

results = []
console = []


def check(name, cond, detail=""):
    results.append({"name": name, "pass": bool(cond), "detail": detail})
    print(
        f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""),
        flush=True,
    )


def benign(msg: str) -> bool:
    """무해 콘솔 메시지(앱 버그 아님)."""
    return ("favicon.ico" in msg) or ("Framebuffer status: Incomplete" in msg)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=LAUNCH_ARGS)
    ctx = browser.new_context(
        ignore_https_errors=True, viewport={"width": 1680, "height": 950}
    )
    page = ctx.new_page()
    page.on("console", lambda m: console.append((m.type, m.text)))
    page.on("pageerror", lambda e: console.append(("pageerror", str(e))))

    # ── 로드 ──
    # ★SSE/WebSocket 영속 연결 앱은 'networkidle'에 절대 도달 안 함(타임아웃) → 쓰지 말 것.
    #   domcontentloaded + 명시 selector/timeout 대기로 안정화한다.
    page.goto(URL, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector("body", timeout=15000)
    page.wait_for_timeout(1500)
    check("페이지 로드", True, URL)

    # ── CHECKS(대상 앱에 맞게 수정) ─────────────────────────────────────────────
    # 예: 캔버스 존재·단일.
    has_canvas = page.locator("canvas").count()
    if has_canvas:
        page.wait_for_timeout(2500)  # WebGL boot.
        check("캔버스 단일", has_canvas == 1, f"count={has_canvas}")
        page.locator("canvas").first.screenshot(path=f"{OUT}/canvas.png")
    # 예: 전체 스크린샷.
    page.screenshot(path=f"{OUT}/page.png", full_page=False)
    # 예: 버튼 클릭(텍스트/role/testid). 필요 시 추가:
    # page.get_by_role("button", name="…").click(); page.wait_for_timeout(400)
    # check("…전환", page.locator("[data-testid=…]").count() >= 1)
    # ────────────────────────────────────────────────────────────────────────────

    errs = [t for (ty, t) in console if ty in ("error", "pageerror") and not benign(t)]
    check("콘솔 에러 0(무해 제외)", len(errs) == 0, f"errors={errs[:3]}")

    browser.close()

passed = sum(1 for r in results if r["pass"])
print(f"\n=== {passed}/{len(results)} PASS · shots={OUT} ===", flush=True)
print("※ 캔버스/비주얼은 스크린샷을 Read로 직접 보고 판정. 글로우/애니메이션 정량은")
print(
    "  crawl env python + PIL ImageChops.difference로 동일줌 프레임 변화영역 격리 후 크롭·확대."
)
