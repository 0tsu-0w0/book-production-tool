import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../document/settings.js";
import { Face, typesetLazy } from "../engine/index.js";
import { breakLines } from "../engine/layout.js";
import { listNumber, parse } from "../engine/parse.js";
import type { Atom, Block } from "../engine/types.js";
import { FontService } from "../fonts/service.js";

let face: Face | undefined;
try {
  face = new Face(new FontService().load(null).bytes);
} catch {
  face = undefined;
}

const text = (b: Block) => (b.kind === "para" ? b.atoms.map((a) => a.cells.map((c) => c.text).join("")).join("") : "");
const paras = (src: string) => parse(src).filter((b) => b.kind === "para");

describe("箇条書き・番号付き", () => {
  it("箇条書き：間の行の頭に「・」を付ける。印は変えられる。閉じたあとはふつうの段落", () => {
    const b = paras("［＃箇条書き］\nりんご\nみかん\n［＃／箇条書き］\nふつう\n［＃箇条書き：●］\nぶどう\n［＃／箇条書き］");
    assert.deepEqual(b.map(text), ["・りんご", "・みかん", "ふつう", "●ぶどう"]);
    assert.equal((b[0] as { atoms: Atom[] }).atoms[0].listMark, true);
    assert.equal((b[2] as { atoms: Atom[] }).atoms[0].listMark, undefined);
  });

  it("番号付き：書式の数の所を番号にする（1・１・一・①）。書式がなければ（1）", () => {
    assert.equal(listNumber("", 3), "（3）");
    assert.equal(listNumber("1．", 12), "12．");
    assert.equal(listNumber("第１項　", 2), "第2項　");
    assert.equal(listNumber("一、", 11), "十一、");
    assert.equal(listNumber("一、", 20), "二十、");
    assert.equal(listNumber("①", 3), "③");
    const b = paras("［＃番号付き：一、］\n春\n\n夏\n［＃／番号付き］");
    // 空行は項目にせず、番号も進めない。
    assert.deepEqual(b.map(text), ["一、春", "二、夏"]);
  });

  it("読み取り結果を使い回しても、印が二重に付かない", () => {
    paras("［＃箇条書き］\nりんご\n［＃／箇条書き］");
    assert.deepEqual(paras("りんご").map(text), ["りんご"]);
    assert.deepEqual(paras("［＃箇条書き］\nりんご\n［＃／箇条書き］").map(text), ["・りんご"]);
  });

  it("ぶら下げ：2行目以降を印の幅だけ下げる", () => {
    const atoms: Atom[] = [{ cells: [{ text: "（" }, { text: "1" }, { text: "）" }], listMark: true }, ...[..."あいうえおかきくけこさしすせそ"].map((ch) => ({ cells: [{ text: ch }] }))];
    const lines = breakLines(atoms, 10, 0, { kinsoku: "strong", hanging: false, justify: false }, 3);
    assert.equal(lines[0].indent, 0);
    assert.equal(lines[1].indent, 3);
    assert.equal(lines[2]?.indent ?? 3, 3);
  });

  it("組んだページでも、項目の2行目は本文の字の位置まで下がる", { skip: !face && "フォントがない" }, () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    const long = "あ".repeat(60);
    const page = typesetLazy(`［＃箇条書き］\n${long}\n［＃／箇条書き］`, s, face!).page(0);
    const marks = page.items.filter((i) => i.text === "・");
    const as = page.items.filter((i) => i.text === "あ");
    // 1行目：印の次から。2行目：1行目の最初の「あ」と同じ高さから始まる。
    const firstTop = Math.min(...as.filter((i) => Math.abs(i.x - as[0].x) < 1).map((i) => i.y));
    const second = as.filter((i) => i.x < as[0].x - 1);
    assert.ok(marks.length === 1 && second.length > 0);
    assert.ok(Math.abs(Math.min(...second.map((i) => i.y)) - firstTop) < 0.5, `${Math.min(...second.map((i) => i.y))} ${firstTop}`);
  });
});
