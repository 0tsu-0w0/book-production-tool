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
    case "link":
      return { ...s, x: s.x + dx };
    case "path":
      return { ...s, m: [s.m[0], s.m[1], s.m[2], s.m[3], s.m[4] + dx, s.m[5]] };
  }
}

/** 2ページを横に並べて1枚にする。左ページが左半分、右ページが右半分。 */
export function combineSpread(right: DrawPage | null, left: DrawPage | null, index: number): DrawPage {
  const base = (right ?? left)!;
  const w = base.width;
  const placed = (page: DrawPage | null, dx: number) =>
    // 面付けしたページでは、リンクの飛び先（元のページ）がずれるので、リンクは外す。
    page ? { items: page.items.map((it) => ({ ...it, x: it.x + dx })), shapes: page.shapes.filter((s) => s.kind !== "link").map((s) => shiftShape(s, dx)) } : { items: [], shapes: [] };
  const l = placed(left, 0);
  const r = placed(right, w);
  return { index, width: w * 2, height: base.height, paper: base.paper, items: [...l.items, ...r.items], shapes: [...l.shapes, ...r.shapes] };
}

/** ページを見開きにまとめる。名前はページ番号を右→左の順につないだもの（例：002-003）。 */
export function imposeSpreads(pages: DrawPage[], firstPageNumber: number, leftBound = false): { pages: DrawPage[]; labels: string[] } {
  const pairs = spreadPairs(pages.length, firstPageNumber, leftBound);
  return {
    pages: pairs.map((p, i) => combineSpread(p.right === null ? null : pages[p.right], p.left === null ? null : pages[p.left], i)),
    labels: pairs.map((p) => spreadLabel(p, firstPageNumber, leftBound)),
  };
}

/** 見開きの名前（読む順にページ番号をつなぐ。例：002-003）。 */
export function spreadLabel(p: Spread, firstPageNumber: number, leftBound = false): string {
  const num = (i: number) => String(firstPageNumber + i).padStart(3, "0");
  return (leftBound ? [p.left, p.right] : [p.right, p.left]).filter((v): v is number => v !== null).map(num).join("-");
}

/**
 * 中綴じの面付け：ページを、両面に刷って重ね、真ん中で折って綴じると冊子になる順に並べる。
 * 1枚の紙の表に2ページ、裏に2ページ。ページ数は4の倍数になるよう、最後に白ページを足す。
 * 最初のページが偶数ページ（ノンブルの開始番号が偶数）なら、先頭にも白ページを1つ足す（1ページ目は表紙側の右か左）。
 * 右綴じ（縦組み）では、表紙が紙の左半分に来る。左綴じ（横組み）は左右が逆。
 * 返すのは紙の面の並び（1枚目の表・1枚目の裏・2枚目の表…）。null は白ページ。
 */
export function saddlePairs(pageCount: number, firstPageNumber: number, leftBound = false): Spread[] {
  const order: (number | null)[] = [];
  if (pageCount > 0 && firstPageNumber % 2 === 0) order.push(null);
  for (let i = 0; i < pageCount; i++) order.push(i);
  while (order.length % 4 !== 0) order.push(null);
  const n = order.length;
  // 冊子の p ページ目（1始まり）に置く元のページ（null は白ページ）。
  const at = (p: number) => order[p - 1] ?? null;
  const out: Spread[] = [];
  for (let s = 0; s < n / 4; s++) {
    // 表（外側）：最後から数えたページと、前から数えたページ。裏（内側）：その裏のページ。
    const outerBack = n - 2 * s;
    const outerFront = 1 + 2 * s;
    const innerFront = 2 + 2 * s;
    const innerBack = n - 1 - 2 * s;
    // 右綴じは、表で前のページが左・後ろのページが右。裏はその逆。左綴じは左右を入れ替える。
    if (leftBound) {
      out.push({ left: at(outerBack), right: at(outerFront) });
      out.push({ left: at(innerFront), right: at(innerBack) });
    } else {
      out.push({ left: at(outerFront), right: at(outerBack) });
      out.push({ left: at(innerBack), right: at(innerFront) });
    }
  }
  return out;
}

/** 中綴じの面付けをしたページ（紙の面ごとに2ページを並べたもの）と、紙の枚数・足した白ページの数。 */
export function imposeSaddle(pages: DrawPage[], firstPageNumber: number, leftBound = false): { pages: DrawPage[]; sheets: number; blanks: number } {
  const pairs = saddlePairs(pages.length, firstPageNumber, leftBound);
  // 白ページは、紙の色だけの同じ大きさのページ。
  const blank = (): DrawPage => ({ ...pages[0], items: [], shapes: [] });
  const page = (i: number | null) => (i === null ? blank() : pages[i]);
  return {
    pages: pairs.map((p, i) => combineSpread(page(p.right), page(p.left), i)),
    sheets: pairs.length / 2,
    blanks: pairs.length * 2 - pages.length,
  };
}
