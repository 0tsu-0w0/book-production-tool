import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings, saddleOutput } from "../document/settings.js";
import type { DrawPage } from "../engine/types.js";
import { imposeSaddle, saddlePairs, type Spread } from "../output/imposition.js";
import { preflight } from "../output/preflight.js";

/**
 * 面付けした紙を実際に重ねて折ったときの、読む順のページ（0始まり。白ページは null）。
 * 紙は表・裏の順に並ぶ。重ねた紙を真ん中で折ると、各紙の表の「綴じの反対側」半分が前半に、裏が続く。
 */
function readingOrder(pairs: Spread[], leftBound: boolean): (number | null)[] {
  const sheets = pairs.length / 2;
  const front: (number | null)[] = [];
  const back: (number | null)[] = [];
  for (let s = 0; s < sheets; s++) {
    const outer = pairs[2 * s];
    const inner = pairs[2 * s + 1];
    // 右綴じ：表紙側は紙の左半分。外側の表の左 → 内側の裏の右 の順に前半のページが続く。
    if (leftBound) {
      front.push(outer.right, inner.left);
      back.unshift(inner.right, outer.left);
    } else {
      front.push(outer.left, inner.right);
      back.unshift(inner.left, outer.right);
    }
  }
  return [...front, ...back];
}

describe("中綴じの面付け", () => {
  it("8ページ・右綴じ：1枚目の表は1と8、裏は7と2", () => {
    const p = saddlePairs(8, 1);
    assert.deepEqual(p[0], { left: 0, right: 7 });
    assert.deepEqual(p[1], { left: 6, right: 1 });
    assert.deepEqual(p[2], { left: 2, right: 5 });
    assert.deepEqual(p[3], { left: 4, right: 3 });
  });

  it("左綴じは左右が逆", () => {
    const p = saddlePairs(8, 1, true);
    assert.deepEqual(p[0], { left: 7, right: 0 });
    assert.deepEqual(p[1], { left: 1, right: 6 });
  });

  it("重ねて折ると、ページが1から順に並ぶ（右綴じ・左綴じ、いろいろなページ数）", () => {
    for (const leftBound of [false, true]) {
      for (const n of [4, 8, 12, 16, 32]) {
        const order = readingOrder(saddlePairs(n, 1, leftBound), leftBound);
        assert.deepEqual(order, Array.from({ length: n }, (_, i) => i), `${n} ${leftBound}`);
      }
    }
  });

  it("4の倍数でなければ最後に白ページを足す。開始番号が偶数なら先頭にも1つ", () => {
    const order = readingOrder(saddlePairs(5, 1), false);
    assert.deepEqual(order, [0, 1, 2, 3, 4, null, null, null]);
    const even = readingOrder(saddlePairs(6, 2), false);
    assert.deepEqual(even, [null, 0, 1, 2, 3, 4, 5, null]);
  });

  it("紙の面は2ページ分の幅で、白ページは紙の色だけ", () => {
    const page = (i: number): DrawPage => ({ index: i, width: 100, height: 200, paper: "#fffff0", items: [], shapes: [{ kind: "rect", x: 0, y: 0, w: 10, h: 10 }] });
    const r = imposeSaddle([page(0), page(1), page(2)], 1);
    assert.equal(r.sheets, 1);
    assert.equal(r.blanks, 1);
    assert.equal(r.pages.length, 2);
    assert.equal(r.pages[0].width, 200);
    // 1枚目の表：左に1ページ目、右に白ページ（4ページ目）。
    assert.equal(r.pages[0].shapes.length, 1);
    assert.equal(r.pages[0].paper, "#fffff0");
  });

  it("中綴じは閲覧用 PDF だけ。設定に保存でき、知らない値は単ページ", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.output.imposition = "saddle";
    s.pdfKind = "screen";
    assert.equal(saddleOutput(s), true);
    s.pdfKind = "print";
    assert.equal(saddleOutput(s), false);
    assert.equal(normalizeSettings({ output: { imposition: "saddle" } }).output.imposition, "saddle");
    assert.equal(normalizeSettings({ output: { imposition: "折り" } }).output.imposition, "single");
  });

  it("書き出す前の検査で、紙の枚数と白ページの数、刷り方を知らせる", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.output.imposition = "saddle";
    s.pdfKind = "screen";
    const empty: DrawPage = { index: 0, width: 300, height: 400, paper: "#ffffff", items: [], shapes: [] };
    const f = preflight({ settings: s, pageCount: 10, page: () => empty, missingChars: [], fontWarnings: [], target: "pdf" });
    const msg = f.map((x) => x.message).join("\n");
    assert.match(msg, /中綴じ：10ページを3枚の紙の両面に刷ります（白ページを2ページ足します）/);
    assert.match(msg, /短辺とじ/);
  });
});
