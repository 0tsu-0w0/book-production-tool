import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings } from "../document/settings.js";
import { FontService } from "../fonts/service.js";
import { checkPdfX } from "../output/check-pdfx.js";
import { exportPdf, pdfOptions } from "../output/export-pdf.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}

describe("文字のアウトライン化", { skip: !bytes && "フォントがない" }, () => {
  it("入稿用だけ。設定の既定はしない", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    assert.equal(normalizeSettings({}).output.outline, false);
    s.output.outline = true;
    assert.equal(pdfOptions(s, "t").outline, true);
    assert.equal(pdfOptions({ ...s, pdfKind: "screen" }, "t").outline, false);
  });

  it("フォントを埋め込まず、字形を図形（Form XObject）にする。PDF/X-1a の検査に通る", async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.output.outline = true;
    const r = await exportPdf("［＃太字］太字［＃／太字］と ABC と12。\n吾輩は猫である。", s, [{ key: "", bytes: bytes! }], "t");
    const raw = Buffer.from(r.bytes).toString("latin1");
    assert.ok(!/\/FontFile/.test(raw), "フォントを埋め込んでいない");
    assert.ok(!/\/Type\s*\/Font\b/.test(raw), "フォントの辞書がない");
    assert.ok(/\/Subtype \/Form/.test(raw), "字形の図形がある");
    assert.deepEqual(r.check?.filter((c) => !c.ok), []);
    assert.deepEqual((await checkPdfX(r.bytes, "x1a")).filter((c) => !c.ok), []);
  });
});
