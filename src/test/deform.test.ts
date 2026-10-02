import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, fitBookToWritingMode, type Settings } from "../document/settings.js";
import { newCharacterStyle, normalizeStyles } from "../document/styles.js";
import { Face, typesetLazy } from "../engine/index.js";
import type { DrawItem } from "../engine/types.js";
import { FontService } from "../fonts/service.js";

let face: Face | undefined;
try {
  face = new Face(new FontService().load(null).bytes);
} catch {
  face = undefined;
}
const skip = !face && "フォントがない";

/** 「変形」の文字スタイルを足した設定。 */
function withDeform(deform: "condensed" | "flat", ratio: number, horizontal = false): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  if (horizontal) {
    s.layoutMode = "book";
    s.book.writingMode = "horizontal";
    fitBookToWritingMode(s.book);
  }
  s.styles.character.push({ ...newCharacterStyle("変形"), deform, deformRatio: ratio });
  return s;
}

/** 「一二三四」の4字（文字スタイルを当てた字）と、続く「五」の DrawItem。 */
function items(s: Settings): DrawItem[] {
  const page = typesetLazy("［＃変形］一二三四［＃／変形］五", s, face!).page(0);
  return "一二三四五".split("").map((ch) => page.items.find((i) => i.text === ch)!);
}

describe("長体・平体", () => {
  it("スタイルに保存でき、知らない値は「なし」、割合は範囲に収める", () => {
    const sheet = normalizeStyles({ paragraph: [], character: [{ name: "a", deform: "flat", deformRatio: 10 }, { name: "b", deform: "斜体" }] });
    assert.equal(sheet.character[0].deform, "flat");
    assert.equal(sheet.character[0].deformRatio, 30);
    assert.equal(sheet.character[1].deform, "");
    assert.equal(sheet.paragraph[0].deform, "");
  });

  it("縦組みの平体：字が縦に縮み（sy）、字の送りも縮む", { skip }, () => {
    const s = withDeform("flat", 50);
    const [a, b, , d, e] = items(s);
    assert.equal(a.sy, 0.5);
    assert.equal(a.sx, 1);
    const size = e.size;
    // 平体の字は半分の送り。平体の4字のあとの字は、平体にしないときより2字分（4字×半分）前に来る。
    assert.ok(Math.abs(b.y - a.y - size * 0.5) < 0.01, `${b.y - a.y}`);
    const plain = typesetLazy("一二三四五", structuredClone(DEFAULT_SETTINGS), face!).page(0).items.find((i) => i.text === "五")!;
    assert.ok(Math.abs(plain.y - e.y - size * 2) < 0.01, `${plain.y - e.y}`);
    assert.ok(d.y < e.y);
    assert.equal(e.sy, undefined);
  });

  it("縦組みの長体：字が横に縮む（sx）が、字の送りは変わらない。字は行の中央のまま", { skip }, () => {
    const s = withDeform("condensed", 70);
    const [a, b, , , e] = items(s);
    assert.equal(a.sx, 0.7);
    assert.equal(a.sy, undefined);
    assert.ok(Math.abs(b.y - a.y - e.size) < 0.01);
    // 字の幅が縮んだ分、左端が中央へ寄る（縮めない字より右）。
    assert.ok(a.x > e.x, `${a.x} ${e.x}`);
  });

  it("横組みの長体：字の送り（横）が縮む", { skip }, () => {
    const s = withDeform("condensed", 50, true);
    const [a, b, , d, e] = items(s);
    assert.equal(a.sx, 0.5);
    const size = e.size;
    assert.ok(Math.abs(b.x - a.x - size * 0.5) < 0.01, `${b.x - a.x}`);
    assert.ok(Math.abs(e.x - d.x - size * 0.5) < 0.01, `${e.x - d.x}`);
  });

  it("横組みの平体：字の送りは変わらず、字が縦に縮む", { skip }, () => {
    const s = withDeform("flat", 60, true);
    const [a, b, , , e] = items(s);
    assert.equal(a.sy, 0.6);
    assert.ok(Math.abs(b.x - a.x - e.size) < 0.01);
  });
});
