import type { DrawPage, Shape } from "../engine/types.js";
import type { InkPreview } from "./ink-preview.js";

// ページを Canvas に描く。画面のプレビューと、画像の書き出し（Worker 内の OffscreenCanvas）で共用する。

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface DrawOptions {
  /** 1pt を何ピクセルで描くか。 */
  pxPerPt: number;
  /** 仕上がりの外に描く塗り足しの幅（pt）。0 なら仕上がりちょうど。 */
  bleedPt?: number;
  /** 仕上がり線と版面の枠を描く（プレビュー用）。 */
  guides?: boolean;
  /** 文書の画像（名前で引く）。ないものは枠と×印で描く。 */
  images?: Map<string, CanvasImageSource>;
  /** 分版プレビュー：選んだ版だけで刷った色にし、オーバープリントの色は下の色に重ねる。紙の色は刷らないので白。 */
  ink?: InkPreview | null;
}

/** 1つのフォントの字形の輪郭。字形番号はフォントごとに違うので、フォントごとに1つ持つ。 */
export class GlyphPaths {
  private readonly paths = new Map<number, Path2D>();
  private readonly sources = new Map<number, string>();

  add(source: Record<number, string>): void {
    for (const [gid, d] of Object.entries(source)) {
      const id = Number(gid);
      if (this.paths.has(id)) continue;
      this.paths.set(id, new Path2D(d));
      this.sources.set(id, d);
    }
  }

  get(gid: number): Path2D | undefined {
    return this.paths.get(gid);
  }

  /** Worker に渡すための、輪郭の文字列の一覧。 */
  record(): Record<number, string> {
    return Object.fromEntries(this.sources);
  }
}

/** 描いたときのキャンバスの大きさ（ピクセル）。 */
export function canvasSize(page: DrawPage, opts: DrawOptions): { width: number; height: number } {
  const bleed = opts.bleedPt ?? 0;
  return {
    width: Math.round((page.width + bleed * 2) * opts.pxPerPt),
    height: Math.round((page.height + bleed * 2) * opts.pxPerPt),
  };
}

/** 描画に使うフォント（ページの DrawItem.face の番号で引く）。 */
export interface DrawFont {
  paths: GlyphPaths;
  upem: number;
}

/** 擬似ボールドの輪郭の太さ（文字サイズに対する割合。PDF と同じ）。 */
const BOLD_STROKE = 0.035;

export function drawPage(ctx: Ctx, page: DrawPage, fonts: DrawFont[], opts: DrawOptions): void {
  const bleed = opts.bleedPt ?? 0;
  const px = opts.pxPerPt;
  const origin = (x: number, y: number) => [(x + bleed) * px, (y + bleed) * px] as const;
  const { width, height } = canvasSize(page, opts);

  const ink = opts.ink ?? null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = ink ? "#ffffff" : page.paper;
  ctx.fillRect(0, 0, width, height);

  ctx.setTransform(px, 0, 0, px, bleed * px, bleed * px);
  for (const shape of page.shapes) {
    if (shape.kind === "image") {
      const source = opts.images?.get(shape.name);
      drawImage(ctx, shape, source && ink ? inkImage(source, ink) : source);
    } else if (ink) drawShape(ctx, inkShape(shape, ink), ink, shape);
    else drawShape(ctx, shape);
  }

  // 字形を色ごとに1つのパスへまとめ、色ごとに1回だけ塗る。
  // 字形ごとに塗るより、1ページ（約千字）の描画がずっと速い。擬似ボールドは輪郭の太さごとに分ける。
  const groups = new Map<string, { color: string; stroke: number; path: Path2D }>();
  const matrix = new DOMMatrix();
  for (const item of page.items) {
    const font = fonts[item.face] ?? fonts[0];
    const { paths, upem } = font;
    const stroke = item.bold ? item.size * BOLD_STROKE * px : 0;
    const groupKey = `${item.color}|${stroke}`;
    let group = groups.get(groupKey);
    if (!group) groups.set(groupKey, (group = { color: item.color, stroke, path: new Path2D() }));
    const combined = group.path;
    const scale = (item.size / upem) * px;
    for (const g of item.glyphs) {
      const path = paths.get(g.gid);
      if (!path) continue;
      if (item.rotate) {
        // 時計回りに 90°：送り方向（字形の x）がページの下、字形の上（y）がページの右。
        const [ox, oy] = origin(item.x, item.y + (g.dx * item.size * item.sx) / upem);
        setMatrix(matrix, 0, scale * item.sx, scale * (item.sy ?? 1), 0, ox, oy);
      } else {
        const [ox, oy] = origin(item.x + (g.dx * item.size * item.sx) / upem, item.y);
        setMatrix(matrix, scale * item.sx, 0, 0, -scale * (item.sy ?? 1), ox, oy);
      }
      combined.addPath(path, matrix);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const { color, stroke, path } of groups.values()) {
    // 分版プレビュー：見せない版だけの色は描かない。オーバープリントの色は下の色に掛け合わせる。
    const shown = ink ? ink.color(color) : color;
    if (!shown) continue;
    ctx.globalCompositeOperation = ink?.overprint(color) ? "multiply" : "source-over";
    ctx.fillStyle = shown;
    ctx.fill(path);
    if (stroke > 0) {
      ctx.strokeStyle = shown;
      ctx.lineWidth = stroke;
      ctx.lineJoin = "round";
      ctx.stroke(path);
    }
  }
  ctx.globalCompositeOperation = "source-over";

  if (opts.guides && bleed > 0) {
    ctx.setTransform(px, 0, 0, px, bleed * px, bleed * px);
    ctx.lineWidth = 0.5 / px;
    ctx.strokeStyle = "#e0245e";
    ctx.setLineDash([]);
    ctx.strokeRect(0, 0, page.width, page.height);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function setMatrix(m: DOMMatrix, a: number, b: number, c: number, d: number, e: number, f: number): void {
  m.a = a;
  m.b = b;
  m.c = c;
  m.d = d;
  m.e = e;
  m.f = f;
}

/** 画像を描く。clip があればその範囲で切る。画像がなければ、置き場所が分かるよう灰色の枠と×印を描く。 */
function drawImage(ctx: Ctx, shape: Extract<Shape, { kind: "image" }>, source: CanvasImageSource | undefined): void {
  ctx.save();
  if (shape.clip) {
    ctx.beginPath();
    ctx.rect(shape.clip.x, shape.clip.y, shape.clip.w, shape.clip.h);
    ctx.clip();
  }
  if (source) {
    ctx.drawImage(source, shape.x, shape.y, shape.w, shape.h);
  } else {
    ctx.fillStyle = "#eeeeee";
    ctx.fillRect(shape.x, shape.y, shape.w, shape.h);
    ctx.strokeStyle = "#999999";
    ctx.lineWidth = 0.5;
    ctx.setLineDash([]);
    ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
    ctx.beginPath();
    ctx.moveTo(shape.x, shape.y);
    ctx.lineTo(shape.x + shape.w, shape.y + shape.h);
    ctx.moveTo(shape.x + shape.w, shape.y);
    ctx.lineTo(shape.x, shape.y + shape.h);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * 分版プレビューの図形の色：選んだ版だけの色にする。どの版にも乗らない色は空にして描かない
 * （線・塗りの色が空の図形は drawShape が飛ばす）。
 */
function inkShape(shape: Shape, ink: InkPreview): Shape {
  const map = (c: string) => (c ? (ink.color(c) ?? "") : c);
  switch (shape.kind) {
    case "line":
    case "path":
      return { ...shape, color: map(shape.color) };
    case "rect":
      return { ...shape, ...(shape.fill ? { fill: map(shape.fill) } : {}), ...(shape.stroke ? { stroke: { ...shape.stroke, color: map(shape.stroke.color) } } : {}) };
    case "circle":
    case "diamond":
      return { ...shape, fill: map(shape.fill) };
    default:
      return shape;
  }
}

/** 分版プレビューの画像：画素ごとに、選んだ版だけで刷った色にしたもの（版の組み合わせごとに控える）。 */
const inkImages = new WeakMap<object, { key: string; canvas: OffscreenCanvas }>();
function inkImage(source: CanvasImageSource, ink: InkPreview): CanvasImageSource {
  const hit = inkImages.get(source);
  if (hit && hit.key === ink.key) return hit.canvas;
  const s = source as { width: number | { baseVal: { value: number } }; height: number | { baseVal: { value: number } } };
  const w = typeof s.width === "number" ? s.width : s.width.baseVal.value;
  const h = typeof s.height === "number" ? s.height : s.height.baseVal.value;
  if (!w || !h) return source;
  const canvas = new OffscreenCanvas(w, h);
  const c = canvas.getContext("2d")!;
  c.drawImage(source, 0, 0);
  const data = c.getImageData(0, 0, w, h);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = ink.pixel(d[i], d[i + 1], d[i + 2]);
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  }
  c.putImageData(data, 0, 0);
  inkImages.set(source, { key: ink.key, canvas });
  return canvas;
}

function drawShape(ctx: Ctx, shape: Shape, ink?: InkPreview, original: Shape = shape): void {
  // 分版プレビュー：オーバープリントの色（元の色で決める）は、下の色に掛け合わせる。
  const o = original;
  const color = o.kind === "line" || o.kind === "path" ? o.color : o.kind === "rect" ? (o.fill ?? o.stroke?.color ?? "") : "fill" in o ? o.fill : "";
  ctx.globalCompositeOperation = ink && color && ink.overprint(color) ? "multiply" : "source-over";
  try {
    drawShapeInner(ctx, shape);
  } finally {
    ctx.globalCompositeOperation = "source-over";
  }
}

/** 図形を描く。色が空の所は描かない（分版プレビューで、見せない版だけの色）。 */
function drawShapeInner(ctx: Ctx, shape: Shape): void {
  ctx.setLineDash([]);
  switch (shape.kind) {
    case "path": {
      if (!shape.color) break;
      ctx.save();
      ctx.transform(...shape.m);
      ctx.fillStyle = shape.color;
      ctx.fill(new Path2D(shape.d));
      ctx.restore();
      break;
    }
    case "line":
      if (!shape.color) break;
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      if (shape.dash) ctx.setLineDash(shape.dash);
      ctx.beginPath();
      ctx.moveTo(shape.x1, shape.y1);
      ctx.lineTo(shape.x2, shape.y2);
      ctx.stroke();
      break;
    case "rect":
      if (shape.fill) {
        ctx.fillStyle = shape.fill;
        ctx.fillRect(shape.x, shape.y, shape.w, shape.h);
      }
      if (shape.stroke?.color) {
        ctx.strokeStyle = shape.stroke.color;
        ctx.lineWidth = shape.stroke.width;
        ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
      }
      break;
    case "circle":
      if (!shape.fill) break;
      ctx.fillStyle = shape.fill;
      ctx.beginPath();
      ctx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "link":
      // リンクの範囲は描かない（閲覧用 PDF でだけ使う）。
      break;
    case "diamond":
      if (!shape.fill) break;
      ctx.fillStyle = shape.fill;
      ctx.beginPath();
      ctx.moveTo(shape.cx, shape.cy - shape.r);
      ctx.lineTo(shape.cx + shape.r, shape.cy);
      ctx.lineTo(shape.cx, shape.cy + shape.r);
      ctx.lineTo(shape.cx - shape.r, shape.cy);
      ctx.closePath();
      ctx.fill();
      break;
  }
}
