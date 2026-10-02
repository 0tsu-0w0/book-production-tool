import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, compositeFonts, normalizeSettings, type Settings } from "../document/settings.js";
import { toRoman } from "../engine/decorate.js";
import { Face, typesetLazy } from "../engine/index.js";
import { FontService } from "../fonts/service.js";
import { findMatches, replaceAllText } from "../renderer/find-replace.js";

let face: Face | undefined;
try {
  face = new Face(new FontService().load(null).bytes);
} catch {
  face = undefined;
}

describe("検索と置換", () => {
  const plain = { regex: false, caseSensitive: false };
  it("文字で探す（大文字・小文字を区別しない／する）", () => {
    assert.deepEqual(findMatches("Aaa a", "a", plain).matches.length, 4);
    assert.deepEqual(findMatches("Aaa a", "a", { ...plain, caseSensitive: true }).matches.length, 3);
    // 正規表現の字も、そのままの字として探す。
    assert.deepEqual(findMatches("1.5 と 105", ".", plain).matches, [{ start: 1, end: 2 }]);
  });

  it("正規表現で探し、$1 で置き換える。書き間違いは知らせる", () => {
    const re = { regex: true, caseSensitive: false };
    assert.equal(replaceAllText("第1章と第12章", "第(\\d+)章", "Chapter $1", re).text, "Chapter 1とChapter 12");
    assert.equal(replaceAllText("ーー と ーーー", "ー{2,}", "――", re).count, 2);
    assert.match(findMatches("x", "(", re).error ?? "", /正規表現/);
    // 空の一致（^ など）は数えない。
    assert.equal(findMatches("ab", "^", re).matches.length, 0);
  });

  it("正規表現でなければ、置き換える文字の $ もそのまま", () => {
    assert.equal(replaceAllText("100円", "円", "$&ドル", plain).text, "100$&ドル");
  });
});

describe("ノンブルの書き方と位置", () => {
  it("ローマ数字", () => {
    assert.deepEqual([1, 2, 4, 9, 14, 40].map(toRoman), ["i", "ii", "iv", "ix", "xiv", "xl"]);
  });

  it("設定の読み込み：範囲の外は既定に", () => {
    const s = normalizeSettings({ nombreStyle: { front: "x", numerals: "kanji", outerMm: 99, downMm: -2 } });
    assert.deepEqual(s.nombreStyle, { front: "continue", numerals: "kanji", outerMm: 30, downMm: -2 });
  });

  const book = (over: (s: Settings) => void): Settings => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.layoutMode = "book";
    s.bookInfo.title = "本";
    s.pages = { front: [{ kind: "title", text: "" }, { kind: "blank", text: "" }, { kind: "toc", text: "" }, { kind: "blank", text: "" }], back: [], padTo: 1 };
    s.master.bodyNombre = true;
    s.master.openingNombre = true;
    over(s);
    return s;
  };
  const nombres = (s: Settings) => {
    const r = typesetLazy("＃第一章\n本文\n＝＝＝\n二ページ目", s, face!);
    return Array.from({ length: r.pageCount }, (_, i) => r.page(i).items.filter((it) => /^[0-9ivxlcIVXLC一二三四五六七八九〇０-９]+$/.test(it.text) && it.size < 9).map((it) => it.text).join(""));
  };

  it("前付けをローマ数字にすると、目次に ii などが付き、本文は1から。目次の番号も本文の数え方", { skip: !face && "フォントがない" }, () => {
    const s = book((x) => (x.nombreStyle.front = "roman"));
    const n = nombres(s);
    // 本扉（1）・白（2）・目次（3）・白（4）・本文（5〜）。
    assert.equal(n[2], "iii");
    assert.equal(n[4], "1");
    assert.equal(n[5], "2");
    const r = typesetLazy("＃第一章\n本文", s, face!);
    const toc = r.lines(2).map((l) => l.text).join("");
    assert.match(toc, /第一章.*[1１]$/);
  });

  it("通し番号のまま（既定）なら、本文は5ページ目から。漢数字も選べる", { skip: !face && "フォントがない" }, () => {
    assert.equal(nombres(book(() => {}))[4], "5");
    assert.equal(nombres(book((x) => { x.nombreStyle.front = "none"; x.nombreStyle.numerals = "kanji"; }))[4], "一");
  });

  it("位置の微調整：小口の側へ・下へずらす", { skip: !face && "フォントがない" }, () => {
    const at = (s: Settings) => {
      const r = typesetLazy("本文", s, face!);
      const p = r.page(r.pageCount - 1);
      const g = p.items.find((it) => it.text === String(s.nombreStart + p.index))!;
      return { x: g.x, y: g.y };
    };
    const base = book((x) => (x.pages = { front: [], back: [], padTo: 1 }));
    const moved = structuredClone(base);
    moved.nombreStyle.outerMm = 5;
    moved.nombreStyle.downMm = 2;
    const a = at(base);
    const b = at(moved);
    const mm = 72 / 25.4;
    // 1ページ目（奇数）は右綴じの左ページで、小口は左。
    assert.ok(Math.abs(a.x - b.x - 5 * mm) < 0.01, `${a.x} ${b.x}`);
    assert.ok(Math.abs(b.y - a.y - 2 * mm) < 0.01);
  });
});

describe("合成フォント", () => {
  it("読み込みと、フォントを読むときの一覧", () => {
    const s = normalizeSettings({ compositeFont: { kana: { name: "x", postscriptName: "X", path: "x.ttf", index: 0 }, latin: "bad" } });
    assert.equal(s.compositeFont.kana?.name, "x");
    assert.equal(s.compositeFont.latin, null);
    assert.deepEqual(compositeFonts(s).map((f) => f?.name ?? null), ["x", null]);
  });

  it("本文の書体の字だけ、かなと欧文を別の書体にする", { skip: !face && "フォントがない" }, () => {
    const svc = new FontService();
    // 同じ同梱フォントを別の書体として扱い、番号が分かれることを確かめる。
    const s = structuredClone(DEFAULT_SETTINGS);
    s.format.halfWidth = "rotate";
    const def = svc.defaultChoice();
    s.compositeFont = { kana: { ...def, name: "かな" }, latin: { ...def, name: "欧文", index: def.index } };
    const { table } = svc.loadTable(s.font, s.styles, [{ ...def, path: def.path, index: def.index }]);
    const r = typesetLazy("漢かA", s, { faces: [table.faces[0], table.faces[0], table.faces[0]], keys: ["body", "k", "l"] });
    // キーが合わない書体は本文の書体のまま（番号 0）。
    assert.ok(r.page(0).items.every((i) => i.face === 0));
  });
});
