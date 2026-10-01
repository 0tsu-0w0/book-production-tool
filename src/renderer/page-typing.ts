import { afterInsert, caretAt, moveChar, moveLine, type Caret, type Src } from "./caret.js";
import type { Preview } from "./preview.js";

// 紙面に直接打って直す（DTP-15）。紙面の字をクリックするとそこにカーソルを置き、打った字を原稿のその位置に入れて組み直す。
// 日本語入力（IME）の変換中の字は、カーソルの位置に重ねた小さな入力欄に出す（縦組みなら縦に）。
// 原稿への変更は原稿欄を通して行うので、原稿欄の「元に戻す」（Ctrl+Z）で戻せる。

export interface PageTypingHost {
  source: HTMLTextAreaElement;
  /** 縦組みか（矢印の向きとカーソルの形が変わる）。 */
  vertical(): boolean;
  setStatus(text: string): void;
  /** 入力をやめたとき（ツールバーの表示を戻す）。 */
  stopped(): void;
}

export class PageTyping {
  active = false;
  /** カーソルの原稿の位置。 */
  caret: Src | undefined;
  private readonly bar = document.createElement("div");
  private readonly input = document.createElement("textarea");
  private composing = false;
  /** 直近に描いたカーソル（ページの座標）。となりの行へ動くときに使う。 */
  private drawn: Caret | undefined;

  constructor(
    private readonly preview: Preview,
    private readonly host: PageTypingHost,
  ) {
    this.bar.className = "page-caret";
    this.bar.hidden = true;
    this.input.className = "page-input";
    this.input.hidden = true;
    this.input.rows = 1;
    this.input.setAttribute("aria-label", "紙面で入力");
    this.input.spellcheck = false;
    document.body.append(this.bar, this.input);

    this.input.addEventListener("compositionstart", () => {
      this.composing = true;
      this.input.classList.add("composing");
    });
    this.input.addEventListener("compositionend", () => {
      this.composing = false;
      this.input.classList.remove("composing");
      this.commit();
    });
    this.input.addEventListener("input", (e) => {
      if (this.composing || (e as InputEvent).isComposing) return;
      this.commit();
    });
    this.input.addEventListener("keydown", (e) => this.key(e));
    this.input.addEventListener("blur", () => {
      // 原稿欄に書き込む間は一時的にフォーカスが外れるので、そのときは消さない。
      if (!this.writing) this.bar.classList.add("idle");
    });
    this.input.addEventListener("focus", () => this.bar.classList.remove("idle"));
    window.addEventListener("resize", () => this.render());
  }

  setActive(on: boolean) {
    this.active = on;
    if (!on) {
      this.caret = undefined;
      this.bar.hidden = true;
      this.input.hidden = true;
      this.input.value = "";
      return;
    }
    this.host.setStatus("紙面の字をクリックすると、そこから打てます（矢印で移動、Esc でやめる。Ctrl+Z で戻せます）。");
  }

  /** カーソルを置く（紙面の字をクリックしたとき）。 */
  place(src: Src) {
    if (!this.active) return;
    this.caret = [src[0], src[1]];
    this.render();
    this.input.focus();
  }

  /** カーソルを描き直す（ページを描き直したあと・組み直したあと）。 */
  render() {
    if (!this.active || !this.caret) return;
    const page = this.preview.currentPage();
    const c = page ? caretAt(page, this.caret, this.host.vertical()) : undefined;
    const p = c ? this.preview.toClient(c.x, c.y) : undefined;
    this.drawn = c;
    if (!c || !p) {
      // カーソルの字がこのページにない（組み直しでページが変わる途中など）。
      this.bar.hidden = true;
      this.input.style.left = "-1000px";
      this.input.hidden = false;
      return;
    }
    const vertical = this.host.vertical();
    const px = c.size * p.pxPerPt;
    Object.assign(this.bar.style, {
      left: `${p.x - (vertical ? 1 : 1)}px`,
      top: `${p.y - (vertical ? 1 : 0)}px`,
      width: vertical ? `${c.w * p.pxPerPt + 2}px` : "2px",
      height: vertical ? "2px" : `${c.h * p.pxPerPt}px`,
    });
    this.bar.hidden = false;
    // 変換中の字は、縦組みならカーソルの下へ縦に、横組みならカーソルの右へ出す。
    this.input.classList.toggle("vertical", vertical);
    Object.assign(this.input.style, {
      left: `${p.x}px`,
      top: `${p.y}px`,
      fontSize: `${Math.max(10, px)}px`,
    });
    this.input.hidden = false;
  }

  private writing = false;

  /** 原稿の [from, to) を text に置き換える（原稿欄の「元に戻す」で戻せるように）。 */
  private replace(from: Src, to: Src, text: string) {
    const src = this.host.source;
    const lines = src.value.split("\n");
    const abs = ([l, o]: Src) => lines.slice(0, l).reduce((s, x) => s + x.length + 1, 0) + o;
    this.writing = true;
    src.focus();
    src.setSelectionRange(abs(from), abs(to));
    if (text) document.execCommand("insertText", false, text);
    else document.execCommand("delete");
    this.input.focus();
    this.writing = false;
  }

  private commit() {
    const text = this.input.value;
    this.input.value = "";
    if (!text || !this.caret) return;
    // 入力欄の改行は、原稿の改行として入れる。
    const t = text.replace(/\r\n?/g, "\n");
    this.replace(this.caret, this.caret, t);
    this.caret = afterInsert(this.caret, t);
    this.render();
  }

  private key(e: KeyboardEvent) {
    if (this.composing || e.isComposing || e.keyCode === 229) return;
    const caret = this.caret;
    if (e.key === "Escape") {
      e.preventDefault();
      this.setActive(false);
      this.host.stopped();
      this.host.setStatus("紙面での入力をやめました。");
      return;
    }
    if (!caret) return;
    const lines = this.host.source.value.split("\n");
    const vertical = this.host.vertical();
    // 縦組み：上下で字、左右で行。横組み：左右で字、上下で行。
    const charKeys: Record<string, 1 | -1> = vertical ? { ArrowUp: -1, ArrowDown: 1 } : { ArrowLeft: -1, ArrowRight: 1 };
    const lineKeys: Record<string, 1 | -1> = vertical ? { ArrowLeft: 1, ArrowRight: -1 } : { ArrowUp: -1, ArrowDown: 1 };
    const charDir = charKeys[e.key];
    const lineDir = lineKeys[e.key];
    if (charDir) {
      e.preventDefault();
      this.caret = moveChar(lines, caret, charDir);
      this.follow();
    } else if (lineDir) {
      e.preventDefault();
      const page = this.preview.currentPage();
      const to = page && this.drawn ? moveLine(page, this.drawn, lineDir, vertical) : undefined;
      if (to) this.caret = to;
      this.render();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      this.caret = [caret[0], e.key === "Home" ? 0 : (lines[caret[0]] ?? "").length];
      this.follow();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      const from = moveChar(lines, caret, -1);
      if (from[0] === caret[0] && from[1] === caret[1]) return;
      this.replace(from, caret, "");
      this.caret = from;
      this.render();
    } else if (e.key === "Delete") {
      e.preventDefault();
      const to = moveChar(lines, caret, 1);
      if (to[0] === caret[0] && to[1] === caret[1]) return;
      this.replace(caret, to, "");
      this.render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.replace(caret, caret, "\n");
      this.caret = [caret[0] + 1, 0];
      this.render();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "y")) {
      // 元に戻す・やり直しは原稿欄で行う（カーソルは原稿欄の位置に合わせられないので、そのまま）。
      e.preventDefault();
      this.writing = true;
      this.host.source.focus();
      document.execCommand(e.key === "z" && !e.shiftKey ? "undo" : "redo");
      this.input.focus();
      this.writing = false;
      this.render();
    }
  }

  /** カーソルを動かしたあと、そのページにいなければ組み直しのときにページを移る（ここでは描き直すだけ）。 */
  private follow() {
    this.render();
    if (this.bar.hidden) this.onMissing?.();
  }

  /** カーソルが今のページにないとき（ページを移るよう本体に頼む）。 */
  onMissing?: () => void;
}
