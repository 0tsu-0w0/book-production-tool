import type { DrawItem, DrawPage } from "./types.js";

// 画面へ送るページの、詰めた形（#11）。
// ページの字（DrawItem）は1ページに千ほどあり、字形の並びや原稿の位置も合わせると数千の小さなオブジェクトになる。
// 組版のプロセスから画面へは、プロセスの間と画面の仕切り（contextBridge）で2回まるごと写されるので、
// 数は1本の数の並び（Float64Array）に、字と色は1つの文字列と表にまとめて送り、画面で元の形に戻す。

/** 1つの字の数の並び（ITEM_FIELDS 個ずつ）：x・y・大きさ・sx・sy・書体・印・色・原稿の行・原稿の位置・字形の始まり・字形の数。 */
const ITEM_FIELDS = 12;
const ROTATE = 1;
const BOLD = 2;
const VERT = 4;
const HAS_SY = 8;
const HAS_SRC = 16;
/** 字の区切り（字の中には出てこない字）。 */
const SEP = "\u0000";

export interface PackedItems {
  count: number;
  /** 字ごとの数（ITEM_FIELDS 個ずつ）。 */
  nums: Float64Array;
  /** 字形：番号と送りのずれを交互に。 */
  glyphs: Float64Array;
  /** 字（SEP でつないだもの）。 */
  text: string;
  /** 色の表。 */
  colors: string[];
}

/** sig はページの中身の指紋（同じなら、描いた絵をそのまま使える）。 */
export type PackedPage = Omit<DrawPage, "items"> & { items: PackedItems; sig: string };

/** 中身の指紋（FNV-1a、32ビットを2つ）：字の数・字形・字と色、図形などの残り。 */
function signature(items: PackedItems, rest: Omit<DrawPage, "items">): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  const mix = (v: number) => {
    a = Math.imul(a ^ v, 0x01000193) >>> 0;
    b = Math.imul(b ^ v ^ (a >>> 7), 0x5bd1e995) >>> 0;
  };
  for (const arr of [items.nums, items.glyphs]) {
    const words = new Uint32Array(arr.buffer, arr.byteOffset, arr.length * 2);
    for (let i = 0; i < words.length; i++) mix(words[i]);
  }
  const str = items.text + "\u0001" + items.colors.join("\u0001") + "\u0001" + JSON.stringify(rest);
  for (let i = 0; i < str.length; i++) mix(str.charCodeAt(i));
  return `${a.toString(36)}.${b.toString(36)}`;
}

export function packItems(items: DrawItem[]): PackedItems {
  const nums = new Float64Array(items.length * ITEM_FIELDS);
  let glyphCount = 0;
  for (const it of items) glyphCount += it.glyphs.length;
  const glyphs = new Float64Array(glyphCount * 2);
  const colors: string[] = [];
  const colorIndex = new Map<string, number>();
  const texts: string[] = [];
  let g = 0;
  items.forEach((it, i) => {
    let c = colorIndex.get(it.color);
    if (c === undefined) {
      c = colors.length;
      colors.push(it.color);
      colorIndex.set(it.color, c);
    }
    const o = i * ITEM_FIELDS;
    nums[o] = it.x;
    nums[o + 1] = it.y;
    nums[o + 2] = it.size;
    nums[o + 3] = it.sx;
    nums[o + 4] = it.sy ?? 1;
    nums[o + 5] = it.face;
    nums[o + 6] = (it.rotate ? ROTATE : 0) | (it.bold ? BOLD : 0) | (it.font === "vert" ? VERT : 0) | (it.sy !== undefined ? HAS_SY : 0) | (it.src ? HAS_SRC : 0);
    nums[o + 7] = c;
    nums[o + 8] = it.src?.[0] ?? 0;
    nums[o + 9] = it.src?.[1] ?? 0;
    nums[o + 10] = g / 2;
    nums[o + 11] = it.glyphs.length;
    for (const gl of it.glyphs) {
      glyphs[g++] = gl.gid;
      glyphs[g++] = gl.dx;
    }
    texts.push(it.text);
  });
  return { count: items.length, nums, glyphs, text: texts.join(SEP), colors };
}

export function unpackItems(p: PackedItems): DrawItem[] {
  const { nums, glyphs, colors } = p;
  const texts = p.count > 0 ? p.text.split(SEP) : [];
  const out: DrawItem[] = new Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const o = i * ITEM_FIELDS;
    const flags = nums[o + 6];
    const start = nums[o + 10] * 2;
    const n = nums[o + 11];
    const gl = new Array<{ gid: number; dx: number }>(n);
    for (let k = 0; k < n; k++) gl[k] = { gid: glyphs[start + k * 2], dx: glyphs[start + k * 2 + 1] };
    const it: DrawItem = { font: flags & VERT ? "vert" : "horiz", text: texts[i], glyphs: gl, x: nums[o], y: nums[o + 1], size: nums[o + 2], sx: nums[o + 3], color: colors[nums[o + 7]], face: nums[o + 5] };
    if (flags & HAS_SY) it.sy = nums[o + 4];
    if (flags & ROTATE) it.rotate = true;
    if (flags & BOLD) it.bold = true;
    if (flags & HAS_SRC) it.src = [nums[o + 8], nums[o + 9]];
    out[i] = it;
  }
  return out;
}

export function packPage(page: DrawPage): PackedPage {
  const { items, ...rest } = page;
  const packed = packItems(items);
  return { ...rest, items: packed, sig: signature(packed, rest) };
}

/** 詰めた形を戻す。指紋は sig に残す（描いた絵を使い回すのに使う）。 */
export function unpackPage(page: PackedPage): DrawPage & { sig: string } {
  return { ...page, items: unpackItems(page.items) };
}
