import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SPEC, breakLines, layoutDocument } from "../engine/layout.js";
import { parse, parseInline } from "../engine/parse.js";
import { GRID_TYPOGRAPHY, prepareSpacing, type Typography } from "../engine/spacing.js";
import type { Atom, Block, LayoutSpec } from "../engine/types.js";

const JIS: Typography = { mode: "jis", lineHeadBracket: "full", oikomi: true, rubyOverhang: true };

/** 1段落を読み、約物の詰めを決める。 */
function para(text: string, t: Typography = JIS): Atom[] {
  const block: Block = { kind: "para", atoms: parseInline(text) };
  prepareSpacing([block], t, 0.5);
  return block.atoms;
}
const widths = (atoms: Atom[]) => atoms.flatMap((a) => a.cells.map((c) => c.advance ?? 1));
const text = (atoms: Atom[]) => atoms.map((a) => a.cells.map((c) => c.text).join("")).join("");
const jisOpts = { kinsoku: "strong" as const, hanging: false, justify: true, oikomi: true, lineHeadHalf: false };

describe("約物の連続（JIS 準拠）", () => {
  it("終わり括弧・句読点のあとに約物が続くと、間のアキを半角にする", () => {
    assert.deepEqual(widths(para("あ」「い")), [1, 0.5, 1, 1]);
    assert.deepEqual(widths(para("あ。」")), [1, 0.5, 1]);
    assert.deepEqual(widths(para("あ、「い")), [1, 0.5, 1, 1]);
  });

  it("始め括弧が続くと、2つめの前のアキを取る", () => {
    const atoms = para("「「あ");
    assert.deepEqual(widths(atoms), [1, 0.5, 1]);
    assert.equal(atoms[1].cells[0].shift, -0.5, "字形は半角分上へ");
  });

  it("ベタ組みでは、すべて全角のまま", () => {
    assert.deepEqual(widths(para("あ」「い", GRID_TYPOGRAPHY)), [1, 1, 1, 1]);
  });

  it("設定を変えて組み直すと、前の設定の詰めは残らない", () => {
    const block: Block = { kind: "para", atoms: parseInline("あ」「い") };
    prepareSpacing([block], JIS, 0.5);
    prepareSpacing([block], GRID_TYPOGRAPHY, 0.5);
    assert.deepEqual(widths(block.atoms), [1, 1, 1, 1]);
  });
});

describe("追い込み・追い出し・両端揃え（JIS 準拠）", () => {
  it("行頭禁則の文字は、行内の約物を詰めて前の行に入れる（追い込み）", () => {
    // 5字の行に「あ、いうえ」＋「」」。読点のアキ（半角）を詰めれば」が入る。
    const lines = breakLines(para("あ、いうえ」お"), 5.5, 0, jisOpts);
    assert.equal(text(lines[0].atoms), "あ、いうえ」");
    assert.ok((lines[0].adjust ?? 0) < 0, "詰めて入れた行は adjust が負");
  });

  it("詰められる約物がなければ追い出し、短くなった行は字数まで広げる（両端揃え）", () => {
    const lines = breakLines(para("あいうえお」かき"), 5, 0, jisOpts);
    assert.deepEqual(lines.map((l) => text(l.atoms)), ["あいうえ", "お」かき"]);
    assert.equal(lines[0].adjust, 1, "1字分短いので、字間に1字分を配る");
    assert.equal(lines[1].adjust, 0, "段落の最後の行は広げない");
  });

  it("両端揃えした行は、最後の字が行末にそろう", () => {
    const spec: LayoutSpec = { ...DEFAULT_SPEC, charsPerLine: 5, typography: JIS, hanging: false };
    const blocks = parse("あいうえお」かき");
    prepareSpacing(blocks, JIS, 0.5);
    const [page] = layoutDocument(blocks, spec);
    const firstLine = page.glyphs.filter((g) => g.x === Math.max(...page.glyphs.map((p) => p.x)));
    const lastGlyph = firstLine[firstLine.length - 1];
    assert.ok(Math.abs(lastGlyph.y + spec.fontSizePt - (page.block.top + 5 * spec.fontSizePt)) < 1e-6);
  });

  it("段落の途中の行頭に来た始め括弧を半角にできる", () => {
    const lines = breakLines(para("あいうえ「おかき」"), 4, 0, { ...jisOpts, lineHeadHalf: true });
    assert.equal(text(lines[1].atoms).slice(0, 1), "「");
    assert.equal(lines[1].headTrim, 0.5);
  });
});

describe("ルビの掛け方（JIS 準拠）", () => {
  it("親文字より長いルビは、前後の仮名に掛ける（ルビ1字分まで）", () => {
    // 「剣」（1字）に4字のルビ（2字分）。前後が仮名なので、半字ずつ掛ければ親文字は広げずに済む。
    const atoms = para("の｜剣《つるぎや》を");
    const base = atoms[1];
    assert.equal(base.rubyBefore, 0.5);
    assert.equal(base.cells[0].advance ?? 1, 1, "親文字は広げない");
  });

  it("前後が漢字なら掛けずに、親文字の字間を空ける", () => {
    const atoms = para("本｜剣《つるぎや》書");
    const base = atoms[1];
    assert.equal(base.rubyBefore, 0);
    assert.equal(base.cells[0].advance, 2, "ルビの長さ（2字分）まで親文字を広げる");
    assert.equal(base.cells[0].shift, 0.5, "親文字は広げたマスの中央に置く");
  });

  it("掛けない設定にすると、仮名が隣でも親文字を広げる", () => {
    const atoms = para("の｜剣《つるぎや》を", { ...JIS, rubyOverhang: false });
    assert.equal(atoms[1].cells[0].advance, 2);
  });
});
