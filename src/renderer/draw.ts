import type { DrawPage, Shape } from "../engine/types.js";

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

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = page.paper;
  ctx.fillRect(0, 0, width, height);

  ctx.setTransform(px, 0, 0, px, bleed * px, bleed * px);
  for (const shape of page.shapes) {
    if (shape.kind === "image") drawImage(ctx, shape, opts.images?.get(shape.name));
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
        const [ox, oy] = origin(item.x, item.y + (g.dx * item.size) / upem);
        setMatrix(matrix, 0, scale, scale, 0, ox, oy);
      } else {
        const [ox, oy] = origin(item.x + (g.dx * item.size * item.sx) / upem, item.y);
        setMatrix(matrix, scale * item.sx, 0, 0, -scale, ox, oy);
      }
      combined.addPath(path, matrix);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const { color, stroke, path } of groups.values()) {
    ctx.fillStyle = color;
    ctx.fill(path);
    if (stroke > 0) {
      ctx.strokeStyle = color;
      ctx.lineWidth = stroke;
      ctx.lineJoin = "round";
      ctx.stroke(path);
    }
  }

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

function drawShape(ctx: Ctx, shape: Shape): void {
  ctx.setLineDash([]);
  switch (shape.kind) {
    case "path": {
      ctx.save();
      ctx.transform(...shape.m);
      ctx.fillStyle = shape.color;
      ctx.fill(new Path2D(shape.d));
      ctx.restore();
      break;
    }
    case "line":
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
      if (shape.stroke) {
        ctx.strokeStyle = shape.stroke.color;
        ctx.lineWidth = shape.stroke.width;
        ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
      }
      break;
    case "circle":
      ctx.fillStyle = shape.fill;
      ctx.beginPath();
      ctx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "diamond":
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
