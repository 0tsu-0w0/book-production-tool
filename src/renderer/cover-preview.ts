import type { DrawPage } from "../engine/types.js";
import { canvasSize, drawPage, type DrawFont } from "./draw.js";

// 設定欄の「表紙」：表紙（表1・背・表4）の見本と、表紙の PDF の書き出し。

export interface CoverPreviewData {
  page: DrawPage;
  spineMm: number;
  widthMm: number;
  heightMm: number;
  fonts: DrawFont[];
}

export interface CoverPreviewHost {
  /** 今の設定で表紙を組む（字形の輪郭も受け取っておく）。 */
  load(): Promise<CoverPreviewData | undefined>;
  images(): Map<string, CanvasImageSource>;
  exportPdf(): void;
}

export class CoverPreview {
  private readonly canvas = document.createElement("canvas");
  private readonly info = document.createElement("div");
  private seq = 0;
  private timer: number | undefined;

  constructor(private readonly host: CoverPreviewHost) {
    this.canvas.className = "cover-preview";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "表紙の見本");
    this.info.className = "computed";
  }

  /** 設定欄に入れる部品（設定欄を作り直すたびに呼ばれる）。 */
  element(): HTMLElement {
    const box = document.createElement("div");
    box.className = "fields";
    box.style.padding = "0";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "表紙を PDF に書き出す…";
    button.addEventListener("click", () => this.host.exportPdf());
    box.append(this.canvas, this.info, button);
    this.update();
    return box;
  }

  /** 少し待ってから描き直す（設定を続けて変えている間は描かない）。 */
  update() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.draw(), 150);
  }

  private async draw() {
    if (!this.canvas.isConnected) return;
    const seq = ++this.seq;
    const r = await this.host.load();
    if (!r || seq !== this.seq) return;
    const width = Math.max(200, (this.canvas.parentElement?.clientWidth ?? 260) - 4);
    const dpr = window.devicePixelRatio || 1;
    const bleed = 3 * (72 / 25.4);
    const pxPerPt = ((width / (r.page.width + bleed * 2)) * dpr);
    const opts = { pxPerPt, bleedPt: bleed, guides: true, images: this.host.images() };
    const size = canvasSize(r.page, opts);
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    this.canvas.style.width = `${size.width / dpr}px`;
    this.canvas.style.height = `${size.height / dpr}px`;
    drawPage(this.canvas.getContext("2d")!, r.page, r.fonts, opts);
    this.info.textContent = `表紙の大きさ ${r.widthMm.toFixed(1)}×${r.heightMm.toFixed(1)}mm（背幅 ${r.spineMm.toFixed(1)}mm）。塗り足しは書き出しの設定のとおり。`;
  }
}
