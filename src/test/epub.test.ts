import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { XMLValidator } from "fast-xml-parser";
import type { DocImage } from "../document/document.js";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { buildEpub } from "../output/epub.js";

const dec = new TextDecoder();
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const img = (name: string): DocImage => ({ name, mime: "image/png", data: PNG_1PX, width: 1, height: 1 });

const SAMPLE = [
  "＃第一章　雨",
  "　｜図書館《としょかん》の窓に｜ぽつぽつ《圏》と雨が当たる［＃注：梅雨のこと。］。12月3日。",
  "　｜大事《傍線》なこと。［＃割注］小さく［＃／割注］［＃太字］強く［＃／太字］。",
  "［＃画像：猫　キャプション：庭の猫］",
  "［＃表］",
  "| 書名 | 年 |",
  "|---|---:|",
  "| 羅生門 | 1915 |",
  "| ^ | < |",
  "［＃／表］",
  "＃＃一の二",
  "　数式［＃数式］x^2［＃／数式］と、第二章は［＃ページ：second］から。",
  "＝＝＝",
  "＃第二章　霧［＃ラベル：second］",
  "　霧の中で。",
].join("\n");

const settingsOf = (over: (s: Settings) => void = () => {}): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.bookInfo.title = "雨の本 & <テスト>";
  s.bookInfo.author = "山田花子";
  s.pages = { front: [{ kind: "title", text: "" }, { kind: "toc", text: "" }], back: [{ kind: "colophon", text: "" }], padTo: 1 };
  over(s);
  return s;
};

const files = (s: Settings, images: DocImage[] = [img("猫")]) => {
  const out = buildEpub(SAMPLE, s, images, new Date("2026-10-02T00:00:00Z"));
  return { list: out, text: (name: string) => dec.decode(out.find((f) => f.name === name)!.data) };
};

describe("EPUB の書き出し", () => {
  it("決まりどおりの入れ物：mimetype が先頭、container.xml、OPF、nav", () => {
    const { list, text } = files(settingsOf());
    assert.equal(list[0].name, "mimetype");
    assert.equal(dec.decode(list[0].data), "application/epub+zip");
    assert.match(text("META-INF/container.xml"), /OEBPS\/content\.opf/);
    const opf = text("OEBPS/content.opf");
    assert.match(opf, /<dc:title>雨の本 &amp; &lt;テスト&gt;<\/dc:title>/);
    assert.match(opf, /page-progression-direction="rtl"/);
    assert.match(opf, /primary-writing-mode" content="vertical-rl"/);
    assert.match(opf, /properties="nav"/);
  });

  it("XHTML・OPF・nav はすべて正しい XML。マニフェストのファイルはすべて入っていて、余分なものもない", () => {
    const { list, text } = files(settingsOf());
    for (const f of list) {
      if (!/\.(xhtml|opf|xml)$/.test(f.name)) continue;
      const r = XMLValidator.validate(dec.decode(f.data));
      assert.equal(r, true, `${f.name}: ${JSON.stringify(r)}`);
    }
    const opf = text("OEBPS/content.opf");
    const hrefs = [...opf.matchAll(/href="([^"]+)"/g)].map((m) => `OEBPS/${m[1]}`).sort();
    const inZip = list.map((f) => f.name).filter((n) => n.startsWith("OEBPS/") && n !== "OEBPS/content.opf").sort();
    assert.deepEqual(hrefs, inZip);
    // スパインの idref はマニフェストにある。
    const ids = new Set([...opf.matchAll(/<item id="([^"]+)"/g)].map((m) => m[1]));
    for (const m of opf.matchAll(/idref="([^"]+)"/g)) assert.ok(ids.has(m[1]), m[1]);
  });

  it("中身：ルビ・圏点・傍線・縦中横・割注・太字・注・表（結合）・画像・数式・ページ番号の参照", () => {
    const { list, text } = files(settingsOf());
    const all = list.filter((f) => f.name.startsWith("OEBPS/text/")).map((f) => dec.decode(f.data)).join("");
    assert.match(all, /<ruby>図書館<rt>としょかん<\/rt><\/ruby>/);
    assert.match(all, /text-emphasis-style:filled sesame/);
    assert.match(all, /class="sl"/);
    assert.match(all, /<span class="tcy">12<\/span>/);
    assert.match(all, /<span class="warichu">（小さく）<\/span>/);
    assert.match(all, /epub:type="noteref"[^>]*href="#note-1"/);
    assert.match(all, /<aside epub:type="footnote" id="note-1">/);
    assert.match(all, /<td rowspan="2">羅生門<\/td>/);
    assert.match(all, /<td colspan="2"/.test(all) ? /colspan/ : /rowspan/);
    assert.match(all, /<img src="\.\.\/images\/img001\.png" alt="庭の猫"\/><figcaption>/);
    assert.match(all, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    // 第二章のラベルは2つめの章の XHTML にあり、参照はそこへのリンク。
    const ref = /<a class="ref" href="(p\d{3}\.xhtml)#lb-[0-9a-f]+">/.exec(all);
    assert.ok(ref, "参照のリンク");
    assert.match(text(`OEBPS/text/${ref![1]}`), /霧/);
    // 数式のある XHTML は svg の属性を持つ。
    assert.match(text("OEBPS/content.opf"), /properties="svg"/);
  });

  it("目次（nav）は見出しから、大見出しの下に中見出し。ページ構成の目次の場所でスパインに入る", () => {
    const { text } = files(settingsOf());
    const nav = text("OEBPS/nav.xhtml");
    assert.match(nav, /<li><a href="text\/p\d{3}\.xhtml#h1">第一章　雨<\/a><ol><li><a href="text\/p\d{3}\.xhtml#h2">一の二<\/a><\/li><\/ol><\/li>/);
    const spine = /<spine[^>]*>([\s\S]*)<\/spine>/.exec(text("OEBPS/content.opf"))![1];
    // 本扉のあとに目次。
    assert.match(spine, /idref="c1"\/>\s*<itemref idref="nav"/);
  });

  it("横組みの本は横書き・左から右へ。注を本の終わりにまとめると notes.xhtml", () => {
    const { list, text } = files(settingsOf((s) => {
      s.layoutMode = "book";
      s.book.writingMode = "horizontal";
      s.notes.placement = "end";
    }));
    assert.doesNotMatch(text("OEBPS/content.opf"), /page-progression-direction/);
    assert.match(text("OEBPS/style.css"), /writing-mode:horizontal-tb/);
    assert.ok(list.some((f) => f.name === "OEBPS/text/notes.xhtml"));
    assert.match(text("OEBPS/text/notes.xhtml"), /<aside epub:type="endnote" id="note-1">/);
  });

  it("表1の画像を選ぶと、表紙（cover-image）になる", () => {
    const { text } = files(settingsOf((s) => (s.cover.frontImage = "猫")));
    const opf = text("OEBPS/content.opf");
    assert.match(opf, /properties="cover-image"/);
    assert.match(opf, /<spine[^>]*>\s*<itemref idref="cover"\/>/);
  });
});

describe("EPUBCheck で見つかった所（#3）", () => {
  it("見出しのない XHTML の題は空にしない（書名、なければ「無題」）", () => {
    for (const [title, want] of [
      ["見本の本", "見本の本"],
      ["", "無題"],
    ]) {
      const s = { ...structuredClone(DEFAULT_SETTINGS) };
      s.bookInfo = { ...s.bookInfo, title };
      const out = buildEpub("見出しのない文。\n＃第一章\n本文。", s, []);
      const first = out.filter((f) => /text\/p\d+\.xhtml$/.test(f.name)).map((f) => dec.decode(f.data))[0];
      assert.match(first, new RegExp(`<title>${want}</title>`));
    }
  });
});
