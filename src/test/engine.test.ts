import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SPEC, breakLines, layoutDocument, type Line } from "../engine/layout.js";
import { parse, parseInline } from "../engine/parse.js";
import type { Atom } from "../engine/types.js";

const text = (atoms: Atom[]) => atoms.map((a) => a.cells.map((c) => c.text).join("")).join("");
const lineTexts = (lines: Line[]) => lines.map((l) => text(l.atoms));
const strong = { kinsoku: "strong" as const, hanging: true };

describe("parseInline", () => {
  it("｜ 付きのルビ", () => {
    const [a] = parseInline("｜図書館《としょかん》");
    assert.equal(text([a]), "図書館");
    assert.equal(a.ruby, "としょかん");
  });

  it("｜ を省いたルビは、直前の漢字の連なりを親文字にする", () => {
    const atoms = parseInline("あの司書《ししょ》");
    assert.equal(atoms.length, 3);
    assert.equal(text([atoms[2]]), "司書");
    assert.equal(atoms[2].ruby, "ししょ");
  });

  it("[[rb:]] 形式のルビ", () => {
    const [a] = parseInline("[[rb:柊 > ひいらぎ]]");
    assert.equal(text([a]), "柊");
    assert.equal(a.ruby, "ひいらぎ");
  });

  it("圏点は1文字ずつに付く", () => {
    const atoms = parseInline("｜本当《圏》");
    assert.deepEqual(atoms.map((a) => a.kenten), ["﹅", "﹅"]);
  });

  it("2〜3桁の数字だけを縦中横にする", () => {
    const atoms = parseInline("3日12月2026年");
    const tcy = atoms.filter((a) => a.cells[0].tcy).map((a) => a.cells[0].text);
    assert.deepEqual(tcy, ["12"]);
    assert.equal(text(atoms), "３日12月２０２６年");
  });

  it("感嘆符・疑問符の2つ組は縦中横", () => {
    const atoms = parseInline("え！？");
    assert.equal(atoms[1].cells[0].text, "!?");
    assert.equal(atoms[1].cells[0].tcy, true);
  });

  it("「――」は2マスで1組", () => {
    const atoms = parseInline("――あ");
    assert.equal(atoms[0].cells.length, 2);
  });
});

describe("parse", () => {
  it("見出し・改ページ・空行を段落と区別する", () => {
    const kinds = parse("＃第一章\n本文\n\n＝＝＝\n＃＃節\n").map((b) => b.kind);
    assert.deepEqual(kinds, ["heading", "para", "blank", "pagebreak", "heading"]);
  });
});

describe("breakLines", () => {
  it("行頭に句読点が来るときは、ぶら下げで同じ行に入れる", () => {
    const lines = breakLines(parseInline("あいうえお。かき"), 5, 0, strong);
    assert.deepEqual(lineTexts(lines), ["あいうえお。", "かき"]);
  });

  it("ぶら下げを使わないときは、前の文字ごと次の行へ送る", () => {
    const lines = breakLines(parseInline("あいうえお。かき"), 5, 0, { kinsoku: "strong", hanging: false });
    assert.deepEqual(lineTexts(lines), ["あいうえ", "お。かき"]);
  });

  it("閉じ括弧が行頭に来ないようにする", () => {
    const lines = breakLines(parseInline("あいうえお」かき"), 5, 0, strong);
    assert.deepEqual(lineTexts(lines), ["あいうえ", "お」かき"]);
  });

  it("始め括弧を行末に残さない", () => {
    const lines = breakLines(parseInline("あいうえ「おかき"), 5, 0, strong);
    assert.deepEqual(lineTexts(lines), ["あいうえ", "「おかき"]);
  });

  it("小書きの仮名は強い禁則でだけ行頭を避ける", () => {
    const src = parseInline("あいうえおっか");
    assert.deepEqual(lineTexts(breakLines(src, 5, 0, strong)), ["あいうえ", "おっか"]);
    assert.deepEqual(lineTexts(breakLines(src, 5, 0, { kinsoku: "weak", hanging: true })), ["あいうえお", "っか"]);
  });

  it("続けて禁則文字が並ぶときも行頭に来させない", () => {
    const lines = breakLines(parseInline("あいうえお」。か"), 5, 0, { kinsoku: "strong", hanging: false });
    assert.deepEqual(lineTexts(lines), ["あいうえ", "お」。か"]);
  });

  it("ルビ付きの親文字列は行をまたがない", () => {
    const lines = breakLines(parseInline("あいう｜図書館《としょかん》"), 5, 0, strong);
    assert.deepEqual(lineTexts(lines), ["あいう", "図書館"]);
  });

  it("見出しは字下げした位置から始める", () => {
    const lines = breakLines(parseInline("あいうえお"), 5, 3, strong);
    assert.deepEqual(lineTexts(lines), ["あい", "うえ", "お"]);
  });
});

describe("layoutDocument", () => {
  it("1ページの行数を超えたら次のページへ送る", () => {
    const src = Array.from({ length: 20 }, () => "あ").join("\n");
    const pages = layoutDocument(parse(src), DEFAULT_SPEC);
    assert.equal(pages.length, 2);
    assert.equal(pages[0].glyphs.filter((g) => g.kind === "vert").length, 15);
  });

  it("改ページの記号で次のページへ送る", () => {
    const pages = layoutDocument(parse("あ\n＝＝＝\nい"), DEFAULT_SPEC);
    assert.equal(pages.length, 2);
  });

  it("1行目は版面の右端、2行目はその左に置く", () => {
    const [page] = layoutDocument(parse("あ\nい"), DEFAULT_SPEC);
    const [a, i] = page.glyphs.filter((g) => g.kind === "vert");
    assert.ok(a.x > i.x);
    assert.ok(Math.abs(a.x - i.x - DEFAULT_SPEC.fontSizePt * DEFAULT_SPEC.lineGap) < 1e-9);
  });
});
