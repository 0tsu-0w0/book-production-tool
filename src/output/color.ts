import {
  setFillingCmykColor,
  setFillingGrayscaleColor,
  setFillingRgbColor,
  setStrokingCmykColor,
  setStrokingGrayscaleColor,
  setStrokingRgbColor,
  type PDFOperator,
} from "pdf-lib";
import { parseHex } from "../engine/decorate.js";

export type ColorMode = "cmyk" | "gray" | "rgb";

/**
 * 画面の色（RGB）を CMYK にする。カラーマネジメントをしない単純な式。
 * 無彩色（R=G=B）は K だけになるので、黒の文字は K100% になる。
 */
export function hexToCmyk(hex: string): [number, number, number, number] {
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  const k = 1 - Math.max(r, g, b);
  if (k >= 1 - 1e-9) return [0, 0, 0, 1];
  const c = (1 - r - k) / (1 - k);
  const m = (1 - g - k) / (1 - k);
  const y = (1 - b - k) / (1 - k);
  return [c, m, y, k].map((v) => Math.round(v * 1000) / 1000) as [number, number, number, number];
}

export function hexToGray(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  return Math.round((0.299 * r + 0.587 * g + 0.114 * b) * 1000) / 1000;
}

export function fillColor(hex: string, mode: ColorMode): PDFOperator {
  if (mode === "cmyk") return setFillingCmykColor(...hexToCmyk(hex));
  if (mode === "gray") return setFillingGrayscaleColor(hexToGray(hex));
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  return setFillingRgbColor(r, g, b);
}

export function strokeColor(hex: string, mode: ColorMode): PDFOperator {
  if (mode === "cmyk") return setStrokingCmykColor(...hexToCmyk(hex));
  if (mode === "gray") return setStrokingGrayscaleColor(hexToGray(hex));
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  return setStrokingRgbColor(r, g, b);
}
