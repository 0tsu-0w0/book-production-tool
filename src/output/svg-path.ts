import { appendBezierCurve, closePath, lineTo, moveTo, type PDFOperator } from "pdf-lib";

// SVG のパス（d 属性）を PDF の描画命令にする（数式の輪郭を塗るのに使う）。
// M L H V C S Q T Z（大文字は絶対、小文字は相対）に対応する。円弧（A）は数式の輪郭には出てこないので扱わない。

export function svgPathOps(d: string): PDFOperator[] {
  const ops: PDFOperator[] = [];
  const tokens = d.match(/[MLHVCSQTZmlhvcsqtz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // 直前の制御点（S・T で反転して使う）。
  let cx = 0;
  let cy = 0;
  let prev = "";
  const num = () => Number(tokens[i++]);
  const hasNumber = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]);
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    ops.push(appendBezierCurve(x1, y1, x2, y2, ex, ey));
    cx = x2;
    cy = y2;
    x = ex;
    y = ey;
  };
  const quad = (qx: number, qy: number, ex: number, ey: number) => {
    // 2次ベジェを3次に直す。
    cubic(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
    cx = qx;
    cy = qy;
  };
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "M": {
        x = ox + num();
        y = oy + num();
        startX = x;
        startY = y;
        ops.push(moveTo(x, y));
        // M のあとに続く座標は L とみなす。
        cmd = rel ? "l" : "L";
        break;
      }
      case "L":
        x = ox + num();
        y = oy + num();
        ops.push(lineTo(x, y));
        break;
      case "H":
        x = ox + num();
        ops.push(lineTo(x, y));
        break;
      case "V":
        y = oy + num();
        ops.push(lineTo(x, y));
        break;
      case "C": {
        const v = [num(), num(), num(), num(), num(), num()];
        cubic(ox + v[0], oy + v[1], ox + v[2], oy + v[3], ox + v[4], oy + v[5]);
        break;
      }
      case "S": {
        const v = [num(), num(), num(), num()];
        const reflect = /[CS]/i.test(prev);
        cubic(reflect ? 2 * x - cx : x, reflect ? 2 * y - cy : y, ox + v[0], oy + v[1], ox + v[2], oy + v[3]);
        break;
      }
      case "Q": {
        const v = [num(), num(), num(), num()];
        quad(ox + v[0], oy + v[1], ox + v[2], oy + v[3]);
        break;
      }
      case "T": {
        const v = [num(), num()];
        const reflect = /[QT]/i.test(prev);
        quad(reflect ? 2 * x - cx : x, reflect ? 2 * y - cy : y, ox + v[0], oy + v[1]);
        break;
      }
      case "Z":
        ops.push(closePath());
        x = startX;
        y = startY;
        break;
      default:
        // 知らない命令：読み飛ばす。
        i++;
    }
    prev = cmd;
    if (cmd.toUpperCase() === "Z" && hasNumber()) cmd = "L";
  }
  return ops;
}
