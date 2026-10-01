import type { DrawPage } from "../engine/types.js";
import { GlyphPaths, canvasSize, drawPage } from "./draw.js";

// 画像の書き出し（OUT-06/07）を画面の裏で行う。1ページ描くごとにバイト列を返す。

export interface ExportRequest {
  pages: DrawPage[];
  /** フォントごとの輪郭と 1em の大きさ（DrawItem.face の番号順）。 */
  fonts: { paths: Record<number, string>; upem: number }[];
  dpi: number;
  format: "png" | "jpeg";
  jpegQuality: number;
  /** グレースケールにする（OUT-03）。 */
  gray: boolean;
  /** 画像の名前（pages と同じ並び）。 */
  names: string[];
  /** 文書の画像（ページに置くもの）。 */
  images: { name: string; mime: string; bytes: ArrayBuffer }[];
}

export type ExportMessage =
  | { type: "page"; name: string; bytes: ArrayBuffer }
  | { type: "done" }
  | { type: "error"; message: string };

const post = (msg: ExportMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<ExportRequest>) => {
  const req = e.data;
  try {
    const fonts = req.fonts.map((f) => {
      const paths = new GlyphPaths();
      paths.add(f.paths);
      return { paths, upem: f.upem };
    });
    const images = new Map<string, CanvasImageSource>();
    for (const img of req.images) {
      try {
        images.set(img.name, await createImageBitmap(new Blob([img.bytes], { type: img.mime })));
      } catch {
        // 読めない画像は枠だけ描く。
      }
    }
    const opts = { pxPerPt: req.dpi / 72, images };
    for (const [n, page] of req.pages.entries()) {
      const { width, height } = canvasSize(page, opts);
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d")!;
      drawPage(ctx, page, fonts, opts);
      if (req.gray) toGray(ctx, width, height);
      const blob = await canvas.convertToBlob(
        req.format === "jpeg" ? { type: "image/jpeg", quality: req.jpegQuality } : { type: "image/png" },
      );
      const bytes = await blob.arrayBuffer();
      post({ type: "page", name: req.names[n], bytes }, [bytes]);
    }
    post({ type: "done" });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

/** 描いた画像を輝度（Rec. 601）でグレーにする。PDF のグレースケールと同じ式。 */
function toGray(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number) {
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
}
