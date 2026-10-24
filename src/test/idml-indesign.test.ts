import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { importIdml } from "../document/idml-import.js";
import { DEFAULT_SETTINGS } from "../document/settings.js";
import { DEFAULT_STYLES } from "../document/styles.js";
import { findAll, parseXml } from "../document/xml.js";
import { indesignFontName } from "../fonts/catalog.js";
import { BUNDLED_FONTS } from "../fonts/service.js";
import { buildIdml } from "../output/idml.js";
import { ZipWriter } from "../output/zip.js";

// #1：クラウドの InDesign（InDesign Server）で IDML を開いて書き出し、ずれていた所の直し。
const dec = new TextDecoder();
const settings = () => ({ ...structuredClone(DEFAULT_SETTINGS), styles: structuredClone(DEFAULT_STYLES) });
const file = (r: ReturnType<typeof buildIdml>, name: string) => dec.decode(r.files.find((f) => f.name === name)!.data);

describe("InDesign で開いたときのずれ（#1）", () => {
  it("文書の設定のページ数は 1（InDesign はその数だけ白いページを先に作り、そのあとに Spreads のページを足すため）", () => {
    const r = buildIdml("本文。", settings(), { pageCount: 4 });
    assert.match(file(r, "Resources/Preferences.xml"), /PagesPerDocument="1"/);
    // ページそのものは Spreads に4ページある。
    const pages = r.files.filter((f) => f.name.startsWith("Spreads/")).flatMap((f) => findAll(parseXml(dec.decode(f.data)), "Page"));
    assert.equal(pages.length, 4);
  });

  it("段落スタイルは日本語段落コンポーザー（ルビ・圏点・縦中横・割注を組むため）。段落スタイル「なし」には付けない（付けると開けない）", () => {
    const styles = findAll(parseXml(file(buildIdml("本文。", settings(), { pageCount: 1 }), "Resources/Styles.xml")), "ParagraphStyle");
    const none = styles.find((s) => s.attrs.Name === "$ID/[No paragraph style]")!;
    assert.equal(none.attrs.Composer, undefined);
    for (const s of styles.filter((x) => x !== none)) {
      if (s.attrs.Name === "$ID/NormalParagraphStyle") continue;
      assert.equal(s.attrs.Composer, "HL Composer J", s.attrs.Name);
    }
  });

  it("表の段落のあとに1行ぶん空ける（縦組みで、表のすぐあとの行が表に重なるため）", () => {
    const r = buildIdml(["［＃表］", "| 名前 | 値 |", "|---|---|", "| 雨 | 1 |", "［＃／表］", "注のような行。"].join("\n"), settings(), { pageCount: 1 });
    const story = parseXml(file(r, "Stories/Story_u1.xml"));
    const withTable = findAll(story, "ParagraphStyleRange").find((p) => findAll(p, "Table").length > 0)!;
    assert.ok(Number(withTable.attrs.SpaceAfter) > 0, JSON.stringify(withTable.attrs));
  });

  it("書体の名前は InDesign の名前：ファミリーは日本語名、スタイルは英語名（Kolophon の一覧では Regular が空）（#25）", () => {
    const noto = BUNDLED_FONTS[0];
    assert.equal(noto.style, "");
    assert.deepEqual(indesignFontName(noto), { family: "Noto Serif JP", style: "Regular" });
    const r = buildIdml("本文。", settings(), { pageCount: 1, fontName: () => ({ family: "BIZ UD明朝", style: "Medium", postscriptName: "BIZ-UDMincho-Medium" }) });
    // 段落スタイル「なし」（柱・ノンブルの字が使う）にもスタイルを付ける（付けないと Regular になり、ない書体になる）。
    const none = findAll(parseXml(file(r, "Resources/Styles.xml")), "ParagraphStyle").find((s) => s.attrs.Name === "$ID/[No paragraph style]")!;
    assert.equal(none.attrs.FontStyle, "Medium");
    const fonts = file(
      buildIdml("本文。", settings(), { pageCount: 1, fontName: () => ({ ...indesignFontName(noto)!, postscriptName: noto.postscriptName }) }),
      "Resources/Fonts.xml",
    );
    assert.match(fonts, /Name="Noto Serif JP\tRegular"/);
    assert.match(fonts, /FontStyleName="Regular"/);
  });
});

/** 控え（kolophon.json）を抜き、字を差し替えて ZIP にする（InDesign で保存し直した IDML のかわり）。 */
function resaved(r: ReturnType<typeof buildIdml>, edit: (name: string, xml: string) => string = (_n, x) => x): Uint8Array {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kolophon-idml-")), "t.idml");
  const zip = new ZipWriter(out);
  for (const f of r.files) if (f.name !== "META-INF/kolophon.json") zip.add(f.name, f.name.endsWith(".xml") ? new TextEncoder().encode(edit(f.name, dec.decode(f.data))) : f.data);
  zip.close();
  return new Uint8Array(fs.readFileSync(out));
}

describe("InDesign で保存し直した IDML を読み込む（#24）", () => {
  it("ルビの範囲が分かれたとき（RubyFlag=\"2\" の続き）は1つのルビにし、索引の印はルビのあとに", () => {
    const r = buildIdml("その日、｜図書館《としょかん》の窓。", settings(), { pageCount: 1 });
    // InDesign は、ルビの頭に索引の印を置くと、印だけの範囲（RubyFlag="1"）と字の範囲（RubyFlag="2"）に分ける。
    const back = importIdml(
      resaved(r, (name, xml) =>
        name === "Stories/Story_u1.xml"
          ? xml.replace(
              /<CharacterStyleRange ([^>]*)RubyFlag="1"([^>]*)><Content>図書館<\/Content><\/CharacterStyleRange>/,
              '<CharacterStyleRange $1RubyFlag="1"$2><PageReference Self="pr1" PageReferenceType="CurrentPage" ReferencedTopic="t1"/></CharacterStyleRange><CharacterStyleRange $1RubyFlag="2"$2><Content>図</Content></CharacterStyleRange><CharacterStyleRange $1RubyFlag="2"$2><Content>書館</Content></CharacterStyleRange>',
            )
          : name === "designmap.xml"
            ? xml.replace("</Document>", '<Index Self="ix"><Topic Self="t1" Name="図書館" SortOrder="としょかん"/></Index></Document>')
            : xml,
      ),
    );
    assert.match(back.text, /その日、｜図書館《としょかん》［＃索引：図書館（としょかん）］の窓。/);
  });

  it("組み方（文字組みアキ量設定）・行取り・太字を書き、控えなしでも戻す", () => {
    for (const [mode, lineEndPunct, mojikumi] of [
      ["grid", "full", "LineEndAllOneEmEnum"],
      ["jis", "full", "LineEndUkeNoFloatEnum"],
      ["jis", "half", undefined],
    ] as const) {
      const s = settings();
      s.typography = { ...s.typography, mode, lineEndPunct };
      const title = s.styles.paragraph.find((p) => p.name === "書名")!;
      title.lineSpan = 3;
      title.bold = true;
      const r = buildIdml("［＃書名］雨の図書館\n雨の日の図書館は静かだった。棚の間を歩くと、古い紙の匂いがした。", s, { pageCount: 1 });
      const styles = parseXml(file(r, "Resources/Styles.xml"));
      const body = findAll(styles, "ParagraphStyle").find((p) => p.attrs.Name === "本文")!;
      assert.equal(findAll(body, "Mojikumi")[0]?.children.join(""), mojikumi);
      const t = findAll(styles, "ParagraphStyle").find((p) => p.attrs.Name === "書名")!;
      assert.equal(t.attrs.GridGyoudori, "3");
      assert.ok(Number(t.attrs.StrokeWeight) > 0);
      const back = importIdml(resaved(r));
      assert.equal(back.restored, false);
      assert.equal(back.settings.typography.mode, mode);
      if (mode === "jis") assert.equal(back.settings.typography.lineEndPunct, lineEndPunct);
      const t2 = back.settings.styles.paragraph.find((p) => p.name === "書名")!;
      assert.equal(t2.lineSpan, 3);
      assert.equal(t2.bold, true);
      // InDesign は線のない段落にも線の太さを書く（色は「なし」）。それは太字にしない。
      assert.equal(back.settings.styles.paragraph.find((p) => p.name === "本文")!.bold, false);
    }
    const plain = importIdml(
      resaved(buildIdml("本文。", settings(), { pageCount: 1 }), (name, xml) =>
        name === "Resources/Styles.xml" ? xml.replace('Name="本文"', 'Name="本文" StrokeWeight="1" StrokeColor="Swatch/None"') : xml,
      ),
    );
    assert.equal(plain.settings.styles.paragraph.find((p) => p.name === "本文")!.bold, false);
  });
});

describe("IDML の数式（#21）", () => {
  const text = String.raw`本文に［＃数式］E=mc^2［＃／数式］の式。
［＃別行数式］\frac{1}{3}［＃／別行数式］
次の行。`;

  it("式の SVG をリンクのファイルにして行の中に置き、元の TeX を枠のラベルに残す。控えなしでも数式の記法に戻す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kolophon-math-"));
    const r = buildIdml(text, settings(), { pageCount: 1, linkPath: (f) => path.join(dir, f) });
    assert.deepEqual(
      r.links.map((l) => path.basename(l.path)),
      ["数式_1.svg", "数式_2.svg"],
    );
    const svg = dec.decode(r.links[0].data);
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="[\d.]+pt"/);
    assert.match(svg, /<path transform="matrix\(/);
    assert.equal(r.skipped.filter((s) => s.includes("数式")).length, 0);
    const story = parseXml(file(r, "Stories/Story_u1.xml"));
    const rects = findAll(story, "Rectangle");
    assert.equal(rects.length, 2);
    assert.equal(findAll(rects[0], "AnchoredObjectSetting")[0].attrs.AnchoredPosition, "InlinePosition");
    assert.equal(findAll(rects[0], "Link")[0].attrs.LinkResourceFormat, "$ID/SVG");
    assert.equal(findAll(rects[0], "KeyValuePair")[0].attrs.Value, "inline:E=mc^2");
    assert.equal(findAll(rects[1], "KeyValuePair")[0].attrs.Value, String.raw`display:\frac{1}{3}`);
    // 枠に線を付けない（InDesign の既定の黒い線が出ないように）。
    assert.equal(rects[0].attrs.StrokeColor, "Swatch/None");
    const back = importIdml(resaved(r));
    assert.equal(back.restored, false);
    assert.equal(back.text, text);
  });

  it("リンクのファイルを書けないときは、TeX の式を字で入れて知らせる", () => {
    const r = buildIdml(text, settings(), { pageCount: 1 });
    assert.equal(r.links.length, 0);
    assert.match(file(r, "Stories/Story_u1.xml"), /［数式：E=mc\^2］/);
    assert.ok(r.skipped.some((s) => s.includes("数式")));
  });
});

describe("IDML の索引の下位の項目と参照（#17）", () => {
  const text = "梅雨［＃索引：雨／梅雨（あめ／つゆ）］と傘［＃索引参照：傘（かさ）→雨具］。雨具［＃索引：雨具（あまぐ）］。霧雨［＃索引：霧雨（きりさめ）］［＃索引参照：霧雨（きりさめ）→雨／梅雨］。";

  it("下位の項目は入れ子の Topic、参照は CrossReference（番号のない項目は See、ある項目は SeeAlso）。控えなしでも記法に戻す", () => {
    const r = buildIdml(text, settings(), { pageCount: 1 });
    const index = findAll(parseXml(file(r, "designmap.xml")), "Index")[0];
    const top = index.children.filter((c): c is ReturnType<typeof parseXml> => typeof c !== "string" && !("pi" in c) && c.name === "Topic");
    const ame = top.find((t) => t.attrs.Name === "雨")!;
    assert.deepEqual(
      findAll(ame, "Topic").filter((t) => t !== ame).map((t) => [t.attrs.Name, t.attrs.SortOrder]),
      [["梅雨", "つゆ"]],
    );
    const tsuyu = findAll(ame, "Topic").find((t) => t.attrs.Name === "梅雨")!;
    const kasa = top.find((t) => t.attrs.Name === "傘")!;
    const amagu = top.find((t) => t.attrs.Name === "雨具")!;
    const kiri = top.find((t) => t.attrs.Name === "霧雨")!;
    assert.deepEqual(findAll(kasa, "CrossReference").map((x) => [x.attrs.CrossReferenceType, x.attrs.ReferencedTopic]), [["See", amagu.attrs.Self]]);
    assert.deepEqual(findAll(kiri, "CrossReference").map((x) => [x.attrs.CrossReferenceType, x.attrs.ReferencedTopic]), [["SeeAlso", tsuyu.attrs.Self]]);
    // 本文のページの参照は、下位の項目の Topic を指す。参照の項目には置かない。
    const refs = findAll(parseXml(file(r, "Stories/Story_u1.xml")), "PageReference").map((p) => p.attrs.ReferencedTopic);
    assert.ok(refs.includes(tsuyu.attrs.Self));
    assert.ok(!refs.includes(kasa.attrs.Self));
    const back = importIdml(resaved(r));
    assert.equal(back.restored, false);
    assert.match(back.text, /［＃索引：雨／梅雨（あめ／つゆ）］/);
    assert.match(back.text, /［＃索引参照：傘（かさ）→雨具］/);
    assert.match(back.text, /［＃索引参照：霧雨（きりさめ）→雨／梅雨］/);
  });
});
