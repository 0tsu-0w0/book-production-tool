import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings } from "../document/settings.js";
import { Face, typeset } from "../engine/index.js";
import { placeNotes } from "../engine/notes.js";
import { parse } from "../engine/parse.js";
import type { Block } from "../engine/types.js";
import { FontService } from "../fonts/service.js";

const text = (b: Block) => (b.kind === "para" || b.kind === "heading" ? b.atoms.map((a) => a.cells.map((c) => c.text).join("")).join("") : `<${b.kind}>`);

describe("注（後注）", () => {
  it("本文に注番号を入れ、章の終わり（次の大見出しの前）にまとめる。番号は章ごと", () => {
    const blocks = parse("＃一\n雨［＃注：梅雨のこと。］が降る［＃注：二つ目］。\n＃二\n晴れ［＃注：三つ目］");
    const r = placeNotes(blocks, blocks.map((_, i) => i), "chapter");
    assert.deepEqual(r.blocks.map(text), ["一", "雨注1が降る注2。", "<blank>", "注", "注1　梅雨のこと。", "注2　二つ目", "二", "晴れ注1", "<blank>", "注", "注1　三つ目"]);
    // 入れた段落には原稿の行がない。
    assert.deepEqual(r.lines, [0, 1, undefined, undefined, undefined, undefined, 2, 3, undefined, undefined, undefined]);
  });

  it("本の終わりにまとめるなら通し番号", () => {
    const blocks = parse("＃一\nあ［＃注：a］\n＃二\nい［＃注：b］");
    const r = placeNotes(blocks, [], "end");
    assert.deepEqual(r.blocks.map(text).slice(-3), ["注", "注1　ａ", "注2　ｂ"]);
  });

  it("設定は章ごとか本の終わり", () => {
    assert.equal(normalizeSettings({ notes: { placement: "x" } }).notes.placement, "chapter");
    assert.equal(normalizeSettings({ notes: { placement: "end" } }).notes.placement, "end");
  });

  it("組むと、本文の注番号は小さく、注は段落スタイル「注」で組む", { skip: (() => { try { new FontService().load(null); return false; } catch { return "フォントがない"; } })() }, () => {
    const face = new Face(new FontService().load(null).bytes);
    const [page] = typeset("雨［＃注：梅雨。］が降る。", DEFAULT_SETTINGS, face).pages;
    const marks = page.items.filter((i) => i.text === "注");
    const body = page.items.find((i) => i.text === "雨")!;
    assert.ok(marks.length >= 2);
    assert.ok(marks[0].size < body.size * 0.7);
    assert.ok(marks[marks.length - 1].size > body.size * 0.7);
  });
});
