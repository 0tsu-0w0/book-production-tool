import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { PDFDocument, type PDFRef } from "pdf-lib";
import type { DrawPage } from "../engine/types.js";
import type { ColorMode } from "./color.js";

// PDF に画像を入れる（DTP-12）。
// 入稿用（PDF/X-1a）では RGB の画像も透明も使えないので、画素を読んで白の紙の上に重ね（透明をなくし）、
// CMYK かグレーに変換して入れる。閲覧用（RGB）は元のファイルをそのまま入れる。
// 印刷に要る解像度よりずっと細かい画像は、PDF が大きくなりすぎないよう縮める。

export interface PdfImageSource {
  name: string;
  mime: "image/png" | "image/jpeg";
  bytes: Uint8Array;
}

/** 既定では、450ppi より細かい画像を 400ppi に縮める（目標の 1.125 倍を超えたら縮める）。 */
const DEFAULT_TARGET_PPI = 400;

interface Raster {
  width: number;
  height: number;
  /** RGBA。 */
  data: Uint8Array;
}

export function decodeImage(src: PdfImageSource): Raster {
  if (src.mime === "image/jpeg") {
    const img = jpeg.decode(src.bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    return { width: img.width, height: img.height, data: img.data };
  }
  const png = PNG.sync.read(Buffer.from(src.bytes));
  return { width: png.width, height: png.height, data: png.data };
}

/** 面積の平均で縮める（細い線がちらつかないよう、最近傍ではなく平均を取る）。 */
function downsample(r: Raster, width: number, height: number): Raster {
  const out = new Uint8Array(width * height * 4);
  const sx = r.width / width;
  const sy = r.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const sum = [0, 0, 0, 0];
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * r.width + xx) * 4;
          for (let c = 0; c < 4; c++) sum[c] += r.data[i + c];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(sum[c] / n);
    }
  }
  return { width, height, data: out };
}

/** 白の紙の上に重ねて、CMYK（4バイト）かグレー（1バイト）の画素の並びにする。式は文字の色の変換と同じ。 */
export function toDeviceColor(r: Raster, mode: "cmyk" | "gray"): Uint8Array {
  const n = r.width * r.height;
  const out = new Uint8Array(n * (mode === "cmyk" ? 4 : 1));
  for (let i = 0; i < n; i++) {
    const a = r.data[i * 4 + 3] / 255;
    const red = (r.data[i * 4] * a + 255 * (1 - a)) / 255;
    const green = (r.data[i * 4 + 1] * a + 255 * (1 - a)) / 255;
    const blue = (r.data[i * 4 + 2] * a + 255 * (1 - a)) / 255;
    if (mode === "gray") {
      out[i] = Math.round((0.299 * red + 0.587 * green + 0.114 * blue) * 255);
      continue;
    }
    const k = 1 - Math.max(red, green, blue);
    const d = 1 - k;
    const o = i * 4;
    if (d < 1e-9) {
      out[o + 3] = 255;
      continue;
    }
    out[o] = Math.round(((1 - red - k) / d) * 255);
    out[o + 1] = Math.round(((1 - green - k) / d) * 255);
    out[o + 2] = Math.round(((1 - blue - k) / d) * 255);
    out[o + 3] = Math.round(k * 255);
  }
  return out;
}

/** 各画像が紙の上でいちばん大きく置かれる幅と高さ（pt）。縮める目安にする。 */
export function placedSizes(pages: DrawPage[]): Map<string, { w: number; h: number }> {
  const out = new Map<string, { w: number; h: number }>();
  for (const page of pages) {
    for (const s of page.shapes) {
      if (s.kind !== "image") continue;
      const prev = out.get(s.name);
      out.set(s.name, { w: Math.max(prev?.w ?? 0, s.w), h: Math.max(prev?.h ?? 0, s.h) });
    }
  }
  return out;
}

/** 使う画像を PDF に入れ、名前から PDF の参照を引けるようにする。 */
export async function embedImages(
  doc: PDFDocument,
  sources: PdfImageSource[],
  pages: DrawPage[],
  mode: ColorMode,
  targetPpi = DEFAULT_TARGET_PPI,
): Promise<Map<string, PDFRef>> {
  const sizes = placedSizes(pages);
  const refs = new Map<string, PDFRef>();
  for (const src of sources) {
    const placed = sizes.get(src.name);
    if (!placed) continue; // 原稿で使っていない画像は入れない。
    if (mode === "rgb") {
      const img = src.mime === "image/jpeg" ? await doc.embedJpg(src.bytes) : await doc.embedPng(src.bytes);
      refs.set(src.name, img.ref);
      continue;
    }
    let raster = decodeImage(src);
    const ppi = Math.min(raster.width / (placed.w / 72), raster.height / (placed.h / 72));
    if (ppi > targetPpi * 1.125) {
      const f = targetPpi / ppi;
      raster = downsample(raster, Math.max(1, Math.round(raster.width * f)), Math.max(1, Math.round(raster.height * f)));
    }
    const stream = doc.context.flateStream(toDeviceColor(raster, mode), {
      Type: "XObject",
      Subtype: "Image",
      Width: raster.width,
      Height: raster.height,
      ColorSpace: mode === "cmyk" ? "DeviceCMYK" : "DeviceGray",
      BitsPerComponent: 8,
    });
    refs.set(src.name, doc.context.register(stream));
  }
  return refs;
}
