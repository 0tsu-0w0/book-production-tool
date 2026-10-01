import type { LineIssue, VariantGroup } from "../engine/proof.js";

// 校正の補助（DTP-16）の画面。表記ゆれ・禁則違反・段落末の1文字だけの行を一覧にし、
// 選ぶと原稿のその場所（表記ゆれ）か、プレビューのそのページ（組みの問題）を開く。

export interface ProofResult {
  variants: VariantGroup[];
  kinsoku: LineIssue[];
  shortLast: LineIssue[];
}

export interface ProofHandlers {
  run(): Promise<ProofResult>;
  /** 原稿の line 行目（1始まり）の index 文字目から length 文字を選ぶ。 */
  selectInText(line: number, index: number, length: number): void;
  /** プレビューで page ページ目（0始まり）を開く。 */
  showPage(page: number): void;
  firstPageNumber(): number;
}

const KIND_LABEL: Record<VariantGroup["kind"], string> = { word: "表記", "long-vowel": "長音", digits: "数字の幅" };

export class ProofDialog {
  private readonly dialog = document.getElementById("proof-dialog") as HTMLDialogElement;
  private readonly body = document.getElementById("proof-body") as HTMLDivElement;

  constructor(private readonly h: ProofHandlers) {
    document.getElementById("proof-rerun")!.addEventListener("click", () => void this.open());
  }

  async open() {
    this.body.replaceChildren(this.note("調べています…"));
    if (!this.dialog.open) this.dialog.show();
    const r = await this.h.run();
    this.body.replaceChildren(
      this.section(`表記ゆれ（${r.variants.length}）`, r.variants.length === 0 ? [this.note("見つかりませんでした。")] : r.variants.map((g) => this.variant(g))),
      this.section(`禁則違反（${r.kinsoku.length}）`, this.issues(r.kinsoku)),
      this.section(`段落末の1文字だけの行（${r.shortLast.length}）`, this.issues(r.shortLast)),
    );
  }

  private section(title: string, items: HTMLElement[]): HTMLElement {
    const box = document.createElement("section");
    const h = document.createElement("h3");
    h.textContent = title;
    const list = document.createElement("ul");
    list.className = "proof-list";
    for (const item of items) {
      if (item.tagName === "LI") {
        list.append(item);
      } else {
        const li = document.createElement("li");
        li.append(item);
        list.append(li);
      }
    }
    box.append(h, list);
    return box;
  }

  private note(text: string): HTMLElement {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = text;
    return p;
  }

  private variant(g: VariantGroup): HTMLElement {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    tag.className = "proof-tag";
    tag.textContent = KIND_LABEL[g.kind];
    li.append(tag);
    for (const f of g.forms) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "link";
      b.textContent = `${f.form}（${f.count}）`;
      b.title = `原稿の${f.line}行目`;
      // 数字の幅は語ではないので、最初の1字だけを選ぶ。
      b.addEventListener("click", () => this.h.selectInText(f.line, f.index, g.kind === "digits" ? 1 : f.form.length));
      li.append(b);
    }
    return li;
  }

  private issues(list: LineIssue[]): HTMLElement[] {
    if (list.length === 0) return [this.note("見つかりませんでした。")];
    const shown: HTMLElement[] = list.slice(0, 300).map((i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "link";
      b.textContent = `${this.h.firstPageNumber() + i.page}ページ ${i.line}行目`;
      b.addEventListener("click", () => this.h.showPage(i.page));
      const text = document.createElement("span");
      text.className = "proof-text";
      text.textContent = `${i.reason}：${i.text}`;
      li.append(b, text);
      return li;
    });
    if (list.length > 300) shown.push(this.note(`ほか ${list.length - 300} 件`));
    return shown;
  }
}
