import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { newCharacterStyle, normalizeStyles } from "../document/styles.js";
import { compileGrep, grepCellStyles, grepError } from "../engine/grep.js";
import { Face, typesetLazy } from "../engine/index.js";
import { parseInline } from "../engine/parse.js";
import { buildEpub } from "../output/epub.js";
import { FontService } from "../fonts/service.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}

/** 本文に「数字は赤く大きく」の正規表現スタイルを持たせた設定。 */
function withDigits(): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.styles.character.push({ ...newCharacterStyle("数字"), color: "#cc0000", scale: 1.5 });
  s.styles.paragraph.find((p) => p.name === "本文")!.grep = [{ pattern: "[0-9０-９]+", style: "数字" }];
  return s;
}

describe("正規表現スタイル", () => {
  it("読めない・空にも合う正規表現は知らせて、組版では使わない", () => {
    assert.equal(grepError("[0-9]+"), null);
    assert.match(grepError("[0-9")!, /./);
    assert.match(grepError("\\d*")!, /空の文字列/);
    assert.match(grepError("")!, /空/);
    const rules = compileGrep(
      [
        { pattern: "[0-9", style: "数字" },
        { pattern: "a+", style: "ない" },
        { pattern: "b+", style: "数字" },
      ],
      new Set(["数字"]),
    );
    assert.deepEqual(
      rules.map((r) => r.re.source),
      ["b+"],
    );
  });

  it("合った字のマスにだけ文字スタイルの名前が付く。あとの規則が優先。ルビの字には合わせない", () => {
    const atoms = parseInline("年は2026年、｜東京《とうきょう》へ。");
    const rules = compileGrep(
      [
        { pattern: "[0-9]+", style: "A" },
        { pattern: "26", style: "B" },
        { pattern: "とう", style: "A" },
      ],
      new Set(["A", "B"]),
    );
    const styles = grepCellStyles(atoms, rules)!;
    const marked = atoms.flatMap((a, ai) => a.cells.map((c, ci) => [c.text, styles[ai][ci]])).filter(([, s]) => s);
    // 4桁の「2026」は縦組みで全角の1字ずつになるが、半角で書いた [0-9] でも合う。
    const text = marked.map(([t]) => t).join("");
    assert.equal(text, "２０２６");
    assert.ok(marked.some(([, s]) => s === "B"));
    // ルビ（とうきょう）は親文字ではないので合わない。
    assert.ok(!marked.some(([t]) => t === "東"));
  });

  it("設定を読み込むとき、規則をそろえる（読めない正規表現も直せるように残す）", () => {
    const sheet = normalizeStyles({ paragraph: [{ name: "本文", grep: [{ pattern: "[0-9", style: "数字" }, { bad: true }, "x"] }], character: [] });
    const body = sheet.paragraph.find((p) => p.name === "本文")!;
    assert.deepEqual(body.grep, [
      { pattern: "[0-9", style: "数字" },
      { pattern: "", style: "" },
    ]);
    assert.deepEqual(sheet.paragraph.find((p) => p.name === "大見出し")!.grep, []);
  });

  it("組版：正規表現に合った字に文字スタイルが当たる。原稿で当てた文字スタイルが優先", { skip: !bytes && "フォントがない" }, () => {
    const s = withDigits();
    s.styles.character.push({ ...newCharacterStyle("青"), color: "#0000cc" });
    const face = new Face(bytes!);
    const items = typesetLazy("　あ12い［＃青］34［＃／青］う", s, face).page(0).items;
    const colorOf = (t: string) => items.find((i) => i.text === t)?.color;
    assert.equal(colorOf("12"), "#cc0000");
    assert.equal(colorOf("34"), "#0000cc");
    assert.notEqual(colorOf("あ"), "#cc0000");
    // 規則のない段落スタイル（大見出し）には当たらない。
    const h = typesetLazy("＃第12章", s, face).page(0).items;
    assert.notEqual(h.find((i) => i.text === "12")?.color, "#cc0000");
  });

  it("EPUB でも同じ規則で文字スタイルの span が付く", () => {
    const s = withDigits();
    const files = buildEpub("　あ12い", s, [], new Date(0));
    const xhtml = new TextDecoder().decode(files.find((f) => /p001\.xhtml$/.test(f.name))!.data);
    const cs = s.styles.character.findIndex((c) => c.name === "数字");
    assert.match(xhtml, new RegExp(`<span class="cs${cs}">(<span class="tcy">)?12`));
  });
});
