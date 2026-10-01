import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, bookGeometry, toLayoutSpec, toPageDecor, type Settings } from "../document/settings.js";
import { decoratePage } from "../engine/decorate.js";
import { typeset } from "../engine/index.js";
import { FontService } from "../fonts/service.js";
import { DEFAULT_SPEC, MM, layoutDocument } from "../engine/layout.js";
import { parse } from "../engine/parse.js";
import type { LayoutSpec } from "../engine/types.js";

const spec = (over: Partial<LayoutSpec>): LayoutSpec => ({ ...DEFAULT_SPEC, ...over });
const face = new FontService().load(null).face;
const lines = (n: number) => Array.from({ length: n }, (_, i) => `行${i}`).join("\n");
const bodyGlyphs = (p: ReturnType<typeof layoutDocument>[number]) => p.glyphs.filter((g) => g.kind === "vert");

describe("段組（DTP-03）", () => {
  it("1段目の行数を埋めたら、同じページの2段目（下の段）へ続く", () => {
    const s = spec({ columns: 2, linesPerPage: 3, charsPerLine: 10, columnGapPt: 20 });
    const pages = layoutDocument(parse(lines(7)), s);
    assert.equal(pages.length, 2); // 1ページに 3行 × 2段 = 6行
    const first = bodyGlyphs(pages[0]).filter((g) => g.text === "行");
    const [line0, line3] = [first[0], first[3]];
    assert.equal(line0.x, line3.x, "2段目の1行目は、1段目の1行目と同じ横位置");
    assert.ok(Math.abs(line3.y - line0.y - (10 * s.fontSizePt + 20)) < 1e-6, "2段目は1段の高さ＋段間だけ下");
  });

  it("版面の高さは、段数 × 1段の高さ ＋ 段間", () => {
    const s = spec({ columns: 2, charsPerLine: 20, columnGapPt: 18 });
    const [page] = layoutDocument(parse("あ"), s);
    assert.ok(Math.abs(page.block.height - (2 * 20 * s.fontSizePt + 18)) < 1e-6);
  });
});

describe("天・ノドの余白（DTP-02）", () => {
  const s = spec({ margins: { topMm: 14, gutterMm: 12 }, firstPageNumber: 1 });

  it("奇数ページ（右綴じの左ページ）は右側が、偶数ページ（右ページ）は左側がノド", () => {
    const pages = layoutDocument(parse("あ\n＝＝＝\nい"), s);
    const [odd, even] = pages;
    assert.ok(Math.abs(odd.width - (odd.block.left + odd.block.width) - 12 * MM) < 1e-6);
    assert.ok(Math.abs(even.block.left - 12 * MM) < 1e-6);
    assert.ok(Math.abs(odd.block.top - 14 * MM) < 1e-6);
  });

  it("開始ページ番号が偶数なら、1ページ目は右ページになる", () => {
    const [first] = layoutDocument(parse("あ"), { ...s, firstPageNumber: 2 });
    assert.ok(Math.abs(first.block.left - 12 * MM) < 1e-6);
  });
});

describe("改丁（DTP-11）", () => {
  it("大見出しが偶数ページに来るときは、白ページを入れて奇数ページから始める", () => {
    const pages = layoutDocument(parse("本文\n＃第二章\n本文"), spec({ chapterStartsOdd: true, linesPerPage: 15 }));
    // 1ページ目：本文、2ページ目：白ページ、3ページ目：第二章
    assert.equal(pages.length, 3);
    assert.equal(pages[1].lineCount, 0);
    assert.ok(bodyGlyphs(pages[2]).some((g) => g.text === "第"));
  });

  it("もともと奇数ページに当たるなら、白ページは入れない", () => {
    const pages = layoutDocument(parse("＃第一章\n本文"), spec({ chapterStartsOdd: true }));
    assert.equal(pages.length, 1);
  });

  it("白ページにはノンブルを付けない（設定で付けることもできる）", () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, chapterStartsOdd: true };
    const run = (blankPageNombre: boolean) => {
      const pages = layoutDocument(parse("本文\n＃第二章\n本文"), toLayoutSpec(settings));
      pages.forEach((p) => decoratePage(p, { ...toPageDecor(settings), blankPageNombre }, 9));
      return pages[1].glyphs.filter((g) => g.kind === "horiz").map((g) => g.text);
    };
    assert.deepEqual(run(false), []);
    assert.deepEqual(run(true), ["2"]);
  });
});

describe("柱とマスターページ（DTP-05）", () => {
  // 1ページ15行の文庫。第一章は1〜2ページ（30行）、第二章（中見出しつき）は3ページ目から始まる。
  const body = (n: number) => Array.from({ length: n }, () => "あ").join("\n");
  const text = ["＃第一章　出会い", body(29), "＃第二章　別れ", "＃＃駅にて", body(20)].join("\n");
  const make = (master: Partial<Settings["master"]> = {}) => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      layoutMode: "book",
      master: { ...DEFAULT_SETTINGS.master, bookTitle: "雨の図書館", ...master },
    };
    return typeset(text, settings, face).pages;
  };
  const texts = (page: { items: { text: string; font: string; x: number }[] }) =>
    page.items.filter((i) => i.font === "horiz").map((i) => i.text);

  it("本文ページは、奇数ページに章題、偶数ページに書名。章の始まりのページには柱を出さない", () => {
    const pages = make();
    assert.equal(pages.length, 4);
    assert.deepEqual(texts(pages[0]), ["1"]); // 第一章の始まり：ノンブルだけ
    assert.deepEqual(texts(pages[1]), ["雨の図書館", "2"]);
    assert.deepEqual(texts(pages[2]), ["3"]); // 第二章の始まり
    assert.deepEqual(texts(pages[3]), ["雨の図書館", "4"]);
  });

  it("章題は、そのページの時点の大見出し", () => {
    const pages = make({ bodyEven: "chapter" });
    assert.deepEqual(texts(pages[1]), ["第一章　出会い", "2"]);
    assert.deepEqual(texts(pages[3]), ["第二章　別れ", "4"]);
  });

  it("節題を選ぶと、そのページまでの最後の中見出しを出す（なければ章題）", () => {
    const pages = make({ bodyEven: "section", openingOdd: "section" });
    assert.deepEqual(texts(pages[1]), ["第一章　出会い", "2"]);
    assert.deepEqual(texts(pages[2]), ["駅にて", "3"]);
  });

  it("柱とノンブルは小口側：奇数ページ（左）は左寄り、偶数ページ（右）は右寄り", () => {
    const pages = make({ bodyOdd: "book-title", openingOdd: "book-title" });
    const find = (i: number, t: string) => pages[i].items.find((it) => it.text === t)!;
    const mid = pages[0].width / 2;
    assert.ok(find(1, "雨の図書館").x > mid && find(1, "2").x > mid, "偶数ページの柱とノンブルは右寄り");
    assert.ok(find(2, "雨の図書館").x < mid && find(2, "3").x < mid, "奇数ページの柱とノンブルは左寄り");
  });

  it("柱を小口の余白に縦書きで置ける", () => {
    const pages = make({ headPosition: "fore-edge", bodyEven: "book-title" });
    const vertical = pages[1].items.filter((i) => i.font === "vert" && "雨の図書館".includes(i.text));
    assert.ok(vertical.length >= 5);
  });

  it("かんたんな組み方では、マスターページを使わず付記とノンブルを出す", () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, note1: "付記", master: { ...DEFAULT_SETTINGS.master, bookTitle: "書名" } };
    const pages = typeset(text, settings, face).pages;
    assert.deepEqual(texts(pages[0]), ["付記", "1"]);
  });
});

describe("判型と版面の設定", () => {
  it("詳しい組み方では、判型の寸法と段組が組版の指定になる", () => {
    const s: Settings = { ...DEFAULT_SETTINGS, layoutMode: "book", book: { ...DEFAULT_SETTINGS.book, trim: "新書", columns: 2 } };
    const l = toLayoutSpec(s);
    assert.deepEqual([l.pageWidthMm, l.pageHeightMm, l.columns], [103, 182, 2]);
    assert.ok(l.margins);
  });

  it("かんたんな組み方は、これまでどおり文庫・版面中央", () => {
    const l = toLayoutSpec(DEFAULT_SETTINGS);
    assert.deepEqual([l.pageWidthMm, l.pageHeightMm, l.columns, l.margins], [105, 148, 1, null]);
  });

  it("余白は四方で合計すると判型の寸法になる", () => {
    const g = bookGeometry(DEFAULT_SETTINGS.book);
    assert.ok(Math.abs(g.top + g.blockHeightMm + g.bottom - 148) < 1e-9);
    assert.ok(Math.abs(g.gutter + g.blockWidthMm + g.foreEdge - 105) < 1e-9);
    assert.ok(g.bottom > 5 && g.foreEdge > 5, "既定の版面は文庫に収まる");
  });
});
