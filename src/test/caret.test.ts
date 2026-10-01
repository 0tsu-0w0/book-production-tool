import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../document/settings.js";
import { Face, typeset } from "../engine/index.js";
import { typesetLazy } from "../engine/index.js";
import { FontService } from "../fonts/service.js";
import { afterInsert, caretAt, moveChar, moveLine } from "../renderer/caret.js";

let face: Face | undefined;
try {
  face = new Face(new FontService().load(null).bytes);
} catch {
  face = undefined;
}

describe("紙面で入力：原稿の中のカーソルの動き（DTP-15）", () => {
  it("1字ずつ動き、行の端では前後の行へ。サロゲートペアは1字", () => {
    const lines = ["あい", "𠮷う"];
    assert.deepEqual(moveChar(lines, [0, 2], 1), [1, 0]);
    assert.deepEqual(moveChar(lines, [1, 0], 1), [1, 2]);
    assert.deepEqual(moveChar(lines, [1, 2], -1), [1, 0]);
    assert.deepEqual(moveChar(lines, [1, 0], -1), [0, 2]);
    assert.deepEqual(moveChar(lines, [0, 0], -1), [0, 0]);
    assert.deepEqual(moveChar(lines, [1, 3], 1), [1, 3]);
  });

  it("入れた字のあとにカーソルを置く（改行を含めば次の行）", () => {
    assert.deepEqual(afterInsert([2, 3], "猫"), [2, 4]);
    assert.deepEqual(afterInsert([2, 3], "猫\nは"), [3, 1]);
  });
});

describe("紙面で入力：紙面のカーソル", { skip: !face && "フォントが見つからない" }, () => {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), preset: "文字中（36字×15行）" };

  it("カーソルは字の上（縦組み）。行末なら最後の字の下", () => {
    const [page] = typeset("吾輩は猫\n名前", settings, face!).pages;
    const item = (t: string) => page.items.find((i) => i.text === t)!;
    const c = caretAt(page, [0, 2], true)!;
    assert.ok(Math.abs(c.x - item("は").x) < 1e-6 && c.y < item("は").y && c.h === 0);
    const end = caretAt(page, [0, 4], true)!;
    assert.ok(end.y > item("猫").y - 1e-6);
  });

  it("左の矢印で次の行の、同じ高さの字へ", () => {
    const [page] = typeset("吾輩は猫\n名前はまだ無い", settings, face!).pages;
    const c = caretAt(page, [0, 2], true)!;
    assert.deepEqual(moveLine(page, c, 1, true), [1, 2]);
    // 次の行が短ければ、その行の最後の字のあと。
    const [p2] = typeset("吾輩は猫である\n名前", settings, face!).pages;
    assert.deepEqual(moveLine(p2, caretAt(p2, [0, 5], true)!, 1, true), [1, 2]);
    // 前の行がなければ動かない。
    assert.equal(moveLine(page, c, -1, true), undefined);
  });

  it("カーソルのある原稿の位置から、そのページを探す", () => {
    const text = Array.from({ length: 40 }, (_, i) => `${i}行目の段落です。`).join("\n");
    const r = typesetLazy(text, settings, face!);
    assert.equal(r.pageOf(0, 0), 0);
    const last = r.pageOf(39, 0);
    assert.ok(last > 0 && last < r.pageCount);
    assert.ok(r.page(last).items.some((i) => i.src?.[0] === 39));
  });
});
