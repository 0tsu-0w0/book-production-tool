import type { DrawItem, DrawPage } from "../engine/types.js";

// 紙面で入力するときのカーソルの位置（DTP-15）。原稿の位置（行・行の中の位置）と、紙面の字の位置を対応させる。
// 画面に触れない計算だけをここに置く（テストできるように）。

/** 原稿の位置：[行（0始まり）, 行の中の位置（UTF-16 の単位）]。 */
export type Src = [number, number];

/** カーソル（ページの座標 pt）。縦組みでは横棒（w が長さ）、横組みでは縦棒（h が長さ）。 */
export interface Caret {
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 字面のおおよその枠。原点はベースラインにあり、字面は 0.88em 上から 0.12em 下まで。 */
export function itemBox(it: DrawItem): Box {
  const n = Math.max(1, [...it.text].length);
  if (it.rotate) return { x0: it.x - it.size * 0.88, y0: it.y, x1: it.x + it.size * 0.12, y1: it.y + it.size * Math.max(1, n * 0.5) };
  const w = it.font === "horiz" ? it.size * Math.max(1, n * 0.5) : it.size;
  return { x0: it.x, y0: it.y - it.size * 0.88, x1: it.x + w, y1: it.y + it.size * 0.12 };
}

const before = (a: Src, b: Src) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/** 原稿の位置のついた字（原稿の順）。 */
function sourceItems(page: DrawPage): (DrawItem & { src: Src })[] {
  return page.items.filter((it): it is DrawItem & { src: Src } => !!it.src).sort((a, b) => a.src[0] - b.src[0] || a.src[1] - b.src[1]);
}

/**
 * 原稿の位置のカーソル。その位置かそのあとの、同じ行の最初の字の前に置く。
 * なければ、その位置より前の最後の字のあと（行末）。空の行（字がない行）なら、前の字の次の行の頭。
 */
export function caretAt(page: DrawPage, src: Src, vertical: boolean): Caret | undefined {
  const items = sourceItems(page);
  const next = items.find((it) => it.src[0] === src[0] && !before(it.src, src));
  if (next) {
    const b = itemBox(next);
    return vertical ? { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: 0, size: next.size } : { x: b.x0, y: b.y0, w: 0, h: b.y1 - b.y0, size: next.size };
  }
  const prev = items.findLast((it) => before(it.src, src));
  if (!prev) return undefined;
  const b = itemBox(prev);
  if (prev.src[0] === src[0]) {
    return vertical ? { x: b.x0, y: b.y1, w: b.x1 - b.x0, h: 0, size: prev.size } : { x: b.x1, y: b.y0, w: 0, h: b.y1 - b.y0, size: prev.size };
  }
  // 空の行：前の字の行の次の行の頭（行の間隔は、ページの行の位置から求める）。
  const pitch = linePitch(items, vertical) ?? prev.size * 1.7;
  const lines = src[0] - prev.src[0];
  const top = Math.min(...items.map((it) => itemBox(it)[vertical ? "y0" : "x0"]));
  return vertical
    ? { x: b.x0 - pitch * lines, y: top, w: b.x1 - b.x0, h: 0, size: prev.size }
    : { x: top, y: b.y0 + pitch * lines, w: 0, h: b.y1 - b.y0, size: prev.size };
}

/** 行の間隔：隣り合う行の位置の差のうち、いちばん多いもの。 */
function linePitch(items: DrawItem[], vertical: boolean): number | undefined {
  const pos = [...new Set(items.filter((it) => !it.rotate && it.font !== "horiz").map((it) => Math.round((vertical ? it.x : it.y) * 10) / 10))].sort((a, b) => a - b);
  const counts = new Map<number, number>();
  for (let i = 1; i < pos.length; i++) {
    const d = Math.round((pos[i] - pos[i - 1]) * 10) / 10;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: number | undefined;
  let n = 0;
  for (const [d, c] of counts) if (c > n) [best, n] = [d, c];
  return best;
}

/**
 * となりの行へ動く（縦組みでは左右、横組みでは上下の矢印）。dir は +1 で次の行（縦組みでは左、横組みでは下）。
 * となりの行のうち、今のカーソルの高さ（横組みでは横の位置）にいちばん近い字の前に置く。
 * 行がカーソルより短ければ、その行の最後の字のあと。このページにとなりの行がなければ undefined。
 */
export function moveLine(page: DrawPage, caret: Caret, dir: 1 | -1, vertical: boolean): Src | undefined {
  const items = sourceItems(page);
  // 行の位置（縦組みは x の中心、横組みは y の中心）と、行の中の位置（縦組みは y、横組みは x）。
  const across = (b: Box) => (vertical ? (b.x0 + b.x1) / 2 : (b.y0 + b.y1) / 2);
  const along = (b: Box) => (vertical ? (b.y0 + b.y1) / 2 : (b.x0 + b.x1) / 2);
  const here = vertical ? caret.x + caret.w / 2 : caret.y + caret.h / 2;
  const at = vertical ? caret.y : caret.x;
  // 次の行：縦組みでは左（x が小さい）、横組みでは下（y が大きい）。
  const forward = vertical ? -dir : dir;
  const gap = caret.size / 2;
  let target: number | undefined;
  for (const it of items) {
    const c = across(itemBox(it));
    if ((c - here) * forward <= gap) continue;
    if (target === undefined || Math.abs(c - here) < Math.abs(target - here)) target = c;
  }
  if (target === undefined) return undefined;
  const line = items.filter((it) => Math.abs(across(itemBox(it)) - target) <= gap);
  const last = line[line.length - 1];
  // カーソルより先にある最初の字の前。なければ行の最後の字のあと。
  const hit = line.find((it) => along(itemBox(it)) >= at);
  if (hit) return [hit.src[0], hit.src[1]];
  return [last.src[0], last.src[1] + last.text.length];
}

/** 原稿の中で1字前・1字あとへ動く（行をまたぐ）。サロゲートペアは1字として扱う。 */
export function moveChar(lines: string[], src: Src, dir: 1 | -1): Src {
  const [line, offset] = src;
  const text = lines[line] ?? "";
  if (dir < 0) {
    if (offset > 0) return [line, offset - (offset >= 2 && isLow(text.charCodeAt(offset - 1)) && isHigh(text.charCodeAt(offset - 2)) ? 2 : 1)];
    return line > 0 ? [line - 1, (lines[line - 1] ?? "").length] : src;
  }
  if (offset < text.length) return [line, offset + (isHigh(text.charCodeAt(offset)) && isLow(text.charCodeAt(offset + 1)) ? 2 : 1)];
  return line < lines.length - 1 ? [line + 1, 0] : src;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** 原稿に text を入れたあとのカーソル（入れた文字のあと）。 */
export function afterInsert(src: Src, text: string): Src {
  const parts = text.split("\n");
  if (parts.length === 1) return [src[0], src[1] + text.length];
  return [src[0] + parts.length - 1, parts[parts.length - 1].length];
}
