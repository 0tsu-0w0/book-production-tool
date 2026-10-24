import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../document/settings.js";
import { Face, typesetLazy } from "../engine/index.js";
import { indexGroup, sortIndex } from "../engine/indexing.js";
import { parse, parseInline, splitIndexTerm } from "../engine/parse.js";
import { texToMarkup } from "../engine/tex.js";
import { FontService } from "../fonts/service.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}

describe("索引", () => {
  it("［＃索引］…［＃／索引］は囲んだ語を、読みはルビから。［＃索引：語（よみ）］は印だけ（前の字に付ける）", () => {
    const atoms = parseInline("雨の［＃索引］｜図書館《としょかん》［＃／索引］と猫［＃索引：猫（ねこ）］。");
    const entries = atoms.flatMap((a) => a.index ?? []);
    assert.deepEqual(entries, [
      { term: "図書館", reading: "としょかん" },
      { term: "猫", reading: "ねこ" },
    ]);
    // 印は本文に字を足さない。
    assert.equal(atoms.map((a) => a.cells.map((c) => c.text).join("")).join(""), "雨の図書館と猫。");
    assert.deepEqual(splitIndexTerm("活版｜かっぱん"), { term: "活版", reading: "かっぱん" });
    assert.deepEqual(splitIndexTerm("あめ"), { term: "あめ", reading: "あめ" });
  });

  it("ルビの親字の中の［＃索引：…］・［＃ラベル：…］は注記として読み、親字には残さない", () => {
    const text = (atoms: ReturnType<typeof parseInline>) => atoms.map((a) => a.cells.map((c) => c.text).join("")).join("");
    // 熟語ルビ：Atom は一つ。
    const a = parseInline("その日、｜図書館［＃索引：図書館（としょかん）］《としょかん》の窓");
    assert.equal(text(a), "その日、図書館の窓");
    const rb = a.find((x) => x.ruby === "としょかん")!;
    assert.equal(rb.cells.map((c) => c.text).join(""), "図書館");
    assert.deepEqual(rb.index, [{ term: "図書館", reading: "としょかん" }]);
    // 「語｜よみ」の形でも親字の区切りにしない。ラベルも付く。
    const b = parseInline("｜活版［＃索引：活版｜かっぱん］［＃ラベル：kappan］《かっぱん》");
    assert.equal(text(b), "活版");
    assert.deepEqual(b[0].index, [{ term: "活版", reading: "かっぱん" }]);
    assert.equal(b[0].label, "kappan");
    // モノルビ：注記の直前の字に付ける。
    const c = parseInline("｜図［＃索引：図（ず）］書《と|しょ》");
    assert.equal(text(c), "図書");
    assert.deepEqual(c[0].index, [{ term: "図", reading: "ず" }]);
    assert.equal(c[1].index, undefined);
    // 圏点にも。
    const d = parseInline("｜大事［＃索引：大事（だいじ）］《ゴマ》");
    assert.equal(text(d), "大事");
    assert.deepEqual(d[1].index, [{ term: "大事", reading: "だいじ" }]);
  });

  it("五十音の行に分け、読みの順に並べる（濁点・小さい字は清音と同じ位置。英数字とその他は後ろ）", () => {
    assert.equal(indexGroup("がっこう"), "か");
    assert.equal(indexGroup("ヴァイオリン"), "あ");
    assert.equal(indexGroup("PDF"), "英数字");
    const sorted = sortIndex(
      [
        ["猫", "ねこ"],
        ["学校", "がっこう"],
        ["傘", "かさ"],
        ["雨", "あめ"],
        ["PDF", "PDF"],
        ["鍵", "かぎ"],
      ].map(([term, reading]) => ({ term, reading, ids: [] })),
    );
    assert.deepEqual(
      sorted.map((g) => [g.group, g.entries.map((e) => e.term)]),
      [
        ["あ", ["雨"]],
        ["か", ["鍵", "傘", "学校"]],
        ["な", ["猫"]],
        ["英数字", ["PDF"]],
      ],
    );
  });

  it("［＃索引ページ］はページの置き場所。TeX の \\index{よみ@語} と \\printindex も読む", () => {
    assert.ok(parse("本文\n［＃索引ページ］").some((b) => b.kind === "indexpage"));
    const tex = texToMarkup("本文\\index{あめ@雨}です。\n\n\\printindex").text;
    assert.match(tex, /［＃索引：雨（あめ）］/);
    assert.match(tex, /［＃索引ページ］/);
  });

  it("組んだ本の索引：題・行の見出し・項目とページ番号。同じページに何度出ても番号は1つ", { skip: !bytes && "フォントがない" }, () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    const text = [
      "　［＃索引］｜図書館《としょかん》［＃／索引］へ行く。［＃索引］｜図書館《としょかん》［＃／索引］は静か。猫［＃索引：猫（ねこ）］もいる。",
      "＝＝＝",
      "　また［＃索引］｜図書館《としょかん》［＃／索引］へ。",
      "［＃索引ページ］",
    ].join("\n");
    const r = typesetLazy(text, s, new Face(bytes!));
    const last = r.pageCount - 1;
    const lines = r.lines(last).map((l) => l.text);
    assert.equal(lines[0], "索引");
    assert.ok(lines.includes("た") && lines.includes("な"), JSON.stringify(lines));
    // 図書館は1ページに2回、2ページに1回 → 「1、2」。猫は1ページ。
    assert.ok(lines.some((l) => /^図書館…+１、２$/.test(l)), JSON.stringify(lines));
    assert.ok(lines.some((l) => /^猫…+１$/.test(l)), JSON.stringify(lines));
    // 番号はリンクになる（閲覧用 PDF）。
    assert.ok(r.page(last).shapes.some((sh) => sh.kind === "link" && sh.target.startsWith("l:kolophon-idx-")));
  });

  it("ページ構成の「索引」でも置ける", { skip: !bytes && "フォントがない" }, () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.pages = { front: [], back: [{ kind: "index", text: "" }], padTo: 1 };
    const r = typesetLazy("　雨［＃索引：雨（あめ）］が降る。", s, new Face(bytes!));
    assert.equal(r.lines(r.pageCount - 1)[0].text, "索引");
  });
});

describe("索引の下位の項目と参照（#17）", () => {
  const text = [
    "＃第一章　雨",
    "　梅雨［＃索引：雨／梅雨（あめ／つゆ）］と夕立［＃索引：雨／夕立（あめ／ゆうだち）］。雨［＃索引：雨（あめ）］と傘［＃索引参照：傘（かさ）→雨具］。",
    "　雨具［＃索引：雨具（あまぐ）］と長靴［＃索引：雨具／長靴（あまぐ／ながぐつ）］。霧雨［＃索引：霧雨（きりさめ）］［＃索引参照：霧雨（きりさめ）→雨／梅雨］。",
    "［＃索引ページ］",
  ].join("\n");

  it("［＃索引参照：語（よみ）→行き先］を読む。行頭でも段落スタイルと読まない", () => {
    const atoms = parseInline("傘［＃索引参照：傘（かさ）→雨具］");
    assert.deepEqual(atoms.flatMap((a) => a.index ?? []), [{ term: "傘", reading: "かさ", see: "雨具" }]);
    const [b] = parse("［＃索引参照：傘→雨具］本文。");
    assert.equal(b.kind, "para");
    assert.equal((b as { style?: string }).style, undefined);
  });

  it("下位の項目は親の下に1字下げて並べ、参照は「→行き先を見よ」（番号もあれば次の行に「→行き先も見よ」）", { skip: !bytes && "フォントがない" }, () => {
    const r = typesetLazy(text, { ...structuredClone(DEFAULT_SETTINGS), layoutMode: "book" }, new Face(bytes!));
    const lines = r.lines(r.pageCount - 1).map((l) => l.text).filter(Boolean);
    assert.deepEqual(lines, ["索引", "あ", "雨具…１", "　長靴…１", "雨…１", "　梅雨…１", "　夕立…１", "か", "傘　→雨具を見よ", "霧雨…１", "　→雨（梅雨）も見よ"]);
  });
});

describe("TeX の索引の下位の項目と参照（#17）", () => {
  it("\index の「!」は「親／子」、「|see{}」「|seealso{}」は［＃索引参照：］。ほかの書式は読まない", () => {
    const tex = texToMarkup(String.raw`雨\index{あめ@雨!つゆ@梅雨}と傘\index{かさ@傘|see{雨具}}と\index{きりさめ@霧雨|seealso{雨!梅雨}}と\index{ねこ@猫|textbf}`).text;
    assert.match(tex, /［＃索引：雨／梅雨（あめ／つゆ）］/);
    assert.match(tex, /［＃索引参照：傘（かさ）→雨具］/);
    assert.match(tex, /［＃索引参照：霧雨（きりさめ）→雨／梅雨］/);
    assert.match(tex, /［＃索引：猫（ねこ）］/);
  });
});
