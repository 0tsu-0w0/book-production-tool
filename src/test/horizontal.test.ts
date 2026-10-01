import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, bookGeometry, normalizeSettings, type Settings } from "../document/settings.js";
import { typeset } from "../engine/index.js";
import { DEFAULT_SPEC, MM, layoutDocument } from "../engine/layout.js";
import { parse } from "../engine/parse.js";
import type { LayoutSpec } from "../engine/types.js";
import { FontService } from "../fonts/service.js";
import { imposeSpreads, spreadPairs } from "../output/imposition.js";

const face = new FontService().load(null).face;
const spec: LayoutSpec = { ...DEFAULT_SPEC, horizontal: true, margins: { topMm: 20, gutterMm: 15 } };
const book = (edit: (s: Settings) => void = () => {}): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.layoutMode = "book";
  s.book.writingMode = "horizontal";
  edit(s);
  return s;
};

describe("横組み（DTP-01）", () => {
  it("字は左から右へ、行は上から下へ進む", () => {
    const [page] = layoutDocument(parse(`あい\n${"う".repeat(40)}`), { ...spec, charsPerLine: 30 });
    const g = (t: string) => page.glyphs.filter((x) => x.text === t);
    const [a] = g("あ");
    const [i] = g("い");
    assert.equal(a.kind, "hcell");
    assert.ok(i.x > a.x && Math.abs(i.y - a.y) < 1e-9, "同じ行で右へ");
    const u = g("う");
    assert.ok(u[30].y > u[0].y && Math.abs(u[30].x - u[0].x) < 1e-6, "31字目は次の行の頭");
    assert.ok(u[0].y > a.y, "次の段落は下の行");
  });

  it("版面は横長：幅は字数、高さは行数で決まり、ページの寸法は変わらない", () => {
    const [page] = layoutDocument(parse("あ"), { ...spec, charsPerLine: 30, linesPerPage: 20 });
    assert.ok(Math.abs(page.width - 105 * MM) < 1e-6 && Math.abs(page.height - 148 * MM) < 1e-6);
    assert.ok(Math.abs(page.block.width - 30 * spec.fontSizePt) < 1e-6);
    assert.ok(Math.abs(page.block.height - (19 * spec.fontSizePt * spec.lineGap + spec.fontSizePt)) < 1e-6);
    assert.ok(Math.abs(page.block.top - 20 * MM) < 1e-6, "天");
  });

  it("左綴じ：奇数ページ（右ページ）は左側が、偶数ページ（左ページ）は右側がノド", () => {
    const [odd, even] = layoutDocument(parse("あ\n＝＝＝\nい"), spec);
    assert.ok(Math.abs(odd.block.left - 15 * MM) < 1e-6);
    assert.ok(Math.abs(even.width - (even.block.left + even.block.width) - 15 * MM) < 1e-6);
  });

  it("ルビ・圏点は字の上、傍線は字の下、割注は上下2行", () => {
    const [page] = layoutDocument(parse("｜漢《かん》｜圏《圏》｜傍《傍線》［＃割注］あいうえ［＃／割注］"), spec);
    const g = (t: string) => page.glyphs.find((x) => x.text === t)!;
    assert.ok(g("か").y < g("漢").y, "ルビは上");
    assert.ok(page.glyphs.find((x) => x.kind === "hmark")!.y < g("圏").y, "圏点は上");
    const line = page.shapes.find((s) => s.kind === "line")!;
    assert.ok(line.kind === "line" && line.y1 > g("傍").y, "傍線は下");
    assert.ok(g("あ").y < g("う").y && Math.abs(g("あ").x - g("う").x) < 1e-6, "割注の前半は上の行");
  });

  it("縦中横の数字は、横組みでは1字分に横に並べる", () => {
    const [page] = layoutDocument(parse("第12号"), spec);
    const n = page.glyphs.find((x) => x.text === "12")!;
    assert.equal(n.kind, "hcell");
    assert.equal(n.fit, true);
  });

  it("画像は縦横比を保ったまま、横組みの向きに置く", () => {
    const [page] = layoutDocument(parse("［＃画像：絵］"), { ...spec, images: { 絵: { width: 400, height: 300 } } });
    const img = page.shapes.find((s) => s.kind === "image")!;
    assert.ok(img.kind === "image" && Math.abs(img.h / img.w - 0.75) < 1e-9);
  });

  it("柱とノンブルは小口側：奇数ページは右、偶数ページは左", () => {
    const r = typeset("あ\n＝＝＝\nい", book(), face);
    const nombre = (i: number) => r.pages[i].items.find((x) => /^[0-9]+$/.test(x.text))!;
    assert.ok(nombre(0).x > r.pages[0].width / 2, "1ページ（右ページ）は右");
    assert.ok(nombre(1).x < r.pages[1].width / 2, "2ページ（左ページ）は左");
  });

  it("見開きは左に偶数ページ、右に奇数ページ（1ページ目は右に1枚）", () => {
    assert.deepEqual(spreadPairs(3, 1, true), [
      { left: null, right: 0 },
      { left: 1, right: 2 },
    ]);
    const r = typeset("あ\n＝＝＝\nい\n＝＝＝\nう", book(), face);
    assert.deepEqual(imposeSpreads(r.pages, 1, true).labels, ["001", "002-003"]);
  });

  it("版面の大きさの表示も横組みの向きになる", () => {
    const s = book();
    const g = bookGeometry(s.book);
    assert.ok(g.blockWidthMm > g.blockHeightMm, "文庫の横組みは版面が横長");
    assert.equal(normalizeSettings({ book: { writingMode: "diagonal" } }).book.writingMode, "vertical");
  });
});
