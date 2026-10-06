import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings, toLayoutSpec, toParseOptions, type Settings } from "../document/settings.js";
import { Face, typesetLazy } from "../engine/index.js";
import { KINSOKU_PRESETS, kinsokuSets } from "../engine/kinsoku.js";
import { parse } from "../engine/parse.js";
import { checkLines } from "../engine/proof.js";
import { MOJIKUMI_PRESETS, MOJIKUMI_STANDARD, prepareSpacing } from "../engine/spacing.js";
import { FontService } from "../fonts/service.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}

/** 段落の字のマスの長さ（字）を、文字組みアキ量 aki で準備したときの値で返す。 */
function lengths(text: string, aki = MOJIKUMI_STANDARD): [string, number, number][] {
  const [b] = parse(text);
  assert.ok(b.kind === "para");
  for (const a of b.atoms) for (const c of a.cells) c.scale = 1;
  prepareSpacing([b], { mode: "jis", lineHeadBracket: "full", oikomi: true, rubyOverhang: true, aki }, 0.5);
  return b.atoms.flatMap((a) => a.cells.map((c): [string, number, number] => [c.text, c.advance ?? 1, c.shift ?? 0]));
}

function jis(): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.typography = { ...s.typography, mode: "jis" };
  return s;
}

describe("文字組みアキ量", () => {
  it("標準はこれまでと同じ：句読点と括弧は全角、続く約物は間が半角", () => {
    const l = lengths("あ」「い、う。・え");
    assert.deepEqual(
      l.map(([t, a]) => [t, a]),
      [
        ["あ", 1],
        ["」", 0.5],
        ["「", 1],
        ["い", 1],
        ["、", 1],
        ["う", 1],
        // 中点は続く約物の決まりに入らないので、句点は全角のまま（これまでと同じ）。
        ["。", 1],
        ["・", 1],
        ["え", 1],
      ],
    );
  });

  it("値を変えると、そのアキになる：句読点のあと・始め括弧の前・続くときの間・中点の前後", () => {
    const aki = { ...MOJIKUMI_STANDARD, afterComma: 0.25, afterPeriod: 0, beforeOpening: 0.25, between: 0, middleDot: 0.5 };
    const l = Object.fromEntries(lengths("あ、い。う」「え「お・か", aki).map(([t, a, s], i) => [`${i}${t}`, [a, s]]));
    assert.deepEqual(l["1、"], [0.75, 0]);
    assert.deepEqual(l["3。"], [0.5, 0]);
    // 」のあとの「：間は 0（」も「も半角）。「は前のアキがないので字形を半角ぶん前へ。
    assert.deepEqual(l["5」"], [0.5, 0]);
    assert.deepEqual(l["6「"], [0.5, -0.5]);
    // 単独の「：前のアキ 0.25 → 長さ 0.75、字形を 0.25 前へ。
    assert.deepEqual(l["8「"], [0.75, -0.25]);
    // 中点：前後 0.5 ずつ → 長さ 1.5、字形を 0.25 後ろへ。
    assert.deepEqual(l["10・"], [1.5, 0.25]);
  });

  it("和欧間：横倒しの欧文の前後にアキ（句読点のあとには付けない）", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.format.halfWidth = "rotate";
    const [b] = parse("これはABCで、。DEF", toParseOptions(s));
    assert.ok(b.kind === "para");
    for (const a of b.atoms) for (const c of a.cells) {
      c.scale = 1;
      if (c.rotate) c.advance = 1.5;
    }
    prepareSpacing([b], { mode: "jis", lineHeadBracket: "full", oikomi: true, rubyOverhang: true, aki: { ...MOJIKUMI_STANDARD, latin: 0.25 } }, 0.5);
    const cells = b.atoms.flatMap((a) => a.cells);
    const abc = cells.find((c) => c.text === "ABC")!;
    const def = cells.find((c) => c.text === "DEF")!;
    assert.equal(abc.advance, 2);
    assert.equal(abc.shift, 0.25);
    assert.equal(def.advance, 1.5, "句点のあとの欧文には付けない");
  });

  it("型を選んで組むと行の長さが変わる。標準の型は、文字組みアキ量を渡さない（これまでと同じ組版）", { skip: !bytes && "フォントがない" }, () => {
    const face = new Face(bytes!);
    const text = `　${"「あ」「い」「う」「え」「お」「か」「き」「く」「け」「こ」「さ」「し」「す」「せ」「そ」".repeat(4)}`;
    const lineCount = (preset: string) => {
      const s = jis();
      const p = MOJIKUMI_PRESETS.find((x) => x.id === preset)!;
      s.mojikumi = { preset, ...p.value };
      return typesetLazy(text, s, face).lines(0).length;
    };
    assert.ok(lineCount("full") > lineCount("standard"));
    assert.ok(lineCount("half") <= lineCount("standard"));
    assert.equal(toLayoutSpec(jis()).typography.aki, undefined);
  });

  it("設定を読み込むとき、値を範囲に収め、知らない型は「自分で決める」にする", () => {
    const s = normalizeSettings({ mojikumi: { preset: "?", afterClosing: 3, latin: 2, between: -1, compress: false }, kinsoku: "odd" });
    assert.equal(s.mojikumi.preset, "custom");
    assert.equal(s.mojikumi.afterClosing, 1);
    assert.equal(s.mojikumi.latin, 0.5);
    assert.equal(s.mojikumi.between, 0);
    assert.equal(s.mojikumi.compress, false);
    assert.equal(s.kinsoku, "strong");
  });
});

describe("禁則を自分で決める", () => {
  it("決めた字だけで禁則を組む（強い・弱いの字や、足す字は使わない）", () => {
    const sets = kinsokuSets("custom", { start: "＊", end: "" }, { start: "。", end: "「", hang: "", noBreak: "―" });
    assert.ok(sets.start.has("。"));
    assert.ok(!sets.start.has("、"));
    assert.ok(!sets.start.has("＊"));
    assert.equal(sets.hang.size, 0);
    // 強い・弱いでは足す字も入る。
    assert.ok(kinsokuSets("strong", { start: "＊", end: "" }).start.has("＊"));
    assert.equal(KINSOKU_PRESETS.strong.start.includes("ー"), true);
    assert.equal(KINSOKU_PRESETS.weak.start.includes("ー"), false);
  });

  it("組版：行頭禁則から外した字は行頭に来てよく、分離禁止の字どうしの間では改行しない", { skip: !bytes && "フォントがない" }, () => {
    const face = new Face(bytes!);
    const per = toLayoutSpec(DEFAULT_SETTINGS).charsPerLine;
    // 1行目の字数ちょうどの所に「ー」が来る原稿。
    const text = `${"あ".repeat(per)}ーい`;
    const heads = (s: Settings) => typesetLazy(text, s, face).lines(0).map((l) => [...l.text][0]);
    const strong = structuredClone(DEFAULT_SETTINGS);
    assert.notEqual(heads(strong)[1], "ー");
    const custom = structuredClone(DEFAULT_SETTINGS);
    custom.kinsoku = "custom";
    custom.kinsokuCustom = { ...KINSOKU_PRESETS.strong, start: KINSOKU_PRESETS.strong.start.replace("ー", "") };
    assert.equal(heads(custom)[1], "ー");
    // 分離禁止：行末と次の行頭に「‥」が分かれる所で、分けずに送る。
    const dots = `${"あ".repeat(per - 1)}‥‥い`;
    const noBreak = structuredClone(DEFAULT_SETTINGS);
    noBreak.kinsoku = "custom";
    noBreak.kinsokuCustom = { ...KINSOKU_PRESETS.strong, noBreak: "‥" };
    const lines = typesetLazy(dots, noBreak, face).lines(0).map((l) => l.text);
    assert.ok(lines[1].startsWith("あ‥‥") || !lines[0].endsWith("‥"), JSON.stringify(lines));
  });

  it("校正の補助：自分で決めた禁則なら、その字で禁則違反を探す", () => {
    const lines = [
      { text: "あいう", start: true, end: false },
      { text: "ーえお", start: false, end: true },
    ];
    assert.equal(checkLines(1, () => lines).kinsoku.length, 1);
    assert.equal(checkLines(1, () => lines, undefined, { start: "。", end: "「" }).kinsoku.length, 0);
  });
});

