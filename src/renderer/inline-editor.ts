// 紙面の上で直接直す（DTP-15）。プレビューの字をダブルクリックすると、その字のある原稿の行を
// その場に開く。確定すると原稿の行を置き換えて組み直す。原稿欄の「元に戻す」（Ctrl+Z）で戻せる。

export interface InlineEditorHost {
  /** 原稿の line 行目（0始まり）の文字列。 */
  lineText(line: number): string | undefined;
  /** 原稿の line 行目を text に置き換える（元に戻せるように）。 */
  replaceLine(line: number, text: string): void;
}

export class InlineEditor {
  private readonly box = document.createElement("div");
  private readonly input = document.createElement("textarea");
  private line = -1;

  constructor(private readonly host: InlineEditorHost) {
    this.box.className = "inline-edit";
    this.box.hidden = true;
    this.input.rows = 3;
    this.input.setAttribute("aria-label", "原稿の行を直す");
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Enter で確定、Esc でやめる（Shift+Enter で改行）。確定したあとも Ctrl+Z で戻せます。";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "primary";
    ok.textContent = "確定";
    ok.addEventListener("click", () => this.commit());
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "やめる";
    cancel.addEventListener("click", () => this.close());
    const row = document.createElement("div");
    row.className = "row";
    row.append(ok, cancel);
    this.box.append(this.input, hint, row);
    document.body.append(this.box);
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.commit();
      }
    });
  }

  /** 原稿の line 行目を、画面の (x, y) の近くに開く。offset の字にカーソルを置く。 */
  open(line: number, offset: number, x: number, y: number) {
    const text = this.host.lineText(line);
    if (text === undefined) return;
    this.line = line;
    this.input.value = text;
    this.box.hidden = false;
    const w = Math.min(520, window.innerWidth - 32);
    this.box.style.width = `${w}px`;
    this.box.style.left = `${Math.max(16, Math.min(x - w / 2, window.innerWidth - w - 16))}px`;
    this.box.style.top = `${Math.max(16, Math.min(y + 16, window.innerHeight - 180))}px`;
    this.input.focus();
    const at = Math.min(offset, text.length);
    this.input.setSelectionRange(at, at);
  }

  private commit() {
    if (this.line >= 0 && this.host.lineText(this.line) !== this.input.value) {
      // 行の中で改行したら、そのまま複数の行になる。
      this.host.replaceLine(this.line, this.input.value);
    }
    this.close();
  }

  close() {
    this.box.hidden = true;
    this.line = -1;
  }
}
