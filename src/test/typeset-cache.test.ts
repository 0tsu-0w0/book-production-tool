import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { newCharacterStyle } from "../document/styles.js";
import { Face, typesetLazy } from "../engine/index.js";
import { FontService } from "../fonts/service.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}

/** 全ページの描画命令とページの情報（結果が同じかを比べる）。 */
function snapshot(text: string, s: Settings, face: Face): string {
  const r = typesetLazy(text, s, face);
  const pages = Array.from({ length: r.pageCount }, (_, i) => r.page(i));
  return JSON.stringify([pages, r.pageLabels, r.missingChars, [...r.labelPages()], r.lastPageLines]);
}

describe("組版の使い回し（速さのための控え）", { skip: !bytes && "フォントがない" }, () => {
  const face = bytes ? new Face(bytes) : (undefined as unknown as Face);
  const doc = [
    "［＃目次］",
    "＝＝＝",
    "＃第一章　雨",
    "　｜図書館《としょかん》［＃索引：図書館（としょかん）］へ行く。続きは［＃ページ：kiri］ページ［＃注：梅雨のこと。］。",
    "　同じ行。",
    "　同じ行。",
    "＝＝＝",
    "＃第二章　霧［＃ラベル：kiri］",
    "　霧の中の図書館［＃索引：図書館（としょかん）］。",
    "［＃索引ページ］",
  ].join("\n");

  it("同じ行が何度出ても、長体・平体を重ねて当てない", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.styles.character.push({ ...newCharacterStyle("平体"), deform: "flat", deformRatio: 50 });
    const line = "［＃平体］あいう［＃／平体］";
    const ys = (t: string) => typesetLazy(t, s, face).page(0).items.slice(0, 3).map((i) => Math.round(i.y));
    assert.deepEqual(ys(`${line}\n${line}\n${line}`), ys(line));
  });

  it("続けて組んでも（設定や原稿を変えて戻しても）、初めて組んだときと同じ結果になる", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    const first = snapshot(doc, s, face);
    const other = structuredClone(s);
    other.styles.paragraph[0].scale = 1.3;
    other.typography.mode = "grid";
    snapshot(doc, other, face);
    assert.equal(snapshot(doc, s, face), first);
    snapshot(`　前に足した行。\n${doc.replace("霧の中", "霧の奥")}`, s, face);
    assert.equal(snapshot(doc, s, face), first);
  });

  it("あとから別の組版が走っても、前の結果のページは前の原稿と設定のまま", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    const expected = snapshot(doc, s, face);
    const old = typesetLazy(doc, s, face);
    const other = structuredClone(s);
    other.styles.paragraph[0].scale = 1.3;
    typesetLazy(doc, other, face).page(0);
    const pages = Array.from({ length: old.pageCount }, (_, i) => old.page(i));
    assert.equal(JSON.stringify([pages, old.pageLabels, old.missingChars, [...old.labelPages()], old.lastPageLines]), expected);
  });

  it("カーソルのあるページは、字を置かずに行から探す（前と同じページ）", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    const r = typesetLazy(doc, s, face);
    // 前の作り方：その位置より前にある字のうち、最後の字のページ（全ページの字を見る）。
    const before = (line: number, offset: number) => {
      let best = -1;
      for (let i = 0; i < r.pageCount; i++) if (r.page(i).items.some((it) => it.src && (it.src[0] < line || (it.src[0] === line && it.src[1] <= offset)))) best = i;
      return best;
    };
    for (const [line, offset] of [[2, 0], [2, 3], [3, 0], [3, 10], [5, 2], [7, 1], [8, 4], [99, 0]]) {
      assert.equal(r.pageOf(line, offset), before(line, offset), `行 ${line}・${offset}字目`);
    }
  });
});
