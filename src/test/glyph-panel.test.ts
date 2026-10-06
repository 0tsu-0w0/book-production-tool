import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../document/settings.js";
import { Face, typesetLazy } from "../engine/index.js";
import { parseInline } from "../engine/parse.js";
import { glyphVariants } from "../fonts/glyph-variants.js";
import { variationSelectors } from "../fonts/ivs.js";
import { FontService } from "../fonts/service.js";
import { buildEpub } from "../output/epub.js";
import { glyphTarget, glyphText } from "../renderer/glyph-text.js";

let font: { bytes: Uint8Array; face: Face } | undefined;
try {
  const l = new FontService().load(null);
  font = { bytes: l.bytes, face: l.face };
} catch {
  font = undefined;
}

const VS17 = "\u{E0100}";

describe("字形パネル", () => {
  it("原稿の中で替える字を探す：カーソルの直前の字。異体字セレクタと［＃字形：番号］も含める", () => {
    const t = `渡邊${VS17}さんと芦［＃字形：2］屋`;
    // 「邊＋IVS」のあとにカーソル。
    const a = glyphTarget(t, 4, 4)!;
    assert.deepEqual([a.start, a.end, a.base, a.vs], [1, 4, "邊", 0xe0100]);
    // ［＃字形：2］のあとにカーソル。
    const at = t.indexOf("屋");
    const b = glyphTarget(t, at, at)!;
    assert.deepEqual([t.slice(b.start, b.end), b.base, b.alt], ["芦［＃字形：2］", "芦", 2]);
    // 選んでいれば最初の字。
    assert.equal(glyphTarget(t, 0, 3)!.base, "渡");
    // 空白・記法の括弧・行頭では替えない。
    assert.equal(glyphTarget("　", 1, 1), null);
    assert.equal(glyphTarget("あ", 0, 0), null);
    assert.equal(glyphText("邊", "ivs", 0xe0101), "邊\u{E0101}");
    assert.equal(glyphText("芦", "alt", 2), "芦［＃字形：2］");
    assert.equal(glyphText("芦", "base", 0), "芦");
  });

  it("フォントの異体字（cmap の書式14）と字形の候補（aalt）を並べる。同じ字形は1つだけ", { skip: !font && "フォントがない" }, () => {
    assert.ok(variationSelectors(font!.bytes, 0, "邊".codePointAt(0)!).length >= 5);
    assert.deepEqual(variationSelectors(font!.bytes, 0, "あ".codePointAt(0)!), []);
    const v = glyphVariants(font!.face, font!.bytes, 0, "芦", true);
    assert.equal(v[0].kind, "base");
    assert.ok(v.some((x) => x.kind === "ivs"));
    assert.ok(v.some((x) => x.kind === "alt"));
    assert.ok(v.every((x) => x.d.length > 0));
    // 別の字形のない字は「標準」だけ。
    assert.equal(glyphVariants(font!.face, font!.bytes, 0, "あ", true).length, 1);
  });

  it("［＃字形：番号］は前の字の字形を替える。原稿の字には入らない", { skip: !font && "フォントがない" }, () => {
    const atoms = parseInline("芦［＃字形：2］屋");
    assert.deepEqual(
      atoms.map((a) => a.cells.map((c) => [c.text, c.alt])),
      [[["芦", 2]], [["屋", undefined]]],
    );
    const s = structuredClone(DEFAULT_SETTINGS);
    const gid = (text: string) => typesetLazy(text, s, font!.face).page(0).items.find((i) => i.text === "芦")!.glyphs[0].gid;
    assert.notEqual(gid("芦［＃字形：2］"), gid("芦"));
  });

  it("異体字セレクタを、フォントにない字として知らせない", { skip: !font && "フォントがない" }, () => {
    const r = typesetLazy(`葛${VS17}城と邊\u{E0103}`, structuredClone(DEFAULT_SETTINGS), font!.face);
    assert.deepEqual(r.missingChars, []);
  });

  it("EPUB：異体字はそのまま、字形の候補は font-feature-settings の aalt に", () => {
    const files = buildEpub(`葛${VS17}と芦［＃字形：2］`, structuredClone(DEFAULT_SETTINGS), [], new Date(0));
    const xhtml = new TextDecoder().decode(files.find((f) => /p001\.xhtml$/.test(f.name))!.data);
    assert.ok(xhtml.includes(`葛${VS17}`));
    assert.match(xhtml, /<span style="font-feature-settings:'aalt' 2">芦<\/span>/);
  });
});
