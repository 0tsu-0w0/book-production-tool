import { parseHex } from "./decorate.js";

// 画面の色（RGB）と、印刷のインキ（CMYK・グレー）の変換。カラーマネジメントをしない単純な式。
// 入稿用 PDF の色の変換と、画面の分版プレビューで同じ式を使う（PDF の部品に頼らないので、画面からも読める）。

/**
 * 画面の色（RGB）を CMYK（0〜1）にする。
 * 無彩色（R=G=B）は K だけになるので、黒の文字は K100% になる。
 */
export function hexToCmyk(hex: string): [number, number, number, number] {
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  return rgbToCmyk(r, g, b);
}

/** RGB（0〜1）を CMYK（0〜1。小数3桁に丸める）にする。 */
export function rgbToCmyk(r: number, g: number, b: number): [number, number, number, number] {
  const k = 1 - Math.max(r, g, b);
  if (k >= 1 - 1e-9) return [0, 0, 0, 1];
  const c = (1 - r - k) / (1 - k);
  const m = (1 - g - k) / (1 - k);
  const y = (1 - b - k) / (1 - k);
  return [c, m, y, k].map((v) => Math.round(v * 1000) / 1000) as [number, number, number, number];
}

/** 画面の色の明るさ（0〜1。グレースケールで書き出すときの濃さは 1 − これ）。 */
export function hexToGray(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  return Math.round((0.299 * r + 0.587 * g + 0.114 * b) * 1000) / 1000;
}

/** CMYK（0〜1）で刷った色を、画面の色（RGB 0〜255）にする（インキが紙に重なる見え方の、単純な近似）。 */
export function cmykToRgb(c: number, m: number, y: number, k: number): [number, number, number] {
  return [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)].map((v) => Math.round(v)) as [number, number, number];
}
