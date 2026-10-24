import { parentPort } from "node:worker_threads";
import { processImage, type ImageJob } from "./pdf-images.js";

// 入稿用 PDF の画像を、別のスレッドで処理する（#18）。1枚ずつ受け取り、処理した結果を返す。
parentPort!.on("message", (job: ImageJob) => {
  try {
    const r = processImage(job);
    parentPort!.postMessage(r, r.streams.map((s) => s.buffer as ArrayBuffer));
  } catch (e) {
    parentPort!.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
});
