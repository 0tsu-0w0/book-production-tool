import os from "node:os";
import { Worker } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { PDFDocument, PDFName, type PDFRef } from "pdf-lib";
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
  try {
    if (src.mime === "image/jpeg") {
      const img = jpeg.decode(src.bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
      return { width: img.width, height: img.height, data: img.data };
    }
    const png = PNG.sync.read(Buffer.from(src.bytes));
    return { width: png.width, height: png.height, data: png.data };
  } catch (e) {
    // 壊れた画像：どの画像かを知らせる（読み込みの道具の知らせだけでは分からないため）。
    throw new Error(`画像「${src.name}」を読めません（ファイルが壊れているかもしれません）：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 面積の平均で縮める（細い線がちらつかないよう、最近傍ではなく平均を取る）。 */
export function downsample(r: Raster, width: number, height: number): Raster {
  const out = new Uint8Array(width * height * 4);
  const sx = r.width / width;
  const sy = r.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      // 画素ごとに配列を作らず、4つの和を変数で持つ（#18。大きな写真で3倍ほど速い）。
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * r.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          s0 += r.data[i];
          s1 += r.data[i + 1];
          s2 += r.data[i + 2];
          s3 += r.data[i + 3];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      out[o] = Math.round(s0 / n);
      out[o + 1] = Math.round(s1 / n);
      out[o + 2] = Math.round(s2 / n);
      out[o + 3] = Math.round(s3 / n);
    }
  }
  return { width, height, data: out };
}

/**
 * 白の紙（matte があればその色）の上に重ねて、CMYK（4バイト）かグレー（1バイト）の画素の並びにする。
 * 式は文字の色の変換と同じ。
 */
export function toDeviceColor(r: Raster, mode: "cmyk" | "gray", matte = "#ffffff"): Uint8Array {
  const n = r.width * r.height;
  const out = new Uint8Array(n * (mode === "cmyk" ? 4 : 1));
  const [mr, mg, mb] = [1, 3, 5].map((k) => parseInt(matte.slice(k, k + 2), 16));
  for (let i = 0; i < n; i++) {
    const a = r.data[i * 4 + 3] / 255;
    const red = (r.data[i * 4] * a + mr * (1 - a)) / 255;
    const green = (r.data[i * 4 + 1] * a + mg * (1 - a)) / 255;
    const blue = (r.data[i * 4 + 2] * a + mb * (1 - a)) / 255;
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
/** その画像を置いた所の、透明な部分の下の色（undefined は白の紙）。 */
function mattesOf(pages: DrawPage[], name: string): (string | undefined)[] {
  const out = new Set<string | undefined>();
  for (const page of pages) for (const s of page.shapes) if (s.kind === "image" && s.name === name) out.add(s.matte);
  return [...out];
}

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

/** 画像の参照の鍵：名前と、透明な部分の下の色（同じ画像でも下の色が違えば別に入れる）。 */
export function imageKey(name: string, matte?: string): string {
  return matte ? `${name}|${matte}` : name;
}

/** 1枚の画像の処理（読む・縮める・下の色ごとに CMYK かグレーにして圧縮する）。別のスレッドでも使う。 */
export interface ImageJob {
  src: PdfImageSource;
  /** 紙の上でいちばん大きく置かれる幅と高さ（pt）。 */
  placed: { w: number; h: number };
  targetPpi: number;
  mode: "cmyk" | "gray";
  mattes: (string | undefined)[];
}

export interface ImageResult {
  width: number;
  height: number;
  /** mattes の順の、圧縮した（FlateDecode）画素の並び。 */
  streams: Uint8Array[];
}

export function processImage(job: ImageJob): ImageResult {
  let raster = decodeImage(job.src);
  const ppi = Math.min(raster.width / (job.placed.w / 72), raster.height / (job.placed.h / 72));
  if (ppi > job.targetPpi * 1.125) {
    const f = job.targetPpi / ppi;
    raster = downsample(raster, Math.max(1, Math.round(raster.width * f)), Math.max(1, Math.round(raster.height * f)));
  }
  return { width: raster.width, height: raster.height, streams: job.mattes.map((m) => new Uint8Array(deflateSync(toDeviceColor(raster, job.mode, m)))) };
}

/**
 * 画像をまとめて処理する。2枚以上なら、CPU の数（最大4）のスレッドで並べて処理する（#18。写真の多い本で JPEG を読むのに時間がかかるため。
 * 4000×3000 の写真40枚の本で、処理が1本の約55秒から4本で約24秒に。メモリは約 0.4GB 増える）。
 * スレッドを作れなければ、このスレッドで1枚ずつ。
 */
async function processImages(jobs: ImageJob[]): Promise<ImageResult[]> {
  const threads = Math.min(4, Math.max(1, os.availableParallelism() - 1), jobs.length);
  if (threads < 2) return jobs.map(processImage);
  const results: ImageResult[] = new Array(jobs.length);
  let next = 0;
  const run = () =>
    new Promise<void>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL("./image-worker.js", import.meta.url));
      } catch (e) {
        reject(e);
        return;
      }
      let current = -1;
      const give = () => {
        if (next >= jobs.length) {
          void worker.terminate();
          resolve();
          return;
        }
        current = next++;
        worker.postMessage(jobs[current]);
      };
      worker.on("message", (r: ImageResult | { error: string }) => {
        if ("error" in r) {
          void worker.terminate();
          reject(new Error(r.error));
          return;
        }
        results[current] = r;
        give();
      });
      worker.on("error", reject);
      give();
    });
  try {
    await Promise.all(Array.from({ length: threads }, run));
  } catch (e) {
    // スレッドで処理できなければ（スレッドのファイルが読めないなど）、このスレッドで1枚ずつ。壊れた画像の知らせはそのまま。
    if (e instanceof Error && e.message.startsWith("画像「")) throw e;
    return jobs.map(processImage);
  }
  return results;
}

/** 使う画像を PDF に入れ、名前（と下の色。imageKey）から PDF の参照を引けるようにする。 */
export async function embedImages(
  doc: PDFDocument,
  sources: PdfImageSource[],
  pages: DrawPage[],
  mode: ColorMode,
  targetPpi = DEFAULT_TARGET_PPI,
): Promise<Map<string, PDFRef>> {
  const sizes = placedSizes(pages);
  const refs = new Map<string, PDFRef>();
  const jobs: ImageJob[] = [];
  for (const src of sources) {
    const placed = sizes.get(src.name);
    if (!placed) continue; // 原稿で使っていない画像は入れない。
    if (mode === "rgb") {
      // pdf-lib は、バイト列の領域（buffer）の頭から読む。Buffer.from(…, "base64") の小さなバイト列は Node の共有の領域の途中にあるので、
      // そのまま渡すと別の場所を読んでしまう（JPEG の始まりが見つからない）。自分だけの領域に写してから渡す。
      const bytes = new Uint8Array(src.bytes);
      const img = src.mime === "image/jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
      refs.set(src.name, img.ref);
      continue;
    }
    jobs.push({ src: { name: src.name, mime: src.mime, bytes: src.bytes }, placed, targetPpi, mode, mattes: mattesOf(pages, src.name) });
  }
  // 処理は並べて、PDF には元の順に入れる（書き出すたびに同じ PDF になるように）。
  const results = await processImages(jobs);
  jobs.forEach((job, i) => {
    const r = results[i];
    job.mattes.forEach((matte, k) => {
      const stream = doc.context.stream(r.streams[k], {
        Type: "XObject",
        Subtype: "Image",
        Width: r.width,
        Height: r.height,
        ColorSpace: mode === "cmyk" ? "DeviceCMYK" : "DeviceGray",
        BitsPerComponent: 8,
        Filter: PDFName.of("FlateDecode"),
      });
      refs.set(imageKey(job.src.name, matte), doc.context.register(stream));
    });
  });
  return refs;
}
