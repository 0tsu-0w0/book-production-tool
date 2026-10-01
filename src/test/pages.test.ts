import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, bookGeometry, normalizeSettings, type Settings } from "../document/settings.js";
import { BUILTIN_TEMPLATES, applyTemplate, parseTemplate, serializeTemplate, templateFileName } from "../document/template.js";
import { colophonText } from "../engine/book-pages.js";
import { typeset } from "../engine/index.js";
import { DEFAULT_SPEC, layoutDocument } from "../engine/layout.js";
import { parse } from "../engine/parse.js";
import type { LayoutSpec } from "../engine/types.js";
import { FontService } from "../fonts/service.js";

const spec = (over: Partial<LayoutSpec> = {}): LayoutSpec => ({ ...DEFAULT_SPEC, ...over });
const face = new FontService().load(null).face;
const texts = (p: ReturnType<typeof layoutDocument>[number]) =>
  p.glyphs
    .filter((g) => g.kind === "vert")
    .map((g) => g.text)
    .join("");
const book = (over: (s: Settings) => void): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.layoutMode = "book";
  over(s);
  return s;
};

describe("ページ操作の記法（DTP-13）", () => {
  it("［＃改ページ］は ＝＝＝ と同じ", () => {
    const pages = layoutDocument(parse("あ\n［＃改ページ］\nい"), spec());
    assert.deepEqual(pages.map(texts), ["あ", "い"]);
  });

  it("［＃改丁］は次の奇数ページから始める（偶数ページは白ページにする）", () => {
    const pages = layoutDocument(parse("あ\n［＃改丁］\nい"), spec());
    assert.deepEqual(pages.map(texts), ["あ", "", "い"]);
    assert.equal(pages[1].role, "blank");
  });

  it("［＃白ページ］は白ページを1枚入れる。続けて書けばその枚数だけ入る", () => {
    const pages = layoutDocument(parse("あ\n［＃白ページ］\n［＃白ページ］\nい"), spec());
    assert.deepEqual(pages.map(texts), ["あ", "", "", "い"]);
    assert.deepEqual(pages.map((p) => p.role), ["body", "blank", "blank", "body"]);
  });

  it("原稿の最後の改ページで、空のページを作らない", () => {
    assert.equal(layoutDocument(parse("あ\n＝＝＝\n"), spec()).length, 1);
  });

  it("［＃扉］…［＃／扉］の行は1ページにまとめ、ページの中央に置く", () => {
    const s = spec({ linesPerPage: 15 });
    const pages = layoutDocument(parse("前\n［＃扉］\n第一章\n［＃／扉］\n後"), s);
    assert.deepEqual(pages.map(texts), ["前", "第一章", "後"]);
    assert.equal(pages[1].role, "tobira");
    const [first, , last] = pages[1].glyphs;
    const pitch = s.fontSizePt * s.lineGap;
    // 15行の中央（8行目）に置く。
    const right = pages[1].block.left + pages[1].block.width - s.fontSizePt / 2;
    assert.ok(Math.abs(right - first.x - 7 * pitch) < 1e-6, "横は中央の行");
    // 行の中でも中央（36字のうち3字なので、上に16.5字分空く）。
    assert.ok(Math.abs(first.y - pages[1].block.top - 16.5 * s.fontSizePt) < 1e-6, "縦も中央");
    assert.ok(last.y > first.y);
  });

  it("扉の中の大見出しは柱の章題になり、改丁なら奇数ページに置く", () => {
    const pages = layoutDocument(parse("前\n［＃扉］\n＃第一章\n［＃／扉］\n本文"), spec({ chapterStartsOdd: true }));
    assert.deepEqual(pages.map(texts), ["前", "", "第一章", "本文"]);
    assert.deepEqual(pages[2].headings, [{ level: 1, text: "第一章" }]);
  });

  it("扉の閉じ忘れは、次の改ページで閉じる", () => {
    const pages = layoutDocument(parse("［＃扉］\n題\n＝＝＝\n本文"), spec());
    assert.deepEqual(pages.map((p) => [texts(p), p.role]), [["題", "tobira"], ["本文", "body"]]);
  });

  it("1ページに収まらない扉は、ふつうに流し込む", () => {
    const many = Array.from({ length: 20 }, (_, i) => `行${i}`).join("\n");
    const pages = layoutDocument(parse(`［＃扉］\n${many}\n［＃／扉］\n後`), spec({ linesPerPage: 15 }));
    assert.equal(pages.length, 3);
    assert.equal(texts(pages[2]), "後");
  });
});

describe("本扉・奥付・ページ数合わせ（DTP-13）", () => {
  const info = { title: "縦書きの本", author: "山田花子", publisher: "たてぐみ堂", printer: "", issued: "2026年10月1日　初版発行", extra: "" };

  it("前に本扉と白ページ、後ろに奥付を入れる。扉・奥付には柱もノンブルも付けない", () => {
    const s = book((s) => {
      s.bookInfo = info;
      s.master.bodyOdd = "book-title";
      s.pages = { front: [{ kind: "title", text: "" }, { kind: "blank", text: "" }], back: [{ kind: "colophon", text: "" }], padTo: 1 };
    });
    const r = typeset("本文です。", s, face);
    assert.equal(r.pages.length, 4);
    const all = (i: number) => r.pages[i].items.map((it) => it.text).join("");
    assert.ok(all(0).startsWith("縦書きの本") && all(0).includes("山田花子"), "本扉に書名と著者名");
    assert.equal(all(1), "", "白ページ");
    // 本文ページ（3ページ目＝奇数）には柱（書誌の書名）とノンブル。
    assert.ok(all(2).includes("縦書きの本") && all(2).includes("3"));
    assert.ok(all(3).includes("初版発行") && all(3).includes("発行　たてぐみ堂"), "奥付");
    // ノンブル・柱は版面の外（天・地の余白）に置くので、奥付のページでは版面の外に何もない。
    const MMPT = 72 / 25.4;
    const top = s.book.topMm * MMPT;
    const bottom = top + bookGeometry(s.book).blockHeightMm * MMPT;
    assert.ok(r.pages[3].items.every((i) => i.y > top - 1 && i.y < bottom + 1), "奥付に柱・ノンブルはない");
    assert.ok(r.pages[2].items.some((i) => i.y > bottom + 1), "本文ページにはノンブルがある");
    assert.equal(r.lastPageLines, 1, "最終ページの行数は本文の最後のページで数える");
  });

  it("本扉の書名は大きく中央に、著者名は地付きに置く", () => {
    const s = book((s) => {
      s.bookInfo = info;
      s.pages.front = [{ kind: "title", text: "" }];
    });
    const [title] = typeset("本文", s, face).pages;
    const t = title.items.find((i) => i.text === "縦")!;
    const a = title.items.find((i) => i.text === "子")!;
    assert.ok(Math.abs(t.size - 2 * s.book.fontSizePt) < 1e-9);
    assert.ok(a.y > t.y, "著者名は書名より下（地付き）");
  });

  it("奥付は空の項目を出さない", () => {
    const text = colophonText({ ...info, publisher: "", issued: "" });
    assert.ok(!text.includes("発行"));
    assert.ok(text.includes("著者　山田花子"));
  });

  it("奥付は版面の左端（最後の行の側）に寄せる", () => {
    const s = book((s) => {
      s.bookInfo = info;
      s.pages.back = [{ kind: "colophon", text: "" }];
    });
    const r = typeset("本文", s, face);
    const page = r.pages[r.pages.length - 1];
    const leftmost = Math.min(...page.items.map((i) => i.x));
    // 3ページ目（奇数＝左ページ）は右側がノド。版面の左端は ページ幅 − ノド − 版面の幅。
    const MMPT = 72 / 25.4;
    const blockLeft = page.width - s.book.gutterMm * MMPT - bookGeometry(s.book).blockWidthMm * MMPT;
    // 字形の原点はマスの左寄りにあるので、版面の左端から1字分の中に入っていればよい。
    assert.ok(leftmost >= blockLeft - 1e-6 && leftmost < blockLeft + s.book.fontSizePt, `${leftmost} / ${blockLeft}`);
  });

  it("総ページ数を4の倍数にそろえる（白ページは本文と奥付の間に入る）", () => {
    const s = book((s) => {
      s.bookInfo = info;
      s.pages = { front: [{ kind: "title", text: "" }], back: [{ kind: "colophon", text: "" }], padTo: 4 };
    });
    const r = typeset("本文", s, face);
    // 扉1＋本文1＋白2＋奥付1 … ではなく、扉1＋本文1＋白1＋奥付1＝4
    assert.equal(r.pages.length, 4);
    assert.equal(r.pages[2].items.length, 0);
    assert.ok(r.pages[3].items.some((i) => i.text === "初"));
  });

  it("自由なページは原稿と同じ記法で書け、ページの中央に置く", () => {
    const s = book((s) => {
      s.pages.front = [{ kind: "free", text: "［＃太字］父に［＃／太字］" }];
    });
    const [page] = typeset("本文", s, face).pages;
    assert.deepEqual(page.items.map((i) => [i.text, !!i.bold]), [["父", true], ["に", true]]);
  });

  it("古い文書（ページ構成なし）は、前後に何も入らない", () => {
    const s = normalizeSettings({ layoutMode: "book" });
    assert.deepEqual(s.pages, { front: [], back: [], padTo: 1 });
    assert.equal(typeset("本文", s, face).pages.length, 1);
  });

  it("ページ構成の読み込みでは、知らない種類と範囲外の値を捨てる", () => {
    const s = normalizeSettings({ pages: { front: [{ kind: "title" }, { kind: "cover" }, null], back: "x", padTo: 3 } });
    assert.deepEqual(s.pages, { front: [{ kind: "title", text: "" }], back: [], padTo: 1 });
  });
});

describe("テンプレート（DTP-17）", () => {
  it("保存するときは書名と著者名を空にし、読み込むと設定が戻る", () => {
    const s = book((s) => {
      s.bookInfo = { title: "題", author: "著", publisher: "堂", printer: "印", issued: "", extra: "" };
      s.master.bookTitle = "柱";
      s.book.charsPerLine = 40;
    });
    const t = parseTemplate(serializeTemplate({ name: "私の文庫", settings: s }));
    assert.equal(t.name, "私の文庫");
    assert.equal(t.settings.book.charsPerLine, 40);
    assert.equal(t.settings.bookInfo.title, "");
    assert.equal(t.settings.bookInfo.author, "");
    assert.equal(t.settings.master.bookTitle, "");
    assert.equal(t.settings.bookInfo.publisher, "堂");
  });

  it("今の文書に当てると、書名・著者名は今のまま、ほかはテンプレートの設定になる", () => {
    const current = book((s) => {
      s.bookInfo.title = "今の本";
      s.bookInfo.author = "今の著者";
    });
    const applied = applyTemplate(current, BUILTIN_TEMPLATES[3].settings);
    assert.equal(applied.bookInfo.title, "今の本");
    assert.equal(applied.book.columns, 2);
    assert.equal(applied.pages.padTo, 4);
  });

  it("テンプレートでないファイルは読まない", () => {
    assert.throws(() => parseTemplate(JSON.stringify({ format: "tategumi-document", version: 1 })));
    assert.throws(() => parseTemplate(JSON.stringify({ format: "tategumi-template", version: 99 })));
  });

  it("ファイル名に使えない文字は置き換える", () => {
    assert.equal(templateFileName('A5/二段:組?'), "A5_二段_組_.tategumi-template");
    assert.equal(templateFileName("..."), "テンプレート.tategumi-template");
  });

  for (const t of BUILTIN_TEMPLATES) {
    it(`標準のテンプレート「${t.name}」は版面がページに収まり、余白が 5mm 以上ある`, () => {
      const g = bookGeometry(t.settings.book);
      for (const [k, v] of Object.entries({ 天: g.top, 地: g.bottom, ノド: g.gutter, 小口: g.foreEdge })) {
        assert.ok(v >= 5, `${k} ${v.toFixed(1)}mm`);
      }
      assert.ok(typeset("本文", t.settings, face).pages.length >= 3);
    });
  }
});
