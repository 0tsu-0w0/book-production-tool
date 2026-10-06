import {
  setFillingCmykColor,
  setFillingGrayscaleColor,
  setFillingRgbColor,
  setStrokingCmykColor,
  setStrokingGrayscaleColor,
  setStrokingRgbColor,
  type PDFOperator,
} from "pdf-lib";
import { hexToCmyk, hexToGray } from "../engine/ink-color.js";
import { parseHex } from "../engine/decorate.js";

export type ColorMode = "cmyk" | "gray" | "rgb";

// 色の変換の式は、画面の分版プレビューと共用する（engine/ink-color.ts）。
export { hexToCmyk, hexToGray } from "../engine/ink-color.js";

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
