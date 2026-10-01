import { parentPort, workerData } from "node:worker_threads";
import type { DocImage } from "./document/document.js";
import type { Settings } from "./document/settings.js";
import { exportPdf } from "./output/export-pdf.js";

// PDF の書き出しを別スレッドで行う（NF-04）。書き出している間も画面を操作できる。

export interface PdfWorkerInput {
  text: string;
  settings: Settings;
  /** 先頭が本文の書体。key はスタイルがフォントを指すときのキー。 */
  fonts: { key: string; bytes: Uint8Array }[];
  title: string;
  images: DocImage[];
  /** PDF/X-4 の印刷条件の ICC プロファイル。 */
  icc?: Uint8Array;
}

export type PdfWorkerMessage =
  | { type: "progress"; done: number; total: number }
  | { type: "done"; result: Awaited<ReturnType<typeof exportPdf>> }
  | { type: "error"; message: string };

const input = workerData as PdfWorkerInput;
const send = (msg: PdfWorkerMessage) => parentPort!.postMessage(msg);

try {
  const result = await exportPdf(
    input.text,
    input.settings,
    input.fonts,
    input.title,
    (done, total) => {
      if (done === total || done % 5 === 0) send({ type: "progress", done, total });
    },
    input.images,
    input.icc,
  );
  send({ type: "done", result });
} catch (err) {
  send({ type: "error", message: err instanceof Error ? err.message : String(err) });
}
