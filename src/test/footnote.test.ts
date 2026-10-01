import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { Face, typesetLazy } from "../engine/index.js";
import { FontService } from "../fonts/service.js";

let face: Face | undefined;
try {
  face = new Face(new FontService().load(null).bytes);
} catch {
  face = undefined;
}

const settings = (): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.notes.placement = "page";
  return s;
};

describe("ページごとの注（脚注）", { skip: !face && "フォントがない" }, () => {
  it("注は、注番号のあるページの終わり（最後の行）に、区切り線のあとに置く", () => {
    const r = typesetLazy("雨［＃注：梅雨のこと。］が降る。\n晴れ。", settings(), face!);
    assert.equal(r.pageCount, 1);
    const lines = r.lines(0).map((l) => l.text);
    assert.deepEqual(lines.slice(0, 2), ["雨注１が降る。", "晴れ。"].map((t) => t.replace("１", "1")));
    assert.match(lines[lines.length - 1], /^注1　梅雨のこと。/);
    const page = r.page(0);
    // 区切り線（本文の字数の3分の1の長さ）がある。
    assert.ok(page.shapes.some((s) => s.kind === "line"));
  });

  it("注の行が入らなければ、注番号のある行ごと次のページへ送る", () => {
    const s = settings();
    // 15行のページの14行目に注のある行：注の行と区切り線が入らないので、その行は次のページ。
    const text = [...Array.from({ length: 13 }, (_, i) => `${i + 1}`), "ここ［＃注：注の中身］", "あと"].join("\n");
    const r = typesetLazy(text, s, face!);
    const where = [0, 1].map((p) => r.lines(p).map((l) => l.text));
    assert.ok(!where[0].some((t) => t.startsWith("ここ")), JSON.stringify(where[0]));
    assert.ok(where[1][0].startsWith("ここ"));
    assert.ok(where[1].some((t) => t.startsWith("注1")));
  });

  it("番号は章ごと", () => {
    const r = typesetLazy("＃一\nあ［＃注：a］\n＝＝＝\n＃二\nい［＃注：b］", settings(), face!);
    const notes = [0, 1].flatMap((p) => r.lines(p).map((l) => l.text).filter((t) => t.startsWith("注")));
    assert.deepEqual(notes.map((t) => t.slice(0, 2)), ["注1", "注1"]);
  });
});
