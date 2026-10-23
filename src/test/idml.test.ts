import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { importIdml } from "../document/idml-import.js";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { DEFAULT_STYLES, newCharacterStyle } from "../document/styles.js";
import { childElements, findAll, parseXml } from "../document/xml.js";
import { Face, typesetLazy } from "../engine/index.js";
import { FontService } from "../fonts/service.js";
import { buildIdml } from "../output/idml.js";
import { ZipWriter, crc32, readZip } from "../output/zip.js";
import { deflateRawSync } from "node:zlib";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}

const dec = new TextDecoder();

/** Kolophon の控え（META-INF/kolophon.json）を除く（InDesign で作った IDML と同じにする）。 */
const withoutHint = (files: { name: string; data: Uint8Array }[]) => files.filter((f) => f.name !== "META-INF/kolophon.json");

/** ファイルの並びを ZIP にして、その中身を返す。 */
function zipOf(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kolophon-idml-")), "t.idml");
  const zip = new ZipWriter(file);
  for (const f of files) zip.add(f.name, f.data);
  zip.close();
  return new Uint8Array(fs.readFileSync(file));
}

function sampleSettings(): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.layoutMode = "book";
  s.typography = { ...s.typography, mode: "jis" };
  s.styles = structuredClone(DEFAULT_STYLES);
  s.output.spotColors = [{ name: "DIC 156", color: "#e4007f", cmyk: [0, 100, 0, 0], overprint: false, tints: [50] }];
  s.styles.character.push({ ...newCharacterStyle("特色"), color: "#e4007f", tracking: -50 }, { ...newCharacterStyle("平網"), color: "#f280bf" });
  const body = s.styles.paragraph.find((p) => p.name === "本文")!;
  body.tracking = 20;
  s.styles.paragraph.push({
    ...structuredClone(body),
    name: "用語",
    tracking: 0,
    nested: [{ style: "特色", until: "through", count: 1, chars: "　" }],
    grep: [{ pattern: "[0-9]+", style: "平網" }],
    lineStyle: { style: "平網", lines: 1 },
  });
  return s;
}

const SAMPLE = [
  "＃第一章　雨の図書館［＃ラベル：一章］",
  "　｜図書館《としょかん》の窓から、雨を｜見《み》ていた。｜静《圏》かに。｜傍線《傍線》。",
  "　［＃特色］特色［＃／特色］と［＃平網］平網［＃／平網］。12日、［＃割注］わりちゅう［＃／割注］。注を付ける［＃注：注の中身。］。",
  "［＃用語］組版　文字を並べること。",
  "　［＃字間：－100］詰めた字間［＃／字間］。カ［＃カーニング：－200］ーニング。",
  "［＃改ページ］",
  "＃＃中見出し",
  "　［＃ページ：一章］ページを見よ。",
].join("\n");

describe("IDML の書き出し", () => {
  const s = sampleSettings();
  const r = buildIdml(SAMPLE, s, { pageCount: 3, pageOf: (l) => (l === "一章" ? "1" : undefined), fontName: () => ({ family: "Noto Serif JP", style: "Regular", postscriptName: "NotoSerifJP-Regular" }) });
  const files = new Map(r.files.map((f) => [f.name, dec.decode(f.data)]));

  it("決まりどおりの入れ物：mimetype が先頭、designmap が参照するファイルがすべてある。どの XML も読める", () => {
    assert.equal(r.files[0].name, "mimetype");
    assert.equal(files.get("mimetype"), "application/vnd.adobe.indesign-idml-package");
    for (const [name, text] of files) if (name.endsWith(".xml")) assert.doesNotThrow(() => parseXml(text), name);
    const dm = parseXml(files.get("designmap.xml")!);
    for (const e of childElements(dm)) if (e.attrs.src) assert.ok(files.has(e.attrs.src), e.attrs.src);
    assert.equal(dm.attrs.DOMVersion, "16.0");
  });

  it("ページ：右綴じの見開き（1ページ目は左ページだけ）、版面にテキストフレーム、フレームは1つの流れにつながる", () => {
    const spreads = [...files.keys()].filter((n) => n.startsWith("Spreads/")).map((n) => parseXml(files.get(n)!));
    assert.deepEqual(spreads.map((sp) => findAll(sp, "Page").length), [1, 2]);
    const frames = spreads.flatMap((sp) => findAll(sp, "TextFrame"));
    assert.deepEqual(frames.map((f) => [f.attrs.PreviousTextFrame, f.attrs.NextTextFrame]), [["n", "tf2"], ["tf1", "tf3"], ["tf2", "n"]]);
    // 1ページ目は左ページ（ノドの左）。
    assert.match(findAll(spreads[0], "Page")[0].attrs.ItemTransform, /^1 0 0 1 -/);
    const prefs = parseXml(files.get("Resources/Preferences.xml")!);
    assert.equal(findAll(prefs, "DocumentPreference")[0].attrs.PageBinding, "RightToLeft");
    assert.equal(findAll(prefs, "StoryPreference")[0].attrs.StoryOrientation, "Vertical");
  });

  it("本文：段落スタイル・文字スタイル・ルビ・圏点・傍線・縦中横・割注・字間・カーニング・改ページ・ページ番号", () => {
    const story = files.get("Stories/Story_u1.xml")!;
    assert.match(story, /RubyFlag="1" RubyString="としょかん" RubyType="GroupRuby" RubyAlignment="RubyJIS" RubyPosition="AboveRight"><Content>図書館<\/Content>/);
    assert.match(story, /KentenKind="KentenSesameDot"><Content>静<\/Content>/);
    assert.match(story, /Underline="true"><Content>傍線<\/Content>/);
    assert.match(story, /Tatechuyoko="true"><Content>12<\/Content>/);
    assert.match(story, /Warichu="true"><Content>わりちゅう<\/Content>/);
    assert.match(story, /Tracking="-100"><Content>詰めた字間<\/Content>/);
    assert.match(story, /KerningMethod="\$ID\/Manual" KerningValue="-200"><Content>カ<\/Content>/);
    assert.match(story, /AppliedCharacterStyle="CharacterStyle\/特色"><Content>特色<\/Content>/);
    assert.match(story, /AppliedParagraphStyle="ParagraphStyle\/中見出し" StartParagraph="NextPage"/);
    assert.match(story, /<Content>　1ページを見よ。<\/Content>/);
    // 注は章の終わりの段落に。
    assert.match(story, /<Content>注1　注の中身。<\/Content>/);
    // 段落の終わりは Br。最後の段落のあとには付けない。
    assert.ok(!/<Br\/><\/CharacterStyleRange><\/ParagraphStyleRange>\s*<\/Story>/.test(story));
  });

  it("スタイルと色：特色・特色の濃さ・先頭文字スタイル・正規表現スタイル・行スタイル・字間", () => {
    const styles = files.get("Resources/Styles.xml")!;
    assert.match(styles, /<AllNestedStyles type="list"><ListItem type="record"><AppliedCharacterStyle type="object">CharacterStyle\/特色<\/AppliedCharacterStyle><Delimiter type="string">　<\/Delimiter><Repetition type="long">1<\/Repetition><Inclusive type="boolean">true<\/Inclusive>/);
    assert.match(styles, /<GrepExpression type="string">\[0-9\]\+<\/GrepExpression>/);
    assert.match(styles, /<LineCount type="long">1<\/LineCount>/);
    assert.match(styles, /Name="本文"[^>]*Tracking="20"/);
    const graphic = files.get("Resources/Graphic.xml")!;
    assert.match(graphic, /<Color Self="Color\/DIC 156" Model="Spot" Space="CMYK" ColorValue="0 100 0 0"/);
    assert.match(graphic, /<Tint [^>]*TintValue="50" BaseColor="Color\/DIC 156"/);
    assert.match(graphic, /<Ink Self="Ink\/DIC 156"/);
    assert.ok(r.skipped.length === 0, r.skipped.join());
  });
});

describe("IDML の読み込み", () => {
  it("書き出した IDML を（Kolophon の控えなしで）読み込むと、同じ判型・字組・スタイル・特色と、同じ記法の原稿になる", () => {
    const s = sampleSettings();
    const r = buildIdml(SAMPLE, s, { pageCount: 3, pageOf: () => "1", fontName: () => undefined });
    const back = importIdml(zipOf(withoutHint(r.files)));
    const b = back.settings.book;
    assert.equal(b.writingMode, "vertical");
    assert.equal(b.widthMm, Math.round(s.book.widthMm * 10) / 10);
    assert.equal(b.fontSizePt, s.book.fontSizePt);
    assert.equal(b.charsPerLine, s.book.charsPerLine);
    assert.equal(b.linesPerPage, s.book.linesPerPage);
    assert.equal(b.lineGapPercent, s.book.lineGapPercent);
    assert.equal(b.topMm, s.book.topMm);
    assert.equal(b.gutterMm, s.book.gutterMm);
    // 特色の画面の色は、InDesign の特色が持つ CMYK から作り直す（名前・CMYK・濃さは同じ）。
    assert.deepEqual(back.settings.output.spotColors.map((sp) => [sp.name, sp.cmyk, sp.tints]), [["DIC 156", [0, 100, 0, 0], [50]]]);
    // 文字スタイルの色は、その特色の色になる（特色の版で刷る）。
    assert.equal(back.settings.styles.character.find((c) => c.name === "特色")!.color, back.settings.output.spotColors[0].color);
    const term = back.settings.styles.paragraph.find((p) => p.name === "用語")!;
    assert.deepEqual(term.nested, [{ style: "特色", until: "through", count: 1, chars: "　" }]);
    assert.deepEqual(term.grep, [{ pattern: "[0-9]+", style: "平網" }]);
    assert.deepEqual(term.lineStyle, { style: "平網", lines: 1 });
    assert.equal(back.settings.styles.character.find((c) => c.name === "特色")!.tracking, -50);
    const lines = back.text.split("\n");
    assert.equal(lines[0], "＃第一章　雨の図書館");
    assert.match(back.text, /｜図書館《としょかん》/);
    assert.match(back.text, /｜静《ゴマ》/);
    assert.match(back.text, /｜傍線《傍線》/);
    assert.match(back.text, /［＃縦中横］12［＃／縦中横］/);
    assert.match(back.text, /［＃割注］わりちゅう［＃／割注］/);
    assert.match(back.text, /［＃字間：-100］詰めた字間［＃／字間］/);
    assert.match(back.text, /カ［＃カーニング：-200］ーニング/);
    assert.match(back.text, /［＃特色］特色［＃／特色］/);
    assert.ok(lines.includes("［＃用語］組版　文字を並べること。"));
    assert.ok(lines.includes("［＃改ページ］"));
    assert.ok(lines.includes("＃＃中見出し"));
    assert.deepEqual(back.notes, []);
  });

  it("読み込んだ文書を組むと、元の文書と同じ行になる", { skip: !bytes && "フォントがない" }, () => {
    const s = sampleSettings();
    const text = SAMPLE.split("\n").filter((l) => !l.includes("［＃注") && !l.includes("［＃ページ") && !l.includes("ラベル")).join("\n");
    const r = buildIdml(text, s, { pageCount: 2, fontName: () => undefined });
    const back = importIdml(zipOf(withoutHint(r.files)));
    const face = new Face(bytes!);
    const linesOf = (t: string, st: Settings) => {
      const res = typesetLazy(t, st, face);
      return Array.from({ length: res.pageCount }, (_, i) => res.lines(i).map((l) => l.text)).flat();
    };
    assert.deepEqual(linesOf(back.text, back.settings), linesOf(text, s));
  });

  it("InDesign の書き方：グループの中のフレーム・XMLElement・リンク・1字ずつのルビ・脚注・表・強制改行・処理命令・BasedOn・プロセスカラーの濃さ", () => {
    const NS = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"';
    const enc = (s: string) => new TextEncoder().encode(s);
    const files = [
      { name: "mimetype", data: enc("application/vnd.adobe.indesign-idml-package") },
      {
        name: "designmap.xml",
        data: enc(`<?xml version="1.0" encoding="UTF-8"?><Document ${NS} DOMVersion="18.0" Self="d"><idPkg:Graphic src="Resources/Graphic.xml"/><idPkg:Styles src="Resources/Styles.xml"/><idPkg:Preferences src="Resources/Preferences.xml"/><idPkg:Spread src="Spreads/Spread_a.xml"/><Section Self="s" PageNumberStart="5"/><idPkg:Story src="Stories/Story_side.xml"/><idPkg:Story src="Stories/Story_main.xml"/></Document>`),
      },
      {
        name: "Resources/Graphic.xml",
        data: enc(`<idPkg:Graphic ${NS}><Color Self="Color/u1" Model="Process" Space="CMYK" ColorValue="100 0 0 0" Name="シアン"/><Tint Self="Tint/u2" TintValue="40" BaseColor="Color/u1"/><Color Self="Color/u3" Model="Spot" Space="CMYK" ColorValue="0 60 100 0" Name="PANTONE 151 C"/></idPkg:Graphic>`),
      },
      {
        name: "Resources/Styles.xml",
        data: enc(
          `<idPkg:Styles ${NS}><RootCharacterStyleGroup Self="c"><CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/><CharacterStyleGroup Self="g"><CharacterStyle Self="CharacterStyle/強調%3a青" Name="強調:青" FillColor="Tint/u2" FontStyle="Bold"/></CharacterStyleGroup></RootCharacterStyleGroup><RootParagraphStyleGroup Self="p"><ParagraphStyle Self="ParagraphStyle/$ID/NormalParagraphStyle" Name="$ID/NormalParagraphStyle" PointSize="9"><Properties><Leading type="unit">15.75</Leading><AppliedFont type="string">小塚明朝 Pr6N</AppliedFont></Properties></ParagraphStyle><ParagraphStyle Self="ParagraphStyle/本文組" Name="本文組" FirstLineIndent="0"><Properties><BasedOn type="object">ParagraphStyle/$ID/NormalParagraphStyle</BasedOn></Properties></ParagraphStyle><ParagraphStyle Self="ParagraphStyle/小見出し" Name="小見出し" PointSize="12" Justification="CenterAlign" FillColor="Color/u3"><Properties><BasedOn type="object">ParagraphStyle/本文組</BasedOn></Properties></ParagraphStyle></RootParagraphStyleGroup></idPkg:Styles>`,
        ),
      },
      { name: "Resources/Preferences.xml", data: enc(`<idPkg:Preferences ${NS}><DocumentPreference PageWidth="297.638" PageHeight="419.528"/><StoryPreference StoryOrientation="Vertical"/></idPkg:Preferences>`) },
      {
        name: "Spreads/Spread_a.xml",
        data: enc(
          `<idPkg:Spread ${NS}><Spread Self="a"><Page Self="p1" GeometricBounds="0 0 419.528 297.638" ItemTransform="1 0 0 1 -297.638 -209.764"/><Group Self="g1"><TextFrame Self="t2" ParentStory="side" ItemTransform="1 0 0 1 0 0"><Properties><PathGeometry><GeometryPathType><PathPointArray><PathPointType Anchor="-280 -200"/><PathPointType Anchor="-260 -180"/></PathPointArray></GeometryPathType></PathGeometry></Properties></TextFrame></Group><TextFrame Self="t1" ParentStory="main" ItemTransform="1 0 0 1 0 0"><Properties><PathGeometry><GeometryPathType><PathPointArray><PathPointType Anchor="-250 -170"/><PathPointType Anchor="-250 170"/><PathPointType Anchor="-30 170"/><PathPointType Anchor="-30 -170"/></PathPointArray></GeometryPathType></PathGeometry></Properties></TextFrame><TextFrame Self="t3" ParentStory="main" ItemTransform="1 0 0 1 0 0"><Properties><PathGeometry><GeometryPathType><PathPointArray><PathPointType Anchor="-250 -170"/><PathPointType Anchor="-30 170"/></PathPointArray></GeometryPathType></PathGeometry></Properties></TextFrame><Rectangle Self="r"><Image Self="i"/></Rectangle></Spread></idPkg:Spread>`,
        ),
      },
      {
        name: "Stories/Story_side.xml",
        data: enc(`<idPkg:Story ${NS}><Story Self="side"><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/本文組"><CharacterStyleRange><Content>囲み記事</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`),
      },
      {
        name: "Stories/Story_main.xml",
        data: enc(
          `<idPkg:Story ${NS}><Story Self="main"><StoryPreference StoryOrientation="Vertical"/><XMLElement Self="x" MarkupTag="XMLTag/Root"><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/小見出し" StartParagraph="NextOddPage"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>見出し<?ACE 7?></Content><Br/></CharacterStyleRange></ParagraphStyleRange></XMLElement><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/本文組"><CharacterStyleRange><Content>　東京の</Content></CharacterStyleRange><CharacterStyleRange RubyFlag="true" RubyType="PerCharacterRuby" RubyString="とう きょう"><Content>東京</Content></CharacterStyleRange><HyperlinkTextSource Self="h"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/強調%3a青"><Content>空&amp;海</Content></CharacterStyleRange></HyperlinkTextSource><CharacterStyleRange><Content>一行目 二行目</Content><Footnote><ParagraphStyleRange><CharacterStyleRange><Content><?ACE 4?>　脚注の文</Content></CharacterStyleRange></ParagraphStyleRange></Footnote><Br/></CharacterStyleRange><CharacterStyleRange><Table Self="tb" HeaderRowCount="1"><Cell Name="0:0"><ParagraphStyleRange><CharacterStyleRange><Content>名前</Content></CharacterStyleRange></ParagraphStyleRange></Cell><Cell Name="1:0"><ParagraphStyleRange><CharacterStyleRange><Content>値</Content></CharacterStyleRange></ParagraphStyleRange></Cell><Cell Name="0:1"><ParagraphStyleRange><CharacterStyleRange><Content>A|B</Content></CharacterStyleRange></ParagraphStyleRange></Cell><Cell Name="1:1"><ParagraphStyleRange><CharacterStyleRange><Content>1</Content></CharacterStyleRange></ParagraphStyleRange></Cell></Table></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`,
        ),
      },
    ];
    const r = importIdml(zipOf(files));
    const lines = r.text.split("\n");
    // 流れの順：本文（いちばん多くのフレームを流れるもの）ではなく、フレームの出てくる順（グループの中の囲み記事が先）。
    assert.equal(lines[0], "囲み記事");
    assert.equal(lines[1], "［＃改ページ］");
    assert.equal(lines[2], "［＃改丁］");
    assert.equal(lines[3], "［＃小見出し］見出し");
    assert.equal(lines[4], "　東京の｜東京《とう|きょう》［＃強調:青］空&海［＃／強調:青］一行目");
    assert.equal(lines[5], "二行目［＃注：　脚注の文］");
    assert.deepEqual(lines.slice(6), ["［＃表］", "| 名前 | 値 |", "|---|---|", "| A／B | 1 |", "［＃／表］"]);
    const s = r.settings;
    // いちばん多くの字に当たった「本文組」を本文に。BasedOn から大きさと行送りを受け継ぐ。
    assert.equal(s.book.fontSizePt, 9);
    assert.equal(s.book.lineGapPercent, 175);
    assert.equal(s.book.writingMode, "vertical");
    assert.equal(s.book.widthMm, 105);
    assert.equal(s.nombreStart, 5);
    const heading = s.styles.paragraph.find((p) => p.name === "小見出し")!;
    assert.equal(heading.align, "center");
    assert.equal(heading.scale, 1.33);
    assert.equal(heading.color, s.output.spotColors[0].color);
    const blue = s.styles.character.find((c) => c.name === "強調:青")!;
    assert.equal(blue.bold, true);
    // シアン 100% の 40%：白に近い水色。
    assert.equal(blue.color, "#99ffff");
    assert.deepEqual(s.output.spotColors.map((sp) => sp.name), ["PANTONE 151 C"]);
    assert.equal(r.fonts.body, "小塚明朝 Pr6N");
    assert.ok(r.notes.some((n) => n.startsWith("ページに置いた画像（1個")));
    assert.ok(r.notes.some((n) => n.startsWith("脚注（1個")));
    assert.ok(r.notes.some((n) => n.startsWith("表（1個")));
  });

  it("ZIP の読み取り：deflate で縮めたファイルも読める。IDML でなければ知らせる", () => {
    // InDesign の IDML は、mimetype 以外を deflate で縮めて入れる。
    const name = Buffer.from("designmap.xml");
    const raw = Buffer.from("<Document/>");
    const packed = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    const body = Buffer.concat([local, name, packed]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(46 + name.length, 12);
    end.writeUInt32LE(body.length, 16);
    const zip = readZip(new Uint8Array(Buffer.concat([body, central, name, end])));
    assert.equal(dec.decode(zip.get("designmap.xml")), "<Document/>");
    assert.throws(() => importIdml(zipOf([{ name: "a.txt", data: new TextEncoder().encode("x") }])), /IDML ではありません/);
    assert.throws(() => readZip(new Uint8Array(10)), /ZIP ではありません/);
  });
});

describe("IDML：Kolophon の控え・画像・ノンブル", () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR42mP8z8DwnwEJMDIwAABV0QHrt6R8VgAAAABJRU5ErkJggg==", "base64");
  const img = { name: "絵：表紙", mime: "image/png" as const, data: PNG.toString("base64"), width: 2, height: 3 };

  it("字が書き出したときのままなら、元の原稿と Kolophon だけの設定に戻す。特色は元の画面の色", () => {
    const s = sampleSettings();
    s.format.symbols = true;
    s.typography.lineEndPunct = "half";
    const r = buildIdml(SAMPLE, s, { pageCount: 3, pageOf: () => "1", fontName: () => undefined });
    const back = importIdml(zipOf(r.files));
    assert.equal(back.restored, true);
    assert.equal(back.text, SAMPLE);
    assert.equal(back.settings.format.symbols, true);
    assert.equal(back.settings.typography.lineEndPunct, "half");
    assert.deepEqual(back.settings.output.spotColors.map((sp) => [sp.name, sp.color, sp.tints]), [["DIC 156", "#e4007f", [50]]]);
    assert.equal(back.settings.styles.character.find((c) => c.name === "平網")!.color, "#f280bf");
  });

  it("字が変わっていれば IDML の字を読む。注の段落は［＃注：…］に戻し、特色は元の画面の色", () => {
    const s = sampleSettings();
    const r = buildIdml(SAMPLE, s, { pageCount: 3, pageOf: () => "1", fontName: () => undefined });
    const edited = r.files.map((f) => (f.name === "Stories/Story_u1.xml" ? { ...f, data: new TextEncoder().encode(dec.decode(f.data).replace("の窓から", "の扉から")) } : f));
    const back = importIdml(zipOf(edited));
    assert.equal(back.restored, false);
    assert.match(back.text, /｜図書館《としょかん》の扉から/);
    assert.match(back.text, /注を付ける［＃注：注の中身。］。/);
    assert.ok(!back.text.includes("注1"));
    assert.equal(back.settings.output.spotColors[0].color, "#e4007f");
    assert.equal(back.settings.styles.character.find((c) => c.name === "特色")!.color, "#e4007f");
  });

  it("画像：リンクのファイルを書き出し、Kolophon で置いた所に置く。全面の画像のページにはテキストフレームを置かず、流れを飛ばす", () => {
    const s = sampleSettings();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kolophon-links-"));
    const W = (s.book.widthMm * 72) / 25.4;
    const H = (s.book.heightMm * 72) / 25.4;
    const r = buildIdml(`本文。\n［＃画像：${img.name}　全面］\n続き。`, s, {
      pageCount: 3,
      images: [img],
      linkPath: (f) => path.join(dir, f),
      pages: [
        { images: [] },
        { images: [{ name: img.name, x: -8, y: -8, w: W + 16, h: H + 16, clip: { x: -8, y: -8, w: W + 16, h: H + 16 } }] },
        { images: [{ name: img.name, x: 50, y: 60, w: 40, h: 60 }] },
      ],
    });
    assert.deepEqual(
      r.links.map((l) => path.basename(l.path)),
      ["絵：表紙.png"],
    );
    const story = dec.decode(r.files.find((f) => f.name === "Stories/Story_u1.xml")!.data);
    assert.ok(!story.includes("画像"), "置いた画像は本文に字を入れない");
    const spreads = r.files.filter((f) => f.name.startsWith("Spreads/")).map((f) => parseXml(dec.decode(f.data)));
    const frames = spreads.flatMap((sp) => findAll(sp, "TextFrame"));
    assert.deepEqual(
      frames.map((f) => [f.attrs.Self, f.attrs.PreviousTextFrame, f.attrs.NextTextFrame]),
      [
        ["tf1", "n", "tf3"],
        ["tf3", "tf1", "n"],
      ],
    );
    const rects = spreads.flatMap((sp) => findAll(sp, "Rectangle"));
    assert.equal(rects.length, 2);
    const link = findAll(rects[0], "Link")[0].attrs;
    assert.equal(link.LinkResourceFormat, "$ID/Portable Network Graphics (PNG)");
    assert.match(link.LinkResourceURI, /^file:.*%E7%B5%B5%EF%BC%9A%E8%A1%A8%E7%B4%99\.png$/);
    // 本文のあるページの画像には回り込み、全面の画像にはない。
    assert.equal(findAll(rects[0], "TextWrapPreference").length, 0);
    assert.equal(findAll(rects[1], "TextWrapPreference")[0].attrs.TextWrapMode, "BoundingBoxTextWrap");
    // 画像の大きさ：2×3 画素を 40×60pt に（20倍）。
    assert.match(findAll(rects[1], "Image")[0].attrs.ItemTransform, /^20 0 0 20 /);

    // 読み込み：リンクのファイルが PC にあれば、元の名前の画像として読む。
    for (const l of r.links) fs.writeFileSync(l.path, l.data);
    const back = importIdml(zipOf(r.files));
    assert.equal(back.restored, true);
    assert.deepEqual(
      back.images.map((i) => [i.name, i.mime, i.width, i.height]),
      [[img.name, "image/png", 2, 3]],
    );
    assert.ok(back.text.includes(`［＃画像：${img.name}　全面］`));
  });

  it("画像（#23）：全面の画像のあとの本文は次のページから。行をまるごと空ける画像はオブジェクトを挟み、キャプションはテキストの枠", () => {
    const s = sampleSettings();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kolophon-links-"));
    const W = (s.book.widthMm * 72) / 25.4;
    const H = (s.book.heightMm * 72) / 25.4;
    const caption = { lines: ["切り抜いた", "帯"], x: 20, y: 60, w: 24, h: 45, size: 9 };
    const r = buildIdml(`本文。\n［＃画像：${img.name}　全面］\n続き。\n［＃画像：${img.name}　５行　キャプション：切り抜いた帯］\n終わり。`, s, {
      pageCount: 3,
      images: [img],
      linkPath: (f) => path.join(dir, f),
      pages: [
        { images: [] },
        { images: [{ name: img.name, x: -8, y: -8, w: W + 16, h: H + 16 }] },
        { images: [{ name: img.name, x: 50, y: 60, w: 40, h: 30, jump: true, caption }] },
      ],
    });
    const story = dec.decode(r.files.find((f) => f.name === "Stories/Story_u1.xml")!.data);
    const next = story.split("<ParagraphStyleRange").find((p) => p.includes("続き"))!;
    assert.match(next, /StartParagraph="NextPage"/);
    const spread = r.files.filter((f) => f.name.startsWith("Spreads/")).map((f) => parseXml(dec.decode(f.data)));
    const rect = spread.flatMap((sp) => findAll(sp, "Rectangle")).at(-1)!;
    assert.equal(findAll(rect, "TextWrapPreference")[0].attrs.TextWrapMode, "JumpObjectTextWrap");
    const cf = spread.flatMap((sp) => findAll(sp, "TextFrame")).find((f) => String(f.attrs.Self).startsWith("cf"))!;
    assert.equal(findAll(cf, "TextFramePreference")[0].attrs.IgnoreWrap, "true");
    assert.equal(findAll(cf, "TextWrapPreference")[0].attrs.TextWrapMode, "JumpObjectTextWrap");
    const capStory = dec.decode(r.files.find((f) => f.name === `Stories/Story_${cf.attrs.ParentStory}.xml`)!.data);
    assert.match(capStory, /StoryOrientation="Vertical"/);
    assert.match(capStory, /<Content>切り抜いた<\/Content><Br\/><Content>帯<\/Content>/);
  });

  it("ノンブル：Kolophon でノンブルを出したページにマスター A（自動のページ番号）、ほかはマスター B。前付けを別に数えるときはセクションを分ける", () => {
    const s = sampleSettings();
    s.nombreStyle = { ...s.nombreStyle, front: "roman", numerals: "kanji" };
    const nombre = (x: number, align: "left" | "right") => ({ x, y: 400, size: 7, align, color: "#000000", text: "1" });
    const r = buildIdml("本文。", s, {
      pageCount: 3,
      bodyStart: 1,
      pages: [{ images: [] }, { images: [], nombre: nombre(30, "right") }, { images: [], nombre: nombre(280, "left") }],
    });
    const pages = r.files.filter((f) => f.name.startsWith("Spreads/")).flatMap((f) => findAll(parseXml(dec.decode(f.data)), "Page"));
    assert.deepEqual(
      pages.map((p) => p.attrs.AppliedMaster),
      ["un", "um", "um"],
    );
    const master = dec.decode(r.files.find((f) => f.name === "MasterSpreads/MasterSpread_um.xml")!.data);
    assert.equal(findAll(parseXml(master), "TextFrame").length, 2);
    const numbers = r.files.filter((f) => f.name.startsWith("Stories/Story_un")).map((f) => dec.decode(f.data));
    assert.equal(numbers.length, 2);
    for (const st of numbers) assert.match(st, /PointSize="7"[^>]*><Content><\?ACE 18\?><\/Content>/);
    assert.match(numbers.join(), /Justification="RightAlign"/);
    const dm = parseXml(dec.decode(r.files.find((f) => f.name === "designmap.xml")!.data));
    const sections = childElements(dm, "Section").map((e) => [e.attrs.PageStart, e.attrs.Length, e.attrs.PageNumberStyle, e.attrs.PageNumberStart]);
    assert.deepEqual(sections, [
      ["p1", "1", "LowerRoman", "1"],
      ["p2", "2", "Kanji", "1"],
    ]);
    // 読み込み：前付けのローマ数字・漢数字のノンブル。マスターのページ番号だけなら知らせない。
    const back = importIdml(zipOf(withoutHint(r.files)));
    assert.equal(back.settings.nombreStyle.front, "roman");
    assert.equal(back.settings.nombreStyle.numerals, "kanji");
    assert.ok(!back.notes.some((note) => note.startsWith("マスターページ")), back.notes.join());
  });

  it("文字スタイルの大きさは、段落の大きさを掛けて字に付ける（見出しの中の文字スタイル）", () => {
    const s = sampleSettings();
    s.styles.paragraph.find((p) => p.name === "大見出し")!.scale = 2;
    s.styles.character.push({ ...newCharacterStyle("小"), scale: 0.5 });
    const r = buildIdml("＃［＃小］小さく［＃／小］見出し\n　［＃小］本文の中［＃／小］", s, { pageCount: 1 });
    const story = dec.decode(r.files.find((f) => f.name === "Stories/Story_u1.xml")!.data);
    const size = s.book.fontSizePt;
    assert.match(story, new RegExp(`AppliedCharacterStyle="CharacterStyle/小" PointSize="${size}"><Content>小さく`));
    assert.match(story, /AppliedCharacterStyle="CharacterStyle\/小"><Content>本文の中/);
  });

  it("InDesign の特色：Lab で決めた色を画面の色にし、代わりの CMYK を作る。本文の中に置いた画像は［＃画像：名前］の行に", () => {
    const NS = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"';
    const enc = (t: string) => new TextEncoder().encode(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kolophon-anchored-"));
    const file = path.join(dir, "挿絵 1.png");
    fs.writeFileSync(file, PNG);
    const uri = `file:${encodeURI(file.replace(/\\/g, "/"))}`;
    const files = [
      { name: "designmap.xml", data: enc(`<Document ${NS} Self="d"><idPkg:Graphic src="G.xml"/><idPkg:Spread src="S.xml"/><idPkg:Story src="T.xml"/></Document>`) },
      { name: "G.xml", data: enc(`<idPkg:Graphic ${NS}><Color Self="Color/u9" Model="Spot" Space="LAB" ColorValue="54 81 -7" Name="PANTONE 213 C"/></idPkg:Graphic>`) },
      {
        name: "S.xml",
        data: enc(
          `<idPkg:Spread ${NS}><Spread Self="s"><Page Self="p" GeometricBounds="0 0 400 300" ItemTransform="1 0 0 1 0 -200"/><TextFrame Self="f" ParentStory="t"><Properties><PathGeometry><GeometryPathType><PathPointArray><PathPointType Anchor="20 -180"/><PathPointType Anchor="280 180"/></PathPointArray></GeometryPathType></PathGeometry></Properties></TextFrame></Spread></idPkg:Spread>`,
        ),
      },
      {
        name: "T.xml",
        data: enc(
          `<idPkg:Story ${NS}><Story Self="t"><ParagraphStyleRange><CharacterStyleRange><Content>前の文</Content><Rectangle Self="r"><Image Self="i"><Link Self="l" LinkResourceURI="${uri}"/></Image></Rectangle><Content>後の文</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`,
        ),
      },
    ];
    const r = importIdml(zipOf(files));
    const spot = r.settings.output.spotColors[0];
    assert.equal(spot.name, "PANTONE 213 C");
    // 濃いピンク（赤が強く、緑が弱い）。
    const [red, green, blue] = [1, 3, 5].map((k) => parseInt(spot.color.slice(k, k + 2), 16));
    assert.ok(red > 200 && green < 60 && blue > 80 && blue < 170, spot.color);
    assert.ok(spot.cmyk[1] > 70 && spot.cmyk[0] < 15, spot.cmyk.join());
    assert.deepEqual(r.text.split("\n"), ["前の文", "［＃画像：挿絵 1］", "後の文"]);
    assert.deepEqual(
      r.images.map((i) => i.name),
      ["挿絵 1"],
    );
  });
});
