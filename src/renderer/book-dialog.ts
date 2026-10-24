import type { Book } from "../document/book.js";

// ブックの画面（InDesign のブックパネルにあたるもの）。章ごとの文書を並べ、通しのページ番号を確かめ、
// 1冊の PDF に書き出す。並べ替え・含める／含めない・スタイルの元・設定の同期・文書を開く。

export interface BookInfo {
  pages: number;
  ranges: { index: number; from: number; to: number }[];
  errors: (string | null | undefined)[];
  renamed: { doc: string; from: string; to: string }[];
}

export interface BookHost {
  newBook(): Promise<{ path: string; book: Book } | undefined>;
  openBook(file?: string): Promise<{ path: string; book: Book } | { error: string } | undefined>;
  save(path: string, book: Book): Promise<void>;
  chooseDocs(path: string): Promise<string[]>;
  info(path: string, book: Book): Promise<BookInfo>;
  exportPdf(path: string, book: Book): Promise<void>;
  exportEpub(path: string, book: Book): Promise<void>;
  exportHtml(path: string, book: Book): Promise<void>;
  openCombined(path: string, book: Book): Promise<void>;
  sync(path: string, book: Book): Promise<{ count: number } | { error: string }>;
  openDocument(path: string, rel: string): Promise<void>;
}

const LAST_BOOK = "kolophon.lastBook";
/** 旧名（tategumi）のころに覚えたもの。 */
const LEGACY_LAST_BOOK = "tategumi.lastBook";

export class BookDialog {
  private readonly dialog = document.createElement("dialog");
  private path: string | null = null;
  private book: Book | null = null;
  private info: BookInfo | null = null;
  private busy = false;
  private seq = 0;

  constructor(private readonly host: BookHost) {
    this.dialog.className = "book-dialog";
    this.dialog.setAttribute("aria-label", "ブック");
    document.body.append(this.dialog);
  }

  /** ブックの画面を開く。file を渡すと、そのブックを開く（ブックのファイルをダブルクリックしたとき）。 */
  async open(file?: string) {
    if (file) {
      const r = await this.host.openBook(file);
      if (r && "error" in r) alert(r.error);
      else if (r) this.set(r.path, r.book);
    }
    if (!this.book) {
      let last: string | null = null;
      try {
        last = localStorage.getItem(LAST_BOOK) ?? localStorage.getItem(LEGACY_LAST_BOOK);
      } catch {
        last = null;
      }
      if (last) {
        const r = await this.host.openBook(last);
        if (r && !("error" in r)) this.set(r.path, r.book);
      }
    }
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    void this.refresh();
  }

  private set(path: string, book: Book) {
    this.path = path;
    this.book = book;
    this.info = null;
    try {
      localStorage.setItem(LAST_BOOK, path);
    } catch {
      // 覚えておけなくても使える。
    }
  }

  /** ブックを保存し、組み直してページの範囲を出し直す。 */
  private async changed() {
    if (!this.path || !this.book) return;
    await this.host.save(this.path, this.book);
    this.render();
    await this.refresh();
  }

  private async refresh() {
    if (!this.path || !this.book) return;
    const seq = ++this.seq;
    this.busy = true;
    this.render();
    const info = await this.host.info(this.path, this.book);
    if (seq !== this.seq) return;
    this.info = info;
    this.busy = false;
    this.render();
  }

  private button(label: string, action: () => void | Promise<void>, opts: { primary?: boolean; danger?: boolean; disabled?: boolean; title?: string } = {}) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (opts.primary) b.className = "primary";
    if (opts.danger) b.className = "danger";
    if (opts.title) b.title = opts.title;
    b.disabled = !!opts.disabled;
    b.addEventListener("click", () => void action());
    return b;
  }

  private render() {
    const d = this.dialog;
    d.replaceChildren();
    const head = document.createElement("div");
    head.className = "book-head";
    const title = document.createElement("h2");
    title.textContent = this.path ? `ブック：${this.path.split(/[\\/]/).pop()}` : "ブック";
    head.append(
      title,
      this.button("新規ブック…", async () => {
        const r = await this.host.newBook();
        if (r) {
          this.set(r.path, r.book);
          this.render();
          void this.refresh();
        }
      }),
      this.button("ブックを開く…", async () => {
        const r = await this.host.openBook();
        if (!r) return;
        if ("error" in r) return alert(r.error);
        this.set(r.path, r.book);
        this.render();
        void this.refresh();
      }),
    );
    d.append(head);

    const book = this.book;
    if (!book || !this.path) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "章ごとの文書を1冊にまとめます。ページ番号は文書をまたいで続き、目次・注・ページ番号の参照は本全体で数えます。新しいブックを作るか、ブックを開いてください。";
      d.append(p, this.footer());
      return;
    }

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "★の文書（スタイルの元）の設定で、全体を組みます（判型・スタイル・柱・扉と奥付など）。上から順につなぎ、文書の間で改丁（または改ページ）します。";
    d.append(hint);

    const list = document.createElement("ol");
    list.className = "book-list";
    book.documents.forEach((entry, i) => {
      const li = document.createElement("li");
      const include = document.createElement("input");
      include.type = "checkbox";
      include.checked = entry.include;
      include.title = "書き出しに含める";
      include.setAttribute("aria-label", `${entry.path} を含める`);
      include.addEventListener("change", () => {
        entry.include = include.checked;
        void this.changed();
      });
      const source = document.createElement("input");
      source.type = "radio";
      source.name = "book-style-source";
      source.checked = book.styleSource === i;
      source.title = "スタイルの元にする";
      source.setAttribute("aria-label", `${entry.path} をスタイルの元にする`);
      source.addEventListener("change", () => {
        book.styleSource = i;
        void this.changed();
      });
      const name = document.createElement("span");
      name.className = "book-name";
      name.textContent = `${book.styleSource === i ? "★ " : ""}${entry.path}`;
      const pages = document.createElement("span");
      pages.className = "computed";
      const err = this.info?.errors[i];
      const range = this.info?.ranges.find((r) => r.index === i);
      pages.textContent = err ? `⚠ ${err}` : !entry.include ? "含めない" : range ? `${range.from}〜${range.to}ページ` : this.busy ? "…" : "";
      if (err) pages.classList.add("warning");
      const move = (dir: -1 | 1) => () => {
        const j = i + dir;
        if (j < 0 || j >= book.documents.length) return;
        [book.documents[i], book.documents[j]] = [book.documents[j], book.documents[i]];
        // スタイルの元は、その文書について動く。
        if (book.styleSource === i) book.styleSource = j;
        else if (book.styleSource === j) book.styleSource = i;
        void this.changed();
      };
      li.append(
        include,
        source,
        name,
        pages,
        this.button("↑", move(-1), { disabled: i === 0, title: "前へ" }),
        this.button("↓", move(1), { disabled: i === book.documents.length - 1, title: "後ろへ" }),
        this.button("開く", async () => {
          this.dialog.close();
          await this.host.openDocument(this.path!, entry.path);
        }),
        this.button("外す", () => {
          book.documents.splice(i, 1);
          if (book.styleSource >= book.documents.length || book.styleSource === i) book.styleSource = 0;
          else if (book.styleSource > i) book.styleSource--;
          void this.changed();
        }, { danger: true, title: "ブックから外す（文書のファイルは消さない）" }),
      );
      list.append(li);
    });
    if (book.documents.length === 0) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "「文書を追加…」で、章ごとの文書（Kolophon 文書・テキスト・TeX）を入れてください。";
      d.append(p);
    } else {
      d.append(list);
    }

    const opts = document.createElement("label");
    opts.className = "check";
    const odd = document.createElement("input");
    odd.type = "checkbox";
    odd.checked = book.startOdd;
    odd.addEventListener("change", () => {
      book.startOdd = odd.checked;
      void this.changed();
    });
    opts.append(odd, document.createTextNode("文書を奇数ページから始める（改丁。外すと次のページから）"));
    d.append(opts);

    const status = document.createElement("p");
    status.className = "computed";
    if (this.busy) status.textContent = "組んでいます…";
    else if (this.info) {
      const renamed = this.info.renamed.map((r) => `${r.doc} の画像「${r.from}」→「${r.to}」`).join("、");
      status.textContent = `全${this.info.pages}ページ。${renamed ? `名前が重なった画像を付け替えました：${renamed}` : ""}`;
    }
    d.append(status, this.footer());
  }

  private footer(): HTMLElement {
    const row = document.createElement("div");
    row.className = "row book-actions";
    const has = !!this.book && !!this.path;
    const any = has && this.book!.documents.some((e) => e.include);
    row.append(
      this.button("文書を追加…", async () => {
        const rels = await this.host.chooseDocs(this.path!);
        for (const rel of rels) if (!this.book!.documents.some((e) => e.path === rel)) this.book!.documents.push({ path: rel, include: true });
        if (rels.length > 0) void this.changed();
      }, { disabled: !has }),
      this.button("設定を同期…", async () => {
        const name = this.book!.documents[this.book!.styleSource]?.path ?? "";
        if (!confirm(`「${name}」の設定を、ほかの Kolophon 文書に書き込みます（原稿は変えません）。よろしいですか？`)) return;
        const r = await this.host.sync(this.path!, this.book!);
        alert("error" in r ? r.error : `${r.count}個の文書の設定を同期しました。`);
      }, { disabled: !any, title: "スタイルの元の設定（判型・スタイル・柱など）を、ほかの文書にも書き込む" }),
      this.button("つないで開く", async () => {
        this.dialog.close();
        await this.host.openCombined(this.path!, this.book!);
      }, { disabled: !any, title: "全体をつないだ原稿を、新しい文書として開く（全体の確認や画像の書き出しに）" }),
      this.button("EPUB を書き出す…", async () => {
        this.dialog.close();
        await this.host.exportEpub(this.path!, this.book!);
      }, { disabled: !any, title: "1冊の電子書籍（EPUB 3）にする" }),
      this.button("HTML を書き出す…", async () => {
        this.dialog.close();
        await this.host.exportHtml(this.path!, this.book!);
      }, { disabled: !any, title: "1冊をウェブで読める HTML にする（1つのファイルか、章ごとのフォルダ）" }),
      this.button("PDF を書き出す…", async () => {
        this.dialog.close();
        await this.host.exportPdf(this.path!, this.book!);
      }, { primary: true, disabled: !any }),
      this.button("閉じる", () => this.dialog.close()),
    );
    return row;
  }
}
