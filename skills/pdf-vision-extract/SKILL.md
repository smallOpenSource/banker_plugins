---
name: pdf-vision-extract
description: Convert visual-heavy PDFs (UI mockups, design specs, diagrams) to high-DPI per-page PNGs so Claude can read them as pure vision inputs without layout distortion. Use when a PDF contains UI screens, charts, or any content where layout fidelity matters more than raw text.
---

# pdf-vision-extract

## When to use

Trigger this skill when:
- A PDF contains **UI mockups, screen designs, wireframes, dashboards, or diagrams**
- The user wants Claude to **"see"** the PDF the way a human would, not read a flattened markdown
- Text-only extraction (`pdftotext`, `pdf2md`) would lose meaning
- The PDF exceeds the inline Read tool limit (10+ pages) and per-page vision is preferred

Do **not** use for plain text PDFs (papers, contracts) — `Read pages: "1-20"` is faster.

## Why this works

Claude's PDF support already renders each page to an image internally (per Anthropic docs), but for **UI fidelity** you want:
1. Explicit DPI control (PDF rendering can be at any DPI; native Read pipeline uses defaults)
2. Long-edge sized to the current model's vision sweet spot
3. Pages addressable individually so context only holds what's needed

Claude Opus 4.7 vision limits:
- Max long edge **2576 px** (native res); above this is downscaled
- ~4784 tokens per high-res image
- Token formula: `width × height / 750`

Target: **long edge = 2400 px** (just under cap, leaves headroom).

## Workflow

### 1. Verify input

```bash
ls -lh <pdf-path>
python3 -c "import fitz; d=fitz.open('<pdf-path>'); print('pages=', d.page_count)"
```

### 2. Choose output directory

Convention: place PNGs **next to** existing design assets, in a subfolder named after the PDF or `UI/`:
- `docs/design/UI/page-001.png` (for a single source-of-truth PDF)
- `docs/design/<pdf-stem>/page-001.png` (for multiple PDFs)

### 3. Convert (PyMuPDF — preferred)

PyMuPDF is the most reliable single-dependency path (no Poppler, no ImageMagick).

```bash
python3 - <<'PY'
import fitz, os
SRC = "<absolute-pdf-path>"
OUT = "<absolute-output-dir>"
TARGET = 2400  # long edge px
os.makedirs(OUT, exist_ok=True)
doc = fitz.open(SRC)
for i, page in enumerate(doc, start=1):
    long_pt = max(page.rect.width, page.rect.height)
    mat = fitz.Matrix(TARGET / long_pt, TARGET / long_pt)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    pix.save(f"{OUT}/page-{i:03d}.png")
    print(f"[{i}/{doc.page_count}] page-{i:03d}.png {pix.width}x{pix.height}")
PY
```

Install if missing: `python3 -m pip install --user pymupdf`

### 4. Fallback toolchain

If Python/PyMuPDF unavailable:

| Tool | Command | Notes |
|------|---------|-------|
| `pdftoppm` (poppler-utils) | `pdftoppm -png -r 200 in.pdf out/page` | Fastest, very stable |
| `pdf2image` (Python) | wraps pdftoppm | Needs Poppler binary too |
| ImageMagick | `convert -density 200 in.pdf out/page-%03d.png` | Slow, but ubiquitous |

200 DPI on A4 ≈ 1654×2339 px; bump to **220 DPI** for ~2400 long edge.

### 5. Verify

```bash
ls <OUT> | wc -l                # page count matches PDF
python3 -c "from PIL import Image; im=Image.open('<OUT>/page-001.png'); print(im.size)"
```

Expect long edge ≈ 2400 px.

### 6. Read pages

Now invoke the `Read` tool on individual PNGs — Claude sees them as native vision input:

```
Read /absolute/path/to/page-001.png
```

For multiple pages in one turn, batch multiple `Read` calls in parallel.

## Gotchas

- **Color/font issues**: If the PDF uses uncommon embedded fonts, vectors still render correctly via PyMuPDF; OCR is not needed.
- **Scanned PDFs**: If pages are themselves images (no text layer), DPI in the source bitmap caps quality — bumping render DPI above source DPI won't add information. Run `ocrmypdf` first if you also need searchable text.
- **Very tall/wide pages** (long-form scroll designs): Long edge clamp may shrink details. Consider splitting tall pages into vertical tiles before rendering.
- **Storage**: 2400-px PNGs run ~0.5–1.5 MB each. A 100-page UI deck = ~100 MB. Add `*.png` under the output dir to `.gitignore` if these shouldn't be tracked.

## Companion artifacts (optional)

For a hybrid pipeline (visual + searchable text), also extract markdown:

```bash
python3 -m pip install --user pymupdf4llm
python3 -c "import pymupdf4llm; print(pymupdf4llm.to_markdown('<pdf>'))" > <OUT>/text.md
```

Then `grep` the `.md` for labels and cross-reference with the PNGs.

## Example invocation history

- `docs/UI_260515.pdf` (95 p, 9.3 MB) → `docs/design/UI/page-001.png` … `page-095.png` at 2400 long-edge
