import { PDFOperator, PDFOperatorNames as Op, PDFName, PDFNumber, type PDFOperator as PDFOperatorType } from "pdf-lib";

const MM = 72 / 25.4;
/** トンボの線の長さと太さ。 */
const MARK_LENGTH = 10 * MM;
const MARK_WIDTH = 0.1 * MM;

/** トンボを描くのに必要な、仕上がり線の外側の余白。 */
export function marksMargin(bleed: number): number {
  return bleed + MARK_LENGTH + 2 * MM;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const op = (name: Op, ...args: number[]) => PDFOperator.of(name, args.map((n) => PDFNumber.of(n)));

function line(x0: number, y0: number, x1: number, y1: number): PDFOperatorType[] {
  return [op(Op.MoveTo, x0, y0), op(Op.LineTo, x1, y1), op(Op.StrokePath)];
}

/**
 * 日本式トンボ（四隅の二重のコーナートンボと、各辺中央の十字トンボ）。
 * 色はレジストレーション（全版に出る色。Separation /All）で描く。
 * colorSpace は、ページの Resources に登録した Separation /All の名前。
 */
export function japaneseTrimMarks(trim: Rect, bleed: number, colorSpace: string): PDFOperatorType[] {
  const L = MARK_LENGTH;
  const ops: PDFOperatorType[] = [
    PDFOperator.of(Op.PushGraphicsState),
    PDFOperator.of(Op.StrokingColorspace, [PDFName.of(colorSpace)]),
    op(Op.StrokingColorN, 1),
    op(Op.SetLineWidth, MARK_WIDTH),
  ];

  // 四隅。sx, sy は、その角から外へ向かう向き（-1 か 1）。
  for (const [cx, sx] of [[trim.x0, -1], [trim.x1, 1]] as const) {
    for (const [cy, sy] of [[trim.y0, -1], [trim.y1, 1]] as const) {
      // 仕上がり線の延長（内側の線）。塗り足しの外から始める。
      ops.push(...line(cx, cy + sy * bleed, cx, cy + sy * (bleed + L)));
      ops.push(...line(cx + sx * bleed, cy, cx + sx * (bleed + L), cy));
      // 塗り足し線（外側の線）。仕上がり線の位置から始めて L 字に見せる。
      ops.push(...line(cx + sx * bleed, cy, cx + sx * bleed, cy + sy * (bleed + L)));
      ops.push(...line(cx, cy + sy * bleed, cx + sx * (bleed + L), cy + sy * bleed));
    }
  }

  // 各辺の中央の十字トンボ。
  const mx = (trim.x0 + trim.x1) / 2;
  const my = (trim.y0 + trim.y1) / 2;
  for (const [y, s] of [[trim.y0, -1], [trim.y1, 1]] as const) {
    ops.push(...line(mx, y + s * bleed, mx, y + s * (bleed + L)));
    ops.push(...line(mx - L / 2, y + s * (bleed + L / 2), mx + L / 2, y + s * (bleed + L / 2)));
  }
  for (const [x, s] of [[trim.x0, -1], [trim.x1, 1]] as const) {
    ops.push(...line(x + s * bleed, my, x + s * (bleed + L), my));
    ops.push(...line(x + s * (bleed + L / 2), my - L / 2, x + s * (bleed + L / 2), my + L / 2));
  }

  ops.push(PDFOperator.of(Op.PopGraphicsState));
  return ops;
}
