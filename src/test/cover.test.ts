import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings, spineWidthMm, type Settings } from "../document/settings.js";
import { typesetCover } from "../engine/cover.js";
import { Face, singleFont } from "../engine/index.js";
import { coverParts } from "../engine/layout.js";
import { FontService } from "../fonts/service.js";
import { checkPdfX } from "../output/check-pdfx.js";
import { PRINT_PDF, renderPdf } from "../output/pdf.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}
const MM = 72 / 25.4;

const book = (over: (s: Settings) => void = () => {}) => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.layoutMode = "book";
  s.bookInfo.title = "雨の図書館";
  s.bookInfo.author = "山田花子";
  over(s);
  return s;
};

describe("表紙", () => {
  it("右綴じは表1が左、左綴じは表1が右", () => {
    assert.deepEqual(coverParts({ trimWidth: 100, spine: 10, leftBound: false }), { front: 0, spine: 100, back: 110, width: 210 });
    assert.deepEqual(coverParts({ trimWidth: 100, spine: 10, leftBound: true }), { back: 0, spine: 100, front: 110, width: 210 });
  });

  it("設定の読み込み：色は #rrggbb", () => {
    const s = normalizeSettings({ cover: { background: "red", textColor: "#112233", spineText: false } });
    assert.equal(s.cover.background, "#ffffff");
    assert.equal(s.cover.textColor, "#112233");
    assert.equal(s.cover.spineText, false);
  });

  it("大きさは仕上がり2枚と背幅。題は表1と背に、著者名も", { skip: !bytes && "フォントがない" }, () => {
    const face = new Face(bytes!);
    const s = book();
    const r = typesetCover(s, singleFont(face), {}, 200);
    // 背幅は、本文の紙の枚数（2ページで1枚）× 紙の厚さ。
    assert.ok(Math.abs(r.spineMm - spineWidthMm(200, s.output)) < 1e-6 && r.spineMm > 5);
    const trimW = r.page.width - r.spineMm * MM;
    assert.ok(Math.abs(r.widthMm * MM - r.page.width) < 1e-6 && trimW > 0);
    const xs = (t: string) => r.page.items.filter((i) => i.text === t).map((i) => i.x);
    // 「雨」は表1（左半分）と背に1つずつ。
    const rain = xs("雨");
    assert.equal(rain.length, 2);
    assert.ok(rain.some((x) => x < trimW / 2));
    assert.ok(rain.some((x) => x > trimW / 2 && x < trimW / 2 + r.spineMm * MM));
    assert.equal(xs("山").length, 2);
  });

  it("背幅が4mmより狭いと背には入れない。左綴じ（横組み）なら表1は右で横に並ぶ", { skip: !bytes && "フォントがない" }, () => {
    const face = new Face(bytes!);
    const thin = typesetCover(book(), singleFont(face), {}, 40);
    assert.equal(thin.page.items.filter((i) => i.text === "雨").length, 1);
    const h = typesetCover(book((s) => (s.book.writingMode = "horizontal")), singleFont(face), {}, 200);
    const title = h.page.items.filter((i) => "雨の図書館".includes(i.text) && i.x > h.page.width / 2);
    assert.equal(new Set(title.map((i) => Math.round(i.y))).size, 1, "表1の題は1行の横組み");
  });

  it("入稿用の表紙 PDF は PDF/X-1a の検査に通る", { skip: !bytes && "フォントがない" }, async () => {
    const face = new Face(bytes!);
    const r = typesetCover(book((s) => (s.cover.background = "#1f2a44")), singleFont(face), {}, 200);
    const pdf = await renderPdf([r.page], bytes!, { ...PRINT_PDF, title: "表紙" });
    assert.deepEqual((await checkPdfX(pdf, "x1a")).filter((i) => !i.ok), []);
  });
});

describe("表紙の画像の透明", () => {
  it("入稿用では、透明な部分を地の色の上に重ねる", async () => {
    const { toDeviceColor } = await import("../output/pdf-images.js");
    const clear = { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) };
    assert.deepEqual([...toDeviceColor(clear, "cmyk")], [0, 0, 0, 0]);
    // 黒の地なら K100%。
    assert.deepEqual([...toDeviceColor(clear, "cmyk", "#000000")], [0, 0, 0, 255]);
  });
});
