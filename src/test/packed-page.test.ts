import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { Face, typesetLazy } from "../engine/index.js";
import { packPage, unpackPage } from "../engine/packed-page.js";
import type { DrawPage } from "../engine/types.js";
import { FontService } from "../fonts/service.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}
const noFont = !bytes && "フォントがない";

const pagesOf = (text: string, over: (s: Settings) => void = () => {}): DrawPage[] => {
  const s = structuredClone(DEFAULT_SETTINGS);
  over(s);
  const r = typesetLazy(text, s, new Face(bytes!));
  return Array.from({ length: r.pageCount }, (_, i) => r.page(i));
};

describe("画面へ送るページの詰めた形", () => {
  it("詰めて送って戻すと、元のページと同じ（ルビ・縦中横・横倒し・太字・色・原稿の位置）", { skip: noFont }, () => {
    const text = ["＃第一章　雨", "　｜図書館《としょかん》で、ＡＢＣと12を読む。［＃太字］強く［＃／太字］。" + "あ".repeat(400), "［＃改ページ］", "　次のページ。"].join("\n");
    for (const horizontal of [false, true]) {
      const pages = pagesOf(text, (s) => {
        if (horizontal) s.book.writingMode = "horizontal";
        s.format.halfWidth = "rotate";
      });
      assert.ok(pages.length >= 2);
      for (const p of pages) {
        const { sig, ...back } = unpackPage(structuredClone(packPage(p)));
        assert.deepStrictEqual(back, p);
        assert.match(sig, /^[0-9a-z]+\.[0-9a-z]+$/);
      }
    }
  });

  it("指紋：同じ中身なら同じ、字が1つでも違えば違う", { skip: noFont }, () => {
    const a = pagesOf("あいう\n［＃改ページ］\nえお");
    const b = pagesOf("あいう\n［＃改ページ］\nえか");
    assert.equal(packPage(a[0]).sig, packPage(b[0]).sig);
    assert.notEqual(packPage(a[1]).sig, packPage(b[1]).sig);
    assert.equal(packPage(a[1]).sig, packPage(pagesOf("あいう\n［＃改ページ］\nえお")[1]).sig);
  });

  it("字のないページも詰めて戻せる", () => {
    const empty: DrawPage = { index: 0, width: 100, height: 200, paper: "#ffffff", items: [], shapes: [] };
    const { sig: _sig, ...back } = unpackPage(packPage(empty));
    assert.deepStrictEqual(back, empty);
  });
});
