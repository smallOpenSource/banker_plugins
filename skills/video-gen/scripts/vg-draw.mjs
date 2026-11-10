// vg-draw.mjs: drawing helpers on a CanvasKit canvas for video-gen. A Painter holds the objects one render reuses
// (paints, laid-out paragraphs, decoded images) and frees them at the end, since CanvasKit memory is not collected.
import { FAMILIES } from "./vg-engine.mjs";

const rgb = (h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];

export class Painter {
  constructor(CK, fonts, canvas, width, height) {
    this.CK = CK;
    this.fonts = fonts;
    this.c = canvas;
    this.W = width;
    this.H = height;
    // One unit is a pixel of a 1280 x 720 frame, scaled to fit this frame's shorter side.
    this.u = Math.min(width / 1280, height / 720);
    this.paint = new CK.Paint();
    this.paint.setAntiAlias(true);
    // Images get a paint of their own: the shape paint's colour alpha would fade them.
    this.imagePaint = new CK.Paint();
    this.imagePaint.setAntiAlias(true);
    this.paras = new Map();
    this.images = new Map();
  }

  color(h, a = 1) {
    const [r, g, b] = rgb(h);
    return this.CK.Color(r, g, b, Math.max(0, Math.min(1, a)));
  }

  clear(h) {
    this.c.clear(this.color(h));
  }

  rect(x, y, w, h, color, alpha = 1, radius = 0) {
    if (w <= 0 || h <= 0 || alpha <= 0) return;
    this.paint.setStyle(this.CK.PaintStyle.Fill);
    this.paint.setColor(this.color(color, alpha));
    const r = this.CK.LTRBRect(x, y, x + w, y + h);
    if (radius > 0) this.c.drawRRect(this.CK.RRectXY(r, radius, radius), this.paint);
    else this.c.drawRect(r, this.paint);
  }

  circle(x, y, r, color, alpha = 1) {
    if (r <= 0 || alpha <= 0) return;
    this.paint.setStyle(this.CK.PaintStyle.Fill);
    this.paint.setColor(this.color(color, alpha));
    this.c.drawCircle(x, y, r, this.paint);
  }

  line(points, color, width, alpha = 1) {
    if (points.length < 2) return;
    // CanvasKit 0.42 paths are immutable: build one, then detach it.
    const b = new this.CK.PathBuilder();
    b.moveTo(points[0][0], points[0][1]);
    for (const p of points.slice(1)) b.lineTo(p[0], p[1]);
    const path = b.detachAndDelete();
    this.paint.setStyle(this.CK.PaintStyle.Stroke);
    this.paint.setStrokeWidth(width);
    this.paint.setStrokeJoin(this.CK.StrokeJoin.Round);
    this.paint.setStrokeCap(this.CK.StrokeCap.Round);
    this.paint.setColor(this.color(color, alpha));
    this.c.drawPath(path, this.paint);
    path.delete();
  }

  /** A laid-out paragraph (cached): size in px, bold, color hex, width px, align left|center|right. */
  para(text, { size, bold = false, color = "FFFFFF", width = this.W, align = "left", lineHeight = 1.25 }) {
    const key = JSON.stringify([text, size, bold, color, width, align, lineHeight]);
    let p = this.paras.get(key);
    if (p) return p;
    const CK = this.CK;
    const style = new CK.ParagraphStyle({
      textAlign: { left: CK.TextAlign.Left, center: CK.TextAlign.Center, right: CK.TextAlign.Right }[align],
      textStyle: {
        color: this.color(color), fontFamilies: FAMILIES, fontSize: size, heightMultiplier: lineHeight,
        fontStyle: { weight: bold ? CK.FontWeight.Bold : CK.FontWeight.Normal },
      },
    });
    const b = CK.ParagraphBuilder.MakeFromFontProvider(style, this.fonts);
    b.addText(text);
    p = b.build();
    b.delete();
    p.layout(width);
    this.paras.set(key, p);
    return p;
  }

  /** Draws text at (x, y) top-left with alpha and an optional scale about its centre; returns { w, h }. */
  text(text, x, y, opts, { alpha = 1, scale = 1 } = {}) {
    const p = this.para(text, opts);
    const w = opts.align === "left" || !opts.align ? p.getMaxIntrinsicWidth() : opts.width ?? this.W;
    const h = p.getHeight();
    if (alpha <= 0 || !text) return { w, h };
    this.layer(alpha, () => {
      if (scale !== 1) {
        this.c.translate(x + w / 2, y + h / 2);
        this.c.scale(scale, scale);
        this.c.translate(-(x + w / 2), -(y + h / 2));
      }
      this.c.drawParagraph(p, x, y);
    });
    return { w, h };
  }

  measure(text, opts) {
    const p = this.para(text, opts);
    return { w: p.getMaxIntrinsicWidth(), h: p.getHeight() };
  }

  /** Runs draw() with everything it draws faded to alpha (a layer only when alpha < 1). */
  layer(alpha, draw) {
    if (alpha >= 1) {
      this.c.save();
      draw();
      this.c.restore();
      return;
    }
    const p = new this.CK.Paint();
    p.setAlphaf(Math.max(0, alpha));
    this.c.saveLayer(p);
    draw();
    this.c.restore();
    p.delete();
  }

  clip(x, y, w, h, draw) {
    this.c.save();
    this.c.clipRect(this.CK.LTRBRect(x, y, x + w, y + h), this.CK.ClipOp.Intersect, true);
    draw();
    this.c.restore();
  }

  /** Draws an image to cover the box, zoomed by zoom about a point that drifts by pan (-1..1 of the slack). */
  image(img, box, { zoom = 1, pan = 0, alpha = 1 } = {}) {
    let im = this.images.get(img.file);
    if (!im) {
      im = this.CK.MakeImageFromEncoded(img.data);
      if (!im) throw new Error(`그림을 풀지 못함: ${img.file}`);
      this.images.set(img.file, im);
    }
    const k = Math.max(box.w / im.width(), box.h / im.height()) * zoom;
    const w = im.width() * k;
    const h = im.height() * k;
    const x = box.x + (box.w - w) / 2 + ((w - box.w) / 2) * pan;
    const y = box.y + (box.h - h) / 2;
    this.clip(box.x, box.y, box.w, box.h, () => this.layer(alpha, () => {
      this.c.drawImageRect(im, this.CK.LTRBRect(0, 0, im.width(), im.height()), this.CK.LTRBRect(x, y, x + w, y + h), this.imagePaint);
    }));
  }

  free() {
    for (const p of this.paras.values()) p.delete();
    for (const im of this.images.values()) im.delete();
    this.paras.clear();
    this.images.clear();
    this.paint.delete();
    this.imagePaint.delete();
  }
}
