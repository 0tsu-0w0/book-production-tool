import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { DEFAULT_STYLES, newCharacterStyle, normalizeStyles } from "../document/styles.js";
import { typeset } from "../engine/index.js";
import { parse } from "../engine/parse.js";
import { FontService } from "../fonts/service.js";

const face = new FontService().load(null).face;
const settings = (edit: (s: Settings) => void = () => {}): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.styles = structuredClone(DEFAULT_STYLES);
  edit(s);
  return s;
};
const gidOf = (text: string, s: Settings, ch: string) => typeset(text, s, face).pages[0].items.find((i) => i.text === ch)!.glyphs[0].gid;

describe("字形（DTP-10）", () => {
  it("異体字セレクタ（IVS）は前の字と1字になり、別の字形で組む", () => {
    const [b] = parse("葛\u{E0100}城");
    assert.ok(b.kind === "para");
    assert.deepEqual(b.atoms.map((a) => a.cells[0].text), ["葛\u{E0100}", "城"]);
    assert.notEqual(gidOf("葛\u{E0100}", settings(), "葛\u{E0100}"), gidOf("葛", settings(), "葛"));
  });

  it("文字スタイルの字形（印刷標準字体 nlck）で、フォントの別の字形に切り替わる", () => {
    const s = settings((s) => s.styles.character.push({ ...newCharacterStyle("新字形"), glyphForm: "nlck" }));
    assert.notEqual(gidOf("［＃新字形］芦［＃／新字形］", s, "芦"), gidOf("芦", s, "芦"));
  });

  it("プロポーショナルにすると、かなと約物の行の長さが短くなる（漢字はそのまま）", () => {
    const s = settings((s) => s.styles.character.push({ ...newCharacterStyle("詰め"), proportional: true }));
    // 最後の字（詰めない字）の位置で、そこまでの長さを比べる。
    const endOf = (text: string, last: string) => typeset(text, s, face).pages[0].items.find((i) => i.text === last)!.y;
    assert.ok(endOf("［＃詰め］「っちゃ」と［＃／詰め］言", "言") < endOf("「っちゃ」と言", "言") - 9.25, "かなと括弧は詰まる");
    assert.equal(endOf("［＃詰め］漢字列［＃／詰め］末", "末"), endOf("漢字列末", "末"), "漢字は詰めない");
  });

  it("古いスタイル（字形の項目なし）は標準の字形になる", () => {
    const s = normalizeStyles({ paragraph: [{ name: "本文" }], character: [{ name: "x", glyphForm: "bogus" }] });
    assert.equal(s.paragraph[0].glyphForm, "");
    assert.equal(s.character[0].glyphForm, "");
    assert.equal(s.character[0].proportional, false);
  });
});
