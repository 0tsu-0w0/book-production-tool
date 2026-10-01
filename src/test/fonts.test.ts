import fontkit from "@pdf-lib/fontkit";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { describe, it } from "node:test";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { Face } from "../engine/face.js";
import { loadFontBytes } from "../fonts/catalog.js";
import { BUNDLED_FONTS, FontService } from "../fonts/service.js";

const noto = BUNDLED_FONTS[0];

describe("同梱フォント（Noto Serif JP）", () => {
  it("ファイルが assets/fonts/README.md に記録したものと同じ", () => {
    const hash = createHash("sha256").update(fs.readFileSync(noto.path)).digest("hex");
    assert.equal(hash, "eb9ad8326e459fbc405fac820260ea547ccfd8dc17eeaf3149719cd595e6e361");
  });

  it("フォントを選んでいない文書では、同梱フォントを使う", () => {
    const loaded = new FontService().load(null);
    assert.equal(loaded.choice.postscriptName, "NotoSerifJP-Regular");
  });

  it("別の PC のパスで保存された同梱フォントも、名前で見つけ直す", () => {
    const loaded = new FontService().load({ ...noto, path: "Z:/どこか/NotoSerifJP-Regular.ttf" });
    assert.equal(loaded.choice.path, noto.path);
    assert.equal(loaded.warning, undefined);
  });

  it("HarfBuzz と fontkit（PDF 側）が同じ縦書き用字形を選ぶ", () => {
    const bytes = fs.readFileSync(noto.path);
    const face = new Face(bytes);
    const fk = fontkit.create(bytes);
    const mismatched = [..."、。「」『』（）ー―…〜ぁっゃ漢あ"].filter(
      (ch) => face.shape(ch, "ttb")[0].gid !== fk.layout(ch, { vert: true }).glyphs[0].id,
    );
    assert.deepEqual(mismatched, []);
    // 縦書き用字形に置き換わっている（横書きの字形と違う）こと。
    assert.notEqual(face.shape("「", "ttb")[0].gid, face.shape("「", "ltr")[0].gid);
  });

  it("PDF に埋め込んだサブセットでも、すべての字形の輪郭が元と同じ", async () => {
    // 回帰テスト：奇数長の字形データがあると fontkit のサブセットで字形がずれ、PDF の文字が欠けた。
    const bytes = loadFontBytes(noto);
    const text = "縦書きの組版。「のが日本語」――漢字ひらがなカタカナ、、。";
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(bytes, { subset: true });
    doc.addPage().drawText(text, { font, size: 12 });
    const saved = await PDFDocument.load(await doc.save());
    let fontFile: PDFRawStream | undefined;
    for (const [, obj] of saved.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict && obj.get(PDFName.of("Type")) === PDFName.of("FontDescriptor")) {
        fontFile = saved.context.lookup(obj.get(PDFName.of("FontFile2"))) as PDFRawStream;
      }
    }
    const subset = fontkit.create(Buffer.from(decodePDFRawStream(fontFile!).decode()));
    const original = fontkit.create(Buffer.from(bytes));
    // サブセットには .notdef（0番）のあとに、使った順で字形が入る。1つずつ輪郭を比べる。
    const used = [...new Map(original.layout(text).glyphs.map((g) => [g.id, g])).values()];
    assert.equal(subset.numGlyphs, used.length + 1);
    used.forEach((g, i) => {
      assert.equal(subset.getGlyph(i + 1).path.toSVG(), g.path.toSVG(), `${i + 1}番目の字形（元の ${g.id}）の輪郭が違う`);
    });
  });

  it("仮想ボディの下端を OS/2 から読める（1em = 1000）", () => {
    const face = new Face(fs.readFileSync(noto.path));
    assert.equal(face.upem, 1000);
    assert.equal(face.emBottom, -120);
  });
});
