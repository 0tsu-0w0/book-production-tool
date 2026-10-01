import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../document/settings.js";
import { typeset } from "../engine/index.js";
import { DEFAULT_SPEC, layoutDocument } from "../engine/layout.js";
import { parse } from "../engine/parse.js";
import type { Block, LayoutSpec, PageLayout } from "../engine/types.js";
import { FontService } from "../fonts/service.js";

// 1行10字・1ページ5行の小さなページで確かめる。
const spec: LayoutSpec = { ...DEFAULT_SPEC, charsPerLine: 10, linesPerPage: 5 };
const fmt = (keep: Partial<{ keepLines: boolean; keepWithNext: boolean }>) => ({ indent: 0, align: "start" as const, lineSpan: 1, spaceBefore: 0, spaceAfter: 0, ...keep });
const withFormat = (src: string, keep: Parameters<typeof fmt>[0]): Block[] =>
  parse(src).map((b) => (b.kind === "para" || b.kind === "heading" ? { ...b, format: fmt(keep) } : b));
/** ページごとの、行の頭の字（空行は「・」）。 */
const heads = (pages: PageLayout[]) =>
  pages.map((p) => {
    const xs = [...new Set(p.glyphs.map((g) => g.x))].sort((a, b) => b - a);
    return xs.map((x) => p.glyphs.filter((g) => g.x === x).sort((a, b) => a.y - b.y)[0].text).join("");
  });
const para = (ch: string, lines: number) => ch.repeat(10 * lines);

describe("孤立行を避ける（DTP-11）", () => {
  it("最後の1行だけが次のページに行くときは、2行を次へ送る", () => {
    // 2行の段落のあとに4行の段落：ページ1に3行入るので、最後の1行だけが次へ行く → 2行を送る。
    const src = `${para("あ", 2)}\n${para("い", 4)}`;
    assert.deepEqual(heads(layoutDocument(withFormat(src, {}), spec)), ["ああいいい", "い"]);
    assert.deepEqual(heads(layoutDocument(withFormat(src, { keepLines: true }), spec)), ["ああいい", "いい"]);
  });

  it("1行目だけがページの最後に残るときは、段落ごと次へ送る", () => {
    const src = `${para("あ", 4)}\n${para("い", 3)}`;
    assert.deepEqual(heads(layoutDocument(withFormat(src, {}), spec)), ["ああああい", "いい"]);
    assert.deepEqual(heads(layoutDocument(withFormat(src, { keepLines: true }), spec)), ["ああああ", "いいい"]);
  });

  it("1行の段落と、ページに収まる段落はそのまま", () => {
    const src = `${para("あ", 4)}\n${para("い", 1)}\n${para("う", 2)}`;
    assert.deepEqual(heads(layoutDocument(withFormat(src, { keepLines: true }), spec)), ["ああああい", "うう"]);
  });
});

describe("見出しを次の行と離さない（DTP-11）", () => {
  it("ページの最後の行に来た見出しは、次のページへ送る（既定の見出しスタイル）", () => {
    const face = new FontService().load(null).face;
    const s = structuredClone(DEFAULT_SETTINGS);
    s.layoutMode = "book";
    s.book.charsPerLine = 10;
    s.book.linesPerPage = 5;
    s.book.topMm = 40;
    const r = typeset(`${para("あ", 4)}\n＃章\n${para("い", 1)}`, s, face);
    const text = r.pages.map((p) => p.items.filter((i) => i.size === s.book.fontSizePt && /[あ章い]/.test(i.text)).map((i) => i.text).join(""));
    assert.ok(!text[0].includes("章") && text[1].startsWith("章"), text.join(" / "));
  });

  it("「次の行と離さない」を外すと、見出しはページの最後に残る", () => {
    const blocks = withFormat(`${para("あ", 4)}\n＃章\n${para("い", 1)}`, { keepWithNext: false });
    assert.deepEqual(heads(layoutDocument(blocks, spec)), ["ああああ章", "い"]);
  });
});
