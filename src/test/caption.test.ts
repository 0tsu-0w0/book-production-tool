import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SPEC, layoutDocument } from "../engine/layout.js";
import { parse } from "../engine/parse.js";
import type { ImageBlock, Shape } from "../engine/types.js";

const image = (line: string) => parse(line)[0] as ImageBlock;
const imgShape = (shapes: Shape[]) => shapes.find((s): s is Extract<Shape, { kind: "image" }> => s.kind === "image")!;

describe("画像の切り抜き・大きさ・位置・キャプション", () => {
  it("記法を読む：切り抜き・大きさ・ずらす・キャプション（空白を含む）", () => {
    const b = image("［＃画像：猫　版面　切り抜き：上10下２０　大きさ：８０％　ずらす：右2上1.5　キャプション：庭の猫　（筆者撮影）］");
    assert.deepEqual(b.crop, { top: 0.1, right: 0, bottom: 0.2, left: 0 });
    assert.equal(b.scale, 0.8);
    assert.deepEqual(b.shift, { x: 2, y: -1.5 });
    assert.equal(b.caption?.atoms.map((a) => a.cells.map((c) => c.text).join("")).join(""), "庭の猫　（筆者撮影）");
    assert.equal(image("［＃画像：猫　切り抜き］").fill, true);
  });

  it("切り抜くと、見える範囲で枠に収め、外を隠す", () => {
    const spec = { ...DEFAULT_SPEC, images: { 猫: { width: 100, height: 100 } } };
    const [page] = layoutDocument(parse("［＃画像：猫　版面　切り抜き：上25下25］"), spec);
    const s = imgShape(page.shapes);
    assert.ok(s.clip);
    // 見える範囲は横長（2:1）で、版面の幅いっぱい。
    assert.ok(Math.abs(s.clip.w / s.clip.h - 2) < 1e-6);
    assert.ok(Math.abs(s.clip.w - page.block.width) < 1e-6);
    // 画像の上の4分の1は、見える範囲の上にはみ出している。
    assert.ok(Math.abs(s.clip.y - s.y - s.h / 4) < 1e-6);
  });

  it("枠いっぱい（切り抜き）なら、版面を覆って外を隠す", () => {
    const spec = { ...DEFAULT_SPEC, images: { 猫: { width: 100, height: 100 } } };
    const [page] = layoutDocument(parse("［＃画像：猫　切り抜き］"), spec);
    const s = imgShape(page.shapes);
    assert.ok(Math.abs(s.clip!.w - page.block.width) < 1e-6 && Math.abs(s.clip!.h - page.block.height) < 1e-6);
  });

  it("大きさとずらす", () => {
    const spec = { ...DEFAULT_SPEC, images: { 猫: { width: 100, height: 100 } } };
    const [a] = layoutDocument(parse("［＃画像：猫　版面］"), spec);
    const [b] = layoutDocument(parse("［＃画像：猫　版面　大きさ：50　ずらす：右10下5］"), spec);
    const sa = imgShape(a.shapes);
    const sb = imgShape(b.shapes);
    assert.ok(Math.abs(sb.w - sa.w / 2) < 1e-6);
    const mm = 72 / 25.4;
    assert.ok(Math.abs(sb.x + sb.w / 2 - (sa.x + sa.w / 2) - 10 * mm) < 1e-6);
    assert.ok(Math.abs(sb.y + sb.h / 2 - (sa.y + sa.h / 2) - 5 * mm) < 1e-6);
  });

  it("キャプションは画像の左に、画像の上端から縦に置く", () => {
    const spec = { ...DEFAULT_SPEC, images: { 猫: { width: 100, height: 100 } } };
    const [page] = layoutDocument(parse("［＃画像：猫　版面　キャプション：庭の猫］"), spec);
    const s = imgShape(page.shapes);
    const g = page.glyphs.filter((x) => "庭の猫".includes(x.text));
    assert.equal(g.length, 3);
    for (const x of g) assert.ok(x.x < s.x);
    assert.ok(Math.abs(Math.min(...g.map((x) => x.y)) - s.y) < spec.fontSizePt);
  });

  it("行の中の画像のキャプションは、取った行の最後の行に入り、画像はその分小さくなる", () => {
    const spec = { ...DEFAULT_SPEC, images: { 猫: { width: 100, height: 100 } } };
    const [a] = layoutDocument(parse("［＃画像：猫　4行］"), spec);
    const [b] = layoutDocument(parse("［＃画像：猫　4行　キャプション：猫］"), spec);
    assert.ok(imgShape(b.shapes).w < imgShape(a.shapes).w);
    const cat = b.glyphs.find((x) => x.text === "猫")!;
    assert.ok(cat.x < imgShape(b.shapes).x);
  });
});
