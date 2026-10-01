import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../document/settings.js";
import { Face, typeset, type DrawPage } from "../engine/index.js";
import { FontService } from "../fonts/service.js";
import { checkPdfX1a } from "../output/check-pdfx.js";
import { PRINT_PDF, SCREEN_PDF, renderPdf } from "../output/pdf.js";
import { SAMPLE_TEXT } from "../sample.js";

let fontBytes: Uint8Array | undefined;
try {
  fontBytes = new FontService().load(null).bytes;
} catch {
  fontBytes = undefined;
}

describe("PDF 出力", { skip: !fontBytes && "フォントが見つからない" }, () => {
  let pages: DrawPage[];
  before(() => {
    pages = typeset(SAMPLE_TEXT, DEFAULT_SETTINGS, new Face(fontBytes!)).pages;
  });

  it("入稿用 PDF は PDF/X-1a:2003 の検査をすべて通る", async () => {
    const pdf = await renderPdf(pages, fontBytes!, { ...PRINT_PDF, title: "test" });
    const failed = (await checkPdfX1a(pdf)).filter((i) => !i.ok);
    assert.deepEqual(failed, []);
  });

  it("トンボなしの入稿用 PDF も検査を通る", async () => {
    const pdf = await renderPdf(pages, fontBytes!, { ...PRINT_PDF, marks: false, title: "test" });
    assert.deepEqual((await checkPdfX1a(pdf)).filter((i) => !i.ok), []);
  });

  it("閲覧用 PDF（RGB）は色の検査で不合格になる", async () => {
    const pdf = await renderPdf(pages, fontBytes!, { ...SCREEN_PDF, title: "test" });
    const color = (await checkPdfX1a(pdf)).find((i) => i.rule.startsWith("色は"));
    assert.equal(color?.ok, false);
  });

  it("PDF/X に RGB を指定するとエラーにする", async () => {
    await assert.rejects(renderPdf(pages, fontBytes!, { ...PRINT_PDF, color: "rgb", title: "test" }));
  });

  it("仕上がりサイズは文庫判（105×148mm）で、塗り足しは3mm", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await renderPdf(pages, fontBytes!, { ...PRINT_PDF, title: "test" }));
    const page = doc.getPage(0);
    const trim = page.getTrimBox();
    const bleed = page.getBleedBox();
    const mm = (pt: number) => (pt * 25.4) / 72;
    assert.ok(Math.abs(mm(trim.width) - 105) < 0.01);
    assert.ok(Math.abs(mm(trim.height) - 148) < 0.01);
    assert.ok(Math.abs(mm(trim.x - bleed.x) - 3) < 0.01);
  });
});
