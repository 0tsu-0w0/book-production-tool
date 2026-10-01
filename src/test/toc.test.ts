import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "../document/settings.js";
import { typeset, type DrawPage } from "../engine/index.js";
import { FontService } from "../fonts/service.js";

const face = new FontService().load(null).face;
const settings = (edit: (s: Settings) => void = () => {}): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  edit(s);
  return s;
};
const text = (p: DrawPage) => p.items.map((i) => i.text).join("");
/** 目次のページで、heading で始まる行（同じ x に並ぶ字）を上から順に返す。 */
const tocLine = (page: DrawPage, heading: string) => {
  const xs = [...new Set(page.items.map((i) => i.x))];
  for (const x of xs) {
    const line = page.items.filter((i) => i.x === x).sort((a, b) => a.y - b.y);
    if (line.map((i) => i.text).join("").startsWith(heading)) return line;
  }
  throw new Error(`目次に「${heading}」がない`);
};
const filler = (n: number) => "本文の行です。".repeat(5 * n);

describe("目次（DTP-14）", () => {
  const doc = ["［＃目次］", "＃第一章", filler(20), "＃＃節", filler(30), "＃第二章", filler(10)].join("\n");

  it("［＃目次］の場所に、見出しとページ番号の目次を入れる", () => {
    const r = typeset(doc, settings(), face);
    const toc = r.pages[0];
    assert.ok(text(toc).startsWith("目次"));
    // 見出しのあるページを数える（目次は1ページ、ページ番号は1から）。
    const pageOf = (h: string) => r.pages.findIndex((p, i) => i > 0 && text(p).includes(h)) + 1;
    for (const h of ["第一章", "節", "第二章"]) {
      const line = tocLine(toc, h);
      const number = line[line.length - 1].text.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
      assert.equal(Number(number), pageOf(h), h);
    }
  });

  it("リーダーで行末までつなぎ、ページ番号は行の最後にそろう", () => {
    const s = settings();
    const toc = typeset(doc, s, face).pages[0];
    const size = 9.25;
    const ends = ["第一章", "節"].map((h) => {
      const line = tocLine(toc, h);
      assert.ok(line.filter((i) => i.text === "…").length >= 10, "点線がある");
      return line[line.length - 1].y;
    });
    assert.ok(Math.abs(ends[0] - ends[1]) < 1e-6, "番号の位置は同じ");
    // 項目は1字下げ。同じ形の字（漢字）どうしで比べるため、項目の最初の字から版面の天を出す。
    const blockTop = tocLine(toc, "第一章")[0].y - 1 * size;
    // 字形の原点はマスの中にあるので、36字目のマスに入っていればよい。
    assert.ok(ends[0] > blockTop + 35 * size - 0.01 && ends[0] < blockTop + 36 * size, "最後の字は36字目");
  });

  it("中見出しは2字下げ、大見出しだけにもできる", () => {
    const r = typeset(doc, settings(), face);
    const first = tocLine(r.pages[0], "第一章")[0];
    const sec = tocLine(r.pages[0], "節")[0];
    assert.ok(Math.abs(sec.y - first.y - 2 * 9.25) < 1e-6);
    const only1 = typeset(doc, settings((s) => (s.toc.levels = 1)), face).pages[0];
    assert.ok(!text(only1).includes("節"));
  });

  it("漢数字のページ番号", () => {
    const toc = typeset(doc, settings((s) => (s.toc.numerals = "kanji")), face).pages[0];
    const line = tocLine(toc, "第一章");
    assert.equal(line[line.length - 1].text, "二");
  });

  it("目次が何ページにもなると、そのぶん本文のページ番号もずれる", () => {
    const many = Array.from({ length: 40 }, (_, i) => `＃章${i}\n${filler(1)}`).join("\n");
    const r = typeset(`［＃目次］\n${many}`, settings(), face);
    const tocPages = r.pages.filter((p) => text(p).includes("…")).length;
    assert.ok(tocPages >= 2);
    // 最初の章は目次のすぐあと。目次に書いた番号と合っている。
    const line = tocLine(r.pages[0], "章０");
    assert.equal(line[line.length - 1].text, String(tocPages + 1).length === 1 ? String.fromCharCode(0xff10 + tocPages + 1) : String(tocPages + 1));
  });

  it("目次のページには柱もノンブルも付けず、見出しの柱にも使わない", () => {
    const s = settings((s) => {
      s.layoutMode = "book";
      s.master.bodyOdd = "chapter";
    });
    const r = typeset(doc, s, face);
    const MM = 72 / 25.4;
    const top = s.book.topMm * MM;
    assert.ok(r.pages[0].items.every((i) => i.y > top - 1), "目次に柱がない");
  });

  it("ページ構成の「目次」からも入れられ、古い文書の目次の設定は既定になる", () => {
    const r = typeset("＃章\n本文", settings((s) => (s.pages.front = [{ kind: "toc", text: "" }])), face);
    assert.ok(text(r.pages[0]).startsWith("目次"));
    assert.deepEqual(normalizeSettings({ toc: { levels: 7, numerals: "roman" } }).toc, DEFAULT_SETTINGS.toc);
  });
});
