import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { Face, typeset } from "../engine/index.js";
import { DEFAULT_SPEC, layoutDocument } from "../engine/layout.js";
import { parse } from "../engine/parse.js";
import { FontService } from "../fonts/service.js";

let face: Face | undefined;
try {
  face = new Face(new FontService().load(null).bytes);
} catch {
  face = undefined;
}

describe("ページ番号の参照（［＃ラベル：名前］・［＃ページ：名前］）", () => {
  it("ラベルは字に付き、ページに記録される。字のないラベルの行は次の字のページ", () => {
    const pages = layoutDocument(parse("あ\n＝＝＝\nい［＃ラベル：x］\n＝＝＝\n［＃ラベル：y］\nう"), DEFAULT_SPEC);
    assert.deepEqual(pages.map((p) => p.labels ?? []), [[], ["x"], ["y"]]);
  });

  it("組むと、参照にラベルのページ番号が入る（ないラベルは「？」）", { skip: !face && "フォントがない" }, () => {
    const s: Settings = structuredClone(DEFAULT_SETTINGS);
    const text = "第3ページを見よ（［＃ページ：three］ページ）。ない：［＃ページ：none］\n＝＝＝\n二\n＝＝＝\n［＃ラベル：three］\n三";
    const r = typeset(text, s, face!);
    const first = r.pages[0].items.map((i) => i.text).join("");
    assert.match(first, /（３ページ）/);
    assert.match(first, /ない：？/);
  });

  it("番号の桁が変わって組みが変わっても、番号は正しいページになる", { skip: !face && "フォントがない" }, () => {
    const s: Settings = structuredClone(DEFAULT_SETTINGS);
    const filler = Array.from({ length: 12 }, (_, i) => `${i}\n＝＝＝`).join("\n");
    const r = typeset(`参照［＃ページ：end］\n${filler}\n［＃ラベル：end］\n終わり`, s, face!);
    const last = r.pages.findIndex((p) => p.items.some((i) => i.text === "終"));
    assert.ok(r.pages[0].items.some((i) => i.text === String(last + 1)), `${last + 1}`);
  });
});
