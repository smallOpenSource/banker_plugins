// vg-draw.mjs: drawing helpers on a CanvasKit canvas for video-gen. A Painter holds the objects one render reuses
// (paints, laid-out paragraphs, decoded images) and frees them at the end, since CanvasKit memory is not collected.
import { FAMILIES } from "./vg-engine.mjs";

const PARA_CACHE = 600;
const IMAGE_CACHE = 4;
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

  /** A laid-out paragraph: size in px, bold, color hex, width px, align left|center|right. Not cached. */
  build(text, { size, bold = false, color = "FFFFFF", width = this.W, align = "left", lineHeight = 1.25 }) {
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
    const p = b.build();
    b.delete();
    p.layout(width);
    return p;
  }

  /**
   * A cached paragraph. The cache keeps the most recently used PARA_CACHE entries and frees older ones, so a long
   * video does not run the WASM heap out (a frame uses far fewer).
   */
  para(text, opts) {
    const key = JSON.stringify([text, opts.size, !!opts.bold, opts.color, opts.width, opts.align, opts.lineHeight]);
    let p = this.paras.get(key);
    if (p) {
      this.paras.delete(key);
    } else {
      p = this.build(text, opts);
      while (this.paras.size >= PARA_CACHE) {
        const [old, q] = this.paras.entries().next().value;
        q.delete();
        this.paras.delete(old);
      }
    }
    this.paras.set(key, p);
    return p;
  }

  /**
   * Draws text at (x, y) top-left with alpha and an optional scale about its centre; returns { w, h }.
   * transient text (a number that changes every frame) is laid out, drawn and freed, never cached.
   */
  text(text, x, y, opts, { alpha = 1, scale = 1, transient = false } = {}) {
    const p = transient ? this.build(text, opts) : this.para(text, opts);
    const { w, h } = this.size(p, opts);
    if (alpha > 0 && text) this.place(p, { x, y, w, h, pad: opts.size }, alpha, scale);
    if (transient) p.delete();
    return { w, h };
  }

  /** Draws a laid-out paragraph faded and scaled about its centre, in a layer bounded by its box. */
  place(p, { x, y, w, h, pad }, alpha, scale) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const box = [cx - (w / 2) * scale - pad, cy - (h / 2) * scale - pad, cx + (w / 2) * scale + pad, cy + (h / 2) * scale + pad];
    this.layer(alpha, () => {
      if (scale !== 1) {
        this.c.translate(cx, cy);
        this.c.scale(scale, scale);
        this.c.translate(-cx, -cy);
      }
      this.c.drawParagraph(p, x, y);
    }, box);
  }

  /** Width (the text's own for left-aligned text, else the box) and height of a laid-out paragraph. */
  size(p, opts) {
    const left = opts.align === "left" || !opts.align;
    return { w: left ? p.getMaxIntrinsicWidth() : opts.width ?? this.W, h: p.getHeight() };
  }

  measure(text, opts) {
    const p = this.para(text, opts);
    return { w: p.getMaxIntrinsicWidth(), h: p.getHeight() };
  }

  /**
   * Runs draw() with everything it draws faded to alpha. Below 1 it draws into a layer, bounded by box
   * [left, top, right, bottom] when given: an unbounded layer is the whole frame and costs that much per call.
   */
  layer(alpha, draw, box) {
    if (alpha >= 1) {
      this.c.save();
      draw();
      this.c.restore();
      return;
    }
    const p = new this.CK.Paint();
    p.setAlphaf(Math.max(0, alpha));
    if (box) this.c.saveLayer(p, this.CK.LTRBRect(...box));
    else this.c.saveLayer(p);
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

  /**
   * The image for a scene, decoded once and shrunk to at most 1.15 x the frame's longer side (sharp enough for the
   * slow zoom, small in memory); only the most recent IMAGE_CACHE images are kept.
   */
  decoded(img) {
    let im = this.images.get(img.file);
    if (im) {
      this.images.delete(img.file);
      this.images.set(img.file, im);
      return im;
    }
    const full = this.CK.MakeImageFromEncoded(img.data);
    if (!full) throw new Error(`그림을 풀지 못함: ${img.file}`);
    im = this.shrink(full);
    while (this.images.size >= IMAGE_CACHE) {
      const [old, q] = this.images.entries().next().value;
      q.delete();
      this.images.delete(old);
    }
    this.images.set(img.file, im);
    return im;
  }

  shrink(full) {
    // Down to the size it covers the frame at (plus room for the zoom), so a portrait or panorama is not enlarged again.
    const k = Math.min(1, Math.max(this.W / full.width(), this.H / full.height()) * 1.15);
    if (k >= 1) return full;
    const w = Math.max(1, Math.round(full.width() * k));
    const h = Math.max(1, Math.round(full.height() * k));
    const s = this.CK.MakeSurface(w, h);
    s.getCanvas().drawImageRectOptions(full, this.CK.LTRBRect(0, 0, full.width(), full.height()), this.CK.LTRBRect(0, 0, w, h), this.CK.FilterMode.Linear, this.CK.MipmapMode.Linear, null);
    const small = s.makeImageSnapshot();
    s.delete();
    full.delete();
    return small;
  }

  /** Draws an image to cover the box, zoomed by zoom about a point that drifts by pan (-1..1 of the slack). */
  image(img, box, { zoom = 1, pan = 0, alpha = 1 } = {}) {
    const im = this.decoded(img);
    const k = Math.max(box.w / im.width(), box.h / im.height()) * zoom;
    const w = im.width() * k;
    const h = im.height() * k;
    const x = box.x + (box.w - w) / 2 + ((w - box.w) / 2) * pan;
    const y = box.y + (box.h - h) / 2;
    this.clip(box.x, box.y, box.w, box.h, () => this.layer(alpha, () => {
      const src = this.CK.LTRBRect(0, 0, im.width(), im.height());
      this.c.drawImageRectOptions(im, src, this.CK.LTRBRect(x, y, x + w, y + h), this.CK.FilterMode.Linear, this.CK.MipmapMode.None, this.imagePaint);
    }, [box.x, box.y, box.x + box.w, box.y + box.h]));
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
