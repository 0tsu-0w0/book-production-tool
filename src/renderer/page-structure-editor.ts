import type { PageItem, PageItemKind, PageStructure } from "../document/settings.js";

// 設定欄の「ページ構成」：本文の前と後ろに入れるページ（本扉・白ページ・奥付・自由なページ）の追加・並べ替え・削除（DTP-13）。

const KIND_LABELS: Record<PageItemKind, string> = {
  title: "本扉（書名・著者名）",
  blank: "白ページ",
  colophon: "奥付",
  free: "自由なページ（献辞など）",
  toc: "目次（見出しから作る）",
  index: "索引（［＃索引］の語から作る）",
};

export class PageStructureEditor {
  readonly element = document.createElement("div");

  constructor(
    private readonly pages: PageStructure,
    private readonly onChange: () => void,
  ) {
    this.element.className = "fields";
    this.element.style.padding = "0";
    this.render();
  }

  private render() {
    this.element.replaceChildren(this.list("本文の前", this.pages.front), this.list("本文の後ろ", this.pages.back), this.adder());
  }

  private changed() {
    this.render();
    this.onChange();
  }

  private list(label: string, items: PageItem[]): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const title = document.createElement("span");
    title.textContent = label;
    const box = document.createElement("div");
    box.className = "page-items";
    if (items.length === 0) {
      const none = document.createElement("span");
      none.className = "computed";
      none.textContent = "なし";
      box.append(none);
    }
    items.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "page-item";
      const name = document.createElement("span");
      name.textContent = `${i + 1}. ${KIND_LABELS[item.kind]}`;
      const move = (to: number) => {
        [items[i], items[to]] = [items[to], items[i]];
        this.changed();
      };
      const up = this.button("↑", "前へ", () => move(i - 1), i === 0);
      const down = this.button("↓", "後ろへ", () => move(i + 1), i === items.length - 1);
      const del = this.button("×", "取り除く", () => {
        items.splice(i, 1);
        this.changed();
      });
      row.append(name, up, down, del);
      if (item.kind === "free") {
        const text = document.createElement("textarea");
        text.value = item.text;
        text.placeholder = "原稿と同じ記法で書けます（ページの中央に置きます）";
        text.setAttribute("aria-label", "自由なページの中身");
        text.addEventListener("input", () => {
          item.text = text.value;
          this.onChange();
        });
        row.append(text);
      }
      box.append(row);
    });
    wrap.append(title, box);
    return wrap;
  }

  private adder(): HTMLElement {
    const row = document.createElement("div");
    row.className = "row";
    const kind = document.createElement("select");
    kind.setAttribute("aria-label", "入れるページ");
    for (const [k, label] of Object.entries(KIND_LABELS)) kind.add(new Option(label, k));
    const add = (target: PageItem[]) => () => {
      target.push({ kind: kind.value as PageItemKind, text: "" });
      this.changed();
    };
    row.append(kind, this.button("前に入れる", "", add(this.pages.front)), this.button("後ろに入れる", "", add(this.pages.back)));
    return row;
  }

  private button(text: string, label: string, onClick: () => void, disabled = false): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    if (label) {
      b.title = label;
      b.setAttribute("aria-label", label);
    }
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  }
}
