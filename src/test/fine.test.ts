import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, fitBookToWritingMode, normalizeSettings } from "../document/settings.js";
import { hyphenPoints } from "../engine/hyphen.js";
import { Face, typesetLazy } from "../engine/index.js";
import { DEFAULT_SPEC, layoutDocument } from "../engine/layout.js";
import { parse } from "../engine/parse.js";
import type { Shape, TableBlock } from "../engine/types.js";
import { FontService } from "../fonts/service.js";

let face: Face | undefined;
try {
  face = new Face(new FontService().load(null).bytes);
} catch {
  face = undefined;
}

describe("英語のハイフネーション", () => {
  it("分けてよい位置を求める（句読点が付いていても）。短い語は分けない", () => {
    assert.deepEqual(hyphenPoints("hyphenation"), [2, 6]);
    assert.deepEqual(hyphenPoints("(hyphenation),"), [3, 7]);
    assert.deepEqual(hyphenPoints("small"), []);
    assert.deepEqual(hyphenPoints("日本語"), []);
  });

  it("横組みで、行末に入らない単語を「-」を付けて分ける。設定で切れる", { skip: !face && "フォントがない" }, () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.layoutMode = "book";
    s.book.writingMode = "horizontal";
    fitBookToWritingMode(s.book);
    s.book.charsPerLine = 12;
    const text = "　Typesetting internationalization requires understanding characteristically extraordinary hyphenation.";
    const lines = (st: typeof s) => typesetLazy(text, st, face!).lines(0).map((l) => l.text);
    const on = lines(s);
    assert.ok(on.some((t) => /[a-z]-$/.test(t)), JSON.stringify(on));
    // 分けた前半と後半をつなぐと、元の文になる。
    assert.equal(on.join("").replace(/([a-z])-(?=[a-z])/g, "$1").replace(/-$/, ""), text);
    s.book.hyphenation = false;
    assert.ok(!lines(s).some((t) => /[a-z]-$/.test(t)));
    assert.equal(normalizeSettings({}).book.hyphenation, true);
  });
});

describe("表の結合と罫線", () => {
  const rules = (shapes: Shape[]) => shapes.filter((s): s is Extract<Shape, { kind: "line" }> => s.kind === "line");

  it("［＃表：罫なし］・［＃表：行の罫］・［＃表：見出し二重線］を読む", () => {
    const opt = (o: string) => parse(`［＃表：${o}］\n| a | b |\n［＃／表］`)[0] as TableBlock;
    assert.equal(opt("罫なし").rules, "none");
    assert.equal(opt("行の罫").rules, "rows");
    assert.equal(opt("見出し二重線").headerDouble, true);
    assert.equal((parse("［＃表］\n| a |\n［＃／表］")[0] as TableBlock).rules, undefined);
  });

  it("罫なしなら線を引かない。行の罫なら欄の境目を引かない", () => {
    const lay = (o: string) => layoutDocument(parse(`［＃表${o}］\n| あ | い |\n| う | え |\n［＃／表］`), DEFAULT_SPEC)[0];
    assert.equal(rules(lay("：罫なし").shapes).length, 0);
    // 行の罫：線はすべて行に沿う（縦組みでは縦の線＝x が同じ）。
    const rows = rules(lay("：行の罫").shapes);
    assert.ok(rows.length > 0 && rows.every((r) => Math.abs(r.x1 - r.x2) < 1e-6));
    assert.ok(rules(lay("").shapes).some((r) => Math.abs(r.y1 - r.y2) < 1e-6));
  });

  it("「<」は左の欄と、「^」は上の欄とつなぐ（その間の線を引かない）", () => {
    const spec = { ...DEFAULT_SPEC, charsPerLine: 20 };
    const plain = layoutDocument(parse("［＃表］\n| あ | い |\n| う | え |\n［＃／表］"), spec)[0];
    const merged = layoutDocument(parse("［＃表］\n| あ | い |\n| ^ | < |\n［＃／表］"), spec)[0];
    // 結合した欄の「^」「<」は字として出さない。
    assert.ok(!merged.glyphs.some((g) => /[<^＜＾]/.test(g.text)));
    assert.ok(rules(merged.shapes).length < rules(plain.shapes).length);
  });
});
