import type { DrawPage, Shape } from "../engine/types.js";

// 見開きの面付け（OUT-05）。右綴じの本では、偶数ページが右、次の奇数ページが左に並ぶ。
// 最初のページが奇数ページなら、それだけで左側に置く（右側は空ける）。左綴じ（横組み）は左右が逆。

export interface Spread {
  /** 右ページ・左ページの番号（0 始まりの通し番号。ないほうは null）。 */
  right: number | null;
  left: number | null;
}

export function spreadPairs(pageCount: number, firstPageNumber: number, leftBound = false): Spread[] {
  const out: Spread[] = [];
  let i = 0;
  const pair = (first: number | null, second: number | null): Spread => (leftBound ? { left: first, right: second } : { right: first, left: second });
  if (pageCount > 0 && firstPageNumber % 2 !== 0) {
    out.push(pair(null, 0));
    i = 1;
  }
  for (; i < pageCount; i += 2) out.push(pair(i, i + 1 < pageCount ? i + 1 : null));
  return out;
}

function shiftShape(s: Shape, dx: number): Shape {
  switch (s.kind) {
    case "line":
      return { ...s, x1: s.x1 + dx, x2: s.x2 + dx };
    case "rect":
      return { ...s, x: s.x + dx };
    case "circle":
    case "diamond":
      return { ...s, cx: s.cx + dx };
    case "image":
      return { ...s, x: s.x + dx, ...(s.clip ? { clip: { ...s.clip, x: s.clip.x + dx } } : {}) };
    case "path":
      return { ...s, m: [s.m[0], s.m[1], s.m[2], s.m[3], s.m[4] + dx, s.m[5]] };
  }
}

/** 2ページを横に並べて1枚にする。左ページが左半分、右ページが右半分。 */
export function combineSpread(right: DrawPage | null, left: DrawPage | null, index: number): DrawPage {
  const base = (right ?? left)!;
  const w = base.width;
  const placed = (page: DrawPage | null, dx: number) =>
    page ? { items: page.items.map((it) => ({ ...it, x: it.x + dx })), shapes: page.shapes.map((s) => shiftShape(s, dx)) } : { items: [], shapes: [] };
  const l = placed(left, 0);
  const r = placed(right, w);
  return { index, width: w * 2, height: base.height, paper: base.paper, items: [...l.items, ...r.items], shapes: [...l.shapes, ...r.shapes] };
}

/** ページを見開きにまとめる。名前はページ番号を右→左の順につないだもの（例：002-003）。 */
export function imposeSpreads(pages: DrawPage[], firstPageNumber: number, leftBound = false): { pages: DrawPage[]; labels: string[] } {
  const num = (i: number) => String(firstPageNumber + i).padStart(3, "0");
  const pairs = spreadPairs(pages.length, firstPageNumber, leftBound);
  return {
    pages: pairs.map((p, i) => combineSpread(p.right === null ? null : pages[p.right], p.left === null ? null : pages[p.left], i)),
    labels: pairs.map((p) => (leftBound ? [p.left, p.right] : [p.right, p.left]).filter((v): v is number => v !== null).map(num).join("-")),
  };
}
