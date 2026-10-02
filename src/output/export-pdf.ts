import { imageInfos, type DocImage } from "../document/document.js";
import { leftBound, saddleOutput, spreadOutput, type PdfKind, type Settings } from "../document/settings.js";
import { Face, typeset } from "../engine/index.js";
import { checkPdfX, type CheckItem } from "./check-pdfx.js";
import { imposeSaddle, imposeSpreads } from "./imposition.js";
import { PRINT_PDF, SCREEN_PDF, renderPdf, type PdfOptions } from "./pdf.js";

export const PDF_KINDS: Record<PdfKind, Omit<PdfOptions, "title">> = {
  print: PRINT_PDF,
  "print-nomarks": { ...PRINT_PDF, marks: false },
  screen: SCREEN_PDF,
};

export interface PdfExportResult {
  bytes: Uint8Array;
  pages: number;
  /** 入稿用のときの PDF/X の検査結果。 */
  check?: CheckItem[];
  /** 検査した PDF/X の版。 */
  standard?: "x1a" | "x4";
}

/** 原稿と設定から PDF を作り、入稿用なら検査もする。 */
export async function exportPdf(
  text: string,
  settings: Settings,
  fonts: { key: string; bytes: Uint8Array }[],
  title: string,
  onProgress?: (done: number, total: number) => void,
  images: DocImage[] = [],
  icc?: Uint8Array,
): Promise<PdfExportResult> {
  const table = { faces: fonts.map((f) => new Face(f.bytes)), keys: fonts.map((f) => f.key) };
  const typeset_ = typeset(text, settings, table, imageInfos(images));
  const options = { ...pdfOptions(settings, title), icc };
  // 見開き・中綴じ（閲覧用だけ）：2ページを1枚に並べる。
  const pages = spreadOutput(settings, "pdf")
    ? imposeSpreads(typeset_.pages, settings.nombreStart, leftBound(settings)).pages
    : saddleOutput(settings) && typeset_.pages.length > 0
      ? imposeSaddle(typeset_.pages, settings.nombreStart, leftBound(settings)).pages
      : typeset_.pages;
  const sources = images.map((i) => ({ name: i.name, mime: i.mime, bytes: Buffer.from(i.data, "base64") }));
  const bytes = await renderPdf(pages, fonts.map((f) => f.bytes), options, onProgress, sources);
  if (!options.pdfx) return { bytes, pages: pages.length };
  const standard = options.standard ?? "x1a";
  return { bytes, pages: pages.length, check: await checkPdfX(bytes, standard), standard };
}

/** PDF の種類と色の設定から、書き出しの指定を作る。グレースケールは入稿用・閲覧用のどちらでも使える（OUT-03）。 */
export function pdfOptions(settings: Settings, title: string): PdfOptions {
  const base = PDF_KINDS[settings.pdfKind];
  // 塗り足しは詳細設定の値（入稿用だけ。閲覧用は塗り足しなし）。
  const bleedMm = base.pdfx ? settings.advanced.bleedMm : base.bleedMm;
  return {
    ...base,
    bleedMm,
    color: settings.output.color === "gray" ? "gray" : base.color,
    title,
    imagePpi: settings.advanced.imagePpi,
    standard: base.pdfx ? settings.output.pdfStandard : undefined,
    // アウトライン化は入稿用だけ（閲覧用で文字を図形にすると、検索もコピーもできなくなるため）。
    outline: base.pdfx && settings.output.outline,
  };
}
