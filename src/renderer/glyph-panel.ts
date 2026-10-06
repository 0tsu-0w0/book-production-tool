import { glyphTarget, glyphText, type GlyphTarget } from "./glyph-text.js";

// 字形パネル（InDesign の字形パネルにあたる）。原稿欄のカーソルの直前の字（選んでいれば最初の字）について、
// フォントにある別の字形（異体字・字形の候補）を並べ、選ぶとその字の書き方を替える。
// 開いている間は、カーソルを動かすと、その字の字形に替わる。

export interface GlyphVariantView {
  kind: "base" | "ivs" | "alt";
  value: number;
  label: string;
  d: string;
  advance: number;
}

export interface GlyphPanelHost {
  source: HTMLTextAreaElement;
  /** 本文の書体で、字の字形の一覧を調べる（vertical なら縦組みの字形）。 */
  variants(base: string): Promise<{ upem: number; emBottom: number; variants: GlyphVariantView[]; font: string }>;
  /** 原稿の範囲を書き換える（元に戻せるように）。 */
  replace(start: number, end: number, text: string): void;
}

export class GlyphPanel {
  private readonly root = document.createElement("section");
  private readonly title = document.createElement("p");
  private readonly grid = document.createElement("div");
  private timer: number | undefined;
  private shown: GlyphTarget | null = null;
  /** 頼んだ順の番号（古い答えで上書きしないため）。 */
  private seq = 0;

  constructor(private readonly host: GlyphPanelHost) {
    this.root.className = "glyph-panel";
    this.root.hidden = true;
    this.root.setAttribute("aria-label", "字形");
    const head = document.createElement("header");
    const h = document.createElement("h2");
    h.textContent = "字形";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = close.ariaLabel = "閉じる";
    close.addEventListener("click", () => this.close());
    head.append(h, close);
    this.title.className = "glyph-target";
    this.grid.className = "glyph-grid";
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "原稿欄で字のあとにカーソルを置くか、字を選ぶと、本文の書体にある別の字形が並びます。IVS（異体字）は原稿に字として残り、ほかのソフトや EPUB でも同じ字形になります。「候補」は原稿に［＃字形：番号］と入り、Kolophon の紙面と PDF で使えます。";
    this.root.append(head, this.title, this.grid, hint);
    document.body.append(this.root);
    // カーソルが動いたら、その字の字形に替える（少し待ってから）。
    document.addEventListener("selectionchange", () => {
      if (!this.root.hidden && document.activeElement === host.source) this.schedule();
    });
    host.source.addEventListener("input", () => {
      if (!this.root.hidden) this.schedule();
    });
  }

  toggle() {
    if (this.root.hidden) this.open();
    else this.close();
  }

  open() {
    this.root.hidden = false;
    this.refresh();
  }

  close() {
    this.root.hidden = true;
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), 80);
  }

  /** 書体や組み方向が変わったとき（設定を変えたとき）に、出している字を調べ直す。 */
  refresh() {
    if (this.root.hidden) return;
    const { source } = this.host;
    const target = glyphTarget(source.value, source.selectionStart, source.selectionEnd);
    this.shown = target;
    if (!target) {
      this.title.textContent = "字を選ぶか、字のあとにカーソルを置いてください。";
      this.grid.replaceChildren();
      return;
    }
    const seq = ++this.seq;
    void this.host.variants(target.base).then((r) => {
      if (seq !== this.seq) return;
      const cp = target.base.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
      this.title.textContent = `「${target.base}」U+${cp}　${r.variants.length > 1 ? `${r.variants.length}字形` : "別の字形はありません"}（${r.font}）`;
      this.grid.replaceChildren(...r.variants.map((v) => this.button(v, r.upem, r.emBottom, target)));
    });
  }

  private button(v: GlyphVariantView, upem: number, emBottom: number, target: GlyphTarget): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "glyph-cell";
    const current = v.kind === "base" ? !target.vs && !target.alt : v.kind === "ivs" ? target.vs === v.value : target.alt === v.value;
    b.setAttribute("aria-pressed", String(current));
    b.title = `${v.label}${v.kind === "ivs" ? "（原稿に異体字セレクタを付けます）" : v.kind === "alt" ? `（原稿に［＃字形：${v.value}］を付けます）` : ""}`;
    // 字形の輪郭は y 軸が上向き。仮想ボディ（1em の正方形）に収めて、送り幅の真ん中に置く。
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${upem} ${upem}`);
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", v.d);
    path.setAttribute("transform", `translate(${(upem - v.advance) / 2} ${upem + emBottom}) scale(1 -1)`);
    svg.append(path);
    const label = document.createElement("span");
    label.textContent = v.label;
    b.append(svg, label);
    b.addEventListener("click", () => {
      // 調べたあとに原稿が変わっていれば、その字を探し直してから替える。
      const now = this.shown && this.shown.base === target.base ? this.shown : target;
      this.host.replace(now.start, now.end, glyphText(now.base, v.kind, v.value));
      this.refresh();
    });
    return b;
  }
}
