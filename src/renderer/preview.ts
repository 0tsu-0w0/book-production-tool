import type { DrawItem, DrawPage } from "../engine/types.js";
import type { InkPreview } from "./ink-preview.js";
import { canvasSize, drawPage, type DrawFont } from "./draw.js";

// プレビュー（OUT-01）。1ページ・見開き・一覧の3つの表示を切り替える。
// 全ページは本体（main）が持っていて、ここには表示に必要なページだけを取り寄せる。

export type ViewMode = "single" | "spread" | "grid";

/** ページを取り寄せる。組み直しで版が変わっていたら null。 */
export type PageFetcher = (version: number, indices: number[]) => Promise<DrawPage[] | null>;

const MM_PT = 72 / 25.4;

/**
 * (x, y)（pt）にいちばん近い、原稿の位置を持つ字。字の原点はベースラインにあるので、
 * 字面の中心をベースラインから 0.38em 上とみなす。1字分より遠ければ選ばない。
 */
export function pickItem(page: DrawPage, x: number, y: number): DrawItem | undefined {
  let best: DrawItem | undefined;
  let bestD = Infinity;
  for (const it of page.items) {
    if (!it.src) continue;
    const cx = it.rotate ? it.x - it.size * 0.38 : it.x + (it.size * (it.font === "horiz" ? Math.max(1, [...it.text].length) * 0.5 : 1)) / 2;
    const cy = it.rotate ? it.y + it.size / 2 : it.y - it.size * 0.38;
    const d = Math.hypot(cx - x, cy - y);
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return best && bestD <= best.size * 0.9 ? best : undefined;
}

export class Preview {
  mode: ViewMode = "single";
  guides = false;
  /** 文書の画像（名前で引く）。 */
  images = new Map<string, CanvasImageSource>();
  /** 左綴じ（横組み）：見開きの左に偶数ページ、右に奇数ページを置く。 */
  leftBound = false;
  /** 仕上がり線と塗り足しを見せるときの塗り足しの幅（mm）。 */
  bleedMm = 3;
  /** 分版プレビュー（選んだ版だけで刷った見え方）。null なら画面の色のまま。 */
  ink: InkPreview | null = null;
  /** 紙面の字をクリック・ダブルクリックしたとき（原稿のその場所を開く。DTP-15）。 */
  onPick?: (item: DrawItem, ev: MouseEvent, double: boolean) => void;
  /** キャンバスごとに、描いたページと縮尺を覚えておく（クリックした字を探すため）。 */
  private readonly drawn = new WeakMap<HTMLCanvasElement, { page: DrawPage; pxPerPt: number; bleed: number }>();
  private version = 0;
  private pageCount = 0;
  private readonly cache = new Map<number, DrawPage>();
  private fonts: DrawFont[] = [];
  private current = 0;
  /** 1ページ目のページ番号。見開きの組み合わせ（偶数ページが右）を決めるのに使う。 */
  private firstNumber = 1;
  /** ページの大きさ（どのページも同じ）。 */
  private pageSize = { width: 297.64, height: 419.53 };
  private observer: IntersectionObserver | undefined;
  private showSeq = 0;

  constructor(
    private readonly stage: HTMLElement,
    private readonly label: HTMLElement,
    private readonly fetchPages: PageFetcher,
  ) {
    // 表示欄の大きさは、変わったときだけ受け取って覚えておく。描くたびに測ると、そのつどレイアウトをやり直させてしまう。
    // 窓や欄の大きさが変わったら、その大きさで描き直す。
    new ResizeObserver((entries) => {
      const box = entries[entries.length - 1].borderBoxSize[0];
      if (!box) return;
      const changed = this.stageSize !== undefined && (this.stageSize.width !== box.inlineSize || this.stageSize.height !== box.blockSize);
      this.stageSize = { width: box.inlineSize, height: box.blockSize };
      if (changed && this.mode !== "grid") this.show();
    }).observe(stage);
  }

  /** 表示欄の大きさ（px）。ResizeObserver が最初に知らせるまでは測る。 */
  private stageSize: { width: number; height: number } | undefined;

  /** 組み直しの結果を受け取る。initial は、組み直しと一緒に届いたページ。 */
  setDocument(version: number, pageCount: number, fonts: DrawFont[], firstNumber: number, initial: DrawPage[]) {
    this.version = version;
    this.pageCount = pageCount;
    this.fonts = fonts;
    this.firstNumber = firstNumber;
    this.cache.clear();
    for (const p of initial) this.cache.set(p.index, p);
    if (initial[0]) this.pageSize = { width: initial[0].width, height: initial[0].height };
    this.current = Math.min(this.current, Math.max(0, pageCount - 1));
    this.show();
  }

  /** 今の表示で必要なページ（前後のページも少し先読みする）。組み直しを頼むときに一緒に送ってもらう。 */
  wanted(): number[] {
    if (this.mode === "grid") return [];
    const [a, b] = this.mode === "spread" ? this.spreadPair() : [this.current, this.current];
    return [a - 2, a - 1, a, b, b + 1, b + 2].filter((i) => i >= 0);
  }

  setMode(mode: ViewMode) {
    this.mode = mode;
    this.show();
  }

  /** 次のページ（縦書きの本では左へめくる）。 */
  next() {
    this.goTo(this.current + (this.mode === "spread" ? (this.isRightPage(this.current) ? 2 : 1) : 1));
  }

  prev() {
    this.goTo(this.current - (this.mode === "spread" ? (this.isRightPage(this.current) ? 1 : 2) : 1));
  }

  goTo(index: number) {
    this.current = Math.max(0, Math.min(this.pageCount - 1, index));
    this.show();
  }

  /** 次に表示するページを決める（描くのは次の setDocument・show のとき）。 */
  jumpTo(index: number) {
    this.current = Math.max(0, index);
  }

  /** 1ページ表示で今描いているページ（紙面で入力するときに使う）。 */
  currentPage(): DrawPage | undefined {
    return this.mode === "single" && this.singleCanvas?.isConnected ? this.drawn.get(this.singleCanvas)?.page : undefined;
  }

  /** ページの座標（pt）を、画面の座標（px）にする。1ページ表示のときだけ。 */
  toClient(x: number, y: number): { x: number; y: number; pxPerPt: number } | undefined {
    const canvas = this.singleCanvas;
    const d = canvas?.isConnected ? this.drawn.get(canvas) : undefined;
    if (!canvas || !d) return undefined;
    const box = canvas.getBoundingClientRect();
    const scale = d.pxPerPt / (window.devicePixelRatio || 1);
    return { x: box.left + (x + d.bleed) * scale, y: box.top + (y + d.bleed) * scale, pxPerPt: scale };
  }

  /** 1ページ表示でページを描き直したとき（紙面で入力するときのカーソルを置き直す）。 */
  onShown?: () => void;

  /** 見開きの先に来るページか（偶数ページ。右綴じでは右、左綴じでは左に置く）。 */
  private isRightPage(index: number): boolean {
    return (this.firstNumber + index) % 2 === 0;
  }

  /** 今のページを含む見開きの [右ページ, 左ページ]。 */
  private spreadPair(): [number, number] {
    const right = this.isRightPage(this.current) ? this.current : this.current - 1;
    return [right, right + 1];
  }

  /** 足りないページを取り寄せる。取り寄せている間に組み直しがあれば false。 */
  private async ensure(indices: number[]): Promise<boolean> {
    const missing = indices.filter((i) => i >= 0 && i < this.pageCount && !this.cache.has(i));
    if (missing.length === 0) return true;
    const version = this.version;
    const pages = await this.fetchPages(version, missing);
    if (!pages || version !== this.version) return false;
    for (const p of pages) this.cache.set(p.index, p);
    return true;
  }

  show() {
    const seq = ++this.showSeq;
    this.observer?.disconnect();
    this.gridSeq++;
    this.stage.classList.toggle("grid", this.mode === "grid");
    if (this.pageCount === 0) {
      this.stage.replaceChildren();
      this.label.textContent = "– / –";
      return;
    }
    if (this.mode === "grid") {
      this.showGrid();
      return;
    }
    const needed = this.mode === "spread" ? this.spreadPair() : [this.current];
    void this.ensure(this.wanted()).then((ok) => {
      if (!ok || seq !== this.showSeq) return;
      if (this.mode === "spread") this.showSpread(needed as [number, number]);
      else this.showSingle();
    });
  }

  private fitScale(pagesAcross: number): number {
    const bleed = this.guides ? this.bleedMm * MM_PT : 0;
    const w = (this.pageSize.width + bleed * 2) * pagesAcross;
    const h = this.pageSize.height + bleed * 2;
    const box = this.stageSize ?? this.stage.getBoundingClientRect();
    return Math.max(0.2, Math.min((box.width - 40) / w, (box.height - 40) / h));
  }

  /** reuse を渡すと、そのキャンバスに描き直す（大きさが同じなら画素の領域を作り直さずに済む）。 */
  private makeCanvas(page: DrawPage, cssScale: number, reuse?: HTMLCanvasElement): HTMLCanvasElement {
    const canvas = reuse ?? this.pickable(document.createElement("canvas"));
    const dpr = window.devicePixelRatio || 1;
    const opts = { pxPerPt: cssScale * dpr, bleedPt: this.guides ? this.bleedMm * MM_PT : 0, guides: this.guides, images: this.images, ink: this.ink };
    const size = canvasSize(page, opts);
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
    canvas.style.width = `${size.width / dpr}px`;
    canvas.style.height = `${size.height / dpr}px`;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `${this.firstNumber + page.index}ページ`);
    drawPage(canvas.getContext("2d")!, page, this.fonts, opts);
    this.drawn.set(canvas, { page, pxPerPt: opts.pxPerPt, bleed: opts.bleedPt });
    return canvas;
  }

  /** キャンバスで字を選べるようにする。 */
  private pickable(canvas: HTMLCanvasElement): HTMLCanvasElement {
    const handler = (double: boolean) => (ev: MouseEvent) => {
      const d = this.drawn.get(canvas);
      if (!d || !this.onPick) return;
      const dpr = window.devicePixelRatio || 1;
      const x = (ev.offsetX * dpr) / d.pxPerPt - d.bleed;
      const y = (ev.offsetY * dpr) / d.pxPerPt - d.bleed;
      const item = pickItem(d.page, x, y);
      if (item) this.onPick(item, ev, double);
    };
    canvas.addEventListener("click", handler(false));
    canvas.addEventListener("dblclick", handler(true));
    return canvas;
  }

  /** 直近の描画にかかった時間（計測用）。 */
  lastDrawMs = 0;

  /** 1ページ表示のキャンバス。編集のたびの描き直しで使い回す。 */
  private singleCanvas: HTMLCanvasElement | undefined;

  private showSingle() {
    const page = this.cache.get(this.current);
    if (!page) return;
    const t = performance.now();
    this.singleCanvas = this.makeCanvas(page, this.fitScale(1), this.singleCanvas);
    if (this.stage.firstChild !== this.singleCanvas || this.stage.childNodes.length !== 1) this.stage.replaceChildren(this.singleCanvas);
    this.lastDrawMs = performance.now() - t;
    this.label.textContent = `${this.current + 1} / ${this.pageCount}`;
    this.onShown?.();
  }

  private showSpread([rightIndex, leftIndex]: [number, number]) {
    const scale = this.fitScale(2);
    const box = document.createElement("div");
    box.className = "spread";
    // 右綴じでは見開きの先のページ（偶数）を右に、左綴じでは左に置く。
    for (const index of this.leftBound ? [rightIndex, leftIndex] : [leftIndex, rightIndex]) {
      const page = this.cache.get(index);
      if (page) {
        box.append(this.makeCanvas(page, scale));
      } else {
        const blank = document.createElement("canvas");
        blank.className = "blank";
        blank.style.width = `${this.pageSize.width * scale}px`;
        blank.style.height = `${this.pageSize.height * scale}px`;
        box.append(blank);
      }
    }
    this.stage.replaceChildren(box);
    const shown = [rightIndex, leftIndex].filter((x) => x >= 0 && x < this.pageCount).map((x) => x + 1);
    this.label.textContent = `${shown.join("・")} / ${this.pageCount}`;
  }

  /** 一覧の図（ページの番号で引く）。組み直しても同じページ数なら使い回し、古い縮小図を出したまま描き直す。 */
  private gridFigures: HTMLElement[] = [];
  private gridSeq = 0;
  private gridSize = "";

  private showGrid() {
    // 見えているページだけを取り寄せて描く。何百ページあっても最初の表示を速くするため。
    // 描くのは1ページずつ、合間に入力やスクロールを通す（まとめて描くと画面が止まる）。
    const thumbScale = 150 / this.pageSize.width;
    const seq = ++this.gridSeq;
    const pending = new Set<number>();
    let running = false;
    const pump = async () => {
      running = true;
      while (pending.size > 0 && seq === this.gridSeq) {
        // 近い順（番号の小さい順）に、少しずつ取り寄せる。
        const batch = [...pending].sort((x, y) => x - y).slice(0, 4);
        if (!(await this.ensure(batch)) || seq !== this.gridSeq) break;
        for (const i of batch) {
          pending.delete(i);
          const page = this.cache.get(i);
          const fig = this.gridFigures[i];
          if (page && fig) fig.querySelector("canvas")?.replaceWith(this.makeCanvas(page, thumbScale));
          await new Promise((r) => setTimeout(r, 0));
          if (seq !== this.gridSeq) break;
        }
      }
      running = false;
    };
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          pending.add(Number((e.target as HTMLElement).dataset.index));
          this.observer!.unobserve(e.target);
        }
        if (pending.size > 0 && !running) void pump();
      },
      { root: this.stage, rootMargin: "300px" },
    );

    const sizeKey = `${this.pageSize.width}x${this.pageSize.height}`;
    if (this.gridFigures.length === this.pageCount && this.gridSize === sizeKey) {
      if (this.stage.firstChild !== this.gridFigures[0]) this.stage.replaceChildren(...this.gridFigures);
    } else {
      this.gridFigures = [];
      this.gridSize = sizeKey;
      for (let index = 0; index < this.pageCount; index++) {
        const fig = document.createElement("figure");
        fig.dataset.index = String(index);
        fig.tabIndex = 0;
        const placeholder = document.createElement("canvas");
        placeholder.width = 1;
        placeholder.height = 1;
        placeholder.style.aspectRatio = `${this.pageSize.width} / ${this.pageSize.height}`;
        const caption = document.createElement("figcaption");
        fig.append(placeholder, caption);
        const open = () => {
          this.current = index;
          this.stage.dispatchEvent(new CustomEvent("modechange", { detail: "single" }));
        };
        fig.addEventListener("click", open);
        fig.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") open();
        });
        this.gridFigures.push(fig);
      }
      this.stage.replaceChildren(...this.gridFigures);
    }
    this.gridFigures.forEach((fig, index) => {
      const caption = fig.querySelector("figcaption")!;
      const n = String(this.firstNumber + index);
      if (caption.textContent !== n) caption.textContent = n;
      this.observer!.observe(fig);
    });
    this.label.textContent = `全${this.pageCount}ページ`;
  }
}
