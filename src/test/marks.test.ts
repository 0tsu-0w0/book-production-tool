import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SPEC, layoutDocument } from "../engine/layout.js";
import { parse } from "../engine/parse.js";
import type { LayoutSpec, Shape } from "../engine/types.js";

const spec = (over: Partial<LayoutSpec> = {}): LayoutSpec => ({ ...DEFAULT_SPEC, ...over });
const lines = (shapes: Shape[]) => shapes.filter((s): s is Extract<Shape, { kind: "line" }> => s.kind === "line");

describe("圏点の種類と傍線（DTP-08）", () => {
  it("圏点の名前ごとに記号が変わる", () => {
    const [b] = parse("｜あ《白ゴマ》｜い《丸》｜う《白三角》｜え《圏》");
    assert.ok(b.kind === "para");
    assert.deepEqual(b.atoms.map((a) => a.kenten), ["﹆", "●", "△", "﹅"]);
    const [page] = layoutDocument([b], spec());
    assert.deepEqual(page.glyphs.filter((g) => g.kind === "mark").map((g) => g.text), ["﹆", "●", "△", "﹅"]);
  });

  it("傍線は続く字に1本で、字の右に引く", () => {
    const s = spec();
    const [page] = layoutDocument(parse("前｜大事な話《傍線》後"), s);
    const [line] = lines(page.shapes);
    const first = page.glyphs.find((g) => g.text === "大")!;
    const last = page.glyphs.find((g) => g.text === "話")!;
    assert.equal(lines(page.shapes).length, 1);
    assert.ok(line.x1 > first.x + s.fontSizePt / 2, "字の右");
    assert.ok(Math.abs(line.y1 - first.y) < 1e-6 && Math.abs(line.y2 - (last.y + s.fontSizePt)) < 1e-6, "大〜話の長さ");
    assert.equal(line.color, "", "色は文字の色（あとで決める）");
  });

  it("二重傍線は2本、点線と破線は破線の指定、波線は短い線の並び", () => {
    const shapesOf = (kind: string) => lines(layoutDocument(parse(`｜あいう《${kind}》`), spec())[0].shapes);
    assert.equal(shapesOf("二重傍線").length, 2);
    assert.ok(shapesOf("点線")[0].dash && shapesOf("破線")[0].dash);
    const wave = shapesOf("波線");
    assert.ok(wave.length > 10 && new Set(wave.map((l) => l.x1.toFixed(2))).size > 2, "左右に振れる");
  });

  it("行をまたぐ傍線は、行ごとに分かれる", () => {
    const [page] = layoutDocument(parse(`${"あ".repeat(34)}｜大事な話《傍線》`), spec({ charsPerLine: 36 }));
    assert.equal(lines(page.shapes).length, 2);
  });
});

describe("割注と縦中横（DTP-09）", () => {
  it("割注は半分の大きさの2行で、前半を右・後半を左に置き、2字で1字の半分の長さを取る", () => {
    const s = spec();
    const [page] = layoutDocument(parse("前［＃割注］あいうえお［＃／割注］後"), s);
    const g = (t: string) => page.glyphs.find((x) => x.text === t)!;
    const half = s.fontSizePt / 2;
    assert.equal(g("あ").size, half);
    assert.ok(g("あ").x > g("前").x && g("え").x < g("前").x, "前半は右、後半は左");
    assert.equal(g("あ").y, g("え").y);
    assert.ok(Math.abs(g("う").y - g("あ").y - 2 * half) < 1e-6);
    // 5字は3つの半角枠（1.5字分）。「後」は「前」の 2.5 字下。
    assert.ok(Math.abs(g("後").y - g("前").y - 2.5 * s.fontSizePt) < 1e-6);
  });

  it("行末に来た割注は、入るところまでで分け、残りを次の行で2行に組む", () => {
    const s = spec({ charsPerLine: 10 });
    const [page] = layoutDocument(parse(`${"本".repeat(8)}［＃割注］一二三四五六七八［＃／割注］`), s);
    const g = (t: string) => page.glyphs.find((x) => x.text === t)!;
    // 1行目の残りは2字分＝半角枠4つ＝8字…ではなく、2字分は枠4つで8字すべて入る。
    assert.ok(Math.abs(g("一").x - g("本").x) < s.fontSizePt, "割注は1行目に入る");
    const [page2] = layoutDocument(parse(`${"本".repeat(9)}［＃割注］一二三四五六七八［＃／割注］`), s);
    const h = (t: string) => page2.glyphs.find((x) => x.text === t)!;
    // 1行目の残り1字分＝枠2つ＝4字（一二が右、三四が左）。五〜八は次の行。
    assert.ok(Math.abs(h("一").y - h("三").y) < 1e-6);
    assert.ok(h("五").x < h("一").x - s.fontSizePt, "五は次の行");
  });

  it("［＃縦中横］で囲んだ字は、1字分に横に並べる", () => {
    const [b] = parse("第［＃縦中横］2B［＃／縦中横］号");
    assert.ok(b.kind === "para");
    assert.deepEqual(b.atoms[1].cells, [{ text: "2B", tcy: true, src: 1 }]);
  });
});
