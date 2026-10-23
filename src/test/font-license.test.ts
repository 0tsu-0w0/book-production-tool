import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { DEFAULT_STYLES } from "../document/styles.js";
import { embedRestriction, readTables } from "../fonts/sfnt.js";
import { FontService } from "../fonts/service.js";
import { epubFonts } from "../output/epub-fonts.js";
import { buildEpub } from "../output/epub.js";
import { exportPdf } from "../output/export-pdf.js";
import { preflight } from "../output/preflight.js";

// #5：埋め込みを禁じた書体（OS/2 の fsType）。同梱の書体の fsType だけを書き換えて試す。
const body = new FontService().load(null);
const withFsType = (fsType: number) => {
  const bytes = new Uint8Array(body.bytes);
  const os2 = readTables((o, l) => bytes.subarray(o, o + l), 0).find((t) => t.tag === "OS/2")!;
  new DataView(bytes.buffer).setUint16(os2.offset + 8, fsType);
  return bytes;
};
const settings = (edit: (s: Settings) => void = () => {}): Settings => {
  const s = { ...structuredClone(DEFAULT_SETTINGS), styles: structuredClone(DEFAULT_STYLES) };
  edit(s);
  return s;
};
/** PDF に埋め込んだ書体のファイル（FontFile・FontFile2・FontFile3）の数。 */
const embeddedFonts = async (b: Uint8Array) => {
  const doc = await PDFDocument.load(b);
  const keys = ["FontFile", "FontFile2", "FontFile3"].map((k) => PDFName.of(k));
  return doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFDict && keys.some((k) => o.has(k))).length;
};

describe("埋め込みを禁じた書体（#5）", () => {
  it("fsType から、埋め込めない理由を読む（プレビューと印刷・編集可は埋め込める）", () => {
    assert.equal(embedRestriction(withFsType(0)), undefined);
    assert.equal(embedRestriction(withFsType(4)), undefined);
    assert.equal(embedRestriction(withFsType(8)), undefined);
    assert.match(embedRestriction(withFsType(2))!, /禁止/);
    assert.match(embedRestriction(withFsType(0x200))!, /ビットマップ/);
    assert.match(embedRestriction(withFsType(0x100))!, /絞って/);
  });

  it("PDF：埋め込みを禁じた書体なら、閲覧用でも字をアウトラインにし、書体を埋め込まない", async () => {
    for (const kind of ["screen", "print"] as const) {
      const ok = await exportPdf("本文の字。", settings((s) => (s.pdfKind = kind)), [{ key: "body", bytes: withFsType(0) }], "t");
      assert.ok((await embeddedFonts(ok.bytes)) > 0, kind);
      const no = await exportPdf("本文の字。", settings((s) => (s.pdfKind = kind)), [{ key: "body", bytes: withFsType(2) }], "t");
      assert.equal(await embeddedFonts(no.bytes), 0, kind);
    }
  });

  it("EPUB：埋め込みを禁じた書体は入れない", () => {
    const s = settings();
    const files = buildEpub("本文の字。", s, []);
    const choice = { name: "試し", postscriptName: "T", path: "t.ttf", index: 0 };
    assert.equal(epubFonts(files, s, [{ choice, bytes: withFsType(0) }], ["body"]).length, 1);
    assert.equal(epubFonts(files, s, [{ choice, bytes: withFsType(2) }], ["body"]).length, 0);
  });

  it("書き出す前の検査で、PDF では字をアウトラインにすることを知らせる", () => {
    const findings = preflight({
      settings: settings(),
      pageCount: 0,
      page: () => ({ glyphs: [], shapes: [] }) as never,
      missingChars: [],
      fontWarnings: [],
      target: "pdf",
      restrictedFonts: [{ name: "試しの書体", reason: "埋め込みが禁止されている" }],
    });
    assert.ok(findings.some((f) => f.level === "info" && f.message.includes("試しの書体") && f.message.includes("アウトライン")));
  });
});
