import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { DEFAULT_STYLES } from "../document/styles.js";
import { buildEpub } from "../output/epub.js";
import { buildHtml } from "../output/html.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const dec = new TextDecoder();

function settings(over: (s: Settings) => void = () => {}): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.styles = structuredClone(DEFAULT_STYLES);
  s.bookInfo.title = "雨の本";
  over(s);
  return s;
}

const DOC = [
  "［＃目次］",
  "＃第一章　雨［＃ラベル：雨］",
  "　｜図書館《としょかん》で［＃傍点］本［＃傍点終わり］を読む。注を付ける［＃注：雨の日の話。］。",
  "［＃画像：絵］",
  "［＃表］",
  "| 名前 | 値 |",
  "|---|---|",
  "| 雨 | １ |",
  "［＃／表］",
  "＃第二章　晴れ",
  "　前の章は［＃参照：雨］。",
].join("\n");
const images = [{ name: "絵", mime: "image/png" as const, data: PNG, width: 1, height: 1 }];

/** HTML の中の id の一覧。 */
const ids = (html: string) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

describe("HTML の書き出し：1つのファイル", () => {
  const [file] = buildHtml(buildEpub(DOC, settings(), images), "single", "雨の本");
  const html = dec.decode(file.data);

  it("1つのファイルに、CSS と画像を中に入れる。EPUB だけの書き方は残さない", () => {
    assert.equal(file.name, "雨の本.html");
    assert.match(html, /^<!DOCTYPE html>\n<html lang="ja" class="vrtl">/);
    assert.match(html, /<style>[\s\S]*writing-mode:vertical-rl[\s\S]*<\/style>/);
    assert.match(html, /<img src="data:image\/png;base64,iVBOR/);
    assert.ok(!html.includes("epub:"), "epub: が残っている");
    assert.ok(!/\.xhtml/.test(html), ".xhtml へのリンクが残っている");
    assert.ok(!html.includes("<?xml"));
    // 中身は EPUB と同じ：ルビ・表・注（ARIA の役割）。
    assert.match(html, /<ruby>図書館<rt>としょかん<\/rt><\/ruby>|<ruby>[^<]*図書館/);
    assert.match(html, /<table[\s\S]*<td[^>]*>雨<\/td>/);
    assert.match(html, /role="doc-noteref"/);
    assert.match(html, /role="doc-(footnote|endnote)"/);
  });

  it("ページの中のリンクは、すべて行き先の id がある（目次・注・相互参照）", () => {
    const have = ids(html);
    const links = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    assert.ok(links.length >= 4, links.join());
    for (const l of links) assert.ok(have.has(l), `#${l} がない`);
  });
});

describe("HTML の書き出し：章ごとのフォルダ", () => {
  const files = buildHtml(buildEpub(DOC, settings(), images), "chapters");
  const byName = new Map(files.map((f) => [f.name, dec.decode(f.data)]));

  it("目次（index.html）・章ごとの HTML・style.css・画像。章の終わりに前へ・目次・次へ", () => {
    assert.ok(byName.has("index.html"));
    assert.ok(byName.has("style.css"));
    assert.ok(files.some((f) => /^images\/.+\.png$/.test(f.name)));
    const chapters = [...byName.keys()].filter((n) => /^p\d{3}\.html$/.test(n)).sort();
    assert.ok(chapters.length >= 2, [...byName.keys()].join());
    const index = byName.get("index.html")!;
    assert.match(index, /<h1 class="book-title">雨の本<\/h1>/);
    assert.match(index, /<a href="p\d{3}\.html#[^"]+">第一章　雨<\/a>/);
    const first = byName.get(chapters[0])!;
    assert.match(first, /<link rel="stylesheet" href="style.css">/);
    assert.match(first, /<nav class="pager"><a href="index.html">目次<\/a><a href="p\d{3}\.html" rel="next">次へ<\/a><\/nav>/);
    const last = byName.get(chapters[chapters.length - 1])!;
    assert.match(last, /rel="prev">前へ<\/a><a href="index.html">目次<\/a><\/nav>/);
  });

  it("ファイルをまたぐリンクと画像は、すべてフォルダの中にあるファイルと id を指す", () => {
    for (const [name, html] of byName) {
      if (!name.endsWith(".html")) continue;
      for (const m of html.matchAll(/(?:href|src)="([^"#:]+)?(?:#([^"]*))?"/g)) {
        const [, file, frag] = m;
        const target = file ?? name;
        assert.ok(byName.has(target) || files.some((f) => f.name === target), `${name} → ${target} がない`);
        if (frag && target.endsWith(".html")) assert.ok(ids(byName.get(target)!).has(frag), `${name} → ${target}#${frag} がない`);
      }
      assert.ok(!html.includes("epub:") && !/\.xhtml/.test(html), name);
    }
  });

  it("横組みでは横書きの class", () => {
    const h = buildHtml(buildEpub("＃章\n　本文。", settings((s) => ((s.layoutMode = "book"), (s.book.writingMode = "horizontal"))), []), "chapters");
    const index = dec.decode(h.find((f) => f.name === "index.html")!.data);
    assert.match(index, /<html lang="ja" class="hltr">/);
  });
});
