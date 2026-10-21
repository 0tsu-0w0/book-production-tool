import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../document/settings.js";
import { DEFAULT_STYLES } from "../document/styles.js";
import { findAll, parseXml } from "../document/xml.js";
import { buildIdml } from "../output/idml.js";

// #1：クラウドの InDesign（InDesign Server）で IDML を開いて書き出し、ずれていた所の直し。
const dec = new TextDecoder();
const settings = () => ({ ...structuredClone(DEFAULT_SETTINGS), styles: structuredClone(DEFAULT_STYLES) });
const file = (r: ReturnType<typeof buildIdml>, name: string) => dec.decode(r.files.find((f) => f.name === name)!.data);

describe("InDesign で開いたときのずれ（#1）", () => {
  it("文書の設定のページ数は 1（InDesign はその数だけ白いページを先に作り、そのあとに Spreads のページを足すため）", () => {
    const r = buildIdml("本文。", settings(), { pageCount: 4 });
    assert.match(file(r, "Resources/Preferences.xml"), /PagesPerDocument="1"/);
    // ページそのものは Spreads に4ページある。
    const pages = r.files.filter((f) => f.name.startsWith("Spreads/")).flatMap((f) => findAll(parseXml(dec.decode(f.data)), "Page"));
    assert.equal(pages.length, 4);
  });

  it("段落スタイルは日本語段落コンポーザー（ルビ・圏点・縦中横・割注を組むため）。段落スタイル「なし」には付けない（付けると開けない）", () => {
    const styles = findAll(parseXml(file(buildIdml("本文。", settings(), { pageCount: 1 }), "Resources/Styles.xml")), "ParagraphStyle");
    const none = styles.find((s) => s.attrs.Name === "$ID/[No paragraph style]")!;
    assert.equal(none.attrs.Composer, undefined);
    for (const s of styles.filter((x) => x !== none)) {
      if (s.attrs.Name === "$ID/NormalParagraphStyle") continue;
      assert.equal(s.attrs.Composer, "HL Composer J", s.attrs.Name);
    }
  });

  it("表の段落のあとに1行ぶん空ける（縦組みで、表のすぐあとの行が表に重なるため）", () => {
    const r = buildIdml(["［＃表］", "| 名前 | 値 |", "|---|---|", "| 雨 | 1 |", "［＃／表］", "注のような行。"].join("\n"), settings(), { pageCount: 1 });
    const story = parseXml(file(r, "Stories/Story_u1.xml"));
    const withTable = findAll(story, "ParagraphStyleRange").find((p) => findAll(p, "Table").length > 0)!;
    assert.ok(Number(withTable.attrs.SpaceAfter) > 0, JSON.stringify(withTable.attrs));
  });
});
