import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SPEC, layoutDocument } from "../engine/layout.js";
import { parse, splitTableRow } from "../engine/parse.js";
import { texToMarkup } from "../engine/tex.js";
import type { Shape, TableBlock } from "../engine/types.js";

const text = (atoms: { cells: { text: string }[] }[]) => atoms.map((a) => a.cells.map((c) => c.text).join("")).join("");

describe("表", () => {
  it("行を欄に分ける。ルビの「｜」は区切りにしない", () => {
    assert.deepEqual(
      splitTableRow("| ｜吾輩《わがはい》は猫 ｜ 夏目漱石 |").map((c) => c.text),
      ["｜吾輩《わがはい》は猫", "夏目漱石"],
    );
    assert.deepEqual(splitTableRow("a|b|c").map((c) => c.text), ["a", "b", "c"]);
  });

  it("［＃表］…［＃／表］を読む。区切りの行より前は見出しの行（段落スタイル「表の見出し」）", () => {
    const lineOf: number[] = [];
    const blocks = parse("前\n［＃表］\n| 書名 | 年 |\n|---|---|\n| 羅生門 | 1915 |\n［＃／表］\n後", undefined, lineOf);
    assert.deepEqual(blocks.map((b) => b.kind), ["para", "table", "para"]);
    assert.deepEqual(lineOf, [0, 1, 6]);
    const t = blocks[1] as TableBlock;
    assert.equal(t.header, 1);
    assert.deepEqual(t.rows.map((r) => r.cells.map((c) => text(c.atoms))), [["書名", "年"], ["羅生門", "１９１５"]]);
    assert.equal(t.rows[0].cells[0].style, "表の見出し");
    assert.equal(t.rows[1].cells[0].style, "表");
    assert.equal(t.rows[1].line, 4);
  });

  it("閉じ忘れは空行で終わる", () => {
    const blocks = parse("［＃表］\n| a | b |\n\n本文");
    assert.deepEqual(blocks.map((b) => b.kind), ["table", "blank", "para"]);
  });

  it("組むと、欄の幅は中身に合わせ、長い欄だけ折り返す。罫線で囲む", () => {
    const spec = { ...DEFAULT_SPEC, charsPerLine: 12 };
    const [page] = layoutDocument(parse("［＃表］\n| あいうえおかきくけこさしすせそ | たち |\n| な | は |\n［＃／表］"), spec);
    const lines = page.lines.map((l) => l.text.replace(/　/g, ""));
    // 1行目の長い欄は折り返して2行、短い欄「たち」は折り返さない。
    assert.deepEqual(lines.slice(0, 3), ["あいうえおかきくたち", "けこさしすせそ", "なは"]);
    const rules = page.shapes.filter((s): s is Extract<Shape, { kind: "line" }> => s.kind === "line");
    assert.ok(rules.length >= 8);
    // 罫線は版面の字の並ぶ長さ（12字）を超えない。
    const top = page.block.top;
    for (const r of rules) assert.ok(Math.max(r.y1, r.y2) <= top + 12 * spec.fontSizePt + 1e-6);
  });

  it("TeX の tabular を表にする（1行目のあとの \\hline で見出し）", () => {
    const out = texToMarkup(String.raw`\begin{tabular}{l|r}
\hline
書名 & 年 \\
\hline
羅生門 & 1915 \\
\hline
\end{tabular}`).text;
    assert.equal(out, "［＃表］\n| 書名 | 年 |\n|---|---|\n| 羅生門 | 1915 |\n［＃／表］");
  });
});
