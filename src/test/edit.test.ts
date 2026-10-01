import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { typeset } from "../engine/index.js";
import { FontService } from "../fonts/service.js";
import { pickItem } from "../renderer/preview.js";

const face = new FontService().load(null).face;
const settings = (edit: (s: Settings) => void = () => {}): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  edit(s);
  return s;
};

describe("紙面から原稿へ（DTP-15）", () => {
  it("紙面の字は、原稿の行と行の中の位置を持つ（記法の分ずれる）", () => {
    const text = "一行目\n［＃太字］強い［＃／太字］字\n｜漢字《かんじ》の話\n＃見出し";
    const items = typeset(text, settings(), face).pages[0].items;
    const src = (t: string) => items.find((i) => i.text === t)!.src;
    assert.deepEqual(src("目"), [0, 2]);
    assert.deepEqual(src("強"), [1, 5]);
    assert.deepEqual(src("字"), [1, 13]);
    assert.deepEqual(src("の"), [2, 8]);
    assert.deepEqual(src("見"), [3, 1]);
  });

  it("自動整形で消えた空行があっても、元の原稿の行の番号になる", () => {
    const s = settings((s) => (s.format.dialogueBlankLines = true));
    const items = typeset("地の文。\n\n「会話」\n\n終わり。", s, face).pages[0].items;
    assert.deepEqual(items.find((i) => i.text === "終")!.src, [4, 0]);
  });

  it("扉・奥付など原稿にない字と、柱・ノンブルは原稿の位置を持たない", () => {
    const s = settings((s) => {
      s.layoutMode = "book";
      s.bookInfo.title = "書名";
      s.pages.front = [{ kind: "title", text: "" }];
    });
    const r = typeset("本文", s, face);
    assert.ok(r.pages[0].items.every((i) => !i.src));
    assert.ok(r.pages[1].items.filter((i) => i.src).length === 2);
  });

  it("クリックした場所にいちばん近い字を選ぶ（遠ければ選ばない）", () => {
    const page = typeset("あいう", settings(), face).pages[0];
    const i = page.items.find((x) => x.text === "い")!;
    assert.equal(pickItem(page, i.x + i.size / 2, i.y - i.size * 0.4)?.text, "い");
    assert.equal(pickItem(page, 1, 1), undefined);
  });
});
