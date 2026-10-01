import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePageRange } from "../document/range.js";
import { DEFAULT_SPEC, layoutDocument } from "../engine/layout.js";
import { parse, rubyAtoms } from "../engine/parse.js";

describe("熟語ルビ（DTP-07）", () => {
  it("読みを親文字の数に区切り、どれも2字までなら1字ずつのモノルビにする", () => {
    assert.deepEqual(
      rubyAtoms(["漢", "字"], "かん|じ").map((a) => [a.cells.map((c) => c.text).join(""), a.ruby]),
      [
        ["漢", "かん"],
        ["字", "じ"],
      ],
    );
  });

  it("親文字に収まらない読みがあれば、熟語全体のグループルビにする（区切りは外す）", () => {
    assert.deepEqual(
      rubyAtoms(["東", "京"], "とう|きょう").map((a) => [a.cells.map((c) => c.text).join(""), a.ruby]),
      [["東京", "とうきょう"]],
    );
    // 区切りの数が親文字の数と合わないときも、グループルビ。
    assert.deepEqual(rubyAtoms(["明", "日"], "あ|し|た")[0].ruby, "あした");
  });

  it("記法から：｜と省略形のどちらでも、モノルビの字の間で改行できる", () => {
    const [a] = parse("｜漢字《かん|じ》");
    const [b] = parse("漢字《かん|じ》");
    assert.ok(a.kind === "para" && b.kind === "para");
    assert.equal(a.atoms.length, 2);
    assert.equal(b.atoms.length, 2);
    // 1行1字なら「漢」と「字」は別の行になる（グループルビなら分かれない）。
    const [page] = layoutDocument([a], { ...DEFAULT_SPEC, charsPerLine: 1 });
    const xs = new Set(page.glyphs.filter((g) => g.text === "漢" || g.text === "字").map((g) => g.x));
    assert.equal(xs.size, 2);
  });
});

describe("書き出すページの範囲（OUT-07）", () => {
  const range = (t: string, first = 1, count = 30) => [...parsePageRange(t, first, count)].sort((a, b) => a - b);

  it("空なら全ページ。ノンブルで書き、0始まりの番号にする", () => {
    assert.equal(range("").length, 30);
    assert.deepEqual(range("1-3, 5"), [0, 1, 2, 4]);
    assert.deepEqual(range("28-"), [27, 28, 29]);
    assert.deepEqual(range("-2"), [0, 1]);
  });

  it("全角の数字・波ダッシュ・読点も読み、開始番号を考える", () => {
    assert.deepEqual(range("３〜４、６", 3, 10), [0, 1, 3]);
  });

  it("読めない範囲・逆向き・ページのない範囲は知らせる", () => {
    assert.throws(() => range("a-b"), /読めません/);
    assert.throws(() => range("5-2"), /後ろ/);
    assert.throws(() => range("100-200"), /ありません/);
  });
});

describe("名前を付けたマスターページ（DTP-05）", () => {
  const book = async () => {
    const { DEFAULT_SETTINGS } = await import("../document/settings.js");
    const s = structuredClone(DEFAULT_SETTINGS);
    s.layoutMode = "book";
    s.master.bookTitle = "書名";
    s.master.bodyOdd = "book-title";
    s.master.bodyEven = "book-title";
    s.masters = [
      { name: "付録", bodyOdd: "none", bodyEven: "none", bodyNombre: false, openingOdd: "none", openingEven: "none", openingNombre: false, decoration: "inherit" },
    ];
    return s;
  };

  it("［＃マスター：名前］のページから、そのマスターの柱とノンブルになる。［＃マスター：標準］で戻る", async () => {
    const { typeset } = await import("../engine/index.js");
    const { FontService } = await import("../fonts/service.js");
    const face = new FontService().load(null).face;
    const r = typeset("本文\n＝＝＝\n［＃マスター：付録］\n付録\n＝＝＝\n［＃マスター：標準］\nまた本文", await book(), face);
    const has = (i: number, t: string) => r.pages[i].items.some((x) => x.text.includes(t));
    assert.ok(has(0, "書名"), "1ページ目は標準：柱あり");
    assert.ok(!has(1, "書名") && !r.pages[1].items.some((x) => /^\d+$/.test(x.text)), "2ページ目は付録：柱もノンブルもなし");
    assert.ok(has(2, "書名"), "3ページ目は標準に戻る");
  });

  it("ページの途中で切り替えたら、次のページから", () => {
    const pages = layoutDocument(parse("あ\n［＃マスター：付録］\nい\n＝＝＝\nう"), DEFAULT_SPEC);
    assert.deepEqual(pages.map((p) => p.master), [undefined, "付録"]);
  });

  it("読み込みでは、名前のないもの・重複・「標準」を捨てる", async () => {
    const { normalizeSettings } = await import("../document/settings.js");
    const s = normalizeSettings({ masters: [{ name: "付録" }, { name: "付録" }, { name: "標準" }, { name: "" }, { foo: 1 }] });
    assert.deepEqual(s.masters.map((m) => m.name), ["付録"]);
    assert.equal(s.masters[0].decoration, "inherit");
  });
});

describe("画像を偶数・奇数ページに置く（DTP-12）", () => {
  it("偶数を指定した全面の画像は偶数ページに置き、次の改丁の章扉と向かい合う", () => {
    const spec = { ...DEFAULT_SPEC, chapterStartsOdd: true };
    // 1ページ目（奇数）に本文。画像は偶数の2ページ目、章扉は奇数の3ページ目。
    const pages = layoutDocument(parse("本文\n［＃画像：絵　全面　偶数］\n［＃扉］\n＃第一章\n［＃／扉］"), spec);
    assert.deepEqual(pages.map((p) => p.role), ["body", "image", "tobira"]);
  });

  it("合わなければ白ページを1枚入れる", () => {
    const pages = layoutDocument(parse("本文\n［＃画像：絵　版面　奇数］"), DEFAULT_SPEC);
    assert.deepEqual(pages.map((p) => p.role), ["body", "blank", "image"]);
  });
});
