import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { combineBook, docLabel, newBook, parseBook, serializeBook, type Book, type BookDocument } from "../document/book.js";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { Face, typesetLazy } from "../engine/index.js";
import { FontService } from "../fonts/service.js";

let face: Face | undefined;
try {
  face = new Face(new FontService().load(null).bytes);
} catch {
  face = undefined;
}

const doc = (name: string, text: string, over: (s: Settings) => void = () => {}, images: BookDocument["images"] = []): BookDocument => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  over(settings);
  return { name, text, settings, images, tex: settings.format.markup === "tex" };
};
const img = (name: string) => ({ name, mime: "image/png" as const, data: "", width: 10, height: 10 });
const book = (n: number, over: Partial<Book> = {}): Book => ({ ...newBook(), documents: Array.from({ length: n }, (_, i) => ({ path: `ch${i + 1}.kolophon`, include: true })), ...over });

describe("ブック", () => {
  it("書き出して読み直せる。壊れたもの・ほかの形式は読まない", () => {
    const b = book(2, { styleSource: 1, startOdd: false });
    assert.deepEqual(parseBook(serializeBook(b)), b);
    assert.throws(() => parseBook("{"), /読めません/);
    assert.throws(() => parseBook('{"format":"x"}'), /ブックではありません/);
    // スタイルの元の番号が範囲の外なら最初の文書。
    assert.equal(parseBook(JSON.stringify({ format: "tategumi-book", documents: [{ path: "a" }], styleSource: 5 })).styleSource, 0);
  });

  it("文書をつなぐ：間は改丁、頭にラベル。含めない文書は飛ばす。設定はスタイルの元のもの", () => {
    const b = book(3, { styleSource: 1 });
    b.documents[2].include = false;
    const c = combineBook(b, [doc("ch1", "一章"), doc("ch2", "二章", (s) => (s.nombreStart = 5)), doc("ch3", "三章")]);
    assert.equal(c.text, `［＃改丁］\n［＃ラベル：${docLabel(0)}］\n一章\n［＃改丁］\n［＃ラベル：${docLabel(1)}］\n二章`);
    assert.deepEqual(c.included, [0, 1]);
    assert.equal(c.settings.nombreStart, 5);
    assert.equal(combineBook({ ...b, startOdd: false }, [doc("a", "x"), doc("b", "y"), undefined]).text.includes("［＃改ページ］"), true);
  });

  it("TeX の文書は Kolophon の記法にしてからつなぐ", () => {
    const c = combineBook(book(1), [doc("t", String.raw`\chapter{序}本文`, (s) => (s.format.markup = "tex"))]);
    assert.match(c.text, /＃序/);
    assert.equal(c.settings.format.markup, "standard");
  });

  it("名前の重なった画像は「文書名_名前」に付け替え、その文書の参照も書き換える", () => {
    const c = combineBook(book(2), [doc("ch1.kolophon", "［＃画像：猫］", () => {}, [img("猫")]), doc("ch2.kolophon", "［＃画像：猫　全面］", () => {}, [img("猫")])]);
    assert.deepEqual(c.images.map((i) => i.name), ["猫", "ch2_猫"]);
    assert.match(c.text, /［＃画像：ch2_猫　全面］/);
    assert.match(c.text, /［＃画像：猫］/);
    assert.deepEqual(c.renamed, [{ doc: "ch2.kolophon", from: "猫", to: "ch2_猫" }]);
  });

  it("組むと、ページ番号は文書をまたいで続き、文書ごとの始まりのページが分かる。目次は本全体", { skip: !face && "フォントがない" }, () => {
    const long = "　本文。".repeat(600);
    const c = combineBook(book(2), [doc("ch1", `［＃目次］\n＃第一章\n${long}`), doc("ch2", `＃第二章\n${long}`)]);
    const r = typesetLazy(c.text, c.settings, face!);
    const starts = r.labelPages();
    const s1 = starts.get(docLabel(0))!;
    const s2 = starts.get(docLabel(1))!;
    assert.ok(s2 > s1 + 1);
    // 改丁：2つめの文書は奇数ページ（ノンブル）から。
    assert.equal((c.settings.nombreStart + s2) % 2, 1);
    // 目次に第二章が載る。
    const toc = r.lines(starts.get(docLabel(0))!).map((l) => l.text).join("");
    assert.match(toc, /第二章/);
  });
});
