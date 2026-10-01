import assert from "node:assert/strict";
import fs from "node:fs";
import { before, describe, it } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings } from "../document/settings.js";
import { Face, typeset, type DrawPage } from "../engine/index.js";
import { FontService } from "../fonts/service.js";
import { checkPdfX } from "../output/check-pdfx.js";
import { pdfOptions } from "../output/export-pdf.js";
import { findCmykProfiles, iccProblem, outputConditionId, readIcc } from "../output/icc.js";
import { PRINT_PDF, renderPdf } from "../output/pdf.js";

/** テスト用の小さな ICC プロファイル（ヘッダーと説明のタグだけ。v2 の desc 型か v4 の mluc 型）。 */
function fakeIcc(name: string, { space = "CMYK", cls = "prtr", v4 = false } = {}): Uint8Array {
  const text = v4 ? Buffer.from(name, "utf16le").swap16() : Buffer.from(name + "\0", "latin1");
  const tag = Buffer.alloc(v4 ? 28 + text.length : 12 + text.length + 67);
  if (v4) {
    tag.write("mluc", 0, "latin1");
    tag.writeUInt32BE(1, 8);
    tag.writeUInt32BE(12, 12);
    tag.write("enUS", 16, "latin1");
    tag.writeUInt32BE(text.length, 20);
    tag.writeUInt32BE(28, 24);
    text.copy(tag, 28);
  } else {
    tag.write("desc", 0, "latin1");
    tag.writeUInt32BE(text.length, 8);
    text.copy(tag, 12);
  }
  const header = Buffer.alloc(144);
  const size = header.length + tag.length;
  header.writeUInt32BE(size, 0);
  header[8] = v4 ? 4 : 2;
  header.write(cls, 12, "latin1");
  header.write(space, 16, "latin1");
  header.write("Lab ", 20, "latin1");
  header.write("acsp", 36, "latin1");
  header.writeUInt32BE(1, 128);
  header.write("desc", 132, "latin1");
  header.writeUInt32BE(144, 136);
  header.writeUInt32BE(tag.length, 140);
  return new Uint8Array(Buffer.concat([header, tag]));
}

describe("ICC プロファイルを読む", () => {
  it("v2（desc）と v4（mluc）の説明を読み、CMYK の出力用か確かめる", () => {
    const v2 = readIcc(fakeIcc("Japan Color 2001 Coated"));
    assert.equal(v2.name, "Japan Color 2001 Coated");
    assert.equal(v2.colorSpace, "CMYK");
    assert.equal(iccProblem(v2), undefined);
    assert.equal(readIcc(fakeIcc("Coated FOGRA39", { v4: true })).name, "Coated FOGRA39");
    assert.match(iccProblem(readIcc(fakeIcc("sRGB", { space: "RGB ", cls: "mntr" })))!, /CMYK/);
    assert.match(iccProblem(readIcc(fakeIcc("x", { cls: "mntr" })))!, /出力用/);
    assert.throws(() => readIcc(new Uint8Array(200)), /ICC プロファイルではありません/);
  });

  it("よく知られた印刷条件は登録済みの識別子にする", () => {
    assert.equal(outputConditionId("Japan Color 2001 Coated"), "JC200103");
    assert.equal(outputConditionId("自作の条件"), "自作の条件");
  });

  it("Windows の色のフォルダに RSWOP があれば、CMYK の出力用として見つかる", { skip: process.platform !== "win32" && "Windows だけ" }, () => {
    const found = findCmykProfiles();
    const rswop = found.find((p) => /rswop/i.test(p.path));
    if (fs.existsSync(`${process.env.WINDIR}\\System32\\spool\\drivers\\color\\RSWOP.icm`)) assert.ok(rswop, JSON.stringify(found));
    // sRGB などの RGB のプロファイルは入らない。
    assert.ok(!found.some((p) => /srgb/i.test(p.name)));
  });
});

let fontBytes: Uint8Array | undefined;
try {
  fontBytes = new FontService().load(null).bytes;
} catch {
  fontBytes = undefined;
}

describe("PDF/X-4 の書き出し", { skip: !fontBytes && "フォントが見つからない" }, () => {
  let pages: DrawPage[];
  before(() => {
    pages = typeset("吾輩は猫である。\n名前はまだ無い。", DEFAULT_SETTINGS, new Face(fontBytes!)).pages;
  });

  it("ICC プロファイルを埋め込んだ PDF/X-4 は検査をすべて通る", async () => {
    const pdf = await renderPdf(pages, fontBytes!, { ...PRINT_PDF, standard: "x4", icc: fakeIcc("Japan Color 2001 Coated"), title: "猫 & <test>" });
    assert.equal(Buffer.from(pdf.subarray(0, 8)).toString("latin1"), "%PDF-1.6");
    const items = await checkPdfX(pdf, "x4");
    assert.deepEqual(items.filter((i) => !i.ok), []);
    assert.equal(items.find((i) => i.rule.startsWith("出力インテント（"))?.detail, "JC200103");
    // PDF/X-1a の検査では、版の違いで不合格になる。
    assert.ok((await checkPdfX(pdf, "x1a")).some((i) => !i.ok));
  });

  it("ICC プロファイルがない・CMYK でないなら、書き出さずにエラーにする", async () => {
    await assert.rejects(renderPdf(pages, fontBytes!, { ...PRINT_PDF, standard: "x4", title: "t" }), /ICC プロファイル/);
    await assert.rejects(
      renderPdf(pages, fontBytes!, { ...PRINT_PDF, standard: "x4", icc: fakeIcc("sRGB", { space: "RGB ", cls: "mntr" }), title: "t" }),
      /CMYK/,
    );
  });

  it("設定：入稿用のときだけ規格を渡し、読み込みでは x1a か x4 にそろえる", () => {
    const s = normalizeSettings({ output: { pdfStandard: "x9", iccPath: "a.icc" } });
    assert.equal(s.output.pdfStandard, "x1a");
    assert.equal(s.output.iccPath, "a.icc");
    s.output.pdfStandard = "x4";
    assert.equal(pdfOptions(s, "t").standard, "x4");
    assert.equal(pdfOptions({ ...s, pdfKind: "screen" }, "t").standard, undefined);
  });
});
