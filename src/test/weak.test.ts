import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, type FontChoice } from "../document/settings.js";
import { parseLabeledRange } from "../document/range.js";
import { pageLabel } from "../engine/decorate.js";
import { Face, typesetLazy } from "../engine/index.js";
import { buildEpub } from "../output/epub.js";
import { epubFonts, usedText } from "../output/epub-fonts.js";
import { subsetFont } from "../output/subset-font.js";
import { FontService } from "../fonts/service.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}
const skip = !bytes && "フォントがない";

describe("前付けを別の番号にしたときの、ページの名前と範囲", () => {
  const roman = { nombreStart: 1, nombreStyle: { front: "roman" as const, numerals: "arabic" as const, outerMm: 0, downMm: 0 }, bodyStart: 3 };
  it("前付けは i・ii…、本文は本文の番号（001）。前付けを分けなければ通し番号", () => {
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => pageLabel(i, roman)), ["i", "ii", "iii", "001", "002"]);
    assert.deepEqual([0, 1, 2].map((i) => pageLabel(i, { nombreStart: 1, bodyStart: 3 })), ["001", "002", "003"]);
  });

  it("範囲は、数がノンブル（本文の番号）、ローマ数字が前付け", () => {
    const labels = ["i", "ii", "001", "002", "003", "004"];
    assert.deepEqual([...parseLabeledRange("1-2", labels)], [2, 3]);
    assert.deepEqual([...parseLabeledRange("3-", labels)], [4, 5]);
    assert.deepEqual([...parseLabeledRange("ii, 4", labels)].sort(), [1, 5]);
    assert.deepEqual([...parseLabeledRange("i-", labels)], [0, 1]);
    assert.equal(parseLabeledRange("", labels).size, 6);
    assert.throws(() => parseLabeledRange("v", labels));
    assert.throws(() => parseLabeledRange("10-12", labels));
  });
});

describe("合成フォントの欧文：全角の英数字", { skip }, () => {
  it("縦組みで全角にした英数字も欧文の書体で、半角の字を1マスの中央に立てる", () => {
    const latin: FontChoice = { name: "欧文", postscriptName: "Latin", path: "latin.ttf", index: 0 };
    const s = structuredClone(DEFAULT_SETTINGS);
    s.compositeFont.latin = latin;
    const face = new Face(bytes!);
    const table = { faces: [face, face], keys: ["body", "latin.ttf#0"] };
    const page = typesetLazy("ＡＢ１は、全角の英数字。", s, table).page(0);
    const a = page.items.find((i) => i.text === "A");
    assert.ok(a, JSON.stringify(page.items.slice(0, 4).map((i) => i.text)));
    assert.equal(a!.face, 1);
    assert.equal(a!.font, "horiz");
    // 本文の字はそのまま本文の書体。
    assert.equal(page.items.find((i) => i.text === "全")!.face, 0);
  });
});

describe("EPUB の書体の埋め込み", { skip }, () => {
  it("使った字だけに絞った書体を入れ、CSS で本文に当てる。字のない書体にはしない", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    const text = "＃第一章\n　吾輩は猫である。";
    const plain = buildEpub(text, s, []);
    const used = usedText(plain);
    assert.ok(used.includes("猫") && used.includes("第"));
    const fonts = epubFonts(plain, s, [{ choice: { name: "本文", postscriptName: "B", path: "b.ttf", index: 0 }, bytes: bytes! }], ["b.ttf#0"]);
    assert.equal(fonts.length, 1);
    assert.ok(fonts[0].data.length < bytes!.length / 10);
    const files = buildEpub(text, s, [], new Date(), fonts);
    const css = new TextDecoder().decode(files.find((f) => f.name === "OEBPS/style.css")!.data);
    assert.match(css, /@font-face\{font-family:"kolophon-body";src:url\("fonts\/font0\.ttf"\);\}/);
    assert.match(css, /body\{margin:0;font-family:"kolophon-body",serif;/);
    const opf = new TextDecoder().decode(files.find((f) => f.name === "OEBPS/content.opf")!.data);
    assert.match(opf, /<item id="f1" href="fonts\/font0\.ttf" media-type="font\/ttf"\/>/);
    assert.ok(files.some((f) => f.name === "OEBPS/fonts/font0.ttf"));
    // 絞った書体に、使った字はあり、使っていない字はない。
    const sub = new Face(fonts[0].data);
    assert.equal(sub.isMissing("猫", "ttb"), false);
    assert.equal(sub.isMissing("犬", "ttb"), true);
  });

  it("合成フォントのかなは、かなの範囲（unicode-range）だけに当てる", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    const kana: FontChoice = { name: "かな", postscriptName: "K", path: "k.ttf", index: 0 };
    s.compositeFont.kana = kana;
    const plain = buildEpub("　かな漢字", s, []);
    const fonts = epubFonts(plain, s, [{ choice: { name: "本文", postscriptName: "B", path: "b.ttf", index: 0 }, bytes: bytes! }, { choice: kana, bytes: bytes! }], ["b.ttf#0", "k.ttf#0"]);
    assert.equal(fonts.length, 2);
    const css = new TextDecoder().decode(buildEpub("　かな漢字", s, [], new Date(), fonts).find((f) => f.name === "OEBPS/style.css")!.data);
    // かなの書体を先に書き、範囲を付ける。
    assert.match(css, /font1\.ttf"\);unicode-range:U\+3040-309F[^}]*\}\n@font-face\{font-family:"kolophon-body";src:url\("fonts\/font0\.ttf"\);\}/);
  });

  it("subset：絞れないもの（壊れたフォント）は null", () => {
    assert.equal(subsetFont(new Uint8Array([1, 2, 3, 4]), "あ"), null);
  });
});
