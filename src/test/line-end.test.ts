import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings, toLayoutSpec, type Settings } from "../document/settings.js";
import { Face, typesetLazy } from "../engine/index.js";
import { breakLines } from "../engine/layout.js";
import { parse } from "../engine/parse.js";
import { MOJIKUMI_STANDARD, prepareSpacing, type Mojikumi } from "../engine/spacing.js";
import { FontService } from "../fonts/service.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}

/** 段落を字数 per で行に分ける（行末約物半角か）。 */
function lines(text: string, per: number, half: boolean, aki: Mojikumi = MOJIKUMI_STANDARD) {
  const [b] = parse(text);
  assert.ok(b.kind === "para");
  for (const a of b.atoms) for (const c of a.cells) c.scale = 1;
  prepareSpacing([b], { mode: "jis", lineHeadBracket: "full", lineEndPunct: half ? "half" : "full", oikomi: true, rubyOverhang: true, aki }, 0.5);
  return breakLines(b.atoms, per, 0, { kinsoku: "strong", hanging: true, justify: true, oikomi: true, lineEndHalf: half }).map((l) => ({
    text: l.atoms.map((a) => a.cells.map((c) => c.text).join("")).join(""),
    adjust: l.adjust ?? 0,
    endTrim: l.endTrim ?? 0,
  }));
}

function jis(half: boolean): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.typography = { ...s.typography, mode: "jis", lineEndPunct: half ? "half" : "full" };
  return s;
}

describe("行末約物半角", () => {
  it("行末の句読点・終わり括弧はアキを取り、その分を字間に配って字形を行末にそろえる", () => {
    assert.deepEqual(lines("あいうえ。か", 5, false)[0], { text: "あいうえ。", adjust: 0, endTrim: 0 });
    assert.deepEqual(lines("あいうえ。か", 5, true)[0], { text: "あいうえ。", adjust: 0.5, endTrim: 0.5 });
    assert.deepEqual(lines("あいうえ」か", 5, true)[0], { text: "あいうえ」", adjust: 0.5, endTrim: 0.5 });
  });

  it("アキを取れば入る句点は、追い出さずにこの行に入れる（約物を詰めないときも）", () => {
    // 「あ」「いう」で 4.5 字。句点は全角では入らず、詰められないので「う。」を次の行へ追い出す。
    const noCompress = { ...MOJIKUMI_STANDARD, compress: false };
    const full = lines("あ」「いう。かきくけこ", 5, false, noCompress);
    assert.equal(full[0].text, "あ」「い");
    assert.equal(full[0].adjust, 1.5);
    const half = lines("あ」「いう。かきくけこ", 5, true, noCompress);
    assert.deepEqual(half[0], { text: "あ」「いう。", adjust: 0, endTrim: 0.5 });
  });

  it("追い込みでは、行末の字のアキは詰める量に数えず取る", () => {
    // 「あ、いうえ」で行が埋まり、次の「」」は行頭禁則（ぶら下げない）。全角なら行内の「、」と「」」のアキを1字分詰めて入れる。
    const full = lines("あ、いうえ」か", 5, false);
    assert.deepEqual(full[0], { text: "あ、いうえ」", adjust: -1, endTrim: 0 });
    // 半角なら「」」のアキは取るので、詰めるのは「、」の半角だけ。
    const half = lines("あ、いうえ」か", 5, true);
    assert.deepEqual(half[0], { text: "あ、いうえ」", adjust: -0.5, endTrim: 0.5 });
  });

  it("続く約物（」。など）や段落の最後の行、割注は変わらない", () => {
    const l = lines("あいう」。か", 5, true);
    assert.equal(l[0].text, "あいう」。");
    assert.equal(l[0].endTrim, 0.5);
    const last = lines("あいう。", 5, true);
    assert.deepEqual(last[0], { text: "あいう。", adjust: 0, endTrim: 0.5 });
  });

  it("組版：行末の句点の字形が、行の終わりの半角にそろう（全角では半角のアキが残る）", { skip: !bytes && "フォントがない" }, () => {
    const face = new Face(bytes!);
    const per = toLayoutSpec(jis(false)).charsPerLine;
    const text = `${"あ".repeat(per - 1)}。${"い".repeat(per)}`;
    const extent = (half: boolean) => {
      const r = typesetLazy(text, jis(half), face);
      const items = r.page(0).items;
      const first = items.find((i) => i.text === "あ")!;
      const stop = items.find((i) => i.text === "。")!;
      return { first: first.y, stop: stop.y, size: first.size };
    };
    const full = extent(false);
    const half = extent(true);
    assert.equal(full.first, half.first);
    // 全角では句点はちょうど最後のマス。半角では、取ったアキの分だけ後ろへずれて行末にそろう。
    assert.ok(half.stop > full.stop + full.size * 0.4, `${half.stop} ${full.stop}`);
  });

  it("設定：知らない値は全角に。見本の設定は全角（これまでと同じ）", () => {
    assert.equal(normalizeSettings({ typography: { lineEndPunct: "odd" } }).typography.lineEndPunct, "full");
    assert.equal(normalizeSettings({ typography: { lineEndPunct: "half" } }).typography.lineEndPunct, "half");
    assert.equal(DEFAULT_SETTINGS.typography.lineEndPunct, "full");
  });
});
